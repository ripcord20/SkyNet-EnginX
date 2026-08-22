/**
 * utils/keuanganSync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sumber TUNGGAL untuk menyinkronkan sebuah Payment menjadi entri PEMASUKAN
 * di modul Keuangan (tabel `keuangan`).
 *
 * Tujuan: SETIAP pembayaran pelanggan langsung tercatat sebagai pemasukan
 * secara OTOMATIS — tanpa perlu klik tombol "Sync Bulan Ini" di halaman
 * Keuangan. Tombol manual tetap berfungsi sebagai backfill untuk data lama.
 *
 * Idempotent: dikunci oleh ref_number = `PAY-{payment.id}`. Bila entri sudah
 * ada, fungsi ini tidak membuat duplikat.
 *
 * Pakai (sederhana):
 *   const { syncPaymentToKeuangan } = require('../utils/keuanganSync');
 *   await syncPaymentToKeuangan(payment, { invoice, customer, recordedBy: req.user?.id, transaction: t });
 *
 * Semua argumen opsional selain `payment`. Bila invoice/customer tidak
 * dikirim, helper akan memuat sendiri dari DB.
 */

const { methodLabel } = require('./paymentMethodLabel');

let _logger;
try { _logger = require('./logger'); } catch (_) { _logger = console; }

/**
 * Sinkronkan satu payment menjadi pemasukan di modul Keuangan.
 *
 * @param {object}  payment            Instance/POJO Payment (wajib punya id, amount, payment_date).
 * @param {object}  [opts]
 * @param {object}  [opts.invoice]     Instance Invoice terkait (untuk no. invoice di catatan).
 * @param {object}  [opts.customer]    Instance Customer terkait (untuk deskripsi).
 * @param {number}  [opts.recordedBy]  ID user pencatat (null = otomatis/gateway).
 * @param {string}  [opts.channel]     Label channel sumber (mis. 'gateway', 'manual', 'portal').
 * @param {string}  [opts.referenceNo] Nomor referensi eksternal (opsional).
 * @param {object}  [opts.transaction] Transaksi Sequelize (opsional, agar atomik).
 * @returns {Promise<{synced:boolean, skipped?:boolean, reason?:string, entry?:object}>}
 */
async function syncPaymentToKeuangan(payment, opts = {}) {
  const { Keuangan, Invoice, Customer } = require('../models');

  if (!payment || !payment.id) {
    return { synced: false, skipped: true, reason: 'payment_invalid' };
  }

  const ref = `PAY-${payment.id}`;
  const tx  = opts.transaction || undefined;

  try {
    // Idempotent guard — sudah pernah disinkronkan?
    const existing = await Keuangan.findOne({
      where: { type: 'pemasukan', ref_number: ref },
      ...(tx ? { transaction: tx } : {})
    });
    if (existing) return { synced: false, skipped: true, reason: 'already_synced', entry: existing };

    // Lengkapi data invoice & customer bila belum dikirim.
    let invoice = opts.invoice || null;
    if (!invoice && payment.invoice_id) {
      invoice = await Invoice.findByPk(payment.invoice_id, tx ? { transaction: tx } : {});
    }

    let customer = opts.customer || null;
    if (!customer && invoice && invoice.customer_id) {
      customer = await Customer.findByPk(invoice.customer_id, tx ? { transaction: tx } : {});
    }

    const custName = customer ? (customer.name || '-') : '-';
    const custCode = customer ? (customer.customer_id || '-') : '-';
    const invNo    = invoice  ? (invoice.invoice_number || '-') : '-';

    const channel    = opts.channel || null;
    const referenceNo = opts.referenceNo
      || payment.reference_number
      || payment.reference_no
      || null;

    const methodStr = methodLabel(payment.payment_method, payment.bank || opts.bank);

    const notesParts = [`Invoice: ${invNo}`, `Metode: ${methodStr}${channel ? ` (${channel})` : ''}`];
    if (referenceNo) notesParts.push(`Ref: ${referenceNo}`);

    const entry = await Keuangan.create({
      type:        'pemasukan',
      category:    'Pembayaran Pelanggan',
      description: `Pembayaran ${custName} (${custCode})`,
      amount:      parseFloat(payment.amount) || 0,
      date:        payment.payment_date,
      ref_number:  ref,
      notes:       notesParts.join(' | '),
      recorded_by: (opts.recordedBy !== undefined ? opts.recordedBy : null)
    }, tx ? { transaction: tx } : {});

    _logger.info && _logger.info(`[keuanganSync] Pemasukan otomatis dicatat: ${ref} (${custName})`);
    return { synced: true, entry };
  } catch (e) {
    // Jangan pernah gagalkan pembayaran hanya karena sync keuangan bermasalah.
    (_logger.warn || console.warn)(`[keuanganSync] gagal sync ${ref}: ${e.message}`);
    return { synced: false, skipped: true, reason: e.message };
  }
}

module.exports = { syncPaymentToKeuangan };
