/**
 * IsolirHotspotBinding.js
 * ────────────────────────────────────────────────────────────────────
 * Isolir untuk pelanggan Hotspot IP Static (IP Binding).
 *
 *   - NORMAL  : binding type=bypassed, disabled=false → internet jalan tanpa login.
 *   - ISOLIR  : binding disabled=true → binding tidak berlaku → kena captive portal.
 *   - RESTORE : binding disabled=false → akses normal lagi.
 *
 * FIX PENTING: operasi binding memakai instance MikrotikService (mt) yang SAMA
 * dengan halaman UI (get/put/patch/delete via mt.request). Sebelumnya isolir
 * pakai native client terpisah di IsolirService yang ternyata tidak konsisten
 * (set disabled tidak benar-benar tereksekusi pada sebagian router). Kini isolir
 * & UI memakai jalur transport identik, jadi hasilnya konsisten.
 * ────────────────────────────────────────────────────────────────────
 */

const BINDING_COMMENT_PREFIX = 'FLAYNET-HS-BIND';
const BINDING_PATH = '/ip/hotspot/ip-binding';

function normalizeMac(mac) {
  if (!mac) return '';
  return String(mac).trim().toUpperCase().replace(/[-.\s]/g, ':');
}

// ── Jalur utama: MikrotikService (mt) ───────────────────────────────

async function mtListBindings(mt) {
  const raw = await mt.get(BINDING_PATH);
  return (Array.isArray(raw) ? raw : []).map(b => ({
    id:       b['.id'] || b.id,
    mac:      normalizeMac(b['mac-address'] || b.mac || b.macAddress || ''),
    address:  (b.address || '').trim(),
    type:     b.type || 'regular',
    comment:  b.comment || '',
    disabled: b.disabled === true || b.disabled === 'true',
  }));
}

function mtMatch(bindings, { mac, address, customerId }) {
  const macN = normalizeMac(mac);
  const addr = (address || '').trim();
  const cmt  = customerId ? `${BINDING_COMMENT_PREFIX}-${customerId}` : null;
  return bindings.filter(b =>
    (macN && b.mac === macN) ||
    (addr && b.address === addr) ||
    (cmt && b.comment === cmt)
  );
}

async function mtKickActive(mt, { mac, address }) {
  const macN = normalizeMac(mac);
  const addr = (address || '').trim();
  let kicked = 0;
  try {
    const active = await mt.get('/ip/hotspot/active');
    for (const s of (Array.isArray(active) ? active : [])) {
      const sMac = normalizeMac(s['mac-address'] || s.mac || '');
      const sAddr = (s.address || '').trim();
      const id = s['.id'] || s.id;
      if (id && ((macN && sMac === macN) || (addr && sAddr === addr))) {
        try { await mt.delete(`/ip/hotspot/active/${encodeURIComponent(id)}`); kicked++; } catch (_) {}
      }
    }
  } catch (_) {}
  return kicked;
}

async function mtSetDisabled(mt, { mac, address, customerId, disabled, create }) {
  const macN = normalizeMac(mac);
  const addr = (address || '').trim();

  let bindings = await mtListBindings(mt);
  let matched = mtMatch(bindings, { mac: macN, address: addr, customerId });

  if (matched.length === 0 && create) {
    const body = { type: 'bypassed', comment: `${BINDING_COMMENT_PREFIX}-${customerId || ''}`,
                   disabled: disabled ? 'true' : 'false' };
    if (macN) body['mac-address'] = macN;
    if (addr) body.address = addr;
    try { await mt.put(BINDING_PATH, body); }
    catch (e) { if (!/already exists|such client/i.test(e.message || '')) throw e; }
    bindings = await mtListBindings(mt);
    matched = mtMatch(bindings, { mac: macN, address: addr, customerId });
  }

  if (matched.length === 0) {
    console.log('[HS-Binding] tidak ada binding cocok (mac=%s addr=%s) dari %d binding di router %s',
      macN, addr, bindings.length, mt && mt.host ? mt.host : '?');
    return null;
  }

  matched.sort((a, b) => (b.type === 'bypassed' ? 1 : 0) - (a.type === 'bypassed' ? 1 : 0));
  const keep = matched[0];
  for (let i = 1; i < matched.length; i++) {
    try { await mt.delete(`${BINDING_PATH}/${encodeURIComponent(matched[i].id)}`); } catch (_) {}
  }

  await mt.patch(`${BINDING_PATH}/${encodeURIComponent(keep.id)}`, { disabled: disabled ? 'true' : 'false' });

  try {
    const after = await mtListBindings(mt);
    const v = after.find(b => b.id === keep.id);
    if (v) console.log('[HS-Binding] binding %s → disabled=%s (target %s) router %s',
      keep.id, v.disabled, disabled, mt && mt.host ? mt.host : '?');
  } catch (_) {}

  return keep.id;
}

async function isolirByMt(mt, customer) {
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  if (!mac && !address) throw new Error('Pelanggan hotspot belum punya MAC address maupun Static IP');
  const bindingId = await mtSetDisabled(mt, { mac, address, customerId: customer.customer_id, disabled: true, create: false });
  const kicked = await mtKickActive(mt, { mac, address });
  const subj = mac || address;
  const host = mt && mt.host ? mt.host : 'router';
  return {
    message: bindingId
      ? `IP Binding ${subj} dinonaktifkan${kicked ? ` (${kicked} session di-kick)` : ''}`
      : `Tidak ada IP binding untuk ${subj} di ${host} (cek apakah pelanggan terhubung ke router yang benar)`,
    bindingId, kicked,
  };
}

