/**
 * virtual-avatar-manager.js
 * 1) 12종의 연예인 스타일 가상 얼굴 아바타 로스터
 * 2) 중복 없는 랜덤 얼굴 셔플 덱 (Non-repeating Deck)
 * 3) 실시간 캔버스 렌더링 루프 (눈 깜빡임 + 마이크 음성 립싱크 + 미세 호흡 모션)
 * 4) 딜레이 0초 무중단 WebRTC 캡처 스트림 (가상 얼굴 <-> 실물 웹캠 즉시 전환)
 */

/**
 * 실사 AI 영웅 아바타 목록 (photo/ 폴더 사진 기반)
 */
export const HERO_AVATARS = [
  {
    id: 'hero-superman',
    heroId: 'superman',
    name: '슈퍼맨 (Superman)',
    badge: 'DC 히어로 / 실사 AI',
    photo: 'photo/superman.jpg',
    isHero: true,
    bg: ['#0f172a', '#1e3a8a'],
  },
  {
    id: 'hero-batman',
    heroId: 'batman',
    name: '배트맨 (Batman)',
    badge: '다크나이트 / 실사 AI',
    photo: 'photo/batman.jpg',
    isHero: true,
    bg: ['#09090b', '#18181b'],
  },
  {
    id: 'hero-spiderman',
    heroId: 'spiderman',
    name: '스파이더맨 (Spider-Man)',
    badge: '마블 히어로 / 실사 AI',
    photo: 'photo/spiderman.jpg',
    isHero: true,
    bg: ['#1c1917', '#450a0a'],
  },
];

export const CELEBRITY_AVATARS = [
  {
    id: 'celeb-1',
    name: '한류 톱스타 (현우)',
    badge: '로맨스 드라마 남주',
    gender: 'male',
    bg: ['#1e1b4b', '#0f172a'],
    skin: '#fde8d7',
    skinShadow: '#ebd0be',
    hair: '#1c1917',
    hairStyle: 'dandy',
    eyeColor: '#3c2415',
    lipColor: '#d9777f',
    outfit: 'black-suit',
    accessory: 'none',
  },
  {
    id: 'celeb-2',
    name: 'K-POP 아이돌 (지수)',
    badge: '걸그룹 비주얼 센터',
    gender: 'female',
    bg: ['#4c0519', '#1e1b4b'],
    skin: '#fff1f2',
    skinShadow: '#fed7aa',
    hair: '#451a03',
    hairStyle: 'idol_waves',
    eyeColor: '#451a03',
    lipColor: '#e11d48',
    outfit: 'stage-dress',
    accessory: 'earring-drop',
  },
  {
    id: 'celeb-3',
    name: '시크 액션스타 (준혁)',
    badge: '카리스마 액션 주연',
    gender: 'male',
    bg: ['#1c1917', '#09090b'],
    skin: '#f5d0b5',
    skinShadow: '#deb092',
    hair: '#0c0a09',
    hairStyle: 'pompadour',
    eyeColor: '#1c1917',
    lipColor: '#c27178',
    outfit: 'leather-jacket',
    accessory: 'none',
  },
  {
    id: 'celeb-4',
    name: '로맨스 여신 (수빈)',
    badge: '청순 멜로 여배우',
    gender: 'female',
    bg: ['#2e1065', '#0f172a'],
    skin: '#fff5eb',
    skinShadow: '#fcd3b6',
    hair: '#291e17',
    hairStyle: 'long_elegance',
    eyeColor: '#2e1c10',
    lipColor: '#f43f5e',
    outfit: 'silk-blouse',
    accessory: 'pearl-necklace',
  },
  {
    id: 'celeb-5',
    name: '힙합 트렌드세터 (민재)',
    badge: '글로벌 음원 차트 1위',
    gender: 'male',
    bg: ['#042f2e', '#0f172a'],
    skin: '#f8d7be',
    skinShadow: '#e6bd9f',
    hair: '#e2e8f0',
    hairStyle: 'street_beanie',
    eyeColor: '#262626',
    lipColor: '#cf757d',
    outfit: 'street-hoodie',
    accessory: 'chain-necklace',
  },
  {
    id: 'celeb-6',
    name: '파리 패션모델 (유나)',
    badge: '하이패션 런웨이 뮤즈',
    gender: 'female',
    bg: ['#3b0764', '#18181b'],
    skin: '#fff1e6',
    skinShadow: '#fbd0b8',
    hair: '#09090b',
    hairStyle: 'bob_cut',
    eyeColor: '#172554',
    lipColor: '#be123c',
    outfit: 'high-neck',
    accessory: 'bold-earring',
  },
  {
    id: 'celeb-7',
    name: '헐리우드 젠틀맨 (다니엘)',
    badge: '클래식 영화제 남우주연',
    gender: 'male',
    bg: ['#0f172a', '#1e293b'],
    skin: '#fae4d2',
    skinShadow: '#e3c6af',
    hair: '#44281d',
    hairStyle: 'tux_classic',
    eyeColor: '#1e3a5f',
    lipColor: '#c7787f',
    outfit: 'classic-tuxedo',
    accessory: 'bowtie',
  },
  {
    id: 'celeb-8',
    name: '글램 팝 디바 (올리비아)',
    badge: '월드투어 솔로 팝스타',
    gender: 'female',
    bg: ['#701a75', '#1e1b4b'],
    skin: '#ffeedd',
    skinShadow: '#f8cfb4',
    hair: '#fef08a',
    hairStyle: 'blonde_glam',
    eyeColor: '#0284c7',
    lipColor: '#fb7185',
    outfit: 'sequin-top',
    accessory: 'choker',
  },
  {
    id: 'celeb-9',
    name: '스마트 로코 남주 (서진)',
    badge: '지적인 변호사/의사 역',
    gender: 'male',
    bg: ['#082f49', '#0f172a'],
    skin: '#fce3d0',
    skinShadow: '#e4c4ad',
    hair: '#1e1b18',
    hairStyle: 'smart_glasses',
    eyeColor: '#2b1b11',
    lipColor: '#c97a82',
    outfit: 'knit-blazer',
    accessory: 'glasses',
  },
  {
    id: 'celeb-10',
    name: '상큼 예능 스타 (채원)',
    badge: '국민 MC 비타민 스타',
    gender: 'female',
    bg: ['#831843', '#1e1b4b'],
    skin: '#fff2e8',
    skinShadow: '#fcd5bb',
    hair: '#78350f',
    hairStyle: 'bright_ponytail',
    eyeColor: '#451a03',
    lipColor: '#f43f5e',
    outfit: 'pastel-cardigan',
    accessory: 'heart-earring',
  },
  {
    id: 'celeb-11',
    name: '카리스마 록스타 (태민)',
    badge: '스타디움 록밴드 프론트맨',
    gender: 'male',
    bg: ['#312e81', '#09090b'],
    skin: '#f6d3bc',
    skinShadow: '#dfb79e',
    hair: '#172554',
    hairStyle: 'wolf_cut',
    eyeColor: '#1e293b',
    lipColor: '#ba6e75',
    outfit: 'rider-vest',
    accessory: 'piercing',
  },
  {
    id: 'celeb-12',
    name: '시상식 드레스 여신 (예진)',
    badge: '골든글로브 레드카펫 여신',
    gender: 'female',
    bg: ['#1e1b4b', '#3b0764'],
    skin: '#fff4eb',
    skinShadow: '#fbd4bc',
    hair: '#1c1917',
    hairStyle: 'updo_goddess',
    eyeColor: '#3c2415',
    lipColor: '#9f1239',
    outfit: 'evening-gown',
    accessory: 'diamond-necklace',
  },
];

