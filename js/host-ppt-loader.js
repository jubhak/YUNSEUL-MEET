import { PptEngine } from './ppt-engine.js?v=20260715z';
import {
  progressFromMessage,
  setStage,
  hideProgress,
  progressError,
  showProgress,
} from './load-progress.js';
import {
  putPptCache,
  getPptCache,
  fileKeyFromPresentation,
} from './ppt-cache.js?v=20260715ah';

function setStatus(msg) {
  const el = document.getElementById('upload-status');
  if (el) el.textContent = msg || '';
}

function currentRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('code') || sessionStorage.getItem('roomCode') || '').toUpperCase();
}

/** 초기 PPT 로딩 중에만 전체 화면 프로그레스를 띄움 */
let progressLive = false;
let resizeBound = false;

function reportLoadProgress(msg) {
  if (!msg) return;
  setStatus(msg);
  if (progressLive) progressFromMessage(msg);
}

function clearMediaProgress() {
  setStatus('');
  hideProgress();
}

async function disposeEngine(engine) {
  if (!engine) return;
  try {
    const { revokeMediaUrls } = await import('./pptx-parser.js?v=20260715u');
    revokeMediaUrls(engine.metadata);
  } catch { /* ignore */ }
}

function showPresentationUI() {
  document.getElementById('upload-panel')?.classList.add('hidden');
  document.getElementById('presentation-stage')?.classList.remove('hidden');
  document.body.classList.add('has-presentation');
  const reloadBtn = document.getElementById('btn-reload-ppt');
  if (reloadBtn) reloadBtn.style.display = '';
  if (window.YunseulToolbar && typeof window.YunseulToolbar.showTools === 'function') {
    window.YunseulToolbar.showTools();
  } else {
    const slideControls = document.getElementById('slide-controls');
    const drawTools = document.getElementById('draw-tools');
    const avTools = document.getElementById('av-tools');
    if (slideControls) slideControls.style.setProperty('display', 'inline-flex', 'important');
    if (drawTools) drawTools.style.setProperty('display', 'inline-flex', 'important');
    if (avTools) avTools.style.setProperty('display', 'inline-flex', 'important');
  }
}

function resolveUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  const m = url.match(/(?:^|\/)uploads\/([a-f0-9]{32}\.(?:pptx|ppt))$/i);
  if (m) {
    url = 'api/get-file?f=' + encodeURIComponent(m[1]);
  }
  const base = window.location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  return base + url.replace(/^\//, '');
}

let pptEngine = null;
let slideCount = 0;
let currentSlide = 0;
let loading = false;

function updateIndicator() {
  const el = document.getElementById('slide-indicator');
  if (el) el.textContent = `${currentSlide + 1} / ${slideCount}`;
}

export function goToSlide(index) {
  if (!pptEngine) return false;
  if (pptEngine.goToSlide(index)) {
    currentSlide = index;
    updateIndicator();
    window.dispatchEvent(new CustomEvent('ppt-slide-change', {
      detail: { slideIndex: index },
    }));
    return true;
  }
  return false;
}

export function getPptEngine() {
  return pptEngine;
}

/**
 * @param {string} url
 * @param {ArrayBuffer|null} arrayBuffer
 * @param {{ presentation?: object, fromCache?: boolean }} [opts]
 */
