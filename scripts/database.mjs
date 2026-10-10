import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from '../server/config.js';
import { createStore } from '../server/store.js';
import { createBackups, restoreBackup } from '../server/backups.js';

const [action, source, confirmation] = process.argv.slice(2);
if (!['backup', 'restore'].includes(action) || (action === 'restore' && (!source || confirmation !== '--confirm'))) {
  console.error('Usage : npm run db:backup | npm run db:restore -- /chemin/sauvegarde.sqlite --confirm');
  process.exit(1);
}
const config = readConfig();
if (!existsSync(config.database)) throw new Error('Base cible inexistante. Vérifiez PLANIFIKATEUR_DB_PATH.');
if (action === 'restore' && resolve(source) === config.database) throw new Error('Choisissez un fichier de sauvegarde distinct de la base active.');
const store = createStore(config.database);
const backups = createBackups(store, { directory: config.backupDirectory, intervalMs: config.backupIntervalMs, keep: config.backupKeep, start: false });
try {
  if (action === 'backup') console.log(`Sauvegarde créée : ${config.backupDirectory}/${backups.create().name}`);
  else {
    const restored = restoreBackup(store, resolve(source), backups.create);
    console.log(`Restauration terminée : ${restored.projects.length} projets, révision ${restored.revision}. Copie de sécurité conservée dans ${config.backupDirectory}.`);
  }
} finally { backups.close(); store.close(); }
