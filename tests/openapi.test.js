import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../public/openapi.json', import.meta.url), 'utf8'));
const workActions = [
  'claim',
  'revise',
  'heartbeat',
  'progress',
  'question',
  'submit',
  'interrupt',
  'answer',
  'accept',
  'reject',
  'cancel',
];

// Routes servies par server/api.js : toute route ajoutée doit être décrite dans la spécification.
const routes = {
  '/api/v1/github/webhook': ['post'],
  '/api/v1/github/merge-eligibility': ['get'],
  '/api/v1/session': ['get', 'post', 'delete'],
  '/api/v1/accounts/setup': ['post'],
  '/api/v1/accounts/accept': ['post'],
  '/api/v1/accounts/password': ['post'],
  '/api/v1/users': ['get', 'post'],
  '/api/v1/users/{userId}': ['patch', 'delete'],
  '/api/v1/users/{userId}/invitation': ['post'],
  '/api/v1/agents': ['get', 'post'],
  '/api/v1/agents/{agentId}': ['put', 'delete'],
  '/api/v1/agent/projects': ['get'],
  '/api/v1/agent/projects/{projectId}/diagnostic': ['post'],
  '/api/v1/workspace': ['get', 'put'],
  '/api/v1/activity': ['get'],
  '/api/v1/backups': ['get', 'post'],
  '/api/v1/backups/{filename}': ['get'],
  '/api/v1/projects': ['get'],
  '/api/v1/projects/{projectId}': ['get'],
  '/api/v1/projects/{projectId}/lists': ['get'],
  '/api/v1/projects/{projectId}/cards': ['get'],
  '/api/v1/projects/{projectId}/cards/{cardId}': ['get'],
  '/api/v1/cards': ['get'],
  '/api/v1/cards/{cardId}': ['get'],
  '/api/v1/projects/{projectId}/activity': ['get'],
  '/api/v1/projects/{projectId}/github': ['get', 'put'],
  '/api/v1/projects/{projectId}/ai': ['get', 'put'],
  '/api/v1/projects/{projectId}/execution': ['get', 'put'],
  '/api/v1/projects/{projectId}/worker-status': ['get'],
  '/api/v1/projects/{projectId}/drive': ['get', 'post'],
  '/api/v1/projects/{projectId}/refine': ['post'],
  '/api/v1/projects/{projectId}/card-followers': ['get'],
  '/api/v1/projects/{projectId}/work': ['get'],
  '/api/v1/projects/{projectId}/cards/{cardId}/activity': ['get'],
  '/api/v1/projects/{projectId}/cards/{cardId}/subscribers': ['get', 'put'],
  '/api/v1/projects/{projectId}/cards/{cardId}/subscription': ['get', 'put'],
  '/api/v1/projects/{projectId}/cards/{cardId}/work': ['get', 'post'],
  ...Object.fromEntries(
    workActions.map(action => [`/api/v1/projects/{projectId}/cards/{cardId}/work/{executionId}/${action}`, ['post']]),
  ),
};

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
  assert.deepEqual(unknown, [], 'Une route décrite doit figurer dans la liste des routes servies.');
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
