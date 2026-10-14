import { httpError } from '../http.js';

// Suivi des cartes par les membres et historique des actions.
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
        const visible = projectId ? null : Object.keys(store.readFor(ctx.user).access);
        const events = store.activity({ projectId, cardId, limit, before, visible });
        ctx.send(200, { data: events, meta: { nextBefore: events.length === limit ? events.at(-1).id : null } });
      },
    },
  };
  return [
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
    { path: '/api/v1/projects/:projectId/activity', ...history },
    { path: `${card}/activity`, ...history },
  ];
}
