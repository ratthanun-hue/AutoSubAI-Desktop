use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// 32-byte Ed25519 Public Key for verifying AutoSubAI Desktop UI Hot-Patches.
/// Private key is kept strictly offline outside the repository.
const PATCH_PUBLIC_KEY_HEX: &str =
    "7e713631a041d5c69fe0d398233086ce789546308ee371f0ea8d1ae8eaa7406a";

const PATCH_MANIFEST_URL: &str =
    "https://www.thaiautosub.com/static/desktop-patches/latest.json";

const ALLOWED_DOWNLOAD_PREFIXES: &[&str] = &[
    "https://www.thaiautosub.com/static/desktop-patches/",
    "https://github.com/ratthanun-hue/AutoSubAI-Desktop/releases/download/",
];

const MAX_PATCH_ZIP_BYTES: usize = 10 * 1024 * 1024; // 10 MB hard safety cap (UI zip is ~220 KB)

const SCRIPT_BOOT_ORDER: &[&str] = &[
    "js/i18n.js",
    "js/waveform.js",
    "js/glossary.js",
    "js/local_projects.js",
    "js/studio.js",
    "js/split_merge.js",
    "js/pro_editor.js",
    "js/meeting.js",
    "app.js",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchManifest {
    pub patch_version: String,
    pub min_native_version: String,
    pub size_bytes: Option<u64>,
    pub sha256: String,
    pub ed25519_sig: String,
    pub download_url: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PatchState {
    patch_version: String,
    min_native_version: String,
    applied_at: u64,
    confirmed: bool,
    boot_attempts: u32,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hex_decode(hex_str: &str) -> Result<Vec<u8>, String> {
    let clean = hex_str.trim();
    if clean.len() % 2 != 0 {
        return Err("Invalid hex length".to_string());
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    let bytes = clean.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let pair = std::str::from_utf8(&bytes[i..i + 2]).map_err(|_| "Invalid UTF-8 hex")?;
        let b = u8::from_str_radix(pair, 16).map_err(|_| "Invalid hex byte")?;
        out.push(b);
    }
    Ok(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Parses "1.9.1" -> (1, 9, 1, 0) and "1.9.1+p2" -> (1, 9, 1, 2)
pub fn parse_patch_tuple(raw: &str) -> Option<(u32, u32, u32, u32)> {
    let trimmed = raw
        .trim()
        .trim_start_matches("desktop-v")
        .trim_start_matches('v');
    let mut plus_split = trimmed.splitn(2, '+');
    let base_raw = plus_split.next().unwrap_or("");
    let meta_raw = plus_split.next().unwrap_or("");

    let base_clean = base_raw.split('-').next().unwrap_or(base_raw);
    let parts: Vec<&str> = base_clean.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let maj: u32 = parts[0].parse().ok()?;
    let min: u32 = parts[1].parse().ok()?;
    let pat: u32 = parts[2].parse().ok()?;

    let patch_num: u32 = if !meta_raw.is_empty() {
        meta_raw
            .trim_start_matches('p')
            .trim_start_matches('P')
            .parse()
            .unwrap_or(0)
    } else {
        0
    };
    Some((maj, min, pat, patch_num))
}

fn parse_native_tuple(raw: &str) -> Option<(u32, u32, u32)> {
    let (a, b, c, _) = parse_patch_tuple(raw)?;
    Some((a, b, c))
}

fn patch_root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("ไม่สามารถเข้าถึงโฟลเดอร์ AppData ได้: {}", e))?;
    let dir = base.join("ui_patch");
    std::fs::create_dir_all(&dir).map_err(|e| format!("สร้างโฟลเดอร์ ui_patch ไม่สำเร็จ: {}", e))?;
    Ok(dir)
}

fn read_state(root: &Path) -> Option<PatchState> {
    let p = root.join("state.json");
    let raw = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_state(root: &Path, st: &PatchState) -> Result<(), String> {
    let p = root.join("state.json");
    let tmp = root.join("state.json.tmp");
    let data = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_patch_dir(root: &Path) {
    let _ = std::fs::remove_dir_all(root.join("current"));
    let _ = std::fs::remove_dir_all(root.join("staging"));
    let _ = std::fs::remove_file(root.join("state.json"));
}

fn verify_ed25519_and_sha256(
    zip_bytes: &[u8],
    expected_sha256: &str,
    expected_sig_hex: &str,
) -> Result<(), String> {
    // 1. Verify SHA-256 digest
    let actual_sha = hex_encode(&Sha256::digest(zip_bytes));
    if actual_sha != expected_sha256.trim().to_lowercase() {
        return Err("ตรวจสอบ SHA-256 ของไฟล์ Patch ไม่ผ่าน (ไฟล์อาจเสียหาย)".to_string());
    }

    // 2. Verify Ed25519 cryptographic signature against embedded Public Key
    let pub_bytes = hex_decode(PATCH_PUBLIC_KEY_HEX)?;
    let pub_arr: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| "Public Key ในแอปไม่ถูกต้อง".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&pub_arr)
        .map_err(|_| "ไม่สามารถโหลด Ed25519 Public Key ได้".to_string())?;

    let sig_bytes = hex_decode(expected_sig_hex)
        .map_err(|_| "รูปแบบลายเซ็น Ed25519 ไม่ถูกต้อง".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "ความยาวลายเซ็น Ed25519 ต้องเป็น 64 ไบต์".to_string())?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify_strict(zip_bytes, &signature)
        .map_err(|_| "⛔ ปฏิเสธ Patch: ลายเซ็นดิจิทัล Ed25519 ไม่ถูกต้อง!".to_string())?;

    Ok(())
}

fn is_allowed_patch_entry(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains(':') || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("Blocked unsafe zip path: {}", rel));
    }
    let normalized = rel.replace('\\', "/");
    let p = Path::new(&normalized);
    let mut clean = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => clean.push(seg),
            _ => return Err(format!("Blocked path traversal entry: {}", rel)),
        }
    }
    let ext = clean
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !matches!(
        ext.as_str(),
        "html" | "css" | "js" | "json" | "svg" | "png"
    ) {
        return Err(format!("Blocked disallowed file type in patch: {}", rel));
    }
    Ok(clean)
}

