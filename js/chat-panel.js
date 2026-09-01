/**
 * 드래그 가능한 채팅 레이어
 * - 닫힌 동안 DOM 갱신 안 함(링 버퍼만) → 부하 최소화
 * - 툴바 토글 / 창 닫기로 표시·숨김
 */

const MAX_BUFFER = 120;
const MAX_RENDER = 80;
const POS_KEY = 'yunseul-chat-pos';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * @param {{
 *   socket: import('socket.io-client').Socket | null,
 *   getSocket?: () => any,
 *   clientId: string,
 *   displayName: string,
 *   role?: 'host' | 'viewer',
 *   toggleBtn?: HTMLElement | null,
 * }} opts
 */
export function setupChatPanel(opts) {
  const {
    getSocket,
    clientId,
    displayName,
    role = 'viewer',
    toggleBtn = null,
  } = opts;

  let socket = opts.socket || null;
  const buffer = [];
  let open = false;
  let boundSocket = null;
  let unread = 0;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const root = ensureDom();
  const panel = root.querySelector('.chat-panel');
  const titleEl = root.querySelector('.chat-panel-title');
  const listEl = root.querySelector('.chat-panel-list');
  const formEl = root.querySelector('.chat-panel-form');
  const inputEl = root.querySelector('.chat-panel-input');
  const closeBtn = root.querySelector('.chat-panel-close');
  const unreadEl = toggleBtn?.querySelector('.chat-unread');

  restorePosition(panel);

  function currentSocket() {
    return getSocket?.() || socket || opts.socket || null;
  }

  function bindSocket() {
    const s = currentSocket();
    if (!s || s === boundSocket) return;
    if (boundSocket) {
      boundSocket.off('chat-message', onMessage);
      boundSocket.off('chat-history', onHistory);
    }
    boundSocket = s;
    s.on('chat-message', onMessage);
    s.on('chat-history', onHistory);
    try { s.emit('chat-request-history'); } catch { /* ignore */ }
  }

  function onHistory(payload) {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    buffer.length = 0;
    for (const m of msgs) pushBuffer(m);
    if (open) renderAll();
  }

  function onMessage(msg) {
    if (!msg?.text) return;
    pushBuffer(msg);
    if (open) {
      appendRow(msg, true);
    } else {
      unread += 1;
      syncUnread();
    }
  }

  function pushBuffer(msg) {
    buffer.push(msg);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  function syncUnread() {
    if (!unreadEl) return;
    if (unread > 0 && !open) {
      unreadEl.textContent = unread > 99 ? '99+' : String(unread);
      unreadEl.classList.remove('hidden');
    } else {
      unreadEl.textContent = '';
      unreadEl.classList.add('hidden');
    }
  }

  function syncToggleBtn() {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('is-active', open);
    toggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    toggleBtn.title = open ? '채팅 닫기' : '채팅 열기';
  }

  function setOpen(next) {
    open = !!next;
    root.classList.toggle('hidden', !open);
    root.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      bindSocket();
      unread = 0;
      syncUnread();
      renderAll();
      requestAnimationFrame(() => inputEl?.focus());
    } else {
      // 닫힘: DOM은 유지하되 리스트 비워 렌더 부하·메모리 완화 (버퍼는 유지)
      if (listEl) listEl.innerHTML = '';
    }
    syncToggleBtn();
  }

  function renderAll() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const slice = buffer.slice(-MAX_RENDER);
    for (const m of slice) appendRow(m, false);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function appendRow(msg, scroll) {
    if (!listEl) return;
    const mine = msg.clientId && msg.clientId === clientId;
    const row = document.createElement('li');
    row.className = 'chat-row' + (mine ? ' is-mine' : '') + (msg.role === 'host' ? ' is-host' : '');
    row.innerHTML =
      `<div class="chat-row-meta">`
      + `<span class="chat-row-name">${escapeHtml(msg.name || '참가자')}</span>`
      + `<span class="chat-row-time">${escapeHtml(formatTime(msg.at))}</span>`
      + `</div>`
      + `<div class="chat-row-text">${escapeHtml(msg.text)}</div>`;
    listEl.appendChild(row);
    while (listEl.children.length > MAX_RENDER) {
      listEl.removeChild(listEl.firstChild);
    }
    if (scroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function send() {
    const text = (inputEl?.value || '').trim();
    if (!text) return;
    bindSocket();
    const s = currentSocket();
    if (!s?.connected) return;
    s.emit('chat-send', { text });
    if (inputEl) inputEl.value = '';
  }

  formEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  closeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  });

  toggleBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    setOpen(!open);
  });

  // 타이틀 드래그
  titleEl?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest?.('button')) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    titleEl.setPointerCapture?.(e.pointerId);
    panel.classList.add('is-dragging');
    e.preventDefault();
  });

  titleEl?.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    moveTo(e.clientX - dragOffsetX, e.clientY - dragOffsetY);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    try { titleEl.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    savePosition(panel);
  };
  titleEl?.addEventListener('pointerup', endDrag);
  titleEl?.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (!open || !panel) return;
    clampPanel(panel);
    savePosition(panel);
  });

  // 소켓이 나중에 붙는 경우 대비
  const poll = setInterval(() => {
    if (currentSocket()) {
      bindSocket();
      clearInterval(poll);
    }
  }, 400);
  setTimeout(() => clearInterval(poll), 20000);

  setOpen(false);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    setSocket(s) {
      socket = s;
      bindSocket();
    },
    dispose() {
      clearInterval(poll);
      if (boundSocket) {
        boundSocket.off('chat-message', onMessage);
        boundSocket.off('chat-history', onHistory);
        boundSocket = null;
      }
      root.remove();
    },
  };
}

function ensureDom() {
  let root = document.getElementById('chat-layer');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'chat-layer';
  root.className = 'chat-layer hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="chat-panel" role="dialog" aria-labelledby="chat-panel-title">
      <div class="chat-panel-title" id="chat-panel-titlebar">
        <h3 id="chat-panel-title">채팅</h3>
        <button type="button" class="btn-close chat-panel-close" title="닫기" aria-label="채팅 닫기">✕</button>
      </div>
      <ul class="chat-panel-list" aria-live="polite"></ul>
      <form class="chat-panel-form">
        <input type="text" class="chat-panel-input" maxlength="400" placeholder="메시지 입력…" autocomplete="off">
        <button type="submit" class="btn btn-sm btn-primary chat-panel-send">전송</button>
      </form>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

function moveTo(x, y) {
  const panel = document.querySelector('#chat-layer .chat-panel');
  if (!panel) return;
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  clampPanel(panel);
}

function clampPanel(panel) {
  const rect = panel.getBoundingClientRect();
  const pad = 8;
  let left = rect.left;
  let top = rect.top;
  const maxL = Math.max(pad, window.innerWidth - rect.width - pad);
  const maxT = Math.max(pad, window.innerHeight - rect.height - pad);
  left = Math.min(Math.max(pad, left), maxL);
  top = Math.min(Math.max(pad, top), maxT);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function savePosition(panel) {
  try {
    const rect = panel.getBoundingClientRect();
    sessionStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
  } catch { /* ignore */ }
}

function restorePosition(panel) {
  if (!panel) return;
  try {
    const raw = sessionStorage.getItem(POS_KEY);
    if (raw) {
      const pos = JSON.parse(raw);
      if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        clampPanel(panel);
        return;
      }
    }
  } catch { /* ignore */ }
  // 기본: 우측
  panel.style.right = '16px';
  panel.style.top = '72px';
  panel.style.left = 'auto';
  panel.style.bottom = 'auto';
}
