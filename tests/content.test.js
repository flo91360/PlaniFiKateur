import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

async function fixture(t, { backups } = {}) {
  const store = createStore(':memory:');
  const user = seedAccount(store);
  const config = { readToken: 'content-read-token', ...(backups ? { backups } : {}) };
  const server = createAppServer({ store, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, data, headers = { Cookie: cookie }) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...headers, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, etag: response.headers.get('etag'), body: await response.json() };
  };
  const project = store.read().projects[0];
  return { store, user, call, project, card: project.cards[0] };
}

test('sessions that read the same revision both save their changes without a conflict', async t => {
  const { store, call, project, card } = await fixture(t);
  const revision = store.getRevision();
  const first = await call('PATCH', '/workspace', {
    changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: 'Premier titre' } }],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.revision, revision + 1);
  assert.equal(first.etag, `"${revision + 1}"`);
  const second = await call('PATCH', '/workspace', {
    changes: [
      { type: 'card.update', projectId: project.id, cardId: card.id, fields: { priority: 'low' } },
      { type: 'card.update', projectId: project.id, cardId: 'supprimee-ailleurs', fields: { title: 'x' } },
    ],
  });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.skipped, [{ index: 1, type: 'card.update', reason: 'missing' }]);
  const saved = store.read().projects[0].cards[0];
  assert.equal(saved.title, 'Premier titre');
  assert.equal(saved.priority, 'low');
  assert.equal(saved.updatedBy.name, 'Alice');
  const unchanged = await call('PATCH', '/workspace', {
    changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { priority: 'low' } }],
  });
  assert.equal(unchanged.body.data.revision, revision + 2, 'Une modification sans effet ne change pas la révision.');
});

test('created cards and comments are attributed by the server and recorded in the history', async t => {
  const { store, call, project } = await fixture(t);
  const listId = project.lists[0].id;
  const response = await call('PATCH', '/workspace', {
    changes: [
      {
        type: 'card.create',
        projectId: project.id,
        card: {
          id: 'nouvelle-carte',
          listId,
          title: 'Nouvelle carte',
          description: '',
          status: 'draft',
          priority: 'normal',
          tags: [],
          checklist: [],
          attachments: [],
          comments: [
            {
              id: 'premier-mot',
              author: 'Usurpateur',
              authorId: 'quelquun',
              text: 'Bonjour',
              date: '2000-01-01T00:00:00.000Z',
            },
          ],
        },
      },
    ],
  });
  assert.equal(response.status, 200);
  const card = store.read().projects[0].cards.find(c => c.id === 'nouvelle-carte');
  assert.equal(card.createdBy.name, 'Alice');
  assert.equal(card.comments[0].author, 'Alice');
  assert.notEqual(card.comments[0].date, '2000-01-01T00:00:00.000Z');
  const actions = store.activity({ cardId: 'nouvelle-carte' }).map(event => event.action);
  assert.deepEqual(actions.sort(), ['card.created', 'comment.created']);
});

test('malformed changes and invalid results are refused without saving anything', async t => {
  const { store, call, project, card } = await fixture(t);
  const before = store.read();
  for (const [changes, code] of [
    [[{ type: 'card.rename', projectId: project.id }], 'invalid_change'],
    [[{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { createdBy: null } }], 'invalid_change'],
    [
      [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { listId: 'absente' } }],
      'invalid_workspace',
    ],
    [[{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: '' } }], 'invalid_workspace'],
    ['tout', 'invalid_change'],
  ]) {
    const response = await call('PATCH', '/workspace', { changes });
    assert.equal(response.status, 400, JSON.stringify(changes));
    assert.equal(response.body.error.code, code);
  }
  assert.deepEqual(store.read(), before);
});

test('only a personal session from the same origin can modify the board', async t => {
  const { call, project, card } = await fixture(t);
  const change = { changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: 'x' } }] };
  assert.equal((await call('PATCH', '/workspace', change, { Authorization: 'Bearer content-read-token' })).status, 401);
  assert.equal((await call('PATCH', `/projects/${project.id}/cards/${card.id}`, { title: 'x' }, {})).status, 401);
  const response = await call(
    'POST',
    `/projects/${project.id}/cards`,
    { listId: project.lists[0].id, title: 'x' },
    {
      Authorization: 'Bearer content-read-token',
    },
  );
  assert.equal(response.status, 401);
});

test('removals are preceded by a backup and refused when the backup fails', async t => {
  let copies = 0,
    broken = false;
  const backups = {
    create() {
      if (broken) throw new Error('disque plein');
      copies++;
    },
  };
  const { store, call, project } = await fixture(t, { backups });
  await call('PATCH', '/workspace', {
    changes: [{ type: 'card.update', projectId: project.id, cardId: project.cards[0].id, fields: { title: 'x' } }],
  });
  assert.equal(copies, 0);
  const removed = await call('DELETE', `/projects/${project.id}/cards/${project.cards[0].id}`);
  assert.equal(removed.status, 200);
  assert.equal(copies, 1);
  broken = true;
  const refused = await call('PATCH', '/workspace', {
    changes: [{ type: 'card.delete', projectId: project.id, cardId: project.cards[1].id }],
  });
  assert.equal(refused.status, 503);
  assert.ok(store.read().projects[0].cards.some(c => c.id === project.cards[1].id));
});

