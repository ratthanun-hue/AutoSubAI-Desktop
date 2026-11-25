(() => {
  'use strict';

  const DRAFT_KEY = 'autosub_meeting_draft_v1';
  const PROJECTS_LS_KEY = 'autosub_meeting_projects_v2';
  const MEDIA_EXTS = ['m4a', 'mp3', 'wav', 'ogg', 'aac', 'flac', 'mp4', 'mov', 'mkv', 'webm'];
  const TEXT_EXTS = ['srt', 'vtt', 'txt'];
  const $ = (id) => document.getElementById(id);

  const DEFAULT_SPEAKERS_TH = ['ประธานที่ประชุม', 'เลขานุการ', 'ฝ่ายบัญชี/การเงิน', 'ฝ่ายปฏิบัติการ', 'ผู้เข้าร่วม 1'];
  const DEFAULT_SPEAKERS_EN = ['Chairperson', 'Secretary', 'Finance', 'Operations', 'Participant 1'];

  function t(key, fallback) {
    if (window.DesktopI18n && typeof window.DesktopI18n.t === 'function') {
      const v = window.DesktopI18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback || key;
  }

  function isEn() {
    return window.DesktopI18n && typeof window.DesktopI18n.getLang === 'function' && window.DesktopI18n.getLang() === 'en';
  }

  function makeMeetingId() {
    return `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function catLabel(cat) {
    const map = {
      executive: ['mtCatExecutive', '🏛️ ประชุมบริหาร'],
      board: ['mtCatBoard', '⚖️ คณะกรรมการ / บอร์ด'],
      team: ['mtCatTeam', '👥 ประชุมทีมประจำสัปดาห์'],
      client: ['mtCatClient', '🤝 ลูกค้า / B2B'],
      interview: ['mtCatInterview', '🎤 สัมภาษณ์ / วิจัย'],
      general: ['mtCatGeneral', '📁 ทั่วไป'],
    };
    const entry = map[cat] || map.general;
    return t(entry[0], entry[1]);
  }

  function statusLabel(st) {
    const map = {
      draft: ['mtStatusDraft', '📝 กำลังร่าง'],
      summarized: ['mtStatusSummarized', '✅ สรุปแล้ว'],
      exported: ['mtStatusExported', '📘 ส่งออกแล้ว'],
    };
    const entry = map[st] || map.draft;
    return t(entry[0], entry[1]);
  }

  function fmtClockNow() {
    try {
      return new Date().toLocaleTimeString(isEn() ? 'en-US' : 'th-TH', { hour12: false });
    } catch (_) {
      return new Date().toTimeString().slice(0, 8);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function todayThaiDate() {
    try {
      return new Date().toLocaleDateString('th-TH', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function parseTsToSec(h, m, s, ms) {
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms || '0').padEnd(3, '0').slice(0, 3)) / 1000;
  }

  function parseSrtOrText(raw) {
    const clean = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!clean) return [];
    // Detect SRT / VTT timestamps (preserve BOTH start and end!)
    if (clean.includes('-->')) {
      const blocks = clean.split(/\r?\n\r?\n+/);
      const rows = [];
      for (const b of blocks) {
        const lines = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const tsIdx = lines.findIndex((l) => l.includes('-->'));
        if (tsIdx === -1) continue;
        const parts = lines[tsIdx].split('-->');
        const m1 = (parts[0] || '').match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/) || (parts[0] || '').match(/(\d{1,2}):(\d{2})[,.](\d{1,3})/);
        const m2 = (parts[1] || '').match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/) || (parts[1] || '').match(/(\d{1,2}):(\d{2})[,.](\d{1,3})/);
        let start = 0;
        let end = 0;
        if (m1) start = m1.length === 5 ? parseTsToSec(m1[1], m1[2], m1[3], m1[4]) : parseTsToSec(0, m1[1], m1[2], m1[3]);
        if (m2) end = m2.length === 5 ? parseTsToSec(m2[1], m2[2], m2[3], m2[4]) : parseTsToSec(0, m2[1], m2[2], m2[3]);
        if (end <= start) end = start + 3.0;
        const text = lines.slice(tsIdx + 1).join(' ').trim();
        if (text) rows.push({ start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), speaker: '', text });
      }
      if (rows.length) return rows;
    }
    return clean
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, i) => ({ start: i * 5, end: (i + 1) * 5, speaker: '', text: line }));
  }

  function splitKaraokeTokens(text) {
    const str = String(text || '').trim();
    if (!str) return [];
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const seg = new Intl.Segmenter('th', { granularity: 'word' });
        const out = [];
        for (const item of seg.segment(str)) {
          if (item.segment) out.push(item.segment);
        }
        if (out.length) return out;
      }
    } catch (_) {}
    return str.match(/\S+\s*/g) || [str];
  }

  /**
   * Confidential Local-Only Secretary Meeting Project Workspace (v1.9.0):
   * - 100% Local Disk-Backed Storage (<app_data_dir>/meetings/<id>.json) — zero cloud storage of confidential minutes
   * - View A: Multi-Meeting Projects Hub (Full-text search, status/category filters, recurring templates, JSON backup/restore)
   * - View B: 3-Step Word-style Meeting Editor with 2-line karaoke, speaker tags, AI Summary & 1-click Word (.DOCX)/LINE export
   */
  class DesktopMeetingWorkspace {
    constructor(host) {
      this.host = host;

      this.projects = [];
      this.activeProjectId = null;
      this.viewMode = 'hub'; // 'hub' | 'editor'
      this.filterStatus = 'all';
      this.filterCategory = 'all';
      this.filterQuery = '';
      this._saveDebounceTimer = null;
      this._initialized = false;

      this.category = 'general';
      this.status = 'draft';
      this.mediaPath = '';
      this.mediaName = '';
      this.mediaDuration = 0;
      this.rows = []; // [{ start, end, speaker, text }]
      this.speakers = [...DEFAULT_SPEAKERS_TH];
      this.selectedSpeaker = DEFAULT_SPEAKERS_TH[0];
      this.activeRowIdx = -1;

      this.meta = this._emptyMeta();

      // Live Meeting Recorder state
      this.recording = false;
      this.mediaRecorder = null;
      this.recStream = null;
      this.recAudioCtx = null;
      this.recAnalyser = null;
      this.recVuRaf = null;
      this.recChunks = [];
      this.recStartedAt = 0;
      this.recTimer = null;

      this.transcribing = false;
    }

    _emptyMeta() {
      return {
        title: '',
        date_str: todayThaiDate(),
        location: isEn() ? 'Meeting Room / Online' : 'ห้องประชุม / ออนไลน์',
        attendees: '',
        secretary: '',
        summary: '',
        decisions: '',
        actions: '',
      };
    }

    _hasTauriDiskStorage() {
      const tauri = this.host && typeof this.host.getTauri === 'function' ? this.host.getTauri() : null;
      return !!(tauri && tauri.core && typeof tauri.core.invoke === 'function');
    }

    async initProjects() {
      if (this._initialized) return;
      this._initialized = true;

      let loaded = [];
      if (this._hasTauriDiskStorage()) {
        try {
          const diskList = await this.host.invokeCmd('list_meeting_projects', {});
          if (Array.isArray(diskList)) loaded = diskList;
        } catch (_) {}
      }
      if (!loaded.length) {
        try {
          const raw = localStorage.getItem(PROJECTS_LS_KEY);
          const arr = raw ? JSON.parse(raw) : [];
          if (Array.isArray(arr) && arr.length) loaded = arr;
        } catch (_) {}
      }

      // Normalize loaded projects
      this.projects = loaded
        .filter((p) => p && typeof p === 'object' && p.id)
        .map((p) => ({
          id: String(p.id),
          category: p.category || 'general',
          status: p.status || 'draft',
          createdAt: Number(p.createdAt) || Date.now(),
          updatedAt: Number(p.updatedAt) || Date.now(),
          mediaPath: p.mediaPath || '',
          mediaName: p.mediaName || '',
          mediaDuration: Number(p.mediaDuration) || 0,
          speakers: Array.isArray(p.speakers) && p.speakers.length ? p.speakers : [...DEFAULT_SPEAKERS_TH],
          selectedSpeaker: p.selectedSpeaker || (Array.isArray(p.speakers) && p.speakers[0]) || DEFAULT_SPEAKERS_TH[0],
          rows: Array.isArray(p.rows) ? p.rows : [],
          meta: { ...this._emptyMeta(), ...(p.meta || {}) },
        }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      // Zero-loss Auto-Migration from legacy single draft (v1.6.0–v1.8.0)
      try {
        const legacyRaw = localStorage.getItem(DRAFT_KEY);
        if (legacyRaw) {
          const d = JSON.parse(legacyRaw);
          const hasContent = !!(
            (d.meta && (d.meta.title || d.meta.summary || d.meta.decisions || d.meta.actions || d.meta.attendees)) ||
            (Array.isArray(d.rows) && d.rows.length > 0) ||
            d.mediaPath
          );
          if (hasContent) {
            const migrated = {
              id: makeMeetingId(),
              category: 'general',
              status: (d.meta && d.meta.summary) ? 'summarized' : 'draft',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              mediaPath: d.mediaPath || '',
              mediaName: d.mediaName || '',
              mediaDuration: Number(d.mediaDuration) || 0,
              speakers: Array.isArray(d.speakers) && d.speakers.length ? d.speakers : [...DEFAULT_SPEAKERS_TH],
              selectedSpeaker: (Array.isArray(d.speakers) && d.speakers[0]) || DEFAULT_SPEAKERS_TH[0],
              rows: Array.isArray(d.rows) ? d.rows : [],
              meta: { ...this._emptyMeta(), ...(d.meta || {}) },
            };
            if (!migrated.meta.title) {
              migrated.meta.title = isEn() ? 'Migrated Meeting Draft' : 'รายงานการประชุม (ย้ายจากฉบับร่างเดิม)';
            }
            this.projects.unshift(migrated);
            await this._persistProjectToStore(migrated);
          }
          localStorage.removeItem(DRAFT_KEY);
        }
      } catch (_) {}

      this.renderHub();
    }

    _syncLocalStorageCache() {
      try {
        if (!this._hasTauriDiskStorage()) {
          localStorage.setItem(PROJECTS_LS_KEY, JSON.stringify(this.projects));
        }
      } catch (_) {}
    }

    async _persistProjectToStore(proj) {
      if (!proj || !proj.id) return;
      if (this._hasTauriDiskStorage()) {
        try {
          await this.host.invokeCmd('save_meeting_project', {
            id: proj.id,
            payloadJson: JSON.stringify(proj),
          });
        } catch (err) {
          console.error('save_meeting_project error:', err);
        }
      } else {
        this._syncLocalStorageCache();
      }
      const badge = $('mt-save-badge');
      if (badge) {
        badge.textContent = `${t('mtSavedLocally', '🔒 บันทึกในเครื่องแล้ว')} • ${fmtClockNow()}`;
      }
    }

    _buildCurrentProjectSnapshot() {
      if (!this.activeProjectId) {
        this.activeProjectId = makeMeetingId();
      }
      const existing = this.projects.find((p) => p.id === this.activeProjectId);
      const now = Date.now();
      return {
        id: this.activeProjectId,
        category: this.category || 'general',
        status: this.status || 'draft',
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        mediaPath: this.mediaPath || '',
        mediaName: this.mediaName || '',
        mediaDuration: Number(this.mediaDuration) || 0,
        speakers: [...this.speakers],
        selectedSpeaker: this.selectedSpeaker || this.speakers[0] || '',
        rows: this.rows,
        meta: { ...this.meta },
      };
    }

    _saveDraft(immediate = false) {
      if (!this.activeProjectId && this.viewMode === 'hub') return;
      const snap = this._buildCurrentProjectSnapshot();
      const idx = this.projects.findIndex((p) => p.id === snap.id);
      if (idx >= 0) this.projects[idx] = snap;
      else this.projects.unshift(snap);
      this.projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      if (this._saveDebounceTimer) {
        clearTimeout(this._saveDebounceTimer);
        this._saveDebounceTimer = null;
      }
      if (immediate) {
        this._persistProjectToStore(snap);
      } else {
        this._saveDebounceTimer = setTimeout(() => {
          this._saveDebounceTimer = null;
          this._persistProjectToStore(snap);
        }, 280);
      }
    }

    onTabShown() {
      if (!this._initialized) {
        this.initProjects();
      } else if (this.viewMode === 'hub') {
        this.renderHub();
      } else {
        this.syncInputsFromState();
      }
    }

    showHub() {
      if (this.activeProjectId && this.viewMode === 'editor') {
        this._saveDraft(true);
      }
      const audio = $('mt-audio-player');
      if (audio && !audio.paused) {
        try { audio.pause(); } catch (_) {}
      }
      this.viewMode = 'hub';
      $('mt-hub-view')?.classList.remove('hidden');
      $('mt-editor-view')?.classList.add('hidden');
      this.renderHub();
    }

    openProject(id) {
      const proj = this.projects.find((p) => p.id === id);
      if (!proj) return;
      this.activeProjectId = proj.id;
      this.category = proj.category || 'general';
      this.status = proj.status || 'draft';
      this.mediaPath = proj.mediaPath || '';
      this.mediaName = proj.mediaName || '';
      this.mediaDuration = Number(proj.mediaDuration) || 0;
      this.speakers = Array.isArray(proj.speakers) && proj.speakers.length ? [...proj.speakers] : [...DEFAULT_SPEAKERS_TH];
      this.selectedSpeaker = proj.selectedSpeaker || this.speakers[0];
      this.rows = Array.isArray(proj.rows) ? proj.rows.map((r) => ({ ...r })) : [];
      this.meta = { ...this._emptyMeta(), ...(proj.meta || {}) };
      this.activeRowIdx = -1;
      this._lastKaraokeKey = '';

      if ($('mt-progress-box')) $('mt-progress-box').classList.add('hidden');
      this.viewMode = 'editor';
      $('mt-hub-view')?.classList.add('hidden');
      $('mt-editor-view')?.classList.remove('hidden');
      this.syncInputsFromState();
      const badge = $('mt-save-badge');
      if (badge) badge.textContent = `${t('mtSavedLocally', '🔒 บันทึกในเครื่องแล้ว')}`;
    }

    async createNewProject(templateProject = null) {
      if (this.activeProjectId && this.viewMode === 'editor') {
        this._saveDraft(true);
      }
      const now = Date.now();
      const defaultSpk = isEn() ? [...DEFAULT_SPEAKERS_EN] : [...DEFAULT_SPEAKERS_TH];
      let proj;
      if (templateProject) {
        const baseTitle = (templateProject.meta && templateProject.meta.title) || (isEn() ? 'Meeting' : 'การประชุม');
        const nextSuffix = isEn() ? ' (Next Session)' : ' (รอบถัดไป)';
        const cleanBase = baseTitle.replace(/\s*\((รอบถัดไป|Next Session)\)\s*$/i, '').trim();
        proj = {
          id: makeMeetingId(),
          category: templateProject.category || 'general',
          status: 'draft',
          createdAt: now,
          updatedAt: now,
          mediaPath: '',
          mediaName: '',
          mediaDuration: 0,
          speakers: Array.isArray(templateProject.speakers) && templateProject.speakers.length
            ? [...templateProject.speakers]
            : defaultSpk,
          selectedSpeaker: templateProject.selectedSpeaker || defaultSpk[0],
          rows: [],
          meta: {
            title: `${cleanBase}${nextSuffix}`,
            date_str: todayThaiDate(),
            location: (templateProject.meta && templateProject.meta.location) || (isEn() ? 'Meeting Room / Online' : 'ห้องประชุม / ออนไลน์'),
            attendees: (templateProject.meta && templateProject.meta.attendees) || '',
            secretary: (templateProject.meta && templateProject.meta.secretary) || '',
            summary: '',
            decisions: '',
            actions: '',
          },
        };
      } else {
        proj = {
          id: makeMeetingId(),
          category: 'general',
          status: 'draft',
          createdAt: now,
          updatedAt: now,
          mediaPath: '',
          mediaName: '',
          mediaDuration: 0,
          speakers: defaultSpk,
          selectedSpeaker: defaultSpk[0],
          rows: [],
          meta: this._emptyMeta(),
        };
      }

      this.projects.unshift(proj);
      await this._persistProjectToStore(proj);
      this.openProject(proj.id);
      this.host.showToast(
        templateProject
          ? (isEn() ? '📋 Created next-session project from template (attendees & speakers copied)!' : '📋 สร้างโปรเจกต์รอบถัดไปจากเทมเพลตแล้ว (ดึงรายชื่อผู้เข้าร่วมและผู้พูดมาครบ)!')
          : (isEn() ? '✨ Created new local confidential meeting project!' : '✨ สร้างโปรเจกต์ประชุมใหม่ในเครื่องเรียบร้อยแล้วครับ!'),
        'ok'
      );
    }

    async deleteProject(id) {
      const proj = this.projects.find((p) => p.id === id);
      if (!proj) return;
      const title = (proj.meta && proj.meta.title) || (isEn() ? 'Untitled Meeting' : 'การประชุมไม่มีชื่อ');
      const ok = confirm(
        isEn()
          ? `Delete meeting project "${title}" from your computer? This cannot be undone.`
          : `ต้องการลบโปรเจกต์ประชุม "${title}" ออกจากเครื่องใช่หรือไม่? (ไม่สามารถกู้คืนได้)`
      );
      if (!ok) return;

      if (this._hasTauriDiskStorage()) {
        try {
          await this.host.invokeCmd('delete_meeting_project', { id });
        } catch (err) {
          this.host.showToast(String(err), 'err');
          return;
        }
      }
      this.projects = this.projects.filter((p) => p.id !== id);
      this._syncLocalStorageCache();

      if (this.activeProjectId === id) {
        this.activeProjectId = null;
        this.showHub();
      } else {
        this.renderHub();
      }
      this.host.showToast(isEn() ? `🗑️ Deleted "${title}"` : `🗑️ ลบโปรเจกต์ "${title}" เรียบร้อย`, 'info');
    }

    async openLocalMeetingsFolder() {
      if (!this._hasTauriDiskStorage()) {
        this.host.showToast(
          isEn()
            ? 'In Desktop App, files are stored in AppData/meetings/ on your PC.'
            : 'บนแอป Desktop ไฟล์ประชุมทุกฉบับเก็บอยู่ในโฟลเดอร์ AppData/meetings/ ในเครื่องคุณ 100% ครับ',
          'info'
        );
        return;
      }
      try {
        const dir = await this.host.invokeCmd('open_meetings_folder', {});
        this.host.showToast(`📂 ${dir}`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async backupAllProjects() {
      if (!this.projects.length) {
        this.host.showToast(isEn() ? 'No meeting projects to back up yet.' : 'ยังไม่มีโปรเจกต์การประชุมให้สำรองข้อมูลครับ', 'info');
        return;
      }
      const payload = JSON.stringify({
        format: 'autosubai_meeting_workspace_backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        count: this.projects.length,
        projects: this.projects,
      }, null, 2);
      const filename = `AutoSubAI_Meetings_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      try {
        const tauri = this.host.getTauri();
        if (tauri && tauri.dialog) {
          const savePath = await tauri.dialog.save({
            title: isEn() ? 'Save Local Meeting Archive Backup (.json)' : 'บันทึกไฟล์สำรองคลังงานประชุม (.JSON)',
            defaultPath: filename,
            filters: [{ name: 'JSON Backup', extensions: ['json'] }],
          });
          if (!savePath) return;
          await this.host.invokeCmd('write_text_file', { filePath: savePath, content: payload });
          this.host.showToast(
            isEn() ? `📦 Backed up ${this.projects.length} meeting projects!` : `📦 สำรองคลังงานประชุม ${this.projects.length} โปรเจกต์เรียบร้อย!`,
            'ok'
          );
          await this.host.invokeCmd('reveal_in_folder', { filePath: savePath }).catch(() => {});
          return;
        }
        // Browser fallback download
        const blob = new Blob([payload], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        this.host.showToast(`📦 สำรองคลัง ${this.projects.length} โปรเจกต์สำเร็จ!`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async _ingestBackupJsonText(rawText) {
      const parsed = JSON.parse(String(rawText || '').replace(/^\uFEFF/, ''));
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.projects) ? parsed.projects : []);
      if (!arr.length) throw new Error(isEn() ? 'No meeting projects found in backup file.' : 'ไม่พบข้อมูลโปรเจกต์การประชุมในไฟล์สำรองนี้');
      const existingIds = new Set(this.projects.map((p) => p.id));
      let imported = 0;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        let id = String(item.id || makeMeetingId()).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!id || existingIds.has(id)) id = makeMeetingId();
        existingIds.add(id);
        const norm = {
          id,
          category: item.category || 'general',
          status: item.status || 'draft',
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          mediaPath: item.mediaPath || '',
          mediaName: item.mediaName || '',
          mediaDuration: Number(item.mediaDuration) || 0,
          speakers: Array.isArray(item.speakers) && item.speakers.length ? item.speakers : [...DEFAULT_SPEAKERS_TH],
          selectedSpeaker: item.selectedSpeaker || DEFAULT_SPEAKERS_TH[0],
          rows: Array.isArray(item.rows) ? item.rows : [],
          meta: { ...this._emptyMeta(), ...(item.meta || {}) },
        };
        this.projects.unshift(norm);
        await this._persistProjectToStore(norm);
        imported++;
      }
      this.projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.renderHub();
      this.host.showToast(
        isEn() ? `📥 Imported ${imported} meeting projects into your local workspace!` : `📥 นำเข้าโปรเจกต์ประชุม ${imported} รายการลงเครื่องเรียบร้อย!`,
        'ok'
      );
    }

    async importBackupProjects() {
      try {
        const tauri = this.host.getTauri();
        if (tauri && tauri.dialog) {
          const sel = await tauri.dialog.open({
            multiple: false,
            title: isEn() ? 'Import Meeting Workspace Backup (.json)' : 'เลือกไฟล์สำรองคลังงานประชุม (.JSON)',
            filters: [{ name: 'JSON Backup', extensions: ['json'] }],
          });
          if (!sel || Array.isArray(sel)) return;
          const raw = await this.host.invokeCmd('read_text_file', { filePath: sel });
          await this._ingestBackupJsonText(raw);
          return;
        }
        $('mt-import-backup-file')?.click();
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    renderHub() {
      const grid = $('mt-hub-grid');
      const countEl = $('mt-hub-count');
      if (!grid) return;

      const q = (this.filterQuery || '').trim().toLowerCase();
      const filtered = this.projects.filter((p) => {
        if (this.filterStatus !== 'all' && (p.status || 'draft') !== this.filterStatus) return false;
        if (this.filterCategory !== 'all' && (p.category || 'general') !== this.filterCategory) return false;
        if (!q) return true;
        const m = p.meta || {};
        const haystack = [
          m.title, m.date_str, m.location, m.attendees, m.secretary,
          m.summary, m.decisions, m.actions, p.mediaName,
          ...(Array.isArray(p.rows) ? p.rows.map((r) => `${r.speaker || ''} ${r.text || ''}`) : []),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });

      if (countEl) {
        countEl.textContent = `${filtered.length}${filtered.length !== this.projects.length ? ` / ${this.projects.length}` : ''} ${t('mtProjectsUnit', 'โปรเจกต์')}`;
      }

      if (!filtered.length) {
        const hasAny = this.projects.length > 0;
        grid.innerHTML = `
          <div class="mt-hub-empty">
            <div style="font-size:38px; margin-bottom:8px;">${hasAny ? '🔍' : '📁'}</div>
            <div style="font-weight:800; font-size:15px; margin-bottom:6px;">
              ${hasAny ? (isEn() ? 'No matching meeting projects found' : 'ไม่พบโปรเจกต์ประชุมที่ตรงกับคำค้นหา') : escapeHtml(t('mtHubEmptyTitle', 'ยังไม่มีโปรเจกต์การประชุมในคลัง'))}
            </div>
            <div class="muted" style="font-size:12.5px; max-width:520px; margin:0 auto 14px;">
              ${hasAny ? (isEn() ? 'Try clearing the search query or switching filters.' : 'ลองล้างคำค้นหาหรือเปลี่ยนตัวกรองสถานะ/หมวดหมู่ด้านบนครับ') : escapeHtml(t('mtHubEmptySub', 'กดปุ่ม “➕ สร้างโปรเจกต์ประชุมใหม่” เพื่อเริ่มจด/ถอดเสียงการประชุม — ข้อมูลความลับทั้งหมดเก็บในเครื่องของคุณ 100%'))}
            </div>
            ${!hasAny ? `<button type="button" class="btn btn-primary" data-mt-hub-create="1">${escapeHtml(t('mtNewProjectBtn', '➕ สร้างโปรเจกต์ประชุมใหม่'))}</button>` : ''}
          </div>
        `;
        return;
      }

      grid.innerHTML = filtered.map((p) => {
        const m = p.meta || {};
        const title = m.title || (isEn() ? 'Untitled Meeting Minutes' : 'รายงานการประชุม (ยังไม่ตั้งชื่อ)');
        const excerpt = (m.summary || m.decisions || (p.rows && p.rows[0] && p.rows[0].text) || (isEn() ? 'No summary or transcript yet — click Open Workspace to start.' : 'ยังไม่มีบทสรุปหรือบทถอดเสียง — กดเปิดทำงานเพื่อนำเข้าไฟล์หรืออัดเสียงสด')).replace(/\s+/g, ' ').trim();
        const st = p.status || 'draft';
        const cat = p.category || 'general';
        const rowCnt = Array.isArray(p.rows) ? p.rows.length : 0;
        const spkCnt = Array.isArray(p.speakers) ? p.speakers.length : 0;
        const durBadge = p.mediaDuration > 0 ? `<span>⏱️ ${fmtTime(p.mediaDuration)}</span>` : '';
        const audioBadge = p.mediaName ? `<span title="${escapeHtml(p.mediaName)}">🎙️ ${escapeHtml(p.mediaName.slice(0, 22))}${p.mediaName.length > 22 ? '…' : ''}</span>` : '';

        return `
          <article class="mt-proj-card" data-mt-proj-card="${escapeHtml(p.id)}">
            <div class="mt-proj-top">
              <div class="mt-proj-title" data-mt-open="${escapeHtml(p.id)}">${escapeHtml(title)}</div>
              <span class="mt-badge-status ${escapeHtml(st)}">${escapeHtml(statusLabel(st))}</span>
            </div>
            <div class="mt-proj-badges">
              <span class="mt-badge-cat">${escapeHtml(catLabel(cat))}</span>
              <span class="mt-local-pill" style="font-size:10px; padding:1px 7px;">🔒 Local</span>
            </div>
            <div class="mt-proj-meta">
              <span>📅 ${escapeHtml(m.date_str || '-')}</span>
              ${m.location ? `<span>📍 ${escapeHtml(m.location)}</span>` : ''}
            </div>
            <div class="mt-proj-excerpt">${escapeHtml(excerpt)}</div>
            <div class="mt-proj-stats">
              <span>💬 ${rowCnt} ${escapeHtml(t('mtRowsUnit', 'ย่อหน้า'))}</span>
              <span>👤 ${spkCnt} ${escapeHtml(t('mtSpeakersUnit', 'ผู้พูด'))}</span>
              ${durBadge}
              ${audioBadge}
            </div>
            <div class="mt-proj-actions">
              <button type="button" class="btn btn-primary btn-xs" data-mt-open="${escapeHtml(p.id)}">${escapeHtml(t('mtOpenProjectBtn', '📝 เปิดทำงาน'))}</button>
              <button type="button" class="btn btn-secondary btn-xs" data-mt-clone="${escapeHtml(p.id)}" title="${escapeHtml(t('mtCloneTemplateBtn', '📋 ใช้เป็นเทมเพลตรอบหน้า'))}">${escapeHtml(t('mtCloneTemplateBtn', '📋 ใช้เป็นเทมเพลตรอบหน้า'))}</button>
              <button type="button" class="btn btn-danger-ghost btn-xs" style="margin-left:auto;" data-mt-delete="${escapeHtml(p.id)}" title="ลบโปรเจกต์นี้">🗑️</button>
            </div>
          </article>
        `;
      }).join('');
    }

    syncInputsFromState() {
      if ($('mt-category-select')) $('mt-category-select').value = this.category || 'general';
      if ($('mt-status-select')) $('mt-status-select').value = this.status || 'draft';
      if ($('mt-title')) $('mt-title').value = this.meta.title || '';
      if ($('mt-date')) $('mt-date').value = this.meta.date_str || todayThaiDate();
      if ($('mt-location')) $('mt-location').value = this.meta.location || '';
      if ($('mt-attendees')) $('mt-attendees').value = this.meta.attendees || '';
      if ($('mt-secretary')) $('mt-secretary').value = this.meta.secretary || '';
      if ($('mt-summary')) $('mt-summary').value = this.meta.summary || '';
      if ($('mt-decisions')) $('mt-decisions').value = this.meta.decisions || '';
      if ($('mt-actions')) $('mt-actions').value = this.meta.actions || '';
      this.renderMediaStatus();
      this.renderSpeakerChips();
      this.renderTranscript();
      this._loadAudioPlayer();
    }

    _loadAudioPlayer() {
      const audio = $('mt-audio-player');
      if (!audio) return;
      if (this.mediaPath) {
        const url = this.host.toAssetUrl(this.mediaPath);
        if (audio.dataset.path !== this.mediaPath) {
          audio.src = url;
          audio.dataset.path = this.mediaPath;
          audio.load();
        }
      } else {
        audio.pause();
        audio.removeAttribute('src');
        audio.dataset.path = '';
      }
    }

    renderMediaStatus() {
      const box = $('mt-file-status');
      const btn = $('mt-transcribe-btn');
      if (!box) return;
      if (this.mediaPath) {
        const durStr = this.mediaDuration > 0 ? ` • ความยาว ${fmtTime(this.mediaDuration)}` : '';
        const estMin = Math.max(1, Math.ceil((this.mediaDuration || 60) / 60));
        const model = $('mt-plan-select')?.value || 'plan-2';
        const rate = model === 'plan-1' ? 0.069 : (model === 'plan-3' ? 0.245 : 0.125);
        const estCost = (estMin * rate).toFixed(2);
        box.innerHTML = `✅ <strong>ไฟล์พร้อมแล้ว:</strong> ${escapeHtml(this.mediaName || this.host.getFileName(this.mediaPath))}${durStr} <span class="mono-tag" style="margin-left:6px;">ประมาณ ฿${estCost}</span>`;
        if (btn) btn.disabled = this.transcribing;
      } else {
        box.innerHTML = 'ยังไม่ได้เลือกไฟล์เสียงประชุม — กดปุ่ม <strong>📂 เลือกไฟล์เสียง</strong> หรือ <strong>🔴 อัดเสียงประชุมสด</strong> ด้านบนได้เลยครับ';
        if (btn) btn.disabled = true;
      }
    }

    renderSpeakerChips() {
      const wrap = $('mt-speaker-chips');
      if (!wrap) return;
      wrap.innerHTML = this.speakers
        .map((sp) => `
          <button type="button" class="mt-spk-chip ${sp === this.selectedSpeaker ? 'active' : ''}" data-mt-spk="${escapeHtml(sp)}">
            👤 ${escapeHtml(sp)}
          </button>
        `)
        .join('');
      if (this._updateKaraokeStage) this._updateKaraokeStage(true);
    }

    renderTranscript(filterText = '') {
      const list = $('mt-transcript-list');
      const countEl = $('mt-row-count');
      if (!list) return;
      if (countEl) countEl.textContent = `${this.rows.length} ย่อหน้า`;

      const q = (filterText || $('mt-filter-input')?.value || '').trim().toLowerCase();
      if (!this.rows.length) {
        list.innerHTML = `
          <div class="mt-empty">
            <div style="font-size:32px; margin-bottom:6px;">📝</div>
            <div style="font-weight:700; margin-bottom:4px;">ยังไม่มีบทถอดเสียงการประชุม</div>
            <div class="muted" style="font-size:12px;">เลือกไฟล์เสียงหรือกดอัดเสียงประชุมด้านบน แล้วกด <strong>✨ ถอดเสียงประชุมอัตโนมัติ</strong> หรือกด <strong>📄 นำเข้าข้อความเดิม</strong> ได้เลยครับ</div>
          </div>
        `;
        return;
      }

      const items = this.rows
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => !q || (r.text || '').toLowerCase().includes(q) || (r.speaker || '').toLowerCase().includes(q));

      if (!items.length) {
        list.innerHTML = '<div class="mt-empty muted">ไม่พบข้อความที่ค้นหา</div>';
        return;
      }

      const singleRowMode = items.length === 1;
      list.innerHTML = items
        .map(({ r, idx }) => {
          const textLen = (r.text || '').length;
          const rowLines = singleRowMode
            ? 32
            : (items.length <= 3
              ? Math.max(8, Math.min(22, Math.ceil(textLen / 65) + 1))
              : Math.max(3, Math.min(10, Math.ceil(textLen / 65) + 1)));
          return `
          <div class="mt-row ${idx === this.activeRowIdx ? 'active' : ''}" data-mt-row="${idx}">
            <div class="mt-row-head">
              <button type="button" class="mt-ts-btn" data-mt-play="${idx}" title="คลิกเพื่อฟังเสียงท่อนนี้">
                ▶️ ${fmtTime(r.start)}
              </button>
              <button type="button" class="mt-spk-tag ${r.speaker ? 'has-spk' : ''}" data-mt-assign-spk="${idx}" title="คลิกเพื่อแปะชื่อผู้พูดที่เลือกไว้ (${escapeHtml(this.selectedSpeaker)})">
                👤 ${escapeHtml(r.speaker || 'คลิกใส่ชื่อผู้พูด')}
              </button>
              <div style="margin-left:auto; display:flex; gap:4px;">
                <button type="button" class="btn btn-ghost btn-xs" data-mt-add-after="${idx}" title="เพิ่มย่อหน้าถัดไป">➕</button>
                <button type="button" class="btn btn-danger-ghost btn-xs" data-mt-del="${idx}" title="ลบย่อหน้านี้">✕</button>
              </div>
            </div>
            <textarea class="mt-row-text ${singleRowMode ? 'mt-row-tall' : ''}" data-mt-text="${idx}" rows="${rowLines}">${escapeHtml(r.text)}</textarea>
          </div>
        `;
        })
        .join('');
      if (this._updateKaraokeStage) this._updateKaraokeStage(true);
    }

    async loadAudioPath(sel) {
      if (!sel) return;
      if (this.viewMode !== 'editor' || !this.activeProjectId) {
        await this.createNewProject(null);
      }
      this.mediaPath = sel;
      this.mediaName = this.host.getFileName(sel);
      this.mediaDuration = 0;
      try {
        const info = await this.host.invokeCmd('probe_media_info', { filePath: sel });
        if (info && Number(info.duration_seconds) > 0) this.mediaDuration = Number(info.duration_seconds);
      } catch (_) {}
      if (!this.meta.title) {
        this.meta.title = this.mediaName.replace(/\.[^.]+$/, '');
        if ($('mt-title')) $('mt-title').value = this.meta.title;
      }
      this._saveDraft();
      this.renderMediaStatus();
      this._loadAudioPlayer();
      this.host.showToast(`📂 โหลดไฟล์ประชุม "${this.mediaName}" เรียบร้อย — กดปุ่ม ✨ ถอดเสียงได้เลย!`, 'ok');
    }

    async pickMeetingAudioFile() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'เลือกไฟล์เสียงหรือวิดีโอการประชุม (มือถือ / Zoom / Teams)',
          filters: [{ name: 'Meeting Audio & Video', extensions: MEDIA_EXTS }],
        });
        if (!sel || Array.isArray(sel)) return;
        await this.loadAudioPath(sel);
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async importExistingTranscript() {
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const sel = await tauri.dialog.open({
          multiple: false,
          title: 'เลือกไฟล์ข้อความหรือซับเดิม (.SRT / .VTT / .TXT)',
          filters: [{ name: 'Transcript Files', extensions: TEXT_EXTS }],
        });
        if (!sel || Array.isArray(sel)) return;
        const content = await this.host.invokeCmd('read_text_file', { filePath: sel });
        const parsed = parseSrtOrText(content);
        if (!parsed.length) {
          this.host.showToast('ไม่พบข้อความในไฟล์ที่เลือก', 'err');
          return;
        }
        this.rows = parsed;
        if (!this.meta.title) {
          this.meta.title = this.host.getFileName(sel).replace(/\.[^.]+$/, '');
          if ($('mt-title')) $('mt-title').value = this.meta.title;
        }
        this._saveDraft();
        this.renderTranscript();
        this.host.showToast(`📄 นำเข้าบทถอดเสียง ${parsed.length} ย่อหน้าเรียบร้อย!`, 'ok');
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    async toggleLiveMeetingRecord() {
      if (this.recording) this.stopMeetingRecord();
      else await this.startMeetingRecord();
    }

    async startMeetingRecord() {
      if (this.recording) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.host.showToast('เครื่องนี้ไม่รองรับการอัดเสียงผ่านไมโครโฟน', 'err');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recStream = stream;
        this.recChunks = [];
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''].find(
          (m) => !m || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
        ) || '';
        const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        this.mediaRecorder = mr;
        this.recStartedAt = Date.now();
        this.recording = true;

        mr.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) this.recChunks.push(ev.data);
        };
        mr.onstop = async () => {
          await this._finalizeMeetingRecord();
        };

        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            this.recAudioCtx = new AC();
            const src = this.recAudioCtx.createMediaStreamSource(stream);
            this.recAnalyser = this.recAudioCtx.createAnalyser();
            this.recAnalyser.fftSize = 256;
            src.connect(this.recAnalyser);
            const buf = new Uint8Array(this.recAnalyser.frequencyBinCount);
            const tick = () => {
              if (!this.recording || !this.recAnalyser) return;
              this.recAnalyser.getByteTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) {
                const v = (buf[i] - 128) / 128;
                sum += v * v;
              }
              const pct = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 320));
              if ($('mt-vu-fill')) $('mt-vu-fill').style.width = `${pct}%`;
              this.recVuRaf = requestAnimationFrame(tick);
            };
            tick();
          }
        } catch (_) {}

        mr.start(500);
        const btn = $('mt-record-btn');
        if (btn) {
          btn.classList.add('recording');
          btn.textContent = '⏹️ หยุดอัดเสียงประชุม (00:00)';
        }
        this.recTimer = setInterval(() => {
          const elapsed = (Date.now() - this.recStartedAt) / 1000;
          if (btn && this.recording) btn.textContent = `⏹️ หยุดอัดเสียงประชุม (${fmtTime(elapsed)})`;
        }, 500);
        this.host.showToast('🎙️ เริ่มอัดเสียงประชุมสดแล้ว — กดหยุดเมื่อประชุมเสร็จครับ', 'info');
      } catch (err) {
        this.host.showToast(`เปิดไมโครโฟนไม่สำเร็จ: ${err.message || err}`, 'err');
      }
    }

    stopMeetingRecord() {
      if (!this.recording) return;
      this.recording = false;
      if (this.recTimer) { clearInterval(this.recTimer); this.recTimer = null; }
      if (this.recVuRaf) { cancelAnimationFrame(this.recVuRaf); this.recVuRaf = null; }
      if ($('mt-vu-fill')) $('mt-vu-fill').style.width = '0%';

      const btn = $('mt-record-btn');
      if (btn) {
        btn.classList.remove('recording');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังบันทึกไฟล์เสียงประชุม...';
      }
      try { if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop(); } catch (_) {}
      try { if (this.recStream) this.recStream.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
      try { if (this.recAudioCtx) this.recAudioCtx.close(); } catch (_) {}
      this.recStream = null;
      this.recAudioCtx = null;
      this.recAnalyser = null;
    }

    async _finalizeMeetingRecord() {
      const btn = $('mt-record-btn');
      try {
        const blob = new Blob(this.recChunks, { type: this.recChunks[0]?.type || 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        const res = await this.host.invokeCmd('save_voiceover_recording', {
          projectId: 'meetings',
          filename: 'meeting_rec',
          bytes,
        });
        const est = Math.max(1, (Date.now() - this.recStartedAt) / 1000);
        this.mediaPath = res.path;
        this.mediaName = this.host.getFileName(res.path);
        this.mediaDuration = (res && Number(res.duration) > 0.1) ? Number(res.duration) : est;
        if (!this.meta.title) {
          this.meta.title = `การประชุม ${todayThaiDate().slice(0, 18)}`;
          if ($('mt-title')) $('mt-title').value = this.meta.title;
        }
        this._saveDraft();
        this.renderMediaStatus();
        this._loadAudioPlayer();
        this.host.showToast(`✅ บันทึกเสียงประชุมเรียบร้อย (${fmtTime(this.mediaDuration)}) — กดปุ่ม ✨ ถอดเสียงได้เลย!`, 'ok');
      } catch (err) {
        this.host.showToast(`บันทึกเสียงประชุมไม่สำเร็จ: ${err}`, 'err');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔴 อัดเสียงประชุมสดหน้าเครื่อง';
        }
      }
    }

    async transcribeMeetingAudio() {
      if (this.transcribing) return;
      if (!this.mediaPath) {
        this.host.showToast('กรุณาเลือกไฟล์เสียงหรืออัดเสียงประชุมก่อนครับ', 'err');
        return;
      }
      if (!this.host.state.token || !this.host.state.profile) {
        this.host.showToast('กรุณาเข้าสู่ระบบบัญชี AutoSubAI ก่อนถอดเสียงครับ (สมัครฟรีรับเครดิต ฿10)', 'info');
        const auth = $('auth-panel');
        if (auth) auth.classList.remove('hidden');
        return;
      }

      const model = $('mt-plan-select')?.value || 'plan-2';
      const lang = $('mt-lang-select')?.value || 'th';
      const btn = $('mt-transcribe-btn');
      const progBox = $('mt-progress-box');
      const setProg = (msg, pct) => {
        if (progBox) {
          progBox.classList.remove('hidden');
          progBox.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>${escapeHtml(msg)}</span><strong>${pct}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;
        }
      };

      this.transcribing = true;
      if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังถอดเสียงการประชุม...'; }
      let tempAudio = null;
      try {
        setProg('กำลังเตรียมไฟล์เสียงคุณภาพสูง (บีบอัดลดขนาด 95%)...', 15);
        const extracted = await this.host.invokeCmd('extract_audio_local', { videoPath: this.mediaPath });
        tempAudio = extracted.audio_path;

        setProg('กำลังส่งเสียงขึ้น AutoSubAI Neural Engine...', 32);
        const up = await this.host.invokeCmd('upload_and_transcribe', {
          filePath: tempAudio,
          displayFilename: this.mediaName || 'meeting.wav',
          apiBase: this.host.state.apiBase,
          token: this.host.state.token,
          model,
          language: lang,
        });

        let result = up;
        if (up.job_id && (!up.srt_content && !up.text && !Array.isArray(up.words))) {
          const jobId = up.job_id;
          for (let attempt = 0; attempt < 360; attempt++) {
            await new Promise((r) => setTimeout(r, 2500));
            const st = await this.host.invokeCmd('poll_job_status', {
              apiBase: this.host.state.apiBase,
              token: this.host.state.token,
              jobId,
            });
            const status = String(st.status || '').toLowerCase();
            const pct = Math.min(96, Math.max(38, Math.round(Number(st.progress || 50))));
            const msg = status === 'awaiting_llm' || status === 'refining_llm'
              ? 'กำลังตรวจทานซับและจัดรูปประโยคการประชุม (AutoSub Mastermind)...'
              : (st.progress_text || 'กำลังถอดเสียงการประชุม...');
            setProg(msg, pct);
            if (status === 'completed' || status === 'done') {
              result = st;
              break;
            }
            if (status === 'failed' || status === 'error') {
              throw new Error(st.error_message || st.detail || 'ถอดเสียงไม่สำเร็จ กรุณาลองใหม่');
            }
          }
        }

        // Group cues cleanly into crisp timestamped meeting segments (~8-10s / ~140 chars)
        // NOTE: Backend poll_job_status returns `srt` (and/or `srt_content` / `vtt` / `segments` / `words`)
        let parsed = [];
        const rawSrt = result.srt || result.srt_content || result.vtt || '';
        if (rawSrt && rawSrt.includes('-->')) {
          parsed = parseSrtOrText(rawSrt);
        } else if (Array.isArray(result.segments) && result.segments.length) {
          parsed = result.segments.map((s) => ({
            start: Number(s.start || 0),
            end: Number(s.end || (Number(s.start || 0) + 3)),
            speaker: '',
            text: String(s.text || '').trim(),
          })).filter((r) => r.text);
        } else if (Array.isArray(result.words) && result.words.length) {
          parsed = result.words.map((w) => ({
            start: Number(w.start || 0),
            end: Number(w.end || (Number(w.start || 0) + 0.5)),
            speaker: '',
            text: String(w.text || w.word || '').trim(),
          })).filter((r) => r.text);
        } else if (result.text) {
          parsed = parseSrtOrText(result.text);
        }

        const grouped = [];
        for (const item of parsed) {
          const itemEnd = Number(item.end) > Number(item.start) ? Number(item.end) : Number(item.start) + 3.0;
          const prev = grouped[grouped.length - 1];
          if (prev && (itemEnd - prev.start) <= 10 && (prev.text.length + item.text.length) < 145) {
            prev.text = `${prev.text} ${item.text}`.trim();
            prev.end = Number(Math.max(prev.end || prev.start, itemEnd).toFixed(2));
          } else {
            grouped.push({
              start: Number(Number(item.start || 0).toFixed(2)),
              end: Number(itemEnd.toFixed(2)),
              speaker: '',
              text: item.text,
            });
          }
        }

        if (!grouped.length) throw new Error('ไม่พบข้อความเสียงพูดในไฟล์นี้');
        this.rows = grouped;
        setProg('ถอดเสียงสำเร็จ! กำลังสรุปรายงานการประชุมอัตโนมัติ...', 98);
        await this.generateMeetingSummary(true);
        setProg('✅ ถอดเสียงและสรุปรายงานการประชุมเรียบร้อยแล้ว!', 100);
        this._saveDraft();
        this.renderTranscript();
        if (this.host.refreshProfile) this.host.refreshProfile(true).catch(() => {});
        this.host.showToast(`🎉 ถอดเสียงและสรุปรายงานการประชุมสำเร็จ (${grouped.length} ย่อหน้า)!`, 'ok');
      } catch (err) {
        if (progBox) progBox.classList.add('hidden');
        this.host.showToast(`ถอดเสียงไม่สำเร็จ: ${err}`, 'err');
      } finally {
        if (tempAudio) this.host.invokeCmd('cleanup_temp_file', { filePath: tempAudio }).catch(() => {});
        this.transcribing = false;
        if (btn) { btn.disabled = !this.mediaPath; btn.textContent = '✨ ถอดเสียงประชุม + สรุปรายงานอัตโนมัติ'; }
      }
    }

    async generateMeetingSummary(silent = false) {
      if (!this.rows.length) {
        if (!silent) this.host.showToast('ยังไม่มีบทถอดเสียงให้สรุปครับ', 'err');
        return;
      }
      const btn = $('mt-summarize-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังสรุปรายงาน...'; }
      try {
        // Smart Thai + English Meeting Minutes Extractor (instant & works 100% offline too)
        const decisionRe = /(มติ|เห็นชอบ|อนุมัติ|ตกลง|สรุปว่า|ยืนยัน|เลือกใช้|ใช้แผน|ผ่านการพิจารณา|ปิดโครงการ|agreed|approved|decided|confirmed)/i;
        const actionRe = /(มอบหมาย|รับผิดชอบ|ดำเนินการ|ต้องทำ|จัดทำ|ส่งภายใน|กำหนดส่ง|เดดไลน์|ติดตาม|ประสานงาน|นัดหมาย|เตรียมเอกสาร|ภายในวัน|สัปดาห์หน้า|พรุ่งนี้|action|follow\s*up|deadline|todo)/i;

        const decisions = [];
        const actions = [];
        const candidates = [];

        for (const r of this.rows) {
          const line = (r.text || '').trim();
          if (line.length < 8) continue;
          const prefix = r.speaker ? `[${r.speaker}] ` : '';
          if (decisionRe.test(line) && decisions.length < 8) {
            decisions.push(`${prefix}${line}`);
          }
          if (actionRe.test(line) && actions.length < 10) {
            actions.push(`${prefix}${line} (นาทีที่ ${fmtTime(r.start)})`);
          }
          candidates.push(line);
        }

        // Build Executive Summary (optional server extractive summary + local fallback)
        let summaryLines = [];
        if (this.host.state.token) {
          try {
            const fullText = candidates.join('\n');
            const res = await this.host.invokeCmd('api_summarize_transcript', {
              apiBase: this.host.state.apiBase,
              token: this.host.state.token,
              jobId: null,
              text: fullText.slice(0, 18000),
              language: 'th',
            });
            if (res && res.summary) {
              summaryLines = String(res.summary)
                .split(/[.!?。\n]+/)
                .map((s) => s.trim())
                .filter((s) => s.length > 10)
                .slice(0, 6);
            }
          } catch (_) {}
        }

        if (!summaryLines.length) {
          // Local keyword-weighted summary picking evenly across meeting start/mid/end
          const total = candidates.length;
          const step = Math.max(1, Math.floor(total / 5));
          for (let i = 0; i < total && summaryLines.length < 5; i += step) {
            summaryLines.push(candidates[i]);
          }
        }

        this.meta.summary = summaryLines.map((s) => `• ${s}`).join('\n');
        this.meta.decisions = decisions.length
          ? decisions.join('\n')
          : '• (ตรวจสอบและพิมพ์เพิ่มเติมมติที่ประชุมที่ช่องนี้ได้เลยครับ)';
        this.meta.actions = actions.length
          ? actions.join('\n')
          : '• (ระบุงานที่มอบหมาย / ผู้รับผิดชอบ / กำหนดส่ง ที่ช่องนี้ได้เลยครับ)';

        if ($('mt-summary')) $('mt-summary').value = this.meta.summary;
        if ($('mt-decisions')) $('mt-decisions').value = this.meta.decisions;
        if ($('mt-actions')) $('mt-actions').value = this.meta.actions;
        if (this.status === 'draft') {
          this.status = 'summarized';
          if ($('mt-status-select')) $('mt-status-select').value = 'summarized';
        }
        this._saveDraft(true);
        if (!silent) this.host.showToast('✨ สรุปประเด็นสำคัญ, มติที่ประชุม และงานติดตามเรียบร้อยแล้ว!', 'ok');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✨ สรุปรายงานการประชุมอัตโนมัติ'; }
      }
    }

    _collectDocPayload() {
      this.meta.title = ($('mt-title')?.value || '').trim() || 'รายงานการประชุม';
      this.meta.date_str = ($('mt-date')?.value || '').trim() || todayThaiDate();
      this.meta.location = ($('mt-location')?.value || '').trim();
      this.meta.attendees = ($('mt-attendees')?.value || '').trim();
      this.meta.secretary = ($('mt-secretary')?.value || '').trim();
      this.meta.summary = ($('mt-summary')?.value || '').trim();
      this.meta.decisions = ($('mt-decisions')?.value || '').trim();
      this.meta.actions = ($('mt-actions')?.value || '').trim();
      this._saveDraft();

      const splitLines = (str) => String(str || '').split(/\r?\n/).map((l) => l.replace(/^[•\-*\d.)\s]+/, '').trim()).filter(Boolean);
      return {
        title: this.meta.title,
        date_str: this.meta.date_str,
        location: this.meta.location,
        attendees: this.meta.attendees,
        secretary: this.meta.secretary,
        summary_lines: splitLines(this.meta.summary),
        decision_lines: splitLines(this.meta.decisions),
        action_lines: splitLines(this.meta.actions),
        transcript_rows: this.rows.map((r) => ({
          time_label: fmtTime(r.start),
          speaker: r.speaker || '',
          text: r.text || '',
        })),
      };
    }

    async exportWordDocx() {
      const payload = this._collectDocPayload();
      const safeTitle = payload.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'รายงานการประชุม';
      try {
        const tauri = this.host.getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Save Dialog unavailable');
        const savePath = await tauri.dialog.save({
          title: 'บันทึกรายงานการประชุมเป็น Microsoft Word (.docx)',
          defaultPath: `${safeTitle}.docx`,
          filters: [{ name: 'Microsoft Word Document', extensions: ['docx'] }],
        });
        if (!savePath) return;

        const out = await this.host.invokeCmd('export_meeting_docx', {
          req: { ...payload, output_path: savePath },
        });
        this.status = 'exported';
        if ($('mt-status-select')) $('mt-status-select').value = 'exported';
        this._saveDraft(true);
        this.host.showToast(`📘 บันทึกไฟล์ Word (.DOCX) สำเร็จ: ${this.host.getFileName(out)}`, 'ok');
        await this.host.invokeCmd('reveal_in_folder', { filePath: out }).catch(() => {});
      } catch (err) {
        this.host.showToast(`บันทึกไฟล์ Word ไม่สำเร็จ: ${err}`, 'err');
      }
    }

    async copyForLine() {
      const p = this._collectDocPayload();
      const parts = [
        `📋 สรุปรายงานการประชุม: ${p.title}`,
        `📅 วันที่: ${p.date_str}`,
        p.location ? `📍 สถานที่: ${p.location}` : '',
        p.attendees ? `👥 ผู้เข้าร่วม: ${p.attendees}` : '',
        '',
        '📌 สรุปสาระสำคัญ:',
        ...(p.summary_lines.length ? p.summary_lines.map((l) => `• ${l}`) : ['• (ยังไม่ได้ระบุ)']),
        '',
        '✅ มติที่ประชุม:',
        ...(p.decision_lines.length ? p.decision_lines.map((l, i) => `${i + 1}. ${l}`) : ['- ไม่มี']),
        '',
        '📝 งานมอบหมาย / ติดตามผล:',
        ...(p.action_lines.length ? p.action_lines.map((l, i) => `☐ ${i + 1}. ${l}`) : ['- ไม่มี']),
        '',
        p.secretary ? `✍️ ผู้จดรายงาน: ${p.secretary}` : '',
      ].filter((line) => line !== undefined);

      const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      try {
        await navigator.clipboard.writeText(text);
        this.host.showToast('📋 คัดลอกสรุปรายงานแล้ว! กดวาง (Ctrl+V) ส่งในกลุ่ม LINE ได้เลยครับ', 'ok');
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        this.host.showToast('📋 คัดลอกสรุปรายงานส่ง LINE เรียบร้อย!', 'ok');
      }
    }

    async exportPlainText() {
      const p = this._collectDocPayload();
      const lines = [
        `รายงานการประชุม: ${p.title}`,
        `วันที่/เวลา: ${p.date_str}`,
        `สถานที่: ${p.location || '-'}`,
        `ผู้เข้าร่วม: ${p.attendees || '-'}`,
        `ผู้จดรายงาน: ${p.secretary || '-'}`,
        '',
        '=== 1. สรุปสาระสำคัญ ===',
        ...p.summary_lines.map((l) => `- ${l}`),
        '',
        '=== 2. มติที่ประชุม ===',
        ...p.decision_lines.map((l, i) => `${i + 1}. ${l}`),
        '',
        '=== 3. รายการติดตามงาน (Action Items) ===',
        ...p.action_lines.map((l, i) => `[ ] ${i + 1}. ${l}`),
        '',
        '=== 4. บทถอดเสียงฉบับเต็ม ===',
        ...p.transcript_rows.map((r) => `[${r.time_label}] ${r.speaker ? `${r.speaker}: ` : ''}${r.text}`),
      ];
      const text = '\uFEFF' + lines.join('\r\n');
      try {
        const tauri = this.host.getTauri();
        if (tauri && tauri.dialog) {
          const safeTitle = p.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'รายงานการประชุม';
          const savePath = await tauri.dialog.save({
            title: 'บันทึกเป็นไฟล์ข้อความ (.TXT)',
            defaultPath: `${safeTitle}.txt`,
            filters: [{ name: 'Text File', extensions: ['txt'] }],
          });
          if (!savePath) return;
          await this.host.invokeCmd('write_text_file', { filePath: savePath, content: text });
          this.host.showToast(`💾 บันทึกไฟล์ .TXT สำเร็จ: ${this.host.getFileName(savePath)}`, 'ok');
          await this.host.invokeCmd('reveal_in_folder', { filePath: savePath }).catch(() => {});
          return;
        }
      } catch (err) {
        this.host.showToast(String(err), 'err');
      }
    }

    printReportPdf() {
      const p = this._collectDocPayload();
      const sheet = $('mt-print-sheet');
      if (sheet) {
        sheet.innerHTML = `
          <div class="mt-print-doc">
            <h1>รายงานการประชุม</h1>
            <h2>${escapeHtml(p.title)}</h2>
            <table class="mt-print-meta">
              <tr><th>วันที่ / เวลา</th><td>${escapeHtml(p.date_str)}</td></tr>
              <tr><th>สถานที่ / ช่องทาง</th><td>${escapeHtml(p.location || '-')}</td></tr>
              <tr><th>ผู้เข้าร่วมประชุม</th><td>${escapeHtml(p.attendees || '-')}</td></tr>
              <tr><th>ผู้จดรายงาน</th><td>${escapeHtml(p.secretary || '-')}</td></tr>
            </table>
            <h3>1. สรุปสาระสำคัญของการประชุม</h3>
            <ul>${(p.summary_lines.length ? p.summary_lines : ['-']).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
            <h3>2. มติที่ประชุม / ข้อตกลงสำคัญ</h3>
            <ol>${(p.decision_lines.length ? p.decision_lines : ['-']).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ol>
            <h3>3. รายการงานมอบหมายและติดตามผล (Action Items)</h3>
            <ul>${(p.action_lines.length ? p.action_lines : ['-']).map((l) => `<li>☐ ${escapeHtml(l)}</li>`).join('')}</ul>
            <h3>4. บทถอดเสียงการประชุมฉบับเต็ม</h3>
            <div class="mt-print-transcript">
              ${p.transcript_rows.map((r) => `<p><span class="ts">[${escapeHtml(r.time_label)}]</span> ${r.speaker ? `<strong>${escapeHtml(r.speaker)}:</strong> ` : ''}${escapeHtml(r.text)}</p>`).join('')}
            </div>
          </div>
        `;
      }
      window.print();
    }

    bindEvents() {
      // Hub View & Confidential Storage Controls (v1.9.0)
      $('mt-new-project-btn')?.addEventListener('click', () => this.createNewProject(null));
      $('mt-open-folder-btn')?.addEventListener('click', () => this.openLocalMeetingsFolder());
      $('mt-backup-all-btn')?.addEventListener('click', () => this.backupAllProjects());
      $('mt-import-backup-btn')?.addEventListener('click', () => this.importBackupProjects());
      $('mt-import-backup-file')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          await this._ingestBackupJsonText(text);
        } catch (err) {
          this.host.showToast(String(err), 'err');
        } finally {
          e.target.value = '';
        }
      });

      $('mt-hub-search')?.addEventListener('input', (e) => {
        this.filterQuery = e.target.value || '';
        this.renderHub();
      });
      document.querySelectorAll('[data-mt-filter-status]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.filterStatus = btn.dataset.mtFilterStatus || 'all';
          document.querySelectorAll('[data-mt-filter-status]').forEach((b) => b.classList.toggle('active', b === btn));
          this.renderHub();
        });
      });
      $('mt-hub-category-filter')?.addEventListener('change', (e) => {
        this.filterCategory = e.target.value || 'all';
        this.renderHub();
      });

      $('mt-hub-grid')?.addEventListener('click', (e) => {
        const createBtn = e.target.closest('[data-mt-hub-create]');
        if (createBtn) {
          this.createNewProject(null);
          return;
        }
        const openBtn = e.target.closest('[data-mt-open]');
        if (openBtn) {
          this.openProject(openBtn.dataset.mtOpen);
          return;
        }
        const cloneBtn = e.target.closest('[data-mt-clone]');
        if (cloneBtn) {
          const src = this.projects.find((p) => p.id === cloneBtn.dataset.mtClone);
          if (src) this.createNewProject(src);
          return;
        }
        const delBtn = e.target.closest('[data-mt-delete]');
        if (delBtn) {
          this.deleteProject(delBtn.dataset.mtDelete);
        }
      });

      // Editor Top Bar Controls
      $('mt-back-hub-btn')?.addEventListener('click', () => this.showHub());
      $('mt-category-select')?.addEventListener('change', (e) => {
        this.category = e.target.value || 'general';
        this._saveDraft(true);
      });
      $('mt-status-select')?.addEventListener('change', (e) => {
        this.status = e.target.value || 'draft';
        this._saveDraft(true);
      });
      $('mt-clone-current-btn')?.addEventListener('click', () => {
        const snap = this._buildCurrentProjectSnapshot();
        this.createNewProject(snap);
      });

      $('mt-pick-audio-btn')?.addEventListener('click', () => this.pickMeetingAudioFile());
      $('mt-import-text-btn')?.addEventListener('click', () => this.importExistingTranscript());
      $('mt-record-btn')?.addEventListener('click', () => this.toggleLiveMeetingRecord());
      $('mt-transcribe-btn')?.addEventListener('click', () => this.transcribeMeetingAudio());
      $('mt-plan-select')?.addEventListener('change', () => this.renderMediaStatus());
      $('mt-summarize-btn')?.addEventListener('click', () => this.generateMeetingSummary(false));

      $('mt-export-docx-btn')?.addEventListener('click', () => this.exportWordDocx());
      $('mt-copy-line-btn')?.addEventListener('click', () => this.copyForLine());
      $('mt-print-pdf-btn')?.addEventListener('click', () => this.printReportPdf());
      $('mt-export-txt-btn')?.addEventListener('click', () => this.exportPlainText());
      $('mt-clear-btn')?.addEventListener('click', () => {
        // v1.9.0: Safe! Never wipes previous meeting — creates a brand-new project in the local archive!
        this.createNewProject(null);
      });

      window.addEventListener('autosub-lang-changed', () => {
        if (this.viewMode === 'hub') this.renderHub();
        else {
          const badge = $('mt-save-badge');
          if (badge) badge.textContent = t('mtSavedLocally', '🔒 บันทึกในเครื่องแล้ว');
        }
      });

      // Persist metadata edits automatically
      ['mt-title', 'mt-date', 'mt-location', 'mt-attendees', 'mt-secretary', 'mt-summary', 'mt-decisions', 'mt-actions'].forEach((id) => {
        $(id)?.addEventListener('input', () => {
          this.meta.title = $('mt-title')?.value || '';
          this.meta.date_str = $('mt-date')?.value || '';
          this.meta.location = $('mt-location')?.value || '';
          this.meta.attendees = $('mt-attendees')?.value || '';
          this.meta.secretary = $('mt-secretary')?.value || '';
          this.meta.summary = $('mt-summary')?.value || '';
          this.meta.decisions = $('mt-decisions')?.value || '';
          this.meta.actions = $('mt-actions')?.value || '';
          this._saveDraft();
        });
      });

      // Speaker chips & add custom speaker
      $('mt-speaker-chips')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mt-spk]');
        if (!btn) return;
        this.selectedSpeaker = btn.dataset.mtSpk;
        this.renderSpeakerChips();
      });
      $('mt-add-speaker-btn')?.addEventListener('click', () => {
        const inp = $('mt-new-speaker-input');
        const name = (inp?.value || '').trim();
        if (!name) return;
        if (!this.speakers.includes(name)) this.speakers.push(name);
        this.selectedSpeaker = name;
        if (inp) inp.value = '';
        this._saveDraft();
        this.renderSpeakerChips();
      });

      // Speed pills
      document.querySelectorAll('[data-mt-speed]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sp = Number(btn.dataset.mtSpeed) || 1.0;
          const audio = $('mt-audio-player');
          if (audio) audio.playbackRate = sp;
          document.querySelectorAll('[data-mt-speed]').forEach((b) => b.classList.toggle('active', b === btn));
        });
      });

      // Search & Replace inside Meeting Transcript
      $('mt-filter-input')?.addEventListener('input', (e) => this.renderTranscript(e.target.value));
      $('mt-replace-btn')?.addEventListener('click', () => {
        const find = ($('mt-find-input')?.value || '').trim();
        const rep = $('mt-replace-input')?.value || '';
        if (!find) return;
        let count = 0;
        const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        for (const r of this.rows) {
          if (re.test(r.text)) {
            r.text = r.text.replace(re, rep);
            count++;
          }
        }
        this._saveDraft();
        this.renderTranscript();
        this.host.showToast(count > 0 ? `✨ แทนที่คำผิดสำเร็จ ${count} ย่อหน้า!` : 'ไม่พบคำที่ต้องการค้นหา', count > 0 ? 'ok' : 'info');
      });

      // Transcript list interactions (play, assign speaker, edit, add, delete)
      $('mt-transcript-list')?.addEventListener('click', (e) => {
        const playBtn = e.target.closest('[data-mt-play]');
        if (playBtn) {
          const idx = Number(playBtn.dataset.mtPlay);
          const row = this.rows[idx];
          const audio = $('mt-audio-player');
          this.activeRowIdx = idx;
          if (row && audio && audio.src) {
            audio.currentTime = Math.max(0, Number(row.start) || 0);
            audio.play().catch(() => {});
          } else {
            this.host.showToast('ไม่มีไฟล์เสียงแนบ (กำลังทำงานจากไฟล์ข้อความ)', 'info');
          }
          this.renderTranscript();
          return;
        }
        const spkBtn = e.target.closest('[data-mt-assign-spk]');
        if (spkBtn) {
          const idx = Number(spkBtn.dataset.mtAssignSpk);
          if (this.rows[idx]) {
            this.rows[idx].speaker = this.rows[idx].speaker === this.selectedSpeaker ? '' : this.selectedSpeaker;
            this._saveDraft();
            this.renderTranscript();
          }
          return;
        }
        const addBtn = e.target.closest('[data-mt-add-after]');
        if (addBtn) {
          const idx = Number(addBtn.dataset.mtAddAfter);
          const cur = this.rows[idx];
          this.rows.splice(idx + 1, 0, { start: cur ? cur.start + 5 : 0, speaker: this.selectedSpeaker, text: '' });
          this._saveDraft();
          this.renderTranscript();
          return;
        }
        const delBtn = e.target.closest('[data-mt-del]');
        if (delBtn) {
          const idx = Number(delBtn.dataset.mtDel);
          this.rows.splice(idx, 1);
          this._saveDraft();
          this.renderTranscript();
        }
      });

      $('mt-transcript-list')?.addEventListener('input', (e) => {
        if (e.target.dataset.mtText !== undefined) {
          const idx = Number(e.target.dataset.mtText);
          if (this.rows[idx]) {
            this.rows[idx].text = e.target.value;
            this._saveDraft();
          }
        }
      });

      // Live Karaoke Subtitle Stage synced to audio timestamp (v1.7.0)
      this._karaokeRaf = null;
      this._lastKaraokeKey = '';

      const updateKaraoke = (forceRender = false) => {
        const audioEl = $('mt-audio-player');
        const t = audioEl ? (audioEl.currentTime || 0) : 0;
        const totalDur = (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0)
          ? audioEl.duration
          : (this.mediaDuration || 0);
        const timeEl = $('mt-karaoke-time');
        if (timeEl) timeEl.textContent = `${fmtTime(t)} / ${fmtTime(totalDur)}`;

        if (!this.rows.length) return;
        let found = -1;
        for (let i = 0; i < this.rows.length; i++) {
          const r = this.rows[i];
          const nextStart = i + 1 < this.rows.length ? Number(this.rows[i + 1].start || 0) : Infinity;
          const rEnd = Number(r.end) > Number(r.start) ? Math.min(Number(r.end), nextStart) : nextStart;
          if (t >= Number(r.start || 0) && t < rEnd) {
            found = i;
            break;
          }
        }
        if (found < 0 && this.rows.length) {
          found = t < Number(this.rows[0].start || 0) ? 0 : this.rows.length - 1;
        }

        if (found !== this.activeRowIdx && found >= 0) {
          this.activeRowIdx = found;
          document.querySelectorAll('.mt-row').forEach((el) => {
            const isAct = Number(el.dataset.mtRow) === found;
            el.classList.toggle('active', isAct);
            if (isAct && audioEl && !audioEl.paused) {
              el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
        }

        const row = this.rows[found];
        if (!row) return;

        const spkEl = $('mt-karaoke-speaker');
        if (spkEl) {
          spkEl.textContent = row.speaker ? `👤 ${row.speaker}` : '👤 ยังไม่ระบุผู้พูด';
          spkEl.classList.toggle('has-spk', !!row.speaker);
        }

        const nextStart = found + 1 < this.rows.length ? Number(this.rows[found + 1].start || 0) : (totalDur > row.start ? totalDur : row.start + 6);
        const rowStart = Number(row.start || 0);
        const rowEnd = Number(row.end) > rowStart ? Number(row.end) : Math.max(rowStart + 2, nextStart);
        const span = Math.max(0.25, rowEnd - rowStart);
        const progress = Math.max(0, Math.min(1, (t - rowStart) / span));

        const tokens = splitKaraokeTokens(row.text);
        const totalChars = tokens.reduce((acc, w) => acc + w.length, 0) || 1;
        const activeCharTarget = progress * totalChars;
        let accChars = 0;
        let activeTokIdx = 0;
        for (let i = 0; i < tokens.length; i++) {
          accChars += tokens[i].length;
          if (accChars >= activeCharTarget) {
            activeTokIdx = i;
            break;
          }
        }

        const key = `${found}:${activeTokIdx}:${row.speaker || ''}:${row.text.length}`;
        if (!forceRender && key === this._lastKaraokeKey) return;
        this._lastKaraokeKey = key;

        const box = $('mt-karaoke-text');
        if (box) {
          // Rolling 2-line teleprompter window (~115 chars centered around active word)
          // Keeps karaoke stage strictly 2 lines tall even for long paragraphs!
          let winStart = activeTokIdx;
          let winEnd = activeTokIdx;
          let beforeChars = 0;
          let afterChars = tokens[activeTokIdx] ? tokens[activeTokIdx].length : 0;
          while (winStart > 0 && beforeChars + tokens[winStart - 1].length <= 42) {
            winStart--;
            beforeChars += tokens[winStart].length;
          }
          while (winEnd + 1 < tokens.length && beforeChars + afterChars + tokens[winEnd + 1].length <= 122) {
            winEnd++;
            afterChars += tokens[winEnd].length;
          }
          // Fill remaining budget from before if near the end of paragraph
          while (winStart > 0 && beforeChars + afterChars + tokens[winStart - 1].length <= 122) {
            winStart--;
            beforeChars += tokens[winStart].length;
          }
          const prefixEllipsis = winStart > 0 ? '<span class="mt-k-word done">…</span>' : '';
          const suffixEllipsis = winEnd + 1 < tokens.length ? '<span class="mt-k-word">…</span>' : '';
          const sliceHtml = tokens
            .slice(winStart, winEnd + 1)
            .map((tok, offset) => {
              const i = winStart + offset;
              const cls = i < activeTokIdx ? 'mt-k-word done' : (i === activeTokIdx ? 'mt-k-word active' : 'mt-k-word');
              return `<span class="${cls}">${escapeHtml(tok)}</span>`;
            })
            .join('');
          box.innerHTML = `<div class="mt-karaoke-inner">${prefixEllipsis}${sliceHtml}${suffixEllipsis}</div>`;
        }
      };

      this._updateKaraokeStage = updateKaraoke;

      $('mt-karaoke-assign-btn')?.addEventListener('click', () => {
        const idx = this.activeRowIdx >= 0 ? this.activeRowIdx : 0;
        if (!this.rows[idx]) {
          this.host.showToast('ยังไม่มีบทถอดเสียงให้แปะชื่อผู้พูดครับ', 'info');
          return;
        }
        this.rows[idx].speaker = this.selectedSpeaker;
        this._saveDraft();
        this.renderTranscript();
        updateKaraoke(true);
        this.host.showToast(`🏷️ แปะชื่อ "${this.selectedSpeaker}" ให้ช่วงเวลา ${fmtTime(this.rows[idx].start)} แล้ว!`, 'ok');
      });

      const audio = $('mt-audio-player');
      if (audio) {
        const tickLoop = () => {
          updateKaraoke(false);
          if (!audio.paused && !audio.ended) {
            this._karaokeRaf = requestAnimationFrame(tickLoop);
          }
        };
        audio.addEventListener('play', () => {
          if (this._karaokeRaf) cancelAnimationFrame(this._karaokeRaf);
          tickLoop();
        });
        audio.addEventListener('pause', () => {
          if (this._karaokeRaf) cancelAnimationFrame(this._karaokeRaf);
          updateKaraoke(true);
        });
        audio.addEventListener('timeupdate', () => updateKaraoke(false));
        audio.addEventListener('seeked', () => updateKaraoke(true));
        audio.addEventListener('loadedmetadata', () => updateKaraoke(true));
      }

      this.initProjects();
      updateKaraoke(true);
    }
  }

  window.DesktopMeetingWorkspace = DesktopMeetingWorkspace;
})();
