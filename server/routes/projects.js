import { validateRefinement, notConfigured } from '../refine.js';
import { httpError } from '../http.js';

const editableExecution = ['preset', 'branch'];

// Paramètres d’un projet : dépôt GitHub, IA, profil d’exécution, worker et reformulation.
export function projectRoutes({ store, config, auth, guards, refiner }) {
  const { workflows } = store;
  return [
    {
      path: '/api/v1/projects/:projectId/github',
      guard: guards.project,
      methods: {
        GET(ctx) {
          const { projectId } = ctx.params;
          ctx.send(200, {
            data: {
              repository: workflows.githubProject(projectId),
              branch: workflows.executionProfile(projectId).branch,
              webhookConfigured: !!config.githubWebhookSecret,
            },
          });
        },
        async PUT(ctx) {
          const admin = auth.requireAdmin(ctx.req);
          const data = await ctx.body();
          ctx.send(200, { data: workflows.configureGithub(ctx.params.projectId, data?.repository, admin) });
          store.refreshInfos();
          void config.versions?.refresh();
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/ai',
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: workflows.projectAi(ctx.params.projectId) }),
        async PUT(ctx) {
          const admin = auth.requireAdmin(ctx.req);
          ctx.send(200, { data: workflows.configureAi(ctx.params.projectId, await ctx.body(), admin) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/execution',
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: workflows.executionProfile(ctx.params.projectId) }),
        async PUT(ctx) {
          const admin = auth.requireAdmin(ctx.req);
          const data = await ctx.body();
          // Les commandes et contrôles GitHub viennent du profil installé avec le worker :
          // l’API ne permet de choisir que le profil et la branche cible.
          if (!data || typeof data !== 'object' || Object.keys(data).some(key => !editableExecution.includes(key)))
            throw httpError(
              400,
              'invalid_execution_profile',
              'Seuls le profil (preset) et la branche cible (branch) sont modifiables : les commandes et les contrôles GitHub viennent du profil installé avec le worker.',
            );
          const profile = { preset: data.preset, branch: data.branch };
          ctx.send(200, { data: workflows.configureExecution(ctx.params.projectId, profile, admin) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/worker-status',
      guard: guards.project,
      methods: { GET: ctx => ctx.send(200, { data: workflows.workerStatus(ctx.params.projectId) }) },
    },
    {
      path: '/api/v1/projects/:projectId/refine',
      guard: guards.project,
      methods: {
        async POST(ctx) {
          store.requireProject(ctx.user, ctx.params.projectId, 'editor');
          const [project] = store.readFor(ctx.user, {
            attachmentData: false,
            projectIds: [ctx.params.projectId],
          }).projects;
          const request = validateRefinement(await ctx.body());
          if (!refiner.enabled) throw httpError(503, 'ai_not_configured', notConfigured);
          auth.refineLimit(ctx.user.id);
          const list = project.lists.find(item => item.id === request.listId)?.name || '';
          const repository = workflows.githubProject(project.id) || '';
          const documents =
            repository && config.repositoryContext
              ? await config.repositoryContext.get(repository, workflows.executionProfile(project.id).branch)
              : [];
          const result = await refiner.refine({
            ...request,
            list,
            documents,
            project: { name: project.name, description: project.description, repository },
          });
          ctx.send(200, { data: { ...result, sources: documents.map(file => file.name) } });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/approval',
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: { required: store.mergeApproval(ctx.params.projectId) } }),
        async PUT(ctx) {
          ctx.send(200, { data: store.configureMergeApproval(ctx.params.projectId, await ctx.body(), ctx.user) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/members',
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: store.projectAccess(ctx.params.projectId, ctx.user) }),
        async PUT(ctx) {
          ctx.send(200, { data: store.configureProjectAccess(ctx.params.projectId, await ctx.body(), ctx.user) });
        },
      },
    },
  ];
}
