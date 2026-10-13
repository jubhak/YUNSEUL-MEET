/**
 * 참가자: WebRTC로 호스트 화면을 시청 (화상회의 수신 모드)
 * PPT ZIP/동영상 추출 없음 — 추후 다자 화상 UI를 같은 레이어에 확장 가능
 */
import { RoomSync } from './sync.js?v=20260930a';
import {
  setViewerCount,
  setupViewersPanel,
  setSelectedBroadcaster,
  setSpotlightSpeaker,
} from './viewers-panel.js?v=20261013d';
import { FloatingSpeakerManager } from './floating-speaker-manager.js?v=20261013d';
import { WebrtcSignaling } from './webrtc/signaling.js?v=20260715j';
import { ViewerSubscriber } from './webrtc/viewer-subscriber.js?v=20261013d';
import { setupViewerZoom } from './viewer-zoom.js?v=20261002b';
import { setupChatPanel } from './chat-panel.js?v=20260918fix2';
import { CamFocusManager } from './cam-focus-manager.js?v=20260930a';
import { MicController } from './mic-controller.js?v=20261002b';
import { speakingIndicator } from './speaking-indicator.js?v=20261002b';
import { showToast } from './ui-toast.js?v=20260930a';
import { RemoteControlViewer } from './remote-control.js?v=20260930a';
import { TarotLoungeManager } from './tarot-lounge-manager.js?v=20260930j';
import { DrawCanvas } from './draw-canvas.js?v=20260918pen2';
import { attachVideoFreezeWatchdog } from './webrtc/video-freeze-watchdog.js?v=20260930a';

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || sessionStorage.getItem('roomCode') || '').toUpperCase();
const viewerName = sessionStorage.getItem('viewerName') || '참가자';

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

if (!roomCode) {
  window.location.href = './';
}

document.getElementById('room-code').textContent = roomCode;
setupViewersPanel();

const waitingPanel = document.getElementById('waiting-panel');
const waitingTitle = document.getElementById('waiting-title');
const waitingDesc = document.getElementById('waiting-desc');
const liveStage = document.getElementById('live-stage');
const liveVideo = document.getElementById('live-video');
const viewerDrawCanvasEl = document.getElementById('viewer-draw-canvas');
const syncStatus = document.getElementById('sync-status');
const unmuteBanner = document.getElementById('unmute-banner');
const viewerLinkGate = document.getElementById('viewer-link-gate');
const viewerLinkTitle = document.getElementById('viewer-link-title');
const viewerLinkOpen = document.getElementById('viewer-link-open');
const viewerLinkClose = document.getElementById('viewer-link-close');
const viewerLinkDismiss = document.getElementById('viewer-link-dismiss');
const viewerLinkChip = document.getElementById('viewer-link-chip');

let streamOfflineTimer = null;
let viewerDrawCanvas = null;
if (viewerDrawCanvasEl) {
  viewerDrawCanvas = new DrawCanvas(viewerDrawCanvasEl, {
    isHost: false,
  });
}

if (liveVideo) {
  liveVideo.addEventListener('loadedmetadata', () => viewerDrawCanvas?.resize());
  liveVideo.addEventListener('play', () => viewerDrawCanvas?.resize());
}
window.addEventListener('resize', () => viewerDrawCanvas?.resize());

/** 로컬 줌 — PC 화면 공유일 때만 사용. 영상 회의에서는 끈다. */
const viewerZoom = setupViewerZoom(liveStage);
viewerZoom?.setEnabled?.(false);

let sync = null;
let subscriber = null;
// 진단/자동화 테스트용 (읽기 전용 접근자)
try { window.__ymDebug = { get subscriber() { return subscriber; }, get micCtl() { return micCtl; } }; } catch { /* ignore */ }
let chatPanel = null;
let interactionMode = 'bidirectional';
let requireMic = sessionStorage.getItem('requireMic') === 'true';
let allowClientCamera = true;
let allowClientDeepfake = true;
/** @type {import('./mic-controller.js').MicController|null} */
let micCtl = null;
let rcViewer = null;

/** 호스트가 아직 링크를 열어 둔 동안 유지 */
let activeHostLink = null; // { url, title }
let isMeetingStarted = false;
let currentViewers = [];
let cachedStreamActive = false;
let currentDisplayMode = 'face';

let floatingSpeakerManager = null;
let currentSpotlightSpeaker = {
  id: null,
  name: '호스트',
  role: 'host',
};

function handleSpotlightSpeakerEvent(data) {
  const targetId = data?.clientId || null;
  const targetName = data?.name || '호스트';
  const targetRole = data?.role || 'host';

  currentSpotlightSpeaker = {
    id: targetId,
    name: targetName,
    role: targetRole,
  };

  setSpotlightSpeaker(targetId);
  speakingIndicator.setSpotlightSpeaker(targetId);
  subscriber?.setSpotlightSpeaker?.({
    clientId: targetId,
    name: targetName,
    role: targetRole,
  });

  const isLocalMe = (targetId && targetId === sync?.clientId);
  let stream = null;
  if (isLocalMe) {
    stream = subscriber?.cameraStream || null;
  } else if (subscriber) {
    stream = subscriber.getSpotlightStream?.() || null;
  }

  floatingSpeakerManager?.setSpeaker({
    id: targetId,
    name: targetName,
    role: targetRole,
    stream,
  });
}

floatingSpeakerManager = new FloatingSpeakerManager({
  isHost: false,
});

speakingIndicator.onSpotlightVoice = (isSpeaking, level) => {
  floatingSpeakerManager?.updateVoice(isSpeaking, level);
};

function applyDisplayMode(mode) {
  const next = mode === 'screen' ? 'screen' : 'face';
  currentDisplayMode = next;
  document.body.classList.toggle('display-mode-screen', next === 'screen');
  document.body.classList.toggle('display-mode-face', next === 'face');
  viewerZoom?.setEnabled?.(next === 'screen');
  subscriber?.setCameraIdle?.(next === 'screen');
  floatingSpeakerManager?.setSharingActive(next === 'screen');
}

applyDisplayMode(currentDisplayMode);

function applyRoomPermissions(state) {
  if (!state) return;
  allowClientCamera = state.allowClientCamera !== false;
  allowClientDeepfake = allowClientCamera && (state.allowClientDeepfake !== false);

  const btnAvCam = document.getElementById('btn-av-cam');
  if (btnAvCam) {
    if (!allowClientCamera) {
      // 카메라 불허 방: 참가자에게는 카메라 아이콘 자체를 보여주지 않는다
      btnAvCam.classList.remove('is-active');
      btnAvCam.classList.add('hidden');
      btnAvCam.style.setProperty('display', 'none', 'important');
      // 이미 켜져 있다면 강제 끄기
      if (subscriber?.cameraWanted) {
        subscriber.setCameraEnabled(false).catch(() => {});
      }
    } else {
      btnAvCam.classList.remove('hidden');
      btnAvCam.style.removeProperty('display');
      btnAvCam.style.opacity = '1.0';
      btnAvCam.title = subscriber?.cameraWanted ? '카메라 켜짐 — 클릭하여 끄기' : '카메라 꺼짐 — 클릭하여 켜기';
    }
  }

  const btnFaceEffect = document.getElementById('btn-face-effect');
  if (btnFaceEffect) {
    if (!allowClientDeepfake || !allowClientCamera) {
      btnFaceEffect.classList.add('hidden');
      btnFaceEffect.style.setProperty('display', 'none', 'important');
    }
  }
  if (typeof updateAvatarUi === 'function') updateAvatarUi();
  if (typeof syncAvButtons === 'function') syncAvButtons();
}

