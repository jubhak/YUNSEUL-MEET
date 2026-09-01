/**
 * 마이크 전처리: 노이즈 게이트 + 轻度 고역 필터
 * 원본 트랙을 복제해 분석/처리하므로 재생 경로를 가로채지 않음.
 */

/**
 * @param {MediaStreamTrack} track
 * @param {{
 *   gateThreshold?: number,
 *   gateHangMs?: number,
 *   onLevel?: (rms: number, open: boolean) => void,
 * }} [opts]
 */
export async function createMicPipeline(track, opts = {}) {
  if (!track || track.kind !== 'audio') {
    throw new Error('audio track required');
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    return {
      track,
      stream: new MediaStream([track]),
      close: () => {},
    };
  }

  const ctx = new AC();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }

  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 85;
  highpass.Q.value = 0.7;

  const gate = ctx.createGain();
  gate.gain.value = 0;

  const dest = ctx.createMediaStreamDestination();
  source.connect(highpass);
  highpass.connect(gate);
  gate.connect(dest);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  highpass.connect(analyser);

  const threshold = opts.gateThreshold ?? 0.02;
  const hangMs = opts.gateHangMs ?? 220;
  let openUntil = 0;
  let closed = false;

  const data = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    if (closed) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (rms >= threshold) openUntil = now + hangMs;
    const open = now < openUntil;
    const target = open ? 1 : 0;
    try {
      gate.gain.cancelScheduledValues(ctx.currentTime);
      gate.gain.setTargetAtTime(target, ctx.currentTime, open ? 0.015 : 0.05);
    } catch {
      gate.gain.value = target;
    }
    opts.onLevel?.(rms, open);
  }, 40);

  const outTrack = dest.stream.getAudioTracks()[0];
  if (outTrack) {
    try { outTrack.contentHint = 'speech'; } catch { /* ignore */ }
  }

  return {
    track: outTrack || track,
    stream: dest.stream,
    ctx,
    close: () => {
      closed = true;
      clearInterval(timer);
      try { source.disconnect(); } catch { /* ignore */ }
      try { highpass.disconnect(); } catch { /* ignore */ }
      try { gate.disconnect(); } catch { /* ignore */ }
      try { analyser.disconnect(); } catch { /* ignore */ }
      try { track.stop(); } catch { /* ignore */ }
      try { ctx.close(); } catch { /* ignore */ }
    },
  };
}
