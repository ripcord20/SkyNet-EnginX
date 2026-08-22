// ============================================================
// FLAYNET — Shared MikroTik Selector
// ============================================================
// Dropdown selector MikroTik yang konsisten antar halaman
// (Dashboard, PPPoE, Queue, IP Pool, Firewall, Traffic, Resource).
//
// Cara pakai di view:
//   1. Letakkan placeholder: <div id="mtSelectorMount"></div>
//   2. Sertakan script ini SEBELUM script halaman: <script src="/js/mikrotik-selector.js"></script>
//   3. Di script halaman, panggil:
//        window.MikrotikSelector.init({ onChange: () => reloadPageData() });
//   4. Untuk request API: window.MikrotikSelector.withDevice('/mikrotik/pppoe/active')
//        → menambahkan ?device_id=N otomatis
//
// localStorage key dipakai bersama: 'flaynet:dashboard:mikrotik_id'
// ============================================================

(function () {
  const STORAGE_KEY = 'flaynet:dashboard:mikrotik_id';

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_) { return ''; }
  }

  function setStored(id) {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else    localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Append ?device_id=N ke URL kalau ada device terpilih
  function withDevice(url) {
    const id = getStored();
    if (!id) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'device_id=' + encodeURIComponent(id);
  }

  function getSelectedId() {
    return getStored();
  }

  // Render selector ke dalam container (atau ke <select id="mikrotikSelector"> kalau sudah ada)
  async function init(opts = {}) {
    const {
      mountId  = 'mtSelectorMount',  // id div pembungkus
      selectId = 'mikrotikSelector', // id select kalau sudah ada di view
      onChange = () => {},
      onReady  = () => {},
      title    = 'Pilih MikroTik untuk monitoring'
    } = opts;

    // 1) Pakai existing <select> kalau ada (kasus dashboard.ejs lama)
    let sel = document.getElementById(selectId);
    let mount = document.getElementById(mountId);

    // 2) Kalau tidak ada select tapi ada mount div, render markup-nya
    if (!sel && mount) {
      mount.innerHTML = `
        <div class="mt-selector-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.6;">
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
            <line x1="6" y1="6" x2="6.01" y2="6"></line>
            <line x1="6" y1="18" x2="6.01" y2="18"></line>
          </svg>
          <select id="${selectId}" class="mt-selector" title="${escHtml(title)}">
            <option value="">Loading…</option>
          </select>
        </div>
      `;
      injectStyles();
      sel = document.getElementById(selectId);
    }

    if (!sel) {
      console.warn('[MikrotikSelector] No <select> or mount div found');
      return;
    }

    try {
      const data = await fetchList();
      if (!data?.success || !Array.isArray(data.data) || !data.data.length) {
        sel.innerHTML = '<option value="">Belum ada MikroTik terdaftar</option>';
        sel.disabled = true;
        onReady({ list: [], activeId: null });
        return;
      }

      const list = data.data;
      const ids  = list.map(d => String(d.id));
      const stored = getStored();
      let activeId = (stored && ids.includes(stored))
        ? stored
        : String(list.find(d => d.is_primary)?.id ?? list[0].id);
      setStored(activeId);

      sel.innerHTML = list.map(d => {
        const dot  = d.status === 'online' ? '' : (d.status === 'warning' ? '' : '');
        const star = d.is_primary ? ' ★' : '';
        return `<option value="${d.id}" ${String(d.id) === activeId ? 'selected' : ''}>${dot} ${escHtml(d.name)}${star}</option>`;
      }).join('');
      sel.disabled = false;

      sel.addEventListener('change', () => {
        setStored(sel.value);
        try { onChange(sel.value); } catch (e) { console.error('[MikrotikSelector] onChange error:', e); }
      });

      onReady({ list, activeId });
    } catch (err) {
      console.error('[MikrotikSelector] init failed:', err);
      sel.innerHTML = `<option value="">Error: ${escHtml(err.message || 'load failed')}</option>`;
      sel.disabled = true;
    }
  }

  // Fetch list device dari API. Kompatibel dengan/atau tanpa App.api global.
  async function fetchList() {
    if (typeof App !== 'undefined' && typeof App.api === 'function') {
      const r = await App.api('/devices/mikrotik-list');
      return r;
    }
    // Fallback: fetch langsung
    const token = (typeof localStorage !== 'undefined') ? localStorage.getItem('token') : '';
    const headers = { 'Accept': 'application/json' };
    if (token && token !== 'null') headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/devices/mikrotik-list', { headers, credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function injectStyles() {
    if (document.getElementById('mt-selector-styles')) return;
    const css = document.createElement('style');
    css.id = 'mt-selector-styles';
    css.textContent = `
      .mt-selector-wrap {
        display:flex; align-items:center; gap:8px;
        background:#fff; border:1px solid #e2e8f0; border-radius:8px;
        padding:6px 12px; min-width:200px;
        transition: border-color .15s, box-shadow .15s;
      }
      .mt-selector-wrap:hover { border-color:#1e3a8a; }
      .mt-selector-wrap:focus-within { border-color:#1d4ed8; box-shadow:0 0 0 3px rgba(29,78,216,.12); }
      .mt-selector {
        border:none; outline:none; background:transparent;
        font-family: inherit; font-size:13px; font-weight:500; color:#1e293b;
        min-width:160px; cursor:pointer;
      }
      .mt-selector:disabled { color:#94a3b8; cursor:not-allowed; }
      @media (max-width: 640px) {
        .mt-selector-wrap { min-width:140px; padding:5px 10px; }
        .mt-selector { min-width:110px; font-size:12px; }
      }
    `;
    document.head.appendChild(css);
  }

  // Public API
  window.MikrotikSelector = {
    init,
    withDevice,
    getSelectedId,
    setSelectedId: setStored,
    STORAGE_KEY
  };
})();
