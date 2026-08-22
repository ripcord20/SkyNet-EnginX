// whatsapp.js — WA Gateway

// ── STATE ──────────────────────────────────────────────────────
let _sessions       = [];
let _currentSession = null;
let _currentContact = null;
let _allMessages    = [];
let _contacts       = [];
let _qrPollTimer    = null;
let _qrWaitTicks    = 0;
let _filter         = 'all';
let _ruleEditId     = null;
let _autoRules      = [];
let _tmplEditId     = null;
let _bcNumbers      = [];
const AVATAR_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#14b8a6'];
const _picCache = {};      // number -> url|'loading'
const _picNegAt = {};      // number -> timestamp saat terakhir gagal (null)
const _PIC_RETRY_MS = 5 * 60 * 1000; // coba lagi setelah 5 menit

// Samakan format nomor dengan backend/WAHA (08xx → 628xx). Nomor lokal '08...'
// yang dikirim apa adanya bikin WAHA balas kosong → foto tak pernah muncul.
function _picNormNumber(n) {
  let d = String(n || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.length > 15) return d;           // LID panjang — biarkan
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d;
}

async function fetchProfilePic(number) {
  if (!_currentSession) return null;
  const key = _picNormNumber(number);
  if (!key) return null;
  // Sudah ada URL valid → pakai.
  if (typeof _picCache[key] === 'string' && _picCache[key] !== 'loading') return _picCache[key];
  if (_picCache[key] === 'loading') return null;
  // Cache negatif: jangan permanen. Kontak baru butuh waktu (WEBJS 5-15 dtk)
  // sampai fotonya tersedia di WAHA; izinkan retry setelah _PIC_RETRY_MS.
  if (_picCache[key] === null) {
    if (_picNegAt[key] && (Date.now() - _picNegAt[key]) < _PIC_RETRY_MS) return null;
    // lewat masa tunggu → coba lagi
  }
  _picCache[key] = 'loading';
  try {
    const d = await App.api('/wa/profile-picture?session_id=' + _currentSession.session_id + '&number=' + encodeURIComponent(key));
    if (d?.url) {
      // URL gambar dipakai langsung sebagai <img src> (tidak lewat App.api),
      // jadi prefix '/api' HARUS ditulis eksplisit — route ada di /api/wa/...
      // Tanpa ini, di desktop src '/wa/profile-picture-img' → 404 & foto profil
      // tidak muncul (di /mobile sudah pakai '/api/...' sehingga tampil).
      _picCache[key] = '/api/wa/profile-picture-img?session_id=' +
        encodeURIComponent(_currentSession.session_id) +
        '&number=' + encodeURIComponent(key);
      delete _picNegAt[key];
    } else {
      _picCache[key] = null;
      _picNegAt[key] = Date.now();
    }
    return _picCache[key];
  } catch(e) {
    _picCache[key] = null;
    _picNegAt[key] = Date.now();
    return null;
  }
}

// Baca cache foto dengan key ternormalkan. Kembalikan URL string atau null.
function _picGet(number) {
  const key = _picNormNumber(number);
  const v = _picCache[key];
  return (typeof v === 'string' && v !== 'loading') ? v : null;
}
// Apakah nomor ini perlu di-fetch (belum pernah dicoba, ATAU cache negatif
// yang sudah lewat masa tunggu retry).
function _picUntried(number) {
  const key = _picNormNumber(number);
  const v = _picCache[key];
  if (v === undefined) return true;
  if (v === null && (!_picNegAt[key] || (Date.now() - _picNegAt[key]) >= _PIC_RETRY_MS)) return true;
  return false;
}

function avatarHtml(name, color, number, size, fontSize) {
  const sz = size || 40, fs = fontSize || 16;
  const pic = number ? _picGet(number) : null;
  if (pic) {
    const initial = (name||'?')[0].toUpperCase();
    // Kalau gambar gagal dimuat (proxy 404/CDN gagal), JANGAN tampilkan lingkaran
    // kosong — sembunyikan img & tampilkan inisial di div induk. Sekaligus tandai
    // di cache sbg null agar tidak dicoba lagi terus-menerus.
    const errHandler =
      "this.style.display='none';" +
      "this.parentNode.style.display='flex';" +
      "this.parentNode.style.alignItems='center';" +
      "this.parentNode.style.justifyContent='center';" +
      "this.parentNode.style.color='#fff';" +
      "this.parentNode.style.fontWeight='700';" +
      "this.parentNode.style.fontSize='" + fs + "px';" +
      "this.parentNode.textContent='" + initial.replace(/'/g, '') + "';";
    return '<div style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;overflow:hidden;flex-shrink:0;background:' + color + ';">' +
      '<img src="' + pic + '" style="width:' + sz + 'px;height:' + sz + 'px;object-fit:cover;display:block;" onerror="' + errHandler + '">' +
      '</div>';
  }
  return fallbackAvatar(name, color, sz, fs);
}

function fallbackAvatar(name, color, sz, fs) {
  const initial = (name||'?')[0].toUpperCase();
  return '<div style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;font-size:' + fs + 'px;font-weight:700;color:#fff;flex-shrink:0;">' + initial + '</div>';
}

// SVG Icons (Heroicons)
const IC = {
  user:       '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
  id:         '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0M9 12h6"/></svg>',
  phone:      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 7V5z"/></svg>',
  email:      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>',
  package:    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/></svg>',
  status:     '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
  address:    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
  reply:      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>',
  broadcast:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>',
  bell:       '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>',
  template:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  disconnect: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>',
  plus:       '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M12 4v16m8-8H4"/></svg>',
  warning:    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="#f59e0b" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
};

// ── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof App !== 'undefined') App.init();
  loadStats();
  loadSessions();
  setupSocket();
  setInterval(loadStats, 15000);
  setInterval(loadSessions, 10000);
});

// ── SOCKET ────────────────────────────────────────────────────
function setupSocket() {
  if (!App.socket) return;
  App.socket.onAny((event, data) => {
    // Event broadcast (tidak tergantung session aktif) — session dihapus oleh admin lain
    if (event === 'wa:session:deleted') {
      if (data && data.session_id) {
        _sessions = _sessions.filter(s => s.session_id !== data.session_id);
        if (_currentSession && _currentSession.session_id === data.session_id) {
          _currentSession = null;
          _allMessages = [];
          _contacts = [];
        }
        renderSessionChips();
        loadSessions();
      }
      return;
    }

    if (!_currentSession) return;
    const sid = _currentSession.session_id;
    if (event === 'wa:qr:' + sid) {
      if (data.qrImage) renderQr(data.qrImage);
    }
    if (event === 'wa:status:' + sid) {
      _currentSession.runtime_status = data.status;
      if (data.phone) _currentSession.phone_number = data.phone;
      updateSessionUI();
      if (data.status === 'connected') { stopQrPoll(); loadMessages(); loadSessions(); }
    }
    if (event === 'wa:message:' + sid) {
      if (data.direction === 'outbound') {
        // JANGAN prepend — bubble optimistis sudah ditambahkan saat klik
        // Kirim (prepend di sini = bubble DOBEL sampai reload). Cukup update
        // status centang, lalu sinkron dari DB.
        if (data.wa_message_id) updateBubbleAck(data.wa_message_id, data.status || 'sent');
        loadMessages();
      } else {
        prependIncomingMessage(data);
        loadMessages();
      }
    }
    if (event === 'wa:ack:' + sid) {
      updateBubbleAck(data.wa_message_id, data.status, data.ack_id);
    }
  });
}

// ── STATS ─────────────────────────────────────────────────────
async function loadStats() {
  const d = await App.api('/wa/stats');
  if (!d?.success) return;
  setText('statConnected', d.data.connectedSessions);
  setText('statToday',     d.data.todayMessages);
  setText('statSent',      d.data.totalSent);
  setText('statReceived',  d.data.totalReceived);
}

// ── SESSIONS ─────────────────────────────────────────────────
async function loadSessions() {
  const d = await App.api('/wa/sessions');
  if (!d?.success) return;
  _sessions = d.data;
  renderSessionChips();
  if (!_currentSession && _sessions.length) {
    const connected = _sessions.find(s => (s.runtime_status || s.status) === 'connected');
    if (connected) selectSession(connected.session_id);
  }
}

