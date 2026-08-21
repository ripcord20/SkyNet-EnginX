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

// Data wilayah Indonesia (mandiri di server sendiri)
const { Province, Regency, District, Village } = require('./Region')(sequelize);

// Queue History
const QueueHistory = require('./QueueHistory')(sequelize);

// WA Gateway models
const WaSession   = require('./WaSession')(sequelize);
const WaMessage   = require('./WaMessage')(sequelize);
const WaAutoReply = require('./WaAutoReply')(sequelize);
const WaTemplate      = require('./WaTemplate')(sequelize);
const WaBroadcast     = require('./WaBroadcast')(sequelize);
const EmailBroadcast  = require('./EmailBroadcast')(sequelize);
const EmailLog        = require('./EmailLog')(sequelize);
const WaLog          = require('./WaLog')(sequelize);
const WaIncoming     = require('./WaIncoming')(sequelize);
const ReminderSetting = require('./ReminderSetting')(sequelize);
const ReminderLog = require('./ReminderLog')(sequelize);
const ReportLog = require('./ReportLog')(sequelize);
const MonitorState = require('./MonitorState')(sequelize);
const NotifLog = require('./NotifLog')(sequelize);
const BotCommand = require('./BotCommand')(sequelize);
const AppSetting      = require('./AppSetting')(sequelize);
const Announcement    = require('./Announcement')(sequelize);
const Keuangan        = require('./Keuangan')(sequelize);
const RecurringExpense = require('./RecurringExpense')(sequelize);

// Asset Management
const Asset           = require('./Asset')(sequelize);
const AssetCategory   = require('./AssetCategory')(sequelize);
const AssetHistory    = require('./AssetHistory')(sequelize);
const Ticket          = require('./Ticket')(sequelize);
const TicketTimeline  = require('./TicketTimeline')(sequelize);
const Todo            = require('./Todo')(sequelize);

// ── Bulk Provisioning PPPoE ──────────────────────────────────
const PppoeProvisionJob  = require('./PppoeProvisionJob')(sequelize);
const PppoeProvisionItem = require('./PppoeProvisionItem')(sequelize);

// ── HRIS module — karyawan, absensi, shift, jadwal, payroll ──
const Employee         = require('./Employee')(sequelize);
const HrisShift        = require('./HrisShift')(sequelize);
const HrisWorkLocation = require('./HrisWorkLocation')(sequelize);
const HrisSchedule     = require('./HrisSchedule')(sequelize);
const HrisAttendance   = require('./HrisAttendance')(sequelize);
const HrisLeaveRequest = require('./HrisLeaveRequest')(sequelize);
const HrisPayroll      = require('./HrisPayroll')(sequelize);
const HrisPayrollItem  = require('./HrisPayrollItem')(sequelize);
const WorkOrder       = require('./WorkOrder')(sequelize);

// GPS Tracking
const TechnicianLocation = require('./TechnicianLocation')(sequelize);
const TrackingSession    = require('./TrackingSession')(sequelize);

// Push Notification (admin broadcast)
const PushTemplate     = require('./PushTemplate')(sequelize);
const PushNotification = require('./PushNotification')(sequelize);

// NOC monitor preset — saved bandwidth-monitor card per user
const NocMonitorPreset = require('./NocMonitorPreset')(sequelize);
const NmsInterfacePreset = require('./NmsInterfacePreset')(sequelize);

// Sales module — profil sales, registrasi pelanggan, komisi
const SalesProfile        = require('./SalesProfile')(sequelize);
const RegistrationRequest = require('./RegistrationRequest')(sequelize);
const SalesCommission     = require('./SalesCommission')(sequelize);

// Field Collection module — penagihan lapangan oleh kolektor
const CollectorProfile      = require('./CollectorProfile')(sequelize);
const CollectionAssignment  = require('./CollectionAssignment')(sequelize);
const CollectionAssignmentLog = require('./CollectionAssignmentLog')(sequelize);
const CommissionPayment       = require('./CommissionPayment')(sequelize);
const CashDeposit           = require('./CashDeposit')(sequelize);

