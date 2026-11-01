import { TRACK_KIND } from './config.js';
import { SfuClient } from './sfu-client.js?v=20261006a';
import { VirtualAvatarManager, openWebcamFlexible, faceModeForRoomCount } from '../virtual-avatar-manager.js?v=20261101c';
import { FaceCompositor } from './face-compositor.js?v=20261016a';

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
    /** 단방향 발언권을 가진 참가자 clientId */
    this.voiceFloorId = null;
    /** 단방향 옵션: 모든 참가자 목소리 허용 */
    this.allowAllVoice = false;
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
    this.speakerOn = true;
    this._ensureGlobalAudioUnlock();
    /** @type {((info: { peerId: string|null, active: boolean, stream?: MediaStream|null }) => void)|null} */
    this.onRelayChange = null;
    this.avatarManager = new VirtualAvatarManager({ width: 640, height: 360, fps: 30 });
    this.avatarManager.swapRole = 'host';   // 호스트 본인의 딥페이크는 서버 용량 초과 거절 대상에서 제외
    // 참가자 식별자를 아바타 매니저로 전달 → 워커가 참가자별로 스왑 프레임을 분리
    try { this.avatarManager.setClientId?.(signaling?.localClientId || null); } catch { /* ignore */ }
    this._faceRoomCount = 1;
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

    /** 'face' | 'screen' | null — 시청자에게 보내는 화면 종류. 목소리는 모드와 무관하게 유지 */
    this.shareMode = null;
    /** 얼굴 화면 합성용 타일 목록 제공. host.js 가 그리드 video 를 넘긴다 */
    this.getFaceTiles = null;
    /** @type {((mode: 'face'|'screen'|null) => void)|null} */
    this.onShareModeChange = null;
    this._compositor = null;

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
    return !!this.cameraWanted && !!this.cameraStream && this.cameraStream.getVideoTracks().some((t) => t && t.readyState === 'live');
  }

  get cameraEnabled() {
    return !!this.cameraWanted && this.hasCamera && this.cameraStream.getVideoTracks().some((t) => t.enabled);
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
    // 동시 호출(수신 준비 + 마이크 + 얼굴 송출)이 각자 클라이언트를 만들거나 init 전의 클라이언트를 받지 않도록 한 번만 만든다.
    if (this._sfuInitPromise) return this._sfuInitPromise;
    this._sfuInitPromise = this._createSfu().finally(() => { this._sfuInitPromise = null; });
    return this._sfuInitPromise;
  }

  async _createSfu() {
    const sfu = new SfuClient({
      socket: this.signaling.socket,
      clientId: this.signaling.localClientId,
      role: 'host',
    });
    sfu.consumeFilter = (info) => {
      const source = info?.appData?.source || '';
      const kind = info?.kind || '';
      const role = info?.role || info?.appData?.role || '';
      // 단방향: 발언권을 받은 참가자의 마이크만 (서버가 그 1명만 송출을 허용한다)
      if (this.interactionMode === 'unidirectional') return kind === 'audio' && source === 'viewer-mic';
      // 얼굴/마이크만 기본 수신. viewer-display는 화면공유 릴레이용.
      if (source === 'viewer-camera' || source === 'viewer-mic' || source === 'viewer-display') return true;
      // appData.source 가 빠져도 참가자 목소리는 받아야 한다 (한 명이라도 놓치면 전원 무음처럼 들림)
      if (kind === 'audio' && role !== 'host') return true;
      return false;
    };
    sfu.onConsumed = (info, consumer) => this._onRemoteConsumed(info, consumer);
    sfu.onProducerClosed = (msg) => this._onRemoteProducerClosed(msg);
    try {
      await sfu.init();
    } catch (err) {
      try { sfu.dispose(); } catch { /* ignore */ }
      throw err;
    }
    this.sfu = sfu;
    // 카메라 송신 정지 감시 + 단계적 자동 복구(ICE 재시작 → producer 재생성 → 트랜스포트 재생성)
    sfu.startSenderMonitor();
    return sfu;
  }

  async _ensureSfuRecv() {
    if (this._recvInitPromise) return this._recvInitPromise;
    this._recvInitPromise = (async () => {
      const sfu = await this._ensureSfu();
      if (!sfu.recvTransport || sfu.recvTransport.closed) {
        await sfu.ensureRecvTransport();
        await sfu.consumeExistingProducers();
        sfu.startNetworkStatsMonitor((data) => {
          this.onNetworkQuality?.(data);
        });
      }
      // 참가자 얼굴 영상 정지 자동 복구 (PLI → consumer 재동기화 → 재-consume → ICE 재시작)
      sfu.startReceiverMonitor();
      return sfu;
    })().finally(() => { this._recvInitPromise = null; });
    return this._recvInitPromise;
  }

  async ensureReceiving() {
    // 첫 수신 준비가 실패해도(소켓 재연결/타이밍) 주기 재동기화가 다시 붙이도록 먼저 시작한다.
    this._startProducerResync();
    this._startAudioWatchdog();
    return await this._ensureSfuRecv();
  }

  setRoomCode(code) {
    try { this.avatarManager?.setRoomCode?.(code); } catch { /* ignore */ }
  }

  /** sfu-new-producer 유실 시 참가자 마이크/카메라가 영구히 안 들림 → 주기적으로 목록을 다시 받아 consume */
  _startProducerResync() {
    if (this._resyncTimer) return;
    this._resyncTimer = setInterval(() => {
      // 백그라운드 탭에서는 재동기화를 멈춰 서버 sfu-get-producers 호출을 줄인다
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this.interactionMode === 'unidirectional' && !this.voiceFloorId && !this.allowAllVoice) return;
      const sfu = this.sfu;
      if (!sfu || sfu._closed || !sfu.recvTransport || sfu.recvTransport.closed) {
        this._ensureSfuRecv().catch(() => {});
        return;
      }
      sfu.consumeExistingProducers?.().catch(() => {});
    }, 4000);
  }

  /**
   * 참가자 목소리 재생 감시: 받고 있는 오디오마다 재생 요소가 있는지, 멈춰 있지 않은지 2초마다 확인한다.
   * 자동재생이 막히면 배너로 알리고, 모두 재생되면 배너를 내린다. 스피커를 끈 상태는 건드리지 않는다.
   */
  _startAudioWatchdog() {
    if (this._audioWatchdog) return;
    this._audioWatchdog = setInterval(() => this._checkRemoteAudio(), 2000);
  }

  _stopAudioWatchdog() {
    if (this._audioWatchdog) {
      clearInterval(this._audioWatchdog);
      this._audioWatchdog = null;
    }
  }

  _checkRemoteAudio() {
    if (this.interactionMode === 'unidirectional' && !this.voiceFloorId && !this.allowAllVoice) return;
    const sfu = this.sfu;
    if (!sfu || sfu._closed) return;
    for (const [producerId, consumer] of sfu.consumers) {
      if (!consumer || consumer.closed || consumer.kind !== 'audio') continue;
      const track = consumer.track;
      if (!track || track.readyState === 'ended') continue;
      const meta = sfu.consumerMeta.get(producerId) || {};
      const clientId = meta.clientId || meta.appData?.clientId;
      if (!clientId || clientId === this.signaling.localClientId) continue;
      if (!this._remoteAudioEls?.has(`${clientId}:${track.id}`)) {
        this._playViewerMic(clientId, track);
      }
    }
    if (!this.speakerOn || !this._remoteAudioEls?.size) return;
    const els = [...this._remoteAudioEls.values()].filter(Boolean);
    const attempts = els.map((el) => {
      if (el.muted) el.muted = false;
      if (!el.paused) return Promise.resolve(true);
      return el.play().then(() => true, () => false);
    });
    Promise.all(attempts).then((results) => {
      if (!this.speakerOn) return;
      const ok = results.every(Boolean);
      this._viewerMicPlaying = ok;
      if (ok) this.onAudioPlaybackState?.({ ok: true });
      else this.onAudioPlaybackState?.({ ok: false, needUnmute: true });
    });
  }

  _stopProducerResync() {
    if (this._resyncTimer) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }
  }

  _onRemoteConsumed(info, consumer) {
    const source = info?.appData?.source || '';
    const clientId = info?.clientId || info?.appData?.clientId;
    if (!clientId || clientId === this.signaling.localClientId) return;

    // 목소리는 카메라/화면공유 분기보다 먼저 재생한다. source 누락 시에도 무음이 되면 안 된다.
    if (consumer?.kind === 'audio' || source === 'viewer-mic') {
      this._playViewerMic(clientId, consumer.track);
      if (source === 'viewer-mic' || consumer?.kind === 'audio') return;
    }

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
    }
  }

  _onRemoteProducerClosed(msg) {
    const clientId = msg?.clientId;
    if (!clientId) return;
    // 어떤 producer 가 닫혔는지 구분한다. 예전에는 참가자의 "아무" producer 가 닫혀도
    // (예: 카메라만 껐다 켬) 화면공유 릴레이가 끊기고 마이크 재생이 정리되었다.
    const source = msg?.source || '';
    const kind = msg?.kind || '';
    const isDisplay = source === 'viewer-display';
    const isCamera = source === 'viewer-camera' || source === 'camera' || (!source && kind === 'video' && !isDisplay);
    const isMic = source === 'viewer-mic' || (kind === 'audio' && source !== 'tab-audio');

    if (isDisplay || (!source && !kind)) {
      this._viewerDisplayStreams.delete(clientId);
      if (this._relayPeerId === clientId) {
        this.restoreOwnDisplay().catch(() => {});
      }
    }
    if (isCamera || (!source && !kind)) {
      this.onRemoteCameraClosed?.(clientId);
    }
    if (isMic || (!source && !kind)) {
      // 닫힌 consumer 의 트랙(ended)만 정리한다. 마이크를 껐다 켤 때 새 consumer 가 먼저 붙으면
      // 같은 참가자의 "살아 있는" 재생 요소까지 지워 목소리가 끊기던 문제.
      let live = false;
      if (this._remoteAudioEls) {
        for (const [key, el] of [...this._remoteAudioEls.entries()]) {
          if (!key.startsWith(`${clientId}:`)) continue;
          const tracks = el?.srcObject?.getAudioTracks?.() || [];
          if (tracks.length && tracks.some((t) => t.readyState !== 'ended')) { live = true; continue; }
          this._cleanupViewerAudio(key, clientId);
        }
      }
      if (!live) this.onRemoteAudioTrackClosed?.(clientId);
    }
  }

  /**
   * 디스플레이 영상만 내린다. 카메라·마이크·오디오 재생은 그대로 둔다.
   * (모드 전환 때 목소리가 끊기지 않게)
   */
  _stopDisplayVideoOnly() {
    this._compositor?.stop();
    this._compositor = null;
    const displayStream = this._ownStream || this.localStream;
    if (displayStream && displayStream !== this.cameraStream && displayStream !== this.rawCameraStream) {
      displayStream.getVideoTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this._tabAudioTracks.forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this._tabAudioTracks = [];
    this._ownStream = null;
    this._relayStream = null;
    this._relayPeerId = null;
    if (this.sfu) {
      try { this.sfu.stopPublishing({ source: 'tab-audio' }); } catch { /* ignore */ }
    }
  }

  /**
   * 참가자 얼굴 타일을 캔버스로 합성해 송출한다. PC 화면 캡처가 필요 없다.
   */
  async startFaceShare() {
    this._stopDisplayVideoOnly();
    this.shareMode = 'face';
    this.tabAudioWanted = false;
    this._audioShareMissing = false;
    if (!this._compositor || this._compositor.width !== 1920 || this._compositor.height !== 1080) {
      try { this._compositor?.stop?.(); } catch { /* ignore */ }
      this._compositor = new FaceCompositor({
        getTiles: () => (typeof this.getFaceTiles === 'function' ? this.getFaceTiles() : []),
        width: 1920,
        height: 1080,
        fps: 30,
      });
    }
    const stream = this._compositor.start();
    const vt = stream.getVideoTracks()[0];
    if (!vt || vt.readyState !== 'live') {
      throw new Error('얼굴 화면을 만들 수 없습니다.');
    }
    this._ownStream = stream;
    this.localStream = this._buildOutboundStream();
    if (!this.localStream.getVideoTracks().length) this.localStream = stream;
    this.kinds = [TRACK_KIND.DISPLAY];
    if (this.hasMic) this.kinds.push(TRACK_KIND.MIC);
    this.active = true;
    await this._publishToSfu();
    await this.sfu?.setDisplayMotion?.(true);
    this._ensureSfuRecv().catch((err) => {
      console.warn('[HostPublisher] sfu recv', err);
    });
    this._startAutoRepair();
    this._emitStatus();
    this.onShareModeChange?.('face');
    this._applyDisplayBudget(this._faceRoomCount || 1);
    return stream;
  }

  /**
   * @param {{ withMic?: boolean, withTabAudio?: boolean }} opts
   */
  async startDisplayCapture({ withMic = false, withTabAudio = true } = {}) {
    // 캡처 창이 뜨기 전에는 기존 송출(얼굴 화면·마이크)을 유지한다. 취소해도 목소리가 끊기지 않는다.
    this.tabAudioWanted = !!withTabAudio;
    this.micWanted = this.micWanted || !!withMic;
    this._audioShareMissing = false;

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 2560, max: 3840 },
        height: { ideal: 1440, max: 2160 },
        displaySurface: 'monitor',
      },
      audio: withTabAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            // Chrome: 이 페이지(참가자 목소리 재생)의 소리는 캡처에서 제외 → 시스템 오디오 공유 시 에코/무한반복 방지
            restrictOwnAudio: true,
            suppressLocalAudioPlayback: false,
          }
        : false,
      preferCurrentTab: false,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      systemAudio: withTabAudio ? 'include' : 'exclude',
    });

    this._stopDisplayVideoOnly();

    this.shareMode = 'screen';
    this.kinds = [TRACK_KIND.DISPLAY];
    if (this.hasMic) this.kinds.push(TRACK_KIND.MIC);
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
    this.localStream = this._buildOutboundStream();

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
        // 브라우저 공유 중지 → 얼굴 화면으로 복귀 (목소리는 유지)
        this.startFaceShare().catch((err) => {
          console.warn('[HostPublisher] face fallback', err);
          this.stop();
        });
      });
    }

    this._applyDisplayBudget(this._faceRoomCount || 1);
    await this._publishToSfu();
    await this.sfu?.setDisplayMotion?.(false);
    this._applyDisplayBudget(this._faceRoomCount || 1);
    this._ensureSfuRecv().catch((err) => {
      console.warn('[HostPublisher] sfu recv', err);
    });
    this._startAutoRepair();
    this._emitStatus();
    this.onShareModeChange?.('screen');
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

    // 참가자 화면 릴레이 중에도 호스트 PC 음악(탭/시스템 오디오)은 계속 송출한다.
    // (릴레이 스트림에 자체 오디오가 있을 때만 그쪽을 사용)
    const relayAudio = this._relayStream ? this._relayStream.getAudioTracks() : [];
    const tabTracks = (relayAudio.length ? relayAudio : this._tabAudioTracks)
      .filter((t) => t?.readyState === 'live');
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
        console.warn('[HostPublisher] mic produce failed', err);
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
      console.warn('[HostPublisher] getUserMedia 미지원 브라우저 환경입니다.');
      this.cameraWanted = false;
      this.cameraStream = null;
      this.onCameraChange?.({ active: false, stream: null });
      return false;
    }
    try {
      let hadExisting = false;
      if (this.rawCameraStream) {
        this.rawCameraStream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        this.rawCameraStream = null;
        hadExisting = true;
      }
      const avOut = this.avatarManager?.outputStream;
      if (this.cameraStream && this.cameraStream !== this.rawCameraStream && this.cameraStream !== avOut) {
        this.cameraStream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        this.cameraStream = null;
        hadExisting = true;
      }
      if (hadExisting) {
        // Windows Media Foundation 드라이버가 직전 하드웨어 핸들을 반납할 때까지 100ms 대기
        await new Promise((r) => setTimeout(r, 100));
      }

      let stream = null;
      try {
        stream = await openWebcamFlexible();
      } catch (camErr) {
        console.warn('[HostPublisher] 실물 웹캠 시작 불가(장치 없음/권한 거부/점유 중 등):', camErr);
        this.cameraWanted = false;
        this.cameraStream = null;
        this.onCameraChange?.({ active: false, stream: null });
        return false;
      }

      this.rawCameraStream = stream;
      const mode = (this._manualFaceMode && this._manualFaceMode !== 'auto')
        ? this._manualFaceMode
        : (this.interactionMode === 'unidirectional' ? 'solo' : faceModeForRoomCount(this._faceRoomCount || 1));
      this.avatarManager.setFaceMode(mode);
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
      if (this.sfu && !this.sfu._closed) {
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
      console.warn('[HostPublisher] ensureCamera failed:', err);
      this.cameraWanted = false;
      this.cameraStream = null;
      this.onCameraChange?.({ active: false, stream: null });
      return false;
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
      const mode = faceModeForRoomCount(this._faceRoomCount || 1);
      this.avatarManager.setFaceMode(mode);
      if (!this.avatarManager._getActivePhotoImg?.()) {
        this.avatarManager._loadDefaultPhoto?.();
      }
      this.avatarManager.setMode('virtual');
      if (this.hasMic && this._micTracks?.[0]) {
        this.avatarManager.attachMicTrack(this._micTracks[0]);
      }
      const outgoingStream = this.avatarManager.getOutputStream();
      this.cameraStream = outgoingStream;

      if (this.sfu && !this.sfu._closed) {
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

  /**
   * 서버 상향 대역폭 예산에 맞춰 호스트 화면 비트레이트 상한을 정한다.
   * 시청자 1명당 비트레이트 × 인원 = 서버 회선 상향 사용량. 회선(예: 80Mbps)에서 회의 화면이 차지할 몫을
   * DISPLAY_EGRESS_BUDGET 로 잡고, 인원이 많을 때만 1인당 상한을 낮춘다(8명 이하는 브라우저 기본 = 상한 없음).
   * (호스트 자신의 딥페이크 수신·참가자 오디오 등을 위한 여유를 남긴다.)
   */
  /**
   * 호스트 화면에 참가자 영상 타일이 있는지에 따라 인코딩 우선순위를 바꾼다.
   * 타일이 있으면 프레임 우선(끊김 방지), 없으면 글씨 우선. 켤 때는 즉시, 끌 때는 15초 지연(깜빡임 방지).
   */
  setDisplayMotionMode(on) {
    if (on) {
      clearTimeout(this._motionOffTimer);
      this._motionOffTimer = null;
      if (this._displayMotionOn) return;
      this._displayMotionOn = true;
      this.sfu?.setDisplayMotion?.(true)?.catch?.(() => {});
    } else if (this._displayMotionOn && !this._motionOffTimer) {
      this._motionOffTimer = setTimeout(() => {
        this._motionOffTimer = null;
        this._displayMotionOn = false;
        this.sfu?.setDisplayMotion?.(false)?.catch?.(() => {});
      }, 15000);
    }
  }

  _applyDisplayBudget(count) {
    const n = Math.max(1, Number(count) || 1);
    const EGRESS_BUDGET = 60_000_000;
    let maxBitrate = 6_000_000;
    let startBitrate = 3_500_000;
    if (n <= 6) {
      maxBitrate = 6_000_000;
      startBitrate = 3_500_000;
    } else if (n <= 12) {
      maxBitrate = 4_500_000;
      startBitrate = 2_500_000;
    } else if (n <= 20) {
      maxBitrate = Math.max(1_500_000, Math.min(3_500_000, Math.floor(EGRESS_BUDGET / n)));
      startBitrate = Math.min(2_000_000, maxBitrate);
    } else if (n <= 30) {
      maxBitrate = Math.max(1_000_000, Math.min(2_500_000, Math.floor(EGRESS_BUDGET / n)));
      startBitrate = Math.min(1_500_000, maxBitrate);
    } else {
      maxBitrate = Math.max(800_000, Math.min(1_800_000, Math.floor(EGRESS_BUDGET / n)));
      startBitrate = Math.min(1_000_000, maxBitrate);
    }
    // PC 화면(글씨/문서)은 정지 구간에 비트를 거의 쓰지 않으므로, 스크롤·전환 순간 선명도를 위해 상한을 더 준다.
    // (서버 코덱 상한 x-google-max-bitrate 8Mbps 이내)
    if (this.shareMode === 'screen') {
      if (n <= 6) {
        maxBitrate = 8_000_000;
        startBitrate = 5_000_000;
      } else if (n <= 12) {
        maxBitrate = 5_500_000;
        startBitrate = 3_000_000;
      }
    }
    this.sfu?.setDisplayEncodeBudget?.({ maxBitrate, startBitrate })?.catch?.(() => {});
    const compositorFps = n > 30 ? 20 : 30;
    this._compositor?.setFps?.(compositorFps);
  }

  /**
   * 방 인원 수에 따라 얼굴 송출 화질 자동 전환
   * 2~6명: 960×540 / 7~12명: 640×360 / 13~20명: 512×288 / 21~30명: 384×216 / 31명+: 320×180
   */
  async setManualFaceMode(mode = 'auto') {
    this._manualFaceMode = mode;
    if (!this.avatarManager) return;
    const effectiveMode = (mode && mode !== 'auto')
      ? mode
      : (this.interactionMode === 'unidirectional' ? 'solo' : faceModeForRoomCount(this._faceRoomCount || 1));

    // 카메라가 비활성 상태(사용자가 켜지 않음)일 때는 canvas 출력 스트림을 생성/재할당하지 않고 프로파일만 갱신
    if (!this.cameraWanted || !this.cameraStream || !this.rawCameraStream) {
      this.avatarManager.setFaceMode(effectiveMode);
      const idleProfile = this.avatarManager.getFaceProfile();
      if (this.sfu) {
        await this.sfu.updateCameraEncodings?.('camera', idleProfile).catch(() => {});
      }
      return;
    }

    this.avatarManager.setFaceMode(effectiveMode);
    const profile = this.avatarManager.getFaceProfile();
    // 새 해상도의 캔버스 캡처 스트림을 생성하여 화면 및 송출에 즉시 실제 화질 변경 반영
    const outgoing = this.avatarManager.recreateFreshStream();
    this.cameraStream = outgoing;
    const nextTrack = outgoing?.getVideoTracks?.()[0] || null;
    if (this.cameraWanted && this.sfu && nextTrack) {
      try {
        await this.sfu.publishStream(outgoing, {
          source: 'camera',
          trackKind: TRACK_KIND.CAMERA,
        });
        await this.sfu.updateCameraEncodings?.('camera', profile);
      } catch (err) {
        console.warn('[HostPublisher] manual face quality switch', err);
      }
    } else if (this.sfu) {
      await this.sfu.updateCameraEncodings?.('camera', profile).catch(() => {});
    }
    // 로컬 화면 비디오 요소에도 새 스트림 바인딩하여 해상도 변경 효과가 즉시 시각적으로 확인되도록 함
    this.onCameraChange?.({ active: true, stream: outgoing });
  }

  async setFaceQualityByRoomSize(totalPeople = 1) {
    const count = Math.max(1, Number(totalPeople) || 1);
    this._faceRoomCount = count;
    this._applyDisplayBudget(count);
    if (!this.avatarManager) return;
    // 수동 모드가 설정되어 있으면(auto가 아니면) 인원수 자동 변경을 스킵하고 수동 모드 유지
    if (this._manualFaceMode && this._manualFaceMode !== 'auto') {
      return;
    }
    // 단방향: 호스트 얼굴은 호스트 화면(카드) 캡처로만 전달되므로 인원과 무관하게 640×360 유지
    const mode = this.interactionMode === 'unidirectional' ? 'solo' : faceModeForRoomCount(count);
    // 카메라가 비활성 상태(사용자가 켜지 않음)일 때는 canvas 출력 스트림을 생성/재할당하지 않음
    if (!this.cameraWanted || !this.cameraStream) {
      this.avatarManager.setFaceMode(mode);
      const idleProfile = this.avatarManager.getFaceProfile();
      if (this.sfu) {
        await this.sfu.updateCameraEncodings?.('camera', idleProfile).catch(() => {});
      }
      return;
    }
    const prevTrack = this.cameraStream?.getVideoTracks?.()[0] || null;
    const recreated = this.avatarManager.setFaceMode(mode);
    const profile = this.avatarManager.getFaceProfile();
    const outgoing = this.avatarManager.getOutputStream();
    this.cameraStream = outgoing;
    const nextTrack = outgoing?.getVideoTracks?.()[0] || null;
    if (this.cameraWanted && this.sfu && nextTrack && (recreated || nextTrack !== prevTrack)) {
      try {
        await this.sfu.publishStream(outgoing, {
          source: 'camera',
          trackKind: TRACK_KIND.CAMERA,
        });
        await this.sfu.updateCameraEncodings?.('camera', profile);
      } catch (err) {
        console.warn('[HostPublisher] face quality switch', err);
      }
      this.onCameraChange?.({ active: true, stream: outgoing });
    } else if (this.sfu) {
      await this.sfu.updateCameraEncodings?.('camera', profile).catch(() => {});
    }
  }

  /** 화면 밖 참가자 얼굴 consumer pause (호스트 디코드 부하 절감) */
  async pauseRemoteCamera(clientId) {
    const cid = this.sfu?.findConsumerIdForClient?.(clientId, 'viewer-camera')
      || this.sfu?.findConsumerIdForClient?.(clientId);
    if (cid) await this.sfu.pauseConsumer?.(cid).catch(() => {});
  }

  async resumeRemoteCamera(clientId) {
    const cid = this.sfu?.findConsumerIdForClient?.(clientId, 'viewer-camera')
      || this.sfu?.findConsumerIdForClient?.(clientId);
    if (cid) await this.sfu.resumeConsumer?.(cid).catch(() => {});
  }

  stopCamera() {
    this.cameraWanted = false;
    if (this.rawCameraStream) {
      this.rawCameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.rawCameraStream = null;
    }
    this.avatarManager?.setWebcamStream(null);
    const avOutStop = this.avatarManager?.outputStream;
    if (this.cameraStream && this.cameraStream !== this.rawCameraStream && this.cameraStream !== avOutStop) {
      this.cameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this.cameraStream = null;
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
      if (enabled) {
        // 마이크 송출은 실패를 조용히 삼키면 "상대에게 내 목소리가 안 들림"이
        // 되고 사용자는 아무 단서를 못 얻는다. 실패 시 1회 재시도 후 상태 보고.
        await this._publishMicWithRetry(rawTrack);
      }
      this._startHostMicLevelWatch(rawTrack);
      this.onMicTrack?.(rawTrack);
      this.avatarManager?.attachMicTrack(rawTrack);
      this._emitLocalStatus();
      return true;
    } catch (err) {
      console.warn('[HostPublisher] mic failed', err);
      return false;
    }
  }

  /**
   * 마이크 트랙 송출 (실패 시 짧은 지연 후 1회 재시도).
   * 서버가 produce를 거부하거나 send transport가 만료된 경우에도
   * 사용자가 마이크를 껐다 켜는 번거로움 없이 자동 복구되게 한다.
   */
  async _publishMicWithRetry(track) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const sfu = await this._ensureSfu();
        if (!sfu) throw new Error('sfu-unavailable');
        await sfu.publishStream(new MediaStream([track]), {
          source: 'mic',
          trackKind: TRACK_KIND.MIC,
        });
        this.hostMicState = 'on';
        this._reportMicState('on');
        return true;
      } catch (err) {
        console.warn(`[HostPublisher] mic produce attempt ${attempt + 1} failed`, err);
        try { this.sfu?.sendTransportAudio?.close?.(); } catch { /* ignore */ }
        if (this.sfu) this.sfu.sendTransportAudio = null; // 다음 시도에서 재생성
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.hostMicState = 'error';
    this._reportMicState('error');
    return false;
  }

  /** 서버 room.hostMicState 갱신 + 진단 로그 */
  _reportMicState(state) {
    try {
      this.signaling?.socket?.emit?.('mic-status', { state });
      this.signaling?.socket?.emit?.('client-diag', {
        kind: state === 'error' ? 'host-mic' : 'host-mic',
        event: 'produce',
        state,
        tracks: (this._micTracks || []).map((t) => ({
          enabled: t?.enabled, muted: t?.muted, readyState: t?.readyState,
        })),
      });
    } catch { /* ignore */ }
  }

  /** 마이크가 실제로 살아 있는지(송출 producer 존재 여부) */
  hasLiveMicProducer() {
    const sfu = this.sfu;
    if (!sfu?.producers) return false;
    for (const [key, producer] of sfu.producers.entries()) {
      if (key.startsWith('mic:') && producer && !producer.closed) return true;
    }
    return false;
  }

  setTabAudioEnabled(on) {
    this.tabAudioWanted = !!on;
    this._syncTabAudioForFeedback();
    this._emitLocalStatus();
  }

  /** 호스트 스피커(참가자 목소리 청취)만 끄고 켠다. 탭 오디오 송출과는 별개. */
  setSpeakerEnabled(on) {
    this.speakerOn = !!on;
    if (!this._remoteAudioEls) return;
    for (const el of this._remoteAudioEls.values()) {
      if (!el) continue;
      el.muted = !this.speakerOn;
      if (this.speakerOn && el.paused) {
        el.play().catch(() => {});
      }
    }
  }

  setMicEnabled(on) {
    this.micWanted = !!on;
    this._micTracks.forEach((t) => {
      if (t) t.enabled = !!on;
    });
    // 켜는 순간 producer가 유실되어 있으면(트랜스포트 재협상/서버 거부 등)
    // 여기서 즉시 재송출한다. 이 경로가 없으면 "켰는데 안 들린다" 상태로 굳는다.
    if (on && this._micTracks[0] && !this.hasLiveMicProducer()) {
      this._publishMicWithRetry(this._micTracks[0]).catch(() => {});
    }
    const activeMicTrack = on ? (this._micTracks[0] || null) : null;
    this.onMicTrack?.(activeMicTrack);
    this.avatarManager?.attachMicTrack(activeMicTrack);
    this._emitLocalStatus();
  }

  _emitLocalStatus() {
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

  _emitStatus() {
    if (this.active) {
      this.signaling.setStreamStatus({ active: true, kinds: this.kinds });
    }
    this._emitLocalStatus();
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
    const relayAudio = this._relayStream ? this._relayStream.getAudioTracks() : [];
    (relayAudio.length ? relayAudio : this._tabAudioTracks).forEach((t) => {
      if (t?.readyState === 'live') ms.addTrack(t);
    });
    this._micTracks.forEach((t) => {
      if (t?.readyState === 'live') ms.addTrack(t);
    });
    return ms;
  }

  async _replaceOutboundVideo(track, source = 'display') {
    if (!this.sfu) return;
    try {
      // 소스별로 정확한 producer만 교체한다. 예전에는 Map 삽입 순서로 첫 video
      // producer를 집어서, 카메라 트랙 교체가 화면공유 송출을 바꿔버릴 수 있었다.
      const ok = await this.sfu.replaceProducerTrackForSource(source, track || null);
      if (!ok) await this.sfu.replaceVideoTrack(track || null);
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
      this._emitLocalStatus();
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
    if (!this._remoteAudioEls || !this.speakerOn) return;
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
      el.muted = !this.speakerOn;
      el.volume = 1;
      el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this._remoteAudioEls.set(key, el);
    } else {
      el.srcObject = new MediaStream([track]);
    }

    el.muted = !this.speakerOn;
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
    // 예전에는 참가자 마이크가 하나라도 살아 있으면 호스트 음악(탭/시스템 소리)을 통째로 꺼서
    // "음악이 클라이언트에게 안 들리는" 문제가 있었다(마이크 필수 방에서는 항상 무음).
    // 이제는 에코 원인을 근본적으로 차단한다:
    //  - 화면공유 오디오에 restrictOwnAudio 를 요청해 이 페이지가 재생하는 참가자 목소리가 다시 실리지 않게 함
    //  - 참가자 마이크는 브라우저 AEC 를 켠 채로 송출
    // 따라서 사용자의 탭소리 ON/OFF 설정만 반영한다.
    this._tabAudioTracks.forEach((t) => {
      if (!t) return;
      t.enabled = !!this.tabAudioWanted;
    });
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
    this._compositor?.stop();
    this._compositor = null;
    this.shareMode = null;
    this.onShareModeChange?.(null);
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
    const wasActive = this.active;
    this.stopCaptureOnly();
    if (wasActive) {
      this.signaling.setStreamStatus({ active: false, kinds: [] });
    }
    this._emitLocalStatus();
  }

  dispose() {
    this._stopProducerResync();
    this._stopAudioWatchdog();
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
