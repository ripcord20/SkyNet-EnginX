/**
 * todos.js — To Do List (Kanban Board)
 * NETOPS VOK-10
 */

const TOKEN = localStorage.getItem('token');
const API   = '/api';

let allTodos     = [];
let allUsers     = [];
let editingId    = null;
let deletingId   = null;
let draggingId   = null;
let activeFilter = { status: '', priority: '', assignee: '' };

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

/* ═══════════════════════════════════════
   LOAD DATA
════════════════════════════════════════ */
async function loadAll() {
  await Promise.all([loadUsers(), loadTodos()]);
}

async function loadUsers() {
  try {
    const r = await fetch(`${API}/users`, { headers: authH() });
    const j = await r.json();
    if (!j.success) return;
    allUsers = j.data || [];
    populateUserSelects();
  } catch(e) {}
}

async function loadTodos() {
  try {
    const r = await fetch(`${API}/todos`, { headers: authH() });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    allTodos = j.data || [];
    renderStats();
    renderBoard();
  } catch(e) { showErr('Gagal memuat: ' + e.message); }
}

function populateUserSelects() {
  const opts = '<option value="">— Unassigned —</option>' +
    allUsers.map(u => `<option value="${u.id}">${esc(u.name||u.email)}</option>`).join('');
  ['f_assigned_to','filterAssignee'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === 'filterAssignee') {
        el.innerHTML = '<option value="">Semua Assignee</option>' +
          allUsers.map(u => `<option value="${u.id}">${esc(u.name||u.email)}</option>`).join('');
      } else {
        el.innerHTML = opts;
      }
    }
  });
}

/* ═══════════════════════════════════════
   STATS
════════════════════════════════════════ */
function renderStats() {
  const total      = allTodos.length;
  const todoCount  = allTodos.filter(t=>t.status==='todo').length;
  const progCount  = allTodos.filter(t=>t.status==='in_progress').length;
  const doneCount  = allTodos.filter(t=>t.status==='done').length;
  const today      = new Date().toISOString().slice(0,10);
  const overdue    = allTodos.filter(t=>t.due_date && t.due_date < today && t.status!=='done').length;

  setText('scTotal',    total);
  setText('scTodo',     todoCount);
  setText('scProgress', progCount);
  setText('scDone',     doneCount);

  setText('scTotalPct',    overdue > 0 ? `${overdue} overdue` : 'Tidak ada overdue');
  setText('scTodoPct',     total ? Math.round(todoCount/total*100)+'% dari total' : '—');
  setText('scProgressPct', total ? Math.round(progCount/total*100)+'% dari total' : '—');
  setText('scDonePct',     total ? Math.round(doneCount/total*100)+'% selesai' : '—');

  setBar('scTodoBar',     total ? todoCount/total*100  : 0);
  setBar('scProgressBar', total ? progCount/total*100  : 0);
  setBar('scDoneBar',     total ? doneCount/total*100  : 0);

  setText('todoHeaderSub',  `${total} task · ${todoCount} pending · ${progCount} in progress · ${doneCount} selesai`);
  setText('totalTasksLbl',  `${getFiltered().length} task ditampilkan`);

  // Sidebar badge
  const badge = document.getElementById('todo-count');
  const pending = todoCount + progCount;
  if (badge) {
    badge.textContent = pending;
    badge.style.display = pending > 0 ? 'inline-flex' : 'none';
  }
}

function setText(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }
function setBar(id, pct)   { const el=document.getElementById(id); if(el) el.style.width=pct+'%'; }

/* ═══════════════════════════════════════
   FILTER
════════════════════════════════════════ */
function getFiltered() {
  let list = [...allTodos];
  if (activeFilter.status)   list = list.filter(t => t.status === activeFilter.status);
  if (activeFilter.priority) list = list.filter(t => t.priority === activeFilter.priority);
  if (activeFilter.assignee) list = list.filter(t => String(t.assigned_to) === String(activeFilter.assignee));
  return list;
}

function filterByStatus(status) {
  activeFilter.status = status;
  updateFilterUI();
  renderBoard();
  setText('totalTasksLbl', `${getFiltered().length} task ditampilkan`);
}

function clearFilter() {
  activeFilter = { status: '', priority: '', assignee: '' };
  document.getElementById('filterAssignee').value = '';
  document.getElementById('filterPriority').value = '';
  updateFilterUI();
  renderBoard();
}

