// ippool.js — IP Pool Usage (redesigned)

// Helper: append ?device_id=N kalau ada selector aktif (window.MikrotikSelector)
function _withDev(url) {
  return (window.MikrotikSelector && window.MikrotikSelector.withDevice)
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

const IPPoolPage = {
  pools: [],
  allUsed: [],

  async init() {
    // Init MikroTik selector — reload data saat user ganti device
    if (window.MikrotikSelector) {
      window.MikrotikSelector.init({
        selectId: 'mikrotikSelector',
        onChange: () => { this.load(); }
      });
    }
    this.bindEvents();
    await this.load();
  },

  async load() {
    const data = await App.api(_withDev('/mikrotik/ippool'));
    if (data?.success) {
      this.pools = data.data;
      this.renderPoolCards();
      this.populateFilter();
      this.allUsed = [];
      this.pools.forEach(p => { if (p.usedIPs) this.allUsed.push(...p.usedIPs); });
      this.renderUsedTable();
      this.updateStats();
    } else {
      document.getElementById('poolGrid').innerHTML =
        `<div class="tbl-empty" style="grid-column:1/-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>
          <p style="color:#dc2626">${data?.message || 'Gagal memuat IP pool'}</p>
        </div>`;
    }
  },

  updateStats() {
    const totalUsed = this.pools.reduce((s, p) => s + (p.usedCount || 0), 0);
    const totalFree = this.pools.reduce((s, p) => s + (p.freeCount || 0), 0);
    const totalAll  = totalUsed + totalFree;
    const util      = totalAll > 0 ? Math.round((totalUsed / totalAll) * 100) : 0;

    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('statPools', this.pools.length);
    s('statUsed',  totalUsed);
    s('statFree',  totalFree);
    s('statUtil',  util + '%');
    s('poolCount', this.pools.length + ' pool');
  },

  renderPoolCards() {
    const grid = document.getElementById('poolGrid');
    if (!this.pools.length) {
      grid.innerHTML = `<div class="tbl-empty" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>
        <p>Tidak ada IP pool ditemukan</p>
      </div>`;
      return;
    }

    grid.innerHTML = this.pools.map(p => {
      const pct    = p.usedPercent || 0;
      const cls    = pct < 70 ? 'low' : pct < 90 ? 'med' : 'high';
      const pctCls = pct < 70 ? 'pct-low' : pct < 90 ? 'pct-med' : 'pct-high';

      const ipsHtml = p.usedIPs?.length ? `
        <button class="pool-toggle" onclick="IPPoolPage.toggleIPs(this)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6,9 12,15 18,9"/></svg>
          Lihat ${p.usedCount} IP terpakai
        </button>
        <div class="pool-ips">
          <div class="ip-chips">
            ${p.usedIPs.slice(0, 50).map(u => `
              <div class="ip-chip">
                ${esc(u.address)}
                ${u.owner ? `<span class="ip-chip-owner">${esc(u.owner)}</span>` : ''}
              </div>`).join('')}
            ${p.usedIPs.length > 50 ? `<div class="ip-chip" style="color:var(--faint)">+${p.usedIPs.length - 50} lainnya</div>` : ''}
          </div>
        </div>` : '';

      return `
        <div class="pool-card">
          <div class="pool-card-top">
            <div>
              <div class="pool-name">${esc(p.name)}</div>
              <div class="pool-range">${esc(p.ranges)}</div>
              ${p.comment ? `<div style="font-size:11px;color:var(--faint);margin-top:3px">${esc(p.comment)}</div>` : ''}
            </div>
            <span class="pool-pct ${pctCls}">${pct}%</span>
          </div>
          <div class="usage-bar"><div class="usage-fill fill-${cls}" style="width:${pct}%"></div></div>
          <div class="pool-nums">
            <div class="pool-num-item">
              <span class="pool-dot" style="background:#dc2626"></span>
              <span style="color:#dc2626;font-weight:700">${p.usedCount}</span>
              <span style="color:var(--faint);font-weight:400">terpakai</span>
            </div>
            <div class="pool-num-item">
              <span class="pool-dot" style="background:#16a34a"></span>
              <span style="color:#16a34a;font-weight:700">${p.freeCount}</span>
              <span style="color:var(--faint);font-weight:400">tersedia</span>
            </div>
            <div class="pool-num-item">
              <span class="pool-dot" style="background:#94a3b8"></span>
              <span style="font-weight:700">${p.totalIPs}</span>
              <span style="color:var(--faint);font-weight:400">total</span>
            </div>
          </div>
          ${ipsHtml}
        </div>`;
    }).join('');
  },

  populateFilter() {
    const sel = document.getElementById('filterPool');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All Pools</option>' +
      this.pools.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    sel.value = cur;
  },

  renderUsedTable() {
    const search = document.getElementById('searchUsed').value.toLowerCase();
    const pool   = document.getElementById('filterPool').value;
    let rows = this.allUsed;
    if (pool)   rows = rows.filter(r => r.pool === pool);
    if (search) rows = rows.filter(r => r.address?.includes(search) || r.owner?.toLowerCase().includes(search));

    document.getElementById('usedCount').textContent = `${rows.length} IP`;

    const tbody = document.getElementById('usedTbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5">
        <div class="tbl-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
          <p>Tidak ada IP terpakai</p>
        </div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td class="num-cell">${i + 1}</td>
        <td><span class="ip-badge">${esc(r.address)}</span></td>
        <td><span class="pool-badge">${esc(r.pool)}</span></td>
        <td class="owner-cell">${esc(r.owner) || '—'}</td>
        <td class="info-cell">${esc(r.info) || '—'}</td>
      </tr>`).join('');
  },

  toggleIPs(btn) {
    const panel = btn.nextElementSibling;
    panel.classList.toggle('open');
    const isOpen = panel.classList.contains('open');
    const svg = btn.querySelector('svg');
    if (svg) svg.style.transform = isOpen ? 'rotate(180deg)' : '';
    btn.childNodes[1].textContent = isOpen
      ? btn.textContent.replace('Lihat', 'Sembunyikan')
      : btn.textContent.replace('Sembunyikan', 'Lihat');
  },

  bindEvents() {
    document.getElementById('btnRefresh').addEventListener('click', () => this.load());
    document.getElementById('searchUsed').addEventListener('input', () => this.renderUsedTable());
    document.getElementById('filterPool').addEventListener('change', () => this.renderUsedTable());
  }
};

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
document.addEventListener('DOMContentLoaded', () => { App.init(); IPPoolPage.init(); });