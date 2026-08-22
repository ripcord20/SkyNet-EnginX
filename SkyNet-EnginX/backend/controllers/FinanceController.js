/**
 * FinanceController.js
 * ─────────────────────────────────────────────────────────────────
 * Endpoint pendukung untuk Finance Dashboard:
 *   - GET  /api/finance/activity         → mini activity log (audit)
 *   - GET  /api/finance/insights         → insight otomatis berbasis data
 *   - POST /api/finance/quick-expense    → catat pengeluaran cepat
 *   - GET  /api/finance/reminder-config  → status auto-reminder
 *   - POST /api/finance/reminder-config  → toggle auto-reminder
 */
const { Op } = require('sequelize');
const moment = require('moment');
const {
  ActivityLog, User, Invoice, Payment, Customer, Keuangan,
  ReminderSetting, WaSession, sequelize
} = require('../models');

class FinanceController {
  /**
   * GET /api/finance/activity?limit=10
   * Activity log yang relevan dengan finance (billing/payment/keuangan).
   */
  async activity(req, res) {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const rows = await ActivityLog.findAll({
        where: {
          module: { [Op.in]: ['billing', 'payment', 'keuangan', 'customer'] }
        },
        include: [
          { model: User, as: 'user', attributes: ['id', 'name', 'email'] }
        ],
        order: [['createdAt', 'DESC']],
        limit
      });

      const items = rows.map(r => ({
        id:          r.id,
        action:      r.action,
        module:      r.module,
        description: r.description,
        target_type: r.target_type,
        target_id:   r.target_id,
        created_at:  r.createdAt,
        user: r.user ? {
          id:   r.user.id,
          name: r.user.name
        } : { name: 'Sistem' }
      }));

      res.json({ success: true, data: items });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/insights
   * Generate insight otomatis berbasis data billing+keuangan.
   * Return array {type, severity, icon, title, message, action_url?}
   * severity: 'warning'|'info'|'success'|'danger'
   */
  async insights(req, res) {
    try {
      const today        = moment().format('YYYY-MM-DD');
      const monthStart   = moment().startOf('month').format('YYYY-MM-DD');
      const lastMonthSt  = moment().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
      const lastMonthEnd = moment().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');

      const insights = [];

      // ─── 1. Pelanggan overdue > 30 hari ───
      const stuck30Days = moment().subtract(30, 'days').format('YYYY-MM-DD');
      const stuckRows = await sequelize.query(
        `SELECT COUNT(DISTINCT customer_id) AS c, COALESCE(SUM(total),0) AS amt
           FROM invoices
          WHERE status IN ('unpaid','overdue') AND due_date < :stuck30Days`,
        { replacements: { stuck30Days }, type: sequelize.QueryTypes.SELECT }
      );
      const stuckCnt = parseInt(stuckRows[0]?.c || 0);
      const stuckAmt = parseFloat(stuckRows[0]?.amt || 0);
      if (stuckCnt > 0) {
        insights.push({
          type:     'churn_risk',
          severity: 'danger',
          icon:     'alert-triangle',
          title:    `${stuckCnt} pelanggan overdue >30 hari`,
          message:  `Total nilai Rp ${stuckAmt.toLocaleString('id-ID')}. Pertimbangkan isolir atau follow-up intensif.`,
          action_url:   '/billing',
          action_label: 'Lihat detail'
        });
      }

      // ─── 2. Collection rate naik/turun signifikan vs bulan lalu ───
      const curCol = await sequelize.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid
           FROM invoices
          WHERE period_year = :y AND period_month = :m`,
        { replacements: { y: moment().year(), m: moment().month() + 1 }, type: sequelize.QueryTypes.SELECT }
      );
      const lastCol = await sequelize.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid
           FROM invoices
          WHERE period_year = :y AND period_month = :m`,
        { replacements: {
            y: moment().subtract(1, 'month').year(),
            m: moment().subtract(1, 'month').month() + 1
          }, type: sequelize.QueryTypes.SELECT }
      );
      const curRate  = (parseInt(curCol[0]?.total)  > 0) ? (parseInt(curCol[0].paid)  / parseInt(curCol[0].total))  * 100 : 0;
      const lastRate = (parseInt(lastCol[0]?.total) > 0) ? (parseInt(lastCol[0].paid) / parseInt(lastCol[0].total)) * 100 : 0;
      if (parseInt(lastCol[0]?.total) > 0) {
        const delta = curRate - lastRate;
        if (delta >= 5) {
          insights.push({
            type:     'collection_up',
            severity: 'success',
            icon:     'trending-up',
            title:    `Collection rate naik ${delta.toFixed(1)}%`,
            message:  `Dari ${lastRate.toFixed(1)}% bulan lalu jadi ${curRate.toFixed(1)}% bulan ini. Pertahankan ritme reminder!`,
          });
        } else if (delta <= -5) {
          insights.push({
            type:     'collection_down',
            severity: 'warning',
            icon:     'trending-down',
            title:    `Collection rate turun ${Math.abs(delta).toFixed(1)}%`,
            message:  `Dari ${lastRate.toFixed(1)}% bulan lalu jadi ${curRate.toFixed(1)}% bulan ini. Perlu tingkatkan follow-up.`,
            action_url:   '/finance',
            action_label: 'Cek detail'
          });
        }
      }

      // ─── 3. Channel pembayaran tumbuh signifikan vs bulan lalu ───
      const channelCur = await sequelize.query(
        `SELECT payment_method, COALESCE(SUM(amount),0) AS amt
           FROM payments
          WHERE payment_date >= :monthStart
          GROUP BY payment_method`,
        { replacements: { monthStart }, type: sequelize.QueryTypes.SELECT }
      );
      const channelLast = await sequelize.query(
        `SELECT payment_method, COALESCE(SUM(amount),0) AS amt
           FROM payments
          WHERE payment_date BETWEEN :lastSt AND :lastEnd
          GROUP BY payment_method`,
        { replacements: { lastSt: lastMonthSt, lastEnd: lastMonthEnd }, type: sequelize.QueryTypes.SELECT }
      );
      const lastMap = {};
      channelLast.forEach(r => { lastMap[r.payment_method] = parseFloat(r.amt || 0); });

      // Cari channel dengan growth tertinggi (relative %), threshold > 30%
      let topGrowth = null;
      channelCur.forEach(r => {
        const cur  = parseFloat(r.amt || 0);
        const last = lastMap[r.payment_method] || 0;
        if (last > 0 && cur > last) {
          const growth = ((cur - last) / last) * 100;
          if (growth >= 30 && (!topGrowth || growth > topGrowth.growth)) {
            topGrowth = { method: r.payment_method, growth, cur, last };
          }
        }
      });
      if (topGrowth) {
        const label = topGrowth.method.toUpperCase();
        insights.push({
          type:     'channel_growth',
          severity: 'info',
          icon:     'zap',
          title:    `Channel ${label} naik ${Math.round(topGrowth.growth)}%`,
          message:  `Dari Rp ${topGrowth.last.toLocaleString('id-ID')} jadi Rp ${topGrowth.cur.toLocaleString('id-ID')}. Channel paling tumbuh bulan ini.`,
        });
      }

      // ─── 4. Customer langganan telat 3x berturut-turut (churn risk) ───
      const churnRows = await sequelize.query(
        `SELECT customer_id, COUNT(*) AS late_count
           FROM invoices
          WHERE status IN ('unpaid','overdue') OR
                (status='paid' AND paid_date > due_date)
          GROUP BY customer_id
          HAVING late_count >= 3`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (churnRows.length > 0) {
        insights.push({
          type:     'churn_alert',
          severity: 'warning',
          icon:     'user-x',
          title:    `${churnRows.length} pelanggan churn-risk`,
          message:  `Punya riwayat telat bayar 3x atau lebih. Pertimbangkan komunikasi proaktif atau review paket.`,
          action_url:   '/customers',
          action_label: 'Buka pelanggan'
        });
      }

      // ─── 5. WA session status — TIDAK ditampilkan sebagai insight ───
      // Status koneksi WA Gateway tidak dirender sebagai banner karena
      // sudah ada notifikasi terpisah di halaman WhatsApp Gateway.
      // Menghindari spam banner saat WA sengaja offline atau dalam proses
      // reconnect.

      // ─── 6. Positive: tidak ada overdue ───
      if (insights.length === 0 || (stuckCnt === 0 && churnRows.length === 0)) {
        const overdueAll = await Invoice.count({
          where: { status: { [Op.in]: ['unpaid','overdue'] }, due_date: { [Op.lt]: today } }
        });
        if (overdueAll === 0) {
          insights.push({
            type:     'all_clear',
            severity: 'success',
            icon:     'check-circle',
            title:    'Tidak ada invoice overdue',
            message:  'Semua pelanggan up-to-date. Pertahankan kinerja!',
          });
        }
      }

      // Sort by severity priority: danger > warning > info > success
      const order = { danger: 0, warning: 1, info: 2, success: 3 };
      insights.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));

      res.json({ success: true, data: insights.slice(0, 6) });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * POST /api/finance/quick-expense
   * Body: { amount, category, description?, party_name?, date? }
   */
  async quickExpense(req, res) {
    try {
      const { amount, category, description, party_name, date } = req.body || {};
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) {
        return res.status(400).json({ success: false, message: 'Jumlah pengeluaran wajib diisi (> 0)' });
      }
      if (!category || !String(category).trim()) {
        return res.status(400).json({ success: false, message: 'Kategori wajib diisi' });
      }

      const row = await Keuangan.create({
        type:        'pengeluaran',
        amount:      amt,
        category:    String(category).trim(),
        description: description ? String(description).trim() : null,
        party_name:  party_name ? String(party_name).trim() : null,
        date:        date || moment().format('YYYY-MM-DD'),
      });

      try {
        await ActivityLog.create({
          user_id:     req.user?.id || null,
          action:      'create_expense',
          module:      'keuangan',
          description: `Catat pengeluaran Rp ${amt.toLocaleString('id-ID')} (${category})`,
          target_type: 'keuangan',
          target_id:   row.id
        });
      } catch(_) {}

      res.json({
        success: true,
        message: 'Pengeluaran berhasil dicatat',
        data: { id: row.id, amount: amt, category, date: row.date }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/reminder-config
   * Return status reminder otomatis per type (before/due/overdue).
   */
  async reminderConfig(req, res) {
    try {
      const rows = await ReminderSetting.findAll({ order: [['type','ASC'], ['days_offset','ASC']] });
      const enabled = rows.some(r => r.is_active);
      res.json({
        success: true,
        data: {
          enabled,
          rules: rows.map(r => ({
            id:          r.id,
            type:        r.type,
            days_offset: r.days_offset,
            send_time:   r.send_time,
            is_active:   r.is_active,
            template_id: r.template_id
          }))
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * POST /api/finance/reminder-config
   * Body: { enabled: bool }
   * Toggle ON/OFF semua aturan reminder sekaligus.
   * Untuk edit aturan detail (waktu, template), tetap pakai /wa/reminder.
   */
  async toggleReminder(req, res) {
    try {
      const enabled = !!req.body?.enabled;
      const [affected] = await ReminderSetting.update(
        { is_active: enabled },
        { where: {} }
      );

      try {
        await ActivityLog.create({
          user_id:     req.user?.id || null,
          action:      enabled ? 'enable_auto_reminder' : 'disable_auto_reminder',
          module:      'billing',
          description: `Auto-reminder WA: ${enabled ? 'ON' : 'OFF'}`,
        });
      } catch(_) {}

      res.json({
        success: true,
        message: `Auto-reminder ${enabled ? 'diaktifkan' : 'dinonaktifkan'}`,
        data: { enabled, affected }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/profit-loss?month=&year=&period=year
   * Laporan Laba Rugi: Revenue → COGS (bandwidth) → Laba Kotor → Opex → Laba Bersih.
   * Klasifikasi COGS berdasarkan kategori pengeluaran yang mengandung kata
   * kunci bandwidth/upstream/transit/IP (sisanya = Opex).
   */
  async profitLoss(req, res) {
    try {
      const isYear = String(req.query.period || '').toLowerCase() === 'year';
      const month = parseInt(req.query.month) || (moment().month() + 1);
      const year  = parseInt(req.query.year)  || moment().year();
      const start = isYear
        ? moment(`${year}-01-01`).startOf('year').format('YYYY-MM-DD')
        : moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end = isYear
        ? moment(`${year}-12-31`).endOf('year').format('YYYY-MM-DD')
        : moment(start).endOf('month').format('YYYY-MM-DD');

      // Pemasukan (revenue) = pembayaran pelanggan atas invoice PERIODE ini
      // (basis periode invoice, konsisten dgn kartu Pemasukan & Arus Kas).
      // Dikelompokkan per metode pembayaran sebagai "kategori" revenue.
      const periodWhere = isYear ? 'i.period_year = :year'
                                 : 'i.period_year = :year AND i.period_month = :month';
      const incomeRows = await sequelize.query(
        `SELECT p.payment_method AS category, COALESCE(SUM(p.amount),0) AS total
           FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE ${periodWhere}
          GROUP BY p.payment_method`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );
      // Pengeluaran per kategori (tetap dari ledger keuangan, basis tanggal)
      const expenseRows = await sequelize.query(
        `SELECT category, COALESCE(SUM(amount),0) AS total
           FROM keuangan
          WHERE type='pengeluaran' AND date BETWEEN :start AND :end
          GROUP BY category`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );

      // Kata kunci COGS (biaya langsung penyediaan layanan)
      const COGS_KW = /bandwidth|upstream|transit|uplink|\bip\b|backbone|colo|colocation|sewa\s*ip|interkoneksi/i;
      const revenue = incomeRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
      let cogs = 0, opex = 0;
      const cogsBreak = [], opexBreak = [];
      for (const r of expenseRows) {
        const amt = parseFloat(r.total || 0);
        if (COGS_KW.test(r.category || '')) { cogs += amt; cogsBreak.push({ category: r.category, amount: amt }); }
        else { opex += amt; opexBreak.push({ category: r.category, amount: amt }); }
      }
      const grossProfit = revenue - cogs;
      const netProfit   = grossProfit - opex;
      const grossMargin = revenue > 0 ? (grossProfit / revenue * 100) : 0;
      const netMargin   = revenue > 0 ? (netProfit   / revenue * 100) : 0;

      res.json({
        success: true,
        data: {
          period: isYear ? `Tahun ${year}` : moment(start).format('MMMM YYYY'),
          mode: isYear ? 'year' : 'month',
          revenue,
          revenue_breakdown: incomeRows.map(r => ({ category: r.category, amount: parseFloat(r.total || 0) })),
          cogs, cogs_breakdown: cogsBreak,
          gross_profit: grossProfit, gross_margin: Math.round(grossMargin * 10) / 10,
          opex, opex_breakdown: opexBreak,
          net_profit: netProfit, net_margin: Math.round(netMargin * 10) / 10
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/aging
   * Aging report piutang: invoice unpaid/overdue dikelompokkan per umur
   * tunggakan (dihitung dari due_date): belum jatuh tempo, 1-30, 31-60, 60+.
   */
  async agingReport(req, res) {
    try {
      const today = moment().format('YYYY-MM-DD');
      const rows = await sequelize.query(
        `SELECT i.id, i.invoice_number, i.total, i.due_date, i.status,
                c.name AS cust_name, c.customer_id AS cid, c.phone AS phone, c.status AS cust_status,
                DATEDIFF(:today, i.due_date) AS days_overdue
           FROM invoices i
           JOIN customers c ON c.id = i.customer_id
          WHERE i.status IN ('unpaid','overdue')
          ORDER BY days_overdue DESC`,
        { replacements: { today }, type: sequelize.QueryTypes.SELECT }
      );

      const buckets = {
        not_due:  { label: 'Belum jatuh tempo', count: 0, amount: 0, items: [] },
        d1_30:    { label: '1–30 hari',  count: 0, amount: 0, items: [] },
        d31_60:   { label: '31–60 hari', count: 0, amount: 0, items: [] },
        d60plus:  { label: '> 60 hari',  count: 0, amount: 0, items: [] }
      };
      let totalOutstanding = 0;
      for (const r of rows) {
        const amt = parseFloat(r.total || 0);
        const days = parseInt(r.days_overdue);
        totalOutstanding += amt;
        let key;
        if (days <= 0) key = 'not_due';
        else if (days <= 30) key = 'd1_30';
        else if (days <= 60) key = 'd31_60';
        else key = 'd60plus';
        buckets[key].count++;
        buckets[key].amount += amt;
        buckets[key].items.push({
          invoice_id: r.id, invoice_number: r.invoice_number,
          cust_name: r.cust_name, cid: r.cid, phone: r.phone, cust_status: r.cust_status,
          total: amt, due_date: r.due_date, days_overdue: Math.max(0, days)
        });
      }

      res.json({
        success: true,
        data: {
          today, total_outstanding: totalOutstanding, total_invoices: rows.length,
          buckets
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/cashflow?month=&year=&period=year
   * Laporan arus kas (basis kas): uang benar-benar MASUK (payments.payment_date)
   * vs KELUAR (keuangan pengeluaran by date) pada periode. Beda dgn laba rugi
   * yang berbasis pencatatan.
   */
  async cashFlow(req, res) {
    try {
      const isYear = String(req.query.period || '').toLowerCase() === 'year';
      const month = parseInt(req.query.month) || (moment().month() + 1);
      const year  = parseInt(req.query.year)  || moment().year();
      const start = isYear
        ? moment(`${year}-01-01`).startOf('year').format('YYYY-MM-DD')
        : moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end = isYear
        ? moment(`${year}-12-31`).endOf('year').format('YYYY-MM-DD')
        : moment(start).endOf('month').format('YYYY-MM-DD');

      // Kas masuk = pembayaran pelanggan, dikelompokkan berdasarkan PERIODE
      // INVOICE yang dibayar (bukan tanggal transfer). Jadi bila tagihan Juli
      // dibayar 30 Juni, tetap masuk sebagai kas masuk Juli. Konsisten dgn
      // kartu Pemasukan & Collection Rate yang juga basis periode invoice.
      const periodWhere = isYear ? 'i.period_year = :year'
                                 : 'i.period_year = :year AND i.period_month = :month';
      const [inflowRow] = await sequelize.query(
        `SELECT COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS cnt
           FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE ${periodWhere}`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );
      // Kas masuk per metode
      const inflowByMethod = await sequelize.query(
        `SELECT p.payment_method AS method, COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS cnt
           FROM payments p JOIN invoices i ON i.id = p.invoice_id
          WHERE ${periodWhere}
          GROUP BY p.payment_method ORDER BY total DESC`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );
      // Kas keluar = pengeluaran (keuangan)
      const [outflowRow] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM keuangan WHERE type='pengeluaran' AND date BETWEEN :start AND :end`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );
      const outflowByCat = await sequelize.query(
        `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM keuangan WHERE type='pengeluaran' AND date BETWEEN :start AND :end
          GROUP BY category ORDER BY total DESC`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );
      // Modal masuk (opsional, ikut kas masuk)
      const [capitalRow] = await sequelize.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM keuangan
          WHERE type='modal' AND date BETWEEN :start AND :end`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );

      const inflow = parseFloat(inflowRow.total || 0);
      const capital = parseFloat(capitalRow.total || 0);
      const outflow = parseFloat(outflowRow.total || 0);
      const totalIn = inflow + capital;
      const netCash = totalIn - outflow;

      res.json({
        success: true,
        data: {
          period: isYear ? `Tahun ${year}` : moment(start).format('MMMM YYYY'),
          mode: isYear ? 'year' : 'month',
          inflow, inflow_count: +inflowRow.cnt || 0,
          inflow_by_method: inflowByMethod.map(r => ({ method: r.method || 'lainnya', amount: parseFloat(r.total||0), cnt: +r.cnt })),
          capital,
          total_in: totalIn,
          outflow, outflow_count: +outflowRow.cnt || 0,
          outflow_by_category: outflowByCat.map(r => ({ category: r.category, amount: parseFloat(r.total||0), cnt: +r.cnt })),
          net_cash: netCash
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/tax-report?month=&year=&period=year
   * Rekap PPN keluaran: DPP (invoice.amount) & PPN (invoice.tax) per periode.
   * Berdasarkan invoice yang terbit pada periode (period_month/period_year).
   * Pisahkan paid vs belum, supaya tahu PPN yg sudah/belum tertagih.
   */
  async taxReport(req, res) {
    try {
      const isYear = String(req.query.period || '').toLowerCase() === 'year';
      const month = parseInt(req.query.month) || (moment().month() + 1);
      const year  = parseInt(req.query.year)  || moment().year();

      const where = isYear ? 'period_year=:year' : 'period_year=:year AND period_month=:month';
      const rows = await sequelize.query(
        `SELECT
            COUNT(*) AS inv_count,
            COALESCE(SUM(amount),0) AS dpp_total,
            COALESCE(SUM(tax),0)    AS ppn_total,
            COALESCE(SUM(total),0)  AS grand_total,
            COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS dpp_paid,
            COALESCE(SUM(CASE WHEN status='paid' THEN tax    ELSE 0 END),0) AS ppn_paid,
            COALESCE(SUM(CASE WHEN status IN ('unpaid','overdue') THEN tax ELSE 0 END),0) AS ppn_unpaid,
            COALESCE(SUM(CASE WHEN tax > 0 THEN 1 ELSE 0 END),0) AS inv_with_tax
          FROM invoices
          WHERE ${where}`,
        { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
      );
      const r = rows[0] || {};

      // Breakdown bulanan kalau mode tahunan (untuk tabel rekap pajak)
      let monthly = [];
      if (isYear) {
        monthly = await sequelize.query(
          `SELECT period_month AS m,
                  COALESCE(SUM(amount),0) AS dpp,
                  COALESCE(SUM(tax),0)    AS ppn,
                  COUNT(*) AS cnt
             FROM invoices WHERE period_year=:year
            GROUP BY period_month ORDER BY period_month`,
          { replacements: { year }, type: sequelize.QueryTypes.SELECT }
        );
        monthly = monthly.map(x => ({ month: +x.m, dpp: parseFloat(x.dpp||0), ppn: parseFloat(x.ppn||0), cnt: +x.cnt }));
      }

      res.json({
        success: true,
        data: {
          period: isYear ? `Tahun ${year}` : moment(`${year}-${String(month).padStart(2,'0')}-01`).format('MMMM YYYY'),
          mode: isYear ? 'year' : 'month',
          invoice_count: +r.inv_count || 0,
          invoice_with_tax: +r.inv_with_tax || 0,
          dpp_total: parseFloat(r.dpp_total || 0),
          ppn_total: parseFloat(r.ppn_total || 0),
          grand_total: parseFloat(r.grand_total || 0),
          dpp_paid: parseFloat(r.dpp_paid || 0),
          ppn_paid: parseFloat(r.ppn_paid || 0),
          ppn_unpaid: parseFloat(r.ppn_unpaid || 0),
          // PPN Masukan (dari pembelian) belum dicatat di sistem → 0.
          // PPN yang harus disetor = PPN Keluaran - PPN Masukan.
          // Sediakan dua basis: akrual (seluruh yg terbit) & kas (yg sudah dibayar).
          ppn_input: 0,
          ppn_payable_accrual: parseFloat(r.ppn_total || 0),
          ppn_payable_cash: parseFloat(r.ppn_paid || 0),
          monthly,
          // ── PNBP ISP (BHP Telekomunikasi + Kontribusi USO) ──────────────
          // Dasar = pendapatan BASIS PERIODE INVOICE (konsisten dgn kartu
          // Pemasukan): pembayaran atas invoice periode terpilih, kapan pun
          // dibayar. Pembayaran utk periode lain (mis. tunggakan Juni dibayar
          // Juli) TIDAK ikut dihitung di periode ini.
          pnbp: await (async () => {
            try {
              const wInv = isYear
                ? `i.period_year=:year`
                : `i.period_year=:year AND i.period_month=:month`;
              const kr = await sequelize.query(
                `SELECT COALESCE(SUM(p.amount),0) AS gross
                   FROM payments p
                   JOIN invoices i ON i.id = p.invoice_id
                  WHERE ${wInv}`,
                { replacements: { year, month }, type: sequelize.QueryTypes.SELECT }
              );
              const gross = parseFloat((kr[0] && kr[0].gross) || 0);
              const Keu = require('./KeuanganController');
              return await Keu._computePnbp(gross);
            } catch (_) {
              return null;
            }
          })()
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
  /**
   * GET /api/finance/received?month=&year=[&period=year]
   * "Pembayaran Diterima Bulan Ini" — dana yang FISIK diterima pada bulan yang
   * dipilih (berdasarkan payment_date), dirinci PER PERIODE INVOICE. Berbeda dari
   * kartu Pemasukan (basis periode invoice); panel ini basis TANGGAL BAYAR.
   * Berguna melihat: "bulan ini saya menerima uang untuk periode Juni, Mei, dll".
   * TIDAK mengubah perhitungan pemasukan utama — murni informasi tambahan.
   */
  async receivedThisMonth(req, res) {
    try {
      const now   = new Date();
      const month = parseInt(req.query.month) || (now.getMonth() + 1);
      const year  = parseInt(req.query.year)  || now.getFullYear();
      const isYear = req.query.period === 'year';

      // Rentang tanggal bayar (basis payment_date).
      const start = isYear
        ? moment(`${year}-01-01`).startOf('year').format('YYYY-MM-DD')
        : moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
      const end = isYear
        ? moment(`${year}-12-31`).endOf('year').format('YYYY-MM-DD')
        : moment(start).endOf('month').format('YYYY-MM-DD');

      // Kelompokkan per periode invoice (period_year, period_month).
      const rows = await sequelize.query(
        `SELECT i.period_year AS py, i.period_month AS pm,
                COUNT(*) AS cnt, COALESCE(SUM(p.amount),0) AS total
           FROM payments p
           JOIN invoices i ON i.id = p.invoice_id
          WHERE p.payment_date BETWEEN :start AND :end
          GROUP BY i.period_year, i.period_month
          ORDER BY i.period_year DESC, i.period_month DESC`,
        { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
      );

      const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni',
                      'Juli','Agustus','September','Oktober','November','Desember'];
      const selectedIsCurrentPeriod = (r) =>
        !isYear && parseInt(r.py) === year && parseInt(r.pm) === month;

      // Bandingkan periode invoice thd periode terpilih: -1 lalu, 0 kini, +1 depan.
      // Dipakai utk membedakan tunggakan (bayar telat) vs bayar di muka (advance).
      const cmpPeriod = (py, pm) => {
        if (isYear) {
          // Mode tahunan: bandingkan tahun saja thd tahun terpilih.
          if (py < year) return -1; if (py > year) return 1; return 0;
        }
        const a = py * 12 + pm;
        const b = year * 12 + month;
        return a < b ? -1 : (a > b ? 1 : 0);
      };

      const breakdown = rows.map(r => {
        const py = parseInt(r.py), pm = parseInt(r.pm);
        const cmp = cmpPeriod(py, pm);
        return {
          period_year:  py,
          period_month: pm,
          label: `${MONTHS[pm] || '?'} ${r.py}`,
          count: parseInt(r.cnt),
          amount: parseFloat(r.total || 0),
          is_current: selectedIsCurrentPeriod(r),        // true = periode = bulan dipilih
          position: cmp < 0 ? 'past' : (cmp > 0 ? 'future' : 'current')
        };
      });

      const total       = breakdown.reduce((s, b) => s + b.amount, 0);
      const totalCount  = breakdown.reduce((s, b) => s + b.count, 0);
      // Pisahkan uang dari periode LALU (tunggakan) vs periode DEPAN (bayar di muka).
      const fromPast    = breakdown.filter(b => b.position === 'past')
                                   .reduce((s, b) => s + b.amount, 0);
      const fromFuture  = breakdown.filter(b => b.position === 'future')
                                   .reduce((s, b) => s + b.amount, 0);
      const fromOther   = fromPast + fromFuture; // kompat lama

      res.json({
        success: true,
        data: {
          period: isYear ? `Tahun ${year}` : `${MONTHS[month]} ${year}`,
          mode: isYear ? 'year' : 'month',
          total,
          total_count: totalCount,
          from_other_periods: fromOther,   // kompat: semua periode selain terpilih
          from_past_periods: fromPast,     // tunggakan periode lalu
          from_future_periods: fromFuture, // bayar di muka (periode depan)
          breakdown
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /finance/projection
  // Proyeksi penerimaan periode berjalan: sudah diterima + potensi yang masih
  // akan masuk (invoice periode ini yang belum lunas & belum jatuh tempo) +
  // yang berisiko (belum lunas & sudah lewat jatuh tempo).
  async projection(req, res) {
    try {
      const month = parseInt(req.query.month) || (moment().month() + 1);
      const year  = parseInt(req.query.year)  || moment().year();
      const today = moment().format('YYYY-MM-DD');
      const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni',
                      'Juli','Agustus','September','Oktober','November','Desember'];

      // Target = nilai seluruh invoice periode ini (semua status).
      const targetRow = await sequelize.query(
        `SELECT COALESCE(SUM(total),0) AS amt, COUNT(*) AS cnt
           FROM invoices
          WHERE period_year = :y AND period_month = :m`,
        { replacements: { y: year, m: month }, type: sequelize.QueryTypes.SELECT }
      );
      const targetAmt = parseFloat(targetRow[0]?.amt || 0);
      const targetCnt = parseInt(targetRow[0]?.cnt || 0);

      // Sudah lunas (nilai invoice periode ini berstatus paid).
      const paidRow = await sequelize.query(
        `SELECT COALESCE(SUM(total),0) AS amt, COUNT(*) AS cnt
           FROM invoices
          WHERE period_year = :y AND period_month = :m AND status = 'paid'`,
        { replacements: { y: year, m: month }, type: sequelize.QueryTypes.SELECT }
      );
      const paidAmt = parseFloat(paidRow[0]?.amt || 0);
      const paidCnt = parseInt(paidRow[0]?.cnt || 0);

      // Potensi masih akan masuk: belum lunas & BELUM jatuh tempo.
      const pipelineRow = await sequelize.query(
        `SELECT COALESCE(SUM(total),0) AS amt, COUNT(*) AS cnt
           FROM invoices
          WHERE period_year = :y AND period_month = :m
            AND status IN ('unpaid','overdue')
            AND due_date >= :today`,
        { replacements: { y: year, m: month, today }, type: sequelize.QueryTypes.SELECT }
      );
      const pipelineAmt = parseFloat(pipelineRow[0]?.amt || 0);
      const pipelineCnt = parseInt(pipelineRow[0]?.cnt || 0);

      // Berisiko: belum lunas & SUDAH lewat jatuh tempo.
      const overdueRow = await sequelize.query(
        `SELECT COALESCE(SUM(total),0) AS amt, COUNT(*) AS cnt
           FROM invoices
          WHERE period_year = :y AND period_month = :m
            AND status IN ('unpaid','overdue')
            AND due_date < :today`,
        { replacements: { y: year, m: month, today }, type: sequelize.QueryTypes.SELECT }
      );
      const overdueAmt = parseFloat(overdueRow[0]?.amt || 0);
      const overdueCnt = parseInt(overdueRow[0]?.cnt || 0);

      // Proyeksi realistis = sudah masuk + yang masih dalam tempo (belum lewat).
      // (Yang overdue dianggap berisiko, ditampilkan terpisah.)
      const projected = paidAmt + pipelineAmt;
      const pctPaid       = targetAmt > 0 ? Math.round(paidAmt / targetAmt * 100) : 0;
      const pctProjected  = targetAmt > 0 ? Math.round(projected / targetAmt * 100) : 0;

      res.json({
        success: true,
        data: {
          period: `${MONTHS[month]} ${year}`,
          target_amount: targetAmt,
          target_count: targetCnt,
          paid_amount: paidAmt,
          paid_count: paidCnt,
          pipeline_amount: pipelineAmt,   // belum lunas, masih dalam tempo
          pipeline_count: pipelineCnt,
          overdue_amount: overdueAmt,     // belum lunas, lewat tempo (berisiko)
          overdue_count: overdueCnt,
          projected_amount: projected,    // proyeksi realistis (paid + pipeline)
          pct_paid: pctPaid,
          pct_projected: pctProjected
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  /**
   * GET /api/finance/monthly-series?months=6
   * Deret PEMASUKAN vs PENGELUARAN per bulan untuk N bulan terakhir.
   * Pemasukan = SUM(payments.amount) by bulan payment_date.
   * Pengeluaran = SUM(keuangan.amount WHERE type='pengeluaran') by bulan date.
   * Dipakai untuk chart dua-garis di halaman laporan mobile.
   */
  async monthlySeries(req, res) {
    try {
      const months = Math.min(24, Math.max(1, parseInt(req.query.months) || 6));
      const start = moment().subtract(months - 1, 'months').startOf('month').format('YYYY-MM-DD');

      const incomeRows = await sequelize.query(
        `SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym, COALESCE(SUM(amount),0) AS total
           FROM payments
          WHERE payment_date >= :start
          GROUP BY ym`,
        { replacements: { start }, type: sequelize.QueryTypes.SELECT }
      );
      const expenseRows = await sequelize.query(
        `SELECT DATE_FORMAT(date, '%Y-%m') AS ym, COALESCE(SUM(amount),0) AS total
           FROM keuangan
          WHERE type = 'pengeluaran' AND date >= :start
          GROUP BY ym`,
        { replacements: { start }, type: sequelize.QueryTypes.SELECT }
      );

      const incMap = {}; incomeRows.forEach(r => { incMap[r.ym] = parseFloat(r.total || 0); });
      const expMap = {}; expenseRows.forEach(r => { expMap[r.ym] = parseFloat(r.total || 0); });

      const series = [];
      for (let i = months - 1; i >= 0; i--) {
        const m = moment().subtract(i, 'months');
        const ym = m.format('YYYY-MM');
        series.push({
          ym,
          label: m.format('MMM'),
          income: incMap[ym] || 0,
          expense: expMap[ym] || 0,
        });
      }
      res.json({ success: true, data: series });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new FinanceController();
