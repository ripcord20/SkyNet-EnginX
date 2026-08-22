// ════════════════════════════════════════════════════════════════
//  FinanceReportController
//  Export laporan keuangan per periode (bulan/tahun) sebagai:
//   - XLSX (exceljs)  → GET /api/finance/report/excel
//   - PDF  (pdfkit)   → GET /api/finance/report/pdf
//
//  Isi laporan: ringkasan laba rugi + rincian pemasukan & pengeluaran
//  per kategori. Memanfaatkan data tabel `keuangan`.
// ════════════════════════════════════════════════════════════════
const moment = require('moment');
const { sequelize } = require('../models');
const { getCompanyName } = require('../utils/companyInfo');

const COGS_KW = /bandwidth|upstream|transit|uplink|\bip\b|backbone|colo|colocation|sewa\s*ip|interkoneksi/i;
const fmtRp = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

// Ambil data laporan utk periode tertentu (dipakai kedua format).
async function buildReportData(req) {
  const isYear = String(req.query.period || '').toLowerCase() === 'year';
  const month = parseInt(req.query.month) || (moment().month() + 1);
  const year  = parseInt(req.query.year)  || moment().year();
  const start = isYear
    ? moment(`${year}-01-01`).startOf('year').format('YYYY-MM-DD')
    : moment(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').format('YYYY-MM-DD');
  const end = isYear
    ? moment(`${year}-12-31`).endOf('year').format('YYYY-MM-DD')
    : moment(start).endOf('month').format('YYYY-MM-DD');

  const incomeRows = await sequelize.query(
    `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM keuangan WHERE type='pemasukan' AND date BETWEEN :start AND :end
      GROUP BY category ORDER BY total DESC`,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );
  const expenseRows = await sequelize.query(
    `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM keuangan WHERE type='pengeluaran' AND date BETWEEN :start AND :end
      GROUP BY category ORDER BY total DESC`,
    { replacements: { start, end }, type: sequelize.QueryTypes.SELECT }
  );

  const revenue = incomeRows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
  let cogs = 0, opex = 0;
  const cogsBreak = [], opexBreak = [];
  for (const r of expenseRows) {
    const amt = parseFloat(r.total || 0);
    if (COGS_KW.test(r.category || '')) { cogs += amt; cogsBreak.push({ category: r.category, amount: amt }); }
    else { opex += amt; opexBreak.push({ category: r.category, amount: amt }); }
  }
  const grossProfit = revenue - cogs;
  const netProfit = grossProfit - opex;

  return {
    periodLabel: isYear ? `Tahun ${year}` : moment(start).format('MMMM YYYY'),
    start, end,
    income: incomeRows.map(r => ({ category: r.category, amount: parseFloat(r.total || 0), cnt: +r.cnt })),
    expense: expenseRows.map(r => ({ category: r.category, amount: parseFloat(r.total || 0), cnt: +r.cnt })),
    revenue, cogs, cogsBreak, grossProfit, opex, opexBreak, netProfit,
    grossMargin: revenue > 0 ? grossProfit / revenue * 100 : 0,
    netMargin: revenue > 0 ? netProfit / revenue * 100 : 0
  };
}

class FinanceReportController {
  // ── GET /api/finance/report/excel ──
  async excel(req, res) {
    try {
      const ExcelJS = require('exceljs');
      const d = await buildReportData(req);
      const company = (await getCompanyName().catch(() => null)) || 'FLAYNET';

      const wb = new ExcelJS.Workbook();
      wb.creator = company;
      const ws = wb.addWorksheet('Laporan Keuangan');
      ws.columns = [{ width: 38 }, { width: 18 }, { width: 12 }];

      const title = ws.addRow([company]);
      title.font = { size: 16, bold: true };
      const sub = ws.addRow([`Laporan Keuangan — ${d.periodLabel}`]);
      sub.font = { size: 11, color: { argb: 'FF64748B' } };
      ws.addRow([`Periode: ${d.start} s/d ${d.end}`]).font = { size: 9, color: { argb: 'FF94A3B8' } };
      ws.addRow([]);

      const hdr = (txt) => {
        const r = ws.addRow([txt]);
        r.font = { bold: true, size: 12, color: { argb: 'FF1E3A8A' } };
        return r;
      };
      const moneyRow = (label, val, bold) => {
        const r = ws.addRow([label, val]);
        r.getCell(2).numFmt = '#,##0';
        if (bold) r.font = { bold: true };
        return r;
      };

      // Ringkasan Laba Rugi
      hdr('RINGKASAN LABA RUGI');
      moneyRow('Pendapatan (Revenue)', d.revenue, true);
      moneyRow('Biaya Langsung / COGS (bandwidth dll)', -d.cogs);
      moneyRow('Laba Kotor', d.grossProfit, true);
      moneyRow('Biaya Operasional (Opex)', -d.opex);
      const net = moneyRow('LABA BERSIH', d.netProfit, true);
      net.getCell(1).font = { bold: true, size: 12 };
      net.getCell(2).font = { bold: true, size: 12, color: { argb: d.netProfit >= 0 ? 'FF15803D' : 'FFDC2626' } };
      ws.addRow(['Margin Kotor', (Math.round(d.grossMargin * 10) / 10) + '%']);
      ws.addRow(['Margin Bersih', (Math.round(d.netMargin * 10) / 10) + '%']);
      ws.addRow([]);

      // Rincian pemasukan
      hdr('RINCIAN PEMASUKAN');
      const ih = ws.addRow(['Kategori', 'Jumlah', 'Transaksi']);
      ih.font = { bold: true }; ih.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } });
      d.income.forEach(r => { const rr = ws.addRow([r.category, r.amount, r.cnt]); rr.getCell(2).numFmt = '#,##0'; });
      moneyRow('Total Pemasukan', d.revenue, true);
      ws.addRow([]);

      // Rincian pengeluaran
      hdr('RINCIAN PENGELUARAN');
      const eh = ws.addRow(['Kategori', 'Jumlah', 'Transaksi']);
      eh.font = { bold: true }; eh.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } });
      d.expense.forEach(r => { const rr = ws.addRow([r.category, r.amount, r.cnt]); rr.getCell(2).numFmt = '#,##0'; });
      moneyRow('Total Pengeluaran', d.cogs + d.opex, true);

      const fname = `Laporan-Keuangan-${d.periodLabel.replace(/\s+/g, '-')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── GET /api/finance/report/pdf ──
  async pdf(req, res) {
    try {
      const PDFDocument = require('pdfkit');
      const d = await buildReportData(req);
      const company = (await getCompanyName().catch(() => null)) || 'FLAYNET';

      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const fname = `Laporan-Keuangan-${d.periodLabel.replace(/\s+/g, '-')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      doc.pipe(res);

      const dark = '#1a1a1a', muted = '#697386', navy = '#1e3a8a', line = '#e5e7eb';
      const pageW = doc.page.width - 96;

      // Header
      doc.fillColor(dark).fontSize(20).font('Helvetica-Bold').text(company, { continued: false });
      doc.moveDown(0.2);
      doc.fillColor(navy).fontSize(13).font('Helvetica-Bold').text('Laporan Keuangan');
      doc.fillColor(muted).fontSize(10).font('Helvetica').text(`${d.periodLabel}  ·  ${d.start} s/d ${d.end}`);
      doc.moveDown(0.6);
      doc.strokeColor(line).lineWidth(1).moveTo(48, doc.y).lineTo(48 + pageW, doc.y).stroke();
      doc.moveDown(0.8);

      const row2 = (label, val, opts = {}) => {
        const y = doc.y;
        doc.fillColor(opts.color || dark).fontSize(opts.size || 10).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(label, 48, y, { width: pageW - 140 });
        doc.text(val, 48, y, { width: pageW, align: 'right' });
        doc.moveDown(opts.gap != null ? opts.gap : 0.45);
      };
      const sectionTitle = (t) => {
        doc.moveDown(0.4);
        doc.fillColor(navy).fontSize(11).font('Helvetica-Bold').text(t);
        doc.moveDown(0.25);
      };

      // Ringkasan laba rugi
      sectionTitle('Ringkasan Laba Rugi');
      row2('Pendapatan (Revenue)', fmtRp(d.revenue), { bold: true });
      row2('Biaya Langsung / COGS', '- ' + fmtRp(d.cogs), { color: muted });
      row2('Laba Kotor', fmtRp(d.grossProfit), { bold: true });
      row2('Biaya Operasional (Opex)', '- ' + fmtRp(d.opex), { color: muted });
      doc.strokeColor(line).lineWidth(0.7).moveTo(48, doc.y).lineTo(48 + pageW, doc.y).stroke();
      doc.moveDown(0.4);
      row2('LABA BERSIH', fmtRp(d.netProfit), { bold: true, size: 12, color: d.netProfit >= 0 ? '#15803d' : '#dc2626' });
      row2('Margin Kotor / Bersih', `${Math.round(d.grossMargin * 10) / 10}%  /  ${Math.round(d.netMargin * 10) / 10}%`, { color: muted, size: 9 });

      // Rincian pemasukan
      sectionTitle('Rincian Pemasukan');
      if (!d.income.length) doc.fillColor(muted).fontSize(9).font('Helvetica').text('Tidak ada pemasukan pada periode ini.');
      d.income.forEach(r => row2(r.category, fmtRp(r.amount)));
      row2('Total Pemasukan', fmtRp(d.revenue), { bold: true });

      // Rincian pengeluaran
      sectionTitle('Rincian Pengeluaran');
      if (!d.expense.length) doc.fillColor(muted).fontSize(9).font('Helvetica').text('Tidak ada pengeluaran pada periode ini.');
      d.expense.forEach(r => row2(r.category, fmtRp(r.amount)));
      row2('Total Pengeluaran', fmtRp(d.cogs + d.opex), { bold: true });

      // Footer
      doc.moveDown(1);
      doc.strokeColor(line).lineWidth(0.7).moveTo(48, doc.y).lineTo(48 + pageW, doc.y).stroke();
      doc.moveDown(0.4);
      doc.fillColor(muted).fontSize(8).font('Helvetica')
        .text(`Dibuat otomatis oleh sistem ${company} pada ${moment().format('DD MMM YYYY HH:mm')}`, { align: 'left' });

      doc.end();
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new FinanceReportController();
