'use strict';

/**
 * TelegramBotService.js  — Bot Telegram 2-arah (Paket B)
 * ─────────────────────────────────────────────────────────────────────
 * Memungkinkan admin mengirim PERINTAH ke bot dari Telegram dan mendapat
 * balasan langsung — tanpa membuka dashboard. Berguna untuk operasional
 * lapangan (cek status gangguan, lookup pelanggan, isolir/restore cepat).
 *
 * MEKANISME: long-polling getUpdates (bukan webhook) → tidak butuh URL publik
 * / sertifikat HTTPS. Cocok untuk ISP yang panel-nya di jaringan internal.
 *
 * KEAMANAN:
 *   - Hanya chat_id terdaftar (telegram_chat_id global / telegram_chat_admin)
 *     yang boleh menjalankan perintah. Chat lain diabaikan.
 *   - Perintah destruktif (/isolir, /restore) butuh telegram_bot_allow_control=1.
 *   - Bot dimatikan total bila telegram_bot_enabled != 1.
 *
 * PERINTAH:
 *   /start, /help                 → bantuan
 *   /status                       → ringkasan jumlah down per jenis
 *   /down [device|ont|ip|pppoe]   → daftar entitas yang sedang down
 *   /cek <nama|id|ip|user>        → cari pelanggan & tampilkan status
 *   /isolir <customer_id>         → isolir pelanggan (perlu izin kontrol)
 *   /restore <customer_id>        → pulihkan pelanggan (perlu izin kontrol)
 *
 * Setting app_settings:
 *   telegram_bot_enabled        0/1
 *   telegram_bot_allow_control  0/1  (izinkan /isolir /restore)
 *   telegram_chat_admin         daftar chat_id admin (opsional, multi koma).
 *                               Kosong = pakai telegram_chat_id global.
 *   telegram_bot_offset         (internal) update_id terakhir diproses.
 * ─────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');
const Telegram = require('./TelegramService');

let _running = false;     // loop poll aktif?
let _stop = false;        // sinyal berhenti
let _offset = 0;          // update offset
let _booted = false;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function _getSetting(key, def = '') {
  const { AppSetting } = require('../models');
  const row = await AppSetting.findOne({ where: { key } });
  return (row && row.value != null && row.value !== '') ? row.value : def;
}
async function _setSetting(key, value) {
  const { AppSetting } = require('../models');
  await AppSetting.upsert({ key, value: String(value == null ? '' : value), type: 'string' });
}

// Daftar chat_id yang diizinkan menjalankan perintah.
function _allowedChats(cfg, adminList) {
  const admins = String(adminList || '').split(',').map(s => s.trim()).filter(Boolean);
  if (admins.length) return new Set(admins);
  return new Set(String(cfg.telegram_chat_id || '').split(',').map(s => s.trim()).filter(Boolean));
}

// Balas ke chat tertentu (token global).
async function _reply(chatId, text) {
  try { await Telegram.sendMessageTo(text, String(chatId)); }
  catch (e) { logger.warn('[TGBot] reply gagal: ' + (e.message || e)); }
}

// Balas dengan inline keyboard (tombol). buttons = array of rows; tiap row
// array of { text, data }. data dikirim balik via callback_query.
async function _replyButtons(chatId, text, buttons) {
  try {
    const kb = (buttons || []).map(row => row.map(b => ({ text: b.text, callback_data: b.data })));
    await Telegram.sendMessageWithButtons(text, String(chatId), kb);
  } catch (e) { logger.warn('[TGBot] reply(btn) gagal: ' + (e.message || e)); }
}

// Catat aksi bot ke activity_logs (audit). Tidak pernah melempar error
// (audit tidak boleh mengganggu aksi utama). chatId = identitas pelaku.
async function _audit(chatId, action, description, opts = {}) {
  try {
    const { ActivityLog } = require('../models');
    await ActivityLog.create({
      user_id: null,
      action: String(action || 'bot_action').slice(0, 50),
      module: 'telegram_bot',
      description: String(description || '').slice(0, 2000),
      target_type: opts.targetType ? String(opts.targetType).slice(0, 50) : null,
      target_id: (opts.targetId != null && /^\d+$/.test(String(opts.targetId))) ? Number(opts.targetId) : null,
      old_data: opts.oldData || null,
      new_data: opts.newData || null,
      ip_address: null,
      user_agent: `telegram-bot:chat=${String(chatId)}`,
    });
  } catch (e) {
    logger.warn('[TGBot] audit gagal: ' + (e.message || e));
  }
}

// ── /ping: ICMP ke IP/domain atau ke IP pelanggan (by nama/ID) ─────────
const { execFile } = require('child_process');

const _PING_HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.\-:]{0,253}[a-zA-Z0-9])?$/;

// Jalankan ping & parse hasil. Pakai execFile (argumen terpisah, tanpa shell).
function _runPing(host, { count = 4, timeoutSec = 2 } = {}) {
  return new Promise((resolve) => {
    if (!host || !_PING_HOST_RE.test(host)) {
      return resolve({ ok: false, error: 'Target tidak valid.' });
    }
    const args = ['-c', String(count), '-W', String(timeoutSec), host];
    execFile('ping', args, { timeout: (count * timeoutSec + 5) * 1000 }, (err, stdout) => {
      const out = stdout || '';
      const lossM = out.match(/([\d.]+)%\s*packet loss/i);
      const loss = lossM ? parseFloat(lossM[1]) : (err ? 100 : null);
      const rttM = out.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+/);
      const avg = rttM ? parseFloat(rttM[1]) : null;
      const ipM = out.match(/PING\s+\S+\s+\(([\d.a-fA-F:]+)\)/);
      const resolvedIp = ipM ? ipM[1] : null;
      const recvM = out.match(/(\d+)\s+received|(\d+)\s+packets received/);
      const received = recvM ? parseInt(recvM[1] || recvM[2], 10) : 0;
      const reachable = received > 0 && (loss == null || loss < 100);
      resolve({ ok: true, reachable, loss, avg, resolvedIp, received, count });
    });
  });
}

async function _resolveCustomerIp(query) {
  const q = (query || '').trim();
  if (!q) return null;
  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  let cust = null;
  try {
    cust = await Customer.findOne({
      where: {
        [Op.or]: [
          { customer_id: q },
          { name: { [Op.like]: `%${q}%` } },
          { static_ip: q },
          { pppoe_username: q },
          { phone: { [Op.like]: `%${q}%` } },
        ],
      },
      attributes: ['id', 'customer_id', 'name', 'static_ip', 'pppoe_username'],
    });
  } catch (_) { return null; }
  if (!cust) return null;
  return {
    name: cust.name, customerId: cust.customer_id || cust.id,
    ip: cust.static_ip || null, pppoeUser: cust.pppoe_username || null,
  };
}

function _looksLikeHost(s) {
  const t = (s || '').trim();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(t)) return true;
  if (/^[a-zA-Z0-9][a-zA-Z0-9.\-]*\.[a-zA-Z]{2,}$/.test(t)) return true;
  if (/^[0-9a-fA-F:]+:[0-9a-fA-F:]+$/.test(t)) return true;
  return false;
}

async function _cmdPing(chatId, arg) {
  const q = (arg || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format:\n' +
      '<code>/ping &lt;ip|domain&gt;</code> — mis. /ping 8.8.8.8 atau /ping google.com\n' +
      '<code>/ping &lt;nama|id pelanggan&gt;</code> — ping ke IP pelanggan');
    return;
  }
  let target = q, label = q, custInfo = null;
  if (!_looksLikeHost(q)) {
    custInfo = await _resolveCustomerIp(q);
    if (!custInfo) {
      await _reply(chatId, `Pelanggan "<b>${esc(q)}</b>" tidak ditemukan, dan bukan IP/domain valid.`);
      return;
    }
    if (!custInfo.ip) {
      await _reply(chatId,
        `Pelanggan <b>${esc(custInfo.name)}</b> (${esc(custInfo.customerId)}) ditemukan, ` +
        `tetapi tidak punya IP statis untuk di-ping.` +
        (custInfo.pppoeUser ? `\nUser PPPoE: <code>${esc(custInfo.pppoeUser)}</code>` : ''));
      return;
    }
    target = custInfo.ip;
    label = `${custInfo.name} (${custInfo.customerId})`;
  }
  await _reply(chatId, `Melakukan ping ke <b>${esc(label)}</b>…`);
  const r = await _runPing(target, { count: 4, timeoutSec: 2 });
  if (!r.ok) { await _reply(chatId, `Gagal ping: ${esc(r.error || 'error')}`); return; }
  const lines = ['<b>Hasil Ping</b>', ''];
  lines.push(`Target : <b>${esc(label)}</b>`);
  if (custInfo || target !== label) lines.push(`IP     : <code>${esc(r.resolvedIp || target)}</code>`);
  lines.push(`Status : ${r.reachable ? 'ONLINE (membalas)' : 'TIDAK MERESPONS'}`);
  lines.push(`Paket  : ${r.received}/${r.count} diterima`);
  if (r.loss != null) lines.push(`Loss   : ${r.loss}%`);
  if (r.avg != null) lines.push(`Latensi: ${r.avg} ms (rata-rata)`);
  await _reply(chatId, lines.join('\n'));
}

// ── Registry perintah (DB, dengan cache singkat) ───────────────────────
let _cmdCache = null, _cmdCacheAt = 0;
const CMD_CACHE_MS = 15000;

async function _loadCommands() {
  const now = Date.now();
  if (_cmdCache && (now - _cmdCacheAt) < CMD_CACHE_MS) return _cmdCache;
  try {
    const { BotCommand } = require('../models');
    const rows = await BotCommand.findAll({ where: { enabled: true }, order: [['sort_order', 'ASC']] });
    const map = new Map();
    const list = [];
    for (const r of rows) {
      const def = {
        keyword: r.keyword, type: r.type, handler: r.handler, dataSource: r.data_source,
        description: r.description, replyTemplate: r.reply_template, requireControl: !!r.require_control,
      };
      list.push(def);
      map.set(r.keyword.toLowerCase(), def);
      String(r.aliases || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        .forEach(a => map.set(a, def));
    }
    _cmdCache = { map, list };
    _cmdCacheAt = now;
  } catch (e) {
    logger.warn('[TGBot] gagal load registry: ' + (e.message || e));
    _cmdCache = { map: new Map(), list: [] };
    _cmdCacheAt = now;
  }
  return _cmdCache;
}

function invalidateCommandCache() { _cmdCache = null; _cmdCacheAt = 0; }

// ── Rate-limit per chat (anti-spam) ────────────────────────────────────
// Sliding window: maksimal RL_MAX perintah per RL_WINDOW_MS per chat.
// Perintah "berat" (query agregat) punya cooldown sendiri agar tidak
// di-hammer. Murni in-memory; reset saat proses restart.
const RL_WINDOW_MS = 60 * 1000;   // jendela 60 detik
const RL_MAX = 20;                // maks 20 perintah / menit / chat
const RL_HEAVY_COOLDOWN_MS = 8000; // jeda antar perintah berat (8 detik)
const RL_HEAVY = new Set(['ringkasan', 'jatuhtempo', 'down', 'tiket', 'cekodp', 'cekodc', 'cekpop', 'cekhotspot', 'cekont', 'cekmikrotik', 'cekpppoe', 'cekqueue', 'cekinterface', 'cekip', 'cekisolir', 'cektrafik', 'backupmikrotik']);

// Daftar handler builtin yang keyword-nya = nama handler (dipakai tombol menu
// agar bisa dijalankan langsung tanpa bergantung registry bot_commands).
const BUILTIN_HANDLERS = new Set([
  'status', 'down', 'cek', 'cekcustdata', 'cekodp', 'cekodc', 'cekpop', 'cekont',
  'cekbayar', 'jatuhtempo', 'ringkasan', 'tiket', 'cekreseller', 'cekvoucher',
  'cekhotspot', 'cekmikrotik', 'cekpppoe', 'createpppoe', 'cekqueue', 'createqueue', 'cekinterface', 'cekip', 'cekisolir', 'cektrafik', 'ping', 'backupmikrotik',
]);

const _rlHits = new Map();    // chatId -> [timestamps]
const _rlHeavyAt = new Map(); // chatId -> { cmd: lastTs }
let _rlSweepAt = 0;

// Cek apakah perintah dari chat ini boleh jalan.
// return { ok, retryAfter } — retryAfter detik bila diblok.
function _rateLimit(chatId, cmd) {
  const now = Date.now();
  const key = String(chatId);

  // Sweep ringan tiap menit agar Map tidak membengkak.
  if (now - _rlSweepAt > RL_WINDOW_MS) {
    _rlSweepAt = now;
    for (const [k, arr] of _rlHits) {
      const keep = arr.filter(t => now - t < RL_WINDOW_MS);
      if (keep.length) _rlHits.set(k, keep); else _rlHits.delete(k);
    }
  }

  // Window umum.
  const arr = (_rlHits.get(key) || []).filter(t => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) {
    const oldest = arr[0];
    const retryAfter = Math.ceil((RL_WINDOW_MS - (now - oldest)) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1), reason: 'window' };
  }

  // Cooldown perintah berat.
  if (RL_HEAVY.has(cmd)) {
    const map = _rlHeavyAt.get(key) || {};
    const last = map[cmd] || 0;
    if (now - last < RL_HEAVY_COOLDOWN_MS) {
      const retryAfter = Math.ceil((RL_HEAVY_COOLDOWN_MS - (now - last)) / 1000);
      return { ok: false, retryAfter: Math.max(retryAfter, 1), reason: 'heavy' };
    }
    map[cmd] = now;
    _rlHeavyAt.set(key, map);
  }

  arr.push(now);
  _rlHits.set(key, arr);
  return { ok: true };
}

// Render placeholder umum + custom vars.
function _renderTemplate(tpl, vars = {}) {
  const base = {
    waktu: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }),
  };
  const all = { ...base, ...vars };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(all, k) ? all[k] : m);
}

// ── Handler tiap perintah ──────────────────────────────────────────────
async function _cmdHelp(chatId, allowControl) {
  const { list } = await _loadCommands();
  const lines = ['<b>Bot Monitoring ISP</b>', 'Tip: ketik /menu untuk menu tombol.', ''];
  if (list && list.length) {
    let shown = 0, hidden = 0;
    for (const c of list) {
      if (c.keyword === 'help') continue;
      if (c.requireControl && !allowControl) { hidden++; continue; }
      const desc = c.description ? ' — ' + esc(c.description) : '';
      lines.push(`<b>/${esc(c.keyword)}</b>${desc}`);
      shown++;
    }
    lines.push('');
    lines.push(`<i>${shown} perintah tersedia.${hidden && !allowControl ? ` ${hidden} perintah kontrol tersembunyi (butuh izin).` : ''}</i>`);
  } else {
    // Fallback bila registry kosong.
    lines.push('<b>/status</b> — ringkasan gangguan saat ini');
    lines.push('<b>/down</b> [jenis] — daftar yang sedang down');
    lines.push('<b>/cek</b> &lt;nama|id|ip|user&gt; — cari pelanggan');
    if (allowControl) {
      lines.push('<b>/isolir</b> &lt;id_pelanggan&gt; — isolir pelanggan');
      lines.push('<b>/restore</b> &lt;id_pelanggan&gt; — pulihkan pelanggan');
    }
  }
  await _replyButtons(chatId, lines.join('\n'), [[{ text: 'Buka Menu', data: 'm:root' }]]);
}

async function _cmdStatus(chatId) {
  const Store = require('./MonitorStateStore');
  const counts = {
    device: Store.countDown('device'),
    ont: Store.countDown('ont'),
    ip: Store.countDown('ip'),
    pppoe: Store.countDown('pppoe'),
  };
  const total = counts.device + counts.ont + counts.ip + counts.pppoe;
  const icon = total > 0 ? '[GANGGUAN]' : '[NORMAL]';
  const lines = [
    `${icon} <b>Status Monitoring</b>`,
    '',
    `Perangkat down: <b>${counts.device}</b>`,
    `ONT down: <b>${counts.ont}</b>`,
    `IP timeout: <b>${counts.ip}</b>`,
    `PPPoE down: <b>${counts.pppoe}</b>`,
    '',
    total > 0 ? `Total gangguan: <b>${total}</b>` : 'Semua normal',
  ];
  await _reply(chatId, lines.join('\n'));
}

async function _cmdDown(chatId, arg) {
  const { NotifLog } = require('../models');
  const { Op } = require('sequelize');
  const kinds = ['device', 'ont', 'ip', 'pppoe'];
  const filterKind = kinds.includes((arg || '').trim()) ? arg.trim() : null;

  // Ambil entitas yang status terakhirnya 'down' dari monitor_states + judul
  // terakhir dari notif_logs (best-effort).
  const { MonitorState } = require('../models');
  const where = { status: 'down' };
  if (filterKind) where.kind = filterKind;
  let rows = [];
  try { rows = await MonitorState.findAll({ where, limit: 40, order: [['updated_at', 'DESC']] }); } catch (_) {}

  if (!rows.length) {
    await _reply(chatId, filterKind ? `Tidak ada ${filterKind} yang down.` : 'Tidak ada gangguan aktif.');
    return;
  }

  // Lookup judul terakhir per (kind,ref_id) dari notif_logs.
  const titleMap = new Map();
  try {
    const logs = await NotifLog.findAll({
      where: { event: 'down' }, order: [['created_at', 'DESC']], limit: 200,
    });
    for (const l of logs) {
      const k = `${l.kind}:${l.ref_id}`;
      if (!titleMap.has(k) && l.title) titleMap.set(k, l.title + (l.detail ? ` (${l.detail})` : ''));
    }
  } catch (_) {}

  const KIND = { device: '[DEV]', ont: '[ONT]', ip: '[IP]', pppoe: '[PPPoE]' };
  const lines = [`<b>Sedang Down${filterKind ? ' — ' + filterKind : ''}: ${rows.length}</b>`, ''];
  rows.slice(0, 30).forEach(r => {
    const t = titleMap.get(`${r.kind}:${r.ref_id}`) || `#${r.ref_id}`;
    lines.push(`${KIND[r.kind] || '-'} ${esc(t)}`);
  });
  if (rows.length > 30) lines.push(`… dan ${rows.length - 30} lainnya`);
  await _reply(chatId, lines.join('\n'));
}

async function _cmdCek(chatId, query) {
  const q = (query || '').trim();
  if (!q) { await _reply(chatId, 'Format: <code>/cek &lt;nama|id|ip|user&gt;</code>'); return; }
  const { Customer } = require('../models');
  const { Op } = require('sequelize');

  let custs = [];
  try {
    custs = await Customer.findAll({
      where: {
        [Op.or]: [
          { customer_id: q },
          { name: { [Op.like]: `%${q}%` } },
          { static_ip: q },
          { pppoe_username: q },
          { phone: { [Op.like]: `%${q}%` } },
        ],
      },
      attributes: ['id', 'customer_id', 'name', 'phone', 'status', 'isolir_status', 'static_ip', 'pppoe_username'],
      limit: 6,
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mencari: ' + esc(e.message)); return;
  }

  if (!custs.length) { await _reply(chatId, `Tidak ada pelanggan cocok dengan "<b>${esc(q)}</b>".`); return; }

  const statusIcon = (s, isol) => (isol && isol !== 'active') ? '[ISOLIR]' : (s === 'active' ? '[AKTIF]' : '[NONAKTIF]');
  const lines = [`<b>Hasil pencarian:</b> ${custs.length}`, ''];
  custs.forEach(c => {
    lines.push(`${statusIcon(c.status, c.isolir_status)} <b>${esc(c.name || '-')}</b> (${esc(c.customer_id || c.id)})`);
    const meta = [];
    if (c.pppoe_username) meta.push('user: ' + esc(c.pppoe_username));
    if (c.static_ip) meta.push('ip: ' + esc(c.static_ip));
    if (c.phone) meta.push('hp: ' + esc(c.phone));
    meta.push('status: ' + esc(c.status) + (c.isolir_status && c.isolir_status !== 'active' ? '/' + esc(c.isolir_status) : ''));
    lines.push('   ' + meta.join(' · '));
  });
  await _reply(chatId, lines.join('\n'));
}

async function _cmdControl(chatId, action, arg, allowControl) {
  if (!allowControl) {
    await _reply(chatId, 'Perintah kontrol dinonaktifkan. Aktifkan "Izinkan kontrol via bot" di Telegram Center.');
    return;
  }
  const idStr = (arg || '').trim();
  if (!idStr) { await _reply(chatId, `Format: <code>/${action} &lt;id_pelanggan&gt;</code>`); return; }

  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  let cust = null;
  try {
    cust = await Customer.findOne({
      where: { [Op.or]: [{ customer_id: idStr }, { id: /^\d+$/.test(idStr) ? Number(idStr) : -1 }] },
      attributes: ['id', 'customer_id', 'name', 'status', 'isolir_status'],
    });
  } catch (_) {}
  if (!cust) { await _reply(chatId, `Pelanggan "<b>${esc(idStr)}</b>" tidak ditemukan.`); return; }

  try {
    const Isolir = require('./IsolirService');
    if (action === 'isolir') {
      await Isolir.isolirCustomer(cust.id, 'telegram-bot', null);
      await _audit(chatId, 'customer_isolir', `Isolir pelanggan ${cust.name} (${cust.customer_id})`, { targetType: 'customer', targetId: cust.id });
      await _reply(chatId, `<b>${esc(cust.name)}</b> (${esc(cust.customer_id)}) telah <b>diisolir</b>.`);
    } else {
      await Isolir.restoreCustomer(cust.id, 'telegram-bot', null);
      await _audit(chatId, 'customer_restore', `Restore pelanggan ${cust.name} (${cust.customer_id})`, { targetType: 'customer', targetId: cust.id });
      await _reply(chatId, `<b>${esc(cust.name)}</b> (${esc(cust.customer_id)}) telah <b>dipulihkan</b>.`);
    }
  } catch (e) {
    await _reply(chatId, `Gagal ${action}: `+ esc(e.message || 'error'));
  }
}

// ── /cekcustdata: detail lengkap data pelanggan ────────────────────────
// Cari by nama/CID/IP/PPPoE → tampilkan nama, CID, tgl aktivasi, alamat,
// paket, IP, user PPPoE, dan link koordinat Maps bila tersedia.
function _mapsLink(lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || (la === 0 && ln === 0)) return null;
  return `https://www.google.com/maps?q=${la},${ln}`;
}

const _CUST_STATUS = { active: 'Aktif', inactive: 'Nonaktif', isolated: 'Terisolir', suspended: 'Ditangguhkan' };

async function _cmdCekCustData(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekcustdata &lt;nama|CID|IP|PPPoE&gt;</code>\n' +
      'Contoh: <code>/cekcustdata FLAYNET.COM</code>, <code>/cekcustdata CID010</code>, ' +
      '<code>/cekcustdata 10.10.10.5</code>');
    return;
  }

  const { Customer, Package, InfrastructurePoint } = require('../models');
  const { Op } = require('sequelize');

  let custs = [];
  try {
    custs = await Customer.findAll({
      where: {
        [Op.or]: [
          { customer_id: q },
          { name: { [Op.like]: `%${q}%` } },
          { static_ip: q },
          { pppoe_username: q },
        ],
      },
      include: [{ model: Package, as: 'package', attributes: ['name', 'speed_down', 'speed_up'], required: false }],
      attributes: [
        'id', 'customer_id', 'name', 'address', 'status', 'isolir_status',
        'static_ip', 'pppoe_username', 'phone', 'connection_type',
        'installation_date', 'latitude', 'longitude', 'infra_parent_id',
      ],
      limit: 6,
      order: [['name', 'ASC']],
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mencari: ' + esc(e.message));
    return;
  }

  if (!custs.length) {
    await _reply(chatId, `Tidak ada pelanggan cocok dengan "<b>${esc(q)}</b>".`);
    return;
  }

  if (custs.length > 1) {
    const lines = [`<b>Ditemukan ${custs.length} pelanggan</b> untuk "<b>${esc(q)}</b>":`, ''];
    custs.forEach(c => {
      const isol = (c.isolir_status && c.isolir_status !== 'active');
      const st = isol ? '[ISOLIR]' : (c.status === 'active' ? '[AKTIF]' : '[NONAKTIF]');
      lines.push(`${st} <b>${esc(c.name || '-')}</b> (${esc(c.customer_id || c.id)})`);
    });
    lines.push('', 'Persempit pencarian dengan CID/IP/PPPoE untuk detail lengkap.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // Satu hasil → detail lengkap.
  const c = custs[0];

  // Ambil nama ODP induk bila ada.
  let odpName = null;
  if (c.infra_parent_id) {
    try {
      const odp = await InfrastructurePoint.findByPk(c.infra_parent_id, { attributes: ['name', 'type'] });
      if (odp) odpName = `${odp.name}${odp.type ? ' (' + String(odp.type).toUpperCase() + ')' : ''}`;
    } catch (_) {}
  }

  const isol = (c.isolir_status && c.isolir_status !== 'active');
  const statusTxt = (_CUST_STATUS[c.status] || c.status || '-') + (isol ? ' / Terisolir' : '');
  const pkg = c.package
    ? `${c.package.name}${c.package.speed_down ? ' (' + c.package.speed_down + '/' + (c.package.speed_up || '-') + ' Mbps)' : ''}`
    : '-';

  const lines = [
    `<b>Data Pelanggan</b>`,
    '',
    `Nama      : <b>${esc(c.name || '-')}</b>`,
    `CID       : <code>${esc(c.customer_id || c.id)}</code>`,
    `Aktivasi  : ${c.installation_date ? esc(_fmtTgl(c.installation_date)) : '-'}`,
    `Paket     : ${esc(pkg)}`,
    `Koneksi   : ${esc((c.connection_type || '-').toUpperCase())}`,
    `IP        : ${c.static_ip ? '<code>' + esc(c.static_ip) + '</code>' : '-'}`,
    `PPPoE     : ${c.pppoe_username ? '<code>' + esc(c.pppoe_username) + '</code>' : '-'}`,
    `Status    : ${esc(statusTxt)}`,
  ];
  if (c.phone) lines.push(`HP        : ${esc(c.phone)}`);
  if (odpName) lines.push(`ODP       : ${esc(odpName)}`);
  lines.push(`Alamat    : ${esc(c.address || '-')}`);

  const mapUrl = _mapsLink(c.latitude, c.longitude);
  if (mapUrl) {
    lines.push(`Koordinat : ${esc(c.latitude)}, ${esc(c.longitude)}`);
    lines.push(`Maps      : <a href="${mapUrl}">Buka di Google Maps</a>`);
  } else {
    lines.push('Koordinat : (belum ada titik map)');
  }

  // Tombol kelola pelanggan: Isolir / Restore (sesuai status).
  _mgmtSet(chatId, { type: 'customer', custId: c.id, name: c.name, customerId: c.customer_id, phone: c.phone || '', pppoeUser: c.pppoe_username || '' });
  const isIsolated = (c.isolir_status && c.isolir_status !== 'active') || c.status === 'isolated';
  const row = isIsolated
    ? [{ text: 'Restore (Pulihkan)', data: 'cm:restore' }]
    : [{ text: 'Isolir Pelanggan', data: 'cm:isolir' }];
  if (c.pppoe_username) row.push({ text: 'Cek ONT', data: 'cm:ont' });
  const rows2 = [row];
  if (c.phone) rows2.push([{ text: 'Kirim Tagihan WA', data: 'cm:tagih' }]);
  await _replyButtons(chatId, lines.join('\n'), rows2);
}

function _fmtTgl(d) {
  try {
    return new Date(d).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) { return String(d); }
}

// ── /cekodp: status & ketersediaan ODP ─────────────────────────────────
// Cari by nama ODP (atau keyword lokasi/alamat). Bila banyak hasil →
// ringkasan ketersediaan port. Bila satu hasil → detail + daftar pelanggan.
async function _cmdCekOdp(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekodp &lt;nama/keyword ODP&gt;</code>\n' +
      'Contoh: <code>/cekodp ODP-12</code> atau <code>/cekodp ODP Bogor</code>');
    return;
  }

  const { InfrastructurePoint, Customer } = require('../models');
  const { Op } = require('sequelize');

  let odps = [];
  try {
    odps = await InfrastructurePoint.findAll({
      where: {
        type: 'odp',
        [Op.or]: [
          { name: { [Op.like]: `%${q}%` } },
          { address: { [Op.like]: `%${q}%` } },
        ],
      },
      attributes: ['id', 'name', 'address', 'status', 'capacity', 'used_ports', 'latitude', 'longitude'],
      order: [['name', 'ASC']],
      limit: 25,
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mencari ODP: ' + esc(e.message));
    return;
  }

  if (!odps.length) {
    await _reply(chatId, `Tidak ada ODP cocok dengan "<b>${esc(q)}</b>".`);
    return;
  }

  // Hitung jumlah pelanggan terkoneksi per ODP (real, dari infra_parent_id).
  const ids = odps.map(o => o.id);
  const connMap = new Map();
  try {
    const custs = await Customer.findAll({
      where: { infra_parent_id: { [Op.in]: ids } },
      attributes: ['infra_parent_id'],
    });
    for (const cu of custs) {
      const k = cu.infra_parent_id;
      connMap.set(k, (connMap.get(k) || 0) + 1);
    }
  } catch (_) {}

  const _avail = (o) => {
    const cap = Number(o.capacity || 0);
    const used = Math.max(Number(o.used_ports || 0), connMap.get(o.id) || 0);
    return { cap, used, free: cap > 0 ? Math.max(cap - used, 0) : null };
  };
  const _odpIcon = (o) => {
    if (o.status === 'maintenance') return '[MAINT]';
    if (o.status === 'inactive') return '[OFF]';
    const a = _avail(o);
    if (a.cap > 0 && a.free === 0) return '[PENUH]'; // penuh
    return '[OK]';
  };

  // Banyak hasil → ringkasan ketersediaan.
  if (odps.length > 1) {
    const lines = [`<b>${odps.length} ODP ditemukan</b> untuk "<b>${esc(q)}</b>":`, ''];
    odps.forEach(o => {
      const a = _avail(o);
      const portTxt = a.cap > 0 ? `${a.used}/${a.cap} (sisa ${a.free})` : `${a.used} terpakai (kapasitas -)`;
      lines.push(`${_odpIcon(o)} <b>${esc(o.name)}</b>`);
      lines.push(`   Port: ${portTxt}${o.address ? ' · ' + esc(o.address) : ''}`);
    });
    lines.push('', 'Ketik nama ODP spesifik untuk detail + daftar pelanggan.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // Satu hasil → detail lengkap + daftar pelanggan terkoneksi.
  const o = odps[0];
  const a = _avail(o);
  let custList = [];
  try {
    custList = await Customer.findAll({
      where: { infra_parent_id: o.id },
      attributes: ['customer_id', 'name', 'status', 'isolir_status', 'pppoe_username', 'static_ip'],
      order: [['name', 'ASC']],
      limit: 60,
    });
  } catch (_) {}

  const STATUS_ODP = { active: 'Aktif', inactive: 'Nonaktif', maintenance: 'Maintenance' };
  const lines = [
    `${_odpIcon(o)} <b>Detail ODP</b>`,
    '',
    `Nama      : <b>${esc(o.name)}</b>`,
    `Status    : ${esc(STATUS_ODP[o.status] || o.status || '-')}`,
    `Kapasitas : ${a.cap > 0 ? a.cap + ' port' : '- (belum diset)'}`,
    `Terpakai  : ${a.used} port`,
    `Tersedia  : ${a.free == null ? '-' : '<b>' + a.free + ' port</b>'}`,
    `Lokasi    : ${esc(o.address || '-')}`,
  ];
  const mapUrl = _mapsLink(o.latitude, o.longitude);
  if (mapUrl) {
    lines.push(`Koordinat : ${esc(o.latitude)}, ${esc(o.longitude)}`);
    lines.push(`Maps      : <a href="${mapUrl}">Buka di Google Maps</a>`);
  } else {
    lines.push('Koordinat : (belum ada titik map)');
  }

  lines.push('', `<b>Pelanggan terkoneksi: ${custList.length}</b>`);
  if (custList.length) {
    custList.slice(0, 40).forEach(cu => {
      const isol = (cu.isolir_status && cu.isolir_status !== 'active');
      const st = isol ? '[ISOLIR]' : (cu.status === 'active' ? '[AKTIF]' : '[NONAKTIF]');
      const id = cu.pppoe_username || cu.static_ip || cu.customer_id;
      lines.push(`${st} ${esc(cu.name || '-')} (${esc(id)})`);
    });
    if (custList.length > 40) lines.push(`… dan ${custList.length - 40} lainnya`);
  } else {
    lines.push('(belum ada pelanggan ter-assign ke ODP ini)');
  }

  await _reply(chatId, lines.join('\n'));
}

// ── Helper format Rupiah & periode (lokal untuk bot) ───────────────────
function _rp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }
const _BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function _periode(m, y) {
  const mm = parseInt(m, 10);
  if (!mm || mm < 1 || mm > 12 || !y) return '-';
  return `${_BULAN[mm - 1]} ${y}`;
}

// ── /cekbayar: riwayat & status pembayaran pelanggan ───────────────────
const _PAYM_LABEL = {
  cash: 'Tunai', transfer: 'Transfer', dana: 'DANA', ovo: 'OVO', gopay: 'GoPay',
  qris: 'QRIS', ewallet: 'E-Wallet', gateway: 'Gateway', field_collection: 'Tagih Lapangan', other: 'Lainnya',
};
async function _cmdCekBayar(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekbayar &lt;nama|CID|IP|PPPoE&gt;</code>\n' +
      'Contoh: <code>/cekbayar FLAYNET.COM</code> atau <code>/cekbayar CID010</code>');
    return;
  }

  const { Customer, Invoice, Payment } = require('../models');
  const { Op } = require('sequelize');

  let cust = null;
  try {
    cust = await Customer.findOne({
      where: {
        [Op.or]: [
          { customer_id: q },
          { name: { [Op.like]: `%${q}%` } },
          { static_ip: q },
          { pppoe_username: q },
        ],
      },
      attributes: ['id', 'customer_id', 'name'],
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mencari: ' + esc(e.message)); return;
  }
  if (!cust) { await _reply(chatId, `Pelanggan "<b>${esc(q)}</b>" tidak ditemukan.`); return; }

  // Tunggakan saat ini.
  let unpaid = [];
  try {
    unpaid = await Invoice.findAll({
      where: { customer_id: cust.id, status: { [Op.in]: ['unpaid', 'overdue'] } },
      attributes: ['total', 'amount'],
    });
  } catch (_) {}
  const totalTunggakan = unpaid.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);

  // 5 pembayaran terakhir (join invoice utk periode).
  let pays = [];
  try {
    pays = await Payment.findAll({
      include: [{
        model: Invoice, as: 'invoice', required: true,
        where: { customer_id: cust.id },
        attributes: ['invoice_number', 'period_month', 'period_year'],
      }],
      attributes: ['amount', 'payment_method', 'payment_date'],
      order: [['payment_date', 'DESC'], ['id', 'DESC']],
      limit: 5,
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil pembayaran: ' + esc(e.message)); return;
  }

  const lines = [
    '<b>Riwayat Pembayaran</b>',
    '',
    `Nama   : <b>${esc(cust.name || '-')}</b> (${esc(cust.customer_id || cust.id)})`,
    `Tunggakan : ${unpaid.length} invoice · <b>${_rp(totalTunggakan)}</b>`,
    '',
  ];
  if (!pays.length) {
    lines.push('(belum ada pembayaran tercatat)');
  } else {
    lines.push('Pembayaran terakhir:');
    pays.forEach(p => {
      const inv = p.invoice;
      const per = inv ? _periode(inv.period_month, inv.period_year) : '-';
      const tgl = p.payment_date ? _fmtTgl(p.payment_date) : '-';
      const mtd = _PAYM_LABEL[p.payment_method] || p.payment_method || '-';
      lines.push(`- ${esc(tgl)} · <b>${_rp(p.amount)}</b> · ${esc(mtd)} · ${esc(per)}`);
    });
  }

  // Tombol aksi bila ada tunggakan: Tandai Lunas + Kirim Tagihan WA.
  if (unpaid.length > 0) {
    _mgmtSet(chatId, { type: 'bayar', custId: cust.id, name: cust.name, customerId: cust.customer_id });
    await _replyButtons(chatId, lines.join('\n'), [
      [{ text: 'Tandai Lunas', data: 'by:lunas' }, { text: 'Kirim Tagihan WA', data: 'by:tagih' }],
    ]);
  } else {
    await _reply(chatId, lines.join('\n'));
  }
}

// ── /jatuhtempo: daftar pelanggan nunggak / jatuh tempo ────────────────
// Tanpa arg → semua invoice overdue + unpaid yang sudah lewat due_date.
// Arg "hari ini" / "today" → hanya yang jatuh tempo hari ini.
async function _cmdJatuhTempo(chatId, arg) {
  const { Invoice, Customer } = require('../models');
  const { Op } = require('sequelize');
  const a = (arg || '').trim().toLowerCase();
  const onlyToday = ['hari ini', 'hariini', 'today', 'hi'].includes(a);

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const where = { status: { [Op.in]: ['unpaid', 'overdue'] } };
  if (onlyToday) {
    where.due_date = todayStr;
  } else {
    where.due_date = { [Op.lte]: todayStr };
  }

  let rows = [];
  try {
    rows = await Invoice.findAll({
      where,
      include: [{ model: Customer, as: 'customer', attributes: ['customer_id', 'name', 'phone'], required: true }],
      attributes: ['invoice_number', 'total', 'amount', 'due_date'],
      order: [['due_date', 'ASC']],
      limit: 60,
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil data: ' + esc(e.message)); return;
  }

  if (!rows.length) {
    await _reply(chatId, onlyToday
      ? 'Tidak ada pelanggan jatuh tempo hari ini.'
      : 'Tidak ada pelanggan menunggak / lewat jatuh tempo.');
    return;
  }

  const total = rows.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
  const judul = onlyToday ? 'Jatuh Tempo Hari Ini' : 'Menunggak / Lewat Jatuh Tempo';
  const lines = [
    `<b>${judul}: ${rows.length}</b>`,
    `Total nilai: <b>${_rp(total)}</b>`,
    '',
  ];
  rows.slice(0, 40).forEach(i => {
    const c = i.customer;
    lines.push(`- <b>${esc(c.name || '-')}</b> (${esc(c.customer_id || '-')})`);
    lines.push(`  ${_rp(i.total || i.amount)} · tempo ${esc(_fmtTgl(i.due_date))}${c.phone ? ' · ' + esc(c.phone) : ''}`);
  });
  if (rows.length > 40) lines.push(`... dan ${rows.length - 40} lainnya`);
  await _reply(chatId, lines.join('\n'));
}

// ── /ringkasan: laporan harian operasional ─────────────────────────────
// Membangun teks ringkasan harian (dipakai command /ringkasan DAN job cron
// auto-kirim pagi). Mengembalikan string HTML siap kirim.
async function buildDailySummaryText() {
  const { Payment, Invoice, Customer, Ticket } = require('../models');
  const { Op } = require('sequelize');

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const startOfDay = new Date(`${todayStr}T00:00:00`);

  // Pemasukan hari ini.
  let payCount = 0, payTotal = 0;
  try {
    const pays = await Payment.findAll({
      where: { payment_date: todayStr }, attributes: ['amount'],
    });
    payCount = pays.length;
    payTotal = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
  } catch (_) {}

  // Pelanggan baru hari ini (Customer pakai camelCase createdAt).
  let newCust = 0;
  try {
    newCust = await Customer.count({ where: { createdAt: { [Op.gte]: startOfDay } } });
  } catch (_) {}

  // Invoice jatuh tempo hari ini (belum bayar).
  let dueToday = 0, dueTotal = 0;
  try {
    const dues = await Invoice.findAll({
      where: { due_date: todayStr, status: { [Op.in]: ['unpaid', 'overdue'] } },
      attributes: ['total', 'amount'],
    });
    dueToday = dues.length;
    dueTotal = dues.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
  } catch (_) {}

  // Total tunggakan (semua yang lewat/overdue).
  let arrearsCount = 0, arrearsTotal = 0;
  try {
    const arr = await Invoice.findAll({
      where: { status: { [Op.in]: ['unpaid', 'overdue'] }, due_date: { [Op.lte]: todayStr } },
      attributes: ['total', 'amount'],
    });
    arrearsCount = arr.length;
    arrearsTotal = arr.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
  } catch (_) {}

  // Tiket gangguan terbuka.
  let openTickets = 0;
  try {
    openTickets = await Ticket.count({ where: { status: { [Op.in]: ['open', 'in_progress', 'pending'] } } });
  } catch (_) {}

  // Gangguan jaringan saat ini (dari monitor store).
  let downTotal = 0;
  try {
    const Store = require('./MonitorStateStore');
    downTotal = Store.countDown('device') + Store.countDown('ont') + Store.countDown('ip') + Store.countDown('pppoe');
  } catch (_) {}

  const lines = [
    `<b>Ringkasan Harian</b>`,
    `${_fmtTgl(todayStr)}`,
    '',
    `Pemasukan hari ini : <b>${_rp(payTotal)}</b> (${payCount} transaksi)`,
    `Pelanggan baru     : <b>${newCust}</b>`,
    `Jatuh tempo hari ini : <b>${dueToday}</b> invoice · ${_rp(dueTotal)}`,
    `Total tunggakan    : <b>${arrearsCount}</b> invoice · ${_rp(arrearsTotal)}`,
    `Tiket terbuka      : <b>${openTickets}</b>`,
    `Gangguan jaringan  : <b>${downTotal}</b>`,
  ];
  return lines.join('\n');
}

async function _cmdRingkasan(chatId) {
  const text = await buildDailySummaryText();
  await _reply(chatId, text);
}

// Kirim ringkasan harian ke chat admin bot (dipanggil oleh cron pagi).
// Tujuan: telegram_chat_admin -> telegram_chat_id global.
async function sendDailySummary() {
  try {
    const cfg = await Telegram._getConfig();
    if (!Telegram.isEnabled(cfg)) return { ok: false, reason: 'telegram-disabled' };
    const adminList = await _getSetting('telegram_chat_admin', '');
    const target = (adminList && adminList.trim()) ? adminList.trim() : String(cfg.telegram_chat_id || '').trim();
    if (!target) return { ok: false, reason: 'no-chat-target' };
    const text = await buildDailySummaryText();
    await Telegram.sendMessageTo(text, target, cfg);
    return { ok: true, sent: target };
  } catch (e) {
    logger.warn('[TGBot] sendDailySummary gagal: ' + (e.message || e));
    return { ok: false, reason: e.message || 'error' };
  }
}

// ── /tiket: daftar tiket gangguan terbuka ──────────────────────────────
const _TIKET_STATUS = { open: 'Open', in_progress: 'Dikerjakan', pending: 'Pending', resolved: 'Selesai', closed: 'Ditutup' };
const _TIKET_PRIO = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', critical: 'Kritis' };
async function _cmdTiket(chatId, arg) {
  const { Ticket, Customer, User } = require('../models');
  const { Op } = require('sequelize');
  const a = (arg || '').trim().toLowerCase();

  // Filter status opsional; default = yang masih aktif (open/in_progress/pending).
  let statusFilter;
  if (['open', 'pending', 'closed', 'resolved'].includes(a)) statusFilter = [a];
  else if (a === 'progress' || a === 'in_progress') statusFilter = ['in_progress'];
  else statusFilter = ['open', 'in_progress', 'pending'];

  let rows = [];
  try {
    const { literal } = require('sequelize');
    rows = await Ticket.findAll({
      where: { status: { [Op.in]: statusFilter } },
      include: [
        { model: Customer, as: 'customer', attributes: ['name', 'customer_id'], required: false },
        { model: User, as: 'assignee', attributes: ['name'], required: false },
      ],
      attributes: ['ticket_number', 'title', 'type', 'priority', 'status', 'created_at'],
      order: [
        [literal("FIELD(`Ticket`.`priority`, 'critical','high','medium','low')"), 'ASC'],
        ['created_at', 'ASC'],
      ],
      limit: 40,
    });
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil tiket: ' + esc(e.message)); return;
  }

  if (!rows.length) {
    await _reply(chatId, 'Tidak ada tiket pada filter ini.');
    return;
  }

  const judul = (statusFilter.length === 1)
    ? `Tiket (${_TIKET_STATUS[statusFilter[0]] || statusFilter[0]})`
    : 'Tiket Aktif';
  const lines = [`<b>${judul}: ${rows.length}</b>`, ''];
  rows.forEach(t => {
    const prio = _TIKET_PRIO[t.priority] || t.priority || '-';
    const st = _TIKET_STATUS[t.status] || t.status || '-';
    const who = t.customer ? ` · ${esc(t.customer.name)}` : '';
    const asg = t.assignee ? ` · teknisi: ${esc(t.assignee.name)}` : '';
    lines.push(`- <b>${esc(t.ticket_number || '-')}</b> [${esc(prio)}/${esc(st)}]`);
    lines.push(`  ${esc(t.title || '-')}${who}${asg}`);
  });
  await _reply(chatId, lines.join('\n'));
}

// ── /cekodc: ketersediaan ODC + ODP anak di bawahnya ───────────────────
async function _cmdCekOdc(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekodc &lt;nama/keyword ODC&gt;</code>\n' +
      'Contoh: <code>/cekodc ODC-01</code> atau <code>/cekodc ODC Bogor</code>');
    return;
  }
  const { InfrastructurePoint, Customer } = require('../models');
  const { Op } = require('sequelize');

  let odcs = [];
  try {
    odcs = await InfrastructurePoint.findAll({
      where: { type: 'odc', [Op.or]: [{ name: { [Op.like]: `%${q}%` } }, { address: { [Op.like]: `%${q}%` } }] },
      attributes: ['id', 'name', 'address', 'status', 'capacity', 'used_ports', 'latitude', 'longitude'],
      order: [['name', 'ASC']], limit: 25,
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari ODC: ' + esc(e.message)); return; }

  if (!odcs.length) { await _reply(chatId, `Tidak ada ODC cocok dengan "<b>${esc(q)}</b>".`); return; }

  const portTxt = (o) => {
    const cap = Number(o.capacity || 0), used = Number(o.used_ports || 0);
    return cap > 0 ? `${used}/${cap} (sisa ${Math.max(cap - used, 0)})` : `${used} terpakai (kapasitas -)`;
  };

  if (odcs.length > 1) {
    const lines = [`<b>${odcs.length} ODC ditemukan</b> untuk "<b>${esc(q)}</b>":`, ''];
    odcs.forEach(o => {
      lines.push(`- <b>${esc(o.name)}</b> [${esc(o.status || '-')}]`);
      lines.push(`  Port: ${portTxt(o)}${o.address ? ' · ' + esc(o.address) : ''}`);
    });
    lines.push('', 'Ketik nama ODC spesifik untuk detail + ODP di bawahnya.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  const o = odcs[0];
  // ODP anak (parent_id = ODC ini).
  let children = [];
  try {
    children = await InfrastructurePoint.findAll({
      where: { type: 'odp', parent_id: o.id },
      attributes: ['id', 'name', 'status', 'capacity', 'used_ports'],
      order: [['name', 'ASC']], limit: 60,
    });
  } catch (_) {}

  // Hitung pelanggan per ODP anak.
  const childIds = children.map(c => c.id);
  const connMap = new Map();
  if (childIds.length) {
    try {
      const custs = await Customer.findAll({ where: { infra_parent_id: { [Op.in]: childIds } }, attributes: ['infra_parent_id'] });
      custs.forEach(cu => connMap.set(cu.infra_parent_id, (connMap.get(cu.infra_parent_id) || 0) + 1));
    } catch (_) {}
  }

  const STATUS = { active: 'Aktif', inactive: 'Nonaktif', maintenance: 'Maintenance' };
  const lines = [
    '<b>Detail ODC</b>', '',
    `Nama      : <b>${esc(o.name)}</b>`,
    `Status    : ${esc(STATUS[o.status] || o.status || '-')}`,
    `Kapasitas : ${o.capacity ? o.capacity + ' port' : '- (belum diset)'}`,
    `Terpakai  : ${Number(o.used_ports || 0)} port`,
    `Lokasi    : ${esc(o.address || '-')}`,
  ];
  const mapUrl = _mapsLink(o.latitude, o.longitude);
  if (mapUrl) {
    lines.push(`Koordinat : ${esc(o.latitude)}, ${esc(o.longitude)}`);
    lines.push(`Maps      : <a href="${mapUrl}">Buka di Google Maps</a>`);
  } else { lines.push('Koordinat : (belum ada titik map)'); }

  lines.push('', `<b>ODP di bawah ODC ini: ${children.length}</b>`);
  if (children.length) {
    children.slice(0, 40).forEach(c => {
      const cap = Number(c.capacity || 0);
      const used = Math.max(Number(c.used_ports || 0), connMap.get(c.id) || 0);
      const free = cap > 0 ? Math.max(cap - used, 0) : null;
      lines.push(`- ${esc(c.name)} · port ${cap > 0 ? used + '/' + cap + ' (sisa ' + free + ')' : used + ' (kap -)'}`);
    });
    if (children.length > 40) lines.push(`... dan ${children.length - 40} lainnya`);
  } else {
    lines.push('(belum ada ODP ter-assign ke ODC ini)');
  }
  await _reply(chatId, lines.join('\n'));
}

// ── /cekpop: detail POP + perangkat di bawahnya ────────────────────────
async function _cmdCekPop(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekpop &lt;nama/keyword POP&gt;</code>\n' +
      'Contoh: <code>/cekpop POP-Pusat</code> atau <code>/cekpop Bogor</code>');
    return;
  }
  const { InfrastructurePoint, Device } = require('../models');
  const { Op } = require('sequelize');

  let pops = [];
  try {
    pops = await InfrastructurePoint.findAll({
      where: { type: 'pop', [Op.or]: [{ name: { [Op.like]: `%${q}%` } }, { address: { [Op.like]: `%${q}%` } }] },
      attributes: ['id', 'name', 'address', 'status', 'latitude', 'longitude'],
      order: [['name', 'ASC']], limit: 25,
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari POP: ' + esc(e.message)); return; }

  if (!pops.length) { await _reply(chatId, `Tidak ada POP cocok dengan "<b>${esc(q)}</b>".`); return; }

  if (pops.length > 1) {
    const lines = [`<b>${pops.length} POP ditemukan</b> untuk "<b>${esc(q)}</b>":`, ''];
    pops.forEach(p => lines.push(`- <b>${esc(p.name)}</b> [${esc(p.status || '-')}]${p.address ? ' · ' + esc(p.address) : ''}`));
    lines.push('', 'Ketik nama POP spesifik untuk detail + perangkat.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  const p = pops[0];
  let devices = [];
  try {
    devices = await Device.findAll({
      where: { pop_id: p.id, is_active: true },
      attributes: ['name', 'ip_address', 'type', 'status'],
      order: [['type', 'ASC'], ['name', 'ASC']], limit: 50,
    });
  } catch (_) {}

  const STATUS = { active: 'Aktif', inactive: 'Nonaktif', maintenance: 'Maintenance' };
  const online = devices.filter(d => d.status === 'online').length;
  const offline = devices.filter(d => d.status === 'offline').length;
  const lines = [
    '<b>Detail POP</b>', '',
    `Nama     : <b>${esc(p.name)}</b>`,
    `Status   : ${esc(STATUS[p.status] || p.status || '-')}`,
    `Lokasi   : ${esc(p.address || '-')}`,
  ];
  const mapUrl = _mapsLink(p.latitude, p.longitude);
  if (mapUrl) {
    lines.push(`Koordinat: ${esc(p.latitude)}, ${esc(p.longitude)}`);
    lines.push(`Maps     : <a href="${mapUrl}">Buka di Google Maps</a>`);
  } else { lines.push('Koordinat: (belum ada titik map)'); }

  lines.push('', `<b>Perangkat: ${devices.length}</b> (online ${online}, offline ${offline})`);
  if (devices.length) {
    devices.slice(0, 40).forEach(d => {
      const st = d.status === 'online' ? '[ON]' : (d.status === 'offline' ? '[OFF]' : '[?]');
      lines.push(`${st} ${esc(d.name || '-')} · ${esc((d.type || '-'))}${d.ip_address ? ' · ' + esc(d.ip_address) : ''}`);
    });
    if (devices.length > 40) lines.push(`... dan ${devices.length - 40} lainnya`);
  } else {
    lines.push('(belum ada perangkat ter-assign ke POP ini)');
  }
  await _reply(chatId, lines.join('\n'));
}

// ── /cekont: status ONT + RX power dari GenieACS (by pelanggan) ─────────
async function _cmdCekOnt(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekont &lt;nama|CID|IP|PPPoE&gt;</code>\n' +
      'Contoh: <code>/cekont FLAYNET.COM</code> atau <code>/cekont CID010</code>');
    return;
  }
  const { Customer } = require('../models');
  const { Op } = require('sequelize');

  let cust = null;
  try {
    cust = await Customer.findOne({
      where: { [Op.or]: [
        { customer_id: q }, { name: { [Op.like]: `%${q}%` } }, { static_ip: q }, { pppoe_username: q },
      ] },
      attributes: ['id', 'customer_id', 'name', 'ont_sn', 'pppoe_username'],
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari: ' + esc(e.message)); return; }
  if (!cust) { await _reply(chatId, `Pelanggan "<b>${esc(q)}</b>" tidak ditemukan.`); return; }

  const head = [
    '<b>Status ONT</b>', '',
    `Pelanggan : <b>${esc(cust.name || '-')}</b> (${esc(cust.customer_id || cust.id)})`,
    `PPPoE     : ${cust.pppoe_username ? '<code>' + esc(cust.pppoe_username) + '</code>' : '-'}`,
    `Serial ONT: ${cust.ont_sn ? '<code>' + esc(cust.ont_sn) + '</code>' : '-'}`,
  ];

  if (!cust.ont_sn) {
    head.push('', 'ONT belum di-assign (ont_sn kosong), tidak bisa cek RX power.');
    await _reply(chatId, head.join('\n'));
    return;
  }

  try {
    const genieacs = require('./GenieacsService');
    const devices = await genieacs.getDevices(
      { '_id': { '$regex': cust.ont_sn } },
      'VirtualParameters.RXPower,VirtualParameters.gettemp,_lastInform'
    );
    if (!devices.success || !devices.data?.length) {
      head.push('', 'Device tidak ditemukan di GenieACS.');
      await _reply(chatId, head.join('\n'));
      return;
    }
    const d = devices.data[0];
    const sig = genieacs.extractSignalInfo(d);
    const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
    const online = lastInform && (Date.now() - lastInform) < 300000;
    head.push('');
    head.push(`Koneksi   : ${online ? '[ONLINE]' : '[OFFLINE]'}`);
    head.push(`RX Power  : ${sig.rx_power != null ? '<b>' + esc(sig.rx_power) + ' dBm</b>' : '-'}`);
    if (sig.temperature != null) head.push(`Suhu ONT  : ${esc(sig.temperature)} C`);
    if (d._lastInform) head.push(`Last inform: ${esc(_fmtTgl(d._lastInform))}`);
  } catch (e) {
    head.push('', 'Gagal ambil data GenieACS: ' + esc(e.message || 'error'));
  }
  await _reply(chatId, head.join('\n'));
}

// ── /cekreseller: info saldo, status & aktivitas reseller ──────────────
async function _cmdCekReseller(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekreseller &lt;kode|nama|HP&gt;</code>\n' +
      'Contoh: <code>/cekreseller RS-001</code> atau <code>/cekreseller Budi</code>');
    return;
  }
  const { Reseller, ResellerVoucherLog, ResellerTransaction } = require('../models');
  const { Op } = require('sequelize');

  let rs = [];
  try {
    rs = await Reseller.findAll({
      where: { [Op.or]: [
        { code: q }, { name: { [Op.like]: `%${q}%` } }, { phone: { [Op.like]: `%${q}%` } },
      ] },
      include: [{ model: Reseller, as: 'parent', attributes: ['code', 'name'], required: false }],
      attributes: ['id', 'code', 'name', 'phone', 'balance', 'is_active', 'commission_percent', 'parent_id'],
      order: [['name', 'ASC']], limit: 6,
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari: ' + esc(e.message)); return; }

  if (!rs.length) { await _reply(chatId, `Reseller "<b>${esc(q)}</b>" tidak ditemukan.`); return; }

  if (rs.length > 1) {
    const lines = [`<b>Ditemukan ${rs.length} reseller</b> untuk "<b>${esc(q)}</b>":`, ''];
    rs.forEach(r => {
      const st = r.is_active ? '[AKTIF]' : '[NONAKTIF]';
      lines.push(`${st} <b>${esc(r.name || '-')}</b> (${esc(r.code || r.id)}) · saldo ${_rp(r.balance)}`);
    });
    lines.push('', 'Persempit dengan kode reseller untuk detail.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  const r = rs[0];

  // Jumlah voucher terjual + sub-reseller + transaksi terakhir.
  let voucherCount = 0, voucherUsed = 0, subCount = 0;
  try { voucherCount = await ResellerVoucherLog.count({ where: { reseller_id: r.id } }); } catch (_) {}
  try { voucherUsed = await ResellerVoucherLog.count({ where: { reseller_id: r.id, status: 'used' } }); } catch (_) {}
  try { subCount = await Reseller.count({ where: { parent_id: r.id } }); } catch (_) {}

  let lastTx = [];
  try {
    lastTx = await ResellerTransaction.findAll({
      where: { reseller_id: r.id },
      attributes: ['type', 'amount', 'balance_after', 'createdAt'],
      order: [['id', 'DESC']], limit: 3,
    });
  } catch (_) {}

  const TX_LABEL = { topup: 'Top-up', purchase: 'Beli', adjust: 'Penyesuaian', refund: 'Refund' };
  const lines = [
    '<b>Data Reseller</b>', '',
    `Nama     : <b>${esc(r.name || '-')}</b>`,
    `Kode     : <code>${esc(r.code || r.id)}</code>`,
    `Status   : ${r.is_active ? 'Aktif' : 'Nonaktif'}`,
    `Saldo    : <b>${_rp(r.balance)}</b>`,
    `Komisi   : ${esc(r.commission_percent != null ? r.commission_percent + '%' : '-')}`,
  ];
  if (r.phone) lines.push(`HP       : ${esc(r.phone)}`);
  if (r.parent) lines.push(`Induk    : ${esc(r.parent.name)} (${esc(r.parent.code)})`);
  lines.push(`Voucher  : ${voucherCount} terbuat · ${voucherUsed} terpakai`);
  lines.push(`Sub-reseller : ${subCount}`);

  if (lastTx.length) {
    lines.push('', 'Transaksi terakhir:');
    lastTx.forEach(t => {
      const tgl = t.createdAt ? _fmtTgl(t.createdAt) : '-';
      lines.push(`- ${esc(tgl)} · ${esc(TX_LABEL[t.type] || t.type)} · ${_rp(t.amount)} (sisa ${_rp(t.balance_after)})`);
    });
  }
  await _reply(chatId, lines.join('\n'));
}

// ── /cekvoucher: status voucher hotspot by username ────────────────────
const _VOUCHER_STATUS = { created: 'Aktif (belum dipakai)', used: 'Sudah dipakai', expired: 'Kedaluwarsa', deleted: 'Dihapus', unknown: 'Tidak diketahui' };
async function _cmdCekVoucher(chatId, query) {
  const q = (query || '').trim();
  if (!q) {
    await _reply(chatId,
      'Format: <code>/cekvoucher &lt;username voucher&gt;</code>\n' +
      'Contoh: <code>/cekvoucher abc123</code>');
    return;
  }
  const { ResellerVoucherLog, Reseller } = require('../models');
  const { Op } = require('sequelize');

  let vs = [];
  try {
    vs = await ResellerVoucherLog.findAll({
      where: { username: { [Op.like]: `%${q}%` } },
      include: [{ model: Reseller, as: 'reseller', attributes: ['code', 'name'], required: false }],
      attributes: ['username', 'profile', 'package_name', 'sell_price', 'status', 'server', 'createdAt'],
      order: [['id', 'DESC']], limit: 8,
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari voucher: ' + esc(e.message)); return; }

  if (!vs.length) { await _reply(chatId, `Voucher "<b>${esc(q)}</b>" tidak ditemukan.`); return; }

  if (vs.length > 1) {
    const lines = [`<b>Ditemukan ${vs.length} voucher</b> untuk "<b>${esc(q)}</b>":`, ''];
    vs.forEach(v => {
      lines.push(`- <code>${esc(v.username)}</code> · ${esc(_VOUCHER_STATUS[v.status] || v.status)} · ${esc(v.package_name || v.profile || '-')}`);
    });
    lines.push('', 'Ketik username lengkap untuk detail.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  const v = vs[0];
  const lines = [
    '<b>Status Voucher</b>', '',
    `Username : <code>${esc(v.username)}</code>`,
    `Status   : ${esc(_VOUCHER_STATUS[v.status] || v.status)}`,
    `Paket    : ${esc(v.package_name || '-')}`,
    `Profil   : ${esc(v.profile || '-')}`,
    `Harga    : ${v.sell_price != null ? _rp(v.sell_price) : '-'}`,
  ];
  if (v.server) lines.push(`Server   : ${esc(v.server)}`);
  if (v.reseller) lines.push(`Reseller : ${esc(v.reseller.name)} (${esc(v.reseller.code)})`);
  if (v.createdAt) lines.push(`Dibuat   : ${esc(_fmtTgl(v.createdAt))}`);
  await _reply(chatId, lines.join('\n'));
}

// ── /cekhotspot: daftar user hotspot yang sedang aktif (online) ─────────
// Tanpa arg  → semua user aktif di router utama + ringkasan bandwidth.
// Arg        → filter berdasarkan username/server (substring).
// "@<router>" di awal arg → target router tertentu (by nama Device).
function _humanBytes(n) {
  const b = Number(n || 0);
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = b;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}

async function _cmdCekHotspot(chatId, query) {
  let arg = (query || '').trim();

  // Opsi target router: "@NamaRouter ..." di awal.
  let deviceId = null, routerLabel = null;
  const mRouter = /^@(\S+)\s*(.*)$/.exec(arg);
  if (mRouter) {
    const rname = mRouter[1];
    arg = (mRouter[2] || '').trim();
    try {
      const { Device } = require('../models');
      const { Op } = require('sequelize');
      const dev = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${rname}%` } }, { ip_address: rname }] },
        attributes: ['id', 'name'],
      });
      if (!dev) { await _reply(chatId, `Router "<b>${esc(rname)}</b>" tidak ditemukan.`); return; }
      deviceId = dev.id; routerLabel = dev.name;
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
  }

  let sessions = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const HotspotService = require('./HotspotService');
    const mt = await getMikrotikInstanceByDevice(deviceId);
    const svc = new HotspotService(mt);
    sessions = await svc.getActiveSessions();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil sesi hotspot: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }

  // Filter by username/server bila ada arg.
  const f = arg.toLowerCase();
  let list = sessions;
  if (f) {
    list = sessions.filter(s =>
      (s.user || '').toLowerCase().includes(f) ||
      (s.address || '').toLowerCase().includes(f) ||
      (s.server || '').toLowerCase().includes(f));
  }

  const head = routerLabel ? ` (router: ${esc(routerLabel)})` : '';
  if (!list.length) {
    await _reply(chatId, f
      ? `Tidak ada user hotspot aktif cocok "<b>${esc(arg)}</b>"${head}.`
      : `Tidak ada user hotspot yang aktif saat ini${head}.`);
    return;
  }

  // Ringkasan bandwidth total.
  const totIn = list.reduce((s, x) => s + Number(x.bytesIn || 0), 0);
  const totOut = list.reduce((s, x) => s + Number(x.bytesOut || 0), 0);

  const lines = [
    `<b>User Hotspot Aktif: ${list.length}</b>${head}`,
    `Total: down ${_humanBytes(totIn)} · up ${_humanBytes(totOut)}`,
    '',
  ];
  list.slice(0, 40).forEach(s => {
    lines.push(`- <b>${esc(s.user || '-')}</b> · <code>${esc(s.address || '-')}</code>`);
    const meta = [`uptime ${esc(s.uptime || '0s')}`];
    if (s.server) meta.push(esc(s.server));
    meta.push(`D ${_humanBytes(s.bytesIn)} / U ${_humanBytes(s.bytesOut)}`);
    if (s.macAddress) meta.push(esc(s.macAddress));
    lines.push('  ' + meta.join(' · '));
  });
  if (list.length > 40) lines.push(`... dan ${list.length - 40} lainnya`);
  await _reply(chatId, lines.join('\n'));
}

// ── /cekmikrotik: detail & resource router MikroTik ────────────────────
// Arg = nama device / IP (substring). Tanpa arg → router utama.
// Menampilkan identity, board, versi, uptime, CPU, RAM, disk.
function _uptimePretty(u) {
  // RouterOS uptime mis. "1w2d3h4m5s" → biarkan apa adanya (sudah ringkas).
  return String(u || '0s');
}

async function _cmdCekMikrotik(chatId, query) {
  const q = (query || '').trim();

  // Resolve device target.
  let deviceId = null, devLabel = null, devIp = null;
  if (q) {
    try {
      const { Device } = require('../models');
      const { Op } = require('sequelize');
      const dev = await Device.findOne({
        where: {
          type: 'router',
          [Op.or]: [{ name: { [Op.like]: `%${q}%` } }, { ip_address: q }],
        },
        attributes: ['id', 'name', 'ip_address', 'brand', 'model'],
        order: [['name', 'ASC']],
      });
      if (!dev) {
        await _reply(chatId, `Router "<b>${esc(q)}</b>" tidak ditemukan.\nKetik tanpa argumen untuk router utama.`);
        return;
      }
      deviceId = dev.id; devLabel = dev.name; devIp = dev.ip_address;
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
  }

  let raw = null, identity = null, sys = null;
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId);
    // Ambil paralel: raw resource (field lengkap), identity, parsed resource.
    const [rRaw, rIdent, rSys] = await Promise.allSettled([
      mt.get('/system/resource'),
      mt.getSystemIdentity(),
      mt.getSystemResource(),
    ]);
    raw = rRaw.status === 'fulfilled' ? rRaw.value : null;
    identity = rIdent.status === 'fulfilled' ? rIdent.value : null;
    sys = rSys.status === 'fulfilled' ? rSys.value : null;
    if (!raw && !sys) throw new Error('Router tidak merespons');
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil data router: ' + esc(e.message || 'error') +
      '\nPastikan MikroTik aktif & dapat diakses.');
    return;
  }

  // Normalisasi nilai (gabungkan raw + parsed).
  const ident = (identity && (identity.name || identity['name'])) || devLabel || '-';
  const uptime = (raw && raw.uptime) || (sys && sys.uptime) || '0s';
  const version = (raw && raw.version) || (sys && sys.version) || '-';
  const board = (raw && raw['board-name']) || (sys && sys.boardName) || '-';
  const platform = (raw && raw.platform) || (sys && sys.platform) || '-';
  const arch = (raw && raw['architecture-name']) || '-';
  const cpuName = (raw && raw.cpu) || '-';
  const cpuCount = (raw && raw['cpu-count']) || '-';
  const cpuFreq = (raw && raw['cpu-frequency']) ? raw['cpu-frequency'] + ' MHz' : '-';
  const cpuLoad = (sys && sys.cpuLoad != null) ? sys.cpuLoad : (raw ? parseInt(raw['cpu-load']) || 0 : 0);

  const totalMem = (sys && sys.totalMemory) || (raw ? parseInt(raw['total-memory']) || 0 : 0);
  const freeMem = (sys && sys.freeMemory) || (raw ? parseInt(raw['free-memory']) || 0 : 0);
  const usedMem = Math.max(0, totalMem - freeMem);
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  const totalHdd = raw ? parseInt(raw['total-hdd-space']) || 0 : 0;
  const freeHdd = raw ? parseInt(raw['free-hdd-space']) || 0 : 0;
  const usedHdd = Math.max(0, totalHdd - freeHdd);
  const hddPct = totalHdd > 0 ? Math.round((usedHdd / totalHdd) * 100) : 0;

  const lines = [
    '<b>Detail MikroTik</b>', '',
    `Identity : <b>${esc(ident)}</b>`,
  ];
  if (devLabel) lines.push(`Device   : ${esc(devLabel)}${devIp ? ' (' + esc(devIp) + ')' : ''}`);
  lines.push(
    `Board    : ${esc(board)}`,
    `Platform : ${esc(platform)}`,
    `Arsitektur: ${esc(arch)}`,
    `Versi OS : ${esc(version)}`,
    `Uptime   : ${esc(_uptimePretty(uptime))}`,
    '',
    `CPU      : ${esc(cpuName)} x${esc(String(cpuCount))} @ ${esc(cpuFreq)}`,
    `CPU Load : <b>${cpuLoad}%</b>`,
    `RAM      : <b>${memPct}%</b> (${_humanBytes(usedMem)} / ${_humanBytes(totalMem)})`,
  );
  if (totalHdd > 0) {
    lines.push(`Disk     : <b>${hddPct}%</b> (${_humanBytes(usedHdd)} / ${_humanBytes(totalHdd)})`);
  }
  await _reply(chatId, lines.join('\n'));
}

// ── Dispatch builtin command (dipakai pesan teks DAN tombol menu) ──────
async function _dispatchBuiltin(handler, cmd, arg, chatId, allowControl) {
  switch (handler) {
    case 'help':    return _cmdHelp(chatId, allowControl);
    case 'menu':    return _showMenu(chatId, 'root');
    case 'status':  return _cmdStatus(chatId);
    case 'down':    return _cmdDown(chatId, (arg || '').toLowerCase());
    case 'cek':     return arg ? _cmdCek(chatId, arg) : _showMenu(chatId, 'root');
    case 'cekcustdata': return _cmdCekCustData(chatId, arg);
    case 'cekodp':  return _cmdCekOdp(chatId, arg);
    case 'cekodc':  return _cmdCekOdc(chatId, arg);
    case 'cekpop':  return _cmdCekPop(chatId, arg);
    case 'cekont':  return _cmdCekOnt(chatId, arg);
    case 'cekbayar': return _cmdCekBayar(chatId, arg);
    case 'jatuhtempo': return _cmdJatuhTempo(chatId, arg);
    case 'ringkasan': return _cmdRingkasan(chatId);
    case 'tiket':   return _cmdTiket(chatId, arg);
    case 'cekreseller': return _cmdCekReseller(chatId, arg);
    case 'cekvoucher':  return _cmdCekVoucher(chatId, arg);
    case 'cekhotspot':  return _cmdCekHotspot(chatId, arg);
    case 'cekmikrotik': return _cmdCekMikrotik(chatId, arg);
    case 'cekpppoe': return _cmdCekPppoe(chatId, arg);
    case 'createpppoe': return _wizCreatePppoeStart(chatId, allowControl);
    case 'cekqueue': return _cmdCekQueue(chatId, arg);
    case 'cekinterface': return _cmdCekInterface(chatId, arg);
    case 'cekip': return _cmdCekIp(chatId, arg);
    case 'cektrafik': return _cmdCekTrafik(chatId, arg);
    case 'cekisolir': return _cmdCekIsolir(chatId, arg);
    case 'createqueue': return _wizCreateQueueStart(chatId, allowControl);
    case 'backupmikrotik':
      if (!allowControl) return _reply(chatId, 'Backup butuh izin kontrol. Aktifkan "Izinkan kontrol via bot" di Telegram Center.');
      return _cmdBackupMikrotik(chatId, arg);
    case 'ping':    return _cmdPing(chatId, arg);
    case 'isolir':  return _cmdControl(chatId, 'isolir', arg, allowControl);
    case 'restore': return _cmdControl(chatId, 'restore', arg, allowControl);
    default:
      return _reply(chatId, `Perintah <code>/${esc(cmd || handler)}</code> belum terpasang handler-nya.`);
  }
}

// Dispatch dari tombol menu: resolve command → handler via registry, cek izin.
async function _dispatch(cmd, arg, chatId, allowControl) {
  try {
    const { map } = await _loadCommands();
    if (cmd === 'help' || cmd === 'menu') return _dispatchBuiltin(cmd, cmd, '', chatId, allowControl);
    const def = map.get(cmd);
    if (!def) return _reply(chatId, `Perintah tidak dikenal: <code>/${esc(cmd)}</code>`);
    if (def.requireControl && !allowControl) {
      return _reply(chatId, 'Perintah kontrol dinonaktifkan. Aktifkan di Telegram Center.');
    }
    if (def.type === 'builtin') return _dispatchBuiltin(def.handler, cmd, arg, chatId, allowControl);
    if (def.type === 'reply') {
      return _reply(chatId, _renderTemplate(def.replyTemplate || '(balasan kosong)', { arg: esc(arg) }));
    }
    if (def.type === 'data') {
      const DS = require('./BotDataSources');
      const res = await DS.run(def.dataSource, arg);
      if (!res.ok) return _reply(chatId, esc(res.error || 'Data tidak ditemukan.'));
      return _reply(chatId, _renderTemplate(def.replyTemplate || '', res.vars || {}));
    }
  } catch (e) {
    logger.warn('[TGBot] _dispatch error: ' + (e.message || e));
    return _reply(chatId, 'Terjadi kesalahan menjalankan perintah.');
  }
}

// ── MENU INTERAKTIF (inline keyboard) ──────────────────────────────────
// Struktur menu: tiap node punya title + rows tombol.
// Tipe tombol (lewat callback_data, prefix "m:"):
//   m:<menuKey>        → buka sub-menu
//   r:<command>        → jalankan command tanpa argumen langsung
//   a:<command>        → minta user ketik command + argumen (prompt)
//   m:root             → kembali ke menu utama
// callback_data dibatasi 64 byte oleh Telegram, jadi key dijaga pendek.

const BOT_MENU = {
  root: {
    title: '<b>Menu FLAYNET Bot</b>\nPilih kategori:',
    rows: [
      [{ text: 'Jaringan', data: 'm:net' }, { text: 'Pelanggan', data: 'm:cust' }],
      [{ text: 'Infrastruktur', data: 'm:infra' }, { text: 'Keuangan', data: 'm:fin' }],
      [{ text: 'Hotspot/Voucher', data: 'm:hs' }, { text: 'PPPoE', data: 'm:ppp' }],
      [{ text: 'Tiket', data: 'r:tiket' }, { text: 'Ringkasan Harian', data: 'r:ringkasan' }],
    ],
  },
  net: {
    title: '<b>Jaringan</b>\nPilih perintah:',
    rows: [
      [{ text: 'Status Monitoring', data: 'r:status' }, { text: 'Yang Down', data: 'r:down' }],
      [{ text: 'Cek MikroTik', data: 'a:cekmikrotik' }, { text: 'Ping', data: 'a:ping' }],
      [{ text: 'Hotspot Aktif', data: 'r:cekhotspot' }, { text: 'PPPoE', data: 'm:ppp' }],
      [{ text: 'Cek Interface', data: 'r:cekinterface' }, { text: 'Simple Queue', data: 'm:queue' }],
      [{ text: 'Cek IP', data: 'r:cekip' }, { text: 'Cek Trafik', data: 'r:cektrafik' }],
      [{ text: 'Backup MikroTik', data: 'a:backupmikrotik' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
  queue: {
    title: '<b>Simple Queue</b>\nPilih perintah:',
    rows: [
      [{ text: 'Lihat Queue', data: 'a:cekqueue' }],
      [{ text: 'Buat Simple Queue', data: 'cq:start' }],
      [{ text: '« Kembali', data: 'm:net' }],
    ],
  },
  ppp: {
    title: '<b>PPPoE — Cek User</b>\nPilih status:',
    rows: [
      [{ text: 'PPPoE Status (Ringkasan)', data: 'r:cekpppoe:status' }],
      [{ text: 'PPPoE Active', data: 'r:cekpppoe:active' }, { text: 'PPPoE Offline', data: 'r:cekpppoe:offline' }],
      [{ text: 'Semua User', data: 'r:cekpppoe:all' }],
      [{ text: 'Cari User PPPoE', data: 'a:cekpppoe' }],
      [{ text: 'Buat PPPoE User', data: 'cp:start' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
  cust: {
    title: '<b>Pelanggan</b>\nPilih perintah:',
    rows: [
      [{ text: 'Cek Pelanggan', data: 'a:cek' }, { text: 'Data Lengkap', data: 'a:cekcustdata' }],
      [{ text: 'Cek Tagihan', data: 'a:tagihan' }, { text: 'Riwayat Bayar', data: 'a:cekbayar' }],
      [{ text: 'Cek ONT', data: 'a:cekont' }, { text: 'Terisolir', data: 'r:cekisolir' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
  infra: {
    title: '<b>Infrastruktur</b>\nPilih perintah:',
    rows: [
      [{ text: 'Cek ODP', data: 'a:cekodp' }, { text: 'Cek ODC', data: 'a:cekodc' }],
      [{ text: 'Cek POP', data: 'a:cekpop' }, { text: 'Cek MikroTik', data: 'a:cekmikrotik' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
  fin: {
    title: '<b>Keuangan</b>\nPilih perintah:',
    rows: [
      [{ text: 'Jatuh Tempo', data: 'r:jatuhtempo' }, { text: 'Tempo Hari Ini', data: 'r:jatuhtempo:hari ini' }],
      [{ text: 'Riwayat Bayar', data: 'a:cekbayar' }, { text: 'Cek Tagihan', data: 'a:tagihan' }],
      [{ text: 'Ringkasan Harian', data: 'r:ringkasan' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
  hs: {
    title: '<b>Hotspot & Voucher</b>\nPilih perintah:',
    rows: [
      [{ text: 'User Hotspot Aktif', data: 'r:cekhotspot' }],
      [{ text: 'Cek Voucher', data: 'a:cekvoucher' }, { text: 'Cek Reseller', data: 'a:cekreseller' }],
      [{ text: '« Kembali', data: 'm:root' }],
    ],
  },
};

// Konfigurasi prompt untuk command yang butuh argumen (tipe "a:").
// question = pertanyaan yang dikirim; placeholder = hint di kolom input.
const CMD_PROMPT = {
  cek:         { q: 'Masukkan nama / CID / IP / username PPPoE pelanggan:', ph: 'mis. FLAYNET.COM atau CID010' },
  cekcustdata: { q: 'Masukkan nama / CID / IP / PPPoE pelanggan:', ph: 'mis. CID010 atau 10.10.10.5' },
  tagihan:     { q: 'Masukkan nama / CID / IP / PPPoE pelanggan:', ph: 'mis. CID010' },
  cekbayar:    { q: 'Masukkan nama / CID / IP / PPPoE pelanggan:', ph: 'mis. CID010' },
  cekont:      { q: 'Masukkan nama / CID / IP / PPPoE pelanggan:', ph: 'mis. CID010' },
  cekodp:      { q: 'Masukkan nama / keyword ODP:', ph: 'mis. ODP-12 atau Bogor' },
  cekodc:      { q: 'Masukkan nama / keyword ODC:', ph: 'mis. ODC-01 atau Bogor' },
  cekpop:      { q: 'Masukkan nama / keyword POP:', ph: 'mis. POP-Pusat' },
  cekmikrotik: { q: 'Masukkan nama device / IP router (kosongkan untuk router utama):', ph: 'mis. POP-Pusat atau 192.168.1.1' },
  cekpppoe:    { q: 'Masukkan username PPPoE (atau ketik: active / offline / all):', ph: 'mis. budi atau active' },
  backupmikrotik: { q: 'Masukkan nama device / IP router (kosongkan untuk router utama):', ph: 'mis. POP-Pusat atau 192.168.1.1' },
  cekqueue:    { q: 'Filter nama/target queue (ketik "all" untuk semua termasuk dinamis, atau langsung kirim untuk router utama):', ph: 'mis. budi, all, atau @POP-Pusat' },
  cekvoucher:  { q: 'Masukkan username voucher:', ph: 'mis. abc123' },
  cekreseller: { q: 'Masukkan kode / nama / HP reseller:', ph: 'mis. RS-001' },
  ping:        { q: 'Masukkan IP / domain / CID:', ph: 'mis. 8.8.8.8 atau CID010' },
};

// Penyimpanan prompt yang sedang menunggu jawaban (per chat).
// chatId -> { cmd, at }. Kedaluwarsa setelah PROMPT_TTL_MS.
const PROMPT_TTL_MS = 5 * 60 * 1000;
const _pendingPrompt = new Map();

function _setPending(chatId, cmd) { _pendingPrompt.set(String(chatId), { cmd, at: Date.now() }); }
function _takePending(chatId) {
  const k = String(chatId);
  const p = _pendingPrompt.get(k);
  if (!p) return null;
  _pendingPrompt.delete(k);
  if (Date.now() - p.at > PROMPT_TTL_MS) return null;
  return p.cmd;
}

// ── Wizard state (alur multi-langkah, mis. buat PPPoE user) ────────────
// chatId -> { flow, step, data:{}, at }. Kedaluwarsa setelah PROMPT_TTL_MS.
const _wizard = new Map();
function _wizGet(chatId) {
  const w = _wizard.get(String(chatId));
  if (!w) return null;
  if (Date.now() - w.at > PROMPT_TTL_MS) { _wizard.delete(String(chatId)); return null; }
  return w;
}
function _wizSet(chatId, w) { w.at = Date.now(); _wizard.set(String(chatId), w); }
function _wizClear(chatId) { _wizard.delete(String(chatId)); }

// ── Konteks kelola (manage) terakhir per chat ──────────────────────────
// Menyimpan detail objek yang sedang ditampilkan (PPPoE secret / queue)
// agar tombol kelola tidak perlu membawa id panjang di callback_data.
// chatId -> { type, deviceId, ...fields, at }.
const _mgmt = new Map();
function _mgmtSet(chatId, ctx) { ctx.at = Date.now(); _mgmt.set(String(chatId), ctx); }
function _mgmtGet(chatId) {
  const m = _mgmt.get(String(chatId));
  if (!m) return null;
  if (Date.now() - m.at > PROMPT_TTL_MS) { _mgmt.delete(String(chatId)); return null; }
  return m;
}
function _mgmtClear(chatId) { _mgmt.delete(String(chatId)); }

// ── Chat yang baru berinteraksi (untuk bantu admin temukan Chat ID) ────
// Disimpan walau chat belum terdaftar. Maks 30, kedaluwarsa 1 jam.
const _seenChats = new Map();
function _recordSeenChat(chat, from) {
  if (!chat || chat.id == null) return;
  const id = String(chat.id);
  let label = chat.title || '';
  if (!label && from) label = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
  _seenChats.set(id, { chatId: id, type: chat.type || '-', label: (label || '-').trim(), at: Date.now() });
  // Batasi ukuran: buang yang terlama bila > 30.
  if (_seenChats.size > 30) {
    const oldest = [..._seenChats.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _seenChats.delete(oldest[0]);
  }
}
function getSeenChats() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return [..._seenChats.values()].filter(c => c.at >= cutoff).sort((a, b) => b.at - a.at);
}

// ── WIZARD: Buat PPPoE User ────────────────────────────────────────────
// Langkah: pilih router → pilih profile → input username → input password
// → konfirmasi → create. Butuh izin kontrol.
async function _wizCreatePppoeStart(chatId, allowControl) {
  if (!allowControl) { await _reply(chatId, 'Buat PPPoE user butuh izin kontrol. Aktifkan "Izinkan kontrol via bot" di Telegram Center.'); return; }
  const { Device } = require('../models');
  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'],
      order: [['name', 'ASC']], limit: 30,
    });
  } catch (e) { await _reply(chatId, 'Gagal memuat daftar router: ' + esc(e.message)); return; }

  if (!routers.length) { await _reply(chatId, 'Tidak ada router aktif di Device Management.'); return; }

  _wizSet(chatId, { flow: 'cpppoe', step: 'router', data: {} });
  const rows = routers.map(r => [{ text: `${r.name} (${r.ip_address || '-'})`, data: `cp:rt:${r.id}` }]);
  rows.push([{ text: 'Batal', data: 'cp:cancel' }]);
  await _replyButtons(chatId, '<b>Buat PPPoE User</b>\nLangkah 1/4 — Pilih router:', rows);
}

// Step 2: router dipilih → tampilkan profile.
async function _wizCreatePppoePickRouter(chatId, deviceId) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cpppoe') { await _reply(chatId, 'Sesi pembuatan PPPoE sudah berakhir. Mulai lagi dari menu PPPoE.'); return; }
  const { Device } = require('../models');
  let dev = null;
  try { dev = await Device.findByPk(deviceId, { attributes: ['id', 'name', 'ip_address'] }); } catch (_) {}
  if (!dev) { await _reply(chatId, 'Router tidak ditemukan.'); _wizClear(chatId); return; }

  let profiles = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(dev.id);
    profiles = await mt.getPPPoEProfiles();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil profile dari router: ' + esc(e.message || 'error') + '\nPastikan router dapat diakses.');
    _wizClear(chatId); return;
  }
  if (!profiles.length) { await _reply(chatId, 'Tidak ada PPPoE profile di router ini.'); _wizClear(chatId); return; }

  w.step = 'profile';
  w.data.deviceId = dev.id;
  w.data.deviceName = dev.name;
  _wizSet(chatId, w);

  // callback_data dibatasi 64 byte → kirim INDEX profile, simpan list di state.
  w.data.profiles = profiles.map(p => p.name);
  const rows = profiles.slice(0, 28).map((p, idx) => {
    const rl = p.rateLimit ? ` · ${p.rateLimit}` : '';
    return [{ text: `${p.name}${rl}`.slice(0, 60), data: `cp:pf:${idx}` }];
  });
  rows.push([{ text: 'Batal', data: 'cp:cancel' }]);
  await _replyButtons(chatId, `<b>Buat PPPoE User</b>\nRouter: <b>${esc(dev.name)}</b>\nLangkah 2/4 — Pilih profile:`, rows);
}

// Step 3: profile dipilih → minta username.
async function _wizCreatePppoePickProfile(chatId, profileIdx) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cpppoe' || !w.data.profiles) { await _reply(chatId, 'Sesi pembuatan PPPoE sudah berakhir. Mulai lagi dari menu PPPoE.'); return; }
  const profile = w.data.profiles[parseInt(profileIdx, 10)];
  if (!profile) { await _reply(chatId, 'Profile tidak valid.'); return; }
  w.step = 'username';
  w.data.profile = profile;
  _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `<b>Buat PPPoE User</b>\nRouter: <b>${esc(w.data.deviceName)}</b> · Profile: <b>${esc(profile)}</b>\nLangkah 3/4 — Ketik <b>username</b> PPPoE:`,
    String(chatId), 'mis. budi atau cust010', await Telegram._getConfig());
}

// Step 4: terima username → minta password.
async function _wizCreatePppoeUsername(chatId, username) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cpppoe') return false;
  const u = (username || '').trim();
  if (!u || /\s/.test(u)) { await _reply(chatId, 'Username tidak boleh kosong / mengandung spasi. Ketik ulang username:'); return true; }
  w.step = 'password';
  w.data.username = u;
  _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `Username: <b>${esc(u)}</b>\nLangkah 4/4 — Ketik <b>password</b> PPPoE:`,
    String(chatId), 'mis. pass123', await Telegram._getConfig());
  return true;
}

// Step 5: terima password → konfirmasi.
async function _wizCreatePppoePassword(chatId, password) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cpppoe') return false;
  const p = (password || '').trim();
  if (!p) { await _reply(chatId, 'Password tidak boleh kosong. Ketik ulang password:'); return true; }
  w.step = 'confirm';
  w.data.password = p;
  _wizSet(chatId, w);
  const d = w.data;
  const lines = [
    '<b>Konfirmasi Buat PPPoE User</b>', '',
    `Router   : <b>${esc(d.deviceName)}</b>`,
    `Profile  : <b>${esc(d.profile)}</b>`,
    `Username : <b>${esc(d.username)}</b>`,
    `Password : <code>${esc(d.password)}</code>`,
    '', 'Buat user ini?',
  ];
  await _replyButtons(chatId, lines.join('\n'), [
    [{ text: 'Ya, Buat', data: 'cp:ok' }, { text: 'Batal', data: 'cp:cancel' }],
  ]);
  return true;
}

// Step 6: eksekusi create.
async function _wizCreatePppoeExecute(chatId, allowControl) {
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol.'); _wizClear(chatId); return; }
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cpppoe' || w.step !== 'confirm') { await _reply(chatId, 'Sesi pembuatan PPPoE sudah berakhir.'); return; }
  const d = w.data;
  _wizClear(chatId);
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(d.deviceId);
    await mt.createPPPoESecret({ name: d.username, password: d.password, profile: d.profile, service: 'pppoe' });
    await _audit(chatId, 'pppoe_create', `Buat PPPoE user ${d.username} (profile ${d.profile}) di ${d.deviceName}`, { targetType: 'device', targetId: d.deviceId, newData: { username: d.username, profile: d.profile } });
    await _reply(chatId,
      `<b>PPPoE user berhasil dibuat.</b>\n\n` +
      `Router   : <b>${esc(d.deviceName)}</b>\n` +
      `Username : <code>${esc(d.username)}</code>\n` +
      `Profile  : <b>${esc(d.profile)}</b>`);
  } catch (e) {
    await _reply(chatId, 'Gagal membuat PPPoE user: ' + esc(e.message || 'error') +
      '\nKemungkinan username sudah ada atau profile tidak valid.');
  }
}

// ── AKSI Pembayaran (dari tombol hasil /cekbayar) ──────────────────────
async function _bayarManage(chatId, action, allowControl) {
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }
  const m = _mgmtGet(chatId);
  if (!m || m.type !== 'bayar' || !m.custId) { await _reply(chatId, 'Konteks pembayaran sudah berakhir. Buka lagi via /cekbayar <CID>.'); return; }

  if (action === 'lunas') {
    await _replyButtons(chatId, `Yakin tandai <b>LUNAS</b> tagihan <b>${esc(m.name)}</b> (${esc(m.customerId)})?\nIni mencatat pembayaran cash & memajukan jatuh tempo.`, [
      [{ text: 'Ya, Tandai Lunas', data: 'by:lunasok' }, { text: 'Batal', data: 'by:cancel' }],
    ]);
    return;
  }

  const rl = _rateLimit(chatId, 'cek');
  if (!rl.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`); return; }

  const { Customer, Package } = require('../models');
  const cust = await Customer.findByPk(m.custId, {
    include: [{ model: Package, as: 'package', attributes: ['name'], required: false }],
  });
  if (!cust) { await _reply(chatId, 'Pelanggan tidak ditemukan.'); return; }

  if (action === 'lunasok') {
    await _reply(chatId, `Memproses pembayaran <b>${esc(m.name)}</b>…`);
    const out = await _markPaidWA(chatId, cust);
    await _reply(chatId, out.ok ? out.message : ('Gagal: ' + esc(out.message)));
    return;
  }
  if (action === 'tagih') {
    await _reply(chatId, `Mengirim tagihan WA ke <b>${esc(m.name)}</b>…`);
    const out = await _sendTagihanWA(chatId, cust);
    await _reply(chatId, out.ok ? out.message : ('Gagal: ' + esc(out.message)));
    return;
  }
}

// ── KELOLA Pelanggan (dari tombol hasil /cekcustdata) ──────────────────
async function _customerManage(chatId, action, allowControl) {
  const m = _mgmtGet(chatId);
  if (!m || m.type !== 'customer' || !m.custId) { await _reply(chatId, 'Konteks pelanggan sudah berakhir. Buka lagi via /cekcustdata <keyword>.'); return; }

  if (action === 'ont') {
    return await _cmdCekOnt(chatId, m.customerId || String(m.custId));
  }

  // Kirim Tagihan WA butuh izin kontrol.
  if (action === 'tagih') {
    if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }
    const rl0 = _rateLimit(chatId, 'cek');
    if (!rl0.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl0.retryAfter} detik.`); return; }
    await _reply(chatId, `Mengirim tagihan WA ke <b>${esc(m.name)}</b>…`);
    try {
      const { Customer, Package } = require('../models');
      const cust = await Customer.findByPk(m.custId, {
        include: [{ model: Package, as: 'package', attributes: ['name'], required: false }],
      });
      if (!cust) { await _reply(chatId, 'Pelanggan tidak ditemukan.'); return; }
      const out = await _sendTagihanWA(chatId, cust);
      await _reply(chatId, out.ok ? out.message : ('Gagal: ' + esc(out.message)));
    } catch (e) {
      await _reply(chatId, 'Gagal kirim tagihan: ' + esc(e.message || 'error'));
    }
    return;
  }

  // Isolir / Restore butuh izin kontrol.
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }

  if (action === 'isolir') {
    await _replyButtons(chatId, `Yakin <b>isolir</b> pelanggan <b>${esc(m.name)}</b> (${esc(m.customerId)})?`, [
      [{ text: 'Ya, Isolir', data: 'cm:isolirok' }, { text: 'Batal', data: 'cm:cancel' }],
    ]);
    return;
  }
  const rl = _rateLimit(chatId, 'cek');
  if (!rl.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`); return; }
  try {
    const Isolir = require('./IsolirService');
    if (action === 'isolirok') {
      await Isolir.isolirCustomer(m.custId, 'telegram-bot', null);
      await _audit(chatId, 'customer_isolir', `Isolir pelanggan ${m.name} (${m.customerId})`, { targetType: 'customer', targetId: m.custId });
      await _reply(chatId, `<b>${esc(m.name)}</b> (${esc(m.customerId)}) telah <b>diisolir</b>.`);
    } else if (action === 'restore') {
      await Isolir.restoreCustomer(m.custId, 'telegram-bot', null);
      await _audit(chatId, 'customer_restore', `Restore pelanggan ${m.name} (${m.customerId})`, { targetType: 'customer', targetId: m.custId });
      await _reply(chatId, `<b>${esc(m.name)}</b> (${esc(m.customerId)}) telah <b>dipulihkan</b>.`);
    }
  } catch (e) {
    await _reply(chatId, 'Gagal: ' + esc(e.message || 'error'));
  }
}

// ── KELOLA PPPoE (dari tombol hasil /cekpppoe) ─────────────────────────
async function _pppoeManage(chatId, action, allowControl, value) {
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }
  const m = _mgmtGet(chatId);
  if (!m || m.type !== 'pppoe' || !m.secretId) { await _reply(chatId, 'Konteks user PPPoE sudah berakhir. Buka lagi via /cekpppoe <user>.'); return; }
  const rl = _rateLimit(chatId, 'cekpppoe');
  if (!rl.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`); return; }

  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(m.deviceId || null);

    if (action === 'dc') {
      if (!m.sessionId) { await _reply(chatId, 'User sedang tidak online.'); return; }
      await mt.disconnectPPPoE(m.sessionId);
      await _audit(chatId, 'pppoe_disconnect', `Putus sesi PPPoE ${m.name}`, { targetType: 'device', targetId: m.deviceId });
      await _reply(chatId, `Sesi <b>${esc(m.name)}</b> diputus.`); return;
    }
    if (action === 'pg') {
      if (!m.ip) { await _reply(chatId, 'Tidak ada IP untuk di-ping.'); return; }
      return await _cmdPing(chatId, m.ip);
    }
    if (action === 'toggle') {
      if (m.disabled) {
        await mt.enablePPPoESecret(m.secretId);
        await _audit(chatId, 'pppoe_enable', `Enable PPPoE user ${m.name}`, { targetType: 'device', targetId: m.deviceId });
        m.disabled = false; _mgmtSet(chatId, m);
        await _reply(chatId, `User <b>${esc(m.name)}</b> di-<b>enable</b>.`);
      } else {
        await mt.disablePPPoESecret(m.secretId);
        await _audit(chatId, 'pppoe_disable', `Disable PPPoE user ${m.name}`, { targetType: 'device', targetId: m.deviceId });
        m.disabled = true; _mgmtSet(chatId, m);
        await _reply(chatId, `User <b>${esc(m.name)}</b> di-<b>disable</b>.`);
      }
      return;
    }
    if (action === 'del') {
      await _replyButtons(chatId, `Yakin hapus PPPoE user <b>${esc(m.name)}</b>?\nTindakan ini permanen.`, [
        [{ text: 'Ya, Hapus', data: 'pm:delok' }, { text: 'Batal', data: 'pm:cancel' }],
      ]);
      return;
    }
    if (action === 'delok') {
      await mt.deletePPPoESecret(m.secretId);
      await _audit(chatId, 'pppoe_delete', `Hapus PPPoE user ${m.name}`, { targetType: 'device', targetId: m.deviceId, oldData: { name: m.name, profile: m.profile } });
      _mgmtClear(chatId);
      await _reply(chatId, `User PPPoE <b>${esc(m.name)}</b> dihapus.`); return;
    }
    if (action === 'prof') {
      // Tampilkan daftar profile sebagai tombol (index).
      let profiles = [];
      try { profiles = await mt.getPPPoEProfiles(); } catch (_) {}
      if (!profiles.length) { await _reply(chatId, 'Tidak bisa mengambil daftar profile.'); return; }
      m.profileList = profiles.map(p => p.name); _mgmtSet(chatId, m);
      const rows = profiles.slice(0, 28).map((p, idx) => [{ text: p.name.slice(0, 60), data: `pm:setprof:${idx}` }]);
      rows.push([{ text: 'Batal', data: 'pm:cancel' }]);
      await _replyButtons(chatId, `Ubah profile untuk <b>${esc(m.name)}</b> (sekarang: ${esc(m.profile)})\nPilih profile baru:`, rows);
      return;
    }
    if (action === 'setprof') {
      const newProf = (m.profileList || [])[parseInt(value, 10)];
      if (!newProf) { await _reply(chatId, 'Profile tidak valid.'); return; }
      await mt.updatePPPoESecret(m.secretId, { profile: newProf });
      await _audit(chatId, 'pppoe_update_profile', `Ubah profile ${m.name}: ${m.profile} -> ${newProf}`, { targetType: 'device', targetId: m.deviceId, oldData: { profile: m.profile }, newData: { profile: newProf } });
      m.profile = newProf; _mgmtSet(chatId, m);
      await _reply(chatId, `Profile <b>${esc(m.name)}</b> diubah ke <b>${esc(newProf)}</b>.`); return;
    }
  } catch (e) {
    await _reply(chatId, 'Gagal menjalankan aksi: ' + esc(e.message || 'error'));
  }
}


// Langkah: pilih router → nama → target IP → max upload → max download
// → konfirmasi → create. Butuh izin kontrol.
// ── KELOLA Simple Queue (dari tombol hasil /cekqueue) ──────────────────
async function _queueManage(chatId, action, allowControl, value) {
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }
  const m = _mgmtGet(chatId);
  if (!m || m.type !== 'queue' || !m.queueId) { await _reply(chatId, 'Konteks queue sudah berakhir. Buka lagi via /cekqueue <nama>.'); return; }
  const rl = _rateLimit(chatId, 'cekqueue');
  if (!rl.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`); return; }

  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(m.deviceId || null);

    if (action === 'toggle') {
      if (m.disabled) {
        await mt.enableQueue(m.queueId);
        await _audit(chatId, 'queue_enable', `Enable queue ${m.name}`, { targetType: 'device', targetId: m.deviceId });
        m.disabled = false; _mgmtSet(chatId, m);
        await _reply(chatId, `Queue <b>${esc(m.name)}</b> di-<b>enable</b>.`);
      } else {
        await mt.disableQueue(m.queueId);
        await _audit(chatId, 'queue_disable', `Disable queue ${m.name}`, { targetType: 'device', targetId: m.deviceId });
        m.disabled = true; _mgmtSet(chatId, m);
        await _reply(chatId, `Queue <b>${esc(m.name)}</b> di-<b>disable</b>.`);
      }
      return;
    }
    if (action === 'del') {
      await _replyButtons(chatId, `Yakin hapus queue <b>${esc(m.name)}</b>?\nTindakan ini permanen.`, [
        [{ text: 'Ya, Hapus', data: 'qm:delok' }, { text: 'Batal', data: 'qm:cancel' }],
      ]);
      return;
    }
    if (action === 'delok') {
      await mt.deleteQueue(m.queueId);
      await _audit(chatId, 'queue_delete', `Hapus queue ${m.name} (target ${m.target})`, { targetType: 'device', targetId: m.deviceId, oldData: { name: m.name, target: m.target, maxLimit: m.maxLimit } });
      _mgmtClear(chatId);
      await _reply(chatId, `Queue <b>${esc(m.name)}</b> dihapus.`); return;
    }
    if (action === 'limit') {
      // Mulai mini-wizard ubah limit: minta upload baru. Bawa state lengkap.
      _wizSet(chatId, { flow: 'qlimit', step: 'up', data: { deviceId: m.deviceId, queueId: m.queueId, name: m.name, target: m.target, disabled: m.disabled, parent: m.parent } });
      await Telegram.sendForceReply(
        `Ubah limit <b>${esc(m.name)}</b> (sekarang: ${esc(String(m.maxLimit || '0/0'))})\nKetik <b>max upload</b> baru (mis. 5M):`,
        String(chatId), 'mis. 5M', await Telegram._getConfig());
      return;
    }
  } catch (e) {
    await _reply(chatId, 'Gagal menjalankan aksi: ' + esc(e.message || 'error'));
  }
}

// Mini-wizard ubah limit queue: terima upload → minta download.
async function _qlimitUp(chatId, up) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'qlimit') return false;
  const u = (up || '').trim();
  if (!_validRate(u)) { await _reply(chatId, 'Format tidak valid. Contoh: 5M, 512k. Ketik ulang max upload:'); return true; }
  w.step = 'down'; w.data.up = u; _wizSet(chatId, w);
  await Telegram.sendForceReply(`Max upload baru: <b>${esc(u)}</b>\nKetik <b>max download</b> baru (mis. 10M):`,
    String(chatId), 'mis. 10M', await Telegram._getConfig());
  return true;
}
// Terima download → eksekusi update.
async function _qlimitDown(chatId, down, allowControl) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'qlimit') return false;
  const d = (down || '').trim();
  if (!_validRate(d)) { await _reply(chatId, 'Format tidak valid. Contoh: 10M, 20M. Ketik ulang max download:'); return true; }
  const data = w.data; _wizClear(chatId);
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol.'); return true; }
  const maxLimit = `${data.up}/${d}`;
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(data.deviceId || null);
    // Sertakan field eksisting agar tidak ter-reset oleh updateQueue.
    await mt.updateQueue(data.queueId, {
      name: data.name, target: data.target, maxLimit,
      disabled: data.disabled, parent: data.parent,
    });
    await _audit(chatId, 'queue_update_limit', `Ubah limit queue ${data.name} -> ${maxLimit}`, { targetType: 'device', targetId: data.deviceId, newData: { maxLimit } });
    await _reply(chatId, `Limit queue <b>${esc(data.name)}</b> diubah ke <b>Up ${esc(data.up)} / Down ${esc(d)}</b>.`);
  } catch (e) {
    await _reply(chatId, 'Gagal mengubah limit: ' + esc(e.message || 'error'));
  }
  return true;
}

// ── WIZARD: Buat Simple Queue ──────────────────────────────────────────
async function _wizCreateQueueStart(chatId, allowControl) {
  if (!allowControl) { await _reply(chatId, 'Buat simple queue butuh izin kontrol. Aktifkan "Izinkan kontrol via bot" di Telegram Center.'); return; }
  const { Device } = require('../models');
  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'],
      order: [['name', 'ASC']], limit: 30,
    });
  } catch (e) { await _reply(chatId, 'Gagal memuat daftar router: ' + esc(e.message)); return; }
  if (!routers.length) { await _reply(chatId, 'Tidak ada router aktif di Device Management.'); return; }

  _wizSet(chatId, { flow: 'cqueue', step: 'router', data: {} });
  const rows = routers.map(r => [{ text: `${r.name} (${r.ip_address || '-'})`, data: `cq:rt:${r.id}` }]);
  rows.push([{ text: 'Batal', data: 'cq:cancel' }]);
  await _replyButtons(chatId, '<b>Buat Simple Queue</b>\nLangkah 1/6 — Pilih router:', rows);
}

// Step 2: router dipilih → minta nama queue.
async function _wizCreateQueuePickRouter(chatId, deviceId) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') { await _reply(chatId, 'Sesi pembuatan queue sudah berakhir. Mulai lagi dari menu Jaringan.'); return; }
  const { Device } = require('../models');
  let dev = null;
  try { dev = await Device.findByPk(deviceId, { attributes: ['id', 'name'] }); } catch (_) {}
  if (!dev) { await _reply(chatId, 'Router tidak ditemukan.'); _wizClear(chatId); return; }
  w.step = 'name'; w.data.deviceId = dev.id; w.data.deviceName = dev.name; _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `<b>Buat Simple Queue</b>\nRouter: <b>${esc(dev.name)}</b>\nLangkah 2/6 — Ketik <b>nama queue</b>:`,
    String(chatId), 'mis. queue-budi atau CUST-010', await Telegram._getConfig());
}

// Step 3: nama → minta target IP.
async function _wizCreateQueueName(chatId, name) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') return false;
  const n = (name || '').trim();
  if (!n) { await _reply(chatId, 'Nama queue tidak boleh kosong. Ketik ulang nama:'); return true; }
  w.step = 'target'; w.data.name = n; _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `Nama: <b>${esc(n)}</b>\nLangkah 3/6 — Ketik <b>target IP</b> (boleh /32 atau subnet, multi pisah koma):`,
    String(chatId), 'mis. 10.10.10.5 atau 10.10.10.0/24', await Telegram._getConfig());
  return true;
}

// Step 4: target → minta max upload.
async function _wizCreateQueueTarget(chatId, target) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') return false;
  const t = (target || '').trim();
  if (!t) { await _reply(chatId, 'Target IP tidak boleh kosong. Ketik ulang target:'); return true; }
  w.step = 'up'; w.data.target = t; _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `Target: <code>${esc(t)}</code>\nLangkah 4/6 — Ketik <b>max upload</b> (mis. 5M, 512k, 10M):`,
    String(chatId), 'mis. 5M', await Telegram._getConfig());
  return true;
}

// Step 5: upload → minta max download.
async function _wizCreateQueueUp(chatId, up) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') return false;
  const u = (up || '').trim();
  if (!_validRate(u)) { await _reply(chatId, 'Format tidak valid. Contoh: 5M, 512k, 10M. Ketik ulang max upload:'); return true; }
  w.step = 'down'; w.data.up = u; _wizSet(chatId, w);
  await Telegram.sendForceReply(
    `Max upload: <b>${esc(u)}</b>\nLangkah 5/6 — Ketik <b>max download</b> (mis. 10M, 20M):`,
    String(chatId), 'mis. 10M', await Telegram._getConfig());
  return true;
}

// Step 6: download → konfirmasi.
async function _wizCreateQueueDown(chatId, down) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') return false;
  const d = (down || '').trim();
  if (!_validRate(d)) { await _reply(chatId, 'Format tidak valid. Contoh: 10M, 20M. Ketik ulang max download:'); return true; }
  w.step = 'parent'; w.data.down = d; _wizSet(chatId, w);

  // Ambil queue yang ada di router ini untuk jadi pilihan parent.
  let parents = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(w.data.deviceId);
    const queues = await mt.getQueues();
    // Hanya queue statis (bukan dinamis) & bukan queue dgn nama yang sama.
    parents = queues
      .filter(q => !q.dynamic && q.name && q.name !== w.data.name)
      .map(q => q.name);
  } catch (_) { /* kalau gagal, lanjut tanpa daftar parent */ }

  w.data.parentList = parents;
  const rows = [[{ text: 'Tanpa Parent (none)', data: 'cq:pa:none' }]];
  parents.slice(0, 26).forEach((name, idx) => {
    rows.push([{ text: name.slice(0, 60), data: `cq:pa:${idx}` }]);
  });
  rows.push([{ text: 'Batal', data: 'cq:cancel' }]);

  const title = parents.length
    ? `Max download: <b>${esc(d)}</b>\nLangkah 6/6 — Pilih <b>parent</b> queue (untuk limit bertingkat) atau "Tanpa Parent":`
    : `Max download: <b>${esc(d)}</b>\nLangkah 6/6 — Tidak ada queue lain di router ini. Pilih "Tanpa Parent":`;
  await _replyButtons(chatId, title, rows);
  return true;
}

