/**
 * EmailTemplateService.js — Pusat seluruh template email yang bisa dikustom.
 * ─────────────────────────────────────────────────────────────────────────────
 * Sebelumnya isi email (subject, heading, body) di-hardcode di banyak file.
 * Service ini menyatukan semuanya ke satu registry, dengan default yang SAMA
 * dengan teks lama (perilaku tidak berubah sampai admin mengedit di UI).
 *
 * Penyimpanan override: app_settings, key = `emailtpl_<type>_<field>`.
 *   field: subject | heading | intro | outro | enabled | button_label | accent
 *
 * Cara pakai di sender:
 *   const EmailTpl = require('./EmailTemplateService');
 *   const built = await EmailTpl.render('invoice_unpaid', vars, { bodyExtraHtml });
 *   await EmailService.send({ to, subject: built.subject, html: built.html, text: built.text });
 *
 * `vars` = objek nilai placeholder, mis. { nama, invoice, jumlah, ... }.
 * `bodyExtraHtml` (opsional) = blok HTML khusus (tabel rincian, tombol bayar, dst)
 * yang disisipkan di tengah body — sender boleh tetap membangunnya sendiri.
 */

const { Op } = require('sequelize');

// ── Daftar field yang tersimpan per template ────────────────────────
const FIELDS = ['enabled', 'subject', 'heading', 'intro', 'outro', 'button_label', 'accent'];

