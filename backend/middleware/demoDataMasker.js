/**
 * demoDataMasker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Response masking otomatis untuk akun demo.
 *
 * Cara kerjanya:
 *   1. Pasang middleware ini SETELAH demoGuard.
 *   2. Middleware membungkus res.json sehingga semua response JSON ke demo
 *      user di-scan dan field sensitif di-mask.
 *   3. Skema masking: 2 char awal + bintang + 2 char akhir untuk string
 *      panjang, atau '***' untuk yang pendek.
 *
 * Kategori field yang dimasking:
 *   - Kredensial: password, secret, api_key, token, jwt
 *   - Kontak: phone, mobile, whatsapp, email (untuk customer)
 *   - Lokasi: address, lat, lng (boleh lihat tapi diacak presisinya)
 *   - Identitas: ktp, nik, nopol, akun_bank
 *   - Setting value: untuk AppSetting key yang mengandung kata sensitif
 */

// Field yang HARUS di-mask total (string)
const ALWAYS_MASK_FIELDS = new Set([
  // Kredensial
  'password', 'pass', 'passwd', 'pwd',
  'secret', 'secret_key', 'secretkey',
  'api_key', 'apikey', 'apiKey', 'api-key',
  'token', 'access_token', 'refresh_token', 'jwt',
  'private_key', 'privatekey',
  'client_secret', 'clientsecret',
  'webhook_secret', 'webhooksecret',
  'auth_token', 'authtoken',
  'session_secret',
  // SMTP / kredensial mail
  'smtp_password', 'smtp_pass', 'mail_password',
  // Mikrotik / OLT spesifik
  'rest_password', 'snmp_community', 'mikrotik_password',
]);

// Field yang di-mask sebagian (kelihatan struktur tapi tidak detail)
const PARTIAL_MASK_FIELDS = new Set([
  'phone', 'phone_number', 'mobile', 'whatsapp', 'wa_number', 'no_hp', 'nohp',
  'email', 'customer_email',
  'address', 'alamat', 'street_address',
  'ktp', 'nik', 'no_ktp', 'identity_number',
  'nopol', 'plat_nomor',
  'rekening', 'account_number', 'bank_account', 'no_rekening',
  'npwp',
]);

// Field identifier perangkat/interface — diganti dengan pseudonym konsisten.
// Contoh: "ether1-uplink-isp" → "iface-A1B2"
// Pseudonym konsisten artinya: input yang sama selalu menghasilkan output yang sama,
// jadi user demo masih bisa membedakan interface satu dengan lainnya, tapi tidak
// tahu nama aslinya.
const PSEUDONYM_FIELDS = new Set([
  // Mikrotik interface
  'interface', 'interface_name', 'iface', 'in_interface', 'out_interface',
  'master_port', 'master-interface',
  // Hotspot / PPPoE
  'caller_id', 'caller-id', 'called_id', 'called-id',
  'service_name', 'service-name',
  'session_id',
  // Mikrotik specific identifiers
  'mac_address', 'mac-address', 'gateway_mac',
  'queue_name', 'queue-name',
  // Server names (Mikrotik specific)
  'server', 'server_name', 'server-name',
  // Comment field di queue/firewall (sering berisi nama customer/lokasi)
  'comment',
]);

// Field koordinat: boleh tampil tapi diacak ke 2 desimal (~1km presisi)
const COORD_FIELDS = new Set(['lat', 'latitude', 'lng', 'lon', 'longitude']);

// Untuk model AppSetting yang pakai key-value, key yang valuenya harus di-mask
const SENSITIVE_SETTING_KEY_PATTERNS = [
  /password/i, /secret/i, /token/i, /api[_-]?key/i, /apikey/i,
  /webhook/i, /smtp[_-]?pass/i, /mail[_-]?pass/i, /private[_-]?key/i,
  /\bkey\b/i, /credential/i, /\bpass\b/i,
];

/**
 * Mask satu nilai string.
 * @param {string} val
 * @param {'full'|'partial'} mode
 */
