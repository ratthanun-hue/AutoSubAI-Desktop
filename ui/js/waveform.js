(() => {
  'use strict';

  /**
   * CapCut / Premiere-Style 4-Track Visual Timeline Canvas (v1.4.0):
   * - T4 (y 0..22):   Watermark & Photo B-Roll / PiP Overlays
   * - T3 (y 24..54):  Draggable Subtitle Cue Blocks (drag start/end/move)
   * - T2 (y 56..98):  Audio Waveform + Cut-Out Zones + In/Out + Razor Split Markers
   * - T1 (y 100..128): BGM Audio Track + Auto Audio Ducking Visualizer
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
      this.cutZones = [];     // [{ start, end }]
      this.splitMarkers = []; // [sec, ...]
      this.brollOverlays = []; // [{ start, end, name }]
      this.bgmInfo = { enabled: false, name: '', auto_ducking: true };
      this.watermarkEnabled = false;

      // Drag state
      this.dragMode = null; // 'start' | 'end' | 'move' | 'scrub'
      this.dragCueIdx = -1;
      this.dragStartX = 0;
      this.dragOrigStart = 0;
      this.dragOrigEnd = 0;

      this._bindEvents();
    }

    setData({
      peaks,
      duration,
      segments,
      activeIdx,
      inPoint,
      outPoint,
      cutZones,
      splitMarkers,
      brollOverlays,
      bgmInfo,
      watermarkEnabled,
    }) {
      if (peaks !== undefined) this.peaks = peaks || [];
      if (duration !== undefined && duration > 0) this.duration = duration;
      if (segments !== undefined) this.segments = segments || [];
      if (activeIdx !== undefined) this.activeIdx = activeIdx;
      if (inPoint !== undefined) this.inPoint = inPoint;
      if (outPoint !== undefined) this.outPoint = outPoint;
      if (cutZones !== undefined) this.cutZones = cutZones || [];
      if (splitMarkers !== undefined) this.splitMarkers = splitMarkers || [];
      if (brollOverlays !== undefined) this.brollOverlays = brollOverlays || [];
      if (bgmInfo !== undefined) this.bgmInfo = bgmInfo || { enabled: false, name: '', auto_ducking: true };
      if (watermarkEnabled !== undefined) this.watermarkEnabled = !!watermarkEnabled;
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

    _hitTestCue(x, y, w) {
      // T3 Subtitle track sits at y = 24..54
      if (y < 23 || y > 55) return null;
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

        const hit = this._hitTestCue(x, y, w);
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

        if (!this.dragMode) {
          const hit = this._hitTestCue(x, y, w);
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
      const h = 128;
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
      ctx.fillStyle = '#090f1f';
      ctx.fillRect(0, 0, w, h);

      // Track background bands & subtle dividers
      const tracks = [
        { y: 0, hh: 22, bg: 'rgba(245, 158, 11, 0.04)', label: 'T4 🖼️' },
        { y: 24, hh: 30, bg: 'rgba(16, 185, 129, 0.04)', label: 'T3 💬' },
        { y: 56, hh: 42, bg: 'rgba(99, 102, 241, 0.05)', label: 'T2 🎬' },
        { y: 100, hh: 28, bg: 'rgba(20, 184, 166, 0.04)', label: 'T1 🎵' },
      ];
      for (const tr of tracks) {
        ctx.fillStyle = tr.bg;
        ctx.fillRect(0, tr.y, w, tr.hh);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.fillRect(0, tr.y + tr.hh, w, 1);
      }

      // Cut-out red zones across all tracks
      for (const cz of this.cutZones) {
        const x1 = this._timeToX(cz.start, w);
        const x2 = this._timeToX(cz.end, w);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      }

      // In/Out selection window
      if (this.inPoint != null || this.outPoint != null) {
        const s = this.inPoint != null ? this.inPoint : 0;
        const e = this.outPoint != null ? this.outPoint : this.duration;
        if (e > s) {
          const x1 = this._timeToX(s, w);
          const x2 = this._timeToX(e, w);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
          ctx.fillRect(x1, 0, x2 - x1, h);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(x1, 0, 2, h);
          ctx.fillRect(x2 - 2, 0, 2, h);
        }
      }

      // === T4 (y 2..20): Watermark + Photo B-Roll Overlays ===
      if (this.watermarkEnabled) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.20)';
        ctx.fillRect(2, 3, w - 4, 16);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
        ctx.strokeRect(2.5, 3.5, w - 5, 15);
      }
      for (const br of this.brollOverlays) {
        const x1 = this._timeToX(br.start, w);
        const x2 = Math.max(x1 + 8, this._timeToX(br.end, w));
        ctx.fillStyle = 'rgba(236, 72, 153, 0.52)';
        ctx.fillRect(x1, 2, x2 - x1, 18);
        ctx.strokeStyle = '#f472b6';
        ctx.strokeRect(x1 + 0.5, 2.5, Math.max(1, x2 - x1 - 1), 17);
        if (x2 - x1 > 44) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 3, 2, x2 - x1 - 6, 18);
          ctx.clip();
          ctx.fillStyle = '#fdf2f8';
          ctx.font = '10px sans-serif';
          ctx.fillText(`🖼️ ${br.name || 'B-Roll'}`, x1 + 4, 14);
          ctx.restore();
        }
      }

      // === T3 (y 26..52): Draggable Subtitle Blocks ===
      const cueTop = 26;
      const cueH = 26;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const x1 = this._timeToX(seg.start, w);
        const x2 = Math.max(x1 + 4, this._timeToX(seg.end, w));
        const bw = x2 - x1;
        const isActive = i === this.activeIdx;
        ctx.fillStyle = isActive ? 'rgba(16, 185, 129, 0.82)' : 'rgba(99, 102, 241, 0.52)';
        ctx.fillRect(x1, cueTop, bw, cueH);
        ctx.strokeStyle = isActive ? '#6ee7b7' : 'rgba(199, 210, 254, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, cueTop + 0.5, Math.max(1, bw - 1), cueH - 1);

        if (bw > 34) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 3, cueTop, bw - 6, cueH);
          ctx.clip();
          ctx.fillStyle = '#f8fafc';
          ctx.font = '10px sans-serif';
          ctx.fillText(seg.text || `#${i + 1}`, x1 + 4, cueTop + 17);
          ctx.restore();
        }
      }

      // === T2 (y 56..98): Audio Waveform Peaks ===
      const waveMid = 77;
      const waveAmp = 18;
      if (this.peaks.length > 0) {
        const step = w / this.peaks.length;
        ctx.fillStyle = 'rgba(129, 140, 248, 0.78)';
        for (let i = 0; i < this.peaks.length; i++) {
          const barH = Math.max(2, this.peaks[i] * waveAmp * 2);
          ctx.fillRect(i * step, waveMid - barH / 2, Math.max(1, step - 0.6), barH);
        }
      } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.beginPath();
        ctx.moveTo(0, waveMid);
        ctx.lineTo(w, waveMid);
        ctx.stroke();
      }

      // === T1 (y 102..126): BGM Music Track + Auto Audio Ducking Visualizer ===
      if (this.bgmInfo && this.bgmInfo.enabled && this.bgmInfo.name) {
        ctx.fillStyle = 'rgba(20, 184, 166, 0.26)';
        ctx.fillRect(2, 103, w - 4, 22);
        ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)';
        ctx.strokeRect(2.5, 103.5, w - 5, 21);

        // Draw auto-ducking dip curve under every subtitle cue!
        if (this.bgmInfo.auto_ducking) {
          ctx.fillStyle = 'rgba(13, 148, 136, 0.55)';
          for (const seg of this.segments) {
            const dx1 = this._timeToX(seg.start, w);
            const dx2 = Math.max(dx1 + 3, this._timeToX(seg.end, w));
            ctx.fillRect(dx1, 117, dx2 - dx1, 8);
          }
        }
        ctx.fillStyle = '#99f6e4';
        ctx.font = '10px sans-serif';
        ctx.fillText(
          `🎵 ${this.bgmInfo.name}${this.bgmInfo.auto_ducking ? ' • Auto Ducking ON' : ''}`,
          44,
          117
        );
      } else {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.font = '10px sans-serif';
        ctx.fillText('🎵 BGM Track (เพิ่มเพลงพื้นหลังในแท็บ 🎚️ สี/สปีด & BGM)', 44, 117);
      }

      // Track badge pills on far left
      for (const tr of tracks) {
        ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
        ctx.fillRect(2, tr.y + 3, 36, 15);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '9px sans-serif';
        ctx.fillText(tr.label, 5, tr.y + 13);
      }

      // Razor Split Markers (amber dashed vertical lines across all tracks)
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

      // Full-height Playhead
      const px = this._timeToX(this.currentTime, w);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }

  window.DesktopWaveformTimeline = DesktopWaveformTimeline;
})();
