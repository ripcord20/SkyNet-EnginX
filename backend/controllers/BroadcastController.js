/**
 * BroadcastController.js
 * WA Broadcast dengan sistem anti-block (interval delay per pesan)
 */
const { WaBroadcast, WaTemplate, Customer, Package, WaSession, User, sequelize } = require('../models');
const { Op } = require('sequelize');
const moment = require('moment');
const logger = require('../utils/logger');

// ── Helpers ──────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

const MONTHS_ID = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// Cache company name per process — sekali fetch, dipakai semua broadcast.
// Reset null saat process restart (cron deploy).
let _companyNameCache = null;
async function getCompanyName() {
  if (_companyNameCache !== null) return _companyNameCache;
  try {
    const { AppSetting } = require('../models');
    const row = await AppSetting.findOne({ where: { key: 'company_name' } });
    _companyNameCache = (row?.value || process.env.COMPANY_NAME || 'Internet Service').toString();
  } catch (e) {
    _companyNameCache = process.env.COMPANY_NAME || 'Internet Service';
  }
  return _companyNameCache;
}

// Ambil invoice paling relevan untuk customer (unpaid/overdue terbaru,
// fallback ke invoice terbaru apapun statusnya). Returns null kalau tidak ada.
async function getLatestInvoice(customerId) {
  if (!customerId) return null;
  try {
    const { Invoice } = require('../models');
    // Prioritas: unpaid/overdue dengan due_date terdekat (sudah lewat dulu)
    let inv = await Invoice.findOne({
      where: { customer_id: customerId, status: { [Op.in]: ['unpaid','overdue'] } },
      order: [['due_date', 'ASC']],
    });
    if (!inv) {
      // Fallback ke invoice terbaru apapun statusnya
      inv = await Invoice.findOne({
        where: { customer_id: customerId },
        order: [['created_at', 'DESC']],
      });
    }
    return inv ? inv.toJSON() : null;
  } catch (e) {
    logger.warn(`[Broadcast] getLatestInvoice failed for customer ${customerId}: ${e.message}`);
    return null;
  }
}

// Render template — async sekarang karena perlu fetch invoice + company name.
// Mendukung SEMUA placeholder yang sama dengan reminder/billing:
//   {nama} {cid} {paket} {harga} {phone} {nohp} {alamat}
//   {invoice} {periode} {jumlah} {jatuh_tempo} {tgl_jatuh_tempo} {status}
//   {perusahaan} {duedate}
// Placeholder tidak dikenal (mis. {custom_field}) dibiarkan apa adanya.
async function renderTemplate(msg, cust, opts = {}) {
  if (!msg) return '';
  const companyName = opts.companyName || await getCompanyName();
  const invoice = opts.invoice !== undefined
    ? opts.invoice
    : await getLatestInvoice(cust.id);

  const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const fmtDate = d => d ? moment(d).format('D MMMM YYYY') : '-';
  const fmtDateShort = d => d ? moment(d).format('DD/MM/YYYY') : '-';

  const periodeStr = invoice?.period_month
    ? (MONTHS_ID[invoice.period_month] || invoice.period_month) + ' ' + (invoice.period_year || '')
    : '-';
  const jumlahStr = invoice ? fmtRp(invoice.total) : '-';
  const jatuhTempoStr = invoice ? fmtDate(invoice.due_date) : '-';
  const statusStr = invoice
    ? (invoice.status === 'overdue' ? '⚠️ JATUH TEMPO' : 'segera jatuh tempo')
    : '-';

  const vars = {
    '{nama}':            cust.name || '',
    '{cid}':             cust.customer_id || cust.cid || '',
    '{paket}':           cust.package?.name || cust.paket || '–',
    '{harga}':           fmtRp(cust.package?.price || cust.harga || 0),
    '{phone}':           cust.phone || '',
    '{nohp}':            cust.phone || '',           // alias
    '{alamat}':          cust.address || '-',
    '{invoice}':         invoice?.invoice_number || '-',
    '{periode}':         periodeStr,
    '{jumlah}':          jumlahStr,
    '{jatuh_tempo}':     jatuhTempoStr,
    '{tgl_jatuh_tempo}': jatuhTempoStr,              // alias
    '{duedate}':         invoice ? fmtDateShort(invoice.due_date) : '-',
    '{status}':          statusStr,
    '{perusahaan}':      companyName,
  };

  return Object.keys(vars).reduce((acc, k) => acc.split(k).join(vars[k]), msg);
}

