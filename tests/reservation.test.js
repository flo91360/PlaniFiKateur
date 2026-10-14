import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createReservation, WorkerTimeoutError } from '../worker/reservation.mjs';

function reservation(t, overrides = {}) {
  let beats = 0;
  const run = {
    id: 'task',
    state: 'running',
    leaseToken: 'lease',
    leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
  };
  const r = createReservation({
    run,
    config: { taskTimeoutMs: 10000, heartbeatMs: 10, ...overrides },
    log: () => {},
    site: {
      action: async () => {
        beats++;
        return run;
      },
    },
  });
  t.after(() => r.stop());
  return { r, beats: () => beats };
}

test('phase timeout leaves the reservation alive and gives the next phase a fresh deadline', async t => {
  const { r, beats } = reservation(t);
  await assert.rejects(
    r.phase('travail IA', 50, () => delay(10000, undefined, { signal: r.signal })),
    e => e instanceof WorkerTimeoutError && /travail IA/.test(e.message),
  );
  assert.equal(r.signal.aborted, false);
  assert.ok(beats() > 0);
  assert.equal(await r.phase('tests', 1000, async () => 'ok'), 'ok');
});

test('global timeout keeps its own diagnostic even inside a longer phase', async t => {
  const { r } = reservation(t, { taskTimeoutMs: 50 });
  await assert.rejects(
    r.phase('tests', 10000, () => delay(10000, undefined, { signal: r.signal })),
    e => e instanceof WorkerTimeoutError && /exécution complète/.test(e.message),
  );
  assert.equal(r.signal.aborted, true);
});