// Step 6b: parent dipilih → tampilkan konfirmasi.
async function _wizCreateQueuePickParent(chatId, val) {
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue') { await _reply(chatId, 'Sesi pembuatan queue sudah berakhir.'); return; }
  let parent = 'none';
  if (val !== 'none') {
    const idx = parseInt(val, 10);
    const name = (w.data.parentList || [])[idx];
    if (!name) { await _reply(chatId, 'Parent tidak valid.'); return; }
    parent = name;
  }
  w.step = 'confirm'; w.data.parent = parent; _wizSet(chatId, w);
  await _wizQueueShowConfirm(chatId, w.data);
}

// Tampilkan layar konfirmasi queue (termasuk parent).
async function _wizQueueShowConfirm(chatId, x) {
  const lines = [
    '<b>Konfirmasi Buat Simple Queue</b>', '',
    `Router   : <b>${esc(x.deviceName)}</b>`,
    `Nama     : <b>${esc(x.name)}</b>`,
    `Target   : <code>${esc(x.target)}</code>`,
    `Max Upload   : <b>${esc(x.up)}</b>`,
    `Max Download : <b>${esc(x.down)}</b>`,
    `Parent   : <b>${esc(x.parent && x.parent !== 'none' ? x.parent : 'Tanpa parent')}</b>`,
    '', 'Buat queue ini?',
  ];
  await _replyButtons(chatId, lines.join('\n'), [
    [{ text: 'Ya, Buat', data: 'cq:ok' }, { text: 'Batal', data: 'cq:cancel' }],
  ]);
}

