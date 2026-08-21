'use strict';

/**
 * DatabaseCleanupController.js
 * ─────────────────────────────────────────────────────────────────────
 * Manage retention policy untuk table-table high-volume.
 *
 * Endpoint:
 *   GET    /api/db-cleanup/overview            → ukuran & row count semua table
 *   GET    /api/db-cleanup/retention           → setting retention (hari) per table
 *   PUT    /api/db-cleanup/retention           → update setting retention
 *   POST   /api/db-cleanup/run/:table          → run cleanup manual untuk satu table
 *   POST   /api/db-cleanup/run-all             → run cleanup semua table sekarang
 *   GET    /api/db-cleanup/history             → riwayat cleanup terakhir
 *
 * Semua retention disimpan di app_settings dengan prefix `cleanup_retention_`
 * Contoh: cleanup_retention_traffic_data = "30"  (artinya 30 hari)
 *
 * Setting=0 berarti DISABLED (tidak pernah cleanup).
 * ─────────────────────────────────────────────────────────────────────
 */

const { Op }   = require('sequelize');
const moment   = require('moment');
const logger   = require('../utils/logger');
const {
  sequelize,
  AppSetting,
  TrafficData,
  QueueHistory,
  DeviceLog,
  TechnicianLocation,
  ActivityLog,
  Notification,
  WaLog,
  WaMessage,
  PushNotification,
} = require('../models');

// ─── Table registry ─────────────────────────────────────────────────
// Single source of truth: nama tabel, model, kolom timestamp, default retention,
// label untuk UI, kategori prioritas.
const TABLES = [
  {
    key:        'traffic_data',
    label:      'Traffic Data (Device)',
    description:'Data traffic per interface MikroTik. Sangat cepat tumbuh.',
    model:      TrafficData,
    timeField:  'recorded_at',
    defaultDays:30,
    priority:   'critical',
  },
  {
    key:        'queue_history',
    label:      'Queue History (Simple Queue)',
    description:'Riwayat rate per Simple Queue MikroTik per menit.',
    model:      QueueHistory,
    timeField:  'recorded_at',
    defaultDays:30,
    priority:   'critical',
  },
  {
    key:        'technician_locations',
    label:      'Lokasi GPS Teknisi',
    description:'Titik GPS teknisi setiap ~45 detik selama tracking aktif.',
    model:      TechnicianLocation,
    timeField:  'recorded_at',
    defaultDays:60,
    priority:   'critical',
  },
  {
    key:        'device_logs',
    label:      'Device Polling Log',
    description:'Log polling CPU/RAM/Uptime device.',
    model:      DeviceLog,
    timeField:  'polled_at',
    defaultDays:90,
    priority:   'medium',
  },
  {
    key:        'activity_logs',
    label:      'Activity Log (Audit)',
    description:'Audit trail aktivitas user (login, edit, delete).',
    model:      ActivityLog,
    timeField:  'created_at',
    defaultDays:180,
    priority:   'medium',
  },
  {
    key:        'notifications',
    label:      'Notifikasi In-App',
    description:'Notifikasi internal untuk admin/teknisi.',
    model:      Notification,
    timeField:  'created_at',
    defaultDays:60,
    priority:   'medium',
  },
  {
    key:        'wa_logs',
    label:      'WhatsApp Log Kirim',
    description:'Log pengiriman WA (reminder, broadcast, OTP).',
    model:      WaLog,
    timeField:  'sent_at',
    defaultDays:90,
    priority:   'medium',
  },
  {
    key:        'wa_messages',
    label:      'WhatsApp Messages (Inbox/Outbox)',
    description:'Riwayat pesan WA in/out + auto-reply.',
    model:      WaMessage,
    timeField:  'created_at',
    defaultDays:90,
    priority:   'low',
  },
  {
    key:        'isolir_logs',
    label:      'Log Isolir/Restore',
    description:'Riwayat aksi isolir & restore customer.',
    model:      null,  // model belum ada, pakai raw query
    rawTable:   'isolir_logs',
    timeField:  'created_at',
    defaultDays:365,
    priority:   'low',
  },
  {
    key:        'push_notifications',
    label:      'Push Notification History',
    description:'Riwayat push notification yang sudah terkirim.',
    model:      PushNotification,
    timeField:  'created_at',
    defaultDays:90,
    priority:   'low',
  },
];

const BATCH_SIZE = 5000; // delete per batch supaya tidak lock table besar

// ─── Helpers ────────────────────────────────────────────────────────
async function getRetentionDays(tableKey) {
  const setting = await AppSetting.findOne({
    where: { key: `cleanup_retention_${tableKey}` }
  });
  if (!setting) {
    const def = TABLES.find(t => t.key === tableKey)?.defaultDays || 30;
    return def;
  }
  const v = parseInt(setting.value, 10);
  return isNaN(v) ? 30 : v;
}

