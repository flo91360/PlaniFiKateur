import { ApiError } from './clients.mjs';
import { defaultExecutionProfile } from './execution-profile.mjs';
import { legacyPublicationQuestion } from './legacy-publication.mjs';

// Suivi des tâches connues du worker : état sur le site, PR et fusion automatique. Une erreur sur
// une tâche ne bloque pas les autres ; `reconcile` renvoie la tâche à reprendre, ou null.
// `knownProjects()` donne les projets découverts au dernier tour.
export function createFollowUp({
  site,
  github,
  state,
  log,
  clean,
  allowed,
  auto,
  knownProjects,
  profileOf,
  releaseCheckout,
}) {
  // Message de suivi journalisé une seule fois tant que la situation ne change pas.
  async function note(job, reason, message) {
    if (job.mergeReason === reason) return;
    job.mergeReason = reason;
    await state.put(job);
    log(message);
  }

  // Suivi d’une tâche connue : état sur le site, PR et fusion. Renvoie la tâche à reprendre, ou null.
  async function reconcileJob(job, signal) {
    if (['done', 'cancelled'].includes(job.phase)) {
      await releaseCheckout(job);
      return null;
    }
    if (auto && !knownProjects().has(job.projectId)) {
      if (job.phase !== 'unauthorized') {
        job.phase = 'unauthorized';
        await state.put(job);
        log(`Exécution ${job.id} suspendue localement : projet non autorisé ou supprimé.`);
      }
      return null;
    }
    let history;
    try {
      history = await site.history(job, signal);
    } catch (error) {
      // Site injoignable ou clé refusée : toutes les tâches sont concernées, le tour s’arrête.
      if (!(error instanceof ApiError) || error.status !== 404 || error.code !== 'card_not_found')
        throw Object.assign(error, { siteError: true });
      job.phase = 'cancelled';
      await state.put(job);
      log(`Exécution ${job.id} archivée localement : carte absente de son projet.`);
      return null;
    }
    const run = history.find(r => r.id === job.id);
    if (!run) {
      job.phase = 'cancelled';
      await state.put(job);
      log(`Exécution ${job.id} archivée localement : exécution absente de la carte.`);
      return null;
    }
    if (allowed(run) && legacyPublicationQuestion(run)) {
      const pr = await github.pull(run.repository, run.submissions.at(-1).pullRequest.number, signal);
      if (
        pr.state === 'open' &&
        pr.head.ref === job.branch &&
        pr.head.repo?.full_name?.toLowerCase() === run.repository.toLowerCase() &&
        pr.base?.ref === (run.executionProfile?.branch || 'main')
      ) {
        log(`Exécution ${run.id} : reprise automatique de la publication interrompue.`);
        return { ...run, publicationRecovery: true };
      }
    }
    if (['done', 'cancelled', 'waiting', 'review'].includes(run.state)) {
      if (job.phase !== run.state) {
        job.phase = run.state;
        await state.put(job);
        log(`Exécution ${job.id} : ${run.state}.`);
      }
      await releaseCheckout(job);
      return null;
    }
    // Interrompue ou remise en file sur le site (bail expiré, worker arrêté avant de le signaler) :
    // la tâche n’est plus « running » localement, sinon la mise à jour du worker se croirait occupée.
    if (['interrupted', 'ready'].includes(run.state) && job.phase === 'running') {
      job.phase = run.state;
      await state.put(job);
      log(`Exécution ${job.id} : ${run.state} sur le site.`);
    }
    if (run.state !== 'merging' || !allowed(run)) return null;
    const submission = run.submissions.at(-1)?.pullRequest;
    const profile = profileOf(job.executionProfile || run.executionProfile || defaultExecutionProfile());
    if (!submission) return null;
    const pr = await github.pull(run.repository, submission.number, signal);
    if (pr.state !== 'open') {
      if (!pr.merged)
        return {
          ...run,
          workerQuestion: 'La PR a été fermée sans fusion. Souhaitez-vous reprendre cette tâche ou l’annuler ?',
        };
      // A merged PR is only completed by the signed GitHub webhook or the site's own GitHub check.
      await note(job, 'merged', `Exécution ${run.id} : PR fusionnée, confirmation du site attendue.`);
      return null;
    }
    if (pr.head.sha !== submission.headSha || pr.head.repo?.full_name?.toLowerCase() !== run.repository.toLowerCase()) {
      await note(
        job,
        'head_changed',
        `Exécution ${run.id} : le commit de la PR a changé hors du worker ; elle ne sera pas fusionnée automatiquement.`,
      );
      return null;
    }
    if (await github.behindMain(run.repository, pr.head.sha, signal, profile.branch)) return run;
    if (!pr.labels.some(l => l.name === 'planifikateur-agent')) await github.label(run.repository, pr.number, signal);
    let merged;
    try {
      merged = await github.mergeWhenReady(
        run.repository,
        pr,
        data => site.mergeEligible(data, signal),
        signal,
        profile,
      );
    } catch (error) {
      const message = clean(error.message);
      if (job.mergeReason !== message) {
        job.mergeReason = message;
        await state.put(job);
        log(`Exécution ${run.id} : fusion automatique bloquée : ${message}. Le worker réessaiera sans relancer Codex.`);
      }
      return null;
    }
    if (merged.merged) {
      log(
        `Exécution ${run.id} : PR #${pr.number} fusionnée après réussite des tests GitHub, notification du site attendue.`,
      );
    } else if (job.mergeReason !== merged.reason) {
      job.mergeReason = merged.reason;
      await state.put(job);
      log(`Exécution ${run.id} : fusion en attente (${merged.reason}).`);
    }
    return null;
  }

  // Une erreur sur une tâche (dépôt renommé, PR inaccessible…) ne bloque pas les autres : la tâche
  // est réessayée plus tard, avec un délai croissant, et l’erreur n’est journalisée qu’une fois.
  async function reconcile(signal) {
    for (const job of await state.all()) {
      if (job.followUp?.retryAfter > Date.now()) continue;
      try {
        const candidate = await reconcileJob(job, signal);
        if (job.followUp) {
          delete job.followUp;
          await state.put(job);
          log(`Exécution ${job.id} : suivi rétabli.`);
        }
        if (candidate) return candidate;
      } catch (error) {
        if (signal?.aborted || error.siteError) throw error;
        const message = clean(error.message);
        const failures = (job.followUp?.failures || 0) + 1;
        const minutes = Math.min(30, 2 ** (failures - 1));
        if (job.followUp?.error !== message)
          log(
            `Exécution ${job.id} : suivi impossible (${message}). Nouvelle tentative dans ${minutes} min ; les autres tâches continuent.`,
          );
        job.followUp = { error: message, failures, retryAfter: Date.now() + minutes * 60000 };
        await state.put(job);
      }
    }
    return null;
  }

  return { reconcile };
}
