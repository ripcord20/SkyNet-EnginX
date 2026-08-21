/**
 * IsolirHotspot.js
 * ────────────────────────────────────────────────────────────────────
 * Manage Hotspot server "FLAYNET-ISOLIR-HS" untuk captive portal isolir.
 *
 * Strategi:
 *   - Buat hotspot server terpisah dari hotspot voucher (kalau ada)
 *   - Hotspot mengintercept traffic dari interface yang di-bind
 *   - Browser modern auto-detect captive portal saat HTTPS gagal handshake
 *     → trigger "Sign in to network" notification → buka halaman isolir
 *   - Walled garden: IP server DIGSnet, gateway payment, DNS, LAN private
 *
 * Pendekatan tepat untuk MikroTik:
 *   1. /ip pool isolir-pool (sudah ada dari IsolirPPPoE.js)
 *   2. /ip hotspot profile "flaynet-isolir-profile" - login page custom
 *   3. /ip hotspot server "FLAYNET-ISOLIR-HS" bound ke interface
 *   4. /ip hotspot walled-garden: domains/IPs yang boleh diakses tanpa login
 *   5. /ip hotspot walled-garden ip: address-list bypass
 *   6. Bind hotspot ke interface "<all-ppp>" supaya PPPoE customers ter-handle
 *
 * Kompatibilitas: RouterOS v6 & v7 (REST + native API)
 *
 * Penting tentang user behavior:
 *   - HTTP request → MikroTik intercept di port 80 → redirect ke /login → 200 OK
 *   - HTTPS request → TLS handshake fail (cert mismatch dengan MikroTik)
 *     → Chrome/Safari/Firefox: auto-deteksi captive portal → notif "Sign in"
 *     → Klik notif → buka login page
 *   - DNS resolution untuk customer isolir tetap jalan via Mikrotik DNS
 *     (yang sudah ada di bypass list 8.8.8.8/1.1.1.1)
 * ────────────────────────────────────────────────────────────────────
 */
const { sequelize } = require('../models');

// ── Konstanta ──
const HOTSPOT_SERVER_NAME  = 'FLAYNET-ISOLIR-HS';
const HOTSPOT_PROFILE_NAME = 'flaynet-isolir-profile';
const HOTSPOT_USER_PROFILE = 'flaynet-isolir-user';
const HOTSPOT_HTML_DIR     = 'flaynet-isolir';        // /flaynet-isolir/ di MikroTik filesystem
const HOTSPOT_LOGIN_USER   = 'isolir-guest';          // Auto-login user supaya tidak butuh password
const HOTSPOT_TAG          = 'FLAYNET-ISOLIR-HS-TAG';
// Bridge interface untuk hotspot — bisa di-override via app_settings.
// Default "all" = bind ke semua interface kecuali yang di-explicitly excluded.
const DEFAULT_BRIDGE = 'bridge';

// ════════════════════════════════════════════════════════════════════════
// HELPER untuk akses settings dari DB
// ════════════════════════════════════════════════════════════════════════
async function getHotspotSettings() {
  try {
    const rows = await sequelize.query(
      `SELECT \`key\`, value FROM app_settings
        WHERE \`key\` IN ('isolir_hotspot_enabled','isolir_hotspot_interface',
                          'isolir_hotspot_dns_name','isolir_page_url')`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      enabled:   map.isolir_hotspot_enabled === '1',
      interface: map.isolir_hotspot_interface || DEFAULT_BRIDGE,
      dnsName:   map.isolir_hotspot_dns_name || 'isolir.flaynet.local',
      pageUrl:   map.isolir_page_url || '',
    };
  } catch (e) {
    return {
      enabled: false,
      interface: DEFAULT_BRIDGE,
      dnsName: 'isolir.flaynet.local',
      pageUrl: '',
    };
  }
}

