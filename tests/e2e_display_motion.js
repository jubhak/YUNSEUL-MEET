/**
 * 호스트 화면(참가자 타일이 계속 움직이는 1920x1080 화면)을 시청자 N명이 얼마나 부드럽게 받는지 측정한다.
 * "호스트 화면 캡처 → SFU → 시청자" 경로의 인코딩 설정별 비교용.
 *   VARIANT=baseline|new|new-detail|l1t3  node tests/e2e_display_motion.js [시청자수=12] [측정초=12]
 *   baseline   : 상한 없음, 단일 계층, 'detail'+해상도 우선 (예전 방식)
 *   new        : 인원별 상한 + 프레임 우선(motion) 자동 전환 (지금 코드)
 *   new-detail : 인원별 상한 + 'detail' 유지 (motion 전환 없음)
 *   l1t3       : 인원별 상한 + L1T3 + 'detail'
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const N = Number(process.argv[2] || 12);
const MEASURE_S = Number(process.argv[3] || 12);
const VARIANT = process.env.VARIANT || 'current';
const TILES_W = Number(process.env.TILES_W || 5);
const TILES_H = Number(process.env.TILES_H || 4);
const ROOT = path.resolve(__dirname, '..');
const PORT = 4895;
const DBG = 9336;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

class Page {
  constructor(ws, name) {
    this.ws = ws; this.name = name; this.id = 0; this.cbs = new Map(); this.errors = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.cbs.has(m.id)) { this.cbs.get(m.id)(m); this.cbs.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
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
// 참가자 딥페이크 타일 격자를 흉내: 타일마다 서로 다른 위상으로 ~8~13fps 로 내용이 바뀌는 고엔트로피 화면
const FAKE_DISPLAY = `navigator.mediaDevices.getDisplayMedia = async () => {
  const W = 1920, H = 1080, TW = ${TILES_W}, TH = ${TILES_H};
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#0b0f19'; g.fillRect(0, 0, W, H);
  const tw = Math.floor(W / TW), th = Math.floor(H / TH);
  let t = 0;
  const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(1),33)'], { type: 'text/javascript' })));
  worker.onmessage = () => {
    t += 1;
    for (let ty = 0; ty < TH; ty += 1) for (let tx = 0; tx < TW; tx += 1) {
      const idx = ty * TW + tx;
      const period = 2 + (idx % 3);              // 30fps / (2~4) = 15, 10, 7.5 fps
      if ((t + idx) % period !== 0) continue;
      const x = tx * tw, y = ty * th;
      g.fillStyle = 'hsl(' + ((idx * 37 + t * 2) % 360) + ',35%,32%)'; g.fillRect(x + 2, y + 2, tw - 4, th - 4);
      for (let k = 0; k < 40; k += 1) {   // 얼굴 영상처럼 계속 바뀌는 디테일
        g.fillStyle = 'hsl(' + ((idx * 53 + k * 29 + t * 5) % 360) + ',55%,' + (30 + (k * 7 + t) % 40) + '%)';
        g.beginPath(); g.arc(x + tw / 2 + Math.sin(t * 0.13 + k + idx) * tw * 0.35, y + th / 2 + Math.cos(t * 0.11 + k * 1.7) * th * 0.35, 8 + (k % 6) * 6, 0, 6.283); g.fill();
      }
      g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('참가자 ' + (idx + 1) + '  #' + t, x + 14, y + 36);
    }
  };
  return c.captureStream(30);
};`;

(async () => {
  if (!CHROME) { console.log('Chrome 없음'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-mot-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
  const pages = [];
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      await sleep(500);
      try { up = (await fetch(`${BASE}/api/host-url`)).status === 200 && (await fetch(`http://127.0.0.1:${DBG}/json/version`)).ok; } catch { /* retry */ }
    }
    if (!up) { console.log('기동 실패'); return; }
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

    // 변형별 사전 설정 (SFU 클라이언트를 먼저 만들어 플래그를 세팅한 뒤 화면 공유 시작)
    const useTL = VARIANT === 'l1t3';
    const useCap = ['new', 'new-detail', 'l1t3'].includes(VARIANT);
    const pre = await host.eval(`(async () => {
      const p = window.__ymDebug.publisher; const sfu = await p._ensureSfu();
      sfu._useTemporalLayers = ${useTL};
      if (${useCap}) { const n = ${N}; const cap = n > 8 ? Math.max(800000, Math.min(3000000, Math.floor(50000000 / n))) : 0; await sfu.setDisplayMaxBitrate(cap); }
      return 'ok';
    })()`);
    const started = await host.eval(`(async () => { const p = window.__ymDebug.publisher; await p.startDisplayCapture({ withMic: false, withTabAudio: false }); return 'ok'; })()`);
    if (VARIANT === 'new') {
      // 실제 코드 경로: host.js 가 2초마다 호출하는 setDisplayMotionMode(true) — 캡처 시작 후 동적으로 전환
      // (테스트 호스트에는 실제 참가자 카메라가 없어 host.js 타이머가 false 를 보내므로, false 호출은 무시하게 감싼다)
      await host.eval('(() => { const p = window.__ymDebug.publisher; const orig = p.setDisplayMotionMode.bind(p); p.setDisplayMotionMode = (on) => { if (on) orig(true); }; orig(true); return 1; })()');
      await sleep(1000);
      console.log('motion 적용 확인:', JSON.stringify(await host.eval(`(() => { const sfu = window.__ymDebug.publisher.sfu; const out = { flag: sfu._displayMotion, keys: [...sfu.producers.keys()] }; const pr = sfu.producers.get('display:video'); out.prodHint = pr && pr.track && pr.track.contentHint; out.deg = pr && pr.rtpSender && pr.rtpSender.getParameters().degradationPreference; return out; })()`)));
    }
    await sleep(9000);

    const hostInfo = async () => JSON.parse(await host.eval(`(async () => {
      const out = [];
      for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        for (const s of pc.getSenders()) {
          if (!s.track || s.track.kind !== 'video') continue;
          const st = await pc.getStats(s.track);
          st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out.push({ bytes: r.bytesSent || 0, frames: r.framesEncoded || 0, w: r.frameWidth, h: r.frameHeight, reason: r.qualityLimitationReason, target: r.targetBitrate || 0, hint: s.track.contentHint }); });
        }
      }
      return JSON.stringify(out);
    })()`));
    const viewerInfo = async (v) => JSON.parse(await v.eval(`(async () => {
      let bytes = 0, dec = 0, w = 0, h = 0, freeze = 0, freezeDur = 0, drop = 0;
      for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { bytes += r.bytesReceived || 0; dec += r.framesDecoded || 0; w = r.frameWidth; h = r.frameHeight; freeze += r.freezeCount || 0; freezeDur += r.totalFreezesDuration || 0; drop += r.framesDropped || 0; } });
      }
      return JSON.stringify({ bytes, dec, w, h, freeze, freezeDur, drop });
    })()`));

    const h0 = await hostInfo(); const v0 = await Promise.all(viewers.map(viewerInfo));
    await sleep(MEASURE_S * 1000);
    const h1 = await hostInfo(); const v1 = await Promise.all(viewers.map(viewerInfo));

    const a = h0.find((x) => x.w >= 640) || h0[0]; const b = h1.find((x) => x.w >= 640) || h1[0];
    const hostFps = (b.frames - a.frames) / MEASURE_S;
    const hostKbps = ((b.bytes - a.bytes) * 8) / MEASURE_S / 1000;
    const fps = viewers.map((_, i) => (v1[i].dec - v0[i].dec) / MEASURE_S);
    const kbps = viewers.map((_, i) => ((v1[i].bytes - v0[i].bytes) * 8) / MEASURE_S / 1000);
    const frz = viewers.reduce((s, _, i) => s + (v1[i].freeze - v0[i].freeze), 0);
    const frzDur = viewers.reduce((s, _, i) => s + (v1[i].freezeDur - v0[i].freezeDur), 0);
    const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
    console.log(`\n=== VARIANT=${VARIANT} 시청자 ${N}명, 화면 ${TILES_W}x${TILES_H} 타일 ===`);
    console.log(`설정: L1T3=${useTL} 상한=${useCap} 힌트=${b.hint} (pre=${pre}, start=${started})`);
    console.log(`호스트 인코딩: ${hostFps.toFixed(1)}fps ${b.w}x${b.h} ${hostKbps.toFixed(0)}kbps 제한사유=${b.reason}`);
    console.log(`시청자 수신: 평균 ${avg(fps).toFixed(1)}fps (최소 ${Math.min(...fps).toFixed(1)}) 평균 ${avg(kbps).toFixed(0)}kbps 해상도 ${v1[0].w}x${v1[0].h}`);
    console.log(`끊김(freeze): ${frz}회, 합계 ${frzDur.toFixed(1)}s`);
  } catch (e) {
    console.log('테스트 예외:', e);
  } finally {
    for (const p of pages) { try { p.ws.close(); } catch { /* ignore */ } }
    try { chrome.kill(); } catch { /* ignore */ }
    try { server.kill(); } catch { /* ignore */ }
    await sleep(500);
    process.exit(0);
  }
})();



