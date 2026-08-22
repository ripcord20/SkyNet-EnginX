'use strict';

/**
 * PppoeFeedService.js — Feed real-time PPPoE CONNECT / DISCONNECT ke Telegram.
 * ─────────────────────────────────────────────────────────────────────────────
 * Meniru notifikasi gaya kartu (lihat referensi): tiap pelanggan PPPoE yang
 * LOGIN atau LOGOUT memunculkan satu pesan berisi Server, User, Paket, IP, MAC,
 * Last Logout, plus footer "Total PPPoE Active / Offline".
 *
 * BEDA dengan MonitoringService._checkPppoe:
 *   - _checkPppoe = monitoring GANGGUAN (transition-based, anti-spam, hanya saat
 *     pelanggan AKTIF yang seharusnya online tiba-tiba putus). Tujuannya alarm.
 *   - PppoeFeedService = FEED aktivitas: tiap login & logout dilaporkan (seperti
 *     log accounting). Tujuannya visibilitas operasional, bukan alarm. Karena itu
 *     TIDAK pakai flapping-guard — login adalah login.
 *
 * SUMBER DATA: diff snapshot /ppp/active antar siklus.
 *   - username muncul di snapshot baru tapi tidak di lama  → CONNECT
 *   - username hilang dari snapshot baru                   → DISCONNECT
 * Snapshot disimpan in-memory per router (Map). Saat cold-start (snapshot lama
 * kosong) TIDAK memuntahkan ratusan "CONNECT" — siklus pertama hanya merekam
 * baseline, baru siklus berikutnya melaporkan perubahan.
 *
 * Server name = identity router (devices.name). Paket/MAC/Last Logout di-enrich
 * dari tabel Customer + Package (lookup by pppoe_username). MAC diambil dari
 * caller-id sesi (paling akurat: MAC perangkat yang sedang dial).
 *
 * Setting app_settings:
 *   telegram_pppoe_feed         0/1  — master feed on/off
 *   telegram_pppoe_feed_connect 0/1  — laporkan CONNECT (default 1)
 *   telegram_pppoe_feed_logout  0/1  — laporkan DISCONNECT (default 1)
 *   telegram_chat_pppoe_feed    chat tujuan (multi koma; kosong = chat global)
 *   telegram_pppoe_feed_max     batas pesan per siklus (anti-flood; default 25)
 *
 * Catatan beban: feed ini reuse snapshot /ppp/active yang sudah diambil — tapi
 * agar tidak menggandakan call, ia mengambil sendiri /ppp/active per router.
 * Pada interval pendek + banyak pelanggan, pertimbangkan menaikkan interval.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Snapshot terakhir per router: routerKey → Map(username → { address, callerID })
const _lastSnapshot = new Map();
// Apakah router ini sudah pernah di-snapshot (baseline) di proses ini.
const _seeded = new Set();

function _routerKey(deviceId) { return deviceId != null ? String(deviceId) : 'default'; }

function _enabledConnect(cfg) { return String(cfg.telegram_pppoe_feed_connect ?? '1') === '1'; }
function _enabledLogout(cfg)  { return String(cfg.telegram_pppoe_feed_logout  ?? '1') === '1'; }
function _maxPerCycle(cfg) {
  const n = parseInt(cfg.telegram_pppoe_feed_max, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

// Format kecepatan paket: "Upto 10Mbps" (pakai speed_down).
function _speedLabel(pkg) {
  if (!pkg) return '';
  const d = parseInt(pkg.speed_down, 10);
  if (Number.isFinite(d) && d > 0) return `Upto ${d}Mbps`;
  return pkg.name || '';
}

// Template default kartu PPPoE feed (bisa di-override via app_settings
// telegram_tpl_pppoe_connect / telegram_tpl_pppoe_disconnect di Telegram Center).
// Placeholder: {server} {user} {nama} {paket} {odp} {ip} {mac} {uptime}
//              {last_logout} {total_active} {total_offline}
// Baris yang hanya berisi label + placeholder kosong otomatis dihilangkan.
const FEED_TPL_DEFAULTS = {
  pppoe_connect:
    '<b>PPPoE CONNECT</b>\n\n' +
    'Server : <b>{server}</b>\n' +
    'User : <b>{user}</b>\n' +
    'Nama : {nama}\n' +
    'Paket : {paket}\n' +
    'ODP : {odp}\n' +
    'IP : <code>{ip}</code>\n' +
    'MAC : <code>{mac}</code>\n' +
    'Uptime : {uptime}\n\n' +
    'Total PPPoE Active : <b>{total_active}</b>\n' +
    'Total PPPoE Offline : <b>{total_offline}</b>',
  pppoe_disconnect:
    '<b>PPPoE DISCONNECT</b>\n\n' +
    'Server : <b>{server}</b>\n' +
    'User : <b>{user}</b>\n' +
    'Nama : {nama}\n' +
    'Paket : {paket}\n' +
    'ODP : {odp}\n' +
    'IP : <code>{ip}</code>\n' +
    'MAC : <code>{mac}</code>\n' +
    'Last Logout : {last_logout}\n\n' +
    'Total PPPoE Active : <b>{total_active}</b>\n' +
    'Total PPPoE Offline : <b>{total_offline}</b>',
};

// Placeholder opsional — bila kosong, seluruh barisnya dihilangkan.
const FEED_OPTIONAL = ['nama', 'paket', 'odp', 'ip', 'mac', 'uptime', 'last_logout'];

// Render template feed: substitusi {x} (di-escape), lalu buang baris yang
// placeholder opsionalnya kosong.
function _renderFeedTpl(cfg, key, vars) {
  let tpl = (cfg['telegram_tpl_' + key] || '').trim() || FEED_TPL_DEFAULTS[key] || '';
  const out = tpl.replace(/\{(\w+)\}/g, (m, name) => {
    const has = Object.prototype.hasOwnProperty.call(vars, name);
    const val = has ? String(vars[name] == null ? '' : vars[name]) : '';
    if (FEED_OPTIONAL.includes(name) && val.trim() === '') return '';
    return has ? esc(val) : m;
  });
  // Hilangkan baris yang tinggal label kosong (mis. "Nama :", "ODP :",
  // "IP :" dgn code kosong) lalu rapikan baris kosong berurutan.
  const lines = out.split('\n').filter(line => {
    const stripped = line.replace(/<\/?code>/g, '').replace(/<\/?b>/g, '').trim();
    return !/^[\w .\/]+:\s*$/.test(stripped);
  });
  const cleaned = [];
  for (const l of lines) {
    if (l.trim() === '' && cleaned.length && cleaned[cleaned.length - 1].trim() === '') continue;
    cleaned.push(l);
  }
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Bangun kartu pesan untuk satu event (memakai template editable).
function _buildCard(kind /* connect|disconnect */, ctx, cfg) {
  const key = kind === 'connect' ? 'pppoe_connect' : 'pppoe_disconnect';
  return _renderFeedTpl(cfg || {}, key, {
    server: ctx.server || '-',
    user: ctx.user || '-',
    nama: ctx.customerName || '',
    paket: ctx.packageLabel || '',
    odp: ctx.odp || '',
    ip: ctx.ip || '',
    mac: ctx.mac || '',
    uptime: ctx.uptime || '',
    last_logout: ctx.lastLogout || '',
    total_active: (ctx.totalActive != null ? ctx.totalActive : 0),
    total_offline: (ctx.totalOffline != null ? ctx.totalOffline : 0),
  });
}

