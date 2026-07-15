import { OverlayManager } from './overlay-manager.js?v=20260715ab';
import { DrawCanvas } from './draw-canvas.js?v=20260715u';
import { RoomSync } from './sync.js?v=20260715aj';
import { goToSlide, getPptEngine } from './host-ppt-loader.js?v=20260715ah';
import { findHttpLinkAt, findVideoHitAt } from './link-utils.js?v=20260715z';
import { setViewerCount, setupViewersPanel } from './viewers-panel.js?v=20260715f';
import { WebrtcSignaling } from './webrtc/signaling.js?v=20260715j';
import { HostPublisher } from './webrtc/host-publisher.js?v=20260715at';

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || sessionStorage.getItem('roomCode') || '').toUpperCase();
const hostToken = sessionStorage.getItem('hostToken');

if (!roomCode || !hostToken) {
  window.location.href = './';
}

document.getElementById('room-code').textContent = roomCode;
setupViewersPanel();

let sync = null;
let webrtcPublisher = null;
let knownViewerIds = new Set();
const uploadStatus = document.getElementById('upload-status');
const btnStream = document.getElementById('btn-stream');
const btnPen = document.getElementById('btn-pen');
const btnAvSpeaker = document.getElementById('btn-av-speaker');
const btnAvMic = document.getElementById('btn-av-mic');
const streamOptionsGate = document.getElementById('stream-options-gate');
const optStreamMic = document.getElementById('opt-stream-mic');
const btnStreamStart = document.getElementById('btn-stream-start');
const btnStreamCancel = document.getElementById('btn-stream-cancel');

const MIC_PREF_KEY = 'yunseulStreamMic';
const TAB_AUDIO_PREF_KEY = 'yunseulStreamTabAudio';

let preferTabAudio = sessionStorage.getItem(TAB_AUDIO_PREF_KEY) !== '0';
let preferMic = sessionStorage.getItem(MIC_PREF_KEY) === '1';

function setStatus(msg) {
  if (uploadStatus && msg) uploadStatus.textContent = msg;
}

function syncPenUi(active) {
  if (!btnPen) return;
  btnPen.classList.toggle('is-active', !!active);
  btnPen.setAttribute('aria-pressed', active ? 'true' : 'false');
  btnPen.title = active
    ? '펜 끄기 — 일반 커서 · 링크/영상 클릭 가능'
    : '펜 켜기 — 펜 커서 · 그리기';
  clearLinkHoverCursor();
}

function syncAvButtons() {
  const tabOn = webrtcPublisher?.isActive
    ? (webrtcPublisher.hasTabAudio ? webrtcPublisher.tabAudioEnabled : preferTabAudio)
    : preferTabAudio;
  const micOn = webrtcPublisher?.isActive
    ? (webrtcPublisher.hasMic ? webrtcPublisher.micEnabled : preferMic)
    : preferMic;

  if (btnAvSpeaker) {
    btnAvSpeaker.classList.toggle('is-active', !!tabOn);
    btnAvSpeaker.setAttribute('aria-pressed', tabOn ? 'true' : 'false');
    btnAvSpeaker.title = tabOn
      ? '탭 소리(PPT·동영상) 켜짐'
      : '탭 소리(PPT·동영상) 꺼짐';
  }
  if (btnAvMic) {
    btnAvMic.classList.toggle('is-active', !!micOn);
    btnAvMic.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    btnAvMic.title = micOn ? '마이크 켜짐' : '마이크 꺼짐';
  }
  if (optStreamMic) optStreamMic.checked = !!preferMic;
}

function updateStreamUi(active, withMic = false) {
  if (!btnStream) return;
  btnStream.textContent = active ? '정지' : '송출';
  btnStream.classList.toggle('btn-danger', !!active);
  btnStream.classList.toggle('btn-primary', !active);
  btnStream.title = active
    ? (withMic ? '화면·마이크 송출 중지' : '화면 송출 중지')
    : '참가자에게 화면 송출';
  btnStream.disabled = false;
  syncAvButtons();
}

function openStreamOptions() {
  if (!sync?.socket || !webrtcPublisher) {
    alert('방에 아직 연결되지 않았습니다.');
    return;
  }
  syncAvButtons();
  streamOptionsGate?.classList.remove('hidden');
}

