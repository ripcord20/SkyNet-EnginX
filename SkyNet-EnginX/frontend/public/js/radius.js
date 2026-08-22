// radius.js — RADIUS Server management page

const RadiusPage = {
  nas: [],
  users: [],
  sessions: [],
  devices: [],
  wgServers: [],

  async init() {
    this.bindEvents();
    await Promise.all([
      this.loadStatus(), this.loadStats(), this.loadNas(), this.loadUsers(), this.loadSessions(),
      this.loadDeviceOptions(), this.loadWgServerOptions(),
    ]);
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => this.init());
    document.getElementById('btnServerStart').addEventListener('click', () => this.serverAction('start'));
    document.getElementById('btnServerStop').addEventListener('click', () => this.serverAction('stop'));
    document.getElementById('btnAddNasDirect').addEventListener('click', () => this.openNasModal());
    document.getElementById('btnAddNasWireguard').addEventListener('click', () => this.openNasWgModal());
    document.getElementById('btnAddUser').addEventListener('click', () => this.openUserModal());
    document.getElementById('btnSaveNas').addEventListener('click', () => this.saveNas());
    document.getElementById('btnSaveNasWg').addEventListener('click', () => this.saveNasWg());
    document.getElementById('btnSaveUser').addEventListener('click', () => this.saveUser());
    document.getElementById('btnSavePf').addEventListener('click', () => this.savePortForward());
    document.getElementById('searchUsers').addEventListener('input', () => this.renderUsers());
    document.getElementById('activeOnlyToggle').addEventListener('change', () => this.loadSessions());

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      });
    });
  },

  async loadDeviceOptions() {
    const data = await App.api('/devices/mikrotik-list');
    this.devices = data?.success ? data.data : [];
    const opts = this.devices.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.ip_address)})</option>`).join('');
    ['nasDeviceId', 'nasWgDeviceId'].forEach(id => {
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

  async loadStatus() {
    const data = await App.api('/radius/server/status');
    const pill = document.getElementById('serverStatusPill');
    const text = document.getElementById('serverStatusText');
    const btnStart = document.getElementById('btnServerStart');
    const btnStop  = document.getElementById('btnServerStop');
    if (data?.success) {
      const running = data.data.running;
      pill.className = 'status-pill ' + (running ? 'status-on' : 'status-off');
      text.textContent = running
        ? `Berjalan (auth:${data.data.ports?.authPort} acct:${data.data.ports?.acctPort})`
        : (data.data.ready ? 'Berhenti' : 'Paket "radius" belum terpasang');
      btnStart.style.display = running ? 'none' : 'inline-flex';
      btnStop.style.display  = running ? 'inline-flex' : 'none';
    }
  },

  async serverAction(action) {
    const data = await App.api(`/radius/server/${action}`, { method: 'POST', body: JSON.stringify({}) });
    App.showToast(data?.message || (data?.success ? 'OK' : 'Gagal'), data?.success ? 'success' : 'error');
    await this.loadStatus();
  },

  async loadStats() {
    const data = await App.api('/radius/stats');
    if (!data?.success) return;
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('statNas', data.data.nasCount);
    s('statUsers', data.data.userCount);
    s('statSessions', data.data.activeSessions);
    s('statAccept', data.data.server?.stats?.accessAccept ?? 0);
    s('statReject', data.data.server?.stats?.accessReject ?? 0);
  },

  // ── NAS CLIENTS ──────────────────────────────────────────────────
  async loadNas() {
    const data = await App.api('/radius/nas');
    this.nas = data?.success ? data.data : [];
    this.renderNas();
  },

  renderNas() {
    document.getElementById('nasCount').textContent = this.nas.length + ' NAS';
    const wrap = document.getElementById('nasGroups');
    if (!this.nas.length) {
      wrap.innerHTML = `<div class="tbl-empty"><p>Belum ada NAS. Tambahkan router pertama Anda (IP Manual atau via WireGuard).</p></div>`;
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--rd-blue)" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(site)} <span class="site-group-count">${items.length} NAS</span>
        </div>
        <div class="nas-grid">
          ${items.map(n => this.nasCardHtml(n)).join('')}
        </div>
      </div>`).join('');
  },

  nasCardHtml(n) {
    const isWg = n.connection_mode === 'wireguard';
    const online = n.live?.connected;
    return `
      <div class="nas-card">
        <div class="nas-card-top">
          <div>
            <div class="nas-card-name">${esc(n.name)}</div>
            <div class="nas-card-sub">${esc(n.nas_type)}${n.device ? ' · ' + esc(n.device.name) : ''}</div>
          </div>
          <span class="mode-badge ${isWg ? 'mode-wireguard' : 'mode-direct'}">${isWg ? 'WireGuard' : 'Direct'}</span>
        </div>
        <div class="nas-card-body">
          <div class="row"><span>IP NAS</span><b>${esc(n.nas_ip_address)}</b></div>
          ${isWg ? `<div class="row"><span>Status Tunnel</span><b style="color:${online ? 'var(--rd-green)' : 'var(--faint)'};font-family:inherit">${online ? 'Terhubung' : 'Idle'}</b></div>` : ''}
        </div>
        <div class="nas-card-ftr">
          <label class="toggle" title="Aktif/nonaktif">
            <input type="checkbox" ${n.is_active ? 'checked' : ''} onchange="RadiusPage.toggleNas(${n.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
          <button class="btn btn-outline btn-sm" style="flex:1" onclick="RadiusPage.openNasDetail(${n.id})">Lihat Detail</button>
          <button class="icon-btn danger" onclick="RadiusPage.deleteNas(${n.id}, '${esc(n.name)}')" title="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
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
    if (data?.success) { closeModal('nasModal'); this.loadNas(); this.loadStats(); }
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
    if (data?.success) {
      closeModal('nasWgModal');
      this.loadNas(); this.loadStats();
      this.showNasWgResult(data, body.name);
    }
  },

  async showNasWgResult(data, name) {
    document.getElementById('nasDetailTitle').textContent = 'NAS "' + name + '" siap';
    document.getElementById('nasDetailBody').innerHTML = `
      <div class="field" style="margin-bottom:6px"><label>Secret RADIUS (hanya ditampilkan sekali)</label>
        <input type="text" class="mono" readonly value="${esc(data.radiusSecret)}" onclick="this.select()">
      </div>
      <div class="field"><label>Alamat RADIUS server (dari sisi router, lewat tunnel)</label>
        <input type="text" class="mono" readonly value="${esc(data.serverTunnelAddress)}" onclick="this.select()">
      </div>
      <div class="field-hint" style="margin-bottom:10px">
        Di router: <code>/radius add service=ppp,hotspot address=${esc(data.serverTunnelAddress)} secret=${esc(data.radiusSecret)}</code>,
        lalu import config WireGuard di bawah ini terlebih dahulu supaya tunnel-nya aktif.
      </div>
      <div class="result-qr"><img id="nasWgQrImg" src="" alt="QR config"></div>
      <div class="result-conf">${esc(data.wireguardConfig)}</div>
    `;
    openModal('nasDetailModal');
    // Ambil QR dari peer yang baru dibuat
    const nasId = data.data.id;
    const qrData = await App.api(`/wireguard/peers/${data.data.wireguard_peer_id || ''}/qr`).catch(() => null);
    // Fallback: generate QR dari NAS id lewat endpoint config kalau peer id tidak dikirim balik
    if (!qrData?.success) {
      const cfgQr = await this.fetchNasWgQr(nasId);
      if (cfgQr) document.getElementById('nasWgQrImg').src = cfgQr;
    } else {
      document.getElementById('nasWgQrImg').src = qrData.qrImage;
    }
  },

  async fetchNasWgQr(nasId) {
    const n = this.nas.find(x => x.id === nasId);
    if (!n?.wireguard_peer?.id) return null;
    const d = await App.api(`/wireguard/peers/${n.wireguard_peer.id}/qr`);
    return d?.success ? d.qrImage : null;
  },

  async openNasDetail(id) {
    const n = this.nas.find(x => x.id === id);
    if (!n) return;
    document.getElementById('nasDetailTitle').textContent = n.name;
    const isWg = n.connection_mode === 'wireguard';
    let body = `
      <div class="detail-row"><span>Mode Koneksi</span><span>${isWg ? 'WireGuard Tunnel' : 'IP Manual'}</span></div>
      <div class="detail-row"><span>IP NAS</span><span>${esc(n.nas_ip_address)}</span></div>
      <div class="detail-row"><span>Tipe</span><span>${esc(n.nas_type)}</span></div>
      <div class="detail-row"><span>Lokasi</span><span>${esc(n.site_name) || '—'}</span></div>
      <div class="detail-row"><span>Device Terkait</span><span>${n.device ? esc(n.device.name) : '—'}</span></div>
      <div class="detail-row"><span>Secret</span><span class="reveal-secret"><span id="nasSecretVal">••••••••</span><button onclick="RadiusPage.revealSecret(${n.id})">Lihat</button></span></div>
    `;
    if (isWg && n.wireguard_peer) {
      body += `<div style="margin-top:14px"><button class="btn btn-outline btn-sm" onclick="RadiusPage.loadNasWgConfig(${n.id})">Lihat Config &amp; QR WireGuard</button></div>
        <div id="nasWgConfigArea"></div>`;
      body += `
        <div style="margin-top:18px;border-top:1px solid #f1f5f9;padding-top:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <b style="font-size:13px">Port Forwarding</b>
            <button class="btn btn-primary btn-sm" onclick="RadiusPage.openPortForwardModal(${n.id})">+ Tambah</button>
          </div>
          <div id="pfList"><div class="tbl-empty"><p>Memuat...</p></div></div>
        </div>`;
    }
    document.getElementById('nasDetailBody').innerHTML = body;
    openModal('nasDetailModal');
    if (isWg) this.loadPortForwards(n.id);
  },

  async revealSecret(id) {
    const data = await App.api(`/radius/nas/${id}/secret`);
    if (data?.success) document.getElementById('nasSecretVal').textContent = data.secret;
  },

  async loadNasWgConfig(id) {
    const data = await App.api(`/radius/nas/${id}/wireguard-config`);
    if (!data?.success) return App.showToast(data?.message || 'Gagal ambil config', 'error');
    const n = this.nas.find(x => x.id === id);
    const qr = n?.wireguard_peer?.id ? await App.api(`/wireguard/peers/${n.wireguard_peer.id}/qr`) : null;
    document.getElementById('nasWgConfigArea').innerHTML = `
      <div class="result-qr">${qr?.success ? `<img src="${qr.qrImage}">` : ''}</div>
      <div class="result-conf">${esc(data.config)}</div>
    `;
  },

  async loadPortForwards(nasId) {
    const data = await App.api(`/radius/nas/${nasId}/port-forwards`);
    const rows = data?.success ? data.data : [];
    const el = document.getElementById('pfList');
    if (!el) return;
    if (!rows.length) { el.innerHTML = `<p style="font-size:12px;color:var(--faint)">Belum ada port forward.</p>`; return; }
    el.innerHTML = `<table class="rd-table"><thead><tr><th>Publik</th><th>Tujuan</th><th>Protokol</th><th>Ket.</th><th></th></tr></thead><tbody>
      ${rows.map(r => `
        <tr>
          <td class="mono">${r.public_port}</td>
          <td class="mono">${r.target_port}</td>
          <td><span class="badge badge-gray">${r.protocol.toUpperCase()}</span></td>
          <td>${esc(r.description) || '—'}</td>
          <td><button class="icon-btn danger" onclick="RadiusPage.deletePortForward(${nasId}, ${r.id})" title="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button></td>
        </tr>`).join('')}
    </tbody></table>`;
  },

  openPortForwardModal(nasId) {
    document.getElementById('pfNasId').value = nasId;
    document.getElementById('pfPublicPort').value = '';
    document.getElementById('pfTargetPort').value = '';
    document.getElementById('pfProtocol').value = 'tcp';
    document.getElementById('pfDesc').value = '';
    openModal('pfModal');
  },

  async savePortForward() {
    const nasId = document.getElementById('pfNasId').value;
    const body = {
      public_port: document.getElementById('pfPublicPort').value.trim(),
      target_port: document.getElementById('pfTargetPort').value.trim(),
      protocol: document.getElementById('pfProtocol').value,
      description: document.getElementById('pfDesc').value.trim(),
    };
    if (!body.public_port || !body.target_port) return App.showToast('Port publik dan tujuan wajib diisi', 'error');
    const data = await App.api(`/radius/nas/${nasId}/port-forwards`, { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Ditambahkan' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('pfModal'); this.loadPortForwards(nasId); }
  },

  async deletePortForward(nasId, id) {
    if (!confirm('Hapus port forward ini?')) return;
    const data = await App.api(`/radius/nas/${nasId}/port-forwards/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) this.loadPortForwards(nasId);
  },

  async toggleNas(id, checked) {
    const data = await App.api(`/radius/nas/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: checked }) });
    if (!data?.success) { App.showToast(data?.message || 'Gagal', 'error'); this.loadNas(); }
  },

  async deleteNas(id, name) {
    if (!confirm(`Hapus NAS "${name}"? Kalau mode WireGuard, tunnel dan port forward-nya ikut dihapus.`)) return;
    const data = await App.api(`/radius/nas/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { this.loadNas(); this.loadStats(); }
  },

  // ── RADIUS USERS ─────────────────────────────────────────────────
  async loadUsers() {
    const data = await App.api('/radius/users');
    this.users = data?.success ? data.data : [];
    this.renderUsers();
  },

  renderUsers() {
    const search = document.getElementById('searchUsers').value.toLowerCase();
    let rows = this.users;
    if (search) rows = rows.filter(u => u.username.toLowerCase().includes(search));
    document.getElementById('usersCount').textContent = this.users.length;
    const tbody = document.getElementById('usersTbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="tbl-empty"><p>Belum ada RADIUS user.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(u => `
      <tr>
        <td class="mono" style="font-weight:600">${esc(u.username)}</td>
        <td>${u.customer ? esc(u.customer.name) : '<span style="color:var(--faint)">—</span>'}</td>
        <td>${u.reply_rate_limit ? `<span class="badge badge-gray">${esc(u.reply_rate_limit)}</span>` : '—'}</td>
        <td style="color:var(--faint);font-size:12px">${u.last_auth_at ? new Date(u.last_auth_at).toLocaleString('id-ID') : 'Belum pernah'}</td>
        <td>
          <label class="toggle">
            <input type="checkbox" ${u.is_active ? 'checked' : ''} onchange="RadiusPage.toggleUser(${u.id}, this.checked)">
            <span class="toggle-track"></span>
          </label>
        </td>
        <td>
          <div class="row-actions" style="justify-content:flex-end">
            <button class="icon-btn" onclick="RadiusPage.openUserModal(${u.id})" title="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn danger" onclick="RadiusPage.deleteUser(${u.id}, '${esc(u.username)}')" title="Hapus">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`).join('');
  },

  openUserModal(id) {
    const u = id ? this.users.find(x => x.id === id) : null;
    document.getElementById('userModalTitle').textContent = u ? 'Edit RADIUS User' : 'Tambah RADIUS User';
    document.getElementById('userId').value = u ? u.id : '';
    document.getElementById('userUsername').value = u ? u.username : '';
    document.getElementById('userPassword').value = '';
    document.getElementById('userCustomerId').value = u && u.customer_id ? u.customer_id : '';
    document.getElementById('userRateLimit').value = u ? (u.reply_rate_limit || '') : '';
    document.getElementById('userFramedIp').value = u ? (u.reply_framed_ip || '') : '';
    document.getElementById('userNotes').value = u ? (u.notes || '') : '';
    openModal('userModal');
  },

  async saveUser() {
    const id = document.getElementById('userId').value;
    const body = {
      username: document.getElementById('userUsername').value.trim(),
      password: document.getElementById('userPassword').value,
      customer_id: document.getElementById('userCustomerId').value.trim() || null,
      reply_rate_limit: document.getElementById('userRateLimit').value.trim(),
      reply_framed_ip: document.getElementById('userFramedIp').value.trim(),
      notes: document.getElementById('userNotes').value.trim(),
    };
    if (!body.username) return App.showToast('Username wajib diisi', 'error');
    if (!id && !body.password) return App.showToast('Password wajib diisi', 'error');
    const data = await App.api(id ? `/radius/users/${id}` : '/radius/users', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Tersimpan' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('userModal'); this.loadUsers(); this.loadStats(); }
  },

  async toggleUser(id, checked) {
    const data = await App.api(`/radius/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: checked }) });
    if (!data?.success) { App.showToast(data?.message || 'Gagal', 'error'); this.loadUsers(); }
  },

  async deleteUser(id, username) {
    if (!confirm(`Hapus RADIUS user "${username}"?`)) return;
    const data = await App.api(`/radius/users/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { this.loadUsers(); this.loadStats(); }
  },

  // ── SESSIONS ─────────────────────────────────────────────────────
  async loadSessions() {
    const activeOnly = document.getElementById('activeOnlyToggle').checked;
    const data = await App.api(`/radius/sessions?active=${activeOnly ? '1' : '0'}`);
    this.sessions = data?.success ? data.data : [];
    this.renderSessions();
  },

  renderSessions() {
    document.getElementById('sessionsCount').textContent = this.sessions.length;
    const tbody = document.getElementById('sessionsTbody');
    if (!this.sessions.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="tbl-empty"><p>Tidak ada sesi.</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = this.sessions.map(s => {
      const started = s.started_at ? new Date(s.started_at) : null;
      const dur = started ? fmtDuration((Date.now() - started.getTime()) / 1000) : '—';
      return `
      <tr>
        <td class="mono" style="font-weight:600">${esc(s.username) || '—'}</td>
        <td class="mono">${esc(s.nas_ip_address)}</td>
        <td class="mono">${esc(s.framed_ip_address) || '—'}</td>
        <td style="color:var(--faint);font-size:12px">${started ? started.toLocaleString('id-ID') : '—'}</td>
        <td>${s.stopped_at ? '<span class="badge badge-gray">Selesai</span>' : `<span class="badge badge-green">${dur}</span>`}</td>
        <td>${fmtBytes(s.input_octets)}</td>
        <td>${fmtBytes(s.output_octets)}</td>
      </tr>`;
    }).join('');
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
function fmtDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
}

document.addEventListener('DOMContentLoaded', () => { App.init(); RadiusPage.init(); });
