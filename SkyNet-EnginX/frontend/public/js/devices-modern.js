/* ================================================
   DEVICES MODERN - JavaScript
   Handles device management with modern UI
   ================================================ */

let currentDeviceId = null;
let devicesData = [];

// ─── LOAD DEVICES LIST ────────────────────────────
async function loadDeviceList() {
  try {
    // Load stats
    const statsRes = await App.api('/devices/stats');
    if (statsRes?.success) {
      updateStats(statsRes.data);
    }
    
    // Load devices list
    const devicesRes = await App.api('/devices');
    if (devicesRes?.success) {
      devicesData = devicesRes.data || [];
      renderDeviceTable(devicesData);
    }
  } catch (err) {
    console.error('Error loading devices:', err);
    App.showToast('Failed to load devices', 'error');
  }
}

// ─── UPDATE STATISTICS WITH ANIMATION ─────────────
function updateStats(stats) {
  const { online = 0, offline = 0, warning = 0, total = 0 } = stats;
  
  // Update numbers
  document.getElementById('dOnline').textContent = online;
  document.getElementById('dOffline').textContent = offline;
  document.getElementById('dWarning').textContent = warning;
  document.getElementById('dTotal').textContent = total;
  
  // Animate circular gauges
  animateGauge('gaugeOnline', total > 0 ? (online / total) * 100 : 0);
  animateGauge('gaugeOffline', total > 0 ? (offline / total) * 100 : 0);
  animateGauge('gaugeWarning', total > 0 ? (warning / total) * 100 : 0);
  animateGauge('gaugeTotal', 100);
}

function animateGauge(id, percent) {
  const circle = document.getElementById(id);
  if (!circle) return;
  
  const circumference = 251.2; // 2 * PI * 40
  const offset = circumference - (percent / 100 * circumference);
  
  setTimeout(() => {
    circle.style.strokeDashoffset = offset;
  }, 100);
}

