const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  allowFinanceArea,
  blockFinanceArea,
  isFinanceRole
} = require('../middleware/financeAccess');
const {
  allowNocArea,
  blockNocArea,
  isNocRole
} = require('../middleware/nocAccess');
const {
  allowSalesArea,
  blockSalesArea,
} = require('../middleware/salesAccess');
const { allowHrisAdmin } = require('../middleware/hrisAccess');

// Login page — auto-redirect kalau user sudah punya session valid.
// Cek cookie 'token' (HttpOnly yang di-set saat login berhasil). Kalau JWT
// valid dan user masih aktif, langsung redirect ke role's home page.
// Kalau tidak valid (expired/tampered/user inactive), render halaman login
// dan diam-diam clear cookie supaya tidak loop redirect.
router.get('/login', async (req, res) => {
  try {
    const token = req.cookies && req.cookies.token;
    if (token) {
      const jwt = require('jsonwebtoken');
      const { User, Role } = require('../models');
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findByPk(decoded.id, {
          include: [{ model: Role, as: 'role' }]
        });
        if (user && user.is_active) {
          const roleName = (user.role?.name || '').toLowerCase();
          let dest = '/dashboard';
          if (roleName === 'technician') dest = '/technician';
          else if (roleName === 'collector')  dest = '/collect/field';
          else if (roleName === 'finance')    dest = '/finance';
          else if (roleName === 'noc')        dest = '/noc';
          else if (roleName === 'sales')      dest = '/sales';
          return res.redirect(dest);
        }
        // user tidak aktif / tidak ada — clear cookie
        res.clearCookie('token');
      } catch (_) {
        // JWT invalid/expired — clear cookie supaya browser tidak terus kirim
        res.clearCookie('token');
      }
    }
  } catch (e) {
    // Defensive: kalau apa pun gagal di check ini, tetap render halaman login
    // (lebih baik render daripada loop atau error 500).
  }
  res.render('pages/login', { title: 'Login', layout: false });
});

// Root redirect — role-aware
router.get('/', authenticate, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (roleName === 'technician') return res.redirect('/technician');
  if (roleName === 'collector')  return res.redirect('/collect/field');
  if (roleName === 'finance')    return res.redirect('/finance');
  if (roleName === 'noc')        return res.redirect('/noc');
  if (roleName === 'sales')      return res.redirect('/sales');
  return res.redirect('/dashboard');
});

// ═══════════════════════════════════════════════════════════════════
// SALES CONFINEMENT — role 'sales' hanya boleh akses halaman /sales.
// Guard global ini mengunci role sales: setiap GET halaman selain yang
// di-whitelist akan di-redirect ke /sales. Mencegah sales membuka
// dashboard admin, monitoring, billing, dll lewat URL langsung.
// (Admin/superadmin & role lain tidak terpengaruh.)
// ═══════════════════════════════════════════════════════════════════
const _salesAllowedPaths = new Set([
  '/sales', '/sales/dashboard', '/login', '/logout',
  '/tickets', '/todos', '/work-orders'
]);
// Prefix yang diizinkan (untuk path dinamis seperti /tickets/123).
const _salesAllowedPrefixes = ['/tickets/', '/work-orders/'];
router.use((req, res, next) => {
  // Hanya berlaku untuk GET halaman; lewati aset & request lain.
  if (req.method !== 'GET') return next();
  const token = req.cookies && req.cookies.token;
  if (!token) return next(); // biar route auth masing-masing yang urus
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // role disematkan di token? kalau tidak, fallback aman: lanjut.
    const roleName = (decoded.role || decoded.roleName || '').toLowerCase();
    if (roleName === 'sales') {
      const allowed = _salesAllowedPaths.has(req.path)
        || _salesAllowedPrefixes.some(p => req.path.startsWith(p));
      if (!allowed) return res.redirect('/sales');
    }
  } catch (_) { /* token invalid → biarkan authenticate yang menangani */ }
  next();
});

