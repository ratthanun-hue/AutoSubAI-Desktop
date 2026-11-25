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
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION: &str = "143";
const SEC_MS_GEC_VERSION: &str = "2-143.0.3650.75";
const MIN_VALID_AUDIO_BYTES: u64 = 2048;

#[derive(Debug, Clone, Serialize)]
pub struct TtsResult {
    pub path: String,
    pub duration: f64,
    pub engine: String,
}

// ---------------------------------------------------------------------------
// Microsoft Edge Neural TTS v2 DRM Token (Sec-MS-GEC v2: CS64 + Modified SHA256)
// Ported from official rany2/edge-tts drm.py (v7.3+)
// ---------------------------------------------------------------------------
const SHA256_INITIAL: [u32; 8] = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
    0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];

const SHA256_STATE: [u32; 8] = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
    0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];

const SHA256_SCHEDULE: [u32; 14] = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
    0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
    0xD258B060, 0x72766564,
];

const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];

const SHA256_ADJUSTMENT: u32 = 0xC9DC06A7;
const SHA256_SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;

const CS64_COEFFICIENTS: [(u32, u32); 14] = [
    (0xE82E91B1, 0xB32700D0),
    (0x44DE24C6, 0x88DFF51D),
    (0x3BEB65BC, 0x29514038),
    (0xC89C5933, 0xB328CBDF),
    (0x8D1EC211, 0xD405B4D5),
    (0x314EF5D5, 0x26E55F3C),
    (0xE92491B1, 0x607801C6),
    (0xF0A5B9D5, 0x82B2C1FB),
    (0x06064CF3, 0xFA51A3DA),
    (0xDA79FA60, 0x207CC464),
    (0xBED20560, 0x3C3C74F3),
    (0x89F9C9F8, 0xD2D14B61),
    (0x35FA38C6, 0xBB04A2C1),
    (0xCB49E3C6, 0xC5626167),
];

const CS64_FACTOR: u32 = 0x82893933;
const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

#[inline]
fn small_sigma0(x: u32) -> u32 {
    x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)
}

#[inline]
fn small_sigma1(x: u32) -> u32 {
    x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10)
}

#[inline]
fn big_sigma0(x: u32) -> u32 {
    x.rotate_right(2) ^ x.rotate_right(13) ^ x.rotate_right(22)
}

#[inline]
fn big_sigma1(x: u32) -> u32 {
    x.rotate_right(6) ^ x.rotate_right(11) ^ x.rotate_right(25)
}

fn expand_sha256_schedule(words: &mut [u32; 64], first_word: usize) {
    for i in first_word..64 {
        words[i] = small_sigma1(words[i - 2])
            .wrapping_add(words[i - 7])
            .wrapping_add(small_sigma0(words[i - 15]))
            .wrapping_add(words[i - 16]);
    }
}

