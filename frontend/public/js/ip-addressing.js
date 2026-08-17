// ip-addressing.js — Manajemen /ip/address MikroTik (tambah, edit, hapus) — UI ala GenieACS
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const _dev = () => document.getElementById('routerSel')?.value || '';
const _q = id => document.getElementById(id);
let _routers = [], _ipCache = [], _ifaceCache = [], _ipFilter = 'all';
const LS_KEY = 'flaynet:ipaddr:router_id';
const dev = (sep = '?') => _dev() ? `${sep}device_id=${_dev()}` : '';

document.addEventListener('DOMContentLoaded', loadRouters);

// ── ROUTER ──
async function loadRouters(){
  const d = await App.api('/tools/routers');
  const sel = _q('routerSel');
  if(!d?.success || !d.data?.length){ sel.innerHTML='<option value="">— Tidak ada router —</option>'; return; }
  _routers = d.data;
  const saved = localStorage.getItem(LS_KEY);
  sel.innerHTML = _routers.map(r=>`<option value="${r.id}" ${String(r.id)===String(saved)?'selected':''}>${_esc(r.name)} — ${_esc(r.ip_address)}</option>`).join('');
  if(!saved && _routers[0]) sel.value = _routers[0].id;
  onRouterChange();
}
function onRouterChange(){
  const id=_dev(); if(id) localStorage.setItem(LS_KEY,id);
  const r=_routers.find(x=>String(x.id)===String(id));
  const pill=_q('routerProto');
  if(r&&pill){ pill.textContent=(r.api_protocol||'auto').toUpperCase(); pill.style.display='inline-flex'; }
  loadAddresses();
}

// ── Generic modal ──
function openModal(html){ _q('mdBox').innerHTML=html; _q('mdGeneric').classList.add('show'); }
function closeModal(){ _q('mdGeneric').classList.remove('show'); }
_q('mdGeneric').addEventListener('click', e=>{ if(e.target.id==='mdGeneric') closeModal(); });

const _bodyMsg = (msg, spinner) => `<tr><td colspan="6"><div class="tbl-empty">${spinner?'<span class="spinner"></span>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="6" rx="1.5"/><rect x="2" y="15" width="20" height="6" rx="1.5"/></svg>'}<p>${msg}</p></div></td></tr>`;

// ── LOAD ──
async function loadAddresses(){
  const body=_q('ipBody');
  if(!_dev()){ body.innerHTML=_bodyMsg('Pilih router dulu.'); return; }
  body.innerHTML=_bodyMsg('Memuat IP address…', true);
  const d=await App.api('/ip-addressing'+dev());
  if(!d?.success){ body.innerHTML=_bodyMsg('Gagal: '+_esc(d?.message)); return; }
  _ipCache=d.data||[]; _ifaceCache=d.interfaces||[];
  const total=_ipCache.length, dyn=_ipCache.filter(a=>a.dynamic).length, dis=_ipCache.filter(a=>a.disabled).length;
  _q('ipsTotal').textContent=total;
  _q('ipsStatic').textContent=total-dyn;
  _q('ipsDynamic').textContent=dyn;
  _q('ipsDisabled').textContent=dis;
  // dropdown filter interface
  const f=_q('ifaceFilter'); const cur=f.value;
  const used=[...new Set(_ipCache.map(a=>a.interface).filter(Boolean))].sort();
  f.innerHTML='<option value="">Semua interface</option>'+used.map(n=>`<option value="${_esc(n)}" ${n===cur?'selected':''}>${_esc(n)}</option>`).join('');
  renderAddresses();
}

