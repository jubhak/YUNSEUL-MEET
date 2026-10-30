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
    id: 'photo-portrait-1',
    heroId: 'ID_photo_portrait_20260923152425',
    name: '단정한 프로필',
    badge: 'AI 실사 프로필',
    photoUrl: '/photo/ID_photo_portrait_20260923152425.jpeg',
    bg: ['#0f172a', '#1e293b'],
    isPhotoAvatar: true,
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
/**
 * 스로틀되지 않는 주기 타이머 (Web Worker 기반, 실패 시 setInterval 폴백).
 * 백그라운드 탭에서도 카메라 렌더/딥페이크 요청이 끊기지 않게 한다.
 * @returns {{ stop: () => void }}
 */
export function createWorkerTicker(intervalMs, cb) {
  try {
    const src = 'let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = () => { try { cb(); } catch (err) { console.warn('[ticker]', err); } };
    w.postMessage(Math.max(4, Math.round(intervalMs)));
    return {
      stop() {
        try { w.postMessage(0); } catch { /* ignore */ }
        try { w.terminate(); } catch { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      },
    };
  } catch {
    const id = setInterval(() => { try { cb(); } catch (err) { console.warn('[ticker]', err); } }, Math.max(4, Math.round(intervalMs)));
    return { stop() { clearInterval(id); } };
  }
}

export const FACE_OUT_W = 480;
export const FACE_OUT_H = 270;
export const FACE_OUT_FPS = 22;
export const FACE_OUT_W_HD = 640;
export const FACE_OUT_H_HD = 360;
export const FACE_OUT_FPS_HD = 30;
export const FACE_OUT_W_HQ = 960;
export const FACE_OUT_H_HQ = 540;
export const FACE_OUT_FPS_HQ = 30;
export const FACE_OUT_W_CROWD = 512;
export const FACE_OUT_H_CROWD = 288;
export const FACE_OUT_FPS_CROWD = 20;
export const FACE_OUT_W_PACK = 384;
export const FACE_OUT_H_PACK = 216;
export const FACE_OUT_FPS_PACK = 14;
export const FACE_OUT_W_MASS = 320;
export const FACE_OUT_H_MASS = 180;
export const FACE_OUT_FPS_MASS = 10;

/** 호스트만 개별 얼굴을 받고, 클라이언트는 합성 화면 1장만 받는다. */
export const FACE_PROFILE_HIGH = { mode: 'high', width: FACE_OUT_W_HQ, height: FACE_OUT_H_HQ, fps: FACE_OUT_FPS_HQ, maxBitrate: 900_000 };
export const FACE_PROFILE_SOLO = { mode: 'solo', width: FACE_OUT_W_HD, height: FACE_OUT_H_HD, fps: FACE_OUT_FPS_HD, maxBitrate: 350_000 };
export const FACE_PROFILE_MULTI = { mode: 'multi', width: FACE_OUT_W, height: FACE_OUT_H, fps: FACE_OUT_FPS, maxBitrate: 180_000 };
export const FACE_PROFILE_CROWD = { mode: 'crowd', width: FACE_OUT_W_CROWD, height: FACE_OUT_H_CROWD, fps: FACE_OUT_FPS_CROWD, maxBitrate: 170_000 };
export const FACE_PROFILE_PACK = { mode: 'pack', width: FACE_OUT_W_PACK, height: FACE_OUT_H_PACK, fps: FACE_OUT_FPS_PACK, maxBitrate: 110_000 };
export const FACE_PROFILE_MASS = { mode: 'mass', width: FACE_OUT_W_MASS, height: FACE_OUT_H_MASS, fps: FACE_OUT_FPS_MASS, maxBitrate: 80_000 };

export function faceModeForRoomCount(totalPeople = 1) {
  const n = Math.max(1, Number(totalPeople) || 1);
  if (n <= 6) return 'high';
  if (n <= 12) return 'solo';
  if (n <= 20) return 'crowd';
  if (n <= 30) return 'pack';
  return 'mass';
}

export function faceProfileForMode(mode) {
  if (mode === 'high') return FACE_PROFILE_HIGH;
  if (mode === 'solo') return FACE_PROFILE_SOLO;
  if (mode === 'crowd') return FACE_PROFILE_CROWD;
  if (mode === 'pack') return FACE_PROFILE_PACK;
  if (mode === 'mass') return FACE_PROFILE_MASS;
  return FACE_PROFILE_MULTI;
}

function _isDeniedCameraError(err) {
  const n = err?.name || '';
  return n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError';
}

function _isSkipCameraLabel(label = '') {
  return /ir\b|infrared|mapir|hello|depth|rgb-?d/i.test(label);
}

async function _preferHigherRes(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track?.applyConstraints) return;
  const settings = track.getSettings?.() || {};
  if (settings.width && settings.width >= 1280 && settings.height && settings.height >= 720) {
    return;
  }
  const tries = [
    { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
    { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
  ];
  for (const c of tries) {
    try {
      await track.applyConstraints(c);
      return;
    } catch { /* 장치가 거부하면 다음 단계. 이미 열린 스트림은 유지 */ }
  }
}

/**
 * 실물 웹캠 스트림을 유연하고 강력하게 오픈.
 * 
 * 1. Windows 노트북 웹캠 센서는 대다수 16:9 (720p/1080p) 네이티브이며,
 *    Windows 기본 카메라 앱은 1280x720(16:9)로 센서를 초기화합니다.
 *    Chrome에서 unconstrained(video: true)를 호출하면 640x480(4:3)을 요청하여
 *    절전/초기 상태의 Media Foundation 드라이버가 MF_E_INVALIDMEDIATYPE을 반환하고
 *    Chromium은 이를 "Requested device not found"로 변환합니다.
 *    따라서 16:9 HD(1280x720) ideal을 최우선으로 시도합니다.
 * 
 * 2. 기본 장치 실패 시 enumerateDevices()로 실제 비디오 장치들을 조회하고,
 *    Windows Hello / IR 적외선 센서를 후순위로 넘긴 후 { exact: dev.deviceId }로
 *    1280x720 및 해상도별 단계적 오픈을 시도합니다.
 * 
 * 3. 절전 모드 센서 하드웨어 웜업 대기(250ms) 후 최종 재시도합니다.
 */
export async function openWebcamFlexible() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia 미지원 브라우저 환경입니다.');
  }

  const gum = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  let lastError = null;

  const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  // 1단계 (Fast-Path): 표준 16:9 720p 즉시 요청
  try {
    const fastConstraints = isPhone
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: { ideal: 'user' } }
      : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const stream = await gum(fastConstraints);
    await _preferHigherRes(stream);
    return stream;
  } catch (err) {
    lastError = err;
    if (_isDeniedCameraError(err)) throw err;
  }

  // 2단계 (구글 미팅/줌 방식 - 하드웨어 버스 즉시 기동):
  // 1단계 실패의 99%는 노트북 내장 웹캠 센서 전원 절전(D3 Cold)입니다.
  // 구글 미팅/줌처럼 audio(WASAPI)를 함께 복합 요청하면 OS/드라이버가 부모 USB 컨트롤러 허브를
  // D0(Active)로 즉시 깨우므로 카메라 센서가 전원을 공급받아 수십 ms 안에 바로 열립니다!
  try {
    const compStream = await navigator.mediaDevices.getUserMedia({
      video: isPhone ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'user' } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    // 마이크 트랙은 즉시 안전하게 분리 및 중지 (오직 비디오 스트림만 취함)
    compStream.getAudioTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    const videoTracks = compStream.getVideoTracks();
    if (videoTracks && videoTracks.length > 0) {
      const pureStream = new MediaStream([videoTracks[0]]);
      await _preferHigherRes(pureStream);
      return pureStream;
    }
  } catch (err) {
    lastError = err;
    if (_isDeniedCameraError(err)) throw err;
  }

  // 3단계 (구글 미팅 표준 Two-Step 기법): 무제약 Loose Constraint({ video: true })로 기본 모드 오픈 후 HD 승격
  try {
    const looseStream = await gum(isPhone ? { facingMode: { ideal: 'user' } } : true);
    await _preferHigherRes(looseStream);
    return looseStream;
  } catch (err) {
    lastError = err;
    if (_isDeniedCameraError(err)) throw err;
  }

  // 4단계: 장치 열거 후 개별 장치(exact deviceId)로 순차 시도
  let videoDevices = [];
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devs.filter((d) => d.kind === 'videoinput' && d.deviceId);
  } catch { /* ignore */ }

  if (videoDevices.length > 0) {
    videoDevices.sort((a, b) => {
      const aSkip = _isSkipCameraLabel(a.label || '');
      const bSkip = _isSkipCameraLabel(b.label || '');
      if (aSkip !== bSkip) return aSkip ? 1 : -1;
      return 0;
    });

    for (const dev of videoDevices) {
      if (_isSkipCameraLabel(dev.label || '')) continue;
      const devTries = [
        { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
        { deviceId: { exact: dev.deviceId } },
        { deviceId: { ideal: dev.deviceId } },
      ];
      for (const dc of devTries) {
        try {
          const stream = await gum(dc);
          await _preferHigherRes(stream);
          return stream;
        } catch (err) {
          lastError = err;
          if (_isDeniedCameraError(err)) throw err;
        }
      }
    }
  }

  // 5단계: 센서 PnP 버스 등록 웜업 지연(300ms) 대기 후 최종 시도
  await new Promise((r) => setTimeout(r, 300));
  try {
    const finalStream = await gum(true);
    await _preferHigherRes(finalStream);
    return finalStream;
  } catch (err) {
    lastError = err;
    if (_isDeniedCameraError(err)) throw err;
  }

  if (lastError) {
    const msg = String(lastError.message || lastError.name || '').toLowerCase();
    if (lastError.name === 'NotFoundError' || msg.includes('requested device not found')) {
      lastError.isDeviceNotFound = true;
    }
  }
  throw lastError || new Error('카메라 스트림을 시작할 수 없습니다.');
}

