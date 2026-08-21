// customers.js — Customer Management (redesign)

let _custPage   = 1;
let _custEditId = null;
let _nextAutoId = '';
// Flag: true kalau user sudah mengetik manual di field PPPoE Username,
// supaya auto-generate dari nama TIDAK menimpa input manual.
// Direset ke false setiap kali openAddCustomer() / _clearForm() dipanggil.
let _pppoeManuallyEdited = false;
// Saat editCustomer() load data, simpan pppoe_username asli di sini.
// Dipakai oleh saveCustomer() untuk deteksi apakah user mengubah username
// → kalau berubah, tampilkan modal konfirmasi sync ke router.
// Direset ke '' setiap kali openAddCustomer() (tidak relevan di tambah baru).
let _originalPppoeUsername = '';
const AVATAR_BG = ['#2563eb','#0891b2','#059669','#d97706','#dc2626','#0284c7','#16a34a','#ea580c','#0369a1','#0d9488'];

// Toggle field MAC Address — hanya relevan untuk tipe koneksi Hotspot (IP Binding).
window.onConnTypeChange = function() {
  const ct  = document.getElementById('custConnType')?.value || '';
  const mac = document.getElementById('custMacField');
  if (mac) mac.style.display = (ct === 'hotspot') ? '' : 'none';
};

// ── PPPoE Username slugify ────────────────────────────────────
// Bersihkan NAMA CUSTOMER jadi username PPPoE untuk AUTO-GENERATE.
// Hasil-nya bersih dan predictable — hanya huruf+angka:
//   - normalisasi diakritik (é → e, ñ → n, dll)
//   - lowercase
//   - hanya huruf a-z dan angka 0-9 (semua karakter lain di-drop, termasuk spasi)
//   - max 32 char (cukup lega untuk MikroTik secret)
//
// CATATAN: function ini HANYA dipakai untuk auto-generate dari Nama.
// Untuk input MANUAL user di field PPPoE (boleh pakai @, ., -, _),
// JANGAN sanitize via slugify — biarkan user ketik bebas. Format
// realm-style seperti "avinda@net.id" valid dan didukung MikroTik.
//
// Contoh: "Budi Santoso"      → "budisantoso"
//         "Ahmad Yáñez 2"     → "ahmadyanez2"
//         "PT. Maju Jaya"     → "ptmajujaya"
function _slugifyForPppoe(name) {
  if (!name) return '';
  let s = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.slice(0, 32);
}

// ── PPPoE Username slot mover ─────────────────────────────────
// Field #custPPPoE punya dua "rumah" di EJS:
//   - #custPPPoEAddSlot: di dalam pppoeFormBox (default position, untuk mode tambah baru)
//   - #custPPPoEEditSlot: di grid atas (untuk mode edit, supaya tetap terlihat saat pppoeCreateBox hidden)
//
// Ada SATU element <input id="custPPPoE">. Helper di bawah ini memindahkan
// element itu antar dua slot sesuai mode. Karena cuma satu element, tidak
// perlu sync value antara dua field.
function _movePppoeToEditSlot() {
  const input = document.getElementById('custPPPoE');
  const editSlot = document.getElementById('custPPPoEEditSlot');
  const addSlot = document.getElementById('custPPPoEAddSlot');
  if (!input || !editSlot) return;
  // Tampilkan edit slot, append element input ke sana (kalau belum)
  editSlot.style.display = '';
  if (input.parentElement !== editSlot) {
    editSlot.appendChild(input);
  }
  if (addSlot) addSlot.style.display = 'none';
}

function _movePppoeToAddSlot() {
  const input = document.getElementById('custPPPoE');
  const editSlot = document.getElementById('custPPPoEEditSlot');
  const addSlot = document.getElementById('custPPPoEAddSlot');
  if (!input || !addSlot) return;
  // Kembalikan element input ke posisi default-nya di pppoeFormBox
  addSlot.style.display = '';
  if (input.parentElement !== addSlot) {
    addSlot.appendChild(input);
  }
  if (editSlot) editSlot.style.display = 'none';
}

// ── EXPOSE ────────────────────────────────────────────────────
window.openAddCustomer = async function () {
  _custEditId = null;
  _pppoeManuallyEdited = false; // reset flag → auto-fill PPPoE dari nama aktif
  _originalPppoeUsername = '';   // tidak relevan di tambah baru
  _setText('customerModalTitle', 'Tambah Customer');
  // Pindahkan field PPPoE ke posisi mode Tambah (di dalam pppoeFormBox)
  _movePppoeToAddSlot();
  _clearForm();
  // Set default aktivasi = hari ini
  const today = new Date().toISOString().slice(0, 10);
  _setVal('custInstallDate', today);
  _setVal('custStatus', 'active');
  // Show checkbox WA welcome (default ON)
  const waBox = document.getElementById('waWelcomeBox');
  if (waBox) waBox.style.display = '';
  const waChk = document.getElementById('custSendWaWelcome');
  if (waChk) waChk.checked = true;
  // Show checkbox Email welcome (default ON)
  const emailBox = document.getElementById('emailWelcomeBox');
  if (emailBox) emailBox.style.display = '';
  const emailChk = document.getElementById('custSendEmailWelcome');
  if (emailChk) emailChk.checked = true;
  // Show panel PPPoE create (hanya untuk tambah baru, default OFF)
  const ppBox = document.getElementById('pppoeCreateBox');
  if (ppBox) ppBox.style.display = '';
  document.getElementById('customerModal').classList.add('active');
  custInitMap();
  await loadPackages();
  loadInfraParents(); // load opsi ODP/ODC/POP untuk dropdown parent
  _updateAutoInfraBanner();
  // Pasang listener lat/lng → toggle banner auto-infra (sekali saja per page life)
  if (!window._latLngBannerBound) {
    ['custLatitude','custLongitude'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', _updateAutoInfraBanner);
    });
    window._latLngBannerBound = true;
  }
  const idField = document.getElementById('custId');
  if (idField) { idField.readOnly = false; idField.placeholder = 'Kosongkan untuk otomatis...'; }
  const d = await App.api('/customers/next-id');
  if (d?.success) {
    _nextAutoId = d.customer_id;
    const el = document.getElementById('custId');
    if (el) el.placeholder = 'Kosongkan → otomatis: ' + d.customer_id;
    setIdStatus('hint', d.customer_id);
  }
};

window.closeModal = function () {
  document.getElementById('customerModal').classList.remove('active');
  // Reset panel portal supaya tidak bocor antar edit
  const ppBox = document.getElementById('portalPanelBox');
  if (ppBox) ppBox.style.display = 'none';
  const cidInput = document.getElementById('ppCid');
  if (cidInput) { cidInput.value=''; cidInput.readOnly=true; cidInput.style.background='#eef2f7'; cidInput.style.cursor='not-allowed'; }
  const cidBtn = document.getElementById('ppCidToggle');
  if (cidBtn) { cidBtn.textContent='Ubah'; cidBtn.style.color='#1a6ef5'; cidBtn.style.borderColor='#e4ecf7'; }
  const pwInput = document.getElementById('ppPw');
  if (pwInput) { pwInput.value=''; pwInput.type='password'; }
};

window.editCustomer = async function (id) {
  const data = await App.api('/customers/' + id);
  if (!data?.success) { App.showToast('Gagal memuat data', 'error'); return; }
  const c = data.data;
  _custEditId = c.id;
  // Bersihkan dulu semua field & dropdown wilayah supaya data pelanggan
  // sebelumnya tidak nyangkut saat membuka edit pelanggan lain.
  _clearForm();
  // Di mode edit: anggap PPPoE username sudah "manual" supaya auto-generate
  // dari nama TIDAK menimpa username yang sudah ada di customer ini.
  _pppoeManuallyEdited = true;
  _setText('customerModalTitle', 'Edit Customer');
  // Hide checkbox WA welcome di mode edit (hanya relevan untuk customer baru)
  const waBox = document.getElementById('waWelcomeBox');
  if (waBox) waBox.style.display = 'none';
  // Hide checkbox Email welcome di mode edit
  const emailBox = document.getElementById('emailWelcomeBox');
  if (emailBox) emailBox.style.display = 'none';
  // Hide panel PPPoE create di mode edit (PPPoE secret existing dikelola via halaman PPPoE Manager)
  const ppBox = document.getElementById('pppoeCreateBox');
  if (ppBox) ppBox.style.display = 'none';
  const cbPppoe = document.getElementById('custCreatePppoe');
  if (cbPppoe) cbPppoe.checked = false;
  const ppForm = document.getElementById('pppoeFormBox');
  if (ppForm) ppForm.style.display = 'none';
  // Pindahkan field PPPoE Username ke slot atas (di grid utama) supaya tetap
  // bisa di-edit user — karena pppoeCreateBox tertutup di mode edit.
  _movePppoeToEditSlot();

  _setVal('custName',        c.name            || '');
  _setVal('custPhone',       c.phone           || '');
  _setVal('custEmail',       c.email           || '');
  _setVal('custNik',         c.nik             || '');
  _setVal('custAddress',     c.address         || '');
  // Pulihkan dropdown wilayah dari kolom area tersimpan (province/regency/...)
  // Dicocokkan nama → kode emsifa secara berjenjang. Async, tidak memblok.
  custRestoreRegion(c.province, c.regency, c.district, c.village);
  _setVal('custPackage',     c.package_id      || '');
  _setVal('custDueDate',     c.due_date        || '');
  _setVal('custInstallDate', c.installation_date || '');
  _setVal('custPPPoE',       c.pppoe_username  || '');
  // Simpan value asli untuk deteksi perubahan di saveCustomer()
  _originalPppoeUsername = String(c.pppoe_username || '').trim();
  _setVal('custOntSn',       c.ont_sn          || '');
  _setVal('custStaticIP',    c.static_ip        || '');
  _setVal('custConnType',    c.connection_type  || '');
  _setVal('custMacAddress',  c.mac_address      || '');
  if (typeof onConnTypeChange === 'function') onConnTypeChange();
  // Set mikrotik dropdown
  const mkSel = document.getElementById('custMikrotikId');
  if (mkSel) mkSel.value = c.mikrotik_id || '';
  _setVal('custStatus',      c.status          || 'active');
  _setVal('custId',          c.customer_id     || '');
  // Koordinat peta — populate dari customer record (sebelumnya tidak ke-load)
  _setVal('custLatitude',    c.latitude != null ? c.latitude : '');
  _setVal('custLongitude',   c.longitude != null ? c.longitude : '');
  setIdStatus('existing', c.customer_id);
  const idField = document.getElementById('custId');
  if (idField) idField.readOnly = true;
  await loadPackages();
  _setVal('custPackage', c.package_id || '');
  // Load Parent ODP dropdown + preselect dari c.infra_parent_id
  loadInfraParents(c.infra_parent_id);
  _updateAutoInfraBanner();

  // Tampilkan panel akses portal & load creds (hanya di mode edit)
  const portalBox = document.getElementById('portalPanelBox');
  if (portalBox) portalBox.style.display = 'block';
  ppLoadCredentials(c.id);

  document.getElementById('customerModal').classList.add('active');
  custInitMap();
};

window.toggleIsolate = async function (id, action) {
  const label = action === 'isolate' ? 'Isolir' : 'Aktifkan';
  if (!confirm(label + ' customer ini?')) return;
  const data = await App.api('/customers/' + id, { method:'PUT', body:JSON.stringify({ status: action === 'isolate' ? 'isolated' : 'active' }) });
  if (data?.success) { loadCustomers(); loadCustomerStats(); App.showToast('Customer ' + label.toLowerCase() + 'd', 'success'); }
  else App.showToast(data?.message || 'Gagal', 'error');
};

