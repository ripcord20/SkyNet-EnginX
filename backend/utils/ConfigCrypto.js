'use strict';

/**
 * ConfigCrypto
 * ─────────────────────────────────────────────────────────────────────
 * Transparent encryption-at-rest for runtime config files.
 *
 * Why: files like uploads/mikrotik_config.json and uploads/acs_config.json
 *      used to store `password` and SNMP `community` fields in plaintext on
 *      disk. An attacker with shell / LFI / backup access could read them.
 *
 * How: on save(), fields listed in SENSITIVE_FIELDS are wrapped as
 *      "enc:v1:<base64(iv|tag|ciphertext)>" using AES-256-GCM with a key
 *      derived (scrypt) from process.env.CONFIG_ENCRYPTION_KEY.
 *      On load(), anything prefixed "enc:v1:" is decrypted; plaintext
 *      values are returned as-is (backward compat with old files).
 *
 * Key management:
 *   - Set CONFIG_ENCRYPTION_KEY in .env (any length, at least 16 chars).
 *   - Losing the key = cannot decrypt saved configs; operator must
 *     re-enter the MikroTik/ACS passwords through the UI.
 *   - Rotating the key: set new key, load() each config (old enc will
 *     fail, but load returns plaintext-or-null), have operator re-save.
 *
 * Intentionally uses only node:crypto — no new npm dependency.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const ALGO            = 'aes-256-gcm';
const KEY_LEN         = 32;                // 256-bit
const IV_LEN          = 12;                // 96-bit, GCM standard
const TAG_LEN         = 16;
const MARKER          = 'enc:v1:';         // version prefix, for future algorithm swaps
const SALT            = 'digsnet-config-v1';  // fixed salt is fine: key is the secret

// Fields that should be encrypted on save. Keep the list narrow — we only
// want to encrypt *credentials*, not flags or ports, so decrypt failures
// don't brick routine config edits.
const SENSITIVE_FIELDS = new Set([
  'password', 'pass', 'secret', 'token', 'apiKey', 'api_key',
  'community',               // SNMP
  'snmpCommunity',           // SNMP community OLT management
  'enablePassword',          // OLT CLI privileged-mode password (ZTE)
]);

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY missing or too short (need >= 16 chars in .env). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  // scrypt stretches the user-supplied key into a uniform 32-byte key.
  cachedKey = crypto.scryptSync(raw, SALT, KEY_LEN);
  return cachedKey;
}

// ── Core primitives ──────────────────────────────────────────────────

function encryptString(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  // Already encrypted? Don't double-encrypt on re-save.
  if (plaintext.startsWith(MARKER)) return plaintext;

  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  // Format: base64( iv(12) | tag(16) | ciphertext )
  return MARKER + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptString(value) {
  if (typeof value !== 'string' || !value.startsWith(MARKER)) return value;
  try {
    const blob = Buffer.from(value.slice(MARKER.length), 'base64');
    const iv   = blob.subarray(0, IV_LEN);
    const tag  = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct   = blob.subarray(IV_LEN + TAG_LEN);
    const dec  = crypto.createDecipheriv(ALGO, getKey(), iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  } catch (e) {
    // Wrong key, tampered blob, or format change — don't crash the app,
    // but make sure the operator notices.
    logger.error('[ConfigCrypto] Decrypt failed — wrong CONFIG_ENCRYPTION_KEY?: ' + e.message);
    return '';  // treat as empty so UI prompts operator to re-enter
  }
}

// ── Recursive walk over a parsed config object ───────────────────────

function walk(value, transform) {
  if (Array.isArray(value)) return value.map(v => walk(v, transform));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_FIELDS.has(k) ? transform(value[k]) : walk(value[k], transform);
    }
    return out;
  }
  return value;
}

const encryptObject = (obj) => walk(obj, encryptString);
const decryptObject = (obj) => walk(obj, decryptString);

// ── Public API: drop-in for existing load/save patterns ──────────────

/**
 * Read a JSON config file and return the parsed object with sensitive
 * fields decrypted. Returns `fallback` if the file doesn't exist or is
 * malformed.
 */
function load(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return decryptObject(parsed);
  } catch (e) {
    logger.warn(`[ConfigCrypto] Failed to load ${path.basename(filePath)}: ${e.message}`);
    return fallback;
  }
}

/**
 * Serialize an object and write it to disk, with sensitive fields
 * encrypted. Creates the directory tree as needed.
 */
function save(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const encrypted = encryptObject(obj);
  fs.writeFileSync(filePath, JSON.stringify(encrypted, null, 2), 'utf8');
}

/**
 * Force re-encrypt an existing plaintext config file in place. Useful as
 * a one-time migration after deploying this module.
 */
function migrate(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const plain = load(filePath);
  if (!plain) return false;
  save(filePath, plain);
  return true;
}

module.exports = {
  load,
  save,
  migrate,
  // exported for tests / advanced usage
  _encryptString: encryptString,
  _decryptString: decryptString,
  _SENSITIVE_FIELDS: SENSITIVE_FIELDS,
};