function renderAddresses(){
  const body=_q('ipBody'); if(!body) return;
  const term=(_q('ipSearch')?.value||'').toLowerCase().trim();
  const ifaceF=_q('ifaceFilter')?.value||'';
  let list=_ipCache;
  if(_ipFilter==='static')        list=list.filter(a=>!a.dynamic);
  else if(_ipFilter==='dynamic')  list=list.filter(a=>a.dynamic);
  else if(_ipFilter==='disabled') list=list.filter(a=>a.disabled);
  if(ifaceF) list=list.filter(a=>a.interface===ifaceF);
  if(term)   list=list.filter(a=>(a.address+' '+a.network+' '+a.interface+' '+a.comment).toLowerCase().includes(term));

  _q('ipCount').textContent=list.length;

  if(!_ipCache.length){ body.innerHTML=_bodyMsg('Belum ada IP address di router ini.'); _q('ipFooter').textContent='—'; return; }
  if(!list.length){ body.innerHTML=_bodyMsg('Tidak ada IP yang cocok dengan filter.'); _q('ipFooter').textContent='0 dari '+_ipCache.length+' IP'; return; }

  list=[...list].sort((a,b)=> (a.interface||'').localeCompare(b.interface||'') || (a.address||'').localeCompare(b.address||''));

  body.innerHTML=list.map(a=>{
    const iface=_ifaceCache.find(i=>i.name===a.interface);
    const running=iface?iface.running:true;
    const acts = a.dynamic
      ? '<span class="act-dim">otomatis</span>'
      : `<div class="act-btns">
          <button class="act-btn act-toggle" title="${a.disabled?'Aktifkan':'Nonaktifkan'}" onclick="toggleIp('${a.id}',${a.disabled?'false':'true'})">
            ${a.disabled
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 12l2 2 4-4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9" stroke-width="1.8"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" stroke-width="1.8"/><line x1="8" y1="12" x2="16" y2="12" stroke-width="2" stroke-linecap="round"/></svg>'}
          </button>
          <button class="act-btn act-edit" title="Edit" onclick="openIpModal('${a.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>
          </button>
          <button class="act-btn act-del" title="Hapus" onclick="delIp('${a.id}','${_esc(a.address)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>`;
    return `<tr class="${a.disabled?'row-disabled':''}">
      <td data-l="Address"><div class="ip-cell"><span class="ip-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="4" width="20" height="6" rx="1.5" stroke-width="1.8"/><rect x="2" y="14" width="20" height="6" rx="1.5" stroke-width="1.8"/></svg></span>
        <div style="min-width:0"><div class="ip-addr">${_esc(a.address)}</div>${a.network?`<div class="ip-net">net ${_esc(a.network)}</div>`:''}</div></div></td>
      <td data-l="Interface"><span class="iface-pill"><span class="dot ${running?'':'off'}"></span>${_esc(a.interface||'–')}</span></td>
      <td data-l="Tipe"><span class="type-pill ${a.dynamic?'dynamic':'static'}">${a.dynamic?'dinamis':'statis'}</span></td>
      <td data-l="Status">${a.disabled?'<span class="status-pill pill-off"><span class="sdot"></span>Nonaktif</span>':'<span class="status-pill pill-on"><span class="sdot"></span>Aktif</span>'}</td>
      <td data-l="Komentar">${a.comment?`<span class="cmt-txt" title="${_esc(a.comment)}">${_esc(a.comment)}</span>`:'<span class="cmt-empty">–</span>'}</td>
      <td class="ta-r" data-l="">${acts}</td></tr>`;
  }).join('');
  _q('ipFooter').innerHTML=`Menampilkan <strong>${list.length}</strong> dari <strong>${_ipCache.length}</strong> IP address`;
}

// Klik chip / stat card → set filter
function ipFilterClick(kind){
  _ipFilter=kind;
  const map={all:'ipc-all',static:'ipc-static',dynamic:'ipc-dynamic',disabled:'ipc-disabled'};
  document.querySelectorAll('.ot-card').forEach(c=>c.classList.remove('otc-active'));
  _q(map[kind])?.classList.add('otc-active');
  document.querySelectorAll('.fchip').forEach(c=>c.classList.toggle('active', c.dataset.f===kind));
  renderAddresses();
}

