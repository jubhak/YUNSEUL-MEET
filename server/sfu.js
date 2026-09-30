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
      'x-google-start-bitrate': 1200,
      'x-google-max-bitrate': 4500,
      'x-google-min-bitrate': 300,
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
      'x-google-start-bitrate': 1200,
      'x-google-max-bitrate': 4500,
      'x-google-min-bitrate': 300,
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
function buildListenInfos(port = RTC_PORT) {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  const publicIp = process.env.MEDIASOUP_ANNOUNCED_IP || null;
  const lanIp = detectLanIp();
  const infos = [];
  const pushPair = (ip, announcedAddress) => {
    infos.push({ protocol: 'udp', ip, announcedAddress, port });
    infos.push({ protocol: 'tcp', ip, announcedAddress, port });
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

/**
 * ── mediasoup Worker 풀 (10인 이상 다자간 확장의 핵심 수정) ──────────
 * 기존 구현은 Worker 프로세스를 "단 1개"만 만들었다. mediasoup Worker는
 * 단일 스레드(자체 이벤트 루프)에서 모든 RTP 패킷을 복사·라우팅하므로,
 * 참가자가 4명을 넘어 producer/consumer 수가 늘어나면 그 한 프로세스가
 * 병목이 되어 전 참가자의 영상이 함께 멈칫거린다(N명 × N-1 소비 구조).
 * → CPU 코어 수에 맞춰 Worker를 여러 개 띄우고, 방(Router)을 least-loaded
 *   로 분산한다. 각 Worker는 자기 전용 WebRtcServer(포트 자동 증가)를 갖는다.
 */
const osCpuCount = Math.max(1, (os.cpus() || []).length || 1);

function resolveWorkerCount() {
  const raw = String(process.env.MEDIASOUP_WORKERS || '').trim().toLowerCase();
  if (raw === 'auto') return Math.max(1, osCpuCount - 1);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(Math.floor(n), 16));
  return Math.max(2, Math.min(8, Math.floor(osCpuCount / 2) || 2));
}

const WORKER_COUNT = resolveWorkerCount();
/** 워커별 RTC 포트 간격 (기본 44444 → 44445, 44446 ...) */
const RTC_PORT_SPAN = Number(process.env.MEDIASOUP_RTC_PORT_SPAN || 32);

/** @type {Array<{index:number, worker:any, webRtcServer:any, routers:number}>} */
const workerPool = [];
let workerInitPromise = null;
let poolSeq = 0;

/** roomCode -> SfuRoom */
const sfuRooms = new Map();

/**
 * @typedef {{
 *  router: import('mediasoup').types.Router,
 *  webRtcServer: import('mediasoup').types.WebRtcServer|null,
 *  entry: object|null,
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

async function createPoolEntry(index) {
  const port = RTC_PORT + (index % RTC_PORT_SPAN);
  const w = await mediasoup.createWorker({
    logLevel: process.env.MEDIASOUP_LOG || 'warn',
  });
  const entry = { index, worker: w, webRtcServer: null, routers: 0 };
  workerPool.push(entry);

  w.on('died', () => {
    console.error(`[sfu] mediasoup worker#${index} died — respawning`);
    try { entry.webRtcServer?.close(); } catch { /* ignore */ }
    const i = workerPool.indexOf(entry);
    if (i >= 0) workerPool.splice(i, 1);
    setTimeout(() => { ensureWorkerPool().catch(() => {}); }, 500);
  });

  try {
    entry.webRtcServer = await w.createWebRtcServer({ listenInfos: buildListenInfos(port) });
  } catch (err) {
    console.error(`[sfu] worker#${index} RTC port ${port} bind failed: ${err.message}`);
    entry.webRtcServer = null;
  }
  console.log(
    `[sfu] worker#${index} ready pid=${w.pid} rtcPort=${port} ice=${getAnnouncedAddresses().join(',')}`
  );
  return entry;
}

async function ensureWorkerPool() {
  if (workerPool.length >= WORKER_COUNT) return workerPool;
  if (workerInitPromise) return workerInitPromise;
  workerInitPromise = (async () => {
    const need = WORKER_COUNT - workerPool.length;
    const jobs = [];
    for (let i = 0; i < need; i += 1) {
      jobs.push(createPoolEntry(poolSeq % RTC_PORT_SPAN));
      poolSeq += 1;
    }
    await Promise.all(jobs);
    console.log(`[sfu] worker pool ready: ${workerPool.length}/${WORKER_COUNT}`);
    return workerPool;
  })();
  try { return await workerInitPromise; } finally { workerInitPromise = null; }
}

