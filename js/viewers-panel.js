/**
 * 접속자 수 표시 + 명단 레이어 팝업
 * 호스트: 목록 클릭으로 화면 공유 대상 선택
 * 닫기는 ✕ 버튼으로만
 */
let latestViewers = [];
let selectedId = null;
let selectable = false;
let onSelectParticipant = null;

function ensurePopupDom() {
  let root = document.getElementById('viewers-popup');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'viewers-popup';
  root.className = 'viewers-popup hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="viewers-popup-box" role="dialog" aria-modal="true" aria-labelledby="viewers-popup-title">
      <div class="viewers-popup-header">
        <h3 id="viewers-popup-title">접속자 명단</h3>
        <button type="button" id="viewers-popup-close" class="btn-close" title="닫기">✕</button>
      </div>
      <p class="viewers-popup-sub"><span id="viewers-popup-count">0</span>명 접속 중</p>
      <p id="viewers-popup-hint" class="viewers-popup-hint hidden">이름을 누르면 그 화면을 전원에게 보여줍니다. 호스트를 누르면 참가자 공유를 끄고 발표 화면으로 돌아갑니다.</p>
      <ul id="viewers-list" class="viewers-list"></ul>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById('viewers-popup-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideViewersPopup();
  });

  // 배경 클릭으로는 닫지 않음
  root.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  root.addEventListener('click', (e) => {
    const item = e.target.closest?.('.viewers-item[data-id]');
    if (!item || !selectable || !onSelectParticipant) return;
    e.preventDefault();
    const id = item.getAttribute('data-id');
    const role = item.getAttribute('data-role') || 'viewer';
    const name = item.getAttribute('data-name') || '';
    if (!id) return;
    onSelectParticipant({ id, role, name });
  });

  // 호스트 항목 더블클릭도 동일하게 발표 화면 복귀
  root.addEventListener('dblclick', (e) => {
    const item = e.target.closest?.('.viewers-item[data-id][data-role="host"]');
    if (!item || !selectable || !onSelectParticipant) return;
    e.preventDefault();
    const id = item.getAttribute('data-id');
    const name = item.getAttribute('data-name') || '';
    if (!id) return;
    onSelectParticipant({ id, role: 'host', name });
  });

  return root;
}

function renderList(viewers) {
  const list = document.getElementById('viewers-list');
  const countEl = document.getElementById('viewers-popup-count');
  const hint = document.getElementById('viewers-popup-hint');
  if (countEl) countEl.textContent = String(viewers.length);
  if (hint) hint.classList.toggle('hidden', !selectable);
  if (!list) return;

  if (!viewers.length) {
    list.innerHTML = '<li class="viewers-empty">접속 중인 참가자가 없습니다.</li>';
    return;
  }

  list.innerHTML = viewers.map((v, i) => {
    const name = escapeHtml(v.name || `참가자 ${i + 1}`);
    const initial = escapeHtml((v.name || '참').trim().charAt(0) || '?');
    const role = v.role === 'host' ? 'host' : 'viewer';
    const tag = role === 'host' ? '호스트' : '참가';
    const isSelected = selectedId && v.id === selectedId;
    const micState = v.micState === 'on' || v.micState === 'none' ? v.micState : 'off';
    const micTitle = micState === 'on'
      ? '마이크 켜짐'
      : micState === 'none'
        ? '마이크 인식 안 됨'
        : '마이크 꺼짐';
    const MIC_SVG_ON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>`;
    const MIC_SVG_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line><line x1="2" y1="2" x2="22" y2="22" stroke="#ef4444" stroke-width="2.6" stroke-linecap="round"></line></svg>`;
    const micIco = micState === 'on' ? MIC_SVG_ON : MIC_SVG_OFF;
    const micHtml = micState === 'none'
      ? `<span class="viewers-mic is-none" title="${micTitle}" aria-label="${micTitle}"><span class="mic-ico" aria-hidden="true">${micIco}</span><span class="mic-x" aria-hidden="true">✕</span></span>`
      : `<span class="viewers-mic is-${micState}" title="${micTitle}" aria-label="${micTitle}"><span class="mic-ico" aria-hidden="true">${micIco}</span></span>`;
    const classes = [
      'viewers-item',
      role === 'host' ? 'is-host' : '',
      selectable ? 'is-selectable' : '',
      isSelected ? 'is-selected' : '',
    ].filter(Boolean).join(' ');
    return `
      <li class="${classes}" data-speak-id="${escapeHtml(v.id || '')}" data-id="${escapeHtml(v.id || '')}" data-role="${role}" data-name="${name}" ${selectable ? 'role="button" tabindex="0"' : ''}>
        <span class="viewers-avatar" aria-hidden="true">${initial}</span>
        <span class="viewers-name">${name}</span>
        ${micHtml}
        <span class="viewers-tag${role === 'host' ? ' is-host-tag' : ''}">${v.admitted === false ? '마이크 확인 중' : tag}</span>
        ${isSelected ? '<span class="viewers-live">공유중</span>' : ''}
      </li>
    `;
  }).join('');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showViewersPopup() {
  ensurePopupDom();
  renderList(latestViewers);
  const root = document.getElementById('viewers-popup');
  root?.classList.remove('hidden');
  root?.setAttribute('aria-hidden', 'false');
}

export function hideViewersPopup() {
  const root = document.getElementById('viewers-popup');
  root?.classList.add('hidden');
  root?.setAttribute('aria-hidden', 'true');
}

export function setSelectedBroadcaster(id) {
  selectedId = id || null;
  if (!document.getElementById('viewers-popup')?.classList.contains('hidden')) {
    renderList(latestViewers);
  }
}

export function setViewerCount(n, viewers, opts = {}) {
  const count = Math.max(0, Number(n) || 0);
  if (Array.isArray(viewers)) {
    latestViewers = viewers;
  } else if (count === 0) {
    latestViewers = [];
  }
  if (opts.activeBroadcasterId !== undefined) {
    selectedId = opts.activeBroadcasterId || null;
  }

  const el = document.getElementById('viewer-count');
  if (el) el.textContent = String(count);

  const link = document.getElementById('viewer-count-link');
  if (link) {
    if (count > 0) {
      link.classList.add('is-active');
      link.setAttribute('href', '#viewers');
      link.setAttribute('role', 'button');
      link.setAttribute('tabindex', '0');
      link.title = '접속자 명단 보기';
    } else {
      link.classList.remove('is-active');
      link.removeAttribute('href');
      link.removeAttribute('role');
      link.setAttribute('tabindex', '-1');
      link.title = '';
    }
  }

  if (!document.getElementById('viewers-popup')?.classList.contains('hidden')) {
    renderList(latestViewers);
  }
}

export function setupViewersPanel(opts = {}) {
  selectable = !!opts.selectable;
  onSelectParticipant = typeof opts.onSelect === 'function' ? opts.onSelect : null;
  ensurePopupDom();

  const link = document.getElementById('viewer-count-link');
  if (!link || link.dataset.bound) return;
  link.dataset.bound = '1';

  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const n = Number(document.getElementById('viewer-count')?.textContent || 0);
    if (n <= 0) return;
    showViewersPopup();
  });

  link.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      link.click();
    }
  });
}

export function getLatestViewers() {
  return latestViewers.slice();
}
