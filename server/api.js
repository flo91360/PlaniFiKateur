import { createAuth } from './auth.js';
import { readJson, sendJson } from './http.js';
import { createRefiner } from './refine.js';
import { createRouter, dispatch } from './router.js';
import { accountRoutes } from './routes/accounts.js';
import { cardRoutes } from './routes/cards.js';
import { consultationFallback, consultationRoutes } from './routes/consultation.js';
import { contentRoutes } from './routes/content.js';
import { eventRoutes } from './routes/events.js';
import { githubRoutes } from './routes/github.js';
import { projectRoutes } from './routes/projects.js';
import { workRoutes } from './routes/work.js';
import { workspaceRoutes } from './routes/workspace.js';

// Table des routes de l’API. Chaque module décrit un domaine ; les chemins sont exacts. Quand
// deux modules partagent un chemin, le garde du premier s’applique aux méthodes inconnues : la
// consultation précède donc les modifications. tests/openapi.test.js vérifie la documentation.
export function apiRoutes(store, config = {}, auth = createAuth(store, config), streams = new Set()) {
  const guards = {
    account: ctx => (ctx.user = auth.requireAccount(ctx.req)),
    admin: ctx => (ctx.user = auth.requireAdmin(ctx.req)),
    // Projet visible par le compte connecté (droits par projet) ; sinon 404.
    project: ctx => {
      guards.account(ctx);
      ctx.role = store.requireProject(ctx.user, ctx.params.projectId);
    },
  };
  const refiner = config.refiner || createRefiner({ token: config.claudeOauthToken, model: config.refineModel });
  const app = { store, config, auth, guards, refiner, streams };
  return [
    ...githubRoutes(app),
    ...accountRoutes(app),
    ...projectRoutes(app),
    ...workRoutes(app),
    ...cardRoutes(app),
    ...workspaceRoutes(app),
    ...consultationRoutes(app),
    ...contentRoutes(app),
    ...eventRoutes(app),
  ];
}

export function createApi(store, config = {}) {
  const { logError = console.error } = config;
  const auth = createAuth(store, config);
  // Flux d’événements ouverts : fermés à l’arrêt du serveur, sinon il attendrait leur fin.
  const streams = new Set();
  const router = createRouter(apiRoutes(store, config, auth, streams));
  const fallback = consultationFallback(auth);
  const api = async (req, res, next) => {
    if (!req.url.startsWith('/api/') && req.url !== '/api') {
      next?.();
      return false;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      const ctx = { req, res, url, body: () => readJson(req), send: (status, data) => sendJson(res, status, data) };
      const match = router.match(url.pathname);
      if (match) await dispatch(match, ctx);
      else fallback(ctx);
    } catch (error) {
      // Une erreur sans statut HTTP est inattendue : la journaliser pour le diagnostic.
      // Seuls la méthode et le chemin sont écrits, jamais les paramètres, en-têtes ou corps.
      if (!error.status) logError(`PlaniFiKateur : erreur interne sur ${req.method} ${req.url.split('?')[0]}`, error);
      sendJson(res, error.status || 500, {
        error: {
          code: error.code || 'internal_error',
          message: error.status ? error.message : 'Erreur interne du serveur.',
        },
      });
    }
    return true;
  };
  api.close = () => {
    for (const stream of [...streams]) stream.close();
  };
  return api;
}
