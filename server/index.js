/**
 * YUNSEUL MEET — Node.js + Socket.io 실시간 서버
 * Apache SSE 대신 WebSocket으로 슬라이드/참가자 수 동기화
 */
const path = require('path');
const fs = require('fs');

// .env 로드 (MEDIASOUP_ANNOUNCED_IP 등) — sfu require 전에 실행
(() => {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const { createRemoteControl } = require('./remote-control');
const { createFaceRelay } = require('./face-relay');
const { attachSfuHandlers, cleanupSocketPeer, disposeSfuRoom, detectAnnouncedIp, getListenIps, getRtcPort, getSfuSnapshot, getWorker, getWorkerCount } = require('./sfu');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const LOGS_DIR = path.join(ROOT, 'logs');
const PHOTO_DIR = path.join(ROOT, 'photo');
const DEEP_LIVE_CAM_DIR = path.join(ROOT, 'deep-live-cam');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

for (const dir of [DATA_DIR, ROOMS_DIR, UPLOADS_DIR, LOGS_DIR, PHOTO_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** @type {Map<string, object>} */
const rooms = new Map();

function roomCode(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

/** 진행 중(미종료) 방 코드인지 */
function isCodeTaken(code) {
  const c = roomCode(code);
  if (!c || c.length !== 4) return false;
  const room = getRoom(c);
  if (!room || room.ended) return false;
  // 호스트도 없고 참가자도 없으며 연결 유예 타이머도 없는 빈 방은 재사용 가능
  const hasViewers = room.viewers && room.viewers.size > 0;
  const hasGrace = room._peerGraceTimers && room._peerGraceTimers.size > 0;
  if (!room.hostConnected && !hasViewers && !hasGrace) {
    return false;
  }
  return true;
}

function makeRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 1000~9999
    attempts++;
    if (attempts > 500) throw new Error('사용 가능한 방 코드가 없습니다.');
  } while (isCodeTaken(code));
  return code;
}

function normalizeInteractionMode(mode) {
  return mode === 'unidirectional' ? 'unidirectional' : 'bidirectional';
}

function defaultRoom(code, hostToken, interactionMode = 'bidirectional', requireMic = false, allowClientCamera = true, allowClientDeepfake = true) {
  const normMode = normalizeInteractionMode(interactionMode);
  const allowCam = normMode === 'bidirectional' && allowClientCamera !== false;
  const allowDfc = allowCam && allowClientDeepfake !== false;
  return {
    code,
    hostToken,
    hostConnected: false,
    hostSocketId: null,
    hostClientId: null,
    hostName: '호스트',
    hostMicState: 'off', // on | off | none (실제 상태만 반영)
    hostMicReady: false, // 필수 방: 호스트 마이크가 실제 작동 확인되었는지
    activeBroadcasterId: null,
    // bidirectional: 기존 화상 미팅 / unidirectional: 대규모 시청(참가자 produce 없음)
    interactionMode: normMode,
    requireMic: normMode === 'bidirectional' && !!requireMic,
    allowClientCamera: allowCam,
    allowClientDeepfake: allowDfc,
    presentation: null,
    currentSlide: 0,
    drawings: {},
    popup: null,
    video: null,
    audio: null,
    streamActive: false,
    streamKinds: [],
    viewers: new Map(), // clientId -> { name, socketId, lastSeen }
    chatMessages: [], // 최근 채팅 (메모리만)
    ended: false,
    endedAt: 0,
    meetingStarted: false,
    displayMode: 'face',
    createdAt: Date.now(),
    hostLastSeen: 0,
    lastActivity: Date.now(),
    logDir: null, // logs/날짜/순번_시간_방코드
  };
}

/** Asia/Seoul 기준 날짜·시각 조각 */
function kstParts(ts = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(ts))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const timeCompact = `${parts.hour}${parts.minute}${parts.second}`;
  const timeDisplay = `${parts.hour}:${parts.minute}:${parts.second}`;
  return { date, timeCompact, timeDisplay, datetime: `${date} ${timeDisplay}` };
}

function nextLogSeqForDate(dateDir) {
  if (!fs.existsSync(dateDir)) return 1;
  let max = 0;
  for (const name of fs.readdirSync(dateDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const m = /^(\d+)_/.exec(name.name);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 방 전용 로그 폴더 생성: logs/YYYY-MM-DD/{순번}_{HHMMSS}_{방코드}/ */
function ensureRoomLogDir(room) {
  if (!room) return null;
  if (room.logDir) {
    const abs = path.isAbsolute(room.logDir)
      ? room.logDir
      : path.join(ROOT, room.logDir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    room.logDir = path.relative(ROOT, abs).split(path.sep).join('/');
    return abs;
  }

  const created = room.createdAt || Date.now();
  const { date, timeCompact } = kstParts(created);
  const dateDir = path.join(LOGS_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const seq = nextLogSeqForDate(dateDir);
  const folderName = `${String(seq).padStart(3, '0')}_${timeCompact}_${room.code}`;
  const abs = path.join(dateDir, folderName);
  fs.mkdirSync(abs, { recursive: true });
  room.logDir = path.relative(ROOT, abs).split(path.sep).join('/');
  return abs;
}

function appendRoomLog(room, fileName, line) {
  try {
    const dir = ensureRoomLogDir(room);
    if (!dir) return;
    const file = path.join(dir, fileName);
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (err) {
    console.warn('[room-log]', err?.message || err);
  }
}

function logRoomJoin(room, { role, name, clientId }) {
  const { datetime } = kstParts();
  const safeName = String(name || '').replace(/[\r\n\t]+/g, ' ').trim() || '-';
  const line = [datetime, role || 'viewer', safeName, clientId || '-'].join('\t');
  appendRoomLog(room, 'join_member.log', line);
}

function logRoomChat(room, { role, name, text, clientId }) {
  const { datetime } = kstParts();
  const safeName = String(name || '').replace(/[\r\n\t]+/g, ' ').trim() || '-';
  const safeText = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  const line = [datetime, role || 'viewer', safeName, clientId || '-', safeText].join('\t');
  appendRoomLog(room, 'chats.log', line);
}

function roomPath(code) {
  return path.join(ROOMS_DIR, `${code}.json`);
}

function persistRoom(room) {
  const normMode = normalizeInteractionMode(room.interactionMode);
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
    hostName: room.hostName || '호스트',
    activeBroadcasterId: room.activeBroadcasterId || null,
    interactionMode: normMode,
    requireMic: normMode === 'bidirectional' && !!room.requireMic,
    allowClientCamera: room.allowClientCamera !== false,
    allowClientDeepfake: room.allowClientCamera !== false && room.allowClientDeepfake !== false,
    ended: room.ended,
    endedAt: room.endedAt,
    meetingStarted: !!room.meetingStarted,
    createdAt: room.createdAt,
    logDir: room.logDir || null,
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
    const normMode = normalizeInteractionMode(raw.interactionMode);
    const room = defaultRoom(
      raw.code,
      raw.hostToken,
      normMode,
      !!raw.requireMic,
      raw.allowClientCamera !== false,
      raw.allowClientDeepfake !== false
    );
    Object.assign(room, {
      // 디스크의 hostConnected는 신뢰하지 않음 — 실제 소켓이 있을 때만 true
      hostConnected: false,
      presentation: raw.presentation || null,
      currentSlide: raw.currentSlide || 0,
      drawings: raw.drawings || {},
      popup: raw.popup || null,
      video: raw.video || null,
      audio: raw.audio || null,
      streamActive: false,
      streamKinds: Array.isArray(raw.streamKinds) ? raw.streamKinds : [],
      hostName: raw.hostName || '호스트',
      activeBroadcasterId: raw.activeBroadcasterId || null,
      interactionMode: normMode,
      requireMic: normMode === 'bidirectional' && !!raw.requireMic,
      allowClientCamera: raw.allowClientCamera !== false,
      allowClientDeepfake: raw.allowClientCamera !== false && raw.allowClientDeepfake !== false,
      ended: !!raw.ended,
      endedAt: raw.endedAt || 0,
      // 미팅 시작 여부는 재접속·서버 재기동 후에도 유지 (송출 중인데 카드 대기실로 떨어지는 사고 방지)
      meetingStarted: !!raw.meetingStarted,
      createdAt: raw.createdAt || Date.now(),
      logDir: raw.logDir || null,
      viewers: new Map(),
      chatMessages: [],
    });
    room.hostSocketId = null;
    room.hostLastSeen = 0;
    room.lastActivity = Date.now();
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
    // 디스크에서 올린 방은 실제 접속자가 없음 → 빈 방 정리 예약
    maybeScheduleEmptyRoomDispose(fromDisk);
    return fromDisk;
  }
  return null;
}

function viewerCount(room) {
  return (room.hostConnected && room.hostClientId ? 1 : 0) + room.viewers.size;
}

function viewersPayload(room) {
  const list = [];
  if (room.hostConnected && room.hostClientId) {
    list.push({
      id: room.hostClientId,
      name: room.hostName || '호스트',
      role: 'host',
      lastSeen: Date.now(),
      micState: room.hostMicState === 'on' || room.hostMicState === 'none'
        ? room.hostMicState
        : 'off',
      micReady: room.requireMic ? !!room.hostMicReady : true,
      admitted: true,
    });
  }
  for (const [id, v] of room.viewers.entries()) {
    const micState = v.micState === 'on' || v.micState === 'none' ? v.micState : 'off';
    // 마이크 필수 방: 검증된(작동 확인된) 마이크가 없는 참가자는 "입장 대기" 상태로 표시
    const micReady = room.requireMic ? !!v.micReady : true;
    list.push({
      id,
      name: v.name || '참가자',
      role: 'viewer',
      lastSeen: v.lastSeen || 0,
      micState,
      micReady,
      admitted: micReady,
    });
  }
  return list;
}

function publicState(room) {
  const broadcasterId = room.activeBroadcasterId || room.hostClientId || null;
  const normMode = normalizeInteractionMode(room.interactionMode);
  return {
    code: room.code,
    hostConnected: !!room.hostConnected,
    hostClientId: room.hostClientId || null,
    hostName: room.hostName || '호스트',
    activeBroadcasterId: broadcasterId,
    hasPresentation: !!room.presentation,
    presentation: room.presentation,
    currentSlide: room.currentSlide || 0,
    viewerCount: viewerCount(room),
    viewers: viewersPayload(room),
    ended: !!room.ended,
    meetingStarted: !!room.meetingStarted,
    streamActive: !!room.streamActive,
    streamKinds: Array.isArray(room.streamKinds) ? room.streamKinds : [],
    popup: room.popup || null,
    interactionMode: normMode,
    requireMic: normMode === 'bidirectional' && !!room.requireMic,
    allowClientCamera: room.allowClientCamera !== false,
    allowClientDeepfake: room.allowClientCamera !== false && room.allowClientDeepfake !== false,
    // 호스트가 지금 시청자에게 보여주는 것: 'face'(참가자 얼굴 화면) | 'screen'(호스트 PC 화면)
    displayMode: room.displayMode === 'screen' ? 'screen' : 'face',
  };
}

function broadcastBroadcaster(io, room) {
  const clientId = room.activeBroadcasterId || room.hostClientId || null;
  const isHost = !clientId || clientId === room.hostClientId;
  const name = isHost
    ? (room.hostName || '호스트')
    : (room.viewers.get(clientId)?.name || '참가자');
  io.to(room.code).emit('broadcaster-changed', {
    clientId,
    role: isHost ? 'host' : 'viewer',
    name,
  });
  try { remoteControl.checkRoom(room); } catch { /* ignore */ }
}

function requireHost(room, token) {
  return room && token && room.hostToken === token;
}

function broadcastViewerCount(io, room) {
  const count = viewerCount(room);
  const viewers = viewersPayload(room);
  io.to(room.code).emit('viewer-count', {
    count,
    viewers,
    activeBroadcasterId: room.activeBroadcasterId || room.hostClientId || null,
    meetingStarted: !!room.meetingStarted,
  });
}

/** 1차 안전 장치: 일시 단선 시 30초 유예 (SFU 리소스 및 송출 플래그 보존) */
const PEER_DISCONNECT_GRACE_MS = Number(process.env.PEER_DISCONNECT_GRACE_MS || 30_000);

function cancelPeerDisconnectGrace(room, clientId) {
  if (!room || !room._peerGraceTimers || !clientId) return;
  const t = room._peerGraceTimers.get(clientId);
  if (t) {
    clearTimeout(t);
    room._peerGraceTimers.delete(clientId);
  }
}

function schedulePeerDisconnectGrace(io, room, clientId, role) {
  if (!room || !clientId) return;
  if (!room._peerGraceTimers) room._peerGraceTimers = new Map();
  cancelPeerDisconnectGrace(room, clientId);

  room._peerGraceTimers.set(
    clientId,
    setTimeout(() => {
      room._peerGraceTimers?.delete(clientId);

      // 유예 중 재접속했으면 SFU(송출)를 절대 건드리지 않음
      // (취소 누락·레이스 시에도 방송 중 get-producers=0 사고 방지)
      if (role === 'host') {
        if (room.hostConnected && room.hostClientId === clientId) {
          console.log(`[grace-expired] skipped — host still connected ${clientId.slice(0, 8)}`);
          return;
        }
      } else {
        const v = room.viewers.get(clientId);
        if (v?.connected) {
          console.log(`[grace-expired] skipped — viewer still connected ${clientId.slice(0, 8)}`);
          return;
        }
      }

      console.log(`[grace-expired] room=${room.code} role=${role} client=${clientId.slice(0, 8)}`);

      // 30초 유예가 완전히 경과했고 미재접속일 때만 SFU 리소스 해제
      cleanupSocketPeer(room.code, clientId, io);

      if (role === 'host') {
        if (room.hostClientId === clientId && !room.hostConnected) {
          room.streamActive = false;
          room.streamKinds = [];
          persistRoom(room);
          io.to(room.code).emit('stream-status', { active: false, kinds: [] });
          maybeScheduleEmptyRoomDispose(room);
        }
      } else {
        const v = room.viewers.get(clientId);
        if (v && !v.connected) {
          room.viewers.delete(clientId);
          if (room.activeBroadcasterId === clientId) {
            room.activeBroadcasterId = room.hostClientId;
            if (room.hostSocketId) {
              io.to(room.hostSocketId).emit('screen-share-ended', { clientId });
            }
            broadcastBroadcaster(io, room);
          }
          if (room.hostSocketId) {
            io.to(room.hostSocketId).emit('peer-left', { clientId, role: 'viewer' });
          }
          maybeScheduleEmptyRoomDispose(room);
          persistRoom(room);
          broadcastViewerCount(io, room);
        }
      }
    }, PEER_DISCONNECT_GRACE_MS)
  );
}

/** 참가자 새로고침 시 peer-left가 peer-joined보다 늦어 연결을 끊지 않게 */
function cancelViewerLeave(room, clientId) {
  cancelPeerDisconnectGrace(room, clientId);
  if (!room._viewerLeaveTimers) return;
  const t = room._viewerLeaveTimers.get(clientId);
  if (t) clearTimeout(t);
  room._viewerLeaveTimers.delete(clientId);
}

function scheduleViewerLeave(io, room, clientId) {
  schedulePeerDisconnectGrace(io, room, clientId, 'viewer');
}

/** 호스트·참가자 모두 0명인 빈 방 — 새로고침 유예 후 폐기 (모든 방 3분(180초) 동안 접속 없으면 자동 삭제) */
const EMPTY_ROOM_GRACE_MS = Number(process.env.EMPTY_ROOM_GRACE_MS || 180_000);
/** 하트비트 없는 호스트는 이탈로 간주 (10분) */
const STALE_HOST_MS = Number(process.env.STALE_HOST_MS || 600_000);
/** 하트비트 없는 참가자 제거 (10분) */
const STALE_VIEWER_MS = Number(process.env.STALE_VIEWER_MS || 600_000);
/** 메모리에 없는 디스크 방 파일 삭제 기준 (2시간) */
const ORPHAN_DISK_ROOM_MS = Number(process.env.ORPHAN_DISK_ROOM_MS || 7200_000);
/** 빈 방·유령 참가자 스윕 주기 */
const ROOM_SWEEP_MS = Number(process.env.ROOM_SWEEP_MS || 60_000);

function cancelEmptyRoomDispose(room) {
  if (room?._emptyDisposeTimer) {
    clearTimeout(room._emptyDisposeTimer);
    room._emptyDisposeTimer = null;
  }
}

function isRoomEmpty(room) {
  if (!room) return true;
  return !room.hostConnected && room.viewers.size === 0;
}

function maybeScheduleEmptyRoomDispose(room) {
  if (!room || room.ended) return;
  if (!isRoomEmpty(room)) {
    cancelEmptyRoomDispose(room);
    return;
  }
  cancelEmptyRoomDispose(room);
  room._emptyDisposeTimer = setTimeout(() => {
    room._emptyDisposeTimer = null;
    if (room.ended) return;
    if (!isRoomEmpty(room)) return;
    disposeEmptyRoom(room);
  }, EMPTY_ROOM_GRACE_MS);
}

function disposeEmptyRoom(room) {
  if (!room) return;
  const code = room.code;
  cancelEmptyRoomDispose(room);
  if (room._viewerLeaveTimers) {
    for (const t of room._viewerLeaveTimers.values()) clearTimeout(t);
    room._viewerLeaveTimers.clear();
  }
  room.ended = true;
  room.endedAt = Date.now();
  room.streamActive = false;
  room.streamKinds = [];
  room.hostConnected = false;
  room.hostSocketId = null;
  room.viewers.clear();
  try { disposeSfuRoom(code); } catch (err) {
    console.warn('[disposeEmptyRoom] sfu', err);
  }
  try {
    const p = roomPath(code);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    console.warn('[disposeEmptyRoom] file', err);
  }
  rooms.delete(code);
  console.log(`[room] disposed empty room ${code}`);
}

/** 주기적으로 유령 방·오래된 디스크 파일 정리 */
function sweepRooms() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.ended) {
      disposeEmptyRoom(room);
      continue;
    }

    if (room.hostConnected) {
      const last = room.hostLastSeen || room.lastActivity || 0;
      // lastSeen 없으면(유령 플래그) 즉시 이탈로 간주
      if (!last || now - last > STALE_HOST_MS) {
        room.hostConnected = false;
        room.hostSocketId = null;
        room.streamActive = false;
        room.streamKinds = [];
        console.log(`[room] stale host cleared ${room.code}`);
      }
    }

    for (const [id, v] of [...room.viewers.entries()]) {
      const last = v.lastSeen || 0;
      if (!last || now - last > STALE_VIEWER_MS) {
        room.viewers.delete(id);
      }
    }

    if (isRoomEmpty(room)) {
      maybeScheduleEmptyRoomDispose(room);
    } else {
      cancelEmptyRoomDispose(room);
      try { persistRoom(room); } catch { /* ignore */ }
    }
  }

  // 메모리에 없는 고아 방 JSON 삭제 (코드 점유·디스크 누수 방지)
  try {
    if (!fs.existsSync(ROOMS_DIR)) return;
    for (const name of fs.readdirSync(ROOMS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const code = name.slice(0, -'.json'.length);
      if (!code || rooms.has(code)) continue;
      const p = path.join(ROOMS_DIR, name);
      let age = ORPHAN_DISK_ROOM_MS + 1;
      try { age = now - fs.statSync(p).mtimeMs; } catch { /* ignore */ }
      if (age < ORPHAN_DISK_ROOM_MS) continue;
      try {
        fs.unlinkSync(p);
        console.log(`[room] purged orphan disk room ${code}`);
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[room] disk sweep', err);
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// 정적 파일 (프론트)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

app.use('/photo', express.static(PHOTO_DIR, {
  etag: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

app.use(express.static(ROOT, {
  index: ['index.html'],
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    engine: 'node-socket.io+sfu',
    media: 'sfu',
    rtcPort: getRtcPort(),
    rtcPrefer: 'udp',
    iceIps: getListenIps().map((x) => x.announcedAddress || x.announcedIp).filter(Boolean),
    port: PORT,
    rooms: rooms.size,
  });
});

app.get('/api/deep-live-cam/status', (_req, res) => {
  const hasRepo = fs.existsSync(path.join(DEEP_LIVE_CAM_DIR, 'run.py'));
  const hasBat = fs.existsSync(path.join(ROOT, 'run_deep_live_cam.bat'));
  let photos = [];
  if (fs.existsSync(PHOTO_DIR)) {
    try {
      photos = fs.readdirSync(PHOTO_DIR)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .map((f) => ({
          filename: f,
          url: `/photo/${encodeURIComponent(f)}`,
          name: path.parse(f).name,
        }));
    } catch { /* ignore */ }
  }
  res.json({
    ok: true,
    hasRepo,
    hasBat,
    photos,
  });
});

app.get('/api/photos', (_req, res) => {
  try {
    const photos = [];
    if (fs.existsSync(PHOTO_DIR)) {
      const files = fs.readdirSync(PHOTO_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
      for (const f of files) {
        const s = path.parse(f).name.toLowerCase();
        const name = path.parse(f).name.replace(/_/g, ' ');
        photos.push({
          id: s,
          filename: f,
          name,
          url: `/photo/${encodeURIComponent(f)}`,
        });
      }
    }
    res.json({ ok: true, photos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 사진 업로드(/api/upload-face)는 제거됨 — 서버에 준비된 프리셋 얼굴(photo/)만 사용

app.post('/api/swap-frame', (req, res) => {
  const sourceFace = req.headers['x-source-face'] || '';
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(process.env.FACE_SWAP_PORT || 8765),
    path: '/api/swap-frame',
    method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'] || 'image/jpeg',
      'X-Source-Face': encodeURIComponent(sourceFace),
    },
    timeout: 5000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.setNoDelay?.(true);
  proxyReq.on('error', (err) => {
    console.warn('[FaceSwap Proxy] worker error:', err?.message || err);
    res.status(502).json({ ok: false, error: 'Face swap worker unavailable' });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ ok: false, error: 'Face swap worker timeout' });
  });

  req.pipe(proxyReq);
});

/** 페이스스왑 워커 상태/부하/지연 실측 조회 (진단용) */
app.get('/api/faceswap-status', (_req, res) => {
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: Number(process.env.FACE_SWAP_PORT || 8765),
    path: '/stats',
    method: 'GET',
    timeout: 4000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ ok: false, error: 'Face swap worker unavailable', detail: err?.message });
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ ok: false, error: 'timeout' }); });
  proxyReq.end();
});

app.post('/api/launch-deep-live-cam', (_req, res) => {
  const batPath = path.join(ROOT, 'run_deep_live_cam.bat');
  if (!fs.existsSync(batPath)) {
    return res.status(404).json({ ok: false, error: 'run_deep_live_cam.bat 파일을 찾을 수 없습니다.' });
  }
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '""', 'run_deep_live_cam.bat'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    child.unref();
    res.json({
      ok: true,
      message: 'Deep-Live-Cam이 새로운 창에서 실행되었습니다.',
    });
  } catch (err) {
    console.error('[deep-live-cam] launch error:', err);
    res.status(500).json({ ok: false, error: err.message || '실행 실패' });
  }
});

/** SFU/방 접속 진단 — ICE·producer 상태 확인용 */
app.get('/api/debug/sfu', async (req, res) => {
  const code = roomCode(req.query.code);
  if (!code) return res.status(400).json({ error: 'code required' });
  const room = getRoom(code);
  let sfu;
  try {
    sfu = await getSfuSnapshot(code);
  } catch (err) {
    sfu = { ok: false, error: err.message || String(err) };
  }
  res.json({
    ok: true,
    room: room
      ? {
          code: room.code,
          hostConnected: !!room.hostConnected,
          streamActive: !!room.streamActive,
          streamKinds: room.streamKinds || [],
          viewerCount: viewerCount(room),
          viewers: [...room.viewers.entries()].map(([id, v]) => ({
            id,
            name: v.name,
            lastSeenAgoMs: Date.now() - (v.lastSeen || 0),
          })),
        }
      : null,
    sfu,
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

app.post('/api/create-room', (req, res) => {
  const rawCode = String(req.body?.code ?? '').trim();
  let code = '';
  if (rawCode) {
    code = roomCode(rawCode);
    if (!/^[0-9]{4}$/.test(rawCode)) {
      return res.status(400).json({ error: '참여 코드는 4자리 숫자여야 합니다.' });
    }
    if (isCodeTaken(code)) {
      return res.status(409).json({ error: '이미 사용 중인 참여 코드입니다. 다른 번호를 입력해 주세요.' });
    }
    // 종료된 방이 있으면 교체 가능
    const existing = getRoom(code);
    if (existing) rooms.delete(code);
  } else {
    try {
      code = makeRoomCode();
    } catch (err) {
      return res.status(500).json({ error: err.message || '방 코드 생성 실패' });
    }
  }

  const hostToken = crypto.randomBytes(16).toString('hex');
  const interactionMode = normalizeInteractionMode(req.body?.interactionMode);
  const requireMic = interactionMode === 'bidirectional' && !!req.body?.requireMic;
  const allowClientCamera = req.body?.allowClientCamera !== false;
  const allowClientDeepfake = allowClientCamera && req.body?.allowClientDeepfake !== false;
  const room = defaultRoom(code, hostToken, interactionMode, requireMic, allowClientCamera, allowClientDeepfake);
  try {
    ensureRoomLogDir(room);
  } catch (err) {
    console.warn('[create-room] log dir', err);
  }
  rooms.set(code, room);
  persistRoom(room);
  // 호스트가 들어오지 않으면 유예 후 폐기
  maybeScheduleEmptyRoomDispose(room);
  res.json({
    ok: true,
    code,
    hostToken,
    interactionMode: room.interactionMode,
    requireMic: !!room.requireMic,
    allowClientCamera: !!room.allowClientCamera,
    allowClientDeepfake: !!room.allowClientDeepfake,
  });
});

app.get('/api/get-room', (req, res) => {
  const room = getRoom(req.query.code);
  if (!room) return res.status(404).json({ error: '유효하지 않은 방입니다.' });
  if (room.ended) {
    return res.status(410).json({ error: '유효하지 않은 방입니다.', ended: true });
  }
  res.json(publicState(room));
});

/** 사용 가능한 랜덤 참여 코드 */
app.get('/api/suggest-room-code', (_req, res) => {
  try {
    res.json({ code: makeRoomCode() });
  } catch (err) {
    res.status(500).json({ error: err.message || '방 코드 생성 실패' });
  }
});

/** 참여 코드 사용 가능 여부 */
app.get('/api/check-room-code', (req, res) => {
  const code = roomCode(req.query.code || '');
  if (code.length !== 4) {
    return res.json({ available: false, code, error: '참여 코드는 4자리 숫자여야 합니다.' });
  }
  const taken = isCodeTaken(code);
  res.json({
    available: !taken,
    code,
    error: taken ? '이미 사용 중인 참여 코드입니다. 다른 번호를 입력해 주세요.' : null,
  });
});

/** 호스트 화면 즉시 진입용 URL 제공 (진행 중인 방 재사용 또는 신규 방 자동 생성) */
app.get('/api/host-url', (_req, res) => {
  let targetRoom = null;
  for (const r of rooms.values()) {
    if (!r.ended) {
      targetRoom = r;
      break;
    }
  }
  if (!targetRoom) {
    const code = makeRoomCode();
    const hostToken = crypto.randomBytes(16).toString('hex');
    targetRoom = defaultRoom(code, hostToken, 'bidirectional', false);
    try { ensureRoomLogDir(targetRoom); } catch { /* ignore */ }
    rooms.set(code, targetRoom);
    persistRoom(targetRoom);
    maybeScheduleEmptyRoomDispose(targetRoom);
  }
  const q = new URLSearchParams({
    code: targetRoom.code,
    ht: targetRoom.hostToken,
    hn: targetRoom.hostName || '호스트',
    mode: targetRoom.interactionMode || 'bidirectional',
    rm: targetRoom.requireMic ? '1' : '0',
  });
  res.json({
    ok: true,
    code: targetRoom.code,
    url: `http://${HOST}:${PORT}/host.html?${q.toString()}`,
  });
});

/** 진행 중인 미팅 목록 (참여 코드 자동완성) */
app.get('/api/active-rooms', (req, res) => {
  const q = String(req.query.q || '').replace(/[^0-9]/g, '');
  const list = [];
  for (const room of rooms.values()) {
    if (room.ended) continue;
    // 호스트가 연결된 방만 (진행 중)
    if (!room.hostConnected) continue;
    const code = String(room.code || '');
    if (q && !code.startsWith(q)) continue;
    list.push({
      code,
      hostName: room.hostName || '호스트',
      viewerCount: viewerCount(room),
      streamActive: !!room.streamActive,
    });
  }
  list.sort((a, b) => a.code.localeCompare(b.code));
  res.json({ rooms: list.slice(0, 30) });
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
  const rawCode = String(req.body?.code ?? '').trim();
  let code = '';
  if (rawCode) {
    code = roomCode(rawCode);
    if (!/^[0-9]{4}$/.test(rawCode)) {
      return res.status(400).json({ error: '참여 코드는 4자리 숫자여야 합니다.' });
    }
    const existing = getRoom(code);
    if (existing && !existing.ended) {
      return res.status(409).json({ error: '이미 사용 중인 참여 코드입니다. 다른 번호를 입력해 주세요.' });
    }
    if (existing) rooms.delete(code);
  } else {
    try {
      code = makeRoomCode();
    } catch (err) {
      return res.status(500).json({ error: err.message || '방 코드 생성 실패' });
    }
  }
  const hostToken = crypto.randomBytes(16).toString('hex');
  const interactionMode = normalizeInteractionMode(req.body?.interactionMode);
  const requireMic = interactionMode === 'bidirectional' && !!req.body?.requireMic;
  const allowClientCamera = req.body?.allowClientCamera !== false;
  const allowClientDeepfake = allowClientCamera && req.body?.allowClientDeepfake !== false;
  const room = defaultRoom(code, hostToken, interactionMode, requireMic, allowClientCamera, allowClientDeepfake);
  try {
    ensureRoomLogDir(room);
  } catch (err) {
    console.warn('[create-room.php] log dir', err);
  }
  rooms.set(code, room);
  persistRoom(room);
  maybeScheduleEmptyRoomDispose(room);
  res.json({
    ok: true,
    code,
    hostToken,
    interactionMode: room.interactionMode,
    requireMic: !!room.requireMic,
    allowClientCamera: !!room.allowClientCamera,
    allowClientDeepfake: !!room.allowClientDeepfake,
  });
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
  pingInterval: 5000,
  pingTimeout: 10000,
});

// 원격 제어(호스트 → 화면 공유 중인 참가자 PC) — server/remote-control.js
const remoteControl = createRemoteControl({ io, getRoom, requireHost });
const faceRelay = createFaceRelay({ rooms, getRoom, requireHost });
app.get('/api/face-relay/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...faceRelay.getStats() });
});
remoteControl.registerRoutes(app);
function attachRemoteControlSocket(socket) {
  remoteControl.attachSocket(socket);
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.data.clientId = null;

  attachSfuHandlers(socket, {
    io,
    getRoomCode: () => socket.data.roomCode,
    getClientId: () => socket.data.clientId,
    getRole: () => socket.data.role,
    getInteractionMode: () => {
      const room = getRoom(socket.data.roomCode);
      return normalizeInteractionMode(room?.interactionMode);
    },
    getRoomPolicy: () => {
      const room = getRoom(socket.data.roomCode);
      return {
        allowClientCamera: room ? room.allowClientCamera !== false : true,
        allowClientDeepfake: room ? room.allowClientDeepfake !== false : true,
        requireMic: !!room?.requireMic,
      };
    },
  });
  attachRemoteControlSocket(socket);

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

      // 재접속 시 유예 타이머 취소 (1차 안전망: 기존 세션 및 미디어 유지)
      cancelPeerDisconnectGrace(room, clientId);

      if (role === 'host') {
        if (!requireHost(room, hostToken)) {
          const err = { error: '호스트 토큰이 올바르지 않습니다.' };
          if (typeof ack === 'function') ack(err);
          return;
        }
        room.hostConnected = true;
        room.hostSocketId = socket.id;
        room.hostClientId = clientId;
        room.hostName = name || room.hostName || '호스트';
        room.hostLastSeen = Date.now();
        room.lastActivity = Date.now();
        if (!room.activeBroadcasterId) {
          room.activeBroadcasterId = clientId;
        }
      } else {
        cancelViewerLeave(room, clientId);
        const prev = room.viewers.get(clientId);
        room.viewers.set(clientId, {
          name,
          socketId: socket.id,
          connected: true,
          lastSeen: Date.now(),
          // 마이크 상태는 항상 "실제" 상태만 반영한다. (필수 방이라고 임의로 on 으로 만들지 않음)
          micState: prev?.micState === 'on' || prev?.micState === 'none' ? prev.micState : 'off',
          micReady: prev?.micReady === true,
        });
        room.lastActivity = Date.now();
      }

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.role = role;
      socket.data.clientId = clientId;
      socket.data.hostToken = hostToken;

      const remote = socket.handshake?.address || socket.conn?.remoteAddress || '?';
      console.log(
        `[join] room=${code} role=${role} name=${name} client=${String(clientId).slice(0, 8)} remote=${remote} stream=${!!room.streamActive} viewers=${room.viewers.size}`
      );

      cancelEmptyRoomDispose(room);
      persistRoom(room);
      broadcastViewerCount(io, room);
      logRoomJoin(room, { role, name, clientId });

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

      // 최근 채팅 히스토리 (입장 직후)
      if (Array.isArray(room.chatMessages) && room.chatMessages.length) {
        socket.emit('chat-history', { messages: room.chatMessages.slice(-80) });
      }

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

  socket.on('chat-send', (msg, ack) => {
    const reply = (payload) => {
      if (typeof ack === 'function') {
        try { ack(payload); } catch { /* ignore */ }
      }
    };
    try {
      const code = socket.data.roomCode;
      const clientId = socket.data.clientId;
      const role = socket.data.role === 'host' ? 'host' : 'viewer';
      if (!code || !clientId) {
        reply({ error: '방에 참가되지 않았습니다. 새로고침 후 다시 시도해 주세요.' });
        return;
      }
      const room = getRoom(code);
      if (!room || room.ended) {
        reply({ error: '유효하지 않은 방입니다.' });
        return;
      }

      const text = String(msg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!text) {
        reply({ error: '빈 메시지는 보낼 수 없습니다.' });
        return;
      }

      // 간단한 속도 제한
      const now = Date.now();
      if (!socket.data._chatTimes) socket.data._chatTimes = [];
      socket.data._chatTimes = socket.data._chatTimes.filter((t) => now - t < 3000);
      if (socket.data._chatTimes.length >= 8) {
        reply({ error: '메시지를 너무 빠르게 보내고 있습니다.' });
        return;
      }
      socket.data._chatTimes.push(now);

      let name = '참가자';
      if (role === 'host') {
        name = room.hostName || '호스트';
      } else {
        name = room.viewers.get(clientId)?.name || '참가자';
      }

      const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        clientId,
        role,
        name,
        text,
        at: now,
      };
      if (!Array.isArray(room.chatMessages)) room.chatMessages = [];
      room.chatMessages.push(entry);
      if (room.chatMessages.length > 120) {
        room.chatMessages.splice(0, room.chatMessages.length - 120);
      }
      room.lastActivity = now;
      io.to(code).emit('chat-message', entry);
      logRoomChat(room, { role, name, text, clientId });
      reply({ ok: true, message: entry });
    } catch (e) {
      console.error('[chat-send]', e);
      reply({ error: e.message || '채팅 전송 실패' });
    }
  });

  socket.on('chat-request-history', () => {
    try {
      const room = getRoom(socket.data.roomCode);
      if (!room) return;
      const messages = Array.isArray(room.chatMessages) ? room.chatMessages.slice(-80) : [];
      socket.emit('chat-history', { messages });
    } catch (e) {
      console.error('[chat-request-history]', e);
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
        case 'start-meeting-countdown': {
          room.meetingStarted = true;
          room.meetingCountdown = true;
          const countdownSec = Math.max(1, parseInt(payload?.duration, 10) || 5);
          if (room._countdownTimer) clearTimeout(room._countdownTimer);
          room._countdownTimer = setTimeout(() => {
            room._countdownTimer = null;
            if (room && !room.ended) {
              room.meetingStarted = true;
              room.meetingCountdown = false;
              persistRoom(room);
              broadcastViewerCount(io, room);
              // 카운트다운만 듣고 meeting-started를 못 받은 참가자 안전망
              io.to(room.code).emit('meeting-started', {});
            }
          }, countdownSec * 1000 + 200);
          break;
        }
        case 'meeting-started': {
          if (room._countdownTimer) {
            clearTimeout(room._countdownTimer);
            room._countdownTimer = null;
          }
          room.meetingStarted = true;
          room.meetingCountdown = false;
          persistRoom(room);
          broadcastViewerCount(io, room);
          break;
        }
        case 'session-end':
          room.ended = true;
          room.endedAt = Date.now();
          room.popup = null;
          room.video = null;
          room.audio = null;
          room.streamActive = false;
          room.streamKinds = [];
          room.activeBroadcasterId = null;
          room.meetingStarted = false;
          room.meetingCountdown = false;
          payload.message = payload.message || '호스트가 발표를 종료했습니다.';
          break;
        case 'request-screen-share': {
          if (normalizeInteractionMode(room.interactionMode) === 'unidirectional') {
            return;
          }
          const targetId = String(payload.clientId || '');
          const viewer = room.viewers.get(targetId);
          if (viewer?.socketId) {
            io.to(viewer.socketId).emit('request-screen-share', {
              hostName: room.hostName || '호스트',
            });
          }
          return;
        }
        case 'stop-screen-share': {
          const targetId = String(payload.clientId || room.activeBroadcasterId || '');
          if (targetId && targetId !== room.hostClientId) {
            const viewer = room.viewers.get(targetId);
            if (viewer?.socketId) {
              io.to(viewer.socketId).emit('stop-screen-share', {});
            }
          }
          room.activeBroadcasterId = room.hostClientId;
          persistRoom(room);
          broadcastBroadcaster(io, room);
          broadcastViewerCount(io, room);
          return;
        }
        case 'display-mode': {
          // 얼굴 화면 ↔ PC 화면 전환. 참가자는 'screen' 동안 딥페이크/얼굴 송출을 멈춘다(목소리는 그대로).
          // 늦게 들어온 참가자도 publicState 로 현재 모드를 받는다.
          room.displayMode = payload.mode === 'screen' ? 'screen' : 'face';
          payload.mode = room.displayMode;
          break;
        }
        case 'set-broadcaster': {
          const nextId = String(payload.clientId || room.hostClientId || '');
          const prevId = room.activeBroadcasterId || null;
          const hostId = room.hostClientId || null;
          const goingHost = !nextId || nextId === hostId;
          // stop-screen-share가 먼저 activeBroadcasterId를 호스트로 바꿔도
          // 호스트가 넘긴 stopClientId로 공유 참가자에게 중지 신호를 보장한다.
          const stopId = String(payload.stopClientId || '');
          const targetStop = goingHost
            ? (stopId || (prevId && prevId !== hostId ? prevId : ''))
            : '';
          if (targetStop && targetStop !== hostId) {
            const viewer = room.viewers.get(targetStop);
            if (viewer?.socketId) {
              io.to(viewer.socketId).emit('stop-screen-share', {});
            }
          }
          room.activeBroadcasterId = goingHost ? hostId : (nextId || hostId);
          persistRoom(room);
          broadcastBroadcaster(io, room);
          broadcastViewerCount(io, room);
          return;
        }
        default:
          // draw-start / draw-move 등은 상태 저장 없이 중계만
          break;
      }

      persistRoom(room);
      // 슬라이드/낙서 등은 다른 클라이언트에게만, 종료 및 미팅 시작 카운트다운/미팅 시작은 전원에게 브로드캐스트
      if (type === 'session-end' || type === 'start-meeting-countdown' || type === 'meeting-started') {
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
    const now = Date.now();
    room.lastActivity = now;
    if (socket.data.role === 'host') {
      room.hostConnected = true;
      room.hostSocketId = socket.id;
      room.hostLastSeen = now;
      cancelPeerDisconnectGrace(room, socket.data.clientId);
    } else if (socket.data.clientId && room.viewers.has(socket.data.clientId)) {
      const v = room.viewers.get(socket.data.clientId);
      v.lastSeen = now;
      v.socketId = socket.id;
      v.connected = true;
      cancelPeerDisconnectGrace(room, socket.data.clientId);
    }
  });

  /** 마이크 상태: on | off | none(장치 없음/인식 실패) */
  socket.on('mic-status', (msg) => {
    try {
      const code = socket.data.roomCode;
      const room = code ? getRoom(code) : null;
      if (!room || !socket.data.clientId) return;
      const raw = String(msg?.state || 'off');
      const state = raw === 'on' || raw === 'none' ? raw : 'off';
      // ready: 클라이언트가 "말했을 때 실제로 소리가 잡히는 마이크"를 확인했는가
      // (필수 방에서 host/viewer 모두 ready=true 가 되어야 참여자로 인정)
      const ready = msg?.ready === true && state !== 'none';
      if (socket.data.role === 'host') {
        if (!requireHost(room, socket.data.hostToken)) return;
        if (room.hostMicState === state && room.hostMicReady === ready) return;
        room.hostMicState = state;
        room.hostMicReady = ready;
      } else {
        const viewer = room.viewers.get(socket.data.clientId);
        if (!viewer) return;
        if (viewer.micState === state && viewer.micReady === ready) return;
        viewer.micState = state;
        viewer.micReady = ready;
      }
      room.lastActivity = Date.now();
      broadcastViewerCount(io, room);
    } catch (e) {
      console.error('[mic-status]', e);
    }
  });

  socket.on('client-diag', (msg) => {
    const code = socket.data.roomCode || '?';
    const role = socket.data.role || '?';
    const client = String(socket.data.clientId || '').slice(0, 8);
    console.log(
      `[diag] room=${code} role=${role} peer=${client}`,
      typeof msg === 'object' ? JSON.stringify(msg) : String(msg)
    );
  });

  socket.on('disconnect', (reason) => {
    const code = socket.data.roomCode;
    const clientId = socket.data.clientId;
    const role = socket.data.role;
    const room = code ? getRoom(code) : null;
    if (!room || !clientId) return;

    console.log(
      `[disconnect] room=${code} role=${role} client=${clientId.slice(0, 8)} reason=${reason} (grace ${Math.round(PEER_DISCONNECT_GRACE_MS / 1000)}s)`
    );

    if (role === 'host') {
      if (room.hostSocketId === socket.id) {
        room.hostConnected = false;
        room.hostSocketId = null;
        // 1차 안전망: 스트림과 SFU 리소스를 즉시 끊지 않고 30초 유예 부여
        schedulePeerDisconnectGrace(io, room, clientId, 'host');
      }
    } else {
      const v = room.viewers.get(clientId);
      if (v && v.socketId === socket.id) {
        v.connected = false;
        v.socketId = null;
        // 1차 안전망: 참가자 세션 및 SFU 리소스를 즉시 삭제하지 않고 30초 유예 부여
        schedulePeerDisconnectGrace(io, room, clientId, 'viewer');
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  YUNSEUL MEET (SFU 단일 경로)');
  console.log(`  내부: http://${HOST}:${PORT}/`);
  console.log(`  SFU RTC: ${getRtcPort()}~${getRtcPort() + Math.max(0, getWorkerCount() - 1)} UDP+TCP (UDP 우선)`);
  console.log(`  SFU Workers: ${getWorkerCount()}개 (MEDIASOUP_WORKERS)`);
  console.log(`  SFU ICE IPs: ${getListenIps().map((x) => x.announcedAddress || x.announcedIp).join(', ')}`);
  console.log('  공개: https://ppt.smrun.net/  (Apache 프록시)');
  console.log(`  빈 방 유예: ${Math.round(EMPTY_ROOM_GRACE_MS / 1000)}s · 스윕: ${Math.round(ROOM_SWEEP_MS / 1000)}s`);
  console.log('══════════════════════════════════════');
  console.log('');
  // SFU 워커를 부팅 시 미리 올려 44444 LISTEN 확보
  getWorker().catch((err) => console.warn('[sfu] warmup', err));

  // Deep-Live-Cam 실시간 페이스 스왑 백그라운드 워커 기동
  startFaceSwapWorker();
  try { startExtraFaceSwapWorkers(); } catch (err) { console.warn('[FaceSwap] extra workers', err); }

  try { sweepRooms(); } catch (err) { console.warn('[room] initial sweep', err); }
  setInterval(() => {
    try { sweepRooms(); } catch (err) { console.warn('[room] sweep', err); }
  }, ROOM_SWEEP_MS).unref?.();
});

// WebSocket upgrade proxy: /face-swap-ws -> face_swap_worker:8765/ws
server.on('upgrade', (req, socket, head) => {
  // 원격 제어 에이전트(/rc-agent)는 자체 WebSocketServer 가 처리
  if (req.url && req.url.startsWith('/rc-agent')) {
    if (!remoteControl.handleUpgrade(req, socket, head)) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    return;
  }
  // 딥페이크 릴레이(/face-swap-ws) + 호스트 직송(/face-feed). FACE_RELAY=0 이면 아래 raw 프록시가 처리한다.
  if (faceRelay.handleUpgrade(req, socket, head)) return;
  if (req.url && (req.url.startsWith('/face-swap-ws') || req.url.startsWith('/ws'))) {
    socket.pause();
    const net = require('net');
    const port = Number(process.env.FACE_SWAP_PORT || 8765);
    const proxySocket = net.connect(port, '127.0.0.1', () => {
      // 실시간 프레임은 작은 바이너리 1건 = 1패킷이다. Nagle이 켜져 있으면
      // 프레임이 최대 40ms씩 지연 병합되어 "고속 재생/멈칫거림"이 생긴다.
      try { proxySocket.setNoDelay(true); } catch { /* ignore */ }
      try { socket.setNoDelay(true); } catch { /* ignore */ }
      const targetPath = req.url.replace('/face-swap-ws', '/ws');
      const lines = [`${req.method} ${targetPath} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        lines.push(`${k}: ${v}`);
      }
      // 참가자 식별자 전달 — 워커가 참가자별로 프레임 캐시/얼굴 추적을 분리한다
      try {
        const u = new URL(req.url, 'http://localhost');
        const cid = u.searchParams.get('client');
        if (cid) lines.push(`X-Client-Id: ${cid}`);
      } catch { /* ignore */ }
      lines.push('\r\n');
      proxySocket.write(lines.join('\r\n'));
      if (head && head.length) proxySocket.write(head);
      socket.pipe(proxySocket);
      proxySocket.pipe(socket);
      socket.resume();
    });
    proxySocket.on('error', () => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
    socket.on('error', () => {
      try { proxySocket.destroy(); } catch { /* ignore */ }
    });
  }
});

let faceSwapProcess = null;
let faceSwapRestartTimer = null;
let faceSwapStopping = false;

function getPythonCmd() {
  const pythonCandidates = [
    process.env.PYTHON_PATH,
    'C:\\Program Files\\Python313\\python.exe',
    'python',
    'py',
  ].filter(Boolean);
  for (const cand of pythonCandidates) {
    if (cand.includes('\\') || cand.includes('/')) {
      if (fs.existsSync(cand)) return cand;
    }
  }
  return 'python';
}

function startFaceSwapWorker() {
  if (faceSwapStopping) return;
  if (faceSwapProcess) return;

  const net = require('net');
  const port = Number(process.env.FACE_SWAP_PORT || 8765);
  // 포트 8765에 이미 워커가 동작 중인지 사전 프로브
  const probe = net.connect(port, '127.0.0.1', () => {
    probe.destroy();
    console.log(`[FaceSwap] worker already listening on port ${port}`);
  });
  probe.on('error', () => {
    _spawnFaceSwapWorkerProcess();
  });
}

function _spawnFaceSwapWorkerProcess() {
  if (faceSwapStopping) return;
  if (faceSwapProcess) return;

  const workerScript = path.join(__dirname, 'face_swap_worker.py');
  if (!fs.existsSync(workerScript)) return;

  const pythonCmd = getPythonCmd();
  const workersEnv = process.env.FACE_SWAP_WORKERS || '0';
  console.log(`[FaceSwap] starting worker with ${pythonCmd} (FACE_SWAP_WORKERS=${workersEnv})...`);

  try {
    faceSwapProcess = spawn(pythonCmd, ['-u', workerScript], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    faceSwapProcess.stdout.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log('[FaceSwap]', s);
    });
    faceSwapProcess.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log('[FaceSwap]', s);
    });
    faceSwapProcess.on('error', (err) => {
      console.warn('[FaceSwap] worker spawn error:', err);
    });
    faceSwapProcess.on('exit', (code) => {
      console.log(`[FaceSwap] worker exited (code=${code})`);
      faceSwapProcess = null;
      if (!faceSwapStopping) {
        clearTimeout(faceSwapRestartTimer);
        faceSwapRestartTimer = setTimeout(() => {
          startFaceSwapWorker();
        }, 3000);
      }
    });
  } catch (err) {
    console.warn('[FaceSwap] could not spawn worker:', err);
    if (!faceSwapStopping) {
      clearTimeout(faceSwapRestartTimer);
      faceSwapRestartTimer = setTimeout(startFaceSwapWorker, 5000);
    }
  }
}

// 추가 GPU 워커 프로세스 (선택): FACE_SWAP_EXTRA_WORKERS=N → 포트 base+1..base+N 에 독립 워커를 더 띄우고
// 릴레이가 접속 수가 적은 워커로 분배한다. (GPU 1장에서는 이득이 작고 VRAM 을 2배 쓴다. GPU 여러 장/큰 VRAM 용)
const extraFaceSwapProcs = new Map();
function startExtraFaceSwapWorkers() {
  const n = Math.max(0, Math.min(7, Number(process.env.FACE_SWAP_EXTRA_WORKERS || 0) || 0));
  if (!n || process.env.FACE_SWAP_PORTS) return;
  const base = Number(process.env.FACE_SWAP_PORT || 8765);
  const ports = [base];
  for (let i = 1; i <= n; i++) ports.push(base + i);
  process.env.FACE_SWAP_PORTS = ports.join(',');
  const workerScript = path.join(__dirname, 'face_swap_worker.py');
  if (!fs.existsSync(workerScript)) return;
  const spawnOne = (port) => {
    if (faceSwapStopping || extraFaceSwapProcs.has(port)) return;
    console.log(`[FaceSwap] extra worker on port ${port}`);
    const child = spawn(getPythonCmd(), ['-u', workerScript], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', FACE_SWAP_PORT: String(port), FACE_SWAP_WORKERS: '0' },
    });
    extraFaceSwapProcs.set(port, child);
    const pipeLog = (d) => { const s = d.toString().trim(); if (s) console.log(`[FaceSwap:${port}]`, s); };
    child.stdout.on('data', pipeLog);
    child.stderr.on('data', pipeLog);
    child.on('error', (err) => console.warn(`[FaceSwap:${port}] spawn error:`, err));
    child.on('exit', (code) => {
      console.log(`[FaceSwap:${port}] exited (code=${code})`);
      extraFaceSwapProcs.delete(port);
      if (!faceSwapStopping) setTimeout(() => spawnOne(port), 3000).unref?.();
    });
  };
  // 메인 워커가 모델을 올린 뒤에 시작해 초기 VRAM/디스크 경합을 줄인다
  setTimeout(() => { for (const p of ports.slice(1)) spawnOne(p); }, 20000).unref?.();
}

function stopFaceSwapWorker() {
  faceSwapStopping = true;
  clearTimeout(faceSwapRestartTimer);
  for (const child of extraFaceSwapProcs.values()) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  extraFaceSwapProcs.clear();
  if (faceSwapProcess) {
    try {
      faceSwapProcess.kill('SIGTERM');
    } catch { /* ignore */ }
    faceSwapProcess = null;
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Node] uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[Node] unhandledRejection:', reason);
});
process.on('exit', stopFaceSwapWorker);
process.on('SIGINT', () => { stopFaceSwapWorker(); process.exit(0); });
process.on('SIGTERM', () => { stopFaceSwapWorker(); process.exit(0); });

