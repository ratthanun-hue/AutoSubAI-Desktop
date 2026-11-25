(() => {
  'use strict';

  const HEIGHT_STORAGE_KEY = 'autosub_timeline_height';
  const DEFAULT_HEIGHT = 230;
  const MIN_HEIGHT = 160;
  const MAX_HEIGHT = 420;

  /**
   * CapCut / Premiere-Style 5-Track Resizable Visual Timeline Canvas (v1.5.0):
   * - Ruler: Timecode ruler
   * - T5: Watermark & Photo B-Roll / PiP Overlays
   * - T4: Draggable Subtitle Cue Blocks (drag start/end/move)
   * - T3: Draggable Voiceover / Dubbing Clips (live mic + imported audio)
   * - T2: Audio Waveform + Cut-Out Zones + In/Out + Razor Split Markers [B]
   * - T1: BGM Audio Track + Auto Audio Ducking Visualizer
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
      this.zoom = 1; // 1..16
      this.inPoint = null;
      this.outPoint = null;
      this.cutZones = [];       // [{ start, end }]
      this.splitMarkers = [];   // [sec, ...]
      this.brollOverlays = [];  // [{ start, end, name }]
      this.voiceoverClips = []; // [{ id, start, duration, name, volume }]
      this.bgmInfo = { enabled: false, name: '', auto_ducking: true };
      this.watermarkEnabled = false;

      // Saved resizable height
      let savedH = DEFAULT_HEIGHT;
      try {
        const raw = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
        if (raw >= MIN_HEIGHT && raw <= MAX_HEIGHT) savedH = Math.round(raw);
      } catch (_) {}
      this.height = savedH;
      this._applyCssHeight();

      // Drag state
      this.dragMode = null; // 'start' | 'end' | 'move' | 'vo_move' | 'scrub'
      this.dragCueIdx = -1;
      this.dragVoIdx = -1;
      this.dragStartX = 0;
      this.dragOrigStart = 0;
      this.dragOrigEnd = 0;

      this._bindEvents();
    }

    _applyCssHeight() {
      try {
        document.documentElement.style.setProperty('--timeline-h', `${this.height}px`);
      } catch (_) {}
    }

    setHeight(px, persist = true) {
      const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(px) || DEFAULT_HEIGHT)));
      this.height = clamped;
      this._applyCssHeight();
      if (persist) {
        try { localStorage.setItem(HEIGHT_STORAGE_KEY, String(clamped)); } catch (_) {}
      }
      this.draw();
    }

    toggleExpand() {
      const next = this.height >= 310 ? DEFAULT_HEIGHT : 340;
      this.setHeight(next, true);
      return next;
    }

    _computeLayout() {
      const h = this.height;
      const rulerH = 18;
      const avail = Math.max(120, h - rulerH - 4);
      const t5H = Math.max(20, Math.round(avail * 0.13));
      const t4H = Math.max(32, Math.round(avail * 0.24));
      const t3H = Math.max(26, Math.round(avail * 0.19));
      const t2H = Math.max(36, Math.round(avail * 0.28));
      const t1H = Math.max(22, avail - t5H - t4H - t3H - t2H);

      let y = rulerH + 1;
      const t5 = { y, hh: t5H, bg: 'rgba(245, 158, 11, 0.04)', label: 'T5 🖼️', key: 't5' }; y += t5H + 1;
      const t4 = { y, hh: t4H, bg: 'rgba(16, 185, 129, 0.04)', label: 'T4 💬', key: 't4' }; y += t4H + 1;
      const t3 = { y, hh: t3H, bg: 'rgba(244, 63, 94, 0.05)',  label: 'T3 🎙️', key: 't3' }; y += t3H + 1;
      const t2 = { y, hh: t2H, bg: 'rgba(99, 102, 241, 0.05)', label: 'T2 🎬', key: 't2' }; y += t2H + 1;
      const t1 = { y, hh: Math.max(20, h - y), bg: 'rgba(20, 184, 166, 0.04)', label: 'T1 🎵', key: 't1' };
      return { rulerH, t5, t4, t3, t2, t1, tracks: [t5, t4, t3, t2, t1] };
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
      voiceoverClips,
      bgmInfo,
      audioMonitor,
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
      if (voiceoverClips !== undefined) this.voiceoverClips = voiceoverClips || [];
      if (bgmInfo !== undefined) this.bgmInfo = bgmInfo || { enabled: false, name: '', auto_ducking: true };
      if (audioMonitor !== undefined) this.audioMonitor = audioMonitor || { solo: null, mute: { t3: false, t2: false, t1: false } };
      if (watermarkEnabled !== undefined) this.watermarkEnabled = !!watermarkEnabled;
      this.draw();
    }

    setZoom(z) {
      this.zoom = Math.max(1, Math.min(16, Number(z) || 1));
      this.draw();
    }

    _fmtRuler(sec) {
      const s = Math.max(0, Math.floor(sec));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = s % 60;
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
      return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
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
      const { t4 } = this._computeLayout();
      if (y < t4.y || y > t4.y + t4.hh) return null;
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

    _hitTestVoiceover(x, y, w) {
      const { t3 } = this._computeLayout();
      if (y < t3.y || y > t3.y + t3.hh) return null;
      for (let i = 0; i < this.voiceoverClips.length; i++) {
        const vo = this.voiceoverClips[i];
        const dur = Math.max(1.5, Number(vo.duration) || 3.0);
        const x1 = this._timeToX(vo.start, w);
        const x2 = Math.max(x1 + 14, this._timeToX(vo.start + dur, w));
        if (x >= x1 && x <= x2) return { idx: i, mode: 'vo_move' };
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
          return;
        }

        const voHit = this._hitTestVoiceover(x, y, w);
        if (voHit) {
          this.dragMode = 'vo_move';
          this.dragVoIdx = voHit.idx;
          this.dragStartX = x;
          this.dragOrigStart = Number(this.voiceoverClips[voHit.idx].start) || 0;
          return;
        }

        this.dragMode = 'scrub';
        const t = this._xToTime(x, w);
        if (this.cb.onSeek) this.cb.onSeek(t);
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
          } else if (this._hitTestVoiceover(x, y, w)) {
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

        const dt = ((x - this.dragStartX) / w) * this.duration;

        if (this.dragMode === 'vo_move') {
          const vo = this.voiceoverClips[this.dragVoIdx];
          if (!vo) return;
          const ns = Math.max(0, Math.min(Math.max(0, this.duration - 0.5), Number((this.dragOrigStart + dt).toFixed(2))));
          vo.start = ns;
          this.draw();
          if (this.cb.onVoiceoverDragged) this.cb.onVoiceoverDragged(this.dragVoIdx, ns, false);
          return;
        }

        const seg = this.segments[this.dragCueIdx];
        if (!seg) return;

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
        const finishedVoIdx = this.dragVoIdx;
        const mode = this.dragMode;
        this.dragMode = null;
        this.dragCueIdx = -1;
        this.dragVoIdx = -1;
        if (mode === 'vo_move' && finishedVoIdx >= 0 && this.voiceoverClips[finishedVoIdx] && this.cb.onVoiceoverDragged) {
          this.cb.onVoiceoverDragged(finishedVoIdx, this.voiceoverClips[finishedVoIdx].start, true);
        } else if (mode !== 'scrub' && mode !== 'vo_move' && finishedIdx >= 0 && this.cb.onCueDragged) {
          this.cb.onCueDragged(finishedIdx, true);
        }
      });

      window.addEventListener('resize', () => this.draw());
      if (typeof ResizeObserver !== 'undefined' && this.wrap) {
        this._ro = new ResizeObserver(() => this.draw());
        this._ro.observe(this.wrap);
      }
    }

    draw() {
      if (!this.canvas) return;
      const w = this._canvasWidth();
      const h = this.height;
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
      }

      const ctx = this.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const { rulerH, t5, t4, t3, t2, t1, tracks } = this._computeLayout();

      // Background
      ctx.fillStyle = '#090f1f';
      ctx.fillRect(0, 0, w, h);

      // === TIME RULER ===
      ctx.fillStyle = '#0d152a';
      ctx.fillRect(0, 0, w, rulerH);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.24)';
      ctx.fillRect(0, rulerH, w, 1);
      if (this.duration > 0) {
        const niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
        const targetSec = (90 / Math.max(1, w)) * this.duration;
        const stepSec = niceSteps.find((s) => s >= targetSec) || 900;
        ctx.font = '10px Consolas, monospace';
        for (let t = 0; t <= this.duration; t += stepSec) {
          const tx = this._timeToX(t, w);
          ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
          ctx.fillRect(tx, rulerH - 6, 1, 6);
          if (tx + 38 < w) {
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(this._fmtRuler(t), tx + 3, rulerH - 5);
          }
        }
      }

      // Track background bands & subtle dividers
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
        ctx.fillRect(x1, rulerH + 1, Math.max(2, x2 - x1), h - rulerH - 1);
      }

      // In/Out selection window
      if (this.inPoint != null || this.outPoint != null) {
        const s = this.inPoint != null ? this.inPoint : 0;
        const e = this.outPoint != null ? this.outPoint : this.duration;
        if (e > s) {
          const x1 = this._timeToX(s, w);
          const x2 = this._timeToX(e, w);
          ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
          ctx.fillRect(x1, rulerH + 1, x2 - x1, h - rulerH - 1);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(x1, 0, 2, h);
          ctx.fillRect(x2 - 2, 0, 2, h);
        }
      }

      // === T5: Watermark + Photo B-Roll Overlays ===
      const brTop = t5.y + 3;
      const brH = Math.max(14, t5.hh - 6);
      if (this.watermarkEnabled) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        ctx.fillRect(2, brTop, w - 4, brH);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.42)';
        ctx.strokeRect(2.5, brTop + 0.5, w - 5, brH - 1);
      }
      for (const br of this.brollOverlays) {
        const x1 = this._timeToX(br.start, w);
        const x2 = Math.max(x1 + 10, this._timeToX(br.end, w));
        ctx.fillStyle = 'rgba(236, 72, 153, 0.54)';
        ctx.fillRect(x1, brTop, x2 - x1, brH);
        ctx.strokeStyle = '#f472b6';
        ctx.strokeRect(x1 + 0.5, brTop + 0.5, Math.max(1, x2 - x1 - 1), brH - 1);
        if (x2 - x1 > 44) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 3, brTop, x2 - x1 - 6, brH);
          ctx.clip();
          ctx.fillStyle = '#fdf2f8';
          ctx.font = '10.5px sans-serif';
          ctx.fillText(`🖼️ ${br.name || 'B-Roll'}`, x1 + 4, brTop + Math.round(brH * 0.68));
          ctx.restore();
        }
      }

      // === T4: Draggable Subtitle Blocks ===
      const cueTop = t4.y + 3;
      const cueH = Math.max(24, t4.hh - 6);
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const x1 = this._timeToX(seg.start, w);
        const x2 = Math.max(x1 + 4, this._timeToX(seg.end, w));
        const bw = x2 - x1;
        const isActive = i === this.activeIdx;
        ctx.fillStyle = isActive ? 'rgba(16, 185, 129, 0.86)' : 'rgba(99, 102, 241, 0.56)';
        ctx.fillRect(x1, cueTop, bw, cueH);
        ctx.strokeStyle = isActive ? '#6ee7b7' : 'rgba(199, 210, 254, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, cueTop + 0.5, Math.max(1, bw - 1), cueH - 1);

        if (bw > 28) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1 + 4, cueTop, bw - 8, cueH);
          ctx.clip();
          ctx.fillStyle = '#f8fafc';
          ctx.font = cueH >= 40 ? '12px sans-serif' : '11px sans-serif';
          ctx.fillText(seg.text || `#${i + 1}`, x1 + 5, cueTop + Math.round(cueH * 0.62));
          ctx.restore();
        }
      }

      // === T3: Voiceover / Dubbing Track ===
      const voTop = t3.y + 3;
      const voH = Math.max(18, t3.hh - 6);
      if (this.voiceoverClips.length > 0) {
        for (const vo of this.voiceoverClips) {
          const dur = Math.max(1.5, Number(vo.duration) || 3.0);
          const x1 = this._timeToX(vo.start, w);
          const x2 = Math.max(x1 + 14, this._timeToX(vo.start + dur, w));
          const bw = x2 - x1;
          ctx.fillStyle = 'rgba(244, 63, 94, 0.52)';
          ctx.fillRect(x1, voTop, bw, voH);
          ctx.strokeStyle = '#fda4af';
          ctx.lineWidth = 1;
          ctx.strokeRect(x1 + 0.5, voTop + 0.5, Math.max(1, bw - 1), voH - 1);
          if (bw > 32) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1 + 4, voTop, bw - 8, voH);
            ctx.clip();
            ctx.fillStyle = '#fff1f2';
            ctx.font = '10.5px sans-serif';
            ctx.fillText(`🎙️ ${vo.name || 'พากย์เสียง'}`, x1 + 5, voTop + Math.round(voH * 0.65));
            ctx.restore();
          }
        }
      } else {
        ctx.fillStyle = 'rgba(251, 113, 133, 0.45)';
        ctx.font = '10.5px sans-serif';
        ctx.fillText('🎙️ Voiceover / เสียงพากย์ (อัดไมค์สดหรือนำเข้าไฟล์ในแท็บ 🎙️ พากย์เสียง • ลากย้ายตำแหน่งได้)', 48, voTop + Math.round(voH * 0.65));
      }

      // === T2: Audio Waveform Peaks ===
      const waveMid = t2.y + Math.round(t2.hh / 2);
      const waveAmp = Math.max(14, Math.round((t2.hh - 8) / 2));
      if (this.peaks.length > 0) {
        const step = w / this.peaks.length;
        ctx.fillStyle = 'rgba(129, 140, 248, 0.84)';
        for (let i = 0; i < this.peaks.length; i++) {
          const barH = Math.max(2, this.peaks[i] * waveAmp * 2);
          ctx.fillRect(i * step, waveMid - barH / 2, Math.max(1, step - 0.5), barH);
        }
      } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.beginPath();
        ctx.moveTo(0, waveMid);
        ctx.lineTo(w, waveMid);
        ctx.stroke();
      }

      // === T1: BGM Music Track + Auto Audio Ducking Visualizer ===
      const bgmTop = t1.y + 3;
      const bgmH = Math.max(16, t1.hh - 6);
      if (this.bgmInfo && this.bgmInfo.enabled && this.bgmInfo.name) {
        ctx.fillStyle = 'rgba(20, 184, 166, 0.26)';
        ctx.fillRect(2, bgmTop, w - 4, bgmH);
        ctx.strokeStyle = 'rgba(45, 212, 191, 0.55)';
        ctx.strokeRect(2.5, bgmTop + 0.5, w - 5, bgmH - 1);

        if (this.bgmInfo.auto_ducking) {
          ctx.fillStyle = 'rgba(13, 148, 136, 0.55)';
          const dipH = Math.max(6, Math.round(bgmH * 0.36));
          for (const seg of this.segments) {
            const dx1 = this._timeToX(seg.start, w);
            const dx2 = Math.max(dx1 + 3, this._timeToX(seg.end, w));
            ctx.fillRect(dx1, bgmTop + bgmH - dipH, dx2 - dx1, dipH);
          }
          for (const vo of this.voiceoverClips) {
            const dx1 = this._timeToX(vo.start, w);
            const dx2 = Math.max(dx1 + 6, this._timeToX(vo.start + (vo.duration || 3), w));
            ctx.fillRect(dx1, bgmTop + bgmH - dipH, dx2 - dx1, dipH);
          }
        }
        ctx.fillStyle = '#99f6e4';
        ctx.font = '10.5px sans-serif';
        ctx.fillText(
          `🎵 ${this.bgmInfo.name}${this.bgmInfo.auto_ducking ? ' • Auto Ducking ON' : ''}`,
          48,
          bgmTop + Math.round(bgmH * 0.64)
        );
      } else {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.38)';
        ctx.font = '10.5px sans-serif';
        ctx.fillText('🎵 BGM Track (เพิ่มเพลงพื้นหลังในแท็บ 🎚️ สี/สปีด & BGM)', 48, bgmTop + Math.round(bgmH * 0.64));
      }

      // Track badge pills on far left (with live SOLO / MUTE monitor indicators on T3/T2/T1)
      const mon = this.audioMonitor || { solo: null, mute: {} };
      for (const tr of tracks) {
        const isAudioTrack = tr.key === 't3' || tr.key === 't2' || tr.key === 't1';
        const isSolo = isAudioTrack && mon.solo === tr.key;
        const isMuted = isAudioTrack && ((mon.solo && mon.solo !== tr.key) || !!(mon.mute && mon.mute[tr.key]));
        if (isMuted) {
          ctx.fillStyle = 'rgba(2, 6, 23, 0.56)';
          ctx.fillRect(0, tr.y, w, tr.hh);
        }
        ctx.fillStyle = isSolo ? 'rgba(245, 158, 11, 0.92)' : (isMuted ? 'rgba(127, 29, 29, 0.86)' : 'rgba(2, 6, 23, 0.86)');
        const badgeW = (isSolo || isMuted) ? 56 : 40;
        ctx.fillRect(2, tr.y + 3, badgeW, 17);
        ctx.fillStyle = isSolo ? '#0f172a' : (isMuted ? '#fecaca' : '#cbd5e1');
        ctx.font = 'bold 9.5px sans-serif';
        const suffix = isSolo ? ' S' : (isMuted ? ' M' : '');
        ctx.fillText(tr.label + suffix, 5, tr.y + 15);
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
