/**
 * YUNSEUL MEET — 호스트 솔로 뷰티 필터 & 딥페이크 튜닝 바, 송출 해상도 & 부하 최적화 패널 및 관리자 인증 매니저
 * - 원본 동영상 모드 (real): 5개 뷰티 항목 (스킨 스무딩, 엣지 보존, 블러 반경, 피부 톤업, 입체감 대비)
 * - 딥페이크 모드 (swap): 5개 딥페이크 항목 (합성 혼합 강도, 디테일 선명도, 경계면 페더링, 피부톤/조명 일치, 얼굴 인식 민감도)
 * - 송출 해상도 패널 (오른쪽): 1080p FHD ~ 180p Min 및 자동 최적화 옵션 (접속자 증가 시 부하 분산 지원)
 * - 동영상 화면 좌측 상단 자물쇠(🔒) 클릭 -> 관리자 비밀번호(13240305) 인증 후 배경 20% 투명 + 10px 라운딩 박스 표시
 * - 설정은 myface.ini 파일의 [beauty]와 [Deepface] 섹션에 각각 저장되고 상호 연동됩니다.
 */
import { showToast } from './ui-toast.js?v=20260930a';

const ADMIN_PASSWORD = '13240305';
const AUTH_STORAGE_KEY = 'myface_admin_authed';

export const DEFAULT_BEAUTY_CONFIG = {
  smooth_intensity: 0.22,
  edge_threshold: 100.0,
  blur_radius: 1,
  brightness_lift: 2.50,
  contrast_balance: 1.46,
};

export const DEFAULT_DEEPFACE_CONFIG = {
  swap_blend_ratio: 1.00,
  detail_sharpen: 0.50,
  border_feather: 15,
  tone_matching: 0.80,
  detection_threshold: 0.60,
};

export const RES_MODES = [
  { id: 'auto', title: '⚡ 자동 최적화 (Auto)', badge: '접속자 감지', badgeClass: 'badge-auto', desc: '참가자 수 변동에 맞춰 최적 해상도를 실시간 자동 전환합니다.', label: '자동(Auto)' },
  { id: '1080p', title: '🌟 1080p FHD <small>(1920×1080)</small>', badge: '단독 최고화질', badgeClass: 'badge-fhd', desc: '호스트 1인 단독 방송용 초고화질 (~2.5 Mbps, 30fps)', label: '1080p FHD' },
  { id: '720p', title: '✨ 720p HD <small>(1280×720)</small>', badge: '1~2인 고화질', badgeClass: 'badge-hd', desc: '선명하고 또렷한 HD 방송 품질 (~1.5 Mbps, 30fps)', label: '720p HD' },
  { id: '540p', title: '🔹 540p qHD <small>(960×540)</small>', badge: '기본값 · 3~6인', badgeClass: 'badge-default', desc: '화질과 회선 안정성의 최적 균형 (~900 kbps, 30fps)', label: '540p qHD' },
  { id: '360p', title: '🟢 360p SD <small>(640×360)</small>', badge: '7~12인 안정', badgeClass: 'badge-sd', desc: '접속자가 늘어날 때 버벅임을 방지하는 표준 모드 (~350 kbps)', label: '360p SD' },
  { id: '288p', title: '🟡 288p Low <small>(512×288)</small>', badge: '13~20인 절약', badgeClass: 'badge-low', desc: '많은 참가자가 들어올 때 부하를 대폭 절감 (~170 kbps)', label: '288p Low' },
  { id: '216p', title: '🟠 216p Pack <small>(384×216)</small>', badge: '21~30인 초절약', badgeClass: 'badge-pack', desc: '네트워크 트래픽을 최소화하여 끊김 방지 (~110 kbps)', label: '216p Pack' },
  { id: '180p', title: '🔴 180p Min <small>(320×180)</small>', badge: '31인+ 대규모', badgeClass: 'badge-min', desc: '서버/시청자 대역폭을 극도로 아껴 최대 인원 수용 (~80 kbps)', label: '180p Min' },
];

