import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

async function fixture(t) {
  const store = createStore(':memory:');
  const user = seedAccount(store);
  const server = createAppServer({ store, config: { readToken: 'events-read-token', eventHeartbeatMs: 50 } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const login = async () => (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const cookie = await login();
  const call = (method, path, data, headers = { Cookie: cookie }) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...headers, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  // Lit le flux et range les événements reçus ; `next(type)` attend le prochain de ce type.
  const listen = async (headers = { Cookie: cookie }) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/v1/events`, { headers, signal: controller.signal });
    const events = [],
      waiting = [];
    let ended = false;
    const reader = response.body?.getReader();
    const pump = async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (type) events.push({ type, data: JSON.parse(data) });
            waiting.splice(0).forEach(resolve => resolve());
          }
        }
      } catch {
        /* Flux interrompu par le test. */
      }
      ended = true;
      waiting.splice(0).forEach(resolve => resolve());
    };
    if (response.ok) void pump();
    const next = async (type, from = 0) => {
      for (;;) {
        const found = events.slice(from).find(event => event.type === type);
        if (found) return found.data;
        if (ended) throw new Error(`Flux terminé avant l’événement ${type}`);
        await new Promise(resolve => waiting.push(resolve));
      }
    };
    t.after(() => controller.abort());
    return { response, events, next, ended: () => ended, close: () => controller.abort() };
  };
  return { store, user, base, call, listen, login, project: store.read().projects[0] };
}

test('the event stream announces committed board, execution and subscription changes', async t => {
  const { store, user, call, listen, project } = await fixture(t);
  const stream = await listen();
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get('content-type'), /^text\/event-stream/);
  assert.deepEqual(await stream.next('ready'), { revision: store.getRevision() });
  const card = project.cards[0];
  const saved = await call('PATCH', '/workspace', {
    changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: 'Annoncé' } }],
  });
  const { revision } = (await saved.json()).data;
  assert.deepEqual(await stream.next('workspace'), { revision });
  // Une écriture refusée n’est jamais annoncée.
  const before = stream.events.length;
  assert.equal(
    (
      await call('PATCH', '/workspace', {
        changes: [{ type: 'card.update', projectId: project.id, cardId: card.id, fields: { title: '' } }],
      })
    ).status,
    400,
  );
  await call('PUT', `/projects/${project.id}/cards/${card.id}/subscription`, { following: false });
  assert.deepEqual(await stream.next('subscriptions', before), { projectId: project.id, cardId: card.id });
  assert.equal(
    stream.events.slice(before).some(event => event.type === 'workspace'),
    false,
  );
  store.workflows.configureGithub(project.id, 'flo91360/PlaniFiKateur', user);
  const run = store.workflows.prepare(project.id, card.id, {}, user);
  const work = await stream.next('work');
  assert.deepEqual(work, { projectId: project.id, cardId: card.id, executionId: run.id, state: 'ready' });
});

test('the stream requires a session and closes when the session ends or the server stops', async t => {
  const { base, call, listen } = await fixture(t);
  assert.equal((await listen({})).response.status, 401);
  assert.equal((await listen({ Authorization: 'Bearer events-read-token' })).response.status, 401);
  const stream = await listen();
  await stream.next('ready');
  await call('DELETE', '/session');
  await assert.rejects(stream.next('never'), /Flux terminé/);
  assert.ok(stream.ended());
  assert.ok(base);
});

test('closing the server ends open streams instead of waiting for them', async () => {
  const store = createStore(':memory:');
  seedAccount(store);
  const server = createAppServer({ store, config: { readToken: 'events-read-token' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/v1/events`, { headers: { Cookie: cookie } });
  const reader = response.body.getReader();
  await reader.read();
  const started = Date.now();
  await new Promise(resolve => server.close(resolve));
  assert.ok(Date.now() - started < 2000);
  assert.equal((await reader.read()).done, true);
  store.close();
});
