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
 *   socket?: any,
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
  let sending = false;

  const root = ensureDom();
  const panel = root.querySelector('.chat-panel');
  const titleEl = root.querySelector('.chat-panel-title');
  const listEl = root.querySelector('.chat-panel-list');
  const formEl = root.querySelector('.chat-panel-form');
  const inputEl = root.querySelector('.chat-panel-input');
  const sendBtn = root.querySelector('.chat-panel-send');
  const closeBtn = root.querySelector('.chat-panel-close');
  const statusEl = root.querySelector('.chat-panel-status');
  const unreadEl = toggleBtn?.querySelector('.chat-unread');

  restorePosition(panel);

  function currentSocket() {
    return getSocket?.() || socket || opts.socket || null;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function bindSocket() {
    const s = currentSocket();
    if (!s) return;
    if (s === boundSocket) return;
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
    // 서버 히스토리로 교체하되, 아직 ack 안 된 로컬 메시지는 유지
    const locals = buffer.filter((m) => m && m._local);
    buffer.length = 0;
    for (const m of msgs) pushBuffer(m);
    for (const m of locals) {
      const exists = buffer.some((x) => x.clientId === m.clientId && x.text === m.text && !x._local);
      if (!exists) pushBuffer(m);
    }
    if (open) renderAll();
  }

  function onMessage(msg) {
    if (!msg?.text) return;
    // 낙관적 로컬 메시지와 서버 echo 병합
    const localIdx = buffer.findIndex(
      (m) => m && m._local && m.clientId === msg.clientId && m.text === msg.text
    );
    if (localIdx >= 0) {
      buffer[localIdx] = msg;
      if (open) renderAll();
      return;
    }
    if (msg.id && buffer.some((m) => m && m.id === msg.id)) return;
    pushBuffer(msg);
    if (open) {
      appendRow(msg, true);
    } else if (msg.clientId !== clientId) {
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
      setStatus('');
      renderAll();
      requestAnimationFrame(() => {
        try { inputEl?.focus({ preventScroll: true }); } catch { inputEl?.focus(); }
      });
    } else {
      if (listEl) listEl.innerHTML = '';
      setStatus('');
    }
    syncToggleBtn();
  }

  function renderAll() {
    if (!listEl) return;
    listEl.innerHTML = '';
    const slice = buffer.slice(-MAX_RENDER);
    let prevClientId = null;
    for (const m of slice) {
      appendRow(m, false, prevClientId);
      prevClientId = m.clientId || null;
    }
    listEl.scrollTop = listEl.scrollHeight;
  }

  function appendRow(msg, scroll, prevClientId) {
    if (!listEl) return;
    if (prevClientId === undefined) {
      const last = listEl.lastElementChild;
      prevClientId = last?.getAttribute('data-client-id') || null;
    }
    const mine = msg.clientId && msg.clientId === clientId;
    const sameAuthor = !!(msg.clientId && prevClientId && msg.clientId === prevClientId);
    const row = document.createElement('li');
    row.className = 'chat-row'
      + (mine ? ' is-mine' : '')
      + (msg.role === 'host' ? ' is-host' : '')
      + (sameAuthor ? ' is-continued' : '');
    if (msg.clientId) row.setAttribute('data-client-id', msg.clientId);
    const nameHtml = sameAuthor
      ? ''
      : `<div class="chat-row-meta"><span class="chat-row-name">${
          msg.role === 'host'
            ? '<span class="chat-row-icon chat-row-crown" aria-hidden="true">👑</span>'
            : '<span class="chat-row-icon chat-row-person" aria-hidden="true">'
              + '<svg viewBox="0 0 24 24" width="16" height="16" focusable="false">'
              + '<path fill="currentColor" d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2V19.2c0-3.2-6.4-4.8-9.6-4.8z"/>'
              + '</svg></span>'
        }<span class="chat-row-name-text">${escapeHtml(msg.name || '참가자')}</span></span></div>`;
    row.innerHTML =
      nameHtml
      + `<div class="chat-row-text">`
      + `<span class="chat-row-time">${escapeHtml(formatTime(msg.at))}</span>`
      + `<span class="chat-row-body">${escapeHtml(msg.text)}</span>`
      + `</div>`;
    listEl.appendChild(row);
    while (listEl.children.length > MAX_RENDER) {
      listEl.removeChild(listEl.firstChild);
    }
    if (scroll) listEl.scrollTop = listEl.scrollHeight;
  }

  function send() {
    const text = (inputEl?.value || '').trim();
    if (!text || sending) return;

    bindSocket();
    const s = currentSocket();
    if (!s) {
      setStatus('소켓이 없습니다. 페이지를 새로고침해 주세요.');
      return;
    }
    if (!s.connected) {
      setStatus('서버와 연결이 끊겼습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    sending = true;
    if (sendBtn) sendBtn.disabled = true;
    setStatus('');

    const localMsg = {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      clientId,
      role,
      name: displayName || '참가자',
      text,
      at: Date.now(),
      _local: true,
    };
    pushBuffer(localMsg);
    if (open) appendRow(localMsg, true);
    if (inputEl) inputEl.value = '';

    let settled = false;
    const finish = (errText) => {
      if (settled) return;
      settled = true;
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (errText) setStatus(errText);
      try { inputEl?.focus({ preventScroll: true }); } catch { inputEl?.focus(); }
    };

    try {
      s.timeout(8000).emit('chat-send', { text }, (err, res) => {
        if (err) {
          finish('전송 시간 초과. 서버를 재시작했는지 확인해 주세요.');
          return;
        }
        if (res?.error) {
          finish(String(res.error));
          return;
        }
        if (res?.message) onMessage(res.message);
        finish('');
      });
    } catch {
      // timeout() 미지원 구형 클라이언트 대비
      s.emit('chat-send', { text }, (res) => {
        if (res?.error) {
          finish(String(res.error));
          return;
        }
        if (res?.message) onMessage(res.message);
        finish('');
      });
      setTimeout(() => finish(''), 500);
    }
  }

  formEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation();
    send();
  });

  sendBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    send();
  });

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
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
      <p class="chat-panel-status" aria-live="polite"></p>
      <form class="chat-panel-form" action="#" autocomplete="off">
        <input type="text" class="chat-panel-input" maxlength="400" placeholder="메시지 입력…" autocomplete="off" enterkeyhint="send">
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
  panel.style.right = '16px';
  panel.style.top = '72px';
  panel.style.left = 'auto';
  panel.style.bottom = 'auto';
}