test('projects, lists, cards and comments have their own routes', async t => {
  const { store, call } = await fixture(t);
  const created = await call('POST', '/projects', { name: 'Projet API' });
  assert.equal(created.status, 201);
  const project = created.body.data;
  assert.deepEqual(
    project.lists.map(l => l.name),
    ['Améliorations', 'Nouvelles idées', 'Bugs', 'Discussion', 'À tester', 'Infos'],
  );
  assert.ok(
    project.cards.some(c => c.id === `${project.id}-readme`),
    'Les cartes Infos sont créées.',
  );
  assert.equal(
    (await call('PATCH', `/projects/${project.id}`, { name: 'Projet renommé' })).body.data.name,
    'Projet renommé',
  );
  assert.equal((await call('PATCH', `/projects/${project.id}`, { lists: [] })).status, 400);
  const list = await call('POST', `/projects/${project.id}/lists`, { name: 'Recette', color: 'purple' });
  assert.equal(list.status, 201);
  const listId = list.body.data.id;
  assert.equal(
    (await call('PATCH', `/projects/${project.id}/lists/${listId}`, { name: 'Validation' })).body.data.name,
    'Validation',
  );
  const card = await call('POST', `/projects/${project.id}/cards`, {
    listId,
    title: 'Carte API',
    checklist: [{ text: 'Vérifier', done: false }],
  });
  assert.equal(card.status, 201);
  assert.equal(card.body.data.status, 'draft');
  assert.equal(card.body.data.createdBy.name, 'Alice');
  assert.equal(card.body.data.checklist[0].text, 'Vérifier');
  const cardPath = `/projects/${project.id}/cards/${card.body.data.id}`;
  assert.equal((await call('DELETE', `/projects/${project.id}/lists/${listId}`)).status, 409);
  const updated = await call('PATCH', cardPath, { description: 'Décrite', priority: 'high' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.description, 'Décrite');
  assert.equal((await call('PATCH', cardPath, { createdBy: null })).status, 400);
  assert.equal((await call('PATCH', `/projects/${project.id}/cards/absente`, { title: 'x' })).status, 404);
  const comment = await call('POST', `${cardPath}/comments`, { text: 'Premier commentaire' });
  assert.equal(comment.status, 201);
  assert.equal(comment.body.data.author, 'Alice');
  assert.equal(
    (await call('GET', cardPath, undefined, { Authorization: 'Bearer content-read-token' })).body.data.comments.length,
    1,
  );
  assert.equal((await call('DELETE', cardPath)).status, 200);
  assert.equal((await call('DELETE', `/projects/${project.id}/lists/${listId}`)).status, 200);
  assert.equal((await call('DELETE', `/projects/${project.id}`)).status, 200);
  assert.equal(
    store.read().projects.some(p => p.id === project.id),
    false,
  );
  assert.equal((await call('DELETE', `/projects/${project.id}`)).status, 404);
  assert.equal((await call('PUT', '/projects', {})).status, 405);
});

test('with partial, a refused change is reported and the others are saved', async t => {
  const { store, call, project, card } = await fixture(t);
  // m1 n’a pas d’auteur connu : personne ne peut le modifier (403 comment_forbidden).
  const events = [];
  store.subscribe(event => events.push(event));
  const changes = [
    { type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: 'Titre gardé' } },
    { type: 'comment.update', projectId: project.id, cardId: card.id, commentId: 'm1', text: 'Réécrit' },
    { type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: '' } },
    { type: 'card.delete', projectId: project.id, cardId: 'absente' },
    { type: 'tag.add', projectId: project.id, cardId: card.id, tag: 'Gardée' },
  ];
  const without = await call('PATCH', '/workspace', { changes });
  assert.equal(without.status, 403, 'Sans partial, tout le lot est refusé.');
  assert.equal(store.read().projects[0].cards.find(item => item.id === card.id).title, card.title);
  const response = await call('PATCH', '/workspace', { changes, partial: true });
  assert.equal(response.status, 200);
  const saved = response.body.data.projects[0].cards.find(item => item.id === card.id);
  assert.equal(saved.title, 'Titre gardé');
  assert.ok(saved.tags.includes('Gardée'));
  assert.deepEqual(
    response.body.data.rejected.map(item => [item.index, item.code]),
    [
      [1, 'comment_forbidden'],
      [2, 'invalid_workspace'],
    ],
  );
  assert.deepEqual(
    response.body.data.skipped.map(item => [item.index, item.reason]),
    [[3, 'missing']],
  );
  assert.notEqual(saved.comments.find(item => item.id === 'm1').text, 'Réécrit');
  assert.ok(events.some(event => event.type === 'workspace'));
  assert.equal((await call('PATCH', '/workspace', { changes: [], partial: 'oui' })).status, 400);
});