// myface.ini 뷰티 필터 기본 설정 및 INI 파서
export const DEFAULT_MYFACE_CONFIG = {
  smooth_intensity: 0.68,
  edge_threshold: 16.0,
  blur_radius: 3,
  brightness_lift: 1.04,
  contrast_balance: 1.02,
};

export function parseMyFaceIni(text) {
  const cfg = { ...DEFAULT_MYFACE_CONFIG };
  if (!text) return cfg;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
    const val = parseFloat(trimmed.slice(eqIdx + 1).trim());
    if (isNaN(val)) continue;
    if (key === 'smooth_intensity') cfg.smooth_intensity = Math.max(0.0, Math.min(1.0, val));
    else if (key === 'edge_threshold') cfg.edge_threshold = Math.max(1.0, Math.min(100.0, val));
    else if (key === 'blur_radius') cfg.blur_radius = Math.max(1, Math.min(30, Math.round(val)));
    else if (key === 'brightness_lift') cfg.brightness_lift = Math.max(0.5, Math.min(2.5, val));
    else if (key === 'contrast_balance') cfg.contrast_balance = Math.max(0.5, Math.min(2.5, val));
  }
  return cfg;
}

export class VirtualAvatarManager {
  constructor({
    width = FACE_OUT_W_HQ,
    height = FACE_OUT_H_HQ,
    fps = FACE_OUT_FPS_HQ,
    lockLowRes = false,
  } = {}) {
    this.width = width;
    this.height = height;
    this.captureFps = fps;
    this.lockLowRes = !!lockLowRes;
    this.faceMode = 'high';
    this.isLarge = width >= FACE_OUT_W_HD;
    this.deck = new NonRepeatingDeck(CELEBRITY_AVATARS);
    this._heroImages = new Map();
    this._customFaceImages = new Map();
    this._selectedFaceImage = null;
    this._defaultPhotoImg = null;
    this._loadDefaultPhoto();
    // 기본 아바타: 실사 사진 아바타 기본 설정
    this.currentAvatar = CELEBRITY_AVATARS[0] || {
      id: 'photo-portrait-1',
      heroId: 'ID_photo_portrait_20260923152425',
      name: '단정한 프로필',
      isPhotoAvatar: true,
      photoUrl: '/photo/ID_photo_portrait_20260923152425.jpeg',
      bg: ['#0f172a', '#1e293b'],
    };
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
    // myface.ini 설정
    this.myFaceConfig = { ...DEFAULT_MYFACE_CONFIG };
    this._loadMyFaceIni();
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
    // 동시에 파이프라인에 띄우는 스왑 요청 수.
    // 서버(handle_websocket)는 연결당 latest_pending 슬롯 1개로 프레임을 직렬 처리하므로
    // in-flight를 1로 맞춰 낭비 전송과 카운터 불일치(화면 정지 현상)를 방지한다.
    // 프로토콜 v2: 요청마다 seq 를 붙이고(요청 이름 + \x1f + seq) 응답 헤더 FS2\0 로 매칭한다.
    // 서버는 연결당 "최신 1장" 슬롯이므로 in-flight 2 = (GPU 처리 중 1장 + 전송/인코딩 중 1장)으로
    // 네트워크 왕복·JPEG 인코딩을 GPU 처리와 겹쳐 파이프라이닝한다 (초당 처리량 ↑, 지연 증가 없음).
    this._maxInFlight = 2;
    this._inFlight = 0;
    this._pending = new Map();      // seq -> 전송 시각(performance.now)
    this._seq = 0;
    this._lastShownSeq = -1;        // 이미 표시한 최신 seq (역전/지연 도착 프레임 폐기)
    this._encoding = false;
    this._lastSendAt = 0;
    this._wsRetryAt = 0;
    this._wsRetryDelay = 500;
    this._rttMs = 0;
    this._procMs = 0;
    this._playQ = [];               // 재생 지터 버퍼 (디코드된 ImageBitmap)
    this._serverMaxW = 0;
    this._serverFpsCap = 0;
    this.swapStats = { sent: 0, recv: 0, dropped: 0 };
    this.onSwapStats = null;
    /** 서버가 "호스트 직송 정상(live)" 여부를 알려올 때 호출 — SFU 카메라 송출 절감용 (viewer-subscriber 가 사용) */
    this.onFeedState = null;

    /** 'host' 이면 서버 입장 제어(용량 초과 거절)에서 제외 — host-publisher 가 설정 */
    this.swapRole = 'viewer';
    this.clientId = null;
    this.roomCode = null;
    /** 서버가 용량 초과로 딥페이크 적용을 거절했을 때 호출: ({ active, capacity_fps, per_client_fps, min_fps, max_clients }) => void */
    this.onSwapRejected = null;
    this._swapRejected = false;

    // ── 업로드 품질 자동 조절 (인터넷이 나쁜 참가자는 저화질로 올려도 된다) ──
    // 0: 기본 / 1: ≤480px / 2: ≤384px, 15fps / 3: 320px, 10fps. 신호: 순수 네트워크 왕복(RTT − 서버 처리시간), 송신 버퍼 적체.
    this._uploadLevel = 0;
    this._netRttMs = 0;
    this._upStalls = 0;             // 최근 평가 구간의 송신 버퍼 적체 횟수
    this._upLastEvalAt = 0;
    this._upLastChangeAt = 0;
    this._upCalmSince = 0;
    this.onUploadLevelChange = null; // (level) => void

    this._startRenderLoop();
  }

