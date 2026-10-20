import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { createBackups, restoreBackup } from '../server/backups.js';
import { requirements } from '../server/access.js';
import { hashPassword } from '../server/accounts.js';
import { seedAccount, testEmail, testPassword } from './helpers/accounts.mjs';

async function member(store, admin, name) {
  const { token } = store.inviteUser({ name, email: `${name.toLowerCase()}@example.test` }, admin);
  return store.acceptInvitation(token, name, await hashPassword(`${name}-mot-de-passe-123`));
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-security-'));
  const store = createStore(join(dir, 'site.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const admin = seedAccount(store);
  const bob = await member(store, admin, 'Bob');
  const eve = await member(store, admin, 'Eve');
  const update = (actor, cardId, fields) =>
    store.change([{ type: 'card.update', projectId: 'planifikateur', cardId, fields }], actor, { strict: true });
  return { dir, store, admin, bob, eve, update };
}

const forbidden = code => error => error.status === 403 && error.code === code;

test('a deleted project loses its repository, settings and agent access, and its identifier stays reserved', async t => {
  const { dir, store, admin, eve } = await fixture(t);
  const backups = createBackups(store, { directory: join(dir, 'backups'), start: false });
  store.workflows.configureGithub('website', 'o/secret-repo', admin);
  store.workflows.configureAi('website', { engine: 'claude-code', model: 'sonnet' }, admin);
  store.configureProjectAccess('website', { memberRole: 'none' }, admin);
  store.configureMergeApproval('website', { required: true }, admin);
  const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: ['planifikateur', 'website'] }, admin);
  const saved = backups.create();
  const project = structuredClone(store.read().projects.find(item => item.id === 'website'));

  store.change([{ type: 'project.delete', projectId: 'website' }], admin, { strict: true });
  assert.equal(store.workflows.githubProject('website'), null);
  assert.deepEqual(store.workflows.agents().find(item => item.id === agent.id).projectIds, ['planifikateur']);
  assert.equal(store.mergeApproval('website'), false);
  assert.equal(store.workflows.projectAi('website').engine, 'codex');

  // Recréer le projet sous le même identifiant (avec une carte prête) est refusé à tous.
  project.cards = [{ ...project.cards[0], status: 'ready' }];
  for (const actor of [eve, admin])
    assert.throws(
      () => store.change([{ type: 'project.create', project }], actor),
      error => error.status === 409 && error.code === 'project_deleted',
    );
  assert.throws(
    () => store.write([...store.read().projects, project], store.getRevision(), admin),
    error => error.code === 'project_deleted',
  );

  // Une restauration rétablit le projet avec ses réglages et l’accès de l’agent.
  restoreBackup(store, join(dir, 'backups', saved.name), () => {});
  assert.equal(store.workflows.githubProject('website'), 'o/secret-repo');
  assert.equal(store.workflows.projectAi('website').engine, 'claude-code');
  assert.equal(store.mergeApproval('website'), true);
  assert.equal(store.projectRole(eve, 'website'), null, 'Le projet reste masqué aux autres membres.');
  assert.deepEqual(
    store.workflows
      .agents()
      .find(item => item.id === agent.id)
      .projectIds.sort(),
    ['planifikateur', 'website'],
  );
});

test('settings left by projects deleted before this version are cleared at startup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-leftovers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'site.sqlite');
  let store = createStore(file);
  const admin = seedAccount(store);
  store.workflows.configureGithub('website', 'o/old-repo', admin);
  store.workflows.configureAgent({ name: 'Agent', projectIds: ['website'] }, admin);
  store.change([{ type: 'project.delete', projectId: 'website' }], admin);
  // Simule une base antérieure : les réglages du projet supprimé étaient restés en place.
  store.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO github_projects VALUES ('website', 'o/old-repo'); DELETE FROM deleted_projects");
  db.prepare('UPDATE agents SET projects = \'["website"]\'').run();
  db.close();
  store = createStore(file);
  t.after(() => store.close());
  assert.equal(store.workflows.githubProject('website'), null);
  assert.deepEqual(store.workflows.agents()[0].projectIds, []);
  assert.throws(() => store.change([{ type: 'project.create', project: { id: 'website' } }], admin), /supprimé/);
});

test('a card waiting for the agent keeps the request its manager approved', async t => {
  const { admin, bob, update } = await fixture(t);
  // c2 est « Prête à démarrer » dans les données d’exemple.
  assert.deepEqual(requirements({ type: 'card.update', projectId: 'p', cardId: 'c', fields: { title: 'x' } }), [
    ['p', 'editor'],
  ]);
  assert.throws(() => update(bob, 'c2', { description: 'Instruction de Bob' }), forbidden('project_forbidden'));
  assert.throws(() => update(bob, 'c2', { attachments: [] }), forbidden('project_forbidden'));
  // Un contributeur peut la retirer de la file, ou la déplacer, sans toucher à la demande.
  update(bob, 'c2', { priority: 'high' });
  update(bob, 'c2', { status: 'draft' });
  update(bob, 'c2', { description: 'Demande retravaillée' });
  assert.throws(() => update(bob, 'c2', { status: 'ready' }), forbidden('project_forbidden'));
  update(admin, 'c2', { status: 'ready' });
  update(admin, 'c2', { title: 'Titre revu par un responsable' });
});

