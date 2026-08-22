'use strict';

/**
 * ThresholdAlertService.js — Alert AMBANG agregat (bukan per-event).
 * ─────────────────────────────────────────────────────────────────────────────
 * Tujuan: deteksi dini GANGGUAN MASSAL. Berbeda dari:
 *   - MonitoringService._checkPppoe → alarm per pelanggan (transition).
 *   - PppoeFeedService            → feed login/logout per user.
 *   - NetworkHealthService        → CPU/RAM & router unreachable PER ROUTER.
 *
 * Fitur di sini: hitung TOTAL PPPoE offline (semua router) = jumlah secret
 * aktif (tidak disabled) yang TIDAK punya sesi /ppp/active. Bila total offline
 * melewati ambang (telegram_alert_offline_threshold), kirim SATU alert ringkas
 * (indikasi POP/uplink down). Saat turun kembali di bawah ambang, kirim notif
 * pemulihan.
 *
 * ANTI-SPAM: pakai state crossing in-memory (_alerting). Alert hanya saat
 * naik melewati ambang (transisi false→true), recovery saat turun
 * (true→false). Tidak mengirim tiap siklus.
 *
 * Setting app_settings:
 *   telegram_alert_offline          0/1  — master on/off (default 0)
 *   telegram_alert_offline_threshold int — ambang offline (default 10)
 *   telegram_chat_alert             chatId tujuan (opsional; fallback chat utama)
 *   telegram_tpl_alert_offline      template (opsional)
 *   telegram_tpl_alert_offline_ok   template recovery (opsional)
 */

const logger = require('../utils/logger');

const TPL_DEFAULTS = {
  alert_offline:
    '<b>ALERT: PPPoE OFFLINE MASSAL</b>\n\n' +
    'Total offline : <b>{offline}</b> dari {total} user\n' +
    'Ambang        : {threshold}\n' +
    'Aktif         : {active}\n\n' +
    'Indikasi gangguan area / POP / uplink. Mohon dicek.\n' +
    '{waktu}',
  alert_offline_ok:
    '<b>PEMULIHAN: PPPoE offline kembali normal</b>\n\n' +
    'Total offline : <b>{offline}</b> (di bawah ambang {threshold})\n' +
    'Aktif         : {active}\n' +
    '{waktu}',
};

// State crossing in-memory.
let _alerting = false;

function reset() { _alerting = false; }

function _esc(s) {
  return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function _renderTpl(cfg, key, vars) {
  let tpl = (cfg['telegram_tpl_' + key] || '').trim() || TPL_DEFAULTS[key] || '';
  return tpl.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? _esc(vars[name]) : m);
}

function _nowStr() {
  try { return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }); }
  catch (_) { return new Date().toISOString(); }
}

/**
 * Hitung total PPPoE offline lintas router.
 * offline = secret aktif (tidak disabled) yang tidak ada di /ppp/active.
 */
async function _countOffline() {
  const { Device } = require('../models');
  const { getMikrotikInstanceByDevice } = require('./MikrotikService');

  let routers = [];
  try {
    routers = await Device.findAll({
      where: { type: 'router', is_active: true },
      attributes: ['id', 'name'],
    });
  } catch (e) { logger.warn('[ThresholdAlert] load router gagal: ' + e.message); return null; }
  if (!routers.length) routers = [{ id: null, name: '' }];

  let totalSecrets = 0, totalActive = 0;
  let anyOk = false;
  for (const d of routers) {
    try {
      const mt = await getMikrotikInstanceByDevice(d.id || null);
      const [secrets, sessions] = await Promise.all([mt.getPPPoESecrets(), mt.getPPPoESessions()]);
      const activeNames = new Set((sessions || []).map(s => String(s.name || '').trim().toLowerCase()).filter(Boolean));
      const enabledSecrets = (secrets || []).filter(s => !s.disabled);
      totalSecrets += enabledSecrets.length;
      totalActive += activeNames.size;
      anyOk = true;
    } catch (e) {
      logger.warn(`[ThresholdAlert] router ${d.name || d.id} gagal: ${e.message}`);
    }
  }
  if (!anyOk) return null; // semua router gagal → jangan alert (bukan outage user)
  const offline = Math.max(0, totalSecrets - totalActive);
  return { totalSecrets, totalActive, offline };
}

/**
 * runChecks(cfg) — dipanggil dari MonitoringService.runChecks() tiap siklus.
 */
async function runChecks(cfg) {
  if (String(cfg.telegram_alert_offline) !== '1') return;
  const Telegram = require('./TelegramService');
  if (!Telegram.isEnabled(cfg)) return;

  const threshold = (() => {
    const n = parseInt(cfg.telegram_alert_offline_threshold, 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })();

  const stat = await _countOffline();
  if (!stat) return; // data tidak bisa diambil → skip diam-diam

  const over = stat.offline >= threshold;
  const target = (cfg.telegram_chat_alert || '').trim();
  const send = async (text) => {
    try {
      return target ? await Telegram.sendMessageTo(text, target, cfg) : await Telegram.sendMessage(text, cfg);
    } catch (e) { logger.warn('[ThresholdAlert] kirim gagal: ' + e.message); return { ok: false }; }
  };

  if (over && !_alerting) {
    _alerting = true;
    const text = _renderTpl(cfg, 'alert_offline', {
      offline: stat.offline, total: stat.totalSecrets, active: stat.totalActive,
      threshold, waktu: _nowStr(),
    });
    await send(text);
    logger.info(`[ThresholdAlert] ALERT offline=${stat.offline} (ambang ${threshold})`);
  } else if (!over && _alerting) {
    _alerting = false;
    const text = _renderTpl(cfg, 'alert_offline_ok', {
      offline: stat.offline, total: stat.totalSecrets, active: stat.totalActive,
      threshold, waktu: _nowStr(),
    });
    await send(text);
    logger.info(`[ThresholdAlert] RECOVER offline=${stat.offline} (ambang ${threshold})`);
  }
}

/**
 * Test: kirim contoh alert (tanpa mengubah state crossing).
 */
async function sendTestNotif() {
  const Telegram = require('./TelegramService');
  const cfg = await Telegram._getConfig();
  if (!Telegram.isEnabled(cfg)) return { ok: false, message: 'Telegram belum aktif.' };
  const threshold = (() => { const n = parseInt(cfg.telegram_alert_offline_threshold, 10); return Number.isFinite(n) && n > 0 ? n : 10; })();
  const text = '<i>[CONTOH]</i>\n' + _renderTpl(cfg, 'alert_offline', {
    offline: threshold + 5, total: 350, active: 350 - (threshold + 5), threshold, waktu: _nowStr(),
  });
  const target = (cfg.telegram_chat_alert || '').trim();
  let res;
  try {
    res = target ? await Telegram.sendMessageTo(text, target, cfg) : await Telegram.sendMessage(text, cfg);
  } catch (e) { res = { ok: false, error: e.message }; }
  const okCount = (res.results || []).filter(r => r.ok).length;
  const total = (res.results || []).length;
  return { ok: !!res.ok, message: res.ok ? `Contoh alert terkirim (${okCount}/${total} chat)` : 'Gagal mengirim contoh — cek konfigurasi.' };
}

module.exports = { runChecks, reset, sendTestNotif, TPL_DEFAULTS };
