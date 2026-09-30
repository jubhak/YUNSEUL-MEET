/**
 * 음성 전처리 AudioWorklet (오디오 스레드에서 동작 → 탭이 백그라운드여도 지연/끊김 없음)
 *
 *  1) 적응형 잡음 바닥(noise floor) 추적  : 정상 소음(선풍기/에어컨/PC팬)을 스스로 학습
 *  2) 소프트 익스팬더(게이트)              : 말이 없을 때 잡음을 -18dB 이상 낮춤(완전 차단 X → 뚝뚝 끊기지 않음)
 *  3) 자동 이득(AGC)                       : 작은 목소리를 목표 레벨(-20dBFS)까지 최대 +18dB 증폭, 큰 소리는 즉시 낮춤
 *  4) 소프트 리미터                        : 증폭 후 찢어지는(클리핑) 소리 방지
 *  5) "깨끗한 음성" 판정                   : SNR + 저역 에너지 비율(유성음) + 홀드
 *
 * 메인 스레드로 ~30ms 마다 { level, rms, noise, snr, speech, gate, gain } 를 보낸다.
 */
class YmVoiceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.denoise = o.denoise !== false;
    this.targetRms = o.targetRms || 0.1; // -20 dBFS
    this.maxGain = o.maxGain || 8; // +18 dB
    this.minGain = o.minGain || 0.5; // -6 dB
    this.floorGain = o.floorGain || 0.1; // 잡음 구간 감쇠(-20 dB)
    this.openDb = o.openDb || 9; // 게이트 열림 SNR
    this.closeDb = o.closeDb || 5; // 게이트 닫힘 SNR
    this.minAbs = o.minAbs || 0.004; // 이 이하는 무음 취급(-48 dBFS)

    const sr = sampleRate;
    this.blockDt = 128 / sr;
    const coef = (tc) => 1 - Math.exp(-this.blockDt / tc);
    this.aFast = coef(0.02);
    this.aEnv = coef(0.06);
    this.aGateAtk = coef(0.004);
    this.aGateRel = coef(0.16);
    this.aAgcDown = coef(0.03);
    this.aAgcUp = coef(0.7);
    this.aNoiseDown = coef(0.06);
    this.aNoiseUp = coef(6.5);
    this.aOut = coef(0.05);
    this.lpA = 1 - Math.exp(-2 * Math.PI * 1500 / sr); // 1.5kHz 1-pole LP

    this.lp = 0;
    this.noise = 0.003;
    this.env = 0; // 입력 RMS(빠른)
    this.speechEnv = 0; // 말하는 동안의 RMS
    this.open = false;
    this.holdBlocks = 0;
    this.gate = this.floorGain;
    this.agc = 1;
    this.outRms = 0;
    this.speechHold = 0;
    this.speech = false;
    this.lowRatio = 0;
    this.reportCount = 0;
    this.reportEvery = Math.max(1, Math.round(0.03 / this.blockDt));
    this.peak = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'config') {
        if (typeof m.denoise === 'boolean') this.denoise = m.denoise;
        if (m.targetRms) this.targetRms = m.targetRms;
        if (m.maxGain) this.maxGain = m.maxGain;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const inCh = input && input[0];
    const n = output[0].length;
    if (!inCh) {
      for (let c = 0; c < output.length; c += 1) output[c].fill(0);
      this._report(0, 0);
      return true;
    }

    // 블록 분석
    let sum = 0;
    let lowSum = 0;
    let pk = 0;
    let lp = this.lp;
    for (let i = 0; i < n; i += 1) {
      const x = inCh[i];
      sum += x * x;
      lp += this.lpA * (x - lp);
      lowSum += lp * lp;
      const ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
    }
    this.lp = lp;
    const rms = Math.sqrt(sum / n);
    const lowRms = Math.sqrt(lowSum / n);
    this.lowRatio = rms > 1e-6 ? Math.min(1, lowRms / rms) : 0;
    this.env += this.aEnv * (rms - this.env);
    if (rms > this.env) this.env += this.aFast * (rms - this.env);

    // 잡음 바닥 추적: 내려갈 땐 빠르게, 올라갈 땐 '바닥 근처'일 때만 아주 느리게
    if (rms < this.noise) {
      this.noise += this.aNoiseDown * (rms - this.noise);
    } else if (rms < this.noise * 2.5) {
      this.noise += this.aNoiseUp * (rms - this.noise);
    }
    if (this.noise < 0.0004) this.noise = 0.0004;
    if (this.noise > 0.05) this.noise = 0.05;

    const snrDb = 20 * Math.log10((this.env + 1e-9) / (this.noise + 1e-9));
    if (this.open) {
      if (snrDb < this.closeDb || this.env < this.minAbs) {
        if (this.holdBlocks <= 0) this.open = false;
        else this.holdBlocks -= 1;
      } else {
        this.holdBlocks = Math.round(0.18 / this.blockDt);
      }
    } else if (snrDb > this.openDb && this.env > this.minAbs) {
      this.open = true;
      this.holdBlocks = Math.round(0.18 / this.blockDt);
    }

    // 게이트 이득(부드러운 ramp)
    const gTarget = this.denoise ? (this.open ? 1 : this.floorGain) : 1;
    const gA = gTarget > this.gate ? this.aGateAtk : this.aGateRel;
    const gPrev = this.gate;
    this.gate += gA * (gTarget - this.gate);

    // AGC: 말하는 동안만 레벨 학습
    if (this.open) {
      this.speechEnv += this.aEnv * (rms - this.speechEnv);
      const desired = Math.min(this.maxGain, Math.max(this.minGain, this.targetRms / (this.speechEnv + 1e-6)));
      const a = desired < this.agc ? this.aAgcDown : this.aAgcUp;
      this.agc += a * (desired - this.agc);
    }
    // 큰 소리가 갑자기 들어오면 즉시 이득 낮춤(클리핑 방지)
    if (rms * this.agc * this.gate > 0.7) {
      this.agc = Math.max(this.minGain, this.agc * 0.7);
    }

    // 깨끗한 음성 판정
    const voiced = this.open && this.lowRatio > 0.45 && snrDb > this.openDb;
    if (voiced) this.speechHold = Math.round(0.28 / this.blockDt);
    else if (this.speechHold > 0) this.speechHold -= 1;
    this.speech = this.speechHold > 0;

    // 출력(블록 내 선형 보간으로 게이트 계단 방지) + 소프트 리미터
    let outSum = 0;
    let outPk = 0;
    const gEnd = this.gate;
    const fl = this.floorGain;
    const agc = this.agc;
    // 게이트가 닫히는 구간에서는 AGC 증폭이 잡음까지 키우지 않도록 totalGain 을 floor↔agc 사이에서 보간
    const total = (g) => {
      const o = fl >= 1 ? 1 : Math.min(1, Math.max(0, (g - fl) / (1 - fl)));
      return fl + (agc - fl) * o;
    };
    const t0 = total(gPrev);
    const t1 = total(gEnd);
    for (let i = 0; i < n; i += 1) {
      const g = t0 + ((t1 - t0) * (i + 1)) / n;
      let y = inCh[i] * g;
      const ay = y < 0 ? -y : y;
      if (ay > 0.85) {
        y = (y < 0 ? -1 : 1) * (0.85 + 0.14 * Math.tanh((ay - 0.85) / 0.14));
      }
      outSum += y * y;
      const oy = y < 0 ? -y : y;
      if (oy > outPk) outPk = oy;
      for (let c = 0; c < output.length; c += 1) output[c][i] = y;
    }
    const outRms = Math.sqrt(outSum / n);
    this.outRms += this.aOut * (outRms - this.outRms);
    if (outPk > this.peak) this.peak = outPk;
    this._report(outRms, snrDb);
    return true;
  }

  _report(outRms, snrDb) {
    this.reportCount += 1;
    if (this.reportCount < this.reportEvery) return;
    this.reportCount = 0;
    const db = 20 * Math.log10(this.outRms + 1e-6);
    const level = Math.max(0, Math.min(1, (db + 52) / 34));
    this.port.postMessage({
      level,
      rms: this.outRms,
      peak: this.peak,
      noise: this.noise,
      snr: snrDb,
      speech: this.speech,
      open: this.open,
      gain: this.agc,
    });
    this.peak = 0;
  }
}

registerProcessor('ym-voice-processor', YmVoiceProcessor);