function closeStreamOptions() {
  streamOptionsGate?.classList.add('hidden');
}

async function startScreenShare() {
  const withMic = !!optStreamMic?.checked;
  // 탭 소리는 브라우저「탭 오디오도 허용」에서 결정 — 툴바 스피커는 시작 후 mute용
  const withTabAudio = preferTabAudio !== false;
  preferMic = withMic;
  sessionStorage.setItem(MIC_PREF_KEY, withMic ? '1' : '0');
  closeStreamOptions();

  if (btnStream) {
    btnStream.disabled = true;
    btnStream.textContent = '공유 창 선택…';
  }
  try {
    await webrtcPublisher.startDisplayCapture({ withMic, withTabAudio });
    updateStreamUi(true, (webrtcPublisher.kinds || []).includes('mic'));
    const ids = [...knownViewerIds];
    if (ids.length) await webrtcPublisher.publishTo(ids);
  } catch (err) {
    console.warn('[stream]', err);
    updateStreamUi(false);
    alert(err?.message?.includes('Permission') || err?.name === 'NotAllowedError'
      ? '화면 공유가 취소되었습니다. 「송출」을 다시 눌러 주세요.'
      : (`화면 송출을 시작할 수 없습니다.\n${err?.message || ''}`));
  } finally {
    if (btnStream && !webrtcPublisher?.isActive) {
      btnStream.disabled = false;
      btnStream.textContent = '송출';
    }
    syncAvButtons();
  }
}

function stopScreenShare() {
  webrtcPublisher?.stop();
  updateStreamUi(false);
}

async function toggleTabAudio() {
  preferTabAudio = !preferTabAudio;
  sessionStorage.setItem(TAB_AUDIO_PREF_KEY, preferTabAudio ? '1' : '0');
  if (webrtcPublisher?.isActive) {
    webrtcPublisher.setTabAudioEnabled(preferTabAudio);
    if (preferTabAudio && !webrtcPublisher.hasTabAudio) {
      // 송출 시작 때 탭 오디오를 안 켠 경우 — 재송출 필요
      alert('탭 오디오는 「송출」을 다시 시작할 때 켤 수 있습니다. (공유 창에서 탭 오디오 허용)');
      preferTabAudio = false;
      sessionStorage.setItem(TAB_AUDIO_PREF_KEY, '0');
      webrtcPublisher.tabAudioWanted = false;
    }
  }
  syncAvButtons();
}

async function toggleMic() {
  preferMic = !preferMic;
  sessionStorage.setItem(MIC_PREF_KEY, preferMic ? '1' : '0');
  if (webrtcPublisher?.isActive) {
    if (preferMic) {
      const ok = await webrtcPublisher.ensureMic(true);
      if (!ok) {
        preferMic = false;
        sessionStorage.setItem(MIC_PREF_KEY, '0');
        alert('마이크 권한을 허용해 주세요.');
      }
    } else {
      webrtcPublisher.setMicEnabled(false);
    }
  }
  syncAvButtons();
}

btnStream?.addEventListener('click', () => {
  if (webrtcPublisher?.isActive) stopScreenShare();
  else openStreamOptions();
});

btnStreamCancel?.addEventListener('click', () => closeStreamOptions());
btnStreamStart?.addEventListener('click', () => startScreenShare());

optStreamMic?.addEventListener('change', () => {
  preferMic = !!optStreamMic.checked;
  sessionStorage.setItem(MIC_PREF_KEY, preferMic ? '1' : '0');
  syncAvButtons();
});

btnAvSpeaker?.addEventListener('click', () => { toggleTabAudio(); });
btnAvMic?.addEventListener('click', () => { toggleMic(); });

streamOptionsGate?.addEventListener('click', (e) => {
  if (e.target === streamOptionsGate) closeStreamOptions();
});

syncAvButtons();

