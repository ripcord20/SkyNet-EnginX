// port-forwarding.js — consolidated Port Forwarding page (all NAS, one table)

const PortForwardingPage = {
  rows: [],
  nasOptions: [],

  async init() {
    this.bindEvents();
    await Promise.all([this.loadNasOptions(), this.loadForwards()]);
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => this.init());
    document.getElementById('btnAddForward').addEventListener('click', () => this.openCreateModal());
    document.getElementById('btnSaveForward').addEventListener('click', () => this.saveForward());
    document.getElementById('filterSearch').addEventListener('input', () => this.render());
    document.getElementById('filterSite').addEventListener('change', () => this.render());
    document.getElementById('filterProto').addEventListener('change', () => this.render());
  },

  // ── DATA ─────────────────────────────────────────────────────────
  async loadNasOptions() {
    const data = await App.api('/radius/nas');
    const all = data?.success ? data.data : [];
    this.nasOptions = all.filter(n => n.connection_mode === 'wireguard');
  },

  async loadForwards() {
    const data = await App.api('/radius/port-forwards');
    this.rows = data?.success ? data.data : [];
    this.populateSiteFilter();
    this.render();
  },

  populateSiteFilter() {
    const sites = [...new Set(this.rows.map(r => r.nas?.site_name).filter(Boolean))].sort();
    const sel = document.getElementById('filterSite');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Semua Situs</option>' + sites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sel.value = cur;
  },

  // ── RENDER ───────────────────────────────────────────────────────
  render() {
    const search = document.getElementById('filterSearch').value.trim().toLowerCase();
    const site = document.getElementById('filterSite').value;
    const proto = document.getElementById('filterProto').value;

    const filtered = this.rows.filter(r => {
      if (site && r.nas?.site_name !== site) return false;
      if (proto && r.protocol !== proto) return false;
      if (search) {
        const hay = [r.nas?.name, r.nas?.site_name, r.description, String(r.public_port), String(r.target_port)].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    document.getElementById('pfCount').textContent = filtered.length;
    const tbody = document.getElementById('pfTbody');

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
        <p>${this.rows.length ? 'Tidak ada port forward yang cocok dengan filter.' : 'Belum ada port forward. Klik "Port Forward Baru" untuk menambahkan.'}</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(r => {
      const nas = r.nas || {};
      const server = nas.wireguard_peer?.server;
      const publicHost = server?.endpoint_host || '—';
      return `
      <tr>
        <td>${nas.site_name ? `<span class="badge badge-gray">${esc(nas.site_name)}</span>` : '<span style="color:var(--faint)">—</span>'}</td>
        <td><b>${esc(nas.name || '—')}</b></td>
        <td class="mono">${esc(publicHost)}:<b>${r.public_port}</b></td>
        <td style="text-align:center"><span class="arrow-sep">&rarr;</span></td>
        <td class="mono">${esc(nas.nas_ip_address || '—')}:<b>${r.target_port}</b></td>
        <td><span class="badge badge-blue">${esc((r.protocol || 'tcp').toUpperCase())}</span></td>
        <td>${esc(r.description) || '<span style="color:var(--faint)">—</span>'}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn danger" title="Hapus" onclick="PortForwardingPage.deleteForward(${nas.id}, ${r.id})">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  },

  // ── CREATE ───────────────────────────────────────────────────────
  openCreateModal() {
    const sel = document.getElementById('pfNasSelect');
    if (!this.nasOptions.length) {
      sel.innerHTML = '<option value="">Belum ada NAS mode WireGuard</option>';
    } else {
      sel.innerHTML = this.nasOptions.map(n =>
        `<option value="${n.id}">${n.site_name ? esc(n.site_name) + ' — ' : ''}${esc(n.name)} (${esc(n.nas_ip_address)})</option>`
      ).join('');
    }
    document.getElementById('pfPublicPort').value = '';
    document.getElementById('pfTargetPort').value = '';
    document.getElementById('pfProtocol').value = 'tcp';
    document.getElementById('pfDescription').value = '';
    openModal('pfModal');
  },

  async saveForward() {
    const nasId = document.getElementById('pfNasSelect').value;
    if (!nasId) return App.showToast('Pilih NAS terlebih dahulu (mode WireGuard)', 'error');
    const body = {
      public_port: document.getElementById('pfPublicPort').value.trim(),
      target_port: document.getElementById('pfTargetPort').value.trim(),
      protocol: document.getElementById('pfProtocol').value,
      description: document.getElementById('pfDescription').value.trim(),
    };
    if (!body.public_port || !body.target_port) return App.showToast('Port publik dan port target wajib diisi', 'error');

    const data = await App.api(`/radius/nas/${nasId}/port-forwards`, { method: 'POST', body: JSON.stringify(body) });
    App.showToast(data?.message || (data?.success ? 'Port forward dibuat' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) { closeModal('pfModal'); this.loadForwards(); }
  },

  // ── DELETE ───────────────────────────────────────────────────────
  async deleteForward(nasId, id) {
    if (!confirm('Hapus port forward ini?')) return;
    const data = await App.api(`/radius/nas/${nasId}/port-forwards/${id}`, { method: 'DELETE' });
    App.showToast(data?.message || (data?.success ? 'Dihapus' : 'Gagal'), data?.success ? 'success' : 'error');
    if (data?.success) this.loadForwards();
  },
};

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.addEventListener('DOMContentLoaded', () => { App.init(); PortForwardingPage.init(); });
