use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::ffmpeg_engine;

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const SEC_MS_GEC_VERSION: &str = "1-130.0.2849.68";

#[derive(Debug, Clone, Serialize)]
pub struct TtsResult {
    pub path: String,
    pub duration: f64,
    pub engine: String,
}

fn generate_sec_ms_gec() -> String {
    let unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Windows epoch offset (1601-01-01 to 1970-01-01) = 11,644,473,600 seconds
    let mut ticks_secs: u128 = (unix_secs as u128) + 11_644_473_600u128;
    // Round down to nearest 5-minute window
    ticks_secs -= ticks_secs % 300;
    // Convert to 100-nanosecond intervals
    let ticks_100ns = ticks_secs * 10_000_000u128;
    let payload = format!("{}{}", ticks_100ns, TRUSTED_CLIENT_TOKEN);
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02X}", b)).collect()
}

fn generate_hex_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    digest[..16].iter().map(|b| format!("{:02x}", b)).collect()
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn format_rate(rate_pct: i32) -> String {
    let clamped = rate_pct.clamp(-50, 100);
    if clamped >= 0 {
        format!("+{}%", clamped)
    } else {
        format!("{}%", clamped)
    }
}

fn format_pitch(pitch_hz: i32) -> String {
    let clamped = pitch_hz.clamp(-30, 30);
    if clamped >= 0 {
        format!("+{}Hz", clamped)
    } else {
        format!("{}Hz", clamped)
    }
}

async fn synthesize_edge_neural_mp3(
    text: &str,
    voice: &str,
    rate_pct: i32,
    pitch_hz: i32,
) -> Result<Vec<u8>, String> {
    let conn_id = generate_hex_id();
    let req_id = generate_hex_id();
    let gec = generate_sec_ms_gec();

    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}&ConnectionId={}",
        TRUSTED_CLIENT_TOKEN, gec, SEC_MS_GEC_VERSION, conn_id
    );

    let mut req = url
        .into_client_request()
        .map_err(|e| format!("สร้างคำขอ TTS ไม่สำเร็จ: {}", e))?;
    let headers = req.headers_mut();
    headers.insert("Pragma", HeaderValue::from_static("no-cache"));
    headers.insert("Cache-Control", HeaderValue::from_static("no-cache"));
    headers.insert(
        "Origin",
        HeaderValue::from_static("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"),
    );
    headers.insert(
        "User-Agent",
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        ),
    );

    let (ws_stream, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .map_err(|_| "หมดเวลาเชื่อมต่อ Edge Neural Voice".to_string())?
    .map_err(|e| format!("เชื่อมต่อ Edge Neural Voice ไม่สำเร็จ: {}", e))?;

    let (mut write, mut read) = ws_stream.split();

    let config_msg = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    write
        .send(Message::Text(config_msg.to_string()))
        .await
        .map_err(|e| format!("ส่ง speech.config ไม่สำเร็จ: {}", e))?;

    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{}'><prosody pitch='{}' rate='{}' volume='+0%'>{}</prosody></voice></speak>",
        escape_xml(voice),
        format_pitch(pitch_hz),
        format_rate(rate_pct),
        escape_xml(text)
    );
    let ssml_msg = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n{}",
        req_id, ssml
    );
    write
        .send(Message::Text(ssml_msg))
        .await
        .map_err(|e| format!("ส่งข้อความ SSML ไม่สำเร็จ: {}", e))?;

    let mut mp3_bytes: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);

    while tokio::time::Instant::now() < deadline {
        let next_msg = tokio::time::timeout(Duration::from_secs(12), read.next()).await;
        match next_msg {
            Ok(Some(Ok(Message::Binary(data)))) => {
                if data.len() > 2 {
                    let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                    if data.len() > 2 + header_len {
                        let header = String::from_utf8_lossy(&data[2..2 + header_len]);
                        if header.contains("Path:audio") {
                            mp3_bytes.extend_from_slice(&data[2 + header_len..]);
                        }
                    }
                }
            }
            Ok(Some(Ok(Message::Text(txt)))) => {
                if txt.contains("Path:turn.end") {
                    break;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Err(e))) => return Err(format!("รับข้อมูลเสียงไม่สำเร็จ: {}", e)),
            Err(_) => return Err("หมดเวลารอไฟล์เสียงจาก Edge Neural Voice".to_string()),
            _ => {}
        }
    }

    let _ = write.close().await;
    if mp3_bytes.len() < 128 {
        return Err("ไม่ได้รับข้อมูลเสียงจาก Edge Neural Voice".to_string());
    }
    Ok(mp3_bytes)
}

