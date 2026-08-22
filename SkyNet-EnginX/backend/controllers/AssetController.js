const { Asset, AssetCategory, AssetHistory, Customer, InfrastructurePoint, OntDevice, User, sequelize } = require('../models');
const { Op } = require('sequelize');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ── Multer config untuk foto asset ──────────────────────────
const assetPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../../frontend/public/uploads/assets');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'asset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext);
  }
});
const uploadAssetPhoto = multer({
  storage: assetPhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format tidak didukung. Gunakan PNG/JPG/WebP'));
  }
});

// ── Generate asset code ──────────────────────────────────────
async function generateAssetCode(categorySlug) {
  const prefix = (categorySlug || 'AST').toUpperCase().slice(0, 3);
  const count = await Asset.count();
  const num = String(count + 1).padStart(5, '0');
  const year = new Date().getFullYear().toString().slice(2);
  return `${prefix}-${year}-${num}`;
}

// ── Log helper ───────────────────────────────────────────────
async function logHistory(asset_id, action, old_value, new_value, note, user_id) {
  try {
    await AssetHistory.create({
      asset_id,
      action,
      old_value: old_value ? JSON.stringify(old_value) : null,
      new_value: new_value ? JSON.stringify(new_value) : null,
      note: note || null,
      performed_by: user_id || null
    });
  } catch (e) {
    console.error('[AssetHistory] log error:', e.message);
  }
}

const commonInclude = [
  { model: AssetCategory, as: 'category', attributes: ['id', 'name', 'slug', 'icon', 'color'] },
  { model: Customer, as: 'customer', attributes: ['id', 'customer_id', 'name', 'phone'], required: false },
  { model: InfrastructurePoint, as: 'infrastructure', attributes: ['id', 'name', 'type'], required: false },
  { model: OntDevice, as: 'ont_device', attributes: ['id', 'serial_number', 'model'], required: false },
  { model: User, as: 'assigner', attributes: ['id', 'name'], required: false }
];

class AssetController {

