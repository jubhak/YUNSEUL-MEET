import { runMicCheckDialog } from './mic-check.js?v=20260930a';

/**
 * Node 서버 API 경로 (`.php` 없이). 옛 캐시 대비 둘 다 시도 가능하게 유지.
 */
function api(path) {
  // path: 'create-room' | 'upload' | 'get-room?code=...'
  return 'api/' + path.replace(/^\//, '');
}

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const btn = document.getElementById('btn-create-room');
  const errorEl = document.getElementById('host-error');
  const hostName = document.getElementById('host-name').value.trim();
  const roomCodeEl = document.getElementById('host-room-code');
  let code = (roomCodeEl?.value || '').replace(/[^0-9]/g, '').slice(0, 4);

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  if (!hostName) {
    if (errorEl) {
      errorEl.textContent = '호스트 아이디를 입력해 주세요.';
      errorEl.classList.remove('hidden');
    } else {
      alert('호스트 아이디를 입력해 주세요.');
    }
    document.getElementById('host-name')?.focus();
    return;
  }

  // 모바일에서 코드 자동채움 전에 누르면 실패하던 경우 방지
  if (!code || code.length !== 4) {
    await suggestHostRoomCode();
    code = (roomCodeEl?.value || '').replace(/[^0-9]/g, '').slice(0, 4);
  }
  if (!code || code.length !== 4) {
    if (errorEl) {
      errorEl.textContent = '참여 코드는 4자리 숫자여야 합니다.';
      errorEl.classList.remove('hidden');
    }
    roomCodeEl?.focus();
    return;
  }

  // 마이크 필수 방: 방을 만들기 전에 호스트의 마이크부터 "실제로 소리가 잡히는지" 검증
  {
    const modeSel = document.querySelector('input[name="interaction-mode"]:checked')?.value || 'bidirectional';
    const needMic = modeSel === 'bidirectional' && !!document.getElementById('require-mic')?.checked;
    if (needMic) {
      const r = await runMicCheckDialog({
        required: true,
        title: '호스트 마이크 확인 (필수)',
        subtitle: '마이크 필수 방입니다. 사용할 마이크를 선택하고 "안녕하세요"라고 말씀해 소리가 잡히는지 확인해 주세요.',
        confirmLabel: '확인하고 방 만들기',
        cancelLabel: '취소',
      });
      if (!r.ok || !r.verified) {
        if (errorEl) {
          errorEl.textContent = '마이크 확인이 완료되지 않아 방을 만들지 않았습니다.';
          errorEl.classList.remove('hidden');
        }
        return;
      }
    }
  }

  btn.disabled = true;
  btn.textContent = '시작 중...';

  try {
    const checkRes = await fetch(api('check-room-code?code=' + encodeURIComponent(code)));
    const checkData = await checkRes.json().catch(() => ({}));
    if (checkData.available === false) {
      throw new Error(checkData.error || '이미 사용 중인 참여 코드입니다. 다른 번호를 입력해 주세요.');
    }

    const interactionMode = document.querySelector('input[name="interaction-mode"]:checked')?.value
      || 'bidirectional';
    const requireMic = interactionMode === 'bidirectional' && !!document.getElementById('require-mic')?.checked;
    const allowClientCamera = interactionMode === 'bidirectional' && (document.getElementById('allow-client-cam')?.checked !== false);
    const allowClientDeepfake = allowClientCamera && (document.getElementById('allow-client-deepfake')?.checked !== false);

    const res = await fetch(api('create-room'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, interactionMode, requireMic, allowClientCamera, allowClientDeepfake }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '방 생성 실패');

    const token = data.hostToken || '';
    const room = data.code || code;
    const mode = data.interactionMode || interactionMode;
    const reqMic = !!(data.requireMic ?? requireMic);
    const allowCam = !!(data.allowClientCamera ?? allowClientCamera);
    const allowDfc = !!(data.allowClientDeepfake ?? allowClientDeepfake);

    // 일부 모바일 브라우저에서 sessionStorage만으로 다음 페이지 전달이 실패할 수 있어 URL 백업 사용
    try {
      sessionStorage.setItem('hostToken', token);
      sessionStorage.setItem('roomCode', room);
      sessionStorage.setItem('hostName', hostName);
      sessionStorage.setItem('interactionMode', mode);
      sessionStorage.setItem('requireMic', reqMic ? 'true' : 'false');
      sessionStorage.setItem('allowClientCamera', allowCam ? 'true' : 'false');
      sessionStorage.setItem('allowClientDeepfake', allowDfc ? 'true' : 'false');
    } catch (storageErr) {
      console.warn('[create-room] sessionStorage', storageErr);
    }

    const q = new URLSearchParams({
      code: room,
      ht: token,
      hn: hostName,
      mode,
      rm: reqMic ? '1' : '0',
      ac: allowCam ? '1' : '0',
      ad: allowDfc ? '1' : '0',
    });
    window.location.href = `host.html?${q.toString()}`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '새 방 만들기';
    if (errorEl) {
      errorEl.textContent = err.message || '방 생성에 실패했습니다.';
      errorEl.classList.remove('hidden');
    } else {
      alert(err.message || '방 생성에 실패했습니다.');
    }
    roomCodeEl?.focus();
    roomCodeEl?.select();
  }
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  const code = document.getElementById('join-code').value.trim().replace(/[^0-9]/g, '');
  const name = document.getElementById('viewer-name').value.trim();
  const errorEl = document.getElementById('join-error');

  if (!code || code.length !== 4) {
    errorEl.textContent = '4자리 숫자 코드를 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!name) {
    errorEl.textContent = '아이디를 입력해주세요.';
    errorEl.classList.remove('hidden');
    document.getElementById('viewer-name')?.focus();
    return;
  }

  try {
    const res = await fetch(api('get-room?code=' + encodeURIComponent(code)));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ended) {
      errorEl.textContent = data.error || '유효하지 않은 방입니다.';
      errorEl.classList.remove('hidden');
      return;
    }

    // 마이크 필수 방: 입장 전에 "말했을 때 실제로 소리가 잡히는" 마이크를 검증(장치 선택 가능)
    if (data.requireMic && data.interactionMode !== 'unidirectional') {
      const r = await runMicCheckDialog({
        required: true,
        title: '마이크 확인 (필수)',
        confirmLabel: '확인하고 입장',
        cancelLabel: '취소',
      });
      if (!r.ok || !r.verified) {
        errorEl.textContent = '이 방은 마이크가 필수입니다. 마이크 확인을 완료해야 입장할 수 있습니다.';
        errorEl.classList.remove('hidden');
        return;
      }
    }

    sessionStorage.setItem('viewerName', name);
    sessionStorage.setItem('roomCode', code);
    if (data.interactionMode) {
      sessionStorage.setItem('interactionMode', data.interactionMode);
    }
    sessionStorage.setItem('requireMic', data.requireMic ? 'true' : 'false');
    window.location.href = `viewer.html?code=${code}`;
  } catch {
    errorEl.textContent = '서버에 연결할 수 없습니다. npm start 로 Node 서버를 실행하세요.';
    errorEl.classList.remove('hidden');
  }
});

