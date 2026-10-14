import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStore } from '../server/store.js';
import { createBackups, inspectBackup, restoreBackup } from '../server/backups.js';
import { createAppServer } from '../server/index.js';
import { readConfig } from '../server/config.js';
import { seedAccount, testEmail, testPassword, loginRequest } from './helpers/accounts.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-backups-'));
  const store = createStore(join(dir, 'active.sqlite'));
  seedAccount(store);
  const backups = createBackups(store, { directory: join(dir, 'backups'), ...options });
  t.after(() => { backups.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, backups, dir };
}

test('snapshots include committed WAL data and restore all content with a higher revision', t => {
  const { store, backups } = fixture(t);
  const original = store.read(); original.projects[0].cards[0].title = 'Sauvegarde WAL';
  store.write(original.projects, original.revision);
  const file = backups.create();
  const snapshot = inspectBackup(backups.file(file.name));
  assert.equal(snapshot.projects[0].cards[0].title, 'Sauvegarde WAL');
  store.write([], store.getRevision());
  const before = store.getRevision();
  const restored = restoreBackup(store, backups.file(file.name), backups.create);
  assert.deepEqual(restored.projects, snapshot.projects);
  assert.equal(restored.revision, before + 1);
  assert.equal(store.write([], before), null);
  assert.ok(backups.list().some(file => inspectBackup(backups.file(file.name)).projects.length === 0));
});

test('retention removes only recognized old backups and keeps the newly created file', t => {
  const { backups, dir } = fixture(t, { keep: 2 });
  writeFileSync(join(dir, 'backups', 'important.txt'), 'keep me');
  for (let i = 0; i < 5; i++) {
    const file = backups.create();
    assert.ok(backups.file(file.name));
  }
  assert.equal(backups.list().length, 2);
  assert.equal(readFileSync(join(dir, 'backups', 'important.txt'), 'utf8'), 'keep me');
  assert.equal(backups.file('../active.sqlite'), null);
});

test('corrupt or foreign backups never overwrite the workspace', t => {
  const { store, backups, dir } = fixture(t);
  const invalid = join(dir, 'invalid.sqlite'); writeFileSync(invalid, 'not sqlite');
  const before = store.read();
  assert.throws(() => restoreBackup(store, invalid, backups.create));
  assert.deepEqual(store.read(), before);
  const foreign = createStore(join(dir, 'foreign.sqlite')); foreign.close();
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(join(dir, 'foreign.sqlite'));
  db.prepare('UPDATE workspace SET projects = ? WHERE id = 1').run('[{"id":"bad"}]'); db.close();
  assert.throws(() => restoreBackup(store, join(dir, 'foreign.sqlite'), backups.create));
  assert.deepEqual(store.read(), before);
});

test('automatic schedule captures changed revisions and skips unchanged data', async t => {
  const { store, backups } = fixture(t, { intervalMs: 10 });
  assert.equal(backups.list().length, 1);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(backups.list().length, 1);
  store.write([], store.getRevision());
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(backups.list().length, 2);
  assert.ok(backups.list().some(file => inspectBackup(backups.file(file.name)).projects.length === 0));
});

test('backup failure is reported and does not stop serving the database', t => {
  const { store, dir } = fixture(t);
  const blocked = join(dir, 'blocked'); writeFileSync(blocked, 'not a directory');
  const messages = [];
  const backups = createBackups(store, { directory: join(blocked, 'backups'), onError: message => messages.push(message) });
  t.after(() => backups.close());
  assert.ok(backups.status().error);
  assert.equal(messages.length, 1);
  assert.equal(store.read().projects.length, 2);
});

test('backup configuration uses the database volume by default and validates limits', () => {
  assert.equal(readConfig({ PLANIFIKATEUR_DB_PATH: '/data/site.sqlite' }).backupDirectory, '/data/backups');
  assert.throws(() => readConfig({ PLANIFIKATEUR_BACKUP_INTERVAL_HOURS: '0' }), /Intervalle/);
  assert.throws(() => readConfig({ PLANIFIKATEUR_BACKUP_KEEP: '0' }), /Nombre/);
});