export async function loadPresentation(url, arrayBuffer = null, opts = {}) {
  if (loading) return pptEngine;
  loading = true;
  progressLive = true;
  const isReload = !!pptEngine;
  const previousEngine = pptEngine;
  const fromCache = !!opts.fromCache && !!arrayBuffer;

  try {
    const fullUrl = resolveUrl(url);
    showProgress(isReload ? 'PPT 다시 불러오기' : 'PPT 로딩');
    if (fromCache) {
      setStage('parse', isReload ? '캐시에서 새 PPT 준비…' : '캐시에서 PPT 불러오는 중…');
      reportLoadProgress(isReload ? '캐시에서 새 PPT 준비…' : '캐시에서 PPT 불러오는 중…');
    } else {
      setStage('download', isReload ? '새 PPT 불러오는 중…' : 'PPT 불러오는 중…');
      reportLoadProgress(isReload ? '새 PPT 불러오는 중…' : 'PPT 불러오는 중…');
    }

    const container = document.getElementById('slide-container');
    if (!container) throw new Error('슬라이드 영역을 찾을 수 없습니다.');

    if (isReload) {
      window.dispatchEvent(new CustomEvent('ppt-before-reload'));
    }

    currentSlide = 0;
    pptEngine = new PptEngine(container, {
      isHost: true,
      onProgress: (msg) => {
        if (msg === '__media_done__' || msg === '') {
          clearMediaProgress();
          return;
        }
        if (!progressLive) {
          setStatus(msg);
          return;
        }
        reportLoadProgress(msg);
      },
      onLinkClick: (data) => {
        window.dispatchEvent(new CustomEvent('ppt-link-click', { detail: data }));
      },
      onVideoClick: (data) => {
        window.dispatchEvent(new CustomEvent('ppt-video-click', { detail: data }));
      },
      onSlideCountReady: (count) => {
        slideCount = count;
        updateIndicator();
      },
    });

    let buffer = arrayBuffer;
    if (buffer) {
      slideCount = await pptEngine.loadFromArrayBuffer(buffer);
    } else {
      slideCount = await pptEngine.loadFromUrl(fullUrl);
      buffer = pptEngine.sourceBuffer || null;
    }

    const code = currentRoomCode();
    const fileKey = fileKeyFromPresentation(opts.presentation)
      || fileKeyFromPresentation({ url: fullUrl });
    if (code && fileKey && buffer) {
      putPptCache(code, fileKey, buffer, {
        url: fullUrl,
        originalName: opts.presentation?.originalName || '',
      }).catch((err) => console.warn('[ppt-cache] put failed', err));
    }

    await disposeEngine(previousEngine);

    updateIndicator();
    showPresentationUI();
    setStatus('');
    progressLive = false;
    setStage('done', '완료');
    hideProgress();
    window.YunseulToolbar?.showTools?.();

    requestAnimationFrame(() => {
      window.YunseulToolbar?.showTools?.();
      pptEngine?.resize();
      window.__yunseulDrawCanvas?.resize();
      requestAnimationFrame(() => {
        pptEngine?.resize();
        window.__yunseulDrawCanvas?.resize();
      });
    });

    if (window.__yunseulDrawCanvas) {
      const size = pptEngine.getSlideSize();
      window.__yunseulDrawCanvas.setSlideSize(size.width, size.height);
      window.__yunseulDrawCanvas.resize();
      window.__yunseulDrawCanvas.setSlide(0);
    }

    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener('resize', () => {
        pptEngine?.resize();
        window.__yunseulDrawCanvas?.resize();
      });
    }

    window.dispatchEvent(new CustomEvent('ppt-ready', {
      detail: { url: fullUrl, slideCount, reloaded: isReload, fromCache },
    }));

    return pptEngine;
  } catch (err) {
    progressLive = false;
    hideProgress();
    if (!previousEngine) pptEngine = null;
    throw err;
  } finally {
    progressLive = false;
    loading = false;
  }
}

window.addEventListener('ppt-uploaded', async (e) => {
  const presentation = e.detail?.presentation || null;
  const url = presentation?.url;
  const buffer = e.detail?.buffer || null;
  const hadPresentation = !!pptEngine;
  if (!url && !buffer) {
    setStatus('오류: 업로드 데이터에 파일 정보가 없습니다.');
    window.dispatchEvent(new CustomEvent('ppt-load-error', {
      detail: { message: '업로드 데이터에 파일 정보가 없습니다.' },
    }));
    return;
  }
  try {
    setStatus(hadPresentation ? '새 PPT 불러오는 중…' : 'PPT 라이브러리/슬라이드 불러오는 중…');
    const { ensurePptxReady } = await import('./deps.js');
    await ensurePptxReady();
    await loadPresentation(url, buffer, { presentation });
    goToSlide(0);
  } catch (err) {
    console.error('[ppt-loader]', err);
    const message = (err && err.message) || '알 수 없는 오류';
    setStatus('PPT 표시 오류: ' + message + ' — check.html 에서 검사하세요.');
    progressError(message);
    window.dispatchEvent(new CustomEvent('ppt-load-error', { detail: { message } }));
    if (!hadPresentation && !pptEngine) {
      document.getElementById('upload-panel')?.classList.remove('hidden');
      document.getElementById('presentation-stage')?.classList.add('hidden');
    }
  }
});

// 새로고침: 로컬 캐시 우선, 없으면 서버 다운로드
window.addEventListener('DOMContentLoaded', () => {
  const code = currentRoomCode();
  if (!code) return;

  fetch(resolveUrl('api/get-room?code=' + encodeURIComponent(code)))
    .then((r) => r.json())
    .then(async (state) => {
      if (!state?.presentation?.url || pptEngine) return;
      const presentation = state.presentation;
      const fileKey = fileKeyFromPresentation(presentation);
      let cached = null;
      if (fileKey) {
        cached = await getPptCache(code, fileKey);
      }
      if (cached) {
        await loadPresentation(presentation.url, cached, { presentation, fromCache: true });
      } else {
        await loadPresentation(presentation.url, null, { presentation });
      }
      goToSlide(state.currentSlide || 0);
    })
    .catch((err) => console.warn('기존 발표 로드 실패', err));
});

document.getElementById('btn-prev')?.addEventListener('click', () => goToSlide(currentSlide - 1));
document.getElementById('btn-next')?.addEventListener('click', () => goToSlide(currentSlide + 1));

document.addEventListener('keydown', (e) => {
  if (!pptEngine) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goToSlide(currentSlide + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goToSlide(currentSlide - 1);
});
