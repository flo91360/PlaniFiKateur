import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discussionListId, withDiscussionList, withProjectLists } from '../src/lib/discussion-list.js';
import { doneListId } from '../src/lib/done-list.js';
import { withInfos } from '../src/lib/infos.js';
import { createStore } from '../server/store.js';
import { readWorkspace, writeWorkspace } from '../server/workspace-tables.js';
import { seedAccount } from './helpers/accounts.mjs';
import { discussionAi } from '../server/workflows/runs.js';

const card = (id, listId, status) => ({
  id,
  listId,
  title: id,
  description: 'Comment fonctionne la sauvegarde ?',
  status,
  priority: 'normal',
  tags: [],
  comments: [],
  checklist: [],
});

test('every project gets a « Discussion » list before Terminées, whose cards leave the agent queue', () => {
  const project = withProjectLists(
    withInfos({
      id: 'p',
      lists: [{ id: 'improvements', name: 'Améliorations', color: 'green' }],
      cards: [card('task', 'improvements', 'ready')],
    }),
  );
  assert.deepEqual(
    project.lists.map(list => list.name),
    ['Améliorations', 'Discussion', 'Terminées', 'Infos'],
  );
  assert.equal(withProjectLists(project), project);
  // Une carte « Prête à démarrer » placée dans Discussion revient « À explorer » ; les autres restent.
  const moved = withDiscussionList({
    ...project,
    cards: project.cards.map(item => ({ ...item, listId: discussionListId('p') })),
  });
  assert.equal(moved.cards.find(item => item.id === 'task').status, 'draft');
  assert.equal(project.cards.find(item => item.id === 'task').status, 'ready');
  // Une liste existante nommée « Discussions » est reprise.
  const named = { id: 'q', lists: [{ id: 'talk', name: ' Discussions ', color: 'orange' }], cards: [] };
  assert.equal(withDiscussionList(named), named);
});

test('a discussion card is never prepared for the agent and a moved card loses its execution', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-discussion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'site.sqlite');
  let store = createStore(file);
  try {
    const admin = seedAccount(store);
    const projectId = 'planifikateur';
    const discussion = discussionListId(projectId);
    assert.ok(
      store.read().projects.every(project => project.lists.some(list => list.id === discussionListId(project.id))),
    );
    store.workflows.configureGithub(projectId, 'flo91360/PlaniFiKateur', admin);
    const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [projectId] }, admin);
    // Une carte créée « Prête à démarrer » dans Discussion reste « À explorer » : sa question
    // attend une réponse de l’agent, jamais une modification.
    store.change([{ type: 'card.create', projectId, card: card('question', discussion, 'ready') }], admin, {
      strict: true,
    });
    const created = store.read().projects.find(project => project.id === projectId);
    assert.equal(created.cards.find(item => item.id === 'question').status, 'draft');
    const [answer] = store.workflows.queue(projectId, agent).filter(run => run.cardId === 'question');
    assert.equal(answer.mode, 'discussion');
    assert.equal(answer.trigger, 'description');
    assert.deepEqual(answer.ai, { engine: 'codex', model: '', effort: 'low' });
    // Une seule réponse par message : la file ne prépare pas une seconde exécution.
    store.workflows.queue(projectId, agent);
    assert.equal(store.workflows.list(projectId, 'question').length, 1);
    assert.throws(
      () => store.workflows.prepare(projectId, 'question', {}, admin),
      error => error.code === 'discussion_card',
    );
    // Une carte confiée à l’agent puis déplacée dans Discussion : son exécution est annulée.
    store.change([{ type: 'card.create', projectId, card: card('task', 'bugs', 'ready') }], admin, { strict: true });
    const [run] = store.workflows.queue(projectId, agent).filter(item => item.cardId === 'task');
    assert.ok(run);
    store.change([{ type: 'card.update', projectId, cardId: 'task', fields: { listId: discussion } }], admin, {
      strict: true,
    });
    const task = store
      .read()
      .projects.find(project => project.id === projectId)
      .cards.find(item => item.id === 'task');
    assert.equal(task.status, 'draft');
    assert.ok(!store.workflows.queue(projectId, agent).some(item => item.id === run.id));
    store.close();

    // Base antérieure à la liste : elle est ajoutée au démarrage, avant Terminées.
    const db = new DatabaseSync(file);
    writeWorkspace(
      db,
      readWorkspace(db).map(item => ({
        ...item,
        lists: item.lists.filter(list => list.id !== discussionListId(item.id)),
        cards: item.cards.filter(entry => entry.listId !== discussionListId(item.id)),
      })),
    );
    db.close();
    store = createStore(file);
    const migrated = store.read().projects.find(project => project.id === projectId);
    const ids = migrated.lists.map(list => list.id);
    assert.equal(ids.indexOf(discussion) + 1, ids.indexOf(doneListId(projectId)));
  } finally {
    store.close();
  }
});

test('discussion answers use a lighter model: Haiku for Claude Code, low effort for both engines', () => {
  assert.deepEqual(discussionAi({ engine: 'claude-code', model: 'opus' }), {
    engine: 'claude-code',
    model: 'haiku',
    effort: 'low',
  });
  assert.deepEqual(discussionAi({ engine: 'codex', model: 'gpt-x' }), {
    engine: 'codex',
    model: 'gpt-x',
    effort: 'low',
  });
});
