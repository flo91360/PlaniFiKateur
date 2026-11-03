import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fail } from '../http.js';

// Licences des logiciels livrés par un projet (exécutable de la Release GitHub).
// Un responsable crée une clé par personne ; le logiciel l’échange, avec l’empreinte de la machine,
// contre un jeton signé Ed25519 valable LEASE_DAYS jours hors ligne et renouvelé en silence. Une
// licence révoquée ou expirée ne se renouvelle plus. La clé privée reste dans la base (comme les
// clés Web Push) ; seule la clé publique est intégrée au logiciel.
export const LEASE_DAYS = 30;
const DAY = 86400000;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans 0, 1, I ni O, faciles à confondre
const normalize = key =>
  String(key || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
const hashKey = key =>
  createHash('sha256')
    .update(`planifikateur-licence:${normalize(key)}`)
    .digest('hex');
const newKey = () =>
  [...randomBytes(16)]
    .map(byte => ALPHABET[byte % 32])
    .join('')
    .match(/.{4}/g)
    .join('-');
const b64 = value => Buffer.from(value).toString('base64url');

const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(400, 'invalid_license', `${label} : de 1 à ${max} caractères.`);
  return value.trim();
};
const machines = value => {
  if (!Number.isInteger(value) || value < 1 || value > 20)
    fail(400, 'invalid_license', 'Nombre de postes : de 1 à 20.');
  return value;
};
// Fin d’accès (abonnement) : date AAAA-MM-JJ incluse, ou null pour une licence sans échéance.
const expiry = value => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
    fail(400, 'invalid_license', 'Date de fin invalide (AAAA-MM-JJ).');
  return value;
};
const endOf = date => (date ? Date.parse(`${date}T23:59:59.999Z`) : Infinity);