fn sha256_rounds(state: [u32; 8], words: &[u32; 64], first_round: usize) -> [u32; 8] {
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
    for i in first_round..64 {
        let k = if first_round == 14 && i == 14 {
            SHA256_ADJUSTMENT
        } else {
            SHA256_ROUND_CONSTANTS[i]
        };
        let ch = g ^ (e & (f ^ g));
        let maj = (a & b) | (c & (a | b));
        let t1 = h
            .wrapping_add(big_sigma1(e))
            .wrapping_add(ch)
            .wrapping_add(k)
            .wrapping_add(words[i]);
        let t2 = big_sigma0(a).wrapping_add(maj);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    [a, b, c, d, e, f, g, h]
}

fn custom_sha256_digest(data: &[u8]) -> [u8; 32] {
    let mut words = [0u32; 64];
    words[14] = ((data[0] as u32) << 16) | ((data[1] as u32) << 8) | (data[2] as u32);
    words[15] = u32::from_be_bytes([data[3], data[4], data[5], data[6]]);

    for i in 16..30 {
        let mut v = SHA256_SCHEDULE[i - 16];
        if i - 2 >= 14 {
            let s = small_sigma1(words[i - 2]);
            v = v.wrapping_add(if i == 16 { s ^ SHA256_SIGMA1_ADJUSTMENT } else { s });
        }
        if i - 7 >= 14 {
            v = v.wrapping_add(words[i - 7]);
        }
        if i - 15 >= 14 {
            let s = small_sigma0(words[i - 15]);
            v = v.wrapping_add(if i == 29 { s ^ SHA256_SIGMA0_ADJUSTMENT } else { s });
        }
        words[i] = v;
    }
    words[30] = small_sigma1(words[28])
        .wrapping_add(words[23])
        .wrapping_add(small_sigma0(words[15]))
        .wrapping_add(words[14])
        .wrapping_add(SHA256_ADJUSTMENT)
        .wrapping_sub(SHA256_ROUND_CONSTANTS[14]);
    expand_sha256_schedule(&mut words, 31);

    let working = sha256_rounds(SHA256_STATE, &words, 14);
    let mut state = [0u32; 8];
    for i in 0..8 {
        state[i] = SHA256_INITIAL[i].wrapping_add(working[i]);
    }

    let length = 57usize + data.len();
    let zero_len = (55isize - (length as isize)).rem_euclid(64) as usize;
    let mut padded = Vec::with_capacity(data.len() - 7 + 1 + zero_len + 8);
    padded.extend_from_slice(&data[7..]);
    padded.push(0x80);
    padded.resize(padded.len() + zero_len, 0);
    padded.extend_from_slice(&((length as u64) * 8).to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut bw = [0u32; 64];
        for j in 0..16 {
            bw[j] = u32::from_be_bytes([
                chunk[j * 4],
                chunk[j * 4 + 1],
                chunk[j * 4 + 2],
                chunk[j * 4 + 3],
            ]);
        }
        expand_sha256_schedule(&mut bw, 16);
        let wrk = sha256_rounds(state, &bw, 0);
        for i in 0..8 {
            state[i] = state[i].wrapping_add(wrk[i]);
        }
    }

    let mut out = [0u8; 32];
    for i in 0..8 {
        out[i * 4..i * 4 + 4].copy_from_slice(&state[i].to_be_bytes());
    }
    out
}

fn cs64_digest(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
    let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
    let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
    let factors = [
        key_a.wrapping_mul(CS64_FACTOR),
        key_b.wrapping_mul(CS64_FACTOR),
    ];

    let mut terms: Vec<u32> = Vec::with_capacity(32);
    let mut offsets: Vec<u32> = Vec::with_capacity(32);
    for (idx, &(coeff, off)) in CS64_COEFFICIENTS.iter().enumerate() {
        terms.push(coeff.wrapping_mul(factors[idx % 2]));
        offsets.push(off);
    }

    let mut inp = Vec::with_capacity(1 + data.len() + 4);
    inp.push(0u8);
    inp.extend_from_slice(data);
    while inp.len() % 4 != 0 {
        inp.push(0u8);
    }
    let mut words: Vec<u32> = inp
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    if words.len() % 2 != 0 {
        words.push(0);
    }

    for (idx, &word) in words.iter().enumerate() {
        let mut term = word.wrapping_mul(if idx % 2 == 0 { key_a } else { key_b });
        let mut off = word
            .rotate_left(16)
            .wrapping_mul(if idx % 2 == 0 { 0xEF0569FB } else { 0xC31713DB });
        if idx == 0 {
            term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
            off = off.wrapping_add(CS64_ADJUSTMENT1);
        }
        terms.push(term);
        offsets.push(off);
    }

    let mut swap_acc: u32 = 0;
    let mut swap_last: u32 = 0;
    let mut state: u32 = 0;
    let mut acc: u32 = 0;

    let mut i = 0;
    while i < terms.len() {
        let x = terms[i];
        let y = terms[i + 1];

        let t1 = offsets[i].wrapping_add(x).rotate_left(16);
        let q1 = t1.wrapping_mul(0x76F50F34);
        swap_acc = swap_acc.wrapping_add(q1.rotate_left(16).wrapping_mul(0xC3EFEA97).wrapping_add(q1));

        let t2 = offsets[i + 1].wrapping_add(y).rotate_left(16);
        let q2 = t2.wrapping_mul(0x1881CE3C);
        swap_last = q2.rotate_left(16).wrapping_mul(0x35BD1EC9).wrapping_add(q2);
        swap_acc = swap_acc.wrapping_add(swap_last);

        state = state.wrapping_mul(key_a).wrapping_add(x);
        state = state.rotate_left(16).wrapping_mul(0xCF98B111);
        state = state.rotate_left(16).wrapping_mul(0x87085B9F);
        state = state.rotate_left(16).wrapping_mul(0x12CEB96D);
        state = state.rotate_left(16).wrapping_mul(0x257E1D83);
        acc = acc.wrapping_add(state);

        let mut t = state.wrapping_mul(key_b).wrapping_add(y);
        t = t.rotate_left(16).wrapping_mul(0xA27416F5);
        t = t.rotate_left(16).wrapping_mul(0xD38396FF);
        state = t
            .rotate_left(16)
            .wrapping_mul(0x7C932B89)
            .rotate_left(16)
            .wrapping_mul(0xBFA49F69);
        acc = acc.wrapping_add(state);

        i += 2;
    }

    (swap_last ^ state, swap_acc ^ acc)
}

fn generate_sec_ms_gec_v2(unix_secs: u64) -> String {
    // Windows epoch offset (1601-01-01 to 1970-01-01) = 11,644,473,600 seconds
    let mut ticks_secs: u128 = (unix_secs as u128) + 11_644_473_600u128;
    ticks_secs -= ticks_secs % 300;
    let ticks_100ns = ticks_secs * 10_000_000u128;
    let payload = format!("{}{}", ticks_100ns, TRUSTED_CLIENT_TOKEN);
    let data = payload.as_bytes();
    let digest = custom_sha256_digest(data);
    let (w0, w1) = cs64_digest(data, &digest);
    let mut cs_bytes = [0u8; 8];
    cs_bytes[0..4].copy_from_slice(&w0.to_le_bytes());
    cs_bytes[4..8].copy_from_slice(&w1.to_le_bytes());
    let cs_hex: String = cs_bytes.iter().map(|b| format!("{:02X}", b)).collect();
    let sha_hex: String = digest.iter().map(|b| format!("{:02X}", b)).collect();
    format!("{}-{}", cs_hex, sha_hex)
}

fn generate_hex_id(salt: u64) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(salt.to_le_bytes());
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

fn percent_encode_utf8(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
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

fn format_edge_voice_name(voice: &str) -> String {
    let v = voice.trim();
    if v.starts_with("Microsoft Server Speech Text to Speech Voice") {
        return v.to_string();
    }
    let parts: Vec<&str> = v.split('-').collect();
    if parts.len() >= 3 {
        let locale = format!("{}-{}", parts[0], parts[1]);
        let name = parts[2..].join("-");
        format!("Microsoft Server Speech Text to Speech Voice ({}, {})", locale, name)
    } else {
        "Microsoft Server Speech Text to Speech Voice (th-TH, PremwadeeNeural)".to_string()
    }
}

fn format_js_utc_timestamp(unix_secs: u64) -> String {
    // Civil date from Unix days (Howard Hinnant's algorithm) -> JS Date UTC string
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    const DOW: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MON: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let dow = DOW[(days.rem_euclid(7)) as usize];
    let mon = MON[(month - 1) as usize];
    format!(
        "{} {} {:02} {:04} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        dow, mon, day, year, hour, min, sec
    )
}

fn voice_to_google_lang(voice: &str) -> &'static str {
    let v = voice.to_lowercase();
    if v.starts_with("en-") {
        "en"
    } else if v.starts_with("zh-") {
        "zh-CN"
    } else if v.starts_with("ja-") {
        "ja"
    } else if v.starts_with("ko-") {
        "ko"
    } else if v.starts_with("vi-") {
        "vi"
    } else if v.starts_with("id-") {
        "id"
    } else {
        "th"
    }
}

fn chunk_text_for_google(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0usize;

    for ch in text.chars() {
        current.push(ch);
        count += 1;
        let is_break = matches!(ch, ' ' | '\n' | '.' | ',' | '!' | '?' | '。' | '、' | ';' | ':');
        if (count >= max_chars) || (count >= max_chars.saturating_sub(25) && is_break) {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                chunks.push(trimmed);
            }
            current.clear();
            count = 0;
        }
    }
    let tail = current.trim().to_string();
    if !tail.is_empty() {
        chunks.push(tail);
    }
    chunks
}

