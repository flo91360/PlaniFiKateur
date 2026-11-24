// Mises à niveau des données, jouées une seule fois chacune au démarrage : PRAGMA user_version
// retient la dernière appliquée. Chaque étape et sa version sont enregistrées dans la même
// transaction : une étape interrompue est rejouée au démarrage suivant.
// La version 1 est la conversion du tableau JSON en tables (server/workspace-tables.js).
export const SCHEMA_VERSION = 5;

export function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

// `steps` : { version, run } dans l’ordre croissant des versions ; renvoie les versions jouées.
export function runMigrations(db, transaction, steps) {
  const applied = [];
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (!Number.isInteger(step.version) || step.version < 2) throw new Error('Version de migration invalide.');
    if (step.version <= schemaVersion(db)) continue;
    transaction(() => {
      step.run();
      db.exec(`PRAGMA user_version = ${step.version}`);
    });
    applied.push(step.version);
  }
  return applied;
}
