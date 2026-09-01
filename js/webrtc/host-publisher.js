import { TRACK_KIND } from './config.js';
import { SfuClient } from './sfu-client.js?v=20260826sfu23';

/**
 * Host -> SFU display share (+ optional tab audio / mic).
 * 참가자 화면은 SFU로 수신 후 host video producer.replaceTrack 으로 전원에 중계.
 */
export class HostPublisher {
  /**
   * @param {{ signaling: import('./signaling.js').WebrtcSignaling, onStatus?: (s: object) => void }} opts
   */
  constructor({ signaling, onStatus }) {
    this.signaling = signaling;
    this.onStatus = onStatus || (() => {});
    /** @type {MediaStream|null} */
    this.localStream = null;
    this.active = false;
    this.kinds = [];
    /** bidirectional | unidirectional */
    this.interactionMode = 'bidirectional';
    /** @type {MediaStreamTrack[]} */
    this._tabAudioTracks = [];
    /** @type {MediaStreamTrack[]} */
    this._micTracks = [];
    this.tabAudioWanted = true;
    this.micWanted = false;
    this._audioShareMissing = false;
    /** @type {MediaStream|null} */
    this._ownStream = null;
    /** @type {MediaStream|null} */
    this._relayStream = null;
    this._relayPeerId = null;
    /** @type {SfuClient|null} */
    this.sfu = null;
    /** @type {Map<string, MediaStream>} */
    this._viewerDisplayStreams = new Map();
    /** @type {HTMLAudioElement|null} */
    this._viewerAudioEl = null;
    /** @type {MediaStream|null} */
    this._viewerAudioMix = null;
    /** @type {((info: { peerId: string|null, active: boolean, stream?: MediaStream|null }) => void)|null} */
    this.onRelayChange = null;

    this._unsubLeft = signaling.onPeerLeft((msg) => this._onPeerLeft(msg));
  }

  get relayPeerId() {
    return this._relayPeerId;
  }

