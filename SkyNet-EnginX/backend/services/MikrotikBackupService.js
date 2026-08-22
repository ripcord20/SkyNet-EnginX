'use strict';

/**
 * MikrotikBackupService.js
 * ─────────────────────────────────────────────────────────────────────
 * Backup konfigurasi MikroTik dan kirim otomatis ke email.
 *
 * Cara kerja per device (type=router, is_active=true):
 *   1. SSH ke router (port dari setting mtbackup_ssh_port, default 22)
 *      memakai kredensial api_username/api_password dari tabel devices.
 *   2. Jalankan `/export show-sensitive` → simpan output sebagai file .rsc
 *      (script konfigurasi lengkap, bisa di-restore via /import).
 *   3. (Opsional) `/system backup save` → download file .backup biner
 *      via SFTP (backup full restorable termasuk password user).
 *   4. File disimpan di <project>/backups/mikrotik/.
 *   5. Kirim email berisi ringkasan + lampiran file backup ke daftar
 *      penerima (setting mtbackup_recipients).
 *   6. Prune file lama sesuai retention.
 *
 * Setting tersimpan di app_settings (prefix `mtbackup_`):
 *   - mtbackup_enabled         (0/1)   — auto-backup terjadwal aktif?
 *   - mtbackup_frequency       (daily | weekly | monthly)
 *   - mtbackup_hour            (0-23, default 2)
 *   - mtbackup_minute          (0-59, default 0)
 *   - mtbackup_day_of_week     (0-6, Minggu=0; untuk weekly)
 *   - mtbackup_day_of_month    (1-28; untuk monthly)
 *   - mtbackup_send_email      (0/1)   — kirim hasil ke email?
 *   - mtbackup_recipients      (email, pisah koma)
 *   - mtbackup_include_binary  (0/1)   — sertakan .backup biner?
 *   - mtbackup_retention       (jumlah file per device yang disimpan, default 14)
 *   - mtbackup_ssh_port        (default 22)
 *   - mtbackup_last_run_key    (marker dedup scheduler, mis. "2026-06-10")
 *   - mtbackup_last_at / mtbackup_last_status / mtbackup_last_summary
 *
 * Scheduler: CronService cek tiap menit (_runMikrotikBackupScheduler) —
 * membandingkan waktu sekarang dengan setting. Perubahan setting langsung
 * berlaku tanpa restart aplikasi.
 * ─────────────────────────────────────────────────────────────────────
 */

const fs     = require('fs');
const path   = require('path');
const moment = require('moment');
const { Client } = require('ssh2');
const logger = require('../utils/logger');

const BACKUP_DIR = path.join(__dirname, '../../backups/mikrotik');

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Sanitasi nama device untuk nama file: hanya alfanumerik, dash, underscore.
function safeName(name) {
  return String(name || 'router').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'router';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Settings helpers ─────────────────────────────────────────────────
async function getSetting(key, def) {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key } });
    return (row && row.value != null && row.value !== '') ? row.value : def;
  } catch (_) { return def; }
}

async function setSetting(key, value) {
  try {
    const { AppSetting } = require('../models');
    const [row, created] = await AppSetting.findOrCreate({
      where: { key }, defaults: { key, value: String(value), type: 'string' }
    });
    if (!created) await row.update({ value: String(value) });
  } catch (e) { logger.warn(`[MTBackup] setSetting ${key} failed: ${e.message}`); }
}

async function loadSettings() {
  return {
    enabled:        (await getSetting('mtbackup_enabled', '0')) === '1',
    frequency:      await getSetting('mtbackup_frequency', 'daily'),
    hour:           parseInt(await getSetting('mtbackup_hour', '2'), 10),
    minute:         parseInt(await getSetting('mtbackup_minute', '0'), 10),
    day_of_week:    parseInt(await getSetting('mtbackup_day_of_week', '1'), 10),
    day_of_month:   parseInt(await getSetting('mtbackup_day_of_month', '1'), 10),
    send_email:     (await getSetting('mtbackup_send_email', '1')) === '1',
    recipients:     await getSetting('mtbackup_recipients', ''),
    include_binary: (await getSetting('mtbackup_include_binary', '1')) === '1',
    retention:      Math.max(1, parseInt(await getSetting('mtbackup_retention', '14'), 10) || 14),
    ssh_port:       parseInt(await getSetting('mtbackup_ssh_port', '22'), 10) || 22,
  };
}

