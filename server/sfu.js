/**
 * mediasoup SFU — 확정 단일 미디어 경로
 * 호스트 1회 produce → 참가자 consume
 * WebRtcServer: 고정 포트 44444 (TCP 우선 + UDP 보조)
 */
const os = require('os');
const mediasoup = require('mediasoup');

const RTC_PORT = Number(process.env.MEDIASOUP_RTC_PORT || 44444);

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1, // 원거리 패킷 손실 시 Opus 인밴드 FEC 자동 복구
      usedtx: 0,        // DTX 비활성화 (말문 시작 시 첫 음절 잘림 방지)
      minptime: 10,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 800,
      'x-google-max-bitrate': 2500,
      'x-google-min-bitrate': 200,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 800,
      'x-google-max-bitrate': 2500,
      'x-google-min-bitrate': 200,
    },
  },
];

function detectLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = net.family === 4 || net.family === 'IPv4';
      if (family && !net.internal) return net.address;
    }
  }
  return null;
}

function detectAnnouncedIp() {
  if (process.env.MEDIASOUP_ANNOUNCED_IP) return process.env.MEDIASOUP_ANNOUNCED_IP;
  return detectLanIp() || '127.0.0.1';
}

/**
 * ICE 후보용 announced IP 목록 (공인 + LAN).
 * 공인만 있으면 같은 Wi‑Fi에서 hairpin NAT 실패로 영상이 안 나올 수 있음.
 */
function getAnnouncedAddresses() {
  const publicIp = process.env.MEDIASOUP_ANNOUNCED_IP || null;
  const lanIp = detectLanIp();
  const list = [];
  const seen = new Set();
  for (const addr of [publicIp, lanIp]) {
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    list.push(addr);
  }
  if (!list.length) list.push('127.0.0.1');
  return list;
}

/** @deprecated boot log / 호환 — announcedIp 필드 유지 */
function getListenIps() {
  return getAnnouncedAddresses().map((announcedIp) => ({
    ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
    announcedIp,
    announcedAddress: announcedIp,
  }));
}

function getRtcPort() {
  return RTC_PORT;
}

/**
 * WebRtcServer listenInfos — 고정 포트 1개(UDP+TCP).
 * 동일 ip:port를 announcedAddress만 바꿔 두 번 bind하면 EADDRINUSE →
 * 공인은 0.0.0.0, LAN은 LAN IPv4에 각각 바인드(가능하면 둘 다 ICE 후보).
 */
function buildListenInfos() {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  const publicIp = process.env.MEDIASOUP_ANNOUNCED_IP || null;
  const lanIp = detectLanIp();
  const infos = [];
  const pushPair = (ip, announcedAddress) => {
    infos.push({ protocol: 'udp', ip, announcedAddress, port: RTC_PORT });
    infos.push({ protocol: 'tcp', ip, announcedAddress, port: RTC_PORT });
  };

  if (publicIp && lanIp && publicIp !== lanIp) {
    // 공인: 전체 인터페이스 / LAN: LAN NIC — 같은 포트, 다른 bind IP
    pushPair(listenIp, publicIp);
    pushPair(lanIp, lanIp);
  } else {
    const announced = publicIp || lanIp || '127.0.0.1';
    const ip = announced === '127.0.0.1' ? '127.0.0.1' : listenIp;
    pushPair(ip, announced);
  }
  return infos;
}

/** @type {import('mediasoup').types.Worker | null} */
let worker = null;
/** @type {import('mediasoup').types.WebRtcServer | null} */
let webRtcServer = null;

/** roomCode -> SfuRoom */
const sfuRooms = new Map();

/**
 * @typedef {{
 *  router: import('mediasoup').types.Router,
 *  peers: Map<string, SfuPeer>,
 * }} SfuRoom
 *
 * @typedef {{
 *  clientId: string,
 *  role: string,
 *  transports: Map<string, import('mediasoup').types.WebRtcTransport>,
 *  producers: Map<string, import('mediasoup').types.Producer>,
 *  consumers: Map<string, import('mediasoup').types.Consumer>,
 * }} SfuPeer
 */

