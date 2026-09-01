import { SfuClient } from './sfu-client.js?v=20260826sfu20';
import { createMicPipeline } from './mic-pipeline.js?v=20260826sfu20';

/**
 * 참가자: SFU에서 호스트 display 수신 + (선택) 마이크/화면 업링크
 */
export class ViewerSubscriber {
  /**
   * @param {{
   *   signaling: import('./signaling.js').WebrtcSignaling,
   *   videoEl: HTMLVideoElement,
   *   onStatus?: (s: object) => void,
   * }} opts
   */
  constructor({ signaling, videoEl, onStatus }) {
    this.signaling = signaling;
    this.videoEl = videoEl;
    this.onStatus = onStatus || (() => {});
    /** @type {MediaStream|null} */
    this.remoteStream = null;
    this._watching = false;
    this.hostPeerId = null;
    /** @type {SfuClient|null} */
    this.sfu = null;
    this._sfuReady = null;
    /** @type {Promise<boolean>|null} */
    this._watchChain = null;

    this.speakerOn = true;
    this.micOn = false;
    /** @type {MediaStream|null} */
    this._micStream = null;
    this._audioUnlocked = false;
    /** @type {MediaStream|null} */
    this._displayShareStream = null;
    this.sharingScreen = false;
    /** @type {HTMLAudioElement|null} */
    this._remoteAudioEl = null;
    /** @type {MediaStream|null} */
    this._remoteAudioStream = null;

    this._unsubStatus = signaling.onStreamStatus((msg) => {
      if (!msg.active) {
        this._watching = false;
        this.clearRemote();
        this.onStatus({ streamActive: false, streamEnded: true, playing: false });
        return;
      }
      if (this._watching && this.hasLiveVideo()) {
        this.onStatus({ streamActive: true, playing: true });
        return;
      }
      this.onStatus({ streamActive: true, kinds: msg.kinds || [] });
      // watch() 하나로 직렬화 — 병렬 _ensureWatching이 transport를 서로 끊던 버그 방지
      this.watch().catch((err) => {
        console.warn('[ViewerSubscriber] sfu watch', err);
      });
    });
  }

  async _ensureSfu() {
    if (this.sfu && !this.sfu._closed) return this.sfu;
    if (this._sfuReady) return this._sfuReady;
    this._sfuReady = (async () => {
      const sfu = new SfuClient({
        socket: this.signaling.socket,
        clientId: this.signaling.localClientId,
        role: 'viewer',
      });
      sfu.consumeFilter = (info) => {
        const source = info?.appData?.source || '';
        // 자기 화면 공유만 제외. 다른 참가자 마이크는 전원 청취(보이스 미팅)
        if (source === 'viewer-display') return false;
        if (source === 'viewer-mic') return true;
        if (source === 'display' || source === 'tab-audio' || source === 'mic') return true;
        if (info?.role === 'host') return true;
        if (info?.role === 'viewer' && info?.kind === 'audio') return true;
        return info?.kind === 'video' || info?.kind === 'audio';
      };
      sfu.onRemoteStream = (stream) => this._attachRemote(stream);
      sfu.onProducerClosed = () => {
        if (!this.hasLiveVideo()) this._notifyIfStreamDead();
      };
      await sfu.init();
      this.sfu = sfu;
      return sfu;
    })();
    try {
      return await this._sfuReady;
    } finally {
      this._sfuReady = null;
    }
  }

  _resetRecvOnly() {
    const sfu = this.sfu;
    if (!sfu || sfu._closed) return;
    for (const [pid, consumer] of [...sfu.consumers.entries()]) {
      try {
        const track = consumer.track;
        if (track && sfu.remoteStream) {
          try { sfu.remoteStream.removeTrack(track); } catch { /* ignore */ }
        }
        consumer.close();
      } catch { /* ignore */ }
      sfu.consumers.delete(pid);
    }
    try { sfu.recvTransport?.close(); } catch { /* ignore */ }
    sfu.recvTransport = null;
  }

  async _waitLiveVideo(ms = 2500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.hasLiveVideo()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.hasLiveVideo();
  }

