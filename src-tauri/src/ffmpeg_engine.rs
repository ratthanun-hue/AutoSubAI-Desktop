use crate::ass_builder::{
    build_ass_document, build_ass_document_with_headline, build_srt_document, CueItem,
    SubtitleStyleConfig,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

#[derive(Serialize)]
pub struct FfmpegInfo {
    pub available: bool,
    pub bundled: bool,
    pub path: String,
    pub version: String,
}

#[derive(Serialize)]
pub struct MediaProbeInfo {
    pub size_bytes: u64,
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize)]
pub struct ExtractedAudio {
    pub audio_path: String,
    pub original_bytes: u64,
    pub extracted_bytes: u64,
}

#[derive(Serialize)]
pub struct HardsubResult {
    pub output_path: String,
    pub encoder_used: String,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DelogoConfig {
    pub enabled: bool,
    pub mode: String, // "blur" | "solid"
    pub y_pct: f64,
    pub height_pct: f64,
    pub blur_strength: u32,
    pub box_color: String,
    pub box_opacity: f64,
}

impl Default for DelogoConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "blur".to_string(),
            y_pct: 82.0,
            height_pct: 14.0,
            blur_strength: 12,
            box_color: "#000000".to_string(),
            box_opacity: 0.85,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct WatermarkConfig {
    pub enabled: bool,
    pub image_path: String,
    pub position: String, // "top-right" | "top-left" | "bottom-right" | "bottom-left"
    pub width_pct: f64,
    pub opacity: f64,
}

impl Default for WatermarkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            image_path: String::new(),
            position: "top-right".to_string(),
            width_pct: 12.0,
            opacity: 0.85,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct StudioRenderRequest {
    pub video_path: String,
    pub output_path: Option<String>,
    pub mode: String,       // "hardsub" | "softsub"
    pub resolution: String, // "original" | "1080p" | "720p" | "480p"
    pub cues: Vec<CueItem>,
    pub style: SubtitleStyleConfig,
    pub delogo: DelogoConfig,
    pub watermark: WatermarkConfig,
    pub intro_path: Option<String>,
    pub outro_path: Option<String>,
}

impl Default for StudioRenderRequest {
    fn default() -> Self {
        Self {
            video_path: String::new(),
            output_path: None,
            mode: "hardsub".to_string(),
            resolution: "original".to_string(),
            cues: Vec::new(),
            style: SubtitleStyleConfig::default(),
            delogo: DelogoConfig::default(),
            watermark: WatermarkConfig::default(),
            intro_path: None,
            outro_path: None,
        }
    }
}

fn find_bundled_ffmpeg() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    #[cfg(target_os = "windows")]
    let candidates = [
        dir.join("ffmpeg.exe"),
        dir.join("binaries")
            .join("ffmpeg-x86_64-pc-windows-msvc.exe"),
    ];

    #[cfg(not(target_os = "windows"))]
    let candidates = [
        dir.join("ffmpeg"),
        dir.join("binaries").join("ffmpeg-aarch64-apple-darwin"),
        dir.join("binaries").join("ffmpeg-x86_64-apple-darwin"),
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

fn probe_ffmpeg_executable(bin: &str) -> bool {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn resolve_ffmpeg_binary() -> Option<(String, bool)> {
    if let Some(bundled) = find_bundled_ffmpeg() {
        if probe_ffmpeg_executable(&bundled) {
            return Some((bundled, true));
        }
    }

    let mut candidates: Vec<String> = vec!["ffmpeg".to_string()];
    #[cfg(target_os = "macos")]
    {
        candidates.push("/opt/homebrew/bin/ffmpeg".to_string());
        candidates.push("/usr/local/bin/ffmpeg".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        candidates.push("ffmpeg.exe".to_string());
        candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe".to_string());
    }

    for cand in candidates {
        if probe_ffmpeg_executable(&cand) {
            return Some((cand, false));
        }
    }
    None
}

pub fn parse_ffmpeg_duration_secs(stderr: &str) -> Option<f64> {
    let idx = stderr.find("Duration: ")?;
    let rest = &stderr[idx + 10..];
    let token = rest.split(',').next()?.trim();
    if token.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].trim().parse().ok()?;
    let mins: f64 = parts[1].trim().parse().ok()?;
    let secs: f64 = parts[2].trim().parse().ok()?;
    let total = hours * 3600.0 + mins * 60.0 + secs;
    if total > 0.0 {
        Some(total)
    } else {
        None
    }
}

pub fn parse_video_dimensions(stderr: &str) -> Option<(u32, u32)> {
    for line in stderr.lines() {
        if !line.contains("Video:") {
            continue;
        }
        for tok in line.split(|c: char| c == ',' || c.is_whitespace()) {
            let clean = tok.trim();
            if let Some(x_idx) = clean.find('x') {
                let (w_s, h_s) = clean.split_at(x_idx);
                let h_s = &h_s[1..];
                if let (Ok(w), Ok(h)) = (w_s.parse::<u32>(), h_s.parse::<u32>()) {
                    if (160..=7680).contains(&w) && (120..=4320).contains(&h) {
                        return Some((w, h));
                    }
                }
            }
        }
    }
    None
}

pub fn escape_ffmpeg_filter_path(p: &str) -> String {
    let clean = p.strip_prefix("\\\\?\\").unwrap_or(p);
    clean
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

pub fn find_bundled_fonts_dir(app: &AppHandle) -> Option<String> {
    let res_dir = app.path().resource_dir().ok()?;
    let candidates = [
        res_dir.join("resources").join("fonts"),
        res_dir.join("fonts"),
    ];
    for c in candidates {
        if c.is_dir() {
            if let Some(s) = c.to_str() {
                let clean = s.strip_prefix("\\\\?\\").unwrap_or(s);
                return Some(clean.to_string());
            }
        }
    }
    None
}

pub async fn check_ffmpeg_info() -> FfmpegInfo {
    if let Some((bin, bundled)) = resolve_ffmpeg_binary() {
        let mut cmd = Command::new(&bin);
        cmd.arg("-version");
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        let ver = match cmd.output().await {
            Ok(out) => String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .unwrap_or("ffmpeg ready")
                .to_string(),
            Err(_) => "ffmpeg ready".to_string(),
        };
        FfmpegInfo {
            available: true,
            bundled,
            path: bin,
            version: ver,
        }
    } else {
        FfmpegInfo {
            available: false,
            bundled: false,
            path: String::new(),
            version: "ไม่พบ FFmpeg ในเครื่อง (สามารถอัปโหลดไฟล์ตรงได้ทันที)".to_string(),
        }
    }
}

pub async fn probe_media(file_path: &str) -> Result<MediaProbeInfo, String> {
    let meta = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("อ่านข้อมูลไฟล์ไม่สำเร็จ: {}", e))?;
    let size_bytes = meta.len();

    let mut duration_seconds = None;
    let mut width = None;
    let mut height = None;

    if let Some((ffmpeg, _)) = resolve_ffmpeg_binary() {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-hide_banner", "-i", file_path]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        if let Ok(out) = cmd.output().await {
            let stderr = String::from_utf8_lossy(&out.stderr);
            duration_seconds = parse_ffmpeg_duration_secs(&stderr);
            if let Some((w, h)) = parse_video_dimensions(&stderr) {
                width = Some(w);
                height = Some(h);
            }
        }
    }

    Ok(MediaProbeInfo {
        size_bytes,
        duration_seconds,
        width,
        height,
    })
}

pub async fn extract_audio_mp3(video_path: &str) -> Result<ExtractedAudio, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg บนเครื่องนี้ (ปิดตัวเลือกแยกเสียงบนเครื่องเพื่อส่งไฟล์ตรง)".to_string())?;

    let src = PathBuf::from(video_path);
    let orig_meta = tokio::fs::metadata(&src)
        .await
        .map_err(|e| format!("ไม่พบไฟล์ต้นฉบับ: {}", e))?;
    let original_bytes = orig_meta.len();

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect::<String>();

    let mut out_path = std::env::temp_dir();
    out_path.push(format!("autosub_{}_{}.mp3", stem, ts));

    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-y",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        out_path.to_str().ok_or("Invalid temp path")?,
    ]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("รัน FFmpeg แยกเสียงไม่สำเร็จ: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "FFmpeg แยกเสียงผิดพลาด: {}",
            stderr
                .chars()
                .rev()
                .take(260)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }

