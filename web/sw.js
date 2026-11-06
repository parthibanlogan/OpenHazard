/* OpenHazard India service worker
 * shell: cache-first (versioned) | data JSON: network-first with cache fallback
 * CORS map tiles: cache-first, capped LRU. Opaque (no-CORS) responses are never stored: browsers pad
 * them to megabytes of quota each. */
const VERSION = 'v5.1.0';
const SHELL = `oh-shell-${VERSION}`, DATA = 'oh-data-v1', TILES = 'oh-tiles-v1', MAX_TILES = 800;
const SHELL_FILES = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/config.js', 'js/analytics.js', 'js/geo.js', 'js/api.js', 'js/dem.js', 'js/app.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/marker-icon.png', 'vendor/chart.umd.js', 'vendor/topojson-client.min.js',
  'data/districts.topo.json', 'data/states.topo.json', 'data/MANIFEST.json', 'icons/icon-192.png', 'icons/icon-512.png'];
const DATA_HOSTS = ['api.open-meteo.com', 'archive-api.open-meteo.com', 'air-quality-api.open-meteo.com', 'flood-api.open-meteo.com', 'rest.isric.org', 'earthquake.usgs.gov', 'eonet.gsfc.nasa.gov'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('oh-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(SHELL).then((c) => c.put(req, cp)); }
      return r;
    }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
    return;
  }
  if (DATA_HOSTS.includes(url.hostname)) {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && r.type === 'cors') { const cp = r.clone(); caches.open(DATA).then((c) => c.put(req, cp)).then(() => trim(DATA, 300)); }
      return r;
    }).catch(() => caches.match(req).then((hit) => hit || Response.error())));
    return;
  }
  if (req.destination === 'image' && req.mode === 'cors') {
    e.respondWith(caches.open(TILES).then((c) => c.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok && r.type === 'cors') { c.put(req, r.clone()).then(() => trim(TILES, MAX_TILES)); }
      return r;
    }))));
  }
});