// Lookup enrich (paket, nama, mac DB) untuk daftar username sekaligus.
async function _enrich(usernames) {
  const map = new Map(); // username(lower) → { customerName, package, macDb, customerId }
  if (!usernames.length) return map;
  try {
    const { Customer, Package, InfrastructurePoint } = require('../models');
    const { Op } = require('sequelize');
    const rows = await Customer.findAll({
      where: { pppoe_username: { [Op.in]: usernames } },
      attributes: ['id', 'customer_id', 'name', 'pppoe_username', 'mac_address', 'ont_mac', 'infra_parent_id'],
      include: [
        { model: Package, as: 'package', attributes: ['name', 'speed_down', 'speed_up'], required: false },
      ],
    });
    // Lookup nama ODP (InfrastructurePoint) untuk parent_id yang ada.
    let odpMap = new Map();
    try {
      const parentIds = [...new Set(rows.map(c => c.infra_parent_id).filter(Boolean))];
      if (parentIds.length && InfrastructurePoint) {
        const pts = await InfrastructurePoint.findAll({
          where: { id: { [Op.in]: parentIds } },
          attributes: ['id', 'name', 'type'],
        });
        odpMap = new Map(pts.map(p => [p.id, p]));
      }
    } catch (e) { logger.debug('[PppoeFeed] odp lookup gagal: ' + (e.message || e)); }

    for (const c of rows) {
      const key = String(c.pppoe_username || '').trim().toLowerCase();
      if (!key) continue;
      const odpPt = c.infra_parent_id ? odpMap.get(c.infra_parent_id) : null;
      map.set(key, {
        customerName: c.name || '',
        customerId: c.customer_id || c.id,
        package: c.package || null,
        macDb: c.mac_address || c.ont_mac || '',
        odp: odpPt ? (odpPt.name || '') : '',
      });
    }
  } catch (e) {
    logger.debug('[PppoeFeed] enrich gagal: ' + (e.message || e));
  }
  return map;
}

