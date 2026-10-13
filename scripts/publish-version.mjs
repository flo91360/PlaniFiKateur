import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCommand } from './delivery.mjs';
import { verifyDelivery } from '../worker/delivery.mjs';

export async function publishVersion({ repository, sha, runId, cwd = '.', request, command = gitCommand(cwd) }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !Number.isSafeInteger(Number(runId)) || Number(runId) < 1) throw new Error('Dépôt, commit ou exécution CI invalide.');
  const root = `/repos/${repository}`;
  const run = await request(`${root}/actions/runs/${runId}`);
  const workflow = await request(`${root}/actions/workflows/ci.yml`);
  const valid = current => current.head_sha === sha && current.head_branch === 'main' && current.event === 'push' && current.workflow_id === workflow.id && current.head_repository?.full_name?.toLowerCase() === repository.toLowerCase() && current.status === 'completed' && current.conclusion === 'success';
  if (!valid(run)) throw new Error('La publication exige les tests réussis du commit exact fusionné sur main.');
  const jobs = [];
  for (let page = 1; page <= 100; page++) {
    const data = await request(`${root}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    jobs.push(...data.jobs);
    if (jobs.length >= data.total_count) break;
    if (!data.jobs.length || page === 100) throw new Error('Liste de contrôles CI incomplète.');
  }
  for (const name of ['Tests serveur', 'Tests navigateur']) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success' || matches[0].run_attempt !== run.run_attempt) throw new Error(`Le contrôle ${name} doit réussir pour cette tentative CI.`);
  }
  const recent = await request(`${root}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`);
  if (recent.workflow_runs.some(candidate => candidate.head_sha === sha && candidate.id > run.id)) throw new Error('Une exécution CI plus récente existe pour ce commit.');
  const current = await request(`${root}/actions/runs/${runId}`);
  if (!valid(current) || current.run_attempt !== run.run_attempt) throw new Error('Les contrôles CI ont changé pendant la publication.');
  if (await command(['git', 'rev-parse', 'HEAD']) !== sha) throw new Error('Le checkout ne correspond pas au commit testé.');
  const delivery = await verifyDelivery(cwd, { preset: 'planifikateur', branch: 'main' }, command, `${sha}^1`);
  const tag = `v${delivery.version}`;
  const exists = await command(['git', 'tag', '--list', tag]);
  if (exists) {
    if (await command(['git', 'rev-parse', `${tag}^{commit}`]) !== sha) throw new Error(`Le tag ${tag} existe sur un autre commit ; il ne sera pas déplacé.`);
  } else {
    await command(['git', 'config', 'user.name', 'github-actions[bot]']);
    await command(['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    await command(['git', 'tag', '-a', tag, '-m', `${tag}\n\n${delivery.notes}`, sha]);
  }
  await command(['git', 'push', 'origin', `refs/tags/${tag}`]);
  return tag;
}
export async function main(env = process.env) {
  const request = async path => {
    const response = await fetch(`https://api.github.com${path}`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) throw new Error(`Lecture des contrôles GitHub refusée (${response.status}).`);
    return response.json();
  };
  const tag = await publishVersion({ repository: env.GITHUB_REPOSITORY, sha: env.DELIVERY_SHA, runId: env.TEST_RUN_ID, request });
  console.log(`Tag ${tag} publié sur le commit testé.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
