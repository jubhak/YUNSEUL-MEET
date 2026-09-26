/**
 * video-freeze-watchdog.js
 * 실시간 WebRTC 비디오 스트림 멈춤(Freeze) / 끊김 자동 감지 및 안전 복구 워치독
 * - 정지 화면(슬라이드·카메라 대기)을 정상 상태로 인식하여 오작동 차단
 * - video.srcObject = null 등의 파괴적 디코더 리셋 차단 (깜빡임·렉 제거)
 * - 실제 네트워크 패킷 단절(track.muted === true) 시에만 최소 4초 간격 키프레임 요청
 */
export function attachVideoFreezeWatchdog(videoEl, {
  label = 'video',
  onRequestKeyFrame = null,
  onDecoderKick = null,
  onFullRecover = null,
  checkIntervalMs = 1500,
} = {}) {
  if (!videoEl || videoEl._hasFreezeWatchdog) return;
  videoEl._hasFreezeWatchdog = true;

  let lastTime = -1;
  let freezeCount = 0;
  let lastKeyFrameTime = 0;

  const onWaitingOrStalled = () => {
    if (!videoEl.isConnected) return;
    videoEl.play?.().catch(() => {});
    const now = Date.now();
    if (now - lastKeyFrameTime > 3000) {
      lastKeyFrameTime = now;
      try { onRequestKeyFrame?.(); } catch { /* ignore */ }
    }
  };

  videoEl.addEventListener('waiting', onWaitingOrStalled);
  videoEl.addEventListener('stalled', onWaitingOrStalled);

  const onVisChange = () => {
    if (document.visibilityState === 'visible' && videoEl.isConnected) {
      if (videoEl.paused) videoEl.play?.().catch(() => {});
      const now = Date.now();
      if (now - lastKeyFrameTime > 2500) {
        lastKeyFrameTime = now;
        try { onRequestKeyFrame?.(); } catch { /* ignore */ }
      }
    }
  };
  document.addEventListener('visibilitychange', onVisChange);

  const timer = setInterval(() => {
    // DOM에서 제거된 경우 타이머 및 이벤트 리스너 자동 정리
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

    // 브라우저 백그라운드 탭 또는 정책으로 인한 일시정지 안전 해제
    if (videoEl.paused) {
      videoEl.play?.().catch(() => {});
    }

    const now = Date.now();

    // 1. 네트워크 패킷 단절 감지 (WebRTC 표준 track.muted === true)
    if (liveTrack.muted) {
      freezeCount++;
      // 패킷이 약 3초(2틱) 이상 끊겨 음소거된 경우 키프레임 1회 요청
      if (freezeCount >= 2 && now - lastKeyFrameTime > 4000) {
        lastKeyFrameTime = now;
        console.warn(`[FreezeWatchdog] ${label} 패킷 일시 중단 감지 -> 키프레임 복구 요청`);
        try { onRequestKeyFrame?.(); } catch { /* ignore */ }
        videoEl.play?.().catch(() => {});
      }
      return;
    }

    // 2. 패킷이 정상 도착 중이면 freezeCount 리셋
    const cur = videoEl.currentTime;
    if (cur > 0 && cur === lastTime) {
      // 프레젠테이션 정지 슬라이드는 정상 상태이므로 최소 10초(7틱) 이상 지속 시에만 부드러운 play() 및 키프레임 1회 시도
      freezeCount++;
      if (freezeCount >= 7) {
        if (now - lastKeyFrameTime > 5000) {
          lastKeyFrameTime = now;
          try { onRequestKeyFrame?.(); } catch { /* ignore */ }
        }
        videoEl.play?.().catch(() => {});
      }
    } else {
      lastTime = cur;
      freezeCount = 0;
    }
  }, checkIntervalMs);

  videoEl._freezeWatchdogTimer = timer;
}
