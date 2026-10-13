/**
 * floating-speaker-manager.js
 * 
 * 호스트 PC 화면 공유 모드('screen')일 때 화면 위에 떠 있는
 * DRAG 가능한 발언자 얼굴 오버랩 창 (Floating Speaker PIP).
 * 
 * - 마우스 및 모바일 터치 드래그 지원 (화면 밖 이탈 방지 클램핑)
 * - 최소화(캡슐화) 및 닫기/다시 열기 칩(Chip) 지원
 * - 비디오 스트림 자동 재생 및 카메라 OFF 시 아바타+음성 파형 폴백
 * - 발언 시 테두리 골드/에메랄드 펄스 글로우 효과
 */

export class FloatingSpeakerManager {
  constructor({
    isHost = false,
    hostClientId = null,
    onResetToHost = null,
  } = {}) {
    this.isHost = !!isHost;
    this.hostClientId = hostClientId;
    this.onResetToHost = onResetToHost;

    this.root = null;
    this.videoEl = null;
    this.fallbackEl = null;
    this.titleEl = null;
    this.avatarCircleEl = null;
    this.avatarNameEl = null;
    this.chipEl = null;

    this.currentSpeakerId = null;
    this.currentSpeakerName = '호스트';
    this.currentSpeakerRole = 'host';
    this.currentStream = null;

    this.isMinimized = false;
    this.isClosedByUser = false;
    this.isSharingActive = false;

    this._isDragging = false;
    this._dragStart = { x: 0, y: 0 };
    this._startPos = { x: 0, y: 0 };

    this.ensureDom();
    this.setupDrag();
  }

