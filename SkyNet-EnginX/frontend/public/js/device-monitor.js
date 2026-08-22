/* ============================================================
   device-monitor.js — Grafana-style Device Monitoring
   ============================================================ */
'use strict';

// ── State ─────────────────────────────────────────────────────
let selectedDeviceId = null;
let pollIntervalMs   = 3000;
let pollTimer        = null;
let isDarkMode       = false;

// ApexCharts instances
let cpuGauge     = null;
let ramGauge     = null;
let diskGauge    = null;

// Grafana panels
const gfCharts = {};  // { cpu, ram, disk, rx, tx, combined }
let currentHistHours = 1;

// Realtime ring buffers — data yang dikumpulkan dari polling
const RT_MAX = 300;  // max 300 titik (~5 menit pada 3s interval, ~2.5 jam pada 30s)
const rtBuf = { cpu:[], ram:[], disk:[], rx:[], tx:[], ts:[] };

function rtPush(cpu, ram, disk, rx, tx) {
  const now = Date.now();
  rtBuf.ts.push(now);
  rtBuf.cpu.push(cpu);
  rtBuf.ram.push(ram);
  rtBuf.disk.push(disk);
  rtBuf.rx.push(rx);
  rtBuf.tx.push(tx);
  // Trim
  if (rtBuf.ts.length > RT_MAX) {
    ['ts','cpu','ram','disk','rx','tx'].forEach(k => rtBuf[k].shift());
  }
  // Update chart realtime jika history belum di-load atau masih sedikit
  if (Object.keys(gfCharts).length > 0) updateGfFromRt();
}

function updateGfFromRt() {
  const ts = rtBuf.ts;
  if (!ts.length) return;
  const mk = (arr) => ts.map((t,i) => ({ x:t, y: parseFloat((arr[i]||0).toFixed(2)) }));

  const defs = [
    { key:'cpu',      series:[{ name:'CPU %',   data:mk(rtBuf.cpu) }],  vals:rtBuf.cpu,  statIds:['gfCpuCur','gfCpuAvg','gfCpuMax'],  unit:'%'  },
    { key:'ram',      series:[{ name:'RAM %',   data:mk(rtBuf.ram) }],  vals:rtBuf.ram,  statIds:['gfRamCur','gfRamAvg','gfRamMax'],  unit:'%'  },
    { key:'disk',     series:[{ name:'Disk %',  data:mk(rtBuf.disk)}],  vals:rtBuf.disk, statIds:['gfDiskCur','gfDiskAvg','gfDiskMax'],unit:'%' },
    { key:'rx',       series:[{ name:'RX Mbps', data:mk(rtBuf.rx)  }],  vals:rtBuf.rx,   statIds:['gfRxCur','gfRxAvg','gfRxMax'],    unit:' M' },
    { key:'tx',       series:[{ name:'TX Mbps', data:mk(rtBuf.tx)  }],  vals:rtBuf.tx,   statIds:['gfTxCur','gfTxAvg','gfTxMax'],    unit:' M' },
    { key:'combined', series:[{ name:'RX', data:mk(rtBuf.rx) },{ name:'TX', data:mk(rtBuf.tx) }],
      vals:rtBuf.rx, vals2:rtBuf.tx, statIds:['gfTotalRx','gfTotalTx'], unit:' M' }
  ];

  const fmt = n => n >= 100 ? Math.round(n) : n.toFixed(1);
  defs.forEach(def => {
    const v = (def.vals||[]).filter(x=>x>0);
    const cur = def.vals.length ? def.vals[def.vals.length-1] : 0;
    const avg = v.length ? (v.reduce((a,b)=>a+b,0)/v.length) : 0;
    const max = v.length ? Math.max(...v) : 0;
    if (def.statIds[0]) setText(def.statIds[0], fmt(cur)+def.unit);
    if (def.statIds[1]) setText(def.statIds[1], fmt(avg)+def.unit);
    if (def.statIds[2]) setText(def.statIds[2], fmt(max)+def.unit);
    if (def.key === 'combined' && def.vals2) {
      const cur2 = def.vals2.length ? def.vals2[def.vals2.length-1] : 0;
      if (def.statIds[1]) setText(def.statIds[1], fmt(cur2)+def.unit);
    }
    if (gfCharts[def.key]) gfCharts[def.key].updateSeries(def.series, false);
  });
}
const $ = id => document.getElementById(id);
const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadThemePreference();
  loadDeviceList();
  initIntervalButtons();
  initGfTimeBtns();

  // Restore last selected device
  const last = localStorage.getItem('dm_device');
  if (last) setTimeout(() => selectDevice(last), 300);
});

