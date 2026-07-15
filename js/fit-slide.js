/**
 * 슬라이드를 화면에 비율 유지(contain)로 최대 크기로 맞추고,
 * pptx-preview 내부 스크롤을 제거합니다.
 * scale = min(가로비, 세로비) → 한쪽이 먼저 닿으면 반대쪽 확대 중지.
 */
export function killInnerScroll(root) {
  if (!root) return;
  const targets = [
    root,
    ...root.querySelectorAll('.pptx-preview-wrapper, [class*="pptx-preview-slide-wrapper"]'),
  ];
  targets.forEach((el) => {
    el.style.setProperty('overflow', 'hidden', 'important');
    el.style.setProperty('overflow-x', 'hidden', 'important');
    el.style.setProperty('overflow-y', 'hidden', 'important');
    if (el.scrollLeft) el.scrollLeft = 0;
    if (el.scrollTop) el.scrollTop = 0;
  });
}

export function fitSlideToStage({
  stage,
  fit,
  scaler,
  container,
  slideWidth = 960,
  slideHeight = 540,
}) {
  if (!stage || !fit || !scaler || !container) return 1;

  // 스테이지가 실제로 차지하는 영역 (툴바 아래 stage-area)
  let availW = stage.clientWidth;
  let availH = stage.clientHeight;

  // 아직 레이아웃 전이면 stage-area / 창 크기 사용
  if (availW < 8 || availH < 8) {
    const area = stage.parentElement || document.querySelector('.stage-area');
    if (area) {
      availW = Math.max(availW, area.clientWidth);
      availH = Math.max(availH, area.clientHeight);
    }
  }
  if (availW < 8 || availH < 8) {
    availW = window.innerWidth || 960;
    availH = Math.max(120, (window.innerHeight || 540) - 56);
  }

  // 아주 작은 여백 없이 최대 채움 (스크롤만 나지 않게)
  const pad = 0;
  availW = Math.max(1, availW - pad);
  availH = Math.max(1, availH - pad);

  const scale = Math.min(availW / slideWidth, availH / slideHeight);
  const safeScale = Number.isFinite(scale) && scale > 0.01 ? scale : 1;
  const displayW = Math.max(1, Math.round(slideWidth * safeScale));
  const displayH = Math.max(1, Math.round(slideHeight * safeScale));

  fit.style.boxSizing = 'border-box';
  fit.style.width = `${displayW}px`;
  fit.style.height = `${displayH}px`;
  fit.style.maxWidth = `${availW}px`;
  fit.style.maxHeight = `${availH}px`;
  fit.style.overflow = 'hidden';
  fit.style.position = 'relative';
  fit.style.margin = '0';
  fit.style.flexShrink = '0';
  fit.style.background = '#000';

  scaler.style.position = 'absolute';
  scaler.style.top = '0';
  scaler.style.left = '0';
  scaler.style.width = `${slideWidth}px`;
  scaler.style.height = `${slideHeight}px`;
  scaler.style.transformOrigin = '0 0';
  scaler.style.transform = `scale(${safeScale})`;
  scaler.style.overflow = 'hidden';
  scaler.style.margin = '0';
  scaler.style.padding = '0';

  container.style.width = `${slideWidth}px`;
  container.style.height = `${slideHeight}px`;
  container.style.overflow = 'hidden';
  container.style.transform = 'none';
  container.style.margin = '0';
  container.style.padding = '0';
  container.style.background = '#fff';

  killInnerScroll(scaler);
  killInnerScroll(container);

  return safeScale;
}
