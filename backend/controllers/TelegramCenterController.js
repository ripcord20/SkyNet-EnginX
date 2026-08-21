/**
 * TelegramCenterController.js
 * ----------------------------------------------------------------------------
 * Endpoint khusus halaman "Telegram Center" (/telegram) — pusat kelola Telegram
 * yang sebelumnya hanya ada di Settings → Telegram.
 *
 * Tanggung jawab:
 *   - config()         : muat seluruh setting telegram_* + template default + stat
 *   - save()           : simpan koneksi, toggle notif, interval, & 8 template
 *   - test()           : getMe + kirim pesan tes (delegasi ke TelegramService)
 *   - runChecks()      : trigger manual pengecekan monitoring
 *   - sendCustom()     : kirim pesan bebas ke chat_id (uji format / pengumuman)
 *
 * Semua setting disimpan di tabel app_settings (key-value), identik dengan yang
 * dipakai TelegramService & MonitoringService — jadi halaman ini & Settings
 * lama tetap konsisten (sumber data sama).
 */

const { AppSetting, sequelize } = require('../models');
const { Op } = require('sequelize');

// Daftar key yang dikelola halaman ini. Dipakai untuk load & whitelist save.
const TG_KEYS = [
  'telegram_enabled', 'telegram_bot_token', 'telegram_chat_id',
  'telegram_notif_device', 'telegram_notif_ont', 'telegram_notif_ip', 'telegram_notif_pppoe',
  // Network health (infrastruktur inti)
  'telegram_notif_router', 'telegram_notif_resource', 'telegram_notif_iface',
  'telegram_cpu_threshold', 'telegram_mem_threshold',
  'telegram_alert_offline', 'telegram_alert_offline_threshold', 'telegram_chat_alert',
  'telegram_tpl_alert_offline', 'telegram_tpl_alert_offline_ok',
  'telegram_iface_keywords', 'telegram_iface_all',
  'telegram_chat_router', 'telegram_chat_resource', 'telegram_chat_iface',
  // Feed PPPoE connect/disconnect (gaya kartu)
  'telegram_pppoe_feed', 'telegram_pppoe_feed_connect', 'telegram_pppoe_feed_logout',
  'telegram_pppoe_feed_max', 'telegram_chat_pppoe_feed',
  'telegram_interval',
  'telegram_flap_guard', 'telegram_group_threshold',
  'telegram_quiet_enabled', 'telegram_quiet_start', 'telegram_quiet_end',
  'telegram_bot_enabled', 'telegram_bot_allow_control', 'telegram_chat_admin',
  'telegram_summary_enabled', 'telegram_summary_hour',
  'telegram_chat_device', 'telegram_chat_ont', 'telegram_chat_ip', 'telegram_chat_pppoe',
  'telegram_chat_event',
  'telegram_evt_payment', 'telegram_evt_newcust', 'telegram_evt_ticket', 'telegram_evt_voucher',
  'telegram_tpl_device_down', 'telegram_tpl_device_recover',
  'telegram_tpl_ont_down', 'telegram_tpl_ont_recover',
  'telegram_tpl_ip_down', 'telegram_tpl_ip_recover',
  'telegram_tpl_pppoe_down', 'telegram_tpl_pppoe_recover',
  'telegram_tpl_router_down', 'telegram_tpl_router_recover',
  'telegram_tpl_resource_down', 'telegram_tpl_resource_recover',
  'telegram_tpl_iface_down', 'telegram_tpl_iface_recover',
  'telegram_tpl_pppoe_connect', 'telegram_tpl_pppoe_disconnect',
];

// Sentinel: frontend mengirim nilai ini bila token TIDAK diubah (tetap
// memakai token tersimpan). Mencegah token utuh bolak-balik ke browser.
const TOKEN_MASK_SENTINEL = '__UNCHANGED__';

// Masking token untuk dikirim ke UI: tampilkan ujung saja.
function _maskToken(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 2) + '••••';
  return s.slice(0, 6) + '••••••' + s.slice(-4);
}

