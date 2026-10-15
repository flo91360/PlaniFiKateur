import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { hashPassword } from '../server/accounts.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { diffWorkspace } from '../src/lib/workspace-changes.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const file = (id, name, type, text) => ({
  id,
  name,
  type,
  size: Buffer.byteLength(text),
  data: Buffer.from(text).toString('base64'),
});

async function fixture(t) {
  const store = createStore(':memory:');
  const admin = seedAccount(store);
  const server = createAppServer({ store, config: { readToken: 'attachments-read-token' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const call = (method, path, data, session = cookie) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { Cookie: session, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const project = store.read().projects[0],
    card = project.cards[0];
  store.change(
    [
      {
        type: 'card.update',
        projectId: project.id,
        cardId: card.id,
        fields: {
          attachments: [
            file('photo', 'écran (1).png', 'image/png', 'PNG-octets'),
            file('page', 'piège.html', 'text/html', '<script>alert(1)</script>'),
          ],
        },
      },
    ],
    admin,
  );
  return { store, admin, base, call, project, card };
}

test('the board sent to the browser omits attachment contents, served by their own route', async t => {
  const { call, project, card } = await fixture(t);
  const board = await (await call('GET', '/workspace')).json();
  const attachments = board.projects[0].cards.find(item => item.id === card.id).attachments;
  assert.deepEqual(
    attachments.map(({ id, data }) => [id, data]),
    [
      ['photo', undefined],
      ['page', undefined],
    ],
  );
  assert.doesNotThrow(() => validateWorkspace(board.projects, { attachmentData: false }));
  assert.throws(() => validateWorkspace(board.projects), /attachment\.data/);
  const full = await (await call('GET', '/workspace?attachments=data')).json();
  assert.equal(full.projects[0].cards.find(item => item.id === card.id).attachments[1].data.length > 0, true);

  const path = `/projects/${project.id}/cards/${card.id}/attachments`;
  const image = await call('GET', `${path}/photo`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(
    image.headers.get('content-disposition'),
    /^inline; filename="_cran \(1\)\.png"; filename\*=UTF-8''%C3%A9cran%20%281%29\.png$/,
  );
  assert.equal(await image.text(), 'PNG-octets');
  // Un fichier HTML est téléchargé, jamais interprété sur l’origine du site.
  const page = await call('GET', `${path}/page`);
  assert.equal(page.headers.get('content-type'), 'application/octet-stream');
  assert.match(page.headers.get('content-disposition'), /^attachment;/);
  assert.match(page.headers.get('content-security-policy'), /sandbox/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('GET', `/projects/${project.id}/cards/c2/attachments/photo`)).status, 404);
  assert.equal((await call('GET', `${path}/photo`, undefined, '')).status, 401);
});

test('attachments sent back without their content keep it, and unknown ones are refused', async t => {
  const { store, admin, call, project, card } = await fixture(t);
  const board = await (await call('GET', '/workspace')).json();
  const before = validateWorkspace(board.projects, { attachmentData: false });
  // L’interface réordonne les fichiers (liste envoyée en entier, sans contenu) et en ajoute un.
  const after = structuredClone(before);
  const target = after[0].cards.find(item => item.id === card.id);
  target.attachments.reverse();
  target.attachments.push(file('note', 'note.txt', 'text/plain', 'bonjour'));
  const response = await call('PATCH', '/workspace', { changes: diffWorkspace(before, after), partial: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.rejected, []);
  assert.ok(body.data.projects[0].cards.every(item => item.attachments.every(a => a.data === undefined)));
  const saved = store.read().projects[0].cards.find(item => item.id === card.id).attachments;
  assert.deepEqual(
    saved.map(a => [a.id, Buffer.from(a.data, 'base64').toString()]),
    [
      ['page', '<script>alert(1)</script>'],
      ['photo', 'PNG-octets'],
      ['note', 'bonjour'],
    ],
  );
  // Une pièce jointe inconnue sans contenu ne peut pas être créée.
  const { rejected } = store.change(
    [
      {
        type: 'attachment.create',
        projectId: project.id,
        cardId: card.id,
        attachment: { id: 'vide', name: 'vide.txt', type: 'text/plain', size: 3 },
      },
    ],
    admin,
    { partial: true },
  );
  assert.equal(rejected[0].code, 'invalid_workspace');
});

test('notifications are indexed per account, filled from history once and purged with it', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const alice = seedAccount(store);
  const { token } = store.inviteUser({ name: 'Bob', email: 'bob@example.test' }, alice);
  const bob = store.acceptInvitation(token, 'Bob', await hashPassword('bob-mot-de-passe-123'));
  const comment = (actor, id) =>
    store.change(
      [{ type: 'comment.create', projectId: 'planifikateur', cardId: 'c3', comment: { id, text: `Message ${id}` } }],
      actor,
    );
  comment(alice, 'a1');
  comment(bob, 'b1');
  comment(bob, 'b2');
  assert.deepEqual(
    store.notifications(alice).items.map(item => item.action),
    ['comment.created', 'comment.created'],
  );
  assert.equal(store.notifications(alice).unread, 2);
  assert.equal(store.notifications(bob).items.length, 0, 'Personne n’est notifié de ses propres actions.');
  store.purge({ activityDays: 1, now: Date.now() + 2 * 86400000 });
  assert.equal(store.notifications(alice).items.length, 0);
});

test('an existing database fills the notification index from its history', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-notifications-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'site.sqlite');
  let store = createStore(filename);
  const alice = seedAccount(store);
  const { token } = store.inviteUser({ name: 'Bob', email: 'bob@example.test' }, alice);
  const bob = store.acceptInvitation(token, 'Bob', await hashPassword('bob-mot-de-passe-123'));
  for (const [actor, id] of [
    [alice, 'a1'],
    [bob, 'b1'],
  ])
    store.change(
      [{ type: 'comment.create', projectId: 'planifikateur', cardId: 'c3', comment: { id, text: id } }],
      actor,
    );
  store.close();
  // Base antérieure à la 0.1.34 : pas d’index des notifications.
  const db = new DatabaseSync(filename);
  db.exec('DROP TABLE notifications');
  db.close();
  store = createStore(filename);
  t.after(() => store.close());
  assert.deepEqual(
    store.notifications(alice).items.map(item => [item.action, item.actor.name]),
    [['comment.created', 'Bob']],
  );
});

test('a save returns only the projects it touched, and a project can be read back alone', async t => {
  const { call, project, card } = await fixture(t);
  const board = await (await call('GET', '/workspace')).json();
  const response = await call('PATCH', '/workspace', {
    changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: 'Seul projet' } }],
    partial: true,
    scope: 'changed',
  });
  const { data } = await response.json();
  assert.deepEqual(data.projectIds, [project.id]);
  assert.deepEqual(
    data.projects.map(item => item.id),
    [project.id],
  );
  assert.equal(data.fromRevision, board.revision);
  assert.equal(data.revision, board.revision + 1);
  assert.deepEqual(Object.keys(data.access).sort(), Object.keys(board.access).sort());
  // Ajout de projet : la liste change, tout le tableau revient.
  const created = await call('PATCH', '/workspace', {
    changes: [
      {
        type: 'project.create',
        project: {
          id: 'nouveau',
          name: 'Nouveau',
          description: '',
          emoji: '◈',
          color: '#e1e7cd',
          lists: [],
          cards: [],
        },
      },
    ],
    scope: 'changed',
  });
  const all = (await created.json()).data;
  assert.equal(all.projectIds, undefined);
  assert.ok(all.projects.length > 1);
  const partial = await (await call('GET', `/workspace?projects=${project.id}`)).json();
  assert.deepEqual(
    partial.projects.map(item => item.id),
    [project.id],
  );
  assert.ok(Object.keys(partial.access).includes('nouveau'));
  assert.equal((await call('PATCH', '/workspace', { changes: [], scope: 'tout' })).status, 400);
});