function renderSessionChips() {
  const el = document.getElementById('sessionChips');
  if (!_sessions.length) { el.innerHTML = '<span style="font-size:12px;color:#667781;">Belum ada session</span>'; return; }
  el.innerHTML = _sessions.map(s => {
    const st = s.runtime_status || s.status;
    const active = _currentSession?.session_id === s.session_id ? 'active' : st !== 'connected' ? 'disconnected' : '';
    const nameEsc = esc(s.name);
    const sidEsc  = String(s.session_id).replace(/'/g, "\\'");
    // Chip: klik => selectSession; tombol trash kecil di kanan; klik kanan => context menu
    return '<div class="wa-session-chip ' + active + '" ' +
             'onclick="selectSession(\'' + sidEsc + '\')" ' +
             'oncontextmenu="openSessionCtxMenu(event,\'' + sidEsc + '\')" ' +
             'title="' + nameEsc + ' — klik kanan untuk opsi">' +
             '<span class="wa-chip-dot chip-' + (st === 'connected' ? 'connected' : st === 'connecting' ? 'connecting' : 'disconnected') + '"></span>' +
             '<span>' + nameEsc + '</span>' +
             '<button class="wa-chip-del" title="Hapus session" ' +
                'onclick="event.stopPropagation();confirmDeleteSessionById(\'' + sidEsc + '\')">' +
                '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>' +
             '</button>' +
           '</div>';
  }).join('');
}

async function selectSession(sessionId) {
  const s = _sessions.find(x => x.session_id === sessionId);
  if (!s) return;
  _currentSession = s;
  _currentContact = null;
  renderSessionChips();
  updateSessionUI();
  await loadMessages();
}

function updateSessionUI() {
  if (!_currentSession) return;
  const st = _currentSession.runtime_status || _currentSession.status || 'disconnected';
  const isFonnte = _currentSession.provider === 'fonnte';
  hide('chatEmpty'); hide('chatQR'); hide('chatActive');
  const fp = document.getElementById('chatFonnte'); if (fp) fp.style.display = 'none';

  // Update nama session di header mobile (untuk panel QR)
  const qrHdrName = document.getElementById('qrMobileHeaderName');
  const qrHdrSub  = document.getElementById('qrMobileHeaderSub');
  if (qrHdrName) qrHdrName.textContent = _currentSession.name || 'Hubungkan WhatsApp';

  if (st === 'connected') {
    const ca = document.getElementById('chatActive');
    ca.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;min-height:0;';
    document.getElementById('chatInputBar').style.cssText = 'display:flex;flex-shrink:0;';
    document.getElementById('btnDisconnectHeader').style.display = '';
    if (!_currentContact) showEmptyChat();
    // Di mobile: kalau sudah connected & belum ada kontak dipilih, kembali ke list
    if (isMobile && isMobile()) mobileCloseQrView();
  } else if (isFonnte) {
    // Provider Fonnte: JANGAN tampilkan QR scan. Tampilkan panel Fonnte.
    if (fp) fp.style.display = '';
    const nm = document.getElementById('fonnteSessionName');
    if (nm) nm.textContent = _currentSession.name || '';
    setFonnteStatus(st === 'connected');
    if (isMobile && isMobile()) mobileOpenQrView();
  } else if (st === 'connecting') {
    show('chatQR');
    document.getElementById('qrSessionName').textContent = _currentSession.name;
    const btnC = document.getElementById('btnConnectQR'); if (btnC) btnC.style.display = 'none';
    setQrStatus('waiting', 'Menunggu QR');
    showQrLoading('Menghasilkan QR code...');
    if (qrHdrSub) qrHdrSub.textContent = 'Menghasilkan QR code...';
    startQrPoll();
    // Di mobile: buka panel QR fullscreen
    if (isMobile && isMobile()) mobileOpenQrView();
  } else {
    show('chatQR');
    document.getElementById('qrSessionName').textContent = _currentSession.name;
    const btnC = document.getElementById('btnConnectQR'); if (btnC) btnC.style.display = '';
    setQrStatus('waiting', 'Belum terhubung');
    showQrEmpty();
    stopQrCountdown();
    if (qrHdrSub) qrHdrSub.textContent = 'Klik Hubungkan untuk generate QR';
    // Di mobile: buka panel QR fullscreen
    if (isMobile && isMobile()) mobileOpenQrView();
  }
}

// Tampilkan catatan sinkron khusus session Fonnte (di atas input bar)
function _toggleFonnteChatNote() {
  const note = document.getElementById('fonnteChatNote');
  if (!note) return;
  const isFonnte = _currentSession && _currentSession.provider === 'fonnte';
  note.style.display = isFonnte ? 'flex' : 'none';
}

// Set tampilan status box di panel Fonnte
function setFonnteStatus(connected) {
  const box = document.getElementById('fonnteStatusBox');
  const txt = document.getElementById('fonnteStatusText');
  if (!box || !txt) return;
  box.className = 'fn-status ' + (connected ? 'is-on' : 'is-off');
  txt.textContent = connected ? 'Device aktif & terhubung' : 'Device tidak aktif';
}

// Verifikasi ulang status device Fonnte (panggil endpoint connect yang
// untuk Fonnte hanya memverifikasi token, tanpa QR).
async function verifyFonnteSession() {
  if (!_currentSession) return;
  const btn = document.getElementById('btnVerifyFonnte');
  const txt = document.getElementById('fonnteStatusText');
  if (btn) btn.disabled = true;
  if (txt) txt.textContent = 'Memeriksa…';
  try {
    const d = await App.api('/wa/sessions/' + _currentSession.session_id + '/connect', { method:'POST', body: '{}' });
    if (d?.success) {
      App.showToast(d.message || 'Device Fonnte terhubung', 'success');
      setFonnteStatus(true);
      await loadSessions();
      // refresh current session object & UI
      const upd = _sessions.find(s => s.session_id === _currentSession.session_id);
      if (upd) { _currentSession = upd; updateSessionUI(); }
    } else {
      App.showToast(d?.message || 'Device Fonnte tidak aktif', 'error');
      setFonnteStatus(false);
    }
  } catch (e) {
    App.showToast('Error: ' + e.message, 'error');
    setFonnteStatus(false);
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.verifyFonnteSession = verifyFonnteSession;

// ── QR UI helpers (redesigned) ────────────────────────────────
function setQrStatus(state, text) {
  // state: waiting | active | expired | connected
  const pill = document.getElementById('qrStatusPill');
  const txt  = document.getElementById('qrStatusPillText');
  if (pill) pill.className = 'wa-qr-status-pill ' + state;
  if (txt)  txt.textContent = text;

  const badge = document.getElementById('qrSessionBadge');
  const bTxt  = document.getElementById('qrBadgeText');
  if (badge) {
    badge.className = 'wa-qr-session-badge ' +
      (state === 'active' ? 'is-qr' : state === 'connected' ? 'is-ready' : state === 'expired' ? 'is-expired' : 'is-qr');
  }
  if (bTxt) {
    const map = { waiting: 'Menunggu QR code', active: 'QR aktif · siap discan', expired: 'QR kedaluwarsa', connected: 'Terhubung' };
    bTxt.textContent = map[state] || 'Menunggu QR code';
  }

  // Sync juga ke header mobile
  const qrHdrSub = document.getElementById('qrMobileHeaderSub');
  if (qrHdrSub) {
    const subMap = {
      waiting:   'Klik Hubungkan untuk scan',
      active:    'Scan QR dengan HP kamu',
      expired:   'QR kedaluwarsa — refresh ulang',
      connected: 'Berhasil terhubung'
    };
    qrHdrSub.textContent = subMap[state] || 'Scan QR code untuk terhubung';
  }
}

function showQrLoading(msg) {
  const w = document.getElementById('qrWrapper');
  if (!w) return;
  w.innerHTML =
    '<div class="wa-qr-loading">' +
      '<div class="wa-qr-loading-spinner"></div>' +
      '<div class="wa-qr-loading-text">' + (msg || 'Memuat QR code...') + '</div>' +
    '</div>' +
    '<span class="wa-qr-corner-bl"></span><span class="wa-qr-corner-br"></span>';
}

function showQrEmpty() {
  const w = document.getElementById('qrWrapper');
  if (!w) return;
  w.innerHTML =
    '<div class="wa-qr-empty">' +
      '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
        '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>' +
        '<path d="M14 14h2M14 17h5M14 20h3M17 14h4"/>' +
      '</svg>' +
      '<div class="wa-qr-empty-text">Klik tombol <b>Hubungkan</b> di bawah<br>untuk menghasilkan QR code</div>' +
    '</div>' +
    '<span class="wa-qr-corner-bl"></span><span class="wa-qr-corner-br"></span>';
  const wrap = document.getElementById('qrCountdownWrap');
  if (wrap) wrap.style.display = 'none';
}

function showQrConnectedSuccess() {
  const w = document.getElementById('qrWrapper');
  if (!w) return;
  w.innerHTML =
    '<div class="wa-qr-success">' +
      '<div class="wa-qr-success-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</div>' +
      '<div class="wa-qr-success-text">Berhasil Terhubung!</div>' +
      '<div class="wa-qr-success-sub">Memuat percakapan...</div>' +
    '</div>';
  const wrap = document.getElementById('qrCountdownWrap');
  if (wrap) wrap.style.display = 'none';
}

// ── QR Countdown (durasi hidup QR sebelum refresh) ────────────
let _qrCountdownTimer = null;
let _qrCountdownRemaining = 0;
const QR_LIFETIME_MS = 25000; // sinkron dengan batas age 25s di pollQr

function startQrCountdown(remainingMs) {
  stopQrCountdown();
  _qrCountdownRemaining = Math.max(0, remainingMs || QR_LIFETIME_MS);
  const wrap = document.getElementById('qrCountdownWrap');
  if (wrap) wrap.style.display = 'flex';
  _qrCountdownTimer = setInterval(function() {
    _qrCountdownRemaining -= 1000;
    renderQrCountdown(_qrCountdownRemaining);
    if (_qrCountdownRemaining <= 0) {
      stopQrCountdown();
      setQrStatus('expired', 'QR kedaluwarsa');
    }
  }, 1000);
  renderQrCountdown(_qrCountdownRemaining);
}

function renderQrCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const txt = document.getElementById('qrCountdown');
  const fill = document.getElementById('qrCountdownFill');
  if (txt)  txt.textContent = sec + 's';
  if (fill) {
    const pct = Math.max(0, Math.min(100, (ms / QR_LIFETIME_MS) * 100));
    fill.style.width = pct + '%';
    fill.classList.toggle('low', sec <= 8);
  }
}

function stopQrCountdown() {
  if (_qrCountdownTimer) { clearInterval(_qrCountdownTimer); _qrCountdownTimer = null; }
}

async function refreshQrManual() {
  if (!_currentSession) return;
  const btn = document.getElementById('btnRefreshQR');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  setQrStatus('waiting', 'Refresh QR...');
  showQrLoading('Refresh QR code...');
  // Trigger baru: call connect endpoint ulang untuk rebuild session
  try {
    await App.api('/wa/sessions/' + _currentSession.session_id + '/connect', { method:'POST' });
    setTimeout(startQrPoll, 1000);
  } catch(e) {}
  setTimeout(function(){ if (btn) { btn.disabled = false; btn.style.opacity = ''; } }, 2000);
}

function showEmptyChat() {
  document.getElementById('messagesWrap').innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#667781;">' +
    '<div style="width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#25d366,#128c7e);display:flex;align-items:center;justify-content:center;margin-bottom:12px;box-shadow:0 4px 16px rgba(37,211,102,.2);">' +
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M8 10h8M8 14h5" stroke-width="1.5"/></svg>' +
    '</div>' +
    '<div style="font-size:14px;">Pilih percakapan dari kiri</div></div>';
  document.getElementById('chatHeaderName').textContent = _currentSession?.name || '—';
  document.getElementById('chatHeaderStatus').textContent = _currentSession?.phone_number || 'connected';
  document.getElementById('chatHeaderAvatar').textContent = (_currentSession?.name || '?')[0].toUpperCase();
  document.getElementById('chatHeaderAvatar').style.background = '#25d366';
  const note = document.getElementById('fonnteChatNote');
  if (note) note.style.display = 'none';
}

// ── Message ticks (WhatsApp-style SVG) ───────────────────────
// Status: pending | sent | delivered | read | failed
function renderTick(status) {
  const st = String(status || 'sent').toLowerCase();
  const valid = ['pending','sent','delivered','read','failed'].includes(st) ? st : 'sent';

  // Shapes:
  //   pending: clock icon (melingkar dengan jarum)
  //   sent: 1 tick
  //   delivered/read: 2 tick overlap (read = biru, delivered = abu)
  //   failed: exclamation circle
  let svg = '';
  if (valid === 'pending') {
    svg = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10,9.5"/></svg>';
  } else if (valid === 'failed') {
    svg = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.3" r="0.6" fill="currentColor" stroke="none"/></svg>';
  } else if (valid === 'sent') {
    // Single tick
    svg = '<svg width="16" height="15" viewBox="0 0 16 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5,7.5 6.5,10.5 13,4"/></svg>';
  } else {
    // delivered & read — 2 tick bertumpuk (standard WhatsApp)
    svg =
      '<svg width="16" height="15" viewBox="0 0 16 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="0.5,8.5 3.5,11.5 10,5"/>' +
        '<polyline points="5.5,8.5 8.5,11.5 15,5"/>' +
      '</svg>';
  }
  return '<span class="wa-tick ' + valid + '">' + svg + '</span>';
}

// Update tick dari event wa:ack — cari bubble dengan data-wa-id matching
// Update tick dari event wa:ack — cari bubble by data-wa-id (exact atau prefix).
function updateBubbleAck(waId, status, ackId) {
  const targets = [];
  if (waId) targets.push(waId);
  if (ackId && ackId !== waId) targets.push(ackId);
  if (!targets.length) return;
  const bubbles = document.querySelectorAll('[data-wa-id]');
  bubbles.forEach(b => {
    const attr = b.getAttribute('data-wa-id') || '';
    // Cocok kalau sama persis, atau salah satu awalan dari yang lain (data lama
    // bisa bersuffix '|jid:...', sedangkan ack id sudah ternormalisasi).
    const match = targets.some(t =>
      attr === t || attr.startsWith(t) || t.startsWith(attr.split('|')[0])
    );
    if (!match) return;
    const oldTick = b.querySelector('.wa-tick');
    if (oldTick) oldTick.outerHTML = renderTick(status);
  });

  // Update juga status di data in-memory (_allMessages) supaya preview di daftar
  // chat kiri ikut konsisten (bukan cuma bubble chatroom). Lalu re-render list.
  let changed = false;
  const matchId = (mid) => {
    const c = String(mid || '');
    if (!c) return false;
    return targets.some(t => c === t || c.startsWith(t) || t.startsWith(c.split('|')[0]));
  };
  (_allMessages || []).forEach(m => {
    if (m.direction === 'outbound' && matchId(m.wa_message_id)) {
      // Jangan turunkan status (read > delivered > sent).
      const rank = { pending: 0, sent: 1, delivered: 2, read: 3 };
      if (status === 'failed' || (rank[status] || 0) >= (rank[m.status] || 0)) {
        if (m.status !== status) { m.status = status; changed = true; }
      }
    }
  });
  // Perbarui juga objek pesan di kontak yg sedang terbuka (referensi bisa beda).
  if (_currentContact && Array.isArray(_currentContact.messages)) {
    _currentContact.messages.forEach(m => {
      if (m.direction === 'outbound' && matchId(m.wa_message_id)) m.status = status;
    });
  }
  if (changed) { try { renderContactList(); } catch (_) {} }
}

// ── MESSAGES ─────────────────────────────────────────────────
async function loadMessages() {
  if (!_currentSession) return;
  const d = await App.api('/wa/conversations?session_id=' + _currentSession.session_id);
  if (!d?.success) return;
  _allMessages = d.data;
  // Ingat kontak yg sedang dibuka supaya thread-nya ikut ter-refresh (bukan cuma
  // daftar kontak). Tanpa ini, _currentContact tetap menunjuk objek lama →
  // pesan yang baru dihapus/berubah tidak terlihat sampai halaman di-reload.
  const openNum = _currentContact ? _currentContact.number : null;
  buildContactList();
  if (openNum) {
    const still = _contacts.find(c => c.number === openNum)
      || _contacts.find(c => c.number.slice(-9) === openNum.slice(-9));
    if (still) {
      _currentContact = still;
      renderChatMessages(_currentContact.messages);
      renderContactList();
    }
  }
}

function buildContactList() {
  // Nomor milik kita sendiri
  const myNumbers = new Set();
  _sessions.forEach(s => {
    if (!s.phone_number) return;
    const n = cleanNumber(s.phone_number);
    myNumbers.add(n);
    if (n.startsWith('62')) myNumbers.add('0' + n.slice(2));
    if (n.length >= 9) myNumbers.add(n.slice(-9));
  });
  // from_number outbound = pasti nomor kita
  _allMessages.forEach(m => {
    if (m.direction === 'outbound' && m.from_number) {
      const n = cleanNumber(m.from_number);
      if (n.length >= 9) { myNumbers.add(n); myNumbers.add(n.slice(-9)); if (n.startsWith('62')) myNumbers.add('0' + n.slice(2)); }
    }
  });

  function isValidPhone(n) { return n.length >= 10 && n.length <= 15 && (n.startsWith('62') || n.startsWith('0')); }
  function last9(n) { return n.slice(-9); }
  function betterNum(a, b) {
    const aOk = isValidPhone(a) && a.startsWith('62'), bOk = isValidPhone(b) && b.startsWith('62');
    if (aOk && !bOk) return a; if (bOk && !aOk) return b;
    return a.length <= b.length ? a : b;
  }

  const contactMap = {};
  _allMessages.forEach(m => {
    // Skip inbound dari nomor kita sendiri
    if (m.direction === 'inbound') {
      const fn = cleanNumber(m.from_number);
      if (myNumbers.has(fn) || myNumbers.has(last9(fn))) return;
    }
    let contactNum = m.direction === 'inbound' ? cleanNumber(m.from_number) : cleanNumber(m.to_number);
    if (!isValidPhone(contactNum) && m.customer?.phone) contactNum = cleanNumber(m.customer.phone);
    if (!contactNum) return;
    // Channel/newsletter/broadcast sudah difilter di BACKEND (webhook menolak
    // JID '@newsletter'/'@broadcast'). Di sini JANGAN membuang nomor panjang
    // begitu saja: pesan dari kontak '@lid' yang belum ter-resolve juga
    // menghasilkan nomor numerik panjang, dan itu adalah pesan pelanggan ASLI
    // yang harus tetap tampil. Hanya buang yang jelas bukan kontak: kosong,
    // atau terlalu pendek utk jadi key.
    if (myNumbers.has(contactNum) || myNumbers.has(last9(contactNum))) return;
    // Buang HANYA channel/newsletter warisan di DB lama (sebelum filter backend):
    // ID channel WhatsApp berpola khas diawali '120363' & sangat panjang (15+).
    // Pola ini TIDAK bertabrakan dgn nomor '@lid' kontak asli, jadi aman.
    if (/^120363\d{6,}$/.test(contactNum)) return;
    const key = last9(contactNum);
    if (!key || key.length < 7) return;

    if (!contactMap[key]) {
      let replyJid = null, pushName = null;
      if (m.wa_message_id && m.wa_message_id.includes('|')) {
        m.wa_message_id.split('|').forEach(part => {
          if (part.startsWith('jid:')) replyJid = part.slice(4);
          if (part.startsWith('name:')) pushName = part.slice(5);
        });
      }
      contactMap[key] = { number: contactNum, replyJid, pushName, customer: m.customer || null, messages: [], lastMsg: null, unread: 0 };
    } else {
      contactMap[key].number = betterNum(contactMap[key].number, contactNum);
    }
    // Nama dari kolom push_name (diisi provider WAHA/Fonnte) — sumber utama
    if (!contactMap[key].pushName && m.push_name) contactMap[key].pushName = m.push_name;
    if (!contactMap[key].pushName && m.wa_message_id?.includes('|name:'))
      contactMap[key].pushName = m.wa_message_id.split('|name:')[1]?.split('|')[0] || null;
    if (!contactMap[key].replyJid && m.wa_message_id?.includes('|jid:')) {
      const jp = m.wa_message_id.split('|jid:')[1];
      contactMap[key].replyJid = jp ? jp.split('|')[0] : null;
    }
    if (m.customer && !contactMap[key].customer) contactMap[key].customer = m.customer;
    if (m.customer?.phone && contactMap[key].customer?.phone &&
        cleanNumber(m.customer.phone).startsWith('62') && !cleanNumber(contactMap[key].customer.phone).startsWith('62'))
      contactMap[key].customer = m.customer;
    // Normalize timestamp
    if (!m.created_at && m.createdAt) m.created_at = m.createdAt;
    contactMap[key].messages.push(m);
    const mTime = parseDate(m.created_at) || 0;
    if (!contactMap[key].lastMsg || mTime > (parseDate(contactMap[key].lastMsg.created_at) || 0))
      contactMap[key].lastMsg = m;
    // Track last inbound/outbound untuk filter Belum Baca & Belum Balas
    if (m.direction === 'inbound') {
      if (!contactMap[key].lastInbound || mTime > (parseDate(contactMap[key].lastInbound.created_at) || 0))
        contactMap[key].lastInbound = m;
    } else {
      if (!contactMap[key].lastOutbound || mTime > (parseDate(contactMap[key].lastOutbound.created_at) || 0))
        contactMap[key].lastOutbound = m;
    }
  });

  // Dedup by customer_id
  const cidMap = {};
  Object.keys(contactMap).forEach(key => {
    const cid = contactMap[key].customer?.id;
    if (!cid) return;
    if (!cidMap[cid]) { cidMap[cid] = key; return; }
    const other = cidMap[cid];
    const keepKey = betterNum(contactMap[key].number, contactMap[other].number) === contactMap[key].number ? key : other;
    const dropKey = keepKey === key ? other : key;
    contactMap[keepKey].messages = contactMap[keepKey].messages.concat(contactMap[dropKey].messages);
    if (!contactMap[keepKey].lastMsg || new Date(contactMap[dropKey].lastMsg?.created_at||0) > new Date(contactMap[keepKey].lastMsg?.created_at||0))
      contactMap[keepKey].lastMsg = contactMap[dropKey].lastMsg;
    if (!contactMap[keepKey].pushName && contactMap[dropKey].pushName) contactMap[keepKey].pushName = contactMap[dropKey].pushName;
    if (!contactMap[keepKey].replyJid && contactMap[dropKey].replyJid) contactMap[keepKey].replyJid = contactMap[dropKey].replyJid;
    if (!contactMap[keepKey].customer && contactMap[dropKey].customer) contactMap[keepKey].customer = contactMap[dropKey].customer;
    delete contactMap[dropKey];
    cidMap[cid] = keepKey;
  });

  _contacts = Object.values(contactMap).sort((a, b) =>
    (parseDate(b.lastMsg?.created_at) || 0) - (parseDate(a.lastMsg?.created_at) || 0)
  );
  renderContactList();
}

function getDisplayName(c) {
  if (c.customer?.name) return c.customer.name;
  if (c.pushName) return c.pushName;
  if (c.number.length >= 10 && c.number.length <= 15 && c.number.startsWith('62')) return '+' + c.number;
  if (c.number.length > 13) return 'User ' + c.number.slice(-6);
  return c.number;
}

// Nomor HP yang akan ditampilkan ke user — prioritas: customer.phone > number (jika valid) > null
function getDisplayPhone(c) {
  if (c.customer?.phone) {
    const n = c.customer.phone.replace(/[^0-9]/g, '');
    return '+' + n;
  }
  const n = c.number;
  // Nomor valid (62xxx atau 08xxx, 10-15 digit)
  if (n.length >= 10 && n.length <= 15 && (n.startsWith('62') || n.startsWith('0'))) return '+' + n;
  // LID atau nomor tidak dikenal — jangan tampilkan
  return null;
}

function renderContactList() {
  const search = document.getElementById('contactSearch')?.value.toLowerCase() || '';
  const el = document.getElementById('contactList');

  const filtered = _contacts.filter(c => {
    const name = getDisplayName(c).toLowerCase();
    const matchSearch = !search || name.includes(search) || c.number.includes(search);
    if (!matchSearch) return false;
    // Filter tab
    if (_filter === 'unread') {
      // Belum Baca: pesan terakhir adalah inbound (belum dibuka/dibalas)
      return c.lastMsg && c.lastMsg.direction === 'inbound';
    }
    if (_filter === 'unanswered') {
      // Belum Balas: ada pesan inbound yang lebih baru dari pesan outbound terakhir
      if (!c.lastInbound) return false;
      if (!c.lastOutbound) return true; // belum pernah balas
      return new Date(c.lastInbound.created_at) > new Date(c.lastOutbound.created_at);
    }
    return true;
  });

  // Update tab badges
  const allCount        = _contacts.length;
  const unreadCount     = _contacts.filter(c => c.lastMsg && c.lastMsg.direction === 'inbound').length;
  const unansweredCount = _contacts.filter(c => c.lastInbound && (!c.lastOutbound || new Date(c.lastInbound.created_at) > new Date(c.lastOutbound.created_at))).length;
  updateTabBadge('tabAll',        allCount);
  updateTabBadge('tabUnread',     unreadCount);
  updateTabBadge('tabUnanswered', unansweredCount);

  if (!filtered.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:#667781;font-size:13px;">Belum ada percakapan</div>';
    return;
  }

  el.innerHTML = filtered.map(c => {
    const name     = getDisplayName(c);
    const color    = AVATAR_COLORS[hashCode(c.number) % AVATAR_COLORS.length];
    const last     = c.lastMsg;
    const lastTs   = last ? (last.created_at || last.createdAt) : null;
    const time     = lastTs ? formatTime(lastTs) : '';
    const isOut    = last?.direction === 'outbound';
    // Preview centang konsisten dgn chatroom: pakai status asli (sent/delivered/
    // read/failed), bukan centang 1 hardcoded. renderTick mengembalikan span
    // ber-class .wa-tick yg sudah diberi warna (biru utk read) via CSS.
    const previewTick = isOut ? '<span class="wa-preview-tick">' + renderTick(last.status || 'sent') + '</span> ' : '';
    const preview  = last ? previewTick + esc(last.message?.substring(0, 40)) : '';
    const isActive = _currentContact && (_currentContact.number === c.number || _currentContact.number.slice(-9) === c.number.slice(-9));
    const pkg      = c.customer?.package?.name || '';
    const pkgColor = pkg ? getPackageColor(pkg) : '';
    const hasUnread = last && last.direction === 'inbound';
    // Lazy-load foto profil jika belum ada di cache
    if (_picUntried(c.number)) fetchProfilePic(c.number).then(() => renderContactList());

    return '<div class="wa-contact-item ' + (isActive ? 'active' : '') + '" onclick="openContact(\'' + c.number + '\')" oncontextmenu="showContactMenu(event,\'' + c.number + '\')">' +
      avatarHtml(name, color, c.number, 46, 18) +
      '<div class="wa-contact-info">' +
        '<div class="wa-contact-top">' +
          '<span class="wa-contact-name" style="' + (hasUnread ? 'font-weight:700;color:#111b21;' : '') + '">' + esc(name) + '</span>' +
          '<span class="wa-contact-time" style="' + (hasUnread ? 'color:#25d366;font-weight:600;' : '') + '">' + time + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">' +
          '<div class="wa-contact-preview" style="' + (hasUnread ? 'color:#111b21;font-weight:500;' : '') + '">' + (preview || '<em style="opacity:.6">Belum ada pesan</em>') + '</div>' +
          (hasUnread ? '<span style="background:#25d366;color:#fff;border-radius:50%;min-width:18px;height:18px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px;flex-shrink:0;">!</span>' : '') +
        '</div>' +
        (pkg ? '<div class="wa-contact-tags"><span class="wa-tag" style="background:' + pkgColor + '20;color:' + pkgColor + ';">' + esc(pkg) + '</span></div>' : '') +
      '</div></div>';
  }).join('');
}

function updateTabBadge(tabId, count) {
  const el = document.getElementById(tabId);
  if (!el) return;
  // Hapus badge lama
  const old = el.querySelector('.tab-badge');
  if (old) old.remove();
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.style.cssText = 'background:#25d366;color:#fff;border-radius:20px;font-size:10px;font-weight:700;padding:1px 6px;margin-left:4px;';
    badge.textContent = count;
    el.appendChild(badge);
  }
}

function setFilter(f, btn) {
  _filter = f;
  document.querySelectorAll('.wa-filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderContactList();
}

function filterContacts() { renderContactList(); }

async function openContact(number) {
  _currentContact = _contacts.find(c => c.number === number)
    || _contacts.find(c => c.number.slice(-9) === number.slice(-9))
    || { number, messages: [] };
  renderContactList();
  hide('chatEmpty'); hide('chatQR');
  const ca = document.getElementById('chatActive');
  ca.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;min-height:0;';
  document.getElementById('chatInputBar').style.cssText = 'display:flex;flex-shrink:0;';
  _toggleFonnteChatNote();

  if (_currentContact.customer?.id) {
    try { const d = await App.api('/customers/' + _currentContact.customer.id); if (d?.success) _currentContact.customer = d.data; } catch(e) {}
  }

  const name  = getDisplayName(_currentContact);
  const color = AVATAR_COLORS[hashCode(number) % AVATAR_COLORS.length];
  // Fetch profile pic jika belum ada
  const headerEl = document.getElementById('chatHeaderAvatar');
  function setHeaderAvatar(pic) {
    if (pic) {
      headerEl.style.cssText = 'width:38px;height:38px;font-size:15px;border-radius:50%;overflow:hidden;flex-shrink:0;background:' + color + ';';
      const img = document.createElement('img');
      img.src = pic;
      img.style.cssText = 'width:38px;height:38px;object-fit:cover;display:block;border-radius:50%;';
      img.onerror = function() { this.remove(); };
      headerEl.innerHTML = '';
      headerEl.appendChild(img);
    } else {
      headerEl.style.cssText = 'width:38px;height:38px;font-size:15px;border-radius:50%;overflow:hidden;flex-shrink:0;background:' + color + ';display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;';
      headerEl.textContent = name[0].toUpperCase();
    }
  }
  if (_picUntried(number)) {
    headerEl.style.background = color;
    headerEl.textContent = name[0].toUpperCase();
    fetchProfilePic(number).then(url => setHeaderAvatar(url));
  } else {
    setHeaderAvatar(_picGet(number));
  }
  document.getElementById('chatHeaderName').textContent = name;
  // Header status: tampilkan nomor asli (bukan LID)
  const dispPhone = getDisplayPhone(_currentContact);
  let headerStatus = '';
  if (_currentContact.customer) {
    const custId = _currentContact.customer.customer_id || '';
    headerStatus = dispPhone ? dispPhone + (custId ? ' · ' + custId : '') : custId || 'WhatsApp User';
  } else {
    headerStatus = dispPhone || 'WhatsApp User';
  }
  document.getElementById('chatHeaderStatus').textContent = headerStatus;

  renderChatMessages(_currentContact.messages);
  renderProfile(_currentContact);
  setTimeout(() => { const w = document.getElementById('messagesWrap'); w.scrollTop = w.scrollHeight; }, 50);
}

// Blok quote kecil di dalam bubble utk pesan yang membalas pesan lain
function renderQuoteBlock(m) {
  const qt = m.reply_to_text || (m.reply_to_id ? '[pesan]' : null);
  if (!qt) return '';
  const short = String(qt).length > 90 ? String(qt).slice(0, 90) + '…' : String(qt);
  return '<div class="wa-quote">' + esc(short) + '</div>';
}

function renderBubbleContent(m) {
  const mtype = m.message_type || 'text';
  const url   = m.media_url || '';
  const txt   = m.message || '';

  // ── Deteksi berbasis EKSTENSI file (menang atas message_type) ──
  // Enum DB tidak punya tipe 'video' (video/sticker disimpan sebagai 'image',
  // pola lama Baileys yang diikuti WAHA) — tanpa ini, video dirender <img>
  // dan tampil rusak. Ekstensi file adalah sumber kebenaran yang sebenarnya.
  const _ext = url ? (url.split('?')[0].split('.').pop() || '').toLowerCase() : '';
  const _isVideoFile = ['mp4','webm','mov','3gp','mkv','avi'].includes(_ext);
  const _isAudioFile = ['ogg','mp3','opus','m4a','aac','wav','amr'].includes(_ext);

  if (url && _isVideoFile) {
    return '<div class="wa-media-wrap">' +
      '<video src="' + url + '" class="wa-media-video" controls preload="metadata"></video>' +
      (txt && !/^\[(image|video|media)\]$/i.test(txt) ? '<div class="wa-media-caption">' + esc(txt) + '</div>' : '') +
    '</div>';
  }
  if (url && _isAudioFile && mtype !== 'document') {
    return '<div class="wa-media-wrap">' +
      '<audio src="' + url + '" controls class="wa-media-audio"></audio>' +
    '</div>';
  }

  if (mtype === 'image' || mtype === 'sticker') {
    if (!url) return esc(txt) || '[Gambar]';
    return '<div class="wa-media-wrap">' +
      '<img src="' + url + '" class="wa-media-img" onclick="openMediaFull(this.src)" alt="Gambar" loading="lazy">' +
      (txt ? '<div class="wa-media-caption">' + esc(txt) + '</div>' : '') +
    '</div>';
  }
  if (mtype === 'video') {
    if (!url) return esc(txt) || '[Video]';
    return '<div class="wa-media-wrap">' +
      '<video src="' + url + '" class="wa-media-video" controls preload="metadata"></video>' +
      (txt ? '<div class="wa-media-caption">' + esc(txt) + '</div>' : '') +
    '</div>';
  }
  if (mtype === 'audio') {
    if (!url) return '[Audio]';
    return '<div class="wa-media-wrap">' +
      '<audio src="' + url + '" controls class="wa-media-audio"></audio>' +
    '</div>';
  }
  if (mtype === 'document') {
    if (!url) return esc(txt) || '[Dokumen]';
    const fname = url.split('/').pop().replace(/^wa_\d+_[a-z0-9]+\./, 'dokumen.');
    return '<div class="wa-media-wrap wa-doc-wrap">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;opacity:0.6;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:500;word-break:break-all;">' + esc(fname) + '</div>' +
        '<a href="' + url + '" download target="_blank" style="font-size:11px;color:#25d366;text-decoration:none;">⬇ Unduh</a>' +
      '</div>' +
    '</div>';
  }
  return esc(txt);
}

function openMediaFull(elOrUrl) {
  const url = typeof elOrUrl === 'string' ? elOrUrl : elOrUrl.src;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = '<img src="' + url + '" style="max-width:92vw;max-height:92vh;border-radius:8px;object-fit:contain;">';
  document.body.appendChild(overlay);
}

function parseDate(val) {
  if (!val) return null;
  // Jika sudah Date object
  if (val instanceof Date) return isNaN(val) ? null : val;
  // Number timestamp (ms)
  if (typeof val === 'number') return new Date(val);
  const s = String(val).trim();
  // ISO format standard: "2026-03-24T23:07:00.000Z" dll
  let d = new Date(s);
  if (!isNaN(d)) return d;
  // MySQL format: "2026-03-24 23:07:00" → ganti spasi ke T
  d = new Date(s.replace(' ', 'T'));
  if (!isNaN(d)) return d;
  // Format dengan timezone offset: "2026-03-24 23:07:00+07:00"
  d = new Date(s.replace(' ', 'T').replace(/(\+\d{2})(\d{2})$/, '$1:$2'));
  if (!isNaN(d)) return d;
  return null;
}

function renderChatMessages(messages) {
  const wrap = document.getElementById('messagesWrap');
  if (!messages.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:40px;color:#667781;font-size:13px;">Belum ada pesan</div>';
    return;
  }

  const today     = new Date();
  const todayStr  = today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const yestStr   = yesterday.toDateString();

  // Sort ascending by time
  // Normalize: Sequelize bisa return createdAt atau created_at
  messages.forEach(m => {
    if (!m.created_at && m.createdAt) m.created_at = m.createdAt;
  });

  const sorted = [...messages].sort((a, b) => {
    const da = parseDate(a.created_at), db = parseDate(b.created_at);
    return (da || 0) - (db || 0);
  });

  let html = '', lastDateKey = '';

  sorted.forEach(m => {
    const d = parseDate(m.created_at);

    // ── Date divider ──
    const dateKey = d ? d.toDateString() : 'unknown';
    if (dateKey !== lastDateKey) {
      let dividerLabel = '';
      if (d) {
        if (dateKey === todayStr) {
          dividerLabel = 'Hari Ini';
        } else if (dateKey === yestStr) {
          dividerLabel = 'Kemarin';
        } else {
          dividerLabel = d.toLocaleDateString('id-ID', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
        }
      }
      if (dividerLabel) {
        html += '<div class="wa-date-divider"><span>' + dividerLabel + '</span></div>';
      }
      lastDateKey = dateKey;
    }

    // ── Bubble ──
    const isOut   = m.direction === 'outbound';
    const timeStr = d ? d.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' }) : '–';
    const fullTs  = d ? d.toLocaleString('id-ID', { weekday:'long', day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const tick    = isOut ? renderTick(m.status || 'sent') : '';
    const meta    = '<span class="wa-bubble-meta"><span class="wa-bubble-time">' + timeStr + '</span>' + tick + '</span>';
    const msgBody = renderQuoteBlock(m) + renderBubbleContent(m);

    // Index pesan utk menu aksi (Balas / Hapus)
    if (m.id) _msgIndex[m.id] = m;
    const menuBtn = m.id
      ? '<span class="wa-bubble-menu" onclick="openMsgMenu(event, ' + m.id + ')" title="Aksi">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>' +
        '</span>'
      : '';

    const waIdAttr = (isOut && m.wa_message_id) ? ' data-wa-id="' + esc(m.wa_message_id) + '"' : '';
    html += '<div class="wa-msg-row ' + (isOut ? 'out' : 'in') + '">' +
      '<div class="wa-bubble ' + (isOut ? 'out' : 'in') + '"' + waIdAttr + ' title="' + fullTs + '">' +
        menuBtn + msgBody + meta +
      '</div></div>';
  });

  wrap.innerHTML = html;
}

function prependIncomingMessage(data) {
  if (!_currentContact) return;
  const fromClean = cleanNumber(data.from || '');
  const curNum = _currentContact.number;
  const isMatch = fromClean === curNum || fromClean.slice(-9) === curNum.slice(-9);
  if (data.direction === 'inbound' && !isMatch) return;
  const wrap = document.getElementById('messagesWrap');
  const div  = document.createElement('div');
  const isOut = data.direction === 'outbound';
  div.className = 'wa-msg-row ' + (isOut ? 'out' : 'in');
  const _t1 = new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
  const _mc = renderQuoteBlock({ reply_to_id: data.reply_to_id, reply_to_text: data.reply_to_text }) +
    renderBubbleContent({ message: data.text, message_type: data.message_type || 'text', media_url: data.media_url || null });
  const _tick = isOut ? renderTick('sent') : '';
  const _attr = (isOut && data.wa_message_id) ? ' data-wa-id="' + esc(data.wa_message_id) + '"' : '';
  div.innerHTML = '<div class="wa-bubble ' + (isOut ? 'out' : 'in') + '"' + _attr + '>' + _mc +
    '<span class="wa-bubble-meta"><span class="wa-bubble-time">' + _t1 + '</span>' + _tick + '</span></div>';
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

// ── SEND ──────────────────────────────────────────────────────
async function sendMessage() {
  if (!_currentSession || !_currentContact) return;
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg) return;
  if (!isConnected()) { App.showToast('Session belum terhubung', 'error'); return; }
  input.value = '';
  input.style.height = '';
  let sendTo = _currentContact.replyJid || _currentContact.number;
  if (sendTo && !sendTo.includes('@') && sendTo.length > 13) sendTo = sendTo + '@lid';
  const _reply = _replyTarget; // snapshot (strip dibersihkan setelah kirim)
  const payload = { session_id:_currentSession.session_id, to:sendTo, message:msg };
  if (_reply && _reply.waId) { payload.reply_to = _reply.waId; payload.reply_to_text = _reply.text; payload.reply_to_from_me = _reply.fromMe === true; }
  const d = await App.api('/wa/send', { method:'POST', body:JSON.stringify(payload) });
  if (d?.success) {
    cancelReply();
    const waId = d?.data?.key?.id || null;
    const wrap = document.getElementById('messagesWrap');
    const div  = document.createElement('div');
    div.className = 'wa-msg-row out';
    const _t2 = new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'});
    const _attr = waId ? ' data-wa-id="' + esc(waId) + '"' : '';
    const _quote = (_reply && _reply.waId) ? renderQuoteBlock({ reply_to_id: _reply.waId, reply_to_text: _reply.text }) : '';
    // Optimistic: start as 'pending' (jam), server akan kirim ACK 'sent' segera
    div.innerHTML = '<div class="wa-bubble out"' + _attr + '>' + _quote + esc(msg) +
      '<span class="wa-bubble-meta"><span class="wa-bubble-time">' + _t2 + '</span>' + renderTick('pending') + '</span></div>';
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  } else App.showToast(d?.message || 'Gagal kirim', 'error');
}

// ══════════════════════════════════════════════════════════════
// MEDIA SEND (file, image, document) + paste + drag-drop
// ══════════════════════════════════════════════════════════════
let _waPendingFile = null;      // File object yg sedang di-preview
let _waPendingPreviewUrl = null; // blob URL untuk preview (harus di-revoke)

function waToggleAttachMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('waAttachMenu');
  const btn  = document.getElementById('btnAttach');
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  menu.classList.toggle('open', willOpen);
  if (btn) btn.classList.toggle('active', willOpen);

  // Tutup saat klik di luar
  if (willOpen) {
    setTimeout(() => {
      document.addEventListener('click', waCloseAttachMenuOnce, { once: true });
    }, 0);
  }
}
function waCloseAttachMenuOnce(ev) {
  const menu = document.getElementById('waAttachMenu');
  const btn  = document.getElementById('btnAttach');
  if (menu && !menu.contains(ev.target) && ev.target !== btn) {
    menu.classList.remove('open');
    if (btn) btn.classList.remove('active');
  } else {
    document.addEventListener('click', waCloseAttachMenuOnce, { once: true });
  }
}

function waPickFile(type) {
  const menu = document.getElementById('waAttachMenu');
  const btn  = document.getElementById('btnAttach');
  if (menu) menu.classList.remove('open');
  if (btn)  btn.classList.remove('active');

  const inputId = (type === 'photo') ? 'waFilePhoto' : 'waFileDoc';
  const input = document.getElementById(inputId);
  if (input) { input.value = ''; input.click(); }
}

function waOnFilePicked(ev) {
  const files = ev?.target?.files;
  if (!files || !files.length) return;
  // Kirim satu per satu: tampilkan preview untuk file pertama, sisanya antri
  _waPendingFileQueue = Array.from(files).slice(1);
  waOpenMediaModal(files[0]);
}

let _waPendingFileQueue = [];

// Buka preview modal untuk file yg akan dikirim
function waOpenMediaModal(file) {
  if (!file) return;
  if (!isConnected()) { App.showToast('Session belum terhubung', 'error'); return; }
  if (!_currentContact) { App.showToast('Pilih kontak dulu', 'error'); return; }

  // Limit 64MB (sama dengan WA Web)
  const MAX = 64 * 1024 * 1024;
  if (file.size > MAX) {
    App.showToast('File terlalu besar. Maks 64MB.', 'error');
    return;
  }

  _waPendingFile = file;
  if (_waPendingPreviewUrl) { URL.revokeObjectURL(_waPendingPreviewUrl); _waPendingPreviewUrl = null; }

  const modal  = document.getElementById('waMediaModal');
  const area   = document.getElementById('waMediaPreview');
  const title  = document.getElementById('waMediaModalTitle');
  const sub    = document.getElementById('waMediaModalSub');
  const captionEl = document.getElementById('waMediaCaption');
  if (!modal || !area) return;

  captionEl.value = '';
  captionEl.style.height = '';

  const mime = file.type || '';
  const sizeStr = waFormatFileSize(file.size);

  if (mime.startsWith('image/')) {
    _waPendingPreviewUrl = URL.createObjectURL(file);
    area.innerHTML = '<img src="' + _waPendingPreviewUrl + '" alt="preview">';
    title.textContent = 'Kirim Foto';
    sub.textContent = (file.name || 'gambar') + ' · ' + sizeStr;
  } else if (mime.startsWith('video/')) {
    _waPendingPreviewUrl = URL.createObjectURL(file);
    area.innerHTML = '<video src="' + _waPendingPreviewUrl + '" controls></video>';
    title.textContent = 'Kirim Video';
    sub.textContent = (file.name || 'video') + ' · ' + sizeStr;
  } else {
    // Dokumen — tampilkan card
    const fname = esc(file.name || 'dokumen');
    area.innerHTML =
      '<div class="wa-media-preview-doc">' +
        '<div class="wa-media-preview-doc-ico">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="13" y2="11"/></svg>' +
        '</div>' +
        '<div class="wa-media-preview-doc-info">' +
          '<div class="wa-media-preview-doc-name">' + fname + '</div>' +
          '<div class="wa-media-preview-doc-size">' + sizeStr + '</div>' +
        '</div>' +
      '</div>';
    title.textContent = 'Kirim Dokumen';
    sub.textContent = sizeStr;
  }

  modal.classList.add('show');
  setTimeout(() => captionEl.focus(), 100);
}

function waCloseMediaModal() {
  const modal = document.getElementById('waMediaModal');
  if (modal) modal.classList.remove('show');
  if (_waPendingPreviewUrl) { URL.revokeObjectURL(_waPendingPreviewUrl); _waPendingPreviewUrl = null; }
  _waPendingFile = null;
  // Buang queue kalau user batal
  _waPendingFileQueue = [];
}

function waFormatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024) return (bytes/(1024*1024)).toFixed(1) + ' MB';
  return (bytes/(1024*1024*1024)).toFixed(2) + ' GB';
}

// Kirim media dari modal (klik tombol kirim)
async function waSendMediaFromModal() {
  if (!_waPendingFile) return;
  if (!_currentSession || !_currentContact) return;

  const caption = document.getElementById('waMediaCaption')?.value.trim() || '';
  const file = _waPendingFile;
  const btn  = document.getElementById('waMediaSendBtn');
  if (btn) btn.disabled = true;

  // Cache reference sebelum close
  const nextFile = _waPendingFileQueue.shift();

  try {
    // Tutup modal dulu, bubble optimistic langsung muncul
    const modal = document.getElementById('waMediaModal');
    if (modal) modal.classList.remove('show');

    // Render bubble optimistic
    const bubbleEl = waAppendOptimisticMediaBubble(file, caption);

    // Upload via multipart
    await waUploadAndSend(file, caption, bubbleEl);

  } catch(e) {
    App.showToast('Gagal kirim: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (_waPendingPreviewUrl) { URL.revokeObjectURL(_waPendingPreviewUrl); _waPendingPreviewUrl = null; }
    _waPendingFile = null;
  }

  // Kirim file berikutnya di queue (untuk multi-select)
  if (nextFile) {
    setTimeout(() => waOpenMediaModal(nextFile), 300);
  }
}

// Render bubble out optimistic dengan preview + loading overlay
function waAppendOptimisticMediaBubble(file, caption) {
  const wrap = document.getElementById('messagesWrap');
  if (!wrap) return null;
  const div = document.createElement('div');
  div.className = 'wa-msg-row out';

  const mime = file.type || '';
  const timeStr = new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit' });
  const blobUrl = URL.createObjectURL(file);

  let body = '';
  if (mime.startsWith('image/')) {
    body =
      '<div class="wa-media-wrap" style="position:relative">' +
        '<img src="' + blobUrl + '" class="wa-media-img" alt="Gambar" loading="lazy">' +
        (caption ? '<div class="wa-media-caption">' + esc(caption) + '</div>' : '') +
        '<div class="wa-upload-overlay"><div class="wa-upload-ring"></div></div>' +
      '</div>';
  } else if (mime.startsWith('video/')) {
    body =
      '<div class="wa-media-wrap" style="position:relative">' +
        '<video src="' + blobUrl + '" class="wa-media-video" preload="metadata"></video>' +
        (caption ? '<div class="wa-media-caption">' + esc(caption) + '</div>' : '') +
        '<div class="wa-upload-overlay"><div class="wa-upload-ring"></div></div>' +
      '</div>';
  } else {
    const fname = esc(file.name || 'dokumen');
    body =
      '<div class="wa-media-wrap wa-doc-wrap" style="position:relative">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0;opacity:0.6;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13px;font-weight:500;word-break:break-all;">' + fname + '</div>' +
          '<div style="font-size:11px;color:#8696a0;">' + waFormatFileSize(file.size) + '</div>' +
        '</div>' +
        '<div class="wa-upload-overlay"><div class="wa-upload-ring"></div></div>' +
      '</div>';
  }

  div.innerHTML = '<div class="wa-bubble out wa-bubble-uploading">' + body +
    '<span class="wa-bubble-meta"><span class="wa-bubble-time">' + timeStr + '</span>' + renderTick('pending') + '</span>' +
  '</div>';
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;

  // Simpan blobUrl di element supaya bisa di-revoke saat bubble digantikan
  const bubble = div.querySelector('.wa-bubble');
  if (bubble) bubble._blobUrl = blobUrl;
  return bubble;
}

// Upload file via FormData ke /api/wa/send-media
async function waUploadAndSend(file, caption, bubbleEl) {
  const fd = new FormData();
  fd.append('session_id', _currentSession.session_id);
  let sendTo = _currentContact.replyJid || _currentContact.number;
  if (sendTo && !sendTo.includes('@') && sendTo.length > 13) sendTo = sendTo + '@lid';
  fd.append('to', sendTo);
  if (caption) fd.append('caption', caption);
  fd.append('file', file);

  // Pakai App.token untuk auth (sama seperti App.api)
  const token = (window.App && App.token) || localStorage.getItem('token') || '';
  const r = await fetch('/api/wa/send-media', {
    method: 'POST',
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    body: fd
  });
  const d = await r.json().catch(() => ({ success: false, message: 'Response invalid' }));

  // Clean up upload overlay
  if (bubbleEl) {
    const ov = bubbleEl.querySelector('.wa-upload-overlay');
    if (ov) ov.remove();
    bubbleEl.classList.remove('wa-bubble-uploading');
  }

  if (!d?.success) {
    // Tandai bubble gagal
    if (bubbleEl) {
      const tickEl = bubbleEl.querySelector('.wa-tick');
      if (tickEl) tickEl.outerHTML = renderTick('failed');
    }
    App.showToast(d?.message || 'Gagal kirim media', 'error');
    return;
  }

  // Attach wa_message_id ke bubble supaya ACK tracker bisa update tick-nya
  const waId = d?.data?.key?.id;
  if (waId && bubbleEl) bubbleEl.setAttribute('data-wa-id', waId);
}

// ── Paste handler (Ctrl+V image) ──────────────────────────────
function waOnChatPaste(ev) {
  if (!ev?.clipboardData) return;
  const items = ev.clipboardData.items || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const file = it.getAsFile();
      if (file) {
        ev.preventDefault();
        // Rename "image.png" dari clipboard jadi lebih informatif
        const renamed = new File([file], 'paste_' + Date.now() + '.' + (file.type.split('/')[1] || 'png'), { type: file.type });
        waOpenMediaModal(renamed);
        return;
      }
    }
  }
  // Kalau bukan image, biarkan paste berjalan normal (teks)
}

// ── Drag & drop handler ───────────────────────────────────────
function waInitDragDrop() {
  const panel = document.querySelector('.wa-chat-panel');
  const overlay = document.getElementById('waDragOverlay');
  if (!panel || !overlay) return;
  let dragCounter = 0;

  panel.addEventListener('dragenter', (e) => {
    if (!_currentContact) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounter++;
    overlay.classList.add('show');
  });
  panel.addEventListener('dragover', (e) => {
    if (!_currentContact) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  panel.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('show'); }
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0; overlay.classList.remove('show');
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    if (!_currentContact) { App.showToast('Pilih kontak dulu', 'error'); return; }
    _waPendingFileQueue = Array.from(files).slice(1);
    waOpenMediaModal(files[0]);
  });
}
document.addEventListener('DOMContentLoaded', waInitDragDrop);

