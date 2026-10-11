import { mergeAgentPullRequest } from './merge.mjs';

export class ApiError extends Error {
  constructor(status, code) { super(`API : ${status} ${code}`); this.status = status; this.code = code; }
}

export function createSiteClient({ origin, token }, transport = fetch) {
  const request = async (path, data, signal) => {
    const response = await transport(new URL(`/api/v1/${path}`, origin), {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    if (!response.ok) throw new ApiError(response.status, body.error?.code || 'api_error');
    return body.data;
  };
  const path = run => `projects/${run.projectId}/cards/${run.cardId}/work`;
  return {
    mergeEligible: async ({ repository, number, sha }, signal) => (await request(`github/merge-eligibility?${new URLSearchParams({ repository, number, sha })}`, undefined, signal)).eligible === true,
    queue: (projectId, signal) => request(`projects/${projectId}/work`, undefined, signal),
    history: (run, signal) => request(path(run), undefined, signal),
    action: (run, action, data = {}, signal) => request(`${path(run)}/${run.id}/${action}`, { version: run.version, ...(run.leaseToken ? { leaseToken: run.leaseToken } : {}), ...data }, signal),
  };
}

export function createGithubClient(token, transport = fetch) {
  const request = async (path, method = 'GET', data, signal) => {
    const response = await transport(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub : ${method} refusé (${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
  const pull = (repo, number, signal) => request(`/repos/${repo}/pulls/${number}`, 'GET', undefined, signal);
  return {
    request, pull,
    async mergeWhenReady(repo, pr, eligible, signal) {
      const query = new URLSearchParams({ branch: pr.head.ref, event: 'pull_request', head_sha: pr.head.sha, per_page: '100' });
      const latestRun = async () => {
        const { workflow_runs: runs } = await request(`/repos/${repo}/actions/workflows/ci.yml/runs?${query}`, 'GET', undefined, signal);
        return runs.filter(run => run.head_sha === pr.head.sha && run.head_branch === pr.head.ref && run.event === 'pull_request')
          .sort((a, b) => b.id - a.id)[0];
      };
      const latest = await latestRun();
      if (!latest || latest.status !== 'completed') return { merged: false, reason: 'tests_pending' };
      if (latest.conclusion !== 'success') return { merged: false, reason: 'tests_not_successful' };
      return mergeAgentPullRequest({ repository: repo, runId: latest.id, request: (path, method, data) => request(path, method, data, signal), eligible: async data => {
        if (data.number !== pr.number || data.sha !== pr.head.sha) return false;
        const current = await latestRun();
        return current?.id === latest.id && current.run_attempt === latest.run_attempt && current.status === 'completed' && current.conclusion === 'success' && await eligible(data);
      } });
    },
    async ensurePullRequest(repo, branch, title, body, signal) {
      const pulls = await request(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=main`, 'GET', undefined, signal);
      if (pulls.length > 1) throw new Error('Plusieurs PR pour cette branche.');
      const pr = pulls[0] || await request(`/repos/${repo}/pulls`, 'POST', { title, body, head: branch, base: 'main' }, signal);
      if (pr.draft || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || pr.base?.ref !== 'main') throw new Error('La PR ne correspond pas à la livraison attendue.');
      return pr;
    },
    label: (repo, number, signal) => request(`/repos/${repo}/issues/${number}/labels`, 'POST', { labels: ['planifikateur-agent'] }, signal),
    unlabel: (repo, number, signal) => request(`/repos/${repo}/issues/${number}/labels/planifikateur-agent`, 'DELETE', undefined, signal),
    async behindMain(repo, headSha, signal) {
      const branch = await request(`/repos/${repo}/branches/main`, 'GET', undefined, signal);
      const comparison = await request(`/repos/${repo}/compare/${branch.commit.sha}...${headSha}`, 'GET', undefined, signal);
      return !['ahead', 'identical'].includes(comparison.status);
    },
  };
}