// Reseller Voucher Hotspot — akun reseller, paket, ledger saldo
const Reseller                = require('./Reseller')(sequelize);
const ResellerVoucherPackage  = require('./ResellerVoucherPackage')(sequelize);
const ResellerTransaction     = require('./ResellerTransaction')(sequelize);
const ResellerTopup           = require('./ResellerTopup')(sequelize);
const ResellerPackagePrice    = require('./ResellerPackagePrice')(sequelize);
const ResellerVoucherLog      = require('./ResellerVoucherLog')(sequelize);
const ResellerPromo           = require('./ResellerPromo')(sequelize);
const ResellerPromoRedemption = require('./ResellerPromoRedemption')(sequelize);
const PublicVoucherOrder      = require('./PublicVoucherOrder')(sequelize);

// ── RADIUS module — AAA terpusat (NAS clients, users, accounting) ────
const RadiusNasClient  = require('./RadiusNasClient')(sequelize);
const RadiusUser       = require('./RadiusUser')(sequelize);
const RadiusAccounting = require('./RadiusAccounting')(sequelize);
const NasPortForward   = require('./NasPortForward')(sequelize);

// ── WireGuard module — VPN interface & peer management ───────────────
const WireguardServer = require('./WireguardServer')(sequelize);
const WireguardPeer   = require('./WireguardPeer')(sequelize);

// ===== ASSOCIATIONS =====
// InfrastructureLink associations
InfrastructureLink.belongsTo(InfrastructurePoint, { foreignKey: 'from_point_id', as: 'fromPoint' });
InfrastructureLink.belongsTo(InfrastructurePoint, { foreignKey: 'to_point_id',   as: 'toPoint'   });
InfrastructurePoint.hasMany(InfrastructureLink,   { foreignKey: 'from_point_id', as: 'linksFrom' });
InfrastructurePoint.hasMany(InfrastructureLink,   { foreignKey: 'to_point_id',   as: 'linksTo'   });

// Keuangan <-> User
User.hasMany(Keuangan, { foreignKey: 'recorded_by', as: 'keuangan_records' });
Keuangan.belongsTo(User, { foreignKey: 'recorded_by', as: 'recorder' });
RecurringExpense.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

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

// Customer <-> Device (router MikroTik untuk PPPoE isolir)
// Asosiasi ini opsional — customer.mikrotik_id boleh NULL (tidak semua
// customer terhubung ke router tertentu). Alias 'mikrotik' dipakai agar
// query yang include router pakai semantic "Customer.mikrotik".
Customer.belongsTo(Device, { foreignKey: 'mikrotik_id', as: 'mikrotik' });

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
  Province,
  Regency,
  District,
  Village,
  WaSession,
  WaMessage,
  WaAutoReply,
  WaTemplate,
  WaBroadcast,
  EmailBroadcast,
  EmailLog,
  WaLog,
  WaIncoming,
  ReminderSetting,
  ReminderLog,
  ReportLog,
  MonitorState,
  NotifLog,
  BotCommand,
  AppSetting,
  Announcement,
  Keuangan,
  RecurringExpense,
  QueueHistory,
  Asset,
  AssetCategory,
  AssetHistory,
  Ticket,
  TicketTimeline,
  Todo,
  PppoeProvisionJob,
  PppoeProvisionItem,
  Employee,
  HrisShift,
  HrisWorkLocation,
  HrisSchedule,
  HrisAttendance,
  HrisLeaveRequest,
  HrisPayroll,
  HrisPayrollItem,
  WorkOrder,
  TechnicianLocation,
  TrackingSession,
  PushTemplate,
  PushNotification,
  NocMonitorPreset,
  NmsInterfacePreset,
  SalesProfile,
  RegistrationRequest,
  SalesCommission,
  CollectorProfile,
  CollectionAssignment,
  CollectionAssignmentLog,
  CommissionPayment,
  CashDeposit,
  Reseller,
  ResellerVoucherPackage,
  ResellerTransaction,
  ResellerTopup,
  ResellerPackagePrice,
  ResellerVoucherLog,
  ResellerPromo,
  ResellerPromoRedemption,
  PublicVoucherOrder,
  RadiusNasClient,
  RadiusUser,
  RadiusAccounting,
  NasPortForward,
  WireguardServer,
  WireguardPeer
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
NmsInterfacePreset.belongsTo(Device, { foreignKey: 'router_id', as: 'router' });
User.hasMany(NocMonitorPreset,     { foreignKey: 'user_id',   as: 'noc_monitor_presets' });

