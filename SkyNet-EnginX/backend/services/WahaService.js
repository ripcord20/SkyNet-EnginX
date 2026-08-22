/**
 * WahaService.js — Provider WA Gateway via WAHA (self-hosted, HTTP API)
 * ---------------------------------------------------------------------
 * WAHA = WhatsApp HTTP API (https://waha.devlike.pro) yang berjalan sebagai
 * container Docker TERPISAH dari FLAYNET-CRM. Session WA hidup di WAHA, bukan
 * di proses Node aplikasi ini — jadi restart/deploy CRM tidak memutus koneksi
 * WA (beda dengan Baileys embedded di WAService.js).
 *
 * Konfigurasi per-session (kolom wa_sessions):
 *   waha_url     : base URL instance WAHA, mis. http://127.0.0.1:3001
 *   waha_api_key : API key (env WHATSAPP_API_KEY di container WAHA)
 *   waha_session : nama session di sisi WAHA (default 'default')
 *
 * Endpoint WAHA yang dipakai:
 *   POST /api/sendText                        → kirim teks
 *   POST /api/sendImage|sendVideo|sendFile|sendVoice → kirim media (base64)
 *   GET  /api/sessions/{name}                 → info & status session
 *   POST /api/sessions/{name}/start|stop|logout
 *   POST /api/sessions                        → buat session baru (+webhook)
 *   GET  /api/{name}/auth/qr?format=image     → QR PNG untuk pairing
 *   GET  /api/contacts/profile-picture        → foto profil kontak
 *
 * Status session WAHA: STARTING → SCAN_QR_CODE → WORKING (juga STOPPED/FAILED).
 * Pemetaan ke status internal: WORKING=connected, SCAN_QR_CODE/STARTING=
 * connecting, selainnya=disconnected.
 *
 * Interface dibuat MIRIP FonnteService supaya GatewayService memanggil seragam:
 *   sendMessage(session, to, message, io)
 *   sendMedia(session, opts, io)
 *   sendBroadcast(session, numbers, message, io)
 *   checkConnection(session)  → 'connected' | 'disconnected' | 'unknown'
 *   handleWebhook(payload, io)
 *
 * CATATAN: WAHA tidak punya delay server-side seperti Fonnte, jadi broadcast
 * memakai jeda acak di sisi kita (pola sama dengan throttle Baileys) supaya
 * nomor tidak kena soft-ban.
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');

// ── Dedup lock in-memory untuk webhook pesan ────────────────
// WAHA bisa mengirim webhook dobel untuk pesan yang sama (retry, atau session
// lama yang masih berlangganan 'message' + 'message.any'). Cek idempotensi
// berbasis DB (findOne→create) punya jendela balapan: dua event tiba nyaris
// bersamaan, keduanya lolos findOne sebelum salah satu sempat create → row
// dobel. Lock ini menyerialkan penanganan per-message-id di dalam proses ini
// sehingga event kedua langsung ditolak. Murni in-memory; auto-bersih.
const _msgSeen = new Map(); // waId -> timestamp
const _MSG_SEEN_TTL = 60 * 1000;
let _msgSeenSweepAt = 0;
// return true bila id ini BARU (belum terlihat); false bila duplikat.
function _claimMessageId(waId) {
  if (!waId) return true; // tanpa id, tak bisa di-lock di sini — biar cek DB yang urus
  const now = Date.now();
  if (now - _msgSeenSweepAt > _MSG_SEEN_TTL) {
    _msgSeenSweepAt = now;
    for (const [k, t] of _msgSeen) if (now - t > _MSG_SEEN_TTL) _msgSeen.delete(k);
  }
  if (_msgSeen.has(waId)) return false;
  _msgSeen.set(waId, now);
  return true;
}

// ── Konfigurasi & helper dasar ──────────────────────────────

// Cocokkan pesan masuk dgn keyword auto-reply. keyword bisa berisi BEBERAPA
// kata dipisah koma (mis. "terimakasih, makasih, mksih") — pesan cocok bila
// mengandung/sama dengan/berawalan SALAH SATU kata tsb. Tanpa ini, keyword
// multi-kata dibandingkan sebagai satu string utuh sehingga tak pernah cocok.
//   exact      → salah satu kata sama persis dgn seluruh isi pesan
//   startswith → pesan diawali salah satu kata
//   contains   → pesan mengandung salah satu kata (default)
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

// Normalisasi nomor: 08xxx → 62xxx, buang non-digit (konsisten dgn Fonnte).
function normalizeNumber(to) {
  let d = String(to || '').replace(/[^0-9]/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

// chatId format WAHA: '628xxxx@c.us'
function toChatId(to) {
  const raw = String(to || '');
  if (raw.includes('@')) return raw; // sudah JID (mis. dari webhook)
  return normalizeNumber(raw) + '@c.us';
}

// Ambil config dari row WaSession; lempar error jelas kalau belum diisi.
function getConfig(session) {
  const baseUrl = String(session && session.waha_url || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('URL WAHA belum diisi untuk session ini');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('URL WAHA harus diawali http:// atau https://');
  return {
    baseUrl,
    apiKey:      String(session.waha_api_key || '').trim(),
    wahaSession: String(session.waha_session || 'default').trim() || 'default',
  };
}

// Axios instance per panggilan (config bisa berubah dari UI kapan saja).
function api(session, timeoutMs) {
  const cfg = getConfig(session);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey;
  return {
    cfg,
    http: axios.create({ baseURL: cfg.baseUrl, headers, timeout: timeoutMs || 30000 }),
  };
}

// Ringkas pesan error axios agar log/toast enak dibaca.
function errDetail(e) {
  if (e.response) {
    const body = e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
    return 'HTTP ' + e.response.status + (body ? ' — ' + body : '');
  }
  return e.message;
}

function randBetween(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Kirim 1 pesan teks ──────────────────────────────────────
// opts (opsional): { replyToId, replyToText } → dikirim sbg quote/reply.
// reply_to WAHA menerima message ID; id raw bekerja utk NOWEB/GOWS (basis
// Baileys pakai raw id). Utk WEBJS yang butuh bentuk serialized, WAHA
// menoleransi raw di versi baru — kalau gagal, pesan tetap terkirim polos.
async function sendMessage(session, to, message, io, opts) {
  const { cfg, http } = api(session);
  const chatId = toChatId(to);
  const replyToId = opts && opts.replyToId ? normalizeMsgId(opts.replyToId) : null;
  // reply_to dlm format yang dimengerti engine session ini.
  // fromMe: pesan yang dibalas bisa milik kita ATAU milik customer — kita tahu
  // dari opts.replyToFromMe (dikirim controller); default false (balas pesan customer).
  let replyToWire = null;
  if (replyToId) {
    replyToWire = await formatIdForEngine(session, replyToId, chatId, opts && opts.replyToFromMe === true);
  }

  let resp;
  // Retry ringan hanya untuk error jaringan/timeout (bukan penolakan logis).
  const maxTries = 3;
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      resp = await http.post('/api/sendText', {
        session: cfg.wahaSession,
        chatId,
        text: message,
        reply_to: replyToWire || undefined,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Server WAHA membalas (ada response) = penolakan logis → jangan retry...
      if (e.response) {
        // ...KECUALI: gagal karena reply_to (id tak ditemukan di engine) →
        // kirim ulang POLOS agar pesan tetap sampai; quote tetap tampil di CRM.
        if (replyToWire) {
          logger.warn('[WAHA] Kirim dgn reply_to gagal (' + errDetail(e) + ') — kirim ulang tanpa quote');
          replyToWire = null;
          continue;
        }
        throw new Error('WAHA API error: ' + errDetail(e));
      }
      if (i < maxTries - 1) await sleep(400 * (i + 1));
    }
  }
  if (lastErr) {
    throw new Error('WAHA API error (jaringan, setelah ' + maxTries + ' percobaan): ' + lastErr.message);
  }

  // Respons WAHA (WebJS/NOWEB/GOWS): objek message dgn id / key.id / id.id
  const data = resp.data || {};
  const waId = extractMessageId(data);

  await _logOutbound(session, normalizeNumber(to), message, 'text', waId, null, io, {
    replyToId,
    replyToText: (opts && opts.replyToText) || null,
  });
  return { key: { id: waId, remoteJid: chatId }, waha: data };
}

// ── Hapus pesan "untuk semua" ───────────────────────────────
// DELETE /api/{session}/chats/{chatId}/messages/{messageId}
// Hanya berlaku utk pesan KELUAR milik kita, dlm jendela waktu WhatsApp.
async function deleteMessage(session, chatTarget, messageId) {
  const { cfg, http } = api(session, 20000);
  const chatId = toChatId(chatTarget);
  const raw = normalizeMsgId(messageId);
  if (!raw) throw new Error('Message ID kosong');

  // PENTING (spesifikasi WAHA terbaru): karakter '@' di chatId & messageId pada
  // path di-escape sebagai '%40' — persis yang dihasilkan encodeURIComponent.
  // Ref: https://waha.devlike.pro/docs/how-to/chats/ (bagian Delete message):
  //   DELETE /api/{session}/chats/123%40c.us/messages/true_123%40c.us_AAA
  const doDelete = (mid) => http.delete(
    '/api/' + encodeURIComponent(cfg.wahaSession) +
    '/chats/' + encodeURIComponent(chatId) +
    '/messages/' + encodeURIComponent(mid)
  );

  // Format ID sesuai engine tujuan (WEBJS/WPP butuh 'true_{chatId}_{raw}',
  // NOWEB/GOWS pakai raw). Pakai helper bersama supaya konsisten dgn jalur kirim,
  // dan getEngine hanya dipanggil sekali (cache). fromMe=true: hapus "untuk semua"
  // hanya berlaku utk pesan KELUAR milik kita.
  const primary = await formatIdForEngine(session, raw, chatId, true);
  // Fallback: kalau format utama gagal (cache engine basi / perbedaan perilaku
  // antar versi WAHA), coba bentuk satunya.
  const serialized = 'true_' + chatId + '_' + raw;
  const secondary = primary === raw ? serialized : raw;

  const engineForLog = await getEngine(session);
  const tried = [];
  logger.info('[WAHA] deleteMessage start: engine=' + engineForLog + ' chatId=' + chatId +
    ' rawId=' + raw + ' primary=' + primary + ' secondary=' + secondary);
  try {
    tried.push(primary);
    await doDelete(primary);
    logger.info('[WAHA] deleteMessage OK via primary=' + primary);
    return true;
  } catch (e1) {
    logger.warn('[WAHA] deleteMessage primary gagal (' + primary + '): ' + errDetail(e1));
    try {
      if (secondary === primary) throw e1; // tak ada alternatif berbeda
      tried.push(secondary);
      await doDelete(secondary);
      logger.info('[WAHA] deleteMessage OK via secondary=' + secondary);
      return true;
    } catch (e2) {
      logger.warn('[WAHA] deleteMessage secondary gagal (' + secondary + '): ' + errDetail(e2));
      throw new Error('WAHA hapus pesan gagal (engine=' + engineForLog +
        ', id tried: ' + tried.join(', ') + '): ' + errDetail(e1));
    }
  }
}

// Normalisasi message ID ke bentuk RAW yang konsisten antara respons kirim
// dan payload webhook. Masalahnya: WEBJS/NOWEB mengirim ID webhook dalam
// bentuk serialized 'true_628xx@c.us_ABC123' (kadang + suffix), sedangkan
// respons kirim memberi raw 'ABC123' — dedup by exact match jadi MELESET dan
// pesan keluar tercatat DOBEL (sekali dari _logOutbound, sekali dari webhook
// fromMe). Solusi: selalu simpan & bandingkan bentuk raw-nya.
//
// PENTING utk HAPUS PESAN: WAHA kadang menambahkan suffix '_out' (atau '_in')
// di akhir ID utk pesan ke/dari nomor sendiri. Kalau suffix ini ikut terbawa,
// endpoint DELETE WAHA mengembalikan objek kosong / gagal menarik pesan
// (lihat WAHA discussion #687). Karena itu suffix arah ('_out'/'_in') dan
// segmen participant (ber-@) DIBUANG di sini supaya raw id benar-benar bersih.
function normalizeMsgId(id) {
  if (!id) return '';
  let s = '';
  if (typeof id === 'string') s = id;
  else if (typeof id === 'object') s = String(id._serialized || id.id || '');
  if (!s) return '';
  // Buang suffix metadata '|jid:...|name:...' (pola penyimpanan jalur Baileys)
  if (s.includes('|')) s = s.split('|')[0];
  // Bentuk serialized STRIKT: 'true|false_<jid>_<RAWID>[_<participant@...>][_out|_in]'
  // Deteksi hanya kalau pola persis (awalan true/false + segmen JID), supaya
  // raw id yang kebetulan mengandung underscore TIDAK ikut termutilasi.
  if (s.includes('_')) {
    const parts = s.split('_');
    if ((parts[0] === 'true' || parts[0] === 'false') && parts[1] && parts[1].includes('@')) {
      // id asli = semua segmen setelah JID, buang segmen participant (ber-@)
      // DAN suffix arah '_out'/'_in' di ujung.
      s = parts.slice(2)
        .filter(p => !p.includes('@'))
        .filter(p => p !== 'out' && p !== 'in')
        .join('_');
    }
  }
  // Jaring pengaman: buang suffix arah di ujung utk bentuk RAW polos juga
  // (mis. '3EB0...AEE6_out' → '3EB0...AEE6').
  s = s.replace(/_(?:out|in)$/i, '');
  return s;
}

// Ambil message ID dari respons WAHA (bentuknya beda antar engine).
function extractMessageId(data) {
  if (!data) return '';
  let raw = '';
  if (typeof data.id === 'string') raw = data.id;
  else if (data.id && typeof data.id.id === 'string') raw = data.id.id;             // WEBJS
  else if (data.id && data.id._serialized) raw = String(data.id._serialized);       // WEBJS
  else if (data.key && data.key.id) raw = String(data.key.id);                      // NOWEB/GOWS
  else if (data._data && data._data.id && data._data.id.id) raw = String(data._data.id.id);
  return normalizeMsgId(raw);
}

// ── Kirim media (image/video/audio/document) ─────────────────
// opts: { to, mediaPath, mediaUrl, mediaType, caption, mimeType, fileName }
// WAHA menerima file sebagai { mimetype, filename, url } ATAU { mimetype,
// filename, data } (base64). Kita pakai URL kalau tersedia, selain itu baca
// file lokal → base64.
async function sendMedia(session, opts, io) {
  const { cfg, http } = api(session, 60000);
  const { to, mediaPath, mediaUrl, mediaType, caption, mimeType, fileName } = opts || {};
  if (!to) throw new Error('Parameter "to" wajib');
  const chatId = toChatId(to);

  // Tentukan endpoint + default mimetype berdasarkan tipe media
  let endpoint, defMime;
  if (mediaType === 'image')      { endpoint = '/api/sendImage'; defMime = 'image/jpeg'; }
  else if (mediaType === 'video') { endpoint = '/api/sendVideo'; defMime = 'video/mp4'; }
  else if (mediaType === 'audio') { endpoint = '/api/sendVoice'; defMime = 'audio/ogg; codecs=opus'; }
  else                            { endpoint = '/api/sendFile';  defMime = 'application/octet-stream'; }

  const file = { mimetype: mimeType || defMime };
  if (mediaUrl) {
    file.url = mediaUrl;
    if (fileName) file.filename = fileName;
  } else if (mediaPath) {
    if (!fs.existsSync(mediaPath)) throw new Error('File tidak ditemukan: ' + mediaPath);
    file.filename = fileName || path.basename(mediaPath);
    file.data = fs.readFileSync(mediaPath).toString('base64');
  } else {
    throw new Error('Butuh mediaUrl atau mediaPath untuk kirim media');
  }

  let resp;
  try {
    resp = await http.post(endpoint, {
      session: cfg.wahaSession,
      chatId,
      file,
      caption: caption || undefined,
    });
  } catch (e) {
    throw new Error('WAHA API error (media): ' + errDetail(e));
  }

  const data = resp.data || {};
  const waId = extractMessageId(data);
  const logType = toDbMsgType(mediaType || 'document');
  // URL utk bubble chat: kalau file diupload lewat chat CRM (multer menaruhnya
  // di uploads/...), pakai URL lokal supaya preview langsung tampil. File TIDAK
  // dihapus setelah kirim — memang jadi arsip riwayat chat.
  let publicUrl = mediaUrl || null;
  if (!publicUrl && mediaPath) {
    const norm = String(mediaPath).replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/uploads/');
    if (idx !== -1) publicUrl = norm.slice(idx); // → '/uploads/media/wa_out_...'
  }
  await _logOutbound(session, normalizeNumber(to), caption || '[media]', logType, waId, publicUrl, io);

  return { key: { id: waId, remoteJid: chatId }, waha: data };
}

// ── Broadcast ───────────────────────────────────────────────
// WAHA tidak punya delay server-side → jeda acak di sisi kita (pola sama dgn
// throttle Baileys di WAService: jeda antar pesan + jeda batch) supaya pola
// kirim terlihat manusiawi dan nomor tidak kena soft-ban.
const WAHA_BC_CFG = {
  minDelayMs:      parseInt(process.env.WAHA_BC_MIN_DELAY       || '4000'),
  maxDelayMs:      parseInt(process.env.WAHA_BC_MAX_DELAY       || '12000'),
  batchSize:       parseInt(process.env.WAHA_BC_BATCH_SIZE      || '20'),
  batchPauseMinMs: parseInt(process.env.WAHA_BC_BATCH_PAUSE_MIN || '60000'),
  batchPauseMaxMs: parseInt(process.env.WAHA_BC_BATCH_PAUSE_MAX || '180000'),
};

async function sendBroadcast(session, numbers, message, io) {
  const res = { success: 0, failed: 0, errors: [] };
  const total = Array.isArray(numbers) ? numbers.length : 0;
  if (!total) return res;
  const sessionId = session.session_id;

  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    try {
      await sendMessage(session, num, message, io);
      res.success++;
    } catch (e) {
      res.failed++;
      res.errors.push({ number: num, error: e.message });
      logger.warn('[WAHA] Broadcast gagal ke ' + num + ': ' + e.message);
    }

    if (io) io.emit('wa:broadcast:progress:' + sessionId, {
      sent: res.success, failed: res.failed, total, current: i + 1
    });

    // Jeda antar pesan + jeda batch (kecuali pesan terakhir)
    if (i < numbers.length - 1) {
      if ((i + 1) % WAHA_BC_CFG.batchSize === 0) {
        const pause = randBetween(WAHA_BC_CFG.batchPauseMinMs, WAHA_BC_CFG.batchPauseMaxMs);
        logger.info('[WAHA] Broadcast jeda batch ' + Math.round(pause / 1000) + 's setelah ' + (i + 1) + ' pesan');
        await sleep(pause);
      } else {
        await sleep(randBetween(WAHA_BC_CFG.minDelayMs, WAHA_BC_CFG.maxDelayMs));
      }
    }
  }

  logger.info(`[WAHA] Broadcast selesai: ${res.success} terkirim, ${res.failed} gagal`);
  if (io) io.emit('wa:broadcast:done:' + sessionId, { sent: res.success, failed: res.failed, total });
  return res;
}

// ── Session lifecycle (start / stop / logout / QR) ──────────

// Info session dari WAHA. Return objek { status, me, ... } atau lempar error.
async function getSessionInfo(session) {
  const { cfg, http } = api(session, 12000);
  const resp = await http.get('/api/sessions/' + encodeURIComponent(cfg.wahaSession));
  return resp.data || {};
}

// Pemetaan status WAHA → status internal wa_sessions.status
function mapStatus(wahaStatus) {
  const s = String(wahaStatus || '').toUpperCase();
  if (s === 'WORKING') return 'connected';
  if (s === 'SCAN_QR_CODE' || s === 'STARTING') return 'connecting';
  return 'disconnected'; // STOPPED / FAILED / unknown
}

// Start session di WAHA. Kalau session belum ada di WAHA (404) → buat baru,
// sekalian daftarkan webhook ke aplikasi ini (pakai APP_URL kalau tersedia).
// Daftar event webhook yang dibutuhkan aplikasi. 'message.ack' WAJIB ada agar
// status centang (sent/delivered/read) terkirim ke CRM.
//
// CATATAN DEDUP: JANGAN daftarkan 'message' DAN 'message.any' bersamaan.
// 'message.any' sudah mencakup pesan MASUK (fromMe=false) maupun pesan yang
// dikirim dari HP (fromMe=true). Bila 'message' ikut didaftarkan, setiap pesan
// masuk memicu DUA webhook (message + message.any) yang tiba nyaris bersamaan →
// balapan cek idempotensi → row tersimpan dobel di CRM. Cukup 'message.any'.
const WAHA_WEBHOOK_EVENTS = ['message.any', 'message.ack', 'message.revoked', 'session.status'];

// Pastikan session yang SUDAH ADA punya config webhook lengkap (termasuk
// 'message.ack'). Session lama yang dibuat sebelum fitur ack tidak berlangganan
// event itu, sehingga WAHA tak pernah mengirim update centang. Fungsi ini
// meng-update config-nya (best-effort, aman kalau versi WAHA tak mendukung PUT).
async function ensureWebhookConfig(session) {
  const appUrl = String(process.env.APP_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (!appUrl) return false; // tanpa APP_URL/BASE_URL tak bisa pasang webhook
  const { cfg, http } = api(session, 15000);
  const webhookUrl = appUrl + '/portal/webhook/waha';

  // Cek config saat ini — kalau webhook & event sudah lengkap, tak perlu update.
  try {
    const info = await getSessionInfo(session);
    const hooks = (info && info.config && info.config.webhooks) || [];
    const mine = hooks.find(h => String(h.url || '') === webhookUrl);
    if (mine) {
      const ev = Array.isArray(mine.events) ? mine.events : [];
      const hasAll = WAHA_WEBHOOK_EVENTS.every(e => ev.includes(e));
      // Session lama mungkin masih berlangganan 'message' (selain 'message.any').
      // Itu menyebabkan pesan masuk dobel — paksa update config utk membuangnya.
      const hasStale = ev.includes('message');
      if (hasAll && !hasStale) return true; // sudah lengkap & bersih
    }
  } catch (_) { /* lanjut update */ }

  // Update config webhook (PUT). Sebagian versi WAHA memakai PUT /api/sessions/{name}.
  try {
    await http.put('/api/sessions/' + encodeURIComponent(cfg.wahaSession), {
      config: { webhooks: [{ url: webhookUrl, events: WAHA_WEBHOOK_EVENTS.slice() }] },
    });
    logger.info('[WAHA] Webhook config di-update utk "' + cfg.wahaSession + '" (incl. message.ack).');
    return true;
  } catch (e) {
    logger.warn('[WAHA] Gagal update webhook config "' + cfg.wahaSession + '": ' + errDetail(e) +
      ' — event ack mungkin tak aktif utk session lama. Reconnect ulang bila perlu.');
    return false;
  }
}

