const { ActivityLog } = require('../models');
const { sequelize } = require('../models');

// Map module → table name + columns yang relevan untuk snapshot
// Pakai raw query supaya tidak harus require model satu-satu (avoid circular deps).
const MODULE_TABLES = {
  customer:         { table: 'customers',          nameCol: 'name',          extraCols: ['customer_id', 'pppoe_username', 'phone'] },
  device:           { table: 'devices',            nameCol: 'name',          extraCols: ['ip_address', 'device_type'] },
  infrastructure:   { table: 'infrastructure_points', nameCol: 'name',       extraCols: ['type', 'address'] },
  package:          { table: 'packages',           nameCol: 'name',          extraCols: ['speed_down', 'speed_up', 'price'] },
  payment:          { table: 'payments',           nameCol: 'invoice_no',    extraCols: ['amount', 'method'] },
  invoice:          { table: 'invoices',           nameCol: 'invoice_no',    extraCols: ['total', 'status', 'due_date'] },
  user:             { table: 'users',              nameCol: 'name',          extraCols: ['email', 'role_id'] },
  role:             { table: 'roles',              nameCol: 'name',          extraCols: ['description'] },
  asset:            { table: 'assets',             nameCol: 'name',          extraCols: ['type', 'serial_number'] },
  push_notif:       { table: 'push_notifications', nameCol: 'title',         extraCols: ['body'] },
  broadcast:        { table: 'broadcasts',         nameCol: 'name',          extraCols: ['template_id', 'status'] },
};

/**
 * Fetch snapshot of entity from DB. Used to capture state BEFORE delete/update.
 * Returns null kalau table tidak terdaftar, ID kosong, atau row tidak ditemukan.
 */
async function fetchEntitySnapshot(module, id) {
  if (!id) return null;
  const cfg = MODULE_TABLES[module];
  if (!cfg) return null;
  try {
    const cols = ['id', cfg.nameCol, ...cfg.extraCols].filter(Boolean);
    const colsStr = cols.map(c => `\`${c}\``).join(',');
    const [rows] = await sequelize.query(
      `SELECT ${colsStr} FROM \`${cfg.table}\` WHERE id = :id LIMIT 1`,
      { replacements: { id } }
    );
    return rows[0] || null;
  } catch (e) {
    console.error(`fetchEntitySnapshot error for ${module}#${id}:`, e.message);
    return null;
  }
}

/**
 * Build a human-readable description for the log.
 * Examples:
 *   "Hapus customer Dani (CID001)"
 *   "Update package Internet 50Mbps"
 *   "Buat device MikroTik Kamar"
 */
function buildDescription(action, module, snapshot) {
  const actionLabels = {
    create:      'Buat',
    update:      'Update',
    delete:      'Hapus',
    import:      'Import',
    generate:    'Generate',
    reset:       'Reset',
    sync:        'Sync',
    reboot:      'Reboot',
    assign:      'Assign',
    unassign:    'Unassign',
    recalculate: 'Recalculate',
  };
  const actLabel = actionLabels[action] || action;

  if (!snapshot) return `${actLabel} on ${module}`;

  const cfg = MODULE_TABLES[module];
  const name = cfg ? snapshot[cfg.nameCol] : null;

  // Tambahan identifier kalau ada
  let identifier = '';
  if (module === 'customer' && snapshot.customer_id)  identifier = ` (${snapshot.customer_id})`;
  else if (module === 'invoice' && snapshot.invoice_no) identifier = ` (${snapshot.invoice_no})`;
  else if (module === 'device' && snapshot.ip_address)  identifier = ` (${snapshot.ip_address})`;
  else if (snapshot.id)                                 identifier = ` (#${snapshot.id})`;

  return name ? `${actLabel} ${module} ${name}${identifier}` : `${actLabel} ${module}${identifier}`;
}

