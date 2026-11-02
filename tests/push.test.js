import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import {
  createPushSender,
  encryptPush,
  pushMessage,
  vapidAuthorization,
  vapidPublicKey,
  vapidSubject,
} from '../server/push.js';
import { loginRequest, seedAccount } from './helpers/accounts.mjs';

// Navigateur abonné : clés de réception, et déchiffrement d’un message selon la RFC 8291.
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const decrypt = body => {
    const salt = body.subarray(0, 16);
    assert.equal(body.readUInt32BE(16), 4096);
    const idlen = body[20];
    const sender = body.subarray(21, 21 + idlen);
    const secret = ecdh.computeSecret(sender);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const encrypted = body.subarray(21 + idlen);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(encrypted.subarray(-16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'dernier enregistrement');
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { keys, decrypt };
}

test('messages are encrypted for the subscribed browser and signed with the server VAPID key', () => {
  const device = browser();
  const body = encryptPush(JSON.stringify({ title: 'Bonjour' }), device.keys);
  assert.deepEqual(device.decrypt(body), { title: 'Bonjour' });
  // Une autre clé de navigateur ne peut pas le lire.
  assert.throws(() => browser().decrypt(body));
  const store = createStore(':memory:');
  try {
    const jwk = store.pushKey();
    assert.deepEqual(store.pushKey(), jwk, 'clé créée une seule fois');
    const authorization = vapidAuthorization(jwk, 'https://fcm.googleapis.com', 'https://site.example', 0);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
    assert.equal(key, vapidPublicKey(jwk));
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    const [header, claims, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
      aud: 'https://fcm.googleapis.com',
      exp: 12 * 3600,
      sub: 'https://site.example',
    });
    const { d, ...publicJwk } = jwk;
    assert.ok(d);
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    );
  } finally {
    store.close();
  }
});

test('only agent steps that wait for a person become a notification with a link to the card', () => {
  const base = { projectId: 'p1', cardId: 'c1', projectName: 'Site', cardTitle: 'Menu' };
  assert.deepEqual(pushMessage({ ...base, action: 'work.question', state: 'waiting' }), {
    title: 'Question de l’agent',
    body: 'Menu · Site\nL’agent attend votre réponse dans la discussion de la carte.',
    url: '/#/projets/p1/cartes/c1',
    tag: 'planifikateur-c1',
  });
  assert.equal(pushMessage({ ...base, action: 'work.submit', state: 'merging' }), null);
  assert.equal(
    pushMessage({ ...base, action: 'work.submit', state: 'merging', approvalRequired: true }).title,
    'PR à approuver',
  );
  assert.equal(pushMessage({ ...base, action: 'work.checks', state: 'ready' }), null);
  assert.equal(pushMessage({ ...base, action: 'work.checks', state: 'waiting' }).title, 'Tests GitHub en échec');
  assert.equal(pushMessage({ ...base, action: 'work.merged', state: 'done' }).title, 'Carte à tester');
  assert.equal(pushMessage({ ...base, action: 'comment.created' }), null);
});