  async _ensureWatching() {
    const sfu = await this._ensureSfu();
    if (this.hasLiveVideo() && sfu.recvTransport && !sfu.recvTransport.closed) {
      this._attachRemote(sfu.remoteStream);
      return;
    }
    sfu._pendingProducers = [];
    await sfu.consumeExistingProducers();
    if (sfu.remoteStream?.getTracks?.().length) {
      this._attachRemote(sfu.remoteStream);
    }
    if (await this._waitLiveVideo(2500)) return;
    throw new Error('호스트 영상 producer를 받지 못했습니다. 호스트가 송출 중인지 확인해 주세요.');
  }

  async watch() {
    if (this._watchChain) return this._watchChain;
    this._watchChain = this._watchLoop().finally(() => {
      this._watchChain = null;
    });
    return this._watchChain;
  }

  async _watchLoop() {
    let lastErr = null;
    for (let i = 0; i < 4; i += 1) {
      try {
        if (this.hasLiveVideo()) return true;
        await this._ensureWatching();
        return true;
      } catch (err) {
        lastErr = err;
        console.warn('[ViewerSubscriber] watch try', i + 1, err);
        this.onStatus({
          streamActive: true,
          playing: false,
          connectError: err?.message || String(err),
        });
        if (i < 3) {
          this._resetRecvOnly();
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    this.onStatus({
      streamActive: true,
      playing: false,
      connectError: lastErr?.message || '화면 연결 실패',
    });
    throw lastErr || new Error('화면 연결 실패');
  }

  _visuallyHideMediaEl(el) {
    el.setAttribute('playsinline', '');
    el.playsInline = true;
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
  }

  async _ensurePlayMix() {
    if (this._playMix?.master) return this._playMix;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = this._audioCtx && this._audioCtx.state !== 'closed'
      ? this._audioCtx
      : new AC();
    this._audioCtx = ctx;
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    const master = ctx.createGain();
    master.gain.value = this.speakerOn && this._audioUnlocked ? 1 : 0;
    master.connect(ctx.destination);
    this._playMix = {
      ctx,
      master,
      sources: new Map(),
    };
    return this._playMix;
  }

  /**
   * 소리는 WebAudio 믹스만 담당. 영상 연결은 _attachRemote에서 동기적으로 먼저 처리.
   * @param {MediaStream} stream
   */
  async _syncRemoteAudio(stream) {
    if (!stream) return;

    const liveIds = new Set();
    try {
      const mix = await this._ensurePlayMix();
      if (!mix) return;

      for (const track of stream.getAudioTracks()) {
        if (!track || track.readyState === 'ended') continue;
        liveIds.add(track.id);
        if (mix.sources.has(track.id)) continue;
        try {
          const src = mix.ctx.createMediaStreamSource(new MediaStream([track]));
          const gain = mix.ctx.createGain();
          gain.gain.value = 1;
          const analyser = mix.ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(gain);
          gain.connect(mix.master);
          gain.connect(analyser);
          mix.sources.set(track.id, { src, gain, analyser, track });
          this._reportAudioDiag('track-add', track);
        } catch (err) {
          console.warn('[ViewerSubscriber] mix add', err);
        }
      }

      for (const [id, entry] of [...mix.sources.entries()]) {
        if (!liveIds.has(id) || entry.track.readyState === 'ended') {
          try { entry.src.disconnect(); } catch { /* ignore */ }
          try { entry.gain.disconnect(); } catch { /* ignore */ }
          mix.sources.delete(id);
        }
      }

      mix.master.gain.value = this.speakerOn && this._audioUnlocked ? 1 : 0;

      if (!this._levelTimer) {
        this._levelTimer = setInterval(() => {
          if (!this._playMix) return;
          if (this._playMix.ctx.state === 'suspended') {
            this._playMix.ctx.resume().catch(() => {});
          }
          let peak = 0;
          for (const { analyser, track } of this._playMix.sources.values()) {
            if (track.readyState === 'ended') continue;
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i += 1) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            if (rms > peak) peak = rms;
          }
          this._lastRms = peak;
          if (!this._lastRmsReport || Date.now() - this._lastRmsReport > 3000) {
            this._lastRmsReport = Date.now();
            this._reportAudioDiag(
              peak > 0.02 ? 'level-hot' : 'level-silent',
              null,
              `rms=${peak.toFixed(4)} tracks=${this._playMix.sources.size}`
            );
          }
        }, 500);
      }
    } catch (err) {
      console.warn('[ViewerSubscriber] sync audio', err);
    }
  }

  _reportAudioDiag(event, track, detail = '') {
    try {
      const socket = this.signaling?.socket;
      if (!socket?.connected) return;
      if (event === 'track-add') {
        const key = `${event}:${track?.id || ''}`;
        if (this._diagOnce?.has(key)) return;
        if (!this._diagOnce) this._diagOnce = new Set();
        this._diagOnce.add(key);
      }
      socket.emit('client-diag', {
        kind: 'viewer-audio',
        event,
        detail: detail || undefined,
        speakerOn: this.speakerOn,
        unlocked: this._audioUnlocked,
        videoMuted: !!this.videoEl?.muted,
        trackId: track?.id ? String(track.id).slice(0, 8) : undefined,
        muted: track?.muted,
        enabled: track?.enabled,
        readyState: track?.readyState,
        mixTracks: this._playMix?.sources?.size || 0,
        rms: this._lastRms,
      });
    } catch { /* ignore */ }
  }

  _attachRemote(stream) {
    this.remoteStream = stream;
    const video = this.videoEl;
    if (!video) return;

    const vtracks = (stream.getVideoTracks() || []).filter((t) => t && t.readyState !== 'ended');
    const hasAudio = (stream.getAudioTracks() || []).some((t) => t && t.readyState !== 'ended');

    // 영상 먼저 연결 — 오디오 오류와 분리해서 송출 대기 고착 방지
    if (vtracks.length) {
      const cur = video.srcObject;
      const curId = cur instanceof MediaStream ? cur.getVideoTracks()[0]?.id : null;
      if (curId !== vtracks[0].id) {
        video.srcObject = new MediaStream(vtracks);
      }
      video.playsInline = true;
      video.muted = true;
      this._watching = true;
      this.onStatus({
        streamActive: true,
        playing: true,
        hasRemoteAudio: hasAudio,
        needUnmute: hasAudio && this.speakerOn && !this._audioUnlocked,
      });
      video.play().catch(() => {});
    } else if (hasAudio) {
      this.onStatus({
        streamActive: true,
        hasRemoteAudio: true,
        needUnmute: this.speakerOn && !this._audioUnlocked,
      });
    }

    this._syncRemoteAudio(stream).catch((err) => {
      console.warn('[ViewerSubscriber] sync audio', err);
    });
  }

  clearRemote() {
    if (this._levelTimer) {
      clearInterval(this._levelTimer);
      this._levelTimer = null;
    }
    if (this._playMix) {
      for (const entry of this._playMix.sources.values()) {
        try { entry.src.disconnect(); } catch { /* ignore */ }
        try { entry.gain.disconnect(); } catch { /* ignore */ }
      }
      this._playMix.sources.clear();
      try { this._playMix.master.disconnect(); } catch { /* ignore */ }
      this._playMix = null;
    }
    if (this._meterSources) {
      for (const { src, clone } of this._meterSources.values()) {
        try { src.disconnect(); } catch { /* ignore */ }
        try { clone?.stop?.(); } catch { /* ignore */ }
      }
      this._meterSources.clear();
    }
    if (this.sfu) {
      try {
        for (const track of [...(this.sfu.remoteStream?.getTracks?.() || [])]) {
          try { this.sfu.remoteStream.removeTrack(track); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    this.remoteStream = null;
    this._watching = false;
    if (this.videoEl) {
      try { this.videoEl.pause(); } catch { /* ignore */ }
      this.videoEl.srcObject = null;
    }
    if (this._remoteAudioEl) {
      try { this._remoteAudioEl.pause(); } catch { /* ignore */ }
      this._remoteAudioEl.srcObject = null;
    }
    this._remoteAudioStream = null;
  }

  hasLiveVideo() {
    const stream = this.videoEl?.srcObject;
    if (!(stream instanceof MediaStream)) return false;
    return stream.getVideoTracks().some((t) => t && t.readyState !== 'ended');
  }

  _notifyIfStreamDead() {
    if (this.hasLiveVideo()) return;
    this.onStatus({ streamActive: false, streamEnded: true, playing: false });
  }

  async unlockAudio() {
    this._audioUnlocked = true;
    try {
      if (this._audioCtx?.state === 'suspended') await this._audioCtx.resume();
    } catch { /* ignore */ }
    if (this.remoteStream) await this._syncRemoteAudio(this.remoteStream);
    const mix = await this._ensurePlayMix();
    if (mix) mix.master.gain.value = this.speakerOn ? 1 : 0;
    this.onStatus({
      streamActive: true,
      playing: this.hasLiveVideo(),
      hasRemoteAudio: !!(this.remoteStream?.getAudioTracks?.().length),
      needUnmute: false,
    });
    return true;
  }

  async setSpeakerEnabled(on) {
    this.speakerOn = !!on;
    if (on && !this._audioUnlocked) {
      await this.unlockAudio();
    }
    const mix = await this._ensurePlayMix();
    if (mix) mix.master.gain.value = this.speakerOn && this._audioUnlocked ? 1 : 0;
    this.onStatus({
      streamActive: true,
      playing: this.hasLiveVideo(),
      hasRemoteAudio: !!(this.remoteStream?.getAudioTracks?.().length),
      needUnmute: this.speakerOn && !this._audioUnlocked,
    });
  }

  async setMicEnabled(on) {
    this.micOn = !!on;
    if (!on) {
      await this._stopMic();
      return true;
    }
    try {
      await this._startMic();
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] mic', err);
      this.micOn = false;
      return false;
    }
  }

  async _startMic() {
    if (this._micStream) return;
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const rawTrack = raw.getAudioTracks()[0];
    if (!rawTrack) throw new Error('마이크 트랙 없음');
    const pipeline = await createMicPipeline(rawTrack);
    this._micStream = pipeline.stream;
    this._micPipeline = pipeline;
    const sfu = await this._ensureSfu();
    await sfu.ensureSendTransport();
    for (const track of this._micStream.getAudioTracks()) {
      await sfu.produce(track, { source: 'viewer-mic' });
    }
  }

  async _stopMic() {
    if (this._micPipeline) {
      try { this._micPipeline.close(); } catch { /* ignore */ }
      this._micPipeline = null;
    }
    if (this._micStream) {
      for (const t of this._micStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this._micStream = null;
    }
    const sfu = this.sfu;
    if (!sfu) return;
    for (const [pid, producer] of [...sfu.producers.entries()]) {
      const source = producer.appData?.source;
      if (source !== 'viewer-mic') continue;
      try { producer.close(); } catch { /* ignore */ }
      sfu.producers.delete(pid);
      try {
        sfu.socket.emit('sfu-close-producer', { producerId: pid });
      } catch { /* ignore */ }
    }
  }

  async startScreenShare() {
    if (this.sharingScreen) return true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      this._displayShareStream = stream;
      this.sharingScreen = true;
      const sfu = await this._ensureSfu();
      await sfu.ensureSendTransport();
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => {
          this.stopScreenShare().catch(() => {});
        });
        await sfu.produce(track, { source: 'viewer-display' });
      }
      return true;
    } catch (err) {
      console.warn('[ViewerSubscriber] screen share', err);
      this.sharingScreen = false;
      return false;
    }
  }

  async stopScreenShare() {
    this.sharingScreen = false;
    if (this._displayShareStream) {
      for (const t of this._displayShareStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
      this._displayShareStream = null;
    }
    const sfu = this.sfu;
    if (!sfu) return;
    for (const [pid, producer] of [...sfu.producers.entries()]) {
      if (producer.appData?.source !== 'viewer-display') continue;
      try { producer.close(); } catch { /* ignore */ }
      sfu.producers.delete(pid);
      try {
        sfu.socket.emit('sfu-close-producer', { producerId: pid });
      } catch { /* ignore */ }
    }
  }

  destroy() {
    try { this._unsubStatus?.(); } catch { /* ignore */ }
    this.clearRemote();
    this._stopMic().catch(() => {});
    this.stopScreenShare().catch(() => {});
    try { this.sfu?.close?.(); } catch { /* ignore */ }
    this.sfu = null;
  }

  dispose() {
    this.destroy();
  }
}
