import { defaultExecutionProfile, installedProfile, targetOnlyPaths } from './execution-profile.mjs';
// Trusted worker code shared with the GitHub Actions merger.
export const requiredJobs = ['Tests serveur', 'Tests navigateur'];

// La PR contient-elle la branche cible ? Les commits de la branche cible qui ne touchent que des
// fichiers qu’elle seule fait évoluer (`ignoredPaths`, comme le CHANGELOG.md recopié par la CI de
// DefilOrdi après chaque Release) ne l’obligent pas à être remise à jour, si la PR ne les modifie
// pas : la fusion donne alors exactement l’arbre testé, plus ces fichiers. Sans cette tolérance,
// chaque commit de journal relançait l’agent sur toutes les PR en attente, dont la CI finissait
// juste après le commit de journal suivant, et aucune ne fusionnait.
export async function targetIncluded(request, root, targetSha, headSha, ignoredPaths = []) {
  const comparison = await request(`${root}/compare/${targetSha}...${headSha}`);
  if (['ahead', 'identical'].includes(comparison.status)) return true;
  if (!ignoredPaths.length || comparison.status !== 'diverged') return false;
  // Listes de fichiers limitées à 300 par GitHub : une liste pleine peut être incomplète.
  const listed = files => Array.isArray(files) && files.length < 300;
  const touches = file => [file.filename, file.previous_filename].some(name => ignoredPaths.includes(name));
  if (!listed(comparison.files) || comparison.files.some(touches)) return false;
  const target = await request(`${root}/compare/${headSha}...${targetSha}`);
  return (
    listed(target.files) &&
    target.files.length > 0 &&
    target.files.every(file =>
      [file.filename, file.previous_filename].filter(Boolean).every(name => ignoredPaths.includes(name)),
    )
  );
}

export async function mergeAgentPullRequest({
  repository,
  runId,
  request,
  eligible,
  log = () => {},
  executionProfile = defaultExecutionProfile(),
}) {
  const profile = installedProfile(executionProfile);
  const requiredJobs = profile.workflow.jobs;
  const root = `/repos/${repository}`;
  const sameRepository = value => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
  const run = await request(`${root}/actions/runs/${runId}`);
  const workflow = await request(`${root}/actions/workflows/${profile.workflow.file}`);
  if (
    run.workflow_id !== workflow.id ||
    run.event !== 'pull_request' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !sameRepository(run.head_repository?.full_name)
  )
    return { merged: false, reason: 'untrusted_run' };
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = await request(`${root}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    if (page >= 100 || !result.jobs.length) throw new Error('Liste de contrôles incomplète.');
  }
  if (
    requiredJobs.some(
      name =>
        jobs.filter(job => job.name === name).length !== 1 ||
        jobs.find(job => job.name === name)?.conclusion !== 'success' ||
        jobs.find(job => job.name === name)?.status !== 'completed',
    )
  )
    return { merged: false, reason: 'required_tests_missing_or_failed' };
  // A later rerun must also be successful; an older successful attempt is insufficient.
  if (run.run_attempt !== jobs[0]?.run_attempt) return { merged: false, reason: 'stale_attempt' };
  const pulls = await request(
    `${root}/pulls?state=open&head=${encodeURIComponent(repository.split('/')[0] + ':' + run.head_branch)}&per_page=100`,
  );
  const candidates = pulls.filter(
    pr =>
      pr.head.sha === run.head_sha &&
      sameRepository(pr.head.repo?.full_name) &&
      pr.base.ref === profile.branch &&
      !pr.draft &&
      pr.labels.some(label => label.name === 'planifikateur-agent'),
  );
  if (candidates.length !== 1) return { merged: false, reason: 'no_unique_agent_pr' };
  const pr = await request(`${root}/pulls/${candidates[0].number}`);
  if (
    pr.state !== 'open' ||
    pr.draft ||
    pr.head.sha !== run.head_sha ||
    !sameRepository(pr.head.repo?.full_name) ||
    pr.base.ref !== profile.branch ||
    !pr.labels.some(l => l.name === 'planifikateur-agent')
  )
    return { merged: false, reason: 'pr_changed' };
  const branch = await request(`${root}/branches/${encodeURIComponent(profile.branch)}`);
  if (!(await targetIncluded(request, root, branch.commit.sha, pr.head.sha, targetOnlyPaths(profile))))
    return { merged: false, reason: 'update_branch_required' };
  const current = await request(`${root}/actions/runs/${runId}`);
  if (current.run_attempt !== run.run_attempt || current.status !== 'completed' || current.conclusion !== 'success')
    return { merged: false, reason: 'rerun_in_progress' };
  if (!(await eligible({ repository, number: pr.number, sha: run.head_sha })))
    return { merged: false, reason: 'task_not_eligible' };
  const merged = await request(`${root}/pulls/${pr.number}/merge`, 'PUT', {
    sha: run.head_sha,
    merge_method: 'squash',
  });
  if (!merged.merged) throw new Error('GitHub n’a pas fusionné la PR.');
  log(`PR #${pr.number} fusionnée après réussite des contrôles requis.`);
  // GitHub keeps the head branch unless the repository deletes it automatically:
  // remove it ourselves, without ever failing a merge that already succeeded.
  if (run.head_branch !== profile.branch)
    try {
      await request(`${root}/git/refs/heads/${run.head_branch.split('/').map(encodeURIComponent).join('/')}`, 'DELETE');
      log(`Branche ${run.head_branch} supprimée après fusion.`);
    } catch (error) {
      if (error.status !== 422) log(`Branche ${run.head_branch} conservée : ${error.message}`);
    }
  return { merged: true, number: pr.number, sha: merged.sha };
}