function updateFilterUI() {
  const hasFilter = activeFilter.status || activeFilter.priority || activeFilter.assignee;
  const btn   = document.getElementById('clearFilterBtn');
  const label = document.getElementById('boardFilterLabel');
  if (btn)   btn.style.display   = hasFilter ? 'inline-flex' : 'none';
  if (label) {
    if (activeFilter.status) {
      const map = {todo:'To Do',in_progress:'In Work',done:'Done'};
      label.textContent = '· Filter: ' + (map[activeFilter.status]||activeFilter.status);
    } else {
      label.textContent = '';
    }
  }
}

/* ═══════════════════════════════════════
   RENDER BOARD
════════════════════════════════════════ */
function renderBoard() {
  const filtered = getFiltered();
  const cols = ['todo','in_progress','done'];

  cols.forEach(status => {
    const cards = filtered.filter(t => t.status === status);
    const container = document.getElementById('cards-' + status);
    const countEl   = document.getElementById('count-' + status);
    if (!container) return;
    if (countEl) countEl.textContent = cards.length;

    if (!cards.length) {
      container.innerHTML = `
        <div class="kanban-empty">
          <svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 9h6M9 13h4"/>
          </svg>
          ${status==='todo' ? 'Tidak ada task pending' : status==='in_progress' ? 'Tidak ada task in progress' : 'Belum ada task selesai'}
        </div>`;
      return;
    }
    container.innerHTML = cards.map(t => buildTaskCard(t)).join('');
  });

  setText('totalTasksLbl', `${filtered.length} task ditampilkan`);
}

