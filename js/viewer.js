/**
 * 참가자: WebRTC로 호스트 화면을 시청 (화상회의 수신 모드)
 * PPT ZIP/동영상 추출 없음 — 추후 다자 화상 UI를 같은 레이어에 확장 가능
 */
import { RoomSync } from './sync.js?v=20260728b';
import {
  setViewerCount,
  setupViewersPanel,
  setSelectedBroadcaster,
} from './viewers-panel.js?v=20260826mic1';
import { WebrtcSignaling } from './webrtc/signaling.js?v=20260715j';
import { ViewerSubscriber } from './webrtc/viewer-subscriber.js?v=20260826share1';
import { setupViewerZoom } from './viewer-zoom.js?v=20260819b';
import { setupChatPanel } from './chat-panel.js?v=20260901chat1';

const params = new URLSearchParams(window.location.search);
const roomCode = (params.get('code') || sessionStorage.getItem('roomCode') || '').toUpperCase();
const viewerName = sessionStorage.getItem('viewerName') || '참가자';

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
const syncStatus = document.getElementById('sync-status');
const unmuteBanner = document.getElementById('unmute-banner');
const viewerLinkGate = document.getElementById('viewer-link-gate');
const viewerLinkTitle = document.getElementById('viewer-link-title');
const viewerLinkOpen = document.getElementById('viewer-link-open');
const viewerLinkClose = document.getElementById('viewer-link-close');
const viewerLinkDismiss = document.getElementById('viewer-link-dismiss');
const viewerLinkChip = document.getElementById('viewer-link-chip');

/** 로컬 핀치 줌 — 호스트 화면 전환과 무관하게 유지 */
setupViewerZoom(liveStage);

let sync = null;
let subscriber = null;
let chatPanel = null;
let interactionMode = 'bidirectional';
/** 호스트가 아직 링크를 열어 둔 동안 유지 */
let activeHostLink = null; // { url, title }

function applyInteractionMode(mode) {
  interactionMode = mode === 'unidirectional' ? 'unidirectional' : 'bidirectional';
  document.body.classList.toggle('is-unidirectional', interactionMode === 'unidirectional');
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.textContent = interactionMode === 'unidirectional' ? '단방향' : '양방향';
    badge.classList.toggle('is-uni', interactionMode === 'unidirectional');
    badge.title = interactionMode === 'unidirectional'
      ? '단방향 대규모 시청 — 시청·채팅만 가능'
      : '양방향 화상 미팅';
  }
  if (subscriber) subscriber.interactionMode = interactionMode;
  if (interactionMode === 'unidirectional' && subscriber?.micOn) {
    subscriber.setMicEnabled(false).catch(() => {});
  }
  if (typeof syncAvButtons === 'function') syncAvButtons();
}

