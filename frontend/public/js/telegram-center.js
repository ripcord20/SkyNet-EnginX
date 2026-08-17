/* telegram-center.js — logika halaman /telegram (Telegram Center) */
(function () {
  'use strict';

  // ── Definisi 8 template (selaras MonitoringService TPL_DEFAULTS) ──────
  const TPLS = [
    { key:'device_down',    name:'Perangkat Down',     group:'down',    color:'#ef4444', vars:['{nama}','{tipe}','{ip}','{waktu}'] },
    { key:'device_recover', name:'Perangkat Pulih',    group:'recover', color:'#22c55e', vars:['{nama}','{tipe}','{ip}','{waktu}'] },
    { key:'ont_down',       name:'ONT Disconnect',     group:'down',    color:'#f97316', vars:['{nama}','{cid}','{waktu}'] },
    { key:'ont_recover',    name:'ONT Pulih',          group:'recover', color:'#22c55e', vars:['{nama}','{cid}','{waktu}'] },
    { key:'ip_down',        name:'IP Timeout',         group:'down',    color:'#f59e0b', vars:['{nama}','{cid}','{ip}','{waktu}'] },
    { key:'ip_recover',     name:'IP Pulih',           group:'recover', color:'#22c55e', vars:['{nama}','{cid}','{ip}','{waktu}'] },
    { key:'pppoe_down',     name:'PPPoE Disconnect',   group:'down',    color:'#229ED9', vars:['{nama}','{cid}','{user}','{waktu}'] },
    { key:'pppoe_recover',  name:'PPPoE Pulih',        group:'recover', color:'#22c55e', vars:['{nama}','{cid}','{user}','{waktu}'] },
    { key:'pppoe_connect',    name:'Feed PPPoE Connect',    group:'feed', color:'#16a34a', vars:['{server}','{user}','{nama}','{paket}','{odp}','{ip}','{mac}','{uptime}','{total_active}','{total_offline}'] },
    { key:'pppoe_disconnect', name:'Feed PPPoE Disconnect', group:'feed', color:'#dc2626', vars:['{server}','{user}','{nama}','{paket}','{odp}','{ip}','{mac}','{last_logout}','{total_active}','{total_offline}'] },
  ];

  // Sample data utk preview — placeholder di-replace agar mirip pesan asli.
  const SAMPLE = {
    nama: 'Budi Santoso', tipe: 'Router', ip: '192.168.10.1',
    cid: ' (CUST-00123)', user: 'budi.s', waktu: nowClock(),
    server: 'Archer', paket: 'Upto 50Mbps',
    odp: 'ODP-Blok-C', mac: '5C:09:79:52:09:64', uptime: '9s',
    last_logout: nowClock(), total_active: 2, total_offline: 0,
  };
  // Untuk ont/ip/pppoe, {cid} dipakai polos tanpa kurung di sebagian template.
  const SAMPLE_PLAIN = { ...SAMPLE, cid: 'CUST-00123' };

  let state = { config: {}, defaults: {}, current: null, dirty: false };

  function $(id) { return document.getElementById(id); }
  function nowClock() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + '.' + String(d.getMinutes()).padStart(2, '0');
  }
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ── INIT ──────────────────────────────────────────────────────────
  async function init() {
    renderTplList();
    await loadConfig();
    loadBotStats();
    // pilih template pertama secara default
    selectTpl(TPLS[0].key);
  }

  async function loadConfig() {
    try {
      const r = await App.api('/telegram/config');
      if (!r || !r.success) throw new Error(r && r.message || 'Gagal memuat');
      state.config = r.config || {};
      state.defaults = r.defaults || {};

      const c = state.config;
      $('tg-enabled').checked     = String(c.telegram_enabled) === '1';

      // Token: ditampilkan masked. Sentinel '__UNCHANGED__' menandakan token
      // tersimpan tidak dikirim utuh ke browser (keamanan).
      state.tokenSet = !!r.token_set;
      state.tokenMasked = r.token_masked || '';
      state.tokenDirty = false;
      const tokenInp = $('tg-bot-token');
      if (state.tokenSet) {
        tokenInp.value = state.tokenMasked;
        tokenInp.dataset.masked = '1';
        tokenInp.readOnly = true;
        if ($('tg-token-reveal')) $('tg-token-reveal').style.display = 'inline-flex';
        if ($('tg-token-hint')) $('tg-token-hint').innerHTML = 'Token tersimpan (disamarkan). Klik ikon mata untuk ganti token baru.';
      } else {
        tokenInp.value = '';
        tokenInp.dataset.masked = '0';
        tokenInp.readOnly = false;
        if ($('tg-token-reveal')) $('tg-token-reveal').style.display = 'none';
      }

      $('tg-chat-id').value       = c.telegram_chat_id || '';
      $('tg-notif-device').checked= String(c.telegram_notif_device) === '1';
      $('tg-notif-ont').checked   = String(c.telegram_notif_ont) === '1';
      $('tg-notif-ip').checked    = String(c.telegram_notif_ip) === '1';
      $('tg-notif-pppoe').checked = String(c.telegram_notif_pppoe) === '1';
      // Network health
      if ($('tg-notif-router'))   $('tg-notif-router').checked   = String(c.telegram_notif_router) === '1';
      if ($('tg-notif-resource')) $('tg-notif-resource').checked = String(c.telegram_notif_resource) === '1';
      if ($('tg-notif-iface'))    $('tg-notif-iface').checked    = String(c.telegram_notif_iface) === '1';
      if ($('tg-cpu-threshold'))  $('tg-cpu-threshold').value    = c.telegram_cpu_threshold != null ? c.telegram_cpu_threshold : '';
      if ($('tg-mem-threshold'))  $('tg-mem-threshold').value    = c.telegram_mem_threshold != null ? c.telegram_mem_threshold : '';
      if ($('tg-alert-offline'))  $('tg-alert-offline').checked  = String(c.telegram_alert_offline) === '1';
      if ($('tg-alert-offline-threshold')) $('tg-alert-offline-threshold').value = c.telegram_alert_offline_threshold != null ? c.telegram_alert_offline_threshold : '';
      if ($('tg-chat-alert'))     $('tg-chat-alert').value       = c.telegram_chat_alert || '';
      if ($('tg-iface-keywords')) $('tg-iface-keywords').value   = c.telegram_iface_keywords || '';
      if ($('tg-iface-all'))      $('tg-iface-all').checked      = String(c.telegram_iface_all) === '1';
      // Feed PPPoE connect/disconnect
      if ($('tg-pppoe-feed'))         $('tg-pppoe-feed').checked         = String(c.telegram_pppoe_feed) === '1';
      if ($('tg-pppoe-feed-connect')) $('tg-pppoe-feed-connect').checked = String(c.telegram_pppoe_feed_connect ?? '1') === '1';
      if ($('tg-pppoe-feed-logout'))  $('tg-pppoe-feed-logout').checked  = String(c.telegram_pppoe_feed_logout ?? '1') === '1';
      if ($('tg-pppoe-feed-max'))     $('tg-pppoe-feed-max').value       = c.telegram_pppoe_feed_max != null ? c.telegram_pppoe_feed_max : '';
      if ($('tg-chat-pppoe-feed'))    $('tg-chat-pppoe-feed').value      = c.telegram_chat_pppoe_feed || '';
      $('tg-interval').value      = c.telegram_interval || '3';

      // Pengaturan keandalan v2.
      if ($('tg-flap-guard'))       $('tg-flap-guard').value = c.telegram_flap_guard != null ? c.telegram_flap_guard : '';
      if ($('tg-group-threshold'))  $('tg-group-threshold').value = c.telegram_group_threshold != null ? c.telegram_group_threshold : '';
      if ($('tg-quiet-enabled'))    $('tg-quiet-enabled').checked = String(c.telegram_quiet_enabled) === '1';
      if ($('tg-quiet-start'))      $('tg-quiet-start').value = c.telegram_quiet_start || '23:00';
      if ($('tg-quiet-end'))        $('tg-quiet-end').value = c.telegram_quiet_end || '06:00';
      syncQuiet();

      // Paket B — bot, routing, event.
      if ($('tg-bot-enabled'))  $('tg-bot-enabled').checked = String(c.telegram_bot_enabled) === '1';
      if ($('tg-bot-control'))  $('tg-bot-control').checked = String(c.telegram_bot_allow_control) === '1';
      if ($('tg-chat-admin'))   $('tg-chat-admin').value = c.telegram_chat_admin || '';
      // Ringkasan harian otomatis.
      if ($('tg-summary-enabled')) $('tg-summary-enabled').checked = String(c.telegram_summary_enabled) === '1';
      if ($('tg-summary-hour'))    $('tg-summary-hour').value = (c.telegram_summary_hour != null && c.telegram_summary_hour !== '') ? c.telegram_summary_hour : '8';
      ['device','ont','ip','pppoe'].forEach(k => {
        const el = $('tg-chat-' + k); if (el) el.value = c['telegram_chat_' + k] || '';
      });
      if ($('tg-chat-event'))   $('tg-chat-event').value = c.telegram_chat_event || '';
      if ($('tg-evt-payment'))  $('tg-evt-payment').checked = String(c.telegram_evt_payment) === '1';
      if ($('tg-evt-newcust'))  $('tg-evt-newcust').checked = String(c.telegram_evt_newcust) === '1';
      if ($('tg-evt-ticket'))   $('tg-evt-ticket').checked = String(c.telegram_evt_ticket) === '1';
      if ($('tg-evt-voucher'))  $('tg-evt-voucher').checked = String(c.telegram_evt_voucher) === '1';
      applyBotBadge(!!r.bot_running, String(c.telegram_bot_enabled) === '1');

      ['device','ont','ip','pppoe','router','resource','iface'].forEach(k => {
        const cb = $('tg-notif-' + k); if (cb) syncNotifCard(cb);
      });
      // Kartu event bisnis & feed PPPoE kini juga pakai pola .tg-notif → sync highlight.
      ['tg-evt-payment','tg-evt-newcust','tg-evt-ticket','tg-evt-voucher',
       'tg-pppoe-feed','tg-pppoe-feed-connect','tg-pppoe-feed-logout',
       'tg-bot-enabled','tg-bot-control','tg-quiet-enabled','tg-iface-all'].forEach(id => {
        const cb = $(id); if (cb) syncNotifCard(cb);
      });

      renderTplList();          // refresh badge custom/default
      applyStats(r.stats || {});
      renderHistory(r.history || []);
      refreshConnHeader();
      refreshIntervalPill();
      state.dirty = false;
      setSaveDirty(false);
    } catch (e) {
      App.toast && App.toast('Gagal memuat: ' + e.message, 'error');
    }
  }

  function applyStats(s) {
    if ('enabled' in s) {
      $('scStatus').textContent = s.enabled ? 'Aktif' : 'Nonaktif';
      $('scStatusDot').style.background = s.enabled ? '#22c55e' : '#cbd5e1';
      $('scStatusSub').textContent = s.enabled ? 'siap mengirim' : 'belum siap';
    }
    if ('notif_active' in s) {
      $('scNotif').textContent = s.notif_active;
      $('scNotifPill').textContent = s.notif_active + '/' + (s.notif_total || 4);
    }
    if ('tpl_filled' in s) {
      $('scTpl').textContent = s.tpl_filled;
      $('scTplPill').textContent = s.tpl_filled + '/' + (s.tpl_total || 8);
    }
    if ('chat_count' in s) $('scChat').textContent = s.chat_count;
    if ('interval' in s) $('scInterval').textContent = 'cek ' + s.interval + ' mnt';
  }

  // ── TEMPLATE LIST ─────────────────────────────────────────────────
  function renderTplList() {
    const wrap = $('tplList');
    if (!wrap) return;
    const groups = [
      { id:'down',    label:'Gangguan / Down', dot:'#ef4444' },
      { id:'recover', label:'Pemulihan',       dot:'#22c55e' },
      { id:'feed',    label:'Feed PPPoE (kartu)', dot:'#229ED9' },
    ];
    let html = '';
    groups.forEach(g => {
      html += `<div class="rm-grp-lbl"><span class="dot" style="background:${g.dot}"></span>${g.label}</div>`;
      TPLS.filter(t => t.group === g.id).forEach(t => {
        const filled = (state.config['telegram_tpl_' + t.key] || '').trim() !== '';
        const active = state.current === t.key ? ' active' : '';
        html += `
          <button type="button" class="et-item${active}" data-key="${t.key}" onclick="TG.selectTpl('${t.key}')">
            <span class="et-item-ic" style="background:${hexA(t.color,.13)};">
              <svg width="17" height="17" fill="none" stroke="${t.color}" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z"/><path stroke-linecap="round" stroke-linejoin="round" d="M22 6l-10 7L2 6"/></svg>
            </span>
            <span class="et-item-b">
              <span class="et-item-t">${t.name}</span>
              <span class="et-item-d">${t.vars.join(' ')}</span>
              <span class="et-pill ${filled ? 'custom' : 'default'}">${filled ? 'CUSTOM' : 'DEFAULT'}</span>
            </span>
          </button>`;
      });
    });
    wrap.innerHTML = html;
  }

  function hexA(hex, a) {
    const h = hex.replace('#',''); const n = parseInt(h, 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
  }

  // ── EDITOR ────────────────────────────────────────────────────────
  function selectTpl(key) {
    state.current = key;
    const t = TPLS.find(x => x.key === key);
    if (!t) return;
    renderTplList();

    const cur = state.config['telegram_tpl_' + key] || '';
    const def = state.defaults[key] || '';
    $('etEditorTitle').textContent = 'Editor — ' + t.name;

    const phChips = t.vars.map(v => `<span class="tg-ph" onclick="TG.insertPh('${v}')">${v}</span>`).join('');
    const tags = ['<b>','</b>','<i>','</i>','<code>','</code>']
      .map(tag => `<span class="tg-tag" onclick="TG.insertPh('${escAttr(tag)}')">${escHtml(tag)}</span>`).join('');

    const isFeed = (key === 'pppoe_connect' || key === 'pppoe_disconnect');
    const feedKind = key === 'pppoe_connect' ? 'pppoe_feed_connect' : 'pppoe_feed_disconnect';
    const testBtn = isFeed
      ? `<button class="et-link-btn" onclick="TG.testNotif('${feedKind}')" style="color:#229ED9;">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Tes Kirim
        </button>`
      : '';

    $('etEditor').innerHTML = `
      <div class="et-label">Isi Pesan
        <span style="font-weight:600;color:#94a3b8;">${cur.trim() ? 'Disesuaikan' : 'Pakai format bawaan'}</span>
      </div>
      <textarea id="tplBody" class="et-ta" oninput="TG.onBody()" placeholder="${escAttr(def)}"></textarea>
      <div class="et-label" style="margin:14px 0 0;">Placeholder</div>
      <div class="tg-ph-row">${phChips}</div>
      <div class="et-label" style="margin-top:2px;">Format HTML Telegram</div>
      <div class="tg-tag-row">${tags}</div>
      <div class="et-editor-foot">
        <button class="et-link-btn" onclick="TG.useDefault()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
          Pakai format bawaan
        </button>
        <button class="et-link-btn" onclick="TG.clearBody()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m-9 0v14a2 2 0 002 2h6a2 2 0 002-2V6"/></svg>
          Kosongkan
        </button>
        ${testBtn}
      </div>`;
    $('tplBody').value = cur;
    renderPreview();
  }

  function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function onBody() {
    if (!state.current) return;
    state.config['telegram_tpl_' + state.current] = $('tplBody').value;
    renderPreview();
    onAnyChange();
  }
  function insertPh(ph) {
    const ta = $('tplBody'); if (!ta) return;
    const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, s) + ph + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + ph.length;
    onBody();
  }
  function useDefault() {
    const ta = $('tplBody'); if (!ta || !state.current) return;
    ta.value = state.defaults[state.current] || '';
    onBody();
  }
  function clearBody() {
    const ta = $('tplBody'); if (!ta) return;
    ta.value = '';
    onBody();
  }

  // ── PREVIEW (Telegram chat bubble) ────────────────────────────────
  function renderPreview() {
    const t = TPLS.find(x => x.key === state.current);
    if (!t) return;
    $('tgCatLabel').textContent = t.name;
    $('tgCatDot').style.background = t.color;
    $('tgBotName').textContent = (state.config.telegram_bot_token ? 'Bot Monitoring' : 'Bot Monitoring');

    let raw = (state.config['telegram_tpl_' + t.key] || '').trim() || state.defaults[t.key] || '';
    if (!raw) {
      $('tgEmpty').style.display = 'flex';
      $('tgBubble').style.display = 'none';
      return;
    }
    // ont/ip/pppoe pakai {cid} polos; device pakai {cid} jarang. Pilih sample sesuai.
    const data = /^ont|^ip|^pppoe/.test(t.key) ? SAMPLE_PLAIN : SAMPLE;
    const isFeed = (t.key === 'pppoe_connect' || t.key === 'pppoe_disconnect');
    const FEED_OPT = ['nama','paket','odp','ip','mac','uptime','last_logout'];
    let msg = raw.replace(/\{(\w+)\}/g, (m, name) => {
      const has = Object.prototype.hasOwnProperty.call(data, name);
      const val = has ? String(data[name] == null ? '' : data[name]) : '';
      if (isFeed && FEED_OPT.includes(name) && val.trim() === '') return '';
      return has ? escHtml(data[name]) : m;
    });
    // Untuk feed: buang baris yang tinggal label kosong (mirip pesan asli).
    if (isFeed) {
      msg = msg.split('\n').filter(line => {
        const stripped = line.replace(/<\/?code>/g, '').replace(/<\/?b>/g, '').trim();
        return !/^[\w .\/]+:\s*$/.test(stripped);
      }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    // Render subset HTML Telegram (b/i/code) — sisanya di-escape.
    msg = renderTgHtml(msg);
    $('tgText').innerHTML = msg;
    $('tgTime').textContent = nowClock();
    $('tgEmpty').style.display = 'none';
    $('tgBubble').style.display = 'block';
  }

  // Escape semua, lalu un-escape tag yang didukung Telegram.
  function renderTgHtml(s) {
    let out = escHtml(s);
    out = out
      .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
      .replace(/&lt;strong&gt;/g, '<b>').replace(/&lt;\/strong&gt;/g, '</b>')
      .replace(/&lt;i&gt;/g, '<i>').replace(/&lt;\/i&gt;/g, '</i>')
      .replace(/&lt;em&gt;/g, '<i>').replace(/&lt;\/em&gt;/g, '</i>')
      .replace(/&lt;code&gt;/g, '<code>').replace(/&lt;\/code&gt;/g, '</code>')
      .replace(/&lt;pre&gt;/g, '<code>').replace(/&lt;\/pre&gt;/g, '</code>');
    return out;
  }

  // ── CONNECTION HEADER ─────────────────────────────────────────────
  function refreshConnHeader() {
    const on = $('tg-enabled').checked;
    const token = $('tg-bot-token').value.trim();
    const chat = $('tg-chat-id').value.trim();
    const ready = on && token && chat;
    $('connDot').style.background = ready ? '#22c55e' : (on ? '#f59e0b' : '#cbd5e1');
    $('connText').textContent = !on ? 'Nonaktif'
      : (ready ? 'Aktif & siap mengirim' : 'Aktif — lengkapi token & chat ID');
  }
  function refreshIntervalPill() {
    $('scInterval').textContent = 'cek ' + ($('tg-interval').value || '3') + ' mnt';
  }
  function syncNotifCard(cb) {
    const card = cb.closest('.tg-notif');
    if (card) card.classList.toggle('on', cb.checked);
  }

  // ── DIRTY / SAVE ──────────────────────────────────────────────────
  function onAnyChange() { state.dirty = true; setSaveDirty(true); }
  function setSaveDirty(d) {
    const lbl = $('btnSaveLabel');
    if (lbl) lbl.textContent = d ? 'Simpan Perubahan •' : 'Tersimpan';
  }

  function tokenValueForSave() {
    const inp = $('tg-bot-token');
    // Token tersimpan & belum diubah → kirim sentinel (jangan timpa).
    if (state.tokenSet && inp.dataset.masked === '1' && !state.tokenDirty) return '__UNCHANGED__';
    return (inp.value || '').trim();
  }

  function payload() {
    return {
      telegram_enabled:      $('tg-enabled').checked ? '1' : '0',
      telegram_bot_token:    tokenValueForSave(),
      telegram_chat_id:      $('tg-chat-id').value.trim(),
      telegram_notif_device: $('tg-notif-device').checked ? '1' : '0',
      telegram_notif_ont:    $('tg-notif-ont').checked ? '1' : '0',
      telegram_notif_ip:     $('tg-notif-ip').checked ? '1' : '0',
      telegram_notif_pppoe:  $('tg-notif-pppoe').checked ? '1' : '0',
      telegram_notif_router:   ($('tg-notif-router') && $('tg-notif-router').checked) ? '1' : '0',
      telegram_notif_resource: ($('tg-notif-resource') && $('tg-notif-resource').checked) ? '1' : '0',
      telegram_notif_iface:    ($('tg-notif-iface') && $('tg-notif-iface').checked) ? '1' : '0',
      telegram_cpu_threshold:  ($('tg-cpu-threshold') ? ($('tg-cpu-threshold').value || '90') : '90'),
      telegram_mem_threshold:  ($('tg-mem-threshold') ? ($('tg-mem-threshold').value || '90') : '90'),
      telegram_alert_offline:  ($('tg-alert-offline') && $('tg-alert-offline').checked) ? '1' : '0',
      telegram_alert_offline_threshold: ($('tg-alert-offline-threshold') ? ($('tg-alert-offline-threshold').value || '10') : '10'),
      telegram_chat_alert:     ($('tg-chat-alert') ? ($('tg-chat-alert').value || '') : ''),
      telegram_iface_keywords: ($('tg-iface-keywords') ? $('tg-iface-keywords').value.trim() : ''),
      telegram_iface_all:      ($('tg-iface-all') && $('tg-iface-all').checked) ? '1' : '0',
      telegram_pppoe_feed:         ($('tg-pppoe-feed') && $('tg-pppoe-feed').checked) ? '1' : '0',
      telegram_pppoe_feed_connect: ($('tg-pppoe-feed-connect') && $('tg-pppoe-feed-connect').checked) ? '1' : '0',
      telegram_pppoe_feed_logout:  ($('tg-pppoe-feed-logout') && $('tg-pppoe-feed-logout').checked) ? '1' : '0',
      telegram_pppoe_feed_max:     ($('tg-pppoe-feed-max') ? ($('tg-pppoe-feed-max').value || '25') : '25'),
      telegram_chat_pppoe_feed:    ($('tg-chat-pppoe-feed') ? $('tg-chat-pppoe-feed').value.trim() : ''),
      telegram_interval:     $('tg-interval').value || '3',
      telegram_flap_guard:      ($('tg-flap-guard') ? ($('tg-flap-guard').value || '0') : '0'),
      telegram_group_threshold: ($('tg-group-threshold') ? ($('tg-group-threshold').value || '5') : '5'),
      telegram_quiet_enabled:   ($('tg-quiet-enabled') && $('tg-quiet-enabled').checked) ? '1' : '0',
      telegram_quiet_start:     ($('tg-quiet-start') ? $('tg-quiet-start').value : '23:00'),
      telegram_quiet_end:       ($('tg-quiet-end') ? $('tg-quiet-end').value : '06:00'),
      telegram_bot_enabled:       ($('tg-bot-enabled') && $('tg-bot-enabled').checked) ? '1' : '0',
      telegram_bot_allow_control: ($('tg-bot-control') && $('tg-bot-control').checked) ? '1' : '0',
      telegram_chat_admin:   ($('tg-chat-admin') ? $('tg-chat-admin').value.trim() : ''),
      telegram_summary_enabled: ($('tg-summary-enabled') && $('tg-summary-enabled').checked) ? '1' : '0',
      telegram_summary_hour:    ($('tg-summary-hour') ? String(parseInt($('tg-summary-hour').value, 10) || 8) : '8'),
      telegram_chat_device:  ($('tg-chat-device') ? $('tg-chat-device').value.trim() : ''),
      telegram_chat_ont:     ($('tg-chat-ont') ? $('tg-chat-ont').value.trim() : ''),
      telegram_chat_ip:      ($('tg-chat-ip') ? $('tg-chat-ip').value.trim() : ''),
      telegram_chat_pppoe:   ($('tg-chat-pppoe') ? $('tg-chat-pppoe').value.trim() : ''),
      telegram_chat_event:   ($('tg-chat-event') ? $('tg-chat-event').value.trim() : ''),
      telegram_evt_payment:  ($('tg-evt-payment') && $('tg-evt-payment').checked) ? '1' : '0',
      telegram_evt_newcust:  ($('tg-evt-newcust') && $('tg-evt-newcust').checked) ? '1' : '0',
      telegram_evt_ticket:   ($('tg-evt-ticket') && $('tg-evt-ticket').checked) ? '1' : '0',
      telegram_evt_voucher:  ($('tg-evt-voucher') && $('tg-evt-voucher').checked) ? '1' : '0',
      telegram_tpl_device_down:    state.config.telegram_tpl_device_down || '',
      telegram_tpl_device_recover: state.config.telegram_tpl_device_recover || '',
      telegram_tpl_ont_down:       state.config.telegram_tpl_ont_down || '',
      telegram_tpl_ont_recover:    state.config.telegram_tpl_ont_recover || '',
      telegram_tpl_ip_down:        state.config.telegram_tpl_ip_down || '',
      telegram_tpl_ip_recover:     state.config.telegram_tpl_ip_recover || '',
      telegram_tpl_pppoe_down:     state.config.telegram_tpl_pppoe_down || '',
      telegram_tpl_pppoe_recover:  state.config.telegram_tpl_pppoe_recover || '',
      telegram_tpl_pppoe_connect:    state.config.telegram_tpl_pppoe_connect || '',
      telegram_tpl_pppoe_disconnect: state.config.telegram_tpl_pppoe_disconnect || '',
    };
  }

  async function saveAll() {
    const btn = $('btnSave'), icon = $('btnSaveIcon');
    btn.disabled = true;
    const orig = icon.outerHTML;
    icon.outerHTML = '<span class="et-spin-sm" id="btnSaveIcon"></span>';
    try {
      const r = await App.api('/telegram/save', { method:'POST', body: JSON.stringify(payload()) });
      if (r && r.success) {
        showResult(true, 'Tersimpan', r.message || 'Pengaturan Telegram berhasil disimpan.');
        state.dirty = false; setSaveDirty(false);
        await loadConfig();
        if (state.current) selectTpl(state.current);
      } else {
        showResult(false, 'Gagal', (r && r.message) || 'Tidak dapat menyimpan.');
      }
    } catch (e) {
      showResult(false, 'Gagal', e.message);
    } finally {
      btn.disabled = false;
      const ic = $('btnSaveIcon');
      if (ic) ic.outerHTML = '<svg id="btnSaveIcon" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
    }
  }

  async function testConnection() {
    const btn = $('btnTest');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="et-spin-sm"></span> Menguji…';
    try {
      const r = await App.api('/telegram/test', { method:'POST', body: JSON.stringify({
        telegram_bot_token: tokenValueForSave(),
        telegram_chat_id:   $('tg-chat-id').value.trim(),
        telegram_enabled:   $('tg-enabled').checked ? '1' : '0',
      })});
      if (r && r.success) {
        showResult(true, 'Koneksi Berhasil', r.message || 'Bot terhubung & pesan tes terkirim.');
        await loadConfig();
      } else {
        showResult(false, 'Koneksi Gagal', (r && r.message) || 'Cek token & chat ID.');
      }
    } catch (e) {
      showResult(false, 'Koneksi Gagal', e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  async function runChecksNow() {
    const btn = $('btnRunChecks');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="et-spin-sm" style="border-color:rgba(31,139,255,.3);border-top-color:#1f8bff;"></span> Memeriksa…';
    try {
      const r = await App.api('/telegram/run-checks', { method:'POST', body: '{}' });
      if (r && r.success) {
        const n = (r.notified != null) ? r.notified : (r.sent != null ? r.sent : null);
        showResult(true, 'Pengecekan Selesai',
          (r.message || 'Monitoring dijalankan.') + (n != null ? ` ${n} notifikasi terkirim.` : ''));
      } else {
        showResult(false, 'Tidak Bisa Memeriksa', (r && r.message) || 'Pastikan Telegram aktif.');
      }
    } catch (e) {
      showResult(false, 'Gagal', e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  async function sendQuick() {
    const text = $('tgQuickText').value.trim();
    if (!text) { App.toast && App.toast('Teks pesan kosong', 'error'); return; }
    const btn = $('btnQuickSend');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="et-spin-sm"></span> Mengirim…';
    try {
      const r = await App.api('/telegram/send-custom', { method:'POST', body: JSON.stringify({ text }) });
      if (r && r.success) showResult(true, 'Terkirim', r.message || 'Pesan terkirim ke Telegram.');
      else showResult(false, 'Gagal Mengirim', (r && r.message) || 'Cek koneksi Telegram.');
    } catch (e) {
      showResult(false, 'Gagal', e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  // ── RESULT MODAL ──────────────────────────────────────────────────
  function showResult(ok, title, msg) {
    const m = $('resultModal'), ic = $('rmIcon');
    ic.className = 'rm-icon ' + (ok ? 'ok' : 'err');
    ic.innerHTML = ok
      ? '<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M14 27l8 8 16-16" stroke="#16a34a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 52 52" fill="none"><path class="rm-draw" d="M18 18l16 16M34 18L18 34" stroke="#dc2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $('rmTitle').textContent = title;
    $('rmMsg').textContent = msg || '';
    m.style.display = 'flex';
  }
  function closeResult() { $('resultModal').style.display = 'none'; }

  // ── MOBILE TABS ───────────────────────────────────────────────────
  function mtab(which) {
    document.querySelectorAll('.et-mtab').forEach(b =>
      b.classList.toggle('active', b.dataset.mtab === which));
    const g = $('etGrid');
    g.classList.toggle('m-edit', which === 'edit');
    g.classList.toggle('m-prev', which === 'prev');
  }

  // Peringatan jika ada perubahan belum disimpan.
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Expose
  // ── Token reveal / edit ────────────────────────────────────────────
  // Klik mata: kalau token tersimpan & masih masked → kosongkan agar admin
  // bisa mengetik token baru (mode edit). Klik lagi → batal (kembali masked).
  function toggleToken() {
    const inp = $('tg-bot-token');
    if (inp.dataset.masked === '1') {
      // Masuk mode ganti token.
      inp.value = '';
      inp.dataset.masked = '0';
      inp.readOnly = false;
      state.tokenDirty = true;
      inp.focus();
      if ($('tg-token-hint')) $('tg-token-hint').textContent = 'Mode ganti token: tempel token baru. Kosongkan lalu simpan untuk menghapus.';
      onAnyChange();
    } else if (state.tokenSet) {
      // Batal — kembalikan tampilan masked.
      inp.value = state.tokenMasked;
      inp.dataset.masked = '1';
      inp.readOnly = true;
      state.tokenDirty = false;
      if ($('tg-token-hint')) $('tg-token-hint').innerHTML = 'Token tersimpan (disamarkan). Klik ikon mata untuk ganti token baru.';
    }
  }

  // ── Tes notifikasi per jenis ───────────────────────────────────────
  async function testNotif(kind) {
    try {
      const r = await App.api('/telegram/test-notif', { method:'POST', body: JSON.stringify({ kind }) });
      if (r && r.success) { showResult(true, 'Contoh Terkirim', r.message || 'Contoh notifikasi dikirim.'); refreshHistory(); }
      else showResult(false, 'Gagal', (r && r.message) || 'Tidak dapat mengirim contoh.');
    } catch (e) { showResult(false, 'Gagal', e.message); }
  }

  // ── Quiet hours show/hide ──────────────────────────────────────────
  function syncQuiet() {
    const on = $('tg-quiet-enabled') && $('tg-quiet-enabled').checked;
    const box = $('tg-quiet-times');
    if (box) box.style.display = on ? '' : 'none';
  }

  // Badge status bot (hijau=jalan, abu=mati/nonaktif).
  function applyBotBadge(running, enabled) {
    const b = $('tg-bot-badge'); if (!b) return;
    if (enabled) {
      b.style.display = 'inline';
      b.style.color = running ? '#22c55e' : '#f59e0b';
      b.title = running ? 'Bot berjalan' : 'Bot aktif tapi loop belum jalan (cek log/restart)';
    } else {
      b.style.display = 'none';
    }
  }

  // ── Riwayat notifikasi ─────────────────────────────────────────────
  const KIND_LABEL = { device:'Perangkat', ont:'ONT', ip:'IP', pppoe:'PPPoE', summary:'Ringkasan', custom:'Custom', test:'Tes', router:'Router', resource:'Beban Router', iface:'Interface', pppoe_feed:'Feed PPPoE', event:'Event', payment:'Pembayaran', newcust:'Pelanggan Baru', ticket:'Tiket', voucher:'Voucher' };
  // Terjemahkan pesan gagal teknis jadi keterangan yang bisa ditindaklanjuti.
  function failReason(msg){
    const m = String(msg || '').toLowerCase();
    if (!m || m === 'gagal') return 'gagal kirim — cek koneksi/token';
    if (m.includes('no_token') || m.includes('token')) return 'token bot belum diisi/invalid';
    if (m.includes('no_chat') || m.includes('chat not found') || m.includes('chat_id')) return 'Chat ID salah / bot belum di-start';
    if (m.includes('disabled')) return 'Telegram nonaktif saat itu';
    if (m.includes('blocked') || m.includes('bot was blocked')) return 'bot diblokir user';
    if (m.includes('timeout') || m.includes('etimedout') || m.includes('econn')) return 'jaringan timeout ke Telegram';
    if (m.includes('too many requests') || m.includes('429')) return 'rate-limit Telegram (429)';
    return msg;
  }
  // Badge ikon + warna per jenis notifikasi (SVG kecil, tanpa emoji).
  // Tiap entri: warna latar badge berdasarkan status, ikon berdasarkan kind.
  function histBadge(h) {
    const isFail = h.status === 'failed';
    const isHeld = h.status === 'held';
    const isPartial = h.status === 'sent' && (h.ok_count||0) < (h.chat_count||0) && (h.chat_count||0) > 0;
    const isDown = h.event === 'down';
    // Warna stroke + background lembut.
    let stroke, bg;
    if (isFail)        { stroke = '#dc2626'; bg = 'rgba(220,38,38,.10)'; }
    else if (isHeld)   { stroke = '#94a3b8'; bg = 'rgba(148,163,184,.14)'; }
    else if (isPartial){ stroke = '#d97706'; bg = 'rgba(217,119,6,.12)'; }
    else if (isDown)   { stroke = '#ef4444'; bg = 'rgba(239,68,68,.10)'; }
    else               { stroke = '#0d9488'; bg = 'rgba(13,148,136,.12)'; }
    // Ikon per kind.
    const ICON = {
      device:'<path d="M4 4h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM8 20h8"/>',
      ont:'<path d="M5 12.55a11 11 0 0114 0M8.5 16.05a6 6 0 017 0M2 8.82a15 15 0 0120 0M12 20h.01"/>',
      ip:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/>',
      pppoe:'<path d="M4 7h16M4 12h16M4 17h10"/>',
      pppoe_feed:'<path d="M4 7h16M4 12h16M4 17h10"/>',
      router:'<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/>',
      resource:'<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
      iface:'<path d="M9 17a5 5 0 01-5-5V8a5 5 0 0110 0M15 7a5 5 0 015 5v4a5 5 0 01-10 0"/>',
      payment:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
      newcust:'<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
      ticket:'<path d="M4 4h16a2 2 0 012 2v4a2 2 0 000 4v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 000-4V6a2 2 0 012-2z"/>',
      voucher:'<path d="M2 9a3 3 0 010 6v2a2 2 0 002 2h16a2 2 0 002-2v-2a3 3 0 010-6V7a2 2 0 00-2-2H4a2 2 0 00-2 2z"/>',
      summary:'<path d="M4 6h16M4 12h16M4 18h10"/>',
      event:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    };
    const path = ICON[h.kind] || ICON.event;
    return `<span class="tg-hist-badge" style="background:${bg};flex:0 0 34px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;overflow:hidden;"><svg width="17" height="17" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" style="width:17px;height:17px;flex-shrink:0;">${path}</svg></span>`;
  }

  let _histList = [];      // seluruh data riwayat
  let _histPage = 1;       // halaman aktif
  const HIST_PER_PAGE = 7; // maksimal 7 per halaman

  function renderHistory(list) {
    _histList = Array.isArray(list) ? list : [];
    _histPage = 1;
    renderHistPage();
  }

  function renderHistPage() {
    const el = $('tg-history'); if (!el) return;
    const foot = $('tg-hist-foot');
    if (!_histList.length) {
      el.innerHTML = '<div style="padding:22px 16px;text-align:center;font-size:12px;color:#64748b;">Belum ada notifikasi terkirim.</div>';
      if (foot) foot.style.display = 'none';
      return;
    }
    const total = _histList.length;
    const pages = Math.ceil(total / HIST_PER_PAGE);
    if (_histPage > pages) _histPage = pages;
    const start = (_histPage - 1) * HIST_PER_PAGE;
    const slice = _histList.slice(start, start + HIST_PER_PAGE);

    el.innerHTML = slice.map(h => {
      const d = new Date(h.created_at);
      const when = isNaN(d) ? '—' : (String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));
      const isDown = h.event === 'down';
      const isHeld = h.status === 'held';
      const isFail = h.status === 'failed';
      const isPartial = h.status === 'sent' && (h.ok_count||0) < (h.chat_count||0) && (h.chat_count||0) > 0;
      const evMap = { summary:'ringkasan', recover:'pulih', down:'down', pppoe_connect:'connect', pppoe_disconnect:'disconnect', payment:'bayar', newcust:'baru', ticket:'tiket', voucher:'voucher' };
      const evLabel = evMap[h.event] || (isDown ? 'down' : 'pulih');
      // Warna pill event.
      let evColor, evBg;
      if (isFail)        { evColor = '#dc2626'; evBg = 'rgba(220,38,38,.10)'; }
      else if (isHeld)   { evColor = '#64748b'; evBg = 'rgba(148,163,184,.16)'; }
      else if (isPartial){ evColor = '#b45309'; evBg = 'rgba(217,119,6,.14)'; }
      else if (isDown)   { evColor = '#dc2626'; evBg = 'rgba(239,68,68,.10)'; }
      else               { evColor = '#0d9488'; evBg = 'rgba(13,148,136,.12)'; }
      const sub = isFail ? escHtml(failReason(h.error_message))
        : isHeld ? 'ditahan (jam tenang)'
        : isPartial ? `terkirim sebagian (${h.ok_count}/${h.chat_count})`
        : (h.detail ? escHtml(h.detail) : '');
      return `<div class="tg-hist-row" style="display:flex;align-items:flex-start;gap:11px;padding:11px 16px;border-bottom:1px solid #e8edf5;">
        ${histBadge(h)}
        <div class="tg-hist-mid" style="flex:1;min-width:0;">
          <div class="tg-hist-t" style="font-size:12.5px;font-weight:700;color:#1e293b;display:flex;align-items:center;gap:7px;flex-wrap:wrap;line-height:1.3;">${escHtml(h.title || (KIND_LABEL[h.kind]||h.kind))} <span class="tg-hist-ev" style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:5px;color:${evColor};background:${evBg};">${evLabel}</span></div>
          <div class="tg-hist-sub" style="font-size:11px;color:#64748b;margin-top:3px;line-height:1.4;word-break:break-word;">${KIND_LABEL[h.kind]||h.kind}${sub?(' · '+sub):''}</div>
        </div>
        <div class="tg-hist-when" style="font-family:'DM Mono',monospace;font-size:10.5px;color:#94a3b8;white-space:nowrap;flex-shrink:0;margin-top:2px;">${when}</div>
      </div>`;
    }).join('');

    // Footer pagination.
    if (foot) {
      if (pages <= 1) {
        foot.style.display = 'none';
      } else {
        foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px 4px;border-top:1.5px solid #e8edf5;margin-top:2px;';
        const from = start + 1, to = Math.min(start + HIST_PER_PAGE, total);
        const info = $('tg-hist-info');
        if (info) { info.textContent = `${from}–${to} dari ${total}`; info.style.cssText = 'font-size:11px;color:#64748b;'; }
        const pager = $('tg-hist-pager');
        if (pager) { pager.style.cssText = 'display:flex;align-items:center;'; pager.innerHTML = buildPager(_histPage, pages); }
      }
    }
  }

  // Bangun tombol pagination: ‹ 1 2 3 … ›  (maks 5 nomor terlihat).
  function buildPager(cur, pages) {
    const baseStyle = 'display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 8px;border:1.5px solid #e8edf5;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;font-weight:700;color:#1e293b;margin-left:6px;';
    const actStyle = 'display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 8px;border:1.5px solid #1a6ef5;border-radius:8px;background:#1a6ef5;cursor:pointer;font-size:12px;font-weight:700;color:#fff;margin-left:6px;';
    const disStyle = baseStyle + 'opacity:.4;cursor:not-allowed;';
    const btn = (label, page, opts = {}) => {
      const dis = opts.disabled ? 'disabled' : '';
      const st = opts.disabled ? disStyle : opts.active ? actStyle : baseStyle;
      const pg = (page == null || opts.disabled) ? '' : `onclick="TG.histGoto(${page})"`;
      return `<button class="tg-hist-pg" style="${st}" ${dis} ${pg}>${label}</button>`;
    };
    const dots = '<span style="font-size:11px;color:#94a3b8;margin-left:6px;">…</span>';
    let html = btn('‹', cur - 1, { disabled: cur <= 1 });
    let s = Math.max(1, cur - 2), e = Math.min(pages, s + 4);
    s = Math.max(1, e - 4);
    if (s > 1) { html += btn('1', 1, { active: cur === 1 }); if (s > 2) html += dots; }
    for (let p = s; p <= e; p++) html += btn(String(p), p, { active: p === cur });
    if (e < pages) { if (e < pages - 1) html += dots; html += btn(String(pages), pages, { active: cur === pages }); }
    html += btn('›', cur + 1, { disabled: cur >= pages });
    return html;
  }

  function histGoto(page) {
    const pages = Math.ceil(_histList.length / HIST_PER_PAGE);
    _histPage = Math.min(Math.max(1, page), pages);
    renderHistPage();
    const el = $('tg-history'); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function refreshHistory() {
    try {
      const r = await App.api('/telegram/history?limit=100');
      if (r && r.success) renderHistory(r.history || []);
    } catch (_) {}
  }

  function onTokenInput() {
    const inp = $('tg-bot-token');
    if (inp.dataset.masked !== '1') { state.tokenDirty = true; }
  }

  // ── Statistik bot (aktivitas dari activity_logs) ──────────────────
  async function loadBotStats() {
    try {
      const r = await App.api('/telegram/bot-stats');
      if (!r || !r.success) return;
      const d = r.data || {};
      if ($('scBotToday')) $('scBotToday').textContent = d.today || 0;
      if ($('scBotWeek')) $('scBotWeek').textContent = (d.week || 0) + ' / 7 hari';
    } catch (_) {}
  }

  // ── Deteksi Chat ID yang baru berinteraksi ────────────────────────
  async function detectChats() {
    const box = $('detectChatsList');
    const btn = $('btnDetectChats');
    if (btn) { btn.disabled = true; btn.textContent = 'Memuat…'; }
    try {
      const r = await App.api('/telegram/detect-chats');
      const list = (r && r.success && r.data) ? r.data : [];
      if (!list.length) {
        box.innerHTML = '<div class="et-hint" style="margin:0;">Belum ada chat baru terdeteksi. Minta orang/grup kirim pesan apa pun ke bot, lalu klik lagi.</div>';
      } else {
        box.innerHTML = list.map(c => {
          const id = String(c.chatId || '').replace(/[<>&"]/g, '');
          const label = String(c.label || '-').replace(/[<>&"]/g, '');
          const type = String(c.type || '-').replace(/[<>&"]/g, '');
          return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px;background:#fff;">'
            + '<div style="flex:1;min-width:0;"><div style="font-size:12.5px;font-weight:700;color:#1e293b;">' + label + '</div>'
            + '<div style="font-size:11px;color:#64748b;">ID: <code>' + id + '</code> · ' + type + '</div></div>'
            + '<button type="button" class="et-btn" style="font-size:11px;padding:6px 10px;" onclick="TG.useChatId(\'' + id + '\')">Pakai sbg Admin</button>'
            + '</div>';
        }).join('');
      }
    } catch (e) {
      box.innerHTML = '<div class="et-hint" style="margin:0;color:#dc2626;">Gagal memuat: ' + (e.message || 'error') + '</div>';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Deteksi Chat ID Baru'; }
    }
  }

  // Masukkan chat ID ke field admin (tambah ke daftar bila sudah ada).
  function useChatId(id) {
    const inp = $('tg-chat-admin');
    if (!inp) return;
    const cur = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!cur.includes(id)) cur.push(id);
    inp.value = cur.join(', ');
    onAnyChange();
    inp.focus();
  }

  // ── Kirim ringkasan harian sekarang ───────────────────────────────
  async function summaryNow() {
    const btn = $('btnSummaryNow');
    const msg = $('summaryNowMsg');
    if (btn) { btn.disabled = true; btn.textContent = 'Mengirim…'; }
    if (msg) { msg.textContent = ''; msg.style.color = '#64748b'; }
    try {
      const r = await App.api('/telegram/summary-now', { method: 'POST', body: '{}' });
      if (r && r.success) {
        if (msg) { msg.textContent = r.message || 'Terkirim.'; msg.style.color = '#16a34a'; }
      } else {
        if (msg) { msg.textContent = (r && r.message) || 'Gagal mengirim.'; msg.style.color = '#dc2626'; }
      }
    } catch (e) {
      if (msg) { msg.textContent = 'Gagal: ' + (e.message || 'error'); msg.style.color = '#dc2626'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Kirim Ringkasan Sekarang'; }
    }
  }

  window.TG = { selectTpl, insertPh, onBody, useDefault, clearBody, toggleToken, testNotif, syncQuiet, refreshHistory, histGoto, onTokenInput, detectChats, useChatId, summaryNow };
  window.selectTpl = selectTpl;
  window.saveAll = saveAll;
  window.testConnection = testConnection;
  window.runChecksNow = runChecksNow;
  window.sendQuick = sendQuick;
  window.closeResult = closeResult;
  window.mtab = mtab;
  window.onAnyChange = onAnyChange;
  window.refreshConnHeader = refreshConnHeader;
  window.refreshIntervalPill = refreshIntervalPill;
  window.syncNotifCard = syncNotifCard;

  document.addEventListener('DOMContentLoaded', init);
})();
