/**
 * WAService.js - Baileys Multi Session Manager
 */

let makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Boom, Browsers;
let baileysReady = false;

try {
  const baileys = require('@whiskeysockets/baileys');
  makeWASocket              = baileys.default;
  DisconnectReason          = baileys.DisconnectReason;
  useMultiFileAuthState     = baileys.useMultiFileAuthState;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  Browsers                  = baileys.Browsers;
  Boom = require('@hapi/boom').Boom;
  baileysReady = true;
} catch (e) {
  console.error('[WAService] Baileys tidak tersedia:', e.message);
}

const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');

// Cocokkan pesan masuk dgn keyword auto-reply. keyword bisa berisi BEBERAPA
// kata dipisah koma (mis. "terimakasih, makasih, mksih") — pesan cocok bila
// mengandung/sama dengan/berawalan SALAH SATU kata tsb.
function matchAutoReply(text, keyword, matchType) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;
  const words = String(keyword || '')
    .toLowerCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!words.length) return false;
  return words.some(kw =>
    matchType === 'exact' ? lower === kw
      : matchType === 'startswith' ? lower.startsWith(kw)
      : lower.includes(kw)
  );
}

const sessions = new Map();  // sessionId -> sock
const qrStore  = new Map();  // sessionId -> { raw, image, timestamp }

// ── Store pesan keluar untuk melayani RETRY dekripsi penerima ──────────────
// Penyebab "Waiting for this message" di HP penerima: device penerima gagal
// dekripsi lalu kirim retry-receipt minta pesan dikirim ULANG. Baileys melayani
// itu lewat callback getMessage(key) → harus mengembalikan isi message asli.
// Tanpa store ini, retry tidak bisa dipenuhi → pesan stuck "Waiting" selamanya.
//
// v2 — PERSISTENT STORE:
// Sebelumnya store hanya in-memory → hilang saat PM2 restart/reload, sehingga
// retry-receipt yang datang SETELAH restart tidak bisa dilayani. Sekarang:
//   • Entri: sessionId|messageId → { c: content(proto), t: timestamp }
//   • Disimpan ke uploads/wa_msgstore/msgstore.json (debounced 2 dtk, atomic
//     write via file .tmp + rename) supaya broadcast besar tidak IO per-pesan.
//   • Serialisasi pakai BufferJSON dari Baileys — payload media mengandung
//     Buffer (mediaKey, fileSha256, dst) yang korup jika JSON.stringify biasa.
//   • Prune: entri > MSG_STORE_TTL (default 7 hari) dibuang saat load & save;
//     LRU cap MAX_MSG_STORE (default 5000, override via env WA_MSG_STORE_MAX).
//   • Flush sinkron saat SIGINT/SIGTERM (PM2 kirim SIGINT saat restart).
const msgStore = new Map();
const MAX_MSG_STORE = parseInt(process.env.WA_MSG_STORE_MAX || '5000');
const MSG_STORE_TTL = parseInt(process.env.WA_MSG_STORE_TTL_MS || String(7 * 24 * 60 * 60 * 1000)); // 7 hari

const MSG_STORE_DIR  = path.join(__dirname, '../../uploads/wa_msgstore');
const MSG_STORE_FILE = path.join(MSG_STORE_DIR, 'msgstore.json');

// BufferJSON dari Baileys (replacer/reviver untuk Buffer di dalam proto message).
// Fallback manual kalau versi Baileys tidak meng-export-nya.
let BufferJSON = null;
try { BufferJSON = require('@whiskeysockets/baileys').BufferJSON; } catch (_) {}
if (!BufferJSON || !BufferJSON.replacer) {
  BufferJSON = {
    replacer: (k, v) => {
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        return { type: 'Buffer', data: Buffer.from(v).toString('base64') };
      }
      // JSON.stringify sudah memanggil .toJSON() Buffer lebih dulu → bentuk {type:'Buffer',data:[..]}
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
        return { type: 'Buffer', data: Buffer.from(v.data).toString('base64') };
      }
      return v;
    },
    reviver: (k, v) => {
      if (v && v.type === 'Buffer') {
        return typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : Buffer.from(v.data || []);
      }
      return v;
    },
  };
}

// Buang entri kadaluarsa + enforce cap (Map mempertahankan urutan insertion → LRU).
function pruneMsgStore() {
  const now = Date.now();
  for (const [k, v] of msgStore) {
    if (!v || !v.t || (now - v.t) > MSG_STORE_TTL) msgStore.delete(k);
  }
  while (msgStore.size > MAX_MSG_STORE) {
    const firstKey = msgStore.keys().next().value;
    if (firstKey === undefined) break;
    msgStore.delete(firstKey);
  }
}

// Tulis store ke disk secara atomic (tmp + rename) agar file tidak korup
// jika proses mati di tengah write.
function flushMsgStoreSync() {
  try {
    if (!fs.existsSync(MSG_STORE_DIR)) fs.mkdirSync(MSG_STORE_DIR, { recursive: true });
    pruneMsgStore();
    const obj = {};
    for (const [k, v] of msgStore) obj[k] = v;
    const tmp = MSG_STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, BufferJSON.replacer));
    fs.renameSync(tmp, MSG_STORE_FILE);
  } catch (e) {
    logger.warn('[WA] Gagal flush msgstore: ' + e.message);
  }
}

// Debounce: kumpulkan banyak putSentMessage dalam 2 dtk jadi 1 kali write.
let _msgStoreSaveTimer = null;
function scheduleMsgStoreSave() {
  if (_msgStoreSaveTimer) return;
  _msgStoreSaveTimer = setTimeout(() => {
    _msgStoreSaveTimer = null;
    flushMsgStoreSync();
  }, 2000);
  // Jangan tahan proses tetap hidup hanya karena timer ini.
  if (_msgStoreSaveTimer.unref) _msgStoreSaveTimer.unref();
}

