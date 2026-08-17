/**
 * TelegramService.js — Kirim notifikasi monitoring ke Telegram.
 * ------------------------------------------------------------
 * Pakai Telegram Bot API (https://core.telegram.org/bots/api).
 * Config disimpan di app_settings:
 *   telegram_enabled        '1' / '0'
 *   telegram_bot_token      token dari @BotFather
 *   telegram_chat_id        chat/group/channel id tujuan (bisa multi, pisah koma)
 *   telegram_notif_device   '1'/'0'  — perangkat down
 *   telegram_notif_ont      '1'/'0'  — ONT pelanggan disconnect
 *   telegram_notif_ip       '1'/'0'  — IP pelanggan timeout
 *
 * Cara dapat chat_id: chat ke bot, lalu buka
 *   https://api.telegram.org/bot<TOKEN>/getUpdates  → ambil "chat":{"id":...}
 * Untuk grup: tambahkan bot ke grup, kirim pesan, cek getUpdates.
 */

const axios = require('axios');
const logger = require('../utils/logger');

// Ambil beberapa setting sekaligus dari app_settings.
async function _getConfig() {
  const { sequelize } = require('../models');
  const [rows] = await sequelize.query(
    "SELECT `key`, value FROM app_settings WHERE `key` LIKE 'telegram_%'"
  );
  const cfg = {};
  (rows || []).forEach(r => { cfg[r.key] = r.value; });
  return cfg;
}

function isEnabled(cfg) {
  return String(cfg.telegram_enabled) === '1'
    && !!(cfg.telegram_bot_token || '').trim()
    && !!(cfg.telegram_chat_id || '').trim();
}

// Batas 1 pesan Telegram = 4096 char. Pakai margin agar aman.
const TG_MAX_LEN = 3900;

// Pecah teks panjang jadi beberapa bagian < TG_MAX_LEN, memotong di batas
// baris (lalu spasi, lalu paksa) supaya tag HTML sederhana tetap utuh per
// baris. Ini mencegah error "MESSAGE_TOO_LONG" yang membuat pesan panjang
// (mis. /help, /down dengan banyak entri) gagal terkirim tanpa jejak ke user.
function _splitForTelegram(text, max = TG_MAX_LEN) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return [s];
  const parts = [];
  let buf = '';
  const flush = () => { if (buf.length) { parts.push(buf); buf = ''; } };
  for (const line of s.split('\n')) {
    // Baris tunggal lebih panjang dari max — potong keras per max char.
    if (line.length > max) {
      flush();
      let rest = line;
      while (rest.length > max) { parts.push(rest.slice(0, max)); rest = rest.slice(max); }
      buf = rest;
      continue;
    }
    const candidate = buf ? buf + '\n' + line : line;
    if (candidate.length > max) { flush(); buf = line; }
    else { buf = candidate; }
  }
  flush();
  return parts.length ? parts : [''];
}

