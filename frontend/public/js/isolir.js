// isolir.js

// ════════════════════════════════════════════════════════════════════════
// DigsDialog — modal dialog kustom (replace alert/confirm browser default)
// Self-injecting CSS, standalone. API:
//   DigsDialog.alert({ type, title, message, log })           → Promise<void>
//   DigsDialog.confirm({ type, title, message, bullets, confirmText, cancelText }) → Promise<bool>
// Types: 'info' | 'success' | 'warning' | 'error'
// ════════════════════════════════════════════════════════════════════════
(function injectDigsDialog() {
  if (window.DigsDialog) return;

  // ── Inject CSS sekali ──
  const css = `
  .dd-ov{position:fixed;inset:0;background:rgba(13,27,62,.55);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:16px;opacity:0;pointer-events:none;transition:opacity .2s ease;}
  .dd-ov.open{opacity:1;pointer-events:auto;}
  .dd-box{background:#fff;border-radius:18px;width:460px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(13,27,62,.25),0 0 0 1px rgba(13,27,62,.05);overflow:hidden;transform:translateY(12px) scale(.96);transition:transform .25s cubic-bezier(.34,1.56,.64,1);font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif;}
  .dd-ov.open .dd-box{transform:translateY(0) scale(1);}

  .dd-head{padding:24px 24px 0;display:flex;flex-direction:column;align-items:center;text-align:center;}
  .dd-icon{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;position:relative;}
  .dd-icon svg{width:28px;height:28px;}
  .dd-icon::before{content:'';position:absolute;inset:-6px;border-radius:20px;opacity:.35;z-index:-1;}
  .dd-icon.info{background:linear-gradient(135deg,#dbeafe,#bfdbfe);color:#1d4ed8;}
  .dd-icon.info::before{background:#dbeafe;}
  .dd-icon.success{background:linear-gradient(135deg,#d1fae5,#a7f3d0);color:#047857;}
  .dd-icon.success::before{background:#d1fae5;}
  .dd-icon.warning{background:linear-gradient(135deg,#fef3c7,#fde68a);color:#b45309;}
  .dd-icon.warning::before{background:#fef3c7;}
  .dd-icon.error{background:linear-gradient(135deg,#fee2e2,#fecaca);color:#b91c1c;}
  .dd-icon.error::before{background:#fee2e2;}

  .dd-title{font-size:17px;font-weight:700;color:#0d1b3e;margin:0 0 6px;letter-spacing:-.2px;}
  .dd-msg{font-size:13.5px;color:#475569;line-height:1.6;margin:0 0 4px;max-width:100%;word-wrap:break-word;}
  .dd-msg strong{color:#0d1b3e;font-weight:600;}

  .dd-body{padding:14px 24px 0;overflow-y:auto;flex:1;min-height:0;}
  .dd-bullets{list-style:none;padding:0;margin:14px 0 4px;background:#f8faff;border:1px solid #e0e7f3;border-radius:12px;overflow:hidden;}
  .dd-bullets li{padding:10px 14px 10px 38px;font-size:12.5px;color:#334155;line-height:1.5;border-bottom:1px solid #eef2f9;position:relative;}
  .dd-bullets li:last-child{border-bottom:none;}
  .dd-bullets li::before{content:'';position:absolute;left:14px;top:14px;width:14px;height:14px;border-radius:50%;background:#fff;border:1.5px solid #cbd5e1;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='none' stroke='%2364748b' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' d='M3.5 8.5l3 3 6-7'/></svg>");background-size:11px;background-position:center;background-repeat:no-repeat;}

  .dd-log{margin-top:14px;background:#0f172a;color:#cbd5e1;border-radius:10px;padding:12px 14px;font-family:'DM Mono',ui-monospace,monospace;font-size:11px;line-height:1.65;max-height:180px;overflow-y:auto;}
  .dd-log-toggle{margin-top:10px;cursor:pointer;font-size:11.5px;font-weight:600;color:#64748b;display:flex;align-items:center;gap:6px;user-select:none;padding:8px 0;}
  .dd-log-toggle:hover{color:#0d1b3e;}
  .dd-log-toggle svg{width:12px;height:12px;transition:transform .2s;}
  .dd-log-toggle.open svg{transform:rotate(90deg);}
  .dd-log-wrap{display:none;}
  .dd-log-wrap.open{display:block;}
  .dd-log-line{display:block;padding:1px 0;white-space:pre-wrap;word-break:break-word;}
  .dd-log-line.ok{color:#86efac;}
  .dd-log-line.warn{color:#fcd34d;}
  .dd-log-line.err{color:#fca5a5;}

  .dd-ft{padding:18px 24px 22px;display:flex;gap:8px;justify-content:flex-end;}
  .dd-btn{padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;border:none;letter-spacing:.1px;transition:transform .1s,box-shadow .15s,filter .15s;-webkit-tap-highlight-color:transparent;}
  .dd-btn:active{transform:scale(.97);}
  .dd-btn-ghost{background:#f4f8ff;color:#0d1b3e;border:1.5px solid #e0e7f3;}
  .dd-btn-ghost:hover{background:#eef2f9;}
  .dd-btn-primary{background:linear-gradient(135deg,#1a6ef5,#0047cc);color:#fff;box-shadow:0 2px 8px rgba(26,110,245,.25);}
  .dd-btn-primary:hover{box-shadow:0 4px 14px rgba(26,110,245,.4);}
  .dd-btn-success{background:linear-gradient(135deg,#10b981,#059669);color:#fff;box-shadow:0 2px 8px rgba(16,185,129,.25);}
  .dd-btn-success:hover{box-shadow:0 4px 14px rgba(16,185,129,.4);}
  .dd-btn-warning{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;box-shadow:0 2px 8px rgba(245,158,11,.25);}
  .dd-btn-warning:hover{box-shadow:0 4px 14px rgba(245,158,11,.4);}
  .dd-btn-danger{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;box-shadow:0 2px 8px rgba(239,68,68,.25);}
  .dd-btn-danger:hover{box-shadow:0 4px 14px rgba(239,68,68,.4);}

  @media(max-width:480px){
    .dd-box{border-radius:14px;}
    .dd-head{padding:20px 18px 0;}
    .dd-body{padding:12px 18px 0;}
    .dd-ft{padding:16px 18px 18px;flex-direction:column-reverse;}
    .dd-btn{width:100%;padding:12px 16px;}
    .dd-title{font-size:16px;}
  }
  `;
  const style = document.createElement('style');
  style.id = 'digs-dialog-styles';
  style.textContent = css;
  document.head.appendChild(style);

  // ── Icon SVG per type ──
  const ICONS = {
    info: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    success: '<svg fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
    warning: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>',
    error: '<svg fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  // Allow basic inline tags (<strong>, <code>, <br>) di message — input dari Claude/dev, bukan dari user.
  // Tetap escape user-content (log lines) sepenuhnya.
  function richEsc(s) {
    return String(s == null ? '' : s);
  }
  function classifyLog(line) {
    const s = String(line);
    if (/^[✓✔]|berhasil|selesai|synced|created|added|OK/i.test(s)) return 'ok';
    if (/^[⚠]|warning|warn/i.test(s)) return 'warn';
    if (/^[✗✘×]|gagal|error|fail/i.test(s)) return 'err';
    return '';
  }

  // ── Core open/close ──
  function open(opts) {
    return new Promise((resolve) => {
      const { type='info', title='', message='', bullets=null, log=null,
              isConfirm=false, confirmText='OK', cancelText='Batal' } = opts;

      const ov = document.createElement('div');
      ov.className = 'dd-ov';

      const iconClass = ['info','success','warning','error'].includes(type) ? type : 'info';
      const confirmBtnClass =
        type === 'success' ? 'dd-btn-success'
        : type === 'warning' ? 'dd-btn-warning'
        : type === 'error' ? 'dd-btn-danger'
        : 'dd-btn-primary';

      let bulletsHtml = '';
      if (Array.isArray(bullets) && bullets.length) {
        bulletsHtml = '<ul class="dd-bullets">' +
          bullets.map(b => `<li>${esc(b)}</li>`).join('') +
          '</ul>';
      }

      let logHtml = '';
      if (Array.isArray(log) && log.length) {
        const lines = log.map(l => {
          const cls = classifyLog(l);
          return `<span class="dd-log-line ${cls}">${esc(l)}</span>`;
        }).join('');
        logHtml = `
          <div class="dd-log-toggle" data-toggle="log">
            <svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            <span>Lihat detail log (${log.length} entri)</span>
          </div>
          <div class="dd-log-wrap"><div class="dd-log">${lines}</div></div>
        `;
      }

      ov.innerHTML = `
        <div class="dd-box" role="dialog" aria-modal="true">
          <div class="dd-head">
            <div class="dd-icon ${iconClass}">${ICONS[iconClass]}</div>
            <h3 class="dd-title">${esc(title)}</h3>
            <p class="dd-msg">${richEsc(message)}</p>
          </div>
          ${(bulletsHtml || logHtml) ? `<div class="dd-body">${bulletsHtml}${logHtml}</div>` : ''}
          <div class="dd-ft">
            ${isConfirm ? `<button class="dd-btn dd-btn-ghost" data-act="cancel">${esc(cancelText)}</button>` : ''}
            <button class="dd-btn ${confirmBtnClass}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>
      `;

      document.body.appendChild(ov);
      // Trigger reflow for animation
      void ov.offsetWidth;
      ov.classList.add('open');

      const close = (val) => {
        ov.classList.remove('open');
        setTimeout(() => { ov.remove(); resolve(val); }, 200);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
        if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); close(true); }
      };
      document.addEventListener('keydown', onKey);

      ov.addEventListener('click', (e) => {
        // Toggle log expand
        const tog = e.target.closest('[data-toggle="log"]');
        if (tog) {
          tog.classList.toggle('open');
          tog.nextElementSibling.classList.toggle('open');
          // Update text
          const span = tog.querySelector('span');
          if (span) {
            const isOpen = tog.classList.contains('open');
            span.textContent = isOpen
              ? `Sembunyikan detail log (${log.length} entri)`
              : `Lihat detail log (${log.length} entri)`;
          }
          return;
        }
        // Klik luar dialog → cancel
        if (e.target === ov) { document.removeEventListener('keydown', onKey); close(false); return; }
        // Klik tombol
        const btn = e.target.closest('[data-act]');
        if (btn) {
          document.removeEventListener('keydown', onKey);
          close(btn.dataset.act === 'ok');
        }
      });

      // Focus default button untuk keyboard nav
      requestAnimationFrame(() => {
        const focusBtn = ov.querySelector('.dd-btn[data-act="ok"]');
        if (focusBtn) focusBtn.focus();
      });
    });
  }

  window.DigsDialog = {
    alert: (opts) => open({ ...opts, isConfirm: false }),
    confirm: (opts) => open({ ...opts, isConfirm: true }),
    info:    (msg, title='Informasi')   => open({ type:'info',    title, message: msg, isConfirm:false }),
    success: (msg, title='Berhasil')    => open({ type:'success', title, message: msg, isConfirm:false }),
    warning: (msg, title='Peringatan')  => open({ type:'warning', title, message: msg, isConfirm:false }),
    error:   (msg, title='Error')       => open({ type:'error',   title, message: msg, isConfirm:false })
  };
})();

