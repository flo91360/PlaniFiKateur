import { STATUSES } from '../../src/lib/workspace.js';
import { httpError } from '../http.js';

const onlyGet = 'Cette API de consultation accepte uniquement GET.';
const summary = p => ({
  id: p.id,
  name: p.name,
  description: p.description,
  emoji: p.emoji,
  color: p.color,
  listCount: p.lists.length,
  cardCount: p.cards.length,
});
const cardContext = (p, c) => ({
  ...c,
  projectId: p.id,
  projectName: p.name,
  listName: p.lists.find(l => l.id === c.listId)?.name,
});

function pageNumber(url, key, fallback, max) {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max ||
    (key === 'limit' && Number(value) === 0)
  )
    throw httpError(400, 'invalid_pagination', `${key} invalide.`);
  return Number(value);
}

// Consultation en lecture seule : session, clé de lecture ou clé d’agent (limitée à ses projets).
// Chaque réponse indique la révision du tableau lue.
export function consultationRoutes({ store, auth }) {
  const guard = ctx => {
    ctx.agent = auth.readAccess(ctx.req);
  };
  const read = (ctx, data, meta = {}) => ctx.send(200, { data, meta: { revision: ctx.workspace.revision, ...meta } });
  const load = ctx => {
    ctx.workspace = store.read();
    return ctx.workspace.projects;
  };
  const allowed = (ctx, projectId) => {
    if (ctx.agent && !ctx.agent.projectIds.includes(projectId))
      throw httpError(403, 'agent_scope', 'Projet non autorisé pour cet agent.');
  };
  const project = ctx => {
    const projects = load(ctx);
    const p = projects.find(item => item.id === ctx.params.projectId);
    allowed(ctx, ctx.params.projectId);
    if (!p) throw httpError(404, 'project_not_found', 'Projet inexistant.');
    return p;
  };
  // Les routes /cards exigent le projet, dans le chemin ou en paramètre projectId (pas les deux en désaccord).
  const scopedProject = ctx => {
    const projects = load(ctx);
    const pathId = ctx.params.projectId;
    const values = ctx.url.searchParams.getAll('projectId');
    if (values.length > 1 || (values.length && (!values[0].trim() || (pathId && values[0] !== pathId))))
      throw httpError(400, 'invalid_project_scope', 'Indiquez un seul projet, identique à celui du chemin.');
    const projectId = pathId || values[0];
    allowed(ctx, projectId);
    if (!projectId) throw httpError(400, 'project_required', 'Précisez le projet dans le chemin ou avec projectId.');
    const p = projects.find(item => item.id === projectId);
    if (!p) throw httpError(404, 'project_not_found', 'Projet inexistant.');
    return p;
  };
  const cards = ctx => {
    const p = scopedProject(ctx);
    const status = ctx.url.searchParams.get('status'),
      listId = ctx.url.searchParams.get('listId'),
      q = (ctx.url.searchParams.get('q') || '').trim().toLocaleLowerCase('fr');
    if (status && !STATUSES.includes(status)) throw httpError(400, 'invalid_filter', 'Statut inconnu.');
    const limit = pageNumber(ctx.url, 'limit', 50, 200),
      offset = pageNumber(ctx.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const filtered = p.cards
      .map(c => cardContext(p, c))
      .filter(
        c =>
          (!status || c.status === status) &&
          (!listId || c.listId === listId) &&
          (!q || `${c.title} ${c.description} ${c.tags.join(' ')}`.toLocaleLowerCase('fr').includes(q)),
      );
    read(ctx, filtered.slice(offset, offset + limit), {
      total: filtered.length,
      limit,
      offset,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
    });
  };
  const card = ctx => {
    const p = scopedProject(ctx);
    const c = p.cards.find(item => item.id === ctx.params.cardId);
    if (!c) throw httpError(404, 'card_not_found', 'Carte inexistante dans ce projet.');
    read(ctx, cardContext(p, c));
  };
  const route = (path, handler) => ({ path, guard, notAllowed: onlyGet, methods: { GET: handler } });
  return [
    route('/api/v1/projects', ctx =>
      read(
        ctx,
        load(ctx)
          .filter(p => !ctx.agent || ctx.agent.projectIds.includes(p.id))
          .map(summary),
      ),
    ),
    route('/api/v1/projects/:projectId', ctx => read(ctx, summary(project(ctx)))),
    route('/api/v1/projects/:projectId/lists', ctx => {
      const p = project(ctx);
      read(
        ctx,
        p.lists.map(l => ({ ...l, cardCount: p.cards.filter(c => c.listId === l.id).length })),
      );
    }),
    route('/api/v1/projects/:projectId/cards', cards),
    route('/api/v1/cards', cards),
    route('/api/v1/projects/:projectId/cards/:cardId', card),
    route('/api/v1/cards/:cardId', card),
  ];
}

// Chemin inconnu : même authentification que la consultation, puis 405 ou 404.
export function consultationFallback(auth) {
  return ctx => {
    auth.readAccess(ctx.req);
    if (ctx.req.method !== 'GET') throw httpError(405, 'method_not_allowed', onlyGet);
    throw httpError(404, 'not_found', 'Route inexistante.');
  };
}