// ── Registry seluruh tipe email + default-nya ───────────────────────
// `vars` di sini hanya untuk dokumentasi/UI (chip variabel + data dummy preview).
const TEMPLATES = {
  invoice_unpaid: {
    label: 'Kirim Invoice (Tagihan)',
    desc: 'Email tagihan yang dikirim ke pelanggan beserta lampiran invoice PDF.',
    icon: 'invoice',
    defaults: {
      enabled: '1',
      subject: 'Tagihan {invoice} ({periode}) — {perusahaan}',
      heading: 'Tagihan Layanan Internet',
      intro:   'Halo {nama}, berikut tagihan layanan internet Anda untuk periode {periode}. Mohon lakukan pembayaran sebelum tanggal {jatuh_tempo}.',
      outro:   'Terima kasih telah menjadi pelanggan setia {perusahaan}.',
      button_label: 'Bayar Sekarang',
      accent:  '#1f8bff'
    },
    vars: ['nama', 'invoice', 'periode', 'jumlah', 'jatuh_tempo', 'paket', 'perusahaan'],
    // Email invoice asli memakai layout sendiri (invoiceEmail.js) dgn warna & footer
    // terpisah, jadi Outro & Warna Aksen di sini tidak berefek → disembunyikan.
    hiddenFields: ['outro', 'accent'],
    note: 'Email invoice memakai tata letak khusus (lampiran PDF & info rekening). Subject, Heading, Intro, dan Label Tombol di sini diterapkan ke email invoice.',
    sample: {
      nama: 'Budi Santoso', invoice: 'INV-2026-0042', periode: 'Juni 2026',
      jumlah: 'Rp 150.000', jatuh_tempo: '20 Juni 2026', paket: 'Home 50 Mbps', perusahaan: 'FLAYNET Network'
    }
  },

  invoice_overdue: {
    label: 'Notifikasi Tagihan Jatuh Tempo',
    desc: 'Pengingat saat invoice melewati / mendekati tanggal jatuh tempo.',
    icon: 'clock',
    defaults: {
      enabled: '1',
      subject: 'Pengingat: Tagihan {invoice} Jatuh Tempo — {perusahaan}',
      heading: 'Pengingat Tagihan',
      intro:   'Halo {nama}, tagihan Anda {invoice} sebesar {jumlah} telah jatuh tempo pada {jatuh_tempo}.',
      outro:   'Mohon segera lakukan pembayaran untuk menghindari pemutusan layanan. Abaikan email ini bila Anda sudah membayar.',
      button_label: 'Bayar Sekarang',
      accent:  '#e08a00'
    },
    vars: ['nama', 'invoice', 'periode', 'jumlah', 'jatuh_tempo', 'paket', 'perusahaan'],
    sample: {
      nama: 'Budi Santoso', invoice: 'INV-2026-0042', periode: 'Juni 2026',
      jumlah: 'Rp 150.000', jatuh_tempo: '20 Juni 2026', paket: 'Home 50 Mbps', perusahaan: 'FLAYNET Network'
    }
  },

  invoice_paid: {
    label: 'Pembayaran Diterima (Lunas)',
    desc: 'Email konfirmasi saat pembayaran invoice berhasil / lunas, dengan kwitansi PDF.',
    icon: 'check',
    defaults: {
      enabled: '1',
      subject: 'Pembayaran Diterima {invoice} — {perusahaan}',
      heading: 'Pembayaran Diterima — Terima Kasih',
      intro:   'Halo {nama}, pembayaran Anda untuk invoice {invoice} sebesar {jumlah} telah kami terima.',
      outro:   'Terima kasih atas pembayaran Anda. Layanan internet Anda aktif hingga {jatuh_tempo}.',
      button_label: '',
      accent:  '#16a34a'
    },
    vars: ['nama', 'invoice', 'periode', 'jumlah', 'metode', 'tanggal_bayar', 'jatuh_tempo', 'perusahaan'],
    // Sekarang email lunas memakai wrapper template (lewat PaymentController), jadi
    // hanya Label Tombol yang tak relevan (kwitansi tak pakai tombol).
    hiddenFields: ['button_label'],
    note: 'Email kwitansi memakai tata letak ini + lampiran kwitansi PDF. Subject, Heading, Intro, Outro, dan Warna Aksen akan diterapkan.',
    sample: {
      nama: 'Budi Santoso', invoice: 'INV-2026-0042', periode: 'Juni 2026', jumlah: 'Rp 150.000',
      metode: 'Transfer Bank', tanggal_bayar: '15 Juni 2026', jatuh_tempo: '20 Juli 2026', perusahaan: 'FLAYNET Network'
    }
  },

  customer_welcome: {
    label: 'Pelanggan Baru Terdaftar',
    desc: 'Email selamat datang otomatis saat ada pelanggan / customer baru mendaftar.',
    icon: 'user',
    defaults: {
      enabled: '0',
      subject: 'Selamat Datang di {perusahaan}, {nama}!',
      heading: 'Selamat Datang 👋',
      intro:   'Halo {nama}, terima kasih telah mendaftar di {perusahaan}. Akun layanan Anda telah dibuat.',
      outro:   'Tim kami akan segera menghubungi Anda untuk proses pemasangan. Simpan email ini sebagai referensi.',
      button_label: '',
      accent:  '#1f8bff'
    },
    vars: ['nama', 'id_pelanggan', 'paket', 'telepon', 'email', 'perusahaan'],
    sample: {
      nama: 'Budi Santoso', id_pelanggan: 'CUST-00128', paket: 'Home 50 Mbps',
      telepon: '0812-3456-7890', email: 'budi@email.com', perusahaan: 'FLAYNET Network'
    }
  },

  voucher_delivery: {
    label: 'Kirim Voucher (Beli Voucher)',
    desc: 'Email berisi kode voucher saat ada pembeli di halaman publik /beli-voucher.',
    icon: 'ticket',
    defaults: {
      enabled: '1',
      subject: '🎉 Voucher WiFi {paket} — {order}',
      heading: 'Voucher WiFi Anda Siap!',
      intro:   'Halo {nama}, terima kasih telah membeli voucher di {perusahaan}. Berikut detail voucher Anda.',
      outro:   'Masukkan username & password di atas pada halaman login WiFi untuk mulai terhubung. Simpan email ini sebagai bukti.',
      button_label: '',
      accent:  '#1f8bff'
    },
    vars: ['nama', 'order', 'paket', 'jumlah', 'username', 'password', 'perusahaan'],
    sample: {
      nama: 'Pembeli', order: 'VC-7H3K9P', paket: 'Voucher 3 Hari', jumlah: 'Rp 13.000',
      username: 'wifi-7h3k9p', password: 'a1b2c3', perusahaan: 'FLAYNET Network'
    }
  },

  smtp_test: {
    label: 'Email Uji (Test SMTP)',
    desc: 'Email percobaan untuk memverifikasi konfigurasi SMTP.',
    icon: 'bolt',
    defaults: {
      enabled: '1',
      subject: 'Test Email — Konfigurasi SMTP Berhasil',
      heading: '✓ SMTP Berfungsi',
      intro:   'Ini adalah email percobaan dari {perusahaan}. Jika Anda menerimanya, konfigurasi SMTP sudah benar.',
      outro:   'Dikirim otomatis oleh sistem.',
      button_label: '',
      accent:  '#1f8bff'
    },
    vars: ['perusahaan', 'waktu'],
    sample: { perusahaan: 'FLAYNET Network', waktu: new Date().toLocaleString('id-ID') }
  }
};

