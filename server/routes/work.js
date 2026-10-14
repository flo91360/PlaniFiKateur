import { httpError } from '../http.js';

const humanActions = ['answer', 'accept', 'reject', 'cancel'];
// Valider ou faire corriger le travail de l’agent revient à le diriger : réservé aux responsables.
const managerActions = ['accept', 'reject'];
const agentActions = ['claim', 'revise', 'heartbeat', 'progress', 'question', 'submit', 'interrupt'];

// Identité de l’agent (administration et worker) et parcours de travail des cartes.
export function workRoutes({ store, config, auth, guards }) {
  const { workflows } = store;
  const cardWork = '/api/v1/projects/:projectId/cards/:cardId/work';
  return [
    {
      path: '/api/v1/agents',
      guard: guards.admin,
      methods: {
        GET: ctx => ctx.send(200, { data: workflows.agents() }),
        POST: async ctx => ctx.send(201, { data: workflows.configureAgent(await ctx.body(), ctx.user) }),
      },
    },
    {
      path: '/api/v1/agents/:agentId',
      guard: guards.admin,
      methods: {
        PUT: async ctx =>
          ctx.send(200, { data: workflows.configureAgent(await ctx.body(), ctx.user, ctx.params.agentId) }),
        DELETE: ctx => ctx.send(200, { data: workflows.revokeAgent(ctx.params.agentId, ctx.user) }),
      },
    },
    {
      path: '/api/v1/agent/projects',
      methods: {
        GET(ctx) {
          const projects = workflows.agentProjects(auth.requireAgent(ctx.req));
          ctx.send(200, {
            data: projects.map(project => ({ ...project, webhookConfigured: !!config.githubWebhookSecret })),
          });
        },
      },
    },
    {
      path: '/api/v1/agent/projects/:projectId/diagnostic',
      methods: {
        async POST(ctx) {
          const agent = auth.requireAgent(ctx.req);
          ctx.send(200, { data: workflows.recordWorkerStatus(ctx.params.projectId, await ctx.body(), agent) });
        },
      },
    },
    {
      path: '/api/v1/attention',
      guard: guards.account,
      methods: {
        GET(ctx) {
          const { access } = store.readFor(ctx.user);
          ctx.send(200, { data: workflows.attention().filter(item => access[item.projectId]) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/work',
      methods: {
        GET: ctx =>
          ctx.send(200, {
            data: workflows.queue(ctx.params.projectId, auth.requireAgent(ctx.req), {
              autoPrepare: !!config.githubWebhookSecret,
            }),
          }),
      },
    },
    {
      path: cardWork,
      methods: {
        GET(ctx) {
          // Une session voit les exécutions des projets qu’elle voit ; un agent celles de ses projets.
          const user = auth.currentUser(ctx.req);
          if (user) store.requireProject(auth.requireAccount(ctx.req), ctx.params.projectId);
          const agent = user ? null : auth.requireAgent(ctx.req);
          ctx.send(200, { data: workflows.list(ctx.params.projectId, ctx.params.cardId, agent) });
        },
        async POST(ctx) {
          auth.requireAccount(ctx.req);
          const data = await ctx.body();
          if (!config.githubWebhookSecret)
            throw httpError(503, 'github_not_configured', 'Configurez le secret du webhook GitHub sur le serveur.');
          const actor = auth.requireAccount(ctx.req);
          // Confier une carte à l’agent : réservé aux responsables du projet.
          store.requireProject(actor, ctx.params.projectId, 'manager');
          ctx.send(201, { data: workflows.prepare(ctx.params.projectId, ctx.params.cardId, data, actor) });
        },
      },
    },
    ...humanActions.map(action => ({
      path: `${cardWork}/:executionId/${action}`,
      methods: {
        async POST(ctx) {
          auth.requireAccount(ctx.req);
          const data = await ctx.body();
          const { projectId, cardId, executionId } = ctx.params;
          const actor = auth.requireAccount(ctx.req);
          store.requireProject(actor, projectId, managerActions.includes(action) ? 'manager' : 'editor');
          ctx.send(200, { data: workflows.human(projectId, cardId, executionId, action, data, actor) });
        },
      },
    })),
    ...agentActions.map(action => ({
      path: `${cardWork}/:executionId/${action}`,
      methods: {
        async POST(ctx) {
          auth.requireAgent(ctx.req);
          const data = await ctx.body();
          const { projectId, cardId, executionId } = ctx.params;
          const agent = auth.requireAgent(ctx.req);
          ctx.send(200, { data: workflows.agentAction(projectId, cardId, executionId, action, data, agent) });
        },
      },
    })),
  ];
}
