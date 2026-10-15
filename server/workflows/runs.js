import { randomUUID } from 'node:crypto';
import { fail } from '../http.js';
import { CARD_STATUS, canTransition, isTerminal, legacyPublicationQuestion, transition } from '../execution-states.js';
import { OPEN, source, text } from './core.js';
import { usageSummary } from './usage.js';

// Cycle de vie des exécutions côté personnes : préparation, file de l’agent, décisions humaines,
// vues (carte, badges du tableau, « À traiter ») et cohérence avec les modifications du tableau.
export function createRuns(
  db,
  { transaction, findCard, readProjects, writeProjects, canLaunch, requiresApproval },
  {
    rows,
    unpack,
    compact,
    questionComments,
    save,
    expire,
    scoped,
    checkVersion,
    checkAgent,
    checkSource,
    approvalNeeded,
  },
  { githubProject, executionProfile },
) {
  // PR en cours de fusion qui attend encore l’approbation d’un responsable.
  const awaitingApproval = (run, required) =>
    run.state === 'merging' &&
    approvalNeeded(run, required) &&
    run.approval?.headSha !== run.submissions.at(-1)?.pullRequest?.headSha;
  const prepare = (projectId, cardId, data, actor) => {
    const { card } = findCard(projectId, cardId);
    if (db.prepare(`SELECT id FROM executions WHERE card_id=? AND ${OPEN}`).get(cardId))
      fail(409, 'active_execution', 'Une exécution existe déjà. Annulez-la avant de préparer une nouvelle demande.');
    if (data?.delivery !== undefined && data.delivery !== 'github')
      fail(400, 'invalid_delivery', 'La livraison se fait par fusion automatique GitHub.');
    const repository = githubProject(projectId);
    if (!repository) fail(400, 'github_not_configured', 'Configurez le dépôt GitHub du projet.');
    const run = {
      delivery: 'github',
      repository,
      executionProfile: executionProfile(projectId),
      id: randomUUID(),
      projectId,
      cardId,
      state: 'ready',
      version: 0,
      requestSource: 'card',
      objective: text(card.description, 'Description de la carte'),
      criteria: '',
      context: '',
      requestedBy: { id: actor.id, name: actor.name },
      createdAt: new Date().toISOString(),
      source: source(card),
      cardSnapshot: card,
      agent: null,
      updates: [],
      exchanges: [],
      submissions: [],
    };
    db.prepare('INSERT INTO executions(id,project_id,card_id,state,version,data) VALUES(?,?,?,?,0,?)').run(
      run.id,
      projectId,
      cardId,
      run.state,
      JSON.stringify(run),
    );
    return save(run, actor, 'prepared');
  };
  // Cartes « Prêtes à démarrer » sans exécution : préparées pour l’agent si un responsable les a
  // rendues prêtes (défense en profondeur, la règle est aussi vérifiée à la modification).
  const prepareReadyCards = (project, projectId) => {
    const activeCards = new Set(
      db
        .prepare(`SELECT card_id FROM executions WHERE ${OPEN}`)
        .all()
        .map(row => row.card_id),
    );
    for (const card of project?.cards || []) {
      if (card.status !== 'ready' || !card.description.trim() || activeCards.has(card.id)) continue;
      const readiness = db
        .prepare(
          "SELECT actor_id,actor_name FROM activity WHERE card_id=? AND action='card.status_changed' AND json_extract(payload,'$.details.to')='ready' ORDER BY id DESC LIMIT 1",
        )
        .get(card.id);
      const actor = readiness?.actor_id
        ? { id: readiness.actor_id, name: readiness.actor_name }
        : card.updatedBy || card.createdBy || { id: 'system', name: 'Système' };
      if (!canLaunch(actor, projectId)) continue;
      prepare(projectId, card.id, {}, actor);
    }
  };
  // Décisions humaines : chaque action enregistre ce qu’elle porte avant la transition.
  const decisions = {
    cancel(run, data) {
      run.cancellation = text(data?.message, 'Motif', 10000);
    },
    answer(run, data, decidedBy) {
      const answer = text(data?.message, 'Réponse', 10000);
      run.exchanges.at(-1).answer = { text: answer, actor: decidedBy, date: new Date().toISOString() };
      // Une réponse humaine redonne leurs cycles de correction aux contrôles GitHub.
      run.ciFailures = 0;
    },
    accept(run, data, decidedBy) {
      checkSource(run);
      run.submissions.at(-1).decision = { accepted: true, actor: decidedBy, date: new Date().toISOString() };
    },
    approve(run, data, decidedBy) {
      const headSha = run.submissions.at(-1)?.pullRequest?.headSha;
      if (!headSha) fail(409, 'invalid_transition', 'Aucune PR à approuver.');
      checkSource(run);
      run.approval = { headSha, actor: decidedBy, date: new Date().toISOString() };
    },
    reject(run, data, decidedBy) {
      run.submissions.at(-1).decision = {
        accepted: false,
        message: text(data?.message, 'Corrections demandées', 10000),
        actor: decidedBy,
        date: new Date().toISOString(),
      };
    },
  };
  // Mise à niveau : les questions déjà posées rejoignent la discussion de leur carte.
  transaction(() => {
    const projects = readProjects();
    let changed = false;
    const agentIds = new Set(
      db
        .prepare('SELECT id FROM agents')
        .all()
        .map(agent => agent.id),
    );
    for (const card of projects.flatMap(project => project.cards))
      for (const comment of card.comments) {
        if (!comment.authorKind && agentIds.has(comment.authorId)) {
          comment.authorKind = 'agent';
          changed = true;
        }
      }
    for (const row of rows("json_array_length(data, '$.exchanges') > 0")) {
      const run = unpack(row),
        card = projects.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
      if (card) changed = questionComments(card, run, false) || changed;
    }
    if (changed) writeProjects(projects);
    // Exécutions terminées avant la 0.1.26 : retirer le contenu des pièces jointes de leur copie de carte.
    for (const row of rows("state IN ('done','cancelled') AND data LIKE '%\"data\":%'")) {
      const run = JSON.parse(row.data),
        snapshot = run.cardSnapshot;
      if (compact(run).cardSnapshot !== snapshot)
        db.prepare('UPDATE executions SET data = ? WHERE id = ?').run(JSON.stringify(run), row.id);
    }
  });
  return {
    list(projectId, cardId, agent = null) {
      return transaction(() => {
        if (agent) checkAgent(agent, projectId);
        findCard(projectId, cardId);
        expire();
        const approvalRequired = requiresApproval(projectId);
        return rows('project_id = ? AND card_id = ?', projectId, cardId)
          .map(unpack)
          .map(run => ({ ...run, approvalRequired: approvalNeeded(run, approvalRequired), usage: usageSummary(run) }));
      });
    },
    // État de l’agent pour chaque carte d’un projet ayant une exécution en cours, affiché en badge
    // sur le tableau : { cardId: { state, awaitingApproval, checks } }.
    projectStatus(projectId) {
      const required = requiresApproval(projectId);
      const status = {};
      for (const run of rows(`project_id = ? AND ${OPEN}`, projectId).map(unpack)) {
        if (status[run.cardId] || legacyPublicationQuestion(run)) continue;
        status[run.cardId] = {
          state: run.state,
          awaitingApproval: awaitingApproval(run, required),
          checks: run.githubChecks?.conclusion || null,
        };
      }
      return status;
    },
    // Exécutions qui attendent une personne : question de l’agent, résultat sans PR à valider, ou
    // PR à approuver. La question technique d’un ancien worker se résout seule et n’est pas listée.
    attention() {
      const projects = readProjects();
      return rows("state IN ('waiting','review','merging')")
        .map(unpack)
        .flatMap(run => {
          const project = projects.find(p => p.id === run.projectId);
          const card = project?.cards.find(c => c.id === run.cardId);
          if (!card || legacyPublicationQuestion(run)) return [];
          if (run.state === 'merging' && !awaitingApproval(run)) return [];
          const message = run.state === 'waiting' ? run.exchanges.at(-1)?.question : run.submissions.at(-1)?.summary;
          return [
            {
              projectId: project.id,
              projectName: project.name,
              cardId: card.id,
              cardTitle: card.title,
              executionId: run.id,
              state: run.state,
              message: (message || '').slice(0, 500),
              since: run.updatedAt,
            },
          ];
        });
    },
    queue(projectId, agent, { autoPrepare = true } = {}) {
      return transaction(() => {
        checkAgent(agent, projectId);
        expire();
        if (autoPrepare && githubProject(projectId))
          prepareReadyCards(
            readProjects().find(p => p.id === projectId),
            projectId,
          );
        return rows("project_id = ? AND state IN ('ready','interrupted')", projectId).map(unpack);
      });
    },
    prepare(projectId, cardId, data, actor) {
      return transaction(() => prepare(projectId, cardId, data, actor));
    },
    human(projectId, cardId, id, action, data, actor) {
      return transaction(() => {
        const run = unpack(scoped(projectId, cardId, id));
        checkVersion(run, data?.version);
        if (isTerminal(run.state)) fail(409, 'invalid_transition', 'Cette exécution est terminée.');
        if (!canTransition(run.state, action))
          fail(409, 'invalid_transition', 'Cette action n’est pas disponible à cette étape.');
        decisions[action]?.(run, data, { id: actor.id, name: actor.name });
        transition(run, action);
        return save(run, actor, action);
      });
    },
    // Supprime les exécutions terminées dont la dernière activité précède `before` (date ISO),
    // avec le lien de leur PR. Renvoie le nombre d’exécutions supprimées.
    purge(before) {
      const old = db
        .prepare(
          "SELECT id FROM executions WHERE state IN ('done','cancelled') AND COALESCE(json_extract(data, '$.updatedAt'), json_extract(data, '$.createdAt'), '') < ?",
        )
        .all(before);
      for (const { id } of old) {
        db.prepare('DELETE FROM github_pr_bindings WHERE execution_id = ?').run(id);
        db.prepare('DELETE FROM executions WHERE id = ?').run(id);
      }
      return old.length;
    },
    // Modification du tableau (`before` → `after`) : annule les exécutions dont la demande a changé,
    // refuse un statut piloté par l’agent, et prend une réponse en commentaire pour la question posée.
    reconcile(before, after, actor, restore) {
      for (const row of rows(OPEN))
        if (!isTerminal(row.state)) {
          const run = unpack(row),
            card = after.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
          if (restore || !card || source(card) !== run.source) {
            transition(run, 'cancel');
            run.cancellation = restore
              ? 'Restauration du contenu : préparez une nouvelle demande.'
              : 'Carte supprimée, déplacée ou demande modifiée : préparez une nouvelle exécution.';
            save(run, actor, 'cancel', { syncCard: false });
            if (card) card.status = CARD_STATUS[run.state];
          } else if (run.state === 'ready' && card.status !== 'ready') {
            transition(run, 'cancel');
            run.cancellation = 'La carte a été retirée de la file par son changement de statut.';
            save(run, actor, 'cancel', { syncCard: false });
          } else if (card.status !== CARD_STATUS[run.state])
            fail(409, 'managed_status', 'Le statut de cette carte est piloté par son exécution IA.');
          if (run.state === 'waiting' && card && actor && !restore) {
            const previous = before.find(p => p.id === run.projectId)?.cards.find(c => c.id === run.cardId);
            const oldIds = new Set(previous?.comments.map(comment => comment.id));
            const reply = card.comments.find(comment => !oldIds.has(comment.id) && comment.text.trim());
            if (reply) {
              run.exchanges.at(-1).answer = {
                text: reply.text.trim(),
                actor: { id: actor.id, name: actor.name },
                date: new Date().toISOString(),
                commentId: reply.id,
              };
              transition(run, 'answer');
              save(run, actor, 'answer', { syncCard: false });
              card.status = CARD_STATUS[run.state];
            }
          }
        }
    },
  };
}
