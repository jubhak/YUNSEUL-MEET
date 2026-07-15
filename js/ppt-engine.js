// CDN 직접 로드 대신 deps.js 사용 (importmap + esm.sh)
import { ensurePptxReady } from './deps.js?v=20260715b';
import { fitSlideToStage, killInnerScroll } from './fit-slide.js?v=20260715b';
import { enhanceSlideLinks, normalizeHttpUrl, lockInlineMedia } from './link-utils.js?v=20260715z';

const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;

export class PptEngine {
  constructor(container, options = {}) {
    this.container = container;
    this.isHost = options.isHost ?? false;
    this.onLinkClick = options.onLinkClick || (() => {});
    this.onVideoClick = options.onVideoClick || (() => {});
    this.onSlideCountReady = options.onSlideCountReady || (() => {});
    this.onProgress = options.onProgress || (() => {});

    this.viewer = null;
    this.metadata = null;
    this.sourceBuffer = null;
    this.currentSlide = 0;
    this.slideCount = 0;
    this.slideElements = [];
    this._displayScale = 1;
    this._mode = 'slide';
  }

  async loadFromBuffer(arrayBuffer, metadata = null) {
    this.sourceBuffer = arrayBuffer;
    this.metadata = metadata || { slideCount: 1, slides: [], mediaFiles: {} };
    this.slideCount = this.metadata.slideCount || 1;
    this.container.innerHTML = '';
    this._mediaReady = false;
    this._enrichPromise = null;

    this.onProgress('렌더러 준비…');
    const init = await ensurePptxReady();

    // list 모드 = 세로 스택 + 검은 wrapper + 스크롤 → 검정 화면/스크롤 원인
    // slide 모드 = 한 장만 렌더, renderSingleSlide로 전환
    this.viewer = init(this.container, {
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      mode: 'slide',
    });
    this._mode = 'slide';

    this.onProgress('슬라이드 렌더링 중… (이미지·장수에 따라 시간이 걸릴 수 있음)');
    await this.viewer.preview(arrayBuffer);

    this.onProgress('렌더 완료 — 화면 정리…');

    const libCount = this.viewer.slideCount;
    if (libCount && libCount > 0) {
      this.slideCount = libCount;
    }

    this.currentSlide = 0;
    this.hideLibraryChrome();
    this.cacheSlideElements();
    this.normalizeWrapper();
    enhanceSlideLinks(this.container);
    lockInlineMedia(this.container, { isHost: this.isHost });
    this.setupInteractions();
    killInnerScroll(this.container);
    this.updateContainerSize();

    this.onSlideCountReady(this.slideCount);

    // 메타·동영상 추출은 백그라운드 — 발표 UI는 여기서 바로 열림
    this._enrichPromise = this.enrichInBackground(arrayBuffer);

    return this.slideCount;
  }

  /**
   * 슬라이드 표시 후 ZIP 메타데이터·미디어를 백그라운드에서 준비.
   * 로딩 완료 체감을 앞당기고, 재생 시에만 폴백 추출한다.
   */
  async enrichInBackground(arrayBuffer) {
    try {
      const { parsePptxMetadata, extractAllMediaUrls } = await import(
        './pptx-parser.js?v=20260715s'
      );
      // 메타가 아직 비어 있거나 stub이면 파싱
      const needsMeta = !this.metadata?.slides?.length;
      if (needsMeta) {
        this.metadata = await parsePptxMetadata(arrayBuffer, () => {});
        if (this.metadata.slideCount > 0) {
          this.slideCount = this.metadata.slideCount;
          this.onSlideCountReady(this.slideCount);
        }
      }
      await extractAllMediaUrls(arrayBuffer, this.metadata?.mediaFiles, () => {});
      this.syncMediaUrlsToSlides();
      this._mediaReady = true;
      try {
        window.dispatchEvent(
          new CustomEvent('ppt-enriched', {
            detail: { slideCount: this.slideCount, mediaReady: true },
          })
        );
      } catch { /* ignore */ }
    } catch (err) {
      console.warn('[ppt] 백그라운드 미디어/메타 준비 실패 (재생 시 재시도)', err);
    }
  }

  /** mediaFiles.url → 슬라이드 videos/audios.url 동기화 */
  syncMediaUrlsToSlides() {
    const files = this.metadata?.mediaFiles;
    const slides = this.metadata?.slides;
    if (!files || !slides) return;
    for (const slide of slides) {
      for (const list of [slide.videos, slide.audios]) {
        if (!list) continue;
        for (const item of list) {
          const u = files[item.name]?.url;
          if (u) item.url = u;
        }
      }
    }
  }

