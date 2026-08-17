/**
 * resellerAuth.js — Middleware untuk Dashboard Reseller Voucher.
 * ─────────────────────────────────────────────────────────────────────────────
 * Pola sama dengan portalAuth: token JWT type='reseller', cookie terpisah
 * `reseller_token` dengan path=/reseller. Sign pakai JWT_RESELLER_SECRET
 * (fallback ke JWT_SECRET untuk migrasi tanpa downtime).
 */
const jwt = require('jsonwebtoken');
const { Reseller } = require('../models');

const resellerSecret = () =>
  process.env.JWT_RESELLER_SECRET || process.env.JWT_SECRET;

const resellerAuth = async (req, res, next) => {
  try {
    let token = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    if (!token && req.cookies && req.cookies.reseller_token) {
      token = req.cookies.reseller_token;
    }

    const isApi = req.path.startsWith('/api') ||
      req.headers.accept?.includes('application/json') ||
      req.xhr;

    if (!token) {
      if (isApi) return res.status(401).json({ success: false, message: 'Authentication required' });
      return res.redirect('/reseller/login');
    }

    const decoded = jwt.verify(token, resellerSecret());
    if (decoded.type !== 'reseller') {
      return res.status(403).json({ success: false, message: 'Invalid token type' });
    }

    const reseller = await Reseller.findByPk(decoded.id, {
      include: [{ association: 'device', required: false }]
    });
    if (!reseller || !reseller.is_active) {
      if (isApi) return res.status(401).json({ success: false, message: 'Akun dinonaktifkan' });
      return res.redirect('/reseller/login');
    }

    req.reseller = reseller;
    next();
  } catch (e) {
    const isApi = req.path.startsWith('/api') || req.headers.accept?.includes('application/json');
    if (e.name === 'TokenExpiredError') {
      if (isApi) return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
      return res.redirect('/reseller/login');
    }
    if (isApi) return res.status(401).json({ success: false, message: 'Invalid token' });
    return res.redirect('/reseller/login');
  }
};

module.exports = { resellerAuth, resellerSecret };