// ── Theme ─────────────────────────────────────────────────────
function loadThemePreference() {
  const saved = localStorage.getItem('dm_theme');
  if (saved === 'dark') applyDarkMode(true);
}

function toggleDmTheme() {
  applyDarkMode(!isDarkMode);
  localStorage.setItem('dm_theme', isDarkMode ? 'dark' : 'light');
}

function applyDarkMode(dark) {
  isDarkMode = dark;
  document.getElementById('dmHtml').classList.toggle('dark-mode', dark);
  const icon = $('themeIcon');
  if (dark) {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
  }
  // Update chart themes if mounted
  updateChartTheme();
}

function getChartTheme() {
  return isDarkMode ? 'dark' : 'light';
}

// ── Load device list ──────────────────────────────────────────
async function loadDeviceList() {
  const r = await fetch('/api/device-monitor/devices');
  const j = await r.json();
  if (!j.success) return;

  const sel = $('deviceSelect');
  sel.innerHTML = '<option value="">— Pilih Device —</option>';
  j.data.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.ip_address})`;
    sel.appendChild(opt);
  });
}

// ── Select device ─────────────────────────────────────────────
function selectDevice(id) {
  if (!id) return;
  selectedDeviceId = id;
  localStorage.setItem('dm_device', id);

  $('deviceSelect').value = id;
  $('dmEmpty').style.display     = 'none';
  $('dmDashboard').style.display = 'block';
  $('dmLive').style.display      = 'flex';

  // Destroy old charts
  destroyCharts();

  // Init gauges
  initGauges();

  // Init Grafana chart panels (kosong dulu)
  setTimeout(() => initGfCharts(), 50);

  // Load summary
  loadSummary();

  // Load history
  loadHistory(0.083);

  // Start polling
  startPolling();
}

// ── Polling ───────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollRealtime, pollIntervalMs);
  pollRealtime();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollRealtime() {
  if (!selectedDeviceId) return;
  try {
    const r = await fetch(`/api/device-monitor/${selectedDeviceId}/realtime`);
    const j = await r.json();
    if (!j.success) return;
    const d = j.data;

    updateGauges(d);
    updateStatusBar(d);
    updateTrafficSummary(d);
    updateInterfaceGrid(d.interfaces || []);

    // Push ke realtime ring buffer → update chart langsung
    rtPush(
      Math.min(d.cpu || 0, 100),
      Math.min(d.memPercent || 0, 100),
      Math.min(d.diskPercent || 0, 100),
      d.totalRxMbps || 0,
      d.totalTxMbps || 0
    );

    $('sbLastPoll').textContent = new Date().toLocaleTimeString('id-ID');
  } catch(e) { console.error('[DevMon] poll error:', e); }
}

// ── Summary ───────────────────────────────────────────────────
async function loadSummary() {
  if (!selectedDeviceId) return;
  const r = await fetch(`/api/device-monitor/${selectedDeviceId}/summary`);
  const j = await r.json();
  if (!j.success) return;
  const d = j.data;

  $('sbName').textContent     = d.name || '—';
  $('sbIp').textContent       = d.ip_address || '—';
  $('sbFirmware').textContent = d.firmware || d.raw_data?.firmware || '—';
  $('cpuSub').textContent     = d.brand || d.model || 'Router';

  const protoEl = $('sbProto');
  const pt = d.monitoring_type || 'api';
  protoEl.innerHTML = `<span class="proto-badge ${pt}">${pt.toUpperCase()}</span>`;
}

// ── Update status bar ─────────────────────────────────────────
function updateStatusBar(d) {
  const statusEl = $('sbStatus');
  const status   = d.reachable ? (d.cpu > 90 ? 'warning' : 'online') : 'offline';
  const statusMap = { online:'Online', offline:'Offline', warning:'Warning' };
  statusEl.className   = `dm-status-val dm-status-${status}`;
  statusEl.textContent = statusMap[status] || status;

  if (d.uptime)   $('sbUptime').textContent   = d.uptime;
  if (d.firmware) $('sbFirmware').textContent = d.firmware;

  // Update protokol dari data aktual
  const protoEl = $('sbProto');
  const pt = d.protocol || 'api';
  protoEl.innerHTML = `<span class="proto-badge ${pt}">${pt.toUpperCase()}</span>`;
}

// ── Update gauges ─────────────────────────────────────────────
function updateGauges(d) {
  const cpu  = Math.min(Math.max(d.cpu  || 0, 0), 100);
  const mem  = Math.min(Math.max(d.memPercent  || 0, 0), 100);
  const disk = Math.min(Math.max(d.diskPercent || 0, 0), 100);

  // Update gauge charts
  if (cpuGauge)  cpuGauge.updateSeries([cpu]);
  if (ramGauge)  ramGauge.updateSeries([mem]);
  if (diskGauge) diskGauge.updateSeries([disk]);

  // Update text values
  $('cpuVal').innerHTML  = `${cpu}<span style="font-size:16px;">%</span>`;
  $('ramVal').innerHTML  = `${mem}<span style="font-size:16px;">%</span>`;
  $('diskVal').innerHTML = `${disk}<span style="font-size:16px;">%</span>`;

  // RAM detail
  const memUsed  = d.memUsed  || 0;
  const memTotal = d.memTotal || 0;
  $('ramSub').textContent = memTotal > 0
    ? `${memUsed} / ${memTotal} MB`
    : 'N/A';

  // Disk detail
  const diskFree  = d.diskFree  || 0;
  const diskTotal = d.diskTotal || 0;
  const diskSubEl = $('diskSub');
  if (diskSubEl) {
    diskSubEl.textContent = diskTotal > 0
      ? `${diskFree} MB free / ${diskTotal} MB`
      : 'Flash / HDD';
  }

  // Color coding — threshold based
  setGaugeColor($('cpuVal'),  cpu);
  setGaugeColor($('ramVal'),  mem);
  setGaugeColor($('diskVal'), disk);
}

function setGaugeColor(el, val) {
  el.className = 'dm-gauge-val ' + (val > 90 ? 'clr-danger' : val > 70 ? 'clr-warn' : 'clr-ok');
}

function updateTrafficSummary(d) {
  $('rxVal').textContent = (d.totalRxMbps || 0).toFixed(2);
  $('txVal').textContent = (d.totalTxMbps || 0).toFixed(2);
}

// ── Interface grid ────────────────────────────────────────────
function updateInterfaceGrid(interfaces) {
  const grid = $('ifaceGrid');
  if (!interfaces.length) {
    grid.innerHTML = '<div style="color:var(--dm-muted);font-size:12px;">Tidak ada interface aktif</div>';
    return;
  }
  grid.innerHTML = interfaces.map(i => `
    <div class="dm-iface-card">
      <div class="dm-iface-header">
        <div class="dm-iface-name">
          <span class="dm-iface-dot ${i.running ? '' : 'down'}"></span>
          ${i.name}
        </div>
        <span style="font-size:10px;color:var(--dm-muted);">${i.type || 'ether'}</span>
      </div>
      <div class="dm-iface-traffic">
        <div class="dm-iface-rx">
          <span class="dm-arrow-rx">↓</span>
          ${(i.rxMbps || 0).toFixed(2)} Mbps
        </div>
        <div class="dm-iface-tx">
          <span class="dm-arrow-tx">↑</span>
          ${(i.txMbps || 0).toFixed(2)} Mbps
        </div>
      </div>
    </div>
  `).join('');
}

// ── History charts ────────────────────────────────────────────
async function loadHistory(hours) {
  if (!selectedDeviceId) return;
  currentHistHours = hours;
  try {
    const r = await fetch(`/api/device-monitor/${selectedDeviceId}/history?hours=${hours}`);
    const j = await r.json();
    if (!j.success) return;
    updateGfPanels(j.data);
  } catch(e) {}
}

function updateGfPanels(d) {
  const ts = d.timestamps || [];
  if (!ts.length) {
    // Tidak ada history — tampilkan realtime buffer saja
    if (rtBuf.ts.length) updateGfFromRt();
    return;
  }

  const mk = (arr) => ts.map((t,i) => ({ x: t, y: parseFloat((arr[i] || 0).toFixed(2)) }));

  const panelDefs = [
    { key:'cpu',      el:'gfCpuChart',      color:'#f9a825', series:[{ name:'CPU %',    data: mk(d.cpu)    }], yMax:100, unit:'%',    statIds:['gfCpuCur','gfCpuAvg','gfCpuMax'],   vals: d.cpu    },
    { key:'ram',      el:'gfRamChart',      color:'#7986cb', series:[{ name:'RAM %',    data: mk(d.memory) }], yMax:100, unit:'%',    statIds:['gfRamCur','gfRamAvg','gfRamMax'],   vals: d.memory },
    { key:'disk',     el:'gfDiskChart',     color:'#ef5350', series:[{ name:'Disk %',   data: mk(d.disk)   }], yMax:100, unit:'%',    statIds:['gfDiskCur','gfDiskAvg','gfDiskMax'],vals: d.disk   },
    { key:'rx',       el:'gfRxChart',       color:'#4dd0e1', series:[{ name:'RX Mbps',  data: mk(d.rx)     }], yMax:null,unit:' M',   statIds:['gfRxCur','gfRxAvg','gfRxMax'],     vals: d.rx     },
    { key:'tx',       el:'gfTxChart',       color:'#ff8a65', series:[{ name:'TX Mbps',  data: mk(d.tx)     }], yMax:null,unit:' M',   statIds:['gfTxCur','gfTxAvg','gfTxMax'],     vals: d.tx     },
    { key:'combined', el:'gfCombinedChart', color:null,
      series:[{ name:'RX', data: mk(d.rx) },{ name:'TX', data: mk(d.tx) }],
      colors:['#4dd0e1','#ff8a65'], yMax:null, unit:' M',
      statIds:['gfTotalRx','gfTotalTx'], vals: d.rx, vals2: d.tx }
  ];

  panelDefs.forEach(def => {
    // Update stats
    const v = (def.vals || []).filter(x => x > 0);
    const cur = v.length ? def.vals[def.vals.length-1] : 0;
    const avg = v.length ? (v.reduce((a,b)=>a+b,0)/v.length) : 0;
    const max = v.length ? Math.max(...v) : 0;
    const fmt = n => n >= 100 ? Math.round(n) : n.toFixed(1);
    if (def.statIds[0]) setText(def.statIds[0], fmt(cur) + def.unit);
    if (def.statIds[1]) setText(def.statIds[1], fmt(avg) + def.unit);
    if (def.statIds[2]) setText(def.statIds[2], fmt(max) + def.unit);
    if (def.key === 'combined' && def.vals2) {
      const v2 = def.vals2.filter(x => x > 0);
      const cur2 = v2.length ? def.vals2[def.vals2.length-1] : 0;
      if (def.statIds[1]) setText(def.statIds[1], fmt(cur2) + def.unit);
    }

    // Create or update chart
    const colors = def.colors || [def.color];
    if (gfCharts[def.key]) {
      gfCharts[def.key].updateSeries(def.series, false);
    } else {
      gfCharts[def.key] = createGfPanel(def.el, def.series, colors, def.yMax, def.unit);
    }
  });
}

function initGfCharts() {
  const panelDefs = [
    { key:'cpu',      el:'gfCpuChart',      colors:['#f9a825'], yMax:100,  unit:'%'  },
    { key:'ram',      el:'gfRamChart',      colors:['#7986cb'], yMax:100,  unit:'%'  },
    { key:'disk',     el:'gfDiskChart',     colors:['#ef5350'], yMax:100,  unit:'%'  },
    { key:'rx',       el:'gfRxChart',       colors:['#4dd0e1'], yMax:null, unit:' M' },
    { key:'tx',       el:'gfTxChart',       colors:['#ff8a65'], yMax:null, unit:' M' },
    { key:'combined', el:'gfCombinedChart', colors:['#4dd0e1','#ff8a65'], yMax:null, unit:' M' }
  ];
  const emptyTs = [Date.now() - 10000, Date.now()];
  panelDefs.forEach(def => {
    if (gfCharts[def.key]) return;  // sudah ada
    const series = def.key === 'combined'
      ? [{ name:'RX', data: emptyTs.map(t=>({x:t,y:0})) },{ name:'TX', data: emptyTs.map(t=>({x:t,y:0})) }]
      : [{ name: def.key.toUpperCase(), data: emptyTs.map(t=>({x:t,y:0})) }];
    gfCharts[def.key] = createGfPanel(def.el, series, def.colors, def.yMax, def.unit);
  });
}

function createGfPanel(elId, series, colors, yMax, unit) {
  const el = $(elId);
  if (!el) return null;

  const dark       = isDarkMode;
  const bgColor    = dark ? '#141720' : '#ffffff';
  const gridColor  = dark ? '#1e2130' : '#f0f4f8';
  const labelColor = dark ? '#5a6070' : '#94a3b8';

  const chart = new ApexCharts(el, {
    chart: {
      type: 'area', height: 140,
      background: bgColor,
      toolbar: { show: false },
      fontFamily: "'JetBrains Mono', monospace",
      zoom: { enabled: false },
      animations: { enabled: false },
      sparkline: { enabled: false }
    },
    theme: { mode: dark ? 'dark' : 'light' },
    series,
    colors,
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.45,
        opacityTo: 0.02,
        stops: [0, 100]
      }
    },
    stroke: { curve: 'straight', width: 1.5 },
    dataLabels: { enabled: false },
    legend: { show: false },
    grid: {
      borderColor: gridColor,
      strokeDashArray: 0,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
      padding: { top: 0, right: 8, bottom: 0, left: 0 }
    },
    xaxis: {
      type: 'datetime',
      labels: {
        style: { fontSize: '9px', colors: labelColor, fontFamily: 'DM Sans, sans-serif' },
        datetimeUTC: false,
        format: 'HH:mm'
      },
      axisBorder: { show: false },
      axisTicks: { show: false }
    },
    yaxis: {
      max: yMax || undefined,
      min: 0,
      tickAmount: 3,
      labels: {
        style: { fontSize: '9px', colors: labelColor, fontFamily: 'DM Sans, sans-serif' },
        formatter: v => v >= 1000 ? (v/1000).toFixed(1)+'G' : v.toFixed(1) + (unit || '')
      }
    },
    tooltip: {
      theme: dark ? 'dark' : 'light',
      x: { format: 'HH:mm dd/MM' },
      shared: true, intersect: false,
      style: { fontSize: '11px', fontFamily: 'DM Sans, sans-serif' }
    },
    markers: { size: 0 }
  });
  chart.render();
  return chart;
}

// ── Init gauges (radialBar) ────────────────────────────────────
function initGauges() {
  cpuGauge  = createGauge('cpuGaugeChart',  0, ['#22c55e','#f59e0b','#ef4444']);
  ramGauge  = createGauge('ramGaugeChart',  0, ['#3b82f6','#f59e0b','#ef4444']);
  diskGauge = createGauge('diskGaugeChart', 0, ['#8b5cf6','#f59e0b','#ef4444']);
}

function createGauge(elId, value, colors) {
  const el = $(elId);
  if (!el) return null;

  const chart = new ApexCharts(el, {
    chart: {
      type: 'radialBar',
      height: 150,
      background: 'transparent',
      toolbar: { show: false },
      fontFamily: 'JetBrains Mono, monospace',
      sparkline: { enabled: true },
      animations: { enabled: true, speed: 400 }
    },
    series: [Math.min(value, 100)],
    plotOptions: {
      radialBar: {
        startAngle: -135,
        endAngle:   135,
        hollow: {
          size: '58%',
          background: 'transparent'
        },
        track: {
          background: isDarkMode ? '#2a2d3e' : '#f1f5f9',
          strokeWidth: '100%',
          margin: 4
        },
        dataLabels: { show: false }
      }
    },
    fill: {
      type: 'gradient',
      gradient: {
        shade: 'dark',
        type: 'horizontal',
        colorFrom: colors[0],
        colorTo:   colors[2],
        stops: [0, 70, 100]
      }
    },
    stroke: { lineCap: 'round' },
    states: {
      hover:  { filter: { type: 'none' } },
      active: { filter: { type: 'none' } }
    }
  });
  chart.render();
  return chart;
}

// ── Interval buttons ──────────────────────────────────────────
function initIntervalButtons() {
  document.querySelectorAll('.dm-int-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dm-int-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pollIntervalMs = parseInt(btn.dataset.ms);
      if (selectedDeviceId) startPolling();
    });
  });
}

// ── History tabs ──────────────────────────────────────────────
function initGfTimeBtns() {
  const btns = document.querySelectorAll('.gf-time-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadHistory(parseFloat(btn.dataset.h));
    });
  });
}

// ── Update chart themes ───────────────────────────────────────
function updateChartTheme() {
  const theme      = { mode: getChartTheme() };
  const dark       = isDarkMode;
  const bgColor    = dark ? '#141720' : '#ffffff';
  const gridColor  = dark ? '#1e2130' : '#f0f4f8';
  const labelColor = dark ? '#5a6070' : '#94a3b8';
  const trackBg    = dark ? '#2a2d3e' : '#f1f5f9';

  Object.values(gfCharts).forEach(c => {
    if (!c) return;
    c.updateOptions({
      theme,
      chart:  { background: bgColor },
      grid:   { borderColor: gridColor },
      xaxis:  { labels: { style: { colors: labelColor } } },
      yaxis:  { labels: { style: { colors: labelColor } } },
      tooltip:{ theme: dark ? 'dark' : 'light' }
    }, false, false);
  });

  [cpuGauge, ramGauge, diskGauge].forEach(c => {
    if (!c) return;
    c.updateOptions({
      theme,
      chart: { background: 'transparent' },
      plotOptions: {
        radialBar: { track: { background: trackBg } }
      }
    }, false, false);
  });
}

// ── Destroy charts ────────────────────────────────────────────
function destroyCharts() {
  [cpuGauge, ramGauge, diskGauge, ...Object.values(gfCharts)].forEach(c => {
    if (c) { try { c.destroy(); } catch(e) {} }
  });
  cpuGauge = ramGauge = diskGauge = null;
  Object.keys(gfCharts).forEach(k => delete gfCharts[k]);
  // Clear realtime buffers
  ['ts','cpu','ram','disk','rx','tx'].forEach(k => { rtBuf[k].length = 0; });
}

// Pause polling saat tab hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (selectedDeviceId) startPolling();
});

// ══════════════════════════════════════════════════════════════
// DEVICE MODAL — Add / Edit
// ══════════════════════════════════════════════════════════════

let currentProto = 'api';

function openAddDevice() {
  $('modalTitle').textContent    = 'Tambah Device Baru';
  $('saveDeviceBtn').textContent = 'Simpan Device';
  $('fDeviceId').value           = '';
  $('fName').value = $('fIp').value = $('fBrand').value = $('fModel').value = $('fLocation').value = '';
  $('fApiPort').value   = '80';
  $('fApiUser').value   = '';
  $('fApiPass').value   = '';
  $('fSnmpComm').value  = 'public';
  $('fSnmpPort').value  = '161';
  $('fSnmpVer').value   = '2';
  $('fType').value      = 'router';
  $('fPollInterval').value = '60';
  setProto('api');
  clearTestResult();
  $('deviceModal').classList.add('show');
}

async function openEditDevice(id) {
  try {
    const r = await fetch(`/api/device-monitor/${id}/summary`);
    const j = await r.json();
    if (!j.success) return;
    const d = j.data;

    $('modalTitle').textContent    = 'Edit Device';
    $('saveDeviceBtn').textContent = 'Update Device';
    $('fDeviceId').value = d.id;
    $('fName').value     = d.name || '';
    $('fIp').value       = d.ip_address || '';
    $('fBrand').value    = d.brand || '';
    $('fModel').value    = d.model || '';
    $('fLocation').value = d.location || '';
    $('fType').value     = d.type || 'router';
    $('fPollInterval').value = d.poll_interval || '60';

    const proto = d.monitoring_type || 'api';
    setProto(proto);

    if (proto !== 'snmp') {
      $('fApiPort').value = d.api_port || '80';
      $('fApiUser').value = d.api_username || '';
      $('fApiPass').value = '';  // jangan tampilkan password
    } else {
      $('fSnmpComm').value = d.snmp_community || 'public';
      $('fSnmpPort').value = d.snmp_port || '161';
      $('fSnmpVer').value  = d.snmp_version || '2';
    }

    clearTestResult();
    $('deviceModal').classList.add('show');
  } catch(e) { alert('Gagal memuat data device'); }
}

function closeDeviceModal() {
  $('deviceModal').classList.remove('show');
  clearTestResult();
}

function setProto(proto) {
  currentProto = proto;
  $('fProto').value = proto;

  // Tab active state
  $('tabApi').classList.toggle('active',  proto !== 'snmp');
  $('tabSnmp').classList.toggle('active', proto === 'snmp');

  // Show/hide fields
  $('apiFields').style.display  = proto !== 'snmp' ? 'block' : 'none';
  $('snmpFields').style.display = proto === 'snmp' ? 'block' : 'none';
}

function clearTestResult() {
  const el = $('testResult');
  el.className  = 'dm-test-result';
  el.textContent = '';
}

async function testDeviceConnection() {
  const btn = $('testConnBtn');
  btn.disabled    = true;
  btn.textContent = 'Testing...';
  clearTestResult();

  const proto = $('fProto').value;
  const body  = {
    ip_address:      $('fIp').value.trim(),
    monitoring_type: proto,
    api_port:        $('fApiPort').value  || null,
    api_username:    $('fApiUser').value  || null,
    api_password:    $('fApiPass').value  || null,
    snmp_community:  $('fSnmpComm').value || 'public',
    snmp_version:    $('fSnmpVer').value  || 2,
    snmp_port:       $('fSnmpPort').value || 161
  };

  if (!body.ip_address) {
    showTestResult(false, 'IP Address wajib diisi terlebih dahulu');
    btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1"/></svg> Test Koneksi';
    return;
  }

  try {
    const r = await fetch('/api/device-monitor/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    showTestResult(j.success, j.message);
  } catch(e) {
    showTestResult(false, 'Network error: ' + e.message);
  }

  btn.disabled = false;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1"/></svg> Test Koneksi';
}

function showTestResult(ok, msg) {
  const el = $('testResult');
  el.className  = 'dm-test-result ' + (ok ? 'ok' : 'fail');
  el.textContent = msg;
}

async function saveDevice() {
  const btn  = $('saveDeviceBtn');
  const id   = $('fDeviceId').value;
  const proto = $('fProto').value;

  const name = $('fName').value.trim();
  const ip   = $('fIp').value.trim();
  if (!name || !ip) { showTestResult(false, 'Nama dan IP Address wajib diisi'); return; }

  btn.disabled    = true;
  btn.textContent = 'Menyimpan...';

  const body = {
    name, ip_address: ip,
    type:     $('fType').value,
    brand:    $('fBrand').value    || null,
    model:    $('fModel').value    || null,
    location: $('fLocation').value || null,
    monitoring_type:  proto,
    api_port:         proto !== 'snmp' ? ($('fApiPort').value  || null) : null,
    api_username:     proto !== 'snmp' ? ($('fApiUser').value  || null) : null,
    api_password:     proto !== 'snmp' ? ($('fApiPass').value  || null) : null,
    snmp_community:   proto === 'snmp' ? $('fSnmpComm').value  : 'public',
    snmp_version:     proto === 'snmp' ? parseInt($('fSnmpVer').value) : 2,
    snmp_port:        proto === 'snmp' ? parseInt($('fSnmpPort').value) : 161,
    poll_interval:    parseInt($('fPollInterval').value) || 60
  };

  try {
    const url    = id ? `/api/device-monitor/devices/${id}` : '/api/device-monitor/devices';
    const method = id ? 'PUT' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.success) {
      closeDeviceModal();
      await loadDeviceList();
      // Auto-select device baru jika bukan edit
      if (!id && j.data?.id) selectDevice(j.data.id);
      // Reload jika edit device yang sedang aktif
      if (id && id == selectedDeviceId) loadSummary();
    } else {
      showTestResult(false, 'Error: ' + j.message);
    }
  } catch(e) {
    showTestResult(false, 'Error: ' + e.message);
  }

  btn.disabled    = false;
  btn.textContent = id ? 'Update Device' : 'Simpan Device';
}

async function deleteDevice(id, name) {
  if (!confirm(`Hapus device "${name}"?\n\nSeluruh history log device ini juga akan dihapus.`)) return;
  try {
    const r = await fetch(`/api/device-monitor/devices/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.success) {
      if (id == selectedDeviceId) {
        selectedDeviceId = null;
        stopPolling();
        $('dmDashboard').style.display = 'none';
        $('dmEmpty').style.display     = 'block';
        $('dmLive').style.display      = 'none';
        destroyCharts();
      }
      await loadDeviceList();
    } else {
      alert('Gagal hapus: ' + j.message);
    }
  } catch(e) { alert('Error: ' + e.message); }
}

