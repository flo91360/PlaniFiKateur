import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { STATUSES } from '../src/lib/workspace.js';

const MAX_BODY = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest();
const equal = (a, b) => !!b && timingSafeEqual(hash(a), hash(b));
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, 'unsupported_media_type', 'Envoyez du JSON avec Content-Type: application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw httpError(413, 'payload_too_large', 'La requête dépasse 4 Mo.'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) { req.resume(); throw httpError(413, 'payload_too_large', 'La requête dépasse 4 Mo.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'invalid_json', 'JSON invalide.'); }
}

export function createApi(store, config = {}) {
  const { ownerToken = '', readToken = '', secureCookie = false } = config;
  const sessions = new Map();
  const loginAttempts = new Map();
  const cookie = (token, maxAge) => `planifikateur_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const send = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
  const sameOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const owner = req => {
    const token = /(?:^|;\s*)planifikateur_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const expires = sessions.get(token);
    return !!expires && expires > Date.now();
  };
  const newSession = res => {
    for (const [token, expires] of sessions) if (expires < Date.now()) sessions.delete(token);
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    res.setHeader('Set-Cookie', cookie(token, 43200));
  };
  const requireOwner = req => {
    if (!owner(req)) throw httpError(401, 'unauthorized', 'Connectez-vous à l’interface.');
    if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
  };
  return async (req, res, next) => {
    if (!req.url.startsWith('/api/') && req.url !== '/api') { next?.(); return false; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/api/v1/session') {
        if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
        if (req.method === 'GET') {
          if (!ownerToken && !owner(req)) newSession(res);
          send(res, 200, { authenticated: !ownerToken || owner(req), requiresLogin: !!ownerToken });
        } else if (req.method === 'POST') {
          if (ownerToken) {
            const now = Date.now(), ip = req.socket.remoteAddress;
            for (const [key, attempt] of loginAttempts) if (attempt.until < now) loginAttempts.delete(key);
            const attempt = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
            if (++attempt.count > 20) throw httpError(429, 'too_many_attempts', 'Trop de tentatives. Réessayez dans une minute.');
            loginAttempts.set(ip, attempt);
          }
          const data = await body(req);
          if (ownerToken && !equal(typeof data?.token === 'string' ? data.token : '', ownerToken)) throw httpError(401, 'unauthorized', 'Clé d’accès incorrecte.');
          newSession(res); send(res, 200, { authenticated: true });
        } else if (req.method === 'DELETE') {
          requireOwner(req);
          const token = /(?:^|;\s*)planifikateur_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
          sessions.delete(token); res.setHeader('Set-Cookie', cookie('', 0)); send(res, 200, { authenticated: false });
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      if (req.method === 'PUT' && path === '/api/v1/workspace') {
        requireOwner(req);
        const match = /^"(\d+)"$/.exec(req.headers['if-match'] || '');
        if (!match) throw httpError(428, 'precondition_required', 'Envoyez la révision obtenue à la lecture dans If-Match.');
        const data = await body(req);
        let saved;
        try { saved = store.write(data?.projects, Number(match[1])); }
        catch (error) { throw httpError(400, 'invalid_workspace', error.message); }
        if (!saved) throw httpError(409, 'revision_conflict', 'Le tableau a changé dans une autre session. Rechargez les données avant de réessayer.');
        res.setHeader('ETag', `"${saved.revision}"`); send(res, 200, saved); return true;
      }
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      if (!owner(req) && !(readToken && equal(bearer, readToken)) && (ownerToken || readToken)) throw httpError(401, 'unauthorized', 'Une clé de lecture Bearer est requise.');
      if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Cette API de consultation accepte uniquement GET.');
      if (path === '/api/v1/workspace') {
        requireOwner(req);
        const workspace = store.read(); res.setHeader('ETag', `"${workspace.revision}"`); send(res, 200, workspace); return true;
      }
      const { projects, revision } = store.read();
      const meta = { revision };
      const segments = path.split('/').filter(Boolean).map(segment => { try { return decodeURIComponent(segment); } catch { throw httpError(400, 'invalid_path', 'Chemin invalide.'); } });
      if (segments[0] !== 'api' || segments[1] !== 'v1') throw httpError(404, 'not_found', 'Route inexistante.');
      const projectSummary = p => ({ id: p.id, name: p.name, description: p.description, emoji: p.emoji, color: p.color, listCount: p.lists.length, cardCount: p.cards.length });
      const scopedProject = pathId => {
        const values = url.searchParams.getAll('projectId');
        if (values.length > 1 || (values.length && (!values[0].trim() || (pathId && values[0] !== pathId)))) {
          throw httpError(400, 'invalid_project_scope', 'Indiquez un seul projet, identique à celui du chemin.');
        }
        const projectId = pathId || values[0];
        if (!projectId) throw httpError(400, 'project_required', 'Précisez le projet dans le chemin ou avec projectId.');
        const project = projects.find(p => p.id === projectId);
        if (!project) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        return project;
      };
      const cardContext = (p, c) => ({ ...c, projectId: p.id, projectName: p.name, listName: p.lists.find(l => l.id === c.listId)?.name });
      let data;
      if (path === '/api/v1/projects') data = projects.map(projectSummary);
      else if (path === '/api/v1/cards' || (segments[2] === 'projects' && segments[4] === 'cards' && segments.length === 5)) {
        const project = scopedProject(segments[2] === 'projects' ? segments[3] : undefined);
        const status = url.searchParams.get('status'), listId = url.searchParams.get('listId'), q = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('fr');
        if (status && !STATUSES.includes(status)) throw httpError(400, 'invalid_filter', 'Statut inconnu.');
        const number = (key, fallback, max) => {
          const value = url.searchParams.get(key);
          if (value === null) return fallback;
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max || (key === 'limit' && Number(value) === 0)) throw httpError(400, 'invalid_pagination', `${key} invalide.`);
          return Number(value);
        };
        const limit = number('limit', 50, 200), offset = number('offset', 0, Number.MAX_SAFE_INTEGER);
        const cards = project.cards.map(c => cardContext(project, c));
        const filtered = cards.filter(c => (!status || c.status === status) && (!listId || c.listId === listId) && (!q || `${c.title} ${c.description} ${c.tags.join(' ')}`.toLocaleLowerCase('fr').includes(q)));
        data = filtered.slice(offset, offset + limit);
        Object.assign(meta, { total: filtered.length, limit, offset, nextOffset: offset + limit < filtered.length ? offset + limit : null });
      } else if ((segments[2] === 'cards' && segments.length === 4) || (segments[2] === 'projects' && segments[4] === 'cards' && segments.length === 6)) {
        const nested = segments[2] === 'projects';
        const project = scopedProject(nested ? segments[3] : undefined);
        const card = project.cards.find(c => c.id === segments[nested ? 5 : 3]);
        if (!card) throw httpError(404, 'card_not_found', 'Carte inexistante dans ce projet.');
        data = cardContext(project, card);
      } else if (segments[2] === 'projects' && (segments.length === 4 || (segments.length === 5 && segments[4] === 'lists'))) {
        const p = projects.find(p => p.id === segments[3]);
        if (!p) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        data = segments.length === 4 ? projectSummary(p) : p.lists.map(l => ({ ...l, cardCount: p.cards.filter(c => c.listId === l.id).length }));
      } else throw httpError(404, 'not_found', 'Route inexistante.');
      send(res, 200, { data, meta });
    } catch (error) {
      send(res, error.status || 500, { error: { code: error.code || 'internal_error', message: error.status ? error.message : 'Erreur interne du serveur.' } });
    }
    return true;
  };
}