const overlayManager = new OverlayManager({
  isHost: true,
  onCloseLink: () => sync?.emit('close-link'),
  onCloseVideo: () => sync?.emit('close-video'),
  onVideoControl: (data) => sync?.emit('video-control', data),
  onCloseAudio: () => sync?.emit('close-audio'),
  onAudioControl: (data) => sync?.emit('audio-control', data),
  onVideoDrawSurface: ({ active, canvas }) => {
    const dc = window.__yunseulDrawCanvas;
    if (!dc?.setVideoSurface) return;
    dc.setVideoSurface(active ? canvas : null);
    if (active) {
      requestAnimationFrame(() => dc.resizeOverlaySurface?.() || dc.resizeVideoSurface?.());
    }
  },
  onLinkDrawSurface: ({ active, canvas }) => {
    const dc = window.__yunseulDrawCanvas;
    if (!dc?.setLinkSurface) return;
    dc.setLinkSurface(active ? canvas : null);
    if (active) {
      requestAnimationFrame(() => dc.resizeOverlaySurface?.());
    }
  },
  onPenModeChange: (active) => syncPenUi(active),
});

btnPen?.addEventListener('click', () => {
  overlayManager.setPenMode(!overlayManager.isPenMode);
});

function openSyncedLink(data) {
  if (!data?.url) return;
  overlayManager.closeVideo(true);
  overlayManager.showLink(data.url, data.title || data.url);
  sync?.emit('open-link', { url: data.url, title: data.title || data.url });
}

async function openSyncedVideo(data) {
  if (!data?.name && !data?.url) return;
  const engine = getPptEngine();
  let url = data.url;
  try {
    if (engine?.resolveVideoUrl && data.name) {
      url = (await engine.resolveVideoUrl(data.name)) || url;
    }
    if (!url) return;
    overlayManager.closeLink(true);
    overlayManager.pauseAudioOnly();
    sync?.emit('audio-control', { action: 'pause', currentTime: overlayManager.syncAudio?.currentTime || 0 });
    overlayManager.showVideo(url);
    sync?.emit('play-video', { name: data.name, currentTime: 0 });
  } finally {
    try {
      window.YunseulProgress?.hideProgress?.();
    } catch { /* ignore */ }
  }
}

async function syncSlideAudio(slideIndex) {
  const engine = getPptEngine();
  const audios = engine?.metadata?.slides?.[slideIndex]?.audios || [];

  if (!audios.length) {
    // 가로지르는 배경음이면 유지·재개
    if (overlayManager._audioAcross && overlayManager.syncAudio?.getAttribute('src')) {
      overlayManager.resumeAudioIfAcross();
      sync?.emit('audio-control', {
        action: 'play',
        currentTime: overlayManager.syncAudio.currentTime || 0,
        name: overlayManager._audioName,
      });
      return;
    }
    overlayManager.closeAudio(true);
    return;
  }

  const a = audios[0];
  // 같은 across BGM이면 재시작하지 않고 재생 유지/재개
  if (
    overlayManager._audioAcross &&
    overlayManager._audioName === a.name &&
    overlayManager.syncAudio?.getAttribute('src')
  ) {
    overlayManager.resumeAudioIfAcross();
    sync?.emit('audio-control', {
      action: 'play',
      currentTime: overlayManager.syncAudio.currentTime || 0,
      name: a.name,
    });
    return;
  }

  const url = await engine.resolveVideoUrl(a.name);
  if (!url) return;

  overlayManager.showAudio(url, {
    name: a.name,
    currentTime: 0,
    loop: !!a.loop || !!a.across,
    across: !!a.across,
  });
  sync?.emit('play-audio', {
    name: a.name,
    currentTime: 0,
    loop: !!a.loop || !!a.across,
    across: !!a.across,
  });
}

function clearLinkHoverCursor() {
  const canvas = document.getElementById('draw-canvas');
  canvas?.classList.remove('is-over-link');
  document.getElementById('slide-hotspot-glow')?.remove();
}

function updateLinkHoverCursor(clientX, clientY) {
  // 펜 ON이면 항상 펜 커서 — 링크 커서/클릭 힌트 없음
  if (overlayManager.isPenMode || document.body.classList.contains('pen-mode')) {
    clearLinkHoverCursor();
    return;
  }
  const canvas = document.getElementById('draw-canvas');
  if (!canvas) return;
  const link = findHttpLinkAt(clientX, clientY, canvas);
  if (link) {
    canvas.classList.add('is-over-link');
    return;
  }
  // 영상: 넓은 영역 폴백 없이 실제 요소 위에만 손 모양
  const engine = getPptEngine();
  const hit = findVideoHitAt(clientX, clientY, canvas, engine);
  if (hit?.el) {
    canvas.classList.add('is-over-link');
    return;
  }
  canvas.classList.remove('is-over-link');
}