function maskString(val, mode = 'full') {
  if (val == null) return val;
  const str = String(val);
  if (str.length === 0) return str;

  if (mode === 'full') {
    return '••••••••';
  }

  // Partial: tampilkan 2 awal + 2 akhir
  if (str.length <= 4) return '***';
  const head = str.slice(0, 2);
  const tail = str.slice(-2);
  const middle = '*'.repeat(Math.min(8, Math.max(3, str.length - 4)));
  return head + middle + tail;
}

/**
 * Pseudonym generator — konversi string ke alias konsisten.
 * Input yang sama selalu menghasilkan output yang sama dalam satu instance,
 * jadi user demo bisa membedakan dua interface tanpa tahu nama aslinya.
 *
 * Contoh:
 *   "ether1-uplink-isp"        → "iface-A1B2"
 *   "wlan1-hotspot-lt2"        → "iface-C3D4"
 *   "00:11:22:33:44:55"        → "mac-X9Y8"
 *
 * Pakai cache agar konsisten dalam runtime, dan deterministic hash supaya
 * konsisten antar request juga.
 */
const crypto = require('crypto');
const pseudonymCache = new Map();
const PSEUDONYM_CACHE_LIMIT = 5000; // cap memory

function pseudonym(val, prefix = 'item') {
  if (val == null) return val;
  const str = String(val);
  if (str.length === 0) return str;

  const cacheKey = prefix + ':' + str;
  if (pseudonymCache.has(cacheKey)) {
    return pseudonymCache.get(cacheKey);
  }

  // Cap cache supaya tidak grow indefinitely
  if (pseudonymCache.size >= PSEUDONYM_CACHE_LIMIT) {
    // Hapus 20% entry tertua (FIFO)
    const toDelete = Math.floor(PSEUDONYM_CACHE_LIMIT * 0.2);
    let i = 0;
    for (const k of pseudonymCache.keys()) {
      if (i++ >= toDelete) break;
      pseudonymCache.delete(k);
    }
  }

  // Deterministic hash → 4 char alfanumerik uppercase
  const hash = crypto.createHash('sha256').update(str).digest('hex');
  const code = hash.substring(0, 4).toUpperCase();
  const result = `${prefix}-${code}`;

  pseudonymCache.set(cacheKey, result);
  return result;
}

/**
 * Auto-detect prefix yang sesuai berdasarkan field name.
 */
function getPseudonymPrefix(fieldName) {
  const lk = fieldName.toLowerCase();
  if (lk.includes('mac')) return 'mac';
  if (lk.includes('queue')) return 'queue';
  if (lk.includes('server')) return 'srv';
  if (lk.includes('session')) return 'session';
  if (lk.includes('caller') || lk.includes('called')) return 'caller';
  if (lk.includes('comment')) return 'note';
  // default: interface
  return 'iface';
}

/**
 * Mask koordinat: bulatkan ke 2 desimal supaya tidak presisi.
 */
function maskCoord(val) {
  if (val == null) return val;
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  // Tambah random offset ~0.005 (~500m) supaya tidak bisa di-track persis
  const offset = (Math.random() - 0.5) * 0.01;
  return Math.round((num + offset) * 100) / 100;
}

/**
 * Cek apakah ini object AppSetting (punya field key & value).
 */
function isSettingRow(obj) {
  return obj &&
    typeof obj === 'object' &&
    typeof obj.key === 'string' &&
    'value' in obj;
}

/**
 * Cek apakah key setting termasuk sensitif.
 */
function isSensitiveSettingKey(key) {
  if (!key) return false;
  return SENSITIVE_SETTING_KEY_PATTERNS.some(re => re.test(key));
}

/**
 * Cek apakah path URL termasuk konteks Mikrotik (di mana field generic
 * seperti `name`, `username`, `comment` harus di-pseudonym).
 */
function isMikrotikContext(path) {
  if (!path) return false;
  return /\/(mikrotik|hotspot|pppoe|interface|traffic|queue|firewall|olt|genieacs|isolir)/i.test(path);
}

/**
 * Field tambahan yang di-pseudonym HANYA dalam konteks Mikrotik (URL match).
 * Field-field ini terlalu generic untuk di-mask global.
 */