// Expose ke window
window.waToggleAttachMenu = waToggleAttachMenu;
window.waPickFile        = waPickFile;
window.waOnFilePicked    = waOnFilePicked;
window.waCloseMediaModal = waCloseMediaModal;
window.waSendMediaFromModal = waSendMediaFromModal;
window.waOnChatPaste     = waOnChatPaste;

// ── QR ────────────────────────────────────────────────────────
function startQrPoll() {
  _qrWaitTicks = 0;
  stopQrPoll(); pollQr();
  _qrPollTimer = setInterval(pollQr, 3000);
}
function stopQrPoll() { if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null; } stopQrCountdown(); }

async function pollQr() {
  if (!_currentSession) return;
  try {
    const d = await App.api('/wa/sessions/' + _currentSession.session_id + '/qr?_=' + Date.now(), { cache:'no-store', headers:{'Cache-Control':'no-cache'} });
    if (d?.success) {
      // Status "connected" dulu dihandle supaya tidak render QR lagi setelahnya
      if (d.data?.status === 'connected') {
        stopQrPoll();
        stopQrCountdown();
        setQrStatus('connected', 'Terhubung');
        showQrConnectedSuccess();
        _currentSession.runtime_status = 'connected';
        setTimeout(function() { updateSessionUI(); loadMessages(); }, 900);
        return;
      }
      const age = d.data?.age || 0;
      if (d.data?.qr_image && age < 25000) {
        renderQr(d.data.qr_image, age);
        _qrWaitTicks = 0;
      } else if (d.data?.qr_image && age >= 25000) {
        setQrStatus('expired', 'QR kedaluwarsa · menunggu refresh');
      } else if (d.data?.qr_pending || d.data?.sub_status === 'STARTING') {
        // WAHA sedang menyiapkan (buka WhatsApp Web) — QR belum siap, ~5-15 dtk.
        setQrStatus('waiting', 'Menyiapkan QR...');
        showQrLoading('WAHA sedang menyiapkan QR code, tunggu sebentar...');
        _qrWaitTicks = (_qrWaitTicks || 0) + 1;
      } else if (d.data?.status === 'disconnected') {
        // WAHA menolak / session gagal dibuat. Beri info + tombol coba lagi,
        // jangan biarkan berputar "Refresh QR" tanpa akhir.
        setQrStatus('expired', 'Gagal menyiapkan QR');
        showQrLoading('Tidak bisa menyiapkan QR. Klik tombol ⟳ untuk coba lagi, atau cek koneksi/URL WAHA.');
      } else {
        // qr_image null tapi masih connecting tanpa sub_status STARTING → tunggu,
        // tapi setelah ~10 tick (30 dtk) beri petunjuk agar user tidak bingung.
        _qrWaitTicks = (_qrWaitTicks || 0) + 1;
        if (_qrWaitTicks >= 10) {
          showQrLoading('QR belum muncul. Klik ⟳ untuk refresh, atau restart session WAHA bila tetap gagal.');
        }
      }
    }
  } catch(e) {}
}

