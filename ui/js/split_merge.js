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
})();
