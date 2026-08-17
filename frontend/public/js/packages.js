/**
 * packages.js — Paket Layanan
 * Clean rewrite — all stat IDs match packages.ejs HTML
 */

const TOKEN = localStorage.getItem('token');
const API   = '/api';
let allPackages  = [];
let editingId    = null;
let deletingId   = null;
let activeFilter = 'all'; // 'all' | 'active' | 'inactive'

/* ════ HELPERS ════ */
function authH() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };
}
function fmtRp(v) {
  return 'Rp ' + (parseFloat(v)||0).toLocaleString('id-ID');
}
function fmtSpd(mbps) {
  if (!mbps) return '—';
  return mbps >= 1000 ? (mbps/1000)+' Gbps' : mbps+' Mbps';
}
function catLabel(c) {
  return ({home:'Home',business:'Business',enterprise:'Enterprise',custom:'Custom'})[c]||'Home';
}
function detectCat(p) {
  const n = (p.name||'').toLowerCase();
  if (n.includes('enterprise')) return 'enterprise';
  if (n.includes('business'))   return 'business';
  if (n.includes('custom'))     return 'custom';
  return 'home';
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
function showOk(msg)  { showToast('toastOk',  '✓ ' + msg); }
function showErr(msg) { showToast('toastErr', '✕ ' + msg); }
function showToast(id, msg) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  setTimeout(function(){ el.style.display = 'none'; }, 3500);
}

/* ════ LOAD ════ */
async function loadPackages() {
  try {
    var r = await fetch(API + '/packages', { headers: authH() });
    var j = await r.json();
    if (!j.success) throw new Error(j.message);
    allPackages = j.data || [];
    renderStats();
    renderCards();
  } catch(e) { showErr('Gagal memuat: ' + e.message); }
}

/* ════ STATS ════ */
function renderStats() {
  var total    = allPackages.length;
  var active   = allPackages.filter(function(p){ return p.is_active; }).length;
  var totalC   = allPackages.reduce(function(a, p){ return a + (p.customer_count || 0); }, 0);
  var activePrices = allPackages.filter(function(p){ return p.is_active; }).map(function(p){ return parseFloat(p.price) || 0; });
  var avgPrice = activePrices.length ? Math.round(activePrices.reduce(function(a, b){ return a + b; }, 0) / activePrices.length) : 0;

  // Set stat card values — IDs match packages.ejs HTML
  setText('scTotal',     total);
  setText('scActive',    active);
  setText('scCustomers', totalC);
  setText('scAvgPrice',  avgPrice ? fmtRp(avgPrice) : '0');

  // Header subtitle
  var sub = document.getElementById('pkgHeaderSub');
  if (sub) sub.textContent = total + ' paket terdaftar \u00b7 ' + active + ' aktif \u00b7 ' + totalC + ' pelanggan';
}

