import { fail } from '../http.js';

// Chiffres d’utilisation envoyés chaque semaine par le logiciel livré par un projet (DefilOrdi,
// familles de test qui l’ont accepté) : un relevé par licence, poste et semaine ISO, remplacé si
// le poste le renvoie. Seulement des totaux (jours d’utilisation, parties et minutes par jeu…),
// jamais de prénom ni de résultat d’enfant. Lus par les responsables du projet (Paramètres du
// projet → Utilisation).
export const MAX_USAGE_ROWS = 5000; // par projet : les plus anciens partent au-delà
const MAX_DATA = 20000;

export function createUsageStore({ db, licenseFromToken }) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_metrics (license_id TEXT NOT NULL, machine TEXT NOT NULL, period TEXT NOT NULL,
      project_id TEXT NOT NULL, license_name TEXT NOT NULL, data TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(license_id, machine, period));
    CREATE INDEX IF NOT EXISTS usage_metrics_project ON usage_metrics(project_id, period);`);
  return {
    receiveUsage(data, now = Date.now()) {
      if (!data || typeof data !== 'object') fail(400, 'invalid_usage', 'Relevé attendu.');
      const license = licenseFromToken(data.token);
      if (!license) fail(401, 'usage_unauthorized', 'Licence inconnue : relevé refusé.');
      if (typeof data.period !== 'string' || !/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(data.period))
        fail(400, 'invalid_usage', 'Semaine attendue au format AAAA-Wss.');
      const json = JSON.stringify(data.data ?? null);
      if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data) || json.length > MAX_DATA)
        fail(400, 'invalid_usage', `Chiffres : un objet de ${MAX_DATA} caractères au plus.`);
      db.prepare(
        `INSERT INTO usage_metrics VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(license_id, machine, period) DO UPDATE SET data = excluded.data, received_at = excluded.received_at,
           license_name = excluded.license_name`,
      ).run(
        license.licenseId,
        license.machine,
        data.period,
        license.projectId,
        license.name,
        json,
        new Date(now).toISOString(),
      );
      db.prepare(
        `DELETE FROM usage_metrics WHERE project_id = ? AND rowid NOT IN
           (SELECT rowid FROM usage_metrics WHERE project_id = ? ORDER BY period DESC, received_at DESC LIMIT ?)`,
      ).run(license.projectId, license.projectId, MAX_USAGE_ROWS);
      return { period: data.period };
    },
    // Les semaines les plus récentes d’abord ; le poste n’est désigné que par un numéro court.
    usageMetrics(projectId) {
      return db
        .prepare('SELECT * FROM usage_metrics WHERE project_id = ? ORDER BY period DESC, license_name, machine')
        .all(projectId)
        .map(row => ({
          licenseId: row.license_id,
          licenseName: row.license_name,
          machine: row.machine.slice(0, 8),
          period: row.period,
          data: JSON.parse(row.data),
          receivedAt: row.received_at,
        }));
    },
  };
}
