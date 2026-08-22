// Generator PDF INVOICE / KWITANSI (FALLBACK pdfkit).
//
// Dipakai HANYA bila wkhtmltopdf tidak tersedia di server. Begitu wkhtmltopdf
// ter-install, sistem otomatis memakai jalur HTML (buildInvoicePdf.js) yang
// 100% identik dengan tampilan on-screen.
//
// Versi ini MENIRU layout "merchant" (Autodesk/Cleverbridge) yang dipakai di
// invoice-renderer.js, supaya fallback tetap mirip template on-screen:
//   logo/brand kiri-atas, alamat penerima, judul tengah bergaris,
//   tabel produk (#, Product name, Qty, Local Price, VAT, Price to pay),
//   Subtotal/VAT/Total kanan, blok "Total to pay" + badge PAID/UNPAID,
//   "Payment details" (narasi + info bank), footer legal 1 baris.
//
// SADAR STATUS: statusPaid === true -> PAID/LUNAS; selain itu UNPAID/BELUM LUNAS.
//
// Catatan: pdfkit menggambar manual sehingga tidak bisa 100% sama seperti
// wkhtmltopdf, tapi strukturnya sengaja dibuat semirip mungkin dgn layout
// merchant. Untuk hasil identik, install wkhtmltopdf (lihat CARA-DEPLOY).
const PDFDocument = require('pdfkit');

