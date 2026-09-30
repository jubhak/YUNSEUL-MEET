'use strict';

/**
 * 딥페이크 프레임 릴레이 + 호스트 직송(feed)
 *
 *  참가자 브라우저 ──(JPEG)──▶ /face-swap-ws ──▶ [이 모듈] ──▶ GPU 워커(Python)
 *                                                    │
 *  참가자 브라우저 ◀──(딥페이크 JPEG)────────────────┤  (기존과 동일하게 되돌려 줌: SFU 폴백 경로용)
 *  호스트 브라우저 ◀──(딥페이크 JPEG)── /face-feed ──┘  (신규: 호스트 화면에 곧바로 그림 → stress_test.html 과 같은 속도/화질)
 *
 * - 참가자↔워커 구간은 기존 raw TCP 프록시와 같은 프로토콜(바이너리/텍스트 그대로 전달)이다.
 * - permessage-deflate 를 끈다. JPEG 은 압축이 안 되는데 CPU 만 먹는다.
 * - 워커가 여러 포트(FACE_SWAP_PORTS=8765,8766,…)에 떠 있으면 접속 수가 가장 적은 쪽으로 분배한다.
 * - 호스트 feed 는 느린 호스트가 있어도 서버 메모리가 쌓이지 않도록 송신 버퍼가 차면 프레임을 버린다.
 * - FACE_RELAY=0 이면 이 모듈이 비활성화되어 기존 raw 프록시가 그대로 동작한다. FACE_FEED=0 이면 호스트 직송만 끈다.
 */

const { WebSocketServer, WebSocket } = require('ws');

const FS2_MAGIC = 0x46533200; // "FS2\0"
const MAX_MSG = 10 * 1024 * 1024;
const CLIENT_SLOW_BUF = 768 * 1024;   // 참가자 쪽 송신 버퍼가 이보다 크면 되돌려주는 프레임 폐기
const FEED_MAX_BUF = 512 * 1024;      // 호스트 쪽 송신 버퍼 상한
const OPEN = 1;

