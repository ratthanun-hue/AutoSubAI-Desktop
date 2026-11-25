//! 1-Step Native Offline Whisper Engine (`whisper.cpp` bundled sidecar).
//!
//! Architecture:
//! 1. Uses bundled `ffmpeg` to convert any video/audio into 16kHz mono PCM WAV.
//! 2. Runs bundled static `whisper-cli` (whisper.cpp — CPU / Apple Silicon Metal)
//!    in a single step (`-oj` JSON output) with no-speech hallucination guard.
//! 3. Models (`ggml-*.bin`) are downloaded on demand into `<app_data_dir>/whisper_models/`
//!    so the native installer stays small (~27 MB).
//! 4. Remote feature flag & model visibility are controlled live from `GET /v1/desktop/config`
//!    on `thaiautosub.com` (cached locally up to 7 days for true offline resilience).

use crate::ffmpeg_engine::{check_ffmpeg_info, probe_media};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const POLICY_CACHE_MAX_AGE_SECS: u64 = 7 * 24 * 3600;
const ALLOWED_MODEL_HOSTS: [&str; 4] = [
    "https://huggingface.co/",
    "https://hf.co/",
    "https://www.thaiautosub.com/",
    "https://thaiautosub.com/",
];

#[derive(Serialize)]
pub struct WhisperDownloadedModel {
    pub filename: String,
    pub size_bytes: u64,
    pub path: String,
}

#[derive(Serialize)]
pub struct WhisperLocalStatus {
    pub engine_available: bool,
    pub engine_bundled: bool,
    pub engine_path: String,
    pub models_dir: String,
    pub downloaded: Vec<WhisperDownloadedModel>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WhisperSegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Serialize)]
pub struct WhisperTranscribeResult {
    pub engine: String,
    pub model_filename: String,
    pub language: String,
    pub duration_seconds: f64,
    pub elapsed_seconds: f64,
    pub text: String,
    pub srt: String,
    pub vtt: String,
    pub segments: Vec<WhisperSegment>,
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn find_bundled_whisper_cli() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    #[cfg(target_os = "windows")]
    let candidates = [
        dir.join("whisper-cli.exe"),
        dir.join("binaries")
            .join("whisper-cli-x86_64-pc-windows-msvc.exe"),
    ];

    #[cfg(not(target_os = "windows"))]
    let candidates = [
        dir.join("whisper-cli"),
        dir.join("binaries")
            .join("whisper-cli-aarch64-apple-darwin"),
        dir.join("binaries").join("whisper-cli-x86_64-apple-darwin"),
        dir.join("binaries")
            .join("whisper-cli-x86_64-unknown-linux-gnu"),
        dir.join("binaries")
            .join("whisper-cli-aarch64-unknown-linux-gnu"),
    ];

    for cand in candidates {
        if cand.is_file() {
            if let Some(s) = cand.to_str() {
                return Some(s.to_string());
            }
        }
    }
    None
}

async fn resolve_whisper_cli() -> (bool, bool, String) {
    if let Some(bundled) = find_bundled_whisper_cli() {
        return (true, true, bundled);
    }
    for bin in ["whisper-cli", "whisper-cpp", "main"] {
        let mut cmd = Command::new(bin);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if let Ok(out) = cmd.arg("--help").output().await {
            if out.status.success() || !out.stderr.is_empty() || !out.stdout.is_empty() {
                return (true, false, bin.to_string());
            }
        }
    }
    (false, false, String::new())
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("ไม่สามารถเข้าถึงโฟลเดอร์ข้อมูลแอปได้: {}", e))?;
    let dir = base.join("whisper_models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("ไม่สามารถสร้างโฟลเดอร์ whisper_models ได้: {}", e))?;
    Ok(dir)
}

fn policy_cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("whisper_policy_cache.json"))
}

fn sanitize_model_filename(raw: &str) -> Result<String, String> {
    let name = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if name.is_empty()
        || !name.ends_with(".bin")
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("ชื่อไฟล์โมเดลไม่ถูกต้อง (ต้องลงท้ายด้วย .bin)".to_string());
    }
    Ok(name.to_string())
}

