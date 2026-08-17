// ============================================
// FLAYNET.Com - Dashboard Analytics
// New Features: Top Customers, Network Uptime, 
// Ticket Stats, Bandwidth Trends, Customer Growth, Revenue Forecast
// ============================================

let bandwidthTrendsChart = null;
let customerGrowthChart = null;
let revenueForecastChart = null;

// Interface yang dipilih user di Bandwidth Trends.
// String kosong '' = aggregate semua interface.
let selectedBwIface = '';

// Helper: append ?device_id=N ke URL (delegate ke shared util)
function _withDevice(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

// Helper: append &interface=NAME ke URL bandwidth-trends
function _withIface(url, ifaceName) {
  if (!ifaceName) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'interface=' + encodeURIComponent(ifaceName);
}

document.addEventListener('DOMContentLoaded', () => {
  // Peta & alerts tidak butuh ApexCharts → jalankan langsung tanpa menunggu,
  // supaya titik peta muncul tanpa jeda saat halaman pertama dibuka.
  loadDashCustomerMap();
  loadAlerts();

  waitForApex(() => {
    // Load interface list dulu untuk Bandwidth Trends (independen ke chart)
    loadBwInterfaceList().then(() => {
      loadBandwidthTrends();
    });

    loadTopCustomers();
    loadNetworkUptime();
    loadTicketStats();
    loadCustomerGrowth();
    loadRevenueForecast();
    initAnalyticsControls();
  });

  // Listen ke perubahan MikroTik device. dashboard.js sudah init shared
  // selector, jadi di sini cukup pasang event listener tambahan langsung
  // ke elemen <select>-nya. Saat user ganti device → list interface
  // berubah → refresh dropdown bandwidth trends + chart.
  const mtSel = document.getElementById('mikrotikSelector');
  if (mtSel) {
    mtSel.addEventListener('change', () => {
      // Reset filter interface karena interface device A belum tentu sama
      // dengan device B.
      selectedBwIface = '';
      loadBwInterfaceList().then(() => {
        loadBandwidthTrends();
      });
    });
  }
});

function waitForApex(cb) {
  if (typeof ApexCharts !== 'undefined') { cb(); return; }
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof ApexCharts !== 'undefined') { clearInterval(t); cb(); }
    else if (tries > 50) { clearInterval(t); console.error('[Analytics] ApexCharts gagal load'); cb(); }
  }, 100);
}

// ─── ANALYTICS CONTROLS ──────────────────────────────────────
function initAnalyticsControls() {
  // Top Customers Period Selector
  const topCustomersPeriod = document.getElementById('topCustomersPeriod');
  if (topCustomersPeriod) {
    topCustomersPeriod.addEventListener('change', () => loadTopCustomers());
  }

  // Uptime Period Selector
  const uptimePeriod = document.getElementById('uptimePeriod');
  if (uptimePeriod) {
    uptimePeriod.addEventListener('change', () => loadNetworkUptime());
  }

  // Bandwidth Trends Period Selector
  const bandwidthTrendsPeriod = document.getElementById('bandwidthTrendsPeriod');
  if (bandwidthTrendsPeriod) {
    bandwidthTrendsPeriod.addEventListener('change', () => loadBandwidthTrends());
  }

  // Bandwidth Trends Interface Selector
  const bandwidthTrendsIface = document.getElementById('bandwidthTrendsIface');
  if (bandwidthTrendsIface) {
    bandwidthTrendsIface.addEventListener('change', () => {
      selectedBwIface = bandwidthTrendsIface.value || '';
      loadBandwidthTrends();
    });
  }

  // Refresh Dashboard Button
  const refreshBtn = document.getElementById('refreshDashboard');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadTopCustomers();
      loadNetworkUptime();
      loadTicketStats();
      loadBwInterfaceList().then(() => loadBandwidthTrends());
      loadCustomerGrowth();
      loadRevenueForecast();
    });
  }
}

