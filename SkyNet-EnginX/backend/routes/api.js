/**
 * routes/api.js  (UPDATED - tambahkan mikrotik routes)
 * Tambahkan 2 baris ini di file api.js yang sudah ada:
 *
 *   const mikrotikRoutes = require('./mikrotik');
 *   router.use('/mikrotik', mikrotikRoutes);
 *
 * Letakkan sebelum 
// ===== TODO =====
const TodoController = require('../controllers/TodoController');

// ===== WORK ORDERS =====
const WOCtrl = require('../controllers/WorkOrderController');

module.exports = router;
 * Semua route existing tetap utuh.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { authenticate, authorize, hasPermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/activityLogger');
const { demoGuard } = require('../middleware/demoGuard');
const { apiBlockFinanceArea } = require('../middleware/financeAccess');
const { apiBlockNocArea }     = require('../middleware/nocAccess');
const { apiBlockSalesArea }   = require('../middleware/salesAccess');
const demoRoutes = require('./demo');

// Controllers (existing)
const AuthController = require('../controllers/AuthController');
const UserController = require('../controllers/UserController');
const CustomerController = require('../controllers/CustomerController');
const RegionController = require('../controllers/RegionController');
const PackageController = require('../controllers/PackageController');
const BillingController = require('../controllers/BillingController');
const DeviceController = require('../controllers/DeviceController');
const InfrastructureController     = require('../controllers/InfrastructureController');
const InfrastructureLinkController  = require('../controllers/InfrastructureLinkController');
const OntController = require('../controllers/OntController');
const DashboardController = require('../controllers/DashboardController');
const DashboardLayoutController = require('../controllers/DashboardLayoutController');
const NotificationController = require('../controllers/NotificationController');
const ActivityLogController = require('../controllers/ActivityLogController');
const ResourceController = require('../controllers/ResourceController');
const TopologyController = require('../controllers/TopologyController');

// ===== DEMO (public — /provision tidak butuh login) =====
router.use('/demo', demoRoutes);

// ===== RESELLER VOUCHER (admin management) =====
// CRUD reseller, top-up saldo, paket voucher, laporan. Guard role di dalam file.
const resellerAdminRoutes = require('./resellerAdmin');
router.use('/reseller-admin', resellerAdminRoutes);

// ===== AUTH =====
router.post('/auth/login', AuthController.login);
router.post('/auth/refresh', AuthController.refreshToken);
router.post('/auth/logout', authenticate, demoGuard, AuthController.logout);
router.get('/auth/profile', authenticate, demoGuard, AuthController.profile);
router.put('/auth/profile', authenticate, demoGuard, AuthController.updateProfile);
router.put('/auth/password', authenticate, demoGuard, AuthController.changePassword);

// ═══════════════════════════════════════════════════════════════════
// FINANCE ROLE — Path-prefix API block
// ─────────────────────────────────────────────────────────────────
// Role 'finance' DILARANG akses prefix-prefix di bawah ini. Pasang sebelum
// route handler aslinya supaya middleware ini tereksekusi duluan dan menolak
// request dengan 403 sebelum sampai ke controller.
// Aturan: cuma block prefix yang jelas-jelas modul admin. Endpoint shared
// (billing, payments, customers, packages, keuangan, laporan, dashboard,
// app-settings GET, notifications, auth/profile) tetap accessible.
// ═══════════════════════════════════════════════════════════════════
const _financeBlockedPrefixes = [
  '/mikrotik',          // MikroTik commands
  '/genieacs',          // TR-069 / ONT actions
  '/ont',               // ONT actions
  '/devices',           // Device CRUD (kecuali read — di-handle controller)
  '/firewall',
  '/olt',
  '/hotspot',
  '/pppoe',
  '/radius',
  '/wireguard',
  '/monitoring',
  '/ping-monitor',
  '/host-monitor',
  '/isolir',
  '/wa',                // WA send/sessions/templates/reminder/report
  '/whatsapp',
  '/broadcast',
  // Email diizinkan untuk role finance (kecuali Backup MikroTik yang tetap
  // admin-only). Prefix email berikut SENGAJA tidak diblok:
  //   /email-broadcast, /email-template, /email-log, /email-schedule
  '/mikrotik-backup',   // backup konfigurasi router — admin only
  '/message-logs',      // log WA — admin only
  '/topology',
  '/tickets',
  '/todos',
  '/work-orders',
  '/assets',
  '/infrastructure',
  '/snmp',
  '/traffic',
  '/queue',
  '/ippool',
  '/voucher',
  '/voucher-template',
  '/invoice-template',  // template editor — admin only (finance bisa lihat list invoice via /billing)
  '/notifications/admin',
  '/push',
  '/gps',
  '/technician-location',
  '/work-order',
  '/users',             // user management — admin only
  '/roles',
  '/permissions',
  '/activity-logs',
  '/system',
  '/resources',
];
for (const p of _financeBlockedPrefixes) {
  router.use(p, authenticate, apiBlockFinanceArea);
}
// Settings: GET app-settings boleh (untuk load brand), tapi POST/PUT/DELETE ditolak
router.use('/app-settings', authenticate, (req, res, next) => {
  if (req.method === 'GET') return next();
  return apiBlockFinanceArea(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════
// NOC ROLE — API ACCESS RESTRICTIONS
// Role 'noc' fokus monitoring jaringan. TIDAK boleh akses modul billing,
// payments, customers (admin), packages, keuangan, settings, users, dll.
// API monitoring/devices/mikrotik/genieacs/hotspot tetap accessible.
// ═══════════════════════════════════════════════════════════════════
const _nocBlockedPrefixes = [
  '/billing',           // billing & invoice
  '/payments',          // pembayaran customer
  '/keuangan',          // keuangan
  '/finance',           // finance dashboard endpoints
  '/laporan',           // laporan keuangan
  '/packages',          // paket layanan (price)
  '/voucher',
  '/voucher-template',
  '/invoice-template',
  '/customers',         // customer CRUD (NOC bisa cek dari monitoring)
  '/wa',                // WA gateway full (NOC bisa lihat status, tapi tidak kirim)
  '/whatsapp',
  '/broadcast',
  '/email-broadcast',
  '/email-template',
  '/email-log',
  '/email-schedule',
  '/mikrotik-backup',
  '/message-logs',
  '/users',             // user management
  '/roles',
  '/permissions',
  '/activity-logs',
  '/system',
];
for (const p of _nocBlockedPrefixes) {
  router.use(p, authenticate, apiBlockNocArea);
}
// Settings: GET boleh, mutasi tidak
router.use('/app-settings', authenticate, (req, res, next) => {
  if (req.method === 'GET') return next();
  return apiBlockNocArea(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════
// SALES ROLE — API ACCESS RESTRICTIONS
// Role 'sales' fokus akuisisi pelanggan. HANYA boleh akses /sales/*.
// Diblok dari semua modul admin (monitoring, billing, customers, devices,
// users, settings, dll) supaya global search di topbar & akses langsung
// tidak membocorkan data. Admin/superadmin tidak terpengaruh.
// ═══════════════════════════════════════════════════════════════════
const _salesBlockedPrefixes = [
  '/billing', '/payments', '/keuangan', '/finance', '/laporan',
  '/packages', '/voucher', '/voucher-template', '/invoice-template',
  '/customers', '/devices', '/infrastructure', '/monitoring', '/mikrotik',
  '/genieacs', '/olt', '/ont', '/hotspot', '/isolir', '/radius', '/wireguard',
  '/wa', '/whatsapp', '/broadcast', '/email-broadcast', '/mikrotik-backup', '/message-logs',
  '/users', '/roles', '/permissions', '/activity-logs', '/system',
  '/dashboard',
  // Catatan: /tickets, /todos, /work-orders SENGAJA tidak diblok —
  // role sales kini boleh membuat & mengelola tiket, to-do, work order.
];
for (const p of _salesBlockedPrefixes) {
  router.use(p, authenticate, apiBlockSalesArea);
}

// ===== DASHBOARD =====
router.get('/dashboard/overview', authenticate, demoGuard, DashboardController.overview);
router.get('/dashboard/top-customers', authenticate, demoGuard, DashboardController.topCustomersBandwidth);
router.get('/dashboard/network-uptime', authenticate, demoGuard, DashboardController.networkUptime);
router.get('/dashboard/ticket-stats', authenticate, demoGuard, DashboardController.ticketStats);
router.get('/dashboard/bandwidth-trends', authenticate, demoGuard, DashboardController.bandwidthTrends);
router.get('/dashboard/bandwidth-interfaces', authenticate, demoGuard, DashboardController.bandwidthInterfaces);
router.get('/dashboard/customer-map-points', authenticate, demoGuard, DashboardController.customerMapPoints);
router.get('/dashboard/alerts', authenticate, demoGuard, DashboardController.alerts);
router.get('/dashboard/customer-growth', authenticate, demoGuard, DashboardController.customerGrowth);
router.get('/dashboard/customer-growth-list', authenticate, demoGuard, DashboardController.customerGrowthList);
router.get('/dashboard/revenue-forecast', authenticate, demoGuard, DashboardController.revenueForecast);

// Dashboard Layout Customization
router.get('/dashboard/layout', authenticate, demoGuard, DashboardLayoutController.getLayout);
router.post('/dashboard/layout', authenticate, demoGuard, DashboardLayoutController.saveLayout);
router.post('/dashboard/layout/reset', authenticate, demoGuard, DashboardLayoutController.resetLayout);


// ===== USERS =====
router.get('/users', authenticate, demoGuard, authorize('superadmin', 'admin'), UserController.index);
router.post('/users', authenticate, demoGuard, authorize('superadmin'), logActivity('create', 'user'), UserController.create);
router.get('/users/:id', authenticate, demoGuard, authorize('superadmin', 'admin'), UserController.show);
router.put('/users/:id', authenticate, demoGuard, authorize('superadmin'), logActivity('update', 'user'), UserController.update);
router.delete('/users/:id', authenticate, demoGuard, authorize('superadmin'), logActivity('delete', 'user'), UserController.destroy);

// ===== ROLES & PERMISSIONS =====
router.get('/roles', authenticate, demoGuard, UserController.getRoles);
router.post('/roles', authenticate, demoGuard, authorize('superadmin'), logActivity('create', 'role'), UserController.createRole);
router.put('/roles/:id', authenticate, demoGuard, authorize('superadmin'), logActivity('update', 'role'), UserController.updateRole);
router.delete('/roles/:id', authenticate, demoGuard, authorize('superadmin'), logActivity('delete', 'role'), UserController.deleteRole);
router.get('/permissions', authenticate, demoGuard, authorize('superadmin'), UserController.getPermissions);

// ===== WILAYAH INDONESIA (data sendiri, untuk dropdown alamat) =====
// Publik: data referensi non-sensitif, dipakai juga oleh halaman registrasi publik.
router.get('/regions/provinces',             RegionController.provinces.bind(RegionController));
router.get('/regions/regencies/:provinceId', RegionController.regencies.bind(RegionController));
router.get('/regions/districts/:regencyId',  RegionController.districts.bind(RegionController));
router.get('/regions/villages/:districtId',  RegionController.villages.bind(RegionController));

// ===== CUSTOMERS =====
router.get('/customers', authenticate, demoGuard, CustomerController.index);
router.post('/customers', authenticate, demoGuard, hasPermission('customer_create'), logActivity('create', 'customer'), CustomerController.create);
router.get('/customers/stats', authenticate, demoGuard, CustomerController.stats);
router.get('/customers/map', authenticate, demoGuard, CustomerController.mapData);
router.get('/customers/next-id', authenticate, demoGuard, CustomerController.nextCustomerId);
router.get('/customers/check-id', authenticate, demoGuard, CustomerController.checkCustomerId);
// Filter per-area (berjenjang) + backfill area dari teks alamat (data lama)
router.get('/customers/areas', authenticate, demoGuard, CustomerController.areas);
router.post('/customers/backfill-areas', authenticate, demoGuard, hasPermission('customer_create'), logActivity('update', 'customer'), CustomerController.backfillAreas);

// Buat link pembayaran permanen untuk SEMUA pelanggan yang belum punya (massal).
// Ditempatkan sebelum route '/customers/:id' agar tidak ke-capture sebagai :id.
router.post('/customers/payment-link/generate-all',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('generate_all', 'customer_payment_link'),
  CustomerController.generateAllPaymentLinks);

// ── Customer Import / Export ──────────────────────────────────────────
const CustomerImportController = require('../controllers/CustomerImportController');
const customerImportStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../uploads/imports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `customer-import-${ts}${path.extname(file.originalname).toLowerCase()}`);
  }
});
const customerImportUpload = multer({
  storage: customerImportStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan .xlsx atau .xls'));
  }
});

router.get('/customers/export',
  authenticate, demoGuard, hasPermission('customer_view'),
  CustomerImportController.exportExcel);

router.get('/customers/import-template',
  authenticate, demoGuard, hasPermission('customer_view'),
  CustomerImportController.downloadTemplate);

router.post('/customers/import-preview',
  authenticate, demoGuard, hasPermission('customer_create'),
  customerImportUpload.single('file'),
  CustomerImportController.importPreview);

router.post('/customers/import-confirm',
  authenticate, demoGuard, hasPermission('customer_create'),
  logActivity('import', 'customer'),
  CustomerImportController.importConfirm);

// ── Bulk Provisioning PPPoE ke MikroTik ───────────────────────────────
// Semua endpoint di bawah /api/pppoe/bulk/... (lihat routes/pppoeBulk.js).
// TANPA baris ini, seluruh endpoint bulk PPPoE akan 404.
const pppoeBulkRoutes = require('./pppoeBulk');
router.use('/pppoe/bulk', pppoeBulkRoutes);

// ===== HRIS (karyawan, absensi, shift, jadwal, payroll) =====
// Guard akses & self-service diatur di dalam routes/hris.js
const hrisRoutes = require('./hris');
router.use('/hris', hrisRoutes);

// ===== RADIUS (AAA terpusat — NAS clients, users, accounting) =====
const radiusRoutes = require('./radius');
router.use('/radius', radiusRoutes);

// ===== WIREGUARD (VPN interface & peer management) =====
const wireguardRoutes = require('./wireguard');
router.use('/wireguard', wireguardRoutes);

router.get('/customers/:id', authenticate, demoGuard, CustomerController.show);
router.put('/customers/:id', authenticate, demoGuard, hasPermission('customer_update'), logActivity('update', 'customer'), CustomerController.update);
router.delete('/customers/:id', authenticate, demoGuard, hasPermission('customer_delete'), logActivity('delete', 'customer'), CustomerController.destroy);

// ── Portal Credentials (admin-only) ───────────────────────────────────
// Admin mengubah customer_id & password yang dipakai pelanggan
// untuk login ke Customer Portal. Password di-bcrypt di controller —
// JANGAN pernah set portal_password via PUT /customers/:id generic.
router.get('/customers/:id/portal-credentials',
  authenticate, demoGuard, hasPermission('customer_view'),
  CustomerController.getPortalCredentials);

router.post('/customers/:id/portal-credentials',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('update', 'customer_portal_credentials'),
  CustomerController.updatePortalCredentials);

router.post('/customers/:id/portal-credentials/reset',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('reset', 'customer_portal_password'),
  CustomerController.resetPortalPassword);

// Rename / clear PPPoE username (opsional sync ke router MikroTik).
// Dipakai dari Edit Customer saat PPPoE username diubah atau dikosongkan.
router.post('/customers/:id/rename-pppoe',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('rename_pppoe', 'customer'),
  CustomerController.renamePppoe);

// ── Permanent payment link per-pelanggan ──
// GET    → ambil link saat ini (atau null kalau belum dibuat)
// POST   → buat / regenerate (revoke lama) token → link baru
// DELETE → cabut link (set token = NULL)
router.get('/customers/:id/payment-link',
  authenticate, demoGuard, CustomerController.getPaymentLink);
router.post('/customers/:id/payment-link',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('generate', 'customer_payment_link'),
  CustomerController.generatePaymentLink);
router.delete('/customers/:id/payment-link',
  authenticate, demoGuard, hasPermission('customer_update'),
  logActivity('revoke', 'customer_payment_link'),
  CustomerController.revokePaymentLink);

// ===== PACKAGES =====
router.get('/packages/stats', authenticate, demoGuard, PackageController.stats);
router.get('/packages', authenticate, demoGuard, PackageController.index);
router.post('/packages', authenticate, demoGuard, authorize('superadmin', 'admin'), logActivity('create', 'package'), PackageController.create);
router.get('/packages/:id', authenticate, demoGuard, PackageController.show);
router.put('/packages/:id', authenticate, demoGuard, authorize('superadmin', 'admin'), logActivity('update', 'package'), PackageController.update);
router.delete('/packages/:id', authenticate, demoGuard, authorize('superadmin', 'admin'), logActivity('delete', 'package'), PackageController.destroy);

// ===== BILLING =====
router.get('/billing/invoices', authenticate, demoGuard, BillingController.listInvoices);
router.get('/billing/invoices/:id', authenticate, demoGuard, BillingController.showInvoice);
router.post('/billing/generate', authenticate, demoGuard, authorize('superadmin', 'admin', 'finance'), logActivity('generate', 'invoice'), BillingController.generateInvoices);
router.post('/billing/payment', authenticate, demoGuard, hasPermission('billing_payment'), logActivity('create', 'payment'), BillingController.recordPayment);
router.post('/billing/mark-overdue', authenticate, demoGuard, authorize('superadmin', 'admin'), BillingController.markOverdue);
router.post('/billing/invoices/:id/reminder', authenticate, demoGuard, BillingController.sendReminder);
router.post('/billing/invoices/:id/send-email', authenticate, demoGuard, BillingController.sendEmail);
router.post('/billing/invoices/send-email-bulk', authenticate, demoGuard, BillingController.sendEmailBulk);
// Broadcast Invoice via email: preview format & statistik
router.post('/billing/invoice-email/preview', authenticate, demoGuard, BillingController.previewInvoiceEmail);
router.get('/billing/invoice-email/preview', authenticate, demoGuard, BillingController.previewInvoiceEmail);
router.get('/billing/invoice-email/stats', authenticate, demoGuard, BillingController.invoiceEmailStats);
router.post('/billing/invoices/:id/mark-paid', authenticate, demoGuard, BillingController.markPaid);

// ── Verifikasi bukti pembayaran manual (admin) ──
// view-proof: streaming file bukti (ber-auth, TIDAK publik)
// verify    : approve bukti → tandai invoice lunas (reuse markPaid flow)
// reject    : tolak bukti
router.get('/billing/invoices/:id/proof',
  authenticate, demoGuard, BillingController.viewProof);
router.post('/billing/invoices/:id/proof/verify',
  authenticate, demoGuard,
  logActivity('verify', 'payment_proof'), BillingController.verifyProof);
router.post('/billing/invoices/:id/proof/reject',
  authenticate, demoGuard,
  logActivity('reject', 'payment_proof'), BillingController.rejectProof);
// Daftar bukti pembayaran menunggu verifikasi (badge/inbox admin)
router.get('/billing/pending-proofs',
  authenticate, demoGuard, BillingController.listPendingProofs);
// Riwayat SEMUA bukti transfer manual (tab di halaman Payment)
router.get('/billing/proofs',
  authenticate, demoGuard, BillingController.listAllProofs);
router.post('/billing/bulk-reminder',          authenticate, demoGuard, BillingController.bulkReminder);
router.get('/billing/summary', authenticate, demoGuard, BillingController.financialSummary);
router.get('/billing/stats', authenticate, demoGuard, BillingController.stats);
router.get('/billing/collection-stats', authenticate, demoGuard, BillingController.collectionStats);
router.get('/billing/due-date-lists',   authenticate, demoGuard, BillingController.dueDateLists);
router.get('/billing/daily-transactions', authenticate, demoGuard, BillingController.dailyTransactions);
router.get('/billing/recent-transactions', authenticate, demoGuard, BillingController.recentTransactions);

// ─── FINANCE DASHBOARD SUPPORT ENDPOINTS ───
const FinanceController = require('../controllers/FinanceController');
router.get ('/finance/activity',         authenticate, demoGuard, FinanceController.activity);
router.get ('/finance/insights',         authenticate, demoGuard, FinanceController.insights);
router.get ('/finance/profit-loss',      authenticate, demoGuard, FinanceController.profitLoss);
router.get ('/finance/aging',            authenticate, demoGuard, FinanceController.agingReport);
router.get ('/finance/cashflow',         authenticate, demoGuard, FinanceController.cashFlow);
router.get ('/finance/monthly-series',   authenticate, demoGuard, FinanceController.monthlySeries);
router.get ('/finance/received',         authenticate, demoGuard, FinanceController.receivedThisMonth);
router.get ('/finance/projection',       authenticate, demoGuard, FinanceController.projection);
router.get ('/finance/tax-report',       authenticate, demoGuard, FinanceController.taxReport);
const FinanceReportController = require('../controllers/FinanceReportController');
router.get ('/finance/report/excel',     authenticate, demoGuard, (r,s)=>FinanceReportController.excel(r,s));
router.get ('/finance/report/pdf',       authenticate, demoGuard, (r,s)=>FinanceReportController.pdf(r,s));
router.post('/finance/quick-expense',    authenticate, demoGuard, FinanceController.quickExpense);
router.get ('/finance/reminder-config',  authenticate, demoGuard, FinanceController.reminderConfig);
router.post('/finance/reminder-config',  authenticate, demoGuard, FinanceController.toggleReminder);

// ─── NOC DASHBOARD SUPPORT ENDPOINTS ───
const NocController = require('../controllers/NocController');
router.get('/noc/overview',                 authenticate, demoGuard, NocController.overview);
router.get   ('/noc/alerts',                   authenticate, demoGuard, NocController.alerts);
router.get   ('/noc/alerts/debug',             authenticate, demoGuard, NocController.alertsDebug);
router.delete('/noc/alerts',                   authenticate, demoGuard, authorize('superadmin','admin'), NocController.clearAlerts);
router.get('/noc/ticket-stats',             authenticate, demoGuard, NocController.ticketStats);
// Router-specific endpoints (real-time data via MikroTik API)
router.get('/noc/routers',                  authenticate, demoGuard, NocController.routers);
router.get('/noc/router/:id/resource',      authenticate, demoGuard, NocController.routerResource);
router.get('/noc/router/:id/realtime',      authenticate, demoGuard, NocController.routerRealtime);
router.get('/noc/router/:id/history',       authenticate, demoGuard, NocController.routerHistory);
router.get('/noc/router/:id/interfaces',    authenticate, demoGuard, NocController.routerInterfaces);
router.get('/noc/router/:id/top-destinations', authenticate, demoGuard, NocController.routerTopDestinations);
router.get('/noc/router/:id/traffic-summary',  authenticate, demoGuard, NocController.routerTrafficSummary);

// Monitor preset CRUD (user-scoped bandwidth chart cards)
router.get   ('/noc/monitors',     authenticate, demoGuard, NocController.listMonitors);
router.post  ('/noc/monitors',     authenticate, demoGuard, NocController.createMonitor);
router.patch ('/noc/monitors/:id', authenticate, demoGuard, NocController.updateMonitor);
router.delete('/noc/monitors/:id', authenticate, demoGuard, NocController.deleteMonitor);

// PPPoE username → Customer name mapping (untuk NOC dashboard panel PPPoE)
router.get('/noc/pppoe-customer-map', authenticate, demoGuard, NocController.pppoeCustomerMap);

router.get('/billing/unpaid-customers', authenticate, demoGuard, BillingController.unpaidCustomers);
router.get('/billing/total-outstanding', authenticate, demoGuard, BillingController.totalOutstanding);

// ── Reset / Hapus Invoice (DESTRUCTIVE — superadmin only) ────
// Preview boleh admin (read-only); destroy hanya superadmin
router.get('/billing/invoices/reset/preview',
  authenticate, demoGuard,
  authorize('superadmin', 'admin'),
  BillingController.previewResetInvoices
);
router.post('/billing/invoices/reset',
  authenticate, demoGuard,
  authorize('superadmin'),
  logActivity('reset', 'invoice'),
  BillingController.resetInvoices
);
// ── Hapus invoice per-baris & multi-select (superadmin/admin) ────
// Sinkron dengan Generate: setelah dihapus, periode tsb bisa di-generate
// ulang karena generate bersifat idempotent (cek by customer+periode).
router.post('/billing/invoices/bulk-delete',
  authenticate, demoGuard,
  authorize('superadmin', 'admin'),
  logActivity('bulk_delete', 'invoice'),
  BillingController.bulkDeleteInvoices
);
router.delete('/billing/invoices/:id',
  authenticate, demoGuard,
  authorize('superadmin', 'admin'),
  logActivity('delete', 'invoice'),
  BillingController.deleteInvoice
);
// Recalculate tax untuk invoice unpaid sesuai setting PPN saat ini
router.post('/billing/recalculate-tax',
  authenticate, demoGuard,
  authorize('superadmin', 'admin'),
  logActivity('recalculate', 'invoice'),
  BillingController.recalculateTax
);
// Preview generate — cek berapa customer aktif & punya paket sebelum generate
router.get('/billing/generate/preview',
  authenticate, demoGuard,
  BillingController.previewGenerate
);

// ── Logo & Favicon Upload ────────────────────────────────────────────
// (multer/path/fs sudah di-require di atas)
//
// Catatan implementasi (FIX bug "logo tidak terganti & menumpuk di aaPanel"):
//   1. Multer menyimpan dengan ekstensi asli (logo.png, logo.jpg, dst).
//      Kalau user upload .jpg lalu .png, file lama TIDAK akan ter-overwrite
//      karena nama filenya beda. Solusi: sebelum simpan baru, hapus SEMUA
//      file dengan prefix 'logo.' / 'favicon.' apa pun ekstensinya.
//   2. URL yang disimpan ke DB ditambah `?v=<timestamp>` agar browser
//      melakukan refresh resource walau pathnya sama. Sidebar, tab favicon,
//      preview di settings — semua otomatis ikut.
//   3. fileSync (writeFile manual) dipakai supaya rangkaian "hapus lama →
//      tulis baru" deterministik, bukan dua step yang bisa race.

const UPLOAD_DIR = path.join(__dirname, '../../frontend/public/uploads');
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Hapus semua file di UPLOAD_DIR yang basename-nya (tanpa ekstensi) cocok
 * dengan `baseName`. Aman terhadap ekstensi yang berbeda dari upload sebelumnya.
 */
