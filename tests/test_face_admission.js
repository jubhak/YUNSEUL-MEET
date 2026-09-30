/**
 * 워커 입장 제어(admission) 테스트 — GPU 워커를 직접 띄워(처리량 하한을 낮게 설정) 용량 초과 시 busy 로 거절하는지 확인한다.
 *   node tests/test_face_admission.js
 * 설정: FACE_SWAP_CAPACITY_FPS=30, FACE_SWAP_MIN_ADMIT_FPS=6 → 30×0.9÷6 = 최대 4명
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const PY = fs.existsSync('C:\\Program Files\\Python313\\python.exe') ? 'C:\\Program Files\\Python313\\python.exe' : 'python';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✅ ${m}`); } else { fail += 1; console.log(`  ❌ ${m}`); } };

function connect(key, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?client=${key}`, { headers });
    const res = { ws, msgs: [], closed: false, code: 0 };
    ws.on('message', (d, bin) => { if (!bin) { try { res.msgs.push(JSON.parse(String(d))); } catch { /* ignore */ } } });
    ws.on('close', (code) => { res.closed = true; res.code = code; });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', clientId: key })); setTimeout(() => resolve(res), 400); });
    ws.on('error', () => setTimeout(() => resolve(res), 400));
  });
}
const busyOf = (r) => r.msgs.find((m) => m.type === 'busy');

(async () => {
  const child = spawn(PY, ['-u', 'server/face_swap_worker.py'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FACE_SWAP_PORT: String(PORT), FACE_SWAP_CAPACITY_FPS: '30', FACE_SWAP_MIN_ADMIT_FPS: '6', PYTHONUNBUFFERED: '1' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString('utf8'); });
  child.stderr.on('data', (d) => { log += d.toString('utf8'); });
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i += 1) {
      await sleep(1000);
      try { up = (await fetch(`http://127.0.0.1:${PORT}/stats`)).ok; } catch { /* retry */ }
    }
    if (!up) { console.log('워커 기동 실패\n' + log.slice(-1200)); process.exit(1); }
    const stats = async () => (await (await fetch(`http://127.0.0.1:${PORT}/stats`)).json()).admission;
    console.log('초기 admission:', JSON.stringify(await stats()));

    const conns = [];
    for (let i = 1; i <= 6; i += 1) conns.push(await connect(`c${i}`));
    ok(conns.slice(0, 4).every((r) => !busyOf(r) && !r.closed), '앞 4명은 승인되어 연결 유지');
    ok(conns.slice(4).every((r) => busyOf(r)), '5, 6번째는 busy 메시지를 받음');
    ok(conns.slice(4).every((r) => r.closed), '거절된 연결은 서버가 닫음');
    const b = busyOf(conns[4]);
    console.log('busy 내용:', JSON.stringify(b));
    ok(b && b.max_clients === 4 && b.min_fps === 6, `busy 에 최대 인원(4)·최소 fps(6) 포함`);

    const host = await connect('hostX', { 'X-Client-Prio': 'host' });
    ok(!busyOf(host) && !host.closed, '호스트(prio=host)는 가득 차도 승인');

    // 이미 승인된(활성) 참가자의 재접속/재선택은 통과
    // (호스트도 GPU 를 쓰므로 활성 인원에 포함된다 — 호스트와 c1 이 나가면 3명 → c1 재접속은 4번째로 승인)
    conns[0].ws.close(); host.ws.close(); await sleep(400);
    const re = await connect('c1');
    ok(!busyOf(re) && !re.closed, '자리가 비면 재접속 승인');

    // set_source 재확인: 활성 목록에서 빠진 뒤(6초) 다시 얼굴을 고르면 다시 검사
    conns[1].ws.close(); await sleep(300);
    const c7 = await connect('c7');
    ok(!busyOf(c7), '자리가 하나 비면 새 참가자 승인');
    const c8 = await connect('c8');
    ok(!!busyOf(c8), '다시 가득 차면 거절');
    const st = await stats();
    console.log('종료 admission:', JSON.stringify(st));
    ok(st.rejected >= 3 && st.accepted >= 6, `통계 반영 (accepted=${st.accepted}, rejected=${st.rejected})`);

    for (const r of [...conns, host, re, c7, c8]) { try { r.ws.close(); } catch { /* ignore */ } }
  } catch (e) {
    fail += 1; console.log('테스트 예외:', e);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(500);
    console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  }
})();
