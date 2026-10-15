import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { usageSummary } from '../server/workflows/usage.js';
import { createReservation } from '../worker/reservation.mjs';
import { seedAccount } from './helpers/accounts.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-usage-'));
  const store = createStore(join(dir, 'site.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const admin = seedAccount(store),
    project = store.read().projects[0],
    card = project.cards[0];
  store.workflows.configureGithub(project.id, 'owner/usage', admin);
  const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, admin);
  const act = (run, action, data = {}) =>
    store.workflows.agentAction(project.id, card.id, run.id, action, { version: run.version, ...data }, agent);
  return { store, admin, project, card, act };
}

test('each reservation opens an attempt whose usage and duration add up across attempts', async t => {
  const { store, admin, project, card, act } = fixture(t);
  let run = store.workflows.prepare(project.id, card.id, {}, admin);
  assert.equal(store.workflows.list(project.id, card.id)[0].usage, null, 'Jamais prise : aucune consommation.');
  run = act(run, 'claim');
  const lease = { leaseToken: run.leaseToken };
  const usage = { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300, costUsd: 0.0123, durationMs: 4000 };
  run = act(run, 'progress', { ...lease, message: 'Étape', usage });
  // Le worker envoie un cumul : la dernière valeur remplace la précédente pour la même tentative.
  run = act(run, 'question', { ...lease, message: 'Quelle couleur ?', usage: { ...usage, outputTokens: 500 } });
  run = store.workflows.human(project.id, card.id, run.id, 'answer', { version: run.version, message: 'Vert' }, admin);
  run = act(run, 'claim');
  act(run, 'interrupt', {
    leaseToken: run.leaseToken,
    message: 'Pause',
    usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
  });
  const [listed] = store.workflows.list(project.id, card.id);
  assert.equal(listed.attempts.length, 2);
  assert.ok(listed.attempts.every(attempt => attempt.startedAt && attempt.endedAt));
  assert.deepEqual(
    { ...listed.usage, durationMs: undefined },
    {
      attempts: 2,
      inputTokens: 1300,
      cachedInputTokens: 200,
      outputTokens: 510,
      costUsd: 0.0133,
      durationMs: undefined,
    },
  );
  assert.ok(listed.usage.durationMs >= 0);
});

test('invalid usage is refused and an unknown engine cost stays unknown', async t => {
  const { store, admin, project, card, act } = fixture(t);
  let run = act(store.workflows.prepare(project.id, card.id, {}, admin), 'claim');
  for (const usage of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { costUsd: 'cher' }, ['x']])
    assert.throws(
      () => act(run, 'progress', { leaseToken: run.leaseToken, message: 'x', usage }),
      error => error.status === 400 && error.code === 'invalid_usage',
    );
  run = act(run, 'progress', { leaseToken: run.leaseToken, message: 'x', usage: { inputTokens: 5, outputTokens: 2 } });
  assert.equal(usageSummary(run).costUsd, null);
  const now = Date.parse(run.attempts[0].startedAt) + 90000;
  assert.equal(usageSummary(run, now).durationMs, 90000, 'Une tentative en cours compte jusqu’à maintenant.');
});

test('the worker reservation sends the cumulated usage with its next actions, never with heartbeats', async t => {
  const sent = [];
  const run = {
    id: 'r',
    state: 'running',
    leaseToken: 'lease',
    leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
  };
  const reservation = createReservation({
    run,
    config: { taskTimeoutMs: 10000, heartbeatMs: 5 },
    log: () => {},
    site: {
      action: async (current, name, data) => {
        sent.push({ name, data });
        return run;
      },
    },
  });
  t.after(() => reservation.stop());
  await reservation.action('progress', { message: 'avant' });
  reservation.addUsage({ inputTokens: 10, outputTokens: 2 });
  reservation.addUsage({ inputTokens: 5, outputTokens: 1, costUsd: 0.5, ignored: Number.NaN });
  await reservation.action('progress', { message: 'après' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent[0].data.usage, undefined);
  assert.deepEqual(sent[1].data.usage, { inputTokens: 15, outputTokens: 3, costUsd: 0.5 });
  assert.ok(sent.filter(item => item.name === 'heartbeat').every(item => item.data.usage === undefined));
});

test('the execution panel describes attempts, duration, tokens and a known cost in French', async () => {
  const { usageText } = await import('../src/lib/execution-usage.js');
  const usage = { attempts: 2, durationMs: 3_900_000, inputTokens: 1500, cachedInputTokens: 0, outputTokens: 20 };
  assert.match(
    usageText({ ...usage, costUsd: null }),
    /^Consommation : 2 tentatives · 1 h 05 · 1\s500 tokens en entrée · 20 en sortie\.$/,
  );
  assert.match(
    usageText({ ...usage, cachedInputTokens: 900, costUsd: 1.5 }),
    /\(dont 900 en cache\).*coût estimé 1,50\s/,
  );
  assert.equal(usageText(null), '');
});
