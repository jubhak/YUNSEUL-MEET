/**
 * YUNSEUL PPT — Node.js + Socket.io 실시간 서버
 * Apache SSE 대신 WebSocket으로 슬라이드/참가자 수 동기화
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

for (const dir of [DATA_DIR, ROOMS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** @type {Map<string, object>} */
const rooms = new Map();

function roomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code) || fs.existsSync(path.join(ROOMS_DIR, `${code}.json`)));
  return code;
}

function defaultRoom(code, hostToken) {
  return {
    code,
    hostToken,
    hostConnected: false,
    hostSocketId: null,
    hostClientId: null,
    presentation: null,
    currentSlide: 0,
    drawings: {},
    popup: null,
    video: null,
    audio: null,
    streamActive: false,
    streamKinds: [],
    viewers: new Map(), // clientId -> { name, socketId, lastSeen }
    ended: false,
    endedAt: 0,
    createdAt: Date.now(),
  };
}

function roomPath(code) {
  return path.join(ROOMS_DIR, `${code}.json`);
}

function persistRoom(room) {
  const data = {
    code: room.code,
    hostToken: room.hostToken,
    hostConnected: room.hostConnected,
    presentation: room.presentation,
    currentSlide: room.currentSlide,
    drawings: room.drawings,
    popup: room.popup,
    video: room.video,
    audio: room.audio,
    // 공유 송출 FLAG — 호스트가 stream-status로만 on/off
    streamActive: !!room.streamActive,
    streamKinds: Array.isArray(room.streamKinds) ? room.streamKinds : [],
    ended: room.ended,
    endedAt: room.endedAt,
    createdAt: room.createdAt,
    viewers: Object.fromEntries(
      [...room.viewers.entries()].map(([id, v]) => [id, { name: v.name, lastSeen: v.lastSeen }])
    ),
  };
  fs.writeFileSync(roomPath(room.code), JSON.stringify(data), 'utf8');
}

function loadRoomFromDisk(code) {
  const p = roomPath(code);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const room = defaultRoom(raw.code, raw.hostToken);
    Object.assign(room, {
      hostConnected: !!raw.hostConnected,
      presentation: raw.presentation || null,
      currentSlide: raw.currentSlide || 0,
      drawings: raw.drawings || {},
      popup: raw.popup || null,
      video: raw.video || null,
      audio: raw.audio || null,
      streamActive: !!raw.streamActive,
      streamKinds: Array.isArray(raw.streamKinds) ? raw.streamKinds : [],
      ended: !!raw.ended,
      endedAt: raw.endedAt || 0,
      createdAt: raw.createdAt || Date.now(),
      viewers: new Map(),
    });
    return room;
  } catch {
    return null;
  }
}

function getRoom(code) {
  const c = roomCode(code);
  if (!c) return null;
  if (rooms.has(c)) return rooms.get(c);
  const fromDisk = loadRoomFromDisk(c);
  if (fromDisk) {
    rooms.set(c, fromDisk);
    return fromDisk;
  }
  return null;
}

function viewerCount(room) {
  return room.viewers.size;
}

function viewersPayload(room) {
  return [...room.viewers.entries()].map(([id, v], index) => ({
    id,
    name: v.name || `참가자 ${index + 1}`,
    lastSeen: v.lastSeen || 0,
  }));
}

function publicState(room) {
  return {
    code: room.code,
    hostConnected: !!room.hostConnected,
    hostClientId: room.hostClientId || null,
    hasPresentation: !!room.presentation,
    presentation: room.presentation,
    currentSlide: room.currentSlide || 0,
    viewerCount: viewerCount(room),
    viewers: viewersPayload(room),
    ended: !!room.ended,
    streamActive: !!room.streamActive,
    streamKinds: Array.isArray(room.streamKinds) ? room.streamKinds : [],
    popup: room.popup || null,
  };
}

function requireHost(room, token) {
  return room && token && room.hostToken === token;
}

function broadcastViewerCount(io, room) {
  const count = viewerCount(room);
  const viewers = viewersPayload(room);
  io.to(room.code).emit('viewer-count', { count, viewers });
}

