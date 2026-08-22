// FLAYNET.Com invoice-broadcast.js — Broadcast Invoice via Email
// Mengelola: format email invoice (sinkron dgn Settings via key invoice_email_*),
// preview live, daftar invoice, pilih & kirim massal via send-email-bulk.

// ── Helpers ───────────────────────────────────────────────────
function _setText(id, v){ const e=document.getElementById(id); if(e) e.textContent=v; }
function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }
function _toast(msg,type){ if(typeof App!=='undefined'&&App.showToast) App.showToast(msg,type||'info'); else alert(msg); }
function _fmtRp(n){ return 'Rp ' + Number(n||0).toLocaleString('id-ID'); }

const ID_MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// Default format (mirror dari backend INVOICE_EMAIL_DEFAULTS)
const FMT_DEFAULTS = {
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

let _fmt = { ...FMT_DEFAULTS };   // nilai format terkini (per-key)
let _fmtStatus = 'unpaid';        // tab format yang sedang diedit
let _attachReceipt = true;
let _baseUrl = '';
let _lastInvoices = [];
let _page = 1;
let _perPage = 20;
let _pageInfo = { total: 0, totalPages: 1 };
let _selected = new Set();        // invoice id terpilih (punya email)
let _refreshTimer = null;

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadSmtp();
  loadFormat();
  loadStats();
  loadInvoices();
  _refreshTimer = setInterval(() => { loadStats(); }, 20000);
});

// ── SMTP config (sinkron dgn Settings, key sama persis) ───────
let _smtpEnabled = false;
async function loadSmtp(){
  try{
    const d = await App.api('/app-settings');
    const s = (d && d.success) ? (d.data||{}) : {};
    _smtpEnabled = s.smtp_enabled === '1';
    document.getElementById('smtpEnabled').checked = _smtpEnabled;
    document.getElementById('smtpHost').value = s.smtp_host || '';
    document.getElementById('smtpPort').value = s.smtp_port || '587';
    document.getElementById('smtpUser').value = s.smtp_user || '';
    document.getElementById('smtpPass').value = s.smtp_pass || '';
    document.getElementById('smtpFrom').value = s.smtp_from || '';
    document.getElementById('smtpFromName').value = s.smtp_from_name || s.app_name || '';
    document.getElementById('smtpSecure').value = s.smtp_secure === '1' ? '1' : '0';
    onSmtpToggle();
    updateSmtpChip(_smtpEnabled && s.smtp_host && s.smtp_user);
  }catch(_){}
}
function onSmtpToggle(){
  const on = document.getElementById('smtpEnabled').checked;
  document.getElementById('smtpFields').style.opacity = on ? '1' : '.5';
  document.getElementById('smtpFields').style.pointerEvents = on ? 'auto' : 'none';
}
function updateSmtpChip(active){
  const chip = document.getElementById('smtpStatusChip');
  if(chip){
    if(active){ chip.textContent = 'Aktif'; chip.className = 'ib-pill green'; }
    else { chip.textContent = 'Belum Aktif'; chip.className = 'ib-pill amber'; }
  }
  const dot = document.getElementById('smtpDot');
  if(dot) dot.style.background = active ? '#16a34a' : '#f59e0b';
}
function openSmtpModal(){ document.getElementById('smtpModal').classList.add('open'); }
function closeSmtpModal(){ document.getElementById('smtpModal').classList.remove('open'); }
function _smtpPayload(){
  return {
    smtp_enabled: document.getElementById('smtpEnabled').checked ? '1' : '0',
    smtp_host: document.getElementById('smtpHost').value.trim(),
    smtp_port: document.getElementById('smtpPort').value || '587',
    smtp_user: document.getElementById('smtpUser').value.trim(),
    smtp_pass: document.getElementById('smtpPass').value,
    smtp_from: document.getElementById('smtpFrom').value.trim(),
    smtp_from_name: document.getElementById('smtpFromName').value.trim(),
    smtp_secure: document.getElementById('smtpSecure').value,
  };
}
async function saveSmtp(){
  const btn = document.getElementById('btnSaveSmtp');
  if(btn) btn.disabled = true;
  try{
    const payload = _smtpPayload();
    const d = await App.api('/app-settings', { method:'POST', body: JSON.stringify(payload) });
    if(d?.success){
      _toast('Pengaturan SMTP disimpan & disinkronkan', 'success');
      updateSmtpChip(payload.smtp_enabled==='1' && payload.smtp_host && payload.smtp_user);
      closeSmtpModal();
    } else _toast(d?.message || 'Gagal menyimpan', 'error');
  } finally { if(btn) btn.disabled = false; }
}
async function testSmtp(){
  const btn = document.getElementById('btnTestSmtp');
  if(btn) btn.disabled = true;
  try{
    // Simpan dulu agar konfigurasi terbaru dipakai saat test
    await App.api('/app-settings', { method:'POST', body: JSON.stringify(_smtpPayload()) });
    const to = document.getElementById('smtpUser').value.trim();
    const d = await App.api('/app-settings/test-email', { method:'POST', body: JSON.stringify({ to }) });
    _toast(d?.message || (d?.success ? 'Email test terkirim' : 'Gagal kirim test'), d?.success ? 'success' : 'error');
  } finally { if(btn) btn.disabled = false; }
}

