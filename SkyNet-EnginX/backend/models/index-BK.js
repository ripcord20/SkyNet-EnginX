const { Sequelize } = require('sequelize');
const dbConfig = require('../config/database');

const env = process.env.APP_ENV || 'development';
const config = dbConfig[env];

const sequelize = new Sequelize(
  config.database,
  config.username,
  config.password,
  {
    host: config.host,
    port: config.port,
    dialect: config.dialect,
    logging: config.logging,
    pool: config.pool,
    define: config.define,
    dialectOptions: config.dialectOptions || {}
  }
);

// Disable ONLY_FULL_GROUP_BY di setiap koneksi baru dari pool
sequelize.afterConnect(async (connection) => {
  return new Promise((resolve, reject) => {
    connection.query(
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
      (err) => { if (err) reject(err); else resolve(); }
    );
  });
});

// Import Models
const User = require('./User')(sequelize);
const Role = require('./Role')(sequelize);
const Permission = require('./Permission')(sequelize);
const RolePermission = require('./RolePermission')(sequelize);
const Customer = require('./Customer')(sequelize);
const CustomerPushSubscription = require('./CustomerPushSubscription')(sequelize);
const Package = require('./Package')(sequelize);
const Invoice = require('./Invoice')(sequelize);
const Payment = require('./Payment')(sequelize);
const Device = require('./Device')(sequelize);
const DeviceLog = require('./DeviceLog')(sequelize);
const InfrastructurePoint = require('./InfrastructurePoint')(sequelize);
const InfrastructureLink  = require('./InfrastructureLink')(sequelize);
const OntDevice = require('./OntDevice')(sequelize);
const FinancialReport = require('./FinancialReport')(sequelize);
const ActivityLog = require('./ActivityLog')(sequelize);
const Notification = require('./Notification')(sequelize);
const TrafficData = require('./TrafficData')(sequelize);

// Queue History
const QueueHistory = require('./QueueHistory')(sequelize);

// WA Gateway models
const WaSession   = require('./WaSession')(sequelize);
const WaMessage   = require('./WaMessage')(sequelize);
const WaAutoReply = require('./WaAutoReply')(sequelize);
const WaTemplate      = require('./WaTemplate')(sequelize);
const WaBroadcast     = require('./WaBroadcast')(sequelize);
const WaLog          = require('./WaLog')(sequelize);
const WaIncoming     = require('./WaIncoming')(sequelize);
const ReminderSetting = require('./ReminderSetting')(sequelize);
const AppSetting      = require('./AppSetting')(sequelize);
const Announcement    = require('./Announcement')(sequelize);
const Keuangan        = require('./Keuangan')(sequelize);

// Asset Management
const Asset           = require('./Asset')(sequelize);
const AssetCategory   = require('./AssetCategory')(sequelize);
const AssetHistory    = require('./AssetHistory')(sequelize);
const Ticket          = require('./Ticket')(sequelize);
const TicketTimeline  = require('./TicketTimeline')(sequelize);
const Todo            = require('./Todo')(sequelize);
const WorkOrder       = require('./WorkOrder')(sequelize);

// GPS Tracking
const TechnicianLocation = require('./TechnicianLocation')(sequelize);
const TrackingSession    = require('./TrackingSession')(sequelize);

// Push Notification (admin broadcast)
const PushTemplate     = require('./PushTemplate')(sequelize);
const PushNotification = require('./PushNotification')(sequelize);

// NOC monitor preset — saved bandwidth-monitor card per user
const NocMonitorPreset = require('./NocMonitorPreset')(sequelize);
 

// ===== ASSOCIATIONS =====
// InfrastructureLink associations
InfrastructureLink.belongsTo(InfrastructurePoint, { foreignKey: 'from_point_id', as: 'fromPoint' });
InfrastructureLink.belongsTo(InfrastructurePoint, { foreignKey: 'to_point_id',   as: 'toPoint'   });
InfrastructurePoint.hasMany(InfrastructureLink,   { foreignKey: 'from_point_id', as: 'linksFrom' });
InfrastructurePoint.hasMany(InfrastructureLink,   { foreignKey: 'to_point_id',   as: 'linksTo'   });

// Keuangan <-> User
User.hasMany(Keuangan, { foreignKey: 'recorded_by', as: 'keuangan_records' });
Keuangan.belongsTo(User, { foreignKey: 'recorded_by', as: 'recorder' });

