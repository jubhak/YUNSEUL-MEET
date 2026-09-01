/**
 * 참가자: WebRTC로 호스트 화면을 시청 (화상회의 수신 모드)
 * PPT ZIP/동영상 추출 없음 — 추후 다자 화상 UI를 같은 레이어에 확장 가능
 */
import { RoomSync } from './sync.js?v=20260728b';
import {
  setViewerCount,
  setupViewersPanel,
  setSelectedBroadcaster,
} from './viewers-panel.js?v=20260728b';
import { WebrtcSignaling } from './webrtc/signaling.js?v=20260715j';
import { ViewerSubscriber } from './webrtc/viewer-subscriber.js?v=20260826sfu20';
import { setupViewerZoom } from './viewer-zoom.js?v=20260819b';

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
/** 호스트가 아직 링크를 열어 둔 동안 유지 */
let activeHostLink = null; // { url, title }

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

function setWaiting(title, desc) {
  waitingPanel?.classList.remove('hidden');
  liveStage?.classList.add('hidden');
  document.body.classList.remove('has-presentation');
  if (waitingTitle) waitingTitle.textContent = title;
  if (waitingDesc) waitingDesc.textContent = desc;
}

function showLive() {
  waitingPanel?.classList.add('hidden');
  liveStage?.classList.remove('hidden');
  document.body.classList.add('has-presentation');
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
  const next = !subscriber.micOn;
  if (next && !sync?.socket?.connected) {
    alert('방에 연결되지 않았습니다.');
    return;
  }
  btnAvMic.disabled = true;
  const ok = await subscriber.setMicEnabled(next);
  btnAvMic.disabled = false;
  if (next && !ok) {
    const secure = window.isSecureContext;
    alert(
      secure
        ? '마이크 권한이 없거나 거부되었습니다.\n주소창 왼쪽 자물쇠 → 사이트 설정에서 마이크를 허용해 주세요.'
        : '마이크는 HTTPS(보안 연결)에서만 사용할 수 있습니다.'
    );
  }
  syncAvButtons();
});

function handleEvent(type, data) {
  switch (type) {
    case 'viewer-count':
      setViewerCount(data.count ?? 0, data.viewers, {
        activeBroadcasterId: data.activeBroadcasterId,
      });
      break;
    case 'broadcaster-changed':
      setSelectedBroadcaster(data.clientId || null);
      break;
    case 'request-screen-share': {
      const hostLabel = data.hostName || '호스트';
      const ok = window.confirm(
        `${hostLabel}님이 회원님의 PC 화면을 모든 참가자에게 보여 달라고 요청했습니다.\n\n화면 공유를 허용할까요?`
      );
      if (!ok) {
        syncStatus.textContent = '화면 공유 요청 거절';
        break;
      }
      syncStatus.textContent = '화면 공유 창 선택…';
      subscriber?.startScreenShare().then((started) => {
        syncStatus.textContent = started ? '내 화면 공유 중' : '화면 공유 취소됨';
      });
      break;
    }
    case 'stop-screen-share':
      subscriber?.stopScreenShare().catch(() => {});
      if (subscriber?.hasLiveVideo?.()) {
        syncStatus.textContent = '실시간 시청 중';
      }
      break;
    case 'session-end':
      clearHostLink();
      showSessionEnded(data.message || '호스트가 발표를 종료했습니다.');
      break;
    case 'open-link':
      showViewerLink(data.url, data.title || data.url, { modal: true });
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

    // 시그널 수신을 먼저 열어 호스트 offer 유실 방지
    const signaling = new WebrtcSignaling(sync.socket, { localClientId: sync.clientId });
    subscriber = new ViewerSubscriber({
      signaling,
      videoEl: liveVideo,
      onStatus: (s) => {
        // needUnmute는 자동 배너로 쓰지 않음 — 스피커 토글 토스트만 사용
        if (s.streamEnded || s.streamActive === false) {
          setWaiting(
            '호스트 화면 송출 대기',
            '호스트가 「송출」을 누르면 여기에서 실시간으로 보입니다.'
          );
          syncStatus.textContent = '송출 대기';
          unmuteBanner?.classList.add('hidden');
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
    if (liveVideo) liveVideo.muted = true;
    if (data.state?.hostClientId) {
      subscriber.hostPeerId = data.state.hostClientId;
    }
    syncAvButtons();

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

    if (data.state?.popup?.url) {
      showViewerLink(data.state.popup.url, data.state.popup.title || data.state.popup.url);
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
