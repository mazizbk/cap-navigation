// Service worker : rend l'application installable et garde l'interface en cache.
// Stratégie « réseau d'abord » pour les fichiers de l'app (on a toujours la dernière version),
// avec repli sur le cache hors connexion. Les tuiles et les API ne sont pas mises en cache.
const CACHE = 'cap-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'native.js', 'geo.js', 'app.js', 'hazards.js', 'street.js', 'traffic.js', 'extras.js', 'voice.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-512.png',
  'https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@5.24.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = e.request.method === 'GET' &&
    ((url.origin === location.origin && !url.pathname.includes('/api/') && !url.pathname.includes('/data/')) || url.hostname === 'unpkg.com');
  if (!isShell) return; // le navigateur gère le reste normalement
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
