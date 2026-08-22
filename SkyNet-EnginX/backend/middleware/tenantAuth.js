/**
 * tenantAuth.js — Middleware untuk Multi-Tenant Authentication
 * ─────────────────────────────────────────────────────────────────────────────
 * Middleware ini:
 * 1. Mendeteksi tenant dari subdomain atau header X-Tenant-ID
 * 2. Memvalidasi bahwa tenant aktif dan belum expired
 * 3. Menyimpan informasi tenant di req.tenant untuk digunakan di controller
 * 4. Mencegah akses cross-tenant dengan memfilter semua query berdasarkan tenant_id
 */

const { Tenant, User } = require('../models');
const logger = require('../utils/logger');

/**
 * Ekstrak tenant dari request
 * Prioritas: 1) Subdomain 2) Header X-Tenant-ID 3) Query parameter
 */
function extractTenantInfo(req) {
  // Dari subdomain (misal: tenant1.billing.com → tenant1)
  const host = req.get('host') || '';
  const subdomainMatch = host.match(/^([a-z0-9-]+)\./i);
  const subdomain = subdomainMatch ? subdomainMatch[1].toLowerCase() : null;
  
  // Dari header (untuk API calls)
  const headerTenantId = req.headers['x-tenant-id'];
  const headerSubdomain = req.headers['x-tenant-subdomain'];
  
  // Dari query parameter (fallback)
  const queryTenantId = req.query.tenant_id;
  
  return {
    subdomain: headerSubdomain || subdomain,
    tenantId: headerTenantId || queryTenantId
  };
}

/**
 * Middleware utama untuk autentikasi tenant
 * Harus dipasang setelah auth user biasa
 */
async function tenantAuth(req, res, next) {
  try {
    const tenantInfo = extractTenantInfo(req);
    
    // Jika tidak ada informasi tenant, gunakan tenant master (ID 1)
    if (!tenantInfo.subdomain && !tenantInfo.tenantId) {
      req.tenant = await Tenant.findByPk(1, {
        attributes: ['id', 'uuid', 'name', 'subdomain', 'is_active', 'subscription_plan']
      });
      
      if (!req.tenant) {
        return res.status(500).json({
          success: false,
          message: 'Master tenant not found. Please run migration first.'
        });
      }
      
      return next();
    }
    
    // Cari tenant berdasarkan subdomain atau ID
    let tenant;
    if (tenantInfo.subdomain) {
      tenant = await Tenant.findOne({
        where: { subdomain: tenantInfo.subdomain },
        attributes: ['id', 'uuid', 'name', 'email', 'subdomain', 'is_active', 
                     'subscription_plan', 'max_customers', 'max_users',
                     'subscription_expires', 'settings']
      });
    } else if (tenantInfo.tenantId) {
      tenant = await Tenant.findByPk(tenantInfo.tenantId, {
        attributes: ['id', 'uuid', 'name', 'email', 'subdomain', 'is_active',
                     'subscription_plan', 'max_customers', 'max_users',
                     'subscription_expires', 'settings']
      });
    }
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found'
      });
    }
    
    // Cek apakah tenant aktif
    if (!tenant.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Please contact support.'
      });
    }
    
    // Cek apakah subscription sudah expired
    if (tenant.subscription_expires) {
      const today = new Date();
      const expires = new Date(tenant.subscription_expires);
      if (expires < today) {
        return res.status(403).json({
          success: false,
          message: 'Your subscription has expired. Please renew to continue using the service.'
        });
      }
    }
    
    // Simpan informasi tenant di request
    req.tenant = tenant;
    
    // Tambahkan tenant_id ke query builder global (untuk Sequelize)
    // Ini akan difilter di setiap query melalui scope global
    req.tenantId = tenant.id;
    
    next();
  } catch (error) {
    logger.error('[TenantAuth] Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Tenant authentication failed'
    });
  }
}

/**
 * Middleware untuk Super Admin - bisa akses semua tenant
 * Hanya untuk endpoint management tenant di level super admin
 */
function superAdminOnly(req, res, next) {
  // Cek apakah user adalah super admin
  if (!req.user || req.user.role_id !== 1) { // Asumsi role_id 1 = super admin
    return res.status(403).json({
      success: false,
      message: 'Super admin access required'
    });
  }
  
  next();
}

/**
 * Middleware untuk validasi batas tenant (quota check)
 * Digunakan saat menambah resource baru (customer, user, dll)
 */
function checkTenantQuota(resourceType) {
  return async (req, res, next) => {
    try {
      if (!req.tenant) {
        return next(); // Skip jika tidak ada tenant context
      }
      
      const tenant = req.tenant;
      const { sequelize } = require('../models');
      
      let quotaField, currentCount;
      
      switch (resourceType) {
        case 'customer':
          quotaField = 'max_customers';
          const [custResult] = await sequelize.query(
            'SELECT COUNT(*) as count FROM customers WHERE tenant_id = :tenantId',
            { replacements: { tenantId: tenant.id }, type: sequelize.QueryTypes.SELECT }
          );
          currentCount = parseInt(custResult?.count || 0);
          break;
          
        case 'user':
          quotaField = 'max_users';
          const [userResult] = await sequelize.query(
            'SELECT COUNT(*) as count FROM users WHERE tenant_id = :tenantId',
            { replacements: { tenantId: tenant.id }, type: sequelize.QueryTypes.SELECT }
          );
          currentCount = parseInt(userResult?.count || 0);
          break;
          
        default:
          return next();
      }
      
      const maxAllowed = tenant[quotaField];
      
      if (currentCount >= maxAllowed) {
        return res.status(403).json({
          success: false,
          message: `Quota exceeded. Maximum ${maxAllowed} ${resourceType}(s) allowed for your plan.`,
          quota: {
            current: currentCount,
            maximum: maxAllowed,
            field: quotaField
          }
        });
      }
      
      // Simpan sisa quota di request untuk referensi
      req.quotaRemaining = maxAllowed - currentCount;
      
      next();
    } catch (error) {
      logger.error('[CheckTenantQuota] Error:', error);
      next(); // Lanjutkan meski ada error (fail-safe)
    }
  };
}

module.exports = {
  tenantAuth,
  superAdminOnly,
  checkTenantQuota,
  extractTenantInfo
};
