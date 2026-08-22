/**
 * utils/paymentFinalizer.js
 * ──────────────────────────────────────────────────────────────────
 * Helper terpusat untuk semua side-effect setelah sebuah pembayaran
 * berhasil (baik via admin manual, webhook Midtrans / Xendit / Duitku,
 * atau channel lain di masa depan).
 *
 * Yang dilakukan:
 *   1. Update Customer.status → 'active'
 *   2. Auto-sync entry ke tabel Keuangan (pemasukan)
 *   3. Auto-restore isolir di MikroTik (kalau customer sebelumnya
 *      ter-isolir / dalam proses restoring)
 *   4. Kirim notifikasi WA "pembayaran terkonfirmasi" (opsional)
 *
 * Semua side-effect ini dibungkus try/catch independen — kalau salah
 * satu gagal (mis. MikroTik unreachable, WhatsApp belum connect, dll)
 * itu TIDAK akan menggagalkan pembayaran. Cron / tombol restore manual
 * masih bisa retry.
 *
 * Dipakai oleh:
 *   - controllers/CustomerPortalController.js  (webhook Midtrans/Xendit/Duitku)
 *   - (PaymentController.js admin tetap pakai logic eksisting agar
 *      compatibility tidak pecah; bisa di-refactor menyusul.)
 * ──────────────────────────────────────────────────────────────────
 */

const moment = require('moment');
const logger = require('./logger');

const { methodLabel: _methodLabel } = require('./paymentMethodLabel');
const METHOD_LABEL = require('./paymentMethodLabel').LABELS;

/**
 * Finalize semua side-effect setelah invoice tertandai paid + Payment dibuat.
 *
 * @param {Object} params
 * @param {number} params.invoiceId      ID invoice yg baru jadi paid
 * @param {number} params.paymentId      ID Payment record yg baru dibuat
 * @param {string} [params.channel]      Sumber pembayaran (mis. 'midtrans','xendit','duitku')
 * @param {string} [params.referenceNo]  Reference number eksternal (order_id / external_id / dll)
 * @returns {Promise<{
 *   customerActivated: boolean,
 *   keuanganSynced: boolean,
 *   isolirRestored: 'restored'|'not_isolated'|'failed'|'skipped',
 *   isolirError: string|null,
 *   waSent: 'sent'|'failed'|'skipped'
 * }>}
 */
