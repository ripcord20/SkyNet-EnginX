/**
 * PublicVoucherService.js — Logika pembelian voucher hotspot dari halaman publik.
 * ─────────────────────────────────────────────────────────────────────────────
 * Dipakai oleh PublicVoucherController (route /beli-voucher & /pub/voucher/*).
 *
 * Tanggung jawab:
 *   - listPublicPackages()         → paket voucher yang ditandai is_public
 *   - createOrder()                → buat PublicVoucherOrder (status pending)
 *   - createVoucherGatewayTxn()    → transaksi gateway (midtrans/duitku/tripay)
 *                                    dengan order_id berformat VPO-{id}-{ts}
 *   - fulfillOrder()               → generate voucher di MikroTik + kirim WA/Email
 *   - buildPaymentConfig()         → reuse dari PublicPaymentService
 *
 * KRITIS — fulfillOrder bersifat IDEMPOTEN: kalau order sudah 'delivered',
 * tidak generate voucher baru (cegah double-generate dari webhook ganda).
 */
const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const {
  sequelize, PublicVoucherOrder, ResellerVoucherPackage, AppSetting
} = require('../models');
const HotspotService = require('./HotspotService');
const { getMikrotikInstanceByDevice } = require('./MikrotikService');
const EmailService = require('./EmailService');
const PublicPaymentService = require('./PublicPaymentService');
const logger = require('../utils/logger');

// Ambil setting dari app_settings (reuse helper PublicPaymentService).
const getSetting = PublicPaymentService.getSetting;

// ── Harga jual publik efektif untuk satu paket ──────────────────────
function publicPriceOf(pkg) {
  const pub = Number(pkg.public_price);
  if (Number.isFinite(pub) && pub > 0) return pub;
  return Number(pkg.sell_price) || Number(pkg.cost_price) || 0;
}

// ── Daftar paket yang boleh dibeli publik ───────────────────────────
async function listPublicPackages() {
  const rows = await ResellerVoucherPackage.findAll({
    where: { is_active: true, is_public: true },
    order: [['sort_order', 'ASC'], ['id', 'ASC']]
  });
  return rows.map(p => ({
    id: p.id,
    name: p.name,
    duration_label: p.duration_label || '',
    price: publicPriceOf(p)
  }));
}

// ── Generate kode order unik (VC-XXXXXX) ────────────────────────────
function genOrderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `VC-${rnd}`;
}

// ── Buat order baru (status pending) ────────────────────────────────
async function createOrder({ package_id, buyer_name, buyer_email, buyer_wa, payment_method }) {
  const pkg = await ResellerVoucherPackage.findByPk(package_id);
  if (!pkg || !pkg.is_active || !pkg.is_public) {
    return { success: false, http: 404, message: 'Paket tidak tersedia.' };
  }
  const amount = publicPriceOf(pkg);
  if (amount <= 0) {
    return { success: false, http: 400, message: 'Harga paket belum diatur. Hubungi admin.' };
  }

  // Kode order unik — retry kalau bentrok.
  let order_code = genOrderCode();
  for (let i = 0; i < 5; i++) {
    const exists = await PublicVoucherOrder.findOne({ where: { order_code } });
    if (!exists) break;
    order_code = genOrderCode();
  }

  const order = await PublicVoucherOrder.create({
    order_code,
    package_id: pkg.id,
    package_name: pkg.name,
    amount,
    buyer_name: String(buyer_name || '').slice(0, 120),
    buyer_email: buyer_email ? String(buyer_email).slice(0, 160) : null,
    buyer_wa: buyer_wa ? normalizeWa(buyer_wa) : null,
    payment_method: payment_method === 'manual' ? 'manual' : 'gateway',
    status: 'pending'
  });
  return { success: true, order, package: pkg };
}

// Normalisasi nomor WA Indonesia → format 62xxxx.
function normalizeWa(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('8')) n = '62' + n;
  else if (n.startsWith('620')) n = '62' + n.slice(3);
  return n;
}