function bindLinkTargets(url) {
  if (!url) return;
  [viewerLinkOpen, viewerLinkChip].forEach((el) => {
    if (!el) return;
    el.href = url;
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
  waitingPanel?.classList.remove('is-self-sharing');
  waitingPanel?.classList.add('hidden');
  liveStage?.classList.remove('hidden');
  document.body.classList.add('has-presentation');
  document.getElementById('btn-stop-self-share')?.classList.add('hidden');
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

document.getElementById('btn-session-end-ok')?.addEventListener('click', () => {
  sessionStorage.removeItem('roomCode');
  sessionStorage.removeItem('viewerName');
  window.location.href = './';
});

unmuteBanner?.classList.add('hidden');

const btnAvSpeaker = document.getElementById('btn-av-speaker');
const btnAvMic = document.getElementById('btn-av-mic');
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
  const micOn = subscriber ? subscriber.micOn : false;
  if (btnAvSpeaker) {
    btnAvSpeaker.classList.toggle('is-active', speakerOn);
    btnAvSpeaker.setAttribute('aria-pressed', speakerOn ? 'true' : 'false');
    btnAvSpeaker.title = speakerOn ? '소리 켜짐 — 클릭하여 끄기' : '소리 꺼짐 — 클릭하여 켜기';
  }
  if (btnAvMic) {
    btnAvMic.classList.toggle('is-active', micOn);
    btnAvMic.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    btnAvMic.title = micOn ? '마이크 켜짐 — 클릭하여 끄기' : '마이크 꺼짐 — 클릭하여 켜기';
  }
}

btnAvSpeaker?.addEventListener('click', () => {
  if (!subscriber) return;
  const next = !subscriber.speakerOn;
  subscriber.setSpeakerEnabled(next);
  syncAvButtons();
  showAvToast(next ? '소리 켜기' : '소리 끄기', { off: !next });
});

btnAvMic?.addEventListener('click', async () => {
  if (!subscriber) return;
  if (interactionMode === 'unidirectional') {
    alert('단방향(대규모 시청) 모드에서는 마이크를 사용할 수 없습니다.');
    return;
  }
  const next = !subscriber.micOn;
  if (next && !sync?.socket?.connected) {
    alert('방에 연결되지 않았습니다.');
    return;
  }
  btnAvMic.disabled = true;
  const ok = await subscriber.setMicEnabled(next);
  btnAvMic.disabled = false;
  if (next && !ok) {
    const err = subscriber._lastMicError;
    const name = err?.name || '';
    const msg = err?.message || String(err || '');
    const permission =
      name === 'NotAllowedError'
      || name === 'PermissionDeniedError'
      || /Permission|NotAllowed|denied/i.test(msg);
    const unavailable =
      name === 'NotFoundError'
      || name === 'DevicesNotFoundError'
      || name === 'NotReadableError'
      || /NotFound|device|found|no microphone/i.test(msg);
    emitMicStatus(unavailable || permission ? 'none' : 'off');
    if (!window.isSecureContext) {
      alert('마이크는 HTTPS(보안 연결)에서만 사용할 수 있습니다.');
    } else if (permission) {
      alert(
        '마이크 권한이 없거나 거부되었습니다.\n주소창 왼쪽 자물쇠 → 사이트 설정에서 마이크를 허용해 주세요.'
      );
    } else if (unavailable) {
      alert('마이크 장치를 찾을 수 없습니다. PC/브라우저 마이크 연결을 확인해 주세요.');
    } else {
      alert(`마이크를 켤 수 없습니다.\n${msg || '알 수 없는 오류'}`);
    }
  } else {
    emitMicStatus(subscriber.micOn ? 'on' : 'off');
  }
  syncAvButtons();
});

function emitMicStatus(state) {
  try {
    sync?.socket?.emit?.('mic-status', { state });
  } catch { /* ignore */ }
}

function probeMicAvailability() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices()
    .then((list) => {
      const hasMic = list.some((d) => d.kind === 'audioinput');
      if (!hasMic) emitMicStatus('none');
      else if (!subscriber?.micOn) emitMicStatus('off');
    })
    .catch(() => {});
}

function handleEvent(type, data) {
  switch (type) {
    case 'viewer-count':
      setViewerCount(data.count ?? 0, data.viewers, {
        activeBroadcasterId: data.activeBroadcasterId,
      });
      break;
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
    case 'open-link':
      // 링크는 호스트 새 창 + 화면 송출만 — 참가자 별도 모달 없음
      break;
    case 'close-link':
      clearHostLink();
      break;
    case 'slide-change':
    case 'play-video':
    case 'close-video':
    case 'presentation-ready':
      clearHostLink();
      break;
    case 'stream-status':
      // 내가 화면 공유 중이면 호스트 송출 FLAG로 UI를 덮어쓰지 않음
      if (isSelfSharingUi()) break;
      if (data.active) {
        // 이미 실시간 시청 중이면 FLAG 주기 재방송으로「연결 중」으로 되돌리지 않음
        if (subscriber?.hasLiveVideo?.()) {
          syncStatus.textContent = '실시간 시청 중';
          break;
        }
        syncStatus.textContent = '호스트 화면 연결 중…';
        if (!liveVideo?.srcObject) {
          setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
        }
        subscriber?.watch?.().catch((err) => { console.warn('[viewer] watch', err); });
      } else {
        subscriber?.clearRemote();
        setWaiting(
          '호스트 화면 송출 대기',
          '호스트가 「송출」을 누르면 여기에서 실시간으로 보입니다.'
        );
        syncStatus.textContent = '송출 대기';
        unmuteBanner?.classList.add('hidden');
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
  onError: (msg) => console.warn(msg),
});

sync.start()
  .then((data) => {
    if (data.state?.ended) {
      showSessionEnded('유효하지 않은 방입니다.');
      return;
    }

    if (data.state?.interactionMode) {
      applyInteractionMode(data.state.interactionMode);
    }

    // 시그널 수신을 먼저 열어 호스트 offer 유실 방지
    const signaling = new WebrtcSignaling(sync.socket, { localClientId: sync.clientId });
    subscriber = new ViewerSubscriber({
      signaling,
      videoEl: liveVideo,
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
          setWaiting(
            '호스트 화면 연결 중…',
            '화면 공유가 끝났습니다. 호스트 화면으로 돌아가는 중…'
          );
          subscriber?.watch?.().catch((err) => console.warn('[viewer] watch', err));
          return;
        }
        if (s.streamEnded || s.streamActive === false) {
          if (subscriber?.sharingScreen) return;
          setWaiting(
            '호스트 화면 송출 대기',
            '호스트가 「송출」을 누르면 여기에서 실시간으로 보입니다.'
          );
          syncStatus.textContent = '송출 대기';
          unmuteBanner?.classList.add('hidden');
          return;
        }
        if (subscriber?.sharingScreen) {
          showSelfSharing();
          return;
        }
        if (s.playing) {
          showLive();
          syncStatus.textContent = '실시간 시청 중';
          syncStatus.classList.add('connected');
        } else if (s.connectError) {
          setWaiting('화면 연결 실패', s.connectError);
          syncStatus.textContent = '연결 실패';
        } else if (s.streamActive && !liveVideo?.srcObject) {
          setWaiting('호스트 화면 연결 중…', '잠시만 기다려 주세요.');
          syncStatus.textContent = '호스트 화면 연결 중…';
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

    // 기본: 소리 ON — 별도 <audio>로 재생 (첫 클릭 시 unlock)
    subscriber.speakerOn = true;
    subscriber.micOn = false;
    subscriber.interactionMode = interactionMode;
    if (liveVideo) liveVideo.muted = true;
    if (data.state?.hostClientId) {
      subscriber.hostPeerId = data.state.hostClientId;
    }
    syncAvButtons();
    probeMicAvailability();

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

    if (data.state?.streamActive) {
      setWaiting('호스트 화면 연결 중…', '송출이 진행 중입니다. 곧 표시됩니다.');
      syncStatus.textContent = '호스트 화면 연결 중…';
      // SFU: watch()로 기존 producer consume
      subscriber.watch?.().catch((err) => { console.warn('[viewer] watch', err); });
    } else {
      setWaiting(
        '호스트 화면 송출 대기',
        '호스트가 「송출」을 누르면 실시간으로 발표 화면이 보입니다.'
      );
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

window.addEventListener('beforeunload', () => {
  try { subscriber?.dispose(); } catch { /* ignore */ }
  sync?.stop();
});
