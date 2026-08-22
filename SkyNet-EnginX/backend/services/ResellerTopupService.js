/**
 * ResellerTopupService.js — Logika isi saldo (top-up) reseller.
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiga jalur:
 *   1. Manual / QRIS  → reseller upload bukti, admin verifikasi → creditTopup()
 *   2. Gateway        → createGatewayTopup() bikin transaksi di provider;
 *                       webhook memanggil markGatewayPaid() saat PAID.
 *
 * Reuse SETTING gateway yang sama dengan modul invoice (payment_gateway_*),
 * jadi konfigurasi cukup sekali di Pengaturan. Yang membedakan hanyalah
 * merchant_ref berprefix "RTOP-" + callback URL khusus /reseller/webhook/*.
 *
 * SEMUA kredit saldo lewat creditTopup() — atomik (row-lock) + idempotent
 * (guard kolom `credited`). Tidak ada jalur lain yang menambah saldo dari top-up.
 */
const crypto = require('crypto');
const axios = require('axios');
const {
  sequelize, Reseller, ResellerTransaction, ResellerTopup, AppSetting
} = require('../models');
const logger = require('../utils/logger');

async function getSetting(key, fallback = null) {
  try {
    const row = await AppSetting.findOne({ where: { key } });
    return row && row.value != null ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

// Daftar metode top-up yang aktif untuk reseller (untuk UI).
async function getTopupConfig() {
  const gwEnabledRaw = await getSetting('payment_gateway_enabled', 'false');
  const gwEnabled = (gwEnabledRaw === 'true' || gwEnabledRaw === '1');
  const gwProvider = await getSetting('payment_gateway_provider', 'midtrans');

  // Reseller top-up bisa diaktif/nonaktifkan terpisah (default: ikut gateway).
  const resellerGwRaw = await getSetting('reseller_topup_gateway_enabled', gwEnabled ? 'true' : 'false');
  const resellerGwEnabled = (resellerGwRaw === 'true' || resellerGwRaw === '1') && gwEnabled;

  const manualRaw = await getSetting('reseller_topup_manual_enabled', 'true');
  const manualEnabled = (manualRaw === 'true' || manualRaw === '1');

  const minTopup = parseInt(await getSetting('reseller_topup_min', '10000')) || 10000;

  // Rekening manual / QRIS — reuse payment_accounts (sama dengan portal).
  let accounts = [];
  try {
    const row = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    if (row && row.value) {
      const list = JSON.parse(row.value);
      if (Array.isArray(list)) {
        accounts = list
          .filter(a => a && a.is_active !== false && ['bank', 'ewallet', 'qris'].includes(a.type))
          .map(a => ({
            type: a.type, provider: a.provider || '',
            account_number: a.account_number || '', account_owner: a.account_owner || '',
            logo_url: a.logo_url || '', qris_image: a.qris_image || a.logo_url || ''
          }));
      }
    }
  } catch (_) { accounts = []; }

  return {
    manual_enabled: manualEnabled,
    gateway_enabled: resellerGwEnabled,
    gateway_provider: gwProvider,
    min_topup: minTopup,
    accounts
  };
}

/**
 * KREDIT SALDO — satu-satunya jalur menambah saldo dari top-up.
 * Atomik (row-lock) + idempotent (guard kolom credited).
 *
 * @param {number} topupId
 * @param {object} [opts]  { verified_by, description }
 * @returns {Promise<{credited:boolean, balance:number, already?:boolean}>}
 */
async function creditTopup(topupId, opts = {}) {
  return sequelize.transaction(async (t) => {
    const topup = await ResellerTopup.findByPk(topupId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!topup) throw new Error('Top-up tidak ditemukan');

    // Idempotent — sudah dikreditkan sebelumnya.
    if (topup.credited) {
      const r = await Reseller.findByPk(topup.reseller_id, { transaction: t });
      return { credited: false, already: true, balance: Number(r ? r.balance : 0) };
    }

    const reseller = await Reseller.findByPk(topup.reseller_id, { lock: t.LOCK.UPDATE, transaction: t });
    if (!reseller) throw new Error('Reseller tidak ditemukan');

    const amount = Number(topup.amount);
    const bonus = Number(topup.bonus_amount) || 0;   // promo (#10)
    const credited = amount + bonus;
    const before = Number(reseller.balance);
    const after = before + credited;
    await reseller.update({ balance: after }, { transaction: t });

    const methodLabel = topup.method === 'gateway'
      ? `Gateway ${topup.gateway_provider || ''}`.trim()
      : (topup.method === 'qris' ? 'QRIS' : 'Transfer Manual');
    const descBase = opts.description || `Top-up saldo via ${methodLabel} (${topup.ref})`;
    const txn = await ResellerTransaction.create({
      reseller_id: reseller.id, type: 'topup', amount: credited,
      balance_before: before, balance_after: after,
      description: bonus > 0
        ? `${descBase} + bonus promo Rp ${bonus.toLocaleString('id-ID')}`
        : descBase,
      created_by: opts.verified_by || null
    }, { transaction: t });

    // Catat pemakaian promo (atomik). Best-effort: bila gagal, jangan batalkan kredit.
    if (bonus > 0 && topup.promo_id) {
      try {
        const ResellerPromoService = require('./ResellerPromoService');
        await ResellerPromoService.recordRedemption({
          promo_id: topup.promo_id, reseller_id: reseller.id,
          topup_id: topup.id, transaction_id: txn.id,
          topup_amount: amount, bonus_amount: bonus
        }, t);
      } catch (e) { /* non-fatal: bonus tetap diberikan */ }
    }

    await topup.update({
      status: 'paid', credited: true, transaction_id: txn.id,
      paid_at: new Date(),
      verified_by: opts.verified_by || topup.verified_by || null,
      verified_at: opts.verified_by ? new Date() : topup.verified_at
    }, { transaction: t });

    return { credited: true, balance: after, ref: topup.ref, amount, bonus, total: credited };
  });
}

/**
 * Buat transaksi top-up via payment gateway (otomatis).
 * Reuse setting payment_gateway_* (provider, key, env). merchant_ref = RTOP-...
 *
 * @returns {Promise<object>} { success, payment_url, ... } | { success:false, http, message }
 */
async function createGatewayTopup({ topup, reseller, baseUrl, tripayMethod }) {
  const gwEnabled = await getSetting('payment_gateway_enabled', 'false');
  if (!(gwEnabled === 'true' || gwEnabled === '1')) {
    return { success: false, http: 400, message: 'Pembayaran online belum aktif.' };
  }
  const provider = await getSetting('payment_gateway_provider', 'midtrans');
  const gwKey = await getSetting('payment_gateway_server_key', '');
  if (!gwKey) return { success: false, http: 400, message: 'Gateway belum dikonfigurasi (server key kosong).' };

  const amount = Math.round(Number(topup.amount));
  const merchantRef = topup.ref; // RTOP-{id}-{ts}
  const finishUrl = `${baseUrl}/reseller/topup/result?ref=${encodeURIComponent(merchantRef)}`;
  const callbackBase = `${baseUrl}/reseller/webhook`;
  const custName = (reseller.name || 'Reseller').slice(0, 50);
  const custEmail = `reseller${reseller.id}@topup.local`;
  const custPhone = (reseller.phone || '').replace(/[^0-9]/g, '');

  // ── Tripay (Closed Transaction) ─────────────────────────────
  if (provider === 'tripay') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    const privateKey = await getSetting('payment_gateway_private_key', '');
    if (!merchantCode) return { success: false, http: 400, message: 'Merchant Code Tripay belum diisi.' };
    if (!privateKey || privateKey.length < 16) return { success: false, http: 400, message: 'Private Key Tripay belum diisi.' };
    const method = (tripayMethod || '').toString().trim();
    if (!method) return { success: false, http: 400, code: 'TRIPAY_METHOD_REQUIRED', message: 'Pilih metode pembayaran.' };

    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const apiBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
    const signature = crypto.createHmac('sha256', privateKey)
      .update(merchantCode + merchantRef + amount).digest('hex');
    const payload = {
      method, merchant_ref: merchantRef, amount,
      customer_name: custName, customer_email: custEmail, customer_phone: custPhone || '',
      order_items: [{ sku: merchantRef, name: `Top-up Saldo Reseller`.slice(0, 50), price: amount, quantity: 1 }],
      callback_url: `${callbackBase}/tripay`,
      return_url: finishUrl,
      expired_time: Math.floor(Date.now() / 1000) + (60 * 60),
      signature
    };
    let trx;
    try {
      trx = await axios.post(`${apiBase}/transaction/create`, payload, {
        headers: { Authorization: `Bearer ${gwKey}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (e) { return mapErr('Tripay', e); }
    const tBody = trx?.data || {};
    if (!tBody.success || !tBody.data?.checkout_url) {
      return { success: false, http: 400, message: `Tripay: ${tBody.message || 'gagal'}` };
    }
    await topup.update({
      gateway_provider: 'tripay', gateway_ref: tBody.data.reference,
      gateway_method: method, payment_url: tBody.data.checkout_url,
      expires_at: new Date(Date.now() + 3600000)
    });
    return { success: true, mode: 'tripay', payment_url: tBody.data.checkout_url, ref: merchantRef };
  }

  // ── Midtrans Snap ───────────────────────────────────────────
  if (provider === 'midtrans') {
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    if (!/^(SB-)?Mid-server-/.test(gwKey)) return { success: false, http: 400, message: 'Server Key Midtrans tidak valid.' };
    const snapUrl = isProd ? 'https://app.midtrans.com/snap/v1/transactions'
                           : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
    const payload = {
      transaction_details: { order_id: merchantRef, gross_amount: amount },
      customer_details: { first_name: custName, email: custEmail, phone: custPhone || undefined },
      item_details: [{ id: merchantRef, price: amount, quantity: 1, name: 'Top-up Saldo Reseller' }],
      callbacks: { finish: finishUrl }
    };
    const auth = Buffer.from(gwKey + ':').toString('base64');
    let snap;
    try {
      snap = await axios.post(snapUrl, payload, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (e) { return mapErr('Midtrans', e); }
    if (!snap?.data?.redirect_url) return { success: false, http: 502, message: 'Midtrans response tidak valid' };
    await topup.update({
      gateway_provider: 'midtrans', gateway_ref: merchantRef,
      payment_url: snap.data.redirect_url, expires_at: new Date(Date.now() + 86400000)
    });
    return { success: true, mode: 'midtrans', payment_url: snap.data.redirect_url, snap_token: snap.data.token, ref: merchantRef };
  }

  // ── Xendit ──────────────────────────────────────────────────
  if (provider === 'xendit') {
    if (!gwKey.startsWith('xnd_')) return { success: false, http: 400, message: 'Secret Key Xendit tidak valid.' };
    const payload = {
      external_id: merchantRef, amount,
      description: `Top-up Saldo Reseller ${reseller.code}`,
      customer: { given_names: custName, email: custEmail, mobile_number: custPhone || undefined },
      success_redirect_url: finishUrl, currency: 'IDR'
    };
    const auth = Buffer.from(gwKey + ':').toString('base64');
    let xen;
    try {
      xen = await axios.post('https://api.xendit.co/v2/invoices', payload, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (e) { return mapErr('Xendit', e); }
    if (!xen?.data?.invoice_url) return { success: false, http: 502, message: 'Xendit response tidak valid' };
    await topup.update({
      gateway_provider: 'xendit', gateway_ref: merchantRef,
      payment_url: xen.data.invoice_url, expires_at: new Date(Date.now() + 86400000)
    });
    return { success: true, mode: 'xendit', payment_url: xen.data.invoice_url, ref: merchantRef };
  }

  // ── Duitku POP ──────────────────────────────────────────────
  if (provider === 'duitku') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    if (!merchantCode || !/^[A-Z0-9]{3,15}$/i.test(merchantCode)) {
      return { success: false, http: 400, message: 'Merchant Code Duitku tidak valid.' };
    }
    if (gwKey.length < 16) return { success: false, http: 400, message: 'API Key Duitku terlalu pendek.' };
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const inquiryUrl = isProd ? 'https://api-prod.duitku.com/api/merchant/createInvoice'
                              : 'https://api-sandbox.duitku.com/api/merchant/createInvoice';
    const ts = Date.now();
    const signature = crypto.createHmac('sha256', gwKey)
      .update(merchantCode + ts).digest('hex');
    const payload = {
      paymentAmount: amount, merchantOrderId: merchantRef,
      productDetails: 'Top-up Saldo Reseller', email: custEmail,
      customerVaName: custName, phoneNumber: custPhone || '',
      callbackUrl: `${callbackBase}/duitku`, returnUrl: finishUrl,
      expiryPeriod: 60
    };
    let duk;
    try {
      duk = await axios.post(inquiryUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-duitku-signature': signature,
          'x-duitku-timestamp': String(ts),
          'x-duitku-merchantcode': merchantCode
        }, timeout: 15000
      });
    } catch (e) { return mapErr('Duitku', e); }
    const url = duk?.data?.paymentUrl;
    if (!url) return { success: false, http: 502, message: 'Duitku response tidak valid' };
    await topup.update({
      gateway_provider: 'duitku', gateway_ref: merchantRef,
      payment_url: url, expires_at: new Date(Date.now() + 3600000)
    });
    return { success: true, mode: 'duitku', payment_url: url, ref: merchantRef };
  }

  return { success: false, http: 400, message: 'Provider gateway tidak dikenali' };
}

function mapErr(name, e) {
  const status = e.response?.status;
  const body = e.response?.data;
  const msg = (body && (body.message || body.Message)) || e.message || 'gateway error';
  logger.error(`[ResellerTopup] ${name} error (${status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  return { success: false, http: 502, message: `${name}: ${typeof msg === 'string' ? msg : 'gagal membuat transaksi'}` };
}

// Cari topup dari merchant_ref (RTOP-{id}-{ts}).
function parseTopupId(ref) {
  const m = String(ref || '').match(/^RTOP-(\d+)-\d+$/);
  return m ? parseInt(m[1]) : null;
}

module.exports = {
  getSetting,
  getTopupConfig,
  creditTopup,
  createGatewayTopup,
  parseTopupId
};
