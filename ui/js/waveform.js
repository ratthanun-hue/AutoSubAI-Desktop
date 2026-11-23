(() => {
  'use strict';

  /**
   * Interactive HTML5 Canvas Audio Waveform + Subtitle Block Drag Editor + Trim/Cut Markers
   */
  class DesktopWaveformTimeline {
    constructor(canvasEl, wrapEl, callbacks) {
      this.canvas = canvasEl;
      this.wrap = wrapEl;
      this.cb = callbacks || {};
      this.peaks = [];
      this.duration = 60;
      this.currentTime = 0;
      this.segments = [];
      this.activeIdx = -1;
      this.zoom = 1; // 1 | 2 | 4 | 8
      this.inPoint = null;
      this.outPoint = null;
      this.cutZones = []; // [{ start, end }]
      this.splitMarkers = []; // [sec, ...]

      // Drag state
      this.dragMode = null; // 'start' | 'end' | 'move' | 'scrub'
      this.dragCueIdx = -1;
      this.dragStartX = 0;
      this.dragOrigStart = 0;
      this.dragOrigEnd = 0;

      this._bindEvents();
    }

    setData({ peaks, duration, segments, activeIdx, inPoint, outPoint, cutZones, splitMarkers }) {
      if (peaks !== undefined) this.peaks = peaks || [];
      if (duration !== undefined && duration > 0) this.duration = duration;
      if (segments !== undefined) this.segments = segments || [];
      if (activeIdx !== undefined) this.activeIdx = activeIdx;
      if (inPoint !== undefined) this.inPoint = inPoint;
      if (outPoint !== undefined) this.outPoint = outPoint;
      if (cutZones !== undefined) this.cutZones = cutZones || [];
      if (splitMarkers !== undefined) this.splitMarkers = splitMarkers || [];
      this.draw();
    }

    setZoom(z) {
      this.zoom = Math.max(1, Math.min(8, Number(z) || 1));
      this.draw();
    }

    setCurrentTime(t, activeIdx) {
      this.currentTime = Math.max(0, Number(t) || 0);
      if (activeIdx !== undefined) this.activeIdx = activeIdx;
      this.draw();
    }

    _canvasWidth() {
      const baseW = Math.max(320, (this.wrap ? this.wrap.clientWidth : 600) - 2);
      return Math.round(baseW * this.zoom);
    }

    _xToTime(x, w) {
      return Math.max(0, Math.min(this.duration, (x / w) * this.duration));
    }

    _timeToX(t, w) {
      if (this.duration <= 0) return 0;
      return (t / this.duration) * w;
    }

    _hitTestCue(x, y, w, h) {
      // Cue strip sits in bottom 44% of canvas
      if (y < h * 0.50) return null;
      const edgeTol = 7;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const x1 = this._timeToX(seg.start, w);
        const x2 = Math.max(x1 + 6, this._timeToX(seg.end, w));
        if (Math.abs(x - x1) <= edgeTol) return { idx: i, mode: 'start' };
        if (Math.abs(x - x2) <= edgeTol) return { idx: i, mode: 'end' };
        if (x > x1 && x < x2) return { idx: i, mode: 'move' };
      }
      return null;
    }

    _bindEvents() {
      if (!this.canvas) return;

      this.canvas.addEventListener('mousedown', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = rect.width;
        const h = rect.height;

        const hit = this._hitTestCue(x, y, w, h);
        if (hit) {
          this.dragMode = hit.mode;
          this.dragCueIdx = hit.idx;
          this.dragStartX = x;
          this.dragOrigStart = this.segments[hit.idx].start;
          this.dragOrigEnd = this.segments[hit.idx].end;
        } else {
          this.dragMode = 'scrub';
          const t = this._xToTime(x, w);
          if (this.cb.onSeek) this.cb.onSeek(t);
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = rect.width;
        const h = rect.height;

        if (!this.dragMode) {
          const hit = this._hitTestCue(x, y, w, h);
          if (hit && (hit.mode === 'start' || hit.mode === 'end')) {
            this.canvas.style.cursor = 'ew-resize';
          } else if (hit && hit.mode === 'move') {
            this.canvas.style.cursor = 'grab';
          } else {
            this.canvas.style.cursor = 'pointer';
          }
          return;
        }

        if (this.dragMode === 'scrub') {
          if (this.cb.onSeek) this.cb.onSeek(this._xToTime(x, w));
          return;
        }

        const seg = this.segments[this.dragCueIdx];
        if (!seg) return;
        const dt = ((x - this.dragStartX) / w) * this.duration;

        if (this.dragMode === 'start') {
          seg.start = Math.max(0, Math.min(seg.end - 0.15, Number((this.dragOrigStart + dt).toFixed(3))));
        } else if (this.dragMode === 'end') {
          seg.end = Math.min(this.duration, Math.max(seg.start + 0.15, Number((this.dragOrigEnd + dt).toFixed(3))));
        } else if (this.dragMode === 'move') {
          const len = this.dragOrigEnd - this.dragOrigStart;
          const ns = Math.max(0, Math.min(this.duration - len, Number((this.dragOrigStart + dt).toFixed(3))));
          seg.start = ns;
          seg.end = Number((ns + len).toFixed(3));
        }
        this.draw();
        if (this.cb.onCueDragged) this.cb.onCueDragged(this.dragCueIdx, false);
      });

      window.addEventListener('mouseup', () => {
        if (!this.dragMode) return;
        const finishedIdx = this.dragCueIdx;
        const wasCueDrag = this.dragMode !== 'scrub';
        this.dragMode = null;
        this.dragCueIdx = -1;
        if (wasCueDrag && finishedIdx >= 0 && this.cb.onCueDragged) {
          this.cb.onCueDragged(finishedIdx, true);
        }
      });

      window.addEventListener('resize', () => this.draw());
    }

    draw() {
      if (!this.canvas) return;
      const w = this._canvasWidth();
      const h = 76;
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
      }

      const ctx = this.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Background
      ctx.fillStyle = '#0b1224';
      ctx.fillRect(0, 0, w, h);

      // Cut-out red zones
      for (const cz of this.cutZones) {
        const x1 = this._timeToX(cz.start, w);
        const x2 = this._timeToX(cz.end, w);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      }

      // In/Out highlighted selection window
      if (this.inPoint != null || this.outPoint != null) {
        const s = this.inPoint != null ? this.inPoint : 0;
        const e = this.outPoint != null ? this.outPoint : this.duration;
        if (e > s) {
          const x1 = this._timeToX(s, w);
          const x2 = this._timeToX(e, w);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
          ctx.fillRect(x1, 0, x2 - x1, h);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(x1, 0, 2, h);
          ctx.fillRect(x2 - 2, 0, 2, h);
        }
      }

      // Waveform peaks in top 52%
      const waveMid = h * 0.27;
      const waveAmp = h * 0.23;
      if (this.peaks.length > 0) {
        const step = w / this.peaks.length;
        ctx.fillStyle = 'rgba(99, 102, 241, 0.72)';
        for (let i = 0; i < this.peaks.length; i++) {
          const barH = Math.max(2, this.peaks[i] * waveAmp * 2);
          ctx.fillRect(i * step, waveMid - barH / 2, Math.max(1, step - 0.6), barH);
        }
      } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
        ctx.beginPath();
        ctx.moveTo(0, waveMid);
        ctx.lineTo(w, waveMid);
        ctx.stroke();
      }

      // Divider line
      ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.fillRect(0, h * 0.52, w, 1);

      // Subtitle cue blocks in bottom half (draggable!)
      const cueTop = h * 0.56;
      const cueH = h * 0.38;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const x1 = this._timeToX(seg.start, w);
        const x2 = Math.max(x1 + 4, this._timeToX(seg.end, w));
        const bw = x2 - x1;
        const isActive = i === this.activeIdx;
        ctx.fillStyle = isActive ? 'rgba(16, 185, 129, 0.78)' : 'rgba(99, 102, 241, 0.55)';
        ctx.fillRect(x1, cueTop, bw, cueH);
        ctx.strokeStyle = isActive ? '#6ee7b7' : 'rgba(199, 210, 254, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, cueTop + 0.5, Math.max(1, bw - 1), cueH - 1);

        if (bw > 34) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 3, cueTop, bw - 6, cueH);
          ctx.clip();
          ctx.fillStyle = '#f8fafc';
          ctx.font = '10px sans-serif';
          ctx.fillText(seg.text || `#${i + 1}`, x1 + 4, cueTop + cueH - 9);
          ctx.restore();
        }
      }

      // Razor Split Markers (amber dashed vertical cut lines)
      if (Array.isArray(this.splitMarkers) && this.splitMarkers.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        for (const mt of this.splitMarkers) {
          const mx = this._timeToX(mt, w);
          ctx.beginPath();
          ctx.moveTo(mx, 0);
          ctx.lineTo(mx, h);
          ctx.stroke();
          ctx.fillStyle = '#fbbf24';
          ctx.fillRect(mx - 4, 0, 8, 9);
        }
        ctx.restore();
      }

      // Playhead
      const px = this._timeToX(this.currentTime, w);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }

  window.DesktopWaveformTimeline = DesktopWaveformTimeline;
})();
