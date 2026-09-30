/**
 * 원격 제어 클라이언트 (호스트 컨트롤러 + 참가자 승인 UI)
 *
 * 서버 이벤트 (server/remote-control.js)
 *   호스트 → rc-request {targetId} (ack)  /  rc-input {sessionId, events}  /  rc-stop {sessionId}
 *   참가자 → rc-respond {sessionId, accept} (ack: {downloadUrl})  /  rc-stop
 *   서버 → rc-request(참가자) · rc-approved · rc-denied · rc-active · rc-ended
 *
 * 상태: idle → requesting → approved(제어 프로그램 실행 대기) → active(제어권 획득)
 */
import { showToast } from './ui-toast.js?v=20260930a';

const END_REASON = {
  denied: '상대가 원격 제어를 거절했습니다.',
  timeout: '상대가 제어 프로그램을 실행하지 않아 요청이 만료되었습니다.',
  'host-stopped': '원격 제어를 종료했습니다.',
  'target-stopped': '상대가 원격 제어를 중지했습니다.',
  'share-ended': '화면 공유가 끝나 원격 제어가 종료되었습니다.',
  'agent-closed': '상대 PC의 제어 프로그램이 종료되어 원격 제어가 끝났습니다.',
  'agent-timeout': '상대 PC와의 연결이 끊겨 원격 제어가 종료되었습니다.',
  'peer-left': '상대 또는 호스트의 접속이 끊겨 원격 제어가 종료되었습니다.',
  replaced: '다른 원격 제어 요청으로 대체되었습니다.',
  expired: '원격 제어 세션이 만료되었습니다.',
  'room-ended': '방이 종료되었습니다.',
};

const $ = (id) => document.getElementById(id);

/* ==========================================================================
   호스트 측
   ========================================================================== */
export class RemoteControlHost {
  /**
   * @param {{ socket: any, getVideoEl: () => HTMLVideoElement|null }} o
   */
  constructor({ socket, getVideoEl }) {
    this.socket = socket;
    this.getVideoEl = getVideoEl;
    this.state = 'idle';
    this.sessionId = null;
    this.target = null; // { id, name }
    this.screen = null;
    this._queue = [];
    this._flushTimer = 0;
    this._lastMove = { x: 0, y: 0 };
    this._down = new Set();
    this._boundKey = (e) => this._onKey(e);

    this.btnRequest = $('btn-rc-request');
    this.btnRelease = $('btn-rc-release');
    this.pill = $('rc-status-pill');
    this.layer = $('rc-capture-layer');
    this.banner = $('rc-active-banner');
    this.stage = $('guest-share-stage');

    this.btnRequest?.addEventListener('click', () => this.request());
    this.btnRelease?.addEventListener('click', () => this.stop());
    $('btn-rc-banner-stop')?.addEventListener('click', () => this.stop());

    socket.on('rc-approved', (m) => this._onApproved(m));
    socket.on('rc-denied', (m) => this._onDenied(m));
    socket.on('rc-active', (m) => this._onActive(m));
    socket.on('rc-ended', (m) => this._onEnded(m));
    this._bindLayer();
    this._render();
  }

  /** 참가자 화면을 중계 중일 때만 제어 요청 가능 */
  setTarget(target) {
    const changed = (this.target?.id || null) !== (target?.id || null);
    this.target = target && target.id ? { id: target.id, name: target.name || '참가자' } : null;
    if (changed && this.state !== 'idle') {
      // 공유 주체가 바뀌면 서버가 세션을 종료한다. UI 는 즉시 초기화.
      this._reset();
    }
    this._render();
  }

