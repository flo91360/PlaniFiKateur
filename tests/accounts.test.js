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

test('personal card subscriptions are scoped, persistent, independent of workspace saves and used for recipients', async t => {
  const f = await fixture(t), admin = await f.login(), member = await inviteMember(f, admin);
  const alice = f.store.userByEmail(testEmail), bob = member.user;
  const project = f.store.read().projects[0], card = project.cards[0];
  const path = `/projects/${project.id}/cards/${card.id}/subscription`;
  assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request(path, { headers: { Authorization: 'Bearer agent-test-key' } })).status, 401);
  assert.equal((await f.request(`/projects/wrong/cards/${card.id}/subscription`, { cookie: member.cookie })).status, 404);
  assert.equal((await f.request(path, { method: 'PUT', cookie: member.cookie, data: { following: 'yes' } })).status, 400);
  const stale = f.store.read(), version = f.store.backupVersion();
  assert.equal((await (await f.request(path, { cookie: member.cookie })).json()).data.following, false);
  await f.request(path, { method: 'PUT', cookie: member.cookie, data: { following: true, userId: alice.id } });
  assert.notEqual(f.store.backupVersion(), version);
  assert.equal(f.store.getRevision(), stale.revision);
  assert.equal(f.store.subscription(project.id, card.id, alice.id).following, false);
  const followedVersion = f.store.backupVersion();
  await f.request(path, { method: 'PUT', cookie: member.cookie, data: { following: true } });
  assert.equal(f.store.backupVersion(), followedVersion);
  stale.projects[0].cards[0].description += ' changed';
  f.store.write(stale.projects, stale.revision, alice);
  assert.equal(f.store.subscription(project.id, card.id, bob.id).following, true);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, [bob.id]);
  const restarted = await f.restart();
  assert.equal((await (await fetch(restarted + path, { headers: { Cookie: member.cookie } })).json()).data.following, true);
  f.store.setSubscription(project.id, card.id, bob, false);
  let snapshot = f.store.read(); snapshot.projects[0].cards[0].title += ' again'; f.store.write(snapshot.projects, snapshot.revision, alice);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, []);
  f.store.setSubscription(project.id, card.id, bob, true);
  f.store.setActive(bob.id, false, alice);
  snapshot = f.store.read(); snapshot.projects[0].cards[0].title += ' disabled'; f.store.write(snapshot.projects, snapshot.revision, alice);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, []);
  f.store.setActive(bob.id, true, alice);
  snapshot = f.store.read(); snapshot.projects[0].cards = snapshot.projects[0].cards.filter(c => c.id !== card.id); f.store.write(snapshot.projects, snapshot.revision, alice);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.deleted').recipientIds, [bob.id]);
  snapshot = f.store.read(); snapshot.projects[0].cards.push(card); f.store.write(snapshot.projects, snapshot.revision, alice, { restore: true });
  assert.equal(f.store.subscription(project.id, card.id, bob.id).following, false);
});

test('authors can opt out of automatic following and subscribers never receive their own actions', async t => {
  const f = await fixture(t), admin = await f.login(), member = await inviteMember(f, admin);
  const alice = f.store.userByEmail(testEmail), bob = member.user;
  let snapshot = f.store.read();
  const project = snapshot.projects[0];
  const card = structuredClone(project.cards[0]); card.id = 'new-followed-card'; card.comments = []; card.checklist = [];
  project.cards.push(card); f.store.write(snapshot.projects, snapshot.revision, alice);
  assert.equal(f.store.subscription(project.id, card.id, alice.id).following, true);
  f.store.setSubscription(project.id, card.id, alice, false);
  snapshot = f.store.read(); snapshot.projects[0].cards.find(c => c.id === card.id).title += ' Bob'; f.store.write(snapshot.projects, snapshot.revision, bob);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, []);
  f.store.setSubscription(project.id, card.id, bob, true);
  snapshot = f.store.read(); snapshot.projects[0].cards.find(c => c.id === card.id).title += ' Bob again'; f.store.write(snapshot.projects, snapshot.revision, bob);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, []);
});

test('SQLite snapshots include subscriptions while content restoration preserves current preferences', async t => {
  const f = await fixture(t), alice = f.store.userByEmail(testEmail);
  const project = f.store.read().projects[0], card = project.cards[0];
  f.store.setSubscription(project.id, card.id, alice, true);
  const file = join(f.dir, 'subscription-backup.sqlite'); f.store.snapshot(file);
  const reopened = createStore(file);
  assert.equal(reopened.subscription(project.id, card.id, alice.id).following, true);
  reopened.close();
  f.store.setSubscription(project.id, card.id, alice, false);
  restoreBackup(f.store, file, () => {});
  assert.equal(f.store.subscription(project.id, card.id, alice.id).following, false);
});