async function finalizePaidInvoice({ invoiceId, paymentId, channel = 'gateway', referenceNo = null }) {
  const result = {
    customerActivated: false,
    keuanganSynced:    false,
    isolirRestored:    'skipped',
    isolirError:       null,
    waSent:            'skipped'
  };

  // Lazy-require model agar tidak ada circular dep di startup
  const { Customer, Invoice, Payment, Package, sequelize } = require('../models');

  // ── Ambil context: invoice + customer + payment ──────────────────
  const invoice = await Invoice.findByPk(invoiceId);
  if (!invoice) {
    logger.warn(`[paymentFinalizer] invoice #${invoiceId} not found — skip`);
    return result;
  }
  const customer = await Customer.findByPk(invoice.customer_id, {
    include: [{ model: Package, as: 'package' }]
  });
  if (!customer) {
    logger.warn(`[paymentFinalizer] customer for invoice #${invoiceId} not found — skip`);
    return result;
  }
  const payment = paymentId ? await Payment.findByPk(paymentId) : null;

  // ── 1. Aktifkan customer + PERPANJANG due_date (jatuh tempo berikutnya) ──
  // PENTING (fix): pembayaran via gateway sebelumnya TIDAK memperpanjang
  // customer.due_date, sehingga "masa aktif" tetap di tanggal lama. Sekarang
  // disamakan dengan PaymentController.record: due_date berikutnya = due_date
  // terkini + 1 bulan (pertahankan tanggal). Idempotent: kalau invoice yang
  // dibayar adalah periode yang due_date-nya == customer.due_date, baru maju
  // 1 bulan; kalau customer.due_date sudah lebih maju (mis. webhook retry),
  // jangan maju lagi.
  try {
    const baseDue = customer.due_date || invoice.due_date
      || (payment?.payment_date) || moment().format('YYYY-MM-DD');
    let nextDue = moment(baseDue);
    nextDue = nextDue.isValid() ? nextDue.add(1, 'month').format('YYYY-MM-DD')
                                : moment().add(1, 'month').format('YYYY-MM-DD');

    // Guard anti dobel-maju saat webhook retry: kalau customer.due_date sudah
    // > due_date invoice yang dibayar, anggap perpanjangan sudah pernah jalan.
    const alreadyExtended = customer.due_date && invoice.due_date &&
      moment(customer.due_date).isAfter(moment(invoice.due_date), 'day');

    const custUpdate = {
      status: 'active',
      installation_date: customer.installation_date
        || (payment?.payment_date) || moment().format('YYYY-MM-DD'),
    };
    if (!alreadyExtended) {
      custUpdate.due_date = nextDue;
      const newDueDay = moment(nextDue).date();
      if (newDueDay >= 1 && newDueDay <= 28) custUpdate.billing_date = newDueDay;
    }
    await customer.update(custUpdate);
    // refresh objek lokal supaya step WA (di bawah) baca due_date yang BARU
    if (custUpdate.due_date) customer.due_date = custUpdate.due_date;
    result.customerActivated = true;
    logger.info(`[paymentFinalizer] customer ${customer.customer_id} aktif, due_date → ${customer.due_date} (${channel})`);
  } catch (e) {
    logger.warn(`[paymentFinalizer] gagal update customer (status/due_date): ${e.message}`);
  }

  // ── 2. Auto-sync ke Keuangan ─────────────────────────────────────
  // (sesuai pattern di PaymentController.record line 386-420)
  try {
    const { Keuangan } = require('../models');
    if (payment) {
      const ref = `PAY-${payment.id}`;
      const existing = await Keuangan.findOne({ where: { type: 'pemasukan', ref_number: ref } });
      if (!existing) {
        const payMethod = payment.payment_method || 'gateway';
        const methodStr = METHOD_LABEL[payMethod] || payMethod;
        await Keuangan.create({
          type:        'pemasukan',
          category:    'Pembayaran Pelanggan',
          description: `Pembayaran ${customer.name} (${customer.customer_id})`,
          amount:      parseFloat(payment.amount),
          date:        payment.payment_date,
          ref_number:  ref,
          notes:       `Invoice: ${invoice.invoice_number || '-'} | Metode: ${methodStr} (${channel})`
                       + (referenceNo ? ` | Ref: ${referenceNo}` : ''),
          recorded_by: null   // null = otomatis dari gateway
        });
        logger.info(`[paymentFinalizer] Keuangan synced: ${ref} (${customer.name}, via ${channel})`);
      }
      result.keuanganSynced = true;
    }
  } catch (e) {
    logger.warn(`[paymentFinalizer] sync Keuangan gagal: ${e.message}`);
  }

  // ── 3. Auto-restore isolir MikroTik ──────────────────────────────
  // (sesuai pattern di PaymentController.record line 304-315)
  // Re-fetch isolir_status karena di webhook bisa jadi belum di-update
  if (customer.isolir_status === 'isolated' || customer.isolir_status === 'restoring') {
    try {
      const IsolirSvc = require('../services/IsolirService');
      const r = await IsolirSvc.restoreAfterPayment(customer.id);
      if (r?.success && !r.skipped) {
        result.isolirRestored = 'restored';
        logger.info(`[paymentFinalizer] Auto-restore SUCCESS: ${customer.customer_id} (${customer.name}) via ${channel}`);
      } else if (r?.skipped) {
        result.isolirRestored = 'not_isolated';
      } else {
        result.isolirRestored = 'failed';
        result.isolirError    = r?.message || 'unknown';
        logger.warn(`[paymentFinalizer] Auto-restore RETURN-FAIL: ${customer.customer_id} — ${result.isolirError}`);
      }
    } catch (e) {
      result.isolirRestored = 'failed';
      result.isolirError    = e.message;
      logger.error(`[paymentFinalizer] Auto-restore EXCEPTION untuk ${customer.customer_id}: ${e.message}`);
      // Tidak throw — payment tetap berhasil; cron / tombol restore manual bisa retry.
    }
  } else {
    result.isolirRestored = 'not_isolated';
  }

  // ── 4. Kirim WA konfirmasi pembayaran (best-effort) ─────────────
  if (customer.phone && payment) {
    try {
      const WAService = require('../services/WAService');
      const { WaSession, WaTemplate } = require('../models');
      const { replaceVariables, getPaymentConfirmationData, getDefaultPaymentTemplate }
        = require('./templateHelper');

      const GatewayService = require('../services/GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      if (session) await GatewayService.warmSession(session.session_id);
      if (session && GatewayService.isConnected(session.session_id)) {
        const template = await WaTemplate.findOne({
          where: { category: 'payment_confirm', is_active: true },
          order: [['updated_at', 'DESC']]
        });
        const templateContent = template?.content || template?.message || getDefaultPaymentTemplate();

        const payMethod = payment.payment_method || 'gateway';
        const methodStr = METHOD_LABEL[payMethod] || payMethod;
        const fmtAmt = 'Rp ' + parseFloat(payment.amount).toLocaleString('id-ID');
        const fmtPay = moment(payment.payment_date).format('DD/MM/YYYY');
        // Jatuh tempo berikutnya: prioritaskan customer.due_date (sudah di-update
        // ke periode berikutnya), fallback hitung dari billing_date.
        const dueDateAfter = customer.due_date
          ? moment(customer.due_date).format('YYYY-MM-DD')
          : (customer.billing_date
              ? moment().add(1, 'month').date(customer.billing_date).format('YYYY-MM-DD')
              : moment().add(1, 'month').format('YYYY-MM-DD'));
        const fmtDue = moment(dueDateAfter).format('DD/MM/YYYY');
        let companyName = '';
        try { companyName = await require('./companyInfo').getCompanyName(); } catch (_) {}

        const data = getPaymentConfirmationData({
          customerName:         customer.name,
          customerId:           customer.customer_id,
          customerPhone:        customer.phone,
          packageName:          customer.package?.name,
          amount:               payment.amount,
          amountFormatted:      fmtAmt,
          paymentDate:          payment.payment_date,
          paymentDateFormatted: fmtPay,
          method:               payMethod,
          methodLabel:          methodStr,
          bank:                 null,
          referenceNo:          referenceNo,
          dueDate:              dueDateAfter,
          dueDateFormatted:     fmtDue,
          invoiceNumber:        invoice.invoice_number,
          notes:                payment.notes,
          companyName
        });
        const msg = replaceVariables(templateContent, data);
        await GatewayService.sendMessage(session.session_id, customer.phone, msg, null);
        result.waSent = 'sent';
        if (template) await template.increment('usage_count').catch(() => {});
        await payment.update({ wa_sent_status: 'sent', wa_sent_at: new Date() }).catch(() => {});
      }
    } catch (waErr) {
      result.waSent = 'failed';
      logger.warn(`[paymentFinalizer] WA send gagal: ${waErr.message}`);
      try { await payment.update({ wa_sent_status: 'failed' }); } catch (_) {}
    }
  }

  // Notif event bisnis ke Telegram (fire-and-forget; tak blok proses bayar).
  try {
    require('../services/TelegramEvents').paymentReceived({
      customerName: customer.name,
      amount: payment.amount,
      method: (payment.payment_method || channel),
      invoiceNo: invoice.invoice_number,
      customerId: customer.customer_id,
    });
  } catch (_) { /* abaikan */ }

  return result;
}

module.exports = { finalizePaidInvoice };