async function getWorker() {
  if (worker && !worker.closed && webRtcServer && !webRtcServer.closed) {
    return worker;
  }
  if (webRtcServer && !webRtcServer.closed) {
    try { webRtcServer.close(); } catch { /* ignore */ }
  }
  webRtcServer = null;
  if (worker && !worker.closed) {
    try { worker.close(); } catch { /* ignore */ }
  }

  worker = await mediasoup.createWorker({
    logLevel: process.env.MEDIASOUP_LOG || 'warn',
  });
  worker.on('died', () => {
    console.error('[sfu] mediasoup worker died');
    worker = null;
    webRtcServer = null;
  });

  const listenInfos = buildListenInfos();
  webRtcServer = await worker.createWebRtcServer({ listenInfos });
  console.log(
    `[sfu] worker pid=${worker.pid} rtcPort=${RTC_PORT} ice=${getAnnouncedAddresses().join(',')}`
  );
  return worker;
}

async function getWebRtcServer() {
  await getWorker();
  if (!webRtcServer || webRtcServer.closed) {
    throw new Error('WebRtcServer unavailable');
  }
  return webRtcServer;
}

async function getOrCreateRoom(roomCode) {
  const code = String(roomCode || '');
  let room = sfuRooms.get(code);
  if (room && !room.router.closed) return room;
  const w = await getWorker();
  const router = await w.createRouter({ mediaCodecs });
  room = { router, peers: new Map() };
  sfuRooms.set(code, room);
  return room;
}

function getPeer(room, clientId) {
  let peer = room.peers.get(clientId);
  if (!peer) {
    peer = {
      clientId,
      role: 'viewer',
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    };
    room.peers.set(clientId, peer);
  }
  return peer;
}

function isHostOnlyFaceSource(source = '') {
  return source === 'camera' || source === 'viewer-camera';
}

function listProducers(room, { excludeClientId, forRole } = {}) {
  const list = [];
  for (const peer of room.peers.values()) {
    if (excludeClientId && peer.clientId === excludeClientId) continue;
    for (const producer of peer.producers.values()) {
      if (producer.closed) continue;
      const source = producer.appData?.source || '';
      // 얼굴 영상은 호스트만 수신 — 뷰어 목록/consume 대상에서 제외
      if (forRole === 'viewer' && isHostOnlyFaceSource(source)) continue;
      list.push({
        producerId: producer.id,
        clientId: peer.clientId,
        role: peer.role,
        kind: producer.kind,
        appData: producer.appData || {},
      });
    }
  }
  return list;
}

function emitToHostPeers(io, room, event, payload) {
  if (!io || !room) return;
  for (const peer of room.peers.values()) {
    if (peer.role !== 'host') continue;
    if (peer.socketId) {
      try { io.to(peer.socketId).emit(event, payload); } catch { /* ignore */ }
    }
  }
}

function emitProducerEvent(io, room, roomCode, event, payload, appData = {}) {
  try { io.to(roomCode).emit(event, payload); } catch { /* ignore */ }
}

/**
 * Chrome: 동일 PC에서 produce 재협상 시 extension ID 재할당 충돌 방지
 * (video-orientation ↔ transport-wide-cc)
 */
function clientRtpCapabilities(router) {
  const caps = JSON.parse(JSON.stringify(router.rtpCapabilities));
  const deny = new Set([
    'urn:3gpp:video-orientation',
    'urn:ietf:params:rtp-hdrext:toffset',
  ]);
  caps.headerExtensions = (caps.headerExtensions || []).filter((ext) => !deny.has(ext.uri));
  return caps;
}

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

async function createWebRtcTransport(router) {
  const server = await getWebRtcServer();
  const transport = await router.createWebRtcTransport({
    webRtcServer: server,
    enableUdp: true,
    enableTcp: true,
    // 공유기 UDP 40000–49999(44444 포함) 활용. TCP는 보조.
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
    minimumAvailableOutgoingBitrate: 300_000,
    maxIncomingBitrate: 3_500_000,
  });
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers: DEFAULT_ICE_SERVERS,
    },
  };
}