// ═══════════════════════════════════════════════════════════════════
// COLLECTOR CONFINEMENT — role 'collector' hanya boleh akses halaman
// lapangan + beberapa halaman operasional. Setiap GET halaman lain
// di-redirect ke /collect/field. (Admin/superadmin tidak terpengaruh.)
// ═══════════════════════════════════════════════════════════════════
const _collectorAllowedPaths = new Set([
  '/collect/field', '/login', '/logout'
]);
const _collectorAllowedPrefixes = ['/collect/field'];
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const token = req.cookies && req.cookies.token;
  if (!token) return next();
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const roleName = (decoded.role || decoded.roleName || '').toLowerCase();
    if (roleName === 'collector') {
      const allowed = _collectorAllowedPaths.has(req.path)
        || _collectorAllowedPrefixes.some(p => req.path.startsWith(p));
      if (!allowed) return res.redirect('/collect/field');
    }
  } catch (_) { /* token invalid → authenticate yang urus */ }
  next();
});

// Dashboard utama — admin-only (role finance/noc/sales di-redirect ke dashboard masing-masing)
router.get('/dashboard', authenticate, blockFinanceArea, blockNocArea, blockSalesArea, (req, res) => {
  res.render('pages/dashboard', { title: 'Dashboard', user: req.user, active: 'dashboard' });
});

// ═══════════════════════════════════════════════════════════════════
// NOC DASHBOARD — halaman utama role NOC
// Monitoring jaringan: traffic, PPPoE, OLT/ONT, devices, infrastructure.
// ═══════════════════════════════════════════════════════════════════
router.get('/noc', authenticate, allowNocArea, (req, res) => {
  res.render('pages/noc-dashboard', {
    title: 'NOC Dashboard',
    user: req.user,
    active: 'noc-dashboard'
  });
});
router.get('/noc/dashboard', authenticate, allowNocArea, (req, res) => res.redirect('/noc'));

// ═══════════════════════════════════════════════════════════════════
// FINANCE DASHBOARD — halaman utama role finance
// ═══════════════════════════════════════════════════════════════════
router.get('/finance', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/finance-dashboard', {
    title: 'Finance Dashboard',
    user: req.user,
    active: 'finance-dashboard'
  });
});
router.get('/finance/dashboard', authenticate, allowFinanceArea, (req, res) => res.redirect('/finance'));

// ═══════════════════════════════════════════════════════════════════
// SALES DASHBOARD — halaman utama role sales (juga dapat diakses admin)
// Registrasi pelanggan, survey, instalasi, coverage checker, komisi.
// ═══════════════════════════════════════════════════════════════════
router.get('/sales', authenticate, allowSalesArea, (req, res) => {
  res.render('pages/sales-dashboard', {
    title: 'Sales Dashboard',
    user: req.user,
    active: 'sales-dashboard'
  });
});
router.get('/sales/dashboard', authenticate, (req, res) => res.redirect('/sales'));

// ─── MONITORING ─────────────────────────────────────────────
router.get('/monitoring/traffic', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/traffic', { title: 'Traffic Interface', user: req.user, active: 'traffic' });
});

router.get('/nms', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/nms', { title: 'NMS · Interface Monitor', user: req.user, active: 'nms' });
});

router.get('/monitoring/pppoe', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/pppoe', { title: 'PPPoE Sessions', user: req.user, active: 'pppoe' });
});

router.get('/monitoring/queue', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/queue', { title: 'Simple Queue', user: req.user, active: 'queue' });
});

router.get('/monitoring/ippool', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/ippool', { title: 'IP Pool Usage', user: req.user, active: 'ippool' });
});

router.get('/monitoring/firewall', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/firewall', { title: 'Firewall Rules', user: req.user, active: 'firewall' });
});

router.get('/monitoring/olt', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/olt', { title: 'OLT Monitoring', user: req.user, active: 'olt' });
});

// OLT Management — live CLI ke ZTE C320/C300 (baca redaman, ONU, authorize, dll)
router.get('/monitoring/olt-management', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/olt-management', { title: 'OLT Management', user: req.user, active: 'olt-management' });
});

router.get('/monitoring/ping', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/ping-monitor', { title: 'Ping Monitor', user: req.user, active: 'ping-monitor' });
});

router.get('/monitoring/hotspot', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/hotspot', { title: 'Hotspot Management', user: req.user, active: 'hotspot' });
});

router.get('/monitoring/radius', authenticate, blockFinanceArea, blockSalesArea, (req, res) => {
  res.render('pages/radius', { title: 'RADIUS Server', user: req.user, active: 'radius' });
});

router.get('/monitoring/nas', authenticate, blockFinanceArea, blockSalesArea, (req, res) => {
  res.render('pages/nas', { title: 'NAS', user: req.user, active: 'nas' });
});

