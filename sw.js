// =====================================================================
//  Service worker « kill switch ».
//  L'ancienne version installait un service worker qui servait les
//  fichiers depuis son cache. Ce fichier le remplace : il vide tous les
//  caches, se désinscrit et recharge les pages ouvertes. Aucun cache,
//  aucun push, aucune notification. À garder tel quel.
// =====================================================================
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
  })());
});
