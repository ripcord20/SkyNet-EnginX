/**
 * buildInvoicePdf.js — render PDF invoice/kwitansi yang 100% IDENTIK dengan
 * tampilan on-screen (halaman /invoice & designer /invoice-template).
 *
 * Caranya: pakai HTML yang sama persis (backend/utils/invoiceHtml.js — port dari
 * invoice-renderer.js), lalu konversi ke PDF via wkhtmltopdf (headless WebKit).
 * Ini menjamin layout, warna, font, dan ke-5 template (banner/minimal/split/
 * clean/merchant) sama dengan yang dilihat & dicetak admin.
 *
 * FALLBACK: kalau wkhtmltopdf tidak ada di server (mis. tidak ter-install),
 * otomatis jatuh ke generator pdfkit lama (receiptPdf.js) agar email tetap jalan.
 * Lokasi binary wkhtmltopdf bisa di-set via ENV WKHTMLTOPDF_PATH.
 *
 * API (async):
 *   const { buildInvoicePdf } = require('./buildInvoicePdf');
 *   const buf = await buildInvoicePdf(invoiceData, tplConfig, { fallback });
 *   // -> Buffer PDF, atau null kalau gagal total
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');
const { buildInvoiceHtml } = require('./invoiceHtml');

// Cari binary wkhtmltopdf. Urutan: ENV → PATH umum Linux → PATH umum Windows.
function resolveWkhtmltopdf() {
  const candidates = [
    process.env.WKHTMLTOPDF_PATH,
    '/usr/bin/wkhtmltopdf',
    '/usr/local/bin/wkhtmltopdf',
    'C:\\Program Files\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
    'C:\\Program Files (x86)\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
    'wkhtmltopdf' // andalkan PATH
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'wkhtmltopdf') return c;          // biarkan shell yang resolve
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

// Bungkus fragment HTML invoice (.invoice-paper) jadi dokumen lengkap A4.
function wrapDocument(innerHtml, cfg) {
  // Buang blok @import Google Fonts (clean/merchant). wkhtmltopdf (unpatched qt)
  // sering gagal/lambat memuat font dari jaringan, dan di sebagian server akses
  // keluar diblokir. Font-family stack pada masing-masing layout sudah punya
  // fallback sistem (Inter/Noto Sans → -apple-system/Segoe UI/sans-serif),
  // jadi tampilan tetap rapi tanpa perlu unduh font.
  var cleaned = String(innerHtml).replace(/<style>@import[^<]*<\/style>/gi, '');

  // Ukuran kertas mengikuti layout:
  //  - clean    -> width 612px container
  //  - merchant -> width 595px container (A4)
  //  - lainnya  -> full-bleed A4
  // wkhtmltopdf pakai page A4 default; container di-center otomatis.
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>' +
    '*{box-sizing:border-box;} html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
    '@page{margin:0;}' +
    // Untuk layout banner/minimal/split: paper punya padding 50px 60px sendiri.
    '.invoice-paper{margin:0 auto;}' +
    '</style></head><body>' + cleaned + '</body></html>';
}

function runWkhtmltopdf(bin, htmlPath, pdfPath) {
  return new Promise((resolve, reject) => {
    // Catatan: beberapa switch (--print-media-type, --disable-smart-shrinking)
    // tidak didukung di build wkhtmltopdf "unpatched qt" dan akan diabaikan;
    // tidak kita kirim agar tidak ada warning. --enable-local-file-access perlu
    // untuk memuat logo dari path lokal.
    const args = [
      '--quiet',
      '--enable-local-file-access',
      '--page-size', 'A4',
      '--margin-top', '0', '--margin-bottom', '0',
      '--margin-left', '0', '--margin-right', '0',
      '--encoding', 'utf-8',
      '--load-error-handling', 'ignore',
      '--load-media-error-handling', 'ignore',
      htmlPath, pdfPath
    ];
    execFile(bin, args, { timeout: 30000 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function buildInvoicePdf(invoiceData, tplConfig, opts = {}) {
  // 1) Coba jalur HTML→PDF (identik on-screen)
  const bin = resolveWkhtmltopdf();
  if (bin) {
    let tmpDir = null;
    try {
      const inner = buildInvoiceHtml(invoiceData, tplConfig);
      const doc = wrapDocument(inner, tplConfig);
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-'));
      const htmlPath = path.join(tmpDir, 'invoice.html');
      const pdfPath = path.join(tmpDir, 'invoice.pdf');
      fs.writeFileSync(htmlPath, doc, 'utf8');
      await runWkhtmltopdf(bin, htmlPath, pdfPath);
      const buf = fs.readFileSync(pdfPath);
      return buf;
    } catch (e) {
      logger.warn('[InvoicePDF] wkhtmltopdf gagal, fallback ke pdfkit: ' + (e.message || e));
      // lanjut ke fallback
    } finally {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
    }
  } else {
    logger.warn('[InvoicePDF] wkhtmltopdf tidak ditemukan — pakai fallback pdfkit. ' +
      'Install wkhtmltopdf agar PDF email identik dengan template on-screen.');
  }

  // 2) Fallback pdfkit (layout sederhana, tapi email tetap terkirim)
  if (typeof opts.fallback === 'function') {
    try { return await opts.fallback(); }
    catch (e) { logger.error('[InvoicePDF] fallback pdfkit gagal: ' + (e.message || e)); }
  }
  return null;
}

module.exports = { buildInvoicePdf, resolveWkhtmltopdf };
