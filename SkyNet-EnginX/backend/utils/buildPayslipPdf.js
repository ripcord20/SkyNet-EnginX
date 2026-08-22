/**
 * buildPayslipPdf.js
 * ──────────────────────────────────────────────────────────────────
 * Generator PDF Slip Gaji (pdfkit). Mengembalikan Buffer.
 *
 * Konsisten dengan utils/receiptPdf.js: A4, header brand, tabel komponen,
 * blok net kanan, footer. Dipakai HrisPayrollService untuk lampiran
 * email & WhatsApp.
 *
 * Input (semua opsional kecuali item):
 *   companyName, logoPath, periodLabel,
 *   employee: { full_name, employee_no, position, department, bank_name, bank_account }
 *   item: {
 *     present_days, absent_days, leave_days, late_count, overtime_minutes,
 *     base_salary, overtime_pay,
 *     allowances:[{label,amount}], deductions:[{label,amount}],
 *     total_allowances, total_deductions, gross_salary, net_salary
 *   }
 */
const PDFDocument = require('pdfkit');

function buildPayslipPdf(d = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const dark = '#111827', muted = '#6b7280', accent = '#2563eb', lineC = '#e5e7eb';
      const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
      const pageW = doc.page.width;
      const M = 40, left = M, right = pageW - M, cw = right - left;
      let y = 44;

      const emp = d.employee || {};
      const it = d.item || {};

      // ── Header: brand kiri, judul kanan ──
      let logoDrawn = false;
      if (d.logoPath) {
        try { doc.image(d.logoPath, left, y, { fit: [150, 34] }); logoDrawn = true; } catch (_) {}
      }
      if (!logoDrawn) {
        doc.fillColor(dark).font('Helvetica-Bold').fontSize(15)
          .text(String(d.companyName || 'PERUSAHAAN').toUpperCase(), left, y, { characterSpacing: 0.5 });
      }
      doc.fillColor(accent).font('Helvetica-Bold').fontSize(18)
        .text('SLIP GAJI', left, y, { width: cw, align: 'right' });
      doc.fillColor(muted).font('Helvetica').fontSize(9.5)
        .text('Periode: ' + (d.periodLabel || '-'), left, y + 24, { width: cw, align: 'right' });
      y += 64;

      doc.moveTo(left, y).lineTo(right, y).strokeColor(lineC).lineWidth(1).stroke();
      y += 16;

      // ── Data karyawan (2 kolom) ──
      const colW = cw / 2;
      const rowsL = [
        ['Nama', emp.full_name || '-'],
        ['No. Karyawan', emp.employee_no || '-'],
        ['Jabatan', emp.position || '-'],
      ];
      const rowsR = [
        ['Departemen', emp.department || '-'],
        ['Bank', emp.bank_name || '-'],
        ['No. Rekening', emp.bank_account || '-'],
      ];
      const drawKV = (rows, x0) => {
        let yy = y;
        rows.forEach(([k, v]) => {
          doc.fillColor(muted).font('Helvetica').fontSize(9).text(k, x0, yy, { width: 90 });
          doc.fillColor(dark).font('Helvetica-Bold').fontSize(9.5).text(String(v), x0 + 92, yy, { width: colW - 100 });
          yy += 17;
        });
        return yy;
      };
      const yL = drawKV(rowsL, left);
      const yR = drawKV(rowsR, left + colW);
      y = Math.max(yL, yR) + 8;

      // ── Ringkasan absensi ──
      doc.moveTo(left, y).lineTo(right, y).strokeColor(lineC).lineWidth(1).stroke();
      y += 12;
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(10).text('Ringkasan Kehadiran', left, y);
      y += 16;
      const att = [
        ['Hadir', (it.present_days || 0) + ' hari'],
        ['Absen', (it.absent_days || 0) + ' hari'],
        ['Izin/Cuti', (it.leave_days || 0) + ' hari'],
        ['Terlambat', (it.late_count || 0) + 'x'],
        ['Lembur', Math.round((it.overtime_minutes || 0) / 60 * 10) / 10 + ' jam'],
      ];
      const cellW = cw / att.length;
      att.forEach(([k, v], i) => {
        const x0 = left + i * cellW;
        doc.fillColor(muted).font('Helvetica').fontSize(8.5).text(k, x0, y, { width: cellW, align: 'center' });
        doc.fillColor(dark).font('Helvetica-Bold').fontSize(11).text(String(v), x0, y + 12, { width: cellW, align: 'center' });
      });
      y += 40;

      // ── Tabel komponen gaji ──
      const drawSectionHeader = (label) => {
        doc.rect(left, y, cw, 20).fill('#f3f4f6');
        doc.fillColor(dark).font('Helvetica-Bold').fontSize(9.5).text(label, left + 8, y + 6);
        y += 24;
      };
      const drawLine = (label, amount, opts = {}) => {
        doc.fillColor(opts.muted ? muted : dark).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
          .text(label, left + 8, y, { width: cw - 140 });
        doc.fillColor(opts.color || dark).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5)
          .text(fmt(amount), right - 140, y, { width: 132, align: 'right' });
        y += 17;
      };

      drawSectionHeader('PENDAPATAN');
      drawLine('Gaji Pokok', it.base_salary || 0);
      (it.allowances || []).forEach(a => drawLine(a.label || 'Tunjangan', a.amount || 0));
      if (it.overtime_pay) drawLine('Lembur', it.overtime_pay);
      y += 4;
      drawLine('Total Pendapatan', it.gross_salary || 0, { bold: true, color: '#16a34a' });
      y += 8;

      drawSectionHeader('POTONGAN');
      const deds = it.deductions || [];
      if (deds.length === 0) drawLine('Tidak ada potongan', 0, { muted: true });
      deds.forEach(dd => drawLine(dd.label || 'Potongan', dd.amount || 0));
      y += 4;
      drawLine('Total Potongan', it.total_deductions || 0, { bold: true, color: '#dc2626' });
      y += 14;

      // ── Blok GAJI BERSIH ──
      doc.rect(left, y, cw, 44).fill(accent);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('GAJI BERSIH (TAKE HOME PAY)', left + 14, y + 15);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
        .text(fmt(it.net_salary || 0), right - 214, y + 12, { width: 200, align: 'right' });
      y += 64;

      // ── Footer ──
      doc.fillColor(muted).font('Helvetica').fontSize(8)
        .text('Slip gaji ini dihasilkan otomatis oleh sistem dan sah tanpa tanda tangan basah.',
          left, y, { width: cw, align: 'center' });
      doc.text('Dicetak: ' + new Date().toLocaleString('id-ID'), left, y + 12, { width: cw, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = buildPayslipPdf;