// ─────────────────────────────────────────────────────────────────────
// Modal konfirmasi hapus customer dengan opsi sync ke router MikroTik.
//
// Dipanggil oleh deleteCustomer(). Return Promise<'sync' | 'db_only' | 'cancel'>:
//   - 'sync'    : hapus customer di FLAYNET + hapus secret PPPoE di router
//   - 'db_only' : hapus customer di FLAYNET saja (secret router tidak disentuh)
//   - 'cancel'  : batalkan, tidak menghapus apa-apa
//
// Param `customer` adalah object minimal { id, name, pppoe_username, mikrotik_id, mikrotik_name }.
// Kalau customer tidak punya pppoe_username + mikrotik_id, tombol "sync" di-disable.
// ─────────────────────────────────────────────────────────────────────
function _confirmCustomerDelete(customer) {
  return new Promise((resolve) => {
    const hasPppoe = !!(customer.pppoe_username && String(customer.pppoe_username).trim());
    const hasRouter = !!customer.mikrotik_id;
    const canSync = hasPppoe && hasRouter;

    // Build reason kalau tidak bisa sync
    let syncDisabledReason = '';
    if (!hasPppoe && !hasRouter) syncDisabledReason = 'Customer tidak punya PPPoE username & router';
    else if (!hasPppoe)          syncDisabledReason = 'Customer tidak punya PPPoE username';
    else if (!hasRouter)         syncDisabledReason = 'Customer tidak punya router MikroTik terhubung';

    const overlay = document.createElement('div');
    overlay.id = '__custDeleteModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;';
    box.innerHTML = `
      <div style="padding:18px 22px 14px;border-bottom:1px solid #f1f5f9;">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg width="22" height="22" fill="none" stroke="#dc2626" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          <div style="font-size:15px;font-weight:700;color:#0f172a;">Hapus Customer</div>
        </div>
      </div>
      <div style="padding:18px 22px;font-size:13px;color:#334155;line-height:1.6;">
        <div style="margin-bottom:10px;">Anda akan menghapus customer:</div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:14px;">
          <div style="font-weight:600;color:#0f172a;font-size:13.5px;">${_esc(customer.name)}</div>
          ${hasPppoe ? `<div style="font-size:12px;color:#64748b;font-family:'DM Mono',monospace;margin-top:3px;">PPPoE: ${_esc(customer.pppoe_username)}</div>` : ''}
          ${hasRouter ? `<div style="font-size:11.5px;color:#64748b;margin-top:2px;">Router: ${customer.mikrotik_name ? _esc(customer.mikrotik_name) : `<span style="color:#94a3b8;">ID #${_esc(customer.mikrotik_id)}</span>`}</div>` : ''}
        </div>
        ${canSync ? `
          <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.5;margin-bottom:6px;">
            <strong>Apa yang ingin Anda lakukan?</strong><br>
            Tanpa hapus secret di router, customer mungkin masih bisa login PPPoE meski sudah dihapus di FLAYNET.
          </div>` : `
          <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;font-size:12px;color:#475569;line-height:1.5;margin-bottom:6px;">
            ${syncDisabledReason}, jadi tidak ada secret di router yang perlu dihapus.
          </div>`}
      </div>
      <div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #f1f5f9;display:flex;flex-direction:column;gap:8px;">
        <button id="__custDelSync" ${canSync ? '' : 'disabled'}
          style="background:${canSync ? '#dc2626' : '#cbd5e1'};color:#fff;border:none;border-radius:8px;padding:11px 14px;font-size:13px;font-weight:600;cursor:${canSync ? 'pointer' : 'not-allowed'};text-align:left;line-height:1.4;opacity:${canSync ? 1 : 0.6};">
          <div>✗ Hapus customer &amp; secret di router MikroTik</div>
          <div style="font-size:11px;font-weight:400;opacity:.9;margin-top:2px;">${canSync ? 'Sync penuh. Customer langsung disconnect, tidak bisa login lagi.' : syncDisabledReason}</div>
        </button>
        <button id="__custDelDbOnly" style="background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;padding:11px 14px;font-size:13px;font-weight:600;cursor:pointer;text-align:left;line-height:1.4;">
          <div>Hapus dari database saja (tanpa sentuh router)</div>
          <div style="font-size:11px;font-weight:400;color:#64748b;margin-top:2px;">${hasPppoe ? 'Pilih ini kalau Anda sudah hapus secret manual via Winbox.' : 'Hanya hapus record di database FLAYNET.'}</div>
        </button>
        <button id="__custDelCancel" style="background:#fff;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;padding:9px 14px;font-size:12.5px;font-weight:500;cursor:pointer;margin-top:2px;">
          Batal
        </button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => { try { document.body.removeChild(overlay); } catch (e) {} };
    const syncBtn = document.getElementById('__custDelSync');
    if (canSync) syncBtn.onclick = () => { cleanup(); resolve('sync'); };
    document.getElementById('__custDelDbOnly').onclick = () => { cleanup(); resolve('db_only'); };
    document.getElementById('__custDelCancel').onclick = () => { cleanup(); resolve('cancel'); };
    const escHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', escHandler); resolve('cancel'); }
    };
    document.addEventListener('keydown', escHandler);
  });
}

window.deleteCustomer = async function (id, name) {
  // Fetch detail customer dulu untuk dapat pppoe_username + mikrotik_id
  // (info ini dipakai modal untuk putuskan apakah opsi sync available)
  let detail = { id, name, pppoe_username: null, mikrotik_id: null, mikrotik_name: null };
  try {
    const res = await App.api('/customers/' + id);
    if (res?.success && res.data) {
      const c = res.data;
      detail = {
        id,
        name: c.name || name,
        pppoe_username: c.pppoe_username || null,
        mikrotik_id: c.mikrotik_id || null,
        // Coba ambil nama dari embedded mikrotik object (kalau backend show() versi
        // terbaru di-deploy). Fallback: null → akan di-fetch via /devices/:id di bawah.
        mikrotik_name: c.mikrotik?.name || c.mikrotik?.host || null,
      };

      // FALLBACK: kalau customer punya mikrotik_id tapi nama router tidak ada
      // di response (backend versi lama, atau Device sudah dihapus), coba fetch
      // langsung via endpoint /devices/:id. Ini bikin display tetap ramah user
      // meski deployment belum sinkron.
      if (detail.mikrotik_id && !detail.mikrotik_name) {
        try {
          const dres = await App.api('/devices/' + detail.mikrotik_id);
          if (dres?.success && dres.data) {
            detail.mikrotik_name = dres.data.name || dres.data.host || null;
          }
        } catch (e2) {
          console.warn('[deleteCustomer] Gagal fetch device detail:', e2.message);
        }
      }
    }
  } catch (e) {
    console.warn('[deleteCustomer] Gagal fetch detail:', e.message, '— lanjut dengan info minimal');
  }

  // Tampilkan modal konfirmasi
  const choice = await _confirmCustomerDelete(detail);
  if (choice === 'cancel') return;

  // Panggil DELETE endpoint dengan flag sesuai pilihan
  const url = '/customers/' + id;
  const data = await App.api(url, {
    method: 'DELETE',
    body: JSON.stringify({ delete_router_secret: (choice === 'sync') })
  });

  if (data && data.success) {
    loadCustomers();
    loadCustomerStats();
    // Toast informatif tergantung status router
    let toastMsg = 'Customer dihapus';
    let toastType = 'success';
    if (choice === 'sync') {
      if (data.router_status === 'deleted')   toastMsg = `Customer & secret di router dihapus (${detail.pppoe_username})`;
      else if (data.router_status === 'not_found') {
        toastMsg = `Customer dihapus. Secret di router sudah tidak ada (mungkin sudah dihapus manual sebelumnya).`;
        toastType = 'info';
      }
    } else {
      toastMsg = 'Customer dihapus dari database (router tidak disentuh)';
      toastType = 'info';
    }
    App.showToast(toastMsg, toastType);
  } else {
    App.showToast((data && data.message) || 'Gagal menghapus', 'error');
  }
};

window.syncDueDates = async function() {
  // Konfirmasi generate invoice bulan ini
  const now   = new Date();
  const bulan = now.toLocaleString('id-ID', { month: 'long' });
  const tahun = now.getFullYear();

  showConfirmModal(
    'Generate Invoice Bulanan',
    'Generate invoice untuk semua pelanggan aktif periode <strong>' + bulan + ' ' + tahun + '</strong>?<br><small style="color:#64748b">Invoice yang sudah ada akan dilewati (skip).</small>',
    'calendar',
    '#1a6ef5',
    async function() {
      const btn = document.getElementById('btnSyncDue');
      if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" style="animation:spin .7s linear infinite"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Memproses...'; }
      const res = await App.api('/billing/generate', { method: 'POST', body: JSON.stringify({ month: now.getMonth()+1, year: tahun }) });
      // Sinkronisasi due_date invoice dari customer.due_date
      await App.api('/billing/sync-due-dates', { method: 'POST' }).catch(function(){});
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span>Auto Due Date</span>'; }
      if (res && res.success) {
        var d = res.data || {};
        App.showToast('✓ Invoice dibuat: ' + (d.created||0) + ', dilewati: ' + (d.skipped||0) + ' · Due date tersinkron', 'success');
        loadCustomers(); loadCustomerStats();
      } else {
        App.showToast('Gagal: ' + ((res && res.message) || 'Error'), 'error');
      }
    }
  );
};

/* ── Confirm Modal ──────────────────────────────────────────── */
function showConfirmModal(title, body, iconType, accentColor, onConfirm) {
  // Remove existing
  var existing = document.getElementById('_confirmModal');
  if (existing) existing.remove();

  var iconSvg = iconType === 'trash'
    ? '<svg width="22" height="22" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24"><polyline points="3,6 5,6 21,6"/><path d="M19,6l-1,14a2,2,0,0,1-2,2H8a2,2,0,0,1-2-2L5,6"/><path d="M10,11v6"/><path d="M14,11v6"/><path d="M9,6V4a1,1,0,0,1,1-1h4a1,1,0,0,1,1,1v2"/></svg>'
    : '<svg width="22" height="22" fill="none" stroke="white" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

  var btnLabel  = iconType === 'trash' ? 'Hapus' : 'Generate';
  var btnColor  = accentColor || '#ef4444';

  var el = document.createElement('div');
  el.id  = '_confirmModal';
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(13,27,62,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .15s ease';

  el.innerHTML = '<div style="background:#fff;border-radius:20px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 24px 80px rgba(13,27,62,.25);animation:slideUp .2s ease">'
    + '<div style="background:'+btnColor+';padding:20px 22px 16px;display:flex;align-items:center;gap:12px;">'
      + '<div style="width:42px;height:42px;background:rgba(255,255,255,.2);border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0">'+iconSvg+'</div>'
      + '<div style="font-size:15px;font-weight:800;color:#fff">'+title+'</div>'
    + '</div>'
    + '<div style="padding:20px 22px;font-size:13.5px;color:#374151;line-height:1.6">'+body+'</div>'
    + '<div style="display:flex;gap:10px;padding:0 22px 20px;justify-content:flex-end">'
      + '<button id="_confirmCancel" style="padding:9px 20px;border:1.5px solid #e2e8f0;border-radius:10px;background:#fff;color:#64748b;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit">Batal</button>'
      + '<button id="_confirmOk" style="padding:9px 20px;border:none;border-radius:10px;background:'+btnColor+';color:#fff;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;box-shadow:0 3px 10px '+btnColor+'44">'+btnLabel+'</button>'
    + '</div>'
  + '</div>';

  // CSS animations
  if (!document.getElementById('_confirmStyles')) {
    var s = document.createElement('style');
    s.id  = '_confirmStyles';
    s.textContent = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  document.body.appendChild(el);

  document.getElementById('_confirmCancel').onclick = function() { el.remove(); };
  document.getElementById('_confirmOk').onclick = function() {
    el.remove();
    onConfirm();
  };
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });
}

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadMikrotikDevices();
  if (typeof App !== 'undefined') App.init();
  loadCustomerStats();

  // Deep-link: auto-apply filter dari URL query param `?status=active`
  // Dipakai NOC Dashboard untuk link langsung ke filter tertentu.
  try {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const sel = document.getElementById('filterStatus');
    if (status && sel) {
      // Cek dulu apakah value ada di option
      const validValues = Array.from(sel.options).map(o => o.value);
      if (validValues.includes(status)) {
        sel.value = status;
      }
    }
  } catch(_) { /* abaikan */ }

  loadCustomers();
  setupSearch();
  loadFilterProvinces();
});

window.applyFilter = function(status) {
  const sel = document.getElementById('filterStatus');
  if (sel) sel.value = status;
  _custPage = 1;
  loadCustomers();
};

function setupSearch() {
  const s  = document.getElementById('searchCustomer');
  const f  = document.getElementById('filterStatus');
  const fd = document.getElementById('filterDue');
  if (s)  s.addEventListener('input', _debounce(() => { _custPage = 1; loadCustomers(); }, 350));
  if (f)  f.addEventListener('change', () => { _custPage = 1; loadCustomers(); });
  if (fd) fd.addEventListener('change', () => { _custPage = 1; loadCustomers(); });
}

// ── STATS ─────────────────────────────────────────────────────
async function loadCustomerStats() {
  const d = await App.api('/customers/stats');
  if (!d?.success) return;
  const s        = d.data;
  const total    = s.total    || 0;
  const active   = s.active   || 0;
  const overdue  = s.overdue  || 0;
  const dueSoon  = s.due_soon || 0;
  const inactive = (s.inactive || 0) + (s.suspended || 0);
  const isolated = s.isolated || 0;

  _setText('scTotal',      total);
  _setText('scTotalSub',   active + ' aktif · ' + inactive + ' nonaktif');
  _setBar ('scTotalBar',   total > 0 ? 0.99 : 0);
  _setText('scTotalPct',   active + ' aktif · ' + isolated + ' isolir');

  _setText('scOverdue',    overdue);
  _setBar ('scOverdueBar', overdue / Math.max(total, 1));
  _setText('scOverduePct', overdue > 0
    ? Math.round(overdue / Math.max(active, 1) * 100) + '% dari pelanggan aktif'
    : 'Tidak ada overdue');

  _setText('scDueSoon',    dueSoon);
  _setBar ('scDueSoonBar', dueSoon / Math.max(active, 1));
  _setText('scDueSoonPct', dueSoon > 0
    ? dueSoon + ' akan jatuh tempo dalam 3 hari'
    : 'Tidak ada mendekati jatuh tempo');

  // Card 4: Revenue
  const rev = s.monthly_revenue || 0;
  let revFmt = 'Rp 0';
  if (rev >= 1000000)  revFmt = 'Rp ' + (rev/1000000).toFixed(1).replace('.0','') + 'jt';
  else if (rev >= 1000) revFmt = 'Rp ' + Math.round(rev/1000) + 'rb';
  else if (rev > 0)    revFmt = 'Rp ' + Math.round(rev).toLocaleString('id-ID');
  _setText('scRevenue',    revFmt);
  _setBar ('scRevenueBar', active > 0 ? Math.min((rev / (active * 200000)), 1) : 0);
  _setText('scRevenuePct', rev > 0
    ? 'Estimasi dari ' + active + ' pelanggan aktif'
    : (active > 0 ? 'Pelanggan aktif belum punya paket' : 'Belum ada pelanggan aktif'));

  // Hidden stubs
  _setText('scActive',     active);
  _setText('scInactive',   inactive);
  _setText('scNoDue',      Math.max(0, total - active));
  _setText('scIsolated',   isolated + inactive);
  _setText('scActiveSub',  Math.round(active / Math.max(total,1)*100) + '% dari total ' + total);
  _setText('scTotal2',     total);

  const subtitle = document.getElementById('headerSubtitle');
  if (subtitle) subtitle.textContent = 'Manajemen pelanggan, terdapat ' + total + ' customer terdaftar';
}

function _setBar(id, ratio) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.min(Math.max(ratio * 100, 2), 100) + '%';
}

function _setPct(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── LIST ──────────────────────────────────────────────────────
async function loadCustomers() {
  const search = document.getElementById('searchCustomer')?.value || '';
  const status = document.getElementById('filterStatus')?.value   || '';
  const prov   = document.getElementById('filterProvince')?.value || '';
  const reg    = document.getElementById('filterRegency')?.value  || '';
  const dist   = document.getElementById('filterDistrict')?.value || '';
  const data   = await App.api('/customers?page=' + _custPage + '&limit=20'
    + '&search=' + encodeURIComponent(search)
    + '&status=' + status
    + '&province=' + encodeURIComponent(prov)
    + '&regency='  + encodeURIComponent(reg)
    + '&district=' + encodeURIComponent(dist));
  const tbody  = document.getElementById('customerTable');
  const countEl= document.getElementById('customerCount');

  if (!data?.success) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="empty-state"><p style="color:var(--danger);">Gagal memuat data</p></td></tr>';
    return;
  }

  const total = data.pagination?.total || 0;
  if (countEl) countEl.textContent = total + ' pelanggan';

  if (!data.data?.length) {
    if (tbody) tbody.innerHTML =
      '<tr><td colspan="9">' +
        '<div class="empty-state" style="padding:48px 16px;text-align:center;color:#94a3b8;">' +
          '<svg width="56" height="56" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display:block;margin:0 auto 12px;color:#cbd5e1;">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0"/>' +
          '</svg>' +
          '<p style="margin:0;font-size:13.5px;color:#64748b;">Tidak ada data customer</p>' +
        '</div>' +
      '</td></tr>';
    _renderPagination(0, 20);
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);

  tbody.innerHTML = data.data.map(function(c) {
    var hash = 0;
    for (var i = 0; i < (c.name||'').length; i++) hash = ((hash<<5)-hash) + c.name.charCodeAt(i);
    var color   = AVATAR_BG[Math.abs(hash) % AVATAR_BG.length];
    var initial = (c.name||'?')[0].toUpperCase();

    // due_date langsung dari kolom customers.due_date
    // Tidak perlu kalkulasi — sudah di-set via form atau migration
    if (!c.latest_due_date && c.due_date) {
      c.latest_due_date = c.due_date;
    }

    var dueDateHtml = '<span style="color:#94a3b8">–</span>';
    if (c.latest_due_date) {
      var due      = new Date(c.latest_due_date+'T00:00:00');
      var diffDays = Math.round((due - today)/86400000);
      var fmtDue   = due.toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'});
      if (c.latest_invoice_status === 'paid') {
        dueDateHtml = fmtDue+' <span style="font-size:10px;background:#f0fdf4;color:#16a34a;padding:1px 6px;border-radius:4px;font-weight:700">Lunas</span>';
      } else if (diffDays < 0) {
        dueDateHtml = '<span style="color:#dc2626;font-weight:600">'+fmtDue+'</span><br><span style="font-size:10px;color:#dc2626">'+Math.abs(diffDays)+' hari lalu</span>';
      } else if (diffDays === 0) {
        dueDateHtml = '<span style="color:#ea580c;font-weight:600">'+fmtDue+'</span><br><span style="font-size:10px;color:#ea580c">Hari ini!</span>';
      } else if (diffDays <= 3) {
        dueDateHtml = '<span style="color:#d97706;font-weight:600">'+fmtDue+'</span><br><span style="font-size:10px;color:#d97706">'+diffDays+' hari lagi</span>';
      } else {
        dueDateHtml = fmtDue;
      }
    }

    // Status badge
    var dueCk  = c.latest_due_date ? new Date(c.latest_due_date+'T00:00:00') : null;
    var diffCk = dueCk ? Math.round((dueCk - today)/86400000) : null;
    // Status sinkron dengan invoice: overdue = ada invoice unpaid & due sudah lewat
    var isOv = (c.latest_invoice_status === 'overdue') && c.status === 'active';
    var isDs = (c.latest_invoice_status === 'unpaid')  && c.status === 'active' && diffCk !== null && diffCk >= 0 && diffCk <= 3;

    var stCls = 'sb-inactive', stDot = '#94a3b8', stLabel = c.status||'–';
    if      (isOv)                   { stCls='sb-overdue';  stDot='#dc2626'; stLabel='Overdue'; }
    else if (isDs)                   { stCls='sb-due-soon'; stDot='#ea580c'; stLabel='Due Soon'; }
    else if (c.status==='active')    { stCls='sb-active';   stDot='#16a34a'; stLabel='Aktif'; }
    else if (c.status==='isolated')  { stCls='sb-suspended';stDot='#dc2626'; stLabel='Isolir'; }
    else if (c.status==='suspended') { stCls='sb-suspended';stDot='#dc2626'; stLabel='Suspended'; }

    var price = (c.package && c.package.price)
      ? 'Rp '+Number(c.package.price).toLocaleString('id-ID')
      : (c.monthly_fee ? 'Rp '+Number(c.monthly_fee).toLocaleString('id-ID') : '–');

    var isoBtn = '';
    if (c.status==='active')   isoBtn = '<button class="rb rb-iso" onclick="toggleIsolate('+c.id+',\'isolate\')">Isolir</button>';
    if (c.status==='isolated') isoBtn = '<button class="rb rb-act" onclick="toggleIsolate('+c.id+',\'activate\')">Aktifkan</button>';

    var addrShort = c.address ? _esc(c.address.substring(0,30))+(c.address.length>30?'...':'') : '';
    var pkgName   = (c.package && c.package.name) ? _esc(c.package.name) : (c.package_name ? _esc(c.package_name) : '–');
    var actDate   = c.installation_date ? new Date(c.installation_date).toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'}) : '–';

    return '<tr data-id="'+c.id+'">'
      + '<td><span class="cid-badge">'+_esc(c.customer_id)+'</span></td>'
      + '<td>'
        + '<div style="display:flex;align-items:center;gap:11px">'
          + '<div class="av-circle" style="background:'+color+'">'+initial+'</div>'
          + '<div>'
            + '<a href="/customers/profile/'+c.id+'" class="cust-name-link">'+_esc(c.name)+'</a>'
            + (addrShort ? '<div style="font-size:11px;color:#6b7fa8;margin-top:1px;max-width:160px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">'+addrShort+'</div>' : '')
          + '</div>'
        + '</div>'
      + '</td>'
      + '<td style="color:#6b7fa8">'+_esc(c.phone||'–')+'</td>'
      + '<td>'
        + '<div style="font-weight:600;font-size:13px;color:#0d1b3e">'+pkgName+'</div>'
        + (c.pppoe_username ? '<div style="font-size:10px;color:#94a3b8;font-family:monospace">'+_esc(c.pppoe_username)+'</div>' : '')
        + (c.static_ip ? '<div style="font-size:10px;color:#2563eb;font-family:monospace">IP: '+_esc(c.static_ip)+'</div>' : '')
      + '</td>'
      + '<td style="font-weight:700;color:#1a6ef5;font-size:13px">'+price+'</td>'
      + '<td style="color:#6b7fa8">'+actDate+'</td>'
      + '<td><div style="line-height:1.5">'+dueDateHtml+'</div></td>'
      + '<td><span class="sb '+stCls+'"><span class="sb-dot" style="background:'+stDot+'"></span>'+stLabel+'</span></td>'
      + '<td style="text-align:right;padding-right:18px">'
        + '<div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">'
          + '<button class="rb rb-wa" onclick="sendWA(\''+_esc(c.phone||'')+'\')" >WA</button>'
          + '<button class="rb rb-edit" onclick="editCustomer('+c.id+')">Edit</button>'
          + isoBtn
          + '<button class="rb rb-del" onclick="deleteCustomer('+c.id+',\''+_esc(c.name)+'\')" title="Hapus">'
            + '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">'
            + '<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>'
            + '</svg></button>'
        + '</div>'
      + '</td>'
    + '</tr>';
  }).join('');

  _renderPagination(total, 20);
}

function sendWA(phone) {
  if (!phone) { App.showToast('Nomor HP tidak tersedia', 'error'); return; }
  let n = phone.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  window.open('https://wa.me/' + n, '_blank');
}
window.sendWA = sendWA;

// ── PACKAGES ─────────────────────────────────────────────────
async function loadPackages() {
  const data = await App.api('/packages');
  const sel  = document.getElementById('custPackage');
  if (!sel || !data?.success) return;
  sel.innerHTML = '<option value="">Pilih paket</option>' +
    data.data.map(p => '<option value="' + p.id + '">' + _esc(p.name) + ' — Rp ' + Number(p.price).toLocaleString('id-ID') + '/bln</option>').join('');
}

// ── Load Parent ODP/ODC/POP untuk dropdown ────────────────────
// Dipanggil saat modal customer dibuka (tambah baru / edit). Cache hasilnya
// di window agar tidak fetch ulang kalau modal dibuka berkali-kali dalam
// sesi yang sama. Refresh otomatis kalau cache > 5 menit.
const _INFRA_PARENT_CACHE_TTL = 5 * 60 * 1000;
let _infraParentCache = null;
let _infraParentCacheTs = 0;

async function loadInfraParents(preselectId) {
  const sel = document.getElementById('custInfraParentId');
  if (!sel) return;

  const now = Date.now();
  let data;
  if (_infraParentCache && (now - _infraParentCacheTs) < _INFRA_PARENT_CACHE_TTL) {
    data = _infraParentCache;
  } else {
    const res = await App.api('/infrastructure/parent-options');
    if (!res?.success) return;
    data = res.data || [];
    _infraParentCache = data;
    _infraParentCacheTs = now;
  }

  // Group by type biar mudah dibaca: POP → ODC → ODP
  const typeLabel = { pop: 'POP', odc: 'ODC', odp: 'ODP' };
  const order = ['pop', 'odc', 'odp'];
  let html = '<option value="">— Tanpa parent —</option>';
  order.forEach(t => {
    const items = data.filter(p => p.type === t);
    if (items.length === 0) return;
    html += '<optgroup label="' + typeLabel[t] + '">';
    items.forEach(p => {
      html += '<option value="' + p.id + '">' + _esc(p.name) + '</option>';
    });
    html += '</optgroup>';
  });
  sel.innerHTML = html;
  if (preselectId) sel.value = String(preselectId);
}

// Helper: cek apakah koord valid (untuk show/hide info banner auto-infra).
function _updateAutoInfraBanner() {
  const lat = document.getElementById('custLatitude')?.value?.trim();
  const lng = document.getElementById('custLongitude')?.value?.trim();
  const banner = document.getElementById('custAutoInfraInfo');
  if (!banner) return;
  const valid = lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
  banner.style.display = valid ? '' : 'none';
}

// ── SAVE ─────────────────────────────────────────────────────
let _custSaving = false;  // re-entry guard — cegah double-submit dari double-binding/dbl-click

// ─────────────────────────────────────────────────────────────────────
// Modal konfirmasi PPPoE username rename.
// Dipanggil di mode EDIT saat user mengubah pppoe_username dari value asli.
//
// Return Promise<'sync' | 'db_only' | 'cancel'>:
//   - 'sync'    : update DB + rename secret di router MikroTik
//   - 'db_only' : update DB saja (user sudah rename manual di Winbox, dll)
//   - 'cancel'  : batalkan save, kembali ke form
//
// Pakai overlay HTML inline (tidak perlu modal terpisah di EJS).
// ─────────────────────────────────────────────────────────────────────
function _confirmPppoeRename(oldName, newName) {
  return new Promise((resolve) => {
    // Build modal overlay
    const overlay = document.createElement('div');
    overlay.id = '__pppoeRenameModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:14px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;';
    box.innerHTML = `
      <div style="padding:18px 22px 14px;border-bottom:1px solid #f1f5f9;">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg width="22" height="22" fill="none" stroke="#d97706" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          </svg>
          <div style="font-size:15px;font-weight:700;color:#0f172a;">PPPoE Username Berubah</div>
        </div>
      </div>
      <div style="padding:18px 22px;font-size:13px;color:#334155;line-height:1.6;">
        <div style="margin-bottom:12px;">Anda mengubah PPPoE username:</div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-family:'DM Mono',monospace;font-size:12.5px;margin-bottom:14px;">
          <div style="color:#64748b;"><span style="color:#94a3b8;">lama:</span> ${_esc(oldName) || '<i style="font-style:italic">(kosong)</i>'}</div>
          <div style="color:#0f172a;font-weight:600;margin-top:4px;"><span style="color:#94a3b8;font-weight:400;">baru:</span> ${_esc(newName)}</div>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:12px;color:#92400e;line-height:1.5;margin-bottom:6px;">
          <strong>Apa yang ingin Anda lakukan?</strong><br>
          Tanpa sync ke router, data di FLAYNET dan MikroTik akan tidak konsisten.
        </div>
      </div>
      <div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #f1f5f9;display:flex;flex-direction:column;gap:8px;">
        <button id="__ppRenameSync" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:11px 14px;font-size:13px;font-weight:600;cursor:pointer;text-align:left;line-height:1.4;">
          <div>✓ Update DB &amp; rename di router MikroTik</div>
          <div style="font-size:11px;font-weight:400;opacity:.85;margin-top:2px;">Sinkron otomatis. Customer mungkin disconnect sementara.</div>
        </button>
        <button id="__ppRenameDbOnly" style="background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;padding:11px 14px;font-size:13px;font-weight:600;cursor:pointer;text-align:left;line-height:1.4;">
          <div>Update database saja (tanpa sentuh router)</div>
          <div style="font-size:11px;font-weight:400;color:#64748b;margin-top:2px;">Pilih ini kalau Anda sudah rename manual di Winbox/router.</div>
        </button>
        <button id="__ppRenameCancel" style="background:#fff;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;padding:9px 14px;font-size:12.5px;font-weight:500;cursor:pointer;margin-top:2px;">
          Batal — kembali ke form
        </button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => { try { document.body.removeChild(overlay); } catch (e) {} };
    document.getElementById('__ppRenameSync').onclick    = () => { cleanup(); resolve('sync'); };
    document.getElementById('__ppRenameDbOnly').onclick  = () => { cleanup(); resolve('db_only'); };
    document.getElementById('__ppRenameCancel').onclick  = () => { cleanup(); resolve('cancel'); };
    // ESC = cancel
    const escHandler = (e) => {
      if (e.key === 'Escape') { cleanup(); document.removeEventListener('keydown', escHandler); resolve('cancel'); }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// Helper escape HTML untuk modal di atas — pakai _esc yang sudah ada di file ini.

async function saveCustomer() {
  if (_custSaving) {
    console.warn('[Customer] saveCustomer dipanggil saat masih in-flight, skip');
    return;
  }
  _custSaving = true;

  try {
    await _saveCustomerInner();
  } finally {
    _custSaving = false;
  }
}

async function _saveCustomerInner() {
  const btn  = document.getElementById('saveCustomerBtn');
  const name = document.getElementById('custName')?.value?.trim();
  if (!name) { App.showToast('Nama customer wajib diisi', 'error'); return; }

  const custId = document.getElementById('custId')?.value?.trim().toUpperCase() || '';
  if (!_custEditId && custId) {
    const checkD = await App.api('/customers/check-id?customer_id=' + encodeURIComponent(custId));
    if (!checkD?.available) {
      App.showToast('ID ' + custId + ' sudah digunakan, pilih ID lain', 'error');
      return;
    }
  }

  // ═══ Validasi PPPoE create (kalau diaktifkan, hanya saat tambah baru) ═══
  const createPppoe = !_custEditId
    && !!document.getElementById('custCreatePppoe')?.checked;

  let pppoeData = null;
  if (createPppoe) {
    const mkId        = document.getElementById('custPppoeRouter')?.value?.trim() || '';
    const pppoeUser   = document.getElementById('custPPPoE')?.value?.trim() || '';
    const pppoePass   = document.getElementById('custPppoePassword')?.value?.trim() || '';
    const pppoeProf   = document.getElementById('custPppoeProfile')?.value?.trim() || '';
    const pppoeSvc    = document.getElementById('custPppoeService')?.value || 'pppoe';
    const pppoeLocal  = document.getElementById('custPppoeLocalAddr')?.value?.trim() || '';
    const pppoeRemote = document.getElementById('custPppoeRemoteAddr')?.value?.trim() || '';

    if (!mkId)      { App.showToast('Pilih Router MikroTik untuk PPPoE', 'error'); return; }
    if (!pppoeUser) { App.showToast('PPPoE Username wajib diisi', 'error'); return; }
    if (!pppoePass) { App.showToast('Password PPPoE wajib diisi', 'error'); return; }
    if (!pppoeProf) { App.showToast('Pilih Profile PPPoE', 'error'); return; }

    pppoeData = {
      device_id:     mkId,
      name:          pppoeUser,
      password:      pppoePass,
      profile:       pppoeProf,
      service:       pppoeSvc,
      localAddress:  pppoeLocal,
      remoteAddress: pppoeRemote,
      comment:       (custId ? custId + ' — ' : '') + name
    };
  }

  btn.disabled = true; btn.textContent = 'Menyimpan...';

  // ═══ STEP 1: Buat akun PPPoE di MikroTik dulu (kalau diminta) ═══
  // Alasan: kalau gagal, jangan lanjutkan create customer (rollback gampang).
  let pppoeStatus = 'skipped';
  if (pppoeData) {
    btn.textContent = 'Membuat akun PPPoE...';
    try {
      const url = '/mikrotik/pppoe/secrets?device_id=' + encodeURIComponent(pppoeData.device_id);
      const ppRes = await App.api(url, {
        method: 'POST',
        body: JSON.stringify({
          name:          pppoeData.name,
          password:      pppoeData.password,
          profile:       pppoeData.profile,
          service:       pppoeData.service,
          localAddress:  pppoeData.localAddress,
          remoteAddress: pppoeData.remoteAddress,
          comment:       pppoeData.comment
        })
      });
      if (!ppRes?.success) {
        const errMsg = ppRes?.message || 'Gagal membuat akun PPPoE';
        App.showToast('PPPoE gagal: ' + errMsg + '. Customer TIDAK disimpan.', 'error');
        btn.disabled = false; btn.textContent = 'Simpan Customer';
        return;
      }
      pppoeStatus = 'created';
    } catch (e) {
      App.showToast('PPPoE gagal: ' + e.message + '. Customer TIDAK disimpan.', 'error');
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      return;
    }
  }

  // ═══ STEP 2: Simpan customer ═══
  btn.textContent = 'Menyimpan customer...';

  const phone = document.getElementById('custPhone')?.value || '';
  // Flag kirim WA welcome — hanya relevan saat tambah baru, dan customer punya HP
  const sendWA = !_custEditId
    && !!document.getElementById('custSendWaWelcome')?.checked
    && !!phone.trim();
  // Flag kirim Email welcome — hanya relevan saat tambah baru, dan customer punya email
  const custEmailVal = document.getElementById('custEmail')?.value || '';
  const sendEmail = !_custEditId
    && !!document.getElementById('custSendEmailWelcome')?.checked
    && !!custEmailVal.trim();

  // ═══ STEP 2a: Intercept PPPoE username rename di mode EDIT ═══
  // Kalau user mengubah pppoe_username dari value aslinya, butuh konfirmasi
  // apakah harus sync ke router MikroTik atau hanya update DB. Hal ini supaya
  // tidak terjadi desync silent antara DB FLAYNET dan secret di router.
  //
  // Skip modal kalau:
  //   - Mode tambah baru (bukan edit)
  //   - Value tidak berubah dari original
  //   - Original kosong (user isi pertama kali → tidak ada secret lama untuk rename,
  //     cukup catat di DB via PUT generic biasa)
  const currentPppoe = (document.getElementById('custPPPoE')?.value || '').trim();
  let pppoeRenameHandled = false; // kalau true → jangan kirim pppoe_username di body PUT

  if (_custEditId && _originalPppoeUsername && currentPppoe !== _originalPppoeUsername) {
    // Show modal konfirmasi
    const choice = await _confirmPppoeRename(_originalPppoeUsername, currentPppoe);

    if (choice === 'cancel') {
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      return; // user batalkan — tidak save apa-apa
    }

    // User pilih 'sync' atau 'db_only' — panggil endpoint khusus
    btn.textContent = choice === 'sync' ? 'Sync ke router...' : 'Update database...';
    try {
      const renameRes = await App.api(`/customers/${_custEditId}/rename-pppoe`, {
        method: 'POST',
        body: JSON.stringify({
          new_username:   currentPppoe,
          sync_to_router: (choice === 'sync')
        })
      });
      if (!renameRes?.success) {
        App.showToast('Rename PPPoE gagal: ' + (renameRes?.message || 'Unknown error'), 'error');
        btn.disabled = false; btn.textContent = 'Simpan Customer';
        return;
      }
      // Update value original supaya tidak ditampilkan modal lagi kalau save dilanjut
      _originalPppoeUsername = currentPppoe;
      pppoeRenameHandled = true;

      // Toast info hasil rename (akan muncul sebelum toast main success di akhir)
      App.showToast(renameRes.message, choice === 'sync' ? 'success' : 'info');
    } catch (err) {
      App.showToast('Rename PPPoE error: ' + err.message, 'error');
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      return;
    }
  }

  // Parse koordinat — kirim null kalau kosong (bukan string kosong) agar
  // backend bisa membedakan "user mengosongkan" vs "tidak diisi".
  const latStr = (document.getElementById('custLatitude')?.value || '').trim();
  const lngStr = (document.getElementById('custLongitude')?.value || '').trim();
  const latNum = latStr === '' ? null : parseFloat(latStr);
  const lngNum = lngStr === '' ? null : parseFloat(lngStr);
  // Validasi range (lenient: kalau invalid, kirim null + toast warning)
  let latitude = null, longitude = null;
  if (latNum != null) {
    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      App.showToast('Latitude harus angka -90 sampai 90', 'warning');
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      return;
    }
    latitude = latNum;
  }
  if (lngNum != null) {
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      App.showToast('Longitude harus angka -180 sampai 180', 'warning');
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      return;
    }
    longitude = lngNum;
  }
  const infraParentRaw = document.getElementById('custInfraParentId')?.value || '';
  const infraParentId = infraParentRaw ? parseInt(infraParentRaw) : null;

  const body = {
    name,
    customer_id:      custId || undefined,
    phone,
    email:            document.getElementById('custEmail')?.value    || '',
    nik:              (document.getElementById('custNik')?.value || '').trim() || null,
    province:         _custSelName('custProv') || null,
    regency:          _custSelName('custKab')  || null,
    district:         _custSelName('custKec')  || null,
    village:          _custSelName('custDesa') || null,
    address:          document.getElementById('custAddress')?.value  || '',
    package_id:       document.getElementById('custPackage')?.value  || null,
    due_date:         document.getElementById('custDueDate')?.value || null,
    installation_date:document.getElementById('custInstallDate')?.value || null,
    ont_sn:           document.getElementById('custOntSn')?.value    || '',
    static_ip:        document.getElementById('custStaticIP')?.value  || null,
    connection_type:  document.getElementById('custConnType')?.value  || null,
    mac_address:      (document.getElementById('custMacAddress')?.value || '').trim().toUpperCase() || null,
    mikrotik_id:      document.getElementById('custMikrotikId')?.value || null,
    status:           document.getElementById('custStatus')?.value   || 'active',
    latitude,
    longitude,
    infra_parent_id:  infraParentId,
  };
  // pppoe_username hanya dikirim saat:
  //   - mode EDIT (user memang mengelola field ini), ATAU
  //   - mode TAMBAH dengan checkbox "Buat Akun PPPoE" dicentang.
  // Tanpa ini, field #custPPPoE yang mungkin ter-auto-fill akan tersimpan ke DB
  // walau user tidak ingin membuat PPPoE (bug: PPPoE seolah selalu ter-create).
  if (_custEditId || createPppoe) {
    body.pppoe_username = document.getElementById('custPPPoE')?.value || '';
  }
  if (sendWA) body.send_wa_welcome = true;
  if (sendEmail) body.send_email_welcome = true;
  // Kalau PPPoE rename sudah di-handle oleh endpoint khusus di atas,
  // hapus field dari body supaya tidak overwrite (endpoint khusus sudah update DB).
  if (pppoeRenameHandled) {
    delete body.pppoe_username;
  }

  const url    = _custEditId ? '/customers/' + _custEditId : '/customers';
  const method = _custEditId ? 'PUT' : 'POST';
  const data   = await App.api(url, { method, body: JSON.stringify(body) });

  if (data?.success) {
    // Sync kredensial portal (cuma jalan di mode edit, panel hidden = no-op)
    const ppRes = await ppSaveCredentials();
    if (!ppRes.ok) {
      // Customer sudah ter-save, tapi update kredensial portal gagal.
      // Jangan close modal — biar admin bisa lihat error & retry.
      App.showToast('Customer tersimpan, tapi kredensial portal gagal: ' + ppRes.message, 'warning');
      btn.disabled = false; btn.textContent = 'Simpan Customer';
      // Tetap refresh list di belakang supaya data lain ter-update.
      loadCustomers();
      loadCustomerStats();
      return;
    }

    // Kalau modal hasil kredensial muncul, beri jeda kecil supaya admin lihat dulu
    const pwModalShown = !!document.getElementById('ppResultModal');
    if (!pwModalShown) {
      window.closeModal();
    } else {
      // Hide saja modal edit (di belakang modal hasil kredensial),
      // biarkan modal hasil yang interaksinya.
      window.closeModal();
    }
    loadCustomers();
    loadCustomerStats();

    // Toast utama
    let msg = _custEditId ? 'Customer diperbarui' : 'Customer ditambahkan';
    let toastType = 'success';

    // Info status pembuatan PPPoE
    if (pppoeStatus === 'created') {
      msg += ' • Akun PPPoE dibuat ✓';
    }

    // Info status auto-sync ke peta infrastruktur
    if (data.infra_sync && data.infra_sync.action) {
      if (data.infra_sync.action === 'created') {
        msg += ' • Ditandai di peta ✓';
      } else if (data.infra_sync.action === 'updated') {
        msg += ' • Titik peta di-update ✓';
      } else if (data.infra_sync.action === 'deleted') {
        msg += ' • Titik peta dihapus (koord kosong)';
      }
    }

    // Tambah info status WA kalau dikirim
    if (!_custEditId && sendWA && data.wa_status) {
      if (data.wa_status === 'sent') {
        msg += ' • WA welcome terkirim ✓';
      } else if (data.wa_status === 'no_phone') {
        msg += ' (no HP, WA dilewati)';
      } else if (data.wa_status === 'no_wa_session') {
        msg += ' (WA Gateway belum terhubung)';
        toastType = 'warning';
      } else if (data.wa_status === 'disabled') {
        msg += ' (notif WA dinonaktifkan)';
      } else {
        msg += ' (WA gagal terkirim)';
        toastType = 'warning';
      }
    }

    // Tambah info status Email welcome kalau dikirim
    if (!_custEditId && sendEmail && data.email_status) {
      if (data.email_status === 'sent') {
        msg += ' • Email welcome terkirim ✓';
      } else if (data.email_status === 'no_email') {
        msg += ' (no email, dilewati)';
      } else if (data.email_status === 'disabled') {
        msg += ' (notif email dinonaktifkan)';
      } else if (data.email_status === 'no_smtp') {
        msg += ' (SMTP belum dikonfigurasi)';
        toastType = 'warning';
      } else if (data.email_status === 'failed') {
        msg += ' (email gagal terkirim)';
        toastType = 'warning';
      }
    }
    App.showToast(msg, toastType);
  } else {
    // Customer gagal disimpan tapi PPPoE sudah dibuat — beri warning supaya admin tahu
    if (pppoeStatus === 'created') {
      App.showToast(
        'PPPoE sudah dibuat di MikroTik tapi customer gagal disimpan: ' + (data?.message || 'Unknown error') +
        '. Silakan hapus secret PPPoE manual atau ulangi simpan customer.',
        'error'
      );
    } else {
      App.showToast(data?.message || 'Gagal menyimpan', 'error');
    }
  }
  btn.disabled = false; btn.textContent = 'Simpan Customer';
}

// ── PAGINATION ────────────────────────────────────────────────
function _renderPagination(total, limit) {
  var totalPages = Math.ceil(total / limit);
  var el = document.getElementById('customerPagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  var offset = (_custPage-1)*limit;
  var info = '<div style="font-size:12.5px;color:var(--d-muted)">Menampilkan <strong style=\"color:var(--d-text)\">'+(offset+1)+'–'+Math.min(offset+limit,total)+'</strong> dari <strong style=\"color:var(--d-text)\">'+total+'</strong> customer</div>';
  var btns = '<div style="display:flex;gap:4px">';
  if (_custPage > 1) btns += '<a href="#" class="pg-btn" onclick="_goPage('+(_custPage-1)+');return false">←</a>';
  for (var i=Math.max(1,_custPage-2); i<=Math.min(totalPages,_custPage+2); i++) {
    btns += '<a href="#" class="pg-btn '+(i===_custPage?'active':'')+'" onclick="_goPage('+i+');return false">'+i+'</a>';
  }
  if (_custPage < totalPages) btns += '<a href="#" class="pg-btn" onclick="_goPage('+(_custPage+1)+');return false">→</a>';
  btns += '</div>';
  el.innerHTML = info + btns;
}
window._goPage = function(p) { _custPage = p; loadCustomers(); };

// ── CUSTOMER ID helpers ───────────────────────────────────────
function setIdStatus(type, id) {
  const el = document.getElementById('custIdStatus');
  if (!el) return;
  const map = {
    hint:      '<span style="color:#adb5bd;font-size:11px;">Berikutnya: <b>' + _esc(id) + '</b></span>',
    auto:      '<span style="color:#25d366;font-size:11px;font-weight:600;">✓ Otomatis: ' + _esc(id) + '</span>',
    available: '<span style="color:#25d366;font-size:11px;font-weight:600;">✓ ID tersedia</span>',
    taken:     '<span style="color:#dc2626;font-size:11px;font-weight:600;">✗ ID sudah digunakan</span>',
    existing:  '<span style="color:#667781;font-size:11px;">ID tidak bisa diubah</span>',
    checking:  '<span style="color:#f59e0b;font-size:11px;">⏳ Mengecek...</span>',
  };
  el.innerHTML = map[type] || '';
}

const _checkIdDebounced = _debounce(async (val) => {
  if (!val || val.length < 2) { setIdStatus(''); return; }
  setIdStatus('checking');
  const d = await App.api('/customers/check-id?customer_id=' + encodeURIComponent(val));
  setIdStatus(d?.available ? 'available' : 'taken');
}, 500);

window.onCustIdInput = function(val) {
  const upper = val.toUpperCase();
  const el = document.getElementById('custId');
  if (el) el.value = upper;
  if (!upper.trim()) setIdStatus(_nextAutoId ? 'auto' : '', _nextAutoId);
  else _checkIdDebounced(upper.trim());
};

window.refreshNextId = async function() {
  const d = await App.api('/customers/next-id');
  if (d?.success) { _nextAutoId = d.customer_id; _setVal('custId', ''); setIdStatus('hint', d.customer_id); const el = document.getElementById('custId'); if(el) el.placeholder = 'Kosongkan → otomatis: ' + d.customer_id; }
};

// ── HELPERS ───────────────────────────────────────────────────
function _clearForm() {
  ['custName','custPhone','custEmail','custAddress','custPPPoE','custOntSn','custId','custInstallDate','custStaticIP',
   'custMacAddress','custNik','custJalan','custNoRumah','custRt','custRw',
   'custPppoePassword','custPppoeLocalAddr','custPppoeRemoteAddr',
   'custLatitude','custLongitude'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  // Reset dropdown wilayah berjenjang
  ['custKab','custKec','custDesa'].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.innerHTML = '<option value="">— pilih —</option>'; e.disabled = true; }
  });
  const provSel = document.getElementById('custProv'); if (provSel) provSel.value = '';
  const geoHint = document.getElementById('custGeoHint'); if (geoHint) geoHint.textContent = '';
  // Bersihkan pin peta + reset view (untuk tambah baru setelah sebelumnya edit)
  try {
    if (_custMarker && _custMap) { _custMap.removeLayer(_custMarker); _custMarker = null; }
    if (_custMap) _custMap.setView([-6.2, 106.81], 12);
  } catch (_) {}
  custLoadProvinces();
  _setVal('custPackage', ''); _setVal('custDueDate', ''); _setVal('custStatus', 'active');
  _setVal('custConnType', '');
  if (typeof onConnTypeChange === 'function') onConnTypeChange();
  _setVal('custInfraParentId', '');
  const mkSel2 = document.getElementById('custMikrotikId');
  if (mkSel2) mkSel2.value = '';

  // Reset flag manual-edit PPPoE → auto-fill dari nama aktif kembali
  _pppoeManuallyEdited = false;

  // Reset PPPoE creation panel ke state default
  const cbPppoe = document.getElementById('custCreatePppoe');
  if (cbPppoe) cbPppoe.checked = false;
  const formBox = document.getElementById('pppoeFormBox');
  if (formBox) formBox.style.display = 'none';
  _setVal('custPppoeService', 'pppoe');
  const routerSel = document.getElementById('custPppoeRouter');
  if (routerSel) routerSel.innerHTML = '<option value="">— Memuat daftar router —</option>';
  const profSel = document.getElementById('custPppoeProfile');
  if (profSel) profSel.innerHTML = '<option value="">— Pilih router dulu —</option>';
  const hintBox = document.getElementById('pppoeFormHint');
  if (hintBox) { hintBox.style.display = 'none'; hintBox.innerHTML = ''; }

  // Set default tanggal aktivasi = hari ini, billing_date = tgl sama bulan depan
  const todayStr = new Date().toISOString().split('T')[0];
  _setVal('custInstallDate', todayStr);
  if (typeof onActivationDateChange === 'function') onActivationDateChange();
  const idStatus = document.getElementById('custIdStatus'); if (idStatus) idStatus.innerHTML = '';
}
function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function _setVal(id, val)  { const el = document.getElementById(id); if (el) el.value = val; }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Note: tombol Simpan sudah punya inline onclick="saveCustomerBtn()" di customers.ejs
// yang memanggil saveCustomer(). JANGAN tambahkan addEventListener('click', saveCustomer)
// di sini — akan menyebabkan double-fire (customer ter-create 2x, toast muncul 2x).

// ── Auto billing_date dari activation_date ───────────────────
window.onActivationDateChange = function() {
  const activEl = document.getElementById('custInstallDate');
  const dueEl   = document.getElementById('custDueDate');
  if (!activEl || !dueEl) return;

  // Hanya auto-set due_date jika mode TAMBAH BARU dan due_date belum diisi
  if (!window._custEditId && activEl.value && !dueEl.value) {
    const actDate = new Date(activEl.value);
    if (!isNaN(actDate)) {
      // Due date = tanggal sama, bulan depan (ikuti logika PHP)
      const nextMonth = new Date(actDate.getFullYear(), actDate.getMonth()+1, actDate.getDate());
      dueEl.value = nextMonth.toISOString().split('T')[0];
    }
  }
};



// ── Load MikroTik devices for dropdown ───────────────────────
async function loadMikrotikDevices() {
  const d = await App.api('/isolir/devices').catch(() => null);
  const sel = document.getElementById('custMikrotikId');
  if (!sel || !d?.data) return;
  sel.innerHTML = '<option value="">— Pilih router —</option>' +
    d.data.map(dev =>
      `<option value="${dev.id}">${dev.name} (${dev.host})</option>`
    ).join('');
}

// ═══════════════════════════════════════════════════════════════
// PPPoE Account Creation
// ═══════════════════════════════════════════════════════════════

// Load daftar router dari tabel `devices` (sumber data sama dgn halaman /devices)
async function loadPppoeRouters() {
  console.log('[PPPoE] loadPppoeRouters called');
  const sel = document.getElementById('custPppoeRouter');
  const spinner = document.getElementById('pppoeRouterSpinner');
  if (!sel) { console.warn('[PPPoE] custPppoeRouter element not found'); return; }

  sel.innerHTML = '<option value="">Memuat router...</option>';
  sel.disabled = true;
  if (spinner) spinner.style.display = 'inline';

  try {
    const d = await App.api('/devices/mikrotik-list');
    console.log('[PPPoE] router list response:', d);
    if (d?.success && Array.isArray(d.data) && d.data.length) {
      // Sort: primary first, lalu alfabet by name
      const routers = d.data.slice().sort((a, b) => {
        if (a.is_primary && !b.is_primary) return -1;
        if (!a.is_primary && b.is_primary) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      sel.innerHTML = '<option value="">— Pilih router —</option>' +
        routers.map(r => {
          const tag = r.is_primary ? ' ★ primary' : '';
          const stat = r.status === 'online' ? '' : ' [' + (r.status || 'unknown') + ']';
          return `<option value="${r.id}">${_esc(r.name)} (${_esc(r.ip_address)})${tag}${stat}</option>`;
        }).join('');
      console.log('[PPPoE] loaded', routers.length, 'routers');
    } else {
      sel.innerHTML = '<option value="">Tidak ada router terdaftar</option>';
      const hint = document.getElementById('pppoeFormHint');
      if (hint) {
        hint.style.display = 'block';
        hint.innerHTML = '<strong style="color:#dc2626">⚠</strong> Belum ada router MikroTik di halaman <a href="/devices" target="_blank" style="color:#2563eb;text-decoration:underline">Devices</a>. Tambahkan router dulu (tipe: Router, aktif).';
      }
    }
  } catch (e) {
    console.error('[PPPoE] loadPppoeRouters exception:', e);
    sel.innerHTML = '<option value="">Error: ' + _esc(e.message) + '</option>';
  } finally {
    sel.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
}

// Load profiles dari router yang dipilih
async function loadPppoeProfiles(deviceId) {
  console.log('[PPPoE] loadPppoeProfiles called with deviceId =', deviceId);
  const sel = document.getElementById('custPppoeProfile');
  const spinner = document.getElementById('pppoeProfileSpinner');
  if (!sel) { console.warn('[PPPoE] custPppoeProfile element not found'); return; }

  if (!deviceId) {
    sel.innerHTML = '<option value="">— Pilih router dulu —</option>';
    return;
  }

  // Show spinner & disable
  sel.innerHTML = '<option value="">Memuat profile...</option>';
  sel.disabled = true;
  if (spinner) spinner.style.display = 'inline';

  try {
    const url = '/mikrotik/pppoe/profiles?device_id=' + encodeURIComponent(deviceId);
    console.log('[PPPoE] fetching:', url);
    const d = await App.api(url);
    console.log('[PPPoE] profile response:', d);

    if (d?.success && Array.isArray(d.data) && d.data.length) {
      // Sort: 'default' first, lalu alfabet
      const profiles = d.data.slice().sort((a, b) => {
        if (a.name === 'default') return -1;
        if (b.name === 'default') return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      sel.innerHTML = '<option value="">— Pilih profile —</option>' +
        profiles.map(p => {
          const meta = [];
          if (p.rateLimit) meta.push(p.rateLimit);
          if (p.localAddress) meta.push('local:' + p.localAddress);
          if (p.remoteAddress) meta.push('pool:' + p.remoteAddress);
          const label = p.name + (meta.length ? '  •  ' + meta.join(' / ') : '');
          return `<option value="${_esc(p.name)}" data-rate="${_esc(p.rateLimit||'')}" data-local="${_esc(p.localAddress||'')}" data-remote="${_esc(p.remoteAddress||'')}">${_esc(label)}</option>`;
        }).join('');
      console.log('[PPPoE] loaded', profiles.length, 'profiles');
    } else if (d?.success && Array.isArray(d.data) && d.data.length === 0) {
      sel.innerHTML = '<option value="">Tidak ada profile di router ini</option>';
    } else {
      sel.innerHTML = '<option value="">Gagal muat profile</option>';
      const errMsg = d?.message || 'Response tidak valid (cek koneksi MikroTik)';
      console.error('[PPPoE] load profiles failed:', errMsg, d);
      const hint = document.getElementById('pppoeFormHint');
      if (hint) {
        hint.style.display = 'block';
        hint.innerHTML = '<strong style="color:#dc2626">⚠ Gagal muat profile:</strong> ' + _esc(errMsg);
      }
    }
  } catch (e) {
    console.error('[PPPoE] loadPppoeProfiles exception:', e);
    sel.innerHTML = '<option value="">Error: ' + _esc(e.message) + '</option>';
    const hint = document.getElementById('pppoeFormHint');
    if (hint) {
      hint.style.display = 'block';
      hint.innerHTML = '<strong style="color:#dc2626">⚠ Error:</strong> ' + _esc(e.message);
    }
  } finally {
    sel.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
}

// Generate random password 10 chars (alfanumeric)
window.generatePppoePassword = function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  const el = document.getElementById('custPppoePassword');
  if (el) el.value = pw;
};

// Bind event listeners untuk panel PPPoE create
// Pakai event delegation pada document supaya listener tetap berfungsi
// terlepas dari urutan load script vs DOMContentLoaded.
(function bindPppoeHandlers() {
  document.addEventListener('change', function(e) {
    const t = e.target;
    if (!t || !t.id) return;

    // 1. Toggle visibility form PPPoE saat checkbox di-klik
    if (t.id === 'custCreatePppoe') {
      const formBox = document.getElementById('pppoeFormBox');
      if (formBox) formBox.style.display = t.checked ? '' : 'none';

      if (t.checked) {
        // Load daftar router dari /api/devices/mikrotik-list
        loadPppoeRouters();
        // Reset profile dropdown
        const profSel = document.getElementById('custPppoeProfile');
        if (profSel) profSel.innerHTML = '<option value="">— Pilih router dulu —</option>';
        const hint = document.getElementById('pppoeFormHint');
        if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }

        // Auto-fill PPPoE Username dari nama (hanya di mode TAMBAH baru,
        // dan kalau user belum edit manual field PPPoE).
        // Berguna untuk skenario: user sudah ketik nama dulu, lalu baru
        // centang "Buat Akun PPPoE" — field auto-terisi langsung.
        if (!_custEditId && !_pppoeManuallyEdited) {
          const nameEl  = document.getElementById('custName');
          const pppoeEl = document.getElementById('custPPPoE');
          if (nameEl && pppoeEl && nameEl.value.trim()) {
            pppoeEl.value = _slugifyForPppoe(nameEl.value);
          }
        }
      } else {
        const hint = document.getElementById('pppoeFormHint');
        if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }

        // Saat uncheck: clear field PPPoE Username supaya tidak ikut ter-submit
        // (intent user = tidak buat akun PPPoE, jadi tidak set username di DB).
        // Hanya di mode TAMBAH baru — di mode edit field ini hidden tapi tetap
        // perlu pertahankan value asli dari DB.
        if (!_custEditId) {
          const pppoeEl = document.getElementById('custPPPoE');
          if (pppoeEl) pppoeEl.value = '';
          _pppoeManuallyEdited = false; // reset flag → auto-fill aktif lagi kalau dicentang ulang
        }
      }
      return;
    }

    // 2. Saat router PPPoE dipilih, load daftar profile dari router itu
    if (t.id === 'custPppoeRouter') {
      loadPppoeProfiles(t.value);
      const hint = document.getElementById('pppoeFormHint');
      if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }
      return;
    }

    // 3. Saat profile dipilih, tampilkan info rate-limit dari profile
    if (t.id === 'custPppoeProfile') {
      const opt = t.options[t.selectedIndex];
      const hint = document.getElementById('pppoeFormHint');
      if (!opt || !opt.value) {
        if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }
        return;
      }
      const rate = opt.dataset.rate || '';
      const local = opt.dataset.local || '';
      const remote = opt.dataset.remote || '';
      const parts = [];
      if (rate) parts.push('<strong>Rate-limit:</strong> ' + _esc(rate));
      if (local) parts.push('<strong>Local addr (profile):</strong> ' + _esc(local));
      if (remote) parts.push('<strong>Pool (profile):</strong> ' + _esc(remote));
      if (hint) {
        if (parts.length) {
          hint.style.display = 'block';
          hint.innerHTML = '<strong style="color:#16a34a">✓ Profile terpilih</strong> &nbsp; ' + parts.join(' &nbsp;|&nbsp; ');
        } else {
          hint.style.display = 'none';
          hint.innerHTML = '';
        }
      }
      return;
    }
  });
})();

// ─────────────────────────────────────────────────────────────────────
// AUTO-GENERATE PPPoE Username dari Nama Customer
// ─────────────────────────────────────────────────────────────────────
// Saat user mengetik nama di field `custName`, field `custPPPoE` ikut
// terisi otomatis dengan versi slugified (huruf+angka, tanpa spasi).
//
// Aturan:
//   1. Hanya jalan di mode TAMBAH baru (_custEditId == null). Saat edit,
//      username yang sudah ada tidak ditimpa.
//   2. Tidak menimpa kalau user sudah pernah mengetik manual di custPPPoE
//      (di-track oleh flag `_pppoeManuallyEdited`).
//   3. Kalau user mengosongkan field PPPoE setelah edit manual, flag
//      direset → auto-fill aktif kembali (user bisa "minta generate ulang"
//      dengan cara mengosongkan field).
//
// Pakai event delegation pada document supaya berfungsi terlepas dari
// urutan load script vs. DOMContentLoaded (konsisten dengan pola
// bindPppoeHandlers di atas).
// ─────────────────────────────────────────────────────────────────────
(function bindPppoeAutoGen() {
  document.addEventListener('input', function(e) {
    const t = e.target;
    if (!t || !t.id) return;

    // (A) Ketika user mengetik di field Nama → propagate ke custPPPoE
    if (t.id === 'custName') {
      if (_custEditId) return;              // skip di mode edit
      if (_pppoeManuallyEdited) return;     // skip kalau user sudah edit manual

      const pppoeEl = document.getElementById('custPPPoE');
      if (!pppoeEl) return;
      pppoeEl.value = _slugifyForPppoe(t.value);
      return;
    }

    // (B) Ketika user mengetik manual di field PPPoE → set flag
    //     supaya auto-fill berhenti menimpa.
    //     Kalau user mengosongkan field, reset flag supaya auto-fill
    //     kembali aktif (re-generate dari nama).
    if (t.id === 'custPPPoE') {
      _pppoeManuallyEdited = !!(t.value && t.value.trim());
      return;
    }
  });
})();

// ═══════════════════════════════════════════════════════════════════════
// PORTAL CREDENTIALS — admin mengubah login ID & password Customer Portal
// (hanya tampil saat modal EDIT customer, di-injeksi oleh editCustomer())
// ═══════════════════════════════════════════════════════════════════════

function ppLoadCredentials(custId) {
  const cidInput = document.getElementById('ppCid');
  const cidBtn   = document.getElementById('ppCidToggle');
  const cidWarn  = document.getElementById('ppCidWarn');
  const pwInput  = document.getElementById('ppPw');
  const hint     = document.getElementById('ppPwHint');
  const last     = document.getElementById('ppLastLogin');
  const enabled  = document.getElementById('ppEnabled');

  if (cidInput) { cidInput.value=''; cidInput.readOnly=true; cidInput.style.background='#eef2f7'; cidInput.style.cursor='not-allowed'; }
  if (cidBtn)   { cidBtn.textContent='Ubah'; cidBtn.style.color='#1a6ef5'; cidBtn.style.borderColor='#e4ecf7'; }
  if (cidWarn)  { cidWarn.style.display='none'; }
  if (pwInput)  { pwInput.value=''; pwInput.type='password'; }
  if (hint)     { hint.textContent='Memuat…'; hint.style.color='#94a3b8'; }
  if (last)     { last.textContent=''; }
  if (enabled)  { enabled.checked = true; }

  App.api('/customers/' + custId + '/portal-credentials').then(function(r){
    if (!r || !r.success || !r.data) {
      if (hint) { hint.textContent='Tidak dapat memuat data kredensial portal'; hint.style.color='#dc2626'; }
      return;
    }
    const d = r.data;
    if (cidInput) cidInput.value = d.customer_id || '';
    if (enabled)  enabled.checked = !!d.portal_enabled;
    if (hint) {
      if (d.has_custom_password) {
        hint.innerHTML = '✓ Password sudah diset. Kosongkan untuk tidak mengubah.';
        hint.style.color = '#16a34a';
      } else if (d.fallback_login_hint) {
        hint.innerHTML = 'Belum ada password custom — pelanggan login pakai nomor HP: <span style="font-family:DM Mono,monospace;color:#0d1b3e;font-weight:600;">' + _esc(d.fallback_login_hint) + '</span>';
        hint.style.color = '#b45309';
      } else {
        hint.innerHTML = '⚠ Belum ada password & belum ada nomor HP — pelanggan tidak bisa login.';
        hint.style.color = '#dc2626';
      }
    }
    if (last) {
      if (d.last_portal_login) {
        const dt = new Date(d.last_portal_login);
        last.textContent = 'Login terakhir: ' + dt.toLocaleString('id-ID', { dateStyle:'medium', timeStyle:'short' });
      } else {
        last.textContent = 'Pelanggan belum pernah login ke portal.';
      }
    }
  }).catch(function(e){
    if (hint) { hint.textContent='Gagal memuat: ' + (e.message||'error'); hint.style.color='#dc2626'; }
  });
}

window.ppToggleCidEdit = function() {
  const cidInput = document.getElementById('ppCid');
  const btn      = document.getElementById('ppCidToggle');
  const warn     = document.getElementById('ppCidWarn');
  if (!cidInput || !btn) return;
  const nowLocked = cidInput.readOnly;
  if (nowLocked) {
    // Unlock
    cidInput.readOnly = false;
    cidInput.style.background = '#fff';
    cidInput.style.cursor = 'text';
    cidInput.focus();
    cidInput.select();
    btn.textContent = 'Batal';
    btn.style.color = '#dc2626';
    btn.style.borderColor = '#fecaca';
    if (warn) warn.style.display = 'block';
  } else {
    // Lock — reload original value
    if (_custEditId) ppLoadCredentials(_custEditId);
  }
};

window.ppTogglePwVisibility = function() {
  const pw = document.getElementById('ppPw');
  if (!pw) return;
  pw.type = (pw.type === 'password') ? 'text' : 'password';
};

window.ppGeneratePassword = function() {
  // 8 karakter mudah dibaca — tanpa O/0/I/l yang ambigu
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  if (window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint32Array(8);
    window.crypto.getRandomValues(arr);
    for (let i=0;i<8;i++) out += chars[arr[i] % chars.length];
  } else {
    for (let j=0;j<8;j++) out += chars[Math.floor(Math.random()*chars.length)];
  }
  const pw = document.getElementById('ppPw');
  if (pw) { pw.value = out; pw.type = 'text'; }
};

window.ppResetPasswordToPhone = async function() {
  if (!_custEditId) return;
  if (!confirm('Reset password pelanggan? Setelah reset, pelanggan akan login menggunakan nomor HP-nya sendiri.')) return;
  try {
    const r = await App.api('/customers/' + _custEditId + '/portal-credentials/reset', { method: 'POST' });
    if (r && r.success) {
      App.showToast(r.message || 'Password direset', 'success');
      ppLoadCredentials(_custEditId);
      const pw = document.getElementById('ppPw');
      if (pw) pw.value = '';
    } else {
      App.showToast((r && r.message) ? r.message : 'Gagal reset password', 'error');
    }
  } catch (err) {
    App.showToast('Error: ' + (err.message||err), 'error');
  }
};

// Dipanggil dari _saveCustomerInner() setelah customer ter-save.
// Return { ok: bool, message: string } supaya saveCustomer bisa tampilkan error tanpa close modal.
async function ppSaveCredentials() {
  if (!_custEditId) return { ok: true };

  const cidInput = document.getElementById('ppCid');
  const pwInput  = document.getElementById('ppPw');
  const enabled  = document.getElementById('ppEnabled');
  const portalBox = document.getElementById('portalPanelBox');

  // Panel tersembunyi (mode tambah baru) → skip
  if (!portalBox || portalBox.style.display === 'none') return { ok: true };

  const payload = {};

  // Customer ID — kirim kalau input ter-unlock
  if (cidInput && !cidInput.readOnly) {
    const cid = (cidInput.value || '').trim();
    if (cid) payload.customer_id = cid;
  }
  // Password — kirim kalau ada isi
  if (pwInput && pwInput.value) {
    if (pwInput.value.length < 6) {
      return { ok:false, message:'Password portal minimal 6 karakter' };
    }
    payload.new_password = pwInput.value;
  }
  // portal_enabled
  if (enabled) payload.portal_enabled = !!enabled.checked;

  try {
    const r = await App.api('/customers/' + _custEditId + '/portal-credentials', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (r && r.success) {
      // Kalau ada password baru di-set, tampilkan modal hasil supaya admin bisa salin
      if (r.data && r.data.new_password) {
        ppShowResultModal(r.data.customer_id || (cidInput && cidInput.value), r.data.new_password);
      }
      return { ok: true };
    } else {
      // "Tidak ada perubahan" bukan error nyata — anggap OK supaya save profil tidak gagal
      if (r && /tidak ada perubahan/i.test(r.message || '')) return { ok: true };
      return { ok:false, message: (r && r.message) ? r.message : 'Gagal update kredensial portal' };
    }
  } catch (err) {
    return { ok:false, message: err.message || String(err) };
  }
}

function ppShowResultModal(custId, password) {
  const existing = document.getElementById('ppResultModal');
  if (existing) existing.remove();

  const html = ''
    + '<div id="ppResultModal" style="position:fixed;inset:0;z-index:10001;background:rgba(13,27,62,.55);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);">'
    +   '<div style="background:#fff;border-radius:18px;width:100%;max-width:420px;padding:24px;box-shadow:0 30px 80px rgba(13,27,62,.3);">'
    +     '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">'
    +       '<div style="width:36px;height:36px;border-radius:10px;background:#dcfce7;display:flex;align-items:center;justify-content:center;">'
    +         '<svg width="18" height="18" fill="none" stroke="#16a34a" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
    +       '</div>'
    +       '<div style="font-size:15px;font-weight:800;color:#0d1b3e;">Kredensial Portal Baru</div>'
    +     '</div>'
    +     '<div style="font-size:12.5px;color:#64748b;margin-bottom:14px;line-height:1.5;">'
    +       'Berikut detail login pelanggan untuk Customer Portal. '
    +       '<span style="color:#dc2626;font-weight:600;">Salin dan kirim ke pelanggan sekarang</span> — password ini tidak akan ditampilkan lagi.'
    +     '</div>'
    +     '<div style="background:#f8fafd;border:1.5px solid #e4ecf7;border-radius:12px;padding:14px;margin-bottom:14px;font-family:DM Mono,ui-monospace,monospace;">'
    +       '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">'
    +         '<span style="font-size:10.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;font-family:DM Sans,sans-serif;letter-spacing:.05em;">Customer ID</span>'
    +         '<span id="ppResCid" style="font-size:13.5px;color:#0d1b3e;font-weight:600;">' + _esc(custId||'') + '</span>'
    +       '</div>'
    +       '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
    +         '<span style="font-size:10.5px;color:#94a3b8;text-transform:uppercase;font-weight:700;font-family:DM Sans,sans-serif;letter-spacing:.05em;">Password</span>'
    +         '<span id="ppResPw" style="font-size:13.5px;color:#0d1b3e;font-weight:600;letter-spacing:.05em;">' + _esc(password||'') + '</span>'
    +       '</div>'
    +     '</div>'
    +     '<div style="display:flex;gap:8px;">'
    +       '<button id="ppResCopyBtn" onclick="ppCopyResult()" style="flex:1;padding:10px;border:1.5px solid #e4ecf7;border-radius:10px;background:#fff;color:#1a6ef5;font-size:12.5px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Salin Keduanya</button>'
    +       '<button onclick="document.getElementById(\'ppResultModal\').remove()" style="flex:1;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#1a6ef5,#0047cc);color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;">Selesai</button>'
    +     '</div>'
    +   '</div>'
    + '</div>';
  document.body.insertAdjacentHTML('beforeend', html);
}

window.ppCopyResult = function() {
  const cidEl = document.getElementById('ppResCid');
  const pwEl  = document.getElementById('ppResPw');
  if (!cidEl || !pwEl) return;
  const txt = 'Customer ID: ' + cidEl.textContent + '\nPassword: ' + pwEl.textContent;
  const btn = document.getElementById('ppResCopyBtn');
  const done = function(){ if (btn) { btn.textContent='✓ Tersalin'; btn.style.color='#16a34a'; setTimeout(function(){ btn.textContent='Salin Keduanya'; btn.style.color='#1a6ef5'; }, 1500); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(function(){
      const ta = document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); done();}catch(_){} document.body.removeChild(ta);
    });
  } else {
    const ta = document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); done();}catch(_){} document.body.removeChild(ta);
  }
};

