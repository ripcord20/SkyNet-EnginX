/**
 * work-orders.js — Work Order Management
 * NETOPS VOK-10
 */

const TOKEN = localStorage.getItem('token');
const API   = '/api';

let allWOs      = [];
let allUsers    = [];
let allCustomers= [];
let allTickets  = [];
let editingId   = null;
let deletingId  = null;
let viewingId   = null;
let techType    = 'user';  // 'user' | 'manual'
let activeStatusFilter = '';

function authH() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showOk(msg)  { toast('toastOk',  '✓ ' + msg); }
function showErr(msg) { toast('toastErr', '✕ ' + msg); }
function toast(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  setTimeout(()=>{ el.style.display='none'; }, 3500);
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'});
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

/* ═══════════════════════════════════════
   LOAD ALL DATA
════════════════════════════════════════ */
async function loadAll() {
  await Promise.all([loadUsers(), loadCustomers(), loadTickets()]);
  await loadWOs();
}

async function loadUsers() {
  try {
    const r = await fetch(`${API}/users`, { headers: authH() });
    const j = await r.json();
    allUsers = j.success ? (j.data||[]) : [];
    const opts = '<option value="">— Pilih user —</option>' +
      allUsers.map(u=>`<option value="${u.id}">${esc(u.name||u.email)}</option>`).join('');
    document.getElementById('f_assigned_user_id').innerHTML = opts;
  } catch(e) {}
}

async function loadCustomers() {
  try {
    const r = await fetch(`${API}/customers?limit=500`, { headers: authH() });
    const j = await r.json();
    allCustomers = j.success ? (j.data?.customers||j.data||[]) : [];
    const opts = '<option value="">— Pilih customer (opsional) —</option>' +
      allCustomers.map(c=>`<option value="${c.id}">[${esc(c.customer_id)}] ${esc(c.name)}</option>`).join('');
    document.getElementById('f_customer_id').innerHTML = opts;
  } catch(e) {}
}

async function loadTickets() {
  try {
    const r = await fetch(`${API}/tickets?limit=200`, { headers: authH() });
    const j = await r.json();
    allTickets = j.success ? (j.data?.tickets||j.data||[]) : [];
    const opts = '<option value="">— Pilih ticket (opsional) —</option>' +
      allTickets.map(t=>`<option value="${t.id}">[${esc(t.ticket_number)}] ${esc(t.title)}</option>`).join('');
    document.getElementById('f_ticket_id').innerHTML = opts;
  } catch(e) {}
}

async function loadWOs() {
  try {
    const r = await fetch(`${API}/work-orders`, { headers: authH() });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    allWOs = j.data || [];
    renderStats();
    renderTable();
  } catch(e) { showErr('Gagal memuat: ' + e.message); }
}

/* ═══════════════════════════════════════
   STATS
════════════════════════════════════════ */
function renderStats() {
  const total      = allWOs.length;
  const pending    = allWOs.filter(w=>['pending','assigned'].includes(w.status)).length;
  const inProgress = allWOs.filter(w=>w.status==='in_progress').length;
  const done       = allWOs.filter(w=>w.status==='done').length;
  const today      = new Date().toISOString().slice(0,10);
  const overdue    = allWOs.filter(w=>w.due_date&&w.due_date<today&&!['done','cancelled'].includes(w.status)).length;

  setText('scTotal',     total);
  setText('scPending',   pending);
  setText('scInProgress',inProgress);
  setText('scDone',      done);
  setText('scTotalPct',    overdue>0?`${overdue} overdue`:'Tidak ada overdue');
  setText('scPendingPct',  total?Math.round(pending/total*100)+'% dari total':'—');
  setText('scProgressPct', total?Math.round(inProgress/total*100)+'% dari total':'—');
  setText('scDonePct',     total?Math.round(done/total*100)+'% selesai':'—');
  setBar('scPendingBar',   total?pending/total*100:0);
  setBar('scProgressBar',  total?inProgress/total*100:0);
  setBar('scDoneBar',      total?done/total*100:0);
  setText('woHeaderSub',   `${total} work order · ${pending} pending · ${inProgress} in progress · ${done} selesai`);

  // Sidebar badge
  const badge = document.getElementById('wo-pending-badge');
  if (badge) {
    badge.textContent = pending+inProgress;
    badge.style.display = (pending+inProgress)>0 ? 'inline-flex' : 'none';
  }
}
function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function setBar(id,pct){ const el=document.getElementById(id); if(el) el.style.width=pct+'%'; }

/* ═══════════════════════════════════════
   RENDER TABLE
════════════════════════════════════════ */
function getFiltered() {
  const search   = (document.getElementById('woSearch')?.value||'').toLowerCase();
  const status   = document.getElementById('filterStatus')?.value||'';
  const type     = document.getElementById('filterType')?.value||'';
  const priority = document.getElementById('filterPriority')?.value||'';

  let list = [...allWOs];
  if (activeStatusFilter) list = list.filter(w=>w.status===activeStatusFilter);
  if (status)   list = list.filter(w=>w.status===status);
  if (type)     list = list.filter(w=>w.type===type);
  if (priority) list = list.filter(w=>w.priority===priority);
  if (search)   list = list.filter(w=>
    (w.wo_number||'').toLowerCase().includes(search)||
    (w.title||'').toLowerCase().includes(search)||
    (w.technician_name||'').toLowerCase().includes(search)||
    (w.assignedUser?.name||'').toLowerCase().includes(search)||
    (w.customer?.name||'').toLowerCase().includes(search)
  );
  return list;
}

function renderTable() {
  const list  = getFiltered();
  const tbody = document.getElementById('woTableBody');
  const lbl   = document.getElementById('woCountLbl');
  if (lbl) lbl.textContent = list.length + ' work order';

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:52px;color:var(--d-muted)">
      <div style="font-size:34px;margin-bottom:10px">📋</div>
      <div style="font-size:14px;font-weight:600;color:var(--d-text)">Tidak ada work order</div>
    </td></tr>`;
    return;
  }

  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);

  tbody.innerHTML = list.map(w => {
    // Technician display
    let techHtml = '';
    if (w.assignedUser) {
      const ini = (w.assignedUser.name||'U').split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
      techHtml = `<div style="display:flex;align-items:center;gap:8px">
        <div class="tech-avatar">${ini}</div>
        <span style="font-size:12.5px;font-weight:600">${esc(w.assignedUser.name)}</span>
      </div>`;
    } else if (w.technician_name) {
      const ini = (w.technician_name||'T').split(/\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase();
      techHtml = `<div style="display:flex;align-items:center;gap:8px">
        <div class="tech-avatar manual">${ini}</div>
        <div>
          <div style="font-size:12.5px;font-weight:600">${esc(w.technician_name)}</div>
          ${w.technician_phone?`<div style="font-size:11px;color:var(--d-muted)">${esc(w.technician_phone)}</div>`:''}
        </div>
      </div>`;
    } else {
      techHtml = `<span style="font-size:12px;color:var(--d-muted);font-style:italic">Belum ditugaskan</span>`;
    }

    // Due date class
    let dueCls = 'due-ok', dueLabel = fmtDate(w.scheduled_date);
    if (w.scheduled_date && !['done','cancelled'].includes(w.status)) {
      if (w.scheduled_date < today)    { dueCls='due-overdue'; }
      else if (w.scheduled_date <= tomorrow) { dueCls='due-soon'; }
    }

    // Customer sub-info
    const custInfo = w.customer
      ? `<div style="font-size:11px;color:var(--d-muted);margin-top:2px">${esc(w.customer.name)}</div>`
      : '';
    const ticketInfo = w.ticket
      ? `<div style="font-size:11px;color:#0891b2;margin-top:2px">${esc(w.ticket.ticket_number)}</div>`
      : '';

    return `<tr>
      <td><span class="wo-num">${esc(w.wo_number||'—')}</span></td>
      <td><span class="type-badge type-${w.type}">${typeLabel(w.type)}</span></td>
      <td>
        <div style="font-size:13.5px;font-weight:600;color:var(--d-text)">${esc(w.title)}</div>
        ${custInfo}${ticketInfo}
      </td>
      <td>${techHtml}</td>
      <td><span class="${dueCls}">${dueLabel||'—'}</span></td>
      <td><span class="prio prio-${w.priority}">${(w.priority||'').toUpperCase()}</span></td>
      <td><span class="sb sb-${w.status}">${statusDot(w.status)}${statusLabel(w.status)}</span></td>
      <td style="text-align:right;padding-right:16px">
        <div style="display:flex;justify-content:flex-end;gap:6px">
          <button class="rb rb-view" onclick="openDetail(${w.id})">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            Detail
          </button>
          <button class="rb rb-edit" onclick="openEdit(${w.id})">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="rb rb-del" onclick="openDelete(${w.id},'${esc(w.wo_number||w.title)}')" title="Hapus">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function typeLabel(t) {
  return ({installation:'Installation',maintenance:'Maintenance',dismantle:'Dismantle',survey:'Survey',repair:'Repair',other:'Other'})[t]||t;
}
function statusLabel(s) {
  return ({pending:'Pending',assigned:'Assigned',in_progress:'In Progress',done:'Done',cancelled:'Cancelled'})[s]||s;
}
function statusDot(s) {
  const c = {pending:'#f97316',assigned:'#3b82f6',in_progress:'#eab308',done:'#22c55e',cancelled:'#94a3b8'}[s]||'#94a3b8';
  return `<span class="sb-dot" style="background:${c}"></span>`;
}

/* ═══════════════════════════════════════
   FILTER
════════════════════════════════════════ */
function setFilter(status) {
  activeStatusFilter = status;
  const sel = document.getElementById('filterStatus');
  if (sel) sel.value = status;
  renderTable();
}

/* ═══════════════════════════════════════
   DETAIL DRAWER
════════════════════════════════════════ */
function openDetail(id) {
  const w = allWOs.find(x=>x.id===id);
  if (!w) return;
  viewingId = id;

  document.getElementById('drawerTitle').textContent = w.title;
  document.getElementById('drawerWoNum').textContent = w.wo_number||'';

  // Status stepper
  const steps = ['pending','in_progress','done'];
  const stepNames = ['Pending','In Progress','Done'];
  const curIdx = steps.indexOf(w.status==='assigned'?'pending':w.status==='cancelled'?'pending':w.status);
  const stepperHtml = `
    <div class="detail-section">
      <div class="detail-section-title">Progress</div>
      <div class="status-steps">
        ${steps.map((s,i)=>`
          <div class="step-wrap">
            <div class="step ${i<curIdx?'done-step':i===curIdx?'active-step':''}">
              <div class="step-circle">
                ${i<curIdx?'✓':i+1}
              </div>
            </div>
            <div class="step-label ${i<curIdx?'done-step':i===curIdx?'active-step':''}">${stepNames[i]}</div>
          </div>
          ${i<steps.length-1?'<div style="flex:1;height:2px;background:'+(i<curIdx?'#00a07a':'var(--d-border)')+'margin-top:-14px"></div>':''}
        `).join('')}
      </div>
    </div>`;

  // Tech info
  let techInfo = '—';
  if (w.assignedUser)     techInfo = w.assignedUser.name + (w.assignedUser.email?` (${w.assignedUser.email})`:'');
  else if (w.technician_name) techInfo = w.technician_name + (w.technician_phone?` · ${w.technician_phone}`:'');

  // Status change buttons
  const statusBtns = buildStatusBtns(w);

  const bodyHtml = `
    ${stepperHtml}

    <div class="detail-section">
      <div class="detail-section-title">Informasi WO</div>
      <div class="detail-grid">
        <div class="detail-item"><label>Tipe</label><span><span class="type-badge type-${w.type}">${typeLabel(w.type)}</span></span></div>
        <div class="detail-item"><label>Prioritas</label><span><span class="prio prio-${w.priority}">${(w.priority||'').toUpperCase()}</span></span></div>
        <div class="detail-item"><label>Status</label><span><span class="sb sb-${w.status}">${statusDot(w.status)}${statusLabel(w.status)}</span></span></div>
        <div class="detail-item"><label>Jadwal</label><span>${fmtDate(w.scheduled_date)}${w.scheduled_time?' '+w.scheduled_time:''}</span></div>
        <div class="detail-item"><label>Deadline</label><span>${fmtDate(w.due_date)}</span></div>
        <div class="detail-item"><label>Mulai</label><span>${fmtDateTime(w.started_at)}</span></div>
        <div class="detail-item"><label>Selesai</label><span>${fmtDateTime(w.completed_at)}</span></div>
        <div class="detail-item" style="grid-column:1/-1"><label>Teknisi</label><span>${esc(techInfo)}</span></div>
        ${w.customer?`<div class="detail-item"><label>Customer</label><span>${esc(w.customer.name)}</span></div>`:''}
        ${w.ticket?`<div class="detail-item"><label>Ticket</label><span>${esc(w.ticket.ticket_number+' - '+w.ticket.title)}</span></div>`:''}
        ${w.location_address?`<div class="detail-item" style="grid-column:1/-1"><label>Lokasi</label><span>${esc(w.location_address)}</span></div>`:''}
        ${w.description?`<div class="detail-item" style="grid-column:1/-1"><label>Deskripsi</label><span>${esc(w.description)}</span></div>`:''}
        ${w.notes?`<div class="detail-item" style="grid-column:1/-1"><label>Catatan</label><span>${esc(w.notes)}</span></div>`:''}
      </div>
    </div>

    ${w.completion_notes?`
    <div class="detail-section">
      <div class="detail-section-title">Laporan Selesai</div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 14px;font-size:13px;color:#15803d">${esc(w.completion_notes)}</div>
    </div>`:''}

    <div class="detail-section">
      <div class="detail-section-title">Foto Bukti (${(w.photos||[]).length})</div>
      <div class="photo-grid" id="drawerPhotoGrid">
        ${buildPhotoGrid(w)}
      </div>
      <div style="margin-top:10px">
        <label class="photo-upload-box" for="photoUploadInput">
          <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin:0 auto 4px;display:block;color:var(--d-blue1)"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <p>Klik untuk upload foto bukti (JPG/PNG, maks 10MB)</p>
        </label>
        <input type="file" id="photoUploadInput" multiple accept="image/*" style="display:none" onchange="uploadPhotos(${w.id}, this)">
      </div>
    </div>

    ${w.status!=='done'?`
    <div class="detail-section">
      <div class="detail-section-title">Update Status</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${statusBtns}
      </div>
      ${w.status==='in_progress'||w.status==='done'?`
      <div style="margin-top:12px">
        <label class="flbl">Laporan Selesai</label>
        <textarea class="finput" id="completionNotesInput" rows="3" placeholder="Tuliskan laporan hasil pekerjaan…">${esc(w.completion_notes||'')}</textarea>
      </div>`:''}</div>`:''}
  `;

  document.getElementById('drawerBody').innerHTML = bodyHtml;
  document.getElementById('drawerFooter').innerHTML = `
    <button onclick="openEdit(${w.id})" class="btn-fin btn-primary-fin" style="flex:1;justify-content:center">
      <svg width="13" height="13" fill="none" stroke="white" stroke-width="2.5" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Edit WO
    </button>
    <button onclick="openDelete(${w.id},'${esc(w.wo_number||'')}');closeDrawer()" class="btn-fin btn-ghost">Hapus</button>
    <button onclick="closeDrawer()" class="btn-fin btn-ghost wo-footer-close" style="gap:5px">
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      Close
    </button>
  `;

  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('woDrawer').classList.add('open');
}

function buildStatusBtns(w) {
  const transitions = {
    pending:     [{s:'assigned',label:'Tugaskan',cls:'background:#1a6ef5;color:#fff;border:none'},{s:'in_progress',label:'Mulai',cls:'background:#ea580c;color:#fff;border:none'}],
    assigned:    [{s:'in_progress',label:'Mulai Kerjakan',cls:'background:#ea580c;color:#fff;border:none'}],
    in_progress: [{s:'done',label:'Tandai Selesai ✓',cls:'background:#00a07a;color:#fff;border:none'}],
    done:        [],
    cancelled:   []
  };
  const btns = transitions[w.status]||[];
  return btns.map(b=>`
    <button onclick="updateStatus(${w.id},'${b.s}')" class="btn-fin" style="${b.cls};box-shadow:none;border-radius:10px">${b.label}</button>
  `).join('') +
  (w.status!=='done'&&w.status!=='cancelled'?
    `<button onclick="updateStatus(${w.id},'cancelled')" class="btn-fin btn-ghost" style="color:#dc2626;border-color:#fecdd3">Batalkan</button>`
  :'');
}

function buildPhotoGrid(w) {
  const photos = w.photos||[];
  if (!photos.length) return '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--d-muted);font-size:12.5px">Belum ada foto bukti</div>';
  return photos.map((p,i)=>`
    <div class="photo-item">
      <img src="${esc(p.url)}" alt="Foto ${i+1}" onclick="openLightbox('${esc(p.url)}')">
      <button class="photo-del-btn" onclick="deletePhoto(${w.id},${i})" title="Hapus foto">✕</button>
    </div>`).join('');
}

function closeDrawer() {
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('woDrawer').classList.remove('open');
  viewingId = null;
}

/* ═══════════════════════════════════════
   STATUS UPDATE
════════════════════════════════════════ */
async function updateStatus(id, status) {
  const completionNotes = document.getElementById('completionNotesInput')?.value || '';
  try {
    const body = { status };
    if (status === 'done' && completionNotes) body.completion_notes = completionNotes;
    const r = await fetch(`${API}/work-orders/${id}`, { method:'PUT', headers:authH(), body:JSON.stringify(body) });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    showOk('Status berhasil diperbarui');
    await loadWOs();
    // Refresh drawer
    if (viewingId === id) openDetail(id);
  } catch(e) { showErr('Gagal: '+e.message); }
}

/* ═══════════════════════════════════════
   PHOTO UPLOAD
════════════════════════════════════════ */
async function uploadPhotos(id, input) {
  if (!input.files.length) return;
  const form = new FormData();
  Array.from(input.files).forEach(f => form.append('photos', f));
  try {
    const r = await fetch(`${API}/work-orders/${id}/photos`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}` },
      body: form
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    showOk(j.message||'Foto berhasil diupload');
    await loadWOs();
    if (viewingId === id) openDetail(id);
  } catch(e) { showErr('Upload gagal: '+e.message); }
  input.value = '';
}

async function deletePhoto(id, idx) {
  if (!confirm('Hapus foto ini?')) return;
  try {
    const r = await fetch(`${API}/work-orders/${id}/photos/${idx}`, { method:'DELETE', headers:authH() });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    showOk('Foto dihapus');
    await loadWOs();
    if (viewingId === id) openDetail(id);
  } catch(e) { showErr('Gagal: '+e.message); }
}

/* ═══════════════════════════════════════
   LIGHTBOX
════════════════════════════════════════ */
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
}

/* ═══════════════════════════════════════
   MODAL ADD/EDIT
════════════════════════════════════════ */
function openAdd() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Buat Work Order Baru';
  document.getElementById('btnSaveTxt').textContent = 'Buat Work Order';
  clearForm();
  document.getElementById('woModal').classList.add('active');
  setTimeout(()=>document.getElementById('f_title').focus(),100);
}

function openEdit(id) {
  const w = allWOs.find(x=>x.id===id);
  if (!w) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Work Order';
  document.getElementById('btnSaveTxt').textContent = 'Simpan Perubahan';
  fillForm(w);
  document.getElementById('woModal').classList.add('active');
}

function closeModal() {
  document.getElementById('woModal').classList.remove('active');
  editingId = null;
}

function clearForm() {
  ['f_title','f_description','f_location_address','f_notes','f_technician_name','f_technician_phone'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('f_type').value       = 'installation';
  document.getElementById('f_priority').value   = 'medium';
  document.getElementById('f_status').value     = 'pending';
  document.getElementById('f_scheduled_date').value = '';
  document.getElementById('f_assigned_user_id').value = '';
  document.getElementById('f_customer_id').value = '';
  document.getElementById('f_ticket_id').value   = '';
  setTechType('user');
}

function fillForm(w) {
  document.getElementById('f_title').value            = w.title||'';
  document.getElementById('f_description').value      = w.description||'';
  document.getElementById('f_type').value             = w.type||'installation';
  document.getElementById('f_priority').value         = w.priority||'medium';
  document.getElementById('f_status').value           = w.status||'pending';
  document.getElementById('f_scheduled_date').value   = w.scheduled_date||'';
  document.getElementById('f_location_address').value = w.location_address||'';
  document.getElementById('f_notes').value            = w.notes||'';
  document.getElementById('f_customer_id').value      = w.customer_id||'';
  document.getElementById('f_ticket_id').value        = w.ticket_id||'';

  if (w.assigned_user_id) {
    setTechType('user');
    document.getElementById('f_assigned_user_id').value = w.assigned_user_id;
  } else if (w.technician_name) {
    setTechType('manual');
    document.getElementById('f_technician_name').value  = w.technician_name||'';
    document.getElementById('f_technician_phone').value = w.technician_phone||'';
  } else {
    setTechType('user');
  }
}

function setTechType(type) {
  techType = type;
  document.getElementById('techTypeUser').classList.toggle('active',   type==='user');
  document.getElementById('techTypeManual').classList.toggle('active', type==='manual');
  document.getElementById('techUserPanel').style.display   = type==='user'   ? 'block' : 'none';
  document.getElementById('techManualPanel').style.display = type==='manual' ? 'grid'  : 'none';
}

/* ═══════════════════════════════════════
   SAVE
════════════════════════════════════════ */
async function saveWO() {
  const title         = document.getElementById('f_title').value.trim();
  const description   = document.getElementById('f_description').value.trim();
  const type          = document.getElementById('f_type').value;
  const priority      = document.getElementById('f_priority').value;
  const status        = document.getElementById('f_status').value;
  const scheduled_date= document.getElementById('f_scheduled_date').value||null;
  const location_address = document.getElementById('f_location_address').value.trim()||null;
  const notes         = document.getElementById('f_notes').value.trim()||null;
  const customer_id   = document.getElementById('f_customer_id').value||null;
  const ticket_id     = document.getElementById('f_ticket_id').value||null;

  let assigned_user_id = null, technician_name = null, technician_phone = null;
  if (techType==='user') {
    assigned_user_id = document.getElementById('f_assigned_user_id').value||null;
  } else {
    technician_name  = document.getElementById('f_technician_name').value.trim()||null;
    technician_phone = document.getElementById('f_technician_phone').value.trim()||null;
  }

  if (!title) return showErr('Judul WO wajib diisi');

  const btn = document.getElementById('btnSaveWO');
  btn.disabled = true;
  document.getElementById('btnSaveTxt').textContent = 'Menyimpan…';

  try {
    const url    = editingId ? `${API}/work-orders/${editingId}` : `${API}/work-orders`;
    const method = editingId ? 'PUT' : 'POST';
    const sendWa = document.getElementById('f_send_wa')?.checked !== false;
    const r = await fetch(url, {
      method, headers: authH(),
      body: JSON.stringify({
        title, description, type, priority, status, scheduled_date,
        location_address, notes, customer_id, ticket_id,
        assigned_user_id, technician_name, technician_phone,
        send_wa_notification: sendWa
      })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    closeModal();
    // Pesan sukses + info WA
    let msg = editingId ? 'Work Order berhasil diperbarui' : `Work Order ${j.data?.wo_number||''} berhasil dibuat`;
    if (j.wa) {
      if (j.wa.sent) msg += ' · Notifikasi WA terkirim ✓';
      else if (sendWa) msg += ` · WA gagal: ${j.wa.reason}`;
    }
    showOk(msg);
    await loadWOs();
  } catch(e) { showErr('Gagal: '+e.message); }
  finally {
    btn.disabled = false;
    document.getElementById('btnSaveTxt').textContent = editingId?'Simpan Perubahan':'Buat Work Order';
  }
}

/* ═══════════════════════════════════════
   DELETE
════════════════════════════════════════ */
function openDelete(id, num) {
  deletingId = id;
  document.getElementById('delMsg').innerHTML =
    `Work Order <strong>${esc(num)}</strong> akan dihapus permanen beserta semua foto terkait.`;
  document.getElementById('delModal').classList.add('active');
}
function closeDelModal() {
  document.getElementById('delModal').classList.remove('active');
  deletingId = null;
}
async function confirmDelete() {
  if (!deletingId) return;
  try {
    const r = await fetch(`${API}/work-orders/${deletingId}`,{method:'DELETE',headers:authH()});
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    closeDelModal(); closeDrawer();
    showOk('Work Order berhasil dihapus');
    await loadWOs();
  } catch(e) { showErr('Gagal: '+e.message); }
}

/* ═══════════════════════════════════════
   INIT
════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Close modals on overlay
  ['woModal','delModal'].forEach(id=>{
    document.getElementById(id)?.addEventListener('click',e=>{
      if(e.target===document.getElementById(id)) { id==='woModal'?closeModal():closeDelModal(); }
    });
  });

  // Filters
  let t;
  document.getElementById('woSearch')?.addEventListener('input',()=>{ clearTimeout(t);t=setTimeout(renderTable,300); });
  ['filterStatus','filterType','filterPriority'].forEach(id=>{
    document.getElementById(id)?.addEventListener('change',()=>{ activeStatusFilter=''; renderTable(); });
  });

  loadAll();
});