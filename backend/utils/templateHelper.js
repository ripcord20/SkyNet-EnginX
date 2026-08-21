/**
 * Template Helper - Replace variables in WA templates
 */

const crypto = require('crypto');

/**
 * Generate signed token untuk public invoice URL.
 *
 * Format token: `<invoiceId>.<sig>`
 *   • invoiceId = ID invoice (integer)
 *   • sig       = HMAC-SHA256(invoiceId, JWT_SECRET) → hex 16 char pertama
 *
 * Token TIDAK punya expiry — link invoice akan terus valid (sesuai use case
 * pelanggan bisa simpan invoice lama). Untuk membuat link tidak bisa ditebak,
 * kuncinya adalah JWT_SECRET yang tidak dipublikasi.
 *
 * Kalau JWT_SECRET tidak diset (dev env), fallback ke konstanta lokal — log
 * warning sekali. Production WAJIB set JWT_SECRET.
 */
function generateInvoiceToken(invoiceId) {
  const secret = process.env.JWT_SECRET || 'flaynet-invoice-fallback-key-change-me';
  const sig = crypto.createHmac('sha256', secret)
    .update(String(invoiceId))
    .digest('hex')
    .slice(0, 16);
  return `${invoiceId}.${sig}`;
}

/**
 * Verify token. Return invoiceId (number) jika valid, null jika invalid.
 * Pakai timingSafeEqual untuk hindari timing attack.
 */
function verifyInvoiceToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const invoiceId = parseInt(parts[0], 10);
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) return null;
  const expectedToken = generateInvoiceToken(invoiceId);
  const expectedSig = expectedToken.split('.')[1];
  const givenSig    = parts[1];
  if (givenSig.length !== expectedSig.length) return null;
  try {
    const ok = crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(givenSig,    'utf8')
    );
    return ok ? invoiceId : null;
  } catch (_) { return null; }
}

/**
 * Build URL absolut ke halaman public invoice.
 * BASE_URL atau APP_URL diambil dari env; jika tidak ada, fallback ke '/' (relatif).
 */
function buildInvoiceLink(invoiceId) {
  const base = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
  const token = generateInvoiceToken(invoiceId);
  return base ? `${base}/pub/invoice/${token}` : `/pub/invoice/${token}`;
}

/**
 * ── PERMANENT CUSTOMER LINK ────────────────────────────────────────────
 * Link permanen per-PELANGGAN (bukan per-invoice). Selalu menampilkan
 * invoice aktif terbaru pelanggan, jadi link tidak berubah tiap periode.
 *
 * Berbeda dengan token invoice yang deterministik (HMAC dari ID), token
 * pelanggan ini RANDOM dan disimpan di kolom customers.public_link_token.
 * Konsekuensinya: token bisa di-REVOKE per pelanggan — cukup generate ulang
 * token random baru untuk pelanggan itu, link lama langsung tidak valid,
 * tanpa mengganggu pelanggan lain.
 *
 * Format: 40 hex char acak (20 byte). Tidak mengandung info ID sehingga
 * tidak bisa ditebak.
 */
function generateCustomerLinkToken() {
  return crypto.randomBytes(20).toString('hex'); // 40 char
}

/**
 * Build URL absolut ke halaman permanent link pelanggan.
 */