// ══════════════════════════════════════════════════════════════
// Alamat berjenjang dari API wilayah Indonesia (emsifa)
// Provinsi → Kabupaten/Kota → Kecamatan → Desa/Kelurahan.
// Sama seperti di halaman Sales. Hasil disusun otomatis ke #custAddress.
// ══════════════════════════════════════════════════════════════
const CUST_WILAYAH_API = '/regions';
let _custProvLoaded = false;

// Ambil nama (data-name / teks) dari option terpilih sebuah dropdown wilayah.
function _custSelName(id) {
  const el = document.getElementById(id);
  if (!el || !el.value) return '';
  const o = el.options[el.selectedIndex];
  return o ? (o.getAttribute('data-name') || o.textContent).trim() : '';
}

async function custFetchWilayah(path) {
  try {
    // App.api menambah base /api + header auth. Endpoint memakai path emsifa:
    //   provinces · regencies/:id · districts/:id · villages/:id
    const r = await App.api(`${CUST_WILAYAH_API}/${path}`);
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
}

function custFillSelect(id, items, placeholder) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    items.map(x => `<option value="${x.id}" data-name="${x.name}">${x.name}</option>`).join('');
  el.disabled = items.length === 0;
}

async function custLoadProvinces() {
  if (_custProvLoaded) return;
  const provs = await custFetchWilayah('provinces');
  if (provs.length) { custFillSelect('custProv', provs, '— pilih provinsi —'); _custProvLoaded = true; }
}

