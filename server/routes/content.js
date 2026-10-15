import { httpError } from '../http.js';
import { createId } from '../../src/lib/id.js';
import { withInfos } from '../../src/lib/infos.js';
import { CARD_FIELDS, LIST_FIELDS, PROJECT_FIELDS } from '../../src/lib/workspace-changes.js';

const REMOVALS = ['project.delete', 'list.delete', 'card.delete'];
const DEFAULT_LISTS = [
  { name: 'Améliorations', color: 'green' },
  { name: 'Nouvelles idées', color: 'purple' },
  { name: 'Bugs', color: 'orange' },
];

const only = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw httpError(400, 'invalid_body', 'Un objet JSON est attendu.');
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw httpError(400, 'invalid_body', `Champs inconnus : ${unknown.join(', ')}.`);
  return body;
};

// Modifications fines du tableau, avec une session personnelle. L’interface envoie ses
// modifications par lot (PATCH /api/v1/workspace) ; les routes par élément servent aux
// intégrations. Toutes s’appliquent sur l’état courant, sans révision à fournir.
export function contentRoutes({ store, config, guards }) {
  // Une modification qui retire réellement un projet, une liste ou une carte est précédée d’une
  // sauvegarde, une fois les droits vérifiés : un compte sans droit n’en déclenche aucune.
  const apply = (ctx, changes, options) => {
    if (
      config.backups &&
      Array.isArray(changes) &&
      changes.some(change => REMOVALS.includes(change?.type)) &&
      store.previewChanges(changes, ctx.user, options).removes
    )
      try {
        config.backups.create({ kind: 'deletion' });
      } catch {
        throw httpError(
          503,
          'backup_failed',
          'La sauvegarde de sécurité a échoué. La suppression n’a pas été enregistrée.',
        );
      }
    return store.change(changes, ctx.user, options);
  };
  const strict = (ctx, change) => apply(ctx, [change], { strict: true });
  const projectOf = (workspace, projectId) => workspace.projects.find(p => p.id === projectId);
  // Même forme que la consultation : la carte avec son projet et le nom de sa liste.
  const cardOf = (workspace, projectId, cardId) => {
    const project = projectOf(workspace, projectId);
    const card = project.cards.find(c => c.id === cardId);
    return {
      ...card,
      projectId,
      projectName: project.name,
      listName: project.lists.find(list => list.id === card.listId)?.name,
    };
  };
  const removed = ctx => ctx.send(200, { data: { deleted: true } });
  const card = '/api/v1/projects/:projectId/cards/:cardId';
  return [
    {
      path: '/api/v1/workspace',
      guard: guards.account,
      methods: {
        async PATCH(ctx) {
          const { changes, partial = false, scope = 'all' } = only(await ctx.body(), ['changes', 'partial', 'scope']);
          if (!Array.isArray(changes))
            throw httpError(400, 'invalid_change', 'Une liste de modifications est requise.');
          if (typeof partial !== 'boolean') throw httpError(400, 'invalid_change', 'partial : booléen attendu.');
          if (!['all', 'changed'].includes(scope))
            throw httpError(400, 'invalid_change', 'scope : « all » ou « changed » attendu.');
          // `partial` : les modifications refusées sont listées dans `rejected`, les autres enregistrées.
          // Le tableau renvoyé n’inclut pas le contenu des pièces jointes (voir leur route).
          const { skipped, rejected, ...workspace } = apply(ctx, changes, { partial, scope, attachmentData: false });
          ctx.res.setHeader('ETag', `"${workspace.revision}"`);
          ctx.send(200, { data: { ...workspace, skipped, ...(partial ? { rejected } : {}) } });
        },
      },
    },
    {
      path: '/api/v1/projects',
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const body = only(await ctx.body(), [...PROJECT_FIELDS, 'lists']);
          const lists = body.lists ?? DEFAULT_LISTS;
          if (!Array.isArray(lists)) throw httpError(400, 'invalid_body', 'lists : liste attendue.');
          const project = withInfos({
            id: createId(),
            name: body.name,
            description: body.description ?? '',
            emoji: body.emoji ?? '◈',
            color: body.color ?? '#e1e7cd',
            lists: lists.map(list => ({ id: createId(), name: list?.name, color: list?.color ?? 'green' })),
            cards: [],
          });
          const workspace = strict(ctx, { type: 'project.create', project });
          ctx.send(201, { data: projectOf(workspace, project.id) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId',
      guard: guards.account,
      methods: {
        async PATCH(ctx) {
          const fields = only(await ctx.body(), PROJECT_FIELDS);
          const workspace = strict(ctx, { type: 'project.update', projectId: ctx.params.projectId, fields });
          ctx.send(200, { data: projectOf(workspace, ctx.params.projectId) });
        },
        DELETE(ctx) {
          strict(ctx, { type: 'project.delete', projectId: ctx.params.projectId });
          removed(ctx);
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/lists',
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const body = only(await ctx.body(), LIST_FIELDS);
          const list = { id: createId(), name: body.name, color: body.color ?? 'green' };
          const workspace = strict(ctx, { type: 'list.create', projectId: ctx.params.projectId, list });
          ctx.send(201, { data: projectOf(workspace, ctx.params.projectId).lists.find(l => l.id === list.id) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/lists/:listId',
      guard: guards.account,
      methods: {
        async PATCH(ctx) {
          const { projectId, listId } = ctx.params;
          const fields = only(await ctx.body(), LIST_FIELDS);
          const workspace = strict(ctx, { type: 'list.update', projectId, listId, fields });
          ctx.send(200, { data: projectOf(workspace, projectId).lists.find(l => l.id === listId) });
        },
        DELETE(ctx) {
          strict(ctx, { type: 'list.delete', projectId: ctx.params.projectId, listId: ctx.params.listId });
          removed(ctx);
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/cards',
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const body = only(await ctx.body(), CARD_FIELDS);
          const created = {
            id: createId(),
            listId: body.listId,
            title: body.title,
            description: body.description ?? '',
            status: body.status ?? 'draft',
            priority: body.priority ?? 'normal',
            ...(body.aiEffort ? { aiEffort: body.aiEffort } : {}),
            tags: body.tags ?? [],
            checklist: Array.isArray(body.checklist)
              ? body.checklist.map(item => ({ id: createId(), ...item }))
              : (body.checklist ?? []),
            attachments: body.attachments ?? [],
            comments: [],
          };
          const workspace = strict(ctx, { type: 'card.create', projectId: ctx.params.projectId, card: created });
          ctx.send(201, { data: cardOf(workspace, ctx.params.projectId, created.id) });
        },
      },
    },
    {
      path: card,
      guard: guards.account,
      methods: {
        async PATCH(ctx) {
          const { projectId, cardId } = ctx.params;
          const fields = only(await ctx.body(), CARD_FIELDS);
          const workspace = strict(ctx, { type: 'card.update', projectId, cardId, fields });
          ctx.send(200, { data: cardOf(workspace, projectId, cardId) });
        },
        DELETE(ctx) {
          strict(ctx, { type: 'card.delete', projectId: ctx.params.projectId, cardId: ctx.params.cardId });
          removed(ctx);
        },
      },
    },
    {
      path: `${card}/comments`,
      guard: guards.account,
      methods: {
        async POST(ctx) {
          const { projectId, cardId } = ctx.params;
          const { text } = only(await ctx.body(), ['text']);
          const comment = { id: createId(), text };
          const workspace = strict(ctx, { type: 'comment.create', projectId, cardId, comment });
          ctx.send(201, { data: cardOf(workspace, projectId, cardId).comments.find(c => c.id === comment.id) });
        },
      },
    },
  ];
}
