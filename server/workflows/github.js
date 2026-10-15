import { transition } from '../execution-states.js';
import { GITHUB_ACTOR, MAX_CI_FAILURES } from './core.js';

const CONCLUSIONS = ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale'];

// Suite d’une PR de l’agent sur GitHub : fusion autorisée, résultat des contrôles, fusion
// constatée (webhooks, ou vérification par server/github-sync.js si un webhook s’est perdu).
export function createGithub(
  { transaction, requiresApproval },
  { rows, unpack, byId, boundExecution, save, checkAgent, checkSource, runProfile, lastPullRequest },
) {
  // Applique une conclusion de contrôles à une exécution en attente de fusion.
  const applyChecks = (run, conclusion) => {
    const date = new Date().toISOString();
    // Labeling a newly opened PR starts another CI run and supersedes the
    // first one. A cancelled run must not send the task back to Codex.
    if (conclusion === 'cancelled') {
      run.updates.push({
        text: 'Une exécution des contrôles GitHub a été annulée. La tâche reste en attente des tests et de la fusion.',
        date,
      });
    } else if (conclusion !== 'success' && conclusion !== 'failure') {
      // Délai dépassé, approbation requise, contrôle ignoré… : le code n’est pas en cause, le
      // modèle n’a rien à corriger. Les contrôles doivent être relancés depuis GitHub.
      run.updates.push({
        text: `Les contrôles GitHub se sont terminés sans verdict (${conclusion}). Relancez-les depuis GitHub : la tâche reste en attente des tests et de la fusion.`,
        date,
      });
    } else if (conclusion === 'failure') {
      run.ciFailures = (run.ciFailures || 0) + 1;
      if (run.ciFailures >= MAX_CI_FAILURES) {
        // Les corrections automatiques tournent en rond : une personne décide de la suite.
        transition(run, 'checksStalled');
        run.exchanges.push({
          question: `Les contrôles GitHub ont échoué ${run.ciFailures} fois de suite malgré les corrections de l’agent. Consultez les journaux de la PR, puis répondez pour relancer une correction (en précisant si possible la cause), ou annulez l’exécution.`,
          date,
          answer: null,
        });
      } else {
        transition(run, 'checksFailed');
        run.updates.push({
          text: 'Les contrôles GitHub ont échoué. Le worker reprend la tâche avec leurs journaux pour corriger puis soumettre à nouveau la PR.',
          date,
        });
      }
    }
  };
  return {
    mergeEligible(repository, number, headSha, agent) {
      const id = boundExecution(repository, number);
      if (!id) return { eligible: false };
      const run = byId(id);
      checkAgent(agent, run.projectId);
      if (run.state !== 'merging' || run.agent?.id !== agent.id || lastPullRequest(run)?.headSha !== headSha)
        return { eligible: false };
      checkSource(run);
      // Validation humaine exigée par le projet : seule la PR approuvée, à ce commit précis, fusionne.
      if (requiresApproval(run.projectId) && run.approval?.headSha !== headSha)
        return { eligible: false, reason: 'approval_required' };
      return { eligible: true };
    },
    githubChecks(event) {
      return transaction(() => {
        const check = event?.workflow_run,
          repository = event?.repository?.full_name;
        if (
          event?.action !== 'completed' ||
          check?.event !== 'pull_request' ||
          typeof repository !== 'string' ||
          check.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
          check.status !== 'completed' ||
          !Number.isSafeInteger(check.id) ||
          !Number.isInteger(check.run_attempt) ||
          !CONCLUSIONS.includes(check.conclusion)
        )
          return { updated: false };
        let updated = false;
        for (const row of rows("state = 'merging'")) {
          const run = unpack(row),
            pr = lastPullRequest(run),
            { workflow } = runProfile(run);
          if (
            check.name !== workflow.name ||
            (check.path && check.path.split('@')[0] !== `.github/workflows/${workflow.file}`)
          )
            continue;
          if (pr?.repository !== repository.toLowerCase() || pr.headSha !== check.head_sha) continue;
          if (
            run.githubChecks?.runId > check.id ||
            (run.githubChecks?.runId === check.id && run.githubChecks?.attempt >= check.run_attempt)
          )
            continue;
          run.githubChecks = {
            runId: check.id,
            attempt: check.run_attempt,
            conclusion: check.conclusion,
            url: check.html_url,
          };
          applyChecks(run, check.conclusion);
          save(run, GITHUB_ACTOR, 'checks');
          updated = true;
        }
        return { updated };
      });
    },
    // PR en attente de tests ou de fusion depuis au moins `quietMs` : le serveur vérifie lui-même
    // leur état auprès de GitHub si un webhook s’est perdu (server/github-sync.js).
    mergingPullRequests({ quietMs = 0, now = Date.now() } = {}) {
      return rows("state = 'merging'")
        .map(unpack)
        .filter(run => Date.parse(run.updatedAt || run.createdAt || 0) <= now - quietMs)
        .flatMap(run => {
          const pr = lastPullRequest(run);
          if (!pr?.repository || !pr.number || !pr.headSha) return [];
          return [
            {
              executionId: run.id,
              repository: pr.repository,
              number: pr.number,
              headSha: pr.headSha,
              workflowFile: runProfile(run).workflow.file,
            },
          ];
        });
    },
    githubMerged(event) {
      return transaction(() => {
        const pr = event?.pull_request,
          repository = event?.repository?.full_name;
        if (
          event?.action !== 'closed' ||
          pr?.merged !== true ||
          typeof repository !== 'string' ||
          !Number.isSafeInteger(pr.number) ||
          pr.number < 1 ||
          pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
          !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || '') ||
          !Number.isFinite(Date.parse(pr.merged_at))
        )
          return { updated: false };
        const id = boundExecution(repository, pr.number);
        if (!id) return { updated: false };
        const run = byId(id),
          submission = run.submissions.at(-1);
        if (pr.base?.ref !== (run.executionProfile?.branch || 'main')) return { updated: false };
        if (
          run.state !== 'merging' ||
          submission?.pullRequest?.headSha !== pr.head?.sha ||
          Date.parse(pr.merged_at) + 1000 < Date.parse(submission.date)
        )
          return { updated: false };
        checkSource(run);
        transition(run, 'merged');
        submission.pullRequest.mergeSha = pr.merge_commit_sha;
        submission.decision = { accepted: true, automatic: true, actor: GITHUB_ACTOR, date: pr.merged_at };
        save(run, GITHUB_ACTOR, 'merged');
        return { updated: true };
      });
    },
  };
}