function buildReceiptPdf(d = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const isPaid = d.statusPaid === true;
      const dark = '#1a1a1a';
      const muted = '#555';
      const line = '#222';
      const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

      const pageW = doc.page.width;       // 595.28pt (A4)
      const M = 40;
      const left = M, right = pageW - M, cw = right - left;
      let y = 42;

      // ── Logo / brand kiri-atas ──
      // pdfkit tidak bisa memuat <img> remote; pakai nama brand sbg teks (uppercase,
      // mirip merchant). Kalau ada path logo lokal (PNG/JPG), coba embed.
      let logoDrawn = false;
      if (d.logoPath) {
        try {
          doc.image(d.logoPath, left, y, { fit: [180, 34] });
          logoDrawn = true;
        } catch (_) { logoDrawn = false; }
      }
      if (!logoDrawn) {
        doc.fillColor(dark).font('Helvetica-Bold').fontSize(15)
          .text(String(d.companyName || 'INVOICE').toUpperCase(), left, y, { characterSpacing: 0.5 });
      }
      y += 56;

      // ── Alamat penerima (Bill to) ──
      doc.fillColor(dark).font('Helvetica').fontSize(9.5);
      const billLines = [];
      if (d.customerName)    billLines.push({ t: d.customerName, b: false });
      if (d.customerId)      billLines.push({ t: d.customerId, b: false });
      if (d.customerAddress) billLines.push({ t: d.customerAddress, b: false });
      if (d.customerPhone)   billLines.push({ t: d.customerPhone, b: false });
      if (d.customerEmail)   billLines.push({ t: d.customerEmail, b: false });
      billLines.forEach(ln => { doc.text(ln.t, left, y, { width: cw * 0.6 }); y += 13; });
      y += 18;

      // ── Judul INVOICE (center) + garis ──
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(18)
        .text(d.invoiceLabel || 'INVOICE', left, y, { width: cw, align: 'center' });
      y += 28;
      doc.strokeColor(line).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
      y += 14;

      // ── Invoice date / number (rata kanan) ──
      const metaRow = (label, value, valueColor) => {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(dark)
          .text(label, left + cw * 0.40, y, { width: cw * 0.32, align: 'right' });
        doc.font('Helvetica').fontSize(9.5).fillColor(valueColor || dark)
          .text(String(value || '-'), left + cw * 0.74, y, { width: cw * 0.26, align: 'right' });
        y += 15;
      };
      metaRow('Invoice date:', d.invoiceDateFormatted || d.paymentDateFormatted);
      metaRow('Invoice number:', d.invoiceNumber);
      if (d.periodLabel) metaRow('Periode:', d.periodLabel);
      if (!isPaid && d.dueDateFormatted) metaRow('Jatuh Tempo:', d.dueDateFormatted, '#dc2626');
      y += 8;

      // ── "Invoice information" + garis ──
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(12)
        .text(d.detailLabel || 'Invoice information', left, y);
      y += 18;
      doc.strokeColor(line).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
      y += 12;

      // ── Header tabel produk ──
      // kolom: # | Product name | Qty | Local Price | VAT | Price to pay
      const cX = {
        no:    left,
        name:  left + 18,
        qty:   left + cw * 0.46,
        price: left + cw * 0.55,
        vat:   left + cw * 0.74,
        total: left + cw * 0.84
      };
      const wQty = cw * 0.08, wPrice = cw * 0.18, wVat = cw * 0.09, wTotal = cw * 0.16;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(dark);
      doc.text('#', cX.no, y);
      doc.text('Product name', cX.name, y);
      doc.text('Qty.', cX.qty, y, { width: wQty, align: 'right' });
      doc.font('Helvetica-Oblique').text('Local Price', cX.price, y, { width: wPrice, align: 'right' });
      doc.font('Helvetica-Bold').text('VAT', cX.vat, y, { width: wVat, align: 'right' });
      doc.text('Price to pay', cX.total, y, { width: wTotal, align: 'right' });
      y += 18;

      // ── Baris produk ──
      const subtotal = d.subtotal != null ? d.subtotal : d.total;
      doc.fillColor(dark).font('Helvetica').fontSize(9).text('1', cX.no, y);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(dark)
        .text(d.productName || 'Layanan Internet', cX.name, y, { width: cw * 0.40 });
      let nameBottom = doc.y;
      // sub-info periode & aktif s/d
      let infoY = nameBottom + 1;
      if (d.periodLabel) { doc.font('Helvetica-Oblique').fontSize(8).fillColor(dark).text(d.periodLabel, cX.name, infoY, { width: cw * 0.40 }); infoY = doc.y; }
      if (d.activeUntilFormatted) { doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text('Aktif s/d: ', cX.name, infoY, { continued: true, width: cw * 0.40 }).font('Helvetica').text(d.activeUntilFormatted); infoY = doc.y; }
      // kolom angka (sejajar baris atas)
      doc.font('Helvetica').fontSize(9).fillColor(dark);
      doc.text('1', cX.qty, y, { width: wQty, align: 'right' });
      doc.font('Helvetica-Oblique').text(fmt(subtotal), cX.price, y, { width: wPrice, align: 'right' });
      doc.font('Helvetica').text((d.vatPercent != null ? d.vatPercent + '%' : '\u2013'), cX.vat, y, { width: wVat, align: 'right' });
      doc.font('Helvetica-Bold').text(fmt(d.total), cX.total, y, { width: wTotal, align: 'right' });
      y = Math.max(infoY, y + 16) + 10;

      // ── Subtotal / VAT / Total (rata kanan) ──
      const sumRow = (label, value, italic) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(dark)
          .text(label, left + cw * 0.5, y, { width: cw * 0.28, align: 'right' });
        doc.font(italic ? 'Helvetica-Oblique' : 'Helvetica-Bold').fontSize(9).fillColor(dark)
          .text(value, left + cw * 0.78, y, { width: cw * 0.22, align: 'right' });
        y += 15;
      };
      if (d.showTax && d.subtotal != null) {
        sumRow('Subtotal:', fmt(d.subtotal), true);
        sumRow((d.taxLabel || 'VAT') + (d.vatPercent != null ? ' (' + d.vatPercent + '%)' : '') + ':', fmt(d.taxAmount || 0), true);
      }
      sumRow('Total:', fmt(d.total), true);
      y += 8;

      // ── Garis pemisah ──
      doc.strokeColor(line).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
      y += 12;

      // ── Total to pay (kanan) + badge status ──
      doc.font('Helvetica-Bold').fontSize(9).fillColor(dark)
        .text('Total to pay:', left + cw * 0.5, y, { width: cw * 0.5, align: 'right' });
      y += 14;
      doc.font('Helvetica-Bold').fontSize(14).fillColor(dark)
        .text(fmt(d.total), left + cw * 0.5, y, { width: cw * 0.5, align: 'right' });
      y += 22;
      // badge
      const statusColor = isPaid ? '#15803d' : '#b91c1c';
      const statusText  = isPaid ? 'PAID' : 'UNPAID';
      const bw = doc.font('Helvetica-Bold').fontSize(10).widthOfString(statusText) + 24;
      const bh = 20, bx = right - bw, by = y;
      doc.roundedRect(bx, by, bw, bh, 5).lineWidth(1.5).strokeColor(statusColor).stroke();
      doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(10)
        .text(statusText, bx, by + 5, { width: bw, align: 'center' });
      y += bh + 22;

      // ── Payment details ──
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(12).text('Payment details', left, y);
      y += 16;
      doc.strokeColor(line).lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
      y += 12;

      doc.font('Helvetica').fontSize(9).fillColor(dark);
      if (isPaid) {
        const parts = ['Pembayaran sebesar ' + fmt(d.total) + ' telah diterima'];
        if (d.paymentDateFormatted) parts.push(' pada ' + d.paymentDateFormatted);
        if (d.methodLabel) parts.push(' via ' + d.methodLabel);
        doc.text(parts.join('') + '.', left, y, { width: cw }); y = doc.y + 6;
        if (d.referenceNo) { doc.text('Ref: ' + d.referenceNo, left, y, { width: cw }); y = doc.y + 6; }
      } else {
        doc.text('Tagihan ini jatuh tempo pada ' + (d.dueDateFormatted || '-') + '. Mohon lakukan pembayaran sebesar ' + fmt(d.total) + ' sebelum tanggal tersebut.', left, y, { width: cw });
        y = doc.y + 8;
      }

      // info bank
      const banks = Array.isArray(d.bankAccounts) ? d.bankAccounts.filter(b => b && (b.bank || b.account_number)) : [];
      if (banks.length) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(dark).text('Pembayaran transfer ke:', left, y); y = doc.y + 3;
        doc.font('Helvetica').fontSize(9).fillColor(dark);
        banks.forEach(b => {
          const lbl = (b.bank || '').toUpperCase();
          doc.text(`${lbl} \u00b7 ${b.account_number || '-'}${b.account_owner ? ' a.n. ' + b.account_owner : ''}`, left, y, { width: cw });
          y = doc.y + 2;
        });
      }
      if (d.notes) { y += 4; doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(muted).text('Catatan: ' + d.notes, left, y, { width: cw }); y = doc.y; }

      // ── Footer legal ──
      const footY = 790;
      doc.strokeColor(line).lineWidth(1).moveTo(left, footY).lineTo(right, footY).stroke();
      const footParts = ['' + (d.companyName || 'ISP Provider')];
      if (d.companyAddress) footParts.push(d.companyAddress.replace(/\n/g, ', '));
      if (d.companyPhone)   footParts.push(d.companyPhone);
      if (d.companyEmail)   footParts.push(d.companyEmail);
      doc.fillColor(muted).font('Helvetica').fontSize(7)
        .text(footParts.join('  \u00b7  '), left, footY + 6, { width: cw });
      if (d.footerText) doc.fillColor(muted).font('Helvetica').fontSize(7).text(d.footerText, left, doc.y + 1, { width: cw });
      doc.fillColor(muted).font('Helvetica').fontSize(7).text('1 / 1', left, doc.y + 2, { width: cw, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildReceiptPdf };
