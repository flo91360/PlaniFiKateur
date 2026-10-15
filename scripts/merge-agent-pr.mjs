import { pathToFileURL } from 'node:url';
import { mergeAgentPullRequest } from '../worker/merge.mjs';
export { mergeAgentPullRequest, requiredJobs } from '../worker/merge.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '') ||
      !/^\d+$/.test(process.env.TEST_RUN_ID || '') ||
      !process.env.GH_TOKEN
    )
      throw new Error('Configuration GitHub manquante.');
    const request = async (path, method = 'GET', data) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok)
        throw Object.assign(new Error(`GitHub a refusé ${method} ${path.split('?')[0]} (${response.status}).`), {
          status: response.status,
        });
      return response.status === 204 ? null : response.json();
    };
    const eligible = async ({ repository, number, sha }) => {
      if (!process.env.PLANIFIKATEUR_URL || !process.env.PLANIFIKATEUR_AGENT_TOKEN)
        throw new Error('Secrets PLANIFIKATEUR_URL et PLANIFIKATEUR_AGENT_TOKEN requis.');
      const origin = new URL(process.env.PLANIFIKATEUR_URL);
      if (origin.protocol !== 'https:' || origin.username || origin.password)
        throw new Error('Une origine HTTPS sans identifiants est requise.');
      const url = new URL('/api/v1/github/merge-eligibility', origin);
      url.search = new URLSearchParams({ repository, number, sha });
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.PLANIFIKATEUR_AGENT_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Vérification de la tâche refusée (${response.status}).`);
      return (await response.json()).data?.eligible === true;
    };
    const result = await mergeAgentPullRequest({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.TEST_RUN_ID,
      request,
      eligible,
      log: console.log,
    });
    if (!result.merged) console.log(`Fusion différée : ${result.reason}.`);
  } catch (error) {
    // GitHub exposes annotations through its API even when job logs cannot be
    // downloaded. Escape workflow commands to keep error text literal.
    const message = error.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Fusion automatique bloquée::${message}`);
    process.exitCode = 1;
  }
}
