/**
 * mediasoup SFU 클라이언트 (호스트 produce / 참가자 consume)
 *
 * Chrome 버그 회피: audio/video 각각 별도 send transport 사용
 * (같은 PC에서 produce 재협상 시 RTP extension ID 충돌 방지)
 */
export class SfuClient {
  /**
   * @param {{ socket: import('socket.io-client').Socket, clientId: string, role: 'host'|'viewer' }} opts
   */
  constructor({ socket, clientId, role }) {
    this.socket = socket;
    this.clientId = clientId;
    this.role = role;
    this.device = null;
    /** @type {import('mediasoup-client').types.Transport|null} */
    this.sendTransportVideo = null;
    /** @type {import('mediasoup-client').types.Transport|null} */
    this.sendTransportAudio = null;
    this.recvTransport = null;
    /** @type {Map<string, import('mediasoup-client').types.Producer>} */
    this.producers = new Map();
    /** @type {Map<string, import('mediasoup-client').types.Consumer>} */
    this.consumers = new Map();
    /** @type {Map<string, object>} producerId -> consume meta */
    this.consumerMeta = new Map();
    this.remoteStream = new MediaStream();
    this._closed = false;
    this._pendingProducers = [];
    this._produceChain = Promise.resolve();
    this._consumeChain = Promise.resolve();
    this._displayMaxBitrate = 0;
    this._displayStartBitrate = 0;
    /** 송출을 일시정지(인코딩·전송 중단)해 둔 source 목록 — 새 producer 가 만들어져도 다시 적용된다 */
    this._inactiveSources = new Set();
    /** @type {((stream: MediaStream) => void)|null} */
    this.onRemoteStream = null;
    /** @type {((info: object, consumer: object) => void)|null} */
    this.onConsumed = null;
    /** @type {((msg: object) => void)|null} */
    this.onProducerClosed = null;
    /** @type {((info: object) => boolean)|null} */
    this.consumeFilter = null;
    this._boundNewProducer = (msg) => this._onNewProducer(msg);
    this._boundProducerClosed = (msg) => this._onProducerClosed(msg);
    this.socket.on('sfu-new-producer', this._boundNewProducer);
    this.socket.on('sfu-producer-closed', this._boundProducerClosed);
  }

