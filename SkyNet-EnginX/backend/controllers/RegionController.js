const { Province, Regency, District, Village } = require('../models');

/**
 * Endpoint data wilayah Indonesia dari database sendiri.
 * Bentuk respons mengikuti emsifa: array of { id, name } — supaya frontend
 * (dropdown alamat berjenjang) tidak perlu banyak diubah.
 */
class RegionController {
  // GET /api/regions/provinces
  async provinces(req, res) {
    try {
      const rows = await Province.findAll({ order: [['name', 'ASC']], attributes: ['id', 'name'] });
      res.json(rows);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // GET /api/regions/regencies/:provinceId
  async regencies(req, res) {
    try {
      const rows = await Regency.findAll({
        where: { province_id: String(req.params.provinceId) },
        order: [['name', 'ASC']], attributes: ['id', 'name'],
      });
      res.json(rows);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // GET /api/regions/districts/:regencyId
  async districts(req, res) {
    try {
      const rows = await District.findAll({
        where: { regency_id: String(req.params.regencyId) },
        order: [['name', 'ASC']], attributes: ['id', 'name'],
      });
      res.json(rows);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // GET /api/regions/villages/:districtId
  async villages(req, res) {
    try {
      const rows = await Village.findAll({
        where: { district_id: String(req.params.districtId) },
        order: [['name', 'ASC']], attributes: ['id', 'name'],
      });
      res.json(rows);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }
}

module.exports = new RegionController();