function applyInteractionMode(mode, isRequireMic = requireMic) {
  interactionMode = mode === 'unidirectional' ? 'unidirectional' : 'bidirectional';
  requireMic = interactionMode === 'bidirectional' && !!isRequireMic;
  try {
    sessionStorage.setItem('interactionMode', interactionMode);
    sessionStorage.setItem('requireMic', requireMic ? 'true' : 'false');
  } catch { /* ignore */ }
  document.body.classList.toggle('is-unidirectional', interactionMode === 'unidirectional');
  const badge = document.getElementById('mode-badge');
  if (badge) {
    if (interactionMode === 'unidirectional') {
      badge.textContent = '단방향';
      badge.classList.add('is-uni');
      badge.title = '단방향 대규모 시청 — 시청·채팅만 가능';
    } else {
      badge.textContent = requireMic ? '양방향 · 마이크 필수' : '양방향';
      badge.classList.remove('is-uni');
      badge.title = requireMic
        ? '양방향 화상 미팅 (마이크 필수)'
        : '양방향 화상 미팅';
    }
  }
  if (subscriber) {
    subscriber.interactionMode = interactionMode;
    if (interactionMode === 'bidirectional') {
      subscriber.ensureReceiving?.().catch(() => {});
    }
  }
  if (micCtl) {
    if (interactionMode === 'unidirectional') {
      micCtl.setRequireMic(false);
      if (micCtl.enabled) micCtl.disable().catch(() => {});
    } else if (micCtl.requireMic !== requireMic) {
      micCtl.setRequireMic(requireMic);
    }
  }
  if (typeof syncAvButtons === 'function') syncAvButtons();
}

function bindLinkTargets(url) {
  if (!url) return;
  let safe = '';
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') safe = u.href;
  } catch {
    return;
  }
  if (!safe) return;
  [viewerLinkOpen, viewerLinkChip].forEach((el) => {
    if (!el) return;
    el.href = safe;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
  });
}

function showLinkChip() {
  if (!activeHostLink?.url || !viewerLinkChip) return;
  bindLinkTargets(activeHostLink.url);
  viewerLinkChip.classList.remove('hidden');
}

function hideLinkChip() {
  viewerLinkChip?.classList.add('hidden');
}

function showViewerLink(url, title, { modal = true } = {}) {
  if (!url) return;
  activeHostLink = { url, title: title || url };
  bindLinkTargets(url);
  if (viewerLinkTitle) viewerLinkTitle.textContent = title || url;

  if (modal && viewerLinkGate) {
    viewerLinkGate.classList.remove('hidden');
    hideLinkChip();
  } else {
    viewerLinkGate?.classList.add('hidden');
    showLinkChip();
  }
}

/** 모달만 닫고, 호스트가 링크 유지 중이면 하단 칩으로 언제든 다시 열기 */
function dismissViewerLinkModal() {
  viewerLinkGate?.classList.add('hidden');
  if (activeHostLink?.url) showLinkChip();
  else hideLinkChip();
}

/** 호스트가 링크를 완전히 닫음 */
function clearHostLink() {
  activeHostLink = null;
  viewerLinkGate?.classList.add('hidden');
  hideLinkChip();
  if (viewerLinkOpen) viewerLinkOpen.removeAttribute('href');
  if (viewerLinkChip) viewerLinkChip.removeAttribute('href');
}

viewerLinkClose?.addEventListener('click', () => dismissViewerLinkModal());
viewerLinkDismiss?.addEventListener('click', () => dismissViewerLinkModal());
viewerLinkGate?.addEventListener('click', (e) => {
  if (e.target === viewerLinkGate) dismissViewerLinkModal();
});

document.getElementById('btn-stop-self-share')?.addEventListener('click', () => {
  restoreAfterSelfShare().catch((err) => console.warn('[viewer] restoreAfterSelfShare', err));
});

function setWaiting(title, desc) {
  waitingPanel?.classList.remove('hidden');
  waitingPanel?.classList.remove('is-self-sharing');
  liveStage?.classList.add('hidden');
  document.body.classList.remove('has-presentation');
  if (waitingTitle) waitingTitle.textContent = title;
  if (waitingDesc) waitingDesc.textContent = desc;
  document.getElementById('btn-stop-self-share')?.classList.add('hidden');
}

function showLive() {
  if (subscriber?.sharingScreen) {
    showSelfSharing();
    return;
  }
  // 호스트가 미팅 시작하기를 누르기 전에는 실시간 화면을 노출하지 않고 타로 대기실(카드 배치) 유지
  if (!isMeetingStarted) {
    showTarotLounge();
    return;
  }
  if (!tarotLounge._isCountingDown) {
    tarotLounge.hide();
  }
  waitingPanel?.classList.remove('is-self-sharing');
  if (subscriber?.hasLiveVideo?.() || subscriber?.playing) {
    waitingPanel?.classList.add('hidden');
    liveStage?.classList.remove('hidden');
  } else {
    liveStage?.classList.add('hidden');
    waitingPanel?.classList.remove('hidden');
    setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
  }
  document.body.classList.add('has-presentation');
  document.getElementById('btn-stop-self-share')?.classList.add('hidden');
  viewerDrawCanvas?.resize();
}

/** 내가 화면 공유 중 — 호스트 영상(자기 화면 에코) 숨기고 안내만 표시 */
function showSelfSharing() {
  liveStage?.classList.add('hidden');
  waitingPanel?.classList.remove('hidden');
  document.body.classList.remove('has-presentation');
  waitingPanel?.classList.add('is-self-sharing');
  if (waitingTitle) waitingTitle.textContent = '내 화면 공유 중…';
  if (waitingDesc) {
    waitingDesc.textContent = '회원님의 PC 화면이 호스트와 모든 참가자에게 보입니다. 코딩·작업 화면을 그대로 보여 주세요.';
  }
  const stopBtn = document.getElementById('btn-stop-self-share');
  stopBtn?.classList.remove('hidden');
  syncStatus.textContent = '내 화면 공유 중';
}

function hideSelfSharing() {
  waitingPanel?.classList.remove('is-self-sharing');
  document.getElementById('btn-stop-self-share')?.classList.add('hidden');
  if (subscriber?.hasLiveVideo?.()) {
    waitingPanel?.classList.add('hidden');
    liveStage?.classList.remove('hidden');
    document.body.classList.add('has-presentation');
    syncStatus.textContent = '실시간 시청 중';
  } else {
    setWaiting(
      '호스트 화면 연결 중…',
      '화면 공유가 끝났습니다. 호스트 화면으로 돌아가는 중…'
    );
    subscriber?.watch?.().catch((err) => console.warn('[viewer] watch', err));
  }
}

function isSelfSharingUi() {
  return !!(subscriber?.sharingScreen || waitingPanel?.classList.contains('is-self-sharing'));
}

let _restoringSelfShare = false;

/** 공유 종료 후 호스트 화면 UI·수신을 확실히 복구 */
async function restoreAfterSelfShare() {
  if (_restoringSelfShare) return;
  _restoringSelfShare = true;
  waitingPanel?.classList.remove('is-self-sharing');
  document.getElementById('btn-stop-self-share')?.classList.add('hidden');

  try {
    try {
      await subscriber?.stopScreenShare?.();
    } catch (err) {
      console.warn('[viewer] stopScreenShare', err);
    }

    const tryShowLive = () => {
      if (subscriber?.sharingScreen) return false;
      if (subscriber?.hasLiveVideo?.()) {
        waitingPanel?.classList.add('hidden');
        liveStage?.classList.remove('hidden');
        document.body.classList.add('has-presentation');
        syncStatus.textContent = '실시간 시청 중';
        syncStatus.classList.add('connected');
        return true;
      }
      return false;
    };

    if (tryShowLive()) return;

    setWaiting(
      '호스트 화면 연결 중…',
      '화면 공유가 끝났습니다. 호스트 화면으로 돌아가는 중…'
    );

    const retryWatch = async () => {
      if (subscriber?.sharingScreen) return;
      try {
        await subscriber?.watch?.();
      } catch (err) {
        console.warn('[viewer] watch', err);
      }
      tryShowLive();
    };

    await retryWatch();
    if (!subscriber?.hasLiveVideo?.() && !subscriber?.sharingScreen) {
      setTimeout(() => { retryWatch(); }, 600);
      setTimeout(() => { retryWatch(); }, 1600);
    }
  } finally {
    _restoringSelfShare = false;
  }
}

