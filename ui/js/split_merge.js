(() => {
  'use strict';

  const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm4v', 'flv', 'wmv'];
  const ALL_MEDIA_EXTS = [...VIDEO_EXTS, 'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus'];
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
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = (s % 60).toFixed(1).padStart(4, '0');
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${r}`
      : `${String(m).padStart(2, '0')}:${r}`;
  }

  /**
   * Snap a desired split timestamp to the nearest inter-subtitle gap within +/- maxShift seconds
   * so dialogue sentences are never sliced mid-word.
   */
  function snapTimeToSubtitleGap(targetSec, segments, maxShift = 4.5) {
    if (!Array.isArray(segments) || !segments.length) return Number(targetSec.toFixed(3));
    const inside = segments.find((c) => targetSec > c.start + 0.08 && targetSec < c.end - 0.08);
    if (!inside) return Number(targetSec.toFixed(3));

    const candidates = [];
    for (let i = 0; i < segments.length; i++) {
      const c = segments[i];
      if (Math.abs(c.start - targetSec) <= maxShift) {
        const prevEnd = i > 0 ? segments[i - 1].end : Math.max(0, c.start - 0.1);
        candidates.push((prevEnd + c.start) / 2);
      }
      if (Math.abs(c.end - targetSec) <= maxShift) {
        const nextStart = i + 1 < segments.length ? segments[i + 1].start : c.end + 0.1;
        candidates.push((c.end + Math.min(nextStart, c.end + 0.25)) / 2);
      }
    }
    if (!candidates.length) return Number(targetSec.toFixed(3));
    candidates.sort((a, b) => Math.abs(a - targetSec) - Math.abs(b - targetSec));
    return Number(Math.max(0.2, candidates[0]).toFixed(3));
  }

  class DesktopSplitMergeManager {
    constructor(host, studio, localWorkspace) {
      this.host = host;
      this.studio = studio;
      this.localWorkspace = localWorkspace;
      this.splitMarkers = []; // sorted timestamps in seconds
      this.mergeClips = [];   // [{ id, path, name, duration, cues, subtitlePath }]
      this.nextClipId = 1;
      this.busy = false;
    }

    resetSplitMarkers() {
      this.splitMarkers = [];
      this.syncMarkersToStudio();
      this.renderSplitUI();
    }

    syncMarkersToStudio() {
      if (this.studio) {
        this.studio.splitMarkers = [...this.splitMarkers];
        this.studio.renderTimeline();
      }
    }

    addMarkerAtPlayhead() {
      const video = $('studio-video');
      const dur = this.studio ? this.studio._effectiveDuration() : 0;
      const t = video ? Number((video.currentTime || 0).toFixed(3)) : 0;
      if (dur <= 1 || t <= 0.4 || t >= dur - 0.4) {
        this.host.showToast('เลื่อน Playhead ไปจุดกลางคลิปก่อนกดวางเส้นตัด [B]', 'err');
        return;
      }
      const snap = $('split-smart-snap') ? $('split-smart-snap').checked : true;
      const finalT = snap
        ? snapTimeToSubtitleGap(t, this.studio ? this.studio.segments : [])
        : t;
      if (finalT <= 0.4 || finalT >= dur - 0.4) return;
      if (this.splitMarkers.some((m) => Math.abs(m - finalT) < 0.8)) {
        this.host.showToast('มีเส้นตัดใกล้จุดนี้อยู่แล้ว', 'info');
        return;
      }
      this.splitMarkers.push(finalT);
      this.splitMarkers.sort((a, b) => a - b);
      this.syncMarkersToStudio();
      this.renderSplitUI();
      this.host.showToast(`🔪 วางเส้นตัดที่ ${fmtSec(finalT)} (${this.splitMarkers.length + 1} ตอน)`, 'ok');
    }

    applyAutoSplitByMinutes() {
      const dur = this.studio ? this.studio._effectiveDuration() : 0;
      const mins = Math.max(0.25, Number($('split-every-mins')?.value || 3));
      const step = mins * 60;
      if (dur <= step + 2) {
        this.host.showToast(`คลิปยาว ${fmtSec(dur)} สั้นกว่าช่วงแบ่ง ${mins} นาที`, 'err');
        return;
      }
      const snap = $('split-smart-snap') ? $('split-smart-snap').checked : true;
      const markers = [];
      for (let t = step; t < dur - 2; t += step) {
        const m = snap ? snapTimeToSubtitleGap(t, this.studio ? this.studio.segments : []) : Number(t.toFixed(3));
        if (m > 0.5 && m < dur - 0.5 && !markers.some((x) => Math.abs(x - m) < 1.0)) {
          markers.push(m);
        }
      }
      this.splitMarkers = markers.sort((a, b) => a - b);
      this.syncMarkersToStudio();
      this.renderSplitUI();
      this.host.showToast(`⏱️ วางเส้นแบ่งอัตโนมัติ ${this.splitMarkers.length} จุด (${this.splitMarkers.length + 1} ตอน)`, 'ok');
    }

    applyAutoSplitEqualParts() {
      const dur = this.studio ? this.studio._effectiveDuration() : 0;
      const count = Math.max(2, Math.min(30, parseInt($('split-equal-count')?.value || '3', 10) || 3));
      if (dur < count * 2) {
        this.host.showToast('คลิปสั้นเกินกว่าจะแบ่งตามจำนวนตอนที่ระบุ', 'err');
        return;
      }
      const snap = $('split-smart-snap') ? $('split-smart-snap').checked : true;
      const step = dur / count;
      const markers = [];
      for (let i = 1; i < count; i++) {
        const raw = step * i;
        const m = snap ? snapTimeToSubtitleGap(raw, this.studio ? this.studio.segments : []) : Number(raw.toFixed(3));
        if (m > 0.5 && m < dur - 0.5 && !markers.some((x) => Math.abs(x - m) < 0.8)) {
          markers.push(m);
        }
      }
      this.splitMarkers = markers.sort((a, b) => a - b);
      this.syncMarkersToStudio();
      this.renderSplitUI();
      this.host.showToast(`✂️ แบ่งเท่าๆ กัน ${this.splitMarkers.length + 1} ตอนเรียบร้อย`, 'ok');
    }

    renderSplitUI() {
      const listEl = $('split-markers-list');
      const countEl = $('split-parts-badge');
      if (!listEl) return;
      const partCount = this.splitMarkers.length + 1;
      if (countEl) {
        countEl.textContent = this.splitMarkers.length
          ? `${this.splitMarkers.length} เส้นตัด → แยกเป็น ${partCount} ตอน`
          : 'ยังไม่ได้วางเส้นตัด (กดปุ่ม 🔪 หรือกดคีย์ B)';
      }
      if (!this.splitMarkers.length) {
        listEl.innerHTML = '';
        return;
      }
      listEl.innerHTML = this.splitMarkers
        .map((t, idx) => `
          <span class="split-marker-chip">
            <button type="button" class="split-marker-seek" data-split-seek="${t}" title="Jump to ${fmtSec(t)}">✂️ #${idx + 1} ${fmtSec(t)}</button>
            <button type="button" class="split-marker-del" data-split-del="${idx}" title="Remove">×</button>
          </span>
        `)
        .join('');
    }

    _buildSplitPartsPayload(dur) {
      const points = [0, ...this.splitMarkers.filter((t) => t > 0.3 && t < dur - 0.3), dur];
      const segs = this.studio ? this.studio.segments || [] : [];
      const parts = [];
      for (let i = 0; i < points.length - 1; i++) {
        const start = Number(points[i].toFixed(3));
        const end = Number(points[i + 1].toFixed(3));
        if (end - start < 0.3) continue;
        const partCues = [];
        for (const c of segs) {
          const ovStart = Math.max(start, c.start);
          const ovEnd = Math.min(end, c.end);
          if (ovEnd - ovStart >= 0.08) {
            partCues.push({
              start: Number((ovStart - start).toFixed(3)),
              end: Number((ovEnd - start).toFixed(3)),
              text: c.text || '',
              secondary_text: c.secondary_text || '',
            });
          }
        }
        parts.push({ index: parts.length + 1, start, end, cues: partCues });
      }
      return parts;
    }

    async executeSplitParts() {
      if (this.busy) return;
      if (!this.splitMarkers.length) {
        this.host.showToast('กรุณาวางเส้นตัดอย่างน้อย 1 จุด หรือกดปุ่มแบ่งอัตโนมัติก่อน', 'err');
        return;
      }
      let videoPath = this.studio ? this.studio.localVideoPath : '';
      if (!videoPath) {
        videoPath = await this.host.pickLocalVideoForProject(this.studio.projectId);
        if (!videoPath) return;
        this.studio.localVideoPath = videoPath;
        this.studio.loadVideoSource();
      }
      const dur = this.studio._effectiveDuration();
      const parts = this._buildSplitPartsPayload(dur);
      if (parts.length < 2) {
        this.host.showToast('ช่วงเวลาแบ่งไม่เพียงพอสำหรับแยกไฟล์', 'err');
        return;
      }

      const mode = $('split-mode-select')?.value || 'lossless';
      const burnSubs = mode === 'precision_hardsub';
      const actualMode = mode === 'lossless' ? 'lossless' : 'precision';
      const addToLocal = $('split-add-local') ? $('split-add-local').checked : true;

      const btn = $('btn-run-split');
      this.busy = true;
      if (btn) { btn.disabled = true; btn.textContent = `⏳ กำลังแยก ${parts.length} ตอน...`; }
      try {
        const res = await this.host.invokeCmd('split_media_parts', {
          req: {
            video_path: videoPath,
            output_dir: null,
            parts,
            mode: actualMode,
            burn_subs: burnSubs,
            save_srt: true,
            save_vtt: false,
            style: this.studio.style,
            delogo: this.studio.delogo,
            watermark: this.studio.watermark,
          },
        });
        if (addToLocal && this.localWorkspace && Array.isArray(res.parts)) {
          await this.localWorkspace.addMediaPaths(res.parts.map((p) => p.video_path));
        }
        this.host.showToast(
          `✂️ แยกไฟล์สำเร็จ ${res.parts.length} ตอน (${res.mode}) พร้อมซับ .SRT ในโฟลเดอร์ ${this.host.getFileName(res.output_dir)}`,
          'ok'
        );
        if (res.parts && res.parts[0]) {
          await this.host.invokeCmd('reveal_in_folder', { filePath: res.parts[0].video_path }).catch(() => {});
        }
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.busy = false;
        if (btn) { btn.disabled = false; btn.textContent = window.DesktopI18n.t('btnRunSplit'); }
      }
    }

    async executeDemux(trackType) {
      if (this.busy) return;
      let videoPath = this.studio ? this.studio.localVideoPath : '';
      if (!videoPath) {
        videoPath = await this.host.pickLocalVideoForProject(this.studio.projectId);
        if (!videoPath) return;
        this.studio.localVideoPath = videoPath;
        this.studio.loadVideoSource();
      }
      this.busy = true;
      this.host.showToast('⏳ กำลังแยกแทร็กไฟล์ด้วย Built-in FFmpeg...', 'info');
      try {
        const res = await this.host.invokeCmd('demux_extract_track', {
          req: { video_path: videoPath, track_type: trackType, output_path: null },
        });
        this.host.showToast(`✅ แยกแทร็กสำเร็จ: ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.busy = false;
      }
    }

    // =========================================================================
    // PRO MULTI-CLIP MERGE MODAL (VIDEO + AUTO-STITCHED SUBTITLES)
    // =========================================================================
    openMergeModal(seedVideoPath = '', seedCues = null) {
      if (seedVideoPath && !this.mergeClips.some((c) => c.path === seedVideoPath)) {
        this.addMergePaths([seedVideoPath], seedCues ? { [seedVideoPath]: seedCues } : null);
      } else {
        this.renderMergeModal();
      }
      const modal = $('modal-merge-clips');
      if (modal) modal.classList.remove('hidden');
    }

    async addMergePaths(paths, overrideCuesMap = null) {
      if (!Array.isArray(paths) || !paths.length) return;
      for (const raw of paths) {
        const p = String(raw || '').trim();
        if (!p) continue;
        let duration = 0;
        let cues = overrideCuesMap && overrideCuesMap[p] ? overrideCuesMap[p] : [];
        let subtitlePath = '';
        try {
          const info = await this.host.invokeCmd('probe_media_info', { filePath: p });
          duration = Number(info.duration_seconds) || 0;
        } catch (_) {}

        if (!cues.length && window.DesktopSubtitleParser) {
          try {
            const adj = await this.host.invokeCmd('find_adjacent_subtitle', { videoPath: p });
            if (adj) {
              const rawSub = await this.host.invokeCmd('read_text_file', { filePath: adj });
              cues = window.DesktopSubtitleParser.parseSubtitleText(rawSub);
              subtitlePath = adj;
            }
          } catch (_) {}
        }

        this.mergeClips.push({
          id: this.nextClipId++,
          path: p,
          name: this.host.getFileName(p),
          duration,
          cues,
          subtitlePath,
        });
      }
      this.renderMergeModal();
    }

    async pickMergeFilesFromDisk() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: true,
          title: 'เลือกไฟล์วิดีโอเพื่อนำมารวมกัน (เลือกได้หลายไฟล์)',
          filters: [{ name: 'Video Files', extensions: ALL_MEDIA_EXTS }],
        });
        if (!sel) return;
        await this.addMergePaths(Array.isArray(sel) ? sel : [sel]);
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    addSelectedLocalProjectToMerge() {
      const sel = $('merge-local-picker');
      if (!sel || !sel.value || !this.localWorkspace) return;
      const proj = this.localWorkspace.getById(sel.value);
      if (!proj || !proj.videoPath) return;
      this.mergeClips.push({
        id: this.nextClipId++,
        path: proj.videoPath,
        name: proj.name || this.host.getFileName(proj.videoPath),
        duration: Number(proj.durationSeconds || proj.duration) || 0,
        cues: Array.isArray(proj.segments) ? proj.segments : [],
        subtitlePath: proj.subtitlePath || '',
      });
      this.renderMergeModal();
    }

    renderMergeModal() {
      const list = $('merge-clips-list');
      const summary = $('merge-summary-box');
      const localSel = $('merge-local-picker');
      const runBtn = $('merge-run-btn');
      if (!list) return;

      if (localSel && this.localWorkspace) {
        const projs = this.localWorkspace.projects || [];
        localSel.innerHTML = projs.length
          ? projs.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${p.segments?.length || 0} cues)</option>`).join('')
          : '<option value="">— ยังไม่มี Local Project —</option>';
      }

      const mode = $('merge-mode-select')?.value || 'lossless';
      const conformWrap = $('merge-conform-opts');
      if (conformWrap) conformWrap.classList.toggle('hidden', mode !== 'conform');

      if (!this.mergeClips.length) {
        list.innerHTML = '<div class="empty-state" style="padding:18px;">ยังไม่มีคลิปในรายการ — กด “➕ เลือกไฟล์จากเครื่อง” หรือเพิ่มจาก Local Workspace ด้านบน</div>';
        if (summary) summary.textContent = '0 คลิป • เวลารวม 00:00 • ซับที่จะต่อรวม 0 บรรทัด';
        if (runBtn) runBtn.disabled = true;
        return;
      }

      let totalDur = 0;
      let totalCues = 0;
      list.innerHTML = this.mergeClips
        .map((c, idx) => {
          totalDur += Number(c.duration) || 0;
          totalCues += c.cues ? c.cues.length : 0;
          return `
            <div class="merge-clip-row">
              <span class="mono-tag">#${idx + 1}</span>
              <div class="merge-clip-info">
                <div class="merge-clip-name" title="${escapeHtml(c.path)}">${escapeHtml(c.name)}</div>
                <div class="muted" style="font-size:11px;">
                  ⏱ ${fmtSec(c.duration)} • ${c.cues && c.cues.length ? `<span style="color:#4ade80;">💬 ซับ ${c.cues.length} บรรทัด</span>` : 'ไม่มีซับ'}
                </div>
              </div>
              <div class="merge-clip-actions">
                <button type="button" class="btn btn-ghost btn-xs" data-merge-up="${idx}" ${idx === 0 ? 'disabled' : ''} title="Move Up">▲</button>
                <button type="button" class="btn btn-ghost btn-xs" data-merge-down="${idx}" ${idx === this.mergeClips.length - 1 ? 'disabled' : ''} title="Move Down">▼</button>
                <button type="button" class="btn btn-danger-ghost btn-xs" data-merge-del="${idx}" title="Remove">✕</button>
              </div>
            </div>
          `;
        })
        .join('');

      if (summary) {
        summary.innerHTML = `รวมทั้งหมด <strong>${this.mergeClips.length} คลิป</strong> • ความยาวรวม <strong>${fmtSec(totalDur)}</strong> • ต่อซับอัตโนมัติ <strong>${totalCues} บรรทัด</strong>`;
      }
      if (runBtn) runBtn.disabled = this.mergeClips.length < 2 || this.busy;
    }

    async executeMerge() {
      if (this.busy || this.mergeClips.length < 2) return;
      const mode = $('merge-mode-select')?.value || 'lossless';
      const targetRes = $('merge-res-select')?.value || 'original';
      const transition = $('merge-trans-select')?.value || 'none';
      const openStudio = $('merge-open-studio') ? $('merge-open-studio').checked : true;

      const btn = $('merge-run-btn');
      this.busy = true;
      if (btn) { btn.disabled = true; btn.textContent = `⏳ กำลังรวม ${this.mergeClips.length} คลิป...`; }
      try {
        const res = await this.host.invokeCmd('merge_media_clips', {
          req: {
            clips: this.mergeClips.map((c) => ({
              video_path: c.path,
              cues: c.cues || [],
            })),
            output_path: null,
            mode,
            target_resolution: mode === 'conform' ? targetRes : 'original',
            transition: mode === 'conform' ? transition : 'none',
            save_merged_srt: true,
            save_merged_vtt: false,
            bilingual_enabled: this.studio ? !!this.studio.style.bilingual_enabled : false,
          },
        });

        this.host.showToast(
          `🔗 รวม ${res.clip_count} คลิปสำเร็จ (${res.mode} / ${res.encoder_used})${res.srt_path ? ` + ต่อซับ ${res.merged_cues.length} บรรทัด` : ''}!`,
          'ok'
        );

        const modal = $('modal-merge-clips');
        if (modal) modal.classList.add('hidden');

        if (this.localWorkspace) {
          await this.localWorkspace.addMediaPaths([res.output_path]);
          const created = this.localWorkspace.projects.find((p) => p.videoPath === res.output_path);
          if (created && res.merged_cues && res.merged_cues.length && !created.segments.length) {
            this.localWorkspace.updateSegments(created.id, res.merged_cues, res.srt_path || '');
          }
          if (openStudio && created && this.studio) {
            await this.studio.openLocalProject(created);
          }
        }
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.busy = false;
        if (btn) { btn.disabled = this.mergeClips.length < 2; btn.textContent = window.DesktopI18n.t('btnStartMerge'); }
      }
    }

    bindEvents() {
      $('local-merge-btn')?.addEventListener('click', () => this.openMergeModal());
      $('studio-open-merge-btn')?.addEventListener('click', () => {
        if (this.studio && this.studio.localVideoPath) {
          this.openMergeModal(this.studio.localVideoPath, this.studio.segments);
        } else {
          this.openMergeModal();
        }
      });

      $('btn-add-split-marker')?.addEventListener('click', () => this.addMarkerAtPlayhead());
      $('wf-razor-split-btn')?.addEventListener('click', () => this.addMarkerAtPlayhead());
      $('btn-clear-split-markers')?.addEventListener('click', () => this.resetSplitMarkers());
      $('btn-auto-split-mins')?.addEventListener('click', () => this.applyAutoSplitByMinutes());
      $('btn-auto-split-equal')?.addEventListener('click', () => this.applyAutoSplitEqualParts());
      $('btn-run-split')?.addEventListener('click', () => this.executeSplitParts());

      $('btn-demux-mp3')?.addEventListener('click', () => this.executeDemux('audio_mp3'));
      $('btn-demux-wav')?.addEventListener('click', () => this.executeDemux('audio_wav'));
      $('btn-demux-mute')?.addEventListener('click', () => this.executeDemux('video_mute'));

      $('split-markers-list')?.addEventListener('click', (e) => {
        const seekBtn = e.target.closest('[data-split-seek]');
        if (seekBtn) {
          const video = $('studio-video');
          if (video) video.currentTime = Number(seekBtn.dataset.splitSeek) || 0;
          return;
        }
        const delBtn = e.target.closest('[data-split-del]');
        if (delBtn) {
          const idx = Number(delBtn.dataset.splitDel);
          this.splitMarkers.splice(idx, 1);
          this.syncMarkersToStudio();
          this.renderSplitUI();
        }
      });

      // Merge modal bindings
      $('merge-pick-files-btn')?.addEventListener('click', () => this.pickMergeFilesFromDisk());
      $('merge-add-local-btn')?.addEventListener('click', () => this.addSelectedLocalProjectToMerge());
      $('merge-clear-btn')?.addEventListener('click', () => { this.mergeClips = []; this.renderMergeModal(); });
      $('merge-mode-select')?.addEventListener('change', () => this.renderMergeModal());
      $('merge-run-btn')?.addEventListener('click', () => this.executeMerge());

      $('merge-clips-list')?.addEventListener('click', (e) => {
        const up = e.target.closest('[data-merge-up]');
        if (up) {
          const i = Number(up.dataset.mergeUp);
          if (i > 0) {
            [this.mergeClips[i - 1], this.mergeClips[i]] = [this.mergeClips[i], this.mergeClips[i - 1]];
            this.renderMergeModal();
          }
          return;
        }
        const dn = e.target.closest('[data-merge-down]');
        if (dn) {
          const i = Number(dn.dataset.mergeDown);
          if (i < this.mergeClips.length - 1) {
            [this.mergeClips[i + 1], this.mergeClips[i]] = [this.mergeClips[i], this.mergeClips[i + 1]];
            this.renderMergeModal();
          }
          return;
        }
        const del = e.target.closest('[data-merge-del]');
        if (del) {
          this.mergeClips.splice(Number(del.dataset.mergeDel), 1);
          this.renderMergeModal();
        }
      });

      // Keyboard shortcut [B] for Razor Split when in Studio
      window.addEventListener('keydown', (e) => {
        if (this.host.state.activeTab !== 'studio') return;
        const tag = (e.target && e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
          e.preventDefault();
          this.addMarkerAtPlayhead();
        }
      });

      this.renderSplitUI();
    }
  }

  window.DesktopSplitMergeManager = DesktopSplitMergeManager;

  // =========================================================================
  // PHASE 1A: AI VIRAL SHORTS STUDIO (Hybrid Local Free + Cloud AI Director)
  // Bundled inside split_merge.js so existing v1.10.x & v1.11.0 apps receive
  // the full AI Shorts Studio immediately via Signed UI Hot-Patch!
  // =========================================================================
  const SHORTS_STYLES = {
    podcast: {
      hookWords: ['ทำไม', 'รู้ไหม', 'ความจริง', 'ความลับ', 'ปัญหาคือ', 'คนส่วนใหญ่', 'ผิดพลาด', 'อย่าเพิ่ง', 'สิ่งสำคัญ', 'คำแนะนำ', 'บทเรียน', 'เรื่องจริง', 'why', 'how', 'secret', 'mistake'],
      valueWords: ['เพราะว่า', 'วิธี', 'เทคนิค', 'เคล็ดลับ', 'ข้อคิด', 'ประสบการณ์', 'เปลี่ยนชีวิต', 'สำเร็จ', 'เข้าใจ', 'ต่างกัน', 'สรุปคือ', 'หลักการ', 'แนะนำ', 'สำคัญมาก'],
      hashtags: ['#พอดแคสต์', '#ข้อคิดดีๆ', '#พัฒนาตัวเอง', '#สาระน่ารู้', '#shorts'],
      prefixes: ['ความจริงที่หลายคนไม่รู้:', 'ฟังให้จบ!', 'ข้อคิดเด็ด:'],
    },
    product: {
      hookWords: ['คุ้ม', 'ลดราคา', 'โปร', 'รีวิว', 'ของมันต้องมี', 'ห้ามพลาด', 'ใช้ดี', 'เปรียบเทียบ', 'ราคา', 'บาท', 'ฟรี', 'ลองใช้', 'ป้ายยา', 'ประหยัด', 'แก้ปัญหา', 'ตัวจบ'],
      valueWords: ['คุณภาพ', 'ทนทาน', 'สะดวก', 'เร็ว', 'สวย', 'ชัด', 'ประกัน', 'ส่งฟรี', 'แนะนำ', 'พิกัด', 'ตะกร้า', 'ซื้อซ้ำ', 'คุ้มค่า', 'ประทับใจ', 'ผลลัพธ์'],
      hashtags: ['#รีวิวของดี', '#ป้ายยา', '#ของมันต้องมี', '#tiktokshop', '#รีวิว'],
      prefixes: ['ป้ายยาตัวจบ!', 'คุ้มจริงไหม?', 'รีวิวจริงไม่จกตา:'],
    },
    story: {
      hookWords: ['รู้หรือไม่', 'เกิดอะไรขึ้น', 'ช็อก', 'ล่าสุด', 'เปิดเผย', 'เบื้องหลัง', 'ประวัติ', 'เรื่องราว', 'เหตุผล', 'อันดับ', 'วิธี', 'ขั้นตอน', 'สรุป', 'เตือนภัย', 'ระวัง', 'ห้ามทำ'],
      valueWords: ['ปรากฏว่า', 'สุดท้าย', 'กลายเป็น', 'สาเหตุ', 'ผลกระทบ', 'ข้อมูล', 'ตัวเลข', 'สถิติ', 'วิจัย', 'ค้นพบ', 'เปลี่ยนแปลง', 'อนาคต', 'สำคัญ', 'ข้อเท็จจริง'],
      hashtags: ['#เล่าเรื่อง', '#สาระความรู้', '#สรุปให้ฟัง', '#เรื่องเล่า', '#fyp'],
      prefixes: ['รู้หรือไม่?', 'สรุปจบในคลิปเดียว:', 'เบื้องหลังที่ต้องรู้:'],
    },
    drama: {
      hookWords: ['ทำไมทำแบบนี้', 'โกหก', 'หักหลัง', 'ความจริง', 'รัก', 'เกลียด', 'แค้น', 'พอที', 'หยุด', 'ไม่ยอม', 'สารภาพ', 'ตาย', 'หนี', 'ช่วยด้วย', 'ช็อก', 'หลอก', 'เอาคืน', 'พีค'],
      valueWords: ['น้ำตา', 'เสียใจ', 'ขอโทษ', 'สัญญา', 'ความลับ', 'เปิดโปง', 'หลักฐาน', 'จับได้', 'สะใจ', 'ซึ้ง', 'หัวใจ', 'คนรัก', 'ศัตรู', 'เด็ดขาด', 'สุดยอด', 'ฮา'],
      hashtags: ['#ไฮไลต์ละคร', '#ซีรีส์น่าดู', '#ฉากเด็ด', '#ละครดัง', '#shorts'],
      prefixes: ['ฉากพีคสุดเดือด!', 'ดูให้จบมีอึ้ง:', 'ช็อตเด็ดห้ามพลาด:'],
    },
  };

  const SHORTS_DUR_BOUNDS = {
    '15-30': [14, 32, 23],
    '30-60': [26, 62, 44],
    '60-90': [52, 92, 72],
  };

  const SHORTS_PRESETS = {
    clean: {
      font_family: 'Noto Sans Thai',
      font_size: 46,
      font_weight: 700,
      text_color: '#ffffff',
      bg_color: '#000000',
      bg_opacity: 0.62,
      stroke_width: 0,
      shadow_depth: 1,
      align: 'center',
      position_y: 80,
    },
    bold: {
      font_family: 'Prompt',
      font_size: 52,
      font_weight: 800,
      text_color: '#ffffff',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_width: 4,
      shadow_depth: 3,
      align: 'center',
      position_y: 80,
    },
    yellow: {
      font_family: 'Prompt',
      font_size: 54,
      font_weight: 800,
      text_color: '#fde047',
      bg_color: '#000000',
      bg_opacity: 0.0,
      stroke_width: 4,
      shadow_depth: 3,
      align: 'center',
      position_y: 80,
    },
    cinema: {
      font_family: 'Noto Sans Thai',
      font_size: 44,
      font_weight: 700,
      text_color: '#f8fafc',
      bg_color: '#0f172a',
      bg_opacity: 0.78,
      stroke_width: 1,
      shadow_depth: 2,
      align: 'center',
      position_y: 82,
    },
  };

  function smartThaiWrap(text, maxChars = 20) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length <= maxChars) return clean;
    let tokens = null;
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('th', { granularity: 'word' });
        tokens = Array.from(seg.segment(clean), (x) => x.segment);
      }
    } catch (_) {}
    if (!tokens || !tokens.length) tokens = clean.split(/(\s+)/);
    const lines = [];
    let cur = '';
    for (const tk of tokens) {
      if ((cur + tk).trim().length > maxChars && cur.trim().length > 0) {
        lines.push(cur.trim());
        cur = tk.trimStart();
      } else {
        cur += tk;
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.slice(0, 2).join('\n');
  }

  function extractShortHeadline(text, maxLen = 34) {
    const parts = String(text || '').split(/[.!?\n,]+/).map((p) => p.trim()).filter((p) => p.length >= 6);
    let lead = (parts[0] || String(text || '').trim())
      .replace(/^(เอ่อ|อืม|คือ|ก็|แบบว่า|นะครับ|นะคะ)\s*/, '')
      .trim();
    if (lead.length > maxLen) lead = `${lead.slice(0, maxLen - 1).trim()}…`;
    return lead || 'ช็อตเด็ดห้ามพลาด';
  }

  function localAnalyzeViralClips(rawCues, style, targetDur, clipCount, videoTitle) {
    const cfg = SHORTS_STYLES[style] || SHORTS_STYLES.podcast;
    const [minDur, maxDur, idealDur] = SHORTS_DUR_BOUNDS[targetDur] || SHORTS_DUR_BOUNDS['30-60'];
    const cues = (rawCues || [])
      .map((c) => ({ start: Math.max(0, Number(c.start) || 0), end: Math.max(0.2, Number(c.end) || 0), text: String(c.text || '').trim() }))
      .filter((c) => c.text && c.end > c.start)
      .sort((a, b) => a.start - b.start);
    if (!cues.length) return [];

    const totalDur = cues[cues.length - 1].end - cues[0].start;
    const scoreWin = (win) => {
      const s = win[0].start;
      const e = win[win.length - 1].end;
      const dur = Math.max(1, e - s);
      const full = win.map((c) => c.text).join(' ');
      const low = full.toLowerCase();
      const openTxt = win.filter((c) => c.start <= s + 4.5).map((c) => c.text).join(' ').toLowerCase();
      const closeTxt = win[win.length - 1].text;

      const hookHits = cfg.hookWords.filter((w) => openTxt.includes(w)).length;
      const hasQ = /[?？]|ทำไม|ไหม|มั้ย|ยังไง|หรือเปล่า/.test(openTxt);
      const hasNum = /\d+/.test(openTxt);
      const hookScore = Math.max(50, Math.min(98, Math.round(62 + Math.min(24, hookHits * 9) + (hasQ ? 8 : 0) + (hasNum ? 5 : 0))));

      const cps = full.replace(/\s+/g, '').length / dur;
      let cpsPen = 0;
      if (cps < 6) cpsPen = (6 - cps) * 4.5;
      else if (cps > 26) cpsPen = (cps - 26) * 2;
      let longGaps = 0;
      for (let i = 0; i < win.length - 1; i++) {
        if (win[i + 1].start - win[i].end > 2.2) longGaps++;
      }
      const durDiff = Math.abs(dur - idealDur) / Math.max(10, idealDur);
      const flowScore = Math.max(52, Math.min(97, Math.round(92 - cpsPen - longGaps * 5.5 - durDiff * 14)));

      const valHits = cfg.valueWords.filter((w) => low.includes(w)).length;
      const allHook = cfg.hookWords.filter((w) => low.includes(w)).length;
      const emotionScore = Math.max(52, Math.min(98, Math.round(60 + Math.min(22, valHits * 5) + Math.min(12, allHook * 3))));

      const cleanEnd = /(ครับ|ค่ะ|นะคะ|นะครับ|เลย|จริง|นะ|กัน|ไหม|มั้ย|[!?.])$/.test(closeTxt) || closeTxt.length >= 12;
      const endingScore = Math.max(52, Math.min(96, Math.round(76 + (cleanEnd ? 14 : -6) + (win.length >= 4 ? 4 : 0))));
      const viralScore = Math.max(58, Math.min(98, Math.round(hookScore * 0.32 + flowScore * 0.23 + emotionScore * 0.28 + endingScore * 0.17)));

      const reasons = [];
      if (hookScore >= 80) reasons.push('เปิดประโยค 3 วิแรกชวนหยุดดู');
      if (emotionScore >= 78) reasons.push('มีประเด็น/อารมณ์เข้มข้นตรงสไตล์');
      if (flowScore >= 82) reasons.push('จังหวะพูดกระชับต่อเนื่อง');
      if (endingScore >= 84) reasons.push('จบประโยคลงตัวไม่ตัดห้วน');
      if (!reasons.length) reasons.push('เนื้อหาครบประเด็น เหมาะตัดเป็นคลิปสั้น 9:16');

      const lead = win[0].text + (win[1] ? ` ${win[1].text}` : '');
      const sn = extractShortHeadline(lead, 34);
      const vt = extractShortHeadline(videoTitle || sn, 26);
      const hookOptions = [
        `${cfg.prefixes[0]} ${sn}`,
        `${cfg.prefixes[1]} ${sn}`,
        `${cfg.prefixes[2]} ${vt}`,
      ].map((x) => (x.length > 54 ? `${x.slice(0, 53).trim()}…` : x));

      return {
        start: Number(s.toFixed(2)),
        end: Number(e.toFixed(2)),
        duration: Number(dur.toFixed(2)),
        viral_score: viralScore,
        hook_score: hookScore,
        flow_score: flowScore,
        emotion_score: emotionScore,
        ending_score: endingScore,
        title: hookOptions[0],
        hook_options: hookOptions,
        reason: reasons.slice(0, 3).join(' • '),
        caption: `${hookOptions[0]}\n\n${cfg.hashtags.join(' ')}`,
        hashtags: cfg.hashtags,
        excerpt: full.slice(0, 200),
      };
    };

    if (totalDur <= minDur + 4) {
      return [{ id: 'clip-1', selected: true, ...scoreWin(cues) }];
    }

    const candidates = [];
    const n = cues.length;
    const step = Math.max(1, Math.floor(n / 100));
    for (let i = 0; i < n; i += step) {
      const sTime = cues[i].start;
      let bestJ = -1;
      let bestDist = 9999;
      for (let j = i; j < n; j++) {
        const d = cues[j].end - sTime;
        if (d >= minDur) {
          if (d > maxDur) break;
          const pauseBonus = j + 1 < n && cues[j + 1].start - cues[j].end >= 0.35 ? 2.0 : 0;
          const dist = Math.abs(d - idealDur) - pauseBonus;
          if (dist < bestDist) {
            bestDist = dist;
            bestJ = j;
          }
        }
      }
      if (bestJ > i) {
        candidates.push(scoreWin(cues.slice(i, bestJ + 1)));
      }
    }

    candidates.sort((a, b) => (b.viral_score - a.viral_score) || (b.hook_score - a.hook_score));
    const picked = [];
    for (const c of candidates) {
      if (picked.length >= clipCount) break;
      const overlap = picked.some((p) => {
        const inter = Math.max(0, Math.min(c.end, p.end) - Math.max(c.start, p.start));
        return inter / Math.max(1, Math.min(c.duration, p.duration)) > 0.18;
      });
      if (!overlap) picked.push(c);
    }
    if (!picked.length) picked.push(scoreWin(cues.slice(0, Math.min(cues.length, 25))));
    return picked.map((item, idx) => ({ id: `clip-${idx + 1}`, selected: idx < 3, ...item }));
  }

  class DesktopShortsStudio {
    constructor(host, studio, localWorkspace) {
      this.host = host;
      this.studio = studio;
      this.localWorkspace = localWorkspace;
      this.mode = 'local_fast'; // 'local_fast' | 'cloud_ai'
      this.bgMode = 'blur';
      this.headlineColor = '#fde047';
      this.presetKey = 'yellow';
      this.safeZoneOn = true;
      this.karaokeOn = true;
      this.lineBreakOn = true;
      this.sources = [];
      this.activeSource = null;
      this.clips = [];
      this.activeClipIdx = 0;
      this.busy = false;
      this._bound = false;
    }

    fmtClock(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    collectSources() {
      const out = [];
      const seen = new Set();
      if (this.studio && this.studio.project && Array.isArray(this.studio.segments) && this.studio.segments.length) {
        const id = `studio:${this.studio.project.id || 'active'}`;
        seen.add(id);
        out.push({
          key: id,
          kind: 'studio',
          title: this.studio.project.title || this.studio.project.filename || 'โปรเจกต์ปัจจุบันใน Studio',
          videoPath: this.studio.localVideoPath || this.studio.project.videoPath || '',
          segments: this.studio.segments,
          duration: this.studio._effectiveDuration ? this.studio._effectiveDuration() : 0,
          localProject: this.studio.project,
        });
      }
      if (this.localWorkspace && Array.isArray(this.localWorkspace.projects)) {
        for (const p of this.localWorkspace.projects) {
          if (!Array.isArray(p.segments) || !p.segments.length) continue;
          const key = `local:${p.id}`;
          if (this.studio && this.studio.project && this.studio.project.id === p.id) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            key,
            kind: 'local',
            title: p.title || this.host.getFileName(p.videoPath || 'Local Project'),
            videoPath: p.videoPath || '',
            segments: p.segments,
            duration: Number(p.duration) || 0,
            localProject: p,
          });
        }
      }
      this.sources = out;
      return out;
    }

    onTabShown() {
      this.refreshSourcesUI();
    }

    refreshSourcesUI() {
      const sources = this.collectSources();
      const sel = $('shorts-source-select');
      const emptyEl = $('shorts-empty-state');
      const wsEl = $('shorts-workspace');

      if (!sources.length) {
        if (sel) sel.innerHTML = '<option value="">— ยังไม่มีโปรเจกต์ที่มีซับ —</option>';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (wsEl) wsEl.classList.add('hidden');
        this.activeSource = null;
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');
      if (wsEl) wsEl.classList.remove('hidden');

      if (sel) {
        const prevKey = this.activeSource ? this.activeSource.key : '';
        sel.innerHTML = sources
          .map((s) => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.title)} (${s.segments.length} ซับ)</option>`)
          .join('');
        const found = sources.find((s) => s.key === prevKey) || sources[0];
        sel.value = found.key;
        const changed = !this.activeSource || this.activeSource.key !== found.key;
        this.activeSource = found;
        if (changed) {
          this.loadPreviewMedia();
          this.runAnalysis(true);
        }
      }
    }

    loadPreviewMedia() {
      const fg = $('shorts-preview-video');
      const bg = $('shorts-preview-bg');
      if (!fg) return;
      const srcPath = this.activeSource && this.activeSource.videoPath ? this.activeSource.videoPath : '';
      if (!srcPath) {
        fg.removeAttribute('src');
        if (bg) bg.removeAttribute('src');
        return;
      }
      const url = /^https?:|^blob:|^asset:|^tauri:/i.test(srcPath)
        ? srcPath
        : (this.host.toAssetUrl ? this.host.toAssetUrl(srcPath) : srcPath);
      if (fg.src !== url) {
        fg.src = url;
        fg.load();
      }
      if (bg && bg.src !== url) {
        bg.src = url;
        bg.load();
      }
    }

    async runAnalysis(silentAuto = false) {
      if (!this.activeSource || !this.activeSource.segments.length) {
        if (!silentAuto) this.host.showToast('กรุณาเลือกโปรเจกต์ที่มีซับไตเติลก่อนครับ', 'err');
        return;
      }
      const btn = $('shorts-analyze-btn');
      const badge = $('shorts-engine-badge');
      const style = ($('shorts-style-select') && $('shorts-style-select').value) || 'podcast';
      const targetDur = ($('shorts-dur-select') && $('shorts-dur-select').value) || '30-60';
      const clipCount = Number(($('shorts-count-select') && $('shorts-count-select').value) || 5);

      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ กำลังวิเคราะห์...';
      }

      try {
        if (this.mode === 'cloud_ai' && !silentAuto) {
          if (!this.host.state.token) {
            this.host.showToast('กรุณาเข้าสู่ระบบก่อนใช้ Cloud AI Director — สลับใช้โหมดออฟไลน์ฟรีให้แทนครับ', 'info');
            this.setMode('local_fast');
          } else {
            const resp = await fetch(`${this.host.state.apiBase}/v1/shorts/analyze`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.host.state.token}`,
              },
              body: JSON.stringify({
                segments: this.activeSource.segments.map((c) => ({ start: c.start, end: c.end, text: c.text })),
                title: this.activeSource.title,
                duration_sec: this.activeSource.duration || 0,
                style,
                target_duration: targetDur,
                clip_count: clipCount,
                mode: 'cloud_ai',
                language: 'th',
              }),
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.status === 402) {
              this.host.showToast(data.detail || 'เครดิตไม่เพียงพอสำหรับ Cloud AI Director', 'err');
              if (this.host.openTopupPage) this.host.openTopupPage();
              return;
            }
            if (!resp.ok || !Array.isArray(data.clips) || !data.clips.length) {
              throw new Error(data.detail || `Cloud AI Error (${resp.status})`);
            }
            this.clips = data.clips.map((c, idx) => ({ selected: idx < 3, ...c }));
            if (badge) {
              badge.textContent = data.billed_thb > 0
                ? `☁️ ${data.engine_label} (฿${Number(data.billed_thb).toFixed(2)})`
                : `✨ ${data.engine_label}`;
            }
            if (this.host.refreshProfile) this.host.refreshProfile(true).catch(() => {});
            this.activeClipIdx = 0;
            this.renderClipsList();
            this.selectClip(0);
            this.host.showToast(`🔥 วิเคราะห์พบ ${this.clips.length} ช็อตเด็ดแล้ว!`, 'ok');
            return;
          }
        }

        // Local Free Viral Intelligence Engine (Zero upload, instant)
        this.clips = localAnalyzeViralClips(
          this.activeSource.segments,
          style,
          targetDur,
          clipCount,
          this.activeSource.title
        );
        if (badge) badge.textContent = '💻 ออฟไลน์ฟรี (ไม่หักเครดิต)';
        this.activeClipIdx = 0;
        this.renderClipsList();
        this.selectClip(0);
        if (!silentAuto) {
          this.host.showToast(`🔥 คัดช็อตเด็ดออฟไลน์พบ ${this.clips.length} คลิปพร้อมส่งออก!`, 'ok');
        }
      } catch (err) {
        // Auto-fallback to Local Free Engine so user is never blocked
        this.clips = localAnalyzeViralClips(
          this.activeSource.segments,
          style,
          targetDur,
          clipCount,
          this.activeSource.title
        );
        if (badge) badge.textContent = '💻 ออฟไลน์ฟรี (Fallback อัตโนมัติ)';
        this.activeClipIdx = 0;
        this.renderClipsList();
        this.selectClip(0);
        this.host.showToast(`เชื่อมต่อ Cloud ไม่สำเร็จ — คัดช็อตด้วยโหมดออฟไลน์ฟรีให้แทน (${err.message || err})`, 'info');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔥 วิเคราะห์หาช็อตเด็ด';
        }
      }
    }

    setMode(m) {
      this.mode = m === 'cloud_ai' ? 'cloud_ai' : 'local_fast';
      document.querySelectorAll('.shorts-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.shortsMode === this.mode);
      });
    }

    renderClipsList() {
      const list = $('shorts-clips-list');
      const head = $('shorts-list-heading');
      if (head) head.textContent = `🔥 AI Viral Highlights (${this.clips.length} คลิป)`;
      if (!list) return;

      if (!this.clips.length) {
        list.innerHTML = '<div class="muted" style="padding:16px;text-align:center;">กดปุ่ม "🔥 วิเคราะห์หาช็อตเด็ด" ด้านบนเพื่อเริ่มคัดคลิปสั้น</div>';
        this.updateBatchBtn();
        return;
      }

      list.innerHTML = this.clips
        .map((c, idx) => {
          const isActive = idx === this.activeClipIdx;
          return `
            <div class="shorts-clip-card ${isActive ? 'active' : ''}" data-clip-idx="${idx}">
              <div class="shorts-clip-top">
                <label class="shorts-clip-check-wrap" data-stop-select="1">
                  <input type="checkbox" class="shorts-clip-check" data-check-idx="${idx}" ${c.selected ? 'checked' : ''} />
                  <span>#${idx + 1} • ${this.fmtClock(c.start)}–${this.fmtClock(c.end)} (${Math.round(c.duration)}วิ)</span>
                </label>
                <span class="shorts-score-badge">Viral ${c.viral_score}/100</span>
              </div>
              <div class="shorts-clip-title">${escapeHtml(c.title)}</div>
              <div class="shorts-clip-reason">${escapeHtml(c.reason || '')}</div>
              <div class="shorts-metrics-grid">
                <div class="shorts-metric-item">
                  <div class="shorts-metric-lbl"><span>Hook 3วิ</span><span>${c.hook_score}</span></div>
                  <div class="shorts-metric-track"><div class="shorts-metric-fill" style="width:${c.hook_score}%"></div></div>
                </div>
                <div class="shorts-metric-item">
                  <div class="shorts-metric-lbl"><span>อารมณ์/คุณค่า</span><span>${c.emotion_score}</span></div>
                  <div class="shorts-metric-track"><div class="shorts-metric-fill" style="width:${c.emotion_score}%"></div></div>
                </div>
                <div class="shorts-metric-item">
                  <div class="shorts-metric-lbl"><span>Flow จังหวะ</span><span>${c.flow_score}</span></div>
                  <div class="shorts-metric-track"><div class="shorts-metric-fill" style="width:${c.flow_score}%"></div></div>
                </div>
                <div class="shorts-metric-item">
                  <div class="shorts-metric-lbl"><span>จบคม</span><span>${c.ending_score}</span></div>
                  <div class="shorts-metric-track"><div class="shorts-metric-fill" style="width:${c.ending_score}%"></div></div>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
      this.updateBatchBtn();
    }

    updateBatchBtn() {
      const cnt = this.clips.filter((c) => c.selected).length;
      const btn = $('shorts-batch-export-btn');
      if (btn) {
        btn.disabled = cnt === 0 || this.busy;
        btn.textContent = `🚀 ส่งออกคลิปที่เลือกทั้งหมด (${cnt} คลิป)`;
      }
    }

    getActiveClip() {
      return this.clips[this.activeClipIdx] || null;
    }

    selectClip(idx) {
      if (!this.clips[idx]) return;
      this.activeClipIdx = idx;
      const clip = this.clips[idx];

      document.querySelectorAll('.shorts-clip-card').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.clipIdx) === idx);
      });

      const hlInput = $('shorts-ai-headline');
      if (hlInput) hlInput.value = clip.title || '';
      const capEl = $('shorts-caption-text');
      if (capEl) capEl.value = clip.caption || '';

      const chipsEl = $('shorts-hook-chips');
      if (chipsEl) {
        const opts = Array.isArray(clip.hook_options) && clip.hook_options.length ? clip.hook_options : [clip.title];
        chipsEl.innerHTML = opts
          .map((opt, i) => `<button type="button" class="shorts-hook-chip" data-hook-opt="${escapeHtml(opt)}">💡 ไอเดีย ${i + 1}: ${escapeHtml(opt)}</button>`)
          .join('');
      }

      this.syncPreviewOverlay();
      this.seekPreviewTo(clip.start, false);
    }

    syncPreviewOverlay() {
      const clip = this.getActiveClip();
      const banner = $('shorts-hook-banner');
      if (banner) {
        const txt = (clip && clip.title ? clip.title : '').trim();
        banner.textContent = txt;
        banner.style.background = this.headlineColor;
        banner.classList.toggle('empty', !txt);
      }
      const frame = $('shorts-phone-frame');
      if (frame) {
        frame.classList.remove('shorts-bg-blur', 'shorts-bg-crop_fill', 'shorts-bg-solid');
        frame.classList.add(`shorts-bg-${this.bgMode}`);
      }
      const sz = $('shorts-safe-zone');
      if (sz) sz.classList.toggle('hidden', !this.safeZoneOn);

      const subEl = $('shorts-sub-preview');
      if (subEl) {
        subEl.classList.remove('shorts-preset-clean', 'shorts-preset-bold', 'shorts-preset-yellow', 'shorts-preset-cinema');
        subEl.classList.add(`shorts-preset-${this.presetKey}`);
      }
      const pill = $('shorts-range-pill');
      if (pill && clip) {
        pill.textContent = `${this.fmtClock(clip.start)} → ${this.fmtClock(clip.end)} (${Math.round(clip.end - clip.start)}วิ)`;
      }
      this.updateLiveSubtitleAt(clip ? clip.start + 0.3 : 0);
    }

    updateLiveSubtitleAt(t) {
      const subEl = $('shorts-sub-preview');
      if (!subEl || !this.activeSource) return;
      const cue = this.activeSource.segments.find((c) => t >= c.start && t <= c.end);
      if (!cue) {
        const clip = this.getActiveClip();
        const first = clip ? this.activeSource.segments.find((c) => c.end > clip.start && c.start < clip.end) : null;
        subEl.textContent = first ? (this.lineBreakOn ? smartThaiWrap(first.text, 20) : first.text) : '';
        return;
      }
      subEl.textContent = this.lineBreakOn ? smartThaiWrap(cue.text, 20) : cue.text;
    }

    seekPreviewTo(sec, autoplay = false) {
      const fg = $('shorts-preview-video');
      const bg = $('shorts-preview-bg');
      const clip = this.getActiveClip();
      if (!fg || !clip) return;
      try {
        if (fg.readyState >= 1) {
          fg.currentTime = sec;
          if (bg && bg.readyState >= 1) bg.currentTime = sec;
        }
      } catch (_) {}
      const rel = Math.max(0, sec - clip.start);
      const dur = Math.max(1, clip.end - clip.start);
      const scrub = $('shorts-scrubber');
      if (scrub) scrub.value = String(Math.min(100, (rel / dur) * 100));
      const lbl = $('shorts-time-label');
      if (lbl) lbl.textContent = `${this.fmtClock(rel)} / ${this.fmtClock(dur)}`;
      this.updateLiveSubtitleAt(sec);
      if (autoplay) {
        fg.play().catch(() => {});
        if (bg) bg.play().catch(() => {});
      }
    }

    buildRenderStyle() {
      const base = Object.assign({}, (this.studio && this.studio.style) || {}, SHORTS_PRESETS[this.presetKey] || SHORTS_PRESETS.yellow);
      base.karaoke_enabled = !!this.karaokeOn;
      return base;
    }

    prepareCuesForRender(clip) {
      if (!this.activeSource) return [];
      return this.activeSource.segments
        .filter((c) => c.end > clip.start && c.start < clip.end)
        .map((c) => Object.assign({}, c, {
          text: this.lineBreakOn ? smartThaiWrap(c.text, 20) : c.text,
        }));
    }

    async renderSingleClip(clip, silentToast = false) {
      if (!this.activeSource || !this.activeSource.videoPath) {
        throw new Error('ไม่พบไฟล์วิดีโอในเครื่องสำหรับโปรเจกต์นี้ (กรุณาผูกไฟล์วิดีโอต้นฉบับก่อนส่งออก)');
      }
      const res = await this.host.invokeCmd('render_viral_shorts_916', {
        req: {
          video_path: this.activeSource.videoPath,
          start_sec: clip.start,
          end_sec: clip.end,
          bg_mode: this.bgMode,
          headline: (clip.title || '').trim(),
          headline_color: this.headlineColor,
          cues: this.prepareCuesForRender(clip),
          style: this.buildRenderStyle(),
          watermark: (this.studio && this.studio.watermark) || { enabled: false },
        },
      });
      if (!silentToast) {
        this.host.showToast(`🔥 สร้างคลิปสั้น 9:16 สำเร็จ (${res.encoder_used}): ${this.host.getFileName(res.output_path)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
      }
      return res;
    }

    async handleRenderOne() {
      const clip = this.getActiveClip();
      if (!clip || this.busy) return;
      const btn = $('shorts-render-one-btn');
      this.busy = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ กำลังสร้างคลิป 9:16 MP4...';
      }
      this.updateBatchBtn();
      try {
        await this.renderSingleClip(clip, false);
      } catch (err) {
        this.host.showToast(String(err), 'err');
      } finally {
        this.busy = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🚀 สร้างคลิปสั้น 9:16 MP4';
        }
        this.updateBatchBtn();
      }
    }

    async handleBatchRender() {
      const targets = this.clips.filter((c) => c.selected);
      if (!targets.length || this.busy) return;
      const prog = $('shorts-batch-progress');
      this.busy = true;
      this.updateBatchBtn();
      if (prog) prog.classList.remove('hidden');

      let done = 0;
      let lastOut = '';
      try {
        for (let i = 0; i < targets.length; i++) {
          const clip = targets[i];
          if (prog) prog.textContent = `⏳ กำลังสร้างคลิป ${i + 1}/${targets.length}: ${clip.title.slice(0, 32)}...`;
          const res = await this.renderSingleClip(clip, true);
          lastOut = res.output_path || lastOut;
          done++;
        }
        if (prog) prog.textContent = `✅ สร้างเสร็จครบ ${done}/${targets.length} คลิปแล้ว!`;
        this.host.showToast(`🔥 ส่งออกคลิปสั้น 9:16 ครบ ${done} คลิปเรียบร้อย!`, 'ok');
        if (lastOut) {
          await this.host.invokeCmd('reveal_in_folder', { filePath: lastOut }).catch(() => {});
        }
      } catch (err) {
        this.host.showToast(`สร้างได้ ${done}/${targets.length} คลิป: ${String(err)}`, 'err');
      } finally {
        this.busy = false;
        this.updateBatchBtn();
      }
    }

    openActiveClipInStudio() {
      const clip = this.getActiveClip();
      if (!clip || !this.activeSource || !this.studio) return;
      if (this.activeSource.kind === 'local' && this.activeSource.localProject) {
        this.studio.openLocalProject(this.activeSource.localProject);
      } else {
        this.host.switchTab('studio');
      }
      this.studio.inPoint = clip.start;
      this.studio.outPoint = clip.end;
      const hl = $('shorts-headline');
      if (hl) hl.value = clip.title || '';
      const bgSel = $('shorts-bg-mode');
      if (bgSel) bgSel.value = this.bgMode;
      const vid = $('studio-video');
      if (vid && vid.readyState >= 1) {
        try { vid.currentTime = clip.start; } catch (_) {}
      }
      if (typeof this.studio.renderTimeline === 'function') this.studio.renderTimeline();
      this.host.showToast(`🎬 เปิดช็อต ${this.fmtClock(clip.start)}–${this.fmtClock(clip.end)} ใน 5-Track Studio แล้ว`, 'ok');
    }

    bindEvents() {
      if (this._bound) return;
      this._bound = true;

      $('shorts-go-local-btn')?.addEventListener('click', () => this.host.switchTab('local'));
      $('shorts-go-studio-btn')?.addEventListener('click', () => this.host.switchTab('studio'));

      document.querySelectorAll('.shorts-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => this.setMode(btn.dataset.shortsMode));
      });

      $('shorts-source-select')?.addEventListener('change', (e) => {
        const found = this.sources.find((s) => s.key === e.target.value);
        if (found) {
          this.activeSource = found;
          this.loadPreviewMedia();
          this.runAnalysis(true);
        }
      });

      $('shorts-analyze-btn')?.addEventListener('click', () => this.runAnalysis(false));

      $('shorts-select-all-btn')?.addEventListener('click', () => {
        const allChecked = this.clips.length > 0 && this.clips.every((c) => c.selected);
        this.clips.forEach((c) => { c.selected = !allChecked; });
        this.renderClipsList();
      });

      $('shorts-clips-list')?.addEventListener('click', (e) => {
        const chk = e.target.closest('.shorts-clip-check');
        if (chk) {
          const i = Number(chk.dataset.checkIdx);
          if (this.clips[i]) this.clips[i].selected = chk.checked;
          this.updateBatchBtn();
          return;
        }
        if (e.target.closest('[data-stop-select="1"]')) return;
        const card = e.target.closest('.shorts-clip-card');
        if (card) this.selectClip(Number(card.dataset.clipIdx));
      });

      $('shorts-ai-headline')?.addEventListener('input', (e) => {
        const clip = this.getActiveClip();
        if (clip) {
          clip.title = e.target.value;
          this.syncPreviewOverlay();
          const cardTitle = document.querySelector(`.shorts-clip-card[data-clip-idx="${this.activeClipIdx}"] .shorts-clip-title`);
          if (cardTitle) cardTitle.textContent = clip.title;
        }
      });

      $('shorts-hook-chips')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.shorts-hook-chip');
        if (!chip) return;
        const val = chip.dataset.hookOpt || '';
        const inp = $('shorts-ai-headline');
        if (inp) inp.value = val;
        const clip = this.getActiveClip();
        if (clip) {
          clip.title = val;
          this.syncPreviewOverlay();
          const cardTitle = document.querySelector(`.shorts-clip-card[data-clip-idx="${this.activeClipIdx}"] .shorts-clip-title`);
          if (cardTitle) cardTitle.textContent = val;
        }
      });

      document.querySelectorAll('.shorts-swatch').forEach((sw) => {
        sw.addEventListener('click', () => {
          this.headlineColor = sw.dataset.hlColor || '#fde047';
          document.querySelectorAll('.shorts-swatch').forEach((x) => x.classList.toggle('active', x === sw));
          this.syncPreviewOverlay();
        });
      });

      document.querySelectorAll('.shorts-opt-pill[data-bg-mode]').forEach((p) => {
        p.addEventListener('click', () => {
          this.bgMode = p.dataset.bgMode || 'blur';
          document.querySelectorAll('.shorts-opt-pill[data-bg-mode]').forEach((x) => x.classList.toggle('active', x === p));
          this.syncPreviewOverlay();
        });
      });

      document.querySelectorAll('.shorts-preset-card[data-shorts-preset]').forEach((c) => {
        c.addEventListener('click', () => {
          this.presetKey = c.dataset.shortsPreset || 'yellow';
          document.querySelectorAll('.shorts-preset-card[data-shorts-preset]').forEach((x) => x.classList.toggle('active', x === c));
          this.syncPreviewOverlay();
        });
      });

      $('shorts-tog-safezone')?.addEventListener('change', (e) => {
        this.safeZoneOn = !!e.target.checked;
        this.syncPreviewOverlay();
      });
      $('shorts-tog-karaoke')?.addEventListener('change', (e) => {
        this.karaokeOn = !!e.target.checked;
      });
      $('shorts-tog-linebreak')?.addEventListener('change', (e) => {
        this.lineBreakOn = !!e.target.checked;
        const clip = this.getActiveClip();
        if (clip) this.updateLiveSubtitleAt(clip.start + 0.3);
      });

      $('shorts-copy-caption-btn')?.addEventListener('click', async () => {
        const txt = ($('shorts-caption-text') && $('shorts-caption-text').value) || '';
        if (!txt) return;
        try {
          await navigator.clipboard.writeText(txt);
          this.host.showToast('📋 คัดลอกแคปชัน + แฮชแท็กเรียบร้อย!', 'ok');
        } catch (_) {
          this.host.showToast('คัดลอกไม่สำเร็จ กรุณากด Ctrl+C ในช่องข้อความ', 'info');
        }
      });

      // Preview video playback & loop within clip range
      const fg = $('shorts-preview-video');
      const bg = $('shorts-preview-bg');
      const playBtn = $('shorts-play-btn');

      playBtn?.addEventListener('click', () => {
        if (!fg || !fg.src) {
          this.host.showToast('ยังไม่มีไฟล์วิดีโอในเครื่องสำหรับพรีวิว (แต่สามารถกดวิเคราะห์/ดูซับได้)', 'info');
          return;
        }
        const clip = this.getActiveClip();
        if (fg.paused) {
          if (clip && (fg.currentTime < clip.start || fg.currentTime >= clip.end - 0.1)) {
            fg.currentTime = clip.start;
            if (bg) bg.currentTime = clip.start;
          }
          fg.play().catch(() => {});
          if (bg) bg.play().catch(() => {});
        } else {
          fg.pause();
          if (bg) bg.pause();
        }
      });

      if (fg) {
        fg.addEventListener('play', () => { if (playBtn) playBtn.textContent = '⏸ หยุด'; });
        fg.addEventListener('pause', () => { if (playBtn) playBtn.textContent = '▶ เล่น'; });
        fg.addEventListener('timeupdate', () => {
          const clip = this.getActiveClip();
          if (!clip) return;
          if (fg.currentTime >= clip.end) {
            fg.currentTime = clip.start;
            if (bg) bg.currentTime = clip.start;
          }
          const rel = Math.max(0, fg.currentTime - clip.start);
          const dur = Math.max(1, clip.end - clip.start);
          const scrub = $('shorts-scrubber');
          if (scrub) scrub.value = String(Math.min(100, (rel / dur) * 100));
          const lbl = $('shorts-time-label');
          if (lbl) lbl.textContent = `${this.fmtClock(rel)} / ${this.fmtClock(dur)}`;
          this.updateLiveSubtitleAt(fg.currentTime);
        });
      }

      $('shorts-scrubber')?.addEventListener('input', (e) => {
        const clip = this.getActiveClip();
        if (!clip) return;
        const pct = Number(e.target.value) / 100;
        const sec = clip.start + pct * Math.max(1, clip.end - clip.start);
        this.seekPreviewTo(sec, false);
      });

      const nudge = (field, delta) => {
        const clip = this.getActiveClip();
        if (!clip) return;
        if (field === 'start') {
          clip.start = Number(Math.max(0, Math.min(clip.end - 5, clip.start + delta)).toFixed(2));
        } else {
          const maxT = (this.activeSource && this.activeSource.duration) ? this.activeSource.duration : clip.end + 15;
          clip.end = Number(Math.max(clip.start + 5, Math.min(maxT, clip.end + delta)).toFixed(2));
        }
        clip.duration = Number((clip.end - clip.start).toFixed(2));
        this.renderClipsList();
        this.syncPreviewOverlay();
        this.seekPreviewTo(field === 'start' ? clip.start : Math.max(clip.start, clip.end - 1.5), false);
      };
      $('shorts-start-minus')?.addEventListener('click', () => nudge('start', -1));
      $('shorts-start-plus')?.addEventListener('click', () => nudge('start', 1));
      $('shorts-end-minus')?.addEventListener('click', () => nudge('end', -1));
      $('shorts-end-plus')?.addEventListener('click', () => nudge('end', 1));

      $('shorts-render-one-btn')?.addEventListener('click', () => this.handleRenderOne());
      $('shorts-batch-export-btn')?.addEventListener('click', () => this.handleBatchRender());
      $('shorts-open-studio-btn')?.addEventListener('click', () => this.openActiveClipInStudio());
    }
  }

  window.DesktopShortsStudio = DesktopShortsStudio;
})();
