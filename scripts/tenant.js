#!/usr/bin/env node
/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-tenant provisioning CLI (Pola B — isolated stack per tenant).
 *
 * Each tenant gets:
 *   - its OWN MySQL/MariaDB database (tenant_<slug>) + DB user,
 *   - its OWN application directory (a copy of this repo, node_modules shared
 *     via symlink) so runtime state — WhatsApp sessions (uploads/wa_auth),
 *     uploads, logs — is fully isolated,
 *   - its OWN port and RADIUS ports,
 *   - its OWN admin login.
 *
 * This keeps the application code unchanged and gives strong (physical) data
 * isolation, which is what you want for a rented/hosted ISP billing SaaS. A
 * reverse proxy maps each tenant's subdomain to its port.
 *
 * Usage:
 *   node scripts/tenant.js create <slug> [--port N] [--pm2] [--no-start] [--admin-email X] [--admin-pass Y]
 *   node scripts/tenant.js list
 *   node scripts/tenant.js start  <slug> [--pm2]
 *   node scripts/tenant.js stop   <slug> [--pm2]
 *   node scripts/tenant.js remove <slug> [--drop-db] [--pm2]
 *   node scripts/tenant.js nginx  <slug> [--domain example.com]
 *
 * Environment:
 *   TENANTS_BASE      Directory where tenant stacks live. Default: <repo>/tenants-runtime
 *   TENANT_DB_ADMIN   Admin MySQL command used to create DBs/users.
 *                     Default: "sudo mysql". In production e.g. "mysql -uroot -pSECRET".
 *   DB_HOST/DB_PORT   Passed into each tenant's .env (default 127.0.0.1 / 3306).
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync, spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE = process.env.TENANTS_BASE || path.join(REPO_ROOT, 'tenants-runtime');
const REGISTRY = path.join(BASE, 'registry.json');
const DB_ADMIN = process.env.TENANT_DB_ADMIN || 'sudo mysql';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = process.env.DB_PORT || '3306';
const PORT_BASE = parseInt(process.env.TENANT_PORT_BASE || '3100', 10);
const RADIUS_BASE = parseInt(process.env.TENANT_RADIUS_BASE || '1900', 10);

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

