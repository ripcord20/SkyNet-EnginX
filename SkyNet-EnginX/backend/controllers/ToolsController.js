/**
 * ToolsController.js
 * ────────────────────────────────────────────────────────────────────
 * Backend untuk halaman Tools (/tools), 2 tab:
 *   1. Hotspot Binding — list pelanggan hotspot, isolir/restore, sync DB↔MikroTik,
 *      CRUD binding manual.
 *   2. IP Scan — meniru Tools > IP Scan di Winbox: pilih router → interface →
 *      address range → scan, lalu bisa bind hasil ke pelanggan.
 *
 * Router dipilih per-request via ?device_id / body.device_id (dropdown di UI).
 * Koneksi pakai getMikrotikInstanceByDevice() (devices/monitoring table).
 * ────────────────────────────────────────────────────────────────────
 */
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');
const HotspotService = require('../services/HotspotService');
const IsolirService  = require('../services/IsolirService');
const { sequelize }  = require('../models');

// Resolve device_id dari query/body/header (konsisten dengan endpoint MikroTik lain).
function resolveDeviceId(req) {
  return req.query.device_id || req.body?.device_id || req.headers['x-device-id'] || null;
}

// Helper: bikin HotspotService dari devices.id (dropdown)
async function getServiceFor(deviceId) {
  const mt = await getMikrotikInstanceByDevice(deviceId);
  return new HotspotService(mt);
}

class ToolsController {

