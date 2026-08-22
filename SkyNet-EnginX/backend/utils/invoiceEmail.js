// Helper terpusat untuk kirim INVOICE/KWITANSI via email.
// Dipakai oleh tombol "Kirim Email" manual di halaman Billing (per-invoice & bulk).
//
// PDF LAMPIRAN kini 100% IDENTIK dengan tampilan invoice on-screen:
//   - Layout mengikuti Template Invoice terpilih (banner/minimal/split/clean/merchant)
//   - Render via wkhtmltopdf memakai HTML yang sama dgn invoice-renderer.js
//     (backend/utils/invoiceHtml.js + buildInvoicePdf.js).
//   - Fallback ke pdfkit (receiptPdf.js) hanya kalau wkhtmltopdf tak tersedia.
//
// Status email & PDF mengikuti status invoice yang sebenarnya
//   - status 'paid'  -> tampilan LUNAS/PAID
//   - selain itu      -> tampilan BELUM LUNAS/UNPAID + info bank
//
// Mengembalikan { ok: boolean, reason?: string }.
const { Op } = require('sequelize');
const { localLogoPath } = require('./invoiceEmailLogo');

const ID_MONTHS = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// Susun config template (invtpl_*) + fallback Brand/Umum → bentuk yang dimengerti
// oleh invoiceHtml.js / receiptPdf.js.
async function loadTemplateConfig(AppSetting) {
  const tplRows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invtpl_%' } } });
  const tpl = {}; tplRows.forEach(r => { tpl[r.key.replace('invtpl_', '')] = r.value; });

  // Data perusahaan dari Settings > Umum (sumber utama), fallback ke invtpl & brand.
  const umumRows = await AppSetting.findAll({ where: { key: ['company_name','company_address','company_whatsapp','company_website','app_name','logo_url'] } });
  const umum = {}; umumRows.forEach(r => { umum[r.key] = r.value; });

  let companyName = (umum.company_name || '').trim() || tpl.company_name || '';
  if (!companyName) { try { companyName = await require('./companyInfo').getCompanyName(); } catch (_) {} }
  companyName = companyName || umum.app_name || 'ISP Provider';

  // Logo: invtpl_logo_url > logo_url global (Brand)
  let logoUrl = (tpl.logo_url || '').trim() || (umum.logo_url || '').trim();
  // wkhtmltopdf butuh path absolut/file:// untuk logo lokal.
  logoUrl = require('./invoiceEmailLogo').resolveLogoForPdf(logoUrl);

  return {
    // identitas
    primary_color: tpl.primary_color || '#1a6ef5',
    accent_color:  tpl.accent_color  || '#1d4ed8',
    text_color:    tpl.text_color    || '#0f172a',
    font_family:   tpl.font_family   || 'Inter',
    header_style:  tpl.header_style  || 'banner',
    show_logo:     tpl.show_logo,
    logo_url:      logoUrl,
    company_name:    companyName,
    company_tagline: tpl.company_tagline || 'Internet Service Provider',
    company_address: (umum.company_address || tpl.company_address || '').trim(),
    company_phone:   (umum.company_whatsapp || tpl.company_phone || '').trim(),
    company_email:   tpl.company_email || '',
    company_website: (umum.company_website || '').trim(),
    // toggles
    show_subtotal:       tpl.show_subtotal,
    show_tax:            tpl.show_tax,
    show_due_date:       tpl.show_due_date,
    show_payment_method: tpl.show_payment_method,
    show_active_until:   tpl.show_active_until,
    show_bank_info:      tpl.show_bank_info,
    show_signature:      tpl.show_signature,
    // label & teks
    invoice_label:           tpl.invoice_label           || 'INVOICE',
    section_recipient_label: tpl.section_recipient_label || 'TAGIHAN UNTUK',
    section_detail_label:    tpl.section_detail_label    || 'DETAIL INVOICE',
    thank_you_text:          tpl.thank_you_text          || 'Terima kasih telah menggunakan layanan kami.',
    footer_text:             tpl.footer_text             || 'Dokumen ini di-generate otomatis oleh sistem. Invoice ini sah tanpa tanda tangan basah.'
  };
}

