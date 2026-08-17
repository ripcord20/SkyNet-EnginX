// olt.js — OLT Management Frontend (modernized to match genieacs style)
const OltPage = {
  olts: [],
  searchTerm: '',
  searchTimer: null,

  async init() {
    this.bindEvents();
    await this.load();
    // auto-refresh tiap 60s
    setInterval(() => this.load(), 60000);
  },

  async load() {
    try {
      const data = await App.api('/olt');
      if (!data?.success) {
        this._showAlert(data?.message || 'Gagal memuat data OLT');
        return;
      }
      this.olts = data.data || [];
      this._hideAlert();
      this.renderCards();
      this.updateStats();
      this._updateRefreshLabel();
    } catch (e) {
      this._showAlert('Tidak bisa terhubung ke server: ' + e.message);
    }
  },

  updateStats() {
    const total   = this.olts.length;
    const active  = this.olts.filter(o => o.enabled !== false).length;
    const onts    = this.olts.reduce((s, o) => s + (o.ontCount || 0), 0);
    const synced  = this.olts.filter(o => o.lastSync).sort((a,b) => new Date(b.lastSync) - new Date(a.lastSync));
    const last    = synced[0]?.lastSync || null;
    const lastAgo = last ? this._timeAgo(last) : '—';

    document.getElementById('statTotal').textContent    = total;
    document.getElementById('statActive').textContent   = active;
    document.getElementById('statOnts').textContent     = onts;
    document.getElementById('statLastSync').textContent = lastAgo;

    // Pills
    document.getElementById('statTotalPill').textContent = `${total} device`;
    document.getElementById('statActivePill').textContent = `${active} aktif`;
    document.getElementById('statOntsPill').textContent  = `${onts} ONT`;

    // Sync pill color/label
    const syncPill = document.getElementById('statSyncPill');
    if (!last) {
      syncPill.className = 'card-pill pill-gray';
      syncPill.textContent = 'Idle';
    } else {
      const ageMin = Math.floor((Date.now() - new Date(last)) / 60000);
      if (ageMin < 15) {
        syncPill.className = 'card-pill pill-green';
        syncPill.textContent = 'Fresh';
      } else if (ageMin < 120) {
        syncPill.className = 'card-pill pill-amber';
        syncPill.textContent = 'Stale';
      } else {
        syncPill.className = 'card-pill pill-amber';
        syncPill.textContent = 'Lama';
      }
    }
  },

  renderCards() {
    const grid = document.getElementById('oltGrid');
    const countLbl = document.getElementById('oltCount');

    // Filter by search
    const q = this.searchTerm.toLowerCase();
    const filtered = q ? this.olts.filter(o =>
      (o.name||'').toLowerCase().includes(q) ||
      (o.host||'').toLowerCase().includes(q) ||
      (o.brand||'').toLowerCase().includes(q)
    ) : this.olts;

    countLbl.textContent = `${filtered.length} device`;

    if (!this.olts.length) {
      grid.innerHTML = `
        <div class="ot-empty">
          <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="7" rx="2"/><rect x="2" y="13" width="20" height="7" rx="2"/><line x1="6" y1="7.5" x2="6.01" y2="7.5"/><line x1="6" y1="16.5" x2="6.01" y2="16.5"/></svg>
          <h3>Belum ada OLT</h3>
          <p>Tambahkan konfigurasi OLT HSGQ atau brand lain untuk mulai sync ONT via SNMP</p>
          <button class="btn btn-blue btn-sm" onclick="OltPage.openAdd()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Tambah OLT Pertama
          </button>
        </div>`;
      return;
    }

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="ot-empty">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <h3>Tidak ditemukan</h3>
          <p>Tidak ada OLT yang cocok dengan pencarian "${esc(this.searchTerm)}"</p>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map(o => {
      const enabled = o.enabled !== false;
      const hasErr  = !!o.lastError;
      const lastSync = o.lastSync ? this._timeAgo(o.lastSync) : 'Belum pernah';
      const lastSyncFull = o.lastSync ? new Date(o.lastSync).toLocaleString('id-ID') : '—';
      const brandLabel = { hsgq:'HSGQ', zte:'ZTE', huawei:'Huawei', fiberhome:'Fiberhome' }[o.brand] || String(o.brand||'').toUpperCase();

      // Status pill
      let pillCls = 'off', pillTxt = 'Nonaktif';
      let icCls = 'off';
      if (hasErr) { pillCls = 'err'; pillTxt = 'Error'; icCls = 'err'; }
      else if (enabled) { pillCls = 'on'; pillTxt = 'Aktif'; icCls = ''; }

      return `
        <div class="olt-card" data-id="${o.id}">
          <div class="olt-card-hdr">
            <div class="olt-card-hdr-l">
              <span class="olt-dev-ic ${icCls}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="4" width="20" height="7" rx="2"/>
                  <rect x="2" y="13" width="20" height="7" rx="2"/>
                  <circle cx="6" cy="7.5" r=".8" fill="currentColor"/>
                  <circle cx="6" cy="16.5" r=".8" fill="currentColor"/>
                </svg>
              </span>
              <div class="olt-hdr-txt">
                <span class="olt-name" title="${esc(o.name)}">${esc(o.name)}</span>
                <span class="olt-host" title="${esc(o.host)}:${o.snmpPort || 161}">${esc(o.host)}:${o.snmpPort || 161}</span>
              </div>
            </div>
            <span class="olt-pill ${pillCls}">
              <span class="olt-pd"></span>
              ${pillTxt}
            </span>
          </div>

          <div class="olt-badges">
            <span class="olt-badge badge-brand">${esc(brandLabel)}</span>
            <span class="olt-badge badge-mode">${esc(o.mibMode || 'auto')}</span>
            <span class="olt-badge badge-port">UDP :${o.snmpPort || 161}</span>
          </div>

          <div class="olt-metric">
            <div class="olt-metric-cell">
              <div class="olt-metric-lbl">Total ONT</div>
              <div class="olt-metric-val">${o.ontCount || 0}</div>
            </div>
            <div class="olt-metric-cell">
              <div class="olt-metric-lbl">Terakhir Sync</div>
              <div class="olt-metric-val small" title="${esc(lastSyncFull)}">${esc(lastSync)}</div>
            </div>
          </div>

          <div class="olt-card-foot">
            <div class="olt-foot-info" title="${esc(lastSyncFull)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              <span>Sync <b>${esc(lastSyncFull)}</b></span>
            </div>
            <div class="olt-foot-acts">
              <button class="olt-act sync" onclick="OltPage.syncOne(${o.id})" title="Sync sekarang">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0115.5-6.3L21 8"/><polyline points="21 3 21 8 16 8"/><path d="M21 12a9 9 0 01-15.5 6.3L3 16"/><polyline points="3 21 3 16 8 16"/></svg>
              </button>
              <button class="olt-act edit" onclick="OltPage.openEdit(${o.id})" title="Edit">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="olt-act del" onclick="OltPage.deleteOlt(${o.id},'${esc(o.name)}')" title="Hapus">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </div>
          </div>

          ${hasErr ? `<div class="olt-err-banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span title="${esc(o.lastError)}">${esc(o.lastError)}</span>
          </div>` : ''}
        </div>`;
    }).join('');
  },

  openAdd() {
    document.getElementById('modalTitle').textContent = 'Tambah OLT';
    document.getElementById('oltId').value       = '';
    document.getElementById('oltName').value     = '';
    document.getElementById('oltHost').value     = '';
    document.getElementById('oltBrand').value    = 'hsgq';
    document.getElementById('oltCommunity').value= 'public';
    document.getElementById('oltSnmpPort').value = '161';
    document.getElementById('oltMibMode').value  = 'auto';
    document.getElementById('oltEnabled').value  = 'true';
    document.getElementById('testResult').style.display = 'none';
    document.getElementById('oltModal').classList.add('show');
  },

  openEdit(id) {
    const o = this.olts.find(o => o.id === id);
    if (!o) return;
    document.getElementById('modalTitle').textContent = 'Edit OLT';
    document.getElementById('oltId').value       = o.id;
    document.getElementById('oltName').value     = o.name || '';
    document.getElementById('oltHost').value     = o.host || '';
    document.getElementById('oltBrand').value    = o.brand || 'hsgq';
    document.getElementById('oltCommunity').value= '';
    document.getElementById('oltSnmpPort').value = o.snmpPort || 161;
    document.getElementById('oltMibMode').value  = o.mibMode || 'auto';
    document.getElementById('oltEnabled').value  = o.enabled !== false ? 'true' : 'false';
    document.getElementById('testResult').style.display = 'none';
    document.getElementById('oltModal').classList.add('show');
  },

  closeModal() {
    document.getElementById('oltModal').classList.remove('show');
  },

  onBrandChange() {
    const brand = document.getElementById('oltBrand').value;
    const mibMap = { hsgq:'hsgq', zte:'zte', huawei:'zte', fiberhome:'gpon' };
    document.getElementById('oltMibMode').value = mibMap[brand] || 'auto';
  },

  async save() {
    const id = document.getElementById('oltId').value;
    const payload = {
      name:      document.getElementById('oltName').value.trim(),
      host:      document.getElementById('oltHost').value.trim(),
      brand:     document.getElementById('oltBrand').value,
      community: document.getElementById('oltCommunity').value || undefined,
      snmpPort:  parseInt(document.getElementById('oltSnmpPort').value) || 161,
      mibMode:   document.getElementById('oltMibMode').value,
      enabled:   document.getElementById('oltEnabled').value === 'true',
    };

    if (!payload.host) { App.showToast('IP Address wajib diisi', 'error'); return; }
    if (!payload.name) payload.name = payload.host;

    const btn = document.getElementById('btnSaveOlt');
    btn.disabled = true; btn.textContent = 'Menyimpan...';

    try {
      const res = id
        ? await App.api(`/olt/${id}`, { method:'PUT',  body:JSON.stringify(payload) })
        : await App.api('/olt',        { method:'POST', body:JSON.stringify(payload) });

      if (res?.success) {
        this.closeModal();
        App.showToast(id ? 'OLT berhasil diupdate' : 'OLT berhasil ditambahkan', 'success');
        await this.load();
      } else {
        App.showToast(res?.message || 'Gagal menyimpan', 'error');
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Simpan';
    }
  },

  async testConnection() {
    const host      = document.getElementById('oltHost').value.trim();
    const community = document.getElementById('oltCommunity').value || 'public';
    const port      = parseInt(document.getElementById('oltSnmpPort').value) || 161;
    const brand     = document.getElementById('oltBrand').value;
    const mibMode   = document.getElementById('oltMibMode').value;

    if (!host) { App.showToast('Isi IP Address dulu', 'warning'); return; }

    const btn = document.getElementById('btnTestConn');
    const res_el = document.getElementById('testResult');
    const oldHtml = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Testing...';
    res_el.style.display = 'none';

    const id = document.getElementById('oltId').value;
    let testId = id;

    if (!testId) {
      const tmp = await App.api('/olt', { method:'POST', body: JSON.stringify({ host, community, snmpPort:port, brand, mibMode, name:'__test__', enabled:false }) });
      if (tmp?.success) testId = tmp.data?.id;
    }

    try {
      const res = testId
        ? await App.api(`/olt/${testId}/test`, { method:'POST' })
        : { success:false, error:'Gagal membuat koneksi test' };

      if (!id && testId) await App.api(`/olt/${testId}`, { method:'DELETE' });

      res_el.className = `test-result ${res.success ? 'test-ok' : 'test-err'}`;
      res_el.style.display = 'block';
      res_el.textContent = res.success
        ? `✓ Terhubung! ${res.sysName || ''} — ${res.sysDescr?.substring(0,80) || ''}`
        : `✗ Gagal: ${res.error || 'Tidak ada respons SNMP'}`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  },

  async syncOne(id) {
    const o = this.olts.find(x => x.id === id);
    const name = o?.name || `OLT #${id}`;
    App.showToast(`Sync "${name}" dimulai...`, 'info');
    const res = await App.api(`/olt/${id}/sync`, { method:'POST' });
    if (res?.success) {
      App.showToast(`Sync berjalan di background. Tunggu ~30 detik lalu refresh.`, 'success');
      setTimeout(() => this.load(), 30000);
    } else {
      App.showToast(res?.message || 'Gagal sync', 'error');
    }
  },

  async syncAll() {
    const btn = document.getElementById('btnSyncAll');
    const oldHtml = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0115.5-6.3L21 8"/></svg> Syncing...';
    const res = await App.api('/olt/sync-all', { method:'POST' });
    App.showToast(res?.message || 'Sync semua OLT dimulai', res?.success ? 'success' : 'error');
    btn.disabled = false;
    btn.innerHTML = oldHtml;
    setTimeout(() => this.load(), 35000);
  },

  async deleteOlt(id, name) {
    if (!confirm(`Hapus OLT "${name}"?\n\nData ONT yang sudah disync tidak akan terhapus.`)) return;
    const res = await App.api(`/olt/${id}`, { method:'DELETE' });
    if (res?.success) { App.showToast('OLT dihapus', 'success'); await this.load(); }
    else App.showToast(res?.message || 'Gagal hapus', 'error');
  },

  _timeAgo(dateStr) {
    const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (diff < 10)    return 'Baru saja';
    if (diff < 60)    return `${diff}d lalu`;
    if (diff < 3600)  return `${Math.floor(diff/60)}m lalu`;
    if (diff < 86400) return `${Math.floor(diff/3600)}j lalu`;
    return `${Math.floor(diff/86400)}h lalu`;
  },

  _updateRefreshLabel() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const el = document.getElementById('lastRefreshLbl');
    if (el) el.textContent = `Diperbarui ${hh}:${mm}`;
  },

  _showAlert(msg) {
    const a = document.getElementById('oltAlert');
    const m = document.getElementById('oltAlertMsg');
    if (a && m) { a.classList.add('show'); m.textContent = msg; }
  },
  _hideAlert() {
    const a = document.getElementById('oltAlert');
    if (a) a.classList.remove('show');
  },

  bindEvents() {
    document.getElementById('btnAddOlt').addEventListener('click',  () => this.openAdd());
    document.getElementById('btnSyncAll').addEventListener('click', () => this.syncAll());

    // Search with debounce
    const searchEl = document.getElementById('oltSearch');
    if (searchEl) {
      searchEl.addEventListener('input', (e) => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.searchTerm = e.target.value.trim();
          this.renderCards();
        }, 200);
      });
    }

    // Close modal on backdrop click
    const modal = document.getElementById('oltModal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal();
      });
    }

    // Close modal on Esc
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModal();
    });
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

document.addEventListener('DOMContentLoaded', () => { App.init(); OltPage.init(); });