router.get('/monitoring/wireguard', authenticate, blockFinanceArea, blockSalesArea, (req, res) => {
  res.render('pages/wireguard', { title: 'WireGuard VPN', user: req.user, active: 'wireguard' });
});

router.get('/monitoring/port-forwarding', authenticate, blockFinanceArea, blockSalesArea, (req, res) => {
  res.render('pages/port-forwarding', { title: 'Port Forwarding', user: req.user, active: 'port-forwarding' });
});

// ─── RESELLER VOUCHER (admin management) ────────────────────
// Kelola akun reseller, saldo deposit, paket voucher. Hanya admin/superadmin.
router.get('/reseller-voucher', authenticate, blockFinanceArea, (req, res) => {
  const role = (req.user?.role?.name || '').toLowerCase();
  if (role !== 'superadmin' && role !== 'admin') return res.redirect('/dashboard');
  res.render('pages/reseller-voucher', { title: 'Reseller Voucher', user: req.user, active: 'reseller-voucher' });
});

// ─── ONT MANAGEMENT (GenieACS) - NEW ────────────────────────
router.get('/genieacs', authenticate, blockFinanceArea, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'genieacs_nbi_url' } });
    const genieacsUrl = row?.value || process.env.GENIEACS_NBI_URL || '';
    res.render('pages/genieacs', {
      title: 'ONT Management',
      user: req.user,
      active: 'genieacs',
      genieacsUrl
    });
  } catch (e) {
    res.render('pages/genieacs', {
      title: 'ONT Management',
      user: req.user,
      active: 'genieacs',
      genieacsUrl: process.env.GENIEACS_NBI_URL || ''
    });
  }
});

router.get('/work-orders', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/work-orders', { title: 'Work Order', user: req.user, active: 'work-orders' });
});

router.get('/todos', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/todos', { title: 'To Do List', user: req.user, active: 'todos' });
});

router.get('/packages', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/packages', { title: 'Paket Layanan', user: req.user, active: 'packages' });
});

// ─── MANAGEMENT ─────────────────────────────────────────────
router.get('/customers', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/customers', { title: 'Customers', user: req.user, active: 'customers' });
});

router.get('/customers/profile/:id', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/customer_profile', { title: 'Profil Pelanggan', user: req.user, active: 'customers', custId: req.params.id });
});

router.get('/whatsapp', authenticate, blockFinanceArea, blockNocArea, (req, res) => {
  res.render('pages/whatsapp', { title: 'WA Gateway', user: req.user, active: 'whatsapp' });
});

router.get('/billing', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/billing', { title: 'Billing', user: req.user, active: 'billing' });});

// ── Field Collection (penagihan lapangan) — dashboard admin ──────────
// Hanya admin/superadmin. Halaman lapangan kolektor ditambahkan di Tahap 3.
router.get('/collect', authenticate, blockFinanceArea, blockNocArea, blockSalesArea, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (!['superadmin', 'admin'].includes(roleName)) return res.redirect('/dashboard');
  res.render('pages/collection', { title: 'Collect Billing', user: req.user, active: 'collect' });
});

// ── Halaman lapangan kolektor (mobile-first) ─────────────────────────
// Boleh diakses role collector (utama) + admin/superadmin (untuk supervisi).
router.get('/collect/field', authenticate, blockFinanceArea, blockNocArea, blockSalesArea, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (!['collector', 'superadmin', 'admin'].includes(roleName)) return res.redirect('/dashboard');
  res.render('pages/collect-field', { title: 'Penagihan Lapangan', user: req.user, active: 'collect-field', layout: false });
});