// ===== ASSET MANAGEMENT =====
// Asset <-> AssetCategory
AssetCategory.hasMany(Asset, { foreignKey: 'category_id', as: 'assets' });
Asset.belongsTo(AssetCategory, { foreignKey: 'category_id', as: 'category' });

// Asset <-> Customer
Customer.hasMany(Asset, { foreignKey: 'customer_id', as: 'assets' });
Asset.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

// Asset <-> InfrastructurePoint
InfrastructurePoint.hasMany(Asset, { foreignKey: 'infrastructure_id', as: 'assets' });
Asset.belongsTo(InfrastructurePoint, { foreignKey: 'infrastructure_id', as: 'infrastructure' });

// Asset <-> OntDevice
OntDevice.hasOne(Asset, { foreignKey: 'ont_device_id', as: 'asset' });
Asset.belongsTo(OntDevice, { foreignKey: 'ont_device_id', as: 'ont_device' });

// Asset <-> User (assigned_by)
User.hasMany(Asset, { foreignKey: 'assigned_by', as: 'assigned_assets' });
Asset.belongsTo(User, { foreignKey: 'assigned_by', as: 'assigner' });

// AssetHistory <-> Asset
Asset.hasMany(AssetHistory, { foreignKey: 'asset_id', as: 'history' });
AssetHistory.belongsTo(Asset, { foreignKey: 'asset_id', as: 'asset' });

// AssetHistory <-> User
User.hasMany(AssetHistory, { foreignKey: 'performed_by', as: 'asset_history' });
AssetHistory.belongsTo(User, { foreignKey: 'performed_by', as: 'performer' });


// User <-> Role
Role.hasMany(User, { foreignKey: 'role_id', as: 'users' });
User.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

// Role <-> Permission (Many-to-Many)
Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id', as: 'permissions' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id', as: 'roles' });

// Customer <-> Package
Package.hasMany(Customer, { foreignKey: 'package_id', as: 'customers' });
Customer.belongsTo(Package, { foreignKey: 'package_id', as: 'package' });

// Customer <-> Invoice
Customer.hasMany(Invoice, { foreignKey: 'customer_id', as: 'invoices' });
Invoice.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

// Invoice <-> Payment
Invoice.hasMany(Payment, { foreignKey: 'invoice_id', as: 'payments' });
Payment.belongsTo(Invoice, { foreignKey: 'invoice_id', as: 'invoice' });

// Payment <-> User (recorded by)
User.hasMany(Payment, { foreignKey: 'recorded_by', as: 'recorded_payments' });
Payment.belongsTo(User, { foreignKey: 'recorded_by', as: 'recorder' });

// Device <-> DeviceLog
Device.hasMany(DeviceLog, { foreignKey: 'device_id', as: 'logs' });
DeviceLog.belongsTo(Device, { foreignKey: 'device_id', as: 'device' });

// Device <-> TrafficData
Device.hasMany(TrafficData, { foreignKey: 'device_id', as: 'traffic_data' });
TrafficData.belongsTo(Device, { foreignKey: 'device_id', as: 'device' });

// Customer <-> OntDevice
Customer.hasOne(OntDevice, { foreignKey: 'customer_id', as: 'ont_device' });
OntDevice.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