function buildCustomerLink(token) {
  const base = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/pub/cust/${token}` : `/pub/cust/${token}`;
}

/**
 * Ambil link permanen pelanggan; generate + simpan token kalau belum ada.
 * Dipakai saat kirim WA supaya {link_bayar_permanen} selalu terisi, termasuk
 * untuk pelanggan lama yang belum sempat di-"buat massal".
 * @param {object} customer - instance Sequelize Customer (punya .save())
 * @returns {Promise<string>} URL permanen (atau '' kalau gagal)
 */
async function getOrCreateCustomerLink(customer) {
  try {
    if (!customer) return '';
    if (!customer.public_link_token) {
      const { Customer } = require('../models');
      let token = null;
      for (let i = 0; i < 5; i++) {
        const candidate = generateCustomerLinkToken();
        const dup = await Customer.findOne({ where: { public_link_token: candidate } });
        if (!dup) { token = candidate; break; }
      }
      if (!token) return '';
      customer.public_link_token = token;
      try { await customer.save(); } catch (_) {
        // Kalau instance tidak bisa di-save (mis. plain object), update by id.
        try { const { Customer } = require('../models'); await Customer.update({ public_link_token: token }, { where: { id: customer.id } }); } catch (__) {}
      }
    }
    return buildCustomerLink(customer.public_link_token);
  } catch (_) { return ''; }
}

/**
 * Replace template variables with actual data
 * @param {string} template - Template string with {variable} placeholders
 * @param {object} data - Data object with variable values
 * @returns {string} - Processed message
 */
function replaceVariables(template, data) {
  if (!template) return '';
  
  let message = template;
  
  // Replace each variable in the format {variable_name}
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    const value = data[key] !== null && data[key] !== undefined ? data[key] : '-';
    message = message.replace(regex, value);
  });
  
  return message;
}

/**
 * Get payment confirmation data for template
 * @param {object} params - Payment data
 * @returns {object} - Template variables
 */
function getPaymentConfirmationData(params) {
  const {
    customerName,
    customerId,
    customerPhone,
    packageName,
    amount,
    amountFormatted,
    paymentDate,
    paymentDateFormatted,
    method,
    methodLabel,
    bank,
    referenceNo,
    dueDate,
    dueDateFormatted,
    invoiceNumber,
    invoiceId,
    notes,
    companyName,
    permanentLink
  } = params;

  // Public invoice link (kalau invoiceId disertakan). Untuk template
  // payment_confirm yang ditrigger dari pencatatan pembayaran manual,
  // caller bisa pass invoiceId supaya pelanggan dapat link ke invoice.
  const linkInvoice = invoiceId ? buildInvoiceLink(invoiceId) : '';

  return {
    // Customer info
    nama: customerName || '-',
    name: customerName || '-',
    customer_name: customerName || '-',
    cid: customerId || '-',
    customer_id: customerId || '-',
    phone: customerPhone || '-',
    nohp: customerPhone || '-',
    
    // Package info
    paket: packageName || '-',
    package: packageName || '-',
    package_name: packageName || '-',
    
    // Payment amount
    jumlah: amountFormatted || amount || '-',
    amount: amountFormatted || amount || '-',
    nominal: amountFormatted || amount || '-',
    
    // Payment date
    tgl_bayar: paymentDateFormatted || paymentDate || '-',
    payment_date: paymentDateFormatted || paymentDate || '-',
    tanggal: paymentDateFormatted || paymentDate || '-',
    
    // Payment method
    metode: methodLabel || method || '-',
    method: methodLabel || method || '-',
    payment_method: methodLabel || method || '-',
    bank: bank || '',
    
    // Reference
    ref_no: referenceNo || '',
    reference: referenceNo || '',
    reference_no: referenceNo || '',
    
    // Due date
    jatuh_tempo: dueDateFormatted || dueDate || '-',
    due_date: dueDateFormatted || dueDate || '-',
    aktif_hingga: dueDateFormatted || dueDate || '-',
    expired_date: dueDateFormatted || dueDate || '-',
    // Alias "jatuh tempo baru / berikutnya" — pada konteks payment_confirm,
    // dueDate yang dikirim caller SUDAH merupakan jatuh tempo periode berikutnya
    // (due_date_after). Sediakan alias-alias umum agar template lama yang memakai
    // {due_date_baru} dll. ter-render dengan benar (sebelumnya dibiarkan mentah).
    due_date_baru: dueDateFormatted || dueDate || '-',
    jatuh_tempo_baru: dueDateFormatted || dueDate || '-',
    tgl_jatuh_tempo_baru: dueDateFormatted || dueDate || '-',
    due_date_after: dueDateFormatted || dueDate || '-',
    aktif_sampai: dueDateFormatted || dueDate || '-',
    aktif_sd: dueDateFormatted || dueDate || '-',
    next_due_date: dueDateFormatted || dueDate || '-',
    next_due: dueDateFormatted || dueDate || '-',
    tgl_jatuh_tempo: dueDateFormatted || dueDate || '-',
    
    // Invoice
    invoice: invoiceNumber || '-',
    invoice_number: invoiceNumber || '-',
    invoice_no: invoiceNumber || '-',

    // Public invoice link (HMAC-signed token URL)
    link_invoice: linkInvoice,
    link: linkInvoice,
    invoice_link: linkInvoice,
    invoice_url: linkInvoice,

    // Link pembayaran permanen per-pelanggan
    link_bayar_permanen: permanentLink || '',
    link_permanen:       permanentLink || '',
    permanent_link:      permanentLink || '',
    
    // Additional
    catatan: notes || '',
    notes: notes || '',

    // Company name (alias) — agar template payment yang memakai {perusahaan}
    // ikut ter-render. Caller boleh kirim companyName; bila tidak, fallback '-'.
    perusahaan: companyName || '-',
    company: companyName || '-',
    company_name: companyName || '-'
  };
}

/**
 * Get default payment confirmation template
 * @returns {string} - Default template
 */
function getDefaultPaymentTemplate() {
  return `✅ *Pembayaran Diterima*

Terima kasih *{nama}*, pembayaran Anda telah dicatat.

📦 Paket   : {paket}
💰 Jumlah  : {jumlah}
📅 Tgl Bayar: {tgl_bayar}
💳 Metode  : {metode}

*Aktif hingga: {aktif_hingga}*

📄 Lihat invoice: {link_invoice}

_Terima kasih telah menggunakan layanan kami_ 🙏`;
}

/**
 * Get template data untuk invoice (paid maupun unpaid).
 *
 * Berbeda dengan `getPaymentConfirmationData` yang berbasis Payment,
 * fungsi ini berbasis Invoice — bisa dipakai untuk:
 *   • invoice_unpaid : kirim tagihan yang belum dibayar (status UNPAID/OVERDUE)
 *   • invoice_paid   : kirim invoice setelah dibayar (status PAID)
 *
 * Includes `{link_invoice}` untuk URL public invoice (pakai HMAC token).
 */
function getInvoiceData(params) {
  const {
    customerName, customerId, customerPhone,
    packageName,
    invoiceNumber, invoiceId,
    periodeStr,
    amount, amountFormatted,
    dueDate, dueDateFormatted,
    paidDate, paidDateFormatted,
    status,            // 'unpaid'|'overdue'|'paid'
    paymentMethodLabel,
    companyName,
    permanentLink      // URL link pembayaran permanen pelanggan (opsional)
  } = params;

  // {status} dalam Bahasa Indonesia untuk display di pesan WA
  let statusLabel;
  if (status === 'paid')         statusLabel = '✅ LUNAS';
  else if (status === 'overdue') statusLabel = '⚠️ JATUH TEMPO';
  else                            statusLabel = 'BELUM DIBAYAR';

  const linkInvoice = invoiceId ? buildInvoiceLink(invoiceId) : '';

  return {
    // Customer
    nama:          customerName || '-',
    name:          customerName || '-',
    customer_name: customerName || '-',
    cid:           customerId || '-',
    customer_id:   customerId || '-',
    phone:         customerPhone || '-',
    nohp:          customerPhone || '-',

    // Paket
    paket:        packageName || '-',
    package:      packageName || '-',
    package_name: packageName || '-',

    // Invoice
    invoice:        invoiceNumber || '-',
    invoice_number: invoiceNumber || '-',
    invoice_no:     invoiceNumber || '-',
    periode:        periodeStr || '-',

    // Amount
    jumlah:  amountFormatted || amount || '-',
    amount:  amountFormatted || amount || '-',
    nominal: amountFormatted || amount || '-',
    total:   amountFormatted || amount || '-',

    // Tanggal jatuh tempo
    jatuh_tempo:     dueDateFormatted || dueDate || '-',
    tgl_jatuh_tempo: dueDateFormatted || dueDate || '-',
    due_date:        dueDateFormatted || dueDate || '-',

    // Tanggal bayar (untuk paid)
    tgl_bayar:    paidDateFormatted || paidDate || '-',
    payment_date: paidDateFormatted || paidDate || '-',
    tanggal:      paidDateFormatted || paidDate || '-',
    aktif_hingga: dueDateFormatted  || dueDate  || '-',
    expired_date: dueDateFormatted  || dueDate  || '-',

    // Metode (untuk paid)
    metode:         paymentMethodLabel || '-',
    method:         paymentMethodLabel || '-',
    payment_method: paymentMethodLabel || '-',

    // Status & perusahaan
    status:     statusLabel,
    perusahaan: companyName || '-',
    company:    companyName || '-',

    // Link ke invoice (public URL, tidak butuh login customer)
    link_invoice:  linkInvoice,
    link:          linkInvoice,
    invoice_link:  linkInvoice,
    invoice_url:   linkInvoice,

    // Link pembayaran PERMANEN per-pelanggan (selalu tampilkan tagihan aktif).
    // Kosong kalau pelanggan belum punya token.
    link_bayar_permanen: permanentLink || '',
    link_permanen:       permanentLink || '',
    permanent_link:      permanentLink || ''
  };
}

function getDefaultInvoiceUnpaidTemplate() {
  return `📄 *Invoice Tagihan*

Halo *{nama}*,
Berikut tagihan internet Anda yang *belum dibayar*:

No Invoice : *{invoice}*
Paket      : {paket}
Periode    : {periode}
Total      : *{jumlah}*
Jatuh Tempo: *{jatuh_tempo}*
Status     : {status}

📄 Lihat invoice lengkap: {link_invoice}

Mohon segera lakukan pembayaran agar layanan tetap aktif.
_Terima kasih_ 🙏`;
}

function getDefaultInvoicePaidTemplate() {
  return `✅ *Invoice — LUNAS*

Halo *{nama}*,
Pembayaran Anda telah diterima. Berikut detailnya:

No Invoice : *{invoice}*
Paket      : {paket}
Periode    : {periode}
Total      : *{jumlah}*
Tgl Bayar  : {tgl_bayar}
Metode     : {metode}
Aktif s/d  : *{aktif_hingga}*

📄 Lihat / unduh invoice: {link_invoice}

_Terima kasih telah menggunakan layanan kami_ 🙏`;
}

module.exports = {
  replaceVariables,
  getPaymentConfirmationData,
  getDefaultPaymentTemplate,
  getInvoiceData,
  getDefaultInvoiceUnpaidTemplate,
  getDefaultInvoicePaidTemplate,
  generateInvoiceToken,
  verifyInvoiceToken,
  buildInvoiceLink,
  generateCustomerLinkToken,
  buildCustomerLink,
  getOrCreateCustomerLink
};