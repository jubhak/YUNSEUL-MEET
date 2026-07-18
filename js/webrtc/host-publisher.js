import { PeerSession } from './peer-session.js?v=20260715ap';
import { TRACK_KIND } from './config.js';

/**
 * Host -> viewer display share (+ optional tab audio / mic).
 * 송출은 단순하게: 탭 공유 + #capture-root(툴바 아래 본문)만 crop.
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

    const stage = document.getElementById('presentation-stage');
    const slide = document.getElementById('slide-fit');
    const stageOn = stage && !stage.classList.contains('hidden');
    // 검정 스테이지 말고 실제 PPT 박스만 송출 → 참가자 화면이 호스트처럼 큼
    const root = (stageOn && slide)
      || document.getElementById('capture-root')
      || document.querySelector('.stage-area');
    const rw = Math.max(640, Math.round(root?.clientWidth || window.innerWidth));
    const rh = Math.max(360, Math.round(root?.clientHeight || window.innerHeight));

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: rw },
        height: { ideal: rh },
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

    await this._cropToCaptureRoot(stream, root);

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

  async _cropToCaptureRoot(stream, el) {
    if (!el) return;
    const track = stream.getVideoTracks()[0];
    if (!track || typeof track.cropTo !== 'function') return;
    if (typeof CropTarget === 'undefined' || !CropTarget.fromElement) return;
    try {
      const target = await CropTarget.fromElement(el);
      await track.cropTo(target);
    } catch (err) {
      console.warn('[HostPublisher] crop skipped', err);
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
      if (st === 'connected' || ice === 'connected' || ice === 'completed') return;
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
  }

  async _onSignal(msg) {
    const { type, fromClientId, payload } = msg;
    if (!fromClientId) return;

    if (payload?.kind === 'viewer-mic') {
      await this._acceptViewerMic(fromClientId, type, payload);
      return;
    }

    const session = this.peers.get(fromClientId);
    if (type === 'answer' && session && payload?.sdp) {
      await session.acceptAnswer(payload.sdp);
      return;
    }
    if (type === 'ice' && session && payload?.candidate) {
      await session.addIce(payload.candidate);
    }
  }

  async _acceptViewerMic(fromClientId, type, payload) {
    if (!this._viewerMicSessions) this._viewerMicSessions = new Map();

    if (type === 'offer' && payload?.sdp) {
      let session = this._viewerMicSessions.get(fromClientId);
      if (session) {
        try { session.pc.close(); } catch { /* ignore */ }
      }
      session = new PeerSession({
        peerId: fromClientId,
        onIce: (candidate) => {
          this.signaling.send({
            type: 'ice',
            toClientId: fromClientId,
            payload: {
              kind: 'viewer-mic',
              candidate: candidate.toJSON ? candidate.toJSON() : candidate,
            },
          });
        },
        onTrack: (ev) => this._playViewerMic(fromClientId, ev),
        onConnectionState: (state) => {
          if (state === 'failed' || state === 'closed') {
            this._stopViewerMic(fromClientId);
          }
        },
      });
      this._viewerMicSessions.set(fromClientId, session);
      const answer = await session.acceptOffer(payload.sdp);
      this.signaling.send({
        type: 'answer',
        toClientId: fromClientId,
        payload: { kind: 'viewer-mic', sdp: answer },
      });
      return;
    }

    const session = this._viewerMicSessions.get(fromClientId);
    if (type === 'ice' && session && payload?.candidate) {
      await session.addIce(payload.candidate);
    }
  }

  _playViewerMic(peerId, ev) {
    if (!this._viewerAudioMix) {
      this._viewerAudioMix = new MediaStream();
      this._viewerAudioEl = document.createElement('audio');
      this._viewerAudioEl.autoplay = true;
      this._viewerAudioEl.playsInline = true;
      this._viewerAudioEl.srcObject = this._viewerAudioMix;
      this._viewerAudioEl.style.display = 'none';
      document.body.appendChild(this._viewerAudioEl);
    }
    const track = ev.track;
    if (track && !this._viewerAudioMix.getTracks().includes(track)) {
      this._viewerAudioMix.addTrack(track);
    }
    this._viewerAudioEl?.play?.().catch(() => {});
  }

  _stopViewerMic(peerId) {
    const s = this._viewerMicSessions?.get(peerId);
    if (!s) return;
    try { s.pc.close(); } catch { /* ignore */ }
    this._viewerMicSessions.delete(peerId);
  }

  stopCaptureOnly() {
    if (this._viewerMicSessions) {
      for (const id of [...this._viewerMicSessions.keys()]) {
        this._stopViewerMic(id);
      }
    }
    if (this._viewerAudioEl) {
      try {
        this._viewerAudioEl.pause();
        this._viewerAudioEl.srcObject = null;
        this._viewerAudioEl.remove();
      } catch { /* ignore */ }
      this._viewerAudioEl = null;
      this._viewerAudioMix = null;
    }
    [...this.peers.keys()].forEach((id) => this._closePeer(id));
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.localStream = null;
    }
    this._tabAudioTracks = [];
    this._micTracks = [];
    this.active = false;
    this.kinds = [];
  }

  stop() {
    this.stopCaptureOnly();
    this._emitStatus();
  }

  dispose() {
    this.stop();
    this._unsubSignal?.();
    this._unsubJoined?.();
    this._unsubLeft?.();
  }
}
