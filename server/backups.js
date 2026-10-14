import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, renameSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateWorkspace } from '../src/lib/workspace.js';
import { readWorkspace, TABLES_VERSION } from './workspace-tables.js';

// Copies périodiques ou manuelles, et copies faites avant une suppression (suffixe -suppression) :
// chaque sorte a sa propre rotation, pour que des suppressions répétées n’effacent pas l’historique.
const backupName =
  /^planifikateur-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(-suppression)?\.sqlite$/;
const KINDS = { regular: '', deletion: '-suppression' };
const kindOf = name => (name.endsWith('-suppression.sqlite') ? 'deletion' : 'regular');
// Réglages des projets conservés dans la copie (droits, dépôt, IA, exécution, accès des agents).
const SETTINGS_TABLES = ['project_policies', 'project_members', 'github_projects', 'project_ai', 'project_execution'];
function readSettings(db) {
  const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const tables = {};
  for (const table of SETTINGS_TABLES) if (exists(table)) tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  const agents = exists('agents')
    ? db
        .prepare('SELECT id, projects FROM agents')
        .all()
        .map(row => ({ id: row.id, projects: JSON.parse(row.projects) }))
    : [];
  return { tables, agents };
}

export function inspectBackup(filename) {
  if (!existsSync(filename)) throw new Error('Sauvegarde inexistante.');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw new Error('Sauvegarde SQLite endommagée.');
    const row = db.prepare('SELECT revision, projects FROM workspace WHERE id = 1').get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Sauvegarde incompatible.');
    // Copies antérieures à la 0.1.25 : tableau JSON ; ensuite : tables.
    const tables = db.prepare('PRAGMA user_version').get().user_version >= TABLES_VERSION;
    const hasActivity = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity'").get();
    const activityId = hasActivity ? db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM activity').get().id : 0;
    return {
      projects: validateWorkspace(tables ? readWorkspace(db) : JSON.parse(row.projects)),
      revision: row.revision,
      version: `${row.revision}:${activityId}`,
      settings: readSettings(db),
    };
  } finally {
    db.close();
  }
}

export function restoreBackup(store, filename, createSafetyCopy) {
  const snapshot = inspectBackup(filename);
  const revision = store.getRevision();
  createSafetyCopy();
  // Restore contents through the existing connection, keeping revisions increasing.
  // This preserves WAL correctness and rejects saves from browsers with old data.
  const restored = store.write(snapshot.projects, revision, null, { restore: true, settings: snapshot.settings });
  if (!restored) throw new Error('Les données ont changé pendant la restauration. Réessayez.');
  return restored;
}

export function createBackups(
  store,
  { directory, intervalMs = 6 * 60 * 60 * 1000, keep = 28, onError = console.error, start = true },
) {
  const root = resolve(directory);
  let error = '',
    lastRevision = null;
  const list = () => {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter(name => backupName.test(name))
      .map(name => {
        const file = statSync(join(root, name));
        return {
          name,
          size: file.size,
          createdAt: name.slice(14, 38).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z'),
          kind: kindOf(name),
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  };
  // `kind: 'deletion'` : copie de sécurité avant une suppression, avec sa propre rotation.
  const create = ({ kind = 'regular' } = {}) => {
    if (!(kind in KINDS)) throw new Error('Sorte de sauvegarde inconnue.');
    const name = `planifikateur-${new Date().toISOString().replace(/:/g, '-').replace('.', '-')}-${randomUUID()}${KINDS[kind]}.sqlite`;
    const temporary = join(root, `${name}.partial`);
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      store.snapshot(temporary);
      chmodSync(temporary, 0o600);
      const snapshot = inspectBackup(temporary);
      renameSync(temporary, join(root, name));
      const files = list().filter(file => file.kind === kind);
      for (const old of [files.find(file => file.name === name), ...files.filter(file => file.name !== name)].slice(
        keep,
      ))
        rmSync(join(root, old.name));
      lastRevision = snapshot.version;
      error = '';
      return list().find(file => file.name === name);
    } catch (cause) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the original error. */
      }
      error = 'La sauvegarde a échoué. Vérifiez le stockage et les logs du serveur.';
      onError(`PlaniFiKateur : sauvegarde impossible (${cause.code || cause.message}).`);
      throw cause;
    }
  };
  const automatic = () => {
    try {
      if (store.backupVersion() !== lastRevision) create();
    } catch {
      /* Keep serving; status reports the failure. */
    }
  };
  if (start) automatic();
  const timer = start ? setInterval(automatic, intervalMs) : null;
  timer?.unref();
  return {
    create,
    list,
    status: () => ({ files: list(), error, intervalHours: intervalMs / 3600000, keep }),
    file(name) {
      return backupName.test(name) && list().some(file => file.name === name) ? join(root, name) : null;
    },
    close() {
      clearInterval(timer);
    },
  };
}