  async loadFromUrl(url) {
    this.onProgress('파일 다운로드 중…');
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`PPT 파일을 가져오지 못했습니다 (HTTP ${res.status}). URL: ${url}`);
    }
    const buffer = await res.arrayBuffer();
    return this.loadFromArrayBuffer(buffer);
  }

  async loadFromArrayBuffer(buffer) {
    this.assertPptxZip(buffer);
    // 메타데이터 ZIP 파싱을 preview 앞으로 두지 않음 → 첫 화면까지 시간 단축
    return this.loadFromBuffer(buffer, null);
  }

  assertPptxZip(buffer) {
    if (!buffer || buffer.byteLength < 4) {
      throw new Error('파일이 비어 있거나 너무 작습니다.');
    }
    const b = new Uint8Array(buffer, 0, 4);
    const isZip = b[0] === 0x50 && b[1] === 0x4b;
    if (!isZip) {
      const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength)));
      if (head.includes('<') || /html|Not Found|Warning/i.test(head)) {
        throw new Error('서버가 PPT 대신 오류 페이지(HTML)를 반환했습니다.');
      }
      throw new Error('ZIP(.pptx) 형식이 아닙니다. PowerPoint에서 .pptx로 저장해 주세요.');
    }
  }

  /** 라이브러리 내장 ◀▶ / 페이지 숫자 숨김 (우리 툴바 사용) */
  hideLibraryChrome() {
    const root = this.container;
    if (!root) return;
    root.querySelectorAll(
      '.pptx-preview-wrapper-next, .pptx-preview-wrapper-pre, .pptx-preview-wrapper-pagination'
    ).forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('aria-hidden', 'true');
    });
  }

  normalizeWrapper() {
    const wrapper = this.container.querySelector('.pptx-preview-wrapper');
    if (!wrapper) return;
    wrapper.style.setProperty('background', '#ffffff', 'important');
    wrapper.style.setProperty('overflow', 'hidden', 'important');
    wrapper.style.setProperty('overflow-x', 'hidden', 'important');
    wrapper.style.setProperty('overflow-y', 'hidden', 'important');
    wrapper.style.setProperty('width', `${SLIDE_WIDTH}px`, 'important');
    wrapper.style.setProperty('height', `${SLIDE_HEIGHT}px`, 'important');
    wrapper.style.setProperty('margin', '0', 'important');
    wrapper.style.setProperty('padding', '0', 'important');
    wrapper.style.setProperty('position', 'relative', 'important');
  }

  cacheSlideElements() {
    const slides = this.container.querySelectorAll('.pptx-preview-slide-wrapper, [class*="pptx-preview-slide-wrapper"]');
    this.slideElements = Array.from(slides);
  }

  async resolveVideoUrl(nameOrData) {
    const name = typeof nameOrData === 'string' ? nameOrData : nameOrData?.name;
    if (!name) return nameOrData?.url || null;
    const cached = this.metadata?.mediaFiles?.[name];
    // PPT 로드 시 이미 추출됨 → ZIP 재열기 없이 즉시 반환
    if (cached?.url) return cached.url;
    if (nameOrData?.url) return nameOrData.url;

    // 폴백: 사전 추출 실패 시에만 ZIP에서 꺼냄 (발표 중 오버레이 없음)
    this.onProgress(`동영상/음악 준비 중: ${name}`);
    try {
      // 백그라운드 추출이 끝나길 짧게 기다림 (이미 끝났으면 즉시)
      if (this._enrichPromise && !this._mediaReady) {
        try {
          await Promise.race([
            this._enrichPromise,
            new Promise((r) => setTimeout(r, 80)),
          ]);
          if (this.metadata?.mediaFiles?.[name]?.url) {
            return this.metadata.mediaFiles[name].url;
          }
        } catch { /* 폴백 */ }
      }
      const { extractMediaUrl } = await import('./pptx-parser.js?v=20260715s');
      const url = await extractMediaUrl(this.sourceBuffer, name);
      if (url && this.metadata?.mediaFiles?.[name]) {
        this.metadata.mediaFiles[name].url = url;
      } else if (url && this.metadata) {
        this.metadata.mediaFiles = this.metadata.mediaFiles || {};
        this.metadata.mediaFiles[name] = {
          ...(this.metadata.mediaFiles[name] || { name }),
          name,
          url,
        };
      }
      return url;
    } finally {
      this.onProgress('__media_done__');
    }
  }

  updateContainerSize() {
    const stage = document.getElementById('presentation-stage') || this.container.closest('.presentation-stage');
    const fit = document.getElementById('slide-fit');
    const scaler = document.getElementById('slide-scaler');
    if (!stage || !fit || !scaler) return;

    // 숨김이면 실측을 위해 표시 — 다시 숨기지 않음 (흰화면/빈 스테이지 방지)
    if (stage.classList.contains('hidden')) {
      stage.classList.remove('hidden');
    }

    this.normalizeWrapper();
    this.hideLibraryChrome();

    const scale = fitSlideToStage({
      stage,
      fit,
      scaler,
      container: this.container,
      slideWidth: SLIDE_WIDTH,
      slideHeight: SLIDE_HEIGHT,
    });

    this._displayScale = scale;

    if (window.__yunseulDrawCanvas) {
      const displayW = Math.round(SLIDE_WIDTH * scale);
      const displayH = Math.round(SLIDE_HEIGHT * scale);
      window.__yunseulDrawCanvas.setSlideSize(SLIDE_WIDTH, SLIDE_HEIGHT);
      window.__yunseulDrawCanvas.syncToFit(displayW, displayH);
    }
  }

  resize() {
    this.updateContainerSize();
  }

  getDisplayScale() {
    return this._displayScale || 1;
  }

  setupInteractions() {
    // 호스트만 슬라이드 내 클릭으로 링크/동영상 실행
    if (!this.isHost) {
      // 참가자는 인라인 미디어 클릭 자체를 차단
      if (this._viewerGuardBound) return;
      this._viewerGuardBound = true;
      this.container.addEventListener('click', (e) => {
        if (e.target.closest('video, audio, [data-video]')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      return;
    }
    if (this._clickBound) return;
    this._clickBound = true;

    this.container.addEventListener('click', async (e) => {
      // 펜 모드에서는 링크/영상 클릭 무시 (낙서는 draw-canvas가 담당)
      if (document.body.classList.contains('pen-mode')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const chrome = e.target.closest(
        '.pptx-preview-wrapper-next, .pptx-preview-wrapper-pagination'
      );
      if (chrome) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const anchor = e.target.closest('a, [data-yunseul-href], [data-href]');
      if (anchor) {
        e.preventDefault();
        e.stopPropagation();
        const href =
          anchor.getAttribute('href') ||
          anchor.getAttribute('data-yunseul-href') ||
          anchor.getAttribute('data-href');
        const url = normalizeHttpUrl(href);
        if (url) {
          this.onLinkClick({ url, title: (anchor.textContent || '').trim() || url });
        }
        return;
      }

      const slideMeta = this.metadata?.slides[this.currentSlide];
      if (!slideMeta?.videos?.length) return;

      const videoEl = e.target.closest('video, [data-video]');
      const rect = this.container.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / Math.max(rect.height, 1);
      if (!videoEl && !(slideMeta.videos.length >= 1 && relY > 0.55)) return;

      e.preventDefault();
      e.stopPropagation();
      const v = slideMeta.videos[0];
      const url = await this.resolveVideoUrl(v.name);
      if (url) this.onVideoClick({ url, name: v.name });
    });
  }

  goToSlide(index) {
    if (index < 0 || index >= this.slideCount) return false;

    const hasSlideDom = !!this.container.querySelector('[class*="pptx-preview-slide-wrapper"]');
    const sameSlide = index === this.currentSlide && hasSlideDom;

    this.currentSlide = index;

    if (!sameSlide && this.viewer && typeof this.viewer.renderSingleSlide === 'function') {
      try {
        this.viewer.renderSingleSlide(index);
      } catch (err) {
        console.warn('[ppt] renderSingleSlide', err);
      }
    }

    this.hideLibraryChrome();
    this.normalizeWrapper();
    this.cacheSlideElements();
    enhanceSlideLinks(this.container);
    lockInlineMedia(this.container, { isHost: this.isHost });
    killInnerScroll(this.container);
    this.updateContainerSize();
    this.setupInteractions();
    return true;
  }

  next() {
    return this.goToSlide(this.currentSlide + 1);
  }

  prev() {
    return this.goToSlide(this.currentSlide - 1);
  }

  getSlideCount() {
    return this.slideCount;
  }

  getCurrentSlide() {
    return this.currentSlide;
  }

  getSlideSize() {
    return { width: SLIDE_WIDTH, height: SLIDE_HEIGHT };
  }
}