// Validasi format rate MikroTik (mis. 512k, 5M, 1G, atau angka bps).
function _validRate(s) {
  return /^\d+(\.\d+)?[kKmMgG]?$/.test(String(s || '').trim());
}

// Step 7: eksekusi create.
async function _wizCreateQueueExecute(chatId, allowControl) {
  if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol.'); _wizClear(chatId); return; }
  const w = _wizGet(chatId);
  if (!w || w.flow !== 'cqueue' || w.step !== 'confirm') { await _reply(chatId, 'Sesi pembuatan queue sudah berakhir.'); return; }
  const d = w.data;
  _wizClear(chatId);
  // MikroTik max-limit = upload/download.
  const maxLimit = `${d.up}/${d.down}`;
  const hasParent = d.parent && d.parent !== 'none';
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(d.deviceId);
    await mt.createQueue({ name: d.name, target: d.target, maxLimit, parent: d.parent || 'none' });
    await _audit(chatId, 'queue_create', `Buat simple queue ${d.name} (target ${d.target}, limit ${maxLimit}${hasParent ? ', parent ' + d.parent : ''}) di ${d.deviceName}`, { targetType: 'device', targetId: d.deviceId, newData: { name: d.name, target: d.target, maxLimit, parent: d.parent } });
    await _reply(chatId,
      `<b>Simple queue berhasil dibuat.</b>\n\n` +
      `Router   : <b>${esc(d.deviceName)}</b>\n` +
      `Nama     : <b>${esc(d.name)}</b>\n` +
      `Target   : <code>${esc(d.target)}</code>\n` +
      `Max Limit: <b>Up ${esc(d.up)} / Down ${esc(d.down)}</b>\n` +
      `Parent   : <b>${esc(hasParent ? d.parent : 'Tanpa parent')}</b>`);
  } catch (e) {
    await _reply(chatId, 'Gagal membuat queue: ' + esc(e.message || 'error') +
      '\nKemungkinan nama queue sudah ada atau target tidak valid.');
  }
}


