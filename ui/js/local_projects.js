(() => {
  'use strict';

  const STORAGE_KEY = 'autosub_desktop_local_projects';
  const PLAN_RATES = { 'plan-1': 0.05, 'plan-2': 0.10, 'plan-3': 0.195 };
  const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm4v', 'flv', 'wmv']);
  const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus']);
  const ALL_MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseAnyTsToSec(raw) {
    const clean = String(raw || '').trim().replace(',', '.').split(/\s+/)[0];
    const parts = clean.split(':');
    if (parts.length === 3) {
      const h = Number(parts[0]), m = Number(parts[1]), s = Number(parts[2]);
      return [h, m, s].some((n) => !Number.isFinite(n)) ? null : h * 3600 + m * 60 + s;
    }
    if (parts.length === 2) {
      const m = Number(parts[0]), s = Number(parts[1]);
      return [m, s].some((n) => !Number.isFinite(n)) ? null : m * 60 + s;
    }
    return null;
  }

  /**
   * Robust SRT & WebVTT subtitle parser supporting UTF-8, BOM, HH:MM:SS or MM:SS, and 2-line bilingual cues.
   */
  function parseSubtitleText(rawText) {
    const cleaned = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = cleaned.split(/\n{2,}/);
    const cues = [];

    for (const blk of blocks) {
      const lines = blk.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const head = lines[0].toUpperCase();
      if (head.startsWith('WEBVTT') || head.startsWith('NOTE') || head.startsWith('STYLE') || head.startsWith('REGION')) {
        continue;
      }

      const tsIdx = lines.findIndex((l) => l.includes('-->'));
      if (tsIdx < 0 || tsIdx + 1 >= lines.length) continue;
      const parts = lines[tsIdx].split('-->');
      if (parts.length < 2) continue;

      const start = parseAnyTsToSec(parts[0]);
      const end = parseAnyTsToSec(parts[1]);
      if (start == null || end == null) continue;

      const textLines = lines
        .slice(tsIdx + 1)
        .map((l) => l.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
      if (!textLines.length) continue;

      cues.push({
        start: Number(start.toFixed(3)),
        end: Number(Math.max(start + 0.1, end).toFixed(3)),
        text: textLines[0] || '',
        secondary_text: textLines.length > 1 ? textLines.slice(1).join(' ') : '',
      });
    }
    return cues;
  }

  class DesktopLocalWorkspace {
    constructor(host) {
      this.host = host;
      this.projects = this._load();
      this.thumbCache = {};
      this.modalProjectId = '';
      this.transcribing = false;
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (_) {
        return [];
      }
    }

    _save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
      } catch (_) {}
    }

    getById(id) {
      return this.projects.find((p) => p.id === id) || null;
    }

    updateSegments(id, segments, subtitlePath = null) {
      const p = this.getById(id);
      if (!p) return;
      p.segments = segments.map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || ''),
        secondary_text: String(s.secondary_text || ''),
      }));
      if (subtitlePath) p.subtitlePath = subtitlePath;
      p.updatedAt = new Date().toLocaleString();
      this._save();
      this.render();
    }

    async addMediaPaths(paths) {
      if (!Array.isArray(paths) || !paths.length) return;
      let added = 0;

      for (const rawPath of paths) {
        const p = String(rawPath || '').trim();
        if (!p) continue;
        const ext = this.host.getFileExt(p);
        if (!ALL_MEDIA_EXTS.includes(ext)) continue;

        const existing = this.projects.find((x) => x.videoPath === p);
        if (existing) {
          this.host.showToast(`มีโปรเจกต์ "${existing.name}" อยู่แล้ว`);
          continue;
        }

        let sizeBytes = 0;
        let durationSeconds = 0;
        try {
          const probe = await this.host.invokeCmd('probe_media_info', { filePath: p });
          sizeBytes = probe.size_bytes || 0;
          durationSeconds = probe.duration_seconds || 0;
        } catch (_) {
          sizeBytes = await this.host.invokeCmd('get_file_size', { filePath: p }).catch(() => 0);
        }

        // Auto-detect adjacent .srt or .vtt next to the video!
        let subtitlePath = '';
        let segments = [];
        try {
          const adj = await this.host.invokeCmd('find_adjacent_subtitle', { videoPath: p });
          if (adj) {
            const rawSub = await this.host.invokeCmd('read_text_file', { filePath: adj });
            const parsed = parseSubtitleText(rawSub);
            if (parsed.length) {
              subtitlePath = adj;
              segments = parsed;
            }
          }
        } catch (_) {}

        const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const nowStr = new Date().toLocaleString();
        this.projects.unshift({
          id,
          name: this.host.getFileName(p),
          videoPath: p,
          isVideo: VIDEO_EXTS.has(ext),
          subtitlePath,
          sizeBytes,
          durationSeconds,
          language: 'th',
          segments,
          createdAt: nowStr,
          updatedAt: nowStr,
        });
        added++;
      }

      if (added > 0) {
        this._save();
        this.render();
        this.host.showToast(`เพิ่ม ${added} Local Project เรียบร้อย (พร้อมทำงานบนเครื่อง 100%)`, 'ok');
      }
    }

    async importSubtitleForProject(projectId) {
      const proj = this.getById(projectId);
      if (!proj) return false;
      const tauri = window.__TAURI__;
      if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== 'function') return false;

      const selected = await tauri.dialog.open({
        multiple: false,
        title: 'เลือกไฟล์ซับไตเติล (.SRT / .VTT)',
        filters: [{ name: 'Subtitle Files (SRT / VTT)', extensions: ['srt', 'vtt'] }],
      });
      if (!selected || Array.isArray(selected)) return false;

      try {
        const rawText = await this.host.invokeCmd('read_text_file', { filePath: selected });
        const cues = parseSubtitleText(rawText);
        if (!cues.length) {
          this.host.showToast('ไม่พบข้อความซับไตเติลในไฟล์ที่เลือก', 'err');
          return false;
        }
        proj.subtitlePath = selected;
        proj.segments = cues;
        proj.updatedAt = new Date().toLocaleString();
        this._save();
        this.render();
        this.host.showToast(`นำเข้าซับ ${cues.length} บรรทัดจาก ${this.host.getFileName(selected)} สำเร็จ!`, 'ok');
        return true;
      } catch (err) {
        this.host.showToast(`อ่านไฟล์ซับไม่สำเร็จ: ${err}`, 'err');
        return false;
      }
    }

    deleteProject(projectId) {
      this.projects = this.projects.filter((p) => p.id !== projectId);
      this._save();
      this.render();
      this.host.showToast('นำออกจาก Local Workspace แล้ว (ไฟล์ต้นฉบับในเครื่องไม่ถูกลบ)');
    }

    render() {
      const grid = $('local-projects-grid');
      if (!grid) return;

      const q = ($('local-search-input') && $('local-search-input').value || '').trim().toLowerCase();
      const filtered = q
        ? this.projects.filter((p) => (p.name || '').toLowerCase().includes(q))
        : this.projects;

      if (!filtered.length) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1;">
            <div style="font-size:30px;margin-bottom:6px;">💻🎬</div>
            <div style="font-weight:700;margin-bottom:4px;">${escapeHtml(window.DesktopI18n.t('localEmptyTitle'))}</div>
            <div class="muted">${escapeHtml(window.DesktopI18n.t('localEmptySub'))}</div>
          </div>
        `;
        return;
      }

      grid.innerHTML = filtered.map((p) => {
        const thumbUrl = this.thumbCache[p.id] || '';
        const durStr = this.host.formatDuration(p.durationSeconds) || '00:00';
        const cueCount = Array.isArray(p.segments) ? p.segments.length : 0;
        const subBadge = cueCount > 0
          ? `<span class="q-badge q-badge-done thumb-badge-tl">📝 ${cueCount} cues</span>`
          : '<span class="q-badge q-badge-pending thumb-badge-tl">⏳ ยังไม่มีซับ</span>';

        return `
          <div class="project-card">
            <div class="project-thumb-wrap" data-local-action="open-studio" data-local-id="${escapeHtml(p.id)}" title="Click to open in Subtitle Studio">
              <img class="project-thumb-img ${thumbUrl ? '' : 'hidden'}" data-local-thumb="${escapeHtml(p.id)}" src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(p.name)}" />
              <div class="project-thumb-fallback ${thumbUrl ? 'hidden' : ''}">
                <span class="thumb-icon">${p.isVideo ? '🎬' : '🎵'}</span>
                <span>Local 100%</span>
              </div>
              <div class="project-thumb-play"><span>▶</span></div>
              ${subBadge}
              <span class="thumb-badge-tr local">💻 Local Free</span>
              <span class="thumb-badge-br">⏱️ ${escapeHtml(durStr)}</span>
            </div>
            <div class="project-card-body">
              <div>
                <div class="project-title">${escapeHtml(p.name)}</div>
                <div class="project-meta" style="margin-top:6px;">
                  <span class="meta-chip">${escapeHtml(this.host.formatBytes(p.sizeBytes))}</span>
                  <span class="meta-chip">${p.subtitlePath ? '📄 ' + escapeHtml(this.host.getFileName(p.subtitlePath)) : 'ไม่มีไฟล์ซับ'}</span>
                </div>
                <div class="muted" style="margin-top:4px;">${escapeHtml(p.updatedAt || '')}</div>
              </div>
              <div class="project-actions">
                <button class="btn btn-primary btn-xs" data-local-action="open-studio" data-local-id="${escapeHtml(p.id)}">🎬 Studio</button>
                <button class="btn btn-ghost btn-xs" data-local-action="import-sub" data-local-id="${escapeHtml(p.id)}" title="Import local .srt or .vtt">📄 +SRT/VTT</button>
                <button class="btn btn-accent btn-xs" data-local-action="cloud-ai" data-local-id="${escapeHtml(p.id)}" title="Generate AI subtitles via Cloud AutoSubAI">✨ สร้างซับ Cloud AI</button>
                <button class="btn btn-danger-ghost btn-xs" data-local-action="delete" data-local-id="${escapeHtml(p.id)}" title="Remove from list">🗑️</button>
              </div>
            </div>
          </div>
        `;
      }).join('');

      this._hydrateThumbnails();
    }

    async _hydrateThumbnails() {
      if (!this.host.state.ffmpeg.available) return;
      for (const p of this.projects) {
        if (!p.isVideo || this.thumbCache[p.id]) continue;
        try {
          const thumbPath = await this.host.invokeCmd('generate_local_thumbnail', {
            videoPath: p.videoPath,
            projectId: p.id,
          });
          const url = this.host.toAssetUrl(thumbPath);
          if (url) {
            this.thumbCache[p.id] = url;
            const img = document.querySelector(`img[data-local-thumb="${p.id}"]`);
            if (img) {
              img.src = url;
              img.classList.remove('hidden');
              const fb = img.parentElement && img.parentElement.querySelector('.project-thumb-fallback');
              if (fb) fb.classList.add('hidden');
            }
          }
        } catch (_) {}
      }
    }

    // --- Cloud AutoSubAI Generation Modal (with Smart Login, Free-Trial Plan-2 Cap & Credit Gate!) ---
    async openCloudAiModal(projectId) {
      const proj = this.getById(projectId);
      if (!proj) return;
      this.modalProjectId = projectId;
      $('cloud-ai-proj-name').textContent = proj.name;
      $('cloud-ai-progress-wrap').classList.add('hidden');
      $('modal-cloud-ai').classList.remove('hidden');
      if (this.host.state.token) {
        await this.host.refreshProfile(true);
      }
      this._updateCloudAiModalState();
    }

    _isFreeTrialAccount() {
      const prof = this.host.state.profile;
      if (!prof) return false;
      if (prof.is_superuser) return false;
      return (prof.plan_tier || 'free').toLowerCase() === 'free';
    }

    _updateCloudAiModalState() {
      const proj = this.getById(this.modalProjectId);
      if (!proj) return;

      const plan = $('cloud-ai-plan').value;
      const rate = PLAN_RATES[plan] ?? 0.10;
      const dur = Math.max(10, Number(proj.durationSeconds) || 60);
      const estCost = Number(((dur / 60.0) * rate).toFixed(2));
      const prof = this.host.state.profile;
      const freeTrial = this._isFreeTrialAccount();

      // Disable/annotate Plan 3 for free-trial accounts (฿10 welcome credit, never topped up)
      const optP3 = $('cloud-ai-plan').querySelector('option[value="plan-3"]');
      if (optP3) {
        optP3.textContent = freeTrial
          ? 'Plan 3 • Studio Masterpiece™ — ฿0.195/min (🔒 เติมเงินเพื่อปลดล็อก)'
          : 'Plan 3 • Studio Masterpiece™ — ฿0.195/min';
      }

      const infoBox = $('cloud-ai-status-box');
      const startBtn = $('cloud-ai-start-btn');
      const topupBtn = $('cloud-ai-topup-btn');
      const loginBtn = $('cloud-ai-login-btn');

      startBtn.classList.add('hidden');
      topupBtn.classList.add('hidden');
      loginBtn.classList.add('hidden');

      const durLabel = this.host.formatDuration(proj.durationSeconds) || '~1:00';

      if (!this.host.state.token || !prof) {
        infoBox.innerHTML = `
          <div>⏱️ ความยาวคลิป: <strong>${durLabel}</strong> • ค่าบริการประมาณการ: <strong>฿${estCost.toFixed(2)}</strong></div>
          <div style="margin-top:6px;color:#fde68a;">🎁 <strong>ยังไม่ได้เข้าสู่ระบบ</strong> — สมัคร/ล็อกอินด้วย Google ID วันนี้รับ <strong>เครดิตทดลองฟรี ฿10</strong> (ใช้ได้สูงสุด Plan 2)!</div>
        `;
        loginBtn.classList.remove('hidden');
        return;
      }

      const bal = Number(prof.credit_balance_thb ?? 0);
      if (freeTrial && plan === 'plan-3') {
        infoBox.innerHTML = `
          <div>💳 เครดิตคงเหลือ: <strong>฿${bal.toFixed(2)}</strong> (บัญชีทดลองฟรี)</div>
          <div style="margin-top:6px;color:#fca5a5;">🔒 <strong>บัญชีรับเครดิตฟรี ฿10 (ยังไม่เคยเติมเงิน) ใช้ได้สูงสุด Plan 2 (LipSync Pro™)</strong> — กรุณาเลือก Plan 1/2 หรือเติมเครดิตเพื่อปลดล็อก Plan 3</div>
        `;
        topupBtn.classList.remove('hidden');
        return;
      }

      if (bal < estCost || bal <= 0) {
        infoBox.innerHTML = `
          <div>⏱️ ความยาวคลิป: <strong>${durLabel}</strong> • ค่าบริการประมาณการ: <strong>฿${estCost.toFixed(2)}</strong></div>
          <div style="margin-top:6px;color:#fca5a5;">⚠️ <strong>เครดิตไม่เพียงพอ</strong> (ยอดคงเหลือของคุณคือ <strong>฿${bal.toFixed(2)}</strong>) — กดปุ่มด้านล่างเพื่อไปหน้าเติมเงิน PromptPay ทันที</div>
        `;
        topupBtn.classList.remove('hidden');
        return;
      }

      infoBox.innerHTML = `
        <div>⏱️ ความยาวคลิป: <strong>${durLabel}</strong> • ค่าบริการประมาณการ: <strong>฿${estCost.toFixed(2)}</strong></div>
        <div style="margin-top:4px;color:#6ee7b7;">✅ เครดิตคงเหลือ: <strong>฿${bal.toFixed(2)}</strong> — พร้อมถอดเสียงด้วย Cloud AutoSubAI ทันที!${freeTrial ? ' <span class="muted">(เครดิตฟรี ฿10: สูงสุด Plan 2)</span>' : ''}</div>
      `;
      startBtn.classList.remove('hidden');
    }

    async startCloudAiForLocalProject() {
      if (this.transcribing) return;
      const proj = this.getById(this.modalProjectId);
      if (!proj) return;

      const plan = $('cloud-ai-plan').value;
      const lang = $('cloud-ai-lang').value;

      // Double-check live credit balance & free-trial Plan-2 cap
      const okProf = await this.host.refreshProfile(true);
      this._updateCloudAiModalState();
      if (!okProf) return;
      const prof = this.host.state.profile;
      const bal = Number(prof.credit_balance_thb ?? 0);
      const estCost = Number(((Math.max(10, proj.durationSeconds || 60) / 60.0) * (PLAN_RATES[plan] ?? 0.10)).toFixed(2));
      if (this._isFreeTrialAccount() && plan === 'plan-3') return;
      if (bal < estCost || bal <= 0) return;

      this.transcribing = true;
      const startBtn = $('cloud-ai-start-btn');
      startBtn.disabled = true;
      const progWrap = $('cloud-ai-progress-wrap');
      const progFill = $('cloud-ai-progress-fill');
      const progText = $('cloud-ai-progress-text');
      progWrap.classList.remove('hidden');

      let uploadPath = proj.videoPath;
      let tempAudio = '';

      try {
        if (proj.isVideo && this.host.state.ffmpeg.available) {
          progFill.style.width = '18%';
          progText.textContent = '⚡ กำลังแยกแทร็กเสียง 16kHz บนเครื่อง (ลดขนาดไฟล์ 95%)...';
          const ext = await this.host.invokeCmd('extract_audio_local', { videoPath: proj.videoPath });
          uploadPath = ext.audio_path;
          tempAudio = ext.audio_path;
        }

        progFill.style.width = '35%';
        progText.textContent = '☁️ กำลังอัปโหลดเสียงไปยัง Cloud AutoSubAI...';
        const resp = await this.host.invokeCmd('upload_and_transcribe', {
          filePath: uploadPath,
          displayFilename: proj.name,
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          model: plan,
          language: lang,
        });
        if (tempAudio) {
          await this.host.invokeCmd('cleanup_temp_file', { filePath: tempAudio }).catch(() => {});
          tempAudio = '';
        }

        const jobId = resp.job_id || resp.id || '';
        if (!jobId) throw new Error('ไม่ได้รับรหัสงาน (job_id) จากเซิร์ฟเวอร์');

        let jobData = null;
        for (let i = 0; i < 1800; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          jobData = await this.host.invokeCmd('poll_job_status', {
            apiBase: this.host.state.apiBase,
            token: this.host.state.token,
            jobId,
          });
          const st = String(jobData.status || '').toLowerCase();
          if (st === 'completed') break;
          if (st === 'failed') throw new Error(jobData.error_message || 'ถอดเสียงไม่สำเร็จ');
          if (st === 'awaiting_llm') {
            progFill.style.width = '75%';
            progText.textContent = '✨ รอคิว AutoSub Contextual Mastermind™...';
          } else if (st === 'refining_llm') {
            progFill.style.width = '88%';
            progText.textContent = '✨ กำลังตรวจทานซับและบริบทด้วย AI...';
          } else {
            progFill.style.width = `${Math.max(45, Math.min(72, Number(jobData.progress) || 55))}%`;
            progText.textContent = '🎙️ กำลังถอดเสียงบน AutoSubAI Cloud...';
          }
        }

        if (!jobData || String(jobData.status).toLowerCase() !== 'completed') {
          throw new Error('หมดเวลารอผลลัพธ์');
        }

        const cues = parseSubtitleText(jobData.srt || '');
        let savedSrtPath = proj.subtitlePath;
        if (jobData.srt) {
          const saved = await this.host.invokeCmd('save_subtitle_next_to_source', {
            videoPath: proj.videoPath,
            srtContent: jobData.srt,
            vttContent: jobData.vtt || '',
            saveVtt: false,
          });
          savedSrtPath = saved.srt_path;
        }

        proj.segments = cues;
        proj.subtitlePath = savedSrtPath;
        proj.language = jobData.language || lang;
        proj.updatedAt = new Date().toLocaleString();
        this._save();
        this.render();
        await this.host.refreshProfile(true);

        progFill.style.width = '100%';
        $('modal-cloud-ai').classList.add('hidden');
        this.host.showToast(`✅ สร้างซับเสร็จสมบูรณ์ (${cues.length} บรรทัด) เปิดเข้า Subtitle Studio แล้ว!`, 'ok');
        this.host.openLocalInStudio(proj);
      } catch (err) {
        if (tempAudio) {
          await this.host.invokeCmd('cleanup_temp_file', { filePath: tempAudio }).catch(() => {});
        }
        this.host.showToast(String(err), 'err');
        progText.textContent = `❌ ${err}`;
      } finally {
        this.transcribing = false;
        startBtn.disabled = false;
      }
    }

    bindEvents() {
      $('local-add-media-btn').addEventListener('click', async () => {
        const tauri = window.__TAURI__;
        if (!tauri || !tauri.dialog) return;
        const sel = await tauri.dialog.open({
          multiple: true,
          title: 'เลือกไฟล์วิดีโอหรือเสียงเพื่อสร้าง Local Workspace Project',
          filters: [{ name: 'Video & Audio Files', extensions: ALL_MEDIA_EXTS }],
        });
        if (!sel) return;
        await this.addMediaPaths(Array.isArray(sel) ? sel : [sel]);
      });

      $('local-search-input').addEventListener('input', () => this.render());

      $('local-projects-grid').addEventListener('click', async (e) => {
        const el = e.target.closest('[data-local-action]');
        if (!el) return;
        const action = el.dataset.localAction;
        const id = el.dataset.localId;
        const proj = this.getById(id);
        if (!proj) return;

        if (action === 'open-studio') {
          this.host.openLocalInStudio(proj);
        } else if (action === 'import-sub') {
          await this.importSubtitleForProject(id);
        } else if (action === 'cloud-ai') {
          await this.openCloudAiModal(id);
        } else if (action === 'delete') {
          if (!window.confirm(`นำ "${proj.name}" ออกจาก Local Workspace? (ไฟล์ต้นฉบับในเครื่องไม่ถูกลบ)`)) return;
          this.deleteProject(id);
        }
      });

      $('cloud-ai-plan').addEventListener('change', () => this._updateCloudAiModalState());
      $('cloud-ai-start-btn').addEventListener('click', () => this.startCloudAiForLocalProject());
      $('cloud-ai-login-btn').addEventListener('click', () => {
        $('modal-cloud-ai').classList.add('hidden');
        $('auth-panel').classList.remove('hidden');
      });
      $('cloud-ai-topup-btn').addEventListener('click', () => {
        this.host.openTopupPage();
      });
    }
  }

  window.DesktopSubtitleParser = { parseSubtitleText };
  window.DesktopLocalWorkspace = DesktopLocalWorkspace;
})();
