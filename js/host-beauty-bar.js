/**
 * YUNSEUL MEET — 호스트 솔로 뷰티 필터 바 & 관리자 인증 매니저
 * 호스트 혼자 접속 시 영상 화면 위로 5개 항목 막대기바(스킨 스무딩, 엣지 보존, 블러 반경, 피부 톤업, 입체감 대비)를 표시하고,
 * 조정 시 관리자 비밀번호(13240305) 인증 후 세션 종료 시까지 myface.ini에 실시간 저장 및 송출에 반영합니다.
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
    this.barEl = null;
    this.isCollapsed = false;
    this._saveTimer = null;
    this._pendingSlider = null;

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
    this.updateAuthBadge();
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

  openAuthModal(sourceSlider = null) {
    this._pendingSlider = sourceSlider;
    if (!this.modal) {
      const pw = prompt('관리자 비밀번호를 입력해 주세요 (초기 비밀번호: 13240305)');
      if (pw === ADMIN_PASSWORD) {
        this.setAuthed(true);
        showToast('관리자 인증이 완료되었습니다. 이제 자유롭게 수치를 조정할 수 있습니다.', 'info', 3000);
      } else {
        alert('수치를 조정할 수 없습니다');
        this.syncSlidersFromConfig();
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
    this._pendingSlider = null;
  }

  _handleAuthSubmit() {
    const val = (this.passwordInput?.value || '').trim();
    if (val === ADMIN_PASSWORD) {
      this.setAuthed(true);
      this.closeAuthModal();
      showToast('관리자 인증이 완료되었습니다. 세션 종료 시까지 수치를 조정할 수 있습니다.', 'info', 3000);
      this.updateAuthBadge();
    } else {
      if (this.errorMsgEl) {
        this.errorMsgEl.textContent = '수치를 조정할 수 없습니다';
        this.errorMsgEl.classList.remove('hidden');
      }
      alert('수치를 조정할 수 없습니다');
      this.syncSlidersFromConfig();
      if (this.passwordInput) {
        this.passwordInput.value = '';
        this.passwordInput.focus();
      }
    }
  }

  _handleAuthCancel() {
    this.closeAuthModal();
    alert('수치를 조정할 수 없습니다');
    this.syncSlidersFromConfig();
  }

  updateAuthBadge() {
    if (!this.barEl) return;
    const badge = this.barEl.querySelector('.solo-beauty-auth-badge');
    if (!badge) return;
    const authed = this.isAuthed();
    badge.className = `solo-beauty-auth-badge ${authed ? 'is-authed' : ''}`;
    badge.textContent = authed ? '🔓 수정 가능 (관리자 인증됨)' : '🔒 관리자 인증 필요';
    badge.title = authed ? '현재 세션 동안 자유롭게 수치를 조정할 수 있습니다.' : '수치를 조정하려면 클릭하여 관리자 비밀번호를 입력하세요.';
  }

  syncSlidersFromConfig() {
    if (!this.barEl) return;
    const ranges = this.barEl.querySelectorAll('.solo-beauty-range');
    ranges.forEach((range) => {
      const key = range.dataset.key;
      if (key && this.config[key] !== undefined) {
        range.value = this.config[key];
        this._updateValueLabel(key, this.config[key]);
      }
    });
  }

  _updateValueLabel(key, val) {
    if (!this.barEl) return;
    const valEl = this.barEl.querySelector(`.solo-beauty-param-val[data-val-for="${key}"]`);
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
    if (card.querySelector('.solo-beauty-bar')) {
      this.barEl = card.querySelector('.solo-beauty-bar');
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'solo-beauty-bar';
    bar.innerHTML = `
      <div class="solo-beauty-header">
        <div class="solo-beauty-title">
          <span class="solo-beauty-icon">✨</span>
          <span>뷰티 필터 설정 (myface.ini)</span>
          <span class="solo-beauty-auth-badge" title="클릭하여 관리자 인증">🔒 관리자 인증 필요</span>
        </div>
        <div class="solo-beauty-header-actions">
          <button type="button" class="solo-beauty-btn-toggle" title="패널 접기/펼치기">▼ 접기</button>
        </div>
      </div>
      <div class="solo-beauty-body">
        <div class="solo-beauty-slider-col">
          <div class="solo-beauty-slider-header">
            <span class="solo-beauty-param-name">스킨 스무딩</span>
            <span class="solo-beauty-param-val" data-val-for="smooth_intensity">0.63</span>
          </div>
          <input type="range" class="solo-beauty-range" data-key="smooth_intensity" min="0" max="1" step="0.01" value="0.63" />
          <div class="solo-beauty-range-hints"><span>0.00(끔)</span><span>1.00(최대)</span></div>
        </div>

        <div class="solo-beauty-slider-col">
          <div class="solo-beauty-slider-header">
            <span class="solo-beauty-param-name">엣지 보존</span>
            <span class="solo-beauty-param-val" data-val-for="edge_threshold">17.0</span>
          </div>
          <input type="range" class="solo-beauty-range" data-key="edge_threshold" min="1" max="100" step="0.5" value="17.0" />
          <div class="solo-beauty-range-hints"><span>1.0(선명)</span><span>100.0(뭉갬)</span></div>
        </div>

        <div class="solo-beauty-slider-col">
          <div class="solo-beauty-slider-header">
            <span class="solo-beauty-param-name">블러 반경</span>
            <span class="solo-beauty-param-val" data-val-for="blur_radius">20px</span>
          </div>
          <input type="range" class="solo-beauty-range" data-key="blur_radius" min="1" max="30" step="1" value="20" />
          <div class="solo-beauty-range-hints"><span>1px(미세)</span><span>30px(소프트)</span></div>
        </div>

        <div class="solo-beauty-slider-col">
          <div class="solo-beauty-slider-header">
            <span class="solo-beauty-param-name">피부 톤업</span>
            <span class="solo-beauty-param-val" data-val-for="brightness_lift">1.70x</span>
          </div>
          <input type="range" class="solo-beauty-range" data-key="brightness_lift" min="0.50" max="2.50" step="0.01" value="1.70" />
          <div class="solo-beauty-range-hints"><span>0.50(어둡게)</span><span>2.50(화사함)</span></div>
        </div>

        <div class="solo-beauty-slider-col">
          <div class="solo-beauty-slider-header">
            <span class="solo-beauty-param-name">입체감 대비</span>
            <span class="solo-beauty-param-val" data-val-for="contrast_balance">1.30x</span>
          </div>
          <input type="range" class="solo-beauty-range" data-key="contrast_balance" min="0.50" max="2.50" step="0.01" value="1.30" />
          <div class="solo-beauty-range-hints"><span>0.50(부드럽게)</span><span>2.50(선명함)</span></div>
        </div>
      </div>
    `;

    this.barEl = bar;
    card.appendChild(bar);
    this._bindEvents();
    this.syncSlidersFromConfig();
    this.updateAuthBadge();
  }

  _bindEvents() {
    if (!this.barEl) return;

    // 접기/펼치기 버튼
    const btnToggle = this.barEl.querySelector('.solo-beauty-btn-toggle');
    btnToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isCollapsed = !this.isCollapsed;
      this.barEl.classList.toggle('is-collapsed', this.isCollapsed);
      btnToggle.textContent = this.isCollapsed ? '▲ 펼치기' : '▼ 접기';
    });

    // 인증 뱃지 클릭
    const badge = this.barEl.querySelector('.solo-beauty-auth-badge');
    badge?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.isAuthed()) {
        this.openAuthModal();
      }
    });

    // 각 슬라이더 입력 및 인증 검사
    const ranges = this.barEl.querySelectorAll('.solo-beauty-range');
    ranges.forEach((range) => {
      // 마우스/터치 시작 시 인증 상태 확인
      const checkAuth = (e) => {
        if (!this.isAuthed()) {
          e.preventDefault();
          e.stopPropagation();
          this.openAuthModal(range);
          return false;
        }
        return true;
      };

      range.addEventListener('pointerdown', checkAuth, { capture: true });
      range.addEventListener('touchstart', checkAuth, { capture: true });
      range.addEventListener('mousedown', checkAuth, { capture: true });

      // 슬라이더 값 변경 (실시간 비디오 프리뷰 반영)
      range.addEventListener('input', (e) => {
        if (!this.isAuthed()) {
          e.preventDefault();
          e.stopPropagation();
          const key = range.dataset.key;
          range.value = this.config[key] !== undefined ? this.config[key] : range.defaultValue;
          alert('수치를 조정할 수 없습니다');
          this.openAuthModal(range);
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

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('[HostBeautyBar] 저장 실패:', data);
        if (res.status === 403) {
          alert('수치를 조정할 수 없습니다');
        }
      } else {
        const data = await res.json();
        if (data.ok && data.config) {
          this.config = { ...this.config, ...data.config };
        }
      }
    } catch (err) {
      console.warn('[HostBeautyBar] 서버 저장 요청 실패:', err);
    }
  }
}
