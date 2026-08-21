// users.js — User Management Frontend

let _roles = [];
let _editUserId = null;

window.openAddUser    = openAddUser;
window.closeUserModal = closeUserModal;
window.saveUser       = saveUser;
window.editUser       = editUser;
window.deleteUser     = deleteUser;
window.toggleStatus   = toggleStatus;

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadRoles().then(() => loadUsers());
});

// ── LOAD ROLES ───────────────────────────────────────────────
async function loadRoles() {
  const d = await App.api('/roles');
  if (d?.success) _roles = d.data;
}

// ── LOAD USERS ───────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('userTable');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#94a3b8;">Memuat...</td></tr>';

  const d = await App.api('/users?limit=100');
  if (!d?.success) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#ef4444;">Gagal memuat: ${d?.message || 'error'}</td></tr>`;
    return;
  }

  if (!d.data?.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#94a3b8;">Belum ada user</td></tr>';
    return;
  }

  tbody.innerHTML = d.data.map(u => {
    const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const statusBadge = u.is_active
      ? '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;">Aktif</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;">Nonaktif</span>';

    return `<tr>
      <td>
        <div style="font-weight:500;">${esc(u.name)}</div>
        <div style="font-size:11px;color:#94a3b8;">${esc(u.phone || '')}</div>
      </td>
      <td>${esc(u.email)}</td>
      <td><span style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;">${esc(u.role?.display_name || u.role?.name || '—')}</span></td>
      <td>${statusBadge}</td>
      <td style="font-size:12px;color:#64748b;">${lastLogin}</td>
      <td>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-secondary" onclick="editUser(${u.id})">Edit</button>
          <button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;" onclick="toggleStatus(${u.id}, ${u.is_active})">${u.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, '${esc(u.name)}')">Hapus</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── MODAL ────────────────────────────────────────────────────
function openAddUser() {
  _editUserId = null;
  document.getElementById('userModalTitle').textContent = 'Tambah User';
  document.getElementById('userForm').reset();
  document.getElementById('passwordGroup').style.display = 'block';
  document.getElementById('passwordField').required = true;
  document.getElementById('passwordField').placeholder = 'Minimal 6 karakter';
  populateRoleSelect();
  document.getElementById("userModal").style.display = "flex";
}

function closeUserModal() {
  document.getElementById("userModal").style.display = "none";
}

async function editUser(id) {
  const d = await App.api(`/users/${id}`);
  if (!d?.success) { App.showToast('Gagal load user', 'error'); return; }
  const u = d.data;
  _editUserId = id;
  document.getElementById('userModalTitle').textContent = 'Edit User';
  document.getElementById('userName').value    = u.name;
  document.getElementById('userEmail').value   = u.email;
  document.getElementById('userPhone').value   = u.phone || '';
  document.getElementById('passwordGroup').style.display = 'block';
  document.getElementById('passwordField').required = false;
  document.getElementById('passwordField').placeholder = 'Kosongkan jika tidak diubah';
  document.getElementById('passwordField').value = '';
  populateRoleSelect(u.role_id);
  document.getElementById("userModal").style.display = "flex";
}

function populateRoleSelect(selectedId = null) {
  const sel = document.getElementById('userRole');
  sel.innerHTML = '<option value="">-- Pilih Role --</option>' +
    _roles.map(r => `<option value="${r.id}" ${r.id == selectedId ? 'selected' : ''}>${esc(r.display_name || r.name)}</option>`).join('');
}

async function saveUser() {
  const name     = document.getElementById('userName').value.trim();
  const email    = document.getElementById('userEmail').value.trim();
  const phone    = document.getElementById('userPhone').value.trim();
  const password = document.getElementById('passwordField').value;
  const role_id  = document.getElementById('userRole').value;

  if (!name || !email || !role_id) { App.showToast('Nama, email, dan role wajib diisi', 'error'); return; }
  if (!_editUserId && !password)   { App.showToast('Password wajib untuk user baru', 'error'); return; }

  const payload = { name, email, phone, role_id: parseInt(role_id) };
  if (password) payload.password = password;

  const url    = _editUserId ? `/users/${_editUserId}` : '/users';
  const method = _editUserId ? 'PUT' : 'POST';

  const d = await App.api(url, { method, body: JSON.stringify(payload) });
  if (d?.success) {
    closeUserModal();
    loadUsers();
    App.showToast(_editUserId ? 'User diperbarui' : 'User ditambahkan', 'success');
  } else {
    App.showToast(d?.message || 'Gagal menyimpan', 'error');
  }
}

async function toggleStatus(id, currentStatus) {
  const d = await App.api(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !currentStatus }) });
  if (d?.success) { loadUsers(); App.showToast('Status diperbarui', 'success'); }
  else App.showToast(d?.message || 'Gagal', 'error');
}

async function deleteUser(id, name) {
  if (!confirm(`Hapus user "${name}"?`)) return;
  const d = await App.api(`/users/${id}`, { method: 'DELETE' });
  if (d?.success) { loadUsers(); App.showToast('User dihapus', 'success'); }
  else App.showToast(d?.message || 'Gagal menghapus', 'error');
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}