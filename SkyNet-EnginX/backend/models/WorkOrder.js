const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const WorkOrder = sequelize.define('WorkOrder', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },

    wo_number: {
      type: DataTypes.STRING(25),
      unique: true,
      comment: 'Auto-generated: WO-YYMMDD-XXXX'
    },

    type: {
      type: DataTypes.ENUM('installation','maintenance','dismantle','survey','repair','other'),
      defaultValue: 'installation',
      allowNull: false
    },

    status: {
      type: DataTypes.ENUM('pending','assigned','in_progress','done','cancelled'),
      defaultValue: 'pending',
      allowNull: false
    },

    priority: {
      type: DataTypes.ENUM('low','medium','high','critical'),
      defaultValue: 'medium'
    },

    title:       { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },

    // Relasi ke customer & ticket (opsional)
    customer_id: {
      type: DataTypes.INTEGER.UNSIGNED, allowNull: true,
      references: { model: 'customers', key: 'id' }
    },
    ticket_id: {
      type: DataTypes.INTEGER.UNSIGNED, allowNull: true,
      references: { model: 'tickets', key: 'id' }
    },

    // Teknisi: bisa user sistem ATAU nama manual
    assigned_user_id:  { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    technician_name:   { type: DataTypes.STRING(150), allowNull: true, comment: 'Nama teknisi manual jika bukan user sistem' },
    technician_phone:  { type: DataTypes.STRING(20),  allowNull: true },

    // Jadwal
    scheduled_date: { type: DataTypes.DATEONLY, allowNull: true },
    scheduled_time: { type: DataTypes.TIME,     allowNull: true },
    due_date:       { type: DataTypes.DATEONLY, allowNull: true },
    started_at:     { type: DataTypes.DATE,     allowNull: true },
    completed_at:   { type: DataTypes.DATE,     allowNull: true },

    // Lokasi
    location_address: { type: DataTypes.TEXT,           allowNull: true },
    latitude:         { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    longitude:        { type: DataTypes.DECIMAL(11, 8), allowNull: true },

    // Catatan & hasil
    notes:            { type: DataTypes.TEXT, allowNull: true },
    completion_notes: { type: DataTypes.TEXT, allowNull: true, comment: 'Laporan hasil pekerjaan' },

    // Foto bukti (JSON array of {url, caption, uploaded_at})
    photos: { type: DataTypes.JSON, defaultValue: [] },

    // Siapa yang buat
    created_by: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true }

  }, {
    tableName: 'work_orders',
    timestamps: true,
    underscored: true,
    hooks: {
      beforeCreate: async (wo) => {
        if (!wo.wo_number) {
          const d = new Date();
          const yy = String(d.getFullYear()).slice(-2);
          const mm = String(d.getMonth()+1).padStart(2,'0');
          const dd = String(d.getDate()).padStart(2,'0');
          const count = await sequelize.models.WorkOrder
            .count({ where: sequelize.literal(`DATE(created_at) = CURDATE()`) })
            .catch(() => 0);
          wo.wo_number = `WO-${yy}${mm}${dd}-${String(count+1).padStart(4,'0')}`;
        }
      }
    }
  });

  return WorkOrder;
};