/** 참가자 새로고침 시 peer-left가 peer-joined보다 늦어 연결을 끊지 않게 */
function cancelViewerLeave(room, clientId) {
  if (!room._viewerLeaveTimers) return;
  const t = room._viewerLeaveTimers.get(clientId);
  if (t) clearTimeout(t);
  room._viewerLeaveTimers.delete(clientId);
}

function scheduleViewerLeave(io, room, clientId) {
  if (!room._viewerLeaveTimers) room._viewerLeaveTimers = new Map();
  cancelViewerLeave(room, clientId);
  room._viewerLeaveTimers.set(
    clientId,
    setTimeout(() => {
      room._viewerLeaveTimers.delete(clientId);
      // 같은 clientId로 다시 들어와 있으면 새로고침 — peer-left 생략
      if (room.viewers.has(clientId)) return;
      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit('peer-left', {
          clientId,
          role: 'viewer',
        });
      }
    }, 2000)
  );
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// 정적 파일 (프론트)
app.use(express.static(ROOT, {
  index: ['index.html'],
  etag: true,
  setHeaders(res, filePath) {
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else if (lower.endsWith('.js') || lower.endsWith('.css')) {
      // 쿼리(?v=)로 캐시버스팅 — 파일 자체는 short cache
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    }
  },
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.pptx';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.pptx')) cb(null, true);
    else cb(new Error('.pptx 파일만 업로드할 수 있습니다.'));
  },
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    engine: 'node-socket.io',
    port: PORT,
    rooms: rooms.size,
  });
});

app.get('/api/check-embed', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  let target;
  try {
    target = new URL(raw);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return res.json({ embeddable: false, reason: 'bad-protocol' });
    }
  } catch {
    return res.json({ embeddable: false, reason: 'bad-url' });
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let r;
    try {
      r = await fetch(target.href, {
        method: 'HEAD',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'YUNSEUL-PPT-EmbedCheck/1.0' },
      });
    } catch {
      r = await fetch(target.href, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'YUNSEUL-PPT-EmbedCheck/1.0',
          Range: 'bytes=0-0',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    let embeddable = true;
    let reason = null;

    if (xfo.includes('deny') || xfo.includes('sameorigin')) {
      embeddable = false;
      reason = 'x-frame-options';
    }
    const fa = csp.match(/frame-ancestors\s+([^;]+)/);
    if (fa) {
      const policy = fa[1].trim();
      if (policy === "'none'" || policy === 'none') {
        embeddable = false;
        reason = 'csp-none';
      } else if (policy === "'self'" || policy === 'self') {
        embeddable = false;
        reason = 'csp-self';
      } else if (!/\*/.test(policy) && !/smrun\.net|localhost|127\.0\.0\.1/.test(policy)) {
        // 명시적 허용 목록에 우리 도메인이 없으면 차단으로 간주
        embeddable = false;
        reason = 'csp-ancestors';
      }
    }

    res.json({ embeddable, reason, status: r.status });
  } catch (e) {
    // 확인 실패 시 iframe 시도는 하되, 프론트에서 타임아웃 폴백
    res.json({ embeddable: true, reason: 'check-failed', soft: true });
  }
});

app.post('/api/create-room', (_req, res) => {
  const code = makeRoomCode();
  const hostToken = crypto.randomBytes(16).toString('hex');
  const room = defaultRoom(code, hostToken);
  rooms.set(code, room);
  persistRoom(room);
  res.json({ code, hostToken });
});

app.get('/api/get-room', (req, res) => {
  const room = getRoom(req.query.code);
  if (!room) return res.status(404).json({ error: '유효하지 않은 방입니다.' });
  if (room.ended) {
    return res.status(410).json({ error: '유효하지 않은 방입니다.', ended: true });
  }
  res.json(publicState(room));
});

app.get('/api/get-file', (req, res) => {
  const f = path.basename(String(req.query.f || ''));
  if (!/^[a-f0-9]{32}\.(pptx|ppt)$/i.test(f)) {
    return res.status(400).json({ error: '잘못된 파일명' });
  }
  const full = path.join(UPLOADS_DIR, f);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '파일 없음' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.sendFile(full);
});

