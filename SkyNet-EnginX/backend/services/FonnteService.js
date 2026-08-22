/**
 * FonnteService.js — Provider WA Gateway via Fonnte HTTP API
 * ----------------------------------------------------------
 * Alternatif dari Baileys (WAService). Tidak perlu scan QR di server kita;
 * autentikasi cukup token API dari dashboard Fonnte (disimpan per-session di DB
 * kolom wa_sessions.fonnte_token).
 *
 * Endpoint: POST https://api.fonnte.com/send
 * Auth    : header "Authorization: <TOKEN>"  (TANPA Bearer)
 * Param   : target (nomor, multi pisah koma), message, delay (range "min-max"),
 *           countryCode (default 62), typing (bool)
 *
 * Interface dibuat MIRIP WAService supaya GatewayService bisa memanggil seragam:
 *   sendMessage(session, to, message, io)
 *   sendMedia(session, opts, io)
 *   sendBroadcast(session, numbers, message, io)
 *   isConnected(session)            → cek device status di Fonnte
 *   getDeviceStatus(token)          → status mentah dari Fonnte
 *
 * CATATAN: throttle/delay di sisi Fonnte ditangani server Fonnte (param delay),
 * jadi broadcast TIDAK perlu sleep manual seperti Baileys. Cukup kirim batch.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const FONNTE_SEND_URL   = 'https://api.fonnte.com/send';
const FONNTE_DEVICE_URL = 'https://api.fonnte.com/device';

// Normalisasi nomor: 08xxx → 62xxx, buang non-digit. Fonnte juga bisa handle via
// countryCode, tapi kita normalkan supaya konsisten dgn data customer.
function normalizeNumber(to) {
  let d = String(to || '').replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

// Ambil token dari objek session (row WaSession) — bisa multi-token (rotator).
function getToken(session) {
  const t = (session && session.fonnte_token || '').trim();
  if (!t) throw new Error('Fonnte token belum diisi untuk session ini');
  return t;
}

// ── Kirim 1 pesan teks ──────────────────────────────────────
async function sendMessage(session, to, message, io) {
  const token  = getToken(session);
  const target = normalizeNumber(to);

  const form = new FormData();
  form.append('target', target);
  form.append('message', message);
  form.append('countryCode', '62');

  let resp;
  // Retry ringan hanya untuk error jaringan/timeout (bukan penolakan logis).
  const maxTries = 3;
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      resp = await axios.post(FONNTE_SEND_URL, form, {
        headers: { 'Authorization': token },
        timeout: 30000,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Kalau server Fonnte membalas (ada response), itu penolakan logis —
      // jangan retry, langsung lempar.
      if (e.response) {
        const detail = e.response.data ? JSON.stringify(e.response.data) : e.message;
        throw new Error('Fonnte API error: ' + detail);
      }
      // Tak ada response = masalah jaringan/timeout → retry dgn jeda.
      if (i < maxTries - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  if (lastErr) {
    throw new Error('Fonnte API error (jaringan, setelah ' + maxTries + ' percobaan): ' + lastErr.message);
  }

  const data = resp.data || {};
  // Fonnte balas { status: true/false, id: [...], detail, reason, ... }
  if (data.status === false) {
    throw new Error('Fonnte gagal kirim: ' + (data.reason || data.detail || 'unknown'));
  }
  const waId = Array.isArray(data.id) ? String(data.id[0] || '') : String(data.id || '');

  // Simpan ke DB (konsisten dgn WAService) — best-effort.
  await _logOutbound(session, target, message, 'text', waId, null, io);

  return { key: { id: waId, remoteJid: target }, fonnte: data };
}

// ── Kirim media (image/video/audio/document) lewat URL atau file lokal ──
// Fonnte menerima param `url` (link media) ATAU `file` (upload). Kita pakai URL
// kalau opts.mediaUrl tersedia; kalau hanya path lokal, baca & upload sbg Blob.
async function sendMedia(session, opts, io) {
  const token  = getToken(session);
  const { to, mediaPath, mediaUrl, caption, fileName } = opts || {};
  if (!to) throw new Error('Parameter "to" wajib');
  const target = normalizeNumber(to);

  const form = new FormData();
  form.append('target', target);
  if (caption) form.append('message', caption);
  form.append('countryCode', '62');
  if (fileName) form.append('filename', fileName);

  if (mediaUrl) {
    // Mode URL — Fonnte mengunduh sendiri dari link
    form.append('url', mediaUrl);
  } else if (mediaPath) {
    // Mode upload file lokal
    const fs = require('fs');
    if (!fs.existsSync(mediaPath)) throw new Error('File tidak ditemukan: ' + mediaPath);
    const buf  = fs.readFileSync(mediaPath);
    const path = require('path');
    const blob = new Blob([buf]);
    form.append('file', blob, fileName || path.basename(mediaPath));
  } else {
    throw new Error('Butuh mediaUrl atau mediaPath untuk kirim media');
  }

  let resp;
  try {
    resp = await axios.post(FONNTE_SEND_URL, form, {
      headers: { 'Authorization': token },
      timeout: 60000,
    });
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error('Fonnte API error (media): ' + detail);
  }

  const data = resp.data || {};
  if (data.status === false) {
    throw new Error('Fonnte gagal kirim media: ' + (data.reason || data.detail || 'unknown'));
  }
  const waId = Array.isArray(data.id) ? String(data.id[0] || '') : String(data.id || '');
  await _logOutbound(session, target, caption || '[media]', 'document', waId, mediaUrl || null, io);

  return { key: { id: waId, remoteJid: target }, fonnte: data };
}

// ── Broadcast ───────────────────────────────────────────────
// Fonnte mendukung multi-target dalam 1 request (pisah koma) + param `delay`
// dengan rentang acak "min-max" (detik) yang dieksekusi di sisi server Fonnte.
// Jauh lebih efisien daripada loop manual: 1 request untuk banyak nomor.
// Kita tetap chunk supaya target string tidak kepanjangan & progress terlacak.
async function sendBroadcast(session, numbers, message, io) {
  const res = { success: 0, failed: 0, errors: [] };
  const token = getToken(session);
  const total = Array.isArray(numbers) ? numbers.length : 0;
  if (!total) return res;

  // Delay acak antar pesan di sisi Fonnte (detik). Bisa di-override via env.
  const delayMin = parseInt(process.env.FONNTE_DELAY_MIN || '4');
  const delayMax = parseInt(process.env.FONNTE_DELAY_MAX || '12');
  const delayRange = `${delayMin}-${delayMax}`;

  // Chunk per 50 nomor agar string target tidak terlalu panjang.
  const CHUNK = parseInt(process.env.FONNTE_CHUNK || '50');
  const sessionId = session.session_id;

  for (let i = 0; i < numbers.length; i += CHUNK) {
    const chunk  = numbers.slice(i, i + CHUNK).map(normalizeNumber);
    const target = chunk.join(',');

    const form = new FormData();
    form.append('target', target);
    form.append('message', message);
    form.append('countryCode', '62');
    form.append('delay', delayRange); // delay acak di server Fonnte

    try {
      const resp = await axios.post(FONNTE_SEND_URL, form, {
        headers: { 'Authorization': token },
        timeout: 60000,
      });
      const data = resp.data || {};
      if (data.status === false) {
        // Sebagian/semua chunk gagal
        res.failed += chunk.length;
        res.errors.push({ chunk: i / CHUNK, error: data.reason || data.detail || 'unknown' });
      } else {
        // Fonnte mengembalikan array id untuk yang sukses
        const okCount = Array.isArray(data.id) ? data.id.length : chunk.length;
        res.success += okCount;
        if (okCount < chunk.length) res.failed += (chunk.length - okCount);
        // Log per nomor (best-effort, ringan)
        for (const num of chunk) {
          await _logOutbound(session, num, message, 'text', '', null, null).catch(() => {});
        }
      }
    } catch (e) {
      res.failed += chunk.length;
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      res.errors.push({ chunk: i / CHUNK, error: detail });
    }

    if (io) io.emit('wa:broadcast:progress:' + sessionId, {
      sent: res.success, failed: res.failed, total, current: Math.min(i + CHUNK, total)
    });
  }

  logger.info(`[Fonnte] Broadcast selesai [${sessionId}]: ${res.success} terkirim, ${res.failed} gagal`);
  if (io) io.emit('wa:broadcast:done:' + sessionId, { sent: res.success, failed: res.failed, total });
  return res;
}

// ── Cek status device di Fonnte ─────────────────────────────
// Mengembalikan raw response Fonnte. Bila gagal jaringan/timeout, objek
// mengandung _netError:true supaya pemanggil bisa membedakan "device offline"
// dari "gagal cek" (transient). Ada retry ringan utk menahan blip sesaat.
async function getDeviceStatus(token) {
  const attempts = 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const form = new FormData();
      const resp = await axios.post(FONNTE_DEVICE_URL, form, {
        headers: { 'Authorization': token },
        timeout: 15000,
      });
      return resp.data || {};
    } catch (e) {
      lastErr = e;
      // Jeda singkat sebelum retry (250ms, 500ms) — hanya utk error jaringan.
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  logger.warn('[Fonnte] getDeviceStatus error (after ' + attempts + ' tries): ' + (lastErr && lastErr.message));
  return { _netError: true, status: false, error: lastErr && lastErr.message };
}

// Tri-state: 'connected' | 'disconnected' | 'unknown'
// 'unknown' = gagal cek ATAU respons ambigu → JANGAN vonis offline.
async function checkConnection(session) {
  try {
    const token = getToken(session);
    const dev = await getDeviceStatus(token);
    if (dev && dev._netError) return 'unknown';        // gagal jaringan → jangan vonis

    // Fonnte /device bisa membalas beberapa bentuk:
    //   { device_status: "connect" | "disconnect" | "connecting", ... }
    //   { data: [ { device, status: "connect"|"disconnect" } ] }
    //   { status: true, ... }  ← status:true di sini = API call sukses, BUKAN
    //                             status koneksi device. Jangan dianggap connected.
    let raw = dev.device_status;
    if (!raw && Array.isArray(dev.data) && dev.data[0]) {
      raw = dev.data[0].device_status || dev.data[0].status;
    }
    if (!raw && typeof dev.status === 'string') raw = dev.status;

    const st = String(raw || '').toLowerCase();
    if (!st) return 'unknown';                          // tak ada info status → ambigu

    if (st === 'connect' || st === 'connected') return 'connected';
    if (st === 'disconnect' || st === 'disconnected' || st === 'not connected') return 'disconnected';
    if (st === 'connecting' || st === 'loading' || st === 'scan') return 'unknown'; // transisi
    return 'unknown';                                   // nilai tak dikenal → jangan vonis
  } catch (_) {
    return 'unknown';
  }
}

async function isConnected(session) {
  // Boolean kompat lama: 'unknown' dianggap tidak-terkonfirmasi (false).
  // Untuk logika status yg stabil, gunakan checkConnection (tri-state).
  return (await checkConnection(session)) === 'connected';
}

async function getSessionStatus(session) {
  return (await isConnected(session)) ? 'connected' : 'disconnected';
}

// ── Helper: simpan pesan keluar ke wa_messages ──────────────
async function _logOutbound(session, target, message, type, waId, mediaUrl, io) {
  try {
    const { WaMessage, Customer } = require('../models');
    const { Op } = require('sequelize');
    const fromNumber = session.phone_number || session.session_id;

    // Resolve customer dari nomor (multi-format lookup ringan)
    let customerId = null;
    try {
      const clean = String(target).replace(/[^0-9]/g, '');
      if (clean.length >= 9) {
        const last9 = clean.slice(-9);
        const cust = await Customer.findOne({
          where: { phone: { [Op.like]: '%' + last9 } },
          attributes: ['id'],
        });
        if (cust) customerId = cust.id;
      }
    } catch (_) {}

    const row = await WaMessage.create({
      session_id:   session.session_id,
      direction:    'outbound',
      from_number:  fromNumber,
      to_number:    target,
      message:      message || '',
      message_type: type || 'text',
      status:       waId ? 'sent' : 'pending',
      wa_message_id: waId || null,
      media_url:    mediaUrl || null,
      customer_id:  customerId,
    });

    if (io) io.emit('wa:message:' + session.session_id, {
      direction: 'outbound', to: target, message, status: row.status, ts: Date.now()
    });
  } catch (e) {
    logger.warn('[Fonnte] _logOutbound gagal: ' + e.message);
  }
}

// ── Handler WEBHOOK pesan MASUK dari Fonnte ─────────────────
// Fonnte mengirim POST ke webhook URL kita saat ada pesan masuk. Payload:
//   device   : nomor device penerima (nomor WA bisnis kita di Fonnte)
//   sender   : nomor pengirim (customer)
//   message  : isi teks pesan
//   name     : pushName pengirim
//   url/filename/extension : lampiran (paket all-feature)
//   location : "lat,lng" bila kirim lokasi
// Fungsi ini: cari session fonnte yang cocok, simpan WaMessage inbound,
// resolve customer, emit ke UI, kirim notif, jalankan auto-reply.
async function handleWebhook(payload, io) {
  const { WaSession, WaMessage, WaAutoReply, Customer } = require('../models');
  const { Op } = require('sequelize');

  // Log payload mentah (untuk diagnosa: lihat field apa yang dikirim Fonnte,
  // khususnya saat balas dari HP — apakah ada penanda arah pesan keluar).
  try { logger.info('[Fonnte] Webhook payload: ' + JSON.stringify(payload).slice(0, 600)); } catch (_) {}

  const sender  = normalizeNumber(payload.sender || payload.from || '');
  const device  = normalizeNumber(payload.device || '');
  const text    = payload.message || payload.text || '';
  const pushName = payload.name || '';
  if (!sender) { logger.warn('[Fonnte] Webhook tanpa sender, diabaikan'); return { ok: false, reason: 'no_sender' }; }

  // Deteksi pesan KELUAR (dikirim dari HP/device kita sendiri). Fonnte dapat
  // mengirim webhook untuk pesan keluar; penandanya bervariasi antar versi:
  // fromMe / from_me / fromme / direction:"out" / outgoing, atau sender==device.
  const dir = String(payload.direction || payload.type || '').toLowerCase();
  const fromMeFlag = payload.fromMe === true || payload.fromMe === 'true'
                  || payload.from_me === true || payload.from_me === 'true'
                  || payload.fromme === true || payload.fromme === 'true'
                  || payload.outgoing === true || payload.outgoing === 'true'
                  || dir === 'out' || dir === 'outgoing' || dir === 'outbound'
                  || (device && sender && normalizeNumber(sender) === device);

  // Cari session provider=fonnte yang cocok dgn device (phone_number).
  // Kalau hanya ada 1 session fonnte, pakai itu. Kalau device tidak match,
  // fallback ke session fonnte pertama yang aktif.
  let session = null;
  try {
    const fonnteSessions = await WaSession.findAll({ where: { provider: 'fonnte' } });
    if (device) {
      session = fonnteSessions.find(s => normalizeNumber(s.phone_number) === device) || null;
    }
    if (!session) session = fonnteSessions[0] || null;
  } catch (e) {
    logger.error('[Fonnte] Webhook: gagal ambil session: ' + e.message);
  }
  if (!session) { logger.warn('[Fonnte] Webhook: tidak ada session fonnte terdaftar'); return { ok: false, reason: 'no_session' }; }

  const sessionId = session.session_id;

  // ── Tentukan tipe & media ──
  let msgType = 'text';
  let mediaUrl = null;
  if (payload.url) {
    const ext = String(payload.extension || '').toLowerCase();
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) msgType = 'image';
    else if (['mp4','3gp','mov'].includes(ext)) msgType = 'video';
    else if (['ogg','mp3','m4a','aac','wav'].includes(ext)) msgType = 'audio';
    else msgType = 'document';
    mediaUrl = payload.url; // URL lampiran di server Fonnte
  } else if (payload.location) {
    msgType = 'location';
  }

  // ── Resolve customer dari nomor sender ──
  let customer = null;
  try {
    const clean = sender.replace(/[^0-9]/g, '');
    if (clean.length >= 9) {
      const last9 = clean.slice(-9);
      customer = await Customer.findOne({
        where: { phone: { [Op.like]: '%' + last9 } },
        attributes: ['id', 'name'],
      });
    }
  } catch (_) {}

  // ── Idempotensi: hindari duplikat kalau Fonnte retry (id sama) ──
  const waId = payload.id ? String(payload.id) : null;
  if (waId) {
    try {
      const dup = await WaMessage.findOne({ where: { wa_message_id: waId, direction: 'inbound' } });
      if (dup) return { ok: true, duplicate: true };
    } catch (_) {}
  }

  // ── Jika pesan KELUAR (dari HP kita) → simpan sebagai outbound & stop ──
  if (fromMeFlag) {
    // Nomor lawan chat (penerima). Coba beberapa kemungkinan field Fonnte.
    const target = normalizeNumber(payload.target || payload.to || payload.receiver || '');
    const toNum = target || sender; // fallback
    if (!toNum) return { ok: false, reason: 'no_target' };

    // Dedup terhadap pesan yang dikirim via aplikasi (sudah tersimpan outbound)
    if (waId) {
      try {
        const dup = await WaMessage.findOne({ where: { wa_message_id: waId, direction: 'outbound' } });
        if (dup) return { ok: true, duplicate: true };
      } catch (_) {}
    }

    // Korelasi customer dari nomor tujuan
    let cust = null;
    try {
      const clean = toNum.replace(/[^0-9]/g, '');
      if (clean.length >= 9) {
        cust = await Customer.findOne({
          where: { phone: { [Op.like]: '%' + clean.slice(-9) } },
          attributes: ['id', 'name'],
        });
      }
    } catch (_) {}

    const outBody = text || (msgType === 'location' ? '[location]' : '[' + msgType + ']');
    try {
      await WaMessage.create({
        session_id:   sessionId,
        direction:    'outbound',
        from_number:  session.phone_number || device || sessionId,
        to_number:    toNum,
        message:      outBody,
        message_type: msgType,
        media_url:    mediaUrl,
        status:       'sent',
        wa_message_id: waId,
        push_name:    null,
        customer_id:  cust?.id || null,
      });
    } catch (e) {
      logger.error('[Fonnte] Webhook: gagal simpan outbound: ' + e.message);
    }
    if (io) io.emit('wa:message:' + sessionId, {
      direction: 'outbound', to: toNum, text: outBody,
      message_type: msgType, media_url: mediaUrl,
      customer: cust ? { id: cust.id, name: cust.name } : null,
      fromDevice: true, timestamp: new Date(),
    });
    return { ok: true, outbound: true };
  }

  // ── Simpan inbound ──
  const bodyText = text || (msgType === 'location' ? '[location]' : '[' + msgType + ']');
  try {
    await WaMessage.create({
      session_id:   sessionId,
      direction:    'inbound',
      from_number:  sender,
      to_number:    session.phone_number || device || sessionId,
      message:      bodyText,
      message_type: msgType,
      media_url:    mediaUrl,
      status:       'delivered',
      wa_message_id: waId,
      push_name:    pushName || null,
      customer_id:  customer?.id || null,
    });
  } catch (e) {
    logger.error('[Fonnte] Webhook: gagal simpan WaMessage: ' + e.message);
  }

  // ── Emit ke UI (format sama dgn Baileys) ──
  if (io) io.emit('wa:message:' + sessionId, {
    direction: 'inbound', from: sender, text: bodyText,
    message_type: msgType, media_url: mediaUrl, pushName,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    timestamp: new Date(),
  });

  // ── Notifikasi WA masuk ──
  try {
    const NotifSvc = require('./NotificationService');
    await NotifSvc.notifyWaIncoming(sender, bodyText, session.name || sessionId);
  } catch (_) {}

  // ── Auto-reply (kalau diaktifkan di session) ──
  try {
    if (session.auto_reply_enabled && text) {
      const rules = await WaAutoReply.findAll({ where: { session_id: sessionId, is_active: true } });
      const lower = text.toLowerCase();
      for (const rule of rules) {
        const kw = (rule.keyword || '').toLowerCase();
        const hit = rule.match_type === 'exact' ? lower === kw
          : rule.match_type === 'startswith' ? lower.startsWith(kw)
          : lower.includes(kw);
        if (hit) {
          await sendMessage(session, sender, rule.reply_message, io);
          await rule.increment('hit_count');
          break;
        }
      }
    }
  } catch (e) {
    logger.warn('[Fonnte] Auto-reply gagal: ' + e.message);
  }

  return { ok: true };
}

module.exports = {
  sendMessage,
  sendMedia,
  sendBroadcast,
  isConnected,
  checkConnection,
  getSessionStatus,
  getDeviceStatus,
  normalizeNumber,
  handleWebhook,
};
