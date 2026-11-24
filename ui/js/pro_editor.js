(() => {
  'use strict';

  const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
  const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSec(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = (s % 60).toFixed(1).padStart(4, '0');
    return `${String(m).padStart(2, '0')}:${r}`;
  }

  /**
   * Phase 2 & Phase 3 Pro Video Editor Controller (v1.4.0):
   * - Color Grading (Brightness / Contrast / Saturation + Cinema Presets)
   * - Export Video Speed (0.5x–2.0x with automatic Lip-Sync Subtitle Scaling)
   * - BGM Background Music Mixer + Live & FFmpeg Auto Audio Ducking
   * - Timed Photo B-Roll / Picture-in-Picture Overlays (with T4 Timeline + Live Monitor Preview)
   * - 1-Click Viral Thumbnail Maker (1920x1080 / 1080x1920 Thai Prompt/Kanit Typography)
   */
  class DesktopProEditor {
    constructor(host, studio) {
      this.host = host;
      this.studio = studio;

      this.colorSpeed = {
        brightness: 0.0, // -0.4..0.4
        contrast: 1.0,   // 0.5..1.8
        saturation: 1.0, // 0.0..2.0
        speed: 1.0,      // 0.5..2.0
      };

      this.bgm = {
        enabled: false,
        bgm_path: '',
        name: '',
        dialogue_volume: 1.0,
        bgm_volume: 0.30,
        auto_ducking: true,
      };

      this.brollOverlays = []; // [{ id, image_path, name, start, end, x_pct, y_pct, width_pct, opacity }]
      this.nextBrollId = 1;

      // Phase 1 v1.5.0: Voiceover / Dubbing Track (Live Mic + Multi-Clip Import + Auto-Ducking)
      this.voiceover = {
        enabled: true,
        duck_original: true,
        original_duck_level: 0.15,
        clips: [], // [{ id, path, name, start, duration, volume, audioEl }]
      };
      this.nextVoId = 1;
      this.voRecording = false;
      this.voMediaRecorder = null;
      this.voStream = null;
      this.voAudioCtx = null;
      this.voAnalyser = null;
      this.voVuRaf = null;
      this.voChunks = [];
      this.voRecStartVideoTime = 0;
      this.voRecTimer = null;
      this.voRecStartedAt = 0;

      this.thumbPreviewVisible = false;
      this.exportingThumb = false;
    }

    getRenderConfig() {
      return {
        color_speed: {
          brightness: Number(this.colorSpeed.brightness) || 0.0,
          contrast: Number(this.colorSpeed.contrast) || 1.0,
          saturation: Number(this.colorSpeed.saturation) || 1.0,
          speed: Number(this.colorSpeed.speed) || 1.0,
        },
        bgm: {
          enabled: !!this.bgm.enabled && !!this.bgm.bgm_path,
          bgm_path: this.bgm.bgm_path || '',
          dialogue_volume: Number(this.bgm.dialogue_volume) || 1.0,
          bgm_volume: Number(this.bgm.bgm_volume) || 0.30,
          auto_ducking: !!this.bgm.auto_ducking,
        },
        broll_overlays: this.brollOverlays.map((b) => ({
          image_path: b.image_path,
          start: Number(b.start) || 0,
          end: Number(b.end) || 0,
          x_pct: Number(b.x_pct) || 58,
          y_pct: Number(b.y_pct) || 8,
          width_pct: Number(b.width_pct) || 36,
          opacity: Number(b.opacity) || 1.0,
        })),
        voiceover: {
          enabled: !!this.voiceover.enabled && this.voiceover.clips.length > 0,
          duck_original: !!this.voiceover.duck_original,
          original_duck_level: Number(this.voiceover.original_duck_level),
          clips: this.voiceover.clips.map((c) => ({
            path: c.path,
            start: Number(c.start) || 0,
            volume: Number(c.volume) || 1.0,
            label: c.name || 'Voiceover',
          })),
        },
      };
    }

    getTimelineMeta() {
      return {
        brollOverlays: this.brollOverlays,
        voiceoverClips: this.voiceover.enabled ? this.voiceover.clips : [],
        bgmInfo: {
          enabled: !!this.bgm.enabled && !!this.bgm.bgm_path,
          name: this.bgm.name || '',
          auto_ducking: !!this.bgm.auto_ducking,
        },
      };
    }

    resetForNewProject() {
      this.brollOverlays = [];
      this.pauseAllVoiceoverAudios();
      this.voiceover.clips = [];
      this.thumbPreviewVisible = false;
      const thumbOv = $('studio-thumb-preview');
      if (thumbOv) thumbOv.classList.add('hidden');
      this.renderBrollList();
      this.renderVoiceoverList();
      this.applyLiveEffects();
      this.syncTimeline();
    }

    pauseAllVoiceoverAudios() {
      for (const c of this.voiceover.clips) {
        if (c.audioEl && !c.audioEl.paused) {
          try { c.audioEl.pause(); } catch (_) {}
        }
      }
    }

    _ensureVoAudioEl(clip) {
      if (!clip.audioEl && clip.path) {
        const a = new Audio(this.host.toAssetUrl(clip.path));
        a.preload = 'auto';
        clip.audioEl = a;
      }
      return clip.audioEl;
    }

    updateVoiceoverStart(idx, newStart, commit = false) {
      const clip = this.voiceover.clips[idx];
      if (!clip) return;
      clip.start = Math.max(0, Number(newStart) || 0);
      if (commit) {
        this.renderVoiceoverList();
        this.host.showToast(`🎙️ เลื่อนเสียงพากย์ "${clip.name}" ไปที่ ${fmtSec(clip.start)}`, 'info');
      }
    }

    async toggleVoiceoverRecording() {
      if (this.voRecording) {
        this.stopVoiceoverRecording();
      } else {
        await this.startVoiceoverRecording();
      }
    }

    async startVoiceoverRecording() {
      if (this.voRecording) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.host.showToast('เบราว์เซอร์/ระบบไม่รองรับการอัดเสียงจากไมโครโฟน', 'err');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.voStream = stream;
        this.voChunks = [];

        const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];
        const chosenMime = mimeCandidates.find((m) => !m || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))) || '';
        const mr = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
        this.voMediaRecorder = mr;

        const video = $('studio-video');
        this.voRecStartVideoTime = video ? Number((video.currentTime || 0).toFixed(2)) : 0;
        this.voRecStartedAt = Date.now();
        this.voRecording = true;

        mr.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) this.voChunks.push(ev.data);
        };
        mr.onstop = async () => {
          await this._finalizeVoiceoverRecording();
        };

        // Live VU Meter
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            this.voAudioCtx = new AC();
            const src = this.voAudioCtx.createMediaStreamSource(stream);
            this.voAnalyser = this.voAudioCtx.createAnalyser();
            this.voAnalyser.fftSize = 256;
            src.connect(this.voAnalyser);
            const buf = new Uint8Array(this.voAnalyser.frequencyBinCount);
            const tickVu = () => {
              if (!this.voRecording || !this.voAnalyser) return;
              this.voAnalyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              const rms = Math.sqrt(sum / buf.length);
              const pct = Math.min(100, Math.round(rms * 320));
              const fill = $('vo-vu-fill');
              if (fill) fill.style.width = `${pct}%`;
              this.voVuRaf = requestAnimationFrame(tickVu);
            };
            tickVu();
          }
        } catch (_) {}

        mr.start(250);

        // Auto-play video so narrator reads live subtitles on screen (duck video volume while recording)
        const autoPlay = $('vo-rec-autoplay')?.checked !== false;
        if (video && autoPlay) {
          video.volume = Math.min(0.25, video.volume);
          video.play().catch(() => {});
        }

        const btn = $('vo-record-btn');
        if (btn) {
          btn.classList.add('recording');
          btn.textContent = '⏹️ หยุดอัดเสียงพากย์ (00:00)';
        }
        this.voRecTimer = setInterval(() => {
          const elapsed = (Date.now() - this.voRecStartedAt) / 1000;
          if (btn && this.voRecording) {
            btn.textContent = `⏹️ หยุดอัดเสียงพากย์ (${fmtSec(elapsed)})`;
          }
        }, 250);
        this.host.showToast(`🎙️ กำลังอัดเสียงพากย์ที่ ${fmtSec(this.voRecStartVideoTime)} — พูดใส่ไมค์ได้เลย!`, 'info');
      } catch (err) {
        this.host.showToast(`ไม่สามารถเปิดไมโครโฟนได้: ${err.message || err}`, 'err');
      }
    }

    stopVoiceoverRecording() {
      if (!this.voRecording) return;
      this.voRecording = false;
      if (this.voRecTimer) { clearInterval(this.voRecTimer); this.voRecTimer = null; }
      if (this.voVuRaf) { cancelAnimationFrame(this.voVuRaf); this.voVuRaf = null; }
      if ($('vo-vu-fill')) $('vo-vu-fill').style.width = '0%';

      const video = $('studio-video');
      if (video && !video.paused) video.pause();
      if (video) video.volume = Math.min(1.0, Math.max(0.0, this.bgm.dialogue_volume));

      const btn = $('vo-record-btn');
      if (btn) {
        btn.classList.remove('recording');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังบันทึกไฟล์เสียงพากย์...';
      }

      try {
        if (this.voMediaRecorder && this.voMediaRecorder.state !== 'inactive') {
          this.voMediaRecorder.stop();
        }
      } catch (_) {}
      try {
        if (this.voStream) this.voStream.getTracks().forEach((tr) => tr.stop());
      } catch (_) {}
      try {
        if (this.voAudioCtx) this.voAudioCtx.close();
      } catch (_) {}
      this.voStream = null;
      this.voAudioCtx = null;
      this.voAnalyser = null;
    }

    async _finalizeVoiceoverRecording() {
      const btn = $('vo-record-btn');
      try {
        const blob = new Blob(this.voChunks, { type: this.voChunks[0]?.type || 'audio/webm' });
        const arrayBuf = await blob.arrayBuffer();
        const byteArr = Array.from(new Uint8Array(arrayBuf));
        const projId = (this.studio && this.studio.projectId) ? String(this.studio.projectId) : 'local';
        const clipNum = this.nextVoId;
        const res = await this.host.invokeCmd('save_voiceover_recording', {
          projectId: projId,
          filename: `dub_take_${clipNum}`,
          bytes: byteArr,
        });
        const estDur = Math.max(0.5, (Date.now() - this.voRecStartedAt) / 1000);
        const dur = (res && Number(res.duration) > 0.1) ? Number(res.duration) : estDur;
        this.voiceover.enabled = true;
        if ($('vo-enabled')) $('vo-enabled').checked = true;
        this.voiceover.clips.push({
          id: this.nextVoId++,
          path: res.path,
          name: `พากย์ไมค์ #${clipNum}`,
          start: this.voRecStartVideoTime,
          duration: Number(dur.toFixed(2)),
          volume: 1.0,
          audioEl: null,
        });
        this.renderVoiceoverList();
        this.syncTimeline();
        this.host.showToast(`🎙️ บันทึกเสียงพากย์ #${clipNum} (${dur.toFixed(1)}s) ลงแทร็ก T3 แล้ว!`, 'ok');
      } catch (err) {
        this.host.showToast(`บันทึกเสียงพากย์ไม่สำเร็จ: ${err}`, 'err');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔴 เริ่มอัดเสียงพากย์สด (ณ Playhead)';
        }
      }
    }

    async importVoiceoverFile() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'เลือกไฟล์เสียงพากย์ (MP3 / WAV / M4A)',
          filters: [{ name: 'Audio Files', extensions: AUDIO_EXTS }],
        });
        if (!sel || Array.isArray(sel)) return;

        let dur = 5.0;
        try {
          const info = await this.host.invokeCmd('probe_media_info', { videoPath: sel });
          if (info && Number(info.duration_seconds) > 0.1) dur = Number(info.duration_seconds);
        } catch (_) {}

        const video = $('studio-video');
        const start = video ? Number((video.currentTime || 0).toFixed(2)) : 0;
        this.voiceover.enabled = true;
        if ($('vo-enabled')) $('vo-enabled').checked = true;
        this.voiceover.clips.push({
          id: this.nextVoId++,
          path: sel,
          name: this.host.getFileName(sel),
          start,
          duration: Number(dur.toFixed(2)),
          volume: 1.0,
          audioEl: null,
        });
        this.renderVoiceoverList();
        this.syncTimeline();
        this.host.showToast(`🎙️ เพิ่มเสียงพากย์ "${this.host.getFileName(sel)}" ที่ ${fmtSec(start)} แล้ว`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    renderVoiceoverList() {
      const box = $('pro-vo-list');
      if (!box) return;
      if (!this.voiceover.clips.length) {
        box.innerHTML = '<div class="muted" style="font-size:11px;">ยังไม่มีเสียงพากย์ — เลื่อน Playhead ไปจุดที่ต้องการ แล้วกดอัดไมค์สด หรือนำเข้าไฟล์เสียง</div>';
        return;
      }
      box.innerHTML = this.voiceover.clips
        .map((c, i) => `
          <div class="vo-clip-row">
            <div class="vo-clip-top">
              <button type="button" class="broll-seek" data-vo-seek="${c.start}">🎙️ ${escapeHtml(c.name)}</button>
              <span class="mono-tag">${fmtSec(c.start)} (${Number(c.duration || 0).toFixed(1)}s)</span>
              <button type="button" class="btn btn-danger-ghost btn-xs" data-vo-del="${i}">✕</button>
            </div>
            <div class="vo-clip-ctrl">
              <span>เริ่ม (วิ):</span>
              <input type="number" step="0.1" min="0" value="${c.start}" data-vo-start="${i}" />
              <span>ดัง:</span>
              <input type="range" min="20" max="200" value="${Math.round((c.volume || 1) * 100)}" data-vo-vol="${i}" style="flex:1;" />
              <span>${Math.round((c.volume || 1) * 100)}%</span>
            </div>
          </div>
        `)
        .join('');
    }

    syncTimeline() {
      if (this.studio) this.studio.renderTimeline();
    }

    applyLiveEffects() {
      const video = $('studio-video');
      if (video) {
        const bPct = Math.round((1.0 + this.colorSpeed.brightness) * 100);
        const cPct = Math.round(this.colorSpeed.contrast * 100);
        const sPct = Math.round(this.colorSpeed.saturation * 100);
        video.style.filter = `brightness(${bPct}%) contrast(${cPct}%) saturate(${sPct}%)`;
        video.volume = Math.min(1.0, Math.max(0.0, this.bgm.dialogue_volume));
      }

      const bgmAudio = $('studio-bgm-audio');
      if (bgmAudio) {
        if (this.bgm.enabled && this.bgm.bgm_path) {
          const url = this.host.toAssetUrl(this.bgm.bgm_path);
          if (bgmAudio.dataset.srcPath !== this.bgm.bgm_path) {
            bgmAudio.src = url;
            bgmAudio.dataset.srcPath = this.bgm.bgm_path;
            bgmAudio.load();
          }
          bgmAudio.volume = Math.max(0, Math.min(1, this.bgm.bgm_volume));
        } else {
          bgmAudio.pause();
          bgmAudio.removeAttribute('src');
          bgmAudio.dataset.srcPath = '';
        }
      }

      this.updateThumbnailLivePreview();
    }

    onTimeUpdate(t, activeCueIdx) {
      // 1. Live Photo B-Roll Overlay preview
      const brollImg = $('studio-broll-preview');
      if (brollImg) {
        const hit = this.brollOverlays.find((b) => t >= b.start && t <= b.end);
        if (hit && hit.image_path) {
          const url = this.host.toAssetUrl(hit.image_path);
          if (brollImg.dataset.path !== hit.image_path) {
            brollImg.src = url;
            brollImg.dataset.path = hit.image_path;
          }
          brollImg.style.left = `${hit.x_pct}%`;
          brollImg.style.top = `${hit.y_pct}%`;
          brollImg.style.width = `${hit.width_pct}%`;
          brollImg.style.opacity = String(hit.opacity);
          brollImg.classList.remove('hidden');
        } else {
          brollImg.classList.add('hidden');
        }
      }

      // 2. Live Voiceover / Dubbing Playback & Original Audio Auto-Ducking
      const video = $('studio-video');
      let voSpeaking = false;
      if (this.voiceover.enabled && this.voiceover.clips.length > 0 && video) {
        for (const clip of this.voiceover.clips) {
          const end = clip.start + Math.max(0.5, Number(clip.duration) || 3.0);
          const inRange = t >= clip.start && t <= end;
          const a = this._ensureVoAudioEl(clip);
          if (!a) continue;
          if (inRange) {
            voSpeaking = true;
            a.volume = Math.max(0, Math.min(1, Number(clip.volume) || 1.0));
            const targetPos = Math.max(0, t - clip.start);
            if (!video.paused) {
              if (Math.abs((a.currentTime || 0) - targetPos) > 0.35) {
                try { a.currentTime = targetPos; } catch (_) {}
              }
              if (a.paused) a.play().catch(() => {});
            } else if (!a.paused) {
              a.pause();
            }
          } else if (!a.paused) {
            a.pause();
          }
        }
        if (!this.voRecording) {
          const baseDlg = Math.min(1.0, Math.max(0.0, this.bgm.dialogue_volume));
          if (voSpeaking && this.voiceover.duck_original) {
            video.volume = Math.max(0.0, Math.min(1.0, baseDlg * Number(this.voiceover.original_duck_level)));
          } else {
            video.volume = baseDlg;
          }
        }
      }

      // 3. Live BGM Auto-Ducking during active subtitle cues OR voiceover
      const bgmAudio = $('studio-bgm-audio');
      if (bgmAudio && this.bgm.enabled && this.bgm.bgm_path && video) {
        const baseVol = Math.max(0.02, Math.min(1.0, this.bgm.bgm_volume));
        const duckedVol = this.bgm.auto_ducking && (activeCueIdx >= 0 || voSpeaking) ? baseVol * 0.28 : baseVol;
        bgmAudio.volume = duckedVol;
        if (!video.paused && bgmAudio.paused) {
          bgmAudio.play().catch(() => {});
        } else if (video.paused && !bgmAudio.paused) {
          bgmAudio.pause();
        }
      }
    }

    applyColorPreset(preset) {
      if (preset === 'cinema') {
        this.colorSpeed.brightness = -0.04;
        this.colorSpeed.contrast = 1.16;
        this.colorSpeed.saturation = 0.92;
      } else if (preset === 'vivid') {
        this.colorSpeed.brightness = 0.04;
        this.colorSpeed.contrast = 1.12;
        this.colorSpeed.saturation = 1.32;
      } else if (preset === 'warm') {
        this.colorSpeed.brightness = 0.03;
        this.colorSpeed.contrast = 1.08;
        this.colorSpeed.saturation = 1.18;
      } else {
        this.colorSpeed.brightness = 0.0;
        this.colorSpeed.contrast = 1.0;
        this.colorSpeed.saturation = 1.0;
        this.colorSpeed.speed = 1.0;
      }
      this.syncColorInputs();
      this.applyLiveEffects();
      this.host.showToast(`🎨 ใช้พรีเซ็ตสี "${preset}" เรียบร้อย`, 'ok');
    }

    syncColorInputs() {
      const bVal = Math.round(this.colorSpeed.brightness * 100);
      const cVal = Math.round(this.colorSpeed.contrast * 100);
      const sVal = Math.round(this.colorSpeed.saturation * 100);
      if ($('pro-brightness')) $('pro-brightness').value = String(bVal);
      if ($('pro-brightness-val')) $('pro-brightness-val').textContent = `${bVal >= 0 ? '+' : ''}${bVal}%`;
      if ($('pro-contrast')) $('pro-contrast').value = String(cVal);
      if ($('pro-contrast-val')) $('pro-contrast-val').textContent = `${cVal}%`;
      if ($('pro-saturation')) $('pro-saturation').value = String(sVal);
      if ($('pro-saturation-val')) $('pro-saturation-val').textContent = `${sVal}%`;
      if ($('pro-export-speed')) $('pro-export-speed').value = String(this.colorSpeed.speed);
    }

    async pickBgmFile() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'เลือกไฟล์เพลงพื้นหลัง (BGM)',
          filters: [{ name: 'Audio Files', extensions: AUDIO_EXTS }],
        });
        if (!sel || Array.isArray(sel)) return;
        this.bgm.bgm_path = sel;
        this.bgm.name = this.host.getFileName(sel);
        this.bgm.enabled = true;
        if ($('pro-bgm-enabled')) $('pro-bgm-enabled').checked = true;
        if ($('pro-bgm-label')) $('pro-bgm-label').textContent = `🎵 ${this.bgm.name}`;
        this.applyLiveEffects();
        this.syncTimeline();
        this.host.showToast(`🎵 เพิ่มเพลงพื้นหลัง: ${this.bgm.name}`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async addBrollPhotoAtPlayhead() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'เลือกรูปภาพ B-Roll / Picture-in-Picture (PNG/JPG)',
          filters: [{ name: 'Images', extensions: IMG_EXTS }],
        });
        if (!sel || Array.isArray(sel)) return;

        const video = $('studio-video');
        const dur = this.studio ? this.studio._effectiveDuration() : 60;
        const start = Number((video ? video.currentTime || 0 : 0).toFixed(2));
        const len = Math.max(1, Number($('broll-dur-input')?.value || 5));
        const end = Number(Math.min(dur, start + len).toFixed(2));
        const pos = $('broll-pos-select')?.value || 'top-right';
        const widthPct = Number($('broll-width-input')?.value || 36);
        const opacity = Number($('broll-opacity-input')?.value || 1.0);

        let xPct = 58, yPct = 8;
        if (pos === 'top-left') { xPct = 4; yPct = 8; }
        else if (pos === 'center') { xPct = Math.round((100 - widthPct) / 2); yPct = 14; }
        else if (pos === 'full') { xPct = 0; yPct = 0; }
        else { xPct = Math.max(2, 96 - widthPct); yPct = 8; }

        this.brollOverlays.push({
          id: this.nextBrollId++,
          image_path: sel,
          name: this.host.getFileName(sel),
          start,
          end: Math.max(start + 0.5, end),
          x_pct: xPct,
          y_pct: yPct,
          width_pct: pos === 'full' ? 100 : widthPct,
          opacity,
        });
        this.renderBrollList();
        this.syncTimeline();
        this.onTimeUpdate(start, this.studio ? this.studio.activeCueIdx : -1);
        this.host.showToast(`🖼️ เพิ่มรูป B-Roll (${fmtSec(start)} – ${fmtSec(end)}) บนแทร็ก T4 แล้ว`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    renderBrollList() {
      const box = $('pro-broll-list');
      if (!box) return;
      if (!this.brollOverlays.length) {
        box.innerHTML = '<div class="muted" style="font-size:11px;">ยังไม่มีรูปภาพ B-Roll — เลื่อน Playhead แล้วกดปุ่ม “➕ แทรกรูปที่ Playhead”</div>';
        return;
      }
      box.innerHTML = this.brollOverlays
        .map((b, i) => `
          <div class="broll-row">
            <button type="button" class="broll-seek" data-broll-seek="${b.start}">🖼️ ${escapeHtml(b.name)}</button>
            <span class="mono-tag">${fmtSec(b.start)}–${fmtSec(b.end)}</span>
            <button type="button" class="btn btn-danger-ghost btn-xs" data-broll-del="${i}">✕</button>
          </div>
        `)
        .join('');
    }

    updateThumbnailLivePreview() {
      const ov = $('studio-thumb-preview');
      if (!ov) return;
      const hl = ($('thumb-headline-input')?.value || '').trim();
      const sl = ($('thumb-subline-input')?.value || '').trim();
      const color = $('thumb-color-input')?.value || '#fde047';
      const font = $('thumb-font-select')?.value || 'Prompt';

      if (!this.thumbPreviewVisible || (!hl && !sl)) {
        ov.classList.add('hidden');
        return;
      }
      ov.classList.remove('hidden');
      ov.style.fontFamily = `'${font}', 'Prompt', sans-serif`;
      const hlEl = $('studio-thumb-hl');
      const slEl = $('studio-thumb-sl');
      if (hlEl) {
        hlEl.textContent = hl;
        hlEl.style.color = color;
      }
      if (slEl) {
        slEl.textContent = sl;
        slEl.classList.toggle('hidden', !sl);
      }
    }

    async executeExportThumbnail() {
      if (this.exportingThumb) return;
      let videoPath = this.studio ? this.studio.localVideoPath : '';
      if (!videoPath) {
        videoPath = await this.host.pickLocalVideoForProject(this.studio.projectId);
        if (!videoPath) return;
        this.studio.localVideoPath = videoPath;
        this.studio.loadVideoSource();
      }
      const video = $('studio-video');
      const ts = video ? Number((video.currentTime || 0).toFixed(3)) : 2.0;

      const btn = $('btn-export-thumbnail');
      this.exportingThumb = true;
      if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังสร้างปกคลิป...'; }
      try {
        const res = await this.host.invokeCmd('export_viral_thumbnail', {
          req: {
            video_path: videoPath,
            timestamp_sec: ts,
            headline: ($('thumb-headline-input')?.value || '').trim(),
            subline: ($('thumb-subline-input')?.value || '').trim(),
            font_family: $('thumb-font-select')?.value || 'Prompt',
            headline_color: $('thumb-color-input')?.value || '#fde047',
            aspect: $('thumb-aspect-select')?.value || '16:9',
            format: $('thumb-format-select')?.value || 'jpg',
            color_speed: this.colorSpeed,
            watermark: this.studio ? this.studio.watermark : undefined,
            output_path: null,
          },
        });
        this.host.showToast(`📸 สร้างภาพปกสำเร็จ: ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.exportingThumb = false;
        if (btn) { btn.disabled = false; btn.textContent = window.DesktopI18n.t('btnExportThumb'); }
      }
    }

    bindEvents() {
      // Color Grading sliders & presets
      $('pro-brightness')?.addEventListener('input', (e) => {
        const v = Number(e.target.value) || 0;
        this.colorSpeed.brightness = v / 100.0;
        if ($('pro-brightness-val')) $('pro-brightness-val').textContent = `${v >= 0 ? '+' : ''}${v}%`;
        this.applyLiveEffects();
      });
      $('pro-contrast')?.addEventListener('input', (e) => {
        const v = Number(e.target.value) || 100;
        this.colorSpeed.contrast = v / 100.0;
        if ($('pro-contrast-val')) $('pro-contrast-val').textContent = `${v}%`;
        this.applyLiveEffects();
      });
      $('pro-saturation')?.addEventListener('input', (e) => {
        const v = Number(e.target.value) || 100;
        this.colorSpeed.saturation = v / 100.0;
        if ($('pro-saturation-val')) $('pro-saturation-val').textContent = `${v}%`;
        this.applyLiveEffects();
      });
      $('pro-export-speed')?.addEventListener('change', (e) => {
        this.colorSpeed.speed = Number(e.target.value) || 1.0;
        const video = $('studio-video');
        if (video) video.playbackRate = this.colorSpeed.speed;
        this.host.showToast(`⚡ ตั้งความเร็วส่งออก ${this.colorSpeed.speed}x (ซับไตเติลปรับเวลาตามอัตโนมัติ)`, 'info');
      });
      document.querySelectorAll('[data-color-preset]').forEach((btn) => {
        btn.addEventListener('click', () => this.applyColorPreset(btn.dataset.colorPreset));
      });

      // BGM Mixer & Auto Audio Ducking
      $('pro-bgm-pick-btn')?.addEventListener('click', () => this.pickBgmFile());
      $('pro-bgm-clear-btn')?.addEventListener('click', () => {
        this.bgm.enabled = false;
        this.bgm.bgm_path = '';
        this.bgm.name = '';
        if ($('pro-bgm-enabled')) $('pro-bgm-enabled').checked = false;
        if ($('pro-bgm-label')) $('pro-bgm-label').textContent = 'ยังไม่ได้เลือกเพลง BGM';
        this.applyLiveEffects();
        this.syncTimeline();
      });
      $('pro-bgm-enabled')?.addEventListener('change', (e) => {
        this.bgm.enabled = e.target.checked;
        this.applyLiveEffects();
        this.syncTimeline();
      });
      $('pro-bgm-ducking')?.addEventListener('change', (e) => {
        this.bgm.auto_ducking = e.target.checked;
        this.syncTimeline();
      });
      $('pro-dlg-vol')?.addEventListener('input', (e) => {
        const v = Number(e.target.value) || 100;
        this.bgm.dialogue_volume = v / 100.0;
        if ($('pro-dlg-vol-val')) $('pro-dlg-vol-val').textContent = `${v}%`;
        this.applyLiveEffects();
      });
      $('pro-bgm-vol')?.addEventListener('input', (e) => {
        const v = Number(e.target.value) || 30;
        this.bgm.bgm_volume = v / 100.0;
        if ($('pro-bgm-vol-val')) $('pro-bgm-vol-val').textContent = `${v}%`;
        this.applyLiveEffects();
      });

      // Keep BGM & Voiceover <audio> synced with video pause/play
      const video = $('studio-video');
      if (video) {
        video.addEventListener('pause', () => {
          const bgmA = $('studio-bgm-audio');
          if (bgmA) bgmA.pause();
          this.pauseAllVoiceoverAudios();
        });
        video.addEventListener('play', () => {
          const bgmA = $('studio-bgm-audio');
          if (bgmA && this.bgm.enabled && this.bgm.bgm_path) bgmA.play().catch(() => {});
        });
      }

      // Voiceover / Dubbing controls (v1.5.0)
      $('vo-record-btn')?.addEventListener('click', () => this.toggleVoiceoverRecording());
      $('vo-import-btn')?.addEventListener('click', () => this.importVoiceoverFile());
      $('vo-enabled')?.addEventListener('change', (e) => {
        this.voiceover.enabled = e.target.checked;
        if (!this.voiceover.enabled) this.pauseAllVoiceoverAudios();
        this.syncTimeline();
      });
      $('vo-duck-orig')?.addEventListener('change', (e) => {
        this.voiceover.duck_original = e.target.checked;
      });
      $('vo-duck-level')?.addEventListener('input', (e) => {
        const pct = Number(e.target.value) || 0;
        this.voiceover.original_duck_level = pct / 100.0;
        if ($('vo-duck-level-val')) $('vo-duck-level-val').textContent = pct === 0 ? '0% (ปิดเสียงเดิม)' : `${pct}%`;
      });
      $('pro-vo-list')?.addEventListener('click', (e) => {
        const seek = e.target.closest('[data-vo-seek]');
        if (seek && video) {
          video.currentTime = Number(seek.dataset.voSeek) || 0;
          return;
        }
        const del = e.target.closest('[data-vo-del]');
        if (del) {
          const idx = Number(del.dataset.voDel);
          const rm = this.voiceover.clips[idx];
          if (rm && rm.audioEl) { try { rm.audioEl.pause(); } catch (_) {} }
          this.voiceover.clips.splice(idx, 1);
          this.renderVoiceoverList();
          this.syncTimeline();
        }
      });
      $('pro-vo-list')?.addEventListener('input', (e) => {
        if (e.target.dataset.voStart !== undefined) {
          const idx = Number(e.target.dataset.voStart);
          if (this.voiceover.clips[idx]) {
            this.voiceover.clips[idx].start = Math.max(0, Number(e.target.value) || 0);
            this.syncTimeline();
          }
        } else if (e.target.dataset.voVol !== undefined) {
          const idx = Number(e.target.dataset.voVol);
          const pct = Number(e.target.value) || 100;
          if (this.voiceover.clips[idx]) {
            this.voiceover.clips[idx].volume = pct / 100.0;
            const span = e.target.nextElementSibling;
            if (span) span.textContent = `${pct}%`;
          }
        }
      });

      // Photo B-Roll controls
      $('btn-add-broll')?.addEventListener('click', () => this.addBrollPhotoAtPlayhead());
      $('pro-broll-list')?.addEventListener('click', (e) => {
        const seek = e.target.closest('[data-broll-seek]');
        if (seek) {
          if (video) video.currentTime = Number(seek.dataset.brollSeek) || 0;
          return;
        }
        const del = e.target.closest('[data-broll-del]');
        if (del) {
          this.brollOverlays.splice(Number(del.dataset.brollDel), 1);
          this.renderBrollList();
          this.syncTimeline();
          this.onTimeUpdate(video ? video.currentTime || 0 : 0, -1);
        }
      });

      // Viral Thumbnail Maker controls
      ['thumb-headline-input', 'thumb-subline-input', 'thumb-color-input', 'thumb-font-select'].forEach((id) => {
        $(id)?.addEventListener('input', () => {
          this.thumbPreviewVisible = true;
          this.updateThumbnailLivePreview();
        });
      });
      $('btn-toggle-thumb-preview')?.addEventListener('click', () => {
        this.thumbPreviewVisible = !this.thumbPreviewVisible;
        this.updateThumbnailLivePreview();
      });
      $('btn-export-thumbnail')?.addEventListener('click', () => this.executeExportThumbnail());

      this.syncColorInputs();
      this.renderBrollList();
      this.renderVoiceoverList();
    }
  }

  window.DesktopProEditor = DesktopProEditor;
})();
