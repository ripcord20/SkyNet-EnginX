const { Op } = require('sequelize');
const crypto = require('crypto');
const ConfigCrypto = require('../utils/ConfigCrypto');
const RadiusServer = require('../services/RadiusServer');
const WireGuardService = require('../services/WireGuardService');
const VpnNasService = require('../services/VpnNasService');

function encrypt(plaintext) { return ConfigCrypto._encryptString(String(plaintext || '')); }
function decrypt(value) {
  try { return ConfigCrypto._decryptString(value) || ''; }
  catch (e) { return ''; }
}
function genSecret() { return crypto.randomBytes(24).toString('base64'); }

// Serialize satu NAS client + info koneksi (device, wireguard peer / VPN PPP + status live)
// untuk ditampilkan di kartu NAS pada frontend.
function serializeNas(row, wgStatsByServer, vpnOpts = {}) {
  const j = row.toJSON();
  const peer = j.wireguard_peer;
  let live = null;
  if (j.connection_mode === 'vpn') {
    const st = VpnNasService.isConnected(j, {
      now: vpnOpts.now,
      accelSessions: vpnOpts.accelSessions || '',
      allowPing: vpnOpts.allowPing === true,
    });
    live = { connected: st.connected, reason: st.reason, lastSeenAt: st.lastSeenAt };
  } else if (peer && wgStatsByServer) {
    const stats = wgStatsByServer.get(peer.server_id)?.get(peer.public_key);
    if (stats) {
      live = {
        connected: stats.latestHandshake > 0 && (Date.now() / 1000 - stats.latestHandshake) < 180,
        lastHandshake: stats.latestHandshake ? new Date(stats.latestHandshake * 1000) : null,
      };
    }
  }
  return {
    ...j,
    secret: undefined,
    vpn_password: undefined,
    vpn_username: j.vpn_username || undefined,
    vpn_local_ip: j.vpn_local_ip || undefined,
    vpn_remote_ip: j.vpn_remote_ip || undefined,
    vpn_protocols: j.vpn_protocols || undefined,
    wireguard_peer: peer ? { id: peer.id, name: peer.name, allocated_ip: peer.allocated_ip } : undefined,
    live,
  };
}

