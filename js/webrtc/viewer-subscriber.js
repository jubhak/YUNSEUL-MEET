import { SfuClient } from './sfu-client.js?v=20260919freeze1';
import { VirtualAvatarManager } from '../virtual-avatar-manager.js?v=20260923priv3';

/**
 * 참가자: SFU에서 호스트 display 수신 + (선택) 마이크/화면 업링크
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
    /** @type {MediaStream|null} */
    this.remoteStream = null;
    this._watching = false;
    this.hostPeerId = null;
    /** @type {SfuClient|null} */
    this.sfu = null;
    this._sfuReady = null;
    /** @type {Promise<boolean>|null} */
    this._watchChain = null;

    this.speakerOn = true;
    this.micOn = false;
    /** bidirectional | unidirectional */
    this.interactionMode = 'bidirectional';
    /** @type {MediaStream|null} */
    this._micStream = null;
    this._audioUnlocked = false;
    this._viewerAudioUnlockBound = false;
    this._ensureGlobalAudioUnlock();
    /** @type {MediaStream|null} */
    this._displayShareStream = null;
    this.sharingScreen = false;
    /** @type {HTMLAudioElement|null} */
    this._remoteAudioEl = null;
    /** @type {MediaStream|null} */
    this._remoteAudioStream = null;
    this.avatarManager = new VirtualAvatarManager({ width: 640, height: 360 });
    this.rawCameraStream = null;
    /** @type {MediaStream|null} */
    this.cameraStream = null;
    this.cameraWanted = false;
    /** @type {Set<string>} */
    this._cameraTrackIds = new Set();
    /** @type {((info: { active: boolean, stream?: MediaStream|null }) => void)|null} */
    this.onCameraChange = null;
    /** @type {((info: { clientId: string, stream: MediaStream, role?: string }) => void)|null} */
    this.onRemoteCamera = null;
    /** @type {((clientId: string) => void)|null} */
    this.onRemoteCameraClosed = null;
    /** @type {((track: MediaStreamTrack|null) => void)|null} */
    this.onMicTrack = null;
    /** @type {((info: { clientId: string, track: MediaStreamTrack, source: string, role?: string }) => void)|null} */
    this.onRemoteAudioTrack = null;
    /** @type {((clientId: string) => void)|null} */
    this.onRemoteAudioTrackClosed = null;
    /** @type {((data: { pingMs: number, lossRate: number, quality: string }) => void)|null} */
    this.onNetworkQuality = null;

    this._unsubStatus = signaling.onStreamStatus((msg) => {
      if (!msg.active) {
        if (this._streamOffTimer) clearTimeout(this._streamOffTimer);
        this._streamOffTimer = setTimeout(() => {
          this._streamOffTimer = null;
          this._watching = false;
          this.clearRemote();
          this.onStatus({ streamActive: false, streamEnded: true, playing: false });
        }, 3500);
        return;
      }
      if (this._streamOffTimer) {
        clearTimeout(this._streamOffTimer);
        this._streamOffTimer = null;
      }
      if (this._watching && this.hasLiveVideo()) {
        this.onStatus({ streamActive: true, playing: true });
        return;
      }
      this.onStatus({ streamActive: true, kinds: msg.kinds || [] });
      // watch() 하나로 직렬화 — 병렬 _ensureWatching이 transport를 서로 끊던 버그 방지
      this.watch().catch((err) => {
        console.warn('[ViewerSubscriber] sfu watch', err);
      });
    });
  }

  get hasCamera() {
    return !!this.cameraStream && this.cameraStream.getVideoTracks().some((t) => t && t.readyState === 'live');
  }

  get cameraEnabled() {
    return this.hasCamera && this.cameraStream.getVideoTracks().some((t) => t.enabled);
  }

  async _ensureSfu() {
    if (this.sfu && !this.sfu._closed) return this.sfu;
    if (this._sfuReady) return this._sfuReady;
    this._sfuReady = (async () => {
      const sfu = new SfuClient({
        socket: this.signaling.socket,
        clientId: this.signaling.localClientId,
        role: 'viewer',
      });
      sfu.consumeFilter = (info) => {
        const source = info?.appData?.source || '';
        const kind = info?.kind;
        // 클라이언트는 영상 화면을 보는 제어권이 없고 오직 호스트 송출 화면만 봄
        // 호스트 화면 1개만 소비하여 20명+ 접속 시에도 모바일 디코딩 부하 및 고속 재생 밀림 완벽 방지
        if (kind === 'video') {
          // 호스트의 메인 송출(display) 스트림만 수신. 모든 카메라 스트림(viewer-camera, camera 등)은 수신 거부
          return info?.role === 'host' && (source === 'display' || !source);
        }
        // 오디오는 호스트 음성/탭 오디오 및 참가자 마이크(양방향 모드 시) 수신
        if (kind === 'audio') {
          if (source === 'tab-audio' || source === 'mic') return true;
          if (source === 'viewer-mic') {
            return this.interactionMode !== 'unidirectional';
          }
          if (info?.role === 'host') return true;
          if (info?.role === 'viewer') {
            return this.interactionMode !== 'unidirectional';
          }
        }
        return false;
      };
      sfu.onConsumed = (info, consumer) => {
        const source = info?.appData?.source || '';
        const clientId = info?.clientId || info?.appData?.clientId;
        if (source === 'camera' || source === 'viewer-camera') {
          if (consumer.track) {
            this._cameraTrackIds.add(consumer.track.id);
            const camStream = new MediaStream([consumer.track]);
            this.onRemoteCamera?.({
              clientId,
              stream: camStream,
              role: info?.role || (source === 'camera' ? 'host' : 'viewer')
            });
            consumer.track.addEventListener('ended', () => {
              this._cameraTrackIds.delete(consumer.track.id);
              this.onRemoteCameraClosed?.(clientId);
            });
          }
        }
        if (source === 'mic' || source === 'viewer-mic') {
          if (consumer.track) {
            this.onRemoteAudioTrack?.({
              clientId,
              role: info?.role || (source === 'mic' ? 'host' : 'viewer'),
              track: consumer.track,
              source,
            });
            consumer.track.addEventListener('ended', () => {
              this.onRemoteAudioTrackClosed?.(clientId);
            }, { once: true });
          }
        }
      };
      sfu.onRemoteStream = (stream) => this._attachRemote(stream);
      sfu.onProducerClosed = (msg) => {
        const clientId = msg?.clientId;
        if (clientId) {
          this.onRemoteCameraClosed?.(clientId);
          this.onRemoteAudioTrackClosed?.(clientId);
        }
        if (!this.hasLiveVideo()) this._notifyIfStreamDead();
      };
      await sfu.init();
      this.sfu = sfu;
      return sfu;
    })();
    try {
      return await this._sfuReady;
    } finally {
      this._sfuReady = null;
    }
  }

  async ensureReceiving() {
    const sfu = await this._ensureSfu();
    if (!sfu.recvTransport || sfu.recvTransport.closed) {
      await sfu.ensureRecvTransport();
      await sfu.consumeExistingProducers();
    }
    return sfu;
  }

  _resetRecvOnly() {
    const sfu = this.sfu;
    if (!sfu || sfu._closed) return;
    for (const [pid, consumer] of [...sfu.consumers.entries()]) {
      try {
        const track = consumer.track;
        if (track && sfu.remoteStream) {
          try { sfu.remoteStream.removeTrack(track); } catch { /* ignore */ }
        }
        consumer.close();
      } catch { /* ignore */ }
      sfu.consumers.delete(pid);
    }
    try { sfu.recvTransport?.close(); } catch { /* ignore */ }
    sfu.recvTransport = null;
  }

  async _waitLiveVideo(ms = 6000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.hasLiveVideo()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.hasLiveVideo();
  }

  async _ensureWatching() {
    const sfu = await this._ensureSfu();
    if (this.hasLiveVideo() && sfu.recvTransport && !sfu.recvTransport.closed) {
      this._attachRemote(sfu.remoteStream);
      sfu.startNetworkStatsMonitor((data) => {
        this.onNetworkQuality?.(data);
      });
      return;
    }
    sfu._pendingProducers = [];
    await sfu.consumeExistingProducers();
    sfu.startNetworkStatsMonitor((data) => {
      this.onNetworkQuality?.(data);
    });
    if (sfu.remoteStream?.getTracks?.().length) {
      this._attachRemote(sfu.remoteStream);
    }
    if (await this._waitLiveVideo(6000)) return;
    throw new Error('호스트 화면 준비 중…');
  }

  _startFreezeWatchdog() {
    if (this._freezeWatchdogTimer) return;
    let lastPliTime = 0;
    this._freezeWatchdogTimer = setInterval(() => {
      const v = this.videoEl;
      if (!v || !this._watching || !this.hasLiveVideo()) return;

      // 브라우저 정책 또는 백그라운드 전환으로 인한 일시정지 안전 복구
      if (v.paused) {
        v.play().catch(() => {});
      }

      // 발표 슬라이드는 정지 화면이 정상이므로 currentTime을 멈춤으로 오판하지 않음.
      // 실제 네트워크 패킷 중단(WebRTC track.muted === true) 시에만 최소 4초 간격 키프레임 요청
      const track = v.srcObject?.getVideoTracks?.()[0];
      const now = Date.now();
      if (track && track.readyState === 'live' && track.muted) {
        if (now - lastPliTime > 4000) {
          lastPliTime = now;
          this.sfu?.requestKeyFrame?.();
          this.sfu?.resumeAllConsumers?.();
          v.play().catch(() => {});
        }
      }
    }, 1500);
  }

  async watch() {
    this._startFreezeWatchdog();
    if (this._watchChain) return this._watchChain;
    this._watchChain = this._watchLoop().finally(() => {
      this._watchChain = null;
    });
    return this._watchChain;
  }

  async _watchLoop() {
    let lastErr = null;
    for (let i = 0; i < 4; i += 1) {
      try {
        if (this.hasLiveVideo()) return true;
        await this._ensureWatching();
        return true;
      } catch (err) {
        lastErr = err;
        console.warn('[ViewerSubscriber] watch try', i + 1, err);
        this.onStatus({
          streamActive: true,
          playing: false,
          connectError: err?.message || '호스트 화면 연결 중…',
        });
        if (i < 3) {
          if (this.interactionMode !== 'bidirectional') {
            this._resetRecvOnly();
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    this.onStatus({
      streamActive: true,
      playing: false,
      connectError: lastErr?.message || '호스트 화면 준비 중…',
    });
    throw lastErr || new Error('호스트 화면 준비 중…');
  }

  _ensureGlobalAudioUnlock() {
    if (this._viewerAudioUnlockBound || typeof window === 'undefined') return;
    this._viewerAudioUnlockBound = true;
    const unlock = () => {
      this.unlockAudio().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('touchstart', unlock, { capture: true, passive: true });
    window.addEventListener('click', unlock, { capture: true });
  }

  _visuallyHideMediaEl(el) {
    el.setAttribute('playsinline', '');
    el.playsInline = true;
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
  }

  async _ensurePlayMix() {
    // 호환용 no-op (이전 WebAudio 믹스 제거)
    return null;
  }

  /**
   * 원격 오디오(호스트 + 다른 참가자 마이크) — 트랙마다 <audio> 1개.
   * (한 요소에 여러 트랙을 넣으면 일부 브라우저가 첫 트랙만 재생함)
   * @param {MediaStream} stream
   */
  async _syncRemoteAudio(stream) {
    if (!stream) return;
    if (!this._remoteAudioEls) this._remoteAudioEls = new Map();

    const live = new Set();
    const tracks = (stream.getAudioTracks() || []).filter(
      (t) => t && t.readyState !== 'ended'
    );

    for (const track of tracks) {
      live.add(track.id);
      let el = this._remoteAudioEls.get(track.id);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        el.playsInline = true;
        el.volume = 1;
        this._visuallyHideMediaEl(el);
        el.srcObject = new MediaStream([track]);
        document.body.appendChild(el);
        this._remoteAudioEls.set(track.id, el);
      }
      el.muted = !this.speakerOn;
      if (this.speakerOn) {
        el.play().then(() => {
          this._audioUnlocked = true;
        }).catch(() => {
          this.onStatus({
            streamActive: true,
            playing: this.hasLiveVideo(),
            hasRemoteAudio: true,
            needUnmute: true,
          });
        });
      }
    }

    for (const [id, el] of [...this._remoteAudioEls.entries()]) {
      if (live.has(id)) continue;
      try { el.pause(); } catch { /* ignore */ }
      el.srcObject = null;
      try { el.remove(); } catch { /* ignore */ }
      this._remoteAudioEls.delete(id);
    }

    // 레거시 단일 요소 정리
    if (this._remoteAudioEl) {
      try { this._remoteAudioEl.pause(); } catch { /* ignore */ }
      this._remoteAudioEl.srcObject = null;
      try { this._remoteAudioEl.remove(); } catch { /* ignore */ }
      this._remoteAudioEl = null;
    }
  }

  _reportAudioDiag(event, track, detail = '') {
    try {
      const socket = this.signaling?.socket;
      if (!socket?.connected) return;
      if (event === 'track-add') {
        const key = `${event}:${track?.id || ''}`;
        if (this._diagOnce?.has(key)) return;
        if (!this._diagOnce) this._diagOnce = new Set();
        this._diagOnce.add(key);
      }
      socket.emit('client-diag', {
        kind: 'viewer-audio',
        event,
        detail: detail || undefined,
        speakerOn: this.speakerOn,
        unlocked: this._audioUnlocked,
        videoMuted: !!this.videoEl?.muted,
        trackId: track?.id ? String(track.id).slice(0, 8) : undefined,
        muted: track?.muted,
        enabled: track?.enabled,
        readyState: track?.readyState,
        mixTracks: this._playMix?.sources?.size || 0,
        rms: this._lastRms,
      });
    } catch { /* ignore */ }
  }

  _attachRemote(stream) {
    this.remoteStream = stream;
    const video = this.videoEl;
    if (!video) return;

    const vtracks = (stream.getVideoTracks() || []).filter((t) => {
      if (!t || t.readyState === 'ended') return false;
      if (this._cameraTrackIds.has(t.id)) return false;
      return true;
    });
    const hasAudio = (stream.getAudioTracks() || []).some((t) => t && t.readyState !== 'ended');

    // 영상 먼저 연결 — 오디오 오류와 분리해서 송출 대기 고착 방지
    if (vtracks.length) {
      const cur = video.srcObject;
      const curId = cur instanceof MediaStream ? cur.getVideoTracks()[0]?.id : null;
      if (curId !== vtracks[0].id) {
        video.srcObject = new MediaStream(vtracks);
      }
      video.playsInline = true;
      video.muted = true;
      this._watching = true;
      this.onStatus({
        streamActive: true,
        playing: true,
        hasRemoteAudio: hasAudio,
        needUnmute: hasAudio && this.speakerOn && !this._audioUnlocked,
      });
      video.play().catch(() => {});
    } else if (hasAudio) {
      this.onStatus({
        streamActive: true,
        hasRemoteAudio: true,
        needUnmute: this.speakerOn && !this._audioUnlocked,
      });
    }

    this._syncRemoteAudio(stream).catch((err) => {
      console.warn('[ViewerSubscriber] sync audio', err);
    });
  }

  clearRemote() {
    if (this._levelTimer) {
      clearInterval(this._levelTimer);
      this._levelTimer = null;
    }
    if (this._playMix) {
      for (const entry of this._playMix.sources?.values?.() || []) {
        try { entry.src.disconnect(); } catch { /* ignore */ }
        try { entry.gain.disconnect(); } catch { /* ignore */ }
      }
      try { this._playMix.master?.disconnect(); } catch { /* ignore */ }
      this._playMix = null;
    }
    if (this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) {
        try { el.pause(); } catch { /* ignore */ }
        el.srcObject = null;
        try { el.remove(); } catch { /* ignore */ }
      }
      this._remoteAudioEls.clear();
    }
    if (this._remoteAudioEl) {
      try { this._remoteAudioEl.pause(); } catch { /* ignore */ }
      this._remoteAudioEl.srcObject = null;
      try { this._remoteAudioEl.remove(); } catch { /* ignore */ }
      this._remoteAudioEl = null;
    }
    this._remoteAudioStream = null;
    if (this.sfu) {
      try {
        for (const track of [...(this.sfu.remoteStream?.getTracks?.() || [])]) {
          try { this.sfu.remoteStream.removeTrack(track); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    this.remoteStream = null;
    this._watching = false;
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch { /* ignore */ }
      this.videoEl.srcObject = null;
    }
  }

  hasLiveVideo() {
    const stream = this.videoEl?.srcObject;
    if (!(stream instanceof MediaStream)) return false;
    return stream.getVideoTracks().some((t) => t && t.readyState !== 'ended');
  }

  _notifyIfStreamDead() {
    if (this.hasLiveVideo()) return;
    this.onStatus({ streamActive: false, streamEnded: true, playing: false });
  }

  async unlockAudio() {
    this._audioUnlocked = true;
    if (this.remoteStream) await this._syncRemoteAudio(this.remoteStream);
    if (this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) {
        if (!this.speakerOn) {
          el.muted = true;
          continue;
        }
        el.muted = false;
        try { await el.play(); } catch { /* ignore */ }
      }
    }
    this.onStatus({
      streamActive: true,
      playing: this.hasLiveVideo(),
      hasRemoteAudio: !!(this.remoteStream?.getAudioTracks?.().length),
      needUnmute: false,
    });
    return true;
  }

  async setSpeakerEnabled(on) {
    this.speakerOn = !!on;
    if (this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) el.muted = !on;
    }
    if (on) await this.unlockAudio();
    else {
      this.onStatus({
        streamActive: true,
        playing: this.hasLiveVideo(),
        hasRemoteAudio: !!(this.remoteStream?.getAudioTracks?.().length),
        needUnmute: false,
      });
    }
  }

  async setMicEnabled(on) {
    this.micOn = !!on;
    this._lastMicError = null;
    if (!on) {
      await this._stopMic();
      return true;
    }
    try {
      await this._startMic();
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] mic', err);
      this.micOn = false;
      this._lastMicError = err;
      await this._stopMic().catch(() => {});
      return false;
    }
  }

  async _startMic() {
    if (this._micStream) return;
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this._micStream = raw;
    const audioTrack = raw.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = true;
      try { audioTrack.contentHint = 'speech'; } catch { /* ignore */ }
      this.onMicTrack?.(audioTrack);
      this.avatarManager?.attachMicTrack(audioTrack);
    }
    const sfu = await this._ensureSfu();
    await sfu.publishStream(this._micStream, { source: 'viewer-mic' });
  }

  async _stopMic() {
    this.onMicTrack?.(null);
    this.avatarManager?.attachMicTrack(null);
    const sfu = this.sfu;
    if (sfu) {
      try { await sfu.stopPublishing({ source: 'viewer-mic' }); } catch { /* ignore */ }
    }
    if (this._micPipeline) {
      try { this._micPipeline.close(); } catch { /* ignore */ }
      this._micPipeline = null;
    }
    if (this._micStream) {
      for (const t of this._micStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this._micStream = null;
    }
  }

  async startScreenShare() {
    if (this.sharingScreen) return true;
    try {
      // 전체 화면(모니터) 공유 우선 — 코딩 PC 화면용
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: 24, max: 30 },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        monitorTypeSurfaces: 'include',
        surfaceSwitching: 'include',
      });
      this._displayShareStream = stream;
      this.sharingScreen = true;
      const sfu = await this._ensureSfu();
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          this.stopScreenShare().catch(() => {});
        });
      }
      await sfu.publishStream(stream, { source: 'viewer-display' });
      this.onStatus?.({ sharingScreen: true, playing: false });
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] screen share', err);
      this.sharingScreen = false;
      if (this._displayShareStream) {
        for (const t of this._displayShareStream.getTracks()) {
          try { t.stop(); } catch { /* ignore */ }
        }
        this._displayShareStream = null;
      }
      this.onStatus?.({ sharingScreen: false });
      return false;
    }
  }

  async stopScreenShare() {
    const wasSharing = this.sharingScreen;
    this.sharingScreen = false;
    const sfu = this.sfu;
    if (sfu) {
      try { await sfu.stopPublishing({ source: 'viewer-display' }); } catch { /* ignore */ }
    }
    if (this._displayShareStream) {
      for (const t of this._displayShareStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this._displayShareStream = null;
    }
    if (wasSharing) {
      this.onStatus?.({
        sharingScreen: false,
        streamActive: true,
        playing: this.hasLiveVideo(),
      });
    }
  }

  async _obtainCameraStream() {
    let lastError = null;

    // 0단계: 장치 목록 사전 점검 (videoinput 장치가 하나라도 있는지 확인)
    let videoDevices = [];
    if (navigator.mediaDevices.enumerateDevices) {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devs.filter((d) => d.kind === 'videoinput');
        if (videoDevices.length === 0) {
          const noDevErr = new Error('연결된 카메라(웹캠) 장치를 찾을 수 없습니다.');
          noDevErr.name = 'NotFoundError';
          throw noDevErr;
        }
      } catch (e) {
        if (e.name === 'NotFoundError') throw e;
      }
    }

    // 1단계: 기본 제약 video: true (가장 기본적이고 안정적으로 장치 개방 시도)
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (err1) {
      lastError = err1;
      console.warn('[ViewerSubscriber] basic video:true failed:', err1);
    }

    // 2단계: 권장 해상도(640x480, 24~30fps)로 시도
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
    } catch (err2) {
      if (!lastError) lastError = err2;
      console.warn('[ViewerSubscriber] ideal constraints failed:', err2);
    }

    // 3단계: 장치가 여러 개인 경우(가상 카메라, 외장 웹캠 등) 개별 videoinput 장치 순회 시도
    if (videoDevices.length > 1) {
      for (const dev of videoDevices) {
        if (!dev.deviceId) continue;
        try {
          return await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: dev.deviceId } },
            audio: false,
          });
        } catch (devErr) {
          console.warn(`[ViewerSubscriber] device ${dev.label || dev.deviceId} failed:`, devErr);
        }
      }
    }

    // 4단계: 모바일/터치 기기 환경인 경우에만 facingMode: 'user' 시도 (데스크톱 USB 웹캠에서는 제외)
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (isTouchDevice) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
      } catch (err4) {
        if (!lastError) lastError = err4;
      }
    }

    throw lastError || new Error('카메라 스트림을 시작할 수 없습니다.');
  }

  async setCameraEnabled(wanted = true) {
    if (this.interactionMode === 'unidirectional' && wanted) {
      throw new Error('단방향 모드에서는 카메라를 송출할 수 없습니다.');
    }
    this.cameraWanted = !!wanted;
    this._lastCameraError = null;
    if (!wanted) {
      this.stopCamera();
      return true;
    }
    if (this.hasCamera) {
      this.cameraStream.getVideoTracks().forEach((t) => { t.enabled = true; });
      this.onCameraChange?.({ active: true, stream: this.cameraStream });
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      console.warn('[ViewerSubscriber] getUserMedia 미지원 환경, 가상 얼굴(아바타)로 전환');
      return await this.startVirtualCamera();
    }
    try {
      // 기존 트랙이 열려 있다면 새 스트림을 요청하기 전에 먼저 정리 (하드웨어 락 해제)
      if (this.rawCameraStream) {
        this.rawCameraStream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        this.rawCameraStream = null;
      }
      if (this.cameraStream && this.cameraStream !== this.rawCameraStream) {
        this.cameraStream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        this.cameraStream = null;
      }

      let stream = null;
      try {
        stream = await this._obtainCameraStream();
      } catch (camErr) {
        console.warn('[ViewerSubscriber] 실물 웹캠 시작 불가(장치 없음/점유 중 등) → 가상 얼굴(아바타)로 자동 대체:', camErr);
        return await this.startVirtualCamera();
      }
      this.rawCameraStream = stream;

      // VirtualAvatarManager에 실제 웹캠 스트림 및 마이크 연결 후 실물 모드 활성화
      this.avatarManager.setWebcamStream(stream);
      if (this._micStream?.getAudioTracks?.()[0]) {
        this.avatarManager.attachMicTrack(this._micStream.getAudioTracks()[0]);
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
      const sfu = await this._ensureSfu();
      await sfu.publishStream(outgoingStream, {
        source: 'viewer-camera',
        trackKind: 'camera',
      });
      this.onCameraChange?.({ active: true, stream: outgoingStream });
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] camera error:', err);
      // 최종 실패 시에도 가상 얼굴 대체 시도
      try {
        return await this.startVirtualCamera();
      } catch (virtErr) {
        this._lastCameraError = virtErr || err;
        this.cameraWanted = false;
        this.cameraStream = null;
        this.rawCameraStream = null;
        this.onCameraChange?.({ active: false, stream: null });
        return false;
      }
    }
  }

  /**
   * 물리적 웹캠이 없거나 오류 발생 시 가상 얼굴(아바타)로 카메라 송출 시작
   */
  async startVirtualCamera() {
    if (this.interactionMode === 'unidirectional') {
      throw new Error('단방향 모드에서는 카메라를 송출할 수 없습니다.');
    }
    this.cameraWanted = true;
    this._lastCameraError = null;

    if (this.rawCameraStream) {
      this.rawCameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.rawCameraStream = null;
    }

    try {
      this.avatarManager.setWebcamStream(null);
      this.avatarManager.setMode('virtual');
      if (this._micStream?.getAudioTracks?.()[0]) {
        this.avatarManager.attachMicTrack(this._micStream.getAudioTracks()[0]);
      }
      const outgoingStream = this.avatarManager.getOutputStream();
      this.cameraStream = outgoingStream;

      const sfu = await this._ensureSfu();
      await sfu.publishStream(outgoingStream, {
        source: 'viewer-camera',
        trackKind: 'camera',
      });
      this.onCameraChange?.({ active: true, stream: outgoingStream });
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] virtual camera error:', err);
      this._lastCameraError = err;
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
    if (this.avatarManager) {
      this.avatarManager.setWebcamStream(null);
    }
    if (this.cameraStream && this.cameraStream !== this.rawCameraStream) {
      this.cameraStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    this.cameraStream = null;
    this.cameraWanted = false;
    if (this.sfu) {
      this.sfu.stopPublishing({ source: 'viewer-camera' }).catch(() => {});
    }
    this.onCameraChange?.({ active: false, stream: null });
  }

  async toggleCamera() {
    return await this.setCameraEnabled(!this.cameraEnabled);
  }

  destroy() {
    if (this._freezeWatchdogTimer) {
      clearInterval(this._freezeWatchdogTimer);
      this._freezeWatchdogTimer = null;
    }
    if (this._streamOffTimer) {
      clearTimeout(this._streamOffTimer);
      this._streamOffTimer = null;
    }
    try { this._unsubStatus?.(); } catch { /* ignore */ }
    this.clearRemote();
    this.stopCamera();
    this._stopMic().catch(() => {});
    this.stopScreenShare().catch(() => {});
    try { this.sfu?.close?.(); } catch { /* ignore */ }
    this.sfu = null;
  }

  dispose() {
    this.destroy();
  }
}
