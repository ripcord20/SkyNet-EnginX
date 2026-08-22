// wireguard.js — WireGuard VPN management page

const WireguardPage = {
  servers: [],
  peers: [],
  wgAvailable: true,
  lastConfigText: '',
  lastConfigName: 'peer',

  async init() {
    this.bindEvents();
    await this.loadServers();
    await this.loadPeers();
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => this.init());
    document.getElementById('btnAddIface').addEventListener('click', () => openModal('ifaceModal'));
    document.getElementById('btnSaveIface').addEventListener('click', () => this.saveIface());
    document.getElementById('btnAutoPeer').addEventListener('click', () => this.openAutoPeerModal());
    document.getElementById('btnCreateAutoPeer').addEventListener('click', () => this.createAutoPeer());
    document.getElementById('btnSaveEditPeer').addEventListener('click', () => this.saveEditPeer());
    document.getElementById('filterIface').addEventListener('change', () => this.loadPeers());
    document.getElementById('btnCopyConfig').addEventListener('click', () => {
      navigator.clipboard?.writeText(this.lastConfigText);
      App.showToast('Konfigurasi disalin ke clipboard', 'success');
    });
    document.getElementById('btnDownloadConfig').addEventListener('click', () => {
      const blob = new Blob([this.lastConfigText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = this.lastConfigName + '.conf';
      a.click();
      URL.revokeObjectURL(url);
    });
  },

  // ── INTERFACES ───────────────────────────────────────────────────
  async loadServers() {
    const data = await App.api('/wireguard/servers');
    this.servers = data?.success ? data.data : [];
    this.wgAvailable = data?.wgAvailable !== false;
    document.getElementById('wgUnavailableWarn').style.display = this.wgAvailable ? 'none' : 'flex';
    this.renderServers();
    this.populateIfaceSelects();
  },

  renderServers() {
    const grid = document.getElementById('ifaceGrid');
    if (!this.servers.length) {
      grid.innerHTML = `<div class="tbl-empty" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
        <p>Belum ada interface WireGuard. Buat interface pertama untuk mulai menambahkan peer.</p>
      </div>`;
      return;
    }
    grid.innerHTML = this.servers.map(s => `
      <div class="iface-card">
        <div class="iface-top">
          <div>
            <div class="iface-name">${esc(s.interface_name)}</div>
            <div class="iface-sub">${esc(s.address_cidr)}</div>
          </div>
          <span class="status-pill ${s.interfaceUp ? 'status-on' : 'status-off'}"><span class="dot"></span>${s.interfaceUp ? 'Up' : 'Down'}</span>
        </div>
        <div class="iface-body">
          <div class="row"><span>Public Key</span><b title="${esc(s.public_key)}">${esc(s.public_key).slice(0, 12)}…</b></div>
          <div class="row"><span>Listen Port</span><b>${s.listen_port}</b></div>
          <div class="row"><span>Endpoint</span><b>${esc(s.endpoint_host) || '—'}</b></div>
          <div class="row"><span>Peers</span><b>${s.peerCount}</b></div>
        </div>
        <div class="iface-ftr">
          <label class="toggle" title="Aktifkan/matikan interface">
            <input type="checkbox" ${s.is_active ? 'checked' : ''} onchange="WireguardPage.toggleIface(${s.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
          <button class="btn btn-outline btn-sm" onclick="WireguardPage.copyText('${esc(s.public_key)}')" style="flex:1">Salin Public Key</button>
          <button class="icon-btn danger" onclick="WireguardPage.deleteIface(${s.id}, '${esc(s.interface_name)}')" title="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`).join('');
  },

  populateIfaceSelects() {
    const opts = this.servers.map(s => `<option value="${s.id}">${esc(s.interface_name)} (${esc(s.address_cidr)})</option>`).join('');
    const autoSel = document.getElementById('autoPeerIface');
    autoSel.innerHTML = opts || '<option value="">Belum ada interface</option>';
    const filterSel = document.getElementById('filterIface');
    const cur = filterSel.value;
    filterSel.innerHTML = '<option value="">Semua Interface</option>' + opts;
    filterSel.value = cur;
  },

  async saveIface() {
    const body = {
      interface_name: document.getElementById('ifaceName').value.trim(),
      address_cidr: document.getElementById('ifaceCidr').value.trim(),
      listen_port: document.getElementById('ifacePort').value.trim() || 51820,
      endpoint_host: document.getElementById('ifaceEndpoint').value.trim(),
      dns: document.getElementById('ifaceDns').value.trim() || '1.1.1.1',
      mtu: document.getElementById('ifaceMtu').value.trim(),
    };
    if (!body.interface_name || !body.address_cidr) return App.showToast('Nama interface dan subnet wajib diisi', 'error');
    const data = await App.api('/wireguard/servers', { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Interface dibuat' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('ifaceModal'); this.loadServers(); }
  },

  async toggleIface(id, checked) {
    const data = await App.api(`/wireguard/servers/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: checked }) });
    App.showToast(data?.message || (data?.success ? 'OK' : 'Gagal'), data?.success ? 'success' : 'error');
    this.loadServers();
  },

  async deleteIface(id, name) {
    if (!confirm(`Hapus interface "${name}" beserta SEMUA peer di dalamnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    const data = await App.api(`/wireguard/servers/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { this.loadServers(); this.loadPeers(); }
  },

  copyText(text) {
    navigator.clipboard?.writeText(text);
    App.showToast('Disalin ke clipboard', 'success');
  },

  // ── PEERS ────────────────────────────────────────────────────────
  async loadPeers() {
    const serverId = document.getElementById('filterIface').value;
    const data = await App.api('/wireguard/peers' + (serverId ? `?server_id=${serverId}` : ''));
    this.peers = data?.success ? data.data : [];
    this.renderPeers();
  },

  renderPeers() {
    document.getElementById('peersCount').textContent = this.peers.length;
    const tbody = document.getElementById('peersTbody');
    if (!this.peers.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="tbl-empty"><p>Belum ada peer. Klik "Auto Create Peer" untuk membuat yang pertama.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = this.peers.map(p => `
      <tr>
        <td style="font-weight:600">${esc(p.name)}</td>
        <td>${p.customer ? esc(p.customer.name) : '<span style="color:var(--faint)">—</span>'}</td>
        <td class="mono">${esc(p.allocated_ip)}</td>
        <td>${p.is_enabled
          ? (p.live?.connected ? '<span class="badge" style="background:var(--wg-green-l);color:var(--wg-green)">Terhubung</span>' : '<span class="badge badge-gray">Idle</span>')
          : '<span class="badge badge-gray">Nonaktif</span>'}</td>
        <td style="color:var(--faint);font-size:12px">${p.live?.lastHandshake ? new Date(p.live.lastHandshake).toLocaleString('id-ID') : 'Belum pernah'}</td>
        <td style="font-size:11.5px">${fmtBytes(p.live?.rx)} / ${fmtBytes(p.live?.tx)}</td>
        <td>
          <div class="row-actions">
            ${p.hasConfig ? `
            <button class="icon-btn" onclick="WireguardPage.showQr(${p.id})" title="QR Code">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="14" y1="14" x2="14" y2="21"/><line x1="21" y1="14" x2="21" y2="21"/><line x1="17" y1="17" x2="17" y2="17.01"/></svg>
            </button>
            <button class="icon-btn" onclick="WireguardPage.downloadPeerConfig(${p.id}, '${esc(p.name)}')" title="Download config">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>` : ''}
            <label class="toggle" title="Aktif/nonaktif">
              <input type="checkbox" ${p.is_enabled ? 'checked' : ''} onchange="WireguardPage.togglePeer(${p.id}, this.checked)">
              <span class="toggle-track"></span>
            </label>
            <button class="icon-btn" onclick="WireguardPage.openEditPeerModal(${p.id})" title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn danger" onclick="WireguardPage.deletePeer(${p.id}, '${esc(p.name)}')" title="Hapus">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`).join('');
  },

  openAutoPeerModal() {
    if (!this.servers.length) return App.showToast('Buat interface WireGuard dahulu', 'error');
    document.getElementById('autoPeerName').value = '';
    document.getElementById('autoPeerCustomerId').value = '';
    document.getElementById('autoPeerAllowedIps').value = '';
    openModal('autoPeerModal');
  },

  async createAutoPeer() {
    const body = {
      server_id: document.getElementById('autoPeerIface').value,
      name: document.getElementById('autoPeerName').value.trim(),
      customer_id: document.getElementById('autoPeerCustomerId').value.trim() || null,
      client_allowed_ips: document.getElementById('autoPeerAllowedIps').value.trim() || undefined,
    };
    if (!body.server_id || !body.name) return App.showToast('Interface dan nama peer wajib diisi', 'error');
    const data = await App.api('/wireguard/peers/auto', { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Peer dibuat' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) {
      closeModal('autoPeerModal');
      this.loadServers(); this.loadPeers();
      this.showResult('Peer "' + body.name + '" siap', data.config, body.name, data.data.id);
    }
  },

  // Buka modal hasil (QR + config) untuk peer yang SUDAH ADA di tabel.
  async showQr(id) {
    const peer = this.peers.find(p => p.id === id);
    const [qrData, configText] = await Promise.all([
      App.api(`/wireguard/peers/${id}/qr`),
      this.fetchConfigText(id),
    ]);
    if (!qrData?.success) return App.showToast(qrData?.message || 'Gagal membuat QR', 'error');
    this.showResult('QR Config — ' + (peer?.name || ''), configText || '', peer?.name || 'peer', id, qrData.qrImage);
  },

  // Tampilkan modal hasil. qrImage opsional — kalau tidak diberikan, diambil dari server via peerId.
  async showResult(title, configText, name, peerId, qrImage) {
    document.getElementById('resultTitle').textContent = title;
    this.lastConfigText = configText;
    this.lastConfigName = name;
    document.getElementById('resultConfText').textContent = configText;
    document.getElementById('resultQrImg').src = qrImage || '';
    if (!qrImage && peerId) {
      const d = await App.api(`/wireguard/peers/${peerId}/qr`);
      if (d?.success) document.getElementById('resultQrImg').src = d.qrImage;
    }
    openModal('resultModal');
  },

  // Endpoint /config mengembalikan text/plain langsung, bukan JSON — fetch manual.
  async fetchConfigText(id) {
    try {
      const res = await fetch(`/api/wireguard/peers/${id}/config`, {
        headers: App.token ? { Authorization: `Bearer ${App.token}` } : {},
      });
      if (!res.ok) return '';
      return await res.text();
    } catch (e) { return ''; }
  },

  async downloadPeerConfig(id, name) {
    const text = await this.fetchConfigText(id);
    if (!text) return App.showToast('Gagal download config', 'error');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.conf';
    a.click();
    URL.revokeObjectURL(url);
  },

  async togglePeer(id, checked) {
    const data = await App.api(`/wireguard/peers/${id}`, { method: 'PUT', body: JSON.stringify({ is_enabled: checked }) });
    if (!data?.success) App.showToast(data?.message || 'Gagal', 'error');
    this.loadPeers();
  },

  openEditPeerModal(id) {
    const p = this.peers.find(x => x.id === id);
    if (!p) return;
    document.getElementById('editPeerId').value = p.id;
    document.getElementById('editPeerName').value = p.name;
    document.getElementById('editPeerAllowedIps').value = p.client_allowed_ips;
    document.getElementById('editPeerKeepalive').value = p.persistent_keepalive || '';
    document.getElementById('editPeerEndpoint').value = p.endpoint || '';
    document.getElementById('editPeerNotes').value = p.notes || '';
    openModal('editPeerModal');
  },

  async saveEditPeer() {
    const id = document.getElementById('editPeerId').value;
    const body = {
      name: document.getElementById('editPeerName').value.trim(),
      client_allowed_ips: document.getElementById('editPeerAllowedIps').value.trim(),
      persistent_keepalive: document.getElementById('editPeerKeepalive').value.trim(),
      endpoint: document.getElementById('editPeerEndpoint').value.trim(),
      notes: document.getElementById('editPeerNotes').value.trim(),
    };
    const data = await App.api(`/wireguard/peers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Tersimpan' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('editPeerModal'); this.loadPeers(); }
  },

  async deletePeer(id, name) {
    if (!confirm(`Hapus peer "${name}"?`)) return;
    const data = await App.api(`/wireguard/peers/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { this.loadServers(); this.loadPeers(); }
  },
};

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtBytes(n) {
  n = parseInt(n, 10) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB','MB','GB','TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + ' ' + units[i];
}

document.addEventListener('DOMContentLoaded', () => { App.init(); WireguardPage.init(); });
