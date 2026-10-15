import { randomBytes } from 'node:crypto';
import { pullRequestLink } from '../github.js';
import { fail } from '../http.js';
import { canTransition, legacyPublicationQuestion, transition } from '../execution-states.js';
import { tokenHash } from '../accounts.js';
import { validateWorkspace } from '../../src/lib/workspace.js';
import { validateAi, efforts } from '../../worker/ai-settings.mjs';
import { defaultExecutionProfile } from '../../worker/execution-profile.mjs';
import { LEASE_MS, source, text } from './core.js';
import { validateUsage } from './usage.js';

const DEFAULT_PROFILE = JSON.stringify(defaultExecutionProfile());

// Transitions demandées par le worker. claim et revise réservent l’exécution (jeton de bail) ;
// les autres actions exigent ce bail, encore valide, et la version courante de l’exécution.
export function createAgentActions(
  db,
  { transaction, readProjects, writeProjects, audit, recipients },
  { unpack, save, expire, scoped, checkVersion, checkAgent, checkSource },
  { projectAi, executionProfile },
) {
  // Le worker doit savoir appliquer le moteur, le modèle, l’effort et le profil de l’exécution.
  const requireCapabilities = (run, data, projectId) => {
    if (!run.ai) {
      const ai = run.agent ? { engine: 'codex', model: '' } : projectAi(projectId),
        effort = run.cardSnapshot.aiEffort || '';
      if (
        (ai.engine !== 'codex' || ai.model || effort) &&
        (!data.aiSettingsSupported || !data.engines?.includes(ai.engine))
      )
        fail(
          503,
          'worker_update_required',
          'Mettez à jour le worker pour utiliser les paramètres IA du projet et de la carte.',
        );
      if (!efforts[ai.engine].includes(effort))
        fail(400, 'invalid_effort', 'Cet effort n’est pas pris en charge par le moteur du projet.');
      run.ai = { ...ai, effort };
    }
    if (
      (run.ai.engine !== 'codex' || run.ai.model || run.ai.effort) &&
      (!data.aiSettingsSupported || !data.engines?.includes(run.ai.engine))
    )
      fail(503, 'worker_update_required', 'Ce worker ne prend pas en charge les paramètres IA de cette exécution.');
    if (!run.executionProfile) {
      run.executionProfile = run.agent ? defaultExecutionProfile() : executionProfile(projectId);
      run.legacyExecutionProfile = !!run.agent;
    }
    if (JSON.stringify(run.executionProfile) !== DEFAULT_PROFILE && !data.executionProfilesSupported)
      fail(503, 'worker_update_required', 'Mettez à jour le worker pour utiliser ce profil d’exécution.');
  };
  const reserve = (run, action, data, agent, projectId) => {
    // Une correction (revise) reprend la PR en cours du même agent ; claim prend une tâche libre.
    const available =
      action === 'claim'
        ? canTransition(run.state, 'claim')
        : (run.state === 'merging' || legacyPublicationQuestion(run)) && run.agent?.id === agent.id;
    if (!available) fail(409, 'already_claimed', 'Cette exécution n’est pas disponible.');
    checkVersion(run, data?.version);
    checkSource(run);
    requireCapabilities(run, data, projectId);
    const leaseToken = randomBytes(32).toString('hex');
    transition(run, action);
    run.agent = { id: agent.id, name: agent.name };
    run.interruption = null;
    run.attempts = [...(run.attempts || []), { startedAt: new Date().toISOString() }].slice(-50);
    save(run, agent, 'claimed', { leaseHash: tokenHash(leaseToken), expires: Date.now() + LEASE_MS });
    return { ...run, leaseToken, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
  };
  const checkLinks = links => {
    if (
      !Array.isArray(links) ||
      links.length > 20 ||
      links.some(link => {
        try {
          return !['http:', 'https:'].includes(new URL(link).protocol) || link.length > 2048;
        } catch {
          return true;
        }
      })
    )
      fail(400, 'invalid_links', 'Les livrables doivent être des liens HTTP ou HTTPS (20 maximum).');
  };
  const bindPullRequest = (run, pullRequest) => {
    const binding = db
      .prepare('SELECT execution_id FROM github_pr_bindings WHERE repository=? AND number=?')
      .get(pullRequest.repository, pullRequest.number);
    if (binding && binding.execution_id !== run.id)
      fail(409, 'pr_already_linked', 'Cette PR est déjà liée à une autre exécution.');
    db.prepare('INSERT OR IGNORE INTO github_pr_bindings VALUES(?,?,?)').run(
      pullRequest.repository,
      pullRequest.number,
      run.id,
    );
  };
  // Fichiers générés joints à la carte, sans invalider l’exécution qui les a produits : les
  // modifications humaines suivantes restent protégées.
  const attachFiles = (run, files, agent) => {
    const projects = readProjects();
    const card = projects.find(project => project.id === run.projectId).cards.find(card => card.id === run.cardId);
    card.attachments = [...(card.attachments || []).filter(file => !files.some(next => next.id === file.id)), ...files];
    let clean;
    try {
      clean = validateWorkspace(projects);
    } catch (error) {
      fail(400, 'invalid_files', error.message);
    }
    const delivered = clean.find(project => project.id === run.projectId).cards.find(card => card.id === run.cardId);
    run.source = source(delivered);
    run.cardSnapshot = { ...run.cardSnapshot, attachments: delivered.attachments };
    // Ni révision ni date ici : save() les met à jour juste après avec le statut de la carte.
    writeProjects(clean, undefined, { revision: false });
    audit(
      agent,
      'card.updated',
      {
        projectId: run.projectId,
        cardId: run.cardId,
        cardTitle: card.title,
        executionId: run.id,
        details: { fields: ['attachments'] },
        recipientIds: recipients(card, agent, [run.requestedBy.id]),
      },
      db.prepare('SELECT revision FROM workspace WHERE id=1').get().revision + 1,
    );
  };
  // Consommation du modèle (tokens, coût, durée) rapportée par le worker pour la tentative en cours.
  const recordUsage = (run, usage) => {
    if (usage === undefined) return;
    const attempt = run.attempts?.at(-1);
    if (attempt) attempt.usage = validateUsage(usage);
  };
  const actions = {
    progress(run, data, agent, row) {
      if (data.aiRuntime) {
        let runtime;
        try {
          runtime = validateAi(data.aiRuntime);
        } catch (error) {
          fail(400, 'invalid_ai', error.message);
        }
        if (runtime.engine !== run.ai?.engine)
          fail(409, 'invalid_ai', 'Le moteur ne peut pas changer pendant une exécution.');
        run.aiRuntime = { ...runtime, effort: run.ai.effort };
      }
      if (run.updates.length >= 200) fail(400, 'update_limit', 'Limite de mises à jour atteinte.');
      run.updates.push({ text: text(data?.message, 'Avancement', 10000), date: new Date().toISOString() });
      return save(run, agent, 'progress', { leaseHash: row.lease_hash, expires: Date.now() + LEASE_MS });
    },
    question(run, data) {
      if (run.exchanges.length >= 100) fail(400, 'question_limit', 'Limite de questions atteinte.');
      run.exchanges.push({
        question: text(data?.message, 'Question', 10000),
        date: new Date().toISOString(),
        answer: null,
      });
      transition(run, 'question');
    },
    submit(run, data, agent) {
      if (run.submissions.length >= 50) fail(400, 'submission_limit', 'Limite de soumissions atteinte.');
      checkLinks(data?.links);
      run.githubChecks = null;
      const files = data.files ?? [];
      if (
        !Array.isArray(files) ||
        files.length > 10 ||
        files.some(file => typeof file?.id !== 'string' || !file.id.startsWith(`generated-${run.id}-`))
      )
        fail(400, 'invalid_files', 'Pièces jointes générées invalides.');
      const artifactOnly = data.artifactOnly === true;
      if (artifactOnly && (!files.length || data.pullRequest || run.submissions.some(item => item.pullRequest)))
        fail(
          400,
          'invalid_delivery',
          'Une livraison de fichiers doit contenir un fichier et ne pas remplacer une PR existante.',
        );
      const pullRequest =
        run.delivery === 'github' && !artifactOnly ? pullRequestLink(data.pullRequest, run.repository) : null;
      if (pullRequest) bindPullRequest(run, pullRequest);
      // Contrôles de la fusion modifiés par la PR (relevés par le worker installé) : un responsable
      // devra approuver ce commit avant la fusion automatique.
      const reviewRequired = data.reviewRequired ?? [];
      if (
        !Array.isArray(reviewRequired) ||
        reviewRequired.length > 50 ||
        reviewRequired.some(item => typeof item !== 'string' || !item.trim() || item.length > 300)
      )
        fail(400, 'invalid_review', 'Liste des contrôles modifiés invalide.');
      if (files.length) attachFiles(run, files, agent);
      run.submissions.push({
        summary: text(data.summary, 'Résultat'),
        checks: text(data.checks, 'Vérifications'),
        links: data.links,
        pullRequest,
        files: files.map(({ id, name, size, type }) => ({ id, name, size, type })),
        ...(pullRequest && reviewRequired.length ? { reviewRequired } : {}),
        date: new Date().toISOString(),
        decision: null,
      });
      // Fichier seul : livré dans la carte. PR : fusion après les tests GitHub. Sinon : validation humaine.
      transition(run, 'submit', artifactOnly ? 'done' : pullRequest ? 'merging' : 'review');
    },
    interrupt(run, data) {
      transition(run, 'interrupt');
      run.interruption = text(data?.message, 'Motif', 10000);
    },
  };
  return {
    agentAction(projectId, cardId, id, action, data, agent) {
      // Persist expiration even when the stale worker's action is subsequently rejected.
      transaction(expire);
      return transaction(() => {
        checkAgent(agent, projectId);
        const row = scoped(projectId, cardId, id),
          run = unpack(row);
        if (action === 'claim' || action === 'revise') return reserve(run, action, data, agent, projectId);
        if (
          run.state !== 'running' ||
          run.agent?.id !== agent.id ||
          typeof data?.leaseToken !== 'string' ||
          tokenHash(data.leaseToken) !== row.lease_hash ||
          row.lease_expires <= Date.now()
        )
          fail(409, 'invalid_lease', 'Réservation expirée ou invalide. Reprenez la tâche depuis la file.');
        if (action === 'heartbeat') {
          const expires = Date.now() + LEASE_MS;
          db.prepare('UPDATE executions SET lease_expires=? WHERE id=?').run(expires, id);
          return { ...run, leaseExpiresAt: new Date(expires).toISOString() };
        }
        checkVersion(run, data?.version);
        checkSource(run);
        if (!Object.hasOwn(actions, action)) fail(400, 'invalid_action', 'Action agent inconnue.');
        recordUsage(run, data.usage);
        return actions[action](run, data, agent, row) || save(run, agent, action);
      });
    },
  };
}