// ── Format email invoice yang bisa dikustomisasi (saling sinkron dgn
//    halaman Broadcast Invoice & Settings). Semua key prefix invoice_email_*.
//    Default disediakan agar perilaku lama tetap sama bila belum di-set. ──
const INVOICE_EMAIL_DEFAULTS = {
  subject_unpaid: 'Tagihan {invoice} ({periode}) — {perusahaan}',
  subject_paid:   'Kwitansi Pembayaran {invoice} ({periode}) — {perusahaan}',
  header_unpaid:  'Tagihan Layanan Internet',
  header_paid:    'Pembayaran Lunas — Terima Kasih',
  intro_unpaid:   'Berikut tagihan layanan internet Anda{periode_intro}. Mohon lakukan pembayaran sebelum tanggal jatuh tempo.',
  intro_paid:     'Pembayaran Anda{periode_intro} telah kami terima. Berikut rinciannya:',
  footer_note:    'Email ini dikirim otomatis oleh sistem {perusahaan}. Mohon tidak membalas email ini.',
  show_bank:      '1',
  show_paybtn:    '0',
  paybtn_label:   'Bayar Sekarang',
};
async function loadEmailFormatConfig(AppSetting) {
  const rows = await AppSetting.findAll({ where: { key: { [Op.like]: 'invoice_email_%' } } });
  const cfg = { ...INVOICE_EMAIL_DEFAULTS };
  rows.forEach(r => {
    const k = r.key.replace('invoice_email_', '');
    if (k in cfg && r.value !== null && r.value !== undefined && r.value !== '') cfg[k] = r.value;
  });
  return cfg;
}
// Ganti placeholder {nama} {invoice} {periode} {jumlah} {jatuh_tempo} {perusahaan}
// {paket} {periode_intro} pada teks template email.
function applyEmailPlaceholders(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (vars[k] == null ? '' : String(vars[k])) : m));
}

// Susun objek invoice-data (bentuk sama dgn endpoint /invoices/:id/invoice-data)
// agar renderer menghasilkan tampilan identik dgn on-screen.
async function buildInvoiceDataForPdf(invoice, customer, tplCfg, AppSetting) {
  const moment = require('moment');

  // PPN
  let vatPercent = null;
  try { const tr = await AppSetting.findOne({ where: { key: 'tax_rate' } }); if (tr?.value) vatPercent = parseFloat(tr.value); } catch (_) {}
  const taxLabelRow = await AppSetting.findOne({ where: { key: 'tax_label' } });
  const taxLabel = taxLabelRow?.value || 'PPN';

  const subtotal = parseFloat(invoice.amount || 0);
  const taxAmount = parseFloat(invoice.tax || 0);
  const total = parseFloat(invoice.total || invoice.amount || 0);
  const isPaid = invoice.status === 'paid';

  // Info bank/e-wallet (bentuk {bank,no,name} sesuai renderer)
  let bankAccounts = [];
  try {
    const paRow = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
    if (paRow?.value) {
      const arr = JSON.parse(paRow.value);
      if (Array.isArray(arr)) {
        bankAccounts = arr
          .filter(a => a && a.is_active !== false && ['bank', 'ewallet'].includes(a.type))
          .map(a => ({
            bank: String(a.provider || '').toUpperCase() || (a.type === 'ewallet' ? 'E-WALLET' : 'BANK'),
            no:   String(a.account_number || ''),
            name: String(a.account_owner  || '')
          }))
          .filter(a => a.no);
      }
    }
  } catch (_) {}

  // active_until: belum lunas → due_date; lunas → +1 bulan
  const addMonth = (d) => { try { const m = moment(d); return m.isValid() ? m.add(1, 'month').format('YYYY-MM-DD') : null; } catch (_) { return null; } };
  const active_until = isPaid ? (addMonth(invoice.due_date) || invoice.due_date) : invoice.due_date;

  return {
    invoice_number: invoice.invoice_number,
    cust_name:    customer.name,
    cid:          customer.customer_id,
    cust_phone:   customer.phone || '',
    cust_address: customer.address || '',
    cust_email:   customer.email || '',
    pkg_name:     customer.package?.name || 'Layanan Internet',
    period_month: invoice.period_month,
    period_year:  invoice.period_year,
    due_date:     invoice.due_date,
    active_until,
    paid_date:    invoice.paid_date || null,
    payment_date: isPaid ? (invoice.paid_date || invoice.updated_at || null) : null,
    method_label: null,
    reference_number: null,
    invoice_subtotal: subtotal,
    invoice_tax:      taxAmount,
    invoice_total:    total,
    tax_label:        taxLabel,
    tax_rate:         vatPercent,
    invoice_status:   invoice.status,
    bank_accounts:    bankAccounts
  };
}