function die(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}
function rand(n = 24) {
  return crypto.randomBytes(n).toString('hex');
}
function ensureBase() {
  fs.mkdirSync(BASE, { recursive: true });
  if (!fs.existsSync(REGISTRY)) fs.writeFileSync(REGISTRY, JSON.stringify({ tenants: [] }, null, 2));
}
function readRegistry() {
  ensureBase();
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}
function writeRegistry(reg) {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}
function findTenant(reg, slug) {
  return reg.tenants.find((t) => t.slug === slug);
}
function allocatePort(reg, requested) {
  const used = new Set(reg.tenants.map((t) => t.port));
  if (requested) {
    if (used.has(requested)) die(`port ${requested} already in use by another tenant`);
    return requested;
  }
  let p = PORT_BASE;
  while (used.has(p)) p += 1;
  return p;
}
function adminSql(sql) {
  // Run SQL through the configured admin MySQL command (socket/root).
  const res = spawnSync('bash', ['-lc', DB_ADMIN], { input: sql, encoding: 'utf8' });
  if (res.status !== 0) {
    die(`admin MySQL command failed (${DB_ADMIN}):\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i += 1; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

function copyAppInto(tenantDir) {
  fs.mkdirSync(tenantDir, { recursive: true });
  const excludes = [
    '.git', 'node_modules', 'tenants-runtime', 'uploads', 'logs', '.env',
  ];
  const hasRsync = spawnSync('bash', ['-lc', 'command -v rsync'], { encoding: 'utf8' }).status === 0;
  if (hasRsync) {
    const ex = excludes.map((e) => `--exclude='${e}'`).join(' ');
    execSync(`rsync -a ${ex} ./ '${tenantDir}/'`, { cwd: REPO_ROOT, stdio: 'inherit' });
  } else {
    // Fallback: tar committed + tracked files (still excludes runtime dirs).
    const ex = excludes.map((e) => `--exclude='./${e}'`).join(' ');
    execSync(`tar -c ${ex} . | tar -x -C '${tenantDir}'`, { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  // Share node_modules via symlink to save disk + install time.
  const link = path.join(tenantDir, 'node_modules');
  if (!fs.existsSync(link)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), link, 'dir');
  }
}

function writeEnv(tenantDir, cfg) {
  const env = `# Auto-generated per-tenant env for "${cfg.slug}" (Pola B — isolated stack).
APP_ENV=production
NODE_ENV=production
APP_PORT=${cfg.port}
APP_URL=${cfg.appUrl}
BASE_URL=${cfg.appUrl}

# Isolated database for this tenant
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${cfg.dbName}
DB_USER=${cfg.dbUser}
DB_PASS=${cfg.dbPass}

# Per-tenant secrets
JWT_SECRET=${cfg.jwt}
JWT_REFRESH_SECRET=${cfg.jwtRefresh}
JWT_PORTAL_SECRET=${cfg.jwtPortal}

# Per-tenant RADIUS ports (avoid collisions between tenant processes)
RADIUS_AUTH_PORT=${cfg.radiusAuth}
RADIUS_ACCT_PORT=${cfg.radiusAcct}

APP_TIMEZONE=Asia/Jakarta
LOG_LEVEL=info
`;
  fs.writeFileSync(path.join(tenantDir, '.env'), env);
}

function startTenant(t, usePm2) {
  const logDir = path.join(t.dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  if (usePm2) {
    execSync(`pm2 start backend/server.js --name tenant-${t.slug}`, { cwd: t.dir, stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });
    return null;
  }
  const out = fs.openSync(path.join(logDir, 'app.log'), 'a');
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: t.dir,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

function stopTenant(t, usePm2) {
  if (usePm2) {
    spawnSync('bash', ['-lc', `pm2 delete tenant-${t.slug}`], { stdio: 'inherit' });
    return;
  }
  if (t.pid) {
    try { process.kill(t.pid); } catch (_) { /* already gone */ }
  }
}

function cmdCreate(positional, flags) {
  const slug = positional[0];
  if (!slug || !SLUG_RE.test(slug)) die('provide a valid <slug> (lowercase letters, digits, dashes)');
  const reg = readRegistry();
  if (findTenant(reg, slug)) die(`tenant "${slug}" already exists`);

  const idx = reg.tenants.length;
  const port = allocatePort(reg, flags.port ? parseInt(flags.port, 10) : null);
  const dbSlug = slug.replace(/-/g, '_');
  const dbName = `tenant_${dbSlug}`;
  const dbUser = `t_${dbSlug}`.slice(0, 32);
  const dbPass = rand(12);
  const tenantDir = path.join(BASE, slug);
  const appUrl = flags.domain ? `https://${flags.domain}` : `http://127.0.0.1:${port}`;
  const adminEmail = flags['admin-email'] || `admin@${slug}.local`;
  const adminPass = flags['admin-pass'] || rand(6);

  const cfg = {
    slug, port, dbName, dbUser, dbPass, appUrl,
    jwt: rand(24), jwtRefresh: rand(24), jwtPortal: rand(24),
    radiusAuth: RADIUS_BASE + idx * 10,
    radiusAcct: RADIUS_BASE + idx * 10 + 1,
  };

  console.log(`==> Creating tenant "${slug}" (port ${port}, db ${dbName})`);

  console.log('    - provisioning database + user');
  adminSql(`
CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${dbUser}'@'localhost'  IDENTIFIED BY '${dbPass}';
CREATE USER IF NOT EXISTS '${dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}';
ALTER USER '${dbUser}'@'localhost'  IDENTIFIED BY '${dbPass}';
ALTER USER '${dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}';
GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'localhost';
GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'127.0.0.1';
GRANT PROCESS ON *.* TO '${dbUser}'@'127.0.0.1';
FLUSH PRIVILEGES;
`);

  console.log('    - copying application into tenant directory');
  copyAppInto(tenantDir);
  writeEnv(tenantDir, cfg);

  console.log('    - seeding schema + admin user');
  const seed = spawnSync(process.execPath, ['.cursor/seed-dev.js'], {
    cwd: tenantDir,
    stdio: 'inherit',
    env: { ...process.env, SEED_ADMIN_EMAIL: adminEmail, SEED_ADMIN_PASS: adminPass, SEED_ADMIN_NAME: `Admin ${slug}` },
  });
  if (seed.status !== 0) die('seeding failed');

  const record = {
    slug, port, dir: tenantDir, dbName, dbUser,
    appUrl, adminEmail, radiusAuth: cfg.radiusAuth, radiusAcct: cfg.radiusAcct,
    createdAt: new Date().toISOString(), pid: null,
  };
  reg.tenants.push(record);
  writeRegistry(reg);

  if (!flags['no-start']) {
    console.log('    - starting tenant');
    const pid = startTenant(record, !!flags.pm2);
    record.pid = pid;
    writeRegistry(reg);
  }

  console.log('\n==> Tenant ready');
  console.log(`    slug        : ${slug}`);
  console.log(`    url         : ${appUrl}  (local: http://127.0.0.1:${port})`);
  console.log(`    database    : ${dbName}`);
  console.log(`    admin login : ${adminEmail} / ${adminPass}`);
  console.log(`    directory   : ${tenantDir}`);
}

function cmdList() {
  const reg = readRegistry();
  if (!reg.tenants.length) { console.log('No tenants provisioned yet.'); return; }
  console.log('SLUG           PORT   DATABASE              ADMIN                        PID');
  console.log('-------------- ------ --------------------- ---------------------------- --------');
  for (const t of reg.tenants) {
    console.log(
      `${t.slug.padEnd(14)} ${String(t.port).padEnd(6)} ${t.dbName.padEnd(21)} ${(t.adminEmail || '').padEnd(28)} ${t.pid || '-'}`
    );
  }
}

function cmdStart(positional, flags) {
  const reg = readRegistry();
  const t = findTenant(reg, positional[0]);
  if (!t) die(`tenant "${positional[0]}" not found`);
  const pid = startTenant(t, !!flags.pm2);
  t.pid = pid;
  writeRegistry(reg);
  console.log(`Started tenant ${t.slug} (port ${t.port}${pid ? ', pid ' + pid : ' via pm2'})`);
}

function cmdStop(positional, flags) {
  const reg = readRegistry();
  const t = findTenant(reg, positional[0]);
  if (!t) die(`tenant "${positional[0]}" not found`);
  stopTenant(t, !!flags.pm2);
  t.pid = null;
  writeRegistry(reg);
  console.log(`Stopped tenant ${t.slug}`);
}

function cmdRemove(positional, flags) {
  const reg = readRegistry();
  const idx = reg.tenants.findIndex((t) => t.slug === positional[0]);
  if (idx < 0) die(`tenant "${positional[0]}" not found`);
  const t = reg.tenants[idx];
  stopTenant(t, !!flags.pm2);
  if (flags['drop-db']) {
    console.log(`    - dropping database ${t.dbName} and user ${t.dbUser}`);
    adminSql(`
DROP DATABASE IF EXISTS \`${t.dbName}\`;
DROP USER IF EXISTS '${t.dbUser}'@'localhost';
DROP USER IF EXISTS '${t.dbUser}'@'127.0.0.1';
FLUSH PRIVILEGES;
`);
  }
  try { fs.rmSync(t.dir, { recursive: true, force: true }); } catch (_) {}
  reg.tenants.splice(idx, 1);
  writeRegistry(reg);
  console.log(`Removed tenant ${t.slug}${flags['drop-db'] ? ' (database dropped)' : ' (database kept)'}`);
}

function cmdNginx(positional, flags) {
  const reg = readRegistry();
  const t = findTenant(reg, positional[0]);
  if (!t) die(`tenant "${positional[0]}" not found`);
  const domain = flags.domain || `${t.slug}.example.com`;
  console.log(`# Nginx reverse proxy for tenant "${t.slug}"
server {
    listen 80;
    server_name ${domain};
    location / {
        proxy_pass http://127.0.0.1:${t.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case 'create': return cmdCreate(positional, flags);
    case 'list': return cmdList();
    case 'start': return cmdStart(positional, flags);
    case 'stop': return cmdStop(positional, flags);
    case 'remove': return cmdRemove(positional, flags);
    case 'nginx': return cmdNginx(positional, flags);
    default:
      console.log(`Multi-tenant provisioning (Pola B).

Commands:
  create <slug> [--port N] [--domain d] [--admin-email e] [--admin-pass p] [--pm2] [--no-start]
  list
  start  <slug> [--pm2]
  stop   <slug> [--pm2]
  remove <slug> [--drop-db] [--pm2]
  nginx  <slug> [--domain d]

Env: TENANTS_BASE, TENANT_DB_ADMIN (default "sudo mysql"), DB_HOST, DB_PORT`);
      process.exit(cmd ? 1 : 0);
  }
}

main();