// Tampilkan menu (key) sebagai inline keyboard.
async function _showMenu(chatId, key) {
  const node = BOT_MENU[key] || BOT_MENU.root;
  await _replyButtons(chatId, node.title, node.rows);
}

// Handler tombol (callback_query).
async function _handleCallback(cb, cfg, allowed, allowControl) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const data = cb.data || '';
  logger.info(`[TGBot] callback data="${data}" dari ${chatId}`);
  // Catat chat untuk fitur "deteksi Chat ID".
  if (cb.message && cb.message.chat) _recordSeenChat(cb.message.chat, cb.from);
  // Selalu jawab agar spinner tombol berhenti.
  try { await Telegram.answerCallbackQuery(cb.id, '', cfg); } catch (_) {}

  if (chatId == null || !allowed.has(String(chatId))) {
    logger.info(`[TGBot] callback diabaikan (chat tak terdaftar: ${chatId})`);
    return;
  }

  try {
    // Rate-limit ringan untuk tombol juga.
    const rl = _rateLimit(chatId, 'menu');
    if (!rl.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`); return; }

    const [kind, ...rest] = data.split(':');
    const payload = rest.join(':');

    if (kind === 'm') {            // buka sub-menu
      await _showMenu(chatId, payload || 'root');
      return;
    }
    if (kind === 'r') {           // jalankan command (mungkin dgn arg tetap)
      const [cmd, fixedArg] = payload.split(':');
      if (RL_HEAVY.has(cmd)) {
        const rl2 = _rateLimit(chatId, cmd);
        if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      }
      // Tombol menu memetakan langsung ke handler builtin. Jalankan langsung
      // agar tetap berfungsi walau registry (bot_commands) belum ter-seed.
      if (BUILTIN_HANDLERS.has(cmd)) {
        return await _dispatchBuiltin(cmd, cmd, fixedArg || '', chatId, allowControl);
      }
      await _dispatch(cmd, fixedArg || '', chatId, allowControl);
      return;
    }
    if (kind === 'a') {           // minta user ketik argumen (ForceReply)
      const p = CMD_PROMPT[payload] || { q: `Masukkan argumen untuk /${payload}:`, ph: '' };
      _setPending(chatId, payload);
      const res = await Telegram.sendForceReply(p.q, String(chatId), p.ph, cfg);
      if (!res.ok) {
        // Fallback bila ForceReply gagal: beri instruksi ketik manual.
        await _reply(chatId, `${p.q}\nKetik: <code>/${esc(payload)} &lt;nilai&gt;</code>`);
      }
      return;
    }
    if (kind === 'dc') {          // putus sesi PPPoE (kontrol)
      if (!allowControl) { await _reply(chatId, 'Aksi ini butuh izin kontrol. Aktifkan di Telegram Center.'); return; }
      // payload = <deviceId>:<sessionId>
      const ci = payload.indexOf(':');
      const devId = parseInt(payload.slice(0, ci), 10) || null;
      const sessId = payload.slice(ci + 1);
      if (!sessId) { await _reply(chatId, 'ID sesi tidak valid.'); return; }
      const rl2 = _rateLimit(chatId, 'cekpppoe');
      if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      try {
        const { getMikrotikInstanceByDevice } = require('./MikrotikService');
        const mt = await getMikrotikInstanceByDevice(devId);
        await mt.disconnectPPPoE(sessId);
        await _audit(chatId, 'pppoe_disconnect', `Putus sesi PPPoE (sessionId ${sessId}, deviceId ${devId || 'utama'})`, { targetType: 'device', targetId: devId });
        await _reply(chatId, `Sesi PPPoE diputus. User akan reconnect otomatis.`);
      } catch (e) {
        await _reply(chatId, 'Gagal memutus sesi: ' + esc(e.message || 'error'));
      }
      return;
    }
    if (kind === 'pg') {          // ping ke IP
      const ci = payload.indexOf(':');
      const ip = payload.slice(ci + 1);
      if (!ip) { await _reply(chatId, 'IP tidak valid.'); return; }
      const rl2 = _rateLimit(chatId, 'ping');
      if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      return await _cmdPing(chatId, ip);
    }
    if (kind === 'if') {          // pilih router untuk cek interface
      const devId = parseInt(payload, 10);
      const rl2 = _rateLimit(chatId, 'cekinterface');
      if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      let name = '';
      try {
        const { Device } = require('../models');
        const dev = await Device.findByPk(devId, { attributes: ['name'] });
        name = dev ? dev.name : '';
      } catch (_) {}
      return await _renderInterfaces(chatId, devId, name);
    }
    if (kind === 'tr') {          // pilih router untuk cek trafik
      const devId = parseInt(payload, 10);
      const rl2 = _rateLimit(chatId, 'cektrafik');
      if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      let name = '';
      try {
        const { Device } = require('../models');
        const dev = await Device.findByPk(devId, { attributes: ['name'] });
        name = dev ? dev.name : '';
      } catch (_) {}
      return await _renderTrafik(chatId, devId, name);
    }
    if (kind === 'ip') {          // pilih jenis cek IP
      if (payload === 'router') return await _cekIpRouterStart(chatId);
      if (payload === 'cust') {
        _setPending(chatId, 'cekip_pelanggan');
        await Telegram.sendForceReply('Masukkan nama / CID / IP / PPPoE pelanggan:', String(chatId), 'mis. FLAYNET.COM atau CID010', cfg);
        return;
      }
      return;
    }
    if (kind === 'ipr') {         // pilih router untuk cek IP router
      const devId = parseInt(payload, 10);
      const rl2 = _rateLimit(chatId, 'cekip');
      if (!rl2.ok) { await _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl2.retryAfter} detik.`); return; }
      let name = '';
      try {
        const { Device } = require('../models');
        const dev = await Device.findByPk(devId, { attributes: ['name'] });
        name = dev ? dev.name : '';
      } catch (_) {}
      return await _renderRouterIp(chatId, devId, name);
    }
    if (kind === 'cm') {          // kelola pelanggan (dari tombol hasil)
      const [sub] = payload.split(':');
      if (sub === 'cancel') { await _reply(chatId, 'Dibatalkan.'); return; }
      return await _customerManage(chatId, sub, allowControl);
    }
    if (kind === 'by') {          // aksi pembayaran (dari hasil /cekbayar)
      const [sub] = payload.split(':');
      if (sub === 'cancel') { await _reply(chatId, 'Dibatalkan.'); return; }
      return await _bayarManage(chatId, sub, allowControl);
    }
    if (kind === 'pm') {          // kelola PPPoE (dari tombol hasil)
      const [sub, val] = payload.split(':');
      if (sub === 'cancel') { await _reply(chatId, 'Dibatalkan.'); return; }
      return await _pppoeManage(chatId, sub, allowControl, val);
    }
    if (kind === 'cp') {          // wizard buat PPPoE user
      const [sub, val] = payload.split(':');
      if (sub === 'start') return await _wizCreatePppoeStart(chatId, allowControl);
      if (sub === 'cancel') { _wizClear(chatId); await _reply(chatId, 'Pembuatan PPPoE user dibatalkan.'); return; }
      if (sub === 'rt') return await _wizCreatePppoePickRouter(chatId, parseInt(val, 10));
      if (sub === 'pf') return await _wizCreatePppoePickProfile(chatId, val);
      if (sub === 'ok') return await _wizCreatePppoeExecute(chatId, allowControl);
      return;
    }
    if (kind === 'qm') {          // kelola simple queue (dari tombol hasil)
      const [sub] = payload.split(':');
      if (sub === 'cancel') { await _reply(chatId, 'Dibatalkan.'); return; }
      return await _queueManage(chatId, sub, allowControl);
    }
    if (kind === 'cq') {          // wizard buat simple queue
      const [sub, val] = payload.split(':');
      if (sub === 'start') return await _wizCreateQueueStart(chatId, allowControl);
      if (sub === 'cancel') { _wizClear(chatId); await _reply(chatId, 'Pembuatan queue dibatalkan.'); return; }
      if (sub === 'rt') return await _wizCreateQueuePickRouter(chatId, parseInt(val, 10));
      if (sub === 'pa') return await _wizCreateQueuePickParent(chatId, val);
      if (sub === 'ok') return await _wizCreateQueueExecute(chatId, allowControl);
      return;
    }
    // Callback tidak dikenal.
    await _reply(chatId, `Tombol tidak dikenal: <code>${esc(data)}</code>`);
  } catch (e) {
    logger.warn('[TGBot] _handleCallback error: ' + (e.message || e));
    try { await _reply(chatId, 'Terjadi kesalahan memproses tombol: ' + esc(e.message || 'error')); } catch (_) {}
  }
}