export class HostBeautyBarManager {
  constructor({ getAvatarManager, getPublisher, getSocket } = {}) {
    this.getAvatarManager = getAvatarManager || (() => null);
    this.getPublisher = getPublisher || (() => null);
    this.getSocket = getSocket || (() => null);

    this.beautyConfig = { ...DEFAULT_BEAUTY_CONFIG };
    this.deepfaceConfig = { ...DEFAULT_DEEPFACE_CONFIG };

    this.currentMode = 'beauty'; // 'beauty' (원본 영상) | 'deepface' (딥페이크)
    this.currentResMode = localStorage.getItem('myface_host_face_res_mode') || '540p'; // 기본값은 지금 설정 해상도
    this.containerEl = null;
    this.lockBtnEl = null;
    this.boxEl = null;
    this.resBoxEl = null;
    this.isOpen = false;
    this._saveTimer = null;
    this._modePollTimer = null;
    this._statusTimer = null;

    this._initModal();
    this._loadInitialConfig();
    this._initSocket();
    this._startModeWatcher();
    this._startStatusWatcher();
  }

  isAuthed() {
    try {
      return sessionStorage.getItem(AUTH_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  setAuthed(authed) {
    try {
      if (authed) {
        sessionStorage.setItem(AUTH_STORAGE_KEY, 'true');
      } else {
        sessionStorage.removeItem(AUTH_STORAGE_KEY);
      }
    } catch { /* ignore */ }
    this.updateLockIcon();
  }

  async _loadInitialConfig() {
    try {
      const res = await fetch('/api/myface-config?t=' + Date.now());
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.config) {
          const cfg = data.config;
          if (cfg.beauty) {
            this.beautyConfig = { ...this.beautyConfig, ...cfg.beauty };
          } else {
            for (const k in this.beautyConfig) {
              if (typeof cfg[k] === 'number') this.beautyConfig[k] = cfg[k];
            }
          }
          if (cfg.deepface) {
            this.deepfaceConfig = { ...this.deepfaceConfig, ...cfg.deepface };
          }
          this.syncSlidersFromConfig();

          const avMgr = this.getAvatarManager();
          if (avMgr) {
            avMgr.updateMyFaceConfig?.({
              beauty: this.beautyConfig,
              deepface: this.deepfaceConfig,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[HostBeautyBar] 설정 로드 실패 (기본값 유지):', err);
    }
  }

  _initSocket() {
    const bindSocket = () => {
      const socket = this.getSocket();
      if (!socket || this._socketBound) return;
      this._socketBound = true;
      socket.on('myface-config-updated', ({ config }) => {
        if (!config || typeof config !== 'object') return;
        if (config.beauty) {
          this.beautyConfig = { ...this.beautyConfig, ...config.beauty };
        }
        if (config.deepface) {
          this.deepfaceConfig = { ...this.deepfaceConfig, ...config.deepface };
        }
        this.syncSlidersFromConfig();
        const avMgr = this.getAvatarManager();
        if (avMgr) {
          avMgr.updateMyFaceConfig?.(config);
        }
      });
    };
    bindSocket();
    setTimeout(bindSocket, 1000);
    setTimeout(bindSocket, 3000);
  }

  _startModeWatcher() {
    let lastIsSwap = null;
    this._modePollTimer = setInterval(() => {
      const avMgr = this.getAvatarManager();
      if (!avMgr) return;
      const isSwap = !!(avMgr.isSwap || (avMgr.mode === 'swap' && avMgr.activeSwapFace));
      if (isSwap !== lastIsSwap) {
        lastIsSwap = isSwap;
        const targetMode = isSwap ? 'deepface' : 'beauty';
        if (this.currentMode !== targetMode) {
          this.switchMode(targetMode, false);
        }
      }
    }, 500);
  }

  _startStatusWatcher() {
    this._statusTimer = setInterval(() => {
      this.updateStatusDisplay();
    }, 1000);
  }

  updateStatusDisplay() {
    if (!this.resBoxEl) return;
    const avMgr = this.getAvatarManager();
    if (!avMgr) return;

    const w = avMgr.width || 960;
    const h = avMgr.height || 540;
    const fps = avMgr.captureFps || 30;
    const profile = avMgr.getFaceProfile?.() || {};
    const bitrate = profile.maxBitrate ? Math.round(profile.maxBitrate / 1000) : 900;

    const elRes = this.resBoxEl.querySelector('#solo-res-status-res');
    const elFps = this.resBoxEl.querySelector('#solo-res-status-fps');
    const elBitrate = this.resBoxEl.querySelector('#solo-res-status-bitrate');

    if (elRes) elRes.textContent = `해상도: ${w}×${h}`;
    if (elFps) elFps.textContent = `${fps} fps`;
    if (elBitrate) elBitrate.textContent = `상한: ${bitrate} kbps`;
  }

  _initModal() {
    this.modal = document.getElementById('myface-auth-modal');
    if (!this.modal) return;

    this.passwordInput = document.getElementById('myface-auth-password');
    this.errorMsgEl = document.getElementById('myface-auth-error-msg');
    this.btnConfirm = document.getElementById('btn-myface-auth-confirm');
    this.btnCancel = document.getElementById('btn-myface-auth-cancel');

    this.btnConfirm?.addEventListener('click', () => this._handleAuthSubmit());
    this.btnCancel?.addEventListener('click', () => this._handleAuthCancel());

    this.passwordInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._handleAuthSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._handleAuthCancel();
      }
    });

    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this._handleAuthCancel();
      }
    });
  }