async function setRetentionDays(tableKey, days) {
  const value = String(parseInt(days, 10));
  const [setting, created] = await AppSetting.findOrCreate({
    where:    { key: `cleanup_retention_${tableKey}` },
    defaults: { key: `cleanup_retention_${tableKey}`, value, type: 'number',
                description: `Hari retention untuk table ${tableKey}` },
  });
  if (!created) await setting.update({ value });
  return setting;
}

/**
 * Batch delete: hapus per BATCH_SIZE row supaya tidak lock table besar.
 * Return total deleted.
 *
 * PENTING: Pakai RAW SQL untuk SEMUA mode (model maupun rawTable).
 * Alasan: Sequelize 6.x `Model.destroy({ where, limit })` punya 2 issue di MySQL:
 *   1. `limit` di-ignore untuk InnoDB → potensi DELETE 12 juta row sekaligus → lock & hang
 *   2. Kadang destroy() return 0 padahal WHERE valid (silent failure)
 * Raw SQL lebih predictable & cepat untuk DELETE besar.
 */
async function batchDelete(config, cutoff) {
  let totalDeleted   = 0;
  let lastBatchCount = 0;

  // Normalisasi: model mode atau rawTable mode → pakai nama tabel dari model
  const tableName = config.model
    ? (config.model.getTableName?.() || config.model.tableName)
    : config.rawTable;
  const timeField = config.timeField;

  if (!tableName) throw new Error('Table name tidak terdeteksi dari config');

  // BATCH_SIZE di-inline langsung jadi integer ke SQL — bukan via replacements,
  // karena Sequelize sering quote LIMIT param jadi string yg bikin MySQL error
  const limitInt = parseInt(BATCH_SIZE, 10);

  do {
    const [result] = await sequelize.query(
      `DELETE FROM \`${tableName}\`
       WHERE \`${timeField}\` < :cutoff
       LIMIT ${limitInt}`,
      { replacements: { cutoff } }   // Date object → Sequelize handle binding sesuai config timezone
    );
    lastBatchCount = result?.affectedRows || 0;
    totalDeleted  += lastBatchCount;

    // Brief pause antar batch supaya MySQL napas (release lock sebentar)
    if (lastBatchCount >= limitInt) {
      await new Promise(r => setTimeout(r, 100));
    }
  } while (lastBatchCount >= limitInt);

  return totalDeleted;
}

/**
 * Count rows matching cutoff — untuk preview "berapa yang akan dihapus".
 */
async function countOldRows(config, cutoff) {
  const tableName = config.model
    ? (config.model.getTableName?.() || config.model.tableName)
    : config.rawTable;

  const [rows] = await sequelize.query(
    `SELECT COUNT(*) AS cnt FROM \`${tableName}\`
     WHERE \`${config.timeField}\` < :cutoff`,
    { replacements: { cutoff } }
  );
  return parseInt(rows[0]?.cnt || 0, 10);
}

/**
 * Get ukuran table dari information_schema.
 * Return: { rows, dataMB, indexMB, totalMB }
 */
/**
 * Get ukuran table dari information_schema + COUNT real.
 *
 * Catatan penting MySQL InnoDB:
 *   - `TABLE_ROWS` di information_schema adalah PERKIRAAN dari statistik index,
 *     dan sering inakurat (atau 0) sampai `ANALYZE TABLE` dijalankan.
 *   - Untuk row count akurat → pakai `SELECT COUNT(*)` (sedikit lebih lambat
 *     tapi reliable). Untuk table > 1 juta row, ini bisa lambat — tapi tidak
 *     masalah karena overview hanya dipanggil saat user buka halaman.
 *   - Untuk size (DATA_LENGTH/INDEX_LENGTH) — biasanya akurat, tapi kalau
 *     0 di table yang BARU SAJA punya data, perlu ANALYZE TABLE dulu untuk
 *     refresh statistik.
 *
 * Return: { rows, dataMB, indexMB, totalMB }
 */
