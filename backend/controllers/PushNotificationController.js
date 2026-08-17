/**
 * PushNotificationController.js
 * CRUD push notification + template + send/retry/schedule
 */

const { Op } = require('sequelize');
const { PushNotification, PushTemplate, Customer, Package,
        Invoice, CustomerPushSubscription, sequelize } = require('../models');
const PushService = require('../services/PushService');
const logger = require('../utils/logger');
const moment = require('moment');

// ── Helper: bangun WHERE clause untuk customer berdasarkan filter ─
async function buildTargetCustomerIds(filters = {}) {
  const f = filters || {};

  // Kalau manual pick, langsung return
  if (Array.isArray(f.customer_ids) && f.customer_ids.length) {
    return f.customer_ids.map(id => parseInt(id)).filter(Boolean);
  }

  const where = {};

  // Filter paket
  if (Array.isArray(f.packages) && f.packages.length) {
    where.package_id = { [Op.in]: f.packages.map(id => parseInt(id)).filter(Boolean) };
  }

  // Filter status pelanggan (active/inactive/suspended)
  if (Array.isArray(f.customer_status) && f.customer_status.length) {
    where.status = { [Op.in]: f.customer_status };
  }

  // Filter status isolir
  if (Array.isArray(f.isolir_status) && f.isolir_status.length) {
    where.isolir_status = { [Op.in]: f.isolir_status };
  }

  // Filter area (partial match di alamat)
  if (f.area && typeof f.area === 'string' && f.area.trim()) {
    where.address = { [Op.like]: '%' + f.area.trim() + '%' };
  }

  // Ambil semua customer match where
  let customers = await Customer.findAll({
    where,
    attributes: ['id']
  });
  let customerIds = customers.map(c => c.id);

  // Filter status tagihan (butuh join ke invoices) — post-filter di memory
  if (Array.isArray(f.bill_status) && f.bill_status.length && customerIds.length) {
    const today = moment().format('YYYY-MM-DD');
    const soonDate = moment().add(3, 'days').format('YYYY-MM-DD');

    // Untuk 'due_soon' → invoice unpaid & due_date antara today dan +3 hari
    // Untuk 'overdue','unpaid','paid' → cari langsung by status invoice
    const matchedCustomerIds = new Set();

    // overdue / unpaid / paid (direct status match)
    const directStatuses = f.bill_status.filter(s => ['overdue','unpaid','paid'].includes(s));
    if (directStatuses.length) {
      const invs = await Invoice.findAll({
        where: {
          customer_id: { [Op.in]: customerIds },
          status: { [Op.in]: directStatuses }
        },
        attributes: ['customer_id'],
        group: ['customer_id']
      });
      invs.forEach(i => matchedCustomerIds.add(i.customer_id));
    }

    // due_soon
    if (f.bill_status.includes('due_soon')) {
      const invs = await Invoice.findAll({
        where: {
          customer_id: { [Op.in]: customerIds },
          status: 'unpaid',
          due_date: { [Op.between]: [today, soonDate] }
        },
        attributes: ['customer_id'],
        group: ['customer_id']
      });
      invs.forEach(i => matchedCustomerIds.add(i.customer_id));
    }

    customerIds = customerIds.filter(id => matchedCustomerIds.has(id));
  }

  return customerIds;
}

// ── Helper: filter customerIds yang punya active push subscription ──
async function filterSubscribedCustomers(customerIds) {
  if (!customerIds.length) return [];
  const subs = await CustomerPushSubscription.findAll({
    where: {
      customer_id: { [Op.in]: customerIds },
      is_active: true
    },
    attributes: ['customer_id'],
    group: ['customer_id']
  });
  return subs.map(s => s.customer_id);
}

