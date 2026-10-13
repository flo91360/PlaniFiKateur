import { githubEvent } from './github.js';
import { releaseVersion, tagPushVersion } from './project-versions.js';
import { driveReleaseFromBody } from '../src/lib/drive-release.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { STATUSES, validateWorkspace } from '../src/lib/workspace.js';
import { createReadStream } from 'node:fs';
import { accountFields, hashPassword, verifyPassword, publicUser } from './accounts.js';
import { createRefiner, validateRefinement } from './refine.js';

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
  const loginAttempts = new Map(), refinements = new Map();
  const refiner = config.refiner || createRefiner({ apiKey: config.anthropicApiKey, model: config.refineModel });
  const cookie = (token, maxAge) => `planifikateur_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const send = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
  const sameOrigin = req => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const sessionToken = req => /(?:^|;\s*)planifikateur_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const currentUser = req => store.session(sessionToken(req));
  const newSession = (res, user) => res.setHeader('Set-Cookie', cookie(store.createSession(user.id), 43200));
  const requireAccount = req => {
    const user = currentUser(req);
    if (!user) throw httpError(401, 'unauthorized', 'Connectez-vous à votre compte.');
    if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
    return user;
  };
  const requireAdmin = req => {
    const user = requireAccount(req);
    if (user.role !== 'admin') throw httpError(403, 'admin_required', 'Cette action est réservée à l’administrateur.');
    return user;
  };
  const rateLimit = req => {
    const now = Date.now(), ip = req.socket.remoteAddress;
    for (const [key, attempt] of loginAttempts) if (attempt.until < now) loginAttempts.delete(key);
    const attempt = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
    if (++attempt.count > 20) throw httpError(429, 'too_many_attempts', 'Trop de tentatives. Réessayez dans une minute.');
    loginAttempts.set(ip, attempt);
  };
  // Chaque reformulation est facturée par le fournisseur IA : limite par compte.
  const refineLimit = user => {
    const now = Date.now();
    for (const [key, attempt] of refinements) if (attempt.until < now) refinements.delete(key);
    const attempt = refinements.get(user.id) || { count: 0, until: now + 60000 };
    if (++attempt.count > 10) throw httpError(429, 'too_many_refinements', 'Trop de reformulations en une minute. Réessayez dans un instant.');
    refinements.set(user.id, attempt);
  };
  const fields = data => { try { return accountFields(data); } catch (error) { throw httpError(400, 'invalid_account', error.message); } };
  const passwordHash = async password => { try { return await hashPassword(password); } catch (error) { throw httpError(400, 'invalid_password', error.message); } };
  return async (req, res, next) => {
    if (!req.url.startsWith('/api/') && req.url !== '/api') { next?.(); return false; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/api/v1/github/webhook') {
        if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        const { event, data } = await githubEvent(req, config.githubWebhookSecret);
        if (event === 'release') {
          const repository = data.repository?.full_name, release = data.release;
          const downloads = ['published','released','edited'].includes(data.action) && repository && !release?.draft && driveReleaseFromBody(release?.body, repository, release?.tag_name);
          const published = releaseVersion(data);
          const version = published ? store.recordGithubVersion(published.repository, published.version) : { updated: false };
          send(res, 200, { data: downloads ? store.recordDriveRelease(repository, downloads) : version });
          if (downloads) void config.versions?.refresh();
          if (['published','released','edited'].includes(data.action) && !release?.draft) void config.driveArchive?.refresh();
          return true;
        }
        if (event === 'push') {
          const tag = tagPushVersion(data);
          send(res, 200, { data: tag ? store.recordGithubVersion(tag.repository, tag.version) : { updated: false } }); return true;
        }
        send(res, 200, { data: event === 'pull_request' ? store.workflows.githubMerged(data) : event === 'workflow_run' ? store.workflows.githubChecks(data) : { updated: false } }); return true;
      }
      const githubProject = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/github$/.exec(path);
      const aiProject = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/ai$/.exec(path);
      const driveProject = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/drive$/.exec(path);
      if (driveProject) {
        requireAccount(req);
        if (!store.read().projects.some(project => project.id === driveProject[1])) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        const repository = store.workflows.githubProject(driveProject[1]);
        if (req.method === 'POST') {
          requireAdmin(req);
          if (!config.driveArchive) throw httpError(503, 'drive_disabled', 'L’archivage Google Drive n’est pas configuré sur le serveur.');
          void config.driveArchive.refresh({ force: true });
        } else if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        send(res, req.method === 'POST' ? 202 : 200, { data: config.driveArchive ? config.driveArchive.status(repository) : { enabled: false, repository: repository || '', releases: [] } });
        return true;
      }
      const executionProject = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/(execution|worker-status)$/.exec(path);
      if (executionProject) {
        requireAccount(req);
        if (!store.read().projects.some(project => project.id === executionProject[1])) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        if (req.method === 'GET') send(res, 200, { data: executionProject[2] === 'execution' ? store.workflows.executionProfile(executionProject[1]) : store.workflows.workerStatus(executionProject[1]) });
        else if (req.method === 'PUT' && executionProject[2] === 'execution') { const actor = requireAdmin(req); send(res, 200, { data: store.workflows.configureExecution(executionProject[1], await body(req), actor) }); }
        else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      if (aiProject) {
        requireAccount(req);
        if (!store.read().projects.some(project => project.id === aiProject[1])) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        if (req.method === 'GET') send(res, 200, { data: store.workflows.projectAi(aiProject[1]) });
        else if (req.method === 'PUT') send(res, 200, { data: store.workflows.configureAi(aiProject[1], await body(req), requireAdmin(req)) });
        else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      const refineProject = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/refine$/.exec(path);
      if (refineProject) {
        const user = requireAccount(req);
        if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        const project = store.read().projects.find(item => item.id === refineProject[1]);
        if (!project) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        const request = validateRefinement(await body(req));
        if (!refiner.enabled) throw httpError(503, 'ai_not_configured', 'La reformulation IA n’est pas configurée : ajoutez ANTHROPIC_API_KEY aux variables du serveur du site.');
        refineLimit(user);
        const list = project.lists.find(item => item.id === request.listId)?.name || '';
        send(res, 200, { data: await refiner.refine({ ...request, list, project: { name: project.name, description: project.description, repository: store.workflows.githubProject(project.id) || '' } }) });
        return true;
      }
      if (githubProject) {
        requireAccount(req);
        if (req.method === 'GET') send(res, 200, { data: { repository: store.workflows.githubProject(githubProject[1]), branch: store.workflows.executionProfile(githubProject[1]).branch, webhookConfigured: !!config.githubWebhookSecret } });
        else if (req.method === 'PUT') {
          requireAdmin(req); const data = await body(req);
          send(res, 200, { data: store.workflows.configureGithub(githubProject[1], data?.repository, requireAdmin(req)) });
          store.refreshInfos();
          void config.versions?.refresh();
          void config.driveArchive?.refresh();
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      if (path === '/api/v1/session') {
        if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
        if (req.method === 'GET') {
          const user = currentUser(req);
          send(res, 200, { authenticated: !!user, user, requiresLogin: true, needsSetup: !store.hasUsers() });
        } else if (req.method === 'POST') {
          rateLimit(req);
          const data = await body(req);
          const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
          const user = store.userByEmail(email);
          const valid = await verifyPassword(data?.password, user?.password_hash);
          if (!valid || !user?.active || !store.userById(user.id)?.active || store.userById(user.id).password_hash !== user.password_hash) throw httpError(401, 'unauthorized', 'Adresse e-mail ou mot de passe incorrect.');
          const account = publicUser(user); newSession(res, account); send(res, 200, { authenticated: true, user: account });
        } else if (req.method === 'DELETE') {
          requireAccount(req); store.deleteSession(sessionToken(req));
          res.setHeader('Set-Cookie', cookie('', 0)); send(res, 200, { authenticated: false });
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      if (path === '/api/v1/accounts/setup' && req.method === 'POST') {
        if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
        rateLimit(req);
        if (store.hasUsers()) throw httpError(409, 'already_initialized', 'Le compte administrateur a déjà été créé.');
        const data = await body(req);
        if (ownerToken && !equal(typeof data?.token === 'string' ? data.token : '', ownerToken)) throw httpError(401, 'unauthorized', 'Clé d’initialisation incorrecte.');
        const user = store.bootstrapUser(fields(data), await passwordHash(data.password));
        newSession(res, user); send(res, 201, { authenticated: true, user }); return true;
      }
      if (path === '/api/v1/accounts/accept' && req.method === 'POST') {
        if (!sameOrigin(req)) throw httpError(403, 'forbidden', 'Origine de la requête non autorisée.');
        rateLimit(req);
        const data = await body(req);
        if (typeof data?.token !== 'string' || data.token.length !== 64 || !store.invitation(data.token)) throw httpError(400, 'invalid_invitation', 'Invitation invalide, expirée ou déjà utilisée.');
        const pending = store.invitation(data.token);
        const account = fields({ email: pending.email, name: data.name });
        const user = store.acceptInvitation(data.token, account.name, await passwordHash(data.password));
        newSession(res, user); send(res, 200, { authenticated: true, user }); return true;
      }
      if (path === '/api/v1/accounts/password' && req.method === 'POST') {
        const user = requireAccount(req); rateLimit(req);
        const data = await body(req);
        if (!await verifyPassword(data?.currentPassword, store.userById(user.id)?.password_hash)) throw httpError(401, 'unauthorized', 'Mot de passe actuel incorrect.');
        const hashed = await passwordHash(data.password); requireAccount(req); store.changePassword(user.id, hashed, user); newSession(res, user); send(res, 200, { authenticated: true, user }); return true;
      }
      if (path === '/api/v1/users' || path.startsWith('/api/v1/users/')) {
        const admin = requireAdmin(req);
        if (path === '/api/v1/users' && req.method === 'GET') send(res, 200, { data: store.users() });
        else if (path === '/api/v1/users' && req.method === 'POST') send(res, 201, { data: store.inviteUser(fields(await body(req)), admin) });
        else {
          const match = /^\/api\/v1\/users\/([a-zA-Z0-9_-]+)(\/invitation)?$/.exec(path);
          if (!match) throw httpError(404, 'not_found', 'Route inexistante.');
          if (match[2] && req.method === 'POST') send(res, 201, { data: store.inviteUser(null, admin, match[1]) });
          else if (!match[2] && req.method === 'PATCH') {
            const data = await body(req);
            if (typeof data?.active !== 'boolean') throw httpError(400, 'invalid_account', 'active doit être un booléen.');
            send(res, 200, { data: store.setActive(match[1], data.active, admin) });
          } else if (!match[2] && req.method === 'DELETE') send(res, 200, { data: store.deleteUser(match[1], admin) });
          else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        }
        return true;
      }
      const agentToken = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      const authenticatedAgent = () => {
        const agent = store.workflows.agent(agentToken);
        if (!agent) throw httpError(401, 'agent_unauthorized', 'Une clé d’agent actif est requise.');
        return agent;
      };
      if (path === '/api/v1/agent/projects') {
        if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        send(res, 200, { data: store.workflows.agentProjects(authenticatedAgent()).map(project => ({ ...project, webhookConfigured: !!config.githubWebhookSecret })) }); return true;
      }
      const diagnosticRoute = /^\/api\/v1\/agent\/projects\/([a-zA-Z0-9_-]+)\/diagnostic$/.exec(path);
      if (diagnosticRoute) {
        if (req.method !== 'POST') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        const agent = authenticatedAgent(); send(res, 200, { data: store.workflows.recordWorkerStatus(diagnosticRoute[1], await body(req), agent) }); return true;
      }
      if (path === '/api/v1/github/merge-eligibility') {
        if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        const repository = url.searchParams.get('repository') || '', number = Number(url.searchParams.get('number')), sha = url.searchParams.get('sha') || '';
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(sha)) throw httpError(400, 'invalid_pull_request', 'PR invalide.');
        send(res, 200, { data: store.workflows.mergeEligible(repository, number, sha, authenticatedAgent()) }); return true;
      }
      const agentRoute = /^\/api\/v1\/agents(?:\/([a-zA-Z0-9_-]+))?$/.exec(path);
      if (agentRoute) {
        const user = requireAdmin(req), id = agentRoute[1];
        if (req.method === 'GET' && !id) send(res, 200, { data: store.workflows.agents() });
        else if (req.method === 'POST' && !id) send(res, 201, { data: store.workflows.configureAgent(await body(req), requireAdmin(req)) });
        else if (req.method === 'PUT' && id) send(res, 200, { data: store.workflows.configureAgent(await body(req), requireAdmin(req), id) });
        else if (req.method === 'DELETE' && id) send(res, 200, { data: store.workflows.revokeAgent(id, user) });
        else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      const queueRoute = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/work$/.exec(path);
      if (queueRoute) {
        if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        send(res, 200, { data: store.workflows.queue(queueRoute[1], authenticatedAgent(), { autoPrepare: !!config.githubWebhookSecret }) }); return true;
      }
      const workRoute = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/cards\/([a-zA-Z0-9_-]+)\/work(?:\/([a-zA-Z0-9_-]+)\/(claim|revise|heartbeat|progress|question|submit|interrupt|answer|accept|reject|cancel))?$/.exec(path);
      if (workRoute) {
        const [, projectId, cardId, id, action] = workRoute;
        if (!id && req.method === 'GET') {
          const agent = currentUser(req) ? (requireAccount(req), null) : authenticatedAgent();
          send(res, 200, { data: store.workflows.list(projectId, cardId, agent) });
        } else if (!id && req.method === 'POST') {
          requireAccount(req); const data = await body(req);
          if (!config.githubWebhookSecret) throw httpError(503, 'github_not_configured', 'Configurez le secret du webhook GitHub sur le serveur.');
          send(res, 201, { data: store.workflows.prepare(projectId, cardId, data, requireAccount(req)) });
        } else if (id && req.method === 'POST') {
          const human = ['answer','accept','reject','cancel'].includes(action);
          if (human) requireAccount(req); else authenticatedAgent();
          const data = await body(req);
          const result = human ? store.workflows.human(projectId, cardId, id, action, data, requireAccount(req)) : store.workflows.agentAction(projectId, cardId, id, action, data, authenticatedAgent());
          send(res, 200, { data: result });
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      const subscription = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)\/cards\/([a-zA-Z0-9_-]+)\/subscription$/.exec(path);
      if (subscription) {
        const user = requireAccount(req);
        if (req.method === 'GET') send(res, 200, { data: store.subscription(subscription[1], subscription[2], user.id) });
        else if (req.method === 'PUT') {
          const data = await body(req);
          if (typeof data?.following !== 'boolean') throw httpError(400, 'invalid_subscription', 'following doit être un booléen.');
          send(res, 200, { data: store.setSubscription(subscription[1], subscription[2], requireAccount(req), data.following) });
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      const history = /^\/api\/v1\/projects\/([a-zA-Z0-9_-]+)(?:\/cards\/([a-zA-Z0-9_-]+))?\/activity$/.exec(path);
      if (path === '/api/v1/activity' || history) {
        requireAccount(req);
        if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        const limit = Number(url.searchParams.get('limit') || 50), before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) throw httpError(400, 'invalid_pagination', 'Pagination invalide.');
        const events = store.activity({ projectId: history?.[1], cardId: history?.[2], limit, before });
        send(res, 200, { data: events, meta: { nextBefore: events.length === limit ? events.at(-1).id : null } }); return true;
      }
      if (req.method === 'PUT' && path === '/api/v1/workspace') {
        requireAccount(req);
        const match = /^"(\d+)"$/.exec(req.headers['if-match'] || '');
        if (!match) throw httpError(428, 'precondition_required', 'Envoyez la révision obtenue à la lecture dans If-Match.');
        const data = await body(req);
        let clean;
        try { clean = validateWorkspace(data?.projects); }
        catch (error) { throw httpError(400, 'invalid_workspace', error.message); }
        if (config.backups && store.getRevision() === Number(match[1])) {
          const before = store.read().projects;
          const removesContent = before.some(p => {
            const after = clean.find(next => next.id === p.id);
            return !after || p.cards.some(c => !after.cards.some(next => next.id === c.id)) || p.lists.some(l => !after.lists.some(next => next.id === l.id));
          });
          if (removesContent) {
            try { config.backups.create(); }
            catch { throw httpError(503, 'backup_failed', 'La sauvegarde de sécurité a échoué. La suppression n’a pas été enregistrée.'); }
          }
        }
        let saved;
        try { saved = store.write(clean, Number(match[1]), requireAccount(req)); }
        catch (error) { throw httpError(error.status || 400, error.code || 'invalid_workspace', error.message); }
        if (!saved) throw httpError(409, 'revision_conflict', 'Le tableau a changé dans une autre session. Rechargez les données avant de réessayer.');
        res.setHeader('ETag', `"${saved.revision}"`); send(res, 200, saved); return true;
      }
      if (path === '/api/v1/backups' || path.startsWith('/api/v1/backups/')) {
        requireAdmin(req);
        if (!config.backups) throw httpError(503, 'backups_unavailable', 'Les sauvegardes ne sont pas configurées.');
        if (path === '/api/v1/backups' && req.method === 'GET') send(res, 200, config.backups.status());
        else if (path === '/api/v1/backups' && req.method === 'POST') {
          try { send(res, 201, { data: config.backups.create() }); }
          catch { throw httpError(503, 'backup_failed', 'Impossible de créer la sauvegarde. Vérifiez le stockage et les logs.'); }
        } else if (req.method === 'GET' && path.startsWith('/api/v1/backups/')) {
          const name = path.slice('/api/v1/backups/'.length);
          const file = config.backups.file(name);
          if (!file) throw httpError(404, 'backup_not_found', 'Sauvegarde inexistante.');
          res.setHeader('Content-Type', 'application/vnd.sqlite3');
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          createReadStream(file).on('error', () => res.destroy()).pipe(res);
        } else throw httpError(405, 'method_not_allowed', 'Méthode non autorisée.');
        return true;
      }
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
      const readingAgent = store.workflows.agent(bearer);
      if (!currentUser(req) && !readingAgent && !(readToken && equal(bearer, readToken)) && (store.hasUsers() || ownerToken || readToken)) throw httpError(401, 'unauthorized', 'Une clé de lecture Bearer est requise.');
      if (req.method !== 'GET') throw httpError(405, 'method_not_allowed', 'Cette API de consultation accepte uniquement GET.');
      if (path === '/api/v1/workspace') {
        requireAccount(req);
        const etag = `"${store.getRevision()}"`;
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return true; }
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
        if (readingAgent && !readingAgent.projectIds.includes(projectId)) throw httpError(403, 'agent_scope', 'Projet non autorisé pour cet agent.');
        if (!projectId) throw httpError(400, 'project_required', 'Précisez le projet dans le chemin ou avec projectId.');
        const project = projects.find(p => p.id === projectId);
        if (!project) throw httpError(404, 'project_not_found', 'Projet inexistant.');
        return project;
      };
      const cardContext = (p, c) => ({ ...c, projectId: p.id, projectName: p.name, listName: p.lists.find(l => l.id === c.listId)?.name });
      let data;
      if (path === '/api/v1/projects') data = projects.filter(p => !readingAgent || readingAgent.projectIds.includes(p.id)).map(projectSummary);
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
        if (readingAgent && !readingAgent.projectIds.includes(segments[3])) throw httpError(403, 'agent_scope', 'Projet non autorisé pour cet agent.');
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
