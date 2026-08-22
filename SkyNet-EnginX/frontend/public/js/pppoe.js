// pppoe.js — PPPoE Session Monitor (redesigned, multi-device aware)
//
// Helper: append ?device_id=N kalau ada selector aktif (window.MikrotikSelector)
function _withDev(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

const PPPoEPage = {
  sessions: [],
  timer: null,

  async init() {
    // Init MikroTik selector kalau ada placeholder di view
    if (window.MikrotikSelector) {
      window.MikrotikSelector.init({
        selectId: 'mikrotikSelector',
        onChange: () => this.load()
      });
    }
    this.bindEvents();
    await this.load();
    this.timer = setInterval(() => this.load(), 10000);
  },

  async load() {
    const search  = document.getElementById('searchInput').value;
    const service = document.getElementById('filterService').value;
    const params  = new URLSearchParams();
    if (search)  params.set('search', search);
    if (service) params.set('service', service);

    const data = await App.api(_withDev(`/mikrotik/pppoe/active?${params}`));
    if (data?.success) {
      this.sessions = data.data;
      this.renderTable();
      this.updateStats();
    } else {
      document.getElementById('pppoeTbody').innerHTML = `
        <tr><td colspan="7">
          <div class="tbl-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <p style="color:#dc2626">${data?.message || 'Gagal memuat sesi'}</p>
          </div>
        </td></tr>`;
    }
  },

  updateStats() {
    const total = this.sessions.length;
    const pppoe = this.sessions.filter(s => s.service === 'pppoe').length;
    const l2tp  = this.sessions.filter(s => s.service === 'l2tp').length;
    document.getElementById('statTotal').textContent  = total;
    document.getElementById('statPppoe').textContent  = pppoe;
    document.getElementById('statL2tp').textContent   = l2tp;
    document.getElementById('statOther').textContent  = total - pppoe - l2tp;
    (document.getElementById('sessionCount')||{textContent:''}).textContent = `${total} sesi`;
    // Sidebar badge
    const badge = document.getElementById('pppoe-count');
    if (badge) { badge.textContent = total; badge.style.display = total ? 'flex' : 'none'; }
  },

  renderTable() {
    const tbody = document.getElementById('pppoeTbody');
    if (!this.sessions.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="tbl-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
            <p>Tidak ada sesi aktif</p>
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = this.sessions.map((s, i) => {
      const svcClass = s.service === 'pppoe' ? 'svc-pppoe'
                     : s.service === 'l2tp'  ? 'svc-l2tp' : 'svc-other';
      return `
        <tr>
          <td class="num-cell">${i + 1}</td>
          <td class="username-cell">${esc(s.name)}</td>
          <td><span class="svc-badge ${svcClass}">${s.service.toUpperCase()}</span></td>
          <td><span class="ip-badge">${esc(s.address) || '—'}</span></td>
          <td class="mac-cell">${esc(s.callerID) || '—'}</td>
          <td>
            <span class="uptime-badge">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
              ${esc(s.uptime)}
            </span>
          </td>
          <td>
            <button class="btn btn-red btn-sm" onclick="PPPoEPage.disconnect('${s.id}','${esc(s.name)}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Disconnect
            </button>
          </td>
        </tr>`;
    }).join('');
  },

  async disconnect(id, name) {
    if (!confirm(`Disconnect sesi "${name}"?`)) return;
    const res = await App.api(_withDev(`/mikrotik/pppoe/disconnect/${id}`), { method:'POST' });
    if (res?.success) await this.load();
    else alert(res?.message || 'Gagal disconnect');
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => this.load());
    document.getElementById('searchInput').addEventListener('input', () => this.load());
    document.getElementById('filterService').addEventListener('change', () => this.load());
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.addEventListener('DOMContentLoaded', () => { App.init(); PPPoEPage.init(); });