// ─── BANDWIDTH INTERFACE LIST ────────────────────────────────
// Ambil daftar interface yang ada datanya di traffic_data untuk
// device terpilih, populate ke dropdown #bandwidthTrendsIface.
async function loadBwInterfaceList() {
  const sel = document.getElementById('bandwidthTrendsIface');
  if (!sel) return;

  try {
    const data = await App.api(_withDevice('/dashboard/bandwidth-interfaces?days=30'));
    const list = (data?.success && Array.isArray(data.data)) ? data.data : [];

    // Bangun ulang options. Selalu pertahankan "All Interfaces" sebagai default.
    const prev = selectedBwIface;
    let html = '<option value="">All Interfaces</option>';
    list.forEach(item => {
      html += `<option value="${escHtml(item.name)}">${escHtml(item.name)}</option>`;
    });
    sel.innerHTML = html;

    // Restore selection jika masih ada
    const stillExists = prev && list.some(i => i.name === prev);
    sel.value = stillExists ? prev : '';
    selectedBwIface = sel.value;
  } catch (err) {
    console.error('Error loading bandwidth interface list:', err);
    // Reset ke default agar UI tetap usable
    sel.innerHTML = '<option value="">All Interfaces</option>';
    selectedBwIface = '';
  }
}

// ─── TOP CUSTOMERS BY BANDWIDTH ──────────────────────────────
async function loadTopCustomers() {
  const container = document.getElementById('topCustomersList');
  if (!container) return;

  const periodSelect = document.getElementById('topCustomersPeriod');
  const period = periodSelect ? periodSelect.value : 'total';

  try {
    const data = await App.api(`/dashboard/top-customers?limit=10&period=${period}`);
    if (!data?.success || !data.data.length) {
      container.innerHTML = '<div class="empty-state">No customer data available</div>';
      return;
    }

    container.innerHTML = data.data.map((customer, idx) => `
      <div class="customer-bandwidth-item">
        <div class="customer-rank">#${idx + 1}</div>
        <div class="customer-info">
          <div class="customer-name">${escHtml(customer.name)}</div>
          <div class="customer-meta">
            <span class="customer-id">${escHtml(customer.customer_id)}</span>
            <span class="customer-package">${escHtml(customer.package_name || '-')}</span>
          </div>
        </div>
        <div class="customer-usage">
          <div class="usage-gb">${customer.total_gb} GB</div>
          <div class="usage-speed">
            <span style="color:#3b82f6;">↓${customer.avg_download_mbps} Mbps</span>
            <span style="color:#f97316;">↑${customer.avg_upload_mbps} Mbps</span>
          </div>
        </div>
        <div class="usage-bar">
          <div class="usage-fill" style="width: ${Math.min(customer.usage_percent, 100)}%"></div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading top customers:', err);
    container.innerHTML = '<div class="error-state">Failed to load data</div>';
  }
}

// ─── NETWORK UPTIME STATISTICS ───────────────────────────────
async function loadNetworkUptime() {
  const summaryContainer = document.getElementById('uptimeSummary');
  const listContainer = document.getElementById('uptimeDevicesList');
  if (!listContainer) return;

  const periodSelect = document.getElementById('uptimePeriod');
  const period = periodSelect ? periodSelect.value : '7d';

  try {
    const data = await App.api(`/dashboard/network-uptime?period=${period}`);
    if (!data?.success) {
      listContainer.innerHTML = '<div class="empty-state">No uptime data available</div>';
      return;
    }

    // Update summary
    if (summaryContainer) {
      const avgUptime = document.getElementById('avgUptime');
      const criticalDevices = document.getElementById('criticalDevices');
      if (avgUptime) avgUptime.textContent = data.data.summary.average_uptime + '%';
      if (criticalDevices) {
        criticalDevices.textContent = data.data.summary.critical_devices;
        criticalDevices.style.color = data.data.summary.critical_devices > 0 ? '#ef4444' : '#22c55e';
      }
    }

    // Show only devices with uptime < 100% or critical ones (top 5)
    const criticalDevices = data.data.devices
      .filter(d => d.uptime_percent < 100)
      .slice(0, 5);

    if (criticalDevices.length === 0) {
      listContainer.innerHTML = '<div class="success-state">All devices running perfectly!</div>';
      return;
    }

    listContainer.innerHTML = criticalDevices.map(device => {
      const uptimeClass = device.uptime_percent >= 99 ? 'good' : 
                          device.uptime_percent >= 95 ? 'warning' : 'critical';
      return `
        <div class="uptime-device-item">
          <div class="device-info-uptime">
            <span class="device-status-dot ${device.current_status}"></span>
            <div>
              <div class="device-name-uptime">${escHtml(device.device_name)}</div>
              <div class="device-ip-uptime">${escHtml(device.device_ip)}</div>
            </div>
          </div>
          <div class="uptime-value ${uptimeClass}">${device.uptime_percent}%</div>
          <div class="uptime-incidents">
            ${device.downtime_incidents} incidents
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading network uptime:', err);
    listContainer.innerHTML = '<div class="error-state">Failed to load data</div>';
  }
}

// ─── TICKET STATISTICS ───────────────────────────────────────
async function loadTicketStats() {
  const listContainer = document.getElementById('openTicketsList');

  try {
    const data = await App.api('/dashboard/ticket-stats?period=30d');
    if (!data?.success) {
      if (listContainer) listContainer.innerHTML = '<div class="empty-state">Failed to load tickets</div>';
      return;
    }

    const s = data.data.summary;
    setText('openTickets', s.open_tickets);
    setText('resolvedTickets', s.resolved_tickets);
    setText('avgResolutionTime', s.avg_resolution_hours + 'h');

    // Render daftar ticket open. Klik baris → buka /tickets/:id di tab yang sama.
    if (!listContainer) return;

    const openList = Array.isArray(data.data.open_tickets_list)
      ? data.data.open_tickets_list
      : [];

    if (!openList.length) {
      listContainer.innerHTML = '<div class="empty-state">Tidak ada tiket open saat ini</div>';
      return;
    }

    listContainer.innerHTML = openList.map(t => {
      const priority = (t.priority || 'medium').toLowerCase();
      const status   = (t.status   || 'open').toLowerCase();
      const statusLabel = status === 'in_progress' ? 'In Progress'
                        : status === 'pending'     ? 'Pending'
                        : 'Open';

      // Customer info di meta line (kalau ada)
      const customerSpan = t.customer_name
        ? `<span class="ot-customer" title="${escHtml(t.customer_name)}">${escHtml(t.customer_name)}</span>`
        : '';

      // Ticket number prefer dipakai daripada raw id agar lebih bermakna
      const numLabel = t.ticket_number || `#${t.id}`;

      return `
        <a class="open-ticket-item" href="/tickets/${t.id}" title="${escHtml(t.title || '')}">
          <span class="ot-priority ${priority}"></span>
          <div class="ot-body">
            <div class="ot-title">${escHtml(t.title || '(no title)')}</div>
            <div class="ot-meta">
              <span class="ot-num">${escHtml(numLabel)}</span>
              ${customerSpan ? '<span>•</span>' + customerSpan : ''}
            </div>
          </div>
          <span class="ot-status ${status}">${statusLabel}</span>
        </a>
      `;
    }).join('');
  } catch (err) {
    console.error('Error loading ticket stats:', err);
    if (listContainer) {
      listContainer.innerHTML = '<div class="empty-state">Failed to load tickets</div>';
    }
  }
}

// ─── BANDWIDTH TRENDS CHART ──────────────────────────────────
async function loadBandwidthTrends() {
  const chartEl = document.getElementById('bandwidthTrendsChart');
  if (!chartEl) return;

  const periodSelect = document.getElementById('bandwidthTrendsPeriod');
  const period = periodSelect ? periodSelect.value : 'daily';

  // Sync state dari dropdown (jika user mengubah lewat keyboard tanpa event)
  const ifaceSel = document.getElementById('bandwidthTrendsIface');
  if (ifaceSel) selectedBwIface = ifaceSel.value || '';

  try {
    // Bangun URL: filter device dulu (via shared MikroTik selector),
    // lalu tambahkan filter interface (jika dipilih).
    let url = _withDevice(`/dashboard/bandwidth-trends?period=${period}`);
    url = _withIface(url, selectedBwIface);

    const data = await App.api(url);
    if (!data?.success || !data.data.length) {
      // Destroy chart lama jika ada agar empty state benar-benar terlihat
      if (bandwidthTrendsChart) {
        try { bandwidthTrendsChart.destroy(); } catch(_) {}
        bandwidthTrendsChart = null;
      }
      chartEl.innerHTML = '<div class="empty-state">No trend data available</div>';
      return;
    }

    // Prepare chart data
    const categories = data.data.map(d => {
      if (period === 'weekly') {
        return d.date;
      } else if (period === 'realtime') {
        return `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`;
      } else {
        return `${d.date} ${String(d.hour).padStart(2, '0')}:00`;
      }
    }).reverse();

    const avgDownload = data.data.map(d => parseFloat(d.avg_download_mbps)).reverse();
    const avgUpload = data.data.map(d => parseFloat(d.avg_upload_mbps)).reverse();

    if (bandwidthTrendsChart) {
      bandwidthTrendsChart.destroy();
    }

    bandwidthTrendsChart = new ApexCharts(chartEl, {
      chart: {
        type: 'area',
        height: 280,
        toolbar: { show: false },
        fontFamily: 'DM Sans, sans-serif',
        zoom: { enabled: false }
      },
      series: [
        { name: 'Download', data: avgDownload },
        { name: 'Upload', data: avgUpload }
      ],
      colors: ['#3b82f6', '#f97316'],
      dataLabels: { enabled: false },
      stroke: {
        curve: 'smooth',
        width: 2
      },
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 1,
          opacityFrom: 0.4,
          opacityTo: 0.1,
          stops: [0, 100]
        }
      },
      xaxis: {
        categories: categories,
        labels: {
          rotate: -45,
          style: { fontSize: '10px', colors: '#94a3b8' }
        }
      },
      yaxis: {
        labels: {
          formatter: v => v.toFixed(1) + ' Mbps',
          style: { fontSize: '10px', colors: '#94a3b8' }
        }
      },
      grid: {
        borderColor: '#f0f4ff',
        strokeDashArray: 3
      },
      tooltip: {
        shared: true,
        intersect: false,
        y: {
          formatter: v => v.toFixed(2) + ' Mbps'
        }
      },
      legend: {
        position: 'top',
        horizontalAlign: 'right'
      }
    });

    bandwidthTrendsChart.render();

    // Auto-refresh tiap 60 detik kalau mode realtime
    if (window._bwTrendsRefresh) {
      clearInterval(window._bwTrendsRefresh);
      window._bwTrendsRefresh = null;
    }
    if (period === 'realtime') {
      window._bwTrendsRefresh = setInterval(() => loadBandwidthTrends(), 60000);
    }
  } catch (err) {
    console.error('Error loading bandwidth trends:', err);
    chartEl.innerHTML = '<div class="error-state">Failed to load data</div>';
  }
}

