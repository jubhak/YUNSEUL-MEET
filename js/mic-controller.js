/**
 * 마이크 컨트롤러 (호스트/참가자 공용)
 *
 *  상태 모델 (거짓 표시 금지)
 *    - state 'on'  : 장치가 실제로 열려 있고 파이프라인→SFU producer 로 송출 중
 *    - state 'off' : 꺼짐(장치 해제됨)
 *    - state 'none': 장치 없음/열기 실패
 *    - ready       : "말했을 때 실제 소리가 잡히는" 검증을 통과한 마이크가 있음
 *
 *  방 정책
 *    - requireMic=true : 입장 전 검증 필수, 자동 ON, 끄기 시도 시 "마이크 사용 필수" 안내 후 ON 유지
 *    - requireMic=false: 모두 꺼진 상태로 시작(아이콘 비활성). 아이콘 클릭 시 켜지고 모두에게 들림
 *
 *  마이크 ON/OFF 는 "파이프라인 입력을 붙였다 떼는 것"뿐이다. SFU producer/트랜스포트/영상은 건드리지 않는다.
 */
import { VoicePipeline } from './webrtc/mic-pipeline.js?v=20260930a';
import {
  openMicStream, runMicCheckDialog, getSavedMicDeviceId, saveMicDeviceId,
  isMicRecentlyVerified, markMicVerified, clearMicVerified, describeMicError,
} from './mic-check.js?v=20260930a';
import { speakingIndicator } from './speaking-indicator.js?v=20261002b';

export class MicController {
  /**
   * @param {{
   *   role: 'host'|'viewer',
   *   clientId: string,
   *   source: 'mic'|'viewer-mic',
   *   getSfu: () => Promise<import('./webrtc/sfu-client.js').SfuClient>,
   *   socket: any,
   *   requireMic: boolean,
   *   onChange?: (info: {state:string, ready:boolean, enabled:boolean}) => void,
   *   onForced?: () => void,
   *   onNotice?: (msg: string, kind?: string) => void,
   *   onLeave?: () => void,
   *   onTrack?: (track: MediaStreamTrack|null) => void,
   * }} o
   */
  constructor(o) {
    this.o = o;
    this.role = o.role;
    this.source = o.source;
    this.requireMic = !!o.requireMic;
    this.pipeline = null;
    this.raw = null;
    this.deviceId = getSavedMicDeviceId();
    this.state = 'off';
    this.ready = false;
    this._busy = null;
    this._published = false;
    this._gateOpen = false;
  }

  get enabled() { return this.state === 'on'; }

  setRequireMic(v) {
    this.requireMic = !!v;
    if (this.requireMic && !this.enabled) this.enable().catch(() => {});
  }

  _speakIds() {
    const ids = Array.isArray(this.o.speakIds) && this.o.speakIds.length ? this.o.speakIds : [this.o.clientId];
    return ids.filter(Boolean);
  }

  _notice(msg, kind) { try { this.o.onNotice?.(msg, kind); } catch { /* ignore */ } }

  _emit() {
    const info = { state: this.state, ready: this.ready, enabled: this.enabled };
    try { this.o.socket?.emit?.('mic-status', { state: this.state, ready: this.ready }); } catch { /* ignore */ }
    try { this.o.onChange?.(info); } catch { /* ignore */ }
  }

  async _ensurePipeline() {
    if (this.pipeline && !this.pipeline._closed) return this.pipeline;
    this.pipeline = await VoicePipeline.create({});
    if (this.pipeline.outTrack) this.pipeline.outTrack._ymKeepAlive = true;
    this.pipeline.onDegraded = (reason) => {
      this._notice('음성 처리 오류를 감지해 안전 모드로 전환했습니다.', 'warn');
      try { this.o.socket?.emit?.('client-diag', { kind: 'mic', event: 'pipeline-bypass', detail: reason }); } catch { /* ignore */ }
    };
    for (const sid of this._speakIds()) speakingIndicator.trackLocal(sid, this.pipeline);
    return this.pipeline;
  }

