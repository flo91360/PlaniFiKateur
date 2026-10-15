import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { inspectBackup, restoreBackup } from '../server/backups.js';
import { readWorkspace, writeWorkspace, WORKSPACE_TABLES } from '../server/workspace-tables.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { seedAccount } from './helpers/accounts.mjs';

const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-tables-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const attachment = { id: 'note-file', name: 'note.txt', type: 'text/plain', size: 5, data: 'Ym9uam8=' };

// Base au format antérieur à la 0.1.25 : tableau JSON dans workspace.projects, sans tables.
function legacyDatabase(file) {
  const store = createStore(file);
  const user = seedAccount(store);
  const { projects, revision } = store.read();
  projects[0].cards[0].attachments = [attachment];
  projects[0].cards[0].aiEffort = 'high';
  projects[0].cards[1].comments.push({
    id: 'legacy-comment',
    author: 'Agent IA',
    authorId: 'agent',
    authorKind: 'agent',
    text: 'Question historique',
    date: '2026-01-02T03:04:05.000Z',
  });
  store.write(projects, revision, user);
  const saved = store.read();
  store.close();
  const db = new DatabaseSync(file);
  db.prepare('UPDATE workspace SET projects = ? WHERE id = 1').run(JSON.stringify(saved.projects));
  for (const table of ['projects', 'lists', 'cards', 'comments', 'attachments']) db.exec(`DROP TABLE ${table}`);
  db.exec('PRAGMA user_version = 0');
  db.close();
  return saved;
}

test('an existing JSON board is copied, converted to tables once and read back identically', t => {
  const dir = directory(t),
    file = join(dir, 'site.sqlite'),
    backups = join(dir, 'copies');
  const legacy = legacyDatabase(file);
  const store = createStore(file, { backupDirectory: backups });
  t.after(() => store.close());
  assert.deepEqual(store.read().projects, legacy.projects);
  assert.equal(store.getRevision(), legacy.revision);
  assert.equal(store.read().projects[0].cards[0].attachments[0].data, attachment.data);
  const copies = readdirSync(backups);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^planifikateur-avant-tables-.*\.sqlite$/);
  assert.deepEqual(inspectBackup(join(backups, copies[0])).projects, legacy.projects);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT projects FROM workspace').get().projects, '[]');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards').get().n, legacy.projects.flatMap(p => p.cards).length);
  db.close();
  const reopened = createStore(file, { backupDirectory: backups });
  assert.deepEqual(reopened.read(), store.read());
  reopened.close();
  assert.equal(readdirSync(backups).length, 1, 'Une base déjà convertie n’est plus copiée.');
});

test('the copy taken before conversion restores the board on the new storage', t => {
  const dir = directory(t),
    file = join(dir, 'site.sqlite'),
    backups = join(dir, 'copies');
  const legacy = legacyDatabase(file);
  const store = createStore(file, { backupDirectory: backups });
  t.after(() => store.close());
  store.write([], store.getRevision());
  const copy = join(backups, readdirSync(backups)[0]);
  const restored = restoreBackup(store, copy, () => {});
  assert.deepEqual(restored.projects, legacy.projects);
  assert.deepEqual(store.read().projects, legacy.projects);
});

test('a new database starts in tables without any copy', t => {
  const dir = directory(t),
    file = join(dir, 'site.sqlite');
  const store = createStore(file);
  store.close();
  assert.equal(existsSync(join(dir, 'backups')), false);
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n > 0);
  db.close();
});

test('a board that cannot be converted leaves the database untouched', t => {
  const dir = directory(t),
    file = join(dir, 'site.sqlite');
  legacyDatabase(file);
  const db = new DatabaseSync(file);
  const broken = JSON.parse(db.prepare('SELECT projects FROM workspace').get().projects);
  broken[0].cards[0].status = 'inconnu';
  db.prepare('UPDATE workspace SET projects = ? WHERE id = 1').run(JSON.stringify(broken));
  db.close();
  assert.throws(() => createStore(file, { backupDirectory: join(dir, 'copies') }), /statut ou priorité inconnus/);
  const after = new DatabaseSync(file, { readOnly: true });
  assert.equal(after.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(JSON.parse(after.prepare('SELECT projects FROM workspace').get().projects), broken);
  after.close();
});

test('tables are read in canonical form and only changed rows are written', () => {
  const store = createStore(':memory:');
  const { projects } = store.read();
  store.close();
  const db = new DatabaseSync(':memory:');
  db.exec(WORKSPACE_TABLES);
  assert.ok(writeWorkspace(db, projects).written > 0);
  const read = readWorkspace(db);
  assert.equal(JSON.stringify(read), JSON.stringify(validateWorkspace(read)));
  assert.deepEqual(read, projects);
  assert.deepEqual(writeWorkspace(db, projects), { written: 0, projectIds: [], structural: false });
  const edited = structuredClone(projects);
  edited[0].cards[0].title = 'Titre modifié';
  assert.deepEqual(writeWorkspace(db, edited), { written: 1, projectIds: [projects[0].id], structural: false });
  const withoutCard = structuredClone(edited);
  const [removed] = withoutCard[0].cards.splice(0, 1);
  // La carte, ses commentaires et pièces jointes disparaissent ; les suivantes changent de position.
  assert.equal(
    writeWorkspace(db, withoutCard).written,
    1 + removed.comments.length + removed.attachments.length + withoutCard[0].cards.length,
  );
  assert.deepEqual(readWorkspace(db), withoutCard);
  // Un projet réordonné ou supprimé change la liste des projets elle-même.
  assert.equal(writeWorkspace(db, [...withoutCard].reverse()).structural, true);
  assert.equal(writeWorkspace(db, withoutCard.slice(1)).structural, true);
  db.close();
});
