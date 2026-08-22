// payments.js — Halaman Pembayaran

let _payChart   = null;
let _donutChart = null;
let _payPage    = 1;
let _payMethod  = 'cash';
let _selCust    = null;
let _searchTimer= null;
const MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const METHOD_COLORS = { cash:'#059669',transfer:'#2563eb',dana:'#0ea5e9',ovo:'#1d4ed8',gopay:'#16a34a',qris:'#d97706',field_collection:'#0d9488' };
let _proofRows = [];

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();

  // Set default date fields
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('payDate').value = today;

  // Set default period = current month/year
  const now = new Date();
  const fm = document.getElementById('filterMonth');
  const fy = document.getElementById('filterYear');
  const pm = document.getElementById('payPeriodMonth');
  const py = document.getElementById('payPeriodYear');
  if (fm) fm.value = now.getMonth() + 1;
  if (pm) pm.value = now.getMonth() + 1;
  if (py) py.value = now.getFullYear();

  // Saat periode (Bulan/Tahun) diubah, cek ulang status lunas untuk periode itu
  // — supaya tombol tidak terkunci karena periode lama yang sudah lunas, padahal
  // admin sedang menginput periode bulan berikutnya (mis. bayar 3 bulan ke depan).
  const reCheck = () => {
    if (!_selCust || !_selCust.id) return;
    const m = document.getElementById('payPeriodMonth')?.value;
    const y = document.getElementById('payPeriodYear')?.value;
    checkAlreadyPaid(_selCust.id, m, y);
  };
  if (pm) pm.addEventListener('change', reCheck);
  if (py) py.addEventListener('input', reCheck);

  // Populate year select
  if (fy) {
    const y = now.getFullYear();
    fy.innerHTML = [y-1, y, y+1].map(yr => `<option value="${yr}" ${yr===y?'selected':''}>${yr}</option>`).join('');
  }

  // Set default due date = next month same billing day (day 1 default)
  setDefaultDueDate(1);

  // WA toggle visual
  const waChk = document.getElementById('paySendWa');
  if (waChk) waChk.addEventListener('change', () => updateWaToggle(waChk.checked));
  const emChk = document.getElementById('paySendEmail');
  if (emChk) emChk.addEventListener('change', () => updateEmailToggle(emChk.checked));

  // Click outside closes dropdown
  document.addEventListener('click', e => {
    if (!e.target.closest('.cust-wrap')) closeCustDropdown();
  });

  // Load data
  loadStats();
  loadChart();
  loadPayments();
});

function updateWaToggle(on) {
  const slider = document.getElementById('waSlider');
  const thumb  = document.getElementById('waThumb');
  if (slider) slider.style.background = on ? '#25d366' : '#ccc';
  if (thumb)  thumb.style.transform = on ? 'translateX(18px)' : 'translateX(0)';
}

function updateEmailToggle(on) {
  const slider = document.getElementById('emailSlider');
  const thumb  = document.getElementById('emailThumb');
  if (slider) slider.style.background = on ? '#1d4ed8' : '#ccc';
  if (thumb)  thumb.style.left = on ? '20px' : '2px';
}