function _calcDueDate(billingDay, installDate) {
  const bd  = Math.min(parseInt(billingDay) || 1, 28);
  // Referensi: pakai installation_date jika ada
  const ref = installDate ? new Date(installDate) : new Date();
  // Coba tgl billing_day di bulan yang sama dengan referensi
  let candidate = new Date(ref.getFullYear(), ref.getMonth(), bd);
  // Jika kandidat <= referensi, maju ke bulan berikutnya
  if (candidate <= ref) {
    candidate = new Date(ref.getFullYear(), ref.getMonth() + 1, bd);
  }
  return candidate.toLocaleDateString('id-ID', {day:'2-digit', month:'2-digit', year:'numeric'});
}

function _setText(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
function _setBar(id,r){const e=document.getElementById(id);if(e)e.style.width=Math.min(Math.max((r||0)*100,2),100)+'%';}
function _esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function _fmtDt(d){if(!d)return'–';const dt=new Date(d);return dt.toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'2-digit'})+' '+dt.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});}
function _fmtDate(d){
  if(!d) return '–';
  // handle YYYY-MM-DD string or Date object
  const s = typeof d === 'string' ? d.substring(0,10) : d;
  const dt = new Date(s + 'T00:00:00');
  if (isNaN(dt)) return String(d).substring(0,10);
  return dt.toLocaleDateString('id-ID',{day:'2-digit',month:'2-digit',year:'numeric'});
}
function _days(d){
  if(!d) return 0;
  const s = typeof d === 'string' ? d.substring(0,10) : String(d).substring(0,10);
  return Math.max(0, Math.round((Date.now() - new Date(s+'T00:00:00')) / 86400000));
}

let _tab = 'isolated';
let _devices = [], _eligible = [];

document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadStats();
  loadDevices();
  loadIsolated();
  loadEligible();
  loadDueAlerts();
  loadSettings();
});

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  const d = await App.api('/isolir/stats');
  if (!d?.success) return;
  const { isolated, with_ip, devices, log_24h, auto_enabled } = d.data;
  _setText('scIsolated', isolated);
  _setText('scIsolatedSub', isolated + ' dari ' + with_ip + ' pelanggan eligible');
  _setBar('scIsolatedBar', isolated / Math.max(with_ip, 1));
  _setText('scWithIP', with_ip);
  _setText('scDevices', devices.online + '/' + devices.total);
  _setText('scDevicesSub', devices.total + ' device terdaftar');
  _setBar('scDevicesBar', devices.online / Math.max(devices.total, 1));
  _setText('scLog24', log_24h);
}

