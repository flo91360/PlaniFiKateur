import { validateRefinement, notConfigured } from '../refine.js';
import { httpError } from '../http.js';
import { implementationList, isDiscussionCard } from '../../src/lib/discussion-list.js';
import { createId } from '../../src/lib/id.js';

const editableExecution = ['preset', 'branch'];

// Paramètres d’un projet : dépôt GitHub, IA, profil d’exécution, worker et reformulation.
export function projectRoutes({ store, config, auth, guards, refiner }) {
  const { workflows } = store;
  // Projet visible du compte, avec le README et CLAUDE.md (ou AGENTS.md) de son dépôt pour le contexte.
  const aiContext = async (ctx, request, { attachmentData = false } = {}) => {
    const role = store.requireProject(ctx.user, ctx.params.projectId, 'editor');
    const [project] = store.readFor(ctx.user, {
      attachmentData,
      projectIds: [ctx.params.projectId],
    }).projects;
    const validated = await request(project);
    if (!refiner.enabled) throw httpError(503, 'ai_not_configured', notConfigured);
    auth.refineLimit(ctx.user.id);
    const repository = workflows.githubProject(project.id) || '';
    const documents =
      repository && config.repositoryContext
        ? await config.repositoryContext.get(repository, workflows.executionProfile(project.id).branch)
        : [];
    return {
      role,
      project,
      validated,
      documents,
      context: { name: project.name, description: project.description, repository },
    };
  };
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
          const { project, validated, documents, context } = await aiContext(ctx, async () =>
            validateRefinement(await ctx.body()),
          );
          const list = project.lists.find(item => item.id === validated.listId)?.name || '';
          const result = await refiner.refine({ ...validated, list, documents, project: context });
          ctx.send(200, { data: { ...result, sources: documents.map(file => file.name) } });
        },
      },
    },
    {
      // Carte d’implémentation tirée d’une carte de la liste Discussion : l’IA résume les demandes de
      // la conversation, puis la carte est créée dans Améliorations avec une copie des pièces jointes,
      // prête pour l’agent quand un responsable la crée, et la carte Discussion est supprimée.
      path: '/api/v1/projects/:projectId/cards/:cardId/implementation',
      guard: guards.project,
      methods: {
        async POST(ctx) {
          const {
            role,
            project,
            validated: card,
            documents,
            context,
          } = await aiContext(
            ctx,
            found => {
              const card = found.cards.find(item => item.id === ctx.params.cardId);
              if (!card) throw httpError(404, 'card_not_found', 'Carte inexistante dans ce projet.');
              if (!isDiscussionCard(found, card))
                throw httpError(400, 'not_discussion', 'Seule une carte de la liste Discussion peut être synthétisée.');
              if (!card.description.trim() && !card.comments.some(comment => comment.text.trim()))
                throw httpError(400, 'empty_discussion', 'La discussion est vide : rien à synthétiser.');
              if (!implementationList(found))
                throw httpError(409, 'no_target_list', 'Ce projet n’a aucune liste où créer la carte.');
              return card;
            },
            { attachmentData: true },
          );
          const result = await refiner.summarize({ card, documents, project: context });
          const list = implementationList(project);
          const created = {
            id: createId(),
            listId: list.id,
            title: result.title || card.title,
            description: result.prompt,
            status: role === 'manager' ? 'ready' : 'draft',
            priority: card.priority || 'normal',
            aiEffort: card.aiEffort || 'medium',
            tags: card.tags || [],
            comments: [],
            checklist: [],
            attachments: (card.attachments || []).map(file => ({ ...file, id: createId() })),
          };
          // La carte Discussion a rempli son rôle : elle est supprimée dans la même transaction.
          store.change(
            [
              { type: 'card.create', projectId: project.id, card: created },
              { type: 'card.delete', projectId: project.id, cardId: card.id },
            ],
            ctx.user,
            { strict: true },
          );
          ctx.send(201, {
            data: {
              card: { id: created.id, title: created.title, listId: list.id, status: created.status },
              list: list.name,
              attachments: created.attachments.length,
              deleted: card.id,
              model: result.model,
              sources: documents.map(file => file.name),
            },
          });
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