    let ext_meta = tokio::fs::metadata(&out_path)
        .await
        .map_err(|e| format!("ไม่พบไฟล์เสียงที่แยกออกมา: {}", e))?;

    Ok(ExtractedAudio {
        audio_path: out_path.to_string_lossy().to_string(),
        original_bytes,
        extracted_bytes: ext_meta.len(),
    })
}

pub async fn render_simple_hardsub(
    app: &AppHandle,
    video_path: &str,
    srt_path: &str,
) -> Result<HardsubResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง กรุณาติดตั้ง FFmpeg ก่อนใช้งานฝังซับบนเครื่อง".to_string())?;

    let src = PathBuf::from(video_path);
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let out_path = parent.join(format!("{}_hardsub.mp4", stem));
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    let escaped_srt = escape_ffmpeg_filter_path(srt_path);
    let vf = if let Some(fonts_dir) = find_bundled_fonts_dir(app) {
        let escaped_fonts = escape_ffmpeg_filter_path(&fonts_dir);
        format!(
            "subtitles='{}':fontsdir='{}':force_style='FontName=Prompt,Bold=1,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=2,MarginV=28'",
            escaped_srt, escaped_fonts
        )
    } else {
        format!(
            "subtitles='{}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=3,Outline=2,MarginV=28'",
            escaped_srt
        )
    };

    run_h264_encode_with_fallback(&ffmpeg, video_path, None, &vf, None, out_str, "hardsub").await
}

pub async fn render_studio_video(
    app: &AppHandle,
    req: StudioRenderRequest,
) -> Result<HardsubResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;

    let src = PathBuf::from(&req.video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอต้นฉบับบนเครื่อง กรุณาเลือกไฟล์ใหม่อีกครั้ง".to_string());
    }

    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let mode_lower = req.mode.trim().to_lowercase();
    let is_softsub = mode_lower == "softsub";

    let out_path = match req.output_path {
        Some(ref custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => {
            let suffix = if is_softsub { "softsub" } else { "studio_hardsub" };
            parent.join(format!("{}_{}.mp4", stem, suffix))
        }
    };
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // Softsub Mode: instant stream-copy mov_text mux (1-2 seconds!)
    if is_softsub {
        let srt_content = build_srt_document(&req.cues, req.style.bilingual_enabled);
        let mut temp_srt = std::env::temp_dir();
        temp_srt.push(format!("autosub_soft_{}.srt", ts));
        tokio::fs::write(&temp_srt, srt_content.as_bytes())
            .await
            .map_err(|e| format!("สร้างไฟล์ซับชั่วคราวไม่สำเร็จ: {}", e))?;

        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-y",
            "-i",
            &req.video_path,
            "-i",
            temp_srt.to_str().ok_or("Invalid temp srt path")?,
            "-map",
            "0:v",
            "-map",
            "0:a?",
            "-map",
            "1:0",
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-c:s",
            "mov_text",
            "-metadata:s:s:0",
            "language=tha",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("รัน FFmpeg Softsub ไม่สำเร็จ: {}", e))?;
        let _ = tokio::fs::remove_file(&temp_srt).await;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "สร้าง Softsub MP4 ไม่สำเร็จ: {}",
                stderr
                    .chars()
                    .rev()
                    .take(260)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ));
        }

        return Ok(HardsubResult {
            output_path: out_path.to_string_lossy().to_string(),
            encoder_used: "stream-copy (mov_text)".to_string(),
            mode: "softsub".to_string(),
        });
    }

    // Hardsub WYSIWYG Mode: Probe resolution -> Scale -> Delogo Blur/Box -> ASS Style -> Watermark PNG
    let probe = probe_media(&req.video_path).await?;
    let mut cur_w = probe.width.unwrap_or(1280);
    let mut cur_h = probe.height.unwrap_or(720);

    let mut chains: Vec<String> = Vec::new();
    let mut cur_label = "[0:v]".to_string();

    // 1. Optional target resolution scaling
    let target_h: Option<u32> = match req.resolution.trim().to_lowercase().as_str() {
        "1080p" => Some(1080),
        "720p" => Some(720),
        "480p" => Some(480),
        _ => None,
    };
    if let Some(th) = target_h {
        if th < cur_h {
            let scaled_w = (((cur_w as f64) * (th as f64) / (cur_h as f64)).round() as u32) & !1;
            let scaled_h = th & !1;
            if scaled_w >= 160 && scaled_h >= 120 {
                chains.push(format!("{}scale={}:{}[v_sc]", cur_label, scaled_w, scaled_h));
                cur_label = "[v_sc]".to_string();
                cur_w = scaled_w;
                cur_h = scaled_h;
            }
        }
    }

    // 2. Optional Delogo / Cover Bar (blur or solid box over original hardcoded subs)
    if req.delogo.enabled {
        let by = (((cur_h as f64) * req.delogo.y_pct.clamp(0.0, 94.0) / 100.0).round() as u32) & !1;
        let mut bh = (((cur_h as f64) * req.delogo.height_pct.clamp(3.0, 45.0) / 100.0).round() as u32).max(16) & !1;
        if by + bh > cur_h {
            bh = cur_h.saturating_sub(by) & !1;
        }
        if bh >= 16 && by + bh <= cur_h {
            if req.delogo.mode.trim().eq_ignore_ascii_case("solid") {
                let raw_hex = req.delogo.box_color.trim().trim_start_matches('#');
                let clean_hex = if raw_hex.len() == 6 && raw_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    raw_hex
                } else {
                    "000000"
                };
                let op = req.delogo.box_opacity.clamp(0.1, 1.0);
                chains.push(format!(
                    "{}drawbox=x=0:y={}:w={}:h={}:color=0x{}@{:.2}:t=fill[v_dl]",
                    cur_label, by, cur_w, bh, clean_hex, op
                ));
            } else {
                let max_r = (bh / 4).max(2);
                let radius = req.delogo.blur_strength.clamp(3, 24).min(max_r);
                chains.push(format!(
                    "{}split=2[v_dl_base][v_dl_src];[v_dl_src]crop={}:{}:0:{},boxblur=luma_radius={}:luma_power=2[v_dl_blur];[v_dl_base][v_dl_blur]overlay=0:{}[v_dl]",
                    cur_label, cur_w, bh, by, radius, by
                ));
            }
            cur_label = "[v_dl]".to_string();
        }
    }

    // 3. WYSIWYG .ASS Subtitle Burn-in (PlayRes matches exact output cur_w x cur_h)
    let ass_doc = build_ass_document(&req.cues, &req.style, cur_w, cur_h);
    let mut temp_ass = std::env::temp_dir();
    temp_ass.push(format!("autosub_wysiwyg_{}.ass", ts));
    tokio::fs::write(&temp_ass, ass_doc.as_bytes())
        .await
        .map_err(|e| format!("สร้างไฟล์ .ass ไม่สำเร็จ: {}", e))?;

    let escaped_ass = escape_ffmpeg_filter_path(temp_ass.to_str().ok_or("Invalid temp ass path")?);
    if let Some(fonts_dir) = find_bundled_fonts_dir(app) {
        let escaped_fonts = escape_ffmpeg_filter_path(&fonts_dir);
        chains.push(format!(
            "{}ass='{}':fontsdir='{}'[v_sub]",
            cur_label, escaped_ass, escaped_fonts
        ));
    } else {
        chains.push(format!("{}ass='{}'[v_sub]", cur_label, escaped_ass));
    }
    cur_label = "[v_sub]".to_string();

    // 4. Optional Channel Watermark PNG Overlay
    let wm_path_opt = if req.watermark.enabled
        && !req.watermark.image_path.trim().is_empty()
        && Path::new(req.watermark.image_path.trim()).is_file()
    {
        let wm_w = (((cur_w as f64) * req.watermark.width_pct.clamp(4.0, 35.0) / 100.0).round() as u32)
            .max(32)
            & !1;
        let wm_op = req.watermark.opacity.clamp(0.1, 1.0);
        let margin = ((cur_w as f64) * 0.025).round() as u32;
        let coords = match req.watermark.position.trim().to_lowercase().as_str() {
            "top-left" => format!("{}:{}", margin, margin),
            "bottom-left" => format!("{}:H-h-{}", margin, margin),
            "bottom-right" => format!("W-w-{}:H-h-{}", margin, margin),
            _ => format!("W-w-{}:{}", margin, margin),
        };
        chains.push(format!(
            "[1:v]format=rgba,scale={}:-1,colorchannelmixer=aa={:.2}[wm_img];{}[wm_img]overlay={}[v_wm]",
            wm_w, wm_op, cur_label, coords
        ));
        cur_label = "[v_wm]".to_string();
        Some(req.watermark.image_path.trim().to_string())
    } else {
        None
    };

    let filter_complex = chains.join(";");
    let has_intro = req
        .intro_path
        .as_deref()
        .map(|p| !p.trim().is_empty() && Path::new(p.trim()).is_file())
        .unwrap_or(false);
    let has_outro = req
        .outro_path
        .as_deref()
        .map(|p| !p.trim().is_empty() && Path::new(p.trim()).is_file())
        .unwrap_or(false);

    if !has_intro && !has_outro {
        let res = run_h264_encode_with_fallback(
            &ffmpeg,
            &req.video_path,
            wm_path_opt.as_deref(),
            &filter_complex,
            Some(&cur_label),
            out_str,
            "hardsub",
        )
        .await;
        let _ = tokio::fs::remove_file(&temp_ass).await;
        return res;
    }

    // Channel Intro / Outro Stitch Mode:
    // 1) Render Main Episode with Delogo + WYSIWYG Subtitles + Watermark to temp file
    // 2) Stitch normalized Intro + Main + Outro cleanly (zero subtitle bleed onto Intro/Outro!)
    let mut temp_main = std::env::temp_dir();
    temp_main.push(format!("autosub_main_stitch_{}.mp4", ts));
    let temp_main_str = temp_main.to_str().ok_or("Invalid temp main path")?;

    let main_res = run_h264_encode_with_fallback(
        &ffmpeg,
        &req.video_path,
        wm_path_opt.as_deref(),
        &filter_complex,
        Some(&cur_label),
        temp_main_str,
        "hardsub",
    )
    .await;
    let _ = tokio::fs::remove_file(&temp_ass).await;
    let main_ok = main_res?;

    let mut stitch_inputs: Vec<String> = Vec::new();
    if has_intro {
        stitch_inputs.push(req.intro_path.as_deref().unwrap().trim().to_string());
    }
    stitch_inputs.push(temp_main_str.to_string());
    if has_outro {
        stitch_inputs.push(req.outro_path.as_deref().unwrap().trim().to_string());
    }

    let stitch_res = stitch_video_segments(&ffmpeg, &stitch_inputs, cur_w, cur_h, out_str, &main_ok.encoder_used).await;
    let _ = tokio::fs::remove_file(&temp_main).await;
    stitch_res
}

