/**
 * 지속형(persistent) 음성 파이프라인
 *
 *   [마이크 원본 트랙] → inputBus → highpass(90Hz) → AudioWorklet(잡음학습·게이트·AGC·리미터) → analyser → destination
 *
 * 핵심 설계
 *  - 출력 트랙(outTrack)은 세션 내내 "하나"다. SFU producer 는 이 트랙에 한 번만 붙이고,
 *    마이크 켜기/끄기는 "입력만 붙였다 떼는" 것으로 처리한다 → producer/트랜스포트가 흔들리지 않아
 *    마이크 토글이 영상 송출에 절대 영향을 주지 않는다.
 *  - 입력이 없으면 destination 은 디지털 무음을 내보낸다(Opus DTX 로 대역폭 거의 0).
 *  - 워크릿을 못 쓰거나(구형 브라우저), 워크릿 출력이 무음인데 입력은 큰 상태가 계속되면
 *    자동으로 안전 모드(bypass: 원본 직결)로 전환한다 → "가공하다 소리가 사라지는" 사고 방지.
 */

const WORKLET_URL = new URL('./voice-worklet.js?v=20260930a', import.meta.url).href;

export const MIC_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  // 자동 이득은 파이프라인(AGC)이 더 안정적으로 처리 → 이중 AGC(펌핑) 방지
  autoGainControl: false,
  channelCount: 1,
};

export class VoicePipeline {
  constructor(opts = {}) {
    this.opts = opts;
    this.ctx = null;
    this.outTrack = null;
    this.outStream = null;
    this.onTelemetry = null;
    /** @type {((reason: string) => void)|null} */
    this.onDegraded = null;
    this.mode = 'init'; // worklet | fallback | bypass
    this._src = null;
    this._inputTrack = null;
    this._timer = null;
    this._closed = false;
    this._silentOutMs = 0;
    this._last = { level: 0, rms: 0, snr: 0, speech: false, open: false, noise: 0, gain: 1 };
    this._fbSpeechHold = 0;
    this._fbGateOpenUntil = 0;
  }

  static async create(opts = {}) {
    const p = new VoicePipeline(opts);
    await p._init();
    return p;
  }

  get ctxState() {
    return this.ctx?.state || 'closed';
  }

  get telemetry() {
    return this._last;
  }

  get hasInput() {
    return !!this._inputTrack && this._inputTrack.readyState === 'live';
  }