function renderQr(qrUrl, age) {
  const w = document.getElementById('qrWrapper');
  if (!w) return;
  w.innerHTML =
    '<img src="' + qrUrl + '" alt="QR code WhatsApp">' +
    '<span class="wa-qr-corner-bl"></span><span class="wa-qr-corner-br"></span>';
  setQrStatus('active', 'QR siap discan');
  const remain = Math.max(0, 25000 - (age || 0));
  startQrCountdown(remain);
}

async function connectCurrentSession() {
  if (!_currentSession) return;
  const btn = document.getElementById('btnConnectQR');
  btn.disabled = true; btn.textContent = 'Menghubungkan...';
  const d = await App.api('/wa/sessions/' + _currentSession.session_id + '/connect', { method:'POST' });
  btn.disabled = false; btn.textContent = 'Hubungkan';
  if (d?.success) {
    // Provider Fonnte: tidak ada QR — verifikasi token langsung selesai.
    if (_currentSession.provider === 'fonnte') {
      _currentSession.runtime_status = 'connected';
      updateSessionUI();
      await loadSessions();
      App.showToast(d.message || 'Device Fonnte terhubung', 'success');
      return;
    }
    _currentSession.runtime_status = 'connecting'; updateSessionUI();
    App.showToast('Menghubungkan... tunggu QR muncul', 'info'); setTimeout(startQrPoll, 1500);
  } else App.showToast(d?.message || 'Gagal', 'error');
}