// ── Sales module associations ─────────────────────────────────
SalesProfile.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasOne(SalesProfile,    { foreignKey: 'user_id', as: 'sales_profile' });

RegistrationRequest.belongsTo(User,             { foreignKey: 'sales_id',     as: 'sales'    });
RegistrationRequest.belongsTo(Package,          { foreignKey: 'package_id',   as: 'package'  });
RegistrationRequest.belongsTo(Customer,         { foreignKey: 'customer_id',  as: 'customer' });
RegistrationRequest.belongsTo(WorkOrder,        { foreignKey: 'work_order_id',as: 'workOrder'});
RegistrationRequest.belongsTo(User,             { foreignKey: 'survey_by',    as: 'surveyor' });
User.hasMany(RegistrationRequest,               { foreignKey: 'sales_id',     as: 'registrations' });
Package.hasMany(RegistrationRequest,            { foreignKey: 'package_id',   as: 'registrations' });
WorkOrder.hasOne(RegistrationRequest,           { foreignKey: 'work_order_id',as: 'registration' });

SalesCommission.belongsTo(User,                 { foreignKey: 'sales_id',        as: 'sales'        });
SalesCommission.belongsTo(User,                 { foreignKey: 'paid_by',         as: 'paidBy'       });
SalesCommission.belongsTo(User,                 { foreignKey: 'approved_by',     as: 'approvedBy'   });
SalesCommission.belongsTo(RegistrationRequest,  { foreignKey: 'registration_id', as: 'registration' });
SalesCommission.belongsTo(Package,              { foreignKey: 'package_id',      as: 'package'      });
SalesCommission.belongsTo(Customer,             { foreignKey: 'customer_id',     as: 'customer'     });
User.hasMany(SalesCommission,                   { foreignKey: 'sales_id',        as: 'commissions'  });

// ── Field Collection associations ─────────────────────────────
// CollectorProfile 1:1 User
CollectorProfile.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasOne(CollectorProfile,    { foreignKey: 'user_id', as: 'collector_profile' });

// CollectionAssignment relations
CollectionAssignment.belongsTo(Invoice,  { foreignKey: 'invoice_id',   as: 'invoice'   });
CollectionAssignment.belongsTo(Customer, { foreignKey: 'customer_id',  as: 'customer'  });
CollectionAssignment.belongsTo(User,     { foreignKey: 'collector_id', as: 'collector' });
CollectionAssignment.belongsTo(User,     { foreignKey: 'assigned_by',  as: 'assigner'  });
Invoice.hasMany(CollectionAssignment,    { foreignKey: 'invoice_id',   as: 'collection_assignments' });
Customer.hasMany(CollectionAssignment,   { foreignKey: 'customer_id',  as: 'collection_assignments' });
User.hasMany(CollectionAssignment,       { foreignKey: 'collector_id', as: 'collection_tasks' });

// CollectionAssignmentLog (audit reassign)
CollectionAssignmentLog.belongsTo(CollectionAssignment, { foreignKey: 'assignment_id', as: 'assignment' });
CollectionAssignmentLog.belongsTo(User, { foreignKey: 'from_collector_id', as: 'from_collector' });
CollectionAssignmentLog.belongsTo(User, { foreignKey: 'to_collector_id',   as: 'to_collector'   });
CollectionAssignmentLog.belongsTo(User, { foreignKey: 'changed_by',        as: 'changer'        });
CollectionAssignment.hasMany(CollectionAssignmentLog, { foreignKey: 'assignment_id', as: 'logs' });

// CommissionPayment
CommissionPayment.belongsTo(User, { foreignKey: 'collector_id', as: 'collector' });
CommissionPayment.belongsTo(User, { foreignKey: 'paid_by', as: 'payer' });

// CashDeposit relations
CashDeposit.belongsTo(User, { foreignKey: 'collector_id', as: 'collector' });
CashDeposit.belongsTo(User, { foreignKey: 'verified_by',  as: 'verifier'  });
User.hasMany(CashDeposit,   { foreignKey: 'collector_id', as: 'cash_deposits' });

