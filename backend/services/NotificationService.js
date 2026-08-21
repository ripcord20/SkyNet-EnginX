/**
 * NotificationService.js
 * Generate & push notifikasi: WA masuk, overdue, jatuh tempo
 */
const { Notification, Customer, Invoice, WaMessage, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');

let _io = null;

function setIO(io) { _io = io; }

async function push(userId, { type, title, message, severity = 'info', action_url = null, metadata = null }) {
  try {
    // Model menyimpan URL tujuan di kolom `link` (bukan `action_url`).
    // Tanpa pemetaan ini, link notif selalu null dan klik notif tak mengarah ke mana-mana.
    const notif = await Notification.create({ user_id: userId, type, title, message, severity, link: action_url, metadata });
    if (_io) _io.emit('notification:new', { id: notif.id, type, title, message, severity });
    return notif;
  } catch(e) { console.error('[NotifService] push error:', e.message); }
}

// Broadcast ke semua admin
// `dedupeDaily`: untuk notif harian (overdue/due_today/due_soon) — jangan buat
// duplikat untuk user+type yang sama pada hari yang sama (mencegah banjir notif
// kalau cron/daily-alert terpicu lebih dari sekali).
async function pushAll({ type, title, message, severity = 'info', action_url = null, metadata = null, dedupeDaily = false }) {
  try {
    const { User } = require('../models');
    const admins = await User.findAll({ attributes: ['id'] });
    for (const u of admins) {
      if (dedupeDaily) {
        const startOfDay = moment().startOf('day').toDate();
        const existing = await Notification.findOne({
          where: { user_id: u.id, type, created_at: { [Op.gte]: startOfDay } },
          attributes: ['id']
        });
        if (existing) {
          // Sudah ada notif tipe ini hari ini → perbarui isinya, jangan buat baru.
          await Notification.update(
            { title, message, severity, link: action_url, metadata },
            { where: { id: existing.id } }
          );
          continue;
        }
      }
      await push(u.id, { type, title, message, severity, action_url, metadata });
    }
  } catch(e) { console.error('[NotifService] pushAll error:', e.message); }
}

// ── WA Incoming — hanya dari pelanggan terdaftar ──────────────
const _notifRateLimit = new Map(); // from -> last notif timestamp

async function notifyWaIncoming(from, text, sessionName) {
  // Rate limit: max 1 notif per nomor per 5 menit
  const now  = Date.now();
  const last = _notifRateLimit.get(from) || 0;
  if (now - last < 5 * 60 * 1000) return;
  _notifRateLimit.set(from, now);

  // Cek apakah dari pelanggan terdaftar
  try {
    const { Customer } = require('../models');
    const { Op } = require('sequelize');
    const clean = from.replace(/[^0-9]/g, '');
    const last9 = clean.slice(-9);
    const customer = await Customer.findOne({
      where: { phone: { [Op.like]: '%' + last9 } },
      attributes: ['name', 'customer_id']
    });

    // Hanya notif jika dari pelanggan terdaftar
    if (!customer) return;

    const title = `WA dari ${customer.name} (${customer.customer_id})`;
    const msg   = (text||'').substring(0, 100) + ((text||'').length > 100 ? '…' : '');

    await pushAll({
      type:      'wa_incoming',
      title,
      message:   msg,
      severity:  'info',
      action_url: '/whatsapp',
      metadata:  { from, customer_id: customer.customer_id, session: sessionName }
    });
  } catch(e) {
    // Jika error cek customer, skip notif
  }
}

// ── Daily check: overdue & due soon ────────────────────────────
async function checkDailyAlerts() {
  try {
    const today   = moment().format('YYYY-MM-DD');
    const in3days = moment().add(3,'days').format('YYYY-MM-DD');

    // Overdue invoices
    const overdues = await sequelize.query(
      `SELECT i.id, i.invoice_number, i.due_date, c.name, c.customer_id
       FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.status IN ('unpaid','overdue') AND i.due_date < :today
       ORDER BY i.due_date ASC LIMIT 20`,
      { replacements: { today }, type: sequelize.QueryTypes.SELECT }
    );

    if (overdues.length) {
      await pushAll({
        type:     'overdue',
        title:    `${overdues.length} Invoice Overdue`,
        message:  overdues.slice(0,3).map(r => `${r.name} (${r.customer_id}) — ${moment(r.due_date).format('DD/MM/YYYY')}`).join(', ') + (overdues.length > 3 ? ` +${overdues.length-3} lagi` : ''),
        severity: 'critical',
        action_url: '/billing?status=overdue',
        metadata:  { count: overdues.length },
        dedupeDaily: true
      });
    }

    // Due today
    const dueToday = await sequelize.query(
      `SELECT i.id, c.name, c.customer_id FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.status='unpaid' AND DATE(i.due_date) = :today LIMIT 20`,
      { replacements: { today }, type: sequelize.QueryTypes.SELECT }
    );
    if (dueToday.length) {
      await pushAll({
        type:     'due_today',
        title:    `${dueToday.length} Tagihan Jatuh Tempo Hari Ini`,
        message:  dueToday.slice(0,3).map(r => `${r.name} (${r.customer_id})`).join(', ') + (dueToday.length > 3 ? ` +${dueToday.length-3} lagi` : ''),
        severity: 'warning',
        action_url: '/billing',
        metadata:  { count: dueToday.length },
        dedupeDaily: true
      });
    }

    // Due in 3 days
    const dueSoon = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM invoices i
       WHERE i.status='unpaid' AND DATE(i.due_date) BETWEEN :today AND :in3days`,
      { replacements: { today, in3days }, type: sequelize.QueryTypes.SELECT }
    );
    const dueSoonCnt = parseInt(dueSoon[0]?.[0]?.cnt || 0);
    if (dueSoonCnt > 0) {
      await pushAll({
        type:     'due_soon',
        title:    `${dueSoonCnt} Tagihan Jatuh Tempo 3 Hari ke Depan`,
        message:  'Segera kirim reminder ke pelanggan',
        severity: 'info',
        action_url: '/billing',
        dedupeDaily: true
      });
    }
  } catch(e) { console.error('[NotifService] checkDailyAlerts error:', e.message); }
}

module.exports = { setIO, push, pushAll, notifyWaIncoming, checkDailyAlerts };
