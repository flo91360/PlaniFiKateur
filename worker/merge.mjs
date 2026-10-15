import { defaultExecutionProfile, installedProfile } from './execution-profile.mjs';
// Trusted worker code shared with the GitHub Actions merger.
export const requiredJobs = ['Tests serveur', 'Tests navigateur'];

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
  const comparison = await request(`${root}/compare/${branch.commit.sha}...${pr.head.sha}`);
  if (!['ahead', 'identical'].includes(comparison.status)) return { merged: false, reason: 'update_branch_required' };
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
