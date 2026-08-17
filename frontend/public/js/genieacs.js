/**
 * genieacs.js — ONT Management frontend
 * Namespace: GeniePage
 */

const GeniePage = (() => {
  let devices = [];
  let currentDeviceId = null;
  let pendingAction = null;
  let filterStatus = '';
  let searchTimer = null;
  let PER_PAGE = 25;
  let currentPage = 1;

  // ── INIT ────────────────────────────────────────────
  function init() {
    // Load settings dari DB agar persist setelah restart
    fetch('/api/genieacs/settings/load').then(r => r.json()).then(j => {
      if (j.success && j.data?.nbi_url) {
        const el_url = el('cfg-nbi-url');
        if (el_url && !el_url.value) el_url.value = j.data.nbi_url;
      }
      loadStats();
      loadDevices();
    }).catch(() => { loadStats(); loadDevices(); });
    setInterval(() => { loadStats(); loadDevices(); }, 60000);
  }

  // ── STATS ───────────────────────────────────────────
  async function loadStats() {
    const t0 = performance.now();
    try {
      const r = await fetch('/api/genieacs/stats');
      const j = await r.json();
      const latency = Math.round(performance.now() - t0);
      if (j.success && j.data) {
        el('stat-total').textContent   = j.data.total   ?? '—';
        el('stat-online').textContent  = j.data.online  ?? '—';
        el('stat-offline').textContent = j.data.offline ?? '—';
        setServerStatus('connected', latency);
        hideAlert();
      } else {
        setServerStatus('warn', latency);
      }
    } catch (e) {
      setServerStatus('error', null);
      showAlert('GenieACS tidak dapat dijangkau. Periksa pengaturan server.');
    }
  }

  // Update server card UI based on state
  function setServerStatus(state, latencyMs) {
    const pill   = document.getElementById('srv-pill');
    const icon   = document.querySelector('.srv-icon');
    const txt    = document.getElementById('stat-server');
    const urlEl  = document.getElementById('stat-server-url');
    const latEl  = document.getElementById('srv-latency');
    const urlVal = document.getElementById('cfg-nbi-url')?.value || '';

    // Strip scheme for display (acs.flaynet.com:7557 bukan https://acs.flaynet.com:7557)
    urlEl.textContent = urlVal ? urlVal.replace(/^https?:\/\//, '') : '—';

    pill?.classList.remove('err', 'warn');
    icon?.classList.remove('err', 'warn');

    if (state === 'connected') {
      txt.textContent = 'Terhubung';
      if (latEl && latencyMs != null) {
        const cls = latencyMs < 200 ? 'latok' : '';
        latEl.innerHTML = `Latency <b class="${cls}">${latencyMs} ms</b>`;
      }
    } else if (state === 'warn') {
      pill?.classList.add('warn');
      icon?.classList.add('warn');
      txt.textContent = 'Partial';
      if (latEl) latEl.innerHTML = `Latency <b>${latencyMs ?? '—'} ms</b>`;
    } else {
      pill?.classList.add('err');
      icon?.classList.add('err');
      txt.textContent = 'Offline';
      if (latEl) latEl.innerHTML = `Latency <b>—</b>`;
    }
  }

  // ── DEVICES ─────────────────────────────────────────
  async function loadDevices() {
    const tbody = el('genie-tbody');
    const search = el('genie-search').value.trim();
    tbody.innerHTML = `<tr><td colspan="11"><div class="tbl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="animation:spin 1s linear infinite"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
      <p>Memuat data...</p></div></td></tr>`;

    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (filterStatus) params.set('status', filterStatus);
      const r = await fetch('/api/genieacs/devices?' + params);
      const j = await r.json();

      if (!j.success) {
        tbody.innerHTML = `<tr><td colspan="11"><div class="tbl-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <p style="color:#dc2626">${j.error || 'Gagal memuat'}</p>
          <button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="GeniePage.openSettings()">⚙ Konfigurasi Server</button>
        </div></td></tr>`;
        showAlert(j.error || 'Gagal memuat data ONT');
        return;
      }

      devices = j.data;
      if (j.stats) {
        el('stat-total').textContent   = j.stats.total;
        el('stat-online').textContent  = j.stats.online;
        el('stat-offline').textContent = j.stats.offline;
      }

      renderTable();
      const now = new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
      el('last-refresh-label').textContent = `Diperbarui ${now}`;
      hideAlert();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="11"><div class="tbl-empty"><p style="color:#dc2626">Error: ${e.message}</p></div></td></tr>`;
    }
  }

  function renderTable() {
    const tbody = el('genie-tbody');
    const search = el('genie-search').value.toLowerCase();

    // Backend sudah filter junk devices. Di sini hanya apply search filter.
    let filtered = devices;

    if (search) {
      filtered = filtered.filter(d =>
        (d.serial||'').toLowerCase().includes(search) ||
        (d.id||'').toLowerCase().includes(search) ||
        (d.model||'').toLowerCase().includes(search) ||
        (d.ssid||'').toLowerCase().includes(search) ||
        (d.customer_name||'').toLowerCase().includes(search)
      );
    }

    el('ont-count-label').textContent = `${filtered.length} device`;

    // ─── Pagination math ───
    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PER_PAGE));
    // Clamp currentPage kalau search/filter mengecilkan jumlah hasil
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const start = (currentPage - 1) * PER_PAGE;
    const end   = Math.min(start + PER_PAGE, totalRows);
    const pageRows = filtered.slice(start, end);

    // Pagination info text — diisi setelah render controls
    renderPagination(totalRows, totalPages);

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>
        <p>Tidak ada device ditemukan</p></div></td></tr>`;
      return;
    }

    // Simpan mapping id -> index untuk lookup saat klik
    // PENTING: index relative ke pageRows (yang ditampilkan), karena tbody
    // hanya berisi page saat ini. Reset map setiap render.
    window._genieDeviceMap = {};
    pageRows.forEach((d, i) => { window._genieDeviceMap[i] = d.id; });

    tbody.innerHTML = pageRows.map((d, i) => {
      const num = String(start + i + 1).padStart(2, '0');

      // Manufacturer icon color tier
      const mfrKey = (d.manufacturer || '').toLowerCase();
      let snIcCls = 'other';
      if (mfrKey.includes('huawei')) snIcCls = 'huawei';
      else if (mfrKey.includes('zte')) snIcCls = 'zte';
      else if (mfrKey.includes('fiberhome') || mfrKey.includes('fh')) snIcCls = 'fh';
      else if (mfrKey.includes('zicg') || mfrKey.includes('zxhn')) snIcCls = 'zicg';

      const snDisplay = d.serial || truncate(d.id, 22);
      const modelSub  = [d.manufacturer, d.model].filter(Boolean).join(' ') || '—';

      // Customer cell
      const custHtml = d.customer_name
        ? `<div class="cust-cell">
             <span class="cust-name">${escHtmlLoc(d.customer_name)}</span>
             ${d.customer_id ? `<span class="cust-id">${escHtmlLoc(d.customer_id)}</span>` : ''}
           </div>`
        : `<span class="cust-empty">Belum assigned</span>`;

      // RX tier
      const rxHtml = d.online ? renderRxTier(d.rx_power) : `<span class="rx-empty">—</span>`;

      // SSID cell
      const ssidHtml = d.ssid
        ? `<div class="ssid-cell">
             <span class="ssid-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg></span>
             <span class="ssid-txt" title="${escHtmlLoc(d.ssid)}">${escHtmlLoc(d.ssid)}</span>
           </div>`
        : `<span class="rx-empty">—</span>`;

      const ipHtml = d.wan_ip
        ? `<span class="ip-badge">${escHtmlLoc(d.wan_ip)}</span>`
        : `<span class="ip-empty">—</span>`;

      const informHtml = d.last_inform
        ? `<div class="inform-cell">
             <span class="inform-ago">${fmtAgo(d.last_inform)}</span>
             <span class="inform-sub">${fmtDateTime(d.last_inform)}</span>
           </div>`
        : `<span class="rx-empty">—</span>`;

      return `<tr data-idx="${i}" class="${d.online ? '' : 'row-offline'}" onclick="GeniePage.rowClick(this)">
        <td class="num-cell">${num}</td>
        <td>
          <div class="sn-cell">
            <span class="sn-num" title="${escHtmlLoc(snDisplay)}">${escHtmlLoc(snDisplay)}</span>
            <span class="sn-sub">${escHtmlLoc(modelSub)}</span>
          </div>
        </td>
        <td data-label="Customer">${custHtml}</td>
        <td data-label="RX Power">${rxHtml}</td>
        <td data-label="Clients">${renderClientsCell(d)}</td>
        <td data-label="Suhu">${renderTempCell(d)}</td>
        <td data-label="Uptime">${renderUptimeCell(d)}</td>
        <td data-label="SSID 2.4G">${ssidHtml}</td>
        <td data-label="WAN IP">${ipHtml}</td>
        <td data-label="Last Inform">${informHtml}</td>
        <td onclick="event.stopPropagation()">
          <div class="act-btns">
            <button class="act-btn act-detail" data-idx="${i}" onclick="GeniePage.btnClick(this,'detail')" title="Detail">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            </button>
            <button class="act-btn act-wifi" data-idx="${i}" onclick="GeniePage.btnClick(this,'wifi')" title="Ubah WiFi">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/></svg>
            </button>
            <button class="act-btn act-reboot" data-idx="${i}" onclick="GeniePage.btnClick(this,'reboot')" title="Reboot">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0115.5-6.3L21 8"/><polyline points="21 3 21 8 16 8"/><path d="M21 12a9 9 0 01-15.5 6.3L3 16"/><polyline points="3 21 3 16 8 16"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // Helper: small html escape scoped to this module (avoid name collision)
  function escHtmlLoc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Render RX power (no icon) — tier color via text only
  function renderRxTier(val) {
    if (val == null || val === '') return `<span class="rx-empty">—</span>`;
    const n = parseFloat(val);
    if (isNaN(n)) return `<span class="rx-empty">—</span>`;
    let cls, lbl;
    if (n >= -25)      { cls = 'good'; lbl = 'Bagus'; }
    else if (n >= -27) { cls = 'weak'; lbl = 'Lemah'; }
    else               { cls = 'bad';  lbl = 'Buruk'; }
    return `<div class="rx-txt">
      <span class="rx-val ${cls}">${n.toFixed(2)} <span style="font-size:9.5px;font-weight:600;opacity:.7">dBm</span></span>
      <span class="rx-lbl ${cls}">${lbl}</span>
    </div>`;
  }

  // Render Clients count (no icon)
  function renderClientsCell(d) {
    if (!d.online) return `<span class="dev-empty">—</span>`;
    const c = d.connected_clients;
    if (typeof c !== 'number' || c < 0) return `<span class="dev-empty">—</span>`;
    return `<span class="dev-val" title="${c} client terhubung">${c}</span>`;
  }

  // Render Temperature (no icon)
  function renderTempCell(d) {
    if (!d.online) return `<span class="dev-empty">—</span>`;
    const t = d.temperature;
    if (typeof t !== 'number' || isNaN(t)) return `<span class="dev-empty">—</span>`;
    const isHot  = t >= 65;
    const isWarn = !isHot && t >= 55;
    const valCls = isHot ? 'hot' : isWarn ? 'warn' : '';
    return `<span class="dev-val ${valCls}" title="Suhu device">${t.toFixed(1)}<span class="u">°C</span></span>`;
  }

  // Render Uptime (no icon)
  function renderUptimeCell(d) {
    if (!d.online) return `<span class="dev-empty">—</span>`;
    const u = d.uptime_formatted;
    if (!u) return `<span class="dev-empty">—</span>`;
    return `<span class="dev-val uptime-txt" title="Uptime ${escHtmlLoc(u)}">${escHtmlLoc(u)}</span>`;
  }

  // Klik baris tabel - pakai data-idx untuk avoid encoding issues
  function rowClick(tr) {
    const idx = parseInt(tr.getAttribute('data-idx'));
    const id  = window._genieDeviceMap?.[idx];
    if (id) openDetail(id);
  }

  function btnClick(btn, action) {
    const idx = parseInt(btn.getAttribute('data-idx'));
    const id  = window._genieDeviceMap?.[idx];
    if (!id) return;
    if (action === 'detail') openDetail(id);
    else if (action === 'wifi')   openDetailTab(id, 'tab-wifi');
    else if (action === 'reboot') confirmReboot(id);
  }

  function rowClick(tr) {
    const idx = parseInt(tr.getAttribute('data-idx'));
    const id  = window._genieDeviceMap?.[idx];
    if (id) openDetail(id);
  }

  function btnClick(btn, action) {
    const idx = parseInt(btn.getAttribute('data-idx'));
    const id  = window._genieDeviceMap?.[idx];
    if (!id) return;
    if (action === 'detail') openDetail(id);
    else if (action === 'wifi')   openDetailTab(id, 'tab-wifi');
    else if (action === 'reboot') confirmReboot(id);
  }

  function setFilter(status) {
    filterStatus = status;
    document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
    const map = { '':'fchip:first-child', 'online':'.fchip.online', 'offline':'.fchip.offline' };
    // toggle active
    document.querySelectorAll('.fchip').forEach(c => {
      const ds = c.getAttribute('onclick')?.match(/'([^']*)'/)?.[1] ?? '';
      if (ds === status) c.classList.add('active');
    });
    currentPage = 1;  // reset ke halaman 1 saat ganti filter
    loadDevices();
  }

  function debounce() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage = 1;  // reset ke halaman 1 saat search berubah
      renderTable();
    }, 300);
  }

  function refresh() { loadStats(); loadDevices(); }

  // ── DETAIL MODAL ─────────────────────────────────────
  async function openDetail(deviceId) {
    currentDeviceId = deviceId;
    showModal('modal-detail');
    el('modal-title').textContent    = 'Detail ONT';
    el('modal-subtitle').textContent = truncate(deviceId, 40);

    // Reset clients tab
    resetClients();
    // Reset signal & assign
    if (rxChart) { rxChart.destroy(); rxChart = null; }
    const bwRx = el('bw-rx'); const bwTx = el('bw-tx');
    if (bwRx) bwRx.textContent = '—'; if (bwTx) bwTx.textContent = '—';

    // Reset wifi form
    el('wifi-ssid').value    = '';
    el('wifi-pass').value    = '';
    el('wifi-ssid-5g').value = '';
    el('wifi-pass-5g').value = '';
    hideInlineAlert('wifi-result');
    hideInlineAlert('task-result');

    // Pre-fill dari cached data
    const cached = devices.find(d => d.id === deviceId);
    if (cached) {
      el('wifi-ssid').value   = cached.ssid  || '';
      el('wifi-ssid-5g').value = cached.ssid_5g || '';
      const pill = cached.online
        ? `<span class="status-pill pill-online"><span class="sdot"></span>Online</span>`
        : `<span class="status-pill pill-offline"><span class="sdot"></span>Offline</span>`;
      el('modal-status-badge').outerHTML;
      document.getElementById('modal-status-badge').className = cached.online ? 'status-pill pill-online' : 'status-pill pill-offline';
      document.getElementById('modal-status-badge').innerHTML = `<span class="sdot"></span>${cached.online ? 'Online' : 'Offline'}`;
    }

    // Fetch detail
    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(deviceId)}`);
      const j = await r.json();
      if (j.success && j.data) {
        const d      = j.data;
        const online = d.online;

        el('modal-title').textContent    = d.model || d.manufacturer || 'Detail ONT';
        el('modal-subtitle').textContent = d.serial_number || truncate(deviceId,40);
        el('d-manufacturer').textContent = d.manufacturer || '—';
        el('d-model').textContent        = d.model || '—';
        el('d-firmware').textContent     = d.software_version || '—';
        el('d-serial').textContent       = d.serial_number || '—';
        el('d-last-inform').textContent  = d.last_inform ? fmtDateTime(d.last_inform) : '—';

        // WAN & Uptime — tampilkan meski offline (data terakhir)
        el('d-ip').textContent        = d.signal?.wan_ip || '—';
        el('d-wan-status').textContent= online ? (d.signal?.wan_status || '—') : 'Disconnected';
        el('d-wan-status').style.color= online ? '' : 'var(--ot-red)';
        el('d-uptime').textContent    = online ? (d.signal?.uptime_formatted || '—') : '—';

        // Sinyal optik & suhu — HANYA tampil saat online
        el('d-rx').textContent   = online && d.signal?.rx_power   ? `${d.signal.rx_power} dBm`     : '—';
        el('d-tx').textContent   = online && d.signal?.tx_power   ? `${d.signal.tx_power} dBm`     : '—';
        el('d-temp').textContent = online && d.signal?.temperature? `${d.signal.temperature}°C`    : '—';

        // Warna sinyal saat online
        const rxEl = el('d-rx');
        if (online && d.signal?.rx_power) {
          const n = parseFloat(d.signal.rx_power);
          rxEl.style.color = n >= -25 ? 'var(--ot-green)' : n >= -27 ? 'var(--ot-amber)' : 'var(--ot-red)';
        } else {
          rxEl.style.color = 'var(--faint)';
        }

        // WiFi SSID & password form — pre-fill dari data GenieACS
        el('d-ssid').textContent  = d.wifi?.ssid_2g || '—';
        el('d-ssid5g').textContent= d.wifi?.ssid_5g || '—';
        if (d.wifi?.ssid_2g)     el('wifi-ssid').value    = d.wifi.ssid_2g;
        if (d.wifi?.ssid_5g)     el('wifi-ssid-5g').value = d.wifi.ssid_5g;
        // Password — tampilkan jika tersedia dari GenieACS
        if (d.wifi?.password_2g) {
          el('wifi-pass').value = d.wifi.password_2g;
          el('wifi-pass').type  = 'password'; // tetap tersembunyi default
          const hint = el('wifi-pass-hint');
          if (hint) hint.textContent = '✓ Password tersedia';
        } else {
          const hint = el('wifi-pass-hint');
          if (hint) hint.textContent = '';
        }
        if (d.wifi?.password_5g) {
          el('wifi-pass-5g').value = d.wifi.password_5g;
          el('wifi-pass-5g').type  = 'password';
          // Auto-show 5GHz section jika ada data
          if (d.wifi.ssid_5g || d.wifi.password_5g) {
            el('wifi-show-5g').checked = true;
            el('wifi-5g-section').style.display = 'block';
          }
        }
      }
    } catch(e) { /* pakai cached data */ }
  }

  function openDetailTab(deviceId, tabId) {
    openDetail(deviceId).then(() => {
      document.querySelectorAll('.m-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.m-panel').forEach(p => p.classList.remove('active'));
      el(tabId)?.classList.add('active');
      // set tab button active
      const tabs = document.querySelectorAll('.m-tab');
      tabs.forEach(t => {
        if (t.getAttribute('onclick')?.includes(tabId)) t.classList.add('active');
      });
    });
  }

  function switchTab(btn, panelId) {
    document.querySelectorAll('.m-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.m-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    el(panelId)?.classList.add('active');
    if (panelId === 'tab-clients') loadClients();
    if (panelId === 'tab-signal')  loadSignalHistory(6);
    if (panelId === 'tab-usage')   loadBandwidth();
    if (panelId === 'tab-assign')  loadAssignedCustomer();
  }

  // ── WIFI ─────────────────────────────────────────────
  async function submitWifi() {
    const ssid    = el('wifi-ssid').value.trim();
    const pass    = el('wifi-pass').value;
    const ssid5g  = el('wifi-ssid-5g').value.trim();
    const pass5g  = el('wifi-pass-5g').value;
    const show5g  = el('wifi-show-5g').checked;

    if (!ssid && !pass && !ssid5g && !pass5g) {
      showInlineAlert('wifi-result', 'error', 'Masukkan SSID atau password yang ingin diubah');
      return;
    }

    const btn = el('btn-save-wifi');
    btn.disabled = true; btn.textContent = 'Menyimpan...';

    try {
      const body = { ssid, password: pass, band: show5g ? 'both' : '2g' };
      if (show5g) { body.ssid_5g = ssid5g; body.password_5g = pass5g; }
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/wifi`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      const j = await r.json();
      if (j.success) {
        // Sama logic dengan doConfirm: tampilkan pesan sesuai status execution
        if (j.executed) {
          showInlineAlert('wifi-result', 'success',
            '✅ Pengaturan WiFi berhasil diterapkan. Perubahan aktif dalam beberapa detik.');
          setTimeout(() => loadDevices(), 3000);
        } else if (j.queued) {
          const eta = j.eta?.etaText || '± 1-15 menit';
          showInlineAlert('wifi-result', 'info',
            `Pengaturan WiFi di-queue. Perubahan akan diterapkan saat ONT sinkron berikutnya ke ACS : <strong>${eta}</strong>.`,
            true);  // allowHtml: pesan ini trusted
          // Tetap reload tapi delay lebih lama
          setTimeout(() => loadDevices(), 10000);
        } else {
          showInlineAlert('wifi-result', 'success', '✅ Perintah berhasil dikirim. Perubahan aktif dalam beberapa detik.');
          setTimeout(() => loadDevices(), 3000);
        }
      } else {
        showInlineAlert('wifi-result', 'error', '⚠ Gagal: ' + j.error);
      }
    } catch(e) {
      showInlineAlert('wifi-result', 'error', 'Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg> Simpan & Terapkan`;
    }
  }

  function toggle5g() {
    el('wifi-5g-section').style.display = el('wifi-show-5g').checked ? 'block' : 'none';
  }

  function togglePw(inputId) {
    const i = el(inputId);
    i.type = i.type === 'password' ? 'text' : 'password';
  }

  // ── TASKS ────────────────────────────────────────────
  function sendTask(action) {
    const labels = { reboot: 'Reboot', 'factory-reset': 'Factory Reset' };
    const msgs   = {
      reboot: 'Yakin ingin me-reboot ONT ini? Koneksi akan terputus sementara.',
      'factory-reset': '⚠ PERINGATAN! Factory reset akan menghapus SEMUA konfigurasi ONT. Tidak dapat dibatalkan!'
    };
    pendingAction = action;
    el('confirm-title').textContent   = labels[action] || action;
    el('confirm-message').textContent = msgs[action]   || `Lanjutkan ${action}?`;
    showModal('modal-confirm');
  }

  async function doConfirm() {
    if (!pendingAction) return;
    const btn = el('btn-confirm');
    btn.disabled = true; btn.textContent = '⏳...';
    closeModal('modal-confirm');
    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/${pendingAction}`, {
        method:'POST', headers:{'Content-Type':'application/json'}
      });
      const j = await r.json();
      // Tampilkan pesan sesuai status execution:
      //   - executed=true  → ONT eksekusi langsung (Connection Request sukses)
      //   - queued=true    → di-queue, akan execute saat ONT periodic inform
      //   - else           → success generic atau error
      if (j.success) {
        const actionLabel = pendingAction === 'reboot' ? 'reboot' : pendingAction;
        if (j.executed) {
          showInlineAlert('task-result', 'success',
            `✅ Perintah ${actionLabel} berhasil dieksekusi. ONT akan reboot dalam beberapa detik.`);
        } else if (j.queued) {
          // Tampilkan ETA kalau ada
          const eta = j.eta?.etaText || '± 1-15 menit';
          const lastInformTxt = j.eta?.lastInform
            ? new Date(j.eta.lastInform).toLocaleString('id-ID', { hour:'2-digit', minute:'2-digit' })
            : '-';
          showInlineAlert('task-result', 'info',
            `Perintah ${actionLabel} di-queue. Akan execute saat ONT sinkron berikutnya ke ACS: <strong>${eta}</strong>. <span style="opacity:.7">(Last inform: ${lastInformTxt})</span>`,
            true);  // allowHtml: pesan ini trusted (internal, no user input)
        } else {
          // Backward compat: kalau backend belum return executed/queued
          showInlineAlert('task-result', 'success',
            `✅ Perintah ${actionLabel} berhasil dikirim.`);
        }
      } else {
        showInlineAlert('task-result', 'error', `⚠ ${j.error || 'Gagal'}`);
      }
    } catch(e) {
      showInlineAlert('task-result', 'error', 'Error: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Ya, Lanjutkan';
      pendingAction = null;
    }
  }

  function confirmReboot(deviceId) {
    currentDeviceId = deviceId;
    sendTask('reboot');
  }

  async function sendRefresh() {
    showInlineAlert('task-result', 'info', '↻ Mengirim permintaan refresh...');
    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/refresh`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ objectName: 'InternetGatewayDevice' })
      });
      const j = await r.json();
      showInlineAlert('task-result', j.success ? 'success' : 'error',
        j.success ? '✅ Refresh dijadwalkan. Data akan diperbarui dalam beberapa detik.' : '⚠ ' + j.error);
      if (j.success) setTimeout(() => loadDevices(), 4000);
    } catch(e) {
      showInlineAlert('task-result', 'error', 'Error: ' + e.message);
    }
  }

  // ── CONNECTED DEVICES ────────────────────────────────────
  let clientsLoaded = false;

  async function loadClients() {
    if (!currentDeviceId) return;
    const container = el('clients-content');
    const summary   = el('clients-summary');
    if (!container) return;

    container.innerHTML = `<div class="tbl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="animation:spin 1s linear infinite"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
      <p>Memuat perangkat terhubung...</p></div>`;

    try {
      const res = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/clients`);
      const j   = await res.json();

      if (!j.success || !j.data?.length) {
        container.innerHTML = `<div class="tbl-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
          <p>Tidak ada perangkat terhubung</p></div>`;
        if (summary) summary.textContent = '0 perangkat';
        return;
      }

      if (summary) summary.innerHTML =
        `<span style="color:#16a34a;font-weight:700">${j.total}</span> perangkat` +
        ` &nbsp;·&nbsp; <span style="color:#1e78ff;font-weight:600">${j.wifi} WiFi</span>` +
        ` &nbsp;·&nbsp; <span style="color:#64748b;font-weight:600">${j.ethernet} Ethernet</span>`;

      // Card style per device
      const cards = j.data.map((c, i) => {
        const isWifi = ['WiFi','802.11'].includes(c.type);
        const isEth  = c.type === 'Ethernet';

        // Type badge
        const typeBadge = isWifi
          ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#eff6ff;color:#1e78ff;border:1.5px solid #bfdbfe">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1"/></svg>
              WiFi</span>`
          : isEth
          ? `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
              Ethernet</span>`
          : `<span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:#f1f5f9;color:#64748b">${c.type||'—'}</span>`;

        // Signal indicator
        const rssiHtml = c.rssi ? signalBar(parseInt(c.rssi)) : '';

        // Hostname avatar letter
        const letter = (c.hostname || c.mac || '?')[0].toUpperCase();
        const avatarColor = isWifi ? '#1e78ff' : isEth ? '#16a34a' : '#64748b';

        return `<div style="display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1.5px solid #e2e8f0;margin-bottom:8px;transition:background .15s" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='#f8fafc'">
          <!-- Avatar -->
          <div style="width:40px;height:40px;border-radius:12px;background:${avatarColor}18;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px;font-weight:800;color:${avatarColor};border:1.5px solid ${avatarColor}28">
            ${letter}
          </div>
          <!-- Info -->
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${c.hostname || '<span style="color:#94a3b8;font-weight:400">Tidak diketahui</span>'}
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              ${c.ip ? `<span style="font-family:monospace;font-size:11.5px;font-weight:600;color:#475569;background:#e2e8f0;padding:2px 8px;border-radius:6px">${c.ip}</span>` : ''}
              ${c.mac ? `<span style="font-family:monospace;font-size:10.5px;color:#94a3b8">${c.mac}</span>` : ''}
            </div>
          </div>
          <!-- Type & SSID -->
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0">
            ${typeBadge}
            ${c.ssid ? `<span style="font-size:11px;color:#64748b;font-weight:500">${c.ssid}</span>` : ''}
          </div>
          <!-- Signal -->
          ${rssiHtml ? `<div style="flex-shrink:0">${rssiHtml}</div>` : ''}
        </div>`;
      }).join('');

      container.innerHTML = `<div style="padding:2px 0">${cards}</div>`;
      clientsLoaded = true;
    } catch(e) {
      container.innerHTML = `<div class="tbl-empty"><p style="color:#dc2626">Error: ${e.message}</p></div>`;
    }
  }

  function signalBar(rssi) {
    if (!rssi) return '';
    const pct   = Math.min(100, Math.max(0, (rssi + 100) * 1.5));
    const color = pct > 60 ? '#16a34a' : pct > 30 ? '#f59e0b' : '#ef4444';
    const bars  = [20, 40, 60, 80, 100].map(threshold =>
      `<div style="width:4px;border-radius:2px;background:${pct >= threshold ? color : '#e2e8f0'};height:${6 + threshold/20}px"></div>`
    ).join('');
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px">
      <div style="display:flex;align-items:flex-end;gap:2px">${bars}</div>
      <span style="font-family:monospace;font-size:9.5px;color:${color};font-weight:700">${rssi}</span>
    </div>`;
  }

  function resetClients() {
    clientsLoaded = false;
    const c = el('clients-content');
    const s = el('clients-summary');
    if (c) c.innerHTML = `<div class="tbl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      <p>Klik tab ini untuk memuat perangkat terhubung</p></div>`;
    if (s) s.textContent = 'Klik untuk memuat data...';
  }

  // ── SIGNAL HISTORY & BANDWIDTH ──────────────────────────
  let rxChart = null;

  async function loadSignalHistory(hours = 6, btn = null) {
    if (!currentDeviceId) return;
    if (btn) {
      document.querySelectorAll('.hist-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    const canvas  = el('rx-chart');
    const noData  = el('signal-no-data');
    if (!canvas) return;

    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/rx-history?hours=${hours}`);
      const j = await r.json();

      if (!j.success || !j.data?.length) {
        if (noData) noData.style.display = 'flex';
        canvas.style.display = 'none';
        return;
      }

      if (noData) noData.style.display = 'none';
      canvas.style.display = 'block';

      const labels = j.data.map(d => {
        const dt = new Date(d.time);
        return dt.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
      });
      const values = j.data.map(d => d.value);

      // Update current signal info
      const last = values[values.length - 1];
      const sigEl = el('signal-current');
      if (sigEl && last) {
        const color = last >= -25 ? '#16a34a' : last >= -27 ? '#f59e0b' : '#ef4444';
        sigEl.innerHTML = `Terkini: <span style="color:${color};font-weight:700">${last.toFixed(2)} dBm</span>`;
      }

      if (rxChart) rxChart.destroy();
      rxChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'RX Power (dBm)',
            data: values,
            borderColor: '#1e78ff',
            backgroundColor: 'rgba(30,120,255,.08)',
            borderWidth: 2,
            pointRadius: values.length > 30 ? 0 : 3,
            pointBackgroundColor: '#1e78ff',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxTicksLimit: 8 }, grid: { display: false } },
            y: {
              ticks: { font: { size: 10 }, callback: v => v + ' dBm' },
              grid: { color: '#f1f5f9' },
              // Ref lines: -25 good, -27 warning
              afterDataLimits: axis => { axis.max = Math.max(axis.max, -10); axis.min = Math.min(axis.min, -35); }
            }
          }
        }
      });
    } catch(e) {
      if (noData) { noData.style.display = 'flex'; noData.querySelector('p').textContent = 'Error: ' + e.message; }
    }
  }

  async function loadBandwidth() {
    if (!currentDeviceId) return;
    const rxEl  = el('bw-rx');    const txEl  = el('bw-tx');
    const rxSub = el('bw-rx-packets'); const txSub = el('bw-tx-packets');
    const errEl = el('bw-error'); const srcEl = el('bw-source');
    if (rxEl) rxEl.textContent = '...'; if (txEl) txEl.textContent = '...';
    if (errEl) errEl.style.display = 'none';

    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/bandwidth`);
      const j = await r.json();

      // Tampilkan info customer jika ada
      if (j.customer && srcEl) {
        srcEl.innerHTML = `Pelanggan: <strong>${j.customer.name}</strong> (${j.customer.customer_id})` +
          (j.source === 'pppoe' ? ' &nbsp;·&nbsp; <span style="color:#16a34a">● PPPoE</span>' :
           j.source === 'queue' ? ' &nbsp;·&nbsp; <span style="color:#1e78ff">● Simple Queue</span>' : '');
      }

      if (!j.success || !j.data) {
        if (rxEl) rxEl.textContent = '—'; if (txEl) txEl.textContent = '—';
        if (rxSub) rxSub.textContent = ''; if (txSub) txSub.textContent = '';
        if (errEl) {
          errEl.style.display = 'block';
          errEl.textContent   = j.error || 'Data tidak tersedia';
        }
        return;
      }

      const d = j.data;

      // Nilai utama
      if (rxEl) {
        rxEl.innerHTML = `${d.rx_display.value} <span style="font-size:14px;opacity:.7">${d.rx_display.unit}</span>`;
      }
      if (txEl) {
        txEl.innerHTML = `${d.tx_display.value} <span style="font-size:14px;opacity:.7">${d.tx_display.unit}</span>`;
      }

      // Sub info
      if (rxSub) {
        const info = d.rx_rate !== '0 bps' ? `↓ ${d.rx_rate}` : (d.uptime ? `Uptime: ${d.uptime}` : '');
        rxSub.textContent = info;
      }
      if (txSub) {
        const info = d.tx_rate !== '0 bps' ? `↑ ${d.tx_rate}` : (d.max_rx ? `Max: ${d.max_rx}` : '');
        txSub.textContent = info;
      }

      // Ratio bar
      const fill  = el('bw-ratio-fill');
      const dlLbl = el('bw-ratio-dl');
      const ulLbl = el('bw-ratio-ul');
      if (fill)  fill.style.width       = d.dl_pct + '%';
      if (dlLbl) dlLbl.textContent      = `↓ ${d.dl_pct}%`;
      if (ulLbl) ulLbl.textContent      = `↑ ${d.ul_pct}%`;

    } catch(e) {
      if (rxEl) rxEl.textContent = '—'; if (txEl) txEl.textContent = '—';
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Error: ' + e.message; }
    }
  }

  // ── ASSIGN PELANGGAN ─────────────────────────────────────
  let assignedCustomerId = null;
  let searchTimer2 = null;

  async function loadAssignedCustomer() {
    if (!currentDeviceId) return;
    const displayEl = el('current-customer-display');
    if (!displayEl) return;
    displayEl.textContent = 'Memuat...';

    try {
      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/customer`);
      const j = await r.json();

      if (j.success && j.data) {
        const c = j.data;
        assignedCustomerId = c.id;
        const statusColor = c.status === 'active' ? '#16a34a' : '#ef4444';
        displayEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:38px;height:38px;border-radius:10px;background:#eff6ff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#1e78ff;flex-shrink:0">
              ${c.name[0].toUpperCase()}
            </div>
            <div>
              <div style="font-weight:700;color:#0f172a;font-size:13px">${c.name}</div>
              <div style="font-size:11px;color:#64748b">${c.customer_id} · <span style="color:${statusColor};font-weight:600">${c.status}</span></div>
              ${c.phone ? `<div style="font-size:11px;color:#94a3b8">${c.phone}</div>` : ''}
            </div>
          </div>`;
      } else {
        assignedCustomerId = null;
        displayEl.innerHTML = '<span style="color:#94a3b8;font-style:italic">Belum ada pelanggan yang di-assign ke ONT ini</span>';
      }
    } catch(e) {
      displayEl.textContent = 'Error: ' + e.message;
    }
  }

  async function searchCustomers() {
    clearTimeout(searchTimer2);
    searchTimer2 = setTimeout(async () => {
      const q = el('customer-search-input')?.value.trim();
      const resultsEl = el('customer-search-results');
      if (!resultsEl) return;

      if (!q || q.length < 2) { resultsEl.style.display = 'none'; return; }

      try {
        const r = await fetch(`/api/genieacs/customers/search?q=${encodeURIComponent(q)}`);
        const j = await r.json();

        if (!j.success || !j.data?.length) {
          resultsEl.innerHTML = '<div style="padding:12px 14px;font-size:13px;color:#94a3b8;text-align:center">Tidak ditemukan</div>';
          resultsEl.style.display = 'block';
          return;
        }

        resultsEl.innerHTML = j.data.map(c => {
          const hasOnt = c.ont_sn ? `<span style="font-size:10px;color:#f59e0b;margin-left:6px">• Sudah punya ONT</span>` : '';
          const statusColor = c.status === 'active' ? '#16a34a' : '#ef4444';
          return `<div onclick="GeniePage.selectCustomer(${c.id},'${c.name}','${c.customer_id}')"
            style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:10px;transition:background .1s"
            onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='#fff'">
            <div style="width:32px;height:32px;border-radius:8px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#475569;flex-shrink:0">
              ${c.name[0].toUpperCase()}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:#0f172a">${c.name} ${hasOnt}</div>
              <div style="font-size:11px;color:#64748b">${c.customer_id} · <span style="color:${statusColor}">${c.status}</span></div>
            </div>
          </div>`;
        }).join('');
        resultsEl.style.display = 'block';
      } catch(e) {}
    }, 300);
  }

  function selectCustomer(id, name, custId) {
    // Langsung assign
    doAssign(id, name, custId);
    el('customer-search-input').value = name + ' (' + custId + ')';
    el('customer-search-results').style.display = 'none';
  }

  async function doAssign(customerId, name, custId) {
    hideInlineAlert('assign-result');
    try {
      // Dapatkan serial dari deviceId
      const decoded = decodeURIComponent(currentDeviceId);
      const parts   = decoded.split('-');
      const serial  = parts.length >= 3 ? parts.slice(2).join('-') : decoded;

      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/assign`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ customer_id: customerId, serial })
      });
      const j = await r.json();
      if (j.success) {
        showInlineAlert('assign-result', 'success', `✅ ONT berhasil di-assign ke ${name} (${custId})`);
        loadAssignedCustomer();
      } else {
        showInlineAlert('assign-result', 'error', '⚠ ' + j.error);
      }
    } catch(e) {
      showInlineAlert('assign-result', 'error', 'Error: ' + e.message);
    }
  }

  async function unassignCustomer() {
    if (!confirm('Yakin ingin melepas assign pelanggan dari ONT ini?')) return;
    try {
      const decoded = decodeURIComponent(currentDeviceId);
      const parts   = decoded.split('-');
      const serial  = parts.length >= 3 ? parts.slice(2).join('-') : decoded;

      const r = await fetch(`/api/genieacs/devices/${safeEncodeId(currentDeviceId)}/assign`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ customer_id: null, serial })
      });
      const j = await r.json();
      if (j.success) {
        showInlineAlert('assign-result', 'success', '✅ Assign berhasil dilepas');
        loadAssignedCustomer();
      } else {
        showInlineAlert('assign-result', 'error', '⚠ ' + j.error);
      }
    } catch(e) {
      showInlineAlert('assign-result', 'error', 'Error: ' + e.message);
    }
  }

  // ── SETTINGS ─────────────────────────────────────────
  function openSettings() { showModal('modal-settings'); hideInlineAlert('cfg-test-result'); }

  async function testConn() {
    let nbi_url  = el('cfg-nbi-url').value.trim();
    const username = el('cfg-username').value;
    const password = el('cfg-password').value;
    if (!nbi_url.startsWith('http')) nbi_url = 'http://' + nbi_url;
    showInlineAlert('cfg-test-result', 'info', '⏳ Mengtest koneksi...');
    try {
      const r = await fetch('/api/genieacs/test', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ nbi_url, username, password })
      });
      const j = await r.json();
      showInlineAlert('cfg-test-result', j.success ? 'success' : 'error',
        j.success ? '✅ Koneksi berhasil!' : '⚠ Gagal: ' + j.error);
    } catch(e) {
      showInlineAlert('cfg-test-result', 'error', 'Error: ' + e.message);
    }
  }

  async function saveSettings() {
    let nbi_url  = el('cfg-nbi-url').value.trim();
    const username = el('cfg-username').value;
    const password = el('cfg-password').value;
    if (!nbi_url) { showInlineAlert('cfg-test-result','error','URL wajib diisi'); return; }
    // Auto-tambah http:// jika belum ada
    if (!nbi_url.startsWith('http')) nbi_url = 'http://' + nbi_url;
    try {
      const r = await fetch('/api/genieacs/settings', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ nbi_url, username, password })
      });
      const j = await r.json();
      if (j.success) {
        closeModal('modal-settings');
        el('stat-server-url').textContent = String(nbi_url).replace(/^https?:\/\//, '');
        loadStats(); loadDevices();
      } else { alert('Gagal: ' + j.error); }
    } catch(e) { alert('Error: ' + e.message); }
  }

  // ── HELPERS ──────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function showModal(id)  { el(id)?.classList.add('show'); }
  function closeModal(id) { el(id)?.classList.remove('show'); }

  function showAlert(msg) {
    el('genie-alert').classList.add('show');
    el('genie-alert-msg').textContent = msg;
  }
  function hideAlert() { el('genie-alert').classList.remove('show'); }

  function showInlineAlert(id, type, msg, allowHtml = false) {
    const e = el(id);
    if (!e) return;
    e.className = `inline-alert ${type}`;
    // allowHtml=true HANYA dipakai untuk pesan internal yang trusted
    // (tidak mengandung user input). Default false untuk safety.
    if (allowHtml) {
      e.innerHTML = msg;
    } else {
      e.textContent = msg;
    }
    e.style.display = 'block';
  }
  function hideInlineAlert(id) {
    const e = el(id);
    if (e) { e.style.display = 'none'; e.className = 'inline-alert'; }
  }

  function formatRxPower(val) {
    if (!val && val !== 0) return '<span style="color:var(--faint)">—</span>';
    const n = parseFloat(val);
    if (isNaN(n)) return '<span style="color:var(--faint)">—</span>';
    let color, label;
    if (n >= -25)      { color = 'var(--ot-green)'; label = 'Bagus'; }
    else if (n >= -27) { color = 'var(--ot-amber)'; label = 'Lemah'; }
    else               { color = 'var(--ot-red)';   label = 'Buruk'; }
    return `<div style="font-family:monospace;font-size:12px;font-weight:700;color:${color}">${n.toFixed(2)} dBm</div><div style="font-size:10px;color:${color};opacity:.8">${label}</div>`;
  }

  function truncate(s, n) { return s && s.length > n ? s.slice(0,n)+'…' : (s||''); }
  function safeEncodeId(id) {
    // Decode dulu untuk hindari double-encoding (%2D yang sudah ada di ID)
    try { return encodeURIComponent(decodeURIComponent(id || '')); }
    catch(e) { return encodeURIComponent(id || ''); }
  }
  function escId(id)  { return (id||'').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

  function fmtAgo(dateStr) {
    if (!dateStr) return '—';
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff/60000);
    if (m < 1)  return 'Baru saja';
    if (m < 60) return `${m} menit lalu`;
    const h = Math.floor(m/60);
    if (h < 24) return `${h} jam lalu`;
    return `${Math.floor(h/24)} hari lalu`;
  }

  function fmtDateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('id-ID',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  // ── PAGINATION ──────────────────────────────────────
  // Render pagination controls di footer tabel.
  // Mendukung: prev/next, page numbers (with ellipsis untuk page banyak),
  // per-page selector (25/50/100/250), dan jump-to-page input.
  function renderPagination(totalRows, totalPages) {
    const info = el('genie-pg-info');
    if (!info) return;

    if (totalRows === 0) {
      info.innerHTML = '<span class="pg-empty">Tidak ada device</span>';
      return;
    }

    const startIdx = (currentPage - 1) * PER_PAGE + 1;
    const endIdx   = Math.min(currentPage * PER_PAGE, totalRows);

    // ─── Build page number buttons dengan ellipsis ───
    // Logic: tampilkan max ~7 tombol (current ± 2, dengan ellipsis jika perlu)
    const pages = [];
    const cp = currentPage, tp = totalPages;
    function addBtn(p) {
      if (p === cp) {
        pages.push(`<button class="pg-btn pg-active" disabled>${p}</button>`);
      } else {
        pages.push(`<button class="pg-btn" onclick="GeniePage.gotoPage(${p})">${p}</button>`);
      }
    }
    function addEllipsis() {
      pages.push(`<span class="pg-ellipsis">…</span>`);
    }

    if (tp <= 7) {
      // Tampilkan semua kalau total page sedikit
      for (let i = 1; i <= tp; i++) addBtn(i);
    } else {
      // Smart pagination: 1 … (cp-1) cp (cp+1) … tp
      addBtn(1);
      if (cp > 4) addEllipsis();
      const startP = Math.max(2, cp - 2);
      const endP   = Math.min(tp - 1, cp + 2);
      for (let i = startP; i <= endP; i++) addBtn(i);
      if (cp < tp - 3) addEllipsis();
      addBtn(tp);
    }

    info.innerHTML = `
      <div class="pg-wrap">
        <div class="pg-info-text">
          Menampilkan <strong>${startIdx.toLocaleString('id-ID')}</strong>–<strong>${endIdx.toLocaleString('id-ID')}</strong>
          dari <strong>${totalRows.toLocaleString('id-ID')}</strong> device
        </div>

        <div class="pg-controls">
          <label class="pg-perpage">
            <span>Per halaman:</span>
            <select onchange="GeniePage.setPerPage(parseInt(this.value))">
              <option value="25"  ${PER_PAGE===25  ? 'selected':''}>25</option>
              <option value="50"  ${PER_PAGE===50  ? 'selected':''}>50</option>
              <option value="100" ${PER_PAGE===100 ? 'selected':''}>100</option>
              <option value="250" ${PER_PAGE===250 ? 'selected':''}>250</option>
            </select>
          </label>

          <div class="pg-nav">
            <button class="pg-btn pg-arrow" ${cp <= 1 ? 'disabled' : `onclick="GeniePage.gotoPage(${cp-1})"`} aria-label="Halaman sebelumnya">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            ${pages.join('')}
            <button class="pg-btn pg-arrow" ${cp >= tp ? 'disabled' : `onclick="GeniePage.gotoPage(${cp+1})"`} aria-label="Halaman berikutnya">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function gotoPage(n) {
    n = parseInt(n) || 1;
    if (n < 1) n = 1;
    currentPage = n;
    renderTable();
    // Scroll ke atas tabel supaya user lihat data baru
    const tableCard = document.querySelector('.ot-table-card') || el('genie-tbody').closest('.card');
    if (tableCard) {
      tableCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Rebuild mobile cards juga
    if (typeof window.rebuildMobileCards === 'function') window.rebuildMobileCards();
  }

  function setPerPage(n) {
    n = parseInt(n) || 25;
    if (![25,50,100,250].includes(n)) n = 25;
    PER_PAGE = n;
    currentPage = 1;
    renderTable();
    if (typeof window.rebuildMobileCards === 'function') window.rebuildMobileCards();
  }

  // Reset ke page 1 saat search/filter berubah, supaya user tidak stuck
  // di halaman yang lebih besar dari total page hasil filter.
  function resetPageOnSearch() {
    currentPage = 1;
  }

  // ── PUBLIC ───────────────────────────────────────────
  return {
    init, refresh, loadDevices, loadStats,
    setFilter, debounce,
    rowClick, btnClick,
    openDetail, openDetailTab, closeModal, switchTab,
    submitWifi, toggle5g, togglePw,
    loadClients, loadSignalHistory, loadBandwidth,
    loadAssignedCustomer, searchCustomers, selectCustomer, unassignCustomer,
    sendTask, doConfirm, confirmReboot, sendRefresh,
    openSettings, testConn, saveSettings,
    gotoPage, setPerPage, resetPageOnSearch
  };
})();

document.addEventListener('DOMContentLoaded', GeniePage.init);