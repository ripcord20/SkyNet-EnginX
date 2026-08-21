/**
 * IsolirWebProxy.js
 * ────────────────────────────────────────────────────────────────────
 * Web Proxy redirect untuk customer isolir.
 *
 * Strategi:
 *   - Aktifkan MikroTik Web Proxy (transparent mode, port 8080)
 *   - DST-NAT redirect HTTP (port 80) dari address-list FLAYNET-ISOLIR
 *     ke port web proxy (8080)
 *   - Web Proxy Access rule: catch-all `action=deny redirect-to=<URL>`
 *     (proxy access TIDAK support src-address-list, hanya src-address.
 *      Strategi: NAT yang filter, proxy yang redirect — hanya customer
 *      ISOLIR yang ter-NAT masuk proxy, jadi semua request di proxy
 *      pasti dari customer ISOLIR.)
 *   - Tidak butuh bridge, tidak butuh interface bind, tidak ubah port
 *
 * BATASAN PENTING:
 *   - HANYA bekerja untuk HTTP (port 80). HTTPS tidak bisa di-redirect
 *     via web proxy karena TLS terenkripsi end-to-end (MikroTik tidak
 *     support SSL Bumping/MITM).
 *   - Customer harus buka site HTTP murni (mis. neverssl.com) atau klik
 *     link HTTP yang dikirim via WhatsApp.
 *   - Browser modern auto-upgrade HTTP→HTTPS untuk banyak site (HSTS preload),
 *     jadi customer praktis harus ketik URL manual.
 *
 * COMPATIBILITY:
 *   - RouterOS v6: fully supported
 *   - RouterOS v7: supported (web proxy tetap ada di v7)
 *
 * Kombinasi rule yang dibuat:
 *   1. /ip proxy → enabled, port 8080
 *   2. /ip proxy access → catch-all deny+redirect rule (single rule)
 *   3. /ip firewall nat → redirect port 80 ke 8080 untuk customer isolir
 *      (filter src-address-list=FLAYNET-ISOLIR di sini, BUKAN di proxy)
 * ────────────────────────────────────────────────────────────────────
 */
const { sequelize } = require('../models');

// ── Konstanta ──
const PROXY_PORT = 8080;
const TAG_NAT_REDIR  = 'FLAYNET-ISOLIR-WP-NAT';   // NAT redirect port 80 → 8080
const TAG_PROXY_RULE = 'FLAYNET-ISOLIR-WP-DENY';  // Proxy access rule

// ════════════════════════════════════════════════════════════════════════
// HELPER untuk akses settings dari DB
// ════════════════════════════════════════════════════════════════════════
async function getWebProxySettings() {
  try {
    const rows = await sequelize.query(
      `SELECT \`key\`, value FROM app_settings
        WHERE \`key\` IN ('isolir_webproxy_enabled','isolir_page_url')`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      enabled: map.isolir_webproxy_enabled === '1',
      pageUrl: map.isolir_page_url || '',
    };
  } catch (e) {
    return { enabled: false, pageUrl: '' };
  }
}

// ════════════════════════════════════════════════════════════════════════
// HELPER untuk API run dengan retry
// ════════════════════════════════════════════════════════════════════════
async function runWithRetry(api, params, maxRetry = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await api.run(params);
    } catch (e) {
      lastErr = e;
      if (i < maxRetry) await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
  throw lastErr;
}