// Kirim pesan teks ke semua chat_id (mendukung multi, pisah koma).
async function sendMessage(text, cfgOverride) {
  try {
    const cfg = cfgOverride || await _getConfig();
    if (!isEnabled(cfg)) return { ok: false, reason: 'disabled' };

    const token = cfg.telegram_bot_token.trim();
    const chatIds = String(cfg.telegram_chat_id).split(',').map(s => s.trim()).filter(Boolean);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const chunks = _splitForTelegram(text);

    const results = [];
    for (const chatId of chatIds) {
      let chatOk = true;
      for (const chunk of chunks) {
        try {
          const res = await axios.post(url, {
            chat_id: chatId,
            text: chunk,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }, { timeout: 10000 });
          if (res.data?.ok !== true) chatOk = false;
        } catch (e) {
          const detail = e.response?.data?.description || e.message;
          logger.warn(`[Telegram] Gagal kirim ke ${chatId}: ${detail}`);
          chatOk = false;
        }
      }
      results.push({ chatId, ok: chatOk });
    }
    return { ok: results.some(r => r.ok), results };
  } catch (e) {
    logger.error('[Telegram] sendMessage error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// Tes koneksi: getMe + kirim pesan tes.
async function testConnection(cfgOverride) {
  const cfg = cfgOverride || await _getConfig();
  const token = (cfg.telegram_bot_token || '').trim();
  if (!token) return { ok: false, message: 'Bot token belum diisi' };
  try {
    const me = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
    if (!me.data?.ok) return { ok: false, message: 'Token tidak valid' };
    const botName = me.data.result?.username || me.data.result?.first_name || 'bot';
    const send = await sendMessage(
      `✅ <b>Telegram Monitoring aktif</b>\nBot <b>@${botName}</b> berhasil terhubung ke dashboard ISP.`,
      cfg
    );
    return {
      ok: send.ok,
      message: send.ok ? `Terhubung sebagai @${botName}, pesan tes terkirim` : 'Token valid tapi gagal kirim — cek chat_id',
      bot: botName,
    };
  } catch (e) {
    const detail = e.response?.data?.description || e.message;
    return { ok: false, message: detail };
  }
}

// ── Kirim pesan teks ke chat_id TERTENTU (override tujuan) ──────────────
// Berbeda dari sendMessage yang pakai telegram_chat_id global. Dipakai
// Telegram Report / Backup yang punya daftar tujuan sendiri.
// chatIdsStr: string chat id dipisah koma. Token tetap dari config global.
async function sendMessageTo(text, chatIdsStr, cfgOverride) {
  try {
    const cfg = cfgOverride || await _getConfig();
    const token = (cfg.telegram_bot_token || '').trim();
    if (!token) return { ok: false, reason: 'no_token' };
    const chatIds = String(chatIdsStr || cfg.telegram_chat_id || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!chatIds.length) return { ok: false, reason: 'no_chat' };

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const chunks = _splitForTelegram(text);
    const results = [];
    for (const chatId of chatIds) {
      let chatOk = true;
      for (const chunk of chunks) {
        try {
          const res = await axios.post(url, {
            chat_id: chatId, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true,
          }, { timeout: 15000 });
          if (res.data?.ok !== true) chatOk = false;
        } catch (e) {
          const detail = e.response?.data?.description || e.message;
          // Bila gagal parse HTML (mis. ada karakter < > yang dikira tag),
          // kirim ulang sebagai teks biasa agar pesan tetap sampai.
          if (/can't parse entities|parse entities|unsupported start tag/i.test(detail)) {
            try {
              const plain = String(chunk).replace(/<\/?[^>]+>/g, '');
              const res2 = await axios.post(url, {
                chat_id: chatId, text: plain, disable_web_page_preview: true,
              }, { timeout: 15000 });
              if (res2.data?.ok !== true) chatOk = false;
              logger.warn(`[Telegram] HTML parse gagal ke ${chatId}, terkirim sbg teks biasa`);
              continue;
            } catch (e2) {
              const d2 = e2.response?.data?.description || e2.message;
              logger.warn(`[Telegram] Fallback teks biasa juga gagal ke ${chatId}: ${d2}`);
              chatOk = false;
              continue;
            }
          }
          logger.warn(`[Telegram] Gagal kirim ke ${chatId}: ${detail}`);
          chatOk = false;
        }
      }
      results.push({ chatId, ok: chatOk });
    }
    return { ok: results.some(r => r.ok), results };
  } catch (e) {
    logger.error('[Telegram] sendMessageTo error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ── Kirim FILE (dokumen) ke Telegram ───────────────────────────────────
// Pakai native FormData/Blob/fetch (Node 18+) — tanpa dependency tambahan.
// Limit Telegram Bot API: dokumen maksimal 50 MB.
//   filePath   : path file lokal yang akan dikirim
//   opts.chatId: tujuan (string multi, pisah koma) — default telegram_chat_id
//   opts.caption: keterangan (HTML diizinkan)
//   opts.filename: nama tampil (default basename)
async function sendDocument(filePath, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  try {
    const cfg = opts.cfg || await _getConfig();
    const token = (cfg.telegram_bot_token || '').trim();
    if (!token) return { ok: false, reason: 'no_token' };

    const chatIds = String(opts.chatId || cfg.telegram_chat_id || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!chatIds.length) return { ok: false, reason: 'no_chat' };

    if (!fs.existsSync(filePath)) return { ok: false, error: 'File tidak ditemukan: ' + filePath };
    const stat = fs.statSync(filePath);
    const MAX = 50 * 1024 * 1024; // 50 MB
    if (stat.size > MAX) {
      return { ok: false, error: `File ${(stat.size/1048576).toFixed(1)} MB melebihi batas Telegram 50 MB` };
    }

    const filename = opts.filename || path.basename(filePath);
    const buf = fs.readFileSync(filePath);
    const url = `https://api.telegram.org/bot${token}/sendDocument`;

    const results = [];
    for (const chatId of chatIds) {
      try {
        const form = new FormData();
        form.append('chat_id', chatId);
        if (opts.caption) { form.append('caption', opts.caption); form.append('parse_mode', 'HTML'); }
        form.append('document', new Blob([buf]), filename);
        const res = await fetch(url, { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (data && data.ok) results.push({ chatId, ok: true });
        else results.push({ chatId, ok: false, error: data?.description || ('HTTP ' + res.status) });
      } catch (e) {
        logger.warn(`[Telegram] Gagal kirim dokumen ke ${chatId}: ${e.message}`);
        results.push({ chatId, ok: false, error: e.message });
      }
    }
    return { ok: results.some(r => r.ok), results, size: stat.size, filename };
  } catch (e) {
    logger.error('[Telegram] sendDocument error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ── Kirim pesan teks + inline keyboard (tombol) ke chat_id tertentu ────────
// buttons: array of array → [[{text, url}], [{text, url}]] (baris tombol).
// Token global; chatIdsStr multi (pisah koma). Dipakai Telegram Report untuk
// tombol "Lihat Dashboard" / deep-link cepat.
async function sendMessageWithButtons(text, chatIdsStr, buttons, cfgOverride) {
  try {
    const cfg = cfgOverride || await _getConfig();
    const token = (cfg.telegram_bot_token || '').trim();
    if (!token) return { ok: false, reason: 'no_token' };
    const chatIds = String(chatIdsStr || cfg.telegram_chat_id || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!chatIds.length) return { ok: false, reason: 'no_chat' };

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const chunks = _splitForTelegram(text);
    const hasKb = Array.isArray(buttons) && buttons.length;
    const results = [];
    for (const chatId of chatIds) {
      let chatOk = true;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const payload = {
          chat_id: chatId, text: chunks[i], parse_mode: 'HTML', disable_web_page_preview: true,
        };
        // Keyboard hanya dipasang di potongan terakhir agar tombol muncul
        // setelah seluruh isi pesan terkirim.
        if (hasKb && isLast) payload.reply_markup = { inline_keyboard: buttons };
        try {
          const res = await axios.post(url, payload, { timeout: 15000 });
          if (res.data?.ok !== true) chatOk = false;
        } catch (e) {
          const detail = e.response?.data?.description || e.message;
          // Fallback: HTML gagal di-parse → kirim ulang sebagai teks biasa.
          if (/can't parse entities|parse entities|unsupported start tag/i.test(detail)) {
            try {
              const plain = String(chunks[i]).replace(/<\/?[^>]+>/g, '');
              const p2 = { chat_id: chatId, text: plain, disable_web_page_preview: true };
              if (hasKb && isLast) p2.reply_markup = { inline_keyboard: buttons };
              const res2 = await axios.post(url, p2, { timeout: 15000 });
              if (res2.data?.ok !== true) chatOk = false;
              logger.warn(`[Telegram] HTML parse gagal (btn) ke ${chatId}, terkirim sbg teks biasa`);
              continue;
            } catch (e2) {
              const d2 = e2.response?.data?.description || e2.message;
              logger.warn(`[Telegram] Fallback teks biasa (btn) gagal ke ${chatId}: ${d2}`);
              chatOk = false;
              continue;
            }
          }
          logger.warn(`[Telegram] Gagal kirim (btn) ke ${chatId}: ${detail}`);
          chatOk = false;
        }
      }
      results.push({ chatId, ok: chatOk });
    }
    return { ok: results.some(r => r.ok), results };
  } catch (e) {
    logger.error('[Telegram] sendMessageWithButtons error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ── Long-polling: ambil update terbaru (untuk bot 2-arah) ──────────────
// offset: update_id terakhir+1 (agar tidak mengambil ulang). timeout detik.
async function getUpdates(offset, timeoutSec = 25, cfgOverride) {
  const cfg = cfgOverride || await _getConfig();
  const token = (cfg.telegram_bot_token || '').trim();
  if (!token) return { ok: false, reason: 'no_token', result: [] };
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
      params: { offset: offset || undefined, timeout: timeoutSec, allowed_updates: JSON.stringify(['message', 'callback_query']) },
      timeout: (timeoutSec + 10) * 1000,
    });
    return { ok: res.data?.ok === true, result: res.data?.result || [] };
  } catch (e) {
    const detail = e.response?.data?.description || e.message;
    return { ok: false, error: detail, result: [] };
  }
}

// ── Jawab callback_query (hentikan loading spinner di tombol) ──────────
async function answerCallbackQuery(callbackQueryId, text, cfgOverride) {
  try {
    const cfg = cfgOverride || await _getConfig();
    const token = (cfg.telegram_bot_token || '').trim();
    if (!token || !callbackQueryId) return { ok: false };
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
    const body = { callback_query_id: callbackQueryId };
    if (text) body.text = text;
    const res = await axios.post(url, body, { timeout: 10000 });
    return { ok: res.data?.ok === true };
  } catch (e) {
    return { ok: false, error: e.response?.data?.description || e.message };
  }
}

// ── Kirim pesan dgn ForceReply (buka keyboard balasan terkunci) ────────
// Telegram akan otomatis memunculkan kolom balasan ke pesan ini, sehingga
// user cukup mengetik nilainya (mis. nama/CID) tanpa perlu ketik command.
// input_field_placeholder memberi hint di kolom input (opsional).
async function sendForceReply(text, chatId, placeholder, cfgOverride) {
  try {
    const cfg = cfgOverride || await _getConfig();
    const token = (cfg.telegram_bot_token || '').trim();
    if (!token) return { ok: false, reason: 'no_token' };
    const target = String(chatId || cfg.telegram_chat_id || '').trim();
    if (!target) return { ok: false, reason: 'no_chat' };
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const reply_markup = { force_reply: true, selective: true };
    if (placeholder) reply_markup.input_field_placeholder = String(placeholder).slice(0, 64);
    const res = await axios.post(url, {
      chat_id: target, text, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup,
    }, { timeout: 15000 });
    return { ok: res.data?.ok === true, messageId: res.data?.result?.message_id };
  } catch (e) {
    const detail = e.response?.data?.description || e.message;
    logger.warn('[Telegram] sendForceReply error: ' + detail);
    return { ok: false, error: detail };
  }
}

module.exports = { sendMessage, sendMessageTo, sendMessageWithButtons, sendForceReply, answerCallbackQuery, sendDocument, testConnection, getUpdates, isEnabled, _getConfig };
