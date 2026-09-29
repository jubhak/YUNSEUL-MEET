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
        }, 1200);
      } else if (state === 'failed') {
        console.warn(`[sfu-client] ${label} failed, attempting immediate ICE restart...`);
        const ok = await this.restartIce(transport);
        if (!ok) {
          try { transport.close(); } catch { /* ignore */ }
          try { this.onTransportFailed?.(transport, label); } catch { /* ignore */ }
        }
      }
    });
  }

  async _createSendTransport() {
    const info = await this.request('sfu-create-transport', { direction: 'send' });
    const transport = this.device.createSendTransport(info);
    this._attachTransportHealth(transport, 'send-transport');
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
    if (kind === 'audio') {
      if (this.sendTransportAudio && !this.sendTransportAudio.closed) {
        return this.sendTransportAudio;
      }
      this.sendTransportAudio = await this._createSendTransport();
      return this.sendTransportAudio;
    }
    if (this.sendTransportVideo && !this.sendTransportVideo.closed) {
      return this.sendTransportVideo;
    }
    this.sendTransportVideo = await this._createSendTransport();
    return this.sendTransportVideo;
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
            if (w <= 320 || fps <= 15) {
              maxBitrate = 120_000;
              maxFramerate = 18;
            } else if (w <= 480 || fps <= 22) {
              maxBitrate = 180_000;
              maxFramerate = 22;
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
            // 화면 공유(Display Share / PPT / 문서): 텍스트 가독성을 위해 해상도 보존('detail') 설정
            try { track.contentHint = 'detail'; } catch { /* ignore */ }
            produceOpts.codecOptions = {
              videoGoogleStartBitrate: 1500,
            };
          }
        } else if (track.kind === 'audio') {
          try { track.contentHint = (source === 'mic' || source === 'viewer-mic') ? 'speech' : 'music'; } catch { /* ignore */ }
          produceOpts.codecOptions = {
            opusStereo: source !== 'mic' && source !== 'viewer-mic',
            opusFec: true,
            opusDtx: false,
            opusMaxAverageBitrate: (source === 'mic' || source === 'viewer-mic') ? 64000 : 128000,
          };
        }
        const producer = await transport.produce(produceOpts);
        if (track.kind === 'video' && producer.rtpSender) {
          try {
            const params = producer.rtpSender.getParameters();
            if (params) {
              const isCam = source === 'camera' || source === 'viewer-camera';
              // 화면공유는 maintain-resolution, 카메라는 maintain-framerate
              params.degradationPreference = isCam ? 'maintain-framerate' : 'maintain-resolution';
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

  async stopPublishing({ source } = {}) {
    for (const [key, producer] of [...this.producers.entries()]) {
      if (source && !key.startsWith(`${source}:`)) continue;
      const id = producer.id;
      try { producer.close(); } catch { /* ignore */ }
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
      await this.request('sfu-resume-consumer', { consumerId: consumer.id });
      // 모든 비디오 수신 직후 키프레임 요청 — 화면(display) 및 카메라 첫 프레임 공백/무한 대기 방지
      if (res.kind === 'video') {
        try { await this.requestKeyFrame(consumer.id); } catch { /* ignore */ }
      }
      try {
        await this.waitTransportConnected(this.recvTransport, '수신', 15000);
      } catch (err) {
        console.warn('[sfu] recv ICE', err);
        throw err;
      }
      // 수신 트랜스포트 연결 확립 후 즉시 핵심 키프레임 보장 (호스트 화면 정지/지연 시 즉시 첫 프레임 수신)
      if (res.kind === 'video') {
        try { await this.requestKeyFrame(consumer.id); } catch { /* ignore */ }
        setTimeout(() => {
          if (!consumer.closed) {
            this.requestKeyFrame(consumer.id).catch(() => {});
          }
        }, 600);
      }
      if (consumer.paused) {
        try {
          await this.request('sfu-resume-consumer', { consumerId: consumer.id });
          await consumer.resume();
        } catch { /* ignore */ }
      }
      const meta = this.consumerMeta.get(info.producerId);
      this.onConsumed?.(meta, consumer);
      this.onRemoteStream?.(this.remoteStream);
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
    if (consumer) {
      try {
        this.remoteStream.removeTrack(consumer.track);
        consumer.close();
      } catch { /* ignore */ }
      this.consumers.delete(producerId);
      this.consumerMeta.delete(producerId);
    }
    this.onRemoteStream?.(this.remoteStream);
    this.onProducerClosed?.(msg);
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
