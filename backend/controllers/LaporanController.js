const { sequelize } = require('../models');
const moment = require('moment');

class LaporanController {

  async summary(req, res) {
    try {
      const view  = ['weekly','monthly','yearly'].includes(req.query.view) ? req.query.view : 'monthly';
      const year  = parseInt(req.query.year)  || moment().year();
      const month = parseInt(req.query.month) || moment().month() + 1;
      const week  = parseInt(req.query.week)  || moment().isoWeek();

      // ── Date range ──────────────────────────────────────────
      let start, end;
      if (view === 'weekly') {
        start = moment().isoWeekYear(year).isoWeek(week).startOf('isoWeek').format('YYYY-MM-DD');
        end   = moment().isoWeekYear(year).isoWeek(week).endOf('isoWeek').format('YYYY-MM-DD');
      } else if (view === 'monthly') {
        start = moment(`${year}-${String(month).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
        end   = moment(start).endOf('month').format('YYYY-MM-DD');
      } else {
        start = `${year}-01-01`;
        end   = `${year}-12-31`;
      }

      // ── Penerimaan periode ini ──────────────────────────────
      // Basis PERIODE INVOICE (konsisten dgn dashboard /finance): pembayaran
      // dikelompokkan berdasarkan periode tagihan yang dibayar, bukan tanggal
      // transfer. Jadi tagihan Juli yang dibayar 30 Juni tetap masuk Juli.
      // Untuk view mingguan, tetap basis tanggal (tak ada konsep "periode minggu").
      const recvIsPeriod = (view === 'monthly' || view === 'yearly');
      const recvPeriodWhere = view === 'yearly' ? 'i.period_year = :year'
                            : 'i.period_year = :year AND i.period_month = :month';
      const [recvRow] = await sequelize.query(
        recvIsPeriod
          ? `SELECT COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS cnt
               FROM payments p JOIN invoices i ON i.id = p.invoice_id
              WHERE ${recvPeriodWhere}`
          : `SELECT COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS cnt
               FROM payments p
              WHERE p.payment_date BETWEEN :start AND :end`,
        { replacements: { start, end, year, month }, type: sequelize.QueryTypes.SELECT }
      );
      const totalRecv = parseFloat(recvRow.total || 0);
      const totalTx   = parseInt(recvRow.cnt || 0);

      // ── Penerimaan periode sebelumnya ───────────────────────
      let prevStart, prevEnd;
      if (view === 'weekly') {
        prevStart = moment(start).subtract(7, 'days').format('YYYY-MM-DD');
        prevEnd   = moment(end).subtract(7, 'days').format('YYYY-MM-DD');
      } else if (view === 'monthly') {
        const pm = month === 1 ? 12 : month - 1;
        const py = month === 1 ? year - 1 : year;
        prevStart = moment(`${py}-${String(pm).padStart(2,'0')}-01`).startOf('month').format('YYYY-MM-DD');
        prevEnd   = moment(prevStart).endOf('month').format('YYYY-MM-DD');
      } else {
        prevStart = `${year - 1}-01-01`;
        prevEnd   = `${year - 1}-12-31`;
      }
      // pakai basis yang sama dgn periode berjalan agar % pertumbuhan konsisten
      let prevRow;
      if (recvIsPeriod) {
        const pm = view === 'yearly' ? null : (month === 1 ? 12 : month - 1);
        const py = view === 'yearly' ? (year - 1) : (month === 1 ? year - 1 : year);
        const prevWhere = view === 'yearly' ? 'i.period_year = :py'
                        : 'i.period_year = :py AND i.period_month = :pm';
        [prevRow] = await sequelize.query(
          `SELECT COALESCE(SUM(p.amount),0) AS total
             FROM payments p JOIN invoices i ON i.id = p.invoice_id
            WHERE ${prevWhere}`,
          { replacements: { py, pm }, type: sequelize.QueryTypes.SELECT }
        );
      } else {
        [prevRow] = await sequelize.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE payment_date BETWEEN :s AND :e`,
          { replacements: { s: prevStart, e: prevEnd }, type: sequelize.QueryTypes.SELECT }
        );
      }
      const prevRecv  = parseFloat(prevRow.total || 0);
      const growthAmt = prevRecv > 0 ? Math.round((totalRecv - prevRecv) / prevRecv * 100) : null;

      // ── Pelanggan aktif & potensi pendapatan ────────────────
      const [custStats] = await sequelize.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(pkg.price), 0) AS potential
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE c.status = 'active'`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const totalActive   = parseInt(custStats.total || 0);
      const potentialRecv = parseFloat(custStats.potential || 0);
      const collectionRate = potentialRecv > 0
        ? Math.min(100, Math.round(totalRecv / potentialRecv * 100))
        : 0;

      // ── Overdue: invoice unpaid & due_date sudah lewat ──────
      const overdueRows = await sequelize.query(
        `SELECT c.id, c.customer_id, c.name, c.phone,
                COALESCE(SUM(i.total), 0) AS price,
                MIN(i.due_date) AS due_date,
                DATEDIFF(CURDATE(), MIN(i.due_date)) AS days_overdue,
                COUNT(i.id) AS unpaid_count
         FROM customers c
         JOIN invoices i ON i.customer_id = c.id
         WHERE c.status = 'active'
           AND i.status IN ('unpaid', 'overdue')
           AND i.due_date < CURDATE()
         GROUP BY c.id, c.customer_id, c.name, c.phone
         ORDER BY due_date ASC
         LIMIT 100`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const totalOverdue    = overdueRows.length;
      const totalOverdueAmt = overdueRows.reduce((a, r) => a + parseFloat(r.price || 0), 0);

      // ── Upcoming: invoice unpaid jatuh tempo 7 hari ke depan
      const upcomingRows = await sequelize.query(
        `SELECT c.id, c.customer_id, c.name,
                COALESCE(pkg.price, 0) AS price,
                MIN(i.due_date) AS due_date,
                DATEDIFF(MIN(i.due_date), CURDATE()) AS days_left
         FROM customers c
         JOIN invoices i ON i.customer_id = c.id
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE c.status = 'active'
           AND i.status = 'unpaid'
           AND i.due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
         GROUP BY c.id, c.customer_id, c.name, pkg.price
         ORDER BY due_date ASC
         LIMIT 50`,
        { type: sequelize.QueryTypes.SELECT }
      );
      const totalUpcoming    = upcomingRows.length;
      const totalUpcomingAmt = upcomingRows.reduce((a, r) => a + parseFloat(r.price || 0), 0);

      // ── Chart data ──────────────────────────────────────────
      let chartLabels = [], chartData = [];
      if (view === 'weekly') {
        const rows = await sequelize.query(
          `SELECT DATE(payment_date) AS d, COALESCE(SUM(amount),0) AS total
           FROM payments WHERE payment_date BETWEEN :start AND :end
           GROUP BY DATE(payment_date) ORDER BY d ASC`,
          { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
        );
        const map  = {};
        rows.forEach(r => { map[r.d] = parseFloat(r.total); });
        const days = ['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
        for (let i = 0; i < 7; i++) {
          const d = moment(start).add(i, 'days').format('YYYY-MM-DD');
          chartLabels.push(days[i] + ' ' + moment(d).format('DD/MM'));
          chartData.push(map[d] || 0);
        }
      } else if (view === 'monthly') {
        const rows = await sequelize.query(
          `SELECT DAY(payment_date) AS d, COALESCE(SUM(amount),0) AS total
           FROM payments WHERE payment_date BETWEEN :start AND :end
           GROUP BY DAY(payment_date) ORDER BY d ASC`,
          { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
        );
        const map  = {};
        rows.forEach(r => { map[parseInt(r.d)] = parseFloat(r.total); });
        const days = moment(start).daysInMonth();
        for (let i = 1; i <= days; i++) {
          chartLabels.push(String(i));
          chartData.push(map[i] || 0);
        }
      } else {
        const rows = await sequelize.query(
          `SELECT MONTH(payment_date) AS m, COALESCE(SUM(amount),0) AS total
           FROM payments WHERE YEAR(payment_date) = :year
           GROUP BY MONTH(payment_date) ORDER BY m ASC`,
          { replacements: { year }, type: sequelize.QueryTypes.SELECT }
        );
        const map = {};
        rows.forEach(r => { map[parseInt(r.m)] = parseFloat(r.total); });
        const mn  = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
        chartLabels = mn;
        chartData   = Array.from({ length: 12 }, (_, i) => map[i + 1] || 0);
      }

      // ── Metode pembayaran ───────────────────────────────────
      // Basis periode invoice (bulanan/tahunan) agar total cocok dgn Penerimaan.
      const methodRows = await sequelize.query(
        recvIsPeriod
          ? `SELECT p.payment_method AS method, COUNT(*) AS cnt,
                    COALESCE(SUM(p.amount),0) AS total
               FROM payments p JOIN invoices i ON i.id = p.invoice_id
              WHERE ${recvPeriodWhere}
              GROUP BY p.payment_method ORDER BY total DESC`
          : `SELECT payment_method AS method, COUNT(*) AS cnt,
                    COALESCE(SUM(amount),0) AS total
               FROM payments
              WHERE payment_date BETWEEN :start AND :end
              GROUP BY payment_method ORDER BY total DESC`,
        { replacements: { start, end, year, month }, type: sequelize.QueryTypes.SELECT }
      );

      // ── Top paket ───────────────────────────────────────────
      const packageRows = await sequelize.query(
        `SELECT pkg.name,
                COUNT(*) AS cnt,
                COALESCE(SUM(p.amount),0) AS total
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE ` + (recvIsPeriod ? recvPeriodWhere : 'p.payment_date BETWEEN :start AND :end') + `
           AND pkg.name IS NOT NULL
         GROUP BY pkg.id, pkg.name
         ORDER BY total DESC
         LIMIT 8`,
        { replacements: { start, end, year, month }, type: sequelize.QueryTypes.SELECT }
      );

      // ── Tren 6 periode (Payments + Keuangan) ─────────────────
      const trendData = [];
      if (view === 'monthly') {
        for (let i = 5; i >= 0; i--) {
          const ts     = moment().year(year).month(month - 1).subtract(i, 'months');
          const tStart = ts.clone().startOf('month').format('YYYY-MM-DD');
          const tEnd   = ts.clone().endOf('month').format('YYYY-MM-DD');
          const tLbl   = ts.format('MMM');

          // Penerimaan: payments + keuangan pemasukan
          const [rPay] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE payment_date BETWEEN :tStart AND :tEnd`,
            { replacements: { tStart, tEnd }, type: sequelize.QueryTypes.SELECT }
          );
          const [rIn] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM keuangan WHERE type = 'pemasukan' AND date BETWEEN :tStart AND :tEnd`,
            { replacements: { tStart, tEnd }, type: sequelize.QueryTypes.SELECT }
          );
          const pemasukan = parseFloat(rPay.t || 0) + parseFloat(rIn.t || 0);

          // Pengeluaran: keuangan pengeluaran
          const [rOut] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM keuangan WHERE type = 'pengeluaran' AND date BETWEEN :tStart AND :tEnd`,
            { replacements: { tStart, tEnd }, type: sequelize.QueryTypes.SELECT }
          );
          const pengeluaran = parseFloat(rOut.t || 0);

          trendData.push({ label: tLbl, pemasukan, pengeluaran, laba: pemasukan - pengeluaran });
        }
      } else if (view === 'yearly') {
        for (let i = 5; i >= 0; i--) {
          const y = year - i;

          const [rPay] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM payments WHERE YEAR(payment_date) = :y`,
            { replacements: { y }, type: sequelize.QueryTypes.SELECT }
          );
          const [rIn] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM keuangan WHERE type = 'pemasukan' AND YEAR(date) = :y`,
            { replacements: { y }, type: sequelize.QueryTypes.SELECT }
          );
          const pemasukan = parseFloat(rPay.t || 0) + parseFloat(rIn.t || 0);

          const [rOut] = await sequelize.query(
            `SELECT COALESCE(SUM(amount),0) AS t FROM keuangan WHERE type = 'pengeluaran' AND YEAR(date) = :y`,
            { replacements: { y }, type: sequelize.QueryTypes.SELECT }
          );
          const pengeluaran = parseFloat(rOut.t || 0);

          trendData.push({ label: String(y), pemasukan, pengeluaran, laba: pemasukan - pengeluaran });
        }
      }

      // ── Daftar pembayaran ───────────────────────────────────
      const paidRows = await sequelize.query(
        `SELECT p.id AS payment_id,
                p.amount,
                p.payment_method,
                p.payment_date,
                p.reference_number,
                i.invoice_number,
                i.due_date AS due_date_after,
                i.period_month,
                i.period_year,
                c.name AS cust_name,
                c.customer_id AS cid,
                c.phone,
                pkg.name AS pkg_name
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE ` + (recvIsPeriod ? recvPeriodWhere : 'p.payment_date BETWEEN :start AND :end') + `
         ORDER BY p.payment_date DESC, p.id DESC
         LIMIT 500`,
        { replacements: { start, end, year, month }, type: sequelize.QueryTypes.SELECT }
      );


      // ── Data dari tabel keuangan ────────────────────────────
      let keuData = {
        pengeluaran:0, pengeluaranCnt:0,
        modal:0, hutangBulan:0, piutangBulan:0,
        catRows:[], keuRows:[], hutangOutstanding:0, piutangOutstanding:0
      };
      try {
        // Aggregat per type bulan ini
        const keuAgg = await sequelize.query(
          `SELECT type, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM keuangan
           WHERE date BETWEEN :start AND :end
           GROUP BY type`,
          { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
        );
        keuAgg.forEach(r => {
          if (r.type === 'pemasukan')   { keuData._keuPemasukanAll = parseFloat(r.total||0); }
          if (r.type === 'pengeluaran') { keuData.pengeluaran = parseFloat(r.total||0); keuData.pengeluaranCnt = parseInt(r.cnt||0); }
          if (r.type === 'modal')       keuData.modal        = parseFloat(r.total||0);
          if (r.type === 'hutang')      keuData.hutangBulan  = parseFloat(r.total||0);
          if (r.type === 'piutang')     keuData.piutangBulan = parseFloat(r.total||0);
        });

        // Pemasukan manual (exclude synced payments from modul Pembayaran)
        const [keuManualRow] = await sequelize.query(
          `SELECT COALESCE(SUM(amount),0) AS total
           FROM keuangan
           WHERE type='pemasukan'
             AND category != 'Pembayaran Pelanggan'
             AND date BETWEEN :start AND :end`,
          { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
        );
        keuData._keuPemasukan = parseFloat(keuManualRow?.total||0);

        // Kategori pengeluaran
        keuData.catRows = await sequelize.query(
          `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
           FROM keuangan
           WHERE type='pengeluaran' AND date BETWEEN :start AND :end
           GROUP BY category ORDER BY total DESC LIMIT 8`,
          { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
        );

        // Daftar transaksi keuangan (non-pemasukan — sudah ada di paidRows)
        keuData.keuRows = await sequelize.query(
          `SELECT k.id, k.type, k.category, k.description, k.amount,
                  k.date, k.party_name, k.ref_number, k.status, k.notes
           FROM keuangan k
           WHERE k.date BETWEEN :start AND :end
             AND k.type IN ('pemasukan','pengeluaran','hutang','piutang','modal')
           ORDER BY k.date DESC, k.id DESC
           LIMIT 200`,
          { replacements:{start,end}, type: sequelize.QueryTypes.SELECT }
        );

        // Outstanding hutang & piutang all-time
        const [hOut] = await sequelize.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM keuangan
           WHERE type='hutang' AND (status='belum_lunas' OR status='cicilan')`,
          { type: sequelize.QueryTypes.SELECT }
        );
        const [pOut] = await sequelize.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM keuangan
           WHERE type='piutang' AND (status='belum_lunas' OR status='cicilan')`,
          { type: sequelize.QueryTypes.SELECT }
        );
        keuData.hutangOutstanding  = parseFloat(hOut?.total||0);
        keuData.piutangOutstanding = parseFloat(pOut?.total||0);
      } catch(keuErr) {
        // Tabel keuangan mungkin belum ada, skip
        console.warn('[LaporanController] keuangan table not available:', keuErr.message);
      }

      // ── Laba Rugi ───────────────────────────────────────────
      // Pemasukan manual dari tabel keuangan (type='pemasukan')
      let keuPemasukan = 0;
      try {
        const keuPRow = keuData._keuPemasukan || 0;
        keuPemasukan = keuPRow;
      } catch(e) {}

      // Total penerimaan = dari pembayaran pelanggan + pemasukan manual keuangan
      const totalRecvAll = totalRecv + keuPemasukan;

      const labaRugi = {
        pendapatanISP:    totalRecv,          // dari pembayaran pelanggan
        pendapatanManual: keuPemasukan,       // dari input manual keuangan
        totalPendapatan:  totalRecvAll,
        pengeluaran:      keuData.pengeluaran,
        pengeluaranCnt:   keuData.pengeluaranCnt,
        labaKotor:        totalRecvAll - keuData.pengeluaran,
        hutangBulan:      keuData.hutangBulan,
        piutangBulan:     keuData.piutangBulan,
        labaBersih:       totalRecvAll - keuData.pengeluaran,
        cashflow:         totalRecvAll + keuData.modal - keuData.pengeluaran
      };

      res.json({
        success: true,
        data: {
          totalRecv, totalRecvAll, totalTx, growthAmt,
          prevRecv, totalActive, potentialRecv, collectionRate,
          totalOverdue, totalOverdueAmt, overdueRows,
          totalUpcoming, totalUpcomingAmt, upcomingRows,
          chartLabels, chartData,
          methodRows, packageRows, trendData,
          paidRows,
          keuData,
          labaRugi
        }
      });
    } catch (e) {
      console.error('[LaporanController] ERROR:', e.message);
      console.error('[LaporanController] SQL:', e.sql || '-');
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new LaporanController();