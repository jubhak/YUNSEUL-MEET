import { PeerSession } from './peer-session.js?v=20260715ap';
import { TRACK_KIND } from './config.js';

/**
 * Host -> viewer display share (+ optional tab audio / mic).
 */
export class HostPublisher {
  /**
   * @param {{ signaling: import('./signaling.js').WebrtcSignaling, onStatus?: (s: object) => void }} opts
   */
  constructor({ signaling, onStatus }) {
    this.signaling = signaling;
    this.onStatus = onStatus || (() => {});
    /** @type {Map<string, PeerSession>} */
    this.peers = new Map();
    /** @type {MediaStream|null} */
    this.localStream = null;
    this.active = false;
    this.kinds = [];
    /** @type {MediaStreamTrack[]} */
    this._tabAudioTracks = [];
    /** @type {MediaStreamTrack[]} */
    this._micTracks = [];
    this.tabAudioWanted = true;
    this.micWanted = false;
    /** 참가자 새로고침 시 늦게 오는 peer-left가 새 연결을 끊지 않게 */
    this._joinGuard = new Map();

    this._unsubSignal = signaling.onSignal((msg) => this._onSignal(msg));
    this._unsubJoined = signaling.onPeerJoined((msg) => this._onPeerJoined(msg));
    this._unsubLeft = signaling.onPeerLeft((msg) => this._onPeerLeft(msg));
  }

  get isActive() {
    return this.active && !!this.localStream;
  }

  get hasTabAudio() {
    return this._tabAudioTracks.some((t) => t && t.readyState === 'live');
  }

  get hasMic() {
    return this._micTracks.some((t) => t && t.readyState === 'live');
  }

  get tabAudioEnabled() {
    return this._tabAudioTracks.some((t) => t?.enabled);
  }

  get micEnabled() {
    return this._micTracks.some((t) => t?.enabled);
  }

