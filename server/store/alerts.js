// Alertes de l’administration (worker muet, sauvegarde en échec, déploiement non vérifié) : une
// notification par incident, dans la cloche et sur les appareils abonnés (Web Push) des
// administrateurs actifs. L’incident en cours est gardé en base : un redémarrage ne le renvoie pas,
// et sa fin le referme pour qu’un nouvel incident soit signalé.
export const ALERT_KINDS = ['worker', 'backup', 'offsite', 'deployment'];

export function createAlertStore({ db, transaction, audit }) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS system_alerts (kind TEXT PRIMARY KEY, raised_at TEXT NOT NULL, data TEXT NOT NULL)',
  );
  const admins = () =>
    db
      .prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL")
      .all()
      .map(row => row.id);
  const check = kind => {
    if (!ALERT_KINDS.includes(kind)) throw new Error(`Alerte inconnue : ${kind}`);
  };
  return {
    // Signale un incident s’il n’est pas déjà en cours ; renvoie true quand une alerte part.
    raiseAlert(kind, { title, text }) {
      check(kind);
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM system_alerts WHERE kind = ?').get(kind)) return false;
        const details = { kind, title: String(title).slice(0, 120), text: String(text).slice(0, 300) };
        db.prepare('INSERT INTO system_alerts VALUES (?, ?, ?)').run(
          kind,
          new Date().toISOString(),
          JSON.stringify(details),
        );
        audit({ id: null, name: 'Surveillance' }, 'system.alert', { details, recipientIds: admins() });
        return true;
      });
    },
    // Fin de l’incident : le prochain sera de nouveau signalé.
    clearAlert(kind) {
      check(kind);
      return db.prepare('DELETE FROM system_alerts WHERE kind = ?').run(kind).changes > 0;
    },
    alerts() {
      return db
        .prepare('SELECT kind, raised_at, data FROM system_alerts ORDER BY raised_at')
        .all()
        .map(row => ({ ...JSON.parse(row.data), raisedAt: row.raised_at }));
    },
  };
}
