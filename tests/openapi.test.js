import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiRoutes } from '../server/api.js';
import { createStore } from '../server/store.js';

const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
// Routes servies par server/api.js, lues dans sa table : toute route ajoutée doit être décrite.
const store = createStore(':memory:');
test.after(() => store.close());
const routes = {};
for (const route of apiRoutes(store)) {
  const path = route.path.replace(/:([a-zA-Z]+)/g, '{$1}');
  routes[path] = Object.keys(route.methods).map(method => method.toLowerCase());
}

const resolve = ref => {
  assert.match(ref, /^#\/components\//, `Référence externe non prise en charge : ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node?.[key], spec);
};

test('every route served by the API is described in the OpenAPI specification', () => {
  const missing = Object.entries(routes).flatMap(([path, methods]) =>
    methods.filter(method => !spec.paths[path]?.[method]).map(method => `${method.toUpperCase()} ${path}`),
  );
  assert.deepEqual(missing, []);
  const unknown = Object.keys(spec.paths).filter(path => !routes[path]);
  assert.deepEqual(unknown, [], 'Une route décrite doit être servie par l’API.');
});

test('OpenAPI operations declare their path parameters, responses and resolvable references', () => {
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  for (const [path, item] of Object.entries(spec.paths)) {
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
    for (const method of methods.filter(method => item[method])) {
      const operation = item[method];
      const label = `${method.toUpperCase()} ${path}`;
      assert.ok(operation.summary, `${label} : résumé manquant`);
      assert.ok(Object.keys(operation.responses || {}).length, `${label} : réponses manquantes`);
      const parameters = [...(item.parameters || []), ...(operation.parameters || [])].map(parameter =>
        parameter.$ref ? resolve(parameter.$ref) : parameter,
      );
      for (const name of names)
        assert.ok(
          parameters.some(parameter => parameter?.in === 'path' && parameter.name === name && parameter.required),
          `${label} : paramètre de chemin ${name} non déclaré`,
        );
    }
  }
  const references = JSON.stringify(spec).match(/"\$ref":"[^"]+"/g) || [];
  for (const reference of new Set(references)) {
    const ref = JSON.parse(`{${reference}}`).$ref;
    assert.ok(resolve(ref), `Référence introuvable : ${ref}`);
  }
});
