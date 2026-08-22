/**
 * DemoController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mengelola akun demo per-visitor.
 *
 * Dua mode dukungan:
 *
 *   MODE A — Shared demo account (default, paling sederhana)
 *   ─────────────────────────────────────────────────────────
 *   Semua visitor login dengan satu email+password yang sama
 *   (demo@ispnetops.com / demo12345). Sesi di-track lewat JWT di cookie.
 *   Data akun di-reset tiap jam oleh DemoResetService.
 *
 *   MODE B — Ephemeral demo account (opsional, lebih aman)
 *   ─────────────────────────────────────────────────────────
 *   Endpoint POST /api/demo/provision membuat user demo BARU secara dinamis
 *   (email demo-<random>@ispnetops.com) dengan masa berlaku 2 jam. Tiap
 *   visitor dapat akun sendiri, sehingga:
 *     - Tidak ada conflict session antar visitor
 *     - Ubah profile/layout tidak mengganggu visitor lain
 *     - Kalau ada yang iseng, dampaknya hanya ke akun dia sendiri
 *
 *   Mode B butuh kolom `is_demo` dan `demo_expires_at` di tabel users — lihat
 *   file `patches/migration_add_is_demo.sql` dalam paket ini.
 *
 * Endpoint yang disediakan:
 *   POST /api/demo/provision  → buat akun ephemeral, return auto-login token
 *   GET  /api/demo/info       → info akun demo yang sedang aktif (expiry, dll)
 *   POST /api/demo/extend     → perpanjang masa berlaku (optional, biasanya
 *                               dibatasi per IP)
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, Role, ActivityLog } = require('../models');
const logger = require('../utils/logger');

const DEMO_TTL_HOURS = parseInt(process.env.DEMO_TTL_HOURS || '2', 10);
const DEMO_MAX_CONCURRENT = parseInt(process.env.DEMO_MAX_CONCURRENT || '50', 10);
const DEMO_PROVISION_COOLDOWN_MIN = parseInt(process.env.DEMO_PROVISION_COOLDOWN_MIN || '5', 10);

// Pakai Map sederhana untuk cooldown per IP (cukup untuk single-process deploy)
// Kalau deploy multi-instance, ganti dengan Redis
const provisionCooldown = new Map();

class DemoController {
  /**
   * POST /api/demo/provision
   * Buat akun demo ephemeral baru dan return token.
   * Diproteksi dari abuse via cooldown per-IP.
   */
  async provision(req, res) {
    try {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';

      // 1. Cooldown check
      const lastProvision = provisionCooldown.get(ip);
      if (lastProvision) {
        const elapsedMin = (Date.now() - lastProvision) / 60000;
        if (elapsedMin < DEMO_PROVISION_COOLDOWN_MIN) {
          const waitMin = Math.ceil(DEMO_PROVISION_COOLDOWN_MIN - elapsedMin);
          return res.status(429).json({
            success: false,
            message: `Silakan tunggu ${waitMin} menit lagi sebelum membuat akun demo baru.`
          });
        }
      }

      // 2. Max concurrent check — jangan sampai DB penuh user demo
      const activeDemoCount = await User.count({
        where: { is_demo: true, is_active: true }
      });
      if (activeDemoCount >= DEMO_MAX_CONCURRENT) {
        return res.status(503).json({
          success: false,
          message: 'Server demo sedang padat. Coba lagi beberapa menit.'
        });
      }

      // 3. Ambil role demo
      const demoRole = await Role.findOne({ where: { name: 'demo' } });
      if (!demoRole) {
        logger.error('[Demo] Role demo tidak ada — jalankan seedDemo.js dulu');
        return res.status(500).json({
          success: false,
          message: 'Sistem demo belum dikonfigurasi.'
        });
      }

      // 4. Buat user baru
      const randomId = crypto.randomBytes(6).toString('hex');
      const email = `demo-${randomId}@ispnetops.local`;
      const password = crypto.randomBytes(12).toString('base64url');
      const expiresAt = new Date(Date.now() + DEMO_TTL_HOURS * 60 * 60 * 1000);

      const user = await User.create({
        name: `Demo Visitor ${randomId.slice(0, 4).toUpperCase()}`,
        email,
        password,                      // akan di-hash oleh hook
        role_id: demoRole.id,
        is_active: true,
        is_demo: true,
        demo_expires_at: expiresAt,
        phone: '08000000000',
      });

      // 5. Generate JWT (expiry cocok dengan masa berlaku akun)
      const token = jwt.sign(
        { id: user.id, email: user.email, role: demoRole.name, isDemo: true },
        process.env.JWT_SECRET,
        { expiresIn: `${DEMO_TTL_HOURS}h` }
      );

      // 6. Set cookie supaya langsung auto-login
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.APP_ENV === 'production',
        maxAge: DEMO_TTL_HOURS * 60 * 60 * 1000,
      });

      provisionCooldown.set(ip, Date.now());

      // 7. Log
      logger.info(`[Demo] Provisioned ephemeral demo ${email} for IP ${ip}`);
      await ActivityLog.create({
        user_id: user.id,
        action: 'demo_provision',
        module: 'auth',
        description: `Akun demo ephemeral dibuat dari IP ${ip}`,
        ip_address: ip,
        user_agent: req.get('User-Agent')
      });

      return res.json({
        success: true,
        message: 'Akun demo berhasil dibuat',
        data: {
          token,
          redirect: '/dashboard',
          expiresAt,
          expiresInHours: DEMO_TTL_HOURS,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: { name: demoRole.name, display_name: demoRole.display_name }
          }
        }
      });
    } catch (err) {
      logger.error('[Demo] Provision failed:', err);
      // Deteksi error spesifik untuk pesan yang lebih jelas
      const errMsg = err.message || '';
      if (errMsg.includes('Unknown column') && errMsg.includes('is_demo')) {
        return res.status(503).json({
          success: false,
          code: 'DEMO_MIGRATION_NEEDED',
          message: 'Mode demo pribadi belum dikonfigurasi. Silakan pakai akun demo bersama (demo@ispnetops.com).'
        });
      }
      if (errMsg.includes('Duplicate entry')) {
        return res.status(500).json({
          success: false,
          message: 'Konflik internal saat membuat akun. Coba lagi.'
        });
      }
      return res.status(500).json({
        success: false,
        message: 'Gagal membuat akun demo. Silakan coba lagi.'
      });
    }
  }

  /**
   * GET /api/demo/info
   * Info akun demo yang sedang aktif — dipakai UI buat nampilin countdown.
   */
  async info(req, res) {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
      }

      const isDemo = req.user.role?.name === 'demo';
      if (!isDemo) {
        return res.json({ success: true, data: { isDemo: false } });
      }

      const expiresAt = req.user.demo_expires_at;
      const remainingMs = expiresAt ? new Date(expiresAt).getTime() - Date.now() : null;

      return res.json({
        success: true,
        data: {
          isDemo: true,
          email: req.user.email,
          name: req.user.name,
          expiresAt,
          remainingSeconds: remainingMs ? Math.max(0, Math.floor(remainingMs / 1000)) : null,
          isEphemeral: !!req.user.is_demo,
        }
      });
    } catch (err) {
      logger.error('[Demo] Info failed:', err);
      return res.status(500).json({ success: false, message: 'Failed to get demo info' });
    }
  }

  /**
   * POST /api/demo/extend
   * Perpanjang masa berlaku akun ephemeral 1x saja (anti-abuse).
   * Hanya berlaku untuk mode B (ephemeral) — shared demo tidak perlu extend.
   */
  async extend(req, res) {
    try {
      if (!req.user || !req.user.is_demo) {
        return res.status(403).json({ success: false, message: 'Not a demo user' });
      }

      // Cek apakah sudah pernah di-extend
      if (req.user.demo_extended) {
        return res.status(400).json({
          success: false,
          message: 'Akun demo hanya dapat diperpanjang 1 kali.'
        });
      }

      const newExpiry = new Date(Date.now() + DEMO_TTL_HOURS * 60 * 60 * 1000);
      await req.user.update({
        demo_expires_at: newExpiry,
        demo_extended: true,
      });

      return res.json({
        success: true,
        message: `Masa berlaku diperpanjang ${DEMO_TTL_HOURS} jam`,
        data: { expiresAt: newExpiry }
      });
    } catch (err) {
      logger.error('[Demo] Extend failed:', err);
      return res.status(500).json({ success: false, message: 'Failed to extend demo' });
    }
  }

  /**
   * Garbage collector — hapus akun demo ephemeral yang sudah expired.
   * Dipanggil dari CronService tiap 10 menit.
   */
  static async cleanupExpired() {
    try {
      const { Op } = require('sequelize');
      const expired = await User.findAll({
        where: {
          is_demo: true,
          demo_expires_at: { [Op.lt]: new Date() }
        }
      });

      if (expired.length === 0) return;

      const ids = expired.map(u => u.id);
      // Hapus activity log dulu supaya tidak jadi orphan
      await ActivityLog.destroy({ where: { user_id: ids } });
      await User.destroy({ where: { id: ids } });

      logger.info(`[Demo] Cleanup: hapus ${expired.length} akun demo expired`);
    } catch (err) {
      logger.error('[Demo] Cleanup failed:', err);
    }
  }
}

module.exports = new DemoController();
module.exports.cleanupExpired = DemoController.cleanupExpired;
