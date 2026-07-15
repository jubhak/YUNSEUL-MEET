/**
 * 전체화면 · 모바일 가로 모드
 */
function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (window.matchMedia && window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches);
}

function getFsElement() {
  return document.documentElement;
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

export async function enterFullscreen() {
  const el = getFsElement();
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch (err) {
    console.warn('fullscreen failed', err);
  }

  try {
    const orient = screen.orientation || screen.mozOrientation || screen.msOrientation;
    if (orient?.lock) await orient.lock('landscape');
  } catch {
    // iOS 등은 잠금 미지원 — 회전 안내만 표시
  }

  document.body.classList.add('is-presenting');
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
  hideRotateHint();
}

export async function toggleFullscreen() {
  if (isFullscreen()) await exitFullscreen();
  else await enterFullscreen();
}

function updateRotateHint() {
  const hint = document.getElementById('rotate-hint');
  if (!hint) return;
  const needRotate = isMobile() && window.innerHeight > window.innerWidth;
  hint.classList.toggle('hidden', !needRotate);
}

function hideRotateHint() {
  document.getElementById('rotate-hint')?.classList.add('hidden');
}

export function setupDisplayMode({ autoPromptMobile = false } = {}) {
  const btn = document.getElementById('btn-fullscreen');
  const gate = document.getElementById('mobile-fs-gate');
  const gateBtn = document.getElementById('btn-mobile-fs');

  btn?.addEventListener('click', () => toggleFullscreen());
  gateBtn?.addEventListener('click', async () => {
    await enterFullscreen();
    gate?.classList.add('hidden');
  });

  document.addEventListener('fullscreenchange', () => {
    btn?.classList.toggle('active', isFullscreen());
    if (!isFullscreen()) {
      document.body.classList.remove('is-presenting');
      hideRotateHint();
    } else {
      document.body.classList.add('is-presenting');
      updateRotateHint();
    }
    // 전체화면 크기 변경 후 슬라이드 contain 재계산
    setTimeout(() => window.dispatchEvent(new Event('resize')), 80);
  });

  window.addEventListener('resize', () => {
    if (isFullscreen() || document.body.classList.contains('is-presenting')) {
      updateRotateHint();
    }
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(updateRotateHint, 200);
  });

  // 발표 시작 시 모바일에서 전체화면 유도
  window.addEventListener('ppt-ready', () => {
    document.body.classList.add('has-presentation');
    if (autoPromptMobile && isMobile() && !isFullscreen()) {
      gate?.classList.remove('hidden');
    } else if (isMobile()) {
      updateRotateHint();
    }
  });
}

// F 키로 전체화면
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    toggleFullscreen();
  }
});
