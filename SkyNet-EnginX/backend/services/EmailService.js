const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// SMTP kini dapat dikonfigurasi via Settings (app_settings), fallback ke ENV.
// Konfigurasi di-cache & bisa di-reload runtime tanpa restart (reload()).
class EmailService {
  constructor() {
    this.transporter = null;
    this.cfg = null;
    this._loaded = false;
  }

  // Ambil konfigurasi SMTP: app_settings > ENV.
  async _loadConfig() {
    let db = {};
    let appName = '';
    try {
      const { AppSetting } = require('../models');
      const keys = ['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_pass','smtp_from','smtp_from_name','smtp_enabled','app_name'];
      const rows = await AppSetting.findAll({ where: { key: keys } });
      rows.forEach(r => { db[r.key] = r.value; });
      appName = db.app_name || '';
    } catch (_) { /* DB belum siap */ }

    // Alamat email pengirim: smtp_from (kalau berisi email) > smtp_user > ENV.
    const rawFrom = (db.smtp_from || process.env.SMTP_FROM || '').trim();
    // Kalau smtp_from sudah berformat "Nama <email>", ambil bagian emailnya saja.
    const emailMatch = rawFrom.match(/<([^>]+)>/);
    const fromEmail = (emailMatch ? emailMatch[1] : rawFrom).trim()
      || (db.smtp_user || process.env.SMTP_USER || '').trim();

    // Nama pengirim: smtp_from_name > nama di smtp_from > nama brand app > default.
    const nameInFrom = rawFrom.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
    const fromName = (db.smtp_from_name || nameInFrom || appName || 'ISP NetOps').trim();

    // Rakit header From standar: "Nama" <email>
    const from = fromEmail ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : (rawFrom || 'ISP NetOps <noreply@ispnetops.com>');

    const cfg = {
      enabled: db.smtp_enabled === '1' || (!!process.env.SMTP_HOST && db.smtp_enabled !== '0'),
      host:   db.smtp_host || process.env.SMTP_HOST || '',
      port:   parseInt(db.smtp_port || process.env.SMTP_PORT || '587', 10),
      secure: db.smtp_secure ? (db.smtp_secure === '1') : (parseInt(db.smtp_port || process.env.SMTP_PORT || '587',10) === 465),
      user:   db.smtp_user || process.env.SMTP_USER || '',
      pass:   db.smtp_pass || process.env.SMTP_PASS || '',
      from,
      fromName,
      fromEmail
    };
    return cfg;
  }

  async _ensure(force) {
    if (this._loaded && this.transporter && !force) return;
    this.cfg = await this._loadConfig();
    if (this.cfg.enabled && this.cfg.host && this.cfg.user) {
      this.transporter = nodemailer.createTransport({
        host: this.cfg.host,
        port: this.cfg.port,
        secure: this.cfg.secure,
        auth: { user: this.cfg.user, pass: this.cfg.pass }
      });
      logger.info('[Email] SMTP siap (' + this.cfg.host + ':' + this.cfg.port + ')');
    } else {
      this.transporter = null;
      logger.warn('[Email] SMTP belum dikonfigurasi / dinonaktifkan');
    }
    this._loaded = true;
  }

  // Reload konfigurasi (panggil setelah user menyimpan setting SMTP).
  async reload() { this._loaded = false; this.transporter = null; await this._ensure(true); return !!this.transporter; }

  // Status konfigurasi SMTP — untuk pesan error yang spesifik di UI.
  // return: { configured:boolean, enabled:boolean, host, user, reason }
  async getStatus() {
    const cfg = await this._loadConfig();
    const enabled = !!cfg.enabled;
    const hasHost = !!(cfg.host && String(cfg.host).trim());
    const hasUser = !!(cfg.user && String(cfg.user).trim());
    let reason = '';
    if (!enabled) reason = 'SMTP dinonaktifkan di pengaturan';
    else if (!hasHost) reason = 'Host SMTP belum diisi di Settings';
    else if (!hasUser) reason = 'Username/email SMTP belum diisi di Settings';
    return { configured: enabled && hasHost && hasUser, enabled, host: cfg.host || '', user: cfg.user || '', reason };
  }