async function custOnProvChange() {
  const id = document.getElementById('custProv')?.value;
  ['custKab','custKec','custDesa'].forEach(x => {
    const e = document.getElementById(x);
    if (e) { e.innerHTML = '<option value="">— pilih —</option>'; e.disabled = true; }
  });
  if (id) { const kabs = await custFetchWilayah('regencies/' + id); custFillSelect('custKab', kabs, '— pilih kab/kota —'); }
  custComposeAddr();
}

async function custOnKabChange() {
  const id = document.getElementById('custKab')?.value;
  ['custKec','custDesa'].forEach(x => {
    const e = document.getElementById(x);
    if (e) { e.innerHTML = '<option value="">— pilih —</option>'; e.disabled = true; }
  });
  if (id) { const kecs = await custFetchWilayah('districts/' + id); custFillSelect('custKec', kecs, '— pilih kecamatan —'); }
  custComposeAddr();
}

async function custOnKecChange() {
  const id = document.getElementById('custKec')?.value;
  const e = document.getElementById('custDesa');
  if (e) { e.innerHTML = '<option value="">— pilih —</option>'; e.disabled = true; }
  if (id) { const desas = await custFetchWilayah('villages/' + id); custFillSelect('custDesa', desas, '— pilih desa/kelurahan —'); }
  custComposeAddr();
}

