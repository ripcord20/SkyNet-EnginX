'use strict';

/**
 * BackupController.js
 * ─────────────────────────────────────────────────────────────────────
 * Manage backup MySQL database.
 *
 * Endpoint:
 *   GET    /api/backup/list             → daftar file backup
 *   POST   /api/backup/create           → buat backup baru (mysqldump atau native)
 *   GET    /api/backup/download/:file   → download file backup
 *   DELETE /api/backup/delete/:file     → hapus file backup
 *   GET    /api/backup/settings         → setting auto-backup
 *   PUT    /api/backup/settings         → update setting auto-backup
 *   GET    /api/backup/info             → info: mysqldump tersedia?, ukuran DB, dll
 *
 * Mode operasi:
 *   1. mysqldump CLI (preferred) — kalau mysqldump ada di PATH
 *      Cepat, output gzip langsung, kompatibel 100% MySQL.
 *   2. Native Node (fallback) — pakai Sequelize raw query
 *      Generate SQL manual, lebih lambat tapi tidak butuh CLI.
 *      Cocok kalau hosting tidak punya akses shell mysqldump.
 *
 * Setting tersimpan di app_settings (prefix `backup_`):
 *   - backup_auto_enabled       (0/1)
 *   - backup_auto_schedule      (cron expression, default "0 2 * * *" — jam 02:00)
 *   - backup_auto_retention     (jumlah file backup yang disimpan, default 7)
 *   - backup_auto_mode          ("auto" | "mysqldump" | "native")
 *
 * File backup disimpan di: <project>/backups/db/
 * Format nama: backup_YYYY-MM-DD_HHmmss.sql.gz
 * ─────────────────────────────────────────────────────────────────────
 */

const fs           = require('fs');
const path         = require('path');
const zlib         = require('zlib');
const { exec, spawn } = require('child_process');
const moment       = require('moment');
const logger       = require('../utils/logger');
const { sequelize, AppSetting } = require('../models');

// ─── Konfigurasi ────────────────────────────────────────────────────
const BACKUP_DIR = path.join(__dirname, '../../backups/db');

// Pastikan folder backup ada
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logger.info(`[Backup] Created backup dir: ${BACKUP_DIR}`);
  }
}

// ─── Helpers DB config ──────────────────────────────────────────────
function getDbConfig() {
  return {
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'isp_netops',
  };
}

// Cek apakah `mysqldump` tersedia di PATH
let _mysqldumpCached = null;
function isMysqldumpAvailable() {
  if (_mysqldumpCached !== null) return Promise.resolve(_mysqldumpCached);
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where mysqldump' : 'which mysqldump';
    exec(cmd, (err, stdout) => {
      _mysqldumpCached = !err && stdout && stdout.trim().length > 0;
      resolve(_mysqldumpCached);
    });
  });
}

// Cek apakah `mysql` (client) tersedia di PATH — dipakai untuk restore.
let _mysqlCached = null;
function isMysqlAvailable() {
  if (_mysqlCached !== null) return Promise.resolve(_mysqlCached);
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where mysql' : 'which mysql';
    exec(cmd, (err, stdout) => {
      _mysqlCached = !err && stdout && stdout.trim().length > 0;
      resolve(_mysqlCached);
    });
  });
}

// ─── Setting helpers ────────────────────────────────────────────────
async function getSetting(key, defaultVal) {
  const s = await AppSetting.findOne({ where: { key } });
  return s ? s.value : defaultVal;
}
async function setSetting(key, value, type='string') {
  const [s, created] = await AppSetting.findOrCreate({
    where: { key }, defaults: { key, value: String(value), type }
  });
  if (!created) await s.update({ value: String(value) });
  return s;
}

