/**
 * CollectionService
 * ─────────────────────────────────────────────────────────────────────────────
 * Logika inti modul Field Collection (penagihan lapangan). Dipakai oleh
 * CollectionController (admin) dan nanti CollectorFieldController (lapangan).
 *
 * Tanggung jawab:
 *   - generateTasks()   : buat CollectionAssignment 'pending' dari invoice belum
 *                         lunas (dipanggil cron tiap periode + tombol manual).
 *   - assign()          : tugaskan satu/banyak assignment ke seorang kolektor.
 *   - autoAssignByArea(): bagikan otomatis berdasar area kerja kolektor.
 *   - adminStats()      : ringkasan untuk dashboard admin.
 *   - recomputeCashHeld(): hitung ulang saldo kas kolektor dari sumber data.
 *
 * Semua uang dalam Rupiah penuh.
 */
const { Op } = require('sequelize');
const moment = require('moment');

const {
  sequelize, Invoice, Customer, Package, User, Role,
  CollectionAssignment, CollectorProfile, CashDeposit, Payment
} = require('../models');

// Status invoice yang dianggap "belum lunas" → layak dibuatkan task tagih.
const UNPAID_INVOICE_STATUSES = ['unpaid', 'overdue'];

// Status assignment yang dianggap "masih aktif" (belum tuntas) — dipakai untuk
// mencegah duplikasi task atas invoice yang sama.
const ACTIVE_ASSIGNMENT_STATUSES = [
  'pending', 'assigned', 'in_progress', 'promise_to_pay', 'not_home', 'partial_paid'
];

class CollectionService {
  /**
   * Generate task penagihan dari invoice yang belum lunas.
   *
   * @param {Object} opts
   * @param {number} [opts.month]  periode bulan (default: bulan berjalan)
   * @param {number} [opts.year]   periode tahun (default: tahun berjalan)
   * @param {boolean} [opts.onlyOverdue]  hanya yang sudah lewat jatuh tempo
   * @returns {Promise<{created:number, skipped:number, total:number}>}
   */
  static async generateTasks(opts = {}) {
    const month = opts.month || (moment().month() + 1);
    const year  = opts.year  || moment().year();
    const today = moment().format('YYYY-MM-DD');

    const where = {
      status: { [Op.in]: UNPAID_INVOICE_STATUSES },
      period_month: month,
      period_year: year
    };
    if (opts.onlyOverdue) where.due_date = { [Op.lt]: today };

    const invoices = await Invoice.findAll({
      where,
      include: [{
        model: Customer, as: 'customer',
        attributes: ['id', 'customer_id', 'name', 'regency', 'district', 'village', 'status'],
        required: true
      }]
    });

    let created = 0, skipped = 0;

    for (const inv of invoices) {
      // Lewati kalau sudah ada assignment aktif untuk invoice ini.
      const existing = await CollectionAssignment.findOne({
        where: {
          invoice_id: inv.id,
          status: { [Op.in]: ACTIVE_ASSIGNMENT_STATUSES }
        }
      });
      if (existing) { skipped++; continue; }

      const c = inv.customer;
      await CollectionAssignment.create({
        invoice_id:    inv.id,
        customer_id:   c.id,
        collector_id:  null,
        status:        'pending',
        amount_due:    inv.total,
        period_month:  inv.period_month,
        period_year:   inv.period_year,
        area_regency:  c.regency  || null,
        area_district: c.district || null,
        area_village:  c.village  || null,
        scheduled_date: today
      });
      created++;
    }

    return { created, skipped, total: invoices.length };
  }

  /**
   * Tugaskan sejumlah assignment ke seorang kolektor.
   * Mengubah status 'pending' → 'assigned' (status lain dibiarkan apa adanya
   * supaya tidak menimpa progres lapangan yang sudah berjalan).
   *
   * @param {number[]} assignmentIds
   * @param {number}   collectorId
   * @param {number}   assignedBy   user id admin
   */
  static async assign(assignmentIds, collectorId, assignedBy) {
    if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      throw new Error('Tidak ada assignment yang dipilih');
    }
    const collector = await User.findByPk(collectorId, { include: [{ model: Role, as: 'role' }] });
    if (!collector) throw new Error('Kolektor tidak ditemukan');
    if ((collector.role?.name || '').toLowerCase() !== 'collector') {
      throw new Error('User yang dipilih bukan kolektor');
    }

    const [count] = await CollectionAssignment.update(
      { collector_id: collectorId, assigned_by: assignedBy, status: 'assigned' },
      {
        where: {
          id: { [Op.in]: assignmentIds },
          status: 'pending'   // hanya yg masih pending yang dipindah ke assigned
        }
      }
    );

