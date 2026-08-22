/**
 * PublicVoucherWebhookController.js — Callback gateway untuk ORDER VOUCHER publik.
 * ─────────────────────────────────────────────────────────────────────────────
 * Order voucher publik memakai order_id/merchant_ref berformat VPO-{id}-{ts}.
 *
 * Midtrans punya SATU Notification URL global → di-route dari
 * CustomerPortalController.midtransNotif berdasarkan prefix VPO-.
 * Duitku & Tripay punya callbackUrl/callback_url sendiri yang menunjuk ke
 * /pub/voucher/webhook/{provider}, tapi juga dirutekan dari handler portal
 * sebagai jaring pengaman.
 *
 * Tiap handler:
 *   1. Verifikasi signature (mekanisme identik webhook invoice/topup).
 *   2. Resolve order dari ref (VPO-{id}-{ts}).
 *   3. Status PAID → PublicVoucherService.markPaidAndFulfill() (idempotent):
 *      generate voucher di MikroTik + kirim ke WA/Email pembeli.
 */
const crypto = require('crypto');
const { PublicVoucherOrder } = require('../models');
const PublicVoucherService = require('../services/PublicVoucherService');
const logger = require('../utils/logger');

const getSetting = PublicVoucherService.getSetting;

// Parse order id dari ref "VPO-{id}-{ts}".
function parseOrderId(ref) {
  const m = String(ref || '').match(/^VPO-(\d+)-\d+$/);
  return m ? parseInt(m[1], 10) : null;
}
async function resolveOrder(ref) {
  const id = parseOrderId(ref);
  if (!id) return null;
  return PublicVoucherOrder.findByPk(id);
}

const PublicVoucherWebhookController = {

  // ── Midtrans (dipanggil dari midtransNotif via prefix VPO-) ─────
  async midtrans(req, res) {
    try {
      const { order_id, transaction_status, fraud_status, status_code, gross_amount, signature_key } = req.body || {};
      const serverKey = await getSetting('payment_gateway_server_key', '');
      if (!serverKey) return res.status(500).json({ success: false, message: 'Gateway not configured' });

      const expected = crypto.createHash('sha512')
        .update(`${order_id}${status_code}${gross_amount}${serverKey}`).digest('hex');
      if (String(signature_key || '').toLowerCase() !== expected.toLowerCase()) {
        logger.warn('[PubVoucher] Midtrans webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }

      const order = await resolveOrder(order_id);
      if (!order) return res.status(200).json({ success: true, ignored: true });
      if (order.status === 'delivered') return res.status(200).json({ success: true });

      const settled = (transaction_status === 'settlement' || transaction_status === 'capture');
      const fraudOk = (!fraud_status || fraud_status === 'accept');
      if (settled && fraudOk) {
        const cb = Math.round(parseFloat(gross_amount || 0));
        const exp = Math.round(Number(order.amount));
        if (cb && cb !== exp) {
          logger.error(`[PubVoucher] Midtrans amount mismatch ${order.order_code} (cb=${cb}, exp=${exp})`);
          return res.status(400).json({ success: false, message: 'Amount mismatch' });
        }
        await PublicVoucherService.markPaidAndFulfill(order.id, order_id);
        logger.info(`[PubVoucher] Midtrans settle → fulfilled ${order.order_code}`);
      } else if (['expire', 'cancel', 'deny'].includes(transaction_status)) {
        if (order.status === 'pending') await order.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[PubVoucher] Midtrans webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  },

  // ── Tripay ──────────────────────────────────────────────────
  async tripay(req, res) {
    try {
      const privateKey = await getSetting('payment_gateway_private_key', '');
      if (!privateKey) return res.status(500).json({ success: false, message: 'Gateway not configured' });

      const rawBody = req.rawBody || JSON.stringify(req.body || {});
      const incomingSig = req.headers['x-callback-signature'] || '';
      const expectedSig = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');
      if (String(incomingSig).toLowerCase() !== expectedSig.toLowerCase()) {
        logger.warn('[PubVoucher] Tripay webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }
      const event = req.headers['x-callback-event'] || '';
      if (event && event !== 'payment_status') return res.status(200).json({ success: true });

      const b = req.body || {};
      const order = await resolveOrder(b.merchant_ref);
      if (!order) return res.status(200).json({ success: true, ignored: true });
      if (order.status === 'delivered') return res.status(200).json({ success: true });

      const status = String(b.status || '').toUpperCase();
      if (status === 'PAID') {
        // Tripay: total_amount termasuk fee customer (Alfamart/VA) → jangan validasi langsung.
        // Cocok bila salah satu dari amount / amount_received / total_amount == expected.
        const exp = Math.round(Number(order.amount));
        const cbA = Math.round(parseFloat(b.amount || 0));
        const cbR = Math.round(parseFloat(b.amount_received || 0));
        const cbT = Math.round(parseFloat(b.total_amount || 0));
        const present = cbA || cbR || cbT;
        const matched = [cbA, cbR, cbT].some(v => v && v === exp);
        if (present && !matched) {
          logger.error(`[PubVoucher] Tripay amount mismatch ${order.order_code} (amount=${cbA}, received=${cbR}, total=${cbT}, exp=${exp})`);
          return res.status(400).json({ success: false, message: 'Amount mismatch' });
        }
        await PublicVoucherService.markPaidAndFulfill(order.id, b.reference);
        logger.info(`[PubVoucher] Tripay PAID → fulfilled ${order.order_code}`);
      } else if (['EXPIRED', 'FAILED', 'REFUND'].includes(status)) {
        if (order.status === 'pending') await order.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[PubVoucher] Tripay webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  },

  // ── Duitku ──────────────────────────────────────────────────
  async duitku(req, res) {
    try {
      const apiKey = await getSetting('payment_gateway_server_key', '');
      const merchantCode = await getSetting('payment_gateway_merchant_code', '');
      const b = req.body || {};
      const expected = crypto.createHash('md5')
        .update(String(merchantCode) + String(b.amount) + String(b.merchantOrderId) + String(apiKey)).digest('hex');
      if (String(b.signature || '').toLowerCase() !== expected.toLowerCase()) {
        logger.warn('[PubVoucher] Duitku webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }
      const order = await resolveOrder(b.merchantOrderId);
      if (!order) return res.status(200).json({ success: true, ignored: true });
      if (order.status === 'delivered') return res.status(200).json({ success: true });

      if (String(b.resultCode) === '00') {
        const cb = Math.round(parseFloat(b.amount || 0));
        const exp = Math.round(Number(order.amount));
        if (cb && cb !== exp) return res.status(400).json({ success: false, message: 'Amount mismatch' });
        await PublicVoucherService.markPaidAndFulfill(order.id, b.reference);
        logger.info(`[PubVoucher] Duitku success → fulfilled ${order.order_code}`);
      } else if (String(b.resultCode) === '01') {
        // pending — biarkan
      } else {
        if (order.status === 'pending') await order.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[PubVoucher] Duitku webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  }
};

module.exports = PublicVoucherWebhookController;
