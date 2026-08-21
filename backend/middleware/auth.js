const jwt = require('jsonwebtoken');
const { User, Role, Permission } = require('../models');

// Bangun URL redirect ke /login sambil menyimpan tujuan awal (?next=...).
// Hanya path internal yang aman (diawali '/', bukan '//' atau 'http') yang
// disimpan, supaya tidak bisa dipakai open-redirect ke domain luar.
function buildLoginRedirect(req) {
  try {
    const original = req.originalUrl || req.url || '';
    const safe = typeof original === 'string'
      && original.startsWith('/')
      && !original.startsWith('//')
      && !original.startsWith('/login');
    if (safe) {
      return '/login?next=' + encodeURIComponent(original);
    }
  } catch (_) { /* fallthrough */ }
  return '/login';
}

// Verify JWT Token
const authenticate = async (req, res, next) => {
  try {
    let token = null;

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // Check cookie
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      // Deteksi apakah request dari fetch/AJAX (bukan page load browser)
      const isApiRequest = req.xhr
        || req.headers.accept?.includes('application/json')
        || req.headers['content-type']?.includes('application/json')
        || req.headers['x-requested-with'] === 'XMLHttpRequest'
        || req.path.startsWith('/api');
      if (isApiRequest) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      return res.redirect(buildLoginRedirect(req));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await User.findByPk(decoded.id, {
      include: [{
        model: Role,
        as: 'role',
        include: [{
          model: Permission,
          as: 'permissions',
          through: { attributes: [] }
        }]
      }]
    });

    if (!user || !user.is_active) {
      const isApiRequest = req.xhr
        || req.headers.accept?.includes('application/json')
        || req.headers['content-type']?.includes('application/json')
        || req.path.startsWith('/api');
      if (isApiRequest) {
        return res.status(401).json({ success: false, message: 'User not found or inactive' });
      }
      return res.redirect(buildLoginRedirect(req));
    }

    req.user = user;
    req.userPermissions = user.role?.permissions?.map(p => p.name) || [];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      return res.redirect(buildLoginRedirect(req));
    }
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    return res.redirect(buildLoginRedirect(req));
  }
};

// Check Role
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const userRole = (req.user.role.name || '').toLowerCase();
    const allowed  = roles.map(r => r.toLowerCase());
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ success: false, message: 'Insufficient role permissions' });
    }
    next();
  };
};

// Check Permission
const hasPermission = (...permissions) => {
  return (req, res, next) => {
    if (!req.userPermissions) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Superadmin bypasses all permission checks
    if (req.user.role?.name === 'superadmin') {
      return next();
    }
    // ── Role-based grant: izin tambahan yang melekat ke role tertentu tanpa
    //    perlu seed permission ke DB. Role 'finance' kini boleh mengelola
    //    pelanggan penuh (create/update/delete) seperti admin.
    const roleName = (req.user.role?.name || '').toLowerCase();
    const ROLE_GRANTS = {
      finance: ['customer_view', 'customer_create', 'customer_update', 'customer_delete'],
    };
    const granted = ROLE_GRANTS[roleName] || [];
    if (granted.length && permissions.some(p => granted.includes(p))) {
      return next();
    }
    const hasAny = permissions.some(p => req.userPermissions.includes(p));
    if (!hasAny) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
};

// Optional auth (for pages that work with or without auth)
const optionalAuth = async (req, res, next) => {
  try {
    let token = req.cookies?.token || req.headers.authorization?.substring(7);
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id, {
        include: [{ model: Role, as: 'role' }]
      });
      if (user && user.is_active) {
        req.user = user;
      }
    }
  } catch (e) {
    // Ignore auth errors for optional auth
  }
  next();
};

module.exports = { authenticate, authorize, hasPermission, optionalAuth };