// Close modal on overlay click
$('deviceModal').addEventListener('click', e => {
  if (e.target === $('deviceModal')) closeDeviceModal();
});

// Override loadDeviceList to add edit/delete buttons per device in dropdown
// dan tambah context menu di status bar
const _origLoadDeviceList = loadDeviceList;
window.loadDeviceList = async function() {
  await _origLoadDeviceList();
  // Inject edit/delete mini buttons di status bar jika device sudah dipilih
  if (selectedDeviceId) injectDeviceActions();
};

function injectDeviceActions() {
  const sbLastPollEl = $('sbLastPoll');
  if (!sbLastPollEl) return;
  // Cari atau buat action container di status bar
  let actContainer = $('dm-dev-actions');
  if (!actContainer) {
    const bar = $('dmStatusBar');
    if (!bar) return;
    const sep = document.createElement('div');
    sep.className = 'dm-sep';
    const wrap = document.createElement('div');
    wrap.id = 'dm-dev-actions';
    wrap.style.cssText = 'display:flex;gap:6px;align-items:center;margin-left:auto;';
    bar.appendChild(sep);
    bar.appendChild(wrap);
    actContainer = wrap;
  }
  actContainer.innerHTML = `
    <button class="dm-edit-btn" onclick="openEditDevice(${selectedDeviceId})">✏ Edit</button>
    <button class="dm-del-btn" onclick="deleteDevice(${selectedDeviceId}, '${$('sbName')?.textContent || ''}')">✕ Hapus</button>
  `;
}