// ── SESSION DELETE ─────────────────────────────────────────────
// State untuk menyimpan session yang sedang akan dihapus (bisa berbeda dari _currentSession)
let _pendingDeleteSessionId = null;

function confirmDeleteSession() {
  // Dipanggil dari tombol "Hapus Session" di panel profil => hapus session aktif
  if (!_currentSession) { App.showToast('Tidak ada session aktif', 'error'); return; }
  confirmDeleteSessionById(_currentSession.session_id);
}

function confirmDeleteSessionById(sessionId) {
  if (!sessionId) return;
  const sess = _sessions.find(s => s.session_id === sessionId);
  const name = sess?.name || sessionId;
  _pendingDeleteSessionId = sessionId;

  const modal = document.getElementById('deleteSessionModal');
  const nameEl = document.getElementById('deleteSessionName');
  if (nameEl) nameEl.textContent = name;
  if (modal) {
    modal.style.display = 'flex';
  } else {
    // Fallback kalau modal belum terpasang di DOM
    if (confirm('Hapus session "' + name + '"?\nSemua data auth dan log percakapan session ini akan hilang permanen.')) {
      doDeleteSessionById(sessionId);
    }
  }
}

function closeDeleteSessionModal() {
  const modal = document.getElementById('deleteSessionModal');
  if (modal) modal.style.display = 'none';
  _pendingDeleteSessionId = null;
}

async function confirmDeleteModalProceed() {
  const sid = _pendingDeleteSessionId;
  closeDeleteSessionModal();
  if (!sid) return;
  await doDeleteSessionById(sid);
}

// Alias untuk kompatibilitas mundur — tombol lama di panel profil masih bisa panggil ini
async function doDeleteSession() {
  if (!_currentSession) return;
  await doDeleteSessionById(_currentSession.session_id);
}

async function doDeleteSessionById(sessionId) {
  if (!sessionId) return;
  const btn = document.getElementById('btnConfirmDeleteSession');
  const origTxt = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Menghapus...'; }

  const d = await App.api('/wa/sessions/' + sessionId, { method: 'DELETE' });

  if (btn) { btn.disabled = false; if (origTxt) btn.textContent = origTxt; }

  if (d?.success) {
    App.showToast('Session berhasil dihapus', 'success');

    // Jika session yang dihapus adalah session aktif => reset state
    if (_currentSession && _currentSession.session_id === sessionId) {
      _currentSession = null;
      _allMessages = [];
      _contacts = [];
      stopQrPoll && stopQrPoll();
    }

    // Hapus dari list lokal supaya UI langsung terupdate tanpa nunggu API
    _sessions = _sessions.filter(s => s.session_id !== sessionId);

    await loadSessions();

    // Pilih session lain kalau masih ada, kalau kosong tampilkan empty state
    if (_sessions.length > 0 && !_currentSession) {
      selectSession(_sessions[0].session_id);
    } else if (_sessions.length === 0) {
      const empty = document.getElementById('chatEmpty');
      if (empty) empty.style.display = 'flex';
      hide('chatQR'); hide('chatActive');
      // Bersihkan contact list
      const cl = document.getElementById('contactList');
      if (cl) cl.innerHTML = '<div style="text-align:center;padding:40px;color:#667781;font-size:13px;">Belum ada session aktif</div>';
    }
  } else {
    App.showToast(d?.message || 'Gagal menghapus session', 'error');
  }
}