  get isRelaying() {
    return !!this._relayPeerId && !!this._relayStream;
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

  async _ensureSfu() {
    if (this.sfu && !this.sfu._closed) return this.sfu;
    this.sfu = new SfuClient({
      socket: this.signaling.socket,
      clientId: this.signaling.localClientId,
      role: 'host',
    });
    this.sfu.consumeFilter = (info) => {
      if (this.interactionMode === 'unidirectional') return false;
      const source = info?.appData?.source || '';
      return source === 'viewer-display' || source === 'viewer-mic';
    };
    this.sfu.onConsumed = (info, consumer) => this._onRemoteConsumed(info, consumer);
    this.sfu.onProducerClosed = (msg) => this._onRemoteProducerClosed(msg);
    await this.sfu.init();
    return this.sfu;
  }

  async _ensureSfuRecv() {
    const sfu = await this._ensureSfu();
    if (!sfu.recvTransport || sfu.recvTransport.closed) {
      await sfu.ensureRecvTransport();
      await sfu.consumeExistingProducers();
    }
    return sfu;
  }

  _onRemoteConsumed(info, consumer) {
    const source = info?.appData?.source || '';
    const clientId = info?.clientId || info?.appData?.clientId;
    if (!clientId || clientId === this.signaling.localClientId) return;

    if (source === 'viewer-display' || (consumer.kind === 'video' && info?.role === 'viewer')) {
      let ms = this._viewerDisplayStreams.get(clientId);
      if (!ms) {
        ms = new MediaStream();
        this._viewerDisplayStreams.set(clientId, ms);
      }
      if (consumer.track && !ms.getTracks().includes(consumer.track)) {
        ms.addTrack(consumer.track);
      }
      if (ms.getVideoTracks().length) {
        this.switchToRelay(clientId, ms).catch((err) => {
          console.warn('[HostPublisher] relay', err);
        });
      }
      return;
    }

    if (source === 'viewer-mic' || (consumer.kind === 'audio' && info?.role === 'viewer' && source !== 'display')) {
      this._playViewerMic(clientId, consumer.track);
    }
  }

  _onRemoteProducerClosed(msg) {
    const clientId = msg?.clientId;
    if (clientId && this._relayPeerId === clientId) {
      this.restoreOwnDisplay().catch(() => {});
    }
    if (clientId) {
      this._viewerDisplayStreams.delete(clientId);
    }
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
    this._audioShareMissing = false;

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 24, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        displaySurface: 'monitor',
      },
      audio: withTabAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
          }
        : false,
      preferCurrentTab: false,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      systemAudio: withTabAudio ? 'include' : 'exclude',
    });

    this.kinds = [TRACK_KIND.DISPLAY];
    this._tabAudioTracks = stream.getAudioTracks().slice();
    if (this._tabAudioTracks.length) {
      this.kinds.push('tab-audio');
      this._tabAudioTracks.forEach((t) => {
        t.enabled = !!withTabAudio;
        try { t.contentHint = 'music'; } catch { /* ignore */ }
      });
      this._audioShareMissing = false;
    } else if (withTabAudio) {
      console.warn('[HostPublisher] no display audio track — share audio unchecked?');
      this._audioShareMissing = true;
    }

    this.localStream = stream;
    this._ownStream = stream;
    this._relayStream = null;
    this._relayPeerId = null;
    this.active = true;

    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = 'detail'; } catch { /* ignore */ }
    }
    const surface = vt?.getSettings?.()?.displaySurface || '';
    if (surface === 'browser') {
      const root = document.getElementById('capture-root')
        || document.querySelector('.stage-area');
      await this._cropToCaptureRoot(stream, root);
    }

    if (withMic) {
      await this.ensureMic(true);
    }

    if (vt) {
      vt.addEventListener('ended', () => {
        this.stop();
      });
    }

    await this._publishToSfu();
    this._ensureSfuRecv().catch((err) => {
      console.warn('[HostPublisher] sfu recv', err);
    });
    this._emitStatus();
    return stream;
  }

  async _publishToSfu() {
    const sfu = await this._ensureSfu();
    const video =
      this._relayStream?.getVideoTracks()?.[0]
      || this._ownStream?.getVideoTracks()?.[0]
      || this.localStream?.getVideoTracks()?.[0];

    if (video && video.readyState === 'live') {
      await sfu.publishStream(new MediaStream([video]), {
        source: 'display',
        trackKind: TRACK_KIND.DISPLAY,
      });
    } else {
      throw new Error('화면 비디오 트랙이 없습니다. 공유를 다시 시작해 주세요.');
    }

    const tabTracks = (this._relayStream
      ? this._relayStream.getAudioTracks()
      : this._tabAudioTracks
    ).filter((t) => t?.readyState === 'live');
    if (tabTracks.length) {
      try {
        await sfu.publishStream(new MediaStream(tabTracks), {
          source: 'tab-audio',
          trackKind: 'tab-audio',
        });
      } catch (err) {
        console.warn('[HostPublisher] tab-audio produce', err);
      }
    }

    const micTracks = this._micTracks.filter((t) => t?.readyState === 'live');
    if (micTracks.length) {
      try {
        this.signaling?.socket?.emit?.('client-diag', {
          kind: 'host-mic',
          event: 'produce',
          enabled: micTracks.map((t) => t.enabled),
          muted: micTracks.map((t) => t.muted),
          readyState: micTracks.map((t) => t.readyState),
        });
        await sfu.publishStream(new MediaStream(micTracks), {
          source: 'mic',
          trackKind: TRACK_KIND.MIC,
        });
      } catch (err) {
        console.warn('[HostPublisher] mic produce', err);
      }
    }
  }

  async _cropToCaptureRoot(stream, el) {
    if (!el) return;
    const track = stream.getVideoTracks()[0];
    if (!track || typeof track.cropTo !== 'function') return;
    if (typeof CropTarget === 'undefined' || !CropTarget.fromElement) return;
    if ((el.clientWidth || 0) < 8 || (el.clientHeight || 0) < 8) {
      console.warn('[HostPublisher] crop skipped: capture root has no size');
      return;
    }
    try {
      const target = await CropTarget.fromElement(el);
      await track.cropTo(target);
    } catch (err) {
      console.warn('[HostPublisher] crop skipped', err);
    }
  }

  async ensureMic(enabled = true) {
    if (!this.localStream && !this.active) return false;
    if (this.hasMic) {
      this.setMicEnabled(enabled);
      return true;
    }
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      const rawTrack = raw.getAudioTracks()[0];
      if (!rawTrack) return false;

      // 참가자와 동일: 원본 mic 트랙 그대로 produce (WebAudio 가공 트랙은 무음 송출됨)
      rawTrack.enabled = !!enabled;
      try { rawTrack.contentHint = 'speech'; } catch { /* ignore */ }
      this._micTracks = [rawTrack];
      if (this.localStream && !this.localStream.getAudioTracks().includes(rawTrack)) {
        try { this.localStream.addTrack(rawTrack); } catch { /* ignore */ }
      }
      if (!this.kinds.includes(TRACK_KIND.MIC)) this.kinds.push(TRACK_KIND.MIC);
      this.micWanted = !!enabled;
      if (this.active) {
        try {
          const sfu = await this._ensureSfu();
          await sfu.publishStream(new MediaStream([rawTrack]), {
            source: 'mic',
            trackKind: TRACK_KIND.MIC,
          });
        } catch (err) {
          console.warn('[HostPublisher] mic produce', err);
        }
      }
      this._startHostMicLevelWatch(rawTrack);
      this._emitStatus();
      return true;
    } catch (err) {
      console.warn('[HostPublisher] mic failed', err);
      return false;
    }
  }

  setTabAudioEnabled(on) {
    this.tabAudioWanted = !!on;
    this._syncTabAudioForFeedback();
    this._emitStatus();
  }

  setMicEnabled(on) {
    this.micWanted = !!on;
    this._micTracks.forEach((t) => {
      if (t) t.enabled = !!on;
    });
    this._emitStatus();
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
      audioShareMissing: !!this._audioShareMissing,
      relaying: this.isRelaying,
      relayPeerId: this._relayPeerId,
    });
  }

  /** SFU는 참가자가 직접 consume — peer 목록은 무시하되 ensure publish */
  async publishTo(_peerIds = []) {
    if (!this.localStream) return;
    await this._publishToSfu();
  }

  _buildOutboundStream() {
    const ms = new MediaStream();
    const video =
      this._relayStream?.getVideoTracks()?.[0]
      || this._ownStream?.getVideoTracks()?.[0]
      || this.localStream?.getVideoTracks()?.[0];
    if (video) ms.addTrack(video);
    if (this._relayStream) {
      this._relayStream.getAudioTracks().forEach((t) => {
        if (t?.readyState === 'live') ms.addTrack(t);
      });
    } else {
      this._tabAudioTracks.forEach((t) => {
        if (t?.readyState === 'live') ms.addTrack(t);
      });
    }
    this._micTracks.forEach((t) => {
      if (t?.readyState === 'live') ms.addTrack(t);
    });
    return ms;
  }

  async _replaceOutboundVideo(track) {
    if (!this.sfu) return;
    try {
      await this.sfu.replaceVideoTrack(track || null);
    } catch (err) {
      console.warn('[HostPublisher] replace video', err);
      await this._publishToSfu();
    }
  }

  /**
   * @param {string} peerId
   * @param {MediaStream} stream
   */
  async switchToRelay(peerId, stream) {
    if (!stream || !peerId) return;
    this._relayPeerId = peerId;
    this._relayStream = stream;
    this.localStream = this._buildOutboundStream();
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      vt.addEventListener('ended', () => {
        if (this._relayPeerId === peerId) {
          this.restoreOwnDisplay().catch(() => {});
        }
      });
      await this._replaceOutboundVideo(vt);
    }
    this.onRelayChange?.({ peerId, active: true, stream });
    this._emitStatus();
  }

  async restoreOwnDisplay() {
    this._relayPeerId = null;
    this._relayStream = null;
    if (!this._ownStream) {
      this.onRelayChange?.({ peerId: null, active: false, stream: null });
      this._emitStatus();
      return;
    }
    this.localStream = this._buildOutboundStream();
    const vt = this._ownStream.getVideoTracks()[0];
    if (vt) await this._replaceOutboundVideo(vt);
    this.onRelayChange?.({ peerId: null, active: false, stream: null });
    this._emitStatus();
  }

  _onPeerLeft(msg) {
    const id = msg?.clientId;
    if (!id) return;
    this._viewerDisplayStreams.delete(id);
    if (this._relayPeerId === id) {
      this.restoreOwnDisplay().catch(() => {});
    }
  }

  _playViewerMic(_peerId, track) {
    if (!track) return;
    if (!this._viewerAudioMix) {
      this._viewerAudioMix = new MediaStream();
      this._viewerAudioEl = document.createElement('audio');
      this._viewerAudioEl.autoplay = true;
      this._viewerAudioEl.setAttribute('playsinline', '');
      this._viewerAudioEl.playsInline = true;
      this._viewerAudioEl.muted = false;
      this._viewerAudioEl.volume = 1;
      this._viewerAudioEl.srcObject = this._viewerAudioMix;
      // display:none 금지 — 일부 환경 무음. 시스템소리 재캡처 루프 완화를 위해 볼륨은 유지하되
      // 탭 오디오(시스템 소리) 송출은 끈다.
      this._viewerAudioEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
      document.body.appendChild(this._viewerAudioEl);
      if (!this._viewerAudioUnlockBound) {
        this._viewerAudioUnlockBound = true;
        const unlock = () => {
          const el = this._viewerAudioEl;
          if (!el) return;
          el.muted = false;
          el.play().catch(() => {});
        };
        window.addEventListener('pointerdown', unlock, { capture: true });
        window.addEventListener('keydown', unlock, { capture: true });
      }
    }
    if (!this._viewerAudioMix.getTracks().includes(track)) {
      this._viewerAudioMix.addTrack(track);
      track.addEventListener('ended', () => {
        try { this._viewerAudioMix?.removeTrack(track); } catch { /* ignore */ }
        this._syncTabAudioForFeedback();
      });
    }
    this._viewerAudioEl.srcObject = this._viewerAudioMix;
    this._viewerAudioEl.play().then(() => {
      this._viewerMicPlaying = true;
      this._syncTabAudioForFeedback();
    }).catch(() => {
      this._viewerMicPlaying = false;
      console.warn('[HostPublisher] 참가자 마이크 재생이 차단됨 — 화면을 한 번 클릭해 주세요');
    });
  }

  /**
   * 참가자 마이크를 호스트 스피커로 재생하면, 화면공유「시스템 소리」에 다시 실려
   * 모바일에서 자기 목소리 무한 반복이 난다 → 그때는 탭/시스템 오디오 송출을 끈다.
   * 호스트 목소리는 mic producer로 별도 전송.
   */
  _syncTabAudioForFeedback() {
    const liveViewerMic = (this._viewerAudioMix?.getAudioTracks() || [])
      .some((t) => t && t.readyState === 'live');
    const shouldMuteTab = liveViewerMic;
    this._tabAudioTracks.forEach((t) => {
      if (!t) return;
      // 사용자가 탭소리 OFF면 그대로 유지
      if (!this.tabAudioWanted) {
        t.enabled = false;
        return;
      }
      t.enabled = !shouldMuteTab;
    });
    if (shouldMuteTab) {
      this.signaling?.socket?.emit?.('client-diag', {
        kind: 'host-audio',
        event: 'tab-audio-ducked',
        reason: 'viewer-mic-feedback-guard',
      });
    }
  }

  _startHostMicLevelWatch(track) {
    if (!track || this._hostMicLevelTimer) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this._hostAudioCtx) this._hostAudioCtx = new AC();
      const clone = track.clone();
      const src = this._hostAudioCtx.createMediaStreamSource(new MediaStream([clone]));
      const analyser = this._hostAudioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      this._hostMicLevelTimer = setInterval(() => {
        if (this._hostAudioCtx.state === 'suspended') {
          this._hostAudioCtx.resume().catch(() => {});
        }
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        if (!this._hostMicLastReport || Date.now() - this._hostMicLastReport > 3000) {
          this._hostMicLastReport = Date.now();
          this.signaling?.socket?.emit?.('client-diag', {
            kind: 'host-mic',
            event: rms > 0.02 ? 'level-hot' : 'level-silent',
            detail: `rms=${rms.toFixed(4)}`,
            enabled: track.enabled,
            muted: track.muted,
          });
        }
      }, 500);
    } catch (err) {
      console.warn('[HostPublisher] mic level', err);
    }
  }

  stopCaptureOnly() {
    if (this._hostMicLevelTimer) {
      clearInterval(this._hostMicLevelTimer);
      this._hostMicLevelTimer = null;
    }
    if (this._micPipeline) {
      try { this._micPipeline.close(); } catch { /* ignore */ }
      this._micPipeline = null;
    }
    this._relayPeerId = null;
    this._relayStream = null;
    this._viewerDisplayStreams.clear();
    this.onRelayChange?.({ peerId: null, active: false, stream: null });

    if (this._viewerAudioEl) {
      try {
        this._viewerAudioEl.pause();
        this._viewerAudioEl.srcObject = null;
        this._viewerAudioEl.remove();
      } catch { /* ignore */ }
      this._viewerAudioEl = null;
      this._viewerAudioMix = null;
    }

    if (this.sfu) {
      try { this.sfu.stopPublishing(); } catch { /* ignore */ }
      try { this.sfu.dispose(); } catch { /* ignore */ }
      this.sfu = null;
    }

    if (this._ownStream) {
      this._ownStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    } else if (this.localStream) {
      this.localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this.localStream = null;
    this._ownStream = null;
    this._tabAudioTracks = [];
    this._micTracks = [];
    this.active = false;
    this.kinds = [];
    this._audioShareMissing = false;
  }

  stop() {
    this.stopCaptureOnly();
    this._emitStatus();
  }

  dispose() {
    this.stop();
    this._unsubLeft?.();
  }
}