function showSessionEnded(message) {
  const gate = document.getElementById('session-end-gate');
  const msg = document.getElementById('session-end-message');
  const title = gate?.querySelector('h2');
  const text = message || '호스트가 발표를 종료했습니다.';
  if (msg) msg.textContent = text;
  if (title) {
    title.textContent = /유효하지/.test(text) ? '유효하지 않은 방' : '발표가 종료되었습니다';
  }
  if (gate) gate.classList.remove('hidden');
  try { subscriber?.dispose(); } catch { /* ignore */ }
  try { sync?.stop(); } catch { /* ignore */ }
}

function showMicRequiredGate(message) {
  const gate = document.getElementById('mic-required-gate');
  const msg = document.getElementById('mic-required-message');
  if (msg && message) {
    msg.innerHTML = message.replace(/\n/g, '<br>');
  }
  if (gate) gate.classList.remove('hidden');
}

function hideMicRequiredGate() {
  const gate = document.getElementById('mic-required-gate');
  if (gate) gate.classList.add('hidden');
}

document.getElementById('btn-session-end-ok')?.addEventListener('click', () => {
  sessionStorage.removeItem('roomCode');
  sessionStorage.removeItem('viewerName');
  window.location.href = './';
});

function initFullscreenPrompt() {
  const gate = document.getElementById('fullscreen-prompt-gate');
  const btnYes = document.getElementById('btn-fs-prompt-yes');
  const btnNo = document.getElementById('btn-fs-prompt-no');
  if (!gate) return;

  // 이미 전체화면 상태라면 팝업을 띄우지 않음
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    return;
  }

  // 접속 시 전체화면 시청 여부 질의 모달 노출
  gate.classList.remove('hidden');

  const closePrompt = () => {
    gate.classList.add('hidden');
    // 사용자 클릭 제스처를 통해 브라우저 오디오/비디오 잠금 즉시 해제
    try {
      subscriber?._ensureGlobalAudioUnlock?.();
      subscriber?.unlockAudio?.();
      liveVideo?.play?.().catch(() => {});
    } catch { /* ignore */ }
  };

  btnYes?.addEventListener('click', async () => {
    closePrompt();
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      // 모바일 기기는 가로 방향으로 잠금 시도
      try {
        const orient = screen.orientation || screen.mozOrientation || screen.msOrientation;
        if (orient?.lock) await orient.lock('landscape');
      } catch { /* ignore */ }
    } catch (err) {
      console.warn('[viewer] fullscreen request failed:', err);
    }
  }, { once: true });

  btnNo?.addEventListener('click', () => {
    closePrompt();
  }, { once: true });
}

document.getElementById('btn-mic-retry')?.addEventListener('click', async () => {
  hideMicRequiredGate();
  // 권한/장치 재확인 (검증 대화상자 재실행)
  checkMicRequirement();
});

unmuteBanner?.classList.add('hidden');

const btnAvSpeaker = document.getElementById('btn-av-speaker');
const btnAvMic = document.getElementById('btn-av-mic');
const btnAvCam = document.getElementById('btn-av-cam');
const deepLiveCamModal = document.getElementById('deep-live-cam-modal');
const btnDlcClose = document.getElementById('btn-dlc-close');
const btnLaunchDlc = document.getElementById('btn-launch-dlc');

const camTroubleshootGate = document.getElementById('cam-troubleshoot-gate');
const btnCamUseAvatar = document.getElementById('btn-cam-use-avatar');
const btnCamRetryWake = document.getElementById('btn-cam-retry-wake');
const btnCamTroubleshootClose = document.getElementById('btn-cam-troubleshoot-close');

let _pendingCamRetryFn = null;

function showCameraTroubleshootModal(err, onRetry) {
  _pendingCamRetryFn = typeof onRetry === 'function' ? onRetry : null;
  if (camTroubleshootGate) {
    camTroubleshootGate.classList.remove('hidden');
  } else {
    alert(`카메라를 켤 수 없습니다: ${err?.message || '장치 권한 및 상태를 확인해 주세요.'}`);
  }
}

function hideCameraTroubleshootModal() {
  _pendingCamRetryFn = null;
  camTroubleshootGate?.classList.add('hidden');
}

btnCamTroubleshootClose?.addEventListener('click', hideCameraTroubleshootModal);

btnCamRetryWake?.addEventListener('click', async () => {
  const retryFn = _pendingCamRetryFn;
  hideCameraTroubleshootModal();
  if (retryFn) {
    showAvToast('카메라 다시 연결 시도 중...');
    await retryFn();
  }
});

btnCamUseAvatar?.addEventListener('click', async () => {
  hideCameraTroubleshootModal();
  closeDeepLiveCamModal();
  if (!subscriber) return;
  try {
    btnAvCam.disabled = true;
    const ok = await subscriber.startVirtualCamera();
    if (ok) {
      showAvToast('가상 얼굴(아바타)로 참여');
      updateAvatarUi();
    } else {
      alert('가상 아바타 송출을 시작할 수 없습니다.');
    }
  } catch (err) {
    alert(`가상 아바타 송출 오류: ${err?.message || err}`);
  } finally {
    btnAvCam.disabled = false;
    syncAvButtons();
  }
});
const camOverlayContainer = document.getElementById('cam-overlay-container');
const camFocusManager = new CamFocusManager({ containerId: 'cam-overlay-container' });
camFocusManager.onFocusChange = (focusedId) => {
  const avMgr = subscriber?.avatarManager;
  if (avMgr) {
    avMgr.setHighRes(focusedId === 'local');
    updateAvatarUi();
  }
};
const vadMonitor = {
  attach: (id, track) => { if (id !== 'local') speakingIndicator.trackRemote(id, track); },
  detach: () => {},
};
speakingIndicator.start();
const tarotLounge = new TarotLoungeManager({ containerId: 'tarot-waiting-lounge', isHost: false });

/** 호스트 화면 송출이 없거나 미팅 시작 전 대기실일 때 타로 카드 대기실 표시 */
function showTarotLounge() {
  if (subscriber?.sharingScreen) return;
  if (isMeetingStarted) {
    if (!tarotLounge._isCountingDown) {
      tarotLounge.hide();
      if (subscriber?.hasLiveVideo?.() || subscriber?.playing) {
        showLive();
      } else {
        liveStage?.classList.add('hidden');
        document.body.classList.remove('has-presentation');
        waitingPanel?.classList.remove('hidden');
        setWaiting('호스트 화면 연결 중…', '호스트의 발표 화면을 연결하고 있습니다. 잠시만 기다려 주세요.');
        syncStatus.textContent = '호스트 화면 연결 중…';
      }
    }
    return;
  }
  if (tarotLounge._isCountingDown) {
    return;
  }
  liveStage?.classList.add('hidden');
  document.body.classList.remove('has-presentation');
  waitingPanel?.classList.add('hidden');
  tarotLounge.show();
  tarotLounge.renderParticipants(currentViewers);
  syncStatus.textContent = '미팅 준비중';
  unmuteBanner?.classList.add('hidden');
}

// 초기 로드 시 대기실(타로 카드 배치) 우선 노출 (호스트 화면 송출 대기 스피너 고착 방지)
showTarotLounge();

function updateCameraPip(id, stream, { label = '카메라', isMirror = false, isHost = false } = {}) {
  if (!camOverlayContainer) return;
  let box = document.getElementById(`cam-box-${id}`);
  if (!stream) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = `cam-box-${id}`;
    box.className = 'cam-pip-box';
    box.dataset.speakId = id;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.defaultMuted = true;
    video.className = `cam-pip-video${isMirror ? ' is-mirror' : ''}`;
    const badge = document.createElement('span');
    badge.className = `cam-pip-badge${isHost ? ' is-host' : ''}`;
    badge.textContent = label;
    box.appendChild(video);
    box.appendChild(badge);

    if (id === 'local') {
      const toolbar = document.createElement('div');
      toolbar.className = 'cam-local-toolbar';
      toolbar.innerHTML = `
        <button type="button" class="cam-btn-pill pill-hd" title="화질 전환 (클릭 시 저부하 SD ↔ 640p 토글)">HD</button>
        <button type="button" class="cam-btn-pill pill-dlc" title="얼굴 변경 (사진·뷰티·내 얼굴 선택)">🎭</button>
      `;
      box.appendChild(toolbar);
      toolbar.querySelector('.pill-hd')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const avMgr = subscriber?.avatarManager;
        if (avMgr) {
          avMgr.setHighRes(!avMgr.isLarge);
          updateAvatarUi();
        }
      });
      toolbar.querySelector('.pill-dlc')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openDeepLiveCamModal();
      });
    }

    camOverlayContainer.appendChild(box);
    camFocusManager.bindBox(id, box);
  }
  const v = box.querySelector('video');
  if (v && v.srcObject !== stream) {
    v.srcObject = stream;
    v.play?.().catch(() => {});
  }
  if (id === 'local') {
    updateAvatarUi();
  }
}