// ── Mobile shell (owner, tampilan ringkas ala APK) ───────────────────
// Full-mobile (layout:false), hanya admin/superadmin. Diakses via /mobile di HP.
// API-nya reuse endpoint yang sudah ada, hanya UI berbeda.
const _mobileAllowed = ['superadmin', 'admin'];
function renderMobile(page, title, active) {
  return (req, res) => {
    const roleName = (req.user?.role?.name || '').toLowerCase();
    if (!_mobileAllowed.includes(roleName)) return res.redirect('/dashboard');
    res.render('pages/mobile/' + page, {
      title, user: req.user, active, layout: false,
      appName: (res.locals && res.locals.appName) || process.env.APP_NAME || 'FLAYNET'
    });
  };
}
router.get('/mobile',            authenticate, renderMobile('home',       'Beranda',          'm-home'));
router.get('/mobile/customers',  authenticate, renderMobile('customers',  'Pelanggan',        'm-customers'));
router.get('/mobile/payments',   authenticate, renderMobile('payments',   'Pembayaran',       'm-payments'));
router.get('/mobile/payment-new',authenticate, renderMobile('payment-new','Catat Pembayaran', 'm-payments'));
router.get('/mobile/finance',    authenticate, renderMobile('finance',    'Laporan Keuangan', 'm-finance'));
router.get('/mobile/keuangan',   authenticate, renderMobile('keuangan',   'Keuangan',         'm-keuangan'));
router.get('/mobile/monitoring', authenticate, renderMobile('monitoring', 'Monitoring',       'm-monitoring'));
router.get('/mobile/queue',      authenticate, renderMobile('queue',      'Simple Queue',     'm-queue'));
router.get('/mobile/isolir',     authenticate, renderMobile('isolir',     'Isolir',           'm-isolir'));
router.get('/mobile/noc',        authenticate, renderMobile('noc',        'NOC / Jaringan',   'm-noc'));
router.get('/mobile/hotspot',    authenticate, renderMobile('hotspot',    'Hotspot',          'm-hotspot'));
router.get('/mobile/voucher',    authenticate, renderMobile('voucher',    'Voucher',          'm-voucher'));
router.get('/mobile/reminder',   authenticate, renderMobile('reminder',   'Reminder Tagihan', 'm-reminder'));
router.get('/mobile/ticket',     authenticate, renderMobile('ticket',     'Tiket',            'm-ticket'));
router.get('/mobile/hotspot-binding', authenticate, renderMobile('hotspot-binding', 'Hotspot Binding', 'm-hotspot-binding'));
router.get('/mobile/host',        authenticate, renderMobile('host',        'Host Terdeteksi',  'm-host'));
router.get('/mobile/infrastructure', authenticate, renderMobile('infrastructure', 'Infrastruktur', 'm-infrastructure'));
router.get('/mobile/invoice',        authenticate, renderMobile('invoice',        'Invoice',       'm-invoice'));
router.get('/mobile/packages',       authenticate, renderMobile('packages',       'Paket Layanan', 'm-packages'));
router.get('/mobile/assets',         authenticate, renderMobile('assets',         'Aset & Inventaris', 'm-assets'));
router.get('/mobile/wa',             authenticate, renderMobile('wa',             'WhatsApp Gateway', 'm-wa'));
router.get('/mobile/profile',        authenticate, renderMobile('profile',        'Akun Saya',     'm-profile'));

router.get('/payments', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/payments', { title: 'Pembayaran', user: req.user, active: 'payments' });
});

