#!/usr/bin/env node
/**
 * AutoSubAI Desktop — Signed UI Hot-Patch Builder & Keygen (Zero npm deps, Node 20+)
 *
 * Security Model:
 *   - Signs the exact DEFLATE ZIP bytes with Ed25519 (RFC 8032) + SHA-256 digest.
 *   - Private key lives strictly outside git in c:\Users\USER\project\vidio\.secrets\autosub_patch_ed25519.pem
 *   - Only the 32-byte Public Key hex is embedded in Rust (src-tauri/src/patch_engine.rs).
 *
 * Usage:
 *   node scripts/build_ui_patch.js --keygen
 *   node scripts/build_ui_patch.js --version 1.9.1+p1 --min-native 1.9.1 --notes "UI hotfix"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(DESKTOP_ROOT, 'ui');
const SECRETS_DIR = path.resolve(DESKTOP_ROOT, '..', '.secrets');
const PRIV_PEM_PATH = path.join(SECRETS_DIR, 'autosub_patch_ed25519.pem');
const PUB_HEX_PATH = path.join(SECRETS_DIR, 'autosub_patch_ed25519.pub.hex');
const OUT_DIR = path.resolve(DESKTOP_ROOT, '..', 'AutoSubAI', 'app', 'static', 'desktop-patches');
const PUBLIC_URL_BASE = 'https://www.thaiautosub.com/static/desktop-patches';

const ALLOWED_EXTS = new Set(['.html', '.css', '.js', '.json', '.svg', '.png']);

// Pure Node CRC32 table for standard ZIP archive creation
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries) {
  // entries: [{ name: 'index.html', data: Buffer }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0); // local file header sig
    localHdr.writeUInt16LE(20, 4);         // version needed
    localHdr.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    localHdr.writeUInt16LE(8, 8);          // method: deflate
    localHdr.writeUInt16LE(0, 10);         // mod time
    localHdr.writeUInt16LE(0x5421, 12);    // mod date
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(comp.length, 18);
    localHdr.writeUInt32LE(raw.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, comp);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0); // central dir sig
    centralHdr.writeUInt16LE(20, 4);         // version made by
    centralHdr.writeUInt16LE(20, 6);         // version needed
    centralHdr.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHdr.writeUInt16LE(8, 10);         // method: deflate
    centralHdr.writeUInt16LE(0, 12);         // mod time
    centralHdr.writeUInt16LE(0x5421, 14);    // mod date
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(comp.length, 20);
    centralHdr.writeUInt32LE(raw.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function collectUiFiles(dir, relBase = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      out.push(...collectUiFiles(full, rel));
    } else if (st.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_EXTS.has(ext)) {
        out.push({ name: rel, data: fs.readFileSync(full) });
      }
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keygen') out.keygen = true;
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--min-native') out.minNative = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

function runKeygen() {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  if (fs.existsSync(PRIV_PEM_PATH) && fs.existsSync(PUB_HEX_PATH)) {
    const pubHex = fs.readFileSync(PUB_HEX_PATH, 'utf8').trim();
    console.log('EXISTING_PUB_HEX=' + pubHex);
    return;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spkiDer.subarray(spkiDer.length - 32);
  const pubHex = rawPub.toString('hex');

  fs.writeFileSync(PRIV_PEM_PATH, privPem, { mode: 0o600 });
  fs.writeFileSync(PUB_HEX_PATH, pubHex + '\n');

  // Verify self-test
  const sample = Buffer.from('AutoSubAI-Ed25519-SelfTest');
  const sig = crypto.sign(null, sample, privateKey);
  const verified = crypto.verify(null, sample, publicKey, sig);
  if (!verified || sig.length !== 64 || rawPub.length !== 32) {
    throw new Error('Ed25519 self-test failed!');
  }
  console.log('GENERATED_PUB_HEX=' + pubHex);
  console.log('PRIV_PEM_PATH=' + PRIV_PEM_PATH);
}

function runBuild(args) {
  if (!fs.existsSync(PRIV_PEM_PATH)) {
    throw new Error(`Missing Ed25519 private key at ${PRIV_PEM_PATH}. Run --keygen first.`);
  }
  const tauriConf = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const nativeVer = tauriConf.version || '1.9.1';
  const patchVersion = args.version || `${nativeVer}+p0`;
  const minNative = args.minNative || nativeVer;
  const notes = args.notes || `AutoSubAI Desktop UI Patch ${patchVersion}`;
  const outDir = args.outDir ? path.resolve(args.outDir) : OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const entries = collectUiFiles(UI_DIR);
  if (!entries.some((e) => e.name === 'index.html')) {
    throw new Error('ui/index.html missing!');
  }

  const zipBuf = buildZipBuffer(entries);
  const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex');

  const privPem = fs.readFileSync(PRIV_PEM_PATH, 'utf8');
  const privateKey = crypto.createPrivateKey(privPem);
  const sigHex = crypto.sign(null, zipBuf, privateKey).toString('hex');

  // Double-check signature with public key
  const publicKey = crypto.createPublicKey(privateKey);
  const ok = crypto.verify(null, zipBuf, publicKey, Buffer.from(sigHex, 'hex'));
  if (!ok) throw new Error('Ed25519 signature verification failed!');

  const safeVerFile = patchVersion.replace(/[^a-zA-Z0-9._+-]/g, '_');
  const zipFilename = `ui-patch-${safeVerFile}.zip`;
  const zipPath = path.join(outDir, zipFilename);
  fs.writeFileSync(zipPath, zipBuf);

  const manifest = {
    schema: 1,
    patch_version: patchVersion,
    min_native_version: minNative,
    published_at: new Date().toISOString(),
    size_bytes: zipBuf.length,
    file_count: entries.length,
    sha256,
    ed25519_sig: sigHex,
    download_url: `${PUBLIC_URL_BASE}/${zipFilename}`,
    notes,
  };
  const manifestPath = path.join(outDir, 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(JSON.stringify({
    ok: true,
    patch_version: patchVersion,
    min_native_version: minNative,
    files: entries.length,
    zip_kb: Number((zipBuf.length / 1024).toFixed(1)),
    sha256,
    zip_path: zipPath,
    manifest_path: manifestPath,
  }, null, 2));
}

const args = parseArgs(process.argv);
if (args.keygen) runKeygen();
else runBuild(args);