export function createLicenseStore({ db, transaction, repositoryOf }) {
  db.exec(`CREATE TABLE IF NOT EXISTS license_keys (id INTEGER PRIMARY KEY CHECK(id = 1), private_pem TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS licenses (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, max_machines INTEGER NOT NULL, expires_on TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS license_machines (license_id TEXT NOT NULL, machine TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(license_id, machine));
    CREATE INDEX IF NOT EXISTS licenses_project ON licenses(project_id);`);
  const privateKey = () => {
    let row = db.prepare('SELECT private_pem FROM license_keys WHERE id = 1').get();
    if (!row) {
      const { privateKey: key } = generateKeyPairSync('ed25519');
      db.prepare('INSERT OR IGNORE INTO license_keys VALUES (1, ?, ?)').run(
        key.export({ type: 'pkcs8', format: 'pem' }),
        new Date().toISOString(),
      );
      row = db.prepare('SELECT private_pem FROM license_keys WHERE id = 1').get();
    }
    return createPrivateKey(row.private_pem);
  };
  const view = row => {
    const seen = db
      .prepare('SELECT COUNT(*) AS count, MAX(last_seen) AS last FROM license_machines WHERE license_id = ?')
      .get(row.id);
    return {
      id: row.id,
      name: row.name,
      keyHint: row.key_hint,
      maxMachines: row.max_machines,
      expiresOn: row.expires_on,
      revoked: !!row.revoked_at,
      machines: seen.count,
      lastSeen: seen.last,
      createdAt: row.created_at,
    };
  };
  const find = (projectId, id) => {
    const row = db.prepare('SELECT * FROM licenses WHERE id = ? AND project_id = ?').get(id, projectId);
    if (!row) fail(404, 'license_not_found', 'Licence inexistante dans ce projet.');
    return row;
  };
  return {
    // Clé publique (SPKI PEM) à intégrer au logiciel pour vérifier les jetons hors ligne.
    licensePublicKey() {
      return createPublicKey(privateKey()).export({ type: 'spki', format: 'pem' });
    },
    licenses(projectId) {
      return db.prepare('SELECT * FROM licenses WHERE project_id = ? ORDER BY created_at, id').all(projectId).map(view);
    },
    // La clé n’est renvoyée qu’à la création : seule son empreinte est gardée.
    createLicense(projectId, data) {
      const name = text(data?.name, 'Nom', 80),
        max = data?.maxMachines === undefined ? 2 : machines(data.maxMachines),
        expiresOn = data?.expiresOn === undefined ? null : expiry(data.expiresOn);
      const key = newKey(),
        id = `lic-${randomBytes(8).toString('hex')}`;
      db.prepare('INSERT INTO licenses VALUES (?,?,?,?,?,?,?,NULL,?)').run(
        id,
        projectId,
        name,
        hashKey(key),
        key.slice(-4),
        max,
        expiresOn,
        new Date().toISOString(),
      );
      return { ...view(find(projectId, id)), key };
    },
    // Nom, postes, date de fin, révocation (ou réactivation) et remise à zéro des postes.
    updateLicense(projectId, id, data) {
      return transaction(() => {
        const row = find(projectId, id);
        const allowed = ['name', 'maxMachines', 'expiresOn', 'revoked', 'resetMachines'];
        if (!data || typeof data !== 'object' || Object.keys(data).some(key => !allowed.includes(key)))
          fail(400, 'invalid_license', `Champs acceptés : ${allowed.join(', ')}.`);
        if ('revoked' in data && typeof data.revoked !== 'boolean')
          fail(400, 'invalid_license', 'revoked doit être un booléen.');
        db.prepare('UPDATE licenses SET name=?, max_machines=?, expires_on=?, revoked_at=? WHERE id=?').run(
          'name' in data ? text(data.name, 'Nom', 80) : row.name,
          'maxMachines' in data ? machines(data.maxMachines) : row.max_machines,
          'expiresOn' in data ? expiry(data.expiresOn) : row.expires_on,
          'revoked' in data ? (data.revoked ? row.revoked_at || new Date().toISOString() : null) : row.revoked_at,
          id,
        );
        if (data.resetMachines === true) db.prepare('DELETE FROM license_machines WHERE license_id = ?').run(id);
        return view(find(projectId, id));
      });
    },
    deleteLicense(projectId, id) {
      transaction(() => {
        find(projectId, id);
        db.prepare('DELETE FROM license_machines WHERE license_id = ?').run(id);
        db.prepare('DELETE FROM licenses WHERE id = ?').run(id);
      });
    },
    // Activation et renouvellement : même appel, avec la clé et l’empreinte de la machine.
    activateLicense(data, now = Date.now()) {
      return transaction(() => {
        const product = typeof data?.product === 'string' ? data.product.toLowerCase() : '';
        const machine = typeof data?.machine === 'string' ? data.machine : '';
        if (!product || !/^[0-9a-f]{64}$/.test(machine) || typeof data?.key !== 'string' || data.key.length > 64)
          fail(400, 'invalid_activation', 'Clé, produit et empreinte de machine (SHA-256) requis.');
        const row = db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(hashKey(data.key));
        if (!row || repositoryOf(row.project_id)?.toLowerCase() !== product)
          fail(404, 'license_invalid', 'Clé de licence inconnue pour ce logiciel.');
        if (row.revoked_at) fail(403, 'license_revoked', 'Cette licence a été désactivée.');
        if (endOf(row.expires_on) < now) fail(403, 'license_expired', 'Cette licence a expiré.');
        const stamp = new Date(now).toISOString();
        const known = db
          .prepare('SELECT 1 FROM license_machines WHERE license_id = ? AND machine = ?')
          .get(row.id, machine);
        if (!known) {
          const used = db.prepare('SELECT COUNT(*) AS count FROM license_machines WHERE license_id = ?').get(row.id);
          if (used.count >= row.max_machines)
            fail(
              409,
              'license_machines',
              `Cette licence est déjà utilisée sur ${row.max_machines} poste(s). Demandez au responsable de libérer un poste.`,
            );
          db.prepare('INSERT INTO license_machines VALUES (?,?,?,?)').run(row.id, machine, stamp, stamp);
        } else
          db.prepare('UPDATE license_machines SET last_seen = ? WHERE license_id = ? AND machine = ?').run(
            stamp,
            row.id,
            machine,
          );
        const payload = {
          v: 1,
          product,
          license: row.id,
          name: row.name,
          machine,
          iat: now,
          exp: Math.min(now + LEASE_DAYS * DAY, endOf(row.expires_on)),
          expiresOn: row.expires_on,
        };
        const body = b64(JSON.stringify(payload));
        return { token: `${body}.${b64(sign(null, Buffer.from(body), privateKey()))}`, ...payload };
      });
    },
  };
}
