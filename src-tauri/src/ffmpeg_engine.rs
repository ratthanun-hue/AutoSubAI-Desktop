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
