// tools.js — Tools page (IP Scan + Hotspot Binding Management)

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _dev = () => document.getElementById('routerSel')?.value || '';
let _routers = [];
let _scanResults = [];
let _hsCustomers = [];

// localStorage key (selaras pola flaynet:dashboard:mikrotik_id)
const LS_KEY = 'flaynet:tools:router_id';

document.addEventListener('DOMContentLoaded', () => {
  loadRouters();
});

// ── ROUTER PICKER ────────────────────────────────────────────
async function loadRouters() {
  const d = await App.api('/tools/routers');
  const sel = document.getElementById('routerSel');
  if (!d?.success || !d.data?.length) {
    sel.innerHTML = '<option value="">— Tidak ada router aktif —</option>';
    return;
  }
  _routers = d.data;
  const saved = localStorage.getItem(LS_KEY);
  sel.innerHTML = _routers.map(r =>
    `<option value="${r.id}" ${String(r.id) === String(saved) ? 'selected' : ''}>${_esc(r.name)} — ${_esc(r.ip_address)}</option>`
  ).join('');
  // Kalau tidak ada saved, pakai yang pertama (sudah selected secara default)
  if (!saved && _routers[0]) sel.value = _routers[0].id;
  onRouterChange();
}

function onRouterChange() {
  const id = _dev();
  if (id) localStorage.setItem(LS_KEY, id);
  const r = _routers.find(x => String(x.id) === String(id));
  const pill = document.getElementById('routerProto');
  if (r && pill) {
    pill.textContent = (r.api_protocol || 'auto').toUpperCase();
    pill.style.display = 'inline-flex';
  }
  // Reload data tab aktif
  const active = document.querySelector('.tools-tab.active')?.dataset.tab;
  if (active === 'binding') { loadHotspotCustomers(); }
  if (active === 'ipscan')  { loadInterfaces(); }
}

// ── TABS ─────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tools-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + tab)?.classList.add('active');
  if (tab === 'binding') loadHotspotCustomers();
  if (tab === 'ipscan')  loadInterfaces();
}