/**
 * 중복 없는 랜덤 셔플 덱
 */
class NonRepeatingDeck {
  constructor(items) {
    this.items = items;
    this.pool = [];
    this.lastIndex = -1;
  }

  _refill() {
    this.pool = this.items.map((_, i) => i).filter((i) => i !== this.lastIndex);
    // Fisher-Yates shuffle
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  pickNext() {
    if (this.pool.length === 0) {
      this._refill();
    }
    this.lastIndex = this.pool.pop();
    return this.items[this.lastIndex];
  }

  pickInitial() {
    // 초기 랜덤 (다양성 보장)
    this.lastIndex = Math.floor(Math.random() * this.items.length);
    this._refill();
    return this.items[this.lastIndex];
  }
}

/**
 * 가상 얼굴 매니저
 */
export class VirtualAvatarManager {
  constructor({ width = 640, height = 360 } = {}) {
    this.width = width;
    this.height = height;
    this.isLarge = false; // 기본값: 작은 이미지(저부하 모드)
    this.deck = new NonRepeatingDeck(CELEBRITY_AVATARS);
    this._heroImages = new Map();
    HERO_AVATARS.forEach((h) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = h.photo;
      this._heroImages.set(h.heroId, img);
      this._heroImages.set(h.id, img);
    });
    // 기본 아바타: 실물 웹캠 모드가 기본 (선명한 30~60fps 무지연 송출)
    this.currentAvatar = HERO_AVATARS[0];
    this.mode = 'real';
    this.swapModeLock = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');

    this.rawWebcamVideo = document.createElement('video');
    this.rawWebcamVideo.autoplay = true;
    this.rawWebcamVideo.playsInline = true;
    this.rawWebcamVideo.muted = true;

    this.rawWebcamStream = null;
    this.outputStream = null;

    // 애니메이션 상태
    this._animId = null;
    this._blinkUntil = 0;
    this._nextBlinkTime = Date.now() + 2500;
    this._mouthOpen = 0; // 0 (closed) ~ 1 (wide open)
    this._smoothMouth = 0;

    // 오디오 VAD 모니터링
    this._audioCtx = null;
    this._analyser = null;
    this._audioBuf = null;

    this.onModeChange = null; // (mode: 'virtual'|'real'|'swap', avatar, swapFace) => void
    this.onAvatarChange = null; // (avatar) => void
    this.onResolutionChange = null; // (isLarge: boolean, w: number, h: number) => void

    // 실시간 Deep-Live-Cam 페이스 스왑 상태 (얼굴 선택 모달에서 선택 시 활성화)
    this.activeSwapFace = null;
    this._lastSwappedImage = null;
    this._lastSwappedUrl = null;
    this._swapBusy = false;
    this._lastSwapReqTime = 0;
    this._offscreenCanvas = null;
    this._offscreenCtx = null;
    this._ws = null;
    this._initSwapWebSocket();

    this._startRenderLoop();
  }

  /**
   * 화면 크기에 맞춰 동적 해상도 전환 (작은 화면: 640x360 저부하, 큰 화면: 1280x720 고화질)
   */
  setHighRes(isLarge) {
    this.isLarge = !!isLarge;
    const targetW = this.isLarge ? 1280 : 640;
    const targetH = this.isLarge ? 720 : 360;
    if (this.width !== targetW || this.height !== targetH) {
      this.width = targetW;
      this.height = targetH;
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      if (this._offscreenCanvas) {
        this._offscreenCanvas.width = targetW;
        this._offscreenCanvas.height = targetH;
      }
    }
    this.onResolutionChange?.(this.isLarge, targetW, targetH);
  }