// ── Util ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Ganti {placeholder} dengan nilai dari vars. Placeholder tak dikenal dibiarkan.
function applyVars(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) =>
    (k in vars ? (vars[k] == null ? '' : String(vars[k])) : m));
}

// ── Loader override dari app_settings (cache 20 detik) ──────────────
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 20 * 1000;

async function _loadOverrides(force) {
  const now = Date.now();
  if (!force && _cache && (now - _cacheAt) < CACHE_MS) return _cache;
  const map = {};
  try {
    const { AppSetting } = require('../models');
    const rows = await AppSetting.findAll({
      where: { key: { [Op.or]: [{ [Op.like]: 'emailtpl_%' }, { [Op.like]: 'invoice_email_%' }] } }
    });
    rows.forEach(r => { map[r.key] = r.value; });
  } catch (_) { /* DB belum siap → pakai default */ }
  _cache = map; _cacheAt = now;
  return map;
}

function clearCache() { _cache = null; _cacheAt = 0; }

// Ambil konfigurasi efektif (default ditimpa override) untuk satu tipe.
async function getConfig(type, force) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error('Unknown email template: ' + type);
  const ov = await _loadOverrides(force);
  const cfg = { ...tpl.defaults };
  const bridge = LEGACY_BRIDGE[type] || {};
  FIELDS.forEach(f => {
    const k = `emailtpl_${type}_${f}`;
    if (ov[k] !== undefined && ov[k] !== null && ov[k] !== '') {
      cfg[f] = ov[k];
    } else if (bridge[f] && ov[bridge[f]] !== undefined && ov[bridge[f]] !== null && ov[bridge[f]] !== '') {
      // Fallback ke nilai lama invoice_email_* bila key baru belum di-set.
      cfg[f] = ov[bridge[f]];
    }
  });
  return cfg;
}

// Apakah tipe email ini diaktifkan? (untuk gating pengiriman)
async function isEnabled(type) {
  try { const c = await getConfig(type); return c.enabled !== '0' && c.enabled !== 0 && c.enabled !== false; }
  catch (_) { return true; }
}

// ── Wrapper HTML standar (kerangka kartu email yang rapi & responsif) ─
function wrapHtml({ accent, companyName, heading, introHtml, bodyExtraHtml, outroHtml, buttonLabel, buttonUrl, footerNote }) {
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(accent || '') ? accent : '#1f8bff';
  const btn = (buttonLabel && buttonUrl)
    ? `<tr><td style="padding:6px 26px 4px;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
           <a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:${safeAccent};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:12px;">${escapeHtml(buttonLabel)}</a>
         </td></tr></table>
       </td></tr>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef3fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3fb;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e8eef9;font-family:Arial,Helvetica,sans-serif;">
    <!-- Header -->
    <tr><td style="background:${safeAccent};padding:22px 26px;">
      <div style="color:#fff;font-size:18px;font-weight:800;">${escapeHtml(companyName)}</div>
      <div style="color:rgba(255,255,255,.92);font-size:13.5px;margin-top:3px;font-weight:600;">${escapeHtml(heading)}</div>
    </td></tr>
    <!-- Intro -->
    <tr><td style="padding:22px 26px 6px;color:#1f2937;font-size:14px;line-height:1.65;">${introHtml || ''}</td></tr>
    ${bodyExtraHtml ? `<tr><td style="padding:6px 26px;">${bodyExtraHtml}</td></tr>` : ''}
    ${btn}
    ${outroHtml ? `<tr><td style="padding:10px 26px 4px;color:#475569;font-size:13px;line-height:1.65;">${outroHtml}</td></tr>` : ''}
    <!-- Footer -->
    <tr><td style="padding:18px 26px 24px;">
      <div style="border-top:1px solid #eef2f9;padding-top:14px;color:#94a3b8;font-size:11.5px;line-height:1.7;">${footerNote || ''}</div>
    </td></tr>
  </table>
  <div style="font-size:11px;color:#aab3c6;margin-top:12px;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(companyName)}</div>
</td></tr>
</table>
</body></html>`;
}

