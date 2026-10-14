import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { allows, requirements } from '../server/access.js';
import { seedAccount, testEmail, testPassword } from './helpers/accounts.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-access-'));
  const file = join(dir, 'site.sqlite');
  const store = createStore(file);
  const admin = seedAccount(store);
  const server = createAppServer({
    store,
    config: { readToken: 'access-read-token', githubWebhookSecret: 'access-webhook-secret' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, path, data, cookie) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (email, password) => {
    const response = await fetch(base + '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return response.headers.get('set-cookie').split(';')[0];
  };
  const adminCookie = await login(testEmail, testPassword);
  const invite = async name => {
    const invited = await call('POST', '/users', { name, email: `${name.toLowerCase()}@example.test` }, adminCookie);
    const password = `${name}-mot-de-passe-123`;
    await call('POST', '/accounts/accept', { token: invited.body.data.token, name, password });
    return { id: invited.body.data.user.id, cookie: await login(`${name.toLowerCase()}@example.test`, password) };
  };
  store.workflows.configureGithub('planifikateur', 'flo91360/PlaniFiKateur', admin);
  return { store, file, base, admin, adminCookie, call, invite };
}

const cardChange = (fields, cardId = 'c3') => ({
  changes: [{ type: 'card.update', projectId: 'planifikateur', cardId, fields }],
});

test('roles are ordered and only entrusting a card to the agent needs a manager', () => {
  assert.ok(allows('manager', 'editor') && allows('editor', 'viewer') && !allows('viewer', 'editor'));
  assert.equal(allows(undefined, 'viewer'), false);
  assert.deepEqual(requirements({ type: 'card.update', projectId: 'p', fields: { title: 'x' } }), [['p', 'editor']]);
  assert.deepEqual(requirements({ type: 'card.update', projectId: 'p', fields: { status: 'ready' } }), [
    ['p', 'manager'],
  ]);
  assert.deepEqual(requirements({ type: 'card.create', projectId: 'p', card: { status: 'ready' } }), [
    ['p', 'manager'],
  ]);
  assert.deepEqual(requirements({ type: 'project.delete', projectId: 'p' }), [['p', 'manager']]);
  assert.deepEqual(requirements({ type: 'project.create', project: {} }), []);
});

test('members edit by default but only managers and administrators entrust cards to the agent', async t => {
  const { call, invite, adminCookie, store } = await fixture(t);
  const bob = await invite('Bob');
  const workspace = await call('GET', '/workspace', undefined, bob.cookie);
  assert.deepEqual(workspace.body.access, { planifikateur: 'editor', website: 'editor' });
  assert.equal((await call('PATCH', '/workspace', cardChange({ title: 'Titre de Bob' }), bob.cookie)).status, 200);
  const refused = await call('PATCH', '/workspace', cardChange({ status: 'ready' }), bob.cookie);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'project_forbidden');
  assert.equal(
    (await call('POST', '/projects/planifikateur/cards/c3/work', {}, bob.cookie)).status,
    403,
    'Confier une carte depuis le panneau est aussi réservé.',
  );
  assert.equal((await call('DELETE', '/projects/planifikateur', undefined, bob.cookie)).status, 403);
  assert.equal((await call('PUT', '/workspace', {}, bob.cookie)).status, 403, 'Le remplacement complet est réservé.');
  assert.equal((await call('PATCH', '/workspace', cardChange({ status: 'ready' }), adminCookie)).status, 200);
  assert.equal(store.read().projects[0].cards.find(c => c.id === 'c3').status, 'ready');
  const prepared = await call('POST', '/projects/planifikateur/cards/c2/work', {}, adminCookie);
  assert.equal(prepared.status, 201);
  const run = prepared.body.data;
  // Un contributeur peut annuler, pas faire corriger le travail.
  const cancel = await call(
    'POST',
    `/projects/planifikateur/cards/c2/work/${run.id}/cancel`,
    { version: run.version, message: 'Plus utile.' },
    bob.cookie,
  );
  assert.equal(cancel.status, 200);
});

test('a project hidden from other members disappears from every read and write of theirs', async t => {
  const { base, call, invite, adminCookie, store } = await fixture(t);
  const bob = await invite('Bob');
  const carol = await invite('Carol');
  const configured = await call(
    'PUT',
    '/projects/website/members',
    { memberRole: 'none', members: { [carol.id]: 'viewer' } },
    adminCookie,
  );
  assert.equal(configured.status, 200);
  assert.equal(configured.body.data.members.find(m => m.id === bob.id).role, null);
  assert.equal(configured.body.data.members.find(m => m.id === carol.id).role, 'viewer');
  const bobView = await call('GET', '/workspace', undefined, bob.cookie);
  assert.deepEqual(
    bobView.body.projects.map(p => p.id),
    ['planifikateur'],
  );
  for (const path of [
    '/projects/website',
    '/projects/website/cards',
    '/projects/website/github',
    '/projects/website/members',
    '/projects/website/activity',
    '/projects/website/card-followers',
    '/projects/website/cards/w-card/work',
  ])
    assert.equal((await call('GET', path, undefined, bob.cookie)).status, 404, path);
  assert.deepEqual(
    (await call('GET', '/projects', undefined, bob.cookie)).body.data.map(p => p.id),
    ['planifikateur'],
  );
  const hidden = await call(
    'PATCH',
    '/workspace',
    { changes: [{ type: 'card.update', projectId: 'website', cardId: 'w-card', fields: { title: 'x' } }] },
    bob.cookie,
  );
  assert.deepEqual(hidden.body.data.skipped, [{ index: 0, type: 'card.update', reason: 'missing' }]);
  assert.equal((await call('PATCH', '/projects/website/cards/w-card', { title: 'x' }, bob.cookie)).status, 404);
  assert.equal(
    (await call('GET', '/activity?limit=100', undefined, bob.cookie)).body.data.some(e => e.projectId === 'website'),
    false,
  );
  // Lecture seule pour Carol : elle voit le projet, sans pouvoir le modifier.
  const carolView = await call('GET', '/workspace', undefined, carol.cookie);
  assert.equal(carolView.body.access.website, 'viewer');
  const readOnly = await call(
    'PATCH',
    '/workspace',
    { changes: [{ type: 'card.update', projectId: 'website', cardId: 'w-card', fields: { title: 'x' } }] },
    carol.cookie,
  );
  assert.equal(readOnly.status, 403);
  assert.equal((await call('PUT', '/projects/website/members', { memberRole: 'editor' }, carol.cookie)).status, 403);
  assert.ok(
    store.read().projects.some(p => p.id === 'website'),
    'Le projet masqué n’est jamais supprimé.',
  );
  // La clé de lecture des agents garde la vue complète.
  const agents = await fetch(`${base}/projects`, { headers: { Authorization: 'Bearer access-read-token' } });
  assert.deepEqual(
    (await agents.json()).data.map(p => p.id),
    ['planifikateur', 'website'],
  );
});

test('the creator of a project manages it and can name its members; invalid settings are refused', async t => {
  const { call, invite, adminCookie } = await fixture(t);
  const bob = await invite('Bob');
  const carol = await invite('Carol');
  const created = await call('POST', '/projects', { name: 'Projet de Bob' }, bob.cookie);
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal((await call('GET', '/workspace', undefined, bob.cookie)).body.access[id], 'manager');
  assert.equal((await call('GET', '/workspace', undefined, carol.cookie)).body.access[id], 'editor');
  const access = await call(
    'PUT',
    `/projects/${id}/members`,
    { memberRole: 'viewer', members: { [carol.id]: 'manager' } },
    bob.cookie,
  );
  assert.equal(access.status, 200);
  assert.equal(access.body.data.memberRole, 'viewer');
  assert.equal((await call('GET', '/workspace', undefined, carol.cookie)).body.access[id], 'manager');
  const back = await call('PUT', `/projects/${id}/members`, { members: { [carol.id]: null } }, bob.cookie);
  assert.equal(back.body.data.members.find(m => m.id === carol.id).role, 'viewer');
  const admin = (await call('GET', '/session', undefined, adminCookie)).body.user;
  for (const data of [
    { memberRole: 'owner' },
    { members: { [carol.id]: 'owner' } },
    { members: { [admin.id]: 'viewer' } },
    { members: { inconnu: 'viewer' } },
    { members: [] },
    { visibility: 'private' },
  ])
    assert.equal((await call('PUT', `/projects/${id}/members`, data, bob.cookie)).status, 400, JSON.stringify(data));
});

test('existing projects keep their creator as manager after the upgrade', async t => {
  const { file, invite, call } = await fixture(t);
  const bob = await invite('Bob');
  const created = await call('POST', '/projects', { name: 'Avant les droits' }, bob.cookie);
  const id = created.body.data.id;
  const db = new DatabaseSync(file);
  db.exec('DELETE FROM project_policies; DELETE FROM project_members;');
  db.close();
  const upgraded = createStore(file);
  t.after(() => upgraded.close());
  const bobUser = upgraded.userById(bob.id);
  assert.equal(upgraded.projectRole({ ...bobUser, active: true }, id), 'manager');
  assert.equal(upgraded.projectRole({ ...bobUser, active: true }, 'planifikateur'), 'editor');
});

test('a card made ready by someone who cannot launch the agent is not taken by the worker', async t => {
  const { store, invite, admin } = await fixture(t);
  const bob = await invite('Bob');
  const { token } = store.workflows.configureAgent({ name: 'Worker', projectIds: ['planifikateur'] }, admin);
  const agent = store.workflows.agent(token);
  // Carte rendue prête par un contributeur avant la mise à jour (écriture directe, sans contrôle des droits).
  const setStatus = (status, actor) => {
    const { projects, revision } = store.read();
    projects[0].cards.find(card => card.id === 'c3').status = status;
    store.write(projects, revision, actor);
  };
  setStatus('ready', { ...store.userById(bob.id), active: true, role: 'member' });
  store.workflows.queue('planifikateur', agent);
  assert.deepEqual(store.workflows.list('planifikateur', 'c3'), []);
  setStatus('draft', admin);
  setStatus('ready', admin);
  store.workflows.queue('planifikateur', agent);
  assert.equal(store.workflows.list('planifikateur', 'c3')[0].requestedBy.id, admin.id);
});