// ─── Mode 1: mysqldump CLI ──────────────────────────────────────────
// Spawn mysqldump, pipe ke gzip, simpan ke file.
function backupViaMysqldump(outPath) {
  return new Promise((resolve, reject) => {
    const cfg = getDbConfig();
    const args = [
      `-h${cfg.host}`,
      `-P${cfg.port}`,
      `-u${cfg.user}`,
      cfg.password ? `-p${cfg.password}` : '',
      '--single-transaction',
      '--quick',
      '--lock-tables=false',
      '--routines',
      '--triggers',
      '--events',
      '--default-character-set=utf8mb4',
      cfg.database,
    ].filter(Boolean);

    const dump = spawn('mysqldump', args);
    const gzip = zlib.createGzip();
    const out  = fs.createWriteStream(outPath);

    let stderr = '';
    dump.stderr.on('data', d => { stderr += d.toString(); });

    dump.stdout.pipe(gzip).pipe(out);

    out.on('finish', () => {
      // mysqldump warning soal password di stderr, bukan error fatal
      if (stderr && !stderr.toLowerCase().includes('using a password')) {
        logger.warn('[Backup] mysqldump stderr: ' + stderr.slice(0, 500));
      }
      resolve({ mode: 'mysqldump' });
    });

    dump.on('error', err => reject(new Error(`mysqldump spawn error: ${err.message}`)));
    dump.on('close', code => {
      if (code !== 0) reject(new Error(`mysqldump exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
    out.on('error',  err => reject(new Error(`write stream error: ${err.message}`)));
    gzip.on('error', err => reject(new Error(`gzip error: ${err.message}`)));
  });
}

// ─── Mode 2: Native Node ────────────────────────────────────────────
// Query semua table, generate SQL DDL + INSERT, gzip ke file.
async function backupViaNative(outPath) {
  const cfg = getDbConfig();
  const gzip = zlib.createGzip();
  const out  = fs.createWriteStream(outPath);
  gzip.pipe(out);

  const write = (text) => new Promise(r => gzip.write(text, r));

  // Header
  await write(`-- ──────────────────────────────────────────────────\n`);
  await write(`-- Backup database: ${cfg.database}\n`);
  await write(`-- Generated:       ${new Date().toISOString()}\n`);
  await write(`-- Mode:            Native Node (Sequelize)\n`);
  await write(`-- ──────────────────────────────────────────────────\n\n`);
  await write(`SET FOREIGN_KEY_CHECKS=0;\n`);
  await write(`SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";\n`);
  await write(`SET NAMES utf8mb4;\n\n`);

  // List tables
  const [tablesRaw] = await sequelize.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  const tables = tablesRaw.map(r => r.name || r.NAME || r.TABLE_NAME);

  for (const tbl of tables) {
    await write(`\n-- ────── Table: \`${tbl}\` ──────\n`);
    await write(`DROP TABLE IF EXISTS \`${tbl}\`;\n`);

    // DDL
    const [ddlRaw] = await sequelize.query(`SHOW CREATE TABLE \`${tbl}\``);
    const ddl = ddlRaw[0]?.['Create Table'] || ddlRaw[0]?.['CREATE TABLE'];
    if (ddl) await write(ddl + ';\n\n');

    // Data — chunk per 1000 row, hindari memory blow up
    const [{ 0: { cnt: rowCountRaw } }] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM \`${tbl}\``
    );
    const rowCount = parseInt(rowCountRaw, 10);
    if (rowCount === 0) continue;

    const CHUNK = 1000;
    for (let offset = 0; offset < rowCount; offset += CHUNK) {
      const [rows] = await sequelize.query(
        `SELECT * FROM \`${tbl}\` LIMIT ${CHUNK} OFFSET ${offset}`
      );
      if (!rows.length) break;

      const cols = Object.keys(rows[0]);
      const colsStr = cols.map(c => `\`${c}\``).join(',');

      // Insert dalam chunk 100 row supaya line tidak terlalu panjang
      const SUB = 100;
      for (let i = 0; i < rows.length; i += SUB) {
        const slice = rows.slice(i, i + SUB);
        const values = slice.map(row => {
          const parts = cols.map(c => formatSqlValue(row[c]));
          return `(${parts.join(',')})`;
        }).join(',\n  ');
        await write(`INSERT INTO \`${tbl}\` (${colsStr}) VALUES\n  ${values};\n`);
      }
    }
  }

  await write(`\nSET FOREIGN_KEY_CHECKS=1;\n`);
  await write(`-- Backup completed.\n`);

  // Close streams
  await new Promise((resolve, reject) => {
    gzip.end((err) => err ? reject(err) : resolve());
  });
  await new Promise((resolve) => out.on('finish', resolve));

  return { mode: 'native', tables: tables.length };
}

// Escape value untuk SQL VALUES
function formatSqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number')  return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date)      return `'${moment(v).format('YYYY-MM-DD HH:mm:ss')}'`;
  if (Buffer.isBuffer(v))     return `0x${v.toString('hex')}`;
  // String / object → escape backslash, single quote, NUL, newline, CR, control chars
  let s;
  if (typeof v === 'object') {
    try { s = JSON.stringify(v); } catch (_) { s = String(v); }
  } else {
    s = String(v);
  }
  s = s.replace(/\\/g, '\\\\')
       .replace(/'/g, "\\'")
       .replace(/\0/g, '\\0')
       .replace(/\n/g, '\\n')
       .replace(/\r/g, '\\r')
       .replace(/\x1a/g, '\\Z');
  return `'${s}'`;
}

// ─── Core: createBackup ─────────────────────────────────────────────
// preferredMode: "auto" | "mysqldump" | "native"
async function createBackup(preferredMode = 'auto') {
  ensureBackupDir();

  const filename = `backup_${moment().format('YYYY-MM-DD_HHmmss')}.sql.gz`;
  const outPath  = path.join(BACKUP_DIR, filename);

  let mode = preferredMode;
  if (mode === 'auto' || mode === 'mysqldump') {
    const hasMysqldump = await isMysqldumpAvailable();
    if (mode === 'auto') mode = hasMysqldump ? 'mysqldump' : 'native';
    else if (mode === 'mysqldump' && !hasMysqldump) {
      throw new Error('mysqldump tidak tersedia di PATH. Install MySQL client tools atau gunakan mode native.');
    }
  }

  const startAt = Date.now();
  let result;
  try {
    if (mode === 'mysqldump') {
      result = await backupViaMysqldump(outPath);
    } else {
      result = await backupViaNative(outPath);
    }
  } catch (err) {
    // Cleanup partial file kalau gagal
    if (fs.existsSync(outPath)) {
      try { fs.unlinkSync(outPath); } catch (_) {}
    }
    throw err;
  }
  const tookMs = Date.now() - startAt;

  // Get file size
  const stat = fs.statSync(outPath);
  const sizeMB = Math.round(stat.size / 1024 / 1024 * 100) / 100;

  // Save last backup info
  await setSetting('backup_last_at',     new Date().toISOString(), 'string');
  await setSetting('backup_last_file',   filename, 'string');
  await setSetting('backup_last_mode',   result.mode, 'string');
  await setSetting('backup_last_sizeMB', String(sizeMB), 'string');
  await setSetting('backup_last_tookMs', String(tookMs), 'string');

  logger.info(`[Backup] Created ${filename} (${sizeMB} MB, mode=${result.mode}, took ${tookMs}ms)`);
  return { filename, sizeMB, tookMs, mode: result.mode };
}

// ─── Pruning: hapus backup lama sesuai retention ────────────────────
async function pruneOldBackups(keepN) {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.sql.gz'))
    .map(f => ({
      name: f,
      path: path.join(BACKUP_DIR, f),
      mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (files.length <= keepN) return { deleted: 0, kept: files.length };

  const toDelete = files.slice(keepN);
  for (const f of toDelete) {
    try { fs.unlinkSync(f.path); }
    catch (e) { logger.warn(`[Backup] Failed to delete ${f.name}: ${e.message}`); }
  }
  logger.info(`[Backup] Pruned ${toDelete.length} old backup(s), kept ${keepN}`);
  return { deleted: toDelete.length, kept: keepN };
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLLERS
// ═══════════════════════════════════════════════════════════════════

// GET /api/backup/info
// ─── RESTORE: dari file .sql.gz / .sql ──────────────────────────────
// Mengembalikan teks SQL mentah dari path file (auto-decompress bila .gz).
async function readSqlFromFile(filePath) {
  const isGz = filePath.toLowerCase().endsWith('.gz');
  const raw = fs.readFileSync(filePath);
  if (isGz) {
    return new Promise((resolve, reject) => {
      zlib.gunzip(raw, (err, buf) => err ? reject(err) : resolve(buf.toString('utf8')));
    });
  }
  return raw.toString('utf8');
}

// Restore via mysql CLI (preferred): pipe SQL ke stdin `mysql`.
function restoreViaMysqlCli(sqlText) {
  return new Promise((resolve, reject) => {
    const cfg = getDbConfig();
    const args = [
      `-h${cfg.host}`, `-P${cfg.port}`, `-u${cfg.user}`,
      cfg.password ? `-p${cfg.password}` : '',
      '--default-character-set=utf8mb4',
      cfg.database,
    ].filter(Boolean);
    const proc = spawn('mysql', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => reject(new Error(`mysql spawn error: ${err.message}`)));
    proc.on('close', code => {
      if (code !== 0 && !(stderr && stderr.toLowerCase().includes('using a password') && code === 0)) {
        if (code !== 0) return reject(new Error(`mysql exited code ${code}: ${stderr.slice(0,500)}`));
      }
      resolve({ mode: 'mysql' });
    });
    proc.stdin.write(sqlText);
    proc.stdin.end();
  });
}

// Restore native: pecah SQL jadi statement, jalankan via sequelize.
// Sederhana tapi efektif untuk dump mysqldump standar. Mematikan FK checks
// selama proses agar urutan tabel tidak masalah.
async function restoreViaNative(sqlText) {
  // Buang baris komentar & delimiter khusus
  const lines = sqlText.split(/\r?\n/).filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith('--') || t.startsWith('#')) return false;
    if (t.startsWith('/*') && t.endsWith('*/;')) return false; // conditional comments
    if (/^DELIMITER/i.test(t)) return false;
    return true;
  });
  const cleaned = lines.join('\n');

  // Pecah berdasarkan ';' di akhir baris (cukup untuk INSERT/CREATE/DROP standar).
  const statements = cleaned
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  await sequelize.query('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const stmt of statements) {
      try { await sequelize.query(stmt); }
      catch (e) {
        // Lewati statement yang gagal tapi catat — restore tetap lanjut
        logger.warn('[Restore] statement gagal: ' + e.message.slice(0, 200));
      }
    }
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS=1');
  }
  return { mode: 'native', statements: statements.length };
}

async function restoreDatabase(sqlText, preferredMode = 'auto') {
  let mode = preferredMode;
  if (mode === 'auto' || mode === 'mysql') {
    const hasMysql = await isMysqlAvailable();
    if (mode === 'auto') mode = hasMysql ? 'mysql' : 'native';
    else if (mode === 'mysql' && !hasMysql) {
      throw new Error('mysql client tidak tersedia di PATH. Gunakan mode native.');
    }
  }
  if (mode === 'mysql') return restoreViaMysqlCli(sqlText);
  return restoreViaNative(sqlText);
}

exports.info = async (req, res) => {
  try {
    ensureBackupDir();
    const hasMysqldump = await isMysqldumpAvailable();
    const hasMysql = await isMysqlAvailable();

    // DB size
    const [rows] = await sequelize.query(
      `SELECT
         ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS totalMB,
         COUNT(*) AS tableCount
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()`
    );
    const dbStats = rows[0] || {};

    res.json({
      success: true,
      info: {
        backupDir:        BACKUP_DIR,
        hasMysqldump:     !!hasMysqldump,
        hasMysql:         !!hasMysql,
        recommendedMode:  hasMysqldump ? 'mysqldump' : 'native',
        dbSizeMB:         parseFloat(dbStats.totalMB || 0),
        dbTableCount:     parseInt(dbStats.tableCount || 0, 10),
        dbName:           getDbConfig().database,
      },
    });
  } catch (e) {
    logger.error('backup info error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/backup/list
exports.list = async (req, res) => {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.sql.gz'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          name:    f,
          sizeMB:  Math.round(st.size / 1024 / 1024 * 100) / 100,
          sizeKB:  Math.round(st.size / 1024),
          created: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    // Total size
    const totalMB = Math.round(files.reduce((s, f) => s + f.sizeMB, 0) * 100) / 100;

    res.json({ success: true, files, count: files.length, totalMB });
  } catch (e) {
    logger.error('backup list error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/backup/create  { mode?: 'auto' | 'mysqldump' | 'native' }
exports.create = async (req, res) => {
  try {
    const mode = req.body?.mode || 'auto';
    if (!['auto', 'mysqldump', 'native'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'mode tidak valid' });
    }
    const result = await createBackup(mode);
    res.json({ success: true, ...result, message: `Backup berhasil: ${result.filename}` });
  } catch (e) {
    logger.error('backup create error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// GET /api/backup/download/:file
exports.download = async (req, res) => {
  try {
    const file = req.params.file;
    // Whitelist: only allow expected backup filename pattern
    if (!/^backup_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/.test(file)) {
      return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
    }
    const fp = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(fp)) {
      return res.status(404).json({ success: false, message: 'File tidak ditemukan' });
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    logger.error('backup download error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// DELETE /api/backup/delete/:file
exports.deleteFile = async (req, res) => {
  try {
    const file = req.params.file;
    if (!/^backup_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/.test(file)) {
      return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
    }
    const fp = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(fp)) {
      return res.status(404).json({ success: false, message: 'File tidak ditemukan' });
    }
    fs.unlinkSync(fp);
    logger.info(`[Backup] Deleted ${file} by user`);
    res.json({ success: true, message: 'File backup dihapus' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// POST /api/backup/restore
// Dua sumber: (a) file di-upload (multipart, field "file"), atau
// (b) { file: "backup_xxx.sql.gz" } merestore backup yang sudah ada di server.
// PERINGATAN: menimpa seluruh database. Hanya superadmin.
exports.restore = async (req, res) => {
  let tempPath = null;
  try {
    ensureBackupDir();
    let sqlText = null;
    let sourceLabel = '';

    if (req.file) {
      // Upload file
      const orig = (req.file.originalname || '').toLowerCase();
      if (!orig.endsWith('.sql') && !orig.endsWith('.sql.gz') && !orig.endsWith('.gz')) {
        return res.status(400).json({ success: false, message: 'Format file harus .sql atau .sql.gz' });
      }
      tempPath = req.file.path;
      sqlText = await readSqlFromFile(tempPath);
      sourceLabel = req.file.originalname;
    } else if (req.body && req.body.file) {
      // Restore dari backup yang sudah ada
      const file = req.body.file;
      if (!/^backup_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/.test(file)) {
        return res.status(400).json({ success: false, message: 'Nama file backup tidak valid' });
      }
      const fp = path.join(BACKUP_DIR, file);
      if (!fs.existsSync(fp)) {
        return res.status(404).json({ success: false, message: 'File backup tidak ditemukan di server' });
      }
      sqlText = await readSqlFromFile(fp);
      sourceLabel = file;
    } else {
      return res.status(400).json({ success: false, message: 'Tidak ada file untuk dipulihkan' });
    }

    if (!sqlText || sqlText.trim().length < 10) {
      return res.status(400).json({ success: false, message: 'File backup kosong atau tidak valid' });
    }
    // Sanity check: pastikan ini dump SQL (mengandung kata kunci umum)
    if (!/CREATE TABLE|INSERT INTO|DROP TABLE/i.test(sqlText)) {
      return res.status(400).json({ success: false, message: 'File tidak terlihat seperti dump SQL yang valid' });
    }

    const mode = req.body && req.body.mode ? req.body.mode : 'auto';
    const result = await restoreDatabase(sqlText, mode);

    logger.warn(`[Restore] Database dipulihkan dari "${sourceLabel}" (mode: ${result.mode}) oleh user ${(req.user && (req.user.username||req.user.name)) || '?'}`);
    res.json({ success: true, message: `Database berhasil dipulihkan dari ${sourceLabel}.`, ...result });
  } catch (e) {
    logger.error('backup restore error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  } finally {
    // Hapus file upload sementara
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
};

// GET /api/backup/settings
exports.getSettings = async (req, res) => {
  try {
    const settings = {
      auto_enabled:   (await getSetting('backup_auto_enabled', '0')) === '1',
      auto_schedule:   await getSetting('backup_auto_schedule', '0 2 * * *'),
      auto_retention: parseInt(await getSetting('backup_auto_retention', '7'), 10),
      auto_mode:       await getSetting('backup_auto_mode', 'auto'),
      last_at:         await getSetting('backup_last_at', null),
      last_file:       await getSetting('backup_last_file', null),
      last_mode:       await getSetting('backup_last_mode', null),
      last_sizeMB:     parseFloat(await getSetting('backup_last_sizeMB', '0')),
      last_tookMs:    parseInt(await getSetting('backup_last_tookMs', '0'), 10),
    };
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// PUT /api/backup/settings
exports.updateSettings = async (req, res) => {
  try {
    const { auto_enabled, auto_schedule, auto_retention, auto_mode } = req.body || {};

    if (typeof auto_enabled === 'boolean') {
      await setSetting('backup_auto_enabled', auto_enabled ? '1' : '0', 'boolean');
    }
    if (typeof auto_schedule === 'string' && auto_schedule.trim()) {
      // Basic cron format check (5 fields)
      const parts = auto_schedule.trim().split(/\s+/);
      if (parts.length !== 5) {
        return res.status(400).json({ success: false, message: 'Cron expression harus 5 field' });
      }
      await setSetting('backup_auto_schedule', auto_schedule.trim(), 'string');
    }
    if (auto_retention !== undefined) {
      const n = parseInt(auto_retention, 10);
      if (isNaN(n) || n < 1 || n > 365) {
        return res.status(400).json({ success: false, message: 'Retention harus 1-365' });
      }
      await setSetting('backup_auto_retention', String(n), 'number');
    }
    if (typeof auto_mode === 'string' && ['auto', 'mysqldump', 'native'].includes(auto_mode)) {
      await setSetting('backup_auto_mode', auto_mode, 'string');
    }

    res.json({ success: true, message: 'Setting backup tersimpan. Restart aplikasi untuk apply schedule baru.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ─── Export untuk CronService ───────────────────────────────────────
exports.createBackup    = createBackup;
exports.pruneOldBackups = pruneOldBackups;
exports.getSetting      = getSetting;
