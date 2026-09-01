export class OverlayManager {
  constructor(options = {}) {
    this.isHost = options.isHost ?? false;
    this.onOpenLink = options.onOpenLink || (() => {});
    this.onCloseLink = options.onCloseLink || (() => {});
    this.onPlayVideo = options.onPlayVideo || (() => {});
    this.onCloseVideo = options.onCloseVideo || (() => {});
    this.onVideoControl = options.onVideoControl || (() => {});
    this.onPlayAudio = options.onPlayAudio || (() => {});
    this.onCloseAudio = options.onCloseAudio || (() => {});
    this.onAudioControl = options.onAudioControl || (() => {});

    this.linkPopup = document.getElementById('link-popup');
    this.popupTitle = document.getElementById('popup-title');
    this.popupIframe = document.getElementById('popup-iframe');
    this.popupClose = document.getElementById('popup-close');
    this.popupFallback = document.getElementById('popup-fallback');
    this.popupFallbackMsg = document.getElementById('popup-fallback-msg');
    this.popupFallbackOpen = document.getElementById('popup-fallback-open');
    this.popupOpenExt = document.getElementById('popup-open-ext');
    this.popupPenBtn = document.getElementById('btn-popup-pen');
    this.linkDrawCanvas = document.getElementById('link-draw-canvas');

    this.videoOverlay = document.getElementById('video-overlay');
    this.syncVideo = document.getElementById('sync-video');
    this.videoClose = document.getElementById('video-close');
    this.syncAudio = document.getElementById('sync-audio');
    this.unmuteBanner = document.getElementById('unmute-banner');
    this.videoDrawCanvas = document.getElementById('video-draw-canvas');

    this.onVideoDrawSurface = options.onVideoDrawSurface || (() => {});
    this.onLinkDrawSurface = options.onLinkDrawSurface || (() => {});
    this.onPenModeChange = options.onPenModeChange || (() => {});
    this._iframeWatch = null;
    this._currentLinkUrl = null;
    this._linkPenActive = false;
    this._preferPen = true;

    this._suppressVideoEvents = false;
    this._suppressAudioEvents = false;
    this._audioAcross = false;
    this._audioName = null;
    this._audioUnlocked = false;

    if (this.popupClose) {
      this.popupClose.addEventListener('click', () => this.closeLink(true));
    }
    if (this.popupPenBtn && this.isHost) {
      this.popupPenBtn.classList.remove('hidden');
      this.popupPenBtn.addEventListener('click', () => this.togglePenMode());
    } else if (this.popupPenBtn) {
      this.popupPenBtn.classList.add('hidden');
    }
    if (this.videoClose) {
      this.videoClose.addEventListener('click', () => {
        this.closeVideo(true);
        if (this.isHost && this._audioAcross && this.syncAudio?.src) {
          this.resumeAudioIfAcross();
          this.onAudioControl({
            action: 'play',
            currentTime: this.syncAudio.currentTime || 0,
            name: this._audioName,
          });
        }
      });
    }

    this.unmuteBanner?.addEventListener('click', () => {
      this.unlockAudio();
      this.hideUnmuteBanner();
      if (this.syncVideo && !this.videoOverlay?.classList.contains('hidden')) {
        this.syncVideo.muted = false;
        this.syncVideo.volume = 1;
        this.syncVideo.play().catch(() => {});
      }
      if (this.syncAudio?.src) {
        this.syncAudio.muted = false;
        this.syncAudio.volume = 1;
        this.syncAudio.play().catch(() => {});
      }
    });

    if (!this.isHost) {
      this.installUnlockGesture();
    }

    if (this.isHost && this.syncVideo) {
      this.syncVideo.addEventListener('play', () => {
        if (this._suppressVideoEvents) return;
        this.onVideoControl({ action: 'play', currentTime: this.syncVideo.currentTime });
      });
      this.syncVideo.addEventListener('pause', () => {
        if (this._suppressVideoEvents) return;
        this.onVideoControl({ action: 'pause', currentTime: this.syncVideo.currentTime });
      });
      this.syncVideo.addEventListener('seeked', () => {
        if (this._suppressVideoEvents) return;
        this.onVideoControl({ action: 'seek', currentTime: this.syncVideo.currentTime });
      });
    }

    if (this.isHost && this.syncAudio) {
      this.syncAudio.addEventListener('play', () => {
        if (this._suppressAudioEvents) return;
        this.onAudioControl({ action: 'play', currentTime: this.syncAudio.currentTime, name: this._audioName });
      });
      this.syncAudio.addEventListener('pause', () => {
        if (this._suppressAudioEvents) return;
        this.onAudioControl({ action: 'pause', currentTime: this.syncAudio.currentTime, name: this._audioName });
      });
      this.syncAudio.addEventListener('seeked', () => {
        if (this._suppressAudioEvents) return;
        this.onAudioControl({ action: 'seek', currentTime: this.syncAudio.currentTime, name: this._audioName });
      });
    }
  }

  installUnlockGesture() {
    const unlock = () => {
      this.unlockAudio();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  unlockAudio() {
    this._audioUnlocked = true;
    [this.syncVideo, this.syncAudio].forEach((el) => {
      if (!el) return;
      el.muted = false;
      el.volume = 1;
    });
    // 브라우저 오디오 컨텍스트 깨우기
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.01);
      }
    } catch { /* ignore */ }
  }

  showUnmuteBanner() {
    this.unmuteBanner?.classList.remove('hidden');
  }

  hideUnmuteBanner() {
    this.unmuteBanner?.classList.add('hidden');
  }

  async playWithSound(el) {
    if (!el) return;
    el.muted = false;
    el.volume = 1;
    try {
      await el.play();
      this.hideUnmuteBanner();
    } catch {
      try {
        el.muted = true;
        await el.play();
        el.muted = false;
        await el.play();
        this.hideUnmuteBanner();
      } catch {
        this.showUnmuteBanner();
      }
    }
  }

  async showLink(url) {
    // 구 임베드/폴백 경로 제거 — 무조건 새 창
    if (!url) return;
    this._currentLinkUrl = url;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch { /* ignore */ }
  }

  get isPenMode() {
    return !!this._linkPenActive;
  }

  togglePenMode() {
    this.setPenMode(!this._linkPenActive);
  }

  toggleLinkPen() {
    this.togglePenMode();
  }

  /** 펜 ON: 영상/웹 위 낙서 · OFF: 재생·웹 조작 */
  setPenMode(active, { remember = true } = {}) {
    this._linkPenActive = !!active;
    if (remember) this._preferPen = this._linkPenActive;
    document.body.classList.toggle('pen-mode', this._linkPenActive);
    this.linkPopup?.classList.toggle('pen-active', this._linkPenActive);
    this.popupPenBtn?.classList.toggle('is-active', this._linkPenActive);
    if (this.popupPenBtn) {
      this.popupPenBtn.title = this._linkPenActive
        ? '펜 끄기 (웹 화면 조작)'
        : '펜으로 그리기';
      this.popupPenBtn.setAttribute('aria-pressed', this._linkPenActive ? 'true' : 'false');
    }
    try {
      window.__yunseulDrawCanvas?.setDrawingEnabled?.(this._linkPenActive);
    } catch { /* ignore */ }
    this.onPenModeChange(this._linkPenActive);
  }

  /** 선호 펜 모드로 복원 (링크 닫은 뒤 등) */
  restorePreferredPen() {
    this.setPenMode(this._preferPen !== false, { remember: false });
  }

  setLinkPen(active) {
    this.setPenMode(active);
  }

  hideLinkFallback() {
    this.popupFallback?.classList.add('hidden');
    if (this._iframeWatch) {
      clearTimeout(this._iframeWatch);
      this._iframeWatch = null;
    }
  }

  closeLink(broadcast = false) {
    if (this.linkPopup) {
      this.hideLinkFallback();
      this.onLinkDrawSurface({ active: false, canvas: this.linkDrawCanvas });
      this.linkPopup.classList.add('hidden');
      if (this.popupIframe) this.popupIframe.src = 'about:blank';
      this._currentLinkUrl = null;
      this.restorePreferredPen();
    }
    if (broadcast && this.isHost) {
      this.onCloseLink();
    }
  }

  handleRemoteOpenLink(data) {
    if (!data?.url) return;
    this.showLink(data.url);
  }

  handleRemoteCloseLink() {
    this.closeLink(false);
  }

  showVideo(url) {
    if (!this.videoOverlay || !this.syncVideo) return;
    this.pauseAudioOnly();
    this._suppressVideoEvents = true;
    this.syncVideo.src = url;
    this.syncVideo.muted = false;
    this.syncVideo.volume = 1;
    this.videoOverlay.classList.remove('hidden');
    this.videoOverlay.classList.add('has-video');
    // 동영상 위 낙서 레이어 활성 (호스트)
    this.onVideoDrawSurface({ active: true, canvas: this.videoDrawCanvas });
    this.playWithSound(this.syncVideo).finally(() => {
      this._suppressVideoEvents = false;
    });
  }

  closeVideo(broadcast = false) {
    if (!this.videoOverlay || !this.syncVideo) return;
    this._suppressVideoEvents = true;
    this.syncVideo.pause();
    this.syncVideo.removeAttribute('src');
    this.syncVideo.load();
    this.videoOverlay.classList.add('hidden');
    this.videoOverlay.classList.remove('has-video');
    this.onVideoDrawSurface({ active: false, canvas: this.videoDrawCanvas });
    this._suppressVideoEvents = false;
    if (broadcast && this.isHost) {
      this.onCloseVideo();
    }
  }

  handleRemotePlayVideo(data) {
    if (!data?.url) return;
    this.showVideo(data.url);
    if (data.currentTime) {
      this.syncVideo.currentTime = data.currentTime;
    }
  }

  handleRemoteCloseVideo() {
    this.closeVideo(false);
  }

  handleRemoteVideoControl(data) {
    if (!this.syncVideo) return;
    this._suppressVideoEvents = true;
    if (data.action === 'play') {
      if (typeof data.currentTime === 'number') this.syncVideo.currentTime = data.currentTime;
      this.playWithSound(this.syncVideo).finally(() => {
        this._suppressVideoEvents = false;
      });
      return;
    }
    if (data.action === 'pause') {
      if (typeof data.currentTime === 'number') this.syncVideo.currentTime = data.currentTime;
      this.syncVideo.pause();
    } else if (data.action === 'seek') {
      if (typeof data.currentTime === 'number') this.syncVideo.currentTime = data.currentTime;
    }
    this._suppressVideoEvents = false;
  }

  /** 배경/슬라이드 오디오 */
  showAudio(url, { name = null, currentTime = 0, loop = false, across = false } = {}) {
    if (!this.syncAudio || !url) return;
    this._audioName = name;
    this._audioAcross = !!across;
    this._suppressAudioEvents = true;
    this.syncAudio.loop = !!loop;
    this.syncAudio.src = url;
    this.syncAudio.muted = false;
    this.syncAudio.volume = 1;
    if (currentTime) this.syncAudio.currentTime = currentTime;
    this.playWithSound(this.syncAudio).finally(() => {
      this._suppressAudioEvents = false;
    });
  }

  pauseAudioOnly() {
    if (!this.syncAudio) return;
    this._suppressAudioEvents = true;
    try { this.syncAudio.pause(); } catch { /* ignore */ }
    this._suppressAudioEvents = false;
  }

  resumeAudioIfAcross() {
    if (!this.syncAudio?.src || !this._audioAcross) return;
    this.playWithSound(this.syncAudio);
  }

  isAcrossAudioPlaying() {
    return !!(this._audioAcross && this.syncAudio?.src && !this.syncAudio.paused);
  }

  closeAudio(broadcast = false) {
    if (!this.syncAudio) return;
    this._suppressAudioEvents = true;
    this.syncAudio.pause();
    this.syncAudio.removeAttribute('src');
    this.syncAudio.load();
    this._audioAcross = false;
    this._audioName = null;
    this._suppressAudioEvents = false;
    if (broadcast && this.isHost) {
      this.onCloseAudio();
    }
  }

  handleRemotePlayAudio(data) {
    if (!data?.url) return;
    this.showAudio(data.url, {
      name: data.name,
      currentTime: data.currentTime || 0,
      loop: !!data.loop,
      across: !!data.across,
    });
  }

  handleRemoteCloseAudio() {
    this.closeAudio(false);
  }

  handleRemoteAudioControl(data) {
    if (!this.syncAudio) return;
    this._suppressAudioEvents = true;
    if (data.action === 'play') {
      if (typeof data.currentTime === 'number') this.syncAudio.currentTime = data.currentTime;
      this.playWithSound(this.syncAudio).finally(() => {
        this._suppressAudioEvents = false;
      });
      return;
    }
    if (data.action === 'pause') {
      if (typeof data.currentTime === 'number') this.syncAudio.currentTime = data.currentTime;
      this.syncAudio.pause();
    } else if (data.action === 'seek') {
      if (typeof data.currentTime === 'number') this.syncAudio.currentTime = data.currentTime;
    }
    this._suppressAudioEvents = false;
  }
}