// Payment <-> collector / assignment
Payment.belongsTo(User,                 { foreignKey: 'collected_by',  as: 'collector'  });
Payment.belongsTo(CollectionAssignment, { foreignKey: 'assignment_id', as: 'assignment' });
CollectionAssignment.hasMany(Payment,   { foreignKey: 'assignment_id', as: 'payments'   });
User.hasMany(Payment,                   { foreignKey: 'collected_by',  as: 'collected_payments' });

// ── Reseller Voucher Hotspot associations ─────────────────────
Reseller.belongsTo(Device, { foreignKey: 'device_id', as: 'device' });
Device.hasMany(Reseller,   { foreignKey: 'device_id', as: 'resellers' });

ResellerVoucherPackage.belongsTo(Device, { foreignKey: 'device_id', as: 'device' });
Device.hasMany(ResellerVoucherPackage,   { foreignKey: 'device_id', as: 'reseller_packages' });

// ── Public voucher orders (landing page /beli) ──
PublicVoucherOrder.belongsTo(ResellerVoucherPackage, { foreignKey: 'package_id', as: 'package' });
ResellerVoucherPackage.hasMany(PublicVoucherOrder,   { foreignKey: 'package_id', as: 'public_orders' });

ResellerTransaction.belongsTo(Reseller, { foreignKey: 'reseller_id', as: 'reseller' });
Reseller.hasMany(ResellerTransaction,   { foreignKey: 'reseller_id', as: 'transactions' });
ResellerTransaction.belongsTo(ResellerVoucherPackage, { foreignKey: 'package_id', as: 'package' });
ResellerTransaction.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

ResellerTopup.belongsTo(Reseller, { foreignKey: 'reseller_id', as: 'reseller' });
Reseller.hasMany(ResellerTopup,   { foreignKey: 'reseller_id', as: 'topups' });
ResellerTopup.belongsTo(User, { foreignKey: 'verified_by', as: 'verifier' });
ResellerTopup.belongsTo(ResellerTransaction, { foreignKey: 'transaction_id', as: 'transaction' });

// Keagenan bertingkat (#4): induk ↔ sub-reseller
Reseller.belongsTo(Reseller, { foreignKey: 'parent_id', as: 'parent' });
Reseller.hasMany(Reseller,   { foreignKey: 'parent_id', as: 'children' });

// Harga modal per paket per reseller (#2)
ResellerPackagePrice.belongsTo(Reseller, { foreignKey: 'reseller_id', as: 'reseller' });
ResellerPackagePrice.belongsTo(ResellerVoucherPackage, { foreignKey: 'package_id', as: 'package' });
Reseller.hasMany(ResellerPackagePrice, { foreignKey: 'reseller_id', as: 'package_prices' });
ResellerVoucherPackage.hasMany(ResellerPackagePrice, { foreignKey: 'package_id', as: 'reseller_prices' });

// Audit voucher (#7)
ResellerVoucherLog.belongsTo(Reseller, { foreignKey: 'reseller_id', as: 'reseller' });
Reseller.hasMany(ResellerVoucherLog, { foreignKey: 'reseller_id', as: 'voucher_logs' });
ResellerVoucherLog.belongsTo(ResellerTransaction, { foreignKey: 'transaction_id', as: 'transaction' });

// Promo top-up (#10)
ResellerPromoRedemption.belongsTo(ResellerPromo, { foreignKey: 'promo_id', as: 'promo' });
ResellerPromo.hasMany(ResellerPromoRedemption, { foreignKey: 'promo_id', as: 'redemptions' });
ResellerPromoRedemption.belongsTo(Reseller, { foreignKey: 'reseller_id', as: 'reseller' });

// ── HRIS associations ────────────────────────────────────────
// Employee ↔ User (opsional 1:1)
Employee.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasOne(Employee,    { foreignKey: 'user_id', as: 'employee' });

