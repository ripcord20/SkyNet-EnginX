// FLAYNET.Com email-broadcast.js — Broadcast Email Manager
// Mengikuti pola broadcast.js (WA) dengan tambahan: kategori, subjek,
// preview email HTML branded, kirim test, dan detail modal.

// ── Helpers ───────────────────────────────────────────────────
function _setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function _toast(msg, type) { if (typeof App !== 'undefined' && App.showToast) App.showToast(msg, type || 'info'); else alert(msg); }

const CAT_LABEL = { gangguan:'Gangguan', maintenance:'Maintenance', promo:'Promo', billing:'Billing', info:'Info' };
const ST_LABEL  = { draft:'Draft', scheduled:'Terjadwal', running:'Berjalan', completed:'Selesai', cancelled:'Dibatalkan', failed:'Gagal' };

let _category   = 'info';
let _targetType = 'all';
let _customMode = 'manual';
let _pickedIds  = new Set();
let _cpLastResults = [];
let _refreshTimer  = null;
let _lastList = [];
let _area = { province:'', regency:'', district:'', village:'' };

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  checkSmtp();
  loadStats();
  loadBroadcasts();
  loadPackages();
  updateTargetCount();
  _refreshTimer = setInterval(() => { loadStats(); loadBroadcasts(true); }, 10000);
});

// ── SMTP status check ─────────────────────────────────────────
// Indikator dini: baca app_settings (key→value object). Validasi final
// tetap dilakukan server saat create broadcast.
async function checkSmtp() {
  try {
    const d = await App.api('/app-settings');
    if (!d?.success) return;
    const s = d.data || {};
    const enabled = s.smtp_enabled === '1' && s.smtp_host && s.smtp_user;
    const box = document.getElementById('smtpBox');
    if (box && !enabled) box.style.display = 'flex';
  } catch (_) { /* abaikan — validasi tetap di server */ }
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  const d = await App.api('/email-broadcast/stats');
  if (!d?.success) return;
  const s = d.data;
  _setText('stTotal', s.total || 0);
  _setText('stTotalPill', (s.completed || 0) + ' selesai');
  _setText('stSent', (s.total_sent || 0).toLocaleString('id-ID'));
  _setText('stRunning', (s.running || 0) + (s.scheduled || 0));
  _setText('stRunningPill', (s.running || 0) + ' run');
  _setText('stRunningSub', (s.running ? s.running + ' berjalan' : '') + (s.scheduled ? (s.running ? ' / ' : '') + s.scheduled + ' terjadwal' : '') || 'tidak ada');
  _setText('stCoverage', (s.customers_with_email || 0).toLocaleString('id-ID'));
}

// ── Stat card → filter riwayat ────────────────────────────────
// Pola identik halaman broadcast WA: kartu aktif berlatar biru, klik
// menyaring tabel riwayat. Kartu "coverage" hanya informatif (tampilkan semua).
function ebCardClick(el) {
  document.querySelectorAll('.eb-card[data-filter]').forEach(c => c.classList.remove('xc-active'));
  el.classList.add('xc-active');
  const f = el.dataset.filter || '';
  const sel = document.getElementById('filterStatus');
  if (sel) {
    sel.value = f === '__coverage' ? '' : f;
    loadBroadcasts();
  }
}

