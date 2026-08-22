/**
 * ResellerWebhookController.js — Callback gateway untuk TOP-UP saldo reseller.
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider mem-POST ke /reseller/webhook/{provider}. Tiap handler:
 *   1. Verifikasi signature (sama mekanisme dengan webhook invoice).
 *   2. Resolve top-up dari merchant_ref/order_id (format RTOP-{id}-{ts}).
 *   3. Kalau status PAID → ResellerTopupService.creditTopup() (atomik, idempotent).
 *
 * Saldo BERTAMBAH OTOMATIS tanpa campur tangan admin untuk jalur gateway.
 */
const crypto = require('crypto');
const { ResellerTopup } = require('../models');
const ResellerTopupService = require('../services/ResellerTopupService');
const logger = require('../utils/logger');

async function getSetting(key, fallback = null) {
  return ResellerTopupService.getSetting(key, fallback);
}

// Resolve topup row dari ref. Mengembalikan { topup, id } atau null.
async function resolveTopup(ref) {
  const id = ResellerTopupService.parseTopupId(ref);
  if (!id) return null;
  const topup = await ResellerTopup.findByPk(id);
  return topup ? { topup, id } : null;
}

const ResellerWebhookController = {

  // ── Tripay ──────────────────────────────────────────────────
  async tripay(req, res) {
    try {
      const privateKey = await getSetting('payment_gateway_private_key', '');
      if (!privateKey) return res.status(500).json({ success: false, message: 'Gateway not configured' });

      const rawBody = req.rawBody || JSON.stringify(req.body || {});
      const incomingSig = req.headers['x-callback-signature'] || '';
      const expectedSig = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');
      if (String(incomingSig).toLowerCase() !== expectedSig.toLowerCase()) {
        logger.warn('[ResellerTopup] Tripay webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }
      const event = req.headers['x-callback-event'] || '';
      if (event && event !== 'payment_status') return res.status(200).json({ success: true });

      const b = req.body || {};
      const found = await resolveTopup(b.merchant_ref);
      if (!found) {
        // Bukan ref top-up reseller (mungkin invoice). Balas 200 biar tidak retry.
        return res.status(200).json({ success: true, ignored: true });
      }
      const { topup } = found;
      if (topup.credited || topup.status === 'paid') return res.status(200).json({ success: true });

      const status = String(b.status || '').toUpperCase();
      if (status === 'PAID') {
        // Tripay: b.total_amount SUDAH termasuk fee yg dibebankan ke customer (Alfamart/VA),
        // sehingga selalu > amount utk channel berfee → JANGAN dipakai validasi langsung.
        // Cocok bila salah satu dari amount / amount_received / total_amount == expected.
        const exp = Math.round(Number(topup.amount));
        const cbA = Math.round(parseFloat(b.amount || 0));
        const cbR = Math.round(parseFloat(b.amount_received || 0));
        const cbT = Math.round(parseFloat(b.total_amount || 0));
        const present = cbA || cbR || cbT;
        const matched = [cbA, cbR, cbT].some(v => v && v === exp);
        if (present && !matched) {
          logger.error(`[ResellerTopup] Tripay amount mismatch ref=${topup.ref} (amount=${cbA}, received=${cbR}, total=${cbT}, exp=${exp})`);
          return res.status(400).json({ success: false, message: 'Amount mismatch' });
        }
        await ResellerTopupService.creditTopup(topup.id);
        logger.info(`[ResellerTopup] Tripay PAID → credited ${topup.ref}`);
      } else if (['EXPIRED', 'FAILED', 'REFUND'].includes(status)) {
        await topup.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[ResellerTopup] Tripay webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  },

  // ── Midtrans ────────────────────────────────────────────────
  async midtrans(req, res) {
    try {
      const serverKey = await getSetting('payment_gateway_server_key', '');
      const b = req.body || {};
      const orderId = b.order_id || '';
      // Routing terpusat: bila ini notifikasi INVOICE pelanggan (INV-...),
      // teruskan ke handler invoice. Memungkinkan satu Notification URL global
      // Midtrans melayani top-up reseller maupun invoice.
      if (/^INV-\d+-\d+$/.test(orderId)) {
        const CustomerPortalController = require('./CustomerPortalController');
        return CustomerPortalController.midtransNotif(req, res);
      }
      // Signature: sha512(order_id + status_code + gross_amount + serverKey)
      const expected = crypto.createHash('sha512')
        .update(orderId + b.status_code + b.gross_amount + serverKey).digest('hex');
      if (String(b.signature_key || '').toLowerCase() !== expected.toLowerCase()) {
        logger.warn('[ResellerTopup] Midtrans webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }
      const found = await resolveTopup(orderId);
      if (!found) return res.status(200).json({ success: true, ignored: true });
      const { topup } = found;
      if (topup.credited || topup.status === 'paid') return res.status(200).json({ success: true });

      const tStatus = String(b.transaction_status || '').toLowerCase();
      const fraud = String(b.fraud_status || 'accept').toLowerCase();
      if ((tStatus === 'capture' && fraud === 'accept') || tStatus === 'settlement') {
        const cb = Math.round(parseFloat(b.gross_amount || 0));
        const exp = Math.round(Number(topup.amount));
        if (cb && cb !== exp) return res.status(400).json({ success: false, message: 'Amount mismatch' });
        await ResellerTopupService.creditTopup(topup.id);
        logger.info(`[ResellerTopup] Midtrans settle → credited ${topup.ref}`);
      } else if (['expire', 'cancel', 'deny'].includes(tStatus)) {
        await topup.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[ResellerTopup] Midtrans webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  },

  // ── Xendit ──────────────────────────────────────────────────
  async xendit(req, res) {
    try {
      const callbackToken = await getSetting('payment_gateway_xendit_callback_token', '');
      const incoming = req.headers['x-callback-token'] || '';
      if (callbackToken && incoming !== callbackToken) {
        logger.warn('[ResellerTopup] Xendit webhook: invalid callback token');
        return res.status(403).json({ success: false, message: 'Invalid token' });
      }
      const b = req.body || {};
      const found = await resolveTopup(b.external_id);
      if (!found) return res.status(200).json({ success: true, ignored: true });
      const { topup } = found;
      if (topup.credited || topup.status === 'paid') return res.status(200).json({ success: true });

      const status = String(b.status || '').toUpperCase();
      if (status === 'PAID' || status === 'SETTLED') {
        const cb = Math.round(parseFloat(b.paid_amount || b.amount || 0));
        const exp = Math.round(Number(topup.amount));
        if (cb && cb !== exp) return res.status(400).json({ success: false, message: 'Amount mismatch' });
        await ResellerTopupService.creditTopup(topup.id);
        logger.info(`[ResellerTopup] Xendit PAID → credited ${topup.ref}`);
      } else if (status === 'EXPIRED') {
        await topup.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[ResellerTopup] Xendit webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  },

  // ── Duitku ──────────────────────────────────────────────────
  async duitku(req, res) {
    try {
      const apiKey = await getSetting('payment_gateway_server_key', '');
      const merchantCode = await getSetting('payment_gateway_merchant_code', '');
      const b = req.body || {};
      // Signature Duitku callback: md5(merchantCode + amount + merchantOrderId + apiKey)
      const expected = crypto.createHash('md5')
        .update(String(merchantCode) + String(b.amount) + String(b.merchantOrderId) + String(apiKey)).digest('hex');
      if (String(b.signature || '').toLowerCase() !== expected.toLowerCase()) {
        logger.warn('[ResellerTopup] Duitku webhook: invalid signature');
        return res.status(403).json({ success: false, message: 'Invalid signature' });
      }
      const found = await resolveTopup(b.merchantOrderId);
      if (!found) return res.status(200).json({ success: true, ignored: true });
      const { topup } = found;
      if (topup.credited || topup.status === 'paid') return res.status(200).json({ success: true });

      // resultCode '00' = success
      if (String(b.resultCode) === '00') {
        const cb = Math.round(parseFloat(b.amount || 0));
        const exp = Math.round(Number(topup.amount));
        if (cb && cb !== exp) return res.status(400).json({ success: false, message: 'Amount mismatch' });
        await ResellerTopupService.creditTopup(topup.id);
        logger.info(`[ResellerTopup] Duitku success → credited ${topup.ref}`);
      } else if (String(b.resultCode) === '01') {
        // pending — biarkan
      } else {
        await topup.update({ status: 'expired' });
      }
      return res.status(200).json({ success: true });
    } catch (e) {
      logger.error('[ResellerTopup] Duitku webhook error: ' + e.message);
      return res.status(500).json({ success: false, message: 'error' });
    }
  }
};

module.exports = ResellerWebhookController;
