/**
 * patch: backend/controllers/AuthController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Perubahan terhadap AuthController existing:
 *   1. Session JWT untuk user demo lebih pendek (2 jam, bukan 24 jam)
 *   2. User demo tidak dapat refresh token (biar pasti expired tepat waktu)
 *   3. Login response menandai `isDemo: true` supaya frontend bisa tampil banner
 *   4. `updateProfile` dan `changePassword` ditolak untuk demo (safety net
 *      selain demoGuard) — user demo tetap bisa lihat profile tapi tidak ubah
 *
 * File di bawah adalah VERSI LENGKAP. Ganti total isi
 * backend/controllers/AuthController.js dengan ini.
 */

const jwt = require('jsonwebtoken');
const { User, Role, ActivityLog } = require('../models');
const logger = require('../utils/logger');

const DEMO_JWT_EXPIRY = process.env.DEMO_JWT_EXPIRY || '2h';

// ── Masa berlaku sesi ────────────────────────────────────────────────
// User biasa: 30 hari (bisa dioverride via .env JWT_EXPIRY, mis. '30d').
// Setelah lewat, user perlu login ulang. User demo: 2 jam (dipaksa pendek).
// Nilai maxAge cookie disamakan dengan expiry token agar konsisten.
const REGULAR_JWT_EXPIRY = process.env.JWT_EXPIRY || '30d';
const REGULAR_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 hari (ms)
const DEMO_COOKIE_MAX_AGE = 2 * 60 * 60 * 1000;          // 2 jam (ms)

function isDemoRole(user) {
  return (user?.role?.name || '').toLowerCase() === 'demo';
}