// Load store dari disk saat modul start (sebelum restoreAllSessions jalan),
// supaya retry-receipt untuk pesan yang dikirim SEBELUM restart tetap terlayani.
(function loadMsgStore() {
  try {
    if (!fs.existsSync(MSG_STORE_FILE)) return;
    const raw = fs.readFileSync(MSG_STORE_FILE, 'utf8');
    if (!raw || !raw.trim()) return;
    const obj = JSON.parse(raw, BufferJSON.reviver);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && v.c) msgStore.set(k, v);
    }
    pruneMsgStore();
    logger.info('[WA] msgstore loaded: ' + msgStore.size + ' pesan (persist anti-"Waiting")');
  } catch (e) {
    logger.warn('[WA] msgstore korup/gagal load, mulai kosong: ' + e.message);
    try { fs.rmSync(MSG_STORE_FILE, { force: true }); } catch (_) {}
  }
})();

// Flush terakhir saat proses dihentikan (PM2 restart/reload → SIGINT).
// Pakai flag agar tidak double-flush jika beberapa signal datang beruntun.
let _msgStoreFlushed = false;
function _finalFlush() {
  if (_msgStoreFlushed) return;
  _msgStoreFlushed = true;
  if (_msgStoreSaveTimer) { clearTimeout(_msgStoreSaveTimer); _msgStoreSaveTimer = null; }
  flushMsgStoreSync();
}
// SIGTERM: server.js sudah punya graceful-shutdown handler yang akan exit
// sendiri — di sini HANYA flush (sinkron, cepat), JANGAN process.exit()
// supaya tidak memotong cleanup async (sequelize.close, cron stop, dll).
process.once('SIGTERM', () => { _finalFlush(); });
// SIGINT: tidak ada handler lain di aplikasi → default-nya proses langsung
// mati. Kita replikasi perilaku itu + flush dulu.
process.once('SIGINT',  () => { _finalFlush(); process.exit(0); });
// Jaring pengaman terakhir (handler 'exit' harus 100% sinkron — sudah).
process.once('exit',    () => { _finalFlush(); });

function putSentMessage(sessionId, messageId, content) {
  if (!messageId || !content) return;
  if (msgStore.size >= MAX_MSG_STORE) {
    // buang entri terlama (Map mempertahankan urutan insertion)
    const firstKey = msgStore.keys().next().value;
    if (firstKey !== undefined) msgStore.delete(firstKey);
  }
  msgStore.set(sessionId + '|' + messageId, { c: content, t: Date.now() });
  scheduleMsgStoreSave();
}

function getSentMessage(sessionId, messageId) {
  const v = msgStore.get(sessionId + '|' + messageId);
  return v ? v.c : undefined;
}

// Hapus semua entri milik satu session (dipanggil saat logout permanen —
// setelah creds dihapus, message ID lama tidak lagi valid untuk retry).
function clearMsgStoreForSession(sessionId) {
  const prefix = sessionId + '|';
  for (const k of msgStore.keys()) {
    if (k.startsWith(prefix)) msgStore.delete(k);
  }
  scheduleMsgStoreSave();
}

// Cache penghitung retry per-pesan (dipakai Baileys agar tidak retry tanpa batas).
// sessionId-scoped Map sederhana yang meniru interface node-cache (get/set/del).
function makeRetryCounterCache() {
  const m = new Map();
  return {
    get:  (k) => m.get(k),
    set:  (k, v) => { m.set(k, v); },
    del:  (k) => { m.delete(k); },
    flushAll: () => m.clear(),
  };
}

// ── Versi protokol WhatsApp Web (PENTING untuk "Waiting for this message") ──
// WhatsApp menolak / salah-enkripsi koneksi yang pakai versi protokol usang.
// fetchLatestBaileysVersion() hanya mengembalikan versi yang di-hardcode di paket
// Baileys terinstall — kalau paket sudah lama, versinya ikut usang → pesan sampai
// ke server tapi penerima lihat "Waiting for this message".
// Solusi: ambil versi LIVE dari web.whatsapp.com (selalu terkini), cache 1 jam.
// Fallback berlapis: (1) web.whatsapp.com → (2) fetchLatestBaileysVersion →
// (3) versi terbaru yang diketahui saat patch ini dibuat.
const KNOWN_GOOD_WA_VERSION = [2, 3000, 1040971408]; // per Jun 2026; update berkala
let _waVersionCache = null;     // { version: number[], ts: number }
const WA_VERSION_TTL = 60 * 60 * 1000; // 1 jam

// ── Pengaturan throttle broadcast (anti-restriction nomor pengirim) ─────────
// Tujuan: meniru pola kirim manusiawi supaya nomor gateway tidak kena soft-ban.
// Bisa di-override via environment variable tanpa ubah kode.
const BROADCAST_CFG = {
  // Jeda acak antar pesan (ms) — TIDAK fixed supaya tidak terdeteksi pola bot
  minDelayMs:   parseInt(process.env.WA_BC_MIN_DELAY  || '4000'),   // min 4 detik
  maxDelayMs:   parseInt(process.env.WA_BC_MAX_DELAY  || '12000'),  // max 12 detik
  // Setelah sekian pesan, istirahat lebih lama (jeda batch)
  batchSize:    parseInt(process.env.WA_BC_BATCH_SIZE || '20'),     // tiap 20 pesan
  batchPauseMinMs: parseInt(process.env.WA_BC_BATCH_PAUSE_MIN || '60000'),   // 1 menit
  batchPauseMaxMs: parseInt(process.env.WA_BC_BATCH_PAUSE_MAX || '180000'),  // 3 menit
  // Simulasi "sedang mengetik" sebelum kirim (presence) — terlihat lebih natural
  simulateTyping: (process.env.WA_BC_TYPING || '1') === '1',
  typingMinMs:  parseInt(process.env.WA_BC_TYPING_MIN || '1200'),
  typingMaxMs:  parseInt(process.env.WA_BC_TYPING_MAX || '3500'),
};

