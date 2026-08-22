/**
 * CollectNotifier — notifikasi siklus setoran kas (Cash Collect).
 *
 * - notifyDepositCreated(): kabari ADMIN (Telegram + WA admin_notify_phones)
 *   bahwa kolektor mengirim setoran kas, menunggu verifikasi.
 * - notifyDepositVerified(): kabari KOLEKTOR (WA) setoran diverifikasi.
 * - notifyDepositRejected(): kabari KOLEKTOR (WA) setoran ditolak + alasan.
 *
 * Semua best-effort: kegagalan kirim tidak boleh mengganggu alur utama.
 * Dipanggil via setImmediate(...).catch(()=>{}) dari controller.
 */
const moment = require('moment');

async function _getSetting(key, fallback = null) {
  try {
    const { AppSetting } = require('../models');
    const r = await AppSetting.findOne({ where: { key } });
    return r ? (r.value != null ? r.value : fallback) : fallback;
  } catch (_) { return fallback; }
}

async function _companyName() {
  try { return await require('../utils/companyInfo').getCompanyName(); } catch (_) { return ''; }
}

function _fmtRp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

// Kirim WA ke satu nomor (best-effort).
async function _sendWa(phone, text) {
  if (!phone) return;
  try {
    const GatewayService = require('./GatewayService');
    const session = await GatewayService.getDefaultSendingSession();
    if (!session) return;
    await GatewayService.warmSession(session.session_id);
    if (!GatewayService.isConnected(session.session_id)) return;
    await GatewayService.sendMessage(session.session_id, phone, text, null);
  } catch (_) { /* ignore */ }
}

// Kirim ke daftar admin (WA admin_notify_phones + Telegram).
async function _notifyAdmins(text) {
  // WA (markdown *bold*)
  try {
    const raw = await _getSetting('admin_notify_phones', '[]');
    let phones = [];
    try { phones = JSON.parse(raw || '[]'); } catch (_) { phones = []; }
    for (const p of (Array.isArray(phones) ? phones : [])) {
      await _sendWa(String(p).trim(), text);
    }
  } catch (_) {}
  // Telegram (HTML parse_mode) — konversi *bold* -> <b>, escape < & >.
  try {
    const Tele = require('./TelegramService');
    const html = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*(.+?)\*/g, '<b>$1</b>');
    await Tele.sendMessage(html);
  } catch (_) {}
}

async function notifyDepositCreated(dep, collectorName) {
  const company = await _companyName();
  const variance = parseFloat(dep.variance) || 0;
  const lines = [
    `🔔 *Setoran Kas Baru*${company ? ' — ' + company : ''}`,
    ``,
    `Kolektor : ${collectorName || '-'}`,
    `Jumlah   : ${_fmtRp(dep.deposited_amount)}`,
    `Ekspektasi: ${_fmtRp(dep.expected_amount)}`,
    variance !== 0 ? `Selisih  : ${variance < 0 ? '-' : '+'}${_fmtRp(Math.abs(variance))} (${variance < 0 ? 'kurang' : 'lebih'})` : `Selisih  : cocok`,
    `Tanggal  : ${moment(dep.deposit_date).format('DD/MM/YYYY')}`,
    dep.proof_path ? `Bukti    : ada foto` : `Bukti    : tanpa foto`,
    ``,
    `Mohon verifikasi di menu Collect → Setoran Kas.`
  ];
  await _notifyAdmins(lines.join('\n'));
}

async function notifyDepositVerified(dep, collectorPhone) {
  if (!collectorPhone) return;
  const company = await _companyName();
  const variance = parseFloat(dep.variance) || 0;
  const lines = [
    `✅ *Setoran Diverifikasi*${company ? ' — ' + company : ''}`,
    ``,
    `Setoran Anda sebesar ${_fmtRp(dep.deposited_amount)} pada ${moment(dep.deposit_date).format('DD/MM/YYYY')} telah *diverifikasi*.`,
    variance !== 0 ? `Catatan: ada selisih ${variance < 0 ? '-' : '+'}${_fmtRp(Math.abs(variance))} (${variance < 0 ? 'kurang' : 'lebih'} setor).` : null,
    ``,
    `Saldo kas di tangan Anda telah diperbarui. Terima kasih.`
  ].filter(Boolean);
  await _sendWa(collectorPhone, lines.join('\n'));
}

async function notifyDepositRejected(dep, collectorPhone) {
  if (!collectorPhone) return;
  const company = await _companyName();
  const lines = [
    `⚠️ *Setoran Ditolak*${company ? ' — ' + company : ''}`,
    ``,
    `Setoran Anda sebesar ${_fmtRp(dep.deposited_amount)} pada ${moment(dep.deposit_date).format('DD/MM/YYYY')} *ditolak*.`,
    dep.reject_reason ? `Alasan: ${dep.reject_reason}` : null,
    ``,
    `Uang dianggap masih di tangan Anda. Silakan hubungi admin / setor ulang.`
  ].filter(Boolean);
  await _sendWa(collectorPhone, lines.join('\n'));
}

module.exports = {
  notifyDepositCreated,
  notifyDepositVerified,
  notifyDepositRejected,
};
