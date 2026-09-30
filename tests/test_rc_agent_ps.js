/**
 * 실제 다운로드되는 PowerShell 제어 프로그램(.bat)을 YM_DRYRUN=1 로 실행해
 * 서버 연결 → rc-active → 입력 수신/처리 → 중지까지 확인한다. (Windows 전용)
 *   node tests/test_rc_agent_ps.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4891;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emitAck = (s, ev, d) => new Promise((res) => s.emit(ev, d, res));
const connect = () => new Promise((res, rej) => {
  const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const waitEvent = (s, ev, ms = 20000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});

(async () => {
  if (process.platform !== 'win32') { console.log('skip (Windows only)'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore' });
  let ok = false;
  let agent = null;
  try {
    for (let i = 0; i < 40 && !ok; i += 1) {
      await sleep(250);
      try { ok = (await fetch(`${BASE}/api/host-url`)).status === 200; } catch { /* retry */ }
    }
    const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional' }) })).json();
    const host = await connect();
    await emitAck(host, 'join', { code: cr.code, role: 'host', hostToken: cr.hostToken, clientId: 'h1', name: '호스트' });
    const viewer = await connect();
    await emitAck(viewer, 'join', { code: cr.code, role: 'viewer', clientId: 'v1', name: '참가자' });
    host.emit('host-event', { type: 'set-broadcaster', payload: { clientId: 'v1' } });
    await sleep(300);
    const reqP = waitEvent(viewer, 'rc-request');
    const r = await emitAck(host, 'rc-request', { targetId: 'v1' });
    await reqP;
    const resp = await emitAck(viewer, 'rc-respond', { sessionId: r.sessionId, accept: true });
    const buf = Buffer.from(await (await fetch(`${BASE}${resp.downloadUrl}`)).arrayBuffer());
    const bat = path.join(os.tmpdir(), 'ym-rc-test.bat');
    fs.writeFileSync(bat, buf);

    const activeP = waitEvent(host, 'rc-active', 30000);
    agent = spawn('cmd.exe', ['/c', bat], { env: { ...process.env, YM_DRYRUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    agent.stdout.on('data', (d) => { out += d.toString('utf8'); });
    agent.stderr.on('data', (d) => { out += d.toString('utf8'); });
    const active = await activeP;
    console.log(`✅ 에이전트 접속: rc-active screen=${active.screen?.w}x${active.screen?.h} dryRun=${active.dryRun}`);
    host.emit('rc-input', { sessionId: r.sessionId, events: [{ k: 'mm', x: 0.5, y: 0.5 }, { k: 'kd', c: 'KeyA' }, { k: 'ku', c: 'KeyA' }] });
    await sleep(800);
    const endedP = waitEvent(host, 'rc-ended', 10000);
    host.emit('rc-stop', { sessionId: r.sessionId });
    const ended = await endedP;
    console.log(`✅ 제어 종료: reason=${ended.reason}`);
    await sleep(1500);
    console.log('--- agent output (tail) ---');
    console.log(out.split('\n').slice(-12).join('\n'));
    console.log('agent exited:', agent.exitCode !== null ? `code ${agent.exitCode}` : '(still running → kill)');
    host.close(); viewer.close();
  } catch (e) {
    console.log('❌', e.message);
    process.exitCode = 1;
  } finally {
    try { agent?.kill(); } catch { /* ignore */ }
    server.kill();
  }
})();