/**
 * render(type, vars, opts) → { subject, html, text, enabled, accent }
 * opts:
 *   - bodyExtraHtml : HTML blok rincian/tabel khusus (disisipkan di body)
 *   - buttonUrl     : URL tombol CTA (kalau template punya button_label)
 *   - companyName   : nama perusahaan (kalau tak diisi, diambil dari vars.perusahaan)
 *   - footerNote    : override catatan footer
 */
async function render(type, vars = {}, opts = {}) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error('Unknown email template: ' + type);
  const cfg = await getConfig(type);
  const companyName = opts.companyName || vars.perusahaan || 'ISP';
  const v = { ...vars, perusahaan: companyName };

  const subject = applyVars(cfg.subject, v);
  const heading = applyVars(cfg.heading, v);
  const introHtml = escapeHtml(applyVars(cfg.intro, v)).replace(/\n/g, '<br>');
  const outroHtml = escapeHtml(applyVars(cfg.outro, v)).replace(/\n/g, '<br>');
  const footerNote = opts.footerNote
    || `Email ini dikirim otomatis oleh sistem ${escapeHtml(companyName)}. Mohon tidak membalas email ini.`;

  const html = wrapHtml({
    accent: cfg.accent,
    companyName,
    heading,
    introHtml,
    bodyExtraHtml: opts.bodyExtraHtml || '',
    outroHtml,
    buttonLabel: cfg.button_label,
    buttonUrl: opts.buttonUrl || '',
    footerNote
  });

  // Versi teks polos (fallback klien email tanpa HTML).
  const text = [applyVars(cfg.heading, v), '', applyVars(cfg.intro, v), '', applyVars(cfg.outro, v)]
    .join('\n').replace(/\n{3,}/g, '\n\n');

  return { subject, html, text, enabled: cfg.enabled !== '0', accent: cfg.accent };
}

// Daftar metadata untuk UI (label, desc, icon, vars, default, current value).
async function listForUi() {
  const ov = await _loadOverrides(true);
  return Object.keys(TEMPLATES).map(type => {
    const t = TEMPLATES[type];
    const bridge = LEGACY_BRIDGE[type] || {};
    const current = {};
    FIELDS.forEach(f => {
      const k = `emailtpl_${type}_${f}`;
      if (ov[k] !== undefined && ov[k] !== null && ov[k] !== '') current[f] = ov[k];
      else if (bridge[f] && ov[bridge[f]] !== undefined && ov[bridge[f]] !== null && ov[bridge[f]] !== '') current[f] = ov[bridge[f]];
      else current[f] = t.defaults[f];
    });
    return {
      type, label: t.label, desc: t.desc, icon: t.icon,
      vars: t.vars, sample: t.sample, defaults: t.defaults, current,
      hiddenFields: t.hiddenFields || [], note: t.note || ''
    };
  });
}

// ── Jembatan ke sistem lama invoice_email_* (dipakai invoiceEmail.js &
//    halaman Broadcast Invoice). Agar editing di satu tempat tetap sinkron,
//    field tertentu pada invoice_unpaid/invoice_paid dipetakan ke key lama. ──
const LEGACY_BRIDGE = {
  invoice_unpaid: {
    subject: 'invoice_email_subject_unpaid',
    heading: 'invoice_email_header_unpaid',
    intro:   'invoice_email_intro_unpaid',
    button_label: 'invoice_email_paybtn_label'
  },
  invoice_paid: {
    subject: 'invoice_email_subject_paid',
    heading: 'invoice_email_header_paid',
    intro:   'invoice_email_intro_paid'
  }
};

// Saat menyimpan emailtpl_<type>_<field>, kembalikan pasangan key lama yang
// perlu di-mirror (atau null bila tidak ada). Dipakai di route /app-settings.
function legacyMirror(type, field, value) {
  const m = LEGACY_BRIDGE[type];
  if (m && m[field]) return { key: m[field], value };
  return null;
}

module.exports = {
  TEMPLATES, FIELDS,
  render, getConfig, isEnabled, listForUi,
  clearCache, applyVars, escapeHtml, wrapHtml,
  LEGACY_BRIDGE, legacyMirror
};
