'use strict';

const { QueueHistory } = require('../models');
const { Op, fn, col, literal } = require('sequelize');
const moment = require('moment');
const logger = require('../utils/logger');

/**
 * GET /api/mikrotik/queues/:queue_name/history?range=1h|6h|24h|7d|30d
 * Mengembalikan data history bandwidth untuk chart
 */
async function getQueueHistory(req, res) {
  try {
    const { queue_name } = req.params;
    const range = req.query.range || '6h';

    // Tentukan rentang waktu dan interval agregasi
    const { startTime, intervalMinutes, label } = getRangeConfig(range);

    // Query data dari DB dengan agregasi per interval
    const rows = await QueueHistory.findAll({
      where: {
        queue_name,
        recorded_at: { [Op.gte]: startTime }
      },
      attributes: [
        // Bucket time berdasarkan interval
        [literal(`FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at) / ${intervalMinutes * 60}) * ${intervalMinutes * 60})`), 'bucket'],
        [fn('AVG', col('rx_rate')), 'avg_rx'],
        [fn('AVG', col('tx_rate')), 'avg_tx'],
        [fn('MAX', col('rx_rate')), 'max_rx'],
        [fn('MAX', col('tx_rate')), 'max_tx'],
        [fn('MIN', col('rx_rate')), 'min_rx'],
        [fn('MIN', col('tx_rate')), 'min_tx'],
        [fn('MAX', col('rx_bytes')), 'rx_bytes_end'],
        [fn('MIN', col('rx_bytes')), 'rx_bytes_start'],
        [fn('MAX', col('tx_bytes')), 'tx_bytes_end'],
        [fn('MIN', col('tx_bytes')), 'tx_bytes_start'],
        [fn('COUNT', col('id')), 'sample_count']
      ],
      group: [literal(`FLOOR(UNIX_TIMESTAMP(recorded_at) / ${intervalMinutes * 60})`)],
      order: [[literal('bucket'), 'ASC']],
      raw: true
    });

    const data = rows.map(r => ({
      time:       r.bucket,
      avg_rx_mbps: parseFloat((r.avg_rx / 1e6).toFixed(4)),
      avg_tx_mbps: parseFloat((r.avg_tx / 1e6).toFixed(4)),
      max_rx_mbps: parseFloat((r.max_rx / 1e6).toFixed(4)),
      max_tx_mbps: parseFloat((r.max_tx / 1e6).toFixed(4)),
      min_rx_mbps: parseFloat((r.min_rx / 1e6).toFixed(4)),
      min_tx_mbps: parseFloat((r.min_tx / 1e6).toFixed(4)),
      rx_delta_bytes: Math.max(0, parseInt(r.rx_bytes_end) - parseInt(r.rx_bytes_start)),
      tx_delta_bytes: Math.max(0, parseInt(r.tx_bytes_end) - parseInt(r.tx_bytes_start)),
      samples: parseInt(r.sample_count)
    }));

    res.json({
      success: true,
      data,
      meta: { range, label, interval_minutes: intervalMinutes, start: startTime, points: data.length }
    });
  } catch (e) {
    logger.error('Queue history error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
}

/**
 * GET /api/mikrotik/queues/history/summary?range=24h
 * Ringkasan semua queue (top 10 by traffic)
 */
async function getHistorySummary(req, res) {
  try {
    const range = req.query.range || '24h';
    const { startTime } = getRangeConfig(range);

    const rows = await QueueHistory.findAll({
      where: { recorded_at: { [Op.gte]: startTime } },
      attributes: [
        'queue_name',
        [fn('AVG', col('rx_rate')), 'avg_rx'],
        [fn('AVG', col('tx_rate')), 'avg_tx'],
        [fn('MAX', col('rx_rate')), 'peak_rx'],
        [fn('MAX', col('tx_rate')), 'peak_tx'],
        [fn('MAX', col('rx_bytes')), 'rx_end'],
        [fn('MIN', col('rx_bytes')), 'rx_start'],
        [fn('MAX', col('tx_bytes')), 'tx_end'],
        [fn('MIN', col('tx_bytes')), 'tx_start'],
      ],
      group: ['queue_name'],
      order: [[literal('avg_rx'), 'DESC']],
      limit: 10,
      raw: true
    });

    const data = rows.map(r => ({
      queue_name:   r.queue_name,
      avg_rx_mbps:  parseFloat((r.avg_rx / 1e6).toFixed(3)),
      avg_tx_mbps:  parseFloat((r.avg_tx / 1e6).toFixed(3)),
      peak_rx_mbps: parseFloat((r.peak_rx / 1e6).toFixed(3)),
      peak_tx_mbps: parseFloat((r.peak_tx / 1e6).toFixed(3)),
      total_rx_gb:  parseFloat(((r.rx_end - r.rx_start) / 1e9).toFixed(3)),
      total_tx_gb:  parseFloat(((r.tx_end - r.tx_start) / 1e9).toFixed(3)),
    }));

    res.json({ success: true, data, range });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

function getRangeConfig(range) {
  const now = moment();
  switch (range) {
    case '1h':  return { startTime: moment().subtract(1,  'hour').toDate(),  intervalMinutes: 1,    label: '1 Jam Terakhir' };
    case '6h':  return { startTime: moment().subtract(6,  'hours').toDate(), intervalMinutes: 5,    label: '6 Jam Terakhir' };
    case '24h': return { startTime: moment().subtract(24, 'hours').toDate(), intervalMinutes: 15,   label: '24 Jam Terakhir' };
    case '7d':  return { startTime: moment().subtract(7,  'days').toDate(),  intervalMinutes: 60,   label: '7 Hari Terakhir' };
    case '30d': return { startTime: moment().subtract(30, 'days').toDate(),  intervalMinutes: 360,  label: '30 Hari Terakhir' };
    default:    return { startTime: moment().subtract(6,  'hours').toDate(), intervalMinutes: 5,    label: '6 Jam Terakhir' };
  }
}

module.exports = { getQueueHistory, getHistorySummary };