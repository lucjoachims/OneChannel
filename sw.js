// =====================================================================
//  Service worker — installabilité + cache du shell hors-ligne.
//  IMPORTANT : aucun "push", aucune "notification" ici. Volontairement.
//  C'est ce qui garantit que rien ne s'affiche sur la montre/voiture/télé.
// =====================================================================
const CACHE = 'memo-v1';
const SHELL = [
  './', './index.html', './app.js', './styles.css',
  './manifest.webmanifest', './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Ne jamais mettre l'API en cache (toujours frais).
  if (url.pathname.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
