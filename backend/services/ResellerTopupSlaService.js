/**
 * ResellerTopupSlaService.js — Reminder SLA verifikasi top-up manual (#3).
 * ─────────────────────────────────────────────────────────────────────────────
 * Mengecek top-up manual/QRIS yang berstatus 'waiting_verification' dan sudah
 * menggantung lebih lama dari ambang (default 2 jam). Mengirim ringkasan ke
 * admin via Telegram (bila aktif). Idempotent ringan: hanya mengingatkan sekali
 * per jam (dipanggil oleh cron tiap jam), tidak menandai DB agar tetap simpel.
 *
 * Ambang jam bisa diatur via AppSetting 'reseller_topup_sla_hours' (angka).
 */
const { Op } = require('sequelize');
const { ResellerTopup, Reseller, AppSetting } = require('../models');
const logger = require('../utils/logger');

async function _slaHours() {
  try {
    const row = await AppSetting.findOne({ where: { key: 'reseller_topup_sla_hours' } });
    const h = row ? parseInt(row.value) : 0;
    return h > 0 ? h : 2;
  } catch (_) { return 2; }
}

async function checkPending() {
  const hours = await _slaHours();
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);

  const pendings = await ResellerTopup.findAll({
    where: {
      status: 'waiting_verification',
      method: { [Op.in]: ['manual', 'qris'] },
      createdAt: { [Op.lte]: cutoff }
    },
    include: [{ model: Reseller, as: 'reseller', attributes: ['code', 'name'] }],
    order: [['createdAt', 'ASC']],
    limit: 50
  });

  if (!pendings.length) return { count: 0, notified: false };

  // Susun pesan ringkas.
  const totalNominal = pendings.reduce((s, t) => s + Number(t.amount), 0);
  const lines = pendings.slice(0, 15).map(t => {
    const ageH = Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 3600000);
    const who = t.reseller ? `${t.reseller.name} (${t.reseller.code})` : `#${t.reseller_id}`;
    return `• ${who} — Rp ${Number(t.amount).toLocaleString('id-ID')} (${ageH} jam lalu)`;
  });
  const more = pendings.length > 15 ? `\n…dan ${pendings.length - 15} lainnya.` : '';
  const text =
    `⏰ *Reminder Verifikasi Top-up Reseller*\n` +
    `${pendings.length} top-up manual menunggu > ${hours} jam ` +
    `(total Rp ${totalNominal.toLocaleString('id-ID')}).\n\n` +
    lines.join('\n') + more +
    `\n\nSegera verifikasi di menu Reseller Voucher → Top-up.`;

  let notified = false;
  try {
    const Telegram = require('./TelegramService');
    if (await Telegram.isEnabled()) {
      await Telegram.sendMessage(text);
      notified = true;
    }
  } catch (e) { logger.warn('[ResellerSLA] telegram notify:', e.message); }

  logger.info(`[ResellerSLA] ${pendings.length} top-up menggantung > ${hours} jam` + (notified ? ' (Telegram terkirim)' : ''));
  return { count: pendings.length, notified, total: totalNominal };
}

module.exports = { checkPending };