// Tambah 1 bulan ke sebuah Date, mempertahankan hari bila memungkinkan.
// Kalau hari tujuan tidak ada di bulan target (mis. 31 -> Feb), clamp ke
// hari terakhir bulan target.
function addOneMonthKeepDay(date) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);                 // hindari overflow saat ganti bulan
  d.setMonth(d.getMonth() + 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function toYmd(date) {
  // Local date -> 'YYYY-MM-DD' tanpa pergeseran timezone (hindari .toISOString()).
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Hitung default "Jatuh Tempo Baru".
//   • Jika customerDueDate (jatuh tempo asli tersimpan di data customer) ada:
//       default = jatuh tempo asli + 1 bulan  (mis. 1 Mei -> 1 Juni)
//   • Jika tidak ada: fallback ke billing_date pada bulan berikutnya dari hari ini.
// Field tetap editable — admin bisa override.
function setDefaultDueDate(billingDay, customerDueDate) {
  const el = document.getElementById('payDueDate');
  if (!el) return;

  if (customerDueDate) {
    const base = new Date(customerDueDate + 'T00:00:00');
    if (!isNaN(base.getTime())) {
      el.value = toYmd(addOneMonthKeepDay(base));
      return;
    }
  }

  // Fallback: pakai billing_date, ambil bulan depan dari hari ini.
  const today = new Date();
  const bd = parseInt(billingDay) || 1;
  let m = today.getMonth(), y = today.getFullYear();
  const thisMonthDue = new Date(y, m, bd);
  if (today >= thisMonthDue) { m++; if (m > 11) { m = 0; y++; } }
  el.value = toYmd(new Date(y, m, bd));
}

// ── STATS ─────────────────────────────────────────────────────
async function loadStats() {
  const month = document.getElementById('filterMonth')?.value;
  const year  = document.getElementById('filterYear')?.value;
  const d = await App.api(`/payments/stats?month=${month}&year=${year}`);
  if (!d?.success) return;
  const s = d.data;

  const fmtAmt = amt => 'Rp ' + (amt >= 1000000
    ? (amt/1000000).toFixed(1).replace('.0','') + 'jt'
    : Math.round(amt/1000) + 'rb');

  // Card 2: Penerimaan
  setT('fcAmt',    fmtAmt(s.total_amount));
  setT('fcAmtSub', s.total_tx + ' transaksi ' + MONTHS[s.month] + ' ' + s.year);
  setT('fcAmtPct', 'Rp ' + Number(s.total_amount).toLocaleString('id-ID') + ' total');
  setW('fcAmtBar', s.prev_amount > 0 ? Math.min(s.total_amount/s.prev_amount*100, 100) : 80);

  // Card 3: Transaksi
  setT('fcTx',    s.total_tx);
  setT('fcTxSub', MONTHS[s.month] + ' ' + s.year + (s.growth_tx !== null ? ' · ' + (s.growth_tx >= 0 ? '↑' : '↓') + Math.abs(s.growth_tx) + '% vs bln lalu' : ''));
  setT('fcTxPct', (s.prev_tx || 0) + ' transaksi bulan lalu');
  setW('fcTxBar', s.prev_tx > 0 ? Math.min(s.total_tx/s.prev_tx*100, 100) : 60);

  // Card 1: Total Tagihan (Total Invoices)
  setT('fcTotalInv',    fmtAmt(s.total_invoice_amount || 0));
  setT('fcTotalInvSub', (s.total_invoices || 0) + ' invoice bulan ini');
  setT('fcTotalInvPct', 'Rp ' + Number(s.total_invoice_amount || 0).toLocaleString('id-ID') + ' total tagihan');
  setW('fcTotalInvBar', 100);

  // Card 4: Tagihan Tertunggak (Overdue)
  setT('fcOverdue',    fmtAmt(s.overdue_amount || 0));
  setT('fcOverdueSub', (s.overdue_count || 0) + ' tagihan belum bayar');
  setT('fcOverduePct', s.total_invoices > 0 ? Math.round((s.overdue_count||0)/(s.total_invoices||1)*100) + '% dari total invoice' : 'Tidak ada tunggakan');
  setW('fcOverdueBar', s.total_invoices > 0 ? (s.overdue_count||0)/(s.total_invoices||1)*100 : 0);

  // Update header sub
  setT('payHeaderSub', `${s.total_tx} transaksi dicatat · Total ${fmtAmt(s.total_amount)} · ${MONTHS[s.month]} ${s.year}`);

  // Update donut chart
  if (s.method_stats?.length) updateDonut(s.method_stats, s.month, s.year);
}

// ── CHART ─────────────────────────────────────────────────────
async function loadChart() {
  const month = parseInt(document.getElementById('filterMonth')?.value);
  const year  = parseInt(document.getElementById('filterYear')?.value);
  const d = await App.api(`/payments/chart?month=${month}&year=${year}`);
  if (!d?.success) return;

  const mname = MONTHS[month] + ' ' + year;
  setT('chartSubTitle', mname);
  setT('tblSubTitle', `${d.data.filter(x=>x.count>0).length} hari aktif · ${mname}`);

  const labels = d.data.map(x => x.day);
  const vals   = d.data.map(x => x.total);

  const ctx = document.getElementById('payChart')?.getContext('2d');
  if (!ctx) return;
  if (_payChart) _payChart.destroy();

  // Gradient bar — identik dengan PHP referensi
  _payChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Penerimaan',
        data: vals,
        backgroundColor: function(c) {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, 160);
          g.addColorStop(0, 'rgba(26,110,245,.85)');
          g.addColorStop(1, 'rgba(26,110,245,.15)');
          return g;
        },
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#fff', titleColor: '#0d1b3e', bodyColor: '#6b7fa8',
          borderColor: '#e0e7f3', borderWidth: 1, cornerRadius: 10,
          callbacks: { label: c => ' Rp ' + Number(c.parsed.y).toLocaleString('id-ID') }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#6b7fa8', font: { size: 11 } }, border: { display: false } },
        y: {
          grid: { color: 'rgba(0,0,0,.04)' },
          ticks: {
            color: '#6b7fa8', font: { size: 11 }, maxTicksLimit: 5,
            callback: v => v >= 1e6 ? 'Rp'+(v/1e6)+'jt' : v >= 1e3 ? 'Rp'+Math.round(v/1e3)+'rb' : v
          },
          border: { display: false }
        }
      }
    }
  });
}

function updateDonut(methodStats, month, year) {
  const COLORS = { cash:'#1a6ef5', transfer:'#00b8e6', dana:'#0ea5e9', ovo:'#1d4ed8', gopay:'#00c896', qris:'#fb8c00' };
  const grandTotal = methodStats.reduce((a, m) => a + m.total, 0) || 1;

  setT('donutSubTitle', 'Periode ' + (MONTHS[month]||'').slice(0,3) + ' ' + year);

  // ── Donut ────────────────────────────────────────────────────
  const dctx = document.getElementById('donutChart')?.getContext('2d');
  if (dctx) {
    if (_donutChart) _donutChart.destroy();
    _donutChart = new Chart(dctx, {
      type: 'doughnut',
      data: {
        labels: methodStats.map(m => m.label),
        datasets: [{
          data: methodStats.map(m => m.total),
          backgroundColor: methodStats.map(m => COLORS[m.method] || '#6b7fa8'),
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        cutout: '70%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#fff', titleColor: '#0d1b3e', bodyColor: '#6b7fa8',
            borderColor: '#e0e7f3', borderWidth: 1, cornerRadius: 10,
            callbacks: { label: c => ' Rp ' + Number(c.parsed).toLocaleString('id-ID') }
          }
        }
      }
    });
  }

  // ── Legend — identik PHP referensi ───────────────────────────
  const legend = document.getElementById('donutLegend');
  if (legend) {
    legend.innerHTML = methodStats.map(m => {
      const pct   = Math.round(m.total / grandTotal * 100);
      const color = COLORS[m.method] || '#6b7fa8';
      return '<div class="mb-row">' +
        '<span class="mb-dot" style="background:' + color + ';"></span>' +
        '<span class="mb-label">' + m.label + '</span>' +
        '<div class="mb-bar"><div class="mb-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
        '<span class="mb-pct" style="color:' + color + ';">' + pct + '%</span>' +
      '</div>';
    }).join('');
  }
}

