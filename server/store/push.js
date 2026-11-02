import { generateKeyPairSync } from 'node:crypto';
import { fail } from '../http.js';

// Services de notification des navigateurs : seuls destinataires possibles des envois Web Push
// (une autre adresse ferait du serveur un relais vers n’importe quel site).
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
const base64url = /^[A-Za-z0-9_-]+$/;
const MAX_PER_USER = 10;

export function validPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      endpoint.length <= 1000 &&
      PUSH_HOSTS.some(host => host.test(url.hostname))
    );
  } catch {
    return false;
  }
}

// Abonnements Web Push des comptes (un par appareil) et clés VAPID du serveur, créées au premier
// besoin et gardées dans la base : la clé privée ne quitte jamais le serveur.
export function createPushStore({ db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY CHECK(id = 1), private_jwk TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);`);
  return {
    // Clé privée VAPID (JWK P-256) ; la clé publique s’en déduit (x, y).
    pushKey() {
      let row = db.prepare('SELECT private_jwk FROM push_keys WHERE id = 1').get();
      if (!row) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        db.prepare('INSERT OR IGNORE INTO push_keys VALUES (1, ?, ?)').run(
          JSON.stringify(privateKey.export({ format: 'jwk' })),
          new Date().toISOString(),
        );
        row = db.prepare('SELECT private_jwk FROM push_keys WHERE id = 1').get();
      }
      return JSON.parse(row.private_jwk);
    },
    savePushSubscription(user, subscription, origin) {
      const { endpoint, keys } = subscription || {};
      if (
        typeof endpoint !== 'string' ||
        !validPushEndpoint(endpoint) ||
        typeof keys?.p256dh !== 'string' ||
        typeof keys?.auth !== 'string' ||
        !base64url.test(keys.p256dh) ||
        !base64url.test(keys.auth) ||
        Buffer.from(keys.p256dh, 'base64url').length !== 65 ||
        Buffer.from(keys.auth, 'base64url').length !== 16
      )
        fail(400, 'invalid_subscription', 'Abonnement aux notifications invalide.');
      db.prepare(
        'INSERT INTO push_subscriptions VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, origin=excluded.origin',
      ).run(endpoint, user.id, keys.p256dh, keys.auth, origin, new Date().toISOString());
      // Au-delà de dix appareils, les plus anciens abonnements du compte sont oubliés.
      db.prepare(
        'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)',
      ).run(user.id, user.id, MAX_PER_USER);
    },
    removePushSubscription(user, endpoint) {
      return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, user.id)
        .changes;
    },
    hasPushSubscription(user, endpoint) {
      return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpoint, user.id);
    },
    // Abonnements des comptes actifs donnés.
    pushSubscriptions(userIds) {
      if (!userIds.length) return [];
      return db
        .prepare(
          'SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.active = 1 AND s.user_id IN (SELECT value FROM json_each(?))',
        )
        .all(JSON.stringify(userIds));
    },
    // Abonnement refusé par le service (expiré ou retiré par le navigateur).
    forgetPushSubscription(endpoint) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    },
  };
}