  /**
   * @param {{ withMic?: boolean, withTabAudio?: boolean }} opts
   */
  async startDisplayCapture({ withMic = false, withTabAudio = true } = {}) {
    if (this.localStream) this.stopCaptureOnly();

    this.tabAudioWanted = !!withTabAudio;
    this.micWanted = !!withMic;
    this._tabAudioTracks = [];
    this._micTracks = [];

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: withTabAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        : false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      systemAudio: withTabAudio ? 'include' : 'exclude',
    });

    this.kinds = [TRACK_KIND.DISPLAY];
    this._tabAudioTracks = stream.getAudioTracks().slice();
    if (this._tabAudioTracks.length) {
      this.kinds.push('tab-audio');
      this._tabAudioTracks.forEach((t) => {
        t.enabled = !!withTabAudio;
      });
    }

    this.localStream = stream;
    this.active = true;

    await this._restrictCaptureToStage(stream);

    if (withMic) {
      await this.ensureMic(true);
    }

    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.addEventListener('ended', () => {
        this.stop();
      });
    }

    this._emitStatus();
    return stream;
  }

  /**
   * 참가자에게 툴바가 안 보이게 발표 영역만 송출.
   * Region Capture(cropTo) 우선 — Element Capture는 복잡 DOM에서 검정 프레임이 나는 경우가 있음.
   */
  async _restrictCaptureToStage(stream) {
    const el = document.getElementById('capture-root')
      || document.getElementById('presentation-stage')
      || document.querySelector('.stage-area');
    if (!el) return;

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    try {
      if (typeof CropTarget !== 'undefined' && CropTarget.fromElement
          && typeof track.cropTo === 'function') {
        const target = await CropTarget.fromElement(el);
        await track.cropTo(target);
        console.info('[HostPublisher] Region Capture OK');
        return;
      }
    } catch (err) {
      console.warn('[HostPublisher] Region Capture failed', err);
    }

    try {
      if (typeof RestrictionTarget !== 'undefined' && RestrictionTarget.fromElement
          && typeof track.restrictTo === 'function') {
        const target = await RestrictionTarget.fromElement(el);
        await track.restrictTo(target);
        console.info('[HostPublisher] Element Capture OK');
      }
    } catch (err) {
      console.warn('[HostPublisher] Element Capture failed', err);
    }
  }

  async ensureMic(enabled = true) {
    if (!this.localStream) return false;
    if (this.hasMic) {
      this.setMicEnabled(enabled);
      return true;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      for (const track of mic.getAudioTracks()) {
        try { track.contentHint = 'speech'; } catch { /* ignore */ }
        track.enabled = !!enabled;
        this.localStream.addTrack(track);
        this._micTracks.push(track);
        await this._addTrackToPeers(track);
      }
      if (!this.kinds.includes(TRACK_KIND.MIC)) this.kinds.push(TRACK_KIND.MIC);
      this.micWanted = !!enabled;
      this._emitStatus();
      return true;
    } catch (err) {
      console.warn('[HostPublisher] mic failed', err);
      return false;
    }
  }

  setTabAudioEnabled(on) {
    this.tabAudioWanted = !!on;
    this._tabAudioTracks.forEach((t) => {
      if (t) t.enabled = !!on;
    });
    this._emitStatus();
  }

  setMicEnabled(on) {
    this.micWanted = !!on;
    this._micTracks.forEach((t) => {
      if (t) t.enabled = !!on;
    });
    this._emitStatus();
  }

  async _addTrackToPeers(track) {
    if (!this.localStream || !track) return;
    for (const [peerId, session] of this.peers) {
      try {
        session.addTrack(track, this.localStream);
        const offer = await session.createOffer();
        this.signaling.send({
          type: 'offer',
          toClientId: peerId,
          payload: {
            sdp: offer,
            trackKind: TRACK_KIND.MIC,
          },
        });
      } catch (err) {
        console.warn('[HostPublisher] renegotiate', peerId, err);
      }
    }
  }

  _emitStatus() {
    this.signaling.setStreamStatus({ active: this.active, kinds: this.kinds });
    this.onStatus({
      active: this.active,
      kinds: this.kinds,
      withMic: this.hasMic && this.micEnabled,
      withTabAudio: this.hasTabAudio ? this.tabAudioEnabled : this.tabAudioWanted,
      micWanted: this.micWanted,
      tabAudioWanted: this.tabAudioWanted,
    });
  }

  async publishTo(peerIds = []) {
    if (!this.localStream) return;
    for (const id of peerIds) {
      if (!id) continue;
      await this.connectPeer(id);
    }
  }

  _closePeer(peerId) {
    const s = this.peers.get(peerId);
    if (!s) return;
    s._intentionalClose = true;
    try { s.pc.close(); } catch { /* ignore */ }
    this.peers.delete(peerId);
  }

  async connectPeer(peerId, { force = false } = {}) {
    if (!this.localStream || !peerId) return;

    const existing = this.peers.get(peerId);
    const startedAt = this._connectAt?.get(peerId) || 0;
    const age = Date.now() - startedAt;
    if (!force && existing) {
      const st = existing.pc?.connectionState;
      const ice = existing.pc?.iceConnectionState;
      if (st === 'connected'
          || ice === 'connected'
          || ice === 'completed') {
        return;
      }
      // 협상 중이면 잠시 유지 — 8초 넘으면 고착으로 보고 재생성
      if ((st === 'connecting' || ice === 'checking') && age < 8000) return;
    }

    const now = Date.now();
    if (!force && this._connectAt?.get(peerId) && now - this._connectAt.get(peerId) < 2500) {
      return;
    }
    if (!this._connectAt) this._connectAt = new Map();
    this._connectAt.set(peerId, now);

    this._closePeer(peerId);

    const session = new PeerSession({
      peerId,
      onIce: (candidate) => {
        this.signaling.send({
          type: 'ice',
          toClientId: peerId,
          payload: { candidate: candidate.toJSON ? candidate.toJSON() : candidate },
        });
      },
      onConnectionState: (state) => {
        if (session._intentionalClose) return;
        if (state === 'failed' || state === 'closed') {
          this._closePeer(peerId);
        }
      },
    });

    this.localStream.getTracks().forEach((track) => {
      session.addTrack(track, this.localStream);
    });

    this.peers.set(peerId, session);

    const offer = await session.createOffer();
    this.signaling.send({
      type: 'offer',
      toClientId: peerId,
      payload: {
        sdp: offer,
        trackKind: TRACK_KIND.DISPLAY,
      },
    });
  }

  async _onPeerJoined(msg) {
    if (!this.isActive) return;
    if (msg.role && msg.role !== 'viewer') return;
    const id = msg.clientId;
    if (!id) return;
    this._joinGuard.set(id, Date.now());

    const existing = this.peers.get(id);
    if (existing) {
      const st = existing.pc?.connectionState;
      const ice = existing.pc?.iceConnectionState;
      const age = Date.now() - (this._connectAt?.get(id) || 0);
      if (st === 'connected' || ice === 'connected' || ice === 'completed') return;
      if ((st === 'connecting' || ice === 'checking') && age < 8000) return;
      if (this._connectAt) this._connectAt.delete(id);
      await this.connectPeer(id, { force: true });
      return;
    }

    await this.connectPeer(id);
  }

  _onPeerLeft(msg) {
    const id = msg?.clientId;
    if (!id) return;
    const joinedAt = this._joinGuard.get(id);
    if (joinedAt && Date.now() - joinedAt < 4000) return;
    this._joinGuard.delete(id);
    this._closePeer(id);
    this._closeUplink(id);
  }

  async _onSignal(msg) {
    const { type, fromClientId, payload } = msg;
    if (!fromClientId) return;

    // 참가자 마이크 업링크
    if (payload?.kind === 'viewer-mic') {
      if (type === 'offer' && payload?.sdp) {
        await this._acceptViewerMic(fromClientId, payload.sdp);
        return;
      }
      const up = this._uplinks?.get(fromClientId);
      if (type === 'ice' && up && payload?.candidate) {
        await up.addIce(payload.candidate);
        return;
      }
      if (type === 'bye') {
        this._closeUplink(fromClientId);
        return;
      }
    }

    const session = this.peers.get(fromClientId);

    if (type === 'answer' && session && payload?.sdp) {
      await session.acceptAnswer(payload.sdp);
      return;
    }
    if (type === 'ice' && session && payload?.candidate) {
      await session.addIce(payload.candidate);
      return;
    }
    if (type === 'bye') {
      this._closePeer(fromClientId);
      this._closeUplink(fromClientId);
    }
  }

  async _acceptViewerMic(peerId, sdp) {
    if (!this._uplinks) this._uplinks = new Map();
    this._closeUplink(peerId);

    if (!this._viewerAudioEl) {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.playsInline = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      document.body.appendChild(a);
      this._viewerAudioEl = a;
    }

    const session = new PeerSession({
      peerId,
      onIce: (candidate) => {
        this.signaling.send({
          type: 'ice',
          toClientId: peerId,
          payload: {
            candidate: candidate.toJSON ? candidate.toJSON() : candidate,
            kind: 'viewer-mic',
          },
        });
      },
      onTrack: (ev) => {
        const stream = ev.streams?.[0] || new MediaStream([ev.track]);
        if (!this._viewerAudioMix) {
          this._viewerAudioMix = new MediaStream();
        }
        stream.getAudioTracks().forEach((t) => {
          if (!this._viewerAudioMix.getTracks().includes(t)) {
            this._viewerAudioMix.addTrack(t);
          }
        });
        this._viewerAudioEl.srcObject = this._viewerAudioMix;
        this._viewerAudioEl.play().catch(() => {});
      },
      onConnectionState: (state) => {
        if (session._intentionalClose) return;
        if (state === 'failed' || state === 'closed') {
          this._closeUplink(peerId);
        }
      },
    });

    this._uplinks.set(peerId, session);
    const answer = await session.acceptOffer(sdp);
    this.signaling.send({
      type: 'answer',
      toClientId: peerId,
      payload: { sdp: answer, kind: 'viewer-mic' },
    });
  }

  _closeUplink(peerId) {
    const s = this._uplinks?.get(peerId);
    if (!s) return;
    s._intentionalClose = true;
    try { s.pc.close(); } catch { /* ignore */ }
    this._uplinks.delete(peerId);
  }

  stopCaptureOnly() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this.localStream = null;
    this._tabAudioTracks = [];
    this._micTracks = [];
  }

  stop() {
    [...this.peers.keys()].forEach((id) => {
      this.signaling.send({ type: 'bye', toClientId: id, payload: {} });
      this._closePeer(id);
    });
    if (this._uplinks) {
      [...this._uplinks.keys()].forEach((id) => this._closeUplink(id));
    }
    if (this._viewerAudioEl) {
      this._viewerAudioEl.srcObject = null;
    }
    this._viewerAudioMix = null;
    this.stopCaptureOnly();
    this.active = false;
    this.kinds = [];
    this.signaling.setStreamStatus({ active: false, kinds: [] });
    this.onStatus({
      active: false,
      kinds: [],
      withMic: false,
      withTabAudio: this.tabAudioWanted,
      micWanted: this.micWanted,
      tabAudioWanted: this.tabAudioWanted,
    });
  }

  dispose() {
    this.stop();
    this._unsubSignal?.();
    this._unsubJoined?.();
    this._unsubLeft?.();
  }
}