test('backup API is owner-only, downloads SQLite, and captures content before deletion', async t => {
  const { store, backups } = fixture(t);
  const server = createAppServer({ store, config: { backups, ownerToken: 'owner-test', readToken: 'reader-test' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  for (const headers of [{}, { Authorization: 'Bearer reader-test' }]) {
    assert.equal((await fetch(`${base}/backups`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/backups`, { method: 'POST', headers })).status, 401);
    assert.equal((await fetch(`${base}/backups/${backups.list()[0].name}`, { headers })).status, 401);
  }
  const login = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: testEmail, password: testPassword }) });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie };
  assert.equal((await fetch(`${base}/backups`, { method: 'POST', headers: { Cookie, Origin: 'https://other.test' } })).status, 403);
  const created = await fetch(`${base}/backups`, { method: 'POST', headers });
  assert.equal(created.status, 201);
  const { data } = await created.json();
  const downloaded = await fetch(`${base}/backups/${data.name}`, { headers });
  assert.equal(downloaded.headers.get('content-type'), 'application/vnd.sqlite3');
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  const initial = store.read(); initial.projects[0].cards[0].title = 'Avant suppression'; store.write(initial.projects, initial.revision);
  const revision = store.getRevision();
  assert.equal((await fetch(`${base}/workspace`, { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': `"${revision}"` }, body: '{"projects":[]}' })).status, 200);
  assert.ok(backups.list().some(file => inspectBackup(backups.file(file.name)).projects[0]?.cards[0].title === 'Avant suppression'));
  assert.deepEqual(store.read().projects, []);
  const count = backups.list().length;
  assert.equal((await fetch(`${base}/workspace`, { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': `"${revision}"` }, body: '{"projects":[]}' })).status, 409);
  assert.equal(backups.list().length, count);
});

test('failed safety backup rejects a deletion without changing stored data', async t => {
  const { store } = fixture(t);
  const server = createAppServer({ store, config: { backups: { create() { throw new Error('full'); } } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const session = await loginRequest(base.replace(/\/api\/v1$/, '')); const Cookie = session.headers.get('set-cookie').split(';')[0];
  const before = store.read();
  const response = await fetch(`${base}/workspace`, { method: 'PUT', headers: { Cookie, 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: '{"projects":[]}' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'backup_failed');
  assert.deepEqual(store.read(), before);
});


test('backup and restore CLI operate on the configured database and require confirmation', t => {
  const { store, dir } = fixture(t);
  const env = { ...process.env, NODE_ENV: 'development', PLANIFIKATEUR_HOST: '127.0.0.1', PLANIFIKATEUR_DB_PATH: join(dir, 'active.sqlite'), PLANIFIKATEUR_BACKUP_DIR: join(dir, 'cli-backups'), PLANIFIKATEUR_OWNER_TOKEN: '', PLANIFIKATEUR_READ_TOKEN: '' };
  const backup = spawnSync(process.execPath, ['scripts/database.mjs', 'backup'], { env, encoding: 'utf8' });
  assert.equal(backup.status, 0, backup.stderr);
  const file = backup.stdout.trim().replace('Sauvegarde créée : ', '');
  assert.equal(inspectBackup(file).projects.length, 2);
  store.write([], store.getRevision());
  const unconfirmed = spawnSync(process.execPath, ['scripts/database.mjs', 'restore', file], { env, encoding: 'utf8' });
  assert.equal(unconfirmed.status, 1);
  assert.deepEqual(store.read().projects, []);
  const restored = spawnSync(process.execPath, ['scripts/database.mjs', 'restore', file, '--confirm'], { env, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(store.read().projects.length, 2);
  assert.equal(store.getRevision(), 3);
});
