import { httpError } from '../http.js';

// Images affichées en aperçu dans le détail de carte.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Pièces jointes, suivi des cartes par les membres et historique des actions.
export function cardRoutes({ store, guards }) {
  const card = '/api/v1/projects/:projectId/cards/:cardId';
  const history = {
    guard: ctx => (ctx.params.projectId ? guards.project(ctx) : guards.account(ctx)),
    methods: {
      GET(ctx) {
        const limit = Number(ctx.url.searchParams.get('limit') || 50),
          before = Number(ctx.url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1)
          throw httpError(400, 'invalid_pagination', 'Pagination invalide.');
        const { projectId, cardId } = ctx.params;
        // Historique global : les projets visibles du compte, et tout pour un administrateur.
        const visible = projectId || ctx.user.role === 'admin' ? null : Object.keys(store.accessOf(ctx.user));
        const events = store.activity({ projectId, cardId, limit, before, visible });
        ctx.send(200, { data: events, meta: { nextBefore: events.length === limit ? events.at(-1).id : null } });
      },
    },
  };
  return [
    {
      // Contenu d’une pièce jointe : le tableau envoyé au navigateur n’en donne que le nom, le type
      // et la taille. Les images s’affichent en aperçu ; tout autre type est téléchargé, sans
      // jamais être interprété par le navigateur sur l’origine du site.
      path: `${card}/attachments/:attachmentId`,
      guard: guards.project,
      methods: {
        GET(ctx) {
          const { projectId, cardId, attachmentId } = ctx.params;
          const file = store.attachment(projectId, cardId, attachmentId);
          if (!file) throw httpError(404, 'attachment_not_found', 'Pièce jointe inexistante dans cette carte.');
          const image = IMAGE_TYPES.has(file.type);
          const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
          ctx.res.writeHead(200, {
            'Content-Type': image ? file.type : 'application/octet-stream',
            'Content-Length': file.size,
            'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'private, no-store',
          });
          ctx.res.end(Buffer.from(file.data, 'base64'));
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/card-followers',
      guard: guards.project,
      methods: { GET: ctx => ctx.send(200, { data: store.projectCardFollowers(ctx.params.projectId) }) },
    },
    {
      path: `${card}/subscribers`,
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: store.cardMembers(ctx.params.projectId, ctx.params.cardId) }),
        // Ajouter un autre membre au suivi : contributeurs et responsables.
        async PUT(ctx) {
          store.requireProject(ctx.user, ctx.params.projectId, 'editor');
          const data = await ctx.body();
          if (typeof data?.userId !== 'string' || !data.userId)
            throw httpError(400, 'invalid_subscriber', 'Choisissez un membre du projet.');
          const { projectId, cardId } = ctx.params;
          store.setSubscription(projectId, cardId, ctx.user, true, data.userId);
          ctx.send(200, { data: store.cardMembers(projectId, cardId) });
        },
      },
    },
    {
      path: `${card}/subscription`,
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: store.subscription(ctx.params.projectId, ctx.params.cardId, ctx.user.id) }),
        async PUT(ctx) {
          const data = await ctx.body();
          if (typeof data?.following !== 'boolean')
            throw httpError(400, 'invalid_subscription', 'following doit être un booléen.');
          const { projectId, cardId } = ctx.params;
          ctx.send(200, { data: store.setSubscription(projectId, cardId, guards.account(ctx), data.following) });
        },
      },
    },
    { path: '/api/v1/activity', ...history },
    {
      path: '/api/v1/notifications',
      guard: guards.account,
      methods: {
        GET(ctx) {
          const limit = Number(ctx.url.searchParams.get('limit') || 30);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw httpError(400, 'invalid_pagination', 'Pagination invalide.');
          const { items, unread, lastReadId } = store.notifications(ctx.user, { limit });
          ctx.send(200, { data: items, meta: { unread, lastReadId } });
        },
      },
    },
    {
      path: '/api/v1/notifications/read',
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const data = await ctx.body();
          const { unread, lastReadId } = store.readNotifications(ctx.user, data?.upTo);
          ctx.send(200, { data: { unread, lastReadId } });
        },
      },
    },
    { path: '/api/v1/projects/:projectId/activity', ...history },
    { path: `${card}/activity`, ...history },
  ];
}