async function getTableStats(tableName, opts = {}) {
  const stats = { rows: 0, dataMB: 0, indexMB: 0, totalMB: 0 };

  // 1) Real row count via SELECT COUNT(*)
  try {
    const [cntRows] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM \`${tableName}\``
    );
    stats.rows = parseInt(cntRows[0]?.cnt || 0, 10);
  } catch (e) {
    logger.warn(`getTableStats(${tableName}) count error: ${e.message}`);
  }

  // 2) Size dari information_schema. Kalau opts.refresh=true, jalankan
  //    ANALYZE TABLE dulu untuk refresh statistik (lebih akurat tapi
  //    sedikit lock ringan — hanya dipakai user via tombol Refresh).
  try {
    if (opts.refresh) {
      try { await sequelize.query(`ANALYZE TABLE \`${tableName}\``); }
      catch (_) { /* abaikan kalau gagal */ }
    }

    const [rows] = await sequelize.query(
      `SELECT
         ROUND((DATA_LENGTH  / 1024 / 1024), 2) AS dataMB,
         ROUND((INDEX_LENGTH / 1024 / 1024), 2) AS indexMB,
         ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS totalMB
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = :table`,
      { replacements: { table: tableName } }
    );
    const r = rows[0] || {};
    stats.dataMB  = parseFloat(r.dataMB  || 0);
    stats.indexMB = parseFloat(r.indexMB || 0);
    stats.totalMB = parseFloat(r.totalMB || 0);
  } catch (e) {
    logger.warn(`getTableStats(${tableName}) size error: ${e.message}`);
  }

  return stats;
}

