mod ass_builder;
mod docx_builder;
mod ffmpeg_engine;
mod patch_engine;
mod tts_engine;
mod whisper_engine;

use ass_builder::{build_ass_document, CueItem, SubtitleStyleConfig};
use ffmpeg_engine::{
    check_ffmpeg_info, extract_audio_mp3, extract_audio_waveform as run_waveform_extract,
    generate_local_thumbnail as run_local_thumb, probe_media, render_simple_hardsub,
    render_studio_video as run_studio_render, render_trimmed_cut_video as run_trim_cut,
    render_viral_shorts_916 as run_viral_shorts, ExtractedAudio, FfmpegInfo, HardsubResult,
    MediaProbeInfo, StudioRenderRequest, TrimCutRequest, ViralShortsRequest,
};
use reqwest::multipart;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Serialize)]
struct SaveSubResult {
    srt_path: String,
    vtt_path: Option<String>,
}

// ---------------------------------------------------------------------------
// System Browser & URL Encoding Helpers
// ---------------------------------------------------------------------------
fn open_in_system_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("อนุญาตเฉพาะ URL ที่ขึ้นต้นด้วย https:// เท่านั้น".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|e| format!("เปิดเบราว์เซอร์ไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("เปิดเบราว์เซอร์ไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("เปิดเบราว์เซอร์ไม่สำเร็จ: {}", e))?;
    }
    Ok(())
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let k = kv.next().unwrap_or("");
        let v = kv.next().unwrap_or("");
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Local Media & FFmpeg Commands
// ---------------------------------------------------------------------------
#[tauri::command]
async fn check_ffmpeg() -> FfmpegInfo {
    check_ffmpeg_info().await
}

#[tauri::command]
async fn get_file_size(file_path: String) -> Result<u64, String> {
    let meta = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("อ่านขนาดไฟล์ไม่สำเร็จ: {}", e))?;
    Ok(meta.len())
}

#[tauri::command]
async fn file_exists(file_path: String) -> bool {
    if file_path.trim().is_empty() {
        return false;
    }
    tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false)
}

#[tauri::command]
async fn probe_media_info(file_path: String) -> Result<MediaProbeInfo, String> {
    probe_media(&file_path).await
}

#[tauri::command]
async fn extract_audio_local(video_path: String) -> Result<ExtractedAudio, String> {
    extract_audio_mp3(&video_path).await
}

#[tauri::command]
async fn cleanup_temp_file(file_path: String) -> Result<(), String> {
    if !file_path.is_empty() {
        let _ = tokio::fs::remove_file(&file_path).await;
    }
    Ok(())
}

#[tauri::command]
async fn write_text_file(file_path: String, content: String) -> Result<String, String> {
    tokio::fs::write(&file_path, content.as_bytes())
        .await
        .map_err(|e| format!("บันทึกไฟล์ไม่สำเร็จ: {}", e))?;
    Ok(file_path)
}

