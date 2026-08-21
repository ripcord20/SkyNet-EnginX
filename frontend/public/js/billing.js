// FLAYNET.Com billing.js — Billing & Invoice Management

let _billPage = 1;
const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  // Auto-mark overdue setiap kali halaman dibuka
  App.api('/billing/mark-overdue', { method: 'POST' }).catch(function(){});

  // Isi dropdown tahun: tahun ini + 4 tahun ke belakang
  const yearSel = document.getElementById('invoiceYear');
  if (yearSel) {
    const cy = new Date().getFullYear();
    for (let y = cy + 1; y >= cy - 4; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y; yearSel.appendChild(o);
    }
  }

  initStatPeriodSelector();
  loadBillStats();
  loadInvoices();
  refreshProofBadge();

  const s = document.getElementById('searchInvoice');
  const f = document.getElementById('invoiceStatus');
  const m = document.getElementById('invoiceMonth');
  const yr = document.getElementById('invoiceYear');
  if (s) s.addEventListener('input', _debounce(() => { _billPage = 1; loadInvoices(); }, 350));
  if (f) f.addEventListener('change', () => { _billPage = 1; loadInvoices(); });
  if (m) m.addEventListener('change', () => { _billPage = 1; _syncStatFromTable(); loadInvoices(); });
  if (yr) yr.addEventListener('change', () => { _billPage = 1; _syncStatFromTable(); loadInvoices(); });
});

// ── STATS ─────────────────────────────────────────────────────
async function loadBillStats() {
  // Ambil periode dari selector (kalau ada). Default: kosong → backend pakai bulan ini.
  const mSel = document.getElementById('statMonth');
  const ySel = document.getElementById('statYear');
  let qs = '';
  if (mSel && ySel && mSel.value && ySel.value) {
    qs = '?month=' + encodeURIComponent(mSel.value) + '&year=' + encodeURIComponent(ySel.value);
  }
  const d = await App.api('/billing/stats' + qs);
  if (!d?.success) return;
  const s = d.data;

  const paid    = s.paidThisMonth  || 0;
  const unpaid  = s.unpaid         || 0;
  const overdue = s.overdue        || 0;
  const revenue = s.revenueThisMonth || 0;
  const total   = paid + unpaid + overdue || 1;

  _setText('fcPaid',     paid);
  _setText('fcUnpaid',   unpaid);
  _setText('fcOverdue',  overdue);
  _setText('fcRevenueVal', revenue >= 1000000
    ? 'Rp ' + (revenue/1000000).toFixed(1).replace('.0','') + 'jt'
    : 'Rp ' + Math.round(revenue/1000) + 'rb');
  _setText('fcRevenueSub', paid + ' invoice lunas');
  _setText('fcRevenueAmt', 'Rp ' + Number(revenue).toLocaleString('id-ID'));

  _setBar('fcPaidBar',    paid    / total);
  _setBar('fcUnpaidBar',  unpaid  / total);
  _setBar('fcOverdueBar', overdue / total);

  const fmtRpShort = (n) => n >= 1000000
    ? 'Rp ' + (n/1000000).toFixed(1).replace('.0','') + 'jt'
    : (n >= 1000 ? 'Rp ' + Math.round(n/1000) + 'rb' : 'Rp ' + Number(n).toLocaleString('id-ID'));

  // ── Total Potensi Penerimaan (TOTAL nilai invoice periode, TIDAK dikurang paid) ──
  const totalVal = s.totalInvoiceValue || 0;
  const totalCnt = s.totalInvoiceCount || 0;
  const potCust  = s.potensiCustomerCount || 0;
  _setText('fcPotensiVal', fmtRpShort(totalVal));
  _setText('fcPotensiSub', totalCnt + ' invoice · ' + potCust + ' plgn');
  const potPill = document.getElementById('cp-potensi');
  if (potPill) potPill.textContent = fmtRpShort(totalVal);

  // ── Sisa Tertagih (nilai invoice belum lunas periode) ──
  const sisaVal = s.outstandingInvoiceValue || 0;
  const sisaCnt = s.outstandingInvoiceCount || 0;
  _setText('fcSisaVal', fmtRpShort(sisaVal));
  _setText('fcSisaSub', sisaCnt + ' invoice belum lunas');
  const sisaPill = document.getElementById('cp-sisa');
  if (sisaPill) {
    const pctSisa = totalVal > 0 ? Math.round(sisaVal / totalVal * 100) : 0;
    sisaPill.textContent = pctSisa + '% belum';
  }

  // Update label kartu sesuai periode terpilih
  const periodLabel = (mSel && ySel && mSel.value && ySel.value)
    ? (MONTHS[parseInt(mSel.value)] + ' ' + ySel.value)
    : 'Bulan Ini';
  const potLbl = document.querySelector('#bcard-potensi .card-lbl');
  if (potLbl) potLbl.textContent = 'Total Potensi Penerimaan · ' + periodLabel;
  const sisaLbl = document.querySelector('#bcard-sisa .card-lbl');
  if (sisaLbl) sisaLbl.textContent = 'Sisa Tertagih · ' + periodLabel;

  const now = new Date();
  _setText('billHeaderSub',
    `${paid + unpaid + overdue} invoice · ${overdue} overdue · ${periodLabel}`
  );
}

// Isi dropdown tahun (5 tahun ke belakang s/d tahun depan) & set default bulan ini.
function initStatPeriodSelector() {
  const mSel = document.getElementById('statMonth');
  const ySel = document.getElementById('statYear');
  if (!mSel || !ySel) return;
  const now = new Date();
  const yr = now.getFullYear();
  if (!ySel.options.length) {
    for (let y = yr + 1; y >= yr - 4; y--) {
      const o = document.createElement('option'); o.value = y; o.textContent = y; ySel.appendChild(o);
    }
  }
  mSel.value = String(now.getMonth() + 1);
  ySel.value = String(yr);
}

function onStatPeriodChange() {
  // Sinkronkan filter tabel dgn selector statistik supaya kartu & daftar invoice
  // menampilkan periode yang sama, lalu muat ulang keduanya.
  const mSel = document.getElementById('statMonth');
  const ySel = document.getElementById('statYear');
  const tblM = document.getElementById('invoiceMonth');
  const tblY = document.getElementById('invoiceYear');
  if (mSel && tblM) tblM.value = mSel.value;
  if (ySel && tblY) tblY.value = ySel.value;
  _billPage = 1;
  loadBillStats();
  loadInvoices();
}
function resetStatPeriod() {
  initStatPeriodSelector();
  onStatPeriodChange();
}

