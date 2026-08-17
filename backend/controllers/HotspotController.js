/**
 * HotspotController.js
 * REST API controller untuk semua fitur MikroTik Hotspot
 */

const HotspotService  = require('../services/HotspotService');
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const logger          = require('../utils/logger');
const fs              = require('fs');
const path            = require('path');

// Pricing config — disimpan per device agar mendukung multi-MikroTik (setiap
// router boleh punya struktur harga sendiri). File JSON sederhana di /uploads.
const PRICING_PATH = path.join(__dirname, '../../uploads/hotspot_pricing.json');

function loadPricing() {
  try {
    if (!fs.existsSync(PRICING_PATH)) return {};
    const raw = fs.readFileSync(PRICING_PATH, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    logger.warn('Failed to load hotspot_pricing.json:', e.message);
    return {};
  }
}

function savePricing(obj) {
  try {
    fs.writeFileSync(PRICING_PATH, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (e) {
    logger.error('Failed to save hotspot_pricing.json:', e.message);
    return false;
  }
}

// Pricing entry sekarang berbentuk objek { price, limitUptime } per profile.
// File legacy berisi number langsung — di-upgrade otomatis saat dibaca.
//
//   number  → { price: N, limitUptime: '' }
//   object  → diambil apa adanya (sanitized)
//   else    → { price: 0, limitUptime: '' }
function normalizePricingEntry(v) {
  if (v == null) return { price: 0, limitUptime: '' };
  if (typeof v === 'number') {
    return { price: v >= 0 ? v : 0, limitUptime: '' };
  }
  if (typeof v === 'object') {
    const price = Number(v.price);
    return {
      price: Number.isFinite(price) && price >= 0 ? price : 0,
      limitUptime: typeof v.limitUptime === 'string' ? v.limitUptime.trim() : '',
    };
  }
  return { price: 0, limitUptime: '' };
}

// Normalize seluruh map pricing untuk satu device.
function normalizePricingMap(deviceMap) {
  const out = {};
  if (!deviceMap || typeof deviceMap !== 'object') return out;
  for (const k of Object.keys(deviceMap)) {
    out[k] = normalizePricingEntry(deviceMap[k]);
  }
  return out;
}

// Ekstrak tanggal "Generated DD/MM/YYYY" dari comment voucher.
// Returns Date object atau null.
function parseGeneratedDate(comment) {
  if (!comment || typeof comment !== 'string') return null;
  const m = comment.match(/Generated\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!m) return null;
  const d = parseInt(m[1]), mo = parseInt(m[2]) - 1, y = parseInt(m[3]);
  if (isNaN(d) || isNaN(mo) || isNaN(y)) return null;
  const dt = new Date(y, mo, d);
  // sanity check
  if (isNaN(dt.getTime())) return null;
  return dt;
}

// Parse comment voucher format pipe-separated:
//   "Generated DD/MM/YYYY | Profile: xxx | Rp NNNN | Sold-to: 08xxx"
// Semua field opsional — kalau tidak ada, value default (null/empty/0).
function parseVoucherComment(comment) {
  const out = { generatedAt: null, profileFromComment: '', priceFromComment: 0, soldTo: '' };
  if (!comment || typeof comment !== 'string') return out;
  out.generatedAt = parseGeneratedDate(comment);
  const mp = comment.match(/Profile:\s*([^|]+?)(?:\s*\||$)/i);
  if (mp) out.profileFromComment = mp[1].trim();
  const mr = comment.match(/Rp\s*([\d.,]+)/i);
  if (mr) {
    const n = parseInt(mr[1].replace(/[.,]/g, ''));
    if (!isNaN(n)) out.priceFromComment = n;
  }
  const ms = comment.match(/Sold-to:\s*([^|]+?)(?:\s*\||$)/i);
  if (ms) out.soldTo = ms[1].trim();
  return out;
}

// User dianggap "sudah dipakai" jika uptime bukan 0 atau ada bytes terpakai.
function isUserUsed(u) {
  if (!u) return false;
  if (u.bytesIn  && u.bytesIn  > 0) return true;
  if (u.bytesOut && u.bytesOut > 0) return true;
  const ut = String(u.uptime || '').trim();
  if (!ut || ut === '0s' || ut === '0' || ut === '00:00:00') return false;
  return true;
}

// Resolve `limit-uptime` untuk user baru / voucher.
// Prioritas:
//   1. Nilai yang dikirim user secara eksplisit (req.body.limitUptime)
//   2. Mapping dari pricing config untuk profile yang dipilih
//   3. Kosong = unlimited (MikroTik default)
//
// Dipakai oleh createUser, generateVouchers, dan updateUser supaya field
// "Limit Waktu" di profile config benar-benar diterapkan ke user MikroTik
// (MikroTik tidak punya `limit-uptime` di user-profile level, hanya di user).
function resolveLimitUptime(req, explicitValue, profileName) {
  // Kalau ada nilai eksplisit (non-empty string), pakai itu — user override manual
  if (typeof explicitValue === 'string' && explicitValue.trim() !== '') {
    return explicitValue.trim();
  }
  if (!profileName) return '';
  try {
    const deviceKey = String(resolveDeviceId(req) || 'default');
    const pricing = normalizePricingMap(loadPricing()[deviceKey] || {});
    const entry = pricing[profileName];
    return entry && entry.limitUptime ? entry.limitUptime : '';
  } catch (e) {
    logger.warn('resolveLimitUptime error:', e.message);
    return '';
  }
}

// Helper: ambil device_id dari query/header
function resolveDeviceId(req) {
  const q = req.query?.device_id;
  const h = req.headers?.['x-device-id'];
  const v = q || h;
  return v ? parseInt(v) : null;
}

// Async — resolve MikroTik instance dari tabel devices (kalau ada device_id)
// atau fallback ke env default. Pattern konsisten dengan InterfaceTrafficController.
async function getService(req) {
  // Backward-compat: kalau ada cfg override di middleware lama, tetap pakai itu
  const cfgOverride = req._mikrotikConfig || null;
  if (cfgOverride) return new HotspotService(cfgOverride);
  // Resolve instance per device_id (default kalau null).
  // HotspotService accept MikrotikService instance langsung sekarang —
  // tidak perlu lagi extract config & re-instantiate. Lebih efisien & menghindari
  // bug "lost config" kalau ada field di MikrotikService yang tidak ada di config.
  const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
  return new HotspotService(mt);
}

const HotspotController = {

  // ─── STATS ────────────────────────────────────────────────
  async summary(req, res) {
    try {
      const svc  = await getService(req);
      const data = await svc.getSummary();
      res.json({ success: true, data });
    } catch (err) {
      logger.error('Hotspot summary error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── SERVERS ──────────────────────────────────────────────
  async getServers(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getServers();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── PROFILES (hotspot server profile) ────────────────────
  async getProfiles(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getProfiles();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async createProfile(req, res) {
    try {
      const svc = await getService(req);
      if (!req.body?.name) return res.status(400).json({ success: false, message: 'Nama profile wajib' });
      const data = await svc.createProfile(req.body);
      res.json({ success: true, data, message: 'Server profile berhasil dibuat' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async updateProfile(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.updateProfile(req.params.id, req.body);
      res.json({ success: true, data, message: 'Server profile berhasil diupdate' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteProfile(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteProfile(req.params.id);
      res.json({ success: true, message: 'Server profile dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── USER PROFILES (paket voucher) ────────────────────────
  async getUserProfiles(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getUserProfiles();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async createUserProfile(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.createUserProfile(req.body);
      res.json({ success: true, data, message: 'User profile berhasil dibuat' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async updateUserProfile(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.updateUserProfile(req.params.id, req.body);
      res.json({ success: true, data, message: 'User profile berhasil diupdate' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteUserProfile(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteUserProfile(req.params.id);
      res.json({ success: true, message: 'User profile berhasil dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── USERS ────────────────────────────────────────────────
  async getUsers(req, res) {
    try {
      const params = {};
      if (req.query.profile) params.profile = req.query.profile;
      if (req.query.server)  params.server  = req.query.server;
      const svc = await getService(req);
      const data = await svc.getUsers(params);
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async createUser(req, res) {
    try {
      const svc = await getService(req);
      // Auto-resolve limit-uptime dari pricing config kalau user tidak isi manual
      const payload = Object.assign({}, req.body);
      payload.limitUptime = resolveLimitUptime(req, payload.limitUptime, payload.profile);
      const data = await svc.createUser(payload);
      res.json({ success: true, data, message: 'User hotspot berhasil dibuat' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async updateUser(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.updateUser(req.params.id, req.body);
      res.json({ success: true, data, message: 'User hotspot berhasil diupdate' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteUser(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteUser(req.params.id);
      res.json({ success: true, message: 'User hotspot berhasil dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteBatch(req, res) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ success: false, message: 'IDs array required' });
      const svc = await getService(req);
      const result = await svc.deleteUserBatch(ids);
      res.json({ success: true, ...result, message: `${result.deleted} user dihapus` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async enableUser(req, res) {
    try {
      const svc = await getService(req);
      await svc.enableUser(req.params.id);
      res.json({ success: true, message: 'User diaktifkan' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async disableUser(req, res) {
    try {
      const svc = await getService(req);
      await svc.disableUser(req.params.id);
      res.json({ success: true, message: 'User dinonaktifkan' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── GENERATE VOUCHERS ────────────────────────────────────
  async generateVouchers(req, res) {
    try {
      const { count, profile, server, prefix, passwordLength,
              comment, limitUptime, limitBytesTotal, soldTo } = req.body;

      if (!count || count < 1 || count > 5000)
        return res.status(400).json({ success: false, message: 'Count harus antara 1-5000' });

      const profileName = profile || 'default';
      // Auto-resolve limit-uptime dari pricing config kalau payload kosong.
      // MikroTik tidak punya limit-uptime di user-profile, jadi kita inject
      // saat create user supaya voucher kadaluarsa otomatis sesuai durasi.
      const finalLimitUptime = resolveLimitUptime(req, limitUptime, profileName);

      // Resolve harga dari pricing config (untuk embed di comment voucher).
      // Frontend tidak perlu kirim — backend lookup sendiri agar konsisten.
      let price = 0;
      try {
        const deviceKey = String(resolveDeviceId(req) || 'default');
        const pricing = normalizePricingMap(loadPricing()[deviceKey] || {});
        price = (pricing[profileName] && pricing[profileName].price) || 0;
      } catch (e) { /* silent — harga 0 = comment tidak akan include Rp */ }

      // Log untuk batch besar — supaya bisa di-trace di pm2 logs kalau lama
      if (count >= 100) {
        logger.info(`[Hotspot] generate ${count} voucher (profile=${profileName}, server=${server||'all'}, limit-uptime=${finalLimitUptime||'unlimited'}, price=${price})...`);
      }
      const t0 = Date.now();

      const svc = await getService(req);
      const result = await svc.generateVouchers({
        count: parseInt(count),
        profile: profileName,
        server:  server  || 'all',
        prefix:  prefix  || 'vc',
        passwordLength: parseInt(passwordLength) || 8,
        comment,
        limitUptime: finalLimitUptime,
        limitBytesTotal: parseInt(limitBytesTotal) || 0,
        price,
        soldTo: typeof soldTo === 'string' ? soldTo.trim() : '',
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (count >= 100) {
        logger.info(`[Hotspot] generate done: ${result.success}/${count} sukses, ${result.errors.length} gagal, ${elapsed}s`);
      }
      res.json({ success: true, ...result, appliedLimitUptime: finalLimitUptime, appliedPrice: price });
    } catch (err) {
      logger.error(`[Hotspot] generate failed: ${err.message}`);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── ACTIVE SESSIONS ──────────────────────────────────────
  async getActiveSessions(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getActiveSessions();
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async disconnectSession(req, res) {
    try {
      const svc = await getService(req);
      await svc.disconnectSession(req.params.id);
      res.json({ success: true, message: 'Sesi berhasil diputus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async disconnectSessionBatch(req, res) {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0)
        return res.status(400).json({ success: false, message: 'IDs array required' });
      const svc = await getService(req);
      const result = await svc.disconnectSessionBatch(ids);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── HOSTS ────────────────────────────────────────────────
  async getHosts(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getHosts();
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async makeHostBinding(req, res) {
    try {
      const svc = await getService(req);
      await svc.makeHostBinding(req.params.id);
      res.json({ success: true, message: 'Host dijadikan IP binding (bypassed)' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteHost(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteHost(req.params.id);
      res.json({ success: true, message: 'Host dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── COOKIES ──────────────────────────────────────────────
  async getCookies(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getCookies();
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteCookie(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteCookie(req.params.id);
      res.json({ success: true, message: 'Cookie dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── IP BINDING ───────────────────────────────────────────
  async getIpBindings(req, res) {
    try {
      const svc = await getService(req);
      const data = await svc.getIpBindings();
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async createIpBinding(req, res) {
    try {
      const svc = await getService(req);
      const b = req.body || {};
      // Terima nama field dari UI (mac_address) maupun camelCase (macAddress).
      const data = await svc.createIpBinding({
        macAddress: b.macAddress || b.mac_address || '',
        address:    b.address    || '',
        toAddress:  b.toAddress  || b.to_address || '',
        server:     b.server     || 'all',
        type:       b.type       || 'regular',
        comment:    b.comment    || '',
      });
      res.json({ success: true, data, message: 'IP Binding berhasil dibuat' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async deleteIpBinding(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteIpBinding(req.params.id);
      res.json({ success: true, message: 'IP Binding dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // Edit binding inline (type/server/comment/address/mac/to-address)
  async updateIpBinding(req, res) {
    try {
      const svc = await getService(req);
      const b = req.body || {};
      await svc.updateIpBinding(req.params.id, {
        type:       b.type,
        server:     b.server,
        comment:    b.comment,
        macAddress: b.macAddress ?? b.mac_address,
        address:    b.address,
        toAddress:  b.toAddress ?? b.to_address,
      });
      res.json({ success: true, message: 'IP Binding berhasil diupdate' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // (2) Riwayat aksi isolir per pelanggan (dari tabel isolir_logs)
  async isolirHistory(req, res) {
    try {
      const customerId = req.params.id || req.query.customer_id;
      if (!customerId) return res.status(400).json({ success: false, message: 'customer_id wajib' });
      const { sequelize } = require('../models');
      const rows = await sequelize.query(
        `SELECT l.id, l.action, l.isolir_method, l.trigger_by, l.success, l.error_msg,
                l.static_ip, l.pppoe_username, l.created_at,
                u.name AS user_name
           FROM isolir_logs l
           LEFT JOIN users u ON u.id = l.triggered_by_user
          WHERE l.customer_id = ?
          ORDER BY l.created_at DESC
          LIMIT 50`,
        { replacements: [customerId], type: sequelize.QueryTypes.SELECT }
      ).catch(() => []);
      res.json({ success: true, data: rows || [] });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  async dedupeIpBindings(req, res) {
    try {
      const svc = await getService(req);
      const result = await svc.dedupeIpBindings();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── SERVER CRUD + SETUP ──────────────────────────────────
  async createServer(req, res) {
    try {
      const svc = await getService(req);
      await svc.createServer(req.body);
      res.json({ success: true, message: 'Hotspot server dibuat' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async updateServer(req, res) {
    try {
      const svc = await getService(req);
      await svc.updateServer(req.params.id, req.body);
      res.json({ success: true, message: 'Hotspot server diperbarui' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async deleteServer(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteServer(req.params.id);
      res.json({ success: true, message: 'Hotspot server dihapus' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async toggleServer(req, res) {
    try {
      const svc = await getService(req);
      const disable = !!req.body.disabled;
      await (disable ? svc.disableServer(req.params.id) : svc.enableServer(req.params.id));
      res.json({ success: true, message: disable ? 'Server dinonaktifkan' : 'Server diaktifkan' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async setupServer(req, res) {
    try {
      const svc = await getService(req);
      const result = await svc.setupServer(req.body);
      res.json({ success: true, message: result.message, steps: result.steps });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  // Daftar interface (untuk dropdown setup server)
  async getInterfaces(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const ifaces = await mt.getInterfaces();
      res.json({ success: true, data: ifaces.map(i => ({ name: i.name, type: i.type, running: i.running })) });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  // Interface yang DIPAKAI server hotspot (fisik/vlan) — untuk monitor traffic.
  // Hanya interface yang ada di /ip/hotspot (punya service hotspot aktif).
  async hotspotInterfaces(req, res) {
    try {
      const svc = await getService(req);
      const mt  = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const [servers, ifaces] = await Promise.all([svc.getServers(), mt.getInterfaces()]);

      const ifMap = {};
      for (const i of ifaces) ifMap[i.name] = i;

      const seen = new Set();
      const data = [];
      for (const s of servers) {
        const name = s.interface;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const det = ifMap[name] || {};
        data.push({
          name,
          type: det.type || 'unknown',
          running: det.running !== false,
          servers: servers.filter(x => x.interface === name).map(x => x.name),
        });
      }
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  // Status koneksi router (untuk badge di router bar). Tidak melempar 500.
  async connStatus(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const r = await mt.testConnection();
      if (r.success) res.json({ success: true, connected: true, identity: r.identity });
      else res.json({ success: true, connected: false, error: r.error || 'Tidak terjangkau' });
    } catch (err) {
      res.json({ success: true, connected: false, error: err.message });
    }
  },

  // Ping satu IP lewat router (test koneksi pelanggan dari panel binding).
  async pingHost(req, res) {
    try {
      const ip = req.body?.ip || req.query?.ip;
      if (!ip) return res.status(400).json({ success: false, message: 'IP wajib' });
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const raw = await mt.ping(ip, { count: 4, interval: '0.2', timeout: 15000 });
      const rows = Array.isArray(raw) ? raw : (raw ? [raw] : []);

      let received = 0, sent = 0; const times = [];
      for (const p of rows) {
        sent++;
        const t = p.time || p['time'] || '';
        const status = (p.status || '').toLowerCase();
        if (t && !status) { received++; const ms = parseFloat(String(t).replace(/[^\d.]/g, '')); if (!isNaN(ms)) times.push(ms); }
      }
      const last = rows[rows.length - 1] || {};
      if (last.sent != null)     sent = parseInt(last.sent) || sent;
      if (last.received != null) received = parseInt(last.received) || received;
      const avg = times.length ? (times.reduce((a, b) => a + b, 0) / times.length) : null;
      const loss = sent ? Math.round(((sent - received) / sent) * 100) : 100;
      const alive = received > 0;

      res.json({
        success: true, alive, ip, sent, received, loss,
        avgMs: avg != null ? Math.round(avg * 100) / 100 : null,
        message: alive
          ? `Reply dari ${ip} — ${received}/${sent} paket, avg ${avg != null ? avg.toFixed(1) + ' ms' : '–'}${loss ? `, loss ${loss}%` : ''}`
          : `Tidak ada balasan dari ${ip} (host down / tidak terjangkau)`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // (6) Riwayat traffic interface hotspot (avg & peak per jam/hari)
  async trafficHistory(req, res) {
    try {
      const TrafficHistory = require('../services/TrafficHistoryService');
      const data = await TrafficHistory.history({
        deviceId: resolveDeviceId(req) || null,
        iface: req.query.interface || null,
        range: req.query.range || '24h',
      });
      res.json({ success: true, ...data });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async trafficHistoryInterfaces(req, res) {
    try {
      const TrafficHistory = require('../services/TrafficHistoryService');
      const data = await TrafficHistory.interfaces(resolveDeviceId(req) || null);
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  // ─── WALLED GARDEN ────────────────────────────────────────
  async getWalledGarden(req, res) {
    try {
      const svc = await getService(req);
      const [host, ip] = await Promise.all([svc.getWalledGarden(), svc.getWalledGardenIp()]);
      res.json({ success: true, data: { host, ip } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async createWalledGarden(req, res) {
    try {
      const svc = await getService(req);
      await svc.createWalledGarden(req.body);
      res.json({ success: true, message: 'Walled garden entry dibuat' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async deleteWalledGarden(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteWalledGarden(req.params.id);
      res.json({ success: true, message: 'Entry dihapus' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async updateWalledGarden(req, res) {
    try {
      const svc = await getService(req);
      await svc.updateWalledGarden(req.params.id, req.body);
      res.json({ success: true, message: 'Walled garden entry diperbarui' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async createWalledGardenIp(req, res) {
    try {
      const svc = await getService(req);
      await svc.createWalledGardenIp(req.body);
      res.json({ success: true, message: 'Walled garden IP entry dibuat' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async deleteWalledGardenIp(req, res) {
    try {
      const svc = await getService(req);
      await svc.deleteWalledGardenIp(req.params.id);
      res.json({ success: true, message: 'Entry dihapus' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  async updateWalledGardenIp(req, res) {
    try {
      const svc = await getService(req);
      await svc.updateWalledGardenIp(req.params.id, req.body);
      res.json({ success: true, message: 'Walled garden IP entry diperbarui' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  },

  // ─── PRICING (profile → harga + limit) ────────────────────
  // Key file: `${deviceId || 'default'}` → { profileName: { price, limitUptime }, ... }
  // Backward compat: file lama berisi number langsung, di-normalize otomatis.

  // GET /api/mikrotik/hotspot/pricing
  // Returns selalu format baru { profileName: { price, limitUptime } }
  getPricing(req, res) {
    try {
      const deviceKey = String(resolveDeviceId(req) || 'default');
      const all = loadPricing();
      const data = normalizePricingMap(all[deviceKey] || {});
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // POST /api/mikrotik/hotspot/pricing  body: { pricing: { profileName: { price, limitUptime } | number, ... } }
  // Replace seluruh map pricing untuk device aktif. Accept format lama (number)
  // atau format baru (object) demi backward compat.
  savePricing(req, res) {
    try {
      const deviceKey = String(resolveDeviceId(req) || 'default');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const incoming = body.pricing && typeof body.pricing === 'object' ? body.pricing : {};
      const clean = {};
      for (const k of Object.keys(incoming)) {
        const entry = normalizePricingEntry(incoming[k]);
        // Simpan kalau ada price > 0 atau limitUptime terisi (entry punya makna)
        if (entry.price > 0 || entry.limitUptime) {
          clean[String(k)] = entry;
        }
      }
      const all = loadPricing();
      all[deviceKey] = clean;
      if (!savePricing(all)) {
        return res.status(500).json({ success: false, message: 'Gagal menyimpan pricing ke disk' });
      }
      res.json({ success: true, data: clean, message: 'Pricing tersimpan' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── SALES REPORT ─────────────────────────────────────────
  // GET /api/mikrotik/hotspot/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD
  //
  // Asumsi:
  //   - Tanggal "terjual" = tanggal `Generated DD/MM/YYYY` di comment voucher,
  //     dengan syarat user TERSEBUT sudah dipakai (uptime > 0 atau bytes > 0).
  //   - Harga ditentukan oleh mapping profile→harga (pricing config).
  //
  // Return:
  //   summary: { totalRevenue, totalSold, totalUnused, totalUsers, arpu, profilesCount }
  //   daily:   [{ date, sold, revenue }]                — chart per hari (rentang from..to)
  //   byProfile: [{ profile, price, sold, unused, total, revenue }]
  async salesReport(req, res) {
    try {
      const svc = await getService(req);
      const users = await svc.getUsers();
      const deviceKey = String(resolveDeviceId(req) || 'default');
      const pricing = normalizePricingMap(loadPricing()[deviceKey] || {});

      // Parse rentang tanggal (inklusif). Default = 30 hari terakhir.
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let to = req.query.to ? new Date(req.query.to) : today;
      let from = req.query.from ? new Date(req.query.from) : new Date(today.getTime() - 29 * 86400000);
      if (isNaN(from.getTime())) from = new Date(today.getTime() - 29 * 86400000);
      if (isNaN(to.getTime()))   to   = today;
      // Normalize ke awal hari supaya perbandingan konsisten
      from = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      to   = new Date(to.getFullYear(),   to.getMonth(),   to.getDate());

      const inRange = (dt) => dt && dt >= from && dt <= to;

      // Agregasi
      const dailyMap   = {};   // 'YYYY-MM-DD' → { sold, revenue }
      const profileMap = {};   // profileName → { price, sold, unused, total, revenue }
      let totalRevenue = 0, totalSold = 0, totalUnused = 0;

      for (const u of users) {
        const profile = u.profile || 'default';
        const entry = pricing[profile] || { price: 0, limitUptime: '' };
        const price = Number(entry.price || 0);
        const used  = isUserUsed(u);
        const dt    = parseGeneratedDate(u.comment);

        if (!profileMap[profile]) {
          profileMap[profile] = { profile, price, limitUptime: entry.limitUptime || '', sold: 0, unused: 0, total: 0, revenue: 0 };
        }
        // Pastikan harga selalu fresh dari pricing (mungkin baru di-update)
        profileMap[profile].price = price;
        profileMap[profile].limitUptime = entry.limitUptime || '';
        profileMap[profile].total += 1;

        if (used) {
          profileMap[profile].sold += 1;
          profileMap[profile].revenue += price;
          totalSold += 1;
          totalRevenue += price;

          // Daily hanya kalau punya tanggal valid dan dalam rentang
          if (dt && inRange(dt)) {
            const key = dt.toISOString().slice(0, 10);
            if (!dailyMap[key]) dailyMap[key] = { date: key, sold: 0, revenue: 0 };
            dailyMap[key].sold += 1;
            dailyMap[key].revenue += price;
          }
        } else {
          profileMap[profile].unused += 1;
          totalUnused += 1;
        }
      }

      // Buat array daily lengkap (isi tanggal kosong dengan 0) supaya chart kontinyu
      const daily = [];
      for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
        const d = new Date(t);
        const key = d.toISOString().slice(0, 10);
        daily.push(dailyMap[key] || { date: key, sold: 0, revenue: 0 });
      }

      const byProfile = Object.values(profileMap).sort((a, b) => b.revenue - a.revenue);
      const totalUsers = users.length;
      const arpu = totalSold > 0 ? Math.round(totalRevenue / totalSold) : 0;

      res.json({
        success: true,
        data: {
          range: { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) },
          summary: {
            totalRevenue, totalSold, totalUnused, totalUsers, arpu,
            profilesCount: byProfile.length,
            profilesWithoutPrice: byProfile.filter(p => !p.price).length,
          },
          daily,
          byProfile,
        }
      });
    } catch (err) {
      logger.error('salesReport error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── CLEANUP VOUCHER KADALUARSA ───────────────────────────
  // Identifikasi voucher yang sudah "selesai pakai" + lama dibuat,
  // lalu hapus (atau preview saja) untuk menjaga MikroTik tidak overflow.
  //
  // GET  /api/mikrotik/hotspot/cleanup-preview?olderDays=30&unusedDays=7
  //   → Return list user yang BAKAL dihapus (dry-run, tidak menyentuh data)
  //
  // POST /api/mikrotik/hotspot/cleanup-expired
  //   body: { olderDays=30, unusedDays=7, mode='used-up'|'unused'|'both' }
  //   → Hapus voucher sesuai kriteria, return summary
  //
  // Kriteria:
  //   used-up: voucher punya limit-uptime, dan uptime ≥ limit-uptime (atau >95%)
  //            DAN generated > olderDays hari lalu
  //   unused : voucher tidak pernah dipakai (uptime 0, bytes 0)
  //            DAN generated > unusedDays hari lalu
  //   both   : gabungan keduanya
  //
  // Default mode = 'used-up' (paling aman — yang unused mungkin masih akan dijual)

  // Helper: konversi MikroTik time string (e.g. "7d", "1h30m", "1w2d3h4m5s") → seconds.
  // Returns null kalau tidak bisa parse.
  _parseMtTime(s) {
    if (!s || typeof s !== 'string') return null;
    const str = s.trim().toLowerCase();
    if (str === '0' || str === '0s' || str === '') return 0;
    // Pattern: angka diikuti unit (w/d/h/m/s). Bisa multiple.
    const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
    const re = /(\d+)([wdhms])/g;
    let total = 0;
    let matched = false;
    let m;
    while ((m = re.exec(str)) !== null) {
      matched = true;
      total += parseInt(m[1]) * (units[m[2]] || 0);
    }
    return matched ? total : null;
  },

  async cleanupPreview(req, res) {
    return this._cleanupCore(req, res, true);
  },

  async cleanupExpired(req, res) {
    return this._cleanupCore(req, res, false);
  },

  async _cleanupCore(req, res, dryRun) {
    try {
      const svc = await getService(req);
      const users = await svc.getUsers();

      const olderDays  = Math.max(1, parseInt(req.query.olderDays  || req.body?.olderDays  || 30));
      const unusedDays = Math.max(1, parseInt(req.query.unusedDays || req.body?.unusedDays ||  7));
      const mode = (req.body?.mode || req.query.mode || 'used-up').toLowerCase();

      const now = Date.now();
      const olderCutoff  = now - olderDays  * 86400000;
      const unusedCutoff = now - unusedDays * 86400000;

      // Klasifikasi setiap user
      const candidates = [];  // { id, name, profile, reason, generatedAt, uptime, limitUptime, percentUsed }
      for (const u of users) {
        const dt = parseGeneratedDate(u.comment);
        if (!dt) continue;  // Tanpa tanggal generate, kita tidak tahu umurnya — skip aman
        const ageMs = now - dt.getTime();

        const uptimeSec = HotspotController._parseMtTime(u.uptime);
        const limitSec  = HotspotController._parseMtTime(u.limitUptime);
        const used = isUserUsed(u);

        // used-up: punya limit + uptime ≥ 95% limit + umur ≥ olderDays
        if ((mode === 'used-up' || mode === 'both')
            && limitSec && limitSec > 0
            && uptimeSec != null
            && uptimeSec >= limitSec * 0.95
            && dt.getTime() < olderCutoff) {
          candidates.push({
            id: u.id, name: u.name, profile: u.profile,
            reason: 'used-up',
            generatedAt: dt.toISOString().slice(0,10),
            ageDays: Math.floor(ageMs / 86400000),
            uptime: u.uptime, limitUptime: u.limitUptime,
            percentUsed: Math.round((uptimeSec / limitSec) * 100),
          });
          continue;
        }

        // unused: tidak pernah dipakai + umur ≥ unusedDays
        if ((mode === 'unused' || mode === 'both')
            && !used
            && dt.getTime() < unusedCutoff) {
          candidates.push({
            id: u.id, name: u.name, profile: u.profile,
            reason: 'unused',
            generatedAt: dt.toISOString().slice(0,10),
            ageDays: Math.floor(ageMs / 86400000),
            uptime: u.uptime || '0s', limitUptime: u.limitUptime || '',
            percentUsed: 0,
          });
        }
      }

      // Group by reason untuk ringkasan
      const summary = {
        totalCandidates: candidates.length,
        usedUp: candidates.filter(c => c.reason === 'used-up').length,
        unused: candidates.filter(c => c.reason === 'unused').length,
        totalUsers: users.length,
        mode, olderDays, unusedDays,
      };

      if (dryRun) {
        return res.json({ success: true, dryRun: true, summary, candidates });
      }

      // Eksekusi delete — paralel chunked (mirror generateVouchers pattern)
      if (!candidates.length) {
        return res.json({ success: true, summary, deleted: 0, errors: [], message: 'Tidak ada voucher untuk dibersihkan' });
      }

      const errors = [];
      let deleted = 0;
      const CHUNK = 8;
      for (let i = 0; i < candidates.length; i += CHUNK) {
        const chunk = candidates.slice(i, i + CHUNK);
        const results = await Promise.allSettled(chunk.map(c => svc.deleteUser(c.id)));
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') deleted++;
          else errors.push({ name: chunk[idx].name, error: r.reason?.message || 'Unknown' });
        });
      }

      logger.info(`[Hotspot] Cleanup done: deleted=${deleted}/${candidates.length}, mode=${mode}, errors=${errors.length}`);
      res.json({ success: true, summary, deleted, errors, message: `${deleted} voucher dibersihkan` });
    } catch (err) {
      logger.error('cleanup error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ─── USAGE HISTORY (user yang sudah pernah digunakan) ─────
  // GET /api/mikrotik/hotspot/usage-history?from=&to=&profile=&search=
  //
  // Filter user dimana isUserUsed(u) === true. Tanggal yang dipakai sebagai
  // anchor adalah tanggal "Generated" di comment (best-effort, MikroTik tidak
  // simpan "first-login" untuk hotspot user).
  async usageHistory(req, res) {
    try {
      const svc = await getService(req);
      const users = await svc.getUsers();
      const deviceKey = String(resolveDeviceId(req) || 'default');
      const pricing = normalizePricingMap(loadPricing()[deviceKey] || {});

      const fromQ = req.query.from ? new Date(req.query.from) : null;
      const toQ   = req.query.to   ? new Date(req.query.to)   : null;
      const profileFilter = (req.query.profile || '').trim();
      const search = (req.query.search || '').trim().toLowerCase();

      const fromDt = (fromQ && !isNaN(fromQ.getTime()))
        ? new Date(fromQ.getFullYear(), fromQ.getMonth(), fromQ.getDate())
        : null;
      const toDt = (toQ && !isNaN(toQ.getTime()))
        ? new Date(toQ.getFullYear(), toQ.getMonth(), toQ.getDate())
        : null;

      const rows = users
        .filter(u => isUserUsed(u))
        .map(u => {
          const profile = u.profile || 'default';
          const parsed = parseVoucherComment(u.comment);
          const dt = parsed.generatedAt;
          const entry = pricing[profile] || { price: 0, limitUptime: '' };
          // Prefer harga dari pricing config; fallback ke harga di comment
          const finalPrice = Number(entry.price || 0) || parsed.priceFromComment || 0;
          return {
            id:        u.id,
            name:      u.name,
            profile,
            server:    u.server,
            uptime:    u.uptime,
            bytesIn:   u.bytesIn  || 0,
            bytesOut:  u.bytesOut || 0,
            bytesTotal: (u.bytesIn || 0) + (u.bytesOut || 0),
            comment:   u.comment || '',
            generatedAt: dt ? dt.toISOString().slice(0, 10) : null,
            soldTo:    parsed.soldTo || '',
            price:     finalPrice,
            disabled:  !!u.disabled,
            macAddress: u.macAddress || '',
            address:   u.address || '',
          };
        })
        .filter(r => {
          if (profileFilter && r.profile !== profileFilter) return false;
          if (fromDt || toDt) {
            // Kalau filter tanggal aktif tapi user tidak punya tanggal generate,
            // exclude (tidak bisa diperhitungkan dalam rentang)
            if (!r.generatedAt) return false;
            const dt = new Date(r.generatedAt);
            if (fromDt && dt < fromDt) return false;
            if (toDt   && dt > toDt)   return false;
          }
          if (search) {
            const hay = (r.name + ' ' + r.profile + ' ' + r.comment + ' ' + r.macAddress).toLowerCase();
            if (!hay.includes(search)) return false;
          }
          return true;
        })
        // Sort: terbaru dulu (by generatedAt), lalu by name
        .sort((a, b) => {
          if (a.generatedAt && b.generatedAt) return b.generatedAt.localeCompare(a.generatedAt);
          if (a.generatedAt) return -1;
          if (b.generatedAt) return 1;
          return a.name.localeCompare(b.name);
        });

      res.json({ success: true, data: rows, total: rows.length });
    } catch (err) {
      logger.error('usageHistory error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
};

module.exports = HotspotController;