// ── SSH primitives ───────────────────────────────────────────────────
function sshConnect(device, sshPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { conn.end(); } catch (_) {}
      reject(new Error('SSH timeout (' + (timeoutMs/1000) + 's) ke ' + device.ip_address + ':' + sshPort));
    }, timeoutMs);

    conn.on('ready', () => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve(conn);
    });
    conn.on('error', (err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      reject(new Error('SSH error: ' + (err.message || err)));
    });
    conn.connect({
      host: device.ip_address,
      port: sshPort,
      username: device.api_username || 'admin',
      password: device.api_password || '',
      readyTimeout: timeoutMs,
      // RouterOS lama kadang hanya support algoritma legacy
      algorithms: {
        kex: ['curve25519-sha256','curve25519-sha256@libssh.org','ecdh-sha2-nistp256','ecdh-sha2-nistp384',
              'ecdh-sha2-nistp521','diffie-hellman-group-exchange-sha256','diffie-hellman-group14-sha256',
              'diffie-hellman-group14-sha1','diffie-hellman-group1-sha1'],
        cipher: ['aes128-ctr','aes192-ctr','aes256-ctr','aes128-gcm@openssh.com','aes256-gcm@openssh.com',
                 'aes128-cbc','aes256-cbc','3des-cbc'],
        serverHostKey: ['ssh-ed25519','ecdsa-sha2-nistp256','rsa-sha2-512','rsa-sha2-256','ssh-rsa','ssh-dss']
      }
    });
  });
}

function sshExec(conn, command, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let out = '', errOut = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      reject(new Error('Command timeout: ' + command));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        if (settled) return; settled = true;
        clearTimeout(timer);
        return reject(err);
      }
      stream.on('data', d => { out += d.toString('utf8'); });
      stream.stderr.on('data', d => { errOut += d.toString('utf8'); });
      stream.on('close', () => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        resolve({ stdout: out, stderr: errOut });
      });
    });
  });
}

function sftpGet(conn, remotePath, localPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      reject(new Error('SFTP timeout: ' + remotePath));
    }, timeoutMs);
    conn.sftp((err, sftp) => {
      if (err) { if (!settled) { settled = true; clearTimeout(timer); reject(err); } return; }
      sftp.fastGet(remotePath, localPath, (err2) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        if (err2) reject(err2); else resolve(true);
      });
    });
  });
}

// ═════════════════════════════════════════════════════════════════════
class MikrotikBackupService {

  get BACKUP_DIR() { return BACKUP_DIR; }
  loadSettings = loadSettings;
  getSetting   = getSetting;
  setSetting   = setSetting;