  get isVirtual() {
    return this.mode === 'virtual';
  }

  get isReal() {
    return this.mode === 'real';
  }

  get isSwap() {
    return this.mode === 'swap';
  }

  get hasWebcamStream() {
    return !!this.rawWebcamStream && this.rawWebcamStream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  getCurrentAvatar() {
    return this.currentAvatar;
  }

  /**
   * 웹캠 원본 스트림 등록 (동적 해상도 반영)
   */
  setWebcamStream(stream) {
    this.rawWebcamStream = stream;
    if (stream) {
      if (this.activeSwapFace && this.activeSwapFace !== 'none' && this.activeSwapFace !== 'real') {
        this.mode = 'swap';
      }
      this.rawWebcamVideo.srcObject = stream;
      const updateDim = () => {
        const targetW = this.isLarge ? 1280 : 640;
        const targetH = this.isLarge ? 720 : 360;
        this.width = targetW;
        this.height = targetH;
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        if (this._offscreenCanvas) {
          this._offscreenCanvas.width = targetW;
          this._offscreenCanvas.height = targetH;
        }
      };
      this.rawWebcamVideo.onloadedmetadata = updateDim;
      this.rawWebcamVideo.play?.().then(updateDim).catch(() => {});
    } else {
      this.rawWebcamVideo.srcObject = null;
    }
  }

  /**
   * 마이크 오디오 트랙 등록 (실시간 립싱크용)
   */
  attachMicTrack(track) {
    if (!track || track.kind !== 'audio') {
      this._detachMic();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new AC();
      }
      if (this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      const clone = track.clone();
      const src = this._audioCtx.createMediaStreamSource(new MediaStream([clone]));
      const analyser = this._audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.2;
      src.connect(analyser);

      this._micClone = clone;
      this._analyser = analyser;
      this._audioBuf = new Uint8Array(analyser.frequencyBinCount);
    } catch (err) {
      console.warn('[Avatar] mic attach error', err);
    }
  }

  _detachMic() {
    if (this._micClone) {
      try { this._micClone.stop(); } catch { /* ignore */ }
      this._micClone = null;
    }
    this._analyser = null;
    this._audioBuf = null;
    this._mouthOpen = 0;
  }

  /**
   * WebRTC 송출용 캡처 스트림 반환
   */
  getOutputStream() {
    if (!this.outputStream || this.outputStream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      // 30fps 스트림 캡처
      this.outputStream = this.canvas.captureStream(30);
    }
    return this.outputStream;
  }

  /**
   * 모드 전환 ('virtual' | 'real' | 'swap')
   */
  setMode(newMode) {
    if (newMode === 'real') {
      this.activeSwapFace = null;
      this.mode = 'real';
    } else if (newMode === 'swap') {
      this.mode = 'swap';
    } else {
      this.mode = 'virtual';
    }
    this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
  }

  toggleMode() {
    if (this.activeSwapFace && this.activeSwapFace !== 'real' && this.activeSwapFace !== 'none') {
      this.mode = this.mode === 'swap' ? 'virtual' : 'swap';
      this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
      return;
    }
    if (this.mode === 'real') {
      this.setMode('virtual');
    } else {
      this.setMode('real');
    }
  }

  setRealMode() {
    this.activeSwapFace = null;
    this._lastSwappedImage = null;
    if (this._lastBitmap) {
      try { this._lastBitmap.close(); } catch { /* ignore */ }
      this._lastBitmap = null;
    }
    if (this._lastSwappedUrl) {
      try { URL.revokeObjectURL(this._lastSwappedUrl); } catch { /* ignore */ }
      this._lastSwappedUrl = null;
    }
    this.setMode('real');
  }

  /**
   * 실시간 Deep-Live-Cam 페이스 스왑 대상 얼굴 설정
   * @param {string} faceIdOrName ('superman' | 'batman' | 'spiderman' | 사진파일명)
   */
  setSwapFace(faceIdOrName) {
    const key = (faceIdOrName || 'superman').toLowerCase();
    this.activeSwapFace = key;
    // [사생활 절대 보호 및 부드러운 전환]
    // 새 얼굴의 첫 프레임이 도착할 때까지 이전 스왑 비트맵(_lastBitmap)을 계속 화면에 렌더링 유지.
    // 기존 이미지를 파기하지 않음으로써 얼굴 변경 시에도 원본 실물 얼굴이 1ms도 노출되지 않도록 완벽 보장합니다.

    const hero = HERO_AVATARS.find((h) => h.heroId === key || h.id === key || h.photo.includes(key));
    if (hero) {
      this.currentAvatar = hero;
    }

    this.mode = 'swap';

    this._initSwapWebSocket();

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({ type: 'set_source', source: this.activeSwapFace }));
      } catch { /* ignore */ }
    }

    this.onAvatarChange?.(this.currentAvatar);
    this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
    return this.activeSwapFace;
  }

  /**
  setRealMode() {
    this.activeSwapFace = null;
    this.mode = 'real';
    this._lastSwappedImage = null;
    this.onModeChange?.(this.mode, this.currentAvatar, null);
  }

  /**
   * 영웅 선택 (웹캠이 있으면 실시간 스왑, 없으면 가상 실사 아바타)
   */
  selectHero(heroId) {
    return this.setSwapFace(heroId);
  }

  /**
   * ID로 아바타 설정 (영웅 또는 연예인)
   */
  setAvatarById(id) {
    const hero = HERO_AVATARS.find((h) => h.id === id || h.heroId === id);
    if (hero) {
      return this.selectHero(hero.heroId);
    }
    const celeb = CELEBRITY_AVATARS.find((c) => c.id === id);
    if (celeb) {
      this.currentAvatar = celeb;
      this.mode = 'virtual';
      this.onAvatarChange?.(this.currentAvatar);
      this.onModeChange?.(this.mode, this.currentAvatar, null);
      return celeb;
    }
    return null;
  }

  getHeroes() {
    return HERO_AVATARS;
  }

  /**
   * 다음 가상 얼굴 선택 (영웅 3종 -> 연예인 덱 순환)
   */
  nextAvatar() {
    const heroIdx = HERO_AVATARS.findIndex((h) => h.id === this.currentAvatar?.id || h.heroId === this.currentAvatar?.heroId);
    if (heroIdx >= 0) {
      if (heroIdx < HERO_AVATARS.length - 1) {
        this.currentAvatar = HERO_AVATARS[heroIdx + 1];
      } else {
        this.currentAvatar = this.deck.pickNext();
      }
    } else {
      this.currentAvatar = this.deck.pickNext();
    }
    this.mode = 'virtual';
    this.onAvatarChange?.(this.currentAvatar);
    this.onModeChange?.(this.mode, this.currentAvatar);
    return this.currentAvatar;
  }

  _startRenderLoop() {
    let lastRenderTime = performance.now();
    const render = () => {
      lastRenderTime = performance.now();
      this._renderFrame();
      this._animId = requestAnimationFrame(render);
    };
    this._animId = requestAnimationFrame(render);

    // 브라우저 탭 비활성화 또는 백그라운드 전환 시 rAF 중단으로 인한 웹캠/아바타 멈춤 방지
    // 50ms 이상 rAF가 지연되면 인터벌이 강제로 프레임을 갱신하여 20~25fps 항시 보장
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (performance.now() - lastRenderTime > 50) {
        lastRenderTime = performance.now();
        this._renderFrame();
      }
    }, 45);
  }

  _updateMouthLevel() {
    if (!this._analyser || !this._audioBuf) {
      this._mouthOpen = 0;
      this._smoothMouth *= 0.8;
      return;
    }
    if (this._audioCtx?.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
    this._analyser.getByteTimeDomainData(this._audioBuf);
    let sum = 0;
    for (let i = 0; i < this._audioBuf.length; i++) {
      const v = (this._audioBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._audioBuf.length);
    // 목소리 볼륨에 비례하여 0~1 입 벌림 계산
    let target = 0;
    if (rms > 0.02) {
      target = Math.min(1, (rms - 0.02) * 12);
    }
    this._smoothMouth = this._smoothMouth * 0.4 + target * 0.6;
  }

  _drawFacePrivacyPlaceholder(ctx, w, h) {
    const a = this.currentAvatar;
    if (a?.isHero) {
      const now = Date.now();
      const isBlinking = now < this._blinkUntil;
      const t = now * 0.002;
      const breatheY = Math.sin(t) * 3.5;
      const headTilt = Math.cos(t * 0.6) * 0.015;
      this._drawHeroPhoto(ctx, a, w, h, breatheY, headTilt, isBlinking, this._smoothMouth);
      return;
    }
    // 일반 아바타 또는 기본 대기 화면 (실물 얼굴 100% 비노출 보호)
    ctx.save();
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, '#090d16');
    bgGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛡️ AI 가상 얼굴 보호 모드', w / 2, h / 2 - 14);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('실시간 AI 페이스를 적용하고 있습니다...', w / 2, h / 2 + 16);
    ctx.restore();
  }

  _renderFrame() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // [사생활 절대 보호 강제 가드]
    // 활성 스왑 얼굴(히어로 또는 업로드 사진)이 지정되어 있는 한,
    // 어떤 레이스 컨디션이나 일시적 오류에서도 mode를 'swap'으로 유지하여 실물 노출 원천 차단!
    if (this.activeSwapFace && this.activeSwapFace !== 'real' && this.activeSwapFace !== 'none') {
      this.mode = 'swap';
    } else if (this.mode === 'swap') {
      this.mode = 'real';
    }

    // 0. 실시간 Deep-Live-Cam 페이스 스왑 / 뷰티 모드
    if (this.mode === 'swap') {
      if (this.rawWebcamVideo.readyState >= 2) {
        this._requestFaceSwapFrame();

        ctx.save();
        if (this._lastBitmap) {
          ctx.drawImage(this._lastBitmap, 0, 0, w, h);
        } else if (this._lastSwappedImage && this._lastSwappedImage.complete && this._lastSwappedImage.naturalWidth) {
          ctx.drawImage(this._lastSwappedImage, 0, 0, w, h);
        } else {
          // [사생활 절대 보호] 첫 프레임 도착 전: 원본 실물 얼굴은 1ms도 노출하지 않고 가상 얼굴 플레이스홀더를 렌더링
          this._drawFacePrivacyPlaceholder(ctx, w, h);
        }
        ctx.restore();
      } else {
        this._drawFacePrivacyPlaceholder(ctx, w, h);
      }
      return;
    }

    // 1. 실물 얼굴 모드 (원본 웹캠의 선명한 화질을 100% 손실 없이 보존)
    if (this.mode === 'real') {
      // [이중 방어막] activeSwapFace가 존재하는 경우 실물 그리기 즉시 차단
      if (this.activeSwapFace && this.activeSwapFace !== 'real' && this.activeSwapFace !== 'none') {
        this.mode = 'swap';
        this._drawFacePrivacyPlaceholder(ctx, w, h);
        return;
      }
      if (this.rawWebcamVideo.readyState >= 2) {
        ctx.save();
        // 거울 반사 효과
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.rawWebcamVideo, 0, 0, w, h);
        ctx.restore();
      } else {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#64748b';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('카메라 영상 준비 중...', w / 2, h / 2);
      }
      return;
    }

    // 2. 가상 연예인 얼굴 모드
    this._updateMouthLevel();

    const now = Date.now();
    // 눈 깜빡임 주기
    if (now > this._nextBlinkTime) {
      this._blinkUntil = now + 120; // 120ms 감김
      this._nextBlinkTime = now + 2500 + Math.random() * 2500;
    }
    const isBlinking = now < this._blinkUntil;

    // 미세 호흡/스웨이 모션 (자연스러운 생동감)
    const t = now * 0.002;
    const breatheY = Math.sin(t) * 3.5;
    const headTilt = Math.cos(t * 0.6) * 0.015;

    const a = this.currentAvatar;
    if (a?.isHero) {
      this._drawHeroPhoto(ctx, a, w, h, breatheY, headTilt, isBlinking, this._smoothMouth);
      this._drawAvatarBadge(ctx, a, w, h);
      return;
    }

    // 배경 렌더링 (스튜디오 그라디언트)
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, a.bg[0]);
    bgGrad.addColorStop(1, a.bg[1]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // 스튜디오 원형 소프트 라이팅
    const light = ctx.createRadialGradient(w * 0.5, h * 0.35, 30, w * 0.5, h * 0.35, 260);
    light.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
    light.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2 + breatheY);
    ctx.rotate(headTilt);

    // 어깨 및 의상 렌더링
    this._drawOutfit(ctx, a);

    // 목 렌더링
    this._drawNeck(ctx, a);

    // 머리카락 뒷부분
    this._drawHairBack(ctx, a);

    // 얼굴 윤곽 & 귀
    this._drawFaceBase(ctx, a);

    // 귀걸이/악세사리
    this._drawAccessories(ctx, a);

    // 눈썹
    this._drawEyebrows(ctx, a);

    // 눈 (깜빡임 반영)
    this._drawEyes(ctx, a, isBlinking);

    // 코
    this._drawNose(ctx, a);

    // 입 (립싱크 말하기 반영)
    this._drawMouth(ctx, a, this._smoothMouth);

    // 앞머리 / 헤어 스타일
    this._drawHairFront(ctx, a);

    ctx.restore();

    // 워터마크/아바타 배지 텍스트
    this._drawAvatarBadge(ctx, a, w, h);
  }

  _drawOutfit(ctx, a) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 240, 210, 120, 0, 0, Math.PI * 2);
    if (a.outfit.includes('suit') || a.outfit.includes('tuxedo')) {
      ctx.fillStyle = '#09090b';
      ctx.fill();
      // 셔츠 브이존
      ctx.beginPath();
      ctx.moveTo(-35, 140);
      ctx.lineTo(35, 140);
      ctx.lineTo(0, 210);
      ctx.closePath();
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      // 타이
      ctx.beginPath();
      ctx.moveTo(-10, 150);
      ctx.lineTo(10, 150);
      ctx.lineTo(6, 230);
      ctx.lineTo(0, 245);
      ctx.lineTo(-6, 230);
      ctx.closePath();
      ctx.fillStyle = '#0f172a';
      ctx.fill();
    } else if (a.outfit === 'leather-jacket') {
      ctx.fillStyle = '#18181b';
      ctx.fill();
      ctx.strokeStyle = '#3f3f46';
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (a.outfit === 'stage-dress' || a.outfit === 'evening-gown') {
      ctx.fillStyle = a.lipColor;
      ctx.fill();
    } else {
      ctx.fillStyle = '#27272a';
      ctx.fill();
    }
    ctx.restore();
  }

  _drawNeck(ctx, a) {
    ctx.fillStyle = a.skinShadow;
    ctx.fillRect(-32, 60, 64, 85);
    // 목 쇄골 그라데이션 음영
    const shadow = ctx.createLinearGradient(0, 60, 0, 110);
    shadow.addColorStop(0, 'rgba(0,0,0,0.22)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(-32, 60, 64, 50);
  }

  _drawHairBack(ctx, a) {
    if (['idol_waves', 'long_elegance', 'blonde_glam', 'wolf_cut'].includes(a.hairStyle)) {
      ctx.save();
      ctx.fillStyle = a.hair;
      ctx.beginPath();
      ctx.ellipse(0, 50, 120, 150, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawFaceBase(ctx, a) {
    // 귀
    ctx.fillStyle = a.skin;
    ctx.beginPath();
    ctx.ellipse(-86, 15, 14, 25, -0.1, 0, Math.PI * 2);
    ctx.ellipse(86, 15, 14, 25, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // 얼굴형 (샤프하고 매력적인 V라인)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, -90);
    ctx.bezierCurveTo(90, -90, 88, 10, 68, 60);
    ctx.bezierCurveTo(55, 95, 24, 115, 0, 120);
    ctx.bezierCurveTo(-24, 115, -55, 95, -68, 60);
    ctx.bezierCurveTo(-88, 10, -90, -90, 0, -90);
    ctx.closePath();

    ctx.fillStyle = a.skin;
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.restore();

    // 턱선 은은한 컨투어 음영
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-60, 70);
    ctx.quadraticCurveTo(0, 128, 60, 70);
    ctx.strokeStyle = a.skinShadow;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }

  _drawAccessories(ctx, a) {
    if (a.accessory === 'earring-drop' || a.accessory === 'bold-earring') {
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(-86, 36, 4.5, 0, Math.PI * 2);
      ctx.arc(86, 36, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (a.accessory === 'glasses') {
      ctx.strokeStyle = '#18181b';
      ctx.lineWidth = 3.5;
      ctx.strokeRect(-62, -18, 48, 30);
      ctx.strokeRect(14, -18, 48, 30);
      ctx.beginPath();
      ctx.moveTo(-14, -3);
      ctx.lineTo(14, -3);
      ctx.stroke();
    }
  }

  _drawEyebrows(ctx, a) {
    ctx.strokeStyle = a.hair;
    ctx.lineWidth = a.gender === 'male' ? 4.5 : 3;
    ctx.lineCap = 'round';

    // 좌
    ctx.beginPath();
    ctx.moveTo(-62, -32);
    ctx.quadraticCurveTo(-38, -42, -16, -33);
    ctx.stroke();

    // 우
    ctx.beginPath();
    ctx.moveTo(16, -33);
    ctx.quadraticCurveTo(38, -42, 62, -32);
    ctx.stroke();
  }

  _drawEyes(ctx, a, isBlinking) {
    const eyeY = -10;
    const eyeX = 38;

    if (isBlinking) {
      // 감은 눈 (매력적인 미소 눈웃음 라인)
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-eyeX - 18, eyeY);
      ctx.quadraticCurveTo(-eyeX, eyeY + 6, -eyeX + 18, eyeY);
      ctx.moveTo(eyeX - 18, eyeY);
      ctx.quadraticCurveTo(eyeX, eyeY + 6, eyeX + 18, eyeY);
      ctx.stroke();
      return;
    }

    // 뜬 눈
    [-eyeX, eyeX].forEach((x) => {
      // 흰자
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, eyeY, 18, 11, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 홍채 (눈동자)
      ctx.beginPath();
      ctx.ellipse(x, eyeY, 10.5, 10.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = a.eyeColor;
      ctx.fill();

      // 동공
      ctx.beginPath();
      ctx.ellipse(x, eyeY, 5, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#09090b';
      ctx.fill();

      // 눈동자 하이라이트 (초롱초롱 연예인 눈빛)
      ctx.beginPath();
      ctx.arc(x - 3.5, eyeY - 3.5, 2.5, 0, Math.PI * 2);
      ctx.arc(x + 3.5, eyeY + 2.5, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 아이라인 / 속눈썹
      ctx.beginPath();
      ctx.ellipse(x, eyeY - 1, 19, 12, 0, Math.PI * 1.1, Math.PI * 1.9);
      ctx.strokeStyle = '#18181b';
      ctx.lineWidth = a.gender === 'female' ? 2.8 : 1.8;
      ctx.stroke();

      ctx.restore();
    });
  }

  _drawNose(ctx, a) {
    ctx.strokeStyle = a.skinShadow;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(2, 28);
    ctx.lineTo(-4, 33);
    ctx.lineTo(4, 33);
    ctx.stroke();

    // 콧대 하이라이트
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 12, 1.5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawMouth(ctx, a, mouthOpen) {
    const mouthY = 65;
    const mouthW = 28 + mouthOpen * 4;
    const mouthH = 3 + mouthOpen * 18;

    ctx.save();
    if (mouthOpen > 0.12) {
      // 말하는 중: 벌려진 입 & 치아
      ctx.beginPath();
      ctx.ellipse(0, mouthY, mouthW, mouthH, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#4c0519'; // 입속 어두운 레드
      ctx.fill();
      ctx.strokeStyle = a.lipColor;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 상단 치아
      ctx.beginPath();
      ctx.rect(-mouthW * 0.6, mouthY - mouthH * 0.9, mouthW * 1.2, mouthH * 0.7);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    } else {
      // 닫힌 입: 매력적인 미소 립
      ctx.beginPath();
      ctx.moveTo(-mouthW, mouthY);
      ctx.quadraticCurveTo(0, mouthY + 5, mouthW, mouthY);
      ctx.quadraticCurveTo(0, mouthY - 3, -mouthW, mouthY);
      ctx.fillStyle = a.lipColor;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(-mouthW, mouthY);
      ctx.quadraticCurveTo(0, mouthY + 2, mouthW, mouthY);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawHairFront(ctx, a) {
    ctx.save();
    ctx.fillStyle = a.hair;

    switch (a.hairStyle) {
      case 'dandy': // 깔끔한 댄디 컷
        ctx.beginPath();
        ctx.ellipse(0, -75, 88, 55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-82, -45);
        ctx.quadraticCurveTo(-40, -42, 0, -48);
        ctx.quadraticCurveTo(40, -40, 82, -45);
        ctx.lineTo(82, -80);
        ctx.lineTo(-82, -80);
        ctx.closePath();
        ctx.fill();
        break;

      case 'idol_waves': // 화려한 웨이브 롱
        ctx.beginPath();
        ctx.ellipse(0, -75, 92, 60, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-88, -20);
        ctx.quadraticCurveTo(-95, 60, -75, 150);
        ctx.quadraticCurveTo(-55, 80, -65, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(88, -20);
        ctx.quadraticCurveTo(95, 60, 75, 150);
        ctx.quadraticCurveTo(55, 80, 65, 0);
        ctx.fill();
        break;

      case 'pompadour': // 카리스마 포마드
        ctx.beginPath();
        ctx.ellipse(0, -92, 78, 48, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-75, -55);
        ctx.lineTo(75, -55);
        ctx.lineTo(65, -80);
        ctx.lineTo(-65, -80);
        ctx.fill();
        break;

      case 'bob_cut': // 시크 단발
        ctx.beginPath();
        ctx.ellipse(0, -75, 90, 58, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(-88, -50, 24, 90);
        ctx.fillRect(64, -50, 24, 90);
        break;

      default: // 기본 자연스러운 헤어
        ctx.beginPath();
        ctx.ellipse(0, -75, 88, 55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-80, -40);
        ctx.quadraticCurveTo(0, -35, 80, -40);
        ctx.lineTo(80, -85);
        ctx.lineTo(-80, -85);
        ctx.closePath();
        ctx.fill();
        break;
    }

    // 헤어 윤기 하이라이트
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, -88, 65, Math.PI * 1.25, Math.PI * 1.75);
    ctx.stroke();

    ctx.restore();
  }

  _drawHeroPhoto(ctx, a, w, h, breatheY, headTilt, isBlinking, mouthLevel) {
    const img = this._heroImages?.get(a.heroId) || this._heroImages?.get(a.id);
    if (!img || !img.complete || !img.naturalWidth) {
      ctx.fillStyle = a.bg ? a.bg[0] : '#0f172a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${a.name} AI 페이스 준비 중...`, w / 2, h / 2);
      return;
    }

    // 1. 배경 (영웅별 엠비언트 그라디언트)
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, a.bg[0]);
    bgGrad.addColorStop(1, a.bg[1]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. 캔버스 종횡비에 맞춘 커버 계산
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const canvasRatio = w / h;
    let drawW, drawH;
    if (canvasRatio > imgRatio) {
      drawW = w;
      drawH = w / imgRatio;
    } else {
      drawH = h;
      drawW = h * imgRatio;
    }

    ctx.save();
    // 부드러운 생체 호흡 및 카메라 스웨이
    ctx.translate(w / 2, h / 2 + breatheY);
    ctx.rotate(headTilt);

    const scale = 1.04;
    const finalW = drawW * scale;
    const finalH = drawH * scale;
    ctx.drawImage(img, -finalW / 2, -finalH / 2, finalW, finalH);

    // 3. 눈 깜빡임 오버레이 (영웅 얼굴 자연스러운 눈꺼풀 음영)
    if (isBlinking) {
      ctx.save();
      const eyeY = -finalH * 0.11;
      const eyeDist = finalW * 0.082;
      const eyeW = finalW * 0.046;
      const eyeH = 3.5;

      ctx.fillStyle = a.heroId === 'batman' || a.heroId === 'spiderman'
        ? 'rgba(15, 23, 42, 0.9)'
        : 'rgba(180, 83, 9, 0.75)';
      ctx.beginPath();
      ctx.ellipse(-eyeDist, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.ellipse(eyeDist, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 4. 음성 발화 반응 (입술 반응 및 AI 에너지 오라)
    if (mouthLevel > 0.04) {
      ctx.save();
      const mouthY = finalH * 0.145;
      const openAmount = mouthLevel * 6.5;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
      ctx.beginPath();
      ctx.ellipse(0, mouthY, finalW * 0.045, Math.max(1.5, openAmount), 0, 0, Math.PI * 2);
      ctx.fill();

      // 발화 시 캐릭터 테마 오라 효과
      const aura = ctx.createRadialGradient(0, 0, finalW * 0.35, 0, 0, finalW * 0.6);
      const auraColor = a.heroId === 'spiderman'
        ? 'rgba(239, 68, 68,'
        : (a.heroId === 'batman' ? 'rgba(148, 163, 184,' : 'rgba(59, 130, 246,');
      aura.addColorStop(0, `${auraColor} 0)`);
      aura.addColorStop(1, `${auraColor} ${Math.min(0.28, mouthLevel * 0.35)})`);
      ctx.fillStyle = aura;
      ctx.fillRect(-finalW / 2, -finalH / 2, finalW, finalH);
      ctx.restore();
    }

    ctx.restore();

    // 5. 스튜디오 시네마틱 비네트 (가장자리 어둡게 처리하여 몰입감 극대화)
    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.76);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.52)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  _drawAvatarBadge(ctx, a, w, h) {
    // 사용자 요청: 송출되는 영상에 AI/가상 문구 미출력
    return;
  }

  _drawSwapBadge(ctx, faceName, w, h) {
    // 사용자 요청: 송출되는 영상에 AI 페이스 문구 미출력
    return;
  }

  _initSwapWebSocket() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
    if (typeof WebSocket === 'undefined') return;
    try {
      const host = window.location.host;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${host}/face-swap-ws`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._ws = ws;
        if (this.activeSwapFace) {
          try {
            ws.send(JSON.stringify({ type: 'set_source', source: this.activeSwapFace }));
          } catch { /* ignore */ }
        }
      };
      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          const blob = new Blob([event.data], { type: 'image/jpeg' });
          if (typeof createImageBitmap === 'function') {
            try {
              const bitmap = await createImageBitmap(blob);
              const old = this._lastBitmap;
              this._lastBitmap = bitmap;
              this._lastSwapSuccessTime = Date.now();
              if (old) {
                try { old.close(); } catch { /* ignore */ }
              }
              this._swapBusy = false;
              return;
            } catch {
              // fallback to DOM Image
            }
          }
          const img = new Image();
          img.onload = () => {
            if (this._lastSwappedUrl) {
              try { URL.revokeObjectURL(this._lastSwappedUrl); } catch { /* ignore */ }
            }
            this._lastSwappedImage = img;
            this._lastSwappedUrl = img.src;
            this._lastSwapSuccessTime = Date.now();
            this._swapBusy = false;
          };
          img.src = URL.createObjectURL(blob);
        } else {
          this._swapBusy = false;
        }
      };
      ws.onerror = () => {
        this._ws = null;
        this._swapBusy = false;
      };
      ws.onclose = () => {
        this._ws = null;
        this._swapBusy = false;
      };
    } catch {
      this._ws = null;
      this._swapBusy = false;
    }
  }

  _requestFaceSwapFrame() {
    if (!this.rawWebcamVideo || this.rawWebcamVideo.readyState < 2) {
      return;
    }
    const now = Date.now();
    // 150ms 이상 지연 시 busy 플래그 자동 해제 (영상 멈춤 및 지연 즉시 방지)
    if (this._swapBusy) {
      if (now - this._lastSwapReqTime > 150) {
        this._swapBusy = false;
      } else {
        return;
      }
    }
    // 33ms 인터벌 제어 (최대 30 FPS 실시간 초고속 송출)
    if (now - this._lastSwapReqTime < 33) {
      return;
    }
    this._lastSwapReqTime = now;
    this._swapBusy = true;

    // WebSocket 단선 시 백그라운드 자동 재접속
    if (!this._ws || this._ws.readyState === WebSocket.CLOSED) {
      this._initSwapWebSocket();
    }

    // AI 페이스 스왑 전송 크기 최적화 (480x270 고속 전송으로 네트워크 부하 90% 절감 및 실시간 FPS 유지)
    const targetW = Math.min(this.width || 640, 480);
    const targetH = Math.min(this.height || 360, 270);
    if (!this._offscreenCanvas || this._offscreenCanvas.width !== targetW || this._offscreenCanvas.height !== targetH) {
      this._offscreenCanvas = document.createElement('canvas');
      this._offscreenCanvas.width = targetW;
      this._offscreenCanvas.height = targetH;
      this._offscreenCtx = this._offscreenCanvas.getContext('2d', { alpha: false });
    }

    const oc = this._offscreenCanvas;
    const octx = this._offscreenCtx;

    // 거울 반사 효과를 적용하여 프레임 추출
    octx.save();
    octx.translate(oc.width, 0);
    octx.scale(-1, 1);
    octx.drawImage(this.rawWebcamVideo, 0, 0, oc.width, oc.height);
    octx.restore();

    const targetFace = this.activeSwapFace || 'superman';

    oc.toBlob(async (blob) => {
      if (!blob || this.mode !== 'swap') {
        this._swapBusy = false;
        return;
      }

      // 1순위: 직접 WebSocket 초고속 바이너리 전송
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try {
          const nameBytes = new TextEncoder().encode(targetFace);
          const header = new Uint8Array(4);
          new DataView(header.buffer).setUint32(0, nameBytes.length);
          const blobBytes = new Uint8Array(await blob.arrayBuffer());
          const packet = new Uint8Array(4 + nameBytes.length + blobBytes.length);
          packet.set(header, 0);
          packet.set(nameBytes, 4);
          packet.set(blobBytes, 4 + nameBytes.length);
          this._ws.send(packet);
          return;
        } catch {
          this._ws = null;
          this._swapBusy = false;
        }
      }

      // 2순위: HTTP POST /api/swap-frame
      try {
        const res = await fetch('/api/swap-frame', {
          method: 'POST',
          headers: {
            'Content-Type': 'image/jpeg',
            'X-Source-Face': targetFace,
          },
          body: blob,
        });
        if (res.ok) {
          const swappedBlob = await res.blob();
          if (typeof createImageBitmap === 'function') {
            try {
              const bitmap = await createImageBitmap(swappedBlob);
              const old = this._lastBitmap;
              this._lastBitmap = bitmap;
              this._lastSwapSuccessTime = Date.now();
              if (old) {
                try { old.close(); } catch { /* ignore */ }
              }
              this._swapBusy = false;
              return;
            } catch { /* ignore */ }
          }
          const img = new Image();
          img.onload = () => {
            if (this._lastSwappedUrl) {
              try { URL.revokeObjectURL(this._lastSwappedUrl); } catch { /* ignore */ }
            }
            this._lastSwappedImage = img;
            this._lastSwappedUrl = img.src;
            this._lastSwapSuccessTime = Date.now();
            this._swapBusy = false;
          };
          img.src = URL.createObjectURL(swappedBlob);
        } else {
          this._swapBusy = false;
        }
      } catch {
        this._swapBusy = false;
      }
    }, 'image/jpeg', 0.82);
  }

  destroy() {
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    if (this._lastBitmap) {
      try { this._lastBitmap.close(); } catch { /* ignore */ }
      this._lastBitmap = null;
    }
    if (this._lastSwappedUrl) {
      try { URL.revokeObjectURL(this._lastSwappedUrl); } catch { /* ignore */ }
      this._lastSwappedUrl = null;
    }
    this._detachMic();
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      try { this._audioCtx.close(); } catch { /* ignore */ }
    }
    this._audioCtx = null;
  }
}

