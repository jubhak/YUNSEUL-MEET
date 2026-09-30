/**
 * 브라우저(Chrome headless, CDP) 스모크/E2E — 실제 클라이언트 JS 를 로드해 모듈/런타임 오류와 UI 상태를 확인한다.
 *   node tests/e2e_browser_smoke.js
 * 필요: Chrome 또는 Edge (Windows 기본 경로), node_modules(ws, socket.io-client)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4892;
const DBG = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✅ ${m}`); } else { fail += 1; console.log(`  ❌ ${m}`); } };

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

class Page {
  constructor(ws, name) {
    this.ws = ws; this.name = name; this.id = 0; this.cbs = new Map(); this.logs = []; this.errors = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.cbs.has(m.id)) { this.cbs.get(m.id)(m); this.cbs.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params.exceptionDetails;
        this.errors.push(`${e.text} ${e.exception?.description || ''} @${e.url || ''}:${e.lineNumber}`);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.logs.push(`[${m.params.type}] ${txt}`);
        if (m.params.type === 'error') this.errors.push(`console.error: ${txt}`);
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        if (e.level === 'error') this.errors.push(`log.error: ${e.text} ${e.url || ''}`);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res) => { const id = ++this.id; this.cbs.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

async function openPage(name, url, preScript = '') {
  const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const p = new Page(ws, name);
  await p.send('Runtime.enable');
  await p.send('Log.enable');
  await p.send('Page.enable');
  if (preScript) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
  await p.send('Page.navigate', { url });
  return p;
}

async function main() {
  if (!CHROME) { console.log('Chrome/Edge 없음 — 건너뜀'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: 'ignore' });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-e2e-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await sleep(250);
      try { up = (await fetch(`${BASE}/api/host-url`)).status === 200 && (await fetch(`http://127.0.0.1:${DBG}/json/version`)).ok; } catch { /* retry */ }
    }
    ok(up, '서버 + 브라우저 기동');
    if (!up) return;

    const scenarios = [
      { name: 'A: 마이크 불필요 + 카메라 허용 + 딥페이크 허용', body: { interactionMode: 'bidirectional', requireMic: false, allowClientCamera: true, allowClientDeepfake: true } },
      { name: 'B: 마이크 불필요 + 카메라 금지', body: { interactionMode: 'bidirectional', requireMic: false, allowClientCamera: false, allowClientDeepfake: false } },
    ];

    for (const sc of scenarios) {
      console.log(`\n=== 시나리오 ${sc.name} ===`);
      const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sc.body) })).json();
      const q = new URLSearchParams({
        code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional',
        rm: sc.body.requireMic ? '1' : '0', ac: sc.body.allowClientCamera ? '1' : '0', ad: sc.body.allowClientDeepfake ? '1' : '0',
      });
      const host = await openPage('host', `${BASE}/host.html?${q}`);
      await sleep(3500);
      const viewer = await openPage('viewer', `${BASE}/viewer.html?code=${cr.code}`,
        `sessionStorage.setItem('viewerName','테스터');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      await sleep(6000);

      const hostInfo = await host.eval(`(() => { const m = document.getElementById('btn-av-mic'); const c = document.getElementById('btn-av-camera') || document.getElementById('btn-av-cam'); return JSON.stringify({ mic: m && m.className, micHidden: m && getComputedStyle(m).display, cam: c && c.className }); })()`);
      console.log('    host UI:', hostInfo);
      const viewerInfo = await viewer.eval(`(() => { const ids=['btn-av-mic','btn-av-camera','btn-av-cam','btn-av-mic-device']; const o={}; for (const i of ids){ const e=document.getElementById(i); o[i]= e ? { cls:e.className, disp:getComputedStyle(e).display } : null; } o.zoomUi = !!document.querySelector('.ym-zoom-ui'); o.rcModal = !!document.querySelector('.rc-modal'); return JSON.stringify(o); })()`);
      console.log('    viewer UI:', viewerInfo);

      const vi = JSON.parse(viewerInfo || '{}');
      const camBtn = vi['btn-av-camera'] || vi['btn-av-cam'];
      if (sc.body.allowClientCamera) {
        ok(!camBtn || camBtn.disp !== 'none', '카메라 허용 방: 참가자 카메라 버튼 표시');
      } else {
        ok(!camBtn || camBtn.disp === 'none', '카메라 금지 방: 참가자 카메라 아이콘이 보이지 않음');
      }
      const mic = vi['btn-av-mic'];
      ok(mic && !/is-active/.test(mic.cls), `마이크 불필요 방: 참가자 마이크 시작 시 비활성 (class="${mic?.cls}")`);

      // 참가자 마이크 켜기 (가짜 마이크)
      await viewer.eval(`document.getElementById('btn-av-mic')?.click()`);
      await sleep(2500);
      const afterMic = await viewer.eval(`document.getElementById('btn-av-mic')?.className`);
      console.log('    after click mic:', afterMic);
      ok(/is-active/.test(afterMic || ''), '참가자 마이크 클릭 → 활성 아이콘');
      const hostSeesMic = await host.eval(`Array.from(document.querySelectorAll('[data-speak-id]')).length`);
      console.log('    host speak-id targets:', hostSeesMic);

      // 마이크 끄기 → 영상/프로듀서 유지, 아이콘 비활성
      await viewer.eval(`document.getElementById('btn-av-mic')?.click()`);
      await sleep(800);
      const offMic = await viewer.eval(`document.getElementById('btn-av-mic')?.className`);
      ok(!/is-active/.test(offMic || ''), '참가자 마이크 다시 클릭 → 비활성');

      // 호스트 마이크
      await host.eval(`document.getElementById('btn-av-mic')?.click()`);
      await sleep(2500);
      const hostMic = await host.eval(`document.getElementById('btn-av-mic')?.className`);
      console.log('    host mic after click:', hostMic);

      // 서버 관점 상태
      const st = await (await fetch(`${BASE}/api/rooms/${cr.code}`)).json().catch(() => null);
      if (st) console.log('    room api ok');

      for (const pg of [host, viewer]) {
        const errs = pg.errors.filter((e) => !/getDisplayMedia|NotAllowedError|Permission|favicon|ERR_|Failed to load resource/i.test(e));
        ok(errs.length === 0, `${pg.name} 페이지 런타임 오류 없음`);
        errs.slice(0, 8).forEach((e) => console.log('     !', e.slice(0, 300)));
        pg.ws.close();
      }
    }
    // ── 시나리오 D: 실제 WebRTC — 카메라 즉시 송출(딥페이크 OFF) + 마이크 토글이 영상에 영향 없음 + 호스트가 소리 수신
    {
      console.log('\n=== 시나리오 D: 실제 미디어 (카메라 + 마이크 토글) ===');
      const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: false, allowClientCamera: true, allowClientDeepfake: false }) })).json();
      const q = new URLSearchParams({ code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional', rm: '0', ac: '1', ad: '0' });
      const PCS = 'window.__pcs=[];const _P=window.RTCPeerConnection;window.RTCPeerConnection=function(...a){const p=new _P(...a);window.__pcs.push(p);return p};window.RTCPeerConnection.prototype=_P.prototype;';
      const host = await openPage('host', `${BASE}/host.html?${q}`, PCS);
      await sleep(3500);
      const viewer = await openPage('viewer', `${BASE}/viewer.html?code=${cr.code}`,
        PCS + `sessionStorage.setItem('viewerName','테스터');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      await sleep(5000);

      const inbound = () => host.eval(`(async () => {
        let vf = 0, ab = 0, vb = 0, ae = 0;
        for (const pc of (window.__pcs||[])) {
          if (pc.connectionState === 'closed') continue;
          const st = await pc.getStats();
          st.forEach(r => { if (r.type === 'inbound-rtp') { if (r.kind === 'video') { vf += r.framesDecoded||0; vb += r.bytesReceived||0; } else if (r.kind === 'audio') { ab += r.bytesReceived||0; ae += r.totalAudioEnergy||0; } } });
        }
        return JSON.stringify({ vf, vb, ab, ae });
      })()`).then((s) => JSON.parse(s));

      // 카메라 클릭 → (딥페이크 OFF) 얼굴 선택 모달 없이 즉시 실제 얼굴 송출
      await viewer.eval(`document.getElementById('btn-av-cam')?.click()`);
      await sleep(4500);
      const modal = await viewer.eval(`(() => { const m = document.querySelector('#face-select-modal, .face-select-modal, #dlc-modal'); return !!(m && !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none'); })()`);
      ok(modal === false, '딥페이크 OFF 방: 카메라 클릭 시 얼굴 선택 모달 없이 바로 송출');
      const camCls = await viewer.eval(`document.getElementById('btn-av-cam')?.className`);
      ok(/is-active/.test(camCls || ''), `카메라 아이콘 활성 (class="${camCls}")`);

      const s0 = await inbound();
      await sleep(3000);
      const s1 = await inbound();
      console.log('    host inbound (카메라만):', JSON.stringify(s0), '→', JSON.stringify(s1));
      ok(s1.vf - s0.vf >= 20, `호스트가 참가자 영상을 수신 중 (3초간 ${s1.vf - s0.vf}프레임)`);

      // 마이크 ON → 영상 계속 + 오디오 수신
      await viewer.eval(`document.getElementById('btn-av-mic')?.click()`);
      await sleep(2500);
      const m0 = await inbound();
      await sleep(3000);
      const m1 = await inbound();
      console.log('    host inbound (마이크 ON):', JSON.stringify(m0), '→', JSON.stringify(m1));
      ok(m1.vf - m0.vf >= 20, `마이크 ON 중에도 영상 유지 (3초간 ${m1.vf - m0.vf}프레임)`);
      ok(m1.ab - m0.ab > 500, `호스트가 참가자 소리를 수신 (${m1.ab - m0.ab} bytes)`);

      // 마이크 OFF → 영상 계속
      await viewer.eval(`document.getElementById('btn-av-mic')?.click()`);
      await sleep(1500);
      const o0 = await inbound();
      await sleep(3000);
      const o1 = await inbound();
      ok(o1.vf - o0.vf >= 20, `마이크 OFF 후에도 영상 유지 (3초간 ${o1.vf - o0.vf}프레임)`);

      // 마이크 ON/OFF 빠르게 여러 번 → 영상 끊김 없음
      for (let i = 0; i < 6; i += 1) { await viewer.eval(`document.getElementById('btn-av-mic')?.click()`); await sleep(400); }
      const r0 = await inbound();
      await sleep(3000);
      const r1 = await inbound();
      ok(r1.vf - r0.vf >= 20, `마이크 연타 후에도 영상 유지 (3초간 ${r1.vf - r0.vf}프레임)`);

      // 참가자 탭이 백그라운드(숨김)가 되어도 영상이 끊기지 않아야 함 (호스트 탭을 앞으로)
      await host.send('Page.bringToFront');
      await sleep(1500);
      const vis = await viewer.eval('document.visibilityState');
      const b0 = await inbound();
      await sleep(4000);
      const b1 = await inbound();
      console.log(`    viewer visibility=${vis}, host inbound video: ${b1.vf - b0.vf} frames/4s`);
      ok(vis === 'hidden', '참가자 탭이 숨김 상태');
      ok(b1.vf - b0.vf >= 40, `참가자 탭이 백그라운드여도 영상 유지 (4초간 ${b1.vf - b0.vf}프레임, 기준 40 이상)`);
      await viewer.send('Page.bringToFront');
      await sleep(800);

      // 카메라 OFF → 마이크는 그대로
      await viewer.eval(`document.getElementById('btn-av-mic')?.className.includes('is-active') || document.getElementById('btn-av-mic')?.click()`);
      await sleep(2000);
      const a0 = await inbound();
      await viewer.eval(`document.getElementById('btn-av-cam')?.click()`);
      await sleep(2500);
      const a1 = await inbound();
      await sleep(3000);
      const a2 = await inbound();
      console.log('    host inbound (카메라 OFF 후 마이크):', JSON.stringify(a1), '→', JSON.stringify(a2));
      ok(a2.ab - a1.ab > 500, `카메라를 꺼도 소리는 계속 전달 (${a2.ab - a1.ab} bytes)`);

      for (const pg of [host, viewer]) {
        const errs = pg.errors.filter((e) => !/getDisplayMedia|NotAllowedError|Permission|favicon|ERR_|Failed to load resource|face-swap-ws|WebSocket/i.test(e));
        ok(errs.length === 0, `${pg.name} 페이지 런타임 오류 없음`);
        errs.slice(0, 8).forEach((e) => console.log('     !', e.slice(0, 300)));
        pg.ws.close();
      }
    }

    // ── 시나리오 R: 원격 제어 — 참가자 브라우저의 승인 모달/배너 (호스트 역할은 소켓 클라이언트로 대행)
    {
      console.log('\n=== 시나리오 R: 원격 제어 UI ===');
      const { io: ioClient } = require('socket.io-client');
      const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: false }) })).json();
      const hs = ioClient(BASE, { transports: ['websocket'], reconnection: false });
      await new Promise((r) => hs.on('connect', r));
      await new Promise((r) => hs.emit('join', { code: cr.code, role: 'host', hostToken: cr.hostToken, clientId: 'h-rc', name: '호스트' }, r));
      let lastVC = null;
      hs.on('viewer-count', (d) => { lastVC = d; });
      const viewer = await openPage('viewer', `${BASE}/viewer.html?code=${cr.code}`,
        `sessionStorage.setItem('viewerName','제어대상');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      await sleep(4500);
      const viewerId = await viewer.eval(`(() => { try { return sessionStorage.getItem('ym_client_id') || localStorage.getItem('ym_client_id') || ''; } catch { return ''; } })()`);
      // 서버에 등록된 참가자 id 조회
      let vid = lastVC?.viewers?.find((v) => v.role !== 'host')?.id;
      for (let i = 0; i < 30 && !vid; i += 1) { await sleep(500); vid = lastVC?.viewers?.find((v) => v.role !== 'host')?.id; }
      console.log('    viewer id:', vid || viewerId);
      hs.emit('host-event', { type: 'set-broadcaster', payload: { clientId: vid || viewerId } });
      await sleep(500);
      const ack = await new Promise((r) => hs.emit('rc-request', { targetId: vid || viewerId }, r));
      ok(!!ack?.ok, `호스트 rc-request 성공 (${JSON.stringify(ack)})`);
      await sleep(800);
      const shown = await viewer.eval(`!!document.querySelector('.rc-modal')`);
      ok(shown === true, '참가자 화면에 원격 제어 허용/거절 모달 표시');
      const hostApproved = new Promise((r) => { hs.once('rc-approved', r); setTimeout(() => r(null), 5000); });
      await viewer.eval(`document.querySelector('.rc-btn-allow')?.click()`);
      const ap = await hostApproved;
      ok(!!ap, '참가자가 허용 → 호스트에 rc-approved');
      await sleep(500);
      const modalGone = await viewer.eval(`!document.querySelector('.rc-modal')`);
      ok(modalGone === true, '허용 후 모달 닫힘');
      // 에이전트 대신 WS 로 접속 (실제 다운로드/실행은 test_rc_agent_ps.js 에서 검증)
      const st2 = await (await fetch(`${BASE}/api/remote-agent/status`)).json();
      console.log('    rc sessions:', JSON.stringify(st2.sessions));
      hs.emit('rc-stop', { sessionId: ack.sessionId });
      await sleep(500);
      const bannerGone = await viewer.eval(`(() => { const b = document.querySelector('.rc-viewer-banner'); return !b || b.classList.contains('hidden'); })()`);
      ok(bannerGone === true, '제어 종료 후 참가자 배너 없음');
      const errs = viewer.errors.filter((e) => !/getDisplayMedia|NotAllowedError|Permission|favicon|ERR_|Failed to load resource|download/i.test(e));
      ok(errs.length === 0, 'viewer 페이지 런타임 오류 없음');
      errs.slice(0, 5).forEach((e) => console.log('     !', e.slice(0, 300)));
      hs.close(); viewer.ws.close();
    }

    // ── 시나리오 C: 마이크 필수 방 — 호스트/참가자 모두 마이크 검증 다이얼로그, 끄기 시도 시 강제 안내
    {
      console.log('\n=== 시나리오 C: 마이크 필수 방 ===');
      const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: true }) })).json();
      const q = new URLSearchParams({ code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional', rm: '1', ac: '1', ad: '0' });
      const host = await openPage('host', `${BASE}/host.html?${q}`);
      await sleep(4000);
      const dlg = await host.eval(`!!document.querySelector('.ym-mc-backdrop, .ym-mc-dialog, [class*="ym-mc"]')`);
      ok(dlg === true, '마이크 필수 방: 호스트에게 마이크 검증 다이얼로그 표시');
      const req = await host.eval(`(() => { const m=document.getElementById('btn-av-mic'); return m && m.className; })()`);
      console.log('    host mic class (검증 전):', req);
      // 크롬 가짜 마이크는 주기적인 비프음을 낸다 → 레벨 미터가 반응하는지 / 검증 통과 후 다이얼로그가 닫히는지
      let closed = false; let lastStatus = '';
      for (let i = 0; i < 24 && !closed; i += 1) {
        await sleep(500);
        lastStatus = await host.eval(`document.querySelector('.ym-mc-status')?.textContent || ''`);
        closed = !(await host.eval(`!!document.querySelector('.ym-mc-backdrop')`));
      }
      console.log('    dialog status:', lastStatus, '/ closed =', closed);
      if (!closed) {
        const okEnabled = await host.eval(`(() => { const b = document.querySelector('.ym-mc-ok'); return !!b && !b.disabled; })()`);
        ok(okEnabled === true, '마이크 검증 통과 → 확인 버튼 활성화 (실제 소리가 잡혔을 때만)');
        await host.eval(`document.querySelector('.ym-mc-ok')?.click()`);
        for (let i = 0; i < 10 && !closed; i += 1) {
          await sleep(400);
          closed = !(await host.eval(`!!document.querySelector('.ym-mc-backdrop')`));
        }
      }
      if (closed) {
        ok(true, '마이크 검증 통과 → 다이얼로그 닫힘');
        await sleep(1500);
        const c1 = await host.eval(`document.getElementById('btn-av-mic')?.className`);
        ok(/is-active/.test(c1 || ''), `필수 방: 검증 후 호스트 마이크 아이콘 활성 (class="${c1}")`);
        await host.eval(`document.getElementById('btn-av-mic')?.click()`);
        await sleep(600);
        const c2 = await host.eval(`document.getElementById('btn-av-mic')?.className`);
        const toast = await host.eval(`document.body.innerText.includes('필수')`);
        ok(/is-active/.test(c2 || ''), '필수 방: 마이크 끄기 시도해도 아이콘은 활성 유지');
        ok(toast === true, '필수 방: "마이크 필수" 안내 메시지 표시');
      }
      host.errors.filter((e) => !/getDisplayMedia|NotAllowedError|Permission|favicon|ERR_|Failed to load resource/i.test(e))
        .slice(0, 5).forEach((e) => console.log('     !', e.slice(0, 300)));
      host.ws.close();
    }

    // ── 시나리오 Z: 줌 모듈 (PC 휠·마우스 따라가기 / 모바일 기본 배율)
    {
      console.log('\n=== 시나리오 Z: 줌 ===');
      const pg = await openPage('zoom', `${BASE}/index.html`);
      await sleep(1500);
      const r = await pg.eval(`(async () => {
        const { setupViewerZoom } = await import('/js/viewer-zoom.js?v=20260930a');
        const stage = document.createElement('div');
        stage.id = 'zs'; stage.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;overflow:hidden;background:#000';
        const zoom = document.createElement('div'); zoom.className = 'live-zoom'; zoom.style.cssText = 'position:absolute;inset:0';
        const v = document.createElement('video'); v.style.cssText = 'width:100%;height:100%'; zoom.appendChild(v);
        stage.appendChild(zoom); document.body.appendChild(stage);
        const z = setupViewerZoom(stage);
        const out = {};
        out.initial = z.getScale();
        out.ui = !!stage.querySelector('.ym-zoom-ui');
        stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 200, bubbles: true, cancelable: true }));
        out.afterWheel = z.getScale();
        const tx0 = zoom.style.transform;
        stage.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 20, pointerType: 'mouse', bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const tLeft = zoom.style.transform;
        stage.dispatchEvent(new PointerEvent('pointermove', { clientX: 780, clientY: 380, pointerType: 'mouse', bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const tRight = zoom.style.transform;
        out.follow = { tx0, tLeft, tRight, changed: tLeft !== tRight };
        for (let i = 0; i < 3; i++) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 200, bubbles: true, cancelable: true }));
        out.afterZoomOut = z.getScale();
        return JSON.stringify(out);
      })()`);
      console.log('    zoom:', r);
      const zr = JSON.parse(r && !r.__error ? r : '{}');
      ok(zr.initial === 1 && zr.ui === true, 'PC: 기본 배율 100% + 줌 UI 표시');
      ok(zr.afterWheel > 1.05, 'PC: 마우스 휠로 확대');
      ok(zr.follow?.changed === true, 'PC: 확대 중 마우스 위치를 따라 화면 이동(초점 추적)');
      ok(zr.afterZoomOut < zr.afterWheel, 'PC: 휠 아래로 축소');

      // 모바일(coarse pointer) 기본 배율
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 400, deviceScaleFactor: 2, mobile: true });
      await pg.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await sleep(300);
      console.log('    coarse?', await pg.eval(`matchMedia('(pointer: coarse)').matches`));
      const m = await pg.eval(`(async () => {
        const { setupViewerZoom } = await import('/js/viewer-zoom.js?v=20260930a');
        document.getElementById('zs')?.remove();
        const stage = document.createElement('div');
        stage.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;overflow:hidden;background:#000';
        const zoom = document.createElement('div'); zoom.className = 'live-zoom'; zoom.style.cssText = 'position:absolute;inset:0';
        const v = document.createElement('video'); v.style.cssText = 'width:100%;height:100%'; zoom.appendChild(v);
        stage.appendChild(zoom); document.body.appendChild(stage);
        const z = setupViewerZoom(stage);
        const o = { n0: z.getScale() };
        z.setFaceCount(11); o.n11 = z.getScale();
        z.setFaceCount(30); o.n30 = z.getScale();
        z.setFaceCount(200); o.n200 = z.getScale();
        o.uiHidden = !stage.querySelector('.ym-zoom-ui');
        return JSON.stringify(o);
      })()`);
      console.log('    mobile zoom:', m);
      const mr = JSON.parse(m && !m.__error ? m : '{}');
      ok(mr.n11 >= 1 && mr.n30 > 1.5 && mr.n30 < 2.0 && mr.n200 <= 3.2 + 1e-6, '모바일: 얼굴 수에 따라 기본 배율 자동 (10명≈1x, 30명≈1.7x, 상한 3.2x)');
      pg.ws.close();
    }
  } catch (e) {
    fail += 1;
    console.log('❌ 예외', e);
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
    server.kill();
    await sleep(500);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  }
}
main();
