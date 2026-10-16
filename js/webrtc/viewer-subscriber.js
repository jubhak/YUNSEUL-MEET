import { SfuClient } from './sfu-client.js?v=20261006a';
import { VirtualAvatarManager, openWebcamFlexible, faceModeForRoomCount } from '../virtual-avatar-manager.js?v=20261016a';

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
  constructor({ signaling, videoEl, onStatus, streamActive = false, hostPeerId = null }) {
    this.signaling = signaling;
    this.videoEl = videoEl;
    this.onStatus = onStatus || (() => {});
    /** @type {MediaStream|null} */
    this.remoteStream = null;
    this._watching = false;
    this.hostPeerId = hostPeerId || null;
    this._spotlightTrackId = null;
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
    this.avatarManager = new VirtualAvatarManager({ width: 640, height: 360, fps: 30 });
    // 참가자 식별자를 아바타 매니저로 전달 → 워커가 참가자별로 스왑 프레임을 분리
    try { this.avatarManager.setClientId?.(signaling?.localClientId || null); } catch { /* ignore */ }
    // 서버가 "호스트가 딥페이크 직송을 화면에 그리는 중"이라고 알리면 SFU 카메라 송출(VP8)을 저fps 로 낮춘다.
    // (직송이 정상인 동안 SFU 영상은 폴백용일 뿐이므로 업로드/호스트 디코드를 줄인다. 직송이 이상하면 즉시 복원)
    this._feedSave = false;
    this._feedSaveTimer = null;
    this.avatarManager.onFeedState = (live) => { this._setFeedSave(!!live); };
    this._faceRoomCount = 1;
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

    this._spotlightSpeakerId = null;
    this._spotlightSpeakerName = '호스트';
    this._spotlightSpeakerRole = 'host';
    this._cameraWantedIdle = false;
    this._spotlightConsumer = null;
    /** @type {((info: { clientId: string, name: string, role: string, stream: MediaStream|null }) => void)|null} */
    this.onSpotlightStream = null;

    this._streamActive = !!streamActive;
    this._unsubStatus = signaling.onStreamStatus((msg) => {
      this._streamActive = !!msg.active;
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

  setStreamActive(active) {
    this._streamActive = !!active;
    if (active) {
      this.watch().catch(() => {});
    }
  }

  get hasCamera() {
    return !!this.cameraWanted && !!this.cameraStream && this.cameraStream.getVideoTracks().some((t) => t && t.readyState === 'live');
  }

  get cameraEnabled() {
    return !!this.cameraWanted && this.hasCamera && this.cameraStream.getVideoTracks().some((t) => t.enabled);
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
      // 호스트가 PC 화면을 보여주는 중이면 새로 만드는 카메라 송출도 멈춘 채로 시작
      if (this._cameraIdle) sfu._inactiveSources.add('viewer-camera');
      sfu.consumeFilter = (info) => {
        const source = info?.appData?.source || '';
        const kind = info?.kind;
        if (kind === 'video') {
          // 화면 공유 모드 시 호스트 display는 기본 수신
          if (info?.role === 'host' && (source === 'display' || !source)) return true;
          // 스포트라이트 화자 비디오: 현재 스포트라이트 지정된 화자의 카메라 track만 선택적 수신!
          const isSpotlightHost = (!this._spotlightSpeakerId || this._spotlightSpeakerRole === 'host' || (this.hostPeerId && this._spotlightSpeakerId === this.hostPeerId));
          if (isSpotlightHost) {
            if (source === 'camera') return true;
          } else {
            const cid = info?.clientId || info?.appData?.clientId;
            if (cid === this._spotlightSpeakerId && source === 'viewer-camera') return true;
          }
          return false;
        }
        if (kind === 'audio') {
          if (source === 'tab-audio' || source === 'mic') return true;
          if (source === 'viewer-mic') {
            return this.interactionMode !== 'unidirectional';
          }
          const role = info?.role || info?.appData?.role || '';
          if (role === 'host' || source === 'display') return true;
          if (role === 'viewer' || !role) {
            return this.interactionMode !== 'unidirectional';
          }
        }
        return false;
      };
      sfu.onConsumed = (info, consumer) => {
        const source = info?.appData?.source || '';
        const clientId = info?.clientId || info?.appData?.clientId;
        if (source === 'camera' || source === 'viewer-camera') {
          const isSpotlightHost = (!this._spotlightSpeakerId || this._spotlightSpeakerRole === 'host' || (this.hostPeerId && this._spotlightSpeakerId === this.hostPeerId));
          const isTarget = isSpotlightHost
            ? (source === 'camera')
            : (clientId === this._spotlightSpeakerId && source === 'viewer-camera');
          if (isTarget && consumer.track) {
            if (this._spotlightConsumer && this._spotlightConsumer !== consumer) {
              try { this._spotlightConsumer.close(); } catch { /* ignore */ }
            }
            this._spotlightConsumer = consumer;
            this._spotlightTrackId = consumer.track.id;
            const spotlightStream = new MediaStream([consumer.track]);
            consumer.track.addEventListener('ended', () => {
              if (this._spotlightConsumer === consumer) {
                this._spotlightConsumer = null;
                this._spotlightTrackId = null;
                this.onSpotlightStream?.({
                  clientId: this._spotlightSpeakerId,
                  name: this._spotlightSpeakerName,
                  role: this._spotlightSpeakerRole,
                  stream: null,
                });
              }
            }, { once: true });
            this.onSpotlightStream?.({
              clientId: this._spotlightSpeakerId || this.hostPeerId,
              name: this._spotlightSpeakerName || '호스트',
              role: this._spotlightSpeakerRole || 'host',
              stream: spotlightStream,
            });
            return;
          }
          try { consumer.close(); } catch { /* ignore */ }
          return;
        }
        if (consumer.kind === 'audio' || source === 'mic' || source === 'viewer-mic' || source === 'tab-audio') {
          if (consumer.track) {
            this._playRemoteAudioTrack(consumer.track, clientId, source);
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
        const source = msg?.source || '';
        const kind = msg?.kind || '';
        if (clientId) {
          this.onRemoteCameraClosed?.(clientId);
          if (this._remoteAudioEls) {
            for (const [key] of [...this._remoteAudioEls.entries()]) {
              if (key.startsWith(`${clientId}:`)) {
                this._cleanupRemoteAudioTrack(key, clientId);
              }
            }
          }
          this.onRemoteAudioTrackClosed?.(clientId);
        }
        if (clientId === this._spotlightSpeakerId || (source === 'camera' && this._spotlightSpeakerRole === 'host')) {
          if (this._spotlightConsumer) {
            try { this._spotlightConsumer.close(); } catch { /* ignore */ }
            this._spotlightConsumer = null;
          }
          this.onSpotlightStream?.({
            clientId: this._spotlightSpeakerId,
            name: this._spotlightSpeakerName,
            role: this._spotlightSpeakerRole,
            stream: null,
          });
        }
        // 마이크/카메라 토글 등 개별 프로듀서 종료로 인해 시청자 화면이
        // 갑작스럽게 '대기중'으로 바뀌는 현상 차단:
        // 오직 호스트의 display(화면공유) 비디오 프로듀서 종료 시에만 검사
        const isHostDisplay = (source === 'display' || (!source && kind === 'video' && (!clientId || clientId === this.hostPeerId)));
        if (isHostDisplay && !this.hasLiveVideo()) {
          this._notifyIfStreamDead();
        }
      };
      await sfu.init();
      sfu.startSenderMonitor();
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
    await sfu.ensureRecvTransport();
    await sfu.consumeExistingProducers();
    this._startProducerResync();
    return sfu;
  }

  _startProducerResync() {
    if (this._resyncTimer) return;
    this._resyncTimer = setInterval(() => {
      if (this.interactionMode === 'unidirectional') return;
      if (!this.sfu || this.sfu._closed) return;
      this.sfu.consumeExistingProducers?.().catch(() => {});
    }, 4000);
  }

  _stopProducerResync() {
    if (this._resyncTimer) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }
  }

  setRoomCode(code) {
    try { this.avatarManager?.setRoomCode?.(code); } catch { /* ignore */ }
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

  requestDisplayKeyframe() {
    const sfu = this.sfu;
    if (!sfu?.consumers) return;
    for (const consumer of sfu.consumers.values()) {
      if (consumer && !consumer.closed && consumer.kind === 'video') {
        sfu.requestKeyFrame(consumer.id).catch(() => {});
      }
    }
  }

  /**
   * 화면 정지(Freeze) 감지 시 특정 시청자의 디스플레이 비디오 컨슈머만 신속하게 재연결·복구
   * @param {boolean} forceFullReset true이면 수신 트랜스포트를 완전히 재구축
   */
  async reconsumeDisplayStream(forceFullReset = false) {
    const sfu = this.sfu;
    if (!sfu || sfu._closed) {
      return this.watch().catch(() => false);
    }
    console.log(`[ViewerSubscriber] reconsumeDisplayStream (forceFullReset=${forceFullReset})`);
    try {
      if (forceFullReset) {
        this._resetRecvOnly();
        await this.ensureReceiving();
      } else {
        // 비파괴적 빠른 싱크: 키프레임 강제 요청 및 컨슈머 resume
        await sfu.resumeAllConsumers().catch(() => {});
        this.requestDisplayKeyframe();
      }
      if (sfu.remoteStream?.getTracks?.().length) {
        this._attachRemote(sfu.remoteStream);
      }
      try { this.videoEl?.play?.().catch(() => {}); } catch {}
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] reconsumeDisplayStream fallback to watch()', err);
      try {
        return await this.watch();
      } catch {
        return false;
      }
    }
  }

  async _waitLiveVideo(ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.hasLiveVideo()) {
        try { this.videoEl?.play?.().catch(() => {}); } catch {}
        return true;
      }
      await new Promise((r) => setTimeout(r, 80));
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
    // 연결 후 즉시 전체 키프레임 요청하여 첫 프레임 수신 가속
    sfu.resumeAllConsumers().catch(() => {});
    for (const consumer of sfu.consumers.values()) {
      if (consumer && !consumer.closed && consumer.kind === 'video') {
        sfu.requestKeyFrame(consumer.id).catch(() => {});
      }
    }
    if (await this._waitLiveVideo(4000)) return;
    throw new Error('호스트 화면 준비 중…');
  }

  /**
   * 연결 및 재생 상태 자가 복구 워치독:
   * 화면이 연결될 때까지 2.5초마다 백그라운드 재시도를 지속하여 '호스트 화면 연결 중' 무한 정체 방지
   */
  _startConnectionWatchdog() {
    if (this._connWatchdogTimer) return;
    this._connWatchdogTimer = setInterval(async () => {
      // 화면 공유 중이거나 스트림이 없으면 패스
      if (this.sharingScreen || !this._streamActive) return;

      const v = this.videoEl;
      const isLive = this.hasLiveVideo();

      if (!isLive || (v && v.paused)) {
        // 아직 비디오가 제대로 연결되지 않았거나 멈춰있는 경우 자동 복구 시도
        try {
          if (this.sfu && !this.sfu._closed) {
            await this.sfu.consumeExistingProducers();
            await this.sfu.resumeAllConsumers();
            for (const consumer of this.sfu.consumers.values()) {
              if (consumer && !consumer.closed && consumer.kind === 'video') {
                this.sfu.requestKeyFrame(consumer.id).catch(() => {});
              }
            }
          }
          if (v && v.srcObject) {
            v.play().catch(() => {});
          }
          if (!this._watchChain) {
            this.watch().catch(() => {});
          }
        } catch { /* ignore watchdog transient errors */ }
      }
    }, 2500);
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
      // 실제 네트워크 패킷 중단(WebRTC track.muted === true) 시에만 최소 3초 간격 키프레임 요청
      const track = v.srcObject?.getVideoTracks?.()[0];
      const now = Date.now();
      if (track && track.readyState === 'live' && track.muted) {
        if (now - lastPliTime > 3000) {
          lastPliTime = now;
          this.sfu?.requestKeyFrame?.();
          this.sfu?.resumeAllConsumers?.();
          v.play().catch(() => {});
        }
      }
    }, 1500);
  }

  async watch() {
    this._streamActive = true;
    this._startFreezeWatchdog();
    this._startConnectionWatchdog();
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
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    this.onStatus({
      streamActive: true,
      playing: false,
      connectError: lastErr?.message || '호스트 화면 준비 중…',
    });
    // 실패하더라도 throw하지 않고 워치독이 백그라운드에서 복구를 이어가도록 boolean 반환
    return false;
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
   * 개별 원격 오디오 트랙(호스트 마이크, 참가자 마이크, 탭 오디오) 재생
   * 트랙별 독립 <audio> 요소를 생성하여 다른 참가자의 소리를 절대 파괴하지 않음.
   * @param {MediaStreamTrack} track
   * @param {string} clientId
   * @param {string} source
   */
  _playRemoteAudioTrack(track, clientId, source = '') {
    if (!track || track.readyState === 'ended') return;
    if (!this._remoteAudioEls) this._remoteAudioEls = new Map();
    this._ensureGlobalAudioUnlock();

    const key = `${clientId || 'remote'}:${track.id}`;
    let el = this._remoteAudioEls.get(key);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', '');
      el.playsInline = true;
      el.volume = 1;
      this._visuallyHideMediaEl(el);
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this._remoteAudioEls.set(key, el);
    } else {
      const cur = el.srcObject;
      const curTrack = cur instanceof MediaStream ? cur.getAudioTracks()[0] : null;
      if (curTrack !== track) {
        el.srcObject = new MediaStream([track]);
      }
    }

    el.muted = !this.speakerOn;
    if (this.speakerOn) {
      el.play().then(() => {
        this._audioUnlocked = true;
      }).catch((err) => {
        console.warn('[ViewerSubscriber] remote audio autoplay blocked, waiting for gesture:', err?.message || err);
        this.onStatus({
          streamActive: this._streamActive,
          playing: this.hasLiveVideo(),
          hasRemoteAudio: true,
          needUnmute: true,
        });
      });
    }

    track.addEventListener('ended', () => {
      this._cleanupRemoteAudioTrack(key, clientId);
    }, { once: true });
  }

  _cleanupRemoteAudioTrack(key, clientId) {
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
  }

  /**
   * 원격 스트림 내 오디오 트랙 재생 동기화 (기존 재생 중인 다른 참가자 요소를 파괴하지 않음)
   * @param {MediaStream} stream
   */
  async _syncRemoteAudio(stream) {
    if (!stream) return;
    const tracks = (stream.getAudioTracks() || []).filter(
      (t) => t && t.readyState !== 'ended'
    );
    for (const track of tracks) {
      this._playRemoteAudioTrack(track, null, 'stream-sync');
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
    this._syncRemoteAudio(stream).catch((err) => {
      console.warn('[ViewerSubscriber] sync audio', err);
    });
    const video = this.videoEl;
    if (!video) return;

    const vtracks = (stream.getVideoTracks() || []).filter((t) => {
      if (!t || t.readyState === 'ended') return false;
      if (this._cameraTrackIds.has(t.id)) return false;
      if (this._spotlightTrackId && t.id === this._spotlightTrackId) return false;
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
        streamActive: this._streamActive,
        hasRemoteAudio: true,
        needUnmute: this.speakerOn && !this._audioUnlocked,
      });
    }
  }

  clearRemote({ videoOnly = false } = {}) {
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
    // 양방향 방에서는 화면 송출이 중단되어도 음성(마이크) 재생을 유지한다
    const shouldClearAudio = !videoOnly && this.interactionMode === 'unidirectional';
    if (shouldClearAudio && this._remoteAudioEls) {
      for (const el of this._remoteAudioEls.values()) {
        try { el.pause(); } catch { /* ignore */ }
        el.srcObject = null;
        try { el.remove(); } catch { /* ignore */ }
      }
      this._remoteAudioEls.clear();
    }
    if (shouldClearAudio && this._remoteAudioEl) {
      try { this._remoteAudioEl.pause(); } catch { /* ignore */ }
      this._remoteAudioEl.srcObject = null;
      try { this._remoteAudioEl.remove(); } catch { /* ignore */ }
      this._remoteAudioEl = null;
    }
    if (shouldClearAudio) this._remoteAudioStream = null;
    if (this.sfu && shouldClearAudio) {
      try {
        for (const track of [...(this.sfu.remoteStream?.getTracks?.() || [])]) {
          try { this.sfu.remoteStream.removeTrack(track); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
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
    if (this.hasLiveVideo() || this._streamActive) return;
    this.onStatus({ streamActive: false, streamEnded: true, playing: false });
  }

  async unlockAudio() {
    this._audioUnlocked = true;
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
    const hasAudio = !!(this._remoteAudioEls && this._remoteAudioEls.size > 0);
    this.onStatus({
      streamActive: this._streamActive,
      playing: this.hasLiveVideo(),
      hasRemoteAudio: hasAudio,
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
    // 마이크 송출: 서버가 produce를 거부(단방향 방 등)하거나 send transport가
    // 만료되면 예외가 나는데, 그대로 두면 "마이크를 켰는데 호스트에게 안 들림"
    // 상태가 된다. 트랜스포트를 재생성해 1회 재시도한다.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const sfu = await this._ensureSfu();
        await sfu.publishStream(this._micStream, { source: 'viewer-mic' });
        this._reportAudioDiag('mic-produce', audioTrack, `ok attempt=${attempt + 1}`);
        return;
      } catch (err) {
        console.warn(`[ViewerSubscriber] mic produce attempt ${attempt + 1} failed`, err);
        try { this.sfu?.sendTransportAudio?.close?.(); } catch { /* ignore */ }
        if (this.sfu) this.sfu.sendTransportAudio = null;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this._reportAudioDiag('mic-produce', audioTrack, 'failed');
    throw new Error('마이크 송출 실패');
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
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 2560, max: 3840 },
          height: { ideal: 1440, max: 2160 },
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
    return openWebcamFlexible();
  }

  /** 직송 정상 동안의 SFU 카메라 송출 프로파일 (폴백용: 끊기지 않을 정도의 저fps/저비트레이트) */
  _feedSaveProfile() {
    return { maxBitrate: 100_000, fps: 3 };
  }

  /** 지금 적용해야 할 카메라 송출 프로파일 (절감 모드면 저fps, 아니면 방 인원 기반 프로파일) */
  _currentFaceProfile() {
    return this._feedSave ? this._feedSaveProfile() : this.avatarManager.getFaceProfile();
  }

  /**
   * 서버의 feed 상태 통지 반영.
   *  live=true  → SFU 카메라 송출을 저fps 로 (서버가 4초마다 재통지하므로 재송출/재접속에도 다시 적용됨)
   *  live=false → 즉시 원래 프로파일로 복원
   * 통지가 8초간 없으면(서버/연결 이상) 안전하게 복원한다.
   */
  _setFeedSave(live) {
    clearTimeout(this._feedSaveTimer);
    this._feedSaveTimer = null;
    if (live) {
      this._feedSaveTimer = setTimeout(() => this._setFeedSave(false), 8000);
    }
    const changed = this._feedSave !== live;
    this._feedSave = live;
    // 상태가 바뀌었거나 live 재통지(새 producer 가 기본값으로 떠 있을 수 있음)일 때 적용
    if (!changed && !live) return;
    if (!this.sfu) return;
    this.sfu.updateCameraEncodings?.('viewer-camera', this._currentFaceProfile())?.catch?.(() => {});
  }

  /**
   * 방 인원 수에 따라 얼굴 송출 화질 자동 전환
   * 2~6명 960×540 / 7~12명 640×360 / 13~20명 512×288 / 21~30명 384×216 / 31명+ 320×180
   * (클라이언트는 업로드만 — 타인 얼굴 수신/디코드 없음)
   */
  async setFaceQualityByRoomSize(totalPeople = 1) {
    const count = Math.max(1, Number(totalPeople) || 1);
    this._faceRoomCount = count;
    if (!this.avatarManager) return;
    const mode = faceModeForRoomCount(count);
    // 카메라가 비활성 상태(사용자가 켜지 않음)일 때는 canvas 출력 스트림을 생성/재할당하지 않음
    if (!this.cameraWanted || !this.cameraStream) {
      this.avatarManager.setFaceMode(mode);
      const idleProfile = this._currentFaceProfile();
      if (this.sfu) {
        await this.sfu.updateCameraEncodings?.('viewer-camera', idleProfile).catch(() => {});
      }
      return;
    }
    const prevTrack = this.cameraStream?.getVideoTracks?.()[0] || null;
    const recreated = this.avatarManager.setFaceMode(mode);
    const profile = this._currentFaceProfile();
    const outgoing = this.avatarManager.getOutputStream();
    this.cameraStream = outgoing;
    const nextTrack = outgoing?.getVideoTracks?.()[0] || null;
    if (this.cameraWanted && this.sfu && nextTrack && (recreated || nextTrack !== prevTrack)) {
      try {
        await this.sfu.publishStream(outgoing, {
          source: 'viewer-camera',
          trackKind: 'camera',
        });
        await this.sfu.updateCameraEncodings?.('viewer-camera', profile);
      } catch (err) {
        console.warn('[ViewerSubscriber] face quality switch', err);
      }
      this.onCameraChange?.({ active: true, stream: outgoing });
    } else if (this.sfu) {
      await this.sfu.updateCameraEncodings?.('viewer-camera', profile).catch(() => {});
    }
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
      let hadExisting = false;
      if (this.rawCameraStream) {
        this.rawCameraStream.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        this.rawCameraStream = null;
        hadExisting = true;
      }
      if (this.cameraStream && this.cameraStream !== this.rawCameraStream) {
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
        stream = await this._obtainCameraStream();
      } catch (camErr) {
        console.warn('[ViewerSubscriber] 실물 웹캠 시작 불가(장치 없음/권한 거부/점유 중 등):', camErr);
        this._lastCameraError = camErr;
        this.cameraWanted = false;
        this.cameraStream = null;
        this.rawCameraStream = null;
        this.onCameraChange?.({ active: false, stream: null });
        return false;
      }
      this.rawCameraStream = stream;

      // VirtualAvatarManager에 실제 웹캠 스트림 및 마이크 연결 후 실물 모드 활성화
      const mode = faceModeForRoomCount(this._faceRoomCount || 1);
      this.avatarManager.setFaceMode(mode);
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
      this._lastCameraError = err;
      this.cameraWanted = false;
      this.cameraStream = null;
      this.rawCameraStream = null;
      this.onCameraChange?.({ active: false, stream: null });
      return false;
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
      const mode = faceModeForRoomCount(this._faceRoomCount || 1);
      this.avatarManager.setFaceMode(mode);
      if (!this.avatarManager._getActivePhotoImg?.()) {
        this.avatarManager._loadDefaultPhoto?.();
      }
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

  /**
   * 호스트가 "PC 화면"을 보여주는 동안(on=true) 얼굴 송출을 통째로 멈춘다.
   *  - 딥페이크 프레임 업로드 + GPU 처리 중단 (서버 연결/자리는 예약 유지)
   *  - SFU 카메라 영상 업로드 중단 (인코딩 자체를 멈춤)
   * 마이크(viewer-mic)는 건드리지 않으므로 목소리는 그대로 전달된다. 해제하면 즉시 재개.
   */
  setCameraIdle(on) {
    this._cameraWantedIdle = !!on;
    const isMeSpotlight = !!(this._spotlightSpeakerId && this._spotlightSpeakerId === this.signaling?.localClientId);
    const effectiveIdle = !!on && !isMeSpotlight;
    this._cameraIdle = effectiveIdle;
    try { this.avatarManager?.setIdle?.(effectiveIdle); } catch { /* ignore */ }
    this.sfu?.setVideoSourceActive?.('viewer-camera', !effectiveIdle)?.catch?.(() => {});
  }

  setSpotlightSpeaker({ clientId, name, role } = {}) {
    const prevId = this._spotlightSpeakerId;
    this._spotlightSpeakerId = clientId || this.hostPeerId || null;
    this._spotlightSpeakerName = name || (role === 'host' ? '호스트' : '참가자');
    this._spotlightSpeakerRole = role || 'host';

    const isLocalMe = (this._spotlightSpeakerId === this.signaling?.localClientId);

    if (isLocalMe) {
      if (this._cameraIdle) {
        this.setCameraIdle(false);
      }
      this.onSpotlightStream?.({
        clientId: this._spotlightSpeakerId,
        name: this._spotlightSpeakerName,
        role: this._spotlightSpeakerRole,
        stream: this.cameraStream || null,
      });
      return;
    }

    if (prevId === this.signaling?.localClientId && this._cameraWantedIdle) {
      this.setCameraIdle(true);
    }

    if (prevId !== this._spotlightSpeakerId && this._spotlightConsumer) {
      try { this._spotlightConsumer.close(); } catch { /* ignore */ }
      this._spotlightConsumer = null;
      this._spotlightTrackId = null;
    }

    if (this.sfu && !this.sfu._closed) {
      this.sfu.consumeExistingProducers().catch(() => {});
    }
  }

  getSpotlightStream() {
    if (this._spotlightConsumer && this._spotlightConsumer.track && this._spotlightConsumer.track.readyState === 'live') {
      return new MediaStream([this._spotlightConsumer.track]);
    }
    return null;
  }

  destroy() {
    this._stopProducerResync();
    if (this._freezeWatchdogTimer) {
      clearInterval(this._freezeWatchdogTimer);
      this._freezeWatchdogTimer = null;
    }
    if (this._streamOffTimer) {
      clearTimeout(this._streamOffTimer);
      this._streamOffTimer = null;
    }
    clearTimeout(this._feedSaveTimer);
    this._feedSaveTimer = null;
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
