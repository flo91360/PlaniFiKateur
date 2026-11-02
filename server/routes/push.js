import { httpError } from '../http.js';
import { vapidPublicKey } from '../push.js';

// Notifications Web Push d’un compte : clé publique du serveur, abonnement de l’appareil.
export function pushRoutes({ store, config, guards }) {
  // Adresse du site, sujet de l’identification VAPID auprès des services de notification.
  const siteOrigin = req => {
    try {
      if (req.headers.origin) return new URL(req.headers.origin).origin;
    } catch {
      /* En-tête invalide : l’adresse est déduite de l’hôte. */
    }
    return `${config.secureCookie ? 'https' : 'http'}://${req.headers.host}`;
  };
  return [
    {
      path: '/api/v1/push',
      guard: guards.account,
      methods: { GET: ctx => ctx.send(200, { data: { publicKey: vapidPublicKey(store.pushKey()) } }) },
    },
    {
      path: '/api/v1/push/subscription',
      guard: guards.account,
      methods: {
        async PUT(ctx) {
          store.savePushSubscription(ctx.user, await ctx.body(), siteOrigin(ctx.req));
          ctx.send(200, { data: { subscribed: true } });
        },
        async DELETE(ctx) {
          const endpoint = (await ctx.body())?.endpoint;
          if (typeof endpoint !== 'string') throw httpError(400, 'invalid_subscription', 'endpoint attendu.');
          store.removePushSubscription(ctx.user, endpoint);
          ctx.send(200, { data: { subscribed: false } });
        },
      },
    },
  ];
}
