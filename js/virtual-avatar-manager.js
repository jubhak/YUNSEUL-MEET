/**
 * virtual-avatar-manager.js
 * 1) 12종의 연예인 스타일 가상 얼굴 아바타 로스터
 * 2) 중복 없는 랜덤 얼굴 셔플 덱 (Non-repeating Deck)
 * 3) 실시간 캔버스 렌더링 루프 (눈 깜빡임 + 마이크 음성 립싱크 + 미세 호흡 모션)
 * 4) 딜레이 0초 무중단 WebRTC 캡처 스트림 (가상 얼굴 <-> 실물 웹캠 즉시 전환)
 */

/**
 * 실사 AI 영웅/인물 아바타 목록 (photo/ 폴더 사진 기반 - 동적 로드)
 */
export const HERO_AVATARS = [];

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
/** 얼굴 송출 프로파일 */
export const FACE_OUT_W = 480;
export const FACE_OUT_H = 270;
export const FACE_OUT_FPS = 22;
export const FACE_OUT_W_HD = 640;
export const FACE_OUT_H_HD = 360;
export const FACE_OUT_FPS_HD = 28;
export const FACE_OUT_W_CROWD = 480;
export const FACE_OUT_H_CROWD = 270;
export const FACE_OUT_FPS_CROWD = 20;

/** 호스트만 수신하는 구조: 10명 이상 다자간 화상에서도 부드러운 20fps와 무지연 보장 */
export const FACE_PROFILE_SOLO = { mode: 'solo', width: FACE_OUT_W_HD, height: FACE_OUT_H_HD, fps: FACE_OUT_FPS_HD, maxBitrate: 350_000 };
export const FACE_PROFILE_MULTI = { mode: 'multi', width: FACE_OUT_W, height: FACE_OUT_H, fps: FACE_OUT_FPS, maxBitrate: 180_000 };
export const FACE_PROFILE_CROWD = { mode: 'crowd', width: FACE_OUT_W_CROWD, height: FACE_OUT_H_CROWD, fps: FACE_OUT_FPS_CROWD, maxBitrate: 140_000 };

export function faceModeForRoomCount(totalPeople = 1) {
  const n = Math.max(1, Number(totalPeople) || 1);
  if (n <= 1) return 'solo';
  if (n <= 5) return 'multi';
  return 'crowd'; // 6명+ (10명+ 포함)
}

export function faceProfileForMode(mode) {
  if (mode === 'solo') return FACE_PROFILE_SOLO;
  if (mode === 'crowd') return FACE_PROFILE_CROWD;
  return FACE_PROFILE_MULTI;
}

/**
 * OverconstrainedError 방지: max 하드 리밋 없이 ideal만 사용.
 * 장비가 256을 지원하지 않으면 장치 기본/최소 해상도로 열고, 송출은 캔버스에서 다운스케일.
 */
export async function openWebcamFlexible() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia 미지원');
  }

  let videoDevices = [];
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

  const attempts = [
    // 솔로 품질 선호 (ideal만 — max 하드 리밋 금지)
    { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 28 } },
    { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
    { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24 } },
    true, // 장치 기본
  ];

  let lastError = null;
  for (const video of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: video === true ? true : video,
        audio: false,
      });
    } catch (err) {
      lastError = err;
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') throw err;
    }
  }

  if (videoDevices.length > 1) {
    for (const dev of videoDevices) {
      if (!dev.deviceId) continue;
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: dev.deviceId } },
          audio: false,
        });
      } catch (err) {
        lastError = err;
      }
    }
  }

  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (isTouchDevice) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('카메라 스트림을 시작할 수 없습니다.');
}

