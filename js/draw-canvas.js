export class DrawCanvas {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.isHost = options.isHost ?? false;
    this.onStrokeEnd = options.onStrokeEnd || (() => {});
    this.onStrokeStart = options.onStrokeStart || (() => {});
    this.onStrokeMove = options.onStrokeMove || (() => {});
    /** 짧은 탭(거의 이동 없음) — 링크 클릭 등 */
    this.onTap = options.onTap || (() => {});
    this.onPointerHover = options.onPointerHover || null;
    this.onPointerLeave = options.onPointerLeave || null;

    this.isDrawing = false;
    this.currentStroke = null;
    this.strokesBySlide = {};
    this.currentSlide = 0;
    this.penColor = '#ff0000';
    this.penSize = 4;
    this.isEraser = false;
    this.slideWidth = 1920;
    this.slideHeight = 1080;
    this._pointerClient = null;
    this._movedPx = 0;
    this._overlayCanvas = null;
    this._overlayCtx = null;
    this._overlayHandlers = null;
    this._overlayLayer = null; // 'video' | 'link' | null
    this._drawTarget = 'slide'; // 'slide' | 'video' | 'link'
    /** 펜 모드 ON일 때만 스트로크 허용 (OFF면 탭/링크만) */
    this.drawingEnabled = true;

    if (this.isHost) {
      this.bindEvents();
    }
  }

  setDrawingEnabled(enabled) {
    this.drawingEnabled = !!enabled;
    if (!this.drawingEnabled && this.isDrawing) {
      this.isDrawing = false;
      this.currentStroke = null;
      this._strokeStarted = false;
    }
  }

  isOverlayLayer(layer) {
    return layer === 'video' || layer === 'link';
  }

  /** 동영상/웹팝업 위 낙서 레이어 */
  setOverlaySurface(layer, canvas) {
    this.unbindOverlaySurface();
    if (!layer || !canvas) {
      this._drawTarget = 'slide';
      return;
    }
    this._overlayLayer = layer;
    this._overlayCanvas = canvas;
    this._overlayCtx = canvas.getContext('2d');
    this._drawTarget = layer;
    if (this.isHost) {
      this.bindOverlaySurface(canvas, layer);
      this.resizeOverlaySurface();
      this.redrawOverlay();
    }
  }

  setVideoSurface(canvas) {
    this.setOverlaySurface(canvas ? 'video' : null, canvas || null);
  }

  setLinkSurface(canvas) {
    this.setOverlaySurface(canvas ? 'link' : null, canvas || null);
  }

  bindOverlaySurface(canvas, layer) {
    const start = (e) => {
      this._drawTarget = layer;
      this.startDraw(e);
    };
    const move = (e) => this.moveDraw(e);
    const end = (e) => this.endDraw(e);
    const touchStart = (e) => {
      e.preventDefault();
      this._drawTarget = layer;
      this.startDraw(e.touches[0]);
    };
    const touchMove = (e) => {
      e.preventDefault();
      this.moveDraw(e.touches[0]);
    };
    const touchEnd = (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      this.endDraw(t || null);
    };
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', touchStart, { passive: false });
    canvas.addEventListener('touchmove', touchMove, { passive: false });
    canvas.addEventListener('touchend', touchEnd);
    this._overlayHandlers = { start, move, end, touchStart, touchMove, touchEnd, canvas };
  }

  unbindOverlaySurface() {
    const h = this._overlayHandlers;
    if (h?.canvas) {
      h.canvas.removeEventListener('mousedown', h.start);
      h.canvas.removeEventListener('mousemove', h.move);
      h.canvas.removeEventListener('mouseup', h.end);
      h.canvas.removeEventListener('mouseleave', h.end);
      h.canvas.removeEventListener('touchstart', h.touchStart);
      h.canvas.removeEventListener('touchmove', h.touchMove);
      h.canvas.removeEventListener('touchend', h.touchEnd);
    }
    this._overlayHandlers = null;
    if (this._overlayCanvas) {
      try {
        this._overlayCtx?.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
      } catch { /* ignore */ }
    }
    this._overlayCanvas = null;
    this._overlayCtx = null;
    this._overlayLayer = null;
    this._drawTarget = 'slide';
  }

  unbindVideoSurface() {
    this.unbindOverlaySurface();
  }

  resizeOverlaySurface() {
    const canvas = this._overlayCanvas;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    canvas.width = this.slideWidth;
    canvas.height = this.slideHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.redrawOverlay();
  }

  resizeVideoSurface() {
    this.resizeOverlaySurface();
  }

  bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this._drawTarget = 'slide';
      this.startDraw(e);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.isDrawing && this.onPointerHover) {
        this.onPointerHover({ clientX: e.clientX, clientY: e.clientY });
      }
      this.moveDraw(e);
    });
    this.canvas.addEventListener('mouseup', (e) => this.endDraw(e));
    this.canvas.addEventListener('mouseleave', (e) => {
      if (this.onPointerLeave) this.onPointerLeave();
      this.endDraw(e);
    });

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._drawTarget = 'slide';
      this.startDraw(e.touches[0]);
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      this.moveDraw(e.touches[0]);
    }, { passive: false });
    this.canvas.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      this.endDraw(t || null);
    });
  }

  setPenColor(color) {
    this.penColor = color;
    this.isEraser = false;
  }

  setPenSize(size) {
    this.penSize = size;
  }

  setEraser(enabled) {
    this.isEraser = enabled;
  }

  setSlideSize(width, height) {
    this.slideWidth = width;
    this.slideHeight = height;
    this.resize();
  }

  setSlide(index) {
    this.currentSlide = index;
    this.redraw();
  }

  resize() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const pw = rect.width || window.innerWidth;
    const ph = rect.height || window.innerHeight;

    const video = parent.querySelector('video');
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      this.slideWidth = vw;
      this.slideHeight = vh;

      const parentAspect = pw / Math.max(ph, 1);
      const videoAspect = vw / Math.max(vh, 1);
      let displayW, displayH, offsetX, offsetY;

      if (parentAspect > videoAspect) {
        displayH = ph;
        displayW = ph * videoAspect;
        offsetX = (pw - displayW) / 2;
        offsetY = 0;
      } else {
        displayW = pw;
        displayH = pw / videoAspect;
        offsetX = 0;
        offsetY = (ph - displayH) / 2;
      }

      this.canvas.width = vw;
      this.canvas.height = vh;
      this.canvas.style.position = 'absolute';
      this.canvas.style.width = `${displayW}px`;
      this.canvas.style.height = `${displayH}px`;
      this.canvas.style.left = `${offsetX}px`;
      this.canvas.style.top = `${offsetY}px`;
      this.canvas.style.transform = 'none';
      this.redraw();
      return;
    }

    this.canvas.width = this.slideWidth || 1920;
    this.canvas.height = this.slideHeight || 1080;
    this.canvas.style.position = 'absolute';
    this.canvas.style.width = `${pw}px`;
    this.canvas.style.height = `${ph}px`;
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';
    this.canvas.style.transform = 'none';
    this.redraw();
  }

  syncToFit(displayW, displayH) {
    this.canvas.width = this.slideWidth;
    this.canvas.height = this.slideHeight;
    this.canvas.style.width = `${displayW}px`;
    this.canvas.style.height = `${displayH}px`;
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.transform = 'none';
    this.redraw();
  }

  getPoint(e) {
    const surface = this.isOverlayLayer(this._drawTarget) && this._overlayCanvas
      ? this._overlayCanvas
      : this.canvas;
    const rect = surface.getBoundingClientRect();
    const scaleX = surface.width / Math.max(rect.width, 1);
    const scaleY = surface.height / Math.max(rect.height, 1);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  startDraw(e) {
    if (!this.isHost) return;
    this.isDrawing = true;
    this._pointerClient = { x: e.clientX, y: e.clientY };
    const point = this.getPoint(e);
    if (!this.drawingEnabled) return;
    this.currentStroke = {
      color: this.isEraser ? '#ffffff' : this.penColor,
      size: this.isEraser ? this.penSize * 3 : this.penSize,
      points: [point],
      isEraser: this.isEraser,
      layer: this._drawTarget || 'slide',
    };
    const slideIndex = this.isOverlayLayer(this._drawTarget) ? this._drawTarget : this.currentSlide;
    this.onStrokeStart({
      slideIndex,
      stroke: this.currentStroke,
    });
  }

  moveDraw(e) {
    if (!this.isDrawing || !this.currentStroke || !this.drawingEnabled) return;
    const point = this.getPoint(e);
    this.currentStroke.points.push(point);

    const slideIndex = this.isOverlayLayer(this._drawTarget)
      ? this._drawTarget
      : this.currentSlide;

    this.onStrokeMove({
      slideIndex,
      point,
      stroke: this.currentStroke,
    });
    this.drawStroke(this.currentStroke, this._drawTarget);
  }

  endDraw(e) {
    if (!this.isDrawing || !this.currentStroke) return;
    this.isDrawing = false;

    const stroke = this.currentStroke;
    this.currentStroke = null;
    const layer = stroke.layer || this._drawTarget || 'slide';
    const slideIndex = this.isOverlayLayer(layer) ? layer : this.currentSlide;

    if (stroke.points.length >= 1) {
      if (stroke.points.length === 1) {
        stroke.points.push({ x: stroke.points[0].x + 0.1, y: stroke.points[0].y + 0.1 });
        this.drawStroke(stroke, this._drawTarget);
      }
      if (!this.strokesBySlide[slideIndex]) {
        this.strokesBySlide[slideIndex] = [];
      }
      this.strokesBySlide[slideIndex].push({ ...stroke });
      this.onStrokeEnd({
        slideIndex,
        stroke: { ...stroke },
      });
    }
  }

  drawStroke(stroke, target = 'slide') {
    if (!stroke || stroke.points.length < 2) return;
    const ctx = this.isOverlayLayer(target) && this._overlayCtx
      ? this._overlayCtx
      : this.ctx;
    if (!ctx) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.isEraser ? '#ffffff' : stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  handleRemoteStrokeStart({ slideIndex, stroke }) {
    if (!this._remoteStrokes) this._remoteStrokes = {};
    this._remoteStrokes[slideIndex] = {
      ...stroke,
      points: [...(stroke.points || [])],
    };
    const target = this.isOverlayLayer(slideIndex) ? slideIndex : 'slide';
    if (this._remoteStrokes[slideIndex].points.length >= 2) {
      this.drawStroke(this._remoteStrokes[slideIndex], target);
    }
  }

  handleRemoteStrokeMove({ slideIndex, point, stroke }) {
    if (!this._remoteStrokes) this._remoteStrokes = {};
    let rem = this._remoteStrokes[slideIndex];
    if (!rem) {
      rem = this._remoteStrokes[slideIndex] = { ...stroke, points: [] };
    }
    if (point) rem.points.push(point);
    const target = this.isOverlayLayer(slideIndex) ? slideIndex : 'slide';
    this.drawStroke(rem, target);
  }

  handleRemoteStrokeEnd({ slideIndex, stroke }) {
    let rem = (this._remoteStrokes && this._remoteStrokes[slideIndex]) || stroke;
    if (rem && rem.points?.length >= 1) {
      if (rem.points.length === 1) {
        rem.points.push({ x: rem.points[0].x + 0.1, y: rem.points[0].y + 0.1 });
        const target = this.isOverlayLayer(slideIndex) ? slideIndex : 'slide';
        this.drawStroke(rem, target);
      }
      this.addStroke(slideIndex, rem);
    }
    if (this._remoteStrokes) {
      delete this._remoteStrokes[slideIndex];
    }
  }

  redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const strokes = this.strokesBySlide[this.currentSlide] || this.strokesBySlide['slide'] || [];
    strokes.forEach((s) => this.drawStroke(s, 'slide'));
  }

  redrawOverlay() {
    if (!this._overlayCtx || !this._overlayCanvas || !this._overlayLayer) return;
    this._overlayCtx.clearRect(0, 0, this._overlayCanvas.width, this._overlayCanvas.height);
    const strokes = this.strokesBySlide[this._overlayLayer] || [];
    strokes.forEach((s) => this.drawStroke(s, this._overlayLayer));
  }

  redrawVideo() {
    this.redrawOverlay();
  }

  addStroke(slideIndex, stroke) {
    if (!this.strokesBySlide[slideIndex]) {
      this.strokesBySlide[slideIndex] = [];
    }
    this.strokesBySlide[slideIndex].push(stroke);
    if (this.isOverlayLayer(slideIndex) && this._overlayLayer === slideIndex) {
      this.drawStroke(stroke, slideIndex);
    } else if (slideIndex === this.currentSlide || slideIndex === 'slide' || slideIndex === 0) {
      this.drawStroke(stroke, 'slide');
    }
  }

  loadStrokes(drawings) {
    this.strokesBySlide = drawings || {};
    this.redraw();
    this.redrawOverlay();
  }

  clearSlide(slideIndex) {
    this.strokesBySlide[slideIndex] = [];
    if (this.isOverlayLayer(slideIndex)) this.redrawOverlay();
    else if (slideIndex === this.currentSlide || slideIndex === 'slide' || slideIndex === 0) this.redraw();
  }

  clearAll() {
    this.strokesBySlide = {};
    if (this._remoteStrokes) this._remoteStrokes = {};
    this.redraw();
    this.redrawOverlay();
  }
}
