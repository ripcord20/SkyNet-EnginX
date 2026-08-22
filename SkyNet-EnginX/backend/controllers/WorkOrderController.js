'use strict';
const path = require('path');
const fs   = require('fs');
const multer = require('multer');
const { WorkOrder, Customer, Ticket, User, WaSession } = require('../models');
const { Op } = require('sequelize');

// ── Upload storage ────────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../frontend/public/uploads/workorders');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `wo_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname));
    cb(ok ? null : new Error('Hanya file gambar yang diizinkan'), ok);
  }
});
exports.uploadMiddleware = upload.array('photos', 10);

// ── Includes ─────────────────────────────────────────────────
const INC = [
  { model: Customer, as: 'customer',    attributes: ['id','name','phone','address'], required: false },
  { model: Ticket,   as: 'ticket',      attributes: ['id','ticket_number','title'],  required: false },
  { model: User,     as: 'assignedUser',attributes: ['id','name','email','phone'],   required: false },
  { model: User,     as: 'creator',     attributes: ['id','name','email'],           required: false }
];

// ── WA Notification helper ────────────────────────────────────
async function sendWANotification(phone, message) {
  if (!phone) return { sent: false, reason: 'Nomor HP teknisi tidak tersedia' };
  try {
    const GatewayService = require('../services/GatewayService');
    // Ambil session WA default (hormati pengaturan admin), provider-aware
    const session = await GatewayService.getDefaultSendingSession();
    if (!session) return { sent: false, reason: 'Tidak ada sesi WA yang terkoneksi' };
    await GatewayService.sendMessage(session.session_id, phone, message);
    return { sent: true, session: session.session_id };
  } catch(e) {
    return { sent: false, reason: e.message };
  }
}

// ── Build WA message ─────────────────────────────────────────
function buildWAMessage(wo, action = 'new') {
  const typeLabel = {installation:'Instalasi Baru',maintenance:'Maintenance',dismantle:'Dismantle',survey:'Survey',repair:'Perbaikan',other:'Lainnya'}[wo.type]||wo.type;
  const prioLabel = {low:'Rendah',medium:'Sedang',high:'Tinggi',critical:'KRITIS'}[wo.priority]||wo.priority;

  const techName = wo.assignedUser?.name || wo.technician_name || 'Teknisi';
  const custInfo = wo.customer ? `\n👤 Customer   : ${wo.customer.name}` : '';
  const tickInfo = wo.ticket   ? `\n🎫 Tiket       : ${wo.ticket.ticket_number}` : '';
  const schedInfo= wo.scheduled_date ? `\n📅 Jadwal      : ${new Date(wo.scheduled_date+'T00:00:00').toLocaleDateString('id-ID',{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}` : '';
  const locInfo  = wo.location_address ? `\n📍 Lokasi      : ${wo.location_address}` : '';
  const notesInfo= wo.notes ? `\n📝 Catatan     : ${wo.notes}` : '';

  const header = action === 'new'
    ? `*🔔 WORK ORDER BARU DITERIMA*`
    : `*📋 UPDATE WORK ORDER*`;

  return `${header}

Halo *${techName}*, Anda mendapatkan penugasan pekerjaan baru.

━━━━━━━━━━━━━━━━━━
*${wo.wo_number}*
━━━━━━━━━━━━━━━━━━
📌 Judul       : ${wo.title}
🔧 Tipe        : ${typeLabel}
⚡ Prioritas   : ${prioLabel}${custInfo}${tickInfo}${schedInfo}${locInfo}${notesInfo}
━━━━━━━━━━━━━━━━━━

Mohon segera konfirmasi penugasan ini.
Terima kasih! 🙏`;
}

