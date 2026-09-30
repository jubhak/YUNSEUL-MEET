/**
 * 얼굴 화면(캔버스 합성) ↔ PC 화면 전환. 목소리는 유지되고 시청자는 영상을 계속 받는다.
 *   node tests/e2e_share_mode.js [시청자수=4] [측정초=6]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const N = Number(process.argv[2] || 4);
const MEASURE_S = Number(process.argv[3] || 6);
const ROOT = path.resolve(__dirname, '..');
const PORT = 4897;
const DBG = 9338;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✅ ${m}`); } else { fail += 1; console.log(`  ❌ ${m}`); } };

class Page {
  constructor(ws, name) {
    this.ws = ws; this.name = name; this.id = 0; this.cbs = new Map(); this.errors = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.cbs.has(m.id)) { this.cbs.get(m.id)(m); this.cbs.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const e = m.params.exceptionDetails;
        this.errors.push(`${e.text} ${e.exception?.description || ''} @${e.url || ''}:${e.lineNumber}`);
      }
    });
  }
  send(method, params = {}) { return new Promise((res) => { const id = ++this.id; this.cbs.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
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
  await p.send('Runtime.enable'); await p.send('Page.enable');
  if (preScript) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
  await p.send('Page.navigate', { url });
  return p;
}

const PCS = 'window.__pcs=[];const _P=window.RTCPeerConnection;window.RTCPeerConnection=function(...a){const p=new _P(...a);window.__pcs.push(p);return p};window.RTCPeerConnection.prototype=_P.prototype;';
const FAKE_DISPLAY = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let t = 0;
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),33)'], { type: 'text/javascript' })));
  w.onmessage = () => { t += 1; g.fillStyle = '#0f766e'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '42px sans-serif'; g.fillText('PC SCREEN ' + t, 80, 360); };
  const s = c.captureStream(30);
  try { s.getVideoTracks()[0].contentHint = 'detail'; } catch (e) {}
  return s;
};`;

const TILE_FEED = `(function(){
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let t = 0;
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),33)'], { type: 'text/javascript' })));
  w.onmessage = () => { t += 1; g.fillStyle = 'hsl(' + (t * 5 % 360) + ',70%,45%)'; g.fillRect(0,0,640,360); g.fillStyle='#fff'; g.font='28px sans-serif'; g.fillText('FACE '+t, 40, 180); };
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = c.captureStream(30); v.play().catch(()=>{});
  window.__faceTileVideo = v;
})();`;

async function viewerVideo(v) {
  return JSON.parse(await v.eval(`(async () => {
    let bytes = 0; let dec = 0; let w = 0; let h = 0;
    for (const pc of (window.__pcs || [])) {
      if (pc.connectionState === 'closed') continue;
      const st = await pc.getStats();
      st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { bytes += r.bytesReceived || 0; dec += r.framesDecoded || 0; w = r.frameWidth; h = r.frameHeight; } });
    }
    return JSON.stringify({ bytes, dec, w, h });
  })()`));
}

(async () => {
  if (!CHROME) { console.log('Chrome 없음'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FACE_SWAP_AUTOSTART: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let wlog = '';
  server.stdout.on('data', (d) => { wlog += d.toString('utf8'); });
  server.stderr.on('data', (d) => { wlog += d.toString('utf8'); });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-share-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  const pages = [];
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      await sleep(500);
      try { up = (await fetch(`${BASE}/api/host-url`)).status === 200 && (await fetch(`http://127.0.0.1:${DBG}/json/version`)).ok; } catch { /* retry */ }
    }
    if (!up) { console.log('서버/Chrome 기동 실패'); console.log(wlog.slice(-1500)); return; }

    const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: false, allowClientCamera: true }) })).json();
    const q = new URLSearchParams({ code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional', rm: '0' });
    const host = await openPage('host', `${BASE}/host.html?${q}`, PCS + FAKE_DISPLAY + TILE_FEED);
    pages.push(host);
    await sleep(3500);

    const viewers = [];
    for (let i = 0; i < N; i += 1) {
      const v = await openPage(`viewer${i + 1}`, `${BASE}/viewer.html?code=${cr.code}`,
        PCS + `sessionStorage.setItem('viewerName','참가자${i + 1}');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      viewers.push(v); pages.push(v);
      await sleep(400);
    }
    await sleep(2500);

    const faceStart = await host.eval(`(async () => {
      const p = window.__ymDebug && window.__ymDebug.publisher;
      if (!p) return 'no-publisher';
      p.getFaceTiles = () => [{ id:'local', name:'호스트', isHost:true, video: window.__faceTileVideo, hasCam:true }];
      await p.startFaceShare();
      return p.shareMode + ':' + (p.sfu && p.sfu._displayMotion ? 'motion' : 'still');
    })()`);
    console.log(`얼굴 화면 시작: ${JSON.stringify(faceStart)}`);
    await sleep(5000);

    const vFace0 = await Promise.all(viewers.map(viewerVideo));
    await sleep(MEASURE_S * 1000);
    const vFace1 = await Promise.all(viewers.map(viewerVideo));
    const faceFps = viewers.map((_, i) => (vFace1[i].dec - vFace0[i].dec) / MEASURE_S);
    const avgFace = faceFps.reduce((a, b) => a + b, 0) / N;
    console.log(`얼굴 모드 시청자 평균 ${avgFace.toFixed(1)}fps ${vFace1[0].w}x${vFace1[0].h}`);

    ok(typeof faceStart === 'string' && faceStart.startsWith('face:'), `얼굴 화면 시작 (${faceStart})`);
    ok(faceStart === 'face:motion', '얼굴 화면은 프레임 우선(motion) 인코딩');
    ok(avgFace >= 8, `얼굴 모드 평균 fps ≥ 8 (${avgFace.toFixed(1)})`);

    const screenStart = await host.eval(`(async () => {
      const p = window.__ymDebug.publisher;
      await p.startDisplayCapture({ withMic: false, withTabAudio: false });
      return p.shareMode + ':' + (p.sfu && p.sfu._displayMotion ? 'motion' : 'detail');
    })()`);
    console.log(`PC 화면 시작: ${JSON.stringify(screenStart)}`);
    await sleep(2500);

    const idleFlags = await Promise.all(viewers.map((v) => v.eval(`({ idle: !!(window.__ymDebug && window.__ymDebug.subscriber && window.__ymDebug.subscriber._cameraIdle), avIdle: !!(window.__ymDebug && window.__ymDebug.subscriber && window.__ymDebug.subscriber.avatarManager && window.__ymDebug.subscriber.avatarManager.isIdle) })`)));
    console.log(`시청자 idle: ${JSON.stringify(idleFlags)}`);
    ok(screenStart === 'screen:detail', `PC 화면은 글씨 우선 (${screenStart})`);
    ok(idleFlags.every((x) => x && x.idle), 'PC 화면 모드에서 참가자 얼굴 송출이 멈춤');

    const vScr0 = await Promise.all(viewers.map(viewerVideo));
    await sleep(MEASURE_S * 1000);
    const vScr1 = await Promise.all(viewers.map(viewerVideo));
    const scrFps = viewers.map((_, i) => (vScr1[i].dec - vScr0[i].dec) / MEASURE_S);
    const avgScr = scrFps.reduce((a, b) => a + b, 0) / N;
    console.log(`PC 모드 시청자 평균 ${avgScr.toFixed(1)}fps`);
    ok(avgScr >= 8, `PC 모드에서도 화면이 계속 옴 (${avgScr.toFixed(1)}fps)`);

    const back = await host.eval(`(async () => { const p = window.__ymDebug.publisher; await p.startFaceShare(); return p.shareMode; })()`);
    await sleep(2000);
    const idleAfter = await Promise.all(viewers.map((v) => v.eval(`!!(window.__ymDebug && window.__ymDebug.subscriber && window.__ymDebug.subscriber._cameraIdle)`)));
    ok(back === 'face', `다시 얼굴 화면 (${back})`);
    ok(idleAfter.every((x) => x === false), '얼굴 화면으로 돌아오면 얼굴 송출 재개');

    const errs = pages.flatMap((p) => p.errors).filter((e) => !/favicon|ResizeObserver/.test(e));
    ok(errs.length === 0, `페이지 예외 없음 (${errs.length}건 ${errs[0] ? String(errs[0]).slice(0, 160) : ''})`);
  } catch (e) {
    fail += 1; console.log('테스트 예외:', e);
  } finally {
    for (const p of pages) { try { p.ws.close(); } catch { /* ignore */ } }
    try { chrome.kill(); } catch { /* ignore */ }
    try { server.kill(); } catch { /* ignore */ }
    console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  }
})();
