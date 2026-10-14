import { validateRefinement, notConfigured } from '../refine.js';
import { httpError } from '../http.js';

const editableExecution = ['preset', 'branch'];

// Paramètres d’un projet : dépôt GitHub, IA, profil d’exécution, worker, Drive et reformulation.
export function projectRoutes({ store, config, auth, guards, refiner }) {
  const { workflows } = store;
  return [
    {
      path: '/api/v1/projects/:projectId/github',
      guard: guards.account,
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
          void config.driveArchive?.refresh();
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
      path: '/api/v1/projects/:projectId/drive',
      guard: guards.project,
      methods: {
        GET: ctx => ctx.send(200, { data: driveStatus(ctx.params.projectId) }),
        POST(ctx) {
          auth.requireAdmin(ctx.req);
          if (!config.driveArchive)
            throw httpError(503, 'drive_disabled', 'L’archivage Google Drive n’est pas configuré sur le serveur.');
          void config.driveArchive.refresh({ force: true });
          ctx.send(202, { data: driveStatus(ctx.params.projectId) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/refine',
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const project = store.read().projects.find(item => item.id === ctx.params.projectId);
          if (!project) throw httpError(404, 'project_not_found', 'Projet inexistant.');
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
  ];

  function driveStatus(projectId) {
    const repository = workflows.githubProject(projectId);
    return config.driveArchive
      ? config.driveArchive.status(repository)
      : { enabled: false, repository: repository || '', releases: [] };
  }
}
