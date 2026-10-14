import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, dispatch } from '../server/router.js';
import { httpError } from '../server/http.js';
import { notificationRecipients } from '../server/recipients.js';

const run = async (router, method, pathname) => {
  const sent = [];
  const match = router.match(pathname);
  if (!match) return null;
  await dispatch(match, { req: { method }, send: (status, data) => sent.push({ status, data }) });
  return sent[0];
};

test('routes match exact paths, decode their parameters and list their methods', async () => {
  const router = createRouter([
    { path: '/api/v1/projects/:projectId', methods: { GET: ctx => ctx.send(200, ctx.params) } },
    { path: '/api/v1/projects/:projectId/cards/:cardId', methods: { GET: ctx => ctx.send(200, ctx.params) } },
  ]);
  assert.deepEqual(await run(router, 'GET', '/api/v1/projects/plani%66ikateur'), {
    status: 200,
    data: { projectId: 'planifikateur' },
  });
  assert.deepEqual((await run(router, 'GET', '/api/v1/projects/p/cards/c1')).data, { projectId: 'p', cardId: 'c1' });
  assert.equal(router.match('/api/v1/projects/p/lists'), null);
  assert.equal(router.match('/api/v1/projects'), null);
  assert.throws(
    () => router.match('/api/v1/projects/%E0%A4%A'),
    error => error.code === 'invalid_path',
  );
  assert.deepEqual(router.routes, [
    { method: 'GET', path: '/api/v1/projects/:projectId' },
    { method: 'GET', path: '/api/v1/projects/:projectId/cards/:cardId' },
  ]);
});

test('the group guard runs before the method check, then an unknown method is refused with 405', async () => {
  const guard = ctx => {
    if (!ctx.req.authorized) throw httpError(401, 'unauthorized', 'Connectez-vous.');
  };
  const router = createRouter([
    { path: '/private', guard, methods: { GET: ctx => ctx.send(200, 'ok') } },
    { path: '/public', notAllowed: 'Lecture seule.', methods: { GET: ctx => ctx.send(200, 'ok') } },
  ]);
  await assert.rejects(run(router, 'DELETE', '/private'), error => error.status === 401);
  const sent = [];
  await assert.rejects(
    dispatch(router.match('/private'), { req: { method: 'DELETE', authorized: true }, send: () => sent.push(1) }),
    error => error.status === 405 && error.message === 'Méthode non autorisée.',
  );
  await assert.rejects(
    run(router, 'POST', '/public'),
    error => error.status === 405 && error.message === 'Lecture seule.',
  );
  assert.deepEqual(sent, []);
});

test('modules sharing a path keep their own guard for each method and cannot declare a method twice', async () => {
  const reader = ctx => {
    if (!ctx.req.reader) throw httpError(401, 'unauthorized', 'Clé de lecture requise.');
  };
  const writer = ctx => {
    if (!ctx.req.writer) throw httpError(401, 'unauthorized', 'Session requise.');
  };
  const router = createRouter([
    { path: '/items', guard: reader, notAllowed: 'Lecture seule.', methods: { GET: ctx => ctx.send(200, 'read') } },
    { path: '/items', guard: writer, methods: { POST: ctx => ctx.send(201, 'written') } },
  ]);
  const call = async (method, req) => {
    const sent = [];
    await dispatch(router.match('/items'), {
      req: { method, ...req },
      send: (status, data) => sent.push({ status, data }),
    });
    return sent[0];
  };
  assert.deepEqual(await call('GET', { reader: true }), { status: 200, data: 'read' });
  await assert.rejects(call('POST', { reader: true }), error => error.message === 'Session requise.');
  assert.deepEqual(await call('POST', { writer: true }), { status: 201, data: 'written' });
  await assert.rejects(call('DELETE', {}), error => error.message === 'Clé de lecture requise.');
  await assert.rejects(
    call('DELETE', { reader: true }),
    error => error.status === 405 && error.message === 'Méthode non autorisée.',
  );
  assert.deepEqual(router.routes, [
    { method: 'GET', path: '/items' },
    { method: 'POST', path: '/items' },
  ]);
  assert.throws(
    () =>
      createRouter([
        { path: '/items', methods: { GET: () => {} } },
        { path: '/items', methods: { GET: () => {} } },
      ]),
    /Route déclarée deux fois : GET \/items/,
  );
});

test('notification recipients combine participants and followers without the actor, inactive or opted-out members', () => {
  const recipients = notificationRecipients({
    participants: ['creator', 'commenter', 'actor', undefined, 'left'],
    preferences: [
      { user_id: 'follower', following: 1 },
      { user_id: 'commenter', following: 0 },
    ],
    activeIds: new Set(['creator', 'commenter', 'actor', 'follower']),
    actorId: 'actor',
  });
  assert.deepEqual(recipients, ['creator', 'follower']);
});
