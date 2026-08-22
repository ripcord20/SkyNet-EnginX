'use strict';

/**
 * EmailBroadcastController.js
 * ─────────────────────────────────────────────────────────────────────
 * Broadcast Email ke pelanggan — informasi gangguan, promo, maintenance,
 * billing, dan informasi umum. Paralel dengan WA Broadcast tapi via SMTP
 * (EmailService) dengan template email HTML branded profesional.
 *
 * Endpoint:
 *   GET    /api/email-broadcast/stats             → statistik
 *   GET    /api/email-broadcast/list              → daftar broadcast
 *   GET    /api/email-broadcast/:id               → detail
 *   POST   /api/email-broadcast                   → buat broadcast
 *   POST   /api/email-broadcast/:id/send-now      → kirim sekarang
 *   POST   /api/email-broadcast/:id/cancel        → batalkan
 *   DELETE /api/email-broadcast/:id               → hapus
 *   GET    /api/email-broadcast/count-targets     → preview jumlah penerima
 *   GET    /api/email-broadcast/search-customers  → cari customer (punya email)
 *   POST   /api/email-broadcast/preview           → render preview HTML email
 *   POST   /api/email-broadcast/send-test         → kirim email test ke 1 alamat
 *
 * Engine pengiriman:
 *   - Throttle: interval antar email (default 2 detik) + random jitter,
 *     untuk hindari rate limit SMTP provider (Gmail, dsb).
 *   - Cancel-aware: cek status tiap iterasi, bisa dibatalkan mid-run.
 *   - Progress update tiap 5 email.
 *   - Placeholder sama dengan WA broadcast: {nama} {cid} {paket} {harga}
 *     {alamat} {invoice} {periode} {jumlah} {jatuh_tempo} {status}
 *     {perusahaan} dll.
 * ─────────────────────────────────────────────────────────────────────
 */

const { Customer, Package, User, AppSetting, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');
const logger = require('../utils/logger');

// ── Helpers ──────────────────────────────────────────────────────────

const MONTHS_ID = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function getModel() {
  const { EmailBroadcast } = require('../models');
  return EmailBroadcast;
}

// Validasi format email sederhana — cukup untuk filter sebelum kirim.
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Where clause: customer punya email valid (NOT NULL & != '').
// Dipakai konsisten di getTargets() & countTargets() supaya angka preview
// match dengan jumlah yang benar-benar terkirim.
function emailNotEmptyWhere() {
  return { email: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } };
}

// ── Branding (cache per process) ─────────────────────────────────────
let _brandCache = null;
let _brandCacheAt = 0;
async function getBranding(force = false) {
  // Cache 60 detik — branding jarang berubah, tidak perlu query tiap email.
  if (!force && _brandCache && (Date.now() - _brandCacheAt) < 60000) return _brandCache;
  const keys = ['company_name','invtpl_company_name','app_name','company_address','invtpl_company_address',
                'company_phone','invtpl_company_phone','company_whatsapp','company_email','invtpl_company_email',
                'company_website'];
  const db = {};
  try {
    const rows = await AppSetting.findAll({ where: { key: keys } });
    rows.forEach(r => { db[r.key] = r.value; });
  } catch (_) { /* DB belum siap */ }
  _brandCache = {
    name:    db.company_name || db.invtpl_company_name || db.app_name || process.env.COMPANY_NAME || 'ISP Provider',
    address: db.company_address || db.invtpl_company_address || process.env.COMPANY_ADDRESS || '',
    phone:   db.company_phone || db.invtpl_company_phone || db.company_whatsapp || process.env.COMPANY_PHONE || '',
    email:   db.company_email || db.invtpl_company_email || process.env.COMPANY_EMAIL || '',
    website: db.company_website || process.env.COMPANY_WEBSITE || ''
  };
  _brandCacheAt = Date.now();
  return _brandCache;
}