async fn synthesize_os_fallback(text: &str, out_raw: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let safe_text = text.replace('\'', "''").replace('\r', " ").replace('\n', " ");
        let out_str = out_raw.to_string_lossy().replace('\'', "''");
        let ps_script = format!(
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('{}'); $s.Speak('{}'); $s.Dispose()",
            out_str, safe_text
        );
        let status = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .await
            .map_err(|e| format!("Windows TTS fallback ล้มเหลว: {}", e))?;
        if !status.success() {
            return Err("Windows TTS fallback ส่งคืนข้อผิดพลาด".to_string());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let status = tokio::process::Command::new("say")
            .args(["-o", &out_raw.to_string_lossy(), text])
            .status()
            .await
            .map_err(|e| format!("macOS say fallback ล้มเหลว: {}", e))?;
        if !status.success() {
            return Err("macOS say fallback ส่งคืนข้อผิดพลาด".to_string());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (text, out_raw);
        Err("ไม่รองรับ OS TTS fallback บนแพลตฟอร์มนี้".to_string())
    }
}

pub async fn synthesize_voiceover_wav(
    project_id: &str,
    text: &str,
    voice: &str,
    rate_pct: i32,
    pitch_hz: i32,
    target_duration_sec: Option<f64>,
) -> Result<TtsResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("กรุณาพิมพ์ข้อความที่ต้องการสร้างเสียงพากย์".to_string());
    }
    let safe_proj: String = project_id
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '_' | '-'))
        .collect();
    let proj_dir = std::env::temp_dir()
        .join("autosub_voiceovers")
        .join(if safe_proj.is_empty() {
            "local".to_string()
        } else {
            safe_proj
        });
    tokio::fs::create_dir_all(&proj_dir)
        .await
        .map_err(|e| format!("สร้างโฟลเดอร์เสียงพากย์ไม่สำเร็จ: {}", e))?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let chosen_voice = if voice.trim().is_empty() {
        "th-TH-PremwadeeNeural"
    } else {
        voice.trim()
    };

    let raw_path: PathBuf;
    let engine_used: String;

    match synthesize_edge_neural_mp3(trimmed, chosen_voice, rate_pct, pitch_hz).await {
        Ok(mp3_bytes) => {
            raw_path = proj_dir.join(format!("tts_{}_raw.mp3", ts));
            tokio::fs::write(&raw_path, &mp3_bytes)
                .await
                .map_err(|e| format!("เขียนไฟล์เสียงชั่วคราวไม่สำเร็จ: {}", e))?;
            engine_used = "edge-neural".to_string();
        }
        Err(_edge_err) => {
            #[cfg(target_os = "macos")]
            let ext = "aiff";
            #[cfg(not(target_os = "macos"))]
            let ext = "wav";
            raw_path = proj_dir.join(format!("tts_{}_raw.{}", ts, ext));
            synthesize_os_fallback(trimmed, &raw_path).await?;
            engine_used = "os-fallback".to_string();
        }
    }

    let final_wav = proj_dir.join(format!("tts_{}.wav", ts));
    let ffmpeg = ffmpeg_engine::check_ffmpeg_info().await;
    if !ffmpeg.available || ffmpeg.path.is_empty() {
        return Err("ไม่พบ FFmpeg สำหรับแปลงไฟล์เสียงพากย์".to_string());
    }

    // Check raw duration for optional Auto Time-Fit (Subtitle-to-Dubbing)
    let raw_str = raw_path.to_string_lossy().to_string();
    let raw_dur = ffmpeg_engine::probe_media(&raw_str)
        .await
        .ok()
        .and_then(|p| p.duration_seconds)
        .unwrap_or(0.0);

    let mut atempo_filter: Option<String> = None;
    if let Some(target_sec) = target_duration_sec {
        if target_sec > 0.35 && raw_dur > target_sec * 1.04 {
            let ratio = (raw_dur / target_sec).clamp(1.0, 1.55);
            atempo_filter = Some(format!("atempo={:.3}", ratio));
        }
    }

    let final_str = final_wav.to_string_lossy().to_string();
    let mut cmd = tokio::process::Command::new(&ffmpeg.path);
    cmd.args(["-y", "-i", &raw_str]);
    if let Some(ref af) = atempo_filter {
        cmd.args(["-af", af]);
    }
    cmd.args(["-vn", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", &final_str]);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let status = cmd
        .status()
        .await
        .map_err(|e| format!("รัน FFmpeg แปลงเสียงพากย์ไม่สำเร็จ: {}", e))?;
    let _ = tokio::fs::remove_file(&raw_path).await;

    if !status.success() || !final_wav.exists() {
        return Err("แปลงไฟล์เสียงพากย์ WAV 48kHz ไม่สำเร็จ".to_string());
    }

    let final_dur = ffmpeg_engine::probe_media(&final_str)
        .await
        .ok()
        .and_then(|p| p.duration_seconds)
        .unwrap_or(raw_dur.max(0.5));

    Ok(TtsResult {
        path: final_str,
        duration: (final_dur * 100.0).round() / 100.0,
        engine: engine_used,
    })
}
