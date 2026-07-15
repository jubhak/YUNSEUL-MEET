import { PeerSession } from './peer-session.js?v=20260715ap';

/**
 * 참가자: 호스트 display 수신 + (선택) 마이크 업링크
 */
export class ViewerSubscriber {
  /**
   * @param {{
   *   signaling: import('./signaling.js').WebrtcSignaling,
   *   videoEl: HTMLVideoElement,
   *   onStatus?: (s: object) => void,
   * }} opts
   */
  constructor({ signaling, videoEl, onStatus }) {
    this.signaling = signaling;
    this.videoEl = videoEl;
    this.onStatus = onStatus || (() => {});
    /** @type {Map<string, PeerSession>} */
    this.peers = new Map();
    /** @type {MediaStream|null} */
    this.remoteStream = null;
    this._accepting = new Set();
    this._watching = false;
    this.hostPeerId = null;

    this.speakerOn = false;
    this.micOn = false;
    /** @type {PeerSession|null} */
    this._micSession = null;
    /** @type {MediaStream|null} */
    this._micStream = null;
    this._audioUnlocked = false;

    this._unsubSignal = signaling.onSignal((msg) => this._onSignal(msg));
    this._unsubStatus = signaling.onStreamStatus((msg) => {
      if (!msg.active) {
        this._watching = false;
        this.clearRemote();
        this.onStatus({ streamActive: false, streamEnded: true, playing: false });
        return;
      }
      if (this._watching && this.hasLiveVideo()) {
        this.onStatus({ streamActive: true, playing: true });
        return;
      }
      this.onStatus({ streamActive: true, kinds: msg.kinds || [] });
    });
  }

  clearRemote() {
    [...this.peers.keys()].forEach((id) => this._closePeer(id));
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    this.remoteStream = null;
    this._watching = false;
    this._audioUnlocked = false;
  }

  hasLiveVideo() {
    const tracks = this.remoteStream?.getVideoTracks?.() || [];
    return tracks.some((t) => t && t.readyState === 'live');
  }

  setSpeakerEnabled(on) {
    this.speakerOn = !!on;
    const video = this.videoEl;
    if (!video) return;
    if (this.speakerOn) {
      this.unlockAudio();
    } else {
      video.muted = true;
    }
  }

  unlockAudio() {
    const video = this.videoEl;
    if (!video || !this.speakerOn) return Promise.resolve(false);
    if (!video.srcObject) return Promise.resolve(false);
    if (this._unlocking) return Promise.resolve(this._audioUnlocked);
    this._unlocking = true;
    video.muted = false;
    video.volume = 1;
    return video.play().then(() => {
      this._audioUnlocked = true;
      this._unlocking = false;
      this.onStatus({ needUnmute: false });
      return true;
    }).catch(() => {
      // 소리만 막힌 경우 — 음소거로 되돌려 영상 재생은 유지
      this._audioUnlocked = false;
      this._unlocking = false;
      video.muted = true;
      video.play().catch(() => {});
      this.onStatus({ needUnmute: true });
      return false;
    });
  }

  async setMicEnabled(on) {
    this.micOn = !!on;
    if (!this.micOn) {
      await this._stopMicUplink();
      return true;
    }
    return this._startMicUplink();
  }

