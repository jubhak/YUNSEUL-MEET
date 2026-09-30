/**
 * tarot-lounge-manager.js
 * 미팅 준비중 고품질 실사 타로카드 대기실 (Tarot Waiting Lounge)
 * 1) img/ 디렉토리 내 180종 고품질 타로카드 이미지 인용
 * 2) 접속자 간 중복 없는 타로카드 자동 배정 (Non-duplication Deck)
 * 3) 카드 본체는 가림 없이 100% 온전히 표시 + 카드 바로 아래 정확히 7px 간격 사용자 아이디 배치
 * 4) 4x2 정중앙 반응형 카드 배치 (8명 시 상단 4장 + 하단 4장)
 * 5) 5, 4, 3, 2, 1 카운트다운 및 황금빛 발광 소멸(Dissolve) 연출
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

  // 카드별 사용 횟수 추적 (공평한 중복 분배용)
  const usageCount = new Array(total).fill(0);

  participants.forEach((p) => {
    const baseIdx = hashString(p.id) % total;

    // 1순위: 아직 한 번도 쓰이지 않은 미사용 카드 탐색 (중복 절대 없음)
    let chosenIdx = -1;
    for (let step = 0; step < total; step++) {
      const idx = (baseIdx + step) % total;
      if (usageCount[idx] === 0) {
        chosenIdx = idx;
        break;
      }
    }

    // 2순위: 180장의 모든 카드가 이미 배정되어 200명 이상 초과 접속한 경우에만 중복 허용
    // 사용 횟수가 가장 적은 카드들 중에서 배정하여 특정 카드만 몰리지 않게 고르게 분배
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
  }

  show() {
    if (!this.container) return;
    this.isActive = true;
    this.container.style.display = '';
    this.container.classList.remove('hidden');
    document.body.classList.add('is-in-tarot-lounge');
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
  }

  /**
   * 접속자 목록 실시간 렌더링
   * @param {Array<{ id: string, name: string, role: string }>} participants
   */
  renderParticipants(participants = []) {
    if (!this.grid || this._isCountingDown) return;

    const list = Array.isArray(participants) ? participants : Object.values(participants || {});

    // 중복 제거 및 호스트를 맨 앞으로 정렬
    const unique = [];
    const seen = new Set();
    // 마이크 확인 대기(admitted === false) 중인 참가자는 아직 입장 전이므로 카드를 배정하지 않는다
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
    this.grid.className = 'tarot-card-grid';
    if (total <= 4) {
      this.grid.classList.add('grid-single-row');
    } else {
      this.grid.classList.add('grid-double-row');
    }

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
      el.style.animationDelay = `${idx * 0.08}s`;

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

    // 대기실 전체 섬광/폭풍 이펙트 클래스 활성화
    this.container.classList.add('is-dissolving-storm');

    // 1. 각 카드마다 하드웨어 가속 3D 전방위(360도) 랜덤 비행 및 섬광 폭발 연출
    const cardItems = this.container.querySelectorAll('.tarot-card-item');
    const totalCards = cardItems.length;

    // 카드가 배치된 순서에 상관없이 사방팔방으로 흩어지도록 셔플된 방향 인덱스 배열 생성
    const dirIndices = Array.from({ length: totalCards }, (_, i) => i);
    for (let i = dirIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirIndices[i], dirIndices[j]] = [dirIndices[j], dirIndices[i]];
    }

    cardItems.forEach((card, idx) => {
      // 360도 전 방향으로 자연스러운 흩어짐 (위, 아래, 좌, 우, 대각선 등 사방팔방)
      const dirSlot = dirIndices[idx] ?? idx;
      const angleStep = (Math.PI * 2) / Math.max(1, totalCards);
      const angle = (dirSlot * angleStep) + (Math.random() - 0.5) * (angleStep * 0.6);

      // 화면 안에서 카드가 사방으로 날아가는 모습을 충분히 감상할 수 있는 적정 비행 거리 (350px ~ 600px)
      const dist = 350 + Math.random() * 250;
      const flyX = Math.round(Math.cos(angle) * dist);
      const flyY = Math.round(Math.sin(angle) * dist);
      const flyZ = Math.round(60 + (Math.random() - 0.5) * 120);

      // 3D 회전각 (-180도 ~ +180도 부드러운 공중 텀블링)
      const rotZ = Math.round((Math.random() - 0.5) * 360);
      const rotY = Math.round((Math.random() - 0.5) * 180);
      const rotX = Math.round((Math.random() - 0.5) * 180);
      const endScale = (0.5 + Math.random() * 0.3).toFixed(2);
      const delayMs = Math.round((idx % 6) * 50 + Math.random() * 60); // 0 ~ 360ms 미세 시차
      const durationMs = Math.round(3800 + Math.random() * 300); // 3.8초 ~ 4.1초 동안 5초 카운트다운에 맞춰 여유롭게 비행

      // 기존 transition 및 float 애니메이션 간섭 완전 차단
      card.style.transition = 'none';
      card.style.animation = 'none';
      card.classList.add('is-dissolving');

      // Web Animations API: 5초 카운트다운 동안 카드가 서서히 사방으로 흩어지며 빛과 함께 사라짐
      if (typeof card.animate === 'function') {
        try {
          const anim = card.animate([
            {
              transform: 'perspective(1200px) translate3d(0px, 0px, 0px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) scale(1)',
              opacity: 1,
              filter: 'brightness(1) drop-shadow(0 4px 12px rgba(0,0,0,0.5))',
            },
            {
              offset: 0.15,
              // 0.6초: 카드가 서서히 떠오르며 황금빛을 발산
              transform: `perspective(1200px) translate3d(${Math.round(flyX * 0.15)}px, ${Math.round(flyY * 0.15)}px, 80px) rotateX(${Math.round(rotX * 0.2)}deg) rotateY(${Math.round(rotY * 0.2)}deg) rotateZ(${Math.round(rotZ * 0.2)}deg) scale(1.08)`,
              opacity: 1,
              filter: 'brightness(1.35) drop-shadow(0 0 20px rgba(250, 204, 21, 0.7))',
            },
            {
              offset: 0.55,
              // 2.2초: 360도 사방으로 부드럽게 흩어져 비행 중 (여전히 선명하게 보임)
              transform: `perspective(1200px) translate3d(${Math.round(flyX * 0.6)}px, ${Math.round(flyY * 0.6)}px, ${flyZ}px) rotateX(${Math.round(rotX * 0.6)}deg) rotateY(${Math.round(rotY * 0.6)}deg) rotateZ(${Math.round(rotZ * 0.6)}deg) scale(0.95)`,
              opacity: 0.95,
              filter: 'brightness(1.2) drop-shadow(0 0 16px rgba(250, 204, 21, 0.5))',
            },
            {
              offset: 0.82,
              // 3.3초: 카운트다운 2~1초 구간, 점차 빛과 함께 소멸 시작
              transform: `perspective(1200px) translate3d(${Math.round(flyX * 0.88)}px, ${Math.round(flyY * 0.88)}px, ${flyZ + 40}px) rotateX(${Math.round(rotX * 0.88)}deg) rotateY(${Math.round(rotY * 0.88)}deg) rotateZ(${Math.round(rotZ * 0.88)}deg) scale(0.75)`,
              opacity: 0.6,
              filter: 'brightness(1.5) drop-shadow(0 0 25px rgba(255, 255, 255, 0.8))',
            },
            {
              offset: 1,
              // 4.0초: 미팅 시작 직전 사방으로 흩어지며 완전히 소멸
              transform: `perspective(1200px) translate3d(${flyX}px, ${flyY}px, ${flyZ + 80}px) rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg) scale(${endScale})`,
              opacity: 0,
              filter: 'brightness(1.8) drop-shadow(0 0 30px rgba(250, 204, 21, 0.9))',
            }
          ], {
            duration: durationMs,
            delay: delayMs,
            easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
            fill: 'forwards',
          });

          anim.onfinish = () => {
            card.style.opacity = '0';
            card.style.visibility = 'hidden';
          };
        } catch (animErr) {
          console.warn('[tarot] card.animate error:', animErr);
          card.style.opacity = '0';
          card.style.visibility = 'hidden';
        }
      } else {
        card.style.opacity = '0';
        card.style.visibility = 'hidden';
      }
    });

    // 2. 카운트다운 오버레이 활성화
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.remove('hidden');
      this.countdownOverlay.classList.add('is-active');
    }

    let remaining = duration;
    if (this.countdownNum) {
      this.countdownNum.textContent = String(remaining);
    }

    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
    }

    this._countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        if (this.countdownNum) {
          this.countdownNum.textContent = String(remaining);
          // 리펄스 트리거
          this.countdownNum.style.animation = 'none';
          void this.countdownNum.offsetWidth;
          this.countdownNum.style.animation = '';
        }
      } else {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;

        // 대기실 전체 페이드아웃 후 닫기
        this.container.classList.add('is-fading-out');
        setTimeout(() => {
          this._isCountingDown = false;
          this.hide();
          this.container.classList.remove('is-fading-out', 'is-dissolving-storm');
          if (this.countdownOverlay) {
            this.countdownOverlay.classList.remove('is-active');
            this.countdownOverlay.classList.add('hidden');
          }
          onComplete?.();
        }, 600);
      }
    }, 1000);
  }
}
