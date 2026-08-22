'use strict';

const { InfrastructurePoint, Customer } = require('../models');
const { Op } = require('sequelize');

class InfrastructureController {

  // GET /api/infrastructure
  async index(req, res) {
    try {
      const { type, status, search } = req.query;
      const where = {};
      if (type)   where.type   = type;
      if (status) where.status = status;
      if (search) where.name   = { [Op.like]: `%${search}%` };

      const points = await InfrastructurePoint.findAll({
        where,
        order: [['created_at', 'DESC']],
      });
      res.json({ success: true, data: points });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /api/infrastructure/map  — semua titik untuk Leaflet
  async mapData(req, res) {
    try {
      const points = await InfrastructurePoint.findAll({
        where: { status: { [Op.ne]: 'inactive' } },
        attributes: ['id','name','type','latitude','longitude','status',
                     'capacity','used_ports','parent_id','metadata','notes'],
        order: [['type', 'ASC'], ['name', 'ASC']],
      });
      res.json({ success: true, data: points });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /api/infrastructure/stats
  async stats(req, res) {
    try {
      const all = await InfrastructurePoint.findAll({ attributes: ['type','status'] });
      const byType = {}, byStatus = {};
      all.forEach(p => {
        byType[p.type]     = (byType[p.type]     || 0) + 1;
        byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      });
      res.json({ success: true, total: all.length, byType, byStatus });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /api/infrastructure/:id
  async show(req, res) {
    try {
      const point = await InfrastructurePoint.findByPk(req.params.id);
      if (!point) return res.status(404).json({ success: false, message: 'Titik tidak ditemukan' });
      res.json({ success: true, data: point });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // POST /api/infrastructure
  async create(req, res) {
    try {
      const { name, type, latitude, longitude, address, status,
              capacity, used_ports, parent_id, metadata, notes } = req.body;
      if (!name || !type || latitude == null || longitude == null)
        return res.status(400).json({ success: false, message: 'name, type, latitude, longitude wajib diisi' });

      const point = await InfrastructurePoint.create({
        name, type, latitude, longitude,
        address:    address    || null,
        status:     status     || 'active',
        capacity:   capacity   || null,
        used_ports: used_ports || 0,
        parent_id:  parent_id  || null,
        metadata:   metadata   || null,
        notes:      notes      || null,
      });

      // Reverse-sync: kalau ini titik customer (type='customer' dgn metadata.customer_id),
      // update juga Customer record agar lat/lng/parent konsisten dua arah. Best-effort.
      // Lalu panggil syncCustomerLink untuk memastikan record InfrastructureLink ada.
      if (point.type === 'customer') {
        try {
          await this._syncCustomerFromInfra(point);
        } catch (e) {
          // tidak fatal — point sudah ter-create
          require('../utils/logger').warn(`[InfraController] reverse-sync gagal: ${e.message}`);
        }
      }

      res.status(201).json({ success: true, data: point });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // PUT /api/infrastructure/:id
  async update(req, res) {
    try {
      const point = await InfrastructurePoint.findByPk(req.params.id);
      if (!point) return res.status(404).json({ success: false, message: 'Titik tidak ditemukan' });
      await point.update(req.body);

      // Reverse-sync titik customer kalau ada perubahan koord/parent
      if (point.type === 'customer') {
        try {
          await this._syncCustomerFromInfra(point);
        } catch (e) {
          require('../utils/logger').warn(`[InfraController] reverse-sync gagal: ${e.message}`);
        }
      }

      res.json({ success: true, data: point });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // Internal helper — saat InfrastructurePoint type='customer' di-buat/update via
  // halaman /infrastructure, sinkronkan kembali ke kolom Customer:
  //   - latitude / longitude  (dari point ke customer)
  //   - infra_parent_id       (dari point.parent_id ke customer.infra_parent_id)
  // Lalu pastikan record InfrastructureLink customer ↔ parent ada (idempoten).
  //
  // CATATAN: kita HANYA panggil syncCustomerLink (ringan, cek 1 link), bukan
  // syncCustomerToInfra (yang akan re-find & re-update point yang BARU saja
  // ke-update via PUT ini — redundan dan menyebabkan extra DB roundtrip).
  async _syncCustomerFromInfra(point) {
    let meta = point.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = null; }
    }
    if (!meta || !meta.customer_id) return;

    const customer = await Customer.findByPk(meta.customer_id);
    if (!customer) return;

    // Update field Customer yang affected
    const updates = {};
    if (Number(customer.latitude)       !== Number(point.latitude))  updates.latitude  = point.latitude;
    if (Number(customer.longitude)      !== Number(point.longitude)) updates.longitude = point.longitude;
    if (Number(customer.infra_parent_id || 0) !== Number(point.parent_id || 0)) {
      updates.infra_parent_id = point.parent_id || null;
    }
    if (Object.keys(updates).length > 0) {
      await customer.update(updates);
    }

    // Ensure link customer ↔ parent ada (atau hapus kalau parent dilepas)
    try {
      const InfraSync = require('../services/CustomerInfraSyncService');
      await InfraSync.syncCustomerLink(customer, point.id, point.parent_id || null);
    } catch (e) {
      require('../utils/logger').warn(`[InfraController] sync link gagal: ${e.message}`);
    }
  }

  // DELETE /api/infrastructure/:id
  async destroy(req, res) {
    try {
      const point = await InfrastructurePoint.findByPk(req.params.id);
      if (!point) return res.status(404).json({ success: false, message: 'Titik tidak ditemukan' });

      // Kalau ini titik customer, clear juga lat/lng & infra_parent_id di Customer
      // agar konsisten (customer di list view tidak punya koord menggantung).
      if (point.type === 'customer') {
        try {
          let meta = point.metadata;
          if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); } catch (_) { meta = null; }
          }
          if (meta && meta.customer_id) {
            const customer = await Customer.findByPk(meta.customer_id);
            if (customer) {
              await customer.update({ latitude: null, longitude: null, infra_parent_id: null });
            }
          }
        } catch (e) {
          require('../utils/logger').warn(`[InfraController] clear customer coord gagal: ${e.message}`);
        }
      }

      // Hapus juga semua links yang melibatkan titik ini
      try {
        const { InfrastructureLink } = require('../models');
        const { Op } = require('sequelize');
        await InfrastructureLink.destroy({
          where: {
            [Op.or]: [
              { from_point_id: point.id },
              { to_point_id:   point.id },
            ],
          },
        });
      } catch (e) {
        require('../utils/logger').warn(`[InfraController] hapus links gagal: ${e.message}`);
      }

      await point.destroy();
      res.json({ success: true, message: 'Titik dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }


  // GET /api/infrastructure/parent-options
  // Daftar ringan ODP/ODC/POP untuk dropdown "Parent ODP" di form customer.
  // Hanya field minimal (id, name, type) supaya payload kecil. Diurutkan
  // berdasarkan name agar mudah dicari user.
  async parentOptions(req, res) {
    try {
      const points = await InfrastructurePoint.findAll({
        where: { type: ['odp', 'odc', 'pop'] },
        attributes: ['id', 'name', 'type', 'address'],
        order: [['type', 'ASC'], ['name', 'ASC']],
      });
      res.json({ success: true, data: points });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /api/infrastructure/pop/:id/devices
  //
  // List semua device (router/switch/server) yang ter-assign ke POP ini,
  // beserta status snapshot terakhir (CPU, RAM, uptime, last_polled).
  //
  // Cepat — tidak melakukan polling fresh ke device. Frontend bisa pakai
  // /api/device-monitor/:deviceId/realtime untuk fetch data fresh saat
  // user expand detail device tertentu.
  async getPopDevices(req, res) {
    try {
      const { Device } = require('../models');
      const popId = parseInt(req.params.id);
      if (!popId) return res.status(400).json({ success: false, message: 'POP id invalid' });

      // Pastikan POP-nya ada
      const pop = await InfrastructurePoint.findOne({
        where: { id: popId, type: 'pop' },
        attributes: ['id', 'name']
      });
      if (!pop) return res.status(404).json({ success: false, message: 'POP tidak ditemukan' });

      const devices = await Device.findAll({
        where: { pop_id: popId, is_active: true },
        attributes: [
          'id', 'name', 'ip_address', 'type', 'brand', 'model',
          'monitoring_type', 'status', 'cpu_load', 'memory_usage',
          'uptime', 'firmware', 'last_polled'
        ],
        order: [['type', 'ASC'], ['name', 'ASC']]
      });

      // Snapshot menggunakan kolom Device (di-update CronService device-traffic
      // setiap menit, atau saat user buka halaman Device Monitor).
      // Kalau last_polled > 5 menit lalu, anggap stale → status 'unknown'.
      const FIVE_MIN = 5 * 60 * 1000;
      const now = Date.now();
      const data = devices.map(d => {
        const stale = !d.last_polled || (now - new Date(d.last_polled).getTime()) > FIVE_MIN;
        return {
          id:               d.id,
          name:             d.name,
          ip_address:       d.ip_address,
          type:             d.type,
          brand:            d.brand,
          model:            d.model,
          monitoring_type:  d.monitoring_type,
          status:           stale && d.status === 'online' ? 'unknown' : d.status,
          cpu_load:         d.cpu_load,
          memory_usage:     d.memory_usage,
          uptime:           d.uptime,
          firmware:         d.firmware,
          last_polled:      d.last_polled,
          stale
        };
      });

      res.json({
        success: true,
        data,
        meta: {
          pop_id:   pop.id,
          pop_name: pop.name,
          total:    data.length,
          online:   data.filter(d => d.status === 'online').length,
          offline:  data.filter(d => d.status === 'offline').length,
          warning:  data.filter(d => d.status === 'warning').length,
          unknown:  data.filter(d => d.status === 'unknown').length
        }
      });
    } catch(e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // GET /api/infrastructure/customer/:id/rx-power
  // Ambil RX Power ONT dari GenieACS berdasarkan ont_sn pelanggan
  async getCustomerRxPower(req, res) {
    try {
      const { Customer } = require('../models');
      const customer = await Customer.findByPk(req.params.id, {
        attributes: ['id','ont_sn','pppoe_username']
      });

      if (!customer || !customer.ont_sn) {
        return res.json({ success: false, error: 'ONT belum di-assign ke pelanggan ini' });
      }

      // Cari device di GenieACS berdasarkan serial number
      const genieacs = require('../services/GenieacsService');
      const devices  = await genieacs.getDevices(
        { '_id': { '$regex': customer.ont_sn } },
        'VirtualParameters.RXPower,VirtualParameters.gettemp,_lastInform'
      );

      if (!devices.success || !devices.data?.length) {
        return res.json({ success: false, error: 'Device tidak ditemukan di GenieACS' });
      }

      const d       = devices.data[0];
      const signal  = genieacs.extractSignalInfo(d);
      const now     = Date.now();
      const lastInform = d._lastInform ? new Date(d._lastInform).getTime() : 0;
      const online  = lastInform && (now - lastInform) < 300000;

      res.json({
        success: true,
        data: {
          rx_power:    signal.rx_power    || null,
          temperature: signal.temperature || null,
          online,
          last_inform: d._lastInform || null,
          ont_sn:      customer.ont_sn
        }
      });
    } catch(e) {
      res.status(500).json({ success: false, error: e.message });
    }
  }

}

module.exports = new InfrastructureController();