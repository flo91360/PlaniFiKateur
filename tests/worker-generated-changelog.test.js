import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDelivery, verifyDelivery } from '../worker/delivery.mjs';
import { targetIncluded, mergeAgentPullRequest } from '../worker/merge.mjs';
import { targetOnlyPaths, validateExecutionProfile } from '../worker/execution-profile.mjs';
import { gitCommand } from '../scripts/delivery.mjs';

// DefilOrdi : la CI de main recopie CHANGELOG.md après chaque Release (« Journal des modifications :
// version … [skip ci] »). Le worker ne l’écrit pas, et ce commit ne remet pas les PR en retard.
const profile = validateExecutionProfile({ preset: 'defilordi' });
const details = { runId: 'carte-1', title: 'Klavicoeur', summary: 'Temps réduit.' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-generated-')),
    cwd = join(root, 'source');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  const command = gitCommand(cwd),
    git = (...args) => command(['git', ...args]);
  await git('init', '--bare', '--initial-branch=main', join(root, 'remote.git'));
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'defilordi', version: '0.8.52' }));
  await writeFile(
    join(cwd, 'package-lock.json'),
    JSON.stringify({ name: 'defilordi', version: '0.8.52', packages: { '': { version: '0.8.52' } } }),
  );
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Journal\n\n## 0.8.52 (2026-11-09)\n\n- Licence.\n');
  await git('add', '.');
  await git('commit', '-m', 'Initial');
  await git('remote', 'add', 'origin', join(root, 'remote.git'));
  await git('push', 'origin', 'main');
  await git('switch', '-c', 'planifikateur/carte-1');
  return { cwd, command };
}

test('a generated changelog is never written by the worker and any earlier entry is taken back from main', async t => {
  const f = await fixture(t);
  const main = await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8');
  // Entrée écrite par une version précédente du worker dans la branche de la tâche.
  await writeFile(join(f.cwd, 'CHANGELOG.md'), `${main}\n## 0.8.53 — 2026-11-09\n\n- **Carte** : texte.\n`);
  const result = await prepareDelivery(f.cwd, profile, f.command, details);
  assert.equal(result.version, '0.8.53');
  assert.equal(await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8'), main);
  assert.equal((await verifyDelivery(f.cwd, profile, f.command)).version, '0.8.53');
  await writeFile(join(f.cwd, 'CHANGELOG.md'), `${main}- ajout\n`);
  await assert.rejects(verifyDelivery(f.cwd, profile, f.command), /fabriqué par la CI/);
});

function github({ prFiles, targetFiles, status = 'diverged' }) {
  const calls = [];
  const request = async path => {
    calls.push(path);
    if (path === '/repos/o/r/compare/main-sha...head-sha')
      return { status, files: prFiles.map(filename => ({ filename })) };
    if (path === '/repos/o/r/compare/head-sha...main-sha')
      return { files: targetFiles.map(filename => ({ filename })) };
    throw new Error(path);
  };
  return { calls, request };
}

test('main commits touching only target-owned files do not require updating a PR that leaves them alone', async () => {
  const ignored = targetOnlyPaths(profile);
  assert.deepEqual(ignored, ['CHANGELOG.md']);
  assert.deepEqual(targetOnlyPaths(validateExecutionProfile({ preset: 'planifikateur' })), []);
  const check = options => {
    const { request } = github(options);
    return targetIncluded(request, '/repos/o/r', 'main-sha', 'head-sha', options.ignored ?? ignored);
  };
  assert.equal(await check({ prFiles: ['src/a.ts'], targetFiles: [], status: 'ahead' }), true);
  // Commit « Journal des modifications » seul sur main : la PR reste fusionnable.
  assert.equal(await check({ prFiles: ['src/a.ts', 'package.json'], targetFiles: ['CHANGELOG.md'] }), true);
  // Un vrai changement de main, ou une PR qui touche aussi CHANGELOG.md, demande une remise à jour.
  assert.equal(await check({ prFiles: ['src/a.ts'], targetFiles: ['CHANGELOG.md', 'src/b.ts'] }), false);
  assert.equal(await check({ prFiles: ['src/a.ts', 'CHANGELOG.md'], targetFiles: ['CHANGELOG.md'] }), false);
  assert.equal(await check({ prFiles: ['src/a.ts'], targetFiles: ['CHANGELOG.md'], ignored: [] }), false);
  assert.equal(await check({ prFiles: ['src/a.ts'], targetFiles: ['CHANGELOG.md'], status: 'behind' }), false);
  // Liste de fichiers possiblement tronquée par GitHub : aucune tolérance.
  const many = Array.from({ length: 300 }, (_, i) => `src/${i}.ts`);
  assert.equal(await check({ prFiles: many, targetFiles: ['CHANGELOG.md'] }), false);
});

test('the merger squashes a DefilOrdi PR whose only missing main commit is the generated changelog', async () => {
  const repo = 'owner/defilordi',
    sha = 'a'.repeat(40),
    target = 'b'.repeat(40);
  const run = {
    workflow_id: 2,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: repo },
    head_sha: sha,
    head_branch: 'planifikateur/task',
    run_attempt: 1,
  };
  const pr = {
    number: 1,
    state: 'open',
    draft: false,
    head: { sha, repo: { full_name: repo } },
    base: { ref: 'main' },
    labels: [{ name: 'planifikateur-agent' }],
  };
  let targetFiles = ['CHANGELOG.md'];
  const request = async path => {
    if (path.endsWith('/workflows/build-windows.yml')) return { id: 2 };
    if (path.includes('/jobs?'))
      return { jobs: [{ name: 'build', status: 'completed', conclusion: 'success', run_attempt: 1 }], total_count: 1 };
    if (path.includes('/actions/runs/')) return run;
    if (path.includes('/pulls?')) return [pr];
    if (path.endsWith('/pulls/1')) return pr;
    if (path.endsWith('/branches/main')) return { commit: { sha: target } };
    if (path.endsWith(`/compare/${target}...${sha}`)) return { status: 'diverged', files: [{ filename: 'src/a.ts' }] };
    if (path.endsWith(`/compare/${sha}...${target}`)) return { files: targetFiles.map(filename => ({ filename })) };
    if (path.endsWith('/merge')) return { merged: true, sha };
    if (path.includes('/git/refs/')) return null;
    throw new Error(path);
  };
  const merge = () =>
    mergeAgentPullRequest({
      repository: repo,
      runId: 1,
      executionProfile: profile,
      request,
      eligible: async () => true,
    });
  assert.equal((await merge()).merged, true);
  targetFiles = ['CHANGELOG.md', 'src/b.ts'];
  assert.deepEqual(await merge(), { merged: false, reason: 'update_branch_required' });
});