function cleanupOldBrandFiles(baseName) {
  try {
    ensureUploadDir();
    const files = fs.readdirSync(UPLOAD_DIR);
    files.forEach(f => {
      // Match "logo.xxx" tapi BUKAN "logo-something.xxx" (hindari hapus file lain)
      const stem = path.parse(f).name; // tanpa ext
      if (stem === baseName) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); }
        catch (e) { console.warn('[brand-upload] gagal hapus', f, e.message); }
      }
    });
  } catch (e) {
    console.warn('[brand-upload] cleanup error:', e.message);
  }
}

// Multer pakai memoryStorage — kita tulis file manual SETELAH cleanup,
// supaya tidak ada window di mana file lama & baru sama-sama eksis.
const brandMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // max 2MB
  fileFilter: (req, file, cb) => {
    // Filter ditangani di handler (logo & favicon punya allow-list berbeda)
    cb(null, true);
  }
});

router.post('/upload/logo', authenticate, demoGuard, brandMemoryUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });

    const allowed = ['.png','.jpg','.jpeg','.svg','.webp'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return res.status(400).json({ success: false, message: 'Format tidak didukung. Gunakan PNG/JPG/SVG/WebP' });
    }
    // Multer sudah enforce 2MB via limits, tapi jaga-jaga:
    if (req.file.size > 2 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Ukuran logo maksimal 2MB' });
    }

    ensureUploadDir();
    // 1) Hapus semua file logo.* lama (ekstensi apa pun)
    cleanupOldBrandFiles('logo');
    // 2) Tulis file baru
    const filename = 'logo' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);

    // 3) URL dengan cache-bust → memaksa browser fetch versi baru
    const version  = Date.now();
    const logoUrl  = `/uploads/${filename}?v=${version}`;

    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'logo_url', value: logoUrl, type: 'string' });
    if (typeof global._invalidateAppSettingsCache === 'function') {
      global._invalidateAppSettingsCache();
    }
    res.json({ success: true, url: logoUrl, message: 'Logo berhasil diupload' });
  } catch (e) {
    console.error('[upload/logo]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Hapus logo (revert ke default ikon)
router.delete('/upload/logo', authenticate, demoGuard, async (req, res) => {
  try {
    cleanupOldBrandFiles('logo');
    const { AppSetting } = require('../models');
    await AppSetting.destroy({ where: { key: 'logo_url' } });
    if (typeof global._invalidateAppSettingsCache === 'function') {
      global._invalidateAppSettingsCache();
    }
    res.json({ success: true, message: 'Logo dikembalikan ke default' });
  } catch (e) {
    console.error('[upload/logo DELETE]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Favicon Upload ──────────────────────────────────────────────────
// Favicon yang tampil di tab browser. Format direkomendasikan: .ico, .png (32x32 atau 64x64).
router.post('/upload/favicon', authenticate, demoGuard, brandMemoryUpload.single('favicon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Tidak ada file' });
    }

    const allowed = ['.ico', '.png', '.svg', '.jpg', '.jpeg'];
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return res.status(400).json({ success: false, message: 'Format tidak didukung. Gunakan ICO/PNG/SVG/JPG' });
    }
    if (req.file.size > 1 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'Ukuran favicon maksimal 1MB' });
    }

    ensureUploadDir();
    cleanupOldBrandFiles('favicon');
    const filename = 'favicon' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);

    const version    = Date.now();
    const faviconUrl = `/uploads/${filename}?v=${version}`;

    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'favicon_url', value: faviconUrl, type: 'string' });
    if (typeof global._invalidateAppSettingsCache === 'function') {
      global._invalidateAppSettingsCache();
    }
    res.json({
      success: true,
      url: faviconUrl,
      message: 'Favicon berhasil diupload. Refresh halaman untuk melihat perubahan di tab browser.'
    });
  } catch (e) {
    console.error('[upload/favicon]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Hapus favicon (revert ke default)
router.delete('/upload/favicon', authenticate, demoGuard, async (req, res) => {
  try {
    cleanupOldBrandFiles('favicon');
    const { AppSetting } = require('../models');
    await AppSetting.destroy({ where: { key: 'favicon_url' } });
    if (typeof global._invalidateAppSettingsCache === 'function') {
      global._invalidateAppSettingsCache();
    }
    res.json({ success: true, message: 'Favicon dikembalikan ke default' });
  } catch (e) {
    console.error('[upload/favicon DELETE]', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Portal Hero Image Upload (untuk halaman login customer portal) ─
const portalHeroStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'portal-hero' + ext);
  }
});
const portalHeroUpload = multer({
  storage: portalHeroStorage,
  limits: { fileSize: 4 * 1024 * 1024 }, // max 4MB (image bisa lebih besar dari logo)
  fileFilter: (req, file, cb) => {
    const allowed = ['.png','.jpg','.jpeg','.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

router.post('/upload/portal-hero', authenticate, demoGuard, portalHeroUpload.single('hero'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const heroUrl = '/uploads/' + req.file.filename + '?v=' + Date.now(); // cache-bust
    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'portal_hero_image', value: heroUrl, type: 'string' });
    res.json({ success: true, url: heroUrl, message: 'Foto hero berhasil diupload' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/upload/portal-hero', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'portal_hero_image', value: '', type: 'string' });
    res.json({ success: true, message: 'Foto hero dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Upload Background Halaman Pendaftaran (/registrasi-layanan) ──
const registerBgStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'register-bg' + ext);
  }
});
const registerBgUpload = multer({
  storage: registerBgStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png','.jpg','.jpeg','.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

router.post('/upload/register-bg', authenticate, demoGuard, registerBgUpload.single('bg'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const bgUrl = '/uploads/' + req.file.filename + '?v=' + Date.now(); // cache-bust
    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'register_bg_url', value: bgUrl, type: 'string' });
    res.json({ success: true, url: bgUrl, message: 'Background berhasil diupload' });
  } catch(e) { console.error('[upload/register-bg]', e); res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/upload/register-bg', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    await AppSetting.upsert({ key: 'register_bg_url', value: '', type: 'string' });
    res.json({ success: true, message: 'Background dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Upload Foto ODP/Infrastruktur ────────────────────────────
const infraPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads/infra');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'infra_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const infraPhotoUpload = multer({
  storage: infraPhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png','.jpg','.jpeg','.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

router.post('/upload/infra-photo', authenticate, demoGuard, infraPhotoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const url = '/uploads/infra/' + req.file.filename;
    res.json({ success: true, url, message: 'Foto berhasil diupload' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Upload Foto Profil / Avatar User ─────────────────────────
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads/avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'avatar_' + (req.user?.id || 'u') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // max 3MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png','.jpg','.jpeg','.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

// Upload / ganti foto profil user yang sedang login
router.post('/auth/avatar', authenticate, demoGuard, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const url = '/uploads/avatars/' + req.file.filename;
    // Hapus avatar lama (kalau file lokal) supaya tidak menumpuk
    const old = req.user.avatar;
    await req.user.update({ avatar: url });
    if (old && typeof old === 'string' && old.startsWith('/uploads/avatars/')) {
      const oldPath = path.join(__dirname, '../../frontend/public', old);
      fs.unlink(oldPath, () => {});
    }
    res.json({ success: true, url, avatar: url, message: 'Foto profil berhasil diperbarui' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Hapus foto profil (kembali ke inisial)
router.delete('/auth/avatar', authenticate, demoGuard, async (req, res) => {
  try {
    const old = req.user.avatar;
    await req.user.update({ avatar: null });
    if (old && typeof old === 'string' && old.startsWith('/uploads/avatars/')) {
      const oldPath = path.join(__dirname, '../../frontend/public', old);
      fs.unlink(oldPath, () => {});
    }
    res.json({ success: true, message: 'Foto profil dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Upload Logo Metode Pembayaran (bank/e-wallet/QRIS) ──────
const paymentLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads/payment');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'pay_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + ext);
  }
});
const paymentLogoUpload = multer({
  storage: paymentLogoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // max 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png','.jpg','.jpeg','.svg','.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/SVG/WebP'));
  }
});

router.post('/upload/payment-logo', authenticate, demoGuard, paymentLogoUpload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });
    const url = '/uploads/payment/' + req.file.filename;
    res.json({ success: true, url, message: 'Logo berhasil diupload' });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Customer Documents (Foto Rumah & Foto KTP) ──────────────
// Disimpan di frontend/public/uploads/customer (di-serve via /uploads/customer/...).
// Metadata path disimpan di kolom Customer.documents (JSON) dengan struktur:
//   { house: { url, name, size, uploaded_at }, ktp: { url, ... } }
const customerDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads/customer');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const slot = (req.params.slot || 'doc').replace(/[^a-z0-9_]/gi, '');
    const cid  = (req.params.id || 'x').replace(/[^a-z0-9_]/gi, '');
    cb(null, 'cust_' + cid + '_' + slot + '_' + Date.now() + ext);
  }
});
const customerDocUpload = multer({
  storage: customerDocStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // max 8MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

const CUST_DOC_SLOTS = ['house', 'ktp'];

// Upload / replace satu dokumen (slot = 'house' atau 'ktp')
router.post('/customers/:id/document/:slot',
  authenticate, demoGuard, hasPermission('customer_update'),
  customerDocUpload.single('photo'),
  async (req, res) => {
    try {
      const { Customer } = require('../models');
      const slot = req.params.slot;
      if (!CUST_DOC_SLOTS.includes(slot)) {
        return res.status(400).json({ success: false, message: 'Slot dokumen tidak valid' });
      }
      if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });

      const customer = await Customer.findByPk(req.params.id);
      if (!customer) {
        // bersihkan file yang sudah terlanjur terupload
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });
      }

      // documents bisa null / array (default lama) → normalisasi jadi object
      let docs = customer.documents;
      if (!docs || Array.isArray(docs) || typeof docs !== 'object') docs = {};

      // Hapus file lama di slot ini (kalau ada) supaya tidak menumpuk
      const old = docs[slot];
      if (old && old.url) {
        const resolved = path.join(__dirname, '../../frontend/public', old.url.replace(/^\/+/, ''));
        try { if (fs.existsSync(resolved)) fs.unlinkSync(resolved); } catch (e) { /* ignore */ }
      }

      docs[slot] = {
        url:         '/uploads/customer/' + req.file.filename,
        name:        req.file.originalname,
        size:        req.file.size,
        uploaded_at: new Date().toISOString()
      };

      // changed() perlu di-flag karena Sequelize tidak selalu deteksi mutasi JSON in-place
      customer.documents = docs;
      customer.changed('documents', true);
      await customer.save();

      res.json({ success: true, data: docs[slot], documents: docs, message: 'Dokumen berhasil diupload' });
    } catch (e) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch (er) {} }
      res.status(500).json({ success: false, message: e.message });
    }
  }
);

// Hapus satu dokumen
router.delete('/customers/:id/document/:slot',
  authenticate, demoGuard, hasPermission('customer_update'),
  async (req, res) => {
    try {
      const { Customer } = require('../models');
      const slot = req.params.slot;
      if (!CUST_DOC_SLOTS.includes(slot)) {
        return res.status(400).json({ success: false, message: 'Slot dokumen tidak valid' });
      }
      const customer = await Customer.findByPk(req.params.id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });

      let docs = customer.documents;
      if (!docs || Array.isArray(docs) || typeof docs !== 'object') docs = {};

      const entry = docs[slot];
      if (entry && entry.url) {
        const resolved = path.join(__dirname, '../../frontend/public', entry.url.replace(/^\/+/, ''));
        try { if (fs.existsSync(resolved)) fs.unlinkSync(resolved); } catch (e) { /* ignore */ }
      }
      delete docs[slot];

      customer.documents = docs;
      customer.changed('documents', true);
      await customer.save();

      res.json({ success: true, documents: docs, message: 'Dokumen dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
);

// ── Tools (IP Scan + Hotspot Binding Management) ────────────
const ToolsCtrl = require('../controllers/ToolsController');
router.get('/tools/routers',              authenticate, demoGuard, (r,s) => ToolsCtrl.listRouters(r,s));
router.get('/tools/interfaces',           authenticate, demoGuard, (r,s) => ToolsCtrl.listInterfaces(r,s));
router.post('/tools/ip-scan',             authenticate, demoGuard, (r,s) => ToolsCtrl.ipScan(r,s));
router.post('/tools/bind-customer',       authenticate, authorize('superadmin','admin'), demoGuard, logActivity('bind','hotspot_binding'), (r,s) => ToolsCtrl.bindToCustomer(r,s));
// Hotspot Binding management
router.get('/tools/hotspot/customers',    authenticate, demoGuard, (r,s) => ToolsCtrl.listHotspotCustomers(r,s));
router.get('/tools/hotspot/bindings',     authenticate, demoGuard, (r,s) => ToolsCtrl.listBindings(r,s));
router.get('/tools/hotspot/sync',         authenticate, demoGuard, (r,s) => ToolsCtrl.syncBindingStatus(r,s));
router.post('/tools/hotspot/customers/:id/isolir',  authenticate, authorize('superadmin','admin'), demoGuard, logActivity('isolir','hotspot_binding'), (r,s) => ToolsCtrl.isolir(r,s));
router.post('/tools/hotspot/customers/:id/restore', authenticate, authorize('superadmin','admin'), demoGuard, logActivity('restore','hotspot_binding'), (r,s) => ToolsCtrl.restore(r,s));
router.post('/tools/hotspot/bindings',              authenticate, authorize('superadmin','admin'), demoGuard, logActivity('create','hotspot_binding'), (r,s) => ToolsCtrl.createBinding(r,s));
router.delete('/tools/hotspot/bindings/:bindingId', authenticate, authorize('superadmin','admin'), demoGuard, logActivity('delete','hotspot_binding'), (r,s) => ToolsCtrl.deleteBinding(r,s));
router.post('/tools/hotspot/bindings/:bindingId/toggle', authenticate, authorize('superadmin','admin'), demoGuard, logActivity('toggle','hotspot_binding'), (r,s) => ToolsCtrl.toggleBinding(r,s));

// ── IP Addressing (manajemen /ip/address MikroTik) ──────────
const IpAddrCtrl = require('../controllers/IpAddressController');
router.get('/ip-addressing',            authenticate, demoGuard, (r,s) => IpAddrCtrl.list(r,s));
router.post('/ip-addressing',           authenticate, authorize('superadmin','admin'), demoGuard, logActivity('create','ip_address'), (r,s) => IpAddrCtrl.create(r,s));
router.put('/ip-addressing/:id',        authenticate, authorize('superadmin','admin'), demoGuard, logActivity('update','ip_address'), (r,s) => IpAddrCtrl.update(r,s));
router.delete('/ip-addressing/:id',     authenticate, authorize('superadmin','admin'), demoGuard, logActivity('delete','ip_address'), (r,s) => IpAddrCtrl.remove(r,s));
router.post('/ip-addressing/:id/toggle',authenticate, authorize('superadmin','admin'), demoGuard, logActivity('toggle','ip_address'), (r,s) => IpAddrCtrl.toggle(r,s));

// ── Isolir Management ───────────────────────────────────────
const IsolirCtrl = require('../controllers/IsolirController');
router.get('/isolir/stats',             authenticate, demoGuard, (r,s) => IsolirCtrl.stats(r,s));
router.get('/isolir/devices',           authenticate, demoGuard, (r,s) => IsolirCtrl.listDevices(r,s));
router.get('/isolir/available-devices', authenticate, demoGuard, (r,s) => IsolirCtrl.listAvailableDevices(r,s));
router.post('/isolir/devices',          authenticate, demoGuard, (r,s) => IsolirCtrl.saveDevice(r,s));
router.put('/isolir/devices/:id',       authenticate, demoGuard, (r,s) => IsolirCtrl.saveDevice(r,s));
router.delete('/isolir/devices/:id',    authenticate, demoGuard, (r,s) => IsolirCtrl.deleteDevice(r,s));
router.post('/isolir/devices/:id/ping', authenticate, demoGuard, (r,s) => IsolirCtrl.testConnection(r,s));
router.post('/isolir/devices/:id/setup-firewall', authenticate, demoGuard, (r,s) => IsolirCtrl.setupFirewall(r,s));
router.get('/isolir/isolated',          authenticate, demoGuard, (r,s) => IsolirCtrl.listIsolated(r,s));
router.get('/isolir/eligible',          authenticate, demoGuard, (r,s) => IsolirCtrl.listEligible(r,s));
router.get('/isolir/due-alerts',        authenticate, demoGuard, (r,s) => IsolirCtrl.dueAlerts(r,s));
router.post('/isolir/customers/:id/isolir',   authenticate, demoGuard, (r,s) => IsolirCtrl.isolir(r,s));
router.post('/isolir/customers/:id/restore',  authenticate, demoGuard, (r,s) => IsolirCtrl.restore(r,s));
router.post('/isolir/run-auto',         authenticate, demoGuard, (r,s) => IsolirCtrl.runAutoIsolir(r,s));
router.get('/isolir/logs',              authenticate, demoGuard, (r,s) => IsolirCtrl.getLogs(r,s));
router.get('/isolir/settings',          authenticate, demoGuard, (r,s) => IsolirCtrl.getSettings(r,s));
router.post('/isolir/settings',         authenticate, demoGuard, (r,s) => IsolirCtrl.saveSettings(r,s));

// ── Bypass list (situs/IP yang masih boleh diakses pelanggan diisolir) ──
router.get('/isolir/bypass/global',                  authenticate, demoGuard, (r,s) => IsolirCtrl.listGlobalBypass(r,s));
router.post('/isolir/bypass/global',                 authenticate, demoGuard, (r,s) => IsolirCtrl.addGlobalBypass(r,s));
router.delete('/isolir/bypass/global/:id',           authenticate, demoGuard, (r,s) => IsolirCtrl.deleteGlobalBypass(r,s));
router.get('/isolir/devices/:id/bypass',             authenticate, demoGuard, (r,s) => IsolirCtrl.listRouterBypass(r,s));
router.post('/isolir/devices/:id/bypass',            authenticate, demoGuard, (r,s) => IsolirCtrl.addRouterBypass(r,s));
router.delete('/isolir/devices/:id/bypass/:entryId', authenticate, demoGuard, (r,s) => IsolirCtrl.deleteRouterBypass(r,s));
router.get('/isolir/devices/:id/bypass-merged',      authenticate, demoGuard, (r,s) => IsolirCtrl.previewMergedBypass(r,s));
router.post('/isolir/devices/:id/sync-bypass',       authenticate, demoGuard, (r,s) => IsolirCtrl.syncBypass(r,s));

// ── Web Proxy Redirect config (HTTP-only, RouterOS v6/v7 compatible) ──
router.get('/isolir/webproxy/config',  authenticate, demoGuard, (r,s) => IsolirCtrl.getWebProxyConfig(r,s));
router.post('/isolir/webproxy/config', authenticate, demoGuard, (r,s) => IsolirCtrl.saveWebProxyConfig(r,s));


// ── App Settings (brand, general, company, payment-gateway, tax) ─
router.post('/app-settings', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    // Whitelist setting keys yang boleh diubah lewat endpoint ini
    const allowed = [
      'brand_mode', 'app_name', 'app_tagline', 'logo_url',
      'company_name', 'company_whatsapp', 'company_address', 'company_website', 'snmp_community', 'poll_interval',
      // Portal customer branding
      'portal_hero_image', 'portal_hero_overlay', 'portal_welcome_title', 'portal_welcome_sub', 'portal_terms_url', 'portal_terms_label',
      // Background halaman pendaftaran publik
      'register_bg_url', 'register_bg_overlay',
      // Note: payment_accounts punya endpoint tersendiri (di bawah)
      'payment_gateway_enabled', 'payment_gateway_provider', 'payment_gateway_env',
      'payment_gateway_server_key', 'payment_gateway_client_key', 'payment_gateway_callback_token',
      // Duitku-specific: merchantCode (dipisah dari server_key yang dipakai sebagai apiKey)
      'payment_gateway_merchant_code',
      // Tripay-specific: private key (untuk signature transaksi & verifikasi callback HMAC-SHA256)
      'payment_gateway_private_key',
      // Tax / PPN settings
      'tax_enabled', 'tax_rate', 'tax_mode', 'tax_label',
      // Auto-generate invoice (cron tiap awal bulan)
      'auto_generate_invoice',
      // Penomoran & kebijakan invoice
      'invoice_prefix', 'invoice_due_days', 'invoice_late_fee_percent',
      // Tema warna (white-label)
      'theme_enabled', 'theme_primary_color', 'theme_accent_color',
      // Localization
      'locale_timezone', 'locale_date_format', 'locale_currency',
      // SMTP / Email
      'smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_from_name', 'email_reminder_enabled', 'email_attach_receipt',
      // Format email invoice (dipakai bersama halaman Broadcast Invoice — saling sinkron)
      'invoice_email_subject_unpaid', 'invoice_email_subject_paid',
      'invoice_email_header_unpaid', 'invoice_email_header_paid',
      'invoice_email_intro_unpaid', 'invoice_email_intro_paid',
      'invoice_email_footer_note', 'invoice_email_show_bank', 'invoice_email_show_paybtn',
      'invoice_email_paybtn_label', 'public_base_url',
      // WA Gateway: session default untuk pengiriman OTOMATIS (cron, notif, dll)
      'default_wa_session',
      // Telegram Monitoring
      'telegram_enabled', 'telegram_bot_token', 'telegram_chat_id',
      'telegram_notif_device', 'telegram_notif_ont', 'telegram_notif_ip',
      'telegram_notif_pppoe',
      'telegram_interval',
      // Push reminder tagihan otomatis (cron harian)
      'push_reminder_enabled',
      'push_reminder_send_hour', 'push_reminder_overdue_hour',
      'push_reminder_h3_enabled', 'push_reminder_h1_enabled', 'push_reminder_h0_enabled',
      'push_reminder_overdue_enabled',
      'push_reminder_h3_title', 'push_reminder_h3_body',
      'push_reminder_h1_title', 'push_reminder_h1_body',
      'push_reminder_h0_title', 'push_reminder_h0_body',
      'push_reminder_overdue_title', 'push_reminder_overdue_body',
      // Push notif isolir / restore
      'push_isolir_enabled',
      'push_isolir_title', 'push_isolir_body',
      'push_restore_title', 'push_restore_body',
      // Telegram template pesan (bisa dikustom)
      'telegram_tpl_device_down', 'telegram_tpl_device_recover',
      'telegram_tpl_ont_down', 'telegram_tpl_ont_recover',
      'telegram_tpl_ip_down', 'telegram_tpl_ip_recover',
      'telegram_tpl_pppoe_down', 'telegram_tpl_pppoe_recover',
      // Invoice template designer (semua key prefix invtpl_)
      'invtpl_primary_color', 'invtpl_accent_color', 'invtpl_text_color',
      'invtpl_font_family', 'invtpl_paper_size', 'invtpl_header_style',
      'invtpl_show_logo', 'invtpl_logo_url',
      'invtpl_company_name', 'invtpl_company_tagline',
      'invtpl_company_address', 'invtpl_company_phone', 'invtpl_company_email',
      'invtpl_show_subtotal', 'invtpl_show_tax', 'invtpl_show_due_date',
      'invtpl_show_signature', 'invtpl_show_active_until', 'invtpl_show_payment_method',
      'invtpl_show_bank_info', 'invtpl_footer_text', 'invtpl_thank_you_text',
      'invtpl_invoice_label', 'invtpl_section_recipient_label', 'invtpl_section_detail_label',
      // Voucher template designer (semua key prefix vtpl_)
      'vtpl_primary_color', 'vtpl_primary_dark', 'vtpl_accent_color',
      'vtpl_company_name', 'vtpl_tagline', 'vtpl_logo_url',
      'vtpl_label_username', 'vtpl_label_password', 'vtpl_label_profile',
      'vtpl_label_duration', 'vtpl_label_price',
      'vtpl_show_wifi', 'vtpl_show_price', 'vtpl_show_duration',
      'vtpl_show_profile', 'vtpl_show_footer',
      'vtpl_columns', 'vtpl_footer_text',
      // Email Template Manager — semua key prefix emailtpl_ (type_field).
      // Di-generate dari registry agar selalu sinkron dgn EmailTemplateService.
      ...(() => {
        try {
          const EmailTpl = require('../services/EmailTemplateService');
          const out = [];
          Object.keys(EmailTpl.TEMPLATES).forEach(type => {
            EmailTpl.FIELDS.forEach(f => out.push(`emailtpl_${type}_${f}`));
          });
          return out;
        } catch (_) { return []; }
      })()
    ];
    let taxChanged = false;
    let brandChanged = false;
    let tgIntervalChanged = false;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        await AppSetting.upsert({ key, value: String(req.body[key] || ''), type: 'string' });
        if (key.startsWith('tax_')) taxChanged = true;
        if (key === 'app_name' || key === 'company_name') brandChanged = true;
        if (key === 'telegram_interval') tgIntervalChanged = true;
        // Mirror key emailtpl_invoice_* → invoice_email_* (sinkron dgn sistem lama)
        if (key.startsWith('emailtpl_')) {
          try {
            const m = key.match(/^emailtpl_(invoice_unpaid|invoice_paid)_(\w+)$/);
            if (m) {
              const mirror = require('../services/EmailTemplateService').legacyMirror(m[1], m[2], String(req.body[key] || ''));
              if (mirror) await AppSetting.upsert({ key: mirror.key, value: mirror.value, type: 'string' });
            }
          } catch (_) {}
        }
        // Refresh cache GatewayService kalau session default diganti
        if (key === 'default_wa_session') {
          try { require('../services/GatewayService').invalidateSessionCache(); } catch (_) {}
        }
      }
    }
    // Reset cache PPN agar perubahan langsung berlaku
    if (taxChanged) {
      try { require('../utils/taxHelper').invalidateCache(); } catch (_) {}
    }
    // Reset cache prefix invoice bila diubah
    if (req.body.invoice_prefix !== undefined) {
      try { require('../utils/helpers').invalidateInvoicePrefixCache(); } catch (_) {}
    }
    // Reload SMTP bila konfigurasi email berubah
    if (['smtp_enabled','smtp_host','smtp_port','smtp_secure','smtp_user','smtp_pass','smtp_from','smtp_from_name'].some(k => req.body[k] !== undefined)) {
      try { require('../services/EmailService').reload(); } catch (_) {}
    }
    // Bersihkan cache template email bila ada key emailtpl_ yang diubah
    if (Object.keys(req.body || {}).some(k => k.startsWith('emailtpl_'))) {
      try { require('../services/EmailTemplateService').clearCache(); } catch (_) {}
    }
    // Invalidate cache app settings global (untuk tema/brand di res.locals) bila tema/brand berubah
    if (['theme_enabled','theme_primary_color','theme_accent_color','app_name','app_tagline','brand_mode'].some(k => req.body[k] !== undefined)) {
      try { global._invalidateAppSettingsCache && global._invalidateAppSettingsCache(); } catch (_) {}
    }
    // Reset cache companyInfo agar variable {perusahaan} di template WA
    // langsung pakai nama baru (tanpa menunggu TTL 30 detik habis)
    if (brandChanged) {
      try { require('../utils/companyInfo').clearCompanyNameCache(); } catch (_) {}
    }
    // Invalidate cache app-settings di server.js supaya perubahan
    // app_name/logo/favicon langsung terlihat di title browser & UI
    if (typeof global._invalidateAppSettingsCache === 'function') {
      global._invalidateAppSettingsCache();
    }
    // Terapkan interval pengecekan Telegram baru tanpa restart
    if (tgIntervalChanged) {
      try { await require('../services/CronService').rescheduleTelegramMonitoring(); } catch (_) {}
    }
    res.json({ success: true, message: 'Pengaturan disimpan' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/app-settings', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const rows = await AppSetting.findAll();
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Email Template: render live preview (pakai draft dari body) ──────
// Body: { type, draft:{ subject, heading, intro, outro, button_label, accent } }
// Mengembalikan { subject, html } untuk ditampilkan di iframe preview.
router.post('/email-template/preview', authenticate, demoGuard, async (req, res) => {
  try {
    const EmailTpl = require('../services/EmailTemplateService');
    const type = String((req.body && req.body.type) || '');
    const meta = EmailTpl.TEMPLATES[type];
    if (!meta) return res.status(400).json({ success: false, message: 'Tipe template tidak dikenal' });

    // Konfigurasi efektif tersimpan, lalu ditimpa draft dari editor (unsaved).
    const saved = await EmailTpl.getConfig(type, true);
    const draft = (req.body && req.body.draft) || {};
    const cfg = { ...saved };
    EmailTpl.FIELDS.forEach(f => {
      if (draft[f] !== undefined && draft[f] !== null) cfg[f] = String(draft[f]);
    });

    // Nama perusahaan nyata untuk {perusahaan}.
    let companyName = '';
    try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
    const vars = { ...(meta.sample || {}), perusahaan: companyName || (meta.sample && meta.sample.perusahaan) || 'ISP' };

    const apply = (t) => EmailTpl.applyVars(t, vars);
    const esc = EmailTpl.escapeHtml;

    // Blok rincian contoh — beda per tipe, agar preview terasa realistis.
    let bodyExtra = '';
    const rowsTbl = (pairs) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;font-size:13px;">`
      + pairs.map((p, i) => `<tr${i % 2 ? ' style="background:#f8faff;"' : ''}><td style="padding:9px 14px;color:#6b7fa8;">${esc(p[0])}</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;">${esc(p[1])}</td></tr>`).join('')
      + `</table>`;
    if (type === 'invoice_unpaid' || type === 'invoice_overdue') {
      bodyExtra = rowsTbl([['No. Invoice', vars.invoice], ['Paket', vars.paket], ['Periode', vars.periode], ['Jumlah', vars.jumlah], ['Jatuh Tempo', vars.jatuh_tempo]]);
    } else if (type === 'invoice_paid') {
      bodyExtra = rowsTbl([['No. Invoice', vars.invoice], ['Metode', vars.metode], ['Tanggal Bayar', vars.tanggal_bayar], ['Jumlah', vars.jumlah]]);
    } else if (type === 'customer_welcome') {
      bodyExtra = rowsTbl([['ID Pelanggan', vars.id_pelanggan], ['Paket', vars.paket], ['Telepon', vars.telepon], ['Email', vars.email]]);
    } else if (type === 'voucher_delivery') {
      bodyExtra = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6ff;border:1px dashed #9cc2ff;border-radius:12px;">
        <tr><td style="padding:14px;text-align:center;">
          <div style="font-size:11px;color:#6b7fa8;letter-spacing:.05em;">USERNAME</div>
          <div style="font-size:18px;font-weight:800;color:#1565e0;font-family:'Courier New',monospace;margin:2px 0 8px;">${esc(vars.username)}</div>
          <div style="font-size:11px;color:#6b7fa8;letter-spacing:.05em;">PASSWORD</div>
          <div style="font-size:18px;font-weight:800;color:#1565e0;font-family:'Courier New',monospace;margin-top:2px;">${esc(vars.password)}</div>
        </td></tr></table>`;
    }

    // Rakit HTML preview via wrapHtml memakai cfg (default tersimpan + draft editor),
    // sehingga preview mencerminkan perubahan yang BELUM disimpan.
    const introHtml = esc(apply(cfg.intro)).replace(/\n/g, '<br>');
    const outroHtml = esc(apply(cfg.outro)).replace(/\n/g, '<br>');
    const html = EmailTpl.wrapHtml({
      accent: cfg.accent,
      companyName: vars.perusahaan,
      heading: apply(cfg.heading),
      introHtml,
      bodyExtraHtml: bodyExtra,
      outroHtml,
      buttonLabel: cfg.button_label,
      buttonUrl: cfg.button_label ? 'https://example.com/bayar' : '',
      footerNote: `Email ini dikirim otomatis oleh sistem ${esc(vars.perusahaan)}. Mohon tidak membalas email ini.`
    });

    res.json({ success: true, subject: apply(cfg.subject), html });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Email Template: kirim email uji ke alamat tertentu ──────────────
router.post('/email-template/send-test', authenticate, demoGuard, async (req, res) => {
  try {
    const to = String((req.body && req.body.to) || '').trim();
    const type = String((req.body && req.body.type) || 'smtp_test');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return res.status(400).json({ success: false, message: 'Alamat email tujuan tidak valid' });
    }

    // Rate limit sederhana: maks 5 kirim-uji / menit per user (cegah spam relay).
    try {
      global.__emailTestRL = global.__emailTestRL || {};
      const uid = (req.user && req.user.id) || 'anon';
      const now = Date.now();
      const win = (global.__emailTestRL[uid] || []).filter(t => now - t < 60000);
      if (win.length >= 5) {
        return res.status(429).json({ success: false, message: 'Terlalu sering. Coba lagi dalam 1 menit.' });
      }
      win.push(now);
      global.__emailTestRL[uid] = win;
    } catch (_) {}

    const EmailTpl = require('../services/EmailTemplateService');
    const EmailService = require('../services/EmailService');

    // Cek dulu status SMTP agar pesan ke user spesifik.
    const st = await EmailService.getStatus();
    if (!st.configured) {
      return res.status(400).json({ success: false, message: st.reason || 'SMTP belum dikonfigurasi di Settings' });
    }

    const meta = EmailTpl.TEMPLATES[type] || EmailTpl.TEMPLATES.smtp_test;
    let companyName = '';
    try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
    const vars = { ...(meta.sample || {}), waktu: new Date().toLocaleString('id-ID'), perusahaan: companyName || 'ISP' };
    const built = await EmailTpl.render(type, vars, { companyName: vars.perusahaan });
    const result = await EmailService.sendWithReason({ to, subject: '[TEST] ' + built.subject, html: built.html, text: built.text });
    if (!result.ok) return res.status(502).json({ success: false, message: result.reason || 'Gagal mengirim — cek konfigurasi SMTP' });
    res.json({ success: true, message: 'Email uji terkirim ke ' + to });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Email Log (Riwayat Email) ───────────────────────────────────────
// GET /api/email-log → daftar dengan filter (type, status, q, date range) + paging
router.get('/email-log', authenticate, demoGuard, async (req, res) => {
  try {
    const { EmailLog } = require('../models');
    const { Op } = require('sequelize');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const where = {};
    if (req.query.type && req.query.type !== 'all') where.type = String(req.query.type);
    if (req.query.status && req.query.status !== 'all') where.status = String(req.query.status);
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      where[Op.or] = [{ recipient: { [Op.like]: q } }, { subject: { [Op.like]: q } }];
    }
    if (req.query.from || req.query.to) {
      where.sent_at = {};
      if (req.query.from) where.sent_at[Op.gte] = new Date(String(req.query.from) + 'T00:00:00');
      if (req.query.to)   where.sent_at[Op.lte] = new Date(String(req.query.to) + 'T23:59:59');
    }
    const { rows, count } = await EmailLog.findAndCountAll({
      where, order: [['sent_at', 'DESC']], limit, offset: (page - 1) * limit
    });
    res.json({ success: true, data: rows, total: count, page, limit, pages: Math.ceil(count / limit) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/email-log/stats → ringkasan (total, sent, failed, hari ini)
router.get('/email-log/stats', authenticate, demoGuard, async (req, res) => {
  try {
    const { EmailLog } = require('../models');
    const { Op, fn, col, literal } = require('sequelize');
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const todayWhere = { sent_at: { [Op.gte]: startToday } };
    const [total, sent, failed, retrying, today, todaySent, todayFailed] = await Promise.all([
      EmailLog.count(),
      EmailLog.count({ where: { status: 'sent' } }),
      EmailLog.count({ where: { status: 'failed' } }),
      EmailLog.count({ where: { status: 'retrying' } }),
      EmailLog.count({ where: todayWhere }),
      EmailLog.count({ where: { ...todayWhere, status: 'sent' } }),
      EmailLog.count({ where: { ...todayWhere, status: 'failed' } })
    ]);
    // breakdown per type
    const byType = await EmailLog.findAll({
      attributes: ['type', [fn('COUNT', col('id')), 'cnt']],
      group: ['type'], order: [[literal('cnt'), 'DESC']], raw: true
    });
    // tren 7 hari terakhir (sent vs failed per hari)
    const since = new Date(Date.now() - 6 * 86400000); since.setHours(0, 0, 0, 0);
    const trendRows = await EmailLog.findAll({
      attributes: [
        [fn('DATE', col('sent_at')), 'd'],
        [fn('SUM', literal("CASE WHEN status='sent' THEN 1 ELSE 0 END")), 'sent'],
        [fn('SUM', literal("CASE WHEN status='failed' THEN 1 ELSE 0 END")), 'failed']
      ],
      where: { sent_at: { [Op.gte]: since } },
      group: [literal('DATE(sent_at)')], order: [[literal('d'), 'ASC']], raw: true
    });
    // success rate keseluruhan
    const denom = sent + failed;
    const successRate = denom > 0 ? +(sent / denom * 100).toFixed(1) : 100;
    res.json({ success: true, data: {
      total, sent, failed, retrying, today, todaySent, todayFailed,
      successRate, byType, trend: trendRows
    } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/email-log/retry-now → proses antrian retry email gagal segera
router.post('/email-log/retry-now', authenticate, demoGuard, async (req, res) => {
  try {
    const EmailService = require('../services/EmailService');
    const r = await EmailService.processRetryQueue(100);
    res.json({ success: true, data: r, message: `${r.sent} terkirim, ${r.scheduled} dijadwal ulang, ${r.failed} gagal (dari ${r.processed} diproses)` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/email-log/:id/retry → paksa retry satu email gagal (reset jadwal)
router.post('/email-log/:id/retry', authenticate, demoGuard, async (req, res) => {
  try {
    const { EmailLog } = require('../models');
    const row = await EmailLog.findByPk(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Log tidak ditemukan' });
    const p = row.payload || {};
    if (!p.to || (!p.html && !p.text)) {
      return res.status(400).json({ success: false, message: 'Email ini tidak punya data untuk dikirim ulang' });
    }
    await row.update({ status: 'retrying', next_retry_at: new Date() });
    const EmailService = require('../services/EmailService');
    const r = await EmailService.processRetryQueue(5);
    res.json({ success: true, data: r, message: r.sent ? 'Email berhasil dikirim ulang' : 'Percobaan ulang dijalankan' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/email/digest/test → kirim digest harian sekarang (untuk uji)
// body: { to } — opsional; bila kosong pakai digest_recipients tersimpan.
router.post('/email/digest/test', authenticate, demoGuard, async (req, res) => {
  try {
    let to = String((req.body && req.body.to) || '').trim();
    if (!to) {
      const { AppSetting } = require('../models');
      const row = await AppSetting.findOne({ where: { key: 'digest_recipients' } });
      to = String(row?.value || '').trim();
    }
    if (!to) return res.status(400).json({ success: false, message: 'Isi email tujuan atau set penerima di Email Schedule dulu' });
    const list = to.split(',').map(s => s.trim()).filter(Boolean);
    const bad = list.find(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) return res.status(400).json({ success: false, message: 'Alamat email tidak valid: ' + bad });
    const Svc = require('../services/DailyDigestService');
    const r = await Svc.sendDigest({ to });
    if (!r.ok) return res.status(502).json({ success: false, message: r.reason || 'Gagal mengirim — cek konfigurasi SMTP' });
    res.json({ success: true, message: 'Digest harian terkirim ke ' + to });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/email-log/cleanup?days=90 → hapus log lebih lama dari N hari
router.delete('/email-log/cleanup', authenticate, demoGuard, async (req, res) => {
  try {
    const { EmailLog } = require('../models');
    const { Op } = require('sequelize');
    const days = Math.max(1, parseInt(req.query.days) || 90);
    const cutoff = new Date(Date.now() - days * 86400000);
    const n = await EmailLog.destroy({ where: { sent_at: { [Op.lt]: cutoff } } });
    res.json({ success: true, deleted: n, message: `${n} log lebih lama dari ${days} hari dihapus` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Laporan Keuangan via Email ──────────────────────────────────────
// POST /api/finance/report/email — kirim laporan periode tertentu ke email
// body: { to, period:'month'|'year', month, year }
router.post('/finance/report/email', authenticate, demoGuard, async (req, res) => {
  try {
    const to = String((req.body && req.body.to) || '').trim();
    if (!to) return res.status(400).json({ success: false, message: 'Alamat email tujuan kosong' });
    // validasi tiap alamat
    const list = to.split(',').map(s => s.trim()).filter(Boolean);
    const bad = list.find(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) return res.status(400).json({ success: false, message: 'Alamat email tidak valid: ' + bad });

    // cek SMTP dulu untuk pesan spesifik
    const EmailService = require('../services/EmailService');
    const st = await EmailService.getStatus();
    if (!st.configured) return res.status(400).json({ success: false, message: st.reason || 'SMTP belum dikonfigurasi di Settings' });

    const Svc = require('../services/FinanceEmailReportService');
    const result = await Svc.sendReport({
      to,
      period: req.body.period === 'year' ? 'year' : 'month',
      month: req.body.month,
      year: req.body.year
    });
    if (!result.ok) return res.status(502).json({ success: false, message: result.reason || 'Gagal mengirim laporan' });
    res.json({ success: true, message: 'Laporan keuangan terkirim ke ' + (result.recipients || [to]).join(', ') });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/finance/report/schedule — baca pengaturan jadwal
router.get('/finance/report/schedule', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const { Op } = require('sequelize');
    const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'finrep_%' } } });
    const map = {}; rows.forEach(r => { map[r.key] = r.value; });
    res.json({ success: true, data: {
      enabled:   map.finrep_enabled === '1',
      frequency: map.finrep_frequency || 'monthly',  // daily | weekly | monthly
      hour:      parseInt(map.finrep_hour) || 7,
      recipients: map.finrep_recipients || '',
      lastSent:  map.finrep_last_sent || ''
    }});
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/finance/report/schedule — simpan pengaturan jadwal
router.post('/finance/report/schedule', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const b = req.body || {};
    const recips = String(b.recipients || '').split(',').map(s => s.trim()).filter(Boolean);
    const bad = recips.find(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (b.enabled && !recips.length) return res.status(400).json({ success: false, message: 'Isi minimal satu email penerima' });
    if (bad) return res.status(400).json({ success: false, message: 'Email tidak valid: ' + bad });
    const freq = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'monthly';
    const hour = Math.min(23, Math.max(0, parseInt(b.hour) || 7));
    const pairs = {
      finrep_enabled: b.enabled ? '1' : '0',
      finrep_frequency: freq,
      finrep_hour: String(hour),
      finrep_recipients: recips.join(', ')
    };
    for (const [key, value] of Object.entries(pairs)) await AppSetting.upsert({ key, value, type: 'string' });
    res.json({ success: true, message: 'Pengaturan jadwal laporan disimpan' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Email Schedule — pusat kendali semua jadwal email ──────────────
// GET /api/email-schedule → daftar semua jadwal + nilai saat ini
router.get('/email-schedule', authenticate, demoGuard, async (req, res) => {
  try {
    const Svc = require('../services/EmailScheduleService');
    const data = await Svc.listForUi();
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/email-schedule/:key → simpan satu jadwal
router.post('/email-schedule/:key', authenticate, demoGuard, async (req, res) => {
  try {
    const Svc = require('../services/EmailScheduleService');
    const result = await Svc.saveSchedule(req.params.key, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });
    res.json({ success: true, message: result.message });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});



// telegram, push reminder, template, dll) + reminder_settings + push_templates
// + wa_templates. Tidak termasuk data pelanggan/transaksi.
// Test kirim email SMTP. Body: { to } (opsional, default ke smtp_user).
router.post('/app-settings/test-email', authenticate, demoGuard, async (req, res) => {
  try {
    const EmailService = require('../services/EmailService');
    let to = (req.body && req.body.to) ? String(req.body.to).trim() : '';
    if (!to) {
      const { AppSetting } = require('../models');
      const row = await AppSetting.findOne({ where: { key: 'smtp_user' } });
      to = row && row.value ? row.value : '';
    }
    if (!to) return res.status(400).json({ success:false, message:'Alamat email tujuan tidak ada (isi SMTP user atau field tujuan).' });
    await EmailService.reload();
    await EmailService.sendTest(to);
    res.json({ success:true, message:'Email test terkirim ke ' + to });
  } catch (e) {
    res.status(500).json({ success:false, message: 'Gagal kirim test: ' + e.message });
  }
});

router.get('/app-settings/backup', authenticate, demoGuard, async (req, res) => {
  try {
    const models = require('../models');
    const { AppSetting } = models;

    const appRows = await AppSetting.findAll();
    const app_settings = {};
    appRows.forEach(r => { app_settings[r.key] = r.value; });

    const dumpTable = async (Model) => {
      if (!Model) return [];
      try {
        const rows = await Model.findAll({ raw: true });
        // Buang kolom timestamp agar restore tidak memaksakan waktu lama
        return rows.map(r => { const o = { ...r }; delete o.created_at; delete o.updated_at; delete o.createdAt; delete o.updatedAt; return o; });
      } catch (_) { return []; }
    };

    const payload = {
      _meta: {
        app: 'FLAYNET-CRM',
        type: 'settings-backup',
        version: 1,
        exported_at: new Date().toISOString(),
        exported_by: (req.user && (req.user.username || req.user.name)) || 'unknown'
      },
      app_settings,
      reminder_settings: await dumpTable(models.ReminderSetting),
      push_templates:    await dumpTable(models.PushTemplate),
      wa_templates:      await dumpTable(models.WaTemplate)
    };

    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="flaynet-settings-backup-${stamp}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Restore pengaturan aplikasi (import JSON) ───────────────
// Menerima file backup hasil endpoint di atas. Memulihkan app_settings via
// upsert (key-value), serta menimpa isi reminder_settings / push_templates /
// wa_templates (replace-all per tabel) bila disertakan. Data pelanggan &
// transaksi TIDAK tersentuh.
router.post('/app-settings/restore', authenticate, demoGuard, async (req, res) => {
  try {
    const models = require('../models');
    const { AppSetting, sequelize } = models;
    const body = req.body || {};

    // Dukung dua bentuk: payload langsung, atau { data: payload }
    const payload = body.app_settings ? body : (body.data || {});
    if (!payload || (!payload.app_settings && !payload.reminder_settings && !payload.push_templates && !payload.wa_templates)) {
      return res.status(400).json({ success: false, message: 'File backup tidak valid atau kosong.' });
    }

    const summary = { app_settings: 0, reminder_settings: 0, push_templates: 0, wa_templates: 0 };
    const warnings = [];

    // 1) app_settings — upsert key-value (aman, tidak menghapus key lain).
    //    Ini bagian terpenting, dijalankan dalam transaksi tersendiri.
    if (payload.app_settings && typeof payload.app_settings === 'object') {
      const t = await sequelize.transaction();
      try {
        for (const key of Object.keys(payload.app_settings)) {
          await AppSetting.upsert({ key, value: String(payload.app_settings[key] ?? ''), type: 'string' }, { transaction: t });
          summary.app_settings++;
        }
        await t.commit();
      } catch (err) { await t.rollback(); throw err; }
    }

    // 2) Tabel pendukung — upsert per-baris dengan mempertahankan id asli,
    //    supaya relasi foreign key yang ada tetap valid. Best-effort: baris
    //    yang gagal (mis. FK user pembuat tidak ada) dilewati & dicatat,
    //    tidak membatalkan restore app_settings yang sudah sukses.
    const restoreTable = async (Model, rows, name) => {
      if (!Model || !Array.isArray(rows)) return;
      for (const row of rows) {
        try { await Model.upsert({ ...row }); summary[name]++; }
        catch (e) { warnings.push(name + ': 1 baris dilewati (' + e.message + ')'); }
      }
    };
    if (payload.reminder_settings) await restoreTable(models.ReminderSetting, payload.reminder_settings, 'reminder_settings');
    if (payload.push_templates)    await restoreTable(models.PushTemplate,    payload.push_templates,    'push_templates');
    if (payload.wa_templates)      await restoreTable(models.WaTemplate,      payload.wa_templates,      'wa_templates');

    // Bersihkan berbagai cache agar perubahan langsung berlaku tanpa restart
    try { global._invalidateAppSettingsCache && global._invalidateAppSettingsCache(); } catch(_) {}
    try { require('../utils/taxHelper').invalidateCache(); } catch(_) {}
    try { require('../utils/companyInfo').clearCompanyNameCache(); } catch(_) {}
    try { require('../services/GatewayService').invalidateSessionCache(); } catch(_) {}
    try { await require('../services/CronService').rescheduleTelegramMonitoring(); } catch(_) {}

    res.json({ success: true, message: 'Pengaturan berhasil dipulihkan.', summary, warnings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Tax Settings (public read) ──────────────────────────────
// Endpoint kecil untuk frontend (admin & portal) yang butuh tahu rate PPN saat ini.
// Tidak butuh auth karena hanya membocorkan info publik (rate, label, enabled).
router.get('/app-settings/tax', async (req, res) => {
  try {
    const { loadTaxSettings } = require('../utils/taxHelper');
    const cfg = await loadTaxSettings();
    res.json({ success: true, data: {
      enabled: cfg.enabled,
      rate:    cfg.rate,
      mode:    cfg.mode,
      label:   cfg.label
    }});
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Payment Gateway: Test Configuration ──────────────────────
// Validate server_key dengan dummy API call — tanpa bikin invoice beneran
// Ambil default template pesan Telegram (untuk placeholder & tombol reset di UI)
router.get('/app-settings/telegram/templates-default', authenticate, demoGuard, (req, res) => {
  try {
    const { TPL_DEFAULTS } = require('../services/MonitoringService');
    res.json({ success: true, data: TPL_DEFAULTS });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Tes koneksi Telegram: simpan config dulu kalau dikirim, lalu getMe + kirim tes
router.post('/app-settings/telegram/test', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    // Kalau body membawa config (token/chat_id), simpan dulu supaya tes pakai nilai terbaru
    const keys = ['telegram_bot_token','telegram_chat_id','telegram_enabled',
                  'telegram_notif_device','telegram_notif_ont','telegram_notif_ip','telegram_notif_pppoe'];
    for (const k of keys) {
      if (req.body[k] !== undefined) {
        await AppSetting.upsert({ key: k, value: String(req.body[k] || ''), type: 'string' });
      }
    }
    const result = await require('../services/TelegramService').testConnection();
    res.json({ success: result.ok, message: result.message, bot: result.bot || null });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Trigger manual pengecekan monitoring (untuk verifikasi tanpa menunggu cron).
// Mereset baseline lalu menjalankan semua cek; notif terkirim bila ada transisi.
router.post('/app-settings/telegram/run-checks', authenticate, demoGuard, async (req, res) => {
  try {
    const out = await require('../services/MonitoringService').runChecksManual();
    res.json({ success: out.ok, ...out });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Telegram Center (halaman /telegram) ──────────────────────────────
// Pusat kelola Telegram terpisah dari Settings. Sumber data sama (app_settings).
const TelegramCenterController = require('../controllers/TelegramCenterController');
router.get ('/telegram/config',            authenticate, demoGuard, TelegramCenterController.config);
router.get ('/telegram/history',           authenticate, demoGuard, TelegramCenterController.history);
router.post('/telegram/save',              authenticate, demoGuard, TelegramCenterController.save);
router.post('/telegram/test',              authenticate, demoGuard, TelegramCenterController.test);
router.post('/telegram/test-notif',        authenticate, demoGuard, TelegramCenterController.testNotif);
router.post('/telegram/run-checks',        authenticate, demoGuard, TelegramCenterController.runChecks);
router.post('/telegram/send-custom',       authenticate, demoGuard, TelegramCenterController.sendCustom);
router.get ('/telegram/templates-default', authenticate, demoGuard, TelegramCenterController.templatesDefault);
router.get ('/telegram/bot-stats',         authenticate, demoGuard, TelegramCenterController.botStats);
router.get ('/telegram/detect-chats',      authenticate, demoGuard, TelegramCenterController.detectChats);
router.post('/telegram/summary-now',       authenticate, demoGuard, TelegramCenterController.summaryNow);

// ── Perintah Bot (tab "Perintah Bot" di Telegram Center) ──────────────
const BotCommandController = require('../controllers/BotCommandController');
router.get   ('/telegram/commands',     authenticate, demoGuard, BotCommandController.list);
router.post  ('/telegram/commands',     authenticate, demoGuard, BotCommandController.create);
router.put   ('/telegram/commands/:id', authenticate, demoGuard, BotCommandController.update);
router.delete('/telegram/commands/:id', authenticate, demoGuard, BotCommandController.remove);

// ── Telegram Report & Backup (halaman /telegram/report & /telegram/backup) ──
const TGRB = require('../controllers/TelegramReportBackupController');
router.get ('/telegram/report/config',   authenticate, demoGuard, TGRB.reportConfig);
router.get ('/telegram/report/history',  authenticate, demoGuard, TGRB.reportHistory);
router.post('/telegram/report/save',     authenticate, demoGuard, TGRB.reportSave);
router.post('/telegram/report/preview',  authenticate, demoGuard, TGRB.reportPreview);
router.post('/telegram/report/send-now', authenticate, demoGuard, TGRB.reportSendNow);
router.get ('/telegram/backup/config',   authenticate, demoGuard, TGRB.backupConfig);
router.post('/telegram/backup/save',     authenticate, demoGuard, TGRB.backupSave);
router.post('/telegram/backup/run-now',  authenticate, demoGuard, TGRB.backupRunNow);

router.post('/app-settings/payment-gateway/test', authenticate, demoGuard, async (req, res) => {
  try {
    const axios = require('axios');
    const crypto = require('crypto');
    const { AppSetting } = require('../models');
    const rows = await AppSetting.findAll({
      where: { key: ['payment_gateway_enabled','payment_gateway_provider','payment_gateway_env','payment_gateway_server_key','payment_gateway_client_key','payment_gateway_merchant_code','payment_gateway_private_key'] }
    });
    const cfg = {};
    rows.forEach(r => { cfg[r.key] = r.value; });

    const provider = cfg.payment_gateway_provider || 'midtrans';
    const env      = cfg.payment_gateway_env || 'sandbox';
    const srvKey   = cfg.payment_gateway_server_key || '';
    const cliKey   = cfg.payment_gateway_client_key || '';
    const merchantCode = cfg.payment_gateway_merchant_code || '';
    const isProd   = env === 'production';

    const result = { provider, env, checks: [] };
    const addCheck = (label, pass, detail) => result.checks.push({ label, pass, detail });

    // ── Check 1: Key format ──
    if (!srvKey) {
      addCheck('Server Key terisi', false, 'Field kosong. Isi di form di atas dan klik Simpan.');
      return res.json({ success: false, message: 'Server Key belum diisi', data: result });
    }
    addCheck('Server Key terisi', true, `${srvKey.length} karakter`);

    if (provider === 'midtrans') {
      // Midtrans menerima key dengan prefix "Mid-server-" atau "SB-Mid-server-".
      // Environment ditentukan oleh URL endpoint (bukan prefix), jadi validasi tidak terlalu ketat.
      const formatOk = /^(SB-)?Mid-server-/.test(srvKey);
      addCheck(`Format key Midtrans`, formatOk,
        formatOk
          ? `Key dimulai "${srvKey.slice(0, srvKey.indexOf('-server-') + 8)}..." — format valid`
          : `Key harus dimulai "Mid-server-" atau "SB-Mid-server-". Saat ini "${srvKey.slice(0,15)}..."`);
      if (!formatOk) return res.json({ success: false, message: 'Format Server Key tidak dikenali', data: result });

      if (cliKey) {
        const cliOk = /^(SB-)?Mid-client-/.test(cliKey);
        addCheck('Client Key format', cliOk, cliOk ? 'OK' : 'Harus dimulai "Mid-client-" atau "SB-Mid-client-"');
      } else {
        addCheck('Client Key terisi', false, 'Wajib untuk Snap.js di portal customer');
      }
    } else if (provider === 'xendit') {
      const expectPrefix = isProd ? 'xnd_production_' : 'xnd_development_';
      const formatOk = srvKey.startsWith(expectPrefix);
      addCheck(`Format key sesuai ${env}`, formatOk,
        formatOk ? 'OK' : `Harus dimulai "${expectPrefix}"`);
      if (!formatOk) return res.json({ success: false, message: 'Format Secret API Key tidak sesuai environment', data: result });
    } else if (provider === 'duitku') {
      // Duitku punya 2 credentials wajib: Merchant Code (DXXXXX) + API Key (hex 32 char umumnya)
      addCheck('Merchant Code terisi', !!merchantCode, merchantCode ? `${merchantCode}` : 'Field kosong');
      if (!merchantCode) {
        return res.json({ success: false, message: 'Merchant Code Duitku belum diisi', data: result });
      }
      const mcOk = /^[A-Z0-9]{3,15}$/i.test(merchantCode);
      addCheck('Format Merchant Code', mcOk, mcOk ? 'OK' : 'Harus alfanumerik 3-15 karakter (contoh: DXXXXX / DSXXXXX)');
      if (!mcOk) return res.json({ success: false, message: 'Format Merchant Code tidak valid', data: result });

      const keyOk = srvKey.length >= 16;
      addCheck('Panjang API Key', keyOk, keyOk ? `${srvKey.length} karakter` : 'API Key Duitku terlalu pendek (minimum 16 karakter)');
      if (!keyOk) return res.json({ success: false, message: 'API Key Duitku terlalu pendek', data: result });
    } else if (provider === 'tripay') {
      // Tripay butuh: API Key (srvKey), Merchant Code, Private Key
      const privateKey = cfg.payment_gateway_private_key || '';
      addCheck('Merchant Code terisi', !!merchantCode, merchantCode ? `${merchantCode}` : 'Field kosong');
      if (!merchantCode) {
        return res.json({ success: false, message: 'Merchant Code Tripay belum diisi', data: result });
      }
      const keyOk = srvKey.length >= 16;
      addCheck('Panjang API Key', keyOk, keyOk ? `${srvKey.length} karakter` : 'API Key Tripay terlalu pendek (minimum 16 karakter)');
      if (!keyOk) return res.json({ success: false, message: 'API Key Tripay terlalu pendek', data: result });
      const pkOk = privateKey.length >= 16;
      addCheck('Private Key terisi', pkOk, pkOk ? `${privateKey.length} karakter` : 'Private Key Tripay kosong / terlalu pendek (minimum 16 karakter)');
      if (!pkOk) return res.json({ success: false, message: 'Private Key Tripay belum diisi', data: result });

      // Verifikasi auth ke Tripay via endpoint instruksi pembayaran (butuh Bearer API Key).
      try {
        const tBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
        const r = await axios.get(`${tBase}/merchant/payment-channel`, {
          headers: { Authorization: `Bearer ${srvKey}` },
          timeout: 10000,
          validateStatus: s => s < 500
        });
        if (r.status === 401 || (r.data && r.data.success === false && /unauthor/i.test(r.data.message || ''))) {
          addCheck('Tripay auth', false, 'API Key ditolak (401). Cek ulang di dashboard Tripay.');
          return res.json({ success: false, message: 'API Key Tripay ditolak', data: result });
        }
        const okChannels = r.data && r.data.success;
        addCheck('Tripay auth', !!okChannels, okChannels
          ? `API Key valid (${(r.data.data || []).length} channel tersedia)`
          : `API merespons HTTP ${r.status}`);
        return res.json({ success: !!okChannels, message: okChannels ? 'Konfigurasi Tripay valid' : 'Tripay merespons tapi tidak sukses', data: result });
      } catch (apiErr) {
        addCheck('Tripay auth', false, 'Gagal menghubungi Tripay: ' + (apiErr.message || 'network error'));
        return res.json({ success: false, message: 'Gagal menghubungi Tripay', data: result });
      }
    }

    // ── Check 2: API call dummy (Midtrans ping, Xendit GET balance) ──
    const auth = Buffer.from(srvKey + ':').toString('base64');
    try {
      if (provider === 'midtrans') {
        // Midtrans tidak punya /ping, tapi kita coba request invalid transaction untuk trigger validation
        // kalau key salah → 401, kalau key benar → 400 "validation_messages" (itu artinya auth ok)
        const testUrl = isProd
          ? 'https://api.midtrans.com/v2/status/dummy-order-id'
          : 'https://api.sandbox.midtrans.com/v2/status/dummy-order-id';
        await axios.get(testUrl, {
          headers: { Authorization: `Basic ${auth}`, 'Accept': 'application/json' },
          timeout: 10000,
          validateStatus: s => s < 500
        }).then(r => {
          if (r.status === 401) {
            addCheck('Midtrans auth', false, 'Server Key ditolak (401). Cek ulang di dashboard Midtrans.');
            throw new Error('401');
          }
          if (r.status === 404 || (r.data && r.data.status_code === '404')) {
            // 404 "Transaction doesn't exist" = auth OK
            addCheck('Midtrans auth', true, 'Server Key valid (API merespons)');
          } else {
            addCheck('Midtrans auth', true, `API merespons: HTTP ${r.status}`);
          }
        });
      } else if (provider === 'xendit') {
        const r = await axios.get('https://api.xendit.co/balance', {
          headers: { Authorization: `Basic ${auth}` },
          timeout: 10000,
          validateStatus: s => s < 500
        });
        if (r.status === 401) {
          addCheck('Xendit auth', false, 'Secret API Key ditolak (401).');
          throw new Error('401');
        } else if (r.status === 200) {
          addCheck('Xendit auth', true, `Saldo ${r.data?.balance ? 'Rp ' + r.data.balance.toLocaleString('id-ID') : 'terbaca'}`);
        } else {
          addCheck('Xendit auth', false, `HTTP ${r.status}: ${r.data?.message || 'unknown'}`);
          throw new Error('Xendit '+r.status);
        }
      } else if (provider === 'duitku') {
        // Duitku tidak punya endpoint /ping. Kita pakai /transactionStatus dengan
        // merchantOrderId acak: kalau key benar → response statusCode='01' "Transaction not found"
        // (atau kadang HTTP 200 dgn statusMessage relevan); kalau signature salah → "Wrong signature".
        const dummyOrderId = 'TEST-CFG-' + Date.now();
        const sig = crypto.createHash('md5')
          .update(merchantCode + dummyOrderId + srvKey)
          .digest('hex');
        const tsUrl = isProd
          ? 'https://passport.duitku.com/webapi/api/merchant/transactionStatus'
          : 'https://sandbox.duitku.com/webapi/api/merchant/transactionStatus';
        const r = await axios.post(tsUrl, {
          merchantCode,
          merchantOrderId: dummyOrderId,
          signature: sig
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
          validateStatus: s => s < 500
        });
        // Response Duitku biasanya HTTP 200 dengan body JSON.
        // Kalau auth salah: { Message: "Wrong signature" } HTTP 400, atau
        // statusCode='01' / 'Wrong signature' / 'Merchant not found'.
        const data = r.data || {};
        const msg  = (data.Message || data.statusMessage || '').toString().toLowerCase();
        const authBad = msg.includes('wrong signature') || msg.includes('invalid signature') ||
                        msg.includes('merchant not found') || msg.includes('unauthorized') ||
                        r.status === 401 || r.status === 403;
        if (authBad) {
          addCheck('Duitku auth', false, `Auth ditolak: ${data.Message || data.statusMessage || 'HTTP ' + r.status}. Cek Merchant Code & API Key.`);
          throw new Error('Duitku auth');
        }
        // Selain itu = key valid (transaksi tidak ditemukan = expected).
        addCheck('Duitku auth', true, `API merespons: ${data.statusMessage || data.Message || 'HTTP ' + r.status} (auth OK)`);
      }
    } catch (e) {
      const allPass = result.checks.every(c => c.pass);
      return res.json({ success: allPass, message: allPass ? 'OK' : 'Gagal verifikasi: ' + e.message, data: result });
    }

    // ── Check 3: Webhook URL reachable (basic — info saja) ──
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${baseUrl}/portal/webhook/${provider}`;
    addCheck('Webhook URL', true, webhookUrl + ' (pastikan sudah diset di dashboard ' + provider + ')');

    const allPass = result.checks.every(c => c.pass);
    res.json({
      success: allPass,
      message: allPass ? 'Konfigurasi OK — siap terima pembayaran' : 'Ada item yang perlu diperbaiki',
      data: result
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Payment Accounts (metode pembayaran untuk portal customer) ──
router.get('/payment-accounts', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    let list = [];
    if (row && row.value) {
      try { list = JSON.parse(row.value); if (!Array.isArray(list)) list = []; }
      catch { list = []; }
    }
    res.json({ success: true, data: list });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/payment-accounts', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const accounts = Array.isArray(req.body.accounts) ? req.body.accounts : [];

    // Sanitasi & validasi minimal
    const clean = accounts
      .filter(a => a && typeof a === 'object' && ['bank','ewallet','qris'].includes(a.type))
      .map(a => ({
        type: String(a.type),
        provider: String(a.provider || '').toLowerCase().slice(0, 40),
        account_number: String(a.account_number || '').slice(0, 80),
        account_owner:  String(a.account_owner  || '').slice(0, 120),
        logo_url:       String(a.logo_url       || '').slice(0, 500),
        is_active: a.is_active !== false
      }));

    await AppSetting.upsert({
      key: 'payment_accounts',
      value: JSON.stringify(clean),
      type: 'json'
    });

    res.json({ success: true, message: 'Tersimpan', data: clean });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Message Logs ────────────────────────────────────────────
const MessageLogController = require('../controllers/MessageLogController');
router.get('/message-logs/stats',    authenticate, demoGuard, (req,res) => MessageLogController.stats(req,res));
router.get('/message-logs/outgoing', authenticate, demoGuard, (req,res) => MessageLogController.outgoing(req,res));
router.get('/message-logs/outgoing/:id', authenticate, demoGuard, (req,res) => MessageLogController.getOutgoingDetail(req,res));
router.get('/message-logs/incoming', authenticate, demoGuard, (req,res) => MessageLogController.incoming(req,res));
router.get('/message-logs/chart',    authenticate, demoGuard, (req,res) => MessageLogController.chart(req,res));
router.get('/message-logs/breakdown',authenticate, demoGuard, (req,res) => MessageLogController.typeBreakdown(req,res));

// ── Broadcast ───────────────────────────────────────────────
const BroadcastController = require('../controllers/BroadcastController');
router.get('/broadcast/stats',         authenticate, demoGuard, (req,res) => BroadcastController.stats(req,res));
router.get('/broadcast/list',          authenticate, demoGuard, (req,res) => BroadcastController.list(req,res));
router.post('/broadcast',              authenticate, demoGuard, logActivity('create','broadcast'), (req,res) => BroadcastController.create(req,res));
router.post('/broadcast/:id/send-now', authenticate, demoGuard, (req,res) => BroadcastController.sendNow(req,res));
router.post('/broadcast/:id/cancel',   authenticate, demoGuard, (req,res) => BroadcastController.cancel(req,res));
router.delete('/broadcast/:id',        authenticate, demoGuard, authorize('superadmin','admin'), (req,res) => BroadcastController.destroy(req,res));
router.get('/broadcast/count-targets', authenticate, demoGuard, (req,res) => BroadcastController.previewCount(req,res));
// Search customers untuk modal "Pilih Customer" di form broadcast.
// Support `q` (query nama/cid/phone) dan `ids` (re-fetch terpilih).
router.get('/broadcast/search-customers', authenticate, demoGuard, (req,res) => BroadcastController.searchCustomers(req,res));

// ── Email Broadcast ─────────────────────────────────────────
// Broadcast email branded ke pelanggan: gangguan, promo, maintenance,
// billing, info. Engine + targeting paralel dengan WA broadcast.
const EmailBroadcastController = require('../controllers/EmailBroadcastController');
router.get('/email-broadcast/stats',            authenticate, demoGuard, (req,res) => EmailBroadcastController.stats(req,res));
router.get('/email-broadcast/list',             authenticate, demoGuard, (req,res) => EmailBroadcastController.list(req,res));
router.get('/email-broadcast/count-targets',    authenticate, demoGuard, (req,res) => EmailBroadcastController.previewCount(req,res));
router.get('/email-broadcast/search-customers', authenticate, demoGuard, (req,res) => EmailBroadcastController.searchCustomers(req,res));
router.post('/email-broadcast/preview',         authenticate, demoGuard, (req,res) => EmailBroadcastController.preview(req,res));
router.post('/email-broadcast/send-test',       authenticate, demoGuard, (req,res) => EmailBroadcastController.sendTest(req,res));
router.post('/email-broadcast',                 authenticate, demoGuard, logActivity('create','email-broadcast'), (req,res) => EmailBroadcastController.create(req,res));
router.get('/email-broadcast/:id',              authenticate, demoGuard, (req,res) => EmailBroadcastController.detail(req,res));
router.post('/email-broadcast/:id/send-now',    authenticate, demoGuard, (req,res) => EmailBroadcastController.sendNow(req,res));
router.post('/email-broadcast/:id/cancel',      authenticate, demoGuard, (req,res) => EmailBroadcastController.cancel(req,res));
router.delete('/email-broadcast/:id',           authenticate, demoGuard, authorize('superadmin','admin'), (req,res) => EmailBroadcastController.destroy(req,res));

// ── MikroTik Config Backup → Email ──────────────────────────
// Backup /export (+ .backup biner via SFTP) semua router aktif,
// terjadwal sesuai setting, hasil dikirim otomatis ke email.
const MikrotikBackupController = require('../controllers/MikrotikBackupController');
router.get   ('/mikrotik-backup/info',           authenticate, demoGuard, (req,res) => MikrotikBackupController.info(req,res));
router.get   ('/mikrotik-backup/devices',        authenticate, demoGuard, (req,res) => MikrotikBackupController.devices(req,res));
router.get   ('/mikrotik-backup/files',          authenticate, demoGuard, (req,res) => MikrotikBackupController.files(req,res));
router.post  ('/mikrotik-backup/run',            authenticate, demoGuard, authorize('superadmin','admin'), logActivity('create','mikrotik-backup'), (req,res) => MikrotikBackupController.run(req,res));
router.get   ('/mikrotik-backup/download/:file', authenticate, demoGuard, authorize('superadmin','admin'), (req,res) => MikrotikBackupController.download(req,res));
router.delete('/mikrotik-backup/files/:file',    authenticate, demoGuard, authorize('superadmin'),          (req,res) => MikrotikBackupController.deleteFile(req,res));
router.get   ('/mikrotik-backup/settings',       authenticate, demoGuard, (req,res) => MikrotikBackupController.getSettings(req,res));
router.put   ('/mikrotik-backup/settings',       authenticate, demoGuard, authorize('superadmin','admin'), (req,res) => MikrotikBackupController.updateSettings(req,res));
router.post  ('/mikrotik-backup/test-email',     authenticate, demoGuard, (req,res) => MikrotikBackupController.testEmail(req,res));

// ── WA Features: Templates, Reminder, Report ────────────────
const { templates, reminder, report } = require('../controllers/WaFeaturesController');
router.get('/wa/templates',          authenticate, demoGuard, templates.list);
router.post('/wa/templates',         authenticate, demoGuard, templates.create);
router.put('/wa/templates/:id',      authenticate, demoGuard, templates.update);
router.patch('/wa/templates/:id/toggle', authenticate, demoGuard, templates.toggle);
router.delete('/wa/templates/:id',   authenticate, demoGuard, templates.destroy);
router.post('/wa/templates/preview', authenticate, demoGuard, templates.preview);

// ── Report template save/load ────────────────────────────────
router.get('/wa/report/template', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'report_template' } });
    res.json({ success: true, template: row?.value || '' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
router.post('/wa/report/template', authenticate, demoGuard, async (req, res) => {
  try {
    const { AppSetting } = require('../models');
    const { template } = req.body;
    await AppSetting.upsert({ key: 'report_template', value: template, type: 'text' });
    res.json({ success: true, message: 'Template disimpan' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/wa/reminders',          authenticate, demoGuard, reminder.list);
router.post('/wa/reminders/seed',    authenticate, demoGuard, reminder.seed);
router.post('/wa/reminders/save',    authenticate, demoGuard, reminder.save);
router.post('/wa/reminders/run-now', authenticate, demoGuard, reminder.runNow);
router.post('/wa/reminders/test-send', authenticate, demoGuard, reminder.testSend);
router.get('/wa/reminders/history',    authenticate, demoGuard, reminder.history);

router.get('/wa/report/settings',    authenticate, demoGuard, report.getSettings);
router.post('/wa/report/settings',   authenticate, demoGuard, report.saveSettings);
router.get('/wa/report/preview',     authenticate, demoGuard, report.preview);
router.post('/wa/report/send-now',   authenticate, demoGuard, report.sendNow);

// Payment page endpoints
const PaymentController = require('../controllers/PaymentController');
router.get('/payments/stats',      authenticate, demoGuard, PaymentController.stats);
router.get('/payments/chart',      authenticate, demoGuard, PaymentController.chartData);
router.get('/payments/list',       authenticate, demoGuard, PaymentController.list);
router.get('/payments/check-paid', authenticate, demoGuard, PaymentController.checkPaid);
router.post('/payments/record',    authenticate, demoGuard, logActivity('create','payment'), PaymentController.record);
router.delete('/payments/:id',     authenticate, demoGuard, authorize('superadmin','admin'), logActivity('delete','payment'), PaymentController.destroy);
router.get('/payments/customers',  authenticate, demoGuard, PaymentController.searchCustomers);
// Public invoice data — TANPA authenticate. Dipakai halaman /pub/invoice/:token
// (pelanggan buka dari link WA). Token HMAC diverifikasi di controller.
router.get('/pub/invoice/:token/data', (req, res) => PaymentController.publicInvoiceData(req, res));
router.get('/payments/:id/invoice-data',         authenticate, demoGuard, PaymentController.invoiceData);
router.get('/invoices/:id/invoice-data',          authenticate, demoGuard, PaymentController.invoiceDataByInvoiceId);
router.post('/payments/:id/send-wa-invoice', authenticate, demoGuard, PaymentController.sendWaInvoice);
// Endpoint baru: kirim invoice via WA berdasarkan Invoice ID (bukan Payment ID).
// Dipakai dari halaman /invoice/inv/:id (yang dibuka dari halaman /billing).
// Bekerja baik untuk invoice status UNPAID, OVERDUE, maupun PAID — template
// di-pilih backend berdasarkan invoice.status.
router.post('/invoices/:id/send-wa-invoice', authenticate, demoGuard, PaymentController.sendWaInvoiceByInvoice);

// ===== DEVICES =====
router.get('/devices', authenticate, demoGuard, DeviceController.index);
router.post('/devices', authenticate, demoGuard, hasPermission('device_create'), logActivity('create', 'device'), DeviceController.create);
router.get('/devices/stats', authenticate, demoGuard, DeviceController.stats);
router.get('/devices/monitoring', authenticate, demoGuard, DeviceController.monitoringOverview);
router.get('/devices/mikrotik-list', authenticate, demoGuard, DeviceController.mikrotikList);
router.post('/devices/test', authenticate, demoGuard, DeviceController.testConnectionByConfig);
router.get('/devices/:id', authenticate, demoGuard, DeviceController.show);
router.get('/devices/:id/traffic', authenticate, demoGuard, DeviceController.trafficData);
router.get('/devices/:id/interfaces', authenticate, demoGuard, DeviceController.interfaces);
router.get('/devices/:id/interface-stats', authenticate, demoGuard, DeviceController.interfaceStats);
router.get('/devices/:id/live-data', authenticate, demoGuard, DeviceController.liveData);
router.post('/devices/:id/test-connection', authenticate, demoGuard, DeviceController.testConnection);
router.post('/devices/:id/set-primary', authenticate, demoGuard, hasPermission('device_update'), DeviceController.setPrimary);
router.put('/devices/:id', authenticate, demoGuard, hasPermission('device_update'), logActivity('update', 'device'), DeviceController.update);
router.delete('/devices/:id', authenticate, demoGuard, hasPermission('device_delete'), logActivity('delete', 'device'), DeviceController.destroy);

// ===== INFRASTRUCTURE =====
router.get('/infrastructure', authenticate, demoGuard, (r,s) => InfrastructureController.index(r,s));
router.post('/infrastructure', authenticate, demoGuard, hasPermission('infra_create'), logActivity('create', 'infrastructure'), (r,s) => InfrastructureController.create(r,s));
router.get('/infrastructure/map', authenticate, demoGuard, (r,s) => InfrastructureController.mapData(r,s));
router.get('/infrastructure/stats', authenticate, demoGuard, (r,s) => InfrastructureController.stats(r,s));
router.get('/infrastructure/parent-options', authenticate, demoGuard, (r,s) => InfrastructureController.parentOptions(r,s));
router.get('/infrastructure/customer/:id/rx-power', authenticate, demoGuard, (r,s) => InfrastructureController.getCustomerRxPower(r,s));
router.get('/infrastructure/pop/:id/devices',       authenticate, demoGuard, (r,s) => InfrastructureController.getPopDevices(r,s));
router.get('/infrastructure/:id', authenticate, demoGuard, (r,s) => InfrastructureController.show(r,s));
router.put('/infrastructure/:id', authenticate, demoGuard, hasPermission('infra_update'), logActivity('update', 'infrastructure'), (r,s) => InfrastructureController.update(r,s));
router.delete('/infrastructure/:id', authenticate, demoGuard, hasPermission('infra_delete'), logActivity('delete', 'infrastructure'), (r,s) => InfrastructureController.destroy(r,s));

// ===== INFRASTRUCTURE LINKS =====
router.get   ('/infrastructure-links',     authenticate, demoGuard, (r,s)=>InfrastructureLinkController.index(r,s));
router.post  ('/infrastructure-links',     authenticate, demoGuard, (r,s)=>InfrastructureLinkController.create(r,s));
router.put   ('/infrastructure-links/:id', authenticate, demoGuard, (r,s)=>InfrastructureLinkController.update(r,s));
router.delete('/infrastructure-links/:id', authenticate, demoGuard, (r,s)=>InfrastructureLinkController.destroy(r,s));

// ===== CUSTOMER TRAFFIC (MikroTik Queue + PPPoE → Customer mapping) =====
// Polling MikroTik kini disentralisasi di services/CustomerTrafficPoller.js
// (1× poll → broadcast Socket.IO ke semua admin). Endpoint di bawah hanya
// melayani snapshot / permintaan khusus. Cache ping (_pingCache, PING_TTL_MS)
// ikut pindah ke poller agar self-contained.
router.get('/mikrotik/customer-traffic', authenticate, demoGuard, async (req, res) => {
  // ── Sumber data: SNAPSHOT dari poller terpusat ────────────────────────
  // Polling MikroTik dilakukan SEKALI di backend oleh CustomerTrafficPoller
  // dan disiarkan ke semua admin via Socket.IO (room 'traffic_monitoring').
  // Endpoint ini sekarang hanya untuk:
  //   1. INITIAL LOAD halaman (sebelum socket connect) → balikan snapshot.
  //   2. Permintaan KHUSUS dengan ?device_id / ?debug=1 / ?ping=0 → hitung
  //      langsung on-demand (tidak dilayani snapshot global).
  // Dengan begitu beban ke router tetap ×1 berapa pun jumlah admin online.
  try {
    const poller = require('../services/CustomerTrafficPoller');

    const explicitDeviceId = (() => {
      const v = req.query?.device_id || req.headers?.['x-device-id'];
      if (v == null || v === '') return null;
      const n = parseInt(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const wantsCustom = explicitDeviceId != null
      || req.query.debug === '1'
      || req.query.ping === '0';

    // Permintaan khusus → hitung on-demand (jarang dipakai, beban kecil).
    if (wantsCustom) {
      const snap = await poller.computeSnapshot({
        explicitDeviceId,
        pingEnabled: req.query.ping !== '0',
        debug: req.query.debug === '1',
      });
      return res.json(snap);
    }

    // Permintaan normal → layani snapshot global terakhir dari poller.
    const snap = poller.getSnapshot();
    if (snap) return res.json(snap);

    // Snapshot belum siap (mis. baru restart & belum ada subscriber) →
    // hitung sekali TANPA ping (maxPing:0) agar initial load instan. Status
    // PPPoE/queue tampil seketika; ping menyusul lewat poller di latar belakang.
    const fresh = await poller.computeSnapshot({ pingEnabled: true, maxPing: 0 });
    return res.json(fresh);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===== ONT / GenieACS =====
router.get('/ont', authenticate, demoGuard, OntController.index);
router.get('/ont/stats', authenticate, demoGuard, OntController.stats);
router.get('/ont/:id', authenticate, demoGuard, OntController.show);
router.post('/ont/sync', authenticate, demoGuard, authorize('superadmin', 'admin'), logActivity('sync', 'ont'), OntController.syncFromGenieACS);
router.post('/ont/:id/reboot', authenticate, demoGuard, hasPermission('ont_reboot'), logActivity('reboot', 'ont'), OntController.reboot);
router.get('/ont/:id/parameters', authenticate, demoGuard, OntController.getParameters);

// ===== NOTIFICATIONS =====
router.get('/notifications', authenticate, demoGuard, NotificationController.index);
router.get('/notifications/unread-count', authenticate, demoGuard, NotificationController.unreadCount);
router.put('/notifications/:id/read', authenticate, demoGuard, NotificationController.markRead);
router.put('/notifications/read-all', authenticate, demoGuard, NotificationController.markAllRead);

// ===== ACTIVITY LOGS =====
router.get('/activity-logs',     authenticate, demoGuard, authorize('superadmin', 'admin'), ActivityLogController.index);
router.get('/activity-logs/:id', authenticate, demoGuard, authorize('superadmin', 'admin'), ActivityLogController.detail);

// ===== MIKROTIK (NEW) =====
const mikrotikRoutes = require('./mikrotik');
router.use('/mikrotik', authenticate, demoGuard, mikrotikRoutes);

// ===== NMS (Interface Monitor) =====
const nmsRoutes = require('./nms');
router.use('/nms', authenticate, demoGuard, nmsRoutes);

// ===== FIELD COLLECTION (penagihan lapangan) =====
const collectionRoutes = require('./collection');
router.use('/collection', authenticate, demoGuard, collectionRoutes);

// ===== FIELD (sisi kolektor lapangan) =====
const fieldRoutes = require('./collectorField');
router.use('/field', authenticate, demoGuard, fieldRoutes);

// ===== WA GATEWAY =====
const waRoutes = require('./wa');
router.use('/wa', authenticate, demoGuard, waRoutes);


// ===== KEUANGAN =====
const KeuanganController = require('../controllers/KeuanganController');
router.get ('/keuangan/summary',    authenticate, demoGuard, (r,s)=>KeuanganController.summary(r,s));
router.get ('/keuangan/recurring',  authenticate, demoGuard, (r,s)=>KeuanganController.recurringList(r,s));
router.post('/keuangan/recurring',  authenticate, demoGuard, (r,s)=>KeuanganController.recurringStore(r,s));
router.post('/keuangan/recurring/generate', authenticate, demoGuard, (r,s)=>KeuanganController.recurringGenerate(r,s));
router.put ('/keuangan/recurring/:id', authenticate, demoGuard, (r,s)=>KeuanganController.recurringUpdate(r,s));
router.delete('/keuangan/recurring/:id', authenticate, demoGuard, (r,s)=>KeuanganController.recurringDestroy(r,s));
router.post('/keuangan/sync-payments', authenticate, demoGuard, (r,s)=>KeuanganController.syncPayments(r,s));
router.get ('/keuangan/categories', authenticate, demoGuard, (r,s)=>KeuanganController.categories(r,s));
router.get ('/keuangan/pnbp-settings', authenticate, demoGuard, (r,s)=>KeuanganController.pnbpSettings(r,s));
router.put ('/keuangan/pnbp-settings', authenticate, demoGuard, (r,s)=>KeuanganController.pnbpSettingsUpdate(r,s));
router.get ('/keuangan/:id',        authenticate, demoGuard, (r,s)=>KeuanganController.show ? KeuanganController.show(r,s) : s.json({success:false,message:'Not implemented'}));
router.get ('/keuangan',            authenticate, demoGuard, (r,s)=>KeuanganController.index(r,s));
router.post('/keuangan',            authenticate, demoGuard, (r,s)=>KeuanganController.store(r,s));
router.put ('/keuangan/:id/lunas',  authenticate, demoGuard, (r,s)=>KeuanganController.markLunas(r,s));
router.put ('/keuangan/:id',        authenticate, demoGuard, (r,s)=>KeuanganController.update(r,s));
router.delete('/keuangan/:id',      authenticate, demoGuard, (r,s)=>KeuanganController.destroy(r,s));

// ===== LAPORAN KEUANGAN =====
const LaporanController = require('../controllers/LaporanController');
router.get('/laporan/summary', authenticate, demoGuard, LaporanController.summary);

// ===== PING MONITOR =====
const PingMonitorController = require('../controllers/PingMonitorController');
router.get ('/ping-monitor/customers',          authenticate, demoGuard, PingMonitorController.getCustomers);
router.get ('/ping-monitor/all-customers',      authenticate, demoGuard, PingMonitorController.getAllCustomers);
router.post('/ping-monitor/ping-batch',         authenticate, demoGuard, PingMonitorController.pingBatch);
router.post('/ping-monitor/ping-single',        authenticate, demoGuard, PingMonitorController.pingSingle);
router.get ('/ping-monitor/summary',            authenticate, demoGuard, PingMonitorController.summary);
router.post('/ping-monitor/sync-from-mikrotik', authenticate, demoGuard, PingMonitorController.syncFromMikrotik);
router.post('/ping-monitor/set-ip',             authenticate, demoGuard, PingMonitorController.setCustomerIP);
// Endpoint baru untuk modal "Tambah Manual" + tombol delete
router.get ('/ping-monitor/search-customers',   authenticate, demoGuard, PingMonitorController.searchCustomers);
router.get ('/ping-monitor/router-sources',     authenticate, demoGuard, PingMonitorController.getRouterSources);
router.post('/ping-monitor/assign',             authenticate, demoGuard, PingMonitorController.assignManual);
router.post('/ping-monitor/delete-ping',        authenticate, demoGuard, PingMonitorController.deletePing);

// ===== DATABASE MANAGEMENT (Cleanup + Backup) =====
const DatabaseCleanupController = require('../controllers/DatabaseCleanupController');
router.get ('/db-cleanup/overview',     authenticate, demoGuard, DatabaseCleanupController.overview);
router.get ('/db-cleanup/retention',    authenticate, demoGuard, DatabaseCleanupController.getRetention);
router.put ('/db-cleanup/retention',    authenticate, demoGuard, authorize('superadmin','admin'), DatabaseCleanupController.updateRetention);
router.post('/db-cleanup/run/:table',   authenticate, demoGuard, authorize('superadmin','admin'), DatabaseCleanupController.runOne);
router.post('/db-cleanup/run-all',      authenticate, demoGuard, authorize('superadmin','admin'), DatabaseCleanupController.runAll);
router.get ('/db-cleanup/history',      authenticate, demoGuard, DatabaseCleanupController.history);
router.get ('/db-cleanup/diagnose/:table', authenticate, demoGuard, DatabaseCleanupController.diagnose);

const BackupController = require('../controllers/BackupController');
router.get   ('/backup/info',                authenticate, demoGuard, BackupController.info);
router.get   ('/backup/list',                authenticate, demoGuard, BackupController.list);
router.post  ('/backup/create',              authenticate, demoGuard, authorize('superadmin','admin'), BackupController.create);
router.get   ('/backup/download/:file',      authenticate, demoGuard, authorize('superadmin','admin'), BackupController.download);
router.delete('/backup/delete/:file',        authenticate, demoGuard, authorize('superadmin'),          BackupController.deleteFile);
// Restore: upload .sql/.sql.gz (atau body.file untuk backup existing). Superadmin only.
const backupRestoreStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../backups/restore-tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => { cb(null, `restore-${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`); }
});
const backupRestoreUpload = multer({
  storage: backupRestoreStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const n = (file.originalname || '').toLowerCase();
    if (n.endsWith('.sql') || n.endsWith('.sql.gz') || n.endsWith('.gz')) cb(null, true);
    else cb(new Error('Format harus .sql atau .sql.gz'));
  }
});
router.post  ('/backup/restore',             authenticate, demoGuard, authorize('superadmin'), backupRestoreUpload.single('file'), BackupController.restore);
router.get   ('/backup/settings',            authenticate, demoGuard, BackupController.getSettings);
router.put   ('/backup/settings',            authenticate, demoGuard, authorize('superadmin','admin'), BackupController.updateSettings);

// ===== OLT MANAGEMENT =====
const OltController = require('../controllers/OltController');
router.get('/olt',           authenticate, demoGuard, OltController.index.bind(OltController));
router.post('/olt',          authenticate, demoGuard, authorize('superadmin','admin'), OltController.create.bind(OltController));
router.put('/olt/:id',       authenticate, demoGuard, authorize('superadmin','admin'), OltController.update.bind(OltController));
router.delete('/olt/:id',    authenticate, demoGuard, authorize('superadmin'), OltController.destroy.bind(OltController));
router.post('/olt/sync-all', authenticate, demoGuard, authorize('superadmin','admin'), OltController.syncAll.bind(OltController));
router.post('/olt/:id/test', authenticate, demoGuard, authorize('superadmin','admin'), OltController.test.bind(OltController));
router.post('/olt/:id/sync', authenticate, demoGuard, authorize('superadmin','admin'), OltController.sync.bind(OltController));

// ===== OLT MANAGEMENT (LIVE CLI — ZTE C320/C300) =====
// Terhubung langsung ke CLI OLT untuk baca status ONU, redaman, dan aksi
// authorize/edit/reboot/hapus ONU. Terpisah dari OLT Monitoring (SNMP) di atas.
const OltMgmtController = require('../controllers/OltManagementController');
// CRUD OLT
router.get   ('/olt-mgmt',            authenticate, demoGuard, OltMgmtController.index.bind(OltMgmtController));
router.post  ('/olt-mgmt',            authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.create.bind(OltMgmtController));
router.put   ('/olt-mgmt/:id',        authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.update.bind(OltMgmtController));
router.delete('/olt-mgmt/:id',        authenticate, demoGuard, authorize('superadmin'),         OltMgmtController.destroy.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/test',   authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.test.bind(OltMgmtController));
// Read live
router.get   ('/olt-mgmt/:id/cards',  authenticate, demoGuard, OltMgmtController.cards.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/onus',   authenticate, demoGuard, OltMgmtController.onus.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/discover', authenticate, demoGuard, OltMgmtController.discover.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/uncfg',  authenticate, demoGuard, OltMgmtController.uncfg.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/onu/detail', authenticate, demoGuard, OltMgmtController.onuDetail.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/onu/power',  authenticate, demoGuard, OltMgmtController.onuPower.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/power-batch', authenticate, demoGuard, OltMgmtController.onuPowerBatch.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/onu/wan-info', authenticate, demoGuard, OltMgmtController.onuWanInfo.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/onu/traffic', authenticate, demoGuard, OltMgmtController.onuTraffic.bind(OltMgmtController));
// Actions (write) — superadmin/admin
router.post  ('/olt-mgmt/:id/onu/authorize', authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.authorizeOnu.bind(OltMgmtController));
router.put   ('/olt-mgmt/:id/onu/edit',      authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.editOnu.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/reboot',    authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.rebootOnu.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/factory-reset', authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.factoryResetOnu.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/eth-port',  authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.setOnuEthPort.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/verify',    authenticate, demoGuard, OltMgmtController.verifyOnu.bind(OltMgmtController));
router.delete('/olt-mgmt/:id/onu',           authenticate, demoGuard, authorize('superadmin'),         OltMgmtController.deleteOnu.bind(OltMgmtController));
// Dashboard: system info & ringkasan per-PON
router.get   ('/olt-mgmt/:id/system',        authenticate, demoGuard, OltMgmtController.systemInfo.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/port-summary',  authenticate, demoGuard, OltMgmtController.portSummary.bind(OltMgmtController));
// VLAN global
router.get   ('/olt-mgmt/:id/vlans',         authenticate, demoGuard, OltMgmtController.vlans.bind(OltMgmtController));
router.get   ('/olt-mgmt/:id/vlans/:vid',    authenticate, demoGuard, OltMgmtController.vlanDetail.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/vlans',         authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.createVlan.bind(OltMgmtController));
router.put   ('/olt-mgmt/:id/vlans/:vid',    authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.updateVlan.bind(OltMgmtController));
router.delete('/olt-mgmt/:id/vlans/:vid',    authenticate, demoGuard, authorize('superadmin'),         OltMgmtController.deleteVlan.bind(OltMgmtController));
// VLAN per-ONU (service-port)
router.get   ('/olt-mgmt/:id/onu/vlans',     authenticate, demoGuard, OltMgmtController.onuVlans.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/vlans',     authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.setOnuVlan.bind(OltMgmtController));
router.delete('/olt-mgmt/:id/onu/vlans',     authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.deleteOnuVlan.bind(OltMgmtController));
// Diagnostik: jalankan perintah show mentah (superadmin)
router.post  ('/olt-mgmt/:id/raw',           authenticate, demoGuard, authorize('superadmin'),         OltMgmtController.rawCommand.bind(OltMgmtController));
// Provisioning wizard
router.get   ('/olt-mgmt/:id/profiles',      authenticate, demoGuard, OltMgmtController.profiles.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/profiles',      authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.createProfile.bind(OltMgmtController));
router.delete('/olt-mgmt/:id/profiles',      authenticate, demoGuard, authorize('superadmin'),         OltMgmtController.deleteProfile.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/provision', authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.provisionOnu.bind(OltMgmtController));
router.post  ('/olt-mgmt/:id/onu/bulk-provision', authenticate, demoGuard, authorize('superadmin','admin'), OltMgmtController.bulkProvision.bind(OltMgmtController));

// ===== TICKETS =====
try {
  const ticketRoutes = require('./tickets');
  router.use('/tickets', authenticate, demoGuard, ticketRoutes);
  console.log('[api.js] ✓ Ticket routes loaded');
} catch(e) {
  console.error('[api.js] ✗ Ticket routes FAILED:', e.message);
  router.use('/tickets', (req, res) => res.status(503).json({ success: false, message: 'Ticket module not available: ' + e.message }));
}

// ===== DEVICE MONITOR =====
const deviceMonitorRoutes = require('./deviceMonitor');
router.use('/device-monitor', authenticate, demoGuard, deviceMonitorRoutes);

// ===== GENIEACS ONT MANAGEMENT =====
const genieacsRoutes = require('./genieacs');
router.use('/genieacs', authenticate, demoGuard, genieacsRoutes);

// ===== ASSET MANAGEMENT =====
const AssetController = require('../controllers/AssetController');
// Categories
router.get   ('/assets/categories',     authenticate, demoGuard, (r,s) => AssetController.getCategories(r,s));
router.post  ('/assets/categories',     authenticate, demoGuard, authorize('superadmin','admin'), (r,s) => AssetController.createCategory(r,s));
router.put   ('/assets/categories/:id', authenticate, demoGuard, authorize('superadmin','admin'), (r,s) => AssetController.updateCategory(r,s));
router.delete('/assets/categories/:id', authenticate, demoGuard, authorize('superadmin','admin'), (r,s) => AssetController.destroyCategory(r,s));
// Assets
router.get   ('/assets/stats',          authenticate, demoGuard, (r,s) => AssetController.stats(r,s));
router.get   ('/assets',                authenticate, demoGuard, (r,s) => AssetController.index(r,s));
router.post  ('/assets',                authenticate, demoGuard, logActivity('create','asset'), (r,s) => AssetController.create(r,s));
router.get   ('/assets/:id',            authenticate, demoGuard, (r,s) => AssetController.show(r,s));
router.put   ('/assets/:id',            authenticate, demoGuard, logActivity('update','asset'), (r,s) => AssetController.update(r,s));
router.delete('/assets/:id',            authenticate, demoGuard, authorize('superadmin','admin'), logActivity('delete','asset'), (r,s) => AssetController.destroy(r,s));
router.post  ('/assets/:id/photo',      authenticate, demoGuard, (r,s) => AssetController.uploadPhoto(r,s));
router.get   ('/assets/:id/history',    authenticate, demoGuard, (r,s) => AssetController.history(r,s));
router.post  ('/assets/:id/assign',     authenticate, demoGuard, logActivity('assign','asset'), (r,s) => AssetController.assign(r,s));
router.post  ('/assets/:id/unassign',   authenticate, demoGuard, logActivity('unassign','asset'), (r,s) => AssetController.unassign(r,s));

// ===== SYSTEM RESOURCES =====
router.get('/resources/router',  authenticate, demoGuard, ResourceController.getRouterResources);
router.get('/resources/server',  authenticate, demoGuard, ResourceController.getServerResources);
router.get('/resources/all',     authenticate, demoGuard, ResourceController.getAllResources);

// ===== TOPOLOGY =====
router.get('/topology/devices',              authenticate, demoGuard, TopologyController.getDevices);
router.post('/topology/devices',             authenticate, demoGuard, TopologyController.addDevice);
router.put('/topology/devices/:id',          authenticate, demoGuard, TopologyController.updateDevice);
router.put('/topology/devices/:id/position', authenticate, demoGuard, TopologyController.updatePosition);
router.delete('/topology/devices/:id',       authenticate, demoGuard, TopologyController.deleteDevice);
router.get('/topology/connections',          authenticate, demoGuard, TopologyController.getConnections);
router.post('/topology/connections',         authenticate, demoGuard, TopologyController.addConnection);
router.delete('/topology/connections/:id',   authenticate, demoGuard, TopologyController.deleteConnection);
router.post('/topology/devices/:id/refresh', authenticate, demoGuard, TopologyController.refreshDevice);
router.post('/topology/refresh-all',         authenticate, demoGuard, TopologyController.refreshAllDevices);


// ===== TODO =====
const TodoController = require('../controllers/TodoController');
router.get('/todos/stats',   authenticate, demoGuard, (r,s) => TodoController.stats(r,s));
router.get('/todos',         authenticate, demoGuard, (r,s) => TodoController.index(r,s));
router.post('/todos',        authenticate, demoGuard, (r,s) => TodoController.create(r,s));
router.get('/todos/:id',     authenticate, demoGuard, (r,s) => TodoController.show(r,s));
router.put('/todos/:id',     authenticate, demoGuard, (r,s) => TodoController.update(r,s));
router.patch('/todos/:id/status', authenticate, demoGuard, (r,s) => TodoController.updateStatus(r,s));
router.delete('/todos/:id',  authenticate, demoGuard, (r,s) => TodoController.destroy(r,s));


// ===== WORK ORDERS =====
const WOCtrl = require('../controllers/WorkOrderController');
router.get   ('/work-orders/stats',              authenticate, demoGuard, WOCtrl.stats);
router.get   ('/work-orders',                    authenticate, demoGuard, WOCtrl.index);
router.post  ('/work-orders',                    authenticate, demoGuard, WOCtrl.create);
router.get   ('/work-orders/:id',                authenticate, demoGuard, WOCtrl.show);
router.put   ('/work-orders/:id',                authenticate, demoGuard, WOCtrl.update);
router.post  ('/work-orders/:id/photos',         authenticate, demoGuard, WOCtrl.uploadMiddleware, WOCtrl.uploadPhotos);
router.delete('/work-orders/:id/photos/:photoIndex', authenticate, demoGuard, WOCtrl.deletePhoto);
router.delete('/work-orders/:id',                authenticate, demoGuard, WOCtrl.destroy);

// ===== ANNOUNCEMENTS (Pengumuman Portal) =====
const AnnCtrl = require('../controllers/AnnouncementController');
router.get   ('/announcements',              authenticate, demoGuard, AnnCtrl.list);
router.post  ('/announcements',              authenticate, demoGuard, AnnCtrl.create);
router.put   ('/announcements/:id',          authenticate, demoGuard, AnnCtrl.update);
router.patch ('/announcements/:id/toggle',   authenticate, demoGuard, AnnCtrl.toggle);
router.delete('/announcements/:id',          authenticate, demoGuard, AnnCtrl.destroy);

// ===== PUSH NOTIFICATION (Admin → Customer Portal) =====
const PushNotifCtrl = require('../controllers/PushNotificationController');
router.get   ('/push-notif/stats',            authenticate, demoGuard, PushNotifCtrl.stats);
router.post  ('/push-notif/preview-targets',  authenticate, demoGuard, PushNotifCtrl.previewTargets);
router.get   ('/push-notif/customers',        authenticate, demoGuard, PushNotifCtrl.customerList);
router.get   ('/push-notif/list',             authenticate, demoGuard, PushNotifCtrl.list);
router.post  ('/push-notif/send',             authenticate, demoGuard, authorize('superadmin','admin'), logActivity('create','push_notif'), PushNotifCtrl.send);
router.post  ('/push-notif/test',             authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.testSend);
router.post  ('/push-notif/test-cron/:type',  authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.testCron);
router.post  ('/push-notif/:id/retry',        authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.retry);
router.post  ('/push-notif/:id/cancel',       authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.cancel);
router.delete('/push-notif/:id',              authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.destroy);
// Templates
router.get   ('/push-notif/templates',        authenticate, demoGuard, PushNotifCtrl.listTemplates);
router.post  ('/push-notif/templates',        authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.createTemplate);
router.put   ('/push-notif/templates/:id',    authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.updateTemplate);
router.delete('/push-notif/templates/:id',    authenticate, demoGuard, authorize('superadmin','admin'), PushNotifCtrl.deleteTemplate);

// ===== GPS TRACKING =====
const trackingRoutes = require('./tracking');
router.use('/tracking', authenticate, demoGuard, trackingRoutes);

// ═══════════════════════════════════════════════════════════════════
// SALES MODULE — Sales Dashboard, Registrasi, Survey, Instalasi, Komisi
// Akses: sales (data sendiri) + admin/superadmin (semua). Finance/NOC tidak.
// ═══════════════════════════════════════════════════════════════════
const SalesCtrl = require('../controllers/SalesController');
const salesRoles      = authorize('sales', 'admin', 'superadmin');
const salesAdminRoles = authorize('admin', 'superadmin');

// Profil & link referral milik sales yang login
router.get ('/sales/me',                 authenticate, demoGuard, salesRoles, SalesCtrl.myProfile);
router.put ('/sales/me',                 authenticate, demoGuard, salesRoles, SalesCtrl.updateMyProfile);

// Dashboard stats
router.get ('/sales/stats',              authenticate, demoGuard, salesRoles, SalesCtrl.dashboardStats);
router.get ('/sales/referral-links',     authenticate, demoGuard, salesRoles, SalesCtrl.listReferralLinks);
router.get ('/sales/analytics',          authenticate, demoGuard, salesRoles, SalesCtrl.analytics);
router.get ('/sales/potential-areas',    authenticate, demoGuard, salesRoles, SalesCtrl.potentialAreas);
router.get ('/sales/kpi',                authenticate, demoGuard, salesRoles, SalesCtrl.kpi);

// Daftar paket (dropdown)
router.get ('/sales/packages',           authenticate, demoGuard, salesRoles, SalesCtrl.publicPackages);

// Manajemen tim sales (admin)
router.get ('/sales/team',               authenticate, demoGuard, salesAdminRoles, SalesCtrl.listSales);
router.post('/sales/team',               authenticate, demoGuard, salesAdminRoles, SalesCtrl.createSalesUser);
router.put ('/sales/team/:userId/profile',        authenticate, demoGuard, salesAdminRoles, SalesCtrl.updateSalesProfile);
router.post('/sales/team/:userId/regenerate-code',authenticate, demoGuard, salesAdminRoles, SalesCtrl.regenerateCode);

// Coverage checker
router.post('/sales/coverage-check',     authenticate, demoGuard, salesRoles, SalesCtrl.coverageCheck);
router.get ('/sales/coverage-points',    authenticate, demoGuard, salesRoles, SalesCtrl.coveragePoints);
router.get ('/sales/customer-points',    authenticate, demoGuard, salesRoles, SalesCtrl.customerPoints);

// Registrasi (pipeline)
router.get ('/sales/customers',          authenticate, demoGuard, salesRoles, SalesCtrl.listCustomers);
router.get ('/sales/registrations',      authenticate, demoGuard, salesRoles, SalesCtrl.listRegistrations);
router.post('/sales/registrations',      authenticate, demoGuard, salesRoles, SalesCtrl.createRegistration);
router.get ('/sales/registrations/:id',  authenticate, demoGuard, salesRoles, SalesCtrl.showRegistration);
router.put ('/sales/registrations/:id/assign', authenticate, demoGuard, salesAdminRoles, SalesCtrl.assignSales);
router.post('/sales/registrations/:id/photo', authenticate, demoGuard, salesRoles, SalesCtrl.uploadSingle, SalesCtrl.uploadRegistrationPhoto);

// Survey
router.post('/sales/registrations/:id/request-survey', authenticate, demoGuard, salesRoles, SalesCtrl.requestSurvey);
router.put ('/sales/registrations/:id/survey-result',  authenticate, demoGuard, salesRoles, SalesCtrl.submitSurvey);
router.post('/sales/registrations/:id/survey-photos',  authenticate, demoGuard, salesRoles, SalesCtrl.uploadMiddleware, SalesCtrl.uploadSurveyPhotos);
router.put ('/sales/registrations/:id/reject-survey',  authenticate, demoGuard, salesRoles, SalesCtrl.rejectSurvey);

// Instalasi / Work Order
router.post('/sales/registrations/:id/approve',     authenticate, demoGuard, salesRoles, SalesCtrl.approve);
router.post('/sales/registrations/:id/generate-wo', authenticate, demoGuard, salesRoles, SalesCtrl.generateWorkOrder);
router.post('/sales/registrations/:id/activate',    authenticate, demoGuard, salesAdminRoles, SalesCtrl.activate);

// Komisi
router.get ('/sales/commissions',           authenticate, demoGuard, salesRoles, SalesCtrl.listCommissions);
router.get ('/sales/commissions/history',   authenticate, demoGuard, salesRoles, SalesCtrl.commissionHistory);
router.get ('/sales/report',                authenticate, demoGuard, salesRoles, SalesCtrl.commissionReport);
router.post('/sales/commissions/pay-bulk',  authenticate, demoGuard, salesAdminRoles, SalesCtrl.payCommissionsBulk);
router.post('/sales/commissions/:id/pay',   authenticate, demoGuard, salesAdminRoles, SalesCtrl.uploadProof, SalesCtrl.payCommission);

module.exports = router;