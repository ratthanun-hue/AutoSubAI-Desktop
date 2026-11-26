(() => {
  'use strict';

  const DEFAULT_STYLE = {
    font_family: 'Prompt',
    font_size: 24,
    font_weight: 700,
    font_color: '#ffffff',
    bg_color: '#000000',
    bg_opacity: 0.72,
    stroke_color: '#000000',
    stroke_width: 2,
    shadow_depth: 2,
    align: 'center',
    pos_y: 86,
    bilingual_enabled: false,
    secondary_color: '#fde047',
    secondary_scale: 0.78,
    karaoke_enabled: false,
    karaoke_highlight_color: '#fde047',
  };

  const STYLE_PRESETS = {
    clean: {
      font_family: 'Prompt',
      font_size: 26,
      font_weight: 600,
      font_color: '#ffffff',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_color: '#000000',
      stroke_width: 2,
      shadow_depth: 2,
      align: 'center',
      pos_y: 86,
    },
    bold: {
      font_family: 'Kanit',
      font_size: 32,
      font_weight: 800,
      font_color: '#ffffff',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_color: '#000000',
      stroke_width: 4,
      shadow_depth: 3,
      align: 'center',
      pos_y: 82,
    },
    yellow: {
      font_family: 'Kanit',
      font_size: 34,
      font_weight: 800,
      font_color: '#fde047',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_color: '#000000',
      stroke_width: 4,
      shadow_depth: 3,
      align: 'center',
      pos_y: 76,
    },
    cinema: {
      font_family: 'Sarabun',
      font_size: 24,
      font_weight: 600,
      font_color: '#f8fafc',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_color: '#000000',
      stroke_width: 1.5,
      shadow_depth: 3,
      align: 'center',
      pos_y: 88,
    },
    minimal: {
      font_family: 'Prompt',
      font_size: 22,
      font_weight: 600,
      font_color: '#f8fafc',
      bg_color: '#0f172a',
      bg_opacity: 0.68,
      stroke_color: '#000000',
      stroke_width: 0,
      shadow_depth: 1,
      align: 'center',
      pos_y: 86,
    },
    // Backwards-compatible preset aliases
    tv: {
      font_family: 'Prompt',
      font_size: 24,
      font_weight: 700,
      font_color: '#ffffff',
      bg_color: '#000000',
      bg_opacity: 0.75,
      stroke_color: '#000000',
      stroke_width: 2,
      shadow_depth: 2,
      align: 'center',
      pos_y: 86,
    },
    tiktok: {
      font_family: 'Kanit',
      font_size: 32,
      font_weight: 800,
      font_color: '#fde047',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_color: '#000000',
      stroke_width: 4,
      shadow_depth: 3,
      align: 'center',
      pos_y: 74,
    },
  };

  function wrapThaiSmartText(text, maxChars) {
    const raw = String(text || '').replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!raw || raw.length <= maxChars) return raw;
    let tokens = [];
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const seg = new Intl.Segmenter('th', { granularity: 'word' });
        for (const item of seg.segment(raw)) {
          if (item.segment) tokens.push(item.segment);
        }
      }
    } catch (_) {}
    if (!tokens.length) tokens = raw.match(/\S+\s*/g) || [raw];

    // Prefer a balanced 2-line split when text fits <= 2.1x maxChars
    if (raw.length <= Math.round(maxChars * 2.1)) {
      const target = raw.length / 2;
      let acc = 0;
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < tokens.length - 1; i++) {
        acc += tokens[i].length;
        const leftLen = acc;
        const rightLen = raw.length - acc;
        if (leftLen <= maxChars + 4 && rightLen <= maxChars + 4) {
          const dist = Math.abs(leftLen - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i + 1;
          }
        }
      }
      if (bestIdx > 0) {
        const l1 = tokens.slice(0, bestIdx).join('').trim();
        const l2 = tokens.slice(bestIdx).join('').trim();
        if (l1 && l2) return `${l1}\n${l2}`;
      }
    }

    // Greedy word-boundary wrap for longer cues
    const lines = [];
    let cur = '';
    for (const tok of tokens) {
      if (cur && (cur.length + tok.length) > maxChars) {
        lines.push(cur.trim());
        cur = tok.trimStart();
      } else {
        cur += tok;
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.join('\n');
  }

  const DEFAULT_DELOGO = {
    enabled: false,
    mode: 'blur',
    y_pct: 82,
    height_pct: 14,
    blur_strength: 12,
    box_color: '#000000',
    box_opacity: 0.85,
  };

  const DEFAULT_WATERMARK = {
    enabled: false,
    image_path: '',
    position: 'top-right',
    width_pct: 12,
    opacity: 0.85,
  };

  const $ = (id) => document.getElementById(id);

  function hexToRgba(hex, alpha) {
    const clean = String(hex || '#000000').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function secToSrtTs(sec) {
    const safe = Math.max(0, Number(sec) || 0);
    const totalMs = Math.round(safe * 1000);
    const ms = totalMs % 1000;
    const totalS = Math.floor(totalMs / 1000);
    const s = totalS % 60;
    const totalM = Math.floor(totalS / 60);
    const m = totalM % 60;
    const h = Math.floor(totalM / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  function parseTsToSec(str) {
    const clean = String(str || '').trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length !== 3) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if ([h, m, s].some((n) => !Number.isFinite(n) || n < 0)) return null;
    return h * 3600 + m * 60 + s;
  }

  function buildSrtFromSegments(segs, bilingual) {
    return segs
      .map((seg, i) => {
        const p = (seg.text || '').trim();
        const s = (seg.secondary_text || '').trim();
        const body = bilingual && s ? (p ? `${p}\n${s}` : s) : p;
        return `${i + 1}\n${secToSrtTs(seg.start)} --> ${secToSrtTs(seg.end)}\n${body}\n`;
      })
      .join('\n');
  }

  function buildVttFromSegments(segs, bilingual) {
    return 'WEBVTT\n\n' + segs
      .map((seg) => {
        const p = (seg.text || '').trim();
        const s = (seg.secondary_text || '').trim();
        const body = bilingual && s ? (p ? `${p}\n${s}` : s) : p;
        return `${secToSrtTs(seg.start).replace(',', '.')} --> ${secToSrtTs(seg.end).replace(',', '.')}\n${body}\n`;
      })
      .join('\n');
  }

  function buildTxtFromSegments(segs, bilingual) {
    return segs
      .map((seg) => {
        const p = (seg.text || '').trim();
        const s = (seg.secondary_text || '').trim();
        return bilingual && s ? `${p} | ${s}` : p;
      })
      .filter(Boolean)
      .join('\n');
  }

  class DesktopSubtitleStudio {
    constructor(host) {
      this.host = host;
      this.sourceType = 'cloud';
      $('studio-offline-upsell-bar')?.classList.add('hidden'); // 'local' | 'cloud'
      this.projectId = '';
      this.filename = '';
      this.language = 'th';
      this.localVideoPath = '';
      this.cloudMediaUrl = '';
      this.durationSeconds = 0;
      this.segments = []; // [{ start, end, text, secondary_text }]
      this.dirty = false;
      this.activeCueIdx = -1;
      this.loopCue = false;
      this.filterQuery = '';
      this.cumulativeOffset = 0;
      this.aspectRatio = '16:9';
      this.safeZone = 'off';
      this.rendering = false;
      this.draftTimer = null;

      this.style = this._loadStored('autosub_studio_style', DEFAULT_STYLE);
      this.delogo = this._loadStored('autosub_studio_delogo', DEFAULT_DELOGO);
      this.watermark = this._loadStored('autosub_studio_watermark', DEFAULT_WATERMARK);
      this.branding = this._loadStored('autosub_studio_branding', { intro_path: '', outro_path: '' });

      // Milestone 2 (v0.5.0): Waveform, Trim/Multi-Cut & Series Glossary
      this.waveform = null;
      this.waveformPeaks = [];
      this.inPoint = null;
      this.outPoint = null;
      this.cutZones = []; // [{ start, end }]
      this.glossary = new window.DesktopGlossaryManager();
    }

    _loadStored(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
      } catch (_) {
        return { ...fallback };
      }
    }

    _persistConfigs() {
      try {
        localStorage.setItem('autosub_studio_style', JSON.stringify(this.style));
        localStorage.setItem('autosub_studio_delogo', JSON.stringify(this.delogo));
        localStorage.setItem('autosub_studio_watermark', JSON.stringify(this.watermark));
        localStorage.setItem('autosub_studio_branding', JSON.stringify(this.branding));
      } catch (_) {}
    }

    bindEvents() {
      $('studio-go-projects-btn').addEventListener('click', () => this.host.switchTab('local'));
      $('studio-back-btn').addEventListener('click', () => this.host.switchTab(this.sourceType === 'local' ? 'local' : 'projects'));
      $('studio-save-btn').addEventListener('click', () => this.save());
      $('studio-cloud-ai-btn')?.addEventListener('click', () => {
        if (this.sourceType === 'local' && this.host.openCloudAiForLocalProject) {
          this.host.openCloudAiForLocalProject(this.projectId);
        }
      });
      $('studio-import-sub-btn').addEventListener('click', () => this.importLocalSubtitleFile());
      $('studio-export-srt-btn').addEventListener('click', () => this.exportSubtitle('srt'));
      $('studio-export-vtt-btn').addEventListener('click', () => this.exportSubtitle('vtt'));
      $('studio-export-ass-btn').addEventListener('click', () => this.exportSubtitle('ass'));
      $('studio-export-txt-btn').addEventListener('click', () => this.exportSubtitle('txt'));
      $('studio-open-export-btn').addEventListener('click', () => this.openExportModal());
      $('studio-audit-btn').addEventListener('click', () => this.openQualityAuditModal());
      $('studio-summary-btn').addEventListener('click', () => this.openAiSummaryModal());
      $('studio-translate-btn').addEventListener('click', () => this.translateSegments());

      $('studio-restore-draft-btn').addEventListener('click', () => this.restoreDraft());
      $('studio-discard-draft-btn').addEventListener('click', () => this.discardDraft(true));

      $('studio-link-local-btn').addEventListener('click', async () => {
        if (!this.projectId) return;
        const picked = await this.host.pickLocalVideoForProject(this.projectId);
        if (picked) {
          this.localVideoPath = picked;
          this.loadVideoSource();
        }
      });

      // Video events
      const video = $('studio-video');
      video.addEventListener('timeupdate', () => this.onTimeUpdate());
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          this.durationSeconds = video.duration;
          this.renderTimeline();
        }
        if (this.waveform && video.currentSrc && video.videoWidth > 0 && video.videoHeight > 0) {
          this.waveform.extractFilmstripFromUrl(video.currentSrc, video.duration);
        } else if (this.waveform) {
          this.waveform.clearFilmstrip();
        }
      });

      // Transport
      $('studio-play-toggle-btn').addEventListener('click', () => this.togglePlay());
      $('studio-skip-back-btn').addEventListener('click', () => this.skip(-3));
      $('studio-skip-fwd-btn').addEventListener('click', () => this.skip(3));
      $('studio-loop-btn').addEventListener('click', () => {
        this.loopCue = !this.loopCue;
        $('studio-loop-btn').classList.toggle('btn-primary', this.loopCue);
        $('studio-loop-btn').classList.toggle('btn-ghost', !this.loopCue);
        this.host.showToast(this.loopCue ? '🔁 เปิดวนซ้ำท่อนปัจจุบัน' : 'ปิดโหมดวนซ้ำ');
      });
      $('studio-speed-select').addEventListener('change', (e) => {
        video.playbackRate = Number(e.target.value) || 1.0;
      });

      // Aspect ratio & Safe zone
      document.querySelectorAll('button[data-ar]').forEach((btn) => {
        btn.addEventListener('click', () => this.setAspectRatio(btn.dataset.ar));
      });
      document.querySelectorAll('button[data-sz]').forEach((btn) => {
        btn.addEventListener('click', () => this.setSafeZone(btn.dataset.sz));
      });

      // Interactive 5-Track Resizable Visual Timeline
      this.waveform = new window.DesktopWaveformTimeline(
        $('studio-waveform-canvas'),
        $('studio-waveform-wrap'),
        {
          onSeek: (t) => {
            video.currentTime = t;
          },
          onCueDragged: (_idx, finished) => {
            this._markDirty();
            if (finished) {
              this.renderSegments();
            }
          },
          onVoiceoverDragged: (voIdx, newStart, finished) => {
            if (this.host.onVoiceoverDragged) this.host.onVoiceoverDragged(voIdx, newStart, finished);
          },
        }
      );

      // Draggable Timeline Height Resizer + 1-Click Expand Toggle (v1.5.0)
      const resizer = $('timeline-resizer');
      if (resizer && this.waveform) {
        let resizing = false;
        let startY = 0;
        let startH = this.waveform.height;
        resizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          resizing = true;
          startY = e.clientY;
          startH = this.waveform.height;
          resizer.classList.add('dragging');
        });
        window.addEventListener('mousemove', (e) => {
          if (!resizing) return;
          const delta = startY - e.clientY;
          this.waveform.setHeight(startH + delta, false);
        });
        window.addEventListener('mouseup', () => {
          if (!resizing) return;
          resizing = false;
          resizer.classList.remove('dragging');
          this.waveform.setHeight(this.waveform.height, true);
        });
      }
      const filmBtn = $('wf-filmstrip-btn');
      if (filmBtn && this.waveform) {
        filmBtn.classList.toggle('active', !!this.waveform.filmstripEnabled);
        filmBtn.addEventListener('click', () => {
          const on = this.waveform.setFilmstripEnabled(!this.waveform.filmstripEnabled, true);
          filmBtn.classList.toggle('active', on);
          if (on && video.currentSrc && video.videoWidth > 0) {
            this.waveform.extractFilmstripFromUrl(video.currentSrc, video.duration);
          }
          this.host.showToast(
            on ? '🎞️ เปิดแถบภาพ Snapshot บนแทร็ก T2 แล้ว' : '🌊 ปิดแถบภาพ Snapshot (ขยายคลื่นเสียงเต็มแทร็ก T2)',
            'info'
          );
        });
      }

      $('wf-expand-btn')?.addEventListener('click', () => {
        if (!this.waveform) return;
        const h = this.waveform.toggleExpand();
        this.host.showToast(`📐 ปรับความสูงไทม์ไลน์เป็น ${h}px`, 'info');
      });

      document.querySelectorAll('button[data-wf-zoom]').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('button[data-wf-zoom]').forEach((b) => b.classList.toggle('active', b === btn));
          if (this.waveform) this.waveform.setZoom(Number(btn.dataset.wfZoom) || 1);
        });
      });

      $('wf-set-in-btn').addEventListener('click', () => this.setInPoint());
      $('wf-set-out-btn').addEventListener('click', () => this.setOutPoint());
      $('wf-cut-zone-btn').addEventListener('click', () => this.addCutZoneFromInOut());
      $('wf-clear-cuts-btn').addEventListener('click', () => this.clearCutMarkers());
      $('btn-render-cut').addEventListener('click', () => this.executeTrimCutRender());
      $('btn-render-shorts').addEventListener('click', () => this.executeViralShortsRender());

      // Series Glossary controls
      $('glossary-series-select').addEventListener('change', (e) => {
        this.glossary.setActiveSeries(e.target.value);
        this.renderGlossaryUI();
      });
      $('glossary-create-series-btn').addEventListener('click', () => {
        const name = $('glossary-new-series-input').value.trim();
        if (!name) return;
        this.glossary.createSeries(name);
        $('glossary-new-series-input').value = '';
        this.renderGlossaryUI();
        this.host.showToast(`สร้างคลังเรื่อง "${name}" แล้ว`, 'ok');
      });
      $('glossary-add-rule-btn').addEventListener('click', () => {
        const w = $('glossary-wrong-input').value.trim();
        const r = $('glossary-right-input').value.trim();
        if (!w || !r) return;
        this.glossary.addRule(w, r);
        $('glossary-wrong-input').value = '';
        $('glossary-right-input').value = '';
        this.renderGlossaryUI();
      });
      $('glossary-rules-list').addEventListener('click', (e) => {
        const del = e.target.closest('button[data-gloss-del]');
        if (!del) return;
        this.glossary.removeRule(Number(del.dataset.glossDel));
        this.renderGlossaryUI();
      });
      $('glossary-apply-btn').addEventListener('click', () => {
        if (!this.segments.length) return;
        const count = this.glossary.applyToSegments(this.segments);
        if (count > 0) {
          this._markDirty();
          this.renderSegments();
          this.host.showToast(`✨ แก้คำผิด/ชื่อตัวละครตามคลัง "${this.glossary.activeSeries}" สำเร็จ ${count} จุด!`, 'ok');
        } else {
          this.host.showToast('ไม่พบคำที่ตรงกับกฎในคลังตัวละครเรื่องนี้');
        }
      });

      // 9-Tab Pro Inspector Switcher
      document.querySelectorAll('.insp-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.inspTab;
          document.querySelectorAll('.insp-tab').forEach((t) => t.classList.toggle('active', t === tab));
          ['style', 'delogo', 'watermark', 'bilingual', 'cutshorts', 'colorbgm', 'voiceover', 'brollthumb', 'glossary'].forEach((k) => {
            const pane = $(`insp-pane-${k}`);
            if (pane) pane.classList.toggle('hidden', k !== target);
          });
        });
      });

      // Easy Mode <-> Pro NLE Mode Switch
      document.querySelectorAll('button[data-studio-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.setStudioMode(btn.dataset.studioMode, true);
        });
      });
      let savedStudioMode = 'pro';
      try {
        const sm = localStorage.getItem('autosub_studio_mode');
        if (sm === 'easy' || sm === 'pro') savedStudioMode = sm;
      } catch (_) {}
      this.setStudioMode(savedStudioMode, false);

      // Style Presets (5 Visual "Aa" Cards)
      document.querySelectorAll('button[data-style-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.stylePreset;
          const p = STYLE_PRESETS[key];
          if (!p) return;
          this.style = { ...this.style, ...p };
          document.querySelectorAll('button[data-style-preset]').forEach((b) => b.classList.toggle('active', b === btn));
          this._syncInspectorInputs();
          this._persistConfigs();
          this.applyLivePreviews();
          const lbl = btn.querySelector('.aa-lbl')?.textContent || btn.textContent.trim();
          this.host.showToast(`ใช้สไตล์ซับ "${lbl}" แล้ว`, 'ok');
        });
      });

      // Thai Smart Line Break 1-Click Button
      $('insp-apply-linebreak-btn')?.addEventListener('click', () => {
        const maxCh = Number($('insp-linebreak-mode')?.value) || 38;
        this.applyThaiSmartLineBreak(maxCh);
      });

      // Style Inspector inputs
      const onStyleInput = () => {
        this.style.font_family = $('insp-font-family').value;
        this.style.font_size = Number($('insp-font-size').value) || 24;
        this.style.font_weight = Number($('insp-font-weight').value) || 700;
        this.style.font_color = $('insp-font-color').value;
        this.style.bg_color = $('insp-bg-color').value;
        this.style.bg_opacity = Number($('insp-bg-opacity').value);
        this.style.stroke_color = $('insp-stroke-color').value;
        this.style.stroke_width = Number($('insp-stroke-width').value) || 0;
        if ($('insp-shadow-depth')) {
          this.style.shadow_depth = Number($('insp-shadow-depth').value) || 0;
          if ($('insp-shadow-depth-val')) $('insp-shadow-depth-val').textContent = String(this.style.shadow_depth);
        }
        this.style.pos_y = Number($('insp-pos-y').value) || 86;
        this.style.karaoke_enabled = $('insp-karaoke-enabled').checked;
        this.style.karaoke_highlight_color = $('insp-karaoke-color').value;
        $('insp-font-color-hex').textContent = this.style.font_color;
        $('insp-bg-opacity-val').textContent = `${Math.round(this.style.bg_opacity * 100)}%`;
        $('insp-pos-y-val').textContent = `${this.style.pos_y}%`;
        $('insp-karaoke-color-hex').textContent = this.style.karaoke_highlight_color;
        this._persistConfigs();
        this.applyLivePreviews();
      };
      ['insp-font-family', 'insp-font-size', 'insp-font-weight', 'insp-font-color', 'insp-bg-color', 'insp-bg-opacity', 'insp-stroke-color', 'insp-stroke-width', 'insp-shadow-depth', 'insp-pos-y', 'insp-karaoke-enabled', 'insp-karaoke-color'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.addEventListener('input', onStyleInput);
        el.addEventListener('change', onStyleInput);
      });
      document.querySelectorAll('button[data-align]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.style.align = btn.dataset.align;
          document.querySelectorAll('button[data-align]').forEach((b) => b.classList.toggle('active', b === btn));
          this._persistConfigs();
          this.applyLivePreviews();
        });
      });

      // Delogo / Blur Bar inputs
      const onDelogoInput = () => {
        this.delogo.enabled = $('delogo-enabled').checked;
        this.delogo.mode = $('delogo-mode').value;
        this.delogo.blur_strength = Number($('delogo-strength').value) || 12;
        this.delogo.y_pct = Number($('delogo-y').value);
        this.delogo.height_pct = Number($('delogo-h').value);
        this.delogo.box_color = $('delogo-color').value;
        this.delogo.box_opacity = Number($('delogo-opacity').value);
        $('delogo-strength-val').textContent = String(this.delogo.blur_strength);
        $('delogo-y-val').textContent = `${this.delogo.y_pct}%`;
        $('delogo-h-val').textContent = `${this.delogo.height_pct}%`;
        $('delogo-opacity-val').textContent = `${Math.round(this.delogo.box_opacity * 100)}%`;
        this._persistConfigs();
        this.applyLivePreviews();
      };
      ['delogo-enabled', 'delogo-mode', 'delogo-strength', 'delogo-y', 'delogo-h', 'delogo-color', 'delogo-opacity'].forEach((id) => {
        $(id).addEventListener('input', onDelogoInput);
        $(id).addEventListener('change', onDelogoInput);
      });

      // Watermark inputs
      const onWmInput = () => {
        this.watermark.enabled = $('wm-enabled').checked;
        this.watermark.position = $('wm-pos').value;
        this.watermark.width_pct = Number($('wm-width').value) || 12;
        this.watermark.opacity = Number($('wm-opacity').value);
        $('wm-width-val').textContent = `${this.watermark.width_pct}%`;
        $('wm-opacity-val').textContent = `${Math.round(this.watermark.opacity * 100)}%`;
        this._persistConfigs();
        this.applyLivePreviews();
      };
      ['wm-enabled', 'wm-pos', 'wm-width', 'wm-opacity'].forEach((id) => {
        $(id).addEventListener('input', onWmInput);
        $(id).addEventListener('change', onWmInput);
      });
      $('wm-pick-btn').addEventListener('click', async () => {
        const tauri = window.__TAURI__;
        if (!tauri || !tauri.dialog) return;
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'Select Watermark PNG / Image',
          filters: [{ name: 'Image (PNG/WEBP/JPG)', extensions: ['png', 'webp', 'jpg', 'jpeg'] }],
        });
        if (!sel || Array.isArray(sel)) return;
        this.watermark.image_path = sel;
        this.watermark.enabled = true;
        this._syncInspectorInputs();
        this._persistConfigs();
        this.applyLivePreviews();
        this.host.showToast(`โหลดโลโก้ช่อง: ${this.host.getFileName(sel)}`, 'ok');
      });

      // Intro / Outro Stitch Pickers
      const pickBumper = async (kind) => {
        const tauri = window.__TAURI__;
        if (!tauri || !tauri.dialog) return;
        const sel = await tauri.dialog.open({
          multiple: false,
          title: `Select Channel ${kind.toUpperCase()} Video`,
          filters: [{ name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
        });
        if (!sel || Array.isArray(sel)) return;
        this.branding[`${kind}_path`] = sel;
        this._syncInspectorInputs();
        this._persistConfigs();
        this.host.showToast(`ตั้งค่า ${kind.toUpperCase()}: ${this.host.getFileName(sel)}`, 'ok');
      };
      $('btn-pick-intro').addEventListener('click', () => pickBumper('intro'));
      $('btn-pick-outro').addEventListener('click', () => pickBumper('outro'));
      $('btn-clear-intro').addEventListener('click', () => {
        this.branding.intro_path = '';
        this._syncInspectorInputs();
        this._persistConfigs();
      });
      $('btn-clear-outro').addEventListener('click', () => {
        this.branding.outro_path = '';
        this._syncInspectorInputs();
        this._persistConfigs();
      });

      // Bilingual inputs
      const onBiInput = () => {
        const prevBi = this.style.bilingual_enabled;
        this.style.bilingual_enabled = $('bi-enabled').checked;
        this.style.secondary_color = $('bi-color').value;
        this.style.secondary_scale = (Number($('bi-scale').value) || 78) / 100.0;
        $('bi-color-hex').textContent = this.style.secondary_color;
        $('bi-scale-val').textContent = `${Math.round(this.style.secondary_scale * 100)}%`;
        this._persistConfigs();
        this.applyLivePreviews();
        if (prevBi !== this.style.bilingual_enabled) {
          this.renderSegments();
        }
      };
      ['bi-enabled', 'bi-color', 'bi-scale'].forEach((id) => {
        $(id).addEventListener('input', onBiInput);
        $(id).addEventListener('change', onBiInput);
      });

      // Filter, Find/Replace, Offset, Add Cue
      $('studio-filter-input').addEventListener('input', (e) => {
        this.filterQuery = e.target.value.trim().toLowerCase();
        this.renderSegments();
      });

      $('studio-replace-all-btn').addEventListener('click', () => {
        const find = $('studio-find-input').value;
        const rep = $('studio-replace-input').value;
        if (!find) return;
        let count = 0;
        this.segments.forEach((seg) => {
          if (seg.text.includes(find)) {
            const p = seg.text.split(find);
            count += p.length - 1;
            seg.text = p.join(rep);
          }
        });
        if (count > 0) {
          this._markDirty();
          this.renderSegments();
          this.host.showToast(`แทนที่ "${find}" → "${rep}" (${count} จุด)`, 'ok');
        } else {
          this.host.showToast(`ไม่พบคำว่า "${find}"`);
        }
      });

      document.querySelectorAll('button[data-offset]').forEach((btn) => {
        btn.addEventListener('click', () => this.shiftAll(Number(btn.dataset.offset) || 0));
      });
      $('studio-reset-offset-btn').addEventListener('click', () => {
        if (Math.abs(this.cumulativeOffset) < 0.001) return;
        this.shiftAll(-this.cumulativeOffset, true);
      });

      $('studio-add-cue-btn').addEventListener('click', () => {
        const last = this.segments[this.segments.length - 1];
        const start = last ? Number((last.end + 0.2).toFixed(3)) : 0;
        this.segments.push({ start, end: start + 3.0, text: '', secondary_text: '' });
        this._markDirty();
        this.renderSegments();
        this.renderTimeline();
      });

      // Delegated Cue List Events
      const segList = $('studio-segments-list');
      segList.addEventListener('input', (e) => {
        const el = e.target;
        const idx = Number(el.dataset.segIdx);
        const field = el.dataset.field;
        if (!Number.isInteger(idx) || !this.segments[idx]) return;
        if (field === 'text' || field === 'secondary_text') {
          this.segments[idx][field] = el.value;
          this._markDirty();
          this.onTimeUpdate();
        }
      });

      segList.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter' && e.target.dataset.field === 'text') {
          e.preventDefault();
          const idx = Number(e.target.dataset.segIdx);
          this.splitCue(idx, e.target.selectionStart);
        }
      });

      segList.addEventListener('change', (e) => {
        const el = e.target;
        const idx = Number(el.dataset.segIdx);
        const field = el.dataset.field;
        if (!Number.isInteger(idx) || !this.segments[idx]) return;
        if (field === 'start' || field === 'end') {
          const parsed = parseTsToSec(el.value);
          if (parsed != null) {
            this.segments[idx][field] = parsed;
            this._markDirty();
            this.renderTimeline();
          } else {
            el.value = secToSrtTs(this.segments[idx][field]);
          }
        }
      });

      segList.addEventListener('click', (e) => {
        const nudge = e.target.closest('button[data-nudge]');
        if (nudge) {
          const idx = Number(nudge.dataset.segIdx);
          const field = nudge.dataset.field;
          const delta = Number(nudge.dataset.nudge);
          if (this.segments[idx]) {
            this.segments[idx][field] = Math.max(0, Number((this.segments[idx][field] + delta).toFixed(3)));
            if (this.segments[idx].end < this.segments[idx].start + 0.1) {
              this.segments[idx].end = Number((this.segments[idx].start + 0.1).toFixed(3));
            }
            this._markDirty();
            this.renderSegments();
            this.renderTimeline();
          }
          return;
        }

        const btn = e.target.closest('button[data-seg-action]');
        if (!btn) return;
        const action = btn.dataset.segAction;
        const idx = Number(btn.dataset.segIdx);
        if (!this.segments[idx]) return;

        if (action === 'seek') {
          video.currentTime = this.segments[idx].start;
          video.play().catch(() => {});
        } else if (action === 'split') {
          this.splitCue(idx);
        } else if (action === 'merge') {
          this.mergeCueWithNext(idx);
        } else if (action === 'insert') {
          const cur = this.segments[idx];
          const next = this.segments[idx + 1];
          const newEnd = next ? Math.min(next.start, cur.end + 2.5) : cur.end + 2.5;
          this.segments.splice(idx + 1, 0, {
            start: cur.end,
            end: Math.max(cur.end + 0.5, newEnd),
            text: '',
            secondary_text: '',
          });
          this._markDirty();
          this.renderSegments();
          this.renderTimeline();
        } else if (action === 'delete') {
          this.segments.splice(idx, 1);
          this._markDirty();
          this.renderSegments();
          this.renderTimeline();
        }
      });

      // Modals Close & Export
      document.querySelectorAll('[data-close-modal]').forEach((btn) => {
        btn.addEventListener('click', () => $(btn.dataset.closeModal).classList.add('hidden'));
      });
      document.querySelectorAll('input[name="export-mode"]').forEach((r) => {
        r.addEventListener('change', () => this._updateExportModalSummary());
      });
      $('export-resolution').addEventListener('change', () => this._updateExportModalSummary());
      $('modal-start-render-btn').addEventListener('click', () => this.executeVideoExport());

      // Global Keyboard Shortcuts (when Studio tab is active)
      window.addEventListener('keydown', (e) => {
        if (this.host.state.activeTab !== 'studio' || !this.projectId) return;
        const tag = (e.target && e.target.tagName || '').toLowerCase();
        const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select';

        if (e.ctrlKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          this.save();
          return;
        }
        if (isEditing) return;

        if (e.code === 'Space') {
          e.preventDefault();
          this.togglePlay();
        } else if (e.key.toLowerCase() === 'j') {
          e.preventDefault();
          this.skip(-3);
        } else if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          this.skip(3);
        } else if (e.key.toLowerCase() === 'i') {
          e.preventDefault();
          this.setInPoint();
        } else if (e.key.toLowerCase() === 'o') {
          e.preventDefault();
          this.setOutPoint();
        }
      });

      this._syncInspectorInputs();
      this.renderGlossaryUI();
    }

    _syncInspectorInputs() {
      $('insp-font-family').value = this.style.font_family;
      $('insp-font-size').value = this.style.font_size;
      $('insp-font-weight').value = String(this.style.font_weight);
      $('insp-font-color').value = this.style.font_color;
      $('insp-font-color-hex').textContent = this.style.font_color;
      $('insp-bg-color').value = this.style.bg_color;
      $('insp-bg-opacity').value = this.style.bg_opacity;
      $('insp-bg-opacity-val').textContent = `${Math.round(this.style.bg_opacity * 100)}%`;
      $('insp-stroke-color').value = this.style.stroke_color;
      $('insp-stroke-width').value = this.style.stroke_width;
      if ($('insp-shadow-depth')) {
        const sd = Number(this.style.shadow_depth ?? 2);
        $('insp-shadow-depth').value = sd;
        if ($('insp-shadow-depth-val')) $('insp-shadow-depth-val').textContent = String(sd);
      }
      $('insp-pos-y').value = this.style.pos_y;
      $('insp-pos-y-val').textContent = `${this.style.pos_y}%`;
      $('insp-karaoke-enabled').checked = Boolean(this.style.karaoke_enabled);
      $('insp-karaoke-color').value = this.style.karaoke_highlight_color || '#fde047';
      $('insp-karaoke-color-hex').textContent = this.style.karaoke_highlight_color || '#fde047';
      document.querySelectorAll('button[data-align]').forEach((b) => b.classList.toggle('active', b.dataset.align === this.style.align));

      $('delogo-enabled').checked = this.delogo.enabled;
      $('delogo-mode').value = this.delogo.mode;
      $('delogo-strength').value = this.delogo.blur_strength;
      $('delogo-strength-val').textContent = String(this.delogo.blur_strength);
      $('delogo-y').value = this.delogo.y_pct;
      $('delogo-y-val').textContent = `${this.delogo.y_pct}%`;
      $('delogo-h').value = this.delogo.height_pct;
      $('delogo-h-val').textContent = `${this.delogo.height_pct}%`;
      $('delogo-color').value = this.delogo.box_color;
      $('delogo-opacity').value = this.delogo.box_opacity;
      $('delogo-opacity-val').textContent = `${Math.round(this.delogo.box_opacity * 100)}%`;

      $('wm-enabled').checked = this.watermark.enabled;
      $('wm-pos').value = this.watermark.position;
      $('wm-width').value = this.watermark.width_pct;
      $('wm-width-val').textContent = `${this.watermark.width_pct}%`;
      $('wm-opacity').value = this.watermark.opacity;
      $('wm-opacity-val').textContent = `${Math.round(this.watermark.opacity * 100)}%`;
      $('wm-file-label').textContent = this.watermark.image_path
        ? `✅ ${this.host.getFileName(this.watermark.image_path)}`
        : 'No logo selected';
      $('intro-file-label').textContent = this.branding.intro_path
        ? `✅ ${this.host.getFileName(this.branding.intro_path)}`
        : 'No Intro';
      $('outro-file-label').textContent = this.branding.outro_path
        ? `✅ ${this.host.getFileName(this.branding.outro_path)}`
        : 'No Outro';

      $('bi-enabled').checked = this.style.bilingual_enabled;
      $('bi-color').value = this.style.secondary_color;
      $('bi-color-hex').textContent = this.style.secondary_color;
      $('bi-scale').value = Math.round(this.style.secondary_scale * 100);
      $('bi-scale-val').textContent = `${Math.round(this.style.secondary_scale * 100)}%`;
    }

    openLocalProject(localProj) {
      if (!localProj) return;
      this.host.switchTab('studio');
      $('studio-empty').classList.add('hidden');
      $('studio-workspace').classList.remove('hidden');

      this.sourceType = 'local';
      this.projectId = localProj.id;
      this.filename = localProj.name || localProj.id;
      const upsellBar = $('studio-offline-upsell-bar');
      if (upsellBar) {
        const isOfflineDraft = !!localProj.isOfflineDraft;
        upsellBar.classList.toggle('hidden', !isOfflineDraft);
        if (isOfflineDraft && this.host && this.host.state && this.host.state.offlineConfig) {
          const isEn = window.DesktopI18n && window.DesktopI18n.getLang() === 'en';
          const msg = isEn
            ? (this.host.state.offlineConfig.cloud_upsell_banner_en || '')
            : (this.host.state.offlineConfig.cloud_upsell_banner_th || '');
          const txtEl = $('studio-offline-upsell-text');
          if (txtEl && msg) txtEl.textContent = msg;
        }
      }
      this.language = localProj.language || 'th';
      this.durationSeconds = Number(localProj.durationSeconds) || 0;
      this.localVideoPath = localProj.videoPath || '';
      this.cloudMediaUrl = '';
      this.segments = Array.isArray(localProj.segments)
        ? localProj.segments.map((s) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: String(s.text || ''),
            secondary_text: String(s.secondary_text || ''),
          }))
        : [];
      this.dirty = false;
      this.activeCueIdx = -1;
      this.cumulativeOffset = 0;
      this.inPoint = null;
      this.outPoint = null;
      this.cutZones = [];
      this.splitMarkers = [];
      this.waveformPeaks = [];
      if (this.host.onProjectChanged) this.host.onProjectChanged();
      $('studio-offset-badge').textContent = '0.0s';

      this.loadVideoSource();
      this.renderHeader();
      this.renderSegments();
      this.renderCutStatus();
      this.renderTimeline();
      this.applyLivePreviews();
      this._checkDraft();
    }

    async importLocalSubtitleFile() {
      if (!this.projectId) return;
      const tauri = window.__TAURI__;
      if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== 'function') return;
      const sel = await tauri.dialog.open({
        multiple: false,
        title: 'นำเข้าไฟล์ซับไตเติล (.SRT / .VTT)',
        filters: [{ name: 'Subtitle Files (SRT / VTT)', extensions: ['srt', 'vtt'] }],
      });
      if (!sel || Array.isArray(sel)) return;
      try {
        const raw = await this.host.invokeCmd('read_text_file', { filePath: sel });
        const cues = window.DesktopSubtitleParser.parseSubtitleText(raw);
        if (!cues.length) {
          this.host.showToast('ไม่พบข้อความซับไตเติลในไฟล์ที่เลือก', 'err');
          return;
        }
        this.segments = cues;
        if (this.sourceType === 'local' && this.host.updateLocalProjectSegments) {
          this.host.updateLocalProjectSegments(this.projectId, cues, sel);
        }
        this._markDirty();
        this.renderSegments();
        this.renderTimeline();
        this.applyLivePreviews();
        this.host.showToast(`นำเข้าซับ ${cues.length} บรรทัดจาก ${this.host.getFileName(sel)} สำเร็จ!`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async openProject(projectId, overrideLocalPath = '') {
      if (!this.host.state.token) {
        this.host.showToast('กรุณาเข้าสู่ระบบก่อนเปิด Cloud Project', 'err');
        return;
      }

      this.sourceType = 'cloud';
      $('studio-offline-upsell-bar')?.classList.add('hidden');

      this.host.switchTab('studio');
      $('studio-empty').classList.add('hidden');
      $('studio-workspace').classList.remove('hidden');
      $('studio-project-title').textContent = '⏳ Loading...';
      $('studio-segments-list').innerHTML = '<div class="empty-state">⏳ Loading subtitles...</div>';

      try {
        const detail = await this.host.invokeCmd('api_get_project_detail', {
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          projectId,
        });

        let localPath = overrideLocalPath || this.host.state.localMediaMap[projectId] || '';
        if (localPath) {
          const exists = await this.host.invokeCmd('file_exists', { filePath: localPath }).catch(() => false);
          if (!exists) localPath = '';
        }

        const rawSegs = Array.isArray(detail.segments) ? detail.segments : [];
        this.projectId = projectId;
        this.filename = detail.name || detail.filename || projectId;
        this.language = detail.language || 'th';
        this.durationSeconds = Number(detail.duration_seconds) || 0;
        this.localVideoPath = localPath;
        this.cloudMediaUrl = detail.has_media
          ? `${this.host.state.apiBase}/v1/projects/${encodeURIComponent(projectId)}/media?token=${encodeURIComponent(this.host.state.token)}`
          : '';
        this.segments = rawSegs.map((s) => {
          const lines = String(s.text || '').split('\n');
          return {
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: lines[0] || '',
            secondary_text: lines.length > 1 ? lines.slice(1).join(' ') : '',
          };
        });
        this.dirty = false;
        this.activeCueIdx = -1;
        this.cumulativeOffset = 0;
        this.inPoint = null;
        this.outPoint = null;
        this.cutZones = [];
        this.splitMarkers = [];
        this.waveformPeaks = [];
        $('studio-offset-badge').textContent = '0.0s';

        this.loadVideoSource();
        this.renderHeader();
        this.renderSegments();
        this.renderCutStatus();
        this.renderTimeline();
        this.applyLivePreviews();
        this._checkDraft();
      } catch (err) {
        this.host.showToast(`เปิดโปรเจกต์ไม่สำเร็จ: ${err}`, 'err');
        $('studio-empty').classList.remove('hidden');
        $('studio-workspace').classList.add('hidden');
      }
    }

    loadVideoSource() {
      const video = $('studio-video');
      const badge = $('studio-source-badge');
      badge.classList.remove('pill-ok', 'pill-warn', 'pill-muted');

      if (this.localVideoPath) {
        video.src = this.host.toAssetUrl(this.localVideoPath);
        video.load();
        badge.classList.add('pill-ok');
        badge.textContent = `💻 Local (0ms): ${this.host.getFileName(this.localVideoPath)}`;
        badge.title = this.localVideoPath;
        this.loadAudioWaveform(this.localVideoPath);
      } else if (this.cloudMediaUrl) {
        video.src = this.cloudMediaUrl;
        video.load();
        badge.classList.add('pill-warn');
        badge.textContent = '☁️ Cloud Stream (Link local video for 0% server load MP4 export)';
      } else {
        video.removeAttribute('src');
        video.load();
        if (this.waveform) this.waveform.clearFilmstrip();
        badge.classList.add('pill-muted');
        badge.textContent = '📄 Subtitles only — Link local video to preview & export MP4';
      }
    }

    setStudioMode(mode, persist = true) {
      const isEasy = mode === 'easy';
      this.studioMode = isEasy ? 'easy' : 'pro';
      const view = $('view-studio');
      if (view) view.classList.toggle('studio-easy-mode', isEasy);
      document.querySelectorAll('button[data-studio-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.studioMode === this.studioMode);
      });
      const tlTitle = $('wf-timeline-title');
      if (tlTitle) {
        tlTitle.textContent = isEasy ? '🎞️ Simple 2-Track Timeline' : '🎞️ 5-Track Visual Timeline';
      }
      // If switching into Easy Mode while on a Pro-only inspector tab, jump cleanly to Style tab
      if (isEasy) {
        const activeTab = document.querySelector('.insp-tab.active');
        if (activeTab && activeTab.dataset.proTab === '1') {
          const styleTab = document.querySelector('.insp-tab[data-insp-tab="style"]');
          if (styleTab) styleTab.click();
        }
      }
      if (this.waveform && typeof this.waveform.setSimpleMode === 'function') {
        this.waveform.setSimpleMode(isEasy);
      }
      if (persist) {
        try { localStorage.setItem('autosub_studio_mode', this.studioMode); } catch (_) {}
      }
    }

    applyThaiSmartLineBreak(maxCharsPerLine = 38) {
      if (!Array.isArray(this.segments) || !this.segments.length) {
        this.host.showToast('ยังไม่มีซับไตเติลให้จัดตัดบรรทัดครับ', 'info');
        return;
      }
      const limit = Math.max(12, Math.min(60, Number(maxCharsPerLine) || 38));
      let changed = 0;
      for (const seg of this.segments) {
        const before = String(seg.text || '');
        const after = wrapThaiSmartText(before, limit);
        if (after !== before) {
          seg.text = after;
          changed++;
        }
      }
      if (changed > 0) {
        this._markDirty();
        this.renderSegments();
        this.renderTimeline();
        this.applyLivePreviews();
        this.host.showToast(`✂️ จัดตัดบรรทัดไทยอัจฉริยะเรียบร้อย ${changed} บรรทัด (≤${limit} ตัวอักษร)`, 'ok');
      } else {
        this.host.showToast(`✅ ทุกบรรทัดมีความยาวเหมาะสมอยู่แล้ว (≤${limit} ตัวอักษร)`, 'info');
      }
    }

    setAspectRatio(ar) {
      this.aspectRatio = ar;
      const stage = $('studio-video-stage');
      stage.classList.remove('ar-16-9', 'ar-9-16', 'ar-1-1');
      stage.classList.add(ar === '9:16' ? 'ar-9-16' : (ar === '1:1' ? 'ar-1-1' : 'ar-16-9'));
      document.querySelectorAll('button[data-ar]').forEach((b) => b.classList.toggle('active', b.dataset.ar === ar));
      // Auto-sync Thai line break dropdown suggestion to chosen aspect ratio
      const lb = $('insp-linebreak-mode');
      if (lb) lb.value = ar === '9:16' ? '20' : (ar === '1:1' ? '28' : '38');
    }

    setSafeZone(mode) {
      this.safeZone = mode;
      document.querySelectorAll('button[data-sz]').forEach((b) => b.classList.toggle('active', b.dataset.sz === mode));
      const box = $('studio-safezone-overlay');
      if (mode === 'off') {
        box.classList.add('hidden');
        box.innerHTML = '';
      } else if (mode === '9:16') {
        box.classList.remove('hidden');
        box.innerHTML = '<div class="sz-916-frame"></div>';
      } else {
        box.classList.remove('hidden');
        box.innerHTML = '<div class="sz-169-frame"></div>';
      }
    }

    applyLivePreviews() {
      // 1. Subtitle Style Overlay
      const anchor = $('studio-sub-anchor');
      const box = $('studio-sub-overlay');
      const pEl = $('studio-sub-primary');
      const sEl = $('studio-sub-secondary');

      anchor.style.top = `${this.style.pos_y}%`;
      anchor.style.justifyContent = this.style.align === 'left'
        ? 'flex-start'
        : (this.style.align === 'right' ? 'flex-end' : 'center');

      box.style.fontFamily = `'${this.style.font_family}', 'Prompt', sans-serif`;
      box.style.fontWeight = String(this.style.font_weight);
      box.style.textAlign = this.style.align;
      box.style.background = this.style.bg_opacity > 0.02
        ? hexToRgba(this.style.bg_color, this.style.bg_opacity)
        : 'transparent';

      // Scale preview font gently for stage size
      const previewFs = Math.max(11, Math.round(this.style.font_size * 0.72));
      pEl.style.fontSize = `${previewFs}px`;
      pEl.style.color = this.style.font_color;
      const sw = Number(this.style.stroke_width || 0);
      const sc = this.style.stroke_color || '#000000';
      const sd = Number(this.style.shadow_depth ?? 2);
      const shadowParts = [];
      if (sw > 0) {
        shadowParts.push(`-${sw}px -${sw}px 0 ${sc}`, `${sw}px -${sw}px 0 ${sc}`, `-${sw}px ${sw}px 0 ${sc}`, `${sw}px ${sw}px 0 ${sc}`);
      }
      if (sd > 0) {
        shadowParts.push(`0 ${sd}px ${Math.max(2, Math.round(sd * 2.2))}px rgba(0,0,0,0.88)`);
      }
      const shadowStr = shadowParts.length ? shadowParts.join(', ') : 'none';
      pEl.style.textShadow = shadowStr;
      pEl.style.whiteSpace = 'pre-line';

      sEl.style.fontSize = `${Math.max(10, Math.round(previewFs * this.style.secondary_scale))}px`;
      sEl.style.color = this.style.secondary_color;
      sEl.style.textShadow = shadowStr;
      sEl.style.whiteSpace = 'pre-line';

      // 2. Delogo / Cover Bar Preview
      const dl = $('studio-delogo-preview');
      if (this.delogo.enabled) {
        dl.classList.remove('hidden');
        dl.style.top = `${this.delogo.y_pct}%`;
        dl.style.height = `${this.delogo.height_pct}%`;
        if (this.delogo.mode === 'solid') {
          dl.style.backdropFilter = 'none';
          dl.style.background = hexToRgba(this.delogo.box_color, this.delogo.box_opacity);
        } else {
          dl.style.background = 'rgba(15, 23, 42, 0.25)';
          dl.style.backdropFilter = `blur(${Math.max(4, Math.round(this.delogo.blur_strength * 0.8))}px)`;
        }
      } else {
        dl.classList.add('hidden');
      }

      // 3. Watermark PNG Preview
      const wm = $('studio-watermark-preview');
      if (this.watermark.enabled && this.watermark.image_path) {
        wm.src = this.host.toAssetUrl(this.watermark.image_path);
        wm.classList.remove('hidden');
        wm.style.width = `${this.watermark.width_pct}%`;
        wm.style.opacity = String(this.watermark.opacity);
        wm.style.top = this.watermark.position.startsWith('top') ? '3%' : 'auto';
        wm.style.bottom = this.watermark.position.startsWith('bottom') ? '3%' : 'auto';
        wm.style.left = this.watermark.position.endsWith('left') ? '3%' : 'auto';
        wm.style.right = this.watermark.position.endsWith('right') ? '3%' : 'auto';
      } else {
        wm.classList.add('hidden');
      }

      this.onTimeUpdate();
    }

    _effectiveDuration() {
      const video = $('studio-video');
      if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
      if (this.durationSeconds > 0) return this.durationSeconds;
      const last = this.segments[this.segments.length - 1];
      return last ? Math.max(10, last.end + 2) : 60;
    }

    async loadAudioWaveform(videoPath) {
      if (!videoPath || !this.host.state.ffmpeg.available) return;
      try {
        const peaks = await this.host.invokeCmd('extract_audio_waveform', {
          videoPath,
          numBins: 600,
        });
        if (Array.isArray(peaks)) {
          this.waveformPeaks = peaks;
          this.renderTimeline();
        }
      } catch (_) {}
    }

    renderTimeline() {
      if (!this.waveform) return;
      const proMeta = this.host.getProTimelineMeta ? this.host.getProTimelineMeta() : {};
      this.waveform.setData({
        peaks: this.waveformPeaks,
        duration: this._effectiveDuration(),
        segments: this.segments,
        activeIdx: this.activeCueIdx,
        inPoint: this.inPoint,
        outPoint: this.outPoint,
        cutZones: this.cutZones,
        splitMarkers: this.splitMarkers || [],
        brollOverlays: proMeta.brollOverlays || [],
        voiceoverClips: proMeta.voiceoverClips || [],
        bgmInfo: proMeta.bgmInfo || { enabled: false, name: '', auto_ducking: true },
        audioMonitor: proMeta.audioMonitor || { solo: null, mute: { t3: false, t2: false, t1: false } },
        watermarkEnabled: !!(this.watermark && this.watermark.enabled && this.watermark.image_path),
      });
    }

    onTimeUpdate() {
      const video = $('studio-video');
      const anchor = $('studio-sub-anchor');
      const pEl = $('studio-sub-primary');
      const sEl = $('studio-sub-secondary');
      const t = video.currentTime || 0;

      // Loop current cue if active
      if (this.loopCue && this.activeCueIdx >= 0 && this.segments[this.activeCueIdx]) {
        const cur = this.segments[this.activeCueIdx];
        if (t >= cur.end) {
          video.currentTime = cur.start;
          return;
        }
      }

      let found = -1;
      for (let i = 0; i < this.segments.length; i++) {
        if (t >= this.segments[i].start && t <= this.segments[i].end) {
          found = i;
          break;
        }
      }

      if (this.waveform) {
        this.waveform.setCurrentTime(t, found);
      }
      if (this.host.onTimeUpdateHook) {
        this.host.onTimeUpdateHook(t, found);
      }

      // If paused at t=0 and no active cue, show sample cue 0 preview so Style Inspector changes are immediately visible!
      const displaySeg = found >= 0 ? this.segments[found] : (t === 0 && this.segments[0] ? this.segments[0] : null);
      if (displaySeg && (displaySeg.text.trim() || displaySeg.secondary_text.trim())) {
        if (this.style.karaoke_enabled && displaySeg.text.trim()) {
          const txt = displaySeg.text;
          const durSeg = Math.max(0.1, displaySeg.end - displaySeg.start);
          const progress = found >= 0 ? Math.max(0, Math.min(1, (t - displaySeg.start) / durSeg)) : 0.45;
          const splitChar = Math.round(txt.length * progress);
          const hiColor = escapeHtml(this.style.karaoke_highlight_color || '#fde047');
          pEl.innerHTML = `<span style="color:${hiColor}">${escapeHtml(txt.slice(0, splitChar))}</span><span>${escapeHtml(txt.slice(splitChar))}</span>`;
        } else {
          pEl.textContent = displaySeg.text;
        }
        if (this.style.bilingual_enabled && displaySeg.secondary_text.trim()) {
          sEl.textContent = displaySeg.secondary_text;
          sEl.classList.remove('hidden');
        } else {
          sEl.classList.add('hidden');
        }
        anchor.classList.remove('hidden');
      } else {
        anchor.classList.add('hidden');
      }

      if (found !== this.activeCueIdx) {
        const prev = document.querySelector(`.seg-row[data-seg-idx="${this.activeCueIdx}"]`);
        if (prev) prev.classList.remove('active-cue');
        this.activeCueIdx = found;
        if (found >= 0) {
          const next = document.querySelector(`.seg-row[data-seg-idx="${found}"]`);
          if (next) {
            next.classList.add('active-cue');
            next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }
      }
    }

    togglePlay() {
      const video = $('studio-video');
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    skip(delta) {
      const video = $('studio-video');
      video.currentTime = Math.max(0, (video.currentTime || 0) + delta);
    }

    _calcCps(seg) {
      const dur = Math.max(0.2, (seg.end || 0) - (seg.start || 0));
      return (seg.text || '').trim().length / dur;
    }

    renderHeader() {
      $('studio-project-title').textContent = this.filename;
      const avgCps = this.segments.length
        ? (this.segments.reduce((acc, s) => acc + this._calcCps(s), 0) / this.segments.length).toFixed(1)
        : '0.0';
      const dirtyTag = this.dirty ? ' • 🟡 Unsaved' : ' • ✅ Synced';
      $('studio-project-meta').textContent = `${this.segments.length} cues • ${this.language}${dirtyTag}`;
      $('studio-cue-stats').textContent = `${this.segments.length} cues • ${avgCps} CPS`;
    }

    renderSegments() {
      const container = $('studio-segments-list');
      this.renderHeader();
      const cloudBtn = $('studio-cloud-ai-btn');
      if (cloudBtn) {
        cloudBtn.classList.toggle('hidden', this.sourceType !== 'local');
      }
      if (!this.segments.length) {
        if (this.sourceType === 'local') {
          container.innerHTML = `
            <div class="empty-state" style="padding:20px 12px; display:flex; flex-direction:column; align-items:center; gap:9px;">
              <div style="font-size:24px;">✨</div>
              <div style="font-weight:700; font-size:13px; color:#f1f5f9;">ยังไม่มีซับไตเติลในคลิปนี้</div>
              <div class="muted" style="font-size:11.5px; line-height:1.45;">ให้ AutoSubAI ถอดเสียงสร้างซับภาษาไทย/ต่างประเทศอัตโนมัติ แม่นยำ 96%+</div>
              <button type="button" id="studio-empty-cloud-ai-btn" class="btn btn-cloud-ai-cta btn-sm" style="width:100%; justify-content:center;">✨ สร้างซับ Cloud AI ทันที</button>
              <div style="display:flex; gap:6px; width:100%;">
                <button type="button" id="studio-empty-import-btn" class="btn btn-ghost btn-xs" style="flex:1; justify-content:center;">📄 +SRT/VTT</button>
                <button type="button" id="studio-empty-add-btn" class="btn btn-ghost btn-xs" style="flex:1; justify-content:center;">➕ พิมพ์ซับเอง</button>
              </div>
            </div>`;
          $('studio-empty-cloud-ai-btn')?.addEventListener('click', () => {
            if (this.host.openCloudAiForLocalProject) this.host.openCloudAiForLocalProject(this.projectId);
          });
          $('studio-empty-import-btn')?.addEventListener('click', () => this.importLocalSubtitleFile());
          $('studio-empty-add-btn')?.addEventListener('click', () => this.addCue());
        } else {
          container.innerHTML = '<div class="empty-state">No subtitles yet — click ➕ Add Cue</div>';
        }
        return;
      }

      const q = this.filterQuery;
      const rows = [];
      for (let idx = 0; idx < this.segments.length; idx++) {
        const seg = this.segments[idx];
        if (q && !seg.text.toLowerCase().includes(q) && !(seg.secondary_text || '').toLowerCase().includes(q)) {
          continue;
        }
        const cps = this._calcCps(seg);
        const cpsCls = cps > 22 ? 'cps-high' : (cps > 17 ? 'cps-warn' : 'cps-ok');
        const biHtml = this.style.bilingual_enabled
          ? `<textarea class="seg-textarea seg-textarea-secondary" data-field="secondary_text" data-seg-idx="${idx}" placeholder="2nd Language Subtitle (Bilingual)...">${escapeHtml(seg.secondary_text)}</textarea>`
          : '';

        rows.push(`
          <div class="seg-row ${idx === this.activeCueIdx ? 'active-cue' : ''}" data-seg-idx="${idx}">
            <div class="seg-top">
              <div class="seg-times">
                <span class="seg-idx">#${idx + 1}</span>
                <button type="button" class="nudge-btn" data-nudge="-0.1" data-field="start" data-seg-idx="${idx}">-</button>
                <input type="text" class="seg-time-input" data-field="start" data-seg-idx="${idx}" value="${secToSrtTs(seg.start)}" />
                <button type="button" class="nudge-btn" data-nudge="0.1" data-field="start" data-seg-idx="${idx}">+</button>
                <span class="muted">→</span>
                <button type="button" class="nudge-btn" data-nudge="-0.1" data-field="end" data-seg-idx="${idx}">-</button>
                <input type="text" class="seg-time-input" data-field="end" data-seg-idx="${idx}" value="${secToSrtTs(seg.end)}" />
                <button type="button" class="nudge-btn" data-nudge="0.1" data-field="end" data-seg-idx="${idx}">+</button>
                <span class="cps-pill ${cpsCls}">${cps.toFixed(0)} CPS</span>
              </div>
              <div class="seg-row-actions">
                <button type="button" class="btn btn-ghost btn-xs" data-seg-action="seek" data-seg-idx="${idx}" title="Play Cue">▶</button>
                <button type="button" class="btn btn-ghost btn-xs" data-seg-action="split" data-seg-idx="${idx}" title="Split (Ctrl+Enter)">✂️</button>
                <button type="button" class="btn btn-ghost btn-xs" data-seg-action="merge" data-seg-idx="${idx}" title="Merge with Next">🔗</button>
                <button type="button" class="btn btn-ghost btn-xs" data-seg-action="insert" data-seg-idx="${idx}" title="Insert After">➕</button>
                <button type="button" class="btn btn-danger-ghost btn-xs" data-seg-action="delete" data-seg-idx="${idx}" title="Delete">🗑️</button>
              </div>
            </div>
            <textarea class="seg-textarea" data-field="text" data-seg-idx="${idx}">${escapeHtml(seg.text)}</textarea>
            ${biHtml}
          </div>
        `);
      }
      container.innerHTML = rows.join('') || '<div class="empty-state">No cues match filter</div>';
    }

    splitCue(idx, cursorPos = null) {
      const seg = this.segments[idx];
      if (!seg) return;
      const txt = seg.text;
      const cutAt = cursorPos != null && cursorPos > 0 && cursorPos < txt.length
        ? cursorPos
        : Math.floor(txt.length / 2);
      const ratio = txt.length > 0 ? Math.max(0.2, Math.min(0.8, cutAt / txt.length)) : 0.5;
      const mid = Number((seg.start + (seg.end - seg.start) * ratio).toFixed(3));
      this.segments.splice(
        idx,
        1,
        { start: seg.start, end: mid, text: txt.slice(0, cutAt).trim() || txt, secondary_text: seg.secondary_text },
        { start: mid, end: seg.end, text: txt.slice(cutAt).trim(), secondary_text: '' }
      );
      this._markDirty();
      this.renderSegments();
      this.renderTimeline();
    }

    mergeCueWithNext(idx) {
      if (idx < 0 || idx + 1 >= this.segments.length) return;
      const a = this.segments[idx];
      const b = this.segments[idx + 1];
      a.end = Math.max(a.end, b.end);
      a.text = `${a.text.trim()} ${b.text.trim()}`.trim();
      if (a.secondary_text || b.secondary_text) {
        a.secondary_text = `${(a.secondary_text || '').trim()} ${(b.secondary_text || '').trim()}`.trim();
      }
      this.segments.splice(idx + 1, 1);
      this._markDirty();
      this.renderSegments();
      this.renderTimeline();
    }

    shiftAll(delta, resetZero = false) {
      if (!this.segments.length) return;
      this.segments.forEach((seg) => {
        seg.start = Math.max(0, Number((seg.start + delta).toFixed(3)));
        seg.end = Math.max(seg.start + 0.1, Number((seg.end + delta).toFixed(3)));
      });
      this.cumulativeOffset = resetZero ? 0 : Number((this.cumulativeOffset + delta).toFixed(2));
      $('studio-offset-badge').textContent = `${this.cumulativeOffset > 0 ? '+' : ''}${this.cumulativeOffset.toFixed(1)}s`;
      this._markDirty();
      this.renderSegments();
      this.renderTimeline();
    }

    // --- Auto-Draft Recovery ---
    _draftKey() {
      return `autosub_desktop_draft_${this.projectId}`;
    }

    _markDirty() {
      this.dirty = true;
      this.renderHeader();
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => {
        if (!this.projectId) return;
        try {
          localStorage.setItem(this._draftKey(), JSON.stringify({
            savedAt: new Date().toLocaleTimeString(),
            segments: this.segments,
          }));
        } catch (_) {}
      }, 600);
    }

    _checkDraft() {
      const banner = $('studio-draft-banner');
      try {
        const raw = localStorage.getItem(this._draftKey());
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.segments) && parsed.segments.length) {
            $('studio-draft-msg').textContent = `🟡 ${window.DesktopI18n.t('draftBannerText')} (${parsed.savedAt || ''})`;
            banner.classList.remove('hidden');
            return;
          }
        }
      } catch (_) {}
      banner.classList.add('hidden');
    }

    restoreDraft() {
      try {
        const raw = localStorage.getItem(this._draftKey());
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.segments)) {
          this.segments = parsed.segments;
          this.dirty = true;
          this.renderSegments();
          this.renderTimeline();
          $('studio-draft-banner').classList.add('hidden');
          this.host.showToast('กู้คืนร่างซับไตเติลสำเร็จ!', 'ok');
        }
      } catch (_) {}
    }

    discardDraft(notify = false) {
      if (this.projectId) {
        try { localStorage.removeItem(this._draftKey()); } catch (_) {}
      }
      $('studio-draft-banner').classList.add('hidden');
      if (notify) this.host.showToast('ลบร่างที่ค้างไว้แล้ว');
    }

    // --- Cloud + Local 2-Way Save (Supports 100% Offline Local Mode too!) ---
    async save() {
      if (!this.projectId) return;
      const btn = $('studio-save-btn');
      btn.disabled = true;
      try {
        if (this.sourceType === 'local') {
          let savedPath = null;
          if (this.localVideoPath) {
            const saved = await this.host.invokeCmd('save_subtitle_next_to_source', {
              videoPath: this.localVideoPath,
              srtContent: buildSrtFromSegments(this.segments, this.style.bilingual_enabled),
              vttContent: buildVttFromSegments(this.segments, this.style.bilingual_enabled),
              saveVtt: $('opt-autosave-vtt') ? $('opt-autosave-vtt').checked : false,
            });
            savedPath = saved.srt_path;
          }
          if (this.host.updateLocalProjectSegments) {
            this.host.updateLocalProjectSegments(this.projectId, this.segments, savedPath);
          }
          this.dirty = false;
          this.discardDraft(false);
          this.renderHeader();
          this.host.showToast('✅ บันทึก Local Project + อัปเดตไฟล์ .srt บนเครื่องสำเร็จ!', 'ok');
          return;
        }

        const payloadSegs = this.segments.map((s, idx) => {
          const p = (s.text || '').trim();
          const sec = (s.secondary_text || '').trim();
          const mergedText = this.style.bilingual_enabled && sec ? `${p}\n${sec}` : p;
          return {
            index: idx + 1,
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: mergedText,
          };
        });

        await this.host.invokeCmd('api_save_job_segments', {
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          jobId: this.projectId,
          segments: payloadSegs,
        });

        let extra = '';
        if (this.localVideoPath) {
          await this.host.invokeCmd('save_subtitle_next_to_source', {
            videoPath: this.localVideoPath,
            srtContent: buildSrtFromSegments(this.segments, this.style.bilingual_enabled),
            vttContent: buildVttFromSegments(this.segments, this.style.bilingual_enabled),
            saveVtt: $('opt-autosave-vtt').checked,
          });
          extra = ' + Local .srt';
        }

        this.dirty = false;
        this.discardDraft(false);
        this.renderHeader();
        this.host.showToast(`✅ บันทึกขึ้นคลาวด์สำเร็จ${extra}!`, 'ok');
      } catch (err) {
        this.host.showToast(`บันทึกไม่สำเร็จ: ${err}`, 'err');
      } finally {
        btn.disabled = false;
      }
    }

    // --- Subtitle File Exports (.SRT / .VTT / .ASS / .TXT) ---
    async exportSubtitle(ext) {
      if (!this.segments.length) return;
      const tauri = window.__TAURI__;
      if (!tauri || !tauri.dialog || typeof tauri.dialog.save !== 'function') return;
      const stem = this.filename.replace(/\.[^.]+$/, '') || 'subtitles';
      const savePath = await tauri.dialog.save({
        title: `Export .${ext.toUpperCase()}`,
        defaultPath: `${stem}.${ext}`,
        filters: [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }],
      });
      if (!savePath) return;

      try {
        let content = '';
        if (ext === 'ass') {
          content = await this.host.invokeCmd('generate_ass_content', {
            cues: this.segments,
            style: this.style,
          });
        } else if (ext === 'vtt') {
          content = buildVttFromSegments(this.segments, this.style.bilingual_enabled);
        } else if (ext === 'txt') {
          content = buildTxtFromSegments(this.segments, this.style.bilingual_enabled);
        } else {
          content = buildSrtFromSegments(this.segments, this.style.bilingual_enabled);
        }
        await this.host.invokeCmd('write_text_file', { filePath: savePath, content });
        this.host.showToast(`บันทึก ${this.host.getFileName(savePath)} สำเร็จ!`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: savePath }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    // --- AI Translate (Supports Bilingual 2nd Track or Primary Replace) ---
    async translateSegments() {
      if (!this.segments.length) return;
      const targetLang = $('studio-translate-lang').value;
      const targetTrack = $('studio-translate-track').value;
      const btn = $('studio-translate-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Translating...';
      try {
        const joined = this.segments.map((s) => (s.text || '').replace(/\r?\n/g, ' ')).join('\n');
        const res = await this.host.invokeCmd('api_translate_text', {
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          text: joined,
          targetLanguage: targetLang,
          sourceLanguage: 'auto',
        });
        const lines = String(res.translated || '').split('\n');
        if (targetTrack === 'secondary') {
          this.style.bilingual_enabled = true;
          this._syncInspectorInputs();
          this._persistConfigs();
          this.segments.forEach((seg, i) => {
            if (lines[i] !== undefined) seg.secondary_text = lines[i];
          });
        } else {
          this.segments.forEach((seg, i) => {
            if (lines[i] !== undefined) seg.text = lines[i];
          });
          this.language = targetLang;
        }
        this._markDirty();
        this.renderSegments();
        this.applyLivePreviews();
        this.host.showToast(`✨ แปลซับเป็น "${targetLang}" สำเร็จ!`, 'ok');
      } catch (err) {
        this.host.showToast(`แปลซับไม่สำเร็จ: ${err}`, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = window.DesktopI18n.t('btnTranslateNow');
      }
    }

    // --- Quality Audit Matrix Modal ---
    openQualityAuditModal() {
      const cues = this.segments;
      let overlaps = 0;
      let mojibake = 0;
      let entities = 0;
      let totalCps = 0;
      for (let i = 0; i < cues.length; i++) {
        const txt = cues[i].text || '';
        totalCps += this._calcCps(cues[i]);
        if (/\?{2,}|/.test(txt)) mojibake++;
        const nums = txt.match(/\d+/g);
        if (nums) entities += nums.length;
        if (i + 1 < cues.length && cues[i].end > cues[i + 1].start + 0.02) overlaps++;
      }
      const avgCps = cues.length ? totalCps / cues.length : 0;
      let score = 100.0;
      score -= mojibake * 5;
      score -= overlaps * 1.5;
      if (avgCps > 22) score -= 5;
      score = Math.max(60, Math.min(99.8, score));
      const grade = score >= 95 ? 'A+' : (score >= 88 ? 'A' : 'B');

      $('modal-audit-body').innerHTML = `
        <div class="audit-banner">
          <div>
            <div style="font-weight:700;font-size:14px;">Studio Quality Standard</div>
            <div class="muted">Mojibake: ${mojibake} • Overlaps: ${overlaps} • Avg Speed: ${avgCps.toFixed(1)} CPS</div>
          </div>
          <div style="text-align:right;">
            <div class="audit-score">${score.toFixed(1)}%</div>
            <div class="q-badge q-badge-done">Grade ${grade}</div>
          </div>
        </div>
        <div class="audit-grid">
          <div class="audit-stat"><div class="muted">Cues</div><strong>${cues.length}</strong></div>
          <div class="audit-stat"><div class="muted">Avg CPS</div><strong>${avgCps.toFixed(1)}</strong></div>
          <div class="audit-stat"><div class="muted">Numbers</div><strong>${entities}</strong></div>
          <div class="audit-stat"><div class="muted">Overlaps</div><strong>${overlaps}</strong></div>
        </div>
      `;
      $('modal-audit').classList.remove('hidden');
    }

    // --- AI Summary Modal ---
    async openAiSummaryModal() {
      $('modal-summary').classList.remove('hidden');
      $('modal-summary-body').innerHTML = '<div class="empty-state">⏳ กำลังสรุปใจความสำคัญด้วย AI...</div>';
      try {
        const fullText = this.segments.map((s) => s.text).join(' ');
        const res = await this.host.invokeCmd('api_summarize_transcript', {
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          jobId: this.projectId,
          text: fullText,
          language: window.DesktopI18n.getLang(),
        });
        const kws = Array.isArray(res.keywords) ? res.keywords : [];
        const bullets = Array.isArray(res.bullet_points) ? res.bullet_points : [];
        $('modal-summary-body').innerHTML = `
          <div class="summary-box">${escapeHtml(res.summary || res.text || 'No summary returned')}</div>
          ${bullets.length ? `<ul style="padding-left:18px;font-size:12.4px;color:#cbd5e1;">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
          ${kws.length ? `<div class="kw-wrap">${kws.map((k) => `<span class="kw-chip">#${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        `;
      } catch (err) {
        $('modal-summary-body').innerHTML = `<div class="inline-alert">${escapeHtml(err)}</div>`;
      }
    }

    // --- Export Video MP4 Modal (WYSIWYG Hardsub / 1-2s Softsub) ---
    openExportModal() {
      this._updateExportModalSummary();
      $('modal-export').classList.remove('hidden');
    }

    _updateExportModalSummary() {
      const modeEl = document.querySelector('input[name="export-mode"]:checked');
      const mode = modeEl ? modeEl.value : 'hardsub';
      $('export-res-wrap').classList.toggle('hidden', mode === 'softsub');
      const res = $('export-resolution').value;
      const proCfgSummary = this.host.getProRenderConfig ? this.host.getProRenderConfig() : {};
      const voCount = (proCfgSummary.voiceover && proCfgSummary.voiceover.enabled && Array.isArray(proCfgSummary.voiceover.clips))
        ? proCfgSummary.voiceover.clips.length : 0;
      const lines = [
        `• Mode: <strong>${mode === 'softsub' ? 'Softsub MP4 (Stream Copy 1–2s)' : 'WYSIWYG Hardsub MP4 (GPU NVENC/VideoToolbox)'}</strong>`,
        `• Style: <strong>${escapeHtml(this.style.font_family)} ${this.style.font_size}px</strong>${this.style.karaoke_enabled ? ' + <strong>✨ Karaoke</strong>' : ''}${this.style.bilingual_enabled ? ' + <strong>Bilingual 2nd Line</strong>' : ''}`,
        voCount > 0 ? `• Voiceover / Dubbing: <strong>🎙️ ${voCount} คลิป${proCfgSummary.voiceover.duck_original ? ' (Auto-Duck เสียงต้นฉบับ)' : ''}</strong>` : '',
        `• Delogo / Cover Bar: <strong>${this.delogo.enabled ? `${this.delogo.mode} (Y=${this.delogo.y_pct}%, H=${this.delogo.height_pct}%)` : 'Off'}</strong>`,
        `• Channel Watermark: <strong>${this.watermark.enabled && this.watermark.image_path ? escapeHtml(this.host.getFileName(this.watermark.image_path)) : 'Off'}</strong>`,
        (this.branding.intro_path || this.branding.outro_path) ? `• Intro / Outro Stitch: <strong>${this.branding.intro_path ? 'Intro ✅' : ''} ${this.branding.outro_path ? 'Outro ✅' : ''}</strong>` : '',
        mode === 'hardsub' ? `• Resolution: <strong>${res}</strong>` : '',
      ].filter(Boolean);
      $('export-summary-box').innerHTML = lines.join('<br/>');
    }

    async executeVideoExport() {
      if (this.rendering) return;
      if (!this.host.state.ffmpeg.available) {
        this.host.showToast('ไม่พบ FFmpeg ในเครื่อง', 'err');
        return;
      }

      let videoPath = this.localVideoPath;
      if (!videoPath) {
        this.host.showToast('กรุณาเลือกไฟล์วิดีโอต้นฉบับในเครื่องสำหรับส่งออก MP4');
        videoPath = await this.host.pickLocalVideoForProject(this.projectId);
        if (!videoPath) return;
        this.localVideoPath = videoPath;
        this.loadVideoSource();
      }

      const modeEl = document.querySelector('input[name="export-mode"]:checked');
      const mode = modeEl ? modeEl.value : 'hardsub';
      const resolution = $('export-resolution').value;

      const btn = $('modal-start-render-btn');
      this.rendering = true;
      btn.disabled = true;
      btn.textContent = '⏳ Rendering MP4...';

      try {
        const proCfg = this.host.getProRenderConfig ? this.host.getProRenderConfig() : {};
        const res = await this.host.invokeCmd('render_studio_video', {
          req: {
            video_path: videoPath,
            output_path: null,
            mode,
            resolution,
            cues: this.segments,
            style: this.style,
            delogo: this.delogo,
            watermark: this.watermark,
            intro_path: this.branding.intro_path || null,
            outro_path: this.branding.outro_path || null,
            color_speed: proCfg.color_speed,
            bgm: proCfg.bgm,
            broll_overlays: proCfg.broll_overlays,
            voiceover: proCfg.voiceover,
          },
        });
        $('modal-export').classList.add('hidden');
        this.host.showToast(`✅ ส่งออก MP4 สำเร็จ (${res.encoder_used}): ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.rendering = false;
        btn.disabled = false;
        btn.textContent = window.DesktopI18n.t('btnStartRender');
      }
    }

    // --- Milestone 2: Trim / Multi-Cut + Ripple Sync + 9:16 Viral Shorts + Glossary ---
    setInPoint() {
      const t = Number(($('studio-video').currentTime || 0).toFixed(2));
      this.inPoint = t;
      if (this.outPoint != null && this.outPoint <= this.inPoint) this.outPoint = null;
      this.renderCutStatus();
      this.renderTimeline();
      this.host.showToast(`📍 ตั้งจุดเริ่ม In = ${secToSrtTs(t).slice(0, 8)}`);
    }

    setOutPoint() {
      const t = Number(($('studio-video').currentTime || 0).toFixed(2));
      this.outPoint = t;
      if (this.inPoint != null && this.outPoint <= this.inPoint) this.inPoint = 0;
      this.renderCutStatus();
      this.renderTimeline();
      this.host.showToast(`📍 ตั้งจุดจบ Out = ${secToSrtTs(t).slice(0, 8)}`);
    }

    addCutZoneFromInOut() {
      if (this.inPoint == null || this.outPoint == null || this.outPoint <= this.inPoint + 0.2) {
        this.host.showToast('กรุณาตั้งจุดเริ่ม [I] และจุดจบ [O] ของช่วงที่ต้องการตัดออกก่อน', 'err');
        return;
      }
      this.cutZones.push({ start: this.inPoint, end: this.outPoint });
      this.cutZones.sort((a, b) => a.start - b.start);
      this.inPoint = null;
      this.outPoint = null;
      this.renderCutStatus();
      this.renderTimeline();
      this.host.showToast(`✂️ เพิ่มช่วงตัดออกแล้ว (${this.cutZones.length} ช่วง) — ซับจะขยับตามอัตโนมัติ`, 'ok');
    }

    clearCutMarkers() {
      this.inPoint = null;
      this.outPoint = null;
      this.cutZones = [];
      this.renderCutStatus();
      this.renderTimeline();
      this.host.showToast('ล้างจุดตัดทั้งหมดแล้ว');
    }

    renderCutStatus() {
      const box = $('cut-status-box');
      if (!box) return;
      const inStr = this.inPoint != null ? secToSrtTs(this.inPoint).slice(0, 8) : '00:00:00';
      const outStr = this.outPoint != null ? secToSrtTs(this.outPoint).slice(0, 8) : 'End';
      box.innerHTML = `In: <strong>${inStr}</strong> • Out: <strong>${outStr}</strong> • Cut-Out Zones: <strong>${this.cutZones.length}</strong>`;
    }

    computeKeepRangesAndRippleCues() {
      const dur = this._effectiveDuration();
      const baseStart = this.inPoint != null ? this.inPoint : 0;
      const baseEnd = this.outPoint != null && this.outPoint > baseStart ? this.outPoint : dur;

      // Subtract cutZones from [baseStart, baseEnd]
      let keep = [{ start: baseStart, end: baseEnd }];
      for (const cz of this.cutZones) {
        const next = [];
        for (const kr of keep) {
          if (cz.end <= kr.start || cz.start >= kr.end) {
            next.push(kr);
          } else {
            if (cz.start > kr.start + 0.1) next.push({ start: kr.start, end: cz.start });
            if (cz.end < kr.end - 0.1) next.push({ start: cz.end, end: kr.end });
          }
        }
        keep = next;
      }

      // Ripple-Sync subtitle cues across kept ranges!
      const synced = [];
      let cursor = 0;
      for (const kr of keep) {
        for (const seg of this.segments) {
          if (seg.end <= kr.start || seg.start >= kr.end) continue;
          const ns = Math.max(seg.start, kr.start) - kr.start + cursor;
          const ne = Math.min(seg.end, kr.end) - kr.start + cursor;
          if (ne > ns + 0.05) {
            synced.push({
              start: Number(ns.toFixed(3)),
              end: Number(ne.toFixed(3)),
              text: seg.text,
              secondary_text: seg.secondary_text || '',
            });
          }
        }
        cursor += (kr.end - kr.start);
      }
      return { keepRanges: keep, rippleCues: synced };
    }

    async executeTrimCutRender() {
      if (this.rendering) return;
      let videoPath = this.localVideoPath;
      if (!videoPath) {
        videoPath = await this.host.pickLocalVideoForProject(this.projectId);
        if (!videoPath) return;
        this.localVideoPath = videoPath;
        this.loadVideoSource();
      }
      const { keepRanges, rippleCues } = this.computeKeepRangesAndRippleCues();
      if (!keepRanges.length) {
        this.host.showToast('ไม่มีช่วงวิดีโอที่เหลือให้ส่งออก', 'err');
        return;
      }

      const btn = $('btn-render-cut');
      this.rendering = true;
      btn.disabled = true;
      btn.textContent = '⏳ Cutting & Ripple-Syncing...';
      try {
        const res = await this.host.invokeCmd('render_trimmed_cut_video', {
          req: {
            video_path: videoPath,
            keep_ranges: keepRanges,
            burn_subtitles: $('cut-burn-subs').checked,
            cues: rippleCues,
            style: this.style,
            delogo: this.delogo,
            watermark: this.watermark,
            intro_path: this.branding.intro_path || null,
            outro_path: this.branding.outro_path || null,
          },
        });
        this.host.showToast(`✅ ตัดต่อพร้อม Ripple-Sync สำเร็จ (${res.encoder_used}): ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.rendering = false;
        btn.disabled = false;
        btn.textContent = window.DesktopI18n.t('btnRenderCut');
      }
    }

    async executeViralShortsRender() {
      if (this.rendering) return;
      let videoPath = this.localVideoPath;
      if (!videoPath) {
        videoPath = await this.host.pickLocalVideoForProject(this.projectId);
        if (!videoPath) return;
        this.localVideoPath = videoPath;
        this.loadVideoSource();
      }
      const dur = this._effectiveDuration();
      const startSec = this.inPoint != null ? this.inPoint : 0;
      const endSec = this.outPoint != null && this.outPoint > startSec + 1
        ? this.outPoint
        : Math.min(dur, startSec + 60);

      const btn = $('btn-render-shorts');
      this.rendering = true;
      btn.disabled = true;
      btn.textContent = '⏳ Rendering 9:16 Shorts...';
      try {
        const res = await this.host.invokeCmd('render_viral_shorts_916', {
          req: {
            video_path: videoPath,
            start_sec: startSec,
            end_sec: endSec,
            bg_mode: $('shorts-bg-mode').value,
            headline: $('shorts-headline').value.trim(),
            headline_color: $('shorts-headline-color').value,
            cues: this.segments,
            style: this.style,
            watermark: this.watermark,
          },
        });
        this.host.showToast(`📱 สร้างคลิปสั้น 9:16 สำเร็จ (${res.encoder_used}): ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.rendering = false;
        btn.disabled = false;
        btn.textContent = window.DesktopI18n.t('btnRenderShorts');
      }
    }

    renderGlossaryUI() {
      const sel = $('glossary-series-select');
      const list = $('glossary-rules-list');
      if (!sel || !list) return;

      const series = this.glossary.listSeries();
      sel.innerHTML = series
        .map((s) => `<option value="${escapeHtml(s)}" ${s === this.glossary.activeSeries ? 'selected' : ''}>${escapeHtml(s)}</option>`)
        .join('');

      const rules = this.glossary.getRules();
      if (!rules.length) {
        list.innerHTML = '<span class="muted">ยังไม่มีคำศัพท์ในเรื่องนี้ — พิมพ์เพิ่มด้านบน</span>';
        return;
      }
      list.innerHTML = rules
        .map((r, i) => `<span class="gloss-chip">${escapeHtml(r.wrong)} → <strong>${escapeHtml(r.right)}</strong><button type="button" class="gloss-del" data-gloss-del="${i}">×</button></span>`)
        .join('');
    }
  }

  window.DesktopSubtitleStudio = DesktopSubtitleStudio;
})();