router.get('/message-logs', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/message-logs', { title: 'Message Logs', user: req.user, active: 'message-logs' }));

router.get('/broadcast', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/broadcast', { title: 'Broadcast', user: req.user, active: 'broadcast' }));

router.get('/email-broadcast', authenticate, allowFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/email-broadcast', { title: 'Broadcast Email', user: req.user, active: 'email-broadcast' }));

router.get('/invoice-broadcast', authenticate, allowFinanceArea, (req, res) =>
  res.render('pages/invoice-broadcast', { title: 'Broadcast Invoice', user: req.user, active: 'invoice-broadcast' }));

router.get('/mikrotik-backup', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/mikrotik-backup', { title: 'Backup MikroTik', user: req.user, active: 'mikrotik-backup' }));

router.get('/wa/templates', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/wa-templates', { title: 'Template Pesan', user: req.user, active: 'wa-templates' }));
router.get('/wa/reminder', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/wa-reminder', { title: 'Automation Reminder', user: req.user, active: 'wa-reminder' }));
router.get('/wa/report', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/wa-report', { title: 'Automation Report', user: req.user, active: 'wa-report' }));

// ── Telegram Center — pusat kelola notifikasi Telegram ──
router.get('/telegram', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/telegram', { title: 'Telegram Center', user: req.user, active: 'telegram' }));

// ── Telegram Report — laporan operasional ke Telegram ──
router.get('/telegram/report', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/telegram-report', { title: 'Telegram Report', user: req.user, active: 'telegram-report' }));

// ── Telegram Backup — kirim backup MikroTik ke Telegram ──
router.get('/telegram/backup', authenticate, blockFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/telegram-backup', { title: 'Telegram Backup', user: req.user, active: 'telegram-backup' }));

// Helper: load invoice template settings (dengan fallback ke global app_settings)
async function loadInvoiceTpl() {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invtpl_%' } } });
  const tpl = {};
  rows.forEach(r => { tpl[r.key.replace('invtpl_', '')] = r.value; });

  // Fallback ke setting global Brand kalau template-specific belum di-set
  if (!tpl.logo_url) {
    const globalLogo = await AppSetting.findOne({ where: { key: 'logo_url' } });
    if (globalLogo && globalLogo.value) tpl.logo_url = globalLogo.value;
  }
  if (!tpl.company_name) {
    const cn = await AppSetting.findOne({ where: { key: 'company_name' } })
            || await AppSetting.findOne({ where: { key: 'app_name' } });
    if (cn && cn.value) tpl.company_name = cn.value;
  }
  if (!tpl.company_phone) {
    const cp = await AppSetting.findOne({ where: { key: 'company_whatsapp' } });
    if (cp && cp.value) tpl.company_phone = cp.value;
  }
  return tpl;
}

router.get('/invoice/inv/:invoiceId', authenticate, allowFinanceArea, async (req, res) => {
  const tpl = await loadInvoiceTpl();
  res.render('pages/invoice', { title: 'Invoice', user: req.user, active: 'billing', tpl });
});
router.get('/invoice/:paymentId', authenticate, allowFinanceArea, async (req, res) => {
  const tpl = await loadInvoiceTpl();
  res.render('pages/invoice', { title: 'Invoice', user: req.user, active: 'payments', tpl });
});

// Invoice Template Designer — customize tampilan invoice (warna, font, label, show/hide)
router.get('/invoice-template', authenticate, allowFinanceArea, async (req, res) => {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invtpl_%' } } });
  const tplSettings = {};
  rows.forEach(r => { tplSettings[r.key] = r.value; });
  // Load global settings utk fallback (logo, company info dari Brand)
  const allRows = await AppSetting.findAll();
  const appSettings = {};
  allRows.forEach(r => { appSettings[r.key] = r.value; });
  res.render('pages/invoice-template', {
    title: 'Template Invoice',
    user: req.user,
    active: 'invoice-template',
    tplSettings,
    appSettings
  });
});

// Preview Print — render invoice.ejs dengan flag preview mode + tpl settings
// Frontend invoice.ejs detect path ini lalu pakai data dummy (skip API fetch)
router.get('/invoice-template/preview-print', authenticate, allowFinanceArea, async (req, res) => {
  const tpl = await loadInvoiceTpl();
  res.render('pages/invoice', {
    title: 'Preview Template Invoice',
    user: req.user,
    active: 'invoice-template',
    tpl
  });
});

// Voucher Template Designer — customize tampilan voucher print (warna, brand, label)
router.get('/voucher-template', authenticate, blockFinanceArea, blockNocArea, async (req, res) => {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'vtpl_%' } } });
  const tplSettings = {};
  rows.forEach(r => { tplSettings[r.key] = r.value; });
  res.render('pages/voucher-template', {
    title: 'Template Voucher',
    user: req.user,
    active: 'voucher-template',
    tplSettings
  });
});

// Voucher Preview Print — buka window print sample voucher dengan template tersimpan
router.get('/voucher-template/preview-print', authenticate, blockFinanceArea, blockNocArea, async (req, res) => {
  const { AppSetting } = require('../models');
  const { Op } = require('sequelize');
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'vtpl_%' } } });
  const tpl = {};
  rows.forEach(r => { tpl[r.key.replace('vtpl_', '')] = r.value; });
  res.render('pages/voucher-preview-print', {
    title: 'Preview Print Voucher',
    user: req.user,
    active: 'voucher-template',
    tpl
  });
});

// ── Email Template Manager — kustomisasi seluruh template email ──
router.get('/email-template', authenticate, allowFinanceArea, blockNocArea, async (req, res) => {
  const EmailTpl = require('../services/EmailTemplateService');
  let templates = [];
  try { templates = await EmailTpl.listForUi(); } catch (e) { templates = []; }
  // Nama perusahaan untuk substitusi {perusahaan} di preview.
  let companyName = '';
  try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
  res.render('pages/email-template', {
    title: 'Email Template',
    user: req.user,
    active: 'email-template',
    templates,
    companyName: companyName || 'ISP'
  });
});

// ── Email Log — riwayat email yang dikirim sistem ──
router.get('/email-log', authenticate, allowFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/email-log', { title: 'Riwayat Email', user: req.user, active: 'email-log' }));

// ── Email Statistic — ringkasan statistik pengiriman email ──
router.get('/email-statistic', authenticate, allowFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/email-statistic', { title: 'Email Statistic', user: req.user, active: 'email-statistic' }));

// ── Email Schedule — pusat kendali semua jadwal email ──
router.get('/email-schedule', authenticate, allowFinanceArea, blockNocArea, (req, res) =>
  res.render('pages/email-schedule', { title: 'Email Schedule', user: req.user, active: 'email-schedule' }));


// ── Tickets ─────────────────────────────────────────────────
router.get('/tickets', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/tickets', { title: 'Tickets', user: req.user, active: 'tickets' }));
router.get('/tickets/:id', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/ticket-detail', { title: 'Detail Ticket', user: req.user, active: 'tickets', ticketId: req.params.id }));

router.get('/monitoring/device-monitor', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/device-monitor', { title: 'Device Monitor', user: req.user, active: 'device-monitor' });
});

router.get('/devices', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/devices', { title: 'Devices', user: req.user, active: 'devices' });
});

router.get('/devices/:id', authenticate, blockFinanceArea, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.redirect('/devices');
  res.render('pages/device-detail', {
    title: 'Device Detail',
    user: req.user,
    active: 'devices',
    deviceId: id
  });
});

router.get('/assets', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/assets', { title: 'Asset Management', user: req.user, active: 'assets' });
});

router.get('/infrastructure', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/infrastructure', { title: 'Infrastructure Map', user: req.user, active: 'infrastructure' });
});

// ─── SYSTEM ──────────────────────────────────────────────────
router.get('/system/resources', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/resources', { title: 'System Resource', user: req.user, active: 'resources' });
});