// ── List ──────────────────────────────────────────────────────
async function loadBroadcasts(silent = false) {
  const status   = document.getElementById('filterStatus')?.value || '';
  const category = document.getElementById('filterCategory')?.value || '';
  const d = await App.api('/email-broadcast/list?limit=30&status=' + encodeURIComponent(status) + '&category=' + encodeURIComponent(category));
  const tbody = document.getElementById('ebTable');
  const cards = document.getElementById('ebCards');
  const subEl = document.getElementById('ebListSub');

  if (!d?.success) {
    if (!silent && tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="tbl-empty"><p style="color:#dc2626;">Gagal memuat data</p></div></td></tr>';
    return;
  }
  _lastList = d.data || [];
  if (subEl) subEl.textContent = (d.total || 0) + ' broadcast';

  if (!_lastList.length) {
    const empty = '<div class="tbl-empty"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg><p>Belum ada broadcast email</p></div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="6">' + empty + '</td></tr>';
    if (cards) cards.innerHTML = empty;
    return;
  }

  if (tbody) tbody.innerHTML = _lastList.map(rowHtml).join('');
  if (cards) cards.innerHTML = _lastList.map(cardHtml).join('');
}

function progressHtml(bc) {
  const total = bc.total_targets || 0;
  const done  = (bc.total_sent || 0) + (bc.total_failed || 0);
  const pct   = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  return '<div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%;"></div></div>' +
    '<div class="prog-txt">' + (bc.total_sent || 0) + ' terkirim' + (bc.total_failed ? ' / ' + bc.total_failed + ' gagal' : '') + ' dari ' + total + '</div></div>';
}

function actionsHtml(bc) {
  let h = '';
  if (bc.status === 'draft' || bc.status === 'scheduled') {
    h += '<button class="act-btn" title="Kirim sekarang" onclick="sendNow(' + bc.id + ')"><svg width="12" height="12" fill="none" stroke="#16a34a" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg></button>';
  }
  if (['draft','scheduled','running'].includes(bc.status)) {
    h += '<button class="act-btn" title="Batalkan" onclick="cancelBc(' + bc.id + ')"><svg width="12" height="12" fill="none" stroke="#b45309" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg></button>';
  }
  h += '<button class="act-btn" title="Detail" onclick="openDetail(' + bc.id + ')"><svg width="12" height="12" fill="none" stroke="#1a6ef5" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></button>';
  if (['completed','cancelled','failed','draft'].includes(bc.status)) {
    h += '<button class="act-btn danger" title="Hapus" onclick="deleteBc(' + bc.id + ')"><svg width="12" height="12" fill="none" stroke="#dc2626" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>';
  }
  return h;
}

function rowHtml(bc) {
  const sched = bc.scheduled_at ? new Date(bc.scheduled_at).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '-';
  return '<tr>' +
    '<td><div style="font-weight:700;">' + _esc(bc.title) + '</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + _esc(bc.subject) + '</div>' +
      '<div style="font-size:10.5px;color:#cbd5e1;margin-top:1px;">' + sched + ' · ' + _esc(bc.created_by_name || '-') + '</div></td>' +
    '<td><span class="cat-badge cat-' + bc.category + '">' + (CAT_LABEL[bc.category] || bc.category) + '</span></td>' +
    '<td style="font-size:12px;">' + (bc.total_targets || 0) + ' email<div style="font-size:10.5px;color:#94a3b8;">' + _esc(bc.target_type) + '</div></td>' +
    '<td>' + progressHtml(bc) + '</td>' +
    '<td><span class="st-badge st-' + bc.status + '">' + (ST_LABEL[bc.status] || bc.status) + '</span></td>' +
    '<td style="text-align:right;white-space:nowrap;">' + actionsHtml(bc) + '</td>' +
  '</tr>';
}

function cardHtml(bc) {
  return '<div class="ebc-item">' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">' +
      '<div style="min-width:0;"><div style="font-weight:700;font-size:13px;">' + _esc(bc.title) + '</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(bc.subject) + '</div></div>' +
      '<span class="st-badge st-' + bc.status + '" style="flex-shrink:0;">' + (ST_LABEL[bc.status] || bc.status) + '</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-top:7px;">' +
      '<span class="cat-badge cat-' + bc.category + '">' + (CAT_LABEL[bc.category] || bc.category) + '</span>' +
      '<span style="font-size:11px;color:#94a3b8;">' + (bc.total_targets || 0) + ' email</span>' +
    '</div>' +
    '<div style="margin-top:8px;">' + progressHtml(bc) + '</div>' +
    '<div style="margin-top:8px;text-align:right;">' + actionsHtml(bc) + '</div>' +
  '</div>';
}

// ── Packages ──────────────────────────────────────────────────
async function loadPackages() {
  const d = await App.api('/packages');
  const sel = document.getElementById('ebPackage');
  if (!d?.success || !sel) return;
  const list = d.data?.packages || d.data || [];
  list.forEach(p => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  });
}

