/**
 * 원격 제어(Remote Control) — 호스트가 "화면 공유 중인 참가자 PC"의 마우스/키보드를 제어
 *
 * 흐름
 *  1) 호스트  → rc-request {targetId}          (대상은 현재 화면 공유 중인 참가자여야 함)
 *  2) 서버    → 참가자 rc-request {sessionId}   (참가자 화면에 허용/거절 팝업)
 *  3) 참가자  → rc-respond {sessionId, accept}
 *       거절: 호스트에 rc-denied
 *       허용: 참가자에게 제어 프로그램(.bat) 다운로드 URL 전달 + 호스트에 rc-approved
 *  4) 참가자 PC에서 제어 프로그램 실행 → wss://.../rc-agent 로 접속 → 서버가 양쪽에 rc-active
 *  5) 호스트 입력(rc-input) → 서버 검증/속도제한 → 에이전트 WebSocket 으로 전달 → SendInput
 *  6) 어느 쪽이든 중지/화면공유 종료/접속 끊김 → rc-ended
 *
 * 보안
 *  - 세션/에이전트 토큰은 crypto 난수. 에이전트 토큰은 참가자가 "허용"한 뒤에만 발급/유효.
 *  - 입력 이벤트는 호스트 토큰이 검증된 호스트 소켓에서만 수락, 종류/값 화이트리스트, 초당 이벤트 제한.
 *  - 참가자 PC의 에이전트 창에는 항상 "제어 중지" 버튼이 표시되며, 창을 닫으면 즉시 종료.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const AGENT_TEMPLATE_PATH = path.join(__dirname, 'remote-agent', 'agent.ps1');
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const PENDING_TTL_MS = 3 * 60 * 1000; // 참가자가 응답/실행하지 않으면 정리
const DISCONNECT_GRACE_MS = 20_000;
const AGENT_PING_MS = 10_000;
const MAX_EVENTS_PER_SEC = 800;
const MAX_EVENTS_PER_MSG = 200;

const KEY_CODE_RE = /^[A-Za-z0-9]{1,24}$/;

function rid(n = 12) {
  return crypto.randomBytes(n).toString('hex');
}

function num(v, lo, hi, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 호스트 입력 이벤트 화이트리스트 검증 */
function sanitizeEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const ev of list.slice(0, MAX_EVENTS_PER_MSG)) {
    if (!ev || typeof ev !== 'object') continue;
    const k = String(ev.k || '');
    switch (k) {
      case 'mm':
        out.push({ k, x: num(ev.x, 0, 1), y: num(ev.y, 0, 1) });
        break;
      case 'md':
      case 'mu':
        out.push({ k, b: Math.round(num(ev.b, 0, 2)), x: num(ev.x, 0, 1), y: num(ev.y, 0, 1) });
        break;
      case 'wh':
        out.push({ k, dx: num(ev.dx, -4000, 4000), dy: num(ev.dy, -4000, 4000), x: num(ev.x, 0, 1), y: num(ev.y, 0, 1) });
        break;
      case 'kd':
      case 'ku': {
        const c = String(ev.c || '');
        if (KEY_CODE_RE.test(c)) out.push({ k, c });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function buildAgentScript({ wsUrl, sessionId, agentToken, hostName }) {
  const tpl = fs.readFileSync(AGENT_TEMPLATE_PATH, 'utf8');
  const psq = (s) => String(s).replace(/'/g, "''");
  const ps = tpl
    .replace(/__WS_URL__/g, psq(wsUrl))
    .replace(/__SESSION_ID__/g, psq(sessionId))
    .replace(/__AGENT_TOKEN__/g, psq(agentToken))
    .replace(/__HOST_NAME__/g, psq(String(hostName || '호스트').replace(/[\r\n]/g, ' ').slice(0, 40)));
  // .bat + PowerShell 하이브리드 (설치 불필요 — Windows 기본 PowerShell 사용)
  const marker = '#<<' + 'PS1>>';
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'title YUNSEUL MEET Remote Control Agent',
    'set "YM_SELF=%~f0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create(((Get-Content -LiteralPath $env:YM_SELF -Raw -Encoding UTF8).Split([string[]](\'#<<\'+\'PS1>>\'),2,[StringSplitOptions]::None))[1]))"',
    'if errorlevel 1 pause',
    'exit /b',
    marker,
    ps,
  ].join('\r\n');
  // UTF-8 BOM 으로 저장해 한글이 깨지지 않도록 한다
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(bat, 'utf8')]);
}

/**
 * @param {{ io: import('socket.io').Server, getRoom: (code:string)=>any, requireHost: (room:any, token:string)=>boolean, log?: Function }} deps
 */
function createRemoteControl({ io, getRoom, requireHost, log = console.log }) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function viewerSocketId(room, clientId) {
    const v = room?.viewers?.get(clientId);
    return v?.connected !== false ? v?.socketId || null : null;
  }

  function emitHost(s, ev, payload) {
    const room = getRoom(s.code);
    if (room?.hostSocketId) io.to(room.hostSocketId).emit(ev, payload);
  }

  function emitTarget(s, ev, payload) {
    const room = getRoom(s.code);
    const sid = viewerSocketId(room, s.targetClientId);
    if (sid) io.to(sid).emit(ev, payload);
  }

  function endSession(s, reason = 'ended') {
    if (!s || s.state === 'ended') return;
    s.state = 'ended';
    try {
      if (s.agentWs && s.agentWs.readyState === 1) {
        s.agentWs.send(JSON.stringify({ t: 'stop', reason }));
        setTimeout(() => { try { s.agentWs.close(); } catch { /* ignore */ } }, 150);
      }
    } catch { /* ignore */ }
    if (s.pingTimer) clearInterval(s.pingTimer);
    emitHost(s, 'rc-ended', { sessionId: s.id, reason });
    emitTarget(s, 'rc-ended', { sessionId: s.id, reason });
    sessions.delete(s.id);
    log(`[rc] end session=${s.id.slice(0, 8)} room=${s.code} reason=${reason}`);
  }

  function findRoomSession(code) {
    for (const s of sessions.values()) {
      if (s.code === code && s.state !== 'ended') return s;
    }
    return null;
  }

  /** 화면 공유 주체가 바뀌었거나 참가자가 사라지면 제어 종료 (index.js 에서 호출) */
  function checkRoom(room) {
    if (!room) return;
    const s = findRoomSession(room.code);
    if (!s) return;
    if (room.activeBroadcasterId !== s.targetClientId) endSession(s, 'share-ended');
  }

  function attachSocket(socket) {
    socket.on('rc-request', (msg, ack) => {
      const reply = (p) => { if (typeof ack === 'function') ack(p); };
      try {
        const room = getRoom(socket.data.roomCode);
        if (!room || socket.data.role !== 'host' || !requireHost(room, socket.data.hostToken)) {
          return reply({ error: 'host-only' });
        }
        if (room.interactionMode === 'unidirectional') return reply({ error: 'unidirectional-room' });
        const targetId = String(msg?.targetId || '');
        const viewer = room.viewers.get(targetId);
        if (!viewer || !viewerSocketId(room, targetId)) return reply({ error: 'target-not-found' });
        if (room.activeBroadcasterId !== targetId) return reply({ error: 'target-not-sharing' });
        const existing = findRoomSession(room.code);
        if (existing) {
          if (existing.targetClientId === targetId && existing.state === 'pending') {
            return reply({ ok: true, sessionId: existing.id, state: existing.state });
          }
          endSession(existing, 'replaced');
        }
        const s = {
          id: rid(10),
          code: room.code,
          hostClientId: room.hostClientId,
          targetClientId: targetId,
          targetName: viewer.name || '참가자',
          agentToken: rid(24),
          state: 'pending',
          createdAt: Date.now(),
          agentWs: null,
          screen: null,
          hostGoneAt: 0,
          targetGoneAt: 0,
          bucketT: Date.now(),
          bucketN: MAX_EVENTS_PER_SEC,
        };
        sessions.set(s.id, s);
        io.to(viewerSocketId(room, targetId)).emit('rc-request', {
          sessionId: s.id,
          hostName: room.hostName || '호스트',
        });
        log(`[rc] request session=${s.id.slice(0, 8)} room=${s.code} target=${String(targetId).slice(0, 8)}`);
        return reply({ ok: true, sessionId: s.id, state: s.state, targetName: s.targetName });
      } catch (err) {
        console.error('[rc-request]', err);
        return reply({ error: err.message || 'rc-error' });
      }
    });

    socket.on('rc-respond', (msg, ack) => {
      const reply = (p) => { if (typeof ack === 'function') ack(p); };
      try {
        const s = sessions.get(String(msg?.sessionId || ''));
        if (!s || s.state === 'ended') return reply({ error: 'session-not-found' });
        if (socket.data.clientId !== s.targetClientId || socket.data.roomCode !== s.code) {
          return reply({ error: 'not-target' });
        }
        if (msg?.accept !== true) {
          emitHost(s, 'rc-denied', { sessionId: s.id, name: s.targetName });
          endSession(s, 'denied');
          return reply({ ok: true, accepted: false });
        }
        if (s.state === 'pending') s.state = 'approved';
        emitHost(s, 'rc-approved', { sessionId: s.id, name: s.targetName });
        return reply({
          ok: true,
          accepted: true,
          downloadUrl: `/api/remote-agent/download?s=${encodeURIComponent(s.id)}&k=${encodeURIComponent(s.agentToken)}`,
        });
      } catch (err) {
        return reply({ error: err.message || 'rc-error' });
      }
    });

    // 호스트/참가자 어느 쪽이든 중지 가능
    socket.on('rc-stop', (msg, ack) => {
      const s = sessions.get(String(msg?.sessionId || ''));
      if (s && s.code === socket.data.roomCode
        && (socket.data.clientId === s.targetClientId || socket.data.clientId === s.hostClientId)) {
        endSession(s, socket.data.clientId === s.hostClientId ? 'host-stopped' : 'target-stopped');
      }
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('rc-input', (msg) => {
      const s = sessions.get(String(msg?.sessionId || ''));
      if (!s || s.state !== 'active' || !s.agentWs || s.agentWs.readyState !== 1) return;
      if (socket.data.role !== 'host' || socket.data.clientId !== s.hostClientId || socket.data.roomCode !== s.code) return;
      const room = getRoom(s.code);
      if (!room || !requireHost(room, socket.data.hostToken)) return;
      const events = sanitizeEvents(msg?.events);
      if (!events.length) return;
      // 토큰 버킷 속도 제한
      const now = Date.now();
      s.bucketN = Math.min(MAX_EVENTS_PER_SEC, s.bucketN + ((now - s.bucketT) / 1000) * MAX_EVENTS_PER_SEC);
      s.bucketT = now;
      if (s.bucketN < events.length) return;
      s.bucketN -= events.length;
      try { s.agentWs.send(JSON.stringify({ t: 'input', events })); } catch { /* ignore */ }
    });
  }

  // ── 에이전트 WebSocket ────────────────────────────────────────────────
  function handleUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { return false; }
    if (u.pathname !== '/rc-agent') return false;
    const s = sessions.get(String(u.searchParams.get('s') || ''));
    const k = String(u.searchParams.get('k') || '');
    const okToken = s && k.length === s.agentToken.length
      && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(s.agentToken));
    if (!s || !okToken || (s.state !== 'approved' && s.state !== 'active')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (s.agentWs && s.agentWs.readyState === 1) {
        try { s.agentWs.close(); } catch { /* ignore */ }
      }
      s.agentWs = ws;
      s.lastPong = Date.now();
      ws.on('message', (data) => {
        let m;
        try { m = JSON.parse(String(data)); } catch { return; }
        if (m?.t === 'pong') { s.lastPong = Date.now(); return; }
        if (m?.t === 'hello') {
          s.screen = { w: Math.round(num(m.w, 0, 20000)), h: Math.round(num(m.h, 0, 20000)) };
          s.state = 'active';
          s.activeAt = Date.now();
          const payload = { sessionId: s.id, screen: s.screen, name: s.targetName, dryRun: !!m.dryRun };
          emitHost(s, 'rc-active', payload);
          emitTarget(s, 'rc-active', payload);
          log(`[rc] agent connected session=${s.id.slice(0, 8)} screen=${s.screen.w}x${s.screen.h}${m.dryRun ? ' (dry-run)' : ''}`);
          return;
        }
        if (m?.t === 'stopped') {
          endSession(s, 'target-stopped');
        }
      });
      ws.on('close', () => {
        if (s.agentWs === ws) {
          s.agentWs = null;
          if (s.state === 'active') endSession(s, 'agent-closed');
        }
      });
      ws.on('error', () => { /* close 에서 처리 */ });
      if (s.pingTimer) clearInterval(s.pingTimer);
      s.pingTimer = setInterval(() => {
        if (!s.agentWs || s.agentWs.readyState !== 1) return;
        if (Date.now() - (s.lastPong || 0) > 35_000) {
          endSession(s, 'agent-timeout');
          return;
        }
        try { s.agentWs.send(JSON.stringify({ t: 'ping' })); } catch { /* ignore */ }
      }, AGENT_PING_MS);
      s.pingTimer.unref?.();
    });
    return true;
  }

  // ── HTTP: 에이전트 다운로드 ─────────────────────────────────────────────
  function registerRoutes(app) {
    app.get('/api/remote-agent/download', (req, res) => {
      const s = sessions.get(String(req.query.s || ''));
      const k = String(req.query.k || '');
      const ok = s && k.length === s.agentToken.length
        && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(s.agentToken));
      if (!ok || (s.state !== 'approved' && s.state !== 'active')) {
        return res.status(403).type('text/plain').send('허용된 원격 제어 세션이 없습니다.');
      }
      const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${host}/rc-agent`;
      const room = getRoom(s.code);
      const buf = buildAgentScript({
        wsUrl,
        sessionId: s.id,
        agentToken: s.agentToken,
        hostName: room?.hostName || '호스트',
      });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="YUNSEUL-Remote-Control.bat"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    });

    // 진단용: 현재 세션 요약 (토큰 미포함)
    app.get('/api/remote-agent/status', (req, res) => {
      const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
      const local = ip === '127.0.0.1' || ip === '::1';
      const fwdOk = !fwd || fwd === '127.0.0.1' || fwd === '::1';
      if (!local || !fwdOk) {
        return res.status(403).json({ error: '이 기능은 호스트 PC에서만 사용할 수 있습니다.' });
      }
      res.json({
        ok: true,
        sessions: [...sessions.values()].map((s) => ({
          id: s.id.slice(0, 8), room: s.code, state: s.state, agent: !!s.agentWs, screen: s.screen,
        })),
      });
    });
  }

  // 정리: 만료/접속 끊김
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      const room = getRoom(s.code);
      if (!room || room.ended) { endSession(s, 'room-ended'); continue; }
      if (now - s.createdAt > SESSION_MAX_MS) { endSession(s, 'expired'); continue; }
      if ((s.state === 'pending' || s.state === 'approved') && now - s.createdAt > PENDING_TTL_MS) {
        endSession(s, 'timeout');
        continue;
      }
      const hostOk = !!room.hostConnected;
      const target = room.viewers.get(s.targetClientId);
      const targetOk = !!target && target.connected !== false;
      s.hostGoneAt = hostOk ? 0 : (s.hostGoneAt || now);
      s.targetGoneAt = targetOk ? 0 : (s.targetGoneAt || now);
      if ((s.hostGoneAt && now - s.hostGoneAt > DISCONNECT_GRACE_MS)
        || (s.targetGoneAt && now - s.targetGoneAt > DISCONNECT_GRACE_MS)) {
        endSession(s, 'peer-left');
      }
    }
  }, 4000);
  sweepTimer.unref?.();

  return { attachSocket, handleUpgrade, registerRoutes, checkRoom, _sessions: sessions, _sanitizeEvents: sanitizeEvents, _buildAgentScript: buildAgentScript };
}

module.exports = { createRemoteControl, sanitizeEvents, buildAgentScript };
