/**
 * IsolirPPPoE.js
 * ────────────────────────────────────────────────────────────────────
 * Isolir untuk pelanggan PPPoE — Profile switch + kick session.
 *
 * Strategi:
 *   1. Backup profile asli dari /ppp/secret/print
 *   2. Set profile=isolir-profile (rate-limit rendah, IP dari pool isolir)
 *   3. Kick session aktif /ppp/active/remove → user disconnect & reconnect
 *      dengan profile baru → dapat IP dari pool isolir → DST-NAT redirect bekerja
 *
 * Restore:
 *   1. Set profile kembali ke original (dari customers.pppoe_profile_original)
 *   2. Kick session lagi → reconnect dengan profile normal
 *
 * Setup MikroTik (auto saat Setup Firewall di IsolirFirewallV2):
 *   /ip pool add name=isolir-pool ranges=10.255.255.2-10.255.255.254
 *   /ppp profile add name=isolir-profile
 *     local-address=10.255.255.1
 *     remote-address=isolir-pool
 *     address-list=FLAYNET-ISOLIR
 *     rate-limit=128k/128k
 * ────────────────────────────────────────────────────────────────────
 */

// Default nama profile & pool isolir. Bisa di-override via app_settings.
const DEFAULT_ISOLIR_PROFILE = 'isolir-profile';
const DEFAULT_ISOLIR_POOL    = 'isolir-pool';
const DEFAULT_POOL_RANGES    = '10.255.255.2-10.255.255.254';
const DEFAULT_LOCAL_ADDR     = '10.255.255.1';
const DEFAULT_RATE_LIMIT     = '128k/128k';

// Runner dengan retry (sama seperti di IsolirFirewallV2)
async function runWithRetry(api, words, maxRetry = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const result = await api.run(words);
      await new Promise(r => setTimeout(r, 80));
      return result;
    } catch (e) {
      lastErr = e;
      const isTransient = /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|ECONNREFUSED/i.test(e.message || '');
      if (isTransient && attempt < maxRetry) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 800));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Ambil setting isolir profile/pool dari app_settings dengan fallback default.
 */
async function getPPPoESettings(sequelize) {
  const rows = await sequelize.query(
    `SELECT \`key\`, value FROM app_settings
      WHERE \`key\` IN ('isolir_pppoe_profile_name','isolir_pppoe_pool_name',
                        'isolir_pppoe_pool_range','isolir_pppoe_local_addr',
                        'isolir_pppoe_rate_limit')`,
    { type: sequelize.QueryTypes.SELECT }
  ).catch(() => []);
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  return {
    profileName: map.isolir_pppoe_profile_name || DEFAULT_ISOLIR_PROFILE,
    poolName:    map.isolir_pppoe_pool_name    || DEFAULT_ISOLIR_POOL,
    poolRange:   map.isolir_pppoe_pool_range   || DEFAULT_POOL_RANGES,
    localAddr:   map.isolir_pppoe_local_addr   || DEFAULT_LOCAL_ADDR,
    rateLimit:   map.isolir_pppoe_rate_limit   || DEFAULT_RATE_LIMIT,
  };
}

/**
 * Setup IP pool & PPP profile isolir di MikroTik. Idempotent.
 * Dipanggil dari setupFirewallV2.
 */
async function setupIsolirProfile(api, sequelize) {
  const cfg = await getPPPoESettings(sequelize);
  const results = [];

  // ── 1. Pool ──
  try {
    const existing = await runWithRetry(api, ['/ip/pool/print', '?name=' + cfg.poolName]);
    if (existing.length === 0) {
      await runWithRetry(api, [
        '/ip/pool/add',
        '=name=' + cfg.poolName,
        '=ranges=' + cfg.poolRange
      ]);
      results.push(`✓ IP pool "${cfg.poolName}" dibuat (${cfg.poolRange})`);
    } else {
      // Update ranges kalau berbeda
      const curRanges = String(existing[0].ranges || '').trim();
      if (curRanges !== cfg.poolRange && existing[0]['.id']) {
        await runWithRetry(api, [
          '/ip/pool/set',
          '=.id=' + existing[0]['.id'],
          '=ranges=' + cfg.poolRange
        ]);
        results.push(`✓ IP pool "${cfg.poolName}" range diupdate ke ${cfg.poolRange}`);
      } else {
        results.push(`• IP pool "${cfg.poolName}" sudah ada`);
      }
    }
  } catch (e) {
    return { success: false, error: `Pool: ${e.message}`, details: results };
  }

  // ── 2. PPP Profile ──
  try {
    const existing = await runWithRetry(api, ['/ppp/profile/print', '?name=' + cfg.profileName]);
    const profileArgs = [
      '=name=' + cfg.profileName,
      '=local-address=' + cfg.localAddr,
      '=remote-address=' + cfg.poolName,
      '=address-list=FLAYNET-ISOLIR',
      '=rate-limit=' + cfg.rateLimit
    ];
    if (existing.length === 0) {
      await runWithRetry(api, ['/ppp/profile/add', ...profileArgs]);
      results.push(`✓ PPP profile "${cfg.profileName}" dibuat`);
    } else if (existing[0]['.id']) {
      // Update existing untuk memastikan semua field sinkron
      await runWithRetry(api, [
        '/ppp/profile/set',
        '=.id=' + existing[0]['.id'],
        '=local-address=' + cfg.localAddr,
        '=remote-address=' + cfg.poolName,
        '=address-list=FLAYNET-ISOLIR',
        '=rate-limit=' + cfg.rateLimit
      ]);
      results.push(`• PPP profile "${cfg.profileName}" sudah ada (sinkron field)`);
    }
  } catch (e) {
    return { success: false, error: `Profile: ${e.message}`, details: results };
  }

  return { success: true, details: results };
}