// ── Transaksi gateway untuk order voucher (VPO-{id}-{ts}) ───────────
// Mirror dari PublicPaymentService.createGatewayTransaction tapi untuk
// order voucher (bukan invoice). order_id pakai prefix VPO supaya webhook
// terpusat bisa merutekan ke PublicVoucherWebhookController.
async function createVoucherGatewayTxn({ order, tripayMethod, baseUrl }) {
  const gwEnabled = await getSetting('payment_gateway_enabled', 'false');
  if (!(gwEnabled === 'true' || gwEnabled === '1')) {
    return { success: false, http: 400, message: 'Pembayaran online belum aktif. Pilih transfer manual.' };
  }
  const gwProvider  = await getSetting('payment_gateway_provider', 'midtrans');
  const gwKey       = await getSetting('payment_gateway_server_key', '');
  const gwClientKey = await getSetting('payment_gateway_client_key', '');
  if (!gwKey) return { success: false, http: 400, message: 'Pembayaran online belum dikonfigurasi.' };

  const amount = Math.round(Number(order.amount));
  const refBase = `VPO-${order.id}-${Date.now()}`;
  const finishUrl = `${baseUrl}/beli-voucher/status/${order.order_code}`;
  const itemName = `Voucher ${order.package_name}`.slice(0, 50);

  // Pecah nama pembeli → first/last untuk gateway.
  const parts = String(order.buyer_name || 'Pembeli').trim().split(/\s+/);
  const firstName = parts[0] || 'Pembeli';
  const lastName = parts.slice(1).join(' ');
  const email = order.buyer_email || 'noreply@example.com';
  const phone = order.buyer_wa || '';

  // ── Midtrans Snap ──
  if (gwProvider === 'midtrans') {
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    if (!/^(SB-)?Mid-server-/.test(gwKey)) {
      return { success: false, http: 400, message: 'Server Key Midtrans tidak valid.' };
    }
    const snapUrl = isProd
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';
    const payload = {
      transaction_details: { order_id: refBase, gross_amount: amount },
      customer_details: { first_name: firstName, last_name: lastName || undefined, email, phone: phone || undefined },
      item_details: [{ id: `vpkg-${order.package_id}`, price: amount, quantity: 1, name: itemName }],
      callbacks: { finish: finishUrl }
    };
    const auth = Buffer.from(gwKey + ':').toString('base64');
    let snap;
    try {
      snap = await axios.post(snapUrl, payload, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000
      });
    } catch (e) { return mapErr('Midtrans', e); }
    if (!snap?.data?.token) return { success: false, http: 502, message: 'Midtrans: snap_token kosong' };
    await order.update({ gateway_provider: 'midtrans', gateway_ref: refBase });
    return {
      success: true, mode: 'midtrans',
      snap_token: snap.data.token, snap_url: snap.data.redirect_url,
      client_key: gwClientKey, env: isProd ? 'production' : 'sandbox', order_code: order.order_code
    };
  }

  // ── Duitku POP ──
  if (gwProvider === 'duitku') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    if (!merchantCode || !/^[A-Z0-9]{3,15}$/i.test(merchantCode)) {
      return { success: false, http: 400, message: 'Merchant Code Duitku tidak valid.' };
    }
    if (gwKey.length < 16) return { success: false, http: 400, message: 'API Key Duitku terlalu pendek.' };
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const inquiryUrl = isProd
      ? 'https://api-prod.duitku.com/api/merchant/createInvoice'
      : 'https://api-sandbox.duitku.com/api/merchant/createInvoice';
    const billingAddress = {
      firstName, lastName: lastName || '', address: 'N/A', city: 'Indonesia',
      postalCode: '00000', phone: phone || '', countryCode: 'ID'
    };
    const payload = {
      paymentAmount: amount, merchantOrderId: refBase,
      productDetails: itemName, email, phoneNumber: phone || '', additionalParam: '',
      customerVaName: firstName.slice(0, 20),
      callbackUrl: `${baseUrl}/pub/voucher/webhook/duitku`,
      returnUrl: finishUrl, expiryPeriod: 60,
      customerDetail: { firstName, lastName: lastName || '', email, phoneNumber: phone || '', billingAddress, shippingAddress: billingAddress },
      itemDetails: [{ name: itemName, price: amount, quantity: 1 }]
    };
    const ts = Date.now().toString();
    const sig = crypto.createHash('sha256').update(merchantCode + ts + gwKey).digest('hex');
    let duk;
    try {
      duk = await axios.post(inquiryUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'x-duitku-merchantcode': merchantCode, 'x-duitku-timestamp': ts, 'x-duitku-signature': sig },
        timeout: 15000
      });
    } catch (e) { return mapErr('Duitku', e); }
    const d = duk?.data || {};
    if (d.statusCode && d.statusCode !== '00') {
      return { success: false, http: 400, message: `Duitku: ${d.statusMessage || 'gagal'} (${d.statusCode})` };
    }
    if (!d.paymentUrl || !d.reference) return { success: false, http: 502, message: 'Duitku response tidak valid' };
    await order.update({ gateway_provider: 'duitku', gateway_ref: refBase, gateway_reference: d.reference });
    return { success: true, mode: 'duitku', payment_url: d.paymentUrl, order_code: order.order_code };
  }

  // ── Tripay (Closed Transaction) ──
  if (gwProvider === 'tripay') {
    const merchantCode = await getSetting('payment_gateway_merchant_code', '');
    const privateKey   = await getSetting('payment_gateway_private_key', '');
    if (!merchantCode) return { success: false, http: 400, message: 'Merchant Code Tripay belum diisi.' };
    if (!privateKey || privateKey.length < 16) return { success: false, http: 400, message: 'Private Key Tripay belum diisi.' };
    const method = (tripayMethod || '').toString().trim();
    if (!method) return { success: false, http: 400, code: 'TRIPAY_METHOD_REQUIRED', message: 'Pilih metode pembayaran dahulu.' };
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const apiBase = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
    const signature = crypto.createHmac('sha256', privateKey).update(merchantCode + refBase + amount).digest('hex');
    const payload = {
      method, merchant_ref: refBase, amount,
      customer_name: String(order.buyer_name || 'Pembeli').slice(0, 50),
      customer_email: email, customer_phone: phone || '',
      order_items: [{ sku: `VPKG-${order.package_id}`, name: itemName, price: amount, quantity: 1 }],
      callback_url: `${baseUrl}/pub/voucher/webhook/tripay`,
      return_url: finishUrl,
      expired_time: Math.floor(Date.now() / 1000) + 3600,
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
    await order.update({ gateway_provider: 'tripay', gateway_ref: refBase, gateway_reference: tBody.data.reference });
    return { success: true, mode: 'tripay', payment_url: tBody.data.checkout_url, order_code: order.order_code };
  }

  return { success: false, http: 400, message: 'Provider gateway tidak dikenali' };
}