#[tauri::command]
async fn read_text_file(file_path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[tauri::command]
async fn find_adjacent_subtitle(video_path: String) -> Option<String> {
    let src = PathBuf::from(&video_path);
    for ext in ["srt", "vtt"] {
        let cand = src.with_extension(ext);
        if let Ok(meta) = tokio::fs::metadata(&cand).await {
            if meta.is_file() && meta.len() > 0 {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[tauri::command]
async fn write_temp_srt(project_id: String, srt_content: String) -> Result<String, String> {
    let clean_id: String = project_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut out_path = std::env::temp_dir();
    out_path.push(format!("autosub_studio_{}_{}.srt", clean_id, ts));
    tokio::fs::write(&out_path, srt_content.as_bytes())
        .await
        .map_err(|e| format!("สร้างไฟล์ซับชั่วคราวไม่สำเร็จ: {}", e))?;
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
fn generate_ass_content(cues: Vec<CueItem>, style: SubtitleStyleConfig) -> String {
    build_ass_document(&cues, &style, 1920, 1080)
}

#[tauri::command]
async fn render_hardsub_local(
    app: AppHandle,
    video_path: String,
    srt_path: String,
) -> Result<HardsubResult, String> {
    render_simple_hardsub(&app, &video_path, &srt_path).await
}

#[tauri::command]
async fn render_studio_video(
    app: AppHandle,
    req: StudioRenderRequest,
) -> Result<HardsubResult, String> {
    run_studio_render(&app, req).await
}

#[tauri::command]
async fn extract_audio_waveform(video_path: String, num_bins: u32) -> Result<Vec<f32>, String> {
    run_waveform_extract(&video_path, num_bins).await
}

#[tauri::command]
async fn render_trimmed_cut_video(
    app: AppHandle,
    req: TrimCutRequest,
) -> Result<HardsubResult, String> {
    run_trim_cut(&app, req).await
}

#[tauri::command]
async fn render_viral_shorts_916(
    app: AppHandle,
    req: ViralShortsRequest,
) -> Result<HardsubResult, String> {
    run_viral_shorts(&app, req).await
}

#[tauri::command]
async fn generate_local_thumbnail(
    video_path: String,
    project_id: String,
) -> Result<String, String> {
    run_local_thumb(&video_path, &project_id).await
}

// ---------------------------------------------------------------------------
// Auth & Google Loopback Browser Login Commands
// ---------------------------------------------------------------------------
#[tauri::command]
async fn api_login(api_base: String, email: String, password: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/login", api_base.trim_end_matches('/'));
    let res = client
        .post(&url)
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| format!("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_google_browser_login(app: AppHandle, api_base: String) -> Result<Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("เปิดพอร์ตเชื่อมต่อเบราว์เซอร์ไม่สำเร็จ: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1);
    let expected_state = format!("asb_{:x}_{:x}", nanos, std::process::id());
    let callback_url = format!("http://127.0.0.1:{}/callback", port);
    let login_url = format!(
        "{}/app?desktop_callback={}&desktop_state={}",
        api_base.trim_end_matches('/'),
        percent_encode(&callback_url),
        percent_encode(&expected_state)
    );

    open_in_system_browser(&login_url)?;

    let wait_result = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let (mut socket, _) = listener
                .accept()
                .await
                .map_err(|e| format!("รับข้อมูลล็อกอินไม่สำเร็จ: {}", e))?;

            let mut buf = [0u8; 8192];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                continue;
            }
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");
            let path = first_line.split_whitespace().nth(1).unwrap_or("");

            if !path.starts_with("/callback") {
                let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = socket.write_all(not_found.as_bytes()).await;
                continue;
            }

            let query = path.splitn(2, '?').nth(1).unwrap_or("");
            let got_state = parse_query_param(query, "state").unwrap_or_default();
            let got_token = parse_query_param(query, "token").unwrap_or_default();

            if got_state != expected_state || got_token.is_empty() {
                let err_html = "<!doctype html><html lang='th'><meta charset='utf-8'><body style='font-family:sans-serif;background:#070b14;color:#fecaca;display:grid;place-items:center;height:100vh;margin:0'><div><h2>ยืนยันตัวตนไม่ถูกต้อง</h2><p>กรุณากลับไปลองกดเข้าสู่ระบบในแอป AutoSubAI Desktop อีกครั้ง</p></div></body></html>";
                let resp = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    err_html.len(),
                    err_html
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                return Err("รหัสยืนยันความปลอดภัย (state) ไม่ตรงกัน กรุณาลองใหม่".to_string());
            }

            let ok_html = "<!doctype html><html lang='th'><meta charset='utf-8'><title>AutoSubAI Desktop Connected</title><body style='font-family:Segoe UI,sans-serif;background:#070b14;color:#f1f5f9;display:grid;place-items:center;height:100vh;margin:0'><div style='text-align:center;padding:32px;border-radius:16px;background:#11192d;border:1px solid #334155;max-width:440px'><div style='font-size:42px;margin-bottom:10px'>✅</div><h2 style='margin:0 0 8px'>เชื่อมต่อ AutoSubAI Desktop สำเร็จแล้ว!</h2><p style='color:#94a3b8;margin:0'>คุณสามารถปิดแท็บนี้แล้วกลับไปใช้งานแอป AutoSubAI Desktop ได้ทันที</p><script>setTimeout(()=>window.close(),2200);</script></div></body></html>";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                ok_html.len(),
                ok_html
            );
            let _ = socket.write_all(resp.as_bytes()).await;
            let _ = socket.flush().await;

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }

            return Ok(json!({ "access_token": got_token }));
        }
    })
    .await;

    match wait_result {
        Ok(res) => res,
        Err(_) => Err("หมดเวลารอการเข้าสู่ระบบด้วย Google (3 นาที) กรุณาลองใหม่อีกครั้ง".to_string()),
    }
}