// ─── Single cleanup runner ──────────────────────────────────────────
// Dipanggil oleh manual trigger DAN oleh cron job.
async function runCleanupForTable(tableKey) {
  const config = TABLES.find(t => t.key === tableKey);
  if (!config) throw new Error(`Table ${tableKey} tidak terdaftar`);

  const days = await getRetentionDays(tableKey);
  if (days <= 0) {
    return { skipped: true, reason: 'disabled (days=0)', deleted: 0 };
  }

  const cutoff  = moment().subtract(days, 'days').toDate();
  const startAt = Date.now();

  let deleted = 0;
  let error   = null;

  try {
    deleted = await batchDelete(config, cutoff);
  } catch (e) {
    error = e.message;
    logger.error(`[Cleanup] ${tableKey} ERROR: ${e.message}\n${e.stack}`);
  }

  const tookMs = Date.now() - startAt;

  // Save last cleanup info (termasuk error kalau ada — visible di UI)
  const lastInfo = { at: new Date().toISOString(), deleted, tookMs, days };
  if (error) lastInfo.error = error;

  await AppSetting.findOrCreate({
    where:    { key: `cleanup_last_${tableKey}` },
    defaults: {
      key: `cleanup_last_${tableKey}`, type: 'json',
      value: JSON.stringify(lastInfo),
    },
  }).then(async ([s, created]) => {
    if (!created) await s.update({ value: JSON.stringify(lastInfo) });
  });

  if (error) {
    // Re-throw supaya controller bisa balikan 500 ke client
    throw new Error(error);
  }

  logger.info(`[Cleanup] ${tableKey}: deleted ${deleted} rows (>${days}d, took ${tookMs}ms)`);
  return { skipped: false, deleted, days, cutoff, tookMs };
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLLERS
// ═══════════════════════════════════════════════════════════════════

// GET /api/db-cleanup/overview?refresh=1
// → tampilkan ukuran tiap table + retention + last cleanup info
//   refresh=1 → jalankan ANALYZE TABLE dulu untuk refresh statistik
//   (lebih akurat, lebih lambat). Default: pakai statistik existing.
exports.overview = async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const rows = [];
    let totalMB = 0;

    // Parallel fetch stats untuk semua table (lebih cepat dari serial)
    const allStats = await Promise.all(
      TABLES.map(t => getTableStats(t.key, { refresh }))
    );

    for (let i = 0; i < TABLES.length; i++) {
      const t     = TABLES[i];
      const stats = allStats[i];
      const days  = await getRetentionDays(t.key);

      // Last cleanup info
      let lastCleanup = null;
      const lastSetting = await AppSetting.findOne({
        where: { key: `cleanup_last_${t.key}` }
      });
      if (lastSetting && lastSetting.value) {
        try { lastCleanup = JSON.parse(lastSetting.value); } catch (_) {}
      }

      // Hitung row yang akan dihapus kalau cleanup dijalankan sekarang
      let purgeable = 0;
      if (days > 0) {
        const cutoff = moment().subtract(days, 'days').toDate();
        try { purgeable = await countOldRows(t, cutoff); }
        catch (_) {}
      }

      rows.push({
        key:         t.key,
        label:       t.label,
        description: t.description,
        priority:    t.priority,
        timeField:   t.timeField,
        stats,
        retentionDays: days,
        defaultDays:   t.defaultDays,
        purgeable,
        lastCleanup,
      });

      totalMB += parseFloat(stats.totalMB || 0);
    }

    res.json({
      success: true,
      tables:  rows,
      summary: {
        tableCount: rows.length,
        totalMB:    Math.round(totalMB * 100) / 100,
        purgeableTotal: rows.reduce((sum, r) => sum + r.purgeable, 0),
      },
    });
  } catch (e) {
    logger.error('db-cleanup overview error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/db-cleanup/retention
exports.getRetention = async (req, res) => {
  try {
    const config = {};
    for (const t of TABLES) {
      config[t.key] = await getRetentionDays(t.key);
    }
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// PUT /api/db-cleanup/retention   { config: { traffic_data: 30, ... } }
exports.updateRetention = async (req, res) => {
  try {
    const cfg = req.body?.config || {};
    const allowed = TABLES.map(t => t.key);
    const updated = {};

    for (const [key, days] of Object.entries(cfg)) {
      if (!allowed.includes(key)) continue;
      const d = parseInt(days, 10);
      if (isNaN(d) || d < 0 || d > 3650) continue;  // max 10 tahun
      await setRetentionDays(key, d);
      updated[key] = d;
    }

    res.json({ success: true, updated, message: 'Setting retention berhasil disimpan' });
  } catch (e) {
    logger.error('updateRetention error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/db-cleanup/run/:table
exports.runOne = async (req, res) => {
  try {
    const result = await runCleanupForTable(req.params.table);
    res.json({ success: true, table: req.params.table, ...result });
  } catch (e) {
    logger.error('runOne error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/db-cleanup/run-all
exports.runAll = async (req, res) => {
  try {
    const results = {};
    let totalDeleted = 0;
    for (const t of TABLES) {
      try {
        const r = await runCleanupForTable(t.key);
        results[t.key] = r;
        totalDeleted += (r.deleted || 0);
      } catch (e) {
        results[t.key] = { error: e.message };
      }
    }
    res.json({ success: true, totalDeleted, results });
  } catch (e) {
    logger.error('runAll error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/db-cleanup/diagnose/:table
// Endpoint debug: tampilkan query yang akan dijalankan + data sample
// untuk troubleshoot kalau cleanup tidak bekerja sesuai harapan.
exports.diagnose = async (req, res) => {
  try {
    const tableKey = req.params.table;
    const config = TABLES.find(t => t.key === tableKey);
    if (!config) return res.status(404).json({ success: false, message: 'Table tidak terdaftar' });

    const days = await getRetentionDays(tableKey);
    const cutoff = moment().subtract(days, 'days').toDate();
    const tableName = config.model
      ? (config.model.getTableName?.() || config.model.tableName)
      : config.rawTable;

    // Total row, oldest & newest record, count of purgeable
    const [[total]] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM \`${tableName}\``
    );
    const [[oldest]] = await sequelize.query(
      `SELECT MIN(\`${config.timeField}\`) AS dt FROM \`${tableName}\``
    );
    const [[newest]] = await sequelize.query(
      `SELECT MAX(\`${config.timeField}\`) AS dt FROM \`${tableName}\``
    );
    const [[purgeable]] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM \`${tableName}\` WHERE \`${config.timeField}\` < :cutoff`,
      { replacements: { cutoff } }
    );

    // Sample 3 oldest rows
    const [samples] = await sequelize.query(
      `SELECT * FROM \`${tableName}\` ORDER BY \`${config.timeField}\` ASC LIMIT 3`
    );

    res.json({
      success: true,
      table:        tableKey,
      tableName,
      timeField:    config.timeField,
      retentionDays: days,
      cutoff:       cutoff.toISOString(),
      cutoffLocal:  moment(cutoff).format('YYYY-MM-DD HH:mm:ss'),
      serverTime:   new Date().toISOString(),
      stats: {
        total:     parseInt(total.cnt, 10),
        oldest:    oldest.dt,
        newest:    newest.dt,
        purgeable: parseInt(purgeable.cnt, 10),
      },
      samples,
      generatedSql: `DELETE FROM \`${tableName}\` WHERE \`${config.timeField}\` < '${moment(cutoff).utc().format('YYYY-MM-DD HH:mm:ss')}' LIMIT ${5000}`,
    });
  } catch (e) {
    logger.error('diagnose error: ' + e.message);
    res.status(500).json({ success: false, message: e.message, stack: e.stack });
  }
};

// GET /api/db-cleanup/history
exports.history = async (req, res) => {
  try {
    const history = {};
    for (const t of TABLES) {
      const setting = await AppSetting.findOne({
        where: { key: `cleanup_last_${t.key}` }
      });
      if (setting && setting.value) {
        try { history[t.key] = JSON.parse(setting.value); }
        catch (_) { history[t.key] = null; }
      }
    }
    res.json({ success: true, history });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─── Export untuk CronService ───────────────────────────────────────
// Cron tinggal panggil exports.runCleanupForTable(tableKey)
// supaya logic-nya konsisten dengan manual run.
exports.runCleanupForTable = runCleanupForTable;
exports.TABLES = TABLES;