class RadiusController {
  // ── SERVER LIFECYCLE ────────────────────────────────────────────────
  // GET /api/radius/server/status
  async serverStatus(req, res) {
    try {
      const { AppSetting } = require('../models');
      const setting = await AppSetting.findOne({ where: { key: 'radius_enabled' } });
      res.json({ success: true, data: { ...RadiusServer.status(), enabled: setting?.value === '1' } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/server/start
  async serverStart(req, res) {
    try {
      const result = await RadiusServer.start(req.body || {});
      const { AppSetting } = require('../models');
      await AppSetting.upsert({ key: 'radius_enabled', value: '1', type: 'boolean' });
      res.json({ success: true, message: 'RADIUS server berjalan', data: result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/server/stop
  async serverStop(req, res) {
    try {
      RadiusServer.stop();
      const { AppSetting } = require('../models');
      await AppSetting.upsert({ key: 'radius_enabled', value: '0', type: 'boolean' });
      res.json({ success: true, message: 'RADIUS server dihentikan' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── DASHBOARD STATS ──────────────────────────────────────────────────
  // GET /api/radius/stats
  async stats(req, res) {
    try {
      const { RadiusNasClient, RadiusUser, RadiusAccounting } = require('../models');
      const [nasCount, userCount, activeSessions] = await Promise.all([
        RadiusNasClient.count({ where: { is_active: true } }),
        RadiusUser.count({ where: { is_active: true } }),
        RadiusAccounting.count({ where: { stopped_at: null } }),
      ]);
      res.json({
        success: true,
        data: { nasCount, userCount, activeSessions, server: RadiusServer.status() }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── NAS CLIENTS ──────────────────────────────────────────────────────
  // GET /api/radius/nas — dikelompokkan per site_name di sisi frontend;
  // di sini cukup kembalikan flat list lengkap dengan relasi.
  async nasIndex(req, res) {
    try {
      const { RadiusNasClient, Device, WireguardPeer, WireguardServer } = require('../models');
      const rows = await RadiusNasClient.findAll({
        order: [['site_name', 'ASC'], ['name', 'ASC']],
        include: [
          { model: Device, as: 'device', attributes: ['id', 'name', 'ip_address', 'type', 'status', 'location'], required: false },
          { model: WireguardPeer, as: 'wireguard_peer', attributes: ['id', 'name', 'server_id', 'public_key', 'allocated_ip'], required: false },
        ],
      });

      // Statistik live WireGuard per-interface (satu `wg show` per server unik yang dipakai).
      const serverIds = [...new Set(rows.map(r => r.wireguard_peer?.server_id).filter(Boolean))];
      const servers = serverIds.length ? await WireguardServer.findAll({ where: { id: serverIds } }) : [];
      const statsByServer = new Map();
      for (const s of servers) statsByServer.set(s.id, WireGuardService.getRuntimeStats(s.interface_name));

      const vpnOpts = { now: Date.now(), accelSessions: '', allowPing: false };
      res.json({ success: true, data: rows.map(r => serializeNas(r, statsByServer, vpnOpts)) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/nas — mode 'direct' (IP publik manual)
  async nasCreate(req, res) {
    try {
      const { name, nas_ip_address, secret, nas_type, description, site_name, device_id } = req.body || {};
      if (!name || !nas_ip_address || !secret) {
        return res.status(400).json({ success: false, message: 'name, nas_ip_address, dan secret wajib diisi' });
      }
      const { RadiusNasClient } = require('../models');
      const row = await RadiusNasClient.create({
        name, nas_ip_address, secret: encrypt(secret),
        nas_type: nas_type || 'mikrotik', description: description || null,
        site_name: site_name || null, device_id: device_id || null,
        connection_mode: 'direct',
        created_by: req.user?.id || null,
      });
      RadiusServer.invalidateNasCache();
      res.json({ success: true, message: 'NAS client ditambahkan', data: { ...row.toJSON(), secret: undefined } });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'IP address NAS sudah terdaftar' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/nas/via-wireguard — mode 'wireguard': router TIDAK perlu IP
  // publik. Auto-provision WireguardPeer, NAS IP diisi dari IP tunnel peer tsb.
  async nasCreateViaWireguard(req, res) {
    try {
      const { name, server_id, site_name, device_id, description } = req.body || {};
      if (!name || !server_id) {
        return res.status(400).json({ success: false, message: 'name dan server_id (interface WireGuard) wajib diisi' });
      }
      const { RadiusNasClient, WireguardServer, WireguardPeer, Device } = require('../models');
      const server = await WireguardServer.findByPk(server_id);
      if (!server) return res.status(404).json({ success: false, message: 'Interface WireGuard tidak ditemukan. Buat interface dahulu di menu WireGuard VPN.' });

      let siteNameFinal = site_name || null;
      if (!siteNameFinal && device_id) {
        const dev = await Device.findByPk(device_id);
        if (dev?.location) siteNameFinal = dev.location;
      }

      const { privateKey, publicKey } = WireGuardService.generateKeypair();
      const presharedKey = WireGuardService.generatePresharedKey();
      const allocatedIp  = await WireGuardService.allocateIp(server);
      const subnetCidr   = WireGuardService.networkCidr(server.address_cidr);

      const peer = await WireguardPeer.create({
        server_id: server.id,
        name: `NAS: ${name}`,
        public_key: publicKey,
        private_key: WireGuardService.encrypt(privateKey),
        preshared_key: WireGuardService.encrypt(presharedKey),
        allocated_ip: allocatedIp,
        client_allowed_ips: subnetCidr,
        persistent_keepalive: 25,
        created_by: req.user?.id || null,
      });

      const secret = genSecret();
      let nas;
      try {
        nas = await RadiusNasClient.create({
          name,
          nas_ip_address: allocatedIp.split('/')[0],
          secret: encrypt(secret),
          nas_type: 'mikrotik',
          description: description || null,
          site_name: siteNameFinal,
          device_id: device_id || null,
          connection_mode: 'wireguard',
          wireguard_peer_id: peer.id,
          created_by: req.user?.id || null,
        });
      } catch (nasErr) {
        // Rollback kompensasi — jangan tinggalkan peer WireGuard tanpa NAS-nya.
        await peer.destroy().catch(() => {});
        throw nasErr;
      }
      RadiusServer.invalidateNasCache();

      const applyResult = await WireGuardService.applyLive(server);
      const wgConfig = WireGuardService.buildClientConfig(server, peer);

      res.json({
        success: true,
        message: 'NAS via WireGuard dibuat' + (applyResult.applied ? ' dan tunnel aktif' : ' (tunnel belum aktif live — ' + applyResult.error + ')'),
        data: { ...nas.toJSON(), secret: undefined },
        // Ditampilkan SEKALI di sini untuk admin salin ke router — tidak dikembalikan lagi setelahnya.
        radiusSecret: secret,
        wireguardConfig: wgConfig,
        serverTunnelAddress: server.address_cidr.split('/')[0],
        apply: applyResult,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Konflik data (IP/public key sudah dipakai) — coba lagi' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/nas/via-vpn — mode 'vpn': L2TP/PPTP ke concentrator di
  // server ini. Router MikroTik tidak perlu IP publik. Kredensial PPP + script
  // RouterOS digenerate otomatis; script disembunyikan setelah NAS online.
  async nasCreateViaVpn(req, res) {
    try {
      const { name, site_name, device_id, description } = req.body || {};
      const result = await VpnNasService.provisionVpnNas({
        name, site_name, device_id, description, created_by: req.user?.id || null,
      });
      RadiusServer.invalidateNasCache();
      const nasJson = { ...result.nas.toJSON(), secret: undefined, vpn_password: undefined };
      res.json({
        success: true,
        message: 'NAS via VPN (L2TP/PPTP) dibuat' + (result.apply.applied ? '' : ' (akun VPN tersimpan; concentrator live belum terpasang)'),
        data: nasJson,
        radiusSecret: result.radiusSecret,
        vpnUsername: result.nas.vpn_username,
        vpnPassword: result.vpnPassword,
        vpnServerIp: result.settings.serverIp,
        script: result.script,
        apply: result.apply,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Konflik data (username/IP VPN sudah dipakai) — coba lagi' });
      }
      const status = /wajib|belum diisi|tidak valid|Tidak ada IP/i.test(err.message) ? 400 : 500;
      res.status(status).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/nas/:id/detail — payload lengkap untuk modal Detail NAS.
  // Script MikroTik HANYA dikirim kalau NAS belum terhubung.
  async nasDetail(req, res) {
    try {
      const { RadiusNasClient, Device, WireguardPeer } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id, {
        include: [
          { model: Device, as: 'device', attributes: ['id', 'name', 'ip_address', 'type', 'status', 'location'], required: false },
          { model: WireguardPeer, as: 'wireguard_peer', attributes: ['id', 'name', 'server_id', 'public_key', 'allocated_ip'], required: false },
        ],
      });
      if (!row) return res.status(404).json({ success: false, message: 'NAS client tidak ditemukan' });

      const vpnOpts = { now: Date.now(), allowPing: true };
      const data = serializeNas(row, null, vpnOpts);
      const settings = await VpnNasService.getSettings();
      const connected = !!data.live?.connected;

      const payload = {
        ...data,
        vpn: row.connection_mode === 'vpn' ? {
          serverIp: settings.serverIp,
          username: row.vpn_username,
          protocols: VpnNasService.protocolList(row.vpn_protocols || settings.protocols),
          protocolLabel: VpnNasService.protocolLabel(row.vpn_protocols || settings.protocols),
          profile: VpnNasService.publicProfile(row, settings),
        } : null,
        scriptHidden: row.connection_mode === 'vpn' && connected,
        script: null,
      };

      if (row.connection_mode === 'vpn' && !connected) {
        payload.script = VpnNasService.buildMikrotikScript({
          name: row.name,
          serverIp: settings.serverIp,
          username: row.vpn_username,
          password: VpnNasService.decrypt(row.vpn_password),
          radiusSecret: decrypt(row.secret),
          localIp: row.vpn_local_ip || settings.localIp,
          remoteIp: row.vpn_remote_ip || row.nas_ip_address,
          profileName: settings.profileName,
          dns: settings.dns,
          protocols: row.vpn_protocols || settings.protocols,
          mtu: settings.mtu,
        });
      }

      res.json({ success: true, data: payload });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/vpn/settings
  async vpnSettingsGet(req, res) {
    try {
      const data = await VpnNasService.getSettings();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/radius/vpn/settings
  async vpnSettingsSave(req, res) {
    try {
      const data = await VpnNasService.saveSettings(req.body || {});
      try { await VpnNasService.syncChapSecrets(); } catch (_) {}
      res.json({ success: true, message: 'Pengaturan NAS VPN disimpan', data });
    } catch (err) {
      const status = /tidak valid|harus/i.test(err.message) ? 400 : 500;
      res.status(status).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/nas/:id/vpn-password — reveal password PPP (admin only)
  async nasRevealVpnPassword(req, res) {
    try {
      const { RadiusNasClient } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id);
      if (!row || row.connection_mode !== 'vpn') {
        return res.status(404).json({ success: false, message: 'NAS VPN tidak ditemukan' });
      }
      res.json({ success: true, password: VpnNasService.decrypt(row.vpn_password), username: row.vpn_username });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/radius/nas/:id
  async nasUpdate(req, res) {
    try {
      const { RadiusNasClient } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'NAS client tidak ditemukan' });

      const { name, nas_ip_address, secret, nas_type, description, is_active, site_name, device_id } = req.body || {};
      const patch = {};
      if (name !== undefined) patch.name = name;
      // NAS mode 'wireguard' — nas_ip_address dikelola otomatis dari tunnel, tidak boleh diedit manual.
      if (nas_ip_address !== undefined && row.connection_mode !== 'wireguard' && row.connection_mode !== 'vpn') patch.nas_ip_address = nas_ip_address;
      if (secret) patch.secret = encrypt(secret); // kosong = pertahankan secret lama
      if (nas_type !== undefined) patch.nas_type = nas_type;
      if (description !== undefined) patch.description = description;
      if (is_active !== undefined) patch.is_active = !!is_active;
      if (site_name !== undefined) patch.site_name = site_name || null;
      if (device_id !== undefined) patch.device_id = device_id || null;
      await row.update(patch);
      RadiusServer.invalidateNasCache();
      res.json({ success: true, message: 'NAS client diperbarui', data: { ...row.toJSON(), secret: undefined } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/radius/nas/:id — kalau mode wireguard, ikut hapus peer & port forward-nya.
  async nasDestroy(req, res) {
    try {
      const { RadiusNasClient, WireguardPeer, WireguardServer, NasPortForward } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'NAS client tidak ditemukan' });

      const forwards = await NasPortForward.findAll({ where: { nas_client_id: row.id } });
      for (const fwd of forwards) {
        try { WireGuardService.removePortForward({ public_port: fwd.public_port, target_ip: row.nas_ip_address, target_port: fwd.target_port, protocol: fwd.protocol }); }
        catch (_) {}
      }
      await NasPortForward.destroy({ where: { nas_client_id: row.id } });

      if (row.connection_mode === 'wireguard' && row.wireguard_peer_id) {
        const peer = await WireguardPeer.findByPk(row.wireguard_peer_id);
        if (peer) {
          const server = await WireguardServer.findByPk(peer.server_id);
          await peer.destroy();
          if (server) await WireGuardService.applyLive(server);
        }
      }

      const wasVpn = row.connection_mode === 'vpn';
      await row.destroy();
      if (wasVpn) {
        try { await VpnNasService.syncChapSecrets(); } catch (_) {}
      }
      RadiusServer.invalidateNasCache();
      res.json({ success: true, message: 'NAS client dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/nas/:id/secret — reveal shared secret (superadmin/admin only, dicatat via logActivity di route).
  async nasRevealSecret(req, res) {
    try {
      const { RadiusNasClient } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'NAS client tidak ditemukan' });
      res.json({ success: true, secret: decrypt(row.secret) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/nas/:id/wireguard-config — ambil ulang config client (mode wireguard saja)
  async nasWireguardConfig(req, res) {
    try {
      const { RadiusNasClient, WireguardPeer, WireguardServer } = require('../models');
      const row = await RadiusNasClient.findByPk(req.params.id);
      if (!row || row.connection_mode !== 'wireguard' || !row.wireguard_peer_id) {
        return res.status(404).json({ success: false, message: 'NAS ini tidak terhubung lewat WireGuard' });
      }
      const peer = await WireguardPeer.findByPk(row.wireguard_peer_id);
      const server = await WireguardServer.findByPk(peer.server_id);
      const config = WireGuardService.buildClientConfig(server, peer);
      res.json({ success: true, config, serverTunnelAddress: server.address_cidr.split('/')[0] });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  }

  // ── PORT FORWARDING (per-NAS, lewat tunnel WireGuard) ────────────────
  // GET /api/radius/nas/:id/port-forwards
  async portForwardsIndex(req, res) {
    try {
      const { NasPortForward } = require('../models');
      const rows = await NasPortForward.findAll({ where: { nas_client_id: req.params.id }, order: [['public_port', 'ASC']] });
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/nas/:id/port-forwards
  async portForwardCreate(req, res) {
    try {
      const { RadiusNasClient, NasPortForward } = require('../models');
      const nas = await RadiusNasClient.findByPk(req.params.id);
      if (!nas) return res.status(404).json({ success: false, message: 'NAS tidak ditemukan' });
      if (nas.connection_mode !== 'wireguard' && nas.connection_mode !== 'vpn') {
        return res.status(400).json({ success: false, message: 'Port forwarding hanya untuk NAS mode WireGuard atau VPN' });
      }
      const { public_port, target_port, protocol, description } = req.body || {};
      if (!public_port || !target_port) {
        return res.status(400).json({ success: false, message: 'public_port dan target_port wajib diisi' });
      }
      const row = await NasPortForward.create({
        nas_client_id: nas.id,
        public_port: parseInt(public_port, 10),
        target_port: parseInt(target_port, 10),
        protocol: protocol === 'udp' ? 'udp' : 'tcp',
        description: description || null,
        created_by: req.user?.id || null,
      });

      let apply = { applied: false };
      try {
        const iface = await WireGuardService.addPortForward({
          public_port: row.public_port, target_ip: nas.nas_ip_address, target_port: row.target_port, protocol: row.protocol,
        });
        apply = { applied: true, iface: iface.iface };
      } catch (e) {
        apply = { applied: false, error: e.message };
      }

      res.json({ success: true, message: 'Port forward dibuat' + (apply.applied ? '' : ' (belum aktif live — ' + apply.error + ')'), data: row, apply });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Port publik itu sudah dipakai forward lain' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/radius/nas/:nasId/port-forwards/:id
  async portForwardDestroy(req, res) {
    try {
      const { RadiusNasClient, NasPortForward } = require('../models');
      const row = await NasPortForward.findOne({ where: { id: req.params.id, nas_client_id: req.params.nasId } });
      if (!row) return res.status(404).json({ success: false, message: 'Port forward tidak ditemukan' });
      const nas = await RadiusNasClient.findByPk(req.params.nasId);
      try {
        WireGuardService.removePortForward({ public_port: row.public_port, target_ip: nas?.nas_ip_address, target_port: row.target_port, protocol: row.protocol });
      } catch (_) {}
      await row.destroy();
      res.json({ success: true, message: 'Port forward dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // GET /api/radius/port-forwards — daftar konsolidasi semua port forward lintas NAS
  async portForwardsAllIndex(req, res) {
    try {
      const { NasPortForward, RadiusNasClient, WireguardPeer, WireguardServer } = require('../models');
      const rows = await NasPortForward.findAll({
        order: [['public_port', 'ASC']],
        include: [{
          model: RadiusNasClient, as: 'nas',
          attributes: ['id', 'name', 'site_name', 'nas_ip_address', 'connection_mode'],
          required: true,
          include: [{
            model: WireguardPeer, as: 'wireguard_peer', attributes: ['id', 'server_id'], required: false,
            include: [{ model: WireguardServer, as: 'server', attributes: ['endpoint_host', 'listen_port'], required: false }],
          }],
        }],
      });
      res.json({ success: true, data: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── RADIUS USERS ─────────────────────────────────────────────────────
  // GET /api/radius/users
  async usersIndex(req, res) {
    try {
      const { RadiusUser, Customer } = require('../models');
      const { search } = req.query;
      const where = {};
      if (search) where.username = { [Op.like]: `%${search}%` };
      const rows = await RadiusUser.findAll({
        where, order: [['created_at', 'DESC']],
        include: [{ model: Customer, as: 'customer', attributes: ['id', 'name', 'customer_id'], required: false }],
      });
      res.json({ success: true, data: rows.map(r => ({ ...r.toJSON(), password: undefined })) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // POST /api/radius/users
  async usersCreate(req, res) {
    try {
      const { username, password, customer_id, group_name, reply_framed_ip, reply_rate_limit, notes, expires_at } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ success: false, message: 'username dan password wajib diisi' });
      }
      const { RadiusUser } = require('../models');
      const row = await RadiusUser.create({
        username, password: encrypt(password),
        customer_id: customer_id || null,
        group_name: group_name || null,
        reply_framed_ip: reply_framed_ip || null,
        reply_rate_limit: reply_rate_limit || null,
        notes: notes || null,
        expires_at: expires_at || null,
      });
      res.json({ success: true, message: 'RADIUS user dibuat', data: { ...row.toJSON(), password: undefined } });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
      }
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // PUT /api/radius/users/:id
  async usersUpdate(req, res) {
    try {
      const { RadiusUser } = require('../models');
      const row = await RadiusUser.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'RADIUS user tidak ditemukan' });

      const { username, password, customer_id, group_name, reply_framed_ip, reply_rate_limit, notes, expires_at, is_active } = req.body || {};
      const patch = {};
      if (username !== undefined) patch.username = username;
      if (password) patch.password = encrypt(password); // kosong = pertahankan password lama
      if (customer_id !== undefined) patch.customer_id = customer_id || null;
      if (group_name !== undefined) patch.group_name = group_name || null;
      if (reply_framed_ip !== undefined) patch.reply_framed_ip = reply_framed_ip || null;
      if (reply_rate_limit !== undefined) patch.reply_rate_limit = reply_rate_limit || null;
      if (notes !== undefined) patch.notes = notes || null;
      if (expires_at !== undefined) patch.expires_at = expires_at || null;
      if (is_active !== undefined) patch.is_active = !!is_active;
      await row.update(patch);
      res.json({ success: true, message: 'RADIUS user diperbarui', data: { ...row.toJSON(), password: undefined } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // DELETE /api/radius/users/:id
  async usersDestroy(req, res) {
    try {
      const { RadiusUser } = require('../models');
      const row = await RadiusUser.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'RADIUS user tidak ditemukan' });
      await row.destroy();
      res.json({ success: true, message: 'RADIUS user dihapus' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // ── SESSIONS / ACCOUNTING ────────────────────────────────────────────
  // GET /api/radius/sessions?active=1
  async sessions(req, res) {
    try {
      const { RadiusAccounting } = require('../models');
      const activeOnly = req.query.active === '1';
      const where = activeOnly ? { stopped_at: null } : {};
      const rows = await RadiusAccounting.findAll({
        where, order: [['started_at', 'DESC']], limit: 200,
      });
      res.json({ success: true, data: rows, total: rows.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

module.exports = new RadiusController();