  /** 세션 내내 유지되는 하나의 producer 를 (필요할 때) 만든다 */
  async _ensureProducer() {
    const rawTrack = this.raw?.getAudioTracks?.()[0];
    if (!rawTrack || rawTrack.readyState !== 'live') {
      throw new Error('마이크 입력 트랙이 없습니다.');
    }
    rawTrack.enabled = true;
    try { rawTrack.contentHint = 'speech'; } catch { /* ignore */ }

    if (this._published) {
      const sfu = await this.o.getSfu();
      const p = sfu?.producers?.get(`${this.source}:audio`);
      if (p && !p.closed) {
        try {
          if (p.track !== rawTrack) await p.replaceTrack({ track: rawTrack });
          return true;
        } catch { /* ignore and republish */ }
      }
      this._published = false;
    }
    // 로컬 VU 미터/발화 인디케이터용 파이프라인 준비
    await this._ensurePipeline().catch(() => {});
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const sfu = await this.o.getSfu();
        await sfu.publishStream(new MediaStream([rawTrack]), {
          source: this.source,
          trackKind: 'mic',
        });
        this._published = true;
        return true;
      } catch (err) {
        lastErr = err;
        console.warn(`[MicController] produce 실패(${attempt + 1}/3)`, err);
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('마이크 송출 실패');
  }

  /**
   * 입장/참여 게이트: 필수 방에서 검증된 마이크가 없으면 대화상자로 반드시 검증.
   * 검증 실패 + 나가기 → onLeave.
   */
  async ensureGate() {
    if (!this.requireMic) return true;
    if (this._gateOpen) return this._gateOpen;
    this._gateOpen = (async () => {
      try {
        while (true) {
          // 1) 최근에 검증되었고 장치가 실제로 열리면 통과 (랜딩에서 검증 → 회의실 진입)
          if (isMicRecentlyVerified(this.deviceId)) {
            try {
              await this._openInput(this.deviceId);
              this.ready = true;
              return true;
            } catch { clearMicVerified(); }
          }
          const r = await runMicCheckDialog({ required: true, initialDeviceId: this.deviceId });
          if (!r.ok) { this.o.onLeave?.(); return false; }
          if (r.verified) {
            this.deviceId = r.deviceId || this.deviceId;
            try {
              await this._openInput(this.deviceId);
              this.ready = true;
              return true;
            } catch (err) {
              this._notice(describeMicError(err), 'error');
            }
          }
        }
      } finally {
        this._gateOpen = false;
      }
    })();
    const ok = await this._gateOpen;
    return ok;
  }

  /** 장치를 열어 파이프라인 입력에 연결 (producer 는 그대로) */
  async _openInput(deviceId) {
    const pipeline = await this._ensurePipeline();
    const stream = await openMicStream(deviceId || '');
    const track = stream.getAudioTracks()[0];
    if (!track) { stream.getTracks().forEach((t) => t.stop()); throw new Error('오디오 트랙 없음'); }
    // 이전 입력 정리
    this._releaseRaw();
    this.raw = stream;
    pipeline.attachInput(track);
    const settingsId = track.getSettings?.().deviceId;
    if (settingsId) { this.deviceId = settingsId; saveMicDeviceId(settingsId); }
    track.addEventListener('ended', () => this._onTrackEnded(track), { once: true });
    track.addEventListener('mute', () => {
      // OS/장치 수준 음소거: 곧 unmute 되면 무시, 계속되면 안내
      clearTimeout(this._muteTimer);
      this._muteTimer = setTimeout(() => {
        if (track.muted && this.enabled) this._notice('마이크가 시스템에서 음소거된 것 같습니다. 장치/OS 설정을 확인해 주세요.', 'warn');
      }, 2500);
    });
    try { this.o.onTrack?.(track); } catch { /* ignore */ }
    return track;
  }

