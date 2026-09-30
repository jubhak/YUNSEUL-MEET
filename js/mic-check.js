/**
 * 마이크 확인 대화상자 + 장치 유틸
 *
 *  - "말했을 때 실제로 소리(레벨)가 잡히는 장치"만 마이크로 인정한다.
 *    (이어폰 출력 전용 장치/음소거된 장치/가짜 장치는 레벨이 0이므로 통과 못 함)
 *  - 사용자는 목록에서 사용할 장치(예: 이어폰 마이크)를 직접 고를 수 있다.
 *  - 검증 결과는 sessionStorage 에 저장되어 같은 탭 안에서 페이지가 바뀌어도(랜딩→회의실) 재사용된다.
 */
import { VoicePipeline, MIC_AUDIO_CONSTRAINTS } from './webrtc/mic-pipeline.js?v=20260930a';

const KEY_DEVICE = 'ym_mic_device_id';
const KEY_VERIFIED = 'ym_mic_verified';
const VERIFY_TTL_MS = 30 * 60 * 1000;

export function getSavedMicDeviceId() {
  try { return localStorage.getItem(KEY_DEVICE) || sessionStorage.getItem(KEY_DEVICE) || ''; } catch { return ''; }
}

export function saveMicDeviceId(id) {
  try {
    if (id) { localStorage.setItem(KEY_DEVICE, id); sessionStorage.setItem(KEY_DEVICE, id); }
  } catch { /* ignore */ }
}

export function markMicVerified(deviceId) {
  try { sessionStorage.setItem(KEY_VERIFIED, JSON.stringify({ deviceId: deviceId || '', at: Date.now() })); } catch { /* ignore */ }
}

export function clearMicVerified() {
  try { sessionStorage.removeItem(KEY_VERIFIED); } catch { /* ignore */ }
}

export function isMicRecentlyVerified(deviceId) {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY_VERIFIED) || 'null');
    if (!v || Date.now() - v.at > VERIFY_TTL_MS) return false;
    return !deviceId || !v.deviceId || v.deviceId === deviceId;
  } catch { return false; }
}

export async function listMicDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  return inputs.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `마이크 ${i + 1}`,
    isDefault: d.deviceId === 'default',
  }));
}

/** 장치 열기. 저장된 장치가 없어졌으면(OverconstrainedError) 기본 장치로 대체 */
export async function openMicStream(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new Error('이 브라우저는 마이크를 지원하지 않습니다. (HTTPS 접속이 필요합니다)');
    e.name = 'NotSupportedError';
    throw e;
  }
  const base = { ...MIC_AUDIO_CONSTRAINTS };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } }, video: false });
    } catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
    }
  }
  return await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
}

export function describeMicError(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError') return '마이크 권한이 차단되어 있습니다. 주소창 왼쪽 자물쇠 아이콘에서 마이크를 "허용"으로 바꾼 뒤 다시 시도해 주세요.';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return '사용 가능한 마이크를 찾을 수 없습니다. 마이크(또는 이어폰 마이크)를 연결한 뒤 "다시 검색"을 눌러 주세요.';
  if (n === 'NotReadableError' || n === 'TrackStartError') return '다른 프로그램이 마이크를 사용 중이거나 장치를 열 수 없습니다. 다른 장치를 선택해 주세요.';
  if (n === 'NotSupportedError') return err.message;
  return `마이크를 열 수 없습니다: ${err?.message || n || '알 수 없는 오류'}`;
}

const VERIFY_SPEECH_MS = 900;
const VERIFY_MIN_PEAK = 0.28;

/**
 * @param {{
 *   required?: boolean,      // true: 소리가 확인되어야만 '확인' 가능, 취소 불가(나가기만 가능)
 *   title?: string,
 *   subtitle?: string,
 *   initialDeviceId?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 * }} opts
 * @returns {Promise<{ok:true, deviceId:string, verified:boolean}|{ok:false}>}
 */