function attachTransportDiag(transport, label) {
  const tid = String(transport.id || '').slice(0, 8);
  transport.on('icestatechange', (state) => {
    console.log(`[sfu] ice ${label} ${tid} → ${state}`);
  });
  transport.on('iceselectedtuplechange', (tuple) => {
    console.log(
      `[sfu] ice-selected ${label} ${tid}`,
      tuple?.local?.ip || tuple?.localIp,
      tuple?.local?.port || tuple?.localPort,
      '↔',
      tuple?.remote?.ip || tuple?.remoteIp,
      tuple?.remote?.port || tuple?.remotePort,
      tuple?.protocol || ''
    );
  });
  transport.on('dtlsstatechange', (state) => {
    console.log(`[sfu] dtls ${label} ${tid} → ${state}`);
  });
}

/** 진단용 SFU 스냅샷 (외부 ICE 실패 확인) */
async function getSfuSnapshot(roomCode) {
  const code = String(roomCode || '');
  const room = sfuRooms.get(code);
  if (!room) {
    return {
      ok: true,
      code,
      exists: false,
      rtcPort: RTC_PORT,
      iceIps: getAnnouncedAddresses(),
      peers: [],
    };
  }
  const peers = [];
  for (const [clientId, peer] of room.peers.entries()) {
    const transports = [];
    for (const [tid, t] of peer.transports.entries()) {
      let stats = null;
      try {
        const list = await t.getStats();
        // mediasoup getStats → Map or array depending on version
        const arr = list instanceof Map ? [...list.values()] : Array.isArray(list) ? list : [];
        const ice = arr.find((s) => s.type === 'ice-server' || s.type === 'transport' || s.iceState);
        stats = {
          iceState: t.iceState,
          dtlsState: t.dtlsState,
          iceSelectedTuple: t.iceSelectedTuple || null,
          bytesReceived: ice?.bytesReceived,
          bytesSent: ice?.bytesSent,
        };
      } catch {
        stats = { iceState: t.iceState, dtlsState: t.dtlsState, iceSelectedTuple: t.iceSelectedTuple || null };
      }
      transports.push({
        id: tid,
        direction: t.appData?.direction || null,
        ...stats,
        candidates: (t.iceCandidates || []).map((c) => ({
          ip: c.ip || c.address,
          port: c.port,
          protocol: c.protocol,
          type: c.type,
        })),
      });
    }
    peers.push({
      clientId,
      role: peer.role,
      producers: [...peer.producers.values()].map((p) => ({
        id: p.id,
        kind: p.kind,
        paused: p.paused,
        closed: p.closed,
        source: p.appData?.source || null,
      })),
      consumers: [...peer.consumers.values()].map((c) => ({
        id: c.id,
        kind: c.kind,
        paused: c.paused,
        producerId: c.producerId,
      })),
      transports,
    });
  }
  return {
    ok: true,
    code,
    exists: true,
    rtcPort: RTC_PORT,
    iceIps: getAnnouncedAddresses(),
    peerCount: peers.length,
    producerCount: peers.reduce((n, p) => n + p.producers.length, 0),
    peers,
  };
}

function closePeer(room, clientId) {
  const peer = room.peers.get(clientId);
  if (!peer) return [];
  const closedProducers = [];
  for (const producer of peer.producers.values()) {
    closedProducers.push({
      producerId: producer.id,
      appData: producer.appData || {},
    });
    try { producer.close(); } catch { /* ignore */ }
  }
  for (const consumer of peer.consumers.values()) {
    try { consumer.close(); } catch { /* ignore */ }
  }
  for (const transport of peer.transports.values()) {
    try { transport.close(); } catch { /* ignore */ }
  }
  room.peers.delete(clientId);
  return closedProducers;
}

function closeRoomIfEmpty(roomCode) {
  const room = sfuRooms.get(roomCode);
  if (!room) return;
  if (room.peers.size > 0) return;
  try { room.router.close(); } catch { /* ignore */ }
  sfuRooms.delete(roomCode);
}

/**
 * Socket.io SFU 핸들러 등록
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomCode: () => string, getClientId: () => string, getRole: () => string, io: import('socket.io').Server }} ctx
 */
const lastProducerPliTimes = new Map(); // producerId -> timestamp