// ActivityLog <-> User
User.hasMany(ActivityLog, { foreignKey: 'user_id', as: 'activity_logs' });
ActivityLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Notification <-> User
User.hasMany(Notification, { foreignKey: 'user_id', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Customer <-> WaMessage
Customer.hasMany(WaMessage, { foreignKey: 'customer_id', as: 'wa_messages' });
WaMessage.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

const db = {
  sequelize,
  Sequelize,
  User,
  Role,
  Permission,
  RolePermission,
  Customer,
  CustomerPushSubscription,
  Package,
  Invoice,
  Payment,
  Device,
  DeviceLog,
  InfrastructurePoint,
  InfrastructureLink,
  OntDevice,
  FinancialReport,
  ActivityLog,
  Notification,
  TrafficData,
  WaSession,
  WaMessage,
  WaAutoReply,
  WaTemplate,
  WaBroadcast,
  WaLog,
  WaIncoming,
  ReminderSetting,
  AppSetting,
  Announcement,
  Keuangan,
  QueueHistory,
  Asset,
  AssetCategory,
  AssetHistory,
  Ticket,
  TicketTimeline,
  Todo,
  WorkOrder,
  TechnicianLocation,
  TrackingSession,
  PushTemplate,
  PushNotification,
  NocMonitorPreset
};

// ── Todo associations
Todo.belongsTo(User, { foreignKey: 'assigned_to', as: 'assignee' });
Todo.belongsTo(User, { foreignKey: 'created_by',  as: 'creator'  });
User.hasMany(Todo,   { foreignKey: 'assigned_to', as: 'assigned_todos' });

// ── WorkOrder associations
WorkOrder.belongsTo(Customer, { foreignKey: 'customer_id',      as: 'customer'     });
WorkOrder.belongsTo(Ticket,   { foreignKey: 'ticket_id',        as: 'ticket'       });
WorkOrder.belongsTo(User,     { foreignKey: 'assigned_user_id', as: 'assignedUser' });
WorkOrder.belongsTo(User,     { foreignKey: 'created_by',       as: 'creator'      });
Customer.hasMany(WorkOrder,   { foreignKey: 'customer_id',      as: 'work_orders'  });
Ticket.hasMany(WorkOrder,     { foreignKey: 'ticket_id',        as: 'work_orders'  });

// ── Ticket associations ───────────────────────────────────────
Ticket.belongsTo(Customer,            { foreignKey: 'customer_id',    as: 'customer'   });
Ticket.belongsTo(InfrastructurePoint, { foreignKey: 'infra_point_id', as: 'infraPoint' });
Ticket.belongsTo(User,                { foreignKey: 'assigned_to',    as: 'assignee'   });
Ticket.belongsTo(User,                { foreignKey: 'created_by',     as: 'creator'    });
Ticket.hasMany(TicketTimeline,        { foreignKey: 'ticket_id',      as: 'timelines'  });
TicketTimeline.belongsTo(Ticket,      { foreignKey: 'ticket_id',      as: 'ticket'     });
TicketTimeline.belongsTo(User,        { foreignKey: 'user_id',        as: 'user'       });
Customer.hasMany(Ticket,              { foreignKey: 'customer_id',    as: 'tickets'    });
// Customer <-> Push Subscriptions
Customer.hasMany(CustomerPushSubscription, { foreignKey: 'customer_id', as: 'push_subscriptions' });
CustomerPushSubscription.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });

// ── GPS Tracking associations ─────────────────────────────────
TechnicianLocation.belongsTo(User,   { foreignKey: 'technician_id', as: 'technician' });
TechnicianLocation.belongsTo(Ticket, { foreignKey: 'ticket_id',     as: 'ticket'     });
User.hasMany(TechnicianLocation,     { foreignKey: 'technician_id', as: 'locations'  });
Ticket.hasMany(TechnicianLocation,   { foreignKey: 'ticket_id',     as: 'technician_locations' });
 
TrackingSession.belongsTo(User,   { foreignKey: 'technician_id', as: 'technician' });
TrackingSession.belongsTo(Ticket, { foreignKey: 'ticket_id',     as: 'ticket'     });
User.hasMany(TrackingSession,     { foreignKey: 'technician_id', as: 'tracking_sessions' });
Ticket.hasMany(TrackingSession,   { foreignKey: 'ticket_id',     as: 'tracking_sessions' });

// ── Push Notification associations ────────────────────────────
PushNotification.belongsTo(User,         { foreignKey: 'created_by',  as: 'creator'  });
PushNotification.belongsTo(PushTemplate, { foreignKey: 'template_id', as: 'template' });
PushTemplate.hasMany(PushNotification,   { foreignKey: 'template_id', as: 'notifications' });
User.hasMany(PushNotification,           { foreignKey: 'created_by',  as: 'push_notifications_created' });
User.hasMany(PushTemplate,               { foreignKey: 'created_by',  as: 'push_templates_created' });
PushTemplate.belongsTo(User,             { foreignKey: 'created_by',  as: 'creator' });

// ── NOC Monitor Preset associations ───────────────────────────
NocMonitorPreset.belongsTo(User,   { foreignKey: 'user_id',   as: 'user'   });
NocMonitorPreset.belongsTo(Device, { foreignKey: 'router_id', as: 'router' });
User.hasMany(NocMonitorPreset,     { foreignKey: 'user_id',   as: 'noc_monitor_presets' });

module.exports = db;