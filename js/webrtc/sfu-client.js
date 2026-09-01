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

  async _createSendTransport() {
    const info = await this.request('sfu-create-transport', { direction: 'send' });
    const transport = this.device.createSendTransport(info);
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
      }).then((res) => callback({ id: res.id })).catch(errback);
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
          try { track.contentHint = 'detail'; } catch { /* ignore */ }
          // encodings/maxFramerate 강제 시 일부 Chrome 화면공유 produce가 실패/검은화면 → 최소 옵션만
          produceOpts.codecOptions = {
            videoGoogleStartBitrate: 1000,
          };
        } else if (track.kind === 'audio') {
          try { track.contentHint = source === 'mic' ? 'speech' : 'music'; } catch { /* ignore */ }
          produceOpts.codecOptions = {
            opusStereo: source !== 'mic',
            opusFec: true,
            opusDtx: source === 'mic',
            opusMaxAverageBitrate: source === 'mic' ? 64000 : 128000,
          };
        }
        const producer = await transport.produce(produceOpts);
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

  getProducerByKind(kind) {
    for (const producer of this.producers.values()) {
      if (!producer.closed && producer.kind === kind) return producer;
    }
    return null;
  }

  async replaceVideoTrack(track) {
    const producer = this.getProducerByKind('video');
    if (!producer) return false;
    await producer.replaceTrack({ track: track || null });
    return true;
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
      try {
        const receiver = consumer.rtpReceiver;
        if (receiver) {
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
        }
      } catch { /* ignore */ }
      this.remoteStream.addTrack(consumer.track);
      await this.request('sfu-resume-consumer', { consumerId: consumer.id });
      try { await consumer.resume(); } catch { /* ignore */ }
      try {
        await this.waitTransportConnected(this.recvTransport, '수신', 15000);
      } catch (err) {
        console.warn('[sfu] recv ICE', err);
        throw err;
      }
      if (consumer.paused) {
        try {
          await this.request('sfu-resume-consumer', { consumerId: consumer.id });
          await consumer.resume();
        } catch { /* ignore */ }
      }
      const meta = {
        ...info,
        kind: res.kind,
        appData: { ...(info.appData || {}), ...(res.appData || {}) },
      };
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
    }
    this.onRemoteStream?.(this.remoteStream);
    this.onProducerClosed?.(msg);
  }

  dispose() {
    this._closed = true;
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
