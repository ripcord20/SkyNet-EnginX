const { Package, Customer } = require('../models');

// Allowed fields untuk create/update
const ALLOWED = ['name','speed_down','speed_up','price','description','category','is_active'];

function pickFields(body) {
  const out = {};
  ALLOWED.forEach(k => { if (k in body) out[k] = body[k]; });
  return out;
}

class PackageController {
  async index(req, res) {
    try {
      const packages = await Package.findAll({
        order: [['price', 'ASC']],
        include: [{
          model: Customer,
          as: 'customers',
          attributes: ['id']
        }]
      });

      const data = packages.map(pkg => ({
        ...pkg.toJSON(),
        customer_count: pkg.customers?.length || 0
      }));

      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async stats(req, res) {
    try {
      const packages = await Package.findAll({
        include: [{ model: Customer, as: 'customers', attributes: ['id'] }]
      });
      const active    = packages.filter(p => p.is_active).length;
      const totalCust = packages.reduce((a, p) => a + (p.customers?.length || 0), 0);
      const maxSpeed  = packages.length ? Math.max(...packages.map(p => p.speed_down || 0)) : 0;
      res.json({ success: true, data: { total: packages.length, active, totalCust, maxSpeed } });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async create(req, res) {
    try {
      const fields = pickFields(req.body);
      if (!fields.name)       return res.status(400).json({ success: false, message: 'Nama paket wajib diisi' });
      if (!fields.speed_down) return res.status(400).json({ success: false, message: 'Kecepatan download wajib diisi' });
      if (!fields.speed_up)   return res.status(400).json({ success: false, message: 'Kecepatan upload wajib diisi' });
      if (!fields.price)      return res.status(400).json({ success: false, message: 'Harga wajib diisi' });
      const pkg = await Package.create(fields);
      res.status(201).json({ success: true, data: pkg, message: 'Paket berhasil dibuat' });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async show(req, res) {
    try {
      const pkg = await Package.findByPk(req.params.id, {
        include: [{ model: Customer, as: 'customers', attributes: ['id','name'] }]
      });
      if (!pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
      res.json({ success: true, data: { ...pkg.toJSON(), customer_count: pkg.customers?.length || 0 } });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async update(req, res) {
    try {
      const pkg = await Package.findByPk(req.params.id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });
      const fields = pickFields(req.body);
      await pkg.update(fields);
      res.json({ success: true, data: pkg, message: 'Paket berhasil diperbarui' });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async destroy(req, res) {
    try {
      const pkg = await Package.findByPk(req.params.id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Paket tidak ditemukan' });

      const customerCount = await Customer.count({ where: { package_id: pkg.id } });
      if (customerCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Paket masih digunakan oleh ${customerCount} pelanggan. Pindahkan pelanggan terlebih dahulu.`
        });
      }

      await pkg.destroy();
      res.json({ success: true, message: 'Paket berhasil dihapus' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new PackageController();
