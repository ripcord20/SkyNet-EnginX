// ============================================
// ISP NetOps - Dashboard (Real-time 2s)
// ============================================

let activityChart = null;
const rxSeries = [];
const txSeries = [];
let currentRange = '2s';       // '2s' | '1m' | '5m'
let pollIntervalMs = 2000;     // default 2 detik
let trafficTimerRef = null;

// Interface yang dipilih user di dropdown Activity Chart.
// Nilai '__all__' (default) = aggregate semua running interfaces.
// Selain itu = nama interface tunggal yang akan dimonitor.
let selectedActivityIface = '__all__';

// MikroTik device selector — pakai shared util (window.MikrotikSelector)
// Helper: append ?device_id=N ke URL (delegate ke shared util)
function withDevice(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

// Berapa maks titik per range
function getMaxPoints() {
  if (currentRange === '2s') return 60;    // 60 × 2s = 2 menit history
  if (currentRange === '1m') return 60;    // 60 × 1m = 60 menit
  return 30;                               // 30 × 5m = 150 menit
}

// Nama interface yang akan di-monitor (diisi saat pertama load)
let monitoredInterfaces = [];

document.addEventListener('DOMContentLoaded', () => {
  // Init shared MikroTik selector (lihat /js/mikrotik-selector.js)
  if (window.MikrotikSelector) {
    window.MikrotikSelector.init({
      selectId: 'mikrotikSelector',
      onChange: () => {
        // Reset chart series saat ganti device
        rxSeries.length = 0; txSeries.length = 0;
        if (activityChart) {
          activityChart.updateSeries([
            { name: 'RX', data: [] },
            { name: 'TX', data: [] }
          ], false);
        }
        monitoredInterfaces = [];
        selectedActivityIface = '__all__';
        loadDashboardData().then(() => {
          // Setelah list interface re-loaded untuk device baru, refresh dropdown
          rebuildActivityIfaceDropdown();
        });
        pollRealtimeTraffic();
      }
    });
  }

  // Init Activity Chart interface selector
  initActivityIfaceSelector();

  waitForApex(() => {
    initActivityChart();
    loadDashboardData().then(() => {
      rebuildActivityIfaceDropdown();
    });
    loadDevices();
    loadBillingStats();
    initRefresh();
    initRangeButtons();
    setInterval(loadDashboardData, 15000);
    startTrafficTimer();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopTrafficTimer(); }
      else { startTrafficTimer(); pollRealtimeTraffic(); }
    });
  });
});

// ─── ACTIVITY CHART INTERFACE SELECTOR ───────────────────────
function initActivityIfaceSelector() {
  const sel = document.getElementById('activityChartIface');
  if (!sel) return;
  sel.addEventListener('change', () => {
    selectedActivityIface = sel.value || '__all__';
    // Reset series + restart polling untuk dataset bersih
    rxSeries.length = 0; txSeries.length = 0;
    if (activityChart) {
      activityChart.updateSeries([
        { name: 'RX', data: [] },
        { name: 'TX', data: [] }
      ], false);
    }
    updateChartStats();
    pollRealtimeTraffic();
  });
}

// Populate dropdown dengan list interface running dari device aktif.
// Dipanggil setelah loadDashboardData / initInterfaceList selesai.
function rebuildActivityIfaceDropdown() {
  const sel = document.getElementById('activityChartIface');
  if (!sel) return;

  const previous = selectedActivityIface;

  // Build options. Default "All Interfaces" → aggregate.
  let html = '<option value="__all__">All Interfaces</option>';
  monitoredInterfaces.forEach(name => {
    html += `<option value="${escHtml(name)}">${escHtml(name)}</option>`;
  });
  sel.innerHTML = html;

  // Restore selection jika masih ada, kalau tidak fallback ke __all__
  if (previous && previous !== '__all__' && monitoredInterfaces.includes(previous)) {
    sel.value = previous;
    selectedActivityIface = previous;
  } else {
    sel.value = '__all__';
    selectedActivityIface = '__all__';
  }
}

function startTrafficTimer() {
  stopTrafficTimer();
  trafficTimerRef = setInterval(pollRealtimeTraffic, pollIntervalMs);
}
function stopTrafficTimer() {
  if (trafficTimerRef) { clearInterval(trafficTimerRef); trafficTimerRef = null; }
}

function initRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const r = btn.dataset.range;
      currentRange = r;
      pollIntervalMs = r === '2s' ? 2000 : r === '1m' ? 60000 : 300000;
      // Clear series dan restart timer
      rxSeries.length = 0; txSeries.length = 0;
      if (activityChart) {
        activityChart.updateSeries([
          { name: 'RX', data: [] },
          { name: 'TX', data: [] }
        ], false);
      }
      startTrafficTimer();
      pollRealtimeTraffic();
    });
  });
}

function waitForApex(cb) {
  if (typeof ApexCharts !== 'undefined') { cb(); return; }
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof ApexCharts !== 'undefined') { clearInterval(t); cb(); }
    else if (tries > 50) { clearInterval(t); console.error('[Dashboard] ApexCharts gagal load'); cb(); }
  }, 100);
}

// ─── LOAD OVERVIEW DATA ──────────────────────────────────────
async function loadDashboardData() {
  const data = await App.api(withDevice('/dashboard/overview'));
  if (!data?.success) return;
  const d = data.data;

  setText('pppoeActiveCount', d.pppoe?.active ?? 0);
  setText('ontOnlineCount',   d.ont?.online   ?? 0);
  setText('ontOfflineCount',  d.ont?.offline  ?? 0);
  setText('cpuLoadAvg',       (d.cpu?.average ?? 0) + '%');
  if (d.cpu?.deviceName) setText('cpuDeviceName', d.cpu.deviceName);

  // Sidebar badges
  const pppoeCount = document.getElementById('pppoe-count');
  if (pppoeCount) {
    const c = d.pppoe?.active || 0;
    pppoeCount.textContent    = c;
    pppoeCount.style.display  = c > 0 ? 'inline' : 'none';
  }
  const ontBadge = document.getElementById('ont-offline-badge');
  if (ontBadge && d.ont?.offline > 0) {
    ontBadge.textContent   = d.ont.offline;
    ontBadge.style.display = 'inline';
  }

  // Jika overview sudah punya interface data, tampilkan
  if (d.interfaces?.length) {
    monitoredInterfaces = d.interfaces.map(i => i.name);
    renderTrafficList(d.interfaces);
    rebuildActivityIfaceDropdown();
  } else {
    // Inisialisasi list interface dari /interfaces
    await initInterfaceList();
    rebuildActivityIfaceDropdown();
  }
}

