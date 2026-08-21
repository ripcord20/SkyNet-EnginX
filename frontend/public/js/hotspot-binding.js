// hotspot-binding.js — Hotspot Binding Management (7 tabs)
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _dev = () => document.getElementById('routerSel')?.value || '';
const _q = id => document.getElementById(id);
let _routers = [], _scanResults = [], _profilesCache = [], _serversCache = [], _scanIface = '';
const LS_KEY = 'flaynet:hsbinding:router_id';
// Hotspot ops live under /mikrotik/hotspot, binding/scan helpers under /tools
const HS  = (p) => '/mikrotik/hotspot' + p;
const dev = (sep = '?') => _dev() ? `${sep}device_id=${_dev()}` : '';

// ── (8) Export CSV ──
function _csvCell(v){ v=(v==null?'':String(v)); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
function downloadCsv(filename, headers, rows){
  const lines=[headers.map(_csvCell).join(',')].concat(rows.map(r=>r.map(_csvCell).join(',')));
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  const ts=new Date().toISOString().slice(0,10);
  a.href=url; a.download=`${filename}-${ts}.csv`; document.body.appendChild(a); a.click();
  document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url),1000);
  App.showToast('CSV diunduh','success');
}
function exportUsersCsv(){ if(!_usersCache.length){App.showToast('Tidak ada data','warning');return;}
  downloadCsv('hotspot-users',['Username','Profile','Server','Address','MAC','Limit Uptime','Limit Bytes In','Limit Bytes Out','Bytes In','Bytes Out','Uptime','Status','Comment'],
    _usersCache.map(u=>[u.name,u.profile,u.server,u.address,u.macAddress,u.limitUptime,u.limitBytesIn,u.limitBytesOut,u.bytesIn,u.bytesOut,u.uptime,u.disabled?'disabled':'enabled',u.comment])); }
function exportBindingsCsv(){ if(!_bindCache.length){App.showToast('Tidak ada data','warning');return;}
  downloadCsv('ip-binding',['MAC','Address','To Address','Type','Server','Comment','Status'],
    _bindCache.map(b=>[b.macAddress,b.address,b.toAddress,b.type,b.server,b.comment,b.disabled?'disabled':'enabled'])); }
function exportCustomersCsv(){ if(!_custCache.length){App.showToast('Tidak ada data','warning');return;}
  downloadCsv('pelanggan-hotspot',['Nama','CID','MAC','IP','Router','Status','Tagihan Terakhir'],
    _custCache.map(c=>[c.name,c.customer_id,c.mac_address,c.static_ip,c.router_name,c.isolir_status==='isolated'?'Terisolir':'Aktif',c.last_inv_status||''])); }

document.addEventListener('DOMContentLoaded', loadRouters);

// ── Responsive: beri data-l (label) ke tiap <td> dari header kolom,
//    supaya tabel berubah jadi kartu rapi di layar HP. Otomatis jalan
//    setiap kali ada tabel baru di-render (MutationObserver).
function labelizeTable(tbl){
  if(!tbl||tbl.dataset.labelized==='1') return;
  const ths=[...tbl.querySelectorAll('thead th')].map(th=>th.textContent.trim());
  if(!ths.length) return;
  tbl.querySelectorAll('tbody tr').forEach(tr=>{
    [...tr.children].forEach((td,i)=>{ if(!td.hasAttribute('data-l')) td.setAttribute('data-l', ths[i]||''); });
  });
  // kolom terakhir (Aksi) → rata kanan & tanpa label
  tbl.querySelectorAll('tbody tr').forEach(tr=>{
    const last=tr.lastElementChild; if(last){ last.classList.add('ta-r'); last.setAttribute('data-l',''); }
  });
  tbl.dataset.labelized='1';
}
function labelizeAll(){ document.querySelectorAll('.hb-tbl').forEach(labelizeTable); }
const _hbObserver=new MutationObserver(()=>labelizeAll());
document.addEventListener('DOMContentLoaded',()=>{
  _hbObserver.observe(document.body,{childList:true,subtree:true});
  labelizeAll();
});

// ── ROUTER ──
async function loadRouters() {
  const d = await App.api('/tools/routers');
  const sel = _q('routerSel');
  if (!d?.success || !d.data?.length) { sel.innerHTML = '<option value="">— Tidak ada router —</option>'; return; }
  _routers = d.data;
  const saved = localStorage.getItem(LS_KEY);
  sel.innerHTML = _routers.map(r => `<option value="${r.id}" ${String(r.id)===String(saved)?'selected':''}>${_esc(r.name)} — ${_esc(r.ip_address)}</option>`).join('');
  if (!saved && _routers[0]) sel.value = _routers[0].id;
  onRouterChange();
}
function onRouterChange() {
  const id = _dev(); if (id) localStorage.setItem(LS_KEY, id);
  const r = _routers.find(x => String(x.id)===String(id));
  const pill = _q('routerProto');
  if (r && pill) { pill.textContent = (r.api_protocol||'auto').toUpperCase(); pill.style.display='inline-flex'; }
  stopTrafMonitor();        // router ganti → hentikan monitor lama
  stopHostsAutoRefresh();   // hentikan refresh host lama
  reloadActiveTab();
  loadTrafInterfaces();     // muat ulang interface hotspot & auto-start traffic
  checkConnStatus();        // cek koneksi router → badge
}

// ── (5) Badge status koneksi router ──
async function checkConnStatus(){
  const b=_q('connBadge'); if(!b) return;
  if(!_dev()){ b.style.display='none'; return; }
  b.style.display='inline-flex'; b.className='conn-badge chk'; b.innerHTML='<span class="dot"></span>cek…';
  try{
    const d=await App.api(HS('/conn-status')+dev());
    if(d?.connected){ b.className='conn-badge ok'; b.innerHTML=`<span class="dot"></span>${_esc(d.identity||'terhubung')}`; }
    else { b.className='conn-badge bad'; b.innerHTML='<span class="dot"></span>tidak terjangkau'; b.title=d?.error||''; }
  }catch(_){ b.className='conn-badge bad'; b.innerHTML='<span class="dot"></span>tidak terjangkau'; }
}
function currentTab() { return document.querySelector('.hb-tab.active')?.dataset.tab; }

// ── (6) Auto-refresh tabel tiap 30 detik (toggle) ──
let _autoRefreshTimer=null;
function toggleAutoRefresh(){
  const on=_q('autoRefresh')?.checked;
  if(_autoRefreshTimer){ clearInterval(_autoRefreshTimer); _autoRefreshTimer=null; }
  if(on){
    _autoRefreshTimer=setInterval(()=>{
      // refresh tab aktif secara halus + cek koneksi; jangan ganggu kalau ada modal terbuka
      if(_q('mdGeneric')?.classList.contains('show')) return;
      // tab Hosts sudah punya auto-refresh sendiri (5 dtk) → jangan dobel
      if(currentTab()!=='hosts') reloadActiveTab();
      checkConnStatus();
    }, 30000);
    App.showToast('Auto-refresh aktif (tiap 30 detik)','info');
  }
}
function reloadActiveTab() {
  switch (currentTab()) {
    case 'binding':  loadCustomers(); break;
    case 'servers':  loadServers(); break;
    case 'sprofiles':loadSProfiles(); break;
    case 'pools':    loadPools(); break;
    case 'profiles': loadProfiles(); break;
    case 'users':    loadUsers(); break;
    case 'active':   loadActive(); break;
    case 'hosts':    loadHosts(); break;
    case 'walled':   loadWalled(); break;
    case 'ipscan':   loadInterfaces(); break;
  }
}
function switchTab(tab) {
  if(tab!=='hosts') stopHostsAutoRefresh();   // hentikan refresh host saat pindah tab
  document.querySelectorAll('.hb-tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  document.querySelectorAll('.hb-panel').forEach(p => p.classList.remove('active'));
  _q('panel-'+tab)?.classList.add('active');
  reloadActiveTab();
}

// ── Generic modal ──
function openModal(html) { _q('mdBox').innerHTML = html; _q('mdGeneric').classList.add('show'); }
function closeModal() { _q('mdGeneric').classList.remove('show'); }
_q('mdGeneric').addEventListener('click', e => { if (e.target.id==='mdGeneric') closeModal(); });

// ── Confirm modal (mengganti window.confirm dengan tampilan yang menarik) ──
// Pakai: if(!await confirmAction({title,message,type,okText})) return;
const _CONFIRM_ICONS = {
  danger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  warn:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
};
let _confirmResolve = null;
function confirmAction(opts){
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  const type = o.type || 'danger';
  const back = _q('confirmBack'), ok = _q('confirmOk'), cancel = _q('confirmCancel'), ic = _q('confirmIc');
  _q('confirmTitle').textContent = o.title || 'Konfirmasi';
  _q('confirmMsg').textContent   = o.message || 'Apakah Anda yakin?';
  ic.className = 'confirm-ic ' + type; ic.innerHTML = _CONFIRM_ICONS[type] || _CONFIRM_ICONS.danger;
  cancel.textContent = o.cancelText || 'Batal';
  ok.textContent = o.okText || 'Ya, lanjutkan';
  ok.className = 'btn confirm-ok-' + type;
  back.classList.add('show');
  setTimeout(() => ok.focus(), 50);
  return new Promise(resolve => {
    _confirmResolve = resolve;
    const done = val => { back.classList.remove('show'); cleanup(); resolve(val); _confirmResolve = null; };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBack = e => { if (e.target.id === 'confirmBack') done(false); };
    const onKey = e => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    function cleanup(){
      ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel);
      back.removeEventListener('click', onBack); document.removeEventListener('keydown', onKey);
    }
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
    back.addEventListener('click', onBack); document.addEventListener('keydown', onKey);
  });
}

// ════════ TAB: BINDING & ISOLIR ════════
let _custCache=[], _custFilter='total', _mismatchIds=new Set();
let _sprofCache=[];
let _custSel=new Set(), _custSearch='';
async function loadCustomers() {
  const wrap = _q('custWrap'); wrap.innerHTML = '<div class="empty">Memuat…</div>';
  const d = await App.api('/tools/hotspot/customers');
  if (!d?.success) { wrap.innerHTML = `<div class="empty">Gagal: ${_esc(d?.message)}</div>`; return; }
  _custCache = d.data || [];
  _custSel.clear();
  const isolated = _custCache.filter(c=>c.isolir_status==='isolated').length;
  _q('stTotal').textContent = _custCache.length;
  _q('stActive').textContent = _custCache.length - isolated;
  _q('stIsolated').textContent = isolated;
  renderCustomers();
  if (_dev()) loadBindings(true);
}
function _custVisible(){
  let list=_custCache;
  if(_custFilter==='active')        list=list.filter(c=>c.isolir_status!=='isolated');
  else if(_custFilter==='isolated') list=list.filter(c=>c.isolir_status==='isolated');
  else if(_custFilter==='mismatch') list=list.filter(c=>_mismatchIds.has(c.id));
  const t=(_custSearch||'').toLowerCase().trim();
  if(t) list=list.filter(c=>`${c.name} ${c.customer_id} ${c.mac_address} ${c.static_ip} ${c.router_name}`.toLowerCase().includes(t));
  return list;
}
function renderCustomers(){
  const wrap=_q('custWrap'); if(!wrap) return;
  const list=_custVisible();
  const tag=_q('custFilterTag');
  if(tag){
    const labels={total:'',active:'Aktif',isolated:'Terisolir',mismatch:'Mismatch'};
    if(_custFilter!=='total'&&labels[_custFilter]){ tag.style.display='inline-flex';
      tag.innerHTML=`Filter: ${labels[_custFilter]} (${list.length}) <button onclick="statCardClick('total')" title="Hapus filter">×</button>`; }
    else tag.style.display='none';
  }
  if(!_custCache.length){ wrap.innerHTML='<div class="empty">Belum ada pelanggan tipe Hotspot. Set Tipe Koneksi = Hotspot + MAC di Customers, atau bind dari IP Scan.</div>'; return; }

  const bar=`<div class="hb-tblbar">
    <div class="hb-search"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="custSearch" placeholder="Cari nama / CID / MAC / IP…" value="${_esc(_custSearch)}" oninput="_custSearch=this.value;_custReRender()"></div>
    <button class="btn btn-ghost btn-sm" onclick="exportCustomersCsv()" title="Export CSV"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> CSV</button>
    <span style="font-size:12px;color:#94a3b8">${list.length} dari ${_custCache.length}</span>
  </div>`;
  const bulkBar=`<div class="bulk-bar${_custSel.size?' show':''}" id="custBulkBar">
    <span id="custSelCount">${_custSel.size} dipilih</span><span class="sp"></span>
    <button class="btn btn-danger btn-sm" onclick="bulkIsolir()">Isolir</button>
    <button class="btn btn-green btn-sm" onclick="bulkRestore()">Restore</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="custSelClear()">Batal</button>
  </div>`;

  if(!list.length){ wrap.innerHTML=bar+`<div class="empty">Tidak ada pelanggan yang cocok.</div>`; return; }
  const allChecked = list.length && list.every(c=>_custSel.has(c.id)) ? 'checked':'';
  wrap.innerHTML = bar+bulkBar+`<table class="hb-tbl"><thead><tr>
    <th style="width:36px"><input type="checkbox" class="row-chk" ${allChecked} onchange="custSelAll(this.checked)"></th>
    <th>Pelanggan</th><th>MAC</th><th>IP</th><th>Router</th><th>Tagihan</th><th>Status</th><th class="ta-r">Aksi</th></tr></thead><tbody>` +
    list.map(c => {
      const iso = c.isolir_status==='isolated';
      const inv = c.last_inv_status==='paid' ? '<span class="badge green">Lunas</span>' : (c.last_inv_status?`<span class="badge amber">${_esc(c.last_inv_status)}</span>`:'<span class="badge gray">–</span>');
      const btn = iso ? `<button class="btn btn-green btn-sm" onclick="doRestore(${c.id},'${_esc(c.name)}')">Restore</button>` : `<button class="btn btn-danger btn-sm" onclick="doIsolir(${c.id},'${_esc(c.name)}')">Isolir</button>`;
      const pingBtn = c.static_ip?`<button class="btn btn-ghost btn-sm" onclick="pingBinding('${(c.static_ip||'').replace(/'/g,'')}')" title="Test ping">Ping</button>`:'';
      const editBtn = `<button class="btn btn-blue btn-sm" onclick="openCustBindEdit(${c.id})">Edit</button>`;
      const histBtn = `<button class="btn btn-ghost btn-sm" onclick="openIsolirHistory(${c.id},'${_esc(c.name)}')" title="Riwayat isolir/restore">Riwayat</button>`;
      const checked=_custSel.has(c.id)?'checked':'';
      return `<tr><td style="width:36px"><input type="checkbox" class="row-chk" ${checked} onchange="custSelToggle(${c.id},this.checked)"></td>
        <td data-l="Pelanggan"><div style="font-weight:700">${_esc(c.name)}</div><div style="font-size:11px;color:#9aa8c4">${_esc(c.customer_id)}</div></td>
        <td data-l="MAC">${c.mac_address?`<span class="tag tag-mac">${_esc(c.mac_address)}</span>`:'–'}</td>
        <td data-l="IP">${c.static_ip?`<span class="tag tag-ip">${_esc(c.static_ip)}</span>`:'–'}</td>
        <td data-l="Router" style="font-size:12px">${_esc(c.router_name||'–')}</td><td data-l="Tagihan">${inv}</td>
        <td data-l="Status">${iso?'<span class="badge red">⛔ Terisolir</span>':'<span class="badge green">✓ Aktif</span>'}</td>
        <td class="ta-r" data-l=""><div class="row-actions">${pingBtn}${histBtn}${editBtn}${btn}</div></td></tr>`;
    }).join('') + '</tbody></table>';
}
function custSelToggle(id,on){ if(on)_custSel.add(id); else _custSel.delete(id); const bar=_q('custBulkBar'),c=_q('custSelCount'); if(bar)bar.classList.toggle('show',_custSel.size>0); if(c)c.textContent=`${_custSel.size} dipilih`; }
function custSelAll(on){ const vis=_custVisible(); if(on)vis.forEach(c=>_custSel.add(c.id)); else vis.forEach(c=>_custSel.delete(c.id)); renderCustomers(); }
function custSelClear(){ _custSel.clear(); renderCustomers(); }
// Re-render menjaga fokus & posisi kursor input pencarian
function _custReRender(){
  const el=_q('custSearch'); const pos=el?el.selectionStart:null;
  renderCustomers();
  const e2=_q('custSearch'); if(e2){ e2.focus(); if(pos!=null){ try{e2.setSelectionRange(pos,pos);}catch(_){} } }
}
async function bulkIsolir(){ if(!_custSel.size)return;
  if(!await confirmAction({type:'warn',title:'Isolir Massal',message:`Isolir ${_custSel.size} pelanggan terpilih? Binding/PPPoE/static akan diblokir di router.`,okText:'Ya, isolir semua'}))return;
  let ok=0; for(const id of [..._custSel]){ const d=await App.api(`/tools/hotspot/customers/${id}/isolir`,{method:'POST',body:'{}'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_custSel.size} pelanggan diisolir`,'success'); _custSel.clear(); loadCustomers(); }
async function bulkRestore(){ if(!_custSel.size)return;
  if(!await confirmAction({type:'success',title:'Restore Massal',message:`Aktifkan kembali akses untuk ${_custSel.size} pelanggan terpilih?`,okText:'Ya, restore semua'}))return;
  let ok=0; for(const id of [..._custSel]){ const d=await App.api(`/tools/hotspot/customers/${id}/restore`,{method:'POST',body:'{}'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_custSel.size} pelanggan di-restore`,'success'); _custSel.clear(); loadCustomers(); }

// (2) Riwayat aksi isolir/restore per pelanggan (dari isolir_logs)
function _trigLabel(t){ return ({manual:'Manual',payment:'Pembayaran',cron:'Otomatis (cron)',invoice_delete:'Hapus invoice',auto:'Otomatis'})[t]||(t||'-'); }
function _relTime(iso){ if(!iso)return '-';
  const d=new Date(iso.replace(' ','T')); const diff=(Date.now()-d.getTime())/1000;
  if(diff<60)return 'baru saja'; if(diff<3600)return Math.floor(diff/60)+' menit lalu';
  if(diff<86400)return Math.floor(diff/3600)+' jam lalu'; if(diff<2592000)return Math.floor(diff/86400)+' hari lalu';
  return d.toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}); }