function pickLeastLoaded() {
  if (!workerPool.length) return null;
  return workerPool.reduce((a, b) => ((b.routers || 0) < (a.routers || 0) ? b : a), workerPool[0]);
}

async function getWorker() {
  await ensureWorkerPool();
  const entry = pickLeastLoaded();
  if (!entry) throw new Error('mediasoup worker pool empty');
  return entry.worker;
}

async function getWebRtcServer() {
  await ensureWorkerPool();
  const entry = pickLeastLoaded();
  if (!entry?.webRtcServer || entry.webRtcServer.closed) throw new Error('WebRtcServer unavailable');
  return entry.webRtcServer;
}

async function getOrCreateRoom(roomCode) {
  const code = String(roomCode || '');
  let room = sfuRooms.get(code);
  if (room && !room.router.closed) return room;
  await ensureWorkerPool();
  const entry = pickLeastLoaded();
  if (!entry) throw new Error('mediasoup worker pool empty');
  const router = await entry.worker.createRouter({ mediaCodecs });
  entry.routers = (entry.routers || 0) + 1;
  room = { router, webRtcServer: entry.webRtcServer, entry, peers: new Map() };
  sfuRooms.set(code, room);
  console.log(`[sfu] router room=${code} worker#${entry.index} load=${entry.routers}`);
  return room;
}