  // Kirim + kembalikan alasan spesifik bila gagal (untuk endpoint kirim uji).
  // return: { ok:boolean, reason:string }
  async sendWithReason({ to, subject, html, text, attachments, type, noRetry }) {
    const st = await this.getStatus();
    if (!st.configured) {
      this._log({ to, subject, type: type || 'test', status: 'failed', error_message: st.reason || 'SMTP belum dikonfigurasi' });
      return { ok: false, reason: st.reason || 'SMTP belum dikonfigurasi' };
    }
    await this._ensure();
    if (!this.transporter) {
      this._log({ to, subject, type: type || 'test', status: 'failed', error_message: 'SMTP belum dikonfigurasi' });
      return { ok: false, reason: 'SMTP belum dikonfigurasi' };
    }
    const t0 = Date.now();
    try {
      const mail = { from: this.cfg.from, to, subject, html, text };
      if (attachments && attachments.length) mail.attachments = attachments;
      await this.transporter.sendMail(mail);
      logger.info(`[Email] terkirim ke ${to}: ${subject}`);
      this._log({ to, subject, type: type || 'test', status: 'sent', duration_ms: Date.now() - t0, has_attachment: !!(attachments && attachments.length) });
      return { ok: true, reason: '' };
    } catch (error) {
      const m = String(error && error.message || error);
      let reason = 'Gagal mengirim email';
      if (/auth|credential|535|534|password|username/i.test(m)) reason = 'Login SMTP ditolak — periksa username/password di Settings';
      else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect|getaddrinfo|EAI_AGAIN/i.test(m)) reason = 'Tidak dapat terhubung ke server SMTP — periksa host & port';
      else if (/self.signed|certificate|TLS|SSL/i.test(m)) reason = 'Masalah sertifikat TLS/SSL — periksa pengaturan secure/port';
      else if (/recipient|550|relay|mailbox/i.test(m)) reason = 'Alamat tujuan ditolak server';
      else reason = 'Gagal mengirim: ' + m.slice(0, 120);
      logger.error('[Email] gagal kirim: ' + m);
      this._log({ to, subject, type: type || 'test', status: 'failed', error_message: reason, duration_ms: Date.now() - t0,
        retryPayload: noRetry ? null : { to, subject, html, text, type: type || 'test' } });
      return { ok: false, reason };
    }
  }

  // Helper: catat ke EmailLog (best-effort, tak boleh menggagalkan pengiriman).
  // Bila email GAGAL & retryPayload diberikan (punya html/text), jadwalkan
  // percobaan ulang otomatis: simpan payload + next_retry_at.
  async _log({ to, subject, type, status, error_message, duration_ms, has_attachment, retryPayload }) {
    try {
      const { EmailLog } = require('../models');
      if (!EmailLog) return;
      const failed = status === 'failed';
      const row = {
        recipient: String(to || '').slice(0, 160),
        subject: subject ? String(subject).slice(0, 255) : null,
        type: (type || 'other').slice(0, 40),
        status: failed ? 'failed' : 'sent',
        error_message: error_message ? String(error_message).slice(0, 255) : null,
        duration_ms: duration_ms || null,
        has_attachment: !!has_attachment
      };
      // Jadwalkan retry hanya bila: gagal, ada payload yg bisa dikirim ulang,
      // dan TIDAK ada lampiran (attachment tak ikut tersimpan — biar tak berat
      // & tak menyimpan PDF di DB). Email berlampiran tetap dicatat gagal saja.
      const canRetry = failed && retryPayload && (retryPayload.html || retryPayload.text) && !has_attachment;
      if (canRetry) {
        row.status = 'retrying';
        row.retry_count = 0;
        row.last_error = row.error_message;
        row.next_retry_at = new Date(Date.now() + this._retryDelayMs(0));
        row.payload = {
          to: retryPayload.to,
          subject: retryPayload.subject,
          html: retryPayload.html || null,
          text: retryPayload.text || null,
          type: retryPayload.type || row.type
        };
      }
      await EmailLog.create(row);
    } catch (_) { /* abaikan: logging tak boleh memengaruhi pengiriman */ }
  }

  // Jeda sebelum percobaan ke-N (backoff): 2m, 10m, 30m.
  _retryDelayMs(attemptIndex) {
    const mins = [2, 10, 30];
    return (mins[Math.min(attemptIndex, mins.length - 1)] || 30) * 60 * 1000;
  }

  // Batas maksimum percobaan ulang.
  get MAX_RETRY() { return 3; }

  // Kirim "mentah" tanpa logging tambahan — dipakai oleh proses retry agar
  // tidak membuat baris log baru tiap percobaan (cukup update baris yang ada).
  // return: { ok:boolean, reason:string }
  async _sendRawForRetry({ to, subject, html, text }) {
    const st = await this.getStatus();
    if (!st.configured) return { ok: false, reason: st.reason || 'SMTP belum dikonfigurasi' };
    await this._ensure();
    if (!this.transporter) return { ok: false, reason: 'SMTP belum dikonfigurasi' };
    try {
      await this.transporter.sendMail({ from: this.cfg.from, to, subject, html, text });
      return { ok: true, reason: '' };
    } catch (error) {
      return { ok: false, reason: String((error && error.message) || error).slice(0, 200) };
    }
  }

  /**
   * processRetryQueue() — dipanggil cron berkala.
   * Ambil email berstatus 'retrying' yang next_retry_at sudah lewat, lalu kirim
   * ulang. Sukses → status 'sent'. Gagal & masih < MAX_RETRY → jadwalkan lagi
   * dgn backoff. Gagal & sudah mentok → status 'failed' (berhenti dicoba).
   * return: { processed, sent, failed, scheduled }
   */
  async processRetryQueue(limit = 50) {
    const stats = { processed: 0, sent: 0, failed: 0, scheduled: 0 };
    let EmailLog, Op;
    try {
      ({ EmailLog } = require('../models'));
      ({ Op } = require('sequelize'));
    } catch (_) { return stats; }
    if (!EmailLog) return stats;

    const due = await EmailLog.findAll({
      where: { status: 'retrying', next_retry_at: { [Op.lte]: new Date() } },
      order: [['next_retry_at', 'ASC']],
      limit: Math.max(1, Math.min(200, limit))
    });

    // Jeda antar-kirim (ms) untuk hindari rate-limit SMTP saat provider baru
    // pulih dari gangguan & banyak email menumpuk sekaligus. Selaras dgn pola
    // throttle di Email Broadcast.
    const THROTTLE_MS = 1500;
    let idx = 0;
    for (const row of due) {
      const p = row.payload || {};
      if (!p.to || (!p.html && !p.text)) {
        // payload tak lengkap → tak bisa diretry, tandai gagal final.
        await row.update({ status: 'failed', next_retry_at: null });
        stats.processed++; stats.failed++;
        continue;
      }
      stats.processed++;
      const r = await this._sendRawForRetry({ to: p.to, subject: p.subject, html: p.html, text: p.text });
      const attempt = (row.retry_count || 0) + 1;
      if (r.ok) {
        await row.update({
          status: 'sent', retry_count: attempt, next_retry_at: null,
          error_message: null
        });
        logger.info(`[Email][Retry] sukses pada percobaan #${attempt} → ${p.to}: ${p.subject || ''}`);
        stats.sent++;
      } else if (attempt < this.MAX_RETRY) {
        await row.update({
          retry_count: attempt,
          last_error: String(r.reason || '').slice(0, 255),
          error_message: String(r.reason || '').slice(0, 255),
          next_retry_at: new Date(Date.now() + this._retryDelayMs(attempt))
        });
        logger.warn(`[Email][Retry] gagal percobaan #${attempt}, dijadwalkan ulang → ${p.to}`);
        stats.scheduled++;
      } else {
        await row.update({
          status: 'failed', retry_count: attempt, next_retry_at: null,
          last_error: String(r.reason || '').slice(0, 255),
          error_message: String(r.reason || '').slice(0, 255)
        });
        logger.error(`[Email][Retry] menyerah setelah ${attempt} percobaan → ${p.to}: ${r.reason}`);
        stats.failed++;
      }
      // Throttle hanya antar pengiriman aktual (bukan setelah baris terakhir).
      if (++idx < due.length) {
        const jitter = Math.floor(Math.random() * 500);
        await new Promise(res => setTimeout(res, THROTTLE_MS + jitter));
      }
    }
    return stats;
  }

  async send({ to, subject, html, text, attachments, type, noRetry }) {
    await this._ensure();
    if (!this.transporter) {
      logger.warn('[Email] tidak terkirim — SMTP belum dikonfigurasi');
      this._log({ to, subject, type, status: 'failed', error_message: 'SMTP belum dikonfigurasi', has_attachment: !!(attachments && attachments.length),
        retryPayload: noRetry ? null : { to, subject, html, text, type } });
      return false;
    }
    const t0 = Date.now();
    try {
      const mail = { from: this.cfg.from, to, subject, html, text };
      if (attachments && attachments.length) mail.attachments = attachments;
      await this.transporter.sendMail(mail);
      logger.info(`[Email] terkirim ke ${to}: ${subject}`);
      this._log({ to, subject, type, status: 'sent', duration_ms: Date.now() - t0, has_attachment: !!(attachments && attachments.length) });
      return true;
    } catch (error) {
      logger.error('[Email] gagal kirim: ' + error.message);
      this._log({ to, subject, type, status: 'failed', error_message: error.message, duration_ms: Date.now() - t0, has_attachment: !!(attachments && attachments.length),
        retryPayload: noRetry ? null : { to, subject, html, text, type } });
      return false;
    }
  }

  // Kirim email test untuk verifikasi konfigurasi. Lempar error agar pesan jelas.
  async sendTest(to) {
    await this._ensure(true);
    if (!this.transporter) throw new Error('SMTP belum dikonfigurasi atau dinonaktifkan');
    await this.transporter.sendMail({
      from: this.cfg.from,
      to,
      subject: 'Test Email — Konfigurasi SMTP Berhasil',
      html: `<div style="font-family:sans-serif;padding:20px;">
        <h2 style="color:#1d4ed8;">✓ SMTP Berfungsi</h2>
        <p>Ini adalah email percobaan. Jika Anda menerimanya, konfigurasi SMTP sudah benar.</p>
        <p style="color:#666;margin-top:20px;">Dikirim: ${new Date().toLocaleString('id-ID')}</p>
      </div>`
    });
    return true;
  }

  async sendDeviceDownAlert(device, recipients) {
    return this.send({
      to: recipients.join(','),
      subject: `[ALERT] Device Down: ${device.name}`,
      html: `
        <div style="font-family:sans-serif;padding:20px;">
          <h2 style="color:#ef4444;">⚠️ Device Down Alert</h2>
          <table style="border-collapse:collapse;width:100%;max-width:500px;">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Device</td><td style="padding:8px;border:1px solid #ddd;">${device.name}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">IP Address</td><td style="padding:8px;border:1px solid #ddd;">${device.ip_address}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Type</td><td style="padding:8px;border:1px solid #ddd;">${device.type}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Time</td><td style="padding:8px;border:1px solid #ddd;">${new Date().toLocaleString('id-ID')}</td></tr>
          </table>
          <p style="color:#666;margin-top:20px;">— ISP NetOps Monitoring System</p>
        </div>
      `
    });
  }

  async sendInvoiceOverdueAlert(customer, invoice) {
    if (!customer.email) return false;
    try {
      const EmailTpl = require('./EmailTemplateService');
      if (!(await EmailTpl.isEnabled('invoice_overdue'))) return false;
      let companyName = '';
      try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
      const vars = {
        nama: customer.name || 'Pelanggan',
        invoice: invoice.invoice_number || '',
        periode: invoice.period || '',
        jumlah: 'Rp ' + parseFloat(invoice.total || 0).toLocaleString('id-ID'),
        jatuh_tempo: invoice.due_date || '',
        paket: (customer.package && customer.package.name) || '-',
        perusahaan: companyName || 'ISP'
      };
      const detailRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr><td style="padding:9px 14px;color:#6b7fa8;">No. Invoice</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;">${EmailTpl.escapeHtml(vars.invoice)}</td></tr>
        <tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Jumlah</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(vars.jumlah)}</td></tr>
        <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Jatuh Tempo</td><td align="right" style="padding:9px 14px;font-weight:700;color:#e08a00;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(vars.jatuh_tempo)}</td></tr>
      </table>`;
      const built = await EmailTpl.render('invoice_overdue', vars, { companyName: vars.perusahaan, bodyExtraHtml: detailRows });
      return this.send({ to: customer.email, subject: built.subject, html: built.html, text: built.text, type: 'invoice_overdue' });
    } catch (e) {
      logger.warn('[Email] overdue template gagal, fallback: ' + e.message);
      // Fallback ke versi lama bila service template bermasalah.
      return this.send({
        to: customer.email,
        type: 'invoice_overdue',
        subject: `Invoice Overdue: ${invoice.invoice_number}`,
        html: `
          <div style="font-family:sans-serif;padding:20px;">
            <h2>Invoice Reminder</h2>
            <p>Dear ${customer.name},</p>
            <p>Your invoice <strong>${invoice.invoice_number}</strong> is overdue.</p>
            <table style="border-collapse:collapse;width:100%;max-width:400px;">
              <tr><td style="padding:8px;border:1px solid #ddd;">Amount</td><td style="padding:8px;border:1px solid #ddd;">Rp ${parseFloat(invoice.total).toLocaleString('id-ID')}</td></tr>
              <tr><td style="padding:8px;border:1px solid #ddd;">Due Date</td><td style="padding:8px;border:1px solid #ddd;">${invoice.due_date}</td></tr>
            </table>
            <p>Please make your payment as soon as possible to avoid service interruption.</p>
            <p>— ISP NetOps</p>
          </div>
        `
      });
    }
  }

  // Kirim email selamat datang ke pelanggan baru (dipakai saat registrasi).
  async sendCustomerWelcome(customer) {
    if (!customer || !customer.email) return false;
    try {
      const EmailTpl = require('./EmailTemplateService');
      if (!(await EmailTpl.isEnabled('customer_welcome'))) return false;
      let companyName = '';
      try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
      const vars = {
        nama: customer.name || 'Pelanggan',
        id_pelanggan: customer.customer_id || customer.id || '-',
        paket: (customer.package && customer.package.name) || customer.packageName || '-',
        telepon: customer.phone || '-',
        email: customer.email || '-',
        perusahaan: companyName || 'ISP'
      };
      const detailRows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr><td style="padding:9px 14px;color:#6b7fa8;">ID Pelanggan</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;">${EmailTpl.escapeHtml(vars.id_pelanggan)}</td></tr>
        <tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Paket</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(vars.paket)}</td></tr>
        <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Telepon</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${EmailTpl.escapeHtml(vars.telepon)}</td></tr>
      </table>`;
      const built = await EmailTpl.render('customer_welcome', vars, { companyName: vars.perusahaan, bodyExtraHtml: detailRows });
      return this.send({ to: customer.email, subject: built.subject, html: built.html, text: built.text, type: 'customer_welcome' });
    } catch (e) {
      logger.warn('[Email] welcome gagal: ' + e.message);
      return false;
    }
  }
}

module.exports = new EmailService();