// Kirim satu kartu (best-effort, log ke notif_logs via NotifLog kind='pppoe_feed').
async function _sendCard(cfg, text, meta) {
  const Telegram = require('./TelegramService');
  const target = (cfg.telegram_chat_pppoe_feed || '').trim();
  let res;
  try {
    res = target ? await Telegram.sendMessageTo(text, target, cfg) : await Telegram.sendMessage(text, cfg);
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  try {
    const { NotifLog } = require('../models');
    if (NotifLog) {
      const okCount = (res.results || []).filter(r => r.ok).length;
      await NotifLog.create({
        kind: 'pppoe_feed', event: meta.event, ref_id: meta.refId != null ? String(meta.refId) : null,
        title: meta.title || null, detail: meta.detail || null,
        chat_count: (res.results || []).length, ok_count: okCount,
        status: res.ok ? 'sent' : 'failed', error_message: res.ok ? null : (res.reason || res.error || 'gagal'),
      });
    }
  } catch (_) {}
  return res;
}

/**
 * runFeed(cfg) — dipanggil dari MonitoringService.runChecks() tiap siklus.
 * Mengambil /ppp/active per router, diff dengan snapshot lama, kirim kartu.
 */
async function runFeed(cfg) {
  if (String(cfg.telegram_pppoe_feed) !== '1') return;
  const Telegram = require('./TelegramService');
  if (!Telegram.isEnabled(cfg)) return;

  const { Device } = require('../models');
  const { getMikrotikInstanceByDevice, getMikrotikInstance } = require('./MikrotikService');

  // Router aktif. Kalau tak ada device router terdaftar, pakai instance default.
  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name', 'ip_address'],
      order: [['id', 'ASC']],
    });
  } catch (_) {}
  if (!routers.length) routers = [{ id: null, name: '', ip_address: '' }];

  const reportConnect = _enabledConnect(cfg);
  const reportLogout = _enabledLogout(cfg);
  const maxPerCycle = _maxPerCycle(cfg);
  let sentThisCycle = 0;

  for (const d of routers) {
    const rkey = _routerKey(d.id);
    let mt = null;
    try {
      mt = d.id != null ? await getMikrotikInstanceByDevice(d.id) : getMikrotikInstance();
    } catch (e) {
      logger.warn(`[PppoeFeed] Router ${rkey} tak terjangkau, skip: ${e.message}`);
      continue;
    }
    if (!mt) continue;

    // Snapshot sesi aktif sekarang.
    let sessions = [];
    try {
      sessions = await mt.getPPPoESessions();
    } catch (e) {
      logger.warn(`[PppoeFeed] gagal /ppp/active router ${rkey}: ${e.message}`);
      continue;
    }

    // Server name: identity router → fallback devices.name.
    let serverName = d.name || '';
    try {
      const id = await mt.getSystemIdentity();
      if (id && id.name) serverName = id.name;
    } catch (_) {}

    // Map username → sesi.
    const nowMap = new Map();
    for (const s of sessions) {
      const u = String(s.name || '').trim();
      if (u) nowMap.set(u.toLowerCase(), { address: s.address || '', callerID: s.callerID || '', uptime: s.uptime || '', user: u });
    }

    const totalActive = nowMap.size;

    // Baseline: siklus pertama untuk router ini → rekam saja, jangan kirim.
    const prevMap = _lastSnapshot.get(rkey) || new Map();
    if (!_seeded.has(rkey)) {
      _seeded.add(rkey);
      _lastSnapshot.set(rkey, nowMap);
      logger.info(`[PppoeFeed] baseline router ${rkey}: ${totalActive} sesi aktif`);
      continue;
    }

    // Hitung delta.
    const connected = []; // username baru
    const disconnected = []; // username hilang
    for (const [u, info] of nowMap) if (!prevMap.has(u)) connected.push({ u, info });
    for (const [u, info] of prevMap) if (!nowMap.has(u)) disconnected.push({ u, info });

    if (!connected.length && !disconnected.length) {
      _lastSnapshot.set(rkey, nowMap);
      continue;
    }

    // Total offline: pelanggan PPPoE terdaftar - yang aktif (best-effort).
    let totalOffline = 0;
    try {
      const { Customer } = require('../models');
      const { Op } = require('sequelize');
      const where = {
        status: 'active',
        pppoe_username: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
      };
      if (d.id != null) where.mikrotik_id = d.id;
      const totalRegistered = await Customer.count({ where });
      totalOffline = Math.max(0, totalRegistered - totalActive);
    } catch (_) {}

    // Enrich semua username yang berubah.
    const allUsers = [...connected, ...disconnected].map(x => x.info.user || x.u);
    const enrichMap = await _enrich(allUsers);

    const emit = async (kind, list) => {
      for (const { u, info } of list) {
        if (sentThisCycle >= maxPerCycle) {
          logger.warn(`[PppoeFeed] batas ${maxPerCycle} pesan/siklus tercapai — sisanya ditunda`);
          return;
        }
        const en = enrichMap.get(u) || {};
        const pkg = en.package;
        const mac = info.callerID || en.macDb || '';
        let lastLogout = '';
        if (kind === 'disconnect') {
          // Waktu sekarang sebagai perkiraan last logout (akurasi = interval poll).
          lastLogout = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'medium' });
        }
        const text = _buildCard(kind, {
          server: serverName,
          user: info.user || u,
          customerName: en.customerName || '',
          packageLabel: _speedLabel(pkg),
          odp: en.odp || '',
          ip: info.address || '',
          mac,
          uptime: info.uptime || '',
          lastLogout,
          totalActive,
          totalOffline,
        }, cfg);
        await _sendCard(cfg, text, {
          event: kind === 'connect' ? 'pppoe_connect' : 'pppoe_disconnect',
          refId: en.customerId || null,
          title: info.user || u,
          detail: (en.customerName || '') + (info.address ? ` · ${info.address}` : ''),
        });
        sentThisCycle++;
      }
    };

    if (reportConnect) await emit('connect', connected);
    if (reportLogout) await emit('disconnect', disconnected);

    // Simpan snapshot terbaru.
    _lastSnapshot.set(rkey, nowMap);
  }

  if (sentThisCycle) logger.info(`[PppoeFeed] ${sentThisCycle} kartu PPPoE terkirim`);
}