const drawCanvas = new DrawCanvas(document.getElementById('draw-canvas'), {
  isHost: true,
  onStrokeStart: (data) => sync?.emit('draw-start', data),
  onStrokeMove: (data) => sync?.emit('draw-move', data),
  onStrokeEnd: (data) => sync?.emit('draw-end', data),
  onPointerHover: ({ clientX, clientY }) => updateLinkHoverCursor(clientX, clientY),
  onPointerLeave: () => clearLinkHoverCursor(),
  onTap: async ({ clientX, clientY }) => {
    // 펜 활성 중에는 링크/영상 열지 않음
    if (overlayManager.isPenMode || document.body.classList.contains('pen-mode')) return;
    const canvas = document.getElementById('draw-canvas');
    const link = findHttpLinkAt(clientX, clientY, canvas);
    if (link) {
      openSyncedLink(link);
      return;
    }
    const engine = getPptEngine();
    const hit = findVideoHitAt(clientX, clientY, canvas, engine);
    if (hit?.name) {
      await openSyncedVideo({ name: hit.name });
    }
  },
});
window.__yunseulDrawCanvas = drawCanvas;

// 기본: 펜 활성화 (펜 커서 · 그리기 ON · 링크 클릭 불가)
overlayManager.setPenMode(true);
syncPenUi(true);

window.addEventListener('ppt-link-click', (e) => {
  openSyncedLink(e.detail);
});

window.addEventListener('ppt-video-click', (e) => {
  openSyncedVideo(e.detail);
});

window.addEventListener('ppt-slide-change', (e) => {
  // 슬라이드 바꾸면 동영상/링크 닫고 동기화 (참가자 화면 멈춤 방지)
  overlayManager.closeVideo(true);
  overlayManager.closeLink(true);
  const idx = e.detail?.slideIndex;
  if (idx != null) {
    drawCanvas.setSlide(idx);
    sync?.emit('slide-change', { slideIndex: idx });
    syncSlideAudio(idx).catch((err) => console.warn('[slide-audio]', err));
  }
});

window.addEventListener('ppt-before-reload', () => {
  overlayManager.closeVideo(true);
  overlayManager.closeLink(true);
  overlayManager.closeAudio?.(true);
  drawCanvas.clearAll();
  clearLinkHoverCursor();
});

window.addEventListener('ppt-ready', (e) => {
  const engine = getPptEngine();
  if (engine) {
    const size = engine.getSlideSize();
    drawCanvas.setSlideSize(size.width, size.height);
    drawCanvas.resize();
    drawCanvas.setSlide(0);
    syncSlideAudio(0).catch((err) => console.warn('[slide-audio]', err));
  }
  document.getElementById('btn-reload-ppt')?.style.setProperty('display', '');
  btnStream?.classList.remove('hidden');
  if (btnStream && !webrtcPublisher?.isActive) {
    btnStream.title = '참가자에게 화면 송출';
  }
  if (e.detail?.reloaded) {
    drawCanvas.clearAll();
    sync?.emit('clear-all-drawings');
    sync?.emit('slide-change', { slideIndex: 0 });
  }
});

document.getElementById('btn-reload-ppt')?.addEventListener('click', () => {
  if (window.YunseulUpload?.isBusy?.()) {
    alert('이미 업로드/로딩 중입니다. 잠시만 기다려 주세요.');
    return;
  }
  const ok = confirm('다른 PPTX 파일로 바꿀까요?\n현재 낙서는 지워지고 첫 슬라이드부터 다시 시작합니다.');
  if (!ok) return;
  if (!window.YunseulUpload?.pickPptFile?.()) {
    document.getElementById('file-input')?.click();
  }
});

// 메타·미디어 백그라운드 준비 완료 → BGM/오디오 재동기화
window.addEventListener('ppt-enriched', () => {
  const engine = getPptEngine();
  const idx = engine?.getCurrentSlide?.() ?? 0;
  syncSlideAudio(idx).catch((err) => console.warn('[slide-audio]', err));
});