async function requestKeyframeThrottled(consumer) {
  if (!consumer || consumer.closed || consumer.kind !== 'video') return;
  const producerId = consumer.producerId;
  const now = Date.now();
  const lastTime = lastProducerPliTimes.get(producerId) || 0;
  // 다중 시청자 동시 접속 시 키프레임(PLI) 폭풍 방지
  // 얼굴(저해상)은 1.2초, 화면공유는 2.5초
  const source = consumer.appData?.source || '';
  const isFace = source === 'camera' || source === 'viewer-camera';
  const minGap = isFace ? 3000 : 2500;
  if (now - lastTime < minGap) {
    return;
  }
  lastProducerPliTimes.set(producerId, now);
  try {
    await consumer.requestKeyFrame();
  } catch { /* ignore */ }
}

function attachSfuHandlers(socket, ctx) {
  socket.on('sfu-get-capabilities', async (_msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      if (!code) return cb?.({ error: 'no-room' });
      const room = await getOrCreateRoom(code);
      const role = ctx.getRole() || 'viewer';
      const peer = getPeer(room, clientId);
      peer.role = role;
      peer.socketId = socket.id;
      const producers = listProducers(room, { excludeClientId: clientId, forRole: role });
      console.log(
        `[sfu] caps room=${code} peer=${String(clientId || '').slice(0, 8)} role=${role} producers=${producers.length}`
      );
      cb?.({
        ok: true,
        rtpCapabilities: clientRtpCapabilities(room.router),
        producers,
      });
    } catch (err) {
      console.error('[sfu-get-capabilities]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-create-transport', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      if (!code || !clientId) return cb?.({ error: 'no-room' });
      const room = await getOrCreateRoom(code);
      const peer = getPeer(room, clientId);
      peer.role = ctx.getRole() || peer.role;
      peer.socketId = socket.id;
      const direction = msg?.direction === 'recv' ? 'recv' : 'send';
      // 재접속/새로고침 시 동일 direction의 기존 트랜스포트가 남아 있다면 즉시 안전하게 종료 및 정리 (타임아웃 캐스케이드 차단)
      for (const [oldId, oldT] of [...peer.transports.entries()]) {
        if (oldT.appData?.direction === direction) {
          console.log(`[sfu] cleaning up replaced transport ${oldId} for peer ${String(clientId).slice(0, 8)} (${direction})`);
          try { oldT.close(); } catch { /* ignore */ }
          peer.transports.delete(oldId);
        }
      }
      const { transport, params } = await createWebRtcTransport(room.router);
      peer.transports.set(transport.id, transport);
      transport.appData = { direction, clientId };
      const label = `${code}/${peer.role}/${direction}/${String(clientId).slice(0, 8)}`;
      attachTransportDiag(transport, label);
      const cands = (params.iceCandidates || [])
        .map((c) => `${c.protocol}/${c.ip || c.address}:${c.port}`)
        .join(', ');
      console.log(`[sfu] transport ${label} id=${String(transport.id).slice(0, 8)} candidates=[${cands}]`);
      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed' || state === 'failed') {
          try { transport.close(); } catch { /* ignore */ }
          peer.transports.delete(transport.id);
        }
      });
      cb?.({ ok: true, ...params, direction });
    } catch (err) {
      console.error('[sfu-create-transport]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-connect-transport', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const transport = peer?.transports.get(msg?.transportId);
      if (!transport) return cb?.({ error: 'transport-not-found' });
      await transport.connect({ dtlsParameters: msg.dtlsParameters });
      cb?.({ ok: true });
    } catch (err) {
      console.error('[sfu-connect-transport]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  // 2차 안전망: 무중단 ICE 재협상
  socket.on('sfu-restart-ice', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const transport = peer?.transports.get(msg?.transportId);
      if (!transport || transport.closed) return cb?.({ error: 'transport-not-found' });
      const iceParameters = await transport.restartIce();
      console.log(`[sfu] ICE restart success: room=${code} client=${String(clientId || '').slice(0, 8)} transport=${String(transport.id).slice(0, 8)}`);
      cb?.({ ok: true, iceParameters });
    } catch (err) {
      console.error('[sfu-restart-ice]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-produce', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const role = ctx.getRole() || 'viewer';
      const interactionMode = typeof ctx.getInteractionMode === 'function'
        ? ctx.getInteractionMode()
        : 'bidirectional';
      // 단방향(대규모 시청): 참가자는 consume만 — produce 차단
      if (interactionMode === 'unidirectional' && role === 'viewer') {
        return cb?.({ error: 'unidirectional-room' });
      }
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const transport = peer?.transports.get(msg?.transportId);
      if (!transport) return cb?.({ error: 'transport-not-found' });
      peer.role = role || peer.role;
      peer.socketId = socket.id;

      const producer = await transport.produce({
        kind: msg.kind,
        rtpParameters: msg.rtpParameters,
        appData: {
          ...(msg.appData || {}),
          clientId,
          role: peer.role,
          trackKind: msg.appData?.trackKind || msg.kind,
        },
      });
      peer.producers.set(producer.id, producer);
      producer.on('transportclose', () => {
        peer.producers.delete(producer.id);
        emitProducerEvent(ctx.io, room, code, 'sfu-producer-closed', {
          producerId: producer.id,
          clientId,
          appData: producer.appData || {},
        }, producer.appData || {});
      });

      console.log(
        `[sfu] produce room=${code} peer=${String(clientId).slice(0, 8)} kind=${producer.kind} source=${producer.appData?.source || '-'} ice=${transport.iceState} id=${String(producer.id).slice(0, 8)}`
      );
      // 오디오 비트레이트 스냅샷 (호스트 마이크 무음 여부 확인)
      if (producer.kind === 'audio') {
        setTimeout(() => {
          producer.getStats().then((stats) => {
            const arr = stats instanceof Map ? [...stats.values()] : [];
            const out = arr.find((s) => s.type === 'outbound-rtp' || s.bitrate != null || s.byteCount != null);
            console.log(
              `[sfu] produce-stats id=${String(producer.id).slice(0, 8)} source=${producer.appData?.source || '-'}`,
              out
                ? `bytes=${out.byteCount ?? out.bytesSent ?? '?'} bitrate=${out.bitrate ?? '?'} score=${JSON.stringify(producer.score || null)}`
                : `score=${JSON.stringify(producer.score || null)} keys=${arr.map((s) => s.type).join(',')}`
            );
          }).catch(() => {});
        }, 2000);
      }

      // 얼굴 영상은 호스트에게만 알림 (클라이언트 N명은 서로 consume하지 않음)
      emitProducerEvent(ctx.io, room, code, 'sfu-new-producer', {
        producerId: producer.id,
        clientId,
        role: peer.role,
        kind: producer.kind,
        appData: producer.appData || {},
      }, producer.appData || {});

      cb?.({ ok: true, id: producer.id });
    } catch (err) {
      console.error('[sfu-produce]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-consume', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      if (!room || !peer) return cb?.({ error: 'no-peer' });

      let transport = msg?.transportId ? peer.transports.get(msg.transportId) : null;
      if (!transport || transport.closed) {
        const liveRecv = [...peer.transports.values()].filter((t) => t.appData?.direction === 'recv' && !t.closed);
        transport = liveRecv[liveRecv.length - 1];
      }
      if (!transport || transport.closed) return cb?.({ error: 'recv-transport-not-found' });

      const producerId = msg?.producerId;
      if (!producerId) return cb?.({ error: 'no-producer' });
      if (!room.router.canConsume({ producerId, rtpCapabilities: msg.rtpCapabilities })) {
        console.warn(`[sfu] cannot-consume room=${code} peer=${String(clientId).slice(0, 8)} producer=${String(producerId).slice(0, 8)}`);
        return cb?.({ error: 'cannot-consume' });
      }

      let targetProducer = null;
      for (const p of room.peers.values()) {
        const prod = p.producers.get(producerId);
        if (prod) {
          targetProducer = prod;
          break;
        }
      }

      // 얼굴 영상은 호스트만 consume 허용 (클라이언트끼리/클라이언트가 얼굴 수신 차단)
      const src = targetProducer?.appData?.source || '';
      const role = ctx.getRole() || peer.role || 'viewer';
      peer.role = role;
      peer.socketId = socket.id;
      const isHost = role === 'host' || room.hostClientId === clientId || room.hostSocketId === socket.id;
      if (!isHost && isHostOnlyFaceSource(src)) {
        console.warn(`[sfu] face-consume-denied room=${code} peer=${String(clientId).slice(0, 8)} role=${role} source=${src}`);
        return cb?.({ error: 'face-host-only' });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: msg.rtpCapabilities,
        appData: targetProducer?.appData || {},
        enableRtx: true, // RFC 4588 RTX 재전송 활성화로 패킷 손실 시 영상 멈춤 완벽 복구
        ignoreDtx: true,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('sfu-producer-closed', { producerId, consumerId: consumer.id });
      });

      console.log(
        `[sfu] consume room=${code} peer=${String(clientId).slice(0, 8)} kind=${consumer.kind} producer=${String(producerId).slice(0, 8)} ice=${transport.iceState}`
      );

      cb?.({
        ok: true,
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: consumer.appData || targetProducer?.appData || {},
        producerPaused: consumer.producerPaused,
      });
    } catch (err) {
      console.error('[sfu-consume]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-pause-consumer', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const consumer = peer?.consumers.get(msg?.consumerId);
      if (consumer && !consumer.closed) {
        await consumer.pause();
      }
      cb?.({ ok: true });
    } catch (err) {
      console.error('[sfu-pause-consumer]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-resume-consumer', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const consumer = peer?.consumers.get(msg?.consumerId);
      if (!consumer) return cb?.({ error: 'consumer-not-found' });
      await consumer.resume();
      cb?.({ ok: true });
    } catch (err) {
      console.error('[sfu-resume-consumer]', err);
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-request-keyframe', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      // consumerId 없으면 전체 PLI 하지 않음 (과부하 방지)
      if (msg?.consumerId) {
        const consumer = peer?.consumers.get(msg.consumerId);
        if (consumer && consumer.kind === 'video') {
          await requestKeyframeThrottled(consumer);
        }
      }
      cb?.({ ok: true });
    } catch {
      cb?.({ ok: false });
    }
  });

  socket.on('sfu-close-producer', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const producer = peer?.producers.get(msg?.producerId);
      if (producer) {
        const id = producer.id;
        const appData = producer.appData || {};
        producer.close();
        peer.producers.delete(id);
        emitProducerEvent(ctx.io, room, code, 'sfu-producer-closed', {
          producerId: id,
          clientId,
          appData,
        }, appData);
      }
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ error: err.message || 'sfu-error' });
    }
  });

  socket.on('sfu-get-producers', async (_msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      if (!code) return cb?.({ ok: true, producers: [] });
      const room = await getOrCreateRoom(code);
      const producers = listProducers(room, { excludeClientId: clientId, forRole: ctx.getRole() || 'viewer' });
      console.log(
        `[sfu] get-producers room=${code} peer=${String(clientId || '').slice(0, 8)} count=${producers.length}`
      );
      cb?.({ ok: true, producers });
    } catch (err) {
      cb?.({ error: err.message || 'sfu-error' });
    }
  });
}

function cleanupSocketPeer(roomCode, clientId, io) {
  const room = sfuRooms.get(roomCode);
  if (!room) return;
  const closed = closePeer(room, clientId);
  for (const item of closed) {
    emitProducerEvent(io, room, roomCode, 'sfu-producer-closed', {
      producerId: item.producerId,
      clientId,
      appData: item.appData,
    }, item.appData);
  }
  closeRoomIfEmpty(roomCode);
}

/** 방 전체 SFU 리소스 해제 (빈 방 폐기 시) */
function disposeSfuRoom(roomCode) {
  const room = sfuRooms.get(roomCode);
  if (!room) return;
  for (const clientId of [...room.peers.keys()]) {
    closePeer(room, clientId);
  }
  try { room.router.close(); } catch { /* ignore */ }
  sfuRooms.delete(roomCode);
}

module.exports = {
  attachSfuHandlers,
  cleanupSocketPeer,
  disposeSfuRoom,
  getOrCreateRoom,
  listProducers,
  getSfuSnapshot,
  detectAnnouncedIp,
  getListenIps,
  getRtcPort,
  getAnnouncedAddresses,
  getWorker,
  getWebRtcServer,
};
