/**
 * IsolirFirewallV2.js
 * ────────────────────────────────────────────────────────────────────
 * Manajemen firewall isolir generasi-2 — strategi:
 *   1. Address-list FLAYNET-ISOLIR : IP pelanggan diisolir
 *   2. Address-list FLAYNET-BYPASS : IP/CIDR yang masih boleh diakses
 *      (gateway pembayaran, DNS publik, situs ISP, dll)
 *   3. NAT chain dstnat: redirect HTTP (port 80) dari ISOLIR ke
 *      halaman isolir, KECUALI tujuan ada di BYPASS
 *   4. Filter chain forward: DROP semua selain HTTP-redirect & BYPASS
 *      (HTTPS tidak bisa di-redirect karena TLS, jadi diblokir)
 *
 * Kompatibel RouterOS v6 & v7 — menggunakan API client di IsolirService.js
 * yang sudah multi-mode (REST / Native v6 / Native v7 / Auto).
 *
 * Bypass list:
 *   - Global  (tabel `isolir_bypass_global`)   — berlaku ke semua router
 *   - Per-router (tabel `isolir_bypass_router`) — override khusus
 *   - Saat sync ke MikroTik: merged (global ∪ per-router) → push ke
 *     address-list FLAYNET-BYPASS dengan timeout=0 (permanent)
 * ────────────────────────────────────────────────────────────────────
 */
const { sequelize } = require('../models');

// ── Konstanta address-list & comment marker ──
const LIST_ISOLIR  = 'FLAYNET-ISOLIR';
const LIST_BYPASS  = 'FLAYNET-BYPASS';
const TAG_NAT      = 'FLAYNET-ISOLIR-NAT';        // dstnat redirect HTTP
const TAG_DROP_FWD = 'FLAYNET-ISOLIR-DROP-FWD';   // drop forward (selain bypass)
const TAG_BYPASS_FWD = 'FLAYNET-ISOLIR-ALLOW-BYPASS'; // allow forward ke bypass (priority tinggi)

// Default bypass entries yang di-seed saat schema setup pertama kali.
// IP server DIGSnet sendiri WAJIB ada (kalau tidak halaman isolir tidak bisa diakses!)
// Server IP akan di-detect otomatis dari env / DB saat sync.
const DEFAULT_BYPASS_GLOBAL = [
  // DNS publik — supaya browser bisa resolve domain redirect target
  { address: '8.8.8.8',         label: 'Google DNS Primary',     category: 'dns'      },
  { address: '8.8.4.4',         label: 'Google DNS Secondary',   category: 'dns'      },
  { address: '1.1.1.1',         label: 'Cloudflare DNS Primary', category: 'dns'      },
  { address: '1.0.0.1',         label: 'Cloudflare DNS Secondary', category: 'dns'    },
  // Private network (LAN) — biar admin tetap bisa diakses dari pelanggan
  { address: '192.168.0.0/16',  label: 'LAN Private Range',      category: 'network' },
  { address: '10.0.0.0/8',      label: 'LAN Private Range',      category: 'network' },
  { address: '172.16.0.0/12',   label: 'LAN Private Range',      category: 'network' },
];

