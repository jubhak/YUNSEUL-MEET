/**
 * Socket.io 기반 방 동기화 + WebRTC 시그널 진입점
 */
export class RoomSync {
  constructor({ code, role, hostToken = null, name = '참가자', onEvent, onError, onRejoined }) {
    this.code = code;
    this.role = role;
    this.hostToken = hostToken;
    this.name = name;
    this.onEvent = onEvent || (() => {});
    this.onError = onError || (() => {});
    this.onRejoined = onRejoined || (() => {});
    const idKey = role === 'host' ? 'hostClientId' : 'viewerClientId';
    this.clientId = sessionStorage.getItem(idKey) ||
      (crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    sessionStorage.setItem(idKey, this.clientId);
    this.socket = null;
    this.heartbeatTimer = null;
    this.drawMoveQueue = null;
    this.drawMoveTimer = null;
    this.joined = null;
    this._rejoining = false;
  }

  _emitJoin() {
    return new Promise((resolve, reject) => {
      this.socket.emit('join', {
        code: this.code,
        role: this.role,
        hostToken: this.hostToken,
        name: this.name,
        clientId: this.clientId,
      }, (res) => {
        if (!res || res.error) {
          const err = new Error(res?.error || '유효하지 않은 방입니다.');
          err.ended = !!res?.ended;
          reject(err);
          return;
        }
        resolve(res);
      });
    });
  }

  async start() {
    if (typeof window.io !== 'function') {
      throw new Error('Socket.io 클라이언트가 없습니다. Node 서버(npm start)로 접속하세요.');
    }

    this.socket = window.io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 300,
      reconnectionDelayMax: 1500,
      reconnectionAttempts: Infinity,
      timeout: 8000,
    });

    let hasConnectedOnce = false;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('서버 연결 시간 초과. Node 서버가 실행 중인지 확인하세요.')), 12000);
      this.socket.once('connect', () => {
        clearTimeout(t);
        hasConnectedOnce = true;
        resolve();
      });
      this.socket.once('connect_error', (err) => {
        clearTimeout(t);
        reject(new Error(err?.message || '서버에 연결할 수 없습니다.'));
      });
    });

    this.bindEvents();
    const data = await this._emitJoin();
    this.joined = data;

    // 1차 안전망: Socket.IO v4 재접속 시 자동 방 재체결 (이벤트 유실 완전 방지)
    this.socket.on('connect', () => {
      if (hasConnectedOnce) {
        console.log('[RoomSync] socket reconnected -> rejoining...');
        this._rejoin();
      }
    });
    this.socket.io?.on('reconnect', () => {
      console.log('[RoomSync] socket.io manager reconnect -> rejoining...');
      this._rejoin();
    });

    // 하트비트: 소켓 생존 확인용. Socket.IO 자체 ping(25s)이 있어 15초면 충분하다.
    // (4초 → 15초: 참가자 수 × 초당 메시지 3.75배 절감)
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('heartbeat');
      } else if (this.socket && !this.socket.connected) {
        try { this.socket.connect(); } catch { /* ignore */ }
      }
    }, 15000);

    return data;
  }

  async _rejoin() {
    if (this._rejoining || !this.socket?.connected) return;
    this._rejoining = true;
    try {
      this.joined = await this._emitJoin();
      console.log('[RoomSync] successfully rejoined room:', this.code);
      this.onRejoined(this.joined);
    } catch (err) {
      console.warn('[RoomSync] rejoin retry error', err);
    } finally {
      this._rejoining = false;
    }
  }

  bindEvents() {
    const types = [
      'slide-change',
      'draw-start',
      'draw-move',
      'draw-end',
      'clear-drawings',
      'clear-all-drawings',
      'open-link',
      'close-link',
      'play-video',
      'video-control',
      'close-video',
      'play-audio',
      'audio-control',
      'close-audio',
      'presentation-ready',
      'viewer-count',
      'session-end',
      'start-meeting-countdown',
      'meeting-started',
      'stream-status',
      'peer-joined',
      'peer-left',
      'request-screen-share',
      'stop-screen-share',
      'broadcaster-changed',
      'screen-share-ended',
      'display-mode',
      'spotlight-speaker',
      'voice-floor',
    ];
    types.forEach((type) => {
      this.socket.on(type, (payload) => {
        this.onEvent(type, payload || {});
      });
    });
    if (typeof this.socket.onAny === 'function') {
      this.socket.onAny((type, payload) => {
        if (!types.includes(type)) {
          this.onEvent(type, payload || {});
        }
      });
    }
  }

  async emit(type, payload = {}) {
    if (this.role !== 'host' || !this.socket) return;

    if (type === 'draw-move') {
      this.drawMoveQueue = payload;
      if (this.drawMoveTimer) return;
      this.drawMoveTimer = setTimeout(() => {
        const data = this.drawMoveQueue;
        this.drawMoveQueue = null;
        this.drawMoveTimer = null;
        if (data) this.socket.emit('host-event', { type: 'draw-move', payload: data });
      }, 40);
      return;
    }

    this.socket.emit('host-event', { type, payload });
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.drawMoveTimer) clearTimeout(this.drawMoveTimer);
    try {
      this.socket?.disconnect();
    } catch { /* ignore */ }
    this.socket = null;
  }
}
