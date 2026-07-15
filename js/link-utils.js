/**

 * 슬라이드 위 http(s) 링크 / 동영상 탐지 유틸

 */



export function normalizeHttpUrl(raw) {

  if (!raw) return null;

  let u = String(raw).trim();

  u = u.replace(/^[<(\["']+/, '').replace(/[>)\]"'",.;:!?]+$/g, '');

  if (/^www\./i.test(u)) u = `https://${u}`;

  if (!/^https?:\/\//i.test(u)) return null;

  try {

    const parsed = new URL(u);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    return parsed.href;

  } catch {

    return null;

  }

}



/**

 * 낙서 캔버스 아래 DOM에서 링크를 찾습니다.

 */

export function findHttpLinkAt(clientX, clientY, overlayEl) {

  const prev = overlayEl ? overlayEl.style.pointerEvents : null;

  if (overlayEl) overlayEl.style.pointerEvents = 'none';

  const el = document.elementFromPoint(clientX, clientY);

  if (overlayEl) overlayEl.style.pointerEvents = prev || '';



  if (!el || !el.closest?.('.slide-container, .presentation-stage')) {

    return null;

  }



  const tagged = el.closest('a[href], [data-yunseul-href], [data-href]');

  if (tagged) {

    const href =

      tagged.getAttribute('href') ||

      tagged.getAttribute('data-yunseul-href') ||

      tagged.getAttribute('data-href');

    const url = normalizeHttpUrl(href);

    if (url) {

      return {

        url,

        title: (tagged.textContent || '').trim().slice(0, 80) || url,

        el: tagged,

      };

    }

  }



  let node = el;

  for (let i = 0; i < 8 && node; i++) {

    const text = (node.innerText || node.textContent || '').trim();

    if (text && text.length < 500) {

      const m =

        text.match(/https?:\/\/[^\s<>"'，。]+/i) ||

        text.match(/\bwww\.[^\s<>"'，。]+/i);

      if (m) {

        const url = normalizeHttpUrl(m[0]);

        if (url) return { url, title: url, el: node };

      }

    }

    node = node.parentElement;

  }

  return null;

}



/** 동영상 영역 탭 여부 (호스트 전용) */

export function findVideoHitAt(clientX, clientY, overlayEl, engine) {

  const prev = overlayEl ? overlayEl.style.pointerEvents : null;

  if (overlayEl) overlayEl.style.pointerEvents = 'none';

  const el = document.elementFromPoint(clientX, clientY);

  if (overlayEl) overlayEl.style.pointerEvents = prev || '';



  const slideMeta = engine?.metadata?.slides?.[engine.currentSlide];

  const videos = slideMeta?.videos || [];

  if (!videos.length) return null;



  const hitVideo = el?.closest?.('video, [data-video], [data-yunseul-video]');

  if (hitVideo) {

    return { name: videos[0].name, el: hitVideo };

  }



  const container = document.getElementById('slide-container');

  if (!container) return null;

  const rect = container.getBoundingClientRect();

  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {

    return null;

  }

  const relY = (clientY - rect.top) / Math.max(rect.height, 1);

  if (relY >= 0.35) {

    return { name: videos[0].name, el: null, fallbackRect: {

      left: rect.left,

      top: rect.top + rect.height * 0.35,

      width: rect.width,

      height: rect.height * 0.65,

    } };

  }

  return null;

}



/** 슬라이드 안 네이티브 video 직접 재생 차단 */

export function lockInlineMedia(root, { isHost = false } = {}) {

  if (!root) return;

  root.querySelectorAll('video, audio').forEach((media) => {

    try {

      media.pause();

    } catch { /* ignore */ }

    media.removeAttribute('controls');

    media.controls = false;

    media.autoplay = false;

    media.classList.add('yunseul-hotmedia');

    media.style.setProperty('pointer-events', 'none', 'important');

    media.style.cursor = isHost ? 'pointer' : 'default';



    if (!media.dataset.yunseulLocked) {

      media.dataset.yunseulLocked = '1';

      media.addEventListener('play', (e) => {

        if (media.id === 'sync-video') return;

        e.preventDefault();

        e.stopImmediatePropagation();

        try { media.pause(); } catch { /* ignore */ }

      }, true);

      media.addEventListener('click', (e) => {

        if (media.id === 'sync-video') return;

        e.preventDefault();

        e.stopPropagation();

      }, true);

    }

  });

}



/** 슬라이드 안 http 링크 표시용 클래스만 붙임 (스타일 변경 없음) */
export function enhanceSlideLinks(root) {
  if (!root) return;
  root.querySelectorAll('a[href]').forEach((a) => {
    const url = normalizeHttpUrl(a.getAttribute('href'));
    if (!url) return;
    a.setAttribute('href', url);
    a.classList.add('yunseul-hotlink');
    a.style.cursor = '';
    a.style.removeProperty('text-decoration');
  });
}