class AuthController {
  // Login
  async login(req, res) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required' });
      }

      const user = await User.findOne({
        where: { email },
        include: [{ model: Role, as: 'role' }]
      });

      if (!user || !user.is_active) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // Kalau user demo ephemeral dan sudah expired, tolak login
      if (user.is_demo && user.demo_expires_at && new Date(user.demo_expires_at) < new Date()) {
        return res.status(401).json({
          success: false,
          message: 'Sesi akun demo telah berakhir. Silakan buat akun demo baru.'
        });
      }

      const isValid = await user.validatePassword(password);
      if (!isValid) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const isDemo = isDemoRole(user);
      const tokenExpiry = isDemo ? DEMO_JWT_EXPIRY : REGULAR_JWT_EXPIRY;

      // Generate tokens
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role?.name, isDemo },
        process.env.JWT_SECRET,
        { expiresIn: tokenExpiry }
      );

      // Refresh token TIDAK diberikan untuk user demo — biar session pasti expired
      let refreshToken = null;
      if (!isDemo) {
        refreshToken = jwt.sign(
          { id: user.id },
          process.env.JWT_REFRESH_SECRET,
          { expiresIn: process.env.JWT_REFRESH_EXPIRY || '7d' }
        );
      }

      await user.update({
        last_login: new Date(),
        refresh_token: refreshToken
      });

      // Log activity
      await ActivityLog.create({
        user_id: user.id,
        action: isDemo ? 'demo_login' : 'login',
        module: 'auth',
        description: `User ${user.name} logged in${isDemo ? ' (demo)' : ''}`,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      });

      // Set cookie — maxAge sesuai expiry token.
      // `secure` di-derive dari req.secure yang sudah respect X-Forwarded-Proto
      // (karena trust proxy ON di server.js). Lebih akurat daripada APP_ENV
      // karena: (a) dev di laptop tetap http://localhost = cookie tidak butuh
      // secure, (b) production via nginx HTTPS = secure dipasang otomatis.
      // sameSite=lax supaya navigasi cross-page tetap kirim cookie tapi tetap
      // proteksi terhadap CSRF.
      const cookieMaxAge = isDemo
        ? DEMO_COOKIE_MAX_AGE        // 2 jam untuk demo
        : REGULAR_COOKIE_MAX_AGE;    // 30 hari untuk user biasa

      res.cookie('token', token, {
        httpOnly: true,
        secure: !!req.secure,
        sameSite: 'lax',
        maxAge: cookieMaxAge
      });

      // Tentukan halaman tujuan berdasar role
      const roleName = (user.role?.name || '').toLowerCase();
      let redirect = '/dashboard';
      if (roleName === 'technician') redirect = '/technician';
      else if (roleName === 'finance')    redirect = '/finance';
      else if (roleName === 'noc')        redirect = '/noc';
      // demo → default ke /dashboard (tapi sebagian besar menu akan auto-disabled)

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: user.toJSON(),
          token,
          refreshToken,
          redirect,
          isDemo,
          demoExpiresAt: user.demo_expires_at || null
        }
      });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ success: false, message: 'Login failed' });
    }
  }

  /**
   * POST /auth/restore-cookie
   * ─────────────────────────────────────────────────────────────
   * Restore HttpOnly cookie dari Bearer token di header. Dipakai oleh
   * halaman login (frontend) untuk auto-login: kalau localStorage masih
   * punya token tapi cookie hilang (mis. setelah clear cookies, atau
   * sesi cookie expire lebih cepat dari token JWT), client kirim token
   * ke endpoint ini, server validasi & re-set cookie supaya page load
   * berikutnya bisa langsung authenticated.
   *
   * Token diambil dari header Authorization Bearer (BUKAN dari body)
   * supaya konsisten dengan pattern API lain.
   * Response: { success, redirect } — kalau success, frontend redirect ke
   * URL home sesuai role.
   */
  async restoreCookie(req, res) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Bearer token required' });
      }
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id, {
        include: [{ model: Role, as: 'role' }]
      });
      if (!user || !user.is_active) {
        return res.status(401).json({ success: false, message: 'User not found or inactive' });
      }
      // Re-set cookie pakai token yg sama (tidak generate baru — token belum expire)
      const isDemo = isDemoRole(user);
      const cookieMaxAge = isDemo ? DEMO_COOKIE_MAX_AGE : REGULAR_COOKIE_MAX_AGE;
      res.cookie('token', token, {
        httpOnly: true,
        secure: !!req.secure,
        sameSite: 'lax',
        maxAge: cookieMaxAge
      });
      const roleName = (user.role?.name || '').toLowerCase();
      let redirect = '/dashboard';
      if (roleName === 'technician') redirect = '/technician';
      else if (roleName === 'finance')    redirect = '/finance';
      else if (roleName === 'noc')        redirect = '/noc';
      return res.json({ success: true, redirect });
    } catch (e) {
      // TokenExpiredError, JsonWebTokenError, dll — semua di-treat invalid
      return res.status(401).json({ success: false, message: 'Token invalid or expired' });
    }
  }

  // Refresh Token
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ success: false, message: 'Refresh token required' });
      }

      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      const user = await User.findOne({
        where: { id: decoded.id, refresh_token: refreshToken },
        include: [{ model: Role, as: 'role' }]
      });

      if (!user || !user.is_active) {
        return res.status(401).json({ success: false, message: 'Invalid refresh token' });
      }

      // User demo tidak boleh refresh — sesi harus expire natural
      if (isDemoRole(user)) {
        return res.status(403).json({
          success: false,
          message: 'Demo sessions cannot be refreshed.'
        });
      }

      const newToken = jwt.sign(
        { id: user.id, email: user.email, role: user.role?.name },
        process.env.JWT_SECRET,
        { expiresIn: REGULAR_JWT_EXPIRY }
      );

      res.cookie('token', newToken, {
        httpOnly: true,
        secure: !!req.secure,
        sameSite: 'lax',
        maxAge: REGULAR_COOKIE_MAX_AGE
      });

      res.json({ success: true, data: { token: newToken } });
    } catch (error) {
      res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
  }

  // Logout
  async logout(req, res) {
    try {
      if (req.user) {
        await req.user.update({ refresh_token: null });
        await ActivityLog.create({
          user_id: req.user.id,
          action: 'logout',
          module: 'auth',
          description: `User ${req.user.name} logged out`,
          ip_address: req.ip
        });
      }
      // PENTING: clearCookie harus pakai opsi (httpOnly, sameSite, secure,
      // path) yang SAMA dengan saat cookie di-set. Kalau berbeda, browser
      // tidak akan recognize cookie yang di-clear sebagai cookie yang sama,
      // dan cookie token tetap ada — user pikir sudah logout tapi sebenarnya
      // masih punya cookie valid, lalu route /login auto-redirect kembali
      // ke dashboard (lihat patch session-persist).
      res.clearCookie('token', {
        httpOnly: true,
        secure: !!req.secure,
        sameSite: 'lax',
        path: '/'
      });
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Logout failed' });
    }
  }

  // Get current user profile
  async profile(req, res) {
    const profile = req.user.toJSON();
    if (isDemoRole(req.user)) {
      profile.isDemo = true;
      profile.demoExpiresAt = req.user.demo_expires_at;
    }
    res.json({ success: true, data: profile });
  }

  // Update profile
  async updateProfile(req, res) {
    try {
      // Demo user tidak boleh ubah profile
      if (isDemoRole(req.user)) {
        return res.status(403).json({
          success: false,
          code: 'DEMO_READONLY',
          message: 'Akun demo tidak dapat mengubah profil.'
        });
      }

      const { name, phone, email } = req.body;
      await req.user.update({ name, phone, email });
      res.json({ success: true, message: 'Profile updated', data: req.user.toJSON() });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Update failed' });
    }
  }

  // Change password
  async changePassword(req, res) {
    try {
      // Demo user tidak boleh ubah password
      if (isDemoRole(req.user)) {
        return res.status(403).json({
          success: false,
          code: 'DEMO_READONLY',
          message: 'Akun demo tidak dapat mengubah password.'
        });
      }

      const { currentPassword, newPassword } = req.body;
      const isValid = await req.user.validatePassword(currentPassword);
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect' });
      }
      await req.user.update({ password: newPassword });
      res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Password change failed' });
    }
  }
}

module.exports = new AuthController();
