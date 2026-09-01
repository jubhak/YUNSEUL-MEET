/**
 * 참가자(모바일) 로컬 핀치 줌·팬
 * - 호스트 화면/슬라이드 변경과 무관하게 transform 유지
 * - 브라우저 페이지 줌이 아니라 live-stage 안 콘텐츠만 확대
 */
const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 280;

function dist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function mid(a, b) {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  };
}

/**
 * @param {HTMLElement | null} stageEl  #live-stage
 * @returns {{ reset: () => void, destroy: () => void } | null}
 */
export function setupViewerZoom(stageEl) {
  if (!stageEl) return null;

  let content = stageEl.querySelector('.live-zoom');
  if (!content) {
    content = document.createElement('div');
    content.className = 'live-zoom';
    while (stageEl.firstChild) content.appendChild(stageEl.firstChild);
    stageEl.appendChild(content);
  }

  stageEl.classList.add('live-stage-zoomable');

  let scale = 1;
  let tx = 0;
  let ty = 0;

  /** @type {{ scale: number, tx: number, ty: number, dist: number, midX: number, midY: number } | null} */
  let pinch = null;
  /** @type {{ x: number, y: number, tx: number, ty: number } | null} */
  let pan = null;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let raf = 0;

  function apply() {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stageEl.classList.toggle('is-zoomed', scale > 1.01);
  }

  function clampPan() {
    if (scale <= 1.01) {
      tx = 0;
      ty = 0;
      return;
    }
    const rect = stageEl.getBoundingClientRect();
    const maxX = (rect.width * (scale - 1)) / 2;
    const maxY = (rect.height * (scale - 1)) / 2;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }

  function scheduleApply() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      clampPan();
      apply();
    });
  }

  function reset() {
    scale = 1;
    tx = 0;
    ty = 0;
    pinch = null;
    pan = null;
    apply();
  }

  function zoomAt(clientX, clientY, nextScale) {
    const rect = stageEl.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    const prev = scale;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (scale === prev) return;
    const ratio = scale / prev;
    // 손가락(초점) 아래 점이 유지되도록 이동량 보정
    tx = cx - (cx - tx) * ratio;
    ty = cy - (cy - ty) * ratio;
    clampPan();
    apply();
  }

  function setPinching(on) {
    document.body.classList.toggle('is-pinching', !!on);
    if (on) {
      document.body.classList.remove('fs-chrome-open');
      window.YunseulFsChrome?.close?.();
    } else {
      document.body.dataset.pinchEndedAt = String(Date.now());
      // 숨김 상태 재고정
      window.YunseulFsChrome?.apply?.();
    }
  }

  function onTouchStart(e) {
    if (e.touches.length >= 2) {
      setPinching(true);
      pan = null;
      const a = e.touches[0];
      const b = e.touches[1];
      const m = mid(a, b);
      pinch = {
        scale,
        tx,
        ty,
        dist: dist(a, b) || 1,
        midX: m.x,
        midY: m.y,
      };
      e.preventDefault();
      return;
    }

    if (e.touches.length === 1 && scale > 1.01) {
      pinch = null;
      const t = e.touches[0];
      pan = { x: t.clientX, y: t.clientY, tx, ty };
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 2 && pinch) {
      setPinching(true);
      const a = e.touches[0];
      const b = e.touches[1];
      const d = dist(a, b) || 1;
      const m = mid(a, b);
      const nextScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, pinch.scale * (d / pinch.dist)),
      );
      const rect = stageEl.getBoundingClientRect();
      const startCx = pinch.midX - rect.left - rect.width / 2;
      const startCy = pinch.midY - rect.top - rect.height / 2;
      const curCx = m.x - rect.left - rect.width / 2;
      const curCy = m.y - rect.top - rect.height / 2;
      const ratio = nextScale / pinch.scale;
      scale = nextScale;
      // 시작 초점 기준 확대 + 두 손가락 중점 이동분 반영
      tx = curCx - (startCx - pinch.tx) * ratio;
      ty = curCy - (startCy - pinch.ty) * ratio;
      scheduleApply();
      e.preventDefault();
      return;
    }

    if (e.touches.length === 1 && pan && scale > 1.01) {
      const t = e.touches[0];
      tx = pan.tx + (t.clientX - pan.x);
      ty = pan.ty + (t.clientY - pan.y);
      scheduleApply();
      e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) {
      pinch = null;
      if (document.body.classList.contains('is-pinching')) {
        setPinching(false);
      }
    }
    if (e.touches.length === 1 && scale > 1.01) {
      const t = e.touches[0];
      pan = { x: t.clientX, y: t.clientY, tx, ty };
    } else if (e.touches.length === 0) {
      pan = null;
      clampPan();
      apply();

      // 더블탭 → 줌 리셋 (한 손가락)
      if (e.changedTouches.length === 1 && scale > 1.01) {
        const t = e.changedTouches[0];
        const now = Date.now();
        const close =
          Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 36;
        if (now - lastTapAt < DOUBLE_TAP_MS && close) {
          reset();
          lastTapAt = 0;
          return;
        }
        lastTapAt = now;
        lastTapX = t.clientX;
        lastTapY = t.clientY;
      }
    }
  }

  // 데스크톱 테스트용: Ctrl + 휠
  function onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    zoomAt(e.clientX, e.clientY, scale * factor);
  }

  const opts = { passive: false };
  stageEl.addEventListener('touchstart', onTouchStart, opts);
  stageEl.addEventListener('touchmove', onTouchMove, opts);
  stageEl.addEventListener('touchend', onTouchEnd, opts);
  stageEl.addEventListener('touchcancel', onTouchEnd, opts);
  stageEl.addEventListener('wheel', onWheel, opts);

  apply();

  return {
    reset,
    destroy() {
      stageEl.removeEventListener('touchstart', onTouchStart);
      stageEl.removeEventListener('touchmove', onTouchMove);
      stageEl.removeEventListener('touchend', onTouchEnd);
      stageEl.removeEventListener('touchcancel', onTouchEnd);
      stageEl.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
      reset();
    },
  };
}
