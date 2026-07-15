/**
 * 접속자 수 표시 + 명단 레이어 팝업
 * 닫기는 ✕ 버튼으로만
 */
let latestViewers = [];

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

  return root;
}

function renderList(viewers) {
  const list = document.getElementById('viewers-list');
  const countEl = document.getElementById('viewers-popup-count');
  if (countEl) countEl.textContent = String(viewers.length);
  if (!list) return;

  if (!viewers.length) {
    list.innerHTML = '<li class="viewers-empty">접속 중인 참가자가 없습니다.</li>';
    return;
  }

  list.innerHTML = viewers.map((v, i) => {
    const name = escapeHtml(v.name || `참가자 ${i + 1}`);
    const initial = escapeHtml((v.name || '참').trim().charAt(0) || '?');
    return `
      <li class="viewers-item">
        <span class="viewers-avatar" aria-hidden="true">${initial}</span>
        <span class="viewers-name">${name}</span>
        <span class="viewers-tag">참가</span>
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

export function setViewerCount(n, viewers) {
  const count = Math.max(0, Number(n) || 0);
  if (Array.isArray(viewers)) {
    latestViewers = viewers;
  } else if (count === 0) {
    latestViewers = [];
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
      // 팝업이 열려 있는데 0명이 되면 목록만 갱신 (닫지는 않음 — 닫기는 ✕만)
      if (!document.getElementById('viewers-popup')?.classList.contains('hidden')) {
        renderList(latestViewers);
      }
    }
  }
}

export function setupViewersPanel() {
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
