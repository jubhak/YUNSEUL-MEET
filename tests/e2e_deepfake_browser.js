/**
 * 실제 브라우저(Chrome headless) N명이 동시에 딥페이크를 켜고, 호스트 페이지가 각 참가자 영상을 받는지 /
 * 각 참가자의 스왑 파이프라인(프로토콜 v2) 처리량·지연을 측정한다. GPU 워커 필요.
 *   node tests/e2e_deepfake_browser.js [참가자수=4] [측정초=15]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const N = Number(process.argv[2] || 4);
const MEASURE_S = Number(process.argv[3] || 15);
const ROOT = path.resolve(__dirname, '..');
const PORT = 4893;
const DBG = 9334;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

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

(async () => {
  if (!CHROME) { console.log('Chrome 없음'); return; }
  const server = spawn('node', ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let wlog = '';
  server.stdout.on('data', (d) => { wlog += d.toString('utf8'); });
  server.stderr.on('data', (d) => { wlog += d.toString('utf8'); });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-df-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${DBG}`, `--user-data-dir=${userDir}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  const pages = [];
  try {
    // 서버 + 워커 준비 대기
    let ready = false; let statusJson = null;
    for (let i = 0; i < 400 && !ready; i += 1) {
      await sleep(500);
      try {
        const r = await fetch(`${BASE}/api/faceswap-status`);
        if (r.ok) { statusJson = await r.json(); ready = true; }
      } catch { /* retry */ }
    }
    console.log(ready ? `워커 준비 완료: ${JSON.stringify(statusJson).slice(0, 300)}` : '워커 준비 실패');
    if (!ready) { console.log(wlog.slice(-1500)); return; }

    const cr = await (await fetch(`${BASE}/api/create-room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactionMode: 'bidirectional', requireMic: false, allowClientCamera: true, allowClientDeepfake: true }) })).json();
    const q = new URLSearchParams({ code: cr.code, ht: cr.hostToken, hn: '호스트', mode: 'bidirectional', rm: '0', ac: '1', ad: '1' });
    const PCS = 'window.__pcs=[];const _P=window.RTCPeerConnection;window.RTCPeerConnection=function(...a){const p=new _P(...a);window.__pcs.push(p);return p};window.RTCPeerConnection.prototype=_P.prototype;';
    const host = await openPage('host', `${BASE}/host.html?${q}`, PCS);
    pages.push(host);
    await sleep(3000);
    const photos = await (await fetch(`${BASE}/api/photos`)).json();
    console.log(`얼굴 사진 ${photos.photos?.length || 0}개`);

    const viewers = [];
    for (let i = 0; i < N; i += 1) {
      const v = await openPage(`viewer${i + 1}`, `${BASE}/viewer.html?code=${cr.code}`,
        `sessionStorage.setItem('viewerName','참가자${i + 1}');sessionStorage.setItem('roomCode','${cr.code}');sessionStorage.setItem('interactionMode','bidirectional');sessionStorage.setItem('requireMic','false');`);
      viewers.push(v); pages.push(v);
      await sleep(700);
    }
    await sleep(5000);
    // 카메라 클릭 → 얼굴 선택 모달 → 서로 다른 얼굴 선택
    for (let i = 0; i < viewers.length; i += 1) {
      await viewers[i].eval(`document.getElementById('btn-av-cam')?.click()`);
      await sleep(700);
      await viewers[i].eval(`(() => { const cards = document.querySelectorAll('.dlc-hero-card'); const c = cards[${i}] || cards[0]; c && c.click(); })()`);
      await sleep(400);
    }
    console.log(`${N}명 딥페이크 시작 — 워밍업 10초…`);
    await sleep(10000);

    const snap = async (v) => JSON.parse(await v.eval(`(() => { const a = window.__ymDebug?.subscriber?.avatarManager; if (!a) return JSON.stringify(null); return JSON.stringify({ mode: a.mode, swap: a.isSwap, face: a.activeSwapFace, sent: a.swapStats.sent, recv: a.swapStats.recv, dropped: a.swapStats.dropped, rtt: Math.round(a._rttMs||0), proc: Math.round(a._procMs||0), cap: a._serverFpsCap, maxW: a._serverMaxW, q: a._playQ.length, shown: a._lastShownSeq, vis: document.visibilityState, pend: a._pending.size, enc: a._encoding, wsr: a._ws && a._ws.readyState, buf: a._ws && a._ws.bufferedAmount, hasVid: a.rawWebcamVideo && a.rawWebcamVideo.readyState, pump: !!a._swapPumpTimer, encMs: Math.round(a._encMs||0), encTot: Math.round(a._encTotalMs||0), pendKeys: [...a._pending.values()].map(t=>Math.round(performance.now()-t)) }); })()`));
    const hostFrames = async () => JSON.parse(await host.eval(`(async () => { const per = []; for (const pc of (window.__pcs||[])) { if (pc.connectionState==='closed') continue; const st = await pc.getStats(); st.forEach(r => { if (r.type==='inbound-rtp' && r.kind==='video') per.push({ id: r.ssrc, f: r.framesDecoded||0, fr: r.framesReceived||0, freeze: r.freezeCount||0, w: r.frameWidth, h: r.frameHeight }); }); } return JSON.stringify(per); })()`));

    const feedSnap = async () => JSON.parse(await host.eval(`JSON.stringify({ feed: window.__ymDebug?.faceFeed || null, src: window.__ymDebug?.cameraSources || null })`));
    const f0 = await feedSnap();
    const s0 = await Promise.all(viewers.map(snap));
    const h0 = await hostFrames();
    const t0 = Date.now();
    await sleep(MEASURE_S * 1000);
    const s1 = await Promise.all(viewers.map(snap));
    const h1 = await hostFrames();
    const f1 = await feedSnap();
    const dt = (Date.now() - t0) / 1000;

    if (process.env.DEBUG_FEED) {
      console.log('DEBUG feed ws:', await host.eval(`new Promise((res) => { const p = new URLSearchParams(location.search); const w = new WebSocket((location.protocol==='https:'?'wss:':'ws:') + '//' + location.host + '/face-feed?room=' + (p.get('code')||sessionStorage.getItem('roomCode')) + '&ht=' + (p.get('ht')||sessionStorage.getItem('hostToken'))); const log=[]; w.onopen=()=>log.push('open'); w.onerror=()=>log.push('error'); w.onclose=(e)=>{log.push('close '+e.code); res(log.join(','));}; w.onmessage=(m)=>{ if(typeof m.data==='string') log.push('msg '+m.data); }; setTimeout(()=>res(log.join(',')+' (timeout)'), 3000); })`));
    }
    console.log('\n호스트 직송(face-feed) 수신:');
    let feedOk = 0;
    if (f1.feed) {
      console.log(`  connected=${f1.feed.connected} 총프레임=${f1.feed.total} url=${f1.feed.url} ev=${JSON.stringify(f1.feed.events)} 표시원본=${JSON.stringify(f1.src)}`);
      for (const [id, c] of Object.entries(f1.feed.clients)) {
        const prev = f0.feed?.clients?.[id]?.frames || 0;
        const fps = (c.frames - prev) / dt;
        if (fps >= 8 && c.live && f1.src && Object.values(f1.src).includes('feed')) feedOk += 1;
        console.log(`  ${id}: ${fps.toFixed(1)}fps ${c.w}x${c.h} live=${c.live} proc=${c.procMs}ms total(서버)=${c.totalMs}ms`);
      }
    } else {
      console.log('  (직송 비활성)');
    }

    console.log(`\n측정 ${dt.toFixed(1)}초 — 참가자별 스왑 파이프라인`);
    let totalFps = 0; let swapping = 0;
    s1.forEach((b, i) => {
      const a = s0[i];
      if (!a || !b) { console.log(`  viewer${i + 1}: 아바타 매니저 없음`); return; }
      const fps = (b.recv - a.recv) / dt;
      totalFps += fps; if (b.swap) swapping += 1;
      console.log(`  viewer${i + 1}: swap=${b.swap} face=${b.face} 응답 ${fps.toFixed(1)}fps  drop ${b.dropped - a.dropped}  rtt~${b.rtt}ms proc~${b.proc}ms cap=${b.cap} maxW=${b.maxW} shown#${b.shown} | ${JSON.stringify({vis:b.vis,pend:b.pend,enc:b.enc,wsr:b.wsr,buf:b.buf,vid:b.hasVid,pump:b.pump,encMs:b.encMs,encTot:b.encTot,pk:b.pendKeys})}`);
    });
    console.log(`  합계 ${totalFps.toFixed(1)} fps / 스왑 중 ${swapping}/${N}`);

    console.log('\n호스트가 받은 영상(참가자별 디코딩 fps):');
    const hostFps = [];
    h1.forEach((b) => {
      const a = h0.find((x) => x.id === b.id);
      if (!a) return;
      const fps = (b.f - a.f) / dt;
      hostFps.push(fps);
      console.log(`  ssrc ${b.id}: ${fps.toFixed(1)}fps ${b.w}x${b.h} freeze+${b.freeze - a.freeze}`);
    });
    // 폴백 검증: 참가자1 이 딥페이크를 끄면(실제 얼굴) 호스트는 SFU 영상으로 돌아오고, 다시 켜면 직송으로 복귀해야 한다
    let fallbackOk = true;
    if (f1.feed && process.env.FACE_FEED !== '0') {
      const vid = await viewers[0].eval(`window.__ymDebug.subscriber.avatarManager.clientId`);
      const face0 = await viewers[0].eval(`window.__ymDebug.subscriber.avatarManager.activeSwapFace`);
      await viewers[0].eval(`window.__ymDebug.subscriber.avatarManager.setMode('real')`);
      await sleep(2500);
      const fOff = await feedSnap();
      const srcOff = fOff.src?.[vid];
      await viewers[0].eval(`(() => { const a = window.__ymDebug.subscriber.avatarManager; a.activeSwapFace = ${JSON.stringify(face0)}; a.setMode('swap'); return 1; })()`);
      await sleep(3500);
      const fOn = await feedSnap();
      const srcOn = fOn.src?.[vid];
      fallbackOk = srcOff === 'sfu' && srcOn === 'feed';
      if (!fallbackOk) {
        console.log('  (진단) feed:', JSON.stringify(fOn.feed?.clients?.[vid]?.live), JSON.stringify(fOn.feed?.clients?.[vid]), 'viewer1:', JSON.stringify(await snap(viewers[0])));
      }
      console.log(`  폴백 검증: 딥페이크 끔 → ${srcOff}, 다시 켬 → ${srcOn} ${fallbackOk ? 'OK' : 'FAIL'}`);
    }
    const relayLog = wlog.split('\n').filter((l) => /face-feed|face-relay|uncaught|unhandled/i.test(l));
    if (relayLog.length) console.log('서버 로그:', relayLog.slice(0, 5).join(' | '));
    console.log(`  직송 정상 참가자: ${feedOk}/${N}`);
    const okAll = fallbackOk && (process.env.FACE_FEED === '0' || feedOk >= N) && swapping === N && hostFps.filter((f) => f >= 8).length >= Math.min(N, hostFps.length) && hostFps.length >= N;
    console.log(okAll ? '\n✅ 모든 참가자 딥페이크 정상 송출/수신' : '\n❌ 일부 참가자 미달');
    for (const p of pages) if (p.errors.length) console.log(p.name, '오류:', p.errors.slice(0, 3).join(' | ').slice(0, 300));
    process.exitCode = okAll ? 0 : 1;
  } catch (e) {
    console.log('❌ 예외', e);
    process.exitCode = 1;
  } finally {
    for (const p of pages) { try { p.ws.close(); } catch { /* ignore */ } }
    try { chrome.kill(); } catch { /* ignore */ }
    server.kill();
    await sleep(800);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