// ── Stats + clickable cards ───────────────────────────────────
async function loadStats(){
  const d = await App.api('/billing/invoice-email/stats');
  if(!d?.success) return;
  const s = d.data;
  _setText('stUnpaid', (s.unpaid||0).toLocaleString('id-ID'));
  _setText('stOverdue', (s.overdue||0).toLocaleString('id-ID'));
  _setText('stPaid', (s.paid||0).toLocaleString('id-ID'));
  _setText('stCoverage', (s.customers_with_email||0).toLocaleString('id-ID'));
}
function ibCardClick(el){
  document.querySelectorAll('.ib-card[data-filter]').forEach(c=>c.classList.remove('xc-active'));
  el.classList.add('xc-active');
  const f = el.dataset.filter || '';
  const sel = document.getElementById('statusFilter');
  if(sel && f !== '__coverage'){ sel.value = f; _page = 1; loadInvoices(); }
}

// ── Format: load dari app-settings (saling sinkron dgn Settings) ──
async function loadFormat(){
  try{
    const d = await App.api('/app-settings');
    const s = (d && d.success) ? (d.data||{}) : {};
    Object.keys(FMT_DEFAULTS).forEach(k=>{
      const v = s['invoice_email_'+k];
      _fmt[k] = (v===undefined||v===null||v==='') ? FMT_DEFAULTS[k] : v;
    });
    // Toggle lampiran PDF mengikuti Settings (default ON)
    _attachReceipt = (s.email_attach_receipt===undefined||s.email_attach_receipt===''||s.email_attach_receipt==='1');
    _baseUrl = s.public_base_url || '';
  }catch(_){ _fmt = { ...FMT_DEFAULTS }; }
  fillFormatForm();
  renderPreview();
}

function fillFormatForm(){
  const st = _fmtStatus;
  document.getElementById('fSubject').value = _fmt['subject_'+st] || '';
  document.getElementById('fHeader').value  = _fmt['header_'+st]  || '';
  document.getElementById('fIntro').value   = _fmt['intro_'+st]   || '';
  document.getElementById('fFooter').value  = _fmt.footer_note    || '';
  document.getElementById('fAttach').checked    = !!_attachReceipt;
  document.getElementById('fShowBank').checked  = _fmt.show_bank !== '0';
  document.getElementById('fShowPaybtn').checked= _fmt.show_paybtn === '1';
  document.getElementById('fPaybtnLabel').value = _fmt.paybtn_label || 'Bayar Sekarang';
  document.getElementById('fBaseUrl').value = _baseUrl || '';
  document.getElementById('paybtnExtra').style.display = _fmt.show_paybtn==='1' ? 'block' : 'none';
}

// Tarik nilai form → _fmt (untuk status yang sedang diedit)
function gatherFormat(){
  const st = _fmtStatus;
  _fmt['subject_'+st] = document.getElementById('fSubject').value;
  _fmt['header_'+st]  = document.getElementById('fHeader').value;
  _fmt['intro_'+st]   = document.getElementById('fIntro').value;
  _fmt.footer_note    = document.getElementById('fFooter').value;
  _fmt.show_bank      = document.getElementById('fShowBank').checked ? '1' : '0';
  _fmt.show_paybtn    = document.getElementById('fShowPaybtn').checked ? '1' : '0';
  _fmt.paybtn_label   = document.getElementById('fPaybtnLabel').value;
  _attachReceipt      = document.getElementById('fAttach').checked;
  _baseUrl            = document.getElementById('fBaseUrl').value.trim();
}