// ════════════════════════════════════════════════════════════════════════
// HELPER untuk API run dengan retry — mirror dari IsolirService
// ════════════════════════════════════════════════════════════════════════
async function runWithRetry(api, params, maxRetry = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await api.run(params);
    } catch (e) {
      lastErr = e;
      if (i < maxRetry) {
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

// ════════════════════════════════════════════════════════════════════════
// 1. SETUP HOTSPOT untuk isolir
// ════════════════════════════════════════════════════════════════════════
/**
 * Setup hotspot server FLAYNET-ISOLIR-HS lengkap dengan profile, walled-garden,
 * dan auto-bind ke address-list FLAYNET-ISOLIR via interface "<all-ppp>" + bridge.
 *
 * @param {Object} api - MikroTik API client
 * @param {Object} device - row dari mikrotik_devices (untuk per-device settings)
 * @returns {Object} { success, details, errors, warnings }
 */
async function setupIsolirHotspot(api, device) {
  const cfg = await getHotspotSettings();
  const results = [];
  const errors = [];
  const warnings = [];

  if (!cfg.enabled) {
    return {
      success: true,
      skipped: true,
      details: ['• Isolir Hotspot Captive Portal: DISABLED (lewati setup)'],
      errors: [],
      warnings: [],
    };
  }

  // ── 1. Resolve target URL untuk halaman isolir ──
  // Halaman ini akan jadi tujuan login-redirect setelah user masuk hotspot
  const FirewallV2 = require('./IsolirFirewallV2');
  let target;
  try {
    if (!cfg.pageUrl) throw new Error('URL halaman isolir belum diset');
    target = await FirewallV2.parseRedirectTarget(cfg.pageUrl);
  } catch (e) {
    return {
      success: false,
      errors: [`Hotspot setup gagal: ${e.message}`],
      details: results,
      warnings,
    };
  }

  // ── 2. Buat user-profile khusus (rate-limit & default settings) ──
  try {
    const existing = await runWithRetry(api, [
      '/ip/hotspot/user/profile/print',
      '?name=' + HOTSPOT_USER_PROFILE
    ]);
    const profileArgs = [
      '=name=' + HOTSPOT_USER_PROFILE,
      '=shared-users=' + '999',      // unlimited concurrent sessions per user
      '=session-timeout=' + '0',     // no timeout
      '=idle-timeout=' + 'none',     // no idle timeout
      '=keepalive-timeout=' + '2m',
      '=status-autorefresh=' + '1m',
      // Rate limit minimal — supaya user tidak bisa abuse jaringan
      '=rate-limit=' + '256k/256k',
    ];
    if (existing.length === 0) {
      await runWithRetry(api, ['/ip/hotspot/user/profile/add', ...profileArgs]);
      results.push(`✓ Hotspot user-profile "${HOTSPOT_USER_PROFILE}" dibuat`);
    } else {
      await runWithRetry(api, [
        '/ip/hotspot/user/profile/set',
        '=.id=' + existing[0]['.id'],
        ...profileArgs.slice(1)  // skip =name= (tidak bisa di-set saat update)
      ]);
      results.push(`• Hotspot user-profile "${HOTSPOT_USER_PROFILE}" sinkron`);
    }
  } catch (e) {
    errors.push(`User-profile: ${e.message}`);
  }

  // ── 3. Buat hotspot profile (login page config) ──
  try {
    const existing = await runWithRetry(api, [
      '/ip/hotspot/profile/print',
      '?name=' + HOTSPOT_PROFILE_NAME
    ]);
    const profileArgs = [
      '=name=' + HOTSPOT_PROFILE_NAME,
      '=hotspot-address=' + '0.0.0.0',     // listen di semua IP MikroTik
      '=dns-name=' + cfg.dnsName,          // hostname untuk halaman login
      '=html-directory=' + HOTSPOT_HTML_DIR,
      '=login-by=' + 'http-chap,http-pap,trial',
      '=split-user-domain=' + 'no',
      // Trial: customer otomatis login tanpa password setelah klik
      '=use-radius=' + 'no',
    ];
    if (existing.length === 0) {
      await runWithRetry(api, ['/ip/hotspot/profile/add', ...profileArgs]);
      results.push(`✓ Hotspot profile "${HOTSPOT_PROFILE_NAME}" dibuat`);
    } else {
      await runWithRetry(api, [
        '/ip/hotspot/profile/set',
        '=.id=' + existing[0]['.id'],
        ...profileArgs.slice(1)
      ]);
      results.push(`• Hotspot profile "${HOTSPOT_PROFILE_NAME}" sinkron`);
    }
  } catch (e) {
    errors.push(`Hotspot profile: ${e.message}`);
  }

  // ── 4. Buat hotspot server ──
  // Bind ke interface yang ditentukan (default: bridge utama).
  // Kalau interface tidak ada, fallback ke "all" (semua interface).
  let bindInterface = cfg.interface;
  try {
    // Validasi interface exists
    const ifaces = await runWithRetry(api, ['/interface/print', '?name=' + bindInterface]);
    if (ifaces.length === 0) {
      warnings.push(`Interface "${bindInterface}" tidak ditemukan — fallback ke "all"`);
      bindInterface = 'all';
    }
  } catch (_) { /* abaikan, pakai default */ }

  try {
    const existing = await runWithRetry(api, [
      '/ip/hotspot/print',
      '?name=' + HOTSPOT_SERVER_NAME
    ]);
    const serverArgs = [
      '=name=' + HOTSPOT_SERVER_NAME,
      '=interface=' + bindInterface,
      '=profile=' + HOTSPOT_PROFILE_NAME,
      '=address-pool=' + (process.env.ISOLIR_POOL_NAME || 'isolir-pool'),
      '=disabled=' + 'no',
      '=addresses-per-mac=' + '1',
    ];
    if (existing.length === 0) {
      await runWithRetry(api, ['/ip/hotspot/add', ...serverArgs]);
      results.push(`✓ Hotspot server "${HOTSPOT_SERVER_NAME}" dibuat (interface: ${bindInterface})`);
    } else {
      await runWithRetry(api, [
        '/ip/hotspot/set',
        '=.id=' + existing[0]['.id'],
        ...serverArgs.slice(1)
      ]);
      results.push(`• Hotspot server "${HOTSPOT_SERVER_NAME}" sinkron (interface: ${bindInterface})`);
    }
  } catch (e) {
    errors.push(`Hotspot server: ${e.message}`);
  }

  // ── 5. Walled garden: domains/URLs yang boleh diakses tanpa login ──
  // Termasuk halaman isolir itu sendiri supaya user bisa lihat info tagihan
  try {
    const wgEntries = [
      // Halaman isolir di server DIGSnet (target redirect)
      { 'dst-host': target.host, comment: HOTSPOT_TAG + ':isolir-page' },
      // Domain payment gateway (kalau pakai)
      { 'dst-host': '*.midtrans.com', comment: HOTSPOT_TAG + ':midtrans' },
      { 'dst-host': '*.tripay.co.id', comment: HOTSPOT_TAG + ':tripay' },
    ];

    // Hapus walled-garden entries lama (tag kita)
    const existing = await runWithRetry(api, [
      '/ip/hotspot/walled-garden/print'
    ]);
    let removed = 0;
    for (const e of existing) {
      if (e.comment && e.comment.startsWith(HOTSPOT_TAG)) {
        try {
          await runWithRetry(api, ['/ip/hotspot/walled-garden/remove', '=.id=' + e['.id']]);
          removed++;
        } catch (_) {}
      }
    }

    // Tambah ulang
    let added = 0;
    for (const wg of wgEntries) {
      try {
        await runWithRetry(api, [
          '/ip/hotspot/walled-garden/add',
          '=dst-host=' + wg['dst-host'],
          '=comment=' + wg.comment,
          '=action=allow'
        ]);
        added++;
      } catch (_) { /* duplicate ignored */ }
    }
    results.push(`✓ Walled-garden: ${added} domain dibolehkan (removed ${removed} lama)`);
  } catch (e) {
    warnings.push(`Walled-garden: ${e.message}`);
  }

  // ── 6. Walled garden IP: sync dari bypass list FLAYNET-BYPASS ──
  // Hotspot punya rule walled-garden-ip terpisah yang accept by address-list.
  // Kalau IP target di address-list BYPASS → diizinkan lewat tanpa login.
  try {
    const existing = await runWithRetry(api, [
      '/ip/hotspot/walled-garden/ip/print'
    ]);
    let removed = 0;
    for (const e of existing) {
      if (e.comment && e.comment.startsWith(HOTSPOT_TAG)) {
        try {
          await runWithRetry(api, ['/ip/hotspot/walled-garden/ip/remove', '=.id=' + e['.id']]);
          removed++;
        } catch (_) {}
      }
    }

    // Allow semua traffic ke address-list FLAYNET-BYPASS (gateway, DNS, LAN)
    await runWithRetry(api, [
      '/ip/hotspot/walled-garden/ip/add',
      '=dst-address-list=' + 'FLAYNET-BYPASS',
      '=action=accept',
      '=comment=' + HOTSPOT_TAG + ':bypass-list'
    ]);
    results.push(`✓ Walled-garden-IP: traffic ke FLAYNET-BYPASS diizinkan (removed ${removed} lama)`);
  } catch (e) {
    warnings.push(`Walled-garden-IP: ${e.message}`);
  }

  // ── 7. Tambah hotspot user "isolir-guest" untuk auto-login ──
  // User ini di-share semua customer isolir — supaya tidak butuh credential
  try {
    const existing = await runWithRetry(api, [
      '/ip/hotspot/user/print',
      '?name=' + HOTSPOT_LOGIN_USER
    ]);
    if (existing.length === 0) {
      await runWithRetry(api, [
        '/ip/hotspot/user/add',
        '=name=' + HOTSPOT_LOGIN_USER,
        '=password=' + HOTSPOT_LOGIN_USER,
        '=profile=' + HOTSPOT_USER_PROFILE,
        '=comment=' + HOTSPOT_TAG
      ]);
      results.push(`✓ Hotspot user "${HOTSPOT_LOGIN_USER}" dibuat (untuk auto-login)`);
    } else {
      results.push(`• Hotspot user "${HOTSPOT_LOGIN_USER}" sudah ada`);
    }
  } catch (e) {
    warnings.push(`Hotspot user: ${e.message}`);
  }

  // ── 8. Cek apakah login.html ada di filesystem ──
  // Best-effort — kasih warning kalau belum di-upload
  try {
    const files = await runWithRetry(api, [
      '/file/print',
      '?name=' + HOTSPOT_HTML_DIR + '/login.html'
    ]);
    if (files.length === 0) {
      warnings.push(
        `⚠ File "${HOTSPOT_HTML_DIR}/login.html" belum ada di MikroTik. ` +
        `Upload via Winbox: Files → drag template HTML → rename ke "${HOTSPOT_HTML_DIR}/login.html". ` +
        `Tanpa file ini, MikroTik akan tampilkan halaman default.`
      );
    } else {
      results.push(`✓ login.html ditemukan di ${HOTSPOT_HTML_DIR}/`);
    }
  } catch (_) { /* abaikan kalau API tidak support file/print */ }

  // ── Result ──
  if (errors.length) {
    return {
      success: false,
      details: results,
      errors,
      warnings,
    };
  }
  results.push(`✓ Setup Hotspot Captive Portal selesai — HTTPS akan trigger captive portal detection di browser modern`);
  return {
    success: true,
    details: results,
    errors: [],
    warnings,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 2. TEARDOWN HOTSPOT (hapus semua resource isolir hotspot)
// ════════════════════════════════════════════════════════════════════════
async function teardownIsolirHotspot(api) {
  const results = [];

  // Hapus hotspot server
  try {
    const servers = await runWithRetry(api, ['/ip/hotspot/print', '?name=' + HOTSPOT_SERVER_NAME]);
    for (const s of servers) {
      await runWithRetry(api, ['/ip/hotspot/remove', '=.id=' + s['.id']]);
      results.push(`✓ Hotspot server "${HOTSPOT_SERVER_NAME}" dihapus`);
    }
  } catch (e) { results.push(`⚠ Hotspot server: ${e.message}`); }

  // Hapus hotspot profile
  try {
    const profiles = await runWithRetry(api, ['/ip/hotspot/profile/print', '?name=' + HOTSPOT_PROFILE_NAME]);
    for (const p of profiles) {
      await runWithRetry(api, ['/ip/hotspot/profile/remove', '=.id=' + p['.id']]);
      results.push(`✓ Hotspot profile dihapus`);
    }
  } catch (_) {}

  // Hapus user-profile
  try {
    const ups = await runWithRetry(api, ['/ip/hotspot/user/profile/print', '?name=' + HOTSPOT_USER_PROFILE]);
    for (const u of ups) {
      await runWithRetry(api, ['/ip/hotspot/user/profile/remove', '=.id=' + u['.id']]);
    }
  } catch (_) {}

  // Hapus walled-garden entries
  try {
    const wg = await runWithRetry(api, ['/ip/hotspot/walled-garden/print']);
    for (const e of wg) {
      if (e.comment && e.comment.startsWith(HOTSPOT_TAG)) {
        await runWithRetry(api, ['/ip/hotspot/walled-garden/remove', '=.id=' + e['.id']]);
      }
    }
    const wgIp = await runWithRetry(api, ['/ip/hotspot/walled-garden/ip/print']);
    for (const e of wgIp) {
      if (e.comment && e.comment.startsWith(HOTSPOT_TAG)) {
        await runWithRetry(api, ['/ip/hotspot/walled-garden/ip/remove', '=.id=' + e['.id']]);
      }
    }
    results.push(`✓ Walled-garden entries dibersihkan`);
  } catch (_) {}

  // Hapus hotspot user
  try {
    const users = await runWithRetry(api, ['/ip/hotspot/user/print', '?name=' + HOTSPOT_LOGIN_USER]);
    for (const u of users) {
      await runWithRetry(api, ['/ip/hotspot/user/remove', '=.id=' + u['.id']]);
    }
  } catch (_) {}

  return { success: true, details: results };
}

// ════════════════════════════════════════════════════════════════════════
// 3. STATUS — query keberadaan rules di MikroTik
// ════════════════════════════════════════════════════════════════════════
async function getHotspotStatus(api) {
  const status = {
    server_exists: false,
    server_disabled: false,
    server_interface: null,
    profile_exists: false,
    user_profile_exists: false,
    login_user_exists: false,
    login_html_exists: false,
    walled_garden_count: 0,
    walled_garden_ip_count: 0,
  };

  try {
    const servers = await runWithRetry(api, ['/ip/hotspot/print', '?name=' + HOTSPOT_SERVER_NAME]);
    if (servers.length) {
      status.server_exists = true;
      status.server_disabled = servers[0].disabled === 'true' || servers[0].disabled === true;
      status.server_interface = servers[0].interface;
    }
  } catch (_) {}

  try {
    const profiles = await runWithRetry(api, ['/ip/hotspot/profile/print', '?name=' + HOTSPOT_PROFILE_NAME]);
    status.profile_exists = profiles.length > 0;
  } catch (_) {}

  try {
    const ups = await runWithRetry(api, ['/ip/hotspot/user/profile/print', '?name=' + HOTSPOT_USER_PROFILE]);
    status.user_profile_exists = ups.length > 0;
  } catch (_) {}

  try {
    const users = await runWithRetry(api, ['/ip/hotspot/user/print', '?name=' + HOTSPOT_LOGIN_USER]);
    status.login_user_exists = users.length > 0;
  } catch (_) {}

  try {
    const files = await runWithRetry(api, ['/file/print', '?name=' + HOTSPOT_HTML_DIR + '/login.html']);
    status.login_html_exists = files.length > 0;
  } catch (_) {}

  try {
    const wg = await runWithRetry(api, ['/ip/hotspot/walled-garden/print']);
    status.walled_garden_count = wg.filter(e => e.comment && e.comment.startsWith(HOTSPOT_TAG)).length;
  } catch (_) {}

  try {
    const wgIp = await runWithRetry(api, ['/ip/hotspot/walled-garden/ip/print']);
    status.walled_garden_ip_count = wgIp.filter(e => e.comment && e.comment.startsWith(HOTSPOT_TAG)).length;
  } catch (_) {}

  return status;
}

module.exports = {
  // Constants
  HOTSPOT_SERVER_NAME,
  HOTSPOT_PROFILE_NAME,
  HOTSPOT_USER_PROFILE,
  HOTSPOT_HTML_DIR,
  HOTSPOT_LOGIN_USER,
  // Settings
  getHotspotSettings,
  // Lifecycle
  setupIsolirHotspot,
  teardownIsolirHotspot,
  getHotspotStatus,
};