/**
 * Isolir customer PPPoE: backup profile asli → switch ke isolir-profile → kick.
 *
 * @param {object} api - MikroTik API client
 * @param {string} pppoeUsername - nama PPP secret
 * @param {object} sequelize - untuk read settings + update customer.pppoe_profile_original
 * @param {number} customerId - untuk update DB
 * @returns {object} { success, originalProfile, message }
 */
async function isolirPPPoEUser(api, pppoeUsername, sequelize, customerId) {
  if (!pppoeUsername) throw new Error('PPPoE username kosong');
  const cfg = await getPPPoESettings(sequelize);

  // ── 1. Ambil profile asli dari /ppp/secret ──
  const secrets = await runWithRetry(api, ['/ppp/secret/print', '?name=' + pppoeUsername]);
  if (secrets.length === 0) {
    throw new Error(`PPP secret "${pppoeUsername}" tidak ditemukan di MikroTik`);
  }
  const secret = secrets[0];
  const originalProfile = String(secret.profile || 'default');

  // Hindari self-overwrite kalau sudah ter-isolir (re-isolir)
  if (originalProfile !== cfg.profileName) {
    // Backup ke DB SEBELUM switch — supaya restore selalu punya referensi
    await sequelize.query(
      'UPDATE customers SET pppoe_profile_original=? WHERE id=?',
      { replacements: [originalProfile, customerId] }
    );
  }

  // ── 2. Switch profile ke isolir-profile ──
  if (!secret['.id']) throw new Error('PPP secret tidak punya ID');
  await runWithRetry(api, [
    '/ppp/secret/set',
    '=.id=' + secret['.id'],
    '=profile=' + cfg.profileName
  ]);

  // ── 3. Kick session aktif (kalau ada) → user reconnect dengan profile baru ──
  let kicked = 0;
  try {
    const active = await runWithRetry(api, ['/ppp/active/print', '?name=' + pppoeUsername]);
    for (const sess of active) {
      if (sess['.id']) {
        await runWithRetry(api, ['/ppp/active/remove', '=.id=' + sess['.id']]);
        kicked++;
      }
    }
  } catch (_) { /* kick gagal tidak fatal */ }

  return {
    success: true,
    originalProfile,
    kicked,
    message: `Profile diubah ke "${cfg.profileName}", ${kicked} session di-kick`
  };
}

/**
 * Restore customer PPPoE: kembalikan profile asli + kick session.
 *
 * @param {object} api - MikroTik API client
 * @param {string} pppoeUsername - nama PPP secret
 * @param {string} originalProfile - dari customers.pppoe_profile_original
 * @returns {object} { success, kicked, message }
 */
async function restorePPPoEUser(api, pppoeUsername, originalProfile) {
  if (!pppoeUsername) throw new Error('PPPoE username kosong');
  const targetProfile = originalProfile || 'default';

  const secrets = await runWithRetry(api, ['/ppp/secret/print', '?name=' + pppoeUsername]);
  if (secrets.length === 0) {
    throw new Error(`PPP secret "${pppoeUsername}" tidak ditemukan di MikroTik`);
  }
  const secret = secrets[0];
  if (!secret['.id']) throw new Error('PPP secret tidak punya ID');

  // Restore profile
  await runWithRetry(api, [
    '/ppp/secret/set',
    '=.id=' + secret['.id'],
    '=profile=' + targetProfile
  ]);

  // Kick session aktif → reconnect dengan profile normal
  let kicked = 0;
  try {
    const active = await runWithRetry(api, ['/ppp/active/print', '?name=' + pppoeUsername]);
    for (const sess of active) {
      if (sess['.id']) {
        await runWithRetry(api, ['/ppp/active/remove', '=.id=' + sess['.id']]);
        kicked++;
      }
    }
  } catch (_) { /* kick gagal tidak fatal */ }

  return {
    success: true,
    kicked,
    message: `Profile dipulihkan ke "${targetProfile}", ${kicked} session di-kick`
  };
}

module.exports = {
  DEFAULT_ISOLIR_PROFILE,
  DEFAULT_ISOLIR_POOL,
  getPPPoESettings,
  setupIsolirProfile,
  isolirPPPoEUser,
  restorePPPoEUser,
};
