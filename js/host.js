import { OverlayManager } from './overlay-manager.js?v=20260930i';
import { DrawCanvas } from './draw-canvas.js?v=20260918pen2';
import { RoomSync } from './sync.js?v=20261017b';
import { goToSlide, getPptEngine } from './host-ppt-loader.js?v=20260715ah';
import { findHttpLinkAt, findVideoHitAt } from './link-utils.js?v=20260715z';
import {
  setViewerCount,
  setupViewersPanel,
  setSelectedBroadcaster,
  setSpotlightSpeaker,
  getLatestViewers,
} from './viewers-panel.js?v=20261014b';
import { FloatingSpeakerManager } from './floating-speaker-manager.js?v=20261013d';
import { WebrtcSignaling } from './webrtc/signaling.js?v=20260715j';
import { HostPublisher } from './webrtc/host-publisher.js?v=20261030k';
import { setupChatPanel } from './chat-panel.js?v=20261014a';
import { CamFocusManager } from './cam-focus-manager.js?v=20260930a';
import { MicController } from './mic-controller.js?v=20261013f';
import { speakingIndicator } from './speaking-indicator.js?v=20261002b';
import { showToast } from './ui-toast.js?v=20260930a';
import { RemoteControlHost } from './remote-control.js?v=20260930a';
import { TarotLoungeManager } from './tarot-lounge-manager.js?v=20260930j';
import { attachVideoFreezeWatchdog } from './webrtc/video-freeze-watchdog.js?v=20260930a';
import { FaceFeedClient } from './face-feed-client.js?v=20260930c';
import { HostBeautyBarManager } from './host-beauty-bar.js?v=20261030l';

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || sessionStorage.getItem('roomCode') || '').replace(/[^0-9]/g, '').slice(0, 4);
const hostToken = params.get('ht') || sessionStorage.getItem('hostToken') || '';
const hostName = params.get('hn') || sessionStorage.getItem('hostName') || '호스트';
const urlMode = params.get('mode');

if (!roomCode || !hostToken) {
  try {
    const res = await fetch('/api/host-url');
    const data = await res.json();
    if (data?.ok && data.url) {
      window.location.replace(data.url);
      await new Promise(() => {});
    } else {
      window.location.href = './#create';
      await new Promise(() => {});
    }
  } catch {
    window.location.href = './#create';
    await new Promise(() => {});
  }
}

try {
  sessionStorage.setItem('hostToken', hostToken);
  sessionStorage.setItem('roomCode', roomCode);
  sessionStorage.setItem('hostName', hostName);
  if (urlMode) sessionStorage.setItem('interactionMode', urlMode);
} catch { /* ignore */ }

// URL에 남은 토큰 제거 (주소창 정리)
if (params.has('ht') || params.has('hn') || params.has('mode')) {
  try {
    const clean = new URL(window.location.href);
    clean.searchParams.delete('ht');
    clean.searchParams.delete('hn');
    clean.searchParams.delete('mode');
    window.history.replaceState({}, '', clean.pathname + clean.search);
  } catch { /* ignore */ }
}

document.getElementById('room-code').textContent = roomCode;

let sync = null;
let webrtcPublisher = null;
let knownViewerIds = new Set();
let activeBroadcasterId = null;
let interactionMode = urlMode || sessionStorage.getItem('interactionMode') || 'bidirectional';
let requireMic = params.get('rm') === '1' || sessionStorage.getItem('requireMic') === 'true';
/** 단방향 옵션: 모든 참가자 목소리 미팅 허용 (서버 상태로 다시 맞춤) */
let allowAllVoice = params.get('av') === '1';
const MIC_PREF_KEY = 'yunseulStreamMic';
let preferMic = requireMic || sessionStorage.getItem(MIC_PREF_KEY) === '1';
let chatPanel = null;
let isMeetingStarted = false;
let hostParticipantsGrid = null;
const sfuCameraStreams = new Map();
const shownCameraSource = new Map();
/** @type {import('./face-feed-client.js').FaceFeedClient|null} */
let faceFeed = null;
/** @type {import('./mic-controller.js').MicController|null} */
let micCtl = null;
/** @type {import('./remote-control.js').RemoteControlHost|null} */
let rcHost = null;

function applyInteractionMode(mode, isRequireMic = requireMic) {
  interactionMode = mode === 'unidirectional' ? 'unidirectional' : 'bidirectional';
  requireMic = interactionMode === 'bidirectional' && !!isRequireMic;
  if (requireMic) {
    preferMic = true;
    try { sessionStorage.setItem(MIC_PREF_KEY, '1'); } catch {}
  }
  try {
    sessionStorage.setItem('interactionMode', interactionMode);
    sessionStorage.setItem('requireMic', requireMic ? 'true' : 'false');
  } catch { /* ignore */ }
  document.body.classList.toggle('is-unidirectional', interactionMode === 'unidirectional');
  document.body.classList.toggle('uni-all-voice', interactionMode === 'unidirectional' && allowAllVoice);
  const badge = document.getElementById('mode-badge');
  if (badge) {
    if (interactionMode === 'unidirectional') {
      badge.textContent = allowAllVoice ? '단방향 · 전체 목소리' : '단방향';
      badge.classList.add('is-uni');
      badge.title = allowAllVoice
        ? '단방향 — 영상은 호스트만, 모든 참가자 목소리 미팅 허용'
        : '단방향 대규모 시청 — 참가자는 시청·채팅만 (카드를 누르면 1명에게 발언권)';
    } else {
      badge.textContent = requireMic ? '양방향 · 마이크 필수' : '양방향';
      badge.classList.remove('is-uni');
      badge.title = requireMic
        ? '양방향 화상 미팅 (마이크 필수)'
        : '양방향 화상 미팅';
    }
  }
  if (webrtcPublisher) {
    webrtcPublisher.interactionMode = interactionMode;
    webrtcPublisher.allowAllVoice = interactionMode === 'unidirectional' && allowAllVoice;
    if (interactionMode === 'bidirectional' || webrtcPublisher.allowAllVoice) {
      webrtcPublisher.ensureReceiving().catch(() => {});
    }
  }
  if (micCtl && micCtl.requireMic !== requireMic) micCtl.setRequireMic(requireMic);
  hostParticipantsGrid?.updateVisibility();
  // 단방향: 명단에서 참가자 화면 공유 선택 비활성
  const hint = document.getElementById('viewers-popup-hint');
  if (hint && interactionMode === 'unidirectional') {
    hint.textContent = '단방향 모드에서는 참가자 화면 공유를 사용할 수 없습니다. 호스트를 누르면 발표 화면으로 돌아갑니다.';
  }
}

applyInteractionMode(interactionMode, requireMic);

const guestShareStage = document.getElementById('guest-share-stage');
const guestShareVideo = document.getElementById('guest-share-video');
const guestShareLabel = document.getElementById('guest-share-label');

function showGuestShare(stream, name) {
  if (guestShareVideo) {
    guestShareVideo.srcObject = stream || null;
    guestShareVideo.muted = true;
    guestShareVideo.play?.().catch(() => {});
  }
  if (guestShareLabel) {
    guestShareLabel.textContent = name
      ? `${name}님 화면 공유 중 — 명단에서 호스트를 누르면 발표 화면으로 돌아갑니다`
      : '참가자 화면 공유 중';
  }
  guestShareStage?.classList.remove('hidden');
  drawCanvas?.resize();
}

function hideGuestShare() {
  if (guestShareVideo) {
    guestShareVideo.srcObject = null;
  }
  guestShareStage?.classList.add('hidden');
  drawCanvas?.resize();
}

async function returnToHostDisplay() {
  if (!sync) return;

  const prevViewer = webrtcPublisher?.relayPeerId
    || (activeBroadcasterId && activeBroadcasterId !== sync.clientId ? activeBroadcasterId : null);

  // UI는 즉시 호스트 화면으로
  hideGuestShare();
  activeBroadcasterId = sync.clientId;
  setSelectedBroadcaster(sync.clientId);

  // 참가자 화면 공유 중지 (수락 전·공유 중 모두)
  if (prevViewer) {
    try {
      await sync.emit('stop-screen-share', { clientId: prevViewer });
    } catch (err) {
      console.warn('[host] stop-screen-share', err);
    }
  }

  // 송출 트랙을 호스트 화면으로 즉시 복구
  if (webrtcPublisher) {
    try {
      await webrtcPublisher.restoreOwnDisplay();
    } catch (err) {
      console.warn('[host] restoreOwnDisplay', err);
    }
  }

  try {
    // stopClientId: stop-screen-share가 activeBroadcasterId를 먼저 비워도
    // 서버가 공유 참가자에게 중지를 다시 보낼 수 있게 함
    await sync.emit('set-broadcaster', {
      clientId: sync.clientId,
      role: 'host',
      name: hostName,
      stopClientId: prevViewer || undefined,
    });
  } catch (err) {
    console.warn('[host] set-broadcaster', err);
  }
}

async function selectParticipant({ id, role, name }) {
  if (!id || !sync) return;

  // 호스트 자신(한 번 또는 두 번 클릭) → 참가자 공유 종료 + 발표 화면 즉시 복귀
  if (role === 'host' || id === sync.clientId) {
    await returnToHostDisplay();
    return;
  }

  if (interactionMode === 'unidirectional') {
    toggleVoiceFloor(id);
    return;
  }

  if (!webrtcPublisher?.isActive) {
    alert('참가자 화면을 공유하려면 먼저 「송출」을 시작해 주세요.');
    return;
  }

  if (webrtcPublisher.relayPeerId && webrtcPublisher.relayPeerId !== id) {
    await sync.emit('stop-screen-share', { clientId: webrtcPublisher.relayPeerId });
    await webrtcPublisher.restoreOwnDisplay();
    hideGuestShare();
  }

  activeBroadcasterId = id;
  setSelectedBroadcaster(id);
  await sync.emit('request-screen-share', { clientId: id, name });
}

let floatingSpeakerManager = null;
let currentSpotlightSpeaker = {
  id: null,
  name: hostName || '호스트',
  role: 'host',
};

