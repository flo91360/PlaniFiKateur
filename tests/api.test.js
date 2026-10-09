import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { readConfig } from '../server/config.js';

async function fixture(t, config = {}, filename = ':memory:') {
  const store = createStore(filename);
  const server = createAppServer({ store, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, base, get: (path, headers = {}) => fetch(base + '/api/v1' + path, { headers }) };
}

test('consultation exposes persisted projects, lists and full card context', async t => {
  const { get } = await fixture(t);
  const projects = await (await get('/projects')).json();
  assert.equal(projects.data.length, 2);
  assert.equal(projects.data[0].cardCount, 8);
  assert.equal((await (await get('/projects/planifikateur')).json()).data.name, 'PlaniFiKateur');
  const lists = await (await get('/projects/planifikateur/lists')).json();
  assert.equal(lists.data[0].cardCount, 3);
  const card = await (await get('/cards/c1')).json();
  assert.equal(card.data.projectId, 'planifikateur');
  assert.equal(card.data.listName, 'Améliorations');
  assert.equal(card.data.comments.length, 1);
  assert.equal(card.data.checklist.length, 2);
  assert.equal(card.meta.revision, 1);
});

test('filters and pagination isolate the requested cards', async t => {
  const { get } = await fixture(t);
  const result = await (await get('/cards?projectId=planifikateur&listId=features&status=clarify&q=discussion')).json();
  assert.deepEqual(result.data.map(c => c.id), ['c5']);
  const page = await (await get('/projects/planifikateur/cards?limit=2&offset=2')).json();
  assert.deepEqual(page.data.map(c => c.id), ['c3', 'c4']);
  assert.deepEqual(page.meta, { revision: 1, total: 8, limit: 2, offset: 2, nextOffset: 4 });
  const last = await (await get('/cards?limit=2&offset=8')).json();
  assert.equal(last.meta.nextOffset, null);
  assert.equal((await (await get('/cards?listId=missing')).json()).data.length, 0);
});

test('invalid requests produce explicit JSON errors', async t => {
  const { get } = await fixture(t);
  for (const path of ['/cards?status=unknown', '/cards?limit=201', '/cards?limit=0', '/cards?offset=-1', '/cards?limit=banana']) {
    const response = await get(path); assert.equal(response.status, 400, path); assert.ok((await response.json()).error.code);
  }
  for (const path of ['/cards/missing', '/projects/missing', '/cards?projectId=missing', '/unknown', '/../v2/cards']) assert.equal((await get(path)).status, 404, path);
});

test('agent bearer key permits reading, never writing or owner snapshots', async t => {
  const { get, base } = await fixture(t, { ownerToken: 'owner-test-key', readToken: 'agent-test-key' });
  assert.equal((await get('/cards')).status, 401);
  assert.equal((await get('/cards', { Authorization: 'Bearer incorrect' })).status, 401);
  const headers = { Authorization: 'Bearer agent-test-key' };
  assert.equal((await get('/cards', headers)).status, 200);
  assert.equal((await get('/workspace', headers)).status, 401);
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers })).status, 401);
  assert.equal((await fetch(base + '/api/v1/cards', { method: 'POST', headers })).status, 405);
  assert.equal((await get('/cards', headers)).headers.get('cache-control'), 'no-store');
});

test('owner authentication saves UI data and makes it visible to the agent', async t => {
  const { base, get } = await fixture(t, { ownerToken: 'owner-test-key', readToken: 'agent-test-key' });
  assert.deepEqual(await (await get('/session')).json(), { authenticated: false, requiresLogin: true });
  const bad = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'agent-test-key' }) });
  assert.equal(bad.status, 401);
  const login = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'owner-test-key' }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const workspace = await (await get('/workspace', { Cookie })).json();
  workspace.projects[0].cards[0].title = 'Créée depuis l’interface';
  const response = await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify({ projects: workspace.projects }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"2"');
  const card = await (await get('/cards/c1', { Authorization: 'Bearer agent-test-key' })).json();
  assert.equal(card.data.title, 'Créée depuis l’interface');
  assert.equal(card.meta.revision, 2);
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie, Origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(base + '/api/v1/session', { method: 'DELETE', headers: { Cookie } })).status, 200);
  assert.equal((await get('/workspace', { Cookie })).status, 401);
});

test('concurrent editors cannot silently overwrite one another', async t => {
  const { get, base } = await fixture(t);
  const session = await get('/session');
  const Cookie = session.headers.get('set-cookie').split(';')[0];
  const original = await (await get('/workspace', { Cookie })).json();
  const writes = ['premier', 'second'].map(title => {
    const projects = structuredClone(original.projects); projects[0].cards[0].title = title;
    return fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify({ projects }) });
  });
  assert.deepEqual((await Promise.all(writes)).map(r => r.status).sort(), [200, 409]);
  assert.equal((await (await get('/cards/c1')).json()).meta.revision, 2);
});

test('invalid snapshots leave existing data intact', async t => {
  const { get, base } = await fixture(t);
  const Cookie = (await get('/session')).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' };
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie }, body: '{}' })).status, 428);
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const { projects } = await (await get('/workspace', { Cookie })).json();
  projects[0].cards[0].listId = 'missing';
  const invalid = await fetch(base + '/api/v1/workspace', { method: 'PUT', headers, body: JSON.stringify({ projects }) });
  assert.equal(invalid.status, 400);
  assert.equal((await (await get('/cards/c1')).json()).meta.revision, 1);
});

test('SQLite retains cards after closing and reopening the database', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'data.sqlite');
  const first = createStore(filename), initial = first.read();
  initial.projects[0].cards[0].title = 'Persistante';
  first.write(initial.projects, 1); first.close();
  const second = createStore(filename);
  assert.equal(second.read().projects[0].cards[0].title, 'Persistante');
  assert.equal(second.read().revision, 2); second.close();
});

test('oversized requests fail with JSON without preventing later reads', async t => {
  const { get, base } = await fixture(t);
  const Cookie = (await get('/session')).headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'payload_too_large');
  assert.equal((await get('/projects')).status, 200);
});

test('owner login attempts are rate limited', async t => {
  const { base } = await fixture(t, { ownerToken: 'owner-test-key', readToken: 'read-test-key' });
  for (let i = 0; i < 20; i++) {
    const response = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"wrong"}' });
    assert.equal(response.status, 401);
  }
  const response = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"wrong"}' });
  assert.equal(response.status, 429);
});

test('public binding requires separate owner and agent keys', () => {
  assert.throws(() => readConfig({ PLANIFIKATEUR_HOST: '0.0.0.0' }), /clés|TOKEN/);
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /TOKEN/);
  assert.throws(() => readConfig({ PLANIFIKATEUR_OWNER_TOKEN: 'same', PLANIFIKATEUR_READ_TOKEN: 'same' }), /différentes/);
  assert.equal(readConfig({}).host, '127.0.0.1');
});
