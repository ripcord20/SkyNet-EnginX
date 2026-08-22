'use strict';

/**
 * TelegramBackupService.js
 * ─────────────────────────────────────────────────────────────────────
 * Backup konfigurasi MikroTik lalu KIRIM file-nya ke Telegram sebagai
 * dokumen. Jadwal & opsi TERPISAH dari fitur backup-email (mtbackup_*),
 * disimpan di app_settings dengan prefix `tgbackup_`:
 *
 *   tgbackup_enabled        0/1   — scheduler aktif?
 *   tgbackup_frequency      daily | weekly | monthly
 *   tgbackup_hour           0-23  (default 3)
 *   tgbackup_minute         0-59  (default 0)
 *   tgbackup_day_of_week    0-6   (Minggu=0; untuk weekly)
 *   tgbackup_day_of_month   1-28  (untuk monthly)
 *   tgbackup_devices        CSV id device (kosong = semua router aktif)
 *   tgbackup_include_binary 0/1   — sertakan file .backup biner?
 *   tgbackup_chat_id        tujuan (multi, pisah koma). Kosong = telegram_chat_id global.
 *   tgbackup_caption        template caption. Placeholder: {router} {ip} {file}
 *                           {ukuran} {tanggal} {perusahaan}. Kosong = bawaan.
 *   tgbackup_last_run_key / tgbackup_last_at / tgbackup_last_status / tgbackup_last_summary
 *
 * Reuse MikrotikBackupService.backupDevice() untuk SSH/export — jadi logika
 * koneksi & file tidak diduplikasi. Kirim file via TelegramService.sendDocument
 * (native FormData, tanpa dependency tambahan). Limit Telegram: 50 MB/dokumen.
 *
 * Scheduler: CronService memanggil schedulerTick() tiap menit. Dedup harian.
 * ─────────────────────────────────────────────────────────────────────
 */

const moment = require('moment');
const logger = require('../utils/logger');

const fmtSize = (b) => {
  b = Number(b || 0);
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
};

async function getSetting(key, def = '') {
  const { AppSetting } = require('../models');
  const row = await AppSetting.findOne({ where: { key } });
  return (row && row.value != null && row.value !== '') ? row.value : def;
}
async function setSetting(key, value) {
  const { AppSetting } = require('../models');
  await AppSetting.upsert({ key, value: String(value == null ? '' : value), type: 'string' });
}

async function loadSettings() {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'tgbackup_%' } } });
  const raw = {};
  rows.forEach(r => { raw[r.key] = r.value; });
  return {
    enabled:        String(raw.tgbackup_enabled) === '1',
    frequency:      raw.tgbackup_frequency || 'daily',
    hour:           parseInt(raw.tgbackup_hour, 10) >= 0 ? parseInt(raw.tgbackup_hour, 10) : 3,
    minute:         parseInt(raw.tgbackup_minute, 10) >= 0 ? parseInt(raw.tgbackup_minute, 10) : 0,
    day_of_week:    parseInt(raw.tgbackup_day_of_week, 10) >= 0 ? parseInt(raw.tgbackup_day_of_week, 10) : 1,
    day_of_month:   parseInt(raw.tgbackup_day_of_month, 10) >= 1 ? parseInt(raw.tgbackup_day_of_month, 10) : 1,
    devices:        (raw.tgbackup_devices != null && raw.tgbackup_devices !== '')
                      ? String(raw.tgbackup_devices).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
                      : [],
    include_binary: String(raw.tgbackup_include_binary) === '1',
    chat_id:        raw.tgbackup_chat_id || '',
    caption:        raw.tgbackup_caption || '',
  };
}

function buildCaption(tpl, ctx) {
  const vars = {
    '{router}':     ctx.router || '',
    '{ip}':         ctx.ip || '',
    '{file}':       ctx.file || '',
    '{ukuran}':     ctx.ukuran || '',
    '{tanggal}':    ctx.tanggal || '',
    '{perusahaan}': ctx.perusahaan || '',
  };
  if (tpl && tpl.trim()) {
    return Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), tpl);
  }
  // Bawaan
  return `💾 <b>Backup ${vars['{router}']}</b>\n`
       + `IP: <code>${vars['{ip}']}</code>\n`
       + `File: ${vars['{file}']} (${vars['{ukuran}']})\n`
       + `${vars['{tanggal}']}`;
}

/**
 * Daftar router yang bisa dipilih (untuk UI) — type=router & aktif.
 */
async function listRouters() {
  const { Device } = require('../models');
  const rows = await Device.findAll({
    where: { type: 'router', is_active: true },
    attributes: ['id', 'name', 'ip_address'],
    order: [['name', 'ASC']],
  });
  return rows.map(r => ({ id: r.id, name: r.name, ip: r.ip_address }));
}

/**
 * runBackupAndSend({ deviceIds?, includeBinary?, chatId?, caption?, manual? })
 *   → { ok, message, results }
 * Backup router terpilih lalu kirim tiap file ke Telegram.
 */