  async request() {
    if (!this.target || (this.state !== 'idle')) return;
    this.state = 'requesting';
    this._render();
    const res = await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ error: 'timeout' }); } }, 8000);
      this.socket.emit('rc-request', { targetId: this.target.id }, (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r || {});
      });
    });
    if (res.error || !res.ok) {
      this.state = 'idle';
      const msg = {
        'target-not-sharing': '상대가 현재 화면을 공유 중이 아닙니다.',
        'target-not-found': '상대를 찾을 수 없습니다.',
        'unidirectional-room': '단방향 방에서는 원격 제어를 사용할 수 없습니다.',
        timeout: '서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.',
      }[res.error] || `원격 제어 요청 실패 (${res.error || '알 수 없음'})`;
      showToast(msg, 'error', 5000);
      this._render();
      return;
    }
    this.sessionId = res.sessionId;
    this._render();
    showToast(`${this.target.name}님에게 원격 제어를 요청했습니다. 상대의 승인을 기다립니다…`, 'info', 5000);
  }

  stop() {
    if (this.sessionId) {
      try { this.socket.emit('rc-stop', { sessionId: this.sessionId }); } catch { /* ignore */ }
    }
    this._reset();
    this._render();
  }

  get active() { return this.state === 'active'; }

  _onApproved(m) {
    if (this.state === 'idle') return;
    this.sessionId = m?.sessionId || this.sessionId;
    this.state = 'approved';
    this._render();
    showToast('상대가 허용했습니다. 상대 PC에서 제어 프로그램을 실행하면 제어권이 연결됩니다.', 'good', 6000);
  }

  _onDenied() {
    showToast('상대가 원격 제어를 거절했습니다.', 'warn', 5000);
    this._reset();
    this._render();
  }

  _onActive(m) {
    if (!m?.sessionId) return;
    this.sessionId = m.sessionId;
    this.screen = m.screen || null;
    this.state = 'active';
    this._render();
    showToast(m.dryRun ? '원격 제어 연결됨 (테스트 모드)' : '🟢 제어권을 획득했습니다. 화면 위에서 마우스/키보드로 조작하세요.', 'good', 5000);
    this.layer?.focus?.();
  }

  _onEnded(m) {
    if (this.state === 'idle') return;
    showToast(END_REASON[m?.reason] || '원격 제어가 종료되었습니다.', 'warn', 5000);
    this._reset();
    this._render();
  }

  _reset() {
    this.state = 'idle';
    this.sessionId = null;
    this.screen = null;
    this._queue.length = 0;
    this._down.clear();
    clearTimeout(this._flushTimer);
    this._flushTimer = 0;
  }

  /* ── UI ───────────────────────────────────────────────────────────── */
  _render() {
    const st = this.state;
    const show = (el, on) => el && el.classList.toggle('hidden', !on);
    show(this.btnRequest, !!this.target && st === 'idle');
    show(this.btnRelease, st === 'requesting' || st === 'approved' || st === 'active');
    if (this.btnRelease) this.btnRelease.textContent = st === 'active' ? '제어 종료' : '요청 취소';
    show(this.layer, st === 'active');
    show(this.banner, st === 'active');
    this.stage?.classList.toggle('rc-active', st === 'active');
    if (this.pill) {
      const txt = {
        requesting: '⏳ 제어 요청 중…',
        approved: '✅ 승인됨 · 상대 PC에서 제어 프로그램 실행 대기',
        active: '🟢 제어권 획득',
      }[st];
      this.pill.textContent = txt || '';
      this.pill.className = `rc-pill${txt ? '' : ' hidden'} rc-pill-${st}`;
    }
    document.body.classList.toggle('rc-controlling', st === 'active');
    if (st === 'active') {
      window.addEventListener('keydown', this._boundKey, true);
      window.addEventListener('keyup', this._boundKey, true);
    } else {
      window.removeEventListener('keydown', this._boundKey, true);
      window.removeEventListener('keyup', this._boundKey, true);
    }
  }

  /* ── 입력 캡처 ────────────────────────────────────────────────────── */
  /** 클라이언트 좌표 → 공유 화면 정규화 좌표(0~1). object-fit: contain 레터박스 보정 */
  _norm(e) {
    const video = this.getVideoEl?.();
    const box = (this.layer || video)?.getBoundingClientRect();
    if (!box || box.width < 2 || box.height < 2) return null;
    const vw = video?.videoWidth || this.screen?.w || 16;
    const vh = video?.videoHeight || this.screen?.h || 9;
    const scale = Math.min(box.width / vw, box.height / vh);
    const cw = vw * scale;
    const ch = vh * scale;
    const ox = box.left + (box.width - cw) / 2;
    const oy = box.top + (box.height - ch) / 2;
    const x = (e.clientX - ox) / cw;
    const y = (e.clientY - oy) / ch;
    if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  _bindLayer() {
    const L = this.layer;
    if (!L) return;
    L.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      const p = this._norm(e);
      if (!p) return;
      this._lastMove = p;
      // 같은 프레임의 이동은 마지막 것만 유지
      const last = this._queue[this._queue.length - 1];
      if (last && last.k === 'mm') { last.x = p.x; last.y = p.y; } else this._queue.push({ k: 'mm', x: p.x, y: p.y });
      this._schedule();
    });
    L.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      e.preventDefault();
      try { L.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      L.focus();
      const p = this._norm(e) || this._lastMove;
      const b = e.button === 2 ? 2 : (e.button === 1 ? 1 : 0);
      this._queue.push({ k: 'mm', x: p.x, y: p.y }, { k: 'md', b, x: p.x, y: p.y });
      this._schedule(true);
    });
    L.addEventListener('pointerup', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const p = this._norm(e) || this._lastMove;
      const b = e.button === 2 ? 2 : (e.button === 1 ? 1 : 0);
      this._queue.push({ k: 'mu', b, x: p.x, y: p.y });
      this._schedule(true);
    });
    L.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const p = this._norm(e) || this._lastMove;
      const k = e.deltaMode === 1 ? 40 : 1;
      this._queue.push({ k: 'wh', dx: e.deltaX * k, dy: e.deltaY * k, x: p.x, y: p.y });
      this._schedule();
    }, { passive: false });
    L.addEventListener('contextmenu', (e) => e.preventDefault());
    L.addEventListener('blur', () => this._releaseAllKeys());
  }

  _onKey(e) {
    if (!this.active) return;
    if (document.activeElement !== this.layer) return; // 캡처 레이어에 포커스가 있을 때만 키 전달
    const code = e.code || '';
    if (!/^[A-Za-z0-9]{1,24}$/.test(code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown') {
      this._down.add(code);
      this._queue.push({ k: 'kd', c: code });
    } else {
      this._down.delete(code);
      this._queue.push({ k: 'ku', c: code });
    }
    this._schedule(true);
  }

  _releaseAllKeys() {
    if (!this.active) return;
    for (const c of this._down) this._queue.push({ k: 'ku', c });
    this._down.clear();
    this._schedule(true);
  }

  _schedule(now = false) {
    if (now) { clearTimeout(this._flushTimer); this._flushTimer = 0; this._flush(); return; }
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = 0; this._flush(); }, 16);
  }

  _flush() {
    if (!this.active || !this._queue.length || !this.sessionId) { this._queue.length = 0; return; }
    const events = this._queue.splice(0, 200);
    try { this.socket.emit('rc-input', { sessionId: this.sessionId, events }); } catch { /* ignore */ }
    if (this._queue.length) this._schedule();
  }
}