// Reset baseline (mis. saat setting feed baru diaktifkan via UI) → siklus
// berikutnya merekam ulang baseline tanpa membanjiri.
function reset() { _lastSnapshot.clear(); _seeded.clear(); }

// Kirim contoh kartu (tombol "Tes" di UI).
async function sendTestNotif(kind) {
  const Telegram = require('./TelegramService');
  const cfg = await Telegram._getConfig();
  if (!Telegram.isEnabled(cfg)) {
    return { ok: false, message: 'Telegram belum aktif (cek token, chat_id, dan toggle aktif).' };
  }
  const k = (kind === 'disconnect') ? 'disconnect' : 'connect';
  const sample = {
    server: 'ALGHOZALI', user: 'DWGjumadi', customerName: 'Jumadi',
    packageLabel: 'Upto 10Mbps', odp: 'ODP-Blok-C', ip: '11.6.8.7', mac: '14:00:7D:A7:E3:98',
    uptime: '00:00:12', lastLogout: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'short', timeStyle: 'medium' }),
    totalActive: 346, totalOffline: 12,
  };
  const text = '<i>[CONTOH]</i>\n' + _buildCard(k, sample, cfg);
  const target = (cfg.telegram_chat_pppoe_feed || '').trim();
  let res;
  try {
    res = target ? await Telegram.sendMessageTo(text, target, cfg) : await Telegram.sendMessage(text, cfg);
  } catch (e) { res = { ok: false, error: e.message }; }
  const okCount = (res.results || []).filter(r => r.ok).length;
  const total = (res.results || []).length;
  return { ok: !!res.ok, message: res.ok ? `Contoh kartu PPPoE ${k === 'connect' ? 'CONNECT' : 'DISCONNECT'} terkirim (${okCount}/${total} chat)` : 'Gagal mengirim contoh — cek konfigurasi.' };
}

module.exports = { runFeed, reset, sendTestNotif, FEED_TPL_DEFAULTS };
