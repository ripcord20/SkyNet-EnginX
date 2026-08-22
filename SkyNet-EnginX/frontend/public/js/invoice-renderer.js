/**
 * Invoice Renderer — single source of truth untuk render invoice.
 *
 * Dipakai oleh:
 *   - /invoice/inv/:id           (invoice asli dari billing)
 *   - /invoice/:paymentId        (invoice dari pembayaran)
 *   - /invoice-template          (live preview di designer page)
 *   - /invoice-template/preview-print (test print dengan data dummy)
 *
 * Semua HTML structure & styling di sini agar konsisten 100% antara designer preview
 * dan invoice asli yang dicetak ke pelanggan.
 *
 * Usage:
 *   InvoiceRenderer.render(targetEl, invoiceData, templateConfig);
 */
(function (global) {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }
  function fmtRp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }
  function fmtDate(s) {
    if (!s) return '–';
    var d = new Date(s + 'T00:00:00');
    var m = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    return d.getDate() + ' ' + m[d.getMonth()] + ' ' + d.getFullYear();
  }
  var MONTHS_ID = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

  // Lighten/darken color helpers
  function hexToRgb(hex) {
    hex = (hex || '#000000').replace('#','');
    if (hex.length === 3) hex = hex.split('').map(function(c){return c+c;}).join('');
    var n = parseInt(hex, 16);
    return [(n>>16)&255, (n>>8)&255, n&255];
  }
  function rgbToHex(r,g,b) {
    function c(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2,'0'); }
    return '#' + c(r) + c(g) + c(b);
  }
  function darken(hex, pct) {
    var rgb = hexToRgb(hex), f = 1 - (pct/100);
    return rgbToHex(rgb[0]*f, rgb[1]*f, rgb[2]*f);
  }
  function lighten(hex, pct) {
    var rgb = hexToRgb(hex), f = pct/100;
    return rgbToHex(rgb[0]+(255-rgb[0])*f, rgb[1]+(255-rgb[1])*f, rgb[2]+(255-rgb[2])*f);
  }

  // Config dengan defaults — terima string '0'/'1' atau boolean
  function normalizeBool(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    return v !== '0' && String(v).toLowerCase() !== 'false';
  }
  function normalizeConfig(t) {
    t = t || {};
    return {
      primary:        t.primary_color || t.primary || '#1a6ef5',
      accent:         t.accent_color  || t.accent  || '#1d4ed8',
      text:           t.text_color    || t.text    || '#0f172a',
      font:           t.font_family   || t.font    || 'Inter',
      headerStyle:    t.header_style  || t.headerStyle || 'banner',
      showLogo:       normalizeBool(t.show_logo  != null ? t.show_logo  : t.showLogo,  true),
      logoUrl:        String(t.logo_url || t.logoUrl || '').trim(),
      companyName:    t.company_name    || t.companyName    || '',
      companyTagline: t.company_tagline || t.companyTagline || 'Internet Service Provider',
      companyAddress: t.company_address || t.companyAddress || '',
      companyPhone:   t.company_phone   || t.companyPhone   || '',
      companyEmail:   t.company_email   || t.companyEmail   || '',
      showSubtotal:      normalizeBool(t.show_subtotal       != null ? t.show_subtotal       : t.showSubtotal,      true),
      showTax:           normalizeBool(t.show_tax            != null ? t.show_tax            : t.showTax,           true),
      showDueDate:       normalizeBool(t.show_due_date       != null ? t.show_due_date       : t.showDueDate,       true),
      showPaymentMethod: normalizeBool(t.show_payment_method != null ? t.show_payment_method : t.showPaymentMethod, true),
      showActiveUntil:   normalizeBool(t.show_active_until   != null ? t.show_active_until   : t.showActiveUntil,   true),
      showBankInfo:      normalizeBool(t.show_bank_info      != null ? t.show_bank_info      : t.showBankInfo,      false),
      showSignature:     normalizeBool(t.show_signature      != null ? t.show_signature      : t.showSignature,     true),
      invoiceLabel:           t.invoice_label           || t.invoiceLabel           || 'INVOICE',
      sectionRecipientLabel:  t.section_recipient_label || t.sectionRecipientLabel  || 'TAGIHAN UNTUK',
      sectionDetailLabel:     t.section_detail_label    || t.sectionDetailLabel     || 'DETAIL INVOICE',
      thankYouText:           t.thank_you_text          || t.thankYouText           || 'Terima kasih telah menggunakan layanan kami.',
      footerText:             t.footer_text             || t.footerText             || 'Dokumen ini di-generate otomatis oleh sistem. Invoice ini sah tanpa tanda tangan basah.'
    };
  }

  // Normalize invoice data (handle different backend shapes)
  function normalizeData(d) {
    d = d || {};
    var rawTotal    = Number(d.invoice_total || d.total || 0);
    var rawSubtotal = Number(d.invoice_subtotal != null ? d.invoice_subtotal : (d.invoice_amount || d.amount || 0));
    var rawTax      = Number(d.invoice_tax || d.tax || 0);

    // Auto-derive tax dari total - subtotal kalau perlu
    var subtotal, tax, total;
    if (rawTax > 0 && rawSubtotal > 0) {
      subtotal = rawSubtotal;
      tax      = rawTax;
      total    = rawTotal > 0 ? rawTotal : (subtotal + tax);
    } else if (rawTotal > 0 && rawSubtotal > 0 && rawTotal > rawSubtotal) {
      subtotal = rawSubtotal;
      tax      = rawTotal - rawSubtotal;
      total    = rawTotal;
    } else {
      subtotal = rawSubtotal > 0 ? rawSubtotal : (Number(d.pkg_price) || 0);
      tax      = 0;
      total    = rawTotal > 0 ? rawTotal : subtotal;
    }

    var displayRate = 0;
    if (tax > 0 && subtotal > 0) {
      var calc = (tax / subtotal) * 100;
      displayRate = Number.isInteger(calc) ? calc : Math.round(calc * 10) / 10;
    } else if (Number(d.tax_rate) > 0) {
      displayRate = Number(d.tax_rate);
    }

    var status = (d.invoice_status || 'unpaid').toLowerCase();
    var statusLabel = ({
      paid:    '✓ LUNAS',
      unpaid:  'UNPAID',
      overdue: '⚠ OVERDUE',
      cancelled: 'CANCELLED'
    })[status] || status.toUpperCase();

    return {
      invoice_number: d.invoice_number || ('INV-' + (d.invoice_id || d.id || '')),
      cust_name:    d.cust_name    || '–',
      cid:          d.cid          || '–',
      cust_phone:   d.cust_phone   || '',
      cust_address: d.cust_address || '',
      cust_email:   d.cust_email   || '',
      pkg_name:     d.pkg_name     || '–',
      period_month: d.period_month || 1,
      period_year:  d.period_year  || new Date().getFullYear(),
      due_date:     d.due_date     || null,
      // "Layanan aktif hingga" (Bug 2): backend mengirim active_until terpisah
      // (= due_date periode bila belum lunas, atau +1 bulan bila sudah lunas).
      // Fallback ke due_date untuk kompatibilitas data lama / preview.
      active_until: d.active_until || d.due_date || null,
      payment_date: d.payment_date || null,
      method_label: d.method_label || (status === 'paid' ? 'Cash' : '–'),
      reference_number: d.reference_number || null,
      recorded_by_name: d.recorded_by_name || 'System',
      tax_label: d.tax_label || 'PPN',
      subtotal: subtotal,
      tax:      tax,
      total:    total,
      taxRate:  displayRate,
      status:   status,
      statusLabel: statusLabel,
      bank_accounts: d.bank_accounts || []
    };
  }

  // ── Render functions ─────────────────────────────────────────
  function renderLogo(cfg, onDark) {
    var initial = (cfg.companyName || '?').charAt(0).toUpperCase();
    var bg = onDark ? 'rgba(255,255,255,.18)' : cfg.primary;
    var border = onDark ? '1px solid rgba(255,255,255,.25)' : 'none';
    if (cfg.logoUrl) {
      return '<div style="width:64px;height:64px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:' + (onDark ? 'rgba(255,255,255,.15)' : '#fff') + ';' + (onDark ? '' : 'border:1px solid #e2e8f0;') + 'overflow:hidden;flex-shrink:0;">' +
        '<img src="' + escHtml(cfg.logoUrl) + '" alt="logo" style="width:100%;height:100%;object-fit:contain;border-radius:14px;" onerror="this.style.display=\'none\';this.parentElement.style.background=\'' + bg + '\';this.parentElement.style.color=\'#fff\';this.parentElement.style.fontSize=\'30px\';this.parentElement.style.fontWeight=\'800\';this.parentElement.textContent=\'' + initial + '\';">' +
        '</div>';
    }
    return '<div style="width:64px;height:64px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:' + bg + ';color:#fff;font-size:30px;font-weight:800;flex-shrink:0;border:' + border + ';">' + initial + '</div>';
  }

  function renderHeader(cfg, p) {
    if (cfg.headerStyle === 'minimal') {
      return '' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:30px;padding-bottom:18px;border-bottom:2px solid ' + cfg.primary + ';">' +
          '<div style="display:flex;gap:12px;align-items:center;">' +
            (cfg.showLogo ? renderLogo(cfg, false) : '') +
            '<div>' +
              '<div style="font-size:18px;font-weight:800;color:' + cfg.text + ';">' + escHtml(cfg.companyName) + '</div>' +
              '<div style="font-size:11px;color:#94a3b8;">' + escHtml(cfg.companyTagline) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-size:28px;font-weight:800;letter-spacing:-.01em;color:' + cfg.primary + ';">' + escHtml(cfg.invoiceLabel) + '</div>' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:13px;color:#64748b;margin-top:2px;">' + escHtml(p.invoice_number) + '</div>' +
            '<div style="margin-top:8px;display:inline-block;padding:3px 12px;border-radius:20px;background:' + lighten(cfg.primary, 40) + ';color:' + cfg.primary + ';font-size:10.5px;font-weight:700;letter-spacing:.08em;">' + escHtml(p.statusLabel) + '</div>' +
          '</div>' +
        '</div>';
    }
    if (cfg.headerStyle === 'split') {
      var ci = '';
      if (cfg.companyAddress) ci += '<div>' + escHtml(cfg.companyAddress).replace(/\n/g,'<br>') + '</div>';
      if (cfg.companyPhone)   ci += '<div>📞 ' + escHtml(cfg.companyPhone) + '</div>';
      if (cfg.companyEmail)   ci += '<div>✉️ ' + escHtml(cfg.companyEmail) + '</div>';
      return '' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px;">' +
          (cfg.showLogo ? renderLogo(cfg, false) : '<div></div>') +
          '<div style="text-align:right;font-size:11px;line-height:1.7;color:#64748b;">' +
            '<b style="display:block;color:' + cfg.text + ';font-size:14px;margin-bottom:3px;">' + escHtml(cfg.companyName) + '</b>' +
            ci +
          '</div>' +
        '</div>' +
        // Title row di bawah split header
        '<div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-bottom:8px;">' +
          '<div style="font-size:32px;font-weight:800;letter-spacing:-.02em;color:' + cfg.text + ';">' + escHtml(cfg.invoiceLabel) + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:13px;color:#64748b;">' + escHtml(p.invoice_number) + '</div>' +
        '</div>';
    }
    // Default: banner solid
    return '' +
      '<div style="background:linear-gradient(135deg,' + cfg.primary + ',' + darken(cfg.primary, 15) + ');color:#fff;margin:-50px -60px 30px;padding:36px 60px 30px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;">' +
          '<div style="display:flex;gap:14px;align-items:center;">' +
            (cfg.showLogo ? renderLogo(cfg, true) : '') +
            '<div>' +
              '<div style="font-size:20px;font-weight:800;letter-spacing:-.01em;">' + escHtml(cfg.companyName) + '</div>' +
              '<div style="font-size:11.5px;opacity:.85;margin-top:2px;">' + escHtml(cfg.companyTagline) + '</div>' +
              (cfg.companyPhone ? '<div style="font-size:11px;opacity:.75;margin-top:4px;">' + escHtml(cfg.companyPhone) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-size:10px;font-weight:700;letter-spacing:.15em;opacity:.8;">' + escHtml(cfg.invoiceLabel) + '</div>' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:18px;font-weight:700;margin-top:3px;">' + escHtml(p.invoice_number) + '</div>' +
            '<div style="margin-top:8px;display:inline-block;padding:3px 12px;border-radius:20px;background:rgba(255,255,255,.2);font-size:10px;font-weight:700;letter-spacing:.08em;">' + escHtml(p.statusLabel) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function renderRecipient(cfg, p) {
    var periodeStr = (MONTHS_ID[p.period_month] || p.period_month) + ' ' + p.period_year;
    return '' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;gap:30px;">' +
        '<div style="flex:1;">' +
          '<div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;">' + escHtml(cfg.sectionRecipientLabel) + '</div>' +
          '<div style="font-size:18px;font-weight:700;color:' + cfg.text + ';margin-bottom:3px;">' + escHtml(p.cust_name) + '</div>' +
          '<div style="display:inline-block;background:' + lighten(cfg.primary, 40) + ';color:' + cfg.primary + ';padding:2px 8px;border-radius:4px;font-size:10.5px;font-weight:700;font-family:\'DM Mono\',monospace;margin:4px 0;">' + escHtml(p.cid) + '</div>' +
          (p.cust_phone   ? '<div style="font-size:11px;color:#64748b;margin-top:6px;line-height:1.6;">Kontak: ' + escHtml(p.cust_phone) + '</div>' : '') +
          (p.cust_address ? '<div style="font-size:11px;color:#64748b;line-height:1.6;">Alamat: ' + escHtml(p.cust_address) + '</div>' : '') +
          (p.cust_email   ? '<div style="font-size:11px;color:#64748b;line-height:1.6;">Email: ' + escHtml(p.cust_email) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;flex:1;max-width:50%;">' +
          '<div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;">' + escHtml(cfg.sectionDetailLabel) + '</div>' +
          '<dl style="margin:0;font-size:11px;color:#64748b;line-height:2;">' +
            '<dt style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-top:4px;">No. Invoice</dt>' +
            '<dd style="margin:0;font-weight:700;color:' + cfg.text + ';font-size:12px;font-family:\'DM Mono\',monospace;">' + escHtml(p.invoice_number) + '</dd>' +
            '<dt style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-top:8px;">Tanggal Bayar</dt>' +
            '<dd style="margin:0;font-weight:700;color:' + cfg.text + ';font-size:12px;">' + (p.payment_date ? fmtDate(p.payment_date) : '–') + '</dd>' +
            (cfg.showDueDate && p.due_date ?
              '<dt style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-top:8px;">Jatuh Tempo</dt>' +
              '<dd style="margin:0;font-weight:700;color:' + cfg.text + ';font-size:12px;">' + fmtDate(p.due_date) + '</dd>'
              : '') +
            '<dt style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-top:8px;">Periode</dt>' +
            '<dd style="margin:0;font-weight:700;color:' + cfg.text + ';font-size:12px;">' + escHtml(periodeStr) + '</dd>' +
          '</dl>' +
        '</div>' +
      '</div>';
  }

  function renderItems(cfg, p) {
    var periodeStr = (MONTHS_ID[p.period_month] || p.period_month) + ' ' + p.period_year;
    return '' +
      '<table style="width:100%;border-collapse:collapse;margin-top:30px;font-size:12px;">' +
        '<thead>' +
          '<tr>' +
            '<th style="font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;background:#f8fafc;padding:12px 14px;text-align:left;width:30px;">#</th>' +
            '<th style="font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;background:#f8fafc;padding:12px 14px;text-align:left;">Deskripsi Layanan</th>' +
            '<th style="font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;background:#f8fafc;padding:12px 14px;text-align:center;width:50px;">Qty</th>' +
            '<th style="font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;background:#f8fafc;padding:12px 14px;text-align:right;width:110px;">Harga</th>' +
            '<th style="font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;background:#f8fafc;padding:12px 14px;text-align:right;width:110px;">Jumlah</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' +
          '<tr>' +
            '<td style="padding:14px;border-bottom:1px solid #f1f5f9;color:#94a3b8;font-size:12px;">01</td>' +
            '<td style="padding:14px;border-bottom:1px solid #f1f5f9;font-size:12px;color:' + cfg.text + ';">' +
              '<div style="font-weight:700;">Langganan Internet ' + escHtml(p.pkg_name) + '</div>' +
              '<div style="font-size:10.5px;color:#94a3b8;margin-top:2px;font-weight:400;">Periode: ' + escHtml(periodeStr) + ' · CID: ' + escHtml(p.cid) + '</div>' +
            '</td>' +
            '<td style="padding:14px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-size:12px;">1</td>' +
            '<td style="padding:14px;border-bottom:1px solid #f1f5f9;text-align:right;color:' + cfg.text + ';font-size:12px;">' + fmtRp(p.subtotal) + '</td>' +
            '<td style="padding:14px;border-bottom:1px solid #f1f5f9;text-align:right;color:' + cfg.text + ';font-size:12px;font-weight:700;">' + fmtRp(p.subtotal) + '</td>' +
          '</tr>' +
        '</tbody>' +
      '</table>';
  }

  function renderTotals(cfg, p) {
    var rows = '';
    if (cfg.showSubtotal) {
      rows += '<div style="display:flex;justify-content:space-between;padding:8px 14px;font-size:12px;color:#475569;"><span>Subtotal</span><span>' + fmtRp(p.subtotal) + '</span></div>';
    }
    if (cfg.showTax && p.tax > 0) {
      rows += '<div style="display:flex;justify-content:space-between;padding:8px 14px;font-size:12px;color:#0d9488;"><span>' + escHtml(p.tax_label) + (p.taxRate ? ' (' + p.taxRate + '%)' : '') + '</span><span>' + fmtRp(p.tax) + '</span></div>';
    }
    var badge = statusBadge(p);
    return '' +
      '<div style="margin-top:18px;display:flex;justify-content:flex-end;">' +
        '<div style="min-width:280px;">' +
          rows +
          '<div style="display:flex;justify-content:space-between;margin-top:6px;border-radius:8px;padding:14px;font-weight:800;color:#fff;background:' + cfg.accent + ';">' +
            '<span style="font-size:14px;">Total Tagihan</span>' +
            '<span style="font-size:16px;">' + fmtRp(p.total) + '</span>' +
          '</div>' +
          '<div style="text-align:right;margin-top:10px;">' + badge + '</div>' +
        '</div>' +
      '</div>';
  }

  // ── Badge status PAID / UNPAID / CANCELLED (dipakai beberapa template) ──
  function statusBadge(p) {
    var label, color;
    if (p.status === 'paid')           { label = 'PAID';      color = '#15803d'; }
    else if (p.status === 'cancelled') { label = 'CANCELLED'; color = '#64748b'; }
    else                               { label = 'UNPAID';    color = '#b91c1c'; }
    return '<span style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:.08em;color:' + color + ';border:1.5px solid ' + color + ';border-radius:6px;padding:3px 12px;">' + label + '</span>';
  }

  function renderPaymentStatus(cfg, p) {
    if (!cfg.showPaymentMethod) return '';
    var statusColor = p.status === 'paid' ? '#16a34a' : (p.status === 'overdue' ? '#dc2626' : '#b45309');
    var ref = p.reference_number ? ('<div><span style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;display:block;margin-bottom:4px;">No. Referensi</span><span style="color:' + cfg.text + ';font-weight:700;font-family:\'DM Mono\',monospace;font-size:12px;">' + escHtml(p.reference_number) + '</span></div>') : '';
    return '' +
      '<div style="margin-top:30px;padding:14px 18px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;display:flex;gap:30px;font-size:11px;flex-wrap:wrap;">' +
        '<div><span style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;display:block;margin-bottom:4px;">Metode Pembayaran</span><span style="color:' + cfg.text + ';font-weight:700;">' + escHtml(p.method_label || '–') + '</span></div>' +
        ref +
        '<div><span style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:700;display:block;margin-bottom:4px;">Status</span><span style="color:' + statusColor + ';font-weight:700;text-transform:uppercase;letter-spacing:.04em;">' + escHtml(p.statusLabel) + '</span></div>' +
      '</div>';
  }

  function renderActiveUntil(cfg, p) {
    var activeDate = p.active_until || p.due_date;
    if (!cfg.showActiveUntil || !activeDate) return '';
    return '' +
      '<div style="margin-top:24px;background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;padding:14px 18px;display:flex;gap:12px;align-items:center;font-size:12px;color:#15803d;">' +
        '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' +
        '<div><b style="color:#14532d;">Layanan aktif hingga: ' + fmtDate(activeDate) + '</b><br><span style="font-size:11px;">Perpanjang sebelum tanggal tersebut agar layanan tidak terputus.</span></div>' +
      '</div>';
  }

  function renderBankInfo(cfg, p) {
    if (!cfg.showBankInfo || !p.bank_accounts || !p.bank_accounts.length) return '';
    var rows = p.bank_accounts.map(function (b) {
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;color:#475569;">' +
        '<span><b style="color:' + cfg.text + ';">' + escHtml(b.bank) + '</b> a.n. ' + escHtml(b.name) + '</span>' +
        '<span style="font-family:\'DM Mono\',monospace;color:' + cfg.text + ';font-weight:700;">' + escHtml(b.no) + '</span>' +
        '</div>';
    }).join('');
    return '' +
      '<div style="margin-top:24px;background:#f8fafc;border-radius:12px;padding:14px 18px;">' +
        '<div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;">Transfer ke Rekening Berikut:</div>' +
        rows +
      '</div>';
  }

  function renderFooter(cfg, p) {
    return '' +
      '<div style="margin-top:30px;padding-top:18px;border-top:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:flex-start;gap:30px;">' +
        '<div style="font-size:11px;color:#64748b;line-height:1.7;flex:1;">' +
          (cfg.thankYouText ? '<div style="margin-bottom:8px;color:' + cfg.text + ';font-weight:600;">' + escHtml(cfg.thankYouText) + '</div>' : '') +
          (cfg.footerText ? '<div>' + escHtml(cfg.footerText).replace(/\n/g,'<br>') + '</div>' : '') +
        '</div>' +
        (cfg.showSignature ?
          '<div style="text-align:center;flex-shrink:0;">' +
            '<div style="width:140px;height:80px;border:1.5px dashed #cbd5e1;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">Stempel / TTD</div>' +
            '<div style="font-size:11px;font-weight:600;color:' + cfg.text + ';margin-top:8px;">' + escHtml(cfg.companyName) + '</div>' +
          '</div>'
          : '') +
      '</div>';
  }

  // ── Main render ──────────────────────────────────────────────
  function buildHtml(cfg, p) {
    var fontStack = "'" + cfg.font + "', -apple-system, BlinkMacSystemFont, sans-serif";

    // ── Gaya "clean" (mirip invoice Anthropic/Stripe): dokumen formal,
    //    logo kanan-atas, judul besar, info 2 kolom, "Amount due" menonjol,
    //    tabel garis tipis. Dipilih lewat headerStyle === 'clean'.
    if (cfg.headerStyle === 'clean') return buildCleanHtml(cfg, p, fontStack);

    // ── Gaya "merchant" (mirip invoice Autodesk/Cleverbridge): A4 formal,
    //    logo kiri-atas, alamat penerima, judul tengah bergaris, tabel
    //    produk Local Price/VAT/Price to pay, footer 3-kolom legal.
    if (cfg.headerStyle === 'merchant') return buildMerchantHtml(cfg, p, fontStack);

    var paperStyle =
      'background:#fff;' +
      'padding:50px 60px;' +
      'font-family:' + fontStack + ';' +
      'color:' + cfg.text + ';' +
      'box-sizing:border-box;' +
      'overflow:hidden;';
    return '<div class="invoice-paper" style="' + paperStyle + '">' +
      renderHeader(cfg, p) +
      renderRecipient(cfg, p) +
      renderItems(cfg, p) +
      renderTotals(cfg, p) +
      renderPaymentStatus(cfg, p) +
      renderActiveUntil(cfg, p) +
      renderBankInfo(cfg, p) +
      renderFooter(cfg, p) +
    '</div>';
  }

  // ── Layout "clean" : 100% meniru invoice Anthropic/Stripe ──────
  // Koordinat & ukuran font mengikuti PDF asli (page 612pt, font Inter).
  // Render dalam container 612px (1px=1pt) agar layout identik.
  function buildCleanHtml(cfg, p, fontStack) {
    var dark = '#1a1a1a', muted = '#3c4257', label = '#697386';
    var lineDark = '#1a1a1a', lineGray = '#ebebeb', linkBlue = '#635bff';
    var inter = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function fmtLong(d) {
      if (!d) return '–';
      try {
        var dt = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d);
        var M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return M[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
      } catch (e) { return String(d); }
    }
    var periodLabel = (MONTHS_ID[p.period_month] || p.period_month) + ' ' + p.period_year;
    var paid   = p.status === 'paid';
    var amount = fmtRp(p.total);

    // Logo / inisial kanan-atas (≈40px tinggi)
    var logoBox = '';
    if (cfg.showLogo) {
      if (cfg.logoUrl) {
        var _initial = escHtml((cfg.companyName || '?').charAt(0).toUpperCase());
        logoBox = '<img src="' + escHtml(cfg.logoUrl) + '" alt="logo" style="height:40px;max-width:160px;object-fit:contain;display:block;margin-left:auto;" ' +
          'onerror="this.outerHTML=\'<div style=&quot;font-size:30px;font-weight:800;color:' + dark + ';line-height:1;text-align:right;&quot;>' + _initial.replace(/'/g, "\\'") + '</div>\';">';
      } else {
        // Lambang seperti monogram (mirip A\\ Anthropic) — pakai inisial perusahaan
        logoBox = '<div style="font-size:30px;font-weight:800;color:' + dark + ';line-height:1;text-align:right;">' + escHtml((cfg.companyName || '?').charAt(0).toUpperCase()) + '</div>';
      }
    }

    function meta(lbl, val, bold) {
      return '<tr>' +
        '<td style="padding:0 16px 3px 0;font-size:9pt;color:' + dark + ';font-weight:600;white-space:nowrap;vertical-align:top;">' + lbl + '</td>' +
        '<td style="padding:0 0 3px;font-size:9pt;color:' + dark + ';font-weight:' + (bold ? '600' : '500') + ';">' + val + '</td>' +
      '</tr>';
    }

    function addrBlock(titleHtml, bodyHtml) {
      return '<div style="font-size:9pt;line-height:1.5;color:' + dark + ';">' +
        (titleHtml ? '<div style="font-weight:600;margin-bottom:1px;">' + titleHtml + '</div>' : '') +
        bodyHtml + '</div>';
    }

    var fromBody =
      (cfg.companyAddress ? escHtml(cfg.companyAddress).replace(/\n/g, '<br>') + '<br>' : '') +
      (cfg.companyEmail ? escHtml(cfg.companyEmail) : '');
    var billBody =
      '<div style="font-weight:600;margin-bottom:1px;">' + escHtml(p.cust_name) + '</div>' +
      (p.cid ? '<div>' + escHtml(p.cid) + '</div>' : '') +
      (p.cust_address ? escHtml(p.cust_address).replace(/\n/g, '<br>') + '<br>' : '') +
      (p.cust_phone ? escHtml(p.cust_phone) + '<br>' : '') +
      (p.cust_email ? escHtml(p.cust_email) : '');

    // Baris totals (kolom kanan), garis abu di atas tiap baris seperti asli
    function totRow(lbl, val, bold, topLine) {
      var bw = bold ? '600' : '400';
      var bt = topLine ? 'border-top:0.7pt solid ' + lineGray + ';' : '';
      return '<tr>' +
        '<td style="padding:5px 8px 5px 0;font-size:9pt;color:' + dark + ';font-weight:' + bw + ';' + bt + '">' + lbl + '</td>' +
        '<td style="padding:5px 0;font-size:9pt;color:' + dark + ';font-weight:' + bw + ';text-align:right;white-space:nowrap;' + bt + '">' + val + '</td>' +
      '</tr>';
    }

    var taxRow = (cfg.showTax && p.tax > 0) ? totRow(escHtml(p.tax_label) + ' (' + p.taxRate + '%)', fmtRp(p.tax), false, true) : '';
    var subtotalRow = cfg.showSubtotal ? totRow('Subtotal', fmtRp(p.subtotal), false, true) : '';

    // amount due line (judul besar 13.5pt) — "Rp X due <tgl>" atau lunas
    var dueLine = paid
      ? amount + ' \u2014 <span style="color:#0a7d33;">Lunas</span>'
      : amount + ' due ' + fmtLong(p.due_date);

    // Container 612px, padding 30px (margin asli), font Inter
    var paper =
      'background:#fff;width:612px;max-width:100%;margin:0 auto;padding:30px 30px 0;' +
      'font-family:' + inter + ';color:' + dark + ';box-sizing:border-box;' +
      '-webkit-font-smoothing:antialiased;font-size:9pt;line-height:1.45;position:relative;min-height:760px;';

    return (
      // import font Inter
      '<style>@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;800&display=swap");</style>' +
      '<div class="invoice-paper" style="' + paper + '">' +

        // ── Header: judul "Invoice" (18pt SemiBold) + logo kanan ──
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:22px;">' +
          '<div style="font-size:18pt;font-weight:600;letter-spacing:-.01em;color:' + dark + ';line-height:1;">' + escHtml(cfg.invoiceLabel || 'Invoice') + '</div>' +
          '<div style="min-width:120px;">' + logoBox + '</div>' +
        '</div>' +

        // ── Meta: Invoice number / Date of issue / Date due ──
        '<table style="border-collapse:collapse;margin-bottom:20px;">' +
          meta('Invoice number', '<span style="font-weight:600;">' + escHtml(p.invoice_number) + '</span>', true) +
          meta('Date of issue', fmtLong(p.payment_date || p.due_date)) +
          (cfg.showDueDate ? meta('Date due', fmtLong(p.due_date)) : '') +
        '</table>' +

        // ── Dua kolom: From (kiri) & Bill to (kanan, mulai x≈251) ──
        '<div style="display:flex;gap:0;margin-bottom:26px;">' +
          '<div style="width:221px;">' + addrBlock(escHtml(cfg.companyName), fromBody) + '</div>' +
          '<div style="flex:1;">' + addrBlock('Bill to', billBody) + '</div>' +
        '</div>' +

        // ── Amount due besar (13.5pt SemiBold) ──
        '<div style="font-size:13.5pt;font-weight:600;color:' + dark + ';margin-bottom:14px;letter-spacing:-.01em;">' + dueLine + '</div>' +

        // ── Link "Pay online" biru bergaris bawah (opsional) ──
        (cfg.showPaymentMethod && !paid ?
          '<div style="margin-bottom:22px;"><span style="font-size:9pt;font-weight:600;color:' + linkBlue + ';border-bottom:0.7pt solid ' + linkBlue + ';padding-bottom:1px;">Pay online</span></div>'
          : '<div style="margin-bottom:22px;"></div>') +

        // ── Tabel item ──
        '<table style="width:100%;border-collapse:collapse;">' +
          // header row (7.5pt) dgn garis bawah HITAM
          '<thead><tr style="border-bottom:0.7pt solid ' + lineDark + ';">' +
            '<th style="text-align:left;padding:0 0 6px;font-size:7.5pt;font-weight:400;color:' + dark + ';">Description</th>' +
            '<th style="text-align:right;padding:0 0 6px;font-size:7.5pt;font-weight:400;color:' + dark + ';width:55px;">Qty</th>' +
            '<th style="text-align:right;padding:0 0 6px;font-size:7.5pt;font-weight:400;color:' + dark + ';width:80px;">Unit price</th>' +
            '<th style="text-align:right;padding:0 0 6px;font-size:7.5pt;font-weight:400;color:' + dark + ';width:80px;">Amount</th>' +
          '</tr></thead>' +
          '<tbody><tr>' +
            '<td style="padding:9px 0 0;font-size:9pt;color:' + dark + ';vertical-align:top;">' + escHtml(p.pkg_name) +
              '<div style="font-size:9pt;color:' + dark + ';">' + escHtml(periodLabel) + '</div></td>' +
            '<td style="text-align:right;padding:9px 0 0;font-size:9pt;color:' + dark + ';vertical-align:top;">1</td>' +
            '<td style="text-align:right;padding:9px 0 0;font-size:9pt;color:' + dark + ';vertical-align:top;">' + fmtRp(p.subtotal) + '</td>' +
            '<td style="text-align:right;padding:9px 0 0;font-size:9pt;color:' + dark + ';vertical-align:top;">' + fmtRp(p.subtotal) + '</td>' +
          '</tr></tbody>' +
        '</table>' +

        // ── Totals: kolom kanan (mulai x≈306, lebar ~276px) ──
        '<div style="display:flex;justify-content:flex-end;margin-top:26px;">' +
          '<table style="width:276px;border-collapse:collapse;">' +
            subtotalRow + taxRow +
            totRow('Total', amount, false, true) +
            totRow('Amount due', amount + (cfg.currencyCode ? ' ' + escHtml(cfg.currencyCode) : ''), true, true) +
          '</table>' +
        '</div>' +

        // ── Badge status PAID / UNPAID ──
        '<div style="display:flex;justify-content:flex-end;margin-top:10px;">' + statusBadge(p) + '</div>' +

        // ── Status pembayaran (kalau lunas) ──
        (paid && cfg.showPaymentMethod ?
          '<div style="margin-top:20px;font-size:9pt;color:#0a7d33;">\u2713 Telah dibayar' +
            (p.payment_date ? ' pada ' + fmtLong(p.payment_date) : '') +
            (p.method_label ? ' via ' + escHtml(p.method_label) : '') +
            (p.reference_number ? ' \u00b7 Ref: ' + escHtml(p.reference_number) : '') +
          '</div>' : '') +

        // ── Info bank (opsional) ──
        (cfg.showBankInfo && p.bank_accounts && p.bank_accounts.length ?
          '<div style="margin-top:18px;font-size:9pt;color:' + dark + ';line-height:1.6;">' +
            '<div style="font-weight:600;margin-bottom:3px;">Pembayaran transfer ke:</div>' +
            p.bank_accounts.map(function(b){ return escHtml(b.bank) + ' \u00b7 ' + escHtml(b.no) + ' a.n. ' + escHtml(b.name); }).join('<br>') +
          '</div>' : '') +

        // ── Footer: garis abu penuh + page number (7.5pt) ──
        '<div style="position:absolute;left:30px;right:30px;bottom:24px;border-top:0.7pt solid ' + lineGray + ';padding-top:8px;">' +
          (cfg.footerText ? '<div style="font-size:7.5pt;color:' + label + ';line-height:1.5;margin-bottom:2px;">' + escHtml(cfg.footerText) + '</div>' : '') +
          '<div style="text-align:right;font-size:7.5pt;color:' + dark + ';">Page 1 of 1</div>' +
        '</div>' +

      '</div>'
    );
  }

  // ── Layout "merchant" : 100% meniru invoice Autodesk/Cleverbridge ──
  //    A4 (595pt), font Noto Sans. Logo kiri-atas, alamat penerima,
  //    judul "Invoice" tengah bergaris, tabel produk dgn Local Price/VAT/
  //    Price to pay, blok "Total to pay", footnotes, footer 3-kolom legal.
  function buildMerchantHtml(cfg, p, fontStack) {
    var dark = '#1a1a1a', muted = '#555', line = '#222';
    var noto = "'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function fmtEng(d) {
      if (!d) return '\u2013';
      try {
        var dt = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d);
        var M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return M[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
      } catch (e) { return String(d); }
    }
    var periodLabel = (MONTHS_ID[p.period_month] || p.period_month) + ' ' + p.period_year;
    var paid = p.status === 'paid';
    var total = fmtRp(p.total);
    var subtotal = fmtRp(p.subtotal);
    var taxAmt = fmtRp(p.tax);
    var hasTax = cfg.showTax && p.tax > 0;

    // Logo / nama brand kiri-atas
    var logoBox = '';
    var brandName = escHtml(cfg.companyName || 'INVOICE');
    if (cfg.showLogo && cfg.logoUrl) {
      logoBox = '<img src="' + escHtml(cfg.logoUrl) + '" alt="logo" style="height:30px;max-width:200px;object-fit:contain;" ' +
        'onerror="this.outerHTML=\'<div style=&quot;font-size:17px;font-weight:800;letter-spacing:.06em;color:' + dark + ';text-transform:uppercase;&quot;>' + brandName.replace(/'/g, "\\'") + '</div>\';">';
    } else {
      logoBox = '<div style="font-size:17px;font-weight:800;letter-spacing:.06em;color:' + dark + ';text-transform:uppercase;">' + brandName + '</div>';
    }

    // Alamat penerima (Bill to) — multi-baris
    var billLines = [];
    if (p.cust_name) billLines.push(escHtml(p.cust_name));
    if (p.cid) billLines.push(escHtml(p.cid));
    if (p.cust_address) billLines.push(escHtml(p.cust_address).replace(/\n/g, '<br>'));
    if (p.cust_phone) billLines.push(escHtml(p.cust_phone));
    if (p.cust_email) billLines.push(escHtml(p.cust_email));
    var billBlock = billLines.join('<br>');

    var paper =
      'background:#fff;width:595px;max-width:100%;margin:0 auto;padding:42px 40px 0;' +
      'font-family:' + noto + ';color:' + dark + ';box-sizing:border-box;' +
      '-webkit-font-smoothing:antialiased;font-size:9pt;line-height:1.45;position:relative;';

    return (
      '<style>@import url("https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,400;0,700;1,400&display=swap");</style>' +
      '<div class="invoice-paper" style="' + paper + '">' +

        // ── Logo brand kiri-atas ──
        '<div style="margin-bottom:60px;">' + logoBox + '</div>' +

        // ── Alamat penerima ──
        '<div style="font-size:9pt;line-height:1.5;color:' + dark + ';margin-bottom:34px;">' + billBlock + '</div>' +

        // ── Judul "Invoice" tengah + garis ──
        '<div style="text-align:center;font-size:18pt;font-weight:700;color:' + dark + ';margin-bottom:10px;">' + escHtml(cfg.invoiceLabel || 'Invoice') + '</div>' +
        '<div style="border-top:1px solid ' + line + ';margin-bottom:14px;"></div>' +

        // ── Invoice date / number (rata kanan) ──
        '<table style="margin-left:auto;border-collapse:collapse;margin-bottom:20px;">' +
          '<tr><td style="font-size:9pt;font-weight:700;padding:1px 30px 1px 0;color:' + dark + ';">Invoice date:</td>' +
            '<td style="font-size:9pt;text-align:right;color:' + dark + ';">' + fmtEng(p.payment_date || p.due_date) + '</td></tr>' +
          '<tr><td style="font-size:9pt;font-weight:700;padding:1px 30px 1px 0;color:' + dark + ';">Invoice number:</td>' +
            '<td style="font-size:9pt;text-align:right;color:' + dark + ';">' + escHtml(p.invoice_number) + '</td></tr>' +
        '</table>' +

        // ── "Invoice information" + garis ──
        '<div style="font-size:12pt;font-weight:700;color:' + dark + ';margin-bottom:6px;">Invoice information</div>' +
        '<div style="border-top:1px solid ' + line + ';margin-bottom:10px;"></div>' +

        // ── Tabel produk ──
        '<table style="width:100%;border-collapse:collapse;">' +
          '<thead><tr>' +
            '<th style="text-align:left;font-size:9pt;font-weight:700;padding:0 0 8px;width:18px;">#</th>' +
            '<th style="text-align:left;font-size:9pt;font-weight:700;padding:0 0 8px;">Product name</th>' +
            '<th style="text-align:right;font-size:9pt;font-weight:700;padding:0 10px 8px;">Qty.</th>' +
            '<th style="text-align:right;font-size:9pt;font-style:italic;font-weight:400;padding:0 10px 8px;">Local Price</th>' +
            '<th style="text-align:right;font-size:9pt;font-weight:700;padding:0 10px 8px;">VAT</th>' +
            '<th style="text-align:right;font-size:9pt;font-weight:700;padding:0 0 8px;">Price to pay</th>' +
          '</tr></thead>' +
          '<tbody><tr>' +
            '<td style="vertical-align:top;font-size:9pt;padding:4px 0;">1</td>' +
            '<td style="vertical-align:top;padding:4px 0;">' +
              '<div style="font-size:12pt;color:' + dark + ';">' + escHtml(p.pkg_name) + '</div>' +
              '<div style="font-size:8pt;font-style:italic;color:' + dark + ';margin-top:3px;">' + escHtml(periodLabel) + '</div>' +
              (p.active_until ? '<div style="font-size:8pt;color:' + dark + ';"><b>Aktif s/d:</b> ' + fmtEng(p.active_until) + '</div>' : '') +
            '</td>' +
            '<td style="text-align:right;vertical-align:top;font-size:9pt;padding:4px 10px;">1</td>' +
            '<td style="text-align:right;vertical-align:top;font-size:9pt;font-style:italic;padding:4px 10px;white-space:nowrap;">' + subtotal + '</td>' +
            '<td style="text-align:right;vertical-align:top;font-size:9pt;padding:4px 10px;">' + (hasTax ? p.taxRate + '%' : '\u2013') + '</td>' +
            '<td style="text-align:right;vertical-align:top;font-size:9pt;font-weight:700;padding:4px 0;white-space:nowrap;">' + total + '</td>' +
          '</tr></tbody>' +
        '</table>' +

        // ── Subtotal / VAT / Total (rata kanan) ──
        '<table style="margin-left:auto;border-collapse:collapse;margin-top:18px;">' +
          (cfg.showSubtotal ? '<tr><td style="text-align:right;padding:2px 14px 2px 0;font-size:9pt;font-weight:700;">Subtotal:</td><td style="font-size:9pt;font-style:italic;text-align:right;white-space:nowrap;">' + subtotal + '</td></tr>' : '') +
          (hasTax ? '<tr><td style="text-align:right;padding:2px 14px 2px 0;font-size:9pt;font-weight:700;">VAT (' + p.taxRate + '%):</td><td style="font-size:9pt;font-style:italic;text-align:right;white-space:nowrap;">' + taxAmt + '</td></tr>' : '') +
          '<tr><td style="text-align:right;padding:2px 14px 2px 0;font-size:9pt;font-weight:700;">Total:</td><td style="font-size:9pt;font-style:italic;text-align:right;font-weight:700;white-space:nowrap;">' + total + '</td></tr>' +
        '</table>' +

        // ── Garis pemisah ──
        '<div style="border-top:1px solid ' + line + ';margin:16px 0 12px;"></div>' +

        // ── Total to pay (menonjol, kanan) + badge status ──
        '<div style="text-align:right;margin-bottom:8px;">' +
          '<div style="font-size:9pt;font-weight:700;color:' + dark + ';">Total to pay:</div>' +
          '<div style="font-size:14pt;font-weight:700;color:' + dark + ';">' + total + '</div>' +
          '<div style="margin-top:8px;">' +
            (paid
              ? '<span style="display:inline-block;font-size:10pt;font-weight:800;letter-spacing:.08em;color:#15803d;border:1.5px solid #15803d;border-radius:6px;padding:3px 12px;">PAID</span>'
              : '<span style="display:inline-block;font-size:10pt;font-weight:800;letter-spacing:.08em;color:' + (p.status === 'cancelled' ? '#64748b' : '#b91c1c') + ';border:1.5px solid ' + (p.status === 'cancelled' ? '#64748b' : '#b91c1c') + ';border-radius:6px;padding:3px 12px;">' + (p.status === 'cancelled' ? 'CANCELLED' : 'UNPAID') + '</span>') +
          '</div>' +
        '</div>' +

        // ── Status / payment details ──
        '<div style="font-size:12pt;font-weight:700;color:' + dark + ';margin:24px 0 6px;">Payment details</div>' +
        '<div style="border-top:1px solid ' + line + ';margin-bottom:12px;"></div>' +
        '<div style="font-size:9pt;color:' + dark + ';line-height:1.5;">' +
          (paid
            ? 'Pembayaran sebesar <b>' + total + '</b> telah diterima' + (p.payment_date ? ' pada ' + fmtEng(p.payment_date) : '') + (p.method_label ? ' via <b>' + escHtml(p.method_label) + '</b>' : '') + '.' + (p.reference_number ? ' Ref: ' + escHtml(p.reference_number) + '.' : '')
            : 'Tagihan ini jatuh tempo pada <b>' + fmtEng(p.due_date) + '</b>. Mohon lakukan pembayaran sebesar <b>' + total + '</b> sebelum tanggal tersebut.') +
        '</div>' +

        // ── Info bank (opsional) ──
        (cfg.showBankInfo && p.bank_accounts && p.bank_accounts.length ?
          '<div style="font-size:8.5pt;color:' + dark + ';line-height:1.6;margin-top:14px;">' +
            '<b>Pembayaran transfer ke:</b><br>' +
            p.bank_accounts.map(function(b){ return escHtml(b.bank) + ' \u00b7 ' + escHtml(b.no) + ' a.n. ' + escHtml(b.name); }).join('<br>') +
          '</div>' : '') +

        // ── Footer legal (garis + nama perusahaan) ──
        '<div style="margin-top:48px;border-top:1px solid ' + line + ';padding-top:8px;font-size:7pt;color:' + muted + ';line-height:1.5;">' +
          '<b>' + escHtml(cfg.companyName) + '</b>' +
          (cfg.companyAddress ? ' \u00b7 ' + escHtml(cfg.companyAddress).replace(/\n/g, ', ') : '') +
          (cfg.companyPhone ? ' \u00b7 ' + escHtml(cfg.companyPhone) : '') +
          (cfg.companyEmail ? ' \u00b7 ' + escHtml(cfg.companyEmail) : '') +
          (cfg.footerText ? '<br>' + escHtml(cfg.footerText) : '') +
          '<div style="text-align:center;margin-top:6px;">1 / 1</div>' +
        '</div>' +
        '<div style="height:24px;"></div>' +

      '</div>'
    );
  }

  function render(targetEl, invoiceData, templateConfig) {
    var cfg = normalizeConfig(templateConfig);
    var p   = normalizeData(invoiceData);
    if (typeof targetEl === 'string') targetEl = document.querySelector(targetEl);
    if (!targetEl) return;
    targetEl.innerHTML = buildHtml(cfg, p);
  }

  // Public API
  global.InvoiceRenderer = {
    render: render,
    normalizeConfig: normalizeConfig,
    normalizeData: normalizeData,
    buildHtml: function (data, tpl) {
      return buildHtml(normalizeConfig(tpl), normalizeData(data));
    },
    // Sample data buat designer preview
    sampleData: function () {
      return {
        invoice_number: 'INV-2605-00007',
        cust_name: 'Budi Santoso',
        cid: 'CID007',
        cust_address: 'Jl. Merdeka No. 45, Bandung, Jawa Barat',
        cust_phone: '+62 812-3456-7890',
        cust_email: 'budi@email.com',
        pkg_name: '20 Mbps Home',
        invoice_subtotal: 250000,
        invoice_tax: 27500,
        invoice_total: 277500,
        tax_label: 'PPN',
        tax_rate: 11,
        due_date: '2026-06-01',
        active_until: '2026-06-01',
        period_month: 5,
        period_year: 2026,
        invoice_status: 'unpaid',
        method_label: 'Belum dibayar',
        bank_accounts: [
          { bank: 'BCA',     no: '1234567890', name: 'PT Internet Service' },
          { bank: 'Mandiri', no: '9876543210', name: 'PT Internet Service' }
        ]
      };
    }
  };
})(window);
