/**
 * GatewayService.js — Router provider WA Gateway
 * ----------------------------------------------
 * Memilih provider per-session berdasarkan kolom wa_sessions.provider:
 *   - 'baileys' (default) → WAService.js  (scan QR, Baileys embedded)
 *   - 'fonnte'            → FonnteService.js (HTTP API token, cloud)
 *   - 'waha'              → WahaService.js  (HTTP API, self-hosted WAHA)
 *
 * Controller cukup memanggil GatewayService dengan session_id; routing provider
 * ditangani di sini supaya logika controller tetap seragam & tidak peduli
 * provider mana yang dipakai.
 *
 * CATATAN PENTING soal perbedaan signature:
 *   - WAService memakai sessionId (string) sebagai argumen pertama.
 *   - FonnteService butuh OBJEK session (row WaSession) untuk ambil token.
 *   GatewayService menyembunyikan beda ini: selalu terima sessionId dari
 *   controller, lalu resolve row session bila perlu (provider fonnte).
 */

const WAService     = require('./WAService');
const FonnteService = require('./FonnteService');
const WahaService   = require('./WahaService');
const logger        = require('../utils/logger');
const { Op }        = require('sequelize');

// Cache ringan row session (provider+token) supaya tidak query DB tiap kirim.
// TTL pendek karena provider/token bisa diubah admin lewat UI.
const _sessionCache = new Map(); // session_id → { row, ts }
const SESSION_TTL = 30 * 1000;   // 30 detik

async function _getSessionRow(sessionId) {
  const cached = _sessionCache.get(sessionId);
  if (cached && (Date.now() - cached.ts) < SESSION_TTL) return cached.row;
  const { WaSession } = require('../models');
  const row = await WaSession.findOne({ where: { session_id: sessionId } });
  if (row) _sessionCache.set(sessionId, { row, ts: Date.now() });
  return row;
}

// Hapus cache (panggil setelah admin ubah provider/token).
function invalidateSessionCache(sessionId) {
  if (sessionId) _sessionCache.delete(sessionId);
  else _sessionCache.clear();
}

// ── Pilih session untuk pengiriman OTOMATIS (cron, reminder, notif, dll) ─────
// Sebelumnya kode tersebar pakai `WaSession.findOne({ where:{status:'connected'} })`
// yang ambil session acak. Sekarang terpusat di sini & menghormati pengaturan
// admin "default_wa_session" (disimpan di AppSetting). Urutan resolusi:
//   1. Session yang dipilih admin di setting (jika ada & masih connected)
//   2. Session connected paling lama dibuat (stabil, bukan acak)
//   3. null kalau tidak ada yang connected
// Mengembalikan row WaSession (atau null).
// Cache hasil sesi pengirim terverifikasi — supaya verifikasi live tidak
// menembak WAHA/Fonnte berulang saat banyak pemanggil beruntun (mis. broadcast
// per-pelanggan, atau beberapa endpoint dalam satu request).
let _verifiedCache = { at: 0, session_id: null };
const _VERIFIED_TTL = 20 * 1000; // 20 detik

async function getDefaultSendingSession() {
  const { WaSession } = require('../models');

  // Jalur cepat: pakai hasil verifikasi terakhir bila masih segar & sesi itu
  // masih tampak connected di cache (menghindari verifikasi live tiap panggil).
  if (_verifiedCache.session_id && (Date.now() - _verifiedCache.at) < _VERIFIED_TTL) {
    if (isConnected(_verifiedCache.session_id)) {
      const row = await WaSession.findOne({ where: { session_id: _verifiedCache.session_id } });
      if (row) return row;
    }
  }

  // Verifikasi live (menyembuhkan status DB yang basi). Ini kunci perbaikan:
  // dulu fungsi ini hanya membaca kolom status DB yang bisa basi, sehingga
  // SEMUA pemanggil (halaman finance, payment, broadcast, cron, dll) menolak
  // kirim dengan "tidak ada session terhubung" padahal WAHA WORKING.
  const verified = await getVerifiedSendingSession();
  _verifiedCache = { at: Date.now(), session_id: verified ? verified.session_id : null };
  return verified;
}

// Versi yang mengembalikan session_id string saja (helper ringkas).
async function getDefaultSendingSessionId() {
  const s = await getDefaultSendingSession();
  return s ? s.session_id : null;
}

