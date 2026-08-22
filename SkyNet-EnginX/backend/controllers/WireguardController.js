const WireGuardService = require('../services/WireGuardService');

class WireguardController {
  // ── SERVERS (interfaces) ────────────────────────────────────────────
  // GET /api/wireguard/servers
  async serversIndex(req, res) {
    try {
      const { WireguardServer, WireguardPeer } = require('../models');
      const rows = await WireguardServer.findAll({ order: [['created_at', 'ASC']] });
      const data = await Promise.all(rows.map(async (s) => {
        const peerCount = await WireguardPeer.count({ where: { server_id: s.id } });
        return {
          ...s.toJSON(), private_key: undefined,
          peerCount,
          interfaceUp: WireGuardService.interfaceExists(s.interface_name),
        };
      }));
      res.json({ success: true, data, wgAvailable: WireGuardService.binaryAvailable() });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/wireguard/servers
  async serversCreate(req, res) {
    try {
      const { interface_name, address_cidr, listen_port, endpoint_host, dns, mtu, notes } = req.body || {};
      if (!interface_name || !address_cidr) {
        return res.status(400).json({ success: false, message: 'interface_name dan address_cidr wajib diisi' });
      }
      if (!/^[a-zA-Z0-9_-]{1,15}$/.test(interface_name)) {
        return res.status(400).json({ success: false, message: 'Nama interface tidak valid (huruf/angka/-/_, maks 15 karakter)' });
      }
      const { WireguardServer } = require('../models');
      const { privateKey, publicKey } = WireGuardService.generateKeypair();
      const row = await WireguardServer.create({
        interface_name,
        private_key: WireGuardService.encrypt(privateKey),
        public_key: publicKey,
        listen_port: listen_port ? parseInt(listen_port, 10) : 51820,
        address_cidr,
        endpoint_host: endpoint_host || null,
        dns: dns || '1.1.1.1',
        mtu: mtu ? parseInt(mtu, 10) : null,
        notes: notes || null,
        created_by: req.user?.id || null,
      });
      const applyResult = await WireGuardService.applyLive(row);
      res.json({
        success: true,
        message: 'Interface WireGuard dibuat' + (applyResult.applied ? ' dan aktif' : ' (belum aktif live — ' + applyResult.error + ')'),
        data: { ...row.toJSON(), private_key: undefined },
        apply: applyResult,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Nama interface sudah dipakai' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/wireguard/servers/:id
  async serversUpdate(req, res) {
    try {
      const { WireguardServer } = require('../models');
      const row = await WireguardServer.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Interface tidak ditemukan' });

      const { endpoint_host, dns, mtu, listen_port, is_active, notes } = req.body || {};
      const patch = {};
      if (endpoint_host !== undefined) patch.endpoint_host = endpoint_host || null;
      if (dns !== undefined) patch.dns = dns || null;
      if (mtu !== undefined) patch.mtu = mtu ? parseInt(mtu, 10) : null;
      if (listen_port !== undefined) patch.listen_port = parseInt(listen_port, 10) || row.listen_port;
      if (is_active !== undefined) patch.is_active = !!is_active;
      if (notes !== undefined) patch.notes = notes || null;
      await row.update(patch);

      const applyResult = await WireGuardService.applyLive(row);
      res.json({ success: true, message: 'Interface diperbarui', data: { ...row.toJSON(), private_key: undefined }, apply: applyResult });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/wireguard/servers/:id
  async serversDestroy(req, res) {
    try {
      const { WireguardServer, WireguardPeer } = require('../models');
      const row = await WireguardServer.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Interface tidak ditemukan' });
      WireGuardService.interfaceDown(row);
      await WireguardPeer.destroy({ where: { server_id: row.id } });
      await row.destroy();
      res.json({ success: true, message: 'Interface dan seluruh peer-nya dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── PEERS ────────────────────────────────────────────────────────────
  // GET /api/wireguard/peers?server_id=
  async peersIndex(req, res) {
    try {
      const { WireguardPeer, WireguardServer, Customer } = require('../models');
      const where = {};
      if (req.query.server_id) where.server_id = req.query.server_id;
      const rows = await WireguardPeer.findAll({
        where, order: [['created_at', 'DESC']],
        include: [{ model: Customer, as: 'customer', attributes: ['id', 'name', 'customer_id'], required: false }],
      });

      // Ambil statistik live per-interface (satu panggilan `wg show` per server unik).
      const serverIds = [...new Set(rows.map(r => r.server_id))];
      const servers = serverIds.length ? await WireguardServer.findAll({ where: { id: serverIds } }) : [];
      const statsByIface = new Map();
      for (const s of servers) statsByIface.set(s.id, WireGuardService.getRuntimeStats(s.interface_name));

      const data = rows.map(r => {
        const live = statsByIface.get(r.server_id)?.get(r.public_key) || null;
        return {
          ...r.toJSON(), private_key: undefined, preshared_key: undefined,
          hasConfig: !!r.private_key,
          live: live ? {
            connected: live.latestHandshake > 0 && (Date.now() / 1000 - live.latestHandshake) < 180,
            lastHandshake: live.latestHandshake ? new Date(live.latestHandshake * 1000) : null,
            rx: live.rx, tx: live.tx,
          } : null,
        };
      });
      res.json({ success: true, data, total: data.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/wireguard/peers/auto — generate keypair + alokasi IP + simpan + push live
  async peersAutoCreate(req, res) {
    try {
      const { server_id, name, customer_id, client_allowed_ips, persistent_keepalive } = req.body || {};
      if (!server_id || !name) {
        return res.status(400).json({ success: false, message: 'server_id dan name wajib diisi' });
      }
      const { WireguardServer, WireguardPeer } = require('../models');
      const server = await WireguardServer.findByPk(server_id);
      if (!server) return res.status(404).json({ success: false, message: 'Interface WireGuard tidak ditemukan. Buat interface dahulu.' });

      const { privateKey, publicKey } = WireGuardService.generateKeypair();
      const presharedKey = WireGuardService.generatePresharedKey();
      const allocatedIp  = await WireGuardService.allocateIp(server);
      const subnetCidr   = WireGuardService.networkCidr(server.address_cidr);

      const peer = await WireguardPeer.create({
        server_id: server.id,
        name,
        customer_id: customer_id || null,
        public_key: publicKey,
        private_key: WireGuardService.encrypt(privateKey),
        preshared_key: WireGuardService.encrypt(presharedKey),
        allocated_ip: allocatedIp,
        client_allowed_ips: client_allowed_ips || subnetCidr,
        persistent_keepalive: persistent_keepalive ? parseInt(persistent_keepalive, 10) : 25,
        created_by: req.user?.id || null,
      });

      const applyResult = await WireGuardService.applyLive(server);
      const config = WireGuardService.buildClientConfig(server, peer);

      res.json({
        success: true,
        message: 'Peer dibuat otomatis' + (applyResult.applied ? ' dan langsung aktif' : ' (belum aktif live — ' + applyResult.error + ')'),
        data: { ...peer.toJSON(), private_key: undefined, preshared_key: undefined },
        config,
        apply: applyResult,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Konflik data (IP/public key sudah dipakai) — coba lagi' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/wireguard/peers — tambah peer manual (public key dari client sendiri)
  async peersCreateManual(req, res) {
    try {
      const { server_id, name, customer_id, public_key, client_allowed_ips, persistent_keepalive, endpoint, allocated_ip } = req.body || {};
      if (!server_id || !name || !public_key) {
        return res.status(400).json({ success: false, message: 'server_id, name, dan public_key wajib diisi' });
      }
      const { WireguardServer, WireguardPeer } = require('../models');
      const server = await WireguardServer.findByPk(server_id);
      if (!server) return res.status(404).json({ success: false, message: 'Interface WireGuard tidak ditemukan' });

      const ip = allocated_ip ? (allocated_ip.includes('/') ? allocated_ip : allocated_ip + '/32')
                               : await WireGuardService.allocateIp(server);
      const subnetCidr = WireGuardService.networkCidr(server.address_cidr);

      const peer = await WireguardPeer.create({
        server_id: server.id, name, customer_id: customer_id || null,
        public_key, allocated_ip: ip,
        client_allowed_ips: client_allowed_ips || subnetCidr,
        endpoint: endpoint || null,
        persistent_keepalive: persistent_keepalive ? parseInt(persistent_keepalive, 10) : 25,
        created_by: req.user?.id || null,
      });
      const applyResult = await WireGuardService.applyLive(server);
      res.json({
        success: true, message: 'Peer ditambahkan',
        data: { ...peer.toJSON(), private_key: undefined, preshared_key: undefined },
        apply: applyResult,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Public key atau IP sudah dipakai peer lain' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/wireguard/peers/:id
  async peersUpdate(req, res) {
    try {
      const { WireguardPeer, WireguardServer } = require('../models');
      const peer = await WireguardPeer.findByPk(req.params.id);
      if (!peer) return res.status(404).json({ success: false, message: 'Peer tidak ditemukan' });

      const { name, is_enabled, client_allowed_ips, persistent_keepalive, endpoint, notes, customer_id } = req.body || {};
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (is_enabled !== undefined) patch.is_enabled = !!is_enabled;
      if (client_allowed_ips !== undefined) patch.client_allowed_ips = client_allowed_ips;
      if (persistent_keepalive !== undefined) patch.persistent_keepalive = parseInt(persistent_keepalive, 10) || null;
      if (endpoint !== undefined) patch.endpoint = endpoint || null;
      if (notes !== undefined) patch.notes = notes || null;
      if (customer_id !== undefined) patch.customer_id = customer_id || null;
      await peer.update(patch);

      const server = await WireguardServer.findByPk(peer.server_id);
      const applyResult = server ? await WireGuardService.applyLive(server) : { applied: false, error: 'server tidak ditemukan' };
      res.json({ success: true, message: 'Peer diperbarui', data: { ...peer.toJSON(), private_key: undefined, preshared_key: undefined }, apply: applyResult });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/wireguard/peers/:id
  async peersDestroy(req, res) {
    try {
      const { WireguardPeer, WireguardServer } = require('../models');
      const peer = await WireguardPeer.findByPk(req.params.id);
      if (!peer) return res.status(404).json({ success: false, message: 'Peer tidak ditemukan' });
      const server = await WireguardServer.findByPk(peer.server_id);
      await peer.destroy();
      const applyResult = server ? await WireGuardService.applyLive(server) : { applied: false };
      res.json({ success: true, message: 'Peer dihapus', apply: applyResult });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/wireguard/peers/:id/config — download file .conf
  async peersConfig(req, res) {
    try {
      const { WireguardPeer, WireguardServer } = require('../models');
      const peer = await WireguardPeer.findByPk(req.params.id);
      if (!peer) return res.status(404).json({ success: false, message: 'Peer tidak ditemukan' });
      const server = await WireguardServer.findByPk(peer.server_id);
      if (!server) return res.status(404).json({ success: false, message: 'Interface tidak ditemukan' });

      const config = WireGuardService.buildClientConfig(server, peer);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${peer.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.conf"`);
      res.send(config);
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  // GET /api/wireguard/peers/:id/qr — QR code (data URL) dari config
  async peersQr(req, res) {
    try {
      const { WireguardPeer, WireguardServer } = require('../models');
      const peer = await WireguardPeer.findByPk(req.params.id);
      if (!peer) return res.status(404).json({ success: false, message: 'Peer tidak ditemukan' });
      const server = await WireguardServer.findByPk(peer.server_id);
      if (!server) return res.status(404).json({ success: false, message: 'Interface tidak ditemukan' });

      const config = WireGuardService.buildClientConfig(server, peer);
      const QRCode = require('qrcode');
      const qrImage = await QRCode.toDataURL(config, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      res.json({ success: true, qrImage });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }
}

module.exports = new WireguardController();