// ── Kategori → tampilan banner email ─────────────────────────────────
const CATEGORY_META = {
  gangguan:    { label: 'INFORMASI GANGGUAN',    color: '#dc2626', soft: '#fef2f2', border: '#fecaca' },
  maintenance: { label: 'JADWAL PEMELIHARAAN',   color: '#b45309', soft: '#fffbeb', border: '#fde68a' },
  promo:       { label: 'PROMO SPESIAL',         color: '#16a34a', soft: '#f0fdf4', border: '#bbf7d0' },
  billing:     { label: 'INFORMASI TAGIHAN',     color: '#1d4ed8', soft: '#eff6ff', border: '#bfdbfe' },
  info:        { label: 'INFORMASI',             color: '#1e3a8a', soft: '#f8fafc', border: '#e2e8f0' }
};

// ── Template renderer (placeholder) ──────────────────────────────────
async function getLatestInvoice(customerId) {
  if (!customerId) return null;
  try {
    const { Invoice } = require('../models');
    let inv = await Invoice.findOne({
      where: { customer_id: customerId, status: { [Op.in]: ['unpaid','overdue'] } },
      order: [['due_date', 'ASC']],
    });
    if (!inv) {
      inv = await Invoice.findOne({ where: { customer_id: customerId }, order: [['created_at', 'DESC']] });
    }
    return inv ? inv.toJSON() : null;
  } catch (e) {
    logger.warn(`[EmailBC] getLatestInvoice failed for customer ${customerId}: ${e.message}`);
    return null;
  }
}

async function renderPlaceholders(text, cust, opts = {}) {
  if (!text) return '';
  const brand = opts.brand || await getBranding();
  const invoice = opts.invoice !== undefined ? opts.invoice : await getLatestInvoice(cust.id);

  const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const fmtDate = d => d ? moment(d).format('D MMMM YYYY') : '-';
  const fmtDateShort = d => d ? moment(d).format('DD/MM/YYYY') : '-';

  const periodeStr = invoice?.period_month
    ? (MONTHS_ID[invoice.period_month] || invoice.period_month) + ' ' + (invoice.period_year || '')
    : '-';

  const vars = {
    '{nama}':            cust.name || '',
    '{cid}':             cust.customer_id || cust.cid || '',
    '{paket}':           cust.package?.name || '-',
    '{harga}':           fmtRp(cust.package?.price || 0),
    '{email}':           cust.email || '',
    '{phone}':           cust.phone || '',
    '{nohp}':            cust.phone || '',
    '{alamat}':          cust.address || '-',
    '{invoice}':         invoice?.invoice_number || '-',
    '{periode}':         periodeStr,
    '{jumlah}':          invoice ? fmtRp(invoice.total) : '-',
    '{jatuh_tempo}':     invoice ? fmtDate(invoice.due_date) : '-',
    '{tgl_jatuh_tempo}': invoice ? fmtDate(invoice.due_date) : '-',
    '{duedate}':         invoice ? fmtDateShort(invoice.due_date) : '-',
    '{status}':          invoice ? (invoice.status === 'overdue' ? 'JATUH TEMPO' : invoice.status) : '-',
    '{perusahaan}':      brand.name,
  };
  return Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), text);
}

// ── Email HTML branded wrapper ───────────────────────────────────────
// Layout table-based (kompatibel semua email client: Gmail, Outlook, dsb)
// dengan header brand, banner kategori, body, dan footer kontak.
function buildEmailHtml({ category, bodyText, brand }) {
  const meta = CATEGORY_META[category] || CATEGORY_META.info;
  // bodyText plain → konversi newline ke paragraf agar rapi
  const paras = String(bodyText || '').split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;font-size:14px;line-height:1.75;color:#334155;">${escHtml(p).replace(/\n/g,'<br>')}</p>`
  ).join('');

  const footerLines = [];
  if (brand.address) footerLines.push(escHtml(brand.address));
  const contacts = [brand.phone, brand.email, brand.website].filter(Boolean).map(escHtml).join(' &nbsp;|&nbsp; ');
  if (contacts) footerLines.push(contacts);

  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(brand.name)}</title></head>
