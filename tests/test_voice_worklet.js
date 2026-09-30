/**
 * 음성 AudioWorklet(voice-worklet.js) DSP 단위 테스트 (Node, 브라우저 없이 시뮬레이션)
 *  - 작은 목소리 → 증폭(목표 -20dBFS 근처)
 *  - 잡음만 → 게이트로 크게 감쇠, speech=false
 *  - 말소리+잡음 → speech=true
 *  - 큰 목소리 → 리미터로 클리핑 없음
 *   node tests/test_voice_worklet.js
 */
const fs = require('fs');
const path = require('path');

const SR = 48000;
let Ctor = null;
global.sampleRate = SR;
global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => { this.last = m; }, onmessage: null }; } };
global.registerProcessor = (_n, c) => { Ctor = c; };
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'webrtc', 'voice-worklet.js'), 'utf8'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✅ ${m}`); } else { fail += 1; console.log(`  ❌ ${m}`); } };

function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length); }
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

/** 음성 유사 신호: 여러 배음 + 음절(4Hz) 진폭 변조 */
function speechFrame(t0, n, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = t0 + i / SR;
    const env = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t)) ** 1.5;
    let v = 0;
    for (let h = 1; h <= 6; h += 1) v += Math.sin(2 * Math.PI * 160 * h * t) / h;
    out[i] = amp * env * v * 0.55;
  }
  return out;
}
function noiseFrame(n, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (Math.random() * 2 - 1) * amp;
  return out;
}

function run(gen, seconds, opts = {}) {
  const p = new Ctor({ processorOptions: { denoise: true, targetRms: 0.1, maxGain: 8, ...opts } });
  const out = [];
  const outs = [];
  let t = 0;
  const N = 128;
  for (let f = 0; f < (seconds * SR) / N; f += 1) {
    const inp = gen(t, N);
    const o = new Float32Array(N);
    p.process([[inp]], [[o]]);
    out.push(...o);
    outs.push(p.last);
    t += N / SR;
  }
  return { out: Float32Array.from(out), tel: p.last, all: outs };
}

console.log('[1] 작은 목소리(-38dBFS 부근) 증폭');
{
  const inRms = 0.02;
  const r = run((t, n) => speechFrame(t, n, inRms * 3.2), 6);
  const tail = r.out.slice(-SR * 2);
  const g = db(rms(tail)) - db(inRms);
  console.log(`    출력 rms=${db(rms(tail)).toFixed(1)}dBFS (증폭 ${g.toFixed(1)}dB)`);
  ok(g > 4, '작은 목소리가 4dB 이상 증폭됨');
  ok(r.tel.speech === true || r.all.some((m) => m.speech), '말소리 감지(speech=true)');
}

console.log('[2] 잡음만 → 감쇠/무발화');
{
  const r = run((t, n) => noiseFrame(n, 0.01), 6);
  const tail = r.out.slice(-SR * 2);
  console.log(`    출력 rms=${db(rms(tail)).toFixed(1)}dBFS (입력 ${db(0.01 / Math.sqrt(3)).toFixed(1)}dBFS)`);
  ok(rms(tail) < 0.01 / Math.sqrt(3) * 0.6, '배경 잡음이 40% 이상 감쇠됨');
  ok(!r.all.slice(-200).some((m) => m.speech), '잡음만 있을 때 speech=false');
}

console.log('[3] 잡음 + 말소리');
{
  const r = run((t, n) => {
    const s = speechFrame(t, n, 0.15);
    const z = noiseFrame(n, 0.01);
    return s.map((v, i) => v + z[i]);
  }, 8);
  ok(r.all.slice(-300).some((m) => m.speech), '잡음 위에서도 말소리 감지');
}

console.log('[4] 큰 목소리 클리핑 방지');
{
  const r = run((t, n) => speechFrame(t, n, 3.0), 4);
  let peak = 0;
  for (const v of r.out) peak = Math.max(peak, Math.abs(v));
  console.log(`    출력 peak=${peak.toFixed(3)}`);
  ok(peak <= 1.0, '출력이 ±1.0 을 넘지 않음(리미터)');
}

console.log('[5] 완전 무음 입력 안정성(NaN 없음)');
{
  const r = run((t, n) => new Float32Array(n), 2);
  ok(![...r.out].some(Number.isNaN), 'NaN 없음');
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
