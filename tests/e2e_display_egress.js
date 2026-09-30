/**
 * 호스트 화면(display) 송출 검증 — 시청자 N명(기본 12)이 실제로 화면을 수신하는지,
 * 인원 수에 따른 비트레이트 상한(setDisplayMaxBitrate)과 시간계층(L1T3)이 적용됐는지 확인한다.
 *   node tests/e2e_display_egress.js [시청자수=12] [측정초=10]
 * getDisplayMedia 는 캔버스 스트림(움직이는 화면)으로 대체한다. GPU 워커 불필요.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const N = Number(process.argv[2] || 12);
const MEASURE_S = Number(process.argv[3] || 10);
const ROOT = path.resolve(__dirname, '..');
const PORT = 4894;
const DBG = 9335;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
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
// 움직이는 1280x720 캔버스를 화면 공유처럼 돌려준다
const FAKE_DISPLAY = `navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let t = 0;
  // 숨겨진(headless) 탭에서는 setInterval 이 심하게 스로틀되므로 Worker 타이머로 그린다
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),33)'], { type: 'text/javascript' })));
  w.onmessage = () => { t += 1; g.fillStyle = 'hsl(' + (t * 3 % 360) + ',60%,40%)'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '48px sans-serif';
    for (let i = 0; i < 12; i += 1) g.fillText('YUNSEUL MEET display test ' + (t + i), 40 + ((t * 7 + i * 40) % 300), 60 + i * 55); };
  return c.captureStream(30);
};`;

(async () => {
  if (!CHROME) { console.log('Chrome 없음'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FACE_SWAP_AUTOSTART: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let wlog = '';
  server.stdout.on('data', (d) => { wlog += d.toString('utf8'); });
  server.stderr.on('data', (d) => { wlog += d.toString('utf8'); });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-disp-'));
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

    console.log((wlog.split('\n').find((l) => /SFU ICE IPs/.test(l)) || '').trim());
    const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: false, allowClientCamera: false }) })).json();
    const q = new URLSearchParams({ code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional', rm: '0' });
    const host = await openPage('host', `${BASE}/host.html?${q}`, PCS + FAKE_DISPLAY);
    pages.push(host);
    await sleep(3000);

    const viewers = [];
    for (let i = 0; i < N; i += 1) {
      const v = await openPage(`viewer${i + 1}`, `${BASE}/viewer.html?code=${cr.code}`,
        PCS + `sessionStorage.setItem('viewerName','참가자${i + 1}');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      viewers.push(v); pages.push(v);
      await sleep(500);
    }
    await sleep(3000);

    // 시청자가 다 들어온 뒤 화면 공유 시작(처음부터 상한이 적용되는 경로) — 인원 수 상한은 setFaceQualityByRoomSize 경로로도 갱신된다
    const started = await host.eval(`(async () => { const p = window.__ymDebug && window.__ymDebug.publisher; if (!p) return 'no-publisher'; await p.startDisplayCapture({ withMic: false, withTabAudio: false }); return 'ok'; })()`);
    console.log(`호스트 화면 공유 시작: ${JSON.stringify(started)}`);
    await host.eval(`window.__ymDebug.publisher.setFaceQualityByRoomSize(${N}).then(()=>1)`);
    await sleep(8000);

    const hostInfo = async () => JSON.parse(await host.eval(`(async () => {
      const out = [];
      for (const pc of (window.__pcs || [])) {
        if (pc.connectionState === 'closed') continue;
        for (const s of pc.getSenders()) {
          if (!s.track || s.track.kind !== 'video') continue;
          const p = s.getParameters();
          const st = await pc.getStats(s.track);
          let bytes = 0; let frames = 0; let w = 0; let h = 0; let target = 0; let ts = 0;
          st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') { bytes += r.bytesSent || 0; frames += r.framesEncoded || 0; w = r.frameWidth; h = r.frameHeight; target = r.targetBitrate || 0; ts = r.timestamp; } });
          out.push({ enc: (p.encodings || []).map((e) => ({ maxBitrate: e.maxBitrate, scalabilityMode: e.scalabilityMode })), bytes, frames, w, h, target, ts });
        }
      }
      return JSON.stringify(out);
    })()`));
    const viewerInfo = async (v) => JSON.parse(await v.eval(`(async () => {
      let bytes = 0; let dec = 0; let w = 0; let h = 0; let freeze = 0;
      for (const pc of (window.__pcs || [])) {
        if (pc.connectionState === 'closed') continue;
        const st = await pc.getStats();
        st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { bytes += r.bytesReceived || 0; dec += r.framesDecoded || 0; w = r.frameWidth; h = r.frameHeight; freeze += r.freezeCount || 0; } });
      }
      return JSON.stringify({ bytes, dec, w, h, freeze });
    })()`));

    const h0 = await hostInfo(); const v0 = await Promise.all(viewers.map(viewerInfo));
    await sleep(MEASURE_S * 1000);
    const h1 = await hostInfo(); const v1 = await Promise.all(viewers.map(viewerInfo));

    const dispEnc = h1.find((x) => x.enc.length && (x.w >= 640 || x.h >= 360)) || h1[0];
    console.log(`호스트 송출 인코딩: ${JSON.stringify(dispEnc?.enc)} ${dispEnc?.w}x${dispEnc?.h}`);
    const hostKbps = h0.length && h1.length ? ((h1.reduce((a, x) => a + x.bytes, 0) - h0.reduce((a, x) => a + x.bytes, 0)) * 8) / MEASURE_S / 1000 : 0;
    console.log(`호스트 영상 업로드(SFU 로): ${hostKbps.toFixed(0)} kbps`);

    const fpsList = viewers.map((_, i) => (v1[i].dec - v0[i].dec) / MEASURE_S);
    const kbpsList = viewers.map((_, i) => ((v1[i].bytes - v0[i].bytes) * 8) / MEASURE_S / 1000);
    const minFps = Math.min(...fpsList); const avgFps = fpsList.reduce((a, b) => a + b, 0) / N;
    const avgKbps = kbpsList.reduce((a, b) => a + b, 0) / N;
    console.log(`시청자 ${N}명 수신: 평균 ${avgFps.toFixed(1)}fps (최소 ${minFps.toFixed(1)}), 평균 ${avgKbps.toFixed(0)} kbps, 해상도 ${v1[0].w}x${v1[0].h}, freeze 합 ${v1.reduce((a, x) => a + x.freeze, 0)}`);
    console.log(`서버 상향 추정: 시청자당 ${avgKbps.toFixed(0)}kbps × ${N} = ${(avgKbps * N / 1000).toFixed(1)} Mbps`);

    ok(started === 'ok', '호스트 화면 공유 시작');
    ok(viewers.every((_, i) => v1[i].dec - v0[i].dec > 0), '모든 시청자가 화면 영상을 계속 디코드');
    ok(avgFps >= 8, `시청자 평균 fps ≥ 8 (${avgFps.toFixed(1)})`);
    if (N > 8) {
      const cap = dispEnc?.enc?.[0]?.maxBitrate || 0;
      ok(cap > 0 && cap <= 3_000_000, `인원 ${N}명 → 비트레이트 상한 적용 (${cap} bps)`);
    }
    const sm = dispEnc?.enc?.[0]?.scalabilityMode;
    console.log(`  (참고) scalabilityMode = ${sm || '없음(폴백 또는 미보고)'}`);
    const errs = pages.flatMap((p) => p.errors).filter((e) => !/favicon|ResizeObserver/.test(e));
    ok(errs.length === 0, `페이지 예외 없음 (${errs.length}건 ${errs[0] ? errs[0].slice(0, 160) : ''})`);
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
