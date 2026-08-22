// ============================================
// ISP NetOps - Main Application JS (continued)
// ============================================

const App = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  socket: null,

  init() {
    this.setDate();
    this.initSidebar();
    this.initNotifications();
    this.initLogout();
    this.initSocket();
    this.initSearch();
  },

  async api(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };
    // Hanya tambah Authorization header jika token valid (bukan null/undefined)
    if (this.token && this.token !== 'null') {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (options.headers) Object.assign(headers, options.headers);
    const config = { ...options, headers, credentials: 'include' };
    try {
      const res = await fetch(`/api${url}`, config);
      if (res.status === 401) {
        const refreshed = await this.refreshToken();
        if (!refreshed) { window.location.href = '/login'; return null; }
        config.headers.Authorization = `Bearer ${this.token}`;
        return (await fetch(`/api${url}`, config)).json();
      }
      return res.json();
    } catch (err) { console.error('API Error:', err); return { success: false, message: 'Network error' }; }
  },

  async refreshToken() {
    try {
      const rt = localStorage.getItem('refreshToken');
      if (!rt) return false;
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      const data = await res.json();
      if (data.success) { this.token = data.data.token; localStorage.setItem('token', data.data.token); return true; }
      return false;
    } catch { return false; }
  },

  setDate() {
    const el = document.getElementById('currentDate');
    if (el) {
      const now = new Date();
      const dateStr = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      el.textContent = '\u203A ' + dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    }
  },

  initSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    // Buat backdrop element sekali
    let backdrop = document.getElementById('sidebarBackdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'sidebarBackdrop';
      backdrop.className = 'sidebar-backdrop';
      document.body.appendChild(backdrop);
    }

    const openSidebar = () => {
      sidebar.classList.add('open');
      backdrop.classList.add('show');
    };
    const closeSidebar = () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('show');
    };
    // Ekspos global agar SEMUA pemicu memakai logika sama (sinkron backdrop).
    // Tombol hamburger memakai onclick="toggleSidebar()" inline (didefinisikan di
    // topbar) supaya tetap berfungsi di halaman yang tidak memuat app.js.
    // Karena itu, app.js TIDAK lagi mengikat listener klik ke #sidebarToggle
    // (mencegah double-fire: buka lalu langsung tertutup).
    window.openSidebar = openSidebar;
    window.closeSidebar = closeSidebar;

    // Klik backdrop → tutup
    backdrop.addEventListener('click', closeSidebar);

    // Klik link nav di mobile → tutup sidebar otomatis
    // PENTING: kecualikan tombol .nav-group-toggle (Billing & Invoice, dll) — itu untuk
    // expand/collapse submenu, bukan navigasi. Kalau ikut di-close, dropdown tidak pernah
    // sempat terlihat karena sidebar langsung tertutup.
    sidebar.querySelectorAll('.nav-item').forEach(link => {
      if (link.classList.contains('nav-group-toggle')) return;
      link.addEventListener('click', () => {
        if (window.innerWidth < 768) closeSidebar();
      });
    });
  },

  initNotifications() {
    const btn = document.getElementById('notificationBtn');
    const dropdown = document.getElementById('notifDropdown');
    const markAll = document.getElementById('markAllRead');
    if (btn && dropdown) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); const shown = dropdown.style.display !== 'none' && dropdown.style.display !== ''; dropdown.style.display = shown ? 'none' : 'block'; if (!shown) this.loadNotifications(); });
      document.addEventListener('click', () => { dropdown.style.display = 'none'; });
      dropdown.addEventListener('click', (e) => e.stopPropagation());
    }
    if (markAll) { markAll.addEventListener('click', async () => { await this.api('/notifications/read-all', { method: 'PUT' }); this.updateNotifBadge(); this.loadNotifications(); }); }
    this.updateNotifBadge();
  },

  async updateNotifBadge() {
    const data = await this.api('/notifications/unread-count');
    const count = (data && data.success && data.data) ? (data.data.count || 0) : 0;
    const badge = document.getElementById('notifCountBadge');
    if (badge) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
    const dot = document.getElementById('notifDot');
    if (dot) dot.style.display = count > 0 ? 'block' : 'none';
  },

  async loadNotifications() {
    const list = document.getElementById('notifList');
    if (!list) return;
    const data = await this.api('/notifications?limit=10');
    if (!data || !data.success || !data.data.length) {
      list.innerHTML = '<p class="notif-empty">No notifications</p>';
      return;
    }
    list.innerHTML = data.data.map(n => `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" style="padding:12px 16px;border-bottom:1px solid #f1f5f9;cursor:pointer;${n.is_read ? '' : 'background:#f8fafc;'}">
        <div style="display:flex;gap:8px;align-items:start;">
          <div style="width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0;background:${n.severity === 'critical' ? '#ef4444' : n.severity === 'warning' ? '#f59e0b' : '#3b82f6'};"></div>
          <div>
            <div style="font-size:13px;font-weight:${n.is_read ? '400' : '600'};color:#1e293b;">${n.title}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px;">${n.message}</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:4px;">${this.timeAgo(n.created_at)}</div>
          </div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.notif-item').forEach(item => {
      item.addEventListener('click', async () => {
        await this.api(`/notifications/${item.dataset.id}/read`, { method: 'PUT' });
        item.style.background = '';
        this.updateNotifBadge();
      });
    });
  },

  timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  },

  initLogout() {
    const btn = document.getElementById('logoutBtn');
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        // Defensive logout flow — pastikan SELALU berhasil meski API call
        // gagal atau timeout. Urutan operasi:
        //   1. Clear localStorage IMMEDIATELY supaya client-side state pasti
        //      bersih, no matter what happens berikutnya.
        //   2. Panggil POST /auth/logout untuk clear cookie HttpOnly server-side
        //      + invalidate refresh_token di DB. Pakai timeout 3 detik supaya
        //      kalau server lambat, user tidak stuck di tombol logout.
        //   3. Redirect ke /login (window.location.replace supaya entry di
        //      history browser di-replace, bukan di-push — tombol back tidak
        //      kembali ke dashboard yang sudah logged-out).
        //
        // Cookie HttpOnly TIDAK bisa di-hapus dari JS — wajib via server.
        // Kalau step 2 gagal, browser masih punya cookie tapi server-side
        // /login akan validate token saat next request → kalau token JWT
        // masih valid, akan redirect balik ke dashboard. Untuk handle case
        // ini, kita kirim header X-Force-Logout supaya server di sisi
        // /login route bisa skip auto-redirect kalau request berasal dari
        // logout flow yang baru saja gagal (TIDAK diimplementasi — sebagai
        // gantinya kita rely pada cookie ter-clear oleh server normal-case).
        try {
          localStorage.removeItem('token');
          localStorage.removeItem('refreshToken');
          localStorage.removeItem('user');
          this.token = null; // reset memory state juga
        } catch (_) { /* localStorage disabled — ignore */ }

        // Panggil server logout, tapi jangan tunggu lama. AbortController
        // untuk cancel kalau timeout.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            signal: controller.signal
          });
        } catch (_) {
          // Network error / timeout — abaikan, lanjut redirect.
          // Cookie mungkin tidak ter-clear di server, tapi paling tidak
          // localStorage sudah bersih dan user akan di-redirect ke login.
        }
        clearTimeout(timer);

        // Replace, bukan href, supaya tombol "Back" browser tidak balik
        // ke halaman dashboard yang sudah logged-out (UX yang konfusing).
        window.location.replace('/login');
      });
    }
  },

  initSocket() {
    if (typeof io === 'undefined') return;
    if (this.socket) return; // cegah koneksi ganda
    try {
      this.socket = io({ auth: { token: this.token } });
      this.socket.on('connect', () => console.log('Socket connected'));
      this.socket.on('notification:new', (data) => {
        // Satu-satunya handler notifikasi real-time (hindari toast dobel).
        if (typeof window.updateNotifCount === 'function') window.updateNotifCount();
        else this.updateNotifBadge();
        if (typeof window._notifOpen !== 'undefined' && window._notifOpen && typeof window.loadNotifPanel === 'function') {
          window.loadNotifPanel();
        } else {
          this.showToast((data && data.title) || 'Notifikasi baru', (data && data.severity) || 'info');
        }
      });
      this.socket.on('disconnect', () => console.log('Socket disconnected'));
    } catch (e) { console.warn('Socket init failed:', e); }
  },

  initSearch() {
    const input = document.getElementById('globalSearch');
    if (!input) return;
    let timeout;
    input.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const q = input.value.trim();
        if (q.length >= 2) console.log('Search:', q);
      }, 400);
    });
  },

  showToast(message, type = 'info') {
    const msg = String(message == null ? '' : message);

    // Dedupe: notif identik dalam 5 detik diabaikan (cegah banjir toast).
    this._toastSeen = this._toastSeen || {};
    const key = type + '|' + msg;
    const now = Date.now();
    if (this._toastSeen[key] && (now - this._toastSeen[key]) < 5000) return;
    this._toastSeen[key] = now;

    // Container yang menumpuk rapi (stack) di kanan atas.
    let stack = document.getElementById('toastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toastStack';
      stack.style.cssText = 'position:fixed;top:76px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:380px;';
      document.body.appendChild(stack);
    }

    // Batasi maksimal 4 toast tampil sekaligus — yang terlama dibuang.
    while (stack.children.length >= 4) stack.removeChild(stack.firstChild);

    const conf = {
      info:     { c:'#2563eb', bg:'#eff6ff', icon:'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
      success:  { c:'#16a34a', bg:'#f0fdf4', icon:'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
      warning:  { c:'#d97706', bg:'#fffbeb', icon:'M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z' },
      error:    { c:'#dc2626', bg:'#fef2f2', icon:'M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z' },
      critical: { c:'#dc2626', bg:'#fef2f2', icon:'M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z' }
    };
    const cf = conf[type] || conf.info;

    const toast = document.createElement('div');
    toast.style.cssText = 'pointer-events:auto;display:flex;align-items:flex-start;gap:11px;background:#fff;border:1px solid #eef2f9;padding:13px 15px;border-radius:14px;box-shadow:0 12px 32px rgba(13,27,62,.16);font-size:13px;font-family:inherit;color:#0f172a;animation:toastIn .28s cubic-bezier(.2,.9,.3,1.2);transition:opacity .25s,transform .25s;';
    toast.innerHTML =
      '<span style="flex-shrink:0;width:30px;height:30px;border-radius:9px;background:' + cf.bg + ';color:' + cf.c + ';display:flex;align-items:center;justify-content:center;">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="' + cf.icon + '"/></svg>' +
      '</span>' +
      '<span style="flex:1;line-height:1.45;font-weight:500;padding-top:4px;">' + msg.replace(/</g, '&lt;') + '</span>';

    stack.appendChild(toast);
    const remove = () => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; setTimeout(() => toast.remove(), 260); };
    toast.addEventListener('click', remove);
    setTimeout(remove, 4000);
  },

  formatBps(bps) {
    if (!bps || bps === 0) return '0 bps';
    const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    const i = Math.floor(Math.log(Math.abs(bps)) / Math.log(1000));
    return (bps / Math.pow(1000, Math.max(0, i))).toFixed(1) + ' ' + (units[i] || 'bps');
  },

  formatCurrency(amount) {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount || 0);
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());

// Add toast animation
const style = document.createElement('style');
style.textContent = '@keyframes toastIn{from{transform:translateX(30px);opacity:0}to{transform:translateX(0);opacity:1}}';
document.head.appendChild(style);