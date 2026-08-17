/**
 * DemoResetService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Service untuk me-reset state akun demo secara berkala.
 *
 * Tujuan: walaupun demo user sudah read-only, tetap saja:
 *   - Profile dia (nama, phone) bisa diubah via /profile
 *   - Dashboard layout dia bisa diubah
 *   - ActivityLog numpuk dari dia
 *   - Kalau nanti ada fitur yang di-whitelist, bisa bocor state-nya
 *
 * Service ini reset itu semua ke kondisi bersih tiap interval tertentu
 * (mis. tiap 1 jam) lewat CronService yang sudah ada.
 *
 * Cara integrasi:
 *   Di backend/services/CronService.js, tambahkan job:
 *
 *     const DemoResetService = require('./DemoResetService');
 *     cron.schedule('0 * * * *', () => DemoResetService.reset());
 */

const { User, Role, ActivityLog } = require('../models');
const logger = require('../utils/logger');

const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@ispnetops.com';
const DEMO_NAME  = process.env.DEMO_NAME  || 'Demo User';
const DEMO_PASS  = process.env.SEED_DEMO_PASS || 'demo12345';

class DemoResetService {
  async reset() {
    try {
      const demoRole = await Role.findOne({ where: { name: 'demo' } });
      if (!demoRole) {
        logger.warn('[DemoReset] Role demo tidak ditemukan, skip reset');
        return;
      }

      const demoUser = await User.findOne({ where: { email: DEMO_EMAIL } });
      if (!demoUser) {
        logger.warn('[DemoReset] User demo tidak ditemukan, skip reset');
        return;
      }

      // 1. Kembalikan field user ke nilai default
      demoUser.name = DEMO_NAME;
      demoUser.phone = '08000000000';
      demoUser.avatar = null;
      demoUser.is_active = true;
      demoUser.role_id = demoRole.id;
      demoUser.password = DEMO_PASS;   // hook akan re-hash
      await demoUser.save();

      // 2. Hapus activity log dari demo user (opsional — biar tidak numpuk)
      await ActivityLog.destroy({ where: { user_id: demoUser.id } });

      // 3. Hapus refresh token — paksa logout semua sesi demo aktif
      demoUser.refresh_token = null;
      await demoUser.save();

      logger.info('[DemoReset] Akun demo berhasil di-reset');
    } catch (err) {
      logger.error('[DemoReset] Gagal reset akun demo:', err);
    }
  }
}

module.exports = new DemoResetService();
