/**
 * tarot-lounge-manager.js
 * 미팅 준비중 고품질 실사 타로카드 대기실 (Tarot Waiting Lounge)
 * 1) img/ 디렉토리 내 180종 고품질 타로카드 이미지 인용
 * 2) 접속자 간 중복 없는 타로카드 자동 배정 (Non-duplication Deck)
 * 3) 카드 본체는 가림 없이 100% 온전히 표시 + 카드 바로 아래 정확히 7px 간격 사용자 아이디 배치
 * 4) 화면 크기에 따라 한 줄에 최대한 채우고 넘치면 다음 줄로 떨어지는 완전 반응형 카드 배치 (Flex-Wrap)
 * 5) 호스트 전용 "테스트 모드": 가상 접속자 수를 위아래 조정하여 카드 배치 반응형 동작 사전 검증 지원
 * 6) 5, 4, 3, 2, 1 카운트다운 및 황금빛 발광 소멸(Dissolve) 연출
 */

import { TAROT_IMAGES } from './tarot-images.js?v=20260918img1';

/**
 * 문자열 해시 함수 (안정적인 고유 카드 선택용)
 */
function hashString(str) {
  let h = 0;
  const s = String(str || 'guest');
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

/** 가로는 채우고, 인원이 늘면 2/3/4줄(N/2, N/3, N/4). 2장은 항상 한 줄. */
function tarotGridShape(n) {
  const total = Math.max(0, Number(n) || 0);
  if (total <= 1) return { cols: 1, rows: 1 };
  if (total === 2) return { cols: 2, rows: 1 };
  if (total === 3) return { cols: 3, rows: 1 };
  if (total <= 8) {
    const rows = 2;
    return { cols: Math.ceil(total / rows), rows };
  }
  if (total <= 12) {
    const rows = 3;
    return { cols: Math.ceil(total / rows), rows };
  }
  const rows = 4;
  return { cols: Math.ceil(total / rows), rows };
}

/**
 * 방 안의 접속자들에게 타로카드 이미지 배정:
 * - 카드 수(180장) 이내의 인원은 100% 중복 없이 서로 다른 고유 카드 배정
 * - 카드 수를 초과하여 180~200명 이상의 대규모 접속자가 있을 경우에만 최소 사용 빈도 카드로 중복 허용
 * @param {Array<{ id: string, name: string, role: string }>} participants
 * @returns {Map<string, string>} userId -> imageFileName
 */
function assignUniqueCards(participants) {
  const cardMap = new Map();
  const total = TAROT_IMAGES.length;

  if (!total) return cardMap;

  const usageCount = new Array(total).fill(0);

  participants.forEach((p) => {
    const baseIdx = hashString(p.id) % total;

    let chosenIdx = -1;
    for (let step = 0; step < total; step++) {
      const idx = (baseIdx + step) % total;
      if (usageCount[idx] === 0) {
        chosenIdx = idx;
        break;
      }
    }

    if (chosenIdx === -1) {
      let minUsage = Infinity;
      for (let step = 0; step < total; step++) {
        const idx = (baseIdx + step) % total;
        if (usageCount[idx] < minUsage) {
          minUsage = usageCount[idx];
          chosenIdx = idx;
        }
      }
    }

    usageCount[chosenIdx]++;
    cardMap.set(p.id, TAROT_IMAGES[chosenIdx]);
  });

  return cardMap;
}

// 테스트 모드용 다채로운 랜덤 닉네임 풀
const SIMULATED_NICKNAMES = [
  '별빛소녀', '코딩마스터', '루나_Alice', '스카이_Sky', '해피바이러스',
  '블루베리', '화이트스노우', '초코쿠키', '사이버펑크', '골든라이트',
  '새벽공기', '윈드체이서', '미스티블루', '체리블라썸', '네오매트릭스',
  '스타더스트', '레인보우', '블랙스완', '달빛천사', '오로라_Aurora',
  '슈퍼샤이니', '선샤인_Sun', '파도소리', '은하수_Milky', '민트초코',
  '로맨틱홀리', '크리스탈', '에메랄드', '사파이어', '루비레드',
  '모닝커피', '벨벳스카이', '원더랜드', '스마일러', '아쿠아마린',
  '선셋글로우', '라이트닝', '섀도우댄서', '피스메이커', '코스모스'
];

export class TarotLoungeManager {
  constructor({ containerId = 'tarot-waiting-lounge', isHost = false } = {}) {
    this.container = document.getElementById(containerId);
    this.grid = document.getElementById('tarot-card-grid');
    this.countdownOverlay = document.getElementById('tarot-countdown-overlay');
    this.countdownNum = document.getElementById('tarot-countdown-num');
    this.isHost = isHost;
    this.isActive = false;
    this._isCountingDown = false;
    this._countdownTimer = null;

    // 테스트 모드 상태
    this.isTestMode = false;
    this.testCount = 8;
    this._lastRealParticipants = [];
    this.testContainer = null;

    if (this.isHost) {
      this._ensureTestModeUI();
    }
  }

  show() {
    if (!this.container) return;
    this.isActive = true;
    this.container.style.display = '';
    this.container.classList.remove('hidden');
    document.body.classList.add('is-in-tarot-lounge');

    if (this.isHost) {
      this._ensureTestModeUI();
      if (this.testContainer) {
        this.testContainer.style.display = '';
        this.testContainer.classList.remove('hidden');
      }
    }
  }

  hide() {
    if (!this.container) return;
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    this._isCountingDown = false;
    this.isActive = false;
    this.container.style.display = 'none';
    this.container.classList.add('hidden');
    this.container.classList.remove('is-fading-out', 'is-dissolving-storm');
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.remove('is-active');
      this.countdownOverlay.classList.add('hidden');
    }
    document.body.classList.remove('is-in-tarot-lounge');
    this.disableTestMode(false);
  }

  /**
   * PC 화면 공유 모드 전용: 최초 미팅 대기 상태와 같은 "참석자 카드 배치"만 유지해서 보여준다.
   * - 카운트다운/테스트 패널/호스트 시작 버튼 없이 카드 그리드만 노출한다.
   * - 영상 타일(참가자 카메라 박스)이 꺼져 검게 비는 대신, 익숙한 카드 배치가 자리를 지킨다.
   */
  showShareStage(participants = []) {
    if (!this.container) return;
    if (this._isCountingDown) return;
    this.isActive = true;
    this.container.style.display = '';
    this.container.classList.remove('hidden', 'is-fading-out', 'is-dissolving-storm');
    this.container.classList.add('is-share-stage');
    document.body.classList.add('is-in-tarot-lounge');
    document.body.classList.add('is-share-stage');
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.remove('is-active');
      this.countdownOverlay.classList.add('hidden');
    }
    if (this.isHost && this.testContainer) this.testContainer.style.display = 'none';
    this.renderParticipants(Array.isArray(participants) ? participants : []);
  }

  /** 화면 공유 모드 카드 배치 해제 — 영상 미팅(얼굴 화면)으로 복귀할 때 호출 */
  hideShareStage() {
    if (!this.container) return;
    this.container.classList.remove('is-share-stage');
    document.body.classList.remove('is-share-stage');
    if (!this._isCountingDown) {
      this.isActive = false;
      this.container.style.display = 'none';
      this.container.classList.add('hidden');
      document.body.classList.remove('is-in-tarot-lounge');
    }
  }

  /** 화면 공유 모드 카드 배치가 현재 표시 중인지 */
  get isShareStage() {
    return !!(this.container && this.container.classList.contains('is-share-stage'));
  }

  /**
   * 호스트 전용: 카드 배치 테스트 모드 UI 생성 및 바인딩
   */
  _ensureTestModeUI() {
    if (this.testContainer || !this.container) return;

    const el = document.createElement('div');
    el.className = 'tarot-test-mode-container';
    el.id = 'tarot-test-mode-container';
    el.innerHTML = `
      <button type="button" class="tarot-test-toggle-btn" id="btn-tarot-test-toggle" title="카드 배치 테스트 모드 열기/닫기">
        <span class="test-icon">🧪</span>
        <span class="test-btn-text">테스트 모드</span>
      </button>

      <div class="tarot-test-panel hidden" id="tarot-test-panel">
        <div class="tarot-test-panel-header">
          <div class="tarot-test-panel-title">
            <span class="test-icon">🧪</span>
            <span>가상 접속자 카드 배치 테스트</span>
          </div>
          <button type="button" class="tarot-test-close-btn" id="btn-tarot-test-close" title="테스트 모드 종료">✕</button>
        </div>

        <div class="tarot-test-body">
          <div class="tarot-test-stepper">
            <span class="tarot-test-label">가상 접속자 수:</span>
            <button type="button" class="tarot-test-step-btn" id="btn-tarot-test-minus" title="1명 감소">▼</button>
            <input type="number" class="tarot-test-count-input" id="input-tarot-test-count" min="1" max="60" value="${this.testCount}" />
            <span class="tarot-test-unit">명</span>
            <button type="button" class="tarot-test-step-btn" id="btn-tarot-test-plus" title="1명 증가">▲</button>
          </div>

          <input type="range" class="tarot-test-slider" id="slider-tarot-test-count" min="1" max="60" value="${this.testCount}" />

          <div class="tarot-test-presets">
            <button type="button" class="tarot-test-preset-btn" data-count="1">1명(솔로)</button>
            <button type="button" class="tarot-test-preset-btn" data-count="4">4명</button>
            <button type="button" class="tarot-test-preset-btn" data-count="8">8명</button>
            <button type="button" class="tarot-test-preset-btn" data-count="12">12명</button>
            <button type="button" class="tarot-test-preset-btn" data-count="20">20명</button>
            <button type="button" class="tarot-test-preset-btn" data-count="35">35명</button>
          </div>

          <div class="tarot-test-hint">
            💡 접속자 숫자를 위아래로 조절하면 한 줄에 카드가 최대로 배치되고 넘치는 줄로 떨어지는 <strong>반응형 배치</strong>를 미리 보실 수 있습니다.
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(el);
    this.testContainer = el;
    this._bindTestEvents();
  }

  _bindTestEvents() {
    if (!this.testContainer) return;

    const btnToggle = this.testContainer.querySelector('#btn-tarot-test-toggle');
    const panel = this.testContainer.querySelector('#tarot-test-panel');
    const btnClose = this.testContainer.querySelector('#btn-tarot-test-close');
    const btnMinus = this.testContainer.querySelector('#btn-tarot-test-minus');
    const btnPlus = this.testContainer.querySelector('#btn-tarot-test-plus');
    const inputCount = this.testContainer.querySelector('#input-tarot-test-count');
    const sliderCount = this.testContainer.querySelector('#slider-tarot-test-count');
    const presetBtns = this.testContainer.querySelectorAll('.tarot-test-preset-btn');

    btnToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isTestMode) {
        this.disableTestMode();
      } else {
        this.enableTestMode();
      }
    });

    btnClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.disableTestMode();
    });

    btnMinus?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setTestCount(this.testCount - 1);
    });

    btnPlus?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setTestCount(this.testCount + 1);
    });

    inputCount?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) this.setTestCount(val);
    });

    sliderCount?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) this.setTestCount(val);
    });

    presetBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cnt = parseInt(btn.dataset.count, 10);
        if (!isNaN(cnt)) this.setTestCount(cnt);
      });
    });

    // 레이어 팝업 헤더 드래그 이동 기능 (뒤의 카드 배치를 가리지 않도록 자유롭게 이동 가능)
    const header = this.testContainer.querySelector('.tarot-test-panel-header');
    if (header && panel) {
      let isDragging = false;
      let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('#btn-tarot-test-close')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        header.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.position = 'fixed';
        panel.style.left = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + dx)) + 'px';
        panel.style.top = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + dy)) + 'px';
        panel.style.margin = '0';
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          header.style.cursor = 'grab';
          document.body.style.userSelect = '';
        }
      });
    }
  }

  enableTestMode() {
    this.isTestMode = true;
    const panel = this.testContainer?.querySelector('#tarot-test-panel');
    const btnToggle = this.testContainer?.querySelector('#btn-tarot-test-toggle');
    panel?.classList.remove('hidden');
    btnToggle?.classList.add('is-active');
    this._renderSimulated();
  }

  disableTestMode(reRender = true) {
    this.isTestMode = false;
    const panel = this.testContainer?.querySelector('#tarot-test-panel');
    const btnToggle = this.testContainer?.querySelector('#btn-tarot-test-toggle');
    panel?.classList.add('hidden');
    btnToggle?.classList.remove('is-active');
    if (reRender) {
      this._doRenderParticipants(this._lastRealParticipants);
    }
  }

  setTestCount(count) {
    this.testCount = Math.max(1, Math.min(60, Number(count) || 1));
    const inputCount = this.testContainer?.querySelector('#input-tarot-test-count');
    const sliderCount = this.testContainer?.querySelector('#slider-tarot-test-count');
    if (inputCount) inputCount.value = this.testCount;
    if (sliderCount) sliderCount.value = this.testCount;
    if (this.isTestMode) {
      this._renderSimulated();
    }
  }

  /**
   * 가상 접속자 목록을 랜덤 닉네임으로 생성하여 렌더링
   */
  _renderSimulated() {
    const n = this.testCount;
    const simulated = [];

    // 1번: 항상 호스트 (방장)
    simulated.push({
      id: 'local',
      clientId: 'local',
      name: '호스트',
      role: 'host',
    });

    // 2 ~ N번: 가상 시청자 (랜덤 닉네임 배정)
    for (let i = 1; i < n; i++) {
      const nickBase = SIMULATED_NICKNAMES[(i * 7 + 11) % SIMULATED_NICKNAMES.length];
      const randomNum = String((i * 37) % 99 + 1).padStart(2, '0');
      const randomName = `${nickBase}_${randomNum}`;
      simulated.push({
        id: `sim-user-${i}`,
        clientId: `sim-user-${i}`,
        name: randomName,
        role: 'viewer',
      });
    }

    this._doRenderParticipants(simulated);
  }

  /**
   * 접속자 목록 실시간 렌더링
   * @param {Array<{ id: string, name: string, role: string }>} participants
   */
  renderParticipants(participants = []) {
    this._lastRealParticipants = Array.isArray(participants) ? participants : Object.values(participants || {});
    if (this.isTestMode) {
      this._renderSimulated();
      return;
    }
    this._doRenderParticipants(this._lastRealParticipants);
  }

  _doRenderParticipants(participants = []) {
    if (!this.grid || this._isCountingDown) return;

    const list = Array.isArray(participants) ? participants : Object.values(participants || {});

    // 중복 제거 및 호스트를 맨 앞으로 정렬
    const unique = [];
    const seen = new Set();
    const hosts = list.filter((p) => p && p.role === 'host');
    const viewers = list.filter((p) => p && p.role !== 'host' && p.admitted !== false);
    [...hosts, ...viewers].forEach((p) => {
      const pid = p.id || p.clientId;
      if (pid && !seen.has(pid)) {
        seen.add(pid);
        unique.push({ ...p, id: pid });
      }
    });

    const total = unique.length;
    const { cols, rows } = tarotGridShape(total);
    this.grid.className = 'tarot-card-grid';
    this.grid.style.setProperty('--tarot-cols', String(cols));
    this.grid.dataset.cols = String(cols);
    this.grid.dataset.rows = String(rows);
    if (rows <= 1) this.grid.classList.add('grid-single-row');
    else this.grid.classList.add('grid-double-row');

    this.grid.innerHTML = '';

    // 현재 접속자들에게 중복 없는 타로카드 배정
    const cardMap = assignUniqueCards(unique);

    unique.forEach((p, idx) => {
      const imageFile = cardMap.get(p.id) || TAROT_IMAGES[0];
      const isUserHost = p.role === 'host';
      const displayName = (p.name || (isUserHost ? '호스트' : '참가자')).trim();
      const safeName = escapeHtml(displayName);
      const cardUrl = `img/${encodeURIComponent(imageFile)}`;

      const el = document.createElement('div');
      el.className = `tarot-card-item${isUserHost ? ' is-host-card' : ''}`;
      el.style.animationDelay = `${idx * 0.05}s`;

      el.innerHTML = `
        <!-- 고화질 타로카드 이미지 본체 (그림 가림 없이 100% 노출) -->
        <div class="tarot-card">
          <img src="${cardUrl}" class="tarot-card-img" alt="Tarot Card" draggable="false" loading="eager" />
        </div>

        <!-- 카드 바로 아래 정확히 7px 간격의 사용자 아이디 배지 -->
        <div class="tarot-card-user-badge" title="${safeName}">
          ${isUserHost ? '<span class="tarot-user-crown">👑</span>' : ''}${safeName}
        </div>
      `;

      this.grid.appendChild(el);
    });
  }

  /**
   * 5, 4, 3, 2, 1 카운트다운 및 타로카드 황금빛 발광 소멸(Dissolve) 연출
   * @param {Object} options
   * @param {number} options.duration
   * @param {() => void} options.onComplete
   */
  startCountdown({ duration = 5, onComplete } = {}) {
    if (!this.container) {
      onComplete?.();
      return;
    }
    if (this._isCountingDown) {
      return;
    }
    this._isCountingDown = true;
    this.disableTestMode(false);

    this.container.classList.add('is-dissolving-storm');

    const cardItems = this.container.querySelectorAll('.tarot-card-item');
    const totalCards = cardItems.length;

    const dirIndices = Array.from({ length: totalCards }, (_, i) => i);
    for (let i = dirIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirIndices[i], dirIndices[j]] = [dirIndices[j], dirIndices[i]];
    }

    cardItems.forEach((card, idx) => {
      const dirSlot = dirIndices[idx] ?? idx;
      const angleStep = (Math.PI * 2) / Math.max(1, totalCards);
      const angle = (dirSlot * angleStep) + (Math.random() - 0.5) * (angleStep * 0.6);

      const dist = 350 + Math.random() * 250;
      const flyX = Math.round(Math.cos(angle) * dist);
      const flyY = Math.round(Math.sin(angle) * dist);
      const flyZ = Math.round(60 + (Math.random() - 0.5) * 120);

      const rotZ = Math.round((Math.random() - 0.5) * 360);
      const rotY = Math.round((Math.random() - 0.5) * 180);
      const rotX = Math.round((Math.random() - 0.5) * 180);
      const endScale = (0.5 + Math.random() * 0.3).toFixed(2);

      card.style.setProperty('--fly-x', `${flyX}px`);
      card.style.setProperty('--fly-y', `${flyY}px`);
      card.style.setProperty('--fly-z', `${flyZ}px`);
      card.style.setProperty('--rot-x', `${rotX}deg`);
      card.style.setProperty('--rot-y', `${rotY}deg`);
      card.style.setProperty('--rot-z', `${rotZ}deg`);
      card.style.setProperty('--end-scale', endScale);
      card.classList.add('is-dissolving-card');
    });

    if (this.countdownOverlay && this.countdownNum) {
      this.countdownOverlay.classList.remove('hidden');
      this.countdownOverlay.classList.add('is-active');
      let remain = Number(duration) || 5;
      this.countdownNum.textContent = String(remain);

      this._countdownTimer = setInterval(() => {
        remain--;
        if (remain > 0) {
          this.countdownNum.textContent = String(remain);
          this.countdownNum.classList.remove('pulse-tick');
          void this.countdownNum.offsetWidth;
          this.countdownNum.classList.add('pulse-tick');
        } else {
          clearInterval(this._countdownTimer);
          this._countdownTimer = null;
          this.container.classList.add('is-fading-out');
          setTimeout(() => {
            this.hide();
            onComplete?.();
          }, 800);
        }
      }, 1000);
    } else {
      setTimeout(() => {
        this.hide();
        onComplete?.();
      }, (Number(duration) || 5) * 1000);
    }
  }
}