// ════════════════════════════════════════════════════════════════════════
// SCHEMA SETUP — idempotent, dipanggil sekali saat module load.
// Setiap step dibungkus try/catch terpisah supaya satu gagal tidak
// menggagalkan yang lain (misal: ALTER TABLE error karena race condition
// dengan IsolirService.ensureSchema, tapi CREATE TABLE harus tetap jalan).
// ════════════════════════════════════════════════════════════════════════
async function ensureSchema() {
  // ── Step 1: Kolom isolir_page_url di mikrotik_devices ──
  // Catatan: IsolirService.ensureSchema() juga punya alter ini (idempotent
  // safeguard kalau migration order berbeda). Pakai try/catch agar duplicate
  // column error tidak menghentikan flow.
  try {
    const cols = await sequelize.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mikrotik_devices'`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const have = new Set(cols.map(c => c.COLUMN_NAME));
    if (!have.has('isolir_page_url')) {
      await sequelize.query(
        `ALTER TABLE mikrotik_devices
         ADD COLUMN isolir_page_url VARCHAR(500) DEFAULT NULL AFTER notes`
      );
      console.log('[IsolirFirewallV2] added column isolir_page_url to mikrotik_devices');
    }
  } catch (e) {
    // Duplicate column / race-condition aman diabaikan
    if (!/duplicate column|already exists/i.test(e.message || '')) {
      console.error('[IsolirFirewallV2] alter mikrotik_devices error:', e.message);
    }
  }

  // ── Step 2: Tabel isolir_bypass_global ──
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS isolir_bypass_global (
        id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        address VARCHAR(100) NOT NULL,
        label VARCHAR(255) DEFAULT NULL,
        category VARCHAR(50) DEFAULT 'custom',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_addr (address),
        KEY idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.error('[IsolirFirewallV2] create isolir_bypass_global error:', e.message);
  }

  // ── Step 3: Tabel isolir_bypass_router (per-device override) ──
  // CATATAN: tidak pakai FOREIGN KEY constraint karena tipe data
  // mikrotik_devices.id bisa beda di tiap deployment (INT vs INT UNSIGNED).
  // Cascade delete di-handle di app level: deleteDevice() di controller
  // sudah hapus child row.
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS isolir_bypass_router (
        id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        device_id INT UNSIGNED NOT NULL,
        address VARCHAR(100) NOT NULL,
        label VARCHAR(255) DEFAULT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_dev_addr (device_id, address),
        KEY idx_device (device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.error('[IsolirFirewallV2] create isolir_bypass_router error:', e.message);
  }

  // ── Step 4: Seed default global bypass kalau tabel kosong ──
  try {
    const rows = await sequelize.query(
      'SELECT COUNT(*) AS cnt FROM isolir_bypass_global',
      { type: sequelize.QueryTypes.SELECT }
    );
    const cnt = parseInt(rows[0]?.cnt || 0);
    if (cnt === 0) {
      for (const e of DEFAULT_BYPASS_GLOBAL) {
        await sequelize.query(
          `INSERT IGNORE INTO isolir_bypass_global (address, label, category, is_active)
           VALUES (?, ?, ?, 1)`,
          { replacements: [e.address, e.label, e.category] }
        );
      }
      console.log(`[IsolirFirewallV2] seeded ${DEFAULT_BYPASS_GLOBAL.length} default bypass entries`);
    }
  } catch (e) {
    console.error('[IsolirFirewallV2] seed bypass defaults error:', e.message);
  }

  console.log('[IsolirFirewallV2] schema ready');
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS — resolve isolir page URL & merged bypass list
// ════════════════════════════════════════════════════════════════════════

/**
 * Resolve URL halaman isolir untuk device tertentu.
 * Prioritas: device.isolir_page_url → app_settings.isolir_page_url → null
 */
async function resolveIsolirPageUrl(device) {
  if (device?.isolir_page_url && String(device.isolir_page_url).trim()) {
    return String(device.isolir_page_url).trim();
  }
  const rows = await sequelize.query(
    "SELECT value FROM app_settings WHERE `key`='isolir_page_url'",
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  const v = rows[0]?.value;
  return (v && String(v).trim()) ? String(v).trim() : null;
}

/**
 * Parse URL → { host, port, isHttps } untuk dipakai sebagai target dst-nat.
 * Catatan: dst-nat MikroTik pakai to-addresses=<IP> + to-ports=<PORT>.
 * Kalau URL pakai hostname (bukan IP), kita resolve via DNS lookup di Node.
 */
async function parseRedirectTarget(url) {
  if (!url) return null;
  try {
    // Sanitize: pastikan ada protocol
    let u = String(url).trim();
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    const parsed = new URL(u);
    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port || (isHttps ? 443 : 80);
    let host = parsed.hostname;

    // Kalau host bukan IP → DNS lookup
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    let resolved = false;
    if (!isIp) {
      const dns = require('dns').promises;
      try {
        const result = await dns.lookup(host, { family: 4 });
        host = result.address;
        resolved = true;
      } catch (e) {
        throw new Error(`Gagal resolve DNS ${host}: ${e.message}`);
      }
    }

    // ── Validasi: IP target HARUS reachable dari MikroTik (LAN private atau IP server) ──
    // Kalau hasil resolve berupa IP publik (Cloudflare CDN, dll), redirect akan
    // ke server orang lain — bukan ke server DIGSnet. Cegah ini dengan warning.
    const isPrivateIp =
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
      /^127\./.test(host) ||
      /^169\.254\./.test(host);

    return { host, port: parseInt(port), isHttps, fullUrl: u, resolved, isPrivateIp };
  } catch (e) {
    throw new Error('URL halaman isolir tidak valid: ' + e.message);
  }
}

/**
 * Merge bypass list global + per-router untuk device tertentu.
 * Return: [{ address, label }]
 *
 * Tolerant: kalau tabel belum ada (race condition saat startup),
 * return [] daripada throw — supaya halaman /isolir tidak crash.
 */
async function getMergedBypassList(deviceId) {
  const globalRows = await sequelize.query(
    "SELECT address, label FROM isolir_bypass_global WHERE is_active=1 ORDER BY id",
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  const routerRows = await sequelize.query(
    "SELECT address, label FROM isolir_bypass_router WHERE device_id=? AND is_active=1 ORDER BY id",
    { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  // Deduplicate berdasarkan address — per-router override lebih spesifik
  const seen = new Set();
  const merged = [];
  for (const r of [...routerRows, ...globalRows]) {
    if (seen.has(r.address)) continue;
    seen.add(r.address);
    merged.push({ address: r.address, label: r.label || '' });
  }
  return merged;
}

// ════════════════════════════════════════════════════════════════════════
// FIREWALL OPERATIONS via MikroTik API client (yang dipassing dari caller)
// ════════════════════════════════════════════════════════════════════════

/**
 * Wrapper untuk runWithRetry(api, ) dengan retry-on-ECONNRESET dan delay antar call.
 * MikroTik REST API sering ECONNRESET kalau request datang terlalu cepat
 * berturut-turut, atau saat router lagi sibuk.
 */
async function runWithRetry(api, words, maxRetry = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const result = await api.run(words);
      // Beri jeda kecil antar call (rate-limit yang ramah ke MikroTik)
      await new Promise(r => setTimeout(r, 80));
      return result;
    } catch (e) {
      lastErr = e;
      const msg = e.message || '';
      const isTransient = /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|ECONNREFUSED/i.test(msg);
      if (isTransient && attempt < maxRetry) {
        // Backoff: 300ms, 800ms
        const delay = attempt === 0 ? 300 : 800;
        console.warn(`[IsolirFirewallV2] retry ${attempt+1}/${maxRetry} setelah ${delay}ms — ${msg}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Hapus semua rule lama yang dibuat oleh sistem isolir (termasuk legacy WAU).
 * Dipanggil di awal setupFirewall.
 */
async function purgeOldRules(api) {
  const tags = [
    'FLAYNET-ISOLIR-NAT', 'FLAYNET-ISOLIR-DROP-FWD',
    'FLAYNET-ISOLIR-ALLOW-BYPASS',
    'FLAYNET-BLOCK-SRC', 'FLAYNET-BLOCK-DST',     // legacy v1 drop-only
    'WAU-BLOCK-SRC', 'WAU-BLOCK-DST',              // legacy original
  ];
  let removed = 0;

  // Filter rules
  for (const cmt of tags) {
    try {
      const rules = await runWithRetry(api, ['/ip/firewall/filter/print', '?comment=' + cmt]);
      for (const r of rules) {
        if (r['.id']) {
          await runWithRetry(api, ['/ip/firewall/filter/remove', '=.id=' + r['.id']]);
          removed++;
        }
      }
    } catch (_) { /* abaikan */ }
  }

  // NAT rules
  for (const cmt of tags) {
    try {
      const rules = await runWithRetry(api, ['/ip/firewall/nat/print', '?comment=' + cmt]);
      for (const r of rules) {
        if (r['.id']) {
          await runWithRetry(api, ['/ip/firewall/nat/remove', '=.id=' + r['.id']]);
          removed++;
        }
      }
    } catch (_) { /* abaikan */ }
  }

  return removed;
}

/**
 * Sync address-list FLAYNET-BYPASS di MikroTik dengan merged list dari DB.
 * Strategi: hapus semua entry yang dibuat sistem (comment ber-prefix BYPASS-),
 * lalu tambahkan ulang dari merged list.
 */
async function syncBypassList(api, deviceId) {
  const merged = await getMergedBypassList(deviceId);
  let added = 0, removed = 0;

  // Hapus semua entry FLAYNET-BYPASS yang ada
  try {
    const existing = await runWithRetry(api, ['/ip/firewall/address-list/print', '?list=' + LIST_BYPASS]);
    for (const e of existing) {
      if (e['.id']) {
        await runWithRetry(api, ['/ip/firewall/address-list/remove', '=.id=' + e['.id']]);
        removed++;
      }
    }
  } catch (_) { /* abaikan */ }

  // Tambah ulang dari merged list
  for (const entry of merged) {
    try {
      const cmt = ('BYPASS-' + (entry.label || 'custom'))
        .replace(/[^\w\s\-\.]/g, '').slice(0, 100);
      await runWithRetry(api, [
        '/ip/firewall/address-list/add',
        '=list=' + LIST_BYPASS,
        '=address=' + entry.address,
        '=comment=' + cmt
      ]);
      added++;
    } catch (e) {
      console.warn('[IsolirFirewallV2] gagal tambah bypass', entry.address, ':', e.message);
    }
  }

  return { added, removed, total: merged.length };
}

/**
 * Setup full firewall isolir di device — DST-NAT redirect HTTP + filter rules + bypass.
 *
 * Yang akan ditambahkan ke MikroTik:
 *   1. Address-list FLAYNET-BYPASS (sync dari DB)
 *   2. NAT rule: dstnat src=ISOLIR dst=!BYPASS proto=tcp dport=80 → dst-nat to <halaman_isolir>
 *   3. Filter forward: src=ISOLIR dst=BYPASS action=accept (whitelist priority)
 *   4. Filter forward: src=ISOLIR action=drop (catch-all yang sudah masuk ISOLIR tapi tidak ke bypass)
 *
 * @param {Object} api - MikroTik API client (dari connectDevice)
 * @param {Object} device - row dari mikrotik_devices
 * @returns {Object} { added: [...], skipped: [...] }
 */
async function setupFirewallV2(api, device) {
  const results = [];
  const errors = [];

  // ── 1. Resolve halaman isolir URL ──
  const isolirUrl = await resolveIsolirPageUrl(device);
  if (!isolirUrl) {
    throw new Error(
      'URL halaman isolir belum diset. Set di Pengaturan Isolir (global) atau di device ini (override).'
    );
  }
  let target;
  try {
    target = await parseRedirectTarget(isolirUrl);
  } catch (e) {
    throw new Error('Gagal parse URL halaman isolir: ' + e.message);
  }
  results.push(`✓ Target redirect: ${target.host}:${target.port} (${target.fullUrl})`);

  if (target.isHttps) {
    throw new Error(
      `URL halaman isolir tidak boleh HTTPS. DST-NAT HTTP→HTTPS tidak bisa karena TLS handshake. ` +
      `Ganti URL ke HTTP biasa, contoh: http://<IP-LOKAL-SERVER-DIGSNET>:3000/p/isolir`
    );
  }

  // ── VALIDASI: target HARUS IP private/LAN, bukan IP publik ──
  // Kalau hasil resolve berupa IP publik (misal: domain pointing ke
  // Cloudflare CDN 104.21.x.x), redirect akan ke server orang lain.
  // Solusinya: pakai langsung IP LAN server DIGSnet, bukan domain publik.
  if (target.resolved && !target.isPrivateIp) {
    throw new Error(
      `URL halaman isolir resolve ke IP publik (${target.host}) — kemungkinan domain Anda di belakang Cloudflare/CDN. ` +
      `DST-NAT akan redirect ke server CDN, BUKAN ke server DIGSnet Anda. ` +
      `Solusi: gunakan IP LOKAL server DIGSnet langsung, contoh: http://192.168.1.100:3000/p/isolir ` +
      `(IP yang reachable dari MikroTik via LAN)`
    );
  }
  if (!target.isPrivateIp) {
    // IP langsung yang non-private (jarang, tapi bisa terjadi kalau user pakai IP publik static)
    results.push(`⚠ Target ${target.host} bukan IP private. Pastikan IP ini reachable dari MikroTik.`);
  }

  // ── 2. Hapus rule lama ──
  const purged = await purgeOldRules(api);
  if (purged > 0) results.push(`✓ ${purged} rule lama dihapus`);

  // ── 3. Sync address-list bypass ──
  const bypassSync = await syncBypassList(api, device.id);
  results.push(`✓ Bypass list synced: ${bypassSync.total} entry (added ${bypassSync.added}, removed ${bypassSync.removed})`);

  // ── 4. Auto-add IP server DIGSnet sendiri ke bypass ──
  // Detect dari setting app_url atau env, supaya target redirect tidak ikut di-block
  // sendiri kalau IP-nya kebetulan masuk range LAN yg tidak tercover default bypass.
  try {
    const cmt = ('BYPASS-DIGSNET-SERVER').slice(0, 100);
    // Cek dulu apakah sudah ada
    const exists = await runWithRetry(api, [
      '/ip/firewall/address-list/print',
      '?list=' + LIST_BYPASS,
      '?address=' + target.host
    ]);
    if (exists.length === 0) {
      await runWithRetry(api, [
        '/ip/firewall/address-list/add',
        '=list=' + LIST_BYPASS,
        '=address=' + target.host,
        '=comment=' + cmt
      ]);
      results.push(`✓ IP server isolir (${target.host}) auto-ditambahkan ke bypass`);
    }
  } catch (_) { /* abaikan */ }

  // ── 5. NAT rule: redirect HTTP ke halaman isolir ──
  // Place at top of dstnat chain pakai place-before fitur yang ada di API runner
  try {
    const natParams = [
      '/ip/firewall/nat/add',
      '=chain=dstnat',
      '=src-address-list=' + LIST_ISOLIR,
      '=dst-address-list=!' + LIST_BYPASS,    // negation: TIDAK menuju bypass
      '=protocol=tcp',
      '=dst-port=80',
      '=action=dst-nat',
      '=to-addresses=' + target.host,
      '=to-ports=' + target.port,
      '=comment=' + TAG_NAT
    ];
    const natRes = await runWithRetry(api, natParams);
    const natId = natRes[0]?.['.id'] || natRes[0]?.ret;
    results.push(`✓ NAT rule: redirect HTTP → ${target.host}:${target.port}`);

    // Move ke awal dstnat chain (kalau API mendukung)
    // PENTING: kalau move gagal, rule baru ada di akhir chain — bisa kalah
    // priority dari rule masquerade/dst-nat lain. Log warning supaya admin
    // bisa cek manual via Winbox.
    if (natId) {
      try {
        const allNat = await runWithRetry(api, ['/ip/firewall/nat/print']);
        const dstnatRules = allNat.filter(r => r.chain === 'dstnat' && r['.id'] !== natId);
        if (dstnatRules.length > 0) {
          const firstId = dstnatRules[0]['.id'];
          try {
            await runWithRetry(api, [
              '/ip/firewall/nat/move',
              '=numbers=' + natId,
              '=destination=' + firstId
            ]);
            results.push(`✓ NAT rule dipindah ke awal chain dstnat`);
          } catch (moveErr) {
            results.push(
              `⚠ NAT rule TIDAK BISA dipindah ke awal chain: ${moveErr.message}. ` +
              `Cek manual di Winbox: IP → Firewall → NAT, pastikan rule "${TAG_NAT}" ada di posisi paling atas.`
            );
          }
        }
      } catch (e) {
        results.push(`⚠ Tidak bisa cek posisi NAT rule: ${e.message}`);
      }
    }
  } catch (e) {
    errors.push('NAT redirect: ' + e.message);
  }

  // ── 6. Filter ALLOW: src=ISOLIR dst=BYPASS → accept (priority tinggi) ──
  try {
    const allowRes = await runWithRetry(api, [
      '/ip/firewall/filter/add',
      '=chain=forward',
      '=src-address-list=' + LIST_ISOLIR,
      '=dst-address-list=' + LIST_BYPASS,
      '=action=accept',
      '=comment=' + TAG_BYPASS_FWD
    ]);
    const allowId = allowRes[0]?.['.id'] || allowRes[0]?.ret;
    results.push(`✓ Filter ACCEPT: ISOLIR → BYPASS (whitelist)`);

    // Move ke awal forward chain
    if (allowId) {
      try {
        const allFilter = await runWithRetry(api, ['/ip/firewall/filter/print']);
        const fwdRules = allFilter.filter(r => r.chain === 'forward' && r['.id'] !== allowId);
        if (fwdRules.length > 0) {
          await runWithRetry(api, [
            '/ip/firewall/filter/move',
            '=numbers=' + allowId,
            '=destination=' + fwdRules[0]['.id']
          ]).catch(() => null);
        }
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    errors.push('Filter ACCEPT: ' + e.message);
  }

  // ── 7. Filter DROP: src=ISOLIR catch-all (selain HTTP yang sudah di-NAT) ──
  // HTTP port 80 sudah di-redirect via DST-NAT (sebelum sampai chain forward),
  // jadi rule DROP ini menangkap HTTPS, ICMP, dan semua traffic lain dari pelanggan
  // diisolir yang TIDAK menuju bypass.
  try {
    const dropRes = await runWithRetry(api, [
      '/ip/firewall/filter/add',
      '=chain=forward',
      '=src-address-list=' + LIST_ISOLIR,
      '=action=drop',
      '=comment=' + TAG_DROP_FWD
    ]);
    const dropId = dropRes[0]?.['.id'] || dropRes[0]?.ret;
    results.push(`✓ Filter DROP: ISOLIR catch-all (block HTTPS & lainnya)`);

    // Move ke setelah ALLOW rule
    if (dropId) {
      try {
        const allFilter = await runWithRetry(api, ['/ip/firewall/filter/print']);
        const allowIdx = allFilter.findIndex(r => r.comment === TAG_BYPASS_FWD);
        const dropIdx  = allFilter.findIndex(r => r['.id'] === dropId);
        if (allowIdx >= 0 && dropIdx > allowIdx + 1) {
          // Drop sudah setelah allow — biarkan
        } else if (allowIdx >= 0 && allFilter[allowIdx + 1] && allFilter[allowIdx + 1]['.id'] !== dropId) {
          await runWithRetry(api, [
            '/ip/firewall/filter/move',
            '=numbers=' + dropId,
            '=destination=' + allFilter[allowIdx + 1]['.id']
          ]).catch(() => null);
        }
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    errors.push('Filter DROP: ' + e.message);
  }

  // ── 8. Setup PPPoE isolir-profile + IP pool (auto-create) ──
  // Best-effort: kalau gagal, isolir static masih jalan. Hanya isolir PPPoE
  // yang terganggu. Tampilkan warning di details.
  try {
    const IsolirPPPoE = require('./IsolirPPPoE');
    const pppRes = await IsolirPPPoE.setupIsolirProfile(api, sequelize);
    if (pppRes.success) {
      results.push(...(pppRes.details || []));
      results.push(`✓ Isolir profile PPPoE siap`);
    } else {
      results.push(`⚠ Setup profile PPPoE gagal: ${pppRes.error} (isolir static tetap berfungsi)`);
    }
  } catch (e) {
    results.push(`⚠ Setup profile PPPoE error: ${e.message} (isolir static tetap berfungsi)`);
  }

  // ── 9. Setup Web Proxy Redirect (kalau enabled) ──
  // Best-effort: kalau gagal/disabled, DST-NAT redirect HTTP V2 lama tetap
  // berfungsi sebagai fallback. Web Proxy menambahkan layer redirect yang
  // lebih "clean" untuk HTTP (browser langsung dapat 302 redirect dari proxy,
  // bukan dari NAT spoof). HTTPS tetap tidak bisa di-handle (limitation TLS).
  // Compatible RouterOS v6 & v7. Tidak butuh bridge/interface bind.
  try {
    const IsolirWebProxy = require('./IsolirWebProxy');
    const wpRes = await IsolirWebProxy.setupIsolirWebProxy(api);
    if (wpRes.skipped) {
      results.push(...(wpRes.details || []));
    } else if (wpRes.success) {
      results.push(...(wpRes.details || []));
      (wpRes.warnings || []).forEach(w => results.push('⚠ ' + w));
    } else {
      results.push(`⚠ Setup Web Proxy gagal — DST-NAT HTTP V2 tetap berfungsi sebagai fallback`);
      (wpRes.errors  || []).forEach(e => results.push('  ' + e));
      (wpRes.warnings|| []).forEach(w => results.push('  ⚠ ' + w));
    }
  } catch (e) {
    results.push(`⚠ Setup Web Proxy error: ${e.message} (DST-NAT HTTP V2 tetap berfungsi)`);
  }

  if (errors.length) {
    return { success: false, details: results, errors };
  }
  results.push(`✓ Setup firewall V2 selesai — pelanggan diisolir akan di-redirect ke halaman isolir`);
  return { success: true, details: results, errors: [] };
}

/**
 * Push hanya bypass list saja ke router (tanpa rebuild rules).
 * Dipakai saat user tambah/hapus bypass entry dan ingin sync cepat ke router.
 */
async function syncBypassOnly(api, deviceId) {
  return await syncBypassList(api, deviceId);
}

// ════════════════════════════════════════════════════════════════════════
// CRUD BYPASS LIST — operasi DB saja
// ════════════════════════════════════════════════════════════════════════

async function listGlobalBypass() {
  // Tolerant: kalau tabel belum ada, return [] bukan throw.
  // Ini bisa terjadi kalau ensureSchema masih jalan / gagal partial.
  return await sequelize.query(
    `SELECT id, address, label, category, is_active, created_at
       FROM isolir_bypass_global
       ORDER BY category, label, address`,
    { type: sequelize.QueryTypes.SELECT }
  ).catch(async (e) => {
    // Trigger schema retry — mungkin tabel belum ke-create di startup
    if (/doesn't exist|no such table/i.test(e.message || '')) {
      console.warn('[IsolirFirewallV2] table missing, retrying schema setup...');
      await ensureSchema();
      return [];
    }
    throw e;
  });
}

async function addGlobalBypass({ address, label, category }) {
  if (!address || !String(address).trim()) throw new Error('Address wajib diisi');
  const valid = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(address).trim());
  if (!valid) throw new Error('Format address harus IP (contoh: 8.8.8.8) atau CIDR (contoh: 10.0.0.0/8)');
  const params = [String(address).trim(), label || null, category || 'custom'];
  const sql = `INSERT INTO isolir_bypass_global (address, label, category, is_active)
               VALUES (?, ?, ?, 1)
               ON DUPLICATE KEY UPDATE label=VALUES(label), category=VALUES(category), is_active=1`;
  try {
    await sequelize.query(sql, { replacements: params });
  } catch (e) {
    if (/doesn't exist|no such table/i.test(e.message || '')) {
      console.warn('[IsolirFirewallV2] table missing on insert, retrying schema setup...');
      await ensureSchema();
      await sequelize.query(sql, { replacements: params });
    } else { throw e; }
  }
}

async function deleteGlobalBypass(id) {
  await sequelize.query('DELETE FROM isolir_bypass_global WHERE id=?', { replacements: [id] });
}

async function listRouterBypass(deviceId) {
  return await sequelize.query(
    `SELECT id, address, label, is_active, created_at
       FROM isolir_bypass_router WHERE device_id=?
       ORDER BY label, address`,
    { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
  ).catch(async (e) => {
    if (/doesn't exist|no such table/i.test(e.message || '')) {
      console.warn('[IsolirFirewallV2] table missing, retrying schema setup...');
      await ensureSchema();
      return [];
    }
    throw e;
  });
}

async function addRouterBypass(deviceId, { address, label }) {
  if (!address || !String(address).trim()) throw new Error('Address wajib diisi');
  const valid = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(String(address).trim());
  if (!valid) throw new Error('Format address harus IP atau CIDR');
  try {
    await sequelize.query(
      `INSERT INTO isolir_bypass_router (device_id, address, label, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE label=VALUES(label), is_active=1`,
      { replacements: [deviceId, String(address).trim(), label || null] }
    );
  } catch (e) {
    if (/doesn't exist|no such table/i.test(e.message || '')) {
      console.warn('[IsolirFirewallV2] table missing on insert, retrying schema setup...');
      await ensureSchema();
      // Retry sekali setelah schema dibuat
      await sequelize.query(
        `INSERT INTO isolir_bypass_router (device_id, address, label, is_active)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE label=VALUES(label), is_active=1`,
        { replacements: [deviceId, String(address).trim(), label || null] }
      );
    } else { throw e; }
  }
}

async function deleteRouterBypass(deviceId, entryId) {
  await sequelize.query(
    'DELETE FROM isolir_bypass_router WHERE id=? AND device_id=?',
    { replacements: [entryId, deviceId] }
  );
}

// ════════════════════════════════════════════════════════════════════════
// PUBLIC HELPER: lookup customer dari IP — dipakai oleh halaman /p/isolir
//
// Multi-layer fallback strategy (urutan dari cepat ke lambat):
//
//   Layer 1: static_ip di DB (paling cepat, 0 network round-trip)
//            Cocok untuk pelanggan dengan static IP yang terdata di sistem.
//
//   Layer 2: PPPoE active session di MikroTik
//            Query /ppp/active where address=X → dapat username →
//            cocokkan ke customer.pppoe_username.
//            Cocok untuk PPPoE dengan dynamic IP pool.
//
//   Layer 3: DHCP lease di MikroTik
//            Query /ip/dhcp-server/lease where address=X → dapat MAC →
//            cocokkan ke customer.ont_mac.
//            Cocok untuk static IP via DHCP atau ONT mode bridge.
//
//   Layer 4: address-list FLAYNET-ISOLIR comment
//            Saat customer di-isolir, comment di address-list di-set ke
//            customer_id. Kalau IP ada di list isolir, ambil customer
//            dari comment.
//            Fallback terakhir untuk skenario edge case.
//
// Setiap layer di-wrap try/catch independen — kalau MikroTik unreachable,
// layer berikutnya tetap di-coba. Layer 1 selalu jalan (in-DB).
//
// Result di-cache 30 detik di caller untuk hindari spam query MikroTik
// kalau pelanggan refresh berkali-kali.
// ════════════════════════════════════════════════════════════════════════
async function lookupCustomerByIp(ip) {
  if (!ip) return null;

  // ── Layer 1: static_ip ──────────────────────────────────────────
  const byStatic = await _lookupByStaticIp(ip);
  if (byStatic) return byStatic;

  // Layer 2-4 butuh koneksi MikroTik. Coba semua device yg aktif
  // (sistem support multi-MikroTik).
  let devices = [];
  try {
    devices = await sequelize.query(
      `SELECT m.id AS mikrotik_id, e.binary_port, e.wan_interface
         FROM mikrotiks m
         LEFT JOIN mikrotik_extensions e ON e.device_id = m.id
         WHERE COALESCE(m.is_active, 1) = 1
         ORDER BY m.id ASC`,
      { type: sequelize.QueryTypes.SELECT }
    );
  } catch (e) {
    logger.warn(`[lookupCustomerByIp] gagal ambil device list: ${e.message}`);
    return null;
  }

  for (const dev of devices) {
    let api = null;
    try {
      // Reuse koneksi pattern dari IsolirService
      const IsolirSvc = require('./IsolirService');
      const fullDev   = await IsolirSvc.loadDeviceWithMaster(dev.mikrotik_id, false);
      if (!fullDev) continue;
      api = await IsolirSvc.connectDevice(fullDev);

      // ── Layer 2: PPPoE active session ─────────────────────────────
      const byPppoe = await _lookupByPPPoEActive(api, ip);
      if (byPppoe) { try { api.close(); } catch {} return byPppoe; }

      // ── Layer 3: DHCP lease binding by MAC ────────────────────────
      const byDhcp = await _lookupByDhcpLease(api, ip);
      if (byDhcp) { try { api.close(); } catch {} return byDhcp; }

      // ── Layer 4: address-list FLAYNET-ISOLIR comment ──────────────
      const byList = await _lookupByAddressList(api, ip);
      if (byList) { try { api.close(); } catch {} return byList; }

    } catch (e) {
      logger.warn(`[lookupCustomerByIp] device #${dev.mikrotik_id} error: ${e.message}`);
    } finally {
      if (api) { try { api.close(); } catch {} }
    }
  }

  return null;
}

// ── Layer 1: query langsung ke DB by static_ip ──
async function _lookupByStaticIp(ip) {
  const rows = await sequelize.query(
    `SELECT c.id, c.customer_id, c.name, c.phone, c.static_ip, c.isolir_status,
            c.installation_date, c.billing_date,
            pkg.name AS package_name, pkg.price AS package_price
       FROM customers c
       LEFT JOIN packages pkg ON pkg.id = c.package_id
       WHERE c.static_ip = ?
       LIMIT 1`,
    { replacements: [ip], type: sequelize.QueryTypes.SELECT }
  );
  return rows[0] || null;
}

// ── Layer 2: PPPoE active → username → customer ──
async function _lookupByPPPoEActive(api, ip) {
  try {
    const sessions = await runWithRetry(api, ['/ppp/active/print', '?address=' + ip]);
    if (!sessions || !sessions.length) return null;
    const username = sessions[0].name;
    if (!username) return null;

    const rows = await sequelize.query(
      `SELECT c.id, c.customer_id, c.name, c.phone, c.static_ip, c.isolir_status,
              c.installation_date, c.billing_date,
              pkg.name AS package_name, pkg.price AS package_price
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE c.pppoe_username = ?
         LIMIT 1`,
      { replacements: [username], type: sequelize.QueryTypes.SELECT }
    );
    if (rows[0]) {
      // Override static_ip ke IP aktual yang sedang dipakai supaya
      // info di halaman akurat.
      rows[0].static_ip = ip;
      rows[0]._lookup_source = 'pppoe';
      return rows[0];
    }
  } catch (e) {
    logger.warn(`[lookup:pppoe] error: ${e.message}`);
  }
  return null;
}

// ── Layer 3: DHCP lease → MAC → customer ──
async function _lookupByDhcpLease(api, ip) {
  try {
    const leases = await runWithRetry(api, ['/ip/dhcp-server/lease/print', '?address=' + ip]);
    if (!leases || !leases.length) return null;
    const mac = (leases[0]['mac-address'] || leases[0]['active-mac-address'] || '').toUpperCase();
    if (!mac) return null;

    // ont_mac di DB bisa dengan format ":" atau "-" — normalisasi
    const macNormalized = mac.replace(/[^0-9A-F]/g, '');
    const rows = await sequelize.query(
      `SELECT c.id, c.customer_id, c.name, c.phone, c.static_ip, c.isolir_status,
              c.installation_date, c.billing_date,
              pkg.name AS package_name, pkg.price AS package_price
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE UPPER(REPLACE(REPLACE(c.ont_mac,':',''),'-','')) = ?
         LIMIT 1`,
      { replacements: [macNormalized], type: sequelize.QueryTypes.SELECT }
    );
    if (rows[0]) {
      rows[0].static_ip = ip;
      rows[0]._lookup_source = 'dhcp';
      return rows[0];
    }
  } catch (e) {
    logger.warn(`[lookup:dhcp] error: ${e.message}`);
  }
  return null;
}

// ── Layer 4: cek address-list FLAYNET-ISOLIR pakai comment ──
async function _lookupByAddressList(api, ip) {
  try {
    const entries = await runWithRetry(api, [
      '/ip/firewall/address-list/print',
      '?list=' + LIST_ISOLIR,
      '?address=' + ip
    ]);
    if (!entries || !entries.length) return null;
    const comment = entries[0].comment || '';
    // Comment format yang di-set IsolirService.isolirCustomer:
    //   "FLAYNET-ISOLIR-<customer_id>"
    // Note: ada juga legacy format "WAU-ISOLIR-..." yang dimigrate ke FLAYNET-.
    const m = comment.match(/(?:FLAYNET|WAU)-ISOLIR-([^\s|,]+)/);
    if (!m) return null;
    const customerId = m[1];

    const rows = await sequelize.query(
      `SELECT c.id, c.customer_id, c.name, c.phone, c.static_ip, c.isolir_status,
              c.installation_date, c.billing_date,
              pkg.name AS package_name, pkg.price AS package_price
         FROM customers c
         LEFT JOIN packages pkg ON pkg.id = c.package_id
         WHERE c.customer_id = ?
         LIMIT 1`,
      { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
    );
    if (rows[0]) {
      rows[0]._lookup_source = 'address-list';
      return rows[0];
    }
  } catch (e) {
    logger.warn(`[lookup:addrlist] error: ${e.message}`);
  }
  return null;
}

async function getCustomerInvoices(customerId) {
  return await sequelize.query(
    `SELECT id, invoice_number, amount, due_date, status, created_at
       FROM invoices
       WHERE customer_id = ? AND status IN ('unpaid','overdue')
       ORDER BY due_date ASC`,
    { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
  );
}

// ── Run schema setup at module load ──
ensureSchema();

module.exports = {
  // Constants
  LIST_ISOLIR, LIST_BYPASS,
  // Schema
  ensureSchema,
  // Setup & sync
  setupFirewallV2,
  syncBypassOnly,
  purgeOldRules,
  // Helpers
  resolveIsolirPageUrl,
  parseRedirectTarget,
  getMergedBypassList,
  // Bypass CRUD
  listGlobalBypass,
  addGlobalBypass,
  deleteGlobalBypass,
  listRouterBypass,
  addRouterBypass,
  deleteRouterBypass,
  // Public page support
  lookupCustomerByIp,
  getCustomerInvoices,
};
