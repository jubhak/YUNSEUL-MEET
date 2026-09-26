/**
 * cam-focus-manager.js
 * 1) 카메라 더블 클릭 시 90%:10% 집중 뷰 레이아웃 전환 & 스왑 & 복귀 관리
 * 2) Web Audio API 기반 음성 발화 감지(VAD) — 말할 때 노란색 테두리 표시 및 5초 후 자동 해제
 */

export class CamFocusManager {
  constructor({ containerId = 'cam-overlay-container' } = {}) {
    this.container = document.getElementById(containerId);
    this.isFocused = false;
    this.focusedId = null;
    this.mainEl = null;
    this.sidebarEl = null;
    this.exitBtn = null;
    this._boundKeydown = this._handleKeydown.bind(this);
    this._initElements();
  }

  _initElements() {
    if (!this.container) return;

    // 복귀 버튼
    let btn = document.getElementById('btn-cam-exit-focus');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btn-cam-exit-focus';
      btn.className = 'btn-cam-exit-focus';
      btn.title = '원래 화면으로 돌아가기 (Esc)';
      btn.innerHTML = '<span class="ico">✕</span><span>원래 화면으로 돌아가기</span>';
      btn.style.display = 'none';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.exitFocus();
      });
      this.container.appendChild(btn);
    }
    this.exitBtn = btn;

    // 메인 (90%) 영역
    let main = document.getElementById('cam-focus-main');
    if (!main) {
      main = document.createElement('div');
      main.id = 'cam-focus-main';
      main.className = 'cam-focus-main';
      main.style.display = 'none';
      this.container.appendChild(main);
    }
    this.mainEl = main;

    // 사이드바 (10%) 영역
    let sidebar = document.getElementById('cam-focus-sidebar');
    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'cam-focus-sidebar';
      sidebar.className = 'cam-focus-sidebar';
      sidebar.style.display = 'none';
      this.container.appendChild(sidebar);
    }
    this.sidebarEl = sidebar;
  }

  _handleKeydown(e) {
    if (e.key === 'Escape' && this.isFocused) {
      this.exitFocus();
    }
  }

  /**
   * 새 카메라 박스가 생성되었을 때 더블 클릭 리스너 등록
   * @param {string} id
   * @param {HTMLElement} box
   */
  bindBox(id, box) {
    if (!box) return;
    box.dataset.camId = id;
    box.removeEventListener('dblclick', box._camDblClick);
    box._camDblClick = (e) => {
      e.stopPropagation();
      this.handleBoxDblClick(id);
    };
    box.addEventListener('dblclick', box._camDblClick);

    // 포커스 모드 중 새 참가자 박스가 추가된 경우: 사이드바로 자동 배치
    if (this.isFocused) {
      if (id === this.focusedId) {
        if (this.mainEl && !this.mainEl.contains(box)) {
          this.mainEl.appendChild(box);
        }
      } else {
        if (this.sidebarEl && !this.sidebarEl.contains(box)) {
          this.sidebarEl.appendChild(box);
        }
      }
      this._resumeVideo(box);
    }
  }

  handleBoxDblClick(id) {
    if (!this.isFocused) {
      this.enterFocus(id);
    } else {
      if (this.focusedId !== id) {
        this.swapFocus(id);
      }
    }
  }

  enterFocus(targetId) {
    if (!this.container) return;
    this._initElements();

    const targetBox = document.getElementById(`cam-box-${targetId}`);
    if (!targetBox) return;

    this.isFocused = true;
    this.focusedId = targetId;
    this.container.classList.add('is-focus-mode');

    this.exitBtn.style.display = 'inline-flex';
    this.mainEl.style.display = 'flex';
    this.sidebarEl.style.display = 'flex';

    // 모든 현재 cam-pip-box 수집
    const allBoxes = Array.from(this.container.querySelectorAll('.cam-pip-box'));

    // 메인에 타겟 박스 배치
    this.mainEl.innerHTML = '';
    this.mainEl.appendChild(targetBox);
    this._resumeVideo(targetBox);

    // 사이드바에 나머지 박스 배치
    this.sidebarEl.innerHTML = '';
    for (const b of allBoxes) {
      if (b !== targetBox) {
        this.sidebarEl.appendChild(b);
        this._resumeVideo(b);
      }
    }

    window.addEventListener('keydown', this._boundKeydown);
    this.onFocusChange?.(this.focusedId);
  }

  swapFocus(newTargetId) {
    if (!this.isFocused) return this.enterFocus(newTargetId);
    const newBox = document.getElementById(`cam-box-${newTargetId}`);
    if (!newBox || this.focusedId === newTargetId) return;

    const oldTargetId = this.focusedId;
    const oldBox = document.getElementById(`cam-box-${oldTargetId}`);

    // 기존 메인 박스를 사이드바로 이동
    if (oldBox) {
      this.sidebarEl.prepend(oldBox);
      this._resumeVideo(oldBox);
    }

    // 새로운 박스를 메인으로 이동
    this.mainEl.innerHTML = '';
    this.mainEl.appendChild(newBox);
    this._resumeVideo(newBox);

    this.focusedId = newTargetId;
    this.onFocusChange?.(this.focusedId);
  }

  exitFocus() {
    if (!this.isFocused || !this.container) return;
    this.isFocused = false;
    this.focusedId = null;

    window.removeEventListener('keydown', this._boundKeydown);

    // 메인 및 사이드바에서 모든 박스를 꺼내어 container로 원복
    const allBoxes = Array.from(this.container.querySelectorAll('.cam-pip-box'));
    this.container.classList.remove('is-focus-mode');

    if (this.exitBtn) this.exitBtn.style.display = 'none';
    if (this.mainEl) {
      this.mainEl.innerHTML = '';
      this.mainEl.style.display = 'none';
    }
    if (this.sidebarEl) {
      this.sidebarEl.innerHTML = '';
      this.sidebarEl.style.display = 'none';
    }

    for (const b of allBoxes) {
      this.container.appendChild(b);
      this._resumeVideo(b);
    }
    this.onFocusChange?.(null);
  }

  onBoxRemoved(id) {
    if (!this.isFocused) return;
    if (this.focusedId === id) {
      // 메인 박스가 퇴장한 경우: 사이드바의 첫 번째 참가자를 메인으로 승격
      const nextBox = this.sidebarEl?.querySelector('.cam-pip-box');
      if (nextBox && nextBox.dataset.camId) {
        this.swapFocus(nextBox.dataset.camId);
      } else {
        // 남은 카메라가 없으면 집중 뷰 종료
        this.exitFocus();
      }
    }
  }

  _resumeVideo(box) {
    if (!box) return;
    const v = box.querySelector('video');
    if (v) {
      v.play?.().catch(() => {});
    }
  }
}

