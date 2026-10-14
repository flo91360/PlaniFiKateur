import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { applyChanges, ChangeError, diffWorkspace } from '../src/lib/workspace-changes.js';

const base = () => validateWorkspace(structuredClone(seed));
const card = (id, listId, title = id) => ({
  id,
  listId,
  title,
  description: '',
  status: 'draft',
  priority: 'normal',
  tags: [],
  checklist: [],
  attachments: [],
  comments: [],
});
// Rejoue la différence sur l’état de départ : on doit retrouver exactement l’état d’arrivée.
const roundTrip = (before, after) => {
  const changes = diffWorkspace(before, after);
  const { projects, skipped } = applyChanges(before, changes);
  assert.deepEqual(skipped, []);
  assert.deepEqual(projects, after);
  return changes;
};

test('a diff replays every kind of local edit exactly', () => {
  const before = base();
  const after = structuredClone(before);
  const [first, second] = after;
  first.name = 'Projet renommé';
  first.lists[0].name = 'Liste renommée';
  first.lists.push({ id: 'new-list', name: 'Nouvelle liste', color: 'purple' });
  first.cards[0].title = 'Titre modifié';
  first.cards[0].aiEffort = 'high';
  first.cards[1].listId = 'new-list';
  first.cards[2].comments.push({
    id: 'new-comment',
    author: 'Vous',
    authorId: null,
    text: 'Bonjour',
    date: new Date().toISOString(),
  });
  first.cards[0].comments[0].text = 'Commentaire corrigé';
  first.cards.splice(3, 1);
  first.cards.push(card('new-card', first.lists[0].id));
  first.cards.reverse();
  const moved = second.cards.shift();
  first.cards.push(moved);
  after.reverse();
  after.push({ id: 'third', name: 'Troisième', description: '', emoji: '◈', color: '#e1e7cd', lists: [], cards: [] });
  const changes = roundTrip(before, after);
  assert.deepEqual([...new Set(changes.map(change => change.type))].sort(), [
    'card.create',
    'card.delete',
    'card.order',
    'card.update',
    'comment.create',
    'comment.update',
    'list.create',
    'list.update',
    'project.create',
    'project.order',
    'project.update',
  ]);
  assert.deepEqual(diffWorkspace(before, before), []);
});

test('a card update only carries the fields that changed, and removing the AI effort is explicit', () => {
  const before = base();
  before[0].cards[0].aiEffort = 'high';
  const after = structuredClone(before);
  delete after[0].cards[0].aiEffort;
  after[0].cards[0].priority = 'low';
  const changes = roundTrip(before, after);
  assert.deepEqual(changes, [
    {
      type: 'card.update',
      projectId: before[0].id,
      cardId: before[0].cards[0].id,
      fields: { priority: 'low', aiEffort: null },
    },
  ]);
});

test('changes from two sessions that read the same board are both kept', () => {
  const start = base();
  const mine = structuredClone(start),
    theirs = structuredClone(start);
  mine[0].cards[0].title = 'Mon titre';
  mine[0].cards.push(card('mine', mine[0].lists[0].id));
  theirs[0].cards[0].priority = 'low';
  theirs[0].cards[1].description = 'Leur description';
  theirs[1].name = 'Leur projet';
  const server = applyChanges(start, diffWorkspace(start, theirs)).projects;
  const { projects, skipped } = applyChanges(server, diffWorkspace(start, mine));
  assert.deepEqual(skipped, []);
  assert.equal(projects[0].cards[0].title, 'Mon titre');
  assert.equal(projects[0].cards[0].priority, 'low');
  assert.equal(projects[0].cards[1].description, 'Leur description');
  assert.equal(projects[1].name, 'Leur projet');
  assert.ok(projects[0].cards.some(c => c.id === 'mine'));
});

test('a reorder keeps cards added elsewhere in place and ignores cards that disappeared', () => {
  const start = base();
  const ids = start[0].cards.map(c => c.id);
  const server = applyChanges(start, [
    { type: 'card.create', projectId: start[0].id, card: card('elsewhere', start[0].lists[0].id) },
    { type: 'card.delete', projectId: start[0].id, cardId: ids[1] },
  ]).projects;
  const order = [...ids].reverse();
  const { projects } = applyChanges(server, [{ type: 'card.order', projectId: start[0].id, cardIds: order }]);
  const result = projects[0].cards.map(c => c.id);
  assert.equal(result.at(-1), 'elsewhere');
  assert.deepEqual(
    result.filter(id => id !== 'elsewhere'),
    order.filter(id => id !== ids[1]),
  );
});