  request(event, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('socket disconnected'));
        return;
      }
      this.socket.timeout(20000).emit(event, data, (err, res) => {
        if (err) return reject(err instanceof Error ? err : new Error(String(err)));
        if (!res || res.error) return reject(new Error(res?.error || 'sfu error'));
        resolve(res);
      });
    });
  }


  waitTransportConnected(transport, label = 'transport', ms = 15000) {
    const ok = (st) => st === 'connected' || st === 'completed';
    if (ok(transport.connectionState)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        try { transport.off('connectionstatechange', onState); } catch { /* ignore */ }
        fn(arg);
      };
      const timer = setTimeout(() => {
        finish(reject, new Error(
          `${label} 연결 시간 초과 (${transport.connectionState}). `
          + '공유기 UDP/TCP 44444 포워딩과 방화벽을 확인해 주세요.'
        ));
      }, ms);
      const onState = (connectionState) => {
        const st = connectionState || transport.connectionState;
        if (ok(st)) finish(resolve);
        else if (st === 'failed' || st === 'closed') {
          finish(reject, new Error(`${label} ICE 실패 (${st})`));
        }
      };
      // 이벤트 유실 대비 폴링
      const poll = setInterval(() => onState(transport.connectionState), 200);
      transport.on('connectionstatechange', onState);
      onState(transport.connectionState);
    });
  }
  _sanitizeCaps(rtpCapabilities) {
    const deny = new Set([
      'urn:3gpp:video-orientation',
      'urn:ietf:params:rtp-hdrext:toffset',
    ]);
    return {
      codecs: rtpCapabilities.codecs,
      headerExtensions: (rtpCapabilities.headerExtensions || []).filter(
        (ext) => !deny.has(ext.uri)
      ),
    };
  }

  async init() {
    // 동일 출처 번들 (CDN 차단/실패 방지). 서버 mediasoup 3.26 ↔ client 3.22
    const mod = await import(`../vendor/mediasoup-client.js?v=20260826sfu16`);
    const Device = mod.Device || mod.default?.Device || mod.default;
    if (!Device) throw new Error('mediasoup-client Device 로드 실패');
    const caps = await this.request('sfu-get-capabilities');
    this.device = new Device();
    const rtpCapabilities = this._sanitizeCaps(
      typeof structuredClone === 'function'
        ? structuredClone(caps.rtpCapabilities)
        : JSON.parse(JSON.stringify(caps.rtpCapabilities))
    );
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    this._pendingProducers = caps.producers || [];
    return caps;
  }

  async restartIce(transport) {
    if (!transport || transport.closed) return false;
    try {
      const res = await this.request('sfu-restart-ice', { transportId: transport.id });
      if (res?.iceParameters) {
        await transport.restartIce({ iceParameters: res.iceParameters });
        console.log(`[sfu-client] restartIce succeeded for transport ${String(transport.id).slice(0, 8)}`);
        return true;
      }
    } catch (err) {
      console.warn('[sfu-client] restartIce failed:', err);
    }
    return false;
  }

  _attachTransportHealth(transport, label = 'transport') {
    transport.on('connectionstatechange', async (state) => {
      console.log(`[sfu-client] ${label} (${String(transport.id).slice(0, 8)}) state: ${state}`);
      if (state === 'disconnected') {
        setTimeout(async () => {
          if (transport.connectionState === 'disconnected') {
            console.warn(`[sfu-client] ${label} still disconnected, attempting ICE restart...`);
            await this.restartIce(transport);
          }
        }, 700);
      } else if (state === 'failed') {
        console.warn(`[sfu-client] ${label} failed, attempting immediate ICE restart...`);
        const ok = await this.restartIce(transport);
        if (!ok) {
          try { transport.close(); } catch { /* ignore */ }
          try { this.onTransportFailed?.(transport, label); } catch { /* ignore */ }
          // 수신 트랜스포트가 복구 불가면 새로 만들어 모든 producer 를 다시 consume
          if (label === 'recv-transport' && !this._closed && !this._rebuildingRecv) {
            this._rebuildingRecv = true;
            (async () => {
              try {
                for (const [pid, c] of [...this.consumers.entries()]) {
                  try { this.remoteStream.removeTrack(c.track); } catch { /* ignore */ }
                  try { c.close(); } catch { /* ignore */ }
                  this.consumers.delete(pid);
                  this.consumerMeta.delete(pid);
                }
                this.recvTransport = null;
                await this.ensureRecvTransport();
                await this.consumeExistingProducers();
                console.log('[sfu-client] recv transport rebuilt');
              } catch (err) {
                console.warn('[sfu-client] recv rebuild failed', err);
              } finally {
                this._rebuildingRecv = false;
              }
            })();
          }
          // 송신 트랜스포트가 복구 불가면, 같은 종류의 producer 를 새 트랜스포트로 즉시 재송출
          if (String(label).startsWith('send-transport') && !this._closed) {
            const purpose = transport.appData?.purpose === 'audio' ? 'audio' : 'video';
            for (const [key, producer] of [...this.producers.entries()]) {
              if (!producer) continue;
              if ((producer.kind === 'audio') !== (purpose === 'audio')) continue;
              this.recoverProducer(key, { recreateTransport: false }).catch(() => {});
            }
          }
        }
      }
    });
  }

  async _createSendTransport(purpose = 'video') {
    // purpose(audio|video)를 서버에 알려 "종류별 독립 트랜스포트"를 유지한다.
    // (예전에는 마이크용 send transport 를 만들 때 서버가 영상 send transport 까지 닫아 영상이 멈췄다)
    const info = await this.request('sfu-create-transport', { direction: 'send', purpose });
    const transport = this.device.createSendTransport(info);
    transport.appData = { ...(transport.appData || {}), purpose };
    this._attachTransportHealth(transport, `send-transport:${purpose}`);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('sfu-connect-transport', {
        transportId: transport.id,
        dtlsParameters,
      }).then(() => callback()).catch(errback);
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      this.request('sfu-produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData,
      }).then((res) => {
        // 서버가 produce를 거부(res.error)하면 callback이 영영 호출되지 않아
        // 이후 마이크/영상 송출이 조용히 죽는다(가장 흔한 "마이크 안 들림" 원인).
        if (!res || res.error || !res.id) {
          return errback(new Error(res?.error || 'produce-rejected'));
        }
        return callback({ id: res.id });
      }).catch(errback);
    });
    return transport;
  }

  async ensureSendTransportFor(kind) {
    const purpose = kind === 'audio' ? 'audio' : 'video';
    const field = purpose === 'audio' ? 'sendTransportAudio' : 'sendTransportVideo';
    const cur = this[field];
    if (cur && !cur.closed && cur.connectionState !== 'failed') return cur;
    // 동시 호출(마이크 + 카메라 동시 시작 등)에도 트랜스포트가 이중 생성되지 않도록 잠금
    if (!this._sendCreating) this._sendCreating = {};
    if (this._sendCreating[purpose]) return this._sendCreating[purpose];
    this._sendCreating[purpose] = (async () => {
      if (cur && !cur.closed) { try { cur.close(); } catch { /* ignore */ } }
      const t = await this._createSendTransport(purpose);
      this[field] = t;
      return t;
    })();
    try {
      return await this._sendCreating[purpose];
    } finally {
      this._sendCreating[purpose] = null;
    }
  }

  /** @deprecated 호환용 — video transport */
  async ensureSendTransport() {
    return this.ensureSendTransportFor('video');
  }

  async ensureRecvTransport() {
    if (this.recvTransport && !this.recvTransport.closed) return this.recvTransport;
    if (this._recvTransportCreating) return this._recvTransportCreating;
    this._recvTransportCreating = (async () => {
      const info = await this.request('sfu-create-transport', { direction: 'recv' });
      const transport = this.device.createRecvTransport(info);
      this._attachTransportHealth(transport, 'recv-transport');
      transport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this.request('sfu-connect-transport', {
          transportId: transport.id,
          dtlsParameters,
        }).then(() => callback()).catch(errback);
      });
      this.recvTransport = transport;
      return transport;
    })();
    try {
      return await this._recvTransportCreating;
    } finally {
      this._recvTransportCreating = null;
    }
  }

  _producerKey(track, appData = {}) {
    const source = appData.source || appData.trackKind || 'default';
    return `${source}:${track.kind}`;
  }

  /**
   * @param {MediaStream} stream
   * @param {{ source?: string, trackKind?: string }} appData
   */
  async publishStream(stream, appData = {}) {
    const run = async () => {
      const produced = [];
      for (const track of stream.getTracks()) {
        if (track.readyState === 'ended') continue;
        const key = this._producerKey(track, appData);
        const existing = this.producers.get(key);
        if (existing && !existing.closed) {
          await existing.replaceTrack({ track });
          produced.push(existing);
          continue;
        }
        const transport = await this.ensureSendTransportFor(track.kind);
        const source = appData.source || 'display';
        const produceOpts = {
          track,
          // 중요: mediasoup-client 기본값(stopTracks=true)은 replaceTrack()/close() 때 "이전 트랙"을 stop() 한다.
          // 그러면 참가자 화면 릴레이 시작 때 호스트 자신의 화면 트랙이 죽어, 릴레이가 끝나도
          // 호스트 화면으로 복귀할 수 없었다(재송출 복구도 불가). 트랙 수명은 호출자가 직접 관리한다.
          stopTracks: false,
          appData: {
            trackKind: appData.trackKind || track.kind,
            source,
            ...appData,
          },
        };
        if (track.kind === 'video') {
          const isCam = source === 'camera' || source === 'viewer-camera';
          if (isCam) {
            try { track.contentHint = 'motion'; } catch { /* ignore */ }
            const settings = track.getSettings?.() || {};
            const w = Number(settings.width) || 640;
            const fps = Math.min(Number(settings.frameRate) || 28, 30);
            let maxBitrate = 350_000;
            let maxFramerate = 28;
            if (w <= 320 || fps <= 12) {
              maxBitrate = 80_000;
              maxFramerate = 10;
            } else if (w <= 384 || fps <= 15) {
              maxBitrate = 110_000;
              maxFramerate = 14;
            } else if (w <= 480 || fps <= 22) {
              maxBitrate = 180_000;
              maxFramerate = 22;
            } else if (w >= 900) {
              maxBitrate = 900_000;
              maxFramerate = 26;
            }
            produceOpts.encodings = [{
              maxBitrate,
              maxFramerate,
              scaleResolutionDownBy: 1,
            }];
            produceOpts.codecOptions = {
              videoGoogleStartBitrate: Math.round(maxBitrate / 1500),
              videoGoogleMaxBitrate: Math.round(maxBitrate / 1000),
              videoGoogleMinBitrate: Math.max(40, Math.round(maxBitrate / 4000)),
            };
          } else {
            // 화면 공유(Display Share / PPT / 문서): 텍스트 가독성을 위해 해상도 보존('detail') 설정.
            // 단, 화면에 참가자 영상 타일이 움직이는 동안(_displayMotion)에는 'motion'(프레임 우선)으로 보낸다.
            try { track.contentHint = this._displayMotion ? 'motion' : 'detail'; } catch { /* ignore */ }
            produceOpts.codecOptions = {
              videoGoogleStartBitrate: this._displayStartBitrate
                ? Math.round(this._displayStartBitrate / 1000)
                : 1500,
            };
            // 호스트 화면은 시청자 N명에게 그대로 복제돼 나가는 유일한 대용량 스트림(서버 상향 대역폭의 대부분).
            // 인원 수에 따른 비트레이트 상한(_displayMaxBitrate)이 있으면 처음부터 적용한다.
            // 시간계층(L1T3)은 측정 결과 화질/끊김이 오히려 나빠져(freeze ↑, 해상도 ↓) 기본 끔 — _useTemporalLayers 로만 켠다.
            const enc = { scaleResolutionDownBy: 1 };
            if (this._displayMaxBitrate) enc.maxBitrate = this._displayMaxBitrate;
            if (source === 'display' && this._useTemporalLayers) enc.scalabilityMode = 'L1T3';
            produceOpts.encodings = [enc];
          }
        } else if (track.kind === 'audio') {
          try { track.contentHint = (source === 'mic' || source === 'viewer-mic') ? 'speech' : 'music'; } catch { /* ignore */ }
          produceOpts.codecOptions = {
            opusStereo: source !== 'mic' && source !== 'viewer-mic',
            opusFec: true,
            // 마이크 첫마디 씹힘/단절 방지: 연속 음성 패킷 전송
            opusDtx: false,
            opusMaxAverageBitrate: (source === 'mic' || source === 'viewer-mic') ? 64000 : 128000,
          };
        }
        let producer;
        try {
          producer = await transport.produce(produceOpts);
        } catch (err) {
          // L1T3 를 못 받아들이는 환경(브라우저/코덱)이면 단일 계층으로 폴백 — 화면 송출이 실패하면 안 된다.
          if (produceOpts.encodings?.[0]?.scalabilityMode) {
            console.warn('[SFU] scalabilityMode L1T3 실패 → 단일 계층 폴백:', err?.message || err);
            this._useTemporalLayers = false;
            delete produceOpts.encodings[0].scalabilityMode;
            producer = await transport.produce(produceOpts);
          } else {
            throw err;
          }
        }
        if (track.kind === 'video' && producer.rtpSender) {
          try {
            const params = producer.rtpSender.getParameters();
            if (params) {
              const isCam = source === 'camera' || source === 'viewer-camera';
              // 화면공유는 maintain-resolution, 카메라는 maintain-framerate
              params.degradationPreference = (isCam || (source === 'display' && this._displayMotion)) ? 'maintain-framerate' : 'maintain-resolution';
              if (isCam && Array.isArray(params.encodings) && params.encodings.length) {
                const enc0 = produceOpts.encodings?.[0] || {};
                params.encodings = params.encodings.map((enc) => ({
                  ...enc,
                  maxBitrate: enc0.maxBitrate || enc.maxBitrate,
                  maxFramerate: enc0.maxFramerate || enc.maxFramerate,
                }));
              }
              producer.rtpSender.setParameters(params).catch(() => {});
            }
          } catch { /* ignore */ }
        }
        this.producers.set(key, producer);
        produced.push(producer);
        if (track.kind === 'video' && this._inactiveSources.has(source)) {
          this._applySenderActive(producer, false).catch(() => {});
        }
        track.addEventListener('ended', () => {
          try { producer.close(); } catch { /* ignore */ }
          this.producers.delete(key);
          this.request('sfu-close-producer', { producerId: producer.id }).catch(() => {});
        });
      }
      return produced;
    };

    const prev = this._produceChain;
    let release;
    this._produceChain = new Promise((r) => { release = r; });
    try {
      await prev.catch(() => {});
      return await run();
    } finally {
      release();
    }
  }

  /** 같은 kind 중 특정 source(display/camera/...)를 우선 선택한다.
   * 기존 구현은 Map 삽입 순서상 'display' producer를 집어와, 카메라 교체
   * 요청이 화면공유 트랙을 바꿔버리는 사고가 가능했다. */
  getProducerByKind(kind, sourceHint = null) {
    let fallback = null;
    for (const [key, producer] of this.producers.entries()) {
      if (!producer || producer.closed || producer.kind !== kind) continue;
      if (!sourceHint) return producer;
      if (key.startsWith(`${sourceHint}:`)) return producer;
      if (!fallback) fallback = producer; // sourceHint가 있는데 못 찾으면 null
    }
    return sourceHint ? null : fallback;
  }

  /** source별 video producer 트랙 교체 (예: 'camera', 'display') */
  async replaceProducerTrackForSource(source, track) {
    const producer = this.getProducerByKind('video', source);
    if (!producer) return false;
    await producer.replaceTrack({ track: track || null });
    return true;
  }

  async replaceVideoTrack(track) {
    // 호환용: 기존 동작과 동일하게 display producer를 우선 교체
    const producer = this.getProducerByKind('video', 'display') || this.getProducerByKind('video');
    if (!producer) return false;
    await producer.replaceTrack({ track: track || null });
    return true;
  }

  /**
   * 호스트 화면(display) 송출 비트레이트 상한 설정. bitrate 가 falsy 면 상한 해제.
   * 이후 새로 만들어지는 display producer 에도 적용된다.
   */
  async setDisplayEncodeBudget({ maxBitrate = 0, startBitrate = 0 } = {}) {
    this._displayStartBitrate = startBitrate ? Math.round(startBitrate) : 0;
    await this.setDisplayMaxBitrate(maxBitrate);
  }

  async setDisplayMaxBitrate(bitrate) {
    const next = bitrate ? Math.round(bitrate) : 0;
    if (next === (this._displayMaxBitrate || 0)) return;
    this._displayMaxBitrate = next;
    for (const [key, producer] of this.producers.entries()) {
      if (!key.startsWith('display:') || producer.closed || producer.kind !== 'video') continue;
      try {
        const sender = producer.rtpSender;
        const params = sender?.getParameters();
        if (!params?.encodings?.length) continue;
        params.encodings = params.encodings.map((enc) => {
          const e = { ...enc };
          if (next) e.maxBitrate = next; else delete e.maxBitrate;
          return e;
        });
        await sender.setParameters(params);
      } catch { /* ignore */ }
    }
  }

  /**
   * 호스트 화면에 움직이는 영상(참가자 타일)이 있을 때는 프레임 우선('motion' + maintain-framerate),
   * 없으면(PPT/문서) 글씨 우선('detail' + maintain-resolution).
   * 측정(1920x1080, 20타일 움직이는 화면): detail → 약 4fps 로 끊김, motion → 23~30fps (해상도는 대역폭에 맞춰 자동 축소).
   */
  async setDisplayMotion(on, force = false) {
    const next = !!on;
    if (next === !!this._displayMotion && !force) return;
    this._displayMotion = next;
    for (const [key, producer] of this.producers.entries()) {
      if (!key.startsWith('display:') || producer.closed || producer.kind !== 'video') continue;
      try { if (producer.track) producer.track.contentHint = next ? 'motion' : 'detail'; } catch { /* ignore */ }
      try {
        const sender = producer.rtpSender;
        const params = sender?.getParameters();
        if (!params) continue;
        params.degradationPreference = next ? 'maintain-framerate' : 'maintain-resolution';
        await sender.setParameters(params);
      } catch { /* ignore */ }
    }
  }

  async _applySenderActive(producer, active) {
    const sender = producer?.rtpSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params?.encodings?.length) return;
    let changed = false;
    params.encodings = params.encodings.map((enc) => {
      if (enc.active === active) return enc;
      changed = true;
      return { ...enc, active };
    });
    if (changed) await sender.setParameters(params);
  }

  /**
   * source 의 영상 송출을 켜고 끈다(인코딩·전송 자체를 멈춤 — 트랙/producer 는 유지되어 재개가 즉시 된다).
   * 마이크 등 오디오에는 영향이 없다. producer 가 재생성되어도 상태가 유지된다.
   * 모드 전환(얼굴 화면 ↔ PC 화면) 때 "지금 안 보이는 쪽" 업로드를 0 으로 만드는 용도.
   */
  async setVideoSourceActive(source, active) {
    if (active) this._inactiveSources.delete(source); else this._inactiveSources.add(source);
    const prefix = `${source}:`;
    for (const [key, producer] of this.producers.entries()) {
      if (!key.startsWith(prefix) || producer.closed || producer.kind !== 'video') continue;
      try { await this._applySenderActive(producer, !!active); } catch { /* ignore */ }
    }
  }

  /**
   * 카메라 producer 인코딩을 현재 트랙 프로파일에 맞게 갱신
   */
  async updateCameraEncodings(source, profile = {}) {
    const prefix = `${source}:`;
    for (const [key, producer] of this.producers.entries()) {
      if (!key.startsWith(prefix) || producer.closed || producer.kind !== 'video') continue;
      try {
        const sender = producer.rtpSender;
        if (!sender) continue;
        const params = sender.getParameters();
        if (!params?.encodings?.length) continue;
        const maxBitrate = profile.maxBitrate || 120_000;
        const maxFramerate = profile.fps || 20;
        params.encodings = params.encodings.map((enc) => ({
          ...enc,
          maxBitrate,
          maxFramerate,
        }));
        await sender.setParameters(params);
      } catch { /* ignore */ }
    }
  }

  /**
   * producer 를 (같은 트랙, 같은 appData 로) 닫고 다시 만든다. 필요하면 트랜스포트도 새로 만든다.
   * 송신 정지(freeze) 복구의 마지막 수단.
   */
  async recoverProducer(key, { recreateTransport = false } = {}) {
    const producer = this.producers.get(key);
    // 트랜스포트가 닫혀 producer 가 이미 closed 인 경우에도 복구할 수 있어야 한다
    // (stopTracks:false 이므로 track 은 살아 있다)
    if (!producer) return false;
    const track = producer.track;
    if (!track || track.readyState !== 'live') return false;
    const appData = { ...(producer.appData || {}) };
    const kind = producer.kind;
    const oldId = producer.id;
    try { if (!producer.closed) producer.close(); } catch { /* ignore */ }
    this.producers.delete(key);
    this.request('sfu-close-producer', { producerId: oldId }).catch(() => {});
    if (recreateTransport) {
      const field = kind === 'audio' ? 'sendTransportAudio' : 'sendTransportVideo';
      const t = this[field];
      if (t && !t.closed) { try { t.close(); } catch { /* ignore */ } }
      this[field] = null;
    }
    try {
      await this.publishStream(new MediaStream([track]), appData);
      console.log(`[sfu-client] producer 복구 완료: ${key} (recreateTransport=${recreateTransport})`);
      return true;
    } catch (err) {
      console.warn('[sfu-client] producer 복구 실패:', key, err);
      return false;
    }
  }

  /**
   * 송신 정지 감시: 카메라/마이크 producer 의 bytesSent 가 멈추면 단계적으로 복구한다.
   *  1단계(2.5초): ICE 재시작 + 같은 트랙 replaceTrack (인코더 키프레임 강제)
   *  2단계(6초):   producer 재생성(트랜스포트 유지)
   *  3단계(12초):  트랜스포트까지 새로 만들어 재송출
   */
  startSenderMonitor({ intervalMs = 1500, onStalled = null, onRecovered = null } = {}) {
    if (this._senderTimer) return;
    this._senderState = new Map();
    this.onSenderStalled = onStalled || this.onSenderStalled;
    this.onSenderRecovered = onRecovered || this.onSenderRecovered;
    this._senderBusy = false;
    this._senderTimer = setInterval(() => {
      if (this._senderBusy || this._closed) return;
      this._senderBusy = true;
      this._senderTick().catch(() => {}).finally(() => { this._senderBusy = false; });
    }, intervalMs);
  }

  stopSenderMonitor() {
    if (this._senderTimer) clearInterval(this._senderTimer);
    this._senderTimer = null;
  }

  async _senderTick() {
    // 마이크는 DTX 로 정상적으로도 패킷이 거의 없을 수 있어 감시 대상에서 제외
    const monitored = new Set(['camera', 'viewer-camera']);
    const now = Date.now();
    for (const [key, producer] of [...this.producers.entries()]) {
      if (!producer) { this._senderState.delete(key); continue; }
      const source = producer.appData?.source || '';
      if (producer.closed) {
        // 트랜스포트 종료 등으로 producer 만 닫힌 경우: 트랙이 살아 있으면 재송출
        this._senderState.delete(key);
        if (monitored.has(source) && producer.track?.readyState === 'live') {
          await this.recoverProducer(key, { recreateTransport: false });
        }
        continue;
      }
      if (!monitored.has(source)) continue;
      // 일부러 멈춰 둔(모드 전환) 송출은 "정지"가 아니므로 복구 대상에서 제외
      if (this._inactiveSources.has(source)) { this._senderState.delete(key); continue; }
      const track = producer.track;
      if (!track || track.readyState !== 'live' || producer.paused) { this._senderState.delete(key); continue; }
      if (producer.kind === 'audio' && track.enabled === false) { this._senderState.delete(key); continue; }
      let bytes = null;
      try {
        const stats = await producer.getStats();
        stats.forEach((r) => {
          if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === producer.kind) {
            bytes = Math.max(bytes ?? 0, Number(r.bytesSent) || 0);
          }
        });
      } catch { /* ignore */ }
      if (bytes == null) continue;
      const st = this._senderState.get(key) || { bytes: -1, lastAdvance: now, stage: 0, holdUntil: 0 };
      if (bytes > st.bytes) {
        if (st.stage > 0) {
          try { this.onSenderRecovered?.({ key, source, stage: st.stage }); } catch { /* ignore */ }
        }
        st.bytes = bytes;
        st.lastAdvance = now;
        st.stage = 0;
      } else if (now >= st.holdUntil) {
        const stalled = now - st.lastAdvance;
        const transport = producer.kind === 'audio' ? this.sendTransportAudio : this.sendTransportVideo;
        if (stalled > 2500 && st.stage < 1) {
          st.stage = 1;
          try { this.onSenderStalled?.({ key, source, stage: 1, stalledMs: stalled }); } catch { /* ignore */ }
          if (transport && transport.connectionState !== 'connected') this.restartIce(transport).catch(() => {});
          try { await producer.replaceTrack({ track }); } catch { /* ignore */ }
        } else if (stalled > 6000 && st.stage < 2) {
          st.stage = 2;
          try { this.onSenderStalled?.({ key, source, stage: 2, stalledMs: stalled }); } catch { /* ignore */ }
          await this.recoverProducer(key, { recreateTransport: false });
          st.bytes = -1;
          st.lastAdvance = Date.now();
        } else if (stalled > 12000 && st.stage < 3) {
          st.stage = 3;
          try { this.onSenderStalled?.({ key, source, stage: 3, stalledMs: stalled }); } catch { /* ignore */ }
          await this.recoverProducer(key, { recreateTransport: true });
          st.bytes = -1;
          st.lastAdvance = Date.now();
          st.stage = 0;
          st.holdUntil = Date.now() + 10_000; // 반복 재송출(thrash) 방지
        }
      }
      this._senderState.set(key, st);
    }
  }

  /**
   * 수신측 얼굴 영상 정지 감시 (참가자 카메라 consumer 대상).
   * framesDecoded(없으면 bytesReceived)가 멈추면 단계적으로 복구한다:
   *   1.5s  키프레임(PLI) 요청
   *   3.5s  consumer 서버측 pause→resume (재동기화 + 키프레임)
   *   6.5s  consumer 를 닫고 같은 producer 를 다시 consume
   *   12s   수신 트랜스포트 ICE 재시작
   */
  startReceiverMonitor({ intervalMs = 1000, onStalled = null, onRecovered = null } = {}) {
    if (this._rxMonTimer) return;
    this._rxState = new Map();
    this._rxLastIceRestart = 0;
    this._rxMonTimer = setInterval(() => {
      this._receiverTick(onStalled, onRecovered).catch(() => {});
    }, intervalMs);
  }

  stopReceiverMonitor() {
    if (this._rxMonTimer) {
      clearInterval(this._rxMonTimer);
      this._rxMonTimer = null;
    }
    this._rxState?.clear();
  }

  async _receiverTick(onStalled, onRecovered) {
    if (this._closed || this._rxBusy) return;
    // 참가자 카메라 송출을 일부러 멈춰 둔 동안(PC 화면 모드)에는 "정지"가 정상 → 복구 시도(PLI/재-consume) 금지
    if (this.receiverSuspended) { this._rxState?.clear(); return; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      // 백그라운드 탭은 디코딩이 스로틀되므로 판정 보류
      this._rxState.forEach((st) => { st.changedAt = performance.now(); st.stage = 0; });
      return;
    }
    this._rxBusy = true;
    try {
      const now = performance.now();
      const alive = new Set();
      for (const [producerId, consumer] of [...this.consumers.entries()]) {
        if (!consumer || consumer.closed || consumer.kind !== 'video') continue;
        const meta = this.consumerMeta.get(producerId);
        const source = meta?.appData?.source || '';
        if (source !== 'viewer-camera' && source !== 'camera') continue;
        alive.add(consumer.id);
        if (consumer.paused || consumer.producerPaused) {
          this._rxState.delete(consumer.id);
          continue;
        }
        let frames = null;
        let bytes = 0;
        try {
          const stats = await consumer.getStats();
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
              if (typeof r.framesDecoded === 'number') frames = r.framesDecoded;
              bytes = r.bytesReceived || 0;
            }
          });
        } catch { continue; }

        const metric = frames != null ? frames : bytes;
        const st = this._rxState.get(consumer.id);
        if (!st) {
          this._rxState.set(consumer.id, { metric, changedAt: now, stage: 0 });
          continue;
        }
        if (metric > st.metric) {
          if (st.stage > 0) onRecovered?.({ producerId, clientId: meta?.clientId, stage: st.stage });
          st.metric = metric;
          st.changedAt = now;
          st.stage = 0;
          continue;
        }
        const stalledMs = now - st.changedAt;
        const step = stalledMs >= 12000 ? 4 : stalledMs >= 6500 ? 3 : stalledMs >= 3500 ? 2 : stalledMs >= 1500 ? 1 : 0;
        if (step <= st.stage) continue;
        st.stage = step;
        onStalled?.({ producerId, clientId: meta?.clientId, stalledMs, stage: step });
        console.warn(`[sfu] rx stall ${Math.round(stalledMs)}ms client=${String(meta?.clientId || '').slice(0, 8)} stage=${step}`);
        try {
          if (step === 1) {
            await this.requestKeyFrame(consumer.id);
          } else if (step === 2) {
            await this.request('sfu-pause-consumer', { consumerId: consumer.id }).catch(() => {});
            await this.request('sfu-resume-consumer', { consumerId: consumer.id }).catch(() => {});
            await this.requestKeyFrame(consumer.id);
          } else if (step === 3) {
            await this._reconsume(producerId);
            this._rxState.delete(consumer.id);
          } else if (step === 4) {
            if (now - this._rxLastIceRestart > 15000 && this.recvTransport && !this.recvTransport.closed) {
              this._rxLastIceRestart = now;
              await this.restartIce(this.recvTransport);
            }
          }
        } catch (err) {
          console.warn('[sfu] rx recover step failed', step, err?.message || err);
        }
      }
      for (const id of [...this._rxState.keys()]) {
        if (!alive.has(id)) this._rxState.delete(id);
      }
    } finally {
      this._rxBusy = false;
    }
  }

  /** consumer 를 조용히 교체 (onProducerClosed 는 호출하지 않음 → 상위 UI 는 새 트랙으로만 갱신) */
  async _reconsume(producerId) {
    const consumer = this.consumers.get(producerId);
    const meta = this.consumerMeta.get(producerId);
    if (!consumer || !meta || this._closed) return null;
    try { this.remoteStream.removeTrack(consumer.track); } catch { /* ignore */ }
    try { consumer.close(); } catch { /* ignore */ }
    this.consumers.delete(producerId);
    this.consumerMeta.delete(producerId);
    try { await this.request('sfu-close-consumer', { consumerId: consumer.id }); } catch { /* ignore */ }
    return await this.consumeProducer({
      producerId,
      clientId: meta.clientId,
      role: meta.role,
      kind: meta.kind,
      appData: meta.appData,
    });
  }

  async stopPublishing({ source } = {}) {
    for (const [key, producer] of [...this.producers.entries()]) {
      if (source && !key.startsWith(`${source}:`)) continue;
      const id = producer.id;
      const ownedTrack = producer.track;
      try { producer.close(); } catch { /* ignore */ }
      // 명시적 송출 중지는 예전과 동일하게 트랙도 정리한다(마이크 파이프라인 출력 트랙 제외)
      if (ownedTrack && !ownedTrack._ymKeepAlive) { try { ownedTrack.stop(); } catch { /* ignore */ } }
      this.producers.delete(key);
      try { await this.request('sfu-close-producer', { producerId: id }); } catch { /* ignore */ }
    }
  }

  async consumeProducer(info) {
    const run = async () => {
      if (!info?.producerId) return null;
      if (this.consumers.has(info.producerId)) {
        const existing = this.consumers.get(info.producerId);
        if (existing && !existing.closed && existing.paused) {
          try {
            await this.request('sfu-resume-consumer', { consumerId: existing.id });
            await existing.resume();
          } catch { /* ignore */ }
        }
        return existing || null;
      }
      if (info.clientId && info.clientId === this.clientId) return null;
      if (this.consumeFilter && !this.consumeFilter(info)) return null;
      await this.ensureRecvTransport();
      const res = await this.request('sfu-consume', {
        transportId: this.recvTransport.id,
        producerId: info.producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      });
      const consumer = await this.recvTransport.consume({
        id: res.id,
        producerId: res.producerId,
        kind: res.kind,
        rtpParameters: res.rtpParameters,
      });
      this.consumers.set(info.producerId, consumer);
      this.consumerMeta.set(info.producerId, {
        ...info,
        kind: res.kind,
        appData: { ...(info.appData || {}), ...(res.appData || {}) },
      });
      try {
        const receiver = consumer.rtpReceiver;
        if (receiver) {
          // 모바일/무선 환경에서 0은 패킷 지터 시 버퍼 고갈로 인한 멈춤 후 고속 재생(fast-forward)의 치명적 원인이 됨
          // 100ms(0.1초)의 안정적인 적응형 재생 버퍼를 지정하여 프레임 밀림 및 고속 재생 완벽 제거
          // 영상 150ms(프레임 드랍 없이 부드럽게) / 오디오 60ms(대화 지연 최소)
          const isVideo = (res.kind || info?.kind) === 'video';
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = isVideo ? 0.15 : 0.06;
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = isVideo ? 150 : 60;
        }
      } catch { /* ignore */ }
      this.remoteStream.addTrack(consumer.track);
      // 서버 및 로컬 consumer 즉시 활성화
      this.request('sfu-resume-consumer', { consumerId: consumer.id }).catch(() => {});
      try { await consumer.resume(); } catch { /* ignore */ }

      // 모든 비디오 수신 직후 키프레임 요청 — 화면(display) 및 카메라 첫 프레임 공백/무한 대기 방지
      if (res.kind === 'video') {
        try { await this.requestKeyFrame(consumer.id); } catch { /* ignore */ }
      }

      // 수신 트랜스포트 연결 대기 (블로킹하지 않고 백그라운드에서 확인하여 오디오 연결 지연/체인 중단 방지)
      if (this.recvTransport?.connectionState !== 'connected') {
        this.waitTransportConnected(this.recvTransport, '수신', 8000).then(() => {
          if (res.kind === 'video' && !consumer.closed) {
            this.requestKeyFrame(consumer.id).catch(() => {});
          }
        }).catch((err) => {
          console.warn('[sfu] recv transport wait:', err?.message || err);
        });
      }

      if (res.kind === 'video') {
        setTimeout(() => {
          if (!consumer.closed) {
            this.requestKeyFrame(consumer.id).catch(() => {});
          }
        }, 600);
      }

      const meta = this.consumerMeta.get(info.producerId);
      try { this.onConsumed?.(meta, consumer); } catch (e) { console.warn('[sfu] onConsumed err', e); }
      try { this.onRemoteStream?.(this.remoteStream); } catch (e) { console.warn('[sfu] onRemoteStream err', e); }
      return consumer;
    };

    const prev = this._consumeChain;
    let release;
    this._consumeChain = new Promise((r) => { release = r; });
    try {
      await prev.catch(() => {});
      return await run();
    } finally {
      release();
    }
  }

  async resumeAllConsumers() {
    for (const consumer of this.consumers.values()) {
      if (!consumer || consumer.closed || !consumer.paused) continue;
      try {
        await this.request('sfu-resume-consumer', { consumerId: consumer.id });
        await consumer.resume();
      } catch { /* ignore */ }
    }
  }

  async pauseConsumer(consumerId) {
    if (!consumerId || this._closed) return;
    for (const consumer of this.consumers.values()) {
      if (!consumer || consumer.closed || consumer.id !== consumerId) continue;
      if (consumer.paused) return;
      try {
        await consumer.pause();
        await this.request('sfu-pause-consumer', { consumerId: consumer.id });
      } catch { /* ignore */ }
      return;
    }
  }

  async resumeConsumer(consumerId) {
    if (!consumerId || this._closed) return;
    for (const consumer of this.consumers.values()) {
      if (!consumer || consumer.closed || consumer.id !== consumerId) continue;
      try {
        await this.request('sfu-resume-consumer', { consumerId: consumer.id });
        await consumer.resume();
      } catch { /* ignore */ }
      return;
    }
  }

  async requestKeyFrame(producerIdOrConsumerId) {
    if (this._closed || !this.socket?.connected) return;
    if (!producerIdOrConsumerId) return; // 전체 PLI 금지 — 대상 consumer 필수
    try {
      let targetConsumerId = producerIdOrConsumerId;
      if (this.consumers.has(producerIdOrConsumerId)) {
        targetConsumerId = this.consumers.get(producerIdOrConsumerId)?.id;
      }
      if (!targetConsumerId) return;
      await this.request('sfu-request-keyframe', { consumerId: targetConsumerId });
    } catch { /* ignore */ }
  }

  /** 원격 clientId(+선택 source)에 해당하는 video consumerId */
  findConsumerIdForClient(clientId, sourceHint = null) {
    if (!clientId) return null;
    for (const [producerId, consumer] of this.consumers.entries()) {
      if (!consumer || consumer.closed || consumer.kind !== 'video') continue;
      const meta = this.consumerMeta.get(producerId);
      if (!meta || meta.clientId !== clientId) continue;
      const source = meta.appData?.source || '';
      if (sourceHint && source !== sourceHint) continue;
      if (!sourceHint && source && source !== 'viewer-camera' && source !== 'camera') continue;
      return consumer.id;
    }
    return null;
  }

  async consumeExistingProducers() {
    const list = this._pendingProducers?.length
      ? this._pendingProducers
      : (await this.request('sfu-get-producers')).producers || [];
    this._pendingProducers = [];
    // 영상 먼저 — 오디오만 붙고 영상 대기하다 타임아웃/레이스 나는 것 방지
    const ordered = [...list].sort((a, b) => {
      const av = a.kind === 'video' ? 0 : 1;
      const bv = b.kind === 'video' ? 0 : 1;
      return av - bv;
    });
    for (const p of ordered) {
      try { await this.consumeProducer(p); } catch (err) {
        console.warn('[sfu] consume failed', p.producerId, err);
      }
    }
  }

  async _onNewProducer(msg) {
    if (this._closed) return;
    if (!msg?.producerId || msg.clientId === this.clientId) return;
    try {
      await this.consumeProducer(msg);
    } catch (err) {
      console.warn('[sfu] new producer', err);
    }
  }

  _onProducerClosed(msg) {
    const producerId = msg?.producerId;
    if (!producerId) return;
    const consumer = this.consumers.get(producerId);
    const meta = this.consumerMeta.get(producerId);
    const kind = consumer?.kind || meta?.kind || msg?.kind || null;
    const source = meta?.appData?.source || msg?.source || null;
    if (consumer) {
      try {
        this.remoteStream.removeTrack(consumer.track);
        consumer.close();
      } catch { /* ignore */ }
      this.consumers.delete(producerId);
      this.consumerMeta.delete(producerId);
    }
    this.onRemoteStream?.(this.remoteStream);
    this.onProducerClosed?.({ ...msg, kind, source });
  }

  startNetworkStatsMonitor(callback, intervalMs = 2500) {
    if (this._netMonitorTimer) return;
    let lastPacketsLost = 0;
    let lastPacketsReceived = 0;

    this._netMonitorTimer = setInterval(async () => {
      if (this._closed || !this.recvTransport || this.recvTransport.closed) return;
      try {
        const stats = await this.recvTransport.getStats();
        let rtt = null;
        let packetsLostDelta = 0;
        let packetsRecvDelta = 0;

        const list = stats instanceof Map ? [...stats.values()] : Array.isArray(stats) ? stats : [];
        list.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (typeof report.currentRoundTripTime === 'number') {
              rtt = Math.round(report.currentRoundTripTime * 1000);
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const curLost = report.packetsLost || 0;
            const curRecv = report.packetsReceived || 0;
            if (lastPacketsReceived > 0) {
              packetsLostDelta = Math.max(0, curLost - lastPacketsLost);
              packetsRecvDelta = Math.max(0, curRecv - lastPacketsReceived);
            }
            lastPacketsLost = curLost;
            lastPacketsReceived = curRecv;
          }
        });

        const totalPackets = packetsLostDelta + packetsRecvDelta;
        const lossRate = totalPackets > 0 ? (packetsLostDelta / totalPackets) * 100 : 0;
        const pingMs = rtt !== null ? rtt : (lastPacketsReceived > 0 ? 35 : 25);

        let quality = 'good';
        if (pingMs > 280 || lossRate > 6) {
          quality = 'poor';
        } else if (pingMs > 120 || lossRate > 2) {
          quality = 'fair';
        }

        const data = {
          pingMs,
          lossRate: Math.round(lossRate * 10) / 10,
          quality,
        };
        this.onNetworkQuality?.(data);
        callback?.(data);
      } catch { /* ignore */ }
    }, intervalMs);
  }

  stopNetworkStatsMonitor() {
    if (this._netMonitorTimer) {
      clearInterval(this._netMonitorTimer);
      this._netMonitorTimer = null;
    }
  }

  dispose() {
    this._closed = true;
    this.stopNetworkStatsMonitor();
    this.stopSenderMonitor();
    this.stopReceiverMonitor();
    this.socket.off('sfu-new-producer', this._boundNewProducer);
    this.socket.off('sfu-producer-closed', this._boundProducerClosed);
    for (const producer of this.producers.values()) {
      try { producer.close(); } catch { /* ignore */ }
    }
    for (const consumer of this.consumers.values()) {
      try { consumer.close(); } catch { /* ignore */ }
    }
    try { this.sendTransportVideo?.close(); } catch { /* ignore */ }
    try { this.sendTransportAudio?.close(); } catch { /* ignore */ }
    try { this.recvTransport?.close(); } catch { /* ignore */ }
    this.producers.clear();
    this.consumers.clear();
    this.remoteStream.getTracks().forEach((t) => {
      try { this.remoteStream.removeTrack(t); } catch { /* ignore */ }
    });
  }
}
