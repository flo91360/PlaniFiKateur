import { httpError } from './http.js';

// Table de routes : un chemin (« /api/v1/projects/:projectId/ai ») regroupe ses méthodes.
// Le garde du groupe s’exécute avant le contrôle de méthode : une route protégée répond
// 401 ou 403 avant 405, comme l’API l’a toujours fait.
//   { path, guard?: ctx => void, methods: { GET: ctx => …, PUT: ctx => … }, notAllowed?: message }
const compile = path =>
  new RegExp(
    `^${path
      .split('/')
      .map(part => (part.startsWith(':') ? `(?<${part.slice(1)}>[^/]+)` : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}$`,
  );

const decode = groups =>
  Object.fromEntries(
    Object.entries(groups || {}).map(([name, value]) => {
      try {
        return [name, decodeURIComponent(value)];
      } catch {
        throw httpError(400, 'invalid_path', 'Chemin invalide.');
      }
    }),
  );

export function createRouter(routes) {
  const compiled = routes.map(route => ({ ...route, pattern: compile(route.path) }));
  return {
    // Liste méthode + chemin, utilisée par le test de couverture OpenAPI.
    routes: compiled.flatMap(route => Object.keys(route.methods).map(method => ({ method, path: route.path }))),
    // Renvoie { route, params } ou null si aucun chemin ne correspond.
    match(pathname) {
      for (const route of compiled) {
        const match = route.pattern.exec(pathname);
        if (match) return { route, params: decode(match.groups) };
      }
      return null;
    },
  };
}

export async function dispatch({ route, params }, ctx) {
  ctx.params = params;
  await route.guard?.(ctx);
  const handler = route.methods[ctx.req.method];
  if (!handler) throw httpError(405, 'method_not_allowed', route.notAllowed || 'Méthode non autorisée.');
  await handler(ctx);
}