function removeCameraPip(id) {
  camFocusManager.onBoxRemoved(id);
  vadMonitor.detach(id);
  const box = document.getElementById(`cam-box-${id}`);
  if (box) box.remove();
}

let avToastTimer = null;

function showAvToast(text, { off = false } = {}) {
  if (!unmuteBanner) return;
  if (unmuteBanner.dataset.sticky === '1') return; // 소리 차단 안내 유지
  unmuteBanner.textContent = text;
  unmuteBanner.classList.toggle('is-off', !!off);
  unmuteBanner.classList.remove('hidden');
  clearTimeout(avToastTimer);
  avToastTimer = setTimeout(() => {
    if (unmuteBanner.dataset.sticky === '1') return;
    unmuteBanner.classList.add('hidden');
  }, 1600);
}

function syncAvButtons() {
  const speakerOn = subscriber ? subscriber.speakerOn : false;
  const isReqMic = interactionMode === 'bidirectional' && requireMic;
  // 실제 상태만 표시 (필수 방에서도 검증·송출 전에는 비활성으로 보임)
  const micOn = !!micCtl?.enabled;
  const camOn = !!(subscriber?.cameraWanted && subscriber?.hasCamera && subscriber?.cameraEnabled);
  if (btnAvSpeaker) {
    btnAvSpeaker.classList.toggle('is-active', speakerOn);
    btnAvSpeaker.setAttribute('aria-pressed', speakerOn ? 'true' : 'false');
    btnAvSpeaker.title = speakerOn ? '소리 켜짐 — 클릭하여 끄기' : '소리 꺼짐 — 클릭하여 켜기';
  }
  if (btnAvMic) {
    btnAvMic.classList.toggle('is-active', micOn);
    btnAvMic.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    btnAvMic.title = micOn
      ? (isReqMic ? '마이크 켜짐 (마이크 필수 모임 — 끌 수 없음)' : '마이크 켜짐 — 클릭하여 끄기')
      : (micCtl?.state === 'none' ? '마이크를 사용할 수 없습니다 — 클릭하여 다시 시도' : '마이크 꺼짐 — 클릭하여 켜기');
  }
  document.getElementById('btn-av-mic-device')?.classList.toggle('hidden', !micCtl || interactionMode === 'unidirectional');
  if (btnAvCam) {
    btnAvCam.classList.toggle('is-active', camOn);
    btnAvCam.setAttribute('aria-pressed', camOn ? 'true' : 'false');
    btnAvCam.title = camOn ? '카메라 켜짐 — 클릭하여 끄기' : '카메라 꺼짐 — 클릭하여 켜기';
  }
  updateAvatarUi();
}

function onAvatarRandomClick() {
  if (!subscriber?.avatarManager) return;
  subscriber.avatarManager.nextAvatar();
  updateAvatarUi();
}

function onAvatarToggleClick() {
  if (!subscriber?.avatarManager) return;
  if (!subscriber.avatarManager.isReal && !subscriber.rawCameraStream) {
    alert('이 PC에는 실제 웹캠이 감지되지 않아 가상 얼굴(아바타) 모드로 유지됩니다.');
    return;
  }
  subscriber.avatarManager.toggleMode();
  updateAvatarUi();
}

async function applyFaceAndStartCamera(faceApplyFn) {
  closeDeepLiveCamModal();
  if (!subscriber) return;
  if (interactionMode === 'unidirectional') {
    alert('단방향(대규모 시청) 모드에서는 카메라를 사용할 수 없습니다.');
    return;
  }
  if (!allowClientCamera) {
    alert('이 방에서는 호스트가 참가자 카메라를 허용하지 않았습니다. 목소리(마이크)만 사용하실 수 있습니다.');
    return;
  }
  if (!allowClientDeepfake) {
    alert('이 방에서는 참가자의 딥페이크(AI 얼굴) 사용이 제한되어 있습니다. 호스트만 사용 가능합니다.');
    return;
  }

  const camAlreadyActive = !!(subscriber?.cameraWanted && subscriber?.hasCamera && subscriber?.cameraEnabled);

  if (camAlreadyActive) {
    const avMgr = subscriber.avatarManager;
    if (avMgr && typeof faceApplyFn === 'function') {
      faceApplyFn(avMgr);
    }
    updateAvatarUi();
  } else {
    btnAvCam.disabled = true;
    try {
      const avMgr = subscriber.avatarManager;
      if (avMgr && typeof faceApplyFn === 'function') {
        faceApplyFn(avMgr);
      }
      const ok = await subscriber.setCameraEnabled(true);
      if (!ok) {
        const err = subscriber._lastCameraError;
        showCameraTroubleshootModal(err, () => applyFaceAndStartCamera(faceApplyFn));
        return;
      }
      if (avMgr && typeof faceApplyFn === 'function') {
        faceApplyFn(avMgr);
      }
      showAvToast('카메라 켜기');
      updateAvatarUi();
    } catch (err) {
      alert(`카메라 오류: ${err?.message || err}`);
    } finally {
      btnAvCam.disabled = false;
      syncAvButtons();
    }
  }
}

function onSelectHero(heroId, photoUrl = '') {
  applyFaceAndStartCamera((avMgr) => {
    avMgr.setSwapFace(heroId, photoUrl);
  });
}

function onResetReal() {
  applyFaceAndStartCamera((avMgr) => {
    avMgr.activeSwapFace = null;
    avMgr.setRealMode?.();
  });
}

async function loadModalPhotos() {
  const grid = document.getElementById('dlc-hero-grid');
  if (!grid) return;
  try {
    const res = await fetch('/api/photos');
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.photos)) return;

    grid.innerHTML = '';
    const avMgr = subscriber?.avatarManager;
    const curSwap = (avMgr?.isSwap ? avMgr.activeSwapFace : '') || '';

    data.photos.forEach((photo) => {
      const card = document.createElement('div');
      card.className = 'dlc-hero-card';
      card.dataset.hero = photo.id;
      card.id = `card-hero-${photo.id}`;
      const isCur = curSwap === photo.id;
      if (isCur) card.classList.add('is-active');

      card.innerHTML = `
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name)}" class="dlc-hero-thumb">
        <button type="button" class="dlc-hero-apply-btn">${isCur ? '✓ 적용 중' : '선택하기'}</button>
      `;
      card.addEventListener('click', () => {
        onSelectHero(photo.id, photo.url);
      });
      grid.appendChild(card);
    });
  } catch (err) {
    console.warn('[FaceSwap] photos load error', err);
  }
}

function openDeepLiveCamModal() {
  if (!allowClientCamera) {
    alert('이 방에서는 호스트가 참가자 카메라를 허용하지 않았습니다. 목소리(마이크)만 사용하실 수 있습니다.');
    return;
  }
  if (!allowClientDeepfake) {
    alert('이 방에서는 참가자의 딥페이크(AI 얼굴) 사용이 제한되어 있습니다. 호스트만 사용 가능합니다.');
    return;
  }
  loadModalPhotos();
  deepLiveCamModal?.classList.remove('hidden');
}

function closeDeepLiveCamModal() {
  deepLiveCamModal?.classList.add('hidden');
}

