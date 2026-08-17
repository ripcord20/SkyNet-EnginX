// olt-management.js — OLT Management Dashboard (multi-brand, tab-based)
// Pola UI & helper mengikuti olt.js / app.js (App.api, App.showToast).
const OltMgmt = {
  olts: [],
  activeOltId: null,
  activeStyle: 'zte',
  activeTab: 'overview',
  onus: [],
  searchTerm: '',
  searchTimer: null,
  loadingOnu: false,
  // Auto-load (discover) saat halaman dibuka
  autoLoaded: false,         // sudah pernah auto-load untuk OLT aktif?
  ponFilter: 'all',          // filter PON port pada tabel ONU
  statFilter: null,          // filter dari klik stat card (online/offline/badrx)
  portSummaryData: [],       // ringkasan per PON dari discover
  LS_KEY: 'oltMgmt:lastOltId',
  LS_AUTOREFRESH: 'oltMgmt:autoRefresh',   // ingat status toggle auto-refresh
  // Auto-refresh & tren
  autoRefresh: false,
  refreshTimer: null,
  refreshIntervalMs: 30000,
  trend: [],          // [{t, online, avgRx}]
  trendChart: null,
  rxQualityChart: null,

  // Pagination daftar ONU
  onuPage: 1,
  onuPageSize: 50,    // 50 | 100 | 200 | 'all'

  async init() {
    this.bindEvents();
    // Pulihkan status toggle auto-refresh dari kunjungan sebelumnya
    try {
      const saved = localStorage.getItem(this.LS_AUTOREFRESH) === '1';
      const chk = document.getElementById('chkAutoRefresh');
      if (chk && saved) { chk.checked = true; this.setAutoRefresh(true, true); }
    } catch (e) {}
    await this.loadOlts();
  },

  bindEvents() {
    document.getElementById('btnAddOlt').addEventListener('click', () => this.openAddOlt());
    document.getElementById('btnLoadPon').addEventListener('click', () => this.loadOnus());
    const btnReload = document.getElementById('btnReloadAll');
    if (btnReload) btnReload.addEventListener('click', () => this.autoDiscover());
    const btnRefresh = document.getElementById('btnManualRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', () => { this.autoLoaded ? this.autoDiscover() : this.loadOnus(); });
    document.getElementById('btnAddOnu').addEventListener('click', () => {
      // ZTE → wizard provisioning lengkap; merek lain → authorize dasar
      if (this._isZte()) this.openWizard();
      else this.openAddOnu();
    });
    document.getElementById('btnUncfg').addEventListener('click', () => this.openUncfg());
    document.getElementById('ponInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.loadOnus(); });

    const s = document.getElementById('onuSearch');
    s.addEventListener('input', (e) => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.searchTerm = e.target.value.trim(); this.onuPage = 1; this.renderOnus(); }, 200);
    });

    // Pemilih jumlah tampilan ONU (50/100/200/Semua)
    const ps = document.getElementById('onuPageSize');
    if (ps) ps.addEventListener('change', (e) => {
      const v = e.target.value;
      this.onuPageSize = v === 'all' ? 'all' : parseInt(v);
      this.onuPage = 1;
      this.renderOnus();
    });

    // Tab switching
    document.querySelectorAll('.ot-tab').forEach(t => {
      t.addEventListener('click', () => this.switchTab(t.dataset.tab));
    });

    // Auto-refresh toggle
    document.getElementById('chkAutoRefresh').addEventListener('change', (e) => this.setAutoRefresh(e.target.checked));

    // Overview
    document.getElementById('btnLoadSummary').addEventListener('click', () => this.loadPortSummary());
    // Tutup panel detail kualitas redaman
    const rxClose = document.getElementById('rxqDetailClose');
    if (rxClose) rxClose.addEventListener('click', () => {
      this._rxActiveKey = null;
      const p = document.getElementById('rxQualityDetail'); if (p) p.style.display = 'none';
      this.renderRxQuality();
    });
    // VLAN
    document.getElementById('btnLoadVlans').addEventListener('click', () => this.loadVlans());
    document.getElementById('btnAddVlan').addEventListener('click', () => this.openVlanModal());
    // System
    document.getElementById('btnLoadSystem').addEventListener('click', () => this.loadSystem());
    const btnLoadCards = document.getElementById('btnLoadCards');
    if (btnLoadCards) btnLoadCards.addEventListener('click', () => this.loadCards());

    // Tutup modal via klik overlay / Escape.
    // PENTING: onuTrafficModal punya timer polling 3 detik — harus dihentikan
    // saat ditutup via Escape/click-outside, kalau tidak akan terus polling backend.
    const modals = ['oltModal','onuModal','detailModal','uncfgModal','vlanModal','vlanDetailModal','onuVlanModal','onuTrafficModal','wizModal'];
    const self = this;
    const closeModal = (id, m) => {
      if (id === 'onuTrafficModal' && self._stopTrafficTimer) { self._stopTrafficTimer(); self._tfOnuIf = null; }
      if (id === 'vlanDetailModal') self._vlanDetailVid = null;
      m.classList.remove('show');
    };
    modals.forEach(id => {
      const m = document.getElementById(id);
      if (m) m.addEventListener('click', (e) => { if (e.target === m) closeModal(id, m); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      modals.forEach(id => {
        const m = document.getElementById(id);
        if (m && m.classList.contains('show')) closeModal(id, m);
      });
    });
  },

  // ════════════════════ Filter via stat card (clickable) ════════════════════
  // Klik stat card → filter daftar ONU sesuai status + pindah ke tab ONU.
  // Klik card yang sama lagi (atau "Total") → bersihkan filter.
  setStatFilter(key) {
    // "total" = tampilkan semua. Toggle: klik yg aktif lagi → bersihkan.
    const next = (key === 'total' || this.statFilter === key) ? null : key;
    this.statFilter = next;
    this._syncStatCards();
    this.onuPage = 1;
    this.renderOnus();
    // Pindah ke tab ONU agar hasil filter langsung terlihat (kecuali klik Total).
    if (next) this.switchTab('onu');
  },

  // Sorot stat card yang aktif (background biru) sesuai filter berjalan.
  _syncStatCards() {
    const map = { online: 'cardOnline', offline: 'cardOffline', badrx: 'cardBad' };
    document.querySelectorAll('.ot-card').forEach(el => el.classList.remove('active'));
    const id = map[this.statFilter];
    if (id) { const el = document.getElementById(id); if (el) el.classList.add('active'); }
  },

  // ════════════════════ Tabs ════════════════════
  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.ot-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.ot-tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
    // Saat kembali ke Overview, chart mungkin salah ukur tinggi karena tadi
    // tab-nya tersembunyi. Render ulang dari data (renderTrend menangani
    // destroy+create), JANGAN panggil .render() yang menumpuk SVG baru.
    if (tab === 'overview') { this.renderTrend(); try { this.renderRxQuality(); } catch (e) {} }
    // Auto-muat data tab saat dibuka pertama kali (sekali per OLT), supaya
    // tidak perlu klik "Refresh" manual — konsisten dengan auto-load ONU.
    if (tab === 'vlan' && this.activeOltId && !this._vlanLoaded) { this._vlanLoaded = true; this.loadVlans(); }
    if (tab === 'system' && this.activeOltId && !this._systemLoaded) { this._systemLoaded = true; this.loadSystem(true); }
    if (tab === 'cards' && this.activeOltId && !this._cardsLoaded) { this._cardsLoaded = true; this.loadCards(true); }
    if (tab === 'cli') { this.renderRawSuggest(); }
    if (tab === 'profil' && this.activeOltId && !this._profilLoaded) { this._profilLoaded = true; this.loadProfiles(); }
  },

  // ════════════════════ Auto-refresh ════════════════════
  setAutoRefresh(on, silent) {
    this.autoRefresh = on;
    try { localStorage.setItem(this.LS_AUTOREFRESH, on ? '1' : '0'); } catch (e) {}
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (on) {
      this.refreshTimer = setInterval(() => this._tick(), this.refreshIntervalMs);
      if (!silent) App.showToast('Auto-refresh aktif (tiap 30 detik)', 'success');
    } else if (!silent) {
      App.showToast('Auto-refresh dimatikan', 'info');
    }
  },

  async _tick() {
    if (!this.activeOltId) return;
    if (this._ticking) return;   // cegah tumpang-tindih bila scan > 30 dtk
    this._ticking = true;
    try {
      // Mode auto-discover (lintas PON): muat ulang semua ONU diam-diam.
      if (this.autoLoaded) { await this.autoDiscover(true); return; }
      // Mode manual (PON tunggal): refresh sesuai tab aktif + tren.
      if (this.activeTab === 'onu' && this.currentPon) await this.loadOnus(true);
      else if (this.currentPon) await this._sampleTrend();
      if (this.activeTab === 'system') await this.loadSystem(true);
    } finally {
      this._ticking = false;
    }
  },

  // ════════════════════ OLT list ════════════════════
  async loadOlts() {
    try {
      const res = await App.api('/olt-mgmt');
      if (!res?.success) { this._alert(res?.message || 'Gagal memuat OLT'); return; }
      this.olts = res.data || [];
      this._hideAlert();
      this.renderOltBar();
      // Auto-pilih OLT saat pertama kali halaman dibuka, lalu auto-load data
      // sehingga list ONU & status langsung muncul tanpa refresh manual.
      if (!this.activeOltId && this.olts.length) {
        const saved = parseInt(localStorage.getItem(this.LS_KEY) || '');
        const pick = this.olts.find(o => o.id === saved && o.enabled !== false)
                  || this.olts.find(o => o.enabled !== false)
                  || this.olts[0];
        if (pick) this.selectOlt(pick.id);
      }
    } catch (e) {
      this._alert('Tidak bisa terhubung ke server: ' + e.message);
    }
  },

  renderOltBar() {
    const bar = document.getElementById('oltBar');
    document.getElementById('oltCount').textContent = `${this.olts.length} OLT`;

    if (!this.olts.length) {
      bar.innerHTML = `<div class="ot-empty" style="padding:30px 10px;grid-column:1/-1">
        <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="7" rx="2"/><rect x="2" y="13" width="20" height="7" rx="2"/></svg>
        <h3>Belum ada OLT</h3>
        <p>Tambahkan OLT ZTE C320/C300 untuk mulai mengelola ONU via CLI</p>
        <button class="btn btn-blue btn-sm" onclick="OltMgmt.openAddOlt()">+ Tambah OLT</button>
      </div>`;
      document.getElementById('ponBar').style.display = 'none';
      return;
    }

    bar.innerHTML = this.olts.map(o => {
      const enabled = o.enabled !== false;
      const dot = o.lastStatus === 'ok' ? 'dot-ok' : (o.lastStatus === 'error' ? 'dot-err' : 'dot-idle');
      const active = o.id === this.activeOltId ? 'active' : '';
      const offCls = enabled ? '' : 'off';
      const brandLbl = (o.brand || 'zte').toUpperCase();
      return `<div class="olt-chip ${active} ${offCls}" onclick="OltMgmt.selectOlt(${o.id})">
        <span class="olt-chip-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="7" rx="2"/><rect x="2" y="13" width="20" height="7" rx="2"/><line x1="6" y1="7.5" x2="6.01" y2="7.5"/><line x1="6" y1="16.5" x2="6.01" y2="16.5"/></svg></span>
        <span class="olt-chip-txt"><span class="olt-chip-name">${esc(o.name)}</span><span class="olt-chip-host">${esc(o.host)} · ${brandLbl} · ${(o.protocol||'telnet').toUpperCase()}</span></span>
        <span class="olt-chip-dot ${dot}"></span>
        <span class="olt-chip-acts">
          <button class="olt-chip-act" title="Edit OLT" onclick="event.stopPropagation();OltMgmt.openEditOlt(${o.id})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="olt-chip-act del" title="Hapus OLT" onclick="event.stopPropagation();OltMgmt.deleteOlt(${o.id},'${esc(o.name)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        </span>
      </div>`;
    }).join('') + `<button class="olt-chip" onclick="OltMgmt.openAddOlt()" style="border-style:dashed;color:var(--muted)">
        <span class="olt-chip-ic" style="background:#f8fafc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
        <span class="olt-chip-txt"><span class="olt-chip-name">Tambah OLT</span><span class="olt-chip-host">Klik untuk menambah</span></span>
      </button>`;
  },

  selectOlt(id) {
    this.activeOltId = id;
    const o = this.olts.find(x => x.id === id);
    this.activeStyle = o ? (o.style || (o.brand === 'zte' ? 'zte' : 'chipset')) : 'zte';
    this.activeEpon = o ? !!o.epon : false;
    document.getElementById('connLbl').textContent = o ? `Aktif: ${o.name} (${o.host})` : '';
    document.getElementById('ponBar').style.display = 'flex';
    document.getElementById('btnUncfg').disabled = false;
    // Sesuaikan label & placeholder PON port menurut gaya brand
    const isZte = this.activeStyle === 'zte';
    document.getElementById('ponBarLbl').textContent = isZte ? 'PON Port (frame/slot/port)' : 'PON Port';
    const ponInput = document.getElementById('ponInput');
    ponInput.placeholder = isZte ? '1/2/1' : '1';
    ponInput.value = isZte ? '1/2/1' : '';
    // Placeholder ringkasan port per gaya
    document.getElementById('summaryPorts').placeholder = isZte ? '1/2/1, 1/2/2, 1/2/3' : '1, 2, 3, 4';
    document.getElementById('summaryPortsHint').textContent = isZte ? 'format gpon-olt, pisahkan koma' : 'pisahkan dengan koma';
    // Reset state per OLT
    this.onus = []; this.currentPon = null;
    this.trend = [];
    this.autoLoaded = false;
    this._vlanLoaded = false;       // muat ulang VLAN saat tab dibuka utk OLT baru
    this._systemLoaded = false;
    this._cardsLoaded = false;
    this._profilLoaded = false;
    this.vlans = [];
    this.ponFilter = 'all';
    this.statFilter = null;
    this._syncStatCards();
    this.portSummaryData = [];
    if (this.trendChart) { try { this.trendChart.destroy(); } catch (e) {} this.trendChart = null; }
    document.getElementById('trendHint').textContent = 'menunggu data…';
    this.renderOltBar();
    this.renderOnus();
    this._resetStats();
    this.renderRawSuggest();
    // Simpan OLT terakhir dipakai supaya auto-load konsisten antar kunjungan
    try { localStorage.setItem(this.LS_KEY, String(id)); } catch (e) {}
    // Cache-first: tampilkan snapshot tersimpan secara INSTAN (tanpa konek OLT),
    // lalu segarkan di belakang layar. Jadi tidak perlu refresh manual & datanya
    // tetap tersinkron.
    this.loadFromCacheThenRefresh();
  },

  // Load snapshot dari cache server (instan) → render → refresh live di background
  async loadFromCacheThenRefresh() {
    if (!this.activeOltId) return;
    const o = this.olts.find(x => x.id === this.activeOltId);
    if (o && o.enabled === false) { this.autoDiscover(); return; }
    const body = document.getElementById('onuBody');
    let hadCache = false;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/discover?cached=1`);
      if (res?.success && res.data && (res.data.onus || res.data.ports)) {
        hadCache = true;
        this.applyDiscoverData(res.data, { cached: true });
      }
    } catch (e) { /* lanjut ke live */ }
    if (!hadCache && body) {
      body.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spin"></span> Menemukan PON port &amp; memuat ONU otomatis...</td></tr>`;
    }
    // Selalu refresh live setelah cache (silent bila cache sudah tampil)
    this.autoDiscover(hadCache);
  },

  // Terapkan payload discover (dari cache maupun live) ke seluruh UI
  applyDiscoverData(d, { cached = false } = {}) {
    d = d || {};
    this.onus = d.onus || [];
    this.portSummaryData = d.ports || [];
    this.autoLoaded = true;
    const firstPort = (this.portSummaryData.find(p => p.total > 0) || this.portSummaryData[0]);
    if (firstPort) {
      this.currentPon = firstPort.port;
      const pi = document.getElementById('ponInput'); if (pi) pi.value = firstPort.port;
    }
    this.renderOnus();
    this.updateStats();
    this._pushTrend();
    this.renderPortSummaryFromDiscover();
    if (d.system) this.applySystem(d.system);
    const o = this.olts.find(x => x.id === this.activeOltId);
    const onlineTot = this.onus.filter(x => x.status === 'online').length;
    const stamp = d.cachedAt ? this._timeAgo(d.cachedAt) : null;
    const tag = cached ? `<span class="card-pill pill-gray" style="margin-left:4px" title="Data tersimpan, sedang disegarkan">tersimpan${stamp ? ' · ' + stamp : ''}</span>` : '';
    document.getElementById('connLbl').innerHTML =
      `Aktif: ${esc(o?.name || '')} <span class="mut">· ${this.onus.length} ONU di ${this.portSummaryData.length} PON · ${onlineTot} online</span>${tag}`;
  },

  // Format "x menit lalu" sederhana
  _timeAgo(iso) {
    try {
      const diff = Math.max(0, Date.now() - new Date(iso).getTime());
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'baru saja';
      if (m < 60) return `${m} mnt lalu`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h} jam lalu`;
      return `${Math.floor(h / 24)} hr lalu`;
    } catch (e) { return ''; }
  },

  // ════════════════════ Auto-discover (muat semua ONU) ════════════════════
  async autoDiscover(silent) {
    if (!this.activeOltId) return;
    const o = this.olts.find(x => x.id === this.activeOltId);
    if (o && o.enabled === false) {
      // OLT dinonaktifkan — jangan paksa konek
      document.getElementById('onuBody').innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:50px 20px">
        <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/></svg>
        <h3>OLT dinonaktifkan</h3><p>Aktifkan OLT ini (Edit OLT) untuk memuat data ONU otomatis.</p></div></td></tr>`;
      return;
    }
    const body = document.getElementById('onuBody');
    if (!silent) {
      body.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spin"></span> Menemukan PON port &amp; memuat ONU...</td></tr>`;
      document.getElementById('connLbl').innerHTML = `Aktif: ${esc(o?.name || '')} <span class="mut">· memuat…</span>`;
    }
    try {
      // Muat daftar ONU DULU tanpa redaman → tabel tampil instan.
      // Redaman diisi menyusul (progressive load) untuk jalur CLI yang lambat.
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/discover?power=0`);
      if (!res?.success) {
        if (!silent) body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:40px 20px"><h3>Gagal auto-load</h3><p>${esc(res?.message || 'Error')}</p><button class="btn btn-blue btn-sm" style="margin-top:12px" onclick="OltMgmt.autoDiscover()">Coba lagi</button></div></td></tr>`;
        this.onus = []; this._resetStats();
        return;
      }
      const d = res.data || {};
      // Jika live tidak mengembalikan system (mis. SNMP), ambil terpisah
      if (!d.system) this.loadSystem(true);
      this.applyDiscoverData(d, { cached: false });
      if (res.via === 'snmp') document.getElementById('connLbl').innerHTML += ' <span class="card-pill pill-teal" style="margin-left:4px">SNMP</span>';

      // Redaman: SNMP sudah cepat & sertakan power → tak perlu progressive.
      // Untuk CLI (atau bila redaman belum ada), ambil menyusul per-PON.
      const hasPower = this.onus.some(x => x.onu_rx_dbm !== undefined);
      if (res.via !== 'snmp' && !hasPower && this.onus.length) {
        this._loadPowerProgressive();
      }
    } catch (e) {
      if (!silent) body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:40px 20px"><h3>Error</h3><p>${esc(e.message)}</p><button class="btn btn-blue btn-sm" style="margin-top:12px" onclick="OltMgmt.autoDiscover()">Coba lagi</button></div></td></tr>`;
    }
  },

  // Muat redaman menyusul (progressive), per-PON, lalu tambal baris yang sudah
  // tampil. Pengguna langsung lihat daftar ONU; redaman mengisi bertahap.
  async _loadPowerProgressive() {
    // Tandai sedang memuat agar UI bisa menampilkan indikator halus.
    this._powerLoading = true;
    const token = Symbol('powerLoad');
    this._powerToken = token;   // untuk batalkan bila refresh lagi

    const hint = document.getElementById('onuPowerHint');
    if (hint) hint.style.display = '';

    // Kelompokkan ONU per-PON agar tiap permintaan ringan & hasil cepat tampil.
    const byPon = {};
    this.onus.forEach(o => {
      if (!o.onu_if) return;
      const pon = o.pon || (o.onu_if.match(/gpon-onu_(\d+\/\d+\/\d+):/)?.[1]) || 'x';
      (byPon[pon] = byPon[pon] || []).push(o.onu_if);
    });

    const pons = Object.keys(byPon);
    for (const pon of pons) {
      if (this._powerToken !== token) return;   // dibatalkan oleh refresh baru
      try {
        const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/power-batch`, {
          method: 'POST', body: JSON.stringify({ ifs: byPon[pon] }),
        });
        if (res?.success && res.data) {
          // Tambal nilai redaman ke ONU yang cocok.
          this.onus.forEach(o => {
            const p = res.data[o.onu_if];
            if (p) { o.onu_rx_dbm = p.onu_rx_dbm; o.quality = p.quality; }
          });
          // Render ulang hanya jika tab ONU/Overview aktif (hemat).
          this.renderOnus();
          this.updateStats();
        }
      } catch (e) { /* lewati PON ini, lanjut */ }
    }

    if (this._powerToken === token) {
      this._powerLoading = false;
      if (hint) hint.style.display = 'none';
      this._pushTrend();   // perbarui tren dgn redaman terbaru
    }
  },

  // Render ringkasan per-PON dari hasil discover (tanpa query ulang)
  renderPortSummaryFromDiscover() {
    const grid = document.getElementById('portSummaryGrid');
    if (!grid) return;
    const data = this.portSummaryData || [];
    if (!data.length) {
      grid.innerHTML = `<div class="ot-empty" style="padding:30px 10px;grid-column:1/-1"><p>Belum ada PON port terdeteksi.</p></div>`;
      return;
    }
    // Isi field daftar port juga agar tombol "Refresh" manual tetap relevan
    const portsCsv = data.map(p => p.port).join(', ');
    const sp = document.getElementById('summaryPorts');
    if (sp && !sp.value) sp.value = portsCsv;
    grid.innerHTML = data.map(p => {
      const pct = p.total ? Math.round((p.online / p.total) * 100) : 0;
      return `<div class="ot-portsum-card" style="cursor:pointer" onclick="OltMgmt.filterByPon('${esc(String(p.port))}')" title="Klik untuk filter ONU port ini">
        <div class="ps-port">PON ${esc(String(p.port))}</div>
        <div class="ps-total">${p.total}</div>
        <div class="ps-meta"><span class="ps-on">${p.online} on</span><span class="ps-off">${p.offline} off</span></div>
        <div class="ps-bar"><span style="width:${pct}%"></span></div>
      </div>`;
    }).join('');
  },

  // Filter tabel ONU berdasarkan PON port (dipakai dari kartu ringkasan)
  filterByPon(pon) {
    this.ponFilter = pon;
    this.switchTab('onu');
    this.renderOnus();
    this.renderPonChips();
  },

  _isZte() { return this.activeStyle === 'zte'; },

  // ════════════════════ OLT modal CRUD ════════════════════
  openAddOlt() {
    document.getElementById('oltModalTitle').textContent = 'Tambah OLT';
    document.getElementById('oltId').value = '';
    document.getElementById('oltName').value = '';
    document.getElementById('oltHost').value = '';
    document.getElementById('oltBrand').value = 'zte';
    document.getElementById('oltProtocol').value = 'telnet';
    document.getElementById('oltPort').value = '23';
    document.getElementById('oltUser').value = '';
    document.getElementById('oltPass').value = '';
    document.getElementById('oltEnablePass').value = '';
    document.getElementById('oltEnabled').value = 'true';
    document.getElementById('passHint').textContent = 'Wajib diisi';
    document.getElementById('oltTestResult').style.display = 'none';
    document.getElementById('btnDeleteOlt').style.display = 'none';
    document.getElementById('oltSnmpEnabled').checked = false;
    document.getElementById('oltSnmpCommunity').value = '';
    document.getElementById('oltSnmpVersion').value = '2c';
    document.getElementById('oltSnmpPort').value = '161';
    document.getElementById('snmpCommHint').textContent = 'Read community OLT';
    this.onSnmpToggle();
    this.onBrandChange();
    document.getElementById('oltModal').classList.add('show');
  },

  openEditOlt(id) {
    const o = this.olts.find(x => x.id === id);
    if (!o) return;
    document.getElementById('oltModalTitle').textContent = 'Edit OLT';
    document.getElementById('oltId').value = o.id;
    document.getElementById('oltName').value = o.name || '';
    document.getElementById('oltHost').value = o.host || '';
    document.getElementById('oltBrand').value = o.brand || 'zte';
    document.getElementById('oltProtocol').value = o.protocol || 'telnet';
    document.getElementById('oltPort').value = o.port || (o.protocol === 'ssh' ? 22 : 23);
    document.getElementById('oltUser').value = o.username || '';
    document.getElementById('oltPass').value = '';
    document.getElementById('oltEnablePass').value = '';
    document.getElementById('oltEnabled').value = String(o.enabled !== false);
    document.getElementById('passHint').textContent = 'Kosongkan jika tidak ingin mengubah';
    document.getElementById('oltTestResult').style.display = 'none';
    document.getElementById('btnDeleteOlt').style.display = '';
    document.getElementById('oltSnmpEnabled').checked = !!o.snmpEnabled;
    document.getElementById('oltSnmpCommunity').value = '';
    document.getElementById('oltSnmpVersion').value = o.snmpVersion || '2c';
    document.getElementById('oltSnmpPort').value = o.snmpPort || 161;
    document.getElementById('snmpCommHint').textContent = o.snmpCommunity ? 'Tersimpan — kosongkan jika tidak diubah' : 'Read community OLT';
    this.onSnmpToggle();
    this.onBrandChange();
    document.getElementById('oltModal').classList.add('show');
  },

  deleteOltFromModal() {
    const id = parseInt(document.getElementById('oltId').value);
    const name = document.getElementById('oltName').value || 'OLT';
    if (!id) return;
    this.closeOltModal();
    this.deleteOlt(id, name);
  },

  closeOltModal() { document.getElementById('oltModal').classList.remove('show'); },

  deleteOlt(id, name) {
    this._confirm('Hapus OLT?', `OLT <b>${esc(name)}</b> akan dihapus dari daftar beserta kredensialnya. Tindakan ini tidak memengaruhi konfigurasi pada perangkat OLT.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${id}`, { method: 'DELETE' });
      if (res?.success) {
        App.showToast(res.message || 'OLT dihapus', 'success');
        if (this.activeOltId === id) {
          this.activeOltId = null;
          document.getElementById('connLbl').textContent = 'Pilih OLT untuk mulai';
          document.getElementById('ponBar').style.display = 'none';
          document.getElementById('btnUncfg').disabled = true;
          this.onus = []; this.renderOnus(); this._resetStats();
        }
        await this.loadOlts();
      } else {
        App.showToast(res?.message || 'Gagal menghapus OLT', 'error');
      }
    });
  },

  onProtoChange() {
    const proto = document.getElementById('oltProtocol').value;
    const portEl = document.getElementById('oltPort');
    // Hanya ubah port bila masih default
    if (portEl.value === '22' || portEl.value === '23' || !portEl.value) {
      portEl.value = proto === 'ssh' ? '22' : '23';
    }
  },

  _collectOlt() {
    return {
      id:             document.getElementById('oltId').value || null,
      name:           document.getElementById('oltName').value.trim(),
      host:           document.getElementById('oltHost').value.trim(),
      brand:          document.getElementById('oltBrand').value,
      protocol:       document.getElementById('oltProtocol').value,
      port:           document.getElementById('oltPort').value,
      username:       document.getElementById('oltUser').value.trim(),
      password:       document.getElementById('oltPass').value,
      enablePassword: document.getElementById('oltEnablePass').value,
      enabled:        document.getElementById('oltEnabled').value === 'true',
      snmpEnabled:    document.getElementById('oltSnmpEnabled').checked,
      snmpCommunity:  document.getElementById('oltSnmpCommunity').value,
      snmpVersion:    document.getElementById('oltSnmpVersion').value,
      snmpPort:       document.getElementById('oltSnmpPort').value,
    };
  },

  onSnmpToggle() {
    const on = document.getElementById('oltSnmpEnabled').checked;
    document.getElementById('snmpFields').style.display = on ? 'block' : 'none';
  },

  // SNMP hanya relevan untuk ZTE; sembunyikan section untuk brand lain
  onBrandChange() {
    const brand = document.getElementById('oltBrand').value;
    document.getElementById('snmpSection').style.display = (brand === 'zte') ? 'block' : 'none';
  },

  async saveOlt() {
    const p = this._collectOlt();
    if (!p.host)     { App.showToast('IP Address wajib diisi', 'error'); return; }
    if (!p.username) { App.showToast('Username wajib diisi', 'error'); return; }
    if (!p.id && !p.password) { App.showToast('Password wajib diisi untuk OLT baru', 'error'); return; }

    const btn = document.getElementById('btnSaveOlt');
    btn.disabled = true;
    try {
      const id = p.id;
      const res = await App.api(id ? `/olt-mgmt/${id}` : '/olt-mgmt', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(p),
      });
      if (res?.success) {
        this.closeOltModal();
        App.showToast(id ? 'OLT diupdate' : 'OLT ditambahkan', 'success');
        await this.loadOlts();
        if (!id && res.data?.id) this.selectOlt(res.data.id);
      } else {
        App.showToast(res?.message || 'Gagal menyimpan', 'error');
      }
    } catch (e) {
      App.showToast('Error: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  },

  async testConnection() {
    const p = this._collectOlt();
    const box = document.getElementById('oltTestResult');
    // Untuk test, OLT harus sudah tersimpan (pakai credential tersimpan).
    // Jika ada perubahan, simpan dulu.
    if (!p.id) {
      box.style.display = 'block';
      box.className = 'test-result test-err';
      box.textContent = 'Simpan OLT terlebih dahulu sebelum test koneksi.';
      return;
    }
    const btn = document.getElementById('btnTestConn');
    btn.disabled = true;
    box.style.display = 'block';
    box.className = 'test-result';
    box.style.background = '#f8fafc'; box.style.color = '#475569'; box.style.border = '1px solid #e2e8f0';
    box.innerHTML = '<span class="spin"></span> Menghubungi OLT...';
    try {
      const res = await App.api(`/olt-mgmt/${p.id}/test`, { method: 'POST' });
      if (res?.success) {
        box.className = 'test-result test-ok';
        box.textContent = '✓ ' + (res.message || 'Terhubung') + (res.info ? ` — ${res.info}` : '');
      } else {
        box.className = 'test-result test-err';
        box.textContent = '✗ ' + (res?.error || res?.message || 'Gagal terhubung');
      }
      await this.loadOlts();
    } catch (e) {
      box.className = 'test-result test-err';
      box.textContent = '✗ ' + e.message;
    } finally { btn.disabled = false; }
  },

  // ════════════════════ ONU list ════════════════════
  async loadOnus(silent) {
    if (!this.activeOltId) { if (!silent) App.showToast('Pilih OLT dulu', 'warning'); return; }
    const pon = document.getElementById('ponInput').value.trim();
    if (!pon) { if (!silent) App.showToast('Masukkan PON port', 'warning'); return; }
    const withPower = true;   // redaman selalu diambil (default)

    this.loadingOnu = true;
    const body = document.getElementById('onuBody');
    if (!silent) body.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spin"></span> Memuat ONU dari OLT + redaman (mohon tunggu)...</td></tr>`;
    document.getElementById('btnAddOnu').disabled = false;
    document.getElementById('ponInput').value = pon;

    try {
      const q = `pon=${encodeURIComponent(pon)}&power=1`;
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onus?${q}`);
      if (!res?.success) {
        if (!silent) body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:40px 20px"><h3>Gagal memuat</h3><p>${esc(res?.message || 'Error')}</p></div></td></tr>`;
        this.onus = []; this._resetStats();
        return;
      }
      this.onus = (res.data || []).map(o => ({ ...o, pon: o.pon || pon }));
      this.currentPon = pon;
      // Mode manual PON tunggal: matikan filter & sembunyikan chip multi-PON
      this.autoLoaded = false;
      this.ponFilter = 'all';
      this.portSummaryData = [{ port: pon, total: this.onus.length, online: this.onus.filter(o => o.status === 'online').length, offline: this.onus.filter(o => o.status !== 'online').length }];
      this.renderOnus();
      this.updateStats();
      this._pushTrend();  // catat titik tren
    } catch (e) {
      if (!silent) body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:40px 20px"><h3>Error</h3><p>${esc(e.message)}</p></div></td></tr>`;
    } finally { this.loadingOnu = false; }
  },

  // Sample tren tanpa render tabel (untuk auto-refresh di tab lain)
  async _sampleTrend() {
    if (!this.activeOltId || !this.currentPon) return;
    try {
      const q = `pon=${encodeURIComponent(this.currentPon)}&power=1`;
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onus?${q}`);
      if (res?.success) { this.onus = res.data || []; this.updateStats(); this._pushTrend(); }
    } catch (e) {}
  },

  renderOnus() {
    const body = document.getElementById('onuBody');
    const q = this.searchTerm.toLowerCase();
    // Filter PON dulu (saat mode auto-discover lintas PON), lalu pencarian teks
    let base = this.onus;
    if (this.ponFilter && this.ponFilter !== 'all') {
      base = base.filter(o => String(o.pon) === String(this.ponFilter));
    }
    // Filter status dari klik stat card (online / offline / redaman bermasalah)
    if (this.statFilter === 'online') {
      base = base.filter(o => o.status === 'online');
    } else if (this.statFilter === 'offline') {
      base = base.filter(o => o.status !== 'online');
    } else if (this.statFilter === 'badrx') {
      base = base.filter(o => ['warning', 'critical', 'los'].includes(o.quality));
    }
    const filtered = q ? base.filter(o =>
      (o.sn||'').toLowerCase().includes(q) ||
      (o.name||'').toLowerCase().includes(q) ||
      (o.onu_if||'').toLowerCase().includes(q) ||
      (o.type||'').toLowerCase().includes(q)
    ) : base;

    document.getElementById('onuCount').textContent = `${filtered.length} ONU`;
    this.renderPonChips();

    const pager = document.getElementById('onuPager');

    if (!this.onus.length) {
      body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:50px 20px">
        <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/></svg>
        <h3>Belum ada data ONU</h3><p>Data dimuat otomatis saat OLT dipilih. Klik "Refresh" bila perlu memuat ulang.</p></div></td></tr>`;
      if (pager) pager.style.display = 'none';
      return;
    }
    if (!filtered.length) {
      const reason = (this.ponFilter && this.ponFilter !== 'all')
        ? `Tidak ada ONU pada PON ${esc(this.ponFilter)}${this.searchTerm ? ` untuk "${esc(this.searchTerm)}"` : ''}`
        : `Tidak ada ONU cocok dengan "${esc(this.searchTerm)}"`;
      body.innerHTML = `<tr><td colspan="6"><div class="ot-empty" style="padding:40px 20px"><h3>Tidak ditemukan</h3><p>${reason}</p></div></td></tr>`;
      if (pager) pager.style.display = 'none';
      return;
    }

    // ── Pagination: potong sesuai halaman & ukuran tampilan ──
    const size = this.onuPageSize === 'all' ? filtered.length : this.onuPageSize;
    const totalPages = Math.max(1, Math.ceil(filtered.length / size));
    if (this.onuPage > totalPages) this.onuPage = totalPages;
    const startIdx = (this.onuPage - 1) * size;
    const pageRows = filtered.slice(startIdx, startIdx + size);
    this._renderPager(filtered.length, startIdx, pageRows.length, totalPages);

    body.innerHTML = pageRows.map(o => {
      const stCls = o.status === 'online' ? 'st-online' : (o.status === 'disabled' ? 'st-disabled' : 'st-offline');
      // Tampilkan phase asli OLT untuk ONU non-online agar mudah didiagnosa:
      //   LOS      = tidak ada sinyal optik (ONU mati / fiber putus / redaman tinggi)
      //   OffLine  = belum ranging / baru di-provisioning (tunggu 1-2 menit)
      //   SyncMib/Ranging = sedang proses online
      const phase = String(o.phase_state || '').toLowerCase().replace(/\(.*\)$/, '');
      let stTxt;
      if (o.status === 'online') stTxt = 'Online';
      else if (o.status === 'disabled') stTxt = 'Disabled';
      else if (phase === 'los' || phase === 'loss') stTxt = 'LOS';
      else if (phase === 'ranging' || phase === 'syncmib' || phase === 'logging' || phase === 'initial') stTxt = 'Ranging…';
      else stTxt = 'Offline';
      const stTitle = (o.status !== 'online' && phase) ? ` title="Phase OLT: ${esc(phase)}"` : '';
      const rx = this._rxCell(o);
      const ifEsc = esc(o.onu_if);
      const ponTag = o.pon ? `<span class="onu-pon-tag">PON ${esc(String(o.pon))}</span>` : '';
      return `<tr>
        <td data-label="ONU"><span class="onu-if">${ifEsc}</span>${ponTag}</td>
        <td data-label="Nama / SN">
          <div class="onu-namecell">
            <div class="onu-name">${o.name ? esc(o.name) : '<span class="mut">—</span>'}</div>
            <div class="onu-sn">${o.sn ? esc(o.sn) : '<span class="mut">SN: ?</span>'}</div>
          </div>
        </td>
        <td data-label="Type">${o.type ? esc(o.type) : '<span class="mut">—</span>'}</td>
        <td data-label="Status"><span class="st-pill ${stCls}"${stTitle}><span class="pd"></span>${stTxt}</span></td>
        <td data-label="Redaman">${rx}</td>
        <td data-label="Aksi">
          <div class="row-acts">
            <button class="ra info" title="Detail & redaman" onclick="OltMgmt.showDetail('${ifEsc}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
            ${this._isZte() ? `<button class="ra traffic" title="Traffic real-time" onclick="OltMgmt.openOnuTraffic('${ifEsc}','${esc(o.name||'')}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/></svg></button>` : ''}
            <button class="ra edit" title="Edit nama/deskripsi" onclick="OltMgmt.openEditOnu('${ifEsc}','${esc(o.name||'')}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="ra vlan" title="VLAN service-port" onclick="OltMgmt.openOnuVlan('${ifEsc}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button>
            <button class="ra reboot" title="Reboot ONU" onclick="OltMgmt.rebootOnu('${ifEsc}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0115.5-6.3L21 8"/><polyline points="21 3 21 8 16 8"/><path d="M21 12a9 9 0 01-15.5 6.3L3 16"/><polyline points="3 21 3 16 8 16"/></svg></button>
            <button class="ra del" title="Hapus ONU" onclick="OltMgmt.deleteOnu('${ifEsc}','${esc(o.sn||o.onu_if)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
          </div>
        </td>
      </tr>`;
    }).join('');
  },

  // Render kontrol pagination (info rentang + tombol halaman).
  _renderPager(totalFiltered, startIdx, shownCount, totalPages) {
    const pager = document.getElementById('onuPager');
    if (!pager) return;
    pager.style.display = 'flex';

    // Info "1–50 dari 239"
    const info = document.getElementById('onuRangeInfo');
    if (info) {
      const from = totalFiltered === 0 ? 0 : startIdx + 1;
      const to = startIdx + shownCount;
      info.textContent = `${from.toLocaleString('id-ID')}–${to.toLocaleString('id-ID')} dari ${totalFiltered.toLocaleString('id-ID')}`;
    }

    // Sinkronkan nilai dropdown (mis. saat di-reset)
    const ps = document.getElementById('onuPageSize');
    if (ps) ps.value = String(this.onuPageSize);

    const btns = document.getElementById('onuPagerBtns');
    if (!btns) return;
    const cur = this.onuPage;

    // Bila 'Semua' atau hanya 1 halaman → sembunyikan tombol nomor.
    if (this.onuPageSize === 'all' || totalPages <= 1) { btns.innerHTML = ''; return; }

    // Hitung daftar halaman yang ditampilkan (dengan ellipsis).
    const pages = this._pageList(cur, totalPages);
    let html = `<button class="pager-btn" ${cur <= 1 ? 'disabled' : ''} onclick="OltMgmt.gotoOnuPage(${cur - 1})" aria-label="Sebelumnya">‹</button>`;
    pages.forEach(p => {
      if (p === '…') html += `<span class="pager-ellipsis">…</span>`;
      else html += `<button class="pager-btn ${p === cur ? 'active' : ''}" onclick="OltMgmt.gotoOnuPage(${p})">${p}</button>`;
    });
    html += `<button class="pager-btn" ${cur >= totalPages ? 'disabled' : ''} onclick="OltMgmt.gotoOnuPage(${cur + 1})" aria-label="Berikutnya">›</button>`;
    btns.innerHTML = html;
  },

  // Daftar nomor halaman ringkas: 1 … 4 5 [6] 7 8 … 20
  _pageList(cur, total) {
    const out = [];
    const add = (n) => out.push(n);
    if (total <= 7) { for (let i = 1; i <= total; i++) add(i); return out; }
    add(1);
    if (cur > 4) add('…');
    const start = Math.max(2, cur - 1), end = Math.min(total - 1, cur + 1);
    for (let i = start; i <= end; i++) add(i);
    if (cur < total - 3) add('…');
    add(total);
    return out;
  },

  gotoOnuPage(p) {
    this.onuPage = p;
    this.renderOnus();
    // Scroll balik ke atas tabel agar pengguna lihat baris pertama halaman baru.
    document.querySelector('.onu-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Render chip filter PON port (di atas tabel ONU) saat mode auto-discover
  renderPonChips() {
    const wrap = document.getElementById('ponChips');
    if (!wrap) return;
    const ports = this.portSummaryData || [];
    // Hanya tampil saat ada >1 PON port termuat (multi-PON auto-discover)
    if (ports.length <= 1) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
    wrap.style.display = 'flex';
    const total = this.onus.length;
    const mk = (val, label, count, active) =>
      `<button class="pon-chip ${active ? 'active' : ''}" onclick="OltMgmt.setPonFilter('${esc(String(val))}')">${esc(label)}<span class="pon-chip-n">${count}</span></button>`;
    let html = mk('all', 'Semua PON', total, this.ponFilter === 'all' || !this.ponFilter);
    html += ports.map(p => mk(p.port, `PON ${p.port}`, p.total, String(this.ponFilter) === String(p.port))).join('');
    wrap.innerHTML = html;
  },

  setPonFilter(val) {
    this.ponFilter = val;
    this.onuPage = 1;
    this.renderOnus();
  },

  _rxCell(o) {
    // Redaman kini selalu diambil. Bila masih undefined → sedang dimuat (progressive).
    if (o.onu_rx_dbm === undefined) {
      return this._powerLoading
        ? '<span class="rx-badge rx-loading"><span class="spin spin-sm"></span></span>'
        : '<span class="mut" style="font-size:11px">—</span>';
    }
    if (o.onu_rx_dbm === null) {
      const q = o.quality || 'unknown';
      if (q === 'los') return '<span class="rx-badge rx-los">LOS</span>';
      return '<span class="rx-badge rx-unknown">N/A</span>';
    }
    const q = o.quality || 'unknown';
    const cls = 'rx-' + (['good','warning','critical','los'].includes(q) ? q : 'unknown');
    return `<span class="rx-badge ${cls}">${o.onu_rx_dbm.toFixed(1)} dBm</span>`;
  },

  updateStats() {
    const total   = this.onus.length;
    const online  = this.onus.filter(o => o.status === 'online').length;
    const offline = total - online;
    const bad     = this.onus.filter(o => typeof o.onu_rx_dbm === 'number' && o.onu_rx_dbm < -25).length;

    document.getElementById('statOnline').textContent  = online;
    document.getElementById('statOffline').textContent = offline;
    document.getElementById('statTotal').textContent   = total;
    document.getElementById('statBad').textContent     = bad;
    document.getElementById('statOnlinePill').textContent  = `${online} aktif`;
    document.getElementById('statOfflinePill').textContent = `${offline} offline`;
    document.getElementById('statTotalPill').textContent   = `${total} ONU`;
    document.getElementById('statBadPill').textContent     = `${bad} lemah`;

    // Perbarui chart distribusi kualitas redaman (tab Overview).
    try { this.renderRxQuality(); } catch (e) {}
  },

  _resetStats() {
    ['statOnline','statOffline','statTotal','statBad'].forEach(id => document.getElementById(id).textContent = '0');
  },

  // ════════════════════ Tren (chart) ════════════════════
  _pushTrend() {
    const online = this.onus.filter(o => o.status === 'online').length;
    const rxVals = this.onus.map(o => o.onu_rx_dbm).filter(v => typeof v === 'number');
    const avgRx = rxVals.length ? (rxVals.reduce((a, b) => a + b, 0) / rxVals.length) : null;
    this.trend.push({ t: Date.now(), online, avgRx });
    if (this.trend.length > 30) this.trend.shift();
    this.renderTrend();
  },

  // Bangun marker "discrete" untuk DOT di titik terakhir tiap garis
  // (gaya referensi: bulatan putih ber-ring warna di ujung garis).
  _endDots(onlineSeries, rxSeries) {
    const dots = [];
    const ring = ['#3b6ef5', '#0891b2'];
    [onlineSeries, rxSeries].forEach((s, si) => {
      // cari index titik valid terakhir
      let idx = -1;
      for (let i = s.length - 1; i >= 0; i--) { if (s[i] != null) { idx = i; break; } }
      if (idx >= 0) {
        dots.push({ seriesIndex: si, dataPointIndex: idx, size: 5.5, fillColor: '#ffffff', strokeColor: ring[si], strokeWidth: 2.5 });
      }
    });
    return dots;
  },

  renderTrend() {
    const el = document.getElementById('trendChart');
    if (!el || typeof ApexCharts === 'undefined') return;
    const hint = document.getElementById('trendHint');
    if (hint) hint.textContent = this.trend.length ? `${this.trend.length} titik · live` : 'menunggu data…';

    const cats = this.trend.map(p => new Date(p.t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const onlineSeries = this.trend.map(p => p.online);
    const rxSeries = this.trend.map(p => p.avgRx == null ? null : Math.round(p.avgRx * 10) / 10);
    const hasRx = rxSeries.some(v => v !== null);

    // Rentang sumbu dBm: beri ruang ±2 dBm di sekitar data agar label tidak
    // berulang (mis. semua ONU ~-21 → jangan tampilkan "-21" 8x).
    let rxMin, rxMax;
    if (hasRx) {
      const vals = rxSeries.filter(v => v !== null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = Math.max(2, hi - lo);            // minimal 2 dBm rentang
      rxMin = Math.floor(lo - span * 0.4) - 1;
      rxMax = Math.ceil(hi + span * 0.4) + 1;
    }

    // ── Update stat callouts (nilai terkini) ──
    const last = this.trend[this.trend.length - 1] || {};
    const prev = this.trend[this.trend.length - 2] || {};
    const onlineEl = document.getElementById('tsOnline');
    if (onlineEl) {
      if (last.online == null) { onlineEl.textContent = '—'; }
      else {
        // Delta vs pembacaan sebelumnya (▲ naik / ▼ turun).
        let delta = '';
        if (prev.online != null && prev.online !== last.online) {
          const diff = last.online - prev.online;
          const cls = diff > 0 ? 'up' : 'down';
          const arrow = diff > 0 ? '▲' : '▼';
          delta = ` <span class="ts-delta ${cls}">${arrow} ${Math.abs(diff)}</span>`;
        }
        onlineEl.innerHTML = `${last.online}${delta}`;
      }
    }
    const rxEl = document.getElementById('tsRx');
    const rxNote = document.getElementById('tsRxNote');
    if (rxEl) {
      if (last.avgRx == null) {
        rxEl.innerHTML = '— <span class="ts-unit">dBm</span>';
        rxEl.className = 'ts-value';
        if (rxNote) { rxNote.textContent = 'menunggu data redaman…'; rxNote.style.display = ''; }
      } else {
        const v = Math.round(last.avgRx * 10) / 10;
        // Kualitas: ≥-25 baik, -25..-27 waspada, <-27 buruk (GPON umum)
        const cls = v >= -25 ? 'rx-ok' : (v >= -27 ? 'rx-warn' : 'rx-bad');
        const lbl = v >= -25 ? 'sinyal baik' : (v >= -27 ? 'waspada' : 'sinyal lemah');
        rxEl.innerHTML = `${v.toFixed(1)} <span class="ts-unit">dBm</span>`;
        rxEl.className = 'ts-value ' + cls;
        if (rxNote) { rxNote.textContent = lbl; rxNote.style.display = ''; }
      }
    }

    const series = [
      { name: 'ONU Online', type: 'area', data: onlineSeries },
      ...(hasRx ? [{ name: 'Rata-rata Rx (dBm)', type: 'line', data: rxSeries }] : []),
    ];

    const options = {
      chart: {
        type: 'line', height: 230, fontFamily: 'Plus Jakarta Sans, sans-serif',
        toolbar: { show: false }, zoom: { enabled: false },
        animations: { enabled: true, easing: 'easeinout', dynamicAnimation: { speed: 350 } },
        sparkline: { enabled: false },
      },
      colors: ['#3b6ef5', '#0891b2'],
      stroke: { curve: 'smooth', width: [3.5, 2.5], dashArray: [0, 0], lineCap: 'round' },
      series,
      fill: {
        type: ['gradient', 'solid'],
        gradient: { shade: 'light', type: 'vertical', shadeIntensity: 0.7, opacityFrom: 0.32, opacityTo: 0.01, stops: [0, 95] },
      },
      // Marker putih di TITIK TERAKHIR tiap garis (gaya referensi: dot di ujung).
      markers: {
        size: 0, hover: { size: 6 }, strokeWidth: 2.5, strokeColors: ['#3b6ef5', '#0891b2'],
        colors: ['#ffffff', '#ffffff'],
        discrete: this._endDots(onlineSeries, rxSeries),
      },
      xaxis: {
        categories: cats, tickAmount: 6,
        labels: { style: { fontSize: '10px', colors: '#a8b3c2' }, rotate: 0, hideOverlappingLabels: true },
        axisBorder: { show: false }, axisTicks: { show: false }, tooltip: { enabled: false },
      },
      yaxis: hasRx ? [
        { seriesName: 'ONU Online', tickAmount: 4,
          title: { text: 'Online', style: { fontSize: '11px', color: '#94a3b8', fontWeight: 600 } },
          labels: { style: { colors: '#cbd5e1', fontSize: '10px' }, formatter: (v) => Math.round(v) },
          min: (min) => Math.max(0, Math.floor(min * 0.9)), forceNiceScale: true },
        { seriesName: 'Rata-rata Rx (dBm)', opposite: true, min: rxMin, max: rxMax, tickAmount: 4,
          title: { text: 'dBm', style: { fontSize: '11px', color: '#0891b2', fontWeight: 600 } },
          labels: { style: { colors: '#7ccadb', fontSize: '10px' }, formatter: (v) => v == null ? '' : v.toFixed(1) + ' dBm' } },
      ] : { tickAmount: 4,
            title: { text: 'Online', style: { fontSize: '11px', color: '#94a3b8', fontWeight: 600 } },
            labels: { style: { colors: '#cbd5e1', fontSize: '10px' }, formatter: (v) => Math.round(v) },
            min: (min) => Math.max(0, Math.floor(min * 0.9)), forceNiceScale: true },
      legend: { show: hasRx, position: 'top', horizontalAlign: 'right', fontSize: '11px', fontWeight: 600,
        markers: { width: 9, height: 9, radius: 4 }, itemMargin: { horizontal: 8 }, offsetY: -4 },
      grid: { borderColor: '#f3f5f8', strokeDashArray: 0, padding: { left: 10, right: 10, top: 4, bottom: 0 },
        xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
      dataLabels: { enabled: false },
      tooltip: {
        theme: 'light', shared: true, intersect: false,
        style: { fontSize: '12px', fontFamily: 'Plus Jakarta Sans, sans-serif' },
        y: { formatter: (val, opts) => {
          if (val == null) return '—';
          const isRx = opts?.seriesIndex === 1;
          return isRx ? `${val.toFixed(1)} dBm` : `${Math.round(val)} ONU`;
        } },
      },
    };

    // Update bila chart sudah ada DAN masih ada di DOM (tab terlihat).
    // Bila tidak (mis. baru pertama atau kontainer ter-reset), buat ulang
    // dengan aman: hancurkan instance lama + bersihkan kontainer agar tidak
    // ada SVG menumpuk (penyebab chart memanjang ke bawah berulang).
    const stillMounted = this.trendChart && el.querySelector('.apexcharts-canvas');
    if (stillMounted) {
      this.trendChart.updateOptions({ xaxis: { categories: cats }, yaxis: options.yaxis, legend: options.legend }, false, false);
      this.trendChart.updateSeries(series);
    } else {
      if (this.trendChart) { try { this.trendChart.destroy(); } catch (e) {} this.trendChart = null; }
      el.innerHTML = '';   // buang sisa SVG/render lama bila ada
      this.trendChart = new ApexCharts(el, options);
      this.trendChart.render();
    }
  },

  // ════════════════════ Distribusi kualitas redaman (dBm) ════════════════════
  // Hitung ONU per kualitas memakai field `quality` dari backend (sumber tunggal):
  //   good ≥ -25 dBm · warning -25..-28 · critical < -28 · los · belum diukur.
  renderRxQuality() {
    const el = document.getElementById('rxQualityChart');
    const legend = document.getElementById('rxQualityLegend');
    const hint = document.getElementById('rxDistHint');
    if (!el || typeof ApexCharts === 'undefined') return;

    // Kategori (urutan & warna konsisten dgn badge redaman di tabel).
    const cats = [
      { key: 'good',     name: 'Good',         desc: '≥ -25 dBm · sinyal baik',     color: '#16a34a' },
      { key: 'warning',  name: 'Warning',      desc: '-25 s/d -28 dBm · waspada',   color: '#f59e0b' },
      { key: 'critical', name: 'Bad',          desc: '< -28 dBm · sinyal lemah',    color: '#dc2626' },
      { key: 'los',      name: 'LOS',          desc: 'tak ada sinyal optik',        color: '#64748b' },
      { key: 'unmeasured', name: 'Belum diukur', desc: 'redaman belum terbaca',     color: '#cbd5e1' },
    ];

    // Hitung dari ONU yang sedang dimuat.
    const counts = { good: 0, warning: 0, critical: 0, los: 0, unmeasured: 0 };
    this.onus.forEach(o => {
      const q = o.quality;
      if (q === 'good' || q === 'warning' || q === 'critical' || q === 'los') counts[q]++;
      else counts.unmeasured++;   // unknown / null / belum diambil
    });

    const measured = counts.good + counts.warning + counts.critical;
    const totalAll = this.onus.length;
    if (hint) {
      hint.textContent = measured > 0
        ? `${measured} ONU terukur dari ${totalAll}`
        : (totalAll ? 'redaman belum terbaca' : 'menunggu data redaman…');
    }

    // Hanya tampilkan kategori yang ada isinya di chart (legenda tetap lengkap).
    const present = cats.filter(c => counts[c.key] > 0);
    const series = present.map(c => counts[c.key]);
    const labels = present.map(c => c.name);
    const colors = present.map(c => c.color);

    const options = {
      chart: { type: 'donut', height: 240, fontFamily: 'Plus Jakarta Sans, sans-serif',
        animations: { enabled: true, speed: 350 },
        events: {
          // Klik slice donut → buka daftar ONU kategori tsb.
          dataPointSelection: (e, ctx, cfg) => {
            const label = (this._rxPresentKeys || [])[cfg.dataPointIndex];
            if (label) this.showRxQualityDetail(label);
          },
        },
      },
      series: series.length ? series : [1],
      labels: labels.length ? labels : ['—'],
      colors: colors.length ? colors : ['#eef2f7'],
      // Warna semantik dipertahankan, tapi dilembutkan dgn gradient halus
      // (gaya modern seperti referensi) + sudut slice membulat.
      fill: {
        type: series.length ? 'gradient' : 'solid',
        gradient: { shade: 'light', type: 'diagonal1', shadeIntensity: 0.25, opacityFrom: 1, opacityTo: 0.92, stops: [0, 100] },
      },
      stroke: { width: 3, colors: ['#fff'], lineCap: 'round' },
      plotOptions: { pie: { donut: { size: '72%', labels: {
        show: true,
        total: { show: true, label: 'Total terukur', fontSize: '12px', color: '#94a3b8', fontWeight: 600,
          formatter: () => String(measured) },
        value: { fontSize: '26px', fontWeight: 800, color: '#0f172a', offsetY: 4 },
        name: { fontSize: '12px', color: '#94a3b8', offsetY: -2 },
      } }, expandOnClick: true } },
      dataLabels: { enabled: series.length > 0, style: { fontSize: '11px', fontWeight: 700, colors: ['#fff'] },
        formatter: (val, opts) => opts.w.config.series[opts.seriesIndex], dropShadow: { enabled: true, blur: 1, opacity: 0.25 } },
      legend: { show: false },
      tooltip: { theme: 'light', y: { formatter: (v) => `${v} ONU` } },
      states: { hover: { filter: { type: 'darken', value: 0.95 } }, active: { filter: { type: 'darken', value: 0.9 } } },
    };

    // Simpan urutan kunci kategori yang tampil (utk mapping klik slice).
    this._rxPresentKeys = present.map(c => c.key);

    const stillMounted = this.rxQualityChart && el.querySelector('.apexcharts-canvas');
    if (stillMounted) {
      this.rxQualityChart.updateOptions({ labels: options.labels, colors: options.colors,
        plotOptions: options.plotOptions, dataLabels: options.dataLabels }, false, false);
      this.rxQualityChart.updateSeries(options.series);
    } else {
      if (this.rxQualityChart) { try { this.rxQualityChart.destroy(); } catch (e) {} this.rxQualityChart = null; }
      el.innerHTML = '';
      this.rxQualityChart = new ApexCharts(el, options);
      this.rxQualityChart.render();
    }

    // Simpan kategori utk dipakai panel detail.
    this._rxCats = cats;

    // Legenda rinci (selalu tampilkan semua kategori). Baris bisa diklik untuk
    // menampilkan daftar ONU kategori tsb (kecuali yang jumlahnya 0).
    if (legend) {
      const denom = measured > 0 ? measured : 1;
      legend.innerHTML = cats.map(c => {
        const n = counts[c.key];
        const pct = (c.key === 'los' || c.key === 'unmeasured')
          ? (totalAll ? Math.round(n / totalAll * 100) : 0)
          : Math.round(n / denom * 100);
        const pctLbl = (c.key === 'los' || c.key === 'unmeasured') ? `${pct}% dari total` : `${pct}% terukur`;
        const clickable = n > 0;
        const active = this._rxActiveKey === c.key && clickable;
        return `<div class="rxq-row ${clickable ? '' : 'disabled'} ${active ? 'active' : ''}" ${clickable ? `onclick="OltMgmt.showRxQualityDetail('${c.key}')"` : ''}>
          <span class="rxq-ic" style="background:${c.color}"></span>
          <div class="rxq-meta">
            <div class="rxq-name">${c.name}${clickable ? `<svg class="rxq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>` : ''}</div>
            <div class="rxq-desc">${c.desc}</div>
          </div>
          <div><div class="rxq-count">${n}</div><div class="rxq-pct">${pctLbl}</div></div>
        </div>`;
      }).join('');
    }

    // Bila panel detail sedang terbuka, segarkan isinya (data mungkin berubah).
    if (this._rxActiveKey) this.showRxQualityDetail(this._rxActiveKey, true);
  },

  // Tampilkan daftar ONU untuk satu kategori kualitas di panel bawah chart.
  // refresh=true → hanya perbarui isi tanpa toggle buka/tutup.
  showRxQualityDetail(key, refresh = false) {
    const panel = document.getElementById('rxQualityDetail');
    const titleEl = document.getElementById('rxqDetailTitle');
    const bodyEl = document.getElementById('rxqDetailBody');
    if (!panel || !bodyEl) return;

    // Toggle: klik kategori yang sama → tutup.
    if (!refresh && this._rxActiveKey === key) {
      this._rxActiveKey = null;
      panel.style.display = 'none';
      this.renderRxQuality();   // segarkan highlight legenda
      return;
    }
    this._rxActiveKey = key;

    const cat = (this._rxCats || []).find(c => c.key === key);
    if (!cat) return;

    // Filter ONU sesuai kategori.
    const match = (o) => {
      if (key === 'unmeasured') return !['good','warning','critical','los'].includes(o.quality);
      return o.quality === key;
    };
    const list = this.onus.filter(match);

    if (titleEl) titleEl.innerHTML = `<span class="rxq-ic" style="display:inline-block;background:${cat.color};margin-right:8px;vertical-align:middle"></span>${cat.name} — ${list.length} ONU`;

    if (!list.length) {
      bodyEl.innerHTML = `<div class="ot-empty" style="padding:20px"><p>Tidak ada ONU pada kategori ini.</p></div>`;
    } else {
      const rows = list.map(o => {
        const name = o.name || o.description || '(tanpa nama)';
        const rx = (typeof o.onu_rx_dbm === 'number') ? `${o.onu_rx_dbm.toFixed(1)} dBm` : (o.quality === 'los' ? 'LOS' : '—');
        const idx = (o.onu_if || '').replace('gpon-onu_', '');
        const ifEsc = this._esc(o.onu_if || '');
        return `<tr class="rxq-clickable" onclick="OltMgmt.showDetail('${ifEsc}')" title="Lihat detail ONU">
          <td class="rxq-td-name">${this._esc(name)}</td>
          <td class="rxq-td-idx">${this._esc(idx)}</td>
          <td class="rxq-td-sn">${o.sn ? this._esc(o.sn) : '—'}</td>
          <td class="rxq-td-rx" style="color:${cat.color}">${rx}</td>
        </tr>`;
      }).join('');
      bodyEl.innerHTML = `<div class="rxq-table-wrap"><table class="rxq-table">
        <thead><tr><th>Nama</th><th>ONU Index</th><th>SN</th><th style="text-align:right">Redaman</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    }

    panel.style.display = 'block';
    if (!refresh) {
      // Segarkan highlight legenda lalu scroll ke panel.
      this.renderRxQuality();
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  },

  // Helper escape HTML (dipakai panel detail).
  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  },
  async loadPortSummary() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const raw = document.getElementById('summaryPorts').value.trim();
    if (!raw) { App.showToast('Masukkan daftar port, mis. 1,2,3', 'warning'); return; }
    const grid = document.getElementById('portSummaryGrid');
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--faint)"><span class="spin"></span> Memuat ringkasan…</div>`;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/port-summary?ports=${encodeURIComponent(raw)}`);
      if (!res?.success) { grid.innerHTML = `<div class="ot-empty" style="grid-column:1/-1;padding:24px"><p>${esc(res?.message || 'Gagal')}</p></div>`; return; }
      const data = res.data || [];
      if (!data.length) { grid.innerHTML = `<div class="ot-empty" style="grid-column:1/-1;padding:24px"><p>Tidak ada data.</p></div>`; return; }
      grid.innerHTML = data.map(p => {
        const pct = p.total ? Math.round((p.online / p.total) * 100) : 0;
        return `<div class="ot-portsum-card">
          <div class="ps-port">PON ${esc(String(p.port))}</div>
          <div class="ps-total">${p.total}</div>
          <div class="ps-meta"><span class="ps-on">${p.online} on</span><span class="ps-off">${p.offline} off</span></div>
          <div class="ps-bar"><span style="width:${pct}%"></span></div>
        </div>`;
      }).join('');
    } catch (e) {
      grid.innerHTML = `<div class="ot-empty" style="grid-column:1/-1;padding:24px"><p>${esc(e.message)}</p></div>`;
    }
  },

  // ════════════════════ Info sistem ════════════════════
  async loadSystem(silent) {
    if (!this.activeOltId) { if (!silent) App.showToast('Pilih OLT dulu', 'warning'); return; }
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/system`);
      if (!res?.success) { if (!silent) App.showToast(res?.message || 'Gagal memuat sistem', 'error'); return; }
      this.applySystem(res.data || {});
    } catch (e) { if (!silent) App.showToast('Error: ' + e.message, 'error'); }
  },

  // Terapkan data sistem ke kartu (dipakai loadSystem & autoDiscover)
  applySystem(d) {
    d = d || {};
    const cpu = d.cpu_percent;
    document.getElementById('sysCpu').textContent = cpu == null ? '—' : `${cpu}%`;
    document.getElementById('sysCpuBar').style.width = (cpu == null ? 0 : Math.min(100, cpu)) + '%';
    document.getElementById('sysTemp').textContent = d.temperature_c == null ? '—' : `${d.temperature_c}°C`;
    document.getElementById('sysTempSub').innerHTML = d.temperature_c == null ? '&nbsp;' : (d.temperature_c >= 60 ? '<span style="color:#b91c1c">tinggi</span>' : 'normal');
    document.getElementById('sysUptime').textContent = d.uptime || '—';
    document.getElementById('sysVersion').textContent = d.version || '—';
    document.getElementById('sysModel').textContent = d.model ? (d.system_name && d.system_name !== d.model ? `${d.model} (${d.system_name})` : d.model) : '—';
    document.getElementById('sysHw').textContent = d.hw_version || '—';
  },

  // ════════════════════ Daftar Card / Slot GPON ════════════════════
  // Memuat hasil "show card" + "show environment" untuk ditampilkan sebagai
  // kartu detail per slot di tab Sistem (hanya untuk OLT ZTE).
  async loadCards(silent) {
    const panel = document.getElementById('cardsPanel');
    const empty = document.getElementById('cardsEmpty');
    if (!panel || !this.activeOltId) return;
    // Hanya tampil untuk ZTE — brand lain tidak punya konsep slot/card
    if (!this._isZte()) { panel.style.display = 'none'; if (empty) empty.style.display = ''; return; }
    panel.style.display = '';
    if (empty) empty.style.display = 'none';
    const grid = document.getElementById('cardsGrid');
    const sum  = document.getElementById('cardsSummary');
    if (!silent) grid.innerHTML = `<div class="gpon-cards-loading"><span class="spin"></span> Memuat daftar card dari OLT…</div>`;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/cards`);
      if (!res?.success) {
        grid.innerHTML = `<div class="gpon-cards-loading">Gagal: ${esc(res?.message || 'Error')}</div>`;
        if (sum) sum.innerHTML = '';
        document.getElementById('cardsCount').textContent = '0 slot';
        return;
      }
      const cards = res.data || [];
      document.getElementById('cardsCount').textContent = `${cards.length} slot`;
      if (!cards.length) {
        if (sum) sum.innerHTML = '';
        grid.innerHTML = `<div class="gpon-cards-loading">Tidak ada card terdeteksi. Coba jalankan <code>show card</code> dari tab Diagnostik untuk memverifikasi.</div>`;
        return;
      }
      // Ringkasan: hitung per kategori status
      const on  = cards.filter(c => /INSERVICE|ACTIVE|READY/i.test(c.status)).length;
      const off = cards.filter(c => /OFFLINE|NOPOWER/i.test(c.status)).length;
      const oth = cards.length - on - off;
      if (sum) {
        sum.innerHTML =
          `<span class="gcs-pill gcs-on"><span class="d"></span>${on} INSERVICE</span>` +
          `<span class="gcs-pill gcs-off"><span class="d"></span>${off} OFFLINE</span>` +
          (oth > 0 ? `<span class="gcs-pill gcs-other"><span class="d"></span>${oth} lainnya</span>` : '') +
          `<span class="gcs-pill gcs-tot">${cards.length} slot terpasang</span>`;
      }
      grid.innerHTML = cards.map(c => this._renderGponCard(c)).join('');
    } catch (e) {
      grid.innerHTML = `<div class="gpon-cards-loading">Error: ${esc(e.message)}</div>`;
      if (sum) sum.innerHTML = '';
    }
  },

  _renderGponCard(c) {
    const stKey = String(c.status || '').toLowerCase();
    const knownSt = ['inservice','active','ready','register','standby','offline','nopower'];
    const stCls = knownSt.includes(stKey) ? `gc-st-${stKey}` : 'gc-st-other';
    const isOff = /OFFLINE|NOPOWER/i.test(c.status || '');
    const isCtrl = c.type === 'control';
    const icCls = isOff ? 'off' : (isCtrl ? 'ctrl' : '');

    // Ikon: control card (chip + pin) vs PON card (slot port)
    const icSvg = isCtrl
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><line x1="7" y1="10" x2="7" y2="14"/><line x1="11" y1="10" x2="11" y2="14"/><line x1="15" y1="10" x2="15" y2="14"/><line x1="19" y1="10" x2="19" y2="14"/></svg>';

    const fmt = (v) => (v == null || v === '') ? '<span class="gc-v muted">—</span>' : `<span class="gc-v" title="${esc(String(v))}">${esc(String(v))}</span>`;
    const cardTypeLabel = isCtrl ? 'Control Card' : (c.type === 'pon' ? 'GPON Card' : 'Card');
    const portsLbl = isCtrl ? 'Port' : 'PON';

    // ── Gauge melingkar suhu (hero, terinspirasi referензi monitoring) ──
    // Skala 0–80°C. Warna semantik: hijau <60, kuning 60-69, merah ≥70.
    let gaugeHtml;
    if (c.temperature_c == null) {
      gaugeHtml = `<div class="gc-gauge gc-gauge-empty">
        <svg viewBox="0 0 80 80"><circle class="gc-gauge-bg" cx="40" cy="40" r="34"/></svg>
        <div class="gc-gauge-c"><span class="gc-gauge-num mut">—</span></div>
      </div>`;
    } else {
      const t = c.temperature_c;
      const color = t >= 70 ? '#dc2626' : (t >= 60 ? '#d97706' : '#0891b2');
      const pct = Math.max(0, Math.min(1, t / 80));
      const R = 34, CIRC = 2 * Math.PI * R;
      const dash = (pct * CIRC).toFixed(1);
      gaugeHtml = `<div class="gc-gauge">
        <svg viewBox="0 0 80 80">
          <circle class="gc-gauge-bg" cx="40" cy="40" r="${R}"/>
          <circle class="gc-gauge-fg" cx="40" cy="40" r="${R}" stroke="${color}"
            stroke-dasharray="${dash} ${(CIRC - dash).toFixed(1)}" stroke-dashoffset="0"
            transform="rotate(-90 40 40)"/>
        </svg>
        <div class="gc-gauge-c"><span class="gc-gauge-num" style="color:${color}">${t}<span class="gc-gauge-u">°C</span></span><span class="gc-gauge-lbl">suhu</span></div>
      </div>`;
    }

    // ── Bar CPU & Memory (bila tersedia) ──
    let barsHtml = '';
    if (c.cpu_percent != null || c.mem_percent != null) {
      const barCls = (v) => v == null ? '' : (v >= 85 ? ' hot' : (v >= 70 ? ' warn' : ''));
      const cpuV = c.cpu_percent, memV = c.mem_percent;
      const rowCpu = cpuV == null ? '' : `
        <div class="gc-bar-row">
          <span class="gc-bar-lbl">CPU</span>
          <span class="gc-bar-track"><span class="gc-bar-fill cpu${barCls(cpuV)}" style="width:${Math.min(100, cpuV)}%"></span></span>
          <span class="gc-bar-val">${cpuV}%</span>
        </div>`;
      const rowMem = memV == null ? '' : `
        <div class="gc-bar-row">
          <span class="gc-bar-lbl">MEM</span>
          <span class="gc-bar-track"><span class="gc-bar-fill mem${barCls(memV)}" style="width:${Math.min(100, memV)}%"></span></span>
          <span class="gc-bar-val">${memV}%${c.mem_mb ? ` <span class="mut" style="font-size:9.5px">/ ${c.mem_mb}MB</span>` : ''}</span>
        </div>`;
      barsHtml = `<div class="gc-bars">${rowCpu}${rowMem}</div>`;
    }

    return `<div class="gpon-card ${isOff ? 'is-off' : ''}">
      <div class="gpon-card-hdr">
        <div class="gpon-card-pos">
          <span class="gpon-card-ic ${icCls}">${icSvg}</span>
          <span class="gpon-card-title">
            <span class="gpon-card-name">Slot ${esc(c.slot_label || '?')}</span>
            <span class="gpon-card-sub">${esc(cardTypeLabel)}</span>
          </span>
        </div>
        <span class="gpon-card-st ${stCls}"><span class="pd"></span>${esc(c.status || '—')}</span>
      </div>
      <div class="gpon-card-main">
        ${gaugeHtml}
        <div class="gc-main-info">
          <div class="gc-mi-row"><span class="gc-mi-k">${esc(portsLbl)}</span><span class="gc-mi-v">${c.port != null ? c.port : '—'}</span></div>
          <div class="gc-mi-row"><span class="gc-mi-k">CfgType</span>${fmt(c.cfgType)}</div>
          <div class="gc-mi-row"><span class="gc-mi-k">RealType</span>${fmt(c.realType)}</div>
        </div>
      </div>
      <div class="gpon-card-body">
        <div class="gc-row"><span class="gc-k">HW Ver</span>${fmt(c.hw_version)}</div>
        <div class="gc-row"><span class="gc-k">SW Ver</span>${fmt(c.sw_version)}</div>
      </div>
      ${barsHtml}
    </div>`;
  },

  // ════════════════════ Diagnostik CLI ════════════════════
  renderRawSuggest() {
    const el = document.getElementById('rawSuggest');
    if (!el) return;
    let cmds;
    if (this._isZte()) {
      cmds = ['show card', 'show onu-type gpon', 'show card-temperature', 'show processor', 'show gpon onu state gpon-olt_1/2/1', 'show gpon profile tcont', 'show gpon onu uncfg', 'show vlan summary'];
    } else if (this.activeEpon) {
      cmds = ['show onu-info all', 'show vlan', 'board', 'show system'];
    } else {
      cmds = ['show onu_information', 'show vlan all', 'show system info', 'show card'];
    }
    el.innerHTML = cmds.map(c => `<button class="pon-pill" onclick="document.getElementById('rawCmd').value=this.textContent;OltMgmt.runRaw()">${esc(c)}</button>`).join('');
  },

  async runRaw() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const cmd = document.getElementById('rawCmd').value.trim();
    if (!cmd) { App.showToast('Masukkan perintah show', 'warning'); return; }
    const out = document.getElementById('rawOutput');
    const btn = document.getElementById('btnRunRaw');
    btn.disabled = true;
    out.style.display = 'block';
    out.textContent = 'Menjalankan...';
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/raw`, { method: 'POST', body: JSON.stringify({ cmd }) });
      if (res?.success) {
        out.textContent = res.data.output || '(output kosong)';
      } else {
        out.textContent = '✗ ' + (res?.message || 'Gagal');
      }
    } catch (e) {
      out.textContent = '✗ ' + e.message;
    } finally { btn.disabled = false; }
  },

  // ════════════════════ VLAN global ════════════════════
  // ════════════════════ Profil T-CONT & Traffic ════════════════════
  async loadProfiles() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const tEl = document.getElementById('tcontProfileList');
    const fEl = document.getElementById('trafficProfileList');
    tEl.innerHTML = '<div style="padding:20px;color:var(--faint)"><span class="spin"></span> Memuat…</div>';
    fEl.innerHTML = '<div style="padding:20px;color:var(--faint)"><span class="spin"></span> Memuat…</div>';
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/profiles`);
      if (!res?.success) { tEl.innerHTML = fEl.innerHTML = `<div class="ot-alert err show">${esc(res?.message || 'Gagal')}</div>`; return; }
      const d = res.data || {};
      this._profilesCache = d;
      tEl.innerHTML = this._renderTcontProfiles(d.tcontDetail || [], d.tcont || []);
      fEl.innerHTML = this._renderTrafficProfiles(d.trafficDetail || [], d.traffic || []);
    } catch (e) {
      tEl.innerHTML = fEl.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`;
    }
  },

  _renderTcontProfiles(detail, names) {
    // gabungkan detail (punya bandwidth) dengan nama saja (fallback)
    const byName = {}; detail.forEach(p => byName[p.name] = p);
    names.forEach(n => { if (!byName[n]) byName[n] = { name: n }; });
    const rows = Object.values(byName);
    if (!rows.length) return '<div style="padding:20px;color:var(--faint)">Belum ada profil T-CONT.</div>';
    const typeLabel = (t) => ({1:'Fixed',2:'Assured',3:'Assured+Max',4:'Maximum',5:'Fixed+Ass+Max'}[t] || (t!=null?'Type '+t:'—'));
    return `<table class="onu-table"><thead><tr><th>Nama</th><th>Type</th><th>Max BW</th><th style="text-align:right">Aksi</th></tr></thead><tbody>` +
      rows.map(p => {
        const isDefault = /^default$/i.test(p.name);
        const mbw = p.mbw != null ? (p.mbw >= 1000 ? (p.mbw/1000).toFixed(0)+' Mbps' : p.mbw+' kbps') : '—';
        return `<tr>
          <td><span class="onu-if">${esc(p.name)}</span></td>
          <td>${esc(typeLabel(p.type))}</td>
          <td>${esc(mbw)}</td>
          <td style="text-align:right">${isDefault ? '<span class="mut" style="font-size:11px">bawaan</span>' :
            `<button class="ra del" title="Hapus" onclick="OltMgmt.deleteProfile('tcont','${esc(p.name)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>`}</td>
        </tr>`;
      }).join('') + '</tbody></table>';
  },

  _renderTrafficProfiles(detail, names) {
    const byName = {}; detail.forEach(p => byName[p.name] = p);
    names.forEach(n => { if (!byName[n]) byName[n] = { name: n }; });
    const rows = Object.values(byName);
    if (!rows.length) return '<div style="padding:20px;color:var(--faint)">Belum ada profil Traffic.</div>';
    const fmt = (v) => v == null ? '—' : (typeof v === 'number' ? (v >= 1000 ? (v/1000).toFixed(0)+'M' : v+'k') : v);
    return `<table class="onu-table"><thead><tr><th>Nama</th><th>SIR</th><th>PIR</th><th style="text-align:right">Aksi</th></tr></thead><tbody>` +
      rows.map(p => {
        const isDefault = /^default$/i.test(p.name);
        return `<tr>
          <td><span class="onu-if">${esc(p.name)}</span></td>
          <td>${esc(fmt(p.sir))}</td>
          <td>${esc(fmt(p.pir))}</td>
          <td style="text-align:right">${isDefault ? '<span class="mut" style="font-size:11px">bawaan</span>' :
            `<button class="ra del" title="Hapus" onclick="OltMgmt.deleteProfile('traffic','${esc(p.name)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>`}</td>
        </tr>`;
      }).join('') + '</tbody></table>';
  },

  openProfileForm(kind) {
    const isTcont = kind === 'tcont';
    const title = isTcont ? 'Tambah Profil T-CONT' : 'Tambah Profil Traffic';
    const fields = isTcont ? `
      <div class="form-group"><label class="form-label">Nama Profil</label><input id="pfName" class="form-control" placeholder="mis. UP-50M"></div>
      <div class="form-group"><label class="form-label">Type</label>
        <select id="pfType" class="form-control">
          <option value="3">Type 3 — Assured + Maximum (up-to, disarankan)</option>
          <option value="5">Type 5 — Fixed + Assured + Maximum</option>
          <option value="4">Type 4 — Maximum saja</option>
          <option value="2">Type 2 — Assured saja</option>
          <option value="1">Type 1 — Fixed (boros kapasitas PON)</option>
        </select></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Assured (kbps)</label><input id="pfAssured" class="form-control" type="number" placeholder="25000"></div>
        <div class="form-group"><label class="form-label">Maximum (kbps)</label><input id="pfMax" class="form-control" type="number" placeholder="50000"></div>
      </div>
      <div class="form-group"><label class="form-label">Fixed (kbps, utk type 1/5)</label><input id="pfFixed" class="form-control" type="number" placeholder="0"></div>
      <div class="form-hint">50 Mbps = 50000 kbps. Type 3/5 hemat kapasitas PON.</div>` : `
      <div class="form-group"><label class="form-label">Nama Profil</label><input id="pfName" class="form-control" placeholder="mis. 50M"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">SIR (kbps)</label><input id="pfSir" class="form-control" type="number" placeholder="50000"></div>
        <div class="form-group"><label class="form-label">PIR (kbps)</label><input id="pfPir" class="form-control" type="number" placeholder="50000"></div>
      </div>
      <div class="form-hint">SIR = committed rate, PIR = peak. Untuk 50 Mbps isi 50000. Biasanya SIR = PIR.</div>`;
    this._infoBox(title, `<div style="text-align:left">${fields}<div style="text-align:right;margin-top:8px"><button class="btn btn-green btn-sm" onclick="OltMgmt.saveProfile('${kind}')">Simpan</button></div></div>`, 'green');
  },

  async saveProfile(kind) {
    const name = document.getElementById('pfName')?.value.trim();
    if (!name) { App.showToast('Nama profil wajib diisi', 'warning'); return; }
    let payload = { kind, name };
    if (kind === 'tcont') {
      payload.type = document.getElementById('pfType')?.value || 3;
      payload.assured = document.getElementById('pfAssured')?.value || undefined;
      payload.maximum = document.getElementById('pfMax')?.value || undefined;
      payload.fixed = document.getElementById('pfFixed')?.value || undefined;
    } else {
      payload.sir = document.getElementById('pfSir')?.value;
      payload.pir = document.getElementById('pfPir')?.value;
      if (!payload.sir) { App.showToast('SIR wajib diisi', 'warning'); return; }
    }
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/profiles`, { method: 'POST', body: JSON.stringify(payload) });
      if (res?.success) {
        App.showToast(res.message || 'Profil tersimpan', 'success');
        document.getElementById('_oltInfoBox')?.remove();
        this.loadProfiles();
      } else App.showToast(res?.message || 'Gagal', 'error');
    } catch (e) { App.showToast('Error: ' + e.message, 'error'); }
  },

  deleteProfile(kind, name) {
    this._confirm('Hapus Profil?', `Profil ${kind} <b>${esc(name)}</b> akan dihapus dari OLT. Gagal bila masih dipakai ONU.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/profiles`, { method: 'DELETE', body: JSON.stringify({ kind, name }) });
      if (res?.success) { App.showToast(res.message || 'Profil dihapus', 'success'); this.loadProfiles(); }
      else App.showToast(res?.message || 'Gagal hapus', 'error');
    });
  },

  async loadVlans() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const body = document.getElementById('vlanBody');
    body.innerHTML = `<tr class="loading-row"><td colspan="5"><span class="spin"></span> Memuat VLAN…</td></tr>`;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans`);
      if (!res?.success) { body.innerHTML = `<tr><td colspan="5"><div class="ot-empty" style="padding:36px 20px"><h3>Gagal</h3><p>${esc(res?.message || 'Error')}</p></div></td></tr>`; return; }
      this.vlans = res.data || [];
      document.getElementById('vlanCount').textContent = `${this.vlans.length} VLAN`;
      if (!this.vlans.length) {
        const ztehint = this._isZte() ? ' Daftar ini menggabungkan VLAN dari summary, VLAN profile, dan port uplink. Jika tetap kosong, kemungkinan VLAN hanya dipakai lewat service-port per ONU (tab ONU → tombol VLAN).' : '';
        body.innerHTML = `<tr><td colspan="5"><div class="ot-empty" style="padding:40px 20px"><h3>Tidak ada VLAN global</h3><p>Klik "Buat VLAN" untuk menambah.${ztehint}</p></div></td></tr>`;
        return;
      }
      const srcBadge = (s) => {
        const map = { profile: ['Profile', 'pill-teal'], uplink: ['Uplink', 'pill-blue'], summary: ['VLAN', 'pill-gray'] };
        const [lbl, cls] = map[s] || [s, 'pill-gray'];
        return `<span class="card-pill ${cls}" style="margin-left:5px;font-size:10px">${esc(lbl)}</span>`;
      };
      body.innerHTML = this.vlans.map(v => `<tr class="vlan-row" style="cursor:pointer" onclick="OltMgmt.openVlanDetail(${v.vid})">
        <td><span class="onu-if">${v.vid}</span></td>
        <td>${v.name ? esc(v.name) : '<span class="mut">—</span>'}${(v.sources || []).map(srcBadge).join('')}</td>
        <td>${v.type ? esc(v.type) : '<span class="mut">—</span>'}</td>
        <td>${v.ports ? `<span class="onu-sn">${esc(v.ports)}</span>` : '<span class="mut">—</span>'}</td>
        <td onclick="event.stopPropagation()"><div class="row-acts">
          <button class="ra info" title="Detail VLAN" onclick="OltMgmt.openVlanDetail(${v.vid})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></button>
          <button class="ra edit" title="Edit nama VLAN" onclick="OltMgmt.openVlanDetail(${v.vid}, true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="ra del" title="Hapus VLAN" onclick="OltMgmt.deleteVlan(${v.vid})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
        </div></td>
      </tr>`).join('');
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5"><div class="ot-empty" style="padding:36px 20px"><h3>Error</h3><p>${esc(e.message)}</p></div></td></tr>`;
    }
  },

  openVlanModal() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    document.getElementById('vlanVid').value = '';
    document.getElementById('vlanName').value = '';
    document.getElementById('vlanModal').classList.add('show');
  },
  closeVlanModal() { document.getElementById('vlanModal').classList.remove('show'); },

  async saveVlan() {
    const vid = document.getElementById('vlanVid').value;
    const name = document.getElementById('vlanName').value.trim();
    if (!vid) { App.showToast('VLAN ID wajib', 'error'); return; }
    const btn = document.getElementById('btnSaveVlan'); btn.disabled = true;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans`, { method: 'POST', body: JSON.stringify({ vid, name }) });
      if (res?.success) { App.showToast(res.message || 'VLAN dibuat', 'success'); this.closeVlanModal(); await this.loadVlans(); }
      else App.showToast(res?.message || 'Gagal', 'error');
    } catch (e) { App.showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; }
  },

  deleteVlan(vid) {
    this._confirm('Hapus VLAN?', `VLAN <b>${vid}</b> akan dihapus dari OLT. Pastikan tidak dipakai service aktif.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans/${vid}`, { method: 'DELETE' });
      if (res?.success) { App.showToast(res.message || 'VLAN dihapus', 'success'); await this.loadVlans(); }
      else App.showToast(res?.message || 'Gagal hapus', 'error');
    });
  },

  // ── Detail & Edit VLAN ──────────────────────────────────────────────
  async openVlanDetail(vid, focusEdit) {
    this._vlanDetailVid = vid;
    document.getElementById('vlanDetailVid').textContent = vid;
    document.getElementById('vlanEditName').value = '';
    const body = document.getElementById('vlanDetailBody');
    body.innerHTML = `<div class="loading-row" style="padding:30px;text-align:center"><span class="spin"></span> Memuat detail…</div>`;
    document.getElementById('vlanDetailModal').classList.add('show');
    // Prefill nama dari data list yang sudah ada (biar instan)
    const known = (this.vlans || []).find(v => v.vid === vid);
    if (known && known.name) document.getElementById('vlanEditName').value = known.name;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans/${vid}`);
      if (!res?.success) { body.innerHTML = `<div class="info-note">Gagal memuat detail: ${esc(res?.message || 'Error')}</div>`; return; }
      this.renderVlanDetail(res.data || {});
      if ((res.data?.name || res.data?.description) && !document.getElementById('vlanEditName').value) {
        document.getElementById('vlanEditName').value = res.data.name || res.data.description;
      }
    } catch (e) {
      body.innerHTML = `<div class="info-note">Error: ${esc(e.message)}</div>`;
    }
    if (focusEdit) setTimeout(() => document.getElementById('vlanEditName').focus(), 150);
  },

  renderVlanDetail(d) {
    const body = document.getElementById('vlanDetailBody');
    const rows = [];
    const known = (this.vlans || []).find(v => v.vid === d.vid) || {};
    const srcs = d.sources && d.sources.length ? d.sources : (known.sources || []);
    const srcLabel = { profile: 'VLAN Profile', uplink: 'Port Uplink', summary: 'VLAN Summary' };

    rows.push(`<div class="vd-row"><span class="vd-k">VLAN ID</span><span class="vd-v"><span class="onu-if">${d.vid}</span></span></div>`);
    rows.push(`<div class="vd-row"><span class="vd-k">Sumber</span><span class="vd-v">${srcs.length ? srcs.map(s => `<span class="card-pill pill-teal" style="margin-right:4px">${esc(srcLabel[s] || s)}</span>`).join('') : '<span class="mut">—</span>'}</span></div>`);

    if (d.profile) {
      rows.push(`<div class="vd-row"><span class="vd-k">Profile</span><span class="vd-v"><b>${esc(d.profile.name)}</b></span></div>`);
      rows.push(`<div class="vd-row"><span class="vd-k">Tag Mode</span><span class="vd-v">${esc(d.profile.tagMode || '—')}</span></div>`);
      rows.push(`<div class="vd-row"><span class="vd-k">CVLAN</span><span class="vd-v">${d.profile.cvlan ?? '—'}</span></div>`);
    }
    const ports = (d.uplinkPorts && d.uplinkPorts.length) ? d.uplinkPorts : (known.ports ? String(known.ports).split(',').map(s=>s.trim()) : []);
    rows.push(`<div class="vd-row"><span class="vd-k">Port Uplink</span><span class="vd-v">${ports.length ? ports.map(p => `<span class="onu-sn" style="margin-right:6px">${esc(p)}</span>`).join('') : '<span class="mut">tidak terpasang di uplink</span>'}</span></div>`);
    if (d.description) rows.push(`<div class="vd-row"><span class="vd-k">Deskripsi</span><span class="vd-v">${esc(d.description)}</span></div>`);

    body.innerHTML = `<div class="vlan-detail-grid">${rows.join('')}</div>
      ${d.profile ? `<div class="info-note" style="margin-top:10px">VLAN ini punya <b>VLAN Profile</b> bernama "<b>${esc(d.profile.name)}</b>". Nama profil dikelola dari konfigurasi profil OLT; mengubah nama di sini hanya menambah <code>description</code> pada VLAN global.</div>` : ''}
      <div class="info-note" style="margin-top:10px">VLAN per-ONU (service-port) diatur dari tab <b>ONU → tombol VLAN</b> pada baris ONU.</div>`;
  },

  closeVlanDetail() { document.getElementById('vlanDetailModal').classList.remove('show'); this._vlanDetailVid = null; },

  async saveVlanEdit() {
    const vid = this._vlanDetailVid;
    if (!vid) return;
    const name = document.getElementById('vlanEditName').value.trim();
    const btn = document.getElementById('btnSaveVlanEdit'); btn.disabled = true;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans/${vid}`, { method: 'PUT', body: JSON.stringify({ name }) });
      if (res?.success) { App.showToast(res.message || 'VLAN diperbarui', 'success'); this.closeVlanDetail(); await this.loadVlans(); }
      else App.showToast(res?.message || 'Gagal update', 'error');
    } catch (e) { App.showToast('Error: ' + e.message, 'error'); }
    finally { btn.disabled = false; }
  },

  deleteVlanFromDetail() {
    const vid = this._vlanDetailVid;
    if (!vid) return;
    this._confirm('Hapus VLAN?', `VLAN <b>${vid}</b> akan dihapus dari OLT. Pastikan tidak dipakai service aktif.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/vlans/${vid}`, { method: 'DELETE' });
      if (res?.success) { App.showToast(res.message || 'VLAN dihapus', 'success'); this.closeVlanDetail(); await this.loadVlans(); }
      else App.showToast(res?.message || 'Gagal hapus', 'error');
    });
  },

  // ════════════════════ VLAN per-ONU ════════════════════
  async openOnuVlan(onuIf) {
    document.getElementById('onuVlanTitle').textContent = 'VLAN ONU ' + onuIf;
    document.getElementById('onuVlanRef').value = onuIf;
    document.getElementById('spSp').value = '1';
    document.getElementById('spGem').value = '1';
    document.getElementById('spUserVlan').value = '';
    document.getElementById('spVlan').value = '';
    const list = document.getElementById('onuVlanList');
    list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--faint)"><span class="spin"></span> Memuat service-port…</div>`;
    document.getElementById('onuVlanModal').classList.add('show');
    try {
      const qs = this._isZte() ? `if=${encodeURIComponent(onuIf)}` : `if=${encodeURIComponent(onuIf)}`;
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/vlans?${qs}`);
      if (!res?.success) { list.innerHTML = `<div class="ot-alert err show">${esc(res?.message || 'Gagal')}</div>`; return; }
      const rows = res.data || [];
      if (!rows.length) { list.innerHTML = `<div class="ot-empty" style="padding:20px"><p>Belum ada service-port pada ONU ini.</p></div>`; return; }
      list.innerHTML = `<table class="onu-table"><thead><tr><th>SP</th><th>GEM</th><th>User VLAN</th><th>VLAN</th><th></th></tr></thead><tbody>` +
        rows.map(r => `<tr>
          <td><span class="onu-if">${r.service_port ?? '—'}</span></td>
          <td>${r.gemport ?? '—'}</td>
          <td>${r.user_vlan ?? '—'}</td>
          <td><span class="rx-badge rx-good">${r.vlan ?? '—'}</span></td>
          <td style="text-align:right"><button class="ra del" title="Hapus" onclick="OltMgmt.deleteOnuVlan('${esc(onuIf)}',${r.service_port ?? 1})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></td>
        </tr>`).join('') + `</tbody></table>`;
    } catch (e) { list.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`; }
  },

  closeOnuVlan() { document.getElementById('onuVlanModal').classList.remove('show'); },

  async saveOnuVlan() {
    const onuIf = document.getElementById('onuVlanRef').value;
    const sp = document.getElementById('spSp').value;
    const gem = document.getElementById('spGem').value;
    const userVlan = document.getElementById('spUserVlan').value;
    const vlan = document.getElementById('spVlan').value;
    if (!vlan) { App.showToast('VLAN wajib diisi', 'error'); return; }
    const payload = this._isZte() ? { onuIf, sp, gem, userVlan, vlan } : { onuIf, sp, gem, userVlan, vlan };
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/vlans`, { method: 'POST', body: JSON.stringify(payload) });
      if (res?.success) { App.showToast(res.message || 'VLAN diterapkan', 'success'); this.openOnuVlan(onuIf); }
      else App.showToast(res?.message || 'Gagal', 'error');
    } catch (e) { App.showToast('Error: ' + e.message, 'error'); }
  },

  deleteOnuVlan(onuIf, sp) {
    this._confirm('Hapus Service-Port?', `Service-port <b>${sp}</b> pada ONU akan dihapus.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/vlans`, { method: 'DELETE', body: JSON.stringify({ onuIf, sp }) });
      if (res?.success) { App.showToast('Dihapus', 'success'); this.openOnuVlan(onuIf); }
      else App.showToast(res?.message || 'Gagal', 'error');
    });
  },

  // ════════════════════ ONU detail ════════════════════
  async showDetail(onuIf) {
    const modal = document.getElementById('detailModal');
    const body = document.getElementById('detailBody');
    document.getElementById('detailTitle').textContent = 'Detail ONU ' + onuIf;
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--faint)"><span class="spin"></span> Memuat detail dari OLT...</div>';
    modal.classList.add('show');
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/detail?if=${encodeURIComponent(onuIf)}`);
      if (!res?.success) { body.innerHTML = `<div class="ot-alert err show">${esc(res?.message || 'Gagal')}</div>`; return; }
      body.innerHTML = this._renderDetail(res.data);
    } catch (e) {
      body.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`;
    }
  },

  _renderDetail(d) {
    const p = d.power || {};
    const rxClass = (q) => 'rx-' + (['good','warning','critical','los'].includes(q) ? q : 'unknown');
    const fmt = (v, suf='') => (v === null || v === undefined) ? '<span class="mut">—</span>' : `${v}${suf}`;
    const colorFor = (q) => ({ good:'#15803d', warning:'#b45309', critical:'#b91c1c', los:'#b91c1c' }[q] || '#94a3b8');

    let powerHtml = '';
    if (p && (p.onu_rx_dbm !== undefined)) {
      powerHtml = `
        <div class="power-grid">
          <div class="power-box"><div class="pk">ONU Rx (redaman pelanggan)</div><div class="pv" style="color:${colorFor(p.quality)}">${p.no_signal ? 'LOS' : fmt(p.onu_rx_dbm, ' dBm')}</div></div>
          <div class="power-box"><div class="pk">ONU Tx</div><div class="pv">${fmt(p.onu_tx_dbm, ' dBm')}</div></div>
          <div class="power-box"><div class="pk">OLT Rx (upstream)</div><div class="pv">${fmt(p.olt_rx_dbm, ' dBm')}</div></div>
          <div class="power-box"><div class="pk">OLT Tx (downstream)</div><div class="pv">${fmt(p.olt_tx_dbm, ' dBm')}</div></div>
        </div>
        <div class="info-note" style="margin-bottom:14px">Toleransi Rx ONU normal hingga ~-25 dBm. Di bawah -28 dBm perlu perbaikan optik. "LOS" = tidak ada sinyal (kabel putus/ONU mati).</div>`;
    }

    const diagHtml = d.diagnosis
      ? `<div class="info-note" style="margin-bottom:14px;border-left:3px solid ${/los/i.test(d.phase_state||'') ? '#dc2626' : '#d97706'};background:${/los/i.test(d.phase_state||'') ? '#fef2f2' : '#fffbeb'}">⚠ ${esc(d.diagnosis)}</div>`
      : '';

    return `${diagHtml}${powerHtml}
      <div class="det-grid">
        <div class="det-cell"><div class="det-k">Interface</div><div class="det-v mono">${esc(d.onu_if||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Serial Number</div><div class="det-v mono">${esc(d.serial_number||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Nama</div><div class="det-v">${esc(d.name||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Type</div><div class="det-v">${esc(d.type||'—')}</div></div>
        <div class="det-cell"><div class="det-k">State</div><div class="det-v">${esc(d.state||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Phase State</div><div class="det-v">${esc(d.phase_state||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Config State</div><div class="det-v">${esc(d.config_state||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Admin State</div><div class="det-v">${esc(d.admin_state||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Auth Mode</div><div class="det-v">${esc(d.auth_mode||'—')}</div></div>
        <div class="det-cell"><div class="det-k">Jarak (Distance)</div><div class="det-v">${d.distance_m != null ? d.distance_m + ' m' : '—'}</div></div>
        <div class="det-cell"><div class="det-k">Online Duration</div><div class="det-v">${esc(d.online_duration||'—')}</div></div>
        <div class="det-cell full"><div class="det-k">Deskripsi</div><div class="det-v">${esc(d.description||'—')}</div></div>
      </div>`;
  },

  closeDetail() { document.getElementById('detailModal').classList.remove('show'); },

  // ════════════════════ Traffic real-time ONU ════════════════════
  async openOnuTraffic(onuIf, name) {
    this._tfOnuIf = onuIf;
    this._tfData = [];   // riwayat untuk sparkline [{down,up}]
    document.getElementById('trafficOnuTitle').textContent = onuIf + (name ? ` · ${name}` : '');
    document.getElementById('tfDown').textContent = '—';
    document.getElementById('tfUp').textContent = '—';
    document.getElementById('tfDownPps').innerHTML = '&nbsp;';
    document.getElementById('tfUpPps').innerHTML = '&nbsp;';
    document.getElementById('tfStamp').textContent = '';
    document.getElementById('tfAuto').checked = true;
    document.getElementById('onuTrafficModal').classList.add('show');
    await this.refreshOnuTraffic();
    this._startTrafficTimer();
  },

  _startTrafficTimer() {
    this._stopTrafficTimer();
    this._tfTimer = setInterval(() => {
      if (document.getElementById('tfAuto')?.checked) this.refreshOnuTraffic(true);
    }, 3000);
  },
  _stopTrafficTimer() { if (this._tfTimer) { clearInterval(this._tfTimer); this._tfTimer = null; } },

  closeOnuTraffic() {
    this._stopTrafficTimer();
    this._tfOnuIf = null;
    document.getElementById('onuTrafficModal').classList.remove('show');
  },

  // Format bit/s → Kbps/Mbps/Gbps
  _fmtRate(bits) {
    if (bits == null) return '—';
    if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
    if (bits >= 1e6) return (bits / 1e6).toFixed(2) + ' Mbps';
    if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' Kbps';
    return Math.round(bits) + ' bps';
  },

  async refreshOnuTraffic(silent) {
    const onuIf = this._tfOnuIf;
    if (!onuIf) return;
    const btn = document.getElementById('tfRefreshBtn');
    if (!silent && btn) { btn.disabled = true; btn.textContent = 'Memuat…'; }
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/traffic?if=${encodeURIComponent(onuIf)}`);
      if (res?.success && res.data) {
        const d = res.data;
        document.getElementById('tfDown').textContent = this._fmtRate(d.output_bits); // ke pelanggan
        document.getElementById('tfUp').textContent   = this._fmtRate(d.input_bits);  // dari pelanggan
        document.getElementById('tfDownPps').textContent = d.output_pps != null ? `${d.output_pps} pps${d.output_pct != null ? ' · ' + d.output_pct + '%' : ''}` : '\u00a0';
        document.getElementById('tfUpPps').textContent   = d.input_pps  != null ? `${d.input_pps} pps${d.input_pct != null ? ' · ' + d.input_pct + '%' : ''}` : '\u00a0';
        document.getElementById('tfStamp').textContent = 'Update: ' + new Date().toLocaleTimeString('id-ID');
        // simpan untuk sparkline (maks 40 titik)
        this._tfData.push({ down: d.output_bits || 0, up: d.input_bits || 0 });
        if (this._tfData.length > 40) this._tfData.shift();
        this._drawTrafficSpark();
      } else if (!silent) {
        App.showToast(res?.message || 'Gagal ambil traffic', 'error');
      }
    } catch (e) {
      if (!silent) App.showToast('Error: ' + e.message, 'error');
    } finally {
      if (!silent && btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
  },

  _drawTrafficSpark() {
    const cv = document.getElementById('tfSpark');
    if (!cv) return;
    const data = this._tfData || [];
    const ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth || 460;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (data.length < 2) return;
    const max = Math.max(1, ...data.map(p => Math.max(p.down, p.up)));
    const x = (i) => (i / (data.length - 1)) * (W - 8) + 4;
    const y = (v) => H - 6 - (v / max) * (H - 14);
    const line = (key, color, fill) => {
      ctx.beginPath();
      data.forEach((p, i) => { const px = x(i), py = y(p[key]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
      ctx.lineTo(x(data.length - 1), H - 4); ctx.lineTo(x(0), H - 4); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    };
    line('down', '#2563eb', 'rgba(37,99,235,0.10)');
    line('up', '#059669', 'rgba(5,150,105,0.10)');
  },

  // ════════════════════ ONU authorize / edit ════════════════════
  openAddOnu() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const isZte = this._isZte();
    document.getElementById('onuModalTitle').textContent = 'Authorize ONU';
    document.getElementById('onuEditIf').value = '';
    document.getElementById('grpGponOlt').style.display = '';
    document.getElementById('grpIdSn').style.display = '';
    document.getElementById('grpType').style.display = '';
    document.getElementById('onuModalNote').style.display = '';
    document.getElementById('btnSaveOnu').textContent = 'Authorize';
    // Label & hint PON field menurut gaya brand
    document.getElementById('onuGponOltLbl').textContent = isZte ? 'PON Port (gpon-olt)' : 'PON Port';
    document.getElementById('onuGponOltHint').textContent = isZte ? 'Frame/Slot/Port — mis. 1/2/1' : 'Nomor port PON — mis. 1';
    document.getElementById('onuGponOlt').placeholder = isZte ? '1/2/1' : '1';
    document.getElementById('onuGponOlt').value = this.currentPon || document.getElementById('ponInput').value.trim() || '';
    document.getElementById('onuId').value = '';
    document.getElementById('onuSn').value = '';
    document.getElementById('onuType').value = '';
    document.getElementById('onuNameInput').value = '';
    document.getElementById('onuDescInput').value = '';
    // EPON (HSGQ): ONU pakai MAC, bukan SN; Type tidak diperlukan.
    const epon = this.activeEpon;
    document.getElementById('onuSnLbl').textContent = epon ? 'MAC Address ONU' : 'Serial Number';
    document.getElementById('onuSn').placeholder = epon ? '00:12:34:45:56:05' : 'ZTEGC0B82FE8';
    document.getElementById('grpType').style.display = epon ? 'none' : '';
    document.getElementById('onuModalNote').innerHTML = epon
      ? 'ONU EPON di-authorize via MAC address (bind-onu + confirm). ONU ID opsional — kosongkan agar OLT assign otomatis.'
      : 'ONU akan di-authorize ke PON port di atas. Pastikan ONU ID belum dipakai.';
    document.getElementById('onuModal').classList.add('show');
  },

  openEditOnu(onuIf, currentName) {
    document.getElementById('onuModalTitle').textContent = 'Edit ONU ' + onuIf;
    document.getElementById('onuEditIf').value = onuIf;
    document.getElementById('grpGponOlt').style.display = 'none';
    document.getElementById('grpIdSn').style.display = 'none';
    document.getElementById('grpType').style.display = 'none';
    document.getElementById('onuModalNote').style.display = 'none';
    document.getElementById('btnSaveOnu').textContent = 'Simpan Perubahan';
    document.getElementById('onuNameInput').value = currentName || '';
    document.getElementById('onuDescInput').value = '';
    document.getElementById('onuModal').classList.add('show');
  },

  closeOnuModal() { document.getElementById('onuModal').classList.remove('show'); },

  async saveOnu() {
    const editIf = document.getElementById('onuEditIf').value;
    const name = document.getElementById('onuNameInput').value.trim();
    const desc = document.getElementById('onuDescInput').value.trim();
    const btn = document.getElementById('btnSaveOnu');
    btn.disabled = true;

    try {
      if (editIf) {
        // EDIT
        const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/edit`, {
          method: 'PUT',
          body: JSON.stringify({ onuIf: editIf, name, description: desc }),
        });
        if (res?.success) { App.showToast('ONU diupdate', 'success'); this.closeOnuModal(); await this.loadOnus(); }
        else App.showToast(res?.message || 'Gagal edit', 'error');
      } else {
        // AUTHORIZE
        const ponVal = document.getElementById('onuGponOlt').value.trim();
        const snVal = document.getElementById('onuSn').value.trim();
        const epon = this.activeEpon;
        const payload = {
          gponOlt: ponVal,   // dipakai ZTE
          port:    ponVal,   // dipakai chipset/EPON
          onuId:   document.getElementById('onuId').value,
          sn:      snVal,
          mac:     epon ? snVal : undefined,            // EPON: SN field = MAC
          type:    document.getElementById('onuType').value.trim(),
          name, description: desc,
        };
        if (epon) {
          // EPON: butuh PON + MAC (ONU ID & Type opsional)
          if (!ponVal || !snVal) { App.showToast('PON port dan MAC Address wajib diisi', 'error'); btn.disabled = false; return; }
        } else {
          if (!ponVal || !payload.onuId || !payload.sn || !payload.type) {
            App.showToast('PON port, ONU ID, SN, dan Type wajib diisi', 'error'); btn.disabled = false; return;
          }
        }
        const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/authorize`, {
          method: 'POST', body: JSON.stringify(payload),
        });
        if (res?.success) { App.showToast(res.message || 'ONU di-authorize', 'success'); this.closeOnuModal(); await this.loadOnus(); }
        else App.showToast(res?.message || 'Gagal authorize', 'error');
      }
    } catch (e) {
      App.showToast('Error: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  },

  // ════════════════════ Wizard Provisioning (ZTE) ════════════════════
  wizState: { step: 1, mode: 'single', selectedSn: null, profiles: null },

  openWizard() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    this.wizState = { step: 1, mode: 'single', selectedSn: null, profiles: null };
    // Reset field
    document.getElementById('wizPon').value = this.currentPon || '1/2/1';
    ['wizSn','wizName','wizOnuId','wizDesc','wizVlan','wizUserVlan','wizBulkText'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    // Type ONU default "ZTEG-F660" (paling umum); sistem auto-coba type lain bila ditolak.
    const wt = document.getElementById('wizType'); if (wt) wt.value = wt.value || 'ZTEG-F660';
    document.getElementById('wizUncfgList').innerHTML = '';
    this.wizSetMode('single');
    this.wizGoto(1);
    document.getElementById('wizModal').classList.add('show');
    // Pre-load profil di background
    this.wizLoadProfiles();
  },

  closeWizard() { document.getElementById('wizModal').classList.remove('show'); },

  wizSetMode(mode) {
    this.wizState.mode = mode;
    document.querySelectorAll('.wiz-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('wizSingle').style.display = mode === 'single' ? 'block' : 'none';
    document.getElementById('wizBulk').style.display = mode === 'bulk' ? 'block' : 'none';
  },

  wizGoto(step) {
    this.wizState.step = step;
    document.querySelectorAll('.wiz-step').forEach(s => {
      const n = parseInt(s.dataset.step);
      s.classList.toggle('active', n === step);
      s.classList.toggle('done', n < step);
    });
    document.querySelectorAll('.wiz-pane').forEach(p => p.classList.toggle('active', parseInt(p.dataset.pane) === step));
    document.getElementById('wizBack').style.visibility = step > 1 ? 'visible' : 'hidden';
    document.getElementById('wizNext').style.display = step < 3 ? '' : 'none';
    document.getElementById('wizSubmit').style.display = step === 3 ? '' : 'none';
    if (step === 3) this.wizRenderReview();
  },

  wizPrev() { if (this.wizState.step > 1) this.wizGoto(this.wizState.step - 1); },

  wizNext() {
    const step = this.wizState.step;
    if (step === 1) {
      const pon = document.getElementById('wizPon').value.trim();
      if (!pon) { App.showToast('PON port wajib diisi', 'warning'); return; }
      if (this.wizState.mode === 'single') {
        if (!document.getElementById('wizSn').value.trim()) { App.showToast('SN wajib diisi (atau pilih dari auto-find)', 'warning'); return; }
        if (!document.getElementById('wizType').value.trim()) { App.showToast('Type ONU wajib diisi', 'warning'); return; }
      } else {
        const lines = document.getElementById('wizBulkText').value.trim().split('\n').filter(l => l.trim());
        if (!lines.length) { App.showToast('Daftar ONU bulk masih kosong', 'warning'); return; }
        if (!document.getElementById('wizType').value.trim()) { App.showToast('Isi Type ONU dulu (dipakai semua)', 'warning'); return; }
      }
    }
    if (step === 2) {
      if (!document.getElementById('wizVlan').value.trim()) { App.showToast('VLAN wajib diisi', 'warning'); return; }
    }
    if (step < 3) this.wizGoto(step + 1);
  },

  async wizLoadProfiles() {
    const loading = document.getElementById('wizProfileLoading');
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/profiles`);
      if (res?.success) {
        this.wizState.profiles = res.data;
        const fill = (selId, arr, keepFirst) => {
          const sel = document.getElementById(selId);
          const first = sel.querySelector('option');
          sel.innerHTML = '';
          if (keepFirst && first) sel.appendChild(first);
          (arr || []).forEach(name => {
            if (name === 'default' && keepFirst) return;
            const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o);
          });
        };
        fill('wizTcont', this.wizState.profiles.tcont, true);
        fill('wizTraffic', this.wizState.profiles.traffic, true);
        // datalist type ONU
        if (this.wizState.profiles.onuTypes?.length) {
          const dl = document.getElementById('onuTypeList');
          if (dl) this.wizState.profiles.onuTypes.forEach(t => {
            if (![...dl.options].some(o => o.value === t)) { const o = document.createElement('option'); o.value = t; dl.appendChild(o); }
          });
        }
        if (loading) loading.style.display = 'none';
      } else {
        if (loading) loading.textContent = 'Tidak bisa memuat profil — bisa diisi manual di OLT.';
      }
    } catch (e) {
      if (loading) loading.textContent = 'Profil tidak termuat (' + e.message + ') — gunakan default.';
    }
  },

  async wizLoadUncfg() {
    const box = document.getElementById('wizUncfgList');
    box.innerHTML = `<div style="color:var(--faint);font-size:13px;padding:8px"><span class="spin"></span> Mencari ONU belum terdaftar…</div>`;
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/uncfg`);
      if (!res?.success || !res.data?.length) {
        box.innerHTML = `<div class="info-note">Tidak ada ONU belum terdaftar saat ini. Colok ONU ke PON, tunggu sebentar, lalu klik lagi — atau ketik SN manual.</div>`;
        return;
      }
      box.innerHTML = res.data.map(o => {
        const sn = o.sn || o.mac || '?';
        // PON port asli tempat ONU terdeteksi (mis. "1/2/2"), untuk auto-set.
        const port = (o.slot_hint || (o.gpon_olt || '').replace('gpon-olt_', '') || '').trim();
        return `<div class="wiz-uncfg-item" onclick="OltMgmt.wizPickUncfg(this,'${esc(sn)}','${esc(port)}')">
          <span class="ui-sn">${esc(sn)}</span>
          <span class="card-sub">${o.gpon_olt ? esc(o.gpon_olt) : ''} ${o.state ? '· ' + esc(o.state) : ''}</span>
        </div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`;
    }
  },

  wizPickUncfg(el, sn, port) {
    document.querySelectorAll('.wiz-uncfg-item').forEach(i => i.classList.remove('sel'));
    el.classList.add('sel');
    document.getElementById('wizSn').value = sn;
    this.wizState.selectedSn = sn;
    // PENTING: set PON port ke lokasi FISIK ONU terdeteksi. Kalau tidak,
    // ONU bisa ter-authorize di port salah → terkonfigurasi tapi tak pernah
    // ranging (Online Duration 0, Distance N/A).
    if (port) {
      const ponEl = document.getElementById('wizPon');
      const cur = (ponEl.value || '').trim();
      if (cur && cur !== port) {
        App.showToast(`PON Port disesuaikan ke ${port} (lokasi fisik ONU ${sn}), sebelumnya ${cur}.`, 'info');
      }
      ponEl.value = port;
    }
  },

  wizRenderReview() {
    const pon = document.getElementById('wizPon').value.trim();
    const type = document.getElementById('wizType').value.trim();
    const tcont = document.getElementById('wizTcont').value || 'default';
    const traffic = document.getElementById('wizTraffic').value || '(tidak diset)';
    const vlan = document.getElementById('wizVlan').value;
    const uvlan = document.getElementById('wizUserVlan').value || vlan;
    const row = (k, v) => `<div class="wiz-review-row"><span class="rk">${k}</span><span class="rv">${esc(String(v))}</span></div>`;
    let html = row('PON Port', pon) + row('Type ONU', type) + row('Profil TCONT', tcont) + row('Profil Traffic', traffic) + row('VLAN', vlan) + row('User VLAN', uvlan);
    if (this.wizState.mode === 'single') {
      const sn = document.getElementById('wizSn').value.trim();
      const name = document.getElementById('wizName').value.trim() || '(kosong)';
      const onuId = document.getElementById('wizOnuId').value.trim() || 'auto';
      html = row('SN', sn) + row('Nama', name) + row('ONU ID', onuId) + html;
    } else {
      const lines = document.getElementById('wizBulkText').value.trim().split('\n').filter(l => l.trim());
      html = row('Jumlah ONU', lines.length + ' unit') + html;
    }
    document.getElementById('wizReview').innerHTML = html;
  },

  async wizSubmit() {
    const btn = document.getElementById('wizSubmit'); btn.disabled = true;
    const pon = document.getElementById('wizPon').value.trim();
    const type = document.getElementById('wizType').value.trim();
    const tcontProfile = document.getElementById('wizTcont').value || '';
    const trafficProfile = document.getElementById('wizTraffic').value || '';
    const vlan = document.getElementById('wizVlan').value;
    const userVlan = document.getElementById('wizUserVlan').value || vlan;
    const gponOlt = pon.startsWith('gpon-olt_') ? pon : `gpon-olt_${pon}`;
    try {
      if (this.wizState.mode === 'single') {
        const payload = {
          gponOlt, type, sn: document.getElementById('wizSn').value.trim(),
          name: document.getElementById('wizName').value.trim(),
          description: document.getElementById('wizDesc').value.trim(),
          onuId: document.getElementById('wizOnuId').value.trim() || undefined,
          tcontProfile, trafficProfile, vlan, userVlan,
        };
        const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/provision`, { method: 'POST', body: JSON.stringify(payload) });
        if (res?.success) {
          App.showToast(res.message || 'ONU diprovisioning', 'success');
          this.closeWizard();
          document.getElementById('ponInput').value = pon;
          await this.loadOnus();
          // Auto-verify: cek apakah ONU benar online, beri diagnosa bila tidak.
          const onuIf = res.data?.onuIf || (res.onuIf);
          if (onuIf) this.verifyOnuAfterProvision(onuIf);
        }
        else App.showToast(res?.message || 'Gagal provisioning', 'error');
      } else {
        // Bulk: parse textarea "SN,Nama,Deskripsi"
        const items = document.getElementById('wizBulkText').value.trim().split('\n').filter(l => l.trim()).map(l => {
          const [sn, name, description] = l.split(',').map(s => (s || '').trim());
          return { sn, name, description };
        });
        const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/bulk-provision`, {
          method: 'POST', body: JSON.stringify({ gponOlt, type, tcontProfile, trafficProfile, vlan, userVlan, items }),
        });
        if (res?.success) {
          // Tampilkan ringkasan hasil di review pane
          const rv = document.getElementById('wizReview');
          rv.innerHTML = (res.data || []).map(r => `<div class="wiz-bulk-result ${r.success ? 'ok' : 'err'}">${esc(r.sn)} — ${r.success ? 'OK (ONU-id ' + r.onuId + ')' : 'GAGAL: ' + esc(r.error)}</div>`).join('');
          App.showToast(res.message, 'success');
          document.getElementById('ponInput').value = pon;
          await this.loadOnus();
        } else App.showToast(res?.message || 'Gagal bulk', 'error');
      }
    } catch (e) {
      App.showToast('Error: ' + e.message, 'error');
    } finally { btn.disabled = false; }
  },

  async rebootOnu(onuIf) {
    this._confirm('Reboot ONU?', `ONU <b>${esc(onuIf)}</b> akan reboot dan terputus sementara.`, 'amber', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/reboot`, { method: 'POST', body: JSON.stringify({ onuIf }) });
      App.showToast(res?.success ? (res.message || 'ONU reboot') : (res?.message || 'Gagal reboot'), res?.success ? 'success' : 'error');
    });
  },

  // Muat WAN IP & MAC pelanggan ke dalam modal detail (on-demand).
  async loadWanInfo(onuIf) {
    const sec = document.getElementById('wanInfoSection');
    if (!sec) return;
    sec.innerHTML = '<div style="padding:14px;color:var(--faint)"><span class="spin"></span> Memuat WAN IP & MAC dari OLT…</div>';
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/wan-info?if=${encodeURIComponent(onuIf)}`);
      if (!res?.success) { sec.innerHTML = `<div class="ot-alert err show">${esc(res?.message || 'Gagal')}</div>`; return; }
      const d = res.data || {};
      let html = '<div style="margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0">';
      // WAN IP
      html += '<div style="font-weight:600;font-size:13px;margin-bottom:8px;color:#334155">WAN IP Pelanggan</div>';
      if (d.wan && d.wan.length) {
        d.wan.forEach(w => {
          html += `<div class="det-grid" style="margin-bottom:8px">
            <div class="det-cell"><div class="det-k">IP</div><div class="det-v mono">${esc(w.ip || '—')}</div></div>
            <div class="det-cell"><div class="det-k">Gateway</div><div class="det-v mono">${esc(w.gateway || '—')}</div></div>
            <div class="det-cell"><div class="det-k">DNS</div><div class="det-v mono">${esc([w.dns1, w.dns2].filter(Boolean).join(', ') || '—')}</div></div>
            <div class="det-cell"><div class="det-k">MAC</div><div class="det-v mono">${esc(w.mac || '—')}</div></div>
          </div>`;
        });
      } else {
        html += '<div class="info-note" style="margin-bottom:10px">Belum ada WAN IP — ONU mungkin offline, belum dapat IP, atau dalam mode bridge.</div>';
      }
      // MAC list
      html += `<div style="font-weight:600;font-size:13px;margin:12px 0 8px;color:#334155">MAC Address Terdeteksi (${d.mac_count || 0})</div>`;
      if (d.macs && d.macs.length) {
        html += '<div style="display:flex;flex-direction:column;gap:4px">' + d.macs.slice(0, 20).map(m =>
          `<div class="mono" style="font-size:12.5px;color:#475569">${esc(m.mac)}${m.vlan ? ` <span style="color:#94a3b8">· VLAN ${m.vlan}</span>` : ''}</div>`
        ).join('') + '</div>';
      } else {
        html += `<div style="color:var(--faint);font-size:13px">${d.mac_count ? `${d.mac_count} MAC (detail tidak tersedia)` : 'Tidak ada MAC terdeteksi'}</div>`;
      }
      html += '</div>';
      sec.innerHTML = html;
    } catch (e) {
      sec.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`;
    }
  },

  async deleteOnu(onuIf, label) {
    this._confirm('Hapus ONU?', `ONU <b>${esc(label)}</b> (${esc(onuIf)}) akan dihapus dari OLT. Tindakan ini memutus layanan pelanggan.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu`, { method: 'DELETE', body: JSON.stringify({ onuIf }) });
      if (res?.success) { App.showToast(res.message || 'ONU dihapus', 'success'); await this.loadOnus(); }
      else App.showToast(res?.message || 'Gagal hapus', 'error');
    });
  },

  // Verifikasi pasca-provisioning: cek online/LOS/salah port, beri diagnosa.
  async verifyOnuAfterProvision(onuIf) {
    App.showToast(`Memverifikasi ${onuIf}… (cek status online ±1 menit)`, 'info');
    try {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/verify`, { method: 'POST', body: JSON.stringify({ onuIf, tries: 6, intervalMs: 8000 }) });
      if (!res?.success) return;
      const d = res.data || {};
      if (d.online) {
        const rxNote = d.rx_warning ? ` ⚠ ${d.rx_warning}` : (d.onu_rx_dbm != null ? ` (Rx ${d.onu_rx_dbm} dBm)` : '');
        App.showToast(`✓ ${onuIf} ONLINE${rxNote}`, 'success');
      } else {
        // Tampilkan diagnosa dalam modal info (bukan toast singkat) agar terbaca.
        this._infoBox('ONU belum online', `<b>${esc(onuIf)}</b><br><br>${esc(d.diagnosis || '')}<br><br><span style="color:var(--faint)">Tindakan: ${esc(d.action || '')}</span>`, 'amber');
      }
      await this.loadOnus();
    } catch (e) { /* diam — verifikasi opsional */ }
  },

  // Verifikasi manual dari tombol (di row / detail)
  async verifyOnu(onuIf) {
    this.verifyOnuAfterProvision(onuIf);
  },

  async factoryResetOnu(onuIf) {
    this._confirm('Restore Factory ONU?', `ONU <b>${esc(onuIf)}</b> akan di-reset ke setelan pabrik. Semua konfigurasi di perangkat ONU (WiFi, dll) hilang dan ONU reboot.`, 'red', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/factory-reset`, { method: 'POST', body: JSON.stringify({ onuIf }) });
      App.showToast(res?.success ? (res.message || 'Restore factory dikirim') : (res?.message || 'Gagal'), res?.success ? 'success' : 'error');
    });
  },

  async setOnuEthPort(onuIf, port, enable) {
    const act = enable ? 'mengaktifkan' : 'menonaktifkan';
    this._confirm(`${enable ? 'Aktifkan' : 'Nonaktifkan'} Port LAN ${port}?`, `Port LAN <b>eth_0/${port}</b> pada ONU <b>${esc(onuIf)}</b> akan di-${enable ? 'enable' : 'disable'}.`, enable ? 'blue' : 'amber', async () => {
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/onu/eth-port`, { method: 'POST', body: JSON.stringify({ onuIf, port, enable }) });
      App.showToast(res?.success ? (res.message || `Port LAN ${port} di-set`) : (res?.message || 'Gagal'), res?.success ? 'success' : 'error');
    });
  },

  // Kotak info sederhana (reuse pola _confirm tapi 1 tombol).
  _infoBox(title, bodyHtml, accent) {
    const colors = { red:'#dc2626', amber:'#d97706', blue:'#2563eb', green:'#16a34a' };
    const c = colors[accent] || colors.blue;
    let el = document.getElementById('_oltInfoBox');
    if (!el) { el = document.createElement('div'); el.id = '_oltInfoBox'; document.body.appendChild(el); }
    el.innerHTML = `<div style="position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
      <div style="background:#fff;border-radius:14px;max-width:440px;width:90%;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="font-weight:700;font-size:16px;margin-bottom:10px;color:${c}">${esc(title)}</div>
        <div style="font-size:14px;line-height:1.6;color:#334155">${bodyHtml}</div>
        <div style="text-align:right;margin-top:18px"><button class="btn btn-dark btn-sm" onclick="document.getElementById('_oltInfoBox').remove()">Mengerti</button></div>
      </div></div>`;
  },

  // ════════════════════ Uncfg ONU ════════════════════
  async openUncfg() {
    if (!this.activeOltId) { App.showToast('Pilih OLT dulu', 'warning'); return; }
    const modal = document.getElementById('uncfgModal');
    const body = document.getElementById('uncfgBody');
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--faint)"><span class="spin"></span> Memuat ONU belum terdaftar...</div>';
    modal.classList.add('show');
    try {
      // Chipset (CDATA/HIOSO/ZIMMLINK) butuh konteks port; pakai PON yang sedang aktif bila ada.
      const ponQ = (!this._isZte() && document.getElementById('ponInput').value.trim())
        ? `?pon=${encodeURIComponent(document.getElementById('ponInput').value.trim())}` : '';
      const res = await App.api(`/olt-mgmt/${this.activeOltId}/uncfg${ponQ}`);
      if (!res?.success) { body.innerHTML = `<div class="ot-alert err show">${esc(res?.message || 'Gagal')}</div>`; return; }
      const list = res.data || [];
      if (!list.length) {
        body.innerHTML = `<div class="ot-empty" style="padding:40px 10px"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12l2 2 4-4"/></svg><h3>Tidak ada ONU menunggu</h3><p>${this._isZte() ? 'Semua ONU yang terhubung sudah ter-authorize' : 'Tidak ada auto-find ONU pada port ini. Refresh dulu sebuah PON port, lalu buka lagi.'}</p></div>`;
        return;
      }
      body.innerHTML = `<div class="info-note" style="margin-bottom:14px">ONU di bawah terdeteksi OLT namun belum di-authorize. Klik "Authorize" untuk mendaftarkan.</div>
        <div class="onu-table-wrap"><table class="onu-table"><thead><tr><th>PON Port</th><th>Serial Number</th><th>State</th><th style="text-align:right">Aksi</th></tr></thead><tbody>` +
        list.map(u => {
          const portRef = u.gpon_olt || (u.port != null ? String(u.port) : '');
          return `<tr>
          <td><span class="onu-if">${esc(portRef || '—')}</span></td>
          <td><span class="onu-sn" style="font-size:12.5px;color:#334155">${esc(u.sn)}</span></td>
          <td><span class="st-pill st-disabled">${esc(u.state||'unknown')}</span></td>
          <td style="text-align:right"><button class="btn btn-green btn-sm" onclick="OltMgmt.authorizeFromUncfg('${esc(portRef)}','${esc(u.sn)}')">+ Authorize</button></td>
        </tr>`;
        }).join('') + `</tbody></table></div>`;
    } catch (e) {
      body.innerHTML = `<div class="ot-alert err show">${esc(e.message)}</div>`;
    }
  },

  authorizeFromUncfg(portRef, sn) {
    this.closeUncfg();
    // ZTE: gpon-olt_1/1/1 → 1/1/1 ; chipset: sudah berupa nomor port.
    const port = String(portRef).replace(/^gpon-olt_/, '');
    // Buka WIZARD provisioning lengkap (authorize + tcont + gemport + VLAN),
    // bukan sekadar authorize, supaya ONU langsung dapat layanan internet.
    // Port di-set ke lokasi FISIK ONU terdeteksi agar tidak salah port.
    this.openWizard();
    setTimeout(() => {
      const ponEl = document.getElementById('wizPon');
      const snEl  = document.getElementById('wizSn');
      if (ponEl) ponEl.value = port;
      if (snEl)  snEl.value = sn;
      this.wizState.selectedSn = sn;
      App.showToast(`SN ${sn} dipilih · PON Port ${port} (lokasi fisik ONU).`, 'info');
    }, 60);
  },

  closeUncfg() { document.getElementById('uncfgModal').classList.remove('show'); },

  // ════════════════════ Helpers ════════════════════
  _alert(msg) {
    const a = document.getElementById('oltAlert');
    a.className = 'ot-alert err show';
    document.getElementById('oltAlertMsg').textContent = msg;
  },
  _hideAlert() { document.getElementById('oltAlert').classList.remove('show'); },

  // Custom confirm (tanpa native confirm() sesuai aturan UI)
  _confirm(title, bodyHtml, accent, onYes) {
    const colors = { red:'#dc2626', amber:'#d97706', blue:'#2563eb' };
    const c = colors[accent] || colors.blue;
    let el = document.getElementById('_oltConfirm');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = '_oltConfirm';
    el.className = 'ot-modal-overlay show';
    el.style.zIndex = '1200';
    el.innerHTML = `<div class="ot-modal-box" style="width:420px">
      <div class="ot-modal-hdr"><h3>${esc(title)}</h3>
        <button class="ot-modal-close" onclick="document.getElementById('_oltConfirm').remove()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="ot-modal-body"><div style="font-size:13.5px;color:#334155;line-height:1.55">${bodyHtml}</div></div>
      <div class="ot-modal-foot"><div></div><div class="ot-modal-foot-r">
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('_oltConfirm').remove()">Batal</button>
        <button class="btn btn-sm" id="_oltConfirmYes" style="background:${c};border-color:${c};color:#fff">Ya, Lanjutkan</button>
      </div></div>
    </div>`;
    el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
    document.body.appendChild(el);
    document.getElementById('_oltConfirmYes').addEventListener('click', async () => {
      el.remove();
      try { await onYes(); } catch (e) { App.showToast('Error: ' + e.message, 'error'); }
    });
  },
};

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

document.addEventListener('DOMContentLoaded', () => OltMgmt.init());