// Sinkronkan selector statistik dari filter tabel. Kalau tabel "Semua Bulan/Tahun"
// (nilai kosong), statistik jatuh ke bulan berjalan.
function _syncStatFromTable() {
  const mSel = document.getElementById('statMonth');
  const ySel = document.getElementById('statYear');
  const tblM = document.getElementById('invoiceMonth');
  const tblY = document.getElementById('invoiceYear');
  if (!mSel || !ySel) return;
  const now = new Date();
  if (tblM && tblM.value) mSel.value = tblM.value; else mSel.value = String(now.getMonth() + 1);
  if (tblY && tblY.value) ySel.value = tblY.value; else ySel.value = String(now.getFullYear());
  loadBillStats();
}

// ── INVOICES ──────────────────────────────────────────────────
async function loadInvoices() {
  const status = document.getElementById('invoiceStatus')?.value || '';
  const search = document.getElementById('searchInvoice')?.value || '';
  const month  = document.getElementById('invoiceMonth')?.value || '';
  const year   = document.getElementById('invoiceYear')?.value || '';
  const data   = await App.api(
    `/billing/invoices?page=${_billPage}&limit=20&status=${status}&search=${encodeURIComponent(search)}` +
    (month ? `&month=${month}` : '') + (year ? `&year=${year}` : '')
  );
  const tbody   = document.getElementById('invoiceTable');
  const countEl = document.getElementById('billCount');
  const subEl   = document.getElementById('billSub');

  if (!data?.success) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><p style="color:#dc2626;">Gagal memuat data</p></div></td></tr>';
    return;
  }

  const total = data.pagination?.total || 0;
  if (countEl) countEl.textContent = total + ' invoice';
  if (subEl)   subEl.textContent   = total + ' invoice ditemukan';

  if (!data.data?.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg><p>Tidak ada invoice ditemukan</p></div></td></tr>';
    _renderPagination(0);
    if (typeof _syncBulkBar === 'function') _syncBulkBar();
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);

  tbody.innerHTML = data.data.map(i => {
    const isPaid    = i.status === 'paid';
    const today2    = new Date(); today2.setHours(0,0,0,0);
    const dueObj    = i.due_date ? new Date(i.due_date + 'T00:00:00') : null;
    // Overdue = unpaid/overdue di DB ATAU unpaid dengan due_date sudah lewat
    const isOverdue = i.status === 'overdue' || (i.status === 'unpaid' && dueObj && dueObj < today2);
    const isUnpaid  = i.status === 'unpaid' && (!dueObj || dueObj >= today2);

    // Status badge
    const stBadge = isPaid
      ? '<span class="st-paid"><span style="width:5px;height:5px;border-radius:50%;background:#16a34a;"></span>Lunas</span>'
      : isOverdue
      ? '<span class="st-overdue"><span style="width:5px;height:5px;border-radius:50%;background:#dc2626;"></span>Overdue</span>'
      : isUnpaid
      ? '<span class="st-unpaid"><span style="width:5px;height:5px;border-radius:50%;background:#d97706;"></span>Unpaid</span>'
      : '<span class="st-cancelled">Cancelled</span>';

    // Due date color
    let dueTxt = _fmtDate(i.due_date);
    if (!isPaid && i.due_date) {
      const due = new Date(i.due_date + 'T00:00:00');
      const diff = Math.round((due - today) / 86400000);
      if (diff < 0) dueTxt = '<span style="color:#dc2626;font-weight:700;">' + _fmtDate(i.due_date) + '</span><div style="font-size:10px;color:#dc2626;">' + Math.abs(diff) + ' hari lalu</div>';
      else if (diff <= 3) dueTxt = '<span style="color:#d97706;font-weight:600;">' + _fmtDate(i.due_date) + '</span><div style="font-size:10px;color:#d97706;">' + diff + ' hari lagi</div>';
    }

    // Amount
    const fmtAmt = 'Rp ' + Number(i.total).toLocaleString('id-ID');
    const taxAmt = Number(i.tax || 0);
    const subAmt = Number(i.amount || 0);
    // Hitung rate aktual dari data invoice (lebih akurat per-invoice daripada
    // rate global, kalau-kalau ada invoice dengan rate berbeda)
    let taxRatePct = 0;
    if (taxAmt > 0 && subAmt > 0) {
      const calc = (taxAmt / subAmt) * 100;
      taxRatePct = Number.isInteger(calc) ? calc : Math.round(calc * 10) / 10;
    }
    const taxBadge = taxAmt > 0
      ? '<div style="margin-top:6px;font-size:10.5px;color:#0d9488;font-weight:600;display:inline-flex;align-items:center;gap:6px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:5px;padding:2px 7px;font-family:\'Plus Jakarta Sans\',-apple-system,sans-serif;letter-spacing:.01em;">'
        + (taxRatePct > 0
          ? '<span style="background:#0d9488;color:#fff;padding:1px 5px;border-radius:3px;font-size:9.5px;font-weight:700;letter-spacing:.02em;">' + taxRatePct + '%</span>'
          : '')
        + 'Incl. PPN&nbsp;Rp&nbsp;' + Number(taxAmt).toLocaleString('id-ID')
        + '</div>'
      : '';

    // Action buttons — Invoice (cetak) + Kirim WA reminder (jika overdue/unpaid) + Pay (jika belum bayar)
    const invBtn = `<button class="act-btn act-inv" onclick="openInvoiceByInvId(${i.id})">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>Invoice
    </button>`;

    const waBtn = (isOverdue || isUnpaid) ? `<button class="act-btn act-wa" onclick="sendReminder(${i.id},'${_esc(i.customer?.name||'')}')">
      <svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>Kirim
    </button>` : '';

    // Tombol Kirim Email (aktif kalau pelanggan punya email)
    const custEmail = (i.customer && i.customer.email) ? i.customer.email : '';
    const emailBtn = custEmail
      ? `<button class="act-btn act-email" onclick="sendEmailInvoice(${i.id},'${_esc(i.customer?.name||'')}')" title="Kirim invoice ke ${_esc(custEmail)}">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>Email
        </button>`
      : `<button class="act-btn" disabled title="Pelanggan belum punya email" style="opacity:.45;cursor:not-allowed;">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>Email
        </button>`;
    const delBtn = `<button class="act-btn act-del" onclick="deleteInvoice(${i.id},'${_esc(i.invoice_number||'')}','${_esc(i.customer?.name||'')}')" title="Hapus invoice" style="color:#dc2626;border-color:#fecaca;">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
    </button>`;

    // Data pembayaran terakhir
    var lastPay   = (i.payments && i.payments.length) ? i.payments[0] : null;
    var payDate   = lastPay ? _fmtDate(lastPay.payment_date) : null;
    var payMethod = lastPay ? lastPay.payment_method : null;

    // Status + tanggal bayar (di bawah badge)
    var stCell = stBadge;
    if (isPaid && payDate) {
      stCell += '<div style="font-size:11px;color:#16a34a;margin-top:3px;">✓ ' + payDate + '</div>';
    } else if (isOverdue) {
      stCell += '<div style="font-size:10px;color:#dc2626;margin-top:2px;">Segera bayar</div>';
    }

    return '<tr>' +
      '<td style="text-align:center;"><input type="checkbox" class="inv-check" value="' + i.id + '" onchange="onInvCheck()" style="cursor:pointer;width:15px;height:15px;"></td>' +
      '<td><span style="font-family:monospace;font-size:12px;font-weight:700;color:#0d1b3e;">' + _esc(i.invoice_number) + '</span></td>' +
      '<td>' +
        '<div style="font-weight:600;color:#0d1b3e;">' + _esc(i.customer?.name || '–') + '</div>' +
        '<div style="font-size:11px;color:#94a3b8;font-family:monospace;">' + _esc(i.customer?.customer_id || '') + '</div>' +
      '</td>' +
      '<td style="font-weight:700;color:#1a6ef5;font-size:14px;font-family:monospace;"><div style="display:flex;flex-direction:column;align-items:flex-start;gap:0;">' + '<span>' + fmtAmt + '</span>' + taxBadge + '</div></td>' +
      '<td><div style="line-height:1.4;">' + dueTxt + '</div></td>' +
      '<td class="col-hide-sm" style="font-size:12px;color:#6b7fa8;">' + (i.period_month||'–') + '/' + (i.period_year||'–') + '</td>' +
      '<td>' + stCell + '</td>' +
      '<td class="col-hide-sm">' + _pmBadge(lastPay) + '</td>' +
      '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' + invBtn + waBtn + emailBtn + delBtn + '</div></td>' +
    '</tr>';
  }).join('');

  _renderPagination(total);
  _syncBulkBar();
}