<body style="margin:0;padding:0;background-color:#eef2f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef2f9;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e0e7f3;">
    <!-- Header brand -->
    <tr><td style="background:linear-gradient(135deg,#1e3a8a,#1d4ed8);padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;color:#ffffff;letter-spacing:.3px;">${escHtml(brand.name)}</td>
        <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:rgba(255,255,255,.75);">${moment().format('D MMMM YYYY')}</td>
      </tr></table>
    </td></tr>
    <!-- Banner kategori -->
    <tr><td style="background:${meta.soft};border-bottom:1px solid ${meta.border};padding:10px 28px;">
      <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:1.5px;color:${meta.color};">${meta.label}</span>
    </td></tr>
    <!-- Body -->
    <tr><td style="padding:26px 28px 14px;font-family:Arial,Helvetica,sans-serif;">
      ${paras}
    </td></tr>
    <!-- Divider + footer -->
    <tr><td style="padding:0 28px;"><div style="border-top:1px solid #e8eef9;"></div></td></tr>
    <tr><td style="padding:16px 28px 22px;font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:0 0 4px;font-size:12px;font-weight:bold;color:#1e3a8a;">${escHtml(brand.name)}</p>
      ${footerLines.map(l => `<p style="margin:0 0 3px;font-size:11px;color:#94a3b8;line-height:1.6;">${l}</p>`).join('')}
      <p style="margin:10px 0 0;font-size:10.5px;color:#cbd5e1;">Email ini dikirim otomatis oleh sistem. Mohon tidak membalas email ini.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// ── Targeting ────────────────────────────────────────────────────────
async function getTargets(bc) {
  const filter = bc.target_filter || {};
  let where = emailNotEmptyWhere();

  switch (bc.target_type) {
    case 'active':
      where.status = 'active'; break;
    case 'overdue': {
      where.status = 'active';
      const overdueIds = await sequelize.query(
        "SELECT DISTINCT customer_id FROM invoices WHERE status IN ('unpaid','overdue') AND due_date < CURDATE()",
        { type: sequelize.QueryTypes.SELECT }
      );
      const ids = overdueIds.map(r => r.customer_id).filter(Boolean);
      where.id = { [Op.in]: ids.length ? ids : [-1] };
      break;
    }
    case 'by_package':
      where.status = 'active';
      if (filter.package_id) where.package_id = filter.package_id;
      break;
    case 'by_area': {
      // Filter wilayah berjenjang — hanya level yang diisi yang diterapkan.
      if (filter.province) where.province = filter.province;
      if (filter.regency)  where.regency  = filter.regency;
      if (filter.district) where.district = filter.district;
      if (filter.village)  where.village  = filter.village;
      break;
    }
    case 'custom':
      if (filter.mode === 'manual' && filter.emails?.length) {
        // Alamat email manual — tanpa data customer (placeholder dirender generic)
        return filter.emails.map(e => ({
          id: null, name: 'Pelanggan', customer_id: '', email: String(e).trim(),
          phone: '', address: '', package: null
        }));
      }
      if (filter.customer_ids?.length) {
        where.id = { [Op.in]: filter.customer_ids };
      } else {
        return [];
      }
      break;
    // 'all' → hanya filter email non-empty
  }

  const rows = await Customer.findAll({
    where,
    include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }],
    attributes: ['id','name','customer_id','email','phone','status','address'],
    order: [['name','ASC']]
  });
  // Filter format email valid — entri "0"/"-"/typo tidak ikut dikirim.
  return rows.map(r => r.toJSON()).filter(c => isValidEmail(c.email));
}