/** 방 폐기 시 워커 부하 카운터 반환 */
function releaseRoomWorker(room) {
  if (!room || !room.entry) return;
  room.entry.routers = Math.max(0, (room.entry.routers || 1) - 1);
  room.entry = null;
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

/**
 * 프로듀서 이벤트 브로드캐스트.
 * 얼굴 영상(camera / viewer-camera)은 호스트만 consume 하므로 호스트에게만 보낸다
 * (참가자 수백 명에게 의미 없는 이벤트가 퍼지는 것을 방지).
 */
function emitProducerEvent(io, room, roomCode, event, payload, appData = {}) {
  try {
    if (isHostOnlyFaceSource(appData?.source || '')) {
      emitToHostPeers(io, room, event, payload);
      return;
    }
    io.to(roomCode).emit(event, payload);
  } catch { /* ignore */ }
}

/** 트랜스포트 종류 키: direction + purpose (audio / video). 종류별로 서로 독립. */
function transportKey(direction, purpose) {
  const p = purpose === 'audio' || purpose === 'video' ? purpose : '';
  return `${direction}:${p}`;
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

async function createWebRtcTransport(room) {
  const router = room.router;
  const server = (room.webRtcServer && !room.webRtcServer.closed)
    ? room.webRtcServer
    : await getWebRtcServer();
  const transport = await router.createWebRtcTransport({
    webRtcServer: server,
    enableUdp: true,
    enableTcp: true,
    // 공유기 UDP 40000–49999(44444 포함) 활용. TCP는 보조.
    preferUdp: true,
    // 10인 다자간 및 고해상도 화면 공유(1080p Detail) 지원:
    // 초기 대역폭을 3.5Mbps로 확보하여 ramp-up 동안의 글씨 뭉개짐/화질 붕괴를 원천 차단
    initialAvailableOutgoingBitrate: 3_500_000,
    minimumAvailableOutgoingBitrate: 500_000,
    maxIncomingBitrate: 10_000_000,
    enableSctp: false,
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
      workerCount: WORKER_COUNT,
      workers: workerPool.map((e) => ({ index: e.index, pid: e.worker.pid, routers: e.routers })),
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
    workerCount: WORKER_COUNT,
    workers: workerPool.map((e) => ({ index: e.index, pid: e.worker.pid, routers: e.routers })),
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
  releaseRoomWorker(room);
  sfuRooms.delete(roomCode);
}

/**
 * Socket.io SFU 핸들러 등록
 * @param {import('socket.io').Socket} socket
 * @param {{ getRoomCode: () => string, getClientId: () => string, getRole: () => string, io: import('socket.io').Server }} ctx
 */
const lastProducerPliTimes = new Map(); // producerId -> timestamp
const consumerInitialPliDone = new Set(); // consumerId -> 최초 PLI 완료

/**
 * 키프레임(PLI) 요청 스로틀.
 * [멈춤 원인 수정] 기존에는 producer 단위 전역 쿨다운만 있어서, 늦게 입장한
 * 참가자의 "최초 키프레임 요청"이 직전 참가자의 요청에 막혀 최대 수 초간
 * 검은 화면/정지 상태로 남았다. 이제 각 consumer의 첫 요청은 무조건 통과시키고,
 * 부하(활성 비디오 producer 수)가 클수록 쿨다운을 늘려 PLI 폭풍을 막는다.
 */
async function requestKeyframeThrottled(consumer, { force = false } = {}) {
  if (!consumer || consumer.closed || consumer.kind !== 'video') return;
  const producerId = consumer.producerId;
  const now = Date.now();

  if (force || !consumerInitialPliDone.has(consumer.id)) {
    consumerInitialPliDone.add(consumer.id);
    lastProducerPliTimes.set(producerId, now);
    try { await consumer.requestKeyFrame(); } catch { /* ignore */ }
    return;
  }

  const lastTime = lastProducerPliTimes.get(producerId) || 0;
  const source = consumer.appData?.source || '';
  const isFace = source === 'camera' || source === 'viewer-camera';
  const loadFactor = Math.min(4000, lastProducerPliTimes.size * 250);
  const minGap = (isFace ? 3000 : 2500) + loadFactor;
  if (now - lastTime < minGap) return;
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
      const purpose = direction === 'send' && (msg?.purpose === 'audio' || msg?.purpose === 'video')
        ? msg.purpose
        : '';
      const key = transportKey(direction, purpose);
      // [핵심 버그 수정] 예전에는 direction(send/recv)만 비교해서, 마이크(오디오) 송신 트랜스포트를
      // 만들 때 살아 있는 "영상 송신 트랜스포트"까지 닫아 버렸다 → 마이크만 켜도 영상이 멈췄다.
      // 이제 (direction, purpose) 가 같은 트랜스포트만 교체한다.
      for (const [oldId, oldT] of [...peer.transports.entries()]) {
        if (oldT.appData?.key === key) {
          console.log(`[sfu] cleaning up replaced transport ${String(oldId).slice(0, 8)} for peer ${String(clientId).slice(0, 8)} (${key})`);
          try { oldT.close(); } catch { /* ignore */ }
          peer.transports.delete(oldId);
        }
      }
      const { transport, params } = await createWebRtcTransport(room);
      peer.transports.set(transport.id, transport);
      transport.appData = { direction, purpose, key, clientId };
      const label = `${code}/${peer.role}/${key}/${String(clientId).slice(0, 8)}`;
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
      cb?.({ ok: true, ...params, direction, purpose });
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

      // 방 정책 서버 강제: 카메라 비허용 방에서는 참가자 카메라 producer 를 받지 않는다.
      if (role === 'viewer') {
        const policy = typeof ctx.getRoomPolicy === 'function' ? (ctx.getRoomPolicy() || {}) : {};
        const src = String(msg?.appData?.source || '');
        if (src === 'viewer-camera' && policy.allowClientCamera === false) {
          return cb?.({ error: 'camera-not-allowed' });
        }
        if (src === 'camera' || src === 'display' || src === 'tab-audio') {
          // 참가자는 호스트 전용 source 로 위장할 수 없다.
          return cb?.({ error: 'source-not-allowed' });
        }
      }

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
      // 참가자 입장 직후 "화면이 몇 초간 멈춘 채" 보이는 현상 제거:
      // consumer 생성 즉시 강제 키프레임을 1장 받아 디코더를 바로 깨운다.
      if (consumer.kind === 'video') {
        try { await consumer.requestKeyFrame(); } catch { /* ignore */ }
      }
      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('close', () => consumerInitialPliDone.delete(consumer.id));
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

  socket.on('sfu-close-consumer', async (msg, cb) => {
    try {
      const code = ctx.getRoomCode();
      const clientId = ctx.getClientId();
      const room = sfuRooms.get(code);
      const peer = room?.peers.get(clientId);
      const consumer = peer?.consumers.get(msg?.consumerId);
      if (consumer) {
        consumer.close();
        peer.consumers.delete(consumer.id);
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
  releaseRoomWorker(room);
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
  getWorkerCount: () => WORKER_COUNT,
};
