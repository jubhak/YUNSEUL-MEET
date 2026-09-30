/**
 * 참가자 로컬 줌·팬 (호스트 화면/슬라이드 변경과 무관하게 transform 유지)
 *
 * - 모바일(터치): 기본 배율을 "호스트 화면에 얼굴 약 10명이 폰 화면을 채우는 정도"로 자동 설정하고,
 *   나머지 얼굴은 한 손가락 드래그(팬)로 확인. 두 손가락 핀치로 자유 확대/축소, 더블탭으로 기본 배율 ↔ 확대.
 * - PC(마우스): 휠로 확대/축소, 확대 상태에서는 "초점이 마우스를 따라감"(마우스 위치 = 보는 위치),
 *   우측 하단 줌 UI(−/+/맞춤/따라가기 토글)로 조작. 따라가기를 끄면 드래그로 이동.
 * - 브라우저 페이지 줌이 아니라 live-stage 안 콘텐츠만 확대
 */
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 280;
/** 폰 화면에 기본으로 채울 얼굴 수 */
export const DEFAULT_VISIBLE_FACES = 10;
const FOLLOW_KEY = 'ym_zoom_follow';

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function mid(a, b) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {HTMLElement | null} stageEl  #live-stage
 * @returns {{ reset: () => void, applyDefault: () => void, setFaceCount: (n:number)=>void, setScale: (s:number)=>void, getScale: () => number, destroy: () => void } | null}
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

  const isCoarse = () => window.matchMedia?.('(pointer: coarse)')?.matches ?? ('ontouchstart' in window);
  const isFine = () => window.matchMedia?.('(pointer: fine)')?.matches ?? !isCoarse();

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let faceCount = 0;
  let defaultScale = 1;
  let userAdjusted = false;
  let followMouse = (() => {
    try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; }
  })();

  /** @type {{ scale: number, tx: number, ty: number, dist: number, midX: number, midY: number } | null} */
  let pinch = null;
  /** @type {{ x: number, y: number, tx: number, ty: number } | null} */
  let pan = null;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let raf = 0;
  let followRaf = 0;
  let mouse = null; // { x, y } 스테이지 기준 클라이언트 좌표
  let mouseDrag = null;

  // ── 콘텐츠(비디오) 실제 표시 크기: object-fit: contain 레터박스 반영 ─────────────
  function contentSize() {
    const rect = stageEl.getBoundingClientRect();
    const sw = rect.width || 1;
    const sh = rect.height || 1;
    const v = stageEl.querySelector('video');
    const vw = v?.videoWidth || 0;
    const vh = v?.videoHeight || 0;
    if (!vw || !vh) return { sw, sh, cw: sw, ch: sh, rect };
    const r = Math.min(sw / vw, sh / vh);
    return { sw, sh, cw: vw * r, ch: vh * r, rect };
  }

  function bounds() {
    const { sw, sh, cw, ch } = contentSize();
    return {
      maxX: Math.max(0, (cw * scale - sw) / 2),
      maxY: Math.max(0, (ch * scale - sh) / 2),
    };
  }

  function clampPan() {
    const { maxX, maxY } = bounds();
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  let ui = null;
  let uiPct = null;
  let uiFollowBtn = null;

  function buildUi() {
    if (ui || !isFine()) return;
    ui = document.createElement('div');
    ui.className = 'ym-zoom-ui';
    ui.innerHTML = `
      <button type="button" data-z="out" title="축소 (마우스 휠 ↓)">−</button>
      <span class="ym-zoom-pct">100%</span>
      <button type="button" data-z="in" title="확대 (마우스 휠 ↑)">+</button>
      <button type="button" data-z="fit" title="화면에 맞춤 (더블클릭)">맞춤</button>
      <button type="button" data-z="follow" class="ym-zoom-follow" title="확대 중 마우스를 따라 화면 이동">🎯 따라가기</button>
    `;
    stageEl.appendChild(ui);
    uiPct = ui.querySelector('.ym-zoom-pct');
    uiFollowBtn = ui.querySelector('[data-z="follow"]');
    ui.addEventListener('pointerdown', (e) => e.stopPropagation());
    ui.addEventListener('dblclick', (e) => e.stopPropagation());
    ui.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-z]');
      if (!b) return;
      e.stopPropagation();
      const { rect } = contentSize();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      userAdjusted = true;
      switch (b.dataset.z) {
        case 'in': zoomAt(cx, cy, scale * 1.25); break;
        case 'out': zoomAt(cx, cy, scale / 1.25); break;
        case 'fit': setScaleAnimated(1); break;
        case 'follow':
          followMouse = !followMouse;
          try { localStorage.setItem(FOLLOW_KEY, followMouse ? '1' : '0'); } catch { /* ignore */ }
          syncUi();
          break;
        default: break;
      }
    });
    syncUi();
  }

  function syncUi() {
    if (!ui) return;
    if (uiPct) uiPct.textContent = `${Math.round(scale * 100)}%`;
    uiFollowBtn?.classList.toggle('is-on', followMouse);
    ui.classList.toggle('is-zoomed', scale > 1.01);
  }

  // ── 적용 ──────────────────────────────────────────────────────────────────
  function apply() {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stageEl.classList.toggle('is-zoomed', scale > 1.01);
    syncUi();
  }

  function scheduleApply() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      clampPan();
      apply();
    });
  }

  /** 기본 배율: 모바일은 얼굴 ~10명이 화면을 채우도록 (얼굴 수가 많을수록 확대) */
  function computeDefaultScale() {
    if (!isCoarse()) return 1;
    const n = faceCount > 0 ? faceCount : DEFAULT_VISIBLE_FACES;
    // 화면 면적 대비 보이는 비율 = 10/n → 배율 = sqrt(n/10). 화면 공유가 그리드 형태(3열)라는 가정.
    return clamp(Math.sqrt(n / DEFAULT_VISIBLE_FACES), 1, 3.2);
  }

  function applyDefault() {
    defaultScale = computeDefaultScale();
    scale = defaultScale;
    tx = 0;
    // 상단 정렬로 시작 (그리드는 왼쪽 위부터 채워지므로)
    const { maxY } = bounds();
    ty = defaultScale > 1.01 ? maxY : 0;
    pinch = null;
    pan = null;
    userAdjusted = false;
    apply();
  }

  function reset() {
    applyDefault();
  }

  function setScale(next) {
    const { rect } = contentSize();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, next);
  }

  let animRaf = 0;
  function setScaleAnimated(target) {
    cancelAnimationFrame(animRaf);
    const from = { s: scale, x: tx, y: ty };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 160);
      const e = 1 - (1 - p) * (1 - p);
      scale = from.s + (target - from.s) * e;
      tx = from.x * (1 - e);
      ty = from.y * (1 - e);
      if (target > 1.01) {
        clampPan();
      }
      apply();
      if (p < 1) animRaf = requestAnimationFrame(step);
    };
    animRaf = requestAnimationFrame(step);
  }

  function zoomAt(clientX, clientY, nextScale) {
    const { rect } = contentSize();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    const prev = scale;
    scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (scale === prev) return;
    const ratio = scale / prev;
    // 포인터(초점) 아래 점이 유지되도록 이동량 보정
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
      window.YunseulFsChrome?.apply?.();
    }
  }

  // ── 터치 ──────────────────────────────────────────────────────────────────
  function onTouchStart(e) {
    if (e.touches.length >= 2) {
      setPinching(true);
      pan = null;
      userAdjusted = true;
      const a = e.touches[0];
      const b = e.touches[1];
      const m = mid(a, b);
      pinch = { scale, tx, ty, dist: dist(a, b) || 1, midX: m.x, midY: m.y };
      e.preventDefault();
      return;
    }
    if (e.touches.length === 1) {
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
      const nextScale = clamp(pinch.scale * (d / pinch.dist), MIN_SCALE, MAX_SCALE);
      const { rect } = contentSize();
      const startCx = pinch.midX - rect.left - rect.width / 2;
      const startCy = pinch.midY - rect.top - rect.height / 2;
      const curCx = m.x - rect.left - rect.width / 2;
      const curCy = m.y - rect.top - rect.height / 2;
      const ratio = nextScale / pinch.scale;
      scale = nextScale;
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
      userAdjusted = true;
      scheduleApply();
      e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) {
      pinch = null;
      if (document.body.classList.contains('is-pinching')) setPinching(false);
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      pan = { x: t.clientX, y: t.clientY, tx, ty };
    } else if (e.touches.length === 0) {
      pan = null;
      clampPan();
      apply();

      // 더블탭: 기본 배율에서는 2배 확대(탭한 곳 중심), 확대돼 있으면 기본 배율로 복귀
      if (e.changedTouches.length === 1) {
        const t = e.changedTouches[0];
        const now = Date.now();
        const close = Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 36;
        if (now - lastTapAt < DOUBLE_TAP_MS && close) {
          lastTapAt = 0;
          if (Math.abs(scale - defaultScale) > 0.08) {
            applyDefault();
          } else {
            userAdjusted = true;
            zoomAt(t.clientX, t.clientY, Math.min(MAX_SCALE, scale * 2));
          }
          return;
        }
        lastTapAt = now;
        lastTapX = t.clientX;
        lastTapY = t.clientY;
      }
    }
  }

  // ── PC: 휠 확대/축소 + 마우스 따라가기 + (따라가기 OFF 시) 드래그 이동 ──────────
  function onWheel(e) {
    // 스테이지 위 휠 = 확대/축소 (페이지 스크롤 방지)
    e.preventDefault();
    userAdjusted = true;
    const step = e.ctrlKey ? 1.04 : 1.12;
    const factor = e.deltaY < 0 ? step : 1 / step;
    mouse = { x: e.clientX, y: e.clientY };
    zoomAt(e.clientX, e.clientY, scale * factor);
    startFollow();
  }

  function followTarget() {
    const { rect } = contentSize();
    const { maxX, maxY } = bounds();
    const mx = clamp((mouse.x - rect.left) / (rect.width || 1), 0, 1);
    const my = clamp((mouse.y - rect.top) / (rect.height || 1), 0, 1);
    return { x: (0.5 - mx) * 2 * maxX, y: (0.5 - my) * 2 * maxY };
  }

  function startFollow() {
    if (followRaf || !followMouse || !mouse || scale <= 1.01 || mouseDrag) return;
    const tick = () => {
      followRaf = 0;
      if (!followMouse || !mouse || scale <= 1.01 || mouseDrag) return;
      const g = followTarget();
      const dx = g.x - tx;
      const dy = g.y - ty;
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
        tx = g.x;
        ty = g.y;
        apply();
        return; // 수렴 — mousemove 가 오면 다시 시작
      }
      tx += dx * 0.22;
      ty += dy * 0.22;
      apply();
      followRaf = requestAnimationFrame(tick);
    };
    followRaf = requestAnimationFrame(tick);
  }

  function onMouseMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    mouse = { x: e.clientX, y: e.clientY };
    if (mouseDrag) {
      tx = mouseDrag.tx + (e.clientX - mouseDrag.x);
      ty = mouseDrag.ty + (e.clientY - mouseDrag.y);
      userAdjusted = true;
      scheduleApply();
      return;
    }
    if (followMouse && scale > 1.01) startFollow();
  }

  function onMouseDown(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (e.button !== 0 || scale <= 1.01 || followMouse) return;
    if (e.target.closest?.('.ym-zoom-ui')) return;
    mouseDrag = { x: e.clientX, y: e.clientY, tx, ty };
    stageEl.classList.add('is-dragging');
  }

  function onMouseUp() {
    if (!mouseDrag) return;
    mouseDrag = null;
    stageEl.classList.remove('is-dragging');
  }

  function onMouseLeave() {
    // 마우스가 스테이지를 벗어나면 마지막 위치 유지
    mouse = null;
  }

  function onDblClick(e) {
    if (e.target.closest?.('.ym-zoom-ui')) return;
    if (scale > 1.01) {
      setScaleAnimated(1);
    } else {
      userAdjusted = true;
      zoomAt(e.clientX, e.clientY, 2.2);
      mouse = { x: e.clientX, y: e.clientY };
      startFollow();
    }
  }

  // ── 크기/방향/메타데이터 변화 대응 ─────────────────────────────────────────
  function onLayoutChange() {
    if (!userAdjusted) {
      applyDefault();
    } else {
      clampPan();
      apply();
    }
  }

  const opts = { passive: false };
  stageEl.addEventListener('touchstart', onTouchStart, opts);
  stageEl.addEventListener('touchmove', onTouchMove, opts);
  stageEl.addEventListener('touchend', onTouchEnd, opts);
  stageEl.addEventListener('touchcancel', onTouchEnd, opts);
  stageEl.addEventListener('wheel', onWheel, opts);
  stageEl.addEventListener('pointermove', onMouseMove);
  stageEl.addEventListener('pointerdown', onMouseDown);
  stageEl.addEventListener('pointerleave', onMouseLeave);
  stageEl.addEventListener('dblclick', onDblClick);
  window.addEventListener('pointerup', onMouseUp);
  window.addEventListener('resize', onLayoutChange);
  window.addEventListener('orientationchange', onLayoutChange);
  const videoEl = stageEl.querySelector('video');
  videoEl?.addEventListener('loadedmetadata', onLayoutChange);
  videoEl?.addEventListener('resize', onLayoutChange);

  // 스테이지가 처음 표시되거나 크기가 바뀔 때(예: hidden 해제) 기본 배율 재계산
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onLayoutChange());
    ro.observe(stageEl);
  }

  buildUi();
  applyDefault();

  return {
    reset,
    applyDefault,
    setScale,
    getScale: () => scale,
    /** 호스트 화면에 보이는 전체 얼굴 수(호스트 포함) — 모바일 기본 배율 계산에 사용 */
    setFaceCount(n) {
      const next = Math.max(0, Number(n) || 0);
      if (next === faceCount) return;
      faceCount = next;
      // 사용자가 직접 조절하지 않은 경우에만 기본 배율을 갱신
      if (!userAdjusted || Math.abs(scale - defaultScale) < 0.05) {
        applyDefault();
      } else {
        defaultScale = computeDefaultScale();
      }
    },
    destroy() {
      stageEl.removeEventListener('touchstart', onTouchStart);
      stageEl.removeEventListener('touchmove', onTouchMove);
      stageEl.removeEventListener('touchend', onTouchEnd);
      stageEl.removeEventListener('touchcancel', onTouchEnd);
      stageEl.removeEventListener('wheel', onWheel);
      stageEl.removeEventListener('pointermove', onMouseMove);
      stageEl.removeEventListener('pointerdown', onMouseDown);
      stageEl.removeEventListener('pointerleave', onMouseLeave);
      stageEl.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('pointerup', onMouseUp);
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('orientationchange', onLayoutChange);
      videoEl?.removeEventListener('loadedmetadata', onLayoutChange);
      videoEl?.removeEventListener('resize', onLayoutChange);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (followRaf) cancelAnimationFrame(followRaf);
      cancelAnimationFrame(animRaf);
      ui?.remove();
      scale = 1; tx = 0; ty = 0;
      apply();
    },
  };
}