    // Untuk assignment yang sudah ter-assign sebelumnya (mis. re-assign), update
    // collector tanpa memaksa status balik ke 'assigned'.
    await CollectionAssignment.update(
      { collector_id: collectorId, assigned_by: assignedBy },
      {
        where: {
          id: { [Op.in]: assignmentIds },
          status: { [Op.in]: ['assigned', 'in_progress', 'not_home', 'promise_to_pay'] }
        }
      }
    );

    return { assigned: count };
  }

  /**
   * Auto-assign assignment 'pending' berdasarkan kecocokan area kolektor.
   * Mencocokkan area_regency/district assignment dengan region kolektor
   * (substring, case-insensitive). Kolektor tanpa region dilewati.
   */
  static async autoAssignByArea(assignedBy) {
    const collectors = await CollectorProfile.findAll({
      where: { is_active: true, region: { [Op.ne]: null } },
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }]
    });

    const pending = await CollectionAssignment.findAll({ where: { status: 'pending' } });
    let assigned = 0;

    for (const a of pending) {
      const hay = `${a.area_regency || ''} ${a.area_district || ''} ${a.area_village || ''}`.toLowerCase();
      const match = collectors.find(c => {
        const region = (c.region || '').toLowerCase().trim();
        return region && hay.includes(region);
      });
      if (match && match.user) {
        await a.update({ collector_id: match.user.id, assigned_by: assignedBy, status: 'assigned' });
        assigned++;
      }
    }
    return { assigned, pending_total: pending.length };
  }

  /**
   * Ringkasan dashboard admin.
   */
  static async adminStats(opts = {}) {
    const month = opts.month || (moment().month() + 1);
    const year  = opts.year  || moment().year();
    const base  = { period_month: month, period_year: year };

    const rows = await CollectionAssignment.findAll({
      attributes: [
        'status',
        [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_due')), 0), 'sum_due'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_collected')), 0), 'sum_collected']
      ],
      where: base,
      group: ['status'],
      raw: true
    });

    const byStatus = {};
    let totalTask = 0, totalDue = 0, totalCollected = 0;
    for (const r of rows) {
      const cnt = parseInt(r.cnt, 10) || 0;
      byStatus[r.status] = {
        count: cnt,
        due: parseFloat(r.sum_due) || 0,
        collected: parseFloat(r.sum_collected) || 0
      };
      totalTask += cnt;
      totalDue  += parseFloat(r.sum_due) || 0;
      totalCollected += parseFloat(r.sum_collected) || 0;
    }

    const paidCount    = (byStatus.paid?.count || 0) + (byStatus.partial_paid?.count || 0);
    const promiseCount = byStatus.promise_to_pay?.count || 0;
    const pendingCount = byStatus.pending?.count || 0;

    // Total kas belum disetor (cash on hand) seluruh kolektor.
    const cashHeldRow = await CollectorProfile.findOne({
      attributes: [[sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cash_held')), 0), 'total']],
      raw: true
    });

    return {
      period: { month, year },
      totals: {
        task: totalTask,
        due: totalDue,
        collected: totalCollected,
        outstanding: Math.max(totalDue - totalCollected, 0),
        paid_count: paidCount,
        promise_count: promiseCount,
        pending_count: pendingCount,
        cash_on_hand: parseFloat(cashHeldRow?.total) || 0
      },
      by_status: byStatus
    };
  }

  /**
   * Laporan per kolektor untuk satu periode.
   * Mengembalikan, per kolektor: jumlah task, jumlah invoice tertagih
   * (paid + partial_paid), total nominal terkumpul, dan komisi terhitung
   * berdasarkan skema profil (flat / percent / none).
   *
   * Komisi:
   *   - flat    : commission_value Rp × jumlah invoice yang berhasil ditagih
   *   - percent : commission_value % × total nominal terkumpul
   *   - none    : 0
   *
   * @param {Object} opts { month, year }
   * @returns {Promise<{period, rows:[], totals:{}}>}
   */
  static async collectorReport(opts = {}) {
    const month = opts.month || (moment().month() + 1);
    const year  = opts.year  || moment().year();

    // Agregasi assignment yang berhasil ditagih, dikelompokkan per kolektor.
    const PAID_STATUSES = ['paid', 'partial_paid'];
    const rows = await CollectionAssignment.findAll({
      attributes: [
        'collector_id',
        [sequelize.fn('COUNT', sequelize.col('CollectionAssignment.id')), 'task_count'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount_collected')), 0), 'collected'],
        [sequelize.fn('SUM', sequelize.literal(
          `CASE WHEN status IN ('paid','partial_paid') THEN 1 ELSE 0 END`
        )), 'paid_count'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.literal(
          `CASE WHEN status IN ('paid','partial_paid') THEN amount_collected ELSE 0 END`
        )), 0), 'paid_collected']
      ],
      where: {
        period_month: month,
        period_year: year,
        collector_id: { [Op.ne]: null }
      },
      group: ['collector_id'],
      raw: true
    });

    // Ambil profil & nama kolektor sekaligus.
    const collectorIds = rows.map(r => r.collector_id).filter(Boolean);
    let users = [], profiles = [];
    if (collectorIds.length) {
      users = await User.findAll({
        where: { id: { [Op.in]: collectorIds } },
        attributes: ['id', 'name'],
        raw: true
      });
      profiles = await CollectorProfile.findAll({
        where: { user_id: { [Op.in]: collectorIds } },
        attributes: ['user_id', 'commission_type', 'commission_value', 'cash_held'],
        raw: true
      });
    }
    const userMap = {};    users.forEach(u => { userMap[u.id] = u.name; });
    const profMap = {};    profiles.forEach(p => { profMap[p.user_id] = p; });

    // Status pembayaran komisi periode ini (per kolektor).
    const paidMap = {};
    try {
      const { CommissionPayment } = require('../models');
      if (CommissionPayment && collectorIds.length) {
        const cps = await CommissionPayment.findAll({
          where: { period_month: month, period_year: year, collector_id: { [Op.in]: collectorIds } },
          attributes: ['collector_id', 'amount', 'createdAt'],
          raw: true
        });
        cps.forEach(c => { paidMap[c.collector_id] = { amount: parseFloat(c.amount || 0), at: c.createdAt }; });
      }
    } catch (_) {}

    const out = [];
    let tTask = 0, tPaid = 0, tCollected = 0, tCommission = 0;

    for (const r of rows) {
      const cid       = r.collector_id;
      const prof      = profMap[cid] || {};
      const ctype     = prof.commission_type || 'flat';
      const cval      = parseFloat(prof.commission_value || 0);
      const paidCount = parseInt(r.paid_count, 10) || 0;
      const collected = parseFloat(r.paid_collected) || 0;

      let commission = 0;
      if (ctype === 'flat')    commission = cval * paidCount;
      else if (ctype === 'percent') commission = Math.round(collected * cval / 100);

      out.push({
        collector_id: cid,
        name: userMap[cid] || ('User #' + cid),
        task_count: parseInt(r.task_count, 10) || 0,
        paid_count: paidCount,
        collected: collected,
        commission_type: ctype,
        commission_value: cval,
        commission: commission,
        cash_held: parseFloat(prof.cash_held || 0),
        commission_paid: !!paidMap[cid],
        commission_paid_amount: paidMap[cid] ? paidMap[cid].amount : 0
      });

      tTask      += parseInt(r.task_count, 10) || 0;
      tPaid      += paidCount;
      tCollected += collected;
      tCommission += commission;
    }

    out.sort((a, b) => b.collected - a.collected);

    return {
      period: { month, year },
      rows: out,
      totals: {
        collectors: out.length,
        task_count: tTask,
        paid_count: tPaid,
        collected: tCollected,
        commission: tCommission
      }
    };
  }

  /**
   * Hitung ulang cash_held seorang kolektor dari sumber kebenaran:
   *   cash_held = SUM(payment field_collection oleh kolektor)
   *             - SUM(deposit verified oleh kolektor)
   * Dipakai untuk koreksi drift. Mengembalikan nilai baru.
   */
  static async recomputeCashHeld(collectorId) {
    const paidRow = await Payment.findOne({
      attributes: [[sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('amount')), 0), 'total']],
      where: { collected_by: collectorId },
      raw: true
    });
    const depRow = await CashDeposit.findOne({
      attributes: [[sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('deposited_amount')), 0), 'total']],
      where: { collector_id: collectorId, status: 'verified' },
      raw: true
    });
    const cashHeld = (parseFloat(paidRow?.total) || 0) - (parseFloat(depRow?.total) || 0);
    const profile = await CollectorProfile.findOne({ where: { user_id: collectorId } });
    if (profile) await profile.update({ cash_held: cashHeld });
    return cashHeld;
  }
}

module.exports = CollectionService;
module.exports.UNPAID_INVOICE_STATUSES = UNPAID_INVOICE_STATUSES;
module.exports.ACTIVE_ASSIGNMENT_STATUSES = ACTIVE_ASSIGNMENT_STATUSES;
