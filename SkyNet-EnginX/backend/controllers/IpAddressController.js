/**
 * IpAddressController.js
 * ────────────────────────────────────────────────────────────────────
 * Backend untuk halaman IP Addressing (/ip-addressing).
 * Mengelola /ip/address di MikroTik: list, tambah, edit, hapus, enable/disable.
 *
 * Router dipilih per-request via ?device_id / body.device_id (dropdown di UI),
 * konsisten dengan ToolsController. Koneksi pakai getMikrotikInstanceByDevice().
 * ────────────────────────────────────────────────────────────────────
 */
const { getMikrotikInstanceByDevice } = require('../services/MikrotikService');

function resolveDeviceId(req) {
  return req.query.device_id || req.body?.device_id || req.headers['x-device-id'] || null;
}

class IpAddressController {

  // ── Daftar IP address + interface (untuk dropdown) ──────────
  async list(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      const [addresses, ifacesRaw] = await Promise.all([
        mt.getIPAddresses(),
        mt.getInterfaces(),
      ]);
      // Interface untuk dropdown: tampilkan yang fisik/vlan/bridge, sembunyikan
      // dynamic PPP/tunnel (alamat biasanya tidak di-set manual di sana).
      const ifaces = (ifacesRaw || [])
        .filter(i => {
          const t = String(i.type || '').toLowerCase();
          return !(t.includes('ppp') || t.includes('pptp') || t.includes('l2tp') ||
                   t.includes('sstp') || t.includes('ovpn') || t.includes('tunnel'));
        })
        .map(i => ({ name: i.name, type: i.type, running: i.running, disabled: i.disabled }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ success: true, data: addresses, interfaces: ifaces });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async create(req, res) {
    try {
      const { address, interface: iface } = req.body || {};
      if (!address || !iface) {
        return res.status(400).json({ success: false, message: 'Address & interface wajib diisi' });
      }
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      await mt.addIPAddress(req.body);
      res.json({ success: true, message: `IP ${address} ditambahkan ke ${iface}` });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async update(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      await mt.updateIPAddress(req.params.id, req.body);
      res.json({ success: true, message: 'IP address diperbarui' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async remove(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      await mt.deleteIPAddress(req.params.id);
      res.json({ success: true, message: 'IP address dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async toggle(req, res) {
    try {
      const mt = await getMikrotikInstanceByDevice(resolveDeviceId(req));
      await mt.toggleIPAddress(req.params.id, !!req.body.disabled);
      res.json({ success: true, message: req.body.disabled ? 'IP dinonaktifkan' : 'IP diaktifkan' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new IpAddressController();
