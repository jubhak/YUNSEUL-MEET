/**
 * 전체화면 · 모바일 가로 모드
 * - 모바일: 전체 모드일 때만 상단 툴바 10초 뒤 부드럽게 위로 숨김, 좌측 상단 메뉴(☰) 버튼으로 다시 열기 및 10초 뒤 재숨김
 * - 전체 모드가 아닐 때는 툴바가 항상 표시되고 메뉴 버튼은 숨김
 * - 데스크톱 호스트: 전체화면에서도 툴바 항상 표시
 */
export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (window.matchMedia && window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches)
    || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
    || (window.innerWidth <= 768);
}

function isViewerPage() {
  return document.body.classList.contains('viewer-page');
}

function isHostPage() {
  return document.body.classList.contains('presentation-page') || !isViewerPage();
}

function getFsElement() {
  return document.documentElement;
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

const PINCH_GUARD_MS = 500;
const AUTO_HIDE_DELAY_MS = 10000; // 10초

let hideTimer = null;

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function startHideTimer() {
  clearHideTimer();
  // 모바일 화면의 전체 모드일 때만 10초 후 자동 숨김 동작
  if (!isMobile() || !document.body.classList.contains('is-fullscreen')) {
    return;
  }
  hideTimer = setTimeout(() => {
    setChromeOpen(false);
  }, AUTO_HIDE_DELAY_MS);
}

function recentlyPinching() {
  if (document.body.classList.contains('is-pinching')) return true;
  const ended = Number(document.body.dataset.pinchEndedAt || 0);
  return ended > 0 && Date.now() - ended < PINCH_GUARD_MS;
}

function ensureChromeBtn() {
  let btn = document.getElementById('btn-fs-chrome');
  if (btn) return btn;
  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-fs-chrome';
  btn.className = 'btn-fs-chrome';
  btn.title = '메뉴 열기';
  btn.setAttribute('aria-label', '메뉴 열기');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `
    <span class="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
      </svg>
    </span>`;
  btn.hidden = true;
  document.body.appendChild(btn);
  return btn;
}

/** 전체화면 메뉴 표시 상태를 인라인으로 고정 (줌/리사이즈에 안 풀리게) */
function applyChromeVisibility(open) {
  const toolbar = document.getElementById('main-toolbar');
  if (!toolbar) return;

  if (!document.body.classList.contains('is-fullscreen')) {
    toolbar.style.removeProperty('transform');
    toolbar.style.removeProperty('visibility');
    toolbar.style.removeProperty('pointer-events');
    toolbar.style.removeProperty('transition');
    toolbar.style.removeProperty('opacity');
    return;
  }

  // 데스크톱 호스트는 전체화면에서도 툴바 고정 표시
  if (isHostPage() && !isMobile()) open = true;

  toolbar.style.setProperty('position', 'fixed', 'important');
  toolbar.style.setProperty('top', '0', 'important');
  toolbar.style.setProperty('left', '0', 'important');
  toolbar.style.setProperty('right', '0', 'important');
  toolbar.style.setProperty('z-index', '9000', 'important');
  toolbar.style.setProperty('transition', 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease', 'important');

  if (open) {
    toolbar.style.setProperty('transform', 'translate3d(0,0,0)', 'important');
    toolbar.style.setProperty('visibility', 'visible', 'important');
    toolbar.style.setProperty('pointer-events', 'auto', 'important');
    toolbar.style.setProperty('opacity', '1', 'important');
  } else {
    toolbar.style.setProperty('transform', 'translate3d(0,-120%,0)', 'important');
    toolbar.style.setProperty('visibility', 'hidden', 'important');
    toolbar.style.setProperty('pointer-events', 'none', 'important');
    toolbar.style.setProperty('opacity', '0', 'important');
  }
}

function setChromeOpen(open) {
  // 핀치 줌 중/직후엔 메뉴를 열지 않음 (참가자만)
  if (open && recentlyPinching()) return;

  if (isHostPage() && !isMobile() && document.body.classList.contains('is-fullscreen')) {
    open = true;
  }

  const isFs = document.body.classList.contains('is-fullscreen');
  const btn = ensureChromeBtn();

  document.body.classList.toggle('fs-chrome-open', !!open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.title = open ? '메뉴 닫기' : '메뉴 열기';
  btn.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');

  // 전체화면 아닐 때는 항상 메뉴 버튼 숨김
  if (!isFs) {
    btn.hidden = true;
    btn.style.setProperty('display', 'none', 'important');
  } else if (isHostPage() && !isMobile()) {
    // 데스크톱 호스트: 툴바 항상 표시이므로 메뉴 버튼 숨김
    btn.hidden = true;
    btn.style.setProperty('display', 'none', 'important');
  } else {
    // 모바일 또는 참가자 전체화면: 메뉴가 열려있을 땐 버튼 숨김, 닫혔을 땐 좌측 상단에 표시
    btn.hidden = !!open;
    btn.style.setProperty('display', open ? 'none' : 'inline-flex', 'important');
  }

  applyChromeVisibility(!!open);

  // 모바일 전체 모드에서 열렸을 경우 10초 타이머 시작
  if (open && isMobile() && isFs) {
    startHideTimer();
  } else if (!open) {
    clearHideTimer();
  }
}

function enterFsChrome() {
  document.body.classList.add('is-fullscreen');
  if (isMobile()) {
    // 모바일: 전체화면 진입 시 상단 툴바 표시 후 10초 뒤 부드럽게 위로 사라짐
    setChromeOpen(true);
  } else if (isHostPage()) {
    // 데스크톱 호스트: 툴바 항상 표시
    setChromeOpen(true);
  } else {
    // 데스크톱 참가자
    setChromeOpen(false);
  }
  window.YunseulToolbar?.pin?.();
}

function exitFsChrome() {
  clearHideTimer();
  document.body.classList.remove('is-fullscreen', 'fs-chrome-open');
  const btn = document.getElementById('btn-fs-chrome');
  if (btn) {
    btn.hidden = true;
    btn.style.setProperty('display', 'none', 'important');
    btn.setAttribute('aria-expanded', 'false');
  }
  applyChromeVisibility(false);
  window.YunseulToolbar?.pin?.();
}

function onFullscreenChange() {
  const btn = document.getElementById('btn-fullscreen');
  const fs = isFullscreen();
  btn?.classList.toggle('active', fs);
  if (fs) {
    document.body.classList.add('is-presenting');
    enterFsChrome();
    updateRotateHint();
  } else {
    document.body.classList.remove('is-presenting');
    exitFsChrome();
    hideRotateHint();
  }
  setTimeout(() => window.dispatchEvent(new Event('resize')), 80);
}

export async function enterFullscreen() {
  const el = getFsElement();
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (err) {
    console.warn('fullscreen failed', err);
  }

  // 모바일 가로 모드 잠금 시도 (호스트 및 참가자 모두)
  try {
    const orient = screen.orientation || screen.mozOrientation || screen.msOrientation;
    if (orient?.lock) await orient.lock('landscape');
  } catch {
    // iOS 등 브라우저 미지원 시 회전 안내 오버레이 표시
  }

  document.body.classList.add('is-presenting');
  if (isFullscreen()) enterFsChrome();
  updateRotateHint();
}

export async function exitFullscreen() {
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch { /* ignore */ }

  try {
    const orient = screen.orientation;
    if (orient?.unlock) orient.unlock();
  } catch { /* ignore */ }

  document.body.classList.remove('is-presenting');
  exitFsChrome();
  updateRotateHint();
}

export async function toggleFullscreen() {
  if (isFullscreen()) await exitFullscreen();
  else await enterFullscreen();
}

export function updateRotateHint() {
  const hint = document.getElementById('rotate-hint');
  if (!hint) return;
  // 휴대폰/모바일 기기는 가로 화면만 지원 (세로 모드 시 회전 안내 표시)
  const isPortrait = window.innerHeight > window.innerWidth;
  const needRotate = isMobile() && isPortrait;
  hint.classList.toggle('hidden', !needRotate);
  if (needRotate) {
    hint.setAttribute('aria-hidden', 'false');
  } else {
    hint.setAttribute('aria-hidden', 'true');
  }
}

function hideRotateHint() {
  document.getElementById('rotate-hint')?.classList.add('hidden');
}

export function setupDisplayMode({ autoPromptMobile = false } = {}) {
  const btn = document.getElementById('btn-fullscreen');
  const gate = document.getElementById('mobile-fs-gate');
  const gateBtn = document.getElementById('btn-mobile-fs');
  const chromeBtn = ensureChromeBtn();

  window.YunseulFsChrome = {
    close: () => {
      if (isHostPage() && !isMobile()) return;
      setChromeOpen(false);
    },
    open: () => {
      setChromeOpen(true);
    },
    apply: () => applyChromeVisibility(
      (isHostPage() && !isMobile()) || document.body.classList.contains('fs-chrome-open')
    ),
  };

  btn?.addEventListener('click', () => toggleFullscreen());
  gateBtn?.addEventListener('click', async () => {
    await enterFullscreen();
    gate?.classList.add('hidden');
  });

  // 좌측 상단 메뉴 버튼 탭 시 툴바 다시 표시 및 10초 타이머 시작
  chromeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!document.body.classList.contains('is-fullscreen')) return;
    if (recentlyPinching()) return;

    setChromeOpen(true);
  });

  // 멀티터치로 메뉴 버튼이 눌리는 것 방지
  chromeBtn.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || recentlyPinching()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false });

  // 툴바 내부 조작 시 10초 타이머 리셋 (사용 중 사라짐 방지)
  const toolbar = document.getElementById('main-toolbar');
  if (toolbar) {
    const keepToolbarAwake = () => {
      if (isMobile() && document.body.classList.contains('is-fullscreen') && document.body.classList.contains('fs-chrome-open')) {
        startHideTimer();
      }
    };
    toolbar.addEventListener('pointerdown', keepToolbarAwake, { passive: true });
    toolbar.addEventListener('touchstart', keepToolbarAwake, { passive: true });
    toolbar.addEventListener('click', keepToolbarAwake, { passive: true });
  }

  // 메뉴 바깥 터치 시 다시 숨김
  document.addEventListener('pointerdown', (e) => {
    if (!isMobile() && isHostPage()) return;
    if (!document.body.classList.contains('fs-chrome-open')) return;
    if (recentlyPinching()) return;
    if (chromeBtn.contains(e.target)) return;
    if (toolbar && toolbar.contains(e.target)) return;
    setChromeOpen(false);
  }, true);

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 줌/뷰포트 변화 후에도 상태 유지
  const keepChromeState = () => {
    if (!document.body.classList.contains('is-fullscreen')) return;
    if (isHostPage() && !isMobile()) {
      applyChromeVisibility(true);
      return;
    }
    if (document.body.classList.contains('fs-chrome-open') && recentlyPinching()) {
      setChromeOpen(false);
      return;
    }
    applyChromeVisibility(document.body.classList.contains('fs-chrome-open'));
  };
  if (isMobile()) {
    updateRotateHint();
  }
  window.addEventListener('resize', () => {
    keepChromeState();
    if (isMobile()) {
      updateRotateHint();
    }
  });
  window.visualViewport?.addEventListener('resize', keepChromeState);
  window.visualViewport?.addEventListener('scroll', keepChromeState);
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      keepChromeState();
      updateRotateHint();
    }, 150);
  });

  // 발표 시작 시 모바일 가로 회전 안내 및 전체화면 유도
  window.addEventListener('ppt-ready', () => {
    document.body.classList.add('has-presentation');
    if (isMobile()) {
      updateRotateHint();
    }
    if (autoPromptMobile && isMobile() && !isFullscreen()) {
      gate?.classList.remove('hidden');
    }
  });

  if (isFullscreen()) onFullscreenChange();
}

// F 키로 전체화면
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    toggleFullscreen();
  }
});