/* ════ RENDER CARDS ════ */
function renderCards() {
  var grid   = document.getElementById('pkgGrid');
  var empty  = document.getElementById('pkgEmpty');
  var lbl    = document.getElementById('pkgCountLbl');
  if (!grid) return;

  var searchEl = document.getElementById('pkgSearch');
  var search   = searchEl ? searchEl.value.toLowerCase().trim() : '';
  var catEl    = document.getElementById('filterCat');
  var cat      = catEl ? catEl.value : '';
  var statusEl = document.getElementById('filterStatus');
  var status   = statusEl ? statusEl.value : '';
  var sortEl   = document.getElementById('filterSort');
  var sort     = sortEl ? sortEl.value : 'price_asc';

  var list = allPackages.slice();

  // Status filter from card click
  if (activeFilter === 'active')   list = list.filter(function(p){ return p.is_active; });
  if (activeFilter === 'inactive') list = list.filter(function(p){ return !p.is_active; });

  // Dropdown filters
  if (cat)                     list = list.filter(function(p){ return (p.category || detectCat(p)) === cat; });
  if (status === 'active')     list = list.filter(function(p){ return p.is_active; });
  if (status === 'inactive')   list = list.filter(function(p){ return !p.is_active; });

  // Search
  if (search) {
    list = list.filter(function(p){
      return (p.name||'').toLowerCase().indexOf(search) !== -1 ||
             (p.description||'').toLowerCase().indexOf(search) !== -1 ||
             String(p.speed_down).indexOf(search) !== -1 ||
             String(p.price).indexOf(search) !== -1;
    });
  }

  // Sort
  list.sort(function(a, b){
    if (sort === 'price_asc')      return parseFloat(a.price) - parseFloat(b.price);
    if (sort === 'price_desc')     return parseFloat(b.price) - parseFloat(a.price);
    if (sort === 'speed_desc')     return (b.speed_down||0) - (a.speed_down||0);
    if (sort === 'name_asc')       return (a.name||'').localeCompare(b.name||'');
    if (sort === 'customers_desc') return (b.customer_count||0) - (a.customer_count||0);
    return 0;
  });

  if (lbl) lbl.textContent = list.length + ' paket';

  if (!list.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = list.map(buildCard).join('');
}

function buildCard(p) {
  var cat    = p.category || detectCat(p);
  var active = p.is_active;
  var cc     = p.customer_count || 0;
  return '<div class="pkg-card ' + (active ? '' : 'inactive') + '">' +
    '<div class="pkg-card-header ' + cat + '">' +
      (!active ? '<span class="pkg-inactive-tag">Non-Aktif</span>' : '') +
      '<div class="pkg-type-label">' + catLabel(cat) + '</div>' +
      '<div class="pkg-name">' + esc(p.name) + '</div>' +
      '<div class="pkg-speed-badge">' +
        '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>' +
        '<span>' + fmtSpd(p.speed_down) + ' / ' + fmtSpd(p.speed_up) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="pkg-card-body">' +
      '<div>' +
        '<span class="pkg-price-val">' + fmtRp(p.price) + '</span>' +
        '<span class="pkg-price-per">/bulan</span>' +
      '</div>' +
      '<div class="pkg-desc">' + esc(p.description || 'Tidak ada deskripsi') + '</div>' +
      '<div class="pkg-meta">' +
        '<div class="pkg-meta-pill">' +
          '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>' +
          ' DL ' + fmtSpd(p.speed_down) +
        '</div>' +
        '<div class="pkg-meta-pill">' +
          '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          ' UL ' + fmtSpd(p.speed_up) +
        '</div>' +
      '</div>' +
      '<div class="pkg-footer">' +
        '<div class="pkg-cust-count">' +
          '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>' +
          ' <strong>' + cc + '</strong>&nbsp;pelanggan' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="rb rb-edit" onclick="openEdit(' + p.id + ')">' +
            '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            ' Edit' +
          '</button>' +
          '<button class="rb ' + (active ? 'rb-toggle-off' : 'rb-toggle-on') + '" onclick="toggleActive(' + p.id + ',' + active + ')">' +
            (active
              ? '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> Off'
              : '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg> On'
            ) +
          '</button>' +
          '<button class="rb rb-del" onclick="openDelete(' + p.id + ',\'' + esc(p.name) + '\')" title="Hapus">' +
            '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* ════ FILTER from stat cards ════ */
function setFilter(f) {
  activeFilter = f;

  // Sync status dropdown
  var sel = document.getElementById('filterStatus');
  if (sel) sel.value = f === 'active' ? 'active' : f === 'inactive' ? 'inactive' : '';

  // Card active state (billing pattern)
  var COLORS     = {'xc-all':'#2563eb', 'xc-active':'#16a34a', 'xc-cuscount':'#0891b2', 'xc-avgprice':'#d97706'};
  var FILTER_MAP = {'all':'xc-all', 'active':'xc-active', 'cuscount':'xc-cuscount', 'avgprice':'xc-avgprice'};
  var targetId   = FILTER_MAP[f];
  var cards      = document.querySelectorAll('.fin-card[data-filter]');

  // Reset all cards
  cards.forEach(function(c){
    c.classList.remove('fc-active');
    var col = COLORS[c.id] || '#64748b';
    var ln  = c.querySelector('.sp-line');
    var fl  = c.querySelector('.sp-fill');
    var dt  = c.querySelector('.sp-dot');
    if (ln) ln.style.stroke = col;
    if (fl) fl.style.fill   = col;
    if (dt) dt.style.fill   = col;
  });

  // Activate target card
  var target = document.getElementById(targetId);
  if (target) {
    target.classList.add('fc-active');
    var ln = target.querySelector('.sp-line');
    var fl = target.querySelector('.sp-fill');
    var dt = target.querySelector('.sp-dot');
    if (ln) ln.style.stroke = 'rgba(255,255,255,.70)';
    if (fl) fl.style.fill   = 'rgba(255,255,255,.12)';
    if (dt) dt.style.fill   = '#fff';
  }

  renderCards();
}

/* ════ MODAL ════ */
function openAddPkg() {
  editingId = null;
  setText('modalTitle', 'Tambah Paket Baru');
  setText('btnSaveTxt', 'Simpan Paket');
  clearForm();
  var modal = document.getElementById('pkgModal');
  if (modal) modal.classList.add('active');
}

function openEdit(id) {
  var p = allPackages.find(function(x){ return x.id === id; });
  if (!p) return;
  editingId = id;
  setText('modalTitle', 'Edit Paket');
  setText('btnSaveTxt', 'Simpan Perubahan');
  fillForm(p);
  var modal = document.getElementById('pkgModal');
  if (modal) modal.classList.add('active');
}

function closeModal() {
  var modal = document.getElementById('pkgModal');
  if (modal) modal.classList.remove('active');
  editingId = null;
}

function clearForm() {
  ['f_name','f_speed_down','f_speed_up','f_price','f_description'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var catEl = document.getElementById('f_category');
  if (catEl) catEl.value = 'home';
  var actEl = document.getElementById('f_is_active');
  if (actEl) actEl.value = '1';
  syncColor('home');
}

function fillForm(p) {
  function setVal(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
  setVal('f_name',        p.name || '');
  setVal('f_speed_down',  p.speed_down || '');
  setVal('f_speed_up',    p.speed_up || '');
  setVal('f_price',       p.price || '');
  setVal('f_description', p.description || '');
  var cat = p.category || detectCat(p);
  setVal('f_category',    cat);
  setVal('f_is_active',   p.is_active ? '1' : '0');
  syncColor(cat);
}

function syncColor(cat) {
  document.querySelectorAll('#colorOpts .color-opt').forEach(function(el){
    el.classList.toggle('sel', el.dataset.c === cat);
  });
  var sel = document.getElementById('f_category');
  if (sel && sel.value !== cat) sel.value = cat;
}

/* ════ SAVE ════ */
async function savePkg() {
  var nameEl = document.getElementById('f_name');
  var name       = nameEl ? nameEl.value.trim() : '';
  var speed_down = parseInt(document.getElementById('f_speed_down')?.value) || 0;
  var speed_up   = parseInt(document.getElementById('f_speed_up')?.value) || 0;
  var price      = parseFloat(document.getElementById('f_price')?.value) || 0;
  var descEl     = document.getElementById('f_description');
  var description= descEl ? descEl.value.trim() : '';
  var catEl      = document.getElementById('f_category');
  var category   = catEl ? catEl.value : 'home';
  var actEl      = document.getElementById('f_is_active');
  var is_active  = actEl ? actEl.value === '1' : true;

  if (!name)       return showErr('Nama paket wajib diisi');
  if (!speed_down) return showErr('Kecepatan download wajib diisi');
  if (!speed_up)   return showErr('Kecepatan upload wajib diisi');
  if (!price)      return showErr('Harga wajib diisi');

  var btn    = document.getElementById('btnSavePkg');
  var btnTxt = document.getElementById('btnSaveTxt');
  if (btn) btn.disabled = true;
  if (btnTxt) btnTxt.textContent = 'Menyimpan…';

  try {
    var url    = editingId ? API + '/packages/' + editingId : API + '/packages';
    var method = editingId ? 'PUT' : 'POST';
    var r      = await fetch(url, { method: method, headers: authH(), body: JSON.stringify({ name: name, speed_down: speed_down, speed_up: speed_up, price: price, description: description, category: category, is_active: is_active }) });
    var j      = await r.json();
    if (!j.success) throw new Error(j.message);
    closeModal();
    showOk(editingId ? 'Paket berhasil diperbarui' : 'Paket baru berhasil ditambahkan');
    await loadPackages();
  } catch(e) {
    showErr('Gagal: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
    if (btnTxt) btnTxt.textContent = editingId ? 'Simpan Perubahan' : 'Simpan Paket';
  }
}

/* ════ TOGGLE ════ */
async function toggleActive(id, cur) {
  try {
    var r = await fetch(API + '/packages/' + id, { method: 'PUT', headers: authH(), body: JSON.stringify({ is_active: !cur }) });
    var j = await r.json();
    if (!j.success) throw new Error(j.message);
    showOk(cur ? 'Paket dinonaktifkan' : 'Paket diaktifkan');
    await loadPackages();
  } catch(e) { showErr('Gagal: ' + e.message); }
}

/* ════ DELETE ════ */
function openDelete(id, name) {
  deletingId = id;
  var p   = allPackages.find(function(x){ return x.id === id; });
  var msg = document.getElementById('delMsg');
  var btn = document.getElementById('btnDelConfirm');
  if (p && (p.customer_count || 0) > 0) {
    if (msg) msg.innerHTML = 'Paket <strong>' + esc(name) + '</strong> masih digunakan <strong>' + p.customer_count + '</strong> pelanggan. Tidak bisa dihapus.';
    if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
  } else {
    if (msg) msg.innerHTML = 'Paket <strong>' + esc(name) + '</strong> akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.';
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
  var modal = document.getElementById('delModal');
  if (modal) modal.classList.add('active');
}

function closeDelModal() {
  var modal = document.getElementById('delModal');
  if (modal) modal.classList.remove('active');
  deletingId = null;
}

async function confirmDelete() {
  if (!deletingId) return;
  try {
    var r = await fetch(API + '/packages/' + deletingId, { method: 'DELETE', headers: authH() });
    var j = await r.json();
    if (!j.success) throw new Error(j.message);
    closeDelModal();
    showOk('Paket berhasil dihapus');
    await loadPackages();
  } catch(e) { showErr('Gagal: ' + e.message); }
}

/* ════ INIT ════ */
document.addEventListener('DOMContentLoaded', function() {
  // Color picker
  document.querySelectorAll('#colorOpts .color-opt').forEach(function(el){
    el.addEventListener('click', function(){ syncColor(el.dataset.c); });
  });

  // Search with debounce
  var searchTimer;
  var searchEl = document.getElementById('pkgSearch');
  if (searchEl) {
    searchEl.addEventListener('input', function(){
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderCards, 300);
    });
  }

  // Dropdown filters
  ['filterCat', 'filterStatus', 'filterSort'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', renderCards);
  });

  // Close modal on overlay click
  var pkgModal = document.getElementById('pkgModal');
  if (pkgModal) {
    pkgModal.addEventListener('click', function(e){
      if (e.target === pkgModal) closeModal();
    });
  }
  var delModal = document.getElementById('delModal');
  if (delModal) {
    delModal.addEventListener('click', function(e){
      if (e.target === delModal) closeDelModal();
    });
  }

  loadPackages();
});