fn default_offline_policy() -> Value {
    json!({
        "status": "fallback",
        "offline_whisper_enabled": true,
        "max_offline_minutes": 15,
        "default_model": "base",
        "models": [
            {
                "id": "base",
                "enabled": true,
                "label_th": "โมเดลถอดเสียง (เวอร์ชั่นฟรี)",
                "label_en": "Voice Model (Free Version)",
                "desc_th": "เวอร์ชั่นฟรี-ไม่หักเครดิต",
                "desc_en": "Free Version — 0 Credits",
                "filename": "ggml-base.bin",
                "size_mb": 148,
                "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
                "allowed_tiers": ["free", "payg", "creator", "pro"]
            }
        ],
        "cloud_upsell_banner_th": "เวอร์ชั่นฟรี-ไม่หักเครดิต (ถอดเสียงออฟไลน์ในเครื่อง) — หากต้องการความแม่นยำภาษาไทยสูงขึ้น สามารถเลือกใช้ Cloud AI เพิ่มเติมได้",
        "cloud_upsell_banner_en": "Free Version — 0 Credits (Local Offline) — You can also use Cloud AI anytime for higher Thai accuracy."
    })
}

pub async fn fetch_remote_config(
    app: &AppHandle,
    api_base: &str,
    token: Option<String>,
) -> Result<Value, String> {
    let base = api_base.trim_end_matches('/');
    let url = format!("{}/v1/desktop/config", base);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("AutoSubAI-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.bearer_auth(t.trim());
        }
    }

    if let Ok(resp) = req.send().await {
        if resp.status().is_success() {
            if let Ok(val) = resp.json::<Value>().await {
                if let Some(cp) = policy_cache_path(app) {
                    if let Some(parent) = cp.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let wrapped = json!({
                        "cached_at": now_unix_secs(),
                        "config": val,
                    });
                    let _ = std::fs::write(&cp, wrapped.to_string());
                }
                return Ok(val);
            }
        }
    }

    // Offline fallback: reuse last synced server policy if < 7 days old
    if let Some(cp) = policy_cache_path(app) {
        if let Ok(raw) = std::fs::read_to_string(&cp) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                let cached_at = parsed
                    .get("cached_at")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if now_unix_secs().saturating_sub(cached_at) <= POLICY_CACHE_MAX_AGE_SECS {
                    if let Some(cfg) = parsed.get("config") {
                        return Ok(cfg.clone());
                    }
                }
            }
        }
    }

    Ok(default_offline_policy())
}