// ─── CUSTOMER GROWTH CHART ───────────────────────────────────
async function loadCustomerGrowth() {
  const chartEl = document.getElementById('customerGrowthChart');
  if (!chartEl) return;

  try {
    const data = await App.api('/dashboard/customer-growth?months=12');
    if (!data?.success || !data.data.monthly_data.length) {
      chartEl.innerHTML = '<div class="empty-state">No growth data available</div>';
      return;
    }

    // Update summary stats
    const s = data.data.summary;
    setText('totalCustomersGrowth', s.total_customers);
    const growthRateEl = document.getElementById('growthRate');
    if (growthRateEl) {
      growthRateEl.textContent = (s.growth_rate > 0 ? '+' : '') + s.growth_rate + '%';
      growthRateEl.style.color = s.growth_rate >= 0 ? '#22c55e' : '#ef4444';
    }

    // Prepare chart data
    const categories = data.data.monthly_data.map(d => d.month);
    const newCustomers = data.data.monthly_data.map(d => d.new_customers);
    const cumulativeTotal = data.data.monthly_data.map(d => d.cumulative_total);

    if (customerGrowthChart) {
      customerGrowthChart.destroy();
    }

    customerGrowthChart = new ApexCharts(chartEl, {
      chart: {
        type: 'bar',
        height: 280,
        toolbar: { show: false },
        fontFamily: 'DM Sans, sans-serif'
      },
      series: [
        { name: 'New Customers', type: 'column', data: newCustomers },
        { name: 'Total Customers', type: 'line', data: cumulativeTotal }
      ],
      colors: ['#3b82f6', '#22c55e'],
      plotOptions: {
        bar: {
          borderRadius: 6,
          columnWidth: '50%'
        }
      },
      stroke: {
        width: [0, 3],
        curve: 'smooth'
      },
      dataLabels: { enabled: false },
      xaxis: {
        categories: categories,
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8' }
        }
      },
      yaxis: [
        {
          title: { text: 'New Customers' },
          labels: {
            style: { fontSize: '10px', colors: '#94a3b8' }
          }
        },
        {
          opposite: true,
          title: { text: 'Total Customers' },
          labels: {
            style: { fontSize: '10px', colors: '#94a3b8' }
          }
        }
      ],
      grid: {
        borderColor: '#f0f4ff',
        strokeDashArray: 3
      },
      legend: {
        position: 'top',
        horizontalAlign: 'right'
      },
      tooltip: {
        shared: true,
        intersect: false
      }
    });

    customerGrowthChart.render();
  } catch (err) {
    console.error('Error loading customer growth:', err);
    chartEl.innerHTML = '<div class="error-state">Failed to load data</div>';
  }
}

