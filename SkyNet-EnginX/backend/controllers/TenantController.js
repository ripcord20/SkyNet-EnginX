/**
 * TenantController.js — Manajemen Tenant untuk Super Admin
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint untuk mengelola tenant (ISP reseller) dari dashboard super admin.
 */

const { Tenant, sequelize } = require('../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../utils/logger');

class TenantController {
  
  /**
   * GET /api/tenants
   * Daftar semua tenant dengan statistik penggunaan
   */
  async list(req, res) {
    try {
      const { page = 1, limit = 20, search, status } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      
      let where = {};
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { email: { [Op.like]: `%${search}%` } },
          { subdomain: { [Op.like]: `%${search}%` } }
        ];
      }
      if (status !== undefined) {
        where.is_active = status === 'active';
      }
      
      const { count, rows } = await Tenant.findAndCountAll({
        where,
        attributes: ['id', 'uuid', 'name', 'email', 'subdomain', 'contact_name', 
                     'contact_phone', 'subscription_plan', 'monthly_price',
                     'max_customers', 'max_users', 'is_active', 
                     'subscription_start', 'subscription_expires', 
                     'last_login', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset
      });
      
      // Hitung jumlah customer per tenant
      const tenantIds = rows.map(t => t.id);
      const [customerCounts] = await sequelize.query(`
        SELECT tenant_id, COUNT(*) as count 
        FROM customers 
        WHERE tenant_id IN (:tenantIds)
        GROUP BY tenant_id
      `, {
        replacements: { tenantIds },
        type: sequelize.QueryTypes.SELECT
      });
      
      const countMap = {};
      customerCounts.forEach(c => { countMap[c.tenant_id] = parseInt(c.count); });
      
      const tenantsWithStats = rows.map(t => ({
        ...t.toJSON(),
        customer_count: countMap[t.id] || 0,
        usage_percent: Math.round((countMap[t.id] || 0) / t.max_customers * 100)
      }));
      
      res.json({
        success: true,
        data: tenantsWithStats,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit)
      });
    } catch (error) {
      logger.error('[TenantController.list] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * GET /api/tenants/:id
   * Detail tenant spesifik
   */
  async detail(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id, {
        attributes: ['id', 'uuid', 'name', 'email', 'subdomain', 'contact_name',
                     'contact_phone', 'address', 'subscription_plan', 'monthly_price',
                     'max_customers', 'max_users', 'is_active', 
                     'subscription_start', 'subscription_expires',
                     'settings', 'notes', 'last_login', 'createdAt', 'updatedAt']
      });
      
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      // Statistik penggunaan
      const [stats] = await sequelize.query(`
        SELECT 
          (SELECT COUNT(*) FROM customers WHERE tenant_id = :id) as customer_count,
          (SELECT COUNT(*) FROM users WHERE tenant_id = :id) as user_count,
          (SELECT COUNT(*) FROM invoices WHERE tenant_id = :id) as invoice_count,
          (SELECT SUM(amount) FROM payments p 
           JOIN invoices i ON p.invoice_id = i.id 
           WHERE i.tenant_id = :id AND MONTH(p.payment_date) = MONTH(CURDATE())
          ) as monthly_revenue
      `, {
        replacements: { id: tenant.id },
        type: sequelize.QueryTypes.SELECT
      });
      
      res.json({
        success: true,
        data: {
          ...tenant.toJSON(),
          stats: stats || {}
        }
      });
    } catch (error) {
      logger.error('[TenantController.detail] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * POST /api/tenants
   * Buat tenant baru
   */
  async create(req, res) {
    const t = await sequelize.transaction();
    try {
      const {
        name, email, subdomain, password, contact_name, contact_phone,
        address, subscription_plan = 'basic', monthly_price,
        max_customers, max_users, subscription_expires, notes
      } = req.body;
      
      // Validasi input required
      if (!name || !email || !subdomain || !password) {
        await t.rollback();
        return res.status(400).json({
          success: false,
          message: 'Name, email, subdomain, and password are required'
        });
      }
      
      // Cek apakah subdomain atau email sudah ada
      const existing = await Tenant.findOne({
        where: {
          [Op.or]: [{ email }, { subdomain }]
        }
      });
      
      if (existing) {
        await t.rollback();
        return res.status(409).json({
          success: false,
          message: existing.email === email 
            ? 'Email already registered' 
            : 'Subdomain already taken'
        });
      }
      
      // Default values berdasarkan paket jika tidak specified
      const planDefaults = {
        basic: { max_customers: 100, max_users: 5, monthly_price: 0 },
        standard: { max_customers: 500, max_users: 15, monthly_price: 0 },
        premium: { max_customers: 2000, max_users: 50, monthly_price: 0 },
        custom: { max_customers: max_customers || 100, max_users: max_users || 5, monthly_price: monthly_price || 0 }
      };
      
      const defaults = planDefaults[subscription_plan] || planDefaults.basic;
      
      const tenantData = {
        name,
        email,
        subdomain: subdomain.toLowerCase(),
        password, // Akan di-hash oleh model hook
        contact_name,
        contact_phone,
        address,
        subscription_plan,
        monthly_price: monthly_price || defaults.monthly_price,
        max_customers: max_customers || defaults.max_customers,
        max_users: max_users || defaults.max_users,
        is_active: true,
        subscription_start: new Date().toISOString().split('T')[0],
        subscription_expires: subscription_expires || null,
        notes,
        settings: {}
      };
      
      const tenant = await Tenant.create(tenantData, { transaction: t });
      
      // Buat user admin pertama untuk tenant ini
      const adminUser = await sequelize.models.User.create({
        name: contact_name || name + ' Admin',
        email: email,
        password: password, // Akan di-hash oleh model hook
        role_id: 2, // Asumsi role_id 2 = admin tenant
        is_tenant_admin: true,
        tenant_id: tenant.id,
        is_active: true
      }, { transaction: t });
      
      await t.commit();
      
      res.status(201).json({
        success: true,
        message: 'Tenant created successfully',
        data: {
          ...tenant.toJSON(),
          admin_user: {
            id: adminUser.id,
            email: adminUser.email,
            name: adminUser.name
          }
        }
      });
    } catch (error) {
      await t.rollback();
      logger.error('[TenantController.create] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * PUT /api/tenants/:id
   * Update tenant
   */
  async update(req, res) {
    const t = await sequelize.transaction();
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        await t.rollback();
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      const allowedFields = [
        'name', 'email', 'subdomain', 'contact_name', 'contact_phone',
        'address', 'subscription_plan', 'monthly_price', 'max_customers',
        'max_users', 'is_active', 'subscription_expires', 'settings', 'notes'
      ];
      
      const updates = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }
      
      // Handle password update separately
      if (req.body.password) {
        updates.password = req.body.password;
      }
      
      // Subdomain harus lowercase
      if (updates.subdomain) {
        updates.subdomain = updates.subdomain.toLowerCase();
      }
      
      await tenant.update(updates, { transaction: t });
      
      await t.commit();
      
      res.json({
        success: true,
        message: 'Tenant updated successfully',
        data: tenant.toJSON()
      });
    } catch (error) {
      await t.rollback();
      logger.error('[TenantController.update] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * DELETE /api/tenants/:id
   * Hapus tenant (soft delete dengan cascade)
   */
  async delete(req, res) {
    const t = await sequelize.transaction();
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        await t.rollback();
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      // Prevent deleting master tenant
      if (tenant.id === 1) {
        await t.rollback();
        return res.status(403).json({
          success: false,
          message: 'Cannot delete master tenant'
        });
      }
      
      // Delete associated users first
      await sequelize.models.User.destroy({
        where: { tenant_id: tenant.id },
        transaction: t
      });
      
      // Then delete tenant (cascade will handle other tables)
      await tenant.destroy({ transaction: t });
      
      await t.commit();
      
      res.json({
        success: true,
        message: 'Tenant deleted successfully'
      });
    } catch (error) {
      await t.rollback();
      logger.error('[TenantController.delete] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * POST /api/tenants/:id/suspend
   * Suspend/activate tenant
   */
  async toggleStatus(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      const { is_active } = req.body;
      if (typeof is_active !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'is_active must be a boolean'
        });
      }
      
      await tenant.update({ is_active });
      
      res.json({
        success: true,
        message: `Tenant ${is_active ? 'activated' : 'suspended'} successfully`,
        data: tenant.toJSON()
      });
    } catch (error) {
      logger.error('[TenantController.toggleStatus] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
  
  /**
   * POST /api/tenants/:id/extend
   * Extend subscription expiry date
   */
  async extendSubscription(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      const { days } = req.body;
      if (!days || days <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Days must be a positive number'
        });
      }
      
      const currentExpiry = tenant.subscription_expires 
        ? new Date(tenant.subscription_expires) 
        : new Date();
      
      const newExpiry = new Date(currentExpiry);
      newExpiry.setDate(newExpiry.getDate() + days);
      
      await tenant.update({
        subscription_expires: newExpiry.toISOString().split('T')[0]
      });
      
      res.json({
        success: true,
        message: `Subscription extended by ${days} days`,
        data: {
          previous_expiry: tenant.subscription_expires,
          new_expiry: newExpiry.toISOString().split('T')[0]
        }
      });
    } catch (error) {
      logger.error('[TenantController.extendSubscription] Error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new TenantController();
