import { ICE_SERVERS } from './config.js';

/**
 * 단일 상대방에 대한 RTCPeerConnection 래퍼.
 * 이후 다자 화상회의에서도 peerId 단위로 재사용.
 */
export class PeerSession {
  constructor({
    peerId,
    iceServers = ICE_SERVERS,
    onIce,
    onTrack,
    onConnectionState,
  }) {
    this.peerId = peerId;
    this.pc = new RTCPeerConnection({ iceServers });
    this._makingOffer = false;
    this._pendingIce = [];
    this._remoteSet = false;

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) onIce?.(ev.candidate);
    };
    this.pc.ontrack = (ev) => onTrack?.(ev);
    this.pc.onconnectionstatechange = () => {
      onConnectionState?.(this.pc.connectionState);
    };
  }

  addTrack(track, stream) {
    const senders = this.pc.getSenders();
    if (senders.some((s) => s.track === track)) return;
    this.pc.addTrack(track, stream);
  }

  async createOffer() {
    this._makingOffer = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      return this._descPayload(this.pc.localDescription);
    } finally {
      this._makingOffer = false;
    }
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription(this._asDesc(sdp));
    this._remoteSet = true;
    await this._flushIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this._descPayload(this.pc.localDescription);
  }

  async acceptAnswer(sdp) {
    if (this.pc.currentRemoteDescription) return;
    await this.pc.setRemoteDescription(this._asDesc(sdp));
    this._remoteSet = true;
    await this._flushIce();
  }

  async addIce(candidate) {
    if (!candidate) return;
    if (!this._remoteSet && !this.pc.remoteDescription) {
      this._pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[PeerSession] ICE', this.peerId, err);
    }
  }

  async _flushIce() {
    const pending = this._pendingIce.splice(0);
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('[PeerSession] ICE flush', this.peerId, err);
      }
    }
  }

  _asDesc(sdp) {
    if (!sdp) throw new Error('empty sdp');
    if (typeof sdp === 'string') {
      return { type: 'offer', sdp };
    }
    return { type: sdp.type, sdp: sdp.sdp };
  }

  _descPayload(desc) {
    if (!desc) return null;
    return { type: desc.type, sdp: desc.sdp };
  }

  close() {
    try {
      this.pc.close();
    } catch { /* ignore */ }
  }
}