// ════════════════════════════════════════════════════════════════════════
// 1. SETUP Web Proxy redirect untuk isolir
// ════════════════════════════════════════════════════════════════════════
async function setupIsolirWebProxy(api) {
  const cfg = await getWebProxySettings();
  const results = [];
  const errors = [];
  const warnings = [];

  if (!cfg.enabled) {
    return {
      success: true,
      skipped: true,
      details: ['• Isolir Web Proxy Redirect: DISABLED (lewati setup)'],
      errors: [],
      warnings: [],
    };
  }

  if (!cfg.pageUrl) {
    return {
      success: false,
      details: results,
      errors: ['URL halaman isolir belum diset. Isi field "URL Halaman Isolir" di Pengaturan Isolir dulu.'],
      warnings,
    };
  }

  // Pastikan URL HTTP (bukan HTTPS) — web proxy redirect-to butuh HTTP
  let pageUrl = cfg.pageUrl.trim();
  if (pageUrl.startsWith('https://')) {
    warnings.push(`URL halaman isolir pakai HTTPS — browser mungkin reject mixed-content. Ganti ke http:// untuk kompatibilitas maksimal.`);
  }
  if (!pageUrl.match(/^https?:\/\//)) {
    pageUrl = 'http://' + pageUrl;
    warnings.push(`URL halaman isolir auto-prefix dengan http://`);
  }

  // ── 1. Aktifkan Web Proxy ──
  try {
    await runWithRetry(api, [
      '/ip/proxy/set',
      '=enabled=yes',
      '=port=' + PROXY_PORT,
      '=cache-on-disk=no',
      '=max-cache-size=none',
      '=max-cache-object-size=512KiB',
      '=anonymous=no',
    ]);
    results.push(`✓ Web Proxy aktif di port ${PROXY_PORT}`);
  } catch (e) {
    errors.push(`Web Proxy enable: ${e.message}`);
    return { success: false, details: results, errors, warnings };
  }

  // ── 2. Hapus access rule lama (tag kita) ──
  try {
    const existing = await runWithRetry(api, ['/ip/proxy/access/print']);
    let removed = 0;
    for (const e of existing) {
      if (e.comment && e.comment.startsWith(TAG_PROXY_RULE)) {
        try {
          await runWithRetry(api, ['/ip/proxy/access/remove', '=.id=' + e['.id']]);
          removed++;
        } catch (_) {}
      }
    }
    if (removed) results.push(`✓ ${removed} access rule lama dibersihkan`);
  } catch (_) {}

  // ── 3. Tambah access rule baru: deny + redirect ──
  // PENTING: /ip proxy access TIDAK support `src-address-list` (hanya
  // `src-address` single IP/CIDR). Strategi: filter dilakukan di NAT
  // (step 6), bukan di proxy access. Proxy access cukup match SEMUA
  // request yang sampai (catch-all) dan deny+redirect, karena hanya
  // traffic customer ISOLIR yang di-NAT ke port proxy ini.
  try {
    await runWithRetry(api, [
      '/ip/proxy/access/add',
      '=action=deny',
      '=redirect-to=' + pageUrl,
      '=comment=' + TAG_PROXY_RULE,
    ]);
    results.push(`✓ Access rule "deny + redirect → ${pageUrl}" dibuat`);
  } catch (e) {
    errors.push(`Access rule: ${e.message}`);
    return { success: false, details: results, errors, warnings };
  }

  // ── 4. Coba pindah rule baru ke awal chain (best-effort) ──
  try {
    const allRules = await runWithRetry(api, ['/ip/proxy/access/print']);
    const ours = allRules.find(r => r.comment === TAG_PROXY_RULE);
    if (ours && allRules.length > 1) {
      const firstId = allRules.find(r => r['.id'] !== ours['.id'])?.['.id'];
      if (firstId) {
        try {
          await runWithRetry(api, [
            '/ip/proxy/access/move',
            '=numbers=' + ours['.id'],
            '=destination=' + firstId
          ]);
          results.push(`✓ Access rule dipindah ke posisi atas`);
        } catch (e) {
          warnings.push(`Access rule tidak bisa dipindah ke atas: ${e.message}. Cek manual di Winbox: IP → Web Proxy → Access.`);
        }
      }
    }
  } catch (_) { /* abaikan */ }

  // ── 5. Hapus NAT redirect lama (tag kita) ──
  try {
    const existing = await runWithRetry(api, ['/ip/firewall/nat/print', '?comment=' + TAG_NAT_REDIR]);
    for (const e of existing) {
      try {
        await runWithRetry(api, ['/ip/firewall/nat/remove', '=.id=' + e['.id']]);
      } catch (_) {}
    }
  } catch (_) {}

  // ── 6. Tambah NAT rule: redirect TCP port 80 → 8080 ──
  try {
    const natRes = await runWithRetry(api, [
      '/ip/firewall/nat/add',
      '=chain=dstnat',
      '=protocol=tcp',
      '=dst-port=80',
      '=src-address-list=FLAYNET-ISOLIR',
      '=action=redirect',
      '=to-ports=' + String(PROXY_PORT),
      '=comment=' + TAG_NAT_REDIR,
    ]);
    const natId = Array.isArray(natRes) && natRes[0]?.ret ? natRes[0].ret : null;
    results.push(`✓ NAT rule "redirect port 80 → ${PROXY_PORT}" dibuat`);

    // Move ke awal dstnat chain
    if (natId) {
      try {
        const allNat = await runWithRetry(api, ['/ip/firewall/nat/print']);
        const dstnatRules = allNat.filter(r => r.chain === 'dstnat' && r['.id'] !== natId);
        if (dstnatRules.length > 0) {
          await runWithRetry(api, [
            '/ip/firewall/nat/move',
            '=numbers=' + natId,
            '=destination=' + dstnatRules[0]['.id']
          ]);
          results.push(`✓ NAT rule dipindah ke posisi atas chain dstnat`);
        }
      } catch (e) {
        warnings.push(`NAT rule tidak bisa dipindah ke atas: ${e.message}. Cek Winbox: IP → Firewall → NAT.`);
      }
    }
  } catch (e) {
    errors.push(`NAT redirect: ${e.message}`);
    return { success: false, details: results, errors, warnings };
  }

  results.push(`✓ Setup Web Proxy Redirect selesai`);
  results.push(`  ℹ Customer isolir buka HTTP site → di-redirect ke ${pageUrl}`);
  results.push(`  ℹ HTTPS site tetap tidak ke-redirect (limitation TLS) — customer akan lihat "Connection refused"`);

  return {
    success: true,
    details: results,
    errors: [],
    warnings,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 2. TEARDOWN Web Proxy (hapus rule isolir saja, jangan disable proxy)
// ════════════════════════════════════════════════════════════════════════
async function teardownIsolirWebProxy(api) {
  const results = [];

  try {
    const rules = await runWithRetry(api, ['/ip/proxy/access/print']);
    let removed = 0;
    for (const e of rules) {
      if (e.comment && e.comment.startsWith(TAG_PROXY_RULE)) {
        try {
          await runWithRetry(api, ['/ip/proxy/access/remove', '=.id=' + e['.id']]);
          removed++;
        } catch (_) {}
      }
    }
    if (removed) results.push(`✓ ${removed} access rule isolir dihapus`);
  } catch (e) {
    results.push(`⚠ Access rule: ${e.message}`);
  }

  try {
    const rules = await runWithRetry(api, ['/ip/firewall/nat/print', '?comment=' + TAG_NAT_REDIR]);
    let removed = 0;
    for (const e of rules) {
      try {
        await runWithRetry(api, ['/ip/firewall/nat/remove', '=.id=' + e['.id']]);
        removed++;
      } catch (_) {}
    }
    if (removed) results.push(`✓ ${removed} NAT redirect dihapus`);
  } catch (e) {
    results.push(`⚠ NAT redirect: ${e.message}`);
  }

  return { success: true, details: results };
}

// ════════════════════════════════════════════════════════════════════════
// 3. STATUS — query keberadaan rules di MikroTik
// ════════════════════════════════════════════════════════════════════════
async function getWebProxyStatus(api) {
  const status = {
    proxy_enabled: false,
    proxy_port: null,
    access_rule_exists: false,
    nat_redirect_exists: false,
    redirect_target: null,
  };

  try {
    const proxy = await runWithRetry(api, ['/ip/proxy/print']);
    if (proxy.length) {
      status.proxy_enabled = proxy[0].enabled === 'true' || proxy[0].enabled === true;
      status.proxy_port = proxy[0].port;
    }
  } catch (_) {}

  try {
    const rules = await runWithRetry(api, ['/ip/proxy/access/print']);
    const ours = rules.find(r => r.comment && r.comment.startsWith(TAG_PROXY_RULE));
    if (ours) {
      status.access_rule_exists = true;
      status.redirect_target = ours['redirect-to'] || null;
    }
  } catch (_) {}

  try {
    const rules = await runWithRetry(api, ['/ip/firewall/nat/print', '?comment=' + TAG_NAT_REDIR]);
    status.nat_redirect_exists = rules.length > 0;
  } catch (_) {}

  return status;
}

module.exports = {
  PROXY_PORT,
  TAG_NAT_REDIR,
  TAG_PROXY_RULE,
  getWebProxySettings,
  setupIsolirWebProxy,
  teardownIsolirWebProxy,
  getWebProxyStatus,
};