// ---------------------------------------------------------------------------
// Tier 1: Microsoft Edge Neural TTS (Protocol v2 — Premwadee / Niwat / Multi-Lang)
// ---------------------------------------------------------------------------
async fn synthesize_edge_neural_mp3(
    text: &str,
    voice: &str,
    rate_pct: i32,
    pitch_hz: i32,
) -> Result<Vec<u8>, String> {
    let unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let conn_id = generate_hex_id(1);
    let req_id = generate_hex_id(2);
    let muid = generate_hex_id(3).to_uppercase();
    let gec = generate_sec_ms_gec_v2(unix_secs);

    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={}&ConnectionId={}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}",
        TRUSTED_CLIENT_TOKEN, conn_id, gec, SEC_MS_GEC_VERSION
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
        "Accept-Encoding",
        HeaderValue::from_static("gzip, deflate, br, zstd"),
    );
    headers.insert(
        "Accept-Language",
        HeaderValue::from_static("en-US,en;q=0.9"),
    );
    let ua = format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36 Edg/{}.0.0.0",
        CHROMIUM_MAJOR_VERSION, CHROMIUM_MAJOR_VERSION
    );
    if let Ok(v) = HeaderValue::from_str(&ua) {
        headers.insert("User-Agent", v);
    }
    if let Ok(v) = HeaderValue::from_str(&format!("muid={};", muid)) {
        headers.insert("Cookie", v);
    }
    let _ = CHROMIUM_FULL_VERSION;

    let (ws_stream, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .map_err(|_| "หมดเวลาเชื่อมต่อ Edge Neural Voice".to_string())?
    .map_err(|e| format!("เชื่อมต่อ Edge Neural Voice ไม่สำเร็จ: {}", e))?;

    let (mut write, mut read) = ws_stream.split();
    let ts_str = format_js_utc_timestamp(unix_secs);

    let config_msg = format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}\r\n",
        ts_str
    );
    write
        .send(Message::Text(config_msg))
        .await
        .map_err(|e| format!("ส่ง speech.config ไม่สำเร็จ: {}", e))?;

    let full_voice = format_edge_voice_name(voice);
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{}'><prosody pitch='{}' rate='{}' volume='+0%'>{}</prosody></voice></speak>",
        escape_xml(&full_voice),
        format_pitch(pitch_hz),
        format_rate(rate_pct),
        escape_xml(text)
    );
    let ssml_msg = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{}",
        req_id, ts_str, ssml
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
    if mp3_bytes.len() < 512 {
        return Err("ไม่ได้รับข้อมูลเสียงจาก Edge Neural Voice".to_string());
    }
    Ok(mp3_bytes)
}

