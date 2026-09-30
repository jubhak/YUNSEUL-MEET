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

  const swapWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MSG });
  const feedWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });

  /** roomCode -> Set<WebSocket> (호스트 feed 구독자) */
  const hostFeeds = new Map();
  /** 워커 포트별 현재 접속 수 */
  const portLoad = new Map();
  /** clientId -> { code, ts } (방 조회 캐시) */
  const roomCache = new Map();

  const stats = { swapConns: 0, framesIn: 0, framesFed: 0, feedDropped: 0, clientDropped: 0 };

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

  function publishToHosts(cid, data) {
    if (!feedEnabled || data.length < 16 || data.readUInt32BE(0) !== FS2_MAGIC) return;
    const code = roomOfClient(cid);
    if (!code) return;
    const set = hostFeeds.get(code);
    if (!set || !set.size) return;
    let packet = null;
    for (const h of set) {
      if (h.readyState !== OPEN) continue;
      if (h.bufferedAmount > FEED_MAX_BUF) { stats.feedDropped += 1; continue; }
      if (!packet) {
        const idBuf = Buffer.from(String(cid), 'utf8').subarray(0, 255);
        packet = Buffer.concat([Buffer.from([idBuf.length]), idBuf, data]);
      }
      try { h.send(packet, { binary: true }); stats.framesFed += 1; } catch { /* ignore */ }
    }
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
    try {
      const u = new URL(req.url, 'http://localhost');
      cid = String(u.searchParams.get('client') || '');
    } catch { /* ignore */ }

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

    up.on('message', (data, isBinary) => {
      if (ws.readyState !== OPEN) return;
      if (isBinary) {
        stats.framesIn += 1;
        publishToHosts(cid, data);
        if (ws.bufferedAmount > CLIENT_SLOW_BUF) {
          stats.clientDropped += 1;
          try { ws.send(dropNotice(data)); } catch { /* ignore */ }
          return;
        }
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
    ws.on('message', () => { /* 호스트→서버 메시지는 사용하지 않음 */ });
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
      ports: getPorts().map((p) => ({ port: p, connections: portLoad.get(p) || 0 })),
      hostFeeds: feeds,
      ...stats,
    };
  }

  return { handleUpgrade, getStats };
}

module.exports = { createFaceRelay };
