import { httpError } from '../http.js';

const MAX_STREAMS = 200;
// Plusieurs onglets restent possibles, sans qu’un seul compte occupe tous les flux.
const MAX_STREAMS_PER_ACCOUNT = 10;
const HEARTBEAT_MS = 25000;
// Données en attente d’envoi au-delà desquelles un client qui ne lit plus est déconnecté : il se
// reconnecte de lui-même et relit le tableau (événement ready), au lieu d’accumuler la mémoire.
const MAX_PENDING_BYTES = 256 * 1024;

// Flux d’événements du serveur (Server-Sent Events) pour l’interface : il annonce les changements
// du tableau, des exécutions IA et des abonnements, qui sont ensuite relus par les routes
// habituelles. Les événements ne contiennent que des identifiants, une révision et un état.
export function eventRoutes({ store, config, auth, guards, streams }) {
  const heartbeatMs = config.eventHeartbeatMs || HEARTBEAT_MS;
  const maxPending = config.eventMaxPendingBytes || MAX_PENDING_BYTES;
  return [
    {
      path: '/api/v1/events',
      guard: guards.account,
      methods: {
        GET(ctx) {
          if (streams.size >= MAX_STREAMS)
            throw httpError(503, 'too_many_streams', 'Trop de connexions ouvertes. Réessayez plus tard.');
          if ([...streams].filter(stream => stream.userId === ctx.user.id).length >= MAX_STREAMS_PER_ACCOUNT)
            throw httpError(
              429,
              'too_many_streams',
              'Trop d’onglets ouverts sur ce compte. Fermez-en un pour recevoir les mises à jour en direct.',
            );
          const { req, res } = ctx;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
          });
          let closed = false;
          const write = text => {
            if (closed || res.destroyed) return;
            if (res.writableLength > maxPending) close();
            else res.write(text);
          };
          const send = (type, data) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          // Reconnexion automatique du navigateur après 5 s ; l’événement ready donne la révision.
          res.write('retry: 5000\n\n');
          send('ready', { revision: store.getRevision() });
          // Les événements d’un projet ne parviennent qu’aux comptes qui le voient.
          const unsubscribe = store.subscribe(({ type, userIds, ...data }) => {
            if (data.projectId && !store.projectRole(ctx.user, data.projectId)) return;
            // Changement limité à certains projets : seuls ceux que le compte voit lui sont cités.
            if (data.projectIds) {
              const visible = data.projectIds.filter(id => store.projectRole(ctx.user, id));
              if (!visible.length) return;
              data = { ...data, projectIds: visible };
            }
            // Un événement destiné à certains comptes (notifications) ne parvient qu’à eux.
            if (userIds && !userIds.includes(ctx.user.id)) return;
            send(type, data);
          });
          // Commentaire périodique : garde la connexion ouverte à travers les proxys et vérifie
          // que la session est toujours valide (déconnexion, compte désactivé).
          const heartbeat = setInterval(() => {
            if (!auth.currentUser(req)) close();
            else write(': ping\n\n');
          }, heartbeatMs);
          heartbeat.unref();
          const stream = { userId: ctx.user.id, close: () => close() };
          function close() {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            streams.delete(stream);
            if (!res.writableEnded) res.end();
          }
          streams.add(stream);
          req.on('close', close);
        },
      },
    },
  ];
}