// ---------------------------------------------------------------------------
// Tier 2: Google Cloud/Translate TTS Fallback (100% Thai & Multi-Language)
// ---------------------------------------------------------------------------
async fn synthesize_google_tts_mp3(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let lang = voice_to_google_lang(voice);
    let chunks = chunk_text_for_google(text, 160);
    if chunks.is_empty() {
        return Err("ข้อความว่างเปล่า".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("สร้าง HTTP client ไม่สำเร็จ: {}", e))?;

    let mut combined: Vec<u8> = Vec::new();
    for chunk in chunks {
        let url = format!(
            "https://translate.google.com/translate_tts?ie=UTF-8&tl={}&client=tw-ob&q={}",
            lang,
            percent_encode_utf8(&chunk)
        );
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("เชื่อมต่อ Google TTS ไม่สำเร็จ: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("Google TTS ตอบกลับ HTTP {}", resp.status().as_u16()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("อ่านเสียงจาก Google TTS ไม่สำเร็จ: {}", e))?;
        if bytes.len() < 256 {
            return Err("ข้อมูลเสียงจาก Google TTS ไม่สมบูรณ์".to_string());
        }
        combined.extend_from_slice(&bytes);
    }

    if combined.len() < 512 {
        return Err("ข้อมูลเสียงจาก Google TTS ว่างเปล่า".to_string());
    }
    Ok(combined)
}

// ---------------------------------------------------------------------------
// Tier 3: Offline OS Fallback (with strict non-silent file validation)
// ---------------------------------------------------------------------------
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
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (text, out_raw);
        return Err("ไม่รองรับ OS TTS fallback บนแพลตฟอร์มนี้".to_string());
    }

    // Silent-WAV Guard: Windows SAPI without Thai voice writes a 44–78 byte empty header!
    let meta = tokio::fs::metadata(out_raw)
        .await
        .map_err(|_| "ระบบเสียงออฟไลน์ไม่สร้างไฟล์เสียง".to_string())?;
    if meta.len() < MIN_VALID_AUDIO_BYTES {
        let _ = tokio::fs::remove_file(out_raw).await;
        return Err(
            "ระบบเสียงออฟไลน์ในเครื่องไม่รองรับภาษานี้ (ได้ไฟล์เสียงว่างเปล่า) กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต"
                .to_string(),
        );
    }
    Ok(())
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

    // Tier 1: Edge Neural TTS v2 (1x auto-retry on transient reset) → Tier 2: Google TTS → Tier 3: Validated OS Offline Fallback
    let edge_res = match synthesize_edge_neural_mp3(trimmed, chosen_voice, rate_pct, pitch_hz).await {
        Ok(b) => Ok(b),
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            synthesize_edge_neural_mp3(trimmed, chosen_voice, rate_pct, pitch_hz).await
        }
    };
    match edge_res {
        Ok(mp3_bytes) => {
            raw_path = proj_dir.join(format!("tts_{}_raw.mp3", ts));
            tokio::fs::write(&raw_path, &mp3_bytes)
                .await
                .map_err(|e| format!("เขียนไฟล์เสียงชั่วคราวไม่สำเร็จ: {}", e))?;
            engine_used = "edge-neural".to_string();
        }
        Err(edge_err) => match synthesize_google_tts_mp3(trimmed, chosen_voice).await {
            Ok(mp3_bytes) => {
                raw_path = proj_dir.join(format!("tts_{}_raw.mp3", ts));
                tokio::fs::write(&raw_path, &mp3_bytes)
                    .await
                    .map_err(|e| format!("เขียนไฟล์เสียงชั่วคราวไม่สำเร็จ: {}", e))?;
                engine_used = "google-tts".to_string();
            }
            Err(google_err) => {
                #[cfg(target_os = "macos")]
                let ext = "aiff";
                #[cfg(not(target_os = "macos"))]
                let ext = "wav";
                raw_path = proj_dir.join(format!("tts_{}_raw.{}", ts, ext));
                synthesize_os_fallback(trimmed, &raw_path).await.map_err(|os_err| {
                    format!(
                        "สร้างเสียงพากย์ไม่สำเร็จ (Edge: {} | Google: {} | Offline: {})",
                        edge_err, google_err, os_err
                    )
                })?;
                engine_used = "os-fallback".to_string();
            }
        },
    }

    let final_wav = proj_dir.join(format!("tts_{}.wav", ts));
    let ffmpeg = ffmpeg_engine::check_ffmpeg_info().await;
    if !ffmpeg.available || ffmpeg.path.is_empty() {
        let _ = tokio::fs::remove_file(&raw_path).await;
        return Err("ไม่พบ FFmpeg สำหรับแปลงไฟล์เสียงพากย์".to_string());
    }

    // Check raw duration for optional Auto Time-Fit (Subtitle-to-Dubbing)
    let raw_str = raw_path.to_string_lossy().to_string();
    let raw_dur = ffmpeg_engine::probe_media(&raw_str)
        .await
        .ok()
        .and_then(|p| p.duration_seconds)
        .unwrap_or(0.0);

    // Combine user speed for fallback engines + Auto Time-Fit into FFmpeg atempo
    let mut tempo: f64 = 1.0;
    if engine_used != "edge-neural" && rate_pct != 0 {
        tempo = (1.0 + (rate_pct as f64) / 100.0).clamp(0.65, 1.85);
    }
    if let Some(target_sec) = target_duration_sec {
        let eff_dur = if tempo > 0.1 { raw_dur / tempo } else { raw_dur };
        if target_sec > 0.35 && eff_dur > target_sec * 1.04 {
            let ratio = (eff_dur / target_sec).clamp(1.0, 1.55);
            tempo = (tempo * ratio).clamp(0.65, 1.95);
        }
    }

    let af_filter = if (tempo - 1.0).abs() > 0.02 {
        Some(format!("atempo={:.3}", tempo))
    } else {
        None
    };

    let final_str = final_wav.to_string_lossy().to_string();
    let mut cmd = tokio::process::Command::new(&ffmpeg.path);
    cmd.args(["-y", "-i", &raw_str]);
    if let Some(ref af) = af_filter {
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

    // Final Silent-WAV Guard: ensure output WAV has real audio payload
    let final_size = tokio::fs::metadata(&final_wav)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if final_size < MIN_VALID_AUDIO_BYTES {
        let _ = tokio::fs::remove_file(&final_wav).await;
        return Err("ไฟล์เสียงพากย์ที่สร้างว่างเปล่า กรุณาลองใหม่อีกครั้ง".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sec_ms_gec_v2_format() {
        let token = generate_sec_ms_gec_v2(1_764_040_000);
        let parts: Vec<&str> = token.split('-').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), 16);
        assert_eq!(parts[1].len(), 64);
    }
}
