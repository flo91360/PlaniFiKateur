import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const machine = 'a'.repeat(64),
  other = 'b'.repeat(64),
  third = 'c'.repeat(64),
  product = 'flo91360/defilordi';

async function fixture(t) {
  const store = createStore(':memory:');
  const admin = seedAccount(store);
  const [project, second] = store.read().projects;
  store.workflows.configureGithub(project.id, 'flo91360/DefilOrdi', admin);
  store.workflows.configureGithub(second.id, 'flo91360/funkart', admin);
  const server = createAppServer({ store, config: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, data, session = cookie) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(session ? { Cookie: session } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, project, second, call };
}

const verified = (token, publicKey) => {
  const [body, signature] = token.split('.');
  return (
    verify(null, Buffer.from(body), createPublicKey(publicKey), Buffer.from(signature, 'base64url')) &&
    JSON.parse(Buffer.from(body, 'base64url'))
  );
};

test('a manager creates a licence whose key activates the software on a limited number of machines', async t => {
  const { project, second, call } = await fixture(t);
  assert.equal((await call('GET', `/projects/${project.id}/licenses`, undefined, '')).status, 401);
  const created = await call('POST', `/projects/${project.id}/licenses`, { name: 'Ergo', maxMachines: 2 });
  assert.equal(created.status, 201);
  const { key, ...license } = created.body.data;
  assert.match(key, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
  assert.equal(license.keyHint, key.slice(-4));
  const listed = await call('GET', `/projects/${project.id}/licenses`);
  assert.deepEqual(listed.body.data, [license]);
  assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(key));

  const { publicKey } = (await call('GET', '/licenses/public-key', undefined, '')).body.data;
  const activate = (data, session = '') => call('POST', '/licenses/activate', data, session);
  const first = await activate({ key: key.toLowerCase().replace(/-/g, ' '), machine, product: 'flo91360/DefilOrdi' });
  assert.equal(first.status, 200);
  const payload = verified(first.body.data.token, publicKey);
  assert.equal(payload.product, product);
  assert.equal(payload.machine, machine);
  assert.equal(payload.name, 'Ergo');
  assert.equal(payload.exp - payload.iat, 30 * 86400000);
  // Le même poste se renouvelle ; un deuxième poste est accepté, un troisième refusé.
  assert.equal((await activate({ key, machine, product })).status, 200);
  assert.equal((await activate({ key, machine: other, product })).status, 200);
  const full = await activate({ key, machine: third, product });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'license_machines');
  // Une clé d’un autre produit ou inventée ne vaut rien.
  assert.equal((await activate({ key, machine, product: 'flo91360/funkart' })).body.error.code, 'license_invalid');
  assert.equal((await activate({ key: 'AAAA-BBBB-CCCC-DDDD', machine, product })).status, 404);
  assert.equal((await activate({ key, machine: 'poste', product })).status, 400);
  assert.equal((await call('GET', `/projects/${second.id}/licenses/${license.id}`)).status, 405);
  assert.equal((await call('PATCH', `/projects/${second.id}/licenses/${license.id}`, { revoked: true })).status, 404);

  // Libérer les postes permet d’activer un nouveau poste.
  const reset = await call('PATCH', `/projects/${project.id}/licenses/${license.id}`, { resetMachines: true });
  assert.equal(reset.body.data.machines, 0);
  assert.equal((await activate({ key, machine: third, product })).status, 200);
});

test('a revoked or expired licence no longer renews, and an end date caps the offline lease', async t => {
  const { store, project, call } = await fixture(t);
  const { key, id } = (await call('POST', `/projects/${project.id}/licenses`, { name: 'Client' })).body.data;
  const activate = () => call('POST', '/licenses/activate', { key, machine, product });
  const revoked = await call('PATCH', `/projects/${project.id}/licenses/${id}`, { revoked: true });
  assert.equal(revoked.body.data.revoked, true);
  assert.equal((await activate()).body.error.code, 'license_revoked');
  await call('PATCH', `/projects/${project.id}/licenses/${id}`, { revoked: false });
  assert.equal((await activate()).status, 200);

  await call('PATCH', `/projects/${project.id}/licenses/${id}`, { expiresOn: '2020-01-31' });
  assert.equal((await activate()).body.error.code, 'license_expired');
  const now = Date.parse('2026-11-03T12:00:00Z');
  await call('PATCH', `/projects/${project.id}/licenses/${id}`, { expiresOn: '2026-11-10' });
  const lease = store.activateLicense({ key, machine, product }, now);
  assert.equal(lease.exp, Date.parse('2026-11-10T23:59:59.999Z'));
  assert.equal(
    (await call('PATCH', `/projects/${project.id}/licenses/${id}`, { expiresOn: '10/11/2026' })).body.error.code,
    'invalid_license',
  );
  assert.equal((await call('DELETE', `/projects/${project.id}/licenses/${id}`)).status, 200);
  assert.equal((await activate()).status, 404);
});