// ── PAYMENTS LIST ─────────────────────────────────────────────
async function loadPayments() {
  const month  = document.getElementById('filterMonth')?.value;
  const year   = document.getElementById('filterYear')?.value;
  const search = document.getElementById('tblSearch')?.value || '';
  const d = await App.api(`/payments/list?month=${month}&year=${year}&page=${_payPage}&limit=20&search=${encodeURIComponent(search)}`);

  const tbody = document.getElementById('payTable');
  const countEl = document.getElementById('tblCount');
  if (!d?.success) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><p style="color:#dc2626;">Gagal memuat data</p></div></td></tr>';
    return;
  }

  const total = d.total || 0;
  if (countEl) countEl.textContent = 'Hal ' + _payPage + '/' + Math.ceil(total/20);

  if (!d.data?.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg><p>Belum ada pembayaran di periode ini</p></div></td></tr>';
    renderPagination(0);
    return;
  }

  const methodColors = METHOD_COLORS;
  const methodLabels = { cash:'Cash',transfer:'Transfer',dana:'DANA',ovo:'OVO',gopay:'GoPay',qris:'QRIS',field_collection:'Cash Collect',ewallet:'E-Wallet',gateway:'Payment Gateway',va:'Virtual Account',other:'Lainnya' };
  // Warna badge untuk gateway online (label datang dari backend method_label).
  const GATEWAY_COLORS = { tripay:'#2563eb', midtrans:'#1e3a8a', xendit:'#1d4ed8', duitku:'#0284c7' };

  tbody.innerHTML = d.data.map(p => {
    const payDate = p.payment_date ? new Date(p.payment_date+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–';
    const dueDate = p.due_date    ? new Date(p.due_date+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–';
    // Utamakan method_label dari backend (mengenali gateway Tripay/Midtrans/dll).
    const label   = p.method_label || methodLabels[p.payment_method] || (p.payment_method ? String(p.payment_method).replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : '–');
    const gwKey   = p.gateway ? String(p.gateway).toLowerCase() : '';
    const color   = GATEWAY_COLORS[gwKey] || methodColors[p.payment_method] || '#6b7280';
    const fmtAmt  = 'Rp ' + Number(p.amount).toLocaleString('id-ID');
    const ref     = p.reference_number ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${esc(p.reference_number)}</div>` : '';
    // Notification badge
    let notifHtml = '<span style="color:#94a3b8;font-size:13px;">–</span>';
    if (p.wa_sent_status === 'sent') {
      const sentTime = p.wa_sent_at
        ? new Date(p.wa_sent_at).toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit'}) + ' ' +
          new Date(p.wa_sent_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})
        : '';
      notifHtml = '<div style="display:inline-flex;align-items:center;gap:5px;background:#dcfce7;color:#16a34a;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:700;">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:#16a34a;flex-shrink:0;"></span>Sent</div>' +
        (sentTime ? '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">' + sentTime + '</div>' : '');
    } else if (p.wa_sent_status === 'failed') {
      notifHtml = '<span style="display:inline-flex;align-items:center;gap:5px;background:#fee2e2;color:#dc2626;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:700;">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:#dc2626;flex-shrink:0;"></span>Failed</span>';
    }

    // Validation by (recorded_by)
    const recBy = p.recorded_by_name
      ? '<div style="font-size:12px;font-weight:600;color:#0d1b3e;">' + esc(p.recorded_by_name) + '</div>' +
        '<div style="font-size:10px;color:#94a3b8;">' +
          new Date(p.created_at).toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit'}) + ' ' +
          new Date(p.created_at).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'}) +
        '</div>'
      : '<span style="color:#94a3b8;font-size:12px;">–</span>';

    return '<tr>' +
      '<td><div style="font-weight:700;color:#0d1b3e;">' + esc(p.cust_name) + '</div>' +
        '<div style="font-size:11px;color:#94a3b8;">' + esc(p.cid) + ' · ' + esc(p.pkg_name||'–') + '</div></td>' +
      '<td style="font-size:12px;color:#374151;">' + payDate +
        '<div style="font-size:10px;color:#94a3b8;">' + (MONTHS[p.period_month]||'') + ' ' + (p.period_year||'') + '</div></td>' +
      '<td style="font-weight:700;color:#1a6ef5;font-size:14px;font-family:monospace;">' + fmtAmt + '</td>' +
      '<td><span class="mbadge" style="background:' + color + '18;color:' + color + ';">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block;"></span>' + label + '</span>' + ref + '</td>' +
      '<td style="font-size:12px;color:#374151;">' + dueDate + '</td>' +
      '<td class="col-hide-mobile">' + notifHtml + '</td>' +
      '<td class="col-hide-mobile">' + recBy + '</td>' +
      '<td class="col-hide-mobile"><div style="font-size:11px;color:#6b7fa8;font-family:monospace;">' + esc(p.invoice_number||'–') + '</div></td>' +
      '<td><div style="display:flex;gap:5px;flex-wrap:wrap;">' +
        '<button class="inv-btn" onclick="openInvoice(' + p.id + ')">' +
          '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' +
          'Invoice</button>' +
        '<button class="del-btn" onclick="deletePayment(' + p.id + ',&quot;' + esc(p.cust_name) + '&quot;)">Hapus</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');

  renderPagination(total);
}

function renderPagination(total) {
  const totalPages = Math.ceil(total / 20);
  const el = document.getElementById('payPagination');
  if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }
  let html = '';
  if (_payPage > 1) html += `<button class="pg-btn" onclick="goPage(${_payPage-1})">← Prev</button>`;
  for (let i = Math.max(1,_payPage-2); i <= Math.min(totalPages,_payPage+2); i++)
    html += `<button class="pg-btn ${i===_payPage?'active':''}" onclick="goPage(${i})">${i}</button>`;
  if (_payPage < totalPages) html += `<button class="pg-btn" onclick="goPage(${_payPage+1})">Next →</button>`;
  el.innerHTML = html;
}
window.goPage = p => { _payPage = p; loadPayments(); };

// ── CUSTOMER SEARCH ───────────────────────────────────────────
async function searchCustomers(val) {
  clearTimeout(_searchTimer);
  if (!val || val.length < 2) { closeCustDropdown(); return; }
  _searchTimer = setTimeout(async () => {
    const d = await App.api('/payments/customers?q=' + encodeURIComponent(val));
    if (!d?.success) return;
    const dd = document.getElementById('custDropdown');
    if (!dd) return;
    if (!d.data.length) {
      dd.innerHTML = '<div class="cust-item"><div class="ci-sub">Tidak ditemukan</div></div>';
    } else {
      dd.innerHTML = d.data.map(c =>
        `<div class="cust-item" onclick="selectCustomer(${c.id},'${esc(c.name)}','${esc(c.customer_id)}','${esc(c.phone||'')}',${c.billing_date||1},${c.package?.price||0},'${esc(c.package?.name||'')}','${esc(c.due_date||'')}')">
          <div class="ci-name">${esc(c.name)} <span style="font-size:10px;color:#6b7fa8;font-family:monospace;">${esc(c.customer_id)}</span></div>
          <div class="ci-sub">${esc(c.phone||'–')} · ${esc(c.package?.name||'Tanpa paket')} ${c.package?.price ? '· Rp '+Number(c.package.price).toLocaleString('id-ID') : ''}</div>
        </div>`
      ).join('');
    }
    dd.style.display = 'block';
  }, 250);
}
window.searchCustomers = searchCustomers;

window.selectCustomer = async function(id, name, cid, phone, billingDay, price, pkgName, dueDate) {
  _selCust = { id, name, cid, phone, billingDay, price, pkgName, dueDate };
  document.getElementById('custSearch').value = name + ' (' + cid + ')';
  document.getElementById('selectedCustId').value = id;
  closeCustDropdown();

  // Auto-fill amount from package price
  if (price > 0) {
    document.getElementById('payAmount').value = Number(price).toLocaleString('id-ID');
  }

  // Auto-calculate due date:
  // Default = jatuh tempo ASLI customer + 1 bulan (mis. 1 Mei -> 1 Juni).
  // Kalau customer belum punya due_date tersimpan, fallback ke billing_date.
  // Field tetap bisa diedit manual oleh admin.
  setDefaultDueDate(billingDay, dueDate);

  // Cek apakah periode ini sudah lunas
  const pm = document.getElementById('payPeriodMonth')?.value;
  const py = document.getElementById('payPeriodYear')?.value;
  await checkAlreadyPaid(id, pm, py);

  // Show info
  const info = document.getElementById('custInfo');
  if (info) {
    const dueAsliFmt = dueDate
      ? new Date(dueDate + 'T00:00:00').toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' })
      : '–';
    info.style.display = 'block';
    info.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<div>' +
          '<div style="font-weight:700;color:#0d1b3e;">' + esc(name) + '</div>' +
          '<div style="color:#6b7fa8;">' + esc(cid) + ' · ' + esc(phone||'–') + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-weight:600;color:#1a6ef5;">' + esc(pkgName||'–') + '</div>' +
          '<div style="color:#6b7fa8;">Jatuh tempo: ' + dueAsliFmt + '</div>' +
        '</div>' +
      '</div>';
  }
};

async function checkAlreadyPaid(custId, month, year) {
  if (!custId || !month || !year) return;
  const submitBtn = document.getElementById('submitBtn');
  const warn = document.getElementById('paidWarning');
  if (warn) warn.innerHTML = '';   // bersihkan warning periode sebelumnya

  // Cek via API: apakah ada invoice paid untuk customer+periode YANG DIPILIH
  const d = await App.api('/payments/check-paid?customer_id=' + custId + '&month=' + month + '&year=' + year);
  if (d?.paid) {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.background = 'linear-gradient(135deg,#94a3b8,#64748b)';
      submitBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636"/></svg> Sudah Lunas Periode Ini';
    }
    if (warn) {
      const paidDateFmt = d.paid_date
        ? new Date(d.paid_date + 'T00:00:00').toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })
        : '–';
      const monthName = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][parseInt(month)] || month;
      warn.innerHTML =
        '<div style="margin-top:8px;padding:10px 12px;background:#fef3c7;border:1.5px solid #fde68a;border-radius:8px;display:flex;align-items:center;gap:8px;">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#d97706" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>' +
          '<div>' +
            '<div style="font-size:12.5px;font-weight:700;color:#92400e;">Periode ' + monthName + ' ' + year + ' sudah lunas</div>' +
            '<div style="font-size:11px;color:#b45309;">Dibayar: ' + paidDateFmt + ' · ' + esc(d.invoice_number||'–') + ' — ganti Bulan/Tahun untuk periode lain</div>' +
          '</div>' +
        '</div>';
    }
  } else {
    // Periode dipilih BELUM lunas → aktifkan tombol
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.style.background = '';
      submitBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Catat Pembayaran';
    }
  }
}

function closeCustDropdown() {
  const dd = document.getElementById('custDropdown');
  if (dd) dd.style.display = 'none';
}

// ── METHOD SELECT ─────────────────────────────────────────────
window.selectMethod = function(el, method) {
  document.querySelectorAll('.mpill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  _payMethod = method;
  document.getElementById('payMethod').value = method;
  // Show/hide bank field
  const bankField = document.getElementById('bankField');
  if (bankField) bankField.style.display = method === 'transfer' ? 'block' : 'none';
};

// ── FORMAT AMOUNT ─────────────────────────────────────────────
window.formatAmount = function(el) {
  const raw = el.value.replace(/\D/g, '');
  el.value = raw ? Number(raw).toLocaleString('id-ID') : '';
};

// ── SUBMIT ────────────────────────────────────────────────────
window.submitPayment = async function() {
  const custId = document.getElementById('selectedCustId')?.value;
  const rawAmt = document.getElementById('payAmount')?.value?.replace(/\D/g,'') || '0';
  const amount = parseInt(rawAmt);
  const dueDate= document.getElementById('payDueDate')?.value;

  if (!custId)   { App.showToast('Pilih pelanggan terlebih dahulu', 'error'); return; }
  if (!amount)   { App.showToast('Masukkan jumlah pembayaran', 'error'); return; }
  if (!dueDate)  { App.showToast('Masukkan tanggal jatuh tempo baru', 'error'); return; }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Menyimpan...';

  const body = {
    customer_id:  custId,
    amount,
    payment_date: document.getElementById('payDate')?.value,
    method:       _payMethod,
    bank:         document.getElementById('payBank')?.value || '',
    reference_no: document.getElementById('payRef')?.value || '',
    due_date_after: dueDate,
    send_wa:      document.getElementById('paySendWa')?.checked ? 1 : 0,
    send_email:   document.getElementById('paySendEmail')?.checked ? 1 : 0,
    notes:        document.getElementById('payNotes')?.value || '',
    period_month: document.getElementById('payPeriodMonth')?.value,
    period_year:  document.getElementById('payPeriodYear')?.value,
  };

  const d = await App.api('/payments/record', { method:'POST', body: JSON.stringify(body) });

  btn.disabled = false;
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Catat Pembayaran';

  if (d?.success) {
    // Show success banner
    const banner = document.getElementById('successBanner');
    const msgEl  = document.getElementById('successMsg');
    const invEl  = document.getElementById('successInvNum');
    if (banner) banner.style.display = 'block';
    if (msgEl)  msgEl.textContent  = d.message;
    if (invEl)  invEl.textContent  = 'Invoice: ' + (d.data?.invoice_number || '–') + ' · Due date baru: ' + (d.data?.due_date_after || '–');
    setTimeout(() => { if (banner) banner.style.display = 'none'; }, 8000);

    // Reset form
    resetForm();

    // Reload data
    _payPage = 1;
    loadStats();
    loadChart();
    loadPayments();
    App.showToast(d.message, 'success');
  } else {
    if (d?.already_paid) {
      App.showToast('⚠️ ' + (d?.message || 'Sudah lunas periode ini'), 'error');
      // Re-disable tombol
      btn.disabled = true;
      btn.style.background = 'linear-gradient(135deg,#94a3b8,#64748b)';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636"/></svg> Sudah Lunas Periode Ini';
    } else {
      App.showToast(d?.message || 'Gagal menyimpan pembayaran', 'error');
    }
  }
};

function resetForm() {
  document.getElementById('custSearch').value = '';
  document.getElementById('selectedCustId').value = '';
  document.getElementById('custInfo').style.display = 'none';
  document.getElementById('payAmount').value = '';
  document.getElementById('payRef').value = '';
  document.getElementById('payNotes').value = '';
  document.getElementById('payBank').value = '';
  _selCust = null;
  // Reset method to cash
  document.querySelectorAll('.mpill').forEach(p => p.classList.remove('active'));
  document.querySelector('.mpill')?.classList.add('active');
  _payMethod = 'cash';
  document.getElementById('payMethod').value = 'cash';
  document.getElementById('bankField').style.display = 'none';
  // Reset dates
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('payDate').value = today;
  setDefaultDueDate(1);
}

// ── DELETE ────────────────────────────────────────────────────
window.deletePayment = async function(id, name) {
  const res = await payConfirm({
    variant: 'warn',
    title: 'Hapus Pembayaran',
    message: 'Hapus pembayaran <b>' + esc(name) + '</b>?<br>Invoice dikembalikan ke status <b>unpaid</b>, due date direset, dan bukti transfer (termasuk file di server) ikut dihapus.',
    okText: 'Ya, Hapus'
  });
  if (res === null) return;
  const d = await App.api('/payments/' + id, { method:'DELETE' });
  if (d?.success) {
    App.showToast(d.message, 'success');
    loadStats(); loadChart(); loadPayments();
    // Bukti transfer terkait ikut terhapus → refresh tab & badge.
    if (typeof loadProofs === 'function') loadProofs(_proofPage || 1);
    if (typeof refreshProofTabBadge === 'function') refreshProofTabBadge();
  } else App.showToast(d?.message || 'Gagal menghapus', 'error');
};

window.openInvoice = function(paymentId) {
  window.open('/invoice/' + paymentId, '_blank');
};

// ── FILTER CHANGE ─────────────────────────────────────────────
window.onFilterChange = function() {
  _payPage = 1;
  loadStats();
  loadChart();
  loadPayments();
  // Recheck paid status jika customer sudah dipilih
  const custId = document.getElementById('selectedCustId')?.value;
  const pm = document.getElementById('payPeriodMonth')?.value;
  const py = document.getElementById('payPeriodYear')?.value;
  if (custId && pm && py) {
    // Reset info dulu lalu recheck
    const info = document.getElementById('custInfo');
    if (info && _selCust) {
      info.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<div><div style="font-weight:700;color:#0d1b3e;">' + esc(_selCust.name) + '</div>' +
          '<div style="color:#6b7fa8;">' + esc(_selCust.cid) + ' · ' + esc(_selCust.phone||'–') + '</div></div>' +
          '<div style="text-align:right;"><div style="font-weight:600;color:#1a6ef5;">' + esc(_selCust.pkgName||'–') + '</div>' +
          '<div style="color:#6b7fa8;">Tgl tagihan: ' + _selCust.billingDay + '</div></div>' +
        '</div>';
    }
    checkAlreadyPaid(custId, pm, py);
  }
};

window.onSearchChange = function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { _payPage = 1; loadPayments(); }, 350);
};

// ── HELPERS ───────────────────────────────────────────────────
function setT(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setW(id, pct) { const el = document.getElementById(id); if (el) el.style.width = Math.min(Math.max(pct||2, 2), 100) + '%'; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// ════════════════════════════════════════════════════════════════
// TAB: RIWAYAT BUKTI TRANSFER (bukti pembayaran manual)
// ════════════════════════════════════════════════════════════════
let _proofPage = 1;
let _proofSearchTimer = null;
let _proofLoaded = false;

window.switchPayTab = function(tab) {
  const panePay = document.getElementById('tabPanelPay');
  const paneProof = document.getElementById('tabPanelProof');
  const btnPay = document.getElementById('tabBtnPay');
  const btnProof = document.getElementById('tabBtnProof');
  if (tab === 'proof') {
    if (panePay) panePay.style.display = 'none';
    if (paneProof) paneProof.style.display = 'block';
    if (btnPay) btnPay.classList.remove('pay-tab-active');
    if (btnProof) btnProof.classList.add('pay-tab-active');
    if (!_proofLoaded) { _proofLoaded = true; loadProofs(1); }
  } else {
    if (panePay) panePay.style.display = 'block';
    if (paneProof) paneProof.style.display = 'none';
    if (btnProof) btnProof.classList.remove('pay-tab-active');
    if (btnPay) btnPay.classList.add('pay-tab-active');
  }
};

window.onProofSearchChange = function() {
  clearTimeout(_proofSearchTimer);
  _proofSearchTimer = setTimeout(() => { loadProofs(1); }, 350);
};

async function loadProofs(page) {
  _proofPage = page || 1;
  const tbody = document.getElementById('proofTable');
  if (!tbody) return;
  const status = document.getElementById('proofStatusFilter')?.value || '';
  const search = document.getElementById('proofSearch')?.value || '';
  tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><p>Memuat data...</p></div></td></tr>';
  const d = await App.api('/billing/proofs?status=' + encodeURIComponent(status) +
    '&search=' + encodeURIComponent(search) + '&page=' + _proofPage + '&limit=20');
  if (!d || !d.success) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><p>Gagal memuat data</p></div></td></tr>';
    return;
  }
  renderProofRows(d.data || []);
  renderProofPagination(d.total || 0);
  refreshProofTabBadge();
}

function _proofStatusBadge(vs) {
  if (vs === 'verified') return '<span style="background:#dcfce7;color:#15803d;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:700;">Terverifikasi</span>';
  if (vs === 'rejected') return '<span style="background:#fee2e2;color:#b91c1c;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:700;">Ditolak</span>';
  return '<span style="background:#fef9c3;color:#a16207;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:700;">Menunggu</span>';
}

function renderProofRows(rows) {
  _proofRows = rows || [];
  const tbody = document.getElementById('proofTable');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="tbl-empty"><p>Belum ada bukti transfer</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function(p) {
    const cust = p.customer || {};
    const periode = (MONTHS[p.period_month] || '') + ' ' + (p.period_year || '');
    const when = p.proof_submitted_at ? new Date(p.proof_submitted_at).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '–';
    const fmtAmt = 'Rp ' + Number(p.total||0).toLocaleString('id-ID');
    const isPending = p.verification_status === 'submitted';
    const buktiBtn = p.has_proof
      ? '<button onclick="openProofModal(' + p.id + ')" style="padding:5px 11px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;color:#334155;font-size:11.5px;font-weight:700;cursor:pointer;">Lihat</button>'
      : '<span style="color:#cbd5e1;font-size:11px;">—</span>';
    let aksi = '<span style="color:#cbd5e1;font-size:11px;">—</span>';
    if (isPending) {
      aksi = '<div style="display:flex;gap:6px;">' +
        '<button onclick="verifyProofFromTab(' + p.id + ')" style="padding:5px 10px;border:none;border-radius:8px;background:#16a34a;color:#fff;font-size:11.5px;font-weight:700;cursor:pointer;">Verifikasi</button>' +
        '<button onclick="rejectProofFromTab(' + p.id + ')" style="padding:5px 10px;border:1px solid #fecaca;border-radius:8px;background:#fff;color:#dc2626;font-size:11.5px;font-weight:700;cursor:pointer;">Tolak</button>' +
        '</div>';
    }
    return '<tr>' +
      '<td><div style="font-weight:700;color:#0d1b3e;">' + esc(cust.name||'-') + '</div>' +
        '<div style="font-size:11px;color:#94a3b8;">' + esc(cust.customer_id||'-') + '</div></td>' +
      '<td style="font-size:12px;">' + esc(periode.trim()||'-') + '</td>' +
      '<td style="font-size:12px;font-family:monospace;color:#64748b;">' + esc(p.invoice_number||'-') + '</td>' +
      '<td style="font-weight:700;color:#1a6ef5;font-size:13px;font-family:monospace;">' + fmtAmt + '</td>' +
      '<td>' + _proofStatusBadge(p.verification_status) + '</td>' +
      '<td style="font-size:11.5px;color:#64748b;">' + when + '</td>' +
      '<td>' + buktiBtn + '</td>' +
      '<td>' + aksi + '</td>' +
    '</tr>';
  }).join('');
}

function renderProofPagination(total) {
  const el = document.getElementById('proofPagination');
  if (!el) return;
  const totalPages = Math.ceil(total / 20);
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += '<button onclick="loadProofs(' + i + ')" class="' + (i === _proofPage ? 'active' : '') + '">' + i + '</button>';
  }
  el.innerHTML = html;
}

// ── Detail Bukti Transfer Modal ───────────────────────────────
function _findProof(id) { return _proofRows.find(function(p){ return p.id === id; }); }

window.openProofModal = function(id) {
  const p = _findProof(id);
  if (!p) return;
  const modal = document.getElementById('proofModal');
  const cust = p.customer || {};
  const periode = ((MONTHS[p.period_month] || '') + ' ' + (p.period_year || '')).trim();
  const when = p.proof_submitted_at
    ? new Date(p.proof_submitted_at).toLocaleString('id-ID', { day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : '–';

  setT('pmInvNo', p.invoice_number || '—');
  setT('pmAmount', 'Rp ' + Number(p.total || 0).toLocaleString('id-ID'));
  setT('pmCustName', cust.name || '—');
  setT('pmCustId', cust.customer_id || '—');
  setT('pmCustPhone', cust.phone || '—');
  setT('pmInvoice', p.invoice_number || '—');
  setT('pmPeriode', periode || '—');
  setT('pmUploaded', when);

  // Status pill (inside the dark amount card)
  const stWrap = document.getElementById('pmStatusWrap');
  if (stWrap) {
    if (p.verification_status === 'verified')      stWrap.innerHTML = '<span class="pm-st pm-st-ok">Terverifikasi</span>';
    else if (p.verification_status === 'rejected') stWrap.innerHTML = '<span class="pm-st pm-st-no">Ditolak</span>';
    else                                           stWrap.innerHTML = '<span class="pm-st pm-st-wait">Menunggu verifikasi</span>';
  }

  // Note row
  const noteRow = document.getElementById('pmNoteRow');
  if (noteRow) {
    if (p.proof_note) { noteRow.style.display = 'flex'; setT('pmNote', p.proof_note); }
    else noteRow.style.display = 'none';
  }

  // Image — cek dulu apakah respons benar2 file gambar; kalau tidak,
  // tampilkan empty-state rapi (bukan JSON error mentah).
  const frame = document.getElementById('pmImgFrame');
  const openLink = document.getElementById('pmImgOpen');
  const url = '/api/billing/invoices/' + id + '/proof';
  if (openLink) openLink.href = url;
  loadProofImage(frame, openLink, url);

  // Action buttons — only when pending
  const actions = document.getElementById('pmActions');
  if (actions) {
    if (p.verification_status === 'submitted') {
      actions.style.display = 'flex';
      document.getElementById('pmVerifyBtn').onclick = function(){ verifyProofFromTab(id); };
      document.getElementById('pmRejectBtn').onclick = function(){ rejectProofFromTab(id); };
    } else {
      actions.style.display = 'none';
    }
  }

  modal.classList.add('open');
};

window.closeProofModal = function() {
  const modal = document.getElementById('proofModal');
  if (modal) modal.classList.remove('open');
  const frame = document.getElementById('pmImgFrame');
  if (frame) {
    if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
    frame.innerHTML = '<div class="pm-img-loading">Memuat gambar…</div>';
  }
};

// Empty-state rapi saat bukti tidak tersedia / gagal dimuat.
function _proofEmptyState(msg) {
  return '<div class="pm-img-empty">' +
    '<div class="pm-img-empty-icn">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6">' +
      '<path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16M4 6a0 0 0 000 0m0 0v12a2 2 0 002 2h12a2 2 0 002-2V6"/>' +
      '<line x1="3" y1="3" x2="21" y2="21" stroke-linecap="round"/></svg>' +
    '</div>' +
    '<div class="pm-img-empty-ttl">Bukti tidak tersedia</div>' +
    '<div class="pm-img-empty-sub">' + esc(msg || 'File bukti tidak ditemukan di server.') + '</div>' +
  '</div>';
}

async function loadProofImage(frame, openLink, url) {
  if (!frame) return;
  if (frame._objUrl) { URL.revokeObjectURL(frame._objUrl); frame._objUrl = null; }
  frame.innerHTML = '<div class="pm-img-loading">Memuat gambar…</div>';
  frame.classList.remove('is-empty');
  try {
    const res = await fetch(url, { headers: { 'Accept': 'image/*,application/pdf' } });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || ct.includes('application/json') || ct.includes('text/')) {
      // Server balikin error JSON (file hilang / tidak valid) → empty-state.
      let msg = 'File bukti tidak ditemukan di server.';
      try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (_) {}
      frame.classList.add('is-empty');
      frame.innerHTML = _proofEmptyState(msg);
      if (openLink) openLink.style.display = 'none';
      return;
    }
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    frame._objUrl = obj;
    if (openLink) { openLink.style.display = 'inline-flex'; openLink.href = obj; }
    if (ct.includes('pdf')) {
      frame.innerHTML = '<iframe src="' + obj + '"></iframe>';
    } else {
      frame.innerHTML = '<img src="' + obj + '" alt="Bukti pembayaran">';
    }
  } catch (e) {
    frame.classList.add('is-empty');
    frame.innerHTML = _proofEmptyState('Gagal memuat bukti. Periksa koneksi atau coba lagi.');
    if (openLink) openLink.style.display = 'none';
  }
}

// ── Custom confirm/reject dialog ──────────────────────────────
let _pcResolve = null;
/**
 * payConfirm({ variant, title, message, okText, showWa, waText, input, inputLabel, inputPlaceholder })
 * → Promise. Resolves with the input string (or '' ) on OK, or null on cancel.
 */
function payConfirm(opts) {
  opts = opts || {};
  const overlay = document.getElementById('payConfirm');
  const icn = document.getElementById('pcIcn');
  const ok  = document.getElementById('pcOk');
  const field = document.getElementById('pcField');
  const input = document.getElementById('pcInput');
  const wa = document.getElementById('pcWa');

  const variant = opts.variant === 'warn' ? 'warn' : 'ok';
  icn.className = 'pc-icn ' + variant;
  icn.innerHTML = variant === 'warn'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

  setT('pcTitle', opts.title || 'Konfirmasi');
  document.getElementById('pcMsg').innerHTML = opts.message || '';
  setT('pcOk', opts.okText || 'OK');
  ok.className = 'pc-btn ' + (variant === 'warn' ? 'is-warn' : 'is-ok');

  if (opts.input) {
    field.style.display = 'block';
    input.value = '';
    setT('pcFieldLbl', opts.inputLabel || 'Catatan');
    input.placeholder = opts.inputPlaceholder || 'Opsional…';
  } else {
    field.style.display = 'none';
  }

  if (opts.showWa) {
    wa.style.display = 'flex';
    setT('pcWaTxt', opts.waText || 'Kirim notifikasi WhatsApp ke pelanggan');
    const chk = document.getElementById('pcWaCheck');
    if (chk) {
      chk.checked = true;
      wa.classList.remove('off');
      chk.onchange = function(){ wa.classList.toggle('off', !chk.checked); };
    }
  } else {
    wa.style.display = 'none';
  }

  overlay.classList.add('open');
  if (opts.input) setTimeout(function(){ input.focus(); }, 50);

  return new Promise(function(resolve){ _pcResolve = resolve; });
}
window.payConfirmOk = function() {
  const overlay = document.getElementById('payConfirm');
  const val = document.getElementById('pcInput').value || '';
  const waVisible = document.getElementById('pcWa').style.display !== 'none';
  const sendWa = waVisible ? !!document.getElementById('pcWaCheck').checked : false;
  overlay.classList.remove('open');
  if (_pcResolve) { _pcResolve({ value: val, sendWa: sendWa }); _pcResolve = null; }
};
window.payConfirmCancel = function() {
  const overlay = document.getElementById('payConfirm');
  overlay.classList.remove('open');
  if (_pcResolve) { _pcResolve(null); _pcResolve = null; }
};

window.verifyProofFromTab = async function(id) {
  const res = await payConfirm({
    variant: 'ok',
    title: 'Verifikasi Pembayaran',
    message: 'Verifikasi bukti transfer ini dan tandai invoice sebagai <b>LUNAS</b>?',
    okText: 'Ya, Verifikasi',
    showWa: true,
    waText: 'Kirim notifikasi WhatsApp ke pelanggan'
  });
  if (res === null) return;
  const r = await App.api('/billing/invoices/' + id + '/proof/verify', { method: 'POST', body: JSON.stringify({ method: 'transfer', send_wa: res.sendWa }) });
  if (r && r.success) {
    App.showToast(r.message || 'Invoice ditandai lunas', 'success');
    closeProofModal();
    loadProofs(_proofPage);
    if (typeof loadPayments === 'function') loadPayments();
  } else {
    App.showToast('Gagal: ' + ((r && r.message) || 'Error'), 'error');
  }
};

window.rejectProofFromTab = async function(id) {
  const res = await payConfirm({
    variant: 'warn',
    title: 'Tolak Bukti Transfer',
    message: 'Bukti pembayaran ini akan ditolak. Pelanggan dapat mengunggah ulang bukti yang benar.',
    okText: 'Tolak Bukti',
    input: true,
    inputLabel: 'Alasan penolakan',
    inputPlaceholder: 'mis. Nominal tidak sesuai, gambar tidak jelas… (opsional)'
  });
  if (res === null) return; // batal
  const r = await App.api('/billing/invoices/' + id + '/proof/reject', { method: 'POST', body: JSON.stringify({ note: res.value }) });
  if (r && r.success) {
    App.showToast(r.message || 'Bukti ditolak', 'success');
    closeProofModal();
    loadProofs(_proofPage);
  } else {
    App.showToast('Gagal: ' + ((r && r.message) || 'Error'), 'error');
  }
};

async function refreshProofTabBadge() {
  try {
    const d = await App.api('/billing/pending-proofs');
    const n = (d && d.success && Array.isArray(d.data)) ? d.data.length : 0;
    const badge = document.getElementById('proofTabBadge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = n > 0 ? 'inline-block' : 'none';
    }
  } catch (_) {}
}

// Muat badge jumlah pending saat halaman dibuka (tanpa harus klik tab).
document.addEventListener('DOMContentLoaded', function() { setTimeout(refreshProofTabBadge, 400); });

// Tutup modal dengan tombol Escape
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  const pc = document.getElementById('payConfirm');
  if (pc && pc.classList.contains('open')) { payConfirmCancel(); return; }
  const pm = document.getElementById('proofModal');
  if (pm && pm.classList.contains('open')) { closeProofModal(); }
});