fn extract_zip_safely(zip_bytes: &[u8], staging_dir: &Path) -> Result<usize, String> {
    let _ = std::fs::remove_dir_all(staging_dir);
    std::fs::create_dir_all(staging_dir).map_err(|e| e.to_string())?;

    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("ไม่สามารถเปิดไฟล์ ZIP Patch ได้: {}", e))?;

    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("อ่านไฟล์ใน ZIP ไม่สำเร็จ: {}", e))?;
        if file.is_dir() {
            continue;
        }
        let rel = is_allowed_patch_entry(file.name())?;
        let out_path = staging_dir.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("แตกไฟล์ {} ไม่สำเร็จ: {}", file.name(), e))?;
        std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        count += 1;
    }

    if !staging_dir.join("index.html").is_file() || !staging_dir.join("app.js").is_file() {
        return Err("Patch ไม่สมบูรณ์ (ไม่พบ index.html หรือ app.js)".to_string());
    }
    Ok(count)
}

pub async fn check_ui_patch_update(app: &AppHandle) -> Result<Value, String> {
    let native_ver = env!("CARGO_PKG_VERSION");
    let native_tuple = parse_native_tuple(native_ver).unwrap_or((0, 0, 0));
    let built_in_patch_tuple = (native_tuple.0, native_tuple.1, native_tuple.2, 0u32);

    let root = patch_root_dir(app)?;
    let active_state = read_state(&root);
    let active_patch_ver = active_state
        .as_ref()
        .map(|s| s.patch_version.clone())
        .unwrap_or_default();
    let active_tuple = parse_patch_tuple(&active_patch_ver).unwrap_or(built_in_patch_tuple);
    let effective_tuple = if active_tuple > built_in_patch_tuple {
        active_tuple
    } else {
        built_in_patch_tuple
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("AutoSubAI-Desktop-Patcher")
        .build()
        .map_err(|e| e.to_string())?;

    let cache_bust = format!("{}?t={}", PATCH_MANIFEST_URL, now_unix());
    let res = match client.get(&cache_bust).send().await {
        Ok(r) => r,
        Err(_) => {
            return Ok(json!({
                "has_patch": false,
                "native_version": native_ver,
                "active_patch_version": active_patch_ver
            }));
        }
    };

    if !res.status().is_success() {
        return Ok(json!({
            "has_patch": false,
            "native_version": native_ver,
            "active_patch_version": active_patch_ver
        }));
    }

    let manifest: PatchManifest = match res.json().await {
        Ok(m) => m,
        Err(_) => {
            return Ok(json!({
                "has_patch": false,
                "native_version": native_ver,
                "active_patch_version": active_patch_ver
            }));
        }
    };

    let min_native = parse_native_tuple(&manifest.min_native_version).unwrap_or((999, 0, 0));
    let remote_tuple = match parse_patch_tuple(&manifest.patch_version) {
        Some(t) => t,
        None => {
            return Ok(json!({
                "has_patch": false,
                "native_version": native_ver,
                "active_patch_version": active_patch_ver
            }));
        }
    };

    // Compatible only if current native binary >= min_native_version
    // and remote patch version is strictly newer than current effective version
    let compatible = native_tuple >= min_native;
    let is_newer = remote_tuple > effective_tuple;

    if compatible && is_newer {
        return Ok(json!({
            "has_patch": true,
            "native_version": native_ver,
            "active_patch_version": active_patch_ver,
            "patch_version": manifest.patch_version,
            "min_native_version": manifest.min_native_version,
            "size_bytes": manifest.size_bytes.unwrap_or(0),
            "sha256": manifest.sha256,
            "ed25519_sig": manifest.ed25519_sig,
            "download_url": manifest.download_url,
            "notes": manifest.notes.unwrap_or_default()
        }));
    }

    Ok(json!({
        "has_patch": false,
        "native_version": native_ver,
        "active_patch_version": active_patch_ver,
        "requires_native_upgrade": !compatible && is_newer
    }))
}

pub async fn apply_ui_patch(
    app: &AppHandle,
    manifest: PatchManifest,
) -> Result<Value, String> {
    // 1. Validate HTTPS allowlist
    let allowed = ALLOWED_DOWNLOAD_PREFIXES
        .iter()
        .any(|prefix| manifest.download_url.starts_with(prefix));
    if !allowed {
        return Err("⛔ ปฏิเสธ Patch: URL ดาวน์โหลดไม่อยู่ในแหล่งที่ได้รับอนุญาต".to_string());
    }

    let native_ver = env!("CARGO_PKG_VERSION");
    let native_tuple = parse_native_tuple(native_ver).unwrap_or((0, 0, 0));
    let min_native = parse_native_tuple(&manifest.min_native_version)
        .ok_or_else(|| "min_native_version ไม่ถูกต้อง".to_string())?;
    if native_tuple < min_native {
        return Err(format!(
            "Patch นี้ต้องใช้แอปเวอร์ชันฐาน v{} ขึ้นไป กรุณาอัปเดตตัวติดตั้งหลักก่อนครับ",
            manifest.min_native_version
        ));
    }

    // 2. Download zip (~220 KB)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("AutoSubAI-Desktop-Patcher")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(&manifest.download_url)
        .send()
        .await
        .map_err(|e| format!("ดาวน์โหลด Patch ไม่สำเร็จ: {}", e))?;
    if !res.status().is_success() {
        return Err(format!(
            "ดาวน์โหลด Patch ไม่สำเร็จ (HTTP {})",
            res.status().as_u16()
        ));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("อ่านข้อมูล Patch ไม่สำเร็จ: {}", e))?;
    if bytes.is_empty() || bytes.len() > MAX_PATCH_ZIP_BYTES {
        return Err("ขนาดไฟล์ Patch เกินขีดจำกัดความปลอดภัย".to_string());
    }

    // 3. Cryptographic verification (SHA-256 + Ed25519)
    verify_ed25519_and_sha256(&bytes, &manifest.sha256, &manifest.ed25519_sig)?;

    // 4. Safe zip extraction to staging + atomic swap to current/
    let root = patch_root_dir(app)?;
    let staging = root.join("staging");
    let current = root.join("current");
    let backup = root.join("backup");

    let file_count = extract_zip_safely(&bytes, &staging)?;

    let _ = std::fs::remove_dir_all(&backup);
    if current.exists() {
        std::fs::rename(&current, &backup)
            .map_err(|e| format!("สำรอง Patch เดิมไม่สำเร็จ: {}", e))?;
    }
    if let Err(e) = std::fs::rename(&staging, &current) {
        // Restore backup on rename failure
        if backup.exists() {
            let _ = std::fs::rename(&backup, &current);
        }
        return Err(format!("สลับโฟลเดอร์ Patch ไม่สำเร็จ: {}", e));
    }
    let _ = std::fs::remove_dir_all(&backup);

    // 5. Write unconfirmed boot watchdog state
    let st = PatchState {
        patch_version: manifest.patch_version.clone(),
        min_native_version: manifest.min_native_version.clone(),
        applied_at: now_unix(),
        confirmed: false,
        boot_attempts: 0,
    };
    write_state(&root, &st)?;

    Ok(json!({
        "applied": true,
        "patch_version": manifest.patch_version,
        "file_count": file_count,
        "size_bytes": bytes.len()
    }))
}

/// Called by the same-origin Bootloader in ui/index.html on startup (~8ms local disk read).
/// Implements Zero-Brick Boot Watchdog: auto-rolls back if an unconfirmed patch fails to boot twice.
pub fn get_active_ui_patch_bundle(app: &AppHandle) -> Result<Value, String> {
    let root = patch_root_dir(app)?;
    let current = root.join("current");
    let mut st = match read_state(&root) {
        Some(s) if current.join("index.html").is_file() => s,
        _ => return Ok(json!({ "active": false })),
    };

    let native_ver = env!("CARGO_PKG_VERSION");
    let native_tuple = parse_native_tuple(native_ver).unwrap_or((0, 0, 0));
    let built_in_tuple = (native_tuple.0, native_tuple.1, native_tuple.2, 0u32);
    let patch_tuple = match parse_patch_tuple(&st.patch_version) {
        Some(t) => t,
        None => {
            clear_patch_dir(&root);
            return Ok(json!({ "active": false }));
        }
    };

    // If user installed a newer native binary, retire the older UI patch automatically
    if patch_tuple <= built_in_tuple {
        clear_patch_dir(&root);
        return Ok(json!({ "active": false, "retired_older_patch": true }));
    }

    // Zero-Brick Boot Watchdog: if unconfirmed and already attempted >= 2 times, roll back!
    if !st.confirmed {
        if st.boot_attempts >= 2 {
            clear_patch_dir(&root);
            return Ok(json!({ "active": false, "rolled_back": true }));
        }
        st.boot_attempts += 1;
        let _ = write_state(&root, &st);
    }

    let html = match std::fs::read_to_string(current.join("index.html")) {
        Ok(s) => s,
        Err(_) => {
            clear_patch_dir(&root);
            return Ok(json!({ "active": false, "rolled_back": true }));
        }
    };
    let css = std::fs::read_to_string(current.join("style.css")).unwrap_or_default();

    let mut scripts: Vec<Value> = Vec::new();
    for rel in SCRIPT_BOOT_ORDER {
        let p = current.join(rel);
        if let Ok(code) = std::fs::read_to_string(&p) {
            scripts.push(json!({ "src": rel, "code": code }));
        }
    }

    Ok(json!({
        "active": true,
        "patch_version": st.patch_version,
        "confirmed": st.confirmed,
        "html": html,
        "css": css,
        "scripts": scripts
    }))
}

pub fn confirm_ui_patch_boot(app: &AppHandle) -> Result<bool, String> {
    let root = patch_root_dir(app)?;
    if let Some(mut st) = read_state(&root) {
        if !st.confirmed || st.boot_attempts != 0 {
            st.confirmed = true;
            st.boot_attempts = 0;
            write_state(&root, &st)?;
        }
        return Ok(true);
    }
    Ok(false)
}

pub fn rollback_ui_patch(app: &AppHandle) -> Result<bool, String> {
    let root = patch_root_dir(app)?;
    clear_patch_dir(&root);
    Ok(true)
}