export class VirtualAvatarManager {
  constructor({
    width = FACE_OUT_W_HD,
    height = FACE_OUT_H_HD,
    fps = FACE_OUT_FPS_HD,
    lockLowRes = false,
  } = {}) {
    this.width = width;
    this.height = height;
    this.captureFps = fps;
    this.lockLowRes = !!lockLowRes;
    this.faceMode = 'solo'; // 'solo' | 'multi'
    this.isLarge = width >= FACE_OUT_W_HD;
    this.deck = new NonRepeatingDeck(CELEBRITY_AVATARS);
    this._heroImages = new Map();
    this._customFaceImages = new Map();
    this._selectedFaceImage = null;
    // 기본 아바타: 실물 웹캠 모드가 기본 (선명한 30~60fps 무지연 송출)
    this.currentAvatar = CELEBRITY_AVATARS[0] || null;
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
    // WebSocket은 스왑 모드 진입 시에만 연결 (항상 연결하면 워커 준비 후 부하 급증)
    // this._initSwapWebSocket();

    // ── 10인 동시 딥페이크 대응 상태 ─────────────────────────────
    // clientId: 서버 워커가 참가자별로 프레임 캐시/얼굴 추적을 분리하는 키
    this.clientId = null;
    // 동시에 파이프라인에 띄우는 스왑 요청 수. 1이면 워커 응답이 늦을 때마다
    // 프레임이 통째로 버려져 "정지 → 몰아서 재생"이 반복된다. 2로 올려 지연을 숨긴다.
    this._maxInFlight = 2;
    this._inFlight = 0;
    this._serverFpsCap = 0;
    this.swapStats = { sent: 0, recv: 0, dropped: 0 };
    this.onSwapStats = null;

    this._startRenderLoop();
  }

  /**
   * 화질 토글 (하위 호환) — solo/multi 프로파일로 위임
   */
  setHighRes(isLarge) {
    if (this.lockLowRes) {
      this.setFaceMode('crowd');
      return;
    }
    this.setFaceMode(isLarge ? 'solo' : 'multi');
  }

  /**
   * 방 인원 기반 송출 프로파일
   * - solo: 640×360 @ ~28fps
   * - multi: 256×144 @ 20fps
   * @returns {boolean} 출력 트랙이 재생성된 경우 true
   */
  setFaceMode(mode) {
    if (this.lockLowRes) mode = 'crowd';
    const profile = faceProfileForMode(mode);
    const nextMode = profile.mode;
    const same = this.faceMode === nextMode
      && this.width === profile.width
      && this.height === profile.height
      && this.captureFps === profile.fps;
    this.faceMode = nextMode;
    this.isLarge = nextMode === 'solo';
    this.captureFps = profile.fps;

    let recreated = false;
    if (this.width !== profile.width || this.height !== profile.height) {
      this.width = profile.width;
      this.height = profile.height;
      this.canvas.width = profile.width;
      this.canvas.height = profile.height;
      if (this._offscreenCanvas) {
        this._offscreenCanvas.width = profile.width;
        this._offscreenCanvas.height = profile.height;
      }
      recreated = true;
    }
    if (!same) {
      this._recreateOutputStream();
      recreated = true;
      this._softApplyWebcamConstraints(profile);
      // 인원 변화로 faceMode가 바뀌면 스왑 펌프 주기 갱신
      if (this.mode === 'swap') this._startSwapPump();
    }
    this.onResolutionChange?.(this.isLarge, profile.width, profile.height);
    return recreated;
  }

  getFaceProfile() {
    return faceProfileForMode(this.faceMode || 'multi');
  }