router.get('/system/topology', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/topology', { title: 'Topology', user: req.user, active: 'topology' });
});

// ── Database Management (Cleanup + Backup) ───────────────────
// Hanya admin/superadmin yang boleh akses (untuk safety)
router.get('/system/database', authenticate, blockFinanceArea, blockNocArea, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (!['admin', 'superadmin'].includes(roleName)) {
    return res.status(403).render('pages/error', {
      title: 'Akses Ditolak',
      message: 'Halaman ini hanya bisa diakses oleh Admin/Superadmin.',
      user: req.user,
    });
  }
  res.render('pages/database-management', {
    title: 'Database Management',
    user: req.user,
    active: 'database-management',
  });
});

router.get('/settings_old', authenticate, blockFinanceArea, blockNocArea, (req, res) => {
  res.render('pages/settings', { title: 'Settings', user: req.user, active: 'settings' });
});

router.get('/settings/users', authenticate, blockFinanceArea, blockNocArea, (req, res) => {
  res.render('pages/users', { title: 'User Management', user: req.user, active: 'users' });
});

router.get('/logs', authenticate, blockFinanceArea, (req, res) => {
  res.render('pages/logs', { title: 'Activity Logs', user: req.user, active: 'logs' });
});

router.get('/keuangan', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/keuangan', { title: 'Keuangan', user: req.user, active: 'keuangan' });
});

router.get('/laporan/print', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/laporan-print', { title: 'Cetak Laporan', user: req.user, active: 'laporan' });
});

router.get('/laporan', authenticate, allowFinanceArea, (req, res) => {
  res.render('pages/laporan', { title: 'Laporan Keuangan', user: req.user, active: 'laporan' });
});