pub async fn list_local_models(app: &AppHandle) -> Result<WhisperLocalStatus, String> {
    let (avail, bundled, engine_path) = resolve_whisper_cli().await;
    let dir = models_dir(app)?;
    let mut downloaded = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                let fname = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if fname.ends_with(".bin") {
                    let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if size_bytes >= 1_000_000 {
                        downloaded.push(WhisperDownloadedModel {
                            filename: fname,
                            size_bytes,
                            path: p.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    downloaded.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(WhisperLocalStatus {
        engine_available: avail,
        engine_bundled: bundled,
        engine_path,
        models_dir: dir.to_string_lossy().to_string(),
        downloaded,
    })
}

pub async fn download_model(
    app: &AppHandle,
    model_id: &str,
    url: &str,
    filename: &str,
) -> Result<WhisperDownloadedModel, String> {
    let clean_url = url.trim();
    if !ALLOWED_MODEL_HOSTS
        .iter()
        .any(|prefix| clean_url.starts_with(prefix))
    {
        return Err("URL ดาวน์โหลดโมเดลไม่ได้รับอนุญาต (HTTPS Allowlist)".to_string());
    }

    let safe_name = sanitize_model_filename(filename)?;
    let dir = models_dir(app)?;
    let final_path = dir.join(&safe_name);
    let tmp_path = dir.join(format!("{}.part", safe_name));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .user_agent(format!("AutoSubAI-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("สร้าง HTTP client ไม่สำเร็จ: {}", e))?;

    let resp = client
        .get(clean_url)
        .send()
        .await
        .map_err(|e| format!("เชื่อมต่อดาวน์โหลดโมเดลไม่สำเร็จ: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("ดาวน์โหลดโมเดลไม่สำเร็จ (HTTP {})", resp.status()));
    }

    let total_bytes = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("สร้างไฟล์ชั่วคราวไม่สำเร็จ: {}", e))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut header_checked = false;
    let mut last_emit = Instant::now();

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("ดาวน์โหลดขาดช่วง: {}", e)
        })?;
        if !header_checked && chunk.len() >= 4 {
            // Verify GGML binary magic ("lmgg" little-endian = 0x67676d6c)
            let magic = &chunk[0..4];
            if magic != b"lmgg" && magic != b"ggml" {
                let _ = std::fs::remove_file(&tmp_path);
                return Err("ไฟล์ที่ดาวน์โหลดไม่ใช่โมเดล GGML Whisper ที่ถูกต้อง".to_string());
            }
            header_checked = true;
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("เขียนไฟล์โมเดลไม่สำเร็จ: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(200) {
            let pct = if total_bytes > 0 {
                ((downloaded as f64 / total_bytes as f64) * 100.0).min(99.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "whisper-download-progress",
                json!({
                    "model_id": model_id,
                    "filename": safe_name,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total_bytes,
                    "percent": pct,
                }),
            );
            last_emit = Instant::now();
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush ไฟล์โมเดลไม่สำเร็จ: {}", e))?;
    drop(file);

    if downloaded < 1_000_000 {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("ไฟล์โมเดลมีขนาดเล็กผิดปกติ กรุณาดาวน์โหลดใหม่".to_string());
    }

    if final_path.exists() {
        let _ = std::fs::remove_file(&final_path);
    }
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| format!("ย้ายไฟล์โมเดลไม่สำเร็จ: {}", e))?;

    let _ = app.emit(
        "whisper-download-progress",
        json!({
            "model_id": model_id,
            "filename": safe_name,
            "downloaded_bytes": downloaded,
            "total_bytes": downloaded,
            "percent": 100.0,
        }),
    );

    Ok(WhisperDownloadedModel {
        filename: safe_name,
        size_bytes: downloaded,
        path: final_path.to_string_lossy().to_string(),
    })
}

pub fn delete_model(app: &AppHandle, filename: &str) -> Result<bool, String> {
    let safe_name = sanitize_model_filename(filename)?;
    let dir = models_dir(app)?;
    let target = dir.join(&safe_name);
    if target.is_file() {
        std::fs::remove_file(&target).map_err(|e| format!("ลบไฟล์โมเดลไม่สำเร็จ: {}", e))?;
        return Ok(true);
    }
    Ok(false)
}

fn fmt_srt_time(sec: f64) -> String {
    let ms_total = (sec.max(0.0) * 1000.0).round() as u64;
    let h = ms_total / 3_600_000;
    let m = (ms_total % 3_600_000) / 60_000;
    let s = (ms_total % 60_000) / 1000;
    let ms = ms_total % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

fn fmt_vtt_time(sec: f64) -> String {
    fmt_srt_time(sec).replace(',', ".")
}

fn build_srt_vtt(segments: &[WhisperSegment]) -> (String, String, String) {
    let mut srt = String::new();
    let mut vtt = String::from("WEBVTT\n\n");
    let mut plain = Vec::with_capacity(segments.len());
    for (idx, seg) in segments.iter().enumerate() {
        let t = seg.text.trim();
        if t.is_empty() {
            continue;
        }
        srt.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            fmt_srt_time(seg.start),
            fmt_srt_time(seg.end),
            t
        ));
        vtt.push_str(&format!(
            "{} --> {}\n{}\n\n",
            fmt_vtt_time(seg.start),
            fmt_vtt_time(seg.end),
            t
        ));
        plain.push(t.to_string());
    }
    (srt, vtt, plain.join("\n"))
}

fn clean_hallucination_text(raw: &str) -> String {
    let mut s = raw
        .replace("[เสียงดนตรี]", "")
        .replace("(เสียงดนตรี)", "")
        .replace("[ดนตรี]", "")
        .replace("(ดนตรี)", "")
        .replace("[เสียงเพลง]", "")
        .replace("(เสียงเพลง)", "")
        .replace("[เพลง]", "")
        .replace("(เพลง)", "")
        .replace("[เสียงปรบมือ]", "")
        .replace("(เสียงปรบมือ)", "")
        .replace("[เสียงหัวเราะ]", "")
        .replace("(เสียงหัวเราะ)", "")
        .replace("[เสียงรบกวน]", "")
        .replace("[BLANK_AUDIO]", "")
        .replace("[blank_audio]", "")
        .replace("[SILENCE]", "")
        .replace("(SILENCE)", "")
        .replace("[silence]", "")
        .replace("(silence)", "")
        .replace("[MUSIC]", "")
        .replace("(MUSIC)", "")
        .replace("[Music]", "")
        .replace("(Music)", "")
        .replace("[music]", "")
        .replace("(music)", "")
        .replace("[APPLAUSE]", "")
        .replace("[Applause]", "")
        .replace('♪', "")
        .replace('♫', "")
        .replace('♬', "")
        .trim()
        .to_string();

    // Collapse multiple spaces left behind after stripping inline tags
    while s.contains("  ") {
        s = s.replace("  ", " ");
    }
    s.trim().to_string()
}

fn is_non_speech_only(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    // Pure bracketed/parenthesized sound-effect tag e.g. "[...]" or "(...)"
    if (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) {
        let inner = &t[1..t.len().saturating_sub(1)];
        if !inner.contains('[') && !inner.contains('(') && inner.chars().count() <= 40 {
            return true;
        }
    }
    let lower = t.to_lowercase();
    matches!(
        lower.as_str(),
        "เสียงดนตรี"
            | "ดนตรี"
            | "เสียงเพลง"
            | "เพลง"
            | "เพลงประกอบ"
            | "เสียงปรบมือ"
            | "เสียงหัวเราะ"
            | "music"
            | "applause"
            | "silence"
            | "blank_audio"
            | "..."
            | "."
            | "-"
    )
}

fn parse_whisper_json_segments(val: &Value) -> Vec<WhisperSegment> {
    let mut out: Vec<WhisperSegment> = Vec::new();
    let arr = match val.get("transcription").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return out,
    };

    let mut last_norm = String::new();
    let mut repeat_run: usize = 0;

    for item in arr {
        let raw_text = item
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if raw_text.is_empty() {
            continue;
        }

        let cleaned = clean_hallucination_text(raw_text);
        if is_non_speech_only(&cleaned) {
            continue;
        }

        // Guard against consecutive repetition loops (>2 identical lines in a row)
        let norm = cleaned.to_lowercase();
        if norm == last_norm {
            repeat_run += 1;
            if repeat_run >= 2 {
                continue;
            }
        } else {
            last_norm = norm;
            repeat_run = 0;
        }

        let start_ms = item
            .get("offsets")
            .and_then(|o| o.get("from"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let end_ms = item
            .get("offsets")
            .and_then(|o| o.get("to"))
            .and_then(|v| v.as_f64())
            .unwrap_or(start_ms + 1000.0);

        let start = (start_ms / 1000.0).max(0.0);
        let end = (end_ms / 1000.0).max(start + 0.2);

        out.push(WhisperSegment {
            start: (start * 1000.0).round() / 1000.0,
            end: (end * 1000.0).round() / 1000.0,
            text: cleaned,
        });
    }
    out
}

pub async fn transcribe_local_file(
    app: &AppHandle,
    media_path: &str,
    model_filename: &str,
    language: &str,
    max_minutes: Option<u32>,
) -> Result<WhisperTranscribeResult, String> {
    let t_start = Instant::now();
    let src = Path::new(media_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอหรือไฟล์เสียงต้นฉบับในเครื่อง".to_string());
    }

    let (engine_ok, _, whisper_bin) = resolve_whisper_cli().await;
    if !engine_ok || whisper_bin.is_empty() {
        return Err(
            "ไม่พบเอนจิน whisper-cli ในเครื่อง กรุณาอัปเดตเป็น AutoSubAI Desktop v1.10.0 ขึ้นไป"
                .to_string(),
        );
    }

    let safe_model = sanitize_model_filename(model_filename)?;
    let model_path = models_dir(app)?.join(&safe_model);
    if !model_path.is_file() {
        return Err(format!(
            "ยังไม่ได้ดาวน์โหลดโมเดล {} กรุณากดปุ่มดาวน์โหลดโมเดลก่อนเริ่มถอดเสียง",
            safe_model
        ));
    }

    let ffmpeg_info = check_ffmpeg_info().await;
    if !ffmpeg_info.available || ffmpeg_info.path.is_empty() {
        return Err("ไม่พบ FFmpeg สำหรับสกัดเสียง 16kHz WAV".to_string());
    }

    let dur = probe_media(media_path)
        .await
        .ok()
        .and_then(|m| m.duration_seconds)
        .unwrap_or(0.0);

    let limit_mins = max_minutes.unwrap_or(15).clamp(1, 180);
    if dur > (limit_mins as f64) * 60.0 + 5.0 {
        return Err(format!(
            "โหมดฟรีออฟไลน์จำกัดความยาวสูงสุด {} นาทีต่อไฟล์ (ไฟล์นี้ยาว {:.1} นาที) — แนะนำใช้ Cloud Pro เพื่อถอดไฟล์ยาวถึง 180–300 นาที",
            limit_mins,
            dur / 60.0
        ));
    }

    // Step 1A: Convert input media to 16kHz mono PCM WAV with Voice Pre-Filter
    // (bandpass 80Hz..7800Hz + dynaudnorm lifts quiet Thai speech above background music)
    let stamp = format!("{}_{}", std::process::id(), now_unix_secs());
    let temp_dir = std::env::temp_dir();
    let wav_path = temp_dir.join(format!("autosub_wcpp_{}.wav", stamp));
    let out_prefix = temp_dir.join(format!("autosub_wcpp_out_{}", stamp));
    let out_json_path = temp_dir.join(format!("autosub_wcpp_out_{}.json", stamp));

    let max_sec_str = (limit_mins * 60).to_string();
    let mut ff_cmd = Command::new(&ffmpeg_info.path);
    #[cfg(target_os = "windows")]
    ff_cmd.creation_flags(0x08000000);
    let ff_out = ff_cmd
        .args([
            "-y",
            "-i",
            media_path,
            "-t",
            &max_sec_str,
            "-vn",
            "-af",
            "highpass=f=80,lowpass=f=7800,dynaudnorm=f=150:g=15",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            &wav_path.to_string_lossy(),
        ])
        .output()
        .await
        .map_err(|e| format!("รัน FFmpeg สกัดเสียงไม่สำเร็จ: {}", e))?;

    // Fallback without -af if any exotic media stream rejects the audio filtergraph
    if !ff_out.status.success() || !wav_path.is_file() {
        let mut ff_fallback = Command::new(&ffmpeg_info.path);
        #[cfg(target_os = "windows")]
        ff_fallback.creation_flags(0x08000000);
        let fb_out = ff_fallback
            .args([
                "-y",
                "-i",
                media_path,
                "-t",
                &max_sec_str,
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                &wav_path.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| format!("รัน FFmpeg สกัดเสียงไม่สำเร็จ: {}", e))?;
        if !fb_out.status.success() || !wav_path.is_file() {
            let _ = tokio::fs::remove_file(&wav_path).await;
            return Err("สกัดเสียง 16kHz WAV ไม่สำเร็จ ไฟล์อาจเสียหายหรือไม่มีแทร็กเสียง".to_string());
        }
    }

    // Step 1B: Run single-step whisper.cpp (`whisper-cli`) -> JSON output
    // Critical anti-hallucination flags:
    //   -mc 0   : disable cross-window text context (prevents [เสียงดนตรี] infinite loop!)
    //   -sns    : suppress non-speech tokens (music/applause tags)
    //   -et 2.4 : entropy threshold to break repetitive decoder loops
    //   -tp 0.0 -tpi 0.2 : greedy start + automatic temperature fallback
    //   --no-speech-thold 0.50 : balanced non-speech gating
    // GPU acceleration:
    //   - Windows: Vulkan GPU (auto-detects vulkan-1.dll, auto-retries with -ng CPU fallback on driver error)
    //   - macOS ARM64: Apple Metal GPU (with auto -ng CPU fallback)
    let lang_clean = match language.trim().to_lowercase().as_str() {
        "th" | "en" | "zh" | "ja" | "ko" | "auto" => language.trim().to_lowercase(),
        _ => "th".to_string(),
    };
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4)
        .to_string();

    #[cfg(target_os = "windows")]
    let has_gpu_runtime = Path::new(r"C:\Windows\System32\vulkan-1.dll").is_file();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let has_gpu_runtime = true;
    #[cfg(not(any(target_os = "windows", all(target_os = "macos", target_arch = "aarch64"))))]
    let has_gpu_runtime = false;

    let base_args: Vec<String> = vec![
        "-m".into(),
        model_path.to_string_lossy().to_string(),
        "-f".into(),
        wav_path.to_string_lossy().to_string(),
        "-l".into(),
        lang_clean.clone(),
        "-t".into(),
        threads,
        "-mc".into(),
        "0".into(),
        "-sns".into(),
        "-et".into(),
        "2.4".into(),
        "-tp".into(),
        "0.0".into(),
        "-tpi".into(),
        "0.2".into(),
        "--no-speech-thold".into(),
        "0.50".into(),
        "-oj".into(),
        "-of".into(),
        out_prefix.to_string_lossy().to_string(),
    ];

    let mut used_cpu_fallback = !has_gpu_runtime;
    let mut run_args = base_args.clone();
    if used_cpu_fallback {
        run_args.push("-ng".into());
    }

    let mut w_cmd = Command::new(&whisper_bin);
    #[cfg(target_os = "windows")]
    w_cmd.creation_flags(0x08000000);
    let mut w_out = w_cmd.args(&run_args).output().await;

    // Auto-fallback to CPU (-ng) if GPU backend fails (e.g. unsupported driver / low VRAM)
    let gpu_failed = match &w_out {
        Ok(o) => !o.status.success() || !out_json_path.is_file(),
        Err(_) => true,
    };
    if gpu_failed && !used_cpu_fallback {
        let _ = tokio::fs::remove_file(&out_json_path).await;
        used_cpu_fallback = true;
        let mut cpu_args = base_args;
        cpu_args.push("-ng".into());
        let mut fb_cmd = Command::new(&whisper_bin);
        #[cfg(target_os = "windows")]
        fb_cmd.creation_flags(0x08000000);
        w_out = fb_cmd.args(&cpu_args).output().await;
    }

    let _ = tokio::fs::remove_file(&wav_path).await;

    let w_out = match w_out {
        Ok(o) => o,
        Err(e) => {
            let _ = tokio::fs::remove_file(&out_json_path).await;
            return Err(format!("เรียกใช้งาน whisper-cli ไม่สำเร็จ: {}", e));
        }
    };

    if !w_out.status.success() || !out_json_path.is_file() {
        let stderr_tail = String::from_utf8_lossy(&w_out.stderr);
        let snippet: String = stderr_tail.chars().rev().take(240).collect::<String>().chars().rev().collect();
        let _ = tokio::fs::remove_file(&out_json_path).await;
        return Err(format!("ถอดเสียงออฟไลน์ไม่สำเร็จ: {}", snippet.trim()));
    }

    let raw_json = tokio::fs::read_to_string(&out_json_path)
        .await
        .map_err(|e| format!("อ่านผลลัพธ์ JSON ไม่สำเร็จ: {}", e))?;
    let _ = tokio::fs::remove_file(&out_json_path).await;

    let parsed: Value = serde_json::from_str(&raw_json)
        .map_err(|e| format!("แปลงผลลัพธ์ JSON จาก whisper.cpp ไม่สำเร็จ: {}", e))?;

    let segments = parse_whisper_json_segments(&parsed);
    if segments.is_empty() {
        return Err(
            "ไม่พบเสียงพูดที่ชัดเจนในไฟล์นี้ (อาจมีเสียงดนตรีดังกว่าเสียงพูดหรือไฟล์เงียบ) — สามารถเลือกใช้ Cloud AI ที่มีระบบแยกเสียงดนตรีเพิ่มเติมได้ครับ"
                .to_string(),
        );
    }
    let (srt, vtt, text) = build_srt_vtt(&segments);
    let elapsed = (t_start.elapsed().as_secs_f64() * 100.0).round() / 100.0;

    let engine_label = if !used_cpu_fallback {
        #[cfg(target_os = "windows")]
        {
            "whisper.cpp (Vulkan GPU)".to_string()
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            "whisper.cpp (Metal GPU)".to_string()
        }
        #[cfg(not(any(target_os = "windows", all(target_os = "macos", target_arch = "aarch64"))))]
        {
            "whisper.cpp (CPU)".to_string()
        }
    } else {
        "whisper.cpp (CPU)".to_string()
    };

    Ok(WhisperTranscribeResult {
        engine: engine_label,
        model_filename: safe_model,
        language: lang_clean,
        duration_seconds: dur,
        elapsed_seconds: elapsed,
        text,
        srt,
        vtt,
        segments,
    })
}