// ── Form helpers ──────────────────────────────────────────────
function setCategory(cat, el) {
  _category = cat;
  document.querySelectorAll('#catChips .cat-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
}

function updateMsgCount() {
  const v = document.getElementById('ebMessage')?.value || '';
  _setText('ebMsgCount', v.length + ' karakter');
}

function insertVar(v) {
  const ta = document.getElementById('ebMessage');
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd ?? start);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + v.length;
  updateMsgCount();
}

function setTarget(type, el) {
  _targetType = type;
  document.getElementById('ebTargetType').value = type;
  document.querySelectorAll('#targetTabs .ttab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('pkgPanel').style.display    = type === 'by_package' ? 'block' : 'none';
  document.getElementById('areaPanel').style.display   = type === 'by_area' ? 'block' : 'none';
  document.getElementById('manualPanel').style.display = type === 'custom' ? 'block' : 'none';
  if (type === 'by_area' && !_areaLoaded) loadProvinces();
  updateTargetCount();
}

// ── Filter Area berjenjang ────────────────────────────────────
// Memakai endpoint /customers/areas yang sudah ada (province→regency→district)
// + /customers/areas level village. Hanya menampilkan area yang ada datanya.
let _areaLoaded = false;
async function _fetchAreas(params) {
  const qs = new URLSearchParams(params).toString();
  const d = await App.api('/customers/areas' + (qs ? '?' + qs : ''));
  return (d && d.success && Array.isArray(d.data)) ? d.data : [];
}
function _fillAreaSelect(id, list, placeholder) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = '<option value="">' + placeholder + '</option>' +
    list.map(v => '<option value="' + _esc(v) + '">' + _esc(v) + '</option>').join('');
  sel.disabled = list.length === 0;
}
async function loadProvinces() {
  _areaLoaded = true;
  const list = await _fetchAreas({});
  _fillAreaSelect('areaProvince', list, 'Semua provinsi');
}
async function onAreaChange(level) {
  if (level === 'province') {
    _area.province = document.getElementById('areaProvince').value;
    _area.regency = _area.district = _area.village = '';
    _fillAreaSelect('areaRegency', _area.province ? await _fetchAreas({ province:_area.province }) : [], 'Semua kab/kota');
    _fillAreaSelect('areaDistrict', [], 'Semua kecamatan');
    _fillAreaSelect('areaVillage', [], 'Semua kelurahan/desa');
  } else if (level === 'regency') {
    _area.regency = document.getElementById('areaRegency').value;
    _area.district = _area.village = '';
    _fillAreaSelect('areaDistrict', _area.regency ? await _fetchAreas({ province:_area.province, regency:_area.regency }) : [], 'Semua kecamatan');
    _fillAreaSelect('areaVillage', [], 'Semua kelurahan/desa');
  } else if (level === 'district') {
    _area.district = document.getElementById('areaDistrict').value;
    _area.village = '';
    _fillAreaSelect('areaVillage', _area.district ? await _fetchAreas({ province:_area.province, regency:_area.regency, district:_area.district }) : [], 'Semua kelurahan/desa');
  } else if (level === 'village') {
    _area.village = document.getElementById('areaVillage').value;
  }
  updateTargetCount();
}
function _areaFilter() {
  const f = {};
  if (_area.province) f.province = _area.province;
  if (_area.regency)  f.regency  = _area.regency;
  if (_area.district) f.district = _area.district;
  if (_area.village)  f.village  = _area.village;
  return f;
}

