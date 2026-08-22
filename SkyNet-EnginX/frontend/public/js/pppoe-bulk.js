/**
 * pppoe-bulk.js
 * ─────────────────────────────────────────────────────────────────────────────
 * UI bulk provisioning user PPPoE ke MikroTik.
 *
 * Dipakai di halaman /monitoring/pppoe. Modul ini self-contained: memasang
 * modal + progress panel sendiri ke <body>, jadi cukup di-include tanpa
 * mengubah banyak markup halaman.
 *
 * DESAIN PENTING:
 *
 * 1. Job jalan di SERVER, bukan di browser.
 *    Modal boleh ditutup, tab boleh di-refresh — job tetap berjalan.
 *    Saat halaman dibuka lagi, activeJobId dipulihkan dari localStorage
 *    dan polling dilanjutkan.
 *
 * 2. Polling, bukan WebSocket.
 *    Interval 2 detik sudah cukup responsif untuk operasi yang berjalan
 *    menit-menit, dan jauh lebih tahan terhadap koneksi putus-nyambung.
 *
 * 3. Password TIDAK ditampilkan di tabel progress.
 *    Endpoint /items memang tidak mengirimnya. Untuk mengambil password
 *    hasil auto-generate, operator download laporan .xlsx.
 *
 * Penggunaan:
 *   PppoeBulk.open();            // buka wizard
 *   PppoeBulk.resumeIfAny();     // dipanggil saat halaman load
 */

