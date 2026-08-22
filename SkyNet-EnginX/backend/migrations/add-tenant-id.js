/**
 * Migration: Tambah kolom tenant_id untuk Multi-Tenant Support
 * ─────────────────────────────────────────────────────────────────────────────
 * Jalankan migration ini untuk menambahkan kolom tenant_id ke tabel-tabel utama.
 * Semua data existing akan di-set tenant_id = 1 (tenant default/master).
 * 
 * CARA MENGGUNAKAN:
 * 1. Backup database terlebih dahulu!
 * 2. Jalankan: node backend/migrations/add-tenant-id.js
 * 3. Verifikasi hasil dengan query: SELECT COUNT(*), tenant_id FROM customers GROUP BY tenant_id;
 */

const { sequelize } = require('../models');

const TABLES_WITH_TENANT = [
  'customers',
  'packages',
  'invoices',
  'payments',
  'devices',
  'users',
  'assets',
  'tickets',
  'work_orders'
];

async function migrate() {
  const transaction = await sequelize.transaction();
  
  try {
    console.log('🚀 Starting multi-tenant migration...');
    
    // 1. Buat tabel tenants jika belum ada
    console.log('📦 Creating tenants table...');
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        uuid CHAR(36) UNIQUE,
        name VARCHAR(150) NOT NULL,
        email VARCHAR(150) NOT NULL UNIQUE,
        subdomain VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        contact_name VARCHAR(100),
        contact_phone VARCHAR(20),
        address TEXT,
        subscription_plan ENUM('basic', 'standard', 'premium', 'custom') DEFAULT 'basic',
        monthly_price DECIMAL(12,2) DEFAULT 0,
        max_customers INT DEFAULT 100,
        max_users INT DEFAULT 5,
        is_active BOOLEAN DEFAULT TRUE,
        subscription_start DATE NOT NULL,
        subscription_expires DATE,
        api_token VARCHAR(64) UNIQUE,
        logo_path VARCHAR(255),
        settings JSON DEFAULT '{}',
        notes TEXT,
        last_login DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_subdomain (subdomain),
        INDEX idx_email (email),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `, { transaction });
    
    // 2. Buat tenant default (master) dengan ID 1
    console.log('👤 Creating default master tenant...');
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const defaultPassword = await bcrypt.hash('admin123', 12);
    const apiToken = crypto.randomBytes(32).toString('hex');
    
    await sequelize.query(`
      INSERT INTO tenants (uuid, name, email, subdomain, password, subscription_plan, 
                           monthly_price, max_customers, max_users, is_active, 
                           subscription_start, api_token, created_at, updated_at)
      VALUES (UUID(), 'Master ISP', 'admin@master.local', 'master', ?, 'premium', 
              0, 999999, 999, TRUE, CURDATE(), ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE name=VALUES(name);
    `, { replacements: [defaultPassword, apiToken], transaction });
    
    // 3. Tambahkan kolom tenant_id ke setiap tabel
    for (const table of TABLES_WITH_TENANT) {
      console.log(`➕ Adding tenant_id to ${table}...`);
      
      // Cek apakah kolom sudah ada
      const [columns] = await sequelize.query(`
        SHOW COLUMNS FROM ${table} LIKE 'tenant_id';
      `, { transaction });
      
      if (columns.length === 0) {
        // Tambahkan kolom tenant_id
        await sequelize.query(`
          ALTER TABLE ${table} 
          ADD COLUMN tenant_id INT UNSIGNED DEFAULT 1 AFTER id,
          ADD INDEX idx_tenant_id (tenant_id);
        `, { transaction });
        
        // Set semua data existing ke tenant_id = 1 (master tenant)
        await sequelize.query(`
          UPDATE ${table} SET tenant_id = 1 WHERE tenant_id IS NULL;
        `, { transaction });
      } else {
        console.log(`   ⏭️  tenant_id already exists in ${table}`);
      }
    }
    
    // 4. Khusus untuk tabel users - tambahkan field is_tenant_admin
    console.log('🔐 Updating users table...');
    const [userColumns] = await sequelize.query(`
      SHOW COLUMNS FROM users LIKE 'is_tenant_admin';
    `, { transaction });
    
    if (userColumns.length === 0) {
      await sequelize.query(`
        ALTER TABLE users 
        ADD COLUMN is_tenant_admin BOOLEAN DEFAULT FALSE AFTER role_id,
        ADD COLUMN tenant_id INT UNSIGNED DEFAULT 1 AFTER is_tenant_admin,
        ADD INDEX idx_user_tenant (tenant_id, is_tenant_admin);
      `, { transaction });
    }
    
    await transaction.commit();
    console.log('✅ Migration completed successfully!');
    console.log('📝 Default tenant credentials:');
    console.log('   Subdomain: master');
    console.log('   Email: admin@master.local');
    console.log('   Password: admin123');
    console.log('');
    console.log('⚠️  IMPORTANT: Change the default password immediately!');
    
  } catch (error) {
    await transaction.rollback();
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Jalankan migration jika file ini dieksekusi langsung
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