function setCustomMode(mode, el) {
  _customMode = mode;
  document.querySelectorAll('#customModeTabs .cmtab').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.style.background = on ? '#fff' : 'transparent';
    b.style.fontWeight = on ? '600' : '500';
    b.style.color = on ? '#0d1b3e' : '#64748b';
    b.style.boxShadow = on ? '0 1px 3px rgba(0,0,0,0.06)' : 'none';
  });
  document.getElementById('manualModeBox').style.display = mode === 'manual' ? 'block' : 'none';
  document.getElementById('pickModeBox').style.display   = mode === 'pick' ? 'block' : 'none';
  updateTargetCount();
}

function countManual() {
  const lines = (document.getElementById('ebManual')?.value || '').split(/[\n,;]+/);
  const valid = lines.map(s => s.trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  _setText('manualCount', valid.length + ' alamat valid');
  updateTargetCountDebounced();
}

const updateTargetCountDebounced = _debounce(updateTargetCount, 400);

async function updateTargetCount() {
  let url = '/email-broadcast/count-targets?target_type=' + _targetType;
  if (_targetType === 'by_package') {
    const pid = document.getElementById('ebPackage')?.value;
    if (!pid) { showCount(0); return; }
    url += '&package_id=' + pid;
  }
  if (_targetType === 'by_area') {
    const af = _areaFilter();
    Object.keys(af).forEach(k => { url += '&' + k + '=' + encodeURIComponent(af[k]); });
  }
  if (_targetType === 'custom') {
    if (_customMode === 'manual') {
      const v = document.getElementById('ebManual')?.value || '';
      if (!v.trim()) { showCount(0); return; }
      url += '&manual_emails=' + encodeURIComponent(v);
    } else {
      if (!_pickedIds.size) { showCount(0); return; }
      url += '&customer_ids=' + [..._pickedIds].join(',');
    }
  }
  const d = await App.api(url);
  showCount(d?.count || 0);
}

function showCount(n) {
  document.getElementById('targetCountWrap').style.display = 'block';
  _setText('targetCountNum', n);
}

// ── Create / actions ──────────────────────────────────────────
function gatherForm() {
  return {
    title:    document.getElementById('ebTitle')?.value?.trim(),
    subject:  document.getElementById('ebSubject')?.value?.trim(),
    category: _category,
    message:  document.getElementById('ebMessage')?.value?.trim(),
  };
}

async function createBroadcast(mode) {
  const f = gatherForm();
  if (!f.title || !f.subject || !f.message) { _toast('Judul, subjek, dan isi pesan wajib diisi', 'error'); return; }

  const body = {
    ...f,
    target_type: _targetType,
    send_interval: parseInt(document.getElementById('ebInterval')?.value) || 2,
  };
  if (_targetType === 'by_package') {
    const pid = document.getElementById('ebPackage')?.value;
    if (!pid) { _toast('Pilih paket dulu', 'error'); return; }
    body.target_filter = { package_id: parseInt(pid) };
  }
  if (_targetType === 'by_area') {
    const af = _areaFilter();
    if (!Object.keys(af).length) { _toast('Pilih minimal provinsi untuk target per area', 'error'); return; }
    body.target_filter = af;
  }
  if (_targetType === 'custom') {
    if (_customMode === 'manual') {
      body.manual_emails = document.getElementById('ebManual')?.value || '';
    } else {
      if (!_pickedIds.size) { _toast('Pilih minimal 1 customer', 'error'); return; }
      body.customer_ids = [..._pickedIds];
    }
  }

  const schedVal = document.getElementById('ebScheduled')?.value;
  if (mode === 'schedule') {
    if (!schedVal) { _toast('Isi tanggal/jam jadwal dulu', 'error'); return; }
    body.scheduled_at = new Date(schedVal).toISOString();
  }

  const btn = document.getElementById(mode === 'schedule' ? 'btnSchedule' : 'btnSendNow');
  if (btn) btn.disabled = true;
  try {
    const d = await App.api('/email-broadcast', { method: 'POST', body: JSON.stringify(body) });
    if (!d?.success) { _toast(d?.message || 'Gagal membuat broadcast', 'error'); return; }
    if (mode === 'now') {
      const r = await App.api('/email-broadcast/' + d.data.id + '/send-now', { method: 'POST' });
      _toast(r?.success ? 'Broadcast email mulai dikirim' : (r?.message || 'Gagal memulai broadcast'), r?.success ? 'success' : 'error');
    } else {
      _toast(d.message || 'Broadcast dijadwalkan', 'success');
    }
    resetForm();
    loadStats(); loadBroadcasts();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetForm() {
  ['ebTitle','ebSubject','ebMessage','ebManual','ebScheduled'].forEach(id => {
    const e = document.getElementById(id); if (e) e.value = '';
  });
  _pickedIds.clear();
  _setText('pickerSummary', '');
  updateMsgCount(); countManual(); updateTargetCount();
}

async function sendNow(id) {
  if (!confirm('Kirim broadcast email ini sekarang?')) return;
  const d = await App.api('/email-broadcast/' + id + '/send-now', { method: 'POST' });
  _toast(d?.message || (d?.success ? 'OK' : 'Gagal'), d?.success ? 'success' : 'error');
  loadStats(); loadBroadcasts();
}

async function cancelBc(id) {
  if (!confirm('Batalkan broadcast ini? Pengiriman yang sedang berjalan akan dihentikan.')) return;
  const d = await App.api('/email-broadcast/' + id + '/cancel', { method: 'POST' });
  _toast(d?.message || (d?.success ? 'Dibatalkan' : 'Gagal'), d?.success ? 'success' : 'error');
  loadStats(); loadBroadcasts();
}

async function deleteBc(id) {
  if (!confirm('Hapus broadcast ini dari riwayat?')) return;
  const d = await App.api('/email-broadcast/' + id, { method: 'DELETE' });
  _toast(d?.message || (d?.success ? 'Dihapus' : 'Gagal'), d?.success ? 'success' : 'error');
  loadStats(); loadBroadcasts();
}

// ── Preview ───────────────────────────────────────────────────
async function openPreview() {
  const f = gatherForm();
  if (!f.message) { _toast('Isi pesan dulu untuk melihat preview', 'error'); return; }
  const d = await App.api('/email-broadcast/preview', { method: 'POST', body: JSON.stringify(f) });
  if (!d?.success) { _toast(d?.message || 'Gagal render preview', 'error'); return; }
  _setText('previewSubject', d.subject || f.subject || '-');
  const frame = document.getElementById('previewFrame');
  if (frame) frame.srcdoc = d.html;
  openModal('previewModal');
}

// ── Test send ─────────────────────────────────────────────────
function openTestModal() {
  const f = gatherForm();
  if (!f.subject || !f.message) { _toast('Isi subjek dan pesan dulu', 'error'); return; }
  openModal('testModal');
}

async function sendTest() {
  const to = document.getElementById('testEmailTo')?.value?.trim();
  if (!to) { _toast('Isi alamat email tujuan', 'error'); return; }
  const f = gatherForm();
  const btn = document.getElementById('btnSendTest');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengirim...'; }
  try {
    const d = await App.api('/email-broadcast/send-test', { method: 'POST', body: JSON.stringify({ ...f, to }) });
    _toast(d?.message || (d?.success ? 'Terkirim' : 'Gagal'), d?.success ? 'success' : 'error');
    if (d?.success) closeModal('testModal');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Kirim Test'; }
  }
}

// ── Detail modal ──────────────────────────────────────────────
async function openDetail(id) {
  const d = await App.api('/email-broadcast/' + id);
  if (!d?.success) { _toast(d?.message || 'Gagal memuat detail', 'error'); return; }
  const bc = d.data;
  const fmtDT = v => v ? new Date(v).toLocaleString('id-ID') : '-';
  const row = (k, v) => '<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #f5f8ff;font-size:12.5px;"><span style="color:#6b7fa8;flex-shrink:0;">' + k + '</span><span style="font-weight:600;text-align:right;color:#0d1b3e;">' + v + '</span></div>';
  document.getElementById('detailBody').innerHTML =
    row('Judul', _esc(bc.title)) +
    row('Subjek', _esc(bc.subject)) +
    row('Kategori', '<span class="cat-badge cat-' + bc.category + '">' + (CAT_LABEL[bc.category] || bc.category) + '</span>') +
    row('Status', '<span class="st-badge st-' + bc.status + '">' + (ST_LABEL[bc.status] || bc.status) + '</span>') +
    row('Target', (bc.total_targets || 0) + ' email (' + _esc(bc.target_type) + ')') +
    row('Terkirim', (bc.total_sent || 0) + ' / Gagal: ' + (bc.total_failed || 0)) +
    row('Interval', (bc.send_interval || 2) + ' detik') +
    row('Dijadwalkan', fmtDT(bc.scheduled_at)) +
    row('Mulai', fmtDT(bc.started_at)) +
    row('Selesai', fmtDT(bc.completed_at)) +
    '<div style="margin-top:12px;"><div style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#6b7fa8;margin-bottom:5px;">Isi Pesan</div>' +
    '<div style="background:#f8faff;border:1px solid #e8eef9;border-radius:10px;padding:12px;font-size:12px;line-height:1.7;white-space:pre-wrap;color:#334155;max-height:200px;overflow-y:auto;">' + _esc(bc.message) + '</div></div>';
  openModal('detailModal');
}

// ── Customer picker ───────────────────────────────────────────
function openCustomerPicker() {
  openModal('pickerModal');
  cpSearch();
}

const cpSearchDebounced = _debounce(cpSearch, 350);

async function cpSearch() {
  const q = document.getElementById('cpSearch')?.value || '';
  const list = document.getElementById('cpList');
  if (list) list.innerHTML = '<div class="tbl-empty">Memuat...</div>';
  const d = await App.api('/email-broadcast/search-customers?limit=80&q=' + encodeURIComponent(q));
  if (!d?.success) { if (list) list.innerHTML = '<div class="tbl-empty" style="color:#dc2626;">Gagal memuat</div>'; return; }
  _cpLastResults = d.data || [];
  if (!_cpLastResults.length) {
    if (list) list.innerHTML = '<div class="tbl-empty">Tidak ada customer dengan email yang cocok</div>';
    return;
  }
  if (list) list.innerHTML = _cpLastResults.map(c =>
    '<label class="cp-row">' +
      '<input type="checkbox" class="cp-check cp-item" value="' + c.id + '"' + (_pickedIds.has(c.id) ? ' checked' : '') + ' onchange="cpToggleOne(this)">' +
      '<div style="min-width:0;"><div class="cp-name">' + _esc(c.name) + '</div>' +
      '<div class="cp-detail">' + _esc(c.customer_id || '-') + ' · ' + _esc(c.email) + (c.package?.name ? ' · ' + _esc(c.package.name) : '') + '</div></div>' +
    '</label>'
  ).join('');
  cpUpdateCount();
}

function cpToggleOne(cb) {
  const id = parseInt(cb.value);
  if (cb.checked) _pickedIds.add(id); else _pickedIds.delete(id);
  cpUpdateCount();
}

function cpToggleAll(checked) {
  _cpLastResults.forEach(c => { if (checked) _pickedIds.add(c.id); else _pickedIds.delete(c.id); });
  document.querySelectorAll('#cpList .cp-item').forEach(cb => { cb.checked = checked; });
  cpUpdateCount();
}

function cpUpdateCount() {
  _setText('cpSelectedCount', _pickedIds.size + ' terpilih');
}

function cpApply() {
  closeModal('pickerModal');
  _setText('pickerBtnLbl', _pickedIds.size ? 'Ubah Pilihan (' + _pickedIds.size + ')' : 'Buka Daftar Customer');
  _setText('pickerSummary', _pickedIds.size ? _pickedIds.size + ' customer terpilih' : '');
  updateTargetCount();
}

// ── Modal helpers ─────────────────────────────────────────────
function openModal(id)  { const m = document.getElementById(id); if (m) m.classList.add('open'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); }
document.addEventListener('click', e => {
  if (e.target.classList?.contains('eb-modal-bg')) e.target.classList.remove('open');
});