// Susun alamat lengkap dari detail jalan + wilayah terpilih → #custAddress
function custComposeAddr() {
  const selName = id => {
    const el = document.getElementById(id);
    if (!el || !el.value) return '';
    const o = el.options[el.selectedIndex];
    return o ? (o.getAttribute('data-name') || o.textContent) : '';
  };
  const jalan = (document.getElementById('custJalan')?.value || '').trim();
  const no    = (document.getElementById('custNoRumah')?.value || '').trim();
  const rt    = (document.getElementById('custRt')?.value || '').trim();
  const rw    = (document.getElementById('custRw')?.value || '').trim();
  const desa = selName('custDesa'), kec = selName('custKec'), kab = selName('custKab'), prov = selName('custProv');

  const seg = [];
  let jalanSeg = jalan;
  if (no) jalanSeg += (jalan ? ' No. ' : 'No. ') + no;
  if (jalanSeg) seg.push(jalanSeg);
  if (rt || rw) seg.push(`RT ${rt || '-'}/RW ${rw || '-'}`);
  if (desa) seg.push('Kel. ' + desa);
  if (kec)  seg.push('Kec. ' + kec);
  if (kab)  seg.push(kab);
  if (prov) seg.push(prov);

  const txt = seg.join(', ');
  const el = document.getElementById('custAddress');
  // Hanya timpa kalau ada komponen wilayah/jalan terisi (jangan hapus alamat manual saat edit)
  if (txt && el) el.value = txt;

  // Auto-cari koordinat dari wilayah (debounced; tidak menimpa koordinat yang sudah ada)
  custScheduleGeocode();
}