// Seperti getDefaultSendingSession(), TAPI memverifikasi status SECARA LIVE ke
// WAHA/Fonnte sebelum menyerah. Kenapa perlu: kolom `status` di DB bisa BASI
// (mis. blip jaringan, atau app baru restart sebelum cron sinkron). Halaman WA
// menyembuhkan status ini saat DIBUKA — tapi cron reminder jalan otomatis tanpa
// ada yang membuka halaman, jadi ia melihat status basi dan skip dengan alasan
// "tidak ada session terhubung", padahal WAHA sebenarnya WORKING.
//
// Fungsi ini menutup celah itu: kalau tak ada session yang tampak connected,
// ia memverifikasi live tiap session WAHA/Fonnte (yang sekaligus meng-update
// DB), lalu memilih yang benar-benar hidup. Aman terhadap 'unknown' (WAHA tak
// terjangkau → status lama dipertahankan, tidak divonis putus).
async function getVerifiedSendingSession() {
  const { WaSession, AppSetting } = require('../models');

  // Verifikasi live satu row; kembalikan true kalau benar-benar terhubung.
  async function liveOk(row) {
    if (!row) return false;
    try {
      if (row.provider === 'waha')   return await verifyWahaConnection(row.session_id);
      if (row.provider === 'fonnte') return await verifyFonnteConnection(row.session_id);
      // Baileys: status real-time hidup di proses ini (socket) → percaya isConnected.
      return isConnected(row.session_id);
    } catch (_) { return false; }
  }

  // 1) Hormati pilihan admin lebih dulu — verifikasi live-nya.
  try {
    const setting = await AppSetting.findOne({ where: { key: 'default_wa_session' } });
    const chosenId = setting && setting.value ? setting.value.trim() : '';
    if (chosenId) {
      const chosen = await WaSession.findOne({ where: { session_id: chosenId } });
      if (chosen && await liveOk(chosen)) {
        return await WaSession.findOne({ where: { session_id: chosenId } }); // re-read status terbaru
      }
    }
  } catch (_) { /* fallback */ }

  // 2) Jalur cepat: kalau ada yang SUDAH connected di DB, verifikasi & pakai.
  const already = await WaSession.findOne({
    where: { status: 'connected' },
    order: [['created_at', 'ASC']],
  });
  if (already && await liveOk(already)) {
    return await WaSession.findOne({ where: { session_id: already.session_id } });
  }

  // 3) Jalur pemulihan: status DB mungkin BASI. Verifikasi live semua session
  //    WAHA/Fonnte yang belum tervonis banned, urut terlama → deterministik.
  const candidates = await WaSession.findAll({
    where: {
      provider: { [Op.in]: ['waha', 'fonnte'] },
      status:   { [Op.ne]: 'banned' },
    },
    order: [['created_at', 'ASC']],
  });
  for (const row of candidates) {
    if (await liveOk(row)) {
      return await WaSession.findOne({ where: { session_id: row.session_id } });
    }
  }

  // Benar-benar tidak ada yang hidup.
  return null;
}

// Gerbang kirim yang TAHAN status-basi. Dipakai sebelum kirim manual (dengan
// session_id eksplisit). Alur: cek cepat via isConnected (murah, dari cache).
// Kalau tampak putus untuk WAHA/Fonnte, JANGAN langsung tolak — verifikasi live
// sekali (yang sekaligus menyembuhkan DB). Baru menolak kalau live pun gagal.
async function ensureSendable(sessionId) {
  if (!sessionId) return { ok: false, reason: 'session_id kosong' };
  await warmSession(sessionId);
  if (isConnected(sessionId)) return { ok: true };

  const row = await _getSessionRow(sessionId);
  if (!row) return { ok: false, reason: 'Session tidak ditemukan' };

  try {
    if (row.provider === 'waha'   && await verifyWahaConnection(sessionId))   return { ok: true };
    if (row.provider === 'fonnte' && await verifyFonnteConnection(sessionId)) return { ok: true };
  } catch (_) { /* jatuh ke penolakan */ }

  return { ok: false, reason: 'Session tidak terhubung' };
}

async function _providerOf(sessionId) {
  const row = await _getSessionRow(sessionId);
  return { provider: (row && row.provider) || 'baileys', row };
}

