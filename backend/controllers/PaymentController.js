const { Invoice, Payment, Customer, Package, User, sequelize } = require('../models');
const { Op } = require('sequelize');
const { generateInvoiceNumber } = require('../utils/helpers');
const moment = require('moment');
const logger = require('../utils/logger');

const METHODS = ['cash','transfer','dana','ovo','gopay','qris'];
const { LABELS: METHOD_LABEL, COLORS: METHOD_COLOR } = require('../utils/paymentMethodLabel');
const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

/**
 * Hitung tanggal jatuh tempo + 1 bulan (mempertahankan hari, clamp akhir bulan).
 * Dipakai untuk "Layanan aktif hingga" saat invoice sudah LUNAS.
 * @param {string|Date} dateInput  tanggal jatuh tempo periode invoice
 * @returns {string|null}  'YYYY-MM-DD' atau null jika input invalid
 */
function addOneMonthKeepDay(dateInput) {
  if (!dateInput) return null;
  const m = moment(dateInput);
  if (!m.isValid()) return null;
  return m.add(1, 'month').format('YYYY-MM-DD');
}

/**
 * Ambil daftar rekening pembayaran (payment_accounts) dari AppSetting dan
 * map ke bentuk yang dipahami invoice-renderer.js: { bank, no, name }.
 * Hanya rekening aktif & bertipe bank/ewallet yang ditampilkan. Return []
 * kalau tidak ada / setting belum diisi.
 */
async function loadBankAccountsForInvoice() {
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    if (!row || !row.value) return [];
    let list = JSON.parse(row.value);
    if (!Array.isArray(list)) return [];
    return list
      .filter(a => a && a.is_active !== false && ['bank', 'ewallet'].includes(a.type))
      .map(a => ({
        bank: String(a.provider || '').toUpperCase() || (a.type === 'ewallet' ? 'E-WALLET' : 'BANK'),
        no:   String(a.account_number || ''),
        name: String(a.account_owner  || '')
      }))
      .filter(a => a.no);
  } catch (e) {
    return [];
  }
}

class PaymentController {

