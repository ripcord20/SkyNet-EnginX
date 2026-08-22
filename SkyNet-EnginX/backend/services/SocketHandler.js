'use strict';

/**
 * SocketHandler.js - ENHANCED
 * Ditambahkan: subscription room untuk ONT monitoring
 */

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

module.exports = (io) => {
  // Authentication middleware for Socket.IO
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId   = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.id} (user: ${socket.userId})`);

    socket.join(`user_${socket.userId}`);

    // Device monitoring
    socket.on('device:subscribe',   (deviceId) => socket.join(`device_${deviceId}`));
    socket.on('device:unsubscribe', (deviceId) => socket.leave(`device_${deviceId}`));

    // General monitoring dashboard
    socket.on('monitoring:subscribe',   () => socket.join('monitoring'));
    socket.on('monitoring:unsubscribe', () => socket.leave('monitoring'));

    // ─── Customer Traffic Monitoring (halaman /infrastructure) ─────────
    // Polling MikroTik disentralisasi di CustomerTrafficPoller. Tiap admin
    // yang membuka halaman join room 'traffic_monitoring' dan menerima
    // broadcast 'traffic:update'. Poller hanya aktif saat ada subscriber.
    let _subbedTraffic = false;
    const trafficPoller = require('./CustomerTrafficPoller');
    socket.on('traffic:subscribe', () => {
      if (_subbedTraffic) return;        // hindari double-count per socket
      _subbedTraffic = true;
      socket.join('traffic_monitoring');
      trafficPoller.addSubscriber();
      // Kirim snapshot terakhir langsung agar UI tidak menunggu poll berikutnya.
      const snap = trafficPoller.getSnapshot();
      if (snap) socket.emit('traffic:update', snap);
    });
    socket.on('traffic:unsubscribe', () => {
      if (!_subbedTraffic) return;
      _subbedTraffic = false;
      socket.leave('traffic_monitoring');
      trafficPoller.removeSubscriber();
    });

    // ─── ONT Monitoring (NEW) ─────────────────────────────
    socket.on('ont:subscribe',   () => socket.join('ont_monitoring'));
    socket.on('ont:unsubscribe', () => socket.leave('ont_monitoring'));

    // Subscribe ke ONT tertentu (untuk detail view)
    socket.on('ont:subscribe_device', (ontId) => socket.join(`ont_${ontId}`));
    socket.on('ont:unsubscribe_device', (ontId) => socket.leave(`ont_${ontId}`));

    socket.on('disconnect', () => {
      // Pastikan subscriber traffic dikurangi walau klien tidak unsubscribe
      // eksplisit (mis. tab ditutup), supaya poller bisa berhenti saat idle.
      if (_subbedTraffic) {
        _subbedTraffic = false;
        trafficPoller.removeSubscriber();
      }
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
};
