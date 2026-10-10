import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, renameSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateWorkspace } from '../src/lib/workspace.js';

const backupName = /^planifikateur-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]+\.sqlite$/;

export function inspectBackup(filename) {
  if (!existsSync(filename)) throw new Error('Sauvegarde inexistante.');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Sauvegarde SQLite endommagée.');
    const row = db.prepare('SELECT revision, projects FROM workspace WHERE id = 1').get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Sauvegarde incompatible.');
    return { projects: validateWorkspace(JSON.parse(row.projects)), revision: row.revision };
  } finally { db.close(); }
}

export function restoreBackup(store, filename, createSafetyCopy) {
  const snapshot = inspectBackup(filename);
  const revision = store.getRevision();
  createSafetyCopy();
  // Restore contents through the existing connection, keeping revisions increasing.
  // This preserves WAL correctness and rejects saves from browsers with old data.
  const restored = store.write(snapshot.projects, revision);
  if (!restored) throw new Error('Les données ont changé pendant la restauration. Réessayez.');
  return restored;
}

export function createBackups(store, { directory, intervalMs = 6 * 60 * 60 * 1000, keep = 28, onError = console.error, start = true }) {
  const root = resolve(directory);
  let error = '', lastRevision = null;
  const list = () => {
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(name => backupName.test(name)).map(name => {
      const file = statSync(join(root, name));
      return { name, size: file.size, createdAt: name.slice(14, 38).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z') };
    }).sort((a, b) => b.name.localeCompare(a.name));
  };
  const create = () => {
    const name = `planifikateur-${new Date().toISOString().replace(/:/g, '-').replace('.', '-')}-${randomUUID()}.sqlite`;
    const temporary = join(root, `${name}.partial`);
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      store.snapshot(temporary);
      chmodSync(temporary, 0o600);
      const snapshot = inspectBackup(temporary);
      renameSync(temporary, join(root, name));
      const files = list();
      for (const old of [files.find(file => file.name === name), ...files.filter(file => file.name !== name)].slice(keep)) rmSync(join(root, old.name));
      lastRevision = snapshot.revision;
      error = '';
      return list().find(file => file.name === name);
    } catch (cause) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the original error. */ }
      error = 'La sauvegarde a échoué. Vérifiez le stockage et les logs du serveur.';
      onError(`PlaniFiKateur : sauvegarde impossible (${cause.code || cause.message}).`);
      throw cause;
    }
  };
  const automatic = () => {
    try { if (store.getRevision() !== lastRevision) create(); } catch { /* Keep serving; status reports the failure. */ }
  };
  if (start) automatic();
  const timer = start ? setInterval(automatic, intervalMs) : null; timer?.unref();
  return {
    create, list,
    status: () => ({ files: list(), error, intervalHours: intervalMs / 3600000, keep }),
    file(name) { return backupName.test(name) && list().some(file => file.name === name) ? join(root, name) : null; },
    close() { clearInterval(timer); },
  };
}