// ── /cekpppoe: status PPPoE user (active / offline / ringkasan) ────────
// Sub-perintah (arg pertama): active | offline | all | <username/filter>.
// "@<router>" di awal → target router tertentu.
async function _cmdCekPppoe(chatId, query) {
  let arg = (query || '').trim();

  // Opsi target router "@NamaRouter".
  let deviceId = null, routerLabel = null;
  const mRouter = /^@(\S+)\s*(.*)$/.exec(arg);
  if (mRouter) {
    const rname = mRouter[1];
    arg = (mRouter[2] || '').trim();
    try {
      const { Device } = require('../models');
      const { Op } = require('sequelize');
      const dev = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${rname}%` } }, { ip_address: rname }] },
        attributes: ['id', 'name'],
      });
      if (!dev) { await _reply(chatId, `Router "<b>${esc(rname)}</b>" tidak ditemukan.`); return; }
      deviceId = dev.id; routerLabel = dev.name;
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
  }

  // Tentukan mode & filter.
  const tokens = arg.split(/\s+/).filter(Boolean);
  let mode = 'summary', filter = '';
  if (tokens.length) {
    const first = tokens[0].toLowerCase();
    if (['status', 'summary', 'ringkasan', 'sum'].includes(first)) { mode = 'summary'; filter = ''; }
    else if (['active', 'aktif', 'online'].includes(first)) { mode = 'active'; filter = tokens.slice(1).join(' '); }
    else if (['offline', 'off', 'mati'].includes(first)) { mode = 'offline'; filter = tokens.slice(1).join(' '); }
    else if (['all', 'semua'].includes(first)) { mode = 'all'; filter = tokens.slice(1).join(' '); }
    else { mode = 'find'; filter = arg; } // dianggap username/keyword
  }

  // Ambil data dari MikroTik.
  let active = [], secrets = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId);
    if (mode === 'active' || mode === 'find' || mode === 'summary' || mode === 'all') {
      const [aRes, sRes] = await Promise.allSettled([mt.getPPPoESessions(), mt.getPPPoESecrets()]);
      active = aRes.status === 'fulfilled' ? aRes.value : [];
      secrets = sRes.status === 'fulfilled' ? sRes.value : [];
    } else if (mode === 'offline') {
      const [aRes, sRes] = await Promise.allSettled([mt.getPPPoESessions(), mt.getPPPoESecrets()]);
      active = aRes.status === 'fulfilled' ? aRes.value : [];
      secrets = sRes.status === 'fulfilled' ? sRes.value : [];
    }
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil data PPPoE: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }

  const head = routerLabel ? ` (router: ${esc(routerLabel)})` : '';
  const activeNames = new Set(active.map(a => (a.name || '').toLowerCase()));
  const fLow = filter.toLowerCase();

  // ── Mode: ringkasan / status ──
  if (mode === 'summary') {
    const totalSecret = secrets.length;
    const totalActive = active.length;
    const disabled = secrets.filter(s => s.disabled).length;
    const offline = secrets.filter(s => !activeNames.has((s.name || '').toLowerCase()) && !s.disabled).length;
    // Sesi aktif yang tidak punya secret terdaftar (mis. login via RADIUS).
    const secretNames = new Set(secrets.map(s => (s.name || '').toLowerCase()));
    const activeNoSecret = active.filter(a => !secretNames.has((a.name || '').toLowerCase())).length;
    const pct = totalSecret > 0 ? Math.round((totalActive / totalSecret) * 100) : 0;
    const lines = [
      `<b>PPPoE Status</b>${head}`, '',
      `Total user terdaftar : <b>${totalSecret}</b>`,
      `Active session       : <b>${totalActive}</b>${totalSecret > 0 ? ' (' + pct + '%)' : ''}`,
      `Offline              : <b>${offline}</b>`,
      `Disabled             : <b>${disabled}</b>`,
    ];
    if (activeNoSecret > 0) lines.push(`Active tanpa secret  : <b>${activeNoSecret}</b> (mis. RADIUS)`);
    lines.push('', 'Detail: /cekpppoe active | offline | all | &lt;username&gt;');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // ── Mode: active ──
  if (mode === 'active') {
    let list = active;
    if (fLow) list = list.filter(a => (a.name || '').toLowerCase().includes(fLow) || (a.address || '').toLowerCase().includes(fLow));
    if (!list.length) { await _reply(chatId, fLow ? `Tidak ada PPPoE aktif cocok "<b>${esc(filter)}</b>"${head}.` : `Tidak ada PPPoE user yang aktif${head}.`); return; }
    const lines = [`<b>PPPoE Active: ${list.length}</b>${head}`, ''];
    list.slice(0, 50).forEach(a => {
      lines.push(`- <b>${esc(a.name || '-')}</b> · <code>${esc(a.address || '-')}</code>`);
      const meta = [`uptime ${esc(a.uptime || '0s')}`];
      if (a.callerID) meta.push(esc(a.callerID));
      lines.push('  ' + meta.join(' · '));
    });
    if (list.length > 50) lines.push(`... dan ${list.length - 50} lainnya`);
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // ── Mode: offline ──
  if (mode === 'offline') {
    let list = secrets.filter(s => !activeNames.has((s.name || '').toLowerCase()) && !s.disabled);
    if (fLow) list = list.filter(s => (s.name || '').toLowerCase().includes(fLow));
    if (!list.length) { await _reply(chatId, fLow ? `Tidak ada PPPoE offline cocok "<b>${esc(filter)}</b>"${head}.` : `Semua PPPoE user sedang online${head}.`); return; }
    const lines = [`<b>PPPoE Offline: ${list.length}</b>${head}`, ''];
    list.slice(0, 50).forEach(s => {
      lines.push(`- <b>${esc(s.name || '-')}</b> · profil ${esc(s.profile || '-')}`);
      if (s.lastLoggedOut) lines.push(`  terakhir online: ${esc(s.lastLoggedOut)}`);
    });
    if (list.length > 50) lines.push(`... dan ${list.length - 50} lainnya`);
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // ── Mode: all ── (semua user + status)
  if (mode === 'all') {
    let list = secrets;
    if (fLow) list = list.filter(s => (s.name || '').toLowerCase().includes(fLow));
    if (!list.length) { await _reply(chatId, `Tidak ada PPPoE user${fLow ? ' cocok "' + esc(filter) + '"' : ''}${head}.`); return; }
    const lines = [`<b>Semua PPPoE User: ${list.length}</b>${head}`, ''];
    list.slice(0, 50).forEach(s => {
      const on = activeNames.has((s.name || '').toLowerCase());
      const st = s.disabled ? '[DISABLED]' : (on ? '[ONLINE]' : '[OFFLINE]');
      lines.push(`${st} ${esc(s.name || '-')} · ${esc(s.profile || '-')}`);
    });
    if (list.length > 50) lines.push(`... dan ${list.length - 50} lainnya`);
    await _reply(chatId, lines.join('\n'));
    return;
  }

  // ── Mode: find ── (cari satu/beberapa user + status detail)
  {
    const matchSecrets = secrets.filter(s => (s.name || '').toLowerCase().includes(fLow));
    if (!matchSecrets.length) { await _reply(chatId, `PPPoE user "<b>${esc(filter)}</b>" tidak ditemukan${head}.`); return; }
    if (matchSecrets.length > 1) {
      const lines = [`<b>Ditemukan ${matchSecrets.length} PPPoE user</b> untuk "<b>${esc(filter)}</b>":`, ''];
      matchSecrets.slice(0, 40).forEach(s => {
        const on = activeNames.has((s.name || '').toLowerCase());
        const st = s.disabled ? '[DISABLED]' : (on ? '[ONLINE]' : '[OFFLINE]');
        lines.push(`${st} ${esc(s.name || '-')} · ${esc(s.profile || '-')}`);
      });
      await _reply(chatId, lines.join('\n'));
      return;
    }
    const s = matchSecrets[0];
    const sess = active.find(a => (a.name || '').toLowerCase() === (s.name || '').toLowerCase());
    const on = !!sess;
    const st = s.disabled ? 'Disabled' : (on ? 'Online' : 'Offline');

    // Lookup pelanggan (nama + ODP induk) berdasarkan username PPPoE.
    let custName = '', odpLabel = '';
    try {
      const { Customer, InfrastructurePoint } = require('../models');
      const cust = await Customer.findOne({
        where: { pppoe_username: s.name },
        attributes: ['name', 'infra_parent_id'],
      });
      if (cust) {
        custName = cust.name || '';
        if (cust.infra_parent_id) {
          const odp = await InfrastructurePoint.findByPk(cust.infra_parent_id, { attributes: ['name', 'type'] });
          if (odp) odpLabel = `${odp.name}${odp.type ? ' (' + String(odp.type).toUpperCase() + ')' : ''}`;
        }
      }
    } catch (_) { /* abaikan, detail tetap tampil tanpa data pelanggan */ }

    const lines = [
      '<b>Detail PPPoE User</b>', '',
      `User    : <b>${esc(s.name || '-')}</b>`,
    ];
    if (custName) lines.push(`Nama    : ${esc(custName)}`);
    lines.push(`Status  : ${esc(st)}`);
    lines.push(`Profil  : ${esc(s.profile || '-')}`);
    if (odpLabel) lines.push(`ODP     : ${esc(odpLabel)}`);
    if (s.service) lines.push(`Service : ${esc(s.service)}`);
    if (on) {
      lines.push(`IP      : <code>${esc(sess.address || '-')}</code>`);
      lines.push(`Uptime  : ${esc(sess.uptime || '0s')}`);
      if (sess.callerID) lines.push(`Caller  : ${esc(sess.callerID)}`);
    } else {
      if (s.remoteAddress) lines.push(`IP set  : ${esc(s.remoteAddress)}`);
      if (s.lastLoggedOut) lines.push(`Terakhir online: ${esc(s.lastLoggedOut)}`);
      if (s.lastCaller) lines.push(`Caller terakhir: ${esc(s.lastCaller)}`);
    }

    // Tombol aksi & kelola. Konteks disimpan agar callback ringkas.
    const dev = deviceId || 0;
    _mgmtSet(chatId, { type: 'pppoe', deviceId: dev, secretId: s.id, name: s.name, profile: s.profile, disabled: s.disabled, online: on, ip: (on && sess) ? sess.address : s.remoteAddress, sessionId: (on && sess) ? sess.id : null });
    const btnRows = [];
    const actRow = [];
    if (on && sess && sess.id) actRow.push({ text: 'Putus Sesi', data: 'pm:dc' });
    const pingIp = on ? (sess && sess.address) : s.remoteAddress;
    if (pingIp) actRow.push({ text: 'Ping', data: 'pm:pg' });
    if (actRow.length) btnRows.push(actRow);
    // Baris kelola: enable/disable, ubah profile, hapus.
    btnRows.push([
      { text: s.disabled ? 'Enable' : 'Disable', data: 'pm:toggle' },
      { text: 'Ubah Profile', data: 'pm:prof' },
    ]);
    btnRows.push([{ text: 'Hapus User', data: 'pm:del' }]);

    await _replyButtons(chatId, lines.join('\n'), btnRows);
  }
}

// ── /backupmikrotik: backup config router & kirim file ke chat ─────────
// Arg = nama device / IP. Tanpa arg → router utama. Memakai
// MikrotikBackupService (SSH /export show-sensitive → .rsc, opsional .backup).
async function _cmdBackupMikrotik(chatId, query) {
  const q = (query || '').trim();
  const { Device } = require('../models');
  const { Op } = require('sequelize');

  // Resolve device.
  let device = null;
  try {
    if (q) {
      device = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${q}%` } }, { ip_address: q }] },
        order: [['name', 'ASC']],
      });
      if (!device) { await _reply(chatId, `Router "<b>${esc(q)}</b>" tidak ditemukan.\nKetik tanpa argumen untuk router utama.`); return; }
    } else {
      // Router utama: is_primary → router aktif pertama.
      try { device = await Device.findOne({ where: { is_primary: true, type: 'router', is_active: true } }); } catch (_) {}
      if (!device) device = await Device.findOne({ where: { type: 'router', is_active: true }, order: [['id', 'ASC']] });
      if (!device) { await _reply(chatId, 'Tidak ada router aktif untuk dibackup.'); return; }
    }
  } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }

  await _reply(chatId, `Membuat backup konfigurasi <b>${esc(device.name)}</b> (${esc(device.ip_address || '-')})…\nMohon tunggu, proses SSH export bisa beberapa detik.`);

  // Jalankan backup.
  let result = null;
  try {
    const Backup = require('./MikrotikBackupService');
    result = await Backup.backupDevice(device);
  } catch (e) {
    await _reply(chatId, 'Gagal backup: ' + esc(e.message || 'error') +
      '\nPastikan SSH router aktif & kredensial benar (Settings > Backup Router).');
    return;
  }

  if (!result || !result.ok || !result.files || !result.files.length) {
    await _reply(chatId, 'Backup gagal: ' + esc((result && result.error) || 'tidak ada file dihasilkan') +
      '\nPeriksa: SSH enabled di router, port SSH benar, user punya hak /export.');
    return;
  }

  // Kirim tiap file ke chat.
  let sent = 0;
  for (const f of result.files) {
    try {
      const cap = `Backup <b>${esc(device.name)}</b>\nFile: <code>${esc(f.filename)}</code> (${_humanBytes(f.size)})`;
      const r = await Telegram.sendDocument(f.path, { chatId: String(chatId), caption: cap, filename: f.filename });
      if (r && r.ok) sent++;
      else await _reply(chatId, `Gagal kirim ${esc(f.filename)}: ${esc((r && r.error) || 'error')}`);
    } catch (e) {
      await _reply(chatId, `Gagal kirim ${esc(f.filename)}: ${esc(e.message || 'error')}`);
    }
  }

  if (sent) {
    await _audit(chatId, 'mikrotik_backup', `Backup config ${device.name} (${device.ip_address || '-'}), ${sent} file`, { targetType: 'device', targetId: device.id });
    await _reply(chatId, `Backup selesai. ${sent} file terkirim.\nFile .rsc dapat di-restore via /import; file .backup via System &gt; Backup di Winbox.`);
  }
}