  // ── Daftar router untuk dropdown ────────────────────────────
  async listRouters(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT id, name, ip_address, api_port, api_protocol, brand, model, is_active, is_primary
           FROM devices
          WHERE type='router' AND is_active=1
          ORDER BY is_primary DESC, name ASC`,
        { type: sequelize.QueryTypes.SELECT }
      ).catch(async () => {
        // Fallback kalau kolom is_primary belum ada
        return sequelize.query(
          `SELECT id, name, ip_address, api_port, api_protocol, brand, model, is_active
             FROM devices WHERE type='router' AND is_active=1 ORDER BY name ASC`,
          { type: sequelize.QueryTypes.SELECT }
        );
      });
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Daftar interface untuk router terpilih ──────────────────
  async listInterfaces(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const ifaces = await mt.getInterfaces();

      // IP Scan hanya relevan di interface fisik & VLAN. Sembunyikan
      // interface PPPoE / PPP / dynamic tunnel (pptp, l2tp, sstp, ovpn, dll)
      // karena tidak bisa di-scan ARP/L2 dengan benar.
      const isScannable = (i) => {
        const t = String(i.type || '').toLowerCase();
        const n = String(i.name || '').toLowerCase();
        // Eksplisit blokir semua varian PPP / tunnel dinamis
        const blockedTypes = [
          'pppoe-in', 'pppoe-out', 'ppp-out', 'ppp-in', 'pppoe',
          'pptp-in', 'pptp-out', 'l2tp-in', 'l2tp-out',
          'sstp-in', 'sstp-out', 'ovpn-in', 'ovpn-out',
          'gre-tunnel', 'ipip-tunnel', 'eoip', 'wg', 'wireguard'
        ];
        if (blockedTypes.includes(t)) return false;
        // Tangkap juga yang diberi prefix oleh RouterOS (mis. <pppoe-userX>)
        if (/^(<?pppoe|<?ppp-|<?pptp|<?l2tp|<?sstp|<?ovpn)/.test(n)) return false;
        if (t.includes('ppp') || t.includes('pptp') || t.includes('l2tp') ||
            t.includes('sstp') || t.includes('ovpn') || t.includes('tunnel')) return false;
        // Loloskan hanya interface fisik (ether/wlan/sfp/bridge/dll) & vlan
        return true;
      };

      // Hanya nama + status running, urut by name
      const data = ifaces
        .filter(isScannable)
        .map(i => ({ name: i.name, type: i.type, running: i.running, disabled: i.disabled }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── IP SCAN ─────────────────────────────────────────────────
  async ipScan(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const { interface: iface, address_range = '', duration = 5 } = req.body || {};
      if (!iface) return res.status(400).json({ success: false, message: 'Interface wajib dipilih' });

      const dur = Math.min(Math.max(parseInt(duration) || 5, 1), 30); // clamp 1-30s
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const results = await mt.runIpScan({ interface: iface, addressRange: address_range, duration: dur });

      // Enrich: cek MAC mana yang sudah terdaftar sebagai pelanggan
      const macs = results.map(r => (r.macAddress || '').toUpperCase()).filter(Boolean);
      let knownMap = {};
      if (macs.length) {
        const placeholders = macs.map(() => '?').join(',');
        const known = await sequelize.query(
          `SELECT id, customer_id, name, mac_address, static_ip, connection_type, isolir_status
             FROM customers
            WHERE UPPER(mac_address) IN (${placeholders})`,
          { replacements: macs, type: sequelize.QueryTypes.SELECT }
        ).catch(() => []);
        known.forEach(c => { knownMap[(c.mac_address || '').toUpperCase()] = c; });
      }

      const enriched = results.map(r => ({
        ...r,
        customer: knownMap[(r.macAddress || '').toUpperCase()] || null,
      }));

      res.json({ success: true, data: enriched, count: enriched.length });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── Bind hasil IP Scan ke pelanggan ─────────────────────────
  // Set customers.mac_address + static_ip + connection_type='hotspot' + mikrotik_id.
  async bindToCustomer(req, res) {
    try {
      const { customer_id, mac_address, address, mikrotik_id, create_binding } = req.body || {};
      if (!customer_id) return res.status(400).json({ success: false, message: 'customer_id wajib' });
      if (!mac_address && !address) return res.status(400).json({ success: false, message: 'MAC atau IP wajib' });

      const deviceId = resolveDeviceId(req);   // devices.id dari dropdown

      // Map devices.id (dropdown) → mikrotik_devices.id supaya isolir bisa
      // resolve router lewat customer.mikrotik_id. Kalau body kirim mikrotik_id
      // eksplisit, pakai itu; kalau tidak, cari dari device_id.
      let resolvedMikrotikId = mikrotik_id || null;
      if (!resolvedMikrotikId && deviceId) {
        try {
          const md = await sequelize.query(
            'SELECT id FROM mikrotik_devices WHERE device_id=? LIMIT 1',
            { replacements: [deviceId], type: sequelize.QueryTypes.SELECT }
          );
          if (md && md.length) resolvedMikrotikId = md[0].id;
        } catch (_) {}
      }

      const fields = ["connection_type='hotspot'"];
      const repl = [];
      const macUp = mac_address ? String(mac_address).toUpperCase() : null;
      if (macUp)   { fields.push('mac_address=?'); repl.push(macUp); }
      if (address) { fields.push('static_ip=?');   repl.push(address); }
      if (resolvedMikrotikId) { fields.push('mikrotik_id=?'); repl.push(resolvedMikrotikId); }
      repl.push(customer_id);

      await sequelize.query(
        `UPDATE customers SET ${fields.join(', ')} WHERE id=?`,
        { replacements: repl }
      );

      // Opsional: sekalian buat IP binding (bypassed) di router.
      let bindingMsg = '';
      if (create_binding && deviceId) {
        try {
          const svc = await getServiceFor(deviceId);
          // cek dulu apakah binding sudah ada (hindari duplikat)
          const existing = await svc.getIpBindings().catch(() => []);
          const macN = (macUp || '').toUpperCase();
          const dup = (existing || []).find(b =>
            (macN && String(b.macAddress || '').toUpperCase() === macN) ||
            (address && String(b.address || '') === address)
          );
          if (!dup) {
            await svc.createIpBinding({
              type: 'bypassed',
              macAddress: macUp || undefined,
              address: address || undefined,
              comment: 'FLAYNET-HS-BIND-' + customer_id,
            });
            bindingMsg = ' + IP binding dibuat di router';
          } else {
            bindingMsg = ' (IP binding sudah ada di router)';
          }
        } catch (be) {
          bindingMsg = ' (gagal buat binding: ' + be.message + ')';
        }
      }

      res.json({ success: true, message: 'Pelanggan berhasil di-bind ke MAC/IP hotspot' + bindingMsg });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── HOTSPOT BINDING: list pelanggan tipe hotspot ────────────
  async listHotspotCustomers(req, res) {
    try {
      const rows = await sequelize.query(
        `SELECT c.id, c.customer_id, c.name, c.static_ip, c.mac_address,
                c.connection_type, c.isolir_status, c.isolir_at, c.mikrotik_id,
                c.phone, pkg.name AS package_name,
                d.name AS router_name,
                (SELECT MAX(due_date) FROM invoices WHERE customer_id=c.id) AS last_due,
                (SELECT status FROM invoices WHERE customer_id=c.id ORDER BY due_date DESC LIMIT 1) AS last_inv_status
           FROM customers c
           LEFT JOIN packages pkg        ON pkg.id = c.package_id
           LEFT JOIN mikrotik_devices md ON md.id = c.mikrotik_id
           LEFT JOIN devices d           ON d.id = md.device_id
          WHERE c.connection_type='hotspot'
             AND ( (c.mac_address IS NOT NULL AND c.mac_address!='')
                OR (c.static_ip   IS NOT NULL AND c.static_ip!='') )
          ORDER BY c.name ASC`,
        { type: sequelize.QueryTypes.SELECT }
      );
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── HOTSPOT BINDING: list raw IP binding dari MikroTik ──────
  async listBindings(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const hs = new HotspotService(mt);
      const bindings = await hs.getIpBindings();
      res.json({ success: true, data: bindings });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── HOTSPOT BINDING: sync status DB ↔ MikroTik ──────────────
  // Bandingkan isolir_status pelanggan (DB) dengan disabled binding (MikroTik).
  async syncBindingStatus(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const hs = new HotspotService(mt);
      const bindings = await hs.getIpBindings();

      // Map by MAC (uppercase) dan address
      const byMac  = {};
      const byAddr = {};
      bindings.forEach(b => {
        if (b.macAddress) byMac[b.macAddress.toUpperCase()] = b;
        if (b.address)    byAddr[b.address] = b;
      });

      const customers = await sequelize.query(
        `SELECT id, customer_id, name, mac_address, static_ip, isolir_status
           FROM customers
          WHERE connection_type='hotspot' AND (mac_address IS NOT NULL AND mac_address!='')`,
        { type: sequelize.QueryTypes.SELECT }
      );

      const report = customers.map(c => {
        const mac = (c.mac_address || '').toUpperCase();
        const b = byMac[mac] || byAddr[c.static_ip] || null;
        const dbIsolated = c.isolir_status === 'isolated';
        let mtState, mismatch = false, note;
        if (!b) {
          mtState = 'no-binding';
          // Kalau DB bilang isolated tapi tidak ada binding → mismatch (binding hilang)
          mismatch = dbIsolated;
          note = dbIsolated ? 'DB=isolir tapi binding tidak ada di router' : 'Binding tidak ditemukan di router';
        } else {
          // Isolir di router = binding (bypassed) yang DISABLED.
          // Akses normal = binding enabled.
          mtState = b.disabled ? 'disabled' : 'enabled';
          mismatch = (dbIsolated && !b.disabled) || (!dbIsolated && b.disabled);
          note = mismatch
            ? (dbIsolated ? 'DB=isolir tapi binding masih aktif' : 'DB=aktif tapi binding ter-disable')
            : 'Sinkron';
        }
        return {
          id: c.id, customer_id: c.customer_id, name: c.name,
          mac_address: c.mac_address, static_ip: c.static_ip,
          db_status: c.isolir_status, mt_state: mtState,
          mismatch, note,
          binding_id: b ? b.id : null,
        };
      });

      const mismatchCount = report.filter(r => r.mismatch).length;
      res.json({ success: true, data: report, mismatch_count: mismatchCount, total: report.length });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── HOTSPOT BINDING: isolir / restore pelanggan ─────────────
  async isolir(req, res) {
    try {
      const r = await IsolirService.isolirCustomer(req.params.id, 'tools', req.user?.id || null);
      res.json({ success: r.success, message: r.message });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async restore(req, res) {
    try {
      const r = await IsolirService.restoreCustomer(req.params.id, 'tools', req.user?.id || null);
      res.json({ success: r.success, message: r.message });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // ── HOTSPOT BINDING: CRUD binding manual di MikroTik ────────
  async createBinding(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const hs = new HotspotService(mt);
      const { mac_address, address, to_address, type, server, comment } = req.body || {};
      if (!mac_address && !address) return res.status(400).json({ success: false, message: 'MAC atau Address wajib' });
      await hs.createIpBinding({
        macAddress: mac_address ? String(mac_address).toUpperCase() : '',
        address, toAddress: to_address, type: type || 'bypassed',
        server: server || 'all', comment: comment || '',
      });
      res.json({ success: true, message: 'IP Binding dibuat' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  async deleteBinding(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const mt = await getMikrotikInstanceByDevice(deviceId);
      const hs = new HotspotService(mt);
      await hs.deleteIpBinding(req.params.bindingId);
      res.json({ success: true, message: 'IP Binding dihapus' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // Toggle disable/enable binding manual (by .id)
  async toggleBinding(req, res) {
    try {
      const deviceId = resolveDeviceId(req);
      const { disabled } = req.body || {};
      const mt = await getMikrotikInstanceByDevice(deviceId);
      // HotspotService tidak punya method khusus → pakai mt.patch langsung
      await mt.patch(`/ip/hotspot/ip-binding/${req.params.bindingId}`, {
        disabled: disabled ? 'true' : 'false',
      });
      res.json({ success: true, message: disabled ? 'Binding dinonaktifkan' : 'Binding diaktifkan' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new ToolsController();