// ── Geocode maju: alamat/wilayah → koordinat (Nominatim OSM) ──
// Sama seperti halaman Sales. Auto-fill hanya kalau lat/lng masih kosong,
// supaya tidak menimpa koordinat yang sudah diisi manual / dari peta.
let _custGeoTimer = null;
function custScheduleGeocode() {
  clearTimeout(_custGeoTimer);
  _custGeoTimer = setTimeout(() => custGeocodeFromAddress(false), 700);
}

async function custGeocodeFromAddress(force) {
  const latEl = document.getElementById('custLatitude');
  const lngEl = document.getElementById('custLongitude');
  const hint  = document.getElementById('custGeoHint');
  if (!latEl || !lngEl) return;

  // Kalau bukan paksa (auto) & koordinat sudah terisi → jangan timpa
  if (!force && (latEl.value.trim() || lngEl.value.trim())) return;

  const selName = id => {
    const el = document.getElementById(id);
    if (!el || !el.value) return '';
    const o = el.options[el.selectedIndex];
    return o ? (o.getAttribute('data-name') || o.textContent) : '';
  };
  const desa = selName('custDesa'), kec = selName('custKec'),
        kab  = selName('custKab'),  prov = selName('custProv');

  // Butuh minimal kab/prov supaya hasil tidak ngawur
  if (!prov && !kab) {
    if (force && hint) hint.textContent = 'Pilih minimal Provinsi/Kabupaten dulu.';
    return;
  }

  // Query spesifik → umum (Nominatim lebih akurat dengan konteks lengkap)
  const q = [desa, kec, kab, prov, 'Indonesia'].filter(Boolean).join(', ');
  if (hint) { hint.textContent = 'Mencari koordinat…'; hint.style.color = '#64748b'; }

  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=id&countrycodes=id&q=' + encodeURIComponent(q));
    const arr = await r.json();
    if (arr && arr.length) {
      latEl.value = (+arr[0].lat).toFixed(6);
      lngEl.value = (+arr[0].lon).toFixed(6);
      // Pindahkan pin peta ke hasil geocode
      if (typeof custSetPoint === 'function') {
        custSetPoint(+arr[0].lat, +arr[0].lon, true);
        if (_custMap) { try { _custMap.setView([+arr[0].lat, +arr[0].lon], 15); } catch (_) {} }
      }
      if (hint) { hint.textContent = '✓ Koordinat dari ' + (desa || kec || kab || prov) + '. Geser pin untuk presisi.'; hint.style.color = '#16a34a'; }
    } else if (hint) {
      hint.textContent = 'Wilayah tak ditemukan di peta. Isi koordinat manual.'; hint.style.color = '#ea580c';
    }
  } catch (_) {
    if (hint) { hint.textContent = 'Gagal mengambil koordinat (cek koneksi).'; hint.style.color = '#ea580c'; }
  }
}
window.custGeocodeFromAddress = custGeocodeFromAddress;