function updateAvatarUi() {
  const avMgr = subscriber?.avatarManager;
  const camOn = !!(subscriber?.cameraWanted && subscriber?.hasCamera && subscriber?.cameraEnabled);

  // 카메라 활성화 시 상단 툴바에 얼굴 효과 버튼 표시 (딥페이크 허용 방에서만)
  const btnFaceEffect = document.getElementById('btn-face-effect');
  if (btnFaceEffect) {
    if (camOn && allowClientCamera && allowClientDeepfake) {
      btnFaceEffect.classList.remove('hidden');
      btnFaceEffect.style.setProperty('display', 'inline-flex', 'important');
    } else {
      btnFaceEffect.classList.add('hidden');
      btnFaceEffect.style.setProperty('display', 'none', 'important');
    }
  }

  const localBox = document.getElementById('cam-box-local');
  if (localBox && avMgr) {
    const isReal = avMgr.isReal;
    const isSwap = avMgr.isSwap;

    const pillHd = localBox.querySelector('.pill-hd');
    if (pillHd) {
      const mode = avMgr.faceMode || (avMgr.isLarge ? 'high' : 'crowd');
      const pillMap = {
        high: { label: '540p', title: '2~6명: 960×540 @ ~26fps' },
        solo: { label: '360p', title: '7~12명: 640×360 @ ~28fps' },
        multi: { label: '270p', title: '중간: 480×270 @ ~22fps' },
        crowd: { label: '288p', title: '13~20명: 512×288 @ ~20fps' },
        pack: { label: '216p', title: '21~30명: 384×216 @ ~14fps' },
        mass: { label: '180p', title: '31명+: 320×180 @ ~10fps' },
      };
      const pill = pillMap[mode] || pillMap.crowd;
      pillHd.classList.toggle('is-active', mode === 'high' || mode === 'solo');
      pillHd.textContent = pill.label;
      pillHd.title = pill.title;
    }

    const badge = localBox.querySelector('.cam-pip-badge');
    if (badge) {
      const vName = viewerName || '참가자';
      if (isSwap) {
        const key = avMgr.activeSwapFace;
        const heroLabel = key === 'superman' ? '슈퍼맨' : (key === 'batman' ? '배트맨' : (key === 'spiderman' ? '스파이더맨' : (key === 'real' || key === 'none' ? '원래 내 얼굴' : key)));
        badge.textContent = `${vName} (⚡ AI 얼굴: ${heroLabel})`;
      } else if (isReal) {
        badge.textContent = `${vName} (원래 내 얼굴)`;
      } else {
        badge.textContent = `${vName} (✨ ${avMgr.currentAvatar?.name || '가상'})`;
      }
    }
  }

  // 모달 내 사진 카드 및 상단 버튼 활성화 상태 동기화
  if (deepLiveCamModal && avMgr) {
    const curSwap = (avMgr.isSwap ? avMgr.activeSwapFace : '') || '';
    const isReal = avMgr.isReal;

    document.getElementById('btn-dlc-reset-real')?.classList.toggle('is-active', isReal);

    deepLiveCamModal.querySelectorAll('.dlc-hero-card').forEach((card) => {
      const hId = card.dataset.hero;
      const isCur = curSwap === hId;
      card.classList.toggle('is-active', !!isCur);
      const applyBtn = card.querySelector('.dlc-hero-apply-btn');
      if (applyBtn) {
        applyBtn.textContent = isCur ? '✓ 적용 중' : '선택하기';
      }
    });

    const statusText = document.getElementById('dlc-status-text');
    if (statusText) {
      if (camOn) {
        statusText.textContent = '선택한 얼굴이 실시간으로 적용되어 송출 중입니다.';
      } else {
        statusText.textContent = '원하는 얼굴을 선택하면 카메라가 켜지며 실시간 송출이 시작됩니다.';
      }
    }
  }
}

btnDlcClose?.addEventListener('click', closeDeepLiveCamModal);
document.getElementById('btn-dlc-reset-real')?.addEventListener('click', onResetReal);
document.getElementById('btn-face-effect')?.addEventListener('click', openDeepLiveCamModal);


deepLiveCamModal?.addEventListener('click', (e) => {
  if (e.target === deepLiveCamModal) closeDeepLiveCamModal();
});
deepLiveCamModal?.querySelectorAll('.dlc-hero-card').forEach((card) => {
  card.addEventListener('click', () => {
    const hId = card.dataset.hero;
    if (hId) onSelectHero(hId);
  });
});

btnAvCam?.addEventListener('click', async () => {
  if (!subscriber) return;
  if (interactionMode === 'unidirectional') {
    alert('단방향(대규모 시청) 모드에서는 카메라를 사용할 수 없습니다.');
    return;
  }
  if (!allowClientCamera) {
    alert('이 방에서는 호스트가 참가자 카메라를 허용하지 않았습니다. 목소리(마이크)만 사용하실 수 있습니다.');
    return;
  }
  const camAlreadyActive = !!(subscriber.cameraWanted && subscriber.hasCamera && subscriber.cameraEnabled);
  if (camAlreadyActive) {
    btnAvCam.disabled = true;
    try {
      await subscriber.setCameraEnabled(false);
      showAvToast('카메라 끄기', { off: true });
    } finally {
      btnAvCam.disabled = false;
      syncAvButtons();
    }
    return;
  }

  // 딥페이크가 허용되지 않은 방이면 모달 없이 실물 카메라로 즉시 송출 시작
  if (!allowClientDeepfake) {
    btnAvCam.disabled = true;
    try {
      const avMgr = subscriber.avatarManager;
      if (avMgr) {
        avMgr.activeSwapFace = null;
        avMgr.setRealMode?.();
      }
      const ok = await subscriber.setCameraEnabled(true);
      if (!ok) {
        const err = subscriber._lastCameraError;
        showCameraTroubleshootModal(err, () => {
          btnAvCam?.click();
        });
      } else {
        showAvToast('카메라 켜기');
      }
    } finally {
      btnAvCam.disabled = false;
      syncAvButtons();
    }
    return;
  }

  // 딥페이크 허용 방: 얼굴 선택 모달 오픈
  openDeepLiveCamModal();
});

btnAvSpeaker?.addEventListener('click', () => {
  if (!subscriber) return;
  const next = !subscriber.speakerOn;
  subscriber.setSpeakerEnabled(next);
  syncAvButtons();
  showAvToast(next ? '소리 켜기' : '소리 끄기', { off: !next });
});

btnAvMic?.addEventListener('click', async () => {
  if (!subscriber || !micCtl) return;
  if (interactionMode === 'unidirectional') {
    showToast('단방향(대규모 시청) 모드에서는 마이크를 사용할 수 없습니다.', 'warn');
    return;
  }
  if (!sync?.socket?.connected) {
    showToast('방에 연결되지 않았습니다.', 'error');
    return;
  }
  if (!window.isSecureContext) {
    showToast('마이크는 HTTPS(보안 연결)에서만 사용할 수 있습니다.', 'error');
    return;
  }
  btnAvMic.disabled = true;
  try {
    await micCtl.toggle();
  } finally {
    btnAvMic.disabled = false;
    syncAvButtons();
  }
});

document.getElementById('btn-av-mic-device')?.addEventListener('click', async () => {
  if (!micCtl) return;
  await micCtl.openSettings();
  syncAvButtons();
});

/** 서버에 현재 마이크 상태를 다시 알림 (재접속 등) */
function emitMicStatus() {
  try { micCtl?._emit?.(); } catch { /* ignore */ }
}

/** 마이크 컨트롤러 생성 (subscriber 준비 후 1회) */
function setupViewerMic() {
  if (micCtl || !subscriber || !sync) return;
  const isReq = interactionMode === 'bidirectional' && requireMic;
  micCtl = new MicController({
    role: 'viewer',
    clientId: sync.clientId,
    speakIds: ['local', sync.clientId],
    source: 'viewer-mic',
    getSfu: () => subscriber._ensureSfu(),
    socket: sync.socket,
    requireMic: isReq,
    onChange: () => syncAvButtons(),
    onForced: () => showToast('마이크 사용이 필수인 모임입니다. 마이크를 끌 수 없습니다.', 'warn', 4200),
    onNotice: (msg, kind) => showToast(msg, kind === 'error' ? 'error' : 'warn', 5200),
    onLeave: () => {
      try { sessionStorage.removeItem('roomCode'); } catch { /* ignore */ }
      window.location.href = './';
    },
    onTrack: (track) => {
      try { subscriber.avatarManager?.attachMicTrack(track || null); } catch { /* ignore */ }
    },
  });
  sync.socket?.on?.('connect', () => emitMicStatus());
  micCtl._emit(); // 초기 상태: off / ready=false → 아이콘 비활성으로 시작
  syncAvButtons();
}

