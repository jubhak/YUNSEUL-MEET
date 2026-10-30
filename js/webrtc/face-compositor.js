import { createWorkerTicker } from '../virtual-avatar-manager.js?v=20261030k';

/**
 * 호스트 참가자 타일을 16:9 카드로 합성해 보낸다.
 * 인원 수에 맞춰 가로를 채운다(2명이면 반반). 빈 3칸 기준으로 줄이지 않는다.
 */
export class FaceCompositor {
  constructor({ getTiles, width = 1920, height = 1080, fps = 30 } = {}) {
    this.getTiles = typeof getTiles === 'function' ? getTiles : () => [];
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this._ticker = null;
    this._stream = null;
  }

  start() {
    this.stopTicker();
    if (!this._stream || this._stream.getVideoTracks().every((t) => t.readyState !== 'live')) {
      this._stream = this.canvas.captureStream(this.fps);
    }
    const vt = this._stream.getVideoTracks()[0];
    try { if (vt) vt.contentHint = 'motion'; } catch { /* ignore */ }
    this._draw();
    this._ticker = createWorkerTicker(Math.round(1000 / this.fps), () => this._draw());
    return this._stream;
  }

  setFps(fps) {
    const next = Math.max(8, Math.round(Number(fps) || this.fps));
    if (next === this.fps) return;
    this.fps = next;
    if (!this._ticker) return;
    this.stopTicker();
    this._ticker = createWorkerTicker(Math.round(1000 / this.fps), () => this._draw());
  }

  stopTicker() {
    try { this._ticker?.stop?.(); } catch { /* ignore */ }
    this._ticker = null;
  }

  stop() {
    this.stopTicker();
    this._stream?.getTracks?.().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this._stream = null;
  }

  getStream() {
    return this._stream;
  }

  _cols(n) {
    if (n <= 1) return 1;
    if (n === 2 || n === 4) return 2;
    if (n >= 21) return 6;
    if (n >= 10) return 5;
    return 3;
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _drawCover(video, x, y, w, h) {
    const vw = video.videoWidth || w;
    const vh = video.videoHeight || h;
    if (vw < 2 || vh < 2) return false;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    this.ctx.drawImage(video, dx, dy, dw, dh);
    return true;
  }

  _draw() {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const g = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, '#0f172a');
    g.addColorStop(1, '#020617');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    let tiles = [];
    try { tiles = this.getTiles() || []; } catch { tiles = []; }
    const n = Math.max(1, tiles.length);
    const cols = this._cols(n);
    const rows = Math.ceil(n / cols);
    const padX = Math.round(W * 0.045);
    const padY = Math.round(H * 0.07);
    const gap = n <= 1 ? 0 : Math.round(W * (cols >= 5 ? 0.012 : 0.016));
    const innerW = W - padX * 2;
    const innerH = H - padY * 2;
    const footerH = Math.max(26, Math.round(H * 0.05));
    let cardW = n <= 1
      ? Math.min(innerW, (innerH - footerH) * (16 / 9))
      : (innerW - gap * (cols - 1)) / cols;
    let mediaH = cardW * (9 / 16);
    let cardH = mediaH + footerH;
    const blockH = rows * cardH + Math.max(0, rows - 1) * gap;
    if (blockH > innerH && blockH > 0) {
      const scale = innerH / blockH;
      cardW *= scale;
      mediaH *= scale;
      cardH *= scale;
    }
    const radius = Math.max(8, Math.round(cardW * 0.035));

    for (let row = 0; row < rows; row += 1) {
      const start = row * cols;
      const count = Math.min(cols, n - start);
      const rowW = count * cardW + Math.max(0, count - 1) * gap;
      const originX = (W - rowW) / 2;
      const originY = (H - (rows * cardH + Math.max(0, rows - 1) * gap)) / 2 + row * (cardH + gap);
      for (let c = 0; c < count; c += 1) {
        const tile = tiles[start + c] || {};
        const x = originX + c * (cardW + gap);
        const y = originY;
        this._drawCard(ctx, tile, x, y, cardW, cardH, mediaH, footerH, radius);
      }
    }
  }

  _drawCard(ctx, tile, x, y, w, h, mediaH, footerH, radius) {
    ctx.save();
    this._roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = '#0b1329';
    ctx.fillRect(x, y, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, mediaH);
    ctx.clip();
    ctx.fillStyle = '#020617';
    ctx.fillRect(x, y, w, mediaH);
    const video = tile.video;
    const drawn = video && video.readyState >= 2 && this._drawCover(video, x, y, w, mediaH);
    if (!drawn) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
      ctx.beginPath();
      ctx.arc(x + w / 2, y + mediaH * 0.45, Math.min(w, mediaH) * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 ${Math.max(11, Math.round(mediaH * 0.08))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('카메라 꺼짐', x + w / 2, y + mediaH * 0.72, w - 12);
    }
    ctx.restore();

    const fy = y + mediaH;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fillRect(x, fy, w, footerH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, fy, w, 1);
    ctx.fillStyle = '#f8fafc';
    ctx.font = `700 ${Math.max(12, Math.round(footerH * 0.42))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = `${tile.name || '참가자'}${tile.isHost ? ' 👑' : ''}`;
    ctx.fillText(label, x + Math.max(8, w * 0.04), fy + footerH / 2, w - 16);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
    this._drawSpeakOverlay(ctx, tile, x, y, w, h, radius);
  }

  _drawSpeakOverlay(ctx, tile, x, y, w, h, radius) {
    if (!tile?.speaking) return;
    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = Math.max(3, Math.round(w * 0.012));
    this._roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();

    const bands = Array.isArray(tile.bands) ? tile.bands : null;
    const barW = Math.max(18, Math.min(50, w * 0.2));
    const barH = Math.max(12, Math.min(30, h * 0.14));
    const bx = x + w - barW - Math.max(4, w * 0.02);
    const by = y + h - barH - Math.max(4, h * 0.025);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(bx, by, barW, barH, 5);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, barW, barH);
    }
    const n = 7;
    const gap = 2;
    const padX = 4;
    const padY = 3;
    const innerW = barW - padX * 2;
    const innerH = barH - padY * 2;
    const iw = (innerW - gap * (n - 1)) / n;
    const lvl = 0.35 + 0.65 * (Number(tile.level) || 0);
    ctx.fillStyle = '#facc15';
    for (let i = 0; i < n; i += 1) {
      const v = Math.max(0.1, Math.min(1, ((bands && bands[i]) || 0.35) * lvl * 1.15));
      const bh = innerH * v;
      ctx.fillRect(bx + padX + i * (iw + gap), by + padY + (innerH - bh), Math.max(1, iw), bh);
    }
    ctx.restore();
  }
}
