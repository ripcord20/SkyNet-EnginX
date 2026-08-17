#!/usr/bin/env node
/*
 * Dev-only bootstrap for the Cloud Agent environment.
 *
 * Ensures the database schema exists (mirrors the sync the app performs on
 * startup in development) and creates a default superadmin login so the app
 * is immediately usable. Idempotent: safe to run on every environment build.
 *
 * This lives under .cursor/ because it is environment/dev tooling, not part of
 * the application itself.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const db = require(path.join(__dirname, '..', 'backend', 'models'));

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@local.test';
const ADMIN_PASS = process.env.SEED_ADMIN_PASS || 'admin123';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Local Admin';

// Strip DB-level foreign key constraints from every model attribute before
// syncing. Several models declare unsigned integer columns (e.g.
// customers.mikrotik_id) that are wired via associations to signed integer
// primary keys (e.g. devices.id). MySQL/MariaDB reject such a foreign key with
// errno 150 ("incorrectly formed") because the signedness does not match, which
// makes a from-scratch `sequelize.sync()` impossible. Since Sequelize resolves
// every foreign key — whether declared inline or through an association — into
// the attribute's `references` metadata, deleting it here lets all tables be
// created cleanly. The foreign key *columns* are untouched, and Sequelize's
// association layer (eager loading via `include`, etc.) continues to work; only
// the database-level constraint enforcement is omitted for the dev schema.
function stripForeignKeys(sequelize) {
  let removed = 0;
  for (const modelName of Object.keys(sequelize.models)) {
    const model = sequelize.models[modelName];
    const attrs = model.rawAttributes || {};
    for (const attr of Object.values(attrs)) {
      if (attr && attr.references) {
        delete attr.references;
        delete attr.onDelete;
        delete attr.onUpdate;
        removed += 1;
      }
    }
  }
  return removed;
}

async function main() {
  await db.sequelize.authenticate();
  console.log('[seed-dev] DB connection OK');

  const removed = stripForeignKeys(db.sequelize);
  console.log(`[seed-dev] Stripped ${removed} DB-level foreign key(s) for schema creation`);

  // Create/verify all tables. Sync each model individually and tolerate
  // per-model failures instead of aborting the whole run. A few models carry
  // latent definition bugs (e.g. an index declared on `createdAt` while the
  // column is `created_at` under the global `underscored: true`) that make a
  // single monolithic sync throw. Because foreign keys are stripped above,
  // table creation order does not matter, so per-model isolation lets every
  // healthy table be created while noisy edge cases are logged and skipped
  // (the table itself is still created before an index step fails). This
  // mirrors the `safeSync` pattern the app already uses on startup.
  const modelNames = Object.keys(db.sequelize.models);
  let ok = 0;
  const failed = [];
  for (const name of modelNames) {
    try {
      await db.sequelize.models[name].sync({ alter: false });
      ok += 1;
    } catch (e) {
      failed.push(`${name}: ${e.message}`);
    }
  }
  console.log(`[seed-dev] Schema synced (${ok}/${modelNames.length} models OK)`);
  if (failed.length) {
    console.log('[seed-dev] Non-fatal per-model sync warnings:');
    for (const f of failed) console.log('  - ' + f);
  }

  const [role] = await db.Role.findOrCreate({
    where: { name: 'superadmin' },
    defaults: {
      name: 'superadmin',
      display_name: 'Super Admin',
      description: 'Full system access',
      is_system: true,
    },
  });

  const existing = await db.User.findOne({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`[seed-dev] Admin user already exists: ${ADMIN_EMAIL}`);
  } else {
    await db.User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: ADMIN_PASS, // hashed by model beforeCreate hook
      role_id: role.id,
      is_active: true,
    });
    console.log(`[seed-dev] Created admin user: ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
  }

  await db.sequelize.close();
  console.log('[seed-dev] Done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-dev] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