async function countTargets(targetType, filter) {
  try {
    if (targetType === 'custom') {
      if (filter?.mode === 'manual') return (filter.emails || []).filter(isValidEmail).length;
      if (filter?.customer_ids?.length) return filter.customer_ids.length;
      return 0;
    }
    const where = emailNotEmptyWhere();
    if (targetType === 'active')   where.status = 'active';
    if (targetType === 'by_package') {
      where.status = 'active';
      if (filter?.package_id) where.package_id = filter.package_id;
    }
    if (targetType === 'by_area') {
      if (filter?.province) where.province = filter.province;
      if (filter?.regency)  where.regency  = filter.regency;
      if (filter?.district) where.district = filter.district;
      if (filter?.village)  where.village  = filter.village;
    }
    if (targetType === 'overdue') {
      where.status = 'active';
      const overdueIds = await sequelize.query(
        "SELECT DISTINCT customer_id FROM invoices WHERE status IN ('unpaid','overdue') AND due_date < CURDATE()",
        { type: sequelize.QueryTypes.SELECT }
      );
      const ids = overdueIds.map(r => r.customer_id).filter(Boolean);
      where.id = { [Op.in]: ids.length ? ids : [-1] };
    }
    return await Customer.count({ where });
  } catch (e) {
    logger.warn(`[EmailBC] countTargets error: ${e.message}`);
    return 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
class EmailBroadcastController {

  // ── Stats ──────────────────────────────────────────────────────────
  async stats(req, res) {
    try {
      const EmailBroadcast = getModel();
      const [total, completed, running, scheduled, draft, failed, cancelled] = await Promise.all([
        EmailBroadcast.count(),
        EmailBroadcast.count({ where: { status: 'completed' } }),
        EmailBroadcast.count({ where: { status: 'running' } }),
        EmailBroadcast.count({ where: { status: 'scheduled' } }),
        EmailBroadcast.count({ where: { status: 'draft' } }),
        EmailBroadcast.count({ where: { status: 'failed' } }),
        EmailBroadcast.count({ where: { status: 'cancelled' } }),
      ]);
      const [sentRow] = await sequelize.query(
        "SELECT COALESCE(SUM(total_sent),0) AS total FROM email_broadcast",
        { type: sequelize.QueryTypes.SELECT }
      );
      // Jumlah customer yang punya email (untuk indikator coverage)
      const withEmail = await Customer.count({ where: emailNotEmptyWhere() });
      res.json({ success: true, data: { total, completed, running, scheduled, draft, failed, cancelled,
        total_sent: parseInt(sentRow?.total || 0), customers_with_email: withEmail } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── List ───────────────────────────────────────────────────────────
  async list(req, res) {
    try {
      const EmailBroadcast = getModel();
      const { page = 1, limit = 20, status, category } = req.query;
      const where = {};
      if (status) where.status = status;
      if (category) where.category = category;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const { count, rows } = await EmailBroadcast.findAndCountAll({
        where, offset, limit: parseInt(limit),
        order: [['created_at','DESC']]
      });
      const userIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))];
      let userMap = {};
      if (userIds.length) {
        const users = await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id','name'] });
        users.forEach(u => { userMap[u.id] = u.name; });
      }
      const data = rows.map(r => ({ ...r.toJSON(), created_by_name: userMap[r.created_by] || '-' }));
      res.json({ success: true, data, total: count, page: parseInt(page), limit: parseInt(limit) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Detail ─────────────────────────────────────────────────────────
  async detail(req, res) {
    try {
      const bc = await getModel().findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Broadcast tidak ditemukan' });
      res.json({ success: true, data: bc });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Create ─────────────────────────────────────────────────────────
  async create(req, res) {
    try {
      const { title, subject, category, message: msgBody, target_type, target_filter,
              scheduled_at, send_interval, manual_emails, customer_ids } = req.body;

      if (!title || !subject || !msgBody) {
        return res.status(400).json({ success: false, message: 'Judul, subjek, dan isi pesan wajib diisi' });
      }
      // Cek SMTP sudah dikonfigurasi sebelum buat broadcast — supaya user tidak
      // bikin broadcast yang pasti gagal.
      const EmailService = require('../services/EmailService');
      await EmailService._ensure();
      if (!EmailService.transporter) {
        return res.status(400).json({ success: false, message: 'SMTP belum dikonfigurasi. Atur dulu di Settings > Email.' });
      }

      let filter = target_filter || null;
      let finalType = target_type || 'all';
      const cat = CATEGORY_META[category] ? category : 'info';

      if (finalType === 'by_area') {
        const src = target_filter || {};
        const cleaned = {};
        ['province','regency','district','village'].forEach(k => {
          if (src[k] && String(src[k]).trim()) cleaned[k] = String(src[k]).trim();
        });
        if (!Object.keys(cleaned).length) {
          return res.status(400).json({ success: false, message: 'Pilih minimal provinsi untuk target per area' });
        }
        filter = cleaned;
      }

      if (finalType === 'custom') {
        if (manual_emails) {
          const emails = String(manual_emails).split(/[\n,;]+/)
            .map(e => e.trim().toLowerCase())
            .filter(isValidEmail);
          if (!emails.length) {
            return res.status(400).json({ success: false, message: 'Tidak ada alamat email valid di daftar manual' });
          }
          filter = { mode: 'manual', emails: [...new Set(emails)] };
        } else if (customer_ids && customer_ids.length) {
          const ids = (Array.isArray(customer_ids) ? customer_ids : [])
            .map(v => parseInt(v)).filter(n => Number.isFinite(n) && n > 0);
          if (!ids.length) return res.status(400).json({ success: false, message: 'Pilih minimal 1 customer' });
          const custs = await Customer.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id','email'] });
          const validIds = custs.filter(c => isValidEmail(c.email)).map(c => c.id);
          if (!validIds.length) {
            return res.status(400).json({ success: false, message: 'Tidak ada customer terpilih yang punya alamat email valid' });
          }
          filter = { mode: 'custom_select', customer_ids: validIds };
        } else {
          return res.status(400).json({ success: false, message: 'Target Manual harus diisi alamat email atau pilih customer dari daftar' });
        }
      }

      const interval = Math.max(1, Math.min(parseInt(send_interval) || 2, 120));
      const totalTgt = await countTargets(finalType, filter);
      if (totalTgt === 0) {
        return res.status(400).json({
          success: false,
          message: 'Tidak ada penerima dengan alamat email yang cocok dengan filter ini. Pastikan data email pelanggan sudah terisi.'
        });
      }

      const status = scheduled_at ? 'scheduled' : 'draft';
      const bc = await getModel().create({
        title, subject, category: cat,
        message: msgBody, target_type: finalType, target_filter: filter,
        status, scheduled_at: scheduled_at || null,
        total_targets: totalTgt, send_interval: interval,
        created_by: req.user?.id || null
      });

      res.status(201).json({ success: true, data: bc, message: `Broadcast email dibuat dengan ${totalTgt} penerima` });
    } catch (e) {
      logger.error('[EmailBC] create error: ' + (e.message || e));
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Send Now ───────────────────────────────────────────────────────
  async sendNow(req, res) {
    try {
      const bc = await getModel().findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Broadcast tidak ditemukan' });
      if (!['draft','scheduled'].includes(bc.status)) {
        return res.status(400).json({ success: false, message: `Tidak bisa kirim broadcast berstatus ${bc.status}` });
      }
      await bc.update({ status: 'running', scheduled_at: new Date(), started_at: new Date() });
      const ctrl = this;
      setImmediate(() => {
        ctrl._runBroadcast(bc.id).catch(e => logger.error('[EmailBC] run error: ' + e.message));
      });
      res.json({ success: true, message: 'Broadcast email mulai dijalankan' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Cancel ─────────────────────────────────────────────────────────
  async cancel(req, res) {
    try {
      const bc = await getModel().findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
      if (!['draft','scheduled','running'].includes(bc.status)) {
        return res.status(400).json({ success: false, message: 'Tidak bisa dibatalkan' });
      }
      await bc.update({ status: 'cancelled' });
      res.json({ success: true, message: 'Broadcast dibatalkan' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Delete ─────────────────────────────────────────────────────────
  async destroy(req, res) {
    try {
      const bc = await getModel().findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
      await bc.destroy();
      res.json({ success: true, message: 'Broadcast dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Preview count ──────────────────────────────────────────────────
  async previewCount(req, res) {
    try {
      const { target_type, package_id, manual_emails, customer_ids,
              province, regency, district, village } = req.query;
      let filter = null;
      if (target_type === 'by_package' && package_id) filter = { package_id: parseInt(package_id) };
      if (target_type === 'by_area') {
        filter = {};
        if (province) filter.province = province;
        if (regency)  filter.regency  = regency;
        if (district) filter.district = district;
        if (village)  filter.village  = village;
      }
      if (target_type === 'custom') {
        if (manual_emails) {
          const emails = String(manual_emails).split(/[\n,;]+/).map(e => e.trim()).filter(isValidEmail);
          filter = { mode: 'manual', emails };
        } else if (customer_ids) {
          const ids = String(customer_ids).split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n) && n > 0);
          filter = { customer_ids: ids };
        }
      }
      const count = await countTargets(target_type || 'all', filter);
      res.json({ success: true, count });
    } catch (e) {
      logger.warn(`[EmailBC] previewCount error: ${e.message}`);
      res.json({ success: true, count: 0 });
    }
  }

  // ── Search customers (yang punya email) ────────────────────────────
  async searchCustomers(req, res) {
    try {
      const { q, ids, limit } = req.query;
      const lim = Math.min(parseInt(limit) || 50, 200);
      const where = emailNotEmptyWhere();
      where.status = { [Op.in]: ['active', 'isolated'] };

      if (ids) {
        const idArr = String(ids).split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n) && n > 0);
        if (!idArr.length) return res.json({ success: true, data: [], total: 0 });
        where.id = { [Op.in]: idArr };
      } else if (q && q.trim()) {
        const qLike = '%' + q.trim() + '%';
        where[Op.or] = [
          { name: { [Op.like]: qLike } },
          { customer_id: { [Op.like]: qLike } },
          { email: { [Op.like]: qLike } }
        ];
      }

      const rows = await Customer.findAll({
        where,
        include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }],
        attributes: ['id','customer_id','name','email','phone','status','address'],
        order: [['name','ASC']],
        limit: lim
      });
      const total = await Customer.count({ where });
      res.json({ success: true, data: rows.map(r => r.toJSON()), total, limit: lim });
    } catch (e) {
      logger.error(`[EmailBC] searchCustomers error: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Preview rendered email HTML ────────────────────────────────────
  // POST body: { subject, category, message } → render dengan data contoh.
  async preview(req, res) {
    try {
      const { subject, category, message } = req.body || {};
      const brand = await getBranding(true);
      const sample = {
        id: null, name: 'Budi Santoso', customer_id: 'CST-0001',
        email: 'budi@example.com', phone: '6281234567890',
        address: 'Jl. Merdeka No. 1',
        package: { name: 'Home 20 Mbps', price: 200000 }
      };
      const renderedBody = await renderPlaceholders(message || '', sample, { brand, invoice: null });
      const renderedSubject = await renderPlaceholders(subject || '', sample, { brand, invoice: null });
      const html = buildEmailHtml({ category: category || 'info', bodyText: renderedBody, brand });
      res.json({ success: true, html, subject: renderedSubject });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Send test email ────────────────────────────────────────────────
  // POST body: { to, subject, category, message }
  async sendTest(req, res) {
    try {
      const { to, subject, category, message } = req.body || {};
      if (!isValidEmail(to)) return res.status(400).json({ success: false, message: 'Alamat email tujuan tidak valid' });
      if (!subject || !message) return res.status(400).json({ success: false, message: 'Subjek dan isi pesan wajib diisi' });

      const EmailService = require('../services/EmailService');
      const brand = await getBranding(true);
      const sample = {
        id: null, name: 'Budi Santoso', customer_id: 'CST-0001',
        email: to, phone: '6281234567890', address: 'Jl. Merdeka No. 1',
        package: { name: 'Home 20 Mbps', price: 200000 }
      };
      const renderedBody = await renderPlaceholders(message, sample, { brand, invoice: null });
      const renderedSubject = await renderPlaceholders(subject, sample, { brand, invoice: null });
      const html = buildEmailHtml({ category: category || 'info', bodyText: renderedBody, brand });

      const ok = await EmailService.send({ to, subject: '[TEST] ' + renderedSubject, html, type: 'email_broadcast', noRetry: true });
      if (!ok) return res.status(400).json({ success: false, message: 'Gagal kirim — periksa konfigurasi SMTP di Settings' });
      res.json({ success: true, message: 'Email test terkirim ke ' + to });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Run broadcast engine ───────────────────────────────────────────
  async _runBroadcast(broadcastId) {
    const EmailBroadcast = getModel();
    const bc = await EmailBroadcast.findByPk(broadcastId);
    if (!bc || bc.status === 'cancelled') return;

    const EmailService = require('../services/EmailService');
    await EmailService._ensure();
    if (!EmailService.transporter) {
      await bc.update({ status: 'failed' });
      logger.error(`[EmailBC #${bc.id}] SMTP belum dikonfigurasi`);
      return;
    }

    const targets = await getTargets(bc);
    await bc.update({ total_targets: targets.length, started_at: new Date() });

    if (!targets.length) {
      await bc.update({ status: 'completed', completed_at: new Date() });
      return;
    }

    const interval = Math.max(1, bc.send_interval || 2) * 1000;
    let sent = 0, failed = 0;
    logger.info(`[EmailBC #${bc.id}] Starting: ${targets.length} targets, interval ${bc.send_interval}s`);

    const brand = await getBranding(true);

    for (const cust of targets) {
      // Cancel-aware: cek status fresh tiap iterasi
      const fresh = await EmailBroadcast.findByPk(bc.id, { attributes: ['status'] });
      if (fresh?.status === 'cancelled') {
        logger.info(`[EmailBC #${bc.id}] Cancelled mid-run at ${sent} sent`);
        break;
      }

      try {
        if (!isValidEmail(cust.email)) { failed++; continue; }
        const bodyText = await renderPlaceholders(bc.message, cust, { brand });
        const subjText = await renderPlaceholders(bc.subject, cust, { brand, invoice: null });
        const html = buildEmailHtml({ category: bc.category, bodyText, brand });
        const ok = await EmailService.send({ to: cust.email, subject: subjText, html, type: 'email_broadcast', noRetry: true });
        if (ok) sent++; else failed++;
        if ((sent + failed) % 5 === 0) await bc.update({ total_sent: sent, total_failed: failed });
      } catch (e) {
        failed++;
        logger.warn(`[EmailBC #${bc.id}] Failed to send: ${e.message}`);
      }

      // Throttle: interval + jitter 0-1 detik untuk hindari rate limit SMTP
      if (sent + failed < targets.length) {
        const jitter = Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, interval + jitter));
      }
    }

    await bc.update({
      status: 'completed',
      total_sent: sent,
      total_failed: failed,
      completed_at: new Date()
    });
    logger.info(`[EmailBC #${bc.id}] Done: ${sent} sent, ${failed} failed`);
  }
}

module.exports = new EmailBroadcastController();