  openAuthModal() {
    if (!this.modal) {
      const pw = prompt('관리자 비밀번호를 입력해 주세요 (초기 비밀번호: 13240305)');
      if (pw === ADMIN_PASSWORD) {
        this.setAuthed(true);
        this.openBox();
        showToast('관리자 인증이 완료되었습니다.', 'info', 3000);
      } else {
        alert('접근할 수 없습니다.');
      }
      return;
    }

    if (this.errorMsgEl) this.errorMsgEl.classList.add('hidden');
    if (this.passwordInput) {
      this.passwordInput.value = '';
    }
    this.modal.classList.remove('hidden');
    setTimeout(() => this.passwordInput?.focus(), 50);
  }

  closeAuthModal() {
    if (this.modal) {
      this.modal.classList.add('hidden');
    }
  }

  _handleAuthSubmit() {
    const val = (this.passwordInput?.value || '').trim();
    if (val === ADMIN_PASSWORD) {
      this.setAuthed(true);
      this.closeAuthModal();
      this.openBox();
      showToast('관리자 인증이 완료되었습니다.', 'info', 3000);
    } else {
      if (this.errorMsgEl) {
        this.errorMsgEl.textContent = '접근할 수 없습니다.';
        this.errorMsgEl.classList.remove('hidden');
      }
      alert('접근할 수 없습니다.');
      if (this.passwordInput) {
        this.passwordInput.value = '';
        this.passwordInput.focus();
      }
    }
  }

  _handleAuthCancel() {
    this.closeAuthModal();
    alert('접근할 수 없습니다.');
  }

  updateLockIcon() {
    if (!this.lockBtnEl) return;
    const authed = this.isAuthed();
    const iconSpan = this.lockBtnEl.querySelector('.lock-icon');
    if (iconSpan) {
      iconSpan.textContent = authed ? '🔓' : '🔒';
    }
    this.lockBtnEl.classList.toggle('is-unlocked', authed);
    this.lockBtnEl.title = authed ? '설정 패널 열기/닫기' : '설정 (관리자 인증 필요)';
  }

  openBox() {
    this.isOpen = true;
    if (this.boxEl) {
      const avMgr = this.getAvatarManager();
      const isSwap = !!(avMgr?.isSwap || (avMgr?.mode === 'swap' && avMgr?.activeSwapFace));
      this.switchMode(isSwap ? 'deepface' : 'beauty', false);
      this.boxEl.classList.remove('hidden');
      this.syncSlidersFromConfig();
    }
    if (this.resBoxEl) {
      this.resBoxEl.classList.remove('hidden');
      this.syncResUI();
    }
    this.updateLockIcon();
  }

  closeBox() {
    this.isOpen = false;
    if (this.boxEl) {
      this.boxEl.classList.add('hidden');
    }
    if (this.resBoxEl) {
      this.resBoxEl.classList.add('hidden');
    }
    this.updateLockIcon();
  }

  toggleBox() {
    const isAnyOpen = (this.boxEl && !this.boxEl.classList.contains('hidden')) ||
                      (this.resBoxEl && !this.resBoxEl.classList.contains('hidden'));
    if (isAnyOpen) {
      this.closeBox();
    } else {
      this.openBox();
    }
  }

