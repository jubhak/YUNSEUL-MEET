import { TRACK_KIND } from './config.js';
import { SfuClient } from './sfu-client.js?v=20260919freeze1';
import { VirtualAvatarManager } from '../virtual-avatar-manager.js?v=20260923priv3';

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
    /** @type {Map<string, HTMLAudioElement>} */
    this._remoteAudioEls = new Map();
    this._viewerAudioUnlockBound = false;
    this.onAudioPlaybackState = null;
    this._ensureGlobalAudioUnlock();
    /** @type {((info: { peerId: string|null, active: boolean, stream?: MediaStream|null }) => void)|null} */
    this.onRelayChange = null;
    this.avatarManager = new VirtualAvatarManager({ width: 640, height: 360 });
    this.rawCameraStream = null;
    /** @type {MediaStream|null} */
    this.cameraStream = null;
    this.cameraWanted = false;
    /** @type {((info: { active: boolean, stream?: MediaStream|null }) => void)|null} */
    this.onCameraChange = null;
    /** @type {((info: { clientId: string, stream: MediaStream, role?: string }) => void)|null} */
    this.onRemoteCamera = null;
    /** @type {((clientId: string) => void)|null} */
    this.onRemoteCameraClosed = null;
    /** @type {((track: MediaStreamTrack|null) => void)|null} */
    this.onMicTrack = null;
    /** @type {((info: { clientId: string, track: MediaStreamTrack }) => void)|null} */
    this.onRemoteAudioTrack = null;
    /** @type {((clientId: string) => void)|null} */
    this.onRemoteAudioTrackClosed = null;
    /** @type {((data: { pingMs: number, lossRate: number, quality: string }) => void)|null} */
    this.onNetworkQuality = null;

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

  get hasCamera() {
    return !!this.cameraStream && this.cameraStream.getVideoTracks().some((t) => t && t.readyState === 'live');
  }

  get cameraEnabled() {
    return this.hasCamera && this.cameraStream.getVideoTracks().some((t) => t.enabled);
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
      const kind = info?.kind || '';
      const role = info?.role || '';
      if (source === 'viewer-display' || source === 'viewer-mic' || source === 'viewer-camera') return true;
      if (role === 'viewer' && (kind === 'audio' || kind === 'video')) return true;
      return false;
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
      sfu.startNetworkStatsMonitor((data) => {
        this.onNetworkQuality?.(data);
      });
    }
    return sfu;
  }

  async ensureReceiving() {
    return await this._ensureSfuRecv();
  }

  _onRemoteConsumed(info, consumer) {
    const source = info?.appData?.source || '';
    const clientId = info?.clientId || info?.appData?.clientId;
    if (!clientId || clientId === this.signaling.localClientId) return;

    if (source === 'viewer-camera' || info?.appData?.trackKind === 'camera') {
      const ms = new MediaStream([consumer.track]);
      this.onRemoteCamera?.({ clientId, stream: ms, role: 'viewer' });
      consumer.track.addEventListener('ended', () => {
        this.onRemoteCameraClosed?.(clientId);
      });
      return;
    }

    if (source === 'viewer-display') {
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
      this.onRemoteCameraClosed?.(clientId);
      if (this._remoteAudioEls) {
        for (const [key, el] of [...this._remoteAudioEls.entries()]) {
          if (key.startsWith(`${clientId}:`)) {
            this._cleanupViewerAudio(key, clientId);
          }
        }
      }
      this.onRemoteAudioTrackClosed?.(clientId);
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
      // 'motion'으로 설정하여 정지 화면(슬라이드)에서도 0 fps로 떨어지지 않고 꾸준히 프레임을 송출하도록 보장
      try { vt.contentHint = 'motion'; } catch { /* ignore */ }
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
    this._startAutoRepair();
    this._emitStatus();
    return stream;
  }

  /**
   * 모바일 등 화면공유 미지원 환경용 — 카메라(+선택 마이크) 송출
   * @param {{ withMic?: boolean, facingMode?: 'user' | 'environment' }} opts
   */
  async startCameraCapture({ withMic = true, facingMode = 'environment' } = {}) {
    if (this.localStream) this.stopCaptureOnly();

    this.tabAudioWanted = false;
    this.micWanted = !!withMic;
    this._tabAudioTracks = [];
    this._micTracks = [];
    this._audioShareMissing = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 기기/브라우저에서는 카메라 송출을 지원하지 않습니다.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: false,
    });

    this.kinds = [TRACK_KIND.DISPLAY];
    this.localStream = stream;
    this._ownStream = stream;
    this._relayStream = null;
    this._relayPeerId = null;
    this.active = true;

    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = 'motion'; } catch { /* ignore */ }
      vt.addEventListener('ended', () => {
        this.stop();
      });
    }

    if (withMic) {
      await this.ensureMic(true);
    }

    await this._publishToSfu();
    this._ensureSfuRecv().catch((err) => {
      console.warn('[HostPublisher] sfu recv', err);
    });
    this._startAutoRepair();
    this._emitStatus();
    return stream;
  }

  _startAutoRepair() {
    if (this._autoRepairTimer) return;
    this._autoRepairTimer = setInterval(async () => {
      if (!this.active || !this.localStream) return;
      const vt = this.localStream.getVideoTracks()[0];
      if (!vt || vt.readyState !== 'live') return;

      const hasProducer = this.sfu?.getProducerByKind('video');
      if (!this.sfu || this.sfu._closed || !hasProducer) {
        console.log('[HostPublisher] 3차 안전망: SFU 송출 자동 자가 치유(Auto-Repair) 진행...');
        try {
          await this._publishToSfu();
          this._emitStatus();
        } catch (err) {
          console.warn('[HostPublisher] auto-repair error:', err);
        }
      }
    }, 4000);
  }

  async ensurePublished() {
    if (!this.active || !this.localStream) return;
    try {
      await this._publishToSfu();
      this._emitStatus();
    } catch (err) {
      console.warn('[HostPublisher] ensurePublished error:', err);
    }
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

    if (this.cameraWanted && this.cameraStream) {
      const camTracks = this.cameraStream.getVideoTracks().filter((t) => t?.readyState === 'live');
      if (camTracks.length) {
        try {
          await sfu.publishStream(new MediaStream(camTracks), {
            source: 'camera',
            trackKind: TRACK_KIND.CAMERA,
          });
        } catch (err) {
          console.warn('[HostPublisher] camera produce', err);
        }
      }
    }
  }

  async ensureCamera(wanted = true) {
    this.cameraWanted = !!wanted;
    if (!wanted) {
      this.stopCamera();
      return false;
    }
    if (this.hasCamera) {
      this.cameraStream.getVideoTracks().forEach((t) => { t.enabled = true; });
      this.onCameraChange?.({ active: true, stream: this.cameraStream });
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[HostPublisher] getUserMedia 미지원 환경, 가상 얼굴(아바타)로 전환');
      return await this.startVirtualCamera();
    }
    try {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
      } catch (camErr) {
        console.warn('[HostPublisher] 실물 웹캠 시작 불가(장치 없음/점유 중 등) → 가상 얼굴(아바타)로 자동 대체:', camErr);
        return await this.startVirtualCamera();
      }

      this.rawCameraStream = stream;
      this.avatarManager.setWebcamStream(stream);
      if (this.hasMic && this._micTracks?.[0]) {
        this.avatarManager.attachMicTrack(this._micTracks[0]);
      }
      if (this.avatarManager.activeSwapFace && this.avatarManager.activeSwapFace !== 'none' && this.avatarManager.activeSwapFace !== 'real') {
        this.avatarManager.setMode('swap');
      } else {
        this.avatarManager.setMode('real');
      }
      const outgoingStream = this.avatarManager.getOutputStream();
      this.cameraStream = outgoingStream;

      const vt = stream.getVideoTracks()[0];
      if (vt) {
        vt.addEventListener('ended', () => {
          this.stopCamera();
        });
      }

      // SFU가 이미 준비되어 있다면 송출
      if (this.sfu && this.sfu.sendTransport) {
        try {
          await this.sfu.publishStream(outgoingStream, {
            source: 'camera',
            trackKind: TRACK_KIND.CAMERA,
          });
        } catch (err) {
          console.warn('[HostPublisher] publish camera failed:', err);
        }
      }
      this.onCameraChange?.({ active: true, stream: outgoingStream });
      return true;
    } catch (err) {
      console.warn('[HostPublisher] ensureCamera failed, falling back to virtual avatar:', err);
      try {
        return await this.startVirtualCamera();
      } catch (virtErr) {
        this.cameraWanted = false;
        this.cameraStream = null;
        this.onCameraChange?.({ active: false, stream: null });
        return false;
      }
    }
  }

  async startVirtualCamera() {
    this.cameraWanted = true;
    if (this.rawCameraStream) {
      this.rawCameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.rawCameraStream = null;
    }
    try {
      this.avatarManager.setWebcamStream(null);
      this.avatarManager.setMode('virtual');
      if (this.hasMic && this._micTracks?.[0]) {
        this.avatarManager.attachMicTrack(this._micTracks[0]);
      }
      const outgoingStream = this.avatarManager.getOutputStream();
      this.cameraStream = outgoingStream;

      if (this.sfu && this.sfu.sendTransport) {
        try {
          await this.sfu.publishStream(outgoingStream, {
            source: 'camera',
            trackKind: TRACK_KIND.CAMERA,
          });
        } catch (err) {
          console.warn('[HostPublisher] publish virtual camera failed:', err);
        }
      }
      this.onCameraChange?.({ active: true, stream: outgoingStream });
      return true;
    } catch (err) {
      console.warn('[HostPublisher] startVirtualCamera failed:', err);
      this.cameraWanted = false;
      this.cameraStream = null;
      this.onCameraChange?.({ active: false, stream: null });
      return false;
    }
  }

  stopCamera() {
    if (this.rawCameraStream) {
      this.rawCameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.rawCameraStream = null;
    }
    this.avatarManager?.setWebcamStream(null);
    this.cameraStream = null;
    this.cameraWanted = false;
    if (this.sfu) {
      this.sfu.stopPublishing({ source: 'camera' }).catch(() => {});
    }
    this.onCameraChange?.({ active: false, stream: null });
  }

  async toggleCamera() {
    const next = !this.cameraEnabled;
    return await this.ensureCamera(next);
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
      this.onMicTrack?.(rawTrack);
      this.avatarManager?.attachMicTrack(rawTrack);
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
    const activeMicTrack = on ? (this._micTracks[0] || null) : null;
    this.onMicTrack?.(activeMicTrack);
    this.avatarManager?.attachMicTrack(activeMicTrack);
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
    if (this._remoteAudioEls) {
      for (const [key, el] of [...this._remoteAudioEls.entries()]) {
        if (key.startsWith(`${id}:`)) {
          this._cleanupViewerAudio(key, id);
        }
      }
    }
    this.onRemoteAudioTrackClosed?.(id);
  }

  _ensureGlobalAudioUnlock() {
    if (this._viewerAudioUnlockBound || typeof window === 'undefined') return;
    this._viewerAudioUnlockBound = true;
    const unlock = () => {
      this.unlockAudio();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('touchstart', unlock, { capture: true, passive: true });
    window.addEventListener('click', unlock, { capture: true });
  }

  unlockAudio() {
    if (!this._remoteAudioEls) return;
    for (const el of this._remoteAudioEls.values()) {
      if (el) {
        el.muted = false;
        if (el.paused) {
          el.play().catch(() => {});
        }
      }
    }
  }

  _playViewerMic(_peerId, track) {
    if (!track) return;
    if (!this._remoteAudioEls) this._remoteAudioEls = new Map();
    this._ensureGlobalAudioUnlock();

    const key = `${_peerId || 'guest'}:${track.id}`;
    let el = this._remoteAudioEls.get(key);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.playsInline = true;
      el.muted = false;
      el.volume = 1;
      el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this._remoteAudioEls.set(key, el);
    } else {
      el.srcObject = new MediaStream([track]);
    }

    el.muted = false;
    el.play().then(() => {
      this._viewerMicPlaying = true;
      this._syncTabAudioForFeedback();
      this.onAudioPlaybackState?.({ ok: true, clientId: _peerId });
    }).catch((err) => {
      this._viewerMicPlaying = false;
      console.warn('[HostPublisher] 참가자 마이크 자동재생 차단됨 — 화면 클릭 시 재생됩니다:', err);
      this.onAudioPlaybackState?.({ ok: false, needUnmute: true, clientId: _peerId });
    });

    this.onRemoteAudioTrack?.({ clientId: _peerId, track });

    track.addEventListener('ended', () => {
      this._cleanupViewerAudio(key, _peerId);
    }, { once: true });
  }

  _cleanupViewerAudio(key, clientId) {
    const el = this._remoteAudioEls?.get(key);
    if (el) {
      try { el.pause(); } catch { /* ignore */ }
      el.srcObject = null;
      try { el.remove(); } catch { /* ignore */ }
      this._remoteAudioEls.delete(key);
    }
    if (clientId) {
      this.onRemoteAudioTrackClosed?.(clientId);
    }
    this._syncTabAudioForFeedback();
  }

  /**
   * 참가자 마이크를 호스트 스피커로 재생하면, 화면공유「시스템 소리」에 다시 실려
   * 모바일에서 자기 목소리 무한 반복이 난다 → 그때는 탭/시스템 오디오 송출을 끈다.
   * 호스트 목소리는 mic producer로 별도 전송.
   */
  _syncTabAudioForFeedback() {
    let liveViewerMic = false;
    if (this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) {
        const trk = el.srcObject?.getAudioTracks?.()[0];
        if (trk && trk.readyState === 'live') {
          liveViewerMic = true;
          break;
        }
      }
    }
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
    this.stopCamera();
    if (this._autoRepairTimer) {
      clearInterval(this._autoRepairTimer);
      this._autoRepairTimer = null;
    }
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

    if (this.sfu) {
      try { this.sfu.stopPublishing({ source: 'display' }); } catch { /* ignore */ }
      try { this.sfu.stopPublishing({ source: 'tab-audio' }); } catch { /* ignore */ }
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
    if (this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) {
        try { el.pause(); } catch { /* ignore */ }
        el.srcObject = null;
        try { el.remove(); } catch { /* ignore */ }
      }
      this._remoteAudioEls.clear();
    }
    if (this.sfu) {
      try { this.sfu.stopPublishing(); } catch { /* ignore */ }
      try { this.sfu.dispose(); } catch { /* ignore */ }
      this.sfu = null;
    }
  }
}