export function runMicCheckDialog(opts = {}) {
  const required = !!opts.required;
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'ym-mc-backdrop';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <div class="ym-mc-card">
        <h3 class="ym-mc-title"></h3>
        <p class="ym-mc-sub"></p>
        <label class="ym-mc-label">사용할 마이크</label>
        <div class="ym-mc-row">
          <select class="ym-mc-select"></select>
          <button type="button" class="ym-mc-btn ym-mc-refresh" title="장치 다시 검색">다시 검색</button>
        </div>
        <div class="ym-mc-meter"><div class="ym-mc-meter-fill"></div><div class="ym-mc-meter-mark"></div></div>
        <div class="ym-mc-status" aria-live="polite"></div>
        <div class="ym-mc-progress"><div class="ym-mc-progress-fill"></div></div>
        <div class="ym-mc-actions">
          <button type="button" class="ym-mc-btn ym-mc-cancel"></button>
          <button type="button" class="ym-mc-btn ym-mc-ok" disabled></button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const $ = (s) => root.querySelector(s);
    $('.ym-mc-title').textContent = opts.title || (required ? '마이크 확인 (필수)' : '마이크 설정');
    $('.ym-mc-sub').textContent = opts.subtitle || (required
      ? '이 방은 마이크 사용이 필수입니다. 마이크에 대고 "안녕하세요"라고 말씀해 주세요. 소리가 확인되어야 입장할 수 있습니다.'
      : '사용할 마이크를 선택하고, 말을 해서 소리가 잡히는지 확인하세요.');
    const select = $('.ym-mc-select');
    const fill = $('.ym-mc-meter-fill');
    const status = $('.ym-mc-status');
    const progFill = $('.ym-mc-progress-fill');
    const okBtn = $('.ym-mc-ok');
    const cancelBtn = $('.ym-mc-cancel');
    okBtn.textContent = opts.confirmLabel || (required ? '확인하고 입장' : '이 마이크 사용');
    cancelBtn.textContent = opts.cancelLabel || (required ? '나가기' : '취소');

    let stream = null;
    let pipeline = null;
    let disposed = false;
    let speechMs = 0;
    let peak = 0;
    let verified = false;
    let noSignalMs = 0;
    let lastTs = performance.now();
    let raf = 0;
    let startSeq = 0;

    const setStatus = (text, kind = '') => {
      status.textContent = text;
      status.className = `ym-mc-status ${kind}`;
    };

    const stopCurrent = () => {
      cancelAnimationFrame(raf);
      if (pipeline) { try { pipeline.close(); } catch { /* ignore */ } pipeline = null; }
      if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } }); stream = null; }
    };

    const finish = (result) => {
      if (disposed) return;
      disposed = true;
      stopCurrent();
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      root.remove();
      resolve(result);
    };

    const populate = async (preferId) => {
      let devices = [];
      try { devices = await listMicDevices(); } catch { /* ignore */ }
      select.innerHTML = '';
      if (!devices.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '(감지된 마이크 없음)';
        select.appendChild(o);
      }
      devices.forEach((d) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label;
        select.appendChild(o);
      });
      if (preferId && devices.some((d) => d.deviceId === preferId)) select.value = preferId;
      return devices;
    };

    const startTest = async () => {
      const seq = ++startSeq;
      stopCurrent();
      speechMs = 0; peak = 0; verified = false; noSignalMs = 0;
      okBtn.disabled = true;
      progFill.style.width = '0%';
      fill.style.width = '0%';
      setStatus('마이크를 여는 중…');
      try {
        stream = await openMicStream(select.value || '');
      } catch (err) {
        if (seq !== startSeq || disposed) return;
        setStatus(describeMicError(err), 'bad');
        return;
      }
      if (seq !== startSeq || disposed) { stream?.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getAudioTracks()[0];
      // 권한 승인 후에는 장치 라벨이 채워지므로 목록 갱신
      const cur = track?.getSettings?.().deviceId || select.value;
      await populate(cur);
      if (cur) select.value = cur;
      try {
        pipeline = await VoicePipeline.create({});
      } catch (err) {
        setStatus(`오디오 엔진을 시작할 수 없습니다: ${err?.message || err}`, 'bad');
        return;
      }
      if (seq !== startSeq || disposed) { pipeline?.close(); return; }
      pipeline.attachInput(track);
      track.addEventListener('ended', () => {
        if (seq !== startSeq || disposed) return;
        verified = false;
        okBtn.disabled = true;
        setStatus('마이크 연결이 끊어졌습니다. 다시 연결하거나 다른 장치를 선택해 주세요.', 'bad');
      }, { once: true });
      setStatus('말씀해 보세요… (예: "안녕하세요")');
      lastTs = performance.now();
      loop(seq);
    };

    const loop = (seq) => {
      if (seq !== startSeq || disposed || !pipeline) return;
      const now = performance.now();
      const dt = now - lastTs;
      lastTs = now;
      const t = pipeline.telemetry;
      // 미터는 사용자가 "소리가 들어오는지" 바로 보도록 입력 기준(게이트 전)으로 표시
      const inRms = pipeline._rms(pipeline.inAnalyser, pipeline._inBuf);
      const db = 20 * Math.log10(inRms + 1e-6);
      const lvl = Math.max(0, Math.min(1, (db + 55) / 40));
      fill.style.width = `${Math.round(lvl * 100)}%`;
      if (lvl > peak) peak = lvl;
      if (pipeline.ctxState !== 'running') {
        setStatus('화면을 한 번 클릭하면 마이크 테스트가 시작됩니다.', 'warn');
      } else if (!verified) {
        if (t.speech || (lvl > 0.5 && inRms > 0.03)) {
          speechMs += dt;
          noSignalMs = 0;
        } else if (lvl < 0.08) {
          noSignalMs += dt;
        } else {
          noSignalMs = Math.max(0, noSignalMs - dt);
        }
        progFill.style.width = `${Math.min(100, Math.round((speechMs / VERIFY_SPEECH_MS) * 100))}%`;
        if (speechMs >= VERIFY_SPEECH_MS && peak >= VERIFY_MIN_PEAK) {
          verified = true;
          okBtn.disabled = false;
          progFill.style.width = '100%';
          setStatus('✅ 마이크가 정상적으로 작동합니다.', 'good');
        } else if (noSignalMs > 6000) {
          setStatus('선택한 장치에서 소리가 들어오지 않습니다. 말을 해도 막대가 움직이지 않으면 마이크가 아니거나 음소거 상태입니다. 다른 장치(예: 이어폰/헤드셋 마이크)를 선택해 주세요.', 'warn');
        } else if (speechMs > 0) {
          setStatus('좋아요, 계속 말씀해 주세요…');
        }
        if (!required && !verified) okBtn.disabled = false; // 선택 방에서는 미검증이어도 저장 허용
      }
      raf = requestAnimationFrame(() => loop(seq));
    };

    const onDeviceChange = async () => {
      if (disposed) return;
      const prev = select.value;
      await populate(prev);
      if (prev && select.value !== prev) startTest();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

    select.addEventListener('change', () => startTest());
    $('.ym-mc-refresh').addEventListener('click', async () => {
      await populate(select.value);
      startTest();
    });
    okBtn.addEventListener('click', () => {
      const deviceId = select.value || '';
      if (deviceId) saveMicDeviceId(deviceId);
      if (verified) markMicVerified(deviceId);
      finish({ ok: true, deviceId, verified });
    });
    cancelBtn.addEventListener('click', () => finish({ ok: false }));
    if (!required) {
      root.addEventListener('click', (e) => { if (e.target === root) finish({ ok: false }); });
    }

    (async () => {
      await populate(opts.initialDeviceId || getSavedMicDeviceId());
      startTest();
    })();
  });
}
