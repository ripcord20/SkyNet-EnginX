// Helper kecil: ubah path logo (relatif / absolut) jadi bentuk yang bisa
// dimuat wkhtmltopdf saat membuat PDF invoice.
//  - URL http(s) / file:// → dibiarkan apa adanya.
//  - Path relatif (mis. /uploads/logo.png) → dicari di frontend/public lalu
//    dikembalikan sebagai file:// absolut.
//  - Kalau file tak ditemukan → '' (renderer pakai inisial perusahaan).
const fs = require('fs');
const path = require('path');

function resolveLogoForPdf(logoUrl) {
  if (!logoUrl) return '';
  if (/^https?:\/\//i.test(logoUrl) || /^file:\/\//i.test(logoUrl)) return logoUrl;
  try {
    const rel = String(logoUrl).replace(/^\/+/, '');
    const candidates = [
      path.join(process.cwd(), 'frontend', 'public', rel),
      path.join(process.cwd(), 'frontend', 'public', 'uploads', path.basename(logoUrl)),
      path.join(process.cwd(), rel)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return 'file://' + c.replace(/\\/g, '/');
    }
  } catch (_) {}
  return '';
}

// Untuk pdfkit (fallback): butuh PATH filesystem (bukan file://), dan hanya
// mendukung gambar lokal PNG/JPG. URL http(s) tidak bisa di-embed -> '' .
function localLogoPath(logoUrl) {
  if (!logoUrl) return '';
  try {
    let p = String(logoUrl);
    if (/^https?:\/\//i.test(p)) return '';       // remote tak didukung pdfkit
    if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, '');
    if (!/\.(png|jpe?g)$/i.test(p)) {
      // mungkin path relatif; lanjut resolusi di bawah
    }
    const rel = p.replace(/^\/+/, '');
    const candidates = [
      p,
      path.join(process.cwd(), 'frontend', 'public', rel),
      path.join(process.cwd(), 'frontend', 'public', 'uploads', path.basename(p)),
      path.join(process.cwd(), rel)
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && /\.(png|jpe?g)$/i.test(c)) return c;
    }
  } catch (_) {}
  return '';
}

module.exports = { resolveLogoForPdf, localLogoPath };
