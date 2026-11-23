(() => {
  'use strict';

  const STORAGE_KEYS = {
    token: 'autosub_desktop_token',
    apiBase: 'autosub_desktop_api_base',
    plan: 'autosub_desktop_plan',
    lang: 'autosub_desktop_lang',
    extractLocal: 'autosub_desktop_extract_local',
    saveSrt: 'autosub_desktop_save_srt',
    saveVtt: 'autosub_desktop_save_vtt',
    batchFactory: 'autosub_desktop_batch_factory',
    localMap: 'autosub_desktop_local_media_map',
  };

  const PLAN_RATES_PER_MIN = { 'plan-1': 0.05, 'plan-2': 0.10, 'plan-3': 0.195 };
  const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm4v', 'flv', 'wmv']);
  const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus']);
  const ALL_MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS];

  function loadLocalMediaMap() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.localMap) || '{}'); } catch (_) { return {}; }
  }
  function saveLocalMediaMap(map) {
    try { localStorage.setItem(STORAGE_KEYS.localMap, JSON.stringify(map)); } catch (_) {}
  }

  const state = {
    activeTab: 'local',
    token: localStorage.getItem(STORAGE_KEYS.token) || '',
    apiBase: localStorage.getItem(STORAGE_KEYS.apiBase) || 'https://www.thaiautosub.com',
    plan: localStorage.getItem(STORAGE_KEYS.plan) || 'plan-2',
    lang: localStorage.getItem(STORAGE_KEYS.lang) || 'th',
    profile: null,
    ffmpeg: { available: false, bundled: false, path: '', version: '' },
    queue: [],
    running: false,
    stopRequested: false,
    nextRowId: 1,
    localMediaMap: loadLocalMediaMap(),
    localThumbCache: {},
    projects: [],
    projectsStorage: null,
    projectsLoaded: false,
    updateInfo: null,
  };

  const $ = (id) => document.getElementById(id);

  function getTauri() { return window.__TAURI__ || null; }

  async function invokeCmd(cmd, args = {}) {
    const tauri = getTauri();
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
      throw new Error('กรุณาเปิดใช้งานผ่านแอป AutoSubAI Desktop (Tauri Runtime)');
    }
    return tauri.core.invoke(cmd, args);
  }

  function toAssetUrl(localPath) {
    const tauri = getTauri();
    return tauri && tauri.core && typeof tauri.core.convertFileSrc === 'function'
      ? tauri.core.convertFileSrc(localPath)
      : '';
  }

  function showToast(msg, type = 'info') {
    const root = $('toast-root');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3800);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes, i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
  }

  function formatDuration(secs) {
    if (!secs || secs <= 0 || !Number.isFinite(secs)) return '';
    const total = Math.round(secs);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function estimateCostThb(durationSeconds, planId) {
    if (!durationSeconds || durationSeconds <= 0) return null;
    return (durationSeconds / 60.0) * (PLAN_RATES_PER_MIN[planId] ?? 0.10);
  }

  function getFileName(path) {
    const parts = String(path).split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }

  function getFileExt(path) {
    const name = getFileName(path);
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function linkLocalMedia(projectId, localPath) {
    if (!projectId || !localPath) return;
    state.localMediaMap[projectId] = localPath;
    saveLocalMediaMap(state.localMediaMap);
  }

  async function pickLocalVideoForProject(projectId) {
    const tauri = getTauri();
    if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== 'function') return '';
    const selected = await tauri.dialog.open({
      multiple: false,
      title: 'Select Local Video/Audio File',
      filters: [{ name: 'Video & Audio Files', extensions: ALL_MEDIA_EXTS }],
    });
    if (!selected || Array.isArray(selected)) return '';
    linkLocalMedia(projectId, selected);
    if (VIDEO_EXTS.has(getFileExt(selected)) && state.ffmpeg.available) {
      invokeCmd('generate_local_thumbnail', { videoPath: selected, projectId })
        .then((thumbPath) => {
          const url = toAssetUrl(thumbPath);
          if (url) {
            state.localThumbCache[projectId] = url;
            const img = document.querySelector(`img[data-thumb-id="${projectId}"]`);
            if (img) {
              img.src = url;
              img.classList.remove('hidden');
              const fb = img.parentElement && img.parentElement.querySelector('.project-thumb-fallback');
              if (fb) fb.classList.add('hidden');
            }
          }
        })
        .catch(() => {});
    }
    showToast(`ผูกไฟล์ในเครื่องสำเร็จ: ${getFileName(selected)}`, 'ok');
    return selected;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    const ws = document.querySelector('.workspace');
    if (ws) ws.classList.toggle('studio-wide', tab === 'studio');
    ['local', 'projects', 'batch', 'studio'].forEach((t) => {
      const btn = $(`tab-btn-${t}`);
      const view = $(`view-${t}`);
      if (btn) btn.classList.toggle('active', t === tab);
      if (view) view.classList.toggle('hidden', t !== tab);
    });
    if (tab === 'projects' && state.profile && !state.projectsLoaded) {
      loadWorkspaceProjects();
    }
    if (tab === 'local' && localWorkspace) {
      localWorkspace.render();
    }
  }

  function openTopupPage() {
    invokeCmd('open_cloud_studio', {
      url: `${state.apiBase}/app?page=billing`,
      token: state.token || null,
    }).catch((err) => showToast(String(err), 'err'));
  }

  function isFreeTrialAccount() {
    if (!state.profile) return false;
    if (state.profile.is_superuser) return false;
    return (state.profile.plan_tier || 'free').toLowerCase() === 'free';
  }

  let localWorkspace = null;
  let splitMerge = null;

  // Instantiate Modular Native Subtitle Studio
  const studio = new window.DesktopSubtitleStudio({
    state,
    invokeCmd,
    toAssetUrl,
    showToast,
    getFileName,
    switchTab,
    pickLocalVideoForProject,
    updateLocalProjectSegments: (id, segs, subPath) => {
      if (localWorkspace) localWorkspace.updateSegments(id, segs, subPath);
    },
    onProjectChanged: () => {
      if (splitMerge) splitMerge.resetSplitMarkers();
    },
  });

  // Instantiate 100% Local Workspace Project Manager
  localWorkspace = new window.DesktopLocalWorkspace({
    state,
    invokeCmd,
    toAssetUrl,
    showToast,
    getFileName,
    getFileExt,
    formatBytes,
    formatDuration,
    refreshProfile,
    openTopupPage,
    openLocalInStudio: (localProj) => studio.openLocalProject(localProj),
  });

  // Instantiate Phase 1 Pro Split, Demux & Multi-Clip Merge Studio
  splitMerge = new window.DesktopSplitMergeManager(
    {
      state,
      getTauri,
      invokeCmd,
      showToast,
      getFileName,
      pickLocalVideoForProject,
    },
    studio,
    localWorkspace
  );

  // --- Built-in Auto-Updater ---
  async function checkAppUpdateSilent() {
    try {
      const info = await invokeCmd('check_app_update');
      if (info && info.has_update && info.latest_version) {
        state.updateInfo = info;
        const pill = $('update-pill');
        $('update-pill-text').textContent = `Update v${info.latest_version}`;
        pill.title = `New version v${info.latest_version} available (${formatBytes(info.size_bytes)}) — Click to download & install`;
        pill.classList.remove('hidden');
      }
    } catch (_) {}
  }

  async function handleAutoUpdateClick() {
    const info = state.updateInfo;
    if (!info) return;
    const pill = $('update-pill');
    if (info.download_url && info.asset_name) {
      pill.disabled = true;
      $('update-pill-text').textContent = 'Downloading...';
      showToast(`กำลังดาวน์โหลด AutoSubAI v${info.latest_version}...`);
      try {
        await invokeCmd('download_and_launch_update', {
          downloadUrl: info.download_url,
          assetName: info.asset_name,
        });
        showToast(`เปิดไฟล์ติดตั้ง AutoSubAI v${info.latest_version} แล้ว!`, 'ok');
      } catch (err) {
        showToast(String(err), 'err');
        if (info.release_url) {
          await invokeCmd('open_cloud_studio', { url: info.release_url, token: null }).catch(() => {});
        }
      } finally {
        pill.disabled = false;
        $('update-pill-text').textContent = `Update v${info.latest_version}`;
      }
    } else if (info.release_url) {
      await invokeCmd('open_cloud_studio', { url: info.release_url, token: null }).catch(() => {});
    }
  }

  // --- Auth ---
  function setAuthError(msg) {
    const box = $('auth-error');
    if (!msg) { box.classList.add('hidden'); box.textContent = ''; }
    else { box.textContent = msg; box.classList.remove('hidden'); }
  }

  function renderAuthUI() {
    const authPanel = $('auth-panel');
    if (state.profile) {
      const email = state.profile.email || 'User';
      const bal = Number(state.profile.credit_balance_thb ?? 0);
      $('account-btn-label').textContent = `👤 ${email}`;
      $('credit-balance-text').textContent = `฿${bal.toFixed(2)}`;
      $('credit-pill').classList.remove('hidden');
      $('auth-close-btn').classList.remove('hidden');
      $('auth-user-bar').classList.remove('hidden');
      $('auth-user-info').textContent = `${email} (฿${bal.toFixed(2)})`;
      authPanel.classList.add('hidden');
    } else {
      $('account-btn-label').textContent = window.DesktopI18n.t('btnLogin');
      $('credit-pill').classList.add('hidden');
      $('auth-close-btn').classList.remove('hidden');
      $('auth-user-bar').classList.add('hidden');
      // Do NOT force open auth-panel on startup so Local Workspace works immediately like CapCut!
    }
    // Reflect Free-Trial Plan-2 Cap on Batch Plan 3 card
    const p3Card = document.querySelector('.plan-card[data-plan="plan-3"]');
    if (p3Card) {
      const locked = isFreeTrialAccount();
      p3Card.title = locked
        ? 'บัญชีเครดิตฟรี ฿10 (ยังไม่เคยเติมเงิน) ใช้ได้สูงสุด Plan 2 — เติมเงินเพื่อปลดล็อก Plan 3'
        : '';
      p3Card.style.opacity = locked ? '0.62' : '1';
      if (locked && state.plan === 'plan-3') {
        state.plan = 'plan-2';
        localStorage.setItem(STORAGE_KEYS.plan, 'plan-2');
        document.querySelectorAll('.plan-card').forEach((c) => c.classList.toggle('active', c.dataset.plan === 'plan-2'));
      }
    }
  }

  async function refreshProfile(silent = false) {
    if (!state.token) { state.profile = null; renderAuthUI(); return false; }
    try {
      state.profile = await invokeCmd('api_get_profile', { apiBase: state.apiBase, token: state.token });
      renderAuthUI();
      if (state.activeTab === 'projects') loadWorkspaceProjects();
      return true;
    } catch (err) {
      if (!silent) { setAuthError(String(err)); showToast(String(err), 'err'); }
      state.profile = null;
      renderAuthUI();
      return false;
    }
  }

  async function checkLocalFfmpeg() {
    const pill = $('ffmpeg-pill');
    const text = $('ffmpeg-pill-text');
    try {
      const info = await invokeCmd('check_ffmpeg');
      state.ffmpeg = info;
      pill.classList.remove('pill-muted', 'pill-ok', 'pill-warn');
      if (info.available) {
        pill.classList.add('pill-ok');
        pill.title = `${info.bundled ? '[Built-in] ' : ''}${info.path} — ${info.version}`;
        text.textContent = info.bundled ? '⚡ FFmpeg (Built-in)' : '⚡ FFmpeg OK';
      } else {
        pill.classList.add('pill-warn');
        text.textContent = '⚠️ No FFmpeg';
        $('opt-extract-local').checked = false;
      }
    } catch (_) {
      pill.classList.remove('pill-muted');
      pill.classList.add('pill-warn');
      text.textContent = 'Browser Preview';
    }
  }

  // --- Batch Queue ---
  function statusBadgeInfo(status) {
    switch (status) {
      case 'pending': return { cls: 'q-badge-pending', label: '⏳ Queued' };
      case 'extracting': return { cls: 'q-badge-working', label: '⚡ Extracting' };
      case 'uploading': return { cls: 'q-badge-working', label: '☁️ Uploading' };
      case 'transcribing':
      case 'processing':
      case 'queued': return { cls: 'q-badge-working', label: '🎙️ Transcribing' };
      case 'awaiting_llm': return { cls: 'q-badge-llm', label: '✨ Mastermind™ Queue' };
      case 'refining_llm': return { cls: 'q-badge-llm', label: '✨ Refining AI' };
      case 'done':
      case 'completed': return { cls: 'q-badge-done', label: '✅ Completed' };
      case 'error':
      case 'failed': return { cls: 'q-badge-error', label: '❌ Failed' };
      default: return { cls: 'q-badge-pending', label: status };
    }
  }

  async function addFilePaths(paths) {
    if (!Array.isArray(paths) || !paths.length) return;
    let added = 0;
    const existing = new Set(state.queue.map((q) => q.path));
    for (const rawPath of paths) {
      const p = String(rawPath || '').trim();
      if (!p || existing.has(p)) continue;
      const ext = getFileExt(p);
      if (!ALL_MEDIA_EXTS.includes(ext)) continue;

      let sizeBytes = 0, durationSeconds = null;
      try {
        const probe = await invokeCmd('probe_media_info', { filePath: p });
        sizeBytes = probe.size_bytes || 0;
        durationSeconds = probe.duration_seconds ?? null;
      } catch (_) {
        sizeBytes = await invokeCmd('get_file_size', { filePath: p }).catch(() => 0);
      }

      state.queue.push({
        id: state.nextRowId++,
        path: p,
        name: getFileName(p),
        ext,
        isVideo: VIDEO_EXTS.has(ext),
        originalBytes: sizeBytes,
        durationSeconds,
        extractedBytes: 0,
        status: 'pending',
        progress: 0,
        note: 'Ready',
        jobId: '',
        srtPath: '',
        vttPath: '',
        hardsubPath: '',
        renderingHardsub: false,
        costThb: null,
      });
      existing.add(p);
      added++;
    }
    if (added > 0) { showToast(`+${added} files added`, 'ok'); renderQueue(); }
  }

  function renderQueue() {
    const list = $('queue-list');
    const pendingItems = state.queue.filter((q) => q.status === 'pending' || q.status === 'error');
    const doneCount = state.queue.filter((q) => q.status === 'done').length;

    let pendingEst = 0, hasEst = false;
    for (const q of pendingItems) {
      const est = estimateCostThb(q.durationSeconds, state.plan);
      if (est != null) { pendingEst += est; hasEst = true; }
    }
    const estHtml = hasEst ? ` • Est. <strong>~฿${pendingEst.toFixed(2)}</strong>` : '';
    $('queue-stats').innerHTML = `Total <strong>${state.queue.length}</strong> • Done <strong>${doneCount}</strong> • Pending <strong>${pendingItems.length}</strong>${estHtml}`;

    $('start-queue-btn').disabled = state.running || pendingItems.length === 0;
    $('clear-done-btn').disabled = state.running || doneCount === 0;
    $('stop-queue-btn').classList.toggle('hidden', !state.running);

    if (!state.queue.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(window.DesktopI18n.t('emptyQueue'))}</div>`;
      return;
    }

    list.innerHTML = state.queue.map((item) => {
      const badge = statusBadgeInfo(item.status);
      const sizeSummary = item.extractedBytes > 0
        ? `${formatBytes(item.originalBytes)} → ${formatBytes(item.extractedBytes)}`
        : formatBytes(item.originalBytes);
      const durStr = formatDuration(item.durationSeconds);
      const durTag = durStr ? ` • ⏱️ ${durStr}` : '';
      const costTag = item.costThb != null
        ? ` • ฿${Number(item.costThb).toFixed(2)}`
        : (estimateCostThb(item.durationSeconds, state.plan) != null ? ` • ~฿${estimateCostThb(item.durationSeconds, state.plan).toFixed(2)}` : '');

      const actions = [];
      if (item.status === 'done' && item.jobId) {
        actions.push(`<button class="btn btn-primary btn-xs" data-action="studio" data-id="${item.id}">🎬 Studio</button>`);
      }
      if (item.srtPath) {
        actions.push(`<button class="btn btn-ghost btn-xs" data-action="reveal" data-id="${item.id}">📂 Folder</button>`);
      }
      if (item.status === 'done' && item.srtPath && item.isVideo) {
        actions.push(`<button class="btn btn-secondary btn-xs" data-action="hardsub" data-id="${item.id}" ${item.renderingHardsub ? 'disabled' : ''}>${item.renderingHardsub ? '⏳...' : '🔥 MP4'}</button>`);
      }
      if (!state.running || ['pending', 'done', 'error'].includes(item.status)) {
        actions.push(`<button class="btn btn-danger-ghost btn-xs" data-action="remove" data-id="${item.id}">🗑️</button>`);
      }

      return `
        <div class="queue-item">
          <div>
            <div class="q-file-name">${escapeHtml(item.name)}</div>
            <div class="q-file-meta">${escapeHtml(sizeSummary)}${escapeHtml(durTag)}${escapeHtml(costTag)}</div>
          </div>
          <div class="q-status-col">
            <span class="q-badge ${badge.cls}">${badge.label}</span>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, item.progress))}%"></div></div>
            <div class="q-note ${item.status === 'error' ? 'error' : ''}">${escapeHtml(item.note)}</div>
          </div>
          <div class="q-actions">${actions.join('')}</div>
        </div>
      `;
    }).join('');
  }

  async function processSingleItem(item) {
    const useLocalExtract = $('opt-extract-local').checked && state.ffmpeg.available && item.isVideo;
    const autoSaveSrt = $('opt-autosave-srt').checked;
    const autoSaveVtt = $('opt-autosave-vtt').checked;
    let uploadPath = item.path, tempAudioPath = '';

    try {
      if (useLocalExtract) {
        item.status = 'extracting'; item.progress = 12; item.note = 'Extracting 16kHz audio locally...'; renderQueue();
        const extracted = await invokeCmd('extract_audio_local', { videoPath: item.path });
        uploadPath = extracted.audio_path; tempAudioPath = extracted.audio_path;
        item.extractedBytes = extracted.extracted_bytes;
        item.progress = 26; renderQueue();
      }
      item.status = 'uploading'; item.progress = 32; item.note = `Uploading to ${state.apiBase}...`; renderQueue();
      const resp = await invokeCmd('upload_and_transcribe', {
        filePath: uploadPath, displayFilename: item.name,
        apiBase: state.apiBase, token: state.token, model: state.plan, language: state.lang,
      });
      if (tempAudioPath) { await invokeCmd('cleanup_temp_file', { filePath: tempAudioPath }).catch(() => {}); tempAudioPath = ''; }

      const jobId = resp.job_id || resp.id || '';
      if (!jobId) throw new Error('Missing job_id from server');
      item.jobId = jobId;
      linkLocalMedia(jobId, item.path);

      item.status = 'transcribing'; item.progress = 42; item.note = `Queued (${jobId.slice(0, 8)}...)`; renderQueue();
      let jobData = null;
      for (let attempt = 0; attempt < 1800; attempt++) {
        await sleep(3000);
        jobData = await invokeCmd('poll_job_status', { apiBase: state.apiBase, token: state.token, jobId });
        const st = String(jobData.status || '').toLowerCase();
        const srvProg = Number(jobData.progress || 0);
        if (st === 'completed') break;
        if (st === 'failed') throw new Error(jobData.error_message || 'Transcription failed');
        if (st === 'awaiting_llm') { item.status = 'awaiting_llm'; item.progress = Math.max(72, srvProg); item.note = 'Awaiting Contextual Mastermind™...'; }
        else if (st === 'refining_llm') { item.status = 'refining_llm'; item.progress = Math.max(84, srvProg); item.note = 'Refining with Contextual Mastermind™...'; }
        else { item.status = 'transcribing'; item.progress = Math.max(45, Math.min(70, srvProg || 55)); item.note = 'Transcribing on AutoSubAI Cloud...'; }
        renderQueue();
      }
      if (!jobData || String(jobData.status).toLowerCase() !== 'completed') throw new Error('Timed out waiting for job');

      item.costThb = jobData.cost_thb ?? null;
      const runBatchFactory = $('opt-batch-factory') && $('opt-batch-factory').checked && item.isVideo && state.ffmpeg.available;

      let finalSrt = jobData.srt || '';
      let finalVtt = jobData.vtt || '';
      let factoryCues = [];

      if (finalSrt && (runBatchFactory || studio.glossary)) {
        // Parse SRT blocks cleanly for Batch Drama Factory Glossary Auto-Fix & WYSIWYG Render
        const blocks = finalSrt.trim().split(/\r?\n\s*\r?\n/);
        for (const blk of blocks) {
          const lines = blk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const tsIdx = lines.findIndex((l) => l.includes('-->'));
          if (tsIdx < 0 || tsIdx + 1 >= lines.length) continue;
          const parts = lines[tsIdx].split('-->');
          const parseTs = (s) => {
            const p = s.trim().replace(',', '.').split(':');
            return p.length === 3 ? Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2]) : 0;
          };
          factoryCues.push({
            start: parseTs(parts[0]),
            end: parseTs(parts[1].split(' ')[0]),
            text: lines.slice(tsIdx + 1).join('\n'),
            secondary_text: '',
          });
        }
        if (runBatchFactory && studio.glossary && factoryCues.length) {
          const fixedCount = studio.glossary.applyToSegments(factoryCues);
          if (fixedCount > 0) {
            const toTs = (sec) => {
              const msTot = Math.round(Math.max(0, sec) * 1000);
              const ms = msTot % 1000;
              const sTot = Math.floor(msTot / 1000);
              return `${String(Math.floor(sTot / 3600)).padStart(2, '0')}:${String(Math.floor((sTot % 3600) / 60)).padStart(2, '0')}:${String(sTot % 60).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
            };
            finalSrt = factoryCues.map((c, idx) => `${idx + 1}\n${toTs(c.start)} --> ${toTs(c.end)}\n${c.text}\n`).join('\n');
            finalVtt = 'WEBVTT\n\n' + finalSrt.replace(/,/g, '.');
          }
        }
      }

      if (autoSaveSrt && finalSrt) {
        const saved = await invokeCmd('save_subtitle_next_to_source', {
          videoPath: item.path, srtContent: finalSrt, vttContent: finalVtt, saveVtt: autoSaveVtt,
        });
        item.srtPath = saved.srt_path;
        item.vttPath = saved.vtt_path || '';
        item.note = `Saved .srt (${jobData.subtitle_count || 0} cues)`;
      } else {
        item.note = `Done (${jobData.subtitle_count || 0} cues)`;
      }

      if (runBatchFactory && factoryCues.length) {
        item.progress = 92;
        item.note = '🏭 Batch Drama Factory: Rendering WYSIWYG MP4 on local GPU...';
        renderQueue();
        const renderRes = await invokeCmd('render_studio_video', {
          req: {
            video_path: item.path,
            output_path: null,
            mode: 'hardsub',
            resolution: 'original',
            cues: factoryCues,
            style: studio.style,
            delogo: studio.delogo,
            watermark: studio.watermark,
            intro_path: studio.branding.intro_path || null,
            outro_path: studio.branding.outro_path || null,
          },
        });
        item.hardsubPath = renderRes.output_path;
        item.note = `🏭 Factory MP4 Ready (${renderRes.encoder_used}): ${getFileName(renderRes.output_path)}`;
      }

      item.status = 'done'; item.progress = 100; state.projectsLoaded = false;
      renderQueue();
      await refreshProfile(true);
    } catch (err) {
      if (tempAudioPath) await invokeCmd('cleanup_temp_file', { filePath: tempAudioPath }).catch(() => {});
      item.status = 'error'; item.note = String(err); renderQueue();
    }
  }

  async function runQueue() {
    if (state.running) return;
    if (!state.token || !state.profile) {
      showToast('กรุณาเข้าสู่ระบบก่อนเริ่มถอดเสียง (สมาชิกใหม่รับเครดิตฟรี ฿10!)', 'err');
      $('auth-panel').classList.remove('hidden');
      return;
    }
    if (isFreeTrialAccount() && state.plan === 'plan-3') {
      showToast('🔒 บัญชีเครดิตฟรี ฿10 (ยังไม่เคยเติมเงิน) ใช้ได้สูงสุด Plan 2 — กรุณาเลือก Plan 1/2 หรือเติมเครดิต', 'err');
      return;
    }
    const bal = Number(state.profile.credit_balance_thb ?? 0);
    if (bal <= 0 && !(isFreeTrialAccount() && state.plan === 'plan-1')) {
      showToast('💳 เครดิตคงเหลือ ฿0.00 — กำลังเปิดหน้าเติมเงิน PromptPay...', 'err');
      openTopupPage();
      return;
    }
    state.running = true; state.stopRequested = false; renderQueue();
    for (const item of state.queue) {
      if (state.stopRequested) break;
      if (item.status !== 'pending' && item.status !== 'error') continue;
      await processSingleItem(item);
    }
    state.running = false; state.stopRequested = false; renderQueue();
    showToast('Batch queue completed!', 'ok');
  }

  async function handleBatchHardsub(rowId) {
    const item = state.queue.find((q) => q.id === rowId);
    if (!item || !item.srtPath || item.renderingHardsub) return;
    item.renderingHardsub = true; renderQueue();
    try {
      const res = await invokeCmd('render_hardsub_local', { videoPath: item.path, srtPath: item.srtPath });
      item.hardsubPath = res.output_path;
      item.note = `✅ Hardsub (${res.encoder_used}): ${getFileName(res.output_path)}`;
      showToast(item.note, 'ok');
      await invokeCmd('reveal_in_folder', { filePath: res.output_path }).catch(() => {});
    } catch (err) {
      item.note = `❌ ${err}`; showToast(String(err), 'err');
    } finally {
      item.renderingHardsub = false; renderQueue();
    }
  }

  // --- Workspace Projects ---
  async function loadWorkspaceProjects() {
    const grid = $('projects-grid');
    if (!state.token || !state.profile) {
      grid.innerHTML = '<div class="empty-state">Sign in with Google ID, Email, or API Key to view your Workspace Projects</div>';
      $('projects-storage-bar').classList.add('hidden');
      return;
    }
    grid.innerHTML = '<div class="empty-state">⏳ Loading Workspace Projects...</div>';
    try {
      const search = ($('projects-search-input').value || '').trim();
      const data = await invokeCmd('api_list_projects', { apiBase: state.apiBase, token: state.token, search });
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      state.projectsStorage = data.storage || null;
      state.projectsLoaded = true;
      renderWorkspaceProjects();
    } catch (err) {
      grid.innerHTML = `<div class="empty-state">❌ ${escapeHtml(err)}</div>`;
    }
  }

  function renderWorkspaceProjects() {
    const grid = $('projects-grid');
    const bar = $('projects-storage-bar');
    if (state.projectsStorage) {
      const usedMb = Number(state.projectsStorage.used_mb || 0);
      const quotaGb = Number(state.projectsStorage.quota_gb || 1);
      const pct = Math.min(100, Math.round(Number(state.projectsStorage.percent_used || 0)));
      $('storage-bar-label').textContent = `Cloud Media Storage: ${usedMb.toFixed(1)} MB / ${quotaGb.toFixed(1)} GB`;
      $('storage-bar-pct').textContent = `${pct}%`;
      $('storage-bar-fill').style.width = `${pct}%`;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }

    if (!state.projects.length) {
      grid.innerHTML = '<div class="empty-state">No projects yet — transcribe a file in Batch & Local tab</div>';
      return;
    }

    grid.innerHTML = state.projects.map((p) => {
      const badge = statusBadgeInfo(p.status);
      const localPath = state.localMediaMap[p.id] || '';
      const hasLocal = Boolean(localPath);
      const sourceBadge = hasLocal
        ? '<span class="thumb-badge-tr local">💻 Local 0ms</span>'
        : (p.has_media
          ? `<span class="thumb-badge-tr">☁️ ${Number(p.media_size_mb || 0).toFixed(1)} MB</span>`
          : '<span class="thumb-badge-tr">📄 Subtitles</span>');

      const cachedLocalThumb = state.localThumbCache[p.id] || '';
      const cloudThumb = p.thumbnail_url
        ? (p.thumbnail_url.startsWith('http') ? p.thumbnail_url : `${state.apiBase}${p.thumbnail_url}`)
        : `${state.apiBase}/v1/projects/${encodeURIComponent(p.id)}/thumbnail`;
      const thumbSrc = cachedLocalThumb || cloudThumb;
      const isCompleted = p.status === 'completed';

      return `
        <div class="project-card">
          <div class="project-thumb-wrap" ${isCompleted ? `data-proj-action="open-studio" data-proj-id="${escapeHtml(p.id)}"` : ''} title="${isCompleted ? 'Click to open Subtitle Studio' : ''}">
            <img class="project-thumb-img" data-thumb-id="${escapeHtml(p.id)}" src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(p.name || p.filename || '')}" loading="lazy" onerror="this.classList.add('hidden');const fb=this.nextElementSibling;if(fb)fb.classList.remove('hidden');" />
            <div class="project-thumb-fallback hidden">
              <span class="thumb-icon">🎬</span>
              <span>AutoSubAI Studio</span>
            </div>
            ${isCompleted ? '<div class="project-thumb-play"><span>▶</span></div>' : ''}
            <span class="q-badge ${badge.cls} thumb-badge-tl">${badge.label}</span>
            ${sourceBadge}
            <span class="thumb-badge-br">⏱️ ${escapeHtml(p.duration_formatted || '00:00')}</span>
          </div>
          <div class="project-card-body">
            <div>
              <div class="project-title">${escapeHtml(p.name || p.filename || p.id)}</div>
              <div class="project-meta" style="margin-top:6px;">
                <span class="meta-chip">📝 ${Number(p.subtitles_count || 0)} cues</span>
                <span class="meta-chip">${escapeHtml(p.model || 'plan-2')}</span>
                <span class="meta-chip">${escapeHtml((p.language || 'th').toUpperCase())}</span>
              </div>
              <div class="muted" style="margin-top:5px;">${escapeHtml(p.updated_at || '')}</div>
            </div>
            <div class="project-actions">
              <button class="btn btn-primary btn-xs" data-proj-action="open-studio" data-proj-id="${escapeHtml(p.id)}" ${!isCompleted ? 'disabled' : ''}>🎬 Subtitle Studio</button>
              <button class="btn btn-ghost btn-xs" data-proj-action="link-local" data-proj-id="${escapeHtml(p.id)}">📎 Link File</button>
              ${p.has_media ? `<button class="btn btn-ghost btn-xs" data-proj-action="clear-media" data-proj-id="${escapeHtml(p.id)}">🧹 Clear Video</button>` : ''}
              <button class="btn btn-danger-ghost btn-xs" data-proj-action="delete" data-proj-id="${escapeHtml(p.id)}">🗑️</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Hydrate real local video frame thumbnails via Built-in FFmpeg for local-linked videos
    hydrateLocalProjectThumbnails();
  }

  async function hydrateLocalProjectThumbnails() {
    if (!state.ffmpeg.available) return;
    for (const p of state.projects) {
      const localPath = state.localMediaMap[p.id];
      if (!localPath || state.localThumbCache[p.id]) continue;
      if (!VIDEO_EXTS.has(getFileExt(localPath))) continue;
      try {
        const thumbPath = await invokeCmd('generate_local_thumbnail', {
          videoPath: localPath,
          projectId: p.id,
        });
        const assetUrl = toAssetUrl(thumbPath);
        if (assetUrl) {
          state.localThumbCache[p.id] = assetUrl;
          const img = document.querySelector(`img[data-thumb-id="${p.id}"]`);
          if (img) {
            img.src = assetUrl;
            img.classList.remove('hidden');
            const fb = img.parentElement && img.parentElement.querySelector('.project-thumb-fallback');
            if (fb) fb.classList.add('hidden');
          }
        }
      } catch (_) {}
    }
  }

  // --- Boot & Event Binding ---
  function initUI() {
    window.DesktopI18n.applyDom();

    $('ui-lang-th').addEventListener('click', () => { window.DesktopI18n.setLang('th'); renderAuthUI(); renderQueue(); });
    $('ui-lang-en').addEventListener('click', () => { window.DesktopI18n.setLang('en'); renderAuthUI(); renderQueue(); });
    $('update-pill').addEventListener('click', handleAutoUpdateClick);

    $('api-base-input').value = state.apiBase;
    $('lang-select').value = state.lang;
    const savedExtract = localStorage.getItem(STORAGE_KEYS.extractLocal);
    if (savedExtract !== null) $('opt-extract-local').checked = savedExtract === 'true';
    const savedSrt = localStorage.getItem(STORAGE_KEYS.saveSrt);
    if (savedSrt !== null) $('opt-autosave-srt').checked = savedSrt === 'true';
    const savedVtt = localStorage.getItem(STORAGE_KEYS.saveVtt);
    if (savedVtt !== null) $('opt-autosave-vtt').checked = savedVtt === 'true';
    const savedFactory = localStorage.getItem(STORAGE_KEYS.batchFactory);
    if (savedFactory !== null && $('opt-batch-factory')) $('opt-batch-factory').checked = savedFactory === 'true';

    document.querySelectorAll('.main-tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    document.querySelectorAll('.plan-card').forEach((card) => {
      card.classList.toggle('active', card.dataset.plan === state.plan);
      card.addEventListener('click', () => {
        if (card.dataset.plan === 'plan-3' && isFreeTrialAccount()) {
          showToast('🔒 บัญชีเครดิตฟรี ฿10 (ยังไม่เคยเติมเงิน) ใช้ได้สูงสุด Plan 2 — เติมเครดิตเพื่อปลดล็อก Plan 3', 'err');
          return;
        }
        state.plan = card.dataset.plan;
        localStorage.setItem(STORAGE_KEYS.plan, state.plan);
        document.querySelectorAll('.plan-card').forEach((c) => c.classList.toggle('active', c === card));
        renderQueue();
      });
    });

    $('lang-select').addEventListener('change', (e) => { state.lang = e.target.value; localStorage.setItem(STORAGE_KEYS.lang, state.lang); });
    $('opt-extract-local').addEventListener('change', (e) => localStorage.setItem(STORAGE_KEYS.extractLocal, String(e.target.checked)));
    $('opt-autosave-srt').addEventListener('change', (e) => localStorage.setItem(STORAGE_KEYS.saveSrt, String(e.target.checked)));
    $('opt-autosave-vtt').addEventListener('change', (e) => localStorage.setItem(STORAGE_KEYS.saveVtt, String(e.target.checked)));
    if ($('opt-batch-factory')) $('opt-batch-factory').addEventListener('change', (e) => localStorage.setItem(STORAGE_KEYS.batchFactory, String(e.target.checked)));
    $('api-base-input').addEventListener('change', (e) => {
      const val = e.target.value.trim().replace(/\/+$/, '');
      if (val.startsWith('http://') || val.startsWith('https://')) { state.apiBase = val; localStorage.setItem(STORAGE_KEYS.apiBase, val); }
    });

    $('google-login-btn').addEventListener('click', async () => {
      setAuthError('');
      const btn = $('google-login-btn');
      const lbl = $('google-login-label');
      btn.disabled = true;
      lbl.textContent = '🌐 Browser opened — complete Google Sign-In...';
      try {
        const res = await invokeCmd('api_google_browser_login', { apiBase: state.apiBase });
        if (!res.access_token) throw new Error('Missing Access Token');
        state.token = res.access_token;
        localStorage.setItem(STORAGE_KEYS.token, state.token);
        state.projectsLoaded = false;
        await refreshProfile();
        showToast('Google ID Sign-In successful!', 'ok');
      } catch (err) {
        setAuthError(String(err)); showToast(String(err), 'err');
      } finally {
        btn.disabled = false;
        lbl.textContent = window.DesktopI18n.t('btnGoogle');
      }
    });

    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.authTab;
        document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('login-form').classList.toggle('hidden', target !== 'login');
        $('apikey-form').classList.toggle('hidden', target !== 'apikey');
        setAuthError('');
      });
    });

    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault(); setAuthError('');
      const btn = $('login-submit-btn'); btn.disabled = true;
      try {
        const res = await invokeCmd('api_login', { apiBase: state.apiBase, email: $('login-email').value.trim(), password: $('login-password').value });
        if (!res.access_token) throw new Error('No Access Token');
        state.token = res.access_token; localStorage.setItem(STORAGE_KEYS.token, state.token);
        $('login-password').value = ''; state.projectsLoaded = false;
        await refreshProfile(); showToast('Signed in!', 'ok');
      } catch (err) { setAuthError(String(err)); } finally { btn.disabled = false; }
    });

    $('apikey-form').addEventListener('submit', async (e) => {
      e.preventDefault(); setAuthError('');
      const key = $('apikey-input').value.trim(); if (!key) return;
      const btn = $('apikey-submit-btn'); btn.disabled = true;
      try {
        state.token = key; state.projectsLoaded = false;
        if (await refreshProfile()) { localStorage.setItem(STORAGE_KEYS.token, key); $('apikey-input').value = ''; showToast('API Key connected!', 'ok'); }
        else state.token = '';
      } finally { btn.disabled = false; }
    });

    $('account-btn').addEventListener('click', () => $('auth-panel').classList.toggle('hidden'));
    $('auth-close-btn').addEventListener('click', () => $('auth-panel').classList.add('hidden'));
    $('credit-pill').addEventListener('click', async () => { await refreshProfile(true); showToast('Credit balance refreshed', 'ok'); });
    $('logout-btn').addEventListener('click', () => {
      state.token = ''; state.profile = null; state.projects = []; state.projectsLoaded = false;
      localStorage.removeItem(STORAGE_KEYS.token); renderAuthUI(); showToast('Signed out');
    });
    $('open-cloud-btn').addEventListener('click', () => invokeCmd('open_cloud_studio', { url: `${state.apiBase}/app`, token: state.token || null }).catch((e) => showToast(String(e), 'err')));

    $('pick-files-btn').addEventListener('click', async () => {
      try {
        const tauri = getTauri();
        if (!tauri || !tauri.dialog) throw new Error('Desktop Dialog unavailable');
        const selected = await tauri.dialog.open({ multiple: true, title: 'Pick Media Files', filters: [{ name: 'Video & Audio', extensions: ALL_MEDIA_EXTS }] });
        if (!selected) return;
        await addFilePaths(Array.isArray(selected) ? selected : [selected]);
      } catch (err) { showToast(String(err), 'err'); }
    });

    $('start-queue-btn').addEventListener('click', runQueue);
    $('stop-queue-btn').addEventListener('click', () => { state.stopRequested = true; showToast('Stopping after current file'); });
    $('clear-done-btn').addEventListener('click', () => { state.queue = state.queue.filter((q) => q.status !== 'done'); renderQueue(); });

    $('queue-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]'); if (!btn) return;
      const item = state.queue.find((q) => q.id === Number(btn.dataset.id)); if (!item) return;
      if (btn.dataset.action === 'remove') { state.queue = state.queue.filter((q) => q.id !== item.id); renderQueue(); }
      else if (btn.dataset.action === 'reveal') await invokeCmd('reveal_in_folder', { filePath: item.srtPath || item.path }).catch((err) => showToast(String(err), 'err'));
      else if (btn.dataset.action === 'hardsub') await handleBatchHardsub(item.id);
      else if (btn.dataset.action === 'studio' && item.jobId) await studio.openProject(item.jobId, item.path);
    });

    $('projects-refresh-btn').addEventListener('click', loadWorkspaceProjects);
    let searchTimer = null;
    $('projects-search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadWorkspaceProjects, 350); });

    $('projects-grid').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-proj-action]'); if (!btn) return;
      const projId = btn.dataset.projId; if (!projId) return;
      const action = btn.dataset.projAction;
      if (action === 'open-studio') await studio.openProject(projId);
      else if (action === 'link-local') { if (await pickLocalVideoForProject(projId)) renderWorkspaceProjects(); }
      else if (action === 'clear-media') {
        try {
          await invokeCmd('api_clear_project_media', { apiBase: state.apiBase, token: state.token, projectId: projId });
          showToast('Cleared cloud video (subtitles kept)', 'ok'); await loadWorkspaceProjects();
        } catch (err) { showToast(String(err), 'err'); }
      } else if (action === 'delete') {
        if (!window.confirm('Delete this project permanently?')) return;
        try {
          await invokeCmd('api_delete_project', { apiBase: state.apiBase, token: state.token, projectId: projId });
          showToast('Project deleted', 'ok'); await loadWorkspaceProjects();
        } catch (err) { showToast(String(err), 'err'); }
      }
    });

    const dropZone = $('drop-zone');
    const tauri = getTauri();
    if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
      tauri.event.listen('tauri://drag-enter', () => dropZone.classList.add('drag-over'));
      tauri.event.listen('tauri://drag-leave', () => dropZone.classList.remove('drag-over'));
      tauri.event.listen('tauri://drag-drop', async (ev) => {
        dropZone.classList.remove('drag-over');
        const paths = ev && ev.payload && Array.isArray(ev.payload.paths) ? ev.payload.paths : [];
        if (paths.length) {
          if (state.activeTab === 'local') {
            await localWorkspace.addMediaPaths(paths);
          } else {
            if (state.activeTab !== 'batch') switchTab('batch');
            await addFilePaths(paths);
          }
        }
      });
    }

    localWorkspace.bindEvents();
    studio.bindEvents();
    if (splitMerge) splitMerge.bindEvents();
  }

  window.addEventListener('DOMContentLoaded', async () => {
    initUI();
    renderQueue();
    localWorkspace.render();
    await checkLocalFfmpeg();
    localWorkspace.render();
    await refreshProfile(true);
    setTimeout(checkAppUpdateSilent, 2500);
  });
})();