// ═══════════════════════════════════════════════════════════════════════════
// THROTTLE GLOBAL ANTI-BAN — jaring pengaman untuk SEMUA jalur kirim
// ═══════════════════════════════════════════════════════════════════════════
// Latar: broadcast manual sudah punya jeda acak 4-12 dtk + jeda batch di level
// provider (WAService/Fonnte/WahaService). TAPI banyak jalur massal lain
// (cron reminder, auto-isolir, bulk reminder billing, dsb) memanggil
// GatewayService.sendMessage() dalam LOOP dengan delay FIX pendek (500-1500ms)
// — pola robotik yang persis dideteksi WhatsApp sebagai spam → soft-ban.
//
// Solusi terpusat: SEMUA pesan yang lewat GatewayService.sendMessage/sendMedia
// diantrekan per-session dan diberi jeda ACAK minimum antar pesan BERUNTUN:
//   • Pesan tunggal setelah idle (chat manual, konfirmasi bayar) → LOLOS
//     LANGSUNG tanpa delay (idle > gap = streak reset).
//   • Pesan beruntun (loop massal) → jeda acak minGap..maxGap antar pesan.
//   • Setelah batchSize pesan beruntun → istirahat panjang (pause acak).
//   • Antrian per-session (promise chain) → panggilan konkuren dari beberapa
//     modul (cron + admin kirim manual bersamaan) tidak saling tabrak.
//
// TIDAK dobel dengan broadcast: sendBroadcast() Gateway memanggil
// provider.sendBroadcast langsung (yang di dalamnya pakai sendMessage INTERNAL
// provider, bukan Gateway) — jadi throttle ini tidak menumpuk di broadcast.
// Auto-reply juga internal provider → tidak tertahan antrian ini.
//
// Matikan/atur via env tanpa ubah kode:
//   WA_SEND_THROTTLE=0            → nonaktif total (tidak disarankan)
//   WA_SEND_MIN_GAP / WA_SEND_MAX_GAP → jeda acak antar pesan beruntun (ms)
//   WA_SEND_BATCH_SIZE            → pesan beruntun sebelum istirahat panjang
//   WA_SEND_BATCH_PAUSE_MIN/MAX   → durasi istirahat panjang (ms)
const SEND_THROTTLE = {
  enabled:       (process.env.WA_SEND_THROTTLE || '1') === '1',
  minGapMs:       parseInt(process.env.WA_SEND_MIN_GAP         || '2500'),
  maxGapMs:       parseInt(process.env.WA_SEND_MAX_GAP         || '7000'),
  batchSize:      parseInt(process.env.WA_SEND_BATCH_SIZE      || '25'),
  batchPauseMin:  parseInt(process.env.WA_SEND_BATCH_PAUSE_MIN || '45000'),
  batchPauseMax:  parseInt(process.env.WA_SEND_BATCH_PAUSE_MAX || '120000'),
};

const _sendState = new Map(); // session_id → { chain, lastSentAt, streak }

function _rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Bungkus operasi kirim dalam antrian per-session + jeda anti-ban.
function _throttledSend(sessionId, fn) {
  if (!SEND_THROTTLE.enabled) return fn();

  let st = _sendState.get(sessionId);
  if (!st) { st = { chain: Promise.resolve(), lastSentAt: 0, streak: 0 }; _sendState.set(sessionId, st); }

  const task = st.chain.then(async () => {
    const now  = Date.now();
    const idle = now - st.lastSentAt;
    const gap  = _rand(SEND_THROTTLE.minGapMs, SEND_THROTTLE.maxGapMs);

    if (st.lastSentAt && idle < gap) {
      // Pesan BERUNTUN (jarak dgn pesan sebelumnya < gap acak)
      st.streak++;
      let wait = gap - idle;
      if (SEND_THROTTLE.batchSize > 0 && st.streak >= SEND_THROTTLE.batchSize) {
        // Sudah 1 batch penuh beruntun → istirahat panjang, streak reset
        wait = _rand(SEND_THROTTLE.batchPauseMin, SEND_THROTTLE.batchPauseMax);
        st.streak = 0;
        logger.info('[Gateway] Throttle: jeda batch ' + Math.round(wait / 1000) + 's untuk session ' + sessionId);
      }
      await _sleep(wait);
    } else {
      // Idle cukup lama → pesan tunggal biasa, lolos tanpa delay
      st.streak = 0;
    }

    try {
      return await fn();
    } finally {
      st.lastSentAt = Date.now();
    }
  });

  // Jaga chain tetap hidup meski task ini error (error tetap dilempar ke caller)
  st.chain = task.catch(() => {});
  return task;
}

