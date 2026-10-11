import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { readConfig } from '../server/config.js';
import { seedAccount, testEmail, testPassword, loginRequest } from './helpers/accounts.mjs';

async function fixture(t, config = {}, filename = ':memory:') {
  const store = createStore(filename);
  seedAccount(store);
  const actualConfig = { ...config, readToken: config.readToken || 'local-test-agent' };
  const server = createAppServer({ store, config: actualConfig });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  return { store, base, get: (path, headers = {}) => path === '/session' && !config.ownerToken ? loginRequest(base) : fetch(base + '/api/v1' + path, { headers: { Authorization: `Bearer ${actualConfig.readToken}`, ...headers } }) };
}

test('consultation exposes persisted projects, lists and full card context', async t => {
  const { get } = await fixture(t);
  const projects = await (await get('/projects')).json();
  assert.equal(projects.data.length, 2);
  assert.equal(projects.data[0].cardCount, 8);
  assert.equal((await (await get('/projects/planifikateur')).json()).data.name, 'PlaniFiKateur');
  const lists = await (await get('/projects/planifikateur/lists')).json();
  assert.equal(lists.data[0].cardCount, 3);
  const card = await (await get('/projects/planifikateur/cards/c1')).json();
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
  const last = await (await get('/projects/planifikateur/cards?limit=2&offset=8')).json();
  assert.equal(last.meta.nextOffset, null);
  assert.equal((await (await get('/projects/planifikateur/cards?listId=missing')).json()).data.length, 0);
});

test('invalid requests produce explicit JSON errors', async t => {
  const { get } = await fixture(t);
  for (const path of ['/projects/planifikateur/cards?status=unknown', '/projects/planifikateur/cards?limit=201', '/projects/planifikateur/cards?limit=0', '/projects/planifikateur/cards?offset=-1', '/projects/planifikateur/cards?limit=banana']) {
    const response = await get(path); assert.equal(response.status, 400, path); assert.ok((await response.json()).error.code);
  }
  for (const path of ['/projects/planifikateur/cards/missing', '/projects/missing', '/cards?projectId=missing', '/unknown', '/../v2/cards']) assert.equal((await get(path)).status, 404, path);
});

test('agent bearer key permits reading, never writing or owner snapshots', async t => {
  const { get, base } = await fixture(t, { ownerToken: 'owner-test-key', readToken: 'agent-test-key' });
  assert.equal((await fetch(base + '/api/v1/cards?projectId=planifikateur')).status, 401);
  assert.equal((await get('/cards?projectId=planifikateur', { Authorization: 'Bearer incorrect' })).status, 401);
  const headers = { Authorization: 'Bearer agent-test-key' };
  assert.equal((await get('/cards?projectId=planifikateur', headers)).status, 200);
  assert.equal((await get('/workspace', headers)).status, 401);
  assert.equal((await fetch(base + '/api/v1/workspace', { method: 'PUT', headers })).status, 401);
  assert.equal((await fetch(base + '/api/v1/cards', { method: 'POST', headers })).status, 405);
  assert.equal((await get('/cards?projectId=planifikateur', headers)).headers.get('cache-control'), 'no-store');
});

test('owner authentication saves UI data and makes it visible to the agent', async t => {
  const { base, get } = await fixture(t, { ownerToken: 'owner-test-key', readToken: 'agent-test-key' });
  const sessionState = await (await get('/session')).json(); assert.equal(sessionState.authenticated, false); assert.equal(sessionState.needsSetup, false);
  const bad = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'agent-test-key' }) });
  assert.equal(bad.status, 401);
  const login = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: testEmail, password: testPassword }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const workspace = await (await get('/workspace', { Cookie })).json();
  workspace.projects[0].cards[0].title = 'Créée depuis l’interface';
  workspace.projects[0].cards[0].status = 'flo';
  const response = await fetch(base + '/api/v1/workspace', { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify({ projects: workspace.projects }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), '"2"');
  const card = await (await get('/projects/planifikateur/cards/c1', { Authorization: 'Bearer agent-test-key' })).json();
  assert.equal(card.data.title, 'Créée depuis l’interface');
  assert.equal(card.data.status, 'flo');
  const filtered = await get('/projects/planifikateur/cards?status=flo');
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).data.map(card => card.id), ['c1']);
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
  assert.equal((await (await get('/projects/planifikateur/cards/c1')).json()).meta.revision, 2);
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
  assert.equal((await (await get('/projects/planifikateur/cards/c1')).json()).meta.revision, 1);
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
    const response = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"owner@example.test","password":"wrong"}' });
    assert.equal(response.status, 401);
  }
  const response = await fetch(base + '/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"owner@example.test","password":"wrong"}' });
  assert.equal(response.status, 429);
});

