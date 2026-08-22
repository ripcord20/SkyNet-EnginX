const { InfrastructureLink, InfrastructurePoint, Customer } = require('../models');
const { Op } = require('sequelize');

const pointAttrs = ['id','name','type','latitude','longitude','status','parent_id','metadata'];

// Ranking hierarki: angka lebih kecil = lebih "atas" di topologi.
// Saat link dibuat antara 2 titik, yang rank lebih kecil = parent.
//   POP   → root (paling atas)
//   ODC   → di bawah POP, bisa chain ke ODC lain
//   ODP   → di bawah ODC
//   Tower → support fisik (tidak hierarkis untuk customer)
//   Customer → leaf (paling bawah)
const TYPE_RANK = { pop: 1, odc: 2, odp: 3, tower: 4, customer: 5 };

/**
 * Tentukan pasangan (parent, child) dari 2 titik berdasarkan tipe.
 * Return null kalau tidak bisa ditentukan secara otomatis (rank sama, atau salah satu tower).
 *
 * Aturan:
 *   - Rank beda → yang rank kecil = parent, yang rank besar = child
 *   - Rank sama (mis. ODC↔ODC, ODP↔ODP) → null (peer link, user set manual)
 *   - Tower terlibat → null (tower itu support fisik, bukan hierarki struktural)
 */
function resolveParentChild(ptA, ptB) {
  if (!ptA || !ptB) return null;
  const tA = String(ptA.type || '').toLowerCase();
  const tB = String(ptB.type || '').toLowerCase();
  if (tA === 'tower' || tB === 'tower') return null;
  const rA = TYPE_RANK[tA];
  const rB = TYPE_RANK[tB];
  if (rA == null || rB == null) return null;
  if (rA === rB) return null;
  return rA < rB ? { parent: ptA, child: ptB } : { parent: ptB, child: ptA };
}

class InfrastructureLinkController {

  // GET /api/infrastructure-links
  async index(req, res) {
    try {
      const links = await InfrastructureLink.findAll({
        include: [
          { model: InfrastructurePoint, as: 'fromPoint', attributes: pointAttrs },
          { model: InfrastructurePoint, as: 'toPoint',   attributes: pointAttrs }
        ],
        order: [['created_at','DESC']]
      });
      res.json({ success: true, data: links });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // POST /api/infrastructure-links
  async create(req, res) {
    try {
      const { from_point_id, to_point_id, link_type, status, name, notes, distance_m, waypoints } = req.body;
      if (!from_point_id || !to_point_id)
        return res.status(400).json({ success: false, message: 'from_point_id and to_point_id required' });

      // Auto-generate name if not given
      const autoName = name || `LINK-${from_point_id}-${to_point_id}`;
      const link = await InfrastructureLink.create({
        name: autoName, from_point_id, to_point_id,
        link_type:  link_type  || 'fiber',
        status:     status     || 'active',
        notes,      distance_m,
        waypoints:  waypoints  || null
      });

      // ── Auto-set parent_id berdasarkan hierarki tipe titik ──
      // User tidak perlu pilih parent manual saat tambah ODP/ODC/customer.
      // Sistem deteksi otomatis dari arah link:
      //   ODP ↔ ODC  → ODC jadi parent ODP
      //   ODC ↔ POP  → POP jadi parent ODC
      //   ODC ↔ ODC  → tidak otomatis (peer link, ambigu)
      //   Tower libat → tidak otomatis (tower bukan hierarki struktural)
      //   Customer ↔ ODP → ODP jadi parent customer point
      let autoParentInfo = null;
      try {
        const [ptFrom, ptTo] = await Promise.all([
          InfrastructurePoint.findByPk(from_point_id),
          InfrastructurePoint.findByPk(to_point_id),
        ]);
        const resolved = resolveParentChild(ptFrom, ptTo);
        if (resolved) {
          const { parent, child } = resolved;
          // Hanya update kalau child belum punya parent ATAU parent-nya beda
          // dari yang baru di-link. Jangan tiba-tiba ubah parent existing kalau
          // user sengaja sudah set sebelumnya.
          if (!child.parent_id || Number(child.parent_id) !== Number(parent.id)) {
            const oldParentId = child.parent_id;
            await child.update({ parent_id: parent.id });

            // Untuk titik customer, juga sinkronkan customer.infra_parent_id
            // supaya konsisten dua arah (form customer & form infra sama-sama
            // tahu parent terbaru).
            if (String(child.type).toLowerCase() === 'customer' && child.metadata) {
              let meta = child.metadata;
              if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch (_) { meta = null; }
              }
              if (meta && meta.customer_id) {
                try {
                  const customer = await Customer.findByPk(meta.customer_id);
                  if (customer) await customer.update({ infra_parent_id: parent.id });
                } catch (e) { /* best-effort, jangan block link create */ }
              }
            }

            autoParentInfo = {
              child_id:   child.id,
              child_name: child.name,
              child_type: child.type,
              parent_id:  parent.id,
              parent_name: parent.name,
              parent_type: parent.type,
              was_changed: oldParentId != null && Number(oldParentId) !== Number(parent.id),
              old_parent_id: oldParentId,
            };
          }
        }
      } catch (e) {
        // Auto-parent gagal — link tetap di-create, hanya parent_id tidak ter-update.
        // Log agar bisa di-debug, tapi tidak return error ke client.
        require('../utils/logger').warn(`[Link create] auto-parent gagal: ${e.message}`);
      }

      const full = await InfrastructureLink.findByPk(link.id, {
        include: [
          { model: InfrastructurePoint, as: 'fromPoint', attributes: pointAttrs },
          { model: InfrastructurePoint, as: 'toPoint',   attributes: pointAttrs }
        ]
      });
      res.status(201).json({ success: true, data: full, auto_parent: autoParentInfo });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }

  // DELETE /api/infrastructure-links/:id
  async destroy(req, res) {
    try {
      const link = await InfrastructureLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({ success: false, message: 'Link not found' });
      await link.destroy();
      res.json({ success: true, message: 'Link deleted' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  }

  // PUT /api/infrastructure-links/:id
  async update(req, res) {
    try {
      const link = await InfrastructureLink.findByPk(req.params.id);
      if (!link) return res.status(404).json({ success: false, message: 'Link not found' });
      await link.update(req.body);
      res.json({ success: true, data: link });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
  }
}

module.exports = new InfrastructureLinkController();