test('a subscribed account receives the agent question on its devices; expired subscriptions are forgotten', async t => {
  const store = createStore(':memory:');
  const user = seedAccount(store);
  const project = store.read().projects[0],
    card = project.cards[0];
  const sent = [];
  let status = 201;
  const fakeFetch = async (url, options) => {
    sent.push({ url, ...options });
    return { status, ok: status < 300 };
  };
  const logs = [];
  const sender = createPushSender(store, { fetch: fakeFetch, log: line => logs.push(line) });
  const server = createAppServer({ store, config: { push: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sender.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const api = (method, path, data) =>
    fetch(base + '/api/v1' + path, {
      method,
      headers: { Cookie: cookie, Origin: base, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const { publicKey } = (await (await api('GET', '/push')).json()).data;
  assert.equal(publicKey, vapidPublicKey(store.pushKey()));
  const device = browser();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  // Seuls les services de notification des navigateurs sont acceptés.
  for (const bad of ['https://evil.example/push', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x'])
    assert.equal((await api('PUT', '/push/subscription', { endpoint: bad, keys: device.keys })).status, 400, bad);
  assert.equal((await api('PUT', '/push/subscription', { endpoint, keys: { p256dh: 'x', auth: 'y' } })).status, 400);
  assert.equal((await api('PUT', '/push/subscription', { endpoint, keys: device.keys })).status, 200);
  assert.ok(store.hasPushSubscription(user, endpoint));
  // L’agent pose une question sur la carte demandée par Alice.
  const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, user);
  store.workflows.configureGithub(project.id, 'flo91360/PlaniFiKateur', user);
  const prepared = store.workflows.prepare(project.id, card.id, {}, user);
  const run = store.workflows.agentAction(
    project.id,
    card.id,
    prepared.id,
    'claim',
    { version: prepared.version },
    agent,
  );
  store.workflows.agentAction(
    project.id,
    card.id,
    run.id,
    'question',
    { version: run.version, leaseToken: run.leaseToken, message: 'Quel menu ?' },
    agent,
  );
  await sender.settled();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, endpoint);
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
  assert.match(sent[0].headers.Authorization, /^vapid t=.+, k=.+$/);
  const claims = JSON.parse(
    Buffer.from(sent[0].headers.Authorization.split(' ')[1].slice(2).split('.')[1], 'base64url'),
  );
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  // Site local en http : Apple refuserait ce sujet, un mailto le remplace.
  assert.equal(claims.sub, 'mailto:notifications@planifikateur.invalid');
  assert.deepEqual(device.decrypt(sent[0].body), {
    title: 'Question de l’agent',
    body: `${card.title} · ${project.name}\nL’agent attend votre réponse dans la discussion de la carte.`,
    url: `/#/projets/${project.id}/cartes/${card.id}`,
    tag: `planifikateur-${card.id}`,
  });
  // Abonnement expiré : oublié au prochain envoi.
  status = 410;
  let current = store.workflows.list(project.id, card.id)[0];
  current = store.workflows.human(
    project.id,
    card.id,
    current.id,
    'answer',
    { version: current.version, message: 'Le principal.' },
    user,
  );
  current = store.workflows.agentAction(project.id, card.id, current.id, 'claim', { version: current.version }, agent);
  store.workflows.agentAction(
    project.id,
    card.id,
    current.id,
    'question',
    { version: current.version, leaseToken: current.leaseToken, message: 'Et le pied de page ?' },
    agent,
  );
  await sender.settled();
  assert.ok(!store.hasPushSubscription(user, endpoint));
  assert.deepEqual(logs, []);
  assert.equal((await api('DELETE', '/push/subscription', { endpoint })).status, 200);
});

test('the VAPID subject is always accepted by Apple: public https origin, otherwise mailto', () => {
  assert.equal(vapidSubject('https://planifikateur.example'), 'https://planifikateur.example');
  for (const origin of [
    'http://planifikateur.example',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    '',
    undefined,
  ])
    assert.equal(vapidSubject(origin), 'mailto:notifications@planifikateur.invalid', String(origin));
});

test('a test notification reports delivery to this device or the reason of the push service refusal', async t => {
  const store = createStore(':memory:');
  const user = seedAccount(store);
  const sent = [];
  let reply = { status: 201, ok: true };
  const pushFetch = async (url, options) => {
    sent.push({ url, ...options });
    return reply;
  };
  const logs = [];
  const sender = createPushSender(store, { fetch: pushFetch, log: line => logs.push(line) });
  const server = createAppServer({ store, config: { push: false, pushFetch } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    sender.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const api = async (method, path, data) => {
    const response = await fetch(base + '/api/v1' + path, {
      method,
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  const device = browser();
  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH1';
  // Appareil inconnu du serveur : il doit réactiver les notifications.
  assert.equal((await api('POST', '/push/test', { endpoint })).body.error.code, 'subscription_not_found');
  assert.equal((await api('POST', '/push/test', {})).status, 400);
  assert.equal((await api('PUT', '/push/subscription', { endpoint, keys: device.keys })).status, 200);
  let result = await api('POST', '/push/test', { endpoint });
  assert.deepEqual(result.body.data, {
    delivered: true,
    status: 201,
    reason: '',
    service: 'https://web.push.apple.com',
    subscribed: true,
  });
  assert.equal(sent.at(-1).url, endpoint);
  assert.equal(sent.at(-1).headers.TTL, '600');
  assert.equal(device.decrypt(sent.at(-1).body).title, 'Notification de test');
  // Refus d’Apple : sa raison est rapportée, sans l’adresse de l’abonnement.
  reply = { status: 403, ok: false, text: async () => JSON.stringify({ reason: 'BadJwtToken' }) };
  result = await api('POST', '/push/test', { endpoint });
  assert.deepEqual(result.body.data, {
    delivered: false,
    status: 403,
    reason: 'BadJwtToken',
    service: 'https://web.push.apple.com',
    subscribed: true,
  });
  // La même raison apparaît dans le journal lors d’un envoi de l’agent.
  const project = store.read().projects[0],
    card = project.cards[0];
  const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, user);
  store.workflows.configureGithub(project.id, 'flo91360/PlaniFiKateur', user);
  const prepared = store.workflows.prepare(project.id, card.id, {}, user);
  const run = store.workflows.agentAction(
    project.id,
    card.id,
    prepared.id,
    'claim',
    { version: prepared.version },
    agent,
  );
  store.workflows.agentAction(
    project.id,
    card.id,
    run.id,
    'question',
    { version: run.version, leaseToken: run.leaseToken, message: 'Quel menu ?' },
    agent,
  );
  await sender.settled();
  assert.deepEqual(logs, [
    'PlaniFiKateur : notification refusée par https://web.push.apple.com (HTTP 403, BadJwtToken).',
  ]);
  // Abonnement expiré : oublié, l’appareil apparaît désabonné.
  reply = { status: 410, ok: false, text: async () => '' };
  result = await api('POST', '/push/test', { endpoint });
  assert.equal(result.body.data.subscribed, false);
  assert.ok(!store.hasPushSubscription(user, endpoint));
});
