import { fail } from '../http.js';
import { CARD_STATUS, isTerminal, transition } from '../execution-states.js';
import { defaultExecutionProfile } from '../../worker/execution-profile.mjs';

// Socle commun des exécutions : tables, lecture, enregistrement (avec le statut de la carte, la
// discussion et l’historique) et contrôles partagés par les modules de server/workflows/.

export const LEASE_MS = 5 * 60000;
// Échecs consécutifs des contrôles GitHub avant de demander l’avis d’une personne.
export const MAX_CI_FAILURES = 3;
export const OPEN = "state NOT IN ('done','cancelled')";
export const GITHUB_ACTOR = Object.freeze({ id: 'github', name: 'GitHub' });

export const text = (value, name, max = 20000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(400, 'invalid_work', `${name} est requis (maximum ${max} caractères).`);
  return value.trim();
};

// Empreinte de la demande : une exécution est annulée si la carte change depuis sa préparation.
export const source = card =>
  JSON.stringify([
    card.title,
    card.description,
    card.tags,
    card.checklist.map(c => c.text),
    ...((card.attachments || []).length ? [card.attachments] : []),
    ...(card.aiEffort ? [{ aiEffort: card.aiEffort }] : []),
  ]);

export function createSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_worker_status (project_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,agent_id));
    CREATE TABLE IF NOT EXISTS project_execution (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_ai (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_projects (project_id TEXT PRIMARY KEY, repository TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS github_pr_bindings (repository TEXT NOT NULL, number INTEGER NOT NULL, execution_id TEXT NOT NULL, PRIMARY KEY(repository,number));
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, projects TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, card_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, lease_hash TEXT, lease_expires INTEGER, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS execution_active_card ON executions(card_id) WHERE state NOT IN ('done','cancelled');
    CREATE INDEX IF NOT EXISTS executions_state ON executions(state);
    CREATE INDEX IF NOT EXISTS executions_card ON executions(project_id, card_id);`);
}

export function createCore(db, { audit, findCard, readProjects, writeProjects, recipients, emit, requiresApproval }) {
  // Exécutions filtrées par SQL (indexées par état et par carte), les plus récentes d’abord.
  const rows = (where = '1', ...params) =>
    db.prepare(`SELECT * FROM executions WHERE ${where} ORDER BY rowid DESC`).all(...params);
  const unpack = row => ({
    ...JSON.parse(row.data),
    id: row.id,
    projectId: row.project_id,
    cardId: row.card_id,
    state: row.state,
    version: row.version,
    leaseExpiresAt: row.lease_expires ? new Date(row.lease_expires).toISOString() : null,
  });
  const byId = id => unpack(db.prepare('SELECT * FROM executions WHERE id=?').get(id));
  // Exécution liée à une PR (dépôt en minuscules), ou null.
  const boundExecution = (repository, number) =>
    db
      .prepare('SELECT execution_id FROM github_pr_bindings WHERE repository=? AND number=?')
      .get(repository.toLowerCase(), number)?.execution_id || null;
  // Une exécution terminée garde la liste de ses pièces jointes, sans leur contenu : seul le
  // worker en a besoin, pendant la réalisation.
  const compact = run => {
    if (!run.cardSnapshot?.attachments?.some(file => 'data' in file)) return run;
    run.cardSnapshot = {
      ...run.cardSnapshot,
      attachments: run.cardSnapshot.attachments.map(({ data, ...file }) => file),
    };
    return run;
  };
  const addComment = (card, run, actor, id, message, date = new Date().toISOString(), strict = true) => {
    if (card.comments.some(comment => comment.id === id)) return false;
    if (card.comments.length >= 1000) {
      if (strict) fail(400, 'comment_limit', 'La discussion de cette carte a atteint sa limite de commentaires.');
      return false;
    }
    const authorKind =
      actor?.id && actor.id === run.agent?.id ? 'agent' : actor?.id === 'github' || !actor ? 'system' : 'user';
    card.comments.push({
      id,
      author: actor?.name || 'Agent IA',
      authorId: actor?.id || null,
      authorKind,
      text: message.slice(0, 10000),
      date,
    });
    audit(actor, 'comment.created', {
      projectId: run.projectId,
      cardId: run.cardId,
      cardTitle: card.title,
      details: { commentId: id },
      executionId: run.id,
      recipientIds: recipients(card, actor, [run.requestedBy.id]),
    });
    return true;
  };
  const questionComments = (card, run, strict = true) => {
    let changed = false;
    run.exchanges.forEach((exchange, index) => {
      changed =
        addComment(
          card,
          run,
          run.agent,
          `work-${run.id}-question-${index}`,
          exchange.question,
          exchange.date,
          strict,
        ) || changed;
      if (exchange.answer && !exchange.answer.commentId) {
        changed =
          addComment(
            card,
            run,
            exchange.answer.actor,
            `work-${run.id}-answer-${index}`,
            exchange.answer.text,
            exchange.answer.date,
            strict,
          ) || changed;
      }
    });
    return changed;
  };
  const save = (run, actor, action, { leaseHash = null, expires = null, syncCard = true } = {}) => {
    if (isTerminal(run.state)) compact(run);
    run.leaseExpiresAt = expires ? new Date(expires).toISOString() : null;
    run.version++;
    run.updatedAt = new Date().toISOString();
    // Une tentative de l’agent s’arrête dès que l’exécution quitte l’état « running ».
    const attempt = run.attempts?.at(-1);
    if (attempt && !attempt.endedAt && run.state !== 'running') attempt.endedAt = run.updatedAt;
    db.prepare('UPDATE executions SET state=?,version=?,lease_hash=?,lease_expires=?,data=? WHERE id=?').run(
      run.state,
      run.version,
      leaseHash,
      expires,
      JSON.stringify(run),
      run.id,
    );
    emit({ type: 'work', projectId: run.projectId, cardId: run.cardId, executionId: run.id, state: run.state });
    let context;
    try {
      context = findCard(run.projectId, run.cardId);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (context && syncCard) {
      const projects = readProjects();
      const card = projects.find(p => p.id === run.projectId).cards.find(c => c.id === run.cardId);
      card.status = CARD_STATUS[run.state];
      card.updatedAt = run.updatedAt;
      card.updatedBy = actor ? { id: actor.id, name: actor.name } : null;
      // La discussion ne reçoit que les échanges entre l’agent et les personnes (questions, réponses).
      // L’activité de l’agent (avancement, résultat, contrôles, fusion, interruption) reste dans
      // l’exécution, affichée par le bandeau « Exécution IA » de la carte.
      if (['question', 'answer'].includes(action) || (action === 'checks' && run.state === 'waiting'))
        questionComments(card, run);
      writeProjects(projects, run.updatedAt);
    }
    audit(actor, `work.${action}`, {
      projectId: run.projectId,
      cardId: run.cardId,
      projectName: context?.project.name,
      cardTitle: context?.card.title,
      executionId: run.id,
      state: run.state,
      recipientIds: context ? recipients(context.card, actor, [run.requestedBy.id]) : [],
    });
    return run;
  };
  const expire = () => {
    for (const row of rows("state = 'running' AND lease_expires <= ?", Date.now())) {
      const run = transition(unpack(row), 'expire');
      run.interruption = 'L’agent ne répond plus. La réservation a expiré.';
      save(run, null, 'interrupted');
    }
  };
  const scoped = (projectId, cardId, id) => {
    findCard(projectId, cardId);
    const row = db
      .prepare('SELECT * FROM executions WHERE id=? AND project_id=? AND card_id=?')
      .get(id, projectId, cardId);
    if (!row) fail(404, 'execution_not_found', 'Exécution inexistante dans cette carte.');
    return row;
  };
  const checkVersion = (run, version) => {
    if (!Number.isSafeInteger(version) || version !== run.version)
      fail(409, 'work_conflict', 'L’exécution a changé. Actualisez avant de réessayer.');
  };
  const checkAgent = (agent, projectId) => {
    const row = db.prepare('SELECT * FROM agents WHERE id=? AND active=1').get(agent.id);
    if (!row || !JSON.parse(row.projects).includes(projectId))
      fail(403, 'agent_scope', 'Projet non autorisé pour cet agent.');
  };
  const checkSource = run => {
    const { card } = findCard(run.projectId, run.cardId);
    if (source(card) !== run.source)
      fail(409, 'request_changed', 'La demande a changé. Préparez une nouvelle exécution.');
  };
  // Profil figé dans l’exécution, ou profil par défaut pour une exécution antérieure aux profils.
  const runProfile = run => run.executionProfile || defaultExecutionProfile();
  const lastPullRequest = run => run.submissions.at(-1)?.pullRequest;
  // Approbation d’un responsable avant fusion : exigée par le projet, ou parce que la PR modifie
  // les contrôles qui l’autorisent (workflows GitHub, scripts ou configuration des tests).
  const approvalNeeded = (run, projectRequired = requiresApproval(run.projectId)) =>
    projectRequired || !!run.submissions.at(-1)?.reviewRequired?.length;
  return {
    rows,
    unpack,
    byId,
    boundExecution,
    compact,
    questionComments,
    save,
    expire,
    scoped,
    checkVersion,
    checkAgent,
    checkSource,
    runProfile,
    lastPullRequest,
    approvalNeeded,
  };
}