async function openIsolirHistory(custId,name){
  openModal(`<h3>Riwayat Isolir — ${_esc(name)}</h3><p>Catatan isolir & restore untuk pelanggan ini.</p>
    <div id="histWrap" style="max-height:60vh;overflow:auto"><div class="empty">Memuat…</div></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Tutup</button></div>`);
  const d=await App.api(HS('/isolir-history/'+custId)+dev());
  const wrap=_q('histWrap'); if(!wrap)return;
  if(!d?.success){ wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`; return; }
  const rows=d.data||[];
  if(!rows.length){ wrap.innerHTML='<div class="empty">Belum ada riwayat isolir/restore.</div>'; return; }
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Waktu</th><th>Aksi</th><th>Metode</th><th>Pemicu</th><th>Oleh</th><th>Status</th></tr></thead><tbody>`+
    rows.map(r=>{
      const dt=r.created_at?new Date(String(r.created_at).replace(' ','T')):null;
      const dtFmt=dt?dt.toLocaleString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'-';
      const actBadge=r.action==='isolir'?'<span class="badge red">Isolir</span>':r.action==='restore'?'<span class="badge green">Restore</span>':`<span class="badge gray">${_esc(r.action||'-')}</span>`;
      const okBadge=r.success?'<span class="badge green">OK</span>':`<span class="badge red" title="${_esc(r.error_msg||'')}">Gagal</span>`;
      const method={static:'Static IP',pppoe:'PPPoE',hotspot_binding:'Hotspot Binding'}[r.isolir_method]||r.isolir_method||'-';
      return `<tr>
        <td data-l="Waktu"><div style="font-size:12px;font-weight:600">${dtFmt}</div><div style="font-size:10.5px;color:#94a3b8">${_relTime(r.created_at)}</div></td>
        <td data-l="Aksi">${actBadge}</td>
        <td data-l="Metode" style="font-size:12px">${_esc(method)}</td>
        <td data-l="Pemicu" style="font-size:12px">${_esc(_trigLabel(r.trigger_by))}</td>
        <td data-l="Oleh" style="font-size:12px">${_esc(r.user_name||(r.trigger_by==='manual'?'-':'sistem'))}</td>
        <td data-l="Status">${okBadge}</td></tr>`;
    }).join('')+'</tbody></table>';
}
// Edit MAC/IP binding pelanggan hotspot (tabel atas)
function openCustBindEdit(id){
  const c=(_custCache||[]).find(x=>String(x.id)===String(id));
  if(!c){App.showToast('Pelanggan tidak ditemukan, muat ulang dulu','warning');return;}
  openModal(`<h3>Edit Binding Pelanggan</h3><p>Ubah MAC / IP hotspot untuk <strong>${_esc(c.name)}</strong> (${_esc(c.customer_id)}).</p>
    <div class="fg" style="margin-bottom:11px"><label>MAC Address</label><input class="mono" id="cb_mac" value="${_esc(c.mac_address||'')}" placeholder="AA:BB:CC:DD:EE:FF"></div>
    <div class="fg" style="margin-bottom:11px"><label>IP Address <span class="fhint">(opsional)</span></label><input class="mono" id="cb_ip" value="${_esc(c.static_ip||'')}" placeholder="10.9.90.12"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="cb_save" onclick="saveCustBindEdit(${c.id})">Simpan</button></div>`);
}
async function saveCustBindEdit(id){
  const mac=_q('cb_mac').value.trim(), ip=_q('cb_ip').value.trim();
  if(!mac && !ip){App.showToast('Isi minimal MAC atau IP','warning');return;}
  if(mac && !/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(mac)){App.showToast('Format MAC tidak valid','warning');return;}
  if(ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)){App.showToast('Format IP tidak valid','warning');return;}
  const btn=_q('cb_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const d=await App.api('/tools/bind-customer',{method:'POST',body:JSON.stringify({customer_id:id,mac_address:mac,address:ip})});
  App.showToast(d?.message||'OK',d?.success?'success':'error');
  if(d?.success){closeModal();loadCustomers();} else {btn.disabled=false;btn.textContent='Simpan';}
}
// Klik stat card → pindah ke tab Binding, set filter, highlight card aktif
function statCardClick(kind){
  _custFilter=kind;
  // highlight kartu yg aktif (biru solid)
  const map={total:'hbs-total',active:'hbs-active',isolated:'hbs-isolated',mismatch:'hbs-mismatch'};
  document.querySelectorAll('.hbs-card').forEach(c=>c.classList.remove('sc-active'));
  _q(map[kind])?.classList.add('sc-active');
  // pastikan tab Binding aktif
  if(currentTab()!=='binding') switchTab('binding');
  // kalau pilih mismatch & belum pernah sync, jalankan sync dulu utk dapat datanya
  if(kind==='mismatch' && !_mismatchIds.size && _dev()){ runSync().then(()=>renderCustomers()); }
  else renderCustomers();
  // scroll ke daftar pelanggan
  _q('custWrap')?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function doIsolir(id,name){ if(!await confirmAction({type:'warn',title:'Isolir Pelanggan',message:`Isolir "${name}"? Binding akan dinonaktifkan & session di-kick.`,okText:'Ya, isolir'}))return; const d=await App.api(`/tools/hotspot/customers/${id}/isolir`,{method:'POST',body:'{}'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){loadCustomers(); if(_dev())loadBindings(true);} }
async function doRestore(id,name){ if(!await confirmAction({type:'success',title:'Restore Akses',message:`Aktifkan kembali akses internet untuk "${name}"?`,okText:'Ya, restore'}))return; const d=await App.api(`/tools/hotspot/customers/${id}/restore`,{method:'POST',body:'{}'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){loadCustomers(); if(_dev())loadBindings(true);} }
let _mismatchData=[];
async function runSync(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;} App.showToast('Memeriksa binding di router\u2026','info');
  const d=await App.api('/tools/hotspot/sync'+dev()); if(!d?.success){App.showToast('Sync gagal: '+_esc(d?.message),'error');return;}
  _q('stMismatch').textContent=d.mismatch_count;
  const b=_q('tools-mismatch-badge'); if(b){b.textContent=d.mismatch_count;b.style.display=d.mismatch_count?'inline-flex':'none';}
  const mm=(d.data||[]).filter(r=>r.mismatch);
  _mismatchIds=new Set(mm.map(m=>m.id).filter(v=>v!=null));
  _mismatchData=mm;
  if(_custFilter==='mismatch') renderCustomers();
  renderMismatch();
  if(!mm.length) App.showToast(`\u2713 Semua ${d.total} pelanggan sinkron`,'success');
  else App.showToast(`\u26a0 ${d.mismatch_count} dari ${d.total} tidak sinkron \u2014 lihat panel "Perlu Perhatian"`,'warning');
}
function renderMismatch(){
  const card=_q('mismatchCard'), wrap=_q('mismatchWrap'); if(!card||!wrap) return;
  if(!_mismatchData.length){ card.style.display='none'; return; }
  card.style.display='block';
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Pelanggan</th><th>MAC / IP</th><th>DB</th><th>Router</th><th>Masalah</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    _mismatchData.map((m,i)=>{
      const dbBadge = m.db_status==='isolated' ? '<span class="badge red">isolir</span>' : '<span class="badge green">aktif</span>';
      const mtBadge = m.mt_state==='disabled' ? '<span class="badge red">disabled</span>'
                    : m.mt_state==='enabled' ? '<span class="badge green">enabled</span>'
                    : '<span class="badge gray">tidak ada</span>';
      return `<tr>
        <td data-l="Pelanggan"><div style="font-weight:700">${_esc(m.name)}</div><div style="font-size:11px;color:#9aa8c4">${_esc(m.customer_id||'')}</div></td>
        <td data-l="MAC/IP" style="font-size:11px">${m.mac_address?`<span class="tag tag-mac">${_esc(m.mac_address)}</span><br>`:''}${m.static_ip?`<span class="tag tag-ip">${_esc(m.static_ip)}</span>`:''}</td>
        <td data-l="DB">${dbBadge}</td>
        <td data-l="Router">${mtBadge}</td>
        <td data-l="Masalah" style="font-size:11.5px;color:#92400e">${_esc(m.note)}</td>
        <td class="ta-r" data-l=""><button class="btn btn-amber btn-sm" onclick="fixMismatch(${i})">Perbaiki</button></td></tr>`;
    }).join('')+'</tbody></table>';
}
async function fixMismatch(idx){ const m=_mismatchData[idx]; if(!m) return;
  const wantIsolir = m.db_status==='isolated';
  if(!await confirmAction({type:wantIsolir?'warn':'success',title:'Perbaiki Sinkronisasi',
    message:`Samakan router dengan DB untuk "${m.name}"? DB: ${wantIsolir?'isolir':'aktif'} \u2192 router akan di-${wantIsolir?'isolir':'restore'}.`,
    okText:'Ya, perbaiki'}))return;
  const ep = wantIsolir ? `/tools/hotspot/customers/${m.id}/isolir` : `/tools/hotspot/customers/${m.id}/restore`;
  const d=await App.api(ep,{method:'POST',body:'{}'});
  App.showToast(d?.message||(d?.success?'Diperbaiki':'Gagal'),d?.success?'success':'error');
  if(d?.success){ _mismatchData.splice(idx,1); renderMismatch(); loadCustomers(); }
}
async function fixAllMismatch(){ if(!_mismatchData.length)return;
  if(!await confirmAction({type:'warn',title:'Perbaiki Semua',message:`Samakan router dengan DB untuk ${_mismatchData.length} pelanggan tidak sinkron?`,okText:'Ya, perbaiki semua'}))return;
  const btn=_q('fixAllBtn'); if(btn){btn.disabled=true;btn.innerHTML='<span class="spinner"></span>';}
  let ok=0; const total=_mismatchData.length;
  for(const m of [..._mismatchData]){
    const wantIsolir=m.db_status==='isolated';
    const ep=wantIsolir?`/tools/hotspot/customers/${m.id}/isolir`:`/tools/hotspot/customers/${m.id}/restore`;
    const d=await App.api(ep,{method:'POST',body:'{}'}); if(d?.success)ok++;
  }
  App.showToast(`${ok}/${total} diperbaiki`,'success');
  if(btn){btn.disabled=false;btn.textContent='Perbaiki Semua';}
  runSync();
}
let _bindCache=[], _bindSel=new Set(), _bindSearch='';
let _bindPage=1, _bindPageSize=50;
function _bindReRender(){
  const el=_q('bindSearch'); const pos=el?el.selectionStart:null;
  _bindPage=1; // reset ke halaman 1 saat search berubah
  renderBindings();
  const e2=_q('bindSearch'); if(e2){ e2.focus(); if(pos!=null){ try{e2.setSelectionRange(pos,pos);}catch(_){} } }
}
function bindSetPageSize(n){ _bindPageSize=(n==='all')?'all':parseInt(n); _bindPage=1; renderBindings(); }
function bindGoPage(p){ _bindPage=p; renderBindings(); const w=_q('bindingsWrap'); if(w) w.scrollIntoView({behavior:'smooth',block:'start'}); }
async function loadBindings(silent){ if(!_dev()){ if(!silent)App.showToast('Pilih router dulu','warning'); return;}
  const wrap=_q('bindingsWrap'); if(!silent) wrap.innerHTML='<div class="empty">Memuat dari router…</div>';
  const d=await App.api(HS('/ip-binding')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  let list=d.data||[];
  // Dedupe binding ganda (MAC+IP+type+server sama) — tampilkan hanya 1, prioritaskan yang enabled
  const seen=new Map();
  for(const b of list){ const key=`${(b.macAddress||'').toUpperCase()}|${b.address||''}|${b.type||''}|${b.server||''}`;
    const ex=seen.get(key);
    if(!ex) seen.set(key,b);
    else if(ex.disabled && !b.disabled) seen.set(key,b);
  }
  _bindCache=[...seen.values()];
  _bindSel.clear();
  renderBindings();
}
function renderBindings(){
  const wrap=_q('bindingsWrap'); if(!wrap) return;
  if(!_bindCache.length){wrap.innerHTML='<div class="empty">Tidak ada IP Binding.</div>';return;}
  const term=(_bindSearch||'').toLowerCase().trim();
  const fStatus=_q('bindFilter')?.value||'all';
  let list=_bindCache.filter(b=>{
    if(fStatus==='enabled' && b.disabled) return false;
    if(fStatus==='disabled' && !b.disabled) return false;
    if(fStatus==='bypassed' && b.type!=='bypassed') return false;
    if(!term) return true;
    const cust=(_custCache||[]).find(c=>((b.macAddress||'').toUpperCase()===(c.mac_address||'').toUpperCase())||((b.address||'').trim()===(c.static_ip||'').trim()));
    return `${b.macAddress} ${b.address} ${b.type} ${b.server} ${b.comment} ${cust?cust.name+' '+cust.customer_id:''}`.toLowerCase().includes(term);
  });

  const bar=`<div class="hb-tblbar">
    <div class="hb-search"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="bindSearch" placeholder="Cari MAC / IP / nama / comment…" value="${_esc(_q('bindSearch')?.value||_bindSearch||'')}" oninput="_bindSearch=this.value;_bindReRender()"></div>
    <select class="hb-fselect" id="bindFilter" onchange="_bindPage=1;renderBindings()">
      <option value="all"${fStatus==='all'?' selected':''}>Semua status</option>
      <option value="enabled"${fStatus==='enabled'?' selected':''}>Enabled</option>
      <option value="disabled"${fStatus==='disabled'?' selected':''}>Disabled (isolir)</option>
      <option value="bypassed"${fStatus==='bypassed'?' selected':''}>Type: bypassed</option>
    </select>
    <select class="hb-fselect" id="bindPageSize" onchange="bindSetPageSize(this.value)" title="Jumlah baris per halaman">
      ${[50,100,200,300,500].map(n=>`<option value="${n}"${_bindPageSize===n?' selected':''}>Show ${n}</option>`).join('')}
      <option value="all"${_bindPageSize==='all'?' selected':''}>Show semua</option>
    </select>
    <button class="btn btn-ghost btn-sm" onclick="exportBindingsCsv()" title="Export CSV"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> CSV</button>
    <span style="font-size:12px;color:#94a3b8">${list.length} dari ${_bindCache.length}</span>
  </div>`;

  const bulkBar=`<div class="bulk-bar${_bindSel.size?' show':''}" id="bindBulkBar">
    <span id="bindSelCount">${_bindSel.size} dipilih</span><span class="sp"></span>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="bulkBindToggle(true)">Enable</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="bulkBindToggle(false)">Disable</button>
    <button class="btn btn-danger btn-sm" onclick="bulkBindDelete()">Hapus</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="bindSelClear()">Batal</button>
  </div>`;

  // ── Pagination: potong list sesuai halaman & ukuran ──
  const total=list.length;
  const pageSize = _bindPageSize==='all' ? (total||1) : _bindPageSize;
  const totalPages = Math.max(1, Math.ceil(total/pageSize));
  if(_bindPage>totalPages) _bindPage=totalPages;
  if(_bindPage<1) _bindPage=1;
  const startIdx=(_bindPage-1)*pageSize;
  const pageList = _bindPageSize==='all' ? list : list.slice(startIdx, startIdx+pageSize);

  const rows=pageList.map(b=>{
    const typeBadge = b.type==='blocked' ? '<span class="badge red">blocked</span>'
                    : b.type==='bypassed' ? '<span class="badge green">bypassed</span>'
                    : `<span class="badge gray">${_esc(b.type)}</span>`;
    const statusBadge = b.disabled ? '<span class="badge red">⛔ disabled (isolir)</span>' : '<span class="badge green">✓ enabled</span>';
    const _bMac=(b.macAddress||'').toUpperCase(), _bIp=(b.address||'').trim();
    const cust=(_custCache||[]).find(c=>(_bMac&&(c.mac_address||'').toUpperCase()===_bMac)||(_bIp&&(c.static_ip||'').trim()===_bIp));
    const custCell = cust
      ? `<div style="line-height:1.3"><span style="font-weight:700;color:var(--hb-text)">${_esc(cust.name)}</span><br><span style="font-size:11px;color:#94a3b8">${_esc(cust.customer_id||'')}</span></div>`
      : `<span style="font-size:12px;color:#cbd5e1">belum terdaftar</span>`;
    const checked=_bindSel.has(b.id)?'checked':'';
    return `<tr>
      <td style="width:36px"><input type="checkbox" class="row-chk" ${checked} onchange="bindSelToggle('${b.id}',this.checked)"></td>
      <td data-l="MAC">${b.macAddress?`<span class="tag tag-mac">${_esc(b.macAddress)}</span>`:'–'}</td>
      <td data-l="Address">${b.address?`<span class="tag tag-ip">${_esc(b.address)}</span>`:'–'}</td>
      <td data-l="Type">${typeBadge}</td><td data-l="Server" style="font-size:12px">${_esc(b.server)}</td>
      <td data-l="Pelanggan">${custCell}</td>
      <td data-l="Status">${statusBadge}</td>
      <td class="ta-r" data-l=""><div class="row-actions">
        ${b.address?`<button class="btn btn-ghost btn-sm" onclick="pingBinding('${(b.address||'').replace(/'/g,'')}')" title="Test ping ke IP ini">Ping</button>`:''}
        <button class="btn btn-blue btn-sm" onclick="openBindingEdit('${b.id}')" title="Edit binding">Edit</button>
        ${cust ? '' : `<button class="btn btn-green btn-sm" onclick="openBindCust('${(b.macAddress||'').replace(/'/g,'')}','${(b.address||'').replace(/'/g,'')}','binding')" title="Jadikan pelanggan tipe Hotspot">Bind ke Customer</button>`}
        ${b.disabled?`<button class="btn btn-green btn-sm" onclick="toggleBinding('${b.id}',false)">Enable</button>`:`<button class="btn btn-ghost btn-sm" onclick="toggleBinding('${b.id}',true)">Disable</button>`}
        <button class="btn btn-danger btn-sm" onclick="delBinding('${b.id}')">Hapus</button></div></td></tr>`;
  }).join('');

  const allChecked = pageList.length && pageList.every(b=>_bindSel.has(b.id)) ? 'checked' : '';

  // ── Kontrol pagination ──
  let pager='';
  if(_bindPageSize!=='all' && totalPages>1){
    const from=startIdx+1, to=Math.min(startIdx+pageSize, total);
    const btn=(p,label,dis,act)=>`<button class="hb-pg-btn${act?' act':''}" ${dis?'disabled':''} onclick="bindGoPage(${p})">${label}</button>`;
    // window halaman: tampilkan maks 5 nomor di sekitar halaman aktif
    let nums=[]; const win=2;
    let lo=Math.max(1,_bindPage-win), hi=Math.min(totalPages,_bindPage+win);
    if(lo>1){ nums.push(btn(1,'1',false,_bindPage===1)); if(lo>2) nums.push('<span class="hb-pg-dots">…</span>'); }
    for(let p=lo;p<=hi;p++) nums.push(btn(p,String(p),false,p===_bindPage));
    if(hi<totalPages){ if(hi<totalPages-1) nums.push('<span class="hb-pg-dots">…</span>'); nums.push(btn(totalPages,String(totalPages),false,_bindPage===totalPages)); }
    pager=`<div class="hb-pager">
      <span class="hb-pg-info">Menampilkan ${from}–${to} dari ${total}</span>
      <div class="hb-pg-ctrl">
        ${btn(_bindPage-1,'‹ Prev',_bindPage<=1,false)}
        ${nums.join('')}
        ${btn(_bindPage+1,'Next ›',_bindPage>=totalPages,false)}
      </div>
    </div>`;
  } else if(total>0){
    pager=`<div class="hb-pager"><span class="hb-pg-info">Menampilkan ${total} baris</span></div>`;
  }

  wrap.innerHTML=bar+bulkBar+`<table class="hb-tbl"><thead><tr>
    <th style="width:36px"><input type="checkbox" class="row-chk" ${allChecked} onchange="bindSelAll(this.checked)"></th>
    <th>MAC</th><th>Address</th><th>Type</th><th>Server</th><th>Pelanggan</th><th>Status</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+rows+'</tbody></table>'+pager;
}
function bindSelToggle(id,on){ if(on)_bindSel.add(id); else _bindSel.delete(id); _updateBindBulk(); }
function bindSelAll(on){ const term=(_bindSearch||'').toLowerCase().trim(); const fStatus=_q('bindFilter')?.value||'all';
  const visible=_bindCache.filter(b=>{ if(fStatus==='enabled'&&b.disabled)return false; if(fStatus==='disabled'&&!b.disabled)return false; if(fStatus==='bypassed'&&b.type!=='bypassed')return false;
    if(!term)return true; return `${b.macAddress} ${b.address} ${b.type} ${b.server} ${b.comment}`.toLowerCase().includes(term); });
  if(on) visible.forEach(b=>_bindSel.add(b.id)); else visible.forEach(b=>_bindSel.delete(b.id)); renderBindings(); }
function bindSelClear(){ _bindSel.clear(); renderBindings(); }
function _updateBindBulk(){ const bar=_q('bindBulkBar'),c=_q('bindSelCount'); if(bar)bar.classList.toggle('show',_bindSel.size>0); if(c)c.textContent=`${_bindSel.size} dipilih`; }
async function bulkBindToggle(enable){ if(!_bindSel.size)return;
  if(!await confirmAction({type:enable?'success':'warn',title:(enable?'Enable':'Disable')+' Massal',message:`${enable?'Aktifkan':'Nonaktifkan'} ${_bindSel.size} binding terpilih di router?`,okText:'Ya, lanjut'}))return;
  let ok=0; for(const id of [..._bindSel]){ const d=await App.api(`/tools/hotspot/bindings/${id}/toggle`+dev(),{method:'POST',body:JSON.stringify({disabled:!enable,device_id:_dev()})}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_bindSel.size} binding di-${enable?'enable':'disable'}`,'success'); _bindSel.clear(); loadBindings(); }
async function bulkBindDelete(){ if(!_bindSel.size)return;
  if(!await confirmAction({type:'danger',title:'Hapus Massal',message:`Hapus ${_bindSel.size} IP binding terpilih dari router? Tindakan ini tidak bisa dibatalkan.`,okText:'Ya, hapus semua'}))return;
  let ok=0; for(const id of [..._bindSel]){ const d=await App.api(HS('/ip-binding/'+id)+dev(),{method:'DELETE'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_bindSel.size} binding dihapus`,'success'); _bindSel.clear(); loadBindings(); }
// Test ping ke satu IP (test koneksi pelanggan)
async function pingBinding(ip){ if(!ip)return;
  App.showToast(`Ping ${ip}…`,'info');
  const d=await App.api(HS('/ping')+dev(),{method:'POST',body:JSON.stringify({device_id:_dev(),ip})});
  if(d?.success) App.showToast(d.message, d.alive?'success':'warning');
  else App.showToast('Ping gagal: '+_esc(d?.message),'error'); }

// (5) Edit binding inline — ubah type/server/comment/MAC/address/to-address
function openBindingEdit(id){
  const b=(_bindCache||[]).find(x=>String(x.id)===String(id));
  if(!b){App.showToast('Binding tidak ditemukan, muat ulang dulu','warning');return;}
  openModal(`<h3>Edit IP Binding</h3><p>Ubah binding tanpa hapus-buat-ulang (paritas Winbox).</p>
    <div class="fg" style="margin-bottom:11px"><label>MAC Address</label><input class="mono" id="be_mac" value="${_esc(b.macAddress||'')}" placeholder="AA:BB:CC:DD:EE:FF" style="text-transform:uppercase"></div>
    <div class="fg" style="margin-bottom:11px"><label>Address (IP)</label><input class="mono" id="be_addr" value="${_esc(b.address||'')}" placeholder="192.168.1.50"></div>
    <div class="fg" style="margin-bottom:11px"><label>To Address</label><input class="mono" id="be_toaddr" value="${_esc(b.toAddress||'')}" placeholder="opsional"></div>
    <div class="fg" style="margin-bottom:11px"><label>Server</label><select id="be_server"><option value="all">all</option></select></div>
    <div class="fg" style="margin-bottom:11px"><label>Type</label><select id="be_type">
      <option value="bypassed"${b.type==='bypassed'?' selected':''}>bypassed</option>
      <option value="regular"${b.type==='regular'?' selected':''}>regular</option>
      <option value="blocked"${b.type==='blocked'?' selected':''}>blocked</option></select></div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="be_comment" value="${_esc(b.comment||'')}" placeholder="opsional"></div>
    <input type="hidden" id="be_id" value="${_esc(b.id)}">
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="be_save" onclick="saveBindingEdit()">Update</button></div>`);
  // Isi dropdown server, set selected = server binding saat ini
  App.api(HS('/servers')+dev()).then(d=>{
    const sel=_q('be_server'); if(!sel)return;
    let opts='<option value="all">all</option>';
    if(d?.success && Array.isArray(d.data)) opts+=d.data.map(s=>`<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join('');
    sel.innerHTML=opts;
    if(b.server && [...sel.options].some(o=>o.value===b.server)) sel.value=b.server;
  }).catch(()=>{});
}
async function saveBindingEdit(){
  const id=_q('be_id').value; if(!id)return;
  const btn=_q('be_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const payload={device_id:_dev(),
    macAddress:_q('be_mac').value.trim().toUpperCase(),
    address:_q('be_addr').value.trim(),
    toAddress:_q('be_toaddr').value.trim(),
    server:_q('be_server').value,
    type:_q('be_type').value,
    comment:_q('be_comment').value.trim()};
  const d=await App.api(HS('/ip-binding/'+id)+dev(),{method:'PATCH',body:JSON.stringify(payload)});
  App.showToast(d?.message||'OK',d?.success?'success':'error');
  if(d?.success){closeModal();loadBindings();} else {btn.disabled=false;btn.textContent='Update';}
}
async function toggleBinding(id,disabled){ const d=await App.api(`/tools/hotspot/bindings/${id}/toggle`+dev(),{method:'POST',body:JSON.stringify({disabled,device_id:_dev()})}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadBindings(); }
async function delBinding(id){ if(!await confirmAction({type:'danger',title:'Hapus IP Binding',message:'Hapus IP binding ini dari router?',okText:'Ya, hapus'}))return; const d=await App.api(HS('/ip-binding/'+id)+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadBindings(); }
async function dedupeBindings(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  if(!await confirmAction({type:'warn',title:'Bersihkan Binding Duplikat',message:'Hapus semua IP binding yang dobel (MAC/IP sama), sisakan satu per perangkat. Lanjutkan?',okText:'Ya, bersihkan'}))return;
  const d=await App.api(HS('/ip-binding/dedupe')+dev(),{method:'POST',body:'{}'});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadBindings(); }
function openBindingModal(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  openModal(`<h3>Tambah IP Binding</h3><p>Buat binding baru di router terpilih (sesuai New Hotspot IP Binding di Winbox).</p>
    <div class="fg" style="margin-bottom:11px"><label>MAC Address</label><input class="mono" id="m_mac" placeholder="AA:BB:CC:DD:EE:FF" style="text-transform:uppercase"></div>
    <div class="fg" style="margin-bottom:11px"><label>Address (IP)</label><input class="mono" id="m_addr" placeholder="192.168.1.50"></div>
    <div class="fg" style="margin-bottom:11px"><label>To Address</label><input class="mono" id="m_toaddr" placeholder="opsional — IP tujuan translasi"></div>
    <div class="fg" style="margin-bottom:11px"><label>Server</label><select id="m_server"><option value="all">all</option></select></div>
    <div class="fg" style="margin-bottom:11px"><label>Type</label><select id="m_type"><option value="bypassed">bypassed</option><option value="regular">regular</option><option value="blocked">blocked</option></select></div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="m_comment" placeholder="opsional"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="m_save" onclick="saveBinding()">Simpan</button></div>`);
  // Isi dropdown Server dari hotspot server di router (default 'all')
  App.api(HS('/servers')+dev()).then(d=>{
    const sel=_q('m_server'); if(!sel)return;
    let opts='<option value="all">all</option>';
    if(d?.success && Array.isArray(d.data)) opts+=d.data.map(s=>`<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join('');
    sel.innerHTML=opts;
  }).catch(()=>{});
}
async function saveBinding(){ const mac=_q('m_mac').value.trim().toUpperCase(),addr=_q('m_addr').value.trim();
  if(!mac&&!addr){App.showToast('Isi MAC atau Address','warning');return;}
  const btn=_q('m_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const payload={device_id:_dev(),mac_address:mac,address:addr,
    toAddress:_q('m_toaddr').value.trim(),
    server:_q('m_server').value,
    type:_q('m_type').value,
    comment:_q('m_comment').value.trim()};
  const d=await App.api(HS('/ip-binding')+dev(),{method:'POST',body:JSON.stringify(payload)});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadBindings();} else {btn.disabled=false;btn.textContent='Simpan';}
}

// ════════ TAB: SERVERS ════════
async function loadServers(){ if(!_dev()){_q('serversWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('serversWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/servers')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  _serversCache=d.data||[];
  if(!_serversCache.length){wrap.innerHTML='<div class="empty">Belum ada hotspot server. Klik "Setup Server Baru".</div>';return;}
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Nama</th><th>Interface</th><th>Address Pool</th><th>Profile</th><th>Status</th><th style="text-align:right">Aksi</th></tr></thead><tbody>`+
    _serversCache.map(s=>`<tr><td style="font-weight:700">${_esc(s.name)}</td><td>${_esc(s.interface)}</td>
      <td style="font-size:12px">${_esc(s.addressPool||'–')}</td><td>${_esc(s.profile)}</td>
      <td>${s.disabled?'<span class="badge gray">disabled</span>':'<span class="badge green">running</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-blue btn-sm" onclick="openServerEdit('${s.id}')">Edit</button>
        ${s.disabled?`<button class="btn btn-green btn-sm" onclick="toggleServer('${s.id}',false)">Enable</button>`:`<button class="btn btn-ghost btn-sm" onclick="toggleServer('${s.id}',true)">Disable</button>`}
        <button class="btn btn-danger btn-sm" onclick="delServer('${s.id}','${_esc(s.name)}')">Hapus</button></td></tr>`).join('')+'</tbody></table>';
}
async function toggleServer(id,disabled){ const d=await App.api(HS('/servers/'+id+'/toggle')+dev(),{method:'POST',body:JSON.stringify({disabled,device_id:_dev()})}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadServers(); }
async function delServer(id,name){ if(!await confirmAction({type:'danger',title:'Hapus Hotspot Server',message:`Hapus hotspot server "${name}"? Tindakan ini tidak bisa dibatalkan.`,okText:'Ya, hapus'}))return; const d=await App.api(HS('/servers/'+id)+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadServers(); }
async function openSetupModal(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  openModal(`<h3>Setup Hotspot Server</h3><p>Membuat IP pool, server profile, hotspot server, sekaligus set DNS server (seperti wizard di MikroTik).</p>
    <div class="fg" style="margin-bottom:11px"><label>Nama Server *</label><input id="s_name" placeholder="hotspot1"></div>
    <div class="fg" style="margin-bottom:11px"><label>Interface *</label><select id="s_iface" onchange="onSetupIfaceChange()"><option value="">— Memuat… —</option></select></div>
    <div id="s_info" style="font-size:11.5px;color:#64748b;margin-bottom:11px;display:none;padding:8px 11px;background:var(--hb-blue-soft);border-radius:8px"></div>
    <div class="fg" style="margin-bottom:11px"><label>IP Pool Range <span class="fhint">(auto dari IP interface)</span></label><input class="mono" id="s_pool" placeholder="pilih interface → terisi otomatis"></div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>DNS Server 1 <span class="fhint">(diberikan ke client)</span></label><input class="mono" id="s_dns1" value="8.8.8.8" placeholder="8.8.8.8"></div>
      <div class="fg"><label>DNS Server 2 <span class="fhint">(opsional)</span></label><input class="mono" id="s_dns2" value="1.1.1.1" placeholder="1.1.1.1"></div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>DNS Name (login page) <span class="fhint">(opsional)</span></label><input id="s_dns" placeholder="hotspot.flaynet.id"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="s_save" onclick="saveSetup()">Setup</button></div>`);
  const d=await App.api(HS('/interfaces')+dev());
  const sel=_q('s_iface');
  if(d?.success&&d.data?.length) sel.innerHTML='<option value="">— Pilih interface —</option>'+d.data.map(i=>`<option value="${_esc(i.name)}">${_esc(i.name)}${i.running?'':' (down)'}</option>`).join('');
  else sel.innerHTML='<option value="">— Gagal memuat —</option>';
}
async function onSetupIfaceChange(){ const iface=_q('s_iface').value; const info=_q('s_info');
  if(!iface){info.style.display='none';return;}
  if(!_q('s_name').value) _q('s_name').value=iface;
  info.style.display='block'; info.innerHTML='<span class="spinner dark"></span> Membaca IP interface…';
  const d=await App.api('/mikrotik/ippool/suggest?interface='+encodeURIComponent(iface)+dev('&'));
  if(!d?.success){info.innerHTML='Gagal membaca IP: '+_esc(d?.message);return;}
  const s=d.data;
  if(!s.found){ info.innerHTML=`⚠ Interface <strong>${_esc(iface)}</strong> belum punya IP. Isi range pool manual, atau pasang IP di interface dulu.`; }
  else if(!s.suggestedRange){ info.innerHTML=`IP: <strong>${_esc(s.address)}</strong> · subnet kecil, isi range manual.`; }
  else { info.innerHTML=`IP: <strong>${_esc(s.address)}</strong> · Gateway ${_esc(s.gateway)}<br>Saran pool: <strong>${_esc(s.suggestedRange)}</strong>`; _q('s_pool').value=s.suggestedRange; }
}
async function saveSetup(){ const name=_q('s_name').value.trim(),iface=_q('s_iface').value;
  if(!name||!iface){App.showToast('Nama & interface wajib','warning');return;}
  // Gabungkan DNS server (1 & 2) → string "8.8.8.8,1.1.1.1" seperti di MikroTik
  const ipOk=v=>/^\d{1,3}(\.\d{1,3}){3}$/.test(v);
  const dns1=_q('s_dns1').value.trim(), dns2=_q('s_dns2').value.trim();
  if(dns1&&!ipOk(dns1)){App.showToast('DNS Server 1 tidak valid','warning');return;}
  if(dns2&&!ipOk(dns2)){App.showToast('DNS Server 2 tidak valid','warning');return;}
  const dnsServers=[dns1,dns2].filter(Boolean).join(',');
  const btn=_q('s_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Setup…';
  const d=await App.api(HS('/servers/setup')+dev(),{method:'POST',body:JSON.stringify({device_id:_dev(),name,interface:iface,poolRange:_q('s_pool').value.trim(),dnsName:_q('s_dns').value.trim(),dnsServers})});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadServers();} else {btn.disabled=false;btn.textContent='Setup';}
}

// ── Edit server (Servers > Hotspot Server) ──
async function openServerEdit(id){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  const s=(_serversCache||[]).find(x=>String(x.id)===String(id));
  if(!s){App.showToast('Server tidak ditemukan, muat ulang dulu','warning');return;}
  openModal(`<h3>Edit Hotspot Server</h3><p>Ubah konfigurasi server <strong>${_esc(s.name)}</strong>.</p>
    <div class="fg" style="margin-bottom:11px"><label>Nama Server *</label><input id="se_name" value="${_esc(s.name)}"></div>
    <div class="fg" style="margin-bottom:11px"><label>Interface *</label><select id="se_iface"><option value="${_esc(s.interface)}">${_esc(s.interface)} (saat ini)</option></select></div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Address Pool</label><select id="se_pool"><option value="${_esc(s.addressPool)}">${_esc(s.addressPool||'none')} (saat ini)</option></select></div>
      <div class="fg"><label>Profile</label><input id="se_profile" value="${_esc(s.profile)}"></div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>Idle Timeout</label><input id="se_idle" value="${_esc(s.idleTimeout==='none'?'':s.idleTimeout)}" placeholder="none / 00:05:00"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="se_save" onclick="saveServerEdit('${s.id}')">Simpan</button></div>`);
  // Isi dropdown interface
  const di=await App.api(HS('/interfaces')+dev()); const isel=_q('se_iface');
  if(di?.success&&di.data?.length){
    isel.innerHTML=di.data.map(i=>`<option value="${_esc(i.name)}" ${i.name===s.interface?'selected':''}>${_esc(i.name)}${i.running?'':' (down)'}</option>`).join('');
  }
  // Isi dropdown address pool
  const dp=await App.api('/mikrotik/ippool'+dev()); const psel=_q('se_pool');
  if(dp?.success&&Array.isArray(dp.data)){
    psel.innerHTML='<option value="">none</option>'+dp.data.map(p=>`<option value="${_esc(p.name)}" ${p.name===s.addressPool?'selected':''}>${_esc(p.name)}</option>`).join('');
  }
}
async function saveServerEdit(id){ const name=_q('se_name').value.trim(),iface=_q('se_iface').value;
  if(!name||!iface){App.showToast('Nama & interface wajib','warning');return;}
  const btn=_q('se_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const body={device_id:_dev(),name,interface:iface,addressPool:_q('se_pool').value,profile:_q('se_profile').value.trim()||'default'};
  const idle=_q('se_idle').value.trim(); if(idle) body.idleTimeout=idle;
  const d=await App.api(HS('/servers/'+id)+dev(),{method:'PUT',body:JSON.stringify(body)});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadServers();} else {btn.disabled=false;btn.textContent='Simpan';}
}
async function loadPools(){ if(!_dev()){_q('poolsWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('poolsWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api('/mikrotik/ippool'+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  const list=d.data||[];
  if(!list.length){wrap.innerHTML='<div class="empty">Belum ada IP pool. Klik "Buat dari Interface" atau "Pool Manual".</div>';return;}
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Nama</th><th>Ranges</th><th>Total / Terpakai</th><th>Usage</th><th>Next Pool</th><th style="text-align:right">Aksi</th></tr></thead><tbody>`+
    list.map(p=>{
      const pct=p.usedPercent||0;
      const bar=`<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;background:#eef2f9;border-radius:4px;overflow:hidden;min-width:60px"><div style="height:100%;width:${pct}%;background:${pct>85?'var(--hb-red)':pct>60?'var(--hb-amber)':'var(--hb-green)'}"></div></div><span style="font-size:11px;color:#64748b;font-weight:600">${pct}%</span></div>`;
      return `<tr><td style="font-weight:700">${_esc(p.name)}</td><td class="mono" style="font-size:12px">${_esc(p.ranges||'–')}</td>
        <td style="font-size:12px">${p.totalIPs||0} / ${p.usedCount||0}</td><td style="min-width:120px">${bar}</td>
        <td style="font-size:12px">${_esc(p.nextPool||'none')}</td>
        <td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="delPool('${p.id}','${_esc(p.name)}')">Hapus</button></td></tr>`;
    }).join('')+'</tbody></table>';
}
async function delPool(id,name){ if(!await confirmAction({type:'danger',title:'Hapus IP Pool',message:`Hapus pool "${name}"? Pastikan tidak dipakai server/profil aktif.`,okText:'Ya, hapus'}))return;
  const d=await App.api('/mikrotik/ippool/'+id+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadPools(); }

// Pool manual
function openPoolModal(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  openModal(`<h3>Tambah IP Pool</h3><p>Buat pool manual (seperti /ip/pool di MikroTik).</p>
    <div class="fg" style="margin-bottom:11px"><label>Nama Pool *</label><input id="pl_name" placeholder="hs-pool-1"></div>
    <div class="fg" style="margin-bottom:11px"><label>Ranges *</label><input class="mono" id="pl_ranges" placeholder="10.5.50.2-10.5.50.254"></div>
    <div class="fg" style="margin-bottom:11px"><label>Next Pool</label><input id="pl_next" placeholder="none (opsional)"></div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="pl_comment" placeholder="opsional"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="pl_save" onclick="savePool()">Simpan</button></div>`);
}
async function savePool(){ const name=_q('pl_name').value.trim(),ranges=_q('pl_ranges').value.trim();
  if(!name||!ranges){App.showToast('Nama & ranges wajib','warning');return;}
  const btn=_q('pl_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const d=await App.api('/mikrotik/ippool'+dev(),{method:'POST',body:JSON.stringify({device_id:_dev(),name,ranges,nextPool:_q('pl_next').value.trim(),comment:_q('pl_comment').value.trim()})});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadPools();} else {btn.disabled=false;btn.textContent='Simpan';}
}

// Pool dari interface (auto-suggest range dari IP terpasang)
async function openPoolFromIface(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  openModal(`<h3>Buat Pool dari Interface</h3><p>Pilih interface — range otomatis disarankan dari IP yang terpasang.</p>
    <div class="fg" style="margin-bottom:11px"><label>Interface *</label><select id="pf_iface" onchange="onPoolIfaceChange()"><option value="">— Memuat… —</option></select></div>
    <div id="pf_info" style="font-size:12px;color:#64748b;margin-bottom:11px;display:none;padding:9px 11px;background:var(--hb-blue-soft);border-radius:8px"></div>
    <div class="fg" style="margin-bottom:11px"><label>Nama Pool *</label><input id="pf_name" placeholder="hs-pool-ether15"></div>
    <div class="fg" style="margin-bottom:11px"><label>Ranges *</label><input class="mono" id="pf_ranges" placeholder="pilih interface dulu"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-blue" id="pf_save" onclick="savePoolFromIface()">Buat Pool</button></div>`);
  const d=await App.api(HS('/interfaces')+dev()); const sel=_q('pf_iface');
  if(d?.success&&d.data?.length) sel.innerHTML='<option value="">— Pilih interface —</option>'+d.data.map(i=>`<option value="${_esc(i.name)}">${_esc(i.name)}${i.running?'':' (down)'}</option>`).join('');
  else sel.innerHTML='<option value="">— Gagal memuat —</option>';
}
async function onPoolIfaceChange(){ const iface=_q('pf_iface').value; const info=_q('pf_info');
  if(!iface){info.style.display='none';return;}
  info.style.display='block'; info.innerHTML='<span class="spinner dark"></span> Membaca IP interface…';
  const d=await App.api('/mikrotik/ippool/suggest?interface='+encodeURIComponent(iface)+dev('&'));
  if(!d?.success){info.innerHTML='Gagal membaca IP: '+_esc(d?.message);return;}
  const s=d.data;
  if(!s.found){ info.innerHTML=`⚠ Interface <strong>${_esc(iface)}</strong> belum punya IP address. Pasang IP dulu di MikroTik, atau isi range manual.`; _q('pf_ranges').value=''; return; }
  if(!s.suggestedRange){ info.innerHTML=`IP: <strong>${_esc(s.address)}</strong> · subnet terlalu kecil untuk pool. Isi range manual.`; _q('pf_ranges').value=''; }
  else { info.innerHTML=`IP interface: <strong>${_esc(s.address)}</strong><br>Gateway: ${_esc(s.gateway)} · Network: ${_esc(s.network)}<br>Saran range: <strong>${_esc(s.suggestedRange)}</strong>`; _q('pf_ranges').value=s.suggestedRange; }
  if(!_q('pf_name').value) _q('pf_name').value='hs-pool-'+iface;
}
async function savePoolFromIface(){ const name=_q('pf_name').value.trim(),ranges=_q('pf_ranges').value.trim();
  if(!name||!ranges){App.showToast('Nama & ranges wajib (pilih interface dengan IP)','warning');return;}
  const btn=_q('pf_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const d=await App.api('/mikrotik/ippool'+dev(),{method:'POST',body:JSON.stringify({device_id:_dev(),name,ranges,comment:'from-iface '+_q('pf_iface').value})});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadPools();} else {btn.disabled=false;btn.textContent='Buat Pool';}
}

// ════════ TAB: SERVER PROFILES ════════
async function loadSProfiles(){ if(!_dev()){_q('sprofilesWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('sprofilesWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/profiles')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  _sprofCache=d.data||[];
  if(!_sprofCache.length){wrap.innerHTML='<div class="empty">Belum ada server profile.</div>';return;}
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Nama</th><th>DNS Name</th><th>HTML Dir</th><th>Login By</th><th>Cookie Lifetime</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    _sprofCache.map((p,i)=>`<tr>
      <td data-l="Nama" style="font-weight:700">${_esc(p.name)}</td>
      <td data-l="DNS Name" style="font-size:12px">${_esc(p.dnsName||'–')}</td>
      <td data-l="HTML Dir" style="font-size:12px">${_esc(p.htmlDirectory||'–')}</td>
      <td data-l="Login By" style="font-size:11.5px;color:#64748b">${_esc(p.loginBy||'–')}</td>
      <td data-l="Cookie" style="font-size:12px">${_esc(p.httpCookieLifetime||'–')}</td>
      <td class="ta-r" data-l=""><div class="row-actions">
        <button class="btn btn-blue btn-sm" onclick="openSProfileModal(${i})">Edit</button>
        ${p.name==='default'?'':`<button class="btn btn-danger btn-sm" onclick="delSProfile('${p.id}','${_esc(p.name)}')">Hapus</button>`}
      </div></td></tr>`).join('')+'</tbody></table>';
}

function _loginByChecked(loginBy,key){ return (loginBy||'').split(',').map(s=>s.trim()).includes(key)?'checked':''; }

// idx = index ke _sprofCache untuk edit; undefined/null = tambah baru
function openSProfileModal(idx){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  const p=(typeof idx==='number' && _sprofCache[idx]) ? _sprofCache[idx] : {};
  const isEdit=!!(p&&p.id);
  const lb=p.loginBy||'cookie,http-chap';
  openModal(`<h3>${isEdit?'Edit':'Tambah'} Server Profile</h3><p>Profil server hotspot (login page, DNS, metode login) — sesuai Winbox.</p>
    <div class="fg" style="margin-bottom:11px"><label>Name *</label><input id="sp_name" value="${_esc(p.name||'')}" placeholder="hsprof1" ${isEdit?'':''}></div>
    <div class="fg" style="margin-bottom:11px"><label>Hotspot Address</label><input class="mono" id="sp_addr" value="${_esc(p.hotspotAddress||'')}" placeholder="opsional"></div>
    <div class="fg" style="margin-bottom:11px"><label>DNS Name (login page)</label><input id="sp_dns" value="${_esc(p.dnsName||'')}" placeholder="mis. hotspot.flaynet.id"></div>
    <div class="fg" style="margin-bottom:11px"><label>HTML Directory</label><input id="sp_html" value="${_esc(p.htmlDirectory||'hotspot')}" placeholder="hotspot"></div>
    <div class="fg" style="margin-bottom:8px"><label>Login By</label>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:4px;font-size:12.5px;">
        <label class="sp-chk"><input type="checkbox" id="lb_mac" ${_loginByChecked(lb,'mac')}> MAC</label>
        <label class="sp-chk"><input type="checkbox" id="lb_cookie" ${_loginByChecked(lb,'cookie')}> Cookie</label>
        <label class="sp-chk"><input type="checkbox" id="lb_chap" ${_loginByChecked(lb,'http-chap')}> HTTP CHAP</label>
        <label class="sp-chk"><input type="checkbox" id="lb_pap" ${_loginByChecked(lb,'http-pap')}> HTTP PAP</label>
        <label class="sp-chk"><input type="checkbox" id="lb_https" ${_loginByChecked(lb,'https')}> HTTPS</label>
        <label class="sp-chk"><input type="checkbox" id="lb_trial" ${_loginByChecked(lb,'trial')}> Trial</label>
      </div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>HTTP Cookie Lifetime</label><input class="mono" id="sp_cookie" value="${_esc(p.httpCookieLifetime||'3d 00:00:00')}" placeholder="3d 00:00:00"></div>
    <input type="hidden" id="sp_id" value="${_esc(p.id||'')}">
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="sp_save" onclick="saveSProfile()">${isEdit?'Update':'Simpan'}</button></div>`);
}

async function saveSProfile(){ const name=_q('sp_name').value.trim();
  if(!name){App.showToast('Nama profile wajib','warning');return;}
  // Susun login-by dari checkbox
  const lb=[];
  if(_q('lb_mac').checked)    lb.push('mac');
  if(_q('lb_cookie').checked) lb.push('cookie');
  if(_q('lb_chap').checked)   lb.push('http-chap');
  if(_q('lb_pap').checked)    lb.push('http-pap');
  if(_q('lb_https').checked)  lb.push('https');
  if(_q('lb_trial').checked)  lb.push('trial');
  if(!lb.length){App.showToast('Pilih minimal satu metode Login By','warning');return;}
  const id=_q('sp_id').value;
  const payload={device_id:_dev(),name,
    hotspotAddress:_q('sp_addr').value.trim(),
    dnsName:_q('sp_dns').value.trim(),
    htmlDirectory:_q('sp_html').value.trim()||'hotspot',
    loginBy:lb.join(','),
    httpCookieLifetime:_q('sp_cookie').value.trim()};
  const btn=_q('sp_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const d= id
    ? await App.api(HS('/profiles/'+id)+dev(),{method:'PATCH',body:JSON.stringify(payload)})
    : await App.api(HS('/profiles')+dev(),{method:'POST',body:JSON.stringify(payload)});
  App.showToast(d?.message||'OK',d?.success?'success':'error');
  if(d?.success){closeModal();loadSProfiles();} else {btn.disabled=false;btn.textContent=id?'Update':'Simpan';}
}

async function delSProfile(id,name){ if(!await confirmAction({type:'danger',title:'Hapus Server Profile',message:`Hapus server profile "${name}"? Pastikan tidak dipakai server hotspot aktif.`,okText:'Ya, hapus'}))return;
  const d=await App.api(HS('/profiles/'+id)+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadSProfiles(); }

// ════════ TAB: USER PROFILES ════════
async function loadProfiles(){ if(!_dev()){_q('profilesWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('profilesWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/user-profiles')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  _profilesCache=d.data||[];
  if(!_profilesCache.length){wrap.innerHTML='<div class="empty">Belum ada user profile.</div>';return;}
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>Nama</th><th>Rate Limit</th><th>Shared</th><th>Session TO</th><th style="text-align:right">Aksi</th></tr></thead><tbody>`+
    _profilesCache.map(p=>`<tr><td style="font-weight:700">${_esc(p.name)}</td><td class="mono">${_esc(p.rateLimit||'unlimited')}</td>
      <td>${_esc(p.sharedUsers)}</td><td class="mono" style="font-size:12px">${_esc(p.sessionTimeout||'–')}</td>
      <td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="delProfile('${p.id}','${_esc(p.name)}')">Hapus</button></td></tr>`).join('')+'</tbody></table>';
}
async function delProfile(id,name){ if(!await confirmAction({type:'danger',title:'Hapus User Profile',message:`Hapus profile "${name}"?`,okText:'Ya, hapus'}))return; const d=await App.api(HS('/user-profiles/'+id)+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadProfiles(); }
function openProfileModal(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  openModal(`<h3>Tambah User Profile</h3><p>Paket bandwidth untuk hotspot user.</p>
    <div class="fg" style="margin-bottom:11px"><label>Nama *</label><input id="p_name" placeholder="2Mbps"></div>
    <div class="fg" style="margin-bottom:11px"><label>Rate Limit (rx/tx)</label><input class="mono" id="p_rate" placeholder="2M/2M"></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Shared Users</label><input type="number" id="p_shared" value="1" min="1"></div>
      <div class="fg"><label>Session Timeout</label><input class="mono" id="p_session" placeholder="kosong=unlimited"></div></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="p_save" onclick="saveProfile()">Simpan</button></div>`);
}
async function saveProfile(){ const name=_q('p_name').value.trim(); if(!name){App.showToast('Nama wajib','warning');return;}
  const btn=_q('p_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const d=await App.api(HS('/user-profiles')+dev(),{method:'POST',body:JSON.stringify({device_id:_dev(),name,rateLimit:_q('p_rate').value.trim(),sharedUsers:_q('p_shared').value,sessionTimeout:_q('p_session').value.trim()})});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadProfiles();} else {btn.disabled=false;btn.textContent='Simpan';}
}

// ════════ TAB: USERS ════════
let _usersCache=[], _usersSel=new Set(), _usersSearch='';
async function loadUsers(){ if(!_dev()){_q('usersWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('usersWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/users')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  _usersCache=d.data||[]; _usersSel.clear();
  if(!_profilesCache.length){ try{ const pd=await App.api(HS('/user-profiles')+dev()); _profilesCache=pd?.data||[]; }catch(_){} }
  renderUsers();
}
function _fmtBytesU(n){ n=+n||0; if(!n)return '–'; if(n>=1e9)return (n/1073741824).toFixed(1)+'G'; if(n>=1e6)return (n/1048576).toFixed(0)+'M'; if(n>=1e3)return (n/1024).toFixed(0)+'K'; return n+'B'; }
function _usersReRender(){ const el=_q('usersSearch'); const pos=el?el.selectionStart:null; renderUsers(); const e2=_q('usersSearch'); if(e2){e2.focus(); if(pos!=null){try{e2.setSelectionRange(pos,pos);}catch(_){}}} }
function renderUsers(){
  const wrap=_q('usersWrap'); if(!wrap) return;
  if(!_usersCache.length){wrap.innerHTML='<div class="empty">Belum ada hotspot user.</div>';return;}
  const t=(_usersSearch||'').toLowerCase().trim();
  let list=_usersCache;
  if(t) list=list.filter(u=>`${u.name} ${u.profile} ${u.server} ${u.address} ${u.macAddress} ${u.comment}`.toLowerCase().includes(t));

  const bar=`<div class="hb-tblbar">
    <div class="hb-search"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
      <input id="usersSearch" placeholder="Cari username / profile / MAC…" value="${_esc(_usersSearch)}" oninput="_usersSearch=this.value;_usersReRender()"></div>
    <button class="btn btn-ghost btn-sm" onclick="exportUsersCsv()" title="Export CSV"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg> Export CSV</button>
    <span style="font-size:12px;color:#94a3b8">${list.length} dari ${_usersCache.length}</span>
  </div>`;
  const bulkBar=`<div class="bulk-bar${_usersSel.size?' show':''}" id="usersBulkBar">
    <span id="usersSelCount">${_usersSel.size} dipilih</span><span class="sp"></span>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="bulkUserToggle(false)">Enable</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="bulkUserToggle(true)">Disable</button>
    <button class="btn btn-danger btn-sm" onclick="bulkUserDelete()">Hapus</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="usersSelClear()">Batal</button>
  </div>`;
  if(!list.length){ wrap.innerHTML=bar+'<div class="empty">Tidak ada user yang cocok.</div>'; return; }
  const allChecked=list.length && list.every(u=>_usersSel.has(u.id))?'checked':'';
  wrap.innerHTML=bar+bulkBar+`<table class="hb-tbl"><thead><tr>
    <th style="width:36px"><input type="checkbox" class="row-chk" ${allChecked} onchange="usersSelAll(this.checked)"></th>
    <th>Username</th><th>Profile</th><th>Server</th><th>Uptime</th><th>Limit (Up/In/Out)</th><th>Pemakaian</th><th>Status</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    list.map((u,i)=>{
      const checked=_usersSel.has(u.id)?'checked':'';
      const lim=`${u.limitUptime||'–'} / ${_fmtBytesU(u.limitBytesIn)} / ${_fmtBytesU(u.limitBytesOut)}`;
      const usage=`↓${_fmtBytesU(u.bytesIn)} ↑${_fmtBytesU(u.bytesOut)}`;
      return `<tr>
      <td style="width:36px"><input type="checkbox" class="row-chk" ${checked} onchange="usersSelToggle('${u.id}',this.checked)"></td>
      <td data-l="Username" style="font-weight:700">${_esc(u.name)}</td>
      <td data-l="Profile">${_esc(u.profile)}</td>
      <td data-l="Server" style="font-size:12px">${_esc(u.server||'all')}</td>
      <td data-l="Uptime" class="mono" style="font-size:12px">${_esc(u.uptime)}</td>
      <td data-l="Limit" class="mono" style="font-size:11px;color:#64748b">${_esc(lim)}</td>
      <td data-l="Pemakaian" class="mono" style="font-size:11.5px">${usage}</td>
      <td data-l="Status">${u.disabled?'<span class="badge red">disabled</span>':'<span class="badge green">enabled</span>'}</td>
      <td class="ta-r" data-l=""><div class="row-actions">
        <button class="btn btn-blue btn-sm" onclick="openUserEdit(${i})">Edit</button>
        ${u.disabled?`<button class="btn btn-green btn-sm" onclick="toggleUser('${u.id}',false)">Enable</button>`:`<button class="btn btn-ghost btn-sm" onclick="toggleUser('${u.id}',true)">Disable</button>`}
        <button class="btn btn-danger btn-sm" onclick="delUser('${u.id}','${_esc(u.name)}')">Hapus</button></div></td></tr>`;
    }).join('')+'</tbody></table>';
}
function usersSelToggle(id,on){ if(on)_usersSel.add(id); else _usersSel.delete(id); const bar=_q('usersBulkBar'),c=_q('usersSelCount'); if(bar)bar.classList.toggle('show',_usersSel.size>0); if(c)c.textContent=`${_usersSel.size} dipilih`; }
function usersSelAll(on){ const t=(_usersSearch||'').toLowerCase().trim(); const vis=_usersCache.filter(u=>!t||`${u.name} ${u.profile} ${u.server} ${u.address} ${u.macAddress}`.toLowerCase().includes(t)); if(on)vis.forEach(u=>_usersSel.add(u.id)); else vis.forEach(u=>_usersSel.delete(u.id)); renderUsers(); }
function usersSelClear(){ _usersSel.clear(); renderUsers(); }
async function bulkUserToggle(disable){ if(!_usersSel.size)return;
  if(!await confirmAction({type:disable?'warn':'success',title:(disable?'Disable':'Enable')+' Massal',message:`${disable?'Nonaktifkan':'Aktifkan'} ${_usersSel.size} user terpilih?`,okText:'Ya, lanjut'}))return;
  let ok=0; for(const id of [..._usersSel]){ const d=await App.api(HS(`/users/${id}/${disable?'disable':'enable'}`)+dev(),{method:'POST',body:'{}'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_usersSel.size} user di-${disable?'disable':'enable'}`,'success'); _usersSel.clear(); loadUsers(); }
async function bulkUserDelete(){ if(!_usersSel.size)return;
  if(!await confirmAction({type:'danger',title:'Hapus Massal',message:`Hapus ${_usersSel.size} user terpilih? Tidak bisa dibatalkan.`,okText:'Ya, hapus semua'}))return;
  let ok=0; for(const id of [..._usersSel]){ const d=await App.api(HS('/users/'+id)+dev(),{method:'DELETE'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_usersSel.size} user dihapus`,'success'); _usersSel.clear(); loadUsers(); }
async function toggleUser(id,disable){ const d=await App.api(HS(`/users/${id}/${disable?'disable':'enable'}`)+dev(),{method:'POST',body:'{}'}); App.showToast(d?.success?'OK':'Gagal',d?.success?'success':'error'); if(d?.success)loadUsers(); }
async function delUser(id,name){ if(!await confirmAction({type:'danger',title:'Hapus User Hotspot',message:`Hapus user "${name}"?`,okText:'Ya, hapus'}))return; const d=await App.api(HS('/users/'+id)+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadUsers(); }
// (2) Edit user — ubah profile/password/server/address/mac/limits
function openUserEdit(idx){ const u=_usersCache[idx]; if(!u){App.showToast('User tidak ditemukan, muat ulang','warning');return;}
  const profOpts=['default',..._profilesCache.map(p=>p.name)].filter((v,i,a)=>a.indexOf(v)===i).map(n=>`<option value="${_esc(n)}"${n===u.profile?' selected':''}>${_esc(n)}</option>`).join('');
  const toSize=n=>{ n=+n||0; if(!n)return ''; if(n>=1073741824)return (n/1073741824)+'G'; if(n>=1048576)return (n/1048576)+'M'; if(n>=1024)return (n/1024)+'k'; return String(n); };
  openModal(`<h3>Edit Hotspot User</h3><p>Ubah <strong>${_esc(u.name)}</strong> (paritas Winbox).</p>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Server</label><select id="ue_server"><option value="all">all</option></select></div>
      <div class="fg"><label>Profile</label><select id="ue_profile">${profOpts}</select></div></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Username (Name)</label><input id="ue_name" value="${_esc(u.name)}"></div>
      <div class="fg"><label>Password</label><input id="ue_pass" value="${_esc(u.password||'')}" placeholder="kosongkan = tetap"></div></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Address (IP)</label><input class="mono" id="ue_addr" value="${_esc(u.address||'')}"></div>
      <div class="fg"><label>MAC Address</label><input class="mono" id="ue_mac" value="${_esc(u.macAddress||'')}" style="text-transform:uppercase"></div></div>
    <div style="font-size:11px;font-weight:800;color:var(--hb-muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;border-top:1px solid var(--hb-border);padding-top:12px">Limits</div>
    <div class="fg" style="margin-bottom:11px"><label>Limit Uptime</label><input class="mono" id="ue_uptime" value="${_esc(u.limitUptime||'')}" placeholder="mis. 1d 00:00:00"></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Limit Bytes In</label><input class="mono" id="ue_bin" value="${toSize(u.limitBytesIn)}" placeholder="mis. 1G"></div>
      <div class="fg"><label>Limit Bytes Out</label><input class="mono" id="ue_bout" value="${toSize(u.limitBytesOut)}" placeholder="mis. 1G"></div></div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="ue_comment" value="${_esc(u.comment||'')}"></div>
    <input type="hidden" id="ue_id" value="${_esc(u.id)}">
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="ue_save" onclick="saveUserEdit()">Update</button></div>`);
  App.api(HS('/servers')+dev()).then(d=>{ const sel=_q('ue_server'); if(!sel)return; let opts='<option value="all">all</option>'; if(d?.success&&Array.isArray(d.data))opts+=d.data.map(s=>`<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join(''); sel.innerHTML=opts; if(u.server&&[...sel.options].some(o=>o.value===u.server))sel.value=u.server; }).catch(()=>{});
}
async function saveUserEdit(){ const id=_q('ue_id').value; if(!id)return;
  const btn=_q('ue_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const payload={device_id:_dev(),
    name:_q('ue_name').value.trim(),
    profile:_q('ue_profile').value,
    server:_q('ue_server').value,
    address:_q('ue_addr').value.trim(),
    macAddress:_q('ue_mac').value.trim().toUpperCase(),
    limitUptime:_q('ue_uptime').value.trim(),
    limitBytesIn:_parseSize(_q('ue_bin').value),
    limitBytesOut:_parseSize(_q('ue_bout').value),
    comment:_q('ue_comment').value.trim()};
  const pass=_q('ue_pass').value; if(pass) payload.password=pass;   // kosong = tidak diubah
  const d=await App.api(HS('/users/'+id)+dev(),{method:'PUT',body:JSON.stringify(payload)});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadUsers();} else {btn.disabled=false;btn.textContent='Update';}
}
async function openUserModal(){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  // muat profiles untuk dropdown
  if(!_profilesCache.length){ const pd=await App.api(HS('/user-profiles')+dev()); _profilesCache=pd?.data||[]; }
  const profOpts=['default',..._profilesCache.map(p=>p.name)].filter((v,i,a)=>a.indexOf(v)===i).map(n=>`<option value="${_esc(n)}">${_esc(n)}</option>`).join('');
  openModal(`<h3>Tambah Hotspot User</h3><p>User permanen / voucher manual (sesuai New Hotspot User di Winbox).</p>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Server</label><select id="u_server"><option value="all">all</option></select></div>
      <div class="fg"><label>Profile</label><select id="u_profile">${profOpts}</select></div></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Username (Name) *</label><input id="u_name" placeholder="user1"></div>
      <div class="fg"><label>Password</label><input id="u_pass" placeholder="opsional"></div></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Address (IP)</label><input class="mono" id="u_addr" placeholder="opsional"></div>
      <div class="fg"><label>MAC Address</label><input class="mono" id="u_mac" placeholder="opsional" style="text-transform:uppercase"></div></div>

    <div style="font-size:11px;font-weight:800;color:var(--hb-muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;border-top:1px solid var(--hb-border);padding-top:12px">Limits (opsional)</div>
    <div class="fg" style="margin-bottom:11px"><label>Limit Uptime</label><input class="mono" id="u_uptime" placeholder="mis. 1d 00:00:00 atau 8h"></div>
    <div class="grid2" style="margin-bottom:11px"><div class="fg"><label>Limit Bytes In</label><input class="mono" id="u_bin" placeholder="mis. 1G / 500M"></div>
      <div class="fg"><label>Limit Bytes Out</label><input class="mono" id="u_bout" placeholder="mis. 1G / 500M"></div></div>

    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="u_comment" placeholder="opsional"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="u_save" onclick="saveUser()">Simpan</button></div>`);
  // Isi dropdown server dari hotspot server (default 'all')
  App.api(HS('/servers')+dev()).then(d=>{
    const sel=_q('u_server'); if(!sel)return;
    let opts='<option value="all">all</option>';
    if(d?.success && Array.isArray(d.data)) opts+=d.data.map(s=>`<option value="${_esc(s.name)}">${_esc(s.name)}</option>`).join('');
    sel.innerHTML=opts;
  }).catch(()=>{});
}
// Konversi input ukuran (1G/500M/100k) → bytes. Kalau angka murni, dianggap bytes.
function _parseSize(s){ if(!s)return ''; s=String(s).trim(); if(!s)return '';
  const m=s.match(/^([\d.]+)\s*([kmgt]?)i?b?$/i); if(!m) return s; // biarkan apa adanya kalau format aneh
  let v=parseFloat(m[1])||0; const u=(m[2]||'').toLowerCase();
  const mul={'':1,k:1024,m:1048576,g:1073741824,t:1099511627776}[u]||1;
  return String(Math.round(v*mul)); }
async function saveUser(){ const name=_q('u_name').value.trim(); if(!name){App.showToast('Username wajib','warning');return;}
  const btn=_q('u_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const payload={device_id:_dev(),name,
    password:_q('u_pass').value,
    profile:_q('u_profile').value,
    server:_q('u_server').value,
    address:_q('u_addr').value.trim(),
    macAddress:_q('u_mac').value.trim().toUpperCase(),
    limitUptime:_q('u_uptime').value.trim(),
    limitBytesIn:_parseSize(_q('u_bin').value),
    limitBytesOut:_parseSize(_q('u_bout').value),
    comment:_q('u_comment').value.trim()};
  const d=await App.api(HS('/users')+dev(),{method:'POST',body:JSON.stringify(payload)});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadUsers();} else {btn.disabled=false;btn.textContent='Simpan';}
}

// ════════ TAB: ACTIVE ════════
async function loadActive(){ if(!_dev()){_q('activeWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  const wrap=_q('activeWrap'); wrap.innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/active')+dev()); if(!d?.success){wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  const list=d.data||[];
  if(!list.length){wrap.innerHTML='<div class="empty">Tidak ada session aktif.</div>';return;}
  const fmtBytes=n=>{n=+n||0;if(n>1e9)return (n/1e9).toFixed(2)+'G';if(n>1e6)return (n/1e6).toFixed(1)+'M';if(n>1e3)return (n/1e3).toFixed(0)+'K';return n+'B';};
  wrap.innerHTML=`<table class="hb-tbl"><thead><tr><th>User</th><th>IP</th><th>MAC</th><th>Uptime</th><th>↓ / ↑</th><th style="text-align:right">Aksi</th></tr></thead><tbody>`+
    list.map(s=>`<tr><td style="font-weight:700">${_esc(s.user)}</td><td><span class="tag tag-ip">${_esc(s.address)}</span></td>
      <td><span class="tag tag-mac">${_esc(s.macAddress)}</span></td><td class="mono" style="font-size:12px">${_esc(s.uptime)}</td>
      <td class="mono" style="font-size:11.5px">${fmtBytes(s.bytesIn)} / ${fmtBytes(s.bytesOut)}</td>
      <td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="kickSession('${s.id}','${_esc(s.user)}')">Kick</button></td></tr>`).join('')+'</tbody></table>';
}
async function kickSession(id,user){ if(!await confirmAction({type:'warn',title:'Putuskan Session',message:`Putuskan session aktif "${user}"?`,okText:'Ya, putuskan'}))return; const d=await App.api(HS('/active/'+id+'/disconnect')+dev(),{method:'POST',body:'{}'}); App.showToast(d?.success?'Session diputus':'Gagal',d?.success?'success':'error'); if(d?.success)loadActive(); }

// ════════ TAB: HOSTS ════════
let _hostsCache=[];
let _hostSel=new Set();
let _hostRates={};   // key MAC|IP → {bytesIn,bytesOut,t} untuk hitung rate dari delta byte
let _hostsTimer=null;
const HOSTS_REFRESH_MS=5000;
async function loadHosts(silent){ const wrap=_q('hostsWrap');
  if(!_dev()){ wrap.innerHTML='<div class="empty">Pilih router dulu.</div>'; stopHostsAutoRefresh(); return; }
  if(!silent) wrap.innerHTML='<div class="empty"><span class="spinner dark"></span><div style="margin-top:9px">Memuat host…</div></div>';
  // Pastikan _custCache terisi untuk pencocokan nama pelanggan (kalau belum).
  if(!_custCache||!_custCache.length){
    try{ const c=await App.api('/tools/hotspot/customers'); if(c?.success) _custCache=c.data||[]; }catch(_){}
  }
  const d=await App.api(HS('/hosts')+dev());
  if(!d?.success){ if(!silent) wrap.innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`; return; }
  _hostsCache=d.data||[];
  // Hitung rate RX/TX dari DELTA byte antar-refresh (andal utk host bypassed
  // yang rx-rate/tx-rate-nya tidak dilaporkan MikroTik).
  const now=Date.now();
  _hostsCache.forEach(h=>{
    const key=(h.macAddress||'').toUpperCase()+'|'+(h.address||'');
    const inB=+h.bytesIn||0, outB=+h.bytesOut||0;
    const prev=_hostRates[key];
    if(prev && now>prev.t){
      const dt=(now-prev.t)/1000;                 // detik
      const dIn=inB-prev.bytesIn, dOut=outB-prev.bytesOut;
      // hanya hitung kalau byte naik (hindari nilai negatif saat counter reset)
      h.rxBps = dIn>0 ? (dIn*8)/dt : 0;
      h.txBps = dOut>0 ? (dOut*8)/dt : 0;
    } else {
      h.rxBps = 0; h.txBps = 0;                    // refresh pertama: belum ada baseline
    }
    _hostRates[key]={bytesIn:inB,bytesOut:outB,t:now};
  });
  renderHosts();
  startHostsAutoRefresh();   // pastikan timer jalan saat tab Hosts aktif
}
// Auto-refresh traffic host (RX/TX real-time) tanpa klik Muat Ulang.
function startHostsAutoRefresh(){
  if(_hostsTimer) return;
  _hostsTimer=setInterval(()=>{
    // hanya refresh kalau tab Hosts aktif & tidak ada modal terbuka
    if(currentTab()!=='hosts'){ stopHostsAutoRefresh(); return; }
    if(_q('mdGeneric')?.classList.contains('show')) return;
    loadHosts(true);   // silent: tak ada spinner, tak ganggu pencarian
  }, HOSTS_REFRESH_MS);
}
function stopHostsAutoRefresh(){ if(_hostsTimer){ clearInterval(_hostsTimer); _hostsTimer=null; } }
function renderHosts(){ const wrap=_q('hostsWrap'); if(!wrap) return;
  const term=(_q('hostSearch')?.value||'').toLowerCase().trim();
  let list=_hostsCache;
  if(term) list=list.filter(h=>(h.macAddress+' '+h.address+' '+h.toAddress+' '+h.server+' '+h.comment).toLowerCase().includes(term));
  const tag=_q('hostFilterTag');
  if(tag){ if(term){ tag.style.display='inline-flex'; tag.innerHTML=`Hasil: ${list.length} host`; } else tag.style.display='none'; }
  if(!_hostsCache.length){ wrap.innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg><div>Belum ada perangkat terkoneksi ke hotspot.</div></div>'; return; }
  if(!list.length){ wrap.innerHTML='<div class="empty">Tidak ada host yang cocok dengan pencarian.</div>'; return; }
  // urut: authorized dulu, lalu by IP
  const ipNum=ip=>String(ip||'').split('.').reduce((a,o)=>a*256+(parseInt(o)||0),0);
  list=[...list].sort((a,b)=>(b.authorized?1:0)-(a.authorized?1:0) || ipNum(a.address)-ipNum(b.address));

  // (8) Agregat traffic semua host
  let aggRx=0,aggTx=0,aggIn=0,aggOut=0,actCount=0;
  list.forEach(h=>{ aggRx+=(+h.rxBps||0); aggTx+=(+h.txBps||0); aggIn+=(+h.bytesIn||0); aggOut+=(+h.bytesOut||0); if(h.authorized||h.bypassed)actCount++; });
  // skala bar relatif terhadap host dgn rate tertinggi
  const maxRate=Math.max(1,...list.map(h=>Math.max(+h.rxBps||0,+h.txBps||0)));
  const summary=`<div class="host-summary">
    <span class="hs-item" style="font-family:'DM Sans';font-weight:700;color:var(--hb-text)">${list.length} host · ${actCount} aktif</span>
    <span class="hs-sep"></span>
    <span class="hs-item"><span class="hs-dot" style="background:#2563eb"></span><span style="color:#64748b">Total RX</span> <strong style="color:#2563eb">${fmtBps(aggRx)}</strong></span>
    <span class="hs-item"><span class="hs-dot" style="background:#059669"></span><span style="color:#64748b">Total TX</span> <strong style="color:#059669">${fmtBps(aggTx)}</strong></span>
    <span class="hs-sep"></span>
    <span class="hs-item" style="color:#94a3b8">Total data: ↓${fmtBytes(aggIn)} ↑${fmtBytes(aggOut)}</span>
  </div>`;

  const hostBulkBar=`<div class="bulk-bar${_hostSel.size?' show':''}" id="hostBulkBar">
    <span id="hostSelCount">${_hostSel.size} dipilih</span><span class="sp"></span>
    <button class="btn btn-danger btn-sm" onclick="bulkHostDelete()">Hapus</button>
    <button class="btn btn-ghost btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="hostSelClear()">Batal</button>
  </div>`;
  const allChecked=list.length && list.every(h=>_hostSel.has(h.id))?'checked':'';
  wrap.innerHTML=summary+hostBulkBar+`<table class="hb-tbl"><thead><tr><th style="width:36px"><input type="checkbox" class="row-chk" ${allChecked} onchange="hostSelAll(this.checked)"></th><th>MAC Address</th><th>Address</th><th>To Address</th><th>Server</th><th>Pelanggan</th><th>Idle</th><th>Rx / Tx (rate · total)</th><th>Status</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    list.map(h=>{
      const badges=[];
      if(h.authorized) badges.push('<span class="badge green">authorized</span>');
      if(h.bypassed)   badges.push('<span class="badge blue">bypassed</span>');
      if(!h.authorized && !h.bypassed) badges.push('<span class="badge gray">guest</span>');
      const macJs=_esc((h.macAddress||'').replace(/'/g,''));
      const ipJs=_esc((h.address||'').replace(/'/g,''));
      const hasMac=!!h.macAddress;
      const _hMac=(h.macAddress||'').toUpperCase(), _hIp=(h.address||'').trim();
      const hCust=(_custCache||[]).find(c=>
        (_hMac && (c.mac_address||'').toUpperCase()===_hMac) ||
        (_hIp && (c.static_ip||'').trim()===_hIp));
      const hCustCell = hCust
        ? `<div style="line-height:1.3"><span style="font-weight:700;color:var(--hb-text)">${_esc(hCust.name)}</span><br><span style="font-size:11px;color:#94a3b8">${_esc(hCust.customer_id||'')}</span></div>`
        : `<span style="font-size:12px;color:#cbd5e1">belum terdaftar</span>`;
      const btns=[];
      if(hasMac && !hCust) btns.push(`<button class="btn btn-green btn-sm" onclick="openBindCust('${macJs}','${ipJs}','host')" title="Jadikan pelanggan tipe Hotspot">Bind ke Customer</button>`);
      btns.push(`<button class="btn btn-blue btn-sm" onclick="makeHostBinding('${h.id}','${macJs}')" title="Buat IP binding bypassed di MikroTik">Make Binding</button>`);
      btns.push(`<button class="btn btn-danger btn-sm" onclick="delHost('${h.id}','${macJs}')">Hapus</button>`);
      const act = `<div class="row-actions">${btns.join('')}</div>`;
      // (8) Sel Rx/Tx: rate sekarang + mini-bar + total byte
      const rxB=+h.rxBps||0, txB=+h.txBps||0;
      const rxPct=Math.round(rxB/maxRate*100), txPct=Math.round(txB/maxRate*100);
      const trafCell=`<div style="font-size:11px;line-height:1.5">
        <div style="display:flex;align-items:center;gap:5px"><span style="color:#2563eb;font-weight:700;min-width:70px">↓ ${fmtBps(rxB)}</span><span style="flex:1;height:4px;background:#eef2f9;border-radius:2px;overflow:hidden;min-width:40px"><span style="display:block;height:100%;width:${rxPct}%;background:#2563eb"></span></span></div>
        <div style="display:flex;align-items:center;gap:5px"><span style="color:#059669;font-weight:700;min-width:70px">↑ ${fmtBps(txB)}</span><span style="flex:1;height:4px;background:#eef2f9;border-radius:2px;overflow:hidden;min-width:40px"><span style="display:block;height:100%;width:${txPct}%;background:#059669"></span></span></div>
        <div style="color:#94a3b8;margin-top:2px">total ↓${fmtBytes(h.bytesIn)} ↑${fmtBytes(h.bytesOut)}</div>
      </div>`;
      return `<tr>
        <td style="width:36px"><input type="checkbox" class="row-chk" ${_hostSel.has(h.id)?'checked':''} onchange="hostSelToggle('${h.id}',this.checked)"></td>
        <td data-l="MAC Address"><span class="tag tag-mac">${_esc(h.macAddress||'–')}</span></td>
        <td data-l="Address"><span class="tag tag-ip">${_esc(h.address||'–')}</span></td>
        <td data-l="To Address" class="mono" style="font-size:12px;color:#64748b">${_esc(h.toAddress||'–')}</td>
        <td data-l="Server" style="font-size:12px">${_esc(h.server||'–')}</td>
        <td data-l="Pelanggan">${hCustCell}</td>
        <td data-l="Idle" class="mono" style="font-size:12px;color:#64748b">${_esc(h.idleTime||'–')}</td>
        <td data-l="Rx / Tx" style="min-width:170px">${trafCell}</td>
        <td data-l="Status">${badges.join(' ')}</td>
        <td class="ta-r" data-l="">${act}</td></tr>`;
    }).join('')+'</tbody></table>';
}
function hostSelToggle(id,on){ if(on)_hostSel.add(id); else _hostSel.delete(id); const bar=_q('hostBulkBar'),c=_q('hostSelCount'); if(bar)bar.classList.toggle('show',_hostSel.size>0); if(c)c.textContent=`${_hostSel.size} dipilih`; }
function hostSelAll(on){ const term=(_q('hostSearch')?.value||'').toLowerCase().trim(); const vis=_hostsCache.filter(h=>!term||(h.macAddress+' '+h.address+' '+h.toAddress+' '+h.server+' '+h.comment).toLowerCase().includes(term)); if(on)vis.forEach(h=>_hostSel.add(h.id)); else vis.forEach(h=>_hostSel.delete(h.id)); renderHosts(); }
function hostSelClear(){ _hostSel.clear(); renderHosts(); }
async function bulkHostDelete(){ if(!_hostSel.size)return;
  if(!await confirmAction({type:'danger',title:'Hapus Host Massal',message:`Hapus ${_hostSel.size} host terpilih dari tabel hotspot?`,okText:'Ya, hapus semua'}))return;
  let ok=0; for(const id of [..._hostSel]){ const d=await App.api(HS('/hosts/'+id)+dev(),{method:'DELETE'}); if(d?.success)ok++; }
  App.showToast(`${ok}/${_hostSel.size} host dihapus`,'success'); _hostSel.clear(); loadHosts(); }
async function makeHostBinding(id,mac){ if(!await confirmAction({type:'info',title:'Make Binding',message:`Jadikan ${mac||'host ini'} sebagai IP binding (bypassed) di MikroTik?`,okText:'Ya, buat binding'}))return;
  const d=await App.api(HS('/hosts/'+id+'/make-binding')+dev(),{method:'POST',body:'{}'});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){loadHosts();} }
async function delHost(id,mac){ if(!await confirmAction({type:'danger',title:'Hapus Host',message:`Hapus host ${mac||''} dari tabel hotspot?`,okText:'Ya, hapus'}))return;
  const d=await App.api(HS('/hosts/'+id)+dev(),{method:'DELETE'});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadHosts(); }

// ════════ TAB: WALLED GARDEN ════════
let _walledHostCache=[], _walledIpCache=[];
async function loadWalled(){ if(!_dev()){_q('walledHostWrap').innerHTML='<div class="empty">Pilih router dulu.</div>';return;}
  _q('walledHostWrap').innerHTML='<div class="empty">Memuat…</div>'; _q('walledIpWrap').innerHTML='<div class="empty">Memuat…</div>';
  const d=await App.api(HS('/walled-garden')+dev());
  if(!d?.success){_q('walledHostWrap').innerHTML=`<div class="empty">Gagal: ${_esc(d?.message)}</div>`;return;}
  _walledHostCache=d.data?.host||[]; _walledIpCache=d.data?.ip||[];
  const host=_walledHostCache, ip=_walledIpCache;
  _q('walledHostWrap').innerHTML = host.length ? `<table class="hb-tbl"><thead><tr><th>Action</th><th>Dst Host</th><th>Dst Port</th><th>Hits</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    host.map(w=>`<tr><td data-l="Action"><span class="badge ${w.action==='allow'?'green':'red'}">${_esc(w.action)}</span></td>
      <td data-l="Dst Host" class="mono" style="font-size:12px">${_esc(w.dstHost||'–')}</td>
      <td data-l="Dst Port">${_esc(w.dstPort||'–')}</td><td data-l="Hits">${w.hits}</td>
      <td class="ta-r" data-l=""><div class="row-actions"><button class="btn btn-blue btn-sm" onclick="openWalledModal('host','${w.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="delWalled('host','${w.id}')">Hapus</button></div></td></tr>`).join('')+'</tbody></table>'
    : '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9h18M9 21V9M3 5h18v16H3z"/></svg><div>Belum ada entry host/domain.</div></div>';
  _q('walledIpWrap').innerHTML = ip.length ? `<table class="hb-tbl"><thead><tr><th>Action</th><th>Dst Address</th><th>Protocol</th><th>Port</th><th>Hits</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    ip.map(w=>`<tr><td data-l="Action"><span class="badge ${w.action==='accept'?'green':'red'}">${_esc(w.action)}</span></td>
      <td data-l="Dst Address" class="mono" style="font-size:12px">${_esc(w.dstAddress||'–')}</td>
      <td data-l="Protocol">${_esc(w.protocol||'–')}</td><td data-l="Port">${_esc(w.dstPort||'–')}</td><td data-l="Hits">${w.hits}</td>
      <td class="ta-r" data-l=""><div class="row-actions"><button class="btn btn-blue btn-sm" onclick="openWalledModal('ip','${w.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="delWalled('ip','${w.id}')">Hapus</button></div></td></tr>`).join('')+'</tbody></table>'
    : '<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9h18M9 21V9M3 5h18v16H3z"/></svg><div>Belum ada entry IP.</div></div>';
}
async function delWalled(kind,id){ if(!await confirmAction({type:'danger',title:'Hapus Entry',message:'Hapus entry walled garden ini?',okText:'Ya, hapus'}))return;
  const url = kind==='host' ? HS('/walled-garden/host/'+id) : HS('/walled-garden/ip/'+id);
  const d=await App.api(url+dev(),{method:'DELETE'}); App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadWalled(); }

// Modal create + edit (editId opsional). Kalau editId diisi → mode edit.
async function openWalledModal(kind, editId){ if(!_dev()){App.showToast('Pilih router dulu','warning');return;}
  const isEdit=!!editId;
  const e = isEdit ? (kind==='host'?_walledHostCache:_walledIpCache).find(x=>String(x.id)===String(editId)) : null;
  if(isEdit && !e){App.showToast('Entry tidak ditemukan, muat ulang dulu','warning');return;}
  const g=k=>e?_esc(e[k]||''):'';
  const sv=(v,cur)=>v===cur?'selected':'';
  const srv = e ? (e.server&&e.server!=='all'?e.server:'') : '';
  if(kind==='host'){
    const act=e?e.action:'allow';
    openModal(`<h3>${isEdit?'Edit':'Tambah'} Walled Garden — Host</h3><p>Host/domain yang boleh diakses tanpa login.</p>
    <div class="fg" style="margin-bottom:11px"><label>Action</label>
      <select id="w_action"><option value="allow" ${sv('allow',act)}>allow</option><option value="deny" ${sv('deny',act)}>deny</option></select></div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Server</label><select id="w_server"><option value="">all (semua server)</option></select></div>
      <div class="fg"><label>Method</label>
        <select id="w_method"><option value="">— any —</option>${['GET','HEAD','POST','PUT','DELETE','OPTIONS','TRACE','CONNECT'].map(m=>`<option ${sv(m,e?e.method:'')}>${m}</option>`).join('')}</select></div>
    </div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Src. Address</label><input class="mono" id="w_src" value="${g('srcAddress')}" placeholder="opsional"></div>
      <div class="fg"><label>Dst. Address</label><input class="mono" id="w_dst" value="${g('dstAddress')}" placeholder="opsional"></div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>Dst. Host *</label><input class="mono" id="w_host" value="${g('dstHost')}" placeholder="*.whatsapp.com"></div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Dst. Port</label><input id="w_port" value="${g('dstPort')}" placeholder="opsional"></div>
      <div class="fg"><label>Path</label><input class="mono" id="w_path" value="${g('path')}" placeholder="opsional"></div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="w_comment" value="${g('comment')}" placeholder="opsional"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="w_save" onclick="saveWalled('host','${isEdit?editId:''}')">${isEdit?'Update':'Simpan'}</button></div>`);
  } else {
    const act=e?e.action:'accept';
    openModal(`<h3>${isEdit?'Edit':'Tambah'} Walled Garden — IP</h3><p>IP/subnet yang boleh diakses tanpa login.</p>
    <div class="fg" style="margin-bottom:11px"><label>Action</label>
      <select id="w_action"><option value="accept" ${sv('accept',act)}>accept</option><option value="drop" ${sv('drop',act)}>drop</option><option value="reject" ${sv('reject',act)}>reject</option></select></div>
    <div class="fg" style="margin-bottom:11px"><label>Server</label><select id="w_server"><option value="">all (semua server)</option></select></div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Src. Address</label><input class="mono" id="w_src" value="${g('srcAddress')}" placeholder="opsional"></div>
      <div class="fg"><label>Dst. Address *</label><input class="mono" id="w_addr" value="${g('dstAddress')}" placeholder="10.20.20.11"></div>
    </div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Src. Address List</label><input id="w_srclist" value="${g('srcAddressList')}" placeholder="opsional"></div>
      <div class="fg"><label>Dst. Address List</label><input id="w_dstlist" value="${g('dstAddressList')}" placeholder="opsional"></div>
    </div>
    <div class="grid2" style="margin-bottom:11px">
      <div class="fg"><label>Protocol</label>
        <select id="w_proto"><option value="">— any —</option>${['tcp','udp','icmp','gre','ipsec-esp','ipsec-ah'].map(p=>`<option value="${p}" ${sv(p,e?e.protocol:'')}>${p}</option>`).join('')}</select></div>
      <div class="fg"><label>Dst. Port</label><input id="w_port" value="${g('dstPort')}" placeholder="opsional"></div>
    </div>
    <div class="fg" style="margin-bottom:11px"><label>Dst. Host</label><input class="mono" id="w_host" value="${g('dstHost')}" placeholder="opsional"></div>
    <div class="fg" style="margin-bottom:11px"><label>Comment</label><input id="w_comment" value="${g('comment')}" placeholder="opsional"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-primary" id="w_save" onclick="saveWalled('ip','${isEdit?editId:''}')">${isEdit?'Update':'Simpan'}</button></div>`);
  }
  // Isi dropdown server dari daftar hotspot server aktif (+ opsi all)
  await fillServerSelect('w_server', srv);
}
// Ambil daftar hotspot server lalu isi <select>. value kosong = all.
async function fillServerSelect(selId, current){
  const sel=_q(selId); if(!sel) return;
  let servers=_serversCache;
  if(!servers||!servers.length){ const d=await App.api(HS('/servers')+dev()); if(d?.success){_serversCache=d.data||[];servers=_serversCache;} }
  const opts=['<option value="">all (semua server)</option>']
    .concat((servers||[]).map(s=>`<option value="${_esc(s.name)}" ${s.name===current?'selected':''}>${_esc(s.name)}${s.disabled?' (off)':''}</option>`));
  // kalau server lama tidak ada lagi di daftar, tetap tampilkan supaya tidak hilang
  if(current && !(servers||[]).some(s=>s.name===current)) opts.push(`<option value="${_esc(current)}" selected>${_esc(current)} (tidak ditemukan)</option>`);
  sel.innerHTML=opts.join('');
}
async function saveWalled(kind, editId){ const btn=_q('w_save'); const isEdit=!!editId; const lbl=isEdit?'Update':'Simpan';
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const val=id=>{const e=_q(id);return e?e.value.trim():'';};
  const fail=m=>{App.showToast(m,'warning');btn.disabled=false;btn.textContent=lbl;};
  let url,body,method;
  if(kind==='host'){ const h=val('w_host'); if(!h)return fail('Dst. Host wajib');
    url= isEdit ? HS('/walled-garden/host/'+editId) : HS('/walled-garden');
    body={device_id:_dev(),action:val('w_action'),server:val('w_server'),srcAddress:val('w_src'),
      dstAddress:val('w_dst'),method:val('w_method'),dstHost:h,dstPort:val('w_port'),path:val('w_path'),comment:val('w_comment')}; }
  else { const a=val('w_addr'); if(!a)return fail('Dst. Address wajib');
    url= isEdit ? HS('/walled-garden/ip/'+editId) : HS('/walled-garden/ip');
    body={device_id:_dev(),action:val('w_action'),server:val('w_server'),srcAddress:val('w_src'),
      dstAddress:a,srcAddressList:val('w_srclist'),dstAddressList:val('w_dstlist'),
      protocol:val('w_proto').toLowerCase(),dstPort:val('w_port'),dstHost:val('w_host'),comment:val('w_comment')}; }
  method = isEdit ? 'PUT' : 'POST';
  const d=await App.api(url+dev(),{method,body:JSON.stringify(body)});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success){closeModal();loadWalled();} else {btn.disabled=false;btn.textContent=lbl;}
}

// ════════ TAB: IP SCAN ════════
async function loadInterfaces(){ const sel=_q('scanIface');
  if(!_dev()){sel.innerHTML='<option value="">— Pilih router dulu —</option>';return;}
  sel.innerHTML='<option value="">— Memuat… —</option>';
  // Router berganti → hasil scan lama sudah tidak relevan
  _scanResults=[]; _scanIface=''; const mt=_q('scanMeta'); if(mt)mt.style.display='none';
  const sw=_q('scanWrap'); if(sw)sw.innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.2-5.2m0 0A7.5 7.5 0 105.2 5.2a7.5 7.5 0 0010.6 10.6z"/></svg><div>Pilih interface lalu Start Scan.</div></div>';
  const d=await App.api('/tools/interfaces'+dev());
  if(!d?.success||!d.data?.length){sel.innerHTML='<option value="">— Gagal memuat —</option>';return;}
  sel.innerHTML=d.data.map(i=>`<option value="${_esc(i.name)}">${_esc(i.name)}${i.type?` · ${_esc(i.type)}`:''}${i.running?'':' (down)'}</option>`).join('');
}
// Ganti interface → reset hasil scan supaya tidak tercampur antar-interface
function onScanIfaceChange(){
  _scanResults=[]; _scanIface='';
  const mt=_q('scanMeta'); if(mt)mt.style.display='none';
  const sw=_q('scanWrap'); if(sw)sw.innerHTML='<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.2-5.2m0 0A7.5 7.5 0 105.2 5.2a7.5 7.5 0 0010.6 10.6z"/></svg><div>Klik Start untuk memindai interface ini.</div></div>';
}
async function runScan(){ const iface=_q('scanIface').value;
  if(!_dev()){App.showToast('Pilih router dulu','warning');return;} if(!iface){App.showToast('Pilih interface','warning');return;}
  const dur=parseInt(_q('scanDuration').value)||5;
  const btn=_q('scanBtn'); btn.disabled=true; btn.innerHTML=`<span class="spinner"></span> ${dur}s…`;
  // Animasi radar + progress bar selama scan berjalan
  _q('scanWrap').innerHTML=`
    <div class="scan-anim">
      <div class="radar">
        <span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
        <span class="sweep"></span><span class="dot"></span>
        <span class="blip b1"></span><span class="blip b2"></span><span class="blip b3"></span><span class="blip b4"></span>
      </div>
      <div class="scan-anim-txt">Memindai jaringan via <strong>${_esc(iface)}</strong>…</div>
      <div class="scan-prog"><span id="scanProgBar"></span></div>
      <div class="scan-anim-sub" id="scanProgTxt">0%</div>
    </div>`;
  // Progress bar berjalan sesuai durasi (estimasi)
  const t0=Date.now(); const totalMs=dur*1000;
  const pTimer=setInterval(()=>{ const p=Math.min(99,Math.round((Date.now()-t0)/totalMs*100));
    const bar=_q('scanProgBar'), txt=_q('scanProgTxt'); if(bar)bar.style.width=p+'%'; if(txt)txt.textContent=p+'%'; },120);
  const d=await App.api('/tools/ip-scan',{method:'POST',body:JSON.stringify({device_id:_dev(),interface:iface,address_range:_q('scanRange').value.trim(),duration:dur})});
  clearInterval(pTimer);
  const el=((Date.now()-t0)/1000).toFixed(1);
  btn.disabled=false; btn.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.2-5.2m0 0A7.5 7.5 0 105.2 5.2a7.5 7.5 0 0010.6 10.6z"/></svg>Start`;
  if(!d?.success){_q('scanWrap').innerHTML=`<div class="empty">Scan gagal: ${_esc(d?.message)}</div>`;return;}
  // Reset hasil kalau interface berubah dari scan sebelumnya
  if(_scanIface && _scanIface!==iface) _scanResults=[];
  _scanIface=iface;
  const incoming=dedupScan(d.data||[]);              // buang duplikat dari hasil mentah
  const before=_scanResults.length;
  _scanResults=mergeScan(_scanResults, incoming);    // gabung unik dgn hasil lama
  _scanResults=sortScan(_scanResults);
  const added=_scanResults.length-before;
  const withMac=_scanResults.filter(r=>r.macAddress).length;
  const meta=_q('scanMeta'); meta.style.display='flex';
  meta.innerHTML=`<span class="badge blue">${_scanResults.length} host unik</span> <span class="badge green">${withMac} dgn MAC</span>`+
    (added>0?` <span class="badge amber">+${added} baru</span>`:` <span style="color:#94a3b8">tidak ada perangkat baru</span>`)+
    ` <span>Interface: <strong>${_esc(iface)}</strong></span> <span>${el}s</span>`;
  renderScan();
}
// Kunci unik per host: pakai MAC kalau ada (perangkat bisa ganti IP),
// kalau tidak ada MAC pakai IP.
function scanKey(r){ const mac=(r.macAddress||'').toUpperCase().trim(); return mac ? 'M:'+mac : 'A:'+(r.address||'').trim(); }
// Buang duplikat dari satu batch hasil scan (RouterOS sering kirim host sama berkali-kali)
function dedupScan(list){
  const seen=new Map();
  for(const r of (list||[])){ const k=scanKey(r); if(!k.replace(/^[MA]:/,''))continue;
    const ex=seen.get(k);
    // Simpan entri paling lengkap (yang punya MAC/DNS menang)
    if(!ex || (!ex.macAddress&&r.macAddress) || (!ex.dns&&r.dns)) seen.set(k,{...ex,...r});
  }
  return [...seen.values()];
}
// Gabung hasil baru ke daftar lama tanpa duplikat; update info kalau host sudah ada,
// tambahkan kalau perangkat baru.
function mergeScan(oldList, incoming){
  const map=new Map(); (oldList||[]).forEach(r=>map.set(scanKey(r),r));
  for(const r of incoming){ const k=scanKey(r); const ex=map.get(k);
    if(ex) map.set(k,{...ex,...r, customer:r.customer||ex.customer}); // refresh
    else map.set(k,r);                                                 // perangkat baru
  }
  return [...map.values()];
}
// Urutkan: host yg punya MAC di paling atas, lalu IP ascending numerik
function sortScan(list){
  const ipNum=ip=>String(ip||'').split('.').reduce((a,o)=>a*256+(parseInt(o)||0),0);
  return [...list].sort((a,b)=>{
    const am=a.macAddress?1:0, bm=b.macAddress?1:0;
    if(am!==bm) return bm-am;            // yang ada MAC duluan
    return ipNum(a.address)-ipNum(b.address); // lalu IP naik
  });
}
function renderScan(){ const wrap=_q('scanWrap');
  if(!_scanResults.length){wrap.innerHTML='<div class="empty">Tidak ada host yang merespons.</div>';return;}
  const reg=_scanResults.filter(r=>r.customer).length;
  const wMac=_scanResults.filter(r=>r.macAddress).length;
  const head=`<div class="scan-summary">
    <span><strong>${_scanResults.length}</strong> host ditemukan</span>
    <span class="scan-sep"></span>
    <span><strong>${wMac}</strong> punya MAC</span>
    <span class="scan-sep"></span>
    <span><strong>${reg}</strong> sudah jadi pelanggan</span>
  </div>`;
  wrap.innerHTML=head+`<div class="scan-tblwrap"><table class="scan-tbl"><thead><tr><th>Address</th><th>MAC</th><th>Time</th><th>DNS</th><th>Pelanggan</th><th class="ta-r">Aksi</th></tr></thead><tbody>`+
    _scanResults.map((r,i)=>{ const c=r.customer;
      const cell=c
        ? `<span class="scan-cust ${c.isolir_status==='isolated'?'iso':'act'}">${_esc(c.name)}</span>`
        : '<span class="scan-muted">belum terdaftar</span>';
      const btn=c
        ? `<span class="scan-bound">✓ Ter-bind</span>`
        : `<button class="btn btn-green btn-sm" onclick="openBindCustByIdx(${i})">Bind</button>`;
      return `<tr><td data-l="Address"><span class="tag tag-ip">${_esc(r.address)}</span></td>
        <td data-l="MAC">${r.macAddress?`<span class="tag tag-mac">${_esc(r.macAddress)}</span>`:'<span class="scan-muted">–</span>'}</td>
        <td data-l="Time" class="mono" style="font-size:12px;color:#64748b">${_esc(r.time||'–')}</td>
        <td data-l="DNS" style="font-size:12px;color:#64748b">${_esc(r.dns||'–')}</td>
        <td data-l="Pelanggan">${cell}</td>
        <td class="ta-r" data-l="">${btn}</td></tr>`;
    }).join('')+'</tbody></table></div>';
}
// Bind ke pelanggan. Bisa dipanggil dari IP Scan (lewat index) atau dari mana
// saja dengan MAC/IP langsung (mis. tab Hosts).
function openBindCustByIdx(idx){ const r=_scanResults[idx]; if(!r)return; openBindCust(r.macAddress||'', r.address||'', 'scan'); }
async function openBindCust(mac, addr, origin){
  // origin: 'host' / 'scan' → binding belum tentu ada → tawarkan buat binding (default ON)
  //         'binding'      → binding sudah ada di router → tidak perlu buat lagi
  const offerBinding = (origin !== 'binding');
  const bindingRow = offerBinding ? `
    <label class="bc-chk" style="display:flex;align-items:center;gap:9px;margin-bottom:13px;padding:11px 13px;background:var(--hb-blue-soft);border:1px solid var(--hb-border);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;color:var(--hb-text);">
      <input type="checkbox" id="bc_mkbind" checked style="width:17px;height:17px;accent-color:var(--hb-blue);cursor:pointer;">
      Binding IP (Bypassed)
    </label>` : '';
  openModal(`<h3>Bind ke Pelanggan</h3><p>Set MAC/IP ini ke pelanggan sebagai tipe <strong>Hotspot</strong>.</p>
    <div class="fg" style="margin-bottom:11px"><label>MAC</label><input class="mono" id="bc_mac" readonly value="${_esc(mac||'')}" style="background:#f8fafc"></div>
    <div class="fg" style="margin-bottom:11px"><label>IP</label><input class="mono" id="bc_addr" readonly value="${_esc(addr||'')}" style="background:#f8fafc"></div>
    <div class="fg" style="margin-bottom:11px"><label>Pelanggan</label><select id="bc_cust"><option value="">— Memuat… —</option></select></div>
    ${bindingRow}
    <input type="hidden" id="bc_origin" value="${_esc(origin||'')}">
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button><button class="btn btn-green" id="bc_save" onclick="saveBindCust()">Bind</button></div>`);
  const d=await App.api('/customers?limit=1000'); const list=(d?.data?.customers||d?.data||[]);
  const sel=_q('bc_cust');
  sel.innerHTML = Array.isArray(list)&&list.length ? '<option value="">— Pilih pelanggan —</option>'+list.map(c=>`<option value="${c.id}">${_esc(c.name)} — ${_esc(c.customer_id||'')}</option>`).join('') : '<option value="">— Tidak ada pelanggan —</option>';
}
async function saveBindCust(){ const cid=_q('bc_cust').value; if(!cid){App.showToast('Pilih pelanggan','warning');return;}
  const btn=_q('bc_save'); btn.disabled=true; btn.innerHTML='<span class="spinner"></span>';
  const mac=_q('bc_mac').value, addr=_q('bc_addr').value, origin=_q('bc_origin')?.value||'';
  const mkbind=_q('bc_mkbind')?_q('bc_mkbind').checked:false;
  const custName=_q('bc_cust').selectedOptions[0]?.text.split(' — ')[0]||'Pelanggan';
  const d=await App.api('/tools/bind-customer',{method:'POST',body:JSON.stringify({device_id:_dev(),customer_id:cid,mac_address:mac,address:addr,create_binding:mkbind})});
  App.showToast(d?.message||'OK',d?.success?'success':'error');
  if(d?.success){ closeModal();
    if(origin==='scan'){ _scanResults=_scanResults.map(r=>(r.macAddress||'').toUpperCase()===mac.toUpperCase()?{...r,customer:{name:custName,isolir_status:'active'}}:r); renderScan(); }
    else { loadHosts(); loadCustomers(); if(_dev())loadBindings(true); }
  } else {btn.disabled=false;btn.textContent='Bind';}
}

// ════════════════════════════════════════════════════════════════════
//  TRAFFIC MONITOR (selalu tampil, auto-jalan) — interface hotspot saja
//  Mirip widget di /monitoring/hotspot: tanpa tombol Mulai, ada range
//  selector 1m/5m/10m/30m, ApexCharts realtime.
// ════════════════════════════════════════════════════════════════════
let _trafChart = null;
let _trafTimer = null;
let _trafIface = '';
let _trafData  = { rx: [], tx: [] };
let _trafPeak  = { rx: 0, tx: 0 };
let _trafWinMin = 1;                 // window menit (1/5/10/30) — dari range selector
const TRAF_POLL_MS = 2000;          // poll tiap 2 detik

// Format jumlah byte kumulatif → KB/MB/GB
function fmtBytes(n){ n=+n||0;
  if(n>=1e9) return (n/1073741824).toFixed(2)+' GB';
  if(n>=1e6) return (n/1048576).toFixed(1)+' MB';
  if(n>=1e3) return (n/1024).toFixed(0)+' KB';
  return n+' B'; }
// Parse string rate MikroTik ("1.2Mbps","512kbps","0") → bps number
function parseRate(s){ if(!s)return 0; s=String(s).trim().toLowerCase();
  const m=s.match(/([\d.]+)\s*([kmg]?)bps/); if(!m)return parseFloat(s)||0;
  let v=parseFloat(m[1])||0; const u=m[2];
  if(u==='k')v*=1e3; else if(u==='m')v*=1e6; else if(u==='g')v*=1e9; return v; }
function fmtBps(bps) {
  bps = +bps || 0;
  if (bps >= 1e9) return (bps/1e9).toFixed(2) + ' Gbps';
  if (bps >= 1e6) return (bps/1e6).toFixed(2) + ' Mbps';
  if (bps >= 1e3) return (bps/1e3).toFixed(1) + ' Kbps';
  return Math.round(bps) + ' bps';
}
function _trafMaxPoints() { return Math.max(10, Math.round((_trafWinMin * 60 * 1000) / TRAF_POLL_MS)); }

// Range selector 1m/5m/10m/30m
function setTrafRange(min) {
  _trafWinMin = min;
  document.querySelectorAll('#trafRange .traf-rbtn').forEach(b =>
    b.classList.toggle('active', String(b.dataset.min) === String(min)));
  // Trim data ke window baru kalau mengecil
  const cap = _trafMaxPoints();
  if (_trafData.rx.length > cap) {
    _trafData.rx = _trafData.rx.slice(-cap);
    _trafData.tx = _trafData.tx.slice(-cap);
    if (_trafChart) _trafChart.updateSeries([
      { name: 'RX (Download)', data: _trafData.rx },
      { name: 'TX (Upload)', data: _trafData.tx },
    ]);
  }
}

// Auto-load interface hotspot + auto-start monitor pada interface pertama
async function loadTrafInterfaces() {
  const sel = _q('trafIface');
  if (!sel) return;
  if (!_dev()) { sel.innerHTML = '<option value="">— Pilih router dulu —</option>'; stopTrafMonitor(); return; }
  const prev = sel.value || _trafIface;
  sel.innerHTML = '<option value="">— Memuat… —</option>';
  const d = await App.api('/mikrotik/hotspot/hotspot-interfaces' + dev());
  if (!d?.success || !d.data?.length) {
    sel.innerHTML = '<option value="">— Tidak ada interface hotspot —</option>';
    _showTrafEmpty('Belum ada interface dengan service hotspot di router ini.');
    stopTrafMonitor();
    return;
  }
  sel.innerHTML = d.data.map(i =>
    `<option value="${_esc(i.name)}">${_esc(i.name)} · ${_esc(i.type)}${i.running ? '' : ' (down)'}</option>`
  ).join('');
  // Pilih interface sebelumnya kalau masih ada, kalau tidak ambil yang pertama
  const pick = (prev && [...sel.options].some(o => o.value === prev)) ? prev : sel.options[0].value;
  sel.value = pick;
  // AUTO-START (tanpa klik) — sesuai mode aktif
  if (_trafMode === 'hist') loadTrafHistory();
  else startTrafMonitor();
}

function onTrafIfaceChange() {
  if (_trafMode === 'hist') { loadTrafHistory(); return; }
  stopTrafMonitor();
  if (_q('trafIface').value) startTrafMonitor();
}

// ── (6) Mode Real-time vs Riwayat ──
let _trafMode = 'live';
let _trafHistRange = '24h';
let _trafHistChart = null;
function setTrafMode(mode){
  _trafMode = mode;
  document.querySelectorAll('#trafModeTabs .traf-rbtn').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  const live = mode==='live';
  _q('trafRange').style.display = live ? 'flex' : 'none';
  _q('trafHistRange').style.display = live ? 'none' : 'flex';
  if (live) {
    if(_q('trafHistWrap')) _q('trafHistWrap').style.display='none';
    if(_q('trafIface').value) startTrafMonitor();
  } else {
    stopTrafMonitor();
    if(_q('trafStats')) _q('trafStats').style.display='none';
    if(_q('trafChartWrap')) _q('trafChartWrap').style.display='none';
    loadTrafHistory();
  }
}
function setTrafHistRange(r){
  _trafHistRange = r;
  document.querySelectorAll('#trafHistRange .traf-rbtn').forEach(b=>b.classList.toggle('active', b.dataset.h===r));
  loadTrafHistory();
}
async function loadTrafHistory(){
  const iface=_q('trafIface')?_q('trafIface').value:'';
  if(!_dev()||!iface){ _showTrafEmpty('Pilih interface untuk melihat riwayat traffic.'); return; }
  _q('trafEmpty').style.display='none';
  _q('trafHistWrap').style.display='block';
  const d=await App.api(HS('/traffic-history')+dev('?')+`&interface=${encodeURIComponent(iface)}&range=${_trafHistRange}`);
  if(!d?.success||!d.points?.length){
    _q('trafHistWrap').style.display='none';
    _showTrafEmpty('Belum ada data riwayat untuk interface ini. Sampler merekam tiap 5 menit — coba lagi nanti.');
    return;
  }
  const pts=d.points;
  const isHour=d.fmt==='hour';
  const cats=pts.map(p=>{ const s=p.t; return isHour ? s.slice(11) : s.slice(5); }); // HH:00 atau MM-DD
  _initTrafHistChart();
  _trafHistChart.updateOptions({ xaxis:{ categories:cats } });
  _trafHistChart.updateSeries([
    { name:'RX rata-rata', data:pts.map(p=>p.rxAvg) },
    { name:'RX puncak',    data:pts.map(p=>p.rxPeak) },
    { name:'TX rata-rata', data:pts.map(p=>p.txAvg) },
    { name:'TX puncak',    data:pts.map(p=>p.txPeak) },
  ]);
  // ringkasan keseluruhan
  const peakRx=Math.max(...pts.map(p=>p.rxPeak),0), peakTx=Math.max(...pts.map(p=>p.txPeak),0);
  const avgRx=Math.round(pts.reduce((s,p)=>s+p.rxAvg,0)/pts.length), avgTx=Math.round(pts.reduce((s,p)=>s+p.txAvg,0)/pts.length);
  _q('trafHistStats').innerHTML=
    `<span>Peak ↓ <strong style="color:#2563eb">${fmtBps(peakRx)}</strong></span>`+
    `<span>Peak ↑ <strong style="color:#059669">${fmtBps(peakTx)}</strong></span>`+
    `<span>Rata-rata ↓ <strong>${fmtBps(avgRx)}</strong></span>`+
    `<span>Rata-rata ↑ <strong>${fmtBps(avgTx)}</strong></span>`+
    `<span style="color:#94a3b8">${pts.length} titik · ${d.range}</span>`;
}
function _initTrafHistChart(){
  const el=_q('trafHistChart'); if(!el||typeof ApexCharts==='undefined')return;
  if(_trafHistChart){ try{_trafHistChart.destroy();}catch(_){} _trafHistChart=null; }
  _trafHistChart=new ApexCharts(el,{
    chart:{type:'area',height:320,fontFamily:'DM Sans,sans-serif',toolbar:{show:false},zoom:{enabled:false}},
    colors:['#2563eb','#93c5fd','#059669','#6ee7b7'],
    dataLabels:{enabled:false},
    stroke:{curve:'smooth',width:[2.5,1.5,2.5,1.5],dashArray:[0,4,0,4]},
    fill:{type:'gradient',gradient:{opacityFrom:.25,opacityTo:.02}},
    series:[{name:'RX rata-rata',data:[]},{name:'RX puncak',data:[]},{name:'TX rata-rata',data:[]},{name:'TX puncak',data:[]}],
    xaxis:{categories:[],labels:{style:{colors:'#94a3b8',fontSize:'10.5px'},rotate:-45,rotateAlways:false}},
    yaxis:{labels:{formatter:v=>fmtBps(v),style:{colors:'#94a3b8',fontSize:'11px'}}},
    legend:{position:'top',horizontalAlign:'right',fontSize:'11.5px',fontWeight:600,markers:{radius:3}},
    grid:{borderColor:'#eef2f9',strokeDashArray:4},
    tooltip:{y:{formatter:v=>fmtBps(v)}},
  });
  _trafHistChart.render();
}

function _showTrafEmpty(msg) {
  const e = _q('trafEmpty'); if (e) { e.style.display = 'flex'; if (msg) e.querySelector('div').textContent = msg; }
  const w = _q('trafChartWrap'); if (w) w.style.display = 'none';
  const s = _q('trafStats'); if (s) s.style.display = 'none';
}

function _initTrafChart() {
  const el = _q('trafChart');
  if (!el || typeof ApexCharts === 'undefined') return;
  if (_trafChart) { try { _trafChart.destroy(); } catch(_){} _trafChart = null; }
  _trafChart = new ApexCharts(el, {
    chart: {
      type: 'area', height: 320, background: 'transparent',
      fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
      toolbar: { show: false }, zoom: { enabled: false },
      animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 350 } },
      dropShadow: { enabled: true, top: 2, left: 0, blur: 4, color: '#0f172a', opacity: 0.08 },
    },
    theme: { mode: 'light' },
    // RX biru, TX cyan (sesuai NOC interface) — tanpa ungu
    colors: ['#3b82f6', '#06b6d4'],
    series: [{ name: 'RX (Download)', data: [] }, { name: 'TX (Upload)', data: [] }],
    fill: { type: 'gradient', gradient: { type: 'vertical', shadeIntensity: 1, opacityFrom: 0.45, opacityTo: 0.02, stops: [0, 95] } },
    stroke: { curve: 'smooth', width: 2.2, lineCap: 'round' },
    dataLabels: { enabled: false },
    legend: {
      show: true, position: 'bottom', horizontalAlign: 'center',
      fontSize: '12px', fontWeight: 600, markers: { width: 9, height: 9, radius: 9 },
      itemMargin: { horizontal: 12, vertical: 4 }, labels: { colors: '#64748b' },
    },
    grid: {
      borderColor: '#eef2f7', strokeDashArray: 3,
      xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } },
      padding: { top: 10, right: 14, bottom: 0, left: 8 },
    },
    xaxis: {
      type: 'datetime',
      labels: { style: { fontSize: '10px', colors: '#94a3b8', fontWeight: 600 }, datetimeUTC: false, format: 'HH:mm:ss' },
      axisBorder: { show: false }, axisTicks: { show: false },
      crosshairs: { show: true, stroke: { color: '#cbd5e1', width: 1, dashArray: 3 } },
    },
    yaxis: {
      min: 0, tickAmount: 5, forceNiceScale: true,
      labels: { style: { fontSize: '10px', colors: '#94a3b8', fontWeight: 600 }, formatter: v => fmtBps(v) },
    },
    tooltip: {
      theme: 'light', shared: true, intersect: false, followCursor: true,
      x: { format: 'HH:mm:ss' }, y: { formatter: v => fmtBps(v) },
      style: { fontSize: '11px' }, marker: { show: true },
    },
    markers: { size: 0, hover: { size: 5, sizeOffset: 3 }, strokeWidth: 0 },
  });
  _trafChart.render();
}

async function startTrafMonitor() {
  const iface = _q('trafIface') ? _q('trafIface').value : '';
  if (!_dev() || !iface) { _showTrafEmpty(); return; }

  _trafIface = iface;
  _trafData = { rx: [], tx: [] };
  _trafPeak = { rx: 0, tx: 0 };
  _q('trafEmpty').style.display = 'none';
  _q('trafChartWrap').style.display = 'block';
  _q('trafStats').style.display = 'flex';
  _initTrafChart();

  const poll = async () => {
    try {
      const d = await App.api(`/mikrotik/interfaces/${encodeURIComponent(iface)}/stats` + dev());
      if (!d?.success || !d.data) return;
      const rx = +d.data.rxBitsPerSecond || 0;
      const tx = +d.data.txBitsPerSecond || 0;
      const now = Date.now();
      _trafData.rx.push({ x: now, y: rx });
      _trafData.tx.push({ x: now, y: tx });
      const cap = _trafMaxPoints();
      while (_trafData.rx.length > cap) { _trafData.rx.shift(); _trafData.tx.shift(); }
      if (rx > _trafPeak.rx) _trafPeak.rx = rx;
      if (tx > _trafPeak.tx) _trafPeak.tx = tx;

      const avg = arr => arr.length ? arr.reduce((s,p)=>s+p.y,0)/arr.length : 0;
      _q('trafRx').textContent = fmtBps(rx);
      _q('trafTx').textContent = fmtBps(tx);
      _q('trafRxAvg').textContent = fmtBps(avg(_trafData.rx));
      _q('trafTxAvg').textContent = fmtBps(avg(_trafData.tx));
      _q('trafRxPeak').textContent = fmtBps(_trafPeak.rx);
      _q('trafTxPeak').textContent = fmtBps(_trafPeak.tx);
      if (_trafChart) _trafChart.updateSeries([
        { name: 'RX (Download)', data: _trafData.rx },
        { name: 'TX (Upload)', data: _trafData.tx },
      ]);
    } catch (_) {}
  };
  await poll();
  _trafTimer = setInterval(poll, TRAF_POLL_MS);
}

function stopTrafMonitor() {
  if (_trafTimer) { clearInterval(_trafTimer); _trafTimer = null; }
}
