'use strict';

/**
 * MikrotikBackupController.js
 * ─────────────────────────────────────────────────────────────────────
 * API untuk fitur Backup Konfigurasi MikroTik → Email.
 *
 * Endpoint:
 *   GET    /api/mikrotik-backup/info               → status, last run, jumlah device
 *   GET    /api/mikrotik-backup/devices            → daftar router yang akan dibackup
 *   GET    /api/mikrotik-backup/files              → daftar file backup tersimpan
 *   POST   /api/mikrotik-backup/run                → backup sekarang (semua / 1 device)
 *   GET    /api/mikrotik-backup/download/:file     → download file backup
 *   DELETE /api/mikrotik-backup/files/:file        → hapus file backup
 *   GET    /api/mikrotik-backup/settings           → ambil setting
 *   PUT    /api/mikrotik-backup/settings           → simpan setting
 *   POST   /api/mikrotik-backup/test-email         → kirim email test penerima
 * ─────────────────────────────────────────────────────────────────────
 */

const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger');
const Svc    = require('../services/MikrotikBackupService');

// Validasi nama file backup — cegah path traversal pada download/delete.
function isSafeFilename(f) {
  return /^[a-zA-Z0-9_.-]+\.(rsc|backup)$/.test(String(f || '')) && !String(f).includes('..');
}

// Flag in-memory: cegah 2 backup manual jalan bersamaan (SSH ke router
// yang sama 2x paralel bisa bikin export corrupt / lambat).
let _running = false;

class MikrotikBackupController {