// ── SESSION CONTEXT MENU (klik kanan pada chip) ────────────────
let _ctxMenuTarget = null;

function openSessionCtxMenu(ev, sessionId) {
  ev.preventDefault();
  ev.stopPropagation();
  _ctxMenuTarget = sessionId;
  const menu = document.getElementById('waSessionCtxMenu');
  if (!menu) return;
  menu.classList.add('open');
  // Posisikan dalam viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 200, mh = 140;
  const x = Math.min(ev.clientX, vw - mw - 8);
  const y = Math.min(ev.clientY, vh - mh - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeSessionCtxMenu() {
  const menu = document.getElementById('waSessionCtxMenu');
  if (menu) menu.classList.remove('open');
}

function sessionCtxSelect() {
  const sid = _ctxMenuTarget;
  closeSessionCtxMenu();
  if (sid) selectSession(sid);
}

async function sessionCtxDisconnect() {
  const sid = _ctxMenuTarget;
  closeSessionCtxMenu();
  if (!sid) return;
  const sess = _sessions.find(s => s.session_id === sid);
  const name = sess?.name || sid;
  if (!confirm('Putuskan session "' + name + '"?\nSession akan di-logout tapi tidak dihapus.')) return;
  const d = await App.api('/wa/sessions/' + sid + '/disconnect', { method: 'POST' });
  if (d?.success) {
    App.showToast('Session "' + name + '" diputus', 'success');
    await loadSessions();
    if (_currentSession?.session_id === sid) {
      _currentSession.runtime_status = 'disconnected';
      updateSessionUI();
    }
  } else {
    App.showToast(d?.message || 'Gagal memutuskan session', 'error');
  }
}

function sessionCtxDelete() {
  const sid = _ctxMenuTarget;
  closeSessionCtxMenu();
  if (sid) confirmDeleteSessionById(sid);
}

// Tutup context menu saat klik di luar atau scroll
document.addEventListener('click', (e) => {
  const menu = document.getElementById('waSessionCtxMenu');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target)) {
    closeSessionCtxMenu();
  }
});
document.addEventListener('scroll', closeSessionCtxMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSessionCtxMenu(); });

async function disconnectSession() {
  if (!_currentSession || !confirm('Putuskan session ini?')) return;
  const d = await App.api('/wa/sessions/' + _currentSession.session_id + '/disconnect', { method:'POST' });
  if (d?.success) { _currentSession.runtime_status = 'disconnected'; updateSessionUI(); loadSessions(); App.showToast('Session diputus', 'success'); }
  else App.showToast(d?.message || 'Gagal', 'error');
}

// ── PROFILE PANEL ─────────────────────────────────────────────
async function renderProfile(contact) {
  const el = document.getElementById('profileContent');
  if (!el) return;
  const displayName = getDisplayName(contact);
  const color = AVATAR_COLORS[hashCode(contact.number) % AVATAR_COLORS.length];
  const c = contact.customer;
  const rules = _currentSession ? (await App.api('/wa/sessions/' + _currentSession.session_id + '/auto-reply'))?.data || [] : [];
  _autoRules = rules; // simpan utk dipakai openEditRule()

  function statusStyle(s) {
    if (s === 'active')   return 'background:#dcfce7;color:#166534;';
    if (s === 'isolated') return 'background:#fee2e2;color:#dc2626;';
    return 'background:#f1f5f9;color:#64748b;';
  }

  function row(icon, label, val, extra) {
    if (!val) return '';
    return '<div class="wa-profile-row">' +
      '<div class="wa-profile-row-icon">' + icon + '</div>' +
      '<div class="wa-profile-row-content">' +
        '<div class="wa-profile-row-label">' + label + '</div>' +
        '<div class="wa-profile-row-val" ' + (extra||'') + '>' + val + '</div>' +
      '</div></div>';
  }

  var html = '';

  // Fetch profile pic jika belum pernah dicoba
  if (_picUntried(contact.number)) {
    fetchProfilePic(contact.number).then(() => renderProfile(contact));
  }
  const profilePic = _picGet(contact.number);
  const initial0 = displayName[0].toUpperCase();
  const avatarImg = profilePic ? ('<img src="' + profilePic + '" style="width:76px;height:76px;object-fit:cover;display:block;border-radius:50%;">') : '';
  const avatarContent = profilePic ? avatarImg : initial0;
  const avatarStyle = 'background:' + color + ';overflow:hidden;display:flex;align-items:center;justify-content:center;';

  // Avatar — header bergradien biru seperti referensi
  const statusLabel = c ? c.status : '';
  const pkgLabel    = c?.package?.name || '';
  html += '<div style="background:linear-gradient(135deg,#1a6ef5,#0047cc);padding:20px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;">' +
    '<div class="wa-profile-avatar-lg" style="' + avatarStyle + 'width:68px;height:68px;font-size:26px;box-shadow:0 4px 16px rgba(0,0,0,.25);">' + avatarContent + '</div>' +
    '<div style="text-align:center;">' +
      '<div style="font-size:16px;font-weight:700;color:#fff;">' + esc(displayName) + '</div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,.75);margin-top:2px;">' + (getDisplayPhone(contact) || 'WhatsApp User') + '</div>' +
      '<div style="display:flex;gap:6px;justify-content:center;margin-top:6px;flex-wrap:wrap;">' +
        (statusLabel ? '<span style="background:rgba(255,255,255,.2);color:#fff;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;">' + esc(statusLabel) + '</span>' : '') +
        (pkgLabel ? '<span style="background:rgba(255,255,255,.15);color:#fff;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:20px;">' + esc(pkgLabel) + '</span>' : '') +
      '</div>' +
    '</div>' +
  '</div>';

  // Info Pelanggan
  if (c) {
    var pkgColor = getPackageColor(c.package?.name || '');
    var pkgVal = esc(c.package?.name || '—') + (c.package ? ' <span style="font-size:10px;color:#667781;font-weight:400;">↓' + c.package.speed_down + 'M/↑' + c.package.speed_up + 'M</span>' : '');
    html += '<div class="wa-profile-section">' +
      '<div class="wa-profile-section-title">' + IC.user + ' Info Pelanggan</div>' +
      row(IC.user, 'Nama', esc(c.name||'—')) +
      row(IC.id, 'ID Pelanggan', esc(c.customer_id||'—')) +
      row(IC.phone, 'No. HP', esc(c.phone||'—')) +
      (c.email ? row(IC.email, 'Email', esc(c.email)) : '') +
      '<div class="wa-profile-row"><div class="wa-profile-row-icon">' + IC.package + '</div><div class="wa-profile-row-content"><div class="wa-profile-row-label">Paket</div><div class="wa-profile-row-val" style="color:' + pkgColor + ';">' + pkgVal + '</div></div></div>' +
      '<div class="wa-profile-row"><div class="wa-profile-row-icon">' + IC.status + '</div><div class="wa-profile-row-content"><div class="wa-profile-row-label">Status</div><div class="wa-profile-row-val"><span style="' + statusStyle(c.status) + 'padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;">' + esc(c.status||'—') + '</span></div></div></div>' +
      (c.address ? row(IC.address, 'Alamat', esc(c.address), 'style="font-size:12px;"') : '') +
    '</div>';
  }

  // Auto Reply
  var autoReplyOn = _currentSession?.auto_reply_enabled || false;
  var rulesHtml = rules.length ? rules.map(r =>
    '<div class="wa-autorule">' +
      '<div style="flex:1;min-width:0;cursor:pointer;" onclick="openEditRule(' + r.id + ')" title="Klik untuk edit">' +
        '<div class="wa-autorule-keyword">' + esc(r.keyword) + ' <span style="font-size:10px;color:#adb5bd;font-weight:400;">[' + r.match_type + ']</span></div>' +
        '<div class="wa-autorule-reply">' + esc(r.reply_message) + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
        '<span class="wa-autorule-dot" style="background:' + (r.is_active ? '#25d366' : '#ccc') + ';"></span>' +
        '<button onclick="openEditRule(' + r.id + ')" title="Edit" style="background:none;border:none;cursor:pointer;color:#8696a0;padding:0;line-height:1;display:inline-flex;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
        '</button>' +
        '<button onclick="deleteRule(' + r.id + ')" title="Hapus" style="background:none;border:none;cursor:pointer;color:#e57373;padding:0;line-height:1;display:inline-flex;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>'
  ).join('') : '<div style="font-size:12px;color:#adb5bd;padding:4px 0;">Belum ada rule</div>';

  // Toggle switch HTML
  var toggleHtml = '<label class="wa-toggle" title="' + (autoReplyOn ? 'Auto-reply aktif' : 'Auto-reply nonaktif') + '">' +
    '<input type="checkbox" onchange="toggleAutoReply(this.checked)" ' + (autoReplyOn ? 'checked' : '') + '>' +
    '<span class="wa-toggle-slider"></span>' +
  '</label>';

  html += '<div class="wa-profile-section">' +
    '<div class="wa-profile-section-title" style="justify-content:space-between;">' +
      '<span style="display:flex;align-items:center;gap:6px;">' + IC.reply + ' Auto-Reply ' + toggleHtml + '</span>' +
      '<button onclick="openAddRule()" style="display:inline-flex;align-items:center;gap:3px;background:#25d366;color:#fff;border:none;border-radius:20px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600;">' + IC.plus + ' Tambah</button>' +
    '</div>' + rulesHtml + '</div>';

  // Aksi Cepat
  html += '<div class="wa-profile-section">' +
    '<div class="wa-profile-section-title">' + IC.broadcast + ' Aksi Cepat</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;">' +
      '<button onclick="openBroadcast()" class="wa-quick-btn">' + IC.broadcast + ' Broadcast ke semua</button>' +
      '<button onclick="openModal(\'reminderModal\')" class="wa-quick-btn">' + IC.bell + ' Kirim Reminder Invoice</button>' +
      '<button onclick="openTemplates()" class="wa-quick-btn">' + IC.template + ' Kelola Template</button>' +
      '<button onclick="disconnectSession()" class="wa-quick-btn danger">' + IC.disconnect + ' Putus Session</button>' +
      '<button onclick="confirmDeleteSession()" class="wa-quick-btn danger" style="border-color:#dc2626;">' + IC.disconnect + ' Hapus Session</button>' +
    '</div></div>';

  el.innerHTML = html;
}

async function toggleAutoReply(enabled) {
  if (!_currentSession) return;
  const d = await App.api('/wa/sessions/' + _currentSession.session_id, {
    method: 'PUT',
    body: JSON.stringify({ auto_reply_enabled: enabled })
  });
  if (d?.success) {
    _currentSession.auto_reply_enabled = enabled;
    // Update sessions list
    const s = _sessions.find(x => x.session_id === _currentSession.session_id);
    if (s) s.auto_reply_enabled = enabled;
    App.showToast('Auto-reply ' + (enabled ? 'diaktifkan' : 'dinonaktifkan'), 'success');
  } else {
    App.showToast(d?.message || 'Gagal', 'error');
    // Revert toggle
    if (_currentContact) renderProfile(_currentContact);
  }
}

async function deleteRule(ruleId) {
  if (!confirm('Hapus rule ini?')) return;
  const d = await App.api('/wa/auto-reply/' + ruleId, { method: 'DELETE' });
  if (d?.success) {
    App.showToast('Rule dihapus', 'success');
    if (_currentContact) renderProfile(_currentContact);
  } else App.showToast(d?.message || 'Gagal', 'error');
}

function showProfile() { if (_currentContact) renderProfile(_currentContact); }

// ── ADD SESSION ───────────────────────────────────────────────
function openAddSession() { openModal('addSessionModal'); }

// ── Pengaturan session default untuk pengiriman otomatis ──────
async function openDefaultSessionModal() {
  const sel = document.getElementById('defaultSessionSelect');
  if (!sel) return;
  // Isi opsi dari daftar session, beri label provider + status
  let opts = '<option value="">(Otomatis — session terhubung paling awal)</option>';
  _sessions.forEach(s => {
    const provLabel = (s.provider === 'fonnte') ? 'Fonnte' : (s.provider === 'waha') ? 'WAHA' : 'Baileys';
    const st = (s.runtime_status || s.status || 'disconnected');
    const stLabel = st === 'connected' ? 'Connected' : '' + st;
    opts += `<option value="${s.session_id}">${s.name} — ${provLabel} (${stLabel})</option>`;
  });
  sel.innerHTML = opts;

  // Ambil nilai tersimpan dari app-settings
  try {
    const d = await App.api('/app-settings');
    const current = d?.data?.default_wa_session || '';
    sel.value = current;
  } catch (_) {}

  openModal('defaultSessionModal');
}

async function saveDefaultSession() {
  const sel = document.getElementById('defaultSessionSelect');
  if (!sel) return;
  const d = await App.api('/app-settings', {
    method: 'POST',
    body: JSON.stringify({ default_wa_session: sel.value })
  });
  if (d?.success) {
    closeModal('defaultSessionModal');
    App.showToast('Pengaturan session otomatis disimpan', 'success');
  } else App.showToast(d?.message || 'Gagal menyimpan', 'error');
}
window.openDefaultSessionModal = openDefaultSessionModal;
window.saveDefaultSession      = saveDefaultSession;