test('public binding requires separate owner and agent keys', () => {
  assert.throws(() => readConfig({ PLANIFIKATEUR_HOST: '0.0.0.0' }), /clés|TOKEN/);
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /TOKEN/);
  assert.throws(() => readConfig({ PLANIFIKATEUR_OWNER_TOKEN: 'same', PLANIFIKATEUR_READ_TOKEN: 'same' }), /différentes/);
  assert.equal(readConfig({}).host, '127.0.0.1');
});

test('deleting every project persists an empty workspace after reopening SQLite', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'data.sqlite');
  const store = createStore(filename);
  assert.deepEqual(store.write([], 1).projects, []);
  store.close();
  const reopened = createStore(filename);
  assert.deepEqual(reopened.read().projects, []);
  assert.equal(reopened.read().revision, 2);
  reopened.close();
});

test('card consultation requires a single explicit project', async t => {
  const { get } = await fixture(t);
  for (const path of ['/cards', '/cards?q=menu', '/cards/c1', '/cards?projectId=', '/cards/c1?projectId=', '/cards?projectId=planifikateur&projectId=website', '/projects/planifikateur/cards?projectId=website', '/projects/planifikateur/cards/c1?projectId=website']) {
    const response = await get(path);
    assert.equal(response.status, 400, path);
    assert.ok(['project_required', 'invalid_project_scope'].includes((await response.json()).error.code));
  }
  assert.equal((await get('/cards/c1?projectId=planifikateur')).status, 200);
  assert.equal((await get('/cards/c1?projectId=website')).status, 404);
  assert.equal((await get('/projects/website/cards/c1')).status, 404);
  assert.equal((await get('/projects/missing/cards/c1')).status, 404);
});

test('identical card titles in different projects never mix results', async t => {
  const { store, get } = await fixture(t);
  const { projects, revision } = store.read();
  projects[1].name = 'Klaviflo';
  projects[0].cards[0].title = projects[1].cards[0].title = 'Amélioration menu principal';
  projects[0].cards[0].description = 'Menu de PlaniFiKateur';
  projects[1].cards[0].description = 'Menu de Klaviflo';
  store.write(projects, revision);
  for (const p of projects) {
    const query = encodeURIComponent('Amélioration menu principal');
    for (const path of [`/projects/${p.id}/cards?q=${query}`, `/cards?projectId=${p.id}&q=${query}`]) {
      const response = await get(path);
      assert.equal(response.status, 200);
      const { data, meta } = await response.json();
      assert.equal(meta.total, 1);
      assert.equal(data[0].id, p.cards[0].id);
      assert.equal(data[0].projectId, p.id);
    }
    const own = await (await get(`/projects/${p.id}/cards/${p.cards[0].id}`)).json();
    assert.equal(own.data.description, p.cards[0].description);
    const other = projects.find(project => project.id !== p.id);
    assert.equal((await get(`/projects/${p.id}/cards/${other.cards[0].id}`)).status, 404);
  }
});

test('conditional workspace reads return 304 only for authenticated unchanged revisions', async t => {
  const { get, store } = await fixture(t);
  const Cookie = (await get('/session')).headers.get('set-cookie').split(';')[0];
  const initial = await get('/workspace', { Cookie });
  const etag = initial.headers.get('etag');
  assert.equal((await get('/workspace', { 'If-None-Match': etag })).status, 401);
  const unchanged = await get('/workspace', { Cookie, 'If-None-Match': etag });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  store.write([], 1);
  const changed = await get('/workspace', { Cookie, 'If-None-Match': etag });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('etag'), '"2"');
  assert.deepEqual((await changed.json()).projects, []);
});