// ── INVOICE CETAK — buka langsung dari invoice id (unpaid/paid) ─
window.openInvoiceByInvId = function(invoiceId) {
  // Langsung buka halaman invoice by invoice ID — tidak perlu cek payment dulu
  window.open('/invoice/inv/' + invoiceId, '_blank');
};

// ── SEND EMAIL (per-invoice) ──────────────────────────────────
window.sendEmailInvoice = async function(invoiceId, custName) {
  showBillConfirm(
    'Kirim Email',
    'Kirim invoice/kwitansi ke email <strong>' + custName + '</strong>?<br><span style="font-size:12px;color:#64748b;">Lampiran PDF mengikuti setting di Settings &gt; Email.</span>',
    '#1d4ed8',
    async function() {
      const d = await App.api('/billing/invoices/' + invoiceId + '/send-email', { method:'POST', body:'{}' });
      if (d && d.success) App.showToast(d.message, 'success');
      else App.showToast((d && d.message) || 'Gagal kirim email', 'error');
    }
  );
};

// ── SEND EMAIL (bulk) ─────────────────────────────────────────
window.bulkSendEmail = async function() {
  const ids = _selectedInvoiceIds();
  if (!ids.length) { App.showToast('Pilih minimal satu invoice', 'error'); return; }
  showBillConfirm(
    'Kirim Email Terpilih',
    'Kirim email ke <strong>' + ids.length + '</strong> invoice terpilih?<br><span style="font-size:12px;color:#64748b;">Invoice tanpa email pelanggan otomatis dilewati.</span>',
    '#1d4ed8',
    async function() {
      App.showToast('Mengirim email…', 'info');
      const d = await App.api('/billing/invoices/send-email-bulk', { method:'POST', body: JSON.stringify({ invoice_ids: ids }) });
      if (d && d.success) { App.showToast(d.message, 'success'); clearInvoiceSelection(); }
      else App.showToast((d && d.message) || 'Gagal kirim email', 'error');
    }
  );
};

// ── SEND REMINDER ─────────────────────────────────────────────
window.sendReminder = async function(invoiceId, custName) {
  showBillConfirm(
    'Kirim Reminder',
    'Kirim reminder tagihan ke <strong>' + custName + '</strong> via WhatsApp?',
    '#16a34a',
    async function() {
      const d = await App.api('/billing/invoices/' + invoiceId + '/reminder', { method:'POST', body:'{}' });
      if (d && d.success) App.showToast(d.message, 'success');
      else App.showToast((d && d.message) || 'Gagal kirim reminder', 'error');
    }
  );
};

// ── GENERATE ──────────────────────────────────────────────────
window.openGenerate = function() {
  const now = new Date();
  document.getElementById('genMonth').value = now.getMonth() + 1;
  document.getElementById('genYear').value  = now.getFullYear();
  // Reset cakupan ke 'semua' + bersihkan pilihan pelanggan.
  _genSelectedCust = {};
  const allRadio = document.querySelector('input[name="genScope"][value="all"]');
  if (allRadio) allRadio.checked = true;
  const searchEl = document.getElementById('genCustSearch');
  if (searchEl) searchEl.value = '';
  const resBox = document.getElementById('genCustResults');
  if (resBox) { resBox.style.display = 'none'; resBox.innerHTML = ''; }
  _genRenderChips();
  onGenScopeChange();
  document.getElementById('generateModal').classList.add('active');
  // Load preview customer info
  loadGeneratePreview();
  // Refresh preview kalau user ubah bulan/tahun
  const monthEl = document.getElementById('genMonth');
  const yearEl  = document.getElementById('genYear');
  if (monthEl && !monthEl._previewBound) { monthEl.addEventListener('change', loadGeneratePreview); monthEl._previewBound = true; }
  if (yearEl  && !yearEl._previewBound)  { yearEl.addEventListener('change',  loadGeneratePreview);  yearEl._previewBound  = true; }
};

