import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { doneListId, withDoneList } from '../src/lib/done-list.js';
import { withInfos } from '../src/lib/infos.js';
import { seed } from '../src/data/demo.js';
import { createStore } from '../server/store.js';
import { readWorkspace, writeWorkspace } from '../server/workspace-tables.js';
import { seedAccount } from './helpers/accounts.mjs';

const card = (id, listId, status) => ({
  id,
  listId,
  title: id,
  description: '',
  status,
  priority: 'normal',
  tags: [],
  comments: [],
  checklist: [],
});

test('finished tasks move to an « À tester » list created before Infos, other cards stay', () => {
  const project = withInfos({
    id: 'p',
    lists: [{ id: 'improvements', name: 'Améliorations', color: 'green' }],
    cards: [card('open', 'improvements', 'ready'), card('finished', 'improvements', 'done')],
  });
  const next = withDoneList(project);
  assert.deepEqual(
    next.lists.map(list => list.name),
    ['Améliorations', 'À tester', 'Infos'],
  );
  assert.equal(next.cards.find(item => item.id === 'finished').listId, doneListId('p'));
  assert.equal(next.cards.find(item => item.id === 'open').listId, 'improvements');
  // Les cartes Infos, au statut « À tester », restent dans leur liste.
  assert.ok(next.cards.filter(item => item.id.startsWith('p-')).every(item => item.listId === 'p-infos'));
  assert.equal(withDoneList(next), next);
  // Sans tâche terminée, la liste est créée vide et les cartes ne bougent pas.
  const empty = { id: 'q', lists: [{ id: 'l', name: 'Bugs', color: 'orange' }], cards: [card('c', 'l', 'draft')] };
  const withList = withDoneList(empty);
  assert.deepEqual(
    withList.lists.map(list => list.id),
    ['l', doneListId('q')],
  );
  assert.equal(withList.cards, empty.cards);
  assert.equal(withDoneList(withList), withList);
});

test('an existing list named « À tester » is reused, and a former « Terminées » list is renamed', () => {
  const project = {
    id: 'p',
    lists: [
      { id: 'todo', name: 'À faire', color: 'green' },
      { id: 'archive', name: ' terminées ', color: 'purple' },
    ],
    cards: [card('finished', 'todo', 'done')],
  };
  const next = withDoneList(project);
  assert.equal(next.lists.length, 2);
  assert.deepEqual(next.lists[1], { id: 'archive', name: 'À tester', color: 'purple' });
  assert.equal(next.cards[0].listId, 'archive');
  assert.equal(withDoneList(next), next);
  // Liste déjà renommée, sans carte à ranger : rien ne change.
  const named = { ...project, lists: [project.lists[0], { id: 'check', name: 'a tester', color: 'blue' }] };
  assert.equal(withDoneList({ ...named, cards: [] }).lists, named.lists);
  assert.equal(withDoneList(named).cards[0].listId, 'check');
  // Liste du site encore nommée « Terminées » : renommée, sans doublon.
  const legacy = { id: 'q', lists: [{ id: doneListId('q'), name: 'Terminées', color: 'green' }], cards: [] };
  assert.deepEqual(
    withDoneList(legacy).lists.map(list => list.name),
    ['À tester'],
  );
});

test('a card set to done is moved by the server, and finished cards are filed on startup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-done-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'site.sqlite');
  let store = createStore(file);
  try {
    const admin = seedAccount(store);
    // Le tableau de démonstration range déjà sa tâche terminée.
    const initial = store.read().projects.find(project => project.id === 'planifikateur');
    assert.equal(initial.cards.find(item => item.id === 'c7').listId, doneListId('planifikateur'));
    store.change(
      [{ type: 'card.update', projectId: 'planifikateur', cardId: 'c2', fields: { status: 'done' } }],
      admin,
      {
        strict: true,
      },
    );
    const project = store.read().projects.find(item => item.id === 'planifikateur');
    assert.equal(project.cards.find(item => item.id === 'c2').listId, doneListId('planifikateur'));
    assert.equal(project.lists.filter(list => list.id === doneListId('planifikateur')).length, 1);
    store.close();

    // Base antérieure à la liste : une tâche terminée dans « Bugs », sans liste « À tester ».
    const db = new DatabaseSync(file);
    const legacy = structuredClone(seed).map(item => ({
      ...item,
      lists: item.lists.filter(list => list.id !== doneListId(item.id)),
      cards: item.cards.map(entry => (entry.listId === doneListId(item.id) ? { ...entry, listId: 'bugs' } : entry)),
    }));
    writeWorkspace(db, legacy);
    assert.equal(
      readWorkspace(db)
        .find(item => item.id === 'planifikateur')
        .cards.find(item => item.id === 'c7').listId,
      'bugs',
    );
    db.close();
    store = createStore(file);
    const migrated = store.read().projects.find(item => item.id === 'planifikateur');
    assert.equal(migrated.cards.find(item => item.id === 'c7').listId, doneListId('planifikateur'));
    assert.equal(migrated.cards.find(item => item.id === 'c8').listId, 'bugs');
    // Un projet sans tâche terminée reçoit aussi sa liste, vide.
    const website = store.read().projects.find(item => item.id === 'website');
    assert.ok(website.lists.some(list => list.id === doneListId('website')));
    assert.ok(!website.cards.some(item => item.listId === doneListId('website')));
    store.close();

    // Base où la liste s’appelle encore « Terminées » : renommée « À tester » au démarrage, cartes gardées.
    const old = new DatabaseSync(file);
    const named = readWorkspace(old).map(item => ({
      ...item,
      lists: item.lists.map(list => (list.id === doneListId(item.id) ? { ...list, name: 'Terminées' } : list)),
    }));
    writeWorkspace(old, named);
    old.close();
    store = createStore(file);
    for (const item of store.read().projects)
      assert.equal(item.lists.find(list => list.id === doneListId(item.id)).name, 'À tester');
    assert.equal(
      store
        .read()
        .projects.find(item => item.id === 'planifikateur')
        .cards.find(item => item.id === 'c7').listId,
      doneListId('planifikateur'),
    );
  } finally {
    store.close();
  }
});