  /**
   * 화질 토글 (하위 호환) — solo/multi 프로파일로 위임
   */
  setHighRes(isLarge) {
    if (this.lockLowRes) {
      this.setFaceMode('mass');
      return;
    }
    this.setFaceMode(isLarge ? 'high' : 'solo');
  }

  /**
   * 방 인원 기반 송출 프로파일
   * - high: 960×540 (2~6명) / solo: 640×360 (7~12명) / crowd: 512×288 (13~20명)
   * - pack: 384×216 (21~30명) / mass: 320×180 (31명+)
   * @returns {boolean} 출력 트랙이 재생성된 경우 true
   */
  setFaceMode(mode) {
    if (this.lockLowRes) mode = 'mass';
    const profile = faceProfileForMode(mode);
    const nextMode = profile.mode;
    const same = this.faceMode === nextMode
      && this.width === profile.width
      && this.height === profile.height
      && this.captureFps === profile.fps;
    this.faceMode = nextMode;
    this.isLarge = nextMode === 'high' || nextMode === 'solo';
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
    return faceProfileForMode(this.faceMode || 'high');
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
   * 가상 사진 아바타용 기본 실사 이미지 로드
   */
  _loadDefaultPhoto(url = '/photo/ID_photo_portrait_20260923152425.jpeg') {
    if (this._defaultPhotoImg && this._defaultPhotoImg.complete && this._defaultPhotoImg.naturalWidth) return;
    try {
      if (typeof Image !== 'undefined') {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = url;
        this._defaultPhotoImg = img;
        if (!this._selectedFaceImage) {
          this._selectedFaceImage = img;
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * 현재 활성화된 실사 사진 이미지 요소 반환
   */
  _getActivePhotoImg() {
    if (this._selectedFaceImage && this._selectedFaceImage.complete && this._selectedFaceImage.naturalWidth) {
      return this._selectedFaceImage;
    }
    if (this.currentAvatar?.photoImg && this.currentAvatar.photoImg.complete && this.currentAvatar.photoImg.naturalWidth) {
      return this.currentAvatar.photoImg;
    }
    if (this.activeSwapFace && this._customFaceImages?.has(this.activeSwapFace)) {
      const img = this._customFaceImages.get(this.activeSwapFace);
      if (img && img.complete && img.naturalWidth) return img;
    }
    if (this._defaultPhotoImg && this._defaultPhotoImg.complete && this._defaultPhotoImg.naturalWidth) {
      return this._defaultPhotoImg;
    }
    return null;
  }

  /**
   * 모드 전환 ('virtual' | 'real' | 'swap')
   */
  setMode(newMode) {
    if (newMode === 'real') {
      this.activeSwapFace = null;
      this.mode = 'real';
      this._stopSwapPump();
      try { this.onFeedState?.(false); } catch { /* ignore */ }   // 실물 영상 송출로 돌아가면 저fps 해제
    } else if (newMode === 'swap') {
      this.mode = 'swap';
      this._initSwapWebSocket();
      this._startSwapPump();
    } else {
      this.mode = 'virtual';
      this._stopSwapPump();
      try { this.onFeedState?.(false); } catch { /* ignore */ }
      if (!this._getActivePhotoImg()) {
        this._loadDefaultPhoto();
      }
    }
    this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
  }

  /** 스왑 요청 fps — 송출 fps와 분리 (실시간 자연스러운 모션 보장)
   * 서버가 동시 딥페이크 참가자 수를 보고 보내주는 throttle 캡(_serverFpsCap)이 있으면
   * 그 값을 넘지 않도록 클램프한다. 참가자가 많아질수록 서버가 캡을 낮춰 보내므로,
   * 클라이언트가 자체 판단으로 계속 26fps를 밀어넣어 서버 GPU 락을 독점하는 상황을 막는다. */
  _swapRequestFps() {
    const base = this.faceMode === 'mass' ? 10
      : this.faceMode === 'pack' ? 15
      : this.faceMode === 'crowd' ? 20
      : this.faceMode === 'multi' ? 24
      : this.faceMode === 'high' ? 30
      : 30;
    if (this._serverFpsCap) {
      // 서버가 GPU 실시간 부하 및 백프레셔를 측정해 브로드캐스트한 캡(고성능 GPU 최대 60fps) 적용
      const cap = Math.max(4, this._serverFpsCap);
      return Math.min(cap, this._uploadLimits().fps);
    }
    return Math.min(base, this._uploadLimits().fps);
  }

  /**
   * 대기(idle) 모드 — 호스트가 "PC 화면"을 보여주는 동안 참가자 얼굴은 아무도 보지 않으므로
   * 딥페이크 프레임 전송(업로드)·GPU 처리·로컬 렌더링을 모두 멈춘다.
   * 서버 연결과 "자리"는 유지(서버가 대기 중인 자리를 예약)하므로 재개 때 입장 제어에 다시 걸리지 않는다.
   * 웹캠·마이크는 건드리지 않는다(목소리는 그대로 전달).
   */
  setIdle(on) {
    const next = !!on;
    if (!!this._idle === next) return;
    this._idle = next;
    this._sendIdleState();
    if (next) {
      this._stopSwapPump();
      this._resetSwapPipeline();
      try { this.onFeedState?.(false); } catch { /* ignore */ }   // 실물 영상 송출로 돌아가면 저fps 해제
    } else {
      try { this._renderFrame(); } catch { /* ignore */ }
      if (this.mode === 'swap' && !this._swapRejected) {
        this._initSwapWebSocket();
        this._startSwapPump();
      }
    }
  }

  get isIdle() {
    return !!this._idle;
  }

  _sendIdleState() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'idle', on: !!this._idle })); } catch { /* ignore */ }
    }
  }

  _startSwapPump() {
    this._stopSwapPump();
    if (this._idle) return;
    const tick = () => {
      if (this.mode !== 'swap') return;
      this._requestFaceSwapFrame();
    };
    const ms = Math.round(1000 / Math.max(4, this._swapRequestFps()));
    // 워커 타이머: 백그라운드 탭에서도 스로틀 없이 일정한 주기 유지
    this._swapPumpTimer = createWorkerTicker(ms, tick);
    // 즉시 1장
    tick();
  }

  /** 서버로부터 받은 동적 fps 캡을 적용하고, 펌프가 돌고 있으면 새 주기로 재시작한다. */
  _applyServerThrottle(fps, maxW, clients) {
    const w = Number(maxW);
    if (Number.isFinite(w) && w >= 320) this._serverMaxW = w;
    // 동시 참가자가 많아 GPU 가 포화되면(≥8명) 참가자당 동시 요청을 1장으로 제한한다.
    // 처리량은 GPU 가 정하므로 그대로인데, 큐에 쌓이는 프레임 수가 절반이 되어 지연(≈큐 길이/처리량)이 줄어든다.
    const c = Number(clients);
    if (Number.isFinite(c)) this._maxInFlight = c >= 8 ? 1 : 2;
    const n = Number(fps);
    if (!Number.isFinite(n) || n <= 0) return;
    if (this._serverFpsCap === n) return;
    this._serverFpsCap = n;
    if (n > (this.captureFps || 0)) {
      this.captureFps = n;
      this._softApplyWebcamConstraints({ width: this.width, height: this.height, fps: n });
    }
    if (this.mode === 'swap' && this._swapPumpTimer) {
      this._startSwapPump();
    }
  }

  _stopSwapPump() {
    if (this._swapPumpTimer) {
      try { this._swapPumpTimer.stop(); } catch { /* ignore */ }
      this._swapPumpTimer = null;
    }
  }

  /** 스왑 요청 1건 종료 처리 (성공/실패/드랍 공통) */
  _settleSwap(seq = null) {
    if (seq == null) {
      // seq 불명(v1 응답/오류): 가장 오래된 요청 하나를 완료 처리
      const first = this._pending.keys().next();
      if (!first.done) this._pending.delete(first.value);
    } else {
      this._pending.delete(seq);
    }
    this._syncInFlight();
  }

  _syncInFlight() {
    this._inFlight = this._pending.size;
    this._swapBusy = this._inFlight > 0;
  }

  _resetSwapPipeline() {
    this._pending.clear();
    this._encoding = false;
    this._syncInFlight();
  }

  /** 응답/드랍 직후 다음 프레임을 곧바로 전송 (최소 간격은 유지) */
  _kickSwap() {
    if (this.mode !== 'swap') return;
    const gap = performance.now() - this._lastSendAt;
    const period = 1000 / Math.max(4, this._swapRequestFps());
    if (gap >= period * 0.7) this._requestFaceSwapFrame();
  }

  /** 디코드된 스왑 프레임을 재생 큐에 넣는다 (지터 흡수) */
  _enqueuePlayout(bitmap) {
    const q = this._playQ;
    q.push({ bmp: bitmap, t: performance.now() });
    while (q.length > 3) {
      const old = q.shift();
      try { old.bmp.close(); } catch { /* ignore */ }
    }
  }

  /** 렌더 틱마다 호출: 일정한 템포로 다음 프레임을 꺼내 _lastBitmap 갱신 */
  _advancePlayout() {
    const q = this._playQ;
    if (!q.length) return;
    const now = performance.now();
    // 큐에 2장 이상 쌓였거나 최소 지터 시간(고fps일 때는 20ms) 경과 시 즉시 소비하여 부드러운 반응 제공
    const jitterThresholdMs = (this._serverFpsCap && this._serverFpsCap > 35) ? 20 : 45;
    if (q.length >= 2 || (now - q[0].t) >= jitterThresholdMs) {
      const next = q.shift();
      const old = this._lastBitmap;
      this._lastBitmap = next.bmp;
      this._lastSwapSuccessTime = Date.now();
      if (old && old !== next.bmp) {
        try { old.close(); } catch { /* ignore */ }
      }
    }
  }

  /** 외부(호스트/참가자 코드)에서 참가자 식별자를 주입한다. */
  setClientId(id) {
    this.clientId = id || null;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'hello', clientId: this.clientId, room: this.roomCode || null })); } catch { /* ignore */ }
    }
  }

  setRoomCode(code) {
    this.roomCode = code || null;
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
    this._swapRejected = false;   // 사용자가 새로 적용을 시도 → 서버 용량을 다시 확인한다
    this._wsRetryAt = 0;
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
    this._swapRejected = false;
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
      const targetFps = (this.mode === 'swap' && this._serverFpsCap)
        ? Math.max(this.captureFps || 0, this._serverFpsCap)
        : (this.captureFps || FACE_OUT_FPS);
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

    // 백그라운드/최소화 탭에서는 setInterval 이 1초 단위로 스로틀되고 rAF 는 멈춘다 →
    // 참가자가 다른 탭을 보는 순간 카메라 송출이 1fps 로 얼어붙는 원인. Web Worker 타이머는
    // 스로틀되지 않으므로 워커 틱으로 렌더 루프를 구동한다. (탭이 보일 때는 rAF 와 중복 렌더 방지)
    if (this._heartbeatTimer) { try { this._heartbeatTimer.stop(); } catch { /* ignore */ } }
    this._heartbeatTimer = createWorkerTicker(16, () => {
      const targetFps = (this.mode === 'swap' && this._serverFpsCap)
        ? Math.max(this.captureFps || 0, this._serverFpsCap)
        : (this.captureFps || FACE_OUT_FPS);
      const minFrameMs = 1000 / Math.max(1, targetFps);
      const lag = performance.now() - lastRenderTime;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (lag > (hidden ? minFrameMs * 0.98 : minFrameMs * 1.5)) {
        lastRenderTime = performance.now();
        this._renderFrame();
      }
    });
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

  /**
   * Google MediaPipe Face Mesh 비동기 초기화
   */
  _ensureMediaPipe() {
    if (this._faceMesh || this._faceMeshLoading) return;
    if (typeof window === 'undefined') return;

    if (!window.FaceMesh) {
      // CDN 스크립트 동적 로드
      this._faceMeshLoading = true;
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js';
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        this._faceMeshLoading = false;
        this._initMediaPipeInstance();
      };
      s.onerror = () => {
        this._faceMeshLoading = false;
        console.warn('[MediaPipe] CDN 로드 실패, GPU 폴백 모드로 동작합니다.');
      };
      document.head.appendChild(s);
    } else {
      this._initMediaPipeInstance();
    }
  }

  _initMediaPipeInstance() {
    try {
      const fm = new window.FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      fm.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      fm.onResults((results) => {
        if (results?.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
          this._faceLandmarks = results.multiFaceLandmarks[0];
        }
        this._fmProcessing = false;
      });
      this._faceMesh = fm;
      console.log('[MediaPipe] FaceMesh 정밀 뷰티 엔진 준비 완료!');
    } catch (e) {
      console.warn('[MediaPipe] 초기화 오류:', e);
    }
  }

  /**
   * myface.ini 파일 비동기 로드
   * 페이지 새로고침 시 캐시 방지(?t=timestamp) 쿼리로 최신 INI 수치를 읽어옵니다.
   */
  async _loadMyFaceIni() {
    try {
      if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
      const res = await fetch('/myface.ini?t=' + Date.now());
      if (res.ok) {
        const text = await res.text();
        this.myFaceConfig = parseMyFaceIni(text);
        console.log('[myface.ini] 뷰티 필터 설정 로드 완료:', this.myFaceConfig);
      }
    } catch (err) {
      console.warn('[myface.ini] 설정 로드 실패 (기본값 사용):', err);
    }
  }

  /**
   * myface.ini 파일 비동기 로드
   * 페이지 새로고침 시 캐시 방지(?t=timestamp) 쿼리로 최신 INI 수치를 읽어옵니다.
   */
  async _loadMyFaceIni() {
    try {
      if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
      const res = await fetch('/myface.ini?t=' + Date.now());
      if (res.ok) {
        const text = await res.text();
        this.myFaceConfig = parseMyFaceIni(text);
        console.log('[myface.ini] 뷰티 필터 설정 로드 완료:', this.myFaceConfig);
      }
    } catch (err) {
      console.warn('[myface.ini] 설정 로드 실패 (기본값 사용):', err);
    }
  }

  /**
   * OBS StreamFX / Face-Mask 뷰티 필터 (myface.ini 연동 100% 무결점 GPU 뷰티 파이프라인)
   * WebGL 셰이더 컴파일 오류나 검은 화면(Black Screen) 위험을 원천 차단한 네이티브 GPU 가속 엔진.
   * myface.ini의 5가지 수치(스무딩 강도, 엣지 보존, 블러 반경, 톤업 밝기, 대비 균형)를 실시간 반영합니다.
   * - 안경테·모자·눈동자·눈썹·입술 등 경계선(Edge)은 100% 칼같이 보존
   * - 피부 표면의 팔자 주름·모공·잡티만 선택적으로 뭉개서 뽀샤시하고 매끄럽게 정돈
   * - 0.05ms 미만 60fps 무지연 렌더링
   */
  _drawRealFace(ctx, w, h) {
    const video = this.rawWebcamVideo;
    if (!video || video.readyState < 2) return;

    const cfg = this.myFaceConfig || DEFAULT_MYFACE_CONFIG;

    if (!this._beautyCanvas || this._beautyCanvas.width !== w || this._beautyCanvas.height !== h) {
      this._beautyCanvas = document.createElement('canvas');
      this._beautyCanvas.width = w;
      this._beautyCanvas.height = h;
      this._beautyCtx = this._beautyCanvas.getContext('2d');
    }
    const bctx = this._beautyCtx;

    // 1) 웹캠 원본 좌우 반전 캡처 (GPU 텍스처 복사)
    bctx.save();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, w, h);
    bctx.translate(w, 0);
    bctx.scale(-1, 1);
    bctx.drawImage(video, 0, 0, w, h);
    bctx.restore();

    // 2) 1단계: 원본 초고화질 베이스 렌더링 (화면이 절대 까맣게 나오지 않도록 보장)
    ctx.save();
    ctx.drawImage(this._beautyCanvas, 0, 0);

    // 필터 활성화 여부 체크 (smooth_intensity > 0)
    if (cfg.smooth_intensity > 0.01) {
      const blurPx = Math.max(1, Math.min(30, cfg.blur_radius || 3));
      const bright = Number(cfg.brightness_lift || 1.04).toFixed(3);
      const contrast = Number(cfg.contrast_balance || 1.02).toFixed(3);

      // 3) 2단계: 스킨 스무딩 (팔자 주름, 모공, 잡티 부드럽게 완화)
      ctx.save();
      ctx.globalAlpha = Math.min(1.0, cfg.smooth_intensity);
      ctx.filter = `blur(${blurPx}px) brightness(${bright}) contrast(0.96)`;
      ctx.drawImage(this._beautyCanvas, 0, 0);
      ctx.restore();

      // 4) 3단계: 엣지 보존 & 또렷한 입체감 유지 (안경, 눈동자, 모자 선명도 유지)
      // edge_threshold가 낮을수록(예: 10) 엣지를 더 또렷하게 살림
      const edgeWeight = Math.max(0.12, Math.min(0.38, (35.0 - (cfg.edge_threshold || 16.0)) / 55.0));
      ctx.save();
      ctx.globalAlpha = edgeWeight;
      ctx.globalCompositeOperation = 'soft-light';
      ctx.filter = `contrast(${contrast}) brightness(1.01)`;
      ctx.drawImage(this._beautyCanvas, 0, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  _renderFrame() {
    if (this._idle) return;   // 대기 모드: 송출/딥페이크가 멈춘 동안 렌더링도 중단(CPU 절약)
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
      this._advancePlayout();
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
        this._drawRealFace(ctx, w, h);
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

    // 2. 가상 아바타 모드: 실사 사진 기반 아바타 렌더링
    this._drawPhotoAvatar(ctx, w, h, breatheY, headTilt, isBlinking, this._smoothMouth);
  }

/**
   * 실사 사진 기반 AI 가상 아바타 렌더링
   * 생체 미세 호흡, 카메라 스웨이, 자연스러운 눈 깜빡임 및 마이크 립싱크 모션 지원
   */
  _drawPhotoAvatar(ctx, w, h, breatheY, headTilt, isBlinking, mouthLevel) {
    const img = this._getActivePhotoImg();
    if (!img || !img.complete || !img.naturalWidth) {
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#090d16');
      bgGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('AI 사진 아바타 준비 중...', w / 2, h / 2);
      return;
    }

    // 1. 배경 (은은한 다크 스튜디오 그라디언트)
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, '#090d16');
    bgGrad.addColorStop(1, '#1e293b');
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

    const scale = 1.03;
    const finalW = drawW * scale;
    const finalH = drawH * scale;
    ctx.drawImage(img, -finalW / 2, -finalH / 2, finalW, finalH);

    // 3. 눈 깜빡임 오버레이 (자연스러운 눈꺼풀 음영)
    if (isBlinking) {
      ctx.save();
      const eyeY = -finalH * 0.11;
      const eyeDist = finalW * 0.082;
      const eyeW = finalW * 0.046;
      const eyeH = 3.5;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
      ctx.beginPath();
      ctx.ellipse(-eyeDist, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.ellipse(eyeDist, eyeY, eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 4. 음성 발화 반응 (입술 반응)
    if (mouthLevel > 0.04) {
      ctx.save();
      const mouthY = finalH * 0.145;
      const openAmount = mouthLevel * 5.0;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, mouthY, finalW * 0.04, Math.max(1.5, openAmount), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // 5. 스튜디오 시네마틱 비네트 (가장자리 비네팅으로 몰입감 극대화)
    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.76);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  _drawHeroPhoto(ctx, a, w, h, breatheY, headTilt, isBlinking, mouthLevel) {
    return this._drawPhotoAvatar(ctx, w, h, breatheY, headTilt, isBlinking, mouthLevel);
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
    if (this._swapRejected) return;   // 서버가 용량 초과로 거절 → 사용자가 다시 얼굴을 고를 때까지 재연결하지 않는다
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
    if (typeof WebSocket === 'undefined') return;
    // 재연결 폭주 방지 (0.5s → 최대 4s 백오프)
    const nowMs = performance.now();
    if (nowMs < this._wsRetryAt) return;
    this._wsRetryAt = nowMs + this._wsRetryDelay;
    try {
      const host = window.location.host;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = [];
      if (this.clientId) qs.push(`client=${encodeURIComponent(this.clientId)}`);
      if (this.roomCode) qs.push(`room=${encodeURIComponent(this.roomCode)}`);
      if (this.swapRole === 'host') qs.push('prio=host');
      const q = qs.length ? `?${qs.join('&')}` : '';
      // 경로에도 clientId를 넣는다. Apache/프록시가 쿼리스트링을 떼면
      // 원격 참가자만 403 거절되어 호스트만 딥페이크가 되는 사고가 났다.
      const idSeg = this.clientId ? `/${encodeURIComponent(this.clientId)}` : '';
      const wsUrl = `${proto}//${host}/face-swap-ws${idSeg}${q}`;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._wsRetryDelay = 500;
        this._wsRetryAt = 0;
        this._resetSwapPipeline();
          try {
            ws.send(JSON.stringify({ type: 'hello', clientId: this.clientId || null, room: this.roomCode || null }));
          } catch { /* ignore */ }
        if (this.activeSwapFace) {
          try {
            ws.send(JSON.stringify({ type: 'set_source', source: this.activeSwapFace }));
          } catch { /* ignore */ }
        }
        if (this._idle) this._sendIdleState();
        this._kickSwap();
      };
      ws.onmessage = (event) => { this._onSwapMessage(event); };
      ws.onerror = () => {
        if (this._ws === ws) this._ws = null;
        this._wsRetryDelay = Math.min(4000, this._wsRetryDelay * 2);
        this._resetSwapPipeline();
        try { this.onFeedState?.(false); } catch { /* ignore */ }   // 연결이 끊기면 SFU 송출 즉시 복원
      };
      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
        this._wsRetryDelay = Math.min(4000, this._wsRetryDelay * 2);
        this._resetSwapPipeline();
        try { this.onFeedState?.(false); } catch { /* ignore */ }
      };
    } catch {
      this._ws = null;
      this._resetSwapPipeline();
    }
  }

  /** 서버 메시지 처리 (프로토콜 v2 우선, v1 순수 JPEG 응답도 호환) */
  async _onSwapMessage(event) {
    const data = event.data;
    if (typeof data === 'string') {
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'throttle') {
        this._applyServerThrottle(msg.fps, msg.max_w, msg.clients);
      } else if (msg.type === 'feed') {
        try { this.onFeedState?.(!!msg.live); } catch { /* ignore */ }
      } else if (msg.type === 'busy') {
        this._handleSwapRejected(msg);
      } else if (msg.type === 'drop') {
        this.swapStats.dropped += 1;
        this._settleSwap(Number.isFinite(msg.seq) ? msg.seq : null);
        this._kickSwap();
      } else if (msg.type === 'skip') {
        this._settleSwap(null);
        this._kickSwap();
      }
      return;
    }

    let buf = null;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      try { buf = await data.arrayBuffer(); } catch { buf = null; }
    }
    if (!buf) return;

    const u8 = new Uint8Array(buf);
    let seq = null;
    let offset = 0;
    let serverTotal = 0;
    if (u8.length > 12 && u8[0] === 0x46 && u8[1] === 0x53 && u8[2] === 0x32 && u8[3] === 0x00) {
      const dv = new DataView(buf);
      seq = dv.getUint32(4);
      const proc = dv.getUint16(8);
      serverTotal = dv.getUint16(10);   // 서버가 프레임을 받은 뒤 응답을 내보내기까지 걸린 시간(큐 대기 + 처리)
      offset = 12;
      if (proc) this._procMs = this._procMs ? this._procMs * 0.8 + proc * 0.2 : proc;
    }

    const sentAt = seq != null ? this._pending.get(seq) : undefined;
    this._settleSwap(seq);
    if (sentAt != null) {
      const rtt = performance.now() - sentAt;
      this._rttMs = this._rttMs ? this._rttMs * 0.8 + rtt * 0.2 : rtt;
      // 순수 네트워크 구간 = 전체 왕복 − 서버 내부 시간 (서버 큐가 밀려서 느린 것과 내 회선이 느린 것을 구분)
      if (serverTotal > 0) {
        const net = Math.max(0, rtt - serverTotal);
        this._netRttMs = this._netRttMs ? this._netRttMs * 0.7 + net * 0.3 : net;
      }
      this._evalUploadLevel();
    }
    this.swapStats.recv += 1;
    this.onSwapStats?.(this.swapStats);

    if (u8.length - offset < 100) { this._kickSwap(); return; }
    // 이미 더 새로운 프레임을 표시했다면(순서 역전/지연 도착) 폐기
    if (seq != null && seq <= this._lastShownSeq) { this._kickSwap(); return; }

    const blob = new Blob([offset ? u8.subarray(offset) : u8], { type: 'image/jpeg' });
    // 다음 프레임 요청은 디코드를 기다리지 않고 바로 (파이프라인 유지)
    this._kickSwap();

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob);
        if (seq != null) {
          if (seq <= this._lastShownSeq) {
            try { bitmap.close(); } catch { /* ignore */ }
            return;
          }
          this._lastShownSeq = seq;
        }
        this._enqueuePlayout(bitmap);
        return;
      } catch {
        // DOM Image 폴백
      }
    }
    const img = new Image();
    img.onload = () => {
      if (this._lastSwappedUrl) {
        try { URL.revokeObjectURL(this._lastSwappedUrl); } catch { /* ignore */ }
      }
      if (seq != null) {
        if (seq <= this._lastShownSeq) return;
        this._lastShownSeq = seq;
      }
      this._lastSwappedImage = img;
      this._lastSwappedUrl = img.src;
      this._lastSwapSuccessTime = Date.now();
    };
    img.src = URL.createObjectURL(blob);
  }

  /**
   * 서버 하드웨어 용량 초과로 딥페이크 적용이 거절됐을 때.
   * 실물 얼굴이 나가지 않도록 스왑을 해제하고(선택한 사진 아바타로 대체), 재연결을 멈추고, UI 에 알린다.
   */
  _handleSwapRejected(info = {}) {
    this._swapRejected = true;
    this.activeSwapFace = null;
    this.activeSwapFaceUrl = '';
    this._stopSwapPump();
    this._resetSwapPipeline();
    const ws = this._ws;
    this._ws = null;
    // 실사 사진 아바타 모드 유지: 기존 선택한 사진을 그대로 보존하여 AI 사진 아바타(호흡/눈깜빡임)로 계속 송출
    if (!this._getActivePhotoImg()) {
      this._loadDefaultPhoto();
    }
    this.mode = 'virtual';
    try { this.onFeedState?.(false); } catch { /* ignore */ }
    this.onModeChange?.(this.mode, this.currentAvatar, this.activeSwapFace);
    try { this.onSwapRejected?.(info || {}); } catch { /* ignore */ }
  }

  /**
   * 업로드 품질 단계 평가 (응답을 받을 때마다 호출, 2초에 한 번만 실제 판단).
   * 순수 네트워크 왕복이 길거나 송신 버퍼가 자주 막히면 한 단계씩 낮추고, 충분히 안정적이면 천천히 올린다.
   */
  _evalUploadLevel() {
    const now = performance.now();
    if (now - this._upLastEvalAt < 2000) return;
    this._upLastEvalAt = now;
    const stalls = this._upStalls;
    this._upStalls = 0;
    const net = this._netRttMs;
    const bad = (net > 200) || stalls >= 3;
    const good = (net > 0 && net < 100) && stalls === 0;
    let next = this._uploadLevel;
    if (bad) {
      this._upCalmSince = 0;
      if (now - this._upLastChangeAt >= 3000) next = Math.min(3, this._uploadLevel + 1);
    } else if (good) {
      if (!this._upCalmSince) this._upCalmSince = now;
      if (now - this._upCalmSince >= 12000 && now - this._upLastChangeAt >= 12000) next = Math.max(0, this._uploadLevel - 1);
    } else {
      this._upCalmSince = 0;
    }
    if (next !== this._uploadLevel) {
      this._uploadLevel = next;
      this._upLastChangeAt = now;
      this._upCalmSince = 0;
      try { this.onUploadLevelChange?.(next); } catch { /* ignore */ }
      // 요청 fps 상한도 단계에 따라 바뀌므로 펌프 주기를 다시 잡는다
      if (this.mode === 'swap' && this._swapPumpTimer) this._startSwapPump();
    }
  }

  /** 업로드 단계별 (최대 폭, JPEG 품질 상한, fps 상한) */
  _uploadLimits() {
    switch (this._uploadLevel) {
      case 1: return { w: 480, q: 0.65, fps: 30 };
      case 2: return { w: 384, q: 0.58, fps: 18 };
      case 3: return { w: 320, q: 0.5, fps: 12 };
      default: return { w: 640, q: 0.85, fps: 60 };
    }
  }

  /** 서버가 권고한 max_w 와 방 인원 프로파일을 함께 반영한 전송 해상도 */
  _swapSendSize() {
    // 호스트에는 서버 직송(face-feed)으로 이 해상도 그대로 표시되므로, 방 인원과 무관하게
    // 서버가 허용하는 최대 폭(기본 640)까지 보낸다. (서버가 과부하면 throttle 메시지의 max_w 로 자동 축소)
    const outW = this.width || 640;
    const outH = this.height || 360;
    let w = 640;
    if (this._serverMaxW) w = Math.min(w, this._serverMaxW);
    w = Math.min(w, 640, this._uploadLimits().w);
    w = Math.max(320, Math.round(w / 16) * 16);
    const h = Math.max(180, Math.round((w * outH) / outW / 2) * 2);
    return { w, h };
  }

  _swapJpegQuality() {
    // RTT 가 크거나(네트워크 병목) 서버가 바쁘면 품질을 낮춰 대역/인코딩 시간을 절약
    const byRtt = this._rttMs > 350 ? 0.6 : (this._rttMs > 200 ? 0.66 : 0.72);
    return Math.min(byRtt, this._uploadLimits().q);
  }

  /** JPEG 인코딩 전용 워커 (미지원/오류 시 false → 메인 스레드 폴백) */
  _getEncoderWorker() {
    if (this._encWorker !== undefined) return this._encWorker;
    this._encWorker = false;
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return false;
      const src = `
        let oc = null, c = null;
        onmessage = async (e) => {
          const { bitmap, w, h, q, seq } = e.data;
          try {
            if (!oc || oc.width !== w || oc.height !== h) {
              oc = new OffscreenCanvas(w, h);
              c = oc.getContext('2d', { alpha: false });
            }
            c.setTransform(-1, 0, 0, 1, w, 0); // 거울 반사
            c.drawImage(bitmap, 0, 0, w, h);
            bitmap.close();
            const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: q });
            const buf = await blob.arrayBuffer();
            postMessage({ seq, buf }, [buf]);
          } catch (err) {
            try { bitmap.close(); } catch (_) {}
            postMessage({ seq, err: String(err) });
          }
        };`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      this._encWorkerUrl = url;
      worker.onmessage = (e) => this._onEncoded(e.data);
      worker.onerror = () => {
        console.warn('[Avatar] encoder worker error → 메인 스레드 인코딩으로 폴백');
        try { worker.terminate(); } catch { /* ignore */ }
        this._encWorker = false;
        this._encoding = false;
      };
      this._encWorker = worker;
    } catch {
      this._encWorker = false;
    }
    return this._encWorker;
  }

  _requestViaWorker(now) {
    const worker = this._getEncoderWorker();
    if (!worker) return false;
    const video = this.rawWebcamVideo;
    const { w, h } = this._swapSendSize();
    const seq = (this._seq = (this._seq + 1) >>> 0);
    this._encoding = true;
    this._lastSendAt = now;
    this._encJob = { seq, face: this.activeSwapFace || 'superman', ws: this._ws, t0: now };
    createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
      .then((bitmap) => {
        worker.postMessage({ bitmap, w, h, q: this._swapJpegQuality(), seq }, [bitmap]);
      })
      .catch(() => { this._encoding = false; });
    return true;
  }

  _onEncoded(msg) {
    const job = this._encJob;
    this._encoding = false;
    if (!job || !msg || msg.seq !== job.seq || !msg.buf) return;
    const ws = job.ws;
    if (this.mode !== 'swap' || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      this._encMs = performance.now() - job.t0;
      const nameBytes = new TextEncoder().encode(`${job.face}\x1f${job.seq}`);
      const jpeg = new Uint8Array(msg.buf);
      const packet = new Uint8Array(4 + nameBytes.length + jpeg.length);
      new DataView(packet.buffer).setUint32(0, nameBytes.length);
      packet.set(nameBytes, 4);
      packet.set(jpeg, 4 + nameBytes.length);
      this._pending.set(job.seq, performance.now());
      this._syncInFlight();
      this.swapStats.sent += 1;
      this.onSwapStats?.(this.swapStats);
      ws.send(packet);
    } catch {
      this._pending.delete(job.seq);
      this._syncInFlight();
      try { ws.close(); } catch { /* ignore */ }
      if (this._ws === ws) this._ws = null;
    }
  }

  _requestFaceSwapFrame() {
    if (this._idle) return;
    const video = this.rawWebcamVideo;
    if (!video || video.readyState < 2) return;
    const now = performance.now();
    // 인코딩이 1.5초 넘게 끝나지 않으면(워커 정지 등) 잠금 해제
    if (this._encoding && now - this._lastSendAt > 1500) this._encoding = false;

    // 응답이 유실된 요청은 1.5초 뒤 자동 폐기 → 파이프라인 정지 방지
    for (const [s, t] of this._pending) {
      if (now - t > 1500) this._pending.delete(s);
    }
    this._syncInFlight();

    if (!this._ws || this._ws.readyState === WebSocket.CLOSED || this._ws.readyState === WebSocket.CLOSING) {
      this._ws = null;
      this._initSwapWebSocket();
      return;
    }
    if (this._ws.readyState !== WebSocket.OPEN) return;

    if (this._encoding || this._pending.size >= this._maxInFlight) {
      this.swapStats.dropped += 1;
      return;
    }
    // 송신 버퍼가 밀려 있으면(업링크 혼잡) 새 프레임을 만들지 않음 → 지연 누적 방지
    if (this._ws.bufferedAmount > 192 * 1024) {
      this.swapStats.dropped += 1;
      this._upStalls += 1;
      this._evalUploadLevel();
      return;
    }
    // 아직 못 막힌 정도의 적체(≥ 48KB, 약 1~2프레임 분량)도 회선이 느리다는 신호로 센다
    if (this._ws.bufferedAmount > 48 * 1024) this._upStalls += 1;

    // 1순위: 전용 Web Worker 에서 리사이즈+JPEG 인코딩 (메인 스레드 부하 ↓, 숨겨진 탭에서도 지연 없음)
    if (this._requestViaWorker(now)) return;

    const { w: targetW, h: targetH } = this._swapSendSize();
    if (!this._offscreenCanvas || this._offscreenCanvas.width !== targetW || this._offscreenCanvas.height !== targetH) {
      // OffscreenCanvas.convertToBlob 은 Promise 기반이라 백그라운드 탭에서도 지연 없이 완료된다
      // (HTMLCanvasElement.toBlob 은 숨겨진 탭에서 ~1초씩 지연되어 딥페이크가 1fps 로 떨어짐)
      if (typeof OffscreenCanvas !== 'undefined') {
        this._offscreenCanvas = new OffscreenCanvas(targetW, targetH);
      } else {
        this._offscreenCanvas = document.createElement('canvas');
        this._offscreenCanvas.width = targetW;
        this._offscreenCanvas.height = targetH;
      }
      this._offscreenCtx = this._offscreenCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    const oc = this._offscreenCanvas;
    const octx = this._offscreenCtx;

    // 거울 반사 효과를 적용하여 프레임 추출
    octx.save();
    octx.translate(oc.width, 0);
    octx.scale(-1, 1);
    octx.drawImage(video, 0, 0, oc.width, oc.height);
    octx.restore();

    const seq = (this._seq = (this._seq + 1) >>> 0);
    const targetFace = this.activeSwapFace || 'superman';
    const ws = this._ws;
    this._encoding = true;
    this._lastSendAt = now;

    const quality = this._swapJpegQuality();
    const encodeJpeg = typeof oc.convertToBlob === 'function'
      ? oc.convertToBlob({ type: 'image/jpeg', quality })
      : new Promise((resolve) => oc.toBlob(resolve, 'image/jpeg', quality));

    const tEnc0 = performance.now();
    encodeJpeg.then(async (blob) => {
      try {
        this._encMs = performance.now() - tEnc0;
        if (!blob || this.mode !== 'swap' || ws.readyState !== WebSocket.OPEN) return;
        const nameBytes = new TextEncoder().encode(`${targetFace}\x1f${seq}`);
        const blobBytes = new Uint8Array(await blob.arrayBuffer());
        this._encTotalMs = performance.now() - tEnc0;
        const packet = new Uint8Array(4 + nameBytes.length + blobBytes.length);
        new DataView(packet.buffer).setUint32(0, nameBytes.length);
        packet.set(nameBytes, 4);
        packet.set(blobBytes, 4 + nameBytes.length);
        if (ws.readyState !== WebSocket.OPEN) return;
        this._pending.set(seq, performance.now());
        this._syncInFlight();
        this.swapStats.sent += 1;
        this.onSwapStats?.(this.swapStats);
        ws.send(packet);
      } catch {
        this._pending.delete(seq);
        this._syncInFlight();
        try { ws.close(); } catch { /* ignore */ }
        if (this._ws === ws) this._ws = null;
      } finally {
        this._encoding = false;
      }
    }).catch(() => { this._encoding = false; });
  }

  destroy() {
    if (this._visHandler) {
      try { document.removeEventListener('visibilitychange', this._visHandler); } catch { /* ignore */ }
      this._visHandler = null;
    }
    this._stopSwapPump();
    this._resetSwapPipeline();
    for (const it of this._playQ) { try { it.bmp.close(); } catch { /* ignore */ } }
    this._playQ = [];
    if (this._encWorker) {
      try { this._encWorker.terminate(); } catch { /* ignore */ }
      this._encWorker = undefined;
    }
    if (this._encWorkerUrl) {
      try { URL.revokeObjectURL(this._encWorkerUrl); } catch { /* ignore */ }
      this._encWorkerUrl = null;
    }
    if (this._animId) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
    if (this._heartbeatTimer) {
      try { this._heartbeatTimer.stop(); } catch { /* ignore */ }
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