test('comments are edited by their author only, and removed by their author or a manager', async t => {
  const { store, admin, bob, eve } = await fixture(t);
  const target = { projectId: 'planifikateur', cardId: 'c3' };
  const post = (actor, id) =>
    store.change([{ type: 'comment.create', ...target, comment: { id, text: `Message ${id}` } }], actor);
  post(bob, 'bob-1');
  post(eve, 'eve-1');
  const edit = (actor, commentId) =>
    store.change([{ type: 'comment.update', ...target, commentId, text: 'Lien modifié' }], actor);
  const remove = (actor, commentId) => store.change([{ type: 'comment.delete', ...target, commentId }], actor);
  assert.throws(() => edit(eve, 'bob-1'), forbidden('comment_forbidden'));
  assert.throws(() => edit(admin, 'bob-1'), forbidden('comment_forbidden'));
  assert.throws(() => remove(eve, 'bob-1'), forbidden('comment_forbidden'));
  edit(bob, 'bob-1');
  remove(eve, 'eve-1');
  remove(admin, 'bob-1');
  // Commentaire sans auteur connu (exemples, agent) : seul un responsable le supprime.
  assert.throws(
    () => store.change([{ type: 'comment.delete', projectId: 'planifikateur', cardId: 'c1', commentId: 'm1' }], bob),
    forbidden('comment_forbidden'),
  );
  const comments = store.read().projects[0].cards.find(card => card.id === 'c3').comments;
  assert.deepEqual(
    comments.map(comment => comment.id),
    [],
  );
});

test('clients cannot create download, README or changelog links', async t => {
  const { store, bob } = await fixture(t);
  const card = {
    id: 'fake-release',
    listId: 'improvements',
    title: 'Version 9.9',
    description: '',
    status: 'draft',
    priority: 'normal',
    tags: [],
    checklist: [],
    comments: [],
    readme: 'evil/repo',
    changelog: 'evil/repo',
    downloads: { repository: 'evil/repo', version: 'v9.9' },
  };
  store.change([{ type: 'card.create', projectId: 'planifikateur', card }], bob, { strict: true });
  const created = store.read().projects[0].cards.find(item => item.id === 'fake-release');
  assert.equal('downloads' in created || 'readme' in created || 'changelog' in created, false);
});

test('members only reorder the projects they can edit, and see limited member and history data', async t => {
  const { store, admin, bob } = await fixture(t);
  store.configureProjectAccess('website', { memberRole: 'none' }, admin);
  const order = () => store.read().projects.map(project => project.id);
  const before = order();
  store.change([{ type: 'project.order', projectIds: [...before].reverse() }], bob);
  assert.deepEqual(order(), before, 'Bob ne voit qu’un projet : l’ordre commun ne change pas.');

  store.configureProjectAccess('planifikateur', { memberRole: 'viewer', members: { [bob.id]: 'viewer' } }, admin);
  const visible = store.projectAccess('planifikateur', bob).members;
  assert.ok(visible.every(person => person.role && person.explicit === null));
  assert.ok(store.projectAccess('planifikateur', admin).members.some(person => person.id === bob.id));

  const global = store.activity({ visible: ['planifikateur'] });
  assert.ok(global.length > 0);
  assert.ok(global.every(event => event.projectId === 'planifikateur'));
  assert.ok(store.activity().some(event => event.action === 'account.invited'));
});

test('a safety copy is made only for authorised deletions, without rotating the regular copies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-safety-'));
  const store = createStore(join(dir, 'site.sqlite'));
  const admin = seedAccount(store);
  await member(store, admin, 'Eve');
  store.configureProjectAccess('planifikateur', { memberRole: 'none' }, admin);
  store.configureProjectAccess('website', { memberRole: 'none' }, admin);
  const config = { readToken: 'safety-read-token' };
  config.backups = createBackups(store, { directory: join(dir, 'backups'), keep: 2, start: false });
  config.backups.create();
  config.backups.create();
  const server = createAppServer({ store, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const login = async (email, password) =>
    (
      await fetch(`${base}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    ).headers
      .get('set-cookie')
      .split(';')[0];
  // Chaque carte est modifiée juste avant sa suppression : la dernière copie ne contient pas son
  // état, une copie de sécurité est donc nécessaire (sinon elle tiendrait lieu de copie).
  const remove = (cookie, cardId) =>
    fetch(`${base}/workspace`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        partial: true,
        changes: [{ type: 'card.update', projectId: 'planifikateur', cardId, fields: { title: `Modifiée ${cardId}` } }],
      }),
    }).then(() =>
      fetch(`${base}/workspace`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ changes: [{ type: 'card.delete', projectId: 'planifikateur', cardId }] }),
      }),
    );
  const files = () => readdirSync(join(dir, 'backups')).sort();
  const regular = files();
  const eve = await login('eve@example.test', 'Eve-mot-de-passe-123');
  for (let i = 0; i < 3; i++) assert.equal((await remove(eve, 'c3')).status, 200);
  assert.deepEqual(files(), regular, 'Aucune copie pour un projet invisible.');
  const owner = await login(testEmail, testPassword);
  for (const cardId of ['c3', 'c4', 'c5']) assert.equal((await remove(owner, cardId)).status, 200);
  assert.equal((await remove(owner, 'c3')).status, 200, 'Carte déjà supprimée : rien à sauvegarder.');
  const after = files();
  assert.deepEqual(
    after.filter(name => !name.endsWith('-suppression.sqlite')),
    regular,
    'Les copies régulières sont conservées.',
  );
  assert.equal(after.filter(name => name.endsWith('-suppression.sqlite')).length, 2);
  assert.ok(config.backups.list().some(file => file.kind === 'deletion'));
});