// ── /cekqueue: daftar simple queue di router ───────────────────────────
// Arg = filter nama/target (opsional). "@<router>" di awal → router tertentu.
// Default menyembunyikan dynamic queue (auto dari PPPoE); "all" untuk semua.
async function _cmdCekQueue(chatId, query) {
  let arg = (query || '').trim();

  // Opsi target router "@NamaRouter".
  let deviceId = null, routerLabel = null;
  const mRouter = /^@(\S+)\s*(.*)$/.exec(arg);
  if (mRouter) {
    const rname = mRouter[1];
    arg = (mRouter[2] || '').trim();
    try {
      const { Device } = require('../models');
      const { Op } = require('sequelize');
      const dev = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${rname}%` } }, { ip_address: rname }] },
        attributes: ['id', 'name'],
      });
      if (!dev) { await _reply(chatId, `Router "<b>${esc(rname)}</b>" tidak ditemukan.`); return; }
      deviceId = dev.id; routerLabel = dev.name;
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
  }

  // Flag "all" untuk ikut menampilkan dynamic queue.
  const tokens = arg.split(/\s+/).filter(Boolean);
  let showDynamic = false, filter = arg;
  if (tokens.length && ['all', 'semua'].includes(tokens[0].toLowerCase())) {
    showDynamic = true; filter = tokens.slice(1).join(' ');
  }

  let queues = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId);
    queues = await mt.getQueues();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil simple queue: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }

  const head = routerLabel ? ` (router: ${esc(routerLabel)})` : '';
  let list = queues;
  if (!showDynamic) list = list.filter(q => !q.dynamic);
  const fLow = filter.toLowerCase();
  if (fLow) list = list.filter(q => (q.name || '').toLowerCase().includes(fLow) || (q.target || '').toLowerCase().includes(fLow));

  if (!list.length) {
    await _reply(chatId, fLow
      ? `Tidak ada simple queue cocok "<b>${esc(filter)}</b>"${head}.`
      : `Tidak ada simple queue${showDynamic ? '' : ' statis'}${head}.`);
    return;
  }

  // max-limit di MikroTik = upload/download. Tampilkan jelas.
  const fmtLimit = (ml) => {
    const parts = String(ml || '0/0').split('/');
    const up = parts[0] || '0', down = parts[1] || '0';
    return `Up ${up} / Down ${down}`;
  };

  // Satu hasil (statis) → detail + tombol kelola.
  if (list.length === 1 && !list[0].dynamic) {
    const q = list[0];
    _mgmtSet(chatId, { type: 'queue', deviceId: deviceId || 0, queueId: q.id, name: q.name, target: q.target, maxLimit: q.maxLimit, disabled: q.disabled, parent: q.parent });
    const st = q.disabled ? 'Nonaktif' : 'Aktif';
    const dlines = [
      `<b>Simple Queue</b>${head}`, '',
      `Nama     : <b>${esc(q.name || '-')}</b>`,
      `Status   : ${esc(st)}`,
      `Target   : <code>${esc(q.target || '-')}</code>`,
      `Max Limit: <b>${esc(fmtLimit(q.maxLimit))}</b>`,
    ];
    if (q.priority && q.priority !== '8') dlines.push(`Prioritas: ${esc(q.priority)}`);
    if (q.parent && q.parent !== 'none') dlines.push(`Parent   : ${esc(q.parent)}`);
    const rows = [
      [{ text: q.disabled ? 'Enable' : 'Disable', data: 'qm:toggle' }, { text: 'Ubah Limit', data: 'qm:limit' }],
      [{ text: 'Hapus Queue', data: 'qm:del' }],
    ];
    await _replyButtons(chatId, dlines.join('\n'), rows);
    return;
  }

  const lines = [`<b>Simple Queue: ${list.length}</b>${head}`, ''];
  list.slice(0, 45).forEach(q => {
    const st = q.disabled ? '[OFF]' : (q.dynamic ? '[DYN]' : '[ON]');
    lines.push(`${st} <b>${esc(q.name || '-')}</b>`);
    const meta = [`target ${esc(q.target || '-')}`, `limit ${esc(fmtLimit(q.maxLimit))}`];
    if (q.priority && q.priority !== '8') meta.push(`prio ${esc(q.priority)}`);
    if (q.parent && q.parent !== 'none') meta.push(`parent ${esc(q.parent)}`);
    lines.push('  ' + meta.join(' · '));
  });
  if (list.length > 45) lines.push(`... dan ${list.length - 45} lainnya`);
  if (!showDynamic) lines.push('', 'Tambah "all" untuk ikut tampilkan queue dinamis (PPPoE).');
  await _reply(chatId, lines.join('\n'));
}

// ── /cekinterface: cek interface up/running vs down ────────────────────
// Tanpa arg + banyak router → tampilkan tombol pilih router.
// Arg = nama/IP router → langsung. "@router" juga didukung.
async function _cmdCekInterface(chatId, query) {
  let arg = (query || '').trim();
  const mAt = /^@(\S+)\s*(.*)$/.exec(arg);
  if (mAt) arg = mAt[1];

  const { Device } = require('../models');
  const { Op } = require('sequelize');

  // Jika ada argumen → resolve router langsung.
  if (arg) {
    let dev = null;
    try {
      dev = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${arg}%` } }, { ip_address: arg }] },
        attributes: ['id', 'name'], order: [['name', 'ASC']],
      });
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
    if (!dev) { await _reply(chatId, `Router "<b>${esc(arg)}</b>" tidak ditemukan.`); return; }
    return await _renderInterfaces(chatId, dev.id, dev.name);
  }

  // Tanpa argumen: cek jumlah router aktif.
  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'], order: [['name', 'ASC']], limit: 30,
    });
  } catch (e) { await _reply(chatId, 'Gagal memuat router: ' + esc(e.message)); return; }

  if (!routers.length) { await _reply(chatId, 'Tidak ada router aktif di Device Management.'); return; }
  if (routers.length === 1) {
    return await _renderInterfaces(chatId, routers[0].id, routers[0].name);
  }

  // Banyak router → tampilkan tombol pilih.
  const rows = routers.map(r => [{ text: `${r.name} (${r.ip_address || '-'})`, data: `if:${r.id}` }]);
  await _replyButtons(chatId, '<b>Cek Interface</b>\nPilih router:', rows);
}