  // ── Backup satu device ─────────────────────────────────────────────
  // Returns { device, ok, files: [{filename, path, size}], error }
  async backupDevice(device, opts = {}) {
    ensureDir();
    const cfg = opts.settings || await loadSettings();
    const stamp = moment().format('YYYY-MM-DD_HHmmss');
    const base  = `${safeName(device.name)}_${stamp}`;
    const result = { device_id: device.id, device_name: device.name, ip: device.ip_address, ok: false, files: [], error: null };

    let conn = null;
    try {
      conn = await sshConnect(device, cfg.ssh_port);

      // 1) Export konfigurasi (.rsc) — show-sensitive supaya password
      //    PPPoE secret dll ikut (penting untuk restore total).
      //    RouterOS v6 tidak kenal show-sensitive (default sudah sensitive),
      //    jadi fallback ke /export biasa kalau error.
      let exp = await sshExec(conn, '/export show-sensitive', 90000);
      if ((!exp.stdout || exp.stdout.length < 50) && /syntax|unknown|bad command|expected/i.test(exp.stderr + exp.stdout)) {
        exp = await sshExec(conn, '/export', 90000);
      }
      const rscText = (exp.stdout || '').trim();
      if (!rscText || rscText.length < 30) {
        throw new Error('Output /export kosong — periksa permission user (' + (device.api_username || 'admin') + ') di router');
      }
      const rscPath = path.join(BACKUP_DIR, base + '.rsc');
      fs.writeFileSync(rscPath, rscText, 'utf8');
      result.files.push({ filename: base + '.rsc', path: rscPath, size: fs.statSync(rscPath).size, type: 'rsc' });

      // 2) Binary backup (.backup) — opsional
      if (cfg.include_binary) {
        try {
          const remoteName = 'flaynet-auto';
          await sshExec(conn, `/system backup save name=${remoteName} dont-encrypt=yes`, 60000);
          // Tunggu sebentar — router menulis file async
          await new Promise(r => setTimeout(r, 2500));
          const binPath = path.join(BACKUP_DIR, base + '.backup');
          await sftpGet(conn, `/${remoteName}.backup`, binPath, 90000);
          if (fs.existsSync(binPath) && fs.statSync(binPath).size > 0) {
            result.files.push({ filename: base + '.backup', path: binPath, size: fs.statSync(binPath).size, type: 'backup' });
          }
          // Hapus file di router supaya storage tidak penuh
          try { await sshExec(conn, `/file remove "${remoteName}.backup"`, 15000); } catch (_) {}
        } catch (e) {
          // Binary gagal bukan fatal — .rsc tetap valid
          logger.warn(`[MTBackup] Binary backup ${device.name} gagal: ${e.message}`);
        }
      }

      result.ok = true;
      logger.info(`[MTBackup] ${device.name} OK — ${result.files.map(f => f.filename).join(', ')}`);
    } catch (e) {
      result.error = e.message || String(e);
      logger.error(`[MTBackup] ${device.name} gagal: ${result.error}`);
    } finally {
      if (conn) { try { conn.end(); } catch (_) {} }
    }
    return result;
  }

  // ── Backup semua router aktif ──────────────────────────────────────
  // opts.deviceId → hanya 1 device. opts.sendEmail override setting.
  async runBackup(opts = {}) {
    ensureDir();
    const { Device } = require('../models');
    const cfg = await loadSettings();

    const where = { type: 'router', is_active: true };
    if (opts.deviceId) where.id = opts.deviceId;
    const devices = await Device.findAll({ where, order: [['id','ASC']] });
    if (!devices.length) {
      return { success: false, message: opts.deviceId ? 'Device tidak ditemukan / tidak aktif' : 'Tidak ada router aktif untuk dibackup', results: [] };
    }

    const startedAt = Date.now();
    const results = [];
    // Sequential — hindari banyak koneksi SSH paralel ke jaringan yang sama
    for (const dev of devices) {
      results.push(await this.backupDevice(dev, { settings: cfg }));
    }

    // Prune per device
    try { this.pruneOld(cfg.retention); } catch (e) { logger.warn('[MTBackup] prune error: ' + e.message); }

    const okCount  = results.filter(r => r.ok).length;
    const failList = results.filter(r => !r.ok);
    const tookSec  = Math.round((Date.now() - startedAt) / 1000);

    // Kirim email
    const wantEmail = (opts.sendEmail != null) ? !!opts.sendEmail : cfg.send_email;
    let emailStatus = 'skipped';
    if (wantEmail) {
      const sent = await this.sendBackupEmail(results, cfg, tookSec);
      emailStatus = sent ? 'sent' : 'failed';
    }

    // Status marker
    const summary = `${okCount}/${results.length} router OK, email: ${emailStatus}`;
    await setSetting('mtbackup_last_at', new Date().toISOString());
    await setSetting('mtbackup_last_status', failList.length ? 'partial' : 'ok');
    await setSetting('mtbackup_last_summary', summary);

    return {
      success: okCount > 0,
      message: summary,
      took_sec: tookSec,
      email_status: emailStatus,
      results: results.map(r => ({
        device_id: r.device_id, device_name: r.device_name, ip: r.ip,
        ok: r.ok, error: r.error,
        files: r.files.map(f => ({ filename: f.filename, size: f.size, type: f.type }))
      }))
    };
  }

