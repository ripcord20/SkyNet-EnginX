// Simple Queue Monitor - queue.js (table-based redesign)

// Helper: append ?device_id=N kalau ada selector aktif (window.MikrotikSelector)
function _withDev(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

// Ambil nama device aktif dari selector (untuk banner)
function _activeDeviceName() {
  const sel = document.getElementById('mikrotikSelector');
  if (!sel || !sel.options || !sel.value) return null;
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return null;
  return (opt.textContent || '').replace(/[★✓\s]+$/, '').trim() || null;
}

const QueuePage = {
  queues: [],
  filteredQueues: [],
  charts: {},
  chartData: {},
  pollTimer: null,
  pollInflight: false,           // guard: skip kalau request sebelumnya belum balik
  loadSeq: 0,                    // increment tiap loadQueues — abort response stale
  POLL_INTERVAL: 3000,
  MAX_CHART_POINTS: 30,
  selectedQueue: null,
  detailChart: null,
  detailChartData: { rx: [], tx: [], ts: [] },
  historyChart: null,
  currentHistoryRange: '1h',
  hasSelector: false,            // true kalau ada multi-device selector aktif
  // Cache queue list per-device id agar saat user pindah balik ke device yang sama,
  // tampilan langsung muncul (refresh di background). Key: deviceId string ('' = global)
  _queueCache: new Map(),        // deviceId → { queues, ts }
  _CACHE_TTL: 60 * 1000,         // 60 detik — kalau lebih lama, anggap stale tapi tetap pakai sambil refresh

  async init() {
    this.bindEvents();
    // Tampilkan skeleton + banner connecting INSTAN — sebelum nunggu network apa-apa
    this.renderLoading('Memuat queue...');
    this.showBanner('info', '⏳ Menghubungkan ke MikroTik...');

    // Init MikroTik selector — reload data saat user ganti device
    if (window.MikrotikSelector) {
      window.MikrotikSelector.init({
        selectId: 'mikrotikSelector',
        onChange: () => this.onDeviceChange(),
        onReady:  ({ list }) => {
          this.hasSelector = !!(list && list.length);
          // Sembunyikan tombol "MikroTik Config" kalau pakai multi-device
          // (config global tidak relevan saat tiap device punya credential sendiri di tabel devices)
          if (this.hasSelector) {
            const btn = document.getElementById('btnConfigMT');
            if (btn) btn.style.display = 'none';
          }
        }
      });
    }
    await this.loadConfig();
    await this.loadQueues();
    this.startPolling();
  },

  // Saat user ganti device dari dropdown — reset state & reload, tapi pakai cache jika ada
  async onDeviceChange() {
    // Tutup detail panel kalau terbuka (queue dari device lama tidak relevan)
    this.closeDetail();
    // Stop polling sementara biar tidak overlap dengan device lama
    this.stopPolling();

    const devId = this._currentDeviceId();
    const devName = _activeDeviceName() || 'MikroTik';
    const cached = this._queueCache.get(devId);

    // Banner instan — kasih feedback ke user bahwa request lagi jalan
    this.showBanner('info', `Menghubungkan ke ${devName}...`);

    if (cached && cached.queues) {
      // Cache hit — tampilkan dulu, lalu refresh di background.
      // User langsung lihat list queue (mungkin agak stale rate-nya, akan di-update polling)
      this.queues = cached.queues;
      this.applyFilter();
      this.updateStats();
    } else {
      // Tidak ada cache — kosongkan & tampilkan skeleton/loader
      this.queues = [];
      this.filteredQueues = [];
      this.renderLoading(`Memuat queue dari ${devName}...`);
    }

    await this.loadQueues();
    this.startPolling();
  },

  _currentDeviceId() {
    const sel = document.getElementById('mikrotikSelector');
    return (sel && sel.value) ? String(sel.value) : '';
  },

  async loadConfig() {
    // Kalau multi-device aktif, banner & config ditangani per-device — skip global config
    if (this.hasSelector) return;
    try {
      const data = await App.api('/mikrotik/config');
      if (data?.data?.configured) {
        document.getElementById('cfgHost').value = data.data.host || '';
        document.getElementById('cfgPort').value = data.data.port || 80;
        document.getElementById('cfgUser').value = data.data.username || 'admin';
        document.getElementById('cfgSSL').value  = data.data.useSSL ? 'true' : 'false';
      } else {
        this.showBanner('info', 'MikroTik belum dikonfigurasi. Klik "MikroTik Config" untuk connect.');
      }
    } catch (e) { /* silent */ }
  },

  async loadQueues() {
    const seq = ++this.loadSeq;
    const devId = this._currentDeviceId();
    const devNameFromSelector = _activeDeviceName();

    // Banner "menghubungkan" — instan, sebelum nunggu response.
    // Kalau cache sudah ada, banner sukses sudah ada dari onDeviceChange — biarkan.
    if (!this._queueCache.has(devId)) {
      this.showBanner('info', devNameFromSelector
        ? `Menghubungkan ke ${devNameFromSelector}...`
        : 'Menghubungkan ke MikroTik...');
    }

    // Active-device info: fire-and-forget (tidak block render queue).
    // Kalau balik sebelum queue selesai, banner di-upgrade. Kalau setelah, juga oke.
    let devInfoPromise = App.api(_withDev('/mikrotik/queues/active-device')).catch(() => null);

    try {
      const data = await App.api(_withDev('/mikrotik/queues'));
      if (seq !== this.loadSeq) return;     // user ganti device di tengah jalan

      if (data?.success) {
        const queues = data.data || [];
        this.queues = queues;
        // Update cache
        this._queueCache.set(devId, { queues, ts: Date.now() });
        this.applyFilter();
        this.updateStats();
        // Trigger pollStats sekali agar rate langsung muncul tanpa nunggu interval
        this.pollStats();

        // Update banner — pakai nama dari selector dulu (instan), upgrade dengan IP setelah devInfo balik
        const baseName = devNameFromSelector || 'MikroTik';
        this.showBanner('success', `Terhubung ke ${baseName}`);
        devInfoPromise.then(devInfo => {
          if (seq !== this.loadSeq) return;
          if (devInfo?.data?.name) {
            const ip = devInfo.data.ip_address ? ` (${devInfo.data.ip_address})` : '';
            this.showBanner('success', `Terhubung ke ${devInfo.data.name}${ip}`);
          }
        });
      } else {
        // Error response — kalau ada cache, jangan hapus list, kasih warning aja
        if (this._queueCache.has(devId)) {
          this.showBanner('error', `${data?.message || 'Gagal refresh queue'} (menampilkan data cache)`);
        } else {
          this.queues = [];
          this.applyFilter();
          this.updateStats();
          this.showBanner('error', data?.message || 'Gagal load queue dari MikroTik');
          this.renderEmpty(data?.message || 'Gagal konek ke MikroTik. Cek konfigurasi device.');
        }
      }
    } catch (err) {
      if (seq !== this.loadSeq) return;
      if (this._queueCache.has(devId)) {
        this.showBanner('error', 'Connection error (menampilkan data cache)');
      } else {
        this.queues = [];
        this.applyFilter();
        this.updateStats();
        this.showBanner('error', 'Connection error — pastikan MikroTik bisa diakses.');
        this.renderEmpty('Connection error — pastikan MikroTik bisa diakses.');
      }
    }
  },

  async pollStats() {
    if (this.pollInflight) return;        // skip overlap
    this.pollInflight = true;
    const seq = this.loadSeq;             // tag dgn versi load saat ini
    try {
      const data = await App.api(_withDev('/mikrotik/queues/stats'));
      // Drop response kalau user sudah ganti device di tengah jalan
      if (seq !== this.loadSeq) return;
      if (!data?.success) return;
      const statsMap = {};
      (data.data || []).forEach(s => { statsMap[s.id] = s; });
      this.queues.forEach(q => {
        const s = statsMap[q.id];
        if (s) { q.rateIn = s.rateIn; q.rateOut = s.rateOut; q.bytesIn = s.bytesIn; q.bytesOut = s.bytesOut; }
      });
      this.updateTableRates(statsMap);
      this.updateStats();
      if (this.selectedQueue) {
        const s = statsMap[this.selectedQueue.id];
        if (s) { this.selectedQueue = { ...this.selectedQueue, ...s }; this.updateDetailLive(s); }
      }
    } catch (e) { /* silent — banner sudah dipasang loadQueues */ }
    finally { this.pollInflight = false; }
  },

  startPolling(interval) {
    this.stopPolling();
    if (interval) this.POLL_INTERVAL = interval;
    this.pollTimer = setInterval(() => this.pollStats(), this.POLL_INTERVAL);
  },
  stopPolling() { if (this.pollTimer) clearInterval(this.pollTimer); },

  applyFilter() {
    const search = (document.getElementById('queueSearch')?.value || '').toLowerCase();
    const status = document.getElementById('filterStatus')?.value || '';
    this.filteredQueues = this.queues.filter(q => {
      const matchSearch = !search || q.name.toLowerCase().includes(search) || (q.target||'').toLowerCase().includes(search) || (q.comment||'').toLowerCase().includes(search);
      const matchStatus = !status || (status === 'active' && !q.disabled) || (status === 'disabled' && q.disabled);
      return matchSearch && matchStatus;
    });
    this.renderTable();
    document.getElementById('queueCount').textContent = `${this.filteredQueues.length} queue`;
  },

  renderTable() {
    const tbody = document.getElementById('queueTbody');
    if (!this.filteredQueues.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16,3 21,3 21,8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>
        <p>Tidak ada queue ditemukan</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = this.filteredQueues.map((q, i) => {
      const [maxUp, maxDown] = (q.maxLimit || '0/0').split('/');
      const rxMbps = bitsToMbps(q.rateIn);
      const txMbps = bitsToMbps(q.rateOut);
      const maxDownMbps = parseSpeed(maxDown);
      const maxUpMbps   = parseSpeed(maxUp);
      const rxPct = maxDownMbps > 0 ? Math.min(100, (rxMbps / maxDownMbps) * 100) : 0;
      const txPct = maxUpMbps   > 0 ? Math.min(100, (txMbps / maxUpMbps)   * 100) : 0;
      const rxColor = rxPct > 90 ? '#dc2626' : rxPct > 70 ? '#ea580c' : '#1d4ed8';
      const txColor = txPct > 90 ? '#dc2626' : txPct > 70 ? '#ea580c' : '#c2410c';
      const rxPctCls = rxPct > 90 ? 'danger' : rxPct > 70 ? 'warn' : '';
      const txPctCls = txPct > 90 ? 'danger' : txPct > 70 ? 'warn' : '';

      const num = String(i + 1).padStart(2, '0');
      const chipsHtml = renderTargetChips(q.target);
      const targetCount = (q.target || '').split(',').filter(Boolean).length;
      const subComment = q.comment
        ? escHtml(q.comment)
        : (targetCount > 1 ? `Aggregate — ${targetCount} targets` : '');

      const prio = Number(q.priority) || 8;
      const prioCls = prio <= 3 ? 'hi' : prio <= 5 ? 'mid' : '';
      const prioLbl = prio <= 3 ? 'top' : prio <= 5 ? 'mid' : 'low';

      const fmtLim = v => v && v !== '0' ? escHtml(v) : '<span class="unlim">∞</span>';

      return `<tr class="${q.disabled ? 'row-disabled' : ''}">
        <td class="num-cell">${num}</td>
        <td>
          <div class="name-cell" onclick="QueuePage.openDetail('${q.id}')">${escHtml(q.name)}</div>
          ${subComment ? `<div class="comment-sub">${subComment}</div>` : ''}
        </td>
        <td class="target-cell">${chipsHtml}</td>
        <td>
          <span class="status-pill ${q.disabled ? 'pill-off' : 'pill-on'}">
            <span class="sdot ${q.disabled ? '' : 'sdot-on'}"></span>
            ${q.disabled ? 'Disabled' : 'Active'}
          </span>
        </td>
        <td class="bw-cell" data-queue-id="${q.id}">
          <div class="bw-line">
            <span class="bw-arr arr-rx">↓</span>
            <span class="bw-val rx rx-rate" style="color:${rxColor}">${rxMbps.toFixed(2)} M</span>
            <div class="bw-bar"><div class="bw-fill rx-bar" style="width:${rxPct}%;background:${rxColor}"></div></div>
            <span class="bw-pct rx-pct ${rxPctCls}">${rxPct.toFixed(0)}%</span>
          </div>
          <div class="bw-line">
            <span class="bw-arr arr-tx">↑</span>
            <span class="bw-val tx tx-rate" style="color:${txColor}">${txMbps.toFixed(2)} M</span>
            <div class="bw-bar"><div class="bw-fill tx-bar" style="width:${txPct}%;background:${txColor}"></div></div>
            <span class="bw-pct tx-pct ${txPctCls}">${txPct.toFixed(0)}%</span>
          </div>
          <div class="bw-limit-sub">
            <span>↓ ${fmtLim(maxDown)}</span>
            <span>↑ ${fmtLim(maxUp)}</span>
          </div>
        </td>
        <td style="text-align:center;">
          <div class="prio-box ${prioCls}" title="Priority ${prio} (${prioLbl})">
            <span class="prio-val">${prio}</span>
            <span class="prio-lbl">${prioLbl}</span>
          </div>
        </td>
        <td>
          <div class="act-group">
            <button class="act-ic act-edit" title="Edit queue" aria-label="Edit" onclick="QueuePage.openEdit('${q.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M16.5 4.5l3 3M4 20l4.5-1 11-11-3-3-11 11L4 20z"/>
              </svg>
            </button>
            <button class="act-ic ${q.disabled ? 'act-play' : 'act-pause'}" title="${q.disabled ? 'Aktifkan queue' : 'Nonaktifkan queue'}" aria-label="${q.disabled ? 'Enable' : 'Disable'}" onclick="QueuePage.toggleQueue('${q.id}',${q.disabled})">
              ${q.disabled
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5.5v13l11-6.5z"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5.5v13M15 5.5v13"/></svg>'}
            </button>
            <button class="act-ic act-del" title="Hapus queue" aria-label="Delete" onclick="QueuePage.deleteQueue('${q.id}','${escHtml(q.name).replace(/'/g, '&#39;')}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M10 11v6M14 11v6"/>
              </svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  },

  expandTargets(btn) {
    const cell = btn.closest('.target-cell');
    if (!cell) return;
    const chips = cell.querySelectorAll('.ip-chip.hidden-chip');
    chips.forEach(c => c.classList.remove('hidden-chip'));
    chips.forEach(c => c.style.display = '');
    btn.remove();
  },

  renderEmpty(msg) {
    document.getElementById('queueTbody').innerHTML = `<tr><td colspan="7"><div class="tbl-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16,3 21,3 21,8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>
      <p>${msg}</p>
    </div></td></tr>`;
  },

  // Skeleton rows — terasa lebih responsif daripada teks "Memuat..." statis
  renderLoading(msg) {
    msg = msg || 'Memuat queue...';
    const skeletonRow = `
      <tr class="q-skel-row">
        <td class="num-cell"><span class="q-skel q-skel-text" style="width:18px"></span></td>
        <td>
          <div class="q-skel q-skel-text" style="width:140px;height:13px"></div>
          <div class="q-skel q-skel-text" style="width:90px;height:10px;margin-top:4px"></div>
        </td>
        <td><div class="q-skel q-skel-text" style="width:120px;height:18px;border-radius:5px"></div></td>
        <td><div class="q-skel q-skel-text" style="width:60px;height:18px;border-radius:20px"></div></td>
        <td>
          <div class="q-skel q-skel-text" style="width:160px;height:8px;margin-bottom:6px"></div>
          <div class="q-skel q-skel-text" style="width:160px;height:8px"></div>
        </td>
        <td style="text-align:center;"><div class="q-skel q-skel-text" style="width:36px;height:36px;border-radius:10px;margin:0 auto"></div></td>
        <td><div class="q-skel q-skel-text" style="width:96px;height:28px;border-radius:9px;margin-left:auto"></div></td>
      </tr>`;
    const rows = Array(6).fill(skeletonRow).join('');
    const tbody = document.getElementById('queueTbody');
    tbody.innerHTML = rows + (msg ? `
      <tr><td colspan="7" style="padding:10px 14px;">
        <div style="display:flex;align-items:center;gap:8px;color:#94a3b8;font-size:11.5px;">
          <span class="q-spin"></span>
          <span>${escHtml(msg)}</span>
        </div>
      </td></tr>` : '');
  },

  updateTableRates(statsMap) {
    Object.entries(statsMap).forEach(([id, s]) => {
      const cell = document.querySelector(`[data-queue-id="${id}"]`);
      if (!cell) return;
      const q = this.queues.find(q => q.id === id);
      if (!q) return;
      const [maxUp, maxDown] = (q.maxLimit || '0/0').split('/');
      const rxMbps = bitsToMbps(s.rateIn);
      const txMbps = bitsToMbps(s.rateOut);
      const maxDownMbps = parseSpeed(maxDown);
      const maxUpMbps   = parseSpeed(maxUp);
      const rxPct = maxDownMbps > 0 ? Math.min(100, (rxMbps / maxDownMbps) * 100) : 0;
      const txPct = maxUpMbps   > 0 ? Math.min(100, (txMbps / maxUpMbps)   * 100) : 0;
      const rxColor = rxPct > 90 ? '#dc2626' : rxPct > 70 ? '#ea580c' : '#1d4ed8';
      const txColor = txPct > 90 ? '#dc2626' : txPct > 70 ? '#ea580c' : '#c2410c';
      const rxPctCls = rxPct > 90 ? 'danger' : rxPct > 70 ? 'warn' : '';
      const txPctCls = txPct > 90 ? 'danger' : txPct > 70 ? 'warn' : '';

      const rxEl = cell.querySelector('.rx-rate'); if (rxEl) { rxEl.textContent = rxMbps.toFixed(2) + ' M'; rxEl.style.color = rxColor; }
      const txEl = cell.querySelector('.tx-rate'); if (txEl) { txEl.textContent = txMbps.toFixed(2) + ' M'; txEl.style.color = txColor; }
      const rxBar = cell.querySelector('.rx-bar'); if (rxBar) { rxBar.style.width = rxPct + '%'; rxBar.style.background = rxColor; }
      const txBar = cell.querySelector('.tx-bar'); if (txBar) { txBar.style.width = txPct + '%'; txBar.style.background = txColor; }
      const rxPctEl = cell.querySelector('.rx-pct');
      if (rxPctEl) { rxPctEl.textContent = rxPct.toFixed(0) + '%'; rxPctEl.className = 'bw-pct rx-pct ' + rxPctCls; }
      const txPctEl = cell.querySelector('.tx-pct');
      if (txPctEl) { txPctEl.textContent = txPct.toFixed(0) + '%'; txPctEl.className = 'bw-pct tx-pct ' + txPctCls; }
    });
  },

  updateStats() {
    const total = this.queues.length, active = this.queues.filter(q => !q.disabled).length;
    let totalRx = 0, totalTx = 0;
    this.queues.forEach(q => { totalRx += bitsToMbps(q.rateIn || 0); totalTx += bitsToMbps(q.rateOut || 0); });
    const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    s('statTotal', total); s('statActive', active); s('statDisabled', total - active);
    // Auto-scale: kalau ≥ 1000 Mbps tampilkan dlm Gbps; tetap pakai sparkline pill yg ada
    s('statTotalRx', totalRx.toFixed(1));
    s('statTotalTx', totalTx.toFixed(1));
    // Update pill agar unitnya juga ikut auto-scale
    const formatRate = v => v >= 1000 ? (v/1000).toFixed(2) + ' Gbps' : v.toFixed(1) + ' Mbps';
    const qpRx = document.getElementById('qp-rx');
    const qpTx = document.getElementById('qp-tx');
    if (qpRx) qpRx.textContent = '↓ ' + formatRate(totalRx);
    if (qpTx) qpTx.textContent = '↑ ' + formatRate(totalTx);
  },

  openDetail(id) {
    const q = this.queues.find(q => q.id === id);
    if (!q) return;
    this.selectedQueue = q;
    const [maxUp, maxDown] = (q.maxLimit || '0/0').split('/');

    document.getElementById('detailName').textContent   = q.name;

    // Target chip — show first subnet; if multiple, indicate count
    const targetParts = String(q.target || '').split(',').map(s => s.trim()).filter(Boolean);
    const targetEl    = document.getElementById('detailTarget');
    if (targetParts.length === 0) {
      targetEl.textContent = '—';
    } else if (targetParts.length === 1) {
      targetEl.textContent = targetParts[0];
    } else {
      targetEl.textContent = `${targetParts[0]} +${targetParts.length - 1} lainnya`;
      targetEl.title = q.target;
    }

    document.getElementById('detailMaxDown').textContent = maxDown || '—';
    document.getElementById('detailMaxUp').textContent   = maxUp || '—';

    // Priority tier pill
    const prio = Number(q.priority) || 8;
    const prioCls = prio <= 3 ? 'hi' : prio <= 5 ? 'mid' : 'low';
    const prioLbl = prio <= 3 ? 'top' : prio <= 5 ? 'mid' : 'low';
    const prioWrap = document.getElementById('detailPriorityWrap');
    if (prioWrap) prioWrap.innerHTML = `<span class="dinfo-prio ${prioCls}">P${prio} — ${prioLbl}</span>`;

    // Status
    const statusEl = document.getElementById('detailStatus');
    if (q.disabled) {
      statusEl.innerHTML = `<span class="dinfo-sdot" style="background:#94a3b8;animation:none"></span><span style="color:#94a3b8">Disabled</span>`;
    } else {
      statusEl.innerHTML = `<span class="dinfo-sdot"></span><span style="color:#15803d">Active</span>`;
    }

    document.getElementById('detailComment').textContent = q.comment || '—';
    document.getElementById('detailBytesDown').textContent = formatBytes(q.bytesIn);
    document.getElementById('detailBytesUp').textContent   = formatBytes(q.bytesOut);

    // Reset live buffer (timestamps based, not labels)
    const now = Date.now();
    const N = this.MAX_CHART_POINTS;
    const step = 2000; // asumsi polling 2s; data awal spread 2s apart ke belakang
    this.detailChartData = { rx: [], tx: [], ts: [] };
    for (let i = N - 1; i >= 0; i--) {
      this.detailChartData.ts.push(now - i * step);
      this.detailChartData.rx.push(0);
      this.detailChartData.tx.push(0);
    }

    this.updateDetailLive(q);

    // Destroy & build ApexCharts (mirrored area, matching traffic page)
    if (this.detailChart) { try { this.detailChart.destroy(); } catch(e) {} this.detailChart = null; }
    const chartEl = document.getElementById('detailChart');
    chartEl.innerHTML = '';

    const liveSeries = [
      { name: 'Download', data: this.detailChartData.rx.map((v, i) => [this.detailChartData.ts[i], v]) },
      { name: 'Upload',   data: this.detailChartData.tx.map((v, i) => [this.detailChartData.ts[i], -v]) }
    ];

    this.detailChart = new ApexCharts(chartEl, {
      chart: {
        type: 'area', height: 220, background: 'transparent',
        toolbar: { show: false },
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        zoom: { enabled: false },
        animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 350 } },
        sparkline: { enabled: false },
        dropShadow: { enabled: true, top: 2, left: 0, blur: 4, color: '#0f172a', opacity: 0.08 }
      },
      theme: { mode: 'light' },
      series: liveSeries,
      colors: ['#06b6d4', '#f59e0b'],
      fill: {
        type: 'gradient',
        gradient: { type: 'vertical', shadeIntensity: 1, opacityFrom: 0.45, opacityTo: 0.02, stops: [0, 95] }
      },
      stroke: { curve: 'smooth', width: 2.2, lineCap: 'round' },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: {
        borderColor: '#eef2f7', strokeDashArray: 3,
        xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } },
        padding: { top: 10, right: 14, bottom: 0, left: 8 }
      },
      xaxis: {
        type: 'datetime',
        labels: { style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 }, datetimeUTC: false, format: 'HH:mm:ss' },
        axisBorder: { show: false }, axisTicks: { show: false },
        crosshairs: { show: true, stroke: { color: '#cbd5e1', width: 1, dashArray: 3 } }
      },
      yaxis: {
        tickAmount: 5, forceNiceScale: true,
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 },
          formatter: v => {
            const a = Math.abs(v);
            return a >= 1000 ? (a / 1000).toFixed(1) + ' G' : a.toFixed(2) + ' M';
          }
        }
      },
      tooltip: {
        theme: 'light', shared: true, intersect: false, followCursor: true,
        x: { format: 'HH:mm:ss' },
        y: { formatter: (v, { seriesIndex, w }) => {
          const n = w.globals.seriesNames[seriesIndex] || '';
          return Math.abs(v).toFixed(3) + ' Mbps ' + (/Upload|↑/i.test(n) ? '↑' : '↓');
        }},
        style: { fontSize: '11px', fontFamily: 'Plus Jakarta Sans, sans-serif' },
        marker: { show: true }
      },
      markers: { size: 0, hover: { size: 5, sizeOffset: 3 }, strokeWidth: 0 }
    });
    this.detailChart.render();

    document.getElementById('detailPanel').style.display = 'flex';
    this.loadHistory(q.name, this.currentHistoryRange);
  },

  closeDetail() {
    document.getElementById('detailPanel').style.display = 'none';
    this.selectedQueue = null;
    if (this.detailChart) { try { this.detailChart.destroy(); } catch(e) {} this.detailChart = null; }
    if (this.historyChart) { try { this.historyChart.destroy(); } catch(e) {} this.historyChart = null; }
  },

  updateDetailLive(s) {
    const rxMbps = bitsToMbps(s.rateIn || 0), txMbps = bitsToMbps(s.rateOut || 0);
    const rxEl = document.getElementById('detailRxRate'); if (rxEl) rxEl.textContent = rxMbps.toFixed(3);
    const txEl = document.getElementById('detailTxRate'); if (txEl) txEl.textContent = txMbps.toFixed(3);
    if (s.bytesIn !== undefined) {
      const bd = document.getElementById('detailBytesDown'); if (bd) bd.textContent = formatBytes(s.bytesIn);
      const bu = document.getElementById('detailBytesUp');   if (bu) bu.textContent = formatBytes(s.bytesOut);
    }
    if (this.detailChart && this.detailChartData) {
      const now = Date.now();
      this.detailChartData.rx.push(rxMbps); this.detailChartData.rx.shift();
      this.detailChartData.tx.push(txMbps); this.detailChartData.tx.shift();
      this.detailChartData.ts.push(now);    this.detailChartData.ts.shift();
      try {
        this.detailChart.updateSeries([
          { name: 'Download', data: this.detailChartData.rx.map((v, i) => [this.detailChartData.ts[i], v]) },
          { name: 'Upload',   data: this.detailChartData.tx.map((v, i) => [this.detailChartData.ts[i], -v]) }
        ], false);
      } catch (e) { /* chart might be destroyed mid-update */ }
    }
  },

  async loadHistory(queueName, range) {
    range = range || this.currentHistoryRange;
    this.currentHistoryRange = range;
    // Catatan: kolom device_id belum ada di tabel queue_history, jadi history dishare antar device.
    // Tetap kirim device_id untuk forward-compat saat backend di-upgrade.
    const d = await App.api(_withDev('/mikrotik/queues/' + encodeURIComponent(queueName) + '/history?range=' + range));
    const statusEl = document.getElementById('historyStatus');
    const chartEl = document.getElementById('historyChart');

    if (!d?.success || !d.data.length) {
      if (statusEl) statusEl.textContent = 'Belum ada data untuk rentang ' + range + '. Data terekam setiap 1 menit.';
      if (this.historyChart) { try { this.historyChart.destroy(); } catch(e) {} this.historyChart = null; }
      if (chartEl) chartEl.innerHTML = '';
      return;
    }
    if (statusEl) statusEl.textContent = '';
    if (this.historyChart) { try { this.historyChart.destroy(); } catch(e) {} this.historyChart = null; }
    chartEl.innerHTML = '';

    // Mirrored area: Avg DL positif, Avg UL negatif (mirror). Max overlay sebagai line.
    const toPoint = key => d.data.map(r => [new Date(r.time).getTime(), +(r[key] || 0)]);
    const toPointNeg = key => d.data.map(r => [new Date(r.time).getTime(), -(+(r[key] || 0))]);
    const isWide = (range === '7d' || range === '30d');

    const series = [
      { name: 'Avg DL', type: 'area', data: toPoint('avg_rx_mbps') },
      { name: 'Avg UL', type: 'area', data: toPointNeg('avg_tx_mbps') },
      { name: 'Max DL', type: 'line', data: toPoint('max_rx_mbps') },
      { name: 'Max UL', type: 'line', data: toPointNeg('max_tx_mbps') }
    ];

    const options = {
      chart: {
        type: 'area',
        height: 260,
        background: 'transparent',
        toolbar: { show: false },
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        zoom: { enabled: false },
        animations: {
          enabled: true,
          easing: 'linear',
          dynamicAnimation: { speed: 350 }
        },
        sparkline: { enabled: false },
        dropShadow: {
          enabled: true,
          top: 2,
          left: 0,
          blur: 4,
          color: '#0f172a',
          opacity: 0.08
        }
      },
      theme: { mode: 'light' },
      series,
      colors: ['#06b6d4', '#f59e0b', '#0e7490', '#b45309'],
      fill: {
        type: ['gradient', 'gradient', 'solid', 'solid'],
        gradient: {
          type: 'vertical',
          shadeIntensity: 1,
          opacityFrom: 0.45,
          opacityTo: 0.02,
          stops: [0, 95]
        },
        opacity: [1, 1, 1, 1]
      },
      stroke: {
        curve: 'smooth',
        width: [2.2, 2.2, 1.6, 1.6],
        dashArray: [0, 0, 5, 5],
        lineCap: 'round'
      },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: {
        borderColor: '#eef2f7',
        strokeDashArray: 3,
        xaxis: { lines: { show: false } },
        yaxis: { lines: { show: true } },
        padding: { top: 10, right: 14, bottom: 0, left: 8 }
      },
      xaxis: {
        type: 'datetime',
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 },
          datetimeUTC: false,
          format: isWide ? 'dd MMM' : 'HH:mm'
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
        crosshairs: {
          show: true,
          stroke: { color: '#cbd5e1', width: 1, dashArray: 3 }
        }
      },
      yaxis: {
        tickAmount: 5,
        forceNiceScale: true,
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 },
          // Avg/Max UL negatif, tampilkan absolut (+ unit scale)
          formatter: v => {
            const a = Math.abs(v);
            return a >= 1000 ? (a / 1000).toFixed(1) + ' G' : a.toFixed(1) + ' M';
          }
        }
      },
      tooltip: {
        theme: 'light',
        shared: true,
        intersect: false,
        followCursor: true,
        x: { format: isWide ? 'dd MMM yyyy HH:mm' : 'HH:mm:ss' },
        y: {
          formatter: (v, { seriesIndex, w }) => {
            const n = w.globals.seriesNames[seriesIndex] || '';
            return Math.abs(v).toFixed(3) + ' Mbps ' + (/UL|TX|↑/i.test(n) ? '↑' : '↓');
          }
        },
        style: { fontSize: '11px', fontFamily: 'Plus Jakarta Sans, sans-serif' },
        marker: { show: true }
      },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 3 },
        strokeWidth: 0
      }
    };

    this.historyChart = new ApexCharts(chartEl, options);
    this.historyChart.render();
  },

  switchDetailTab(tab) {
    const live = document.getElementById('paneLive'), hist = document.getElementById('paneHistory');
    const tbL  = document.getElementById('tabLive'),  tbH  = document.getElementById('tabHistory');
    if (tab === 'live') {
      live.style.display=''; hist.style.display='none';
      tbL.classList.add('active'); tbH.classList.remove('active');
    } else {
      live.style.display='none'; hist.style.display='';
      tbH.classList.add('active'); tbL.classList.remove('active');
      if (this.selectedQueue) this.loadHistory(this.selectedQueue.name, this.currentHistoryRange);
    }
  },

  switchHistoryRange(range) {
    this.currentHistoryRange = range;
    document.querySelectorAll('.hist-btn').forEach(b => {
      const m = b.getAttribute('onclick').match(/'([^']+)'/);
      if (m) b.classList.toggle('active', m[1] === range);
    });
    if (this.selectedQueue) this.loadHistory(this.selectedQueue.name, range);
  },

  // Isi dropdown Parent dari daftar queue yang ada (kecuali queue itu sendiri saat edit)
  populateParents(selectedParent, excludeName) {
    const sel = document.getElementById('qParent');
    if (!sel) return;
    const cur = selectedParent && selectedParent !== 'none' ? selectedParent : 'none';
    let html = '<option value="none">— Tanpa Parent (top-level) —</option>';
    (this.queues || []).forEach(q => {
      if (excludeName && q.name === excludeName) return; // queue tidak bisa jadi parent dirinya sendiri
      const sel2 = q.name === cur ? ' selected' : '';
      html += `<option value="${String(q.name).replace(/"/g,'&quot;')}"${sel2}>${q.name}</option>`;
    });
    sel.innerHTML = html;
    sel.value = cur;
  },

  openAdd() {
    document.getElementById('modalTitle').textContent = 'Tambah Queue';
    document.getElementById('queueForm').reset();
    document.getElementById('queueId').value = '';
    this.populateParents('none', null);
    document.getElementById('queueModal').style.display = 'flex';
  },

  openEdit(id) {
    const q = this.queues.find(q => q.id === id);
    if (!q) return;
    document.getElementById('modalTitle').textContent = 'Edit Queue';
    document.getElementById('queueId').value   = q.id;
    document.getElementById('qName').value     = q.name;
    document.getElementById('qTarget').value   = q.target;
    const [up, down] = (q.maxLimit || '10M/10M').split('/');
    document.getElementById('qMaxDown').value  = down || '10M';
    document.getElementById('qMaxUp').value    = up || '10M';
    document.getElementById('qPriority').value = q.priority || '8';
    document.getElementById('qDisabled').value = q.disabled ? 'true' : 'false';
    document.getElementById('qComment').value  = q.comment || '';
    this.populateParents(q.parent, q.name);
    document.getElementById('queueModal').style.display = 'flex';
  },

  async saveQueue(e) {
    e.preventDefault();
    const id = document.getElementById('queueId').value;
    const payload = {
      name: document.getElementById('qName').value,
      target: document.getElementById('qTarget').value,
      maxLimit: document.getElementById('qMaxUp').value + '/' + document.getElementById('qMaxDown').value,
      priority: document.getElementById('qPriority').value,
      disabled: document.getElementById('qDisabled').value === 'true',
      comment: document.getElementById('qComment').value,
      parent: (document.getElementById('qParent') || {}).value || 'none'
    };
    const btn = document.getElementById('saveQueue');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      const res = id
        ? await App.api(_withDev('/mikrotik/queues/' + id), { method:'PUT', body:JSON.stringify(payload) })
        : await App.api(_withDev('/mikrotik/queues'), { method:'POST', body:JSON.stringify(payload) });
      if (res?.success) {
        document.getElementById('queueModal').style.display = 'none';
        await this.loadQueues();
        App.showToast('Queue berhasil disimpan', 'success');
      } else { App.showToast(res?.message || 'Gagal simpan', 'error'); }
    } finally { btn.disabled = false; btn.textContent = 'Simpan Queue'; }
  },

  async deleteQueue(id, name) {
    if (!confirm(`Hapus queue "${name}"?`)) return;
    const res = await App.api(_withDev('/mikrotik/queues/' + id), { method:'DELETE' });
    if (res?.success) { await this.loadQueues(); App.showToast('Queue dihapus', 'success'); }
    else App.showToast(res?.message || 'Gagal hapus', 'error');
  },

  async toggleQueue(id, currentlyDisabled) {
    const ep = currentlyDisabled ? `/mikrotik/queues/${id}/enable` : `/mikrotik/queues/${id}/disable`;
    const res = await App.api(_withDev(ep), { method:'POST' });
    if (res?.success) await this.loadQueues();
    else App.showToast(res?.message || 'Gagal', 'error');
  },

  _bannerHideTimer: null,
  showBanner(type, msg) {
    const el = document.getElementById('connectionBanner');
    if (!el) return;

    // Bersihkan timer auto-hide sebelumnya kalau ada
    if (this._bannerHideTimer) {
      clearTimeout(this._bannerHideTimer);
      this._bannerHideTimer = null;
    }

    const cls = { success:'conn-banner conn-success', error:'conn-banner conn-error', info:'conn-banner conn-info' };
    el.className = cls[type] || 'conn-banner conn-info';
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
    el.classList.remove('conn-fadeout');

    // Auto-hide untuk success setelah 4 detik (info/error tetap muncul agar user lihat)
    if (msg && type === 'success') {
      this._bannerHideTimer = setTimeout(() => {
        el.classList.add('conn-fadeout');
        // Setelah animasi fade selesai, baru sembunyikan beneran
        this._bannerHideTimer = setTimeout(() => {
          el.style.display = 'none';
          el.classList.remove('conn-fadeout');
          this._bannerHideTimer = null;
        }, 350);
      }, 4000);
    }
  },

  bindEvents() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('btnAddQueue',     'click',  () => this.openAdd());
    on('closeModal',      'click',  () => { document.getElementById('queueModal').style.display = 'none'; });
    on('cancelModal',     'click',  () => { document.getElementById('queueModal').style.display = 'none'; });
    on('queueForm',       'submit', e => this.saveQueue(e));
    on('queueSearch',     'input',  () => this.applyFilter());
    on('filterStatus',    'change', () => this.applyFilter());
    on('btnRefresh',      'click',  () => this.loadQueues());
    on('btnCloseDetail',  'click',  () => this.closeDetail());
    on('intervalPicker',  'change', e => {
      const val = parseInt(e.target.value) * 1000;
      this.startPolling(val);
      const newMax = Math.max(15, Math.round(90000 / val));
      this.MAX_CHART_POINTS = newMax;
      // Trim/pad detail chart buffer agar konsisten dengan ukuran baru
      if (this.detailChartData && Array.isArray(this.detailChartData.rx)) {
        const cur = this.detailChartData.rx.length;
        if (cur > newMax) {
          // trim depan
          const drop = cur - newMax;
          this.detailChartData.rx.splice(0, drop);
          this.detailChartData.tx.splice(0, drop);
          this.detailChartData.ts.splice(0, drop);
        } else if (cur < newMax && cur > 0) {
          // pad ke depan dengan nilai 0 + timestamp mundur
          const step = val;
          const oldestTs = this.detailChartData.ts[0] || Date.now();
          const need = newMax - cur;
          const padTs = [], padRx = [], padTx = [];
          for (let i = need; i >= 1; i--) {
            padTs.push(oldestTs - i * step);
            padRx.push(0);
            padTx.push(0);
          }
          this.detailChartData.rx = padRx.concat(this.detailChartData.rx);
          this.detailChartData.tx = padTx.concat(this.detailChartData.tx);
          this.detailChartData.ts = padTs.concat(this.detailChartData.ts);
        }
      }
    });
    on('btnConfigMT',     'click',  () => { document.getElementById('configModal').style.display = 'flex'; });
    on('closeConfigModal','click',  () => { document.getElementById('configModal').style.display = 'none'; });
    // Tutup config modal saat klik backdrop
    document.getElementById('configModal')?.addEventListener('click', e => {
      if (e.target === document.getElementById('configModal')) {
        document.getElementById('configModal').style.display = 'none';
      }
    });
    on('btnTestConn', 'click', async () => {
      const cfg = getConfigFromModal();
      const resultEl = document.getElementById('testResult');
      if (!cfg.host || !cfg.username) {
        resultEl.innerHTML = `<span style="color:#dc2626;font-weight:600">✗ Host dan username wajib diisi</span>`;
        return;
      }
      const btn = document.getElementById('btnTestConn');
      btn.disabled = true; btn.textContent = 'Testing...';
      try {
        const res = await App.api('/mikrotik/test', { method:'POST', body:JSON.stringify(cfg) });
        resultEl.innerHTML = res?.success
          ? `<span style="color:#16a34a;font-weight:600">✓ Terhubung: ${res.identity || 'OK'}</span>`
          : `<span style="color:#dc2626;font-weight:600">✗ ${res?.error || res?.message || 'Gagal connect'}</span>`;
      } catch (e) {
        resultEl.innerHTML = `<span style="color:#dc2626;font-weight:600">✗ ${e.message || 'Error'}</span>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Test Connection';
      }
    });
    on('btnSaveConfig', 'click', async () => {
      const cfg = getConfigFromModal();
      if (!cfg.host || !cfg.username) {
        App.showToast('Host dan username wajib diisi', 'error');
        return;
      }
      const btn = document.getElementById('btnSaveConfig');
      btn.disabled = true; btn.textContent = 'Menyimpan...';
      try {
        const res = await App.api('/mikrotik/config', { method:'POST', body:JSON.stringify(cfg) });
        if (res?.success) {
          document.getElementById('configModal').style.display = 'none';
          App.showToast('Config tersimpan', 'success');
          await this.loadConfig();
          await this.loadQueues();
        } else {
          App.showToast(res?.message || 'Gagal simpan config', 'error');
        }
      } catch (e) {
        App.showToast(e.message || 'Error simpan config', 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Simpan Config';
      }
    });

    // Close detail on backdrop click
    document.getElementById('detailPanel')?.addEventListener('click', e => {
      if (e.target === document.getElementById('detailPanel')) this.closeDetail();
    });
    // Close add/edit modal on backdrop click
    document.getElementById('queueModal')?.addEventListener('click', e => {
      if (e.target === document.getElementById('queueModal')) {
        document.getElementById('queueModal').style.display = 'none';
      }
    });
    // ESC = tutup modal/detail manapun yg sedang terbuka
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const detail  = document.getElementById('detailPanel');
      const qm      = document.getElementById('queueModal');
      const cm      = document.getElementById('configModal');
      if (detail && getComputedStyle(detail).display !== 'none') { this.closeDetail(); return; }
      if (qm && qm.style.display === 'flex') { qm.style.display = 'none'; return; }
      if (cm && cm.style.display === 'flex') { cm.style.display = 'none'; return; }
    });
  }
};

function getConfigFromModal() {
  return { host: document.getElementById('cfgHost').value, port: parseInt(document.getElementById('cfgPort').value)||80, username: document.getElementById('cfgUser').value, password: document.getElementById('cfgPass').value, useSSL: document.getElementById('cfgSSL').value === 'true' };
}
function bitsToMbps(val)  { return (parseInt(val) || 0) / 1_000_000; }
function parseSpeed(str) {
  if (!str) return 0;
  str = str.trim().toUpperCase();
  const n = parseFloat(str);
  if (str.endsWith('G')) return n * 1000;
  if (str.endsWith('M')) return n;
  if (str.endsWith('K')) return n / 1000;
  return n / 1_000_000;
}
function formatBytes(val) {
  if (val === undefined || val === null || val === '') return '—';
  const n = parseInt(val) || 0;
  if (n === 0) return '0 B';
  if (n >= 1e12) return (n/1e12).toFixed(2) + ' TB';
  if (n >= 1e9)  return (n/1e9).toFixed(2)  + ' GB';
  if (n >= 1e6)  return (n/1e6).toFixed(2)  + ' MB';
  if (n >= 1e3)  return (n/1e3).toFixed(2)  + ' KB';
  return n + ' B';
}
function escHtml(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Render target as chip list. Split by comma, show first N inline, rest behind "+X more" button.
function renderTargetChips(target, limit = 6) {
  const items = String(target || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) {
    return '<span class="ip-chip" style="color:#cbd5e1;font-style:italic">—</span>';
  }
  const isSingle = items.length === 1;
  const visible = items.slice(0, limit);
  const hidden  = items.slice(limit);
  let html = '<div class="ip-chips">';
  visible.forEach(t => {
    html += `<span class="ip-chip${isSingle ? ' single' : ''}" title="${escHtml(t)}">${escHtml(t)}</span>`;
  });
  hidden.forEach(t => {
    html += `<span class="ip-chip hidden-chip" style="display:none" title="${escHtml(t)}">${escHtml(t)}</span>`;
  });
  if (hidden.length) {
    html += `<button class="ip-more" onclick="event.stopPropagation();QueuePage.expandTargets(this);">+${hidden.length} lagi</button>`;
  }
  html += '</div>';
  return html;
}

document.addEventListener('DOMContentLoaded', () => { if (typeof App !== 'undefined') { App.init(); QueuePage.init(); } });