/**
 * Activity logger middleware factory.
 *
 * @param {string} action  e.g. 'create', 'update', 'delete'
 * @param {string} module  e.g. 'customer', 'device'
 *
 * For DELETE/UPDATE actions: fetch entity snapshot BEFORE the actual handler
 * runs (supaya data masih ada saat delete dilakukan). Snapshot disimpan ke
 * `old_data`. Saat response 2xx datang, snapshot dipakai untuk build
 * descriptive description.
 */
const logActivity = (action, module) => {
  return async (req, res, next) => {
    let oldSnapshot = null;

    // Untuk delete & update: capture entity state SEBELUM handler jalan
    if ((action === 'delete' || action === 'update' || action === 'reset' ||
         action === 'reboot' || action === 'sync')
        && req.params.id) {
      oldSnapshot = await fetchEntitySnapshot(module, req.params.id);
    }

    // Hook res.json untuk capture response data juga
    const originalJson = res.json.bind(res);
    res.json = function (data) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Determine target_id
        const targetId = req.params.id
          || data?.data?.id
          || data?.id
          || null;

        // newSnapshot: untuk create, ambil dari response. Untuk update,
        // fetch ulang dari DB (state baru setelah update).
        let newSnapshot = null;
        let descPromise = Promise.resolve(buildDescription(action, module, oldSnapshot));

        if (action === 'create' && data?.data) {
          newSnapshot = (typeof data.data === 'object') ? data.data : null;
          descPromise = Promise.resolve(buildDescription(action, module, newSnapshot));
        } else if (action === 'update' && targetId) {
          // Fetch updated state untuk new_data + build deskripsi pakai data baru
          descPromise = fetchEntitySnapshot(module, targetId).then(snap => {
            newSnapshot = snap;
            return buildDescription(action, module, snap || oldSnapshot);
          });
        }

        descPromise.then(description => {
          ActivityLog.create({
            user_id:     req.user?.id || null,
            action,
            module,
            description,
            target_type: module,
            target_id:   targetId,
            old_data:    oldSnapshot,
            new_data:    newSnapshot,
            ip_address:  req.ip,
            user_agent:  req.get('User-Agent'),
          }).catch(err => {
            console.error('Activity log error:', err.message);
          });
        });
      }
      return originalJson(data);
    };

    next();
  };
};

/**
 * Direct audit logger for OLT operations (tidak lewat middleware/snapshot DB).
 *
 * Operasi OLT menyasar ONU fisik di perangkat, bukan baris DB — jadi tak ada
 * snapshot tabel. Helper ini menulis langsung ke `activity_logs` yang SAMA
 * dengan audit lain, supaya muncul di riwayat audit yang sama.
 *
 * @param {object} req     Express request (untuk user_id, ip, user-agent)
 * @param {object} opts
 * @param {string} opts.action       e.g. 'delete', 'reboot', 'reset', 'update'
 * @param {string} opts.description   teks siap-baca, mis. "Reboot ONU gpon-onu_1/2/1:1 (OLT 157.20.130.42)"
 * @param {string} [opts.target]      identitas target, mis. "gpon-onu_1/2/1:1"
 * @param {number} [opts.oltId]       id OLT
 * @param {object} [opts.meta]        data tambahan (disimpan di new_data)
 */
async function logOltAction(req, { action, description, target = null, oltId = null, meta = null } = {}) {
  try {
    await ActivityLog.create({
      user_id:     req?.user?.id || null,
      action,
      module:      'olt',
      description,
      target_type: 'onu',
      target_id:   null,            // ONU bukan baris DB → simpan identitas di new_data
      old_data:    null,
      new_data:    { target, olt_id: oltId, ...(meta || {}) },
      ip_address:  req?.ip || null,
      user_agent:  req?.get ? req.get('User-Agent') : null,
    });
  } catch (err) {
    // Audit gagal TIDAK boleh menggagalkan operasi utama.
    console.error('OLT audit log error:', err.message);
  }
}

module.exports = { logActivity, fetchEntitySnapshot, buildDescription, logOltAction };