async function restoreByMt(mt, customer) {
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  if (!mac && !address) throw new Error('Pelanggan hotspot belum punya MAC address maupun Static IP');
  const bindingId = await mtSetDisabled(mt, { mac, address, customerId: customer.customer_id, disabled: false, create: true });
  const subj = mac || address;
  return { message: `IP Binding ${subj} diaktifkan kembali`, bindingId };
}

async function statusByMt(mt, customer) {
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  const bindings = await mtListBindings(mt);
  const matched = mtMatch(bindings, { mac, address, customerId: customer.customer_id });
  if (!matched.length) return { exists: false, disabled: null, bindingId: null, type: null };
  const b = matched[0];
  return { exists: true, disabled: b.disabled, bindingId: b.id, type: b.type };
}

// ── Kompat lama berbasis api.run([...]) ─────────────────────────────

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
      if (isTransient && attempt < maxRetry) { await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 800)); continue; }
      throw e;
    }
  }
  throw lastErr;
}
async function legacyFind(api, { mac, address }) {
  const macN = mac ? normalizeMac(mac) : '';
  const addr = (address || '').trim();
  let all = [];
  try { all = await runWithRetry(api, ['/ip/hotspot/ip-binding/print']); } catch (_) { all = []; }
  const found = [], seen = new Set();
  for (const b of (all || [])) {
    const id = b['.id'] || b.id; if (!id) continue; b['.id'] = id;
    const bMac = normalizeMac(b['mac-address'] || b.mac || b.macAddress || '');
    const bAddr = (b.address || '').trim();
    if (((macN && bMac === macN) || (addr && bAddr === addr)) && !seen.has(id)) { seen.add(id); found.push(b); }
  }
  return found;
}
async function legacyKick(api, { mac, address }) {
  const macN = normalizeMac(mac); let kicked = 0;
  try {
    const active = await runWithRetry(api, ['/ip/hotspot/active/print']);
    for (const s of (active || [])) {
      const sMac = normalizeMac(s['mac-address']); const sAddr = s.address || '';
      if (((macN && sMac === macN) || (address && sAddr === address)) && s['.id']) {
        await runWithRetry(api, ['/ip/hotspot/active/remove', '=.id=' + s['.id']]); kicked++;
      }
    }
  } catch (_) {}
  return kicked;
}
async function legacyUpsert(api, { mac, address, customerId, disabled, noCreate }) {
  const flag = disabled ? 'yes' : 'no';
  let bindings = await legacyFind(api, { mac, address });
  if (bindings.length === 0 && !noCreate) {
    const words = ['/ip/hotspot/ip-binding/add', '=type=bypassed'];
    if (mac) words.push('=mac-address=' + mac);
    if (address) words.push('=address=' + address);
    words.push('=comment=' + BINDING_COMMENT_PREFIX + '-' + (customerId || ''));
    words.push('=disabled=' + flag);
    try { await runWithRetry(api, words); }
    catch (e) { if (!/already exists|such client/i.test(e.message || '')) throw e; }
    bindings = await legacyFind(api, { mac, address });
  }
  if (bindings.length === 0) return null;
  bindings.sort((a, b) => (a.type === 'bypassed' ? -1 : 0) - (b.type === 'bypassed' ? -1 : 0));
  const keep = bindings[0];
  for (let i = 1; i < bindings.length; i++) {
    try { await runWithRetry(api, ['/ip/hotspot/ip-binding/remove', '=.id=' + bindings[i]['.id']]); } catch (_) {}
  }
  await runWithRetry(api, ['/ip/hotspot/ip-binding/set', '=.id=' + keep['.id'], '=disabled=' + flag]);
  return keep['.id'];
}

// ── Dispatcher: pakai mt kalau punya .patch, kalau tidak fallback api.run ──

async function isolirHotspotBinding(api, customer) {
  if (api && typeof api.patch === 'function' && typeof api.get === 'function') return isolirByMt(api, customer);
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  if (!mac && !address) throw new Error('Pelanggan hotspot belum punya MAC address maupun Static IP');
  const bindingId = await legacyUpsert(api, { mac, address, customerId: customer.customer_id, disabled: true, noCreate: true });
  const kicked = await legacyKick(api, { mac, address });
  const subj = mac || address;
  return { message: bindingId ? `IP Binding ${subj} dinonaktifkan${kicked ? ` (${kicked} session di-kick)` : ''}` : `Tidak ada IP binding untuk ${subj} (cek router pelanggan)`, bindingId, kicked };
}

async function restoreHotspotBinding(api, customer) {
  if (api && typeof api.patch === 'function' && typeof api.get === 'function') return restoreByMt(api, customer);
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  if (!mac && !address) throw new Error('Pelanggan hotspot belum punya MAC address maupun Static IP');
  const bindingId = await legacyUpsert(api, { mac, address, customerId: customer.customer_id, disabled: false });
  const subj = mac || address;
  return { message: `IP Binding ${subj} diaktifkan kembali`, bindingId };
}

async function getBindingStatus(api, customer) {
  if (api && typeof api.get === 'function' && typeof api.patch === 'function') return statusByMt(api, customer);
  const mac = normalizeMac(customer.mac_address);
  const address = (customer.static_ip || '').trim();
  const found = await legacyFind(api, { mac, address });
  if (!found.length) return { exists: false, disabled: null, bindingId: null, type: null };
  const b = found[0];
  return { exists: true, disabled: b.disabled === 'true' || b.disabled === true, bindingId: b['.id'], type: b.type || 'regular' };
}

module.exports = {
  isolirHotspotBinding, restoreHotspotBinding, getBindingStatus,
  isolirByMt, restoreByMt, statusByMt,
  normalizeMac, BINDING_COMMENT_PREFIX,
};