const MIKROTIK_CONTEXT_FIELDS = new Set([
  'name',          // di mikrotik = interface name, di customer = nama orang
  'username',      // di mikrotik = pppoe/hotspot user, di app = login user
  'user',          // di mikrotik = active user di hotspot
  'profile',       // di mikrotik = pppoe profile, di app = bisa profile lain
  'target',        // di queue = IP/list, sensitif
  'host',          // bisa berisi DNS internal
]);

/**
 * Recursively mask object/array.
 * @param {*} node
 * @param {number} depth
 * @param {object} ctx — konteks request: { isMikrotik: boolean }
 */
function maskDeep(node, depth = 0, ctx = {}) {
  // Defensive: limit recursion depth
  if (depth > 10) return node;
  if (node == null) return node;

  // Array → map each item
  if (Array.isArray(node)) {
    return node.map(item => maskDeep(item, depth + 1, ctx));
  }

  // Primitive → return as-is
  if (typeof node !== 'object') return node;

  // Sequelize instance → unwrap kalau bisa
  if (typeof node.toJSON === 'function') {
    try {
      node = node.toJSON();
    } catch (_) { /* skip */ }
  }

  // Special: AppSetting row { key, value } — mask value berdasarkan key
  if (isSettingRow(node) && isSensitiveSettingKey(node.key)) {
    return { ...node, value: maskString(node.value, 'full') };
  }

  // Loop semua property
  const out = {};
  for (const k of Object.keys(node)) {
    const v = node[k];
    const lk = k.toLowerCase();

    if (ALWAYS_MASK_FIELDS.has(lk)) {
      out[k] = (v == null || v === '') ? v : maskString(v, 'full');
    } else if (PARTIAL_MASK_FIELDS.has(lk)) {
      out[k] = (v == null || v === '') ? v : maskString(v, 'partial');
    } else if (PSEUDONYM_FIELDS.has(lk)) {
      // Selalu pseudonym field-field yang spesifik mikrotik (interface, mac, dll)
      if (v == null || v === '') {
        out[k] = v;
      } else if (typeof v === 'string') {
        out[k] = pseudonym(v, getPseudonymPrefix(k));
      } else {
        out[k] = v;
      }
    } else if (ctx.isMikrotik && MIKROTIK_CONTEXT_FIELDS.has(lk)) {
      // Pseudonym hanya dalam konteks mikrotik (untuk field generic)
      if (v == null || v === '') {
        out[k] = v;
      } else if (typeof v === 'string') {
        out[k] = pseudonym(v, getPseudonymPrefix(k));
      } else {
        out[k] = v;
      }
    } else if (COORD_FIELDS.has(lk)) {
      out[k] = maskCoord(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = maskDeep(v, depth + 1, ctx);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Express middleware. Pasang di level app (sebelum routes).
 * Middleware ini wrap res.json secara LAZY — kalau saat res.json dipanggil
 * ternyata user adalah demo, baru masking dilakukan. Kalau bukan demo,
 * langsung pass-through ke res.json asli.
 *
 * Dengan begini middleware bisa dipasang di app-level tanpa harus berada
 * SETELAH authenticate — karena pengecekan dilakukan saat response keluar,
 * di mana authenticate pasti sudah jalan.
 */
function demoDataMasker(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    // Cek runtime: apakah user ini demo?
    const isDemo = req.user
      && req.user.role
      && typeof req.user.role.name === 'string'
      && req.user.role.name.toLowerCase() === 'demo';

    if (!isDemo) {
      return originalJson(body);
    }

    try {
      // Pass context: apakah ini endpoint mikrotik/hotspot/dll?
      const reqPath = req.path || req.originalUrl || '';
      const ctx = {
        isMikrotik: isMikrotikContext(reqPath),
      };
      const masked = maskDeep(body, 0, ctx);
      return originalJson(masked);
    } catch (err) {
      // Kalau masking error, tetap kirim respons asli (jangan break aplikasi)
      try {
        const logger = require('../utils/logger');
        logger.error('[DEMO-MASKER] Error masking response:', err.message);
      } catch (_) { /* logger optional */ }
      return originalJson(body);
    }
  };

  next();
}

module.exports = {
  demoDataMasker,
  maskDeep,
  maskString,
  pseudonym,
  isMikrotikContext,
  ALWAYS_MASK_FIELDS,
  PARTIAL_MASK_FIELDS,
  PSEUDONYM_FIELDS,
};