async fn stitch_video_segments(
    ffmpeg: &str,
    inputs: &[String],
    target_w: u32,
    target_h: u32,
    out_str: &str,
    preferred_enc: &str,
) -> Result<HardsubResult, String> {
    let mut chains: Vec<String> = Vec::new();
    let mut concat_refs = String::new();
    for (i, inp) in inputs.iter().enumerate() {
        let has_aud = media_has_audio(ffmpeg, inp).await;
        chains.push(format!(
            "[{}:v]scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[sv{}]",
            i, target_w, target_h, target_w, target_h, i
        ));
        if has_aud {
            chains.push(format!(
                "[{}:a]aresample=48000,aformat=channel_layouts=stereo[sa{}]",
                i, i
            ));
        } else {
            let p = probe_media(inp).await.ok();
            let d = p.and_then(|x| x.duration_seconds).unwrap_or(3.0).max(0.5);
            chains.push(format!(
                "anullsrc=r=48000:cl=stereo:d={:.3}[sa{}]",
                d, i
            ));
        }
        concat_refs.push_str(&format!("[sv{}][sa{}]", i, i));
    }
    chains.push(format!(
        "{}concat=n={}:v=1:a=1[v_st][a_st]",
        concat_refs,
        inputs.len()
    ));
    let fc = chains.join(";");

    let mut enc_list: Vec<(&str, Vec<&str>)> = Vec::new();
    if preferred_enc == "h264_videotoolbox" {
        enc_list.push(("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "5M"]));
    } else if preferred_enc == "h264_nvenc" {
        enc_list.push(("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]));
    }
    enc_list.push(("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]));

    let mut last_err = String::new();
    for (enc_name, enc_args) in enc_list {
        let mut cmd = Command::new(ffmpeg);
        cmd.arg("-y");
        for inp in inputs {
            cmd.args(["-i", inp]);
        }
        cmd.args(["-filter_complex", &fc, "-map", "[v_st]", "-map", "[a_st]"]);
        cmd.args(&enc_args);
        cmd.args([
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                return Ok(HardsubResult {
                    output_path: out_str.to_string(),
                    encoder_used: format!("{}+stitch", enc_name),
                    mode: "hardsub_stitch".to_string(),
                });
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                last_err = stderr
                    .chars()
                    .rev()
                    .take(280)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    Err(format!("ต่อคลิป Intro/Outro ไม่สำเร็จ: {}", last_err))
}

async fn run_h264_encode_with_fallback(
    ffmpeg: &str,
    video_path: &str,
    extra_input: Option<&str>,
    filter_expr: &str,
    map_video_label: Option<&str>,
    out_str: &str,
    mode_label: &str,
) -> Result<HardsubResult, String> {
    #[cfg(target_os = "macos")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "5M"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];

    #[cfg(target_os = "windows")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];

    let mut last_err = String::new();
    for (enc_name, enc_args) in encoders {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-y", "-i", video_path]);
        if let Some(wm) = extra_input {
            cmd.args(["-i", wm]);
        }
        if let Some(v_map) = map_video_label {
            cmd.args(["-filter_complex", filter_expr, "-map", v_map, "-map", "0:a?"]);
        } else {
            cmd.args(["-vf", filter_expr]);
        }
        cmd.args(&enc_args);
        cmd.args([
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        match cmd.output().await {
            Ok(output) if output.status.success() => {
                return Ok(HardsubResult {
                    output_path: out_str.to_string(),
                    encoder_used: enc_name.to_string(),
                    mode: mode_label.to_string(),
                });
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = stderr
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    Err(format!("เรนเดอร์วิดีโอไม่สำเร็จ: {}", last_err))
}

// ---------------------------------------------------------------------------
// Milestone 2 (v0.5.0): Audio Waveform, Trim/Multi-Cut + Ripple Sync & 9:16 Viral Shorts
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Deserialize)]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct TrimCutRequest {
    pub video_path: String,
    pub keep_ranges: Vec<TimeRange>,
    pub burn_subtitles: bool,
    pub cues: Vec<CueItem>,
    pub style: SubtitleStyleConfig,
    pub delogo: DelogoConfig,
    pub watermark: WatermarkConfig,
}

impl Default for TrimCutRequest {
    fn default() -> Self {
        Self {
            video_path: String::new(),
            keep_ranges: Vec::new(),
            burn_subtitles: true,
            cues: Vec::new(),
            style: SubtitleStyleConfig::default(),
            delogo: DelogoConfig::default(),
            watermark: WatermarkConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ViralShortsRequest {
    pub video_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub bg_mode: String, // "blur" | "crop_fill" | "solid"
    pub headline: String,
    pub headline_color: String,
    pub cues: Vec<CueItem>,
    pub style: SubtitleStyleConfig,
    pub watermark: WatermarkConfig,
}

impl Default for ViralShortsRequest {
    fn default() -> Self {
        Self {
            video_path: String::new(),
            start_sec: 0.0,
            end_sec: 60.0,
            bg_mode: "blur".to_string(),
            headline: String::new(),
            headline_color: "#fde047".to_string(),
            cues: Vec::new(),
            style: SubtitleStyleConfig::default(),
            watermark: WatermarkConfig::default(),
        }
    }
}

async fn media_has_audio(ffmpeg: &str, video_path: &str) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-i", video_path]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    match cmd.output().await {
        Ok(out) => String::from_utf8_lossy(&out.stderr).contains("Audio:"),
        Err(_) => true,
    }
}

pub async fn extract_audio_waveform(video_path: &str, num_bins: u32) -> Result<Vec<f32>, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;
    let bins = num_bins.clamp(64, 2000) as usize;

    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-v",
        "error",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "2000",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("อ่านคลื่นเสียงไม่สำเร็จ: {}", e))?;

    let raw = &output.stdout;
    let total_samples = raw.len() / 2;
    if total_samples == 0 {
        return Ok(vec![0.05; bins]);
    }

    let samples_per_bin = (total_samples as f64) / (bins as f64);
    let mut peaks = vec![0.0f32; bins];
    let mut max_peak = 0.001f32;

    for b in 0..bins {
        let s0 = ((b as f64) * samples_per_bin) as usize;
        let s1 = ((((b + 1) as f64) * samples_per_bin) as usize)
            .max(s0 + 1)
            .min(total_samples);
        let mut p = 0.0f32;
        for idx in s0..s1 {
            let off = idx * 2;
            let sample = i16::from_le_bytes([raw[off], raw[off + 1]]);
            let mag = (sample as i32).abs() as f32 / 32768.0;
            if mag > p {
                p = mag;
            }
        }
        peaks[b] = p;
        if p > max_peak {
            max_peak = p;
        }
    }

    for v in &mut peaks {
        *v = (*v / max_peak).clamp(0.03, 1.0);
    }
    Ok(peaks)
}

pub async fn render_trimmed_cut_video(
    app: &AppHandle,
    req: TrimCutRequest,
) -> Result<HardsubResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;
    let src = PathBuf::from(&req.video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอต้นฉบับบนเครื่อง".to_string());
    }
    if req.keep_ranges.is_empty() {
        return Err("ต้องมีช่วงวิดีโอที่เก็บไว้อย่างน้อย 1 ช่วง".to_string());
    }

    let probe = probe_media(&req.video_path).await?;
    let cur_w = probe.width.unwrap_or(1280);
    let cur_h = probe.height.unwrap_or(720);
    let has_audio = media_has_audio(&ffmpeg, &req.video_path).await;

    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_path = parent.join(format!("{}_cut_{}.mp4", stem, ts % 10000));
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    let mut chains: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    for (i, r) in req.keep_ranges.iter().enumerate() {
        let s = r.start.max(0.0);
        let e = r.end.max(s + 0.1);
        chains.push(format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[vt{}]",
            s, e, i
        ));
        if has_audio {
            chains.push(format!(
                "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS[at{}]",
                s, e, i
            ));
            concat_inputs.push_str(&format!("[vt{}][at{}]", i, i));
        } else {
            concat_inputs.push_str(&format!("[vt{}]", i));
        }
    }

    let (mut v_label, a_label) = if req.keep_ranges.len() > 1 {
        if has_audio {
            chains.push(format!(
                "{}concat=n={}:v=1:a=1[v_cat][a_cat]",
                concat_inputs,
                req.keep_ranges.len()
            ));
            ("[v_cat]".to_string(), Some("[a_cat]".to_string()))
        } else {
            chains.push(format!(
                "{}concat=n={}:v=1:a=0[v_cat]",
                concat_inputs,
                req.keep_ranges.len()
            ));
            ("[v_cat]".to_string(), None)
        }
    } else if has_audio {
        ("[vt0]".to_string(), Some("[at0]".to_string()))
    } else {
        ("[vt0]".to_string(), None)
    };

    let mut temp_ass_opt: Option<PathBuf> = None;

    // Optional Delogo + WYSIWYG Subtitles + Watermark
    if req.delogo.enabled {
        let by = (((cur_h as f64) * req.delogo.y_pct.clamp(0.0, 94.0) / 100.0).round() as u32) & !1;
        let mut bh = (((cur_h as f64) * req.delogo.height_pct.clamp(3.0, 45.0) / 100.0).round() as u32).max(16) & !1;
        if by + bh > cur_h {
            bh = cur_h.saturating_sub(by) & !1;
        }
        if bh >= 16 && by + bh <= cur_h {
            if req.delogo.mode.trim().eq_ignore_ascii_case("solid") {
                let raw_hex = req.delogo.box_color.trim().trim_start_matches('#');
                let clean_hex = if raw_hex.len() == 6 && raw_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    raw_hex
                } else {
                    "000000"
                };
                chains.push(format!(
                    "{}drawbox=x=0:y={}:w={}:h={}:color=0x{}@{:.2}:t=fill[v_dl]",
                    v_label, by, cur_w, bh, clean_hex, req.delogo.box_opacity.clamp(0.1, 1.0)
                ));
            } else {
                let radius = req.delogo.blur_strength.clamp(3, 24).min((bh / 4).max(2));
                chains.push(format!(
                    "{}split=2[v_dl_b][v_dl_s];[v_dl_s]crop={}:{}:0:{},boxblur=luma_radius={}:luma_power=2[v_dl_x];[v_dl_b][v_dl_x]overlay=0:{}[v_dl]",
                    v_label, cur_w, bh, by, radius, by
                ));
            }
            v_label = "[v_dl]".to_string();
        }
    }

    if req.burn_subtitles && !req.cues.is_empty() {
        let ass_doc = build_ass_document(&req.cues, &req.style, cur_w, cur_h);
        let mut temp_ass = std::env::temp_dir();
        temp_ass.push(format!("autosub_cut_{}.ass", ts));
        tokio::fs::write(&temp_ass, ass_doc.as_bytes())
            .await
            .map_err(|e| format!("สร้างไฟล์ .ass ไม่สำเร็จ: {}", e))?;
        let escaped_ass = escape_ffmpeg_filter_path(temp_ass.to_str().ok_or("Invalid ass path")?);
        if let Some(fonts_dir) = find_bundled_fonts_dir(app) {
            chains.push(format!(
                "{}ass='{}':fontsdir='{}'[v_sub]",
                v_label,
                escaped_ass,
                escape_ffmpeg_filter_path(&fonts_dir)
            ));
        } else {
            chains.push(format!("{}ass='{}'[v_sub]", v_label, escaped_ass));
        }
        v_label = "[v_sub]".to_string();
        temp_ass_opt = Some(temp_ass);
    }

    let wm_path_opt = if req.watermark.enabled
        && !req.watermark.image_path.trim().is_empty()
        && Path::new(req.watermark.image_path.trim()).is_file()
    {
        let wm_w = (((cur_w as f64) * req.watermark.width_pct.clamp(4.0, 35.0) / 100.0).round() as u32)
            .max(32)
            & !1;
        let margin = ((cur_w as f64) * 0.025).round() as u32;
        let coords = match req.watermark.position.trim().to_lowercase().as_str() {
            "top-left" => format!("{}:{}", margin, margin),
            "bottom-left" => format!("{}:H-h-{}", margin, margin),
            "bottom-right" => format!("W-w-{}:H-h-{}", margin, margin),
            _ => format!("W-w-{}:{}", margin, margin),
        };
        chains.push(format!(
            "[1:v]format=rgba,scale={}:-1,colorchannelmixer=aa={:.2}[wm_img];{}[wm_img]overlay={}[v_wm]",
            wm_w,
            req.watermark.opacity.clamp(0.1, 1.0),
            v_label,
            coords
        ));
        v_label = "[v_wm]".to_string();
        Some(req.watermark.image_path.trim().to_string())
    } else {
        None
    };

    let filter_complex = chains.join(";");

    #[cfg(target_os = "macos")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "5M"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];
    #[cfg(target_os = "windows")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]),
    ];

    let mut last_err = String::new();
    let mut final_res: Option<HardsubResult> = None;

    for (enc_name, enc_args) in encoders {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-y", "-i", &req.video_path]);
        if let Some(ref wm) = wm_path_opt {
            cmd.args(["-i", wm]);
        }
        cmd.args(["-filter_complex", &filter_complex, "-map", &v_label]);
        if let Some(ref a_lbl) = a_label {
            cmd.args(["-map", a_lbl]);
        }
        cmd.args(&enc_args);
        cmd.args([
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        match cmd.output().await {
            Ok(out) if out.status.success() => {
                final_res = Some(HardsubResult {
                    output_path: out_str.to_string(),
                    encoder_used: enc_name.to_string(),
                    mode: "cut".to_string(),
                });
                break;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                last_err = stderr
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    if let Some(ta) = temp_ass_opt {
        let _ = tokio::fs::remove_file(&ta).await;
    }

    if let Some(ok_res) = final_res {
        if !req.cues.is_empty() {
            let srt_path = out_path.with_extension("srt");
            let srt_doc = build_srt_document(&req.cues, req.style.bilingual_enabled);
            let _ = tokio::fs::write(&srt_path, srt_doc.as_bytes()).await;
        }
        Ok(ok_res)
    } else {
        Err(format!("ตัดต่อวิดีโอไม่สำเร็จ: {}", last_err))
    }
}

pub async fn render_viral_shorts_916(
    app: &AppHandle,
    req: ViralShortsRequest,
) -> Result<HardsubResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;
    let src = PathBuf::from(&req.video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอต้นฉบับบนเครื่อง".to_string());
    }

    let start = req.start_sec.max(0.0);
    let end = req.end_sec.max(start + 1.0);
    let clip_dur = end - start;

    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_path = parent.join(format!("{}_shorts916_{}.mp4", stem, ts % 10000));
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    // Shift cues into [0 .. clip_dur]
    let shifted_cues: Vec<CueItem> = req
        .cues
        .iter()
        .filter(|c| c.end > start && c.start < end)
        .map(|c| CueItem {
            start: (c.start - start).max(0.0),
            end: (c.end - start).min(clip_dur),
            text: c.text.clone(),
            secondary_text: c.secondary_text.clone(),
        })
        .collect();

    let mut shorts_style = req.style.clone();
    // Ensure subtitles sit cleanly inside 9:16 lower safe zone (above TikTok caption bar)
    if shorts_style.pos_y > 80.0 {
        shorts_style.pos_y = 74.0;
    }

    let headline_opt = if req.headline.trim().is_empty() {
        None
    } else {
        Some(req.headline.trim())
    };
    let ass_doc = build_ass_document_with_headline(
        &shifted_cues,
        &shorts_style,
        1080,
        1920,
        headline_opt,
        &req.headline_color,
        clip_dur,
    );
    let mut temp_ass = std::env::temp_dir();
    temp_ass.push(format!("autosub_shorts_{}.ass", ts));
    tokio::fs::write(&temp_ass, ass_doc.as_bytes())
        .await
        .map_err(|e| format!("สร้างไฟล์ .ass ไม่สำเร็จ: {}", e))?;

    let mut chains: Vec<String> = Vec::new();
    let bg_mode = req.bg_mode.trim().to_lowercase();
    if bg_mode == "crop_fill" {
        chains.push("[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v_916]".to_string());
    } else if bg_mode == "solid" {
        chains.push("color=c=0x070b14:s=1080x1920[v_bg];[0:v]scale=1080:-2[v_fg];[v_bg][v_fg]overlay=0:(H-h)/2:shortest=1[v_916]".to_string());
    } else {
        // Classic Drama Blurred 9:16 Vertical Layout
        chains.push("[0:v]split=2[bg_src][fg_src];[bg_src]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=18:luma_power=2[v_bg];[fg_src]scale=1080:-2[v_fg];[v_bg][v_fg]overlay=0:(H-h)/2[v_916]".to_string());
    }

    let mut cur_label = "[v_916]".to_string();
    let escaped_ass = escape_ffmpeg_filter_path(temp_ass.to_str().ok_or("Invalid ass path")?);
    if let Some(fonts_dir) = find_bundled_fonts_dir(app) {
        chains.push(format!(
            "{}ass='{}':fontsdir='{}'[v_sub]",
            cur_label,
            escaped_ass,
            escape_ffmpeg_filter_path(&fonts_dir)
        ));
    } else {
        chains.push(format!("{}ass='{}'[v_sub]", cur_label, escaped_ass));
    }
    cur_label = "[v_sub]".to_string();

    let wm_path_opt = if req.watermark.enabled
        && !req.watermark.image_path.trim().is_empty()
        && Path::new(req.watermark.image_path.trim()).is_file()
    {
        let wm_w = ((1080.0 * req.watermark.width_pct.clamp(5.0, 35.0) / 100.0).round() as u32)
            .max(40)
            & !1;
        let margin = 32u32;
        let coords = match req.watermark.position.trim().to_lowercase().as_str() {
            "top-left" => format!("{}:{}", margin, margin),
            "bottom-left" => format!("{}:H-h-{}", margin, margin),
            "bottom-right" => format!("W-w-{}:H-h-{}", margin, margin),
            _ => format!("W-w-{}:{}", margin, margin),
        };
        chains.push(format!(
            "[1:v]format=rgba,scale={}:-1,colorchannelmixer=aa={:.2}[wm_img];{}[wm_img]overlay={}[v_wm]",
            wm_w,
            req.watermark.opacity.clamp(0.1, 1.0),
            cur_label,
            coords
        ));
        cur_label = "[v_wm]".to_string();
        Some(req.watermark.image_path.trim().to_string())
    } else {
        None
    };

    let filter_complex = chains.join(";");
    let ss_str = format!("{:.3}", start);
    let dur_str = format!("{:.3}", clip_dur);

    #[cfg(target_os = "macos")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "6M"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];
    #[cfg(target_os = "windows")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "22"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];

    let mut last_err = String::new();
    let mut final_res: Option<HardsubResult> = None;

    for (enc_name, enc_args) in encoders {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-y", "-ss", &ss_str, "-t", &dur_str, "-i", &req.video_path]);
        if let Some(ref wm) = wm_path_opt {
            cmd.args(["-i", wm]);
        }
        cmd.args([
            "-filter_complex",
            &filter_complex,
            "-map",
            &cur_label,
            "-map",
            "0:a?",
        ]);
        cmd.args(&enc_args);
        cmd.args([
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }

        match cmd.output().await {
            Ok(out) if out.status.success() => {
                final_res = Some(HardsubResult {
                    output_path: out_str.to_string(),
                    encoder_used: enc_name.to_string(),
                    mode: "shorts_916".to_string(),
                });
                break;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                last_err = stderr
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>();
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    let _ = tokio::fs::remove_file(&temp_ass).await;
    final_res.ok_or_else(|| format!("สร้างคลิปสั้น 9:16 ไม่สำเร็จ: {}", last_err))
}

pub async fn generate_local_thumbnail(
    video_path: &str,
    project_id: &str,
) -> Result<String, String> {
    let src = Path::new(video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอต้นฉบับ".to_string());
    }
    let clean_id: String = project_id
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '_' | '-'))
        .take(64)
        .collect();
    if clean_id.is_empty() {
        return Err("Invalid project_id".to_string());
    }

    let mut cache_dir = std::env::temp_dir();
    cache_dir.push("autosub_thumbs");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let out_path = cache_dir.join(format!("{}.jpg", clean_id));
    if let Ok(meta) = tokio::fs::metadata(&out_path).await {
        if meta.len() > 200 {
            return Ok(out_path.to_string_lossy().to_string());
        }
    }

    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;
    let out_str = out_path.to_str().ok_or("Invalid thumb path")?;

    for seek_sec in ["2", "0"] {
        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-y",
            "-ss",
            seek_sec,
            "-i",
            video_path,
            "-frames:v",
            "1",
            "-vf",
            "scale=480:-2",
            "-q:v",
            "4",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        if let Ok(out) = cmd.output().await {
            if out.status.success() {
                if let Ok(meta) = tokio::fs::metadata(&out_path).await {
                    if meta.len() > 200 {
                        return Ok(out_path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Err("ไม่สามารถสร้างภาพปกจากไฟล์นี้ได้ (อาจเป็นไฟล์เสียงล้วน)".to_string())
}

// =========================================================================
// PHASE 1 (v1.2.0): PRO SPLIT, DEMUX & MULTI-CLIP MERGE ENGINE
// =========================================================================

fn format_vtt_ts(sec: f64) -> String {
    let clamped = sec.max(0.0);
    let total_ms = (clamped * 1000.0).round() as u64;
    let h = total_ms / 3_600_000;
    let m = (total_ms % 3_600_000) / 60_000;
    let s = (total_ms % 60_000) / 1000;
    let ms = total_ms % 1000;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

fn build_vtt_document(cues: &[CueItem], bilingual: bool) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for cue in cues {
        let p = cue.text.trim();
        let s = cue.secondary_text.trim();
        if p.is_empty() && s.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "{} --> {}\n",
            format_vtt_ts(cue.start),
            format_vtt_ts(cue.end.max(cue.start + 0.1))
        ));
        if bilingual && !s.is_empty() {
            out.push_str(p);
            out.push('\n');
            out.push_str(s);
        } else if !p.is_empty() {
            out.push_str(p);
        } else {
            out.push_str(s);
        }
        out.push_str("\n\n");
    }
    out
}

async fn probe_has_audio_stream(ffmpeg: &str, path: &str) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-i", path]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    match cmd.output().await {
        Ok(out) => String::from_utf8_lossy(&out.stderr).contains("Audio:"),
        Err(_) => false,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SplitPartSpec {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub cues: Vec<CueItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct SplitMediaRequest {
    pub video_path: String,
    pub output_dir: Option<String>,
    pub parts: Vec<SplitPartSpec>,
    pub mode: String, // "lossless" | "precision"
    pub burn_subs: bool,
    pub save_srt: bool,
    pub save_vtt: bool,
    pub style: SubtitleStyleConfig,
    pub delogo: DelogoConfig,
    pub watermark: WatermarkConfig,
}

impl Default for SplitMediaRequest {
    fn default() -> Self {
        Self {
            video_path: String::new(),
            output_dir: None,
            parts: Vec::new(),
            mode: "lossless".to_string(),
            burn_subs: false,
            save_srt: true,
            save_vtt: false,
            style: SubtitleStyleConfig::default(),
            delogo: DelogoConfig::default(),
            watermark: WatermarkConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitPartOutput {
    pub index: usize,
    pub video_path: String,
    pub srt_path: Option<String>,
    pub vtt_path: Option<String>,
    pub duration: f64,
    pub cue_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SplitMediaResult {
    pub output_dir: String,
    pub parts: Vec<SplitPartOutput>,
    pub mode: String,
}

pub async fn split_media_parts(
    app: &AppHandle,
    req: SplitMediaRequest,
) -> Result<SplitMediaResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่องสำหรับแยกไฟล์".to_string())?;

    let src = Path::new(&req.video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์วิดีโอต้นฉบับในเครื่อง".to_string());
    }
    if req.parts.is_empty() {
        return Err("ไม่มีช่วงเวลาที่จะแยกไฟล์".to_string());
    }

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string();
    let parent = src.parent().unwrap_or_else(|| Path::new("."));

    let out_dir = match req.output_dir.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => parent.join(format!("{}_parts", stem)),
    };
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("สร้างโฟลเดอร์ปลายทางไม่สำเร็จ: {}", e))?;

    let probe = probe_media(&req.video_path).await.ok();
    let vid_w = probe.as_ref().and_then(|p| p.width).unwrap_or(1920);
    let vid_h = probe.as_ref().and_then(|p| p.height).unwrap_or(1080);
    let fonts_dir = find_bundled_fonts_dir(app);
    let is_precision = req.mode.trim().eq_ignore_ascii_case("precision") || req.burn_subs;

    #[cfg(target_os = "macos")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "6M"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];
    #[cfg(target_os = "windows")]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "22"]),
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let encoders: Vec<(&str, Vec<&str>)> = vec![
        ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
    ];

    let mut outputs: Vec<SplitPartOutput> = Vec::new();
    let ts_base = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    for part in &req.parts {
        let start = part.start.max(0.0);
        let dur = (part.end - start).max(0.2);
        let part_num = if part.index == 0 { outputs.len() + 1 } else { part.index };
        let base_name = format!("{}_part{:02}", stem, part_num);
        let out_video = out_dir.join(format!("{}.mp4", base_name));
        let out_video_str = out_video
            .to_str()
            .ok_or_else(|| "พาธปลายทางไม่ถูกต้อง".to_string())?;

        let ss_str = format!("{:.3}", start);
        let dur_str = format!("{:.3}", dur);

        if !is_precision {
            let mut cmd = Command::new(&ffmpeg);
            cmd.args([
                "-y",
                "-ss",
                &ss_str,
                "-i",
                &req.video_path,
                "-t",
                &dur_str,
                "-map",
                "0:v?",
                "-map",
                "0:a?",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "+faststart",
                out_video_str,
            ]);
            #[cfg(target_os = "windows")]
            {
                cmd.creation_flags(0x08000000);
            }
            let out = cmd
                .output()
                .await
                .map_err(|e| format!("รัน FFmpeg แยกไฟล์ไม่สำเร็จ: {}", e))?;
            if !out.status.success() {
                let err_tail = String::from_utf8_lossy(&out.stderr);
                return Err(format!(
                    "แยกไฟล์ตอนที่ {} ไม่สำเร็จ: {}",
                    part_num,
                    err_tail.chars().rev().take(240).collect::<String>().chars().rev().collect::<String>()
                ));
            }
        } else {
            let mut temp_ass: Option<PathBuf> = None;
            let mut vf_parts: Vec<String> = Vec::new();
            if req.burn_subs && !part.cues.is_empty() {
                let ass_text = build_ass_document(&part.cues, &req.style, vid_w, vid_h);
                let ass_path = std::env::temp_dir()
                    .join(format!("autosub_split_{}_{}.ass", ts_base, part_num));
                tokio::fs::write(&ass_path, ass_text.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                let esc_ass = escape_ffmpeg_filter_path(ass_path.to_str().unwrap_or(""));
                if let Some(ref fdir) = fonts_dir {
                    let esc_fd = escape_ffmpeg_filter_path(fdir);
                    vf_parts.push(format!("ass='{}':fontsdir='{}'", esc_ass, esc_fd));
                } else {
                    vf_parts.push(format!("ass='{}'", esc_ass));
                }
                temp_ass = Some(ass_path);
            }

            let mut ok = false;
            let mut last_err = String::new();
            for (_enc_name, enc_args) in &encoders {
                let mut cmd = Command::new(&ffmpeg);
                cmd.args(["-y", "-ss", &ss_str, "-t", &dur_str, "-i", &req.video_path]);
                if !vf_parts.is_empty() {
                    cmd.args(["-vf", &vf_parts.join(",")]);
                }
                cmd.args(enc_args);
                cmd.args([
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-movflags",
                    "+faststart",
                    out_video_str,
                ]);
                #[cfg(target_os = "windows")]
                {
                    cmd.creation_flags(0x08000000);
                }
                match cmd.output().await {
                    Ok(o) if o.status.success() => {
                        ok = true;
                        break;
                    }
                    Ok(o) => {
                        let s = String::from_utf8_lossy(&o.stderr);
                        last_err = s.chars().rev().take(240).collect::<String>().chars().rev().collect::<String>();
                    }
                    Err(e) => last_err = e.to_string(),
                }
            }
            if let Some(p) = temp_ass {
                let _ = tokio::fs::remove_file(p).await;
            }
            if !ok {
                return Err(format!("แยกไฟล์ (Precision) ตอนที่ {} ไม่สำเร็จ: {}", part_num, last_err));
            }
        }

        let mut srt_saved = None;
        let mut vtt_saved = None;
        if req.save_srt && !part.cues.is_empty() {
            let srt_path = out_dir.join(format!("{}.srt", base_name));
            let srt_text = build_srt_document(&part.cues, req.style.bilingual_enabled);
            tokio::fs::write(&srt_path, srt_text.as_bytes())
                .await
                .map_err(|e| format!("บันทึก SRT ตอนที่ {} ไม่สำเร็จ: {}", part_num, e))?;
            srt_saved = Some(srt_path.to_string_lossy().to_string());
        }
        if req.save_vtt && !part.cues.is_empty() {
            let vtt_path = out_dir.join(format!("{}.vtt", base_name));
            let vtt_text = build_vtt_document(&part.cues, req.style.bilingual_enabled);
            tokio::fs::write(&vtt_path, vtt_text.as_bytes())
                .await
                .map_err(|e| format!("บันทึก VTT ตอนที่ {} ไม่สำเร็จ: {}", part_num, e))?;
            vtt_saved = Some(vtt_path.to_string_lossy().to_string());
        }

        outputs.push(SplitPartOutput {
            index: part_num,
            video_path: out_video_str.to_string(),
            srt_path: srt_saved,
            vtt_path: vtt_saved,
            duration: dur,
            cue_count: part.cues.len(),
        });
    }

    Ok(SplitMediaResult {
        output_dir: out_dir.to_string_lossy().to_string(),
        parts: outputs,
        mode: if is_precision { "precision".to_string() } else { "lossless".to_string() },
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct DemuxExtractRequest {
    pub video_path: String,
    pub track_type: String, // "audio_mp3" | "audio_wav" | "audio_m4a" | "video_mute"
    pub output_path: Option<String>,
}

pub async fn demux_extract_track(req: DemuxExtractRequest) -> Result<HardsubResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่อง".to_string())?;

    let src = Path::new(&req.video_path);
    if !src.is_file() {
        return Err("ไม่พบไฟล์ต้นฉบับในเครื่อง".to_string());
    }

    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("media");
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let kind = req.track_type.trim().to_lowercase();

    let (default_suffix, args): (&str, Vec<&str>) = match kind.as_str() {
        "audio_wav" => ("_audio_16k.wav", vec!["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]),
        "audio_m4a" => ("_audio.m4a", vec!["-vn", "-c:a", "aac", "-b:a", "192k"]),
        "video_mute" => ("_mute.mp4", vec!["-an", "-c:v", "copy", "-movflags", "+faststart"]),
        _ => ("_audio.mp3", vec!["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
    };

    let out_path = match req.output_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => parent.join(format!("{}{}", stem, default_suffix)),
    };
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-y", "-i", &req.video_path]);
    cmd.args(&args);
    cmd.arg(out_str);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("รัน FFmpeg แยกแทร็กไม่สำเร็จ: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "แยกแทร็กไม่สำเร็จ: {}",
            err.chars().rev().take(240).collect::<String>().chars().rev().collect::<String>()
        ));
    }

    Ok(HardsubResult {
        output_path: out_str.to_string(),
        encoder_used: kind.clone(),
        mode: kind,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct MergeClipInput {
    pub video_path: String,
    #[serde(default)]
    pub cues: Vec<CueItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MergeMediaRequest {
    pub clips: Vec<MergeClipInput>,
    pub output_path: Option<String>,
    pub mode: String,              // "lossless" | "conform"
    pub target_resolution: String, // "original" | "1080p" | "720p" | "916"
    pub transition: String,        // "none" | "fade"
    pub save_merged_srt: bool,
    pub save_merged_vtt: bool,
    pub bilingual_enabled: bool,
}

impl Default for MergeMediaRequest {
    fn default() -> Self {
        Self {
            clips: Vec::new(),
            output_path: None,
            mode: "lossless".to_string(),
            target_resolution: "original".to_string(),
            transition: "none".to_string(),
            save_merged_srt: true,
            save_merged_vtt: false,
            bilingual_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeMediaResult {
    pub output_path: String,
    pub srt_path: Option<String>,
    pub vtt_path: Option<String>,
    pub total_duration: f64,
    pub merged_cues: Vec<CueItem>,
    pub clip_count: usize,
    pub mode: String,
    pub encoder_used: String,
}

pub async fn merge_media_clips(req: MergeMediaRequest) -> Result<MergeMediaResult, String> {
    let (ffmpeg, _) = resolve_ffmpeg_binary()
        .ok_or_else(|| "ไม่พบ FFmpeg ในเครื่องสำหรับรวมไฟล์".to_string())?;

    if req.clips.len() < 2 {
        return Err("กรุณาเลือกไฟล์อย่างน้อย 2 ไฟล์เพื่อรวมเป็นไฟล์เดียว".to_string());
    }

    for clip in &req.clips {
        if !Path::new(&clip.video_path).is_file() {
            return Err(format!("ไม่พบไฟล์ต้นฉบับ: {}", clip.video_path));
        }
    }

    let first_path = Path::new(&req.clips[0].video_path);
    let first_stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("merged");
    let first_parent = first_path.parent().unwrap_or_else(|| Path::new("."));

    let out_path = match req.output_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => first_parent.join(format!("{}_merged.mp4", first_stem)),
    };
    let out_str = out_path.to_str().ok_or("Invalid output path")?;

    // 1. Probe every clip for exact duration, dimensions, and audio presence -> stitch cues with exact offset
    let mut durations: Vec<f64> = Vec::with_capacity(req.clips.len());
    let mut has_audios: Vec<bool> = Vec::with_capacity(req.clips.len());
    let mut first_w: u32 = 1920;
    let mut first_h: u32 = 1080;
    let mut merged_cues: Vec<CueItem> = Vec::new();
    let mut offset: f64 = 0.0;

    for (idx, clip) in req.clips.iter().enumerate() {
        let info = probe_media(&clip.video_path).await?;
        let dur = info.duration_seconds.unwrap_or(0.0).max(0.1);
        if idx == 0 {
            if let (Some(w), Some(h)) = (info.width, info.height) {
                first_w = (w / 2) * 2;
                first_h = (h / 2) * 2;
            }
        }
        let ha = probe_has_audio_stream(&ffmpeg, &clip.video_path).await;
        for c in &clip.cues {
            if c.text.trim().is_empty() && c.secondary_text.trim().is_empty() {
                continue;
            }
            merged_cues.push(CueItem {
                start: ((c.start.max(0.0) + offset) * 1000.0).round() / 1000.0,
                end: ((c.end.max(c.start + 0.1) + offset) * 1000.0).round() / 1000.0,
                text: c.text.clone(),
                secondary_text: c.secondary_text.clone(),
            });
        }
        durations.push(dur);
        has_audios.push(ha);
        offset += dur;
    }

    let total_duration = offset;
    let want_lossless = req.mode.trim().eq_ignore_ascii_case("lossless")
        && !req.transition.trim().eq_ignore_ascii_case("fade")
        && req.target_resolution.trim().eq_ignore_ascii_case("original");

    let mut used_mode = "conform".to_string();
    let mut encoder_used = "copy".to_string();
    let mut lossless_ok = false;

    // 2. Try Fast Lossless Concat Demuxer first when requested
    if want_lossless {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let list_path = std::env::temp_dir().join(format!("autosub_merge_{}.txt", ts));
        let mut list_content = String::new();
        for clip in &req.clips {
            let norm = clip.video_path.replace('\\', "/").replace('\'', "'\\''");
            list_content.push_str(&format!("file '{}'\n", norm));
        }
        tokio::fs::write(&list_path, list_content.as_bytes())
            .await
            .map_err(|e| format!("สร้างรายการรวมไฟล์ไม่สำเร็จ: {}", e))?;

        let mut cmd = Command::new(&ffmpeg);
        cmd.args([
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_path.to_str().unwrap_or(""),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            out_str,
        ]);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000);
        }
        if let Ok(out) = cmd.output().await {
            if out.status.success() {
                lossless_ok = true;
                used_mode = "lossless".to_string();
                encoder_used = "stream_copy".to_string();
            }
        }
        let _ = tokio::fs::remove_file(&list_path).await;
    }

    // 3. Smart Auto-Conform Merge (works across different codecs, resolutions, FPS, MP4/MKV/MOV + optional Fade!)
    if !lossless_ok {
        let (target_w, target_h) = match req.target_resolution.trim().to_lowercase().as_str() {
            "1080p" => (1920u32, 1080u32),
            "720p" => (1280u32, 720u32),
            "916" | "9:16" => (1080u32, 1920u32),
            _ => (first_w.max(320), first_h.max(240)),
        };
        let use_fade = req.transition.trim().eq_ignore_ascii_case("fade");

        let mut filter_parts: Vec<String> = Vec::new();
        let mut concat_inputs = String::new();

        for i in 0..req.clips.len() {
            let dur = durations[i];
            let mut v_chain = format!(
                "[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p",
                i = i,
                w = target_w,
                h = target_h
            );
            if use_fade && dur > 1.2 {
                let fade_d = 0.35;
                if i > 0 {
                    v_chain.push_str(&format!(",fade=t=in:st=0:d={:.2}", fade_d));
                }
                if i + 1 < req.clips.len() {
                    let st_out = (dur - fade_d).max(0.1);
                    v_chain.push_str(&format!(",fade=t=out:st={:.2}:d={:.2}", st_out, fade_d));
                }
            }
            v_chain.push_str(&format!("[v{}]", i));
            filter_parts.push(v_chain);

            if has_audios[i] {
                let mut a_chain = format!(
                    "[{i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                    i = i
                );
                if use_fade && dur > 1.2 {
                    let fade_d = 0.30;
                    if i > 0 {
                        a_chain.push_str(&format!(",afade=t=in:st=0:d={:.2}", fade_d));
                    }
                    if i + 1 < req.clips.len() {
                        let st_out = (dur - fade_d).max(0.1);
                        a_chain.push_str(&format!(",afade=t=out:st={:.2}:d={:.2}", st_out, fade_d));
                    }
                }
                a_chain.push_str(&format!("[a{}]", i));
                filter_parts.push(a_chain);
            } else {
                filter_parts.push(format!(
                    "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{:.3},asetpts=PTS-STARTPTS[a{}]",
                    dur, i
                ));
            }
            concat_inputs.push_str(&format!("[v{}][a{}]", i, i));
        }

        filter_parts.push(format!(
            "{}concat=n={}:v=1:a=1[vout][aout]",
            concat_inputs,
            req.clips.len()
        ));
        let filter_complex = filter_parts.join(";");

        #[cfg(target_os = "macos")]
        let encoders: Vec<(&str, Vec<&str>)> = vec![
            ("h264_videotoolbox", vec!["-c:v", "h264_videotoolbox", "-b:v", "6M"]),
            ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
        ];
        #[cfg(target_os = "windows")]
        let encoders: Vec<(&str, Vec<&str>)> = vec![
            ("h264_nvenc", vec!["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "22"]),
            ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
        ];
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let encoders: Vec<(&str, Vec<&str>)> = vec![
            ("libx264", vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]),
        ];

        let mut merged_ok = false;
        let mut last_err = String::new();
        for (enc_name, enc_args) in &encoders {
            let mut cmd = Command::new(&ffmpeg);
            cmd.arg("-y");
            for clip in &req.clips {
                cmd.args(["-i", &clip.video_path]);
            }
            cmd.args([
                "-filter_complex",
                &filter_complex,
                "-map",
                "[vout]",
                "-map",
                "[aout]",
            ]);
            cmd.args(enc_args);
            cmd.args([
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                out_str,
            ]);
            #[cfg(target_os = "windows")]
            {
                cmd.creation_flags(0x08000000);
            }
            match cmd.output().await {
                Ok(out) if out.status.success() => {
                    merged_ok = true;
                    used_mode = "conform".to_string();
                    encoder_used = enc_name.to_string();
                    break;
                }
                Ok(out) => {
                    let s = String::from_utf8_lossy(&out.stderr);
                    last_err = s.chars().rev().take(280).collect::<String>().chars().rev().collect::<String>();
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        if !merged_ok {
            return Err(format!("รวมไฟล์วิดีโอไม่สำเร็จ: {}", last_err));
        }
    }

    // 4. Write merged SRT / VTT next to output MP4 if any clips had subtitles
    let mut srt_saved = None;
    let mut vtt_saved = None;
    if !merged_cues.is_empty() {
        let out_stem = out_path.file_stem().and_then(|s| s.to_str()).unwrap_or("merged");
        let out_dir = out_path.parent().unwrap_or(first_parent);
        if req.save_merged_srt {
            let p = out_dir.join(format!("{}.srt", out_stem));
            let content = build_srt_document(&merged_cues, req.bilingual_enabled);
            tokio::fs::write(&p, content.as_bytes())
                .await
                .map_err(|e| format!("บันทึกซับรวม .srt ไม่สำเร็จ: {}", e))?;
            srt_saved = Some(p.to_string_lossy().to_string());
        }
        if req.save_merged_vtt {
            let p = out_dir.join(format!("{}.vtt", out_stem));
            let content = build_vtt_document(&merged_cues, req.bilingual_enabled);
            tokio::fs::write(&p, content.as_bytes())
                .await
                .map_err(|e| format!("บันทึกซับรวม .vtt ไม่สำเร็จ: {}", e))?;
            vtt_saved = Some(p.to_string_lossy().to_string());
        }
    }

    Ok(MergeMediaResult {
        output_path: out_str.to_string(),
        srt_path: srt_saved,
        vtt_path: vtt_saved,
        total_duration,
        merged_cues,
        clip_count: req.clips.len(),
        mode: used_mode,
        encoder_used,
    })
}
