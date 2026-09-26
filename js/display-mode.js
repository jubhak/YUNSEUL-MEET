/**
 * 전체화면 · 모바일 가로 모드
 * 참가자(viewer): 전체화면 시 상단 메뉴 숨김 + ☰ 로 해제
 * 호스트: 전체화면에서도 툴바 항상 표시
 */
function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (window.matchMedia && window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches);
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
  btn.title = '메뉴 열기 (전체화면 종료)';
  btn.setAttribute('aria-label', '메뉴 열기');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="ico" aria-hidden="true">☰</span>';
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
    return;
  }

  // 호스트는 전체화면에서도 툴바 고정 표시
  if (isHostPage()) open = true;

  toolbar.style.setProperty('position', 'fixed', 'important');
  toolbar.style.setProperty('top', '0', 'important');
  toolbar.style.setProperty('left', '0', 'important');
  toolbar.style.setProperty('right', '0', 'important');
  toolbar.style.setProperty('z-index', '9000', 'important');
  toolbar.style.setProperty('transition', 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)', 'important');

  if (open) {
    toolbar.style.setProperty('transform', 'translate3d(0,0,0)', 'important');
    toolbar.style.setProperty('visibility', 'visible', 'important');
    toolbar.style.setProperty('pointer-events', 'auto', 'important');
  } else {
    toolbar.style.setProperty('transform', 'translate3d(0,-120%,0)', 'important');
    toolbar.style.setProperty('visibility', 'hidden', 'important');
    toolbar.style.setProperty('pointer-events', 'none', 'important');
  }
}

function setChromeOpen(open) {
  // 핀치 줌 중/직후엔 메뉴를 열지 않음 (참가자만)
  if (open && !isHostPage() && recentlyPinching()) return;

  const btn = ensureChromeBtn();
  if (isHostPage() && document.body.classList.contains('is-fullscreen')) {
    open = true;
  }
  document.body.classList.toggle('fs-chrome-open', !!open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.title = '메뉴 열기';
  btn.setAttribute('aria-label', '메뉴 열기');
  const ico = btn.querySelector('.ico');
  if (ico) ico.textContent = '☰';
  // 호스트: ☰ 불필요. 참가자: 메뉴 열림 → 버튼 숨김
  if (isHostPage()) {
    btn.hidden = true;
  } else {
    btn.hidden = !!open || !document.body.classList.contains('is-fullscreen');
  }
  applyChromeVisibility(!!open);
}

function enterFsChrome() {
  document.body.classList.add('is-fullscreen');
  if (isHostPage()) {
    setChromeOpen(true);
  } else {
    setChromeOpen(false);
    applyChromeVisibility(false);
  }
  window.YunseulToolbar?.pin?.();
  applyChromeVisibility(isHostPage());
}

function exitFsChrome() {
  document.body.classList.remove('is-fullscreen', 'fs-chrome-open');
  const btn = document.getElementById('btn-fs-chrome');
  if (btn) {
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.title = '메뉴 열기';
    btn.setAttribute('aria-label', '메뉴 열기');
    const ico = btn.querySelector('.ico');
    if (ico) ico.textContent = '☰';
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
      if (isHostPage()) return;
      setChromeOpen(false);
    },
    apply: () => applyChromeVisibility(
      isHostPage() || document.body.classList.contains('fs-chrome-open')
    ),
  };

  btn?.addEventListener('click', () => toggleFullscreen());
  gateBtn?.addEventListener('click', async () => {
    await enterFullscreen();
    gate?.classList.add('hidden');
  });

  chromeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isFullscreen() && !document.body.classList.contains('is-fullscreen')) return;
    if (recentlyPinching()) return;
    // 메뉴 열기 = 전체화면 해제 → 상단 메뉴 정상 표시, ☰ 숨김
    exitFullscreen();
  });

  // 멀티터치로 메뉴 버튼이 눌리는 것 방지
  chromeBtn.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || recentlyPinching()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false });

  // 메뉴 바깥 탭 시 다시 숨김 (참가자만)
  document.addEventListener('pointerdown', (e) => {
    if (isHostPage()) return;
    if (!document.body.classList.contains('fs-chrome-open')) return;
    if (recentlyPinching()) return;
    const toolbar = document.getElementById('main-toolbar');
    if (chromeBtn.contains(e.target)) return;
    if (toolbar && toolbar.contains(e.target)) return;
    setChromeOpen(false);
  }, true);

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // 줌/뷰포트 변화 후에도 상태 유지
  const keepChromeState = () => {
    if (!document.body.classList.contains('is-fullscreen')) return;
    if (isHostPage()) {
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