window.custOnProvChange = custOnProvChange;
window.custOnKabChange  = custOnKabChange;
window.custOnKecChange  = custOnKecChange;
window.custComposeAddr  = custComposeAddr;
window.custLoadProvinces = custLoadProvinces;

// ══════════════════════════════════════════════════════════════
// Filter per-AREA berjenjang (Provinsi → Kab/Kota → Kecamatan)
// Sumber opsi: endpoint /customers/areas (distinct dari data customer),
// jadi hanya area yang benar-benar punya pelanggan yang muncul.
// ══════════════════════════════════════════════════════════════
async function loadFilterProvinces() {
  const sel = document.getElementById('filterProvince');
  if (!sel) return;
  try {
    const d = await App.api('/customers/areas');
    if (d?.success) {
      sel.innerHTML = '<option value="">Semua Provinsi</option>'
        + d.data.map(p => `<option value="${_esc(p)}">${_esc(p)}</option>`).join('');
    }
  } catch (_) {}
}

async function onFilterProvinceChange() {
  const prov = document.getElementById('filterProvince')?.value || '';
  const regSel  = document.getElementById('filterRegency');
  const distSel = document.getElementById('filterDistrict');
  // reset level bawah
  if (regSel)  { regSel.innerHTML  = '<option value="">Semua Kab/Kota</option>';  regSel.disabled = true; }
  if (distSel) { distSel.innerHTML = '<option value="">Semua Kecamatan</option>'; distSel.disabled = true; }

  if (prov && regSel) {
    try {
      const d = await App.api('/customers/areas?province=' + encodeURIComponent(prov));
      if (d?.success && d.data.length) {
        regSel.innerHTML = '<option value="">Semua Kab/Kota</option>'
          + d.data.map(r => `<option value="${_esc(r)}">${_esc(r)}</option>`).join('');
        regSel.disabled = false;
      }
    } catch (_) {}
  }
  _custPage = 1;
  loadCustomers();
}