async function sendInvoiceEmail(invoice, opts = {}) {
  const models = require('../models');
  const { AppSetting } = models;
  const EmailService = require('../services/EmailService');
  const moment = require('moment');

  const customer = invoice.customer || {};
  if (!customer.email) return { ok: false, reason: 'no_email' };

  // SMTP harus aktif
  const smtpRow = await AppSetting.findOne({ where: { key: 'smtp_enabled' } });
  if (smtpRow?.value !== '1') return { ok: false, reason: 'smtp_disabled' };

  // Toggle lampiran PDF (default ON) — bisa dipaksa via opts.attachReceipt
  let attachReceipt;
  if (typeof opts.attachReceipt === 'boolean') {
    attachReceipt = opts.attachReceipt;
  } else {
    const attachRow = await AppSetting.findOne({ where: { key: 'email_attach_receipt' } });
    attachReceipt = !attachRow || attachRow.value === '' || attachRow.value === '1';
  }

  // Config template + data perusahaan
  const tplCfg = await loadTemplateConfig(AppSetting);
  const emailFmt = await loadEmailFormatConfig(AppSetting);
  const companyName = tplCfg.company_name;
  const compAddress = tplCfg.company_address;
  const compPhone   = tplCfg.company_phone;
  const compWebsite = tplCfg.company_website;
  const primaryColor = tplCfg.primary_color;
  const accentColor  = tplCfg.accent_color;

  const subtotal = parseFloat(invoice.amount || 0);
  const taxAmount = parseFloat(invoice.tax || 0);
  const total = parseFloat(invoice.total || invoice.amount || 0);
  const showTax = taxAmount > 0;
  const isPaid = invoice.status === 'paid';

  // PPN persen & label (untuk body email)
  let vatPercent = null;
  try { const tr = await AppSetting.findOne({ where: { key: 'tax_rate' } }); if (tr?.value) vatPercent = parseFloat(tr.value); } catch (_) {}
  const taxLabelRow = await AppSetting.findOne({ where: { key: 'tax_label' } });
  const taxLabel = taxLabelRow?.value || 'PPN';

  // Periode tagihan
  const periodLabel = (invoice.period_month && invoice.period_year)
    ? `${ID_MONTHS[invoice.period_month] || invoice.period_month} ${invoice.period_year}`
    : '';

  const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const dueFmt = invoice.due_date ? moment(invoice.due_date).format('DD/MM/YYYY') : '-';
  const invoiceDateFmt = invoice.created_at ? moment(invoice.created_at).format('DD/MM/YYYY') : moment().format('DD/MM/YYYY');
  const paidDateFmt = invoice.paid_date ? moment(invoice.paid_date).format('DD/MM/YYYY') : invoiceDateFmt;

  // ── PDF lampiran: identik dengan invoice on-screen (via wkhtmltopdf) ──
  let pdfBuf = null;
  if (attachReceipt) {
    try {
      const { buildInvoicePdf } = require('./buildInvoicePdf');
      const invData = await buildInvoiceDataForPdf(invoice, customer, tplCfg, AppSetting);
      pdfBuf = await buildInvoicePdf(invData, tplCfg, {
        // Fallback pdfkit lama bila wkhtmltopdf tidak tersedia di server.
        fallback: async () => {
          const { buildReceiptPdf } = require('./receiptPdf');
          let bankAccounts = [];
          try {
            const paRow = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
            if (paRow?.value) { const arr = JSON.parse(paRow.value); if (Array.isArray(arr)) bankAccounts = arr.filter(m => m && m.type === 'bank').map(b => ({ bank: b.provider, account_number: b.account_number, account_owner: b.account_owner })); }
          } catch (_) {}
          return buildReceiptPdf({
            companyName, companyTagline: tplCfg.company_tagline,
            companyAddress: compAddress, companyPhone: compPhone, companyEmail: tplCfg.company_email,
            logoPath: localLogoPath(tplCfg.logo_url),
            primaryColor, accentColor, textColor: tplCfg.text_color,
            invoiceLabel: tplCfg.invoice_label,
            recipientLabel: tplCfg.section_recipient_label,
            detailLabel: tplCfg.section_detail_label,
            thankYouText: tplCfg.thank_you_text, footerText: tplCfg.footer_text,
            customerName: customer.name, customerId: customer.customer_id, customerAddress: customer.address,
            customerPhone: customer.phone || '', customerEmail: customer.email || '',
            productName: customer.package?.name || 'Layanan Internet', qty: 1, unitPrice: subtotal,
            vatPercent: showTax ? vatPercent : null,
            invoiceNumber: invoice.invoice_number, invoiceDateFormatted: invoiceDateFmt,
            paymentDateFormatted: paidDateFmt, dueDateFormatted: dueFmt, periodLabel,
            activeUntilFormatted: !isPaid && invoice.due_date ? moment(invoice.due_date).format('DD/MM/YYYY') : null,
            methodLabel: null, referenceNo: null, notes: invoice.notes || null,
            subtotal, taxLabel, taxAmount, total, showTax,
            showDueDate: tplCfg.show_due_date !== '0', showBankInfo: true,
            bankAccounts, statusPaid: isPaid
          });
        }
      });
    } catch (_) { pdfBuf = null; }
  }

  // Variabel placeholder untuk teks email yang bisa dikustom
  const periodIntroRaw = periodLabel ? ` untuk periode ${periodLabel}` : '';
  const emailVars = {
    nama: customer.name || 'Pelanggan',
    invoice: invoice.invoice_number || '',
    periode: periodLabel || '-',
    periode_intro: periodLabel ? ` untuk periode <b>${periodLabel}</b>` : '',
    jumlah: fmt(total),
    jatuh_tempo: dueFmt,
    paket: customer.package?.name || '-',
    perusahaan: companyName,
  };

  // ── Email HTML body (ringkasan, sadar status & periode) ──
  const headerColor = isPaid ? '#16a34a' : primaryColor;
  const headerSub = applyEmailPlaceholders(isPaid ? emailFmt.header_paid : emailFmt.header_unpaid, emailVars);
  const taxLbl = taxLabel + (showTax && vatPercent != null ? ' (' + vatPercent + '%)' : '');
  const taxRows = showTax ? `
        <tr><td style="padding:7px 0;color:#64748b;border-top:1px solid #eef2f9;">Subtotal</td><td style="padding:7px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${fmt(subtotal)}</td></tr>
        <tr><td style="padding:7px 0;color:#64748b;">${taxLbl}</td><td style="padding:7px 0;text-align:right;font-weight:700;color:#0f172a;">${fmt(taxAmount)}</td></tr>` : '';

  const periodRow = periodLabel ? `
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Periode</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${periodLabel}</td></tr>` : '';

  let bankHtml = '';
  if (!isPaid && emailFmt.show_bank !== '0') {
    let banks = [];
    try {
      const paRow = await AppSetting.findOne({ where: { key: 'payment_accounts' } });
      if (paRow?.value) { const arr = JSON.parse(paRow.value); if (Array.isArray(arr)) banks = arr.filter(m => m && m.type === 'bank'); }
    } catch (_) {}
    if (banks.length) {
      bankHtml = `<div style="margin-top:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;">
        <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:6px;">Pembayaran transfer ke:</div>
        ${banks.map(b => `<div style="font-size:12px;color:#475569;">${(b.provider||'').toUpperCase()} - ${b.account_number||'-'}${b.account_owner ? ' a.n. ' + b.account_owner : ''}</div>`).join('')}
      </div>`;
    }
  }

  const footRows = [];
  if (compAddress) footRows.push(compAddress);
  if (compPhone)   footRows.push('Telp/WA: ' + compPhone);
  if (compWebsite) footRows.push(compWebsite);
  const companyFooter = `
    <div style="margin-top:16px;padding:16px 24px;background:#0f172a;border-radius:0 0 14px 14px;">
      <div style="color:#fff;font-size:13px;font-weight:800;">${companyName}</div>
      ${footRows.map(t => `<div style="color:#94a3b8;font-size:11px;margin-top:3px;">${t}</div>`).join('')}
    </div>`;

  const totalLabel = isPaid ? ('Total Dibayar' + (showTax ? ' (termasuk ' + taxLabel + ')' : ''))
                            : ('Total Tagihan' + (showTax ? ' (termasuk ' + taxLabel + ')' : ''));
  const intro = applyEmailPlaceholders(isPaid ? emailFmt.intro_paid : emailFmt.intro_unpaid, emailVars);

  // Tombol "Bayar Sekarang" opsional — hanya untuk invoice belum lunas, bila
  // diaktifkan. Memakai LINK PUBLIK PER-INVOICE (/pub/invoice/<id>.<sig>) yang
  // sama dengan link invoice publik tiap pelanggan, jadi langsung membuka
  // halaman pembayaran invoice periode tsb. Base URL: setting public_base_url
  // (utama) → fallback APP_URL/BASE_URL dari env.
  let payBtnHtml = '';
  if (!isPaid && emailFmt.show_paybtn === '1') {
    let baseUrl = '';
    try { const bu = await AppSetting.findOne({ where: { key: 'public_base_url' } }); baseUrl = (bu?.value || '').trim().replace(/\/+$/, ''); } catch (_) {}
    if (!baseUrl) baseUrl = (process.env.APP_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
    if (baseUrl && invoice.id) {
      let payUrl;
      try {
        const { generateInvoiceToken } = require('./templateHelper');
        payUrl = `${baseUrl}/pub/invoice/${generateInvoiceToken(invoice.id)}`;
      } catch (_) { payUrl = null; }
      if (payUrl) {
        const btnLabel = applyEmailPlaceholders(emailFmt.paybtn_label || 'Bayar Sekarang', emailVars);
        payBtnHtml = `<div style="text-align:center;margin:18px 0 2px;">
          <a href="${payUrl}" style="display:inline-block;background:${accentColor};color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:10px;">${btnLabel}</a>
        </div>
        <div style="text-align:center;margin-top:6px;font-size:10.5px;color:#94a3b8;word-break:break-all;">${payUrl}</div>`;
      }
    }
  }

  const footerNote = applyEmailPlaceholders(emailFmt.footer_note, emailVars);

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#f8faff;padding:24px;">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8eef7;">
      <div style="background:${headerColor};padding:20px 24px;">
        <div style="color:#fff;font-size:18px;font-weight:800;">${companyName}</div>
        <div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:2px;">${headerSub}</div>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 14px;color:#0f172a;font-size:14px;">Halo <b>${customer.name || 'Pelanggan'}</b>,</p>
        <p style="margin:0 0 16px;color:#475569;font-size:13.5px;line-height:1.6;">${intro}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <tr><td style="padding:8px 0;color:#64748b;">No. Invoice</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;">${invoice.invoice_number || '-'}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Paket</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${customer.package?.name || '-'}</td></tr>
          ${periodRow}
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">${isPaid ? 'Tanggal Bayar' : 'Jatuh Tempo'}</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${isPaid ? '#16a34a' : '#dc2626'};border-top:1px solid #eef2f9;">${isPaid ? paidDateFmt : dueFmt}</td></tr>
          ${taxRows}
        </table>
        <div style="margin:18px 0 4px;padding:16px;background:${isPaid ? '#f0fdf4' : '#eff6ff'};border-radius:10px;text-align:center;">
          <div style="font-size:12px;color:${isPaid ? '#15803d' : accentColor};">${totalLabel}</div>
          <div style="font-size:26px;font-weight:800;color:${isPaid ? '#16a34a' : accentColor};margin-top:2px;">${fmt(total)}</div>
          <div style="margin-top:10px;display:inline-block;padding:4px 14px;border-radius:999px;border:1.5px solid ${isPaid ? '#16a34a' : '#d97706'};color:${isPaid ? '#16a34a' : '#d97706'};font-size:11px;font-weight:800;letter-spacing:.5px;">${isPaid ? 'LUNAS' : 'BELUM LUNAS'}</div>
        </div>
        ${bankHtml}
        ${payBtnHtml}
        ${pdfBuf ? '<p style="margin:14px 0 0;color:#475569;font-size:12.5px;line-height:1.6;">' + (isPaid ? 'Kwitansi' : 'Invoice') + ' terlampir dalam format PDF (sesuai format invoice resmi).</p>' : ''}
      </div>
      ${companyFooter}
    </div>
    <p style="margin:14px 0 0;color:#94a3b8;font-size:11px;text-align:center;">${footerNote}</p>
  </div>`;

  const subjectTpl = isPaid ? emailFmt.subject_paid : emailFmt.subject_unpaid;
  const subject = applyEmailPlaceholders(subjectTpl, emailVars).replace(/\(\s*-\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  const attachments = pdfBuf ? [{
    filename: `${isPaid ? 'Kwitansi' : 'Invoice'}-${invoice.invoice_number || invoice.id}.pdf`,
    content: pdfBuf, contentType: 'application/pdf'
  }] : [];

  const ok = await EmailService.send({
    to: customer.email,
    subject,
    html,
    text: `${isPaid ? 'Pembayaran' : 'Tagihan'} ${fmt(total)} untuk invoice ${invoice.invoice_number || ''}${periodLabel ? ' periode ' + periodLabel : ''}.`,
    attachments,
    type: isPaid ? 'invoice_paid' : 'invoice_unpaid'
  });
  return { ok: !!ok, reason: ok ? null : 'send_failed' };
}

// ── Preview HTML email invoice (untuk halaman Broadcast Invoice / Settings) ──
// Memakai config format + data contoh, meniru layout body asli di
// sendInvoiceEmail. fmtCfg = hasil loadEmailFormatConfig, tplCfg opsional.
function buildPreviewHtml({ fmtCfg, tplCfg = {}, isPaid = false, sample = {} }) {
  const companyName = tplCfg.company_name || sample.company || 'Nama Perusahaan';
  const primaryColor = tplCfg.primary_color || '#1a6ef5';
  const accentColor  = tplCfg.accent_color  || '#1d4ed8';
  const s = {
    nama: sample.nama || 'Budi Santoso',
    invoice: sample.invoice || 'INV-2026-0001',
    periode: sample.periode || 'Juni 2026',
    paket: sample.paket || 'Home 30 Mbps',
    jumlah: sample.jumlah || 'Rp 250.000',
    jatuh_tempo: sample.jatuh_tempo || '15/06/2026',
    address: sample.address || 'Jl. Merdeka No. 1',
  };
  const vars = {
    nama: s.nama, invoice: s.invoice, periode: s.periode, paket: s.paket,
    jumlah: s.jumlah, jatuh_tempo: s.jatuh_tempo, perusahaan: companyName,
    periode_intro: s.periode ? ` untuk periode <b>${s.periode}</b>` : '',
  };
  const headerColor = isPaid ? '#16a34a' : primaryColor;
  const headerSub = applyEmailPlaceholders(isPaid ? fmtCfg.header_paid : fmtCfg.header_unpaid, vars);
  const intro = applyEmailPlaceholders(isPaid ? fmtCfg.intro_paid : fmtCfg.intro_unpaid, vars);
  const footerNote = applyEmailPlaceholders(fmtCfg.footer_note, vars);
  const totalLabel = isPaid ? 'Total Dibayar' : 'Total Tagihan';
  const bankHtml = (!isPaid && fmtCfg.show_bank !== '0')
    ? `<div style="margin-top:16px;padding:14px 16px;background:#f8fafc;border-radius:10px;">
        <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:6px;">Pembayaran transfer ke:</div>
        <div style="font-size:12px;color:#475569;">BCA - 1234567890 a.n. ${companyName}</div>
      </div>` : '';
  const sampleBase = (sample.baseUrl || 'https://app.isp.id').replace(/\/+$/, '');
  const samplePayUrl = `${sampleBase}/pub/invoice/119.eb845666d44892fa`;
  const payBtnHtml = (!isPaid && fmtCfg.show_paybtn === '1')
    ? `<div style="text-align:center;margin:18px 0 2px;"><a href="#" style="display:inline-block;background:${accentColor};color:#fff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 28px;border-radius:10px;">${applyEmailPlaceholders(fmtCfg.paybtn_label || 'Bayar Sekarang', vars)}</a></div>
       <div style="text-align:center;margin-top:6px;font-size:10.5px;color:#94a3b8;word-break:break-all;">${samplePayUrl}</div>` : '';
  const subject = applyEmailPlaceholders(isPaid ? fmtCfg.subject_paid : fmtCfg.subject_unpaid, vars).replace(/\(\s*-\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();

  const body = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#f8faff;padding:24px;">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e8eef7;">
      <div style="background:${headerColor};padding:20px 24px;">
        <div style="color:#fff;font-size:18px;font-weight:800;">${companyName}</div>
        <div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:2px;">${headerSub}</div>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 14px;color:#0f172a;font-size:14px;">Halo <b>${s.nama}</b>,</p>
        <p style="margin:0 0 16px;color:#475569;font-size:13.5px;line-height:1.6;">${intro}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <tr><td style="padding:8px 0;color:#64748b;">No. Invoice</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;">${s.invoice}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Paket</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${s.paket}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">Periode</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#0f172a;border-top:1px solid #eef2f9;">${s.periode}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #eef2f9;">${isPaid ? 'Tanggal Bayar' : 'Jatuh Tempo'}</td><td style="padding:8px 0;text-align:right;font-weight:700;color:${isPaid ? '#16a34a' : '#dc2626'};border-top:1px solid #eef2f9;">${s.jatuh_tempo}</td></tr>
        </table>
        <div style="margin:18px 0 4px;padding:16px;background:${isPaid ? '#f0fdf4' : '#eff6ff'};border-radius:10px;text-align:center;">
          <div style="font-size:12px;color:${isPaid ? '#15803d' : accentColor};">${totalLabel}</div>
          <div style="font-size:26px;font-weight:800;color:${isPaid ? '#16a34a' : accentColor};margin-top:2px;">${s.jumlah}</div>
          <div style="margin-top:10px;display:inline-block;padding:4px 14px;border-radius:999px;border:1.5px solid ${isPaid ? '#16a34a' : '#d97706'};color:${isPaid ? '#16a34a' : '#d97706'};font-size:11px;font-weight:800;letter-spacing:.5px;">${isPaid ? 'LUNAS' : 'BELUM LUNAS'}</div>
        </div>
        ${bankHtml}
        ${payBtnHtml}
      </div>
      <div style="margin-top:16px;padding:16px 24px;background:#0f172a;border-radius:0 0 14px 14px;">
        <div style="color:#fff;font-size:13px;font-weight:800;">${companyName}</div>
      </div>
    </div>
    <p style="margin:14px 0 0;color:#94a3b8;font-size:11px;text-align:center;">${footerNote}</p>
  </div>`;
  return { subject, html: body };
}

module.exports = { sendInvoiceEmail, loadEmailFormatConfig, applyEmailPlaceholders, INVOICE_EMAIL_DEFAULTS, loadTemplateConfig, buildPreviewHtml };