function buildTaskCard(t) {
  const today    = new Date().toISOString().slice(0,10);
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);

  let dueHtml = '';
  if (t.due_date) {
    let cls = '', label = formatDate(t.due_date);
    if (t.status !== 'done') {
      if (t.due_date < today)    { cls='overdue'; label='⚠ '+label; }
      else if (t.due_date <= tomorrow) { cls='soon'; }
    }
    dueHtml = `<span class="task-due ${cls}">
      <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      ${label}
    </span>`;
  }

  const assignee = t.assignee;
  let avatarHtml = '';
  if (assignee) {
    const initials = (assignee.name||assignee.email||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
    avatarHtml = `<div class="task-avatar" title="${esc(assignee.name||assignee.email)}">${initials}</div>`;
  } else {
    avatarHtml = `<div class="task-avatar unassigned" title="Unassigned">
      <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    </div>`;
  }

  const prio = t.priority || 'medium';
  const prioLabel = {low:'LOW',medium:'MEDIUM',high:'HIGH',critical:'CRITICAL'}[prio]||prio.toUpperCase();

  return `
  <div class="task-card" id="tc-${t.id}"
    draggable="true"
    ondragstart="onDragStart(event,${t.id})"
    ondragend="onDragEnd(event)">
    <div class="task-card-top">
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-actions">
        <button class="ta-btn ta-edit" onclick="openEdit(${t.id});event.stopPropagation()" title="Edit">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="ta-btn ta-del" onclick="openDelete(${t.id},'${esc(t.title)}');event.stopPropagation()" title="Hapus">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
    ${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ''}
    <div class="task-meta">
      <div class="task-meta-left">
        <span class="prio prio-${prio}">${prioLabel}</span>
        ${dueHtml}
      </div>
      ${avatarHtml}
    </div>
  </div>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day:'2-digit', month:'short' });
}

/* ═══════════════════════════════════════
   DRAG & DROP
════════════════════════════════════════ */
function onDragStart(e, id) {
  draggingId = id;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    const el = document.getElementById('tc-' + id);
    if (el) el.classList.add('dragging');
  }, 0);
}
function onDragEnd(e) {
  document.querySelectorAll('.task-card.dragging').forEach(el=>el.classList.remove('dragging'));
  document.querySelectorAll('.kanban-col').forEach(el=>el.classList.remove('drag-over'));
}
function onDragOver(e, status) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.kanban-col').forEach(el=>el.classList.remove('drag-over'));
  document.getElementById('col-' + status)?.classList.add('drag-over');
}
function onDragLeave(e) {
  const col = e.currentTarget;
  if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
}
async function onDrop(e, newStatus) {
  e.preventDefault();
  document.querySelectorAll('.kanban-col').forEach(el=>el.classList.remove('drag-over'));
  if (!draggingId) return;
  const todo = allTodos.find(t=>t.id===draggingId);
  if (!todo || todo.status === newStatus) return;

  try {
    const r = await fetch(`${API}/todos/${draggingId}/status`, {
      method: 'PATCH', headers: authH(),
      body: JSON.stringify({ status: newStatus })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    await loadTodos();
  } catch(e) { showErr('Gagal memindahkan: ' + e.message); }
  draggingId = null;
}

/* ═══════════════════════════════════════
   MODAL
════════════════════════════════════════ */
function openAdd(status='todo') {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'Tambah Task Baru';
  document.getElementById('btnSaveTxt').textContent = 'Simpan Task';
  clearForm();
  document.getElementById('f_status').value = status;
  document.getElementById('todoModal').classList.add('active');
  setTimeout(()=>document.getElementById('f_title').focus(), 100);
}

function openEdit(id) {
  const t = allTodos.find(x=>x.id===id);
  if (!t) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Task';
  document.getElementById('btnSaveTxt').textContent = 'Simpan Perubahan';
  fillForm(t);
  document.getElementById('todoModal').classList.add('active');
}

function closeModal() {
  document.getElementById('todoModal').classList.remove('active');
  editingId = null;
}

function clearForm() {
  document.getElementById('f_title').value       = '';
  document.getElementById('f_description').value = '';
  document.getElementById('f_status').value      = 'todo';
  document.getElementById('f_priority').value    = 'medium';
  document.getElementById('f_due_date').value    = '';
  document.getElementById('f_assigned_to').value = '';
}

function fillForm(t) {
  document.getElementById('f_title').value       = t.title || '';
  document.getElementById('f_description').value = t.description || '';
  document.getElementById('f_status').value      = t.status || 'todo';
  document.getElementById('f_priority').value    = t.priority || 'medium';
  document.getElementById('f_due_date').value    = t.due_date || '';
  document.getElementById('f_assigned_to').value = t.assigned_to || '';
}

/* ═══════════════════════════════════════
   SAVE
════════════════════════════════════════ */
async function saveTask() {
  const title       = document.getElementById('f_title').value.trim();
  const description = document.getElementById('f_description').value.trim();
  const status      = document.getElementById('f_status').value;
  const priority    = document.getElementById('f_priority').value;
  const due_date    = document.getElementById('f_due_date').value || null;
  const assigned_to = document.getElementById('f_assigned_to').value || null;

  if (!title) return showErr('Judul task wajib diisi');

  const btn = document.getElementById('btnSaveTask');
  btn.disabled = true;
  document.getElementById('btnSaveTxt').textContent = 'Menyimpan…';

  try {
    const url    = editingId ? `${API}/todos/${editingId}` : `${API}/todos`;
    const method = editingId ? 'PUT' : 'POST';
    const r = await fetch(url, {
      method, headers: authH(),
      body: JSON.stringify({ title, description, status, priority, due_date, assigned_to })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    closeModal();
    showOk(editingId ? 'Task berhasil diperbarui' : 'Task baru berhasil dibuat');
    await loadTodos();
  } catch(e) { showErr('Gagal: ' + e.message); }
  finally {
    btn.disabled = false;
    document.getElementById('btnSaveTxt').textContent = editingId ? 'Simpan Perubahan' : 'Simpan Task';
  }
}

/* ═══════════════════════════════════════
   DELETE
════════════════════════════════════════ */
function openDelete(id, title) {
  deletingId = id;
  document.getElementById('delMsg').innerHTML =
    `Task <strong>${esc(title)}</strong> akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.`;
  document.getElementById('delModal').classList.add('active');
}
function closeDelModal() {
  document.getElementById('delModal').classList.remove('active');
  deletingId = null;
}
async function confirmDelete() {
  if (!deletingId) return;
  try {
    const r = await fetch(`${API}/todos/${deletingId}`, { method:'DELETE', headers: authH() });
    const j = await r.json();
    if (!j.success) throw new Error(j.message);
    closeDelModal();
    showOk('Task berhasil dihapus');
    await loadTodos();
  } catch(e) { showErr('Gagal: ' + e.message); }
}

/* ═══════════════════════════════════════
   INIT
════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Close modals on overlay click
  document.getElementById('todoModal')?.addEventListener('click', e=>{
    if (e.target===document.getElementById('todoModal')) closeModal();
  });
  document.getElementById('delModal')?.addEventListener('click', e=>{
    if (e.target===document.getElementById('delModal')) closeDelModal();
  });

  // Filters
  document.getElementById('filterAssignee')?.addEventListener('change', e=>{
    activeFilter.assignee = e.target.value;
    updateFilterUI(); renderBoard();
  });
  document.getElementById('filterPriority')?.addEventListener('change', e=>{
    activeFilter.priority = e.target.value;
    updateFilterUI(); renderBoard();
  });

  // Enter to submit modal
  document.getElementById('f_title')?.addEventListener('keydown', e=>{
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); saveTask(); }
  });

  loadAll();
});