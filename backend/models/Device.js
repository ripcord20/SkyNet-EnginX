const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Device = sequelize.define('Device', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    ip_address: {
      type: DataTypes.STRING(45),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('router', 'switch', 'olt', 'ont', 'access_point', 'server', 'other'),
      defaultValue: 'router'
    },
    brand: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    monitoring_type: {
      type: DataTypes.ENUM('snmp', 'api', 'both'),
      defaultValue: 'snmp'
    },
    snmp_community: {
      type: DataTypes.STRING(50),
      defaultValue: 'public'
    },
    snmp_version: {
      type: DataTypes.INTEGER,
      defaultValue: 2
    },
    snmp_port: {
      type: DataTypes.INTEGER,
      defaultValue: 161
    },
    api_port: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    api_username: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    api_password: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    // Pilih protokol MikroTik secara eksplisit, tidak tergantung port.
    // Penting untuk kasus port API custom (mis. /ip service set api port=8730).
    // null → fallback ke deteksi via port (backward-compat utk device lama).
    api_protocol: {
      type: DataTypes.ENUM('rest-http', 'rest-https', 'api-plain', 'api-ssl'),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('online', 'offline', 'warning', 'maintenance'),
      defaultValue: 'offline'
    },
    cpu_load: {
      type: DataTypes.FLOAT,
      defaultValue: 0
    },
    memory_usage: {
      type: DataTypes.FLOAT,
      defaultValue: 0
    },
    uptime: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    firmware: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    location: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true
    },
    poll_interval: {
      type: DataTypes.INTEGER,
      defaultValue: 60,
      comment: 'Poll interval in seconds'
    },
    last_polled: {
      type: DataTypes.DATE,
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    // FK ke infrastructure_points (type='pop'). Boleh null untuk device
    // yang tidak terkait dengan POP tertentu (mis. router pelanggan, dll).
    pop_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'infrastructure_points', key: 'id' }
    }
  }, {
    tableName: 'devices',
    timestamps: true,
    indexes: [
      { fields: ['ip_address'] },
      { fields: ['status'] },
      { fields: ['type'] },
      { fields: ['pop_id'] }
    ]
  });

  return Device;
};
