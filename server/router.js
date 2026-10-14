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

// Plusieurs modules peuvent décrire le même chemin (consultation en GET, modifications en
// POST/PATCH/DELETE) : leurs méthodes sont regroupées et chacune garde le garde de son module.
const group = routes => {
  const byPath = new Map();
  for (const route of routes) {
    const methods = Object.fromEntries(
      Object.entries(route.methods).map(([method, handler]) => [method, { guard: route.guard, handler }]),
    );
    const existing = byPath.get(route.path);
    if (!existing) byPath.set(route.path, { ...route, methods });
    else {
      const duplicate = Object.keys(methods).find(method => existing.methods[method]);
      if (duplicate) throw new Error(`Route déclarée deux fois : ${duplicate} ${route.path}`);
      existing.methods = { ...existing.methods, ...methods };
      existing.notAllowed = undefined;
    }
  }
  return [...byPath.values()];
};

export function createRouter(routes) {
  const compiled = group(routes).map(route => ({ ...route, pattern: compile(route.path) }));
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
  const method = route.methods[ctx.req.method];
  await (method ? method.guard : route.guard)?.(ctx);
  if (!method) throw httpError(405, 'method_not_allowed', route.notAllowed || 'Méthode non autorisée.');
  await method.handler(ctx);
}