// ─── REVENUE FORECAST CHART ──────────────────────────────────
async function loadRevenueForecast() {
  const chartEl = document.getElementById('revenueForecastChart');
  if (!chartEl) return;

  try {
    const data = await App.api('/dashboard/revenue-forecast?months=6');
    if (!data?.success) {
      chartEl.innerHTML = '<div class="empty-state">No forecast data available</div>';
      return;
    }

    // Update current month revenue
    const currentRevEl = document.getElementById('currentMonthRevenue');
    if (currentRevEl && App.formatCurrency) {
      currentRevEl.textContent = App.formatCurrency(data.data.summary.current_month_revenue);
    }

    // Combine historical and forecast
    const allData = [...data.data.historical, ...data.data.forecast];
    const categories = allData.map(d => d.month);
    const historical = data.data.historical.map(d => d.total_revenue);
    const forecast = data.data.forecast.map(d => d.forecasted_revenue);

    // Pad historical with nulls for forecast months
    const historicalPadded = [...historical, ...Array(forecast.length).fill(null)];
    // Pad forecast with nulls for historical months
    const forecastPadded = [...Array(historical.length).fill(null), ...forecast];

    if (revenueForecastChart) {
      revenueForecastChart.destroy();
    }

    revenueForecastChart = new ApexCharts(chartEl, {
      chart: {
        type: 'line',
        height: 280,
        toolbar: { show: false },
        fontFamily: 'DM Sans, sans-serif'
      },
      series: [
        { name: 'Actual Revenue', data: historicalPadded },
        { name: 'Forecasted', data: forecastPadded }
      ],
      colors: ['#3b82f6', '#f59e0b'],
      stroke: {
        width: [3, 3],
        curve: 'smooth',
        dashArray: [0, 5]
      },
      dataLabels: { enabled: false },
      xaxis: {
        categories: categories,
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8' }
        }
      },
      yaxis: {
        labels: {
          formatter: v => {
            if (!v) return '';
            return 'Rp ' + (v / 1000000).toFixed(1) + 'M';
          },
          style: { fontSize: '10px', colors: '#94a3b8' }
        }
      },
      grid: {
        borderColor: '#f0f4ff',
        strokeDashArray: 3
      },
      markers: {
        size: 4,
        hover: { size: 6 }
      },
      legend: {
        position: 'top',
        horizontalAlign: 'right'
      },
      tooltip: {
        shared: true,
        intersect: false,
        y: {
          formatter: v => {
            if (!v) return '';
            return App.formatCurrency ? App.formatCurrency(v) : 'Rp ' + v.toLocaleString('id-ID');
          }
        }
      }
    });

    revenueForecastChart.render();
  } catch (err) {
    console.error('Error loading revenue forecast:', err);
    chartEl.innerHTML = '<div class="error-state">Failed to load data</div>';
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
// ═══════════════════════════════════════════════════════════════
// PETA SEBARAN PELANGGAN + STATUS UP/DOWN (dashboard)
// Marker hijau=online, merah=offline. Cluster + popup detail.
// ═══════════════════════════════════════════════════════════════
let _dashMap = null, _dashCluster = null, _dashLastBounds = null;
function _dashEsc(x){ return String(x==null?'':x).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
function _dashDot(color, pulse){
  const dot = `<div style="position:relative;width:15px;height:15px">`
    + (pulse ? `<span class="dash-pulse"></span>` : '')
    + `<div style="position:relative;width:15px;height:15px;border-radius:50%;background:${color};border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);z-index:2"></div>`
    + `</div>`;
  return L.divIcon({
    className:'',
    html: dot,
    iconSize:[15,15], iconAnchor:[7,7], popupAnchor:[0,-7]
  });
}
async function loadDashCustomerMap(){
  const host = document.getElementById('dashCustMap');
  if (!host || typeof L === 'undefined') return;
  if (typeof L.markerClusterGroup !== 'function'){
    host.innerHTML = '<div style="padding:30px;text-align:center;color:#94a3b8">Komponen peta gagal dimuat.</div>'; return;
  }
  if (!_dashMap){
    _dashMap = L.map(host,{scrollWheelZoom:true}).setView([-2.5,118],5);
    const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'});
    const sat = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',{maxZoom:21,subdomains:'0123',attribution:'&copy; Google'});
    const labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',{maxZoom:19});
    const hybrid = L.layerGroup([sat,labels]);
    street.addTo(_dashMap);
    const layers={street,hybrid}; _dashMap._activeBase='street';
    const Ctl=L.Control.extend({ options:{position:'topright'}, onAdd:function(){
      const div=L.DomUtil.create('div','map-toggle');
      div.innerHTML='<button type="button" data-base="street" class="on">Map</button><button type="button" data-base="hybrid">Satellite</button>';
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
        const k=b.dataset.base; if(_dashMap._activeBase===k) return;
        Object.values(layers).forEach(l=>{ if(_dashMap.hasLayer(l)) _dashMap.removeLayer(l); });
        layers[k].addTo(_dashMap); _dashMap._activeBase=k;
        div.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.base===k));
      }));
      return div;
    }});
    _dashMap.addControl(new Ctl());

    // ── Pastikan peta render benar walau container awalnya belum final ──
    // (peta di dalam card yang di-scroll sering ber-size 0 saat init →
    // tile/marker baru muncul setelah interaksi). Pakai observer + retry.
    const _fix = () => { try { _dashMap.invalidateSize(); if (_dashLastBounds && _dashLastBounds.length) _dashMap.fitBounds(_dashLastBounds, {padding:[40,40], maxZoom:15}); } catch(_){} };
    // a) ResizeObserver: panggil tiap kali ukuran container berubah
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(() => _fix()).observe(host); } catch(_){}
    }
    // b) IntersectionObserver: panggil saat peta masuk viewport (di-scroll ke)
    if (typeof IntersectionObserver !== 'undefined') {
      try {
        new IntersectionObserver((entries) => {
          entries.forEach(e => { if (e.isIntersecting) _fix(); });
        }, { threshold: 0.1 }).observe(host);
      } catch(_){}
    }
    // c) Retry bertahap untuk kasus layout lambat
    [120, 350, 700, 1200].forEach(ms => setTimeout(_fix, ms));
  }
  // Setiap loadDashCustomerMap dipanggil, invalidate juga (mis. saat refresh)
  setTimeout(()=>{ try{_dashMap.invalidateSize();}catch(_){} },80);

  // ── TAHAP 1: render titik SEGERA (tanpa cek status, cepat) ──
  try{
    const j = await App.api('/dashboard/customer-map-points?points_only=1');
    if (j && j.success) _dashRenderMarkers(j.data || []);
  }catch(e){ console.warn('loadDashCustomerMap (points):', e.message); }

  // ── TAHAP 2: ambil status online/offline di BACKGROUND, update warna ──
  _dashLoadStatus();
}