document.getElementById('host-name')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-create-room').click();
});

document.getElementById('viewer-name')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-room').click();
});

const cardJoin = document.getElementById('card-join');
const cardHost = document.getElementById('card-host');
const hostRoomCodeInput = document.getElementById('host-room-code');

function fillHostRoomCode(code) {
  if (!hostRoomCodeInput) return;
  hostRoomCodeInput.value = String(code || '').replace(/[^0-9]/g, '').slice(0, 4);
}

async function suggestHostRoomCode() {
  try {
    const res = await fetch(api('suggest-room-code'));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.code) throw new Error(data.error || '코드 생성 실패');
    fillHostRoomCode(data.code);
  } catch (err) {
    console.warn('[suggest-room-code]', err);
    // 서버 실패 시에만 임시 로컬 값 (생성 시 서버에서 다시 검증)
    fillHostRoomCode(String(Math.floor(1000 + Math.random() * 9000)));
  }
}

function showJoinCard() {
  cardHost?.classList.add('hidden');
  cardJoin?.classList.remove('hidden');
  document.getElementById('join-code')?.focus();
}

function showHostCard() {
  cardJoin?.classList.add('hidden');
  cardHost?.classList.remove('hidden');
  suggestHostRoomCode();
  document.getElementById('host-name')?.focus();
}

hostRoomCodeInput?.addEventListener('input', () => {
  const cleaned = hostRoomCodeInput.value.replace(/[^0-9]/g, '').slice(0, 4);
  if (hostRoomCodeInput.value !== cleaned) hostRoomCodeInput.value = cleaned;
  const errorEl = document.getElementById('host-error');
  if (errorEl && !errorEl.classList.contains('hidden')) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
});

document.getElementById('btn-reroll-code')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-reroll-code');
  if (btn) btn.disabled = true;
  await suggestHostRoomCode();
  if (btn) btn.disabled = false;
  hostRoomCodeInput?.focus();
  hostRoomCodeInput?.select();
});

document.getElementById('link-show-host')?.addEventListener('click', (e) => {
  e.preventDefault();
  showHostCard();
});

document.getElementById('link-show-join')?.addEventListener('click', (e) => {
  e.preventDefault();
  showJoinCard();
});

const micRequiredWrap = document.getElementById('mic-required-wrap');
document.querySelectorAll('input[name="interaction-mode"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    if (micRequiredWrap) {
      micRequiredWrap.classList.toggle('hidden', e.target.value === 'unidirectional');
    }
  });
});

/* ── 참여 코드 입력 처리 (숫자 4자리 제한 및 엔터 입력) ── */
const joinCodeInput = document.getElementById('join-code');

joinCodeInput?.addEventListener('input', () => {
  const raw = joinCodeInput.value;
  const cleaned = raw.replace(/[^0-9]/g, '').slice(0, 4);
  if (raw !== cleaned) joinCodeInput.value = cleaned;
});

joinCodeInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-join-room')?.click();
  }
});

// 참가자 카메라 및 딥페이크 옵션 상호작용
const allowCamEl = document.getElementById('allow-client-cam');
const allowDfcEl = document.getElementById('allow-client-deepfake');
const dfcSubwrap = document.getElementById('deepfake-allowed-subwrap');

function syncCameraDeepfakeOptions() {
  if (!allowCamEl || !allowDfcEl) return;
  const camEnabled = allowCamEl.checked;
  allowDfcEl.disabled = !camEnabled;
  if (!camEnabled) {
    allowDfcEl.checked = false;
  }
  if (dfcSubwrap) {
    dfcSubwrap.style.opacity = camEnabled ? '1.0' : '0.4';
    dfcSubwrap.style.pointerEvents = camEnabled ? 'auto' : 'none';
  }
}

allowCamEl?.addEventListener('change', syncCameraDeepfakeOptions);

// 미팅 방식(양방향/단방향)에 따라 참가자 미디어 옵션 표시/숨김
document.querySelectorAll('input[name="interaction-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isBidir = radio.value === 'bidirectional';
    const micWrap = document.getElementById('mic-required-wrap');
    const camWrap = document.getElementById('camera-allowed-wrap');
    if (micWrap) micWrap.style.display = isBidir ? 'block' : 'none';
    if (camWrap) camWrap.style.display = isBidir ? 'block' : 'none';
  });
});