function mapErr(name, e) {
  if (e.response) {
    const d = e.response.data;
    const msg = d?.message || d?.Message || (d?.error_messages?.join(', ')) || e.message;
    logger.error(`[PubVoucher] ${name} ${e.response.status}: ${JSON.stringify(d)}`);
    return { success: false, http: 400, message: `${name}: ${msg}` };
  }
  logger.error(`[PubVoucher] ${name} error: ${e.message}`);
  return { success: false, http: 502, message: `Tidak bisa terhubung ke ${name}` };
}

// ── Tandai order paid (idempotent) lalu fulfill ─────────────────────
// Dipanggil dari webhook (gateway) atau verifikasi manual admin.
async function markPaidAndFulfill(orderId, gatewayReference) {
  const order = await PublicVoucherOrder.findByPk(orderId);
  if (!order) return { success: false, message: 'Order tidak ditemukan' };
  if (order.status === 'delivered') return { success: true, order, already: true };

  if (order.status !== 'paid') {
    await order.update({
      status: 'paid', paid_at: new Date(),
      gateway_reference: gatewayReference || order.gateway_reference
    });
    await order.reload();
  }
  return fulfillOrder(order.id);
}

// ── Generate voucher di MikroTik + kirim ke pembeli (IDEMPOTEN) ─────
async function fulfillOrder(orderId) {
  // Lock baris order supaya webhook ganda tidak generate dua kali.
  let order;
  try {
    await sequelize.transaction(async (t) => {
      order = await PublicVoucherOrder.findByPk(orderId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!order) throw new Error('Order tidak ditemukan');
      if (order.status === 'delivered') { order = null; return; } // sudah selesai
      if (order.status === 'pending') throw new Error('Order belum dibayar');
      // Tandai "sedang diproses" dengan tetap status paid; voucher diisi di luar txn.
    });
  } catch (e) {
    if (/sudah dibayar|belum dibayar/i.test(e.message)) {
      return { success: false, message: e.message };
    }
    logger.error('[PubVoucher] fulfill lock error:', e.message);
    return { success: false, message: e.message };
  }
  if (!order) {
    const fresh = await PublicVoucherOrder.findByPk(orderId);
    return { success: true, order: fresh, already: true };
  }

  // Sudah punya voucher tersimpan (mis. generate sukses tapi kirim gagal) →
  // jangan generate ulang, cukup kirim ulang.
  let voucher = null;
  if (order.voucher_username) {
    voucher = { username: order.voucher_username, password: order.voucher_password, profile: order.voucher_profile };
  } else {
    const pkg = await ResellerVoucherPackage.findByPk(order.package_id);
    if (!pkg) {
      await order.update({ status: 'failed', notes: 'Paket tidak ditemukan saat fulfill' });
      return { success: false, message: 'Paket tidak ditemukan' };
    }
    try {
      const mt = await getMikrotikInstanceByDevice(pkg.device_id || null);
      const svc = new HotspotService(mt);
      const comment =
        `Public order ${order.order_code} | ${order.buyer_name}` +
        ` | Rp ${Number(order.amount).toLocaleString('id-ID')}`;
      const result = await svc.generateVouchers({
        count: 1,
        profile: pkg.mikrotik_profile,
        server: 'all',
        prefix: pkg.prefix || 'v',
        passwordLength: pkg.code_length || 5,
        comment,
        limitUptime: pkg.limit_uptime || '',
        limitBytesTotal: Number(pkg.limit_bytes_total) || 0,
        price: Number(order.amount),
        soldTo: order.buyer_wa || ''
      });
      voucher = (result.vouchers || [])[0];
      if (!voucher) throw new Error('Router tidak mengembalikan voucher');
      await order.update({
        voucher_username: voucher.username,
        voucher_password: voucher.password,
        voucher_profile: voucher.profile || pkg.mikrotik_profile
      });
    } catch (e) {
      logger.error(`[PubVoucher] generate gagal order ${order.order_code}:`, e.message);
      await order.update({ notes: 'Generate voucher gagal: ' + e.message });
      return { success: false, message: 'Gagal membuat voucher di router: ' + e.message };
    }
  }

  // Kirim ke pembeli (WA + Email, best-effort).
  const sent = await deliverVoucher(order, voucher);

  await order.update({
    status: 'delivered',
    delivered_at: new Date(),
    delivered_wa: sent.wa,
    delivered_email: sent.email
  });
  await order.reload();

  // Notifikasi Telegram (event bisnis) — fire-and-forget.
  try {
    const buyer = [order.buyer_name, order.buyer_wa].filter(Boolean).join(' · ') || null;
    const methodLabel = order.payment_method === 'gateway' ? 'Gateway (otomatis)'
                       : order.payment_method === 'manual' ? 'Transfer manual'
                       : (order.payment_method || null);
    require('./TelegramEvents').voucherSold({
      count: 1,
      amount: Number(order.amount),
      packageName: order.package_name || null,
      buyer,
      method: methodLabel,
      orderCode: order.order_code || null,
      soldAt: order.delivered_at || new Date(),
    }).catch(() => {});
  } catch (_) {}

  return { success: true, order, voucher, delivery: sent };
}