// Render daftar interface up/down untuk satu router.
async function _renderInterfaces(chatId, deviceId, deviceName) {
  let ifaces = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId || null);
    ifaces = await mt.getInterfaces();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil interface: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }

  if (!ifaces.length) { await _reply(chatId, `Tidak ada interface di <b>${esc(deviceName)}</b>.`); return; }

  const up = ifaces.filter(i => i.running && !i.disabled);
  const down = ifaces.filter(i => !i.running && !i.disabled);
  const disabled = ifaces.filter(i => i.disabled);

  const head = ` (router: ${esc(deviceName)})`;
  const lines = [
    `<b>Status Interface</b>${head}`,
    `Total ${ifaces.length} · Up ${up.length} · Down ${down.length} · Disabled ${disabled.length}`,
    '',
  ];

  const fmt = (i) => {
    const cm = i.comment ? ` (${esc(i.comment)})` : '';
    return `${esc(i.name)}${cm} · ${esc(i.type)}`;
  };

  lines.push(`<b>UP / Running (${up.length}):</b>`);
  if (up.length) up.slice(0, 40).forEach(i => lines.push(`[UP] ${fmt(i)}`));
  else lines.push('(tidak ada)');

  lines.push('', `<b>DOWN / Not Running (${down.length}):</b>`);
  if (down.length) down.slice(0, 40).forEach(i => lines.push(`[DOWN] ${fmt(i)}`));
  else lines.push('(tidak ada)');

  if (disabled.length) {
    lines.push('', `<b>Disabled (${disabled.length}):</b>`);
    disabled.slice(0, 20).forEach(i => lines.push(`[OFF] ${fmt(i)}`));
  }

  await _reply(chatId, lines.join('\n'));
}

// ── /cekip: pilih cek IP router atau IP pelanggan ──────────────────────
async function _cmdCekIp(chatId, query) {
  const arg = (query || '').trim();
  // Shortcut: /cekip router  atau  /cekip <keyword pelanggan>
  const first = arg.split(/\s+/)[0]?.toLowerCase();
  if (first === 'router') return await _cekIpRouterStart(chatId);
  if (arg && first !== 'pelanggan' && first !== 'customer') {
    // dianggap keyword pelanggan
    return await _cekIpPelanggan(chatId, arg);
  }
  if (first === 'pelanggan' || first === 'customer') {
    _setPending(chatId, 'cekip_pelanggan');
    await Telegram.sendForceReply('Masukkan nama / CID / IP / PPPoE pelanggan:', String(chatId), 'mis. FLAYNET.COM atau CID010', await Telegram._getConfig());
    return;
  }
  // Tanpa arg → tampilkan pilihan.
  await _replyButtons(chatId, '<b>Cek IP</b>\nPilih jenis:', [
    [{ text: 'Cek IP Router', data: 'ip:router' }],
    [{ text: 'Cek IP Pelanggan', data: 'ip:cust' }],
  ]);
}

// Cek IP Router: pilih router (bila banyak) lalu tampilkan daftar IP.
async function _cekIpRouterStart(chatId) {
  const { Device } = require('../models');
  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'], order: [['name', 'ASC']], limit: 30,
    });
  } catch (e) { await _reply(chatId, 'Gagal memuat router: ' + esc(e.message)); return; }
  if (!routers.length) { await _reply(chatId, 'Tidak ada router aktif di Device Management.'); return; }
  if (routers.length === 1) return await _renderRouterIp(chatId, routers[0].id, routers[0].name);
  const rows = routers.map(r => [{ text: `${r.name} (${r.ip_address || '-'})`, data: `ipr:${r.id}` }]);
  await _replyButtons(chatId, '<b>Cek IP Router</b>\nPilih router:', rows);
}

async function _renderRouterIp(chatId, deviceId, deviceName) {
  let addrs = [];
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    const mt = await getMikrotikInstanceByDevice(deviceId || null);
    addrs = await mt.getIPAddresses();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil IP address: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }
  if (!addrs.length) { await _reply(chatId, `Tidak ada IP address di <b>${esc(deviceName)}</b>.`); return; }

  const head = ` (router: ${esc(deviceName)})`;
  const active = addrs.filter(a => !a.disabled);
  const lines = [`<b>IP Address Router</b>${head}`, `Total ${addrs.length} · Aktif ${active.length}`, ''];
  addrs.slice(0, 50).forEach(a => {
    const st = a.disabled ? '[OFF]' : (a.dynamic ? '[DYN]' : '[ON]');
    const cm = a.comment ? ` (${esc(a.comment)})` : '';
    lines.push(`${st} <code>${esc(a.address)}</code> · ${esc(a.interface || '-')}${cm}`);
  });
  if (addrs.length > 50) lines.push(`... dan ${addrs.length - 50} lainnya`);
  await _reply(chatId, lines.join('\n'));
}

// Cek IP Pelanggan: cari pelanggan & tampilkan IP terkait.
async function _cekIpPelanggan(chatId, keyword) {
  const q = (keyword || '').trim();
  if (!q) { await _reply(chatId, 'Masukkan keyword pelanggan. Contoh: /cekip CID010'); return; }
  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  let custs = [];
  try {
    custs = await Customer.findAll({
      where: { [Op.or]: [
        { customer_id: q }, { name: { [Op.like]: `%${q}%` } }, { static_ip: q }, { pppoe_username: q },
      ] },
      attributes: ['customer_id', 'name', 'static_ip', 'pppoe_username', 'connection_type', 'status', 'isolir_status'],
      limit: 6, order: [['name', 'ASC']],
    });
  } catch (e) { await _reply(chatId, 'Gagal mencari: ' + esc(e.message)); return; }

  if (!custs.length) { await _reply(chatId, `Pelanggan "<b>${esc(q)}</b>" tidak ditemukan.`); return; }

  if (custs.length > 1) {
    const lines = [`<b>Ditemukan ${custs.length} pelanggan</b> untuk "<b>${esc(q)}</b>":`, ''];
    custs.forEach(c => lines.push(`- <b>${esc(c.name || '-')}</b> (${esc(c.customer_id)}) · ${c.static_ip ? esc(c.static_ip) : (c.pppoe_username ? esc(c.pppoe_username) : '-')}`));
    lines.push('', 'Persempit dengan CID untuk detail.');
    await _reply(chatId, lines.join('\n'));
    return;
  }

  const c = custs[0];
  const isol = (c.isolir_status && c.isolir_status !== 'active');
  const lines = [
    '<b>IP Pelanggan</b>', '',
    `Nama    : <b>${esc(c.name || '-')}</b> (${esc(c.customer_id)})`,
    `Koneksi : ${esc((c.connection_type || '-').toUpperCase())}`,
    `IP Statis: ${c.static_ip ? '<code>' + esc(c.static_ip) + '</code>' : '-'}`,
    `PPPoE   : ${c.pppoe_username ? '<code>' + esc(c.pppoe_username) + '</code>' : '-'}`,
    `Status  : ${isol ? 'Terisolir' : (c.status === 'active' ? 'Aktif' : esc(c.status || '-'))}`,
  ];
  await _reply(chatId, lines.join('\n'));
}

