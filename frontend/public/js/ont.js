/**
 * ont.js - ONT Monitoring Frontend
 * Dashboard monitoring ONT via GenieACS
 * Features: realtime status, signal chart, parameter view, task management
 */

const OntPage = (() => {

  // ── State ──────────────────────────────────────────────
  let currentPage    = 1;
  let currentLimit   = 20;
  let currentFilters = { status: '', search: '' };
  let currentOntId   = null;
  let signalChart    = null;
  let allParams      = [];
  let customers      = [];
  let socket         = null;
  let debounceTimer  = null;

  // ── Init ───────────────────────────────────────────────
  function init() {
    loadStats();
    loadONTs();
    loadCustomers();
    initSocket();
  }

  // ── Socket.IO realtime ─────────────────────────────────
  function initSocket() {
    const token = App.getToken ? App.getToken() : localStorage.getItem('token');
    if (!token) return;

    socket = io({ auth: { token } });

    socket.on('connect', () => {
      socket.emit('monitoring:subscribe');
      socket.emit('ont:subscribe');
    });

    socket.on('ont:sync_complete', (data) => {
      loadStats();
      loadONTs();
      showToast(`Sync selesai — ${data.stats?.offline || 0} ONT offline`, 'info');
    });

    socket.on('ont:offline_count', (count) => {
      const badge = document.getElementById('ont-offline-badge');
      if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline-flex' : 'none';
      }
    });

    socket.on('notification:new', (notif) => {
      if (notif.type === 'ont_offline') {
        showToast(notif.message, 'warning');
        loadStats();
      }
    });
  }

  // ── Stats ──────────────────────────────────────────────
  async function loadStats() {
    try {
      const data = await App.api('/ont/stats');
      if (!data?.success) return;
      const s = data.data;
      setText('stat-total',       s.total);
      setText('stat-online',      s.online);
      setText('stat-offline',     s.offline);
      setText('stat-warning',     s.warning);
      setText('stat-unassigned',  s.unassigned);
      setText('stat-uptime-pct',  `${s.onlinePercent}%`);

      // Update sidebar badge
      const badge = document.getElementById('ont-offline-badge');
      if (badge) {
        badge.textContent = s.offline;
        badge.style.display = s.offline > 0 ? 'inline-flex' : 'none';
      }
    } catch (e) {
      console.error('loadStats error:', e);
    }
  }

  // ── ONT List ───────────────────────────────────────────
  async function loadONTs(page = currentPage) {
    currentPage = page;
    const tbody = document.getElementById('ont-table-body');
    tbody.innerHTML = `<tr><td colspan="10"><div class="tbl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.3;margin-bottom:8px;animation:spin 1s linear infinite"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
      <p>Memuat data ONT...</p></div></td></tr>`;

    try {
      const params = new URLSearchParams({
        page: currentPage,
        limit: currentLimit,
        ...(currentFilters.status && { status: currentFilters.status }),
        ...(currentFilters.search && { search: currentFilters.search })
      });

      const data = await App.api(`/ont?${params}`);
      if (!data?.success) throw new Error(data?.message || 'Gagal memuat data');

      // paginateResponse menyimpan info di data.pagination
      const pg    = data.pagination || {};
      const total = pg.total      || data.total      || data.data?.length || 0;
      const page  = pg.page       || data.page       || currentPage;
      const pages = pg.totalPages || data.totalPages || 1;

      renderTable(data.data);
      renderPagination(total, page, pages);
      document.getElementById('ont-count-label').textContent =
        `${data.data.length} dari ${total} ONT`;

    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--ot-red);">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        ${e.message}</td></tr>`;
    }
  }

  function renderTable(onts) {
    const tbody = document.getElementById('ont-table-body');
    if (!onts.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--faint);">
        Tidak ada ONT ditemukan</td></tr>`;
      return;
    }

    tbody.innerHTML = onts.map((ont, idx) => {
      const statusBadge = `<span class="status-pill pill-${ont.status}"><span class="sdot"></span>${statusLabel(ont.status)}</span>`;
      const signalHtml  = renderSignalBar(ont.signal_strength);
      const customerHtml = ont.customer
        ? `<div style="font-size:13px;font-weight:500;">${escHtml(ont.customer.name)}</div>
           <div style="font-size:11px;color:var(--faint);">${escHtml(ont.customer.customer_id)}</div>`
        : `<span style="color:var(--faint);font-size:12px;">–</span>`;

      const lastInform = ont.last_inform
        ? `<div style="font-size:12px;">${timeAgo(ont.last_inform)}</div>
           <div style="font-size:10px;color:var(--faint);">${fmtDate(ont.last_inform)}</div>`
        : '—';

      return `<tr onclick="OntPage.openDetail(${ont.id})">
        <td class="num-cell">${idx + 1}</td>
        <td><span class="sn-badge">${escHtml(ont.serial_number)}</span></td>
        <td>${customerHtml}</td>
        <td class="model-cell">${escHtml((ont.manufacturer||'') + ' ' + (ont.model||'')).trim() || '—'}</td>
        <td>${statusBadge}</td>
        <td>${signalHtml}</td>
        <td><span class="ip-badge">${escHtml(ont.ip_address || '—')}</span></td>
        <td>${lastInform}</td>
        <td class="uptime-cell">${escHtml(ont.uptime || '—')}</td>
        <td onclick="event.stopPropagation()">
          <div class="act-btns">
            <button class="act-btn act-detail" title="Detail" onclick="OntPage.openDetail(${ont.id})">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            ${ont.device_id ? `<button class="act-btn act-reboot" title="Reboot" onclick="OntPage.quickReboot(${ont.id},'${escHtml(ont.serial_number)}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function renderSignalBar(rxPower) {
    if (rxPower === null || rxPower === undefined) {
      return `<div class="signal-wrap signal-none">
        <div class="signal-track"><div class="signal-fill" style="width:0"></div></div>
        <span class="signal-val" style="color:var(--faint)">—</span>
      </div>`;
    }
    // GPON normal: -8 dBm (excellent) to -28 dBm (critical)
    const pct   = Math.max(0, Math.min(100, ((rxPower + 28) / 20) * 100));
    const cls   = rxPower >= -23 ? 'signal-good' : rxPower >= -27 ? 'signal-warn' : 'signal-bad';
    const color = rxPower >= -23 ? 'var(--ot-green)' : rxPower >= -27 ? 'var(--ot-amber)' : 'var(--ot-red)';
    return `<div class="signal-wrap ${cls}">
      <div class="signal-track"><div class="signal-fill" style="width:${pct}%"></div></div>
      <span class="signal-val" style="color:${color}">${rxPower.toFixed(1)} dBm</span>
    </div>`;
  }

  // ── Pagination ─────────────────────────────────────────
  function renderPagination(total, page, totalPages) {
    total      = parseInt(total)      || 0;
    page       = parseInt(page)       || 1;
    totalPages = parseInt(totalPages) || 1;

    document.getElementById('pagination-info').textContent =
      `Halaman ${page} dari ${totalPages} (${total} total)`;

    const btns = document.getElementById('pagination-btns');
    btns.innerHTML = '';
    if (totalPages <= 1) return;

    const addBtn = (label, p, disabled = false) => {
      const b = document.createElement('button');
      b.className = `pg-btn${p === page ? ' active' : ''}`;
      b.textContent = label;
      b.disabled = disabled;
      b.onclick = () => loadONTs(p);
      btns.appendChild(b);
    };

    addBtn('‹', page - 1, page <= 1);
    const start = Math.max(1, page - 2);
    const end   = Math.min(totalPages, page + 2);
    for (let i = start; i <= end; i++) addBtn(i, i);
    addBtn('›', page + 1, page >= totalPages);
  }

  // ── Filter ─────────────────────────────────────────────
  function setFilter(key, value) {
    currentFilters[key] = value;
    currentPage = 1;

    // Update chip active state
    if (key === 'status') {
      document.querySelectorAll('[data-status]').forEach(el => {
        el.classList.toggle('active', el.dataset.status === value);
      });
    }
    loadONTs(1);
  }

  function debounceLoad() {
    clearTimeout(debounceTimer);
    const val = document.getElementById('ont-search').value;
    debounceTimer = setTimeout(() => {
      currentFilters.search = val;
      loadONTs(1);
    }, 400);
  }

  // ── Detail Modal ───────────────────────────────────────
  async function openDetail(ontId) {
    currentOntId = ontId;
    document.getElementById('modal-detail').classList.add('show');
    resetModal();
    switchTab(document.querySelector('.tab-btn[data-tab="signal"]'), 'signal');

    try {
      const data = await App.api(`/ont/${ontId}`);
      if (!data?.success) throw new Error(data?.message);

      const ont = data.data;
      fillModalInfo(ont);

      // Load signal history sekaligus
      loadSignalHistory(6);

      // Load customer list untuk assign tab
      loadAssignTab(ont);

    } catch (e) {
      showToast('Gagal memuat detail ONT: ' + e.message, 'error');
    }
  }

  function fillModalInfo(ont) {
    document.getElementById('modal-title').textContent = `ONT: ${ont.serial_number}`;
    document.getElementById('modal-subtitle').textContent = `Device ID: ${ont.device_id || '—'}`;

    const statusEl = document.getElementById('modal-status-badge');
    statusEl.className = `status-pill pill-${ont.status}`;
    statusEl.innerHTML = `<span class="sdot"></span>${statusLabel(ont.status)}`;

    setText('d-manufacturer', ont.manufacturer || '—');
    setText('d-model',        ont.model || '—');
    setText('d-firmware',     ont.firmware || '—');
    setText('d-ip',           ont.ip_address || '—');
    setText('d-mac',          ont.mac_address || '—');
    setText('d-uptime',       ont.uptime || '—');
    setText('d-last-inform',  ont.last_inform ? `${fmtDate(ont.last_inform)} (${timeAgo(ont.last_inform)})` : '—');
    setText('d-device-id',    ont.device_id || '—');

    const tr069 = ont.tr069_params || {};
    const rxEl  = document.getElementById('d-rx');
    const txEl  = document.getElementById('d-tx');
    const oltEl = document.getElementById('d-olt-rx');

    if (tr069.rx_power !== null && tr069.rx_power !== undefined) {
      rxEl.textContent  = `${parseFloat(tr069.rx_power).toFixed(2)} dBm`;
      rxEl.style.color  = tr069.rx_power >= -23 ? 'var(--ot-green)' : tr069.rx_power >= -27 ? 'var(--ot-amber)' : 'var(--ot-red)';
    } else rxEl.textContent = '—';

    if (tr069.tx_power !== null && tr069.tx_power !== undefined) {
      txEl.textContent  = `${parseFloat(tr069.tx_power).toFixed(2)} dBm`;
    } else txEl.textContent = '—';

    if (tr069.olt_rx_power !== null && tr069.olt_rx_power !== undefined) {
      oltEl.textContent = `${parseFloat(tr069.olt_rx_power).toFixed(2)} dBm`;
    } else oltEl.textContent = '—';

    if (ont.customer) {
      setText('d-customer',    ont.customer.name);
      setText('d-customer-id', ont.customer.customer_id);
    } else {
      setText('d-customer',    'Unassigned');
      setText('d-customer-id', '—');
    }
  }

  function closeModal() {
    document.getElementById('modal-detail').classList.remove('show');
    if (signalChart) { signalChart.destroy(); signalChart = null; }
    currentOntId = null;
  }

  function resetModal() {
    ['d-manufacturer','d-model','d-firmware','d-ip','d-mac','d-uptime',
     'd-last-inform','d-device-id','d-rx','d-tx','d-olt-rx','d-customer','d-customer-id'
    ].forEach(id => setText(id, '—'));
    document.getElementById('params-tbody').innerHTML = '';
    document.getElementById('params-no-data').style.display = 'none';
    document.getElementById('get-param-result').style.display = 'none';
  }

  // ── Tabs ───────────────────────────────────────────────
  function switchTab(btn, tabId) {
    document.querySelectorAll('.m-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.m-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');

    // Lazy load parameters
    if (tabId === 'params' && currentOntId) {
      const tbody = document.getElementById('params-tbody');
      if (!tbody.innerHTML && allParams.length === 0) loadParameters();
    }
  }

  // ── Signal History Chart ───────────────────────────────
  async function loadSignalHistory(hours, chipEl = null) {
    if (chipEl) {
      document.querySelectorAll('#tab-signal .hist-btn').forEach(c => c.classList.remove('active'));
      chipEl.classList.add('active');
    }
    if (!currentOntId) return;

    const noData = document.getElementById('signal-no-data');
    noData.style.display = 'none';

    try {
      const data = await App.api(`/ont/${currentOntId}/signal?hours=${hours}`);
      if (!data?.success || !data.data?.length) {
        noData.style.display = 'block';
        if (signalChart) { signalChart.destroy(); signalChart = null; }
        return;
      }

      const history = data.data;
      const labels  = history.map(h => fmtTime(h.recorded_at));
      const rxData  = history.map(h => h.rx_power);
      const txData  = history.map(h => h.tx_power);

      if (signalChart) { signalChart.destroy(); signalChart = null; }

      const ctx = document.getElementById('signal-chart').getContext('2d');
      signalChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'RX Power (dBm)',
              data: rxData,
              borderColor: '#16a34a',
              backgroundColor: 'rgba(22,163,74,.1)',
              borderWidth: 1.5,
              pointRadius: 1.5,
              tension: 0.3,
              fill: true
            },
            {
              label: 'TX Power (dBm)',
              data: txData,
              borderColor: '#2563eb',
              backgroundColor: 'rgba(37,99,235,.06)',
              borderWidth: 1.5,
              pointRadius: 1.5,
              tension: 0.3,
              fill: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } },
            tooltip: { mode: 'index', intersect: false }
          },
          scales: {
            x: {
              ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#94a3b8' },
              grid: { display: false }
            },
            y: {
              ticks: { font: { size: 10 }, callback: v => `${v} dBm` },
              grid: { color: 'rgba(0,0,0,.04)' }
            }
          },
          interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
      });

    } catch (e) {
      console.error('loadSignalHistory error:', e);
    }
  }

  // ── Parameters ─────────────────────────────────────────
  async function loadParameters() {
    if (!currentOntId) return;
    const tbody    = document.getElementById('params-tbody');
    const loading  = document.getElementById('params-loading');
    const noData   = document.getElementById('params-no-data');
    const table    = document.getElementById('params-table');

    loading.style.display = 'block';
    table.style.display   = 'none';
    noData.style.display  = 'none';
    allParams = [];

    try {
      const data = await App.api(`/ont/${currentOntId}/parameters`);
      if (!data?.success) throw new Error(data?.message);

      allParams = data.data.params || [];
      loading.style.display = 'none';

      if (!allParams.length) {
        noData.style.display = 'block';
        return;
      }

      table.style.display = '';
      renderParamsTable(allParams);

    } catch (e) {
      loading.style.display = 'none';
      noData.style.display  = 'block';
      noData.textContent = 'Gagal memuat parameter: ' + e.message;
    }
  }

  function renderParamsTable(params) {
    const tbody = document.getElementById('params-tbody');
    tbody.innerHTML = params.map(p => `
      <tr>
        <td class="param-path">${escHtml(p.path)}</td>
        <td class="param-value">${formatParamValue(p.value)}</td>
        <td style="color:var(--faint);font-size:10px;">${escHtml(p.type || '')}</td>
        <td style="color:var(--faint);font-size:10px;">${p.timestamp ? fmtTime(p.timestamp) : '—'}</td>
      </tr>
    `).join('');
  }

  function filterParams() {
    const q = document.getElementById('param-search').value.toLowerCase();
    const filtered = q ? allParams.filter(p =>
      p.path.toLowerCase().includes(q) ||
      String(p.value).toLowerCase().includes(q)
    ) : allParams;
    renderParamsTable(filtered);
  }

  function formatParamValue(val) {
    if (val === null || val === undefined) return '<span style="color:var(--faint)">null</span>';
    const s = String(val);
    if (s.length > 200) return escHtml(s.substring(0, 200)) + '…';
    return escHtml(s);
  }

  async function refreshParams() {
    if (!currentOntId) return;
    showToast('Mengirim perintah refresh ke device…', 'info');
    try {
      const data = await App.api(`/ont/${currentOntId}/refresh`, { method: 'POST', body: JSON.stringify({}) });
      if (data?.success) {
        showToast('Refresh dikirim, tunggu 10–30 detik lalu reload', 'success');
      }
    } catch (e) {
      showToast('Gagal refresh: ' + e.message, 'error');
    }
  }

  // ── Task Management ────────────────────────────────────
  async function sendTask(taskName) {
    if (!currentOntId) return;

    const labels = {
      'reboot':        { text: 'reboot', confirm: 'Yakin ingin reboot ONT ini?' },
      'factory-reset': { text: 'factory reset', confirm: '⚠️ Factory reset akan menghapus SEMUA konfigurasi ONT!\n\nLanjutkan?' }
    };
    const meta = labels[taskName];
    if (!confirm(meta.confirm)) return;

    const btnId = taskName === 'reboot' ? 'btn-reboot' : 'btn-factory-reset';
    const btn   = document.getElementById(btnId);
    btn.disabled = true;
    btn.textContent = 'Mengirim…';

    try {
      const data = await App.api(`/ont/${currentOntId}/${taskName}`, { method: 'POST' });
      showToast(data?.message || `Perintah ${meta.text} dikirim`, 'success');
    } catch (e) {
      showToast('Gagal: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = taskName === 'reboot' ? 'Kirim Reboot' : 'Factory Reset';
    }
  }

  async function quickReboot(ontId, serial) {
    if (!confirm(`Reboot ONT ${serial}?`)) return;
    try {
      const data = await App.api(`/ont/${ontId}/reboot`, { method: 'POST' });
      showToast(data?.message || 'Reboot dikirim', 'success');
    } catch (e) {
      showToast('Gagal reboot: ' + e.message, 'error');
    }
  }

  async function getParamValue() {
    if (!currentOntId) return;
    const param = document.getElementById('get-param-input').value.trim();
    if (!param) return;

    const result = document.getElementById('get-param-result');
    result.style.display = 'block';
    result.textContent = 'Mengambil nilai…';

    try {
      const data = await App.api(`/ont/${currentOntId}/get-value`, {
        method: 'POST',
        body: JSON.stringify({ parameters: [param] })
      });
      result.textContent = data?.success
        ? JSON.stringify(data.data, null, 2)
        : 'Error: ' + (data?.message || 'Gagal');
    } catch (e) {
      result.textContent = 'Error: ' + e.message;
    }
  }

  async function setParamValue() {
    if (!currentOntId) return;
    const name  = document.getElementById('set-param-name').value.trim();
    const value = document.getElementById('set-param-value').value;
    const type  = document.getElementById('set-param-type').value;

    if (!name || value === '') {
      showToast('Parameter dan value wajib diisi', 'warning');
      return;
    }

    try {
      const data = await App.api(`/ont/${currentOntId}/set-value`, {
        method: 'POST',
        body: JSON.stringify({ parameter: name, value, type })
      });
      showToast(data?.message || 'Parameter berhasil diset', data?.success ? 'success' : 'error');
    } catch (e) {
      showToast('Gagal set parameter: ' + e.message, 'error');
    }
  }

  // ── Assign Customer ────────────────────────────────────
  async function loadCustomers() {
    try {
      const data = await App.api('/customers?limit=200&status=active');
      if (data?.success) customers = data.data || [];
    } catch (e) {
      console.error('loadCustomers error:', e);
    }
  }

  function loadAssignTab(ont) {
    const sel = document.getElementById('assign-customer-select');
    sel.innerHTML = '<option value="">— Unassigned —</option>';
    customers.forEach(c => {
      const opt = document.createElement('option');
      opt.value       = c.id;
      opt.textContent = `${c.customer_id} – ${c.name}`;
      if (ont.customer_id === c.id) opt.selected = true;
      sel.appendChild(opt);
    });

    const info = document.getElementById('current-customer-info');
    if (ont.customer) {
      info.style.display  = 'block';
      info.innerHTML = `<strong>Saat ini:</strong> ${ont.customer.name} (${ont.customer.customer_id})`;
    } else {
      info.style.display = 'none';
    }
  }

  async function assignCustomer() {
    if (!currentOntId) return;
    const customerId = document.getElementById('assign-customer-select').value;

    try {
      const data = await App.api(`/ont/${currentOntId}/assign`, {
        method: 'PUT',
        body: JSON.stringify({ customer_id: customerId || null })
      });
      if (data?.success) {
        showToast(data.message, 'success');
        loadONTs();
        // Update customer info di modal
        const info = document.getElementById('current-customer-info');
        if (customerId && data.data?.customer) {
          info.style.display = 'block';
          info.innerHTML = `✓ Berhasil diassign ke: <strong>${data.data.customer.name}</strong>`;
        } else {
          info.style.display = 'none';
        }
      } else {
        showToast(data?.message || 'Gagal assign', 'error');
      }
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }

  // ── Sync & Health ──────────────────────────────────────
  async function sync() {
    const btn = document.getElementById('btn-sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';

    try {
      const data = await App.api('/ont/sync', { method: 'POST' });
      if (data?.success) {
        showToast(data.message, 'success');
        setText('last-sync-label', 'Sync: ' + fmtTime(new Date()));
        loadStats();
        loadONTs();
        hideAlert();
      } else {
        showToast(data?.message || 'Sync gagal', 'error');
      }
    } catch (e) {
      showToast('Gagal sync: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Sync GenieACS`;
    }
  }

  async function checkHealth() {
    try {
      const data = await App.api('/ont/health');
      if (data?.data?.connected) {
        showToast(`✅ GenieACS terhubung (${data.data.url}) — ${data.data.device_count} device`, 'success');
        hideAlert();
      } else {
        showAlert(`GenieACS tidak dapat dijangkau: ${data?.data?.error || 'timeout'} (${data?.data?.url})`);
        showToast('GenieACS offline', 'error');
      }
    } catch (e) {
      showAlert('GenieACS health check gagal: ' + e.message);
    }
  }

  function showAlert(msg) {
    const el = document.getElementById('genieacs-alert');
    document.getElementById('genieacs-alert-msg').textContent = msg;
    el.classList.add('show');
  }
  function hideAlert() {
    document.getElementById('genieacs-alert').classList.remove('show');
  }

  // ── Helpers ────────────────────────────────────────────
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function statusLabel(status) {
    const map = { online: 'Online', offline: 'Offline', warning: 'Warning', unknown: 'Unknown' };
    return map[status] || status;
  }

  function timeAgo(date) {
    const diff = Math.floor((Date.now() - new Date(date)) / 1000);
    if (diff < 60)   return `${diff}d lalu`;
    if (diff < 3600) return `${Math.floor(diff/60)}m lalu`;
    if (diff < 86400)return `${Math.floor(diff/3600)}j lalu`;
    return `${Math.floor(diff/86400)}h lalu`;
  }

  function fmtDate(d) {
    return new Date(d).toLocaleString('id-ID', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit'
    });
  }

  function fmtTime(d) {
    return new Date(d).toLocaleString('id-ID', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' });
  }

  function showToast(msg, type = 'info') {
    if (typeof App?.showToast === 'function') {
      App.showToast(msg, type);
    } else {
      console.log(`[${type}] ${msg}`);
    }
  }

  // ── Public API ─────────────────────────────────────────
  return {
    init, loadONTs, loadStats,
    setFilter, debounceLoad,
    openDetail, closeModal,
    switchTab,
    loadSignalHistory,
    loadParameters, filterParams, refreshParams,
    sendTask, quickReboot, getParamValue, setParamValue,
    assignCustomer,
    sync, checkHealth
  };

})();

document.addEventListener('DOMContentLoaded', () => OntPage.init());