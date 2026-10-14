import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { readConfig } from '../server/config.js';
import { createRetention } from '../server/retention.js';
import { seedAccount } from './helpers/accounts.mjs';

const DAY = 86400000;
const attachment = { id: 'capture', name: 'capture.png', type: 'image/png', size: 3, data: 'AQID' };

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const user = seedAccount(store);
  const { projects, revision } = store.read();
  const project = projects[0];
  project.cards[0].attachments = [attachment];
  project.cards.slice(0, 2).forEach(card => {
    card.status = 'draft';
  });
  store.write(projects, revision, user);
  store.workflows.configureGithub(project.id, 'flo91360/PlaniFiKateur', user);
  const prepare = card => store.workflows.prepare(project.id, card.id, {}, user);
  return { store, user, project: store.read().projects[0], prepare };
}

test('a finished execution keeps its attachment list but not their content', t => {
  const { store, user, project, prepare } = fixture(t);
  const card = project.cards[0];
  const active = prepare(card);
  assert.equal(active.cardSnapshot.attachments[0].data, attachment.data);
  const cancelled = store.workflows.human(
    project.id,
    card.id,
    active.id,
    'cancel',
    { version: active.version, message: 'Abandon.' },
    user,
  );
  assert.deepEqual(cancelled.cardSnapshot.attachments, [
    { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size },
  ]);
  const [stored] = store.workflows.list(project.id, card.id);
  assert.equal('data' in stored.cardSnapshot.attachments[0], false);
  assert.equal(store.read().projects[0].cards[0].attachments[0].data, attachment.data, 'La carte garde son fichier.');
});

test('the purge removes old history and finished executions, never cards or open executions', t => {
  const { store, user, project, prepare } = fixture(t);
  const finished = prepare(project.cards[0]);
  store.workflows.human(
    project.id,
    project.cards[0].id,
    finished.id,
    'cancel',
    { version: finished.version, message: 'Fin.' },
    user,
  );
  const open = prepare(project.cards[1]);
  const history = store.activity({ limit: 500 }).length;
  assert.ok(history > 0);
  assert.deepEqual(store.purge({ activityDays: 0, executionDays: 0, now: Date.now() + 4000 * DAY }), {
    activity: 0,
    executions: 0,
  });
  assert.deepEqual(store.purge({ activityDays: 30, executionDays: 30, now: Date.now() + 10 * DAY }), {
    activity: 0,
    executions: 0,
  });
  const purged = store.purge({ activityDays: 30, executionDays: 30, now: Date.now() + 40 * DAY });
  assert.deepEqual(purged, { activity: history, executions: 1 });
  assert.equal(store.activity({ limit: 500 }).length, 0);
  assert.deepEqual(store.workflows.list(project.id, project.cards[0].id), []);
  assert.equal(store.workflows.list(project.id, project.cards[1].id)[0].id, open.id);
  assert.equal(store.read().projects[0].cards.length, project.cards.length);
});

test('retention is configurable, can be disabled and reports a failed purge without stopping', () => {
  const base = { PLANIFIKATEUR_DB_PATH: '/tmp/planifikateur-retention.sqlite' };
  assert.equal(readConfig(base).activityRetentionDays, 365);
  assert.equal(readConfig(base).executionRetentionDays, 365);
  assert.equal(readConfig({ ...base, PLANIFIKATEUR_ACTIVITY_RETENTION_DAYS: '0' }).activityRetentionDays, 0);
  for (const value of ['-1', '3651', '1.5', 'jamais'])
    assert.throws(() => readConfig({ ...base, PLANIFIKATEUR_EXECUTION_RETENTION_DAYS: value }), /invalide/);
  const errors = [];
  const retention = createRetention(
    {
      purge() {
        throw Object.assign(new Error('disque'), { code: 'SQLITE_FULL' });
      },
    },
    { activityDays: 30, onError: message => errors.push(message) },
  );
  retention.close();
  assert.deepEqual(errors, ['PlaniFiKateur : purge de l’historique impossible (SQLITE_FULL).']);
});