// ── /cekisolir: daftar pelanggan yang sedang terisolir ─────────────────
async function _cmdCekIsolir(chatId, query) {
  const q = (query || '').trim().toLowerCase();
  const { Customer } = require('../models');
  const { Op } = require('sequelize');
  let custs = [];
  try {
    const where = { isolir_status: 'isolated' };
    if (q) where[Op.or] = [
      { customer_id: { [Op.like]: `%${q}%` } },
      { name: { [Op.like]: `%${q}%` } },
      { pppoe_username: { [Op.like]: `%${q}%` } },
    ];
    custs = await Customer.findAll({
      where,
      attributes: ['customer_id', 'name', 'pppoe_username', 'isolir_at', 'phone'],
      order: [['isolir_at', 'DESC']], limit: 60,
    });
  } catch (e) { await _reply(chatId, 'Gagal mengambil data isolir: ' + esc(e.message)); return; }

  if (!custs.length) {
    await _reply(chatId, q
      ? `Tidak ada pelanggan terisolir cocok "<b>${esc(query)}</b>".`
      : 'Tidak ada pelanggan yang sedang terisolir. Semua aktif.');
    return;
  }

  const fmtTgl = (d) => {
    if (!d) return '-';
    try { return new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'short' }); }
    catch (_) { return '-'; }
  };

  const lines = [`<b>Pelanggan Terisolir: ${custs.length}</b>`, ''];
  custs.slice(0, 50).forEach(c => {
    lines.push(`- <b>${esc(c.name || '-')}</b> (${esc(c.customer_id)})`);
    const meta = [];
    if (c.pppoe_username) meta.push(`PPPoE ${esc(c.pppoe_username)}`);
    meta.push(`sejak ${esc(fmtTgl(c.isolir_at))}`);
    lines.push('  ' + meta.join(' · '));
  });
  if (custs.length > 50) lines.push(`... dan ${custs.length - 50} lainnya`);
  lines.push('', 'Restore: /cekcustdata <CID> lalu tombol Restore, atau /restore <CID>.');
  await _reply(chatId, lines.join('\n'));
}

// ── Kirim Tagihan / Reminder WA ke pelanggan (dipakai tombol bot) ───────
// Mencari invoice unpaid/overdue terbaru pelanggan, membangun pesan dari
// WaTemplate (atau default), lalu kirim via GatewayService. Mengembalikan
// { ok, message }.
async function _sendTagihanWA(chatId, customer) {
  try {
    const { Invoice, WaTemplate } = require('../models');
    const { Op } = require('sequelize');
    const GatewayService = require('./GatewayService');
    const helper = require('../utils/templateHelper');

    if (!customer.phone) return { ok: false, message: 'Nomor HP pelanggan tidak tersedia.' };

    // Invoice belum lunas terbaru.
    const invoice = await Invoice.findOne({
      where: { customer_id: customer.id, status: { [Op.in]: ['unpaid', 'overdue', 'pending'] } },
      order: [['due_date', 'ASC']],
    });
    if (!invoice) return { ok: false, message: 'Tidak ada tagihan belum dibayar untuk pelanggan ini.' };

    // Session WA aktif.
    const session = await GatewayService.getDefaultSendingSession();
    if (session) { try { await GatewayService.warmSession(session.session_id); } catch (_) {} }
    if (!session || !GatewayService.isConnected(session.session_id)) {
      return { ok: false, message: 'Tidak ada WA session yang terhubung.' };
    }

    // Data & template.
    const MONTHS = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
    const fmtDate = s => s ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' }) : '-';
    const periodeStr = (MONTHS[invoice.period_month] || invoice.period_month || '') + ' ' + (invoice.period_year || '');
    let companyName = 'ISP'; try { companyName = await _getSetting('company_name', 'ISP'); } catch (_) {}

    let permanentLink = '';
    try { permanentLink = await helper.getOrCreateCustomerLink(customer); } catch (_) {}

    const status = invoice.status === 'overdue' ? 'overdue' : 'unpaid';
    const data = helper.getInvoiceData({
      customerName: customer.name, customerId: customer.customer_id, customerPhone: customer.phone,
      packageName: (customer.package && customer.package.name) || '-',
      invoiceNumber: invoice.invoice_number, invoiceId: invoice.id,
      periodeStr,
      amount: invoice.total || invoice.amount, amountFormatted: fmtRp(invoice.total || invoice.amount),
      dueDate: invoice.due_date, dueDateFormatted: fmtDate(invoice.due_date),
      status, companyName, permanentLink,
    });

    // Template: invoice_unpaid (aktif) → default bawaan.
    let tplContent = '';
    try {
      const found = await WaTemplate.findOne({ where: { category: 'invoice_unpaid', is_active: true }, order: [['updated_at', 'DESC']] });
      tplContent = found ? (found.content || found.message || '') : '';
    } catch (_) {}
    if (!tplContent) tplContent = helper.getDefaultInvoiceUnpaidTemplate();

    const message = helper.replaceVariables(tplContent, data);

    await GatewayService.sendMessage(session.session_id, customer.phone, message, null);

    // Catat reminder.
    try { invoice.last_wa_reminder_at = new Date(); await invoice.save(); } catch (_) {}
    await _audit(chatId, 'wa_reminder', `Kirim tagihan WA ke ${customer.name} (${customer.customer_id}), invoice ${invoice.invoice_number}`, { targetType: 'customer', targetId: customer.id });

    return { ok: true, message: `Tagihan WA terkirim ke ${customer.name} (${invoice.invoice_number}).` };
  } catch (e) {
    return { ok: false, message: 'Gagal kirim tagihan: ' + (e.message || 'error') };
  }
}

// ── Tandai Lunas invoice pelanggan dari bot (cash) ─────────────────────
// Mirror inti PaymentController: catat Payment + invoice paid + due_date maju
// + status aktif, lalu auto-restore bila ter-isolir. Audit dicatat.
async function _markPaidWA(chatId, customer) {
  const { sequelize, Invoice, Payment } = require('../models');
  const { Op } = require('sequelize');
  const moment = require('moment');
  const addOneMonthKeepDay = (d) => {
    if (!d) return null; const mm = moment(d); return mm.isValid() ? mm.add(1, 'month').format('YYYY-MM-DD') : null;
  };

  // Invoice belum lunas terbaru.
  const invoice = await Invoice.findOne({
    where: { customer_id: customer.id, status: { [Op.in]: ['unpaid', 'overdue', 'pending'] } },
    order: [['due_date', 'ASC']],
  });
  if (!invoice) return { ok: false, message: 'Tidak ada tagihan belum dibayar.' };

  const today = moment().format('YYYY-MM-DD');
  const amount = invoice.total || invoice.amount || 0;
  const t = await sequelize.transaction();
  try {
    await Payment.create({
      invoice_id: invoice.id, amount,
      payment_method: 'cash', payment_date: today,
      reference_number: 'via Telegram bot', recorded_by: null,
      notes: `Ditandai lunas via Telegram bot (chat ${chatId})`,
    }, { transaction: t });

    await invoice.update({ status: 'paid', paid_date: today }, { transaction: t });

    // due_date berikutnya = due_date customer + 1 bulan.
    const baseDue = customer.due_date || invoice.due_date || today;
    const nextDue = addOneMonthKeepDay(baseDue);
    const custUpdate = { status: 'active' };
    if (nextDue) custUpdate.due_date = nextDue;
    await customer.update(custUpdate, { transaction: t });

    await t.commit();
  } catch (e) {
    try { await t.rollback(); } catch (_) {}
    return { ok: false, message: 'Gagal mencatat pembayaran: ' + (e.message || 'error') };
  }

  // Auto-restore bila sebelumnya ter-isolir (di luar transaksi).
  let restoredNote = '';
  try {
    if (customer.isolir_status === 'isolated' || customer.isolir_status === 'restoring') {
      const IsolirSvc = require('./IsolirService');
      const r = await IsolirSvc.restoreAfterPayment(customer.id);
      if (r && r.success && !r.skipped) restoredNote = '\nLayanan dipulihkan (restore isolir).';
    }
  } catch (e) { restoredNote = '\n(Catatan: auto-restore gagal — cek manual.)'; }

  await _audit(chatId, 'payment_mark_paid', `Tandai lunas ${customer.name} (${customer.customer_id}), invoice ${invoice.invoice_number}, ${amount}`, { targetType: 'customer', targetId: customer.id, newData: { invoice: invoice.invoice_number, amount } });

  const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  return { ok: true, message: `Invoice ${invoice.invoice_number} ditandai LUNAS (${fmtRp(amount)}).${restoredNote}` };
}

// ── /cektrafik: trafik realtime interface (rx/tx bps) ──────────────────
async function _cmdCekTrafik(chatId, query) {
  let arg = (query || '').trim();
  const mAt = /^@(\S+)\s*(.*)$/.exec(arg);
  if (mAt) arg = mAt[1];

  const { Device } = require('../models');
  const { Op } = require('sequelize');

  if (arg) {
    let dev = null;
    try {
      dev = await Device.findOne({
        where: { type: 'router', [Op.or]: [{ name: { [Op.like]: `%${arg}%` } }, { ip_address: arg }] },
        attributes: ['id', 'name'], order: [['name', 'ASC']],
      });
    } catch (e) { await _reply(chatId, 'Gagal mencari router: ' + esc(e.message)); return; }
    if (!dev) { await _reply(chatId, `Router "<b>${esc(arg)}</b>" tidak ditemukan.`); return; }
    return await _renderTrafik(chatId, dev.id, dev.name);
  }

  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'], order: [['name', 'ASC']], limit: 30,
    });
  } catch (e) { await _reply(chatId, 'Gagal memuat router: ' + esc(e.message)); return; }

  if (!routers.length) { await _reply(chatId, 'Tidak ada router aktif di Device Management.'); return; }
  if (routers.length === 1) return await _renderTrafik(chatId, routers[0].id, routers[0].name);

  const rows = routers.map(r => [{ text: `${r.name} (${r.ip_address || '-'})`, data: `tr:${r.id}` }]);
  await _replyButtons(chatId, '<b>Cek Trafik</b>\nPilih router:', rows);
}

// Format bit-per-second → human readable (bps/Kbps/Mbps/Gbps).
function _fmtBps(bps) {
  const n = Number(bps) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' Gbps';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mbps';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' Kbps';
  return n + ' bps';
}

// Render trafik realtime semua interface running di satu router.
async function _renderTrafik(chatId, deviceId, deviceName) {
  let ifaces = [];
  let mt;
  try {
    const { getMikrotikInstanceByDevice } = require('./MikrotikService');
    mt = await getMikrotikInstanceByDevice(deviceId || null);
    ifaces = await mt.getInterfaces();
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil interface: ' + esc(e.message || 'error') +
      '\nPastikan router MikroTik aktif & dapat diakses.');
    return;
  }

  // Hanya interface yang running & tidak disabled (yang punya trafik).
  const running = ifaces.filter(i => i.running && !i.disabled);
  if (!running.length) { await _reply(chatId, `Tidak ada interface running di <b>${esc(deviceName)}</b>.`); return; }

  // Batasi agar tidak terlalu banyak request (maks 20 interface).
  const targets = running.slice(0, 20);
  let stats = [];
  try {
    stats = await mt.getInterfacesBulkStats(targets.map(i => i.name));
  } catch (e) {
    await _reply(chatId, 'Gagal mengambil trafik: ' + esc(e.message || 'error'));
    return;
  }

  // Gabung nama + comment dari ifaces.
  const meta = new Map(targets.map(i => [i.name, i]));
  // Urutkan dari trafik terbesar (rx+tx).
  stats.sort((a, b) => (b.rxBitsPerSecond + b.txBitsPerSecond) - (a.rxBitsPerSecond + a.txBitsPerSecond));

  let totRx = 0, totTx = 0;
  const lines = [`<b>Trafik Realtime</b> (router: ${esc(deviceName)})`, ''];
  stats.forEach(s => {
    totRx += s.rxBitsPerSecond; totTx += s.txBitsPerSecond;
    const m = meta.get(s.name);
    const cm = (m && m.comment) ? ` (${esc(m.comment)})` : '';
    lines.push(`<b>${esc(s.name)}</b>${cm}`);
    lines.push(`  RX ${esc(_fmtBps(s.rxBitsPerSecond))} · TX ${esc(_fmtBps(s.txBitsPerSecond))}`);
  });
  if (running.length > 20) lines.push('', `... ${running.length - 20} interface lain tidak ditampilkan.`);
  lines.push('', `<b>Total</b>: RX ${esc(_fmtBps(totRx))} · TX ${esc(_fmtBps(totTx))}`);
  lines.push('Snapshot sesaat (instan), bukan rata-rata.');

  await _reply(chatId, lines.join('\n'));
}

// Parse & dispatch satu pesan.
async function _handleMessage(msg, cfg, allowed, allowControl) {
  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || '').trim();
  if (chatId == null) return;

  // Catat chat untuk fitur "deteksi Chat ID" (walau belum terdaftar).
  _recordSeenChat(msg.chat, msg.from);

  // Otorisasi: hanya chat terdaftar.
  if (!allowed.has(String(chatId))) {
    logger.info(`[TGBot] Perintah dari chat tak terdaftar (${chatId}) diabaikan`);
    return;
  }

  // Jawaban atas prompt tombol (ForceReply) — teks biasa, bukan command.
  if (text && !text.startsWith('/')) {
    // Wizard aktif (mis. buat PPPoE) menunggu input username/password.
    const w = _wizGet(chatId);
    if (w && w.flow === 'cpppoe' && (w.step === 'username' || w.step === 'password')) {
      if (w.step === 'username') { await _wizCreatePppoeUsername(chatId, text); return; }
      if (w.step === 'password') { await _wizCreatePppoePassword(chatId, text); return; }
    }
    if (w && w.flow === 'cqueue') {
      if (w.step === 'name')   { await _wizCreateQueueName(chatId, text); return; }
      if (w.step === 'target') { await _wizCreateQueueTarget(chatId, text); return; }
      if (w.step === 'up')     { await _wizCreateQueueUp(chatId, text); return; }
      if (w.step === 'down')   { await _wizCreateQueueDown(chatId, text); return; }
    }
    if (w && w.flow === 'qlimit') {
      if (w.step === 'up')   { await _qlimitUp(chatId, text); return; }
      if (w.step === 'down') { await _qlimitDown(chatId, text, allowControl); return; }
    }
    const pendingCmd = _takePending(chatId);
    if (pendingCmd) {
      // Pending khusus: cek IP pelanggan.
      if (pendingCmd === 'cekip_pelanggan') {
        const rl = _rateLimit(chatId, 'cekip');
        if (!rl.ok) return _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`);
        return _cekIpPelanggan(chatId, text);
      }
      const rl = _rateLimit(chatId, pendingCmd);
      if (!rl.ok) return _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`);
      logger.info(`[TGBot] prompt-reply /${pendingCmd} dari ${chatId}`);
      return _dispatch(pendingCmd, text, chatId, allowControl);
    }
    return; // teks biasa tanpa prompt menunggu — abaikan.
  }
  if (!text.startsWith('/')) return;

  // Pisah command & argumen. Dukung "/cmd@botname".
  const m = /^\/(\w+)(?:@\w+)?\s*(.*)$/.exec(text);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || '').trim();

  logger.info(`[TGBot] cmd /${cmd} dari ${chatId}`);

  // Rate-limit anti-spam (per chat). help/start/menu dikecualikan dari blok.
  if (cmd !== 'help' && cmd !== 'start' && cmd !== 'bantuan' && cmd !== 'menu') {
    const rl = _rateLimit(chatId, cmd);
    if (!rl.ok) {
      logger.info(`[TGBot] rate-limit ${rl.reason} chat ${chatId} cmd /${cmd}`);
      return _reply(chatId, `Terlalu sering. Coba lagi dalam ${rl.retryAfter} detik.`);
    }
  }

  // Cari di registry (keyword + alias). 'help'/'start'/'menu' selalu tersedia.
  const { map } = await _loadCommands();
  if (cmd === 'help' || cmd === 'bantuan') {
    return _cmdHelp(chatId, allowControl);
  }
  if (cmd === 'start' || cmd === 'menu') {
    return _showMenu(chatId, 'root');
  }
  const def = map.get(cmd);
  if (!def) {
    return _reply(chatId, `Perintah tidak dikenal: <code>/${esc(cmd)}</code>\nKetik /help untuk daftar.`);
  }

  // Cek izin kontrol bila diperlukan.
  if (def.requireControl && !allowControl) {
    return _reply(chatId, 'Perintah kontrol dinonaktifkan. Aktifkan "Izinkan kontrol via bot" di Telegram Center.');
  }

  // Dispatch sesuai tipe.
  if (def.type === 'builtin') {
    return _dispatchBuiltin(def.handler, cmd, arg, chatId, allowControl);
  }

  if (def.type === 'reply') {
    // Balasan statis dengan placeholder umum.
    const text = _renderTemplate(def.replyTemplate || '(balasan kosong)', { arg: esc(arg) });
    return _reply(chatId, text);
  }

  if (def.type === 'data') {
    const DS = require('./BotDataSources');
    const res = await DS.run(def.dataSource, arg);
    if (!res.ok) {
      return _reply(chatId, esc(res.error || 'Data tidak ditemukan.'));
    }
    const text = _renderTemplate(def.replyTemplate || '', res.vars || {});
    return _reply(chatId, text);
  }

  return _reply(chatId, `Tipe perintah tidak dikenal untuk <code>/${esc(cmd)}</code>.`);
}

// Satu siklus polling.
async function _pollOnce() {
  const cfg = await Telegram._getConfig();
  if (String(cfg.telegram_bot_enabled) !== '1' || !Telegram.isEnabled(cfg)) return false;

  const allowControl = String(cfg.telegram_bot_allow_control) === '1';
  const adminList = await _getSetting('telegram_chat_admin', '');
  const allowed = _allowedChats(cfg, adminList);

  const upd = await Telegram.getUpdates(_offset || undefined, 25, cfg);
  if (!upd.ok) {
    if (upd.error) logger.debug('[TGBot] getUpdates: ' + upd.error);
    return true; // tetap aktif, coba lagi
  }
  for (const u of upd.result) {
    if (u.update_id != null) _offset = u.update_id + 1;
    if (u.message) {
      try { await _handleMessage(u.message, cfg, allowed, allowControl); }
      catch (e) { logger.warn('[TGBot] handle error: ' + (e.message || e)); }
    } else if (u.callback_query) {
      try { await _handleCallback(u.callback_query, cfg, allowed, allowControl); }
      catch (e) { logger.warn('[TGBot] callback error: ' + (e.message || e)); }
    }
  }
  if (upd.result.length) { try { await _setSetting('telegram_bot_offset', String(_offset)); } catch (_) {} }
  return true;
}

// Loop poll berkelanjutan (dipanggil start()).
async function _loop() {
  if (_running) return;
  _running = true;
  logger.info('[TGBot] Polling loop dimulai (build: menu+pppoe+callback v3)');
  while (!_stop) {
    let active = false;
    try { active = await _pollOnce(); }
    catch (e) { logger.warn('[TGBot] poll error: ' + (e.message || e)); }
    // Bila bot nonaktif, jangan hammer API — tidur lebih lama.
    await new Promise(r => setTimeout(r, active ? 800 : 15000));
  }
  _running = false;
  logger.info('[TGBot] Polling loop berhenti');
}

// Mulai bot (idempoten). Memuat offset tersimpan.
async function start() {
  if (_booted) return;
  _booted = true;
  try {
    const saved = parseInt(await _getSetting('telegram_bot_offset', '0'), 10);
    if (Number.isFinite(saved) && saved > 0) _offset = saved;
  } catch (_) {}
  _stop = false;
  _loop().catch(e => logger.error('[TGBot] loop fatal: ' + (e.message || e)));
}

function stop() { _stop = true; }

// Status untuk UI (apakah loop hidup).
function isRunning() { return _running; }

module.exports = { start, stop, isRunning, _handleMessage, invalidateCommandCache, buildDailySummaryText, sendDailySummary, getSeenChats };