// ── Kirim pesan teks ────────────────────────────────────────
// opts (opsional): { replyToId, replyToText } — reply/quote ke pesan lain.
// Fonnte tidak mendukung quote → dikirim sbg pesan biasa (quote tetap
// tampil di UI CRM via kolom reply_to_*).
async function sendMessage(sessionId, to, message, io, opts) {
  const { provider, row } = await _providerOf(sessionId);
  return _throttledSend(sessionId, () => {
    if (provider === 'fonnte') {
      if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
      return FonnteService.sendMessage(row, to, message, io);
    }
    if (provider === 'waha') {
      if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
      return WahaService.sendMessage(row, to, message, io, opts);
    }
    return WAService.sendMessage(sessionId, to, message, io, opts);
  });
}

// Hapus pesan "untuk semua" di WhatsApp (hanya pesan keluar milik kita,
// dlm jendela waktu yang diizinkan WhatsApp ±2 hari).
async function deleteMessage(sessionId, chatTarget, messageId) {
  const { provider, row } = await _providerOf(sessionId);
  if (provider === 'fonnte') {
    throw new Error('Hapus pesan tidak didukung provider Fonnte');
  }
  if (provider === 'waha') {
    if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
    return WahaService.deleteMessage(row, chatTarget, messageId);
  }
  return WAService.deleteMessage(sessionId, chatTarget, messageId);
}

// ── Kirim media ─────────────────────────────────────────────
async function sendMedia(sessionId, opts, io) {
  const { provider, row } = await _providerOf(sessionId);
  return _throttledSend(sessionId, () => {
    if (provider === 'fonnte') {
      if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
      return FonnteService.sendMedia(row, opts, io);
    }
    if (provider === 'waha') {
      if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
      return WahaService.sendMedia(row, opts, io);
    }
    return WAService.sendMedia(sessionId, opts, io);
  });
}

// ── Broadcast ───────────────────────────────────────────────
async function sendBroadcast(sessionId, numbers, message, io) {
  const { provider, row } = await _providerOf(sessionId);
  if (provider === 'fonnte') {
    if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
    return FonnteService.sendBroadcast(row, numbers, message, io);
  }
  if (provider === 'waha') {
    if (!row) throw new Error('Session tidak ditemukan: ' + sessionId);
    return WahaService.sendBroadcast(row, numbers, message, io);
  }
  return WAService.sendBroadcast(sessionId, numbers, message, io);
}

// ── Cek koneksi (SINKRON — agar kompatibel dgn controller existing) ──────────
// Controller memanggil tanpa await (mis. `if (!isConnected(id))`), jadi harus
// sinkron. Untuk Baileys → cek socket di memori (akurat real-time). Untuk Fonnte
// → andalkan kolom status di DB (di-cache via warmSession). Validasi token yang
// sebenarnya tetap terjadi saat kirim (FonnteService melempar error kalau gagal).
function isConnected(sessionId) {
  const cached = _sessionCache.get(sessionId);
  const provider = cached?.row?.provider || 'baileys';
  if (provider === 'fonnte') {
    // Fonnte = layanan CLOUD: device hidup di server Fonnte, bukan di sini.
    // Kolom status DB bisa 'disconnected' palsu akibat blip cek berkala,
    // padahal API /send tetap berhasil. Karena itu untuk keperluan GATE kirim,
    // cukup pastikan token ada; validasi sebenarnya terjadi saat /send (Fonnte
    // melempar error jelas kalau device benar-benar mati). Ini menghentikan
    // "harus verifikasi ulang dulu" sebelum bisa kirim.
    const row = cached?.row;
    if (!row || !row.fonnte_token) return false;
    return row.status !== 'banned';   // hanya 'banned' yg benar2 memblokir
  }
  if (provider === 'waha') {
    // WAHA = proses terpisah: status real-time hidup di sana. Kolom status DB
    // dijaga segar oleh webhook session.status + verifikasi saat connect.
    // Untuk GATE kirim: cukup URL terisi & tidak banned — validasi sebenarnya
    // terjadi saat kirim (WahaService melempar error jelas kalau session mati).
    const row = cached?.row;
    if (!row || !row.waha_url) return false;
    return row.status !== 'banned';
  }
  return WAService.isConnected(sessionId);
}

// Status session (string, SINKRON).
function getSessionStatus(sessionId) {
  const cached = _sessionCache.get(sessionId);
  const provider = cached?.row?.provider || 'baileys';
  if (provider === 'fonnte') {
    const row = cached?.row;
    if (!row || !row.fonnte_token) return 'disconnected';
    return row.status === 'connected' ? 'connected' : (row.status || 'disconnected');
  }
  if (provider === 'waha') {
    const row = cached?.row;
    if (!row || !row.waha_url) return 'disconnected';
    return row.status || 'disconnected';   // dijaga segar via webhook + verify
  }
  return WAService.getSessionStatus(sessionId);
}