/** 마이크 필수 방: 검증 대화상자(장치 선택 + 말하기 확인) 통과 후 자동 ON */
async function checkMicRequirement() {
  if (interactionMode !== 'bidirectional' || !requireMic) {
    hideMicRequiredGate();
    return true;
  }
  if (!window.isSecureContext) {
    showMicRequiredGate('마이크 사용 필수 미팅입니다.<br>마이크는 보안 연결(HTTPS 또는 localhost)에서만 사용할 수 있습니다.');
    return false;
  }
  hideMicRequiredGate();
  if (!micCtl) return false;
  if (micCtl.enabled) return true;
  const ok = await micCtl.enable();
  syncAvButtons();
  return ok;
}

function handleEvent(type, data) {
  switch (type) {
    case 'viewer-count':
      currentViewers = data.viewers || [];
      setViewerCount(data.count ?? 0, data.viewers, {
        activeBroadcasterId: data.activeBroadcasterId,
      });
      // 마이크 on/off 같은 상태 변화마다 viewer-count 가 오므로, 인원수가 바뀔 때만 화질 재계산
      // 모바일 기본 확대: 호스트 화면의 얼굴 수(입장 완료 참가자 + 호스트)에 맞춰 ~10명이 화면을 채우도록
      viewerZoom?.setFaceCount?.(
        (Array.isArray(data.viewers) ? data.viewers.filter((v) => v.admitted !== false).length : (data.count ?? 0)) + 1,
      );
      if (data.count !== handleEvent._lastCount) {
        handleEvent._lastCount = data.count;
        subscriber?.setFaceQualityByRoomSize?.(data.count ?? 1).catch?.(() => {});
      }
      if (data.meetingStarted) {
        const firstStart = !isMeetingStarted;
        isMeetingStarted = true;
        tarotLounge.hide();
        showLive();
        // 이미 영상이 정상 재생 중이면 재-watch 하지 않는다(마이크 토글 시 화면이 흔들리는 원인)
        if (firstStart || !subscriber?.hasLiveVideo?.()) {
          subscriber?.watch?.().catch((err) => console.warn('[viewer] watch', err));
        }
      }
      if (tarotLounge.isActive && !tarotLounge._isCountingDown && !isMeetingStarted) {
        tarotLounge.renderParticipants(currentViewers);
      }
      break;
    case 'start-meeting-countdown': {
      if (isMeetingStarted && !tarotLounge.isActive) break;
      isMeetingStarted = true;
      if (!tarotLounge.isActive) {
        tarotLounge.show();
      }
      tarotLounge.renderParticipants(currentViewers);
      tarotLounge.startCountdown({
        duration: data?.duration || 5,
        onComplete: () => {
          isMeetingStarted = true;
          // 영상 유무와 무관하게 카드 대기실을 반드시 종료 (연결 중 UI로 전환)
          tarotLounge.hide();
          showLive();
          syncStatus.textContent = '호스트 화면 연결 중…';
          subscriber?.watch?.().catch((err) => console.warn('[viewer] watch after countdown:', err));
        },
      });
      break;
    }
    case 'request-screen-share': {
      if (interactionMode === 'unidirectional') {
        syncStatus.textContent = '단방향 모드 — 화면 공유 불가';
        break;
      }
      const hostLabel = data.hostName || '호스트';
      const ok = window.confirm(
        `${hostLabel}님이 회원님의 PC 화면을 모든 참가자에게 보여 달라고 요청했습니다.\n\n`
        + '허용하면 전체 화면 공유 창이 열립니다. 공유하는 동안 호스트 화면 대신 「내 화면 공유 중」만 표시됩니다.'
      );
      if (!ok) {
        syncStatus.textContent = '화면 공유 요청 거절';
        break;
      }
      syncStatus.textContent = '전체 화면 선택…';
      subscriber?.startScreenShare().then((started) => {
        if (started) {
          showSelfSharing();
        } else {
          syncStatus.textContent = '화면 공유 취소됨';
          hideSelfSharing();
        }
      });
      break;
    }
    case 'stop-screen-share':
      restoreAfterSelfShare().catch((err) => console.warn('[viewer] restoreAfterSelfShare', err));
      break;
    case 'broadcaster-changed':
      setSelectedBroadcaster(data.clientId || null);
      // 호스트로 복귀했거나 내가 더 이상 방송자가 아니면 공유 UI·송출 정리
      {
        const backToHost = data.role === 'host' || data.clientId === data.hostClientId;
        const iAmNotBroadcaster = !!(data.clientId && data.clientId !== sync?.clientId);
        if (isSelfSharingUi() && (backToHost || iAmNotBroadcaster)) {
          restoreAfterSelfShare().catch((err) => console.warn('[viewer] restoreAfterSelfShare', err));
        }
      }
      break;
    case 'session-end':
      clearHostLink();
      showSessionEnded(data.message || '호스트가 발표를 종료했습니다.');
      break;
    case 'meeting-started':
      isMeetingStarted = true;
      // 영상 준비 여부와 무관하게 카드 대기실 종료 → 라이브/연결중 UI
      tarotLounge.hide();
      showLive();
      syncStatus.textContent = '호스트 화면 연결 중…';
      subscriber?.watch?.().catch((err) => { console.warn('[viewer] watch', err); });
      break;
    case 'display-mode':
      applyDisplayMode(data.mode);
      break;
    case 'spotlight-speaker':
      handleSpotlightSpeakerEvent(data);
      break;
    case 'draw-start':
      viewerDrawCanvas?.handleRemoteStrokeStart(data);
      break;
    case 'draw-move':
      viewerDrawCanvas?.handleRemoteStrokeMove(data);
      break;
    case 'draw-end':
      viewerDrawCanvas?.handleRemoteStrokeEnd(data);
      break;
    case 'clear-drawings':
    case 'clear-all-drawings':
      viewerDrawCanvas?.clearAll();
      break;
    case 'open-link':
      // 링크는 호스트 새 창 + 화면 송출만 — 참가자 별도 모달 없음
      break;
    case 'close-link':
      clearHostLink();
      break;
    case 'slide-change':
      clearHostLink();
      subscriber?.requestDisplayKeyframe?.();
      break;
    case 'play-video':
    case 'close-video':
    case 'presentation-ready':
      clearHostLink();
      break;
    case 'stream-status':
      // 내가 화면 공유 중이면 호스트 송출 FLAG로 UI를 덮어쓰지 않음
      if (isSelfSharingUi()) break;
      cachedStreamActive = !!data.active;
      if (data.active) {
        subscriber?.setStreamActive?.(true);
        if (streamOfflineTimer) {
          clearTimeout(streamOfflineTimer);
          streamOfflineTimer = null;
        }
        if (isMeetingStarted) {
          if (!tarotLounge._isCountingDown) tarotLounge.hide();
          showLive();
          // 이미 실시간 시청 중이면 FLAG 주기 재방송으로「연결 중」으로 되돌리지 않음
          if (subscriber?.hasLiveVideo?.()) {
            syncStatus.textContent = '실시간 시청 중';
            break;
          }
          syncStatus.textContent = '호스트 화면 연결 중…';
          if (!liveVideo?.srcObject) {
            waitingPanel?.classList.remove('hidden');
            setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
          }
        } else if (!tarotLounge._isCountingDown) {
          showTarotLounge();
        }
        subscriber?.watch?.().catch((err) => { console.warn('[viewer] watch', err); });
      } else {
        // 3차 안전망: 즉각 파괴 방지 — 3.5초 유예 버퍼 (찰나의 소켓/네트워크 순단 보호)
        if (streamOfflineTimer) clearTimeout(streamOfflineTimer);
        streamOfflineTimer = setTimeout(() => {
          streamOfflineTimer = null;
          subscriber?.setStreamActive?.(false);
          subscriber?.clearRemote?.({ videoOnly: interactionMode === 'bidirectional' });
          if (isMeetingStarted) {
            liveStage?.classList.add('hidden');
            waitingPanel?.classList.remove('hidden');
            setWaiting('호스트 화면 송출 대기', '호스트가 「송출」을 누르면 실시간으로 발표 화면이 보입니다.');
            syncStatus.textContent = '송출 대기';
          } else if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
        }, 3500);
      }
      break;
    default:
      break;
  }
}

