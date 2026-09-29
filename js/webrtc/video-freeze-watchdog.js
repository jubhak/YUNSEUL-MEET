/**
 * video-freeze-watchdog.js
 * 실시간 WebRTC 비디오 스트림 멈춤(Freeze) / 끊김 자동 감지 및 안전 복구 워치독
 * - 얼굴(cam) 모드는 저프레임이라 키프레임 복구를 더 빠르게
 * - video.srcObject = null 등 파괴적 디코더 리셋 차단
 */
export function attachVideoFreezeWatchdog(videoEl, {
  label = 'video',
  onRequestKeyFrame = null,
  onDecoderKick = null,
  onFullRecover = null,
  checkIntervalMs = 1500,
  /** 'face' | 'display' — face는 빠른 PLI */
  mode = 'display',
} = {}) {
  if (!videoEl || videoEl._hasFreezeWatchdog) return;
  videoEl._hasFreezeWatchdog = true;

  const isFace = mode === 'face';
  const interval = isFace ? Math.min(checkIntervalMs, 1000) : checkIntervalMs;
  // PLI를 너무 자주 보내면 인코더가 키프레임만 만들다 오히려 10초급 정지 진동이 남
  // 10인 동시 접속에서는 인코더가 키프레임을 자주 만들 수 없다(만들면 대역폭 폭증).
  // 따라서 "정지 판정"은 빠르게 하고, 완전 복구(full recover)를 단계적으로 올린다.
  const keyframeCooldownMs = isFace ? 3500 : 3000;
  const mutedTicksBeforePli = isFace ? 2 : 2;
  const stuckTicksBeforePli = isFace ? 3 : 4;

  let lastTime = -1;
  let freezeCount = 0;
  let lastKeyFrameTime = 0;
  let recoverAttempts = 0;
  const escalate = () => {
    recoverAttempts += 1;
    if (recoverAttempts >= 2) {
      recoverAttempts = 0;
      console.warn(`[FreezeWatchdog] ${label} 정지 지속 감지 -> 자가 치유(onFullRecover) 실행`);
      try { onFullRecover?.(); } catch { /* ignore */ }
    }
  };

  const requestKf = () => {
    const now = Date.now();
    if (now - lastKeyFrameTime < keyframeCooldownMs) return;
    lastKeyFrameTime = now;
    try { onRequestKeyFrame?.(); } catch { /* ignore */ }
  };

  const onWaitingOrStalled = () => {
    if (!videoEl.isConnected) return;
    videoEl.play?.().catch(() => {});
    requestKf();
  };

  videoEl.addEventListener('waiting', onWaitingOrStalled);
  videoEl.addEventListener('stalled', onWaitingOrStalled);

  const onVisChange = () => {
    if (document.visibilityState === 'visible' && videoEl.isConnected) {
      if (videoEl.paused) videoEl.play?.().catch(() => {});
      requestKf();
    }
  };
  document.addEventListener('visibilitychange', onVisChange);

  const timer = setInterval(() => {
    if (!videoEl.isConnected) {
      clearInterval(timer);
      videoEl._hasFreezeWatchdog = false;
      videoEl.removeEventListener('waiting', onWaitingOrStalled);
      videoEl.removeEventListener('stalled', onWaitingOrStalled);
      document.removeEventListener('visibilitychange', onVisChange);
      return;
    }

    const stream = videoEl.srcObject;
    if (!stream) {
      freezeCount = 0;
      return;
    }

    const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    const liveTrack = tracks.find((t) => t && t.readyState === 'live' && t.enabled !== false);
    if (!liveTrack) {
      freezeCount = 0;
      return;
    }

    // 의도적 element pause(스크롤 밖)는 건드리지 않음
    const card = videoEl.closest?.('.participant-card');
    const offscreenPaused = !!(card && videoEl.paused && card.dataset.hasCam === '1'
      && card.getBoundingClientRect().bottom < 0);
    if (videoEl.paused && !offscreenPaused) {
      videoEl.play?.().catch(() => {});
    }

    if (liveTrack.muted) {
      freezeCount++;
      if (freezeCount >= mutedTicksBeforePli) {
        console.warn(`[FreezeWatchdog] ${label} 패킷 일시 중단 -> 키프레임`);
        requestKf();
        videoEl.play?.().catch(() => {});
        if (freezeCount >= mutedTicksBeforePli + 2) escalate();
      }
      return;
    }

    const cur = videoEl.currentTime;
    if (cur > 0 && cur === lastTime) {
      freezeCount++;
      if (freezeCount >= stuckTicksBeforePli) {
        requestKf();
        if (!offscreenPaused) videoEl.play?.().catch(() => {});
        if (freezeCount >= stuckTicksBeforePli + 2) escalate();
      }
    } else {
      lastTime = cur;
      freezeCount = 0;
      recoverAttempts = 0;
    }
  }, interval);

  videoEl._freezeWatchdogTimer = timer;
}