// ════════════════════════════════════════════════════════════
//  TAB 1: HOTSPOT BINDING
// ════════════════════════════════════════════════════════════
async function loadHotspotCustomers() {
  const wrap = document.getElementById('hsCustWrap');
  wrap.innerHTML = '<div class="empty">Memuat…</div>';
  const d = await App.api('/tools/hotspot/customers');
  if (!d?.success) { wrap.innerHTML = `<div class="empty">Gagal: ${_esc(d?.message)}</div>`; return; }
  _hsCustomers = d.data || [];

  // Stats
  const total = _hsCustomers.length;
  const isolated = _hsCustomers.filter(c => c.isolir_status === 'isolated').length;
  document.getElementById('stHsTotal').textContent = total;
  document.getElementById('stHsActive').textContent = total - isolated;
  document.getElementById('stHsIsolated').textContent = isolated;

  if (!total) {
    wrap.innerHTML = '<div class="empty">Belum ada pelanggan tipe Hotspot. Set Tipe Koneksi = Hotspot + MAC Address di halaman Customers, atau bind dari hasil IP Scan.</div>';
    return;
  }

  wrap.innerHTML = `<table class="ttbl"><thead><tr>
    <th>Pelanggan</th><th>MAC</th><th>IP</th><th>Router</th><th>Tagihan</th><th>Status</th><th style="text-align:right">Aksi</th>
    </tr></thead><tbody>` +
    _hsCustomers.map(c => {
      const isolated = c.isolir_status === 'isolated';
      const statusBadge = isolated
        ? '<span class="badge red">⛔ Terisolir</span>'
        : '<span class="badge green">✓ Aktif</span>';
      const invBadge = c.last_inv_status === 'paid'
        ? '<span class="badge green">Lunas</span>'
        : (c.last_inv_status ? `<span class="badge amber">${_esc(c.last_inv_status)}</span>` : '<span class="badge gray">–</span>');
      const actionBtn = isolated
        ? `<button class="btn btn-green btn-sm" onclick="doRestore(${c.id},'${_esc(c.name)}')">Restore</button>`
        : `<button class="btn btn-danger btn-sm" onclick="doIsolir(${c.id},'${_esc(c.name)}')">Isolir</button>`;
      return `<tr>
        <td><div style="font-weight:700">${_esc(c.name)}</div><div style="font-size:11px;color:#94a3b8">${_esc(c.customer_id)}</div></td>
        <td>${c.mac_address ? `<span class="mac-tag">${_esc(c.mac_address)}</span>` : '<span style="color:#cbd5e1">–</span>'}</td>
        <td>${c.static_ip ? `<span class="ip-tag">${_esc(c.static_ip)}</span>` : '<span style="color:#cbd5e1">–</span>'}</td>
        <td style="font-size:12px">${_esc(c.router_name || '–')}</td>
        <td>${invBadge}</td>
        <td>${statusBadge}</td>
        <td style="text-align:right">${actionBtn}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

async function doIsolir(id, name) {
  if (!confirm(`Isolir pelanggan "${name}"?\nIP Binding akan dinonaktifkan & session di-kick.`)) return;
  const d = await App.api(`/tools/hotspot/customers/${id}/isolir`, { method: 'POST', body: JSON.stringify({}) });
  App.showToast(d?.message || (d?.success ? 'Berhasil' : 'Gagal'), d?.success ? 'success' : 'error');
  if (d?.success) loadHotspotCustomers();
}

async function doRestore(id, name) {
  if (!confirm(`Restore akses pelanggan "${name}"?\nIP Binding akan diaktifkan kembali.`)) return;
  const d = await App.api(`/tools/hotspot/customers/${id}/restore`, { method: 'POST', body: JSON.stringify({}) });
  App.showToast(d?.message || (d?.success ? 'Berhasil' : 'Gagal'), d?.success ? 'success' : 'error');
  if (d?.success) loadHotspotCustomers();
}

// ── SYNC DB ↔ MikroTik ───────────────────────────────────────
async function runSync() {
  if (!_dev()) { App.showToast('Pilih router dulu', 'warning'); return; }
  App.showToast('Memeriksa status binding di router…', 'info');
  const d = await App.api('/tools/hotspot/sync?device_id=' + _dev());
  if (!d?.success) { App.showToast('Sync gagal: ' + _esc(d?.message), 'error'); return; }
  document.getElementById('stHsMismatch').textContent = d.mismatch_count;
  const badge = document.getElementById('tools-mismatch-badge');
  if (badge) { badge.textContent = d.mismatch_count; badge.style.display = d.mismatch_count ? 'inline-flex' : 'none'; }

  // Tampilkan ringkasan mismatch
  const mismatches = (d.data || []).filter(r => r.mismatch);
  if (!mismatches.length) {
    App.showToast(`✓ Semua ${d.total} pelanggan sinkron dengan router`, 'success');
  } else {
    const lines = mismatches.slice(0, 8).map(m => `• ${m.name}: ${m.note}`).join('\n');
    alert(`⚠ ${d.mismatch_count} dari ${d.total} pelanggan TIDAK sinkron:\n\n${lines}${mismatches.length > 8 ? '\n…' : ''}\n\nGunakan tombol Isolir/Restore untuk memperbaiki.`);
  }
}

// ── BINDINGS (raw dari router) ───────────────────────────────
async function loadBindings() {
  if (!_dev()) { App.showToast('Pilih router dulu', 'warning'); return; }
  const wrap = document.getElementById('bindingsWrap');
  wrap.innerHTML = '<div class="empty">Memuat dari router…</div>';
  const d = await App.api('/tools/hotspot/bindings?device_id=' + _dev());
  if (!d?.success) { wrap.innerHTML = `<div class="empty">Gagal: ${_esc(d?.message)}</div>`; return; }
  const list = d.data || [];
  if (!list.length) { wrap.innerHTML = '<div class="empty">Tidak ada IP Binding di router ini.</div>'; return; }
  wrap.innerHTML = `<table class="ttbl"><thead><tr>
    <th>MAC</th><th>Address</th><th>To Address</th><th>Type</th><th>Server</th><th>Comment</th><th>Status</th><th style="text-align:right">Aksi</th>
    </tr></thead><tbody>` +
    list.map(b => {
      const statusBadge = b.disabled ? '<span class="badge red">disabled</span>' : '<span class="badge green">enabled</span>';
      const toggleBtn = b.disabled
        ? `<button class="btn btn-green btn-sm" onclick="toggleBinding('${b.id}',false)">Enable</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="toggleBinding('${b.id}',true)">Disable</button>`;
      return `<tr>
        <td>${b.macAddress ? `<span class="mac-tag">${_esc(b.macAddress)}</span>` : '–'}</td>
        <td>${b.address ? `<span class="ip-tag">${_esc(b.address)}</span>` : '–'}</td>
        <td class="mono" style="font-size:12px">${_esc(b.toAddress || '–')}</td>
        <td><span class="badge gray">${_esc(b.type)}</span></td>
        <td style="font-size:12px">${_esc(b.server)}</td>
        <td style="font-size:12px;color:#64748b">${_esc(b.comment || '–')}</td>
        <td>${statusBadge}</td>
        <td style="text-align:right;white-space:nowrap">${toggleBtn}
          <button class="btn btn-danger btn-sm" onclick="deleteBinding('${b.id}')">Hapus</button></td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

async function toggleBinding(bindingId, disabled) {
  const d = await App.api(`/tools/hotspot/bindings/${bindingId}/toggle?device_id=${_dev()}`, {
    method: 'POST', body: JSON.stringify({ disabled, device_id: _dev() })
  });
  App.showToast(d?.message || 'OK', d?.success ? 'success' : 'error');
  if (d?.success) loadBindings();
}

async function deleteBinding(bindingId) {
  if (!confirm('Hapus IP Binding ini dari router?')) return;
  const d = await App.api(`/tools/hotspot/bindings/${bindingId}?device_id=${_dev()}`, { method: 'DELETE' });
  App.showToast(d?.message || 'OK', d?.success ? 'success' : 'error');
  if (d?.success) loadBindings();
}

// ── Modal: tambah binding manual ─────────────────────────────
function openBindingModal() {
  if (!_dev()) { App.showToast('Pilih router dulu', 'warning'); return; }
  ['bmMac','bmAddr','bmComment'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('bmType').value = 'bypassed';
  document.getElementById('bindingModal').classList.add('show');
}
function closeBindingModal() { document.getElementById('bindingModal').classList.remove('show'); }

async function saveBinding() {
  const mac = document.getElementById('bmMac').value.trim().toUpperCase();
  const addr = document.getElementById('bmAddr').value.trim();
  if (!mac && !addr) { App.showToast('Isi MAC atau Address', 'warning'); return; }
  const btn = document.getElementById('bmSaveBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Menyimpan…';
  const d = await App.api('/tools/hotspot/bindings', {
    method: 'POST',
    body: JSON.stringify({
      device_id: _dev(), mac_address: mac, address: addr,
      type: document.getElementById('bmType').value,
      comment: document.getElementById('bmComment').value.trim(),
    })
  });
  btn.disabled = false; btn.textContent = 'Simpan';
  App.showToast(d?.message || 'OK', d?.success ? 'success' : 'error');
  if (d?.success) { closeBindingModal(); loadBindings(); }
}

// ════════════════════════════════════════════════════════════
//  TAB 2: IP SCAN
// ════════════════════════════════════════════════════════════
async function loadInterfaces() {
  const sel = document.getElementById('scanIface');
  if (!_dev()) { sel.innerHTML = '<option value="">— Pilih router dulu —</option>'; return; }
  sel.innerHTML = '<option value="">— Memuat… —</option>';
  const d = await App.api('/tools/interfaces?device_id=' + _dev());
  if (!d?.success || !d.data?.length) {
    sel.innerHTML = '<option value="">— Gagal memuat interface —</option>';
    if (d?.message) App.showToast('Interface: ' + _esc(d.message), 'error');
    return;
  }
  sel.innerHTML = d.data.map(i =>
    `<option value="${_esc(i.name)}">${_esc(i.name)}${i.running ? '' : ' (down)'}</option>`
  ).join('');
}

async function runScan() {
  const iface = document.getElementById('scanIface').value;
  if (!_dev()) { App.showToast('Pilih router dulu', 'warning'); return; }
  if (!iface)  { App.showToast('Pilih interface dulu', 'warning'); return; }
  const range = document.getElementById('scanRange').value.trim();
  const duration = parseInt(document.getElementById('scanDuration').value) || 5;

  const btn = document.getElementById('scanBtn');
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Scanning ${duration}s…`;
  const wrap = document.getElementById('scanWrap');
  wrap.innerHTML = `<div class="empty"><span class="spinner" style="border-top-color:#1e3a8a;border-color:#cbd5e1;border-top-color:#1e3a8a"></span><div style="margin-top:10px">Memindai jaringan via ${_esc(iface)}…</div></div>`;

  const t0 = Date.now();
  const d = await App.api('/tools/ip-scan', {
    method: 'POST',
    body: JSON.stringify({ device_id: _dev(), interface: iface, address_range: range, duration })
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  btn.disabled = false; btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg> Start Scan`;

  if (!d?.success) {
    wrap.innerHTML = `<div class="empty">Scan gagal: ${_esc(d?.message)}</div>`;
    return;
  }
  _scanResults = d.data || [];
  const meta = document.getElementById('scanMeta');
  meta.style.display = 'flex';
  meta.innerHTML = `<span class="badge blue">${d.count} host ditemukan</span> <span>Interface: <strong>${_esc(iface)}</strong></span> <span>Selesai dalam ${elapsed}s</span>`;
  renderScanResults();
}

function renderScanResults() {
  const wrap = document.getElementById('scanWrap');
  if (!_scanResults.length) {
    wrap.innerHTML = '<div class="empty">Tidak ada host yang merespons di range ini.</div>';
    return;
  }
  wrap.innerHTML = `<table class="ttbl"><thead><tr>
    <th>Address</th><th>MAC Address</th><th>Time (ms)</th><th>DNS</th><th>Pelanggan</th><th style="text-align:right">Aksi</th>
    </tr></thead><tbody>` +
    _scanResults.map((r, idx) => {
      const cust = r.customer;
      const custCell = cust
        ? `<span class="badge ${cust.isolir_status === 'isolated' ? 'red' : 'green'}">${_esc(cust.name)}</span>`
        : '<span style="color:#cbd5e1">belum terdaftar</span>';
      const bindBtn = cust
        ? `<button class="btn btn-ghost btn-sm" disabled title="Sudah ter-bind">✓ Ter-bind</button>`
        : `<button class="btn btn-green btn-sm" onclick="openBindCust(${idx})">Bind ke Pelanggan</button>`;
      return `<tr>
        <td><span class="ip-tag">${_esc(r.address)}</span></td>
        <td>${r.macAddress ? `<span class="mac-tag">${_esc(r.macAddress)}</span>` : '–'}</td>
        <td class="mono" style="font-size:12px">${_esc(r.time || '–')}</td>
        <td style="font-size:12px;color:#64748b">${_esc(r.dns || '–')}</td>
        <td>${custCell}</td>
        <td style="text-align:right">${bindBtn}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

// ── Modal: bind hasil scan ke pelanggan ──────────────────────
async function openBindCust(idx) {
  const r = _scanResults[idx];
  if (!r) return;
  document.getElementById('bcMac').value = r.macAddress || '';
  document.getElementById('bcAddr').value = r.address || '';
  // Load daftar pelanggan (yang belum punya binding hotspot diutamakan, tapi semua boleh)
  const sel = document.getElementById('bcCustomer');
  sel.innerHTML = '<option value="">— Memuat… —</option>';
  document.getElementById('bindCustModal').classList.add('show');
  const d = await App.api('/customers?limit=1000');
  const list = (d?.data?.customers || d?.data || d?.customers || []);
  if (!Array.isArray(list) || !list.length) {
    sel.innerHTML = '<option value="">— Tidak ada pelanggan —</option>';
    return;
  }
  sel.innerHTML = '<option value="">— Pilih pelanggan —</option>' +
    list.map(c => `<option value="${c.id}">${_esc(c.name)} — ${_esc(c.customer_id || '')}</option>`).join('');
}
function closeBindCustModal() { document.getElementById('bindCustModal').classList.remove('show'); }

async function saveBindCustomer() {
  const custId = document.getElementById('bcCustomer').value;
  if (!custId) { App.showToast('Pilih pelanggan dulu', 'warning'); return; }
  const btn = document.getElementById('bcSaveBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Binding…';
  const d = await App.api('/tools/bind-customer', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: custId,
      mac_address: document.getElementById('bcMac').value,
      address: document.getElementById('bcAddr').value,
      mikrotik_id: null, // device_id di sini = devices(monitoring); mikrotik_id customer beda tabel, biarkan admin set manual di Customers
    })
  });
  btn.disabled = false; btn.textContent = 'Bind';
  App.showToast(d?.message || 'OK', d?.success ? 'success' : 'error');
  if (d?.success) { closeBindCustModal(); runScanRefresh(); }
}

// Re-render scan results setelah bind (tandai pelanggan baru) — refetch ringan
async function runScanRefresh() {
  // Tandai lokal: cari result dengan MAC yang baru di-bind → set customer flag
  const mac = (document.getElementById('bcMac').value || '').toUpperCase();
  const custName = document.getElementById('bcCustomer').selectedOptions[0]?.text || 'Pelanggan';
  _scanResults = _scanResults.map(r =>
    (r.macAddress || '').toUpperCase() === mac
      ? { ...r, customer: { name: custName.split(' — ')[0], isolir_status: 'active' } }
      : r
  );
  renderScanResults();
}