app.post('/api/upload', (req, res) => {
  upload.single('presentation')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '업로드 실패' });
    }
    try {
      const code = roomCode(req.body.code || '');
      const hostToken = req.body.hostToken || '';
      const room = getRoom(code);
      if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
      if (!requireHost(room, hostToken)) {
        return res.status(403).json({ error: '호스트 권한이 없습니다.' });
      }
      if (room.ended) {
        return res.status(410).json({ error: '이미 종료된 발표입니다.' });
      }
      if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

      const slideCount = Math.max(1, parseInt(req.body.slideCount || '1', 10) || 1);
      const presentation = {
        filename: req.file.filename,
        originalName: req.file.originalname || req.file.filename,
        url: `api/get-file?f=${encodeURIComponent(req.file.filename)}`,
        slideCount,
      };

      room.presentation = presentation;
      room.currentSlide = 0;
      room.drawings = {};
      persistRoom(room);

      const payload = {
        presentation,
        currentSlide: 0,
        drawings: {},
      };

      // 소켓으로도 즉시 전파
      io.to(room.code).emit('presentation-ready', payload);

      res.json({ presentation, ok: true });
    } catch (e) {
      console.error('[upload]', e);
      res.status(500).json({ error: e.message || '서버 오류' });
    }
  });
});

