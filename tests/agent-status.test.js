import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { workerAlerts, workerDetails } from '../src/lib/worker-status.js';
import { seedAccount } from './helpers/accounts.mjs';

async function fixture(t) {
  const store = createStore(':memory:');
  const admin = seedAccount(store),
    project = store.read().projects[0];
  const { agent, token } = store.workflows.configureAgent({ name: 'Worker', projectIds: [project.id] }, admin);
  const server = createAppServer({ store, config: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const call = (path, data, key = token) =>
    fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const status = () => store.workflows.agents()[0].status;
  return { store, agent, call, status };
}

test('worker requests record its last contact at most once a minute, the updater report does not', async t => {
  const { store, agent, call, status } = await fixture(t);
  assert.equal(status(), null);
  // Le programme de mise à jour du VPS ne prouve pas que le worker tourne.
  assert.equal((await call('agent/status', { update: { state: 'ok', message: 'Worker déjà à jour.' } })).status, 200);
  assert.equal(status().lastSeenAt, undefined);
  assert.equal((await call('agent/projects')).status, 200);
  const first = status().lastSeenAt;
  assert.ok(Math.abs(Date.now() - Date.parse(first)) < 5000);
  assert.equal(status().update.message, 'Worker déjà à jour.');
  store.workflows.touchAgent(agent, Date.parse(first) + 30000);
  assert.equal(status().lastSeenAt, first, 'au plus une écriture par minute');
  store.workflows.touchAgent(agent, Date.parse(first) + 61000);
  assert.equal(status().lastSeenAt, new Date(Date.parse(first) + 61000).toISOString());
  assert.equal((await call('agent/status', { revision: 'abc1234' }, 'unknown-key')).status, 401);
});

test('the worker revision and updater outcomes are validated and a failure keeps its start date', async t => {
  const { call, status } = await fixture(t);
  for (const data of [
    {},
    { revision: 'main' },
    { revision: 'A'.repeat(40) },
    { update: null },
    { update: { state: 'broken', message: 'x' } },
    { update: { state: 'ok', message: ' ' } },
    { update: { state: 'ok', message: 'x'.repeat(501) } },
    { update: { state: 'ok', message: 'x', latest: 'abc1234' } },
  ]) {
    const response = await call('agent/status', data);
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.equal((await response.json()).error.code, 'invalid_status');
  }
  assert.equal((await call('agent/status', { revision: 'abc1234' })).status, 200);
  assert.equal(status().revision, 'abc1234');
  const failed = {
    state: 'failed',
    message: 'Espace disque insuffisant.',
    revision: 'a'.repeat(40),
    latest: 'b'.repeat(40),
  };
  const first = (await (await call('agent/status', { update: failed })).json()).data.update;
  assert.deepEqual({ ...first, date: undefined, since: undefined }, { ...failed, date: undefined, since: undefined });
  assert.equal(first.since, first.date);
  await new Promise(resolve => setTimeout(resolve, 5));
  const message = 'Cette révision a échoué au déploiement ; nouvelle tentative suspendue.';
  const again = (await (await call('agent/status', { update: { ...failed, message } })).json()).data.update;
  assert.equal(again.since, first.since, 'échec en cours depuis le premier rapport');
  assert.notEqual(again.date, first.date);
  const ok = (await (await call('agent/status', { update: { state: 'ok', message: 'Worker mis à jour.' } })).json())
    .data.update;
  assert.equal(ok.since, ok.date);
  assert.equal(ok.latest, undefined);
  assert.equal(status().revision, 'abc1234', 'le rapport de mise à jour garde la révision annoncée');
});

test('the administrator is alerted after 15 minutes of silence or of failing automatic updates', () => {
  const now = Date.parse('2026-11-02T12:00:00Z'),
    ago = minutes => new Date(now - minutes * 60000).toISOString();
  assert.deepEqual(workerAlerts(null, now), []);
  assert.deepEqual(workerAlerts({ lastSeenAt: ago(14) }, now), []);
  assert.match(workerAlerts({ lastSeenAt: ago(16) }, now)[0], /^Le worker IA ne s’est pas manifesté depuis le /);
  const update = { state: 'failed', message: 'Espace disque insuffisant.', since: ago(10), date: ago(0) };
  assert.deepEqual(workerAlerts({ lastSeenAt: ago(0), update }, now), [], 'un échec passager n’alerte pas');
  const alerts = workerAlerts({ lastSeenAt: ago(0), update: { ...update, since: ago(15) } }, now);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^La mise à jour automatique du worker échoue depuis le .+ : Espace disque insuffisant\.$/);
  assert.deepEqual(
    workerAlerts({ lastSeenAt: ago(0), update: { ...update, state: 'waiting', since: ago(60) } }, now),
    [],
  );
  assert.deepEqual(workerDetails(null), ['Aucun contact du worker enregistré pour le moment.']);
  const details = workerDetails({
    lastSeenAt: ago(1),
    revision: 'abcdef0123',
    startedAt: ago(30),
    update: { ...update, state: 'ok', message: 'Worker déjà à jour.' },
  });
  assert.equal(details.length, 3);
  assert.match(details[1], /^Révision abcdef0 annoncée au démarrage le /);
  assert.match(details[2], /^Mise à jour automatique réussie \(.+\) : Worker déjà à jour\.$/);
});
