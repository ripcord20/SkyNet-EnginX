'use strict';

/**
 * BotCommandController — CRUD perintah bot Telegram untuk tab "Perintah Bot"
 * di halaman Telegram Center. Setelah setiap perubahan, cache registry di
 * TelegramBotService di-invalidasi agar langsung berlaku.
 */

const KEYWORD_RE = /^[a-z0-9_]{1,40}$/;

function _norm(s) { return String(s == null ? '' : s).trim(); }
function _normKeyword(s) { return _norm(s).toLowerCase().replace(/^\//, ''); }
function _normAliases(s) {
  return String(s || '').split(',').map(a => a.trim().toLowerCase().replace(/^\//, ''))
    .filter(Boolean).filter(a => KEYWORD_RE.test(a)).join(',');
}

function _invalidate() {
  try { require('../services/TelegramBotService').invalidateCommandCache(); } catch (_) {}
}

const BotCommandController = {
  // GET /telegram/commands — daftar perintah + daftar sumber data.
  async list(req, res) {
    try {
      const { BotCommand } = require('../models');
      const rows = await BotCommand.findAll({ order: [['sort_order', 'ASC'], ['id', 'ASC']] });
      let sources = [];
      try { sources = require('../services/BotDataSources').listSources(); } catch (_) {}
      res.json({ success: true, data: rows, sources });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // POST /telegram/commands — buat perintah baru (custom: reply/data).
  async create(req, res) {
    try {
      const { BotCommand } = require('../models');
      const b = req.body || {};
      const keyword = _normKeyword(b.keyword);
      if (!KEYWORD_RE.test(keyword)) {
        return res.status(400).json({ success: false, message: 'Keyword hanya huruf kecil/angka/underscore (maks 40).' });
      }
      const type = ['reply', 'data'].includes(b.type) ? b.type : 'reply';

      // Cek bentrok keyword/alias dengan command lain.
      const aliases = _normAliases(b.aliases);
      const dupe = await _findKeywordClash(BotCommand, keyword, aliases, null);
      if (dupe) return res.status(400).json({ success: false, message: `Keyword/alias "${dupe}" sudah dipakai.` });

      if (type === 'data') {
        const valid = require('../services/BotDataSources').SOURCES[b.data_source];
        if (!valid) return res.status(400).json({ success: false, message: 'Sumber data tidak valid.' });
      }

      const row = await BotCommand.create({
        keyword,
        aliases,
        type,
        handler: null,
        data_source: type === 'data' ? _norm(b.data_source) : null,
        description: _norm(b.description).slice(0, 255),
        reply_template: _norm(b.reply_template),
        require_control: !!b.require_control,
        enabled: b.enabled === false ? false : true,
        is_system: false,
        sort_order: parseInt(b.sort_order, 10) || 100,
      });
      _invalidate();
      res.status(201).json({ success: true, data: row });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // PUT /telegram/commands/:id — edit perintah.
  async update(req, res) {
    try {
      const { BotCommand } = require('../models');
      const row = await BotCommand.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Perintah tidak ditemukan.' });
      const b = req.body || {};
      const patch = {};

      // Keyword & aliases: untuk command sistem, keyword TIDAK boleh diganti
      // (handler kode terkait nama), tapi alias & lainnya boleh.
      if (!row.is_system && b.keyword != null) {
        const kw = _normKeyword(b.keyword);
        if (!KEYWORD_RE.test(kw)) return res.status(400).json({ success: false, message: 'Keyword tidak valid.' });
        patch.keyword = kw;
      }
      if (b.aliases != null) patch.aliases = _normAliases(b.aliases);

      // Cek bentrok bila keyword/alias berubah.
      const newKw = patch.keyword || row.keyword;
      const newAl = patch.aliases != null ? patch.aliases : row.aliases;
      const clash = await _findKeywordClash(BotCommand, newKw, newAl, row.id);
      if (clash) return res.status(400).json({ success: false, message: `Keyword/alias "${clash}" sudah dipakai.` });

      if (b.description != null) patch.description = _norm(b.description).slice(0, 255);
      if (b.reply_template != null) patch.reply_template = _norm(b.reply_template);
      if (b.require_control != null) patch.require_control = !!b.require_control;
      if (b.enabled != null) patch.enabled = !!b.enabled;
      if (b.sort_order != null) patch.sort_order = parseInt(b.sort_order, 10) || row.sort_order;

      // type & data_source hanya boleh diubah untuk command NON-sistem.
      if (!row.is_system) {
        if (b.type && ['reply', 'data'].includes(b.type)) patch.type = b.type;
        const t = patch.type || row.type;
        if (t === 'data' && b.data_source != null) {
          const valid = require('../services/BotDataSources').SOURCES[b.data_source];
          if (!valid) return res.status(400).json({ success: false, message: 'Sumber data tidak valid.' });
          patch.data_source = _norm(b.data_source);
        }
      }

      await row.update(patch);
      _invalidate();
      res.json({ success: true, data: row });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },

  // DELETE /telegram/commands/:id — hapus (command sistem tak boleh dihapus).
  async remove(req, res) {
    try {
      const { BotCommand } = require('../models');
      const row = await BotCommand.findByPk(req.params.id);
      if (!row) return res.status(404).json({ success: false, message: 'Perintah tidak ditemukan.' });
      if (row.is_system) return res.status(400).json({ success: false, message: 'Perintah bawaan tidak dapat dihapus. Nonaktifkan saja bila perlu.' });
      await row.destroy();
      _invalidate();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
};

// Cari keyword/alias yang bentrok dengan command lain (selain excludeId).
async function _findKeywordClash(BotCommand, keyword, aliases, excludeId) {
  const all = await BotCommand.findAll();
  const mine = new Set([keyword, ...String(aliases || '').split(',').map(s => s.trim()).filter(Boolean)]);
  for (const r of all) {
    if (excludeId && r.id === Number(excludeId)) continue;
    const theirs = [r.keyword, ...String(r.aliases || '').split(',').map(s => s.trim()).filter(Boolean)];
    for (const t of theirs) if (mine.has(t.toLowerCase())) return t;
  }
  return null;
}

module.exports = BotCommandController;
