'use strict';

/**
 * TelegramReportBackupController.js
 * ----------------------------------------------------------------------------
 * Endpoint untuk halaman /telegram/report & /telegram/backup.
 *
 * Report:
 *   GET  /telegram/report/config      muat setting tgreport_* + daftar blok + stat
 *   POST /telegram/report/save        simpan jadwal & opsi
 *   POST /telegram/report/preview     teks preview (tanpa kirim)
 *   POST /telegram/report/send-now    generate & kirim sekarang
 *
 * Backup:
 *   GET  /telegram/backup/config      muat setting tgbackup_* + daftar router + stat
 *   POST /telegram/backup/save        simpan jadwal & opsi
 *   POST /telegram/backup/run-now     backup router terpilih & kirim sekarang
 *
 * Semua setting di app_settings (prefix tgreport_ / tgbackup_). Tanpa migrasi DB.
 */

const { AppSetting } = require('../models');
const { Op } = require('sequelize');
const TGReport = require('../services/TelegramReportService');
const TGBackup = require('../services/TelegramBackupService');

// Whitelist key yang boleh disimpan dari masing-masing form.
const REPORT_KEYS = [
  'tgreport_enabled', 'tgreport_frequency', 'tgreport_period', 'tgreport_hour', 'tgreport_minute',
  'tgreport_day_of_week', 'tgreport_day_of_month', 'tgreport_chat_id',
  'tgreport_blocks', 'tgreport_template',
  'tgreport_compare', 'tgreport_show_button', 'tgreport_notify_fail',
];
const BACKUP_KEYS = [
  'tgbackup_enabled', 'tgbackup_frequency', 'tgbackup_hour', 'tgbackup_minute',
  'tgbackup_day_of_week', 'tgbackup_day_of_month', 'tgbackup_devices',
  'tgbackup_include_binary', 'tgbackup_chat_id', 'tgbackup_caption',
];

async function _loadByPrefix(prefix) {
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: prefix + '%' } } });
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  return cfg;
}
async function _saveKeys(keys, body) {
  let saved = 0;
  for (const key of keys) {
    if (body[key] === undefined) continue;
    await AppSetting.upsert({ key, value: String(body[key] ?? ''), type: 'string' });
    saved++;
  }
  return saved;
}

// Apakah Telegram global sudah punya token+chat (info untuk UI).
async function _telegramReady() {
  const t = await _loadByPrefix('telegram_');
  return {
    has_token: !!(t.telegram_bot_token || '').trim(),
    global_chat: (t.telegram_chat_id || '').trim(),
  };
}

module.exports = {
  // ── REPORT ────────────────────────────────────────────────────────
  async reportConfig(req, res) {
    try {
      const cfg = await _loadByPrefix('tgreport_');
      const tg = await _telegramReady();
      let history = [];
      try { history = await TGReport.getHistory(15); } catch (_) { history = []; }
      res.json({
        success: true,
        config: cfg,
        blocks: TGReport.BLOCKS,
        default_blocks: TGReport.DEFAULT_BLOCKS,
        extra_blocks: TGReport.EXTRA_BLOCKS,
        tg_limit: TGReport.TG_LIMIT,
        telegram: tg,
        history,
        last: {
          at: cfg.tgreport_last_at || null,
          status: cfg.tgreport_last_status || null,
          summary: cfg.tgreport_last_summary || null,
        },
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async reportSave(req, res) {
    try {
      const saved = await _saveKeys(REPORT_KEYS, req.body || {});
      res.json({ success: true, message: 'Pengaturan Telegram Report disimpan', saved });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async reportHistory(req, res) {
    try {
      const limit = parseInt(req.query.limit, 10) || 20;
      const history = await TGReport.getHistory(limit);
      res.json({ success: true, history });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async reportPreview(req, res) {
    try {
      const { blocks, template, frequency, period, compare } = req.body || {};
      const out = await TGReport.previewText({
        blocks: Array.isArray(blocks) ? blocks : undefined,
        template: template || '',
        frequency: frequency || 'daily',
        period: period || undefined,
        compare: compare != null ? !!compare : undefined,
      });
      res.json({ success: true, text: out.text, data: out.data, char_len: out.charLen, over_limit: out.overLimit });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async reportSendNow(req, res) {
    try {
      const { blocks, template, chat_id, frequency, period, compare, show_button, notify_fail } = req.body || {};
      const out = await TGReport.generateAndSend({
        blocks: Array.isArray(blocks) ? blocks : undefined,
        template: template || '',
        chatId: chat_id || '',
        frequency: frequency || 'daily',
        period: period || undefined,
        compare: compare != null ? !!compare : undefined,
        showButton: show_button != null ? !!show_button : undefined,
        notifyFail: notify_fail != null ? !!notify_fail : undefined,
        source: 'manual',
      });
      res.json({ success: out.ok, message: out.message, results: out.results || [], char_len: out.text ? out.text.length : 0 });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  // ── BACKUP ────────────────────────────────────────────────────────
  async backupConfig(req, res) {
    try {
      const cfg = await _loadByPrefix('tgbackup_');
      const tg = await _telegramReady();
      let routers = [];
      try { routers = await TGBackup.listRouters(); } catch (_) { routers = []; }
      res.json({
        success: true,
        config: cfg,
        routers,
        telegram: tg,
        last: {
          at: cfg.tgbackup_last_at || null,
          status: cfg.tgbackup_last_status || null,
          summary: cfg.tgbackup_last_summary || null,
        },
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async backupSave(req, res) {
    try {
      const saved = await _saveKeys(BACKUP_KEYS, req.body || {});
      res.json({ success: true, message: 'Pengaturan Telegram Backup disimpan', saved });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },

  async backupRunNow(req, res) {
    try {
      const { device_ids, include_binary, chat_id, caption } = req.body || {};
      const out = await TGBackup.runBackupAndSend({
        deviceIds: Array.isArray(device_ids) ? device_ids.map(Number).filter(Boolean) : undefined,
        includeBinary: include_binary != null ? !!include_binary : undefined,
        chatId: chat_id || '',
        caption: caption != null ? caption : undefined,
        manual: true,
      });
      res.json({ success: out.ok, message: out.message, results: out.results || [] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  },
};
