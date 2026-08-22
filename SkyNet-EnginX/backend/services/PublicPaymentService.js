/**
 * PublicPaymentService.js
 * ──────────────────────────────────────────────────────────────────
 * Core "create payment transaction" gateway logic, di-EXTRACT supaya bisa
 * dipakai dua jalur:
 *
 *   1. Portal pelanggan (login)  → CustomerPortalController.createPayment
 *   2. Public invoice link (TANPA login) → CustomerPortalController.publicPay
 *      (dibuka pelanggan dari link reminder WA: /pub/invoice/<token>)
 *
 * Fungsi ini menerima `customer` + `invoice` yang SUDAH di-resolve oleh
 * caller (caller yang menentukan otorisasi: lewat session portal ATAU lewat
 * HMAC token publik). Service ini tidak tahu-menahu soal auth — ia hanya
 * membangun transaksi ke gateway dan mengembalikan URL/-token redirect.
 *
 * PENTING — merchant_ref / order_id memakai format `INV-{invoiceId}-{ts}`,
 * IDENTIK dengan jalur portal lama. Ini krusial supaya webhook gateway yang
 * sudah ada (tripayNotif/duitkuNotif/midtransNotif/xenditNotif) tetap bisa
 * me-resolve invoice dari callback TANPA bergantung pada sesi login. Artinya
 * pembayaran via link publik akan ter-rekonsiliasi otomatis lewat webhook
 * yang sama persis.
 *
 * Return shape: { success, status?, ...gatewayFields } — caller tinggal
 * res.json() apa adanya. Saat error, { success:false, http, message }.
 * ──────────────────────────────────────────────────────────────────
 */
const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { AppSetting } = require('../models');

async function getSetting(key, fallback = null) {
  try {
    const s = await AppSetting.findOne({ where: { key } });
    return s ? s.value : fallback;
  } catch { return fallback; }
}

/**
 * Sanitasi detail customer supaya lolos validasi Midtrans/Xendit/Duitku.
 */
function sanitizeCustomer(customer) {
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const rawEmail = (customer.email || '').trim();
  const cleanEmail = emailRe.test(rawEmail)
    ? rawEmail
    : `customer-${customer.id}@noreply.digsnet.local`;

  const rawPhone = (customer.phone || '').replace(/[^\d+]/g, '');
  const cleanPhone = rawPhone.length >= 8 ? rawPhone : '';

  const fullName = (customer.name || 'Customer').trim().slice(0, 40);
  const parts = fullName.split(/\s+/);
  const firstName = (parts[0] || 'Customer').slice(0, 20);
  const lastName  = parts.slice(1).join(' ').slice(0, 20);

  return { firstName, lastName, email: cleanEmail, phone: cleanPhone };
}

/**
 * Daftar channel pembayaran Tripay (untuk UI pilih metode).
 * Sama dengan CustomerPortalController.tripayChannels tapi tanpa auth.
 */
async function getTripayChannels() {
  const gwProvider = await getSetting('payment_gateway_provider', 'midtrans');
  if (gwProvider !== 'tripay') {
    return { success: false, http: 400, message: 'Provider aktif bukan Tripay' };
  }
  const apiKey = await getSetting('payment_gateway_server_key', '');
  if (!apiKey || apiKey.length < 16) {
    return { success: false, http: 400, message: 'API Key Tripay belum diisi.' };
  }
  const isProd  = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
  const apiBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';

  let r;
  try {
    r = await axios.get(`${apiBase}/merchant/payment-channel`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 12000,
      validateStatus: s => s < 500
    });
  } catch (e) {
    logger.error('Tripay channels (public) error: ' + (e.message || e));
    return { success: false, http: 502, message: 'Gagal menghubungi Tripay' };
  }
  if (r.status === 401 || (r.data && r.data.success === false)) {
    const msg = (r.data && r.data.message) || 'API Key ditolak';
    return { success: false, http: 400, message: `Tripay: ${msg}` };
  }
  const list = Array.isArray(r.data && r.data.data) ? r.data.data : [];
  const channels = list
    .filter(c => c.active !== false)
    .map(c => ({
      code:  c.code,
      name:  c.name,
      group: c.group || '',
      icon:  c.icon_url || '',
      fee_flat:    (c.total_fee && Number(c.total_fee.flat))    || 0,
      fee_percent: (c.total_fee && c.total_fee.percent != null) ? c.total_fee.percent : '0'
    }));
  return { success: true, env: isProd ? 'production' : 'sandbox', channels };
}

