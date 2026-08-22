/**
 * sw-reseller.js — Service Worker PWA portal reseller (#13).
 * Scope: /reseller
 *
 * Strategi:
 *  - Aset statis (css/js/img/vendor) → cache-first (stale-while-revalidate ringan).
 *  - Halaman & API → network-first dengan fallback cache (offline tetap jalan
 *    untuk shell). API hotspot/saldo selalu coba network dulu agar data segar.
 */
const CACHE = 'reseller-pwa-v2';
const SHELL = [
  '/reseller/dashboard',
  '/reseller-manifest.json',
  '/img/reseller/icon-192.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return /\.(css|js|png|jpg|jpeg|svg|woff2?|ttf)$/.test(url.pathname) ||
         url.pathname.startsWith('/vendor/') ||
         url.pathname.startsWith('/img/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Hanya tangani origin sendiri.
  if (url.origin !== self.location.origin) return;

  // Aset statis → cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached))
    );
    return;
  }

  // Halaman reseller → network-first, fallback cache.
  if (url.pathname.startsWith('/reseller')) {
    // Jangan ikut campur pada halaman login/auth — biarkan murni network agar
    // redirect server (login↔dashboard) tidak terjebak cache → mencegah flicker.
    if (url.pathname.startsWith('/reseller/login') ||
        url.pathname.startsWith('/reseller/api')) {
      return;
    }
    event.respondWith(
      fetch(req).then(res => {
        // Hanya cache navigasi yang benar-benar OK & bukan redirect.
        if (req.mode === 'navigate' && res && res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/reseller/dashboard', copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/reseller/dashboard'))
    );
  }
});
