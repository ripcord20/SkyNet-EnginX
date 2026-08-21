// nas.js — halaman NAS (VPN L2TP/PPTP + WireGuard + IP Manual)

const NasPage = {
  nas: [],
  devices: [],
  wgServers: [],
  vpnSettings: null,
  currentDetailId: null,

  async init() {
    this.bindEvents();
    await Promise.all([
      this.loadNas(),
      this.loadDeviceOptions(),
      this.loadWgServerOptions(),
      this.loadVpnSettings(),
    ]);
  },

  bindEvents() {
    document.getElementById('btnAddNasVpn').addEventListener('click', () => this.openNasVpnModal());
    document.getElementById('btnAddNasDirect').addEventListener('click', () => this.openNasModal());
    document.getElementById('btnAddNasWireguard').addEventListener('click', () => this.openNasWgModal());
    document.getElementById('btnVpnSettings').addEventListener('click', () => this.openVpnSettings());
    document.getElementById('btnSaveNasVpn').addEventListener('click', () => this.saveNasVpn());
    document.getElementById('btnSaveNas').addEventListener('click', () => this.saveNas());
    document.getElementById('btnSaveNasWg').addEventListener('click', () => this.saveNasWg());
    document.getElementById('btnSaveVpnSettings').addEventListener('click', () => this.saveVpnSettings());
  },

  async loadDeviceOptions() {
    const data = await App.api('/devices/mikrotik-list');
    this.devices = data?.success ? data.data : [];
    const opts = this.devices.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.ip_address)})</option>`).join('');
    ['nasDeviceId', 'nasWgDeviceId', 'nasVpnDeviceId'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = '<option value="">— Tidak ada —</option>' + opts;
    });
  },

  async loadWgServerOptions() {
    const data = await App.api('/wireguard/servers');
    this.wgServers = data?.success ? data.data : [];
    const sel = document.getElementById('nasWgServerId');
    if (sel) {
      sel.innerHTML = this.wgServers.length
        ? this.wgServers.map(s => `<option value="${s.id}">${esc(s.interface_name)} (${esc(s.address_cidr)})</option>`).join('')
        : '<option value="">Belum ada interface WireGuard</option>';
    }
  },

  async loadVpnSettings() {
    const data = await App.api('/radius/vpn/settings');
    this.vpnSettings = data?.success ? data.data : null;
    const ip = this.vpnSettings?.serverIp || this.vpnSettings?.detectedServerIp || '—';
    const el = document.getElementById('statServerIp');
    if (el) el.textContent = ip;
  },

  async loadNas() {
    const data = await App.api('/radius/nas');
    this.nas = data?.success ? data.data : [];
    this.renderNas();
  },

  renderNas() {
    const wrap = document.getElementById('nasGroups');
    const vpnList = this.nas.filter(n => n.connection_mode === 'vpn');
    const online = vpnList.filter(n => n.live?.connected).length;
    setText('statTotal', this.nas.length);
    setText('statVpn', vpnList.length);
    setText('statOnline', online);

    if (!this.nas.length) {
      wrap.innerHTML = `<div class="tbl-empty"><p>Belum ada NAS. Klik "NAS via VPN" untuk membuat router pertama (L2TP/PPTP ke MikroTik).</p></div>`;
      return;
    }
    const groups = new Map();
    for (const n of this.nas) {
      const key = n.site_name || 'Tanpa Lokasi';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    wrap.innerHTML = [...groups.entries()].map(([site, items]) => `
      <div class="site-group">
        <div class="site-group-hdr">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--nas-blue)" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(site)} <span class="site-group-count">${items.length} NAS</span>
        </div>
        <div class="nas-grid">${items.map(n => this.nasCardHtml(n)).join('')}</div>
      </div>`).join('');
  },

  modeMeta(n) {
    if (n.connection_mode === 'vpn') return { cls: 'mode-vpn', label: 'VPN' };
    if (n.connection_mode === 'wireguard') return { cls: 'mode-wireguard', label: 'WireGuard' };
    return { cls: 'mode-direct', label: 'Direct' };
  },

  nasCardHtml(n) {
    const mode = this.modeMeta(n);
    const tunneled = n.connection_mode === 'vpn' || n.connection_mode === 'wireguard';
    const online = n.live?.connected;
    return `
      <div class="nas-card">
        <div class="nas-card-top">
          <div>
            <div class="nas-card-name">${esc(n.name)}</div>
            <div class="nas-card-sub">${esc(n.nas_type)}${n.device ? ' · ' + esc(n.device.name) : ''}</div>
          </div>
          <span class="mode-badge ${mode.cls}">${mode.label}</span>
        </div>
        <div class="nas-card-body">
          <div class="row"><span>IP NAS</span><b>${esc(n.nas_ip_address)}</b></div>
          ${tunneled ? `<div class="row"><span>Status Tunnel</span><b style="color:${online ? 'var(--nas-green)' : 'var(--faint)'};font-family:inherit">${online ? 'Terhubung' : 'Belum terhubung'}</b></div>` : ''}
          ${n.connection_mode === 'vpn' && n.vpn_username ? `<div class="row"><span>Username</span><b>${esc(n.vpn_username)}</b></div>` : ''}
        </div>
        <div class="nas-card-ftr">
          <label class="toggle" title="Aktif/nonaktif">
            <input type="checkbox" ${n.is_active ? 'checked' : ''} onchange="NasPage.toggleNas(${n.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
          <button class="btn btn-outline btn-sm" style="flex:1" onclick="NasPage.openNasDetail(${n.id})">Lihat Detail</button>
          <button class="icon-btn danger" onclick="NasPage.deleteNas(${n.id}, '${esc(n.name)}')" title="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
  },

  openNasVpnModal() {
    if (!this.vpnSettings?.serverIp) {
      App.showToast('Isi IP Server VPN di Pengaturan VPN terlebih dahulu', 'error');
      return this.openVpnSettings();
    }
    document.getElementById('nasVpnName').value = '';
    document.getElementById('nasVpnSite').value = '';
    document.getElementById('nasVpnDeviceId').value = '';
    document.getElementById('nasVpnDesc').value = '';
    openModal('nasVpnModal');
  },

  async saveNasVpn() {
    const body = {
      name: document.getElementById('nasVpnName').value.trim(),
      site_name: document.getElementById('nasVpnSite').value.trim(),
      device_id: document.getElementById('nasVpnDeviceId').value || null,
      description: document.getElementById('nasVpnDesc').value.trim(),
    };
    if (!body.name) return App.showToast('Nama NAS wajib diisi', 'error');
    const data = await App.api('/radius/nas/via-vpn', { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'NAS dibuat' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) {
      closeModal('nasVpnModal');
      await this.loadNas();
      if (data.data?.id) this.openNasDetail(data.data.id);
    }
  },

  openNasModal(id) {
    const n = id ? this.nas.find(x => x.id === id) : null;
    document.getElementById('nasModalTitle').textContent = n ? 'Edit NAS' : 'Tambah NAS — IP Manual';
    document.getElementById('nasId').value = n ? n.id : '';
    document.getElementById('nasName').value = n ? n.name : '';
    document.getElementById('nasIp').value = n ? n.nas_ip_address : '';
    document.getElementById('nasSecret').value = '';
    document.getElementById('nasType').value = n ? n.nas_type : 'mikrotik';
    document.getElementById('nasSite').value = n ? (n.site_name || '') : '';
    document.getElementById('nasDeviceId').value = n && n.device_id ? n.device_id : '';
    document.getElementById('nasDesc').value = n ? (n.description || '') : '';
    openModal('nasModal');
  },

  async saveNas() {
    const id = document.getElementById('nasId').value;
    const body = {
      name: document.getElementById('nasName').value.trim(),
      nas_ip_address: document.getElementById('nasIp').value.trim(),
      secret: document.getElementById('nasSecret').value,
      nas_type: document.getElementById('nasType').value,
      site_name: document.getElementById('nasSite').value.trim(),
      device_id: document.getElementById('nasDeviceId').value || null,
      description: document.getElementById('nasDesc').value.trim(),
    };
    if (!body.name || !body.nas_ip_address) return App.showToast('Nama dan IP wajib diisi', 'error');
    if (!id && !body.secret) return App.showToast('Secret wajib diisi', 'error');
    const data = await App.api(id ? `/radius/nas/${id}` : '/radius/nas', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Tersimpan' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('nasModal'); this.loadNas(); }
  },

  openNasWgModal() {
    if (!this.wgServers.length) return App.showToast('Buat interface WireGuard dahulu di menu WireGuard VPN', 'error');
    document.getElementById('nasWgName').value = '';
    document.getElementById('nasWgSite').value = '';
    document.getElementById('nasWgDeviceId').value = '';
    document.getElementById('nasWgDesc').value = '';
    openModal('nasWgModal');
  },

  async saveNasWg() {
    const body = {
      name: document.getElementById('nasWgName').value.trim(),
      server_id: document.getElementById('nasWgServerId').value,
      site_name: document.getElementById('nasWgSite').value.trim(),
      device_id: document.getElementById('nasWgDeviceId').value || null,
      description: document.getElementById('nasWgDesc').value.trim(),
    };
    if (!body.name || !body.server_id) return App.showToast('Nama dan interface wajib diisi', 'error');
    const data = await App.api('/radius/nas/via-wireguard', { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'NAS dibuat' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('nasWgModal'); this.loadNas(); }
  },

  openVpnSettings() {
    const s = this.vpnSettings || {};
    document.getElementById('vpnServerIp').value = s.serverIp || s.detectedServerIp || '';
    document.getElementById('vpnLocalIp').value = s.localIp || '';
    document.getElementById('vpnPoolCidr').value = s.poolCidr || '';
    document.getElementById('vpnProfileName').value = s.profileName || '';
    document.getElementById('vpnMtu').value = s.mtu || '';
    document.getElementById('vpnDns').value = s.dns || '';
    document.getElementById('vpnProtocols').value = s.protocols || 'l2tp,pptp';
    const hint = document.getElementById('vpnDetectedHint');
    if (hint && s.detectedServerIp) hint.textContent = 'Terdeteksi di server ini: ' + s.detectedServerIp;
    openModal('vpnSettingsModal');
  },

  async saveVpnSettings() {
    const body = {
      serverIp: document.getElementById('vpnServerIp').value.trim(),
      localIp: document.getElementById('vpnLocalIp').value.trim(),
      poolCidr: document.getElementById('vpnPoolCidr').value.trim(),
      profileName: document.getElementById('vpnProfileName').value.trim(),
      mtu: document.getElementById('vpnMtu').value.trim(),
      dns: document.getElementById('vpnDns').value.trim(),
      protocols: document.getElementById('vpnProtocols').value,
    };
    if (!body.serverIp) return App.showToast('IP Server VPN wajib diisi', 'error');
    const data = await App.api('/radius/vpn/settings', { method: 'PUT', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Tersimpan' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) {
      this.vpnSettings = data.data;
      setText('statServerIp', data.data.serverIp || '—');
      closeModal('vpnSettingsModal');
    }
  },

  async openNasDetail(id) {
    this.currentDetailId = id;
    document.getElementById('nasDetailBody').innerHTML = `<div class="tbl-empty"><p>Memuat...</p></div>`;
    openModal('nasDetailModal');
    const data = await App.api(`/radius/nas/${id}/detail`);
    if (!data?.success) {
      document.getElementById('nasDetailBody').innerHTML = `<div class="tbl-empty"><p>${esc(data?.message || 'Gagal memuat')}</p></div>`;
      return;
    }
    this.renderDetail(data.data);
  },

  renderDetail(d) {
    const isVpn = d.connection_mode === 'vpn';
    const connected = !!d.live?.connected;
    const modeLabel = isVpn ? 'VPN' : (d.connection_mode === 'wireguard' ? 'WireGuard' : 'Direct');
    const modeCls = isVpn ? 'mode-vpn' : (d.connection_mode === 'wireguard' ? 'mode-wireguard' : 'mode-direct');

    let connBody = `
      <div style="margin-bottom:14px"><span class="mode-badge ${modeCls}">${modeLabel}</span></div>
      <div class="kv-grid">
        <div class="kv"><label>Mode Koneksi</label><div class="val" style="font-family:inherit">${modeLabel}</div></div>
        ${isVpn ? `<div class="kv"><label>Protocol</label><div class="val">${esc(d.vpn?.protocolLabel || 'L2TP, PPTP')}</div></div>` : ''}
        ${isVpn ? `<div class="kv"><label>IP Server VPN</label><div class="val">${esc(d.vpn?.serverIp || '—')}</div></div>` : `<div class="kv"><label>IP NAS</label><div class="val">${esc(d.nas_ip_address)}</div></div>`}
        ${isVpn ? `<div class="kv"><label>Username</label><div class="val">${esc(d.vpn?.username || d.vpn_username || '—')}</div></div>` : ''}
        ${isVpn ? `<div class="kv"><label>Password</label><div class="val"><span class="pw-row"><span id="vpnPwVal">••••••</span><button type="button" title="Lihat password" onclick="NasPage.revealVpnPassword(${d.id})">${eyeIcon()}</button></span></div></div>` : ''}
      </div>`;

    const profile = d.vpn?.profile;
    const profileBody = profile ? `
      <div class="kv-grid">
        <div class="kv"><label>Nama Profile</label><div class="val">${esc(profile.name)}</div></div>
        <div class="kv"><label>Local Address</label><div class="val">${esc(profile.localAddress)}</div></div>
        <div class="kv"><label>Remote Address</label><div class="val">${esc(profile.remoteAddress)}</div></div>
        <div class="kv"><label>DNS</label><div class="val">${esc(profile.dns)}</div></div>
        <div class="kv"><label>MTU</label><div class="val">${esc(profile.mtu)}</div></div>
        <div class="kv"><label>Only One / Encryption</label><div class="val" style="font-family:inherit">${profile.onlyOne ? 'yes' : 'no'} / ${profile.useEncryption ? 'yes' : 'no'}</div></div>
      </div>` : `<p style="font-size:12.5px;color:var(--faint);margin:0">Profile PPP hanya untuk NAS mode VPN.</p>`;

    const nasInfoBody = `
      <div class="kv-grid">
        <div class="kv"><label>Nama</label><div class="val" style="font-family:inherit">${esc(d.name)}</div></div>
        <div class="kv"><label>IP NAS</label><div class="val">${esc(d.nas_ip_address)}</div></div>
        <div class="kv"><label>Tipe</label><div class="val">${esc(d.nas_type)}</div></div>
        <div class="kv"><label>Lokasi</label><div class="val" style="font-family:inherit">${esc(d.site_name) || '—'}</div></div>
        <div class="kv"><label>Device Terkait</label><div class="val" style="font-family:inherit">${d.device ? esc(d.device.name) : '—'}</div></div>
        <div class="kv"><label>Secret RADIUS</label><div class="val"><span class="pw-row"><span id="nasSecretVal">••••••</span><button type="button" title="Lihat secret" onclick="NasPage.revealSecret(${d.id})">${eyeIcon()}</button></span></div></div>
      </div>`;

    let statusHtml = '';
    if (isVpn && connected) {
      statusHtml = `
        <div class="status-box ok">
          <div class="status-ic">${linkIcon()}</div>
          <div>
            <h4>NAS Sudah Terhubung</h4>
            <p>NAS ini sudah dalam status online dan terhubung dengan Mikrotik. Script konfigurasi disembunyikan untuk mencegah kesalahan copy-paste ke Mikrotik lain, karena setiap NAS hanya diperuntukkan untuk satu perangkat Mikrotik.</p>
          </div>
        </div>`;
    } else if (isVpn && d.script) {
      statusHtml = `
        <div class="status-box warn">
          <div class="status-ic">${linkIcon()}</div>
          <div>
            <h4>NAS Belum Terhubung</h4>
            <p>Paste script di bawah ini ke terminal MikroTik. Setelah tunnel L2TP/PPTP connected, script akan disembunyikan otomatis.</p>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin:8px 0">
          <button class="btn btn-primary btn-sm" onclick="NasPage.copyScript()">Salin Script</button>
        </div>
        <pre class="script-box" id="nasScriptBox">${esc(d.script)}</pre>`;
    }

    document.getElementById('nasDetailBody').innerHTML = `
      <div class="acc open" data-acc="conn">
        <button type="button" class="acc-h" onclick="NasPage.toggleAcc(this)">
          <span class="acc-ic">${plugIcon()}</span>
          <b>Informasi Koneksi</b>
          ${chevron()}
        </button>
        <div class="acc-b">${connBody}</div>
      </div>
      <div class="acc" data-acc="ppp">
        <button type="button" class="acc-h" onclick="NasPage.toggleAcc(this)">
          <span class="acc-ic">${profileIcon()}</span>
          <b>Informasi Profile PPP</b>
          ${chevron()}
        </button>
        <div class="acc-b">${profileBody}</div>
      </div>
      <div class="acc" data-acc="nas">
        <button type="button" class="acc-h" onclick="NasPage.toggleAcc(this)">
          <span class="acc-ic">${linkIcon()}</span>
          <b>Informasi NAS</b>
          ${chevron()}
        </button>
        <div class="acc-b">${nasInfoBody}</div>
      </div>
      ${statusHtml}
    `;
  },

  toggleAcc(btn) {
    btn.parentElement.classList.toggle('open');
  },

  async revealVpnPassword(id) {
    const data = await App.api(`/radius/nas/${id}/vpn-password`);
    if (data?.success) document.getElementById('vpnPwVal').textContent = data.password;
  },

  async revealSecret(id) {
    const data = await App.api(`/radius/nas/${id}/secret`);
    if (data?.success) document.getElementById('nasSecretVal').textContent = data.secret;
  },

  copyScript() {
    const el = document.getElementById('nasScriptBox');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(
      () => App.showToast('Script disalin', 'success'),
      () => App.showToast('Gagal menyalin', 'error')
    );
  },

  async toggleNas(id, checked) {
    const data = await App.api(`/radius/nas/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: checked }) });
    if (!data?.success) { App.showToast(data?.message || 'Gagal', 'error'); this.loadNas(); }
  },

  async deleteNas(id, name) {
    if (!confirm(`Hapus NAS "${name}"? Akun VPN, tunnel, dan port forward ikut dihapus.`)) return;
    const data = await App.api(`/radius/nas/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) this.loadNas();
  },
};

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function chevron() {
  return `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
}
function eyeIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}
function plugIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
}
function profileIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
}
function linkIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
}

document.addEventListener('DOMContentLoaded', () => { App.init(); NasPage.init(); });