document.getElementById('pen-color').addEventListener('input', (e) => {
  drawCanvas.setPenColor(e.target.value);
});
document.getElementById('pen-size').addEventListener('input', (e) => {
  drawCanvas.setPenSize(parseInt(e.target.value, 10));
});
document.getElementById('btn-eraser').addEventListener('click', () => {
  drawCanvas.setEraser(true);
});
document.getElementById('btn-clear-slide').addEventListener('click', () => {
  const engine = getPptEngine();
  const idx = engine ? engine.getCurrentSlide() : 0;
  drawCanvas.clearSlide(idx);
  sync?.emit('clear-drawings', { slideIndex: idx });
});
document.getElementById('btn-clear-all').addEventListener('click', () => {
  drawCanvas.clearAll();
  sync?.emit('clear-all-drawings');
});

sync = new RoomSync({
  code: roomCode,
  role: 'host',
  hostToken,
  onEvent: (type, payload) => {
    if (type === 'viewer-count') {
      setViewerCount(payload.count ?? 0, payload.viewers);
      (payload.viewers || []).forEach((v) => {
        if (v?.id) knownViewerIds.add(v.id);
      });
    }
  },
  // 재연결 후 송출 FLAG만 다시 올림 (피어 재생성 없음 — peer-joined가 처리)
  onRejoined: () => {
    if (webrtcPublisher?.isActive) {
      webrtcPublisher.signaling.setStreamStatus({
        active: true,
        kinds: webrtcPublisher.kinds || ['display'],
      });
    }
  },
  onError: (msg) => console.warn(msg),
});

sync.start()
  .then((data) => {
    setViewerCount(data.state?.viewerCount ?? 0, data.state?.viewers);
    (data.state?.viewers || []).forEach((v) => {
      if (v?.id) knownViewerIds.add(v.id);
    });
    if (data.drawings) drawCanvas.loadStrokes(data.drawings);
    if (data.state?.presentation && getPptEngine()) {
      goToSlide(data.state.currentSlide || 0);
      drawCanvas.loadStrokes(data.drawings || {});
    }

    const signaling = new WebrtcSignaling(sync.socket, { localClientId: sync.clientId });
    webrtcPublisher = new HostPublisher({
      signaling,
      onStatus: ({ active, withMic, kinds }) => {
        updateStreamUi(!!active, !!withMic || (kinds || []).includes('mic'));
        syncAvButtons();
      },
    });
  })
  .catch((err) => {
    console.warn('방 연결 실패:', err);
  });

// 송출 FLAG 유지: 송출 중이면 주기적으로 TRUE만 재기록
setInterval(() => {
  if (webrtcPublisher?.isActive && sync?.socket?.connected) {
    webrtcPublisher.signaling.setStreamStatus({
      active: true,
      kinds: webrtcPublisher.kinds || ['display'],
    });
  }
}, 5000);

// 폴링 백업 (참가자 수)
setInterval(() => {
  fetch('api/get-room?code=' + encodeURIComponent(roomCode))
    .then((r) => r.json())
    .then((state) => {
      if (state && typeof state.viewerCount === 'number') {
        setViewerCount(state.viewerCount, state.viewers);
        (state.viewers || []).forEach((v) => {
          if (v?.id) knownViewerIds.add(v.id);
        });
      }
    })
    .catch(() => {});
}, 3000);

window.addEventListener('beforeunload', () => {
  // 참가자가 검정 화면에 남지 않도록 FLAG를 먼저 내림
  try {
    if (sync?.socket?.connected) {
      sync.socket.emit('stream-status', { active: false, kinds: [] });
    }
  } catch { /* ignore */ }
  try { webrtcPublisher?.dispose(); } catch { /* ignore */ }
  sync?.stop();
});

document.getElementById('btn-end-session')?.addEventListener('click', async () => {
  const ok = window.confirm('정말 발표를 종료할까요?\n참가자 화면에도 종료 안내가 표시됩니다.');
  if (!ok) return;

  const btn = document.getElementById('btn-end-session');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '종료…';
  }

  try { webrtcPublisher?.stop(); } catch { /* ignore */ }

  try {
    await sync?.emit('session-end', {
      message: '호스트가 발표를 종료했습니다.',
    });
    await new Promise((r) => setTimeout(r, 400));
  } catch (err) {
    console.warn('종료 이벤트 전송 실패', err);
  }

  try {
    sync?.stop();
  } catch { /* ignore */ }

  sessionStorage.removeItem('hostToken');
  sessionStorage.removeItem('roomCode');
  window.location.href = './';
});
