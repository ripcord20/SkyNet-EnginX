module.exports = {
  // User Roles
  ROLES: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    TECHNICIAN: 'technician'
  },

  // Invoice Status
  INVOICE_STATUS: {
    UNPAID: 'unpaid',
    PAID: 'paid',
    OVERDUE: 'overdue',
    CANCELLED: 'cancelled'
  },

  // Customer Status
  CUSTOMER_STATUS: {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    ISOLATED: 'isolated',
    SUSPENDED: 'suspended'
  },

  // Device Status
  DEVICE_STATUS: {
    ONLINE: 'online',
    OFFLINE: 'offline',
    WARNING: 'warning',
    MAINTENANCE: 'maintenance'
  },

  // Device Types
  DEVICE_TYPES: {
    ROUTER: 'router',
    SWITCH: 'switch',
    OLT: 'olt',
    ONT: 'ont',
    AP: 'access_point',
    SERVER: 'server',
    OTHER: 'other'
  },

  // Infrastructure Types
  INFRA_TYPES: {
    ODP: 'odp',
    ODC: 'odc',
    ONT: 'ont',
    CUSTOMER: 'customer',
    POP: 'pop',
    TOWER: 'tower'
  },

  // SNMP Versions
  SNMP_VERSIONS: {
    V1: 1,
    V2C: 2,
    V3: 3
  },

  // Notification Types
  NOTIFICATION_TYPES: {
    DEVICE_DOWN: 'device_down',
    DEVICE_UP: 'device_up',
    CPU_OVERLOAD: 'cpu_overload',
    MEMORY_HIGH: 'memory_high',
    INVOICE_OVERDUE: 'invoice_overdue',
    PAYMENT_RECEIVED: 'payment_received',
    CUSTOMER_ISOLATED: 'customer_isolated'
  },

  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,

  // SNMP OIDs for Mikrotik
  SNMP_OIDS: {
    SYSTEM_NAME: '1.3.6.1.2.1.1.5.0',
    SYSTEM_UPTIME: '1.3.6.1.2.1.1.3.0',
    SYSTEM_DESCR: '1.3.6.1.2.1.1.1.0',
    IF_TABLE: '1.3.6.1.2.1.2.2.1',
    IF_DESCR: '1.3.6.1.2.1.2.2.1.2',
    IF_OPER_STATUS: '1.3.6.1.2.1.2.2.1.8',
    IF_IN_OCTETS: '1.3.6.1.2.1.2.2.1.10',
    IF_OUT_OCTETS: '1.3.6.1.2.1.2.2.1.16',
    IF_HC_IN_OCTETS: '1.3.6.1.2.1.31.1.1.1.6',
    IF_HC_OUT_OCTETS: '1.3.6.1.2.1.31.1.1.1.10',
    CPU_LOAD: '1.3.6.1.2.1.25.3.3.1.2',
    MEMORY_TOTAL: '1.3.6.1.4.1.14988.1.1.1.1.0',
    MEMORY_USED: '1.3.6.1.4.1.14988.1.1.1.2.0',
    // Mikrotik specific
    MT_CPU_LOAD: '1.3.6.1.4.1.14988.1.1.3.14.0',
    MT_TOTAL_MEMORY: '1.3.6.1.2.1.25.2.3.1.5.65536',
    MT_USED_MEMORY: '1.3.6.1.2.1.25.2.3.1.6.65536',
    MT_FIRMWARE: '1.3.6.1.4.1.14988.1.1.4.4.0',
    MT_BOARD_NAME: '1.3.6.1.4.1.14988.1.1.7.3.0'
  }
};
