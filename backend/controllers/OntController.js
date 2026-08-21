'use strict';

/**
 * OntController.js - ENHANCED
 * Full integration dengan GenieACS
 * - Dashboard stats & listing
 * - Detail per ONT (parameter TR-069 lengkap)
 * - Task management (reboot, factory reset, get/set value)
 * - Signal history
 * - Link pelanggan
 */

const { OntDevice, OntSignalHistory, Customer, Notification, User } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { paginateResponse } = require('../utils/helpers');
const GenieACSService = require('../services/GenieacsService');

class OntController {

  // ─────────────────────────────────────────────────────────
  // LISTING & STATS
  // ─────────────────────────────────────────────────────────

  async index(req, res) {
    try {
      const { page = 1, limit = 20, search, status, manufacturer } = req.query;
      const where = {};

      if (search) {
        where[Op.or] = [
          { serial_number: { [Op.like]: `%${search}%` } },
          { mac_address:   { [Op.like]: `%${search}%` } },
          { ip_address:    { [Op.like]: `%${search}%` } },
          { model:         { [Op.like]: `%${search}%` } }
        ];
      }
      if (status)       where.status = status;
      if (manufacturer) where.manufacturer = { [Op.like]: `%${manufacturer}%` };

      const offset = (page - 1) * limit;
      const { count, rows } = await OntDevice.findAndCountAll({
        where,
        include: [{
          model: Customer,
          as: 'customer',
          attributes: ['id', 'customer_id', 'name', 'phone', 'address']
        }],
        offset,
        limit: parseInt(limit),
        order: [
          // Online dulu, lalu warning, offline, unknown
          [OntDevice.sequelize.literal("FIELD(`OntDevice`.`status`,'online','warning','offline','unknown')"), 'ASC'],
          ['last_inform', 'DESC']
        ]
      });

      res.json({ success: true, ...paginateResponse(rows, count, page, limit) });
    } catch (error) {
      logger.error('OntController.index error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async stats(req, res) {
    try {
      const [total, online, offline, warning, unknown] = await Promise.all([
        OntDevice.count(),
        OntDevice.count({ where: { status: 'online' } }),
        OntDevice.count({ where: { status: 'offline' } }),
        OntDevice.count({ where: { status: 'warning' } }),
        OntDevice.count({ where: { status: 'unknown' } })
      ]);

      // ONT tanpa pelanggan
      const unassigned = await OntDevice.count({ where: { customer_id: null } });

      // ONT online % (dari yang punya data)
      const known = total - unknown;
      const onlinePercent = known > 0 ? Math.round((online / known) * 100) : 0;

      res.json({
        success: true,
        data: { total, online, offline, warning, unknown, unassigned, onlinePercent }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─────────────────────────────────────────────────────────
  // DETAIL & PARAMETERS
  // ─────────────────────────────────────────────────────────

  async show(req, res) {
    try {
      const ont = await OntDevice.findByPk(req.params.id, {
        include: [{
          model: Customer,
          as: 'customer',
          attributes: ['id', 'customer_id', 'name', 'phone', 'address', 'status']
        }]
      });
      if (!ont) return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });

      res.json({ success: true, data: ont });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Ambil parameter TR-069 lengkap langsung dari GenieACS (realtime)
   */
  async getParameters(req, res) {
    try {
      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan atau belum terdaftar di GenieACS' });
      }

      const rawDevice = await GenieACSService.getDevice(ont.device_id);
      if (!rawDevice) {
        return res.status(404).json({ success: false, message: 'Device tidak ditemukan di GenieACS' });
      }

      // Ekstrak info terstruktur
      const deviceInfo = GenieACSService.extractDeviceInfo(rawDevice);

      // Bangun parameter tree untuk tampilan UI
      const paramTree = this._buildParamTree(rawDevice);

      res.json({
        success: true,
        data: {
          info: deviceInfo,
          params: paramTree,
          raw: rawDevice  // Raw untuk advanced view
        }
      });
    } catch (error) {
      logger.error('OntController.getParameters error:', error);
      res.status(500).json({ success: false, message: 'Gagal mengambil parameter: ' + error.message });
    }
  }

  /**
   * Build parameter tree yang readable dari raw GenieACS response
   * Flatten ke array of { path, value, type, writable, timestamp }
   */
  _buildParamTree(rawDevice) {
    const params = [];
    const skip = ['_id', '_deviceId', '_registered', '_lastInform', '_lastBoot', '_tags'];

    const traverse = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;

      // Ini adalah leaf node (parameter value)
      if ('_value' in obj) {
        params.push({
          path: path,
          value: obj._value,
          type: obj._type || 'string',
          writable: obj._writable !== false,
          timestamp: obj._timestamp ? new Date(obj._timestamp * 1000).toISOString() : null
        });
        return;
      }

      for (const key of Object.keys(obj)) {
        if (skip.includes(key) || key.startsWith('_')) continue;
        const newPath = path ? `${path}.${key}` : key;
        traverse(obj[key], newPath);
      }
    };

    traverse(rawDevice);

    // Sort by path
    params.sort((a, b) => a.path.localeCompare(b.path));
    return params;
  }

  /**
   * Ambil signal history untuk grafik
   */
  async getSignalHistory(req, res) {
    try {
      const { hours = 24 } = req.query;
      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont) return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });

      const since = new Date(Date.now() - parseInt(hours) * 3600 * 1000);
      const history = await OntSignalHistory.findAll({
        where: {
          ont_device_id: ont.id,
          recorded_at: { [Op.gte]: since }
        },
        order: [['recorded_at', 'ASC']],
        attributes: ['rx_power', 'tx_power', 'olt_rx_power', 'status', 'recorded_at'],
        limit: 288 // Max 288 data points (5 min interval x 24 jam)
      });

      res.json({ success: true, data: history });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─────────────────────────────────────────────────────────
  // LINK PELANGGAN
  // ─────────────────────────────────────────────────────────

  async assignCustomer(req, res) {
    try {
      const { customer_id } = req.body;
      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont) return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });

      if (customer_id) {
        // Cek apakah customer sudah punya ONT lain
        const existing = await OntDevice.findOne({
          where: {
            customer_id: customer_id,
            id: { [Op.ne]: ont.id }
          }
        });
        if (existing) {
          return res.status(400).json({
            success: false,
            message: `Pelanggan sudah terhubung ke ONT lain (SN: ${existing.serial_number})`
          });
        }
      }

      await ont.update({ customer_id: customer_id || null });
      const updated = await OntDevice.findByPk(ont.id, {
        include: [{ model: Customer, as: 'customer', attributes: ['id', 'customer_id', 'name'] }]
      });

      res.json({ success: true, message: 'Pelanggan berhasil di-assign', data: updated });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ─────────────────────────────────────────────────────────
  // TASK MANAGEMENT
  // ─────────────────────────────────────────────────────────

  async reboot(req, res) {
    try {
      const ont = await OntDevice.findByPk(req.params.id, {
        include: [{ model: Customer, as: 'customer', attributes: ['name'] }]
      });
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan atau belum sync dengan GenieACS' });
      }

      await GenieACSService.reboot(ont.device_id);

      logger.info(`ONT reboot task sent: ${ont.serial_number} by user ${req.user.id}`);
      res.json({ success: true, message: `Perintah reboot dikirim ke ONT ${ont.serial_number}` });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Gagal kirim perintah reboot: ' + error.message });
    }
  }

  async factoryReset(req, res) {
    try {
      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan atau belum sync dengan GenieACS' });
      }

      await GenieACSService.factoryReset(ont.device_id);

      logger.warn(`ONT factory reset task sent: ${ont.serial_number} by user ${req.user.id}`);
      res.json({ success: true, message: `Perintah factory reset dikirim ke ONT ${ont.serial_number}` });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Gagal kirim perintah factory reset: ' + error.message });
    }
  }