  switchMode(mode, userClicked = true) {
    this.currentMode = mode === 'deepface' ? 'deepface' : 'beauty';
    if (!this.boxEl) return;

    const tabBtns = this.boxEl.querySelectorAll('.solo-beauty-tab-btn');
    tabBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
    });

    const beautyPanel = this.boxEl.querySelector('#panel-beauty-sliders');
    const deepfacePanel = this.boxEl.querySelector('#panel-deepface-sliders');
    const headerTitle = this.boxEl.querySelector('.solo-beauty-box-title .title-text');

    if (this.currentMode === 'deepface') {
      beautyPanel?.classList.add('hidden');
      deepfacePanel?.classList.remove('hidden');
      if (headerTitle) headerTitle.textContent = '딥페이크 튜닝 설정';
    } else {
      deepfacePanel?.classList.add('hidden');
      beautyPanel?.classList.remove('hidden');
      if (headerTitle) headerTitle.textContent = '원본 영상 뷰티 필터';
    }

    this.syncSlidersFromConfig();
  }

  syncResUI() {
    if (!this.resBoxEl) return;
    const items = this.resBoxEl.querySelectorAll('.solo-res-item');
    items.forEach((item) => {
      item.classList.toggle('active', item.dataset.mode === this.currentResMode);
    });

    const currentObj = RES_MODES.find((m) => m.id === this.currentResMode) || RES_MODES[3];
    const badgeEl = this.resBoxEl.querySelector('#solo-res-current-badge');
    if (badgeEl) {
      badgeEl.textContent = currentObj.label;
    }
    this.updateStatusDisplay();
  }

  applyResolutionMode(mode, showNotice = true) {
    this.currentResMode = mode;
    localStorage.setItem('myface_host_face_res_mode', mode);

    const pub = this.getPublisher();
    if (pub?.setManualFaceMode) {
      pub.setManualFaceMode(mode).catch?.(() => {});
    } else {
      const avMgr = this.getAvatarManager();
      if (avMgr?.setFaceMode) {
        const effective = (mode === 'auto') ? 'high' : mode;
        avMgr.setFaceMode(effective);
      }
    }

    this.syncResUI();

    if (showNotice) {
      const item = RES_MODES.find((m) => m.id === mode) || { label: mode };
      showToast(`송출 해상도가 [${item.label}]로 설정되었습니다.`, 'info', 2500);
    }
  }

  syncSlidersFromConfig() {
    if (!this.boxEl) return;

    const beautyRanges = this.boxEl.querySelectorAll('#panel-beauty-sliders .solo-beauty-range');
    beautyRanges.forEach((range) => {
      const key = range.dataset.key;
      if (this.beautyConfig[key] !== undefined) {
        range.value = this.beautyConfig[key];
        this._updateValueLabel('beauty', key, this.beautyConfig[key]);
      }
    });

    const deepfaceRanges = this.boxEl.querySelectorAll('#panel-deepface-sliders .solo-beauty-range');
    deepfaceRanges.forEach((range) => {
      const key = range.dataset.key;
      if (this.deepfaceConfig[key] !== undefined) {
        range.value = this.deepfaceConfig[key];
        this._updateValueLabel('deepface', key, this.deepfaceConfig[key]);
      }
    });
  }

  _updateValueLabel(section, key, val) {
    if (!this.boxEl) return;
    const selector = section === 'deepface' ? '#panel-deepface-sliders' : '#panel-beauty-sliders';
    const panel = this.boxEl.querySelector(selector);
    if (!panel) return;

    const valEl = panel.querySelector(`[data-val-for="${key}"]`);
    if (!valEl) return;

    const num = Number(val);
    if (section === 'deepface') {
      if (key === 'swap_blend_ratio' || key === 'tone_matching') {
        valEl.textContent = `${Math.round(num * 100)}%`;
      } else if (key === 'border_feather') {
        valEl.textContent = `${Math.round(num)}px`;
      } else if (key === 'detail_sharpen' || key === 'detection_threshold') {
        valEl.textContent = num.toFixed(2);
      } else {
        valEl.textContent = String(val);
      }
    } else {
      if (key === 'smooth_intensity') {
        valEl.textContent = num.toFixed(2);
      } else if (key === 'edge_threshold') {
        valEl.textContent = num.toFixed(1);
      } else if (key === 'blur_radius') {
        valEl.textContent = `${Math.round(num)}px`;
      } else if (key === 'brightness_lift') {
        valEl.textContent = `${num.toFixed(2)}x`;
      } else if (key === 'contrast_balance') {
        valEl.textContent = `${num.toFixed(2)}x`;
      } else {
        valEl.textContent = String(val);
      }
    }
  }

  attachToCard(card) {
    if (!card) return;
    if (card.querySelector('.solo-beauty-container')) {
      this.containerEl = card.querySelector('.solo-beauty-container');
      this.lockBtnEl = this.containerEl.querySelector('.solo-beauty-lock-btn');
      this.boxEl = this.containerEl.querySelector('.solo-beauty-box');
      this.resBoxEl = this.containerEl.querySelector('.solo-res-box');
      return;
    }

    const resItemsHtml = RES_MODES.map((m) => `
      <button type="button" class="solo-res-item ${m.id === this.currentResMode ? 'active' : ''}" data-mode="${m.id}">
        <div class="res-item-header">
          <span class="res-item-title">${m.title}</span>
          <span class="res-item-badge ${m.badgeClass}">${m.badge}</span>
        </div>
        <div class="res-item-desc">${m.desc}</div>
      </button>
    `).join('');

    const container = document.createElement('div');
    container.className = 'solo-beauty-container';
    container.innerHTML = `
      <div class="solo-beauty-lock-wrapper">
        <button type="button" class="solo-beauty-lock-btn" id="btn-beauty-lock" title="뷰티 / 딥페이크 / 해상도 설정">
          <span class="lock-icon">🔒</span>
        </button>
      </div>

      <div class="solo-panels-wrapper">
        <!-- 1. 기존 원본 뷰티 & 딥페이크 설정 박스 (기존 디자인 및 5개 슬라이더 100% 보존) -->
        <div class="solo-beauty-box hidden" id="solo-beauty-box">
          <div class="solo-beauty-box-header">
            <div class="solo-beauty-box-title">
              <span class="box-header-icon">✨</span>
              <span class="title-text">원본 영상 뷰티 필터</span>
              <span class="solo-beauty-save-indicator" id="solo-beauty-save-indicator">저장됨</span>
            </div>
            <button type="button" class="solo-beauty-box-close" id="btn-beauty-box-close" title="닫기">✕</button>
          </div>

          <!-- 모드 전환 탭 (원본 영상 뷰티 vs 딥페이크 설정) -->
          <div class="solo-beauty-tabs">
            <button type="button" class="solo-beauty-tab-btn active" data-mode="beauty">👤 원본 뷰티</button>
            <button type="button" class="solo-beauty-tab-btn" data-mode="deepface">🎭 딥페이크</button>
          </div>

          <!-- 1. 원본 동영상 모드 슬라이더 (5개 항목) -->
          <div class="solo-beauty-sliders-list" id="panel-beauty-sliders">
            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">스킨 스무딩</span>
                <span class="param-val" data-val-for="smooth_intensity">0.22</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="beauty" data-key="smooth_intensity" min="0" max="1" step="0.01" value="0.22" />
              <div class="param-hints"><span>0.00 (끔)</span><span>1.00 (최대)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">엣지 보존</span>
                <span class="param-val" data-val-for="edge_threshold">100.0</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="beauty" data-key="edge_threshold" min="1" max="100" step="0.5" value="100.0" />
              <div class="param-hints"><span>1.0 (선명)</span><span>100.0 (뭉갬)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">블러 반경</span>
                <span class="param-val" data-val-for="blur_radius">1px</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="beauty" data-key="blur_radius" min="1" max="30" step="1" value="1" />
              <div class="param-hints"><span>1px (미세)</span><span>30px (소프트)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">피부 톤업</span>
                <span class="param-val" data-val-for="brightness_lift">2.50x</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="beauty" data-key="brightness_lift" min="0.50" max="2.50" step="0.01" value="2.50" />
              <div class="param-hints"><span>0.50 (어둡게)</span><span>2.50 (화사함)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">입체감 대비</span>
                <span class="param-val" data-val-for="contrast_balance">1.46x</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="beauty" data-key="contrast_balance" min="0.50" max="2.50" step="0.01" value="1.46" />
              <div class="param-hints"><span>0.50 (부드럽게)</span><span>2.50 (선명함)</span></div>
            </div>
          </div>

          <!-- 2. 딥페이크 모드 슬라이더 (5개 항목) -->
          <div class="solo-beauty-sliders-list hidden" id="panel-deepface-sliders">
            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">합성 혼합 비율</span>
                <span class="param-val" data-val-for="swap_blend_ratio">100%</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="deepface" data-key="swap_blend_ratio" min="0" max="1" step="0.01" value="1.00" />
              <div class="param-hints"><span>0% (내 얼굴)</span><span>100% (완전 합성)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">디테일 선명도</span>
                <span class="param-val" data-val-for="detail_sharpen">0.50</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="deepface" data-key="detail_sharpen" min="0" max="2" step="0.05" value="0.50" />
              <div class="param-hints"><span>0.00 (기본)</span><span>2.00 (눈매 선명)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">경계면 페더링</span>
                <span class="param-val" data-val-for="border_feather">15px</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="deepface" data-key="border_feather" min="1" max="30" step="1" value="15" />
              <div class="param-hints"><span>1px (샤프)</span><span>30px (자연스러움)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">피부톤/조명 일치</span>
                <span class="param-val" data-val-for="tone_matching">80%</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="deepface" data-key="tone_matching" min="0" max="1" step="0.01" value="0.80" />
              <div class="param-hints"><span>0% (사진 톤)</span><span>100% (조명 일치)</span></div>
            </div>

            <div class="solo-beauty-row">
              <div class="solo-beauty-row-label">
                <span class="param-title">얼굴 인식 민감도</span>
                <span class="param-val" data-val-for="detection_threshold">0.60</span>
              </div>
              <input type="range" class="solo-beauty-range" data-section="deepface" data-key="detection_threshold" min="0.30" max="0.85" step="0.01" value="0.60" />
              <div class="param-hints"><span>0.30 (민감 탐지)</span><span>0.85 (엄격)</span></div>
            </div>
          </div>
        </div>

        <!-- 2. 신규 송출 해상도 & 부하 최적화 박스 (동일한 20% 투명 + 10px 라운딩) -->
        <div class="solo-res-box hidden" id="solo-res-box">
          <div class="solo-res-box-header">
            <div class="solo-res-box-title">
              <span class="title-ico">📺</span>
              <span class="title-text">송출 해상도 & 부하 최적화</span>
              <span class="solo-res-current-badge" id="solo-res-current-badge">540p qHD</span>
            </div>
            <button type="button" class="solo-beauty-box-close" id="btn-res-box-close" title="닫기">✕</button>
          </div>

          <div class="solo-res-guide">
            <span class="guide-icon">💡</span>
            <div class="guide-text">
              <strong>접속자 수에 맞게 해상도를 조절하세요</strong>
              <p>접속자가 많을 때 해상도를 낮추면 호스트 업로드와 시청자 기기 부하가 크게 줄어 훨씬 더 많은 참가자를 안정적으로 수용할 수 있습니다.</p>
            </div>
          </div>

          <div class="solo-res-list">
            ${resItemsHtml}
          </div>

          <div class="solo-res-status-bar">
            <span class="status-pill" id="solo-res-status-res">해상도: 960×540</span>
            <span class="status-pill" id="solo-res-status-fps">30 fps</span>
            <span class="status-pill" id="solo-res-status-bitrate">상한: 900 kbps</span>
          </div>
        </div>
      </div>
    `;

    this.containerEl = container;
    this.lockBtnEl = container.querySelector('.solo-beauty-lock-btn');
    this.boxEl = container.querySelector('.solo-beauty-box');
    this.resBoxEl = container.querySelector('.solo-res-box');

    card.appendChild(container);
    this._bindEvents();
    this.syncSlidersFromConfig();
    this.syncResUI();
    this.updateLockIcon();

// 초기에는 스트림을 건드리지 않고 UI 상태만 유지
    this.syncResUI();
  }

  _bindEvents() {
    if (!this.containerEl) return;

    // 좌측 상단 자물쇠 버튼 클릭
    this.lockBtnEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.isAuthed()) {
        this.openAuthModal();
      } else {
        this.toggleBox();
      }
    });

    // 뷰티 박스 닫기 버튼 (✕)
    const btnBeautyClose = this.boxEl?.querySelector('#btn-beauty-box-close');
    btnBeautyClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxEl?.classList.add('hidden');
      if (this.resBoxEl?.classList.contains('hidden')) {
        this.isOpen = false;
        this.updateLockIcon();
      }
    });

    // 해상도 박스 닫기 버튼 (✕)
    const btnResClose = this.resBoxEl?.querySelector('#btn-res-box-close');
    btnResClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resBoxEl?.classList.add('hidden');
      if (this.boxEl?.classList.contains('hidden')) {
        this.isOpen = false;
        this.updateLockIcon();
      }
    });

    // 모드 탭 버튼 클릭 (원본 뷰티 vs 딥페이크)
    const tabBtns = this.boxEl?.querySelectorAll('.solo-beauty-tab-btn') || [];
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchMode(btn.dataset.mode, true);
      });
    });

    // 해상도 아이템 버튼 클릭
    const resItems = this.resBoxEl?.querySelectorAll('.solo-res-item') || [];
    resItems.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.isAuthed()) {
          this.openAuthModal();
          return;
        }
        const mode = btn.dataset.mode;
        if (mode) {
          this.applyResolutionMode(mode, true);
        }
      });
    });

    // 슬라이더 이벤트 바인딩
    const ranges = this.boxEl?.querySelectorAll('.solo-beauty-range') || [];
    ranges.forEach((range) => {
      const checkAuth = (e) => {
        if (!this.isAuthed()) {
          e.preventDefault();
          e.stopPropagation();
          this.openAuthModal();
          return false;
        }
        return true;
      };

      range.addEventListener('pointerdown', checkAuth, { capture: true });
      range.addEventListener('touchstart', checkAuth, { capture: true });
      range.addEventListener('mousedown', checkAuth, { capture: true });

      // 슬라이더 값 변경
      range.addEventListener('input', (e) => {
        if (!this.isAuthed()) {
          e.preventDefault();
          e.stopPropagation();
          alert('접근할 수 없습니다.');
          this.openAuthModal();
          return;
        }

        const section = range.dataset.section || 'beauty';
        const key = range.dataset.key;
        const val = parseFloat(range.value);
        if (isNaN(val)) return;

        if (section === 'deepface') {
          this.deepfaceConfig[key] = val;
          this._updateValueLabel('deepface', key, val);
        } else {
          this.beautyConfig[key] = val;
          this._updateValueLabel('beauty', key, val);
        }

        // 로컬 아바타 매니저에 실시간 반영
        const avMgr = this.getAvatarManager();
        if (avMgr) {
          if (section === 'deepface') {
            if (!avMgr.deepFaceConfig) avMgr.deepFaceConfig = { ...DEFAULT_DEEPFACE_CONFIG };
            avMgr.deepFaceConfig[key] = val;
          } else {
            if (!avMgr.myFaceConfig) avMgr.myFaceConfig = { ...DEFAULT_BEAUTY_CONFIG };
            avMgr.myFaceConfig[key] = val;
          }
        }

        // 저장 상태 인디케이터 표시
        const ind = this.boxEl?.querySelector('.solo-beauty-save-indicator');
        if (ind) {
          ind.textContent = '저장 중...';
          ind.style.borderColor = '#f59e0b';
          ind.style.color = '#fbbf24';
        }

        this._scheduleSave();
      });

      // 슬라이더 조작 완료 시 즉시 저장 플러시
      range.addEventListener('change', () => {
        if (this.isAuthed()) {
          this._saveNow();
        }
      });
    });
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveNow();
    }, 200);
  }

  async _saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    try {
      const res = await fetch('/api/myface-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: ADMIN_PASSWORD,
          config: {
            beauty: this.beautyConfig,
            deepface: this.deepfaceConfig,
          },
        }),
      });

      const ind = this.boxEl?.querySelector('.solo-beauty-save-indicator');
      if (!res.ok) {
        if (res.status === 403) {
          alert('접근할 수 없습니다.');
        }
        if (ind) {
          ind.textContent = '저장 실패';
          ind.style.borderColor = '#ef4444';
          ind.style.color = '#f87171';
        }
      } else {
        const data = await res.json();
        if (data.ok && data.config) {
          if (data.config.beauty) this.beautyConfig = { ...this.beautyConfig, ...data.config.beauty };
          if (data.config.deepface) this.deepfaceConfig = { ...this.deepfaceConfig, ...data.config.deepface };
        }
        if (ind) {
          ind.textContent = '저장됨';
          ind.style.borderColor = 'rgba(34, 197, 94, 0.3)';
          ind.style.color = '#4ade80';
        }
      }
    } catch (err) {
      console.warn('[HostBeautyBar] myface.ini 저장 요청 실패:', err);
    }
  }
}
