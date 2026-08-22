'use strict';

const fs   = require('fs');
const path = require('path');
const { OntDevice, OntSignalHistory } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const ConfigCrypto = require('../utils/ConfigCrypto');

const CONFIG_PATH = path.join(__dirname, '../../uploads/acs_config.json');

function loadConfig() {
  return ConfigCrypto.load(CONFIG_PATH, null)
      || { enabled:true, port:7547, username:'', password:'', informPeriod:300 };
}
function saveConfig(cfg) {
  ConfigCrypto.save(CONFIG_PATH, cfg);
}

class ACSController {

  async status(req, res) {
    const cfg = loadConfig();
    res.json({ success:true, data:{
      running:true, port:cfg.port||7547,
      url:`http://${req.hostname}:${cfg.port||7547}/acs`,
      enabled:cfg.enabled!==false, informPeriod:cfg.informPeriod||300
    }});
  }

  async stats(req, res) {
    try {
      const [total,online,offline,warning] = await Promise.all([
        OntDevice.count({where:{source:'tr069'}}),
        OntDevice.count({where:{source:'tr069',status:'online'}}),
        OntDevice.count({where:{source:'tr069',status:'offline'}}),
        OntDevice.count({where:{source:'tr069',status:'warning'}}),
      ]);
      const latest = await OntDevice.findOne({where:{source:'tr069'},order:[['last_inform','DESC']],attributes:['last_inform']});
      res.json({success:true,data:{total,online,offline,warning,lastInform:latest?.last_inform||null}});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  async sessions(req, res) {
    try {
      const since = new Date(Date.now() - 10*60*1000);
      const active = await OntDevice.findAll({
        where:{source:'tr069',last_inform:{[Op.gte]:since}},
        attributes:['serial_number','model','ip_address','status','last_inform'],
        order:[['last_inform','DESC']], limit:50,
      });
      res.json({success:true,data:active,count:active.length});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  async devices(req, res) {
    try {
      const {page=1,limit=20,search,status} = req.query;
      const where = {source:'tr069'};
      if (status) where.status = status;
      if (search) where[Op.or] = [
        {serial_number:{[Op.like]:`%${search}%`}},
        {model:{[Op.like]:`%${search}%`}},
        {ip_address:{[Op.like]:`%${search}%`}},
        {manufacturer:{[Op.like]:`%${search}%`}},
      ];
      const offset = (parseInt(page)-1)*parseInt(limit);
      const {count,rows} = await OntDevice.findAndCountAll({where,offset,limit:parseInt(limit),order:[['last_inform','DESC']]});
      res.json({success:true,data:rows,total:count,page:parseInt(page),totalPages:Math.ceil(count/limit)});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  async deviceDetail(req, res) {
    try {
      const ont = await OntDevice.findOne({
        where:{[Op.or]:[{id:req.params.id},{serial_number:req.params.id}],source:'tr069'}
      });
      if (!ont) return res.status(404).json({success:false,message:'Device tidak ditemukan'});
      const history = await OntSignalHistory.findAll({
        where:{ont_device_id:ont.id},order:[['recorded_at','DESC']],limit:100
      });
      res.json({success:true,data:{...ont.toJSON(),signalHistory:history}});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  getConfig(req, res) {
    const cfg = loadConfig();
    res.json({success:true,data:{...cfg,password:cfg.password?'****':''}});
  }

  saveConfig(req, res) {
    try {
      const {port,username,password,informPeriod,enabled} = req.body;
      const cfg = loadConfig();
      const updated = {
        ...cfg,
        port:        parseInt(port)||cfg.port||7547,
        username:    username??cfg.username,
        informPeriod:parseInt(informPeriod)||cfg.informPeriod||300,
        enabled:     enabled!==undefined?!!enabled:cfg.enabled,
        ...(password&&password!=='****'?{password}:{}),
      };
      saveConfig(updated);
      res.json({success:true,message:'Config ACS disimpan',data:{...updated,password:updated.password?'****':''}});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  // ── Reboot ──────────────────────────────────────────────────────────
  async reboot(req, res) {
    const sn = req.params.sn;
    try {
      const {ACSCommandQueue} = require('../services/ACSServer');
      ACSCommandQueue.push(sn, 'reboot', {});
      res.json({success:true,message:`Reboot ${sn} diantrekan — akan dieksekusi saat inform berikutnya`});
    } catch(e){ res.json({success:true,message:`Reboot ${sn} diantrekan`}); }
  }

  // ── Get WiFi Info ────────────────────────────────────────────────────
  async getWifi(req, res) {
    const sn = req.params.sn;
    try {
      // Ambil dari DB dulu (data terakhir yang diketahui)
      const ont = await OntDevice.findOne({where:{serial_number:sn}});
      if (!ont) return res.status(404).json({success:false,message:'ONT tidak ditemukan'});

      const p = ont.tr069_params || {};
      res.json({success:true,data:{
        serial_number: sn,
        ssid:          p.wifi_ssid     || null,
        password:      p.wifi_pass     || null,
        channel:       p.wifi_channel  || null,
        standard:      p.wifi_std      || null,
        last_inform:   ont.last_inform,
        note: 'Data dari inform terakhir. Klik "Refresh dari ONT" untuk data terbaru.'
      }});
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  // ── Refresh WiFi dari ONT (queue GPV) ───────────────────────────────
  async refreshWifi(req, res) {
    const sn = req.params.sn;
    try {
      const {ACSCommandQueue} = require('../services/ACSServer');
      ACSCommandQueue.push(sn, 'get_wifi', {});
      res.json({success:true,message:`Request WiFi info untuk ${sn} diantrekan — tunggu inform berikutnya (~5 menit)`});
    } catch(e){ res.json({success:false,message:e.message}); }
  }

  // ── Set WiFi SSID / Password ─────────────────────────────────────────
  async setWifi(req, res) {
    const sn = req.params.sn;
    const {ssid, password} = req.body;

    if (!ssid && !password) {
      return res.status(400).json({success:false,message:'SSID atau password wajib diisi'});
    }

    // Validasi
    if (ssid && (ssid.length < 1 || ssid.length > 32)) {
      return res.status(400).json({success:false,message:'SSID harus 1-32 karakter'});
    }
    if (password && (password.length < 8 || password.length > 63)) {
      return res.status(400).json({success:false,message:'Password WiFi harus 8-63 karakter'});
    }

    try {
      const {ACSCommandQueue} = require('../services/ACSServer');
      ACSCommandQueue.push(sn, 'set_wifi', { ssid, password });

      logger.info(`[ACS] Set WiFi queued: ${sn} ssid=${ssid}`);
      res.json({
        success: true,
        message: `Perubahan WiFi ${sn} diantrekan — akan diterapkan saat ONT check-in berikutnya (~5 menit). ONT akan restart WiFi otomatis.`,
        data: { sn, ssid, passwordChanged: !!password }
      });
    } catch(e){ res.status(500).json({success:false,message:e.message}); }
  }

  // ── Set parameter arbitrary ──────────────────────────────────────────
  async setParam(req, res) {
    const {parameter,value,type='xsd:string'} = req.body;
    const sn = req.params.sn;
    if (!parameter||value===undefined) return res.status(400).json({success:false,message:'Parameter dan value wajib diisi'});
    try {
      const {ACSCommandQueue} = require('../services/ACSServer');
      ACSCommandQueue.push(sn,'set_param',{parameter,value,type});
      res.json({success:true,message:`SetParameterValues diantrekan untuk ${sn}`});
    } catch(e){ res.json({success:false,message:e.message}); }
  }

  async getParam(req, res) {
    const {parameter} = req.body;
    const sn = req.params.sn;
    if (!parameter) return res.status(400).json({success:false,message:'Parameter wajib diisi'});
    try {
      const {ACSCommandQueue} = require('../services/ACSServer');
      ACSCommandQueue.push(sn,'get_param',{parameter});
      res.json({success:true,message:`GetParameterValues diantrekan untuk ${sn}`});
    } catch(e){ res.json({success:false,message:e.message}); }
  }
}

module.exports = new ACSController();