async function loadGeneratePreview() {
  const loadingEl = document.getElementById('genPreviewLoading');
  const contentEl = document.getElementById('genPreviewContent');
  const warnEl    = document.getElementById('gpWarn');
  if (!loadingEl || !contentEl) return;

  loadingEl.style.display = 'inline';
  loadingEl.textContent = 'Memeriksa customer…';
  contentEl.style.display = 'none';

  const month = document.getElementById('genMonth')?.value;
  const year  = document.getElementById('genYear')?.value;
  let url = '/billing/generate/preview';
  if (month && year) url += '?month=' + month + '&year=' + year;

  try {
    const d = await App.api(url);
    if (!d?.success) {
      loadingEl.textContent = d?.message || 'Gagal load preview';
      return;
    }
    const data = d.data || {};
    // Field utama dari backend: eligible_customers (active+isolated+suspended).
    // Fallback ke active_customers untuk backward-compat kalau backend lama.
    const eligibleCount  = data.eligible_customers ?? data.active_customers ?? 0;
    const eligibleWithPk = data.eligible_with_package ?? data.active_with_package ?? 0;
    const eligibleNoPk   = data.eligible_without_package ?? data.active_without_package ?? 0;
    const bs = data.by_status || {};

    document.getElementById('gpActiveCount').textContent =
      eligibleCount + ' / ' + (data.total_customers || 0);
    document.getElementById('gpWithPackage').textContent =
      eligibleWithPk + ' / ' + eligibleCount;

    // Bangun warning + breakdown info
    const warnings = [];

    // Breakdown per-status — hanya tampilkan kalau ada data by_status
    if (bs.active != null || bs.isolated != null || bs.suspended != null || bs.inactive != null) {
      const parts = [];
      if (bs.active    != null) parts.push(`<span style="color:#16a34a">active: <b>${bs.active}</b></span>`);
      if (bs.isolated  != null) parts.push(`<span style="color:#dc2626">isolated: <b>${bs.isolated}</b></span>`);
      if (bs.suspended != null) parts.push(`<span style="color:#d97706">suspended: <b>${bs.suspended}</b></span>`);
      if (bs.inactive  != null) parts.push(`<span style="color:#94a3b8">inactive: <b>${bs.inactive}</b> (di-skip)</span>`);
      warnings.push('Breakdown: ' + parts.join(' · '));
    }

    if (data.total_customers === 0) {
      warnings.push('⚠ Belum ada customer di database — tambah customer dulu.');
    } else if (eligibleCount === 0) {
      warnings.push('⚠ Tidak ada customer eligible (active/isolated/suspended) — generate akan 0 invoice.');
    } else if (eligibleWithPk === 0) {
      warnings.push('⚠ Customer eligible belum dipasangkan ke paket apapun.');
    } else if (eligibleNoPk > 0) {
      warnings.push(`${eligibleNoPk} customer eligible belum punya paket — akan dilewati.`);
    }
    if (data.existing_in_period > 0) {
      warnings.push(`${data.existing_in_period} invoice sudah ada di periode ini — akan dilewati.`);
    }
    warnings.push(`<b>Estimasi invoice yang akan dibuat: ${data.estimated_to_generate || 0}</b>`);

    warnEl.innerHTML = warnings.join('<br>');
    warnEl.style.display = 'block';

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Disable tombol Generate kalau estimasi 0 (tapi tetap bisa diklik manual)
    const btn = document.getElementById('confirmGenerateBtn');
    if (btn) {
      if ((data.estimated_to_generate || 0) === 0) {
        btn.style.opacity = '.6';
        btn.title = 'Tidak ada invoice yang akan dibuat';
      } else {
        btn.style.opacity = '1';
        btn.title = '';
      }
    }
  } catch (err) {
    loadingEl.textContent = 'Error: ' + (err?.message || 'network error');
  }
}

window.closeGenerateModal = function() {
  document.getElementById('generateModal').classList.remove('active');
};

window.confirmGenerate = async function() {
  const btn = document.getElementById('confirmGenerateBtn');
  const month = parseInt(document.getElementById('genMonth').value);
  const year  = parseInt(document.getElementById('genYear').value);

  // Cakupan: 'all' (semua) atau 'selected' (pelanggan tertentu).
  const scope = (document.querySelector('input[name="genScope"]:checked') || {}).value || 'all';
  const payload = { month, year };
  if (scope === 'selected') {
    const ids = Object.keys(_genSelectedCust || {}).map(Number).filter(Boolean);
    if (!ids.length) {
      App.showToast('Pilih minimal satu pelanggan dulu.', 'error');
      return;
    }
    payload.customer_ids = ids;
  }

  btn.disabled = true; btn.textContent = 'Generating...';
  const d = await App.api('/billing/generate', { method:'POST', body: JSON.stringify(payload) });
  if (d?.success) {
    closeGenerateModal();
    loadInvoices();
    loadBillStats();
    // Pilih toast type berdasarkan hasil:
    //   created > 0 → success (hijau)
    //   created = 0 → info (biru) — bukan error karena tidak ada exception
    const created = d.data?.created || 0;
    const toastType = created > 0 ? 'success' : 'info';
    App.showToast(d.message || 'Invoice berhasil digenerate', toastType);

    // Kalau hasil 0 dan ada diagnostik, log ke console untuk debug
    if (created === 0 && d.data?.diagnostics) {
      console.warn('[Generate Invoice] Hasil 0 — diagnostic:', d.data.diagnostics);
    }

    // Tampilkan daftar pelanggan yang TIDAK ter-generate beserta alasannya,
    // supaya jelas "siapa & kenapa" tidak muncul.
    const details = d.data?.diagnostics?.skipped_details || [];
    if (details.length) _showSkippedCustomers(details, created);
  } else {
    App.showToast(d?.message || 'Gagal generate invoice', 'error');
  }
  btn.disabled = false; btn.textContent = 'Generate';
};

// ── Customer picker untuk generate selektif ──────────────────────────
let _genSelectedCust = {};   // { [id]: { id, name, customer_id } }
let _genSearchTimer  = null;

window.onGenScopeChange = function() {
  const scope = (document.querySelector('input[name="genScope"]:checked') || {}).value || 'all';
  const picker = document.getElementById('genCustPicker');
  if (picker) picker.style.display = scope === 'selected' ? 'block' : 'none';
  // Highlight opsi terpilih
  document.querySelectorAll('.gen-scope-opt').forEach(opt => {
    const input = opt.querySelector('input');
    const on = input && input.checked;
    opt.style.borderColor = on ? '#1a6ef5' : '#e2e8f0';
    opt.style.background = on ? '#eff6ff' : '#fff';
  });
  // Preview hanya relevan untuk mode 'all'
  const preview = document.getElementById('genPreview');
  if (preview) preview.style.display = scope === 'all' ? 'block' : 'none';
  // Sinkronkan label tombol Generate dengan cakupan.
  const btn = document.getElementById('confirmGenerateBtn');
  if (btn) {
    if (scope === 'selected') {
      const n = Object.keys(_genSelectedCust || {}).length;
      btn.textContent = n ? `Generate (${n})` : 'Generate';
    } else {
      btn.textContent = 'Generate';
    }
  }
};

// Tutup dropdown hasil saat klik di luar area picker (dipasang sekali).
if (!window._genOutsideBound) {
  window._genOutsideBound = true;
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('genCustPicker');
    const box = document.getElementById('genCustResults');
    if (!picker || !box || box.style.display === 'none') return;
    if (!picker.contains(e.target)) _genCloseResults();
  });
}

window.onGenCustSearch = function() {
  clearTimeout(_genSearchTimer);
  _genSearchTimer = setTimeout(_genDoCustSearch, 250);
};