  async _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('이 브라우저는 Web Audio 를 지원하지 않습니다.');
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      ctx = new AC({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    this._ensureRunning();
    ctx.addEventListener?.('statechange', () => { if (ctx.state === 'suspended') this._ensureRunning(); });
    this._bindGestureResume();

    this.inputBus = ctx.createGain();
    this.inAnalyser = ctx.createAnalyser();
    this.inAnalyser.fftSize = 1024;
    this.inputBus.connect(this.inAnalyser);

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 90;
    this.hp.Q.value = 0.7;
    this.inputBus.connect(this.hp);

    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.outAnalyser.smoothingTimeConstant = 0.6;
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.outAnalyser.connect(this.dest);

    let workletOk = false;
    if (ctx.audioWorklet && this.opts.useWorklet !== false) {
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        this.node = new AudioWorkletNode(ctx, 'ym-voice-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: {
            denoise: this.opts.denoise !== false,
            targetRms: this.opts.targetRms,
            maxGain: this.opts.maxGain,
          },
        });
        this.node.port.onmessage = (e) => this._onWorkletMessage(e.data);
        this.hp.connect(this.node);
        this.node.connect(this.outAnalyser);
        this.mode = 'worklet';
        workletOk = true;
      } catch (err) {
        console.warn('[VoicePipeline] AudioWorklet 사용 불가 → 대체 체인:', err);
      }
    }
    if (!workletOk) this._buildFallbackChain();

    this.outStream = this.dest.stream;
    this.outTrack = this.dest.stream.getAudioTracks()[0] || null;
    if (this.outTrack) {
      try { this.outTrack.contentHint = 'speech'; } catch { /* ignore */ }
    }

    this._inBuf = new Uint8Array(this.inAnalyser.fftSize);
    this._outBuf = new Uint8Array(this.outAnalyser.fftSize);
    this._freqBuf = new Uint8Array(this.outAnalyser.frequencyBinCount);
    this._timer = setInterval(() => this._tick(), 100);
  }

  _buildFallbackChain() {
    const ctx = this.ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -34;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.2;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 3; // ≈ +9.5 dB
    this.fbGate = ctx.createGain();
    this.fbGate.gain.value = 0.15;
    this.hp.connect(this.comp);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.fbGate);
    this.fbGate.connect(this.outAnalyser);
    this.mode = 'fallback';
  }

  _onWorkletMessage(m) {
    if (!m) return;
    this._last = {
      level: m.level, rms: m.rms, snr: m.snr, speech: !!m.speech, open: !!m.open, noise: m.noise, gain: m.gain,
    };
    this._emit();
  }

  _emit() {
    try { this.onTelemetry?.(this._last); } catch { /* ignore */ }
  }

  _rms(analyser, buf) {
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i] - 128) / 128;
      s += v * v;
    }
    return Math.sqrt(s / buf.length);
  }

  _tick() {
    if (this._closed) return;
    if (this.ctx.state === 'suspended') this._ensureRunning();
    const inRms = this._rms(this.inAnalyser, this._inBuf);

    if (this.mode === 'fallback' || this.mode === 'bypass') {
      // 워크릿이 없거나 bypass 일 때: 메인 스레드에서 레벨/발화 판정(+대체 체인은 느슨한 게이트)
      const now = performance.now();
      if (inRms > 0.012) this._fbGateOpenUntil = now + 300;
      const open = now < this._fbGateOpenUntil;
      if (this.mode === 'fallback' && this.fbGate) {
        try { this.fbGate.gain.setTargetAtTime(open ? 1 : 0.2, this.ctx.currentTime, open ? 0.02 : 0.12); } catch { /* ignore */ }
      }
      const outRms = this._rms(this.outAnalyser, this._outBuf);
      const db = 20 * Math.log10(outRms + 1e-6);
      const speech = open && inRms > 0.02;
      if (speech) this._fbSpeechHold = now + 280;
      this._last = {
        level: Math.max(0, Math.min(1, (db + 52) / 34)),
        rms: outRms, snr: 0, speech: now < this._fbSpeechHold, open, noise: 0, gain: 3,
      };
      this._emit();
    }

    // 안전장치: 입력은 크게 들어오는데 출력이 계속 무음 → 원본 직결(bypass)
    if (this.mode !== 'bypass' && this.hasInput) {
      const outRms = this._rms(this.outAnalyser, this._outBuf);
      if (inRms > 0.03 && outRms < 0.0015) {
        this._silentOutMs += 100;
        if (this._silentOutMs >= 2500) this._enterBypass('출력 무음 감지');
      } else {
        this._silentOutMs = 0;
      }
    }
  }

  _enterBypass(reason) {
    if (this.mode === 'bypass') return;
    console.warn('[VoicePipeline] bypass 전환:', reason);
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.fbGate?.disconnect(); } catch { /* ignore */ }
    try { this.inputBus.connect(this.outAnalyser); } catch { /* ignore */ }
    this.mode = 'bypass';
    try { this.onDegraded?.(reason); } catch { /* ignore */ }
  }

  _ensureRunning() {
    if (!this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed') return;
    this.ctx.resume().catch(() => {});
  }

  _bindGestureResume() {
    if (this._gestureBound || typeof window === 'undefined') return;
    this._gestureBound = true;
    const fn = () => {
      this._ensureRunning();
      if (this.ctx?.state === 'running') {
        ['pointerdown', 'keydown', 'touchstart', 'click'].forEach((t) => window.removeEventListener(t, fn, true));
      }
    };
    this._gestureFn = fn;
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach((t) => window.addEventListener(t, fn, true));
  }

  /** 마이크 원본 트랙을 입력에 연결(기존 입력은 교체) */
  attachInput(track) {
    this.detachInput();
    if (!track) return;
    this._ensureRunning();
    this._inputTrack = track;
    this._src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this._src.connect(this.inputBus);
    this._silentOutMs = 0;
  }

  /** 입력 분리(무음 출력). 원본 트랙 stop 은 호출자가 한다. */
  detachInput() {
    if (this._src) {
      try { this._src.disconnect(); } catch { /* ignore */ }
      this._src = null;
    }
    this._inputTrack = null;
    this._silentOutMs = 0;
    this._last = { ...this._last, level: 0, rms: 0, speech: false, open: false };
    this._emit();
  }

  /** 막대그래프용 주파수 대역 레벨(0..1) n개 (음성 대역 150Hz~4kHz 로그 간격) */
  getBands(n = 7) {
    if (!this.outAnalyser) return new Array(n).fill(0);
    this.outAnalyser.getByteFrequencyData(this._freqBuf);
    return bandsFromFreq(this._freqBuf, this.ctx.sampleRate, this.outAnalyser.fftSize, n);
  }

  setDenoise(on) {
    this.node?.port?.postMessage({ type: 'config', denoise: !!on });
  }

  close() {
    this._closed = true;
    clearInterval(this._timer);
    this.detachInput();
    if (this._gestureFn) {
      ['pointerdown', 'keydown', 'touchstart', 'click'].forEach((t) => window.removeEventListener(t, this._gestureFn, true));
    }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.outTrack?.stop(); } catch { /* ignore */ }
    try { this.ctx?.close(); } catch { /* ignore */ }
  }
}

/** FFT 바이트 배열 → 로그 간격 n개 대역(0..1). 화면 막대그래프에서도 재사용 */
export function bandsFromFreq(freq, sampleRate, fftSize, n = 7, lo = 150, hi = 4000) {
  const out = new Array(n).fill(0);
  const binHz = sampleRate / fftSize;
  const ratio = Math.pow(hi / lo, 1 / n);
  let f0 = lo;
  for (let b = 0; b < n; b += 1) {
    const f1 = f0 * ratio;
    const i0 = Math.max(1, Math.floor(f0 / binHz));
    const i1 = Math.min(freq.length - 1, Math.max(i0, Math.ceil(f1 / binHz)));
    let sum = 0;
    let cnt = 0;
    for (let i = i0; i <= i1; i += 1) { sum += freq[i]; cnt += 1; }
    out[b] = cnt ? Math.min(1, (sum / cnt / 255) * 1.35) : 0;
    f0 = f1;
  }
  return out;
}
