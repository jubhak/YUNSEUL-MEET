/**
 * 통합 테스트: 마이크 게이트(mic-status/admitted) + 원격 제어(rc-*) + 화면공유 종료 후 제어 자동 종료
 *   node tests/test_mic_rc_flow.js
 */
const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4890;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass += 1; console.log(`  ✅ ${msg}`); } else { fail += 1; console.log(`  ❌ ${msg}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  return new Promise((res, rej) => {
    const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}
const emitAck = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
function waitEvent(s, ev, pred = () => true, ms = 4000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout ${ev}`)); }, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
    s.on(ev, h);
  });
}

async function main() {
  const server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(250);
    try { ready = (await fetch(`${BASE}/api/host-url`)).status === 200; } catch { /* retry */ }
  }
  assert(ready, '서버 기동');
  if (!ready) { server.kill(); process.exit(1); }

  try {
    // ── 방 생성 (양방향 + 마이크 필수)
    const cr = await (await fetch(`${BASE}/api/create-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: true }),
    })).json();
    assert(cr.ok && cr.code, '방 생성');
    const { code, hostToken } = cr;

    const host = await connect('host');
    const hostJoin = await emitAck(host, 'join', { code, role: 'host', hostToken, clientId: 'host-1', name: '호스트' });
    assert(hostJoin?.role === 'host', '호스트 입장');

    const viewer = await connect('viewer');
    let lastCount = null;
    host.on('viewer-count', (d) => { lastCount = d; });
    const vJoin = await emitAck(viewer, 'join', { code, role: 'viewer', clientId: 'viewer-1', name: '참가자1' });
    assert(!!vJoin?.clientId, '참가자 입장');
    await sleep(300);

    // ── 마이크 게이트: 필수 방에서는 ready 전까지 admitted=false
    const v0 = lastCount?.viewers?.find((v) => v.clientId === 'viewer-1' || v.id === 'viewer-1');
    console.log('    viewer payload:', JSON.stringify(v0));
    assert(v0 && v0.admitted === false, '마이크 검증 전 참가자는 admitted=false');

    viewer.emit('mic-status', { state: 'on', ready: true });
    await sleep(300);
    const v1 = lastCount?.viewers?.find((v) => v.clientId === 'viewer-1' || v.id === 'viewer-1');
    assert(v1 && v1.admitted === true && v1.micState === 'on', 'mic-status(ready) 후 admitted=true, mic=on');

    viewer.emit('mic-status', { state: 'off', ready: true });
    await sleep(300);
    const v2 = lastCount?.viewers?.find((v) => v.clientId === 'viewer-1' || v.id === 'viewer-1');
    assert(v2 && v2.micState === 'off' && v2.admitted === true, '마이크 OFF 로 바뀌어도 검증된 참가자는 유지');

    viewer.emit('mic-status', { state: 'none', ready: false });
    await sleep(300);
    const v3 = lastCount?.viewers?.find((v) => v.clientId === 'viewer-1' || v.id === 'viewer-1');
    assert(v3 && v3.admitted === false, '마이크 없음(none) → 다시 admitted=false');
    viewer.emit('mic-status', { state: 'on', ready: true });
    await sleep(200);

    // ── 원격 제어
    // 대상이 화면 공유 중이 아니면 거절
    let r = await emitAck(host, 'rc-request', { targetId: 'viewer-1' });
    assert(r?.error === 'target-not-sharing', '공유 중이 아니면 rc-request 거절');

    // 참가자가 방송자가 됨 (호스트가 릴레이 시작)
    host.emit('host-event', { type: 'set-broadcaster', payload: { clientId: 'viewer-1' } });
    await sleep(300);

    // 비호스트는 요청 불가
    r = await emitAck(viewer, 'rc-request', { targetId: 'viewer-1' });
    assert(r?.error === 'host-only', '참가자는 rc-request 불가');

    const reqP = waitEvent(viewer, 'rc-request');
    r = await emitAck(host, 'rc-request', { targetId: 'viewer-1' });
    assert(r?.ok && r.sessionId, '호스트 rc-request 성공');
    const reqEv = await reqP;
    assert(reqEv.sessionId === r.sessionId, '참가자에게 rc-request 전달');

    // 거절 흐름
    const deniedP = waitEvent(host, 'rc-denied');
    const resp0 = await emitAck(viewer, 'rc-respond', { sessionId: r.sessionId, accept: false });
    assert(resp0?.ok && resp0.accepted === false, '참가자 거절');
    await deniedP.then(() => assert(true, '호스트에 rc-denied 수신'), () => assert(false, '호스트에 rc-denied 수신'));

    // 다시 요청 → 허용
    const reqP2 = waitEvent(viewer, 'rc-request');
    r = await emitAck(host, 'rc-request', { targetId: 'viewer-1' });
    await reqP2;
    const approvedP = waitEvent(host, 'rc-approved');
    const resp = await emitAck(viewer, 'rc-respond', { sessionId: r.sessionId, accept: true });
    assert(resp?.ok && resp.accepted && /remote-agent\/download/.test(resp.downloadUrl), '참가자 허용 + 다운로드 URL 발급');
    await approvedP.then(() => assert(true, '호스트에 rc-approved 수신'), () => assert(false, '호스트에 rc-approved 수신'));

    // 에이전트 스크립트 다운로드
    const dl = await fetch(`${BASE}${resp.downloadUrl}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const txt = buf.toString('utf8');
    assert(dl.status === 200 && txt.includes('rc-agent') === false ? true : dl.status === 200, '제어 프로그램(.bat) 다운로드 200');
    assert(txt.includes('@echo off') && !txt.includes('__AGENT_TOKEN__'), '제어 프로그램에 토큰/URL 치환됨');
    const bad = await fetch(`${BASE}/api/remote-agent/download?s=${r.sessionId}&k=wrong`);
    assert(bad.status >= 400, '잘못된 토큰 다운로드 거부');

    // 잘못된 토큰의 에이전트 접속 거부
    const badWs = await new Promise((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/rc-agent?s=${r.sessionId}&k=zzzz`);
      w.on('open', () => res('open'));
      w.on('error', () => res('rejected'));
      w.on('unexpected-response', () => res('rejected'));
    });
    assert(badWs === 'rejected', '잘못된 토큰 에이전트 접속 거부');

    // 에이전트(드라이런) 접속
    const k = /k=([0-9a-f]+)/.exec(resp.downloadUrl)[1];
    const activeHostP = waitEvent(host, 'rc-active');
    const activeViewerP = waitEvent(viewer, 'rc-active');
    const agent = new WebSocket(`ws://127.0.0.1:${PORT}/rc-agent?s=${r.sessionId}&k=${k}`);
    const agentMsgs = [];
    agent.on('message', (d) => { try { agentMsgs.push(JSON.parse(String(d))); } catch { /* ignore */ } });
    await new Promise((res, rej) => { agent.on('open', res); agent.on('error', rej); });
    agent.send(JSON.stringify({ t: 'hello', w: 1920, h: 1080, dryRun: true }));
    const ah = await activeHostP;
    await activeViewerP;
    assert(ah.screen?.w === 1920 && ah.dryRun === true, '호스트에 rc-active (제어권 획득) 수신');

    // 입력 전달 (호스트)
    host.emit('rc-input', {
      sessionId: r.sessionId,
      events: [
        { k: 'mm', x: 0.5, y: 0.25 },
        { k: 'md', b: 0, x: 0.5, y: 0.25 },
        { k: 'mu', b: 0, x: 0.5, y: 0.25 },
        { k: 'kd', c: 'KeyA' },
        { k: 'ku', c: 'KeyA' },
        { k: 'kd', c: 'bad code!' },
        { k: 'evil', cmd: 'rm -rf' },
      ],
    });
    await sleep(300);
    const inputMsgs = agentMsgs.filter((m) => m.t === 'input');
    const evs = inputMsgs.flatMap((m) => m.events);
    assert(evs.length === 5, `에이전트가 검증된 입력 5개만 수신 (실제 ${evs.length})`);

    // 참가자가 보낸 rc-input 은 무시
    viewer.emit('rc-input', { sessionId: r.sessionId, events: [{ k: 'mm', x: 0.1, y: 0.1 }] });
    await sleep(200);
    assert(agentMsgs.filter((m) => m.t === 'input').flatMap((m) => m.events).length === 5, '참가자발 입력은 무시됨');

    // 화면 공유 종료 → 제어 자동 종료
    const endedHostP = waitEvent(host, 'rc-ended');
    const endedViewerP = waitEvent(viewer, 'rc-ended');
    host.emit('host-event', { type: 'stop-screen-share', payload: { clientId: 'viewer-1' } });
    const eh = await endedHostP;
    await endedViewerP;
    assert(eh.reason === 'share-ended', `화면 공유 종료 시 제어 자동 종료 (reason=${eh.reason})`);
    await sleep(300);
    assert(agentMsgs.some((m) => m.t === 'stop'), '에이전트에 stop 전달');

    // 호스트가 다시 릴레이 → 제어 → 참가자가 중지
    host.emit('host-event', { type: 'set-broadcaster', payload: { clientId: 'viewer-1' } });
    await sleep(200);
    const reqP3 = waitEvent(viewer, 'rc-request');
    r = await emitAck(host, 'rc-request', { targetId: 'viewer-1' });
    await reqP3;
    const endedP3 = waitEvent(host, 'rc-ended');
    await emitAck(viewer, 'rc-stop', { sessionId: r.sessionId });
    const e3 = await endedP3;
    assert(e3.reason === 'target-stopped', '참가자가 제어를 중지하면 호스트에 rc-ended');

    // 호스트 화면 복귀
    host.emit('host-event', { type: 'stop-screen-share', payload: { clientId: 'viewer-1' } });
    await sleep(200);

    host.close();
    viewer.close();
    agent.close();
  } catch (err) {
    fail += 1;
    console.log('  ❌ 예외:', err.message);
  } finally {
    server.kill();
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

main();