function updateFloatingSpeakerUi() {
  if (!floatingSpeakerManager) return;
  const isHost = (!currentSpotlightSpeaker.id || currentSpotlightSpeaker.id === sync?.clientId || currentSpotlightSpeaker.role === 'host');
  let stream = null;
  if (interactionMode === 'unidirectional') {
    stream = null;
  } else if (isHost) {
    stream = webrtcPublisher?.cameraStream || null;
  } else {
    stream = sfuCameraStreams.get(currentSpotlightSpeaker.id) || null;
  }
  floatingSpeakerManager.setSpeaker({
    id: currentSpotlightSpeaker.id,
    name: currentSpotlightSpeaker.name,
    role: currentSpotlightSpeaker.role,
    stream,
  });
}

function applySpotlightAudioVideo() {
  if (webrtcPublisher?.shareMode !== 'screen') return;
  const isHost = (!currentSpotlightSpeaker.id || currentSpotlightSpeaker.id === sync?.clientId || currentSpotlightSpeaker.role === 'host');

  webrtcPublisher?.sfu?.setVideoSourceActive?.('camera', isHost)?.catch?.(() => {});
  try {
    webrtcPublisher?.avatarManager?.setIdle?.(!isHost);
  } catch { /* ignore */ }

  for (const id of sfuCameraStreams.keys()) {
    if (!isHost && id === currentSpotlightSpeaker.id) {
      webrtcPublisher?.resumeRemoteCamera?.(id);
    } else {
      webrtcPublisher?.pauseRemoteCamera?.(id);
    }
  }
}

function handleSpotlightSelect(p) {
  const isHost = !p?.id || p?.id === sync?.clientId || p?.role === 'host';
  const targetId = isHost ? (sync?.clientId || null) : p.id;
  const targetName = isHost ? (hostName || '호스트') : (p.name || '참가자');
  const targetRole = isHost ? 'host' : 'viewer';

  currentSpotlightSpeaker = {
    id: targetId,
    name: targetName,
    role: targetRole,
  };

  setSpotlightSpeaker(targetId);
  speakingIndicator.setSpotlightSpeaker(targetId);

  sync?.emit('spotlight-speaker', {
    clientId: targetId,
    name: targetName,
    role: targetRole,
  });

  updateFloatingSpeakerUi();
  applySpotlightAudioVideo();
}

/** 단방향 발언권: 호스트 + 선택한 참가자 1명만 목소리 공유 */
let voiceFloorId = null;

function applyVoiceFloorState(clientId) {
  voiceFloorId = interactionMode === 'unidirectional' && clientId ? clientId : null;
  if (webrtcPublisher) {
    webrtcPublisher.voiceFloorId = voiceFloorId;
    if (voiceFloorId) webrtcPublisher.ensureReceiving?.().catch(() => {});
  }
  hostParticipantsGrid?.setVoiceFloor?.(voiceFloorId);
}

function toggleVoiceFloor(id) {
  if (interactionMode !== 'unidirectional' || !sync) return;
  // 모든 참가자 목소리 허용 방: 각자 마이크를 켜고 끄므로 발언권 지정이 없다
  if (allowAllVoice) return;
  const target = !id || id === 'local' || id === sync.clientId || id === voiceFloorId ? null : id;
  if (!target && !voiceFloorId) return;
  sync.emit('voice-floor', { clientId: target });
  applyVoiceFloorState(target);
  if (target) {
    const v = hostParticipantsGrid?.viewers?.find((x) => (x.id || x.clientId) === target);
    showToast(`${v?.name || '참가자'}님에게 발언권을 주었습니다. 다시 누르면 회수합니다.`, 'info', 3600);
  } else {
    showToast('발언권을 회수했습니다.', 'info', 2400);
  }
}

floatingSpeakerManager = new FloatingSpeakerManager({
  isHost: true,
  hostClientId: null,
  onResetToHost: () => {
    handleSpotlightSelect({ id: sync?.clientId || null, name: hostName, role: 'host' });
  },
});

speakingIndicator.onSpotlightVoice = (isSpeaking, level) => {
  floatingSpeakerManager?.updateVoice(isSpeaking, level);
};

setupViewersPanel({
  selectable: true,
  onSelect: (p) => { selectParticipant(p).catch((err) => console.warn(err)); },
  onSpotlight: (p) => {
    if (interactionMode === 'unidirectional') toggleVoiceFloor(p?.id);
    else handleSpotlightSelect(p);
  },
});
const uploadStatus = document.getElementById('upload-status');
const btnStream = document.getElementById('btn-stream');
const btnPen = document.getElementById('btn-pen');
const btnAvSpeaker = document.getElementById('btn-av-speaker');
const btnAvMic = document.getElementById('btn-av-mic');
const btnAvCam = document.getElementById('btn-av-cam');
const deepLiveCamModal = document.getElementById('deep-live-cam-modal');
const btnDlcClose = document.getElementById('btn-dlc-close');
const btnLaunchDlc = document.getElementById('btn-launch-dlc');
const camOverlayContainer = document.getElementById('cam-overlay-container');
const camFocusManager = new CamFocusManager({ containerId: 'cam-overlay-container' });
camFocusManager.onFocusChange = (focusedId) => {
  // 호스트 얼굴 송출은 256×144 고정 — 포커스해도 해상도 올리지 않음
  updateAvatarUi();
};
// 말하는 사람 표시: 깨끗한 목소리 감지 시 노란 테두리 + 막대그래프 (js/speaking-indicator.js)
const vadMonitor = {
  attach: (id, track) => { if (id !== 'local') speakingIndicator.trackRemote(id, track); },
  // 카메라 박스가 사라져도(그리드 전환 등) 오디오 분석은 유지 → 실제 오디오 종료 시에만 untrack
  detach: () => {},
};
speakingIndicator.start();
const tarotLounge = new TarotLoungeManager({ containerId: 'tarot-waiting-lounge', isHost: true });
const btnMeetingWait = document.getElementById('btn-meeting-wait');
const meetingStartModal = document.getElementById('meeting-start-modal');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalStart = document.getElementById('btn-modal-start');
const btnTarotStart = document.getElementById('btn-tarot-start-meeting');

const screenShareSetupModal = document.getElementById('screen-share-setup-modal');
const btnModalShareNow = document.getElementById('btn-modal-share-now');
const btnModalShareSkip = document.getElementById('btn-modal-share-skip');
const btnTarotScreenShare = document.getElementById('btn-tarot-screen-share');

function updateTarotShareButton() {
  if (!btnTarotScreenShare) return;
  const isSharing = !!webrtcPublisher?.isActive;
  btnTarotScreenShare.classList.toggle('is-active', isSharing);
  btnTarotScreenShare.textContent = isSharing ? '✅ 화면 공유 준비 완료' : '🖥️ 윈도우 화면 공유 설정';
}

btnModalShareNow?.addEventListener('click', async () => {
  screenShareSetupModal?.classList.add('hidden');
  await startScreenShare();
  updateTarotShareButton();
});

btnModalShareSkip?.addEventListener('click', () => {
  screenShareSetupModal?.classList.add('hidden');
});

btnTarotScreenShare?.addEventListener('click', async () => {
  await startScreenShare();
  updateTarotShareButton();
});

btnMeetingWait?.addEventListener('click', () => {
  meetingStartModal?.classList.remove('hidden');
});

btnTarotStart?.addEventListener('click', () => {
  meetingStartModal?.classList.remove('hidden');
});

btnModalCancel?.addEventListener('click', () => {
  meetingStartModal?.classList.add('hidden');
});

