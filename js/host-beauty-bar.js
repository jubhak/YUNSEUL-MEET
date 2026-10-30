/**
 * YUNSEUL MEET — 호스트 솔로 뷰티 필터 바 & 관리자 인증 매니저
 * 동영상 화면 좌측 상단 자물쇠 아이콘 클릭 -> 관리자 비밀번호(13240305) 인증
 * 일치 시 배경 20% 투명 + 모서리 라운딩 10px 박스에 5개 조정 바 표시
 */
import { showToast } from './ui-toast.js?v=20260930a';

const ADMIN_PASSWORD = '13240305';
const AUTH_STORAGE_KEY = 'myface_admin_authed';

export const DEFAULT_MYFACE_CONFIG = {
  smooth_intensity: 0.63,
  edge_threshold: 17.0,
  blur_radius: 20,
  brightness_lift: 1.70,
  contrast_balance: 1.30,
};

export class HostBeautyBarManager {
  constructor({ getAvatarManager, getSocket } = {}) {
    this.getAvatarManager = getAvatarManager || (() => null);
    this.getSocket = getSocket || (() => null);
    this.config = { ...DEFAULT_MYFACE_CONFIG };
    this.containerEl = null;
    this.lockBtnEl = null;
    this.boxEl = null;
    this.isOpen = false;
    this._saveTimer = null;

    this._initModal();
    this._loadInitialConfig();
    this._initSocket();
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
          this.config = { ...this.config, ...data.config };
          this.syncSlidersFromConfig();
          const avMgr = this.getAvatarManager();
          if (avMgr) avMgr.updateMyFaceConfig?.(this.config);
        }
      }
    } catch (err) {
      console.warn('[HostBeautyBar] 초기 설정 로드 실패 (기본값 사용):', err);
    }
  }

  _initSocket() {
    const bindSocket = () => {
      const socket = this.getSocket();
      if (!socket || this._socketBound) return;
      this._socketBound = true;
      socket.on('myface-config-updated', ({ config }) => {
        if (!config || typeof config !== 'object') return;
        this.config = { ...this.config, ...config };
        this.syncSlidersFromConfig();
        const avMgr = this.getAvatarManager();
        if (avMgr) avMgr.updateMyFaceConfig?.(config);
      });
    };
    bindSocket();
    setTimeout(bindSocket, 1000);
    setTimeout(bindSocket, 3000);
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
    this.lockBtnEl.title = authed ? '뷰티 필터 설정 열기/닫기' : '뷰티 필터 설정 (관리자 인증 필요)';
  }

  openBox() {
    this.isOpen = true;
    if (this.boxEl) {
      this.boxEl.classList.remove('hidden');
      this.syncSlidersFromConfig();
    }
    this.updateLockIcon();
  }

  closeBox() {
    this.isOpen = false;
    if (this.boxEl) {
      this.boxEl.classList.add('hidden');
    }
    this.updateLockIcon();
  }

  toggleBox() {
    if (this.isOpen) {
      this.closeBox();
    } else {
      this.openBox();
    }
  }

  syncSlidersFromConfig() {
    if (!this.boxEl) return;
    const ranges = this.boxEl.querySelectorAll('.solo-beauty-range');
    ranges.forEach((range) => {
      const key = range.dataset.key;
      if (key && this.config[key] !== undefined) {
        range.value = this.config[key];
        this._updateValueLabel(key, this.config[key]);
      }
    });
  }

  _updateValueLabel(key, val) {
    if (!this.boxEl) return;
    const valEl = this.boxEl.querySelector(`.param-val[data-val-for="${key}"]`);
    if (!valEl) return;
    const num = parseFloat(val);
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

  attachToCard(card) {
    if (!card) return;
    if (card.querySelector('.solo-beauty-container')) {
      this.containerEl = card.querySelector('.solo-beauty-container');
      this.lockBtnEl = this.containerEl.querySelector('.solo-beauty-lock-btn');
      this.boxEl = this.containerEl.querySelector('.solo-beauty-box');
      return;
    }

    const container = document.createElement('div');
    container.className = 'solo-beauty-container';
    container.innerHTML = `
      <div class="solo-beauty-lock-wrapper">
        <button type="button" class="solo-beauty-lock-btn" id="btn-beauty-lock" title="뷰티 필터 설정">
          <span class="lock-icon">🔒</span>
        </button>
      </div>

      <div class="solo-beauty-box hidden" id="solo-beauty-box">
        <div class="solo-beauty-box-header">
          <div class="solo-beauty-box-title">
            <span class="box-header-icon">✨</span>
            <span>뷰티 필터 설정</span>
            <span class="solo-beauty-save-indicator" id="solo-beauty-save-indicator">저장됨</span>
          </div>
          <button type="button" class="solo-beauty-box-close" id="btn-beauty-box-close" title="닫기">✕</button>
        </div>

        <div class="solo-beauty-sliders-list">
          <div class="solo-beauty-row">
            <div class="solo-beauty-row-label">
              <span class="param-title">스킨 스무딩</span>
              <span class="param-val" data-val-for="smooth_intensity">0.63</span>
            </div>
            <input type="range" class="solo-beauty-range" data-key="smooth_intensity" min="0" max="1" step="0.01" value="0.63" />
            <div class="param-hints"><span>0.00 (끔)</span><span>1.00 (최대)</span></div>
          </div>

          <div class="solo-beauty-row">
            <div class="solo-beauty-row-label">
              <span class="param-title">엣지 보존</span>
              <span class="param-val" data-val-for="edge_threshold">17.0</span>
            </div>
            <input type="range" class="solo-beauty-range" data-key="edge_threshold" min="1" max="100" step="0.5" value="17.0" />
            <div class="param-hints"><span>1.0 (선명)</span><span>100.0 (뭉갬)</span></div>
          </div>

          <div class="solo-beauty-row">
            <div class="solo-beauty-row-label">
              <span class="param-title">블러 반경</span>
              <span class="param-val" data-val-for="blur_radius">20px</span>
            </div>
            <input type="range" class="solo-beauty-range" data-key="blur_radius" min="1" max="30" step="1" value="20" />
            <div class="param-hints"><span>1px (미세)</span><span>30px (소프트)</span></div>
          </div>

          <div class="solo-beauty-row">
            <div class="solo-beauty-row-label">
              <span class="param-title">피부 톤업</span>
              <span class="param-val" data-val-for="brightness_lift">1.70x</span>
            </div>
            <input type="range" class="solo-beauty-range" data-key="brightness_lift" min="0.50" max="2.50" step="0.01" value="1.70" />
            <div class="param-hints"><span>0.50 (어둡게)</span><span>2.50 (화사함)</span></div>
          </div>

          <div class="solo-beauty-row">
            <div class="solo-beauty-row-label">
              <span class="param-title">입체감 대비</span>
              <span class="param-val" data-val-for="contrast_balance">1.30x</span>
            </div>
            <input type="range" class="solo-beauty-range" data-key="contrast_balance" min="0.50" max="2.50" step="0.01" value="1.30" />
            <div class="param-hints"><span>0.50 (부드럽게)</span><span>2.50 (선명함)</span></div>
          </div>
        </div>
      </div>
    `;

    this.containerEl = container;
    this.lockBtnEl = container.querySelector('.solo-beauty-lock-btn');
    this.boxEl = container.querySelector('.solo-beauty-box');

    card.appendChild(container);
    this._bindEvents();
    this.syncSlidersFromConfig();
    this.updateLockIcon();
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

    // 박스 닫기 버튼 (✕)
    const btnClose = this.boxEl?.querySelector('.solo-beauty-box-close');
    btnClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeBox();
    });

    // 5개 슬라이더 이벤트 바인딩
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

      // 슬라이더 값 변경 (실시간 GPU 비디오 프리뷰)
      range.addEventListener('input', (e) => {
        if (!this.isAuthed()) {
          e.preventDefault();
          e.stopPropagation();
          const key = range.dataset.key;
          range.value = this.config[key] !== undefined ? this.config[key] : range.defaultValue;
          alert('접근할 수 없습니다.');
          this.openAuthModal();
          return;
        }

        const key = range.dataset.key;
        const val = parseFloat(range.value);
        if (isNaN(val)) return;

        this.config[key] = val;
        this._updateValueLabel(key, val);

        // 로컬 웹캠 실시간 GPU 뷰티 필터에 즉시 반영
        const avMgr = this.getAvatarManager();
        if (avMgr) {
          if (!avMgr.myFaceConfig) avMgr.myFaceConfig = { ...DEFAULT_MYFACE_CONFIG };
          avMgr.myFaceConfig[key] = val;
        }

        // 저장 상태 인디케이터 표시
        const ind = this.boxEl?.querySelector('.solo-beauty-save-indicator');
        if (ind) {
          ind.textContent = '저장 중...';
          ind.style.borderColor = '#f59e0b';
          ind.style.color = '#fbbf24';
        }

        // 서버 myface.ini 저장 디바운스
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
          config: this.config,
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
          this.config = { ...this.config, ...data.config };
        }
        if (ind) {
          ind.textContent = '저장됨';
          ind.style.borderColor = 'rgba(34, 197, 94, 0.3)';
          ind.style.color = '#4ade80';
        }
      }
    } catch (err) {
      console.warn('[HostBeautyBar] 서버 저장 요청 실패:', err);
    }
  }
}
