import { randomBytes, randomUUID } from 'node:crypto';
import { pullRequestLink } from './github.js';
import { tokenHash } from './accounts.js';
import { validateWorkspace } from '../src/lib/workspace.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_work', `${name} est requis (maximum ${max} caractères).`);
  return value.trim();
};
const terminal = new Set(['done', 'cancelled']);
const cardStatus = { ready: 'ready', running: 'progress', waiting: 'clarify', review: 'review', merging: 'review', interrupted: 'ready', done: 'done', cancelled: 'draft' };
const source = card => JSON.stringify([card.title, card.description, card.tags, card.checklist.map(c => c.text), ...((card.attachments || []).length ? [card.attachments] : [])]);
export const LEASE_MS = 5 * 60000;

export function createWorkflows(db, { transaction, audit, findCard }) {
  db.exec(`CREATE TABLE IF NOT EXISTS github_projects (project_id TEXT PRIMARY KEY, repository TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_pr_bindings (repository TEXT NOT NULL, number INTEGER NOT NULL, execution_id TEXT NOT NULL, PRIMARY KEY(repository,number));
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, projects TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, card_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, lease_hash TEXT, lease_expires INTEGER, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_active_card ON executions(card_id) WHERE state NOT IN ('done','cancelled');`);
  const publicAgent = row => ({ id: row.id, name: row.name, projectIds: JSON.parse(row.projects), active: !!row.active });
  const rows = () => db.prepare('SELECT * FROM executions ORDER BY rowid DESC').all();
  const unpack = row => ({ ...JSON.parse(row.data), id: row.id, projectId: row.project_id, cardId: row.card_id, state: row.state, version: row.version, leaseExpiresAt: row.lease_expires ? new Date(row.lease_expires).toISOString() : null });
  const recipients = (card, actor, extra = []) => {
    const prefs = db.prepare('SELECT * FROM card_subscriptions WHERE card_id = ?').all(card.id);
    const out = new Set(prefs.filter(p => !p.following).map(p => p.user_id));
    const active = new Set(db.prepare('SELECT id FROM users WHERE active = 1 AND password_hash IS NOT NULL').all().map(u => u.id));
    return [...new Set([card.createdBy?.id, ...card.comments.map(c => c.authorId), ...prefs.filter(p => p.following).map(p => p.user_id), ...extra])].filter(id => id && id !== actor?.id && active.has(id) && !out.has(id));
  };
  const addComment = (card, run, actor, id, message, date = new Date().toISOString(), strict = true) => {
    if (card.comments.some(comment => comment.id === id)) return false;
    if (card.comments.length >= 1000) {
      if (strict) fail(400, 'comment_limit', 'La discussion de cette carte a atteint sa limite de commentaires.');
      return false;
    }
    const authorKind = actor?.id && actor.id === run.agent?.id ? 'agent' : actor?.id === 'github' || !actor ? 'system' : 'user';
    card.comments.push({ id, author: actor?.name || 'Agent IA', authorId: actor?.id || null, authorKind, text: message.slice(0, 10000), date });
    audit(actor, 'comment.created', { projectId: run.projectId, cardId: run.cardId, cardTitle: card.title, details: { commentId: id }, executionId: run.id, recipientIds: recipients(card, actor, [run.requestedBy.id]) });
    return true;
  };
  const questionComments = (card, run, strict = true) => {
    let changed = false;
    run.exchanges.forEach((exchange, index) => {
      changed = addComment(card, run, run.agent, `work-${run.id}-question-${index}`, exchange.question, exchange.date, strict) || changed;
      if (exchange.answer && !exchange.answer.commentId) {
        changed = addComment(card, run, exchange.answer.actor, `work-${run.id}-answer-${index}`, exchange.answer.text, exchange.answer.date, strict) || changed;
      }
    });
    return changed;
  };
  const save = (run, actor, action, { leaseHash = null, expires = null, syncCard = true } = {}) => {
    run.leaseExpiresAt = expires ? new Date(expires).toISOString() : null;
    run.version++; run.updatedAt = new Date().toISOString();
    db.prepare('UPDATE executions SET state=?,version=?,lease_hash=?,lease_expires=?,data=? WHERE id=?').run(run.state, run.version, leaseHash, expires, JSON.stringify(run), run.id);
    let context;
    try { context = findCard(run.projectId, run.cardId); } catch (error) { if (error.status !== 404) throw error; }
    if (context && syncCard) {
      const row = db.prepare('SELECT projects FROM workspace WHERE id=1').get(); const projects = JSON.parse(row.projects);
      const card = projects.find(p => p.id === run.projectId).cards.find(c => c.id === run.cardId);
      card.status = cardStatus[run.state]; card.updatedAt = run.updatedAt; card.updatedBy = actor ? { id: actor.id, name: actor.name } : null;
      if (['question', 'answer'].includes(action)) questionComments(card, run);
      let message;
      if (action === 'progress') message = run.updates.at(-1)?.text;
      if (['interrupt', 'interrupted'].includes(action)) message = run.interruption;
      if (action === 'submit') {
        const result = run.submissions.at(-1);
        message = `${result.pullRequest ? `PR : ${result.pullRequest.url}\n\n` : ''}${result.summary}${result.files?.length ? `\n\nFichiers disponibles dans les pièces jointes : ${result.files.map(file => file.name).join(', ')}` : ''}\n\nVérifications : ${result.checks}`;
      }
      if (action === 'merged') message = `La PR a été fusionnée. La tâche est terminée.\n${run.submissions.at(-1).pullRequest.url}`;
      if (action === 'checks' && run.state === 'ready') message = run.updates.at(-1)?.text;
      if (message) addComment(card, run, actor, `work-${run.id}-${action}-${run.version}`, message);
      db.prepare('UPDATE workspace SET projects=?,revision=revision+1,updated_at=? WHERE id=1').run(JSON.stringify(projects), run.updatedAt);
    }
    audit(actor, `work.${action}`, { projectId: run.projectId, cardId: run.cardId, projectName: context?.project.name, cardTitle: context?.card.title, executionId: run.id, state: run.state, recipientIds: context ? recipients(context.card, actor, [run.requestedBy.id]) : [] });
    return run;
  };
  const expire = () => {
    for (const row of rows()) if (row.state === 'running' && row.lease_expires <= Date.now()) {
      const run = unpack(row); run.state = 'interrupted'; run.interruption = 'L’agent ne répond plus. La réservation a expiré.';
      save(run, null, 'interrupted');
    }
  };
  const scoped = (projectId, cardId, id) => {
    findCard(projectId, cardId);
    const row = db.prepare('SELECT * FROM executions WHERE id=? AND project_id=? AND card_id=?').get(id, projectId, cardId);
    if (!row) fail(404, 'execution_not_found', 'Exécution inexistante dans cette carte.');
    return row;
  };
  const checkVersion = (run, version) => { if (!Number.isSafeInteger(version) || version !== run.version) fail(409, 'work_conflict', 'L’exécution a changé. Actualisez avant de réessayer.'); };
  const checkAgent = (agent, projectId) => {
    const row = db.prepare('SELECT * FROM agents WHERE id=? AND active=1').get(agent.id);
    if (!row || !JSON.parse(row.projects).includes(projectId)) fail(403, 'agent_scope', 'Projet non autorisé pour cet agent.');
  };
  const checkSource = run => {
    const { card } = findCard(run.projectId, run.cardId);
    if (source(card) !== run.source) fail(409, 'request_changed', 'La demande a changé. Préparez une nouvelle exécution.');
  };
  const githubProject = projectId => db.prepare('SELECT repository FROM github_projects WHERE project_id=?').get(projectId)?.repository || null;
  const prepare = (projectId, cardId, data, actor) => {
    const { card } = findCard(projectId, cardId);
    if (db.prepare("SELECT id FROM executions WHERE card_id=? AND state NOT IN ('done','cancelled')").get(cardId)) fail(409, 'active_execution', 'Une exécution existe déjà. Annulez-la avant de préparer une nouvelle demande.');
    const delivery = 'github';
    if (data?.delivery !== undefined && data.delivery !== 'github') fail(400, 'invalid_delivery', 'La livraison se fait par fusion automatique GitHub.');
    const repository = githubProject(projectId);
    if (!repository) fail(400, 'github_not_configured', 'Configurez le dépôt GitHub du projet.');
    const run = { delivery, repository, id: randomUUID(), projectId, cardId, state: 'ready', version: 0, requestSource: 'card', objective: text(card.description, 'Description de la carte'), criteria: '', context: '', requestedBy: { id: actor.id, name: actor.name }, createdAt: new Date().toISOString(), source: source(card), cardSnapshot: card, agent: null, updates: [], exchanges: [], submissions: [] };
    db.prepare('INSERT INTO executions(id,project_id,card_id,state,version,data) VALUES(?,?,?,?,0,?)').run(run.id, projectId, cardId, run.state, JSON.stringify(run));
    return save(run, actor, 'prepared');
  };
  // Bring existing questions into the card discussion when upgrading the site.
  transaction(() => {
    const projects = JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id=1').get().projects);
    let changed = false;
    const agentIds = new Set(db.prepare('SELECT id FROM agents').all().map(agent => agent.id));
    for (const card of projects.flatMap(project => project.cards)) for (const comment of card.comments) {
      if (!comment.authorKind && agentIds.has(comment.authorId)) { comment.authorKind = 'agent'; changed = true; }
    }
    for (const row of rows()) {
      const run = unpack(row), card = projects.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
      if (card) changed = questionComments(card, run, false) || changed;
    }
    if (changed) db.prepare('UPDATE workspace SET projects=?,revision=revision+1,updated_at=? WHERE id=1').run(JSON.stringify(projects), new Date().toISOString());
  });
  return {
    githubProject,
    configureGithub(projectId, repository, actor) {
      return transaction(() => {
        const projects = JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id=1').get().projects);
        if (!projects.some(p => p.id === projectId)) fail(404, 'project_not_found', 'Projet inexistant.');
        if (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || repository.length > 200) fail(400, 'invalid_repository', 'Indiquez le dépôt sous la forme propriétaire/dépôt.');
        db.prepare('INSERT INTO github_projects VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET repository=excluded.repository').run(projectId, repository);
        audit(actor, 'github.configured', { projectId, repository }); return { repository, branch: 'main' };
      });
    },
    mergeEligible(repository, number, headSha, agent) {
      const binding = db.prepare('SELECT execution_id FROM github_pr_bindings WHERE repository=? AND number=?').get(repository.toLowerCase(), number);
      if (!binding) return { eligible: false };
      const run = unpack(db.prepare('SELECT * FROM executions WHERE id=?').get(binding.execution_id));
      checkAgent(agent, run.projectId);
      if (run.state !== 'merging' || run.agent?.id !== agent.id || run.submissions.at(-1)?.pullRequest?.headSha !== headSha) return { eligible: false };
      checkSource(run); return { eligible: true };
    },
    githubChecks(event) {
      return transaction(() => {
        const check = event?.workflow_run, repository = event?.repository?.full_name;
        if (event?.action !== 'completed' || check?.name !== 'Tests' || check.event !== 'pull_request' || typeof repository !== 'string' || check.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() || check.status !== 'completed' || !Number.isSafeInteger(check.id) || !Number.isInteger(check.run_attempt) || !['success','failure','cancelled','timed_out','action_required','neutral','skipped','stale'].includes(check.conclusion)) return { updated: false };
        let updated = false;
        for (const row of rows()) {
          const run = unpack(row), pr = run.submissions.at(-1)?.pullRequest;
          if (run.state !== 'merging' || pr?.repository !== repository.toLowerCase() || pr.headSha !== check.head_sha) continue;
          if (run.githubChecks?.runId > check.id || (run.githubChecks?.runId === check.id && run.githubChecks?.attempt >= check.run_attempt)) continue;
          run.githubChecks = { runId: check.id, attempt: check.run_attempt, conclusion: check.conclusion, url: check.html_url };
          // Labeling a newly opened PR starts another CI run and supersedes the
          // first one. A cancelled run must not send the task back to Codex.
          if (check.conclusion === 'cancelled') {
            run.updates.push({ text: 'Une exécution des contrôles GitHub a été annulée. La tâche reste en attente des tests et de la fusion.', date: new Date().toISOString() });
          } else if (check.conclusion !== 'success') { run.state = 'ready'; run.updates.push({ text: 'Les contrôles GitHub ont échoué. Le worker reprend la tâche pour corriger puis soumettre à nouveau la PR.', date: new Date().toISOString() }); }
          save(run, { id: 'github', name: 'GitHub' }, 'checks'); updated = true;
        }
        return { updated };
      });
    },
    githubMerged(event) {
      return transaction(() => {
        const pr = event?.pull_request, repository = event?.repository?.full_name;
        if (event?.action !== 'closed' || pr?.merged !== true || typeof repository !== 'string' || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.base?.ref !== 'main' || pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || '') || !Number.isFinite(Date.parse(pr.merged_at))) return { updated: false };
        const binding = db.prepare('SELECT execution_id FROM github_pr_bindings WHERE repository=? AND number=?').get(repository.toLowerCase(), pr.number);
        if (!binding) return { updated: false };
        const row = db.prepare('SELECT * FROM executions WHERE id=?').get(binding.execution_id);
        const run = unpack(row), submission = run.submissions.at(-1);
        if (run.state !== 'merging' || submission?.pullRequest?.headSha !== pr.head?.sha || Date.parse(pr.merged_at) + 1000 < Date.parse(submission.date)) return { updated: false };
        checkSource(run);
        run.state = 'done'; submission.pullRequest.mergeSha = pr.merge_commit_sha;
        submission.decision = { accepted: true, automatic: true, actor: { id: 'github', name: 'GitHub' }, date: pr.merged_at };
        save(run, { id: 'github', name: 'GitHub' }, 'merged'); return { updated: true };
      });
    },
    agents() { return db.prepare('SELECT * FROM agents ORDER BY rowid DESC').all().map(publicAgent); },
    agent(token) { const row = db.prepare('SELECT * FROM agents WHERE token_hash=? AND active=1').get(tokenHash(token || '')); return row ? publicAgent(row) : null; },
    configureAgent(data, actor, id = null) {
      return transaction(() => {
        const name = text(data?.name, 'Nom de l’agent', 80);
        if (!Array.isArray(data.projectIds) || !data.projectIds.length || data.projectIds.length > 100 || data.projectIds.some(p => typeof p !== 'string')) fail(400, 'invalid_work', 'Sélectionnez au moins un projet.');
        const projects = JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id=1').get().projects);
        if (data.projectIds.some(id => !projects.some(p => p.id === id))) fail(400, 'invalid_work', 'Projet inexistant.');
        if (id) {
          if (!db.prepare('SELECT id FROM agents WHERE id=? AND active=1').get(id)) fail(404, 'agent_not_found', 'Agent actif inexistant.');
          db.prepare('UPDATE agents SET name=?,projects=? WHERE id=?').run(name, JSON.stringify([...new Set(data.projectIds)]), id);
          for (const row of rows()) if (!terminal.has(row.state) && JSON.parse(row.data).agent?.id === id && !data.projectIds.includes(row.project_id)) {
            const run = unpack(row); run.state = 'interrupted'; run.interruption = 'L’accès de l’agent au projet a été retiré.'; save(run, actor, 'interrupted');
          }
          audit(actor, 'agent.configured', { agentId: id }); return { agent: this.agents().find(a => a.id === id) };
        }
        if (this.agents().some(a => a.active)) fail(409, 'single_agent', 'Cette version accepte un seul agent actif.');
        id = randomUUID(); const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO agents(id,name,token_hash,projects) VALUES(?,?,?,?)').run(id, name, tokenHash(token), JSON.stringify([...new Set(data.projectIds)]));
        audit(actor, 'agent.created', { agentId: id }); return { agent: this.agents().find(a => a.id === id), token };
      });
    },
    revokeAgent(id, actor) {
      return transaction(() => {
        if (!db.prepare('SELECT id FROM agents WHERE id=? AND active=1').get(id)) fail(404, 'agent_not_found', 'Agent actif inexistant.');
        db.prepare('UPDATE agents SET active=0 WHERE id=?').run(id);
        for (const row of rows()) if (['running', 'waiting'].includes(row.state) && JSON.parse(row.data).agent?.id === id) {
          const run = unpack(row); run.state = 'interrupted'; run.interruption = 'La clé de l’agent a été révoquée.'; save(run, actor, 'interrupted');
        }
        audit(actor, 'agent.revoked', { agentId: id }); return { revoked: true };
      });
    },
    list(projectId, cardId, agent = null) {
      return transaction(() => {
        if (agent) checkAgent(agent, projectId);
        findCard(projectId, cardId); expire();
        return rows().filter(row => row.project_id === projectId && row.card_id === cardId).map(unpack);
      });
    },
    queue(projectId, agent, { autoPrepare = true } = {}) {
      return transaction(() => {
        checkAgent(agent, projectId); expire();
        const projects = JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id=1').get().projects);
        const project = projects.find(p => p.id === projectId);
        if (autoPrepare && githubProject(projectId)) {
          const activeCards = new Set(rows().filter(row => !terminal.has(row.state)).map(row => row.card_id));
          for (const card of project?.cards || []) {
            if (card.status !== 'ready' || !card.description.trim() || activeCards.has(card.id)) continue;
            const readiness = db.prepare("SELECT actor_id,actor_name FROM activity WHERE card_id=? AND action='card.status_changed' AND json_extract(payload,'$.details.to')='ready' ORDER BY id DESC LIMIT 1").get(card.id);
            const actor = readiness?.actor_id ? { id: readiness.actor_id, name: readiness.actor_name } : card.updatedBy || card.createdBy || { id: 'system', name: 'Système' };
            prepare(projectId, card.id, {}, actor);
          }
        }
        return rows().filter(row => row.project_id === projectId && ['ready','interrupted'].includes(row.state)).map(unpack);
      });
    },
    prepare(projectId, cardId, data, actor) {
      return transaction(() => prepare(projectId, cardId, data, actor));
    },
    human(projectId, cardId, id, action, data, actor) {
      return transaction(() => {
        const run = unpack(scoped(projectId, cardId, id)); checkVersion(run, data?.version);
        if (terminal.has(run.state)) fail(409, 'invalid_transition', 'Cette exécution est terminée.');
        if (action === 'cancel') { run.state = 'cancelled'; run.cancellation = text(data?.message, 'Motif', 10000); }
        else if (action === 'answer' && run.state === 'waiting') {
          const answer = text(data?.message, 'Réponse', 10000); run.exchanges.at(-1).answer = { text: answer, actor: { id: actor.id, name: actor.name }, date: new Date().toISOString() }; run.state = 'ready';
        } else if (action === 'accept' && run.state === 'review') {
          checkSource(run); run.state = 'done'; run.submissions.at(-1).decision = { accepted: true, actor: { id: actor.id, name: actor.name }, date: new Date().toISOString() };
        } else if (action === 'reject' && ['review','merging'].includes(run.state)) {
          run.submissions.at(-1).decision = { accepted: false, message: text(data?.message, 'Corrections demandées', 10000), actor: { id: actor.id, name: actor.name }, date: new Date().toISOString() }; run.state = 'ready';
        } else fail(409, 'invalid_transition', 'Cette action n’est pas disponible à cette étape.');
        return save(run, actor, action);
      });
    },
    agentAction(projectId, cardId, id, action, data, agent) {
      // Persist expiration even when the stale worker's action is subsequently rejected.
      transaction(expire);
      return transaction(() => {
        checkAgent(agent, projectId); const row = scoped(projectId, cardId, id), run = unpack(row);
        if (action === 'claim' || action === 'revise') {
          // Compatibility recovery for the old worker's technical publication question.
          // Real requests for clarification still require a human answer.
          const publicationRecovery = run.delivery === 'github' && run.state === 'waiting' && run.submissions.at(-1)?.pullRequest
            && run.exchanges.at(-1)?.question === 'La PR ne pointe pas sur le commit testé.' && !run.exchanges.at(-1)?.answer;
          if (action === 'revise' ? ((!publicationRecovery && run.state !== 'merging') || run.agent?.id !== agent.id) : !['ready','interrupted'].includes(run.state)) fail(409, 'already_claimed', 'Cette exécution n’est pas disponible.');
          checkVersion(run, data?.version); checkSource(run);
          const leaseToken = randomBytes(32).toString('hex'); run.state = 'running'; run.agent = { id: agent.id, name: agent.name }; run.interruption = null;
          save(run, agent, 'claimed', { leaseHash: tokenHash(leaseToken), expires: Date.now() + LEASE_MS });
          return { ...run, leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
        }
        if (run.state !== 'running' || run.agent?.id !== agent.id || typeof data?.leaseToken !== 'string' || tokenHash(data.leaseToken) !== row.lease_hash || row.lease_expires <= Date.now()) fail(409, 'invalid_lease', 'Réservation expirée ou invalide. Reprenez la tâche depuis la file.');
        if (action === 'heartbeat') {
          const expires = Date.now() + LEASE_MS; db.prepare('UPDATE executions SET lease_expires=? WHERE id=?').run(expires, id); return { ...run, leaseExpiresAt: new Date(expires).toISOString() };
        }
        checkVersion(run, data?.version); checkSource(run);
        if (action === 'progress') {
          if (run.updates.length >= 200) fail(400, 'update_limit', 'Limite de mises à jour atteinte.');
          run.updates.push({ text: text(data?.message, 'Avancement', 10000), date: new Date().toISOString() });
          return save(run, agent, action, { leaseHash: row.lease_hash, expires: Date.now() + LEASE_MS });
        }
        if (action === 'question') {
          if (run.exchanges.length >= 100) fail(400, 'question_limit', 'Limite de questions atteinte.');
          run.exchanges.push({ question: text(data?.message, 'Question', 10000), date: new Date().toISOString(), answer: null }); run.state = 'waiting';
        } else if (action === 'submit') {
          if (run.submissions.length >= 50) fail(400, 'submission_limit', 'Limite de soumissions atteinte.');
          if (!Array.isArray(data?.links) || data.links.length > 20 || data.links.some(link => { try { return !['http:','https:'].includes(new URL(link).protocol) || link.length > 2048; } catch { return true; } })) fail(400, 'invalid_links', 'Les livrables doivent être des liens HTTP ou HTTPS (20 maximum).');
          run.githubChecks = null;
          const files = data.files ?? [];
          if (!Array.isArray(files) || files.length > 10 || files.some(file => typeof file?.id !== 'string' || !file.id.startsWith(`generated-${run.id}-`))) fail(400, 'invalid_files', 'Pièces jointes générées invalides.');
          const artifactOnly = data.artifactOnly === true;
          if (artifactOnly && (!files.length || data.pullRequest || run.submissions.some(submission => submission.pullRequest))) fail(400, 'invalid_delivery', 'Une livraison de fichiers doit contenir un fichier et ne pas remplacer une PR existante.');
          const pullRequest = run.delivery === 'github' && !artifactOnly ? pullRequestLink(data.pullRequest, run.repository) : null;
          if (pullRequest) {
            const binding = db.prepare('SELECT execution_id FROM github_pr_bindings WHERE repository=? AND number=?').get(pullRequest.repository, pullRequest.number);
            if (binding && binding.execution_id !== run.id) fail(409, 'pr_already_linked', 'Cette PR est déjà liée à une autre exécution.');
            db.prepare('INSERT OR IGNORE INTO github_pr_bindings VALUES(?,?,?)').run(pullRequest.repository, pullRequest.number, run.id);
          }
          if (files.length) {
            const row = db.prepare('SELECT projects FROM workspace WHERE id=1').get(), projects = JSON.parse(row.projects);
            const card = projects.find(project => project.id === projectId).cards.find(card => card.id === cardId);
            card.attachments = [...(card.attachments || []).filter(file => !files.some(next => next.id === file.id)), ...files];
            let clean;
            try { clean = validateWorkspace(projects); } catch (error) { fail(400, 'invalid_files', error.message); }
            const delivered = clean.find(project => project.id === projectId).cards.find(card => card.id === cardId);
            // Generated outputs become part of the card without invalidating the
            // run that produced them. Subsequent human changes remain protected.
            run.source = source(delivered);
            run.cardSnapshot = { ...run.cardSnapshot, attachments: delivered.attachments };
            db.prepare('UPDATE workspace SET projects=? WHERE id=1').run(JSON.stringify(clean));
            audit(agent, 'card.updated', { projectId, cardId, cardTitle: card.title, executionId: run.id, details: { fields: ['attachments'] }, recipientIds: recipients(card, agent, [run.requestedBy.id]) }, db.prepare('SELECT revision FROM workspace WHERE id=1').get().revision + 1);
          }
          run.submissions.push({ summary: text(data.summary, 'Résultat'), checks: text(data.checks, 'Vérifications'), links: data.links, pullRequest, files: files.map(({ id, name, size, type }) => ({ id, name, size, type })), date: new Date().toISOString(), decision: null }); run.state = artifactOnly ? 'done' : pullRequest ? 'merging' : 'review';
        } else if (action === 'interrupt') { run.state = 'interrupted'; run.interruption = text(data?.message, 'Motif', 10000); }
        else fail(400, 'invalid_action', 'Action agent inconnue.');
        return save(run, agent, action);
      });
    },
    reconcile(before, after, actor, restore) {
      for (const row of rows()) if (!terminal.has(row.state)) {
        const run = unpack(row), card = after.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
        if (restore || !card || source(card) !== run.source) {
          run.state = 'cancelled'; run.cancellation = restore ? 'Restauration du contenu : préparez une nouvelle demande.' : 'Carte supprimée, déplacée ou demande modifiée : préparez une nouvelle exécution.';
          save(run, actor, 'cancel', { syncCard: false });
          if (card) card.status = 'draft';
        } else if (run.state === 'ready' && card.status !== 'ready') {
          run.state = 'cancelled'; run.cancellation = 'La carte a été retirée de la file par son changement de statut.';
          save(run, actor, 'cancel', { syncCard: false });
        } else if (card.status !== cardStatus[run.state]) fail(409, 'managed_status', 'Le statut de cette carte est piloté par son exécution IA.');
        if (run.state === 'waiting' && card && actor && !restore) {
          const previous = before.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
          const oldIds = new Set(previous?.comments.map(comment => comment.id));
          const reply = card.comments.find(comment => !oldIds.has(comment.id) && comment.text.trim());
          if (reply) {
            run.exchanges.at(-1).answer = { text: reply.text.trim(), actor: { id: actor.id, name: actor.name }, date: new Date().toISOString(), commentId: reply.id };
            run.state = 'ready';
            save(run, actor, 'answer', { syncCard: false });
            card.status = 'ready';
          }
        }
      }
    },
  };
}
