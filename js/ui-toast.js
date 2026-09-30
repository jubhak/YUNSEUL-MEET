/** 간단한 토스트 알림 (alert 는 흐름을 막으므로 사용하지 않는다) */
let host = null;

export function showToast(message, kind = 'info', ms = 3800) {
  if (typeof document === 'undefined' || !message) return;
  if (!host) {
    host = document.createElement('div');
    host.className = 'ym-toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `ym-toast ym-toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  const remove = () => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 260);
  };
  setTimeout(remove, ms);
  el.addEventListener('click', remove);
  while (host.children.length > 4) host.firstChild.remove();
}
