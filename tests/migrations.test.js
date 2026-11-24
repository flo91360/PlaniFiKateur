import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, schemaVersion } from '../server/store/migrations.js';

const transaction = db => fn => {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

test('chaque migration est jouée une seule fois, dans l’ordre', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 1');
  const played = [];
  const steps = [3, 2].map(version => ({ version, run: () => played.push(version) }));
  assert.deepEqual(runMigrations(db, transaction(db), steps), [2, 3]);
  assert.deepEqual(played, [2, 3]);
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual(runMigrations(db, transaction(db), steps), []);
  assert.deepEqual(played, [2, 3]);
});

test('une migration interrompue est annulée puis rejouée au démarrage suivant', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version = 1; CREATE TABLE t(v INTEGER)');
  let fail = true;
  const steps = [
    {
      version: 2,
      run: () => {
        db.exec('INSERT INTO t VALUES (2)');
        if (fail) throw new Error('panne');
      },
    },
  ];
  assert.throws(() => runMigrations(db, transaction(db), steps), /panne/);
  assert.equal(schemaVersion(db), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0);
  fail = false;
  assert.deepEqual(runMigrations(db, transaction(db), steps), [2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
});

test('une version de migration invalide est refusée', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => runMigrations(db, transaction(db), [{ version: 1, run() {} }]), /invalide/);
});