// Employee ↔ default shift & work location
Employee.belongsTo(HrisShift,        { foreignKey: 'shift_id',         as: 'shift' });
Employee.belongsTo(HrisWorkLocation, { foreignKey: 'work_location_id', as: 'work_location' });
HrisShift.hasMany(Employee,          { foreignKey: 'shift_id',         as: 'employees' });
HrisWorkLocation.hasMany(Employee,   { foreignKey: 'work_location_id', as: 'employees' });

// Schedule
HrisSchedule.belongsTo(Employee,         { foreignKey: 'employee_id',      as: 'employee' });
HrisSchedule.belongsTo(HrisShift,        { foreignKey: 'shift_id',         as: 'shift' });
HrisSchedule.belongsTo(HrisWorkLocation, { foreignKey: 'work_location_id', as: 'work_location' });
Employee.hasMany(HrisSchedule,           { foreignKey: 'employee_id',      as: 'schedules' });

// Attendance
HrisAttendance.belongsTo(Employee,         { foreignKey: 'employee_id',      as: 'employee' });
HrisAttendance.belongsTo(HrisShift,        { foreignKey: 'shift_id',         as: 'shift' });
HrisAttendance.belongsTo(HrisWorkLocation, { foreignKey: 'work_location_id', as: 'work_location' });
Employee.hasMany(HrisAttendance,           { foreignKey: 'employee_id',      as: 'attendances' });

// Leave requests
HrisLeaveRequest.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
HrisLeaveRequest.belongsTo(User,     { foreignKey: 'reviewed_by', as: 'reviewer' });
Employee.hasMany(HrisLeaveRequest,   { foreignKey: 'employee_id', as: 'leave_requests' });

// Payroll
HrisPayroll.belongsTo(User,      { foreignKey: 'created_by', as: 'creator' });
HrisPayroll.hasMany(HrisPayrollItem, { foreignKey: 'payroll_id', as: 'items', onDelete: 'CASCADE' });
HrisPayrollItem.belongsTo(HrisPayroll, { foreignKey: 'payroll_id',  as: 'payroll', onDelete: 'CASCADE' });
HrisPayrollItem.belongsTo(Employee,    { foreignKey: 'employee_id', as: 'employee' });
Employee.hasMany(HrisPayrollItem,      { foreignKey: 'employee_id', as: 'payroll_items' });

// ── Bulk Provisioning PPPoE associations ─────────────────────
// onDelete CASCADE: hapus job → itemnya ikut terhapus.
PppoeProvisionItem.belongsTo(PppoeProvisionJob, { foreignKey: 'job_id', as: 'job', onDelete: 'CASCADE' });
PppoeProvisionJob.hasMany(PppoeProvisionItem,  { foreignKey: 'job_id', as: 'items', onDelete: 'CASCADE' });

// ── RADIUS module associations ────────────────────────────────
// Link opsional ke Customer — hanya referensi/autofill, bukan sumber auth.
RadiusUser.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(RadiusUser,   { foreignKey: 'customer_id', as: 'radius_users' });

// NAS <-> Device (Mikrotik) — link opsional, NAS bisa berdiri sendiri tanpa device terdaftar.
RadiusNasClient.belongsTo(Device, { foreignKey: 'device_id', as: 'device' });
Device.hasMany(RadiusNasClient,   { foreignKey: 'device_id', as: 'nas_clients' });

// NAS <-> WireguardPeer — dipasang saat connection_mode='wireguard'.
RadiusNasClient.belongsTo(WireguardPeer, { foreignKey: 'wireguard_peer_id', as: 'wireguard_peer' });

// NAS <-> Port Forwards
RadiusNasClient.hasMany(NasPortForward, { foreignKey: 'nas_client_id', as: 'port_forwards', onDelete: 'CASCADE' });
NasPortForward.belongsTo(RadiusNasClient, { foreignKey: 'nas_client_id', as: 'nas' });

// ── WireGuard module associations ─────────────────────────────
WireguardPeer.belongsTo(WireguardServer, { foreignKey: 'server_id',   as: 'server' });
WireguardServer.hasMany(WireguardPeer,   { foreignKey: 'server_id',   as: 'peers', onDelete: 'CASCADE' });
WireguardPeer.belongsTo(Customer,        { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(WireguardPeer,          { foreignKey: 'customer_id', as: 'wireguard_peers' });

module.exports = db;