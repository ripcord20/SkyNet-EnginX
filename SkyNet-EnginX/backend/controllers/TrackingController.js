'use strict';
const { Op } = require('sequelize');
const { 
  TechnicianLocation, 
  TrackingSession, 
  Ticket, 
  User,
  sequelize 
} = require('../models');

// ══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Hitung jarak antara 2 koordinat GPS (Haversine formula)
 * @returns {number} jarak dalam meter
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radius bumi dalam meter
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Jarak dalam meter
}

/**
 * Broadcast update GPS ke semua client via Socket.IO
 */
function broadcastLocationUpdate(io, data) {
  if (io) {
    io.emit('technician:location:update', data);
  }
}

// ══════════════════════════════════════════════════════════════
// START TRACKING SESSION
// POST /api/tracking/start
// Body: { ticket_id, latitude, longitude, device_info }
// ══════════════════════════════════════════════════════════════
exports.startTracking = async (req, res) => {
  try {
    const technician_id = req.user.id;
    const { ticket_id, latitude, longitude, device_info } = req.body;

    if (!ticket_id || !latitude || !longitude) {
      return res.status(400).json({ 
        success: false, 
        message: 'ticket_id, latitude, dan longitude wajib diisi' 
      });
    }

    // Validasi ticket exists
    const ticket = await Ticket.findByPk(ticket_id);
    if (!ticket) {
      return res.status(404).json({ 
        success: false, 
        message: 'Ticket tidak ditemukan' 
      });
    }

    // Validasi teknisi ditugaskan ke ticket ini
    if (ticket.assigned_to !== technician_id) {
      return res.status(403).json({ 
        success: false, 
        message: 'Anda tidak ditugaskan untuk ticket ini' 
      });
    }

    // Check apakah sudah ada sesi aktif untuk ticket ini
    const existingSession = await TrackingSession.findOne({
      where: {
        ticket_id,
        technician_id,
        status: 'active'
      }
    });

    if (existingSession) {
      return res.status(400).json({ 
        success: false, 
        message: 'Sesi tracking untuk ticket ini sudah aktif',
        session: existingSession
      });
    }

    // Buat tracking session baru
    const session = await TrackingSession.create({
      technician_id,
      ticket_id,
      status: 'active',
      start_latitude: latitude,
      start_longitude: longitude,
      started_at: new Date(),
      metadata: {
        device_info: device_info || null,
        initial_battery: req.body.battery_level || null
      }
    });

    // Rekam posisi awal
    const location = await TechnicianLocation.create({
      technician_id,
      ticket_id,
      latitude,
      longitude,
      accuracy: req.body.accuracy || null,
      speed: req.body.speed || null,
      heading: req.body.heading || null,
      altitude: req.body.altitude || null,
      battery_level: req.body.battery_level || null,
      device_info: device_info || null,
      is_active: true,
      recorded_at: new Date()
    });

    // Update ticket status jadi in_progress
    if (ticket.status === 'open') {
      await ticket.update({ status: 'in_progress' });
    }

    // Broadcast via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('technician:tracking:started', {
        session_id: session.session_id,
        technician_id,
        ticket_id,
        location: {
          latitude,
          longitude,
          timestamp: location.recorded_at
        }
      });
    }

    res.status(201).json({ 
      success: true, 
      message: 'Tracking dimulai',
      session,
      location
    });

  } catch (error) {
    console.error('Error starting tracking:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// UPDATE LOCATION
// POST /api/tracking/update
// Body: { session_id, latitude, longitude, ... }
// ══════════════════════════════════════════════════════════════
exports.updateLocation = async (req, res) => {
  try {
    const technician_id = req.user.id;
    const { 
      session_id, 
      latitude, 
      longitude, 
      accuracy, 
      speed, 
      heading, 
      altitude,
      battery_level 
    } = req.body;

    if (!session_id || !latitude || !longitude) {
      return res.status(400).json({ 
        success: false, 
        message: 'session_id, latitude, dan longitude wajib diisi' 
      });
    }

    // Validasi session exists dan aktif
    const session = await TrackingSession.findOne({
      where: {
        session_id,
        technician_id,
        status: 'active'
      }
    });

    if (!session) {
      return res.status(404).json({ 
        success: false, 
        message: 'Sesi tracking tidak ditemukan atau sudah berakhir' 
      });
    }

    // Ambil lokasi terakhir untuk hitung jarak
    const lastLocation = await TechnicianLocation.findOne({
      where: {
        technician_id,
        ticket_id: session.ticket_id
      },
      order: [['recorded_at', 'DESC']]
    });

    let additionalDistance = 0;
    if (lastLocation) {
      additionalDistance = calculateDistance(
        parseFloat(lastLocation.latitude),
        parseFloat(lastLocation.longitude),
        parseFloat(latitude),
        parseFloat(longitude)
      );
    }

    // Simpan lokasi baru
    const location = await TechnicianLocation.create({
      technician_id,
      ticket_id: session.ticket_id,
      latitude,
      longitude,
      accuracy: accuracy || null,
      speed: speed || null,
      heading: heading || null,
      altitude: altitude || null,
      battery_level: battery_level || null,
      is_active: true,
      recorded_at: new Date()
    });

    // Update session stats
    await session.update({
      total_distance: parseFloat(session.total_distance || 0) + additionalDistance,
      total_duration: Math.floor((new Date() - new Date(session.started_at)) / 1000),
      points_count: parseInt(session.points_count || 0) + 1
    });

    // Broadcast real-time update via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('technician:location:update', {
        session_id,
        technician_id,
        ticket_id: session.ticket_id,
        location: {
          latitude,
          longitude,
          accuracy,
          speed,
          heading,
          battery_level,
          timestamp: location.recorded_at
        },
        stats: {
          total_distance: session.total_distance,
          total_duration: session.total_duration,
          points_count: session.points_count
        }
      });
    }

    res.json({ 
      success: true, 
      message: 'Lokasi berhasil diupdate',
      location,
      distance_traveled: additionalDistance
    });

  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// STOP TRACKING
// POST /api/tracking/stop
// Body: { session_id, latitude, longitude }
// ══════════════════════════════════════════════════════════════
exports.stopTracking = async (req, res) => {
  try {
    const technician_id = req.user.id;
    const { session_id, latitude, longitude, notes } = req.body;

    if (!session_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'session_id wajib diisi' 
      });
    }

    const session = await TrackingSession.findOne({
      where: {
        session_id,
        technician_id,
        status: 'active'
      }
    });

    if (!session) {
      return res.status(404).json({ 
        success: false, 
        message: 'Sesi tracking tidak ditemukan' 
      });
    }

    // Update session
    await session.update({
      status: 'completed',
      end_latitude: latitude || session.start_latitude,
      end_longitude: longitude || session.start_longitude,
      ended_at: new Date(),
      total_duration: Math.floor((new Date() - new Date(session.started_at)) / 1000),
      notes: notes || null
    });

    // Set semua lokasi jadi tidak aktif
    await TechnicianLocation.update(
      { is_active: false },
      { 
        where: { 
          technician_id, 
          ticket_id: session.ticket_id 
        } 
      }
    );

    // Broadcast via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('technician:tracking:stopped', {
        session_id,
        technician_id,
        ticket_id: session.ticket_id,
        stats: {
          total_distance: session.total_distance,
          total_duration: session.total_duration,
          points_count: session.points_count
        }
      });
    }

    res.json({ 
      success: true, 
      message: 'Tracking dihentikan',
      session
    });

  } catch (error) {
    console.error('Error stopping tracking:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// GET ACTIVE SESSIONS
// GET /api/tracking/active
// ══════════════════════════════════════════════════════════════
exports.getActiveSessions = async (req, res) => {
  try {
    const sessions = await TrackingSession.findAll({
      where: { status: 'active' },
      include: [
        {
          model: User,
          as: 'technician',
          attributes: ['id', 'name', 'email', 'phone']
        },
        {
          model: Ticket,
          as: 'ticket',
          attributes: ['id', 'ticket_number', 'title', 'type', 'priority', 'status']
        }
      ],
      order: [['started_at', 'DESC']]
    });

    // Ambil lokasi terakhir untuk setiap sesi
    const sessionsWithLocation = await Promise.all(
      sessions.map(async (session) => {
        const lastLocation = await TechnicianLocation.findOne({
          where: {
            technician_id: session.technician_id,
            ticket_id: session.ticket_id,
            is_active: true
          },
          order: [['recorded_at', 'DESC']]
        });

        return {
          ...session.toJSON(),
          last_location: lastLocation || null
        };
      })
    );

    res.json({ 
      success: true, 
      data: sessionsWithLocation,
      total: sessionsWithLocation.length
    });

  } catch (error) {
    console.error('Error getting active sessions:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// GET TRACKING HISTORY BY TICKET
// GET /api/tracking/history/:ticket_id
// ══════════════════════════════════════════════════════════════
exports.getTrackingHistory = async (req, res) => {
  try {
    const { ticket_id } = req.params;

    const sessions = await TrackingSession.findAll({
      where: { ticket_id },
      include: [
        {
          model: User,
          as: 'technician',
          attributes: ['id', 'name', 'email']
        }
      ],
      order: [['started_at', 'DESC']]
    });

    const locations = await TechnicianLocation.findAll({
      where: { ticket_id },
      order: [['recorded_at', 'ASC']]
    });

    res.json({ 
      success: true, 
      data: {
        sessions,
        locations,
        total_sessions: sessions.length,
        total_points: locations.length
      }
    });

  } catch (error) {
    console.error('Error getting tracking history:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// GET LOCATION TRAIL BY SESSION
// GET /api/tracking/trail/:session_id
// ══════════════════════════════════════════════════════════════
exports.getLocationTrail = async (req, res) => {
  try {
    const { session_id } = req.params;

    const session = await TrackingSession.findOne({
      where: { session_id },
      include: [
        {
          model: User,
          as: 'technician',
          attributes: ['id', 'name', 'phone']
        },
        {
          model: Ticket,
          as: 'ticket',
          attributes: ['id', 'ticket_number', 'title']
        }
      ]
    });

    if (!session) {
      return res.status(404).json({ 
        success: false, 
        message: 'Sesi tidak ditemukan' 
      });
    }

    const locations = await TechnicianLocation.findAll({
      where: { 
        technician_id: session.technician_id,
        ticket_id: session.ticket_id,
        recorded_at: {
          [Op.between]: [session.started_at, session.ended_at || new Date()]
        }
      },
      order: [['recorded_at', 'ASC']]
    });

    res.json({ 
      success: true, 
      data: {
        session,
        trail: locations,
        total_points: locations.length
      }
    });

  } catch (error) {
    console.error('Error getting location trail:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// GET MY ACTIVE SESSION (untuk teknisi)
// GET /api/tracking/my-session
// ══════════════════════════════════════════════════════════════
exports.getMyActiveSession = async (req, res) => {
  try {
    const technician_id = req.user.id;

    const session = await TrackingSession.findOne({
      where: {
        technician_id,
        status: 'active'
      },
      include: [
        {
          model: Ticket,
          as: 'ticket',
          attributes: ['id', 'ticket_number', 'title', 'type', 'priority']
        }
      ]
    });

    if (!session) {
      return res.json({ 
        success: true, 
        data: null,
        message: 'Tidak ada sesi tracking aktif'
      });
    }

    const lastLocation = await TechnicianLocation.findOne({
      where: {
        technician_id,
        ticket_id: session.ticket_id,
        is_active: true
      },
      order: [['recorded_at', 'DESC']]
    });

    res.json({ 
      success: true, 
      data: {
        ...session.toJSON(),
        last_location: lastLocation || null
      }
    });

  } catch (error) {
    console.error('Error getting my active session:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

// ══════════════════════════════════════════════════════════════
// GET TRACKING STATISTICS
// GET /api/tracking/stats
// ══════════════════════════════════════════════════════════════
exports.getStats = async (req, res) => {
  try {
    const { start_date, end_date, technician_id } = req.query;

    const where = {};
    if (start_date && end_date) {
      where.started_at = {
        [Op.between]: [new Date(start_date), new Date(end_date)]
      };
    }
    if (technician_id) {
      where.technician_id = technician_id;
    }

    const [
      totalSessions,
      activeSessions,
      completedSessions,
      totalDistance,
      totalDuration,
      avgDistance,
      avgDuration
    ] = await Promise.all([
      TrackingSession.count({ where }),
      TrackingSession.count({ where: { ...where, status: 'active' } }),
      TrackingSession.count({ where: { ...where, status: 'completed' } }),
      TrackingSession.sum('total_distance', { where: { ...where, status: 'completed' } }),
      TrackingSession.sum('total_duration', { where: { ...where, status: 'completed' } }),
      TrackingSession.average('total_distance', { where: { ...where, status: 'completed' } }),
      TrackingSession.average('total_duration', { where: { ...where, status: 'completed' } })
    ]);

    // Get top technicians by distance
    const topTechnicians = await TrackingSession.findAll({
      where: { ...where, status: 'completed' },
      attributes: [
        'technician_id',
        [sequelize.fn('SUM', sequelize.col('total_distance')), 'total_distance'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'session_count']
      ],
      include: [
        {
          model: User,
          as: 'technician',
          attributes: ['id', 'name']
        }
      ],
      group: ['technician_id'],
      order: [[sequelize.fn('SUM', sequelize.col('total_distance')), 'DESC']],
      limit: 10
    });

    res.json({
      success: true,
      data: {
        total_sessions: totalSessions,
        active_sessions: activeSessions,
        completed_sessions: completedSessions,
        total_distance: parseFloat(totalDistance || 0),
        total_duration: parseInt(totalDuration || 0),
        avg_distance: parseFloat(avgDistance || 0),
        avg_duration: parseInt(avgDuration || 0),
        top_technicians: topTechnicians
      }
    });

  } catch (error) {
    console.error('Error getting tracking stats:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
};

module.exports = exports;
