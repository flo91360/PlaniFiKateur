import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { seedAccount } from './helpers/accounts.mjs';

// Une modification limitée à un projet ne lit et n’écrit que lui : les autres projets, leurs
// exécutions et leurs abonnements restent tels quels.
const fixture = t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const alice = seedAccount(store);
  return { store, alice };
};
const website = store => store.read().projects.find(project => project.id === 'website');

test('a change in one project leaves the other projects, their runs and their followers untouched', t => {
  const { store, alice } = fixture(t);
  store.workflows.configureGithub('website', 'owner/website', alice);
  const run = store.workflows.prepare('website', 'w-card', {}, alice);
  store.setSubscription('website', 'w-card', alice, true);
  const otherBefore = JSON.stringify(website(store));
  const order = store.read().projects.map(project => project.id);
  const revision = store.getRevision();
  store.change([{ type: 'card.delete', projectId: 'planifikateur', cardId: 'c2' }], alice);
  store.change(
    [{ type: 'card.update', projectId: 'planifikateur', cardId: 'c1', fields: { title: 'Seulement ici' } }],
    alice,
  );
  assert.equal(store.getRevision(), revision + 2);
  assert.equal(JSON.stringify(website(store)), otherBefore);
  assert.deepEqual(
    store.read().projects.map(project => project.id),
    order,
  );
  assert.equal(store.workflows.list('website', 'w-card')[0].state, run.state);
  assert.ok(store.projectCardFollowers('website')['w-card'].some(member => member.id === alice.id));
  assert.equal(store.read().projects[0].cards.find(card => card.id === 'c1').title, 'Seulement ici');
});

test('a deleted card loses its comments and attachments, without orphan rows', t => {
  const { store, alice } = fixture(t);
  store.change(
    [
      {
        type: 'comment.create',
        projectId: 'planifikateur',
        cardId: 'c3',
        comment: { id: 'note-c3', text: 'À effacer' },
      },
      {
        type: 'attachment.create',
        projectId: 'planifikateur',
        cardId: 'c3',
        attachment: { id: 'file-c3', name: 'a.txt', type: 'text/plain', size: 3, data: 'YnVn' },
      },
    ],
    alice,
  );
  store.change([{ type: 'card.delete', projectId: 'planifikateur', cardId: 'c3' }], alice);
  assert.equal(store.attachment('planifikateur', 'c3', 'file-c3'), null);
  // Recréer la carte avec les mêmes identifiants prouve qu’aucune ligne n’est restée.
  store.change(
    [
      {
        type: 'card.create',
        projectId: 'planifikateur',
        card: {
          id: 'c3',
          listId: 'improvements',
          title: 'Recréée',
          description: '',
          status: 'draft',
          priority: 'normal',
          tags: [],
          checklist: [],
          comments: [],
          attachments: [],
        },
      },
    ],
    alice,
  );
  const card = store.read().projects[0].cards.find(item => item.id === 'c3');
  assert.deepEqual([card.comments.length, card.attachments.length], [0, 0]);
});

test('an identifier already used in another project is refused even when only one project is read', t => {
  const { store, alice } = fixture(t);
  const card = {
    id: 'w-card',
    listId: 'improvements',
    title: 'Doublon',
    description: '',
    status: 'draft',
    priority: 'normal',
    tags: [],
    checklist: [],
    comments: [],
    attachments: [],
  };
  assert.throws(
    () => store.change([{ type: 'card.create', projectId: 'planifikateur', card }], alice),
    error => error.code === 'invalid_workspace',
  );
  assert.throws(
    () =>
      store.change(
        [{ type: 'list.create', projectId: 'planifikateur', list: { id: 'w1', name: 'Doublon', color: 'green' } }],
        alice,
      ),
    error => error.code === 'invalid_workspace',
  );
  assert.equal(website(store).cards.filter(item => item.id === 'w-card').length, 1);
});