test('changes whose target vanished are skipped and reported; malformed changes are refused', () => {
  const start = base();
  const projectId = start[0].id,
    cardId = start[0].cards[0].id;
  const { projects, skipped } = applyChanges(start, [
    { type: 'card.update', projectId, cardId: 'gone', fields: { title: 'x' } },
    { type: 'card.create', projectId, card: start[0].cards[0] },
    { type: 'comment.create', projectId: 'gone', cardId, comment: { id: 'c', text: 'x' } },
    { type: 'list.delete', projectId, listId: start[0].cards[0].listId },
    { type: 'card.update', projectId, cardId, fields: { title: 'Appliqué' } },
  ]);
  assert.deepEqual(
    skipped.map(item => [item.index, item.reason]),
    [
      [0, 'missing'],
      [1, 'exists'],
      [2, 'missing'],
      [3, 'not_empty'],
    ],
  );
  assert.equal(projects[0].cards[0].title, 'Appliqué');
  for (const change of [
    { type: 'card.destroy', projectId },
    { type: 'card.update', projectId, cardId, fields: { createdBy: { id: 'x', name: 'x' } } },
    { type: 'card.update', projectId, cardId, fields: { comments: [] } },
    { type: 'project.update', projectId, fields: [] },
    { type: 'card.order', projectId, cardIds: 'all' },
    null,
  ])
    assert.throws(() => applyChanges(start, [change]), ChangeError);
  assert.throws(() => applyChanges(start, {}), ChangeError);
});

test('a card moved to another project is deleted from one and created in the other', () => {
  const before = base();
  const after = structuredClone(before);
  const [moved] = after[0].cards.splice(0, 1);
  after[1].cards.push({ ...moved, listId: after[1].lists[0].id });
  const changes = roundTrip(before, after);
  assert.deepEqual(
    changes.map(change => change.type),
    ['card.delete', 'card.create'],
  );
});

test('checklist items, attachments and tags are changed one by one, so concurrent edits are all kept', () => {
  const before = base();
  const target = before[0].cards[0];
  assert.deepEqual(
    target.checklist.map(item => [item.id, item.done]),
    [
      ['t1', true],
      ['t2', false],
    ],
  );
  const file = (id, text) => ({
    id,
    name: `${id}.txt`,
    type: 'text/plain',
    size: text.length,
    data: Buffer.from(text).toString('base64'),
  });
  // Deux sessions lisent la même carte : l’une coche t2 et ajoute un fichier, l’autre décoche t1,
  // retire une étiquette et en ajoute une.
  const first = structuredClone(before);
  first[0].cards[0].checklist[1].done = true;
  first[0].cards[0].attachments = [file('a1', 'bonjour')];
  const second = structuredClone(before);
  second[0].cards[0].checklist[0].done = false;
  second[0].cards[0].tags = [...second[0].cards[0].tags.slice(1), 'Urgent'];
  const one = roundTrip(before, first);
  const two = roundTrip(before, second);
  assert.deepEqual(
    one.map(change => change.type),
    ['checklist.update', 'attachment.create'],
  );
  assert.ok(two.every(change => !(change.type === 'card.update' && 'tags' in change.fields)));
  const merged = applyChanges(applyChanges(before, one).projects, two).projects[0].cards[0];
  assert.deepEqual(
    merged.checklist.map(item => [item.id, item.done]),
    [
      ['t1', false],
      ['t2', true],
    ],
  );
  assert.deepEqual(merged.attachments, [file('a1', 'bonjour')]);
  assert.deepEqual(merged.tags, second[0].cards[0].tags);
  // Retirer un fichier ou un critère, en ajouter un : une modification par élément.
  const third = structuredClone(first);
  third[0].cards[0].attachments = [];
  third[0].cards[0].checklist = [
    third[0].cards[0].checklist[0],
    { id: 'nouveau', text: 'Vérifier sur mobile', done: false },
  ];
  assert.deepEqual(
    roundTrip(first, third).map(change => change.type),
    ['checklist.delete', 'checklist.create', 'attachment.delete'],
  );
});

test('a reordered list is sent whole, and item changes whose target vanished are skipped', () => {
  const before = base();
  const after = structuredClone(before);
  after[0].cards[0].checklist.reverse();
  const changes = roundTrip(before, after);
  assert.deepEqual(changes, [
    {
      type: 'card.update',
      projectId: before[0].id,
      cardId: before[0].cards[0].id,
      fields: { checklist: after[0].cards[0].checklist },
    },
  ]);
  const target = { projectId: before[0].id, cardId: before[0].cards[0].id };
  const { skipped } = applyChanges(before, [
    { type: 'checklist.update', ...target, itemId: 'absent', fields: { done: true } },
    { type: 'attachment.delete', ...target, attachmentId: 'absent' },
    { type: 'checklist.create', ...target, item: { id: 't1', text: 'Doublon', done: false } },
    { type: 'tag.remove', ...target, tag: 'absente' },
  ]);
  assert.deepEqual(
    skipped.map(item => [item.index, item.reason]),
    [
      [0, 'missing'],
      [1, 'missing'],
      [2, 'exists'],
    ],
  );
  assert.throws(
    () => applyChanges(before, [{ type: 'checklist.update', ...target, itemId: 't1', fields: { id: 'x' } }]),
    ChangeError,
  );
});