// ─── INISIALISASI LIST INTERFACE ─────────────────────────────
async function initInterfaceList() {
  const data = await App.api(withDevice('/mikrotik/interfaces'));
  if (!data?.success) return;
  const running = data.data.filter(i => i.running && !i.disabled).slice(0, 8);
  monitoredInterfaces = running.map(i => i.name);

  // Render skeleton list dulu
  const container = document.getElementById('trafficInterfaceList');
  if (!container) return;
  container.innerHTML = running.map(iface => `
    <div class="interface-item" id="iface-row-${safeid(iface.name)}">
      <div class="iface-left">
        <span class="iface-dot up"></span>
        <span class="iface-name">${escHtml(iface.name)}</span>
        ${iface.comment ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px;">${escHtml(iface.comment)}</span>` : ''}
      </div>
      <div class="iface-right">
        <div class="iface-traffic-row">
          <span class="iface-arrow" style="color:#3b82f6;">↓</span>
          <span class="iface-rx" id="rx-${safeid(iface.name)}">— Mbps</span>
        </div>
        <div class="iface-traffic-row">
          <span class="iface-arrow" style="color:#f97316;">↑</span>
          <span class="iface-tx" id="tx-${safeid(iface.name)}">— Mbps</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ─── REAL-TIME POLL SETIAP 2 DETIK ───────────────────────────
async function pollRealtimeTraffic() {
  if (!monitoredInterfaces.length) return;

  try {
    const names = monitoredInterfaces.join(',');
    const data  = await App.api(withDevice(`/mikrotik/interfaces/monitor-selected?names=${encodeURIComponent(names)}`));
    if (!data?.success || !data.data?.length) return;

    let totalRxBps = 0, totalTxBps = 0;
    let chartRxBps = 0, chartTxBps = 0;
    const ifaceData = [];

    data.data.forEach(s => {
      const rxMbps = (s.rxBitsPerSecond / 1_000_000);
      const txMbps = (s.txBitsPerSecond / 1_000_000);

      // Total selalu aggregate semua interface (untuk card "Total Bandwidth"
      // dan sidebar bandwidth bar — angka aggregate tetap relevan terlepas
      // dari interface mana yang dipilih user di Activity Chart).
      totalRxBps += s.rxBitsPerSecond;
      totalTxBps += s.txBitsPerSecond;

      // Chart series tergantung pilihan user:
      //   '__all__'           → aggregate semua interface (sum)
      //   <nama interface>    → hanya interface tersebut
      if (selectedActivityIface === '__all__') {
        chartRxBps += s.rxBitsPerSecond;
        chartTxBps += s.txBitsPerSecond;
      } else if (s.name === selectedActivityIface) {
        chartRxBps = s.rxBitsPerSecond;
        chartTxBps = s.txBitsPerSecond;
      }

      ifaceData.push({ name: s.name, rxMbps, txMbps });

      // Update baris di traffic list
      updateIfaceRow(s.name, rxMbps, txMbps);
    });

    // Update activity chart sesuai filter user
    pushChartPoint(chartRxBps / 1_000_000, chartTxBps / 1_000_000);

    // Update total bandwidth card (selalu aggregate)
    setText('totalBandwidth', (totalRxBps / 1_000_000).toFixed(1));

    // Update sidebar bandwidth bar (selalu aggregate)
    updateBandwidthBar(totalRxBps / 1_000_000);

  } catch (e) { /* silent */ }
}

function updateIfaceRow(name, rxMbps, txMbps) {
  const id   = safeid(name);
  const rxEl = document.getElementById(`rx-${id}`);
  const txEl = document.getElementById(`tx-${id}`);
  if (rxEl) rxEl.textContent = rxMbps.toFixed(2) + ' Mbps';
  if (txEl) txEl.textContent = txMbps.toFixed(2) + ' Mbps';
}

function renderTrafficList(interfaces) {
  const container = document.getElementById('trafficInterfaceList');
  if (!container || !interfaces.length) return;
  container.innerHTML = interfaces.map(iface => `
    <div class="interface-item" id="iface-row-${safeid(iface.name)}">
      <div class="iface-left">
        <span class="iface-dot ${iface.status === 'online' ? 'up' : 'down'}"></span>
        <span class="iface-name">${escHtml(iface.name)}</span>
      </div>
      <div class="iface-right">
        <div class="iface-traffic-row">
          <span class="iface-arrow" style="color:#3b82f6;">↓</span>
          <span class="iface-rx" id="rx-${safeid(iface.name)}">${(iface.rxMbps||0)} Mbps</span>
        </div>
        <div class="iface-traffic-row">
          <span class="iface-arrow" style="color:#f97316;">↑</span>
          <span class="iface-tx" id="tx-${safeid(iface.name)}">${(iface.txMbps||0)} Mbps</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ─── ACTIVITY CHART ───────────────────────────────────────────
function pushChartPoint(rxMbps, txMbps) {
  if (!activityChart) return;
  const now = Date.now();
  rxSeries.push({ x: now, y: parseFloat(rxMbps.toFixed(3)) });
  txSeries.push({ x: now, y: parseFloat(txMbps.toFixed(3)) });
  // Trim series sesuai max points
  const maxPts = getMaxPoints();
  while (rxSeries.length > maxPts) { rxSeries.shift(); txSeries.shift(); }
  activityChart.updateSeries([
    { name: 'RX', data: [...rxSeries] },
    { name: 'TX', data: [...txSeries] }
  ], false);
  updateChartStats();
}

function updateChartStats() {
  const rxVals = rxSeries.map(p => p.y).filter(v => v > 0);
  const txVals = txSeries.map(p => p.y).filter(v => v > 0);
  const maxRx = rxVals.length ? Math.max(...rxVals).toFixed(1) : '0.0';
  const maxTx = txVals.length ? Math.max(...txVals).toFixed(1) : '0.0';
  const avgRx = rxVals.length ? (rxVals.reduce((a,b)=>a+b,0)/rxVals.length).toFixed(1) : '0.0';
  const avgTx = txVals.length ? (txVals.reduce((a,b)=>a+b,0)/txVals.length).toFixed(1) : '0.0';
  setText('maxRx', maxRx + ' Mbps');
  setText('maxTx', maxTx + ' Mbps');
  setText('avgRx', avgRx + ' Mbps');
  setText('avgTx', avgTx + ' Mbps');
}

function initActivityChart() {
  const el = document.getElementById('activityChart');
  if (!el) return;

  activityChart = new ApexCharts(el, {
    chart: {
      type: 'area',
      height: 240,
      animations: {
        enabled: true,
        easing: 'linear',
        dynamicAnimation: { speed: 300 }
      },
      toolbar: { show: false },
      fontFamily: 'DM Sans, sans-serif',
      background: 'transparent',
      zoom: { enabled: false },
      dropShadow: {
        enabled: true,
        top: 8, left: 0, blur: 12,
        color: ['#1e78ff', '#f97316'],
        opacity: 0.12
      }
    },
    series: [
      { name: 'RX', data: [] },
      { name: 'TX', data: [] }
    ],
    colors: ['#1e78ff', '#f97316'],
    fill: {
      type: ['gradient', 'gradient'],
      gradient: {
        type: 'vertical',
        shadeIntensity: 1,
        opacityFrom: 0.35,
        opacityTo: 0.01,
        stops: [0, 100]
      }
    },
    stroke: {
      curve: 'smooth',
      width: [2.5, 2],
      dashArray: [0, 6]
    },
    dataLabels: { enabled: false },
    legend: { show: false },
    grid: {
      borderColor: '#f0f4ff',
      strokeDashArray: 3,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
      padding: { left: 4, right: 4, top: 0, bottom: 0 }
    },
    xaxis: {
      type: 'datetime',
      labels: {
        style: { fontSize: '10px', colors: '#b0bec5', fontWeight: 500 },
        datetimeUTC: false,
        format: 'HH:mm:ss',
        rotate: 0
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
      crosshairs: {
        show: true,
        stroke: { color: '#1e78ff', width: 1, dashArray: 4 }
      }
    },
    yaxis: {
      labels: {
        style: { fontSize: '10px', colors: '#b0bec5', fontWeight: 500 },
        formatter: v => v >= 1000 ? (v/1000).toFixed(1)+'G' : v.toFixed(1)+' M'
      },
      min: 0,
      forceNiceScale: true
    },
    tooltip: {
      theme: 'light',
      shared: true,
      intersect: false,
      x: { format: 'HH:mm:ss' },
      y: { formatter: v => v.toFixed(2) + ' Mbps' },
      style: { fontSize: '12px', fontFamily: 'DM Sans, sans-serif' },
      marker: { show: true },
      custom: function({ series, seriesIndex, dataPointIndex, w }) {
        const rx = series[0][dataPointIndex] ?? 0;
        const tx = series[1][dataPointIndex] ?? 0;
        const t  = new Date(w.globals.seriesX[0][dataPointIndex]);
        const ts = t.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        return `<div style="background:#fff;border:1px solid #e0e8ff;border-radius:10px;padding:10px 14px;box-shadow:0 4px 16px rgba(30,120,255,.12);font-family:'DM Sans',sans-serif;">
          <div style="font-size:10px;color:#94a3b8;font-weight:600;margin-bottom:6px;">${ts}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="width:8px;height:8px;border-radius:50%;background:#1e78ff;display:inline-block;"></span>
            <span style="font-size:12px;color:#1e293b;font-weight:700;">RX ${rx.toFixed(2)} Mbps</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="width:8px;height:8px;border-radius:50%;background:#f97316;display:inline-block;"></span>
            <span style="font-size:12px;color:#1e293b;font-weight:700;">TX ${tx.toFixed(2)} Mbps</span>
          </div>
        </div>`;
      }
    },
    markers: {
      size: 0,
      hover: { size: 5, sizeOffset: 2 }
    }
  });
  activityChart.render();
}

// ─── BANDWIDTH SIDEBAR BAR ────────────────────────────────────
function updateBandwidthBar(rxMbps) {
  const bwFill    = document.getElementById('bw-fill');
  const bwPercent = document.getElementById('bw-percent');
  const bwTime    = document.getElementById('bw-time');
  if (bwFill) {
    // Kapasitas default 1 Gbps
    const cap = parseFloat(window._bwCapacity || 1000);
    const pct = Math.min(Math.round((rxMbps / cap) * 100), 100);
    bwFill.style.width    = pct + '%';
    if (bwPercent) bwPercent.textContent = pct + '%';
  }
  if (bwTime) bwTime.textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// ─── DEVICE STATUS ────────────────────────────────────────────
async function loadDevices() {
  const statsData = await App.api('/devices/stats');
  if (statsData?.success) {
    const s = statsData.data;
    setText('devOnline',  s.online  ?? 0);
    setText('devOffline', s.offline ?? 0);
    setText('devWarning', s.warning ?? 0);
    setText('devTotal',   s.total   ?? 0);
  }

  const devData = await App.api('/devices?limit=6');
  const list = document.getElementById('deviceList');
  if (!list || !devData?.success) return;
  list.innerHTML = (devData.data || []).map(d => `
    <div class="device-row">
      <div class="dev-info">
        <span class="dev-status-dot ${d.status}"></span>
        <div>
          <div class="dev-name">${escHtml(d.name)}</div>
          <div class="dev-ip">${escHtml(d.ip_address)}</div>
        </div>
      </div>
      <div class="dev-cpu">CPU: ${d.cpu_load || 0}%</div>
    </div>
  `).join('');
}

// ─── BILLING ─────────────────────────────────────────────────
async function loadBillingStats() {
  const data = await App.api('/billing/stats');
  if (!data?.success) return;
  const s = data.data;
  setText('billPaid',     s.paidThisMonth || 0);
  setText('billUnpaid',   s.unpaid        || 0);
  setText('billOverdue',  s.overdue       || 0);
  
  // Update new revenue box
  const revenueEl = document.getElementById('revenueMonthNew');
  if (revenueEl) {
    revenueEl.textContent = App.formatCurrency
      ? App.formatCurrency(s.revenueThisMonth)
      : 'Rp ' + (s.revenueThisMonth || 0).toLocaleString('id-ID');
  }
  
  // Update revenue detail (customer count)
  const detailEl = document.getElementById('revenueDetail');
  if (detailEl) {
    const customerCount = s.paidCustomerCount || s.paidThisMonth || 0;
    detailEl.textContent = `${customerCount} pelanggan bayar`;
  }
  
  // Load total outstanding
  loadTotalOutstanding();
}

// ─── TOTAL OUTSTANDING AMOUNT ────────────────────────────────
async function loadTotalOutstanding() {
  try {
    const data = await App.api('/billing/total-outstanding');
    if (!data?.success) return;

    // Backend mengembalikan total_amount + customer_count (preferred),
    // dengan fallback `total` untuk backward-compat.
    const totalAmount   = (data.data.total_amount != null)
      ? Number(data.data.total_amount)
      : Number(data.data.total || 0);
    const customerCount = Number(data.data.customer_count || 0);

    // Update total outstanding
    const totalEl = document.getElementById('totalOutstanding');
    if (totalEl) {
      totalEl.textContent = App.formatCurrency
        ? App.formatCurrency(totalAmount)
        : `Rp ${totalAmount.toLocaleString('id-ID')}`;

      // Warna konsisten: hijau jika Rp 0 (tidak ada tunggakan),
      // selain itu pakai warna default kotak (orange/amber).
      // Tidak lagi berubah-ubah berdasar amount, agar visual stabil.
      totalEl.style.color = totalAmount > 0 ? '' : '#10b981';
    }

    // Update customer count detail
    const detailEl = document.getElementById('outstandingDetail');
    if (detailEl) {
      detailEl.textContent = `${customerCount} pelanggan`;
    }
  } catch (err) {
    console.error('Error loading total outstanding:', err);
  }
}

// ─── REFRESH ─────────────────────────────────────────────────
function initRefresh() {
  // Tombol "Refresh" di header dashboard.ejs (id="refreshDashboard")
  const btn = document.getElementById('refreshDashboard');
  if (btn) {
    btn.addEventListener('click', () => {
      loadDashboardData();
      loadDevices();
      loadBillingStats();
      pollRealtimeTraffic();
    });
  }
  // Backward-compat: ID lama yang mungkin masih ada di view lain
  const btnOld = document.getElementById('refreshOverview');
  if (btnOld) btnOld.addEventListener('click', () => { loadDashboardData(); loadDevices(); loadBillingStats(); });
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
}

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function safeid(s) {
  return String(s || '').replace(/[^a-zA-Z0-9]/g, '_');
}