sync = new RoomSync({
  code: roomCode,
  role: 'viewer',
  name: viewerName,
  onEvent: handleEvent,
  onRejoined: (data) => {
    console.log('[viewer] 1차 안전망: 소켓 재체결 성공, 상태 동기화 진행', data);
    if (data?.state) {
      applyRoomPermissions(data.state);
      if (data.state.viewers) currentViewers = data.state.viewers;
      if (data.state.meetingStarted) {
        isMeetingStarted = true;
      }
      if (data.state.displayMode) applyDisplayMode(data.state.displayMode);
      if (data.state.spotlightSpeakerId) {
        handleSpotlightSpeakerEvent({
          clientId: data.state.spotlightSpeakerId,
          name: data.state.spotlightSpeakerName,
          role: data.state.spotlightSpeakerRole,
        });
      }
      if (data.state.streamActive && isMeetingStarted) {
        if (!tarotLounge._isCountingDown) tarotLounge.hide();
        showLive();
        syncStatus.textContent = '호스트 화면 연결 중…';
        subscriber?.setStreamActive?.(true);
        subscriber?.watch?.().catch((err) => console.warn('[viewer] rejoin watch', err));
      } else if (data.state.streamActive) {
        // 송출은 있으나 미팅 시작 플래그가 아직 없으면 대기실 유지 + 수신만 준비
        subscriber?.setStreamActive?.(true);
        subscriber?.watch?.().catch((err) => console.warn('[viewer] rejoin watch', err));
        if (!isMeetingStarted && !tarotLounge._isCountingDown) showTarotLounge();
      } else if (!isMeetingStarted && !tarotLounge._isCountingDown) {
        subscriber?.setStreamActive?.(false);
        showTarotLounge();
      }
    }
  },
  onError: (msg) => console.warn(msg),
});