/* ==========================================================================
   참가자 측: 요청 승인/거절 + 제어 프로그램 다운로드 + 상태 배너
   ========================================================================== */
export class RemoteControlViewer {
  constructor({ socket }) {
    this.socket = socket;
    this.sessionId = null;
    this.state = 'idle';
    this.modal = null;
    this.banner = null;
    socket.on('rc-request', (m) => this._onRequest(m));
    socket.on('rc-active', (m) => this._onActive(m));
    socket.on('rc-ended', (m) => this._onEnded(m));
  }

  _ensureBanner() {
    if (this.banner) return this.banner;
    const el = document.createElement('div');
    el.className = 'rc-viewer-banner hidden';
    el.innerHTML = `
      <span class="rc-viewer-dot"></span>
      <span class="rc-viewer-text"></span>
      <button type="button" class="rc-viewer-stop">제어 중지</button>`;
    el.querySelector('.rc-viewer-stop').addEventListener('click', () => this.stop());
    document.body.appendChild(el);
    this.banner = el;
    return el;
  }

  _setBanner(text, on) {
    const el = this._ensureBanner();
    el.querySelector('.rc-viewer-text').textContent = text || '';
    el.classList.toggle('hidden', !on);
  }

  _onRequest(m) {
    if (!m?.sessionId) return;
    if (this.modal) this.modal.remove();
    this.sessionId = m.sessionId;
    this.state = 'asking';
    const host = m.hostName || '호스트';
    const modal = document.createElement('div');
    modal.className = 'rc-modal-backdrop';
    modal.innerHTML = `
      <div class="rc-modal">
        <h3>🖱️ 원격 제어 요청</h3>
        <p><strong class="rc-host-name"></strong>님이 내 PC의 <b>마우스와 키보드를 제어</b>하려고 합니다.</p>
        <ul>
          <li>허용하면 <b>제어 프로그램(.bat)</b>이 다운로드됩니다. 다운로드한 파일을 <b>더블클릭해 실행</b>해야 제어가 시작됩니다.</li>
          <li>제어 중에는 화면 위에 <b>"제어 중지"</b> 버튼이 항상 표시되며, 프로그램 창을 닫으면 즉시 종료됩니다.</li>
          <li>모르는 사람의 요청이라면 <b>거절</b>하세요.</li>
        </ul>
        <div class="rc-modal-actions">
          <button type="button" class="rc-btn-deny">거절</button>
          <button type="button" class="rc-btn-allow">허용하고 프로그램 받기</button>
        </div>
      </div>`;
    modal.querySelector('.rc-host-name').textContent = host;
    modal.querySelector('.rc-btn-deny').addEventListener('click', () => this._respond(false));
    modal.querySelector('.rc-btn-allow').addEventListener('click', () => this._respond(true));
    document.body.appendChild(modal);
    this.modal = modal;
  }