test('only administrators can delete members; sessions and invitations are revoked while authorship stays intact', async t => {
  const f = await fixture(t), admin = await f.login(), member = await inviteMember(f, admin);
  const alice = f.store.userByEmail(testEmail), bob = member.user;
  const snapshot = f.store.read(), card = structuredClone(snapshot.projects[0].cards[0]);
  card.id = 'bob-preserved-card'; card.comments = [{ id: 'bob-preserved-comment', text: 'Commentaire conservé', author: 'ignored', date: new Date().toISOString() }]; card.checklist = [];
  snapshot.projects[0].cards.push(card); f.store.write(snapshot.projects, snapshot.revision, bob);
  f.store.setSubscription(snapshot.projects[0].id, card.id, bob, true);
  const invitation = f.store.inviteUser(null, alice, bob.id);
  const path = `/users/${bob.id}`;
  assert.equal((await f.request(path, { method: 'DELETE' })).status, 401);
  assert.equal((await f.request(path, { method: 'DELETE', cookie: member.cookie })).status, 403);
  assert.equal((await f.request(path, { method: 'DELETE', headers: { Authorization: 'Bearer agent-test-key' } })).status, 401);
  assert.equal((await f.request(`/users/${alice.id}`, { method: 'DELETE', cookie: admin })).status, 400);
  const version = f.store.backupVersion(), revision = f.store.getRevision();
  assert.equal((await f.request(path, { method: 'DELETE', cookie: admin, headers: { Origin: 'https://foreign.example' } })).status, 403);
  const deleted = await f.request(path, { method: 'DELETE', cookie: admin });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).data.deleted, true);
  assert.equal(f.store.userById(bob.id), undefined); assert.equal(f.store.invitation(invitation.token), undefined);
  assert.equal((await f.request('/workspace', { cookie: member.cookie })).status, 401);
  assert.equal((await f.request('/session', { method: 'POST', data: { email: bob.email, password: 'bob-personal-password-123' } })).status, 401);
  assert.equal((await f.request('/accounts/accept', { method: 'POST', data: { token: invitation.token, name: 'Bob', password: 'another-password-123' } })).status, 400);
  assert.notEqual(f.store.backupVersion(), version); assert.equal(f.store.getRevision(), revision);
  assert.equal((await f.request(path, { method: 'DELETE', cookie: admin })).status, 404);
  const preserved = f.store.read().projects[0].cards.find(c => c.id === card.id);
  assert.equal(preserved.createdBy.name, 'Bob'); assert.equal(preserved.comments[0].authorId, bob.id);
  assert.equal(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.created').actor.name, 'Bob');
  const db = new DatabaseSync(f.filename); t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(bob.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM card_subscriptions WHERE user_id=?').get(bob.id).n, 0);
  const replacement = f.store.inviteUser({ name: 'Nouveau Bob', email: bob.email }, alice);
  assert.notEqual(replacement.user.id, bob.id);
  const next = f.store.read(); next.projects[0].cards.find(c => c.id === card.id).description += ' changed'; f.store.write(next.projects, next.revision, alice);
  assert.deepEqual(f.store.activity({ cardId: card.id }).find(e => e.action === 'card.updated').recipientIds, []);
});

test('administrators can delete pending and deactivated accounts', async t => {
  const f = await fixture(t), admin = await f.login(), alice = f.store.userByEmail(testEmail);
  const pending = f.store.inviteUser({ name: 'Invité', email: 'pending@example.test' }, alice);
  assert.equal((await f.request(`/users/${pending.user.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal(f.store.invitation(pending.token), undefined);
  const member = await inviteMember(f, admin); f.store.setActive(member.user.id, false, alice);
  assert.equal((await f.request(`/users/${member.user.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal(f.store.users().length, 1);
});

test('deleting a member during a password request revokes the request without a server error', async t => {
  const f = await fixture(t), admin = await f.login(), member = await inviteMember(f, admin);
  const { request: httpRequest } = await import('node:http');
  let signalAuthenticated;
  const authenticated = new Promise(resolve => { signalAuthenticated = resolve; });
  const session = f.store.session;
  f.store.session = token => { const user = session(token); if (user?.id === member.user.id) signalAuthenticated(); return user; };
  const pending = httpRequest(f.base + '/accounts/password', { method: 'POST', headers: { Cookie: member.cookie, 'Content-Type': 'application/json' } });
  t.after(() => pending.destroy());
  const result = new Promise((resolve, reject) => { pending.on('response', response => { response.resume(); resolve(response.statusCode); }); pending.on('error', reject); });
  pending.write('{"currentPassword":');
  await authenticated;
  assert.equal((await f.request(`/users/${member.user.id}`, { method: 'DELETE', cookie: admin })).status, 200);
  pending.end('"bob-personal-password-123","password":"another-password-123"}');
  assert.equal(await result, 401);
});