(function () {
  'use strict';

  var API = '/api/pppoe/bulk';
  var LS_KEY = 'flaynet_pppoe_bulk_active_job';

  var state = {
    step: 1,              // 1=upload, 2=preview, 3=progress
    jobId: null,
    deviceId: null,
    deviceName: '',
    preview: null,
    pollTimer: null,
    itemFilter: 'all',
    itemPage: 1,
  };

  // ── Util ───────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  function fmtEta(sec) {
    if (sec == null || sec < 0) return '-';
    if (sec < 60) return sec + ' detik';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + s + 's';
    return Math.floor(m / 60) + 'j ' + (m % 60) + 'm';
  }

  function toast(msg, type) {
    if (window.showToast) return window.showToast(msg, type || 'info');
    if (window.Swal) {
      return window.Swal.fire({
        toast: true, position: 'top-end', showConfirmButton: false,
        timer: 3000, icon: type === 'error' ? 'error' : 'success', title: msg
      });
    }
    console.log('[PppoeBulk] ' + msg);
  }

  async function api(url, opts) {
    var res = await fetch(url, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts || {}));
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok && res.status !== 202) {
      throw new Error(json.message || ('HTTP ' + res.status));
    }
    return json;
  }

  // ── Dialog konfirmasi kustom ───────────────────────────────────────────────
  /**
   * Pengganti window.confirm / window.prompt bawaan browser.
   *
   * Kenapa tidak pakai bawaan? Dialog native tidak bisa di-styling, tampil
   * berbeda di tiap OS/browser, dan memblokir thread UI sehingga polling
   * progress ikut berhenti selama dialog terbuka.
   *
   * Mengembalikan Promise:
   *   - mode confirm : true (OK) / false (batal)
   *   - mode prompt  : string isi input / null (batal)
   *
   * Opsi:
   *   { title, message, note, tone, icon, okText, cancelText, prompt, defaultValue, placeholder }
   *   tone: 'danger' | 'warn' | 'info'  — menentukan warna
   *   icon: 'danger' | 'warn' | 'info' | 'upload' | 'edit'  — opsional, default ikut tone
   */
  function dialog(opt) {
    opt = opt || {};
    var tone = opt.tone || 'info';
    var isPrompt = !!opt.prompt;

    return new Promise(function (resolve) {
      var el = document.createElement('div');
      el.className = 'pb-cf ' + tone;

      // Ikon dipisah dari `tone` supaya warna dan simbol bisa dikombinasikan
      // bebas — mis. aksi "jalankan" pakai warna biru tapi ikon panah,
      // bukan lingkaran informasi.
      var ICONS = {
        danger: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
        warn:   '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        info:   '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        // Panah ke atas dari kotak — konsisten dengan ikon tombol "Bulk Create"
        upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/>',
        edit:   '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>'
      };

      el.innerHTML = [
        '<div class="pb-cf-bd"></div>',
        '<div class="pb-cf-cd" role="dialog" aria-modal="true">',
        '  <div class="pb-cf-bdy">',
        '    <div class="pb-cf-ic"><svg viewBox="0 0 24 24">' + (ICONS[opt.icon] || ICONS[tone] || ICONS.info) + '</svg></div>',
        '    <h4 class="pb-cf-ti">' + esc(opt.title || 'Konfirmasi') + '</h4>',
        '    <p class="pb-cf-ms">' + (opt.message || '') + '</p>',
        opt.note ? '    <div class="pb-cf-nt">' + opt.note + '</div>' : '',
        isPrompt ? '    <input class="pb-cf-in" type="text" value="' + esc(opt.defaultValue || '') +
                   '" placeholder="' + esc(opt.placeholder || '') + '">' : '',
        '  </div>',
        '  <div class="pb-cf-ft">',
        '    <button class="pb-cf-b c" data-a="cancel">' + esc(opt.cancelText || 'Batal') + '</button>',
        '    <button class="pb-cf-b k" data-a="ok">' + esc(opt.okText || 'Lanjutkan') + '</button>',
        '  </div>',
        '</div>',
      ].join('');

      document.body.appendChild(el);

      var input = el.querySelector('.pb-cf-in');
      var done = false;

      function finish(val) {
        if (done) return;
        done = true;
        el.classList.remove('show');
        document.removeEventListener('keydown', onKey);
        // Tunggu transisi keluar selesai sebelum melepas elemen
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 240);
        resolve(val);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(isPrompt ? null : false); }
        else if (e.key === 'Enter' && (isPrompt || document.activeElement !== el.querySelector('[data-a=cancel]'))) {
          e.preventDefault();
          finish(isPrompt ? (input ? input.value.trim() : '') : true);
        }
      }

      el.querySelector('[data-a=ok]').onclick = function () {
        finish(isPrompt ? (input ? input.value.trim() : '') : true);
      };
      el.querySelector('[data-a=cancel]').onclick = function () {
        finish(isPrompt ? null : false);
      };
      el.querySelector('.pb-cf-bd').onclick = function () {
        finish(isPrompt ? null : false);
      };
      document.addEventListener('keydown', onKey);

      // Paksa reflow supaya transisi masuk benar-benar terpicu,
      // lalu fokuskan elemen yang paling relevan.
      requestAnimationFrame(function () {
        el.offsetHeight;
        el.classList.add('show');
        setTimeout(function () {
          if (input) { input.focus(); input.select(); }
          else el.querySelector('[data-a=ok]').focus();
        }, 180);
      });
    });
  }

  // ── Injeksi markup + style ─────────────────────────────────────────────────
  function ensureDom() {
    if ($('pbWrap')) return;

    var css = document.createElement('style');
    css.textContent = [
      '.pb-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(2px);z-index:9998;display:none;align-items:center;justify-content:center;padding:16px}',
      '.pb-ov.show{display:flex}',
      '.pb-md{background:#fff;border-radius:16px;width:100%;max-width:860px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(15,23,42,.25);font-family:"Plus Jakarta Sans",sans-serif}',
      '.pb-hd{padding:18px 22px;border-bottom:1px solid #e8eaed;display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.pb-hd h3{margin:0;font-size:17px;font-weight:800;color:#0f172a}',
      '.pb-hd p{margin:3px 0 0;font-size:12.5px;color:#64748b}',
      '.pb-x{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:9px;cursor:pointer;font-size:18px;color:#64748b;line-height:1}',
      '.pb-x:hover{background:#e2e8f0}',
      '.pb-bd{padding:20px 22px;overflow-y:auto;flex:1}',
      '.pb-ft{padding:14px 22px;border-top:1px solid #e8eaed;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      '.pb-btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:1.5px solid;font-family:inherit;transition:all .15s}',
      '.pb-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.pb-btn-p{background:#2563eb;border-color:#2563eb;color:#fff}.pb-btn-p:hover:not(:disabled){background:#1d4ed8}',
      '.pb-btn-o{background:#fff;border-color:#e2e8f0;color:#374151}.pb-btn-o:hover:not(:disabled){background:#f8fafc}',
      '.pb-btn-r{background:#dc2626;border-color:#dc2626;color:#fff}.pb-btn-r:hover:not(:disabled){background:#b91c1c}',
      '.pb-btn-a{background:#d97706;border-color:#d97706;color:#fff}.pb-btn-a:hover:not(:disabled){background:#b45309}',
      '.pb-fg{margin-bottom:16px}',
      '.pb-fg label{display:block;font-size:12.5px;font-weight:700;color:#334155;margin-bottom:6px}',
      '.pb-fg select,.pb-fg input[type=number],.pb-fg input[type=file]{width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13px;font-family:inherit;background:#fff}',
      '.pb-hint{font-size:11.5px;color:#94a3b8;margin-top:5px;line-height:1.5}',
      '.pb-drop{border:2px dashed #cbd5e1;border-radius:14px;padding:26px;text-align:center;background:#f8fafc;cursor:pointer;transition:all .15s}',
      '.pb-drop:hover,.pb-drop.over{border-color:#2563eb;background:#eff6ff}',
      '.pb-drop .n{font-size:13.5px;font-weight:700;color:#334155}',
      '.pb-drop .s{font-size:12px;color:#94a3b8;margin-top:4px}',
      '.pb-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:18px}',
      '.pb-st{background:#f8fafc;border:1px solid #e8eaed;border-radius:12px;padding:12px 14px}',
      '.pb-st .v{font-size:21px;font-weight:800;line-height:1.1}',
      '.pb-st .l{font-size:11px;color:#64748b;font-weight:600;margin-top:3px;text-transform:uppercase;letter-spacing:.3px}',
      '.pb-al{border-radius:11px;padding:12px 14px;font-size:12.5px;margin-bottom:14px;line-height:1.6}',
      '.pb-al-w{background:#fffbeb;border:1px solid #fde68a;color:#92400e}',
      '.pb-al-e{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}',
      '.pb-al-i{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}',
      '.pb-al b{font-weight:800}',
      '.pb-tbw{border:1px solid #e8eaed;border-radius:12px;overflow:auto;max-height:340px}',
      '.pb-tb{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.pb-tb th{background:#f8fafc;padding:9px 11px;text-align:left;font-weight:700;color:#475569;position:sticky;top:0;border-bottom:1px solid #e8eaed;white-space:nowrap;font-size:11.5px}',
      '.pb-tb td{padding:8px 11px;border-bottom:1px solid #f1f5f9;color:#334155;vertical-align:top}',
      '.pb-tb tr:last-child td{border-bottom:none}',
      '.pb-bg{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10.5px;font-weight:700;white-space:nowrap}',
      '.pb-bg.ok{background:#dcfce7;color:#15803d}',
      '.pb-bg.failed{background:#fee2e2;color:#b91c1c}',
      '.pb-bg.skipped{background:#fef3c7;color:#b45309}',
      '.pb-bg.pending{background:#f1f5f9;color:#64748b}',
      '.pb-pr{height:10px;background:#e2e8f0;border-radius:20px;overflow:hidden;margin:10px 0 6px}',
      '.pb-pr i{display:block;height:100%;background:linear-gradient(90deg,#2563eb,#3b82f6);border-radius:20px;transition:width .4s ease}',
      '.pb-pr.done i{background:linear-gradient(90deg,#16a34a,#22c55e)}',
      '.pb-prm{display:flex;justify-content:space-between;font-size:12px;color:#64748b;font-weight:600}',
      '.pb-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}',
      '.pb-tab{padding:6px 13px;border-radius:20px;font-size:12px;font-weight:700;cursor:pointer;border:1.5px solid #e2e8f0;background:#fff;color:#64748b;font-family:inherit}',
      '.pb-tab.on{background:#2563eb;border-color:#2563eb;color:#fff}',
      '.pb-opt{display:grid;grid-template-columns:1fr 1fr;gap:14px}',
      '@media(max-width:600px){.pb-opt{grid-template-columns:1fr}}',
      '.pb-chk{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:#334155;cursor:pointer;padding:9px 0}',
      '.pb-chk input{margin-top:2px;width:16px;height:16px;cursor:pointer}',
      '.pb-chk .t{font-weight:700}.pb-chk .d{font-size:11.5px;color:#94a3b8;margin-top:2px;line-height:1.5}',
      /* ══ Dialog konfirmasi kustom ══════════════════════════════ */
      /* Menggantikan window.confirm/prompt bawaan browser yang tidak
         bisa di-styling dan tampil beda-beda di tiap OS. */
      '.pb-cf{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;pointer-events:none;transition:opacity .22s cubic-bezier(.4,0,.2,1)}',
      '.pb-cf.show{opacity:1;pointer-events:auto}',
      '.pb-cf-bd{position:absolute;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}',
      /* Kartu: masuk dengan scale + translate, keluar lebih cepat */
      '.pb-cf-cd{position:relative;background:#fff;border-radius:20px;width:100%;max-width:452px;box-shadow:0 24px 64px rgba(15,23,42,.28),0 2px 8px rgba(15,23,42,.08);font-family:"Plus Jakarta Sans",sans-serif;overflow:hidden;transform:translateY(16px) scale(.94);opacity:0;transition:transform .32s cubic-bezier(.16,1,.3,1),opacity .24s ease}',
      '.pb-cf.show .pb-cf-cd{transform:translateY(0) scale(1);opacity:1}',
      '.pb-cf-bdy{padding:30px 28px 22px;text-align:center}',
      /* Ikon dengan cincin berdenyut sekali saat muncul */
      '.pb-cf-ic{width:58px;height:58px;border-radius:50%;background:var(--pbc-l);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;position:relative;transform:scale(.5);opacity:0;transition:transform .42s cubic-bezier(.34,1.56,.64,1) .06s,opacity .3s ease .06s}',
      '.pb-cf.show .pb-cf-ic{transform:scale(1);opacity:1}',
      '.pb-cf-ic svg{width:27px;height:27px;stroke:var(--pbc);stroke-width:2.2;fill:none;stroke-linecap:round;stroke-linejoin:round;position:relative;z-index:1}',
      '.pb-cf-ic::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--pbc);opacity:0}',
      '.pb-cf.show .pb-cf-ic::after{animation:pbRing .9s cubic-bezier(.4,0,.2,1) .22s}',
      '@keyframes pbRing{0%{transform:scale(.85);opacity:.5}100%{transform:scale(1.25);opacity:0}}',
      /* Judul & teks naik sedikit, sedikit tertunda dari ikon */
      '.pb-cf-ti{font-size:18px;font-weight:800;color:#0f172a;margin:0 0 9px;letter-spacing:-.01em;transform:translateY(8px);opacity:0;transition:transform .34s cubic-bezier(.16,1,.3,1) .1s,opacity .3s ease .1s}',
      '.pb-cf.show .pb-cf-ti{transform:none;opacity:1}',
      '.pb-cf-ms{font-size:13.5px;line-height:1.65;color:#64748b;margin:0;transform:translateY(8px);opacity:0;transition:transform .34s cubic-bezier(.16,1,.3,1) .14s,opacity .3s ease .14s}',
      '.pb-cf.show .pb-cf-ms{transform:none;opacity:1}',
      '.pb-cf-ms b{color:#334155;font-weight:800}',
      /* Kotak sorotan untuk info penting (mis. jumlah yang akan dihapus) */
      '.pb-cf-nt{margin-top:15px;padding:11px 14px;border-radius:11px;background:var(--pbc-l);border:1px solid var(--pbc-b);font-size:12.5px;line-height:1.6;color:var(--pbc-t);text-align:left;transform:translateY(8px);opacity:0;transition:transform .34s cubic-bezier(.16,1,.3,1) .18s,opacity .3s ease .18s}',
      '.pb-cf.show .pb-cf-nt{transform:none;opacity:1}',
      /* Input untuk mode prompt */
      '.pb-cf-in{width:100%;margin-top:16px;padding:11px 14px;border:1.5px solid #e2e8f0;border-radius:11px;font-size:13.5px;font-family:inherit;color:#0f172a;text-align:center;font-weight:600;transition:border-color .18s,box-shadow .18s;transform:translateY(8px);opacity:0}',
      '.pb-cf.show .pb-cf-in{transform:none;opacity:1;transition:transform .34s cubic-bezier(.16,1,.3,1) .18s,opacity .3s ease .18s,border-color .18s,box-shadow .18s}',
      '.pb-cf-in:focus{outline:none;border-color:var(--pbc);box-shadow:0 0 0 3.5px var(--pbc-l)}',
      /* Tombol aksi */
      '.pb-cf-ft{display:flex;gap:10px;padding:8px 28px 26px;transform:translateY(8px);opacity:0;transition:transform .34s cubic-bezier(.16,1,.3,1) .22s,opacity .3s ease .22s}',
      '.pb-cf.show .pb-cf-ft{transform:none;opacity:1}',
      '.pb-cf-b{flex:1;padding:12px 18px;border-radius:12px;font-size:13.5px;font-weight:700;cursor:pointer;border:1.5px solid;font-family:inherit;transition:transform .14s cubic-bezier(.4,0,.2,1),box-shadow .18s,background .16s,border-color .16s}',
      '.pb-cf-b:active{transform:scale(.975)}',
      '.pb-cf-b:focus-visible{outline:none;box-shadow:0 0 0 3.5px var(--pbc-l)}',
      '.pb-cf-b.c{background:#fff;border-color:#e2e8f0;color:#475569}',
      '.pb-cf-b.c:hover{background:#f8fafc;border-color:#cbd5e1}',
      '.pb-cf-b.k{background:var(--pbc);border-color:var(--pbc);color:#fff;box-shadow:0 2px 10px var(--pbc-s)}',
      '.pb-cf-b.k:hover{filter:brightness(.93);box-shadow:0 4px 16px var(--pbc-s)}',
      /* Varian warna */
      '.pb-cf.danger{--pbc:#dc2626;--pbc-l:#fef2f2;--pbc-b:#fecaca;--pbc-t:#991b1b;--pbc-s:rgba(220,38,38,.32)}',
      '.pb-cf.warn{--pbc:#d97706;--pbc-l:#fffbeb;--pbc-b:#fde68a;--pbc-t:#92400e;--pbc-s:rgba(217,119,6,.32)}',
      '.pb-cf.info{--pbc:#2563eb;--pbc-l:#eff6ff;--pbc-b:#bfdbfe;--pbc-t:#1e40af;--pbc-s:rgba(37,99,235,.32)}',
      '@media(max-width:520px){.pb-cf-ft{flex-direction:column-reverse}.pb-cf-bdy{padding:26px 22px 18px}.pb-cf-ft{padding:8px 22px 22px}}',
      /* Hormati preferensi pengguna yang mematikan animasi */
      '@media(prefers-reduced-motion:reduce){.pb-cf,.pb-cf-cd,.pb-cf-ic,.pb-cf-ti,.pb-cf-ms,.pb-cf-nt,.pb-cf-in,.pb-cf-ft{transition-duration:.01ms!important}.pb-cf.show .pb-cf-ic::after{animation:none}}',
      /* Indikator kecil di pojok saat modal ditutup tapi job jalan */
      '.pb-mini{position:fixed;bottom:20px;right:20px;background:#fff;border:1px solid #e8eaed;border-radius:14px;padding:12px 16px;box-shadow:0 8px 28px rgba(15,23,42,.16);z-index:9990;display:none;cursor:pointer;min-width:230px;font-family:"Plus Jakarta Sans",sans-serif}',
      '.pb-mini.show{display:block}',
      '.pb-mini .t{font-size:12.5px;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:7px}',
      '.pb-mini .dot{width:8px;height:8px;border-radius:50%;background:#2563eb;animation:pbpulse 1.6s infinite}',
      '@keyframes pbpulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.pb-mini .s{font-size:11.5px;color:#64748b;margin-top:3px}',
    ].join('');
    document.head.appendChild(css);

    var wrap = document.createElement('div');
    wrap.id = 'pbWrap';
    wrap.innerHTML = [
      '<div class="pb-ov" id="pbOv">',
      '  <div class="pb-md">',
      '    <div class="pb-hd">',
      '      <div>',
      '        <h3 id="pbTitle">Bulk Create User PPPoE</h3>',
      '        <p id="pbSub">Buat ratusan hingga ribuan akun sekaligus ke MikroTik</p>',
      '      </div>',
      '      <button class="pb-x" onclick="PppoeBulk.close()">&times;</button>',
      '    </div>',
      '    <div class="pb-bd" id="pbBody"></div>',
      '    <div class="pb-ft" id="pbFoot"></div>',
      '  </div>',
      '</div>',
      '<div class="pb-mini" id="pbMini" onclick="PppoeBulk.open()">',
      '  <div class="t"><span class="dot"></span><span id="pbMiniT">Provisioning berjalan</span></div>',
      '  <div class="s" id="pbMiniS">-</div>',
      '</div>',
    ].join('');
    document.body.appendChild(wrap);

    $('pbOv').addEventListener('click', function (e) {
      if (e.target === this) close();
    });
  }

  // ── STEP 1: Upload ─────────────────────────────────────────────────────────
  function renderStep1() {
    state.step = 1;
    $('pbTitle').textContent = 'Bulk Create User PPPoE';
    $('pbSub').textContent = 'Langkah 1 dari 3 — pilih router & upload data';

    var devId = (window.MikrotikSelector && window.MikrotikSelector.getSelectedId)
      ? window.MikrotikSelector.getSelectedId() : null;

    $('pbBody').innerHTML = [
      '<div class="pb-al pb-al-i">',
      '  <b>Sebelum mulai:</b> pastikan PPP Profile (paket kecepatan) sudah dibuat di router tujuan. ',
      '  Baris yang merujuk profile belum ada akan ditandai gagal saat pratinjau.',
      '</div>',
      '<div class="pb-fg">',
      '  <label>Router Tujuan</label>',
      '  <select id="pbDev"><option value="">Memuat daftar router...</option></select>',
      '  <div class="pb-hint">User PPPoE akan dibuat di router ini.</div>',
      '</div>',
      '<div class="pb-fg">',
      '  <label>Sumber Data</label>',
      '  <div class="pb-drop" id="pbDrop">',
      '    <div class="n" id="pbDropN">Klik atau seret file Excel ke sini</div>',
      '    <div class="s">Format .xlsx atau .xls — maksimal 10 MB</div>',
      '  </div>',
      '  <input type="file" id="pbFile" accept=".xlsx,.xls" style="display:none">',
      '  <div class="pb-hint">',
      '    Belum punya file? <a href="' + API + '/template" style="color:#2563eb;font-weight:700">Download template Excel</a>',
      '  </div>',
      '</div>',
      '<div class="pb-al pb-al-w" style="margin-bottom:0">',
      '  <b>Alternatif:</b> kalau data pelanggan sudah ada di CRM dan Anda hanya perlu ',
      '  mendorongnya ke router baru, gunakan tombol <b>Dari Data Customer</b> di bawah — tanpa perlu Excel.',
      '</div>',
    ].join('');

    $('pbFoot').innerHTML = [
      '<button class="pb-btn pb-btn-o" onclick="PppoeBulk.fromCustomers()">Dari Data Customer</button>',
      '<button class="pb-btn pb-btn-o" onclick="PppoeBulk.close()">Batal</button>',
      '<button class="pb-btn pb-btn-p" id="pbNext" onclick="PppoeBulk.doPreview()" disabled>Pratinjau</button>',
    ].join('');

    // Drag & drop
    var drop = $('pbDrop'), file = $('pbFile');
    drop.onclick = function () { file.click(); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    drop.ondrop = function (e) {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files.length) {
        file.files = e.dataTransfer.files;
        onFilePicked();
      }
    };
    file.onchange = onFilePicked;

    loadDevices(devId);
  }

  function onFilePicked() {
    var f = $('pbFile').files[0];
    if (!f) return;
    $('pbDropN').textContent = f.name;
    $('pbNext').disabled = !$('pbDev').value;
  }

  /**
   * Muat daftar router MikroTik ke dropdown.
   *
   * PENTING: endpoint yang benar adalah /api/devices/mikrotik-list.
   * Jangan pakai /api/devices?type=mikrotik — di database, kolom
   * devices.type berisi 'router', BUKAN 'mikrotik', jadi filter itu
   * selalu mengembalikan array kosong.
   *
   * /devices/mikrotik-list sudah memfilter type='router' + is_active=true
   * dan menandai router primary. Ini endpoint yang sama dengan yang
   * dipakai mikrotik-selector.js.
   */
  async function loadDevices(preselect) {
    var sel = $('pbDev');
    try {
      var j = await api('/api/devices/mikrotik-list');
      var list = j.data || [];

      // Fallback: kalau mikrotik-list kosong, coba endpoint umum lalu
      // saring sendiri. Berguna kalau ada router yang is_active=false
      // atau instalasi lama dengan nilai type berbeda.
      if (!list.length) {
        var j2 = await api('/api/devices?limit=200').catch(function () { return {}; });
        var all = j2.data || j2.devices || [];
        list = all.filter(function (d) {
          var t = String(d.type || '').toLowerCase();
          return t === 'router' || t === 'mikrotik';
        });
      }

      if (!list.length) {
        sel.innerHTML = '<option value="">Tidak ada router terdaftar</option>';
        return;
      }

      // Kalau selector halaman belum memilih apa pun, pakai router primary
      var fallback = null;
      list.forEach(function (d) { if (d.is_primary) fallback = d.id; });
      var chosen = preselect || fallback;

      sel.innerHTML = '<option value="">— Pilih router —</option>' +
        list.map(function (d) {
          var label = esc(d.name || ('Device #' + d.id));
          if (d.ip_address) label += ' (' + esc(d.ip_address) + ')';
          if (d.is_primary) label += ' \u2605';
          var off = d.status && String(d.status).toLowerCase() === 'offline';
          return '<option value="' + d.id + '"' +
                 (String(d.id) === String(chosen) ? ' selected' : '') + '>' +
                 label + (off ? ' — offline' : '') + '</option>';
        }).join('');

      sel.onchange = function () {
        $('pbNext').disabled = !this.value || !$('pbFile').files.length;
      };
      if (chosen) $('pbNext').disabled = !$('pbFile').files.length;
    } catch (e) {
      sel.innerHTML = '<option value="">Gagal memuat router — ' + esc(e.message) + '</option>';
    }
  }

  // ── STEP 2: Preview ────────────────────────────────────────────────────────
  async function doPreview() {
    var deviceId = $('pbDev').value;
    var file = $('pbFile').files[0];
    if (!deviceId || !file) return;

    var btn = $('pbNext');
    btn.disabled = true;
    btn.textContent = 'Memproses...';

    try {
      var fd = new FormData();
      fd.append('file', file);
      fd.append('device_id', deviceId);

      var res = await fetch(API + '/preview', {
        method: 'POST', body: fd, credentials: 'same-origin'
      });
      var j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.message || 'Gagal memproses file');

      state.jobId = j.job_id;
      state.deviceId = deviceId;
      state.deviceName = (j.router && j.router.name) || '';
      state.preview = j;
      renderStep2();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Pratinjau';
    }
  }

  function renderStep2() {
    state.step = 2;
    var p = state.preview, s = p.summary;

    $('pbTitle').textContent = 'Pratinjau & Opsi Eksekusi';
    $('pbSub').textContent = 'Langkah 2 dari 3 — periksa data sebelum dikirim ke router';

    var html = [];

    // Peringatan router offline
    if (p.router && !p.router.online) {
      html.push('<div class="pb-al pb-al-e"><b>Router tidak dapat dihubungi.</b> ' +
        'Validasi duplikat dan profile dilewati. ' + esc(p.router.error || '') +
        ' Job tetap bisa dibuat, tapi sebaiknya perbaiki koneksi dulu.</div>');
    }

    // Kartu ringkasan
    html.push('<div class="pb-stats">');
    html.push(stat(s.total, 'Total Baris', '#0f172a'));
    html.push(stat(s.ready, 'Siap Dibuat', '#16a34a'));
    html.push(stat(s.duplicateOnRouter, 'Sudah Ada', '#d97706'));
    html.push(stat(s.error, 'Bermasalah', '#dc2626'));
    html.push(stat(s.autoPassword, 'Password Auto', '#0891b2'));
    html.push('</div>');

    // Profile yang belum ada — penyebab kegagalan massal paling umum
    if (p.missing_profiles && p.missing_profiles.length) {
      html.push('<div class="pb-al pb-al-e"><b>Profile berikut belum ada di router:</b> ' +
        p.missing_profiles.map(esc).join(', ') +
        '.<br>Buat profile tersebut di menu PPP &rarr; Profiles, lalu upload ulang file. ' +
        'Baris yang memakai profile ini tidak akan diproses.' +
        (p.available_profiles && p.available_profiles.length
          ? '<br><br><b>Profile yang tersedia:</b> ' + p.available_profiles.map(esc).join(', ')
          : '') +
        '</div>');
    }

    if (s.duplicateOnRouter > 0) {
      html.push('<div class="pb-al pb-al-w"><b>' + s.duplicateOnRouter + ' username sudah ada di router.</b> ' +
        'Sesuai opsi di bawah, secret ini akan dilewati atau ditimpa.</div>');
    }

    if (!s.ready) {
      html.push('<div class="pb-al pb-al-e"><b>Tidak ada baris yang bisa diproses.</b> ' +
        'Perbaiki masalah di atas lalu upload ulang.</div>');
    }

    // Opsi eksekusi
    html.push('<div style="font-size:13px;font-weight:800;color:#0f172a;margin:20px 0 10px">Opsi Eksekusi</div>');
    html.push('<div class="pb-opt">');
    html.push([
      '<div class="pb-fg" style="margin:0">',
      '  <label>Jika username sudah ada</label>',
      '  <select id="pbDup">',
      '    <option value="skip">Lewati (aman — tidak menyentuh secret lama)</option>',
      '    <option value="overwrite">Timpa (update password & profile)</option>',
      '  </select>',
      '</div>',
      '<div class="pb-fg" style="margin:0">',
      '  <label>Concurrency (request paralel)</label>',
      '  <select id="pbConc">',
      '    <option value="1">1 — RB750 / hAP lite (paling aman)</option>',
      '    <option value="3" selected>3 — hEX / RB450G (disarankan)</option>',
      '    <option value="5">5 — CCR / RB1100 (router kuat)</option>',
      '  </select>',
      '</div>',
      '<div class="pb-fg" style="margin:0">',
      '  <label>Jeda antar batch (ms)</label>',
      '  <input type="number" id="pbDelay" value="120" min="0" max="2000" step="10">',
      '  <div class="pb-hint">Naikkan kalau CPU router melonjak saat proses.</div>',
      '</div>',
      '<div style="display:flex;flex-direction:column;justify-content:center">',
      '  <label class="pb-chk"><input type="checkbox" id="pbDry">',
      '    <span><span class="t">Dry run</span><span class="d">Simulasi tanpa menulis ke router. Pakai ini dulu untuk batch besar.</span></span>',
      '  </label>',
      '  <label class="pb-chk"><input type="checkbox" id="pbSync" checked>',
      '    <span><span class="t">Sinkron ke data customer</span><span class="d">Simpan username & router ke data pelanggan yang punya ID Pelanggan.</span></span>',
      '  </label>',
      '  <label class="pb-chk"><input type="checkbox" id="pbAdapt" checked>',
      '    <span><span class="t">Laju adaptif</span><span class="d">Otomatis melambat kalau router mulai kewalahan, lalu kembali normal saat stabil.</span></span>',
      '  </label>',
      '</div>',
      '<div class="pb-fg" style="margin:0;grid-column:1/-1">',
      '  <label>Jadwalkan (opsional)</label>',
      '  <input type="datetime-local" id="pbSchedule">',
      '  <div class="pb-hint">Kosongkan untuk jalan sekarang. Isi untuk menjalankan batch di luar jam sibuk — server akan menjalankannya otomatis pada waktu tersebut.</div>',
      '</div>',
    ].join(''));
    html.push('</div>');

    // Tabel baris
    html.push('<div style="font-size:13px;font-weight:800;color:#0f172a;margin:18px 0 10px">' +
      'Rincian Baris' + (p.truncated ? ' <span style="font-weight:600;color:#94a3b8;font-size:11.5px">(200 pertama)</span>' : '') +
      '</div>');
    html.push('<div class="pb-tbw"><table class="pb-tb"><thead><tr>' +
      '<th>#</th><th>Username</th><th>Profile</th><th>Pelanggan</th><th>Status</th><th>Catatan</th>' +
      '</tr></thead><tbody>');
    (p.rows || []).forEach(function (r) {
      var notes = (r.errors || []).concat(r.warnings || []);
      html.push('<tr>' +
        '<td>' + r.rowNumber + '</td>' +
        '<td style="font-family:monospace;font-weight:600">' + esc(r.username) + '</td>' +
        '<td>' + esc(r.profile) + '</td>' +
        '<td>' + esc(r.customer_name || r.customer_id || '-') + '</td>' +
        '<td><span class="pb-bg ' + (r.valid ? (r.duplicateOnRouter ? 'skipped' : 'ok') : 'failed') + '">' +
          (r.valid ? (r.duplicateOnRouter ? 'DUPLIKAT' : 'SIAP') : 'ERROR') + '</span></td>' +
        '<td style="font-size:11.5px;color:#64748b">' + esc(notes.join('; ') || '-') + '</td>' +
        '</tr>');
    });
    html.push('</tbody></table></div>');

    $('pbBody').innerHTML = html.join('');
    $('pbFoot').innerHTML = [
      '<button class="pb-btn pb-btn-o" onclick="PppoeBulk.back()">Kembali</button>',
      '<button class="pb-btn pb-btn-p" onclick="PppoeBulk.doStart()"' + (s.ready ? '' : ' disabled') + '>',
      '  Jalankan (' + s.ready + ' user)',
      '</button>',
    ].join('');
  }

  function stat(v, l, c) {
    return '<div class="pb-st"><div class="v" style="color:' + c + '">' + (v || 0) + '</div><div class="l">' + l + '</div></div>';
  }

  // ── STEP 3: Progress ───────────────────────────────────────────────────────
  async function doStart() {
    var dry  = $('pbDry').checked;
    var dup  = $('pbDup').value;
    var n    = (state.preview && state.preview.summary.ready) || 0;

    // Jadwal (opsional). datetime-local memberi waktu LOKAL tanpa zona —
    // ubah ke ISO supaya server menafsirkannya konsisten. Jadwal diabaikan
    // saat dry run (tidak masuk akal menunda simulasi).
    var scheduleRaw = $('pbSchedule') ? $('pbSchedule').value : '';
    var scheduledAt = null;
    if (scheduleRaw && !dry) {
      var when = new Date(scheduleRaw);
      if (isNaN(when.getTime())) {
        toast('Format waktu jadwal tidak valid', 'error');
        return;
      }
      if (when.getTime() <= Date.now() + 60000) {
        toast('Waktu jadwal harus lebih dari 1 menit ke depan', 'error');
        return;
      }
      scheduledAt = when.toISOString();
    }

    // Konfirmasi terakhir sebelum menulis ke router produksi.
    // Dilewati saat dry run — tidak ada yang berubah, jadi tidak perlu.
    if (!dry) {
      var ok = await dialog({
        tone: 'info',
        icon: scheduledAt ? 'clock' : 'upload',
        title: scheduledAt ? 'Jadwalkan Provisioning?' : 'Jalankan Provisioning?',
        message: '<b>' + n + ' user PPPoE</b> akan dibuat di router' +
                 (state.deviceName ? ' <b>' + esc(state.deviceName) + '</b>' : '') +
                 (scheduledAt ? ' pada <b>' + new Date(scheduledAt).toLocaleString('id-ID') + '</b>' : '') + '.',
        note: 'Mode duplikat: <b>' + (dup === 'overwrite' ? 'Timpa secret yang sudah ada' : 'Lewati yang sudah ada') + '</b>.<br>' +
              (scheduledAt
                ? 'Job akan dijalankan otomatis oleh server pada waktu tersebut. Bisa dibatalkan sebelum jatuh tempo.'
                : 'Proses berjalan di server — modal boleh ditutup. ' +
                  'Kalau ada yang salah, tersedia tombol Rollback setelah selesai.'),
        okText: scheduledAt ? 'Jadwalkan' : 'Jalankan Sekarang',
        cancelText: 'Periksa Lagi',
      });
      if (!ok) return;
    }

    try {
      var body = {
        dryRun:      dry,
        onDuplicate: dup,
        concurrency: parseInt($('pbConc').value),
        delayMs:     parseInt($('pbDelay').value) || 0,
        syncToCrm:   $('pbSync').checked,
        adaptiveThrottle: !$('pbAdapt') || $('pbAdapt').checked,
      };
      if (scheduledAt) body.scheduledAt = scheduledAt;

      var resp = await api(API + '/' + state.jobId + '/start', {
        method: 'POST', body: JSON.stringify(body)
      });
      localStorage.setItem(LS_KEY, state.jobId);

      // Job dijadwalkan (belum jalan) — beri tahu, jangan buka layar progress
      // seolah-olah sedang berjalan.
      if (resp && resp.scheduled) {
        toast(resp.message || 'Job dijadwalkan', 'success');
      }
      renderStep3();
      startPolling();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderStep3() {
    state.step = 3;
    $('pbTitle').textContent = 'Proses Provisioning';
    $('pbSub').textContent = 'Langkah 3 dari 3 — modal boleh ditutup, proses tetap berjalan di server';

    $('pbBody').innerHTML = [
      '<div id="pbProg"></div>',
      '<div class="pb-tabs" id="pbTabs" style="margin-top:18px">',
      '  <button class="pb-tab on" data-f="all">Semua</button>',
      '  <button class="pb-tab" data-f="ok">Berhasil</button>',
      '  <button class="pb-tab" data-f="failed">Gagal</button>',
      '  <button class="pb-tab" data-f="skipped">Dilewati</button>',
      '  <button class="pb-tab" data-f="pending">Menunggu</button>',
      '</div>',
      '<div class="pb-tbw" id="pbItems"><div style="padding:22px;text-align:center;color:#94a3b8;font-size:12.5px">Memuat...</div></div>',
    ].join('');

    Array.prototype.forEach.call($('pbTabs').children, function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call($('pbTabs').children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        state.itemFilter = b.dataset.f;
        loadItems();
      };
    });

    $('pbFoot').innerHTML = '<div style="flex:1"></div><button class="pb-btn pb-btn-o" onclick="PppoeBulk.close()">Tutup</button>';
    loadItems();
  }

  function startPolling() {
    stopPolling();
    tick();
    state.pollTimer = setInterval(tick, 2000);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function tick() {
    if (!state.jobId) return stopPolling();
    try {
      var j = await api(API + '/' + state.jobId + '/status');
      var d = j.data;
      renderProgress(d);
      updateMini(d);

      if (d.status === 'done' || d.status === 'failed') {
        stopPolling();
        localStorage.removeItem(LS_KEY);
        loadItems();
        if (d.status === 'done') {
          toast('Provisioning selesai: ' + d.succeeded + ' berhasil, ' + d.failed + ' gagal', 'success');
        }
      }
    } catch (e) {
      // Diamkan error polling sesaat — koneksi bisa putus-nyambung.
      console.warn('[PppoeBulk] poll:', e.message);
    }
  }

  function renderProgress(d) {
    var el = $('pbProg');
    if (!el) return;

    var LBL = {
      scheduled: 'Dijadwalkan', pending: 'Menunggu dijalankan', running: 'Sedang berjalan',
      paused: 'Dihentikan sementara', done: 'Selesai', failed: 'Gagal'
    };

    var html = [];
    if (d.options && d.options.dryRun) {
      html.push('<div class="pb-al pb-al-w" style="margin-bottom:12px"><b>Mode dry run.</b> ' +
        'Tidak ada perubahan yang ditulis ke router.</div>');
    }
    if (d.status === 'failed' && d.error_message) {
      html.push('<div class="pb-al pb-al-e"><b>Job gagal:</b> ' + esc(d.error_message) + '</div>');
    }

    // Pemberitahuan job yang dilanjutkan otomatis setelah restart server
    if (d.error_message && /restart|dilanjutkan otomatis|Terputus/i.test(d.error_message) && d.status !== 'failed') {
      html.push('<div class="pb-al pb-al-i" style="margin-bottom:12px">' + esc(d.error_message) + '</div>');
    }

    // Status throttle adaptif — hanya tampil kalau worker benar-benar
    // menyesuaikan diri, supaya tidak jadi noise di kondisi normal.
    if (d.throttle && d.throttle.throttled) {
      var t = d.throttle;
      html.push('<div class="pb-al pb-al-w" style="margin-bottom:12px">' +
        '<b>Laju disesuaikan otomatis.</b> Router menunjukkan tanda kewalahan, ' +
        'jadi worker menurunkan concurrency dari ' + t.base.concurrency + ' ke <b>' + t.current.concurrency + '</b>' +
        ' dan menaikkan jeda dari ' + t.base.delayMs + 'ms ke <b>' + t.current.delayMs + 'ms</b>.' +
        '<br><span style="font-size:11.5px;opacity:.85">Job tetap berjalan, hanya lebih pelan. ' +
        'Untuk batch berikutnya, mulai dari concurrency ' + t.current.concurrency + '.</span>' +
        '</div>');
    }

    // Hasil verifikasi pasca-job
    if (d.verification && !d.verification.error) {
      var v = d.verification;
      if (v.missing > 0) {
        html.push('<div class="pb-al pb-al-e" style="margin-bottom:12px">' +
          '<b>Verifikasi menemukan selisih.</b> ' + v.confirmed + ' dari ' + v.checked +
          ' secret terkonfirmasi ada di router, tapi <b>' + v.missing + ' tidak ditemukan</b> ' +
          'meski sempat dilaporkan berhasil.' +
          (v.missingUsernames && v.missingUsernames.length
            ? '<br><span style="font-size:11.5px">' + v.missingUsernames.slice(0, 8).map(esc).join(', ') +
              (v.missingUsernames.length > 8 ? ', …' : '') + '</span>'
            : '') +
          '<br><span style="font-size:11.5px;opacity:.85">Item ini sudah dikembalikan ke antrian — ' +
          'klik <b>Ulangi</b> untuk membuatnya lagi.</span></div>');
      } else if (v.checked > 0) {
        html.push('<div class="pb-al" style="margin-bottom:12px;background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d">' +
          '<b>Terverifikasi.</b> Semua ' + v.confirmed + ' secret dikonfirmasi ada di router' +
          (v.idRecovered ? ' (' + v.idRecovered + ' ID dipulihkan untuk keperluan rollback)' : '') +
          '.</div>');
      }
    }

    // Job dijadwalkan — tampilkan waktunya, belum ada progress.
    if (d.status === 'scheduled' && d.scheduled_at) {
      html.push('<div class="pb-al pb-al-i" style="margin-bottom:12px">' +
        '<b>Dijadwalkan.</b> Job akan dijalankan otomatis pada <b>' +
        esc(new Date(d.scheduled_at).toLocaleString('id-ID')) + '</b>. ' +
        'Modal boleh ditutup — server yang menjalankannya.</div>');
    }

    html.push('<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">');
    html.push('<div style="font-size:13.5px;font-weight:800;color:#0f172a">' + (LBL[d.status] || d.status) +
      ' <span style="font-weight:600;color:#94a3b8;font-size:12px">— ' + esc(d.device_name || '') + '</span></div>');
    html.push('<div style="font-size:12px;color:#64748b;font-weight:700">' +
      (d.status === 'running' && d.eta_seconds != null ? 'Sisa ± ' + fmtEta(d.eta_seconds) : '') + '</div>');
    html.push('</div>');

    html.push('<div class="pb-pr' + (d.status === 'done' ? ' done' : '') + '"><i style="width:' + d.percent + '%"></i></div>');
    html.push('<div class="pb-prm"><span>' + d.processed + ' / ' + d.total + ' diproses</span><span>' + d.percent + '%</span></div>');

    html.push('<div class="pb-stats" style="margin-top:16px">');
    html.push(stat(d.succeeded, 'Berhasil', '#16a34a'));
    html.push(stat(d.skipped, 'Dilewati', '#d97706'));
    html.push(stat(d.failed, 'Gagal', '#dc2626'));
    html.push(stat(d.pending, 'Menunggu', '#64748b'));
    html.push('</div>');

    el.innerHTML = html.join('');

    // Tombol aksi menyesuaikan status job
    var f = [];
    if (d.status === 'scheduled') {
      f.push('<button class="pb-btn pb-btn-a" onclick="PppoeBulk.doUnschedule()">Batalkan Jadwal</button>');
    }
    if (d.status === 'running') {
      f.push('<button class="pb-btn pb-btn-a" onclick="PppoeBulk.doPause()">Hentikan Sementara</button>');
    }
    if (d.status === 'paused' || d.status === 'pending') {
      f.push('<button class="pb-btn pb-btn-p" onclick="PppoeBulk.doResume()">Lanjutkan</button>');
    }
    if ((d.status === 'done' || d.status === 'paused' || d.status === 'failed') && d.failed > 0) {
      f.push('<button class="pb-btn pb-btn-a" onclick="PppoeBulk.doRetry()">Ulangi ' + d.failed + ' Gagal</button>');
    }
    if (d.status === 'done' && d.succeeded > 0 && !(d.options && d.options.dryRun)) {
      f.push('<button class="pb-btn pb-btn-r" onclick="PppoeBulk.doRollback()">Rollback</button>');
    }
    if ((d.status === 'done' || d.status === 'paused') && d.succeeded > 0 && !(d.options && d.options.dryRun)) {
      f.push('<button class="pb-btn pb-btn-o" onclick="PppoeBulk.doVerify()">Verifikasi Ulang</button>');
    }
    if (d.processed > 0) {
      f.push('<a class="pb-btn pb-btn-o" href="' + API + '/' + d.id + '/report" style="text-decoration:none">Unduh Laporan</a>');
    }
    f.push('<div style="flex:1"></div>');
    f.push('<button class="pb-btn pb-btn-o" onclick="PppoeBulk.close()">Tutup</button>');
    $('pbFoot').innerHTML = f.join('');
  }

  async function loadItems() {
    var el = $('pbItems');
    if (!el || !state.jobId) return;
    try {
      var j = await api(API + '/' + state.jobId + '/items?limit=200&status=' + state.itemFilter);
      var rows = j.data || [];
      if (!rows.length) {
        el.innerHTML = '<div style="padding:22px;text-align:center;color:#94a3b8;font-size:12.5px">Tidak ada data</div>';
        return;
      }
      el.innerHTML = '<table class="pb-tb"><thead><tr>' +
        '<th>Username</th><th>Profile</th><th>Pelanggan</th><th>Status</th><th>Keterangan</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr>' +
            '<td style="font-family:monospace;font-weight:600">' + esc(r.username) + '</td>' +
            '<td>' + esc(r.profile || '-') + '</td>' +
            '<td>' + esc(r.customer_name || r.customer_id || '-') + '</td>' +
            '<td><span class="pb-bg ' + r.status + '">' + r.status.toUpperCase() + '</span></td>' +
            '<td style="font-size:11.5px;color:#64748b">' + esc(r.error || '-') + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table>' +
        (j.pagination && j.pagination.total > rows.length
          ? '<div style="padding:9px;text-align:center;font-size:11.5px;color:#94a3b8">Menampilkan ' +
            rows.length + ' dari ' + j.pagination.total + ' — unduh laporan untuk data lengkap</div>'
          : '');
    } catch (e) {
      el.innerHTML = '<div style="padding:22px;text-align:center;color:#dc2626;font-size:12.5px">' + esc(e.message) + '</div>';
    }
  }

  function updateMini(d) {
    var m = $('pbMini');
    if (!m) return;
    var active = d && (d.status === 'running' || d.status === 'paused' || d.status === 'scheduled');
    var modalOpen = $('pbOv').classList.contains('show');
    if (active && !modalOpen) {
      m.classList.add('show');
      $('pbMiniT').textContent = d.status === 'paused' ? 'Provisioning dijeda'
        : d.status === 'scheduled' ? 'Provisioning dijadwalkan'
        : 'Provisioning berjalan';
      $('pbMiniS').textContent = d.status === 'scheduled'
        ? (d.scheduled_at ? new Date(d.scheduled_at).toLocaleString('id-ID') + ' (klik untuk buka)' : 'Menunggu jadwal (klik untuk buka)')
        : d.processed + '/' + d.total + ' — ' + d.percent + '% (klik untuk buka)';
    } else {
      m.classList.remove('show');
    }
  }

  // ── Aksi kontrol job ───────────────────────────────────────────────────────
  async function doPause() {
    try { await api(API + '/' + state.jobId + '/pause', { method: 'POST' }); tick(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function doResume() {
    try {
      await api(API + '/' + state.jobId + '/start', { method: 'POST', body: '{}' });
      startPolling();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function doUnschedule() {
    try {
      var j = await api(API + '/' + state.jobId + '/unschedule', { method: 'POST' });
      toast(j.message || 'Jadwal dibatalkan', 'success');
      tick();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function doRetry() {
    try {
      var j = await api(API + '/' + state.jobId + '/retry', {
        method: 'POST', body: JSON.stringify({ includeSkipped: false })
      });
      toast(j.message || 'Mengulang item gagal', 'success');
      localStorage.setItem(LS_KEY, state.jobId);
      startPolling();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function doVerify() {
    try {
      toast('Memeriksa kondisi router...', 'info');
      var j = await api(API + '/' + state.jobId + '/verify', { method: 'POST' });
      toast(j.message, j.data && j.data.missing ? 'error' : 'success');
      tick();
      loadItems();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function doRollback() {
    // Ambil jumlah nyata dari server supaya angka di dialog akurat,
    // bukan sekadar peringatan generik.
    var n = null, router = state.deviceName || '';
    try {
      var st = await api(API + '/' + state.jobId + '/status');
      n = st.data.succeeded;
      router = st.data.device_name || router;
    } catch (e) { /* tetap lanjut dengan pesan tanpa angka */ }

    var ok = await dialog({
      tone: 'danger',
      title: 'Rollback Provisioning?',
      message: n != null
        ? 'Tindakan ini akan menghapus <b>' + n + ' secret PPPoE</b> yang dibuat oleh job ini dari router' +
          (router ? ' <b>' + esc(router) + '</b>' : '') + '.'
        : 'Tindakan ini akan menghapus semua secret PPPoE yang dibuat oleh job ini dari router.',
      note: 'Secret lain di router tidak akan tersentuh — termasuk yang dilewati karena sudah ada sebelumnya. ' +
            'Setelah rollback, job kembali ke status menunggu dan bisa dijalankan ulang.',
      okText: n != null ? 'Ya, Hapus ' + n + ' Secret' : 'Ya, Rollback',
      cancelText: 'Batal',
    });
    if (!ok) return;

    try {
      var j = await api(API + '/' + state.jobId + '/rollback', { method: 'POST' });
      toast(j.message, 'success');
      tick();
      loadItems();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ── Buat job dari customer existing ────────────────────────────────────────
  async function fromCustomers() {
    var deviceId = $('pbDev') ? $('pbDev').value : null;
    if (!deviceId) return toast('Pilih router tujuan dulu', 'error');

    var profile = await dialog({
      tone: 'info',
      icon: 'edit',
      prompt: true,
      title: 'Profile Default',
      message: 'Profile PPP yang dipakai untuk pelanggan yang paketnya belum dipetakan.',
      note: 'Paket yang sudah mengisi kolom <b>mikrotik_profile</b> akan memakai nilainya sendiri, ' +
            'bukan profile default ini.',
      defaultValue: 'default',
      placeholder: 'mis. 10Mbps',
      okText: 'Lanjutkan',
      cancelText: 'Batal',
    });
    if (profile === null) return;

    try {
      var j = await api(API + '/from-customers', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, default_profile: profile || 'default' })
      });
      state.jobId = j.job_id;
      state.deviceId = deviceId;
      state.preview = {
        router: j.router,
        summary: {
          total: j.summary.total, ready: j.summary.total,
          duplicateOnRouter: j.summary.duplicateOnRouter, error: 0,
          autoPassword: j.summary.total,
        },
        missing_profiles: [],
        available_profiles: j.available_profiles || [],
        rows: [], truncated: true,
      };
      renderStep2();
      if (j.summary.invalidStaticIp > 0) {
        toast(j.summary.invalidStaticIp + ' pelanggan punya IP statis tidak valid — dibuat tanpa IP (ikut pool)', 'info');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ── Kontrol modal ──────────────────────────────────────────────────────────
  function open() {
    ensureDom();
    $('pbOv').classList.add('show');
    $('pbMini').classList.remove('show');

    if (state.jobId && state.step === 3) {
      renderStep3();
      startPolling();
    } else if (state.step === 2 && state.preview) {
      renderStep2();
    } else {
      renderStep1();
    }
  }

  function close() {
    if ($('pbOv')) $('pbOv').classList.remove('show');
    // Polling tetap jalan supaya indikator mini terus terupdate.
    if (state.jobId && state.step === 3) tick();
  }

  function back() {
    renderStep1();
  }

  /**
   * Dipanggil saat halaman load. Kalau ada job yang belum selesai
   * (tercatat di localStorage), lanjutkan polling dan tampilkan indikator mini.
   */
  function resumeIfAny() {
    ensureDom();
    var id = localStorage.getItem(LS_KEY);
    if (!id) return;
    state.jobId = parseInt(id);
    state.step = 3;
    api(API + '/' + id + '/status').then(function (j) {
      var d = j.data;
      if (d.status === 'running' || d.status === 'paused' || d.status === 'scheduled') {
        startPolling();
      } else {
        localStorage.removeItem(LS_KEY);
        state.jobId = null;
        state.step = 1;
      }
    }).catch(function () {
      localStorage.removeItem(LS_KEY);
      state.jobId = null;
      state.step = 1;
    });
  }

  window.PppoeBulk = {
    open: open,
    close: close,
    back: back,
    doPreview: doPreview,
    doStart: doStart,
    doPause: doPause,
    doResume: doResume,
    doUnschedule: doUnschedule,
    doRetry: doRetry,
    doRollback: doRollback,
    doVerify: doVerify,
    fromCustomers: fromCustomers,
    resumeIfAny: resumeIfAny,
  };

  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(resumeIfAny, 800);
  });
})();