async function getTargets(bc) {
  const filter = bc.target_filter || {};
  // PERBAIKAN: filter phone harus konsisten antara getTargets() & countTargets().
  // Sebelumnya getTargets pakai (NOT NULL AND != ''), sedang countTargets cuma (!= '').
  // Akibatnya: customer dengan phone=NULL ke-count di preview tapi tidak terkirim,
  // bikin user kaget. Sekarang dipakai helper yg sama.
  let where = phoneNotEmptyWhere();

  switch (bc.target_type) {
    case 'active':
      where.status = 'active'; break;
    case 'overdue': {
      where.status = 'active';
      // Cari customer yang punya invoice overdue/unpaid (lewat tempo)
      const overdueIds = await sequelize.query(
        "SELECT DISTINCT customer_id FROM invoices WHERE status IN ('unpaid','overdue') AND due_date < CURDATE()",
        { type: sequelize.QueryTypes.SELECT }
      );
      const ids = overdueIds.map(r => r.customer_id).filter(Boolean);
      // PERBAIKAN: kalau tidak ada customer overdue, paksa where yang tidak match apapun
      // supaya tidak ada risk Sequelize translate `[Op.in]:[]` jadi `WHERE 1=1`.
      // -1 dijamin tidak match karena id auto-increment > 0.
      where.id = { [Op.in]: ids.length ? ids : [-1] };
      break;
    }
    case 'by_package':
      // PERBAIKAN: tambahkan filter status='active' agar konsisten dgn 'active'/'overdue'.
      // Customer suspended yang masih punya paket tidak perlu ikut broadcast.
      where.status = 'active';
      if (filter.package_id) where.package_id = filter.package_id;
      break;
    case 'custom':
      if (filter.mode === 'manual' && filter.phones?.length) {
        // Nomor manual — kembalikan langsung tanpa query customer
        return filter.phones.map(p => ({
          id: null, name: 'Pelanggan', customer_id: '', phone: normalizePhone(p),
          package: null
        }));
      }
      if (filter.customer_ids?.length) {
        where.id = { [Op.in]: filter.customer_ids };
      } else {
        // PERBAIKAN: target custom tanpa filter apapun → return [] (bukan return semua)
        return [];
      }
      break;
    // 'all' → no filter (selain phone non-empty)
  }

  const rows = await Customer.findAll({
    where,
    include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }],
    attributes: ['id','name','customer_id','phone','status','address'],
    order: [['name','ASC']]
  });
  return rows.map(r => r.toJSON());
}

// Helper: where clause untuk phone non-empty. Dipakai konsisten di
// getTargets() & countTargets() supaya preview match dengan actual target.
function phoneNotEmptyWhere() {
  return {
    phone: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] }
  };
}

async function countTargets(targetType, filter) {
  try {
    // PERBAIKAN: handle semua mode `custom` (manual + customer_ids).
    // Sebelumnya cuma manual yang di-count, customer_ids return 0.
    if (targetType === 'custom') {
      if (filter?.mode === 'manual') return (filter.phones||[]).length;
      if (filter?.customer_ids?.length) return filter.customer_ids.length;
      return 0;
    }

    // PERBAIKAN: phone filter konsisten dengan getTargets() (NOT NULL AND != '').
    const where = phoneNotEmptyWhere();

    if (targetType === 'active')   where.status = 'active';
    if (targetType === 'by_package') {
      where.status = 'active';
      if (filter?.package_id) where.package_id = filter.package_id;
    }
    if (targetType === 'overdue') {
      // PERBAIKAN BESAR: sebelumnya cuma `status='active'`, sekarang
      // ikut subquery yang sama dengan getTargets supaya preview & target
      // konsisten. User yang lihat "50 penerima" akan benar-benar 50.
      where.status = 'active';
      const overdueIds = await sequelize.query(
        "SELECT DISTINCT customer_id FROM invoices WHERE status IN ('unpaid','overdue') AND due_date < CURDATE()",
        { type: sequelize.QueryTypes.SELECT }
      );
      const ids = overdueIds.map(r => r.customer_id).filter(Boolean);
      where.id = { [Op.in]: ids.length ? ids : [-1] };
    }
    return await Customer.count({ where });
  } catch(e) {
    logger.warn(`[Broadcast] countTargets error: ${e.message}`);
    return 0;
  }
}

class BroadcastController {