#[tauri::command]
async fn api_get_profile(api_base: String, token: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/user/me", api_base.trim_end_matches('/'));
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("เชื่อมต่อไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("Token หรือ API Key ไม่ถูกต้อง");
        return Err(detail.to_string());
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Transcription, Workspace Projects & Studio Cloud APIs
// ---------------------------------------------------------------------------
#[tauri::command]
async fn upload_and_transcribe(
    file_path: String,
    display_filename: String,
    api_base: String,
    token: String,
    model: String,
    language: String,
) -> Result<Value, String> {
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("อ่านไฟล์ไม่สำเร็จ: {}", e))?;

    let ext = Path::new(&file_path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp3")
        .to_lowercase();

    let send_name = if display_filename.is_empty() {
        Path::new(&file_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("audio.mp3")
            .to_string()
    } else {
        let stem = Path::new(&display_filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");
        format!("{}.{}", stem, ext)
    };

    let part = multipart::Part::bytes(bytes).file_name(send_name);
    let form = multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("language", language)
        .text("response_format", "verbose_json")
        .text("async_mode", "true");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/v1/audio/transcriptions", api_base.trim_end_matches('/'));
    let res = client
        .post(&url)
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("อัปโหลดไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("เซิร์ฟเวอร์ปฏิเสธคำขอ");
        return Err(format!("HTTP {}: {}", status.as_u16(), detail));
    }
    Ok(body)
}

#[tauri::command]
async fn poll_job_status(api_base: String, token: String, job_id: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/v1/audio/transcriptions/{}",
        api_base.trim_end_matches('/'),
        job_id
    );
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("เช็กสถานะไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("ไม่สามารถอ่านสถานะงานได้");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_list_projects(
    api_base: String,
    token: String,
    search: String,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut url = format!("{}/v1/projects?limit=80", api_base.trim_end_matches('/'));
    let q = search.trim();
    if !q.is_empty() {
        url.push_str("&search=");
        url.push_str(&percent_encode(q));
    }

    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("โหลดรายการโปรเจกต์ไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("โหลดโปรเจกต์ไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_get_project_detail(
    api_base: String,
    token: String,
    project_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/v1/projects/{}",
        api_base.trim_end_matches('/'),
        project_id
    );
    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("โหลดข้อมูลโปรเจกต์ไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("ไม่พบโปรเจกต์นี้");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_save_job_segments(
    api_base: String,
    token: String,
    job_id: String,
    segments: Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/v1/jobs/{}/segments",
        api_base.trim_end_matches('/'),
        job_id
    );
    let res = client
        .put(&url)
        .bearer_auth(&token)
        .json(&json!({ "segments": segments }))
        .send()
        .await
        .map_err(|e| format!("บันทึกซับขึ้นคลาวด์ไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("บันทึกซับไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_delete_project(
    api_base: String,
    token: String,
    project_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/v1/projects/{}",
        api_base.trim_end_matches('/'),
        project_id
    );
    let res = client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("ลบโปรเจกต์ไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("ลบโปรเจกต์ไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_clear_project_media(
    api_base: String,
    token: String,
    project_id: String,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "{}/v1/projects/{}/media",
        api_base.trim_end_matches('/'),
        project_id
    );
    let res = client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("ล้างไฟล์สื่อไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("ล้างไฟล์สื่อไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

async fn translate_chunk_direct(
    client: &reqwest::Client,
    chunk_text: &str,
    src_lang: &str,
    tgt_lang: &str,
) -> Option<String> {
    let form_body = format!("q={}", percent_encode(chunk_text));

    // Tier 1: clients5.google.com Chrome Extension Translate endpoint (high reliability)
    let url1 = format!(
        "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl={}&tl={}",
        percent_encode(src_lang),
        percent_encode(tgt_lang)
    );
    if let Ok(resp) = client
        .post(&url1)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body.clone())
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<Value>().await {
                if let Some(arr) = data.as_array() {
                    if let Some(first) = arr.first() {
                        if let Some(inner) = first.as_array() {
                            if let Some(s) = inner.first().and_then(|v| v.as_str()) {
                                if !s.trim().is_empty() {
                                    return Some(s.to_string());
                                }
                            }
                        } else if let Some(s) = first.as_str() {
                            if !s.trim().is_empty() {
                                return Some(s.to_string());
                            }
                        }
                    }
                } else if let Some(sents) = data.get("sentences").and_then(|v| v.as_array()) {
                    let combined: String = sents
                        .iter()
                        .filter_map(|s| s.get("trans").and_then(|v| v.as_str()))
                        .collect();
                    if !combined.trim().is_empty() {
                        return Some(combined);
                    }
                }
            }
        }
    }

    // Tier 2: translate.googleapis.com POST gtx
    let url2 = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t",
        percent_encode(src_lang),
        percent_encode(tgt_lang)
    );
    if let Ok(resp) = client
        .post(&url2)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<Value>().await {
                if let Some(outer) = data.as_array().and_then(|a| a.first()).and_then(|v| v.as_array()) {
                    let combined: String = outer
                        .iter()
                        .filter_map(|item| item.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()))
                        .collect();
                    if !combined.trim().is_empty() {
                        return Some(combined);
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
async fn api_translate_text(
    api_base: String,
    token: String,
    text: String,
    target_language: String,
    source_language: String,
) -> Result<Value, String> {
    let tgt = target_language.trim().to_lowercase();
    let mut src = source_language.trim().to_lowercase();
    if src.is_empty() || src == tgt {
        src = "auto".to_string();
    }

    let raw_lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    let mut chunks: Vec<(Vec<usize>, Vec<String>)> = Vec::new();
    let mut cur_idx: Vec<usize> = Vec::new();
    let mut cur_lines: Vec<String> = Vec::new();
    let mut cur_chars: usize = 0;

    for (i, line) in raw_lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let char_len = trimmed.chars().count();
        if !cur_lines.is_empty() && (cur_chars + char_len + 1 > 1300 || cur_lines.len() >= 24) {
            chunks.push((cur_idx, cur_lines));
            cur_idx = Vec::new();
            cur_lines = Vec::new();
            cur_chars = 0;
        }
        cur_idx.push(i);
        cur_lines.push(trimmed.to_string());
        cur_chars += char_len + 1;
    }
    if !cur_lines.is_empty() {
        chunks.push((cur_idx, cur_lines));
    }

    if chunks.is_empty() {
        return Ok(json!({ "translated": text, "target_language": tgt, "source_language": src }));
    }

    let direct_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let mut out_lines = raw_lines.clone();
    let mut ok_chunks = 0usize;

    for (c_i, (indices, lines_batch)) in chunks.iter().enumerate() {
        let joined = lines_batch.join("\n");
        if let Some(translated_block) = translate_chunk_direct(&direct_client, &joined, &src, &tgt).await {
            ok_chunks += 1;
            let t_lines: Vec<&str> = translated_block.split('\n').collect();
            for (pos, &line_i) in indices.iter().enumerate() {
                if let Some(tl) = t_lines.get(pos) {
                    out_lines[line_i] = tl.trim().to_string();
                }
            }
        }
        if c_i + 1 < chunks.len() {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    if ok_chunks > 0 {
        return Ok(json!({
            "translated": out_lines.join("\n"),
            "target_language": tgt,
            "source_language": src,
            "provider": "desktop_direct_batch"
        }));
    }

    // Fallback to AutoSubAI Cloud API if direct local network is restricted
    let cloud_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/v1/audio/translate", api_base.trim_end_matches('/'));
    let res = cloud_client
        .post(&url)
        .bearer_auth(&token)
        .json(&json!({
            "text": text,
            "target_language": tgt,
            "source_language": src
        }))
        .send()
        .await
        .map_err(|e| format!("แปลภาษาไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("บริการแปลภาษาไม่พร้อมใช้งานชั่วคราว");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn api_summarize_transcript(
    api_base: String,
    token: String,
    job_id: Option<String>,
    text: Option<String>,
    language: String,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/v1/audio/summarize", api_base.trim_end_matches('/'));
    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&json!({
            "job_id": job_id,
            "text": text,
            "language": language
        }))
        .send()
        .await
        .map_err(|e| format!("สรุปใจความสำคัญไม่สำเร็จ: {}", e))?;

    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("สรุปใจความสำคัญไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn save_subtitle_next_to_source(
    video_path: String,
    srt_content: String,
    vtt_content: String,
    save_vtt: bool,
) -> Result<SaveSubResult, String> {
    let src = PathBuf::from(&video_path);
    let srt_path = src.with_extension("srt");
    tokio::fs::write(&srt_path, srt_content.as_bytes())
        .await
        .map_err(|e| format!("บันทึกไฟล์ .srt ไม่สำเร็จ: {}", e))?;

    let vtt_out = if save_vtt && !vtt_content.trim().is_empty() {
        let vp = src.with_extension("vtt");
        tokio::fs::write(&vp, vtt_content.as_bytes())
            .await
            .map_err(|e| format!("บันทึกไฟล์ .vtt ไม่สำเร็จ: {}", e))?;
        Some(vp.to_string_lossy().to_string())
    } else {
        None
    };

    Ok(SaveSubResult {
        srt_path: srt_path.to_string_lossy().to_string(),
        vtt_path: vtt_out,
    })
}

#[tauri::command]
fn reveal_in_folder(file_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new(&file_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or(".");
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_cloud_studio(url: String, token: Option<String>) -> Result<(), String> {
    let base = if url.starts_with("https://") {
        url
    } else {
        "https://www.thaiautosub.com/app".to_string()
    };
    let final_url = match token {
        Some(t) if !t.trim().is_empty() && !t.trim().starts_with("sk_") => {
            let sep = if base.contains('?') { '&' } else { '?' };
            format!("{}{}token={}", base, sep, percent_encode(t.trim()))
        }
        _ => base,
    };
    open_in_system_browser(&final_url)
}

// ---------------------------------------------------------------------------
// Built-in Smart Auto-Updater (GitHub Releases SemVer Check + 1-Click Install)
// ---------------------------------------------------------------------------
fn parse_semver_tuple(raw: &str) -> Option<(u32, u32, u32)> {
    let stripped = raw
        .trim()
        .trim_start_matches("desktop-v")
        .trim_start_matches('v');
    let core = stripped.split('-').next().unwrap_or(stripped);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

fn asset_matches_platform(name: &str) -> bool {
    let lower = name.to_lowercase();
    #[cfg(target_os = "windows")]
    {
        return lower.ends_with("_x64-setup.exe");
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return lower.ends_with("_aarch64.dmg") || lower.ends_with("_universal.dmg");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return lower.ends_with("_x64.dmg") || lower.ends_with("_universal.dmg");
    }
    #[cfg(target_os = "linux")]
    {
        return lower.ends_with(".appimage") || lower.ends_with("_amd64.deb");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = lower;
        false
    }
}

#[tauri::command]
async fn check_app_update() -> Result<Value, String> {
    let current_ver = env!("CARGO_PKG_VERSION");
    let current_tuple = parse_semver_tuple(current_ver).unwrap_or((0, 0, 0));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("AutoSubAI-Desktop-Updater")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get("https://api.github.com/repos/ratthanun-hue/AutoSubAI-Desktop/releases?per_page=10")
        .send()
        .await
        .map_err(|e| format!("ตรวจอัปเดตไม่สำเร็จ: {}", e))?;

    if !res.status().is_success() {
        return Ok(json!({
            "has_update": false,
            "current_version": current_ver
        }));
    }

    let releases: Vec<Value> = res.json().await.unwrap_or_default();
    let mut best: Option<((u32, u32, u32), Value)> = None;

    for rel in releases {
        let tag = rel.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
        if !tag.starts_with("desktop-v") {
            continue;
        }
        if let Some(ver) = parse_semver_tuple(tag) {
            if ver > current_tuple {
                if best.as_ref().map(|(bv, _)| ver > *bv).unwrap_or(true) {
                    best = Some((ver, rel));
                }
            }
        }
    }

    if let Some(((maj, min, pat), rel)) = best {
        let tag = rel.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
        let html_url = rel.get("html_url").and_then(|v| v.as_str()).unwrap_or("");
        let mut asset_name = String::new();
        let mut download_url = String::new();
        let mut size_bytes = 0u64;

        if let Some(assets) = rel.get("assets").and_then(|v| v.as_array()) {
            for a in assets {
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if asset_matches_platform(name) {
                    asset_name = name.to_string();
                    download_url = a
                        .get("browser_download_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    size_bytes = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    break;
                }
            }
        }

        return Ok(json!({
            "has_update": true,
            "current_version": current_ver,
            "latest_version": format!("{}.{}.{}", maj, min, pat),
            "tag_name": tag,
            "release_url": html_url,
            "asset_name": asset_name,
            "download_url": download_url,
            "size_bytes": size_bytes
        }));
    }

    Ok(json!({
        "has_update": false,
        "current_version": current_ver
    }))
}

#[tauri::command]
async fn download_and_launch_update(
    download_url: String,
    asset_name: String,
) -> Result<String, String> {
    if !download_url.starts_with("https://github.com/ratthanun-hue/AutoSubAI-Desktop/releases/download/") {
        return Err("ลิงก์อัปเดตไม่อยู่ในแหล่งดาวน์โหลดที่ได้รับอนุญาต".to_string());
    }

    let safe_name: String = asset_name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '.' | '_' | '-'))
        .collect();
    if safe_name.is_empty() {
        return Err("ชื่อไฟล์ตัวติดตั้งไม่ถูกต้อง".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("AutoSubAI-Desktop-Updater")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("ดาวน์โหลดตัวอัปเดตไม่สำเร็จ: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("ดาวน์โหลดไม่สำเร็จ (HTTP {})", res.status().as_u16()));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("อ่านไฟล์ตัวอัปเดตไม่สำเร็จ: {}", e))?;

    let mut dest = std::env::temp_dir();
    dest.push(&safe_name);
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("บันทึกตัวอัปเดตไม่สำเร็จ: {}", e))?;

    let dest_str = dest.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&dest)
            .spawn()
            .map_err(|e| format!("เปิดไฟล์ติดตั้งอัปเดตไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dest)
            .spawn()
            .map_err(|e| format!("เปิดไฟล์ .dmg ไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        if safe_name.to_lowercase().ends_with(".appimage") {
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            std::process::Command::new(&dest)
                .spawn()
                .map_err(|e| format!("เปิดไฟล์ .AppImage ไม่สำเร็จ: {}", e))?;
        } else {
            let parent = dest.parent().unwrap_or_else(|| Path::new("/tmp"));
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("เปิดโฟลเดอร์ไฟล์อัปเดตไม่สำเร็จ: {}", e))?;
        }
    }

    Ok(dest_str)
}

#[tauri::command]
async fn split_media_parts(
    app: tauri::AppHandle,
    req: ffmpeg_engine::SplitMediaRequest,
) -> Result<ffmpeg_engine::SplitMediaResult, String> {
    ffmpeg_engine::split_media_parts(&app, req).await
}

#[tauri::command]
async fn demux_extract_track(
    req: ffmpeg_engine::DemuxExtractRequest,
) -> Result<ffmpeg_engine::HardsubResult, String> {
    ffmpeg_engine::demux_extract_track(req).await
}

#[tauri::command]
async fn merge_media_clips(
    req: ffmpeg_engine::MergeMediaRequest,
) -> Result<ffmpeg_engine::MergeMediaResult, String> {
    ffmpeg_engine::merge_media_clips(req).await
}

#[tauri::command]
async fn export_viral_thumbnail(
    app: tauri::AppHandle,
    req: ffmpeg_engine::ThumbnailExportRequest,
) -> Result<ffmpeg_engine::HardsubResult, String> {
    ffmpeg_engine::export_viral_thumbnail(&app, req).await
}

#[tauri::command]
async fn save_voiceover_recording(
    project_id: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    if bytes.is_empty() {
        return Err("ไม่มีข้อมูลเสียงที่บันทึกได้".to_string());
    }
    let safe_proj: String = project_id
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '_' | '-'))
        .take(48)
        .collect();
    let folder_name = if safe_proj.is_empty() {
        "default".to_string()
    } else {
        safe_proj
    };

    let mut vo_dir = std::env::temp_dir();
    vo_dir.push("autosubai_voiceovers");
    vo_dir.push(&folder_name);
    tokio::fs::create_dir_all(&vo_dir)
        .await
        .map_err(|e| format!("สร้างโฟลเดอร์เก็บเสียงพากย์ไม่สำเร็จ: {}", e))?;

    let safe_stem: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '_' | '-'))
        .take(48)
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = if safe_stem.is_empty() {
        format!("vo_{}", ts)
    } else {
        format!("{}_{}", safe_stem, ts)
    };

    let raw_path = vo_dir.join(format!("{}_raw.webm", stem));
    let wav_path = vo_dir.join(format!("{}.wav", stem));

    tokio::fs::write(&raw_path, &bytes)
        .await
        .map_err(|e| format!("บันทึกไฟล์เสียงดิบไม่สำเร็จ: {}", e))?;

    // Convert to clean 48kHz stereo PCM WAV using Built-in FFmpeg for universal playback & sync
    let ffmpeg_info = check_ffmpeg_info().await;
    let final_path = if ffmpeg_info.available && !ffmpeg_info.path.is_empty() {
        let mut cmd = tokio::process::Command::new(&ffmpeg_info.path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let status = cmd
            .args([
                "-y",
                "-i",
                &raw_path.to_string_lossy(),
                "-ar",
                "48000",
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                &wav_path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;

        if matches!(status, Ok(s) if s.success()) && wav_path.is_file() {
            let _ = tokio::fs::remove_file(&raw_path).await;
            wav_path
        } else {
            raw_path
        }
    } else {
        raw_path
    };

    let final_str = final_path.to_string_lossy().to_string();
    let dur = probe_media(&final_str)
        .await
        .ok()
        .and_then(|m| m.duration_seconds)
        .unwrap_or(0.0);

    Ok(json!({
        "path": final_str,
        "duration": dur
    }))
}

#[tauri::command]
async fn api_submit_feedback(
    api_base: String,
    token: Option<String>,
    category: String,
    rating: i32,
    message: String,
    contact_email: Option<String>,
) -> Result<Value, String> {
    let base = api_base.trim_end_matches('/');
    let url = format!("{}/v1/feedback", base);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("AutoSubAI-Desktop")
        .build()
        .map_err(|e| e.to_string())?;

    let payload = json!({
        "category": category,
        "rating": rating.clamp(1, 5),
        "message": message,
        "contact_email": contact_email.unwrap_or_default(),
        "source": "desktop",
        "app_version": env!("CARGO_PKG_VERSION"),
        "os_info": format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
    });

    let mut req = client.post(&url).json(&payload);
    if let Some(t) = token {
        if !t.trim().is_empty() {
            req = req.bearer_auth(t.trim());
        }
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ส่งข้อเสนอแนะได้: {}", e))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("ส่งข้อเสนอแนะไม่สำเร็จ");
        return Err(detail.to_string());
    }
    Ok(body)
}

#[tauri::command]
async fn check_ui_patch_update(app: AppHandle) -> Result<Value, String> {
    patch_engine::check_ui_patch_update(&app).await
}

#[tauri::command]
async fn apply_ui_patch(
    app: AppHandle,
    manifest: patch_engine::PatchManifest,
) -> Result<Value, String> {
    patch_engine::apply_ui_patch(&app, manifest).await
}

#[tauri::command]
async fn get_active_ui_patch_bundle(app: AppHandle) -> Result<Value, String> {
    patch_engine::get_active_ui_patch_bundle(&app)
}

#[tauri::command]
async fn confirm_ui_patch_boot(app: AppHandle) -> Result<bool, String> {
    patch_engine::confirm_ui_patch_boot(&app)
}

#[tauri::command]
async fn rollback_ui_patch(app: AppHandle) -> Result<bool, String> {
    patch_engine::rollback_ui_patch(&app)
}

#[tauri::command]
async fn whisper_fetch_remote_config(
    app: AppHandle,
    api_base: String,
    token: Option<String>,
) -> Result<Value, String> {
    whisper_engine::fetch_remote_config(&app, &api_base, token).await
}

#[tauri::command]
async fn whisper_list_models(app: AppHandle) -> Result<whisper_engine::WhisperLocalStatus, String> {
    whisper_engine::list_local_models(&app).await
}

#[tauri::command]
async fn whisper_download_model(
    app: AppHandle,
    model_id: String,
    url: String,
    filename: String,
) -> Result<whisper_engine::WhisperDownloadedModel, String> {
    whisper_engine::download_model(&app, &model_id, &url, &filename).await
}

#[tauri::command]
fn whisper_delete_model(app: AppHandle, filename: String) -> Result<bool, String> {
    whisper_engine::delete_model(&app, &filename)
}

#[tauri::command]
async fn whisper_transcribe_local(
    app: AppHandle,
    media_path: String,
    model_filename: String,
    language: String,
    max_minutes: Option<u32>,
) -> Result<whisper_engine::WhisperTranscribeResult, String> {
    whisper_engine::transcribe_local_file(&app, &media_path, &model_filename, &language, max_minutes)
        .await
}

#[tauri::command]
async fn export_meeting_docx(req: docx_builder::MeetingDocxRequest) -> Result<String, String> {
    docx_builder::write_meeting_docx(&req).await
}

// ---------------------------------------------------------------------------
// Local-Only Confidential Meeting Project Workspace Storage (v1.9.0)
// All meeting minutes, speaker tags & transcripts are saved strictly on disk
// inside the user's local app_data_dir/meetings/ folder (0% cloud storage).
// ---------------------------------------------------------------------------
fn meetings_storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("ไม่สามารถเข้าถึงโฟลเดอร์ข้อมูลแอปได้: {}", e))?;
    let dir = base.join("meetings");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("ไม่สามารถสร้างโฟลเดอร์เก็บงานประชุมได้: {}", e))?;
    Ok(dir)
}

fn sanitize_meeting_id(id: &str) -> Result<String, String> {
    let clean = id.trim();
    if clean.is_empty()
        || clean.len() > 64
        || !clean
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("รหัสโปรเจกต์การประชุมไม่ถูกต้อง".to_string());
    }
    Ok(clean.to_string())
}

#[tauri::command]
async fn get_meetings_storage_dir(app: AppHandle) -> Result<String, String> {
    let dir = meetings_storage_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn list_meeting_projects(app: AppHandle) -> Result<Vec<Value>, String> {
    let dir = meetings_storage_dir(&app)?;
    let mut entries = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| format!("ไม่สามารถอ่านโฟลเดอร์งานประชุมได้: {}", e))?;
    let mut list: Vec<Value> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if val.is_object() {
                    list.push(val);
                }
            }
        }
    }
    list.sort_by(|a, b| {
        let ta = a.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        let tb = b.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(list)
}

#[tauri::command]
async fn save_meeting_project(
    app: AppHandle,
    id: String,
    payload_json: String,
) -> Result<String, String> {
    let safe_id = sanitize_meeting_id(&id)?;
    let parsed: Value = serde_json::from_str(&payload_json)
        .map_err(|e| format!("ข้อมูลโปรเจกต์ JSON ไม่ถูกต้อง: {}", e))?;
    let pretty = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("จัดรูปแบบ JSON ไม่สำเร็จ: {}", e))?;
    let dir = meetings_storage_dir(&app)?;
    let target = dir.join(format!("{}.json", safe_id));
    let tmp = dir.join(format!("{}.json.tmp", safe_id));
    tokio::fs::write(&tmp, pretty.as_bytes())
        .await
        .map_err(|e| format!("บันทึกไฟล์ชั่วคราวไม่สำเร็จ: {}", e))?;
    tokio::fs::rename(&tmp, &target)
        .await
        .map_err(|e| format!("บันทึกโปรเจกต์การประชุมไม่สำเร็จ: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_meeting_project(app: AppHandle, id: String) -> Result<bool, String> {
    let safe_id = sanitize_meeting_id(&id)?;
    let dir = meetings_storage_dir(&app)?;
    let target = dir.join(format!("{}.json", safe_id));
    if target.is_file() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|e| format!("ลบโปรเจกต์การประชุมไม่สำเร็จ: {}", e))?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
async fn open_meetings_folder(app: AppHandle) -> Result<String, String> {
    let dir = meetings_storage_dir(&app)?;
    let dir_str = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| format!("เปิดโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| format!("เปิดโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| format!("เปิดโฟลเดอร์ไม่สำเร็จ: {}", e))?;
    }
    Ok(dir_str)
}

#[tauri::command]
async fn generate_tts_voiceover(
    project_id: String,
    text: String,
    voice: String,
    rate_pct: i32,
    pitch_hz: i32,
    target_duration_sec: Option<f64>,
) -> Result<tts_engine::TtsResult, String> {
    tts_engine::synthesize_voiceover_wav(
        &project_id,
        &text,
        &voice,
        rate_pct,
        pitch_hz,
        target_duration_sec,
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            get_file_size,
            file_exists,
            probe_media_info,
            extract_audio_local,
            cleanup_temp_file,
            write_text_file,
            read_text_file,
            find_adjacent_subtitle,
            write_temp_srt,
            generate_ass_content,
            render_hardsub_local,
            render_studio_video,
            extract_audio_waveform,
            render_trimmed_cut_video,
            render_viral_shorts_916,
            generate_local_thumbnail,
            split_media_parts,
            demux_extract_track,
            merge_media_clips,
            export_viral_thumbnail,
            save_voiceover_recording,
            generate_tts_voiceover,
            export_meeting_docx,
            get_meetings_storage_dir,
            list_meeting_projects,
            save_meeting_project,
            delete_meeting_project,
            open_meetings_folder,
            api_submit_feedback,
            api_login,
            api_google_browser_login,
            api_get_profile,
            upload_and_transcribe,
            poll_job_status,
            api_list_projects,
            api_get_project_detail,
            api_save_job_segments,
            api_delete_project,
            api_clear_project_media,
            api_translate_text,
            api_summarize_transcript,
            save_subtitle_next_to_source,
            reveal_in_folder,
            open_cloud_studio,
            check_app_update,
            download_and_launch_update,
            check_ui_patch_update,
            apply_ui_patch,
            get_active_ui_patch_bundle,
            confirm_ui_patch_boot,
            rollback_ui_patch,
            whisper_fetch_remote_config,
            whisper_list_models,
            whisper_download_model,
            whisper_delete_model,
            whisper_transcribe_local,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AutoSubAI Desktop");
}