async function _genDoCustSearch() {
  const q = (document.getElementById('genCustSearch')?.value || '').trim();
  const box = document.getElementById('genCustResults');
  if (!box) return;
  if (q.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
  try {
    const d = await App.api('/customers?search=' + encodeURIComponent(q) + '&limit=15');
    const rows = (d?.data || d?.customers || d?.rows || []);
    if (!rows.length) {
      box.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:#94a3b8;">Tidak ada hasil.</div>';
      box.style.display = 'block';
      return;
    }
    box.innerHTML = rows.map(c => {
      const id = c.id;
      const cid = c.customer_id || '';
      const nm = (c.name || '').replace(/</g,'&lt;');
      const picked = !!_genSelectedCust[id];
      return `<div onclick='genToggleCust(${id}, ${JSON.stringify(nm)}, ${JSON.stringify(cid)})'
        style="padding:9px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #f1f5f9;${picked?'background:#f0fdf4;':''}"
        onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='${picked?'#f0fdf4':'#fff'}'">
        <div><div style="font-size:12.5px;font-weight:600;color:#0f172a;">${nm}</div>
        <div style="font-size:11px;color:#94a3b8;font-family:'DM Mono',monospace;">${cid}</div></div>
        ${picked?'<span style="font-size:11px;color:#16a34a;font-weight:700;">✓ dipilih</span>':'<span style="font-size:16px;color:#1a6ef5;">+</span>'}
      </div>`;
    }).join('');
    box.style.display = 'block';
  } catch (e) {
    box.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:#dc2626;">Error mencari pelanggan.</div>';
    box.style.display = 'block';
  }
}

window.genToggleCust = function(id, name, cid) {
  if (_genSelectedCust[id]) delete _genSelectedCust[id];
  else _genSelectedCust[id] = { id, name, customer_id: cid };
  _genRenderChips();
  // Tutup dropdown & kosongkan kotak cari setelah memilih supaya tombol
  // Generate tidak tertutup. User bisa cari lagi untuk menambah pelanggan.
  _genCloseResults();
  const searchEl = document.getElementById('genCustSearch');
  if (searchEl) { searchEl.value = ''; searchEl.focus(); }
};

// Tutup daftar hasil pencarian.
function _genCloseResults() {
  const box = document.getElementById('genCustResults');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

function _genRenderChips() {
  const wrap = document.getElementById('genCustChips');
  const empty = document.getElementById('genCustEmpty');
  if (!wrap) return;
  const items = Object.values(_genSelectedCust);
  if (empty) {
    empty.style.display = items.length ? 'none' : 'block';
    empty.textContent = 'Belum ada pelanggan dipilih — cari & klik nama di atas.';
  }
  wrap.innerHTML = items.map(c => `
    <span style="display:inline-flex;align-items:center;gap:6px;background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;
      padding:4px 8px;border-radius:8px;font-size:11.5px;font-weight:600;">
      ${(c.name||'').replace(/</g,'&lt;')}
      <span onclick="genToggleCust(${c.id})" style="cursor:pointer;color:#64748b;font-weight:800;" title="Hapus">×</span>
    </span>`).join('');
  // Label jumlah terpilih (di samping chips) + perbarui tombol Generate.
  if (items.length) {
    wrap.insertAdjacentHTML('afterbegin',
      `<span style="font-size:11.5px;color:#16a34a;font-weight:700;align-self:center;margin-right:2px;">${items.length} dipilih:</span>`);
  }
  const btn = document.getElementById('confirmGenerateBtn');
  const scope = (document.querySelector('input[name="genScope"]:checked') || {}).value || 'all';
  if (btn && scope === 'selected') {
    btn.textContent = items.length ? `Generate (${items.length})` : 'Generate';
  }
}

// ── MARK OVERDUE ──────────────────────────────────────────────
window.markOverdue = async function() {
  showBillConfirm(
    'Tandai Overdue',
    'Tandai semua invoice yang melewati jatuh tempo sebagai <strong>Overdue</strong>?',
    '#dc2626',
    async function() {
      const d = await App.api('/billing/mark-overdue', { method:'POST' });
      if (d && d.success) {
        loadInvoices(); loadBillStats();
        App.showToast(d.message || 'Invoice overdue ditandai', 'success');
      } else App.showToast((d && d.message) || 'Gagal', 'error');
    }
  );
};

// ── RESET / DELETE INVOICES (DESTRUCTIVE) ─────────────────────
window.openResetInvoices = function() {
  // Reset state modal setiap dibuka
  const radios = document.querySelectorAll('input[name="resetMode"]');
  radios.forEach(r => { r.checked = (r.value === 'unpaid'); });
  const periodInputs = document.getElementById('resetPeriodInputs');
  if (periodInputs) periodInputs.style.display = 'none';
  const now = new Date();
  const monthEl = document.getElementById('resetMonth');
  const yearEl  = document.getElementById('resetYear');
  if (monthEl) monthEl.value = now.getMonth() + 1;
  if (yearEl)  yearEl.value  = now.getFullYear();
  const confirmInput = document.getElementById('resetConfirmInput');
  if (confirmInput) confirmInput.value = '';
  const btn = document.getElementById('confirmResetBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; btn.style.cursor = 'not-allowed'; }
  // Show modal & load preview
  document.getElementById('resetInvoiceModal').classList.add('active');
  loadResetPreview();
};

window.closeResetModal = function() {
  document.getElementById('resetInvoiceModal').classList.remove('active');
};

window.onResetModeChange = function() {
  const mode = (document.querySelector('input[name="resetMode"]:checked') || {}).value || 'unpaid';
  const periodInputs = document.getElementById('resetPeriodInputs');
  if (periodInputs) periodInputs.style.display = (mode === 'period') ? 'grid' : 'none';
  loadResetPreview();
};

window.onResetConfirmInput = function() {
  const val = (document.getElementById('resetConfirmInput')?.value || '').trim();
  const btn = document.getElementById('confirmResetBtn');
  if (!btn) return;
  // Tombol baru aktif kalau user ketik persis "RESET" DAN preview sudah load (count > -1)
  const previewLoaded = document.getElementById('resetPreviewContent').style.display !== 'none';
  const enabled = (val === 'RESET') && previewLoaded;
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? '1' : '.5';
  btn.style.cursor  = enabled ? 'pointer' : 'not-allowed';
};

window.loadResetPreview = async function() {
  const mode = (document.querySelector('input[name="resetMode"]:checked') || {}).value || 'unpaid';
  const month = document.getElementById('resetMonth')?.value;
  const year  = document.getElementById('resetYear')?.value;

  const loadingEl = document.getElementById('resetPreviewLoading');
  const contentEl = document.getElementById('resetPreviewContent');
  if (loadingEl) loadingEl.style.display = 'block';
  if (contentEl) contentEl.style.display = 'none';

  // Validasi mode period — kalau month/year belum lengkap, tahan preview
  if (mode === 'period' && (!month || !year)) {
    if (loadingEl) loadingEl.textContent = 'Pilih bulan & tahun untuk melihat preview';
    return;
  }

  let url = '/billing/invoices/reset/preview?mode=' + encodeURIComponent(mode);
  if (mode === 'period') url += '&month=' + month + '&year=' + year;

  try {
    const d = await App.api(url);
    if (!d?.success) {
      if (loadingEl) loadingEl.textContent = d?.message || 'Gagal memuat preview';
      return;
    }
    const data = d.data || {};
    const fmt = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
    document.getElementById('rpInvoiceCount').textContent = (data.invoice_count || 0).toLocaleString('id-ID');
    document.getElementById('rpPaymentCount').textContent = (data.payment_count || 0).toLocaleString('id-ID');
    document.getElementById('rpGrossTotal').textContent   = fmt(data.gross_total);
    document.getElementById('rpPaidTotal').textContent    = fmt(data.paid_total);
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';
    // Re-evaluate tombol confirm
    onResetConfirmInput();
  } catch (err) {
    if (loadingEl) loadingEl.textContent = 'Error: ' + (err?.message || 'network error');
  }
};

window.confirmResetInvoices = async function() {
  const mode = (document.querySelector('input[name="resetMode"]:checked') || {}).value || 'unpaid';
  const month = document.getElementById('resetMonth')?.value;
  const year  = document.getElementById('resetYear')?.value;
  const confirm = (document.getElementById('resetConfirmInput')?.value || '').trim();

  if (confirm !== 'RESET') {
    App.showToast('Ketik "RESET" untuk melanjutkan', 'error');
    return;
  }

  const body = { mode, confirm };
  if (mode === 'period') {
    if (!month || !year) {
      App.showToast('Pilih bulan & tahun untuk mode periode', 'error');
      return;
    }
    body.month = parseInt(month);
    body.year  = parseInt(year);
  }

  const btn = document.getElementById('confirmResetBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '.5'; btn.textContent = 'Menghapus…'; }

  try {
    const d = await App.api('/billing/invoices/reset', { method:'POST', body: JSON.stringify(body) });
    if (d?.success) {
      App.showToast(d.message || 'Reset berhasil', 'success');
      closeResetModal();
      _billPage = 1;
      loadInvoices();
      if (typeof loadBillStats === 'function') loadBillStats();
    } else {
      App.showToast(d?.message || 'Gagal reset invoice', 'error');
    }
  } catch (err) {
    App.showToast('Error: ' + (err?.message || 'network error'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false; btn.style.opacity = '1';
      btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="display:inline-block;vertical-align:-2px;margin-right:6px;"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>Hapus Invoice';
    }
  }
};

// ── HAPUS INVOICE (per-baris & multi-select) ──────────────────
window.deleteInvoice = function(invoiceId, invNumber, custName) {
  showBillConfirm(
    'Hapus Invoice',
    'Hapus invoice <strong>' + _esc(invNumber) + '</strong>' +
      (custName ? ' (' + _esc(custName) + ')' : '') + '?<br><br>' +
      '<span style="color:#dc2626;">Pembayaran terkait juga akan dihapus. Tindakan ini tidak bisa dibatalkan.</span><br><br>' +
      '<span style="font-size:12px;color:#64748b;">Setelah dihapus, invoice ini bisa di-generate ulang lewat tombol Generate.</span>',
    '#dc2626',
    async function() {
      try {
        const d = await App.api('/billing/invoices/' + invoiceId, { method: 'DELETE' });
        if (d?.success) {
          App.showToast(d.message || 'Invoice dihapus', 'success');
          loadInvoices();
          if (typeof loadBillStats === 'function') loadBillStats();
        } else {
          App.showToast(d?.message || 'Gagal menghapus invoice', 'error');
        }
      } catch (err) {
        App.showToast('Error: ' + (err?.message || 'network error'), 'error');
      }
    }
  );
};

window.onInvCheck = function() { _syncBulkBar(); };

window.toggleSelectAllInv = function(master) {
  document.querySelectorAll('.inv-check').forEach(cb => { cb.checked = master.checked; });
  _syncBulkBar();
};

window.clearInvoiceSelection = function() {
  document.querySelectorAll('.inv-check').forEach(cb => { cb.checked = false; });
  const master = document.getElementById('selectAllInv');
  if (master) master.checked = false;
  _syncBulkBar();
};

function _selectedInvoiceIds() {
  return Array.from(document.querySelectorAll('.inv-check:checked')).map(cb => parseInt(cb.value)).filter(Boolean);
}

function _syncBulkBar() {
  const ids   = _selectedInvoiceIds();
  const bar   = document.getElementById('bulkBar');
  const count = document.getElementById('bulkCount');
  if (count) count.textContent = ids.length;
  if (bar)   bar.style.display = ids.length > 0 ? 'flex' : 'none';
  // Sinkronkan state checkbox "select all"
  const master = document.getElementById('selectAllInv');
  const all    = document.querySelectorAll('.inv-check');
  if (master) {
    master.checked = all.length > 0 && ids.length === all.length;
    master.indeterminate = ids.length > 0 && ids.length < all.length;
  }
}

window.bulkDeleteSelected = function() {
  const ids = _selectedInvoiceIds();
  if (ids.length === 0) { App.showToast('Pilih invoice dulu', 'info'); return; }
  showBillConfirm(
    'Hapus ' + ids.length + ' Invoice',
    'Hapus <strong>' + ids.length + '</strong> invoice terpilih beserta pembayarannya?<br><br>' +
      '<span style="color:#dc2626;">Tindakan ini tidak bisa dibatalkan.</span>',
    '#dc2626',
    async function() {
      try {
        const d = await App.api('/billing/invoices/bulk-delete', {
          method: 'POST', body: JSON.stringify({ invoice_ids: ids })
        });
        if (d?.success) {
          App.showToast(d.message || 'Invoice terpilih dihapus', 'success');
          clearInvoiceSelection();
          loadInvoices();
          if (typeof loadBillStats === 'function') loadBillStats();
        } else {
          App.showToast(d?.message || 'Gagal menghapus invoice', 'error');
        }
      } catch (err) {
        App.showToast('Error: ' + (err?.message || 'network error'), 'error');
      }
    }
  );
};

// ── MODAL: daftar pelanggan yang tidak ter-generate ───────────
function _showSkippedCustomers(details, created) {
  const REASON = {
    ineligible_status: { label: 'Status tidak aktif', color: '#94a3b8' },
    no_package:        { label: 'Belum punya paket',  color: '#d97706' },
    existing:          { label: 'Sudah ada invoice',  color: '#1a6ef5' },
    not_started:       { label: 'Belum mulai ditagih', color: '#0ea5e9' },
    failed:            { label: 'Gagal dibuat',        color: '#dc2626' }
  };
  // Kelompokkan per alasan
  const groups = {};
  details.forEach(it => { (groups[it.reason] = groups[it.reason] || []).push(it); });

  let rows = '';
  Object.keys(groups).forEach(reason => {
    const meta = REASON[reason] || { label: reason, color: '#64748b' };
    groups[reason].forEach(it => {
      rows += '<tr style="border-bottom:1px solid #f1f5f9;">' +
        '<td style="padding:7px 10px;font-size:12.5px;color:#0d1b3e;">' + _esc(it.name || '–') +
          '<div style="font-size:11px;color:#94a3b8;font-family:monospace;">' + _esc(it.customer_id || '') + '</div></td>' +
        '<td style="padding:7px 10px;"><span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#fff;background:' + meta.color + ';">' + meta.label + '</span></td>' +
        '<td style="padding:7px 10px;font-size:11.5px;color:#64748b;">' + _esc(it.detail || '') + '</td>' +
      '</tr>';
    });
  });

  var existing = document.getElementById('_skippedModal');
  if (existing) existing.remove();
  var el = document.createElement('div');
  el.id = '_skippedModal';
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(13,27,62,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
  el.innerHTML = '<div style="background:#fff;border-radius:18px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(13,27,62,.25);">'
    + '<div style="background:#1e3a8a;padding:16px 20px;">'
      + '<div style="font-size:14px;font-weight:800;color:#fff;">Pelanggan yang tidak ter-generate (' + details.length + ')</div>'
      + '<div style="font-size:12px;color:#c7d7fe;margin-top:3px;">' + (created || 0) + ' invoice berhasil dibuat · ' + details.length + ' dilewati</div>'
    + '</div>'
    + '<div style="overflow-y:auto;padding:8px 14px 0;">'
      + '<table style="width:100%;border-collapse:collapse;">'
        + '<thead><tr style="border-bottom:2px solid #e2e8f0;">'
          + '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase;">Pelanggan</th>'
          + '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase;">Alasan</th>'
          + '<th style="padding:7px 10px;text-align:left;font-size:11px;color:#94a3b8;text-transform:uppercase;">Keterangan</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>'
    + '</div>'
    + '<div style="padding:14px 20px;display:flex;justify-content:flex-end;border-top:1px solid #f1f5f9;">'
      + '<button id="_skippedClose" style="padding:8px 18px;border:none;border-radius:9px;background:#1a6ef5;color:#fff;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;">Tutup</button>'
    + '</div>'
  + '</div>';
  document.body.appendChild(el);
  document.getElementById('_skippedClose').onclick = function(){ el.remove(); };
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });
}

// ── PAGINATION ────────────────────────────────────────────────
function _renderPagination(total) {
  const totalPages = Math.ceil(total / 20);
  const el = document.getElementById('billPagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }
  let html = '';
  if (_billPage > 1) html += '<button class="pg-btn" onclick="_goPage(' + (_billPage-1) + ')">← Prev</button>';
  for (let i = Math.max(1,_billPage-2); i <= Math.min(totalPages,_billPage+2); i++)
    html += '<button class="pg-btn ' + (i===_billPage?'active':'') + '" onclick="_goPage(' + i + ')">' + i + '</button>';
  if (_billPage < totalPages) html += '<button class="pg-btn" onclick="_goPage(' + (_billPage+1) + ')">Next →</button>';
  el.innerHTML = html;
}
window._goPage = p => { _billPage = p; loadInvoices(); };

// ── CONFIRM MODAL ────────────────────────────────────────────
function showBillConfirm(title, body, accentColor, onConfirm) {
  var existing = document.getElementById('_billConfirm');
  if (existing) existing.remove();

  var el = document.createElement('div');
  el.id = '_billConfirm';
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(13,27,62,.45);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
  el.innerHTML = '<div style="background:#fff;border-radius:18px;width:100%;max-width:400px;overflow:hidden;box-shadow:0 24px 80px rgba(13,27,62,.25);">'
    + '<div style="background:' + (accentColor||'#1a6ef5') + ';padding:16px 20px;display:flex;align-items:center;gap:10px;">'
      + '<div style="font-size:14px;font-weight:800;color:#fff">' + title + '</div>'
    + '</div>'
    + '<div style="padding:18px 20px;font-size:13.5px;color:#374151;line-height:1.6;">' + body + '</div>'
    + '<div style="display:flex;gap:10px;padding:0 20px 18px;justify-content:flex-end;">'
      + '<button id="_billCancel" style="padding:8px 18px;border:1.5px solid #e2e8f0;border-radius:9px;background:#fff;color:#64748b;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;">Batal</button>'
      + '<button id="_billOk" style="padding:8px 18px;border:none;border-radius:9px;background:' + (accentColor||'#1a6ef5') + ';color:#fff;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;">Ya, Lanjutkan</button>'
    + '</div>'
  + '</div>';

  document.body.appendChild(el);
  document.getElementById('_billCancel').onclick = function(){ el.remove(); };
  document.getElementById('_billOk').onclick = function(){ try { onConfirm(); } finally { el.remove(); } };
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });
}


// Payment method badge helper. `pay` = objek payment (punya payment_method,
// gateway, notes) ATAU string method (kompat lama).
function _pmBadge(pay) {
  if (!pay) return '<span style="color:#94a3b8;font-size:12px">–</span>';
  var method, gateway = null, notes = null;
  if (typeof pay === 'object') {
    method  = pay.payment_method;
    gateway = pay.gateway || null;
    notes   = pay.notes || null;
  } else { method = pay; }

  // Deteksi gateway online: kolom gateway → fallback parsing notes ("Auto: <Gw>").
  var GW = { tripay:'Tripay', midtrans:'Midtrans', xendit:'Xendit', duitku:'Duitku' };
  var gwKey = gateway ? String(gateway).toLowerCase() : null;
  if (!gwKey && notes) {
    var m = String(notes).match(/(?:Auto|Rekonsiliasi)\s*:\s*(Tripay|Midtrans|Xendit|Duitku)\b/i);
    if (m) gwKey = m[1].toLowerCase();
  }
  if (gwKey && GW[gwKey]) {
    return '<span class="pm-gateway pm-'+gwKey+'">'+GW[gwKey]+'</span>';
  }

  var labels = { cash:'Cash', transfer:'Transfer', dana:'Dana', ovo:'OVO',
    gopay:'GoPay', qris:'QRIS', ewallet:'E-Wallet', gateway:'Gateway',
    field_collection:'Cash Collect', other:'Lainnya' };
  var cls = ['qris','gateway'].includes(method) ? 'pm-'+method
    : ['dana','ovo','gopay','ewallet'].includes(method) ? 'pm-ewallet'
    : method === 'transfer' ? 'pm-transfer'
    : method === 'field_collection' ? 'pm-cash'
    : method === 'cash' ? 'pm-cash' : 'pm-other';
  // fallback label: ubah snake_case mentah jadi Title Case bila tak dikenal
  var lbl = labels[method] || String(method).replace(/_/g,' ').replace(/\b\w/g, function(c){return c.toUpperCase();});
  return '<span class="'+cls+'">'+lbl+'</span>';
}
// ── HELPERS ───────────────────────────────────────────────────
function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function _setBar(id, ratio) { const el = document.getElementById(id); if (el) el.style.width = Math.min(Math.max((ratio||0)*100, 2), 100) + '%'; }
function _fmtDate(s) { return s ? new Date(s+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}) : '–'; }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }
// ════════════════════════════════════════════════════════════════
// VERIFIKASI BUKTI PEMBAYARAN (manual)
// ════════════════════════════════════════════════════════════════
let _proofList = [];

async function refreshProofBadge() {
  try {
    const r = await App.api('/billing/pending-proofs');
    const n = (r && r.success && Array.isArray(r.data)) ? r.data.length : 0;
    const badge = document.getElementById('proofInboxBadge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = n > 0 ? 'block' : 'none';
    }
  } catch (_) { /* diam */ }
}

async function openProofInbox() {
  const modal = document.getElementById('proofInboxModal');
  const body = document.getElementById('proofInboxBody');
  if (modal) modal.style.display = 'flex';
  if (body) body.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Memuat…</div>';
  try {
    const r = await App.api('/billing/pending-proofs');
    _proofList = (r && r.success && Array.isArray(r.data)) ? r.data : [];
    renderProofInbox();
  } catch (e) {
    if (body) body.innerHTML = '<div style="color:#dc2626;font-size:13px;padding:20px;">Gagal memuat: ' + _esc(e.message || e) + '</div>';
  }
}

function closeProofInbox() {
  const modal = document.getElementById('proofInboxModal');
  if (modal) modal.style.display = 'none';
}

function renderProofInbox() {
  const body = document.getElementById('proofInboxBody');
  if (!body) return;
  if (!_proofList.length) {
    body.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:30px;">Tidak ada bukti yang menunggu verifikasi. 🎉</div>';
    return;
  }
  body.innerHTML = _proofList.map(function (p) {
    const cust = p.customer || {};
    const when = p.proof_submitted_at ? new Date(p.proof_submitted_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '–';
    const periodeStr = (MONTHS[p.period_month] || p.period_month || '') + (p.period_year ? ' ' + p.period_year : '');
    const periodeBadge = periodeStr
      ? '<span style="display:inline-block;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;padding:2px 9px;border-radius:6px;margin-left:8px;">' + _esc(periodeStr) + '</span>'
      : '';
    return '' +
      '<div style="border:1px solid #eef2f7;border-radius:12px;padding:14px;margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<div>' +
            '<div style="font-size:14px;font-weight:700;color:#0f172a;">' + _esc(cust.name || '-') + ' <span style="font-weight:500;color:#94a3b8;">(' + _esc(cust.customer_id || '-') + ')</span>' + periodeBadge + '</div>' +
            '<div style="font-size:12px;color:#64748b;margin-top:3px;">' + _esc(p.invoice_number) + ' · Periode <b style="color:#475569;">' + _esc(periodeStr || '-') + '</b> · ' + _fmtRp(p.total) + '</div>' +
            '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">Diunggah: ' + when + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">' +
            '<button onclick="viewProofImg(' + p.id + ')" style="padding:7px 12px;border:1.5px solid #e2e8f0;border-radius:9px;background:#fff;color:#334155;font-size:12px;font-weight:700;cursor:pointer;">Lihat Bukti</button>' +
            '<button onclick="approveProof(' + p.id + ')" style="padding:7px 12px;border:none;border-radius:9px;background:#16a34a;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">Verifikasi &amp; Lunas</button>' +
            '<button onclick="rejectProofPrompt(' + p.id + ')" style="padding:7px 12px;border:1.5px solid #fecaca;border-radius:9px;background:#fff;color:#dc2626;font-size:12px;font-weight:700;cursor:pointer;">Tolak</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }).join('');
}

function viewProofImg(id) {
  const lb = document.getElementById('proofLightbox');
  const content = document.getElementById('proofLightboxContent');
  if (!lb || !content) return;
  const url = '/api/billing/invoices/' + id + '/proof';
  // Coba render sebagai gambar; kalau PDF, tampilkan via <iframe>.
  content.innerHTML = '<img src="' + url + '" style="display:block;max-width:88vw;max-height:80vh;" ' +
    'onerror="this.outerHTML=\'<iframe src=&quot;' + url + '&quot; style=&quot;width:88vw;height:80vh;border:none;&quot;></iframe>\'">';
  lb.style.display = 'flex';
}

function closeProofLightbox() {
  const lb = document.getElementById('proofLightbox');
  if (lb) { lb.style.display = 'none'; const c = document.getElementById('proofLightboxContent'); if (c) c.innerHTML = ''; }
}

async function approveProof(id) {
  showBillConfirm(
    'Verifikasi Pembayaran',
    'Verifikasi bukti ini dan tandai invoice <strong>LUNAS</strong>?<br><small style="color:#64748b">Pembayaran akan dicatat sebagai Transfer Bank.</small>' +
    '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;cursor:pointer;user-select:none;">' +
      '<input type="checkbox" id="_proofSendWa" checked style="width:16px;height:16px;accent-color:#16a34a;cursor:pointer;">' +
      '<span style="font-size:12.5px;color:#0f172a;font-weight:600;">Kirim notifikasi WhatsApp ke pelanggan</span>' +
    '</label>',
    '#16a34a',
    async function () {
      const sendWa = !!(document.getElementById('_proofSendWa') && document.getElementById('_proofSendWa').checked);
      const r = await App.api('/billing/invoices/' + id + '/proof/verify', { method: 'POST', body: JSON.stringify({ method: 'transfer', send_wa: sendWa }) });
      if (r && r.success) {
        let extra = '';
        if (sendWa) extra = (r.data && r.data.wa_status === 'sent') ? ' · WA terkirim' : ' · WA gagal/skip';
        App.showToast('✓ ' + (r.message || 'Invoice ditandai lunas') + extra, 'success');
        _proofList = _proofList.filter(function (p) { return p.id !== id; });
        renderProofInbox(); refreshProofBadge(); loadInvoices(); loadBillStats();
      } else {
        App.showToast('Gagal: ' + ((r && r.message) || 'Error'), 'error');
      }
    }
  );
}

function rejectProofPrompt(id) {
  showBillConfirm(
    'Tolak Bukti Pembayaran',
    'Tolak bukti pembayaran ini? Pelanggan dapat mengunggah ulang bukti yang benar.',
    '#dc2626',
    async function () {
      const r = await App.api('/billing/invoices/' + id + '/proof/reject', { method: 'POST', body: JSON.stringify({}) });
      if (r && r.success) {
        App.showToast(r.message || 'Bukti ditolak', 'success');
        _proofList = _proofList.filter(function (p) { return p.id !== id; });
        renderProofInbox(); refreshProofBadge();
      } else {
        App.showToast('Gagal: ' + ((r && r.message) || 'Error'), 'error');
      }
    }
  );
}

function _fmtRp(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }
