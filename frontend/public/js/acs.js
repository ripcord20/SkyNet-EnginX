// acs.js — TR-069 ACS Management Frontend
const AcsPage = {
  devices: [],
  currentSn: null,

  async init() {
    this.bindEvents();
    await this.loadStatus();
    await this.loadStats();
    await this.loadDevices();
    // Auto refresh setiap 60 detik
    setInterval(() => { this.loadStats(); this.loadDevices(); }, 60000);
  },

  async loadStatus() {
    const data = await App.api('/acs/status');
    if (!data?.success) return;
    const d = data.data;
    const banner = document.getElementById('acsBanner');
    const text   = document.getElementById('acsStatusText');
    const url    = document.getElementById('acsUrlText');
    if (d.running) {
      banner.className = 'acs-banner acs-banner-ok';
      text.textContent = `ACS Server Berjalan (port ${d.port})`;
      url.textContent  = `URL ONT: ${d.url}`;
      document.getElementById('acsUrlPreview').textContent = d.url;
    } else {
      banner.className = 'acs-banner acs-banner-off';
      text.textContent = 'ACS Server tidak berjalan';
      url.textContent  = 'Restart aplikasi untuk memulai ACS';
    }
    // Load config ke form
    const cfg = await App.api('/acs/config');
    if (cfg?.success) {
      document.getElementById('cfgPort').value         = cfg.data.port || 7547;
      document.getElementById('cfgUsername').value     = cfg.data.username || '';
      document.getElementById('cfgInformPeriod').value = cfg.data.informPeriod || 300;
    }
  },

  async loadStats() {
    const data = await App.api('/acs/stats');
    if (!data?.success) return;
    const d = data.data;
    document.getElementById('statTotal').textContent   = d.total   || 0;
    document.getElementById('statOnline').textContent  = d.online  || 0;
    document.getElementById('statOffline').textContent = d.offline || 0;
    document.getElementById('statWarning').textContent = d.warning || 0;
  },

  async loadDevices() {
    const search = document.getElementById('searchInput').value;
    const status = document.getElementById('filterStatus').value;
    const params = new URLSearchParams({ limit: 100 });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const data = await App.api(`/acs/devices?${params}`);
    if (!data?.success) return;
    this.devices = data.data || [];
    document.getElementById('devCount').textContent = `${this.devices.length} device`;
    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById('deviceTbody');
    if (!this.devices.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/></svg>
        <p>Belum ada ONT yang terkoneksi via TR-069.<br>Arahkan ONT ke URL ACS di atas.</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = this.devices.map((d, i) => {
      const rx    = d.signal_strength;
      const rxPct = rx !== null ? Math.min(100, Math.max(0, (rx + 35) / 27 * 100)) : 0;
      const rxClr = rx === null ? '#94a3b8' : rx >= -23 ? '#16a34a' : rx >= -27 ? '#d97706' : '#dc2626';
      const rxHtml = rx !== null
        ? `<div class="signal-wrap">
             <div class="signal-track"><div class="signal-fill" style="width:${rxPct}%;background:${rxClr}"></div></div>
             <span class="signal-val" style="color:${rxClr}">${rx} dBm</span>
           </div>`
        : `<span style="color:var(--faint)">—</span>`;

      const lastInform = d.last_inform
        ? `<div class="inform-cell">${this._timeAgo(d.last_inform)}</div>
           <div class="inform-sub">${new Date(d.last_inform).toLocaleString('id-ID',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>`
        : '—';

      const params = d.tr069_params || {};
      const fw = params.fw_version || d.firmware || '';

      return `<tr onclick="AcsPage.openDetail('${esc(d.serial_number)}')">
        <td class="num-cell">${i+1}</td>
        <td class="sn-cell">${esc(d.serial_number)}</td>
        <td>
          <div class="model-cell">${esc(d.model || d.manufacturer || '—')}</div>
          <div class="mfr-sub">${esc(d.manufacturer || '')}${fw ? ' · ' + esc(fw) : ''}</div>
        </td>
        <td>${d.ip_address ? `<span class="ip-badge">${esc(d.ip_address)}</span>` : '<span style="color:var(--faint)">—</span>'}</td>
        <td><span class="status-pill pill-${d.status||'unknown'}"><span class="sdot"></span>${d.status||'unknown'}</span></td>
        <td>${rxHtml}</td>
        <td>${lastInform}</td>
        <td onclick="event.stopPropagation()">
          <div class="act-btns">
            <button class="act-btn act-detail" onclick="AcsPage.openDetail('${esc(d.serial_number)}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            <button class="act-btn act-reboot" onclick="AcsPage.quickReboot('${esc(d.serial_number)}')" title="Reboot">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  },

  async openDetail(sn) {
    this.currentSn = sn;
    const data = await App.api(`/acs/devices/${encodeURIComponent(sn)}`);
    if (!data?.success) return;
    const d = data.data;
    const p = d.tr069_params || {};

    document.getElementById('detailTitle').textContent = `ONT: ${d.serial_number}`;
    document.getElementById('detailGrid').innerHTML = [
      { lbl:'Serial Number',  val: d.serial_number,              mono:true  },
      { lbl:'Status',         val: d.status || '—',              mono:false },
      { lbl:'Model',          val: d.model || '—',               mono:false },
      { lbl:'Manufacturer',   val: d.manufacturer || '—',        mono:false },
      { lbl:'IP Address',     val: d.ip_address || '—',          mono:true  },
      { lbl:'Firmware',       val: p.fw_version || d.firmware || '—', mono:true },
      { lbl:'HW Version',     val: p.hw_version || '—',          mono:true  },
      { lbl:'RX Power',       val: d.signal_strength != null ? `${d.signal_strength} dBm` : '—', mono:true },
      { lbl:'TX Power',       val: p.tx_power != null ? `${p.tx_power} dBm` : '—', mono:true },
      { lbl:'Uptime',         val: d.uptime || '—',              mono:false },
      { lbl:'Last Inform',    val: d.last_inform ? new Date(d.last_inform).toLocaleString('id-ID') : '—', mono:false },
      { lbl:'Sumber Data',    val: d.source || 'tr069',          mono:true  },
    ].map(item => `
      <div class="info-item">
        <div class="info-lbl">${item.lbl}</div>
        <div class="info-val${item.mono?' mono':''}">${esc(String(item.val))}</div>
      </div>`).join('');

    document.getElementById('detailModal').classList.add('show');
  },

  closeDetailModal() {
    document.getElementById('detailModal').classList.remove('show');
    this.currentSn = null;
    this.switchTab('info');
  },

  switchTab(tab) {
    ['info','wifi'].forEach(t => {
      document.getElementById(`tab-${t}`)?.classList.toggle('active', t===tab);
      document.getElementById(`panel-${t}`)?.style && (document.getElementById(`panel-${t}`).style.display = t===tab ? '' : 'none');
    });
    if (tab === 'wifi' && this.currentSn) this.loadWifi();
  },

  _passVisible: false,
  togglePassVis() {
    this._passVisible = !this._passVisible;
    const el = document.getElementById('currentPass');
    if (!el) return;
    const raw = el.dataset.raw || '';
    el.textContent = this._passVisible ? raw : (raw ? '••••••••' : '—');
  },
  toggleNewPass() {
    const el = document.getElementById('newPass');
    if (el) el.type = el.type === 'password' ? 'text' : 'password';
  },

  async loadWifi() {
    if (!this.currentSn) return;
    const data = await App.api(`/acs/devices/${encodeURIComponent(this.currentSn)}/wifi`);
    if (!data?.success) return;
    const d = data.data;
    const passEl = document.getElementById('currentPass');
    if (passEl) {
      passEl.dataset.raw = d.password || '';
      passEl.textContent = d.password ? '••••••••' : '—';
    }
    const ssidEl = document.getElementById('currentSsid');
    if (ssidEl) ssidEl.textContent = d.ssid || '— (belum diketahui)';
    const chEl = document.getElementById('currentChannel');
    if (chEl) chEl.textContent = d.channel ? `Ch ${d.channel}` : '—';
    // Pre-fill form dengan nilai saat ini
    if (d.ssid) document.getElementById('newSsid').placeholder = d.ssid;
  },

  async refreshWifi() {
    if (!this.currentSn) return;
    const res = await App.api(`/acs/devices/${encodeURIComponent(this.currentSn)}/wifi/refresh`, {method:'POST'});
    App.showToast(res?.message || 'Request dikirim', res?.success ? 'success' : 'error');
  },

  async setWifi() {
    if (!this.currentSn) return;
    const ssid = document.getElementById('newSsid').value.trim();
    const pass = document.getElementById('newPass').value;

    if (!ssid && !pass) {
      App.showToast('Isi SSID atau password yang ingin diubah', 'warning');
      return;
    }
    if (pass && pass.length < 8) {
      App.showToast('Password WiFi minimal 8 karakter', 'error');
      return;
    }
    if (ssid && ssid.length > 32) {
      App.showToast('SSID maksimal 32 karakter', 'error');
      return;
    }

    const btn = document.getElementById('btnSetWifi');
    btn.disabled = true; btn.textContent = 'Mengirim...';

    try {
      const payload = {};
      if (ssid) payload.ssid     = ssid;
      if (pass) payload.password = pass;

      const res = await App.api(`/acs/devices/${encodeURIComponent(this.currentSn)}/wifi`, {
        method: 'POST', body: JSON.stringify(payload)
      });

      if (res?.success) {
        App.showToast(res.message || 'Perubahan WiFi diantrekan', 'success');
        document.getElementById('newSsid').value = '';
        document.getElementById('newPass').value  = '';
      } else {
        App.showToast(res?.message || 'Gagal', 'error');
      }
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1"/></svg> Terapkan Perubahan WiFi`;
    }
  },

  async quickReboot(sn) {
    if (!confirm(`Reboot ONT ${sn}?\n\nPerintah akan dieksekusi saat ONT check-in berikutnya.`)) return;
    const res = await App.api(`/acs/devices/${encodeURIComponent(sn)}/reboot`, { method:'POST' });
    App.showToast(res?.message || 'Reboot diantrekan', res?.success ? 'success' : 'error');
  },

  async rebootDevice() {
    if (!this.currentSn) return;
    await this.quickReboot(this.currentSn);
    this.closeDetailModal();
  },

  openConfigModal()  { document.getElementById('configModal').classList.add('show'); },
  closeConfigModal() { document.getElementById('configModal').classList.remove('show'); },

  async saveConfig() {
    const payload = {
      port:         parseInt(document.getElementById('cfgPort').value) || 7547,
      username:     document.getElementById('cfgUsername').value,
      password:     document.getElementById('cfgPassword').value,
      informPeriod: parseInt(document.getElementById('cfgInformPeriod').value) || 300,
    };
    const btn = document.getElementById('btnSaveConfig');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      const res = await App.api('/acs/config', { method:'POST', body:JSON.stringify(payload) });
      if (res?.success) {
        App.showToast('Config ACS disimpan. Restart app untuk apply port baru.', 'success');
        this.closeConfigModal();
        await this.loadStatus();
      } else App.showToast(res?.message || 'Gagal', 'error');
    } finally { btn.disabled = false; btn.textContent = 'Simpan'; }
  },

  _timeAgo(d) {
    const s = Math.floor((Date.now() - new Date(d)) / 1000);
    if (s < 60)    return `${s}d lalu`;
    if (s < 3600)  return `${Math.floor(s/60)}m lalu`;
    if (s < 86400) return `${Math.floor(s/3600)}j lalu`;
    return `${Math.floor(s/86400)}h lalu`;
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => { this.loadStats(); this.loadDevices(); });
    document.getElementById('btnAcsConfig').addEventListener('click', () => this.openConfigModal());
    document.getElementById('searchInput').addEventListener('input', () => this.loadDevices());
    document.getElementById('filterStatus').addEventListener('change', () => this.loadDevices());
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

document.addEventListener('DOMContentLoaded', () => { App.init(); AcsPage.init(); });