// ── Kirim info voucher ke WA & Email pembeli ────────────────────────
async function deliverVoucher(order, voucher) {
  const result = { wa: false, email: false };
  const companyName = await getSetting('company_name', 'ISP');
  const loginUrl = await getSetting('hotspot_login_url', '');

  const lines = [
    `🎉 *Voucher WiFi Anda Siap!*`,
    ``,
    `Halo *${order.buyer_name}*, terima kasih sudah membeli.`,
    ``,
    `📦 Paket   : ${order.package_name}`,
    `🔑 Username : ${voucher.username}`,
    `🔒 Password : ${voucher.password}`,
    `🧾 Order    : ${order.order_code}`,
  ];
  if (loginUrl) lines.push(``, `🌐 Login di: ${loginUrl}`);
  lines.push(``, `Simpan pesan ini ya. Terima kasih 🙏\n— ${companyName}`);
  const waMsg = lines.join('\n');

  // WhatsApp via GatewayService (session default).
  if (order.buyer_wa) {
    try {
      const GatewayService = require('./GatewayService');
      const session = await GatewayService.getDefaultSendingSession();
      if (session) {
        await GatewayService.warmSession(session.session_id);
        if (GatewayService.isConnected(session.session_id)) {
          await GatewayService.sendMessage(session.session_id, order.buyer_wa, waMsg, null);
          result.wa = true;
        }
      }
    } catch (e) { logger.warn('[PubVoucher] kirim WA gagal:', e.message); }
  }

  // Email via EmailService — isi (subject/intro/outro) dari Email Template "voucher_delivery".
  if (order.buyer_email) {
    try {
      const EmailTpl = require('./EmailTemplateService');
      if (await EmailTpl.isEnabled('voucher_delivery')) {
        const cfg = await EmailTpl.getConfig('voucher_delivery');
        const accent = /^#[0-9a-fA-F]{3,8}$/.test(cfg.accent || '') ? cfg.accent : '#1f8bff';
        const vars = {
          nama: order.buyer_name || 'Pembeli',
          order: order.order_code || '',
          paket: order.package_name || '-',
          jumlah: 'Rp ' + Number(order.amount).toLocaleString('id-ID'),
          username: voucher.username,
          password: voucher.password,
          perusahaan: companyName || 'ISP'
        };
        // Kartu kredensial + tabel order sebagai blok khusus (tetap kaya tampilannya).
        const loginBtn = loginUrl
          ? `<div style="text-align:center;margin:4px 0 2px;">
               <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-size:13px;font-weight:bold;padding:11px 24px;border-radius:10px;">Login WiFi Sekarang →</a>
             </div>` : '';
        const bodyExtra = `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1.5px solid #dbe6ff;border-radius:12px;overflow:hidden;margin-bottom:12px;">
            <tr><td style="background:#f4f8ff;padding:11px 18px;border-bottom:1px solid #e6eeff;">
              <span style="font-size:11px;letter-spacing:1px;color:#6b7fa8;text-transform:uppercase;font-weight:bold;">Kode Login Voucher</span>
            </td></tr>
            <tr><td style="padding:6px 18px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding:12px 0;border-bottom:1px dashed #e6eef9;font-size:13px;color:#8a95ad;">Username</td>
                    <td align="right" style="padding:12px 0;border-bottom:1px dashed #e6eef9;font-family:'Courier New',monospace;font-size:18px;font-weight:bold;color:${accent};letter-spacing:1px;">${escapeHtml(voucher.username)}</td></tr>
                <tr><td style="padding:12px 0;font-size:13px;color:#8a95ad;">Password</td>
                    <td align="right" style="padding:12px 0;font-family:'Courier New',monospace;font-size:18px;font-weight:bold;color:${accent};letter-spacing:1px;">${escapeHtml(voucher.password)}</td></tr>
              </table>
            </td></tr>
          </table>
          ${loginBtn}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8eef9;border-radius:10px;overflow:hidden;margin-top:12px;">
            <tr style="background:#f8faff;"><td style="padding:9px 14px;font-size:13px;color:#6b7fa8;">Paket</td>
                <td align="right" style="padding:9px 14px;font-size:13px;font-weight:bold;color:#1f2937;">${escapeHtml(order.package_name || '-')}</td></tr>
            <tr><td style="padding:9px 14px;font-size:13px;color:#6b7fa8;border-top:1px solid #eef3fb;">No. Order</td>
                <td align="right" style="padding:9px 14px;font-size:13px;font-weight:bold;color:#1f2937;border-top:1px solid #eef3fb;font-family:'Courier New',monospace;">${escapeHtml(order.order_code)}</td></tr>
            <tr style="background:#f8faff;"><td style="padding:9px 14px;font-size:13px;color:#6b7fa8;border-top:1px solid #eef3fb;">Total Bayar</td>
                <td align="right" style="padding:9px 14px;font-size:14px;font-weight:bold;color:#16a34a;border-top:1px solid #eef3fb;">Rp ${Number(order.amount).toLocaleString('id-ID')}</td></tr>
          </table>`;
        const built = await EmailTpl.render('voucher_delivery', vars, { companyName: vars.perusahaan, bodyExtraHtml: bodyExtra });
        const ok = await EmailService.send({
          to: order.buyer_email,
          subject: built.subject,
          html: built.html,
          text: waMsg.replace(/\*/g, ''),
          type: 'voucher_delivery'
        });
        result.email = !!ok;
      }
    } catch (e) { logger.warn('[PubVoucher] kirim Email gagal:', e.message); }
  }
  return result;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Notifikasi admin: order manual menunggu verifikasi (best-effort) ─
async function notifyAdminManualOrder(order) {
  try {
    const companyWa = (await getSetting('company_whatsapp', '') || '').replace(/[^0-9]/g, '');
    if (!companyWa) return null;
    const appUrl = (process.env.APP_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
    const msg =
      `🔔 *Order Voucher Baru (Manual)*\n\n` +
      `Order   : ${order.order_code}\n` +
      `Paket   : ${order.package_name}\n` +
      `Jumlah  : Rp ${Number(order.amount).toLocaleString('id-ID')}\n` +
      `Pembeli : ${order.buyer_name}\n` +
      `WA      : ${order.buyer_wa || '-'}\n` +
      `Email   : ${order.buyer_email || '-'}\n\n` +
      `Verifikasi di dashboard → Reseller/Voucher → Order Publik.`;
    const GatewayService = require('./GatewayService');
    const session = await GatewayService.getDefaultSendingSession();
    if (session) {
      await GatewayService.warmSession(session.session_id);
      if (GatewayService.isConnected(session.session_id)) {
        await GatewayService.sendMessage(session.session_id, companyWa, msg, null);
      }
    }
    return null;
  } catch (e) { logger.warn('[PubVoucher] notify admin gagal:', e.message); return null; }
}

// ── URL WhatsApp konfirmasi pembayaran manual (pembeli → admin) ──────
async function buildManualConfirmWaUrl(order) {
  const companyName = await getSetting('company_name', 'ISP');
  const companyWa = (await getSetting('company_whatsapp', '') || '').replace(/[^0-9]/g, '');
  const text = encodeURIComponent(
    `*Konfirmasi Pembayaran Voucher*\n\n` +
    `Halo ${companyName}, saya sudah transfer untuk:\n\n` +
    `📦 Paket   : ${order.package_name}\n` +
    `💰 Jumlah  : Rp ${Number(order.amount).toLocaleString('id-ID')}\n` +
    `🧾 No Order : ${order.order_code}\n` +
    `👤 Nama    : ${order.buyer_name}\n\n` +
    `Mohon diverifikasi & voucher dikirim. Terima kasih 🙏`
  );
  return companyWa ? `https://wa.me/${companyWa}?text=${text}` : null;
}

// ── Cek status pembayaran langsung ke gateway (untuk auto-deliver tanpa webhook).
// Dipanggil dari endpoint status publik saat order gateway masih pending/paid.
// Kalau gateway bilang LUNAS → markPaidAndFulfill (generate + kirim voucher).
// Return: { paid:boolean, fulfilled:boolean } | null (kalau tak bisa dicek).
async function checkGatewayStatus(order) {
  try {
    if (!order || order.status === 'delivered') return { paid: true, fulfilled: true };
    if (order.payment_method !== 'gateway' || !order.gateway_ref) return null;

    const provider = order.gateway_provider || await getSetting('payment_gateway_provider', 'midtrans');
    const isProd = (await getSetting('payment_gateway_env', 'sandbox')) === 'production';
    const serverKey = await getSetting('payment_gateway_server_key', '');
    const ref = order.gateway_ref; // VPO-{id}-{ts}

    let paid = false;

    if (provider === 'midtrans') {
      if (!serverKey) return null;
      const base = isProd ? 'https://api.midtrans.com/v2' : 'https://api.sandbox.midtrans.com/v2';
      const auth = Buffer.from(serverKey + ':').toString('base64');
      const r = await axios.get(`${base}/${encodeURIComponent(ref)}/status`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, timeout: 12000,
        validateStatus: () => true
      });
      const st = r.data && r.data.transaction_status;
      const fraud = r.data && r.data.fraud_status;
      paid = (st === 'settlement' || st === 'capture') && (!fraud || fraud === 'accept');
      if (['expire', 'cancel', 'deny'].includes(st) && order.status === 'pending') {
        await order.update({ status: 'expired' });
        return { paid: false, fulfilled: false };
      }
    } else if (provider === 'duitku') {
      const merchantCode = await getSetting('payment_gateway_merchant_code', '');
      const apiKey = serverKey;
      if (!merchantCode || !apiKey) return null;
      const base = isProd ? 'https://passport.duitku.com/webapi/api/merchant/transactionStatus'
                          : 'https://sandbox.duitku.com/webapi/api/merchant/transactionStatus';
      const sig = crypto.createHash('md5').update(merchantCode + ref + apiKey).digest('hex');
      const r = await axios.post(base, { merchantCode, merchantOrderId: ref, signature: sig }, {
        headers: { 'Content-Type': 'application/json' }, timeout: 12000, validateStatus: () => true
      });
      const code = r.data && r.data.statusCode;
      paid = String(code) === '00';
      if (String(code) === '02' && order.status === 'pending') { await order.update({ status: 'expired' }); return { paid:false, fulfilled:false }; }
    } else if (provider === 'tripay') {
      const apiKey = serverKey;
      if (!apiKey) return null;
      const base = isProd ? 'https://tripay.co.id/api' : 'https://tripay.co.id/api-sandbox';
      const r = await axios.get(`${base}/transaction/detail`, {
        params: { reference: order.gateway_reference || '' },
        headers: { Authorization: `Bearer ${apiKey}` }, timeout: 12000, validateStatus: () => true
      });
      const st = r.data && r.data.data && String(r.data.data.status || '').toUpperCase();
      paid = st === 'PAID';
      if (['EXPIRED', 'FAILED'].includes(st) && order.status === 'pending') { await order.update({ status:'expired' }); return { paid:false, fulfilled:false }; }
    } else {
      return null;
    }

    if (paid) {
      const r = await markPaidAndFulfill(order.id, order.gateway_reference || ref);
      return { paid: true, fulfilled: !!(r && r.success) };
    }
    return { paid: false, fulfilled: false };
  } catch (e) {
    logger.warn('[PubVoucher] checkGatewayStatus error:', e.message);
    return null;
  }
}

module.exports = {
  getSetting,
  publicPriceOf,
  listPublicPackages,
  createOrder,
  createVoucherGatewayTxn,
  markPaidAndFulfill,
  fulfillOrder,
  deliverVoucher,
  notifyAdminManualOrder,
  buildManualConfirmWaUrl,
  checkGatewayStatus,
  normalizeWa
};