  // ── GET /api/assets ──────────────────────────────────────
  async index(req, res) {
    try {
      const {
        page = 1, limit = 25, search, status, category_id,
        customer_id, infrastructure_id, sort = 'created_at', order = 'DESC'
      } = req.query;

      const where = {};
      if (search) {
        where[Op.or] = [
          { name:          { [Op.like]: `%${search}%` } },
          { asset_code:    { [Op.like]: `%${search}%` } },
          { serial_number: { [Op.like]: `%${search}%` } },
          { brand:         { [Op.like]: `%${search}%` } },
          { model:         { [Op.like]: `%${search}%` } }
        ];
      }
      if (status)           where.status = status;
      if (category_id)      where.category_id = category_id;
      if (customer_id)      where.customer_id = customer_id;
      if (infrastructure_id) where.infrastructure_id = infrastructure_id;

      const offset = (parseInt(page) - 1) * parseInt(limit);
      const allowedSort = ['name', 'asset_code', 'status', 'created_at', 'purchase_date', 'purchase_price'];
      const sortCol = allowedSort.includes(sort) ? sort : 'created_at';

      const { count, rows } = await Asset.findAndCountAll({
        where,
        include: commonInclude,
        offset,
        limit: parseInt(limit),
        order: [[sortCol, order === 'ASC' ? 'ASC' : 'DESC']]
      });

      res.json({
        success: true,
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(count / parseInt(limit))
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── GET /api/assets/stats ────────────────────────────────
  async stats(req, res) {
    try {
      const [
        byStatus,
        byCategory,
        totalValue,
        recentlyAssigned,
        valueByStatus
      ] = await Promise.all([
        // Hitung per status
        Asset.findAll({
          attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
          group: ['status'],
          raw: true
        }),
        // Hitung per kategori
        Asset.findAll({
          attributes: [
            'category_id',
            [sequelize.fn('COUNT', sequelize.col('Asset.id')), 'count']
          ],
          include: [{ model: AssetCategory, as: 'category', attributes: ['name', 'color', 'icon'] }],
          group: ['category_id', 'category.id', 'category.name', 'category.color', 'category.icon'],
          raw: false
        }),
        // Total nilai asset aktif
        Asset.findOne({
          attributes: [[sequelize.fn('SUM', sequelize.col('purchase_price')), 'total']],
          where: { status: { [Op.ne]: 'disposed' } },
          raw: true
        }),
        // Asset baru di-assign 30 hari terakhir
        Asset.count({
          where: {
            assigned_at: { [Op.gte]: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
          }
        }),
        // Nilai asset per status
        Asset.findAll({
          attributes: ['status', [sequelize.fn('SUM', sequelize.col('purchase_price')), 'total']],
          where: { status: { [Op.ne]: 'disposed' } },
          group: ['status'],
          raw: true
        })
      ]);

      const statusMap = {};
      byStatus.forEach(r => { statusMap[r.status] = parseInt(r.count); });

      const statusValueMap = {};
      valueByStatus.forEach(r => { statusValueMap[r.status] = parseFloat(r.total || 0); });

      res.json({
        success: true,
        data: {
          total: Object.values(statusMap).reduce((a, b) => a + b, 0),
          by_status: statusMap,
          by_category: byCategory.map(r => ({
            category: r.category,
            count: r.get('count')
          })),
          total_value: parseFloat(totalValue?.total || 0),
          value_by_status: statusValueMap,
          recently_assigned: recentlyAssigned
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── GET /api/assets/:id ──────────────────────────────────
  async show(req, res) {
    try {
      const asset = await Asset.findByPk(req.params.id, {
        include: [
          ...commonInclude,
          {
            model: AssetHistory,
            as: 'history',
            include: [{ model: User, as: 'performer', attributes: ['id', 'name'], required: false }],
            order: [['created_at', 'DESC']],
            limit: 50
          }
        ]
      });
      if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });
      res.json({ success: true, data: asset });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── POST /api/assets ─────────────────────────────────────
  async create(req, res) {
    try {
      const {
        name, category_id, brand, model, serial_number, status,
        condition, purchase_date, purchase_price, purchase_vendor, warranty_until,
        location, customer_id, infrastructure_id, ont_device_id, notes, specs
      } = req.body;

      // Ambil slug kategori untuk prefix kode
      let categorySlug = 'AST';
      if (category_id) {
        const cat = await AssetCategory.findByPk(category_id);
        if (cat) categorySlug = cat.slug;
      }

      const asset_code = await generateAssetCode(categorySlug);

      const asset = await Asset.create({
        asset_code, name, category_id, brand, model, serial_number,
        status: status || 'storage',
        condition: condition || 'good',
        purchase_date: purchase_date || null,
        purchase_price: purchase_price || 0,
        purchase_vendor: purchase_vendor || null,
        warranty_until: warranty_until || null,
        location: location || null,
        customer_id: customer_id || null,
        infrastructure_id: infrastructure_id || null,
        ont_device_id: ont_device_id || null,
        notes: notes || null,
        specs: specs || null,
        assigned_at: (customer_id || infrastructure_id) ? new Date() : null,
        assigned_by: (customer_id || infrastructure_id) ? (req.user?.id || null) : null
      });

      await logHistory(asset.id, 'created', null, { asset_code, name, status }, 'Asset dibuat', req.user?.id);

      res.status(201).json({ success: true, data: asset, message: 'Asset berhasil ditambahkan' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── PUT /api/assets/:id ──────────────────────────────────
  async update(req, res) {
    try {
      const asset = await Asset.findByPk(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });

      const oldData = {
        status: asset.status, customer_id: asset.customer_id,
        infrastructure_id: asset.infrastructure_id, location: asset.location
      };

      const updateData = { ...req.body };

      // Jika ada perubahan assignment
      const newCustomerId     = req.body.customer_id !== undefined ? req.body.customer_id : asset.customer_id;
      const newInfraId        = req.body.infrastructure_id !== undefined ? req.body.infrastructure_id : asset.infrastructure_id;
      const hasNewAssignment  = (newCustomerId && newCustomerId != asset.customer_id) ||
                                (newInfraId    && newInfraId    != asset.infrastructure_id);

      if (hasNewAssignment) {
        updateData.assigned_at = new Date();
        updateData.assigned_by = req.user?.id || null;
      }

      await asset.update(updateData);

      // Log perubahan status
      if (req.body.status && req.body.status !== oldData.status) {
        await logHistory(asset.id, 'status_change', { status: oldData.status }, { status: req.body.status }, null, req.user?.id);
      }
      // Log assignment baru
      if (hasNewAssignment) {
        await logHistory(asset.id, 'assigned',
          { customer_id: oldData.customer_id, infrastructure_id: oldData.infrastructure_id },
          { customer_id: newCustomerId, infrastructure_id: newInfraId },
          null, req.user?.id
        );
      } else {
        await logHistory(asset.id, 'updated', oldData, req.body, null, req.user?.id);
      }

      const updated = await Asset.findByPk(asset.id, { include: commonInclude });
      res.json({ success: true, data: updated, message: 'Asset berhasil diperbarui' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── DELETE /api/assets/:id ───────────────────────────────
  async destroy(req, res) {
    try {
      const asset = await Asset.findByPk(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });

      // Hapus foto jika ada
      if (asset.photo_url) {
        const filePath = path.join(__dirname, '../../frontend/public', asset.photo_url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await AssetHistory.destroy({ where: { asset_id: asset.id } });
      await asset.destroy();

      res.json({ success: true, message: 'Asset berhasil dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── POST /api/assets/:id/photo ───────────────────────────
  uploadPhoto(req, res) {
    uploadAssetPhoto.single('photo')(req, res, async (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      if (!req.file) return res.status(400).json({ success: false, message: 'Tidak ada file' });

      try {
        const asset = await Asset.findByPk(req.params.id);
        if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });

        // Hapus foto lama
        if (asset.photo_url) {
          const oldPath = path.join(__dirname, '../../frontend/public', asset.photo_url);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        const photo_url = '/uploads/assets/' + req.file.filename;
        await asset.update({ photo_url });
        await logHistory(asset.id, 'photo_updated', null, { photo_url }, 'Foto diperbarui', req.user?.id);

        res.json({ success: true, url: photo_url, message: 'Foto berhasil diupload' });
      } catch (e) {
        res.status(500).json({ success: false, message: e.message });
      }
    });
  }

  // ── GET /api/assets/:id/history ─────────────────────────
  async history(req, res) {
    try {
      const rows = await AssetHistory.findAll({
        where: { asset_id: req.params.id },
        include: [{ model: User, as: 'performer', attributes: ['id', 'name'], required: false }],
        order: [['created_at', 'DESC']],
        limit: 100
      });
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  // ── POST /api/assets/:id/assign ──────────────────────────
  async assign(req, res) {
    try {
      const asset = await Asset.findByPk(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });

      const { customer_id, infrastructure_id, ont_device_id, location, note } = req.body;

      const old = {
        customer_id: asset.customer_id,
        infrastructure_id: asset.infrastructure_id,
        location: asset.location
      };

      await asset.update({
        customer_id:       customer_id       || null,
        infrastructure_id: infrastructure_id || null,
        ont_device_id:     ont_device_id     || null,
        location:          location          || asset.location,
        status:            customer_id || infrastructure_id ? 'active' : 'storage',
        assigned_at:       new Date(),
        assigned_by:       req.user?.id || null
      });

      await logHistory(asset.id, 'assigned', old,
        { customer_id, infrastructure_id, location },
        note || null, req.user?.id
      );

      const updated = await Asset.findByPk(asset.id, { include: commonInclude });
      res.json({ success: true, data: updated, message: 'Asset berhasil di-assign' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── POST /api/assets/:id/unassign ────────────────────────
  async unassign(req, res) {
    try {
      const asset = await Asset.findByPk(req.params.id);
      if (!asset) return res.status(404).json({ success: false, message: 'Asset tidak ditemukan' });

      const old = {
        customer_id:       asset.customer_id,
        infrastructure_id: asset.infrastructure_id
      };

      await asset.update({
        customer_id:       null,
        infrastructure_id: null,
        ont_device_id:     null,
        status:            'storage',
        assigned_at:       null,
        assigned_by:       null
      });

      await logHistory(asset.id, 'unassigned', old, { customer_id: null, infrastructure_id: null },
        req.body.note || null, req.user?.id
      );

      res.json({ success: true, message: 'Asset berhasil di-unassign' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  // ── CATEGORIES ──────────────────────────────────────────
  async getCategories(req, res) {
    try {
      const rows = await AssetCategory.findAll({ order: [['name', 'ASC']] });
      res.json({ success: true, data: rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }

  async createCategory(req, res) {
    try {
      const { name, icon, description, color } = req.body;
      if (!name) return res.status(400).json({ success: false, message: 'Nama kategori wajib diisi' });
      const slug = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      const cat = await AssetCategory.create({ name, slug, icon: icon || 'device', description, color: color || '#3b82f6' });
      res.status(201).json({ success: true, data: cat });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  async updateCategory(req, res) {
    try {
      const cat = await AssetCategory.findByPk(req.params.id);
      if (!cat) return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
      if (req.body.name) req.body.slug = req.body.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      await cat.update(req.body);
      res.json({ success: true, data: cat });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  }

  async destroyCategory(req, res) {
    try {
      const cat = await AssetCategory.findByPk(req.params.id);
      if (!cat) return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
      const used = await Asset.count({ where: { category_id: cat.id } });
      if (used > 0) return res.status(400).json({ success: false, message: `Kategori masih digunakan oleh ${used} asset` });
      await cat.destroy();
      res.json({ success: true, message: 'Kategori dihapus' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = new AssetController();