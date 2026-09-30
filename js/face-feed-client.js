/**
 * 호스트 전용: 딥페이크 프레임 직송 수신기.
 *
 * 서버(/face-feed)가 GPU 워커의 결과 JPEG 를 참가자별로 곧바로 밀어준다.
 * 이를 참가자별 canvas 에 그리고 canvas.captureStream() 을 호스트 화면(그리드/PIP)의 <video> 에 연결한다.
 *  - 참가자 PC 의 재인코딩(VP8) + SFU + 지터버퍼 구간을 건너뛰므로 stress_test.html 처럼 지연이 짧고 화질이 좋다.
 *  - 프레임이 끊기면(isLive=false) 호출측이 기존 SFU 스트림으로 자동 복귀한다.
 */

const FS2 = 0x46533200;
const HEADER_BYTES = 12; // magic(4) + seq(4) + proc(2) + total(2)

export class FaceFeedClient {
  constructor({ roomCode, hostToken, staleMs = 900, onFirstLive = null } = {}) {
    this.roomCode = roomCode;
    this.hostToken = hostToken;
    this.staleMs = staleMs;
    this.onFirstLive = onFirstLive;
    this._ws = null;
    this._retryDelay = 500;
    this._retryTimer = null;
    this._stopped = true;
    this._clients = new Map();
    this._decoder = new TextDecoder();
    this.connected = false;
    this.totalFrames = 0;
    this._sweepTimer = null;
    this.supported = typeof WebSocket !== 'undefined'
      && typeof createImageBitmap === 'function'
      && typeof HTMLCanvasElement !== 'undefined'
      && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  start() {
    if (!this.supported || !this._stopped) return;
    this._stopped = false;
    this._connect();
    this._sweepTimer = setInterval(() => this._sweep(), 10000);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._sweepTimer);
    this._sweepTimer = null;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
    this.connected = false;
    for (const id of Array.from(this._clients.keys())) this.dropClient(id);
  }

  _connect() {
    if (this._stopped) return;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/face-feed?room=${encodeURIComponent(this.roomCode)}&ht=${encodeURIComponent(this.hostToken)}`;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;
      this.lastUrl = url.replace(/ht=[^&]+/, 'ht=***');
      ws.onopen = () => {
        this._ev('open');
        this.connected = true;
        this._retryDelay = 500;
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return;
        this._onFrame(ev.data);
      };
      const lost = (e) => {
        this._ev('close ' + (e && e.code));
        if (this._ws === ws) this._ws = null;
        this.connected = false;
        if (this._stopped) return;
        clearTimeout(this._retryTimer);
        this._retryTimer = setTimeout(() => this._connect(), this._retryDelay);
        this._retryDelay = Math.min(5000, this._retryDelay * 2);
      };
      ws.onclose = lost;
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
    } catch {
      this._retryTimer = setTimeout(() => this._connect(), this._retryDelay);
    }
  }

  _ev(s) {
    (this.events ||= []).push(s);
    if (this.events.length > 12) this.events.shift();
  }

  _state(id) {
    let st = this._clients.get(id);
    if (!st) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d', { alpha: false });
      let stream = canvas.captureStream(0);
      let track = stream.getVideoTracks()[0];
      if (!track || typeof track.requestFrame !== 'function') {
        // requestFrame 미지원 브라우저: 고정 fps 캡처로 대체
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        stream = canvas.captureStream(30);
        track = stream.getVideoTracks()[0];
      }
      st = {
        id, canvas, ctx, stream, track,
        decoding: false, pending: null,
        lastAt: 0, lastSeq: -1, frames: 0, everLive: false,
        fpsCount: 0, fpsAt: performance.now(), fps: 0, procMs: 0, totalMs: 0,
      };
      this._clients.set(id, st);
    }
    return st;
  }

  _onFrame(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 20) return;
    const idLen = u8[0];
    const off = 1 + idLen;
    if (u8.length < off + HEADER_BYTES + 100) return;
    const dv = new DataView(buf);
    if (dv.getUint32(off) !== FS2) return;
    const id = this._decoder.decode(u8.subarray(1, off));
    const seq = dv.getUint32(off + 4);
    const procMs = dv.getUint16(off + 8);
    const totalMs = dv.getUint16(off + 10);
    const st = this._state(id);
    // 오래된 프레임(역전)은 버린다 (u32 랩어라운드 고려). 참가자 재접속으로 seq 가 초기화되면(공백 후/크게 역행) 새로 시작.
    if (st.lastSeq >= 0) {
      const diff = (seq - st.lastSeq) | 0;
      const restarted = diff < -1000 || performance.now() - st.lastAt > 1500;
      if (diff <= 0 && !restarted) return;
    }
    st.lastSeq = seq;
    st.procMs = procMs;
    st.totalMs = totalMs;
    st.pending = new Blob([u8.subarray(off + HEADER_BYTES)], { type: 'image/jpeg' });
    if (!st.decoding) this._decodeNext(st);
  }

  async _decodeNext(st) {
    st.decoding = true;
    try {
      while (st.pending) {
        const blob = st.pending;
        st.pending = null; // 디코딩 중 새 프레임이 오면 최신 1장만 유지(적체 방지)
        let bmp = null;
        try { bmp = await createImageBitmap(blob); } catch { bmp = null; }
        if (!bmp) continue;
        if (st.canvas.width !== bmp.width || st.canvas.height !== bmp.height) {
          st.canvas.width = bmp.width;
          st.canvas.height = bmp.height;
        }
        st.ctx.drawImage(bmp, 0, 0);
        bmp.close();
        try { st.track.requestFrame?.(); } catch { /* ignore */ }
        const now = performance.now();
        st.lastAt = now;
        st.frames += 1;
        st.fpsCount += 1;
        this.totalFrames += 1;
        if (now - st.fpsAt >= 1000) {
          st.fps = Math.round((st.fpsCount * 1000) / (now - st.fpsAt) * 10) / 10;
          st.fpsCount = 0;
          st.fpsAt = now;
        }
        if (!st.everLive) {
          st.everLive = true;
          try { this.onFirstLive?.(st.id); } catch { /* ignore */ }
        }
      }
    } finally {
      st.decoding = false;
    }
  }

  /** 최근 staleMs 안에 프레임이 들어왔는가 */
  isLive(id) {
    const st = this._clients.get(id);
    return !!st && st.frames > 0 && performance.now() - st.lastAt < this.staleMs;
  }

  getStream(id) {
    return this._clients.get(id)?.stream || null;
  }

  /** 참가자가 나가거나 카메라를 껐을 때 자원 정리 */
  dropClient(id) {
    const st = this._clients.get(id);
    if (!st) return;
    this._clients.delete(id);
    try { st.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    st.pending = null;
  }

  /** 다시 첫 프레임 알림을 받고 싶을 때(카메라 재시작) */
  resetLive(id) {
    const st = this._clients.get(id);
    if (st) { st.everLive = false; st.lastSeq = -1; }
  }

  _sweep() {
    const now = performance.now();
    for (const [id, st] of this._clients) {
      if (now - st.lastAt > 120000) this.dropClient(id);
    }
  }

  stats() {
    const per = {};
    for (const [id, st] of this._clients) {
      per[id.slice(0, 6)] = {
        live: this.isLive(id), fps: st.fps, frames: st.frames,
        procMs: st.procMs, totalMs: st.totalMs, w: st.canvas.width, h: st.canvas.height,
      };
    }
    return { connected: this.connected, total: this.totalFrames, url: this.lastUrl || null, events: this.events || [], clients: per };
  }
}