/**
 * Web Audio API 기반 음성 발화 감지(VAD)
 * 목소리가 들릴 때 참가자 카메라 박스에 .is-speaking 부여 (노란색 테두리)
 * 음성이 5초간 없으면 .is-speaking 해제
 */
export class VoiceActivityMonitor {
  constructor({ threshold = 0.026, holdMs = 5000 } = {}) {
    this.threshold = threshold;
    this.holdMs = holdMs;
    this._audioCtx = null;
    this._tracks = new Map(); // id -> { track, clone, sourceNode, analyser, intervalId }
    this._speakingTimers = new Map(); // id -> timerId
  }

  _ensureContext() {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this._audioCtx = new AC();
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
    return this._audioCtx;
  }

  attach(id, track) {
    if (!id || !track || track.kind !== 'audio') return;
    this.detach(id);
    const ctx = this._ensureContext();
    if (!ctx) return;

    try {
      const clone = track.clone();
      const ms = new MediaStream([clone]);
      const sourceNode = ctx.createMediaStreamSource(ms);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.25;
      sourceNode.connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const intervalId = setInterval(() => {
        if (!track || track.readyState === 'ended' || !track.enabled) return;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > this.threshold) {
          this._handleSpeaking(id);
        }
      }, 120);

      track.addEventListener('ended', () => {
        this.detach(id);
      }, { once: true });

      this._tracks.set(id, { track, clone, sourceNode, analyser, intervalId });
    } catch (err) {
      console.warn('[VAD] attach error', id, err);
    }
  }

  _handleSpeaking(id) {
    this._setSpeakingUi(id, true);

    if (this._speakingTimers.has(id)) {
      clearTimeout(this._speakingTimers.get(id));
    }
    const timer = setTimeout(() => {
      this._setSpeakingUi(id, false);
      this._speakingTimers.delete(id);
    }, this.holdMs);
    this._speakingTimers.set(id, timer);
  }

  _setSpeakingUi(id, speaking) {
    const box = document.getElementById(`cam-box-${id}`);
    if (box) {
      box.classList.toggle('is-speaking', !!speaking);
    }
  }

  detach(id) {
    const entry = this._tracks.get(id);
    if (entry) {
      clearInterval(entry.intervalId);
      try { entry.sourceNode.disconnect(); } catch { /* ignore */ }
      try { entry.analyser.disconnect(); } catch { /* ignore */ }
      try { entry.clone?.stop(); } catch { /* ignore */ }
      this._tracks.delete(id);
    }
    if (this._speakingTimers.has(id)) {
      clearTimeout(this._speakingTimers.get(id));
      this._speakingTimers.delete(id);
      this._setSpeakingUi(id, false);
    }
  }

  destroy() {
    for (const id of Array.from(this._tracks.keys())) {
      this.detach(id);
    }
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      try { this._audioCtx.close(); } catch { /* ignore */ }
    }
    this._audioCtx = null;
  }
}
