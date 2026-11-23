use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CueItem {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub secondary_text: String,
}

impl Default for CueItem {
    fn default() -> Self {
        Self {
            start: 0.0,
            end: 0.0,
            text: String::new(),
            secondary_text: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct SubtitleStyleConfig {
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: u32,
    pub font_color: String,
    pub bg_color: String,
    pub bg_opacity: f64,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub align: String, // "left" | "center" | "right"
    pub pos_y: f64,    // 20.0 .. 95.0 (% from top)
    pub bilingual_enabled: bool,
    pub secondary_color: String,
    pub secondary_scale: f64, // e.g. 0.78
    pub karaoke_enabled: bool,
    pub karaoke_highlight_color: String,
}

impl Default for SubtitleStyleConfig {
    fn default() -> Self {
        Self {
            font_family: "Prompt".to_string(),
            font_size: 24.0,
            font_weight: 700,
            font_color: "#ffffff".to_string(),
            bg_color: "#000000".to_string(),
            bg_opacity: 0.72,
            stroke_color: "#000000".to_string(),
            stroke_width: 2.0,
            align: "center".to_string(),
            pos_y: 86.0,
            bilingual_enabled: false,
            secondary_color: "#fde047".to_string(),
            secondary_scale: 0.78,
            karaoke_enabled: false,
            karaoke_highlight_color: "#fde047".to_string(),
        }
    }
}

/// Convert CSS hex '#RRGGBB' + opacity (1.0=opaque, 0.0=transparent)
/// into ASS '&HAABBGGRR' format (AA=00 opaque, AA=FF transparent).
pub fn hex_to_ass_color(hex: &str, opacity: f64) -> String {
    let trimmed = hex.trim().trim_start_matches('#');
    let expanded = if trimmed.len() == 3 {
        trimmed
            .chars()
            .flat_map(|c| [c, c])
            .collect::<String>()
    } else {
        trimmed.to_string()
    };

    let valid = expanded.len() == 6 && expanded.chars().all(|c| c.is_ascii_hexdigit());
    let clean = if valid {
        expanded.to_uppercase()
    } else {
        "FFFFFF".to_string()
    };

    let r = &clean[0..2];
    let g = &clean[2..4];
    let b = &clean[4..6];
    let alpha_clamped = opacity.clamp(0.0, 1.0);
    let aa = ((1.0 - alpha_clamped) * 255.0).round() as u8;
    format!("&H{:02X}{}{}{}", aa, b, g, r)
}

fn sec_to_ass_ts(sec: f64) -> String {
    let safe = sec.max(0.0);
    let total_cs = (safe * 100.0).round() as u64;
    let cs = total_cs % 100;
    let total_s = total_cs / 100;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{}:{:02}:{:02}.{:02}", h, m, s, cs)
}

fn escape_ass_text(raw: &str) -> String {
    raw.trim()
        .replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace("\r\n", "\\N")
        .replace('\n', "\\N")
}

fn normalize_font_family(requested: &str) -> String {
    let lower = requested.trim().to_lowercase();
    match lower.as_str() {
        "prompt" | "inter" | "sans-serif" | "" => "Prompt".to_string(),
        "kanit" => "Kanit".to_string(),
        "sarabun" => "Sarabun".to_string(),
        "tahoma" => "Tahoma".to_string(),
        _ => requested.trim().to_string(),
    }
}

fn build_karaoke_line(escaped_text: &str, duration_sec: f64) -> String {
    let total_cs = ((duration_sec.max(0.2) * 100.0).round() as u32).max(10);
    // Split by spaces if spaces exist; for continuous Thai sentences, chunk into ~5-char rhythmic beats
    let tokens: Vec<String> = if escaped_text.contains(' ') {
        escaped_text
            .split(' ')
            .filter(|w| !w.is_empty())
            .enumerate()
            .map(|(i, w)| if i == 0 { w.to_string() } else { format!(" {}", w) })
            .collect()
    } else {
        let chars: Vec<char> = escaped_text.chars().collect();
        let mut chunks = Vec::new();
        let mut idx = 0;
        while idx < chars.len() {
            let end = (idx + 5).min(chars.len());
            chunks.push(chars[idx..end].iter().collect::<String>());
            idx = end;
        }
        chunks
    };

    if tokens.is_empty() {
        return escaped_text.to_string();
    }

    let total_chars: usize = tokens.iter().map(|t| t.chars().count().max(1)).sum();
    let mut out = String::new();
    let mut used_cs = 0u32;
    for (i, tok) in tokens.iter().enumerate() {
        let cs = if i + 1 == tokens.len() {
            total_cs.saturating_sub(used_cs).max(5)
        } else {
            let w = tok.chars().count().max(1) as f64;
            let alloc = ((w / (total_chars.max(1) as f64)) * (total_cs as f64)).round() as u32;
            alloc.max(5)
        };
        used_cs = used_cs.saturating_add(cs);
        out.push_str(&format!("{{\\kf{}}}{}", cs, tok));
    }
    out
}

/// Builds a complete WYSIWYG Advanced SubStation Alpha (.ass) document
/// matching the Desktop Style Inspector settings, with optional top viral headline banner.
pub fn build_ass_document(
    cues: &[CueItem],
    style: &SubtitleStyleConfig,
    play_res_x: u32,
    play_res_y: u32,
) -> String {
    build_ass_document_with_headline(cues, style, play_res_x, play_res_y, None, "#fde047", 0.0)
}

pub fn build_ass_document_with_headline(
    cues: &[CueItem],
    style: &SubtitleStyleConfig,
    play_res_x: u32,
    play_res_y: u32,
    headline_text: Option<&str>,
    headline_color: &str,
    clip_duration: f64,
) -> String {
    let res_x = play_res_x.max(320);
    let res_y = play_res_y.max(240);

    let font_name = normalize_font_family(&style.font_family);
    let scale_factor = (res_y as f64) / 540.0;
    let primary_fs = (style.font_size.clamp(12.0, 72.0) * scale_factor).round() as u32;
    let secondary_fs = ((primary_fs as f64) * style.secondary_scale.clamp(0.55, 1.0)).round() as u32;
    let headline_fs = ((res_x as f64) * 0.062).round().clamp(36.0, 88.0) as u32;

    let bold_flag = if style.font_weight >= 600 { -1 } else { 0 };
    let base_colour = hex_to_ass_color(&style.font_color, 1.0);
    let karaoke_hi_colour = hex_to_ass_color(&style.karaoke_highlight_color, 1.0);
    // In ASS \kf karaoke, SecondaryColour fills smoothly into PrimaryColour!
    let (primary_colour, primary_karaoke_base) = if style.karaoke_enabled {
        (karaoke_hi_colour, base_colour.clone())
    } else {
        (base_colour.clone(), hex_to_ass_color(&style.secondary_color, 1.0))
    };
    let secondary_colour = hex_to_ass_color(&style.secondary_color, 1.0);
    let stroke_colour = hex_to_ass_color(&style.stroke_color, 1.0);
    let headline_colour = hex_to_ass_color(headline_color, 1.0);

    let use_box = style.bg_opacity > 0.04;
    let (border_style, outline_colour, back_colour, outline_w, shadow_w) = if use_box {
        let box_col = hex_to_ass_color(&style.bg_color, style.bg_opacity);
        let pad = (style.stroke_width.max(2.0) * scale_factor * 1.15).clamp(2.0, 20.0);
        (3, box_col.clone(), box_col, pad, 0.0)
    } else {
        let sw = (style.stroke_width.clamp(0.0, 10.0) * scale_factor).clamp(0.0, 18.0);
        let sh = if sw > 0.0 { (1.5 * scale_factor).clamp(1.0, 6.0) } else { 0.0 };
        (1, stroke_colour, hex_to_ass_color("#000000", 0.55), sw, sh)
    };

    let alignment = match style.align.trim().to_lowercase().as_str() {
        "left" => 1,
        "right" => 3,
        _ => 2,
    };

    let pos_y_clamped = style.pos_y.clamp(15.0, 96.0);
    let margin_v = (((100.0 - pos_y_clamped) / 100.0) * (res_y as f64)).round() as u32;
    let margin_lr = ((res_x as f64) * 0.05).round() as u32;
    let headline_margin_v = ((res_y as f64) * 0.12).round() as u32;

    let mut out = String::with_capacity(4096);
    out.push_str("[Script Info]\n");
    out.push_str("Title: AutoSubAI Desktop Studio\n");
    out.push_str("ScriptType: v4.00+\n");
    out.push_str("WrapStyle: 0\n");
    out.push_str("ScaledBorderAndShadow: yes\n");
    out.push_str(&format!("PlayResX: {}\n", res_x));
    out.push_str(&format!("PlayResY: {}\n\n", res_y));

    out.push_str("[V4+ Styles]\n");
    out.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    out.push_str(&format!(
        "Style: Primary,{},{},{},{},{},{},{},0,0,0,100,100,0,0,{},{:.1},{:.1},{},{},{},{},1\n",
        font_name, primary_fs, primary_colour, primary_karaoke_base, outline_colour, back_colour,
        bold_flag, border_style, outline_w, shadow_w, alignment, margin_lr, margin_lr, margin_v
    ));
    out.push_str(&format!(
        "Style: Secondary,{},{},{},{},{},{},0,0,0,0,100,100,0,0,{},{:.1},{:.1},{},{},{},{},1\n",
        font_name, secondary_fs, secondary_colour, primary_colour, outline_colour, back_colour,
        border_style, (outline_w * 0.85).max(1.0), shadow_w, alignment, margin_lr, margin_lr, margin_v
    ));
    out.push_str(&format!(
        "Style: Headline,{},{},{},{},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5.0,2.5,8,{},{},{},1\n\n",
        font_name, headline_fs, headline_colour, headline_colour, margin_lr, margin_lr, headline_margin_v
    ));

    out.push_str("[Events]\n");
    out.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    if let Some(hl) = headline_text {
        let escaped_hl = escape_ass_text(hl);
        if !escaped_hl.is_empty() {
            let hl_end = if clip_duration > 0.5 { clip_duration } else { 36000.0 };
            out.push_str(&format!(
                "Dialogue: 1,0:00:00.00,{},Headline,,0,0,0,,{}\n",
                sec_to_ass_ts(hl_end),
                escaped_hl
            ));
        }
    }

    for cue in cues {
        let primary_raw = escape_ass_text(&cue.text);
        let secondary = escape_ass_text(&cue.secondary_text);
        if primary_raw.is_empty() && secondary.is_empty() {
            continue;
        }
        let end_clamped = cue.end.max(cue.start + 0.1);
        let s_ts = sec_to_ass_ts(cue.start);
        let e_ts = sec_to_ass_ts(end_clamped);
        let primary = if style.karaoke_enabled && !primary_raw.is_empty() {
            build_karaoke_line(&primary_raw, end_clamped - cue.start)
        } else {
            primary_raw
        };

        if style.bilingual_enabled && !secondary.is_empty() {
            let combined = if primary.is_empty() {
                format!("{{\\rSecondary}}{}", secondary)
            } else {
                format!("{}\\N{{\\rSecondary}}{}", primary, secondary)
            };
            out.push_str(&format!(
                "Dialogue: 0,{},{},Primary,,0,0,0,,{}\n",
                s_ts, e_ts, combined
            ));
        } else if !primary.is_empty() {
            out.push_str(&format!(
                "Dialogue: 0,{},{},Primary,,0,0,0,,{}\n",
                s_ts, e_ts, primary
            ));
        }
    }

    out
}

pub fn build_srt_document(cues: &[CueItem], bilingual: bool) -> String {
    let mut out = String::new();
    let mut idx = 1usize;
    for cue in cues {
        let p = cue.text.trim();
        let s = cue.secondary_text.trim();
        let body = if bilingual && !s.is_empty() {
            if p.is_empty() {
                s.to_string()
            } else {
                format!("{}\n{}", p, s)
            }
        } else {
            p.to_string()
        };
        if body.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx,
            sec_to_srt_ts(cue.start),
            sec_to_srt_ts(cue.end.max(cue.start + 0.1)),
            body
        ));
        idx += 1;
    }
    out
}

fn sec_to_srt_ts(sec: f64) -> String {
    let safe = sec.max(0.0);
    let total_ms = (safe * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}
