/**
 * ES 모듈 소비자용 래퍼.
 * 실제 UI는 js/progress-bar.js (일반 스크립트) 가 window.YunseulProgress 로 제공합니다.
 * progress-bar.js 가 먼저 로드되어야 합니다.
 */
function api() {
  const p = window.YunseulProgress;
  if (!p) {
    console.warn('[progress] YunseulProgress 미로드 — progress-bar.js 를 먼저 넣어 주세요');
    return null;
  }
  return p;
}

export function showProgress(title) {
  return api()?.showProgress(title);
}
export function hideProgress() {
  return api()?.hideProgress();
}
export function setProgress(percent, label) {
  return api()?.setProgress(percent, label);
}
export function setStage(stageKey, extraLabel) {
  return api()?.setStage(stageKey, extraLabel);
}
export function progressFromMessage(msg) {
  return api()?.progressFromMessage(msg);
}
export function progressError(message) {
  return api()?.progressError(message);
}

export default {
  showProgress,
  hideProgress,
  setProgress,
  setStage,
  progressFromMessage,
  progressError,
};