// Key template → di-loop saat hitung "template terisi".
const TPL_KEYS = [
  'device_down', 'device_recover', 'ont_down', 'ont_recover',
  'ip_down', 'ip_recover', 'pppoe_down', 'pppoe_recover',
  'pppoe_connect', 'pppoe_disconnect',
];

async function _loadCfg() {
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'telegram_%' } } });
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  return cfg;
}

function _interval(cfg) {
  const n = parseInt(cfg.telegram_interval, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

module.exports = {
  /**
   * GET /telegram/config
   * Kembalikan: { config, defaults, stats }
   *   config   = nilai telegram_* tersimpan (string)
   *   defaults = TPL_DEFAULTS dari MonitoringService (placeholder editor)
   *   stats    = ringkasan utk stat strip
   */
  async config(req, res) {
    try {
      const cfg = await _loadCfg();

      let defaults = {};
      try {
        const mon = require('../services/MonitoringService');
        defaults = { ...(mon.TPL_DEFAULTS || {}) };
      } catch (_) { defaults = {}; }
      try { Object.assign(defaults, require('../services/NetworkHealthService').TPL_DEFAULTS || {}); } catch (_) {}
      try { Object.assign(defaults, require('../services/PppoeFeedService').FEED_TPL_DEFAULTS || {}); } catch (_) {}
      try { Object.assign(defaults, require('../services/ThresholdAlertService').TPL_DEFAULTS || {}); } catch (_) {}

      // Hitung statistik ringan untuk stat strip.
      const notifOn = ['device', 'ont', 'ip', 'pppoe']
        .filter(k => String(cfg['telegram_notif_' + k]) === '1').length;
      const tplFilled = TPL_KEYS
        .filter(k => (cfg['telegram_tpl_' + k] || '').trim() !== '').length;
      const chatCount = String(cfg.telegram_chat_id || '')
        .split(',').map(s => s.trim()).filter(Boolean).length;

      const tokenRaw = (cfg.telegram_bot_token || '').trim();
      const enabled = String(cfg.telegram_enabled) === '1'
        && !!tokenRaw
        && !!(cfg.telegram_chat_id || '').trim();

      // JANGAN kirim token utuh ke browser. Ganti dgn versi mask; frontend
      // mengirim sentinel saat menyimpan bila token tidak diubah.
      const safeCfg = { ...cfg };
      if (tokenRaw) safeCfg.telegram_bot_token = TOKEN_MASK_SENTINEL;

      // Riwayat notifikasi (best-effort).
      let history = [];
      try { history = await require('../services/MonitoringService').getHistory(100); } catch (_) {}

      // Status bot 2-arah (loop hidup?).
      let botRunning = false;
      try { botRunning = require('../services/TelegramBotService').isRunning(); } catch (_) {}

      res.json({
        success: true,
        config: safeCfg,
        token_set: !!tokenRaw,
        token_masked: _maskToken(tokenRaw),
        defaults,
        history,
        bot_running: botRunning,
        stats: {
          enabled,
          notif_active: notifOn,
          notif_total: 4,
          tpl_filled: tplFilled,
          tpl_total: TPL_KEYS.length,
          chat_count: chatCount,
          interval: _interval(cfg),
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/save
   * Body: subset dari TG_KEYS. Hanya key di whitelist yang disimpan.
   * Jika telegram_interval berubah → restart scheduler monitoring (tanpa restart app).
   */
  async save(req, res) {
    try {
      const body = req.body || {};
      const prevCfg = await _loadCfg();
      const prevInterval = _interval(prevCfg);

      let saved = 0;
      for (const key of TG_KEYS) {
        if (body[key] === undefined) continue;
        // Token tidak diubah (sentinel) → jangan timpa token tersimpan.
        if (key === 'telegram_bot_token' && String(body[key]) === TOKEN_MASK_SENTINEL) continue;
        await AppSetting.upsert({ key, value: String(body[key] ?? ''), type: 'string' });
        saved++;
      }

      // Terapkan interval baru ke scheduler monitoring bila tersedia & berubah.
      let intervalApplied = false;
      const newInterval = _interval(await _loadCfg());
      if (newInterval !== prevInterval) {
        try {
          const mon = require('../services/MonitoringService');
          if (typeof mon.restartScheduler === 'function') {
            await mon.restartScheduler();
            intervalApplied = true;
          }
        } catch (_) { /* scheduler dikendalikan CronService — abaikan bila tak ada */ }
      }

      // Bila feed PPPoE baru diaktifkan, reset baseline snapshot supaya siklus
      // berikutnya merekam ulang (tidak membanjiri kartu CONNECT saat pertama on).
      try {
        const wasOn = String(prevCfg.telegram_pppoe_feed) === '1';
        const nowOn = String((await _loadCfg()).telegram_pppoe_feed) === '1';
        if (nowOn && !wasOn) require('../services/PppoeFeedService').reset();
      } catch (_) {}

      res.json({
        success: true,
        message: 'Pengaturan Telegram berhasil disimpan' + (intervalApplied ? ' (interval diterapkan)' : ''),
        saved,
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/test
   * Simpan koneksi terkini (token/chat_id/enabled) lalu getMe + kirim pesan tes.
   */
  async test(req, res) {
    try {
      const body = req.body || {};
      const keys = ['telegram_bot_token', 'telegram_chat_id', 'telegram_enabled'];
      for (const k of keys) {
        if (body[k] !== undefined) {
          // Token sentinel → biarkan token tersimpan apa adanya.
          if (k === 'telegram_bot_token' && String(body[k]) === TOKEN_MASK_SENTINEL) continue;
          await AppSetting.upsert({ key: k, value: String(body[k] || ''), type: 'string' });
        }
      }
      const result = await require('../services/TelegramService').testConnection();
      res.json({ success: result.ok, message: result.message, bot: result.bot || null });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/run-checks
   * Trigger manual monitoring (reset baseline + cek semua). Notif terkirim bila
   * ada transisi status. Berguna untuk verifikasi tanpa menunggu cron.
   */
  async runChecks(req, res) {
    try {
      const out = await require('../services/MonitoringService').runChecksManual();
      res.json({ success: out.ok, ...out });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/send-custom
   * Body: { text }
   * Kirim pesan bebas (HTML) ke semua chat_id terdaftar. Untuk pengumuman /
   * uji render template manual.
   */
  async sendCustom(req, res) {
    try {
      const text = (req.body && req.body.text || '').trim();
      if (!text) return res.status(400).json({ success: false, message: 'Teks pesan kosong' });
      const result = await require('../services/TelegramService').sendMessage(text);
      if (!result.ok) {
        return res.json({ success: false, message: result.reason === 'disabled'
          ? 'Telegram belum aktif / token & chat_id belum lengkap'
          : (result.error || 'Gagal mengirim pesan') });
      }
      const okCount = (result.results || []).filter(r => r.ok).length;
      const total = (result.results || []).length;
      res.json({ success: true, message: `Pesan terkirim ke ${okCount}/${total} chat`, results: result.results });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * GET /telegram/history
   * Riwayat notifikasi monitoring (tab Riwayat).
   */
  async history(req, res) {
    try {
      const limit = parseInt(req.query.limit, 10) || 20;
      const history = await require('../services/MonitoringService').getHistory(limit);
      res.json({ success: true, history });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/test-notif
   * Body: { kind: 'device'|'ont'|'ip'|'pppoe' }
   * Kirim contoh notifikasi satu jenis (uji template tanpa menunggu kejadian).
   */
  async testNotif(req, res) {
    try {
      const kind = (req.body && req.body.kind || '').trim();
      if (!kind) return res.status(400).json({ success: false, message: 'Jenis notifikasi kosong' });
      let out;
      if (['router', 'resource', 'iface'].includes(kind)) {
        out = await require('../services/NetworkHealthService').sendTestNotif(kind);
      } else if (kind === 'pppoe_feed' || kind === 'pppoe_feed_connect') {
        out = await require('../services/PppoeFeedService').sendTestNotif('connect');
      } else if (kind === 'pppoe_feed_disconnect') {
        out = await require('../services/PppoeFeedService').sendTestNotif('disconnect');
      } else if (kind === 'alert_offline') {
        out = await require('../services/ThresholdAlertService').sendTestNotif();
      } else {
        out = await require('../services/MonitoringService').sendTestNotif(kind);
      }
      res.json({ success: out.ok, message: out.message });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * GET /telegram/templates-default
   * Default template bawaan (untuk tombol "Reset ke Default" di editor).
   */
  async templatesDefault(req, res) {
    try {
      const { TPL_DEFAULTS } = require('../services/MonitoringService');
      let extra = {};
      try { extra = require('../services/NetworkHealthService').TPL_DEFAULTS || {}; } catch (_) {}
      let feed = {};
      try { feed = require('../services/PppoeFeedService').FEED_TPL_DEFAULTS || {}; } catch (_) {}
      let alert = {};
      try { alert = require('../services/ThresholdAlertService').TPL_DEFAULTS || {}; } catch (_) {}
      res.json({ success: true, data: { ...(TPL_DEFAULTS || {}), ...extra, ...feed, ...alert } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * GET /telegram/bot-stats
   * Statistik penggunaan bot dari activity_logs (module=telegram_bot).
   */
  async botStats(req, res) {
    try {
      const { ActivityLog } = require('../models');
      const { Op, fn, col, literal } = require('sequelize');
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [todayCount, weekCount, topActions, recent] = await Promise.all([
        ActivityLog.count({ where: { module: 'telegram_bot', created_at: { [Op.gte]: startOfDay } } }),
        ActivityLog.count({ where: { module: 'telegram_bot', created_at: { [Op.gte]: since7 } } }),
        ActivityLog.findAll({
          where: { module: 'telegram_bot', created_at: { [Op.gte]: since7 } },
          attributes: ['action', [fn('COUNT', col('id')), 'cnt']],
          group: ['action'], order: [[literal('cnt'), 'DESC']], limit: 5, raw: true,
        }),
        ActivityLog.findAll({
          where: { module: 'telegram_bot' },
          attributes: ['action', 'description', 'user_agent', 'created_at'],
          order: [['created_at', 'DESC']], limit: 8, raw: true,
        }),
      ]);

      // Ekstrak chat ID dari user_agent "telegram-bot:chat=<id>".
      const recentMapped = recent.map(r => {
        const m = /chat=([\-0-9]+)/.exec(r.user_agent || '');
        return { action: r.action, description: r.description, chatId: m ? m[1] : null, at: r.created_at };
      });

      res.json({
        success: true,
        data: {
          today: todayCount, week: weekCount,
          topActions: topActions.map(t => ({ action: t.action, count: Number(t.cnt) })),
          recent: recentMapped,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * GET /telegram/detect-chats
   * Ambil chat ID yang baru berinteraksi dgn bot (via getUpdates).
   * Membantu admin menemukan chat ID untuk didaftarkan.
   */
  async detectChats(req, res) {
    try {
      const TGBot = require('../services/TelegramBotService');
      const chats = (typeof TGBot.getSeenChats === 'function') ? TGBot.getSeenChats() : [];
      res.json({ success: true, data: chats });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  /**
   * POST /telegram/summary-now
   * Kirim ringkasan harian SEKARANG (tanpa menunggu jadwal).
   */
  async summaryNow(req, res) {
    try {
      const TGBot = require('../services/TelegramBotService');
      const out = await TGBot.sendDailySummary();
      if (!out || !out.ok) {
        const reasonMap = {
          'telegram-disabled': 'Bot Telegram belum aktif. Aktifkan dulu di Koneksi Bot.',
          'no-chat-target': 'Chat ID admin / utama belum diisi.',
        };
        return res.json({ success: false, message: reasonMap[out && out.reason] || ('Gagal: ' + ((out && out.reason) || 'error')) });
      }
      res.json({ success: true, message: `Ringkasan harian terkirim ke ${out.sent}.` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
};