  async setValue(req, res) {
    try {
      const { parameter, value, type = 'xsd:string' } = req.body;
      if (!parameter || value === undefined) {
        return res.status(400).json({ success: false, message: 'Parameter dan value wajib diisi' });
      }

      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });
      }

      const result = await GenieACSService.setParameterValues(ont.device_id, [[parameter, value, type]]);

      logger.info(`ONT setParameterValues: ${ont.serial_number} ${parameter}=${value}`);
      res.json({ success: true, message: 'Parameter berhasil diset', data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Gagal set parameter: ' + error.message });
    }
  }

  async getValue(req, res) {
    try {
      const { parameters } = req.body;
      if (!parameters || !Array.isArray(parameters)) {
        return res.status(400).json({ success: false, message: 'Parameters harus berupa array' });
      }

      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });
      }

      const result = await GenieACSService.getParameterValues(ont.device_id, parameters);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Gagal get parameter: ' + error.message });
    }
  }

  async refreshParams(req, res) {
    try {
      const ont = await OntDevice.findByPk(req.params.id);
      if (!ont || !ont.device_id) {
        return res.status(404).json({ success: false, message: 'ONT tidak ditemukan' });
      }

      const root = req.body.root || 'InternetGatewayDevice';
      await GenieACSService.refreshObject(ont.device_id, [root]);

      res.json({ success: true, message: 'Refresh parameter dikirim, tunggu beberapa detik' });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Gagal refresh parameter: ' + error.message });
    }
  }

  // ─────────────────────────────────────────────────────────
  // SYNC FROM GENIEACS
  // ─────────────────────────────────────────────────────────

  /**
   * Manual sync dari GenieACS (dipanggil dari UI atau cron)
   */
  async syncFromGenieACS(req, res) {
    try {
      const result = await this._performSync(req.app.get('io'));
      res.json({
        success: true,
        message: `Sync selesai: ${result.synced} ONT diperbarui, ${result.offline_detected} offline terdeteksi, ${result.errors} error`,
        data: result
      });
    } catch (error) {
      logger.error('GenieACS sync error:', error);
      res.status(500).json({
        success: false,
        message: 'Gagal terhubung ke GenieACS: ' + error.message
      });
    }
  }

  /**
   * Core sync logic - digunakan oleh manual sync dan cron
   */
  async _performSync(io = null) {
    const devices = await GenieACSService.fetchDevicesForSync();

    let synced = 0;
    let offline_detected = 0;
    let errors = 0;
    const offlineONTs = [];

    for (const rawDevice of devices) {
      try {
        const info = GenieACSService.extractDeviceInfo(rawDevice);
        if (!info) continue;

        // Cari ONT yang sudah ada berdasarkan device_id atau serial_number
        let ontRecord = await OntDevice.findOne({
          where: {
            [Op.or]: [
              { device_id: info.device_id },
              { serial_number: info.serial_number }
            ]
          }
        });

        const prevStatus = ontRecord?.status;

        const updateData = {
          device_id:     info.device_id,
          serial_number: info.serial_number,
          manufacturer:  info.manufacturer || ontRecord?.manufacturer,
          model:         info.model || ontRecord?.model,
          firmware:      info.firmware || ontRecord?.firmware,
          ip_address:    info.ip_address || ontRecord?.ip_address,
          mac_address:   info.mac_address || ontRecord?.mac_address,
          status:        info.status,
          signal_strength: info.rx_power,
          uptime:        info.uptime_seconds ? GenieACSService.formatUptime(info.uptime_seconds) : ontRecord?.uptime,
          last_inform:   info.last_inform,
          last_synced:   new Date(),
          tr069_params:  {
            rx_power:     info.rx_power,
            tx_power:     info.tx_power,
            olt_rx_power: info.olt_rx_power,
            oui:          info.oui,
            hardware_version: info.hardware_version
          }
        };

        if (ontRecord) {
          await ontRecord.update(updateData);
        } else {
          ontRecord = await OntDevice.create(updateData);
        }

        // Simpan ke signal history (hanya jika ada data sinyal)
        if (info.rx_power !== null || info.tx_power !== null) {
          await OntSignalHistory.create({
            ont_device_id: ontRecord.id,
            rx_power:      info.rx_power,
            tx_power:      info.tx_power,
            olt_rx_power:  info.olt_rx_power,
            status:        info.status
          });
        }

        // Deteksi perubahan status online -> offline
        if (prevStatus === 'online' && info.status === 'offline') {
          offline_detected++;
          offlineONTs.push({ ont: ontRecord, info });
        }

        synced++;
      } catch (err) {
        errors++;
        logger.error(`ONT sync error for device ${rawDevice._id}:`, err.message);
      }
    }

    // Update ONT yang ada di DB tapi tidak ada di GenieACS
    // (device yang mungkin sudah dihapus dari GenieACS)
    await this._checkMissingDevices(devices);

    // Kirim notifikasi untuk ONT yang baru offline
    if (offlineONTs.length > 0 && io) {
      await this._notifyOfflineONTs(offlineONTs, io);
    }

    // Emit update via Socket.IO
    if (io) {
      const stats = await this._getQuickStats();
      io.to('monitoring').emit('ont:sync_complete', { stats, offline_detected });
    }

    return { synced, offline_detected, errors, total: devices.length };
  }

  async _checkMissingDevices(genieDevices) {
    try {
      const genieIds = genieDevices
        .map(d => d._id)
        .filter(Boolean);

      if (genieIds.length === 0) return;

      // Update status menjadi unknown untuk device yang tidak ada di GenieACS
      await OntDevice.update(
        { status: 'unknown' },
        {
          where: {
            device_id: { [Op.notIn]: genieIds },
            status: { [Op.ne]: 'unknown' }
          }
        }
      );
    } catch (err) {
      logger.error('_checkMissingDevices error:', err.message);
    }
  }

  async _notifyOfflineONTs(offlineONTs, io) {
    try {
      // Load customer data untuk ONT offline
      const ontIds = offlineONTs.map(o => o.ont.id);
      const ontsWithCustomer = await OntDevice.findAll({
        where: { id: { [Op.in]: ontIds } },
        include: [{ model: Customer, as: 'customer', attributes: ['name', 'customer_id'] }]
      });

      // Buat notifikasi untuk admin/superadmin
      const admins = await User.findAll({
        include: [{
          model: require('../models').Role,
          as: 'role',
          where: { name: { [Op.in]: ['superadmin', 'admin'] } }
        }]
      });

      for (const ont of ontsWithCustomer) {
        const customerName = ont.customer?.name || 'Unassigned';
        const message = `ONT ${ont.serial_number} (${customerName}) terdeteksi OFFLINE`;

        // Simpan notifikasi ke DB
        for (const admin of admins) {
          await Notification.create({
            user_id: admin.id,
            type: 'ont_offline',
            title: 'ONT Offline',
            message,
            data: JSON.stringify({ ont_id: ont.id, serial_number: ont.serial_number })
          });

          // Push via Socket.IO
          io.to(`user_${admin.id}`).emit('notification:new', {
            type: 'ont_offline',
            title: 'ONT Offline',
            message
          });
        }

        // Update badge count
        const offlineCount = await OntDevice.count({ where: { status: 'offline' } });
        io.emit('ont:offline_count', offlineCount);
      }
    } catch (err) {
      logger.error('_notifyOfflineONTs error:', err.message);
    }
  }

  async _getQuickStats() {
    const [total, online, offline, warning] = await Promise.all([
      OntDevice.count(),
      OntDevice.count({ where: { status: 'online' } }),
      OntDevice.count({ where: { status: 'offline' } }),
      OntDevice.count({ where: { status: 'warning' } })
    ]);
    return { total, online, offline, warning };
  }

  // ─────────────────────────────────────────────────────────
  // HEALTH CHECK
  // ─────────────────────────────────────────────────────────

  async healthCheck(req, res) {
    try {
      const health = await GenieACSService.healthCheck();
      res.json({ success: true, data: health });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new OntController();