// Pre-load row session ke cache (panggil sebelum isConnected sinkron untuk
// session fonnte). Controller bisa `await warmSession(id)` lebih dulu.
async function warmSession(sessionId) {
  await _getSessionRow(sessionId);
}

// Verifikasi koneksi Fonnte SECARA NYATA via API (async) + update kolom status.
// Dipakai saat connect/refresh dari UI, bukan di hot-path kirim.
async function verifyFonnteConnection(sessionId) {
  const row = await _getSessionRow(sessionId);
  if (!row || row.provider !== 'fonnte') return false;

  // Tri-state: 'connected' | 'disconnected' | 'unknown'.
  // 'unknown' berarti pengecekan gagal (jaringan/timeout), BUKAN device offline.
  // Dalam kasus itu kita PERTAHANKAN status terakhir agar tidak "sering
  // terputus" palsu akibat blip sesaat ke API Fonnte.
  const state = await FonnteService.checkConnection(row);
  if (state === 'unknown') {
    return row.status === 'connected';   // biarkan status lama, jangan vonis putus
  }

  const ok = (state === 'connected');
  try {
    const { WaSession } = require('../models');
    await WaSession.update(
      { status: ok ? 'connected' : 'disconnected', last_seen: new Date() },
      { where: { session_id: sessionId } }
    );
    invalidateSessionCache(sessionId);
    await _getSessionRow(sessionId); // re-cache dgn status baru
  } catch (_) {}
  return ok;
}

// Verifikasi koneksi WAHA SECARA NYATA via API (async) + update kolom status.
// Dipakai saat connect/refresh dari UI & syncStatus, bukan di hot-path kirim.
// Tri-state sama dgn Fonnte: 'unknown' (WAHA tak terjangkau) → pertahankan
// status terakhir, jangan vonis putus karena blip jaringan sesaat.
async function verifyWahaConnection(sessionId) {
  const row = await _getSessionRow(sessionId);
  if (!row || row.provider !== 'waha') return false;

  const state = await WahaService.checkConnection(row);
  if (state === 'unknown') {
    return row.status === 'connected';   // biarkan status lama
  }

  const ok = (state === 'connected');
  try {
    const { WaSession } = require('../models');
    // 'connecting' (sedang scan QR) disimpan apa adanya — jangan divonis
    // disconnected oleh syncStatus di tengah proses pairing.
    const newStatus = ok ? 'connected' : (state === 'connecting' ? 'connecting' : 'disconnected');
    const patch = { status: newStatus, last_seen: new Date() };
    // Saat connected, ambil nomor WA dari info session WAHA (me.id)
    if (ok) {
      try {
        const info = await WahaService.getSessionInfo(row);
        const meId = info && info.me && info.me.id ? String(info.me.id) : '';
        if (meId) patch.phone_number = WahaService.normalizeNumber(meId.split('@')[0].split(':')[0]);
        patch.qr_code = null;
      } catch (_) {}
    }
    await WaSession.update(patch, { where: { session_id: sessionId } });
    invalidateSessionCache(sessionId);
    await _getSessionRow(sessionId); // re-cache dgn status baru
  } catch (_) {}
  return ok;
}

// ── Profile picture (Baileys & WAHA; Fonnte tidak menyediakan) ──
async function getProfilePicture(sessionId, number) {
  const { provider, row } = await _providerOf(sessionId);
  if (provider === 'fonnte') return null;
  if (provider === 'waha') {
    if (!row) return null;
    return WahaService.getProfilePicture(row, number);
  }
  return WAService.getProfilePicture(sessionId, number);
}

// Ambil bytes gambar foto profil (utk di-proxy backend). Hanya WAHA yg
// mendukung; provider lain → null (frontend fallback ke inisial).
async function getProfilePictureImage(sessionId, number) {
  const { provider, row } = await _providerOf(sessionId);
  if (provider === 'waha') {
    if (!row) return null;
    return WahaService.getProfilePictureImage(row, number);
  }
  return null;
}

module.exports = {
  sendMessage,
  sendMedia,
  sendBroadcast,
  isConnected,
  getSessionStatus,
  getProfilePicture,
  getProfilePictureImage,
  invalidateSessionCache,
  warmSession,
  verifyFonnteConnection,
  verifyWahaConnection,
  deleteMessage,
  getDefaultSendingSession,
  getVerifiedSendingSession,
  ensureSendable,
  getDefaultSendingSessionId,
};