// Simpan referensi marker per customer id supaya bisa di-update statusnya
let _dashMarkers = {};

function _dashRenderMarkers(pts){
  const _ce = _dashEsc;
  if (_dashCluster){ _dashMap.removeLayer(_dashCluster); _dashCluster=null; }
  _dashCluster = L.markerClusterGroup({ maxClusterRadius:50, showCoverageOnHover:false });
  _dashMarkers = {};
  const bounds=[];
  pts.forEach(p=>{
    // online: true=hijau, false=merah, null=abu (belum diketahui)
    const m = L.marker([p.latitude,p.longitude], { icon:_dashMarkerIcon(p.online), zIndexOffset: p.online===false ? 1000 : 0 });
    m._cust = p;
    m.bindPopup(_dashPopupHtml(p), { className:'dpop-wrap', maxWidth:240 });
    _dashCluster.addLayer(m);
    _dashMarkers[p.id] = m;
    bounds.push([p.latitude,p.longitude]);
  });
  _dashMap.addLayer(_dashCluster);
  if (bounds.length){ _dashLastBounds = bounds; try{ _dashMap.fitBounds(bounds,{padding:[40,40],maxZoom:15}); }catch(_){} }
}

function _dashMarkerColor(online){ return online===true ? '#16a34a' : online===false ? '#ef4444' : '#94a3b8'; }
function _dashMarkerIcon(online){ return _dashDot(_dashMarkerColor(online), online===false); }
function _dashPopupHtml(p){
  const _ce=_dashEsc;
  const color=_dashMarkerColor(p.online);
  const area=[p.district,p.regency].filter(Boolean).join(', ');
  const initial=(p.name||'?').trim().charAt(0).toUpperCase();
  const statusTxt = p.online===true ? '● Online' : p.online===false ? '● Offline' : '○ Mengecek…';
  return `<div class="dpop">`
    +`<div class="dpop-head" style="background:${color}">`
      +`<span class="ic">${_ce(initial)}</span>`
      +`<span class="tt"><b>${_ce(p.name||'-')}</b><span>${_ce(p.customer_id||'')}</span></span>`
    +`</div>`
    +`<div class="dpop-body">`
      +`<div class="dpop-row"><span class="l">Status</span><span class="v"><span class="dpop-badge" style="background:${color}">${statusTxt}</span></span></div>`
      +(area?`<div class="dpop-row"><span class="l">Area</span><span class="v">${_ce(area)}</span></div>`:'')
      +`<div class="dpop-addr">${_ce(p.address||'-')}</div>`
      +`<a class="dpop-link" href="/customers/profile/${p.id}">View details →</a>`
    +`</div></div>`;
}