  _releaseRaw() {
    if (this.raw) {
      this.raw.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.raw = null;
    }
  }

  async _onTrackEnded(track) {
    if (!this.raw || this.raw.getAudioTracks()[0] !== track) return; // 이미 교체됨
    this.pipeline?.detachInput();
    this._releaseRaw();
    this.ready = false;
    this.state = 'none';
    this._emit();
    try { this.o.onTrack?.(null); } catch { /* ignore */ }
    if (this.requireMic) {
      this._notice('마이크 연결이 끊어졌습니다. 마이크를 다시 확인해 주세요.', 'error');
      const wasEnabled = true;
      const ok = await this.ensureGate();
      if (ok && wasEnabled) await this.enable();
    } else {
      this.state = 'off';
      this._emit();
      this._notice('마이크 연결이 끊어져 꺼졌습니다.', 'warn');
    }
  }

  /** 아이콘 클릭(켜기) */
  async enable() {
    if (this._busy) return this._busy;
    this._busy = (async () => {
      try {
        if (this.requireMic && !this.ready) {
          const ok = await this.ensureGate();
          if (!ok) return false;
        }
        if (!this.raw) {
          try {
            await this._openInput(this.deviceId);
          } catch (err) {
            this.state = 'none';
            this.ready = false;
            this._emit();
            this._notice(describeMicError(err), 'error');
            if (!this.requireMic) return false;
            // 필수 방: 다시 검증 대화상자로 장치를 고르게 한다
            const ok = await this.ensureGate();
            if (!ok) return false;
          }
        }
        if (!this.requireMic && !this.ready) this.ready = true; // 선택 방: 열림 자체를 ready 로 취급
        await this._ensureProducer();
        this.state = 'on';
        this._emit();
        return true;
      } catch (err) {
        console.warn('[MicController] enable 실패', err);
        this.state = 'none';
        this._emit();
        this._notice('마이크를 켤 수 없습니다. 장치를 확인해 주세요.', 'error');
        return false;
      } finally {
        this._busy = null;
      }
    })();
    return this._busy;
  }

  /** 아이콘 클릭(끄기) — 필수 방이면 거부 */
  async disable() {
    if (this.requireMic) {
      try { this.o.onForced?.(); } catch { /* ignore */ }
      return false;
    }
    const track = this.raw?.getAudioTracks?.()[0];
    if (track) track.enabled = false;
    this.pipeline?.detachInput();
    this._releaseRaw();
    this.state = 'off';
    this._published = false;
    try { this.o.onTrack?.(null); } catch { /* ignore */ }
    this._emit();
    return true;
  }

  async toggle() {
    return this.enabled ? this.disable() : this.enable();
  }

  /** 마이크 장치 선택/테스트 대화상자 (설정 버튼) */
  async openSettings() {
    const r = await runMicCheckDialog({
      required: false,
      title: '마이크 장치 선택',
      initialDeviceId: this.deviceId,
      confirmLabel: '이 마이크로 변경',
    });
    if (!r.ok) return false;
    const changed = r.deviceId && r.deviceId !== this.deviceId;
    this.deviceId = r.deviceId || this.deviceId;
    if (r.verified) this.ready = true;
    if (this.enabled && changed) {
      try {
        await this._openInput(this.deviceId);
        this._emit();
      } catch (err) {
        this._notice(describeMicError(err), 'error');
      }
    } else if (!this.enabled && this.requireMic) {
      await this.enable();
    }
    return true;
  }

  dispose() {
    try { this.pipeline?.detachInput(); } catch { /* ignore */ }
    this._releaseRaw();
    for (const sid of this._speakIds()) speakingIndicator.untrack(sid);
    try { this.pipeline?.close(); } catch { /* ignore */ }
    this.pipeline = null;
    this._published = false;
    this.state = 'off';
  }
}
