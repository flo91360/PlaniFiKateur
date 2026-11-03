/* global self */
// Service worker de PlaniFiKateur : affiche les notifications Web Push (étapes de l’agent qui
// attendent une personne) et ouvre la carte concernée au clic. Il n’intercepte aucune requête.

// Pastille de l’icône installée (écran d’accueil) : nombre de notifications non lues, effacée à 0.
// Ignorée par les navigateurs sans API Badging.
const setBadge = count => {
  const nav = self.navigator;
  if (!Number.isSafeInteger(count) || count < 0 || !nav?.setAppBadge) return Promise.resolve();
  return (count ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {});
};
self.addEventListener('push', event => {
  let message;
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  event.waitUntil(
    Promise.all([
      setBadge(message.badge),
      self.registration.showNotification(message.title || 'PlaniFiKateur', {
        body: message.body || '',
        tag: message.tag,
        renotify: !!message.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/' },
      }),
    ]),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find(client => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});