// ══════════════════════════════════════════════════════════════
// PREVIEW TARGETS — untuk UI kalkulasi "akan dikirim ke X orang"
// ══════════════════════════════════════════════════════════════
exports.previewTargets = async (req, res) => {
  try {
    const filters = req.body.filters || req.body || {};
    const matchedIds   = await buildTargetCustomerIds(filters);
    const subscribed   = await filterSubscribedCustomers(matchedIds);

    res.json({
      success: true,
      data: {
        total_matched:    matchedIds.length,      // match filter
        total_subscribed: subscribed.length,       // yang bisa dikirim push
        total_unsubscribed: matchedIds.length - subscribed.length
      }
    });
  } catch(e) {
    logger.error('previewTargets error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// CUSTOMER LIST — untuk UI checkbox pick manual (dengan search)
// ══════════════════════════════════════════════════════════════
exports.customerList = async (req, res) => {
  try {
    const { search = '', limit = 50, subscribed_only = 'false' } = req.query;

    const where = {};
    if (search.trim()) {
      where[Op.or] = [
        { name:        { [Op.like]: '%' + search.trim() + '%' } },
        { customer_id: { [Op.like]: '%' + search.trim() + '%' } },
        { phone:       { [Op.like]: '%' + search.trim() + '%' } }
      ];
    }

    let customers = await Customer.findAll({
      where,
      attributes: ['id','customer_id','name','phone','package_id','status','isolir_status'],
      limit: Math.min(parseInt(limit) || 50, 200),
      order: [['name','ASC']]
    });

    // Tag which customer has subscription
    const ids = customers.map(c => c.id);
    const subs = ids.length ? await CustomerPushSubscription.findAll({
      where: { customer_id: { [Op.in]: ids }, is_active: true },
      attributes: ['customer_id'],
      group: ['customer_id']
    }) : [];
    const subscribedSet = new Set(subs.map(s => s.customer_id));

    let data = customers.map(c => ({
      id: c.id,
      customer_id: c.customer_id,
      name: c.name,
      phone: c.phone,
      package_id: c.package_id,
      status: c.status,
      isolir_status: c.isolir_status,
      subscribed: subscribedSet.has(c.id)
    }));

    if (subscribed_only === 'true') {
      data = data.filter(d => d.subscribed);
    }

    res.json({ success: true, data });
  } catch(e) {
    logger.error('customerList error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// SEND — kirim push (bisa langsung / scheduled)
// ══════════════════════════════════════════════════════════════
exports.send = async (req, res) => {
  try {
    const {
      title, body, icon, url, tag,
      filters = {}, scheduled_at = null, template_id = null
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Title dan body wajib diisi' });
    }

    // Hitung target saat compose (snapshot)
    const matchedIds   = await buildTargetCustomerIds(filters);
    const subscribed   = await filterSubscribedCustomers(matchedIds);

    if (!subscribed.length && !scheduled_at) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada pelanggan yang match filter DAN subscribe push. Coba cek kriteria.'
      });
    }

    // Normalisasi scheduled_at
    let schedDate = null;
    let status = 'pending';
    if (scheduled_at) {
      schedDate = new Date(scheduled_at);
      if (isNaN(schedDate.getTime())) {
        return res.status(400).json({ success: false, message: 'Format scheduled_at tidak valid' });
      }
      // Kalau jadwal di masa lalu (sudah lewat) → tolak
      if (schedDate.getTime() <= Date.now()) {
        return res.status(400).json({
          success: false,
          message: 'Jadwal sudah terlewat. Pilih waktu minimal 2 menit dari sekarang.'
        });
      }
      // Semua jadwal masa depan → masuk queue (akan diproses cron tiap menit)
      status = 'scheduled';
    }

    const notif = await PushNotification.create({
      title: title.slice(0, 120),
      body:  String(body).slice(0, 1000),
      icon:  (icon || '').slice(0, 10) || null,
      url:   (url  || '').slice(0, 255) || null,
      tag:   (tag  || '').slice(0, 60)  || null,
      filters,
      target_count: subscribed.length,
      sent_count: 0,
      failed_count: 0,
      status,
      scheduled_at: schedDate,
      template_id: template_id || null,
      created_by: req.user ? req.user.id : null
    });

    // Kalau scheduled, return tanpa kirim sekarang
    if (status === 'scheduled') {
      return res.json({
        success: true,
        mode: 'scheduled',
        message: `Push dijadwalkan untuk ${schedDate.toLocaleString('id-ID')} ke ${subscribed.length} pelanggan`,
        data: notif
      });
    }

    // Kirim sekarang
    const result = await _dispatchNotification(notif, subscribed);
    return res.json({
      success: true,
      mode: 'sent',
      message: `Push terkirim ke ${result.sent_count} pelanggan (gagal: ${result.failed_count})`,
      data: result
    });

  } catch(e) {
    logger.error('Push send error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ── Internal: kirim push dan update log status ──
async function _dispatchNotification(notif, subscribedIds) {
  if (!PushService.isReady()) {
    await notif.update({
      status: 'failed',
      error_message: 'Push service belum siap (VAPID keys belum di-set di .env)'
    });
    throw new Error('Push service belum siap — set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY di .env');
  }

  // Emoji yang dipilih admin (kolom `icon`) di-prepend ke title supaya tampil
  // di notifikasi. Service worker menampilkan `data.title` apa adanya dan tidak
  // membaca `data.emoji`, jadi kalau emoji hanya ditaruh di data.* tidak akan
  // kelihatan. Hindari double-emoji kalau admin sudah mengetik emoji di title.
  const emoji = (notif.icon || '').trim();
  const titleWithEmoji = (emoji && !notif.title.trim().startsWith(emoji))
    ? `${emoji} ${notif.title}`
    : notif.title;

  const payload = {
    title: titleWithEmoji,
    body:  notif.body,
    icon:  '/img/icon-192.png',
    url:   notif.url || '/portal',
    tag:   notif.tag || 'broadcast',
    data:  {
      type: 'admin_broadcast',
      notif_id: notif.id,
      emoji: notif.icon || null
    }
  };

  try {
    const result = await PushService.sendToCustomers(subscribedIds, payload);
    await notif.update({
      status: 'sent',
      sent_count: result.total_sent,
      failed_count: result.total_failed,
      sent_at: new Date()
    });
    return notif.reload();
  } catch (e) {
    await notif.update({
      status: 'failed',
      error_message: e.message.slice(0, 500)
    });
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// RETRY — kirim ulang notifikasi yang gagal / sudah dikirim
// ══════════════════════════════════════════════════════════════
exports.retry = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await PushNotification.findByPk(id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notifikasi tidak ditemukan' });

    if (notif.status === 'scheduled') {
      return res.status(400).json({ success: false, message: 'Notifikasi ini masih dijadwalkan, batalkan dulu' });
    }

    // Rebuild target dari snapshot filter
    const matchedIds = await buildTargetCustomerIds(notif.filters || {});
    const subscribed = await filterSubscribedCustomers(matchedIds);

    if (!subscribed.length) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada pelanggan yang subscribe saat ini. Filter menghasilkan 0 target.'
      });
    }

    // Reset counters sebelum retry
    await notif.update({
      status: 'pending',
      target_count: subscribed.length,
      sent_count: 0,
      failed_count: 0,
      error_message: null
    });

    const result = await _dispatchNotification(notif, subscribed);
    res.json({
      success: true,
      message: `Retry selesai: ${result.sent_count} terkirim, ${result.failed_count} gagal`,
      data: result
    });
  } catch(e) {
    logger.error('Push retry error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// CANCEL — batalkan notifikasi scheduled
// ══════════════════════════════════════════════════════════════
exports.cancel = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await PushNotification.findByPk(id);
    if (!notif) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    if (notif.status !== 'scheduled') {
      return res.status(400).json({ success: false, message: 'Hanya notifikasi scheduled yang bisa dibatalkan' });
    }
    await notif.update({ status: 'cancelled' });
    res.json({ success: true, message: 'Dibatalkan' });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// LIST — riwayat push notifications
// ══════════════════════════════════════════════════════════════
exports.list = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const where = {};
    if (status) where.status = status;
    if (search && search.trim()) {
      where[Op.or] = [
        { title: { [Op.like]: '%' + search.trim() + '%' } },
        { body:  { [Op.like]: '%' + search.trim() + '%' } }
      ];
    }

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const { rows, count } = await PushNotification.findAndCountAll({
      where,
      order: [['created_at','DESC']],
      limit: Math.min(parseInt(limit) || 20, 100),
      offset
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        total_pages: Math.ceil(count / parseInt(limit))
      }
    });
  } catch(e) {
    logger.error('Push list error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// STATS — dashboard small cards
// ══════════════════════════════════════════════════════════════
exports.stats = async (req, res) => {
  try {
    const today = moment().startOf('day').toDate();
    const monthAgo = moment().subtract(30, 'days').toDate();

    const [totalAll, totalToday, totalMonth, totalScheduled, subscribers] = await Promise.all([
      PushNotification.count(),
      PushNotification.count({ where: { created_at: { [Op.gte]: today } } }),
      PushNotification.count({ where: { created_at: { [Op.gte]: monthAgo } } }),
      PushNotification.count({ where: { status: 'scheduled' } }),
      CustomerPushSubscription.count({ where: { is_active: true }, distinct: true, col: 'customer_id' })
    ]);

    res.json({
      success: true,
      data: {
        total_all: totalAll,
        total_today: totalToday,
        total_month: totalMonth,
        total_scheduled: totalScheduled,
        total_subscribers: subscribers,
        push_ready: PushService.isReady()
      }
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// DELETE — hapus log (bulk by IDs atau single by ID)
// ══════════════════════════════════════════════════════════════
exports.destroy = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await PushNotification.findByPk(id);
    if (!notif) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    if (notif.status === 'scheduled' || notif.status === 'pending') {
      return res.status(400).json({ success: false, message: 'Batalkan dulu sebelum dihapus' });
    }
    await notif.destroy();
    res.json({ success: true, message: 'Dihapus' });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// TEST NOTIFIKASI — kirim 1 push uji untuk verifikasi sistem
// ══════════════════════════════════════════════════════════════
// Body opsional:
//   { customer_id }  → kirim ke 1 customer tertentu (harus punya sub aktif)
//   {}               → kirim ke subscriber MANA SAJA yang ditemukan (1 customer
//                      pertama yang punya subscription aktif) sebagai smoke-test.
// Tidak menyimpan ke tabel push_notifications (ini cuma uji, bukan broadcast).
exports.testSend = async (req, res) => {
  try {
    if (!PushService.isReady()) {
      return res.status(400).json({
        success: false,
        message: 'Push service belum siap. Set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY (web) atau FCM di .env, lalu restart.'
      });
    }

    let customerId = req.body && req.body.customer_id ? parseInt(req.body.customer_id) : null;

    // Kalau tidak ditentukan, cari subscriber aktif pertama sebagai target uji.
    if (!customerId) {
      const anySub = await CustomerPushSubscription.findOne({
        where: { is_active: true },
        order: [['last_used', 'DESC']],
        attributes: ['customer_id']
      });
      if (!anySub) {
        return res.status(400).json({
          success: false,
          message: 'Belum ada pelanggan yang subscribe push. Minta pelanggan aktifkan notifikasi di portal dulu.'
        });
      }
      customerId = anySub.customer_id;
    }

    // Validasi customer punya subscription aktif
    const subCount = await CustomerPushSubscription.count({
      where: { customer_id: customerId, is_active: true }
    });
    if (!subCount) {
      return res.status(400).json({
        success: false,
        message: 'Pelanggan ini belum/ tidak lagi subscribe push notification.'
      });
    }

    const cust = await Customer.findByPk(customerId, { attributes: ['id','name','customer_id'] });
    const nama = cust ? cust.name : 'Pelanggan';

    const now = new Date();
    const jam = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const result = await PushService.sendToCustomer(customerId, {
      title: '🔔 Tes Notifikasi',
      body:  `Halo ${nama}, ini notifikasi uji dari sistem. Jika Anda menerima pesan ini (${jam}), push notification berfungsi normal.`,
      tag:   'test-' + Date.now(),
      url:   '/portal/dashboard',
      data:  { type: 'test', ts: now.toISOString() }
    });

    return res.json({
      success: true,
      message: `Notifikasi uji dikirim ke ${nama} (${cust ? cust.customer_id : customerId}) — ${result.sent} device terkirim, ${result.failed} gagal.`,
      data: {
        customer_id: customerId,
        customer_name: nama,
        devices_sent: result.sent,
        devices_failed: result.failed
      }
    });
  } catch (e) {
    logger.error('Push testSend error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// TEST CRON — trigger manual logika reminder otomatis
// ══════════════════════════════════════════════════════════════
// Param :type = 'due-soon' | 'overdue'
// Menjalankan fungsi yang SAMA dengan cron harian, mengabaikan jam kirim
// (push_reminder_send_hour / overdue_hour) supaya admin bisa verifikasi
// alur otomatis kapan saja. Tetap menghormati master switch & toggle per-jenis.
exports.testCron = async (req, res) => {
  try {
    if (!PushService.isReady()) {
      return res.status(400).json({
        success: false,
        message: 'Push service belum siap (VAPID/FCM belum dikonfigurasi di .env).'
      });
    }

    const type = (req.params.type || '').toLowerCase();
    const cfg  = await PushService.getReminderSettings();

    if (cfg.push_reminder_enabled !== '1') {
      return res.status(400).json({
        success: false,
        message: 'Reminder otomatis sedang OFF (master switch). Aktifkan & simpan dulu untuk menguji.'
      });
    }

    if (type === 'due-soon' || type === 'duesoon') {
      const activeDays = [];
      if (cfg.push_reminder_h3_enabled === '1') activeDays.push('H-3');
      if (cfg.push_reminder_h1_enabled === '1') activeDays.push('H-1');
      if (cfg.push_reminder_h0_enabled === '1') activeDays.push('H+0');
      if (!activeDays.length) {
        return res.status(400).json({
          success: false,
          message: 'Tidak ada jenis reminder jatuh-tempo (H-3/H-1/H+0) yang aktif.'
        });
      }
      await PushService.sendDueSoonReminders();
      return res.json({
        success: true,
        message: `Cron reminder jatuh-tempo dijalankan (aktif: ${activeDays.join(', ')}). Cek log server & device pelanggan yang invoice-nya jatuh tempo H-3/H-1/H+0.`
      });
    }

    if (type === 'overdue') {
      if (cfg.push_reminder_overdue_enabled !== '1') {
        return res.status(400).json({
          success: false,
          message: 'Reminder overdue sedang OFF. Aktifkan & simpan dulu untuk menguji.'
        });
      }
      await PushService.sendOverdueReminders();
      return res.json({
        success: true,
        message: 'Cron reminder overdue dijalankan. Cek log server & device pelanggan yang invoice-nya sudah lewat jatuh tempo (dan belum diisolir).'
      });
    }

    return res.status(400).json({
      success: false,
      message: "Tipe tidak dikenal. Gunakan 'due-soon' atau 'overdue'."
    });
  } catch (e) {
    logger.error('Push testCron error: ' + e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ══════════════════════════════════════════════════════════════
// TEMPLATE — CRUD
// ══════════════════════════════════════════════════════════════
exports.listTemplates = async (req, res) => {
  try {
    const rows = await PushTemplate.findAll({ order: [['category','ASC'],['name','ASC']] });
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.createTemplate = async (req, res) => {
  try {
    const { name, category, icon, title, body, url, tag } = req.body;
    if (!name || !title || !body) {
      return res.status(400).json({ success: false, message: 'Nama, title, body wajib' });
    }
    const tpl = await PushTemplate.create({
      name: String(name).slice(0, 100),
      category: category || 'info',
      icon: (icon || '').slice(0, 10) || null,
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 1000),
      url: (url || '').slice(0, 255) || null,
      tag: (tag || '').slice(0, 60) || null,
      created_by: req.user ? req.user.id : null
    });
    res.json({ success: true, data: tpl });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const tpl = await PushTemplate.findByPk(id);
    if (!tpl) return res.status(404).json({ success: false, message: 'Template tidak ditemukan' });
    const { name, category, icon, title, body, url, tag } = req.body;
    await tpl.update({
      name: name !== undefined ? String(name).slice(0, 100) : tpl.name,
      category: category || tpl.category,
      icon: icon !== undefined ? ((icon || '').slice(0, 10) || null) : tpl.icon,
      title: title !== undefined ? String(title).slice(0, 120) : tpl.title,
      body: body !== undefined ? String(body).slice(0, 1000) : tpl.body,
      url: url !== undefined ? ((url || '').slice(0, 255) || null) : tpl.url,
      tag: tag !== undefined ? ((tag || '').slice(0, 60) || null) : tpl.tag
    });
    res.json({ success: true, data: tpl });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const tpl = await PushTemplate.findByPk(id);
    if (!tpl) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    await tpl.destroy();
    res.json({ success: true, message: 'Template dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ══════════════════════════════════════════════════════════════
// SCHEDULER WORKER — dipanggil dari cron tiap 1 menit
// ══════════════════════════════════════════════════════════════
exports.processScheduled = async function processScheduled() {
  try {
    const now = new Date();
    const due = await PushNotification.findAll({
      where: {
        status: 'scheduled',
        scheduled_at: { [Op.lte]: now }
      },
      limit: 10 // hati-hati: kirim max 10 job per-menit
    });

    for (const notif of due) {
      try {
        // Lock
        await notif.update({ status: 'pending' });

        const matchedIds = await buildTargetCustomerIds(notif.filters || {});
        const subscribed = await filterSubscribedCustomers(matchedIds);

        if (!subscribed.length) {
          await notif.update({
            status: 'failed',
            error_message: 'Tidak ada subscriber saat dijadwalkan'
          });
          continue;
        }

        await notif.update({ target_count: subscribed.length });
        await _dispatchNotification(notif, subscribed);
        logger.info(`[PushScheduler] Sent notif #${notif.id} to ${subscribed.length} customers`);
      } catch (err) {
        logger.error(`[PushScheduler] Error processing notif #${notif.id}: ${err.message}`);
      }
    }
  } catch (e) {
    logger.error('[PushScheduler] processScheduled error: ' + e.message);
  }
};