  // ── Stats (4 fintech cards) ──────────────────────────────────
  async stats(req, res) {
    try {
      const month = parseInt(req.query.month) || moment().month() + 1;
      const year  = parseInt(req.query.year)  || moment().year();
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear  = month === 1 ? year - 1 : year;

      // Current period totals
      const [cur] = await sequelize.query(
        `SELECT COUNT(*) AS total_tx, COALESCE(SUM(p.amount),0) AS total_amount,
                SUM(p.payment_method='cash') AS cash_count,
                SUM(p.payment_method='transfer') AS transfer_count,
                SUM(p.payment_method IN ('dana','ovo','gopay','qris')) AS digital_count
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         WHERE i.period_year=:year AND i.period_month=:month`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );

      // Previous period
      const [prev] = await sequelize.query(
        `SELECT COUNT(*) AS total_tx, COALESCE(SUM(p.amount),0) AS total_amount
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         WHERE i.period_year=:year AND i.period_month=:month`,
        { replacements: { year: prevYear, month: prevMonth }, type: sequelize.QueryTypes.SELECT }
      );

      // Total Invoices (semua tagihan bulan ini)
      const [invoiceTotals] = await sequelize.query(
        `SELECT COUNT(*) AS total_invoices, COALESCE(SUM(total),0) AS total_invoice_amount
         FROM invoices
         WHERE period_year=:year AND period_month=:month`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );

      // Overdue/Unpaid Invoices (tagihan tertunggak)
      const [overdueData] = await sequelize.query(
        `SELECT COUNT(*) AS overdue_count, COALESCE(SUM(total),0) AS overdue_amount
         FROM invoices
         WHERE period_year=:year AND period_month=:month AND status IN ('unpaid','overdue')`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );

      // Method breakdown — kelompokkan per GATEWAY bila ada (Tripay/Midtrans/
      // Xendit/Duitku), selain itu per payment_method. Supaya "Channel Pembayaran"
      // di dashboard finance menampilkan nama gateway, bukan tergabung jadi "Lainnya".
      // Mendukung mode tahunan (period=year) → agregasi seluruh tahun.
      const msIsYear = req.query.period === 'year';
      const msWhere  = msIsYear ? 'i.period_year=:year' : 'i.period_year=:year AND i.period_month=:month';
      const methodStats = await sequelize.query(
        `SELECT COALESCE(NULLIF(p.gateway,''), p.payment_method) AS method,
                COUNT(*) AS cnt, COALESCE(SUM(p.amount),0) AS total
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         WHERE ${msWhere}
         GROUP BY method ORDER BY total DESC`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );

      const prevTx  = parseInt(prev?.total_tx || 0);
      const prevAmt = parseFloat(prev?.total_amount || 0);
      const curTx   = parseInt(cur?.total_tx || 0);
      const curAmt  = parseFloat(cur?.total_amount || 0);

      res.json({
        success: true,
        data: {
          month, year,
          total_tx: curTx,
          total_amount: curAmt,
          cash_count: parseInt(cur?.cash_count || 0),
          transfer_count: parseInt(cur?.transfer_count || 0),
          digital_count: parseInt(cur?.digital_count || 0),
          prev_tx: prevTx,
          prev_amount: prevAmt,
          growth_tx:  prevTx  > 0 ? Math.round((curTx  - prevTx)  / prevTx  * 100) : null,
          growth_amt: prevAmt > 0 ? Math.round((curAmt - prevAmt) / prevAmt * 100) : null,
          // Tambahan: Total Invoices & Overdue
          total_invoices: parseInt(invoiceTotals?.total_invoices || 0),
          total_invoice_amount: parseFloat(invoiceTotals?.total_invoice_amount || 0),
          overdue_count: parseInt(overdueData?.overdue_count || 0),
          overdue_amount: parseFloat(overdueData?.overdue_amount || 0),
          method_stats: methodStats.map(m => ({
            method: m.method,
            label: METHOD_LABEL[m.method] || m.method,
            color: METHOD_COLOR[m.method] || '#6b7280',
            count: parseInt(m.cnt),
            total: parseFloat(m.total)
          }))
        }
      });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Chart data (daily totals) ────────────────────────────────
  async chartData(req, res) {
    try {
      const month = parseInt(req.query.month) || moment().month() + 1;
      const year  = parseInt(req.query.year)  || moment().year();
      const daysInMonth = new Date(year, month, 0).getDate();

      const rows = await sequelize.query(
        `SELECT DAY(p.payment_date) AS d, COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS cnt
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         WHERE i.period_year=:year AND i.period_month=:month
         GROUP BY DAY(p.payment_date) ORDER BY d ASC`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );

      const map = {};
      rows.forEach(r => { map[parseInt(r.d)] = { total: parseFloat(r.total), cnt: parseInt(r.cnt) }; });
      const days = Array.from({ length: daysInMonth }, (_, i) => ({
        day: i + 1,
        total: map[i+1]?.total || 0,
        count: map[i+1]?.cnt   || 0
      }));

      res.json({ success: true, data: days });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── List payments ────────────────────────────────────────────
  async list(req, res) {
    try {
      const { page = 1, limit = 20, search, month, year } = req.query;
      const m = parseInt(month) || moment().month() + 1;
      const y = parseInt(year)  || moment().year();
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let custWhere = '';
      const params = { year: y, month: m };
      if (search) {
        custWhere = `AND (c.name LIKE :search OR c.customer_id LIKE :search OR c.phone LIKE :search)`;
        params.search = '%' + search + '%';
      }

      const [countRow] = await sequelize.query(
        `SELECT COUNT(*) AS n FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         JOIN customers c ON c.id = i.customer_id
         WHERE i.period_year=:year AND i.period_month=:month ${custWhere}`,
        { replacements: params, type: sequelize.QueryTypes.SELECT }
      );
      const total = parseInt(countRow?.n || 0);

      const rows = await sequelize.query(
        `SELECT p.id, p.amount, p.payment_method, p.payment_date, p.reference_number, p.notes, p.gateway, p.created_at,
                p.wa_sent_status, p.wa_sent_at,
                i.invoice_number, i.due_date, i.period_month, i.period_year, i.total AS invoice_total,
                c.name AS cust_name, c.customer_id AS cid, c.phone AS cust_phone,
                pkg.name AS pkg_name,
                u.name AS recorded_by_name
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         LEFT JOIN users u ON u.id = p.recorded_by
         WHERE i.period_year=:year AND i.period_month=:month ${custWhere}
         ORDER BY p.payment_date DESC, p.created_at DESC
         LIMIT :limit OFFSET :offset`,
        { replacements: { ...params, limit: parseInt(limit), offset }, type: sequelize.QueryTypes.SELECT }
      );

      const { displayMethodLabel } = require('../utils/paymentMethodLabel');
      const rowsOut = rows.map(r => ({
        ...r,
        // Label metode untuk kolom "Metode": kalau berasal dari gateway online,
        // tampilkan nama gateway (Tripay/Midtrans/Xendit/Duitku) dari notes;
        // selain itu label metode biasa. Data lama ikut benar tanpa migrasi.
        method_label: displayMethodLabel(r.payment_method, { gateway: r.gateway, notes: r.notes })
      }));

      res.json({ success: true, data: rowsOut, total, page: parseInt(page), limit: parseInt(limit) });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Record payment ───────────────────────────────────────────
  async record(req, res) {
    const t = await sequelize.transaction();
    try {
      const {
        customer_id, amount, payment_date, method, bank,
        reference_no, due_date_after, send_wa, send_email,
        notes, period_month, period_year
      } = req.body;

      if (!customer_id || !amount || !due_date_after) {
        await t.rollback();
        const missing = [];
        if (!customer_id)    missing.push('customer_id');
        if (!amount)         missing.push('amount');
        if (!due_date_after) missing.push('due_date_after (jatuh tempo baru)');
        return res.status(400).json({ success: false, message: 'Wajib diisi: ' + missing.join(', ') });
      }

      const customer = await Customer.findByPk(customer_id, {
        include: [{ model: Package, as: 'package' }],
        transaction: t
      });
      if (!customer) { await t.rollback(); return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' }); }

      const pm = parseInt(period_month) || moment().month() + 1;
      const py = parseInt(period_year)  || moment().year();

      // ── Cek duplikat: apakah periode ini sudah ada payment yang lunas? ──
      const existingPaidInvoice = await Invoice.findOne({
        where: { customer_id, period_month: pm, period_year: py, status: 'paid' },
        include: [{ model: Payment, as: 'payments', attributes: ['id','amount','payment_date'] }],
        transaction: t
      });
      if (existingPaidInvoice) {
        await t.rollback();
        const paidDate = existingPaidInvoice.paid_date
          ? new Date(existingPaidInvoice.paid_date).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })
          : '–';
        return res.status(400).json({
          success: false,
          message: `${customer.name} sudah membayar untuk periode ${MONTHS[pm]} ${py} (lunas ${paidDate}). Invoice: ${existingPaidInvoice.invoice_number}`,
          already_paid: true,
          invoice_number: existingPaidInvoice.invoice_number,
          paid_date: existingPaidInvoice.paid_date
        });
      }

      // Cari atau buat invoice untuk periode ini
      let invoice = await Invoice.findOne({
        where: { customer_id, period_month: pm, period_year: py },
        transaction: t
      });

      if (!invoice) {
        // Auto-create invoice — penomoran konsisten dengan BillingController
        // via helper terpusat getNextInvoiceNumber (MAX suffix per-periode).
        // Dulu jalur ini pakai sequence global berbasis id sehingga bisa bentrok
        // dengan generate batch (yang pakai per-periode) → "konflik nomor invoice".
        const { getNextInvoiceNumber } = require('../utils/helpers');
        const invAmount = parseFloat(customer.package?.price || amount);
        let invoiceNumber;
        let attempts = 0;
        while (attempts < 8) {
          try {
            const { invoiceNumber: candidate, prefix: candPrefix } = await getNextInvoiceNumber(sequelize, pm, py, { transaction: t });
            invoiceNumber = attempts === 0
              ? candidate
              : generateInvoiceNumber(py, pm, parseInt(candidate.split('-').pop(), 10) + attempts, candPrefix || 'INV');
            const exists = await Invoice.findOne({ where: { invoice_number: invoiceNumber }, transaction: t });
            if (!exists) break;
            attempts++;
          } catch(_) { attempts++; }
        }
        invoice = await Invoice.create({
          invoice_number: invoiceNumber,
          customer_id,
          amount: invAmount,
          tax: 0,
          total: invAmount,
          status: 'unpaid',
          due_date: due_date_after,
          period_month: pm,
          period_year: py
        }, { transaction: t });
      }

      const payMethod = METHODS.includes(method) ? method : 'cash';
      const refNote = [bank, reference_no].filter(Boolean).join(' — ') || null;

      // Simpan payment
      const payment = await Payment.create({
        invoice_id: invoice.id,
        amount: parseFloat(String(amount).replace(/[.,]/g, '') || 0) || parseFloat(amount),
        payment_method: payMethod,
        payment_date: payment_date || moment().format('YYYY-MM-DD'),
        reference_number: refNote,
        recorded_by: req.user?.id || null,
        notes: notes || null
      }, { transaction: t });

      // Update invoice: paid + due_date
      await invoice.update({ status: 'paid', paid_date: payment_date || moment().format('YYYY-MM-DD') }, { transaction: t });

      // ── Tentukan jatuh tempo BERIKUTNYA ──────────────────────────────
      // Kebijakan: jatuh tempo berikutnya = jatuh tempo customer terkini + 1 bulan.
      // Server menghitung sendiri (tidak mengandalkan kiriman frontend) supaya
      // konsisten & tahan dari kasus invoice periode lama. Jika admin SENGAJA
      // mengisi due_date_after yang berbeda dari default (override manual),
      // nilai itu dihormati.
      const baseDue = customer.due_date || invoice.due_date || payment_date || moment().format('YYYY-MM-DD');
      const computedNextDue = addOneMonthKeepDay(baseDue) || due_date_after;
      // Default yang "diharapkan" frontend = customer.due_date + 1 bulan.
      const expectedDefault = addOneMonthKeepDay(customer.due_date || baseDue);
      // Pakai computed (server) kecuali admin override ke tanggal lain.
      const effectiveDueAfter =
        (due_date_after && expectedDefault && due_date_after !== expectedDefault)
          ? due_date_after            // admin override manual
          : computedNextDue;          // default terhitung server

      // Update customer: due_date BARU + status aktif.
      // PENTING: simpan `due_date` (jatuh tempo berikutnya) ke customer supaya
      // pesan WA berikutnya (invoice/reminder) menampilkan tgl jatuh tempo yang
      // sudah diperbarui — bukan tanggal lama.
      const custUpdate = {
        status: 'active',
        due_date: effectiveDueAfter,
        installation_date: customer.installation_date || payment_date || moment().format('YYYY-MM-DD')
      };
      // Selaraskan billing_date (hari dalam bulan) dengan due_date baru, jika valid (1..28)
      const newDueDay = moment(effectiveDueAfter).date();
      if (newDueDay >= 1 && newDueDay <= 28) custUpdate.billing_date = newDueDay;
      await customer.update(custUpdate, { transaction: t });

      // Jika customer terisolir, set flag restoring
      // (implementasi MikroTik restore di-trigger setelah commit di bawah)

      await t.commit();

      // ── Auto-restore di MikroTik kalau customer sebelumnya ter-isolir ──
      // Dijalankan AFTER commit supaya:
      // (1) payment + invoice paid + customer.status='active' sudah persist di DB,
      // (2) kegagalan komunikasi MikroTik tidak membatalkan transaction payment.
      // Kalau gagal di sini, log error tapi jangan throw — cron berikutnya
      // (atau user manual via tombol Restore) bisa retry.
      if (customer.isolir_status === 'isolated' || customer.isolir_status === 'restoring') {
        const restoreCustId = customer.id;
        const restoreCustCode = customer.customer_id;
        const restoreCustName = customer.name;
        setImmediate(async () => {
          try {
            const IsolirSvc = require('../services/IsolirService');
            const restoreResult = await IsolirSvc.restoreAfterPayment(restoreCustId);
            if (restoreResult?.success && !restoreResult.skipped) {
              console.log(`[Payment] Auto-restore isolir success: customer ${restoreCustCode} (${restoreCustName})`);
            }
          } catch (e) {
            console.error(`[Payment] Auto-restore isolir gagal untuk customer ${restoreCustCode}:`, e.message);
          }
        });
      }

      // Kirim WA konfirmasi jika diminta — DIJALANKAN DI BACKGROUND (setImmediate)
      // supaya response "Catat Pembayaran" tidak menunggu koneksi/sendMessage WA
      // yang bisa makan beberapa detik. Status awal di-set di bawah, lalu
      // di-update oleh background task.
      if (send_wa && customer.phone) {
        // Status awal dibiarkan null (akan di-set background ke sent/failed).
        const waCtx = {
          paymentId: payment.id,
          phone: customer.phone,
          customerName: customer.name,
          customerId: customer.customer_id,
          customerPhone: customer.phone,
          packageName: customer.package?.name,
          amount: payment.amount,
          paymentDate: payment.payment_date,
          payMethod, bank,
          referenceNo: reference_no,
          dueDate: effectiveDueAfter,
          invoiceNumber: invoice.invoice_number,
          notes
        };
        setImmediate(async () => {
          let waSentStatus = 'failed';
          try {
            const GatewayService = require('../services/GatewayService');
            const { WaTemplate, Payment } = require('../models');
            const { replaceVariables, getPaymentConfirmationData, getDefaultPaymentTemplate } = require('../utils/templateHelper');
            const session = await GatewayService.getDefaultSendingSession();
            if (session) await GatewayService.warmSession(session.session_id);
            if (session && GatewayService.isConnected(session.session_id)) {
              let template = await WaTemplate.findOne({ where: { category: 'payment_confirm', is_active: true }, order: [['updated_at', 'DESC']] });
              let templateContent = template?.content || template?.message || getDefaultPaymentTemplate();
              const methodStr = require('../utils/paymentMethodLabel').methodLabel(waCtx.payMethod, waCtx.bank);
              const fmtAmt = 'Rp ' + parseFloat(waCtx.amount).toLocaleString('id-ID');
              const fmtDue = moment(waCtx.dueDate).format('DD/MM/YYYY');
              const fmtPay = moment(waCtx.paymentDate).format('DD/MM/YYYY');
              let companyName = '';
              try { companyName = await require('../utils/companyInfo').getCompanyName(); } catch (_) {}
              const templateData = getPaymentConfirmationData({
                customerName: waCtx.customerName, customerId: waCtx.customerId, customerPhone: waCtx.customerPhone,
                packageName: waCtx.packageName, amount: waCtx.amount, amountFormatted: fmtAmt,
                paymentDate: waCtx.paymentDate, paymentDateFormatted: fmtPay, method: waCtx.payMethod,
                methodLabel: methodStr, bank: waCtx.bank, referenceNo: waCtx.referenceNo,
                dueDate: waCtx.dueDate, dueDateFormatted: fmtDue, invoiceNumber: waCtx.invoiceNumber,
                notes: waCtx.notes, companyName
              });
              const msg = replaceVariables(templateContent, templateData);
              await GatewayService.sendMessage(session.session_id, waCtx.phone, msg, null);
              waSentStatus = 'sent';
              if (template) { try { await template.increment('usage_count'); } catch(_){} }
            }
          } catch(waErr) {
            waSentStatus = 'failed';
            logger.warn('[Payment] WA send (bg) failed: ' + waErr.message);
          }
          try {
            const { Payment } = require('../models');
            await Payment.update(
              { wa_sent_status: waSentStatus, wa_sent_at: waSentStatus === 'sent' ? new Date() : null },
              { where: { id: waCtx.paymentId } }
            );
          } catch(_){}
        });
      } else {
        await payment.update({ wa_sent_status: 'skipped' });
      }
      let waSentStatus = send_wa ? 'pending' : 'skipped';  // hanya untuk pesan respons

      // ═══════════════════════════════════════════════════════════
      // EMAIL KONFIRMASI PEMBAYARAN + KWITANSI PDF (background, non-blocking)
      // Dijalankan via setImmediate supaya TIDAK menahan response (catat
      // pembayaran terasa instan). Toggle: send_email (default true bila SMTP on).
      // ═══════════════════════════════════════════════════════════
      if (customer.email && send_email !== false && send_email !== 'false' && send_email !== 0 && send_email !== '0') {
        const emailCtx = {
          customer: { name: customer.name, customer_id: customer.customer_id, email: customer.email, address: customer.address, packageName: customer.package?.name },
          payAmount: parseFloat(payment.amount),
          payMethodLabel: require('../utils/paymentMethodLabel').methodLabel(payMethod, bank),
          payDateFmt: moment(payment.payment_date).format('DD/MM/YYYY'),
          dueFmt: moment(effectiveDueAfter).format('DD/MM/YYYY'),
          invoiceNumber: invoice.invoice_number,
          referenceNo: reference_no,
          notes,
          paymentId: payment.id,
          subtotal: parseFloat(invoice.amount || payment.amount),
          taxAmount: parseFloat(invoice.tax || 0),
          total: parseFloat(invoice.total || payment.amount),
          periodMonth: invoice.period_month,
          periodYear: invoice.period_year
        };
        setImmediate(async () => {
          try {
            const { AppSetting } = require('../models');
            const smtpRow = await AppSetting.findOne({ where: { key: 'smtp_enabled' } });
            if (smtpRow?.value !== '1') return;
            // Toggle lampiran kwitansi PDF (default ON kalau belum pernah di-set)
            const attachRow = await AppSetting.findOne({ where: { key: 'email_attach_receipt' } });
            const attachReceipt = !attachRow || attachRow.value === '' || attachRow.value === '1';

            const EmailService = require('../services/EmailService');
            const { buildReceiptPdf } = require('../utils/receiptPdf');

            // Ambil setting template invoice (invtpl_*) + brand + payment_accounts
            const tplRows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invtpl_%' } } });
            const tpl = {}; tplRows.forEach(r => { tpl[r.key.replace('invtpl_', '')] = r.value; });

            // Data perusahaan dari Settings > Umum (sumber utama untuk email & footer)
            const umumRows = await AppSetting.findAll({ where: { key: ['company_name','company_address','company_whatsapp','company_website'] } });
            const umum = {}; umumRows.forEach(r => { umum[r.key] = r.value; });

            // Nama perusahaan: Umum company_name → invtpl_company_name → brand → fallback
            let companyName2 = (umum.company_name || '').trim() || tpl.company_name || '';
            if (!companyName2) { try { companyName2 = await require('../utils/companyInfo').getCompanyName(); } catch (_) {} }
            if (!tpl.logo_url) { const gl = await AppSetting.findOne({ where: { key: 'logo_url' } }); if (gl?.value) tpl.logo_url = gl.value; }
            // Alamat/telp/website untuk footer & PDF — utamakan Umum, fallback invtpl
            const compAddress = (umum.company_address || tpl.company_address || '').trim();
            const compPhone   = (umum.company_whatsapp || tpl.company_phone || '').trim();
            const compWebsite = (umum.company_website || '').trim();

            // Info bank dari payment_accounts (type=bank)
            let bankAccounts = [];
            try {
              const paRow = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
              if (paRow?.value) {
                const arr = JSON.parse(paRow.value);
                if (Array.isArray(arr)) bankAccounts = arr.filter(m => m && m.type === 'bank');
              }
            } catch (_) {}

            // PPN persen (dari tax_rate bila ada)
            let vatPercent = null;
            try { const tr = await AppSetting.findOne({ where: { key: 'tax_rate' } }); if (tr?.value) vatPercent = parseFloat(tr.value); } catch (_) {}

            const taxLabelRow = await AppSetting.findOne({ where: { key: 'tax_label' } });
            const showTax = emailCtx.taxAmount > 0;

            let pdfBuf = null;
            if (attachReceipt) {
            try {
              // ── PDF kwitansi: 100% IDENTIK dengan invoice on-screen ──
              // Pakai HTML yang sama (invoiceHtml.js → invoice-renderer.js) +
              // render via wkhtmltopdf. Data diambil dari _buildInvoiceData
              // (sumber data yang sama dgn halaman /invoice).
              const { buildInvoicePdf } = require('../utils/buildInvoicePdf');

              // Lengkapi config template dgn data perusahaan + logo siap-PDF.
              const tplCfg = Object.assign({}, tpl, {
                company_name:    companyName2 || 'ISP Provider',
                company_tagline: tpl.company_tagline || 'Internet Service Provider',
                company_address: compAddress,
                company_phone:   compPhone,
                company_website: compWebsite,
                logo_url:        require('../utils/invoiceEmailLogo').resolveLogoForPdf(tpl.logo_url || '')
              });

              // Data invoice persis seperti yang dipakai halaman on-screen.
              let invData = null;
              try {
                invData = await PaymentController.prototype._buildInvoiceData.call(this, invoice.id);
              } catch (_) { invData = null; }

              if (invData) {
                // Pastikan status & tanggal bayar tercermin sebagai LUNAS.
                invData.invoice_status = 'paid';
                invData.method_label   = emailCtx.payMethodLabel;
                invData.reference_number = emailCtx.referenceNo || null;
                invData.payment_date   = invoice.paid_date || new Date();

                pdfBuf = await buildInvoicePdf(invData, tplCfg, {
                  // Fallback pdfkit lama bila wkhtmltopdf tak tersedia.
                  fallback: async () => buildReceiptPdf({
                    companyName: companyName2 || 'ISP Provider',
                    companyTagline: tpl.company_tagline || 'Internet Service Provider',
                    companyAddress: compAddress, companyPhone: compPhone, companyEmail: tpl.company_email || '',
                    logoPath: require('../utils/invoiceEmailLogo').localLogoPath(tpl.logo_url || ''),
                    primaryColor: tpl.primary_color || '#1e3a8a', accentColor: tpl.accent_color || '#1d4ed8',
                    textColor: tpl.text_color || '#0f172a', invoiceLabel: tpl.invoice_label || 'INVOICE',
                    recipientLabel: tpl.section_recipient_label || 'TAGIHAN UNTUK',
                    detailLabel: tpl.section_detail_label || 'Invoice information',
                    thankYouText: tpl.thank_you_text || '', footerText: tpl.footer_text || '',
                    customerName: emailCtx.customer.name, customerId: emailCtx.customer.customer_id, customerAddress: emailCtx.customer.address,
                    productName: emailCtx.customer.packageName || 'Layanan Internet', qty: 1, unitPrice: emailCtx.subtotal,
                    vatPercent: showTax ? vatPercent : null,
                    invoiceNumber: emailCtx.invoiceNumber, paymentDateFormatted: emailCtx.payDateFmt, dueDateFormatted: emailCtx.dueFmt,
                    methodLabel: emailCtx.payMethodLabel, referenceNo: emailCtx.referenceNo, notes: emailCtx.notes,
                    subtotal: emailCtx.subtotal, taxLabel: (taxLabelRow?.value || 'VAT'), taxAmount: emailCtx.taxAmount, total: emailCtx.total,
                    showTax, bankAccounts, statusPaid: true,
                    periodLabel: (emailCtx.periodMonth && emailCtx.periodYear)
                      ? `${['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][emailCtx.periodMonth] || emailCtx.periodMonth} ${emailCtx.periodYear}` : ''
                  })
                });
              }
            } catch (pe) { logger.warn('[Payment] gagal buat PDF kwitansi: ' + pe.message); }
            }

            const cName = companyName2 || 'ISP Provider';
            const fmtSub = 'Rp ' + Number(emailCtx.subtotal || 0).toLocaleString('id-ID');
            const fmtTax = 'Rp ' + Number(emailCtx.taxAmount || 0).toLocaleString('id-ID');
            const fmtTot = 'Rp ' + Number(emailCtx.total || emailCtx.payAmount || 0).toLocaleString('id-ID');
            const taxLbl = (taxLabelRow?.value || 'PPN') + (showTax && vatPercent != null ? ' (' + vatPercent + '%)' : '');

            // Baris ringkasan: subtotal + PPN hanya kalau ada pajak
            const taxRows = showTax ? `
                    <tr><td style="padding:7px 0;color:#64748b;border-top:1px solid #eef2f9;">Subtotal</td><td style="padding:7px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${fmtSub}</td></tr>
                    <tr><td style="padding:7px 0;color:#64748b;">${taxLbl}</td><td style="padding:7px 0;text-align:right;font-weight:700;color:#0f172a;">${fmtTax}</td></tr>` : '';

            // Footer informasi perusahaan (nama, alamat, telp, website)
            const footRows = [];
            if (compAddress) footRows.push(compAddress);
            if (compPhone)   footRows.push('Telp/WA: ' + compPhone);
            if (compWebsite) footRows.push(compWebsite);
            const companyFooter = `
              <div style="margin-top:16px;padding:16px 24px;background:#0f172a;border-radius:0 0 14px 14px;">
                <div style="color:#fff;font-size:13px;font-weight:800;">${cName}</div>
                ${footRows.map(t => `<div style="color:#94a3b8;font-size:11px;margin-top:3px;">${t}</div>`).join('')}
              </div>`;

            const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#f8faff;padding:24px;">
              <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8eef7;">
                <div style="background:#16a34a;padding:20px 24px;">
                  <div style="color:#fff;font-size:18px;font-weight:800;">${cName}</div>
                  <div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:2px;">Pembayaran Diterima — Terima Kasih</div>
                </div>
                <div style="padding:24px;">
                  <p style="margin:0 0 14px;color:#0f172a;font-size:14px;">Halo <b>${emailCtx.customer.name || 'Pelanggan'}</b>,</p>
                  <p style="margin:0 0 16px;color:#475569;font-size:13.5px;line-height:1.6;">Pembayaran Anda telah kami terima. Berikut rinciannya:</p>
                  <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
                    <tr><td style="padding:8px 0;color:#64748b;">No. Invoice</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;">${emailCtx.invoiceNumber || '-'}</td></tr>
                    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Metode</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${emailCtx.payMethodLabel}</td></tr>
                    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Tanggal Bayar</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${emailCtx.payDateFmt}</td></tr>
                    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Jatuh Tempo Berikutnya</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#1d4ed8;border-top:1px solid #eef2f9;">${emailCtx.dueFmt}</td></tr>
                    ${taxRows}
                  </table>
                  <div style="margin:18px 0 4px;padding:16px;background:#f0fdf4;border-radius:10px;text-align:center;">
                    <div style="font-size:12px;color:#15803d;">Total Tagihan${showTax ? ' (termasuk ' + (taxLabelRow?.value || 'PPN') + ')' : ''}</div>
                    <div style="font-size:26px;font-weight:800;color:#16a34a;margin-top:2px;">${fmtTot}</div>
                  </div>
                  ${pdfBuf ? '<p style="margin:14px 0 0;color:#475569;font-size:12.5px;line-height:1.6;">Kwitansi pembayaran terlampir dalam format PDF.</p>' : ''}
                </div>
                ${companyFooter}
              </div>
              <p style="margin:14px 0 0;color:#94a3b8;font-size:11px;text-align:center;">Email ini dikirim otomatis oleh sistem ${cName}. Mohon tidak membalas email ini.</p>
            </div>`;

            const attachments = pdfBuf ? [{ filename: `Kwitansi-${emailCtx.invoiceNumber || emailCtx.paymentId}.pdf`, content: pdfBuf, contentType: 'application/pdf' }] : [];

            // Subject & isi (heading/intro/outro) dari Email Template "invoice_paid"
            // bila diaktifkan, agar bisa dikustom di halaman Email Template.
            // Tabel rincian + footer perusahaan tetap dipakai sebagai blok khusus.
            // Fallback ke layout bawaan (html di atas) bila template nonaktif/gagal.
            let finalSubject = `Konfirmasi Pembayaran ${emailCtx.invoiceNumber || ''} — ${cName}`;
            let finalHtml = html;
            try {
              const EmailTpl = require('../services/EmailTemplateService');
              if (await EmailTpl.isEnabled('invoice_paid')) {
                const tplVars = {
                  nama: emailCtx.customer.name || 'Pelanggan',
                  invoice: emailCtx.invoiceNumber || '',
                  periode: (emailCtx.periodMonth && emailCtx.periodYear)
                    ? `${['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][emailCtx.periodMonth] || emailCtx.periodMonth} ${emailCtx.periodYear}` : '',
                  jumlah: fmtTot,
                  metode: emailCtx.payMethodLabel || '-',
                  tanggal_bayar: emailCtx.payDateFmt || '-',
                  jatuh_tempo: emailCtx.dueFmt || '-',
                  perusahaan: cName
                };
                const esc = EmailTpl.escapeHtml;
                const bodyExtra = `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;font-size:13px;">
                    <tr><td style="padding:9px 14px;color:#6b7fa8;">No. Invoice</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;">${esc(tplVars.invoice)}</td></tr>
                    <tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Metode</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${esc(tplVars.metode)}</td></tr>
                    <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Tanggal Bayar</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${esc(tplVars.tanggal_bayar)}</td></tr>
                    ${showTax ? `<tr style="background:#f8faff;"><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">Subtotal</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${esc(fmtSub)}</td></tr>
                    <tr><td style="padding:9px 14px;color:#6b7fa8;border-top:1px solid #eef3fb;">${esc(taxLbl)}</td><td align="right" style="padding:9px 14px;font-weight:700;color:#1f2937;border-top:1px solid #eef3fb;">${esc(fmtTax)}</td></tr>` : ''}
                  </table>
                  <div style="margin:14px 0 2px;padding:14px;background:#f0fdf4;border-radius:10px;text-align:center;">
                    <div style="font-size:12px;color:#15803d;">Total Dibayar${showTax ? ' (termasuk ' + esc(taxLabelRow?.value || 'PPN') + ')' : ''}</div>
                    <div style="font-size:24px;font-weight:800;color:#16a34a;margin-top:2px;">${esc(fmtTot)}</div>
                  </div>
                  ${pdfBuf ? '<p style="margin:12px 0 0;color:#475569;font-size:12.5px;line-height:1.6;">Kwitansi pembayaran terlampir dalam format PDF.</p>' : ''}`;
                const built = await EmailTpl.render('invoice_paid', tplVars, { companyName: cName, bodyExtraHtml: bodyExtra });
                finalSubject = built.subject;
                finalHtml = built.html;
              }
            } catch (tplErr) {
              logger.warn('[Payment] template invoice_paid gagal, fallback: ' + (tplErr.message || tplErr));
            }

            const ok = await EmailService.send({
              to: emailCtx.customer.email,
              subject: finalSubject,
              html: finalHtml,
              text: `Pembayaran ${fmtTot} untuk invoice ${emailCtx.invoiceNumber || ''} telah diterima. Terima kasih.`,
              attachments,
              type: 'invoice_paid'
            });
            if (ok) logger.info('[Payment] Email konfirmasi terkirim ke ' + emailCtx.customer.email);
          } catch (emailErr) {
            logger.warn('[Payment] background email konfirmasi error: ' + emailErr.message);
          }
        });
      }
      // ═══════════════════════════════════════════════════════════

      // ═══════════════════════════════════════════════════════════
      // AUTO-SYNC ke Keuangan (Real-time tanpa perlu klik Sync)
      // ═══════════════════════════════════════════════════════════
      try {
        const { Keuangan } = require('../models');
        
        // Cek apakah payment ini sudah pernah di-sync
        const existingEntry = await Keuangan.findOne({
          where: {
            type: 'pemasukan',
            ref_number: `PAY-${payment.id}`
          }
        });
        
        // Jika belum ada, create entry baru di Keuangan
        if (!existingEntry) {
          const methodStr = require('../utils/paymentMethodLabel').methodLabel(payMethod, bank);
          
          await Keuangan.create({
            type: 'pemasukan',
            category: 'Pembayaran Pelanggan',
            description: `Pembayaran ${customer.name} (${customer.customer_id})`,
            amount: parseFloat(payment.amount),
            date: payment.payment_date,
            ref_number: `PAY-${payment.id}`,
            notes: `Invoice: ${invoice.invoice_number || '-'} | Metode: ${methodStr}${reference_no ? ' | Ref: '+reference_no : ''}`,
            recorded_by: req.user?.id || null
          });
          
          logger.info(`[Payment] Auto-sync ke Keuangan: PAY-${payment.id} - ${customer.name}`);
        }
      } catch(syncErr) {
        // Jangan fail payment jika sync gagal, cukup log saja
        logger.warn('[Payment] Auto-sync ke Keuangan gagal:', syncErr.message);
      }
      // ═══════════════════════════════════════════════════════════

      const waSentMsg = waSentStatus === 'pending' ? ' Notifikasi sedang dikirim di latar belakang.' : '';

      // Notifikasi Telegram (event bisnis) — fire-and-forget, tidak memblok response.
      try {
        const methodLabel = require('../utils/paymentMethodLabel').methodLabel(payMethod, bank);
        let recordedByName = null;
        if (req.user?.id) {
          try {
            const u = await User.findByPk(req.user.id, { attributes: ['name'] });
            recordedByName = u?.name || null;
          } catch (_) {}
        }
        require('../services/TelegramEvents').paymentReceived({
          customerName: customer.name,
          customerCode: customer.customer_id,
          customerId: customer.id,
          amount: parseFloat(payment.amount),
          method: methodLabel,
          invoiceNo: invoice.invoice_number,
          packageName: customer.package?.name || null,
          periodeMonth: pm,
          periodeYear: py,
          dueDate: computedNextDue,
          recordedBy: recordedByName,
          paidAt: payment.payment_date || new Date(),
        }).catch(() => {});
      } catch (_) {}

      res.status(201).json({
        success: true,
        message: `Pembayaran ${customer.name} berhasil dicatat.` + waSentMsg,
        data: {
          payment_id: payment.id,
          invoice_number: invoice.invoice_number,
          customer_name: customer.name,
          amount: payment.amount,
          due_date_after: effectiveDueAfter,
          wa_sent_status: waSentStatus
        }
      });
    } catch(e) {
      try { await t.rollback(); } catch(_) {}
      // Log detail lengkap termasuk SQL error asli
      const detail = e.original?.message || e.errors?.[0]?.message || e.message;
      console.error('[PaymentController.record] ERROR:', detail);
      console.error('[PaymentController.record] SQL:', e.sql || '-');
      console.error('[PaymentController.record] STACK:', e.stack?.split('\n')[0]);
      res.status(500).json({ success: false, message: detail, sql_hint: e.original?.code || null });
    }
  }

  // ── Delete payment ───────────────────────────────────────────
  async destroy(req, res) {
    const t = await sequelize.transaction();
    let customerId = null;
    let collectorToRecompute = null;
    try {
      const payment = await Payment.findByPk(req.params.id, { transaction: t });
      if (!payment) { await t.rollback(); return res.status(404).json({ success: false, message: 'Payment tidak ditemukan' }); }

      // Ambil customer_id dari invoice (untuk re-evaluasi isolir setelah delete)
      const invoice = await Invoice.findByPk(payment.invoice_id, { transaction: t });
      customerId = invoice?.customer_id || null;
      // Simpan path bukti transfer agar filenya bisa dihapus dari server setelah commit.
      const proofPathToDelete = invoice?.proof_path || null;

      // ═══════════════════════════════════════════════════════════
      // AUTO-DELETE dari Keuangan (Real-time sync)
      // ═══════════════════════════════════════════════════════════
      try {
        const { Keuangan } = require('../models');
        
        // Hapus entry di keuangan yang terkait dengan payment ini
        await Keuangan.destroy({
          where: {
            type: 'pemasukan',
            ref_number: `PAY-${payment.id}`
          },
          transaction: t
        });
        
        logger.info(`[Payment] Auto-delete dari Keuangan: PAY-${payment.id}`);
      } catch(syncErr) {
        // Jangan fail payment delete jika sync gagal, cukup log saja
        logger.warn('[Payment] Auto-delete dari Keuangan gagal:', syncErr.message);
      }
      // ═══════════════════════════════════════════════════════════

      // ═══════════════════════════════════════════════════════════
      // SYNC MODUL COLLECTION (untuk pembayaran Cash Collect / field)
      // ═══════════════════════════════════════════════════════════
      // Bila payment ini berasal dari penagihan lapangan, kembalikan:
      //   - status tugas (assignment) -> assigned (muncul lagi utk ditagih),
      //   - cash_held kolektor dikurangi sebesar nominal yang dihapus,
      //   - bersihkan jejak penagihan pada tugas.
      try {
        if (payment.payment_method === 'field_collection' || payment.assignment_id) {
          const { CollectionAssignment } = require('../models');

          // Tandai kolektor utk recompute cash_held SETELAH commit (akurat dari
          // sumber kebenaran: total payment - total setoran terverifikasi).
          collectorToRecompute = payment.collected_by || null;

          // Reset assignment agar tugas muncul kembali untuk ditagih.
          if (payment.assignment_id && CollectionAssignment) {
            const asg = await CollectionAssignment.findByPk(payment.assignment_id, { transaction: t });
            if (asg) {
              // Bila pembayaran sebelumnya partial, kembalikan carry_over_amount customer.
              const prevCarry = parseFloat(asg.carry_over || 0);
              if (prevCarry > 0 && customerId) {
                try {
                  const cust = await Customer.findByPk(customerId, { transaction: t });
                  if (cust && cust.constructor.rawAttributes.carry_over_amount) {
                    const newCarry = Math.max(0, parseFloat(cust.carry_over_amount || 0) - prevCarry);
                    await cust.update({ carry_over_amount: newCarry }, { transaction: t });
                  }
                } catch (_) {}
              }
              const patch = {
                status: asg.collector_id ? 'assigned' : 'pending',
                amount_collected: null,
                carry_over: null,
                collected_at: null
              };
              if (asg.constructor.rawAttributes.payment_proof) patch.payment_proof = null;
              await asg.update(patch, { transaction: t });
            }
          }
          logger.info(`[Payment] Sync collection setelah delete PAY-${payment.id}`);
        }
      } catch (collErr) {
        logger.warn('[Payment] Sync collection gagal:', collErr.message);
      }
      // ═══════════════════════════════════════════════════════════

      // Revert invoice ke unpaid + bersihkan data bukti transfer (proof) agar
      // baris di tab "Bukti Transfer" ikut hilang dan tidak ada sisa data.
      await Invoice.update({
        status: 'unpaid',
        paid_date: null,
        verification_status: 'none',
        proof_path: null,
        proof_submitted_at: null,
        proof_note: null
      }, { where: { id: payment.invoice_id }, transaction: t });

      // ── Kembalikan jatuh tempo customer ke periode yang di-revert ────────
      // Saat pembayaran dibuat, customer.due_date dimajukan +1 bulan
      // (mis. 12 Juni → 12 Juli). Saat pembayaran dihapus, invoice ini kembali
      // 'unpaid', jadi due_date customer HARUS mundur lagi ke jatuh tempo
      // periode invoice tsb (12 Juni) agar tampilan halaman customer & form
      // input pembayaran berikutnya konsisten — tidak tertinggal di 12 Juli.
      //
      // Hanya dilakukan bila invoice yg dihapus ini adalah "periode terakhir"
      // milik customer (tidak ada invoice paid lain dengan due_date lebih baru),
      // supaya tidak salah memundurkan ketika ada pembayaran periode setelahnya.
      if (customerId && invoice && invoice.due_date) {
        try {
          const cust = await Customer.findByPk(customerId, { transaction: t });
          if (cust) {
            // Cek apakah ada invoice LAIN (paid) dengan due_date lebih baru
            // dari invoice yang dihapus — kalau ada, jangan mundurkan due_date
            // (ada periode setelahnya yang masih lunas).
            const newerPaid = await Invoice.findOne({
              where: {
                customer_id: customerId,
                status: 'paid',
                id: { [Op.ne]: invoice.id },
                due_date: { [Op.gt]: invoice.due_date }
              },
              transaction: t
            });
            // Hanya mundurkan bila due_date customer saat ini memang LEBIH MAJU
            // dari jatuh tempo invoice (artinya sempat dimajukan oleh pembayaran ini),
            // dan tidak ada periode lunas yang lebih baru.
            const shouldRevert = !newerPaid && (
              !cust.due_date || moment(cust.due_date).isAfter(moment(invoice.due_date), 'day')
            );
            if (shouldRevert) {
              const revertPatch = { due_date: moment(invoice.due_date).format('YYYY-MM-DD') };
              const dueDay = moment(invoice.due_date).date();
              if (dueDay >= 1 && dueDay <= 28) revertPatch.billing_date = dueDay;
              await cust.update(revertPatch, { transaction: t });
              logger.info(`[Payment] due_date customer ${customerId} dikembalikan ke ${revertPatch.due_date} setelah hapus PAY-${payment.id}`);
            }
          }
        } catch (revErr) {
          logger.warn('[Payment] Gagal mengembalikan due_date customer:', revErr.message);
        }
      }

      await payment.destroy({ transaction: t });
      await t.commit();

      // ── Recompute cash_held kolektor SETELAH commit (akurat) ──
      // Dihitung ulang dari sumber kebenaran: SUM(payment kolektor) -
      // SUM(setoran verified). Menggantikan pengurangan manual agar tidak
      // drift, termasuk saat sebagian uang sudah disetor & terverifikasi.
      if (collectorToRecompute) {
        try {
          const CollectionService = require('../services/CollectionService');
          const newHeld = await CollectionService.recomputeCashHeld(collectorToRecompute);
          logger.info(`[Payment] Recompute cash_held kolektor ${collectorToRecompute} = ${newHeld}`);
        } catch (e) {
          logger.warn('[Payment] Recompute cash_held gagal:', e.message);
        }
      }

      // ── Hapus file bukti fisik dari server SETELAH commit ──
      // Non-fatal: kalau gagal hapus file, delete payment tetap dianggap sukses.
      if (proofPathToDelete) {
        try {
          const fs = require('fs'); const path = require('path');
          const safeRel = String(proofPathToDelete).replace(/^\/+/, '');
          if (safeRel.startsWith('uploads/payment_proofs/') && !safeRel.includes('..')) {
            const abs = path.join(__dirname, '..', '..', safeRel);
            if (fs.existsSync(abs)) {
              fs.unlinkSync(abs);
              logger.info(`[Payment] File bukti transfer dihapus: ${safeRel}`);
            }
          }
        } catch (fileErr) {
          logger.warn('[Payment] Gagal hapus file bukti transfer:', fileErr.message);
        }
      }

      // ── Re-evaluate isolir status SETELAH commit ──
      // Kalau customer ini sekarang punya invoice unpaid yang sudah lewat grace days,
      // dan belum ter-isolir, lakukan auto-isolir (karena pembayaran yang sebelumnya
      // membuat dia "active" sudah tidak valid).
      // Dijalankan after commit supaya kegagalan komunikasi MikroTik tidak membatalkan
      // delete payment. Kalau gagal di sini, cron berikutnya akan retry.
      let isolirNote = '';
      if (customerId) {
        try {
          const IsolirSvc = require('../services/IsolirService');
          const result = await IsolirSvc.evaluateCustomer(customerId, 'payment_revert');
          if (result?.success && !result.skipped) {
            logger.info(`[Payment] Auto-isolir setelah delete payment: customer ${customerId} — ${result.message}`);
            isolirNote = ' Customer otomatis di-isolir karena tagihan kembali overdue.';
          }
        } catch (e) {
          logger.error(`[Payment] Auto-isolir gagal untuk customer ${customerId}:`, e.message);
          // Tidak fatal — delete payment tetap berhasil
        }
      }

      res.json({
        success: true,
        message: 'Pembayaran berhasil dihapus dan tersinkronisasi dengan keuangan.' + isolirNote
      });
    } catch(e) {
      await t.rollback();
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Check if already paid for period ────────────────────────
  async checkPaid(req, res) {
    try {
      const { customer_id, month, year } = req.query;
      if (!customer_id || !month || !year) return res.json({ paid: false });
      const invoice = await Invoice.findOne({
        where: {
          customer_id: parseInt(customer_id),
          period_month: parseInt(month),
          period_year: parseInt(year),
          status: 'paid'
        },
        attributes: ['id','invoice_number','paid_date','due_date']
      });
      if (invoice) {
        return res.json({ paid: true, invoice_number: invoice.invoice_number, paid_date: invoice.paid_date });
      }
      res.json({ paid: false });
    } catch(e) { res.json({ paid: false }); }
  }

  // ── Builder data invoice (dipakai admin & public) ───────────
  // Mengembalikan objek data siap-render (sama format dgn yang dipakai
  // invoice-renderer.js) atau null kalau invoice tidak ditemukan.
  async _buildInvoiceData(invoiceId) {
    const [rowWithPay] = await sequelize.query(
      `SELECT p.id AS payment_id, p.amount AS payment_amount, p.payment_method, p.payment_date, p.reference_number, p.notes, p.gateway,
              i.id AS invoice_id, i.invoice_number, i.due_date, i.period_month, i.period_year,
              i.amount AS invoice_amount, i.tax AS invoice_tax, i.total AS invoice_total,
              i.status AS invoice_status,
              i.verification_status AS verification_status,
              i.proof_submitted_at AS proof_submitted_at,
              c.name AS cust_name, c.customer_id AS cid, c.phone AS cust_phone,
              c.address AS cust_address, c.email AS cust_email, c.installation_date,
              pkg.name AS pkg_name, pkg.price AS pkg_price
       FROM invoices i
       LEFT JOIN payments p ON p.invoice_id = i.id
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN packages pkg ON pkg.id = c.package_id
       WHERE i.id = :id ORDER BY p.id DESC LIMIT 1`,
      { replacements: { id: invoiceId }, type: sequelize.QueryTypes.SELECT }
    );
    if (!rowWithPay) return null;

    const company = {
      name:    process.env.COMPANY_NAME    || process.env.APP_NAME || 'ISP Provider',
      address: process.env.COMPANY_ADDRESS || '',
      phone:   process.env.COMPANY_PHONE   || '',
      email:   process.env.COMPANY_EMAIL   || '',
      website: process.env.COMPANY_WEBSITE || '',
      footer:  process.env.INVOICE_FOOTER  || 'Terima kasih telah menggunakan layanan kami.'
    };
    const methodLabel = require('../utils/paymentMethodLabel')
      .displayMethodLabel(rowWithPay.payment_method, { gateway: rowWithPay.gateway, notes: rowWithPay.notes });

    const amount = rowWithPay.payment_amount || rowWithPay.invoice_total || 0;
    const recorded_by_name = 'System';

    const { loadTaxSettings } = require('../utils/taxHelper');
    const taxCfg = await loadTaxSettings();
    let invSubtotal = parseFloat(rowWithPay.invoice_amount || rowWithPay.pkg_price || 0);
    let invTax      = parseFloat(rowWithPay.invoice_tax || 0);
    let invTotal    = parseFloat(rowWithPay.invoice_total || (invSubtotal + invTax));

    if (invTax === 0 && invTotal > invSubtotal && invSubtotal > 0) {
      invTax = invTotal - invSubtotal;
    }
    if (!taxCfg.enabled) {
      invTax   = 0;
      invTotal = invSubtotal > 0 ? invSubtotal : invTotal;
    }
    const computedRate = invSubtotal > 0 && invTax > 0
      ? Math.round((invTax / invSubtotal) * 1000) / 10
      : taxCfg.rate;

    // Rekening pembayaran (Bug 3)
    const bank_accounts = await loadBankAccountsForInvoice();

    // "Layanan aktif hingga" (Bug 2): belum lunas → due_date periode;
    // sudah lunas → +1 bulan.
    const isPaid = rowWithPay.invoice_status === 'paid';
    const active_until = isPaid
      ? (addOneMonthKeepDay(rowWithPay.due_date) || rowWithPay.due_date)
      : rowWithPay.due_date;

    return {
      ...rowWithPay,
      amount,
      invoice_subtotal: invSubtotal,
      invoice_tax:      invTax,
      invoice_total:    invTotal,
      tax_label:        taxCfg.label,
      tax_rate:         computedRate,
      tax_applied:      invTax > 0,
      method_label:  methodLabel,
      recorded_by_name,
      bank_accounts,
      active_until,
      company
    };
  }

  // ── Get invoice data for rendering ──────────────────────────
  async invoiceDataByInvoiceId(req, res) {
    try {
      const data = await PaymentController.prototype._buildInvoiceData.call(this, req.params.id);
      if (!data) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });
      res.json({ success: true, data });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Public invoice data (NO AUTH, via HMAC token) ───────────
  // Dipakai oleh halaman /pub/invoice/:token yang dibuka pelanggan dari link WA.
  // Token diverifikasi dulu; kalau invalid → 404 (tidak bocorkan info).
  async publicInvoiceData(req, res) {
    try {
      const { verifyInvoiceToken } = require('../utils/templateHelper');
      const invoiceId = verifyInvoiceToken(req.params.token);
      if (!invoiceId) {
        return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan atau link tidak valid' });
      }
      const data = await PaymentController.prototype._buildInvoiceData.call(this, invoiceId);
      if (!data) return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan' });

      // Riwayat pembayaran (list pembayaran) untuk ditampilkan di halaman publik.
      // Bisa lebih dari satu kalau ada cicilan / pembayaran parsial.
      const { displayMethodLabel } = require('../utils/paymentMethodLabel');
      const payRows = await sequelize.query(
        `SELECT id, amount, payment_method, payment_date, reference_number, notes, gateway, created_at
           FROM payments WHERE invoice_id = :id ORDER BY payment_date DESC, id DESC`,
        { replacements: { id: invoiceId }, type: sequelize.QueryTypes.SELECT }
      );
      data.payments = payRows.map(p => ({
        id: p.id,
        amount: parseFloat(p.amount || 0),
        method: p.payment_method,
        // Kalau pembayaran via gateway online, tampilkan nama gateway (Tripay/dll).
        method_label: displayMethodLabel(p.payment_method, { gateway: p.gateway, notes: p.notes }),
        payment_date: p.payment_date,
        reference_number: p.reference_number || '',
        notes: p.notes || ''
      }));

      // ── Cek "sudah dibayar" yang robust ──────────────────────────
      // Tombol Bayar TIDAK boleh muncul kalau invoice ini sudah lunas.
      // Dua kondisi dianggap lunas:
      //   1. invoice.status === 'paid' (kanal normal: webhook/admin set paid)
      //   2. total pembayaran tercatat >= total tagihan (jaga-jaga kalau status
      //      belum ke-update tapi pembayaran sudah masuk penuh).
      const invTotalNum = parseFloat(data.invoice_total || 0);
      const totalPaid   = data.payments.reduce((s, p) => s + (p.amount || 0), 0);
      const isPaidStatus = data.invoice_status === 'paid';
      const isFullyPaid  = invTotalNum > 0 && totalPaid >= invTotalNum;
      const isPayable    = ['unpaid', 'overdue'].includes(data.invoice_status) && !isFullyPaid;

      data.payable      = isPayable;
      data.is_paid      = isPaidStatus || isFullyPaid;
      data.total_paid   = totalPaid;

      // ── Riwayat tagihan 1 tahun terakhir (periode terdahulu) ─────
      // Ambil customer_id (FK) dari invoice yang dibuka, lalu list invoice
      // milik customer tsb untuk 12 bulan terakhir. Ditandai status & nominal.
      try {
        const [invRow] = await sequelize.query(
          `SELECT customer_id FROM invoices WHERE id = :id LIMIT 1`,
          { replacements: { id: invoiceId }, type: sequelize.QueryTypes.SELECT }
        );
        if (invRow && invRow.customer_id) {
          // Batas 12 bulan ke belakang dari hari ini (berdasarkan period_year/month).
          const now = new Date();
          const curY = now.getFullYear();
          const curM = now.getMonth() + 1;
          // Cutoff = 11 bulan sebelum bulan ini (jadi total 12 periode termasuk bulan ini).
          let cutY = curY, cutM = curM - 11;
          while (cutM <= 0) { cutM += 12; cutY -= 1; }
          // Komparasi (year*100+month) >= cutoff
          const cutoff = cutY * 100 + cutM;

          const histRows = await sequelize.query(
            `SELECT i.id, i.invoice_number, i.period_month, i.period_year,
                    i.total, i.status, i.due_date, i.paid_date,
                    COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS paid_amount
               FROM invoices i
               WHERE i.customer_id = :cid
                 AND (i.period_year * 100 + i.period_month) >= :cutoff
               ORDER BY i.period_year DESC, i.period_month DESC`,
            { replacements: { cid: invRow.customer_id, cutoff }, type: sequelize.QueryTypes.SELECT }
          );

          const { generateInvoiceToken } = require('../utils/templateHelper');
          data.invoice_history = histRows.map(h => {
            const total = parseFloat(h.total || 0);
            const paid  = parseFloat(h.paid_amount || 0);
            const fully = total > 0 && paid >= total;
            const settled = h.status === 'paid' || fully;
            let statusLabel, statusKey;
            if (settled)                     { statusLabel = 'Lunas';        statusKey = 'paid'; }
            else if (h.status === 'overdue') { statusLabel = 'Jatuh Tempo';  statusKey = 'overdue'; }
            else if (h.status === 'cancelled'){ statusLabel = 'Dibatalkan';  statusKey = 'cancelled'; }
            else                             { statusLabel = 'Belum Bayar';  statusKey = 'unpaid'; }
            return {
              id: h.id,
              invoice_number: h.invoice_number,
              period_month: h.period_month,
              period_year:  h.period_year,
              total,
              due_date: h.due_date,
              paid_date: h.paid_date,
              status: statusKey,
              status_label: statusLabel,
              is_current: h.id === invoiceId,
              // Token public per-invoice → tiap baris bisa dibuka sebagai halaman tagihannya sendiri
              token: generateInvoiceToken(h.id),
              payable: ['unpaid', 'overdue'].includes(h.status) && !settled
            };
          });
        } else {
          data.invoice_history = [];
        }
      } catch (histErr) {
        logger.error('publicInvoiceData history error: ' + (histErr.message || histErr));
        data.invoice_history = [];
      }

      // Config pembayaran (gateway flags + rekening manual + WA) supaya halaman
      // publik bisa membangun modal pembayaran identik dgn portal pelanggan.
      try {
        const PublicPaymentService = require('../services/PublicPaymentService');
        data.payment_config = await PublicPaymentService.buildPaymentConfig();
      } catch (cfgErr) {
        logger.error('publicInvoiceData payment_config error: ' + (cfgErr.message || cfgErr));
        data.payment_config = { gateway_enabled: false, gateway_provider: 'midtrans', company_whatsapp: '', payment_accounts: [] };
      }

      res.json({ success: true, data });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Original invoiceData (by payment ID) ─────────────────────
  async invoiceData(req, res) {
    try {
      const paymentId = req.params.id;
      const [row] = await sequelize.query(
        `SELECT p.id, p.amount, p.payment_method, p.payment_date, p.reference_number, p.notes, p.gateway, p.created_at,
                i.invoice_number, i.due_date, i.paid_date, i.status AS invoice_status,
                i.period_month, i.period_year,
                i.amount AS invoice_amount, i.tax AS invoice_tax, i.total AS invoice_total,
                c.name AS cust_name, c.customer_id AS cid, c.phone AS cust_phone,
                c.address AS cust_address, c.email AS cust_email, c.installation_date,
                pkg.name AS pkg_name, pkg.price AS pkg_price,
                u.name AS recorded_by_name
         FROM payments p
         JOIN invoices i ON p.invoice_id = i.id
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         LEFT JOIN users u ON u.id = p.recorded_by
         WHERE p.id = :id`,
        { replacements: { id: paymentId }, type: sequelize.QueryTypes.SELECT }
      );
      if (!row) return res.status(404).json({ success: false, message: 'Payment tidak ditemukan' });

      // Company info dari env
      const company = {
        name:    process.env.COMPANY_NAME    || process.env.APP_NAME || 'ISP Provider',
        address: process.env.COMPANY_ADDRESS || '',
        phone:   process.env.COMPANY_PHONE   || '',
        email:   process.env.COMPANY_EMAIL   || '',
        website: process.env.COMPANY_WEBSITE || '',
        footer:  process.env.INVOICE_FOOTER  || 'Terima kasih telah menggunakan layanan kami.'
      };

      const { displayMethodLabel } = require('../utils/paymentMethodLabel');
      let methodLabel = displayMethodLabel(row.payment_method, { gateway: row.gateway, notes: row.notes });
      if (row.reference_number && row.reference_number.includes(' — ')) {
        const parts = row.reference_number.split(' — ');
        const methodMapKeys = ['cash','transfer','dana','ovo','gopay','qris','field_collection'];
        if (parts[0] && !methodMapKeys.includes(parts[0].toLowerCase())) methodLabel += ' — ' + parts[0];
      }

      // Tax breakdown — derived dari kolom invoice, dgn fallback kalau tax kolom belum di-set
      const { loadTaxSettings } = require('../utils/taxHelper');
      const taxCfg = await loadTaxSettings();
      let invSubtotal = parseFloat(row.invoice_amount || row.pkg_price || 0);
      let invTax      = parseFloat(row.invoice_tax || 0);
      let invTotal    = parseFloat(row.invoice_total || (invSubtotal + invTax));
      if (invTax === 0 && invTotal > invSubtotal && invSubtotal > 0) {
        invTax = invTotal - invSubtotal;
      }
      // Override on-the-fly — kalau setting PPN nonaktif, sembunyikan pajak
      // walau kolom DB masih ada nilai (invoice lama dari saat PPN aktif).
      if (!taxCfg.enabled) {
        invTax   = 0;
        invTotal = invSubtotal > 0 ? invSubtotal : invTotal;
      }
      const computedRate = invSubtotal > 0 && invTax > 0
        ? Math.round((invTax / invSubtotal) * 1000) / 10
        : taxCfg.rate;

      // Rekening pembayaran (Bug 3)
      const bank_accounts = await loadBankAccountsForInvoice();
      // "Layanan aktif hingga" (Bug 2): endpoint ini selalu ada payment record,
      // jadi invoice dianggap lunas → maju 1 bulan dari jatuh tempo.
      const isPaid = row.invoice_status === 'paid' || !!row.payment_date;
      const active_until = isPaid
        ? (addOneMonthKeepDay(row.due_date) || row.due_date)
        : row.due_date;

      res.json({
        success: true,
        data: {
          ...row,
          method_label: methodLabel,
          invoice_subtotal: invSubtotal,
          invoice_tax:      invTax,
          invoice_total:    invTotal,
          tax_label:        taxCfg.label,
          tax_rate:         computedRate,
          tax_applied:      invTax > 0,
          bank_accounts,
          active_until,
          company
        }
      });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Send invoice via WA ──────────────────────────────────────
  /**
   * Kirim invoice via WhatsApp.
   *
   * Endpoint ini support 2 mode input:
   *   • via Payment ID    : POST /payments/:id/send-wa-invoice
   *     (legacy — dipakai dari halaman invoice yang dibuka dari payment)
   *   • via Invoice ID    : POST /invoices/:id/send-wa-invoice
   *     (baru — dipakai dari halaman /billing → buka invoice → kirim WA,
   *      bekerja baik untuk invoice UNPAID, OVERDUE, maupun PAID)
   *
   * Template diambil dari DB berdasarkan status invoice:
   *   • PAID            → category `invoice_paid`   (fallback ke `payment_confirm`)
   *   • UNPAID/OVERDUE  → category `invoice_unpaid` (fallback ke template default)
   *
   * Pesan menyertakan link public invoice (`{link_invoice}`) supaya customer
   * bisa buka invoice tanpa login.
   *
   * @param {object} req  - Express req. req.params.id = paymentId atau invoiceId
   * @param {boolean} byInvoice - true jika ID adalah invoice_id
   */
  async sendWaInvoice(req, res) {
    return PaymentController.prototype._sendWaInvoiceImpl(req, res, false);
  }

  async sendWaInvoiceByInvoice(req, res) {
    return PaymentController.prototype._sendWaInvoiceImpl(req, res, true);
  }

  async _sendWaInvoiceImpl(req, res, byInvoice) {
    try {
      const id = req.params.id;
      const GatewayService = require('../services/GatewayService');
      const {
        WaSession, WaTemplate, Invoice, Customer, Package, Payment
      } = require('../models');
      const {
        replaceVariables, getInvoiceData,
        getDefaultInvoiceUnpaidTemplate, getDefaultInvoicePaidTemplate,
        getOrCreateCustomerLink
      } = require('../utils/templateHelper');

      // ── 1) Resolve invoice + customer (path dependent on mode) ─────
      let invoice;
      if (byInvoice) {
        invoice = await Invoice.findByPk(id, {
          include: [{
            model: Customer, as: 'customer',
            include: [{ model: Package, as: 'package' }]
          }]
        });
      } else {
        const payment = await Payment.findByPk(id, {
          include: [{
            model: Invoice, as: 'invoice',
            include: [{
              model: Customer, as: 'customer',
              include: [{ model: Package, as: 'package' }]
            }]
          }]
        });
        invoice = payment?.invoice || null;
      }

      if (!invoice) {
        return res.status(404).json({
          success: false,
          message: byInvoice ? 'Invoice tidak ditemukan' : 'Payment tidak ditemukan'
        });
      }
      const customer = invoice.customer;
      if (!customer) {
        return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });
      }
      if (!customer.phone) {
        return res.status(400).json({ success: false, message: 'Nomor HP pelanggan tidak tersedia' });
      }

      // ── 2) Cek WA session ─────────────────────────────────────────
      const session = await GatewayService.getDefaultSendingSession();
      if (session) await GatewayService.warmSession(session.session_id);
      if (!session || !GatewayService.isConnected(session.session_id)) {
        return res.status(400).json({ success: false, message: 'Tidak ada session WA yang terhubung' });
      }

      // ── 3) Pilih template berdasarkan status invoice ──────────────
      const isPaid = invoice.status === 'paid';
      const targetCategory  = isPaid ? 'invoice_paid'    : 'invoice_unpaid';
      const fallbackCategory = isPaid ? 'payment_confirm' : null;

      let tpl = await WaTemplate.findOne({
        where: { category: targetCategory, is_active: true },
        order: [['updated_at', 'DESC']]
      });
      // Fallback: kalau invoice_paid belum dibuat user, pakai payment_confirm
      if (!tpl && fallbackCategory) {
        tpl = await WaTemplate.findOne({
          where: { category: fallbackCategory, is_active: true },
          order: [['updated_at', 'DESC']]
        });
      }
      const tplContent = (tpl && (tpl.content || tpl.message))
        || (isPaid ? getDefaultInvoicePaidTemplate() : getDefaultInvoiceUnpaidTemplate());

      // ── 4) Build template variables ──────────────────────────────
      const moment = require('moment');
      const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
      const periodeStr = (MONTHS[invoice.period_month] || invoice.period_month) + ' ' + invoice.period_year;
      const fmtRp   = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
      const fmtDate = s => s ? moment(s).format('DD MMMM YYYY') : '-';

      // Untuk paid invoice, ambil payment terakhir untuk info metode & tgl bayar.
      let paidDateStr   = null;
      let paymentMethodLabel = null;
      if (isPaid) {
        const lastPayment = await Payment.findOne({
          where: { invoice_id: invoice.id },
          order: [['id', 'DESC']]
        });
        if (lastPayment) {
          paidDateStr = lastPayment.payment_date
            ? moment(lastPayment.payment_date).format('DD MMMM YYYY')
            : (invoice.paid_date ? moment(invoice.paid_date).format('DD MMMM YYYY') : '-');
          paymentMethodLabel = require('../utils/paymentMethodLabel').methodLabel(lastPayment.payment_method);
        } else if (invoice.paid_date) {
          paidDateStr = moment(invoice.paid_date).format('DD MMMM YYYY');
        }
      }

      // Ambil nama perusahaan dari setting
      let companyName = 'ISP';
      try {
        const { AppSetting } = require('../models');
        const cn = await AppSetting.findOne({ where: { key: 'company_name' } });
        if (cn?.value) companyName = cn.value;
      } catch(_) { /* ignore */ }

      // ── "Aktif s/d" (aktif_hingga) ───────────────────────────────
      // Untuk invoice LUNAS, masa aktif = jatuh tempo periode invoice + 1 bulan
      // (konsisten dgn endpoint invoice-data: addOneMonthKeepDay(due_date)).
      // Ini akurat PER-INVOICE — tidak salah saat mengirim ulang invoice lama
      // yang bukan periode terakhir. Untuk invoice BELUM LUNAS, pakai jatuh
      // tempo periode invoice apa adanya.
      const activeUntilDate = isPaid
        ? (addOneMonthKeepDay(invoice.due_date) || invoice.due_date)
        : invoice.due_date;

      const tplData = getInvoiceData({
        customerName:  customer.name,
        customerId:    customer.customer_id,
        customerPhone: customer.phone,
        packageName:   customer.package?.name,
        invoiceNumber: invoice.invoice_number,
        invoiceId:     invoice.id,
        periodeStr,
        amountFormatted: fmtRp(invoice.total),
        dueDateFormatted: fmtDate(activeUntilDate),
        paidDateFormatted: paidDateStr,
        status: invoice.status,
        paymentMethodLabel,
        companyName,
        permanentLink: await getOrCreateCustomerLink(customer)
      });

      const msg = replaceVariables(tplContent, tplData);

      // ── 5) Kirim & track ─────────────────────────────────────────
      await GatewayService.sendMessage(session.session_id, customer.phone, msg, null);

      // Track timestamp di invoice (untuk badge UI)
      try {
        invoice.last_wa_reminder_at = new Date();
        await invoice.save();
      } catch(_) { /* non-fatal */ }

      // Increment usage count template
      if (tpl) {
        tpl.update({ usage_count: (tpl.usage_count || 0) + 1 }).catch(()=>{});
      }

      // Activity log (best-effort)
      try {
        const { ActivityLog } = require('../models');
        await ActivityLog.create({
          user_id:     req.user?.id || null,
          action:      isPaid ? 'send_invoice_paid' : 'send_invoice_unpaid',
          module:      'billing',
          description: `Kirim WA invoice ${invoice.invoice_number} (${invoice.status}) ke ${customer.name}`,
          target_type: 'invoice',
          target_id:   invoice.id
        });
      } catch(_) { /* ignore */ }

      res.json({
        success: true,
        message: `Invoice ${invoice.invoice_number} (${(invoice.status || '').toUpperCase()}) berhasil dikirim ke ${customer.phone}`,
        invoice_status: invoice.status,
        used_template: tpl ? (tpl.name || tpl.category) : 'default'
      });
    } catch(e) {
      logger.error('[Payment] sendWaInvoice error: ' + e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Search customers for form ────────────────────────────────
  async searchCustomers(req, res) {
    try {
      const { q } = req.query;
      const where = { status: { [Op.in]: ['active', 'isolated'] } };
      if (q) where[Op.or] = [
        { name: { [Op.like]: '%' + q + '%' } },
        { customer_id: { [Op.like]: '%' + q + '%' } },
        { phone: { [Op.like]: '%' + q + '%' } }
      ];
      const rows = await Customer.findAll({
        where,
        include: [{ model: Package, as: 'package', attributes: ['id','name','price'] }],
        attributes: ['id','customer_id','name','phone','status','billing_date','installation_date','due_date'],
        order: [['name','ASC']],
        limit: 30
      });
      res.json({ success: true, data: rows });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new PaymentController();