  // ── Info / status ──────────────────────────────────────────────────
  async info(req, res) {
    try {
      const { Device } = require('../models');
      const cfg = await Svc.loadSettings();
      const routerCount = await Device.count({ where: { type: 'router', is_active: true } });
      const files = Svc.listFiles();
      res.json({
        success: true,
        data: {
          running: _running,
          router_count: routerCount,
          file_count: files.length,
          total_size: files.reduce((a, f) => a + f.size, 0),
          last_at:      await Svc.getSetting('mtbackup_last_at', null),
          last_status:  await Svc.getSetting('mtbackup_last_status', null),
          last_summary: await Svc.getSetting('mtbackup_last_summary', null),
          settings: { ...cfg }
        }
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Daftar router ──────────────────────────────────────────────────
  async devices(req, res) {
    try {
      const { Device } = require('../models');
      const rows = await Device.findAll({
        where: { type: 'router', is_active: true },
        attributes: ['id','name','ip_address','api_username','api_port','status'],
        order: [['id','ASC']]
      });
      res.json({ success: true, data: rows.map(r => ({
        id: r.id, name: r.name, ip_address: r.ip_address,
        username: r.api_username || 'admin', status: r.status || null
      })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Daftar file ────────────────────────────────────────────────────
  async files(req, res) {
    try {
      res.json({ success: true, data: Svc.listFiles() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Run backup sekarang ────────────────────────────────────────────
  // Body: { device_id? , send_email? }
  async run(req, res) {
    try {
      if (_running) {
        return res.status(409).json({ success: false, message: 'Backup sedang berjalan — tunggu sampai selesai' });
      }
      const { device_id, send_email } = req.body || {};
      _running = true;
      try {
        const result = await Svc.runBackup({
          deviceId: device_id ? parseInt(device_id) : null,
          sendEmail: (send_email != null) ? !!send_email : null
        });
        res.json({ success: result.success, message: result.message, data: result });
      } finally {
        _running = false;
      }
    } catch (e) {
      _running = false;
      logger.error('[MTBackup] run error: ' + (e.message || e));
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Download file ──────────────────────────────────────────────────
  async download(req, res) {
    try {
      const file = req.params.file;
      if (!isSafeFilename(file)) return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
      const full = path.join(Svc.BACKUP_DIR, file);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, message: 'File tidak ditemukan' });
      res.download(full, file);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Hapus file ─────────────────────────────────────────────────────
  async deleteFile(req, res) {
    try {
      const file = req.params.file;
      if (!isSafeFilename(file)) return res.status(400).json({ success: false, message: 'Nama file tidak valid' });
      const full = path.join(Svc.BACKUP_DIR, file);
      if (!fs.existsSync(full)) return res.status(404).json({ success: false, message: 'File tidak ditemukan' });
      fs.unlinkSync(full);
      res.json({ success: true, message: 'File backup dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Get settings ───────────────────────────────────────────────────
  async getSettings(req, res) {
    try {
      const cfg = await Svc.loadSettings();
      res.json({ success: true, data: cfg });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Update settings ────────────────────────────────────────────────
  async updateSettings(req, res) {
    try {
      const b = req.body || {};
      const clampInt = (v, min, max, def) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
      };
      const freq = ['daily','weekly','monthly'].includes(b.frequency) ? b.frequency : 'daily';

      // Validasi penerima email — buang yang tidak valid, simpan sisanya.
      const recipients = String(b.recipients || '')
        .split(/[\s,;]+/)
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

      const updates = {
        mtbackup_enabled:        b.enabled ? '1' : '0',
        mtbackup_frequency:      freq,
        mtbackup_hour:           String(clampInt(b.hour, 0, 23, 2)),
        mtbackup_minute:         String(clampInt(b.minute, 0, 59, 0)),
        mtbackup_day_of_week:    String(clampInt(b.day_of_week, 0, 6, 1)),
        mtbackup_day_of_month:   String(clampInt(b.day_of_month, 1, 28, 1)),
        mtbackup_send_email:     b.send_email ? '1' : '0',
        mtbackup_recipients:     recipients.join(','),
        mtbackup_include_binary: b.include_binary ? '1' : '0',
        mtbackup_retention:      String(clampInt(b.retention, 1, 365, 14)),
        mtbackup_ssh_port:       String(clampInt(b.ssh_port, 1, 65535, 22)),
      };
      for (const [k, v] of Object.entries(updates)) await Svc.setSetting(k, v);

      // Auto-backup aktif + email on tapi penerima kosong → beri peringatan
      let warning = null;
      if (b.enabled && b.send_email && !recipients.length) {
        warning = 'Auto-backup aktif tapi email penerima kosong — hasil backup tidak akan terkirim ke email.';
      }
      res.json({ success: true, message: 'Pengaturan backup MikroTik tersimpan', warning });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Test email penerima ────────────────────────────────────────────
  async testEmail(req, res) {
    try {
      const cfg = await Svc.loadSettings();
      const recipients = String(cfg.recipients || '').split(/[\s,;]+/).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (!recipients.length) return res.status(400).json({ success: false, message: 'Email penerima belum diisi di pengaturan' });

      const EmailService = require('../services/EmailService');
      const ok = await EmailService.send({
        to: recipients.join(','),
        subject: '[Test] Backup MikroTik — Email Penerima OK',
        html: `<div style="font-family:Arial,sans-serif;padding:20px;">
          <h2 style="color:#1d4ed8;margin:0 0 10px;">Email Penerima Backup OK</h2>
          <p style="color:#475569;font-size:13px;line-height:1.7;">Alamat ini terdaftar sebagai penerima hasil backup konfigurasi MikroTik.
          Jika Anda menerima email ini, pengaturan sudah benar.</p>
          <p style="color:#94a3b8;font-size:11px;margin-top:16px;">Dikirim: ${new Date().toLocaleString('id-ID')}</p>
        </div>`,
        type: 'backup',
        noRetry: true
      });
      if (!ok) return res.status(400).json({ success: false, message: 'Gagal kirim — periksa konfigurasi SMTP di Settings' });
      res.json({ success: true, message: 'Email test terkirim ke ' + recipients.join(', ') });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new MikrotikBackupController();