/**
 * Buat transaksi pembayaran gateway.
 *
 * @param {object}  opts
 * @param {object}  opts.customer       instance Customer (sudah di-resolve)
 * @param {object}  opts.invoice        instance Invoice  (sudah di-resolve, status unpaid/overdue)
 * @param {string}  [opts.tripayMethod] kode method Tripay (wajib untuk Tripay)
 * @param {string}  opts.baseUrl        base URL absolut (mis. https://app.isp.id)
 * @param {string}  [opts.returnPath]   path tujuan setelah bayar (default jalur portal).
 *                                      Jalur publik mengisi ini dgn /pub/invoice/:token
 *                                      supaya pelanggan tanpa login tidak diarahkan ke
 *                                      halaman portal yang butuh token.
 * @returns {Promise<object>} { success, ...fields } atau { success:false, http, message }
 */
async function createGatewayTransaction({ customer, invoice, tripayMethod, baseUrl, returnPath }) {
  const gwEnabled   = await getSetting('payment_gateway_enabled', 'false');
  const gwActive    = (gwEnabled === 'true' || gwEnabled === '1');
  if (!gwActive) {
    return { success: false, http: 400, message: 'Pembayaran online belum aktif. Hubungi admin.' };
  }
  const gwProvider  = await getSetting('payment_gateway_provider', 'midtrans');
  const gwKey       = await getSetting('payment_gateway_server_key', '');
  const gwClientKey = await getSetting('payment_gateway_client_key', '');
  if (!gwKey) {
    return { success: false, http: 400, message: 'Pembayaran online belum dikonfigurasi (server key kosong).' };
  }

  const sc = sanitizeCustomer(customer);

  // URL tujuan setelah pembayaran. Jalur portal (login) default ke
  // /portal/payment/finish; jalur publik mengirim returnPath ke /pub/invoice/:token.
  const finishUrl  = returnPath
    ? `${baseUrl}${returnPath}`
    : `${baseUrl}/portal/payment/finish?invoice=${invoice.id}`;
  const errorUrl   = returnPath
    ? `${baseUrl}${returnPath}`
    : `${baseUrl}/portal/payment/finish?invoice=${invoice.id}&status=error`;
  const pendingUrl = returnPath
    ? `${baseUrl}${returnPath}`
    : `${baseUrl}/portal/payment/pending?invoice=${invoice.id}`;

  // ── Midtrans Snap ──────────────────────────────────────────
  if (gwProvider === 'midtrans') {
    const isProd   = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const keyValid = /^(SB-)?Mid-server-/.test(gwKey);
    if (!keyValid) {
      return { success: false, http: 400, message: 'Server Key Midtrans tidak valid.' };
    }
    const orderId = `INV-${invoice.id}-${Date.now()}`;
    const snapUrl = isProd
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const invSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
    const invTax      = Math.round(parseFloat(invoice.tax || 0));
    const invTotal    = Math.round(parseFloat(invoice.total));
    const taxLabel    = (await getSetting('tax_label', 'PPN')) || 'PPN';
    const taxRateNum  = parseFloat(await getSetting('tax_rate', ''));
    const taxLabelFull = invTax > 0
      ? (taxLabel + (Number.isFinite(taxRateNum) && taxRateNum > 0
          ? ' ' + (Number.isInteger(taxRateNum) ? taxRateNum : taxRateNum.toFixed(1)) + '%' : ''))
      : taxLabel;

    const itemDetails = [{
      id: `invoice-${invoice.id}`,
      price: invTax > 0 ? invSubtotal : invTotal,
      quantity: 1,
      name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`
    }];
    if (invTax > 0) itemDetails.push({ id: `tax-${invoice.id}`, price: invTax, quantity: 1, name: taxLabelFull });
    const sumItems = itemDetails.reduce((s, it) => s + (it.price * it.quantity), 0);
    if (sumItems !== invTotal) {
      const diff = invTotal - sumItems;
      itemDetails.push({ id: `adj-${invoice.id}`, price: diff, quantity: 1, name: diff > 0 ? 'Penyesuaian' : 'Diskon' });
    }

    const payload = {
      transaction_details: { order_id: orderId, gross_amount: invTotal },
      customer_details: {
        first_name: sc.firstName,
        last_name:  sc.lastName || undefined,
        email:      sc.email,
        phone:      sc.phone || undefined
      },
      item_details: itemDetails,
      callbacks: { finish: finishUrl, error: errorUrl, pending: pendingUrl }
    };
    const auth = Buffer.from(gwKey + ':').toString('base64');
    let snap;
    try {
      snap = await axios.post(snapUrl, payload, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (gwErr) {
      return mapGatewayError('Midtrans', gwErr);
    }
    if (!snap?.data?.token) {
      return { success: false, http: 502, message: 'Midtrans response tidak valid (snap_token kosong)' };
    }
    await invoice.update({ notes: (invoice.notes || '') + `|midtrans_order:${orderId}` });
    return {
      success: true, mode: 'midtrans',
      snap_token: snap.data.token, snap_url: snap.data.redirect_url,
      client_key: gwClientKey, env: isProd ? 'production' : 'sandbox',
      order_id: orderId, invoice_id: invoice.id
    };
  }

  // ── Xendit ─────────────────────────────────────────────────
  if (gwProvider === 'xendit') {
    if (!gwKey.startsWith('xnd_')) {
      return { success: false, http: 400, message: 'Secret API Key Xendit tidak valid.' };
    }
    const externalId = `INV-${invoice.id}-${Date.now()}`;
    const xenSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
    const xenTax      = Math.round(parseFloat(invoice.tax || 0));
    const xenTotal    = Math.round(parseFloat(invoice.total));
    const xenTaxLabel = (await getSetting('tax_label', 'PPN')) || 'PPN';
    const xenTaxRate  = parseFloat(await getSetting('tax_rate', ''));
    const xenTaxName  = xenTax > 0
      ? (xenTaxLabel + (Number.isFinite(xenTaxRate) && xenTaxRate > 0
          ? ' ' + (Number.isInteger(xenTaxRate) ? xenTaxRate : xenTaxRate.toFixed(1)) + '%' : ''))
      : xenTaxLabel;

    const xenItems = [{
      name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`,
      quantity: 1, price: xenTax > 0 ? xenSubtotal : xenTotal, category: 'Internet Service'
    }];
    if (xenTax > 0) xenItems.push({ name: xenTaxName, quantity: 1, price: xenTax, category: 'Tax' });

    const payload = {
      external_id: externalId, amount: xenTotal,
      description: `Tagihan Internet ${invoice.period_month}/${invoice.period_year} - ${customer.name}`,
      customer: {
        given_names: sc.firstName + (sc.lastName ? ' ' + sc.lastName : ''),
        email: sc.email, mobile_number: sc.phone || undefined
      },
      success_redirect_url: finishUrl,
      failure_redirect_url: errorUrl,
      currency: 'IDR', items: xenItems
    };
    const auth = Buffer.from(gwKey + ':').toString('base64');
    let xen;
    try {
      xen = await axios.post('https://api.xendit.co/v2/invoices', payload, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (gwErr) {
      return mapGatewayError('Xendit', gwErr);
    }
    if (!xen?.data?.invoice_url) {
      return { success: false, http: 502, message: 'Xendit response tidak valid' };
    }
    await invoice.update({ notes: (invoice.notes || '') + `|xendit_id:${externalId}` });
    return { success: true, mode: 'xendit', invoice_url: xen.data.invoice_url, external_id: externalId, invoice_id: invoice.id };
  }

  // ── Duitku POP ─────────────────────────────────────────────
  if (gwProvider === 'duitku') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    if (!merchantCode || !/^[A-Z0-9]{3,15}$/i.test(merchantCode)) {
      return { success: false, http: 400, message: 'Merchant Code Duitku belum/format tidak valid.' };
    }
    if (gwKey.length < 16) {
      return { success: false, http: 400, message: 'API Key Duitku terlalu pendek.' };
    }
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const merchantOrderId = `INV-${invoice.id}-${Date.now()}`;
    const inquiryUrl = isProd
      ? 'https://api-prod.duitku.com/api/merchant/createInvoice'
      : 'https://api-sandbox.duitku.com/api/merchant/createInvoice';

    const dukSubtotal = Math.round(parseFloat(invoice.amount || invoice.total));
    const dukTax      = Math.round(parseFloat(invoice.tax || 0));
    const dukTotal    = Math.round(parseFloat(invoice.total));
    const dukTaxLabel = (await getSetting('tax_label', 'PPN')) || 'PPN';
    const dukTaxRate  = parseFloat(await getSetting('tax_rate', ''));
    const dukTaxName  = dukTax > 0
      ? (dukTaxLabel + (Number.isFinite(dukTaxRate) && dukTaxRate > 0
          ? ' ' + (Number.isInteger(dukTaxRate) ? dukTaxRate : dukTaxRate.toFixed(1)) + '%' : ''))
      : dukTaxLabel;

    const itemDetails = [{
      name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`,
      price: dukTax > 0 ? dukSubtotal : dukTotal, quantity: 1
    }];
    if (dukTax > 0) itemDetails.push({ name: dukTaxName, price: dukTax, quantity: 1 });

    const billingAddress = {
      firstName: sc.firstName, lastName: sc.lastName || '',
      address: String(customer.address || '').slice(0, 200) || 'N/A',
      city: 'Indonesia', postalCode: '00000',
      phone: sc.phone || '', countryCode: 'ID'
    };
    const customerDetail = {
      firstName: sc.firstName, lastName: sc.lastName || '',
      email: sc.email, phoneNumber: sc.phone || '',
      billingAddress, shippingAddress: billingAddress
    };
    const payload = {
      paymentAmount: dukTotal, merchantOrderId,
      productDetails: `Tagihan Internet ${invoice.period_month}/${invoice.period_year} - ${customer.name}`.slice(0, 200),
      email: sc.email, phoneNumber: sc.phone || '', additionalParam: '',
      merchantUserInfo: customer.customer_id || '',
      customerVaName: sc.firstName.slice(0, 20),
      callbackUrl: `${baseUrl}/portal/webhook/duitku`,
      returnUrl: finishUrl,
      expiryPeriod: 60, customerDetail, itemDetails
    };
    const dukTimestamp = Date.now().toString();
    const dukSignature = crypto.createHash('sha256')
      .update(merchantCode + dukTimestamp + gwKey).digest('hex');

    let duk;
    try {
      duk = await axios.post(inquiryUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-duitku-merchantcode': merchantCode,
          'x-duitku-timestamp': dukTimestamp,
          'x-duitku-signature': dukSignature
        }, timeout: 15000
      });
    } catch (gwErr) {
      return mapGatewayError('Duitku', gwErr);
    }
    const dukData = duk?.data || {};
    if (dukData.statusCode && dukData.statusCode !== '00') {
      return { success: false, http: 400, message: `Duitku: ${dukData.statusMessage || 'transaksi gagal'} (kode ${dukData.statusCode})` };
    }
    if (!dukData.paymentUrl || !dukData.reference) {
      return { success: false, http: 502, message: 'Duitku response tidak valid' };
    }
    await invoice.update({ notes: (invoice.notes || '') + `|duitku_order:${merchantOrderId}|duitku_ref:${dukData.reference}` });
    return {
      success: true, mode: 'duitku',
      payment_url: dukData.paymentUrl, reference: dukData.reference,
      merchant_order_id: merchantOrderId, env: isProd ? 'production' : 'sandbox', invoice_id: invoice.id
    };
  }

  // ── Tripay (Closed Transaction) ────────────────────────────
  if (gwProvider === 'tripay') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    const privateKey   = await getSetting('payment_gateway_private_key', '');
    if (!merchantCode) return { success: false, http: 400, message: 'Merchant Code Tripay belum diisi.' };
    if (!privateKey || privateKey.length < 16) return { success: false, http: 400, message: 'Private Key Tripay belum diisi/terlalu pendek.' };

    const method = (tripayMethod || '').toString().trim();
    if (!method) {
      return { success: false, http: 400, code: 'TRIPAY_METHOD_REQUIRED', message: 'Pilih metode pembayaran terlebih dahulu.' };
    }

    const isProd  = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const apiBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
    const merchantRef = `INV-${invoice.id}-${Date.now()}`;
    const amount = Math.round(parseFloat(invoice.total));
    const signature = crypto.createHmac('sha256', privateKey)
      .update(merchantCode + merchantRef + amount).digest('hex');

    const orderItems = [{
      sku: `INV-${invoice.id}`,
      name: `Tagihan Internet ${invoice.period_month}/${invoice.period_year}`.slice(0, 50),
      price: amount, quantity: 1
    }];
    const payload = {
      method, merchant_ref: merchantRef, amount,
      customer_name:  (customer.name || 'Customer').slice(0, 50),
      customer_email: sc.email, customer_phone: sc.phone || '',
      order_items: orderItems,
      callback_url: `${baseUrl}/portal/webhook/tripay`,
      return_url:   finishUrl,
      expired_time: Math.floor(Date.now() / 1000) + (60 * 60),
      signature
    };
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    let trx;
    try {
      trx = await axios.post(`${apiBase}/transaction/create`, payload, {
        headers: { Authorization: `Bearer ${gwKey}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (gwErr) {
      return mapGatewayError('Tripay', gwErr);
    }
    const tBody = trx?.data || {};
    if (!tBody.success || !tBody.data) {
      return { success: false, http: 400, message: `Tripay: ${tBody.message || 'transaksi gagal dibuat'}` };
    }
    const tData = tBody.data;
    if (!tData.checkout_url || !tData.reference) {
      return { success: false, http: 502, message: 'Tripay response tidak valid' };
    }
    await invoice.update({ notes: (invoice.notes || '') + `|tripay_ref:${merchantRef}|tripay_tref:${tData.reference}` });
    return {
      success: true, mode: 'tripay',
      payment_url: tData.checkout_url, reference: tData.reference,
      merchant_ref: merchantRef, env: isProd ? 'production' : 'sandbox', invoice_id: invoice.id
    };
  }

  return { success: false, http: 400, message: 'Payment gateway provider tidak dikenali' };
}

/**
 * Map error axios gateway ke shape { success:false, http, message }.
 */
function mapGatewayError(name, gwErr) {
  if (gwErr.response) {
    const status = gwErr.response.status;
    const data   = gwErr.response.data;
    logger.error(`${name} ${status}: ${JSON.stringify(data)}`);
    if (status === 401 || status === 403) {
      return { success: false, http: 400, message: `${name} auth ditolak. Cek kredensial gateway.` };
    }
    if (data?.error_messages?.length) {
      return { success: false, http: 400, message: `${name}: ` + data.error_messages.join(', ') };
    }
    const msg = data?.message || data?.Message || data?.status_message || data?.error_code || gwErr.message;
    return { success: false, http: 400, message: `${name} error ${status}: ${msg}` };
  }
  if (gwErr.code === 'ECONNABORTED') return { success: false, http: 408, message: `Koneksi ke ${name} timeout` };
  if (gwErr.code === 'ENOTFOUND' || gwErr.code === 'ECONNREFUSED') {
    return { success: false, http: 502, message: `Tidak bisa terhubung ke server ${name}` };
  }
  logger.error(`${name} unexpected error: ${gwErr.message}`);
  return { success: false, http: 500, message: `Gagal membuat transaksi ${name}: ${gwErr.message}` };
}

module.exports = {
  getSetting,
  sanitizeCustomer,
  getTripayChannels,
  createGatewayTransaction,
  buildManualWaUrl,
  buildPaymentConfig,
  notifyAdminProofSubmitted
};

// ── Notifikasi admin: bukti pembayaran diunggah pelanggan (best-effort) ──
// Kirim WA ke nomor CS perusahaan agar admin tahu ada bukti menunggu verifikasi.
async function notifyAdminProofSubmitted(customer, invoice) {
  try {
    const companyWa = (await getSetting('company_whatsapp', '') || '').replace(/[^0-9]/g, '');
    if (!companyWa) return;
    const GatewayService = require('./GatewayService');
    const session = await GatewayService.getDefaultSendingSession();
    if (!session) return;
    await GatewayService.warmSession(session.session_id);
    if (!GatewayService.isConnected(session.session_id)) return;

    const months = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    const periode = `${months[invoice.period_month] || invoice.period_month} ${invoice.period_year}`;
    const total = 'Rp ' + Number(invoice.total || 0).toLocaleString('id-ID');
    const msg =
      `🔔 *Bukti Pembayaran Masuk*\n\n` +
      `Pelanggan: *${customer.name}* (${customer.customer_id})\n` +
      `Invoice: ${invoice.invoice_number}\n` +
      `Periode: ${periode}\n` +
      `Total: ${total}\n\n` +
      `Mohon verifikasi di dashboard → Billing → Verifikasi Bukti.`;
    await GatewayService.sendMessage(session.session_id, companyWa, msg, null);
  } catch (_) { /* best-effort */ }
}

// ── Manual confirm: bangun URL WhatsApp konfirmasi pembayaran ────────
// Identik dgn jalur portal (CustomerPortalController.createPayment mode=manual).
async function buildManualWaUrl(customer, invoice) {
  const companyName = await getSetting('company_name', 'ISP');
  const companyWa   = await getSetting('company_whatsapp', '');
  const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni',
                      'Juli','Agustus','September','Oktober','November','Desember'];
  const periodeStr = `${monthNames[invoice.period_month] || invoice.period_month} ${invoice.period_year}`;
  const waMsg = encodeURIComponent(
    `*Konfirmasi Pembayaran*\n\n` +
    `Halo ${companyName},\n` +
    `Saya sudah transfer untuk tagihan internet berikut:\n\n` +
    `👤 Nama        : ${customer.name}\n` +
    `🆔 ID Pelanggan : ${customer.customer_id}\n` +
    `📄 No Invoice   : ${invoice.invoice_number}\n` +
    `📅 Periode      : ${periodeStr}\n` +
    `💰 Jumlah       : Rp ${parseFloat(invoice.total).toLocaleString('id-ID')}\n\n` +
    `Mohon verifikasi pembayarannya. Terima kasih 🙏`
  );
  return companyWa ? `https://wa.me/${companyWa.replace(/[^0-9]/g, '')}?text=${waMsg}` : null;
}

// ── Config pembayaran untuk halaman publik ──────────────────────────
// Mengembalikan flag gateway + daftar rekening manual (bank/ewallet/qris)
// + nomor WA, supaya halaman invoice publik bisa membangun modal pembayaran
// yang IDENTIK dgn portal pelanggan.
async function buildPaymentConfig() {
  const gwEnabledRaw = await getSetting('payment_gateway_enabled', 'false');
  const gwEnabled    = (gwEnabledRaw === 'true' || gwEnabledRaw === '1');
  const gwProvider   = await getSetting('payment_gateway_provider', 'midtrans');
  const companyWa    = (await getSetting('company_whatsapp', '') || '').replace(/[^0-9]/g, '');

  // Info perusahaan untuk header & footer halaman pembayaran publik.
  // Fallback berlapis: AppSetting (company_*) → invoice template (invtpl_company_*)
  //                    → ENV (COMPANY_*) → default.
  const companyName    = (await getSetting('company_name', ''))
                      || (await getSetting('invtpl_company_name', ''))
                      || (await getSetting('app_name', ''))
                      || process.env.COMPANY_NAME || process.env.APP_NAME || 'ISP Provider';
  const companyAddress = (await getSetting('company_address', ''))
                      || (await getSetting('invtpl_company_address', ''))
                      || process.env.COMPANY_ADDRESS || '';
  const companyPhone   = (await getSetting('company_phone', ''))
                      || (await getSetting('invtpl_company_phone', ''))
                      || companyWa
                      || process.env.COMPANY_PHONE || '';
  const companyEmail   = (await getSetting('company_email', ''))
                      || (await getSetting('invtpl_company_email', ''))
                      || process.env.COMPANY_EMAIL || '';
  const companyWebsite = (await getSetting('company_website', ''))
                      || process.env.COMPANY_WEBSITE || '';

  // payment_accounts disimpan sebagai JSON array di AppSetting.
  let accounts = [];
  try {
    const row = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    if (row && row.value) {
      const list = JSON.parse(row.value);
      if (Array.isArray(list)) {
        accounts = list
          .filter(a => a && a.is_active !== false && ['bank', 'ewallet', 'qris'].includes(a.type))
          .map(a => ({
            type: a.type,
            provider: a.provider || '',
            account_number: a.account_number || '',
            account_owner: a.account_owner || '',
            logo_url: a.logo_url || '',
            is_active: a.is_active !== false
          }));
      }
    }
  } catch (_) { accounts = []; }

  return {
    gateway_enabled: gwEnabled,
    gateway_provider: gwProvider,
    company_whatsapp: companyWa,
    company_name:    companyName,
    company_address: companyAddress,
    company_phone:   companyPhone,
    company_email:   companyEmail,
    company_website: companyWebsite,
    payment_accounts: accounts
  };
}