// ── ADD / EDIT MODAL ──
function openIpModal(editId){
  if(!_dev()){ App.showToast('Pilih router dulu','warning'); return; }
  const isEdit=!!editId;
  const e = isEdit ? _ipCache.find(x=>String(x.id)===String(editId)) : null;
  if(isEdit && !e){ App.showToast('IP tidak ditemukan, muat ulang dulu','warning'); return; }
  if(e && e.dynamic){ App.showToast('IP dinamis tidak bisa diedit','warning'); return; }
  const g=k=>e?_esc(e[k]||''):'';
  const ifaceOpts=['<option value="">— pilih interface —</option>']
    .concat(_ifaceCache.map(i=>`<option value="${_esc(i.name)}" ${e&&e.interface===i.name?'selected':''}>${_esc(i.name)}${i.type?` · ${_esc(i.type)}`:''}${i.running?'':' (down)'}</option>`));
  if(e && e.interface && !_ifaceCache.some(i=>i.name===e.interface))
    ifaceOpts.push(`<option value="${_esc(e.interface)}" selected>${_esc(e.interface)}</option>`);
  openModal(`<h3>${isEdit?'Edit':'Tambah'} IP Address</h3>
    <p>Alamat IP yang dipasang pada interface MikroTik (format CIDR, mis. <strong>192.168.1.1/24</strong>).</p>
    <div class="fg" style="margin-bottom:12px"><label>Address (CIDR) <span style="color:#e11d48">*</span></label>
      <input class="mono" id="ip_address" value="${g('address')}" placeholder="192.168.1.1/24"></div>
    <div class="fg" style="margin-bottom:12px"><label>Interface <span style="color:#e11d48">*</span></label>
      <select id="ip_iface">${ifaceOpts.join('')}</select></div>
    <div class="grid2" style="margin-bottom:12px">
      <div class="fg"><label>Network <span class="hint">(opsional)</span></label><input class="mono" id="ip_network" value="${g('network')}" placeholder="otomatis"></div>
      <div class="fg"><label>Status</label>
        <select id="ip_disabled"><option value="false" ${e&&e.disabled?'':'selected'}>Aktif</option><option value="true" ${e&&e.disabled?'selected':''}>Nonaktif</option></select></div>
    </div>
    <div class="fg"><label>Komentar <span class="hint">(opsional)</span></label><input id="ip_comment" value="${g('comment')}" placeholder="mis. Gateway distribusi"></div>
    <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Batal</button>
      <button class="btn btn-blue" id="ip_save" onclick="saveIp('${isEdit?editId:''}')">${isEdit?'Simpan Perubahan':'Tambah IP'}</button></div>`);
}

async function saveIp(editId){
  const isEdit=!!editId, lbl=isEdit?'Simpan Perubahan':'Tambah IP';
  const val=id=>{ const e=_q(id); return e?e.value.trim():''; };
  const address=val('ip_address'), iface=_q('ip_iface').value;
  const btn=_q('ip_save');
  const fail=m=>App.showToast(m,'warning');
  if(!address) return fail('Address (CIDR) wajib diisi');
  if(!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(address)) return fail('Format harus CIDR, mis. 192.168.1.1/24');
  if(!iface) return fail('Interface wajib dipilih');
  btn.disabled=true; btn.innerHTML='<span class="spinner light"></span>';
  const bodyData={device_id:_dev(),address,interface:iface,network:val('ip_network'),comment:val('ip_comment'),disabled:_q('ip_disabled').value==='true'};
  const url=isEdit?`/ip-addressing/${editId}`:'/ip-addressing';
  const d=await App.api(url,{method:isEdit?'PUT':'POST',body:JSON.stringify(bodyData)});
  App.showToast(d?.message||'OK',d?.success?'success':'error');
  if(d?.success){ closeModal(); loadAddresses(); } else { btn.disabled=false; btn.textContent=lbl; }
}

async function toggleIp(id,disabled){
  const d=await App.api(`/ip-addressing/${id}/toggle`,{method:'POST',body:JSON.stringify({device_id:_dev(),disabled})});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadAddresses();
}
async function delIp(id,addr){
  if(!confirm(`Hapus IP ${addr} dari router?`))return;
  const d=await App.api(`/ip-addressing/${id}`+dev(),{method:'DELETE'});
  App.showToast(d?.message||'OK',d?.success?'success':'error'); if(d?.success)loadAddresses();
}