// Ambil status online/offline (lambat, cek PPPoE) lalu update warna marker.
async function _dashLoadStatus(){
  try{
    const j = await App.api('/dashboard/customer-map-points');
    if (!j || !j.success) return;
    const upEl=document.getElementById('custMapUp'), dnEl=document.getElementById('custMapDown');
    if(upEl) upEl.textContent = j.up || 0;
    if(dnEl) dnEl.textContent = j.down || 0;
    (j.data||[]).forEach(p=>{
      const m = _dashMarkers[p.id];
      if (!m) return;
      m._cust = p;
      try{ m.setIcon(_dashMarkerIcon(p.online)); m.setZIndexOffset(p.online===false?1000:0); }catch(_){}
      try{ m.setPopupContent(_dashPopupHtml(p)); }catch(_){}
    });
  }catch(e){ console.warn('_dashLoadStatus:', e.message); }
}

// Refresh manual
document.addEventListener('DOMContentLoaded', ()=>{
  const btn=document.getElementById('custMapRefresh');
  if(btn) btn.addEventListener('click', ()=>loadDashCustomerMap());
});

// ═══════════════════════════════════════════════════════════════
// PANEL "NEEDS ATTENTION" — alert aktif (device/ONT/isolir/tiket)
// ═══════════════════════════════════════════════════════════════
let _alertsData = [];
let _alertsFilter = 'all';
const _ALERT_ICONS = {
  device:  {bg:'#fdecef',fg:'#f5365c',svg:'<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>'},
  ont:     {bg:'#fff5e9',fg:'#fb8c00',svg:'<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>'},
  isolir:  {bg:'#fff5e9',fg:'#fb8c00',svg:'<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'},
  ticket:  {bg:'#eef4ff',fg:'#1d4ed8',svg:'<path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a2 2 0 0 0 0 4v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a2 2 0 0 0 0-4z"/>'},
};
function _alertIcon(kind){
  const map={device_offline:'device',ont_offline:'ont',customer_isolated:'isolir',ticket_urgent:'ticket'};
  return _ALERT_ICONS[map[kind]] || _ALERT_ICONS.device;
}
function _alertTimeAgo(t){
  if(!t) return '';
  const diff=(Date.now()-new Date(t).getTime())/1000;
  if(diff<60) return 'baru saja';
  if(diff<3600) return Math.floor(diff/60)+'m lalu';
  if(diff<86400) return Math.floor(diff/3600)+'j lalu';
  return Math.floor(diff/86400)+'h lalu';
}
async function loadAlerts(){
  const list=document.getElementById('alertsList');
  if(!list) return;
  try{
    const j=await App.api('/dashboard/alerts');
    _alertsData=(j&&j.success)?(j.data||[]):[];
    // Badge total
    const badge=document.getElementById('alertsBadge');
    if(badge){
      const crit=j?.counts?.critical||0;
      if(_alertsData.length){ badge.style.display='inline-block'; badge.textContent=_alertsData.length+(crit?` • ${crit} kritis`:''); badge.style.background=crit?'#f5365c':'#fb8c00'; }
      else badge.style.display='none';
    }
    renderAlerts();
  }catch(e){
    list.innerHTML='<div class="alerts-empty">Gagal memuat alert.</div>';
  }
}
function renderAlerts(){
  const list=document.getElementById('alertsList');
  if(!list) return;
  const items=_alertsFilter==='all'?_alertsData:_alertsData.filter(a=>a.kind===_alertsFilter);
  if(!items.length){
    list.innerHTML='<div class="alerts-empty"><span class="ok">✓ Semua aman</span><br>Tidak ada kejadian yang perlu perhatian.</div>';
    return;
  }
  list.innerHTML=items.map(a=>{
    const ic=_alertIcon(a.kind);
    return `<a class="alert-item sev-${a.severity}" href="${a.link||'#'}">
      <span class="ai-ic" style="background:${ic.bg};color:${ic.fg}"><svg width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${ic.svg}</svg></span>
      <span class="ai-body">
        <span class="ai-title">${escHtml(a.title||'-')}</span>
        <span class="ai-detail">${escHtml(a.detail||'')}</span>
      </span>
      <span class="ai-time">${_alertTimeAgo(a.time)}</span>
    </a>`;
  }).join('');
}
// Filter chips + refresh + auto-refresh 60s
document.addEventListener('DOMContentLoaded', ()=>{
  const wrap=document.getElementById('alertsFilters');
  if(wrap){
    wrap.querySelectorAll('.alert-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        wrap.querySelectorAll('.alert-chip').forEach(c=>c.classList.remove('on'));
        chip.classList.add('on');
        _alertsFilter=chip.dataset.f;
        renderAlerts();
      });
    });
  }
  const rf=document.getElementById('alertsRefresh');
  if(rf) rf.addEventListener('click', ()=>loadAlerts());
  setInterval(()=>{ if(typeof loadAlerts==='function') loadAlerts(); }, 60000);
});