// Helper: angka acak dalam rentang [min, max]
function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWhatsAppWebVersion() {
  // Pakai cache kalau masih segar
  if (_waVersionCache && (Date.now() - _waVersionCache.ts) < WA_VERSION_TTL) {
    return _waVersionCache.version;
  }
  // 1) Coba ambil versi live dari web.whatsapp.com
  try {
    const https = require('https');
    const html = await new Promise((resolve, reject) => {
      const req = https.get('https://web.whatsapp.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; if (data.length > 200000) req.destroy(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    // Cari pola "x.y.zzzzzzz" di HTML (mis. 2.3000.1040971408)
    const m = html.match(/(\d+)\.(\d+)\.(\d{7,})/);
    if (m) {
      const v = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      _waVersionCache = { version: v, ts: Date.now() };
      logger.info('[WA] WA Web version (live): ' + v.join('.'));
      return v;
    }
  } catch (e) {
    logger.warn('[WA] Gagal ambil versi live WA Web: ' + e.message);
  }
  // 2) Fallback: fetchLatestBaileysVersion (dari paket)
  try {
    const result = await fetchLatestBaileysVersion();
    if (result && Array.isArray(result.version)) {
      // Bandingkan dgn KNOWN_GOOD — pakai yang lebih tinggi (build number ke-3)
      const pkg = result.version;
      const chosen = (pkg[2] || 0) >= KNOWN_GOOD_WA_VERSION[2] ? pkg : KNOWN_GOOD_WA_VERSION;
      _waVersionCache = { version: chosen, ts: Date.now() };
      logger.info('[WA] WA Web version (baileys/fallback): ' + chosen.join('.'));
      return chosen;
    }
  } catch (e) {
    logger.warn('[WA] fetchLatestBaileysVersion gagal: ' + e.message);
  }
  // 3) Fallback terakhir: versi known-good
  logger.warn('[WA] Pakai KNOWN_GOOD_WA_VERSION: ' + KNOWN_GOOD_WA_VERSION.join('.'));
  return KNOWN_GOOD_WA_VERSION;
}

const AUTH_DIR = path.join(__dirname, '../../uploads/wa_auth');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

function getAuthDir(sid) {
  const d = path.join(AUTH_DIR, sid);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function clearStaleAuth(sessionId) {
  const authDir = getAuthDir(sessionId);
  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    // creds dengan registered: false = belum pernah berhasil login, harus dihapus
    if (creds.registered === false) {
      logger.warn('[WA] Detected stale/unregistered creds for ' + sessionId + ', clearing auth dir...');
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
      return true;
    }
  } catch (e) {
    // creds.json korup, hapus juga
    logger.warn('[WA] Corrupt creds.json for ' + sessionId + ', clearing...');
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.mkdirSync(authDir, { recursive: true });
    return true;
  }
  return false;
}

async function createSession(sessionId, io, onMessage, isReconnect) {
  if (!baileysReady) {
    logger.error('[WA] Baileys belum terinstall');
    if (io) io.emit('wa:status:' + sessionId, { status: 'disconnected' });
    return null;
  }
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  // JAGA: jangan pernah jalankan Baileys utk session provider WAHA/Fonnte.
  // Kalau terpanggil (mis. dari jalur lama), berhenti diam-diam TANPA notifikasi
  // agar tidak memicu spam "Session Terputus" + loop reconnect.
  try {
    const { WaSession } = require('../models');
    const row = await WaSession.findOne({ where: { session_id: sessionId }, attributes: ['provider'] });
    const prov = row && row.provider ? String(row.provider).toLowerCase() : 'baileys';
    if (prov === 'waha' || prov === 'fonnte') {
      logger.info('[WA] Lewati createSession utk provider ' + prov + ' (' + sessionId + ') — dikelola layanan lain.');
      return null;
    }
  } catch (_) { /* kalau gagal cek, lanjut sbg Baileys (perilaku default lama) */ }

  // Bersihkan creds stale sebelum mulai — hanya saat fresh start, bukan saat reconnect setelah scan
  if (!isReconnect) clearStaleAuth(sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(getAuthDir(sessionId));
  let version;
  try {
    version = await getWhatsAppWebVersion();
  } catch (e) {
    logger.warn('[WA] Gagal resolve versi WA, pakai known-good: ' + e.message);
    version = KNOWN_GOOD_WA_VERSION;
  }
  logger.info('[WA] Starting session ' + sessionId + ' v' + version.join('.'));

  // Retry counter cache untuk sesi ini (lihat makeRetryCounterCache).
  const retryCache = makeRetryCounterCache();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
    // Cache hitungan retry supaya Baileys bisa mengelola retry-receipt dgn benar.
    msgRetryCounterCache: retryCache,
    // INTI PERBAIKAN "Waiting for this message":
    // Saat penerima gagal dekripsi & minta resend, Baileys panggil getMessage(key).
    // Kita kembalikan isi pesan dari msgStore. Kalau tidak ada (mis. setelah
    // restart & pesan sudah lewat), kembalikan undefined — Baileys akan kirim
    // placeholder, tetap lebih baik daripada stuck tanpa balasan retry.
    getMessage: async (key) => {
      try {
        const content = getSentMessage(sessionId, key.id);
        if (content) return content;
      } catch (_) {}
      return undefined;
    },
  });

  sessions.set(sessionId, sock);

  let isNewLogin = false; // track apakah QR baru saja di-scan

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (update.isNewLogin) isNewLogin = true;

    if (qr) {
      console.log('\n[WA] QR ready for ' + sessionId + ' — scan now!\n');
      let qrImage = null;
      try {
        qrImage = await QRCode.toDataURL(qr, { width: 256, margin: 1, errorCorrectionLevel: 'H' });
      } catch (e) {}
      qrStore.set(sessionId, { raw: qr, image: qrImage, ts: Date.now() });
      if (io) io.emit('wa:qr:' + sessionId, { qrImage, ts: Date.now() });
      try {
        const { WaSession } = require('../models');
        await WaSession.update({ qr_code: qr, status: 'connecting' }, { where: { session_id: sessionId } });
      } catch (e) {}
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.info('[WA] Session ' + sessionId + ' closed. LoggedOut:' + loggedOut + ' code:' + code);
      sessions.delete(sessionId);
      qrStore.delete(sessionId);

      // code 515 = WhatsApp minta restart protocol
      if (code === 515) {
        const delay = isNewLogin ? 2000 : 15000; // setelah scan: reconnect cepat; otherwise lebih lama
        logger.info('[WA] Code 515 for ' + sessionId + ' (isNewLogin:' + isNewLogin + '), reconnecting in ' + delay + 'ms...');
        const wasNewLogin = isNewLogin;
        isNewLogin = false;
        setTimeout(() => createSession(sessionId, io, onMessage, wasNewLogin), delay);
        return;
      }

      try {
        const { WaSession } = require('../models');
        await WaSession.update({ status: 'disconnected', qr_code: null }, { where: { session_id: sessionId } });
      } catch (e) {}
      if (io) io.emit('wa:status:' + sessionId, { status: 'disconnected' });

      // Notifikasi session terputus
      try {
        const NotifSvc = require('./NotificationService');
        const reason = loggedOut ? 'Logout dari perangkat WA' : `Error code: ${code||'unknown'}`;
        await NotifSvc.pushAll({
          type:      'wa_disconnected',
          title:     `WA Session Terputus: ${sessionId}`,
          message:   reason + (loggedOut ? ' — Perlu scan QR ulang' : ' — Mencoba reconnect...'),
          severity:  loggedOut ? 'critical' : 'warning',
          action_url: '/whatsapp'
        });
      } catch(ne) {}

      if (!loggedOut) {
        logger.info('[WA] Reconnecting ' + sessionId + ' in 5s...');
        setTimeout(() => createSession(sessionId, io, onMessage, true), 5000);
      } else {
        // loggedOut = WhatsApp reject sesi ini → hapus creds lama dan generate QR baru
        logger.info('[WA] Logged out ' + sessionId + ', clearing auth and re-generating QR in 3s...');
        try { fs.rmSync(getAuthDir(sessionId), { recursive: true, force: true }); } catch (e) {}
        // Creds sudah diganti → message ID lama tak bisa dipakai retry lagi, bersihkan store.
        try { clearMsgStoreForSession(sessionId); } catch (e) {}
        setTimeout(() => createSession(sessionId, io, onMessage), 3000);
      }
    }

    if (connection === 'open') {
      // Ekstrak nomor HP dari user.id: format "628xxx:50@s.whatsapp.net"
      // split ':')[0] mengambil bagian nomor, strip non-digit
      const rawId = sock.user?.id || '';
      const phone = rawId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || '';
      logger.info('[WA] Session ' + sessionId + ' connected! Phone: ' + phone + ' (raw: ' + rawId + ')');
      qrStore.delete(sessionId);
      try {
        const { WaSession } = require('../models');
        await WaSession.update(
          { status: 'connected', qr_code: null, phone_number: phone, last_seen: new Date() },
          { where: { session_id: sessionId } }
        );
      } catch (e) {}
      if (io) io.emit('wa:status:' + sessionId, { status: 'connected', phone });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ── ACK / Delivery receipt tracking ─────────────────────────
  // Baileys emit 'messages.update' setiap kali status pesan berubah.
  // Mapping status code Baileys → status enum WaMessage:
  //   0 ERROR       → 'failed'
  //   1 PENDING     → 'pending'
  //   2 SERVER_ACK  → 'sent'       (centang 1 — sampai ke server WA)
  //   3 DELIVERY_ACK→ 'delivered'  (centang 2 abu — sampai ke HP penerima)
  //   4 READ        → 'read'       (centang 2 biru — sudah dibaca)
  //   5 PLAYED      → 'read'       (untuk voice note yang sudah diputar)
  const ACK_MAP = { 0:'failed', 1:'pending', 2:'sent', 3:'delivered', 4:'read', 5:'read' };
  sock.ev.on('messages.update', async (updates) => {
    try {
      const { WaMessage } = require('../models');
      for (const u of updates || []) {
        if (!u.key || !u.key.fromMe) continue; // hanya track pesan kita yg dikirim
        const statusCode = u.update?.status;
        if (statusCode == null) continue;
        const newStatus = ACK_MAP[statusCode];
        if (!newStatus) continue;
        const waId = u.key.id;
        if (!waId) continue;

        // Update DB — hanya naik level, tidak boleh turun (delivered → sent jangan)
        const levels = { pending:0, sent:1, delivered:2, read:3, failed:-1 };
        const row = await WaMessage.findOne({
          where: { session_id: sessionId, wa_message_id: waId, direction: 'outbound' }
        });
        if (!row) continue;
        const curLevel = levels[row.status] ?? 0;
        const newLevel = levels[newStatus] ?? 0;
        if (newStatus !== 'failed' && newLevel <= curLevel) continue; // sudah di status lebih tinggi

        await row.update({ status: newStatus });

        if (io) io.emit('wa:ack:' + sessionId, {
          wa_message_id: waId,
          status: newStatus,
          to: u.key.remoteJid || '',
          ts: Date.now()
        });
      }
    } catch (e) {
      logger.error('[WA] messages.update handler error: ' + e.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = pesan baru (masuk maupun keluar realtime).
    // 'append' = pesan hasil sinkronisasi dari device lain (mis. balasan yang
    //   Anda kirim dari HP). Keduanya kita terima, tapi 'append' HANYA diproses
    //   untuk pesan fromMe (sinkron balasan); pesan masuk pelanggan tetap
    //   hanya dari 'notify' supaya tidak ada notif/auto-reply ganda.
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || '';

      // ── Pesan fromMe (dikirim dari HP / device lain) ──────────
      // Sinkronkan balasan yang Anda kirim dari aplikasi WhatsApp di HP
      // supaya muncul juga di thread chat WA Gateway. Tidak memicu
      // auto-reply / notif masuk. Pesan yang dikirim VIA aplikasi ini
      // sendiri sudah tersimpan sebagai outbound saat sendMessage(),
      // jadi di-dedup berdasarkan wa_message_id.
      if (msg.key.fromMe) {
        try {
          // Hanya chat pribadi (skip grup/status/broadcast/channel)
          if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast'
              || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) continue;
          if (msg.message?.reactionMessage || msg.message?.protocolMessage
              || msg.message?.ephemeralMessage) continue;

          const c = msg.message || {};
          const fmText = c.conversation || c.extendedTextMessage?.text
            || c.imageMessage?.caption || c.videoMessage?.caption
            || c.documentMessage?.caption || '';
          let fmType = 'text';
          if (c.imageMessage) fmType = 'image';
          else if (c.videoMessage) fmType = 'video';
          else if (c.documentMessage) fmType = 'document';
          else if (c.audioMessage || c.pttMessage) fmType = 'audio';
          else if (c.stickerMessage) fmType = 'sticker';
          if (!fmText && fmType === 'text') continue;

          const toNum = remoteJid.split('@')[0].split(':')[0];
          if (!toNum) continue;

          const { WaMessage, WaSession, Customer } = require('../models');
          const { Op } = require('sequelize');
          const waId = msg.key.id || '';

          // Dedup: kalau pesan ini sudah tersimpan (dikirim via aplikasi), skip
          if (waId) {
            const dup = await WaMessage.findOne({
              where: { session_id: sessionId, direction: 'outbound',
                       wa_message_id: { [Op.like]: waId + '%' } }
            });
            if (dup) continue;
          }

          const session = await WaSession.findOne({ where: { session_id: sessionId } });

          // Korelasi pelanggan dari nomor tujuan
          let customer = null;
          if (toNum.length >= 9) {
            const last9 = toNum.slice(-9), last10 = toNum.slice(-10);
            const to0 = toNum.startsWith('62') ? '0' + toNum.slice(2) : null;
            const orConds = [{ phone: toNum }, { phone: { [Op.like]: '%' + last9 } },
                             { phone: { [Op.like]: '%' + last10 } }];
            if (to0) orConds.push({ phone: to0 });
            customer = await Customer.findOne({ where: { [Op.or]: orConds } });
          }

          await WaMessage.create({
            session_id: sessionId,
            direction: 'outbound',
            from_number: session?.phone_number || '',
            to_number: toNum,
            message: fmText || ('[' + fmType + ']'),
            message_type: fmType,
            media_url: null,
            status: 'sent',
            wa_message_id: waId,
            push_name: null,
            customer_id: customer?.id || null,
          });

          if (io) io.emit('wa:message:' + sessionId, {
            direction: 'outbound', to: toNum, text: fmText || ('[' + fmType + ']'),
            message_type: fmType, media_url: null,
            customer: customer ? { id: customer.id, name: customer.name } : null,
            fromDevice: true, timestamp: new Date(),
          });
        } catch (e) {
          logger.error('[WA] fromMe sync error: ' + e.message);
        }
        continue; // jangan lanjut ke logika pesan masuk
      }

      // Pesan MASUK pelanggan hanya diproses dari 'notify'. Tipe 'append'
      // (hasil sinkronisasi history) untuk pesan non-fromMe diabaikan supaya
      // tidak memicu notifikasi / auto-reply ganda atau pesan lama masuk lagi.
      if (type !== 'notify') continue;

      // ── Filter: hanya proses chat pribadi ──────────────────
      // Skip grup (@g.us)
      if (remoteJid.endsWith('@g.us'))          continue;
      // Skip WA Status / Stories (status@broadcast)
      if (remoteJid === 'status@broadcast')     continue;
      // Skip broadcast list
      if (remoteJid.endsWith('@broadcast'))     continue;
      // Skip newsletter / channel
      if (remoteJid.endsWith('@newsletter'))    continue;
      // Skip reaction messages
      if (msg.message?.reactionMessage)         continue;
      // Skip protocol/ephemeral messages
      if (msg.message?.protocolMessage)         continue;
      if (msg.message?.ephemeralMessage)        continue;
      // ────────────────────────────────────────────────────────
      
      // Ekstrak nomor dari JID
      let from = remoteJid.split('@')[0].split(':')[0];
      // Simpan raw JID untuk reply
      const replyJid = remoteJid;
      
      // Jika format @lid, coba resolve ke nomor HP asli
      if (remoteJid.includes('@lid')) {
        try {
          // Coba dari verifiedBizAccount atau bizPrivacyStatus
          const phoneHint = msg.verifiedBizAccount?.phoneNumber ||
                           msg.bizPrivacyStatus?.phoneNumber || null;
          if (phoneHint) {
            from = phoneHint.replace(/[^0-9]/g, '');
          } else {
            // Coba resolve via sock.onWhatsApp (async, mungkin lambat)
            try {
              const result = await sock.onWhatsApp(remoteJid);
              if (result && result[0]?.jid) {
                const resolvedJid = result[0].jid;
                if (!resolvedJid.includes('@lid')) {
                  from = resolvedJid.split('@')[0].split(':')[0];
                }
              }
            } catch(e2) {
              // onWhatsApp gagal, keep LID sebagai identifier
            }
          }
        } catch(e) {}
      }
      
      // ── Ekstrak konten pesan (text atau media) ──
      const msgContent = msg.message || {};
      const text = msgContent.conversation
        || msgContent.extendedTextMessage?.text
        || msgContent.imageMessage?.caption
        || msgContent.videoMessage?.caption
        || msgContent.documentMessage?.caption
        || '';

      // Deteksi tipe pesan
      let msgType = 'text';
      if (msgContent.imageMessage)    msgType = 'image';
      else if (msgContent.videoMessage)    msgType = 'video';
      else if (msgContent.documentMessage) msgType = 'document';
      else if (msgContent.audioMessage || msgContent.pttMessage) msgType = 'audio';
      else if (msgContent.stickerMessage) msgType = 'sticker';

      // Skip jika tidak ada konten sama sekali
      if (!text && msgType === 'text') continue;
      if (!from) continue;

      try {
        const { WaMessage, WaAutoReply, WaSession, Customer } = require('../models');
        const { Op } = require('sequelize');
        const session  = await WaSession.findOne({ where: { session_id: sessionId } });

        // Multi-format phone lookup
        let customer = null;
        if (from && from.length >= 9) {
          const last9  = from.slice(-9);
          const last10 = from.slice(-10);
          const from0  = from.startsWith('62') ? '0' + from.slice(2) : null;
          const orConds = [
            { phone: from },
            { phone: { [Op.like]: '%' + last9 } },
            { phone: { [Op.like]: '%' + last10 } },
          ];
          if (from0) orConds.push({ phone: from0 });
          customer = await Customer.findOne({ where: { [Op.or]: orConds } });
        }

        // ── Download media jika ada ──
        let mediaUrl = null;
        if (['image','video','document','audio','sticker'].includes(msgType)) {
          try {
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            const buffer = await downloadMediaMessage(
              msg, 'buffer', {},
              {
                logger: require('pino')({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
                  ? sock.updateMediaMessage.bind(sock)
                  : undefined
              }
            );
            if (buffer) {
              const ext = msgType === 'image' ? 'jpg'
                : msgType === 'video' ? 'mp4'
                : msgType === 'audio' ? 'ogg'
                : msgType === 'sticker' ? 'webp'
                : (msgContent.documentMessage?.fileName?.split('.').pop() || 'bin');
              const fname = 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.' + ext;
              const mediaDir = path.join(AUTH_DIR, '..', 'media');
              if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
              fs.writeFileSync(path.join(mediaDir, fname), buffer);
              mediaUrl = '/uploads/media/' + fname;
            }
          } catch(me) {
            logger.warn('[WA] Media download failed: ' + me.message);
          }
        }

        // Simpan pushName untuk kontak LID
        const pushName = msg.pushName || '';
        const jidSuffix = replyJid.includes('@lid') ? '|jid:' + replyJid + (pushName ? '|name:' + pushName : '') : '';

        // Push notifikasi WA masuk
        try {
          const NotifSvc = require('./NotificationService');
          const sName = session?.name || sessionId;
          await NotifSvc.notifyWaIncoming(from, text || ('[' + msgType + ']'), sName);
        } catch(ne) {}

        await WaMessage.create({
          session_id: sessionId,
          direction: 'inbound',
          from_number: from,
          to_number: session?.phone_number || '',
          message: text || ('[' + msgType + ']'),
          message_type: msgType,
          media_url: mediaUrl,
          status: 'delivered',
          wa_message_id: (msg.key.id || '') + jidSuffix,
          push_name: pushName || null,
          customer_id: customer?.id || null
        });

        if (io) io.emit('wa:message:' + sessionId, {
          direction: 'inbound', from, text: text || ('[' + msgType + ']'),
          message_type: msgType, media_url: mediaUrl, pushName,
          replyJid: replyJid.includes('@lid') ? replyJid : null,
          customer: customer ? { id: customer.id, name: customer.name } : null,
          timestamp: new Date()
        });

        if (session?.auto_reply_enabled) {
          const rules = await WaAutoReply.findAll({ where: { session_id: sessionId, is_active: true } });
          for (const rule of rules) {
            if (matchAutoReply(text, rule.keyword, rule.match_type)) {
              await sendMessage(sessionId, from, rule.reply_message, io);
              await rule.increment('hit_count');
              break;
            }
          }
        }
      } catch (e) {
        logger.error('[WA] Message handler error:', e.message);
      }

      if (typeof onMessage === 'function') onMessage(sessionId, from, text, msg);
    }
  });

  return sock;
}

// Resolve nomor → JID yang BENAR via onWhatsApp(). Menebak @lid dari panjang
// digit tidak reliable & sering bikin sesi enkripsi salah (gejala "Waiting").
// onWhatsApp mengembalikan jid kanonik (server tahu nomor terdaftar di @s.whatsapp.net
// atau perlu @lid). Fallback ke @s.whatsapp.net kalau lookup gagal.
async function resolveJid(sock, to) {
  if (to.includes('@')) return to; // sudah JID lengkap
  let digits = to.replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  try {
    const res = await sock.onWhatsApp(digits + '@s.whatsapp.net');
    if (Array.isArray(res) && res.length && res[0].exists && res[0].jid) {
      return res[0].jid; // jid kanonik dari server WA
    }
  } catch (_) { /* lookup gagal → fallback di bawah */ }
  return digits + '@s.whatsapp.net';
}

async function sendMessage(sessionId, to, message, io, opts) {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error('Session ' + sessionId + ' not connected');
  const jid = await resolveJid(sock, to);
  // Reply/quote best-effort: kalau pesan yang dibalas adalah kiriman kita
  // sendiri, kontennya ada di msgStore → bisa dikirim sbg quoted message.
  // Kalau tidak ada di store (mis. membalas pesan masuk), kirim polos —
  // konteks quote tetap tampil di UI CRM via kolom reply_to_*.
  let sendExtra = undefined;
  if (opts && opts.replyToId) {
    const rid = String(opts.replyToId).split('|')[0];
    const quotedContent = getSentMessage(sessionId, rid);
    if (quotedContent) {
      sendExtra = { quoted: { key: { remoteJid: jid, fromMe: true, id: rid }, message: quotedContent } };
    }
  }
  const result = await sock.sendMessage(jid, { text: message }, sendExtra);
  // Simpan pesan ke store untuk melayani retry dekripsi penerima (anti "Waiting").
  try {
    if (result && result.key && result.message) {
      putSentMessage(sessionId, result.key.id, result.message);
    }
  } catch (_) {}
  try {
    const { WaMessage, WaSession, Customer } = require('../models');
    const { Op } = require('sequelize');
    const session  = await WaSession.findOne({ where: { session_id: sessionId } });
    // Multi-format phone lookup
    let customer = null;
    const toClean = to.replace(/[^0-9]/g, '');
    if (toClean.length >= 9) {
      const last9  = toClean.slice(-9);
      const last10 = toClean.slice(-10);
      const to0    = toClean.startsWith('62') ? '0' + toClean.slice(2) : null;
      const orConds = [
        { phone: toClean },
        { phone: { [Op.like]: '%' + last9 } },
        { phone: { [Op.like]: '%' + last10 } },
      ];
      if (to0) orConds.push({ phone: to0 });
      customer = await Customer.findOne({ where: { [Op.or]: orConds } });
    }
    await WaMessage.create({
      session_id: sessionId, direction: 'outbound',
      from_number: session?.phone_number || '', to_number: to,
      message, message_type: 'text', status: 'sent',
      wa_message_id: result?.key?.id || null,
      customer_id: customer?.id || null, sent_at: new Date()
    });
    if (io) io.emit('wa:message:' + sessionId, {
      direction: 'outbound', to, text: message,
      wa_message_id: result?.key?.id || null,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      timestamp: new Date()
    });
  } catch (e) { logger.error('[WA] Save outbound error:', e.message); }
  return result;
}

// ── Send media (image / video / audio / document) ─────────────
// opts: { to, mediaPath, mediaType, caption, mimeType, fileName }
//   mediaType: 'image' | 'video' | 'audio' | 'document'
async function sendMedia(sessionId, opts, io) {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error('Session ' + sessionId + ' not connected');
  const { to, mediaPath, mediaType, caption, mimeType, fileName } = opts;
  if (!to || !mediaPath || !mediaType) throw new Error('to, mediaPath, mediaType wajib');
  if (!fs.existsSync(mediaPath)) throw new Error('File tidak ditemukan: ' + mediaPath);

  // Resolve JID (via onWhatsApp — lihat resolveJid)
  const jid = await resolveJid(sock, to);

  // Build Baileys payload sesuai media type
  let payload;
  if (mediaType === 'image') {
    payload = { image: fs.readFileSync(mediaPath), caption: caption || undefined, mimetype: mimeType || 'image/jpeg' };
  } else if (mediaType === 'video') {
    payload = { video: fs.readFileSync(mediaPath), caption: caption || undefined, mimetype: mimeType || 'video/mp4' };
  } else if (mediaType === 'audio') {
    payload = { audio: fs.readFileSync(mediaPath), mimetype: mimeType || 'audio/mp4', ptt: false };
  } else {
    // document (catch-all)
    payload = {
      document: fs.readFileSync(mediaPath),
      mimetype: mimeType || 'application/octet-stream',
      fileName: fileName || path.basename(mediaPath),
      caption: caption || undefined
    };
  }

  const result = await sock.sendMessage(jid, payload);
  // Simpan ke store untuk melayani retry dekripsi penerima (anti "Waiting").
  try {
    if (result && result.key && result.message) {
      putSentMessage(sessionId, result.key.id, result.message);
    }
  } catch (_) {}

  // Simpan ke DB + emit socket
  try {
    const { WaMessage, WaSession, Customer } = require('../models');
    const { Op } = require('sequelize');
    const session = await WaSession.findOne({ where: { session_id: sessionId } });

    // Resolve customer
    let customer = null;
    const toClean = to.replace(/[^0-9]/g, '');
    if (toClean.length >= 9) {
      const last9 = toClean.slice(-9), last10 = toClean.slice(-10);
      const to0 = toClean.startsWith('62') ? '0' + toClean.slice(2) : null;
      const orConds = [
        { phone: toClean },
        { phone: { [Op.like]: '%' + last9 } },
        { phone: { [Op.like]: '%' + last10 } },
      ];
      if (to0) orConds.push({ phone: to0 });
      customer = await Customer.findOne({ where: { [Op.or]: orConds } });
    }

    // Move file ke /uploads/media supaya URL konsisten dengan inbound, lalu set mediaUrl
    const mediaDir = path.join(AUTH_DIR, '..', 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const baseName = path.basename(mediaPath);
    const finalPath = path.join(mediaDir, baseName);
    if (path.resolve(mediaPath) !== path.resolve(finalPath)) {
      try { fs.renameSync(mediaPath, finalPath); }
      catch { fs.copyFileSync(mediaPath, finalPath); try { fs.unlinkSync(mediaPath); } catch(_) {} }
    }
    const mediaUrl = '/uploads/media/' + baseName;

    // Map ke enum message_type di model (hanya accept: text, image, document, audio, template)
    // 'video' & 'sticker' di-fallback ke 'image' agar lewat enum (renderer frontend lihat media_url & tag)
    const dbMsgType = ['image','document','audio'].includes(mediaType)
      ? mediaType
      : (mediaType === 'video' ? 'image' : 'document');

    await WaMessage.create({
      session_id: sessionId, direction: 'outbound',
      from_number: session?.phone_number || '', to_number: to,
      message: caption || ('[' + mediaType + ']'),
      message_type: dbMsgType, status: 'sent',
      wa_message_id: result?.key?.id || null,
      media_url: mediaUrl,
      customer_id: customer?.id || null, sent_at: new Date()
    });

    if (io) io.emit('wa:message:' + sessionId, {
      direction: 'outbound', to,
      text: caption || '',
      message_type: dbMsgType,
      media_url: mediaUrl,
      wa_message_id: result?.key?.id || null,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      timestamp: new Date()
    });
  } catch (e) {
    logger.error('[WA] sendMedia save error: ' + e.message);
  }

  return result;
}

async function sendBroadcast(sessionId, numbers, message, io) {
  const res = { success: 0, failed: 0, errors: [] };
  const sock = sessions.get(sessionId);
  const total = Array.isArray(numbers) ? numbers.length : 0;
  if (!total) return res;

  logger.info(`[WA] Broadcast mulai: ${total} nomor (delay ${BROADCAST_CFG.minDelayMs}-${BROADCAST_CFG.maxDelayMs}ms, batch ${BROADCAST_CFG.batchSize})`);

  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    try {
      // ── Simulasi "mengetik" sebelum kirim (lebih natural di mata WhatsApp) ──
      if (BROADCAST_CFG.simulateTyping && sock) {
        try {
          const jid = await resolveJid(sock, n);
          await sock.sendPresenceUpdate('composing', jid);
          await sleep(randBetween(BROADCAST_CFG.typingMinMs, BROADCAST_CFG.typingMaxMs));
          await sock.sendPresenceUpdate('paused', jid);
        } catch (_) { /* presence gagal → lanjut kirim saja */ }
      }

      await sendMessage(sessionId, n, message, io);
      res.success++;

      // Emit progress ke UI (kalau ada socket) — admin bisa pantau real-time
      if (io) io.emit('wa:broadcast:progress:' + sessionId, {
        sent: res.success, failed: res.failed, total, current: i + 1
      });
    } catch (e) {
      res.failed++;
      res.errors.push({ number: n, error: e.message });
      if (io) io.emit('wa:broadcast:progress:' + sessionId, {
        sent: res.success, failed: res.failed, total, current: i + 1
      });
    }

    // Jangan delay setelah pesan terakhir
    const isLast = (i === numbers.length - 1);
    if (isLast) break;

    // ── Jeda batch: setelah tiap N pesan, istirahat lebih lama ──
    const sentSoFar = i + 1;
    if (BROADCAST_CFG.batchSize > 0 && sentSoFar % BROADCAST_CFG.batchSize === 0) {
      const pause = randBetween(BROADCAST_CFG.batchPauseMinMs, BROADCAST_CFG.batchPauseMaxMs);
      logger.info(`[WA] Broadcast jeda batch setelah ${sentSoFar} pesan: istirahat ${Math.round(pause/1000)}s`);
      if (io) io.emit('wa:broadcast:batch-pause:' + sessionId, {
        sentSoFar, pauseMs: pause, total
      });
      await sleep(pause);
    } else {
      // ── Jeda acak antar pesan biasa ──
      await sleep(randBetween(BROADCAST_CFG.minDelayMs, BROADCAST_CFG.maxDelayMs));
    }
  }

  logger.info(`[WA] Broadcast selesai: ${res.success} terkirim, ${res.failed} gagal`);
  if (io) io.emit('wa:broadcast:done:' + sessionId, {
    sent: res.success, failed: res.failed, total
  });
  return res;
}

async function disconnectSession(sessionId) {
  const sock = sessions.get(sessionId);
  sessions.delete(sessionId); // hapus dulu dari map agar tidak ada reconnect loop
  qrStore.delete(sessionId);
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (e) {}
    try { await sock.logout(); } catch (e) {}
    try { sock.end(); } catch (e) {}
    try { sock.ws?.close(); } catch (e) {}
  }
  try { fs.rmSync(getAuthDir(sessionId), { recursive: true, force: true }); } catch (e) {}
  // Session dihapus permanen → entri retry-store miliknya ikut dibersihkan.
  try { clearMsgStoreForSession(sessionId); } catch (e) {}
}

function getSessionStatus(sessionId) {
  const sock = sessions.get(sessionId);
  if (!sock) return 'disconnected';
  return sock.user ? 'connected' : 'connecting';
}

function isConnected(sessionId) {
  return sessions.has(sessionId) && !!sessions.get(sessionId)?.user;
}

function getSessions() { return sessions; }

async function restoreAllSessions(io) {
  if (!baileysReady) { logger.warn('[WA] Skip restore — Baileys not ready'); return; }
  await new Promise(r => setTimeout(r, 3000));
  try {
    const { WaSession } = require('../models');
    const { Op } = require('sequelize');
    // PENTING: HANYA restore session provider Baileys. Session WAHA & Fonnte
    // dikelola layanan masing-masing (WahaService/cron auto-reconnect &
    // FonnteService). Tanpa filter ini, Baileys mencoba "menghidupkan" session
    // WAHA → gagal (bukan creds Baileys) → error 408 → notifikasi "Session
    // Terputus" spam + loop reconnect. provider null/'' dianggap Baileys (default lama).
    const list = await WaSession.findAll({
      where: {
        is_active: true,
        status: 'connected',
        [Op.or]: [
          { provider: 'baileys' },
          { provider: null },
          { provider: '' },
        ],
      },
    });
    for (const s of list) {
      createSession(s.session_id, io, null).catch(e => logger.error('[WA] Restore failed:', e.message));
      await new Promise(r => setTimeout(r, 1000));
    }
    logger.info('[WA] Restored ' + list.length + ' Baileys sessions');
  } catch (e) { logger.error('[WA] restoreAllSessions error:', e.message); }
}

async function getProfilePicture(sessionId, number) {
  const sock = sessions.get(sessionId);
  if (!sock) return null;
  try {
    const jid = await resolveJid(sock, number);
    const url = await sock.profilePictureUrl(jid, 'image');
    return url || null;
  } catch(e) {
    // Contact may have hidden their profile picture
    return null;
  }
}

// Hapus pesan "untuk semua" (delete for everyone) — hanya pesan keluar kita.
async function deleteMessage(sessionId, chatTarget, messageId) {
  const sock = sessions.get(sessionId);
  if (!sock) throw new Error('Session ' + sessionId + ' not connected');
  let jid = String(chatTarget || '');
  if (!jid.includes('@')) {
    let d = jid.replace(/[^0-9]/g, '');
    if (d.startsWith('0')) d = '62' + d.slice(1);
    jid = d + '@s.whatsapp.net';
  }
  const rid = String(messageId || '').split('|')[0];
  if (!rid) throw new Error('Message ID kosong');
  await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: rid } });
  return true;
}

module.exports = { createSession, sendMessage, sendMedia, sendBroadcast, disconnectSession, getSessionStatus, isConnected, getSessions, restoreAllSessions, qrStore, getProfilePicture, flushMsgStoreSync, deleteMessage };