  ensureDom() {
    if (typeof document === 'undefined') return;
    let root = document.getElementById('floating-speaker-pip');
    let chip = document.getElementById('floating-speaker-chip');

    if (!root) {
      root = document.createElement('div');
      root.id = 'floating-speaker-pip';
      root.className = 'floating-speaker-pip hidden';
      root.setAttribute('aria-label', '발표자 얼굴 창');
      root.innerHTML = `
        <div class="floating-speaker-header" id="floating-drag-header">
          <div class="floating-drag-grip" title="드래그하여 이동">
            <span class="floating-grip-dots" aria-hidden="true">⋮⋮</span>
            <span class="floating-speaker-title" id="floating-speaker-title">호스트</span>
            <span class="floating-live-dot" aria-hidden="true"></span>
          </div>
          <div class="floating-header-actions">
            ${this.isHost ? '<button type="button" class="floating-btn-action btn-floating-reset-host hidden" id="btn-floating-reset-host" title="호스트 얼굴로 복귀">👤 복귀</button>' : ''}
            <button type="button" class="floating-btn-action" id="btn-floating-min" title="최소화/확대">━</button>
            <button type="button" class="floating-btn-action" id="btn-floating-close" title="닫기 (나중에 다시 열 수 있음)">✕</button>
          </div>
        </div>
        <div class="floating-speaker-body" id="floating-speaker-body">
          <video class="floating-speaker-video" id="floating-speaker-video" autoplay playsinline muted></video>
          <div class="floating-speaker-fallback hidden" id="floating-speaker-fallback">
            <div class="floating-avatar-wrap">
              <div class="floating-avatar-circle" id="floating-avatar-circle">호</div>
              <div class="floating-voice-wave" aria-hidden="true">
                <span></span><span></span><span></span>
              </div>
            </div>
            <div class="floating-avatar-info">
              <span class="floating-avatar-name" id="floating-avatar-name">호스트</span>
              <span class="floating-avatar-badge">음성 참여 중</span>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(root);
    }

    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'floating-speaker-chip';
      chip.className = 'floating-speaker-chip hidden';
      chip.title = '발표자 얼굴 창 다시 열기';
      chip.innerHTML = `
        <span class="chip-ico" aria-hidden="true">👤</span>
        <span id="floating-chip-name">호스트</span>
      `;
      document.body.appendChild(chip);
    }

    this.root = root;
    this.chipEl = chip;
    this.videoEl = root.querySelector('#floating-speaker-video');
    this.fallbackEl = root.querySelector('#floating-speaker-fallback');
    this.titleEl = root.querySelector('#floating-speaker-title');
    this.avatarCircleEl = root.querySelector('#floating-avatar-circle');
    this.avatarNameEl = root.querySelector('#floating-avatar-name');
    this.resetHostBtn = root.querySelector('#btn-floating-reset-host');

    // 최소화 버튼
    root.querySelector('#btn-floating-min')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });

    // 닫기 버튼
    root.querySelector('#btn-floating-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeByUser();
    });

    // 호스트 복귀 버튼 (호스트 전용)
    this.resetHostBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onResetToHost?.();
    });

    // 복원 칩 클릭
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.restoreFromChip();
    });

    // 창 본체 더블 클릭 시 최소화 토글
    root.querySelector('#floating-drag-header')?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.toggleMinimize();
    });
  }

  setupDrag() {
    if (!this.root) return;
    const header = this.root.querySelector('#floating-drag-header');
    if (!header) return;

    // 초기 위치 (좌측 상단 안전 여백)
    if (!this.root.style.top && !this.root.style.left) {
      this.root.style.top = '74px';
      this.root.style.left = '20px';
      this.root.style.right = 'auto';
    }

    const onStart = (clientX, clientY) => {
      this._isDragging = true;
      this.root.classList.add('is-dragging');
      const rect = this.root.getBoundingClientRect();
      this._dragStart.x = clientX;
      this._dragStart.y = clientY;
      this._startPos.x = rect.left;
      this._startPos.y = rect.top;

      // right -> left 전환으로 정확한 좌표 이동 보장
      this.root.style.left = `${rect.left}px`;
      this.root.style.top = `${rect.top}px`;
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
    };

    const onMove = (clientX, clientY) => {
      if (!this._isDragging) return;
      const dx = clientX - this._dragStart.x;
      const dy = clientY - this._dragStart.y;
      const margin = 10;
      const w = this.root.offsetWidth || 260;
      const h = this.root.offsetHeight || 160;
      const maxLeft = Math.max(margin, window.innerWidth - w - margin);
      const maxTop = Math.max(margin, window.innerHeight - h - margin);

      let targetX = this._startPos.x + dx;
      let targetY = this._startPos.y + dy;

      targetX = Math.max(margin, Math.min(maxLeft, targetX));
      targetY = Math.max(margin, Math.min(maxTop, targetY));

      this.root.style.left = `${targetX}px`;
      this.root.style.top = `${targetY}px`;
    };

    const onEnd = () => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this.root.classList.remove('is-dragging');
    };

    // 마우스 이벤트
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      onStart(e.clientX, e.clientY);

      const moveHandler = (ev) => onMove(ev.clientX, ev.clientY);
      const upHandler = () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
        onEnd();
      };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);
    });

    // 모바일 터치 이벤트
    header.addEventListener('touchstart', (e) => {
      if (e.target.closest('button')) return;
      const t = e.touches[0];
      if (!t) return;
      onStart(t.clientX, t.clientY);

      const moveTouchHandler = (ev) => {
        const ct = ev.touches[0];
        if (ct) {
          ev.preventDefault();
          onMove(ct.clientX, ct.clientY);
        }
      };
      const endTouchHandler = () => {
        window.removeEventListener('touchmove', moveTouchHandler);
        window.removeEventListener('touchend', endTouchHandler);
        window.removeEventListener('touchcancel', endTouchHandler);
        onEnd();
      };
      window.addEventListener('touchmove', moveTouchHandler, { passive: false });
      window.addEventListener('touchend', endTouchHandler);
      window.addEventListener('touchcancel', endTouchHandler);
    }, { passive: true });

    // 윈도우 리사이즈 시 화면 밖 탈출 방지 클램핑
    window.addEventListener('resize', () => {
      if (this.root.classList.contains('hidden')) return;
      const rect = this.root.getBoundingClientRect();
      const margin = 10;
      const w = this.root.offsetWidth || 260;
      const h = this.root.offsetHeight || 160;
      const maxLeft = Math.max(margin, window.innerWidth - w - margin);
      const maxTop = Math.max(margin, window.innerHeight - h - margin);
      if (rect.left > maxLeft) this.root.style.left = `${maxLeft}px`;
      if (rect.top > maxTop) this.root.style.top = `${maxTop}px`;
    });
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    this.root?.classList.toggle('is-minimized', this.isMinimized);
    const minBtn = this.root?.querySelector('#btn-floating-min');
    if (minBtn) minBtn.textContent = this.isMinimized ? '▢' : '━';
  }

  closeByUser() {
    this.isClosedByUser = true;
    this.root?.classList.add('hidden');
    if (this.isSharingActive) {
      this.chipEl?.classList.remove('hidden');
      const chipName = this.chipEl?.querySelector('#floating-chip-name');
      if (chipName) chipName.textContent = this.currentSpeakerName || '발표자';
    }
  }

  restoreFromChip() {
    this.isClosedByUser = false;
    this.chipEl?.classList.add('hidden');
    if (this.isSharingActive) {
      this.root?.classList.remove('hidden');
    }
  }

  setSharingActive(active) {
    this.isSharingActive = !!active;
    if (this.isSharingActive) {
      if (!this.isClosedByUser) {
        this.root?.classList.remove('hidden');
        this.chipEl?.classList.add('hidden');
      } else {
        this.chipEl?.classList.remove('hidden');
      }
    } else {
      this.root?.classList.add('hidden');
      this.chipEl?.classList.add('hidden');
      if (this.videoEl) this.videoEl.srcObject = null;
    }
  }

  setSpeaker({ id, name = '호스트', role = 'host', stream = null } = {}) {
    this.currentSpeakerId = id || null;
    this.currentSpeakerName = name || (role === 'host' ? '호스트' : '참가자');
    this.currentSpeakerRole = role || 'host';

    const displayName = role === 'host' ? `${this.currentSpeakerName} (호스트)` : this.currentSpeakerName;
    if (this.titleEl) this.titleEl.textContent = displayName;
    if (this.avatarNameEl) this.avatarNameEl.textContent = displayName;
    if (this.avatarCircleEl) {
      this.avatarCircleEl.textContent = (name || '참').trim().charAt(0) || '?';
    }
    const chipName = this.chipEl?.querySelector('#floating-chip-name');
    if (chipName) chipName.textContent = displayName;

    // 호스트 복귀 버튼 가시성 (호스트 전용: 스포트라이트가 참가자일 때만 노출)
    if (this.resetHostBtn) {
      const isCustomParticipant = role !== 'host' && id && id !== this.hostClientId;
      this.resetHostBtn.classList.toggle('hidden', !isCustomParticipant);
    }

    this.setStream(stream);
  }

  setStream(stream) {
    this.currentStream = stream || null;
    const hasLiveVideo = !!(stream && stream.getVideoTracks && stream.getVideoTracks().some((t) => t.readyState === 'live'));

    if (hasLiveVideo && this.videoEl) {
      if (this.videoEl.srcObject !== stream) {
        this.videoEl.srcObject = stream;
        this.videoEl.play?.().catch(() => {});
      }
      this.videoEl.classList.remove('hidden');
      this.fallbackEl?.classList.add('hidden');
    } else {
      if (this.videoEl) {
        this.videoEl.srcObject = null;
        this.videoEl.classList.add('hidden');
      }
      this.fallbackEl?.classList.remove('hidden');
    }
  }

  updateVoice(isSpeaking, level = 0) {
    if (!this.root || this.root.classList.contains('hidden')) return;
    this.root.classList.toggle('is-speaking', !!isSpeaking);
    const waves = this.fallbackEl?.querySelectorAll('.floating-voice-wave span');
    if (waves && waves.length) {
      const scale = isSpeaking ? Math.min(2.0, 1.0 + level * 1.2) : 1.0;
      waves.forEach((w) => {
        w.style.transform = `scale(${scale.toFixed(2)})`;
        w.style.opacity = isSpeaking ? '0.85' : '0';
      });
    }
  }

  destroy() {
    this.root?.remove();
    this.chipEl?.remove();
    this.root = null;
    this.chipEl = null;
  }
}
