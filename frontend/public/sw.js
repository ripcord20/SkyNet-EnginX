/**
 * sw.js — Service Worker untuk Web Push Notification
 * Letakkan di: frontend/public/sw.js  (root domain)
 *
 * Capacitor Android: Service Worker tetap aktif via Chrome WebView
 */

const CACHE_NAME = 'netops-portal-v1';
const PORTAL_URL = '/portal/dashboard';

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting(); // aktifkan SW baru langsung tanpa tunggu tab ditutup
});

// ── Activate ──────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// ── Push Event ────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Notifikasi', body: event.data ? event.data.text() : '' };
  }

  const title   = data.title   || 'Notifikasi Portal';
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/img/icon-192.png',
    badge:   data.badge   || '/img/badge-96.png',
    tag:     data.tag     || 'netops-portal',
    data:  { url: data.url || PORTAL_URL, ...( data.data || {} ) },
    // Android: tampil di notification tray bahkan saat app minimize
    requireInteraction: data.data?.type === 'due_today' || data.data?.type === 'overdue',
    // Vibrasi: [getar, jeda, getar]
    vibrate: [200, 100, 200],
    actions: [
      { action: 'open',    title: 'Buka Portal' },
      { action: 'dismiss', title: 'Tutup' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification Click ────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : PORTAL_URL;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Jika portal sudah terbuka di tab, fokus ke sana
      for (const client of clientList) {
        if (client.url.includes('/portal') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Buka tab baru
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ── Push Subscription Change ──────────────────────────────────
// Dipanggil browser saat subscription berubah (contoh: browser update VAPID server)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true })
      .then((sub) => {
        return fetch('/portal/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub, action: 'resubscribe' })
        });
      })
      .catch(() => {})
  );
});