// ── Devices ───────────────────────────────────────────────────
async function loadDevices() {
  const d = await App.api('/isolir/devices');
  _devices = d?.data || [];
  const el = document.getElementById('deviceList');
  if (!el) return;
  if (!_devices.length) {
    el.innerHTML = '<div class="empty-state">'
      + '<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/></svg>'
      + '<p>Belum ada router untuk isolir</p>'
      + '<p style="font-size:11px;color:var(--d-muted);margin-top:4px;">Tambahkan router MikroTik di <a href="/devices" style="color:#1d4ed8;text-decoration:underline;">Device Management</a> dulu, lalu klik <strong>+ Tambah</strong> di sini.</p>'
      + '</div>';
    return;
  }
  el.innerHTML = _devices.map(dev => {
    const st = dev.status || 'unknown';
    // Badge protocol dari devices.api_protocol (via field connection_type yang sudah di-derive di controller)
    const protoBadge = dev.connection_type
      ? `<span style="display:inline-block;padding:1px 6px;border-radius:5px;background:${dev.connection_type === 'REST' ? '#dbeafe' : '#fef3c7'};border:1px solid ${dev.connection_type === 'REST' ? '#93c5fd' : '#fde68a'};color:${dev.connection_type === 'REST' ? '#1d4ed8' : '#92400e'};font-size:10px;font-weight:600;margin-left:4px;">${dev.connection_type}</span>`
      : '';
    return `<div class="dev-card">
      <div style="display:flex;align-items:flex-start;gap:9px;">
        <span class="dev-dot ${st}" style="margin-top:5px;"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:700;color:#0d1b3e;display:flex;align-items:center;flex-wrap:wrap;gap:5px;">
            <span>${_esc(dev.name)}</span>${protoBadge}
          </div>
          <div style="font-size:11px;color:#64748b;font-family:'DM Mono',monospace;margin-top:3px;">${_esc(dev.host || '-')}:${dev.port || '?'}</div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span>${st === 'online' ? 'Online' : st === 'offline' ? 'Offline' : 'Belum dicek'}</span>
            ${dev.last_ping ? '<span>· ' + _fmtDt(dev.last_ping) + '</span>' : ''}
            ${dev.device_id ? '<span>· <a href="/devices" style="color:#1d4ed8;text-decoration:none;">Kelola</a></span>' : ''}
          </div>
        </div>
      </div>
      <div class="dev-actions">
        <button class="dev-act" onclick="pingDevice(${dev.id})" title="Tes koneksi">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Ping
        </button>
        <button class="dev-act primary" onclick="setupFirewall(${dev.id})" title="Pasang rule isolir">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg> Setup Firewall
        </button>
        <button class="dev-act info" onclick="openBypassRouterModal(${dev.id}, '${_esc(dev.name)}')" title="Bypass IP per router">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Bypass
        </button>
        <button class="dev-act" onclick='editDevice(${JSON.stringify(dev).replace(/'/g, "&#39;")})' title="Edit router">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg> Edit
        </button>
        <button class="dev-act danger" onclick="deleteDevice(${dev.id})" title="Hapus router">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

window.pingDevice = async function(id) {
  App.showToast('Menghubungi router...', 'info');
  const d = await App.api('/isolir/devices/' + id + '/ping', { method: 'POST', body: '{}' });
  if (d?.success) {
    const apiLabels = { 'v7-rest':'REST', 'v7':'API v7', 'v6':'API v6', 'unknown':'Native' };
    const mode = apiLabels[d.api_mode] || d.api_mode || '';
    const ver  = d.ros_version ? ` · RouterOS ${d.ros_version}` : '';
    App.showToast(`✅ ${d.identity || 'MikroTik'} — online (${mode})${ver}`, 'success');
    loadDevices();
  }
  else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

window.setupFirewall = async function(id) {
  const ok = await DigsDialog.confirm({
    type: 'warning',
    title: 'Setup Firewall',
    message: 'Akan membuat rule <strong>NAT redirect + bypass + drop</strong> di router ini.',
    bullets: [
      'URL halaman isolir sudah diset (HTTP, IP LOKAL, bukan domain CDN)',
      'Rule lama sudah dibersihkan via WinBox'
    ],
    confirmText: 'Lanjutkan',
    cancelText: 'Batal'
  });
  if (!ok) return;

  App.showToast('Setup firewall...', 'info');
  const d = await App.api('/isolir/devices/' + id + '/setup-firewall', { method: 'POST', body: '{}' });

  if (d?.success) {
    DigsDialog.alert({
      type: 'success',
      title: 'Setup Firewall Selesai',
      message: 'Pelanggan diisolir akan di-redirect ke halaman isolir saat browsing.',
      log: Array.isArray(d.details) ? d.details : null
    });
    App.showToast('✅ Firewall setup selesai', 'success');
  } else {
    DigsDialog.alert({
      type: 'error',
      title: 'Setup Firewall Gagal',
      message: d?.message || 'Terjadi kesalahan tidak diketahui.',
      log: Array.isArray(d?.details) ? d.details : null
    });
    App.showToast('❌ Setup firewall gagal — lihat detail di dialog', 'error');
  }
};

// ── Cache daftar devices yang available untuk dropdown ─────────
let _availableDevices = [];

// Load daftar devices dari halaman /devices yang bisa dipakai sebagai
// extension isolir (filter: type=router, brand=MikroTik, aktif, belum di-extend).
// Parameter includeId: kalau di-set, sertakan device yang sedang di-edit
// (supaya dropdown tidak kosong di mode edit).
async function loadAvailableDevices(includeId) {
  try {
    const url = includeId
      ? `/isolir/available-devices?include=${includeId}`
      : '/isolir/available-devices';
    const d = await App.api(url);
    _availableDevices = d?.data || [];
    return _availableDevices;
  } catch (e) {
    console.error('loadAvailableDevices error:', e);
    _availableDevices = [];
    return [];
  }
}

// Populate dropdown #fDeviceId dari _availableDevices.
// Optional: preselect device dengan id tertentu.
function populateDevicePicker(preselectId) {
  const sel = document.getElementById('fDeviceId');
  const hint = document.getElementById('fDeviceHint');
  if (!sel) return;

  if (!_availableDevices.length) {
    sel.innerHTML = '<option value="">— Tidak ada device MikroTik tersedia —</option>';
    if (hint) {
      hint.innerHTML = '⚠ Tidak ada device dengan <code>type=router</code>, <code>brand=MikroTik</code>, dan <code>aktif</code> di /devices, atau semua sudah dipakai. <a href="/devices" style="color:#1d4ed8;text-decoration:underline;">Tambah device dulu</a>.';
      hint.style.color = '#dc2626';
    }
    return;
  }

  const opts = ['<option value="">— Pilih router dari Device Management —</option>'];
  for (const dev of _availableDevices) {
    const label = `${dev.name} (${dev.ip_address})`;
    const selected = (preselectId && parseInt(dev.id) === parseInt(preselectId)) ? 'selected' : '';
    opts.push(`<option value="${dev.id}" ${selected}>${_esc(label)}</option>`);
  }
  sel.innerHTML = opts.join('');

  if (hint) {
    hint.innerHTML = `${_availableDevices.length} device tersedia. Untuk menambah, daftarkan dulu di <a href="/devices" style="color:#1d4ed8;text-decoration:underline;">Device Management</a>.`;
    hint.style.color = '';
  }

  // Trigger preview kalau ada preselect
  if (preselectId) onDevicePickChange();
}

// Saat user pilih device dari dropdown — tampilkan preview detail
window.onDevicePickChange = function() {
  const sel = document.getElementById('fDeviceId');
  const prev = document.getElementById('fDevicePreview');
  if (!sel || !prev) return;

  const id = parseInt(sel.value) || 0;
  if (!id) {
    prev.style.display = 'none';
    return;
  }

  const dev = _availableDevices.find(x => parseInt(x.id) === id);
  if (!dev) {
    prev.style.display = 'none';
    return;
  }

  // Derive label protocol untuk preview
  const protoLabels = {
    'rest-http':  'REST API (HTTP)',
    'rest-https': 'REST API (HTTPS)',
    'api-plain':  'API Binary (plain)',
    'api-ssl':    'API Binary (SSL)'
  };
  const proto = dev.api_protocol;
  const protoLabel = protoLabels[proto] || (proto || '⚠ tidak di-set (default: Native Binary plain)');
  const protoWarn  = !proto
    ? '<div style="margin-top:6px;padding:6px 8px;background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;color:#92400e;font-size:10.5px;line-height:1.4;">⚠ <code>api_protocol</code> di /devices belum di-set. Default fallback: <strong>Native Binary plain (port ' + (dev.api_port || 8728) + ')</strong>. Untuk REST API, set <code>api_protocol</code> ke <code>rest-http</code> atau <code>rest-https</code> di /devices.</div>'
    : '';

  document.getElementById('fPrevName').textContent = dev.name + (dev.model ? ' · ' + dev.model : '');
  document.getElementById('fPrevHost').textContent = `${dev.ip_address}:${dev.api_port || '?'} (${dev.api_username || 'admin'})`;
  document.getElementById('fPrevProto').innerHTML = `Protokol: <strong>${protoLabel}</strong> · Brand: ${dev.brand || '<em style="color:#dc2626;">NULL</em>'}` + protoWarn;
  prev.style.display = '';
};

window.editDevice = async function(dev) {
  if (typeof dev === 'string') dev = JSON.parse(dev);
  document.getElementById('deviceModalTitle').textContent = 'Edit Konfigurasi Isolir';
  document.getElementById('fDevId').value  = dev.id;

  // Load available devices DENGAN includeId supaya device terpilih masuk dropdown
  await loadAvailableDevices(dev.id);
  populateDevicePicker(dev.device_id);

  // Field isolir-specific
  document.getElementById('fWan').value         = dev.wan_interface || 'ether1';
  document.getElementById('fBinaryPort').value  = dev.binary_port || 8728;
  document.getElementById('fIsolirUrl').value   = dev.isolir_page_url || '';
  document.getElementById('fNotes').value       = dev.notes || '';

  // Pasang validator real-time pada field URL (kalau belum)
  if (typeof attachUrlValidators === 'function') attachUrlValidators();

  openModal('deviceModal');
};

window.deleteDevice = async function(id) {
  const ok = await DigsDialog.confirm({
    type: 'error',
    title: 'Hapus Extension Isolir',
    message: 'Extension isolir untuk router ini akan dihapus.<br>Device di <strong>/devices</strong> TIDAK ikut terhapus.<br>Pelanggan yang terkait akan kehilangan referensi router isolir.',
    confirmText: 'Hapus Extension',
    cancelText: 'Batal'
  });
  if (!ok) return;
  const d = await App.api('/isolir/devices/' + id, { method: 'DELETE' });
  if (d?.success) { App.showToast(d.message || 'Extension dihapus', 'success'); loadDevices(); }
  else App.showToast(d?.message||'Gagal', 'error');
};

window.openDeviceModal = async function() {
  document.getElementById('deviceModalTitle').textContent = 'Tambah Router untuk Isolir';
  // Reset field
  document.getElementById('fDevId').value = '';
  document.getElementById('fWan').value   = 'ether1';
  document.getElementById('fBinaryPort').value = '8728';
  document.getElementById('fIsolirUrl').value = '';
  document.getElementById('fNotes').value = '';
  document.getElementById('fDevicePreview').style.display = 'none';

  // Load available devices (yang belum punya extension)
  const sel = document.getElementById('fDeviceId');
  if (sel) sel.innerHTML = '<option value="">Memuat...</option>';
  await loadAvailableDevices(null);
  populateDevicePicker(null);

  // Pasang validator real-time pada field URL
  if (typeof attachUrlValidators === 'function') attachUrlValidators();

  openModal('deviceModal');
};

window.saveDevice = async function() {
  const id        = document.getElementById('fDevId').value;
  const deviceId  = document.getElementById('fDeviceId').value;

  if (!deviceId) {
    App.showToast('Pilih device dari dropdown terlebih dahulu', 'error');
    return;
  }

  // ── HARD BLOCK: tolak save kalau URL HTTPS ──
  const fIsolirUrl = document.getElementById('fIsolirUrl');
  if (fIsolirUrl && window.validateIsolirUrl) {
    const v = window.validateIsolirUrl(fIsolirUrl.value);
    if (!v.ok && v.severity === 'error') {
      App.showToast(v.msg, 'error');
      fIsolirUrl.focus();
      return;
    }
  }

  const body = {
    id:              id || undefined,
    device_id:       parseInt(deviceId),
    binary_port:     parseInt(document.getElementById('fBinaryPort').value) || 8728,
    wan_interface:   document.getElementById('fWan').value || 'ether1',
    isolir_page_url: document.getElementById('fIsolirUrl').value || null,
    notes:           document.getElementById('fNotes').value || ''
  };

  const method = id ? 'PUT' : 'POST';
  const url    = id ? '/isolir/devices/' + id : '/isolir/devices';
  const d = await App.api(url, { method, body: JSON.stringify(body) });
  if (d?.success) { App.showToast(d.message||'Disimpan', 'success'); closeModal('deviceModal'); loadDevices(); }
  else App.showToast(d?.message||'Gagal', 'error');
};

// ── Isolated list ─────────────────────────────────────────────
async function loadIsolated() {
  const d = await App.api('/isolir/isolated');
  const rows = d?.data || [];
  const el = document.getElementById('isolatedTableWrap');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg><p>Semua pelanggan aktif 🎉</p></div>';
    return;
  }
  el.innerHTML = '<table class="iso-tbl"><thead><tr><th>Pelanggan</th><th>Tipe</th><th>Target</th><th>Router</th><th>Jatuh Tempo</th><th>Diisolir</th><th>Aksi</th></tr></thead><tbody>' +
    rows.map(r => {
      const overdue = r.last_due ? _days(r.last_due) : 0;
      const tb = r.isolir_method === 'pppoe' ? '<span class="tbadge pppoe">PPPoE</span>'
        : (r.isolir_method === 'hotspot_binding' ? '<span class="tbadge hotspot">IP Static Hotspot</span>'
        : (r.isolir_method === 'static' ? '<span class="tbadge static">Static IP</span>' : '<span class="tbadge" style="background:#f1f5f9;color:#64748b;">—</span>'));
      const target = (r.isolir_method === 'hotspot_binding' && (r.mac_address || r.static_ip))
        ? `<span class="ip-tag" title="Hotspot IP Binding">${_esc(r.mac_address || r.static_ip)}</span>`
        : (r.static_ip
        ? `<span class="ip-tag">${_esc(r.static_ip)}</span>`
        : (r.pppoe_username ? `<span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;" title="PPPoE user">${_esc(r.pppoe_username)}</span>` : '<span style="color:#94a3b8;">–</span>'));
      return `<tr>
        <td data-label="">
          <div style="font-weight:700">${_esc(r.name)}</div>
          <div style="font-size:11px;color:#64748b;">${_esc(r.customer_id)}</div>
        </td>
        <td data-label="Tipe">${tb}</td>
        <td data-label="Target">${target}</td>
        <td data-label="Router" style="font-size:12px;color:#64748b;">${_esc(r.router_name||'–')}</td>
        <td data-label="Jatuh Tempo">
          ${r.last_due
            ? `<div style="font-size:12px;font-weight:700;color:#dc2626;">${_fmtDate(r.last_due)}</div>${overdue > 0 ? '<div style="font-size:10.5px;color:#94a3b8;">'+overdue+' hari telat</div>' : ''}`
            : r.billing_date
              ? `<div style="font-size:12px;color:#94a3b8;">${_calcDueDate(r.billing_date, r.installation_date)}</div>`
              : '<span style="color:#94a3b8;">–</span>'}
        </td>
        <td data-label="Diisolir" style="font-size:11.5px;color:#64748b;">${_fmtDt(r.isolir_at)}</td>
        <td data-label="">
          <button class="btn-success btn-xs" onclick="doRestore(${r.id},'${_esc(r.name)}')">✓ Restore</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

// ── Eligible list ─────────────────────────────────────────────
let _ctypeFilter = 'all';   // all | pppoe | hotspot_binding | static

window.filterCustomerType = function(type, btn) {
  _ctypeFilter = type;
  document.querySelectorAll('.ctype-tab').forEach(b => b.classList.toggle('active', b.dataset.ctype === type));
  renderEligible();
};

async function loadEligible() {
  const d = await App.api('/isolir/eligible');
  _eligible = d?.data || [];

  // Hitung jumlah per tipe untuk badge segmen
  const cnt = { all: _eligible.length, pppoe: 0, hotspot_binding: 0, static: 0 };
  _eligible.forEach(c => { if (cnt[c.isolir_method] !== undefined) cnt[c.isolir_method]++; });
  _setText('ctAll', cnt.all);
  _setText('ctPppoe', cnt.pppoe);
  _setText('ctHotspot', cnt.hotspot_binding);
  _setText('ctStatic', cnt.static);

  // Update dropdowns — label menampilkan IP atau PPPoE user
  const _label = c => {
    if (c.isolir_method === 'hotspot_binding' && (c.mac_address || c.static_ip)) return `${c.name} — HS: ${c.mac_address || c.static_ip}`;
    if (c.static_ip)      return `${c.name} — ${c.static_ip}`;
    if (c.pppoe_username) return `${c.name} — PPPoE: ${c.pppoe_username}`;
    return c.name;
  };
  const isoSel = document.getElementById('manualIsolirSel');
  const reSel  = document.getElementById('manualRestoreSel');
  if (isoSel) isoSel.innerHTML = '<option value="">Pilih pelanggan...</option>' +
    _eligible.filter(c => c.isolir_status !== 'isolated').map(c => `<option value="${c.id}">${_esc(_label(c))}</option>`).join('');
  if (reSel) reSel.innerHTML = '<option value="">Pilih pelanggan...</option>' +
    _eligible.filter(c => c.isolir_status === 'isolated').map(c => `<option value="${c.id}">${_esc(_label(c))}</option>`).join('');

  renderEligible();
}

// Render tabel eligible sesuai filter tipe aktif (_ctypeFilter)
function renderEligible() {
  const el = document.getElementById('eligibleTableWrap');
  if (!el) return;

  const TYPE_LABEL = { pppoe: 'PPPoE', hotspot_binding: 'IP Static Hotspot', static: 'Static IP Biasa', all: 'Semua' };
  _setText('eligibleTitle', _ctypeFilter === 'all' ? 'Semua Pelanggan Eligible' : 'Pelanggan — ' + TYPE_LABEL[_ctypeFilter]);

  const rows0 = _ctypeFilter === 'all' ? _eligible : _eligible.filter(c => c.isolir_method === _ctypeFilter);
  // Filter pencarian: nama / CID / IP / PPPoE
  const q = (document.getElementById('eligibleSearch')?.value || '').trim().toLowerCase();
  const rows = !q ? rows0 : rows0.filter(c =>
    (c.name||'').toLowerCase().includes(q) ||
    (c.customer_id||'').toLowerCase().includes(q) ||
    (c.static_ip||'').toLowerCase().includes(q) ||
    (c.pppoe_username||'').toLowerCase().includes(q) ||
    (c.mac_address||'').toLowerCase().includes(q)
  );
  _setText('eligibleCount', rows.length + ' pelanggan');

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state"><p>' + (q ? 'Tidak ada hasil untuk "' + _esc(q) + '"' : 'Tidak ada pelanggan untuk tipe ini') + '</p></div>';
    return;
  }

  // Badge tipe (warna konsisten dgn segmen)
  const typeBadge = m => m === 'pppoe'
    ? '<span class="tbadge pppoe">PPPoE</span>'
    : (m === 'hotspot_binding' ? '<span class="tbadge hotspot">IP Static Hotspot</span>'
    : (m === 'static' ? '<span class="tbadge static">Static IP</span>' : '<span class="tbadge" style="background:#f1f5f9;color:#64748b;">—</span>'));

  el.innerHTML = '<table class="iso-tbl"><thead><tr><th>Pelanggan</th><th>Tipe</th><th>Target</th><th>Paket</th><th>Jatuh Tempo</th><th>Status</th><th>Router</th><th>Aksi</th></tr></thead><tbody>' +
    rows.map(r => {
      const statusCls = r.isolir_status === 'isolated' ? 'red' : 'green';
      const statusLbl = r.isolir_status === 'isolated' ? '⛔ Isolir' : '✓ Aktif';
      const overdue = r.last_due ? _days(r.last_due) : 0;
      const target = (r.isolir_method === 'hotspot_binding' && (r.mac_address || r.static_ip))
        ? `<span class="ip-tag" title="Hotspot IP Binding">${_esc(r.mac_address || r.static_ip)}</span>`
        : (r.static_ip
        ? `<span class="ip-tag">${_esc(r.static_ip)}</span>`
        : (r.pppoe_username ? `<span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;" title="PPPoE">${_esc(r.pppoe_username)}</span>` : '<span style="color:#94a3b8;">–</span>'));
      return `<tr>
        <td data-label=""><div style="font-weight:700">${_esc(r.name)}</div><div style="font-size:11px;color:#64748b;">${_esc(r.customer_id)}</div></td>
        <td data-label="Tipe">${typeBadge(r.isolir_method)}</td>
        <td data-label="Target">${target}</td>
        <td data-label="Paket" style="font-size:12px;">${_esc(r.package_name||'–')}</td>
        <td data-label="Jatuh Tempo">
          ${r.last_due
            ? `<span style="font-size:12px;font-weight:600;color:${overdue>0?'#dc2626':'#16a34a'};">${_fmtDate(r.last_due)}</span>${overdue>0?'<div style="font-size:10.5px;color:#94a3b8;">'+overdue+'h telat</div>':r.last_inv_status==='paid'?'<div style="font-size:10px;color:#16a34a;">Lunas</div>':''}`
            : r.billing_date
              ? `<span style="font-size:12px;color:#94a3b8;">${_calcDueDate(r.billing_date, r.installation_date)}</span>`
              : '<span style="color:#94a3b8;">–</span>'}
        </td>
        <td data-label="Status"><span class="badge ${statusCls}">${statusLbl}</span></td>
        <td data-label="Router" style="font-size:12px;color:#64748b;">${_esc(r.router_name||'–')}</td>
        <td data-label="">
          ${r.isolir_status !== 'isolated'
            ? `<button class="btn-danger btn-xs" onclick="doIsolir(${r.id},'${_esc(r.name)}')">Isolir</button>`
            : `<button class="btn-success btn-xs" onclick="doRestore(${r.id},'${_esc(r.name)}')">Restore</button>`}
        </td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

// ── Logs ──────────────────────────────────────────────────────
async function loadLogs() {
  const d = await App.api('/isolir/logs?limit=50');
  const rows = d?.data || [];
  const el = document.getElementById('logsTableWrap');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty-state"><p>Belum ada log aktivitas</p></div>'; return; }
  el.innerHTML = '<table class="iso-tbl"><thead><tr><th>Waktu</th><th>Pelanggan</th><th>Target</th><th>Aksi</th><th>Oleh</th><th>Status</th></tr></thead><tbody>' +
    rows.map(r => {
      // Tampilkan IP kalau ada, kalau tidak tampilkan PPPoE user
      const target = r.static_ip
        ? `<span class="ip-tag">${_esc(r.static_ip)}</span>`
        : (r.pppoe_username ? `<span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;">PPPoE: ${_esc(r.pppoe_username)}</span>` : '<span style="color:#94a3b8;">–</span>');
      const methodBadge = r.isolir_method === 'pppoe'
        ? '<span class="badge amber" style="margin-left:4px;">PPPoE</span>'
        : (r.isolir_method === 'static' ? '<span class="badge blue" style="margin-left:4px;">Static</span>'
        : (r.isolir_method === 'hotspot_binding' ? '<span class="badge" style="margin-left:4px;background:#dbeafe;color:#1e40af;border-color:#bfdbfe;">Hotspot</span>' : ''));
      return `<tr>
      <td data-label="Waktu" style="font-size:11.5px;color:#64748b;white-space:nowrap;">${_fmtDt(r.created_at)}</td>
      <td data-label=""><div style="font-weight:600;">${_esc(r.cust_name||'–')}</div><div style="font-size:11px;color:#94a3b8;">${_esc(r.cid||'')}</div></td>
      <td data-label="Target">${target}${methodBadge}</td>
      <td data-label="Aksi"><span class="badge ${r.action==='isolir'?'red':'green'}">${r.action==='isolir'?'⛔ Isolir':'✓ Restore'}</span></td>
      <td data-label="Oleh"><span class="badge ${r.trigger_by==='cron'?'gray':r.trigger_by==='payment'?'blue':'amber'}">${_esc(r.trigger_by)}${r.admin_name?' · '+r.admin_name:''}</span></td>
      <td data-label="Status">
        <span class="badge ${r.success?'green':'red'}">${r.success?'OK':'Gagal'}</span>
        ${r.error_msg?`<div style="font-size:10.5px;color:#dc2626;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(r.error_msg)}</div>`:''}
      </td>
    </tr>`;
    }).join('') + '</tbody></table>';
}

// ── Actions ───────────────────────────────────────────────────
window.doIsolir = async function(id, name) {
  // Cari tipe pelanggan untuk pesan konfirmasi yang sesuai
  const cust = (_eligible || []).find(c => String(c.id) === String(id)) || {};
  const m = cust.isolir_method;
  let bullets;
  if (m === 'hotspot_binding') {
    bullets = ['IP Binding di MikroTik akan di-<strong>disable</strong> (sama seperti di /hotspot-binding)', 'Session hotspot pelanggan di-kick', 'Akses internet langsung terputus'];
  } else if (m === 'pppoe') {
    bullets = ['Profil PPPoE diganti ke profil isolir', 'Session PPPoE aktif di-kick', 'Saat reconnect, pelanggan masuk profil isolir'];
  } else {
    bullets = ['IP pelanggan ditambahkan ke address-list FLAYNET-ISOLIR', 'Traffic HTTP di-redirect ke halaman isolir', 'HTTPS & traffic lain di-drop'];
  }
  const ok = await DigsDialog.confirm({
    type: 'warning',
    title: 'Isolir Pelanggan',
    message: `Akses internet <strong>${_esc(name)}</strong> akan diblokir.`,
    bullets,
    confirmText: 'Isolir Sekarang',
    cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Memproses isolir...', 'info');
  const d = await App.api('/isolir/customers/' + id + '/isolir', { method:'POST', body:'{}' });
  if (d?.success) { App.showToast('✅ ' + (d.message||'Berhasil diisolir'), 'success'); refresh(); }
  else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

window.doRestore = async function(id, name) {
  const ok = await DigsDialog.confirm({
    type: 'success',
    title: 'Restore Akses',
    message: `Akses internet <strong>${_esc(name)}</strong> akan dipulihkan.`,
    confirmText: 'Restore',
    cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Memproses restore...', 'info');
  const d = await App.api('/isolir/customers/' + id + '/restore', { method:'POST', body:'{}' });
  if (d?.success) { App.showToast('✅ ' + (d.message||'Berhasil di-restore'), 'success'); refresh(); }
  else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

window.manualIsolir = function() {
  const id = document.getElementById('manualIsolirSel')?.value;
  if (!id) { App.showToast('Pilih pelanggan terlebih dahulu', 'error'); return; }
  const name = document.getElementById('manualIsolirSel').options[document.getElementById('manualIsolirSel').selectedIndex]?.text || '';
  doIsolir(id, name);
};

window.manualRestore = function() {
  const id = document.getElementById('manualRestoreSel')?.value;
  if (!id) { App.showToast('Pilih pelanggan terlebih dahulu', 'error'); return; }
  const name = document.getElementById('manualRestoreSel').options[document.getElementById('manualRestoreSel').selectedIndex]?.text || '';
  doRestore(id, name);
};

window.runAutoIsolir = async function() {
  const ok = await DigsDialog.confirm({
    type: 'warning',
    title: 'Jalankan Auto Isolir',
    message: 'Semua pelanggan overdue yang punya IP akan diisolir secara otomatis.',
    bullets: ['Cek semua pelanggan yang sudah lewat jatuh tempo + grace days', 'IP mereka akan ditambahkan ke address-list FLAYNET-ISOLIR', 'Notifikasi WhatsApp dikirim (kalau diaktifkan)'],
    confirmText: 'Jalankan',
    cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Menjalankan auto isolir...', 'info');
  const d = await App.api('/isolir/run-auto', { method:'POST', body:'{}' });
  if (d?.success) {
    App.showToast(`✅ ${d.isolated} diisolir, ${d.failed} gagal dari ${d.total} eligible`, 'success');
    refresh();
  } else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

// ── Settings ──────────────────────────────────────────────────

// Validator URL halaman isolir.
// Return:  { ok: true }              jika URL kosong atau valid
//          { ok: false, msg, severity: 'error'|'warn' }  jika invalid
// severity 'error' = wajib HTTP (HTTPS pasti gagal di MikroTik)
// severity 'warn'  = mungkin tidak bekerja (mis. host bukan IP / domain publik)
function validateIsolirUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return { ok: true };  // kosong = fallback ke default, oke

  // Wajib pakai prefix protocol (kalau cuma "192.168.x.x" auto-tambah http://)
  let withProto = url;
  if (!/^https?:\/\//i.test(withProto)) {
    return { ok: false, severity: 'error',
      msg: 'URL harus diawali "http://". Contoh: http://192.168.1.100:3000/p/isolir' };
  }

  // HARD BLOCK: HTTPS tidak akan pernah jalan
  if (/^https:\/\//i.test(withProto)) {
    return { ok: false, severity: 'error',
      msg: 'MikroTik dst-nat tidak bisa redirect ke HTTPS (TLS handshake akan gagal). Wajib pakai http:// dengan IP LAN.' };
  }

  // Parse
  let parsed;
  try { parsed = new URL(withProto); } catch (_) {
    return { ok: false, severity: 'error', msg: 'URL tidak valid.' };
  }

  // Validasi host: IP LAN (private) lebih bagus.
  const host = parsed.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

  if (!isIp) {
    // Domain → warning saja (server-side validator akan resolve DNS dan cek private/public).
    // Tapi kasih hint user: kalau domainnya digs.co.id (Cloudflare), pasti gagal.
    return { ok: false, severity: 'warn',
      msg: 'Pakai IP LAN langsung (192.168.x atau 10.x) lebih aman. Domain publik biasanya resolve ke Cloudflare/CDN — paket akan nyasar ke server CDN, bukan server Anda.' };
  }

  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    /^127\./.test(host);

  if (!isPrivate) {
    return { ok: false, severity: 'warn',
      msg: `IP ${host} bukan IP LAN private. Pastikan IP ini reachable dari MikroTik via LAN.` };
  }

  return { ok: true };
}

// Pasang real-time warning ke input URL global + per-device.
// Idempotent — dipasang sekali, di-trigger tiap input event.
function attachUrlValidators() {
  function bind(inputId, warnId) {
    const inp  = document.getElementById(inputId);
    const warn = document.getElementById(warnId);
    if (!inp || !warn || inp.__validatorAttached) return;
    const check = () => {
      const r = validateIsolirUrl(inp.value);
      if (r.ok) {
        warn.style.display = 'none';
        inp.style.borderColor = '';
      } else {
        warn.style.display = 'block';
        warn.textContent = (r.severity === 'error' ? '✗ ' : '⚠ ') + r.msg;
        warn.style.color = r.severity === 'error' ? '#dc2626' : '#92400e';
        warn.style.background = r.severity === 'error' ? '#fef2f2' : '#fefce8';
        warn.style.borderColor = r.severity === 'error' ? '#fecaca' : '#fde68a';
        inp.style.borderColor = r.severity === 'error' ? '#fca5a5' : '#fcd34d';
      }
    };
    inp.addEventListener('input', check);
    inp.addEventListener('blur', check);
    inp.__validatorAttached = true;
    check();   // initial check
  }
  bind('isolirPageUrl', 'isolirPageUrlWarn');
  bind('fIsolirUrl',    'fIsolirUrlWarn');
}

async function loadSettings() {
  const d = await App.api('/isolir/settings');
  if (!d?.success) return;
  const cfg = d.data;
  const el = id => document.getElementById(id);
  if (el('graceDays'))      el('graceDays').value = cfg.isolir_grace_days || '0';
  if (el('isolirPageUrl'))  el('isolirPageUrl').value = cfg.isolir_page_url || '';
  if (el('isolirNotifWa'))  el('isolirNotifWa').checked = cfg.isolir_notify_wa === '1';
  if (el('isolirAutoEnable')) el('isolirAutoEnable').checked = cfg.isolir_auto_enable === '1';
  // Jam auto-isolir (0-23). Kosong/'-1' = setiap jam (begitu lewat grace).
  if (el('isolirAutoHour'))   el('isolirAutoHour').value   = (cfg.isolir_auto_hour ?? '') === '' ? '-1' : cfg.isolir_auto_hour;
  // Template pesan WA saat diisolir
  if (el('isolirWaMessage'))  el('isolirWaMessage').value  = cfg.isolir_wa_message || '';

  // ── Customisasi halaman /p/isolir ──
  if (el('isolirPageTitle'))    el('isolirPageTitle').value    = cfg.isolir_page_title || '';
  if (el('isolirPageSubtitle')) el('isolirPageSubtitle').value = cfg.isolir_page_subtitle || '';
  if (el('isolirPageFooter'))   el('isolirPageFooter').value   = cfg.isolir_page_footer || '';
  if (el('isolirPageHelpText')) el('isolirPageHelpText').value = cfg.isolir_page_help_text || '';
  const color = (cfg.isolir_page_color || '#1a6ef5').trim();
  if (el('isolirPageColor'))    el('isolirPageColor').value    = color;
  if (el('isolirPageColorHex')) el('isolirPageColorHex').value = color.toUpperCase();
  if (el('isolirPageShowInvoices')) {
    // Default '1' (true) kalau belum pernah di-set
    el('isolirPageShowInvoices').checked = (cfg.isolir_page_show_invoices ?? '1') !== '0';
  }

  // Sync color picker ↔ text input
  const colorPicker = el('isolirPageColor');
  const colorHex    = el('isolirPageColorHex');
  if (colorPicker && colorHex && !colorPicker.__synced) {
    colorPicker.addEventListener('input', e => {
      colorHex.value = e.target.value.toUpperCase();
    });
    colorHex.addEventListener('input', e => {
      const v = e.target.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) colorPicker.value = v.toLowerCase();
    });
    colorPicker.__synced = true;
  }

  // Pasang validator real-time untuk field URL
  attachUrlValidators();
}

window.saveSettings = async function() {
  const el = id => document.getElementById(id);

  // ── HARD BLOCK: tolak save kalau URL HTTPS ──
  const urlVal = el('isolirPageUrl')?.value || '';
  if (el('isolirPageUrl')) {
    const v = validateIsolirUrl(urlVal);
    if (!v.ok && v.severity === 'error') {
      App.showToast(v.msg, 'error');
      el('isolirPageUrl')?.focus();
      return;
    }
  }

  // Hanya kirim field yang elemennya ADA di halaman. Field yang sudah dihapus
  // dari UI (mis. customisasi halaman /p/isolir) TIDAK dikirim, sehingga nilai
  // tersimpan sebelumnya tetap aman (tidak ter-overwrite kosong).
  const body = {};
  const put = (key, id, fn) => { const e = el(id); if (e) body[key] = fn(e); };

  put('isolir_grace_days',  'graceDays',        e => e.value || '0');
  put('isolir_page_url',    'isolirPageUrl',    e => e.value || '');
  put('isolir_notify_wa',   'isolirNotifWa',    e => e.checked ? '1' : '0');
  put('isolir_auto_enable', 'isolirAutoEnable', e => e.checked ? '1' : '0');
  put('isolir_auto_hour',   'isolirAutoHour',   e => e.value ?? '-1');
  put('isolir_wa_message',  'isolirWaMessage',  e => e.value || '');

  // Customisasi halaman /p/isolir — hanya jika field-nya masih ada
  put('isolir_page_title',    'isolirPageTitle',    e => e.value || '');
  put('isolir_page_subtitle', 'isolirPageSubtitle', e => e.value || '');
  put('isolir_page_footer',   'isolirPageFooter',   e => e.value || '');
  put('isolir_page_help_text','isolirPageHelpText', e => e.value || '');
  put('isolir_page_show_invoices', 'isolirPageShowInvoices', e => e.checked ? '1' : '0');
  if (el('isolirPageColor') || el('isolirPageColorHex')) {
    let color = el('isolirPageColorHex')?.value.trim() || '';
    if (!/^#[0-9a-f]{6}$/i.test(color)) color = el('isolirPageColor')?.value || '#1a6ef5';
    body.isolir_page_color = color.toLowerCase();
  }

  const d = await App.api('/isolir/settings', { method:'POST', body: JSON.stringify(body) });
  if (d?.success) App.showToast('Settings disimpan', 'success');
  else App.showToast(d?.message||'Gagal', 'error');
};

// Export validator supaya bisa dipakai dari form simpan device (saveDevice)
window.validateIsolirUrl = validateIsolirUrl;

// ════════════════════════════════════════════════════════════════════
// WEB PROXY REDIRECT — untuk redirect HTTP (HTTPS tidak di-handle)
// Compatible RouterOS v6 & v7
// ════════════════════════════════════════════════════════════════════

// Load config + status di MikroTik saat panel settings di-expand
async function loadWebProxyConfig() {
  // Card Web Proxy sudah dihapus dari UI — bail kalau elemennya tidak ada
  // (mencegah API call sia-sia). Fungsi dipertahankan untuk kompatibilitas.
  if (!document.getElementById('webproxyEnabled') && !document.getElementById('webproxyStatusDetail')) return;
  try {
    const d = await App.api('/isolir/webproxy/config');
    if (!d?.success) return;

    const cfg = d.config || {};
    const enabledEl = document.getElementById('webproxyEnabled');
    const statusEl  = document.getElementById('webproxyStatusDetail');

    if (enabledEl) enabledEl.checked = !!cfg.enabled;

    // Render MikroTik status
    if (statusEl) {
      const m = d.mikrotik;
      if (!m || m.error) {
        statusEl.innerHTML = '<span style="color:#a16207;">⚠ Tidak bisa konek ke MikroTik untuk cek status</span>';
      } else {
        const yes = '<span style="color:#16a34a;">✓</span>';
        const no  = '<span style="color:#dc2626;">✗</span>';
        statusEl.innerHTML =
          '<div>' + (m.proxy_enabled ? yes : no) + ' Web Proxy aktif' +
              (m.proxy_enabled ? ' (port <code>' + (m.proxy_port || '?') + '</code>)' : '') + '</div>' +
          '<div>' + (m.access_rule_exists ? yes : no) + ' Access rule (deny + redirect)' +
              (m.redirect_target ? ' → <code>' + m.redirect_target + '</code>' : '') + '</div>' +
          '<div>' + (m.nat_redirect_exists ? yes : no) + ' NAT redirect port 80 → 8080 (filter: FLAYNET-ISOLIR)</div>' +
          '<div style="margin-top:4px;color:var(--d-muted);font-size:10px;">Device: ' + (m.device_name||'?') + '</div>';
      }
    }
  } catch (e) {
    console.error('loadWebProxyConfig:', e);
  }
}

window.saveWebProxyConfig = async function() {
  const el = id => document.getElementById(id);
  const body = {
    enabled: el('webproxyEnabled')?.checked || false,
  };
  const d = await App.api('/isolir/webproxy/config', { method:'POST', body: JSON.stringify(body) });
  if (d?.success) {
    App.showToast(d.message || 'Config Web Proxy disimpan', 'success');
    setTimeout(loadWebProxyConfig, 500);
  } else {
    App.showToast(d?.message || 'Gagal menyimpan', 'error');
  }
};

// Auto-load saat halaman ready
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadWebProxyConfig, 800);
});

// ── Tab switch ────────────────────────────────────────────────
window.switchTab = function(tab, btn) {
  _tab = tab;
  ['isolated','eligible','logs'].forEach(t => {
    const el = document.getElementById('tab-'+t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'logs') loadLogs();
};

// ── Top-level tab (Operasional / Pelanggan / Kebijakan & Lanjutan) ──
window.switchMainTab = function(pane, btn) {
  document.querySelectorAll('.iso-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
  document.querySelectorAll('.iso-maintab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Lazy-load konten tab Pelanggan (tabel) & Kebijakan saat pertama dibuka
  if (pane === 'cust') {
    if (typeof loadIsolated === 'function') loadIsolated();
    if (typeof loadEligible === 'function') loadEligible();
  } else if (pane === 'policy') {
    if (typeof loadSettings === 'function') loadSettings();
  }
};

// ── Helpers ───────────────────────────────────────────────────
function refresh() {
  loadStats();
  loadDevices();
  loadIsolated();
  loadEligible();
  loadDueAlerts();
}

// ════════════════════════════════════════════════════════════════
// DUE ALERTS (jatuh tempo / overdue / siap isolir / sudah isolir)
// ════════════════════════════════════════════════════════════════
let _dueData = { upcoming: [], overdue: [], eligible: [], isolated: [] };
let _dueTab = 'eligible';   // default ke yang paling actionable
let _dueSelected = new Set(); // device IDs yang di-check untuk bulk action

window.loadDueAlerts = async function() {
  try {
    const d = await App.api('/isolir/due-alerts');
    if (!d?.success) return;
    _dueData = d.data || { upcoming:[], overdue:[], eligible:[], isolated:[] };
    const counts = d.counts || { upcoming:0, overdue:0, eligible:0, isolated:0 };
    _setText('dcUpcoming', counts.upcoming);
    _setText('dcOverdue',  counts.overdue);
    _setText('dcEligible', counts.eligible);
    _setText('dcIsolated', counts.isolated);

    // Auto-pilih tab yang paling perlu perhatian saat first load
    if (!_dueData[_dueTab] || _dueData[_dueTab].length === 0) {
      const fallback = ['eligible','overdue','upcoming','isolated'].find(t => _dueData[t]?.length > 0);
      if (fallback) {
        _dueTab = fallback;
        document.querySelectorAll('.due-tab').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-due-tab') === _dueTab);
        });
      }
    }
    _dueSelected.clear();
    renderDueList();
  } catch (e) {
    const list = document.getElementById('dueList');
    if (list) list.innerHTML = `<div class="due-empty"><div class="due-empty-title">Error</div><div>${_esc(e.message||'Gagal memuat')}</div></div>`;
  }
};

window.switchDueTab = function(tab, btn) {
  _dueTab = tab;
  _dueSelected.clear();
  document.querySelectorAll('.due-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDueList();
};

function renderDueList() {
  const list = document.getElementById('dueList');
  if (!list) return;
  const items = _dueData[_dueTab] || [];

  if (items.length === 0) {
    const emptyMsg = {
      upcoming: { icon:'✓', title:'Tidak ada yang akan jatuh tempo', sub:'7 hari ke depan aman' },
      overdue:  { icon:'✓', title:'Tidak ada yang overdue', sub:'Semua tagihan masih dalam grace period' },
      eligible: { icon:'✓', title:'Tidak ada yang siap diisolir', sub:'Belum ada yang melewati grace period' },
      isolated: { icon:'😊', title:'Tidak ada pelanggan ter-isolir', sub:'Semua pelanggan aktif' }
    }[_dueTab] || { icon:'—', title:'Kosong', sub:'' };
    list.innerHTML = `<div class="due-empty">
      <div style="font-size:24px;margin-bottom:6px;">${emptyMsg.icon}</div>
      <div class="due-empty-title">${emptyMsg.title}</div>
      <div>${emptyMsg.sub}</div>
    </div>`;
    updateBulkBar();
    return;
  }

  list.innerHTML = items.map(c => renderDueItem(c)).join('');
  updateBulkBar();
}

function renderDueItem(c) {
  const tab = _dueTab;
  const isChecked = _dueSelected.has(c.id);
  const canCheck = (tab === 'eligible' || tab === 'overdue') ? c.can_isolir : (tab === 'isolated');

  // ── Due date label + classification ──
  let dueLbl, dueCls = '';
  if (tab === 'upcoming') {
    const days = -c.days_overdue;
    if (days === 0)      { dueLbl = 'Hari ini'; dueCls = 'amber'; }
    else if (days === 1) { dueLbl = 'Besok'; dueCls = 'amber'; }
    else                 { dueLbl = `${days} hari lagi`; dueCls = 'green'; }
  } else if (tab === 'overdue' || tab === 'eligible') {
    dueLbl = `Telat ${c.days_overdue} hari`;
    dueCls = tab === 'eligible' ? '' : 'amber';
  } else {
    dueLbl = `Telat ${c.days_overdue} hari`;
    dueCls = 'muted';
  }

  // ── State attribute untuk left-border accent ──
  let state = 'upcoming';
  if (tab === 'isolated') state = 'isolated';
  else if (tab === 'eligible' && c.can_isolir) state = 'eligible';
  else if (tab === 'overdue') state = 'overdue';

  // ── Badges (status indicators) ──
  const badges = [];
  if (c.isolir_method === 'static')      badges.push('<span class="due-badge static">Static</span>');
  else if (c.isolir_method === 'pppoe')  badges.push('<span class="due-badge pppoe">PPPoE</span>');
  else if (c.isolir_method === 'hotspot_binding') badges.push('<span class="due-badge static">Hotspot</span>');

  if (tab === 'isolated') badges.push('<span class="due-badge danger">Isolated</span>');
  else if (tab === 'eligible' && c.can_isolir) badges.push('<span class="due-badge warn">Siap Isolir</span>');

  if (c.missing_ip)     badges.push('<span class="due-badge muted">No IP / PPPoE</span>');
  if (c.missing_router && !c.missing_ip) badges.push('<span class="due-badge muted">No Router</span>');

  // ── Target tag (IP / PPPoE username / Hotspot MAC) ──
  let targetTag = '';
  if (c.isolir_method === 'hotspot_binding' && (c.mac_address || c.static_ip)) {
    targetTag = `<span class="due-target-tag">HS: ${_esc(c.mac_address || c.static_ip)}</span>`;
  } else if (c.static_ip) {
    targetTag = `<span class="due-target-tag">${_esc(c.static_ip)}</span>`;
  } else if (c.pppoe_username) {
    targetTag = `<span class="due-target-tag pppoe">PPPoE: ${_esc(c.pppoe_username)}</span>`;
  }

  // ── Action button ──
  let actionBtn = '';
  if (tab === 'isolated') {
    actionBtn = `<button class="due-action restore" onclick="doRestoreFromDue(${c.id}, '${_escAttr(c.name)}')">✓ Restore Akses</button>`;
  } else if (c.can_isolir && tab !== 'upcoming') {
    actionBtn = `<button class="due-action isolir" onclick="doIsolirFromDue(${c.id}, '${_escAttr(c.name)}')">⛔ Isolir Sekarang</button>`;
  } else if (tab === 'upcoming') {
    actionBtn = ''; // tidak perlu tombol di upcoming
  } else if (c.missing_router && !c.missing_ip) {
    actionBtn = `<button class="due-action detect" onclick="detectSingleRouter(${c.id}, '${_escAttr(c.name)}')" title="Scan semua router">🔍 Auto-Detect Router</button>`;
  } else {
    actionBtn = `<button class="due-action" disabled title="Edit pelanggan ini dan isi Static IP, PPPoE Username, atau MAC (Hotspot)">⚠ Belum ada IP / PPPoE / Hotspot</button>`;
  }

  // ── Checkbox ──
  const checkClass = canCheck
    ? (isChecked ? 'due-check checked' : 'due-check')
    : 'due-check disabled';
  const checkOnclick = canCheck ? `onclick="toggleDueCheck(${c.id}, this)"` : '';

  return `<div class="due-item" data-state="${state}">
    <!-- Row 1: checkbox + name + ID + target -->
    <div class="due-head">
      <span class="${checkClass}" ${checkOnclick}>${isChecked ? '✓' : ''}</span>
      <div class="due-info">
        <div class="due-name-row">
          <span class="due-name">${_esc(c.name)}</span>
          <span class="due-cid">${_esc(c.customer_id)}</span>
        </div>
        ${targetTag ? `<div class="due-target">${targetTag}</div>` : ''}
      </div>
    </div>

    <!-- Row 2: amount (left) + due warning (right) -->
    <div class="due-meta-row">
      <div class="due-amount-block">
        <div class="due-amount">Rp ${_fmtMoney(c.invoice_amount || c.package_price || 0)}</div>
        <div class="due-amount-sub">${_esc(c.invoice_number || '–')}</div>
      </div>
      <span class="due-warn ${dueCls}">${dueLbl}</span>
    </div>

    <!-- Row 3: badges (optional, only if any) -->
    ${badges.length ? `<div class="due-badges">${badges.join('')}</div>` : ''}

    <!-- Row 4: action button (optional) -->
    ${actionBtn ? `<div class="due-foot">${actionBtn}</div>` : ''}
  </div>`;
}

window.toggleDueCheck = function(id, el) {
  if (el.classList.contains('disabled')) return;
  if (_dueSelected.has(id)) {
    _dueSelected.delete(id);
    el.classList.remove('checked');
    el.textContent = '';
  } else {
    _dueSelected.add(id);
    el.classList.add('checked');
    el.textContent = '✓';
  }
  updateBulkBar();
};

function updateBulkBar() {
  const bar = document.getElementById('dueBulkBar');
  if (!bar) return;
  const n = _dueSelected.size;
  if (n === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  _setText('dueBulkCount', n);
  const isolirBtn  = document.getElementById('dueBulkIsolirBtn');
  const restoreBtn = document.getElementById('dueBulkRestoreBtn');
  if (isolirBtn)  isolirBtn.style.display  = (_dueTab === 'isolated') ? 'none' : '';
  if (restoreBtn) restoreBtn.style.display = (_dueTab === 'isolated') ? '' : 'none';
}

window.doIsolirFromDue = async function(id, name) {
  const ok = await DigsDialog.confirm({
    type: 'warning', title: 'Isolir Pelanggan',
    message: `Akses internet <strong>${_esc(name)}</strong> akan diblokir.`,
    confirmText: 'Isolir Sekarang', cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Memproses isolir...', 'info');
  const d = await App.api('/isolir/customers/' + id + '/isolir', { method:'POST', body:'{}' });
  if (d?.success) { App.showToast('✅ ' + (d.message||'Berhasil diisolir'), 'success'); refresh(); }
  else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

window.doRestoreFromDue = async function(id, name) {
  const ok = await DigsDialog.confirm({
    type: 'success', title: 'Restore Akses',
    message: `Akses internet <strong>${_esc(name)}</strong> akan dipulihkan.`,
    confirmText: 'Restore', cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Memproses restore...', 'info');
  const d = await App.api('/isolir/customers/' + id + '/restore', { method:'POST', body:'{}' });
  if (d?.success) { App.showToast('✅ ' + (d.message||'Berhasil di-restore'), 'success'); refresh(); }
  else App.showToast('❌ ' + (d?.message||'Gagal'), 'error');
};

window.bulkIsolir = async function() {
  const ids = Array.from(_dueSelected);
  if (!ids.length) return;
  const ok = await DigsDialog.confirm({
    type: 'warning', title: 'Bulk Isolir',
    message: `<strong>${ids.length} pelanggan</strong> terpilih akan diisolir sekaligus.`,
    bullets: ['Semua IP ditambahkan ke address-list FLAYNET-ISOLIR', 'Proses sekuensial dengan jeda 400ms'],
    confirmText: 'Isolir Semua', cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast(`Memproses ${ids.length} pelanggan...`, 'info');
  let okCnt = 0, fail = 0;
  for (const id of ids) {
    try {
      const d = await App.api('/isolir/customers/' + id + '/isolir', { method:'POST', body:'{}' });
      if (d?.success) okCnt++; else fail++;
    } catch(_) { fail++; }
    // Throttle agar tidak DDoS router
    await new Promise(r => setTimeout(r, 400));
  }
  _dueSelected.clear();
  App.showToast(`✅ ${okCnt} berhasil, ${fail} gagal`, okCnt > 0 ? 'success' : 'error');
  refresh();
};

window.bulkRestore = async function() {
  const ids = Array.from(_dueSelected);
  if (!ids.length) return;
  const ok = await DigsDialog.confirm({
    type: 'success', title: 'Bulk Restore',
    message: `Akses untuk <strong>${ids.length} pelanggan</strong> terpilih akan dipulihkan.`,
    confirmText: 'Restore Semua', cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast(`Memproses ${ids.length} pelanggan...`, 'info');
  let okCnt = 0, fail = 0;
  for (const id of ids) {
    try {
      const d = await App.api('/isolir/customers/' + id + '/restore', { method:'POST', body:'{}' });
      if (d?.success) okCnt++; else fail++;
    } catch(_) { fail++; }
    await new Promise(r => setTimeout(r, 400));
  }
  _dueSelected.clear();
  App.showToast(`✅ ${okCnt} berhasil, ${fail} gagal`, okCnt > 0 ? 'success' : 'error');
  refresh();
};

// Helpers
function _fmtMoney(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
function _escAttr(s) {
  return String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Toggle collapsible settings panel di mobile
window.toggleSettingPanel = function(btn) {
  btn.classList.toggle('open');
  const panel = btn.parentElement.querySelector('.iso-setting-content');
  if (panel) panel.classList.toggle('open');
};

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
window.openModal  = openModal;
window.closeModal = closeModal;

// ════════════════════════════════════════════════════════════════
// BYPASS LIST MANAGEMENT
// ════════════════════════════════════════════════════════════════
let _currentBypassRouterId = null;
let _currentBypassRouterName = '';

// ── Global bypass ──
window.loadBypassGlobal = async function() {
  const el = document.getElementById('bypassGlobalList');
  if (!el) return;
  try {
    const d = await App.api('/isolir/bypass/global');
    const rows = d?.data || [];
    if (!rows.length) {
      el.innerHTML = '<div style="padding:14px;text-align:center;font-size:11.5px;color:var(--d-muted);background:#f8faff;border:1px dashed var(--d-border);border-radius:8px;">Belum ada bypass global</div>';
      return;
    }
    // Group by category
    const grouped = {};
    rows.forEach(r => {
      const cat = r.category || 'custom';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r);
    });
    const catLabels = { dns:'DNS', network:'Network', payment:'Payment', isp:'ISP', custom:'Custom' };
    let html = '<div style="background:#f8faff;border:1px solid var(--d-border);border-radius:9px;overflow:hidden;">';
    Object.keys(grouped).forEach(cat => {
      html += `<div style="padding:6px 12px;background:#eef2f9;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--d-muted);border-bottom:1px solid var(--d-border);">${catLabels[cat] || cat}</div>`;
      grouped[cat].forEach(r => {
        html += `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid #f0f4ff;">
          <span class="ip-tag" style="font-size:11px;">${_esc(r.address)}</span>
          <span style="flex:1;font-size:11.5px;color:var(--d-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(r.label || '')}</span>
          <button onclick="deleteBypassGlobal(${r.id},'${_escAttr(r.address)}')" title="Hapus" style="border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;padding:2px 5px;line-height:1;">×</button>
        </div>`;
      });
    });
    html += '</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div style="padding:14px;color:#dc2626;font-size:11.5px;">Error: ${_esc(e.message)}</div>`;
  }
};

window.addBypassGlobal = async function() {
  const addr  = document.getElementById('bypassNewAddr')?.value.trim();
  const label = document.getElementById('bypassNewLabel')?.value.trim();
  if (!addr) { App.showToast('Address wajib diisi', 'error'); return; }
  const d = await App.api('/isolir/bypass/global', {
    method: 'POST',
    body: JSON.stringify({ address: addr, label, category: 'custom' })
  });
  if (d?.success) {
    App.showToast('Bypass ditambahkan', 'success');
    document.getElementById('bypassNewAddr').value = '';
    document.getElementById('bypassNewLabel').value = '';
    loadBypassGlobal();
  } else {
    App.showToast(d?.message || 'Gagal', 'error');
  }
};

window.deleteBypassGlobal = async function(id, addr) {
  const ok = await DigsDialog.confirm({
    type: 'error', title: 'Hapus Bypass Global',
    message: `Address <strong>${_esc(addr)}</strong> akan dihapus dari daftar bypass global.`,
    confirmText: 'Hapus', cancelText: 'Batal'
  });
  if (!ok) return;
  const d = await App.api('/isolir/bypass/global/' + id, { method: 'DELETE' });
  if (d?.success) { App.showToast('Bypass dihapus', 'success'); loadBypassGlobal(); }
  else App.showToast(d?.message || 'Gagal', 'error');
};

// ── Per-router bypass ──
window.openBypassRouterModal = async function(deviceId, deviceName) {
  _currentBypassRouterId = deviceId;
  _currentBypassRouterName = deviceName;
  document.getElementById('bypassRouterTitle').textContent = deviceName;
  document.getElementById('bypassRouterAddr').value = '';
  document.getElementById('bypassRouterLabel').value = '';
  openModal('bypassRouterModal');
  await loadBypassRouter();
  await loadBypassMergedPreview();
};

async function loadBypassRouter() {
  const el = document.getElementById('bypassRouterListWrap');
  if (!el || !_currentBypassRouterId) return;
  try {
    const d = await App.api('/isolir/devices/' + _currentBypassRouterId + '/bypass');
    const rows = d?.data || [];
    if (!rows.length) {
      el.innerHTML = '<div style="padding:18px 14px;text-align:center;font-size:11.5px;color:var(--d-muted);">Belum ada bypass khusus router ini.<br>Hanya bypass global yang akan di-push.</div>';
      return;
    }
    el.innerHTML = rows.map(r => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e8eef9;">
        <span class="ip-tag" style="font-size:11px;">${_esc(r.address)}</span>
        <span style="flex:1;font-size:11.5px;color:var(--d-muted);">${_esc(r.label || '—')}</span>
        <button onclick="deleteBypassRouter(${r.id},'${_escAttr(r.address)}')" title="Hapus" style="border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:15px;padding:2px 6px;line-height:1;">×</button>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div style="padding:14px;color:#dc2626;font-size:11.5px;">Error: ${_esc(e.message)}</div>`;
  }
}

async function loadBypassMergedPreview() {
  const el = document.getElementById('bypassMergedPreview');
  if (!el || !_currentBypassRouterId) return;
  try {
    const d = await App.api('/isolir/devices/' + _currentBypassRouterId + '/bypass-merged');
    const rows = d?.data || [];
    if (!rows.length) {
      el.innerHTML = '<span style="color:var(--d-muted);">(kosong)</span>';
      return;
    }
    el.innerHTML = rows.map(r =>
      `<div>${_esc(r.address)}${r.label ? ' <span style="color:var(--d-muted);">// ' + _esc(r.label) + '</span>' : ''}</div>`
    ).join('') + `<div style="margin-top:6px;font-family:'DM Sans',sans-serif;font-size:11px;color:var(--d-muted);">${rows.length} entry total</div>`;
  } catch(_) {}
}

window.addBypassRouter = async function() {
  if (!_currentBypassRouterId) return;
  const addr  = document.getElementById('bypassRouterAddr')?.value.trim();
  const label = document.getElementById('bypassRouterLabel')?.value.trim();
  if (!addr) { App.showToast('Address wajib diisi', 'error'); return; }
  const d = await App.api('/isolir/devices/' + _currentBypassRouterId + '/bypass', {
    method: 'POST',
    body: JSON.stringify({ address: addr, label })
  });
  if (d?.success) {
    App.showToast('Bypass ditambahkan', 'success');
    document.getElementById('bypassRouterAddr').value = '';
    document.getElementById('bypassRouterLabel').value = '';
    loadBypassRouter();
    loadBypassMergedPreview();
  } else {
    App.showToast(d?.message || 'Gagal', 'error');
  }
};

window.deleteBypassRouter = async function(entryId, addr) {
  if (!_currentBypassRouterId) return;
  const ok = await DigsDialog.confirm({
    type: 'error', title: 'Hapus Bypass Router',
    message: `Address <strong>${_esc(addr)}</strong> akan dihapus dari bypass khusus router ini.`,
    confirmText: 'Hapus', cancelText: 'Batal'
  });
  if (!ok) return;
  const d = await App.api('/isolir/devices/' + _currentBypassRouterId + '/bypass/' + entryId, { method: 'DELETE' });
  if (d?.success) { App.showToast('Bypass dihapus', 'success'); loadBypassRouter(); loadBypassMergedPreview(); }
  else App.showToast(d?.message || 'Gagal', 'error');
};

window.syncBypassToRouter = async function() {
  if (!_currentBypassRouterId) return;
  const ok = await DigsDialog.confirm({
    type: 'warning', title: 'Sync Bypass ke Router',
    message: `Daftar bypass akan di-push ke <strong>${_esc(_currentBypassRouterName)}</strong>.`,
    bullets: ['Seluruh isi address-list FLAYNET-BYPASS di router akan di-replace', 'Daftar gabungan = bypass global + bypass khusus router ini'],
    confirmText: 'Sync Sekarang', cancelText: 'Batal'
  });
  if (!ok) return;
  App.showToast('Sync bypass ke router...', 'info');
  const d = await App.api('/isolir/devices/' + _currentBypassRouterId + '/sync-bypass', { method: 'POST', body: '{}' });
  if (d?.success) App.showToast('✅ ' + (d.message || 'Sync berhasil'), 'success');
  else App.showToast('❌ ' + (d?.message || 'Gagal'), 'error');
};
// ════════════════════════════════════════════════════════════════
// AUTO-DETECT ROUTER (Multi-MikroTik Router Matcher)
// ════════════════════════════════════════════════════════════════
let _autoDetectResult = null;   // hasil preview (untuk diapply nanti)
let _adSelectedIds    = new Set();   // customer_id terpilih untuk apply
let _adCurrentTab     = 'detected';

window.openAutoDetectModal = function() {
  // Reset state ke phase idle
  document.getElementById('adPhaseIdle').style.display = '';
  document.getElementById('adPhaseScan').style.display = 'none';
  document.getElementById('adPhaseResult').style.display = 'none';
  document.getElementById('adApplyBtn').style.display = 'none';
  _autoDetectResult = null;
  _adSelectedIds = new Set();
  openModal('autoDetectModal');
};

window.startAutoDetect = async function() {
  document.getElementById('adPhaseIdle').style.display = 'none';
  document.getElementById('adPhaseScan').style.display = '';
  document.getElementById('adScanStatus').textContent = 'Menghubungi semua MikroTik secara paralel...';

  try {
    const d = await App.api('/isolir/router-matcher/preview', { method: 'POST', body: '{}' });
    if (!d?.success) {
      document.getElementById('adPhaseScan').style.display = 'none';
      document.getElementById('adPhaseIdle').style.display = '';
      DigsDialog.error(d?.message || 'Scan gagal', 'Auto-Detect Error');
      return;
    }
    _autoDetectResult = d.data;
    renderAutoDetectResult();
  } catch (e) {
    document.getElementById('adPhaseScan').style.display = 'none';
    document.getElementById('adPhaseIdle').style.display = '';
    DigsDialog.error(e.message, 'Auto-Detect Error');
  }
};

function renderAutoDetectResult() {
  document.getElementById('adPhaseScan').style.display = 'none';
  document.getElementById('adPhaseResult').style.display = '';

  const r = _autoDetectResult;
  if (!r) return;

  // Default: select all detected
  _adSelectedIds = new Set(r.detected.map(d => d.customer_id));

  // Counts
  _setText('adCntDetected',  r.detected.length);
  _setText('adCntConflicts', r.conflicts.length);
  _setText('adCntNoMatch',   r.no_match.length);

  // Summary bar
  const sumEl = document.getElementById('adSummary');
  sumEl.innerHTML = `
    <div style="flex:1;min-width:120px;background:#dbeafe;border-radius:8px;padding:8px 12px;">
      <div style="font-size:10.5px;color:#1e40af;font-weight:700;letter-spacing:.07em;text-transform:uppercase;">Router Discan</div>
      <div style="font-size:18px;font-weight:800;color:#1d4ed8;">${r.total_routers}</div>
    </div>
    <div style="flex:1;min-width:120px;background:#f1f5f9;border-radius:8px;padding:8px 12px;">
      <div style="font-size:10.5px;color:#475569;font-weight:700;letter-spacing:.07em;text-transform:uppercase;">Customer Scanned</div>
      <div style="font-size:18px;font-weight:800;color:#0d1b3e;">${r.total_customers}</div>
    </div>
    <div style="flex:1;min-width:120px;background:#dcfce7;border-radius:8px;padding:8px 12px;">
      <div style="font-size:10.5px;color:#166534;font-weight:700;letter-spacing:.07em;text-transform:uppercase;">Match</div>
      <div style="font-size:18px;font-weight:800;color:#16a34a;">${r.detected.length}</div>
    </div>
  `;

  // Router scan list
  const rsEl = document.getElementById('adRouterScanList');
  if (r.scanned_routers && r.scanned_routers.length) {
    rsEl.innerHTML = '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--d-muted);margin-bottom:6px;">Hasil Scan per Router</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      r.scanned_routers.map(rs => `
        <div style="background:${rs.error ? '#fef2f2' : '#f8faff'};border:1px solid ${rs.error ? '#fecaca' : 'var(--d-border)'};border-radius:8px;padding:6px 10px;font-size:11px;min-width:140px;">
          <div style="font-weight:700;color:#0d1b3e;">${_esc(rs.device_name)}</div>
          ${rs.error
            ? `<div style="color:#dc2626;font-size:10.5px;margin-top:2px;">⚠ ${_esc(rs.error)}</div>`
            : `<div style="color:var(--d-muted);font-size:10.5px;margin-top:2px;">ARP: ${rs.arp_count} · PPP: ${rs.active_count}/${rs.secret_count}</div>`
          }
        </div>
      `).join('') +
      '</div>';
  }

  renderAdTab();
}

window.switchAdTab = function(tab) {
  _adCurrentTab = tab;
  document.querySelectorAll('.ad-tab').forEach(b => {
    if (b.dataset.adtab === tab) {
      b.classList.add('ad-tab-active');
      b.style.borderBottom = '2.5px solid #1a6ef5';
      b.style.color = '#1a6ef5';
      b.style.fontWeight = '700';
    } else {
      b.classList.remove('ad-tab-active');
      b.style.borderBottom = '2.5px solid transparent';
      b.style.color = 'var(--d-muted)';
      b.style.fontWeight = '600';
    }
  });
  renderAdTab();
};

function renderAdTab() {
  const tab = _adCurrentTab;
  const r = _autoDetectResult;
  const el = document.getElementById('adTabContent');
  if (!el || !r) return;

  // Method badge style helper
  const methodBadge = (m) => {
    const map = {
      arp:         { label: 'ARP',         bg: '#dbeafe', color: '#1d4ed8' },
      active_ppp:  { label: 'Active PPP',  bg: '#d1fae5', color: '#047857' },
      ppp_secret:  { label: 'PPP Secret',  bg: '#fef3c7', color: '#92400e' }
    };
    const o = map[m] || { label: m, bg: '#e2e8f0', color: '#475569' };
    return `<span style="display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;background:${o.bg};color:${o.color};">${o.label}</span>`;
  };

  if (tab === 'detected') {
    if (r.detected.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:30px 14px;font-size:12px;">Tidak ada pelanggan yang berhasil terdeteksi.<br><span style="font-size:11px;color:var(--d-muted);">Pastikan pelanggan online (untuk ARP) atau PPPoE secret sudah dibuat di router.</span></div>';
      document.getElementById('adApplyBtn').style.display = 'none';
      return;
    }
    // Header row dengan "Select all" checkbox
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1.5px solid var(--d-border);background:#fff;position:sticky;top:0;z-index:1;">
        <input type="checkbox" id="adSelectAll" checked onchange="toggleAdSelectAll(this.checked)" style="width:15px;height:15px;cursor:pointer;">
        <label for="adSelectAll" style="font-size:11.5px;font-weight:700;color:#0d1b3e;cursor:pointer;flex:1;">Pilih semua (${r.detected.length})</label>
        <span style="font-size:11.5px;color:var(--d-muted);"><span id="adSelectedCount">${_adSelectedIds.size}</span> dipilih</span>
      </div>
    ` + r.detected.map(d => {
      const checked = _adSelectedIds.has(d.customer_id);
      const target = d.static_ip
        ? `<span class="ip-tag">${_esc(d.static_ip)}</span>`
        : `<span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;">PPPoE: ${_esc(d.pppoe_username)}</span>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e8eef9;background:#fff;">
        <input type="checkbox" data-adcid="${d.customer_id}" ${checked?'checked':''} onchange="toggleAdSelectOne(${d.customer_id}, this.checked)" style="width:15px;height:15px;cursor:pointer;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12.5px;color:#0d1b3e;">${_esc(d.name)} <span style="color:#94a3b8;font-weight:500;">· ${_esc(d.cid)}</span></div>
          <div style="font-size:11px;color:var(--d-muted);margin-top:2px;">${d.evidence ? _esc(d.evidence) : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;">
          ${target}
          ${methodBadge(d.method)}
        </div>
        <div style="font-size:11.5px;font-weight:700;color:#1d4ed8;flex-shrink:0;min-width:80px;text-align:right;">→ ${_esc(d.suggested_device_name)}</div>
      </div>`;
    }).join('');

    // Show apply button
    const btn = document.getElementById('adApplyBtn');
    btn.style.display = '';
    _setText('adApplyCount', _adSelectedIds.size);
  } else if (tab === 'conflicts') {
    document.getElementById('adApplyBtn').style.display = 'none';
    if (r.conflicts.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:30px 14px;font-size:12px;">Tidak ada konflik 🎉</div>';
      return;
    }
    el.innerHTML = r.conflicts.map(c => `
      <div style="padding:10px 14px;border-bottom:1px solid #e8eef9;background:#fff;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <div style="font-weight:700;font-size:12.5px;color:#0d1b3e;flex:1;">${_esc(c.name)} <span style="color:#94a3b8;font-weight:500;">· ${_esc(c.cid)}</span></div>
          <span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;">PPPoE: ${_esc(c.pppoe_username||'-')}</span>
        </div>
        <div style="font-size:11px;color:#dc2626;margin-bottom:6px;">⚠ ${_esc(c.evidence)}</div>
        <div style="font-size:11px;color:var(--d-muted);">Pilih router manual di halaman Edit Pelanggan</div>
      </div>
    `).join('');
  } else if (tab === 'nomatch') {
    document.getElementById('adApplyBtn').style.display = 'none';
    if (r.no_match.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:30px 14px;font-size:12px;">Semua pelanggan ketemu router-nya 🎉</div>';
      return;
    }
    el.innerHTML = r.no_match.map(c => {
      const target = c.static_ip
        ? `<span class="ip-tag">${_esc(c.static_ip)}</span>`
        : (c.pppoe_username ? `<span class="ip-tag" style="background:#fef3c7;border-color:#fde68a;color:#92400e;">PPPoE: ${_esc(c.pppoe_username)}</span>` : '');
      return `<div style="padding:10px 14px;border-bottom:1px solid #e8eef9;background:#fff;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;font-size:12.5px;color:#0d1b3e;">${_esc(c.name)} <span style="color:#94a3b8;font-weight:500;">· ${_esc(c.cid)}</span></div>
            <div style="font-size:11px;color:var(--d-muted);margin-top:2px;">${_esc(c.reason)}</div>
          </div>
          ${target}
        </div>
      </div>`;
    }).join('');
  }
}

window.toggleAdSelectAll = function(checked) {
  if (!_autoDetectResult) return;
  if (checked) {
    _adSelectedIds = new Set(_autoDetectResult.detected.map(d => d.customer_id));
  } else {
    _adSelectedIds = new Set();
  }
  // Update checkboxes
  document.querySelectorAll('[data-adcid]').forEach(cb => {
    const cid = parseInt(cb.dataset.adcid);
    cb.checked = _adSelectedIds.has(cid);
  });
  _setText('adSelectedCount', _adSelectedIds.size);
  _setText('adApplyCount', _adSelectedIds.size);
};

window.toggleAdSelectOne = function(cid, checked) {
  if (checked) _adSelectedIds.add(cid);
  else         _adSelectedIds.delete(cid);
  _setText('adSelectedCount', _adSelectedIds.size);
  _setText('adApplyCount', _adSelectedIds.size);
  // Update select-all state
  const sa = document.getElementById('adSelectAll');
  if (sa && _autoDetectResult) {
    sa.checked = _adSelectedIds.size === _autoDetectResult.detected.length;
  }
};

window.applyAutoDetect = async function() {
  if (!_autoDetectResult || _adSelectedIds.size === 0) return;

  const ok = await DigsDialog.confirm({
    type: 'warning',
    title: 'Terapkan Auto-Detect',
    message: `<strong>${_adSelectedIds.size} pelanggan</strong> akan di-assign router otomatis berdasarkan hasil scan.`,
    bullets: ['Field <code>mikrotik_id</code> akan terisi', 'Method ditandai sebagai auto-detected', 'Bisa diubah manual via Edit Pelanggan kapan saja'],
    confirmText: 'Terapkan',
    cancelText: 'Batal'
  });
  if (!ok) return;

  // Build decisions array
  const decisions = _autoDetectResult.detected
    .filter(d => _adSelectedIds.has(d.customer_id))
    .map(d => ({
      customer_id: d.customer_id,
      device_id:   d.suggested_device_id,
      method:      d.method
    }));

  App.showToast('Menerapkan...', 'info');
  const d = await App.api('/isolir/router-matcher/apply', {
    method: 'POST', body: JSON.stringify({ decisions })
  });
  if (d?.success) {
    closeModal('autoDetectModal');
    DigsDialog.success(`<strong>${d.applied} pelanggan</strong> berhasil di-assign router${d.failed > 0 ? `, ${d.failed} gagal` : ''}.`, 'Auto-Detect Berhasil');
    // Refresh data
    loadDueAlerts();
    loadEligible();
    loadStats();
  } else {
    DigsDialog.error(d?.message || 'Gagal apply', 'Auto-Detect Gagal');
  }
};

// ── Per-customer detect (tombol "🔍 Detect" di card Pelanggan Jatuh Tempo) ──
window.detectSingleRouter = async function(customerId, customerName) {
  const ok = await DigsDialog.confirm({
    type: 'info',
    title: 'Detect Router untuk Pelanggan',
    message: `Akan scan semua router untuk cari di mana <strong>${_esc(customerName)}</strong> terdaftar.`,
    bullets: ['Live scan via ARP & PPP table (~1-3 detik per router)', 'Hasil otomatis disimpan ke <code>mikrotik_id</code>'],
    confirmText: 'Scan',
    cancelText: 'Batal'
  });
  if (!ok) return;

  App.showToast('Scanning router...', 'info');
  try {
    const d = await App.api('/isolir/router-matcher/detect/' + customerId, { method: 'POST', body: '{}' });
    if (d?.success) {
      DigsDialog.success(
        `Pelanggan terdeteksi di <strong>${_esc(d.device_name)}</strong>.<br>` +
        `<span style="font-size:12px;color:var(--d-muted);">${_esc(d.evidence)}</span>`,
        'Router Ditemukan'
      );
      loadDueAlerts();
      loadEligible();
    } else {
      const summary = (d.cache_summary || []).map(s =>
        `${s.name}: ARP ${s.arp_count} · PPP ${s.active_count}/${s.secret_count}`).join('\n');
      DigsDialog.alert({
        type: 'warning',
        title: d.conflict ? 'Konflik Detected' : 'Tidak Ditemukan',
        message: d.evidence || 'Pelanggan tidak terdeteksi di router manapun.',
        log: summary ? summary.split('\n') : null
      });
    }
  } catch (e) {
    DigsDialog.error(e.message, 'Detect Error');
  }
};