  async _startMicUplink() {
    if (!this.hostPeerId) {
      console.warn('[ViewerSubscriber] hostPeerId 없음');
      return false;
    }
    try {
      if (!this._micStream) {
        this._micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      }
      this._micStream.getAudioTracks().forEach((t) => { t.enabled = true; });

      this._closeMicSession();
      const hostId = this.hostPeerId;
      const session = new PeerSession({
        peerId: `${hostId}#mic`,
        onIce: (candidate) => {
          this.signaling.send({
            type: 'ice',
            toClientId: hostId,
            payload: {
              candidate: candidate.toJSON ? candidate.toJSON() : candidate,
              kind: 'viewer-mic',
            },
          });
        },
        onConnectionState: (state) => {
          if (session._intentionalClose) return;
          if (state === 'failed' || state === 'closed') this._closeMicSession();
        },
      });
      this._micSession = session;
      this._micStream.getTracks().forEach((t) => session.addTrack(t, this._micStream));
      const offer = await session.createOffer();
      this.signaling.send({
        type: 'offer',
        toClientId: hostId,
        payload: { sdp: offer, kind: 'viewer-mic' },
      });
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] mic failed', err);
      this.micOn = false;
      await this._stopMicUplink();
      return false;
    }
  }

  async _stopMicUplink() {
    if (this._micStream) {
      this._micStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this._micStream = null;
    }
    if (this._micSession && this.hostPeerId) {
      this.signaling.send({
        type: 'bye',
        toClientId: this.hostPeerId,
        payload: { kind: 'viewer-mic' },
      });
    }
    this._closeMicSession();
  }

  _closeMicSession() {
    if (!this._micSession) return;
    this._micSession._intentionalClose = true;
    try { this._micSession.pc.close(); } catch { /* ignore */ }
    this._micSession = null;
  }

  _notifyIfStreamDead() {
    if (this._accepting.size) return;
    if (this.hasLiveVideo()) return;
    this._watching = false;
    this.clearRemote();
    this.onStatus({ streamActive: false, streamEnded: true, playing: false });
  }

  async _onSignal(msg) {
    const { type, fromClientId, payload } = msg;
    if (!fromClientId) return;

    // 마이크 업링크 전용 시그널 — 화면 수신과 분리
    if (payload?.kind === 'viewer-mic') {
      if (!this._micSession) return;
      if (type === 'answer' && payload?.sdp) {
        await this._micSession.acceptAnswer(payload.sdp);
        return;
      }
      if (type === 'ice' && payload?.candidate) {
        await this._micSession.addIce(payload.candidate);
        return;
      }
      return;
    }

    if (type === 'offer' && payload?.sdp) {
      await this._acceptOffer(fromClientId, payload.sdp);
      return;
    }

    const session = this.peers.get(fromClientId);
    if (type === 'ice' && session && payload?.candidate) {
      await session.addIce(payload.candidate);
      return;
    }
    if (type === 'bye') {
      this._closePeer(fromClientId);
      this._notifyIfStreamDead();
    }
  }

  async _acceptOffer(peerId, sdp) {
    // 호스트 force 재연결로 offer가 연달아 오면 최신만 처리
    this._pendingOffer = { peerId, sdp };
    if (this._accepting.has(peerId)) return;
    this._accepting.add(peerId);
    this.hostPeerId = peerId;
    try {
      while (this._pendingOffer?.peerId === peerId) {
        const { sdp: nextSdp } = this._pendingOffer;
        this._pendingOffer = null;
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
          onTrack: (ev) => this._onTrack(ev),
          onConnectionState: (state) => {
            if (session._intentionalClose) return;
            if (state === 'failed') {
              this._closePeer(peerId);
              this._notifyIfStreamDead();
            }
          },
        });

        this.peers.set(peerId, session);
        const answer = await session.acceptOffer(nextSdp);
        this.signaling.send({
          type: 'answer',
          toClientId: peerId,
          payload: { sdp: answer },
        });
      }
    } finally {
      this._accepting.delete(peerId);
    }
  }

  _onTrack(ev) {
    if (ev.streams?.[0]) {
      this.remoteStream = ev.streams[0];
    } else {
      if (!this.remoteStream) this.remoteStream = new MediaStream();
      if (ev.track && !this.remoteStream.getTracks().includes(ev.track)) {
        try { this.remoteStream.addTrack(ev.track); } catch { /* ignore */ }
      }
    }

    if (ev.track) {
      ev.track.addEventListener('ended', () => {
        if (this._accepting.size) return;
        this._notifyIfStreamDead();
      });
    }

    const video = this.videoEl;
    if (!video) return;

    video.srcObject = this.remoteStream;
    video.playsInline = true;

    // 영상이 오면 즉시 시청 UI — 소리는 별도 unlock
    if (this.hasLiveVideo()) {
      this._watching = true;
      this.onStatus({ streamActive: true, playing: true });
    } else {
      this.onStatus({ streamActive: true });
      return;
    }

    // 자동재생: mute로 영상만. 소리는 스피커 버튼(제스처)에서 unlock
    video.muted = true;
    video.play().then(() => {
      this.onStatus({ streamActive: true, playing: true });
      if (this.speakerOn && !this._audioUnlocked) this.unlockAudio();
    }).catch(() => {
      this.onStatus({ streamActive: true, playing: true });
    });
  }

  _closePeer(peerId) {
    const s = this.peers.get(peerId);
    if (!s) return;
    s._intentionalClose = true;
    try { s.pc.close(); } catch { /* ignore */ }
    this.peers.delete(peerId);
  }

  dispose() {
    this._stopMicUplink().catch(() => {});
    this.clearRemote();
    this._unsubSignal?.();
    this._unsubStatus?.();
  }
}
