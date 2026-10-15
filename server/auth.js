import { createHash, timingSafeEqual } from 'node:crypto';
import { httpError } from './http.js';

const hash = value => createHash('sha256').update(value).digest();
export const equalSecret = (a, b) => !!b && timingSafeEqual(hash(a), hash(b));

// Limite glissante en mémoire : `max` tentatives par clé et par minute.
function createLimiter(max, code, message) {
  const attempts = new Map();
  return key => {
    const now = Date.now();
    for (const [entry, attempt] of attempts) if (attempt.until < now) attempts.delete(entry);
    const attempt = attempts.get(key) || { count: 0, until: now + 60000 };
    if (++attempt.count > max) throw httpError(429, code, message);
    attempts.set(key, attempt);
  };
}

// Sessions personnelles (cookie HttpOnly), clés d’agent et clé de lecture.
// Adresse du client. Derrière `trustProxy` mandataires (Railway : 1), l’adresse ajoutée par le
// dernier mandataire de confiance dans X-Forwarded-For ; sinon celle de la connexion.
export function clientAddress(req, trustProxy = 0) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return (trustProxy > 0 && forwarded.at(-trustProxy)) || req.socket?.remoteAddress || '';
}

export function createAuth(store, { ownerToken = '', readToken = '', secureCookie = false, trustProxy = 0 } = {}) {
  const cookie = (token, maxAge) =>
    `planifikateur_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const sameOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    try {
      return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const sessionToken = req => /(?:^|;\s*)planifikateur_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const bearer = req => /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  const currentUser = req => store.session(sessionToken(req));
  const requireSameOrigin = req => {
    if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
  };
  const requireAccount = req => {
    const user = currentUser(req);
    if (!user) throw httpError(401, 'unauthorized', 'Connectez-vous à votre compte.');
    requireSameOrigin(req);
    return user;
  };
  const loginLimit = createLimiter(20, 'too_many_attempts', 'Trop de tentatives. Réessayez dans une minute.');
  // Tentatives sur un compte, comptées par adresse : un tiers ne peut pas bloquer la connexion
  // de son titulaire depuis une autre adresse.
  const accountLimit = createLimiter(
    10,
    'too_many_attempts',
    'Trop de tentatives pour ce compte. Réessayez dans une minute.',
  );
  // Plafond plus large pour un même compte, toutes adresses confondues (attaque répartie).
  const accountWideLimit = createLimiter(
    100,
    'too_many_attempts',
    'Trop de tentatives pour ce compte. Réessayez dans une minute.',
  );
  return {
    ownerToken,
    cookie,
    sessionToken,
    currentUser,
    requireSameOrigin,
    requireAccount,
    requireAdmin(req) {
      const user = requireAccount(req);
      if (user.role !== 'admin')
        throw httpError(403, 'admin_required', 'Cette action est réservée à l’administrateur.');
      return user;
    },
    newSession: (res, user) => res.setHeader('Set-Cookie', cookie(store.createSession(user.id), 43200)),
    requireAgent(req) {
      const agent = store.workflows.agent(bearer(req));
      if (!agent) throw httpError(401, 'agent_unauthorized', 'Une clé d’agent actif est requise.');
      return agent;
    },
    // Consultation : session, clé d’agent ou clé de lecture. Renvoie l’agent éventuel,
    // dont l’accès est limité à ses projets.
    readAccess(req) {
      const agent = store.workflows.agent(bearer(req));
      if (
        !currentUser(req) &&
        !agent &&
        !(readToken && equalSecret(bearer(req), readToken)) &&
        (store.hasUsers() || ownerToken || readToken)
      )
        throw httpError(401, 'unauthorized', 'Une clé de lecture Bearer est requise.');
      return agent;
    },
    loginLimit(req, email = '') {
      const address = clientAddress(req, trustProxy);
      loginLimit(address);
      if (!email) return;
      accountLimit(JSON.stringify([address, email]));
      accountWideLimit(email);
    },
    // Chaque reformulation consomme le quota de l’abonnement Claude : limite par compte.
    refineLimit: createLimiter(
      10,
      'too_many_refinements',
      'Trop de reformulations en une minute. Réessayez dans un instant.',
    ),
  };
}