  _respond(accept) {
    const sid = this.sessionId;
    this.modal?.remove();
    this.modal = null;
    if (!sid) return;
    this.socket.emit('rc-respond', { sessionId: sid, accept }, (r) => {
      if (!accept) { this.state = 'idle'; this._setBanner('', false); return; }
      if (!r?.ok || !r.downloadUrl) {
        showToast('원격 제어 허용 처리에 실패했습니다.', 'error');
        this.state = 'idle';
        return;
      }
      this.state = 'waiting-agent';
      this._setBanner('제어 프로그램을 실행해 주세요 (다운로드한 YUNSEUL-Remote-Control.bat 더블클릭)', true);
      this._download(r.downloadUrl);
    });
  }

  _download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'YUNSEUL-Remote-Control.bat';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('제어 프로그램을 다운로드했습니다. 파일을 실행해 주세요. (Windows 전용 · 보안 경고가 나오면 "실행"을 선택)', 'info', 9000);
  }

  _onActive() {
    this.state = 'active';
    this._setBanner('🟢 호스트가 내 PC를 원격 제어 중입니다', true);
  }

  _onEnded(m) {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.sessionId = null;
    this.modal?.remove();
    this.modal = null;
    this._setBanner('', false);
    showToast(END_REASON[m?.reason] || '원격 제어가 종료되었습니다.', 'warn', 5000);
  }

  stop() {
    if (this.sessionId) {
      try { this.socket.emit('rc-stop', { sessionId: this.sessionId }); } catch { /* ignore */ }
    }
    this.state = 'idle';
    this.sessionId = null;
    this._setBanner('', false);
  }
}
