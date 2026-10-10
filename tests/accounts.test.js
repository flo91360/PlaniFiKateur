import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { hashPassword, verifyPassword } from '../server/accounts.js';
import { seedAccount, testEmail, testPassword, testPasswordHash } from './helpers/accounts.mjs';
import { seed } from '../src/data/demo.js';
import { createBackups, restoreBackup } from '../server/backups.js';

async function fixture(t, { initialized = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-accounts-'));
  const filename = join(dir, 'site.sqlite');
  const store = createStore(filename);
  if (initialized) seedAccount(store);
  const config = { ownerToken: 'initialization-test-key', readToken: 'agent-test-key' };
  let server;
  const start = async () => { server = createAppServer({ store, config }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}/api/v1`; };
  const base = await start();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', data, cookie, headers = {} } = {}) => fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const login = async (email = testEmail, password = testPassword) => {
    const response = await request('/session', { method: 'POST', data: { email, password } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { store, filename, dir, config, base, request, login, restart: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); return start(); } };
}
const inviteMember = async (f, admin) => {
  const response = await f.request('/users', { method: 'POST', cookie: admin, data: { name: 'Bob', email: 'bob@example.test' } });
  assert.equal(response.status, 201); const { data } = await response.json();
  const accepted = await f.request('/accounts/accept', { method: 'POST', data: { token: data.token, name: 'Bob', password: 'bob-personal-password-123' } });
  assert.equal(accepted.status, 200);
  return { ...data, cookie: accepted.headers.get('set-cookie').split(';')[0] };
};

test('initialization key creates the first administrator once and never remains a login credential', async t => {
  const f = await fixture(t, { initialized: false });
  assert.equal((await (await f.request('/session')).json()).needsSetup, true);
  const data = { token: 'wrong', name: 'Alice', email: testEmail, password: testPassword };
  assert.equal((await f.request('/accounts/setup', { method: 'POST', data })).status, 401);
  data.token = f.config.ownerToken;
  assert.equal((await f.request('/accounts/setup', { method: 'POST', data: { ...data, password: 'short' } })).status, 400);
  const response = await f.request('/accounts/setup', { method: 'POST', data });
  assert.equal(response.status, 201); const { user } = await response.json(); assert.equal(user.role, 'admin');
  assert.equal((await f.request('/accounts/setup', { method: 'POST', data })).status, 409);
  assert.equal((await f.request('/session', { method: 'POST', data: { token: f.config.ownerToken } })).status, 401);
  const stored = f.store.userByEmail(testEmail); assert.notEqual(stored.password_hash, testPassword); assert.match(stored.password_hash, /^scrypt:/);
  const cookie = await f.login(testEmail.toUpperCase());
  assert.equal((await (await f.request('/session', { cookie })).json()).user.id, user.id);
  assert.equal((await f.request('/workspace')).status, 401);
});

test('passwords use different salts and enforce length without revealing account existence', async t => {
  const first = await hashPassword(testPassword), second = await hashPassword(testPassword);
  assert.notEqual(first, second); assert.equal(await verifyPassword(testPassword, first), true); assert.equal(await verifyPassword('incorrect', first), false);
  await assert.rejects(() => hashPassword('short'));
  const f = await fixture(t);
  for (const email of [testEmail, 'unknown@example.test']) {
    const response = await f.request('/session', { method: 'POST', data: { email, password: 'incorrect' } });
    assert.equal(response.status, 401); assert.equal((await response.json()).error.message, 'Adresse e-mail ou mot de passe incorrect.');
  }
});

test('invitations are private, single-use, hashed and unavailable to agents or members', async t => {
  const f = await fixture(t); const admin = await f.login(); const bob = await inviteMember(f, admin);
  assert.equal((await f.request('/accounts/accept', { method: 'POST', data: { token: bob.token, name: 'Bob', password: testPassword } })).status, 400);
  assert.equal((await f.request('/users', { cookie: bob.cookie })).status, 403);
  assert.equal((await f.request('/users', { headers: { Authorization: 'Bearer agent-test-key' } })).status, 401);
  assert.equal((await f.request('/backups', { cookie: bob.cookie })).status, 403);
  assert.equal((await f.request('/workspace', { cookie: bob.cookie })).status, 200);
  assert.equal((await f.request('/users', { method: 'POST', cookie: admin, headers: { Origin: 'https://evil.test' }, data: { name: 'Eve', email: 'eve@example.test' } })).status, 403);
  const response = await f.request('/users', { method: 'POST', cookie: admin, data: { name: 'Eve', email: 'eve@example.test' } });
  const invited = (await response.json()).data;
  assert.notEqual(f.store.userByEmail('eve@example.test').invite_hash, invited.token);
  const db = new DatabaseSync(f.filename); db.prepare('UPDATE users SET invite_expires = 0 WHERE email = ?').run('eve@example.test'); db.close();
  assert.equal((await f.request('/accounts/accept', { method: 'POST', data: { token: invited.token, name: 'Eve', password: testPassword } })).status, 400);
  const listed = JSON.stringify(await (await f.request('/users', { cookie: admin })).json()); assert.ok(!listed.includes('password_hash')); assert.ok(!listed.includes('invite_hash')); assert.ok(!listed.includes(invited.token));
});

test('sessions persist across server restart, logout revokes them, and deactivation blocks existing sessions', async t => {
  const f = await fixture(t); const admin = await f.login(); const bob = await inviteMember(f, admin);
  const newBase = await f.restart();
  assert.equal((await fetch(newBase + '/workspace', { headers: { Cookie: admin } })).status, 200);
  assert.equal((await fetch(newBase + '/workspace', { headers: { Cookie: bob.cookie } })).status, 200);
  const disable = await fetch(newBase + `/users/${bob.user.id}`, { method: 'PATCH', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: '{"active":false}' }); assert.equal(disable.status, 200);
  assert.equal((await fetch(newBase + '/workspace', { headers: { Cookie: bob.cookie } })).status, 401);
  assert.equal((await fetch(newBase + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bob@example.test', password: 'bob-personal-password-123' }) })).status, 401);
  assert.equal((await fetch(newBase + `/users/${f.store.userByEmail(testEmail).id}`, { method: 'PATCH', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: '{"active":false}' })).status, 400);
  assert.equal((await fetch(newBase + '/session', { method: 'DELETE', headers: { Cookie: admin } })).status, 200);
  assert.equal((await fetch(newBase + '/workspace', { headers: { Cookie: admin } })).status, 401);
});

test('changing a password revokes other sessions and member reset links are rotated', async t => {
  const f = await fixture(t); const admin = await f.login(); const bob = await inviteMember(f, admin);
  const second = await f.login('bob@example.test', 'bob-personal-password-123');
  const change = await f.request('/accounts/password', { method: 'POST', cookie: bob.cookie, data: { currentPassword: 'bob-personal-password-123', password: 'new-personal-password-123' } });
  assert.equal(change.status, 200); const fresh = change.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/workspace', { cookie: second })).status, 401);
  assert.equal((await f.request('/workspace', { cookie: fresh })).status, 200);
  const reset = await f.request(`/users/${bob.user.id}/invitation`, { method: 'POST', cookie: admin }); const firstLink = (await reset.json()).data.token;
  const rotated = await f.request(`/users/${bob.user.id}/invitation`, { method: 'POST', cookie: admin }); const secondLink = (await rotated.json()).data.token;
  assert.equal((await f.request('/accounts/accept', { method: 'POST', data: { token: firstLink, name: 'Bob', password: testPassword } })).status, 400);
  assert.equal((await f.request('/accounts/accept', { method: 'POST', data: { token: secondLink, name: 'Bob', password: testPassword } })).status, 200);
  assert.equal((await f.request('/workspace', { cookie: fresh })).status, 401);
});

test('the server stamps card and comment authors, preserves creators, and records recipients atomically', async t => {
  const f = await fixture(t); const admin = await f.login(); const bob = await inviteMember(f, admin); const alice = f.store.userByEmail(testEmail);
  let snapshot = f.store.read();
  const card = structuredClone(snapshot.projects[0].cards[1]); card.id = 'authorship-card'; card.createdBy = { id: bob.user.id, name: 'Spoofed' }; card.comments = [{ id: 'authorship-comment', author: 'Spoofed', authorId: bob.user.id, text: 'Contexte', date: '2000-01-01T00:00:00Z' }]; snapshot.projects[0].cards.push(card);
  const save = async (cookie, data) => f.request('/workspace', { method: 'PUT', cookie, headers: { 'If-Match': `"${data.revision}"` }, data: { projects: data.projects } });
  const created = await save(admin, snapshot); assert.equal(created.status, 200); snapshot = await created.json();
  const actual = snapshot.projects[0].cards.find(c => c.id === card.id); assert.deepEqual(actual.createdBy, { id: alice.id, name: 'Alice' }); assert.equal(actual.comments[0].authorId, alice.id); assert.equal(actual.comments[0].author, 'Alice'); assert.notEqual(actual.comments[0].date, '2000-01-01T00:00:00Z');
  const stale = structuredClone(snapshot);
  actual.status = 'progress'; actual.createdBy = { id: bob.user.id, name: 'Spoofed' }; actual.comments.push({ id: 'bob-comment', author: 'Alice', authorId: alice.id, text: 'Je prends cette tâche', date: '2000-01-01T00:00:00Z' });
  assert.equal((await save(bob.cookie, snapshot)).status, 200);
  const result = f.store.read().projects[0].cards.find(c => c.id === card.id); assert.equal(result.createdBy.id, alice.id); assert.equal(result.updatedBy.id, bob.user.id); assert.equal(result.comments[1].author, 'Bob');
  const history = await (await f.request(`/projects/planifikateur/cards/${card.id}/activity`, { cookie: admin })).json();
  const status = history.data.find(e => e.action === 'card.status_changed'); assert.equal(status.actor.id, bob.user.id); assert.deepEqual(status.recipientIds, [alice.id]); assert.equal(status.projectId, 'planifikateur');
  const eventCount = f.store.activity({ limit: 100 }).length;
  assert.equal((await save(admin, stale)).status, 409); assert.equal(f.store.activity({ limit: 100 }).length, eventCount);
  assert.equal((await f.request(`/projects/website/cards/${card.id}/activity`, { cookie: admin })).status, 200); assert.deepEqual((await (await f.request(`/projects/website/cards/${card.id}/activity`, { cookie: admin })).json()).data, []);
  assert.equal((await f.request('/activity', { headers: { Authorization: 'Bearer agent-test-key' } })).status, 401);
  const deleted = f.store.read(); deleted.projects[0].cards = deleted.projects[0].cards.filter(c => c.id !== card.id); assert.equal((await save(bob.cookie, deleted)).status, 200);
  assert.ok(f.store.activity({ projectId: 'planifikateur', cardId: card.id }).some(e => e.action === 'card.deleted'));
});

test('migration preserves legacy data and content restoration preserves current accounts and history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-legacy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'legacy.sqlite'); const legacy = new DatabaseSync(filename); legacy.exec('CREATE TABLE workspace (id INTEGER PRIMARY KEY, revision INTEGER, projects TEXT, updated_at TEXT)'); legacy.prepare('INSERT INTO workspace VALUES(1,5,?,?)').run(JSON.stringify(seed), '2026-10-09T00:00:00Z'); legacy.close();
  const store = createStore(filename); t.after(() => store.close()); assert.equal(store.getRevision(), 5); assert.equal(store.read().projects[0].cards[0].title, seed[0].cards[0].title);
  const admin = seedAccount(store); const backups = createBackups(store, { directory: join(dir, 'backups') }); t.after(() => backups.close()); const source = backups.list()[0].name;
  store.write(store.read().projects, 5, admin); assert.equal(store.read().projects[0].cards[0].createdBy, null);
  const session = store.createSession(admin.id); const count = store.activity().length;
  restoreBackup(store, backups.file(source), backups.create);
  assert.equal(store.session(session).id, admin.id); assert.equal(store.users().length, 1); assert.ok(store.activity().length > count); assert.equal(store.activity()[0].action, 'workspace.restored');
});

test('account changes trigger automatic snapshots even when workspace revision does not change', async t => {
  const f = await fixture(t); const backups = createBackups(f.store, { directory: join(f.dir, 'backups'), intervalMs: 10 }); t.after(() => backups.close());
  const revision = f.store.getRevision(); f.store.inviteUser({ name: 'Bob', email: 'bob@example.test' }, f.store.users()[0]);
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.store.getRevision(), revision); assert.equal(backups.list().length, 2);
});

test('a change committed during snapshot creation is still captured by the next automatic backup', async t => {
  const f = await fixture(t);
  const snapshot = f.store.snapshot.bind(f.store); let concurrent = true;
  f.store.snapshot = target => { snapshot(target); if (concurrent) { concurrent = false; f.store.write([], f.store.getRevision()); } };
  const backups = createBackups(f.store, { directory: join(f.dir, 'backups'), intervalMs: 10 }); t.after(() => backups.close());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(backups.list().length, 2);
});
