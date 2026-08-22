/**
 * portalAuth.js — Middleware untuk Customer Portal
 */
const jwt = require('jsonwebtoken');
const { Customer } = require('../models');

const portalAuth = async (req, res, next) => {
  try {
    let token = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    if (!token && req.cookies && req.cookies.portal_token) {
      token = req.cookies.portal_token;
    }

    if (!token) {
      const isApi = req.path.startsWith('/api') ||
        req.headers.accept?.includes('application/json') ||
        req.xhr;
      if (isApi) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      return res.redirect('/portal/login');
    }

    // Verifikasi token dengan secret yang SAMA seperti saat login/restore-cookie
    // menandatanganinya: JWT_PORTAL_SECRET bila di-set, fallback ke JWT_SECRET.
    // (Sebelumnya middleware ini hanya memakai JWT_SECRET → bila operator meng-set
    //  JWT_PORTAL_SECRET, login sukses tapi semua request dashboard gagal verify.)
    const portalSecret = process.env.JWT_PORTAL_SECRET || process.env.JWT_SECRET;
    const decoded = jwt.verify(token, portalSecret);

    if (decoded.type !== 'customer') {
      return res.status(403).json({ success: false, message: 'Invalid token type' });
    }

    const customer = await Customer.findByPk(decoded.id);
    if (!customer || !customer.portal_enabled) {
      return res.status(401).json({ success: false, message: 'Account disabled' });
    }
    // Tolak akun yang di-suspend meski token masih valid (suspend bisa terjadi
    // SETELAH login; tanpa cek ini token 24 jam tetap bisa dipakai).
    if (customer.status === 'suspended') {
      const isApi = req.path.startsWith('/api') || req.headers.accept?.includes('application/json') || req.xhr;
      if (isApi) return res.status(403).json({ success: false, message: 'Akun Anda telah di-suspend. Hubungi ISP.' });
      return res.redirect('/portal/login');
    }

    req.portalUser = {
      id: customer.id,
      customer_id: customer.customer_id,
      name: customer.name,
      status: customer.status
    };

    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      const isApi = req.path.startsWith('/api') || req.headers.accept?.includes('application/json');
      if (isApi) return res.status(401).json({ success: false, message: 'Token expired' });
      return res.redirect('/portal/login');
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

module.exports = { portalAuth };