router.get('/isolir', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/isolir', { title: 'Isolir Management', user: req.user, active: 'isolir' }));

router.get('/hotspot-binding', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/hotspot-binding', { title: 'Hotspot Binding Management', user: req.user, active: 'hotspot-binding' }));

router.get('/ip-addressing', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/ip-addressing', { title: 'IP Addressing', user: req.user, active: 'ip-addressing' }));

// Redirect lama → halaman baru
router.get('/tools', authenticate, (req, res) => res.redirect('/hotspot-binding'));

router.get('/settings', authenticate, blockFinanceArea, blockNocArea, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    // Ambil SEMUA setting — biar semua field di page settings (brand, umum, payment, dll) ter-populate
    const rows = await AppSetting.findAll();
    const appSettings = {};
    rows.forEach(r => { appSettings[r.key] = r.value; });
    res.render('pages/settings', { title: 'Settings', user: req.user, active: 'settings', appSettings });
  } catch(e) {
    res.render('pages/settings', { title: 'Settings', user: req.user, active: 'settings', appSettings: {} });
  }
});

// ── GPS Tracking ───────────────────────────────────────────── 
router.get('/gps-tracking', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/gps-tracking', { title: 'GPS Tracking', user: req.user, active: 'gps-tracking' }));
 
router.get('/technician-tracking', authenticate, blockFinanceArea, (req, res) =>
  res.render('pages/technician-tracking', { title: 'Field Tracking', user: req.user, active: 'technician-tracking', layout: false }));

// ── Portal Teknisi ──────────────────────────────────────────
// Dashboard utama untuk tim teknisi lapangan.
// Role 'technician' masuk langsung ke sini; admin & superadmin juga
// boleh akses untuk keperluan QA / preview.
router.get('/technician', authenticate, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (!/technician|admin|superadmin/.test(roleName)) {
    return res.status(403).send('Akses ditolak: portal ini khusus untuk teknisi.');
  }
  res.render('pages/technician-dashboard', {
    title: 'Portal Teknisi',
    user: req.user,
    active: 'technician-dashboard',
    layout: false
  });
});

// Alias agar /technician/dashboard juga valid
router.get('/technician/dashboard', authenticate, (req, res) => res.redirect('/technician'));

// ═══════════════════════════════════════════════════════════════════
// Tambahkan di backend/routes/web.js setelah route /technician
// ═══════════════════════════════════════════════════════════════════

// Halaman detail ticket untuk teknisi
router.get('/technician/ticket/:id', authenticate, (req, res) => {
  const roleName = (req.user?.role?.name || '').toLowerCase();
  if (!/technician|admin|superadmin/.test(roleName)) {
    return res.status(403).send('Akses ditolak');
  }
  res.render('pages/technician-ticket-detail', {
    title: 'Detail Ticket',
    user: req.user,
    active: 'technician-dashboard',
    layout: false,
    ticketId: req.params.id
  });
});

// ═══════════════════════════════════════════════════════════════════
// HRIS — Human Resource Information System
// ─────────────────────────────────────────────────────────────────
// Admin panel (superadmin/admin/hr) untuk data karyawan, absensi,
// jadwal, dan payroll. Halaman absensi karyawan (/hris/absen) terbuka
// untuk semua user login yang tertaut ke Employee.
// ═══════════════════════════════════════════════════════════════════

// Dashboard HRIS + sub-halaman admin (SPA-style, dirender satu view)
router.get('/hris', authenticate, allowHrisAdmin, (req, res) => {
  res.render('pages/hris-dashboard', { title: 'HRIS · Dashboard', user: req.user, active: 'hris' });
});
router.get('/hris/employees', authenticate, allowHrisAdmin, (req, res) => {
  res.render('pages/hris-employees', { title: 'HRIS · Data Karyawan', user: req.user, active: 'hris-employees' });
});
router.get('/hris/attendance', authenticate, allowHrisAdmin, (req, res) => {
  res.render('pages/hris-attendance', { title: 'HRIS · Absensi', user: req.user, active: 'hris-attendance' });
});
router.get('/hris/schedule', authenticate, allowHrisAdmin, (req, res) => {
  res.render('pages/hris-schedule', { title: 'HRIS · Shift & Jadwal', user: req.user, active: 'hris-schedule' });
});
router.get('/hris/payroll', authenticate, allowHrisAdmin, (req, res) => {
  res.render('pages/hris-payroll', { title: 'HRIS · Penggajian', user: req.user, active: 'hris-payroll' });
});

// Halaman absensi selfie + GPS untuk KARYAWAN (semua user login).
// Layout khusus (tanpa sidebar admin) — dirender full-page seperti collect-field.
router.get('/hris/absen', authenticate, (req, res) => {
  res.render('pages/hris-absen', { title: 'Absensi Online', user: req.user, active: 'hris-absen', layout: false });
});

module.exports = router;