// PHP 호환 별칭 (구 URL)
app.post('/api/create-room.php', (req, res) => {
  const code = makeRoomCode();
  const hostToken = crypto.randomBytes(16).toString('hex');
  const room = defaultRoom(code, hostToken);
  rooms.set(code, room);
  persistRoom(room);
  res.json({ code, hostToken });
});
app.get('/api/get-room.php', (req, res) => {
  const room = getRoom(req.query.code);
  if (!room) return res.status(404).json({ error: '유효하지 않은 방입니다.' });
  if (room.ended) {
    return res.status(410).json({ error: '유효하지 않은 방입니다.', ended: true });
  }
  res.json(publicState(room));
});
app.get('/api/get-file.php', (req, res) => {
  const f = path.basename(String(req.query.f || ''));
  if (!/^[a-f0-9]{32}\.(pptx|ppt)$/i.test(f)) {
    return res.status(400).json({ error: '잘못된 파일명' });
  }
  const full = path.join(UPLOADS_DIR, f);
  if (!fs.existsSync(full)) return res.status(404).json({ error: '파일 없음' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.sendFile(full);
});
app.post('/api/upload.php', (req, res) => {
  upload.single('presentation')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '업로드 실패' });
    // reuse body of main upload by redirecting logic — call same by re-posting internally is hard;
    // duplicate minimal:
    try {
      const code = roomCode(req.body.code || '');
      const hostToken = req.body.hostToken || '';
      const room = getRoom(code);
      if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
      if (!requireHost(room, hostToken)) return res.status(403).json({ error: '호스트 권한이 없습니다.' });
      if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
      const presentation = {
        filename: req.file.filename,
        originalName: req.file.originalname || req.file.filename,
        url: `api/get-file?f=${encodeURIComponent(req.file.filename)}`,
        slideCount: Math.max(1, parseInt(req.body.slideCount || '1', 10) || 1),
      };
      room.presentation = presentation;
      room.currentSlide = 0;
      room.drawings = {};
      persistRoom(room);
      const payload = { presentation, currentSlide: 0, drawings: {} };
      io.to(room.code).emit('presentation-ready', payload);
      res.json({ presentation, ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message || '서버 오류' });
    }
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
  pingInterval: 10000,
  pingTimeout: 20000,
});

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.data.clientId = null;

  socket.on('join', (msg, ack) => {
    try {
      const code = roomCode(msg?.code);
      const role = msg?.role === 'host' ? 'host' : 'viewer';
      const hostToken = msg?.hostToken || null;
      const name = String(msg?.name || '참가자').trim() || '참가자';
      const clientId = String(msg?.clientId || crypto.randomBytes(8).toString('hex'));

      const room = getRoom(code);
      if (!room) {
        const err = { error: '유효하지 않은 방입니다.' };
        if (typeof ack === 'function') ack(err);
        return;
      }

      if (room.ended && role !== 'host') {
        const err = { error: '유효하지 않은 방입니다.', ended: true };
        if (typeof ack === 'function') ack(err);
        return;
      }

      if (role === 'host') {
        if (!requireHost(room, hostToken)) {
          const err = { error: '호스트 토큰이 올바르지 않습니다.' };
          if (typeof ack === 'function') ack(err);
          return;
        }
        room.hostConnected = true;
        room.hostSocketId = socket.id;
        room.hostClientId = clientId;
      } else {
        cancelViewerLeave(room, clientId);
        room.viewers.set(clientId, {
          name,
          socketId: socket.id,
          lastSeen: Date.now(),
        });
      }

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.role = role;
      socket.data.clientId = clientId;
      socket.data.hostToken = hostToken;

      persistRoom(room);
      broadcastViewerCount(io, room);

      const payload = {
        clientId,
        role,
        state: publicState(room),
        drawings: room.drawings || {},
        popup: room.popup,
        video: room.video,
        audio: room.audio,
      };
      if (typeof ack === 'function') ack(payload);

      // 참가자 입장 → 호스트가 offer. 송출 중이면 상태도 즉시 전달
      if (role === 'viewer' && room.hostSocketId) {
        io.to(room.hostSocketId).emit('peer-joined', {
          clientId,
          role: 'viewer',
          name,
        });
        if (room.streamActive) {
          socket.emit('stream-status', {
            active: true,
            kinds: Array.isArray(room.streamKinds) ? room.streamKinds : [],
          });
        }
      }
    } catch (e) {
      console.error('[join]', e);
      if (typeof ack === 'function') ack({ error: e.message || '참가 실패' });
    }
  });

  /** WebRTC 시그널 중계 (offer/answer/ice/bye) — 다자 회의 공용 */
  socket.on('webrtc-signal', (msg) => {
    try {
      const code = socket.data.roomCode;
      const room = code ? getRoom(code) : null;
      if (!room || !socket.data.clientId) return;

      const type = String(msg?.type || '');
      const toClientId = String(msg?.toClientId || '');
      if (!type || !toClientId) return;

      let targetSocketId = null;
      const viewer = room.viewers.get(toClientId);
      if (viewer?.socketId) {
        targetSocketId = viewer.socketId;
      } else if (
        toClientId === room.hostClientId ||
        (socket.data.role === 'viewer' && room.hostSocketId)
      ) {
        targetSocketId = room.hostSocketId;
      }

      if (!targetSocketId) return;

      io.to(targetSocketId).emit('webrtc-signal', {
        type,
        fromClientId: socket.data.clientId,
        fromRole: socket.data.role,
        toClientId,
        payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
      });
    } catch (e) {
      console.error('[webrtc-signal]', e);
    }
  });

  socket.on('stream-status', (msg) => {
    try {
      const code = socket.data.roomCode;
      const room = code ? getRoom(code) : null;
      if (!room || socket.data.role !== 'host') return;
      if (!requireHost(room, socket.data.hostToken)) return;

      const nextActive = !!msg?.active;
      const nextKinds = Array.isArray(msg?.kinds) ? msg.kinds : [];
      const changed =
        room.streamActive !== nextActive ||
        JSON.stringify(room.streamKinds || []) !== JSON.stringify(nextKinds);

      room.streamActive = nextActive;
      room.streamKinds = nextKinds;
      room.hostClientId = socket.data.clientId;
      persistRoom(room);

      // FLAG 값이 바뀔 때만 방송 (5초 heartbeat로「연결 중」이 반복되지 않게)
      if (changed) {
        io.to(code).emit('stream-status', {
          active: room.streamActive,
          kinds: room.streamKinds,
        });
      }
    } catch (e) {
      console.error('[stream-status]', e);
    }
  });

  // 참가자가 offer를 놓쳤을 때 호스트에 peer-joined 재요청
  socket.on('request-stream', () => {
    try {
      const code = socket.data.roomCode;
      const room = code ? getRoom(code) : null;
      if (!room || socket.data.role !== 'viewer' || !socket.data.clientId) return;
      if (!room.streamActive || !room.hostSocketId) return;
      if (!room.viewers.has(socket.data.clientId)) return;
      io.to(room.hostSocketId).emit('peer-joined', {
        clientId: socket.data.clientId,
        role: 'viewer',
        name: room.viewers.get(socket.data.clientId)?.name || '참가자',
      });
    } catch (e) {
      console.error('[request-stream]', e);
    }
  });

  socket.on('host-event', (msg) => {
    try {
      const code = socket.data.roomCode;
      const room = code ? getRoom(code) : null;
      if (!room || socket.data.role !== 'host') return;
      if (!requireHost(room, socket.data.hostToken)) return;

      const type = String(msg?.type || '');
      const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {};

      switch (type) {
        case 'slide-change':
          room.currentSlide = Math.max(0, parseInt(payload.slideIndex, 10) || 0);
          break;
        case 'draw-end': {
          const key = String(payload.slideIndex ?? 0);
          if (!Array.isArray(room.drawings[key])) room.drawings[key] = [];
          if (payload.stroke) room.drawings[key].push(payload.stroke);
          break;
        }
        case 'clear-drawings':
          room.drawings[String(payload.slideIndex ?? 0)] = [];
          break;
        case 'clear-all-drawings':
          room.drawings = {};
          break;
        case 'open-link':
          room.popup = payload;
          break;
        case 'close-link':
          room.popup = null;
          break;
        case 'play-video':
          room.video = payload;
          break;
        case 'close-video':
          room.video = null;
          break;
        case 'play-audio':
          room.audio = payload;
          break;
        case 'close-audio':
          room.audio = null;
          break;
        case 'audio-control':
          if (room.audio && payload) {
            room.audio = { ...room.audio, ...payload, playing: payload.action !== 'pause' };
          }
          break;
        case 'session-end':
          room.ended = true;
          room.endedAt = Date.now();
          room.popup = null;
          room.video = null;
          room.audio = null;
          room.streamActive = false;
          room.streamKinds = [];
          payload.message = payload.message || '호스트가 발표를 종료했습니다.';
          break;
        default:
          // draw-start / draw-move 등은 상태 저장 없이 중계만
          break;
      }

      persistRoom(room);
      // 슬라이드/낙서 등은 다른 클라이언트에게만, 종료는 전원
      if (type === 'session-end') {
        io.to(code).emit(type, payload);
      } else {
        socket.to(code).emit(type, payload);
      }
    } catch (e) {
      console.error('[host-event]', e);
    }
  });

  socket.on('heartbeat', () => {
    const code = socket.data.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return;
    if (socket.data.role === 'host') {
      room.hostConnected = true;
      room.hostSocketId = socket.id;
    } else if (socket.data.clientId && room.viewers.has(socket.data.clientId)) {
      const v = room.viewers.get(socket.data.clientId);
      v.lastSeen = Date.now();
      v.socketId = socket.id;
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = code ? getRoom(code) : null;
    if (!room) return;

    if (socket.data.role === 'host') {
      if (room.hostSocketId === socket.id) {
        room.hostConnected = false;
        room.hostSocketId = null;
        // 호스트 새로고침/이탈 = 송출 종료 → FLAG false + 참가자「송출 대기」
        room.streamActive = false;
        room.streamKinds = [];
        persistRoom(room);
        io.to(code).emit('stream-status', { active: false, kinds: [] });
      }
    } else if (socket.data.clientId) {
      const clientId = socket.data.clientId;
      const v = room.viewers.get(clientId);
      if (v && v.socketId === socket.id) {
        room.viewers.delete(clientId);
        // peer-left는 지연 — 새로고침 재입장 시 생략
        scheduleViewerLeave(io, room, clientId);
      }
    }
    persistRoom(room);
    broadcastViewerCount(io, room);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  YUNSEUL PPT  (Node + Socket.io)');
  console.log(`  내부: http://${HOST}:${PORT}/`);
  console.log('  공개: https://ppt.smrun.net/  (Apache 프록시)');
  console.log('══════════════════════════════════════');
  console.log('');
});
