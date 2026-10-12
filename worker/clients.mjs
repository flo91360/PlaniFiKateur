import { mergeAgentPullRequest } from './merge.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultExecutionProfile, validateExecutionProfile } from './execution-profile.mjs';

export class PublicationPendingError extends Error {
  constructor() { super('GitHub n’a pas encore confirmé le commit testé sur la PR. Nouvelle tentative automatique.'); }
}

export class ApiError extends Error {
  constructor(status, code) { super(`API : ${status} ${code}`); this.status = status; this.code = code; }
}

// Only known diagnostics are printable; never include response bodies or URLs.
export function connectionDiagnostic(error) {
  if (error instanceof ApiError) return `API : ${error.status} ${/^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'api_error'}`;
  if (/^GitHub : (GET|POST|PUT|PATCH|DELETE) refusé \(\d{3}\)\.$/.test(error?.message)) return error.message;
  const code = error?.cause?.code || error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return `Réseau : ${code}`;
  if (error?.name === 'TimeoutError') return 'Délai de connexion dépassé';
  if (error?.name === 'SyntaxError') return 'Réponse du serveur invalide';
  return 'Connexion indisponible';
}

export function temporaryConnectionError(error) {
  return error instanceof ApiError ? error.status === 429 || error.status >= 500 : ['TypeError', 'TimeoutError', 'SyntaxError'].includes(error?.name);
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
    projects: signal => request('agent/projects', undefined, signal),
    diagnostic: (projectId, data, signal) => request(`agent/projects/${projectId}/diagnostic`, data, signal),
    mergeEligible: async ({ repository, number, sha }, signal) => (await request(`github/merge-eligibility?${new URLSearchParams({ repository, number, sha })}`, undefined, signal)).eligible === true,
    queue: (projectId, signal) => request(`projects/${projectId}/work`, undefined, signal),
    history: (run, signal) => request(path(run), undefined, signal),
    action: (run, action, data = {}, signal) => request(`${path(run)}/${run.id}/${action}`, { version: run.version, ...(run.leaseToken ? { leaseToken: run.leaseToken } : {}), ...(['claim', 'revise'].includes(action) ? { aiSettingsSupported: true, executionProfilesSupported: true, engines: ['codex', 'claude-code'] } : {}), ...data }, signal),
  };
}

export function createGithubClient(token, transport = fetch, wait = delay) {
  const request = async (path, method = 'GET', data, signal) => {
    const response = await transport(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub : ${method} refusé (${response.status}).`), { status: response.status });
    return response.status === 204 ? null : response.json();
  };
  const pull = (repo, number, signal) => request(`/repos/${repo}/pulls/${number}`, 'GET', undefined, signal);
  return {
    request, pull,
    async mergeWhenReady(repo, pr, eligible, signal, executionProfile = defaultExecutionProfile()) {
      const profile = validateExecutionProfile(executionProfile);
      const query = new URLSearchParams({ branch: pr.head.ref, event: 'pull_request', head_sha: pr.head.sha, per_page: '100' });
      const latestRun = async () => {
        const { workflow_runs: runs } = await request(`/repos/${repo}/actions/workflows/${profile.workflow.file}/runs?${query}`, 'GET', undefined, signal);
        return runs.filter(run => run.head_sha === pr.head.sha && run.head_branch === pr.head.ref && run.event === 'pull_request')
          .sort((a, b) => b.id - a.id)[0];
      };
      const latest = await latestRun();
      if (!latest || latest.status !== 'completed') return { merged: false, reason: 'tests_pending' };
      if (latest.conclusion !== 'success') return { merged: false, reason: 'tests_not_successful' };
      return mergeAgentPullRequest({ repository: repo, runId: latest.id, executionProfile: profile, request: (path, method, data) => request(path, method, data, signal), eligible: async data => {
        if (data.number !== pr.number || data.sha !== pr.head.sha) return false;
        const current = await latestRun();
        return current?.id === latest.id && current.run_attempt === latest.run_attempt && current.status === 'completed' && current.conclusion === 'success' && await eligible(data);
      } });
    },
    async ensurePullRequest(repo, branch, title, body, signal, expectedSha, targetBranch = 'main') {
      const pulls = await request(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(targetBranch)}`, 'GET', undefined, signal);
      if (pulls.length > 1) throw new Error('Plusieurs PR pour cette branche.');
      let pr = pulls[0] || await request(`/repos/${repo}/pulls`, 'POST', { title, body, head: branch, base: targetBranch }, signal);
      if (pr.draft || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || pr.base?.ref !== targetBranch) throw new Error('La PR ne correspond pas à la livraison attendue.');
      if (expectedSha) {
        // The list endpoint can still describe the previous head just after push.
        // Confirm the exact tested commit through the individual PR endpoint.
        const number = pr.number;
        for (let attempt = 0; attempt < 6; attempt++) {
          pr = await pull(repo, number, signal);
          if (pr.number !== number || pr.state !== 'open' || pr.draft || pr.head?.ref !== branch || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || pr.base?.ref !== targetBranch) throw new Error('La PR ne correspond pas à la livraison attendue.');
          if (pr.head.sha === expectedSha) return pr;
          if (attempt < 5) await wait(Math.min(attempt + 1, 5) * 1000, undefined, { signal });
        }
        throw new PublicationPendingError();
      }
      return pr;
    },
    async label(repo, number, signal) {
      const add = () => request(`/repos/${repo}/issues/${number}/labels`, 'POST', { labels: ['planifikateur-agent'] }, signal);
      try { return await add(); } catch (error) { if (error.status !== 422) throw error; }
      try { await request(`/repos/${repo}/labels`, 'POST', { name: 'planifikateur-agent', color: '476b9c', description: 'Livraison automatique depuis PlaniFiKateur' }, signal); }
      catch (error) { if (error.status !== 422) throw error; }
      return add();
    },
    unlabel: (repo, number, signal) => request(`/repos/${repo}/issues/${number}/labels/planifikateur-agent`, 'DELETE', undefined, signal),
    async behindMain(repo, headSha, signal, targetBranch = 'main') {
      const branch = await request(`/repos/${repo}/branches/${encodeURIComponent(targetBranch)}`, 'GET', undefined, signal);
      const comparison = await request(`/repos/${repo}/compare/${branch.commit.sha}...${headSha}`, 'GET', undefined, signal);
      return !['ahead', 'identical'].includes(comparison.status);
    },
  };
}