async function onFilterRegencyChange() {
  const prov = document.getElementById('filterProvince')?.value || '';
  const reg  = document.getElementById('filterRegency')?.value || '';
  const distSel = document.getElementById('filterDistrict');
  if (distSel) { distSel.innerHTML = '<option value="">Semua Kecamatan</option>'; distSel.disabled = true; }

  if (reg && distSel) {
    try {
      const d = await App.api('/customers/areas?province=' + encodeURIComponent(prov) + '&regency=' + encodeURIComponent(reg));
      if (d?.success && d.data.length) {
        distSel.innerHTML = '<option value="">Semua Kecamatan</option>'
          + d.data.map(x => `<option value="${_esc(x)}">${_esc(x)}</option>`).join('');
        distSel.disabled = false;
      }
    } catch (_) {}
  }
  _custPage = 1;
  loadCustomers();
}

// Backfill area data lama dari teks alamat
async function backfillAreas() {
  const btn = document.getElementById('backfillAreaBtn');
  if (!confirm('Isi otomatis data area (Provinsi/Kab/Kecamatan) untuk customer lama dari teks alamatnya?\n\nHanya mengisi yang masih kosong, tidak menimpa data yang sudah ada.')) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Memproses…'; }
  try {
    const d = await App.api('/customers/backfill-areas', { method: 'POST' });
    if (d?.success) {
      App.showToast(d.message || 'Backfill selesai', 'success');
      await loadFilterProvinces();
      loadCustomers();
    } else {
      App.showToast(d?.message || 'Gagal backfill', 'error');
    }
  } catch (e) {
    App.showToast('Gagal: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

window.onFilterProvinceChange = onFilterProvinceChange;
window.onFilterRegencyChange  = onFilterRegencyChange;
window.backfillAreas          = backfillAreas;
window.loadFilterProvinces    = loadFilterProvinces;

// ══════════════════════════════════════════════════════════════
// Pulihkan dropdown wilayah saat EDIT, dari nama area tersimpan.
// emsifa pakai KODE wilayah, sedangkan kita simpan NAMA. Jadi tiap
// level: ambil daftar → cari item yang namanya cocok → set value →
// load level berikutnya. Pencocokan case-insensitive & toleran.
// ══════════════════════════════════════════════════════════════
function _matchWilayah(items, name) {
  if (!name) return null;
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(name);
  // 1) cocok persis
  let hit = items.find(x => norm(x.name) === target);
  if (hit) return hit;
  // 2) cocok tanpa prefix umum (KABUPATEN/KOTA/KEC./KEL.)
  const strip = s => norm(s).replace(/^(kabupaten|kota|kab\.|kec\.|kecamatan|kel\.|kelurahan|desa)\s+/i, '');
  const t2 = strip(target);
  hit = items.find(x => strip(x.name) === t2);
  if (hit) return hit;
  // 3) saling mengandung (fallback longgar)
  hit = items.find(x => norm(x.name).includes(t2) || t2.includes(norm(x.name)));
  return hit || null;
}

async function custRestoreRegion(provName, regName, distName, vilName) {
  try {
    // Fallback: kalau kolom area kosong (data lama belum di-backfill), coba
    // parse dari teks alamat lengkap yang ada di field.
    if (!provName && !regName && !distName) {
      const addrEl = document.getElementById('custAddress');
      const parsed = _custParseAddr(addrEl ? addrEl.value : '');
      provName = parsed.province; regName = parsed.regency;
      distName = parsed.district; vilName = parsed.village;
    }
    if (!provName) return; // tetap tidak ada → biarkan kosong
    await custLoadProvinces();

    // PROVINSI
    const provs = await custFetchWilayah('provinces');
    const prov = _matchWilayah(provs, provName);
    const provSel = document.getElementById('custProv');
    if (!prov || !provSel) return;
    provSel.value = prov.id;

    // KABUPATEN/KOTA
    const kabs = await custFetchWilayah('regencies/' + prov.id);
    custFillSelect('custKab', kabs, '— pilih kab/kota —');
    if (!regName) { custComposeAddr(); return; }
    const kab = _matchWilayah(kabs, regName);
    const kabSel = document.getElementById('custKab');
    if (!kab || !kabSel) return;
    kabSel.value = kab.id;

    // KECAMATAN
    const kecs = await custFetchWilayah('districts/' + kab.id);
    custFillSelect('custKec', kecs, '— pilih kecamatan —');
    if (!distName) { custComposeAddr(); return; }
    const kec = _matchWilayah(kecs, distName);
    const kecSel = document.getElementById('custKec');
    if (!kec || !kecSel) return;
    kecSel.value = kec.id;

    // DESA/KELURAHAN
    const desas = await custFetchWilayah('villages/' + kec.id);
    custFillSelect('custDesa', desas, '— pilih desa/kelurahan —');
    if (vilName) {
      const desa = _matchWilayah(desas, vilName);
      const desaSel = document.getElementById('custDesa');
      if (desa && desaSel) desaSel.value = desa.id;
    }
    // Jangan timpa alamat lengkap yang sudah ada saat edit — composeAddr
    // hanya menulis kalau field kosong? Tidak; supaya aman, kita TIDAK panggil
    // composeAddr di akhir restore agar alamat asli pelanggan tetap utuh.
  } catch (e) {
    console.warn('[Customer] custRestoreRegion gagal:', e.message);
  }
}
window.custRestoreRegion = custRestoreRegion;

// Parser alamat sisi-client (mirror ringan dari backend parseAreaFromAddress).
// Dipakai sebagai fallback saat kolom area kosong di mode edit.
function _custParseAddr(address) {
  const out = { province: '', regency: '', district: '', village: '' };
  if (!address) return out;
  const segs = String(address).split(',').map(s => s.trim()).filter(Boolean);
  for (const seg of segs) {
    if (!out.village && /^(kel\.|kelurahan|desa)\s+/i.test(seg))
      out.village = seg.replace(/^(kel\.|kelurahan|desa)\s+/i, '').trim();
    else if (!out.district && /^(kec\.|kecamatan)\s+/i.test(seg))
      out.district = seg.replace(/^(kec\.|kecamatan)\s+/i, '').trim();
    else if (!out.regency && /^(kab\.|kabupaten|kota|kotamadya)\s+/i.test(seg))
      out.regency = seg.trim();
    else if (!out.province && /^(prov\.|provinsi)\s+/i.test(seg))
      out.province = seg.replace(/^(prov\.|provinsi)\s+/i, '').trim();
  }
  if (!out.province && segs.length) {
    const last = segs[segs.length - 1];
    if (last && !/\d/.test(last) && !/^(kel\.|kec\.|kab\.|kota|rt|rw)/i.test(last)) out.province = last.trim();
  }
  if (!out.regency && segs.length >= 2) {
    const cand = segs[segs.length - 2];
    if (cand && !/\d/.test(cand) && !/^(kel\.|kec\.|rt|rw|jl)/i.test(cand)) out.regency = cand.trim();
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// Peta interaktif titik lokasi customer (Leaflet)
// Pin draggable + klik peta + tombol Lokasi Saya. Sinkron dua arah
// dengan field custLatitude / custLongitude.
// ══════════════════════════════════════════════════════════════
let _custMap = null, _custMarker = null;

function _custPinIcon() {
  return L.divIcon({
    className: '',
    html: '<div style="position:relative;width:28px;height:38px">'
      + '<svg viewBox="0 0 30 40" width="28" height="38" style="filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))">'
      + '<path d="M15 0C7 0 1 6 1 14c0 9 14 26 14 26s14-17 14-26C29 6 23 0 15 0z" fill="#1a6ef5"/>'
      + '<circle cx="15" cy="14" r="6" fill="#fff"/></svg></div>',
    iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -34],
  });
}

// Base layers + tombol toggle Peta/Satelit (sama seperti halaman Sales)
function custAddBaseLayers(map) {
  const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' });
  const sat    = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 21, subdomains: '0123', attribution: '&copy; Google' });
  const labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png', { maxZoom: 19, pane: 'overlayPane' });
  const hybrid = L.layerGroup([sat, labels]);
  street.addTo(map); // default
  const layers = { street, hybrid };
  map._activeBase = 'street';

  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'map-toggle');
      div.innerHTML = '<button type="button" data-base="street" class="on">Peta</button>'
        + '<button type="button" data-base="hybrid">Satelit</button>';
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const key = b.dataset.base;
          if (map._activeBase === key) return;
          Object.values(layers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
          layers[key].addTo(map);
          map._activeBase = key;
          div.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.base === key));
        });
      });
      return div;
    }
  });
  map.addControl(new Ctl());
}

function custInitMap() {
  const host = document.getElementById('custMap');
  if (!host || typeof L === 'undefined') return;
  if (!_custMap) {
    _custMap = L.map(host, { scrollWheelZoom: true }).setView([-6.2, 106.81], 12);
    custAddBaseLayers(_custMap);
    _custMap.on('click', e => custSetPoint(e.latlng.lat, e.latlng.lng, true));
  }
  // Modal awalnya hidden → ukuran peta 0. Paksa recalculation setelah tampil.
  setTimeout(() => { try { _custMap.invalidateSize(); } catch (_) {} }, 200);

  // Kalau koordinat sudah terisi (mode edit), tampilkan pin di sana
  const lat = parseFloat(document.getElementById('custLatitude')?.value);
  const lng = parseFloat(document.getElementById('custLongitude')?.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    custSetPoint(lat, lng, false);
    setTimeout(() => { try { _custMap.setView([lat, lng], 16); } catch (_) {} }, 250);
  }
}

// Taruh/geser pin + isi field koordinat. recenterMap=true → peta pan ke titik.
function custSetPoint(lat, lng, recenterMap) {
  lat = +(+lat).toFixed(6); lng = +(+lng).toFixed(6);
  const latEl = document.getElementById('custLatitude');
  const lngEl = document.getElementById('custLongitude');
  if (latEl) latEl.value = lat;
  if (lngEl) lngEl.value = lng;
  if (_custMap) {
    if (_custMarker) _custMarker.setLatLng([lat, lng]);
    else {
      _custMarker = L.marker([lat, lng], { draggable: true, icon: _custPinIcon() }).addTo(_custMap)
        .on('dragend', ev => { const p = ev.target.getLatLng(); custSetPoint(p.lat, p.lng, false); });
    }
    if (recenterMap) _custMap.panTo([lat, lng]);
  }
}

// Field koordinat diketik manual → pindahkan pin
function custOnCoordInput() {
  const lat = parseFloat(document.getElementById('custLatitude')?.value);
  const lng = parseFloat(document.getElementById('custLongitude')?.value);
  if (!isNaN(lat) && !isNaN(lng) && _custMap) {
    custSetPoint(lat, lng, true);
    try { _custMap.setView([lat, lng], 16); } catch (_) {}
  }
}

// Tombol "Lokasi Saya" — pakai GPS browser
function custUseMyLocation() {
  const hint = document.getElementById('custGeoHint');
  if (!navigator.geolocation) {
    if (hint) { hint.textContent = 'Browser tidak mendukung GPS.'; hint.style.color = '#ea580c'; }
    return;
  }
  if (hint) { hint.textContent = 'Mengambil lokasi…'; hint.style.color = '#64748b'; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      custSetPoint(pos.coords.latitude, pos.coords.longitude, true);
      if (_custMap) { try { _custMap.setView([pos.coords.latitude, pos.coords.longitude], 17); } catch (_) {} }
      if (hint) { hint.textContent = '✓ Lokasi GPS terpasang. Geser pin untuk presisi.'; hint.style.color = '#16a34a'; }
    },
    err => { if (hint) { hint.textContent = 'Gagal ambil GPS: ' + err.message; hint.style.color = '#ea580c'; } },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

window.custInitMap        = custInitMap;
window.custSetPoint       = custSetPoint;
window.custOnCoordInput   = custOnCoordInput;
window.custUseMyLocation  = custUseMyLocation;
