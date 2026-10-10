import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, projects TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, 1, ?, ?)').run(JSON.stringify(validateWorkspace(seed)), new Date().toISOString());
  return {
    getRevision() { return db.prepare('SELECT revision FROM workspace WHERE id = 1').get().revision; },
    snapshot(target) {
      // VACUUM INTO includes committed WAL data in a standalone, consistent database.
      db.prepare('VACUUM INTO ?').run(target);
    },
    read() {
      const row = db.prepare('SELECT * FROM workspace WHERE id = 1').get();
      return { projects: JSON.parse(row.projects), revision: row.revision, updatedAt: row.updated_at };
    },
    write(projects, revision) {
      const clean = validateWorkspace(projects);
      const result = db.prepare('UPDATE workspace SET projects = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?').run(JSON.stringify(clean), new Date().toISOString(), revision);
      if (!result.changes) return null;
      return this.read();
    },
    close() { db.close(); },
  };
}