btnModalStart?.addEventListener('click', async () => {
  // 송출이 없으면 얼굴 화면으로 시작한다(PC 캡처 창이 필요 없음 → 시작이 빨라진다).
  if (!webrtcPublisher?.isActive) {
    meetingStartModal?.classList.add('hidden');
    // 단방향: 영상 미팅 모드 없이 호스트 PC 화면(전체 화면 권장)만 송출
    const uni = interactionMode === 'unidirectional';
    const ok = uni ? await startScreenShare() : await startFaceShare();
    updateTarotShareButton();
    if (!ok) {
      alert(uni
        ? '단방향 미팅은 호스트 화면 공유로 진행됩니다. 공유할 화면(전체 화면 권장)을 선택한 뒤 다시 시작해 주세요.'
        : '얼굴 화면 송출을 시작하지 못했습니다. 다시 시도해 주세요.');
      return;
    }
  }

  meetingStartModal?.classList.add('hidden');
  isMeetingStarted = true;
  if (btnMeetingWait) {
    btnMeetingWait.disabled = true;
    btnMeetingWait.textContent = '시작 중…';
  }

  // 2. 방 안의 모든 참가자(호스트+클라이언트)에게 미팅 시작 카운트다운 이벤트 전송
  try {
    sync?.socket?.emit('host-event', {
      type: 'start-meeting-countdown',
      payload: { duration: 5 },
    });
  } catch (err) {
    console.warn('[host] emit start-meeting-countdown error:', err);
  }

  // 3. 호스트 화면에서도 즉시 5,4,3,2,1 카운트다운 및 타로카드 소멸 연출
  tarotLounge.startCountdown({
    duration: 5,
    onComplete: () => {
      isMeetingStarted = true;
      tarotLounge.hide();
      btnMeetingWait?.classList.add('hidden');
      showHostMenu();
      hostParticipantsGrid.updateVisibility();
      try {
        sync?.socket?.emit('host-event', { type: 'meeting-started', payload: {} });
      } catch { /* ignore */ }
      drawCanvas?.resize();
    },
  });
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

class HostParticipantsGridManager {
  constructor({ viewEl, gridEl }) {
    this.viewEl = viewEl;
    this.gridEl = gridEl;
    this.viewers = [];
    this.streams = new Map();
    this.hostInfo = { id: 'local', name: hostName || '호스트', role: 'host' };
    this.isVisible = false;
    this.netQualities = new Map();

    if (typeof IntersectionObserver !== 'undefined' && viewEl) {
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const card = entry.target;
          const video = card.querySelector('video');
          if (!video) return;
          if (entry.isIntersecting) {
            // 화면 복귀: play만 (SFU consumer는 계속 수신 — pause 후 키프레임 공백으로 멈춤 방지)
            if (card.dataset.hasCam === '1') {
              video.play?.().catch(() => {});
            }
          } else if (this.viewEl?.classList.contains('is-overflowing') && !video.paused) {
            // 스크롤로 완전히 벗어난 카드만 element pause (디코더/패킷은 유지)
            video.pause?.();
          }
        });
      }, {
        root: this.viewEl,
        threshold: 0.01,
      });
    }

    this.checkOverflow = this.checkOverflow.bind(this);
    window.addEventListener('resize', this.checkOverflow);

    this.voiceFloorId = null;
    // 단방향: 참가자 카드 클릭 = 발언권 부여/회수 (호스트 카드 클릭 = 회수)
    this.gridEl?.addEventListener('click', (e) => {
      if (interactionMode !== 'unidirectional') return;
      const card = e.target?.closest?.('.participant-card[data-participant-id]');
      if (!card || !this.gridEl.contains(card)) return;
      toggleVoiceFloor(card.dataset.participantId);
    });
  }

  setVoiceFloor(id) {
    this.voiceFloorId = id || null;
    this.gridEl?.querySelectorAll('.participant-card[data-participant-id]').forEach((card) => {
      this._patchVoiceFloorBadge(card);
    });
  }

  _patchVoiceFloorBadge(card) {
    const on = !!this.voiceFloorId && card.dataset.participantId === this.voiceFloorId;
    card.classList.toggle('has-voice-floor', on);
    let badge = card.querySelector('.voice-floor-badge');
    if (on && !badge) {
      badge = document.createElement('span');
      badge.className = 'voice-floor-badge';
      badge.textContent = '🎤 발언 중';
      card.appendChild(badge);
    } else if (!on && badge) {
      badge.remove();
    }
  }

  checkOverflow() {
    if (!this.viewEl || !this.gridEl) return;
    const clientH = this.viewEl.clientHeight;
    if (clientH <= 0) return;

    const cards = this.gridEl.querySelectorAll('.participant-card');
    const totalCards = cards.length;
    if (totalCards <= 0) {
      this.gridEl.classList.remove('grid-5-col', 'solo-1');
      this.viewEl.classList.remove('is-overflowing');
      return;
    }

    // 1명 단독일 때: 얼굴/카드를 약 3배 크기로 대형 배치 (스포트라이트)
    const isSolo = totalCards === 1;
    this.gridEl.classList.toggle('solo-1', isSolo);

    // 9명 이하: 3명 1줄 배치 (화면 높이 초과 시 세로 스크롤)
    // 10명 이상부터: 5명씩 배치 (13명이면 5, 5, 3명 총 3줄, 50명이면 총 10줄 등)
    const is5Col = totalCards >= 10;
    this.gridEl.classList.toggle('grid-5-col', is5Col);

    // 화면 높이를 초과하면 세로 스크롤 활성화 (상단 margin-top: 50px, 하단 margin-bottom: 50px 유지)
    const isOverflowing = this.gridEl.scrollHeight > (clientH - 20);
    this.viewEl.classList.toggle('is-overflowing', isOverflowing);
  }

  updateNetworkQuality(pid, { pingMs = 30, lossRate = 0, quality = 'good' } = {}) {
    this.netQualities.set(pid, { pingMs, lossRate, quality });
    if (!this.gridEl) return;
    const card = this.gridEl.querySelector(`.participant-card[data-participant-id="${pid}"]`);
    if (!card) return;
    const pill = card.querySelector('.participant-net-pill');
    if (!pill) return;
    pill.className = `participant-net-pill net-${quality}`;
    const dot = quality === 'poor' ? '🔴' : quality === 'fair' ? '🟡' : '🟢';
    const lossText = lossRate > 1 ? ` (${lossRate}%)` : '';
    pill.textContent = `${dot} ${pingMs}ms${lossText}`;
    pill.title = `네트워크 지연시간(Ping): ${pingMs}ms / 패킷손실: ${lossRate}%`;
  }

  setHostName(name) {
    this.hostInfo.name = name || '호스트';
    this.patchCardMeta('local');
  }

  setViewers(viewers = []) {
    // 마이크 필수 방에서 마이크 검증이 안 된 참가자(admitted === false)는 아직 입장 전이므로 제외
    const next = (viewers || []).filter((v) => v && v.role !== 'host' && v.admitted !== false);
    const prevIds = new Set(this.viewers.map((v) => v.id || v.clientId));
    const nextIds = new Set(next.map((v) => v.id || v.clientId));
    this.viewers = next;

    let membershipChanged = prevIds.size !== nextIds.size;
    if (!membershipChanged) {
      for (const id of nextIds) {
        if (!prevIds.has(id)) { membershipChanged = true; break; }
      }
    }

    if (membershipChanged) {
      // 추가/삭제만 반영 — 기존 카드의 video/srcObject는 유지
      this.syncCardsIncremental();
    } else {
      // 이름 등 메타만 갱신
      for (const v of next) {
        this.patchCardMeta(v.id || v.clientId);
      }
    }
  }

  setStream(id, stream) {
    if (stream) {
      this.streams.set(id, stream);
    } else {
      this.streams.delete(id);
    }
    // 얼굴 송출 중에는 전체 재배치 없이 해당 카드 미디어만 패치
    this.patchCardMedia(id);
  }

  removeStream(id) {
    this.streams.delete(id);
    this.patchCardMedia(id);
  }

  updateVisibility() {
    const isLoungeActive = typeof tarotLounge !== 'undefined' && tarotLounge && tarotLounge.isActive;
    // 단방향도 미팅이 시작되면 참가자 카드를 계속 깔아 둔다(호스트 화면 송출에 그대로 보임)
    const shouldShow = isMeetingStarted && !isLoungeActive;
    const wasVisible = this.isVisible;
    this.isVisible = shouldShow;
    if (this.viewEl) {
      this.viewEl.classList.toggle('hidden', !shouldShow);
    }
    if (typeof camOverlayContainer !== 'undefined' && camOverlayContainer) {
      camOverlayContainer.style.display = shouldShow ? 'none' : '';
    }
    // 미팅 그리드 표시 시 PIP 디코드 완전 중단 (display:none만으로는 부족)
    if (shouldShow && typeof clearCameraPipDecoders === 'function') {
      clearCameraPipDecoders();
    }
    if (shouldShow && !wasVisible) {
      this.syncCardsIncremental();
    }
  }

  _resolveStream(pid, person = null) {
    let stream = this.streams.get(pid);
    if (!stream && person?.clientId) stream = this.streams.get(person.clientId);
    if (!stream && person?.id) stream = this.streams.get(person.id);
    if (!stream && pid === 'local') stream = this.streams.get('local');
    return stream || null;
  }

  _participantList() {
    return [this.hostInfo, ...this.viewers];
  }

  syncCardsIncremental() {
    if (!this.gridEl) return;
    if (!this.isVisible && tarotLounge?.isActive) return;

    const list = this._participantList();
    const presentIds = new Set(list.map((p) => p.id || p.clientId));

    this.gridEl.querySelectorAll('.participant-card[data-participant-id]').forEach((card) => {
      const pid = card.dataset.participantId;
      if (!presentIds.has(pid)) {
        this.observer?.unobserve(card);
        card.remove();
      }
    });

    list.forEach((p) => {
      const pid = p.id || p.clientId;
      let card = this.gridEl.querySelector(`.participant-card[data-participant-id="${pid}"]`);
      if (!card) {
        card = this._createCard(pid, p.role === 'host' || pid === 'local');
        this.gridEl.appendChild(card);
      } else if (card.parentElement !== this.gridEl) {
        this.gridEl.appendChild(card);
      }
      this.patchCardMeta(pid, p);
      this.patchCardMedia(pid, p);
      this._patchVoiceFloorBadge(card);
    });

    this.gridEl.querySelectorAll('.participant-card-empty').forEach((el) => el.remove());
    const localCard = this.gridEl.querySelector('.participant-card[data-participant-id="local"]');
    if (localCard) {
      try { hostBeautyBar?.attachToCard(localCard); } catch { /* ignore */ }
    }
    const n = list.length;
    this.gridEl.classList.toggle('solo-1', n === 1);
    this.gridEl.classList.toggle('pair-2', n === 2);
    this.gridEl.classList.toggle('grid-5-col', n >= 10);
    this._scheduleOverflowCheck();
  }

  _createCard(pid, isHost) {
    const card = document.createElement('div');
    card.className = 'participant-card';
    card.dataset.participantId = pid;
    card.dataset.speakId = pid; // 말하는 사람 표시(노란 테두리 + 막대그래프) 대상
    card.innerHTML = `
      <div class="participant-card-media"></div>
      <div class="participant-card-footer">
        <span class="participant-card-name"></span>
        <div class="participant-card-meta">
          <span class="participant-net-pill net-good">🟢 25ms</span>
          <span class="participant-cam-state"></span>
        </div>
      </div>
    `;
    if (pid === 'local') {
      try { hostBeautyBar?.attachToCard(card); } catch { /* ignore */ }
    }
    this.observer?.observe(card);
    return card;
  }

  patchCardMeta(pid, person = null) {
    if (!this.gridEl) return;
    const card = this.gridEl.querySelector(`.participant-card[data-participant-id="${pid}"]`);
    if (!card) return;
    const p = person
      || (pid === 'local' || pid === this.hostInfo.id ? this.hostInfo : null)
      || this.viewers.find((v) => (v.id || v.clientId) === pid);
    if (!p) return;
    const isHost = p.role === 'host' || pid === 'local';
    const nameEl = card.querySelector('.participant-card-name');
    if (nameEl) {
      const next = `${escapeHtml(p.name || (isHost ? '호스트' : '참가자'))} ${isHost ? '👑' : ''}`;
      if (nameEl.innerHTML !== next) nameEl.innerHTML = next;
    }
    const netPill = card.querySelector('.participant-net-pill');
    if (netPill) {
      const net = this.netQualities.get(pid) || { pingMs: 25, lossRate: 0, quality: 'good' };
      netPill.className = `participant-net-pill net-${net.quality}`;
      const dot = net.quality === 'poor' ? '🔴' : net.quality === 'fair' ? '🟡' : '🟢';
      const lossText = net.lossRate > 1 ? ` (${net.lossRate}%)` : '';
      const text = `${dot} ${net.pingMs}ms${lossText}`;
      if (netPill.textContent !== text) netPill.textContent = text;
      netPill.title = `네트워크 지연시간(Ping): ${net.pingMs}ms / 패킷손실: ${net.lossRate}%`;
    }
  }

  patchCardMedia(pid, person = null) {
    if (!this.gridEl || !this.isVisible) return;
    let card = this.gridEl.querySelector(`.participant-card[data-participant-id="${pid}"]`);
    if (!card) {
      // 스트림만 먼저 도착한 경우 카드 생성
      const p = person
        || (pid === 'local' ? this.hostInfo : null)
        || this.viewers.find((v) => (v.id || v.clientId) === pid);
      if (!p && pid !== 'local') return;
      card = this._createCard(pid, pid === 'local' || p?.role === 'host');
      this.gridEl.appendChild(card);
      this.patchCardMeta(pid, p || this.hostInfo);
      this._scheduleOverflowCheck();
    }

    const stream = this._resolveStream(pid, person);
    const hasCam = !!stream && stream.getVideoTracks().some((t) => t && t.readyState === 'live' && t.enabled !== false);
    const isHost = pid === 'local' || person?.role === 'host' || this.hostInfo.id === pid;
    card.dataset.hasCam = hasCam ? '1' : '0';

    const camStateEl = card.querySelector('.participant-cam-state');
    if (camStateEl) {
      camStateEl.className = `participant-cam-state ${hasCam ? 'is-on' : 'is-off'}`;
      const label = hasCam ? '● LIVE' : '✕ OFF';
      if (camStateEl.textContent !== label) camStateEl.textContent = label;
    }

    const mediaEl = card.querySelector('.participant-card-media');
    if (!mediaEl) return;

    if (hasCam) {
      let video = mediaEl.querySelector('video');
      if (!video) {
        mediaEl.innerHTML = '';
        video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.defaultMuted = true;
        video.className = `participant-card-video${isHost ? ' is-mirror' : ''}`;
        video.srcObject = stream;
        video.play?.().catch(() => {});
            if (!isHost) {
              attachVideoFreezeWatchdog(video, {
                label: `grid-${pid}`,
                mode: 'face',
                onRequestKeyFrame: () => {
                  if (webrtcPublisher?.shareMode === 'screen') return; // PC 화면 모드: 참가자 얼굴 송출이 꺼진 상태가 정상
                  const cid = webrtcPublisher?.sfu?.findConsumerIdForClient?.(pid, 'viewer-camera')
                    || webrtcPublisher?.sfu?.findConsumerIdForClient?.(pid);
                  if (cid) webrtcPublisher?.sfu?.requestKeyFrame?.(cid);
                },
              });
            }
        mediaEl.appendChild(video);
      } else if (video.srcObject !== stream) {
        video.srcObject = stream;
        video.muted = true;
        video.defaultMuted = true;
        video.play?.().catch(() => {});
      }
    } else if (!mediaEl.querySelector('.participant-card-cam-off')) {
      mediaEl.innerHTML = `
        <div class="participant-card-cam-off">
          <div class="cam-off-icon-box" title="카메라 꺼짐">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m4 0h5a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path>
              <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>
          </div>
          <span class="cam-off-badge">카메라 꺼짐</span>
        </div>
      `;
    }
  }

  _scheduleOverflowCheck() {
    if (this._overflowRaf) cancelAnimationFrame(this._overflowRaf);
    this._overflowRaf = requestAnimationFrame(() => {
      this._overflowRaf = 0;
      this.checkOverflow();
    });
  }

  getTiles() {
    return this._participantList().map((p) => {
      const pid = p.id || p.clientId;
      const card = this.gridEl?.querySelector(`.participant-card[data-participant-id="${pid}"]`);
      const video = card?.querySelector('video') || null;
      const stream = this._resolveStream(pid, p);
      const hasCam = !!stream && stream.getVideoTracks().some((t) => t && t.readyState === 'live' && t.enabled !== false);
      const vis = speakingIndicator.getVisual?.(pid) || {};
      return {
        id: pid,
        name: p.name || (p.role === 'host' || pid === 'local' ? '호스트' : '참가자'),
        isHost: p.role === 'host' || pid === 'local',
        video: hasCam ? video : null,
        hasCam,
        speaking: !!vis.speaking,
        level: vis.level || 0,
        bands: vis.bands || null,
      };
    });
  }

  render() {
    // 하위 호환: 전체 동기화는 증분 경로로 통일
    this.syncCardsIncremental();
  }
}