async function startSession(session) {
  const { cfg, http } = api(session, 20000);

  // 1) Coba START session yang mungkin sudah ada.
  try {
    await http.post('/api/sessions/' + encodeURIComponent(cfg.wahaSession) + '/start', {});
    // Session sudah ada & di-start → pastikan webhook-nya lengkap (termasuk ack).
    ensureWebhookConfig(session).catch(() => {});
    return true;
  } catch (e) {
    const code = e.response && e.response.status;
    if (code === 422) { ensureWebhookConfig(session).catch(() => {}); return true; } // sudah jalan
    if (code !== 404) {
      // Selain 404, mungkin session ADA tapi STOPPED — coba tetap lanjut ke create
      // (idempotent di banyak versi). Log supaya terlihat.
      logger.warn('[WAHA] start "' + cfg.wahaSession + '" balas ' + (code || '?') + ': ' + errDetail(e) + ' — coba create.');
    }
  }

  // 2) Susun config webhook (kalau APP_URL/BASE_URL tersedia).
  const webhooks = [];
  const appUrl = String(process.env.APP_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (appUrl) {
    webhooks.push({
      url: appUrl + '/portal/webhook/waha',
      events: WAHA_WEBHOOK_EVENTS.slice(),
    });
  } else {
    logger.warn('[WAHA] APP_URL kosong — session dibuat TANPA webhook. Set APP_URL di .env agar pesan masuk & status realtime.');
  }

  // 3) Buat session baru. Kalau WAHA menolak karena config webhook (format beda
  //    antar versi) atau field engine, JANGAN gagal total — retry dgn payload
  //    minimal supaya QR tetap bisa muncul & user bisa scan.
  const createPayloads = [
    { name: cfg.wahaSession, start: true, config: webhooks.length ? { webhooks } : undefined },
    { name: cfg.wahaSession, start: true },                 // tanpa config
    { name: cfg.wahaSession },                              // paling minimal
  ];

  let lastErr = null;
  for (const payload of createPayloads) {
    try {
      await http.post('/api/sessions', payload);
      // Kalau payload tanpa start, pastikan di-start.
      if (!payload.start) {
        try { await http.post('/api/sessions/' + encodeURIComponent(cfg.wahaSession) + '/start', {}); } catch (_) {}
      }
      // Kalau session dibuat tanpa webhook (karena APP_URL kosong / config ditolak),
      // coba pasang webhook via update endpoint (best-effort).
      if (webhooks.length && payload.config === undefined && appUrl) {
        try {
          await http.put('/api/sessions/' + encodeURIComponent(cfg.wahaSession), { config: { webhooks } });
        } catch (_) { /* sebagian versi tak punya PUT; abaikan */ }
      }
      return true;
    } catch (e) {
      const code = e.response && e.response.status;
      lastErr = e;
      // 422 = session sudah ada (mis. sudah dibuat sebelumnya) → anggap sukses,
      // lalu coba start.
      if (code === 422) {
        try { await http.post('/api/sessions/' + encodeURIComponent(cfg.wahaSession) + '/start', {}); } catch (_) {}
        return true;
      }
      logger.warn('[WAHA] create session attempt gagal (' + (code || '?') + '): ' + errDetail(e) + ' — coba payload lebih minimal.');
    }
  }
  throw new Error('WAHA create session gagal: ' + (lastErr ? errDetail(lastErr) : 'unknown'));
}

async function stopSession(session) {
  const { cfg, http } = api(session, 20000);
  try { await http.post('/api/sessions/' + encodeURIComponent(cfg.wahaSession) + '/stop', {}); } catch (_) {}
}

// Logout = unlink device (perlu scan QR lagi untuk connect berikutnya).
async function logoutSession(session) {
  const { cfg, http } = api(session, 20000);
  try {
    await http.post('/api/sessions/' + encodeURIComponent(cfg.wahaSession) + '/logout', {});
  } catch (e) {
    logger.warn('[WAHA] logout gagal (' + cfg.wahaSession + '): ' + errDetail(e));
  }
  await stopSession(session);
}

// Ambil QR pairing sebagai data URL PNG (untuk ditampilkan di panel QR yang
// sama dengan Baileys). Return null kalau QR belum/tidak tersedia (mis. sudah
// WORKING atau masih STARTING — QR butuh ~5-15 dtk siap setelah start).
async function getQrImage(session) {
  const { cfg, http } = api(session, 12000);
  const base = '/api/' + encodeURIComponent(cfg.wahaSession) + '/auth/qr';
  const errs = [];

  // 1) Format image (binary PNG) — cara utama.
  try {
    const resp = await http.get(base, {
      params: { format: 'image' }, responseType: 'arraybuffer',
      headers: { Accept: 'image/png' },
    });
    // Validasi: pastikan benar-benar bytes gambar (bukan JSON error terbungkus).
    const buf = Buffer.from(resp.data);
    const ct = String((resp.headers && resp.headers['content-type']) || '').toLowerCase();
    if (buf.length > 100 && (ct.includes('image') || buf[0] === 0x89 /* PNG magic */)) {
      return 'data:' + (ct.includes('image') ? ct : 'image/png') + ';base64,' + buf.toString('base64');
    }
    errs.push('image:ct=' + ct + ',len=' + buf.length);
  } catch (e) {
    errs.push('image:' + errDetail(e));
    // 404/422 = QR belum siap (STARTING) atau sudah WORKING; lanjut ke fallback.
  }

  // 2) Format raw → generate QR sendiri pakai lib qrcode. Berguna bila endpoint
  //    image bermasalah di versi WAHA tertentu.
  try {
    const resp = await http.get(base, {
      params: { format: 'raw' }, headers: { Accept: 'application/json' },
    });
    const d = resp.data || {};
    const rawValue = d.value || d.qr || d.code || (typeof d === 'string' ? d : null);
    if (rawValue) {
      const QRCodeLib = require('qrcode');
      return await QRCodeLib.toDataURL(String(rawValue), { width: 300, margin: 2, errorCorrectionLevel: 'M' });
    }
    errs.push('raw:no-value');
  } catch (e) { errs.push('raw:' + errDetail(e)); }

  // 3) Base64 image via Accept: application/json (sebagian versi mengembalikan
  //    { mimetype, data } atau { qr }).
  try {
    const resp = await http.get(base, {
      params: { format: 'image' }, headers: { Accept: 'application/json' },
    });
    const d = resp.data || {};
    const dataB64 = d.data || d.qr || null;
    if (dataB64) {
      const mime = d.mimetype || 'image/png';
      const val = String(dataB64);
      return val.startsWith('data:') ? val : ('data:' + mime + ';base64,' + val);
    }
    errs.push('json:no-data');
  } catch (e) { errs.push('json:' + errDetail(e)); }

  logger.info('[WAHA] QR "' + cfg.wahaSession + '" belum tersedia (' + errs.join(' | ') + ')');
  return null; // QR belum tersedia (masih STARTING) atau status bukan SCAN_QR_CODE
}

// ── Cek koneksi (quad-state) ────────────────────────────────
// 'connected'    : WAHA menjawab & status WORKING
// 'connecting'   : WAHA menjawab & status STARTING/SCAN_QR_CODE (sedang pairing
//                  — JANGAN divonis disconnected, panel QR sedang dipakai)
// 'disconnected' : WAHA menjawab & status STOPPED/FAILED, atau session tak ada
// 'unknown'      : WAHA tidak bisa dihubungi (jaringan/timeout) — JANGAN
//                  divonis putus; pertahankan status terakhir di DB.
async function checkConnection(session) {
  try {
    const info = await getSessionInfo(session);
    return mapStatus(info.status); // 'connected' | 'connecting' | 'disconnected'
  } catch (e) {
    if (e.response && e.response.status === 404) return 'disconnected'; // session tak ada di WAHA
    return 'unknown';
  }
}

async function isConnected(session) {
  return (await checkConnection(session)) === 'connected';
}

async function getSessionStatus(session) {
  try {
    const info = await getSessionInfo(session);
    return mapStatus(info.status);
  } catch (_) { return 'disconnected'; }
}

// ── Auto-reconnect: pastikan session WAHA hidup kembali tanpa campur tangan ──
// Dipanggil berkala oleh cron. Mengembalikan objek deskriptif agar cron bisa
// mengambil keputusan & broadcast status. Aman: HANYA memulai ulang session
// yang STOPPED/FAILED (punya auth tersimpan) — TIDAK memaksa start session yang
// butuh scan QR (SCAN_QR_CODE) atau yang sudah WORKING.
//   return { raw, mapped, action } di mana:
//     raw    : status mentah WAHA (WORKING/STARTING/SCAN_QR_CODE/STOPPED/FAILED/UNKNOWN/NOT_FOUND)
//     mapped : 'connected' | 'connecting' | 'disconnected' | 'unknown'
//     action : 'none' | 'restarted' | 'created' | 'needs_qr' | 'error'
async function ensureConnected(session) {
  let info;
  try {
    info = await getSessionInfo(session);
  } catch (e) {
    if (e.response && e.response.status === 404) {
      // Session belum ada di WAHA (mis. container WAHA di-reset). Coba buat &
      // start ulang; kalau auth lama masih tersimpan di volume WAHA, langsung
      // WORKING. Kalau tidak, akan minta QR (di luar kendali kita).
      try {
        await startSession(session);
        return { raw: 'NOT_FOUND', mapped: 'connecting', action: 'created' };
      } catch (e2) {
        return { raw: 'NOT_FOUND', mapped: 'disconnected', action: 'error', error: errDetail(e2) };
      }
    }
    // Timeout / WAHA tak menjawab → transient, jangan vonis apa-apa.
    return { raw: 'UNKNOWN', mapped: 'unknown', action: 'none' };
  }

  const raw = String(info.status || '').toUpperCase();
  const mapped = mapStatus(raw);

  if (raw === 'WORKING') return { raw, mapped, action: 'none' };

  // STARTING = sedang naik; beri waktu, jangan diganggu.
  if (raw === 'STARTING') return { raw, mapped, action: 'none' };

  // SCAN_QR_CODE = butuh manusia scan QR; auto-start tidak akan menolong.
  if (raw === 'SCAN_QR_CODE') return { raw, mapped, action: 'needs_qr' };

  // STOPPED / FAILED / lainnya → coba start ulang (auth biasanya masih ada).
  try {
    await startSession(session);
    return { raw, mapped: 'connecting', action: 'restarted' };
  } catch (e) {
    return { raw, mapped: 'disconnected', action: 'error', error: errDetail(e) };
  }
}

// ── Foto profil kontak ──────────────────────────────────────
// GET /api/contacts/profile-picture → URL foto di CDN WhatsApp
// (pps.whatsapp.net — publik, bisa langsung dipakai <img> di browser).
// Cache server-side 24 jam (positif) / 1 jam (negatif): frontend memanggil
// endpoint ini utk SETIAP kontak di daftar chat setiap reload halaman — tanpa
// cache, 20+ kontak = 20+ panggilan WAHA→WhatsApp per reload (rawan rate-limit,
// dokumentasi WAHA sendiri memperingatkan jangan sering refresh).
const _profilePicCache = new Map(); // digits → { url, exp }
async function getProfilePicture(session, number) {
  const raw = String(number || '').replace(/[^0-9]/g, '');
  if (!raw) return null;
  // Normalisasi 08xx → 628xx (kecuali LID panjang, biarkan apa adanya)
  const digits = raw.length > 15 ? raw : normalizeNumber(raw);
  const now = Date.now();
  const hit = _profilePicCache.get(digits);
  if (hit && hit.exp > now) return hit.url;

  let url = null;
  try {
    // Timeout lebih longgar: WEBJS mengambil foto profil LIVE dari WhatsApp Web,
    // bisa 5-15 dtk untuk kontak yg belum ter-cache.
    const { cfg, http } = api(session, 20000);
    // Digit sangat panjang (>15) = LID yang belum ter-resolve → pakai @lid,
    // bukan @c.us (kontak '99887...@c.us' tidak ada dan hanya bikin 404).
    const contactId = digits.length > 15 ? digits + '@lid' : digits + '@c.us';

    const pickUrl = (d) => {
      if (!d || typeof d !== 'object') return null;
      const u = d.profilePictureURL || d.profilePictureUrl || d.url || d.profilePicture || null;
      return u ? String(u) : null;
    };

    // 1) Endpoint utama: /api/contacts/profile-picture (semua engine)
    try {
      const resp = await http.get('/api/contacts/profile-picture', {
        params: { session: cfg.wahaSession, contactId },
      });
      url = pickUrl(resp.data);
    } catch (e1) {
      logger.warn('[WAHA] Foto profil (primary) ' + digits + ' gagal: ' + errDetail(e1));
    }

    // 2) Fallback: paksa refresh sekali (kadang cache WAHA kosong utk kontak baru)
    if (!url) {
      try {
        const resp2 = await http.get('/api/contacts/profile-picture', {
          params: { session: cfg.wahaSession, contactId, refresh: true },
        });
        url = pickUrl(resp2.data);
      } catch (_) { /* diamkan; lanjut fallback ke-3 */ }
    }

    // 3) Fallback: endpoint per-chat /api/{session}/chats/{chatId}/picture
    //    (tersedia di sebagian versi WAHA, berguna bila endpoint contacts null)
    if (!url) {
      try {
        const resp3 = await http.get(
          '/api/' + encodeURIComponent(cfg.wahaSession) +
          '/chats/' + encodeURIComponent(contactId) + '/picture',
          { params: { refresh: false } }
        );
        url = pickUrl(resp3.data);
      } catch (_) { /* diamkan */ }
    }

    if (!url) logger.info('[WAHA] Foto profil ' + digits + ': tidak tersedia (privasi/kontak tak dikenal/engine tanpa Store)');
  } catch (e) {
    // Log penyebab supaya bisa didiagnosa dari pm2 logs (cache-negatif 1 jam
    // mencegah spam log utk kontak yang sama).
    logger.warn('[WAHA] Foto profil ' + digits + ' gagal: ' + errDetail(e));
  }

  _profilePicCache.set(digits, { url, exp: now + (url ? 24 * 3600 * 1000 : 60 * 60 * 1000) });
  if (_profilePicCache.size > 5000) {
    const k = _profilePicCache.keys().next().value; _profilePicCache.delete(k);
  }
  return url;
}

// ── Proxy foto profil: ambil bytes gambar server-side ───────────────
// URL foto WhatsApp (pps.whatsapp.net) kadang gagal dimuat langsung oleh <img>
// di browser (CDN kadaluarsa cepat / butuh konteks). Dengan mem-proxy lewat
// backend, browser cukup memuat dari domain kita sendiri → jauh lebih andal.
// Return { buffer, contentType } atau null.
const _picBytesCache = new Map(); // url → { buf, ct, exp }
async function getProfilePictureImage(session, number) {
  const url = await getProfilePicture(session, number);
  if (!url) return null;

  const now = Date.now();
  const hit = _picBytesCache.get(url);
  if (hit && hit.exp > now) return { buffer: hit.buf, contentType: hit.ct };

  try {
    const axios = require('axios');
    const cfg = getConfig(session);
    // Hanya kirim X-Api-Key kalau URL menunjuk BALIK ke host WAHA. Untuk CDN
    // WhatsApp (pps.whatsapp.net / mmg.whatsapp.net), header itu tak perlu &
    // justru bisa bikin CDN menolak. UA browser-like membantu diterima CDN.
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    };
    try {
      const wahaHost = new URL(cfg.baseUrl).host;
      const urlHost = new URL(url).host;
      if (cfg.apiKey && urlHost === wahaHost) headers['X-Api-Key'] = cfg.apiKey;
    } catch (_) { /* URL relatif tak terduga: jangan sertakan api key */ }

    const resp = await axios.get(url, {
      headers, responseType: 'arraybuffer', timeout: 15000,
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buf = Buffer.from(resp.data);
    const ct = String((resp.headers && resp.headers['content-type']) || 'image/jpeg');
    // Validasi: pastikan benar-benar gambar (bukan HTML error page dari CDN).
    if (buf.length < 50 || !/^image\//i.test(ct)) {
      logger.warn('[WAHA] Proxy foto profil: respons bukan gambar (ct=' + ct + ', len=' + buf.length + ')');
      return null;
    }
    _picBytesCache.set(url, { buf, ct, exp: now + 6 * 3600 * 1000 });
    if (_picBytesCache.size > 2000) {
      const k = _picBytesCache.keys().next().value; _picBytesCache.delete(k);
    }
    return { buffer: buf, contentType: ct };
  } catch (e) {
    logger.warn('[WAHA] Proxy foto profil gagal (' + String(url).slice(0, 80) + '…): ' + errDetail(e));
    return null;
  }
}

// ── Log outbound ke DB (konsisten dgn WAService/FonnteService) ──
async function _logOutbound(session, target, message, type, waId, mediaUrl, io, extra) {
  try {
    const { WaMessage, Customer } = require('../models');
    const { Op } = require('sequelize');
    const fromNumber = session.phone_number || session.session_id;
    // Snapshot isi pesan yang dibalas (utk render quote) — kalau frontend
    // tidak mengirim teksnya, cari dari DB by wa_message_id.
    let replyToId   = (extra && extra.replyToId) || null;
    let replyToText = (extra && extra.replyToText) || null;
    if (replyToId && !replyToText) {
      try {
        const orig = await WaMessage.findOne({ where: { wa_message_id: { [Op.like]: replyToId + '%' } } });
        if (orig) replyToText = String(orig.message || '').slice(0, 490);
      } catch (_) {}
    }

    // Resolve customer dari nomor (lookup ringan by 9 digit terakhir)
    let customerId = null;
    let customerName = null;
    try {
      const clean = String(target).replace(/[^0-9]/g, '');
      if (clean.length >= 9) {
        const cust = await Customer.findOne({
          where: { phone: { [Op.like]: '%' + clean.slice(-9) } },
          attributes: ['id', 'name'],
        });
        if (cust) { customerId = cust.id; customerName = cust.name; }
      }
    } catch (_) {}

    const row = await WaMessage.create({
      session_id:    session.session_id,
      direction:     'outbound',
      from_number:   fromNumber,
      to_number:     target,
      message:       message || '',
      message_type:  type || 'text',
      status:        waId ? 'sent' : 'pending',
      wa_message_id: waId || null,
      media_url:     mediaUrl || null,
      reply_to_id:   replyToId,
      reply_to_text: replyToText,
      customer_id:   customerId,
      sent_at:       new Date(),
    });

    if (io) io.emit('wa:message:' + session.session_id, {
      direction: 'outbound', to: target, text: message,
      message_type: type || 'text', media_url: mediaUrl || null,
      reply_to_id: replyToId, reply_to_text: replyToText,
      wa_message_id: waId || null, status: row.status,
      customer: customerId ? { id: customerId, name: customerName } : null,
      timestamp: new Date(),
    });
  } catch (e) {
    logger.warn('[WAHA] _logOutbound gagal: ' + e.message);
  }
}

// Ambil nama tampilan pengirim dari payload webhook — letaknya beda per engine:
//   NOWEB : _data.pushName (raw proto Baileys)
//   WEBJS : _data.notifyName
//   GOWS  : _data.Info.PushName
// plus kemungkinan field level atas (notifyName/pushName) di versi tertentu.
function extractPushName(p) {
  if (!p) return '';
  const d = p._data || {};
  return String(
    d.notifyName || d.pushName ||
    (d.Info && (d.Info.PushName || d.Info.pushName)) ||
    p.notifyName || p.pushName ||
    d.verifiedBizName || ''
  ).trim();
}

// Cache nama kontak dari API WAHA (GET /api/contacts) — dipakai saat webhook
// tidak membawa pushName (mis. GOWS versi tertentu / pesan media). TTL 6 jam,
// cache negatif 15 menit supaya tidak menembak API tiap pesan dari kontak
// tanpa nama.
const _contactNameCache = new Map(); // chatId → { name, exp }
async function lookupContactName(session, chatId) {
  const now = Date.now();
  const hit = _contactNameCache.get(chatId);
  if (hit && hit.exp > now) return hit.name;
  let name = '';
  try {
    const { cfg, http } = api(session, 8000);
    const resp = await http.get('/api/contacts', {
      params: { session: cfg.wahaSession, contactId: chatId },
    });
    const c = resp.data || {};
    name = String(c.name || c.pushname || c.pushName || c.shortName || '').trim();
  } catch (_) { /* kontak tak dikenal / engine tak support — biarkan kosong */ }
  _contactNameCache.set(chatId, { name, exp: now + (name ? 6 * 3600 * 1000 : 15 * 60 * 1000) });
  if (_contactNameCache.size > 3000) {
    const firstKey = _contactNameCache.keys().next().value;
    _contactNameCache.delete(firstKey);
  }
  return name;
}

// ── Deteksi ENGINE session (cached 10 menit) ────────────────
// Format message ID berbeda per engine:
//   NOWEB/GOWS : raw id            (mis. '3EB0ABC...')
//   WEBJS      : serialized        (mis. 'true_628x@c.us_3EB0ABC...')
// Salah format → WEBJS getMessageById dapat undefined → error 500
// "Cannot read properties of undefined (reading 'id')" saat delete/reply.
const _engineCache = new Map(); // session_id → { engine, exp }
async function getEngine(session) {
  const key = session.session_id || 'x';
  const now = Date.now();
  const hit = _engineCache.get(key);
  if (hit && hit.exp > now) return hit.engine;
  let engine = 'NOWEB';
  try {
    const info = await getSessionInfo(session);
    engine = String(info.engine && (info.engine.engine || info.engine) || info.config && info.config.engine || 'NOWEB').toUpperCase();
  } catch (_) {}
  _engineCache.set(key, { engine, exp: now + 10 * 60 * 1000 });
  return engine;
}

// Format message ID sesuai engine tujuan. fromMe=true utk pesan kiriman kita.
async function formatIdForEngine(session, rawOrSerializedId, chatId, fromMe) {
  const raw = normalizeMsgId(rawOrSerializedId);
  if (!raw) return '';
  const engine = await getEngine(session);
  if (engine === 'WEBJS' || engine === 'WPP') {
    return (fromMe ? 'true' : 'false') + '_' + chatId + '_' + raw;
  }
  return raw;
}

// Resolusi @lid → nomor telepon asli via GET /api/{session}/lids/{lid}
// (respons: { lid, pn: '628xx@c.us' } — pn bisa null kalau kontak tak dikenal
// atau bukan admin grup). Cache 24 jam; cache-negatif 30 menit.
// KONTEKS: WhatsApp memakai Linked ID utk menyembunyikan nomor — tanpa
// resolusi ini, kontak tampil 'User XXXXXX' dan nomornya tidak diketahui CRM
// (tidak bisa dicocokkan ke data pelanggan).
const _lidPhoneCache = new Map(); // lidDigits → { pn, exp }
async function lookupLidPhone(session, lidJid) {
  const lidDigits = String(lidJid || '').split('@')[0].replace(/[^0-9]/g, '');
  if (!lidDigits) return null;
  const now = Date.now();
  const hit = _lidPhoneCache.get(lidDigits);
  if (hit && hit.exp > now) return hit.pn;
  let pn = null;
  try {
    const { cfg, http } = api(session, 8000);
    const resp = await http.get(
      '/api/' + encodeURIComponent(cfg.wahaSession) + '/lids/' + lidDigits
    );
    const raw = resp.data && resp.data.pn;
    if (raw) pn = normalizeNumber(String(raw).split('@')[0]);
  } catch (_) { /* endpoint tak tersedia di engine ini / lid tak dikenal */ }
  _lidPhoneCache.set(lidDigits, { pn, exp: now + (pn ? 24 * 3600 * 1000 : 30 * 60 * 1000) });
  if (_lidPhoneCache.size > 5000) {
    const k = _lidPhoneCache.keys().next().value; _lidPhoneCache.delete(k);
  }
  return pn;
}

// Map tipe pesan → enum kolom wa_messages.message_type
// Enum DB hanya: text, image, document, audio, template. 'video' & 'sticker'
// di-fallback ke 'image' (pola sama dgn Baileys — renderer frontend tetap
// menampilkan benar karena melihat ekstensi file), 'location' → text.
function toDbMsgType(t) {
  if (t === 'image' || t === 'audio' || t === 'document') return t;
  if (t === 'video' || t === 'sticker') return 'image';
  if (t === 'location') return 'text';
  return t === 'text' ? 'text' : 'document';
}

// Folder media lokal — SAMA dengan jalur Baileys & multer send-media,
// supaya URL konsisten: /uploads/media/<file>
const MEDIA_DIR = path.join(__dirname, '../../uploads/media');

// Unduh media dari server WAHA saat webhook tiba, simpan lokal, kembalikan
// URL relatif yang bisa dirender browser.
// KENAPA HARUS DIUNDUH: (1) file di WAHA punya masa hidup default 180 detik —
// URL-nya mati sebelum admin sempat buka chat; (2) endpoint /api/files butuh
// API key yang TIDAK boleh dibocorkan ke <img src> di browser. CRM mengunduh
// server-side dgn header X-Api-Key, browser cukup akses /uploads/media lokal.
async function persistWebhookMedia(session, p, msgType) {
  const remoteUrl = p && p.media && p.media.url;
  if (!remoteUrl) return null; // media tidak diunduh WAHA (filter mimetype/dll)
  let resp = null;
  const cfg = getConfig(session);
  try {
    const headers = {};
    if (cfg.apiKey) headers['X-Api-Key'] = cfg.apiKey;
    const fetchOpts = {
      headers, responseType: 'arraybuffer', timeout: 30000,
      maxContentLength: 64 * 1024 * 1024, // batas sama dgn upload chat (64MB)
    };
    try {
      resp = await axios.get(remoteUrl, fetchOpts);
    } catch (e1) {
      // URL media dibentuk WAHA dari WAHA_BASE_URL — kalau env itu salah
      // (mis. duplikat 'http://localhost:3000' bawaan template menang),
      // URL menunjuk ke tempat yang salah. Retry: ganti origin URL dengan
      // waha_url milik session (yang terbukti benar utk kirim pesan).
      let retryUrl = null;
      try {
        const u = new URL(remoteUrl);
        retryUrl = cfg.baseUrl + u.pathname + (u.search || '');
      } catch (_) {}
      if (retryUrl && retryUrl !== remoteUrl) {
        logger.warn('[WAHA] Unduh media gagal dari ' + remoteUrl + ' (' + e1.message + ') — retry via waha_url session: ' + retryUrl);
        resp = await axios.get(retryUrl, fetchOpts);
      } else {
        throw e1;
      }
    }

    // Tentukan ekstensi: filename asli → mimetype → path URL → default per tipe
    const mime = String((p.media && p.media.mimetype) || resp.headers['content-type'] || '').toLowerCase();
    let ext = '';
    const origName = p.media && p.media.filename;
    if (origName && origName.includes('.')) ext = origName.split('.').pop().replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!ext) {
      const m = String(remoteUrl).split('?')[0].match(/\.([a-z0-9]{1,5})$/i);
      if (m) ext = m[1].toLowerCase();
    }
    if (!ext) {
      ext = mime.startsWith('image/') ? (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg')
        : mime.startsWith('video/') ? 'mp4'
        : mime.startsWith('audio/') ? 'ogg'
        : mime.includes('pdf') ? 'pdf' : 'bin';
    }

    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const fname = 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(MEDIA_DIR, fname), Buffer.from(resp.data));
    logger.info('[WAHA] Media tersimpan lokal: /uploads/media/' + fname + ' (' + Buffer.from(resp.data).length + ' bytes)');
    return '/uploads/media/' + fname;
  } catch (e) {
    logger.warn('[WAHA] Gagal unduh media webhook (' + (e.message || e) + ') — pakai URL remote sbg fallback');
    // Fallback: URL remote (mungkin butuh api-key & bisa kadaluarsa, tapi
    // lebih baik dari kosong; TANPA menyisipkan api-key ke URL).
    return remoteUrl;
  }
}

// ── Handler WEBHOOK dari WAHA ───────────────────────────────
// WAHA POST event ke webhook URL kita. Bentuk umum:
//   { event: 'message'|'message.any'|'session.status', session: '<nama>',
//     payload: {...}, me: {...}, engine: 'NOWEB'|... }
// event 'message'      = pesan MASUK (fromMe=false)
// event 'message.any'  = semua pesan (termasuk fromMe=true, mis. balas dari HP)
// event 'session.status' = perubahan status session (WORKING/STOPPED/...)
// payload message: { id, timestamp, from, to, fromMe, body, hasMedia,
//                    media: { url, mimetype, filename }, _data, ... }
async function handleWebhook(payload, io) {
  const { WaSession, WaMessage, WaAutoReply, Customer } = require('../models');
  const { Op } = require('sequelize');

  const event = String(payload && payload.event || '');
  const wahaSessionName = String(payload && payload.session || '');
  if (!event) return { ok: false, reason: 'no_event' };

  // Log ringkas untuk diagnosa (payload media bisa besar → potong)
  try { logger.info('[WAHA] Webhook ' + event + ' (' + wahaSessionName + '): ' + JSON.stringify(payload.payload || {}).slice(0, 500)); } catch (_) {}

  // ── Cari row WaSession yang cocok dgn nama session WAHA ──
  let session = null;
  try {
    const wahaSessions = await WaSession.findAll({ where: { provider: 'waha' } });
    if (wahaSessionName) {
      session = wahaSessions.find(s => String(s.waha_session || 'default') === wahaSessionName) || null;
    }
    if (!session) session = wahaSessions[0] || null;
  } catch (e) {
    logger.error('[WAHA] Webhook: gagal ambil session: ' + e.message);
  }
  if (!session) { logger.warn('[WAHA] Webhook: tidak ada session provider=waha terdaftar'); return { ok: false, reason: 'no_session' }; }
  const sessionId = session.session_id;

  // ── Event status session → sinkron kolom status DB ──
  if (event === 'session.status') {
    const newStatus = mapStatus(payload.payload && payload.payload.status);
    try {
      const patch = { status: newStatus, last_seen: new Date() };
      // Simpan nomor WA saat WORKING (payload.me.id = '628xx@c.us' / '...:xx@s.whatsapp.net')
      const meId = payload.me && payload.me.id ? String(payload.me.id) : '';
      if (newStatus === 'connected' && meId) {
        patch.phone_number = normalizeNumber(meId.split('@')[0].split(':')[0]);
        patch.qr_code = null;
      }
      await WaSession.update(patch, { where: { session_id: sessionId } });
      const GatewayService = require('./GatewayService');
      GatewayService.invalidateSessionCache(sessionId);
    } catch (e) { logger.warn('[WAHA] Webhook: gagal update status: ' + e.message); }
    if (io) io.emit('wa:status:' + sessionId, { status: newStatus });
    return { ok: true, status: newStatus };
  }

  // ── Event ACK: status pengiriman pesan KELUAR (centang WA) ──
  // WAHA kirim { event:'message.ack', payload:{ id, from, ack, ackName } }.
  // Nilai ack: -1 ERROR, 0 PENDING, 1 SERVER(terkirim), 2 DEVICE(diterima),
  // 3 READ(dibaca), 4 PLAYED. Kita map ke enum status DB:
  //   ERROR   → 'failed'    (centang 1 / tanda gagal: penerima tak aktif/nomor salah)
  //   SERVER  → 'sent'      (centang 1)
  //   DEVICE  → 'delivered' (centang 2)
  //   READ/PLAYED → 'read'  (centang 2 biru)
  // PENDING diabaikan (belum ada info baru).
  if (event === 'message.ack' || event === 'message.ack.group') {
    const ap = payload.payload || {};
    const ackId = normalizeMsgId(ap.id);
    let ackVal = ap.ack;
    if (ackVal === undefined || ackVal === null) {
      // Fallback dari ackName kalau ack numerik tak ada
      const nm = String(ap.ackName || '').toUpperCase();
      ackVal = ({ ERROR: -1, PENDING: 0, SERVER: 1, DEVICE: 2, READ: 3, PLAYED: 4 })[nm];
    }
    ackVal = Number(ackVal);
    if (!ackId || Number.isNaN(ackVal)) return { ok: true, ignored: 'ack_incomplete' };

    let newStatus = null;
    if (ackVal === -1) newStatus = 'failed';
    else if (ackVal === 1) newStatus = 'sent';
    else if (ackVal === 2) newStatus = 'delivered';
    else if (ackVal >= 3) newStatus = 'read';
    if (!newStatus) return { ok: true, ignored: 'ack_pending' };

    // Urutan status: pending<sent<delivered<read<failed(khusus). Jangan turunkan
    // status (mis. dari 'read' balik ke 'delivered') karena ack bisa datang
    // tidak berurutan.
    const rank = { pending: 0, sent: 1, delivered: 2, read: 3 };
    try {
      const row = await WaMessage.findOne({
        where: { wa_message_id: { [Op.like]: ackId + '%' }, direction: 'outbound' },
        order: [['created_at', 'DESC']],
      });
      if (row) {
        const cur = String(row.status || 'pending');
        // 'failed' selalu ditulis (info penting). Selain itu hanya naik.
        if (newStatus === 'failed' || (rank[newStatus] || 0) > (rank[cur] || 0)) {
          await row.update({ status: newStatus });
          if (io) io.emit('wa:ack:' + sessionId, {
            wa_message_id: row.wa_message_id || ackId, ack_id: ackId,
            status: newStatus, ack: ackVal, id: row.id,
          });
        }
      }
    } catch (e) {
      logger.warn('[WAHA] Gagal update ack: ' + (e.message || e));
    }
    return { ok: true, ack: ackVal, status: newStatus };
  }

  // ── Event pesan dihapus pengirim (delete for everyone) ──
  if (event === 'message.revoked') {
    const rp = payload.payload || {};
    const revokedId = normalizeMsgId(rp.revokedMessageId || rp.id || (rp.after && rp.after.id));
    if (revokedId) {
      try {
        const row = await WaMessage.findOne({ where: { wa_message_id: { [Op.like]: revokedId + '%' } } });
        if (row) {
          await row.update({ message: '⊘ Pesan telah dihapus', media_url: null, message_type: 'text' });
          if (io) io.emit('wa:message:' + sessionId, { direction: row.direction, refresh: true });
        }
      } catch (_) {}
    }
    return { ok: true, revoked: revokedId || null };
  }

  // ── Event pesan ──
  if (event !== 'message' && event !== 'message.any') return { ok: true, ignored: event };
  const p = payload.payload || {};
  const fromJid = String(p.from || '');
  const toJid   = String(p.to || '');

  // Abaikan group, channel (newsletter), broadcast list & status broadcast.
  // Chat CRM = percakapan 1-on-1 dgn customer. WhatsApp Channels ber-JID
  // '...@newsletter' (mis. "Dakwah Ust ...") — TANPA filter ini, pesan channel
  // yang di-follow user ikut nyasar ke daftar chat masuk CRM.
  if (fromJid.endsWith('@g.us') || toJid.endsWith('@g.us')) return { ok: true, ignored: 'group' };
  if (fromJid.endsWith('@newsletter') || toJid.endsWith('@newsletter')) return { ok: true, ignored: 'channel' };
  if (fromJid.endsWith('@broadcast') || toJid.endsWith('@broadcast')) return { ok: true, ignored: 'broadcast' };
  if (fromJid.includes('status@broadcast') || toJid.includes('status@broadcast')) return { ok: true, ignored: 'status' };

  const fromMe = p.fromMe === true || p.fromMe === 'true';
  const text   = String(p.body || p.caption || '');
  // Normalisasi ID supaya cocok dgn wa_message_id yang disimpan saat kirim
  // (respons kirim = raw, webhook = serialized 'true_jid_RAW' → samakan ke raw)
  const waId   = normalizeMsgId(p.id) || null;

  // Dedup lock in-memory: tolak event kedua utk id yang sama SEBELUM unduh media
  // & tulis DB (menutup jendela balapan yang tak tertangkap cek DB findOne).
  if (waId && !_claimMessageId(waId)) {
    return { ok: true, duplicate: true, via: 'lock' };
  }

  // ── Tipe & media ──
  let msgType = 'text';
  let mediaUrl = null;
  if (p.hasMedia || (p.media && p.media.url)) {
    const mime = String((p.media && p.media.mimetype) || '').toLowerCase();
    if (mime.startsWith('image/')) msgType = 'image';
    else if (mime.startsWith('video/')) msgType = 'video';
    else if (mime.startsWith('audio/')) msgType = 'audio';
    else msgType = 'document';
    // Unduh ke lokal (/uploads/media) — URL WAHA kadaluarsa 180 dtk & butuh API key
    mediaUrl = await persistWebhookMedia(session, p, msgType);
    if (!mediaUrl && p.hasMedia) {
      logger.warn('[WAHA] Pesan bermedia tapi media.url kosong — cek WHATSAPP_FILES_MIMETYPES / WHATSAPP_DOWNLOAD_MEDIA di .env WAHA');
    }
  } else if (p.location || (p._data && p._data.isLive)) {
    msgType = 'location';
  }
  const dbMsgType = toDbMsgType(msgType);

  // ── Idempotensi: WAHA bisa retry webhook; event message + message.any juga
  //    bisa dobel untuk pesan yang sama ──
  if (waId) {
    try {
      // Op.like waId% → cocok baik id polos maupun id lama bersuffix '|jid:...'
      const dup = await WaMessage.findOne({
        where: { wa_message_id: { [Op.like]: waId + '%' } },
      });
      if (dup) return { ok: true, duplicate: true };
    } catch (_) {}
  }

  // ── Pesan KELUAR (dikirim dari HP / device lain) → simpan outbound & stop ──
  if (fromMe) {
    let toNum = normalizeNumber(toJid.split('@')[0]);
    if (!toNum) return { ok: false, reason: 'no_target' };
    if (toJid.endsWith('@lid')) {
      const pn = await lookupLidPhone(session, toJid);
      if (pn) toNum = pn;
    }

    // Jaring pengaman ke-2 (kalau format ID engine tetap tak cocok):
    // pesan keluar dgn tujuan + isi sama yang BARU SAJA dikirim via aplikasi
    // (<= 90 dtk) hampir pasti echo webhook dari kiriman kita sendiri → skip.
    const outBodyEarly = text || '[' + msgType + ']';
    try {
      const recentDup = await WaMessage.findOne({
        where: {
          session_id: sessionId,
          direction:  'outbound',
          to_number:  toNum,
          message:    outBodyEarly,
          created_at: { [Op.gte]: new Date(Date.now() - 90 * 1000) },
        },
        order: [['created_at', 'DESC']],
      });
      if (recentDup) {
        // Lengkapi wa_message_id kalau row asli belum punya (best-effort)
        if (waId && !recentDup.wa_message_id) {
          try { await recentDup.update({ wa_message_id: waId }); } catch (_) {}
        }
        return { ok: true, duplicate: true, via: 'content-window' };
      }
    } catch (_) {}

    let cust = null;
    try {
      if (toNum.length >= 9) {
        cust = await Customer.findOne({
          where: { phone: { [Op.like]: '%' + toNum.slice(-9) } },
          attributes: ['id', 'name'],
        });
      }
    } catch (_) {}

    const outBody = text || '[' + msgType + ']';
    try {
      await WaMessage.create({
        session_id:    sessionId,
        direction:     'outbound',
        from_number:   session.phone_number || sessionId,
        to_number:     toNum,
        message:       outBody,
        message_type:  dbMsgType,
        media_url:     mediaUrl,
        status:        'sent',
        wa_message_id: waId,
        customer_id:   cust ? cust.id : null,
        sent_at:       new Date(),
      });
    } catch (e) { logger.error('[WAHA] Webhook: gagal simpan outbound: ' + e.message); }

    if (io) io.emit('wa:message:' + sessionId, {
      direction: 'outbound', to: toNum, text: outBody,
      message_type: dbMsgType, media_url: mediaUrl,
      customer: cust ? { id: cust.id, name: cust.name } : null,
      fromDevice: true, timestamp: new Date(),
    });
    return { ok: true, outbound: true };
  }

  // ── Pesan MASUK ──
  let sender = normalizeNumber(fromJid.split('@')[0]);
  if (!sender) return { ok: false, reason: 'no_sender' };
  // Pengirim @lid (ID tersembunyi) → resolve ke nomor telepon asli supaya
  // (1) nomor tampil di UI, (2) bisa dicocokkan ke data pelanggan.
  if (fromJid.endsWith('@lid')) {
    const pn = await lookupLidPhone(session, fromJid);
    if (pn) sender = pn;
  }
  let pushName = extractPushName(p);
  // Fallback: tanya API WAHA (ter-cache) — penting utk kontak @lid yang tanpa
  // nama akan tampil sebagai 'User XXXXXX' di daftar chat.
  if (!pushName) {
    try { pushName = await lookupContactName(session, fromJid); } catch (_) {}
  }

  let customer = null;
  try {
    if (sender.length >= 9) {
      customer = await Customer.findOne({
        where: { phone: { [Op.like]: '%' + sender.slice(-9) } },
        attributes: ['id', 'name'],
      });
    }
  } catch (_) {}

  // Pesan masuk yang MEMBALAS pesan lain → simpan konteks quote
  let inReplyToId = null, inReplyToText = null;
  if (p.replyTo) {
    inReplyToId = normalizeMsgId(p.replyTo.id || p.replyTo) || null;
    inReplyToText = p.replyTo.body ? String(p.replyTo.body).slice(0, 490) : null;
    if (inReplyToId && !inReplyToText) {
      try {
        const orig = await WaMessage.findOne({ where: { wa_message_id: { [Op.like]: inReplyToId + '%' } } });
        if (orig) inReplyToText = String(orig.message || '').slice(0, 490);
      } catch (_) {}
    }
  }

  const bodyText = text || '[' + msgType + ']';
  try {
    await WaMessage.create({
      session_id:    sessionId,
      direction:     'inbound',
      from_number:   sender,
      to_number:     session.phone_number || sessionId,
      message:       bodyText,
      message_type:  dbMsgType,
      media_url:     mediaUrl,
      status:        'delivered',
      wa_message_id: waId,
      reply_to_id:   inReplyToId,
      reply_to_text: inReplyToText,
      push_name:     pushName || null,
      customer_id:   customer ? customer.id : null,
    });
  } catch (e) { logger.error('[WAHA] Webhook: gagal simpan WaMessage: ' + e.message); }

  // Emit ke UI (format sama dgn Baileys/Fonnte)
  if (io) io.emit('wa:message:' + sessionId, {
    direction: 'inbound', from: sender, text: bodyText,
    message_type: dbMsgType, media_url: mediaUrl, pushName,
    reply_to_id: inReplyToId, reply_to_text: inReplyToText,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    timestamp: new Date(),
  });

  // Notifikasi WA masuk
  try {
    const NotifSvc = require('./NotificationService');
    await NotifSvc.notifyWaIncoming(sender, bodyText, session.name || sessionId);
  } catch (_) {}

  // Auto-reply (kalau diaktifkan di session)
  try {
    if (session.auto_reply_enabled && text) {
      const rules = await WaAutoReply.findAll({ where: { session_id: sessionId, is_active: true } });
      for (const rule of rules) {
        if (matchAutoReply(text, rule.keyword, rule.match_type)) {
          await sendMessage(session, sender, rule.reply_message, io);
          await rule.increment('hit_count');
          break;
        }
      }
    }
  } catch (e) { logger.warn('[WAHA] Auto-reply gagal: ' + e.message); }

  return { ok: true };
}

module.exports = {
  sendMessage,
  sendMedia,
  deleteMessage,
  sendBroadcast,
  isConnected,
  checkConnection,
  getSessionStatus,
  ensureConnected,
  getSessionInfo,
  startSession,
  ensureWebhookConfig,
  stopSession,
  logoutSession,
  getQrImage,
  getProfilePicture,
  getProfilePictureImage,
  normalizeNumber,
  handleWebhook,
  mapStatus,
};