  // ── Stats ────────────────────────────────────────────────────
  async stats(req, res) {
    try {
      const [total, completed, running, scheduled, draft, failed, cancelled] = await Promise.all([
        WaBroadcast.count(),
        WaBroadcast.count({ where: { status: 'completed' } }),
        WaBroadcast.count({ where: { status: 'running' } }),
        WaBroadcast.count({ where: { status: 'scheduled' } }),
        WaBroadcast.count({ where: { status: 'draft' } }),
        WaBroadcast.count({ where: { status: 'failed' } }),
        WaBroadcast.count({ where: { status: 'cancelled' } }),
      ]);
      const [sentRow] = await sequelize.query(
        "SELECT COALESCE(SUM(total_sent),0) AS total FROM wa_broadcast",
        { type: sequelize.QueryTypes.SELECT }
      );
      res.json({ success: true, data: { total, completed, running, scheduled, draft, failed, cancelled, total_sent: parseInt(sentRow?.total||0) } });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── List ─────────────────────────────────────────────────────
  async list(req, res) {
    try {
      const { page = 1, limit = 20, status } = req.query;
      const where = {};
      if (status) where.status = status;
      const offset = (parseInt(page)-1) * parseInt(limit);
      const { count, rows } = await WaBroadcast.findAndCountAll({
        where, offset, limit: parseInt(limit),
        order: [['created_at','DESC']]
      });
      // Attach creator name
      const userIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))];
      let userMap = {};
      if (userIds.length) {
        const users = await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id','name'] });
        users.forEach(u => { userMap[u.id] = u.name; });
      }
      const data = rows.map(r => ({ ...r.toJSON(), created_by_name: userMap[r.created_by] || '–' }));
      res.json({ success: true, data, total: count, page: parseInt(page), limit: parseInt(limit) });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Create ───────────────────────────────────────────────────
  async create(req, res) {
    try {
      const { title, template_id, message: msgBody, target_type, target_filter,
              scheduled_at, send_interval, manual_numbers, customer_ids } = req.body;

      if (!title || !msgBody) return res.status(400).json({ success: false, message: 'Judul dan pesan wajib diisi' });

      let filter = target_filter || null;
      let finalType = target_type || 'all';

      // Handle target_type='custom' — bisa manual_numbers ATAU customer_ids.
      // PERBAIKAN: validate dulu sebelum create — kalau target_type=custom
      // tapi tidak ada nomor & customer_ids, return error (sebelumnya broadcast
      // dengan 0 target tetap dibuat).
      if (finalType === 'custom') {
        if (manual_numbers) {
          const phones = manual_numbers.split(/[\n,;]+/)
            .map(p => normalizePhone(p.trim()))
            .filter(p => p.length >= 10);
          if (!phones.length) {
            return res.status(400).json({ success: false, message: 'Tidak ada nomor valid di daftar manual' });
          }
          filter = { mode: 'manual', phones: [...new Set(phones)] };
        } else if (customer_ids && customer_ids.length) {
          // Validasi tipe — customer_ids harus array of number
          const ids = (Array.isArray(customer_ids) ? customer_ids : [])
            .map(v => parseInt(v))
            .filter(n => Number.isFinite(n) && n > 0);
          if (!ids.length) {
            return res.status(400).json({ success: false, message: 'Pilih minimal 1 customer' });
          }
          // Fetch phone untuk validasi — pastikan customer ada & punya HP.
          // Sekaligus pre-compute phones supaya tidak perlu query lagi saat run.
          const custs = await Customer.findAll({
            where: { id: { [Op.in]: ids } },
            attributes: ['id','phone']
          });
          const validIds = custs
            .filter(c => c.phone && normalizePhone(c.phone).length >= 10)
            .map(c => c.id);
          if (!validIds.length) {
            return res.status(400).json({ success: false, message: 'Tidak ada customer terpilih yang punya nomor HP valid' });
          }
          filter = { mode: 'custom_select', customer_ids: validIds };
        } else {
          return res.status(400).json({ success: false, message: 'Target Manual harus diisi nomor HP atau pilih customer dari daftar' });
        }
      }

      const interval  = Math.max(8, parseInt(send_interval) || 10);
      const totalTgt  = await countTargets(finalType, filter);

      // PERBAIKAN: jangan buat broadcast kalau totalTgt=0 (mis. filter overdue
      // tapi tidak ada invoice overdue). Sebelumnya broadcast dibuat dengan 0
      // target — bikin entri "completed" tanpa kirim apapun yang membingungkan.
      if (totalTgt === 0) {
        return res.status(400).json({
          success: false,
          message: 'Tidak ada penerima yang cocok dengan filter ini. Coba target type lain atau periksa data customer.'
        });
      }

      const status    = scheduled_at ? 'scheduled' : 'draft';

      const bc = await WaBroadcast.create({
        title, template_id: template_id || null,
        message: msgBody, target_type: finalType,
        target_filter: filter,
        status, scheduled_at: scheduled_at || null,
        total_targets: totalTgt,
        send_interval: interval,
        created_by: req.user?.id || null
      });

      res.status(201).json({ success: true, data: bc, message: `Broadcast dibuat dengan ${totalTgt} target` });
    } catch(e) {
      logger.error('[Broadcast] create error:', e);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Send Now (draft → scheduled → run) ───────────────────────
  async sendNow(req, res) {
    try {
      const bc = await WaBroadcast.findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Broadcast tidak ditemukan' });
      if (!['draft','scheduled'].includes(bc.status)) {
        return res.status(400).json({ success: false, message: `Tidak bisa kirim broadcast berstatus ${bc.status}` });
      }
      // PERBAIKAN: await update SEBELUM trigger _runBroadcast supaya tidak
      // ada race condition (sebelumnya bc.update dipanggil tanpa await,
      // _runBroadcast bisa mulai baca status lama). Setelah update commit,
      // baru launch async task.
      await bc.update({ status: 'running', scheduled_at: new Date(), started_at: new Date() });
      // Reference function langsung dari prototype supaya tidak depend pada
      // `this` context (yang kadang lost saat dipanggil dari arrow callback
      // di Express router).
      const ctrl = this;
      setImmediate(() => {
        ctrl._runBroadcast(bc.id).catch(e =>
          logger.error('[Broadcast] run error:', e.message));
      });
      res.json({ success: true, message: 'Broadcast mulai dijalankan' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Cancel ───────────────────────────────────────────────────
  async cancel(req, res) {
    try {
      const bc = await WaBroadcast.findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
      if (!['draft','scheduled','running'].includes(bc.status)) {
        return res.status(400).json({ success: false, message: 'Tidak bisa dibatalkan' });
      }
      await bc.update({ status: 'cancelled' });
      res.json({ success: true, message: 'Broadcast dibatalkan' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Delete ───────────────────────────────────────────────────
  async destroy(req, res) {
    try {
      const bc = await WaBroadcast.findByPk(req.params.id);
      if (!bc) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
      await bc.destroy();
      res.json({ success: true, message: 'Broadcast dihapus' });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── Count targets preview ────────────────────────────────────
  async previewCount(req, res) {
    try {
      const { target_type, package_id, manual_numbers, customer_ids } = req.query;
      let filter = null;
      if (target_type === 'by_package' && package_id) {
        filter = { package_id: parseInt(package_id) };
      }
      if (target_type === 'custom') {
        // PERBAIKAN: previewCount sekarang support kedua mode `custom`:
        //   - manual_numbers (mode lama)
        //   - customer_ids (mode baru: pick from list dengan checkbox)
        if (manual_numbers) {
          const phones = manual_numbers.split(/[\n,;]+/)
            .map(p => normalizePhone(p.trim()))
            .filter(p => p.length >= 10);
          filter = { mode: 'manual', phones };
        } else if (customer_ids) {
          // customer_ids dikirim sebagai string CSV: "1,2,3,4"
          const ids = String(customer_ids)
            .split(',')
            .map(s => parseInt(s.trim()))
            .filter(n => Number.isFinite(n) && n > 0);
          filter = { customer_ids: ids };
        }
      }
      const count = await countTargets(target_type || 'all', filter);
      res.json({ success: true, count });
    } catch(e) {
      logger.warn(`[Broadcast] previewCount error: ${e.message}`);
      res.json({ success: true, count: 0 });
    }
  }

  // ── Search customers untuk target picker (BARU) ──────────────
  // GET /api/broadcast/search-customers?q=<query>&limit=50
  //
  // Endpoint khusus untuk modal "Pilih Customer" di form broadcast.
  // Berbeda dengan /api/payments/customers:
  //   - Filter: HANYA customer yang punya HP (phone IS NOT NULL & != '')
  //     — broadcast tanpa HP percuma
  //   - Status: 'active' & 'isolated' (suspended tidak relevan untuk broadcast)
  //   - Field: include `package.name` untuk display di list
  //   - Limit default 50 (vs 30 di payment search) — broadcast biasanya pilih
  //     banyak sekaligus, butuh list lebih panjang
  //   - Optional `ids` param: untuk re-fetch customer terpilih lewat ID
  //     supaya saat user re-open form, customer terpilih tetap muncul
  //     dengan nama+detail (bukan cuma ID).
  async searchCustomers(req, res) {
    try {
      const { q, ids, limit } = req.query;
      const lim = Math.min(parseInt(limit) || 50, 200);

      const where = phoneNotEmptyWhere();
      where.status = { [Op.in]: ['active', 'isolated'] };

      if (ids) {
        // Mode fetch-by-IDs (untuk restore pilihan saat re-open form)
        const idArr = String(ids).split(',')
          .map(s => parseInt(s.trim()))
          .filter(n => Number.isFinite(n) && n > 0);
        if (!idArr.length) return res.json({ success: true, data: [], total: 0 });
        where.id = { [Op.in]: idArr };
      } else if (q && q.trim()) {
        // Mode search by query
        const qLike = '%' + q.trim() + '%';
        where[Op.or] = [
          { name: { [Op.like]: qLike } },
          { customer_id: { [Op.like]: qLike } },
          { phone: { [Op.like]: qLike } }
        ];
      }
      // Kalau tidak ada `q` & tidak ada `ids` → return list awal (limit teratas
      // berdasar name). Berguna untuk "saat modal dibuka, langsung tampilkan
      // beberapa customer".

      const rows = await Customer.findAll({
        where,
        include: [{ model: Package, as: 'package', attributes: ['name','price'], required: false }],
        attributes: ['id','customer_id','name','phone','status','address'],
        order: [['name', 'ASC']],
        limit: lim
      });
      // Total count tanpa limit (untuk indikator "X dari N customer")
      const total = await Customer.count({ where });

      res.json({
        success: true,
        data: rows.map(r => r.toJSON()),
        total,
        limit: lim
      });
    } catch(e) {
      logger.error(`[Broadcast] searchCustomers error: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Run broadcast (anti-block engine) ────────────────────────
  async _runBroadcast(broadcastId) {
    const bc = await WaBroadcast.findByPk(broadcastId);
    if (!bc || bc.status === 'cancelled') return;

    const GatewayService = require('../services/GatewayService');
    const session   = await GatewayService.getDefaultSendingSession();
    if (session) await GatewayService.warmSession(session.session_id);
    if (!session || !GatewayService.isConnected(session.session_id)) {
      await bc.update({ status: 'failed' });
      logger.error(`[Broadcast #${bc.id}] No WA session connected`);
      return;
    }

    const targets = await getTargets(bc);
    await bc.update({ total_targets: targets.length, started_at: new Date() });

    if (!targets.length) {
      await bc.update({ status: 'completed', completed_at: new Date() });
      return;
    }

    const interval = Math.max(8, bc.send_interval || 10) * 1000; // convert to ms
    let sent = 0, failed = 0;

    logger.info(`[Broadcast #${bc.id}] Starting: ${targets.length} targets, interval ${bc.send_interval}s`);

    // Pre-fetch company name sekali — dipakai untuk semua customer di batch ini.
    // renderTemplate akan re-use lewat opts supaya tidak query AppSetting per pesan.
    const companyName = await getCompanyName();

    for (const cust of targets) {
      // Cek apakah dibatalkan di tengah jalan
      const fresh = await WaBroadcast.findByPk(bc.id, { attributes: ['status'] });
      if (fresh?.status === 'cancelled') {
        logger.info(`[Broadcast #${bc.id}] Cancelled mid-run at ${sent} sent`);
        break;
      }

      try {
        const phone = normalizePhone(cust.phone);
        if (!phone) { failed++; continue; }
        // Render dengan placeholder lengkap — fetch invoice per customer
        const msg = await renderTemplate(bc.message, cust, { companyName });
        await GatewayService.sendMessage(session.session_id, phone, msg, null);
        sent++;
        // Update progress tiap 10 pesan
        if (sent % 10 === 0) await bc.update({ total_sent: sent });
        logger.debug(`[Broadcast #${bc.id}] Sent ${sent}/${targets.length} → ${phone}`);
      } catch(e) {
        failed++;
        logger.warn(`[Broadcast #${bc.id}] Failed to send: ${e.message}`);
      }

      // ── ANTI-BLOCK: delay antar pesan + random jitter ─────
      // Base interval + random 0-2 detik jitter untuk menghindari pattern
      if (sent + failed < targets.length) {
        const jitter = Math.floor(Math.random() * 2000);
        await new Promise(r => setTimeout(r, interval + jitter));
      }
    }

    await bc.update({
      status: 'completed',
      total_sent: sent,
      total_failed: failed,
      completed_at: new Date()
    });
    logger.info(`[Broadcast #${bc.id}] Done: ${sent} sent, ${failed} failed`);
  }
}

module.exports = new BroadcastController();
