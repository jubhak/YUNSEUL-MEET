/**
 * 말하는 사람 표시
 *  - 깨끗한 목소리가 감지되면 해당 참가자의 영상 박스(카메라 OFF면 ID 박스)에 3px 노란 테두리
 *    (absolute 오버레이 → 레이아웃 이동 없음) + 우측 하단 50px 막대그래프(목소리 크기)
 *  - DOM 에서 `data-speak-id="<clientId>"` 속성을 가진 요소를 매 틱 스캔해 자동 연결하므로,
 *    카드가 다시 렌더링되어도 별도의 바인딩 관리가 필요 없다.
 *
 * 사용:
 *   speakingIndicator.trackRemote(clientId, mediaStreamTrack)   // 원격 참가자 오디오
 *   speakingIndicator.trackLocal(clientId, voicePipeline)       // 내 마이크(파이프라인 텔레메트리)
 *   speakingIndicator.untrack(clientId)
 */
import { bandsFromFreq } from './webrtc/mic-pipeline.js?v=20260930a';

const BAR_COUNT = 7;

class SpeakingIndicatorManager {
  constructor() {
    this.sources = new Map();
    this.ctx = null;
    this._timer = null;
    this._lastSpeaking = new Map();
    this.onSpeakingChange = null;
    this._currentSpotlightId = null;
    this.onSpotlightVoice = null;
    this._visHandler = () => this._reschedule();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._visHandler);
    }
  }

  setSpotlightSpeaker(id) {
    this._currentSpotlightId = id || null;
  }

  _ensureCtx() {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC({ latencyHint: 'playback' });
    return this.ctx;
  }

  start() {
    if (this._timer) return;
    this._reschedule();
  }

  _reschedule() {
    if (this._timer) clearInterval(this._timer);
    const hidden = typeof document !== 'undefined' && document.hidden;
    this._timer = setInterval(() => this._tick(), hidden ? 500 : 50);
  }

  /** 원격 오디오 트랙 등록 (이미 <audio> 로 재생 중이어야 Chrome 에서 분석 데이터가 나옴) */
  trackRemote(id, track) {
    if (!id || !track) return;
    this.untrack(id);
    const ctx = this._ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
      src.connect(analyser);
      this.sources.set(id, {
        type: 'remote',
        src,
        analyser,
        time: new Uint8Array(analyser.fftSize),
        freq: new Uint8Array(analyser.frequencyBinCount),
        hold: 0,
        speaking: false,
        track,
      });
      const onEnd = () => {
        const cur = this.sources.get(id);
        if (cur && cur.track === track) this.untrack(id);
      };
      track.addEventListener('ended', onEnd, { once: true });
    } catch (err) {
      console.warn('[SpeakingIndicator] trackRemote 실패', err);
    }
    this.start();
  }

  /** 내 마이크: VoicePipeline 의 텔레메트리(깨끗한 음성 판정 포함)를 그대로 사용 */
  trackLocal(id, pipeline) {
    if (!id || !pipeline) return;
    this.untrack(id);
    this.sources.set(id, { type: 'local', pipeline, hold: 0, speaking: false });
    this.start();
  }

  untrack(id) {
    const s = this.sources.get(id);
    if (!s) return;
    if (s.type === 'remote') {
      try { s.src.disconnect(); } catch { /* ignore */ }
      try { s.analyser.disconnect(); } catch { /* ignore */ }
    }
    this.sources.delete(id);
    this._lastSpeaking.delete(id);
  }

  isSpeaking(id) {
    return !!this.sources.get(id)?.speaking;
  }

  /** 합성 화면·오버레이용 현재 발화 상태 */
  getVisual(id) {
    const s = this.sources.get(id);
    if (!s) return { speaking: false, level: 0, bands: null };
    return this._measure(id, s, performance.now());
  }

  _measure(id, s, now) {
    if (s.type === 'local') {
      const t = s.pipeline.telemetry || {};
      const speaking = !!t.speech && (s.pipeline.hasInput);
      s.speaking = speaking;
      const bands = speaking ? s.pipeline.getBands(BAR_COUNT) : null;
      return { speaking, level: speaking ? (t.level || 0) : 0, bands };
    }
    s.analyser.getByteTimeDomainData(s.time);
    let sum = 0;
    for (let i = 0; i < s.time.length; i += 1) {
      const v = (s.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / s.time.length);
    // 송신 측에서 이미 잡음 제거/게이트가 적용된 소리 → 절대 임계 + 히스테리시스
    const on = s.speaking ? rms > 0.008 : rms > 0.016;
    if (on) s.hold = now + 320;
    s.speaking = on || now < s.hold;
    let bands = null;
    if (s.speaking) {
      s.analyser.getByteFrequencyData(s.freq);
      bands = bandsFromFreq(s.freq, this.ctx.sampleRate, s.analyser.fftSize, BAR_COUNT);
    }
    const db = 20 * Math.log10(rms + 1e-6);
    return { speaking: s.speaking, level: Math.max(0, Math.min(1, (db + 52) / 34)), bands };
  }

  _ensureOverlay(el) {
    if (el._ymSpeak && el._ymSpeak.ring.parentNode === el) return el._ymSpeak;
    if (getComputedStyle(el).position === 'static') el.classList.add('ym-speak-host');
    const ring = document.createElement('div');
    ring.className = 'ym-speak-ring';
    const bars = document.createElement('div');
    bars.className = 'ym-speak-bars';
    const items = [];
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const b = document.createElement('i');
      bars.appendChild(b);
      items.push(b);
    }
    el.appendChild(ring);
    el.appendChild(bars);
    el._ymSpeak = { ring, bars, items };
    return el._ymSpeak;
  }

  _tick() {
    if (typeof document === 'undefined') return;
    const now = performance.now();
    const els = document.querySelectorAll('[data-speak-id]');
    const cache = new Map();
    els.forEach((el) => {
      const id = el.dataset.speakId;
      let m = cache.get(id);
      if (m === undefined) {
        const s = this.sources.get(id);
        m = s ? this._measure(id, s, now) : null;
        cache.set(id, m);
      }
      const speaking = !!(m && m.speaking);
      const ov = speaking || el._ymSpeak ? this._ensureOverlay(el) : null;
      if (speaking !== el.classList.contains('is-speaking-clean')) {
        el.classList.toggle('is-speaking-clean', speaking);
      }
      if (speaking && ov && m.bands) {
        const lvl = 0.35 + 0.65 * m.level;
        for (let i = 0; i < ov.items.length; i += 1) {
          const v = Math.max(0.1, Math.min(1, m.bands[i] * lvl * 1.15));
          ov.items[i].style.transform = `scaleY(${v.toFixed(2)})`;
        }
      }

      // 접속자 명단(viewers-list) 내 실시간 주파수/이퀄라이저 파형 애니메이션
      const wave = el.querySelector('.viewers-wave-bars');
      if (wave) {
        const bars = wave.children;
        if (speaking && m && m.bands && bars.length) {
          const lvl = 0.35 + 0.65 * (m.level || 0);
          for (let i = 0; i < bars.length; i += 1) {
            const bandVal = m.bands[i] || m.bands[0] || 0.3;
            const v = Math.max(0.18, Math.min(1.0, bandVal * lvl * 1.35));
            bars[i].style.transform = `scaleY(${v.toFixed(2)})`;
          }
        } else if (!speaking && bars.length) {
          for (let i = 0; i < bars.length; i += 1) {
            bars[i].style.transform = 'scaleY(0.18)';
          }
        }
      }
    });

    if (this.onSpotlightVoice && this._currentSpotlightId) {
      const spId = this._currentSpotlightId;
      const s = this.sources.get(spId);
      const m = s ? this._measure(spId, s, now) : null;
      try { this.onSpotlightVoice(!!(m && m.speaking), m?.level || 0); } catch { /* ignore */ }
    }
    if (this.onSpeakingChange) {
      for (const [id, s] of this.sources.entries()) {
        const prev = this._lastSpeaking.get(id);
        if (prev !== s.speaking) {
          this._lastSpeaking.set(id, s.speaking);
          try { this.onSpeakingChange(id, s.speaking); } catch { /* ignore */ }
        }
      }
    }
    // 화면에 요소가 없는 소스도 상태가 갱신되도록(콜백용) 측정
    if (this.onSpeakingChange) {
      for (const [id, s] of this.sources.entries()) {
        if (!cache.has(id)) this._measure(id, s, now);
      }
    }
  }
}

export const speakingIndicator = new SpeakingIndicatorManager();