// ── Index ─────────────────────────────────────────────────────
exports.index = async (req, res) => {
  try {
    const where = {};
    if (req.query.status)   where.status   = req.query.status;
    if (req.query.type)     where.type     = req.query.type;
    if (req.query.priority) where.priority = req.query.priority;
    if (req.query.search) {
      const q = `%${req.query.search}%`;
      where[Op.or] = [
        { title: { [Op.like]: q } }, { wo_number: { [Op.like]: q } },
        { technician_name: { [Op.like]: q } }
      ];
    }
    const rows = await WorkOrder.findAll({ where, include: INC, order: [['created_at','DESC']] });
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Stats ─────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const [total, pending, inProgress, done, overdue] = await Promise.all([
      WorkOrder.count(),
      WorkOrder.count({ where: { status: 'pending' } }),
      WorkOrder.count({ where: { status: 'in_progress' } }),
      WorkOrder.count({ where: { status: 'done' } }),
      WorkOrder.count({ where: { status: { [Op.in]:['pending','assigned','in_progress'] }, due_date: { [Op.lt]: today } } })
    ]);
    res.json({ success: true, data: { total, pending, inProgress, done, overdue } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Show ──────────────────────────────────────────────────────
exports.show = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, { include: INC });
    if (!wo) return res.status(404).json({ success: false, message: 'Work Order tidak ditemukan' });
    res.json({ success: true, data: wo });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Create ────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const {
      title, description, type, status, priority,
      customer_id, ticket_id,
      assigned_user_id, technician_name, technician_phone,
      scheduled_date, scheduled_time, due_date,
      location_address, latitude, longitude, notes,
      send_wa_notification
    } = req.body;

    if (!title) return res.status(400).json({ success: false, message: 'Judul WO wajib diisi' });

    const wo = await WorkOrder.create({
      title, description,
      type: type || 'installation', status: status || 'pending', priority: priority || 'medium',
      customer_id: customer_id || null, ticket_id: ticket_id || null,
      assigned_user_id: assigned_user_id || null,
      technician_name: technician_name || null, technician_phone: technician_phone || null,
      scheduled_date: scheduled_date || null, scheduled_time: scheduled_time || null,
      due_date: due_date || null,
      location_address: location_address || null,
      latitude: latitude || null, longitude: longitude || null,
      notes: notes || null,
      created_by: req.user?.id || null,
      photos: []
    });

    const result = await WorkOrder.findByPk(wo.id, { include: INC });

    // ── WA Notification ───────────────────────────────────────
    let waResult = { sent: false, reason: 'Notifikasi WA tidak diminta' };
    if (send_wa_notification !== false) {
      // Prioritas nomor: technician_phone (manual) → assignedUser.phone (user sistem)
      const techPhone = technician_phone || result.assignedUser?.phone || null;

      if (techPhone) {
        const msg = buildWAMessage(result, 'new');
        waResult  = await sendWANotification(techPhone, msg);
      } else {
        waResult = { sent: false, reason: 'Nomor HP teknisi tidak tersedia. Isi nomor HP di profil user atau field nomor teknisi.' };
      }
    }

    res.status(201).json({
      success: true, data: result,
      message: `Work Order ${result.wo_number} berhasil dibuat`,
      wa: waResult
    });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
};

// ── Update ────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id, { include: INC });
    if (!wo) return res.status(404).json({ success: false, message: 'Work Order tidak ditemukan' });

    const allowed = [
      'title','description','type','status','priority',
      'customer_id','ticket_id','assigned_user_id','technician_name','technician_phone',
      'scheduled_date','scheduled_time','due_date','location_address','latitude','longitude',
      'notes','completion_notes'
    ];
    const fields = {};
    allowed.forEach(k => { if (k in req.body) fields[k] = req.body[k] || null; });

    if (fields.status === 'in_progress' && !wo.started_at)   fields.started_at   = new Date();
    if (fields.status === 'done'        && !wo.completed_at) fields.completed_at = new Date();

    await wo.update(fields);

    // ── Sales hook: WO instalasi selesai → aktifkan registrasi + catat komisi ──
    // Jika WO ini berasal dari registrasi sales dan baru saja menjadi 'done',
    // buat Customer + komisi 'earned'. Idempoten (aman dipanggil berulang).
    if (fields.status === 'done') {
      try {
        const { RegistrationRequest } = require('../models');
        const reg = await RegistrationRequest.findOne({ where: { work_order_id: wo.id } });
        if (reg && reg.status !== 'activated') {
          const SalesController = require('./SalesController');
          await SalesController.activateRegistration(reg.id, { activated_by: req.user?.id || null });
        }
      } catch (hookErr) {
        // Jangan gagalkan update WO hanya karena hook komisi error
        console.error('[WorkOrder→Sales activation hook]', hookErr.message);
      }
    }

    const result = await WorkOrder.findByPk(wo.id, { include: INC });

    // WA hanya dikirim saat create, tidak saat update
    res.json({
      success: true, data: result,
      message: 'Work Order berhasil diperbarui'
    });
  } catch(e) { res.status(400).json({ success: false, message: e.message }); }
};

// ── Upload Photos ─────────────────────────────────────────────
exports.uploadPhotos = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ success: false, message: 'Work Order tidak ditemukan' });
    if (!req.files?.length) return res.status(400).json({ success: false, message: 'Tidak ada file' });

    const newPhotos = req.files.map(f => ({
      url: '/uploads/workorders/' + f.filename,
      caption: req.body.caption || '',
      uploaded_at: new Date().toISOString()
    }));
    const photos = [...(wo.photos||[]), ...newPhotos];
    await wo.update({ photos });
    res.json({ success: true, data: { photos }, message: `${newPhotos.length} foto berhasil diupload` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Delete Photo ──────────────────────────────────────────────
exports.deletePhoto = async (req, res) => {
  try {
    const wo  = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ success: false, message: 'Work Order tidak ditemukan' });
    const idx = parseInt(req.params.photoIndex);
    const photos = [...(wo.photos||[])];
    if (idx < 0 || idx >= photos.length)
      return res.status(400).json({ success: false, message: 'Index foto tidak valid' });
    const fp = path.join(__dirname, '../../frontend/public', photos[idx].url);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    photos.splice(idx, 1);
    await wo.update({ photos });
    res.json({ success: true, message: 'Foto dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};

// ── Delete ────────────────────────────────────────────────────
exports.destroy = async (req, res) => {
  try {
    const wo = await WorkOrder.findByPk(req.params.id);
    if (!wo) return res.status(404).json({ success: false, message: 'Work Order tidak ditemukan' });
    (wo.photos||[]).forEach(p => {
      const fp = path.join(__dirname, '../../frontend/public', p.url);
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {}
    });
    await wo.destroy();
    res.json({ success: true, message: 'Work Order berhasil dihapus' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
};