async function saveNewSession() {
  const name = document.getElementById('newSessionName').value.trim();
  if (!name) { App.showToast('Nama session wajib', 'error'); return; }
  const provider = document.getElementById('newSessionProvider').value;
  const fonnteToken = document.getElementById('newSessionFonnteToken').value.trim();
  if (provider === 'fonnte' && !fonnteToken) {
    App.showToast('Token Fonnte wajib diisi', 'error'); return;
  }
  const wahaUrl = (document.getElementById('newSessionWahaUrl')?.value || '').trim();
  if (provider === 'waha') {
    if (!wahaUrl) { App.showToast('URL WAHA wajib diisi', 'error'); return; }
    if (!/^https?:\/\//i.test(wahaUrl)) { App.showToast('URL WAHA harus diawali http:// atau https://', 'error'); return; }
  }
  const payload = {
    name,
    notes: document.getElementById('newSessionNotes').value,
    provider,
    fonnte_token: provider === 'fonnte' ? fonnteToken : null,
    waha_url:     provider === 'waha' ? wahaUrl : null,
    waha_api_key: provider === 'waha' ? (document.getElementById('newSessionWahaApiKey')?.value || '').trim() : null,
    waha_session: provider === 'waha' ? ((document.getElementById('newSessionWahaSession')?.value || '').trim() || 'default') : null,
  };
  const d = await App.api('/wa/sessions', { method:'POST', body:JSON.stringify(payload) });
  if (d?.success) {
    closeModal('addSessionModal');
    document.getElementById('newSessionName').value = '';
    document.getElementById('newSessionNotes').value = '';
    document.getElementById('newSessionFonnteToken').value = '';
    const wu = document.getElementById('newSessionWahaUrl');    if (wu) wu.value = '';
    const wk = document.getElementById('newSessionWahaApiKey'); if (wk) wk.value = '';
    const ws = document.getElementById('newSessionWahaSession');if (ws) ws.value = 'default';
    document.getElementById('newSessionProvider').value = 'baileys';
    toggleFonnteToken();
    await loadSessions();
    selectSession(d.data.session_id);
    App.showToast('Session dibuat', 'success');
  } else App.showToast(d?.message || 'Gagal', 'error');
}

// Tampilkan/sembunyikan grup field per provider (Fonnte / WAHA).
// Nama fungsi dipertahankan karena dipanggil inline onchange di EJS.
function toggleFonnteToken() {
  const prov = document.getElementById('newSessionProvider')?.value;
  const grp  = document.getElementById('fonnteTokenGroup');
  if (grp) grp.style.display = (prov === 'fonnte') ? 'block' : 'none';
  const wgrp = document.getElementById('wahaConfigGroup');
  if (wgrp) wgrp.style.display = (prov === 'waha') ? 'block' : 'none';
  // Isi webhook URL otomatis dari origin aplikasi saat ini
  const wh = document.getElementById('fonnteWebhookUrl');
  if (wh && prov === 'fonnte') wh.textContent = window.location.origin + '/portal/webhook/fonnte';
  const wwh = document.getElementById('wahaWebhookUrl');
  if (wwh && prov === 'waha') wwh.textContent = window.location.origin + '/portal/webhook/waha';
}
window.toggleFonnteToken = toggleFonnteToken;

// ── AUTO REPLY ────────────────────────────────────────────────
function openAddRule() {
  _ruleEditId = null;
  document.getElementById('ruleModalTitle').textContent = 'Tambah Auto Reply';
  document.getElementById('ruleKeyword').value = '';
  document.getElementById('ruleMatchType').value = 'contains';
  document.getElementById('ruleReply').value = '';
  openModal('ruleModal');
}

// Edit rule yang sudah ada: isi form dari data rule lalu buka modal (mode PUT).
function openEditRule(ruleId) {
  const rule = (_autoRules || []).find(r => String(r.id) === String(ruleId));
  if (!rule) { App.showToast('Rule tidak ditemukan', 'error'); return; }
  _ruleEditId = rule.id;
  document.getElementById('ruleModalTitle').textContent = 'Edit Auto Reply';
  document.getElementById('ruleKeyword').value = rule.keyword || '';
  document.getElementById('ruleMatchType').value = rule.match_type || 'contains';
  document.getElementById('ruleReply').value = rule.reply_message || '';
  openModal('ruleModal');
}

async function saveRule() {
  if (!_currentSession) return;
  const payload = {
    keyword: document.getElementById('ruleKeyword').value.trim(),
    match_type: document.getElementById('ruleMatchType').value,
    reply_message: document.getElementById('ruleReply').value.trim()
  };
  if (!payload.keyword || !payload.reply_message) { App.showToast('Keyword dan balasan wajib', 'error'); return; }
  const url    = _ruleEditId ? '/wa/auto-reply/' + _ruleEditId : '/wa/sessions/' + _currentSession.session_id + '/auto-reply';
  const method = _ruleEditId ? 'PUT' : 'POST';
  const d = await App.api(url, { method, body:JSON.stringify(payload) });
  if (d?.success) { closeModal('ruleModal'); if (_currentContact) renderProfile(_currentContact); App.showToast('Tersimpan', 'success'); }
  else App.showToast(d?.message || 'Gagal', 'error');
}

// ── TEMPLATES ─────────────────────────────────────────────────
async function openTemplates() {
  const d = await App.api('/wa/templates');
  if (!d?.success) return;
  App.showToast(d.data.length + ' template tersedia', 'info');
}
function openAddTemplate() {
  _tmplEditId = null;
  document.getElementById('tmplModalTitle').textContent = 'Tambah Template';
  document.getElementById('tmplName').value = '';
  document.getElementById('tmplMessage').value = '';
  document.getElementById('tmplCategory').value = 'custom';
  openModal('templateModal');
}
async function saveTemplate() {
  const payload = {
    name: document.getElementById('tmplName').value.trim(),
    category: document.getElementById('tmplCategory').value,
    message: document.getElementById('tmplMessage').value.trim()
  };
  if (!payload.name || !payload.message) { App.showToast('Nama dan pesan wajib', 'error'); return; }
  const url = _tmplEditId ? '/wa/templates/' + _tmplEditId : '/wa/templates';
  const d = await App.api(url, { method: _tmplEditId ? 'PUT' : 'POST', body:JSON.stringify(payload) });
  if (d?.success) { closeModal('templateModal'); App.showToast('Template tersimpan', 'success'); }
  else App.showToast(d?.message || 'Gagal', 'error');
}

// ── BROADCAST ─────────────────────────────────────────────────
async function openBroadcast() {
  _bcNumbers = [];
  renderBcTags();
  const d = await App.api('/wa/templates');
  const sel = document.getElementById('bcTemplate');
  sel.innerHTML = '<option value="">-- Tulis manual --</option>' + (d?.data||[]).map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('');
  openModal('broadcastModal');
}
function addBcNumber() {
  const inp = document.getElementById('bcNumberInput');
  const num = inp.value.trim().replace(/\D/g, '');
  if (!num || _bcNumbers.includes(num)) return;
  _bcNumbers.push(num); renderBcTags(); inp.value = '';
}
async function loadCustomerNumbers() {
  const d = await App.api('/customers?limit=200&status=active');
  if (!d?.success) return;
  d.data.forEach(c => { const n = (c.phone||'').replace(/\D/g,''); if (n && !_bcNumbers.includes(n)) _bcNumbers.push(n); });
  renderBcTags(); App.showToast(d.data.length + ' nomor dimuat', 'success');
}
function renderBcTags() {
  const el = document.getElementById('bcTags');
  if (!_bcNumbers.length) {
    el.innerHTML = '<span style="font-size:12px;color:#adb5bd;padding:2px 2px;">Belum ada nomor. Ketik lalu klik Tambah, atau Impor dari pelanggan.</span>';
    setText('bcCount', '0 nomor');
    return;
  }
  el.innerHTML = _bcNumbers.map((n,i) =>
    '<span style="background:#e7f0ff;color:#1a6ef5;border-radius:6px;padding:3px 8px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:5px;">' +
    n + '<button onclick="removeBcNumber(' + i + ')" title="Hapus" style="background:none;border:none;cursor:pointer;color:#1a6ef5;line-height:0;padding:0;display:inline-flex;">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
    '</button></span>'
  ).join('');
  setText('bcCount', _bcNumbers.length + ' nomor');
}
window.removeBcNumber = function(i) { _bcNumbers.splice(i,1); renderBcTags(); };
async function fillBcFromTemplate() {
  const id = document.getElementById('bcTemplate').value;
  if (!id) return;
  const d = await App.api('/wa/templates');
  const t = d?.data?.find(x => String(x.id) === id);
  if (t) document.getElementById('bcMsg').value = t.message;
}
async function sendBroadcast() {
  if (!_currentSession || !isConnected()) { App.showToast('Session belum terhubung', 'error'); return; }
  const msg = document.getElementById('bcMsg').value.trim();
  if (!_bcNumbers.length || !msg) { App.showToast('Nomor dan pesan wajib', 'error'); return; }
  if (!confirm('Kirim broadcast ke ' + _bcNumbers.length + ' nomor?')) return;
  const d = await App.api('/wa/broadcast', { method:'POST', body:JSON.stringify({ session_id:_currentSession.session_id, numbers:_bcNumbers, message:msg }) });
  if (d?.success) { closeModal('broadcastModal'); App.showToast(d.message, 'success'); }
  else App.showToast(d?.message || 'Gagal', 'error');
}

// ── REMINDER ─────────────────────────────────────────────────
async function sendReminders() {
  if (!_currentSession || !isConnected()) { App.showToast('Session belum terhubung', 'error'); return; }
  const days = parseInt(document.getElementById('reminderDays').value) || 3;
  const el   = document.getElementById('reminderResult');
  el.innerHTML = '<div style="color:#667781;font-size:13px;">Mengirim...</div>';
  const d = await App.api('/wa/reminders', { method:'POST', body:JSON.stringify({ session_id:_currentSession.session_id, days_before:days }) });
  el.innerHTML = d?.success
    ? '<div style="background:#dcfce7;color:#166534;padding:10px;border-radius:8px;font-size:13px;">' + d.message + '</div>'
    : '<div style="background:#fee2e2;color:#991b1b;padding:10px;border-radius:8px;font-size:13px;">' + (d?.message||'Gagal') + '</div>';
}

// ── MISC UI ───────────────────────────────────────────────────
function toggleChatSearch() {
  const bar = document.getElementById('chatSearchBar');
  const shown = bar.style.display !== 'none';
  bar.style.display = shown ? 'none' : '';
  if (!shown) document.getElementById('chatSearchInput').focus();
}
function searchInChat() {
  if (!_currentContact) return;
  const q = document.getElementById('chatSearchInput').value.toLowerCase();
  renderChatMessages(_currentContact.messages.filter(m => !q || m.message?.toLowerCase().includes(q)));
}
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function isConnected() { return _currentSession && (_currentSession.runtime_status || _currentSession.status) === 'connected'; }
function cleanNumber(s) { return (s||'').split('@')[0].split(':')[0].replace(/[^0-9]/g,''); }
function hashCode(s) { let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0; return Math.abs(h); }
function getPackageColor(name) {
  if (!name) return '#64748b';
  const n = name.toLowerCase();
  if (n.includes('gold') || n.includes('premium')) return '#f59e0b';
  if (n.includes('silver')) return '#64748b';
  if (n.includes('basic') || n.includes('lite')) return '#6366f1';
  return '#25d366';
}
function formatTime(dateStr) {
  const d = parseDate(dateStr); if (!d) return '';
  const now = new Date(), diff = now - d;
  const timeStr = d.toLocaleTimeString('id-ID', {hour:'2-digit', minute:'2-digit'});
  // Hari ini: tampilkan jam saja
  if (d.toDateString() === now.toDateString()) return timeStr;
  // Kemarin
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Kemarin';
  // Minggu ini: nama hari
  if (diff < 604800000) return ['Min','Sen','Sel','Rab','Kam','Jum','Sab'][d.getDay()];
  // Lebih lama: tanggal/bulan
  return d.toLocaleDateString('id-ID', {day:'2-digit', month:'2-digit', year:'2-digit'});
}

function formatFullTime(dateStr) {
  const d = new Date(dateStr); if (isNaN(d)) return '';
  return d.toLocaleString('id-ID', {day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'});
}
function openModal(id)  { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function show(id)    { document.getElementById(id).style.display = ''; }
function hide(id)    { document.getElementById(id).style.display = 'none'; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── GLOBALS ───────────────────────────────────────────────────
window.openAddSession        = openAddSession;
window.saveNewSession        = saveNewSession;
window.connectCurrentSession = connectCurrentSession;
window.disconnectSession     = disconnectSession;
window.confirmDeleteSession  = confirmDeleteSession;
window.confirmDeleteSessionById = confirmDeleteSessionById;
window.doDeleteSession       = doDeleteSession;
window.doDeleteSessionById   = doDeleteSessionById;
window.closeDeleteSessionModal = closeDeleteSessionModal;
window.confirmDeleteModalProceed = confirmDeleteModalProceed;
window.openSessionCtxMenu    = openSessionCtxMenu;
window.closeSessionCtxMenu   = closeSessionCtxMenu;
window.sessionCtxSelect      = sessionCtxSelect;
window.sessionCtxDisconnect  = sessionCtxDisconnect;
window.sessionCtxDelete      = sessionCtxDelete;
window.openAddRule           = openAddRule;
window.saveRule              = saveRule;
window.openAddTemplate       = openAddTemplate;
window.saveTemplate          = saveTemplate;
window.openBroadcast         = openBroadcast;
window.sendBroadcast         = sendBroadcast;
window.addBcNumber           = addBcNumber;
window.loadCustomerNumbers   = loadCustomerNumbers;
window.fillBcFromTemplate    = fillBcFromTemplate;
window.sendReminders         = sendReminders;
window.openTemplates         = openTemplates;
window.closeModal            = closeModal;
window.filterContacts        = filterContacts;
window.toggleAutoReply       = toggleAutoReply;
window.deleteRule            = deleteRule;
window.setFilter             = setFilter;
window.showProfile           = showProfile;

// ── DELETE CHAT ───────────────────────────────────────────────
let _deleteTargetNumber = null;

function deleteCurrentChat() {
  if (!_currentContact) return;
  _deleteTargetNumber = _currentContact.number;
  const name = getDisplayName(_currentContact);
  document.getElementById('deleteChatDesc').textContent = 'Semua pesan dengan "' + name + '" akan dihapus permanen.';
  document.getElementById('deleteChatModal').style.display = 'flex';
}
function closeDeleteModal() {
  document.getElementById('deleteChatModal').style.display = 'none';
  _deleteTargetNumber = null;
}
async function confirmDeleteChat() {
  if (!_deleteTargetNumber) { App.showToast('Pilih kontak terlebih dahulu', 'error'); return; }
  const btn = document.querySelector('#deleteChatModal .btn-del-confirm');
  btn.textContent = 'Menghapus...'; btn.disabled = true;
  try {
    // Gunakan session pertama yang connected jika _currentSession null
    const session = _currentSession || _sessions?.find(s => s.status === 'connected') || _sessions?.[0];
    if (!session) throw new Error('Tidak ada session WA aktif');
    const payload = { session_id: session.session_id, contact_number: _deleteTargetNumber };
    const d = await App.api('/wa/conversations', {
      method: 'DELETE',
      body: JSON.stringify(payload)
    });
    if (!d?.success) throw new Error(d?.message || 'Gagal menghapus');
    App.showToast(d.message || 'Chat dihapus', 'success');
    // Prune lokal pakai pencocokan nomor SEUTUHNYA (bukan 9 digit terakhir) supaya
    // kontak lain yg kebetulan 9 digit akhirnya sama tidak ikut hilang dari daftar.
    // Kanonikalisasi 08xx / +628xx / 628xx → 628xx supaya perbandingan konsisten
    // apa pun format penyimpanan nomornya.
    const canon = (s) => { let c = cleanNumber(s || ''); if (c.startsWith('0')) c = '62' + c.slice(1); return c; };
    const tnum = canon(_deleteTargetNumber);
    const sameNumber = (a) => { const c = canon(a); return c && c === tnum; };
    _allMessages = _allMessages.filter(m => !sameNumber(m.from_number) && !sameNumber(m.to_number));
    _contacts = _contacts.filter(c => !sameNumber(c.number));
    _deleteTargetNumber = null;
    _currentContact = null;
    hide('chatActive'); show('chatEmpty');
    renderContactList();
  } catch(e) { App.showToast(e.message, 'error'); }
  finally { btn.textContent = 'Hapus'; btn.disabled = false; closeDeleteModal(); }
}

// ── CONTEXT MENU ─────────────────────────────────────────────
let _contextMenuNumber = null;

function showContactMenu(e, number) {
  e.preventDefault(); e.stopPropagation();
  _contextMenuNumber = number;
  const menu = document.getElementById('waContextMenu');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top  = Math.min(e.clientY, window.innerHeight - 90) + 'px';
}
function hideContextMenu() {
  document.getElementById('waContextMenu').style.display = 'none';
  // Jangan reset _contextMenuNumber di sini — biarkan fungsi action yang reset
}
function contextOpenChat() {
  const num = _contextMenuNumber;
  _contextMenuNumber = null;
  document.getElementById('waContextMenu').style.display = 'none';
  if (num) openContact(num);
}
function contextDeleteChat() {
  // Ambil number SEBELUM hide (karena hide bisa dipanggil duluan lewat bubble)
  const num = _contextMenuNumber;
  _contextMenuNumber = null;
  document.getElementById('waContextMenu').style.display = 'none';
  if (!num) return;

  const num9 = num.replace(/[^0-9]/g,'').slice(-9);
  const contact = _contacts.find(c => c.number === num)
               || _contacts.find(c => c.number.replace(/[^0-9]/g,'').endsWith(num9))
               || { number: num, name: num };

  _deleteTargetNumber = num;
  _currentContact = contact;
  const name = contact.name || contact.number || num;
  document.getElementById('deleteChatDesc').textContent = 'Semua pesan dengan "' + name + '" akan dihapus permanen.';
  document.getElementById('deleteChatModal').style.display = 'flex';
}
document.addEventListener('click', function(e) {
  // Hide context menu hanya jika klik di luar menu
  const menu = document.getElementById('waContextMenu');
  if (menu && !menu.contains(e.target)) {
    menu.style.display = 'none';
    _contextMenuNumber = null;
  }
});
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { hideContextMenu(); closeDeleteModal(); } });

window.deleteCurrentChat = deleteCurrentChat;
window.closeDeleteModal  = closeDeleteModal;
window.confirmDeleteChat = confirmDeleteChat;
window.showContactMenu   = showContactMenu;
window.contextOpenChat   = contextOpenChat;
window.contextDeleteChat = contextDeleteChat;
window.openMediaFull     = openMediaFull;

// ── MOBILE SUPPORT ───────────────────────────────────────────
function isMobile() { return window.innerWidth <= 768; }

function mobileOpenChat() {
  if (!isMobile()) return;
  const sb = document.querySelector('.wa-sidebar');
  const cp = document.querySelector('.wa-chat-panel');
  // Tutup QR mode dulu (kalau ada) supaya class bersih
  if (sb) { sb.classList.remove('mobile-qr-open'); sb.classList.add('mobile-chat-open'); }
  if (cp) { cp.classList.remove('mobile-qr-open'); cp.classList.add('mobile-chat-open'); }
  document.body.classList.remove('wa-qr-open');
  document.body.classList.add('wa-chat-open');
}

function mobileShowSidebar() {
  if (!isMobile()) return;
  const sb = document.querySelector('.wa-sidebar');
  const cp = document.querySelector('.wa-chat-panel');
  if (sb) { sb.classList.remove('mobile-chat-open'); sb.classList.remove('mobile-qr-open'); }
  if (cp) { cp.classList.remove('mobile-chat-open'); cp.classList.remove('mobile-qr-open'); }
  document.body.classList.remove('wa-chat-open');
  document.body.classList.remove('wa-qr-open');
}

// Panel QR mode khusus mobile: fullscreen, instruksi di bawah, QR di atas
function mobileOpenQrView() {
  if (!isMobile()) return;
  const sb = document.querySelector('.wa-sidebar');
  const cp = document.querySelector('.wa-chat-panel');
  if (sb) { sb.classList.remove('mobile-chat-open'); sb.classList.add('mobile-qr-open'); }
  if (cp) { cp.classList.remove('mobile-chat-open'); cp.classList.add('mobile-qr-open'); }
  document.body.classList.remove('wa-chat-open');
  document.body.classList.add('wa-qr-open');
}

function mobileCloseQrView() {
  if (!isMobile()) return;
  const sb = document.querySelector('.wa-sidebar');
  const cp = document.querySelector('.wa-chat-panel');
  if (sb) sb.classList.remove('mobile-qr-open');
  if (cp) cp.classList.remove('mobile-qr-open');
  document.body.classList.remove('wa-qr-open');
}

// Patch openContact to trigger mobile view switch
const _openContactOrig = window.openContact;
window.openContact = function(number) {
  if (_openContactOrig) _openContactOrig(number);
  if (isMobile()) mobileOpenChat();
};

window.mobileShowSidebar = mobileShowSidebar;
window.mobileOpenChat    = mobileOpenChat;
window.mobileOpenQrView  = mobileOpenQrView;
window.mobileCloseQrView = mobileCloseQrView;

// Cleanup class saat resize ke desktop
window.addEventListener('resize', function() {
  if (!isMobile()) {
    document.body.classList.remove('wa-chat-open');
    document.body.classList.remove('wa-qr-open');
    document.querySelectorAll('.mobile-chat-open, .mobile-qr-open').forEach(el => {
      el.classList.remove('mobile-chat-open');
      el.classList.remove('mobile-qr-open');
    });
  }
});

// ══════════════════════════════════════════════════════════════
// AKSI PESAN: Balas (reply/quote) & Hapus
// ══════════════════════════════════════════════════════════════
const _msgIndex = {};          // DB id → objek pesan (diisi saat render)
let _replyTarget = null;       // { dbId, waId, text } pesan yang sedang dibalas

function openMsgMenu(ev, dbId) {
  ev.stopPropagation();
  closeMsgMenu();
  const m = _msgIndex[dbId];
  if (!m) return;
  const menu = document.createElement('div');
  menu.id = 'waMsgMenu';
  menu.className = 'wa-msg-menu';
  // Fitur hapus pesan (untuk saya / untuk semua) DINONAKTIFKAN sementara.
  // Hanya sisakan aksi Balas.
  let items = '<div class="wa-msg-menu-item" onclick="startReply(' + dbId + ')">↩ Balas</div>';
  menu.innerHTML = items;
  document.body.appendChild(menu);
  // Posisikan dekat tombol, jaga tetap dlm viewport
  const r = ev.target.closest('.wa-bubble-menu').getBoundingClientRect();
  const mw = 190;
  menu.style.top  = Math.min(r.bottom + 4, window.innerHeight - 130) + 'px';
  menu.style.left = Math.min(Math.max(8, r.left - mw + r.width), window.innerWidth - mw - 8) + 'px';
  setTimeout(() => document.addEventListener('click', closeMsgMenu, { once: true }), 0);
}
function closeMsgMenu() { document.getElementById('waMsgMenu')?.remove(); }

// ── Balas / quote ──
function startReply(dbId) {
  closeMsgMenu();
  const m = _msgIndex[dbId];
  if (!m) return;
  const snippet = (m.message || '[media]').slice(0, 120);
  _replyTarget = { dbId, waId: (m.wa_message_id || '').split('|')[0] || null, text: snippet, fromMe: m.direction === 'outbound' };
  renderReplyStrip();
  document.getElementById('chatInput')?.focus();
}
function cancelReply() { _replyTarget = null; renderReplyStrip(); }
function renderReplyStrip() {
  let strip = document.getElementById('waReplyStrip');
  if (!_replyTarget) { strip?.remove(); return; }
  const input = document.getElementById('chatInput');
  if (!input) return;
  const html =
    '<div style="flex:1;min-width:0;border-left:3px solid #25d366;padding:4px 10px;">' +
      '<div style="font-size:11px;font-weight:700;color:#25d366;">Membalas</div>' +
      '<div style="font-size:12px;color:#54656f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(_replyTarget.text) + '</div>' +
    '</div>' +
    '<span onclick="cancelReply()" style="cursor:pointer;padding:6px;color:#8696a0;font-size:16px;line-height:1;">✕</span>';
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'waReplyStrip';
    strip.style.cssText = 'display:flex;align-items:center;gap:6px;background:#f0f2f5;border-radius:10px;padding:4px 6px;margin:0 0 6px 0;';
    // Sisipkan tepat di atas baris input
    const inputRow = input.closest('div');
    inputRow.parentElement.insertBefore(strip, inputRow);
  }
  strip.innerHTML = html;
}

// ── Hapus (modal konfirmasi custom — bukan confirm() native) ──
function confirmDeleteMsg(dbId, scope) {
  closeMsgMenu();
  const isAll = scope === 'everyone';
  const overlay = document.createElement('div');
  overlay.id = 'waDelConfirm';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(11,20,26,.55);z-index:99998;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML =
    '<div style="background:#fff;border-radius:12px;width:380px;max-width:92vw;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.25);">' +
      '<div style="font-size:15px;font-weight:700;color:#111b21;margin-bottom:8px;">' + (isAll ? 'Hapus untuk semua?' : 'Hapus dari riwayat?') + '</div>' +
      '<div style="font-size:13px;color:#54656f;line-height:1.5;margin-bottom:18px;">' +
        (isAll
          ? 'Pesan akan DITARIK di WhatsApp penerima (hanya berlaku utk pesan yang belum lama dikirim) dan ditandai terhapus di riwayat.'
          : 'Pesan hanya dihapus dari riwayat chat aplikasi ini. Penerima tetap melihatnya di WhatsApp mereka.') +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:10px;">' +
        '<button onclick="document.getElementById(\'waDelConfirm\').remove()" style="padding:8px 16px;border:1px solid #d1d7db;background:#fff;border-radius:8px;font-size:13px;cursor:pointer;color:#111b21;">Batal</button>' +
        '<button onclick="execDeleteMsg(' + dbId + ', \'' + scope + '\')" style="padding:8px 16px;border:none;background:#dc2626;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">Hapus</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
}
async function execDeleteMsg(dbId, scope) {
  document.getElementById('waDelConfirm')?.remove();
  const d = await App.api('/wa/message/delete', { method:'POST', body: JSON.stringify({ message_id: dbId, scope }) });
  if (d?.success) {
    // partial=true: baris dihapus dari riwayat tapi penarikan di WhatsApp gagal.
    App.showToast(d.message || 'Pesan dihapus', d.partial ? 'warning' : 'success');
    await loadMessages();
  } else {
    App.showToast(d?.message || 'Gagal menghapus pesan', 'error');
  }
}