function setFmtStatus(st, el){
  gatherFormat();               // simpan dulu yang sedang diedit
  _fmtStatus = st;
  document.querySelectorAll('#fmtSeg button').forEach(b=>b.classList.toggle('active', b.dataset.st===st));
  fillFormatForm();
  renderPreview();
}

function onPaybtnToggle(){
  document.getElementById('paybtnExtra').style.display = document.getElementById('fShowPaybtn').checked ? 'block' : 'none';
  schedulePreview();
}

function insertVar(targetId, token){
  const el = document.getElementById(targetId);
  if(!el) return;
  const s=el.selectionStart||el.value.length, e=el.selectionEnd||el.value.length;
  el.value = el.value.slice(0,s) + token + el.value.slice(e);
  el.focus(); el.selectionStart = el.selectionEnd = s + token.length;
  schedulePreview();
}

const schedulePreview = _debounce(renderPreview, 350);

// ── Preview (pakai endpoint backend agar 1:1 dgn email asli) ──
async function renderPreview(){
  gatherFormat();
  const hint = document.getElementById('previewHint');
  if(hint) hint.textContent = 'Memperbarui...';
  try{
    const d = await App.api('/billing/invoice-email/preview?status='+_fmtStatus, {
      method:'POST',
      body: JSON.stringify({ status:_fmtStatus, format:_fmt })
    });
    if(d?.success){
      _setText('pvSubject', d.data.subject || '-');
      const f = document.getElementById('pvFrame');
      if(f) f.srcdoc = d.data.html || '';
      if(hint) hint.textContent = _fmtStatus==='paid' ? 'Contoh: kwitansi lunas' : 'Contoh: tagihan belum lunas';
    }
  }catch(_){ if(hint) hint.textContent='Gagal memuat preview'; }
}

// ── Simpan format → app-settings (sinkron ke Settings) ──
async function saveFormat(){
  gatherFormat();
  const payload = {};
  Object.keys(FMT_DEFAULTS).forEach(k=>{ payload['invoice_email_'+k] = _fmt[k]; });
  payload.email_attach_receipt = _attachReceipt ? '1' : '0';
  payload.public_base_url = _baseUrl;
  const btn = document.getElementById('btnSaveFmt');
  if(btn) btn.disabled = true;
  try{
    const d = await App.api('/app-settings', { method:'POST', body: JSON.stringify(payload) });
    _toast(d?.success ? 'Format email invoice disimpan & disinkronkan' : (d?.message||'Gagal menyimpan'), d?.success?'success':'error');
  } finally { if(btn) btn.disabled = false; }
}

function resetFormat(){
  _fmt = { ...FMT_DEFAULTS };
  fillFormatForm();
  renderPreview();
  _toast('Format dikembalikan ke default (belum disimpan)', 'info');
}

// ── Daftar invoice ────────────────────────────────────────────
const searchDebounced = _debounce(() => { _page = 1; loadInvoices(); }, 400);

