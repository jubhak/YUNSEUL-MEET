/**
 * Node 서버 API 경로 (`.php` 없이). 옛 캐시 대비 둘 다 시도 가능하게 유지.
 */
function api(path) {
  // path: 'create-room' | 'upload' | 'get-room?code=...'
  return 'api/' + path.replace(/^\//, '');
}

let hostData = null;

document.getElementById('btn-create-room').addEventListener('click', async () => {
  const btn = document.getElementById('btn-create-room');
  btn.disabled = true;
  btn.textContent = '생성 중...';

  try {
    const res = await fetch(api('create-room'), { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '방 생성 실패');
    hostData = data;

    document.getElementById('room-code-display').textContent = data.code;
    document.getElementById('host-result').classList.remove('hidden');
    btn.textContent = '방 생성 완료';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '새 방 만들기';
    alert('방 생성에 실패했습니다.\nNode 서버가 실행 중인지 확인하세요.\n(프로젝트에서 npm start)\n\n' + (err.message || ''));
  }
});

document.getElementById('btn-go-host').addEventListener('click', () => {
  if (!hostData) return;
  sessionStorage.setItem('hostToken', hostData.hostToken);
  sessionStorage.setItem('roomCode', hostData.code);
  window.location.href = `host.html?code=${hostData.code}`;
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('viewer-name').value.trim() || '참가자';
  const errorEl = document.getElementById('join-error');

  if (!code || code.length < 4) {
    errorEl.textContent = '방 코드를 입력해주세요.';
    errorEl.classList.remove('hidden');
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

    sessionStorage.setItem('viewerName', name);
    sessionStorage.setItem('roomCode', code);
    window.location.href = `viewer.html?code=${code}`;
  } catch {
    errorEl.textContent = '서버에 연결할 수 없습니다. npm start 로 Node 서버를 실행하세요.';
    errorEl.classList.remove('hidden');
  }
});

document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-room').click();
});