// ─── RENDER DEVICE TABLE ──────────────────────────
function renderDeviceTable(devices) {
  const tbody = document.getElementById('deviceTable');
  const emptyState = document.getElementById('emptyState');
  
  if (!devices || devices.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }
  
  if (emptyState) emptyState.style.display = 'none';
  
  tbody.innerHTML = devices.map(device => `
    <tr>
      <td>
        <span class="status-badge ${device.status}">
          <span class="status-dot"></span>
          ${capitalize(device.status)}
        </span>
      </td>
      <td>
        <div>
          <div style="font-weight: 500;">${escHtml(device.name)}</div>
          <div style="font-size: 0.75rem; color: var(--text-tertiary); margin-top: 0.25rem;">
            ${escHtml(device.model || 'N/A')}
          </div>
        </div>
      </td>
      <td>
        <code style="font-size: 0.875rem; color: var(--text-secondary);">
          ${escHtml(device.ip_address)}
        </code>
      </td>
      <td>
        <span class="type-badge">${escHtml(device.type || 'Unknown')}</span>
      </td>
      <td>
        <div class="resource-bar">
          <span class="resource-value">${device.cpu_load || 0}%</span>
          <div class="progress-bar-container">
            <div class="progress-bar-fill ${getResourceClass(device.cpu_load)}" 
                 style="width: ${Math.min(device.cpu_load || 0, 100)}%"></div>
          </div>
        </div>
      </td>
      <td>
        <div class="resource-bar">
          <span class="resource-value">${device.memory_usage || 0}%</span>
          <div class="progress-bar-container">
            <div class="progress-bar-fill ${getResourceClass(device.memory_usage)}" 
                 style="width: ${Math.min(device.memory_usage || 0, 100)}%"></div>
          </div>
        </div>
      </td>
      <td>
        <span style="font-size: 0.875rem; color: var(--text-secondary);">
          ${device.uptime || '-'}
        </span>
      </td>
      <td>
        <div class="action-buttons">
          <button class="btn-action" onclick="editDevice(${device.id})" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
            Edit
          </button>
          <button class="btn-action danger" onclick="deleteDevice(${device.id}, '${escHtml(device.name)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ─── FILTER/SEARCH DEVICES ────────────────────────
function filterDevices() {
  const searchTerm = document.getElementById('searchDevices').value.toLowerCase();
  
  if (!searchTerm) {
    renderDeviceTable(devicesData);
    return;
  }
  
  const filtered = devicesData.filter(device => 
    device.name.toLowerCase().includes(searchTerm) ||
    device.ip_address.includes(searchTerm) ||
    (device.type && device.type.toLowerCase().includes(searchTerm)) ||
    (device.model && device.model.toLowerCase().includes(searchTerm))
  );
  
  renderDeviceTable(filtered);
}

// ─── MODAL FUNCTIONS ──────────────────────────────
function openAddDevice() {
  currentDeviceId = null;
  document.getElementById('deviceModalTitle').textContent = 'Add New Device';
  document.getElementById('deviceForm').reset();
  document.getElementById('deviceId').value = '';
  document.getElementById('deviceModal').classList.add('active');
}

function editDevice(id) {
  const device = devicesData.find(d => d.id === id);
  if (!device) return;
  
  currentDeviceId = id;
  document.getElementById('deviceModalTitle').textContent = 'Edit Device';
  document.getElementById('deviceId').value = id;
  document.getElementById('devName').value = device.name || '';
  document.getElementById('devIP').value = device.ip_address || '';
  document.getElementById('devType').value = device.type || 'router';
  document.getElementById('devLocation').value = device.location || '';
  document.getElementById('devModel').value = device.model || '';
  document.getElementById('devUsername').value = device.username || '';
  document.getElementById('devPort').value = device.api_port || 8728;
  document.getElementById('devProtocol').value = device.protocol || 'api';
  document.getElementById('devTimeout').value = device.timeout || 30;
  document.getElementById('devDescription').value = device.description || '';
  document.getElementById('devMonitoring').checked = device.monitoring !== false;
  document.getElementById('devAlerts').checked = device.alerts !== false;
  
  document.getElementById('deviceModal').classList.add('active');
}

function closeDeviceModal() {
  document.getElementById('deviceModal').classList.remove('active');
  currentDeviceId = null;
}

// ─── SAVE DEVICE ──────────────────────────────────
async function saveDevice() {
  const deviceData = {
    name: document.getElementById('devName').value.trim(),
    ip_address: document.getElementById('devIP').value.trim(),
    type: document.getElementById('devType').value,
    location: document.getElementById('devLocation').value.trim(),
    model: document.getElementById('devModel').value.trim(),
    username: document.getElementById('devUsername').value.trim(),
    password: document.getElementById('devPassword').value,
    api_port: parseInt(document.getElementById('devPort').value) || 8728,
    protocol: document.getElementById('devProtocol').value,
    timeout: parseInt(document.getElementById('devTimeout').value) || 30,
    description: document.getElementById('devDescription').value.trim(),
    monitoring: document.getElementById('devMonitoring').checked,
    alerts: document.getElementById('devAlerts').checked
  };
  
  // Validation
  if (!deviceData.name) {
    App.showToast('Device name is required', 'error');
    return;
  }
  
  if (!deviceData.ip_address) {
    App.showToast('IP address is required', 'error');
    return;
  }
  
  try {
    const endpoint = currentDeviceId ? `/devices/${currentDeviceId}` : '/devices';
    const method = currentDeviceId ? 'PUT' : 'POST';
    
    const res = await App.api(endpoint, { method, body: deviceData });
    
    if (res?.success) {
      App.showToast(
        currentDeviceId ? 'Device updated successfully' : 'Device added successfully',
        'success'
      );
      closeDeviceModal();
      loadDeviceList();
    } else {
      App.showToast(res?.message || 'Failed to save device', 'error');
    }
  } catch (err) {
    console.error('Error saving device:', err);
    App.showToast('Failed to save device', 'error');
  }
}

// ─── DELETE DEVICE ────────────────────────────────
async function deleteDevice(id, name) {
  if (!confirm(`Are you sure you want to delete device "${name}"?`)) {
    return;
  }
  
  try {
    const res = await App.api(`/devices/${id}`, { method: 'DELETE' });
    
    if (res?.success) {
      App.showToast('Device deleted successfully', 'success');
      loadDeviceList();
    } else {
      App.showToast(res?.message || 'Failed to delete device', 'error');
    }
  } catch (err) {
    console.error('Error deleting device:', err);
    App.showToast('Failed to delete device', 'error');
  }
}

// ─── HELPER FUNCTIONS ─────────────────────────────
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getResourceClass(value) {
  if (!value) return 'low';
  if (value < 60) return 'low';
  if (value < 80) return 'medium';
  return 'high';
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────
document.addEventListener('keydown', (e) => {
  // ESC to close modal
  if (e.key === 'Escape') {
    const modal = document.getElementById('deviceModal');
    if (modal && modal.classList.contains('active')) {
      closeDeviceModal();
    }
  }
  
  // Ctrl/Cmd + K to focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('searchDevices')?.focus();
  }
});

// ─── CLOSE MODAL ON BACKGROUND CLICK ──────────────
document.getElementById('deviceModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'deviceModal') {
    closeDeviceModal();
  }
});

// ─── INIT ON PAGE LOAD ────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadDeviceList();
  
  // Auto-refresh every 30 seconds
  setInterval(loadDeviceList, 30000);
});