sync.start()
  .then(async (data) => {
    if (data.state?.ended) {
      showSessionEnded('유효하지 않은 방입니다.');
      return;
    }

    if (data.state) {
      applyRoomPermissions(data.state);
    }

    if (data.state?.interactionMode || data.state?.requireMic !== undefined) {
      applyInteractionMode(data.state?.interactionMode || interactionMode, !!data.state?.requireMic);
    }

    const isStreamActive = !!data.state?.streamActive || cachedStreamActive;
    isMeetingStarted = !!data.state?.meetingStarted;
    currentViewers = data.state?.viewers || [];

    // 접속 시 전체화면 시청 여부 확인 팝업
    initFullscreenPrompt();

    // 시그널 수신을 먼저 열어 호스트 offer 유실 방지
    const signaling = new WebrtcSignaling(sync.socket, { localClientId: sync.clientId });
    subscriber = new ViewerSubscriber({
      signaling,
      videoEl: liveVideo,
      streamActive: isStreamActive,
      hostPeerId: data.state?.hostClientId || null,
      onStatus: (s) => {
        // needUnmute는 자동 배너로 쓰지 않음 — 스피커 토글 토스트만 사용
        if (s.sharingScreen) {
          showSelfSharing();
          return;
        }
        if (s.sharingScreen === false && !subscriber?.sharingScreen) {
          // stopScreenShare 후 — 영상 유무와 무관하게 공유 UI는 반드시 해제
          waitingPanel?.classList.remove('is-self-sharing');
          document.getElementById('btn-stop-self-share')?.classList.add('hidden');
          if (s.playing || subscriber?.hasLiveVideo?.()) {
            showLive();
            syncStatus.textContent = '실시간 시청 중';
            syncStatus.classList.add('connected');
            return;
          }
          if (isMeetingStarted) {
            showLive();
          } else if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
          subscriber?.watch?.().catch((err) => console.warn('[viewer] watch', err));
          return;
        }
        if (s.streamEnded || s.streamActive === false) {
          if (subscriber?.sharingScreen) return;
          // 호스트가 실제로 송출 중지(active: false)를 보냈을 때만 송출 대기로 전환
          // (라이브 영상이 재생 중이면 일시적인 오디오/카메라 토글로 인한 대기 전환 차단)
          if (cachedStreamActive && (subscriber?.hasLiveVideo?.() || (liveVideo?.srcObject && !liveVideo?.paused))) {
            return;
          }
          if (isMeetingStarted) {
            liveStage?.classList.add('hidden');
            waitingPanel?.classList.remove('hidden');
            setWaiting('호스트 화면 송출 대기', '호스트가 「송출」을 누르면 실시간으로 발표 화면이 보입니다.');
            syncStatus.textContent = '송출 대기';
            return;
          }
          if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
          return;
        }
        if (subscriber?.sharingScreen) {
          showSelfSharing();
          return;
        }
        if (s.playing) {
          if (isMeetingStarted) {
            showLive();
            syncStatus.textContent = '실시간 시청 중';
            syncStatus.classList.add('connected');
          } else if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
        } else if (s.connectError) {
          if (subscriber?.hasLiveVideo?.() || (liveVideo?.srcObject && !liveVideo?.paused)) {
            // 이미 실시간 영상이 정상 재생 중이면 연결 중 팝업으로 화면을 가리지 않음
            return;
          }
          if (isMeetingStarted) {
            waitingPanel?.classList.remove('hidden');
            setWaiting('호스트 화면 연결 중…', '호스트의 발표 화면을 연결하고 있습니다. 잠시만 기다려 주세요.');
            syncStatus.textContent = '화면 연결 중…';
          } else if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
        } else if (cachedStreamActive && s.streamActive && !liveVideo?.srcObject) {
          if (subscriber?.hasLiveVideo?.()) {
            return;
          }
          if (isMeetingStarted) {
            waitingPanel?.classList.remove('hidden');
            setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
            syncStatus.textContent = '호스트 화면 연결 중…';
          } else if (!tarotLounge._isCountingDown) {
            showTarotLounge();
          }
        }
        if (s.needUnmute && s.hasRemoteAudio) {
          if (unmuteBanner) {
            unmuteBanner.textContent = '🔊 탭하여 소리 켜기';
            unmuteBanner.classList.remove('hidden', 'is-off');
            unmuteBanner.dataset.sticky = '1';
          }
        } else if (s.needUnmute === false) {
          if (unmuteBanner) {
            unmuteBanner.dataset.sticky = '';
            unmuteBanner.classList.add('hidden');
          }
        }
      },
    });

    if (liveVideo) {
      attachVideoFreezeWatchdog(liveVideo, {
        label: 'viewer-main-screen',
        mode: 'display',
        onRequestKeyFrame: () => {
          subscriber?.requestDisplayKeyframe?.();
        },
        onFullRecover: async () => {
          subscriber?.requestDisplayKeyframe?.();
          try { await liveVideo.play?.().catch(() => {}); } catch {}
        },
      });
    }

    // ⚡ 화면 싱크 수동 새로고침 버튼 및 단축키(R)
    const btnSyncRefresh = document.getElementById('btn-sync-refresh');
    const triggerManualSync = async () => {
      if (!subscriber) return;
      if (syncStatus) syncStatus.textContent = '⚡ 싱크 맞추는 중…';
      btnSyncRefresh?.classList.add('is-active');
      try {
        subscriber.requestDisplayKeyframe?.();
        await subscriber.videoEl?.play?.().catch(() => {});
        await subscriber.sfu?.resumeAllConsumers?.().catch(() => {});
        if (syncStatus) syncStatus.textContent = '실시간 시청 중';
      } catch (e) {
        console.warn('[viewer] manual sync err', e);
      } finally {
        setTimeout(() => btnSyncRefresh?.classList.remove('is-active'), 500);
      }
    };
    btnSyncRefresh?.addEventListener('click', triggerManualSync);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'r' || e.key === 'R') {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
        triggerManualSync();
      }
    });

    // 기본: 소리 ON — 별도 <audio>로 재생 (첫 클릭 시 unlock)
    subscriber.speakerOn = true;
    subscriber.interactionMode = interactionMode;
    subscriber.setRoomCode?.(roomCode);
    subscriber.avatarManager?.setClientId?.(sync.clientId);
    if (subscriber.avatarManager) {
      subscriber.avatarManager.onAvatarChange = () => updateAvatarUi();
      subscriber.avatarManager.onModeChange = () => updateAvatarUi();
      // 서버 하드웨어 용량이 한계라 딥페이크를 더 적용할 수 없을 때: 실물 얼굴이 나가지 않도록 카메라를 끄고 안내한다.
      subscriber.avatarManager.onSwapRejected = (info) => {
        Promise.resolve(subscriber.setCameraEnabled(false)).catch(() => {}).finally(() => {
          try { updateAvatarUi(); syncAvButtons(); } catch { /* ignore */ }
        });
        const max = Number(info?.max_clients) > 0 ? ` (동시 딥페이크 최대 약 ${info.max_clients}명)` : '';
        showToast(`서버 하드웨어 상황에 따라 더 이상 딥페이크를 적용할 수 없습니다.${max} 잠시 후 다시 시도해 주세요.`, 'warn', 8000);
      };
    }

    subscriber.onCameraChange = ({ active, stream }) => {
      if (active && stream) {
        updateCameraPip('local', stream, { label: `${viewerName} (내 카메라)`, isMirror: true, isHost: false });
        if (currentSpotlightSpeaker.id === sync?.clientId) {
          floatingSpeakerManager?.setStream(stream);
        }
      } else {
        removeCameraPip('local');
        if (currentSpotlightSpeaker.id === sync?.clientId) {
          floatingSpeakerManager?.setStream(null);
        }
      }
      syncAvButtons();
    };

    subscriber.onSpotlightStream = ({ clientId, name, role, stream }) => {
      floatingSpeakerManager?.setSpeaker({
        id: clientId,
        name,
        role,
        stream,
      });
    };

    subscriber.onRemoteCamera = () => {};
    subscriber.onRemoteCameraClosed = () => {};
    subscriber.onRemoteAudioTrack = ({ clientId, track }) => {
      vadMonitor.attach(clientId, track);
    };
    subscriber.onRemoteAudioTrackClosed = (clientId) => {
      speakingIndicator.untrack(clientId);
    };
    subscriber.onNetworkQuality = ({ pingMs, lossRate, quality }) => {
      const syncEl = document.getElementById('sync-status');
      if (syncEl) {
        const dot = quality === 'poor' ? '🔴' : quality === 'fair' ? '🟡' : '🟢';
        const lossText = lossRate > 1 ? ` (${lossRate}%)` : '';
        syncEl.textContent = `${dot} ${pingMs}ms${lossText}`;
        syncEl.title = `실시간 네트워크 지연(Ping): ${pingMs}ms, 손실율: ${lossRate}%`;
      }
      const avMgr = subscriber.avatarManager;
      if (quality === 'poor' && avMgr?.isLarge) {
        console.warn('[viewer] network poor -> lowering camera res to SD for low latency');
        avMgr.setHighRes(false);
      }
    };

    if (liveVideo) liveVideo.muted = true;
    if (data.state?.hostClientId) {
      subscriber.hostPeerId = data.state.hostClientId;
    }

    const initialSpotlightId = data.state?.spotlightSpeakerId || data.state?.hostClientId || null;
    const initialSpotlightName = data.state?.spotlightSpeakerName || data.state?.hostName || '호스트';
    const initialSpotlightRole = data.state?.spotlightSpeakerRole || 'host';

    handleSpotlightSpeakerEvent({
      clientId: initialSpotlightId,
      name: initialSpotlightName,
      role: initialSpotlightRole,
    });
    applyInteractionMode(data.state?.interactionMode || interactionMode, !!data.state?.requireMic);
    setupViewerMic();
    if (sync?.socket && interactionMode === 'bidirectional') {
      // 호스트의 원격 제어(마우스/키보드) 요청 승인 UI
      rcViewer = new RemoteControlViewer({ socket: sync.socket });
    }
    syncAvButtons();

    // 양방향 방: 화면 송출 유무와 무관하게 음성 수신은 접속 즉시 항상 보장
    if (interactionMode === 'bidirectional') {
      subscriber.ensureReceiving?.().catch((err) => {
        console.warn('[viewer] ensureReceiving error:', err);
      });
    }

    if (isMeetingStarted) {
      tarotLounge.hide();
      if (isStreamActive) {
        showLive();
        syncStatus.textContent = '호스트 화면 연결 중…';
        setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
        subscriber.watch().catch((err) => {
          console.warn('[viewer] initial watch error:', err);
        });
      } else {
        liveStage?.classList.add('hidden');
        waitingPanel?.classList.remove('hidden');
        setWaiting('호스트 화면 송출 대기', '호스트가 「송출」을 누르면 실시간으로 발표 화면이 보입니다.');
        syncStatus.textContent = '송출 대기';
      }
    } else {
      showTarotLounge();
      if (isStreamActive) {
        subscriber.watch().catch((err) => {
          console.warn('[viewer] initial watch error:', err);
        });
      }
    }

    sync.socket?.on('connect', () => {
      console.log('[viewer] socket reconnected -> resyncing media streams...');
      subscriber?.watch().catch(() => {});
      if (interactionMode === 'bidirectional') {
        subscriber?.ensureReceiving?.().catch(() => {});
      }
    });

    // 마이크 필수 미팅인 경우 즉시 마이크 권한 확인 및 켜기
    if (interactionMode === 'bidirectional' && requireMic) {
      await checkMicRequirement();
    }

    const unlockSound = () => {
      if (!subscriber?.speakerOn) return;
      // 이미 unlock 됐어도 영상 muted면 다시 시도
      if (subscriber._audioUnlocked && subscriber.videoEl && !subscriber.videoEl.muted) return;
      subscriber.unlockAudio().then((ok) => {
        if (ok && unmuteBanner) {
          unmuteBanner.dataset.sticky = '';
          unmuteBanner.classList.add('hidden');
        }
      });
    };
    unmuteBanner?.addEventListener('click', (e) => {
      e.preventDefault();
      unlockSound();
    });
    window.addEventListener('pointerdown', unlockSound, { capture: true });
    window.addEventListener('keydown', unlockSound, { capture: true });

    syncStatus.textContent = '연결됨';
    syncStatus.classList.add('connected');
    setViewerCount(data.state?.viewerCount ?? 0, data.state?.viewers, {
      activeBroadcasterId: data.state?.activeBroadcasterId,
    });
    subscriber?.setFaceQualityByRoomSize?.(data.state?.viewerCount ?? 1).catch?.(() => {});
    applyDisplayMode(data.state?.displayMode || 'face');
    viewerZoom?.setFaceCount?.(
      (Array.isArray(data.state?.viewers)
        ? data.state.viewers.filter((v) => v.admitted !== false).length
        : (data.state?.viewerCount ?? 0)) + 1,
    );

    chatPanel = setupChatPanel({
      getSocket: () => sync?.socket,
      clientId: sync.clientId,
      displayName: viewerName,
      role: 'viewer',
      toggleBtn: document.getElementById('btn-chat'),
    });

    if (data.state?.popup?.url) {
      // 구버전 호스트 popup 상태 무시
      clearHostLink();
    }
  })
  .catch((err) => {
    syncStatus.textContent = '연결 실패';
    syncStatus.classList.add('disconnected');
    const msg = err?.message || '유효하지 않은 방입니다.';
    if (err?.ended || /유효하지|종료/.test(msg)) {
      showSessionEnded(msg);
      return;
    }
    alert(msg);
    window.location.href = './';
  });

const cleanupSession = () => {
  try { subscriber?.dispose(); } catch { /* ignore */ }
  sync?.stop();
};
window.addEventListener('beforeunload', cleanupSession);
window.addEventListener('pagehide', cleanupSession);

// 백그라운드 탭 전환 등으로 일시정지된 비디오 재생 유지
setInterval(() => {
  document.querySelectorAll('video').forEach((v) => {
    if (v.srcObject && v.paused) {
      v.play?.().catch(() => {});
    }
  });
}, 2000);