  // ── Email hasil backup (HTML branded + lampiran) ───────────────────
  async sendBackupEmail(results, cfg, tookSec) {
    const EmailService = require('./EmailService');
    const recipients = String(cfg.recipients || '').split(/[\s,;]+/).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (!recipients.length) {
      logger.warn('[MTBackup] Email penerima belum diisi — skip kirim email');
      return false;
    }

    const okCount = results.filter(r => r.ok).length;
    const allOk = okCount === results.length;
    const statusColor = allOk ? '#16a34a' : (okCount > 0 ? '#b45309' : '#dc2626');
    const statusLabel = allOk ? 'BERHASIL' : (okCount > 0 ? 'SEBAGIAN BERHASIL' : 'GAGAL');

    const fmtSize = (b) => b >= 1048576 ? (b/1048576).toFixed(2) + ' MB' : (b/1024).toFixed(1) + ' KB';
    const rowsHtml = results.map(r => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #eef2f9;font-size:13px;color:#0d1b3e;font-weight:bold;">${escHtml(r.device_name)}<br><span style="font-weight:normal;font-size:11px;color:#94a3b8;">${escHtml(r.ip)}</span></td>
        <td style="padding:9px 12px;border-bottom:1px solid #eef2f9;font-size:12px;color:#475569;">${r.files.length ? r.files.map(f => escHtml(f.filename) + ' (' + fmtSize(f.size) + ')').join('<br>') : '-'}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #eef2f9;font-size:12px;font-weight:bold;color:${r.ok ? '#16a34a' : '#dc2626'};">${r.ok ? 'OK' : 'GAGAL'}${r.error ? '<br><span style="font-weight:normal;font-size:11px;color:#94a3b8;">' + escHtml(r.error) + '</span>' : ''}</td>
      </tr>`).join('');

    // Branding ringan
    let companyName = 'ISP Provider';
    try {
      const { AppSetting } = require('../models');
      const row = await AppSetting.findOne({ where: { key: 'company_name' } })
               || await AppSetting.findOne({ where: { key: 'app_name' } });
      if (row?.value) companyName = row.value;
    } catch (_) {}

    const html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#eef2f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e0e7f3;font-family:Arial,Helvetica,sans-serif;">
  <tr><td style="background:linear-gradient(135deg,#1e3a8a,#1d4ed8);padding:20px 26px;">
    <div style="font-size:18px;font-weight:bold;color:#fff;">${escHtml(companyName)}</div>
    <div style="font-size:11px;color:rgba(255,255,255,.75);margin-top:3px;">Backup Konfigurasi MikroTik — ${moment().format('D MMMM YYYY HH:mm')}</div>
  </td></tr>
  <tr><td style="padding:20px 26px 8px;">
    <span style="display:inline-block;padding:5px 14px;border-radius:20px;background:${statusColor};color:#fff;font-size:11px;font-weight:bold;letter-spacing:1px;">${statusLabel}</span>
    <p style="font-size:13px;color:#475569;line-height:1.7;margin:14px 0 6px;">
      Backup otomatis selesai dalam <strong>${tookSec} detik</strong>.
      <strong>${okCount}</strong> dari <strong>${results.length}</strong> router berhasil dibackup.
      File konfigurasi terlampir pada email ini.
    </p>
  </td></tr>
  <tr><td style="padding:8px 26px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;">
      <tr style="background:#f8faff;">
        <th align="left" style="padding:9px 12px;font-size:10px;letter-spacing:1px;color:#6b7fa8;text-transform:uppercase;">Router</th>
        <th align="left" style="padding:9px 12px;font-size:10px;letter-spacing:1px;color:#6b7fa8;text-transform:uppercase;">File Backup</th>
        <th align="left" style="padding:9px 12px;font-size:10px;letter-spacing:1px;color:#6b7fa8;text-transform:uppercase;">Status</th>
      </tr>
      ${rowsHtml}
    </table>
    <p style="font-size:11px;color:#94a3b8;margin:16px 0 0;line-height:1.6;">
      File .rsc dapat di-restore via <code>/import</code>, file .backup via System &gt; Backup &gt; Restore di Winbox.
      Email ini dikirim otomatis oleh sistem — mohon tidak membalas.
    </p>
  </td></tr>
</table>
</td></tr></table></body></html>`;

    // Lampiran — batasi total ±20MB supaya tidak ditolak SMTP
    const MAX_TOTAL = 20 * 1024 * 1024;
    let totalSize = 0;
    const attachments = [];
    for (const r of results) {
      for (const f of r.files) {
        if (totalSize + f.size > MAX_TOTAL) continue;
        attachments.push({ filename: f.filename, path: f.path });
        totalSize += f.size;
      }
    }

    return EmailService.send({
      to: recipients.join(','),
      subject: `[Backup MikroTik] ${statusLabel} — ${okCount}/${results.length} router (${moment().format('DD/MM/YYYY HH:mm')})`,
      html,
      attachments,
      type: 'backup'
    });
  }

  // ── List file backup ───────────────────────────────────────────────
  listFiles() {
    ensureDir();
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.rsc') || f.endsWith('.backup'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: st.size, created_at: st.mtime };
      })
      .sort((a, b) => b.created_at - a.created_at);
  }

  // ── Prune: simpan N backup terbaru per device per ekstensi ─────────
  pruneOld(keepN) {
    ensureDir();
    const files = this.listFiles();
    // Group: prefix device (nama sebelum _YYYY-MM-DD) + ekstensi
    const groups = {};
    files.forEach(f => {
      const m = f.filename.match(/^(.+)_(\d{4}-\d{2}-\d{2}_\d{6})\.(rsc|backup)$/);
      const key = m ? (m[1] + '.' + m[3]) : f.filename;
      (groups[key] = groups[key] || []).push(f);
    });
    let deleted = 0;
    Object.values(groups).forEach(list => {
      list.sort((a, b) => b.created_at - a.created_at);
      list.slice(keepN).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f.filename)); deleted++; } catch (_) {}
      });
    });
    if (deleted) logger.info(`[MTBackup] Pruned ${deleted} file backup lama`);
    return { deleted };
  }

  // ── Scheduler check (dipanggil CronService tiap menit) ─────────────
  // Membaca setting live → perubahan jadwal berlaku tanpa restart.
  async schedulerTick() {
    try {
      const cfg = await loadSettings();
      if (!cfg.enabled) return;

      const now = moment();
      if (now.hour() !== cfg.hour || now.minute() !== cfg.minute) return;

      // Cek frekuensi
      if (cfg.frequency === 'weekly' && now.day() !== cfg.day_of_week) return;
      if (cfg.frequency === 'monthly' && now.date() !== cfg.day_of_month) return;

      // Dedup — jangan jalan 2x di menit yang sama / hari yang sama
      const runKey = now.format('YYYY-MM-DD');
      const lastKey = await getSetting('mtbackup_last_run_key', '');
      if (lastKey === runKey) return;
      await setSetting('mtbackup_last_run_key', runKey);

      logger.info(`[MTBackup] Scheduler trigger (${cfg.frequency} ${String(cfg.hour).padStart(2,'0')}:${String(cfg.minute).padStart(2,'0')})`);
      const result = await this.runBackup({});
      logger.info(`[MTBackup] Scheduler done: ${result.message}`);
    } catch (e) {
      logger.error('[MTBackup] Scheduler error: ' + (e.message || e));
    }
  }
}

module.exports = new MikrotikBackupService();
