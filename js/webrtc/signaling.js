/**
 * Socket.io ↔ WebRTC 시그널 어댑터.
 * 이벤트 이름/페이로드는 이후 SFU·다자 회의에서도 동일하게 유지.
 */
export class WebrtcSignaling {
  constructor(socket, { localClientId } = {}) {
    this.socket = socket;
    this.localClientId = localClientId;
    this._handlers = new Set();
  }

  /** @param {(msg: object) => void} fn */
  onSignal(fn) {
    const handler = (msg) => fn(msg || {});
    this._handlers.add(handler);
    this.socket.on('webrtc-signal', handler);
    return () => {
      this.socket.off('webrtc-signal', handler);
      this._handlers.delete(handler);
    };
  }

  onPeerJoined(fn) {
    const handler = (msg) => fn(msg || {});
    this.socket.on('peer-joined', handler);
    return () => this.socket.off('peer-joined', handler);
  }

  onPeerLeft(fn) {
    const handler = (msg) => fn(msg || {});
    this.socket.on('peer-left', handler);
    return () => this.socket.off('peer-left', handler);
  }

  onStreamStatus(fn) {
    const handler = (msg) => fn(msg || {});
    this.socket.on('stream-status', handler);
    return () => this.socket.off('stream-status', handler);
  }

  /**
   * @param {{ type: 'offer'|'answer'|'ice'|'bye', toClientId: string, payload?: object }} msg
   */
  send(msg) {
    if (!this.socket?.connected) return;
    this.socket.emit('webrtc-signal', {
      type: msg.type,
      toClientId: msg.toClientId,
      payload: msg.payload || {},
    });
  }

  setStreamStatus({ active, kinds = ['display'] }) {
    if (!this.socket?.connected) return;
    this.socket.emit('stream-status', { active: !!active, kinds });
  }

  dispose() {
    this._handlers.forEach((h) => this.socket.off('webrtc-signal', h));
    this._handlers.clear();
  }
}