function createFaceRelay({ rooms, requireHost, getRoom, log = console.log }) {
  const relayEnabled = process.env.FACE_RELAY !== '0';
  const feedEnabled = process.env.FACE_FEED !== '0';
  // 참가자에게 결과 JPEG 를 돌려주지 않는 모드(기본 auto).
  //  - 호스트 직송(feed)으로 실제 전달된 프레임은 참가자에게 13바이트 ack 만 보낸다(대역폭/송신 CPU 절약).
  //  - 직송이 안 된 프레임(호스트 미접속/느린 호스트/직송 끔)은 기존처럼 전체를 돌려줘서 SFU 폴백 영상이 유지된다.
  //  - FACE_CLIENT_RETURN=always 면 예전처럼 항상 돌려준다.
  const returnAlways = String(process.env.FACE_CLIENT_RETURN || 'auto').toLowerCase() === 'always';
  // 직송이 정상이어도 이 간격마다 1장은 전체를 돌려줘 참가자 쪽 canvas(SFU 폴백 영상)를 신선하게 유지. 0 = 끔
  const keepWarmRaw = process.env.FACE_CLIENT_KEEPWARM_MS;
  const keepWarmMs = keepWarmRaw === undefined || keepWarmRaw === '' || !Number.isFinite(Number(keepWarmRaw))
    ? 2000
    : Math.max(0, Number(keepWarmRaw));
  // 호스트가 "이 참가자의 직송을 지금 화면에 그리고 있다"고 보고한 뒤 이 시간 안이면 유효(ms).
  // 보고가 없으면(구버전 호스트 포함) 항상 전체 JPEG 를 돌려준다 = 안전한 기본 동작.
  const liveTtlRaw = Number(process.env.FACE_FEED_LIVE_TTL_MS);
  const liveTtlMs = Number.isFinite(liveTtlRaw) && liveTtlRaw > 0 ? liveTtlRaw : 1200;
  // 직송이 안정적이면 참가자에게 {"type":"feed","live":true} 를 알려 SFU 카메라 송출(VP8)을 저fps 로 낮추게 한다.
  // FACE_SFU_SAVE=0 이면 알리지 않는다.
  const sfuSaveEnabled = process.env.FACE_SFU_SAVE !== '0' && !returnAlways;
  const SFU_SAVE_STABLE_MS = 2000;     // 이 시간 동안 연속으로 직송이 확인돼야 "live" 로 전환
  const SFU_SAVE_HEARTBEAT_MS = 4000;  // live 동안 주기적으로 재통지(참가자 재송출/재접속 대비)
  const SFU_SAVE_IDLE_MS = 3000;       // 프레임이 이만큼 끊기면 live 해제(딥페이크 끔/카메라 끔)

  const swapWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MSG });
  const feedWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });

  /** roomCode -> Set<WebSocket> (호스트 feed 구독자) */
  const hostFeeds = new Map();
  /** 워커 포트별 현재 접속 수 */
  const portLoad = new Map();
  /** clientId -> { code, ts } (방 조회 캐시) */
  const roomCache = new Map();

  const stats = {
    swapConns: 0, framesIn: 0, framesFed: 0, feedDropped: 0, clientDropped: 0,
    clientReturned: 0,   // 참가자에게 JPEG 전체를 돌려준 횟수
    clientAcked: 0,      // 직송이 전달되어 ack 만 보낸 횟수 (절약된 왕복)
    sfuSaveOn: 0,        // 참가자 SFU 카메라 송출 저fps 전환 통지 횟수
    sfuSaveOff: 0,       // 복원 통지 횟수
  };

  function getPorts() {
    const list = String(process.env.FACE_SWAP_PORTS || '')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (list.length) return list;
    return [Number(process.env.FACE_SWAP_PORT || 8765)];
  }

  /** 연결에 실패한 포트는 잠시 후보에서 제외 (워커 기동 중/다운) */
  const portDownUntil = new Map();

  function pickPort() {
    const now = Date.now();
    const all = getPorts();
    const alive = all.filter((p) => (portDownUntil.get(p) || 0) <= now);
    let best = null;
    for (const p of (alive.length ? alive : all)) {
      const load = portLoad.get(p) || 0;
      if (best === null || load < best.load) best = { port: p, load };
    }
    portLoad.set(best.port, (portLoad.get(best.port) || 0) + 1);
    return best.port;
  }

  function roomOfClient(cid) {
    if (!cid) return null;
    const now = Date.now();
    const hit = roomCache.get(cid);
    if (hit && now - hit.ts < 4000) return hit.code;
    let code = null;
    for (const room of rooms.values()) {
      if (room?.viewers?.has(cid)) { code = room.code; break; }
    }
    roomCache.set(cid, { code, ts: now });
    if (roomCache.size > 512) {
      for (const [k, v] of roomCache) if (now - v.ts > 30000) roomCache.delete(k);
    }
    return code;
  }

  /** 호스트가 이 참가자의 직송을 화면에 그리고 있다고 최근(liveTtlMs)에 보고했는가 */
  function isHostLive(cid) {
    const code = roomOfClient(cid);
    if (!code) return false;
    const set = hostFeeds.get(code);
    if (!set || !set.size) return false;
    const now = Date.now();
    for (const h of set) {
      const ts = h._live && h._live.get(cid);
      if (ts && now - ts < liveTtlMs && h.readyState === OPEN) return true;
    }
    return false;
  }

  /** 호스트 feed 로 프레임을 보낸다. 실제로 전송에 성공한 호스트 수를 반환(0 이면 호스트가 이 프레임을 못 받음). */
  function publishToHosts(cid, data) {
    if (!feedEnabled || data.length < 16 || data.readUInt32BE(0) !== FS2_MAGIC) return 0;
    const code = roomOfClient(cid);
    if (!code) return 0;
    const set = hostFeeds.get(code);
    if (!set || !set.size) return 0;
    let packet = null;
    let delivered = 0;
    for (const h of set) {
      if (h.readyState !== OPEN) continue;
      if (h.bufferedAmount > FEED_MAX_BUF) { stats.feedDropped += 1; continue; }
      if (!packet) {
        const idBuf = Buffer.from(String(cid), 'utf8').subarray(0, 255);
        packet = Buffer.concat([Buffer.from([idBuf.length]), idBuf, data]);
      }
      try { h.send(packet, { binary: true }); stats.framesFed += 1; delivered += 1; } catch { /* ignore */ }
    }
    return delivered;
  }

  /**
   * 결과 프레임의 "응답 헤더(FS2 magic + seq + procMs + totalMs, 12바이트)"만 복사하고 1바이트를 덧붙인 ack.
   * 클라이언트는 이를 헤더 있는 '이미지 없는 응답'으로 처리한다: 슬롯 해제 + RTT/처리시간 갱신 + 다음 프레임 요청.
   * (100바이트 미만 페이로드는 디코드하지 않음 — virtual-avatar-manager._onSwapMessage)
   */
  function makeAck(data) {
    const ack = Buffer.allocUnsafe(13);
    data.copy(ack, 0, 0, 12);
    ack[12] = 0;
    return ack;
  }

  function dropNotice(data) {
    // FS2 응답을 참가자에게 못 보낼 때 v2 클라이언트가 즉시 슬롯을 회수하도록 drop 알림으로 대체
    if (data.length >= 8 && data.readUInt32BE(0) === FS2_MAGIC) {
      return JSON.stringify({ type: 'drop', seq: data.readUInt32BE(4) });
    }
    return '{"type":"skip"}';
  }

  function onSwapConnection(ws, req) {
    let cid = '';
    let prio = '';
    try {
      const u = new URL(req.url, 'http://localhost');
      cid = String(u.searchParams.get('client') || '');
      // 호스트 본인의 딥페이크는 워커 입장 제어(용량 초과 거절)에서 제외한다
      if (u.searchParams.get('prio') === 'host') prio = 'host';
    } catch { /* ignore */ }

    if (prio === 'host') {
      let isHost = false;
      if (cid) {
        for (const room of rooms.values()) {
          if (room && !room.ended && room.hostClientId === cid) { isHost = true; break; }
        }
      }
      if (!isHost) prio = '';
    }

    const port = pickPort();
    stats.swapConns += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      portLoad.set(port, Math.max(0, (portLoad.get(port) || 1) - 1));
    };

    try { ws._socket?.setNoDelay(true); } catch { /* ignore */ }

    const headers = {};
    if (cid) headers['X-Client-Id'] = cid;
    if (prio) headers['X-Client-Prio'] = prio;
    const up = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers,
      perMessageDeflate: false,
      maxPayload: MAX_MSG,
      handshakeTimeout: 8000,
    });

    /** 워커 연결 전에 도착한 메시지 (프레임은 최신 몇 개만 유지) */
    let queue = [];
    let closed = false;
    // 프록시/터널의 유휴 타임아웃 방지 (브라우저는 pong 을 자동 응답)
    const pingTimer = setInterval(() => {
      try { if (ws.readyState === OPEN) ws.ping(); } catch { /* ignore */ }
    }, 25000);
    pingTimer.unref?.();
    const closeBoth = (code = 1000) => {
      if (closed) return;
      closed = true;
      release();
      clearInterval(pingTimer);
      try { if (ws.readyState <= 1) ws.close(code); } catch { /* ignore */ }
      try { if (up.readyState <= 1) up.close(); else up.terminate(); } catch { /* ignore */ }
    };

    let upOpened = false;
    up.on('open', () => {
      upOpened = true;
      portDownUntil.delete(port);
      try { up._socket?.setNoDelay(true); } catch { /* ignore */ }
      for (const [d, bin] of queue) {
        try { up.send(d, { binary: bin }); } catch { /* ignore */ }
      }
      queue = [];
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // hello 메시지의 clientId 를 반영(방 조회용)
        const s = data.toString();
        if (s.length < 512 && s.includes('"hello"')) {
          try {
            const m = JSON.parse(s);
            if (m?.type === 'hello' && m.clientId) cid = String(m.clientId);
          } catch { /* ignore */ }
        }
      }
      if (up.readyState === OPEN) {
        try { up.send(data, { binary: isBinary }); } catch { /* ignore */ }
      } else if (up.readyState === WebSocket.CONNECTING) {
        queue.push([data, isBinary]);
        let frames = 0;
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i][1] && ++frames > 3) queue.splice(i, 1);
        }
      }
    });

    let lastReturnAt = 0;   // 이 참가자에게 JPEG 전체를 마지막으로 돌려준 시각

    // ── 참가자 SFU 카메라 송출 절감 상태 ──
    let okSince = 0;          // 직송이 연속으로 확인되기 시작한 시각 (0 = 지금 불확실)
    let lastFrameAt = 0;
    let feedLive = false;     // 참가자에게 live=true 를 통지한 상태
    let lastStateAt = 0;
    const sendFeedState = (live) => {
      feedLive = live;
      lastStateAt = Date.now();
      if (live) stats.sfuSaveOn += 1; else stats.sfuSaveOff += 1;
      try { if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'feed', live })); } catch { /* ignore */ }
    };
    // 프레임이 끊기면(딥페이크 끔/카메라 끔) live 해제, live 동안은 주기적으로 재통지
    const stateTimer = setInterval(() => {
      if (!sfuSaveEnabled || ws.readyState !== OPEN) return;
      const now = Date.now();
      if (feedLive && now - lastFrameAt > SFU_SAVE_IDLE_MS) {
        okSince = 0;
        sendFeedState(false);
      } else if (feedLive && now - lastStateAt >= SFU_SAVE_HEARTBEAT_MS) {
        sendFeedState(true);
      }
    }, 1000);
    stateTimer.unref?.();
    ws.on('close', () => clearInterval(stateTimer));

    up.on('message', (data, isBinary) => {
      if (ws.readyState !== OPEN) return;
      if (isBinary) {
        stats.framesIn += 1;
        const delivered = publishToHosts(cid, data);
        const now = Date.now();
        lastFrameAt = now;
        // 호스트가 이 프레임을 받았고(delivered) + 화면에 그리고 있다고 보고했다(isHostLive) → 직송 정상.
        const hostOk = delivered > 0 && isHostLive(cid);
        if (sfuSaveEnabled) {
          if (hostOk) {
            if (!okSince) okSince = now;
            if (!feedLive && now - okSince >= SFU_SAVE_STABLE_MS) sendFeedState(true);
          } else {
            okSince = 0;
            if (feedLive) sendFeedState(false);   // 직송 이상 → 즉시 SFU 송출 복원
          }
        }
        // 직송 정상이고 keep-warm 간격 안이면 → 참가자에게는 이미지 대신 ack 만 (슬롯 해제/RTT 용).
        // 호스트가 못 받았거나 화면에 안 그리는 프레임은 항상 전체를 돌려준다(SFU 폴백 유지).
        const skipReturn = hostOk && !returnAlways
          && (keepWarmMs === 0 || now - lastReturnAt < keepWarmMs);
        if (skipReturn) {
          stats.clientAcked += 1;
          try { ws.send(makeAck(data), { binary: true }); } catch { /* ignore */ }
          return;
        }
        if (ws.bufferedAmount > CLIENT_SLOW_BUF) {
          stats.clientDropped += 1;
          try { ws.send(dropNotice(data)); } catch { /* ignore */ }
          return;
        }
        lastReturnAt = now;
        stats.clientReturned += 1;
      }
      try { ws.send(data, { binary: isBinary }); } catch { /* ignore */ }
    });

    ws.on('close', () => closeBoth());
    ws.on('error', () => closeBoth());
    up.on('close', () => closeBoth());
    up.on('error', () => {
      if (!upOpened) portDownUntil.set(port, Date.now() + 5000);
      closeBoth(1011);
    });
  }

  function onFeedConnection(ws, code) {
    let set = hostFeeds.get(code);
    if (!set) { set = new Set(); hostFeeds.set(code, set); }
    set.add(ws);
    try { ws._socket?.setNoDelay(true); } catch { /* ignore */ }
    const cleanup = () => {
      set.delete(ws);
      if (!set.size && hostFeeds.get(code) === set) hostFeeds.delete(code);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    // 호스트 → 서버: { t:'live', ids:[clientId,…] } = "지금 직송을 화면에 그리고 있는 참가자 목록"
    ws._live = new Map();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const s = data.toString();
      if (s.length > 16 * 1024 || !s.includes('"live"')) return;
      try {
        const m = JSON.parse(s);
        if (m?.t !== 'live' || !Array.isArray(m.ids)) return;
        const now = Date.now();
        const next = new Map();
        for (const id of m.ids.slice(0, 256)) {
          if (typeof id === 'string' && id.length <= 128) next.set(id, now);
        }
        ws._live = next;   // 호스트가 보낸 목록이 기준: 빠진 참가자는 즉시 무효
      } catch { /* ignore */ }
    });
    const pingTimer = setInterval(() => {
      try { if (ws.readyState === OPEN) ws.ping(); } catch { /* ignore */ }
    }, 25000);
    pingTimer.unref?.();
    ws.on('close', () => clearInterval(pingTimer));
    try { ws.send(JSON.stringify({ t: 'ready', feed: feedEnabled })); } catch { /* ignore */ }
  }

  /** HTTP upgrade 진입점. 처리했으면 true */
  function handleUpgrade(req, socket, head) {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { return false; }

    if (u.pathname === '/face-feed') {
      const code = String(u.searchParams.get('room') || '');
      const ht = String(u.searchParams.get('ht') || '');
      const room = feedEnabled ? getRoom(code) : null;
      if (!room || !requireHost(room, ht)) {
        log(`[face-feed] 거부: room=${code} found=${!!room} tokenLen=${ht.length}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return true;
      }
      feedWss.handleUpgrade(req, socket, head, (ws) => onFeedConnection(ws, room.code));
      return true;
    }

    if (relayEnabled && u.pathname === '/face-swap-ws') {
      const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
        .split(',')[0].trim().replace(/^::ffff:/, '');
      const local = (ip === '127.0.0.1' || ip === '::1')
        && (!fwd || fwd === '127.0.0.1' || fwd === '::1' || fwd.toLowerCase() === 'localhost');
      const cid = String(u.searchParams.get('client') || u.searchParams.get('client_id') || '');
      let inRoom = false;
      if (cid) {
        for (const room of rooms.values()) {
          if (!room || room.ended) continue;
          if (room.hostClientId === cid || room.viewers?.has(cid)) { inRoom = true; break; }
        }
      }
      if (!local && !inRoom) {
        log(`[face-swap-ws] 거부: client=${cid.slice(0, 8) || '-'}`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return true;
      }
      swapWss.handleUpgrade(req, socket, head, (ws) => onSwapConnection(ws, req));
      return true;
    }
    return false;
  }

  function getStats() {
    const feeds = {};
    for (const [code, set] of hostFeeds) feeds[code] = set.size;
    return {
      relay: relayEnabled,
      feed: feedEnabled,
      clientReturn: returnAlways ? 'always' : 'auto',
      keepWarmMs,
      sfuSave: sfuSaveEnabled,
      ports: getPorts().map((p) => ({ port: p, connections: portLoad.get(p) || 0 })),
      hostFeeds: feeds,
      ...stats,
    };
  }

  return { handleUpgrade, getStats };
}

module.exports = { createFaceRelay };
