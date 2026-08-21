// devices.js - Device Management CRUD
let editingDeviceId = null;

document.addEventListener('DOMContentLoaded', () => {
  loadDeviceStats();
  loadDeviceList();

  document.getElementById('saveDeviceBtn').addEventListener('click', saveDevice);

  // Handle edit param dari URL (redirect lama)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('edit')) {
    editDevice(parseInt(urlParams.get('edit')));
    window.history.replaceState({}, '', '/devices');
  }
});

async function loadDeviceStats() {
  const d = await App.api('/devices/stats');
  if (d?.success) {
    setText('dOnline',  d.data.online  || 0);
    setText('dOffline', d.data.offline || 0);
    setText('dWarning', d.data.warning || 0);
    setText('dTotal',   d.data.total   || 0);
  }
}

async function loadDeviceList() {
  const data = await App.api('/devices?limit=100');
  const tbody = document.getElementById('deviceTable');
  if (!data?.success || !data.data?.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8;">No devices found. Click "Add Device" to add one.</td></tr>';
    return;
  }
  tbody.innerHTML = data.data.map(d => `
    <tr>
      <td><span class="status-dot ${d.status === 'online' ? 'online' : d.status === 'warning' ? 'warning' : 'offline'}"></span></td>
      <td>
        <strong>${esc(d.name)}</strong>
        <div style="font-size:11px;color:#94a3b8;">${esc(d.brand || '')} ${esc(d.model || '')}</div>
      </td>
      <td><code style="font-size:12px;">${esc(d.ip_address)}</code></td>
      <td><span class="badge badge-info">${esc(d.type)}</span></td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:50px;height:5px;background:#f1f5f9;border-radius:3px;overflow:hidden;">
            <div style="width:${d.cpu_load||0}%;height:100%;background:${(d.cpu_load||0)>80?'#ef4444':(d.cpu_load||0)>60?'#f59e0b':'#22c55e'};border-radius:3px;"></div>
          </div>
          <span style="font-size:12px;">${d.cpu_load||0}%</span>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:50px;height:5px;background:#f1f5f9;border-radius:3px;overflow:hidden;">
            <div style="width:${d.memory_usage||0}%;height:100%;background:${(d.memory_usage||0)>80?'#ef4444':(d.memory_usage||0)>60?'#f59e0b':'#22c55e'};border-radius:3px;"></div>
          </div>
          <span style="font-size:12px;">${d.memory_usage||0}%</span>
        </div>
      </td>
      <td style="font-size:12px;color:#64748b;">${esc(d.uptime||'-')}</td>
      <td>
        <div style="display:flex;gap:4px;">
          <button class="btn btn-sm btn-secondary" onclick="editDevice(${d.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDevice(${d.id},'${esc(d.name)}')">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function openAddDevice() {
  editingDeviceId = null;
  document.getElementById('deviceModalTitle').textContent = 'Add Device';
  document.getElementById('deviceForm').reset();
  document.getElementById('devSnmp').value = 'public';
  document.getElementById('devPollInterval').value = '60';
  document.getElementById('devSnmpPort').value = '161';
  document.getElementById('devSnmpVersion').value = '2';
  document.getElementById('deviceModal').classList.add('active');
}

async function editDevice(id) {
  const data = await App.api(`/devices/${id}`);
  if (!data?.success) return;
  const d = data.data;
  editingDeviceId = d.id;
  document.getElementById('deviceModalTitle').textContent = 'Edit Device';
  document.getElementById('devName').value          = d.name           || '';
  document.getElementById('devIP').value            = d.ip_address     || '';
  document.getElementById('devType').value          = d.type           || 'router';
  document.getElementById('devBrand').value         = d.brand          || '';
  document.getElementById('devModel').value         = d.model          || '';
  document.getElementById('devLocation').value      = d.location       || '';
  document.getElementById('devMonType').value       = d.monitoring_type|| 'snmp';
  document.getElementById('devSnmp').value          = d.snmp_community || 'public';
  document.getElementById('devSnmpPort').value      = d.snmp_port      || 161;
  document.getElementById('devSnmpVersion').value   = d.snmp_version   || 2;
  document.getElementById('devPollInterval').value  = d.poll_interval  || 60;
  document.getElementById('devActive').value        = d.is_active ? 'true' : 'false';
  document.getElementById('deviceModal').classList.add('active');
}

async function saveDevice() {
  const btn = document.getElementById('saveDeviceBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  const body = {
    name:             document.getElementById('devName').value,
    ip_address:       document.getElementById('devIP').value,
    type:             document.getElementById('devType').value,
    brand:            document.getElementById('devBrand').value,
    model:            document.getElementById('devModel').value,
    location:         document.getElementById('devLocation').value,
    monitoring_type:  document.getElementById('devMonType').value,
    snmp_community:   document.getElementById('devSnmp').value,
    snmp_port:        parseInt(document.getElementById('devSnmpPort').value) || 161,
    snmp_version:     parseInt(document.getElementById('devSnmpVersion').value) || 2,
    poll_interval:    parseInt(document.getElementById('devPollInterval').value) || 60,
    is_active:        document.getElementById('devActive').value === 'true'
  };

  if (!body.name || !body.ip_address) {
    App.showToast('Name and IP address are required', 'error');
    btn.disabled = false; btn.textContent = 'Save Device';
    return;
  }

  const url    = editingDeviceId ? `/devices/${editingDeviceId}` : '/devices';
  const method = editingDeviceId ? 'PUT' : 'POST';
  const data   = await App.api(url, { method, body: JSON.stringify(body) });

  if (data?.success) {
    closeDeviceModal();
    loadDeviceList();
    loadDeviceStats();
    App.showToast(editingDeviceId ? 'Device updated' : 'Device added', 'success');
  } else {
    App.showToast(data?.message || 'Error saving device', 'error');
  }
  btn.disabled = false; btn.textContent = 'Save Device';
}

async function deleteDevice(id, name) {
  if (!confirm(`Delete device "${name}"?`)) return;
  const data = await App.api(`/devices/${id}`, { method: 'DELETE' });
  if (data?.success) {
    loadDeviceList();
    loadDeviceStats();
    App.showToast('Device deleted', 'success');
  } else {
    App.showToast(data?.message || 'Error', 'error');
  }
}

function closeDeviceModal() {
  document.getElementById('deviceModal').classList.remove('active');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