async function runBackupAndSend(opts = {}) {
  const { Device } = require('../models');
  const MTBackup = require('./MikrotikBackupService');
  const Telegram = require('./TelegramService');

  const cfg = await loadSettings();
  const includeBinary = (opts.includeBinary != null) ? !!opts.includeBinary : cfg.include_binary;
  const caption = (opts.caption != null) ? opts.caption : cfg.caption;
  const chatId  = opts.chatId || cfg.chat_id || '';

  let companyName = 'ISP';
  try { companyName = (await require('../utils/companyInfo').getCompanyName()) || 'ISP'; } catch (_) {}

  // Tentukan device target.
  const ids = (opts.deviceIds && opts.deviceIds.length) ? opts.deviceIds
            : (cfg.devices && cfg.devices.length ? cfg.devices : null);
  const where = { type: 'router', is_active: true };
  if (ids) where.id = ids;
  const devices = await Device.findAll({ where, order: [['id', 'ASC']] });
  if (!devices.length) {
    return { ok: false, message: 'Tidak ada router aktif yang cocok untuk dibackup', results: [] };
  }

  // Cek koneksi Telegram di awal supaya pesan error jelas.
  if (!Telegram.isEnabled(await Telegram._getConfig())) {
    // isEnabled butuh telegram_enabled=1; tapi kirim tetap bisa kalau token+chat ada.
    const tcfg = await Telegram._getConfig();
    if (!(tcfg.telegram_bot_token || '').trim()) {
      return { ok: false, message: 'Bot token belum diisi (atur di Telegram Center)', results: [] };
    }
    if (!chatId && !(tcfg.telegram_chat_id || '').trim()) {
      return { ok: false, message: 'Tujuan chat belum diisi', results: [] };
    }
  }

  const results = [];
  const dateLabel = moment().format('D MMMM YYYY HH:mm');

  // ssh_port dipakai bersama dengan fitur backup-email (setting yang sama).
  const sshPort = parseInt(await getSetting('mtbackup_ssh_port', '22'), 10) || 22;

  for (const dev of devices) {
    const bk = await MTBackup.backupDevice(dev, { settings: { ssh_port: sshPort, include_binary: includeBinary } });
    const entry = { device_id: dev.id, device_name: dev.name, ip: dev.ip_address, ok: false, files: [], error: bk.error };

    if (!bk.ok || !bk.files.length) {
      entry.error = bk.error || 'Backup gagal / file kosong';
      results.push(entry);
      continue;
    }

    for (const f of bk.files) {
      const cap = buildCaption(caption, {
        router: dev.name, ip: dev.ip_address, file: f.filename,
        ukuran: fmtSize(f.size), tanggal: dateLabel, perusahaan: companyName,
      });
      const sent = await Telegram.sendDocument(f.path, { chatId, caption: cap, filename: f.filename });
      entry.files.push({
        filename: f.filename, size: f.size, type: f.type,
        sent: !!sent.ok, error: sent.ok ? null : (sent.error || sent.reason || 'gagal'),
      });
      if (sent.ok) entry.ok = true;
    }
    results.push(entry);
  }

  const okFiles = results.reduce((a, r) => a + r.files.filter(f => f.sent).length, 0);
  const totFiles = results.reduce((a, r) => a + r.files.length, 0);
  const okRouters = results.filter(r => r.ok).length;
  const message = `${okRouters}/${devices.length} router · ${okFiles}/${totFiles} file terkirim ke Telegram`;

  return { ok: okFiles > 0, message, results };
}

// ── Scheduler tick (dipanggil CronService tiap menit) ──────────────────
async function schedulerTick() {
  try {
    const cfg = await loadSettings();
    if (!cfg.enabled) return;

    const now = moment();
    if (now.hour() !== cfg.hour || now.minute() !== cfg.minute) return;
    if (cfg.frequency === 'weekly'  && now.day()  !== cfg.day_of_week)  return;
    if (cfg.frequency === 'monthly' && now.date() !== cfg.day_of_month) return;

    const runKey = now.format('YYYY-MM-DD');
    const lastKey = await getSetting('tgbackup_last_run_key', '');
    if (lastKey === runKey) return;
    await setSetting('tgbackup_last_run_key', runKey);

    logger.info(`[TGBackup] Scheduler trigger (${cfg.frequency} ${String(cfg.hour).padStart(2,'0')}:${String(cfg.minute).padStart(2,'0')})`);
    const result = await runBackupAndSend({});
    await setSetting('tgbackup_last_at', new Date().toISOString());
    await setSetting('tgbackup_last_status', result.ok ? 'ok' : 'failed');
    await setSetting('tgbackup_last_summary', result.message);
    logger.info('[TGBackup] Scheduler done: ' + result.message);
  } catch (e) {
    logger.error('[TGBackup] Scheduler error: ' + (e.message || e));
  }
}

module.exports = {
  loadSettings, getSetting, setSetting,
  listRouters, buildCaption, runBackupAndSend, schedulerTick,
};