async function loadInvoices(){
  const status = document.getElementById('statusFilter')?.value || '';
  const search = document.getElementById('searchBox')?.value?.trim() || '';
  const tbody = document.getElementById('invTable');
  const cards = document.getElementById('invCards');
  const sub = document.getElementById('listSub');
  let url = '/billing/invoices?limit=' + _perPage + '&page=' + _page;
  if(status) url += '&status='+encodeURIComponent(status);
  if(search) url += '&search='+encodeURIComponent(search);
  const d = await App.api(url);
  if(!d?.success){
    if(tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="tbl-empty" style="color:#dc2626;">Gagal memuat data</div></td></tr>';
    return;
  }
  _lastInvoices = (d.data || d.invoices || []);
  _pageInfo = d.pagination || { total: _lastInvoices.length, totalPages: 1, page: _page };
  // Catatan: pilihan dipertahankan lintas halaman (paginasi), tidak dibersihkan
  // hanya karena invoice tidak ada di halaman aktif.

  if(sub){
    const total = _pageInfo.total ?? _lastInvoices.length;
    sub.textContent = total + ' invoice' + (search?` · cari "${search}"`:'');
  }
  renderInvoiceList();
  renderPagination();
  updateSelCount();
}

function gotoPage(p){
  const tp = _pageInfo.totalPages || 1;
  if(p < 1 || p > tp || p === _page) return;
  _page = p;
  loadInvoices();
  const panel = document.querySelector('.panel .list-hdr');
  if(panel) panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function renderPagination(){
  const el = document.getElementById('invPagination');
  if(!el) return;
  const tp = _pageInfo.totalPages || 1;
  const cur = _pageInfo.page || _page;
  const total = _pageInfo.total ?? _lastInvoices.length;
  if(total === 0){ el.innerHTML = ''; return; }
  const from = (cur - 1) * _perPage + 1;
  const to = Math.min(cur * _perPage, total);

  // Window halaman (maks 5 nomor)
  let start = Math.max(1, cur - 2);
  let end = Math.min(tp, start + 4);
  start = Math.max(1, end - 4);
  let nums = '';
  for(let i = start; i <= end; i++){
    nums += `<button class="pg-btn${i===cur?' active':''}" onclick="gotoPage(${i})">${i}</button>`;
  }

  el.innerHTML =
    `<div class="pg-info">Menampilkan <b>${from}–${to}</b> dari <b>${total}</b></div>`+
    `<div class="pg-nav">`+
      `<button class="pg-btn" ${cur<=1?'disabled':''} onclick="gotoPage(${cur-1})" title="Sebelumnya">‹</button>`+
      (start>1 ? `<button class="pg-btn" onclick="gotoPage(1)">1</button>${start>2?'<span class="pg-dots">…</span>':''}` : '')+
      nums+
      (end<tp ? `${end<tp-1?'<span class="pg-dots">…</span>':''}<button class="pg-btn" onclick="gotoPage(${tp})">${tp}</button>` : '')+
      `<button class="pg-btn" ${cur>=tp?'disabled':''} onclick="gotoPage(${cur+1})" title="Berikutnya">›</button>`+
    `</div>`;
}

function _statusBadge(inv){
  const st = (inv.status||'').toLowerCase();
  const today = new Date().toISOString().slice(0,10);
  const isOverdue = (st==='unpaid'||st==='overdue') && inv.due_date && String(inv.due_date).slice(0,10) < today;
  if(st==='paid') return '<span class="st-badge st-paid">LUNAS</span>';
  if(isOverdue || st==='overdue') return '<span class="st-badge st-overdue">OVERDUE</span>';
  return '<span class="st-badge st-unpaid">BELUM LUNAS</span>';
}
function _periodTxt(inv){
  if(inv.period_month && inv.period_year) return (ID_MONTHS[inv.period_month]||inv.period_month)+' '+inv.period_year;
  return '-';
}

function renderInvoiceList(){
  const tbody = document.getElementById('invTable');
  const cards = document.getElementById('invCards');
  if(!_lastInvoices.length){
    const empty = '<div class="tbl-empty">Tidak ada invoice untuk filter ini.</div>';
    if(tbody) tbody.innerHTML = '<tr><td colspan="6">'+empty+'</td></tr>';
    if(cards) cards.innerHTML = empty;
    return;
  }
  const rowHtml = inv => {
    const email = inv.customer?.email || '';
    const hasEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const checked = _selected.has(inv.id) ? 'checked' : '';
    const checkCell = hasEmail
      ? `<input type="checkbox" class="ib-check" ${checked} onchange="toggleOne(${inv.id},this.checked)">`
      : `<span title="Tanpa email" style="opacity:.3;">—</span>`;
    return { hasEmail, email, checkCell, inv };
  };

  if(tbody) tbody.innerHTML = _lastInvoices.map(inv=>{
    const r = rowHtml(inv);
    return '<tr>'+
      '<td>'+r.checkCell+'</td>'+
      '<td style="font-family:\'DM Mono\',monospace;font-size:11.5px;font-weight:600;">'+_esc(inv.invoice_number||('#'+inv.id))+'</td>'+
      '<td><div style="font-weight:600;">'+_esc(inv.customer?.name||'-')+'</div>'+
        (r.hasEmail ? '<div style="font-size:10.5px;color:#94a3b8;">'+_esc(r.email)+'</div>' : '<div class="no-email">tanpa email</div>')+'</td>'+
      '<td style="font-size:12px;">'+_esc(_periodTxt(inv))+'</td>'+
      '<td style="font-weight:700;">'+_fmtRp(inv.total||inv.amount)+'</td>'+
      '<td>'+_statusBadge(inv)+'</td>'+
    '</tr>';
  }).join('');

  if(cards) cards.innerHTML = _lastInvoices.map(inv=>{
    const r = rowHtml(inv);
    return '<div class="ibc-item">'+
      '<div style="padding-top:2px;">'+r.checkCell+'</div>'+
      '<div style="min-width:0;flex:1;">'+
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">'+
          '<div style="font-family:\'DM Mono\',monospace;font-size:11px;font-weight:700;">'+_esc(inv.invoice_number||('#'+inv.id))+'</div>'+
          _statusBadge(inv)+
        '</div>'+
        '<div style="font-size:12.5px;font-weight:600;margin-top:3px;">'+_esc(inv.customer?.name||'-')+'</div>'+
        (r.hasEmail ? '<div style="font-size:10.5px;color:#94a3b8;">'+_esc(r.email)+'</div>' : '<div class="no-email" style="margin-top:2px;">tanpa email</div>')+
        '<div style="font-size:11px;color:#64748b;margin-top:4px;">'+_esc(_periodTxt(inv))+' · <b style="color:#0f172a;">'+_fmtRp(inv.total||inv.amount)+'</b></div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function toggleOne(id, on){
  if(on) _selected.add(id); else _selected.delete(id);
  updateSelCount();
  syncSelectAll();
}
function toggleAll(on){
  _lastInvoices.forEach(inv=>{
    const email = inv.customer?.email||'';
    const hasEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if(!hasEmail) return;
    if(on) _selected.add(inv.id); else _selected.delete(inv.id);
  });
  renderInvoiceList();
  updateSelCount();
}
function syncSelectAll(){
  const eligible = _lastInvoices.filter(inv=>{ const e=inv.customer?.email||''; return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); });
  const all = eligible.length>0 && eligible.every(inv=>_selected.has(inv.id));
  const sa = document.getElementById('selectAll'); if(sa) sa.checked = all;
}
function updateSelCount(){
  _setText('selCount', _selected.size + ' dipilih');
  const btn = document.getElementById('btnSend');
  if(btn) btn.disabled = _selected.size === 0;
  syncSelectAll();
}

// ── Kirim massal ──────────────────────────────────────────────
function openSendModal(){
  if(!_selected.size){ _toast('Pilih minimal 1 invoice', 'error'); return; }
  _setText('sendModalMsg', `Sistem akan mengirim ${_selected.size} invoice ke email pelanggan masing-masing${_attachReceipt?' dengan lampiran PDF':''}. Pengiriman dijeda otomatis untuk menghindari spam. Lanjutkan?`);
  document.getElementById('sendModal').classList.add('open');
}
function closeSendModal(){ document.getElementById('sendModal').classList.remove('open'); }

async function confirmSend(){
  closeSendModal();
  const ids = [..._selected];
  const btn = document.getElementById('btnSend');
  if(btn){ btn.disabled = true; btn.innerHTML = '<svg width="14" height="14" class="spin" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Mengirim...'; }
  try{
    const d = await App.api('/billing/invoices/send-email-bulk', {
      method:'POST',
      body: JSON.stringify({ invoice_ids: ids, attach_receipt: _attachReceipt ? 1 : 0 })
    });
    if(d?.success){
      _toast(d.message || 'Email terkirim', (d.summary && d.summary.failed) ? 'warning' : 'success');
      _selected.clear();
      loadInvoices(); loadStats();
    } else {
      _toast(d?.message || 'Gagal mengirim', 'error');
    }
  } finally {
    if(btn){ btn.disabled = _selected.size===0; btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg> Kirim Email'; }
    updateSelCount();
  }
}
