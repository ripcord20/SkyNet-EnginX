// firewall.js — Firewall Rules Monitor (redesigned)

// Helper: append ?device_id=N kalau ada selector aktif (window.MikrotikSelector)
function _withDev(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

const FirewallPage = {
  filterRules: [],
  natRules: [],
  activeTab: 'filter',

  async init() {
    // Init MikroTik selector — reload data saat user ganti device
    if (window.MikrotikSelector) {
      window.MikrotikSelector.init({
        selectId: 'mikrotikSelector',
        onChange: () => { (async () => { await this.loadStats(); await this.loadFilter(); })(); }
      });
    }
    this.bindEvents();
    await this.loadStats();
    await this.loadFilter();
  },

  async loadStats() {
    const data = await App.api(_withDev('/mikrotik/firewall/stats'));
    if (data?.success) {
      const d = data.data;
      document.getElementById('sfTotal').textContent    = d.filter.total;
      document.getElementById('sfActive').textContent   = d.filter.active;
      document.getElementById('sfDisabled').textContent = d.filter.disabled;
      document.getElementById('sfNat').textContent      = d.nat.total;
    }
  },

  async loadFilter() {
    const search = document.getElementById('filterSearch').value;
    const chain  = document.getElementById('filterChain').value;
    const action = document.getElementById('filterAction').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (chain)  params.set('chain', chain);
    if (action) params.set('action', action);

    const data = await App.api(_withDev(`/mikrotik/firewall/filter?${params}`));
    if (data?.success) {
      this.filterRules = data.data;
      this.renderFilter();
    }
  },

  async loadNat() {
    const data = await App.api(_withDev('/mikrotik/firewall/nat'));
    if (data?.success) {
      this.natRules = data.data;
      this.renderNat();
    }
  },

  // Map chain string to CSS class
  chainClass(chain) {
    const map = { input:'chain-input', forward:'chain-forward', output:'chain-output', srcnat:'chain-srcnat', dstnat:'chain-dstnat' };
    return map[chain?.toLowerCase()] || 'chain-other';
  },

  // Map action string to CSS class
  actionClass(action) {
    const a = (action||'').toLowerCase().replace('-','').replace(' ','-');
    const map = { accept:'act-accept', drop:'act-drop', reject:'act-reject', masquerade:'act-masquerade', dstnat:'act-dst-nat', srcnat:'act-src-nat', 'dst-nat':'act-dst-nat', 'src-nat':'act-src-nat' };
    return map[a] || 'act-other';
  },

  renderFilter() {
    const tbody = document.getElementById('filterTbody');
    document.getElementById('filterCount').textContent = `${this.filterRules.length} rule`;

    if (!this.filterRules.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <p>Tidak ada rule ditemukan</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = this.filterRules.map(r => {
      const srcHtml = r.srcAddress
        ? `<span class="mono-cell">${esc(r.srcAddress)}</span>`
        : `<span class="mono-any">any</span>`;
      const dstHtml = r.dstAddress
        ? `<span class="mono-cell">${esc(r.dstAddress)}</span>`
        : `<span class="mono-any">any</span>`;

      return `<tr class="${r.disabled ? 'rule-disabled' : ''}">
        <td class="num-cell">${r.order}</td>
        <td><span class="chain-badge ${this.chainClass(r.chain)}">${esc(r.chain)}</span></td>
        <td><span class="action-badge ${this.actionClass(r.action)}">${esc(r.action)}</span></td>
        <td class="mono-cell">${esc(r.protocol) || '<span class="mono-any">any</span>'}</td>
        <td>
          <div style="display:flex;align-items:center;gap:4px;font-size:12px;">
            ${srcHtml}
            <span style="color:var(--faint)">→</span>
            ${dstHtml}
          </div>
          ${r.inInterface ? `<div style="font-size:10.5px;color:var(--faint);margin-top:2px">in: ${esc(r.inInterface)}</div>` : ''}
        </td>
        <td class="mono-cell">${esc(r.dstPort) || '<span class="mono-any">—</span>'}</td>
        <td class="comment-cell" title="${esc(r.comment)}">${esc(r.comment) || '<span style="color:var(--faint)">—</span>'}</td>
        <td class="hits-cell">
          <div class="hits-val">${fmtBytes(r.bytes)}</div>
          <div>${(r.packets||0).toLocaleString()} pkt</div>
        </td>
        <td>
          <button class="toggle-btn ${r.disabled ? 'toggle-enable' : 'toggle-disable'}"
            onclick="FirewallPage.toggleRule('filter','${r.id}',${!r.disabled})">
            ${r.disabled ? '▶ Enable' : '⏸ Disable'}
          </button>
        </td>
      </tr>`;
    }).join('');
  },

  renderNat() {
    const tbody = document.getElementById('natTbody');
    document.getElementById('natCount').textContent = `${this.natRules.length} rule`;

    if (!this.natRules.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="tbl-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16,3 21,3 21,8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>
        <p>Tidak ada NAT rule</p>
      </div></td></tr>`;
      return;
    }

    tbody.innerHTML = this.natRules.map(r => `
      <tr class="${r.disabled ? 'rule-disabled' : ''}">
        <td class="num-cell">${r.order}</td>
        <td><span class="chain-badge ${this.chainClass(r.chain)}">${esc(r.chain)}</span></td>
        <td><span class="action-badge ${this.actionClass(r.action)}">${esc(r.action)}</span></td>
        <td class="mono-cell">${esc(r.srcAddress) || '<span class="mono-any">any</span>'}</td>
        <td class="mono-cell">${esc(r.dstAddress) || '<span class="mono-any">any</span>'}</td>
        <td class="mono-cell">${esc(r.toAddresses) || '<span class="mono-any">—</span>'}</td>
        <td class="mono-cell">${esc(r.toPorts) || '<span class="mono-any">—</span>'}</td>
        <td class="comment-cell" title="${esc(r.comment)}">${esc(r.comment) || '<span style="color:var(--faint)">—</span>'}</td>
        <td class="hits-cell">
          <div class="hits-val">${fmtBytes(r.bytes)}</div>
          <div>${(r.packets||0).toLocaleString()} pkt</div>
        </td>
      </tr>`).join('');
  },

  async toggleRule(chain, id, disable) {
    const res = await App.api(_withDev('/mikrotik/firewall/toggle'), {
      method: 'POST',
      body: JSON.stringify({ chain, id, disable })
    });
    if (res?.success) {
      await this.loadStats();
      await this.loadFilter();
    } else {
      alert(res?.message || 'Gagal toggle rule');
    }
  },

  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.fw-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('tabFilter').style.display = tab === 'filter' ? '' : 'none';
    document.getElementById('tabNat').style.display    = tab === 'nat'    ? '' : 'none';
    if (tab === 'nat' && !this.natRules.length) this.loadNat();
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', async () => {
      await this.loadStats();
      if (this.activeTab === 'filter') await this.loadFilter();
      else { this.natRules = []; await this.loadNat(); }
    });
    document.getElementById('filterSearch').addEventListener('input', () => this.loadFilter());
    document.getElementById('filterChain').addEventListener('change', () => this.loadFilter());
    document.getElementById('filterAction').addEventListener('change', () => this.loadFilter());
    document.querySelectorAll('.fw-tab').forEach(t => {
      t.addEventListener('click', () => this.switchTab(t.dataset.tab));
    });
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

document.addEventListener('DOMContentLoaded', () => { App.init(); FirewallPage.init(); });
