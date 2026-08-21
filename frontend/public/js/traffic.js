// traffic.js — Interface Traffic Live Monitor (ApexCharts edition, modernized)

// Helper: append ?device_id=N otomatis kalau MikrotikSelector tersedia.
// Konsisten dengan halaman /monitoring/pppoe — semua call mikrotik
// menghormati device yg dipilih user.
function _withDev(url) {
  return (window.MikrotikSelector && typeof window.MikrotikSelector.withDevice === 'function')
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

const TrafficPage = {
  interfaces: [],
  selected: new Set(),
  apexChart: null,
  pollTimer: null,

  // Warna untuk per-interface chart (palet kaya, high-contrast)
  perIfColors: ['#2563eb','#ea580c','#16a34a','#dc2626','#0891b2','#d97706','#7c3aed','#db2777'],

  INTERVAL: 5000,        // default 5s (sesuai <select id="pollInterval">)
  MAX_PTS: 12,           // default 1m window (60s / 5s = 12 pts)
  timeMin: 1,            // active time range (minutes)
  chartMode: 'aggregate',// 'aggregate' | 'per-interface'

  buf: { rx:[], tx:[], ts:[] },  // aggregate buffer
  bufPer: {},                    // per-interface buffer { name: { rx:[], tx:[], ts:[] } }
  lastPush: 0,
  _eventsBound: false,           // guard supaya bindEvents tidak dobel saat reset

  async init() {
    this.bindEvents();
    await this.loadInterfaces();
    await this.pollTraffic();
    this.startPolling();
    this.bindTimeRange();
    this.bindChartMode();
  },

  // Reset state untuk device baru — dipanggil dari MikrotikSelector.onChange.
  // Hentikan polling lama, buang buffer & chart, lalu re-init data untuk device baru.
  async resetForDevice() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.interfaces = [];
    this.selected.clear();
    this.buf    = { rx:[], tx:[], ts:[] };
    this.bufPer = {};
    this.lastPush = 0;
    if (this.apexChart) {
      try { this.apexChart.destroy(); } catch(_) {}
      this.apexChart = null;
    }
    // Re-render kosong supaya UI tidak nampak data lama
    const grid = document.getElementById('ifaceGrid');
    if (grid) grid.innerHTML = '<div class="loading-state">Memuat interface...</div>';
    const cnt = document.getElementById('ifaceCount');
    if (cnt) cnt.textContent = '— interface';
    // Reload data device baru
    await this.loadInterfaces();
    await this.pollTraffic();
    this.startPolling();
  },

  async loadInterfaces() {
    const data = await App.api(_withDev('/mikrotik/interfaces'));
    if (data?.success) {
      this.interfaces = data.data;
      this.renderCards();
      this.updateSummary();
      document.getElementById('ifaceCount').textContent = `${this.interfaces.length} interface`;
    } else {
      document.getElementById('ifaceGrid').innerHTML =
        `<div class="loading-state" style="color:#dc2626;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <br>${data?.message || 'Gagal memuat interface'}
        </div>`;
    }
  },

  async pollTraffic() {
    const data = await App.api(_withDev('/mikrotik/interfaces/monitor'));
    if (!data?.success) return;

    const statsMap = {};
    data.data.forEach(s => { statsMap[s.name] = s; });

    // Sinkronkan rx/tx rate ke objek interface, reset ke 0 jika tidak ada di statsMap
    this.interfaces.forEach(iface => {
      const s = statsMap[iface.name];
      if (s) {
        iface._rxBps = s.rxBitsPerSecond;
        iface._txBps = s.txBitsPerSecond;
      } else {
        iface._rxBps = 0;
        iface._txBps = 0;
      }
    });

    this.updateCards(statsMap);
    this.pushChartData(data.data);
    this.updateSummary();
  },

  startPolling() {
    const interval = parseInt(document.getElementById('pollInterval').value) || 5000;
    this.INTERVAL = interval;
    this.MAX_PTS = Math.max(10, Math.ceil(this.timeMin * 60 * 1000 / this.INTERVAL));
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollTraffic(), interval);
  },

  renderCards() {
    const grid = document.getElementById('ifaceGrid');
    if (!this.interfaces.length) {
      grid.innerHTML = `<div class="loading-state">Tidak ada interface ditemukan</div>`;
      return;
    }

    // Reset sparkline buffer per card (supaya fresh on re-render)
    if (!this._cardSpark) this._cardSpark = {};

    grid.innerHTML = this.interfaces.map((iface) => {
      const sel = this.selected.has(iface.name);
      const up  = iface.running;
      const id  = safeid(iface.name);
      return `
        <div class="iface-card ${sel ? 'selected' : ''} ${!up ? 'card-down' : ''}"
             id="icard-${id}" onclick="TrafficPage.toggleSelect('${esc(iface.name)}')">
          <div class="iface-top">
            <span class="iface-dot ${up ? 'dot-up' : 'dot-down'}"></span>
            <span class="iface-name" title="${esc(iface.name)}">${esc(iface.name)}</span>
            <span class="iface-type-badge">${esc(iface.type)}</span>
            <span class="track-tag ${sel ? 'active' : ''}" id="trk-${id}">
              ${sel
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Tracked'
                : 'Track'}
            </span>
          </div>
          ${iface.comment ? `<div class="iface-comment" title="${esc(iface.comment)}">${esc(iface.comment)}</div>` : ''}
          <div class="iface-rates">
            <div class="rate-cell">
              <div class="rate-head">
                <span class="rate-arrow arrow-rx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="19 12 12 19 5 12"/><line x1="12" y1="5" x2="12" y2="19"/></svg></span>
                <span class="rate-lbl">RX</span>
              </div>
              <div><span class="rate-val rx rx-rate-${id}">0.00</span><span class="rate-unit">Mbps</span></div>
              <div class="rate-spark"><svg viewBox="0 0 100 18" preserveAspectRatio="none">
                <path class="rsp-fill" id="csp-rx-fill-${id}" d="" fill="#1d4ed8" opacity=".14"/>
                <path class="rsp-line" id="csp-rx-line-${id}" d="" stroke="#1d4ed8"/>
              </svg></div>
            </div>
            <div class="rate-cell">
              <div class="rate-head">
                <span class="rate-arrow arrow-tx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="5 12 12 5 19 12"/><line x1="12" y1="19" x2="12" y2="5"/></svg></span>
                <span class="rate-lbl">TX</span>
              </div>
              <div><span class="rate-val tx tx-rate-${id}">0.00</span><span class="rate-unit">Mbps</span></div>
              <div class="rate-spark"><svg viewBox="0 0 100 18" preserveAspectRatio="none">
                <path class="rsp-fill" id="csp-tx-fill-${id}" d="" fill="#c2410c" opacity=".14"/>
                <path class="rsp-line" id="csp-tx-line-${id}" d="" stroke="#c2410c"/>
              </svg></div>
            </div>
          </div>
          <div class="iface-footer">
            <span class="iface-mac" title="${esc(iface.macAddress) || ''}">${esc(iface.macAddress) || 'MAC: —'}</span>
            <span class="status-pill ${up ? 'pill-running' : 'pill-down'}">${up ? 'Running' : 'Down'}</span>
          </div>
        </div>`;
    }).join('');
  },

  updateCards(statsMap) {
    if (!this._cardSpark) this._cardSpark = {};

    Object.entries(statsMap).forEach(([name, s]) => {
      const rxMbps = s.rxBitsPerSecond / 1_000_000;
      const txMbps = s.txBitsPerSecond / 1_000_000;
      const id = safeid(name);
      const rxEl = document.querySelector(`.rx-rate-${id}`);
      const txEl = document.querySelector(`.tx-rate-${id}`);
      // Format: nilai > 100 Mbps → 0 desimal, > 10 Mbps → 1 desimal, sisanya 2 desimal
      const fmt = v => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      if (rxEl) rxEl.textContent = fmt(rxMbps);
      if (txEl) txEl.textContent = fmt(txMbps);

      // Push ke buffer per-card (max 20 points)
      if (!this._cardSpark[name]) this._cardSpark[name] = { rx:[], tx:[] };
      const buf = this._cardSpark[name];
      buf.rx.push(rxMbps); buf.tx.push(txMbps);
      while (buf.rx.length > 20) buf.rx.shift();
      while (buf.tx.length > 20) buf.tx.shift();

      // Render sparkline
      this.renderCardSpark(id, 'rx', buf.rx);
      this.renderCardSpark(id, 'tx', buf.tx);
    });
  },

  renderCardSpark(id, key, vals) {
    if (!vals || vals.length < 2) return;
    const W = 100, H = 18;
    const mn = 0; // baseline dari 0, jadi nilai rendah kelihatan rendah
    const mx = Math.max(...vals, 0.01);
    const rng = mx - mn || 1;
    const pts = vals.map((v, i) => [
      (i / (vals.length - 1)) * W,
      H - ((v - mn) / rng) * (H - 3) - 1.5
    ]);
    // Smooth bezier
    const d = pts.reduce((acc, [x, y], i) => {
      if (!i) return `M${x.toFixed(1)},${y.toFixed(1)}`;
      const [px, py] = pts[i - 1];
      const cx = (px + x) / 2;
      return acc + ` C${cx.toFixed(1)},${py.toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
    }, '');
    const fp = pts[0], lp = pts[pts.length - 1];
    const fill = d + ` L${lp[0].toFixed(1)},${H} L${fp[0].toFixed(1)},${H} Z`;

    const lineEl = document.getElementById(`csp-${key}-line-${id}`);
    const fillEl = document.getElementById(`csp-${key}-fill-${id}`);
    if (lineEl) lineEl.setAttribute('d', d);
    if (fillEl) fillEl.setAttribute('d', fill);
  },

  updateSummary() {
    const running = this.interfaces.filter(i => i.running).length;
    const down    = this.interfaces.filter(i => !i.running && !i.disabled).length;
    let totalRx = 0, totalTx = 0;
    this.interfaces.forEach(i => {
      totalRx += (i._rxBps || 0) / 1_000_000;
      totalTx += (i._txBps || 0) / 1_000_000;
    });
    document.getElementById('sumRunning').textContent = running;
    document.getElementById('sumDown').textContent    = down;
    document.getElementById('sumRx').textContent      = totalRx.toFixed(1);
    document.getElementById('sumTx').textContent      = totalTx.toFixed(1);
  },

  toggleSelect(name) {
    if (this.selected.has(name)) {
      this.selected.delete(name);
    } else {
      if (this.selected.size >= 8) { alert('Maksimal 8 interface untuk live chart'); return; }
      this.selected.add(name);
    }
    this.buf = { rx:[], tx:[], ts:[] };
    this.bufPer = {};
    if (this.apexChart) { try { this.apexChart.destroy(); } catch(e) {} this.apexChart = null; }
    this.updateSelectionUI();
    this.toggleChartVisibility();
    this.refreshPerIfLegend();
  },

  updateSelectionUI() {
    document.getElementById('selectedCount').textContent = `${this.selected.size} selected untuk live chart`;
    this.interfaces.forEach(iface => {
      const card = document.getElementById(`icard-${safeid(iface.name)}`);
      if (!card) return;
      const sel = this.selected.has(iface.name);
      card.classList.toggle('selected', sel);
      const tag = card.querySelector('.track-tag');
      if (tag) {
        tag.className = `track-tag ${sel ? 'active' : ''}`;
        tag.innerHTML = sel
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Tracked'
          : 'Track';
      }
    });
  },

  toggleChartVisibility() {
    const chartEl  = document.getElementById('mainChart');
    const emptyMsg = document.getElementById('emptyChart');
    if (this.selected.size > 0) {
      chartEl.style.display  = 'block';
      emptyMsg.style.display = 'none';
      ['tc-rx-cur','tc-tx-cur','tc-rx-avg','tc-tx-avg','tc-rx-max','tc-tx-max'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '0';
      });
    } else {
      chartEl.style.display  = 'none';
      emptyMsg.style.display = 'flex';
      if (this.apexChart) { try { this.apexChart.destroy(); } catch(e) {} this.apexChart = null; }
    }
  },

  // ── Push data ke buffer + chart ────────────────────────────
  pushChartData(statsArray) {
    if (!this.selected.size) return;

    // Aggregate sum
    let sumRx = 0, sumTx = 0;
    statsArray.forEach(s => {
      if (!this.selected.has(s.name)) return;
      sumRx += (s.rxBitsPerSecond || 0);
      sumTx += (s.txBitsPerSecond || 0);
    });

    const now = Date.now();
    this.buf.rx.push(sumRx);
    this.buf.tx.push(sumTx);
    this.buf.ts.push(now);
    while (this.buf.rx.length > this.MAX_PTS) {
      this.buf.rx.shift(); this.buf.tx.shift(); this.buf.ts.shift();
    }

    // Per-interface buffer
    this.selected.forEach(name => {
      if (!this.bufPer[name]) this.bufPer[name] = { rx:[], tx:[], ts:[] };
      const s = statsArray.find(x => x.name === name);
      this.bufPer[name].rx.push(s ? (s.rxBitsPerSecond || 0) : 0);
      this.bufPer[name].tx.push(s ? (s.txBitsPerSecond || 0) : 0);
      this.bufPer[name].ts.push(now);
      while (this.bufPer[name].rx.length > this.MAX_PTS) {
        this.bufPer[name].rx.shift();
        this.bufPer[name].tx.shift();
        this.bufPer[name].ts.shift();
      }
    });

    // Bersihkan interface yang tidak lagi di-select
    Object.keys(this.bufPer).forEach(name => {
      if (!this.selected.has(name)) delete this.bufPer[name];
    });

    this.lastPush = now;

    if (!this.apexChart) {
      this.createChart();
    } else {
      this.updateChartSeries();
    }

    this.updateChartStats();
  },

  // ── Series builder ─────────────────────────────────────────
  buildSeries() {
    if (this.chartMode === 'per-interface') {
      const series = [];
      const names = Array.from(this.selected);
      names.forEach((name, idx) => {
        const b = this.bufPer[name];
        if (!b) return;
        const color = this.perIfColors[idx % this.perIfColors.length];
        series.push({
          name: `${name} ↓`,
          data: b.rx.map((v, i) => [b.ts[i], v]),
          color
        });
        series.push({
          name: `${name} ↑`,
          data: b.tx.map((v, i) => [b.ts[i], -v]),  // TX negatif (mirrored)
          color
        });
      });
      return series;
    }
    // aggregate mode
    return [
      { name: 'RX Download', data: this.buf.rx.map((v, i) => [this.buf.ts[i], v]),  color: '#06b6d4' },
      { name: 'TX Upload',   data: this.buf.tx.map((v, i) => [this.buf.ts[i], -v]), color: '#f59e0b' }
    ];
  },

  // ── Annotations: peak & avg lines ──────────────────────────
  buildAnnotations() {
    if (this.chartMode === 'per-interface') return { yaxis: [], points: [] };
    if (!this.buf.rx.length) return { yaxis: [], points: [] };

    const rxMax = Math.max(...this.buf.rx);
    const txMax = Math.max(...this.buf.tx);
    const rxAvg = this.buf.rx.reduce((a,b)=>a+b,0) / this.buf.rx.length;
    const txAvg = this.buf.tx.reduce((a,b)=>a+b,0) / this.buf.tx.length;

    const rxPeakIdx = this.buf.rx.indexOf(rxMax);
    const txPeakIdx = this.buf.tx.indexOf(txMax);

    const yaxis = [];
    if (rxAvg > 0) {
      yaxis.push({
        y: rxAvg,
        borderColor: '#06b6d4',
        strokeDashArray: 4,
        opacity: 0.6,
        label: {
          borderColor: '#06b6d4',
          style: { color: '#fff', background: '#06b6d4', fontSize: '10px', fontWeight: 700 },
          text: `avg ↓ ${bpsShort(rxAvg)}`,
          position: 'left',
          offsetX: 70
        }
      });
    }
    if (txAvg > 0) {
      yaxis.push({
        y: -txAvg,
        borderColor: '#f59e0b',
        strokeDashArray: 4,
        opacity: 0.6,
        label: {
          borderColor: '#f59e0b',
          style: { color: '#fff', background: '#f59e0b', fontSize: '10px', fontWeight: 700 },
          text: `avg ↑ ${bpsShort(txAvg)}`,
          position: 'left',
          offsetX: 70
        }
      });
    }

    const points = [];
    if (rxMax > 0 && this.buf.ts[rxPeakIdx]) {
      points.push({
        x: this.buf.ts[rxPeakIdx],
        y: rxMax,
        marker: { size: 6, fillColor: '#fff', strokeColor: '#06b6d4', strokeWidth: 2.5, radius: 2 },
        label: {
          borderColor: '#06b6d4',
          offsetY: -6,
          style: { color: '#fff', background: '#06b6d4', fontSize: '10px', fontWeight: 700, padding: { left:6, right:6, top:2, bottom:2 } },
          text: `peak ${bpsShort(rxMax)}`
        }
      });
    }
    if (txMax > 0 && this.buf.ts[txPeakIdx]) {
      points.push({
        x: this.buf.ts[txPeakIdx],
        y: -txMax,
        marker: { size: 6, fillColor: '#fff', strokeColor: '#f59e0b', strokeWidth: 2.5, radius: 2 },
        label: {
          borderColor: '#f59e0b',
          offsetY: 18,
          style: { color: '#fff', background: '#f59e0b', fontSize: '10px', fontWeight: 700, padding: { left:6, right:6, top:2, bottom:2 } },
          text: `peak ${bpsShort(txMax)}`
        }
      });
    }

    return { yaxis, points };
  },

  createChart() {
    const el = document.getElementById('mainChart');
    if (!el) return;
    el.innerHTML = '';

    const series = this.buildSeries();
    const ann = this.buildAnnotations();

    const options = {
      chart: {
        type: 'area',
        height: 360,
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
      colors: series.map(s => s.color),
      fill: {
        type: 'gradient',
        gradient: {
          type: 'vertical',
          shadeIntensity: 1,
          opacityFrom: 0.45,
          opacityTo: 0.02,
          stops: [0, 95]
        }
      },
      stroke: {
        curve: 'smooth',
        width: 2.2,
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
          format: 'HH:mm:ss'
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
          // TX negatif, tampilkan nilai absolut
          formatter: v => bpsShort(Math.abs(v))
        }
      },
      tooltip: {
        theme: 'light',
        shared: true,
        intersect: false,
        followCursor: true,
        x: { format: 'HH:mm:ss' },
        y: {
          formatter: (v, { seriesIndex, w }) => {
            const n = w.globals.seriesNames[seriesIndex] || '';
            return bps(Math.abs(v)) + ' ' + (/↑|TX/i.test(n) ? '↑' : '↓');
          }
        },
        style: { fontSize: '11px', fontFamily: 'Plus Jakarta Sans, sans-serif' },
        marker: { show: true }
      },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 3 },
        strokeWidth: 0
      },
      annotations: ann
    };

    this.apexChart = new ApexCharts(el, options);
    this.apexChart.render();
  },

  updateChartSeries() {
    if (!this.apexChart) return;
    try {
      const series = this.buildSeries();
      this.apexChart.updateSeries(series, false);

      if (this.chartMode === 'aggregate') {
        const ann = this.buildAnnotations();
        this.apexChart.updateOptions({
          annotations: ann,
          colors: series.map(s => s.color)
        }, false, false);
      } else {
        this.apexChart.updateOptions({
          annotations: { yaxis: [], points: [] },
          colors: series.map(s => s.color)
        }, false, false);
      }
    } catch (e) {
      console.warn('chart update failed, recreate', e);
      try { this.apexChart.destroy(); } catch(_) {}
      this.apexChart = null;
      this.createChart();
    }
  },

  updateChartStats() {
    const s = (arr) => {
      if (!arr.length) return { cur: 0, avg: 0, max: 0 };
      let sum = 0, max = 0;
      arr.forEach(v => { sum += v; if (v > max) max = v; });
      return { cur: arr[arr.length - 1], avg: sum / arr.length, max };
    };
    const rxS = s(this.buf.rx), txS = s(this.buf.tx);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = bpsShort(v); };
    set('tc-rx-cur', rxS.cur); set('tc-rx-avg', rxS.avg); set('tc-rx-max', rxS.max);
    set('tc-tx-cur', txS.cur); set('tc-tx-avg', txS.avg); set('tc-tx-max', txS.max);
  },

  // ── Time range 1m / 5m / 10m / 30m ──────────────────────────
  setTimeRange(min) {
    this.timeMin = min;
    this.MAX_PTS = Math.max(10, Math.ceil(min * 60 * 1000 / this.INTERVAL));
    while (this.buf.rx.length > this.MAX_PTS) {
      this.buf.rx.shift(); this.buf.tx.shift(); this.buf.ts.shift();
    }
    Object.values(this.bufPer).forEach(b => {
      while (b.rx.length > this.MAX_PTS) {
        b.rx.shift(); b.tx.shift(); b.ts.shift();
      }
    });
    document.querySelectorAll('.tc-time-btn').forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.min === min);
    });
    if (this.apexChart) this.updateChartSeries();
  },

  bindTimeRange() {
    document.querySelectorAll('.tc-time-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setTimeRange(+btn.dataset.min));
    });
  },

  // ── Chart mode toggle: Aggregate / Per Interface ───────────
  bindChartMode() {
    document.querySelectorAll('.tc-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === this.chartMode) return;
        this.chartMode = mode;
        document.querySelectorAll('.tc-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const statsEl = document.getElementById('chartAggStats');
        if (statsEl) statsEl.style.display = mode === 'aggregate' ? '' : 'none';
        const legendEl = document.getElementById('chartPerIfLegend');
        if (legendEl) legendEl.style.display = mode === 'per-interface' ? '' : 'none';
        this.refreshPerIfLegend();
        if (this.apexChart) {
          try { this.apexChart.destroy(); } catch(e) {}
          this.apexChart = null;
          this.createChart();
        }
      });
    });
  },

  refreshPerIfLegend() {
    const legendEl = document.getElementById('chartPerIfLegend');
    if (!legendEl) return;
    const names = Array.from(this.selected);
    legendEl.innerHTML = names.map((n, i) => {
      const c = this.perIfColors[i % this.perIfColors.length];
      return `<span class="per-if-chip"><span class="per-if-swatch" style="background:${c}"></span>${esc(n)}</span>`;
    }).join('');
  },

  bindEvents() {
    if (this._eventsBound) return;   // jangan dobel — penting karena init() bisa dipanggil ulang via resetForDevice indirect (kalau ada bug)
    this._eventsBound = true;
    document.getElementById('btnRefresh').addEventListener('click', async () => {
      await this.loadInterfaces();
      await this.pollTraffic();
    });
    document.getElementById('btnSelectAll').addEventListener('click', () => {
      this.selected.clear();
      this.interfaces.filter(i => i.running).slice(0, 8).forEach(i => this.selected.add(i.name));
      this.buf = { rx:[], tx:[], ts:[] };
      this.bufPer = {};
      if (this.apexChart) { try { this.apexChart.destroy(); } catch(e) {} this.apexChart = null; }
      this.updateSelectionUI();
      this.toggleChartVisibility();
      this.refreshPerIfLegend();
    });
    document.getElementById('btnClearAll').addEventListener('click', () => {
      this.selected.clear();
      this.buf = { rx:[], tx:[], ts:[] };
      this.bufPer = {};
      this.updateSelectionUI();
      this.toggleChartVisibility();
      this.refreshPerIfLegend();
    });
    document.getElementById('pollInterval').addEventListener('change', () => this.startPolling());
  }
};

// ── Format helpers ──────────────────────────────────────────
function bps(v, dec) {
  v = +v || 0; dec = dec === undefined ? 2 : dec;
  if (v >= 1e9) return (v / 1e9).toFixed(dec) + ' Gbps';
  if (v >= 1e6) return (v / 1e6).toFixed(dec) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(dec) + ' Kbps';
  return Math.round(v) + ' bps';
}
function bpsShort(v) { return bps(v, 1); }

function esc(s)    { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function safeid(s) { return String(s||'').replace(/[^a-zA-Z0-9]/g,'_'); }

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  if (window.MikrotikSelector) {
    window.MikrotikSelector.init({
      mountId: 'mtSelectorMount',
      selectId: 'mikrotikSelector',
      onReady: () => {
        // Selector siap — initial load aman dijalankan
        TrafficPage.init();
      },
      onChange: () => {
        // User pilih device lain — reset state lalu load ulang
        TrafficPage.resetForDevice();
      }
    });
  } else {
    // Fallback kalau selector script gagal load
    TrafficPage.init();
  }
});