  _softApplyWebcamConstraints(profile) {
    try {
      const vt = this.rawWebcamStream?.getVideoTracks?.()[0];
      if (!vt) return;
      // ideal만 — max 하드 리밋으로 OverconstrainedError 내지 않음
      vt.applyConstraints?.({
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: profile.fps },
      }).catch(() => {
        // 장비가 해당 해상도를 못 내면 장치 기본 유지 → 캔버스에서 다운스케일
      });
    } catch { /* ignore */ }
  }

  _recreateOutputStream() {
    const fps = this.captureFps || FACE_OUT_FPS;
    // 이미 라이브 출력 스트림이 유지되고 있다면 트랙을 강제로 죽이지 않음 (WebRTC 송출 및 비디오 재생 중단 방지)
    if (this.outputStream && this.outputStream.getVideoTracks().some((t) => t && t.readyState === 'live')) {
      return this.outputStream;
    }
    this.outputStream = this.canvas.captureStream(fps);
    return this.outputStream;
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
   * 웹캠 원본 스트림 등록 (송출 해상도는 faceMode 프로파일 유지)
   */
  setWebcamStream(stream) {
    this.rawWebcamStream = stream;
    if (stream) {
      if (this.activeSwapFace && this.activeSwapFace !== 'none' && this.activeSwapFace !== 'real') {
        this.mode = 'swap';
        this._initSwapWebSocket();
        this._startSwapPump();
      }
      this.rawWebcamVideo.srcObject = stream;
      const ensureOutDim = () => {
        const profile = this.getFaceProfile();
        if (this.width !== profile.width || this.height !== profile.height) {
          this.width = profile.width;
          this.height = profile.height;
          this.canvas.width = profile.width;
          this.canvas.height = profile.height;
          if (this._offscreenCanvas) {
            this._offscreenCanvas.width = profile.width;
            this._offscreenCanvas.height = profile.height;
          }
        }
      };
      this.rawWebcamVideo.onloadedmetadata = ensureOutDim;
      this.rawWebcamVideo.play?.().then(ensureOutDim).catch(() => {});
      this._softApplyWebcamConstraints(this.getFaceProfile());
    } else {
      this.rawWebcamVideo.srcObject = null;
      this._stopSwapPump();
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
      this.outputStream = this.canvas.captureStream(this.captureFps || FACE_OUT_FPS);
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
      this._stopSwapPump();
    } else if (newMode === 'swap') {
      this.mode = 'swap';
      this._initSwapWebSocket();
      this._startSwapPump();
    } else {
      this.mode = 'virtual';
      this._stopSwapPump();
    }
    this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
  }

  /** 스왑 요청 fps — 송출 fps와 분리 (실시간 자연스러운 모션 보장)
   * 서버가 동시 딥페이크 참가자 수를 보고 보내주는 throttle 캡(_serverFpsCap)이 있으면
   * 그 값을 넘지 않도록 클램프한다. 참가자가 많아질수록 서버가 캡을 낮춰 보내므로,
   * 클라이언트가 자체 판단으로 계속 26fps를 밀어넣어 서버 GPU 락을 독점하는 상황을 막는다. */
  _swapRequestFps() {
    const base = this.faceMode === 'crowd' ? 18 : (this.faceMode === 'multi' ? 22 : 26);
    if (this._serverFpsCap) return Math.min(base, this._serverFpsCap);
    return base;
  }

  _startSwapPump() {
    this._stopSwapPump();
    const tick = () => {
      if (this.mode !== 'swap') return;
      this._requestFaceSwapFrame();
    };
    const ms = Math.round(1000 / Math.max(2, this._swapRequestFps()));
    this._swapPumpTimer = setInterval(tick, ms);
    // 즉시 1장
    tick();
  }

  /** 서버로부터 받은 동적 fps 캡을 적용하고, 펌프가 돌고 있으면 새 주기로 재시작한다. */
  _applyServerThrottle(fps) {
    const n = Number(fps);
    if (!Number.isFinite(n) || n <= 0) return;
    if (this._serverFpsCap === n) return;
    this._serverFpsCap = n;
    if (this.mode === 'swap' && this._swapPumpTimer) {
      this._startSwapPump();
    }
  }

  _stopSwapPump() {
    if (this._swapPumpTimer) {
      clearInterval(this._swapPumpTimer);
      this._swapPumpTimer = null;
    }
  }

  /** 스왑 요청 1건 종료 처리 (성공/실패/드랍 공통) */
  _settleSwap() {
    this._swapBusy = false;
    this._inFlight = Math.max(0, this._inFlight - 1);
  }

  /** 외부(호스트/참가자 코드)에서 참가자 식별자를 주입한다. */
  setClientId(id) {
    this.clientId = id || null;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'hello', clientId: this.clientId })); } catch { /* ignore */ }
    }
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

  /**
   * 실시간 Deep-Live-Cam 페이스 스왑 대상 얼굴 설정
   * @param {string} faceIdOrName (사진 ID 또는 파일명)
   * @param {string} [photoUrl] (사진 접근 URL - 첫 프레임 도착 전 플레이스홀더 표시용)
   */
  setSwapFace(faceIdOrName, photoUrl = '') {
    const key = (faceIdOrName || '').toLowerCase().trim();
    if (!key) return null;
    this.activeSwapFace = key;
    this.activeSwapFaceUrl = photoUrl || '';

    // [사생활 절대 보호: 선택한 사진 즉시 프리뷰]
    // 딥페이크 모델이 로딩되어 첫 스왑 프레임이 도착할 때까지 실제 얼굴 대신
    // 사용자가 방금 선택한 사진 자체를 화면에 띄워 1ms도 실물이 노출되지 않도록 완벽 보장합니다.
    let img = this._customFaceImages?.get(key);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      if (photoUrl) {
        img.src = photoUrl;
      } else if (key.includes('.')) {
        img.src = `/photo/${encodeURIComponent(key)}`;
      } else {
        img.src = `/photo/${encodeURIComponent(key)}.jpg`;
      }
      if (!this._customFaceImages) this._customFaceImages = new Map();
      this._customFaceImages.set(key, img);
    }
    this._selectedFaceImage = img;

    const hero = HERO_AVATARS.find((h) => h.heroId === key || h.id === key || h.photo?.includes(key));
    if (hero) {
      this.currentAvatar = hero;
    } else {
      this.currentAvatar = {
        id: `photo-${key}`,
        heroId: key,
        name: key,
        isCustomPhoto: true,
        photoImg: img,
        bg: ['#0f172a', '#1e293b'],
      };
    }

    this.mode = 'swap';

    this._initSwapWebSocket();
    this._startSwapPump();

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
   * 실물 웹캠 모드로 복귀 (AI 스왑 해제)
   */
  setRealMode() {
    this.activeSwapFace = null;
    this.activeSwapFaceUrl = '';
    this._selectedFaceImage = null;
    this._lastSwappedImage = null;
    this._stopSwapPump();
    this._settleSwap();
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
    let lastRenderTime = 0;
    const render = (ts) => {
      const targetFps = this.captureFps || FACE_OUT_FPS;
      const minFrameMs = 1000 / Math.max(1, targetFps);
      if (!lastRenderTime || (ts - lastRenderTime) >= minFrameMs) {
        lastRenderTime = ts;
        this._renderFrame();
      }
      this._animId = requestAnimationFrame(render);
    };
    this._animId = requestAnimationFrame(render);

    // 백그라운드 탭에서는 requestAnimationFrame이 멈춘다. 그 상태로 두면
    // canvas가 마지막 프레임에 고정되고 그대로 captureStream 송출되어
    // "상대 화면이 멈춤"으로 보인다. 탭 복귀 즉시 강제로 다시 그린다.
    if (!this._visHandler) {
      this._visHandler = () => {
        if (document.visibilityState === 'visible') {
          lastRenderTime = 0;
          try { this._renderFrame(); } catch { /* ignore */ }
        }
      };
      document.addEventListener('visibilitychange', this._visHandler);
    }

    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      const targetFps = this.captureFps || FACE_OUT_FPS;
      const minFrameMs = 1000 / Math.max(1, targetFps);
      if (performance.now() - lastRenderTime > minFrameMs * 1.5) {
        lastRenderTime = performance.now();
        this._renderFrame();
      }
    }, 50);
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
    const img = this._selectedFaceImage;
    if (img && img.complete && img.naturalWidth) {
      const now = Date.now();
      const t = now * 0.002;
      const breatheY = Math.sin(t) * 3.0;
      const headTilt = Math.cos(t * 0.6) * 0.01;

      // 1. 배경 (은은한 다크 그라디언트)
      ctx.save();
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#090d16');
      bgGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 2. 사용자가 선택한 사진을 종횡비에 맞춰 중앙 렌더링
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

      ctx.translate(w / 2, h / 2 + breatheY);
      ctx.rotate(headTilt);
      const scale = 1.02;
      const finalW = drawW * scale;
      const finalH = drawH * scale;
      ctx.drawImage(img, -finalW / 2, -finalH / 2, finalW, finalH);
      ctx.restore();

      // 3. AI 모델 로딩 안내 오버레이 뱃지 (하단)
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      const badgeW = 220;
      const badgeH = 28;
      const bx = (w - badgeW) / 2;
      const by = h - 42;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(bx, by, badgeW, badgeH, 14);
      } else {
        ctx.rect(bx, by, badgeW, badgeH);
      }
      ctx.fill();

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✨ AI 페이스 모델 준비 중...', w / 2, by + badgeH / 2);
      ctx.restore();
      return;
    }

    // 일반 아바타 또는 사진 로딩 대기 (실물 얼굴 100% 비노출 보호)
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
    ctx.fillText('선택한 AI 페이스를 적용하고 있습니다...', w / 2, h / 2 + 16);
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
    // 중요: 여기서는 "그리기만" 한다. toBlob/스왑 요청은 별도 펌프(_startSwapPump)에서만.
    // 렌더마다 스왑 요청하면 워커 적체 → 10초 정지 진동의 주원인.
    if (this.mode === 'swap') {
      ctx.save();
      if (this._lastBitmap) {
        ctx.drawImage(this._lastBitmap, 0, 0, w, h);
      } else if (this._lastSwappedImage && this._lastSwappedImage.complete && this._lastSwappedImage.naturalWidth) {
        ctx.drawImage(this._lastSwappedImage, 0, 0, w, h);
      } else {
        this._drawFacePrivacyPlaceholder(ctx, w, h);
      }
      ctx.restore();
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
      const q = this.clientId ? `?client=${encodeURIComponent(this.clientId)}` : '';
      const wsUrl = `${proto}//${host}/face-swap-ws${q}`;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ type: 'hello', clientId: this.clientId || null }));
        } catch { /* ignore */ }
        if (this.activeSwapFace) {
          try {
            ws.send(JSON.stringify({ type: 'set_source', source: this.activeSwapFace }));
          } catch { /* ignore */ }
        }
      };
      ws.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.swapStats.recv += 1;
          this.onSwapStats?.(this.swapStats);
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
              this._settleSwap();
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
            this._settleSwap();
          };
          img.src = URL.createObjectURL(blob);
        } else if (typeof event.data === 'string') {
          // 서버 제어 메시지 (동시 참가자 수 기반 fps 조절 등)
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'throttle' && msg.fps) {
              this._applyServerThrottle(msg.fps);
            }
          } catch { /* ignore non-JSON text frames */ }
          this._settleSwap();
        } else {
          this._settleSwap();
        }
      };
      ws.onerror = () => {
        if (this._ws === ws) this._ws = null;
        this._settleSwap();
      };
      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
        this._settleSwap();
      };
    } catch {
      this._ws = null;
      this._settleSwap();
    }
  }

  _requestFaceSwapFrame() {
    if (!this.rawWebcamVideo || this.rawWebcamVideo.readyState < 2) {
      return;
    }
    const now = Date.now();
    // [10인 확장 수정] 예전 로직은 _swapBusy 단일 비행 + 2.5초 가드였다.
    // 워커가 바빠 응답이 늦으면 그 사이 프레임이 전부 버려지고, 마지막
    // 비트맵만 계속 그려져 화면이 "멈춘 것처럼" 보였다(드랍 폭주 → 정지 →
    // 몰아서 재생). 이제 상한(_maxInFlight)까지 요청을 파이프라인에 띄워
    // 지연을 겹쳐 숨기고(pipelining), 상한 초과 시에만 최신 프레임을 버린다.
    if (this._inFlight >= this._maxInFlight) {
      this.swapStats.dropped += 1;
      this.onSwapStats?.(this.swapStats);
      return;
    }
    if (now - this._lastSwapReqTime > 4000) {
      // 워커 재시작 등으로 응답이 장시간 없으면 카운터를 강제 복구
      this._inFlight = 0;
      this._swapBusy = false;
    }
    this._lastSwapReqTime = now;
    this._swapBusy = true;
    this._inFlight += 1;
    this.swapStats.sent += 1;
    this.onSwapStats?.(this.swapStats);

    if (!this._ws || this._ws.readyState === WebSocket.CLOSED) {
      this._initSwapWebSocket();
    }
    // WS 미연결이면 다음 틱에 재시도
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      this._settleSwap();
      return;
    }

    // InsightFace 얼굴 검출에 최적인 표준 해상도 (최소 480x270 ~ 640x360 보장)
    const targetW = Math.max(480, this.width || 640);
    const targetH = Math.max(270, this.height || 360);
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
        this._settleSwap();
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
          // busy는 onmessage에서 해제 (응답 없으면 2.5s 가드)
          return;
        } catch {
          this._ws = null;
          this._settleSwap();
        }
      }

      this._settleSwap();
    }, 'image/jpeg', 0.70);
  }

  destroy() {
    if (this._visHandler) {
      try { document.removeEventListener('visibilitychange', this._visHandler); } catch { /* ignore */ }
      this._visHandler = null;
    }
    this._stopSwapPump();
    this._inFlight = 0;
    this._swapBusy = false;
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
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