const hostParticipantsView = document.getElementById('host-participants-view');
const hostParticipantsGridEl = document.getElementById('host-participants-grid');
hostParticipantsGrid = new HostParticipantsGridManager({
  viewEl: hostParticipantsView,
  gridEl: hostParticipantsGridEl,
});
const hostBeautyBar = new HostBeautyBarManager({
  getAvatarManager: () => webrtcPublisher?.avatarManager || null,
  getSocket: () => sync?.socket || null,
});
hostParticipantsGrid.updateVisibility();

if (!isMeetingStarted) {
  tarotLounge.show();
  tarotLounge.renderParticipants([{ id: 'local', name: hostName, role: 'host' }]);
  btnMeetingWait?.classList.remove('hidden');
}


function clearCameraPipDecoders() {
  if (!camOverlayContainer) return;
  camOverlayContainer.querySelectorAll('video').forEach((v) => {
    try {
      v.srcObject = null;
      v.removeAttribute('src');
      v.load?.();
    } catch { /* ignore */ }
  });
}

function updateCameraPip(id, stream, { label = '카메라', isMirror = false, isHost = false } = {}) {
  if (!camOverlayContainer) return;
  // 미팅 그리드가 보이는 동안에는 PIP에 붙이지 않음 (이중 디코드 방지)
  if (hostParticipantsGrid?.isVisible) {
    removeCameraPip(id);
    return;
  }
  let box = document.getElementById(`cam-box-${id}`);
  if (!stream) {
    removeCameraPip(id);
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
    video.className = `cam-pip-video${isMirror ? ' is-mirror' : ''}`;
    const badge = document.createElement('span');
    badge.className = `cam-pip-badge${isHost ? ' is-host' : ''}`;
    badge.textContent = label;
    box.appendChild(video);
    box.appendChild(badge);

    if (id !== 'local') {
      attachVideoFreezeWatchdog(video, {
        label: `pip-${id}`,
        onRequestKeyFrame: () => {
          const cid = webrtcPublisher?.sfu?.findConsumerIdForClient?.(id, 'viewer-camera')
            || webrtcPublisher?.sfu?.findConsumerIdForClient?.(id);
          if (cid) webrtcPublisher?.sfu?.requestKeyFrame?.(cid);
        },
      });
    }

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
        const avMgr = webrtcPublisher?.avatarManager;
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

const streamOptionsGate = document.getElementById('stream-options-gate');
const optStreamMic = document.getElementById('opt-stream-mic');
const btnStreamStart = document.getElementById('btn-stream-start');
const btnStreamCancel = document.getElementById('btn-stream-cancel');

const TAB_AUDIO_PREF_KEY = 'yunseulStreamTabAudio';

let preferTabAudio = sessionStorage.getItem(TAB_AUDIO_PREF_KEY) !== '0';

function setStatus(msg) {
  if (uploadStatus && msg) uploadStatus.textContent = msg;
}

function syncPenUi(active) {
  if (!btnPen) return;
  btnPen.classList.toggle('is-active', !!active);
  btnPen.setAttribute('aria-pressed', active ? 'true' : 'false');
  btnPen.title = active
    ? '펜 끄기 — 화면 위 그리기 끄기'
    : '펜 켜기 — 화면 위 그리기';
  document.body.classList.toggle('pen-mode', !!active);
  if (drawCanvas?.canvas) {
    drawCanvas.canvas.style.pointerEvents = active ? 'auto' : 'none';
  }
  drawCanvas?.setDrawingEnabled(active);
  clearLinkHoverCursor();
}

function syncAvButtons() {
  const speakerOn = webrtcPublisher ? !!webrtcPublisher.speakerOn : true;
  const isReqMic = interactionMode === 'bidirectional' && requireMic;
  // 실제 상태만 표시한다(필수 방이라고 해서 켜진 것처럼 꾸미지 않음).
  // 필수 방에서는 검증·송출이 끝나기 전까지는 비활성 → 끝나면 항상 활성.
  const micOn = !!micCtl?.enabled;
  const camOn = !!(webrtcPublisher?.cameraWanted && webrtcPublisher?.hasCamera && webrtcPublisher?.cameraEnabled);

  if (btnAvSpeaker) {
    btnAvSpeaker.classList.toggle('is-active', !!speakerOn);
    btnAvSpeaker.setAttribute('aria-pressed', speakerOn ? 'true' : 'false');
    btnAvSpeaker.title = speakerOn
      ? '소리 켜짐 — 클릭하여 끄기'
      : '소리 꺼짐 — 클릭하여 켜기';
  }
  if (btnAvMic) {
    btnAvMic.classList.toggle('is-active', !!micOn);
    btnAvMic.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    btnAvMic.title = micOn
      ? (isReqMic ? '마이크 켜짐 (마이크 필수 모임 — 끌 수 없음)' : '마이크 켜짐 — 클릭하여 끄기')
      : (micCtl?.state === 'none' ? '마이크를 사용할 수 없습니다 — 클릭하여 다시 시도' : '마이크 꺼짐 — 클릭하여 켜기');
  }
  const btnMicDev = document.getElementById('btn-av-mic-device');
  if (btnMicDev) btnMicDev.classList.toggle('hidden', !micCtl);
  if (btnAvCam) {
    btnAvCam.classList.toggle('is-active', !!camOn);
    btnAvCam.setAttribute('aria-pressed', camOn ? 'true' : 'false');
    btnAvCam.title = camOn ? '카메라 켜짐 — 클릭하여 끄기' : '카메라 꺼짐 — 클릭하여 켜기';
  }
  if (optStreamMic) optStreamMic.checked = !!micCtl?.enabled;
  updateAvatarUi();
  emitCamStatus();
}

function onAvatarRandomClick() {
  if (!webrtcPublisher?.avatarManager) return;
  webrtcPublisher.avatarManager.nextAvatar();
  updateAvatarUi();
}

async function applyFaceAndStartCamera(faceApplyFn) {
  closeDeepLiveCamModal();
  if (!webrtcPublisher) return;

  const camAlreadyActive = !!(webrtcPublisher?.cameraWanted && webrtcPublisher?.hasCamera && webrtcPublisher?.cameraEnabled);

  if (camAlreadyActive) {
    const avMgr = webrtcPublisher.avatarManager;
    if (avMgr && typeof faceApplyFn === 'function') {
      faceApplyFn(avMgr);
    }
    updateAvatarUi();
  } else {
    btnAvCam.disabled = true;
    try {
      const avMgr = webrtcPublisher.avatarManager;
      if (avMgr && typeof faceApplyFn === 'function') {
        faceApplyFn(avMgr);
      }
      const ok = await webrtcPublisher.ensureCamera(true);
      if (!ok) {
        // 물리적 카메라가 없는 경우 실사 사진 아바타 카메라 시작 시도
        const virtOk = await webrtcPublisher.startVirtualCamera();
        if (virtOk) {
          showAvToast('카메라 미감지: AI 사진 아바타로 방송');
          updateAvatarUi();
          return;
        }
        alert('카메라를 켤 수 없습니다. 브라우저 카메라 권한 및 연결을 확인해 주세요.');
        return;
      }
      if (avMgr && typeof faceApplyFn === 'function') {
        faceApplyFn(avMgr);
      }
      updateAvatarUi();
    } catch (err) {
      alert(`카메라 시작 실패: ${err?.message || err}`);
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
    const avMgr = webrtcPublisher?.avatarManager;
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
  loadModalPhotos();
  deepLiveCamModal?.classList.remove('hidden');
}

function closeDeepLiveCamModal() {
  deepLiveCamModal?.classList.add('hidden');
}

function updateAvatarUi() {
  const avMgr = webrtcPublisher?.avatarManager;
  const camOn = !!(webrtcPublisher?.cameraWanted && webrtcPublisher?.hasCamera && webrtcPublisher?.cameraEnabled);

  // 카메라 활성화 시 상단 툴바에 얼굴 효과 버튼 표시
  const btnFaceEffect = document.getElementById('btn-face-effect');
  if (btnFaceEffect) {
    if (camOn) {
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
      pillHd.disabled = false;
      pillHd.classList.toggle('is-active', mode === 'high' || mode === 'solo');
      pillHd.textContent = pill.label;
      pillHd.title = pill.title;
    }

    const badge = localBox.querySelector('.cam-pip-badge');
    if (badge) {
      const hName = hostName || '호스트';
      if (isSwap) {
        const key = avMgr.activeSwapFace;
        const heroLabel = key === 'superman' ? '슈퍼맨' : (key === 'batman' ? '배트맨' : (key === 'spiderman' ? '스파이더맨' : (key === 'real' || key === 'none' ? '원래 내 얼굴' : key)));
        badge.textContent = `${hName} (⚡ AI 얼굴: ${heroLabel})`;
      } else if (isReal) {
        badge.textContent = `${hName} (원래 내 얼굴)`;
      } else {
        badge.textContent = `${hName} (✨ ${avMgr.currentAvatar?.name || '가상'})`;
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

async function toggleCamera() {
  if (!webrtcPublisher) return;
  const camAlreadyActive = !!(webrtcPublisher.cameraWanted && webrtcPublisher.hasCamera && webrtcPublisher.cameraEnabled);
  if (camAlreadyActive) {
    btnAvCam.disabled = true;
    await webrtcPublisher.ensureCamera(false);
    btnAvCam.disabled = false;
    syncAvButtons();
    return;
  }
  // 카메라 비활성 상태일 때: 바로 영상 송출하지 않고 얼굴 선택 모달 오픈
  openDeepLiveCamModal();
}

btnAvCam?.addEventListener('click', toggleCamera);

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
  updateTarotShareButton();
}

function hideSharePrompt() {
  document.getElementById('upload-panel')?.classList.add('hidden');
  showHostMenu();
}

function isMobileHostEnv() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (window.matchMedia && window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches);
}

function canDisplayCapture() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}

function configureSharePromptUi() {
  const title = document.getElementById('share-prompt-title');
  const desc = document.getElementById('share-prompt-desc');
  const shareBtn = document.getElementById('btn-share-now');
  const camBtn = document.getElementById('btn-camera-share');
  const mobile = isMobileHostEnv();
  const hasDisplay = canDisplayCapture();

  if (camBtn) camBtn.classList.toggle('hidden', !(mobile || !hasDisplay));
  if (shareBtn) {
    shareBtn.classList.toggle('hidden', !hasDisplay);
    if (!hasDisplay) shareBtn.classList.add('hidden');
  }

  if (mobile || !hasDisplay) {
    if (title) title.textContent = '송출 시작';
    if (desc) {
      desc.textContent = hasDisplay
        ? '휴대폰에서는 화면 공유가 제한될 수 있습니다. 카메라로 송출하거나, 지원되면 화면 공유를 선택하세요.'
        : '이 기기에서는 화면 공유를 지원하지 않습니다. 카메라로 송출해 주세요.';
    }
  } else {
    if (title) title.textContent = '화면 공유';
    if (desc) desc.textContent = '공유할 화면·창을 선택하면 참가자에게 바로 송출됩니다.';
  }
}

function showSharePrompt(msg) {
  const panel = document.getElementById('upload-panel');
  const status = document.getElementById('upload-status');
  configureSharePromptUi();
  panel?.classList.remove('hidden');
  if (status) status.textContent = msg || '';
}

/** 페이지 진입 즉시 패널 숨김 — 공유 창 뜨기 전 PPT/안내 깜빡임 방지 */
document.getElementById('upload-panel')?.classList.add('hidden');

/** 호스트 툴바(그리기·마이크·송출 등) 표시 */
function showHostMenu() {
  document.body.classList.add('has-presentation');
  window.YunseulToolbar?.showTools?.();
  syncAvButtons();
}

function openStreamOptions() {
  // 모바일은 안내 패널에서 카메라/화면공유를 고르게 함
  if (isMobileHostEnv() || !canDisplayCapture()) {
    showSharePrompt('');
    return;
  }
  startScreenShare();
}

function closeStreamOptions() {
  streamOptionsGate?.classList.add('hidden');
}

function emitDisplayMode(mode) {
  try {
    sync?.socket?.emit('host-event', { type: 'display-mode', payload: { mode } });
  } catch (err) {
    console.warn('[host] display-mode', err);
  }
}

function updateShareModeUi(mode) {
  const wrap = document.getElementById('share-mode-toggle');
  const faceBtn = document.getElementById('btn-share-face');
  const pcBtn = document.getElementById('btn-share-pc');
  const on = mode === 'face' || mode === 'screen';
  // 단방향: 영상 미팅(얼굴 화면) 전환 없음 — 화면 공유가 끊겨 얼굴 화면으로 대체된 경우에만 「PC 화면」 복귀 버튼 표시
  const uni = interactionMode === 'unidirectional';
  if (wrap) wrap.hidden = !on || (uni && mode === 'screen');
  if (faceBtn) faceBtn.style.display = uni ? 'none' : '';
  faceBtn?.classList.toggle('is-active', mode === 'face');
  pcBtn?.classList.toggle('is-active', mode === 'screen');
  if (faceBtn) faceBtn.setAttribute('aria-pressed', mode === 'face' ? 'true' : 'false');
  if (pcBtn) pcBtn.setAttribute('aria-pressed', mode === 'screen' ? 'true' : 'false');
}

function applyShareMode(mode) {
  const screen = mode === 'screen';
  const isHost = (!currentSpotlightSpeaker.id || currentSpotlightSpeaker.id === sync?.clientId || currentSpotlightSpeaker.role === 'host');

  try {
    webrtcPublisher?.avatarManager?.setIdle?.(screen && !isHost);
  } catch { /* ignore */ }

  webrtcPublisher?.sfu?.setVideoSourceActive?.('camera', !screen || isHost)?.catch?.(() => {});

  for (const id of sfuCameraStreams.keys()) {
    if (screen) {
      if (!isHost && id === currentSpotlightSpeaker.id) {
        webrtcPublisher?.resumeRemoteCamera?.(id);
      } else {
        webrtcPublisher?.pauseRemoteCamera?.(id);
      }
    } else {
      webrtcPublisher?.resumeRemoteCamera?.(id);
    }
  }
  if (screen) faceFeed?.reportLive?.([]);
  updateShareModeUi(mode);
  emitDisplayMode(mode === 'screen' ? 'screen' : 'face');

  // 단방향: 호스트 화면엔 참가자 카드만 — 호스트 얼굴 미니창은 클라이언트에만 띄운다
  floatingSpeakerManager?.setSharingActive(screen && interactionMode !== 'unidirectional');
  if (screen) {
    updateFloatingSpeakerUi();
  }
}

async function startFaceShare() {
  if (!sync?.socket || !webrtcPublisher) {
    alert('방에 아직 연결되지 않았습니다.');
    return false;
  }
  closeStreamOptions();
  if (btnStream) {
    btnStream.disabled = true;
    btnStream.textContent = '얼굴 화면 준비…';
  }
  try {
    webrtcPublisher.getFaceTiles = () => hostParticipantsGrid?.getTiles?.() || [];
    await webrtcPublisher.startFaceShare();
    updateStreamUi(true, !!micCtl?.enabled);
    hideSharePrompt();
    drawCanvas?.resize();
    const ids = [...knownViewerIds];
    if (ids.length) await webrtcPublisher.publishTo(ids);
    applyShareMode('face');
    showToast('얼굴 화면을 송출합니다. PC 화면이 필요하면 「PC 화면」을 누르세요.', 'info', 4200);
    return true;
  } catch (err) {
    console.warn('[face-share]', err);
    updateStreamUi(!!webrtcPublisher?.isActive, !!micCtl?.enabled);
    showToast(err?.message || '얼굴 화면을 시작할 수 없습니다.', 'error', 4200);
    return false;
  } finally {
    if (btnStream) {
      btnStream.disabled = false;
      btnStream.textContent = webrtcPublisher?.isActive ? '정지' : '송출';
    }
    syncAvButtons();
  }
}

async function startScreenShare() {
  if (!sync?.socket || !webrtcPublisher) {
    alert('방에 아직 연결되지 않았습니다.');
    return false;
  }
  if (!canDisplayCapture()) {
    showSharePrompt('이 기기에서는 화면 공유를 지원하지 않습니다. 「카메라로 송출」을 사용해 주세요.');
    return false;
  }
  // 마이크는 MicController 가 화면 송출과 독립적으로 관리한다(마이크 토글이 영상에 영향 없음)
  const withMic = false;
  const withTabAudio = preferTabAudio !== false;
  closeStreamOptions();

  if (btnStream) {
    btnStream.disabled = true;
    btnStream.textContent = '공유 창 선택…';
  }
  const shareBtn = document.getElementById('btn-share-now');
  if (shareBtn) {
    shareBtn.disabled = true;
    shareBtn.textContent = '공유 창 선택…';
  }
  try {
    await webrtcPublisher.startDisplayCapture({ withMic, withTabAudio });
    updateStreamUi(true, !!micCtl?.enabled);
    hideSharePrompt();
    drawCanvas?.resize();
    const ids = [...knownViewerIds];
    // SFU 단일 경로: produce 재확인
    if (ids.length) await webrtcPublisher.publishTo(ids);
    applyShareMode('screen');
    showToast(interactionMode === 'unidirectional'
      ? '호스트 화면을 송출합니다. 다른 화면을 보여주려면 이 창을 내리고 PC 화면을 띄우세요.'
      : 'PC 화면을 송출합니다. 참가자 얼굴은 잠시 멈추고, 목소리는 그대로입니다.', 'info', 4200);
    return true;
  } catch (err) {
    console.warn('[stream]', err);
    const stillOn = !!webrtcPublisher?.isActive;
    updateStreamUi(stillOn, !!micCtl?.enabled);
    if (stillOn && webrtcPublisher?.shareMode === 'face') applyShareMode('face');
    const cancelled = /Permission|NotAllowed|Abort|cancel/i.test(String(err?.name || '') + String(err?.message || ''));
    const unsupported = /NotSupported|undefined|getDisplayMedia/i.test(String(err?.name || '') + String(err?.message || ''));
    if (!stillOn) {
      showSharePrompt(cancelled
        ? '화면 공유가 취소되었습니다. 아래 버튼으로 다시 시작해 주세요.'
        : (unsupported
          ? '이 기기에서는 화면 공유가 어렵습니다. 「카메라로 송출」을 사용해 주세요.'
          : (err?.message || '화면 송출을 시작할 수 없습니다.')));
    } else if (cancelled) {
      showToast('PC 화면 선택이 취소되어 얼굴 화면을 유지합니다.', 'warn', 3200);
    }
    if (!stillOn && !cancelled && !isMobileHostEnv() && !unsupported) {
      alert(`화면 송출을 시작할 수 없습니다.\n${err?.message || ''}`);
    }
    return false;
  } finally {
    if (btnStream) {
      btnStream.disabled = false;
      btnStream.textContent = webrtcPublisher?.isActive ? '정지' : '송출';
    }
    if (shareBtn) {
      shareBtn.disabled = false;
      shareBtn.textContent = '화면 공유 시작';
    }
    syncAvButtons();
  }
}

async function startCameraShare() {
  if (!sync?.socket || !webrtcPublisher) {
    alert('방에 아직 연결되지 않았습니다.');
    return false;
  }
  const withMic = false;
  closeStreamOptions();

  if (btnStream) {
    btnStream.disabled = true;
    btnStream.textContent = '카메라 준비…';
  }
  const camBtn = document.getElementById('btn-camera-share');
  if (camBtn) {
    camBtn.disabled = true;
    camBtn.textContent = '카메라 준비…';
  }
  try {
    await webrtcPublisher.startCameraCapture({ withMic, facingMode: 'environment' });
    updateStreamUi(true, !!micCtl?.enabled);
    hideSharePrompt();
    drawCanvas?.resize();
    const ids = [...knownViewerIds];
    if (ids.length) await webrtcPublisher.publishTo(ids);
    return true;
  } catch (err) {
    console.warn('[camera-stream]', err);
    updateStreamUi(false);
    const cancelled = /Permission|NotAllowed|Abort|cancel/i.test(String(err?.name || '') + String(err?.message || ''));
    showSharePrompt(cancelled
      ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용한 뒤 다시 시도해 주세요.'
      : (err?.message || '카메라 송출을 시작할 수 없습니다.'));
    return false;
  } finally {
    if (btnStream && !webrtcPublisher?.isActive) {
      btnStream.disabled = false;
      btnStream.textContent = '송출';
    }
    if (camBtn) {
      camBtn.disabled = false;
      camBtn.textContent = '카메라로 송출';
    }
    syncAvButtons();
  }
}

function stopScreenShare() {
  webrtcPublisher?.stop();
  updateStreamUi(false);
  showSharePrompt('송출이 중지되었습니다. 다시 화면을 공유해 주세요.');
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
  if (!micCtl) return;
  if (btnAvMic) btnAvMic.disabled = true;
  try {
    await micCtl.toggle();
  } finally {
    if (btnAvMic) btnAvMic.disabled = false;
    syncAvButtons();
  }
}

/** 서버에 현재 마이크 상태 재통지 (재접속/새 소켓 후) */
function emitMicStatus() {
  try { micCtl?._emit?.(); } catch { /* ignore */ }
}

/** 서버에 현재 카메라 상태 재통지 (재접속/장치변경/토글 등) */
async function emitCamStatus() {
  if (!sync?.socket) return;
  const camOn = !!(webrtcPublisher?.cameraWanted && webrtcPublisher?.hasCamera && webrtcPublisher?.cameraEnabled);
  let state = camOn ? 'on' : 'off';
  if (!camOn) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      state = 'none';
    } else {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const hasVideo = devs.some((d) => d.kind === 'videoinput');
        state = hasVideo ? 'off' : 'none';
      } catch {
        state = 'none';
      }
    }
  }
  try { sync.socket.emit('cam-status', { state }); } catch { /* ignore */ }
}

function setupHostMic() {
  if (micCtl || !webrtcPublisher || !sync) return;
  const isReq = interactionMode === 'bidirectional' && requireMic;
  micCtl = new MicController({
    role: 'host',
    clientId: sync.clientId,
    speakIds: ['local', sync.clientId],
    source: 'mic',
    getSfu: () => webrtcPublisher._ensureSfu(),
    socket: sync.socket,
    requireMic: isReq,
    onChange: () => syncAvButtons(),
    onForced: () => showToast('마이크 사용이 필수인 모임입니다. 마이크를 끌 수 없습니다.', 'warn', 4200),
    onNotice: (msg, kind) => showToast(msg, kind === 'error' ? 'error' : 'warn', 5200),
    onLeave: () => { window.location.href = './'; },
    onTrack: (track) => {
      try { webrtcPublisher?.avatarManager?.attachMicTrack(track || null); } catch { /* ignore */ }
      try { webrtcPublisher?.onMicTrack?.(track || null); } catch { /* ignore */ }
    },
  });
  sync.socket.on?.('connect', () => {
    emitMicStatus();
    emitCamStatus();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => emitCamStatus());
  micCtl._emit(); // 초기 상태(off / ready=false) 통지 → 아이콘은 비활성으로 시작
  emitCamStatus();
  syncAvButtons();
  if (isReq) {
    // 필수 방: 검증 대화상자(필요 시) → 자동 ON
    micCtl.enable().finally(() => syncAvButtons());
  }
}

document.getElementById('btn-av-mic-device')?.addEventListener('click', async () => {
  if (!micCtl) return;
  await micCtl.openSettings();
  syncAvButtons();
});

btnStream?.addEventListener('click', () => {
  if (webrtcPublisher?.isActive) stopScreenShare();
  else if (isMobileHostEnv() || !canDisplayCapture()) showSharePrompt('');
  else if (interactionMode === 'unidirectional') startScreenShare();
  else startFaceShare();
});

btnStreamCancel?.addEventListener('click', () => closeStreamOptions());
btnStreamStart?.addEventListener('click', () => startFaceShare());
document.getElementById('btn-share-now')?.addEventListener('click', () => startScreenShare());
document.getElementById('btn-share-face')?.addEventListener('click', () => {
  if (webrtcPublisher?.shareMode === 'face' && webrtcPublisher?.isActive) return;
  startFaceShare();
});
document.getElementById('btn-share-pc')?.addEventListener('click', () => {
  if (webrtcPublisher?.shareMode === 'screen' && webrtcPublisher?.isActive) return;
  startScreenShare();
});
document.getElementById('btn-camera-share')?.addEventListener('click', () => startCameraShare());

optStreamMic?.addEventListener('change', async () => {
  if (!micCtl) { optStreamMic.checked = false; return; }
  if (optStreamMic.checked) await micCtl.enable();
  else await micCtl.disable();
  syncAvButtons();
});

btnAvSpeaker?.addEventListener('click', () => {
  if (!webrtcPublisher) {
    syncAvButtons();
    return;
  }
  webrtcPublisher.setSpeakerEnabled(!webrtcPublisher.speakerOn);
  syncAvButtons();
});
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
  const currentActive = document.body.classList.contains('pen-mode');
  const next = !currentActive;
  overlayManager.setPenMode(next);
  syncPenUi(next);
  if (next) {
    drawCanvas.setEraser(false);
  }
});

function openSyncedLink(data) {
  if (!data?.url) return;
  // iframe/팝업 동기화 없음 — 새 창만 열고 화면 송출에 맡김
  try {
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('[host] open link', err);
  }
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

// 기본: 펜 비활성화 (아이콘 클릭 시에만 활성화)
overlayManager.setPenMode(false);
syncPenUi(false);

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
  document.body.classList.add('has-ppt');
  showHostMenu();
  const engine = getPptEngine();
  if (engine) {
    const size = engine.getSlideSize();
    drawCanvas.setSlideSize(size.width, size.height);
    drawCanvas.resize();
    drawCanvas.setSlide(0);
    syncSlideAudio(0).catch((err) => console.warn('[slide-audio]', err));
  }
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

// 메타·미디어 백그라운드 준비 완료 → BGM/오디오 재동기화
window.addEventListener('ppt-enriched', () => {
  const engine = getPptEngine();
  const idx = engine?.getCurrentSlide?.() ?? 0;
  syncSlideAudio(idx).catch((err) => console.warn('[slide-audio]', err));
});

document.getElementById('pen-color')?.addEventListener('input', (e) => {
  drawCanvas.setPenColor(e.target.value);
});
document.getElementById('pen-size')?.addEventListener('input', (e) => {
  drawCanvas.setPenSize(parseInt(e.target.value, 10));
});
document.getElementById('btn-eraser')?.addEventListener('click', () => {
  drawCanvas.setEraser(true);
  overlayManager.setPenMode(true);
  syncPenUi(true);
});
document.getElementById('btn-clear-slide')?.addEventListener('click', () => {
  const engine = getPptEngine();
  const idx = engine ? engine.getCurrentSlide() : 0;
  drawCanvas.clearSlide(idx);
  sync?.emit('clear-drawings', { slideIndex: idx });
});
document.getElementById('btn-clear-all')?.addEventListener('click', () => {
  drawCanvas.clearAll();
  sync?.emit('clear-all-drawings');
});

window.addEventListener('resize', () => drawCanvas?.resize());

let onEventLastCount = null;
sync = new RoomSync({
  code: roomCode,
  role: 'host',
  hostToken,
  name: hostName,
  onEvent: (type, payload) => {
    if (type === 'viewer-count') {
      setViewerCount(payload.count ?? 0, payload.viewers, {
        activeBroadcasterId: payload.activeBroadcasterId ?? activeBroadcasterId,
      });
      (payload.viewers || []).forEach((v) => {
        if (v?.id && v.role !== 'host') knownViewerIds.add(v.id);
      });
      hostParticipantsGrid.setViewers(payload.viewers || []);
      // count = 호스트+참가자 총원 → 1명 solo HQ / 2명+ multi LQ
      // 마이크 on/off 등 상태 변화에도 viewer-count 가 오므로, 인원수가 바뀔 때만 화질 재계산
      if (payload.count !== onEventLastCount) {
        onEventLastCount = payload.count;
        webrtcPublisher?.setFaceQualityByRoomSize?.(payload.count ?? 1).catch?.(() => {});
      }
      if (tarotLounge.isActive && !tarotLounge._isCountingDown) {
        tarotLounge.renderParticipants(payload.viewers || []);
      }
    }
    if (type === 'start-meeting-countdown') {
      isMeetingStarted = true;
      if (btnMeetingWait) btnMeetingWait.classList.add('hidden');
      tarotLounge.startCountdown({
        duration: payload?.duration || 5,
        onComplete: () => {
          isMeetingStarted = true;
          tarotLounge.hide();
          btnMeetingWait?.classList.add('hidden');
          showHostMenu();
          drawCanvas?.resize();
          hostParticipantsGrid.updateVisibility();
          webrtcPublisher?.ensureReceiving?.().catch(() => {});
          if (!webrtcPublisher?.isActive) {
            startScreenShare().catch((e) => console.warn('[host] startScreenShare', e));
          }
        },
      });
    }
    if (type === 'broadcaster-changed') {
      activeBroadcasterId = payload.clientId || sync?.clientId;
      setSelectedBroadcaster(activeBroadcasterId);
    }
    if (type === 'screen-share-ended') {
      if (webrtcPublisher?.relayPeerId === payload.clientId) {
        webrtcPublisher.restoreOwnDisplay().catch(() => {});
        hideGuestShare();
      }
    }
    if (type === 'voice-floor') {
      applyVoiceFloorState(payload?.clientId || null);
    }
    if (type === 'spotlight-speaker') {
      const isHost = (!payload?.clientId || payload.clientId === sync?.clientId || payload?.role === 'host');
      currentSpotlightSpeaker = {
        id: isHost ? (sync?.clientId || null) : payload.clientId,
        name: isHost ? (hostName || '호스트') : (payload.name || '참가자'),
        role: isHost ? 'host' : 'viewer',
      };
      setSpotlightSpeaker(currentSpotlightSpeaker.id);
      speakingIndicator.setSpotlightSpeaker(currentSpotlightSpeaker.id);
      updateFloatingSpeakerUi();
      applySpotlightAudioVideo();
    }
  },
  // 재연결 후 3차 안전망: SFU 프로듀서 검증 및 송출 보장
  onRejoined: (data) => {
    const serverStarted = !!data?.state?.meetingStarted;
    if (serverStarted) {
      isMeetingStarted = true;
    }
    // 서버에는 없는데 로컬만 미팅 중 → 서버에 한 번 맞춤 (중복 카운트다운 유발 방지)
    if (isMeetingStarted && !serverStarted) {
      tarotLounge.hide();
      btnMeetingWait?.classList.add('hidden');
      try {
        sync?.socket?.emit('host-event', { type: 'meeting-started', payload: {} });
      } catch { /* ignore */ }
    } else if (isMeetingStarted) {
      tarotLounge.hide();
      btnMeetingWait?.classList.add('hidden');
    }
    if (webrtcPublisher?.isActive) {
      console.log('[host] reconnected & rejoined -> ensuring publication...');
      webrtcPublisher.ensurePublished?.();
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
    if (data.state) allowAllVoice = !!data.state.allowAllVoice;
    if (data.state?.interactionMode || data.state?.requireMic !== undefined) {
      applyInteractionMode(data.state?.interactionMode || interactionMode, !!data.state?.requireMic);
    }
    activeBroadcasterId = data.state?.activeBroadcasterId || sync.clientId;
    setViewerCount(data.state?.viewerCount ?? 0, data.state?.viewers, {
      activeBroadcasterId,
    });
    (data.state?.viewers || []).forEach((v) => {
      if (v?.id && v.role !== 'host') knownViewerIds.add(v.id);
    });

    if (floatingSpeakerManager) {
      floatingSpeakerManager.hostClientId = sync.clientId;
    }
    if (data.state?.spotlightSpeakerId) {
      const isHost = (!data.state.spotlightSpeakerId || data.state.spotlightSpeakerId === sync.clientId || data.state.spotlightSpeakerRole === 'host');
      currentSpotlightSpeaker = {
        id: isHost ? sync.clientId : data.state.spotlightSpeakerId,
        name: data.state.spotlightSpeakerName || (isHost ? hostName : '참가자'),
        role: isHost ? 'host' : (data.state.spotlightSpeakerRole || 'viewer'),
      };
      setSpotlightSpeaker(currentSpotlightSpeaker.id);
      speakingIndicator.setSpotlightSpeaker(currentSpotlightSpeaker.id);
    }

    isMeetingStarted = !!data.state?.meetingStarted;
    if (!isMeetingStarted) {
      tarotLounge.show();
      const initialViewers = data.state?.viewers || [];
      if (!initialViewers.some((v) => v.role === 'host')) {
        initialViewers.unshift({ id: sync.clientId, name: hostName, role: 'host' });
      }
      tarotLounge.renderParticipants(initialViewers);
      btnMeetingWait?.classList.remove('hidden');
    } else {
      tarotLounge.hide();
      btnMeetingWait?.classList.add('hidden');
    }
    hostParticipantsGrid.setViewers(data.state?.viewers || []);
    hostParticipantsGrid.updateVisibility();
    applyVoiceFloorState(data.state?.voiceFloorId || null);


    if (data.drawings) drawCanvas.loadStrokes(data.drawings);
    if (data.state?.presentation && getPptEngine()) {
      goToSlide(data.state.currentSlide || 0);
      drawCanvas.loadStrokes(data.drawings || {});
    }

    chatPanel = setupChatPanel({
      getSocket: () => sync?.socket,
      clientId: sync.clientId,
      displayName: hostName,
      role: 'host',
      toggleBtn: document.getElementById('btn-chat'),
    });

    const signaling = new WebrtcSignaling(sync.socket, { localClientId: sync.clientId });
    webrtcPublisher = new HostPublisher({
      signaling,
      onStatus: ({ active, withMic, kinds, audioShareMissing }) => {
        updateStreamUi(!!active, !!micCtl?.enabled);
        syncAvButtons();
        if (active) {
          hideSharePrompt();
          if (audioShareMissing && !webrtcPublisher._audioWarned) {
            webrtcPublisher._audioWarned = true;
            alert(
              '화면 소리는 캡처되지 않았습니다.\n\n'
              + '공유 팝업에서 「오디오 공유」또는 「시스템 오디오」를 체크한 뒤\n'
              + '다시 송출해 주세요.\n'
              + '(Chrome: 전체 화면/창 공유 시 시스템 소리, 탭 공유 시 탭 소리)'
            );
          }
        } else if (!document.getElementById('presentation-stage')
          || document.getElementById('presentation-stage').classList.contains('hidden')) {
          showSharePrompt('');
        }
      },
    });
    webrtcPublisher.interactionMode = interactionMode;
    webrtcPublisher.voiceFloorId = voiceFloorId;
    webrtcPublisher.allowAllVoice = interactionMode === 'unidirectional' && allowAllVoice;
    if (webrtcPublisher.allowAllVoice) webrtcPublisher.ensureReceiving().catch(() => {});
    webrtcPublisher.setSpeakerEnabled?.(true);
    webrtcPublisher.setRoomCode?.(roomCode);
    webrtcPublisher.avatarManager?.setClientId?.(sync.clientId);
    webrtcPublisher.getFaceTiles = () => hostParticipantsGrid?.getTiles?.() || [];
    webrtcPublisher.onShareModeChange = (mode) => {
      if (!mode) { updateShareModeUi(null); return; }
      applyShareMode(mode);
    };
    webrtcPublisher.setFaceQualityByRoomSize?.(data.state?.viewerCount ?? 1).catch?.(() => {});
    if (webrtcPublisher.avatarManager) {
      webrtcPublisher.avatarManager.onAvatarChange = () => updateAvatarUi();
      webrtcPublisher.avatarManager.onModeChange = () => updateAvatarUi();
    }
    webrtcPublisher.onCameraChange = ({ active, stream }) => {
      hostParticipantsGrid.setStream('local', active ? stream : null);
      if (hostParticipantsGrid?.isVisible) {
        removeCameraPip('local');
      } else if (active && stream) {
        updateCameraPip('local', stream, { label: `${hostName} (내 카메라)`, isMirror: true, isHost: true });
      } else {
        removeCameraPip('local');
      }
      if (floatingSpeakerManager?.isSharingActive) {
        const isHost = (!currentSpotlightSpeaker.id || currentSpotlightSpeaker.id === sync?.clientId || currentSpotlightSpeaker.role === 'host');
        if (isHost) {
          floatingSpeakerManager.setStream(active ? stream : null);
        }
      }
      syncAvButtons();
    };
    // ── 참가자 카메라 표시: 딥페이크 직송(faceFeed)이 살아 있으면 그것을, 아니면 SFU 스트림을 사용 ──
    // 직송 경로: 참가자 JPEG → GPU 워커 → 서버 → 호스트 canvas (stress_test.html 과 같은 경로/속도)
    // SFU 경로는 항상 유지되므로, 직송이 끊기거나 딥페이크가 꺼지면 자동으로 SFU 영상으로 돌아온다.
    const feedDisabled = params.get('feed') === '0' || localStorage.getItem('ym_face_feed') === '0';
    faceFeed = feedDisabled ? null : new FaceFeedClient({
      roomCode,
      hostToken,
      onFirstLive: (id) => showRemoteCamera(id),
    });
    function showRemoteCamera(clientId) {
      const sfuStream = sfuCameraStreams.get(clientId);
      if (!sfuStream) return; // 카메라가 꺼졌거나 아직 SFU 에 없음 → 직송만으로는 표시하지 않음
      const useFeed = !!faceFeed?.isLive(clientId);
      const stream = (useFeed && faceFeed.getStream(clientId)) || sfuStream;
      shownCameraSource.set(clientId, stream === sfuStream ? 'sfu' : 'feed');
      hostParticipantsGrid.setStream(clientId, stream);
      if (hostParticipantsGrid?.isVisible) {
        removeCameraPip(clientId);
        return;
      }
      const viewers = getLatestViewers() || [];
      const v = viewers.find((x) => x.clientId === clientId || x.id === clientId);
      const label = v ? `${v.name || '참가자'}` : '참가자';
      updateCameraPip(clientId, stream, { label, isMirror: false, isHost: false });
    }
    webrtcPublisher.onRemoteCamera = ({ clientId, stream }) => {
      sfuCameraStreams.set(clientId, stream);
      showRemoteCamera(clientId);
      if (floatingSpeakerManager?.isSharingActive && currentSpotlightSpeaker.id === clientId) {
        floatingSpeakerManager.setStream(stream);
      }
    };
    webrtcPublisher.onRemoteCameraClosed = (clientId) => {
      sfuCameraStreams.delete(clientId);
      shownCameraSource.delete(clientId);
      faceFeed?.dropClient(clientId);
      hostParticipantsGrid.removeStream(clientId);
      removeCameraPip(clientId);
      if (floatingSpeakerManager?.isSharingActive && currentSpotlightSpeaker.id === clientId) {
        floatingSpeakerManager.setStream(null);
      }
    };
    if (faceFeed?.supported) {
      faceFeed.start();
      // 직송이 끊기면(0.9s 무프레임) SFU 로 복귀, 다시 살아나면 직송으로 전환
      setInterval(() => {
        for (const clientId of sfuCameraStreams.keys()) {
          const want = faceFeed.isLive(clientId) ? 'feed' : 'sfu';
          if (shownCameraSource.get(clientId) !== want) showRemoteCamera(clientId);
        }
        // 서버에 "직송을 실제로 화면에 그리고 있는 참가자" 보고 → 서버는 그 참가자에게 결과 JPEG 를 돌려주지 않고,
        // 참가자의 SFU 카메라 송출(VP8)을 저fps 로 낮춘다. 보고가 끊기거나 목록에서 빠지면 자동 복원된다.
        const liveIds = [];
        if (webrtcPublisher?.shareMode !== 'screen') {
          for (const clientId of sfuCameraStreams.keys()) {
            if (shownCameraSource.get(clientId) === 'feed' && faceFeed.isLive(clientId)) liveIds.push(clientId);
          }
        }
        faceFeed.reportLive(liveIds);
      }, 400);
      window.__ymDebug = window.__ymDebug || {};
      Object.defineProperties(window.__ymDebug, {
        faceFeed: { configurable: true, get: () => faceFeed.stats() },
        cameraSources: { configurable: true, get: () => Object.fromEntries(shownCameraSource) },
        publisher: { configurable: true, get: () => webrtcPublisher },
      });
    }
    window.__ymDebug = window.__ymDebug || {};
    try {
      Object.defineProperty(window.__ymDebug, 'publisher', { configurable: true, get: () => webrtcPublisher });
    } catch { /* already defined */ }
    webrtcPublisher.onMicTrack = (track) => {
      if (track) {
        vadMonitor.attach('local', track);
      } else {
        vadMonitor.detach('local');
      }
    };
    webrtcPublisher.onRemoteAudioTrack = ({ clientId, track }) => {
      vadMonitor.attach(clientId, track);
    };
    webrtcPublisher.onRemoteAudioTrackClosed = (clientId) => {
      speakingIndicator.untrack(clientId);
    };
    webrtcPublisher.onNetworkQuality = ({ pingMs, lossRate, quality }) => {
      hostParticipantsGrid.updateNetworkQuality('local', { pingMs, lossRate, quality });
      const avMgr = webrtcPublisher.avatarManager;
      if (quality === 'poor' && avMgr?.isLarge) {
        console.warn('[host] network poor -> lowering camera res to SD for low latency');
        avMgr.setHighRes(false);
      }
    };

    function setupGlobalAudioUnlock() {
      const unlock = () => {
        try {
          document.querySelectorAll('audio').forEach((el) => {
            if (el.paused && el.srcObject) el.play().catch(() => {});
          });
        } catch { /* ignore */ }
      };
      ['click', 'touchstart', 'keydown'].forEach((evt) => {
        window.addEventListener(evt, unlock, { capture: true, passive: true });
      });
    }
    setupGlobalAudioUnlock();
    // 원격 제어(마우스/키보드) — 참가자 화면을 중계 중일 때만 요청 가능
    if (!rcHost && sync?.socket) {
      rcHost = new RemoteControlHost({ socket: sync.socket, getVideoEl: () => guestShareVideo });
    }
    document.getElementById('btn-guest-share-stop')?.addEventListener('click', () => {
      returnToHostDisplay().catch((err) => console.warn('[host] returnToHostDisplay', err));
    });
    webrtcPublisher.onRelayChange = ({ peerId, active, stream }) => {
      if (active && stream) {
        const name = getLatestViewers().find((v) => v.id === peerId)?.name || '참가자';
        rcHost?.setTarget({ id: peerId, name });
        showGuestShare(stream, name);
        activeBroadcasterId = peerId;
        setSelectedBroadcaster(peerId);
        sync?.emit('set-broadcaster', {
          clientId: peerId,
          role: 'viewer',
          name,
        });
      } else {
        rcHost?.setTarget(null);
        hideGuestShare();
        activeBroadcasterId = sync.clientId;
        setSelectedBroadcaster(sync.clientId);
        sync?.emit('set-broadcaster', {
          clientId: sync.clientId,
          role: 'host',
          name: hostName,
        });
      }
    };

    const unmuteBanner = document.getElementById('unmute-banner');
    webrtcPublisher.onAudioPlaybackState = ({ ok, needUnmute }) => {
      if (!webrtcPublisher?.speakerOn) {
        unmuteBanner?.classList.add('hidden');
        return;
      }
      if (needUnmute && unmuteBanner) {
        unmuteBanner.classList.remove('hidden');
      } else if (ok && unmuteBanner) {
        unmuteBanner.classList.add('hidden');
      }
    };
    unmuteBanner?.addEventListener('click', () => {
      webrtcPublisher?.unlockAudio();
      unmuteBanner.classList.add('hidden');
    });

    if (interactionMode === 'bidirectional') {
      webrtcPublisher.ensureReceiving().catch((err) => {
        console.warn('[host] ensureReceiving error:', err);
      });
    }

    // 마이크: 필수 방이면 검증 후 자동 ON, 아니면 꺼진 상태(아이콘 비활성)로 시작
    setupHostMic();

    // 입장 직후 호스트 메뉴 표시
    // 모바일: 자동 화면공유는 사용자 제스처 없이 실패하므로 안내만 표시
    showHostMenu();
    if (isMeetingStarted) {
      if (isMobileHostEnv() || !canDisplayCapture()) {
        showSharePrompt('');
      } else {
        setTimeout(() => {
          if (!webrtcPublisher?.isActive) startFaceShare();
        }, 120);
      }
    } else {
      updateTarotShareButton();
    }
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
        setViewerCount(state.viewerCount, state.viewers, {
          activeBroadcasterId: state.activeBroadcasterId ?? activeBroadcasterId,
        });
        (state.viewers || []).forEach((v) => {
          if (v?.id && v.role !== 'host') knownViewerIds.add(v.id);
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

// 백그라운드 탭 전환 등으로 일시정지된 비디오 재생 유지 (보이는 것만)
setInterval(() => {
  document.querySelectorAll('video').forEach((v) => {
    if (!v.srcObject || !v.paused) return;
    if (v.offsetParent === null && getComputedStyle(v).display === 'none') return;
    v.play?.().catch(() => {});
  });
}, 5000);

