// Anti-rejeu du webhook GitHub : chaque livraison traitée est gardée 24 h par son identifiant
// (X-GitHub-Delivery) et par l’empreinte de son corps signé. La signature ne couvre que le corps :
// un rejeu qui changerait l’en-tête garde donc la même empreinte et reste reconnu. Une livraison
// n’est enregistrée qu’après son traitement : une redélivraison après un échec est acceptée.
export const DELIVERY_TTL_MS = 24 * 3600000;

export function createGithubDeliveries(db, { now = Date.now } = {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS github_deliveries (key TEXT PRIMARY KEY, received INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS github_deliveries_received ON github_deliveries(received);',
  );
  const keys = ({ id, digest }) => [...(id ? [`id:${id}`] : []), `body:${digest}`];
  const purge = () => db.prepare('DELETE FROM github_deliveries WHERE received <= ?').run(now() - DELIVERY_TTL_MS);
  return {
    seen(delivery) {
      purge();
      const select = db.prepare('SELECT 1 FROM github_deliveries WHERE key = ? AND received > ?');
      return keys(delivery).some(key => select.get(key, now() - DELIVERY_TTL_MS));
    },
    record(delivery) {
      const insert = db.prepare(
        'INSERT INTO github_deliveries(key, received) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET received = excluded.received',
      );
      for (const key of keys(delivery)) insert.run(key, now());
    },
  };
}
