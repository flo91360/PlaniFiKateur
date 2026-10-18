import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { hashPassword } from '../server/accounts.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { seedAccount } from './helpers/accounts.mjs';

const update = (store, actor, cardId, fields) =>
  store.change([{ type: 'card.update', projectId: 'planifikateur', cardId, fields }], actor);
const card = (store, id) => store.read().projects[0].cards.find(item => item.id === id);
const failure = code => error => error.code === code;

test('due date, assignee and archive are validated, stored, and removed with null', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const alice = seedAccount(store);
  const { token } = store.inviteUser({ name: 'Bob', email: 'bob@example.test' }, alice);
  const bob = store.acceptInvitation(token, 'Bob', await hashPassword('bob-mot-de-passe-123'));
  update(store, alice, 'c1', { dueDate: '2026-11-03', assigneeId: bob.id, archived: true });
  assert.deepEqual(
    {
      dueDate: card(store, 'c1').dueDate,
      assigneeId: card(store, 'c1').assigneeId,
      archived: card(store, 'c1').archived,
    },
    { dueDate: '2026-11-03', assigneeId: bob.id, archived: true },
  );
  const history = store.activity().find(event => event.action === 'card.updated' && event.cardId === 'c1');
  assert.deepEqual(history.details.fields.sort(), ['archived', 'assigneeId', 'dueDate']);
  update(store, alice, 'c1', { dueDate: null, assigneeId: null, archived: null });
  for (const key of ['dueDate', 'assigneeId', 'archived']) assert.equal(key in card(store, 'c1'), false);
  for (const dueDate of ['2026-02-30', '03/11/2026', 20261103])
    assert.throws(() => update(store, alice, 'c1', { dueDate }), /Échéance invalide/);
  assert.throws(() => update(store, alice, 'c1', { archived: 'oui' }), /booléen/);
  // Le responsable doit être un membre actif qui voit le projet.
  assert.throws(() => update(store, alice, 'c1', { assigneeId: 'inconnu' }), failure('invalid_assignee'));
  store.configureProjectAccess('planifikateur', { memberRole: 'none' }, alice);
  assert.throws(() => update(store, alice, 'c2', { assigneeId: bob.id }), failure('invalid_assignee'));
  update(store, alice, 'c2', { assigneeId: alice.id });
  assert.equal(card(store, 'c2').assigneeId, alice.id);
});

test('an archived card leaves the agent queue and cannot be archived while the agent works on it', () => {
  const store = createStore(':memory:');
  try {
    const alice = seedAccount(store);
    store.workflows.configureGithub('planifikateur', 'owner/repo', alice);
    const run = store.workflows.prepare('planifikateur', 'c1', {}, alice);
    assert.throws(() => update(store, alice, 'c1', { archived: true }), failure('managed_status'));
    store.workflows.human('planifikateur', 'c1', run.id, 'cancel', { version: run.version, message: 'Stop.' }, alice);
    update(store, alice, 'c1', { archived: true });
    assert.throws(() => store.workflows.prepare('planifikateur', 'c1', {}, alice), failure('archived_card'));
    // Une carte archivée « Prête à démarrer » n’est pas préparée pour l’agent.
    update(store, alice, 'c2', { archived: true, status: 'ready', description: 'À faire.' });
    const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: ['planifikateur'] }, alice);
    assert.deepEqual(
      store.workflows.queue('planifikateur', agent).filter(item => item.cardId === 'c2'),
      [],
    );
  } finally {
    store.close();
  }
});

test('an existing database gains the new card columns without losing its cards', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-card-fields-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'base.sqlite');
  createStore(file).close();
  const db = new DatabaseSync(file);
  for (const column of ['due_date', 'assignee_id', 'archived']) db.exec(`ALTER TABLE cards DROP COLUMN ${column}`);
  db.close();
  const store = createStore(file);
  t.after(() => store.close());
  assert.ok(store.read().projects[0].cards.length > 0);
  const alice = seedAccount(store);
  update(store, alice, 'c1', { dueDate: '2026-12-01' });
  assert.equal(card(store, 'c1').dueDate, '2026-12-01');
  assert.deepEqual(validateWorkspace(store.read().projects), store.read().projects);
});

test('the card listing excludes archived cards unless asked', async t => {
  const store = createStore(':memory:');
  const alice = seedAccount(store);
  update(store, alice, 'c1', { archived: true });
  const server = createAppServer({ store, config: { readToken: 'read-token' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const ids = async query => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/projects/planifikateur/cards${query}`,
      { headers: { Authorization: 'Bearer read-token' } },
    );
    return response.status === 200 ? (await response.json()).data.map(item => item.id) : response.status;
  };
  assert.equal((await ids('')).includes('c1'), false);
  assert.deepEqual(await ids('?archived=true'), ['c1']);
  assert.equal((await ids('?archived=all')).includes('c1'), true);
  assert.equal(await ids('?archived=peut-etre'), 400);
});
