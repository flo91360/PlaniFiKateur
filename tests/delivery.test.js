import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { prepareDelivery, verifyDelivery } from '../worker/delivery.mjs';
import { gitCommand } from '../scripts/delivery.mjs';
import { publishVersion } from '../scripts/publish-version.mjs';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';
import { createAppServer } from '../server/index.js';
import { createStore } from '../server/store.js';

const exec = promisify(execFile), profile = { preset: 'planifikateur', branch: 'main' };
const details = { runId: 'livraison-test', title: 'Menu', summary: 'Le menu permet de retrouver les projets.' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-delivery-')), cwd = join(root, 'source');
  t.after(() => rm(root, { recursive: true, force: true })); await mkdir(cwd);
  const command = gitCommand(cwd), git = (...args) => command(['git', ...args]);
  const bare = join(root, 'remote.git');
  await git('init', '--bare', '--initial-branch=main', bare);
  await git('init', '--initial-branch=main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3', type: 'module' }));
  await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }));
  await writeFile(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 — 2026-10-01\n\n- Version précédente.\n');
  await writeFile(join(cwd, 'README.md'), 'Version : v1.2.3. Copie : apercu-v1.2.3.html\n');
  await git('add', '.'); await git('commit', '-m', 'Initial'); await git('remote', 'add', 'origin', bare); await git('push', 'origin', 'main');
  const base = await git('rev-parse', 'HEAD'); await git('switch', '-c', 'livraison/test');
  return { root, cwd, git, command, bare, base };
}

test('a direct CLI delivery and the worker use the same idempotent version/changelog preparation', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyDelivery(f.cwd, profile, f.command), /augmenter la version/);
  const script = fileURLToPath(new URL('../scripts/delivery.mjs', import.meta.url));
  await exec(process.execPath, [script, 'prepare', '--id', details.runId, '--title', details.title, '--summary', details.summary], { cwd: f.cwd });
  const before = await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8');
  assert.equal((await prepareDelivery(f.cwd, profile, f.command, details)).version, '1.2.4');
  assert.equal(await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8'), before);
  assert.match(await readFile(join(f.cwd, 'README.md'), 'utf8'), /Version : v1\.2\.4\. Copie : apercu-v1\.2\.4\.html/);
  await exec(process.execPath, [script, 'check'], { cwd: f.cwd });
});
test('missing, empty, obsolete or duplicate release notes and a mismatched lockfile block delivery', async t => {
  const f = await fixture(t); await prepareDelivery(f.cwd, profile, f.command, details);
  const valid = await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8');
  for (const source of ['', '# Changelog\n\n## 1.2.3 — 2026-10-01\n\n- Previous\n', '# Changelog\n\n## 1.2.4 — 2026-10-13\n\n', valid + '\n## 1.2.4 — 2026-10-13\n\n- Duplicate\n']) {
    await writeFile(join(f.cwd, 'CHANGELOG.md'), source); await assert.rejects(verifyDelivery(f.cwd, profile, f.command), /CHANGELOG|changelog/);
  }
  await writeFile(join(f.cwd, 'CHANGELOG.md'), valid);
  await writeFile(join(f.cwd, 'package-lock.json'), JSON.stringify({ version: '1.2.3' }));
  await assert.rejects(verifyDelivery(f.cwd, profile, f.command), /même version/);
});
test('updating against a newly released base increases the version again and retains previous release notes', async t => {
  const f = await fixture(t); await prepareDelivery(f.cwd, profile, f.command, details);
  await f.git('add', '.'); await f.git('commit', '-m', 'First release');
  await f.git('push', 'origin', 'HEAD:main'); await f.git('fetch', 'origin', 'main');
  assert.equal((await prepareDelivery(f.cwd, profile, f.command, { ...details, runId: 'livraison-next', title: 'Aide' })).version, '1.2.5');
  const log = await readFile(join(f.cwd, 'CHANGELOG.md'), 'utf8'); assert.ok(log.indexOf('## 1.2.5') < log.indexOf('## 1.2.4'));
});
test('a delivery based on an obsolete main cannot pass even with a higher version and changelog', async t => {
  const f = await fixture(t); await prepareDelivery(f.cwd, profile, f.command, details);
  await f.git('add', '.'); await f.git('commit', '-m', 'Prepared feature');
  await f.git('switch', 'main'); await writeFile(join(f.cwd, 'other.txt'), 'Another feature');
  await f.git('add', '.'); await f.git('commit', '-m', 'Advance main'); await f.git('push', 'origin', 'main');
  await f.git('switch', 'livraison/test'); await assert.rejects(verifyDelivery(f.cwd, profile, f.command), /branche cible a avancé/);
  await f.git('merge', '--no-edit', 'origin/main'); assert.equal((await verifyDelivery(f.cwd, profile, f.command)).version, '1.2.4');
});
test('version and documentation files cannot be replaced by symlinks', async t => {
  const f = await fixture(t); await rm(join(f.cwd, 'README.md')); await symlink(join(f.cwd, 'package.json'), join(f.cwd, 'README.md'));
  await assert.rejects(prepareDelivery(f.cwd, profile, f.command, details), /fichier ordinaire/);
  const other = await fixture(t), outside = join(other.root, 'private-docs'); await mkdir(outside);
  await writeFile(join(outside, 'agents.md'), 'Conserver 1.2.3'); await symlink(outside, join(other.cwd, 'docs'));
  await assert.rejects(prepareDelivery(other.cwd, profile, other.command, details), /répertoire ordinaire/);
  assert.equal(await readFile(join(outside, 'agents.md'), 'utf8'), 'Conserver 1.2.3');
});

function ci(sha, changes = {}) {
  const run = { id: 42, workflow_id: 7, head_sha: sha, head_branch: 'main', event: 'push', head_repository: { full_name: 'owner/project' }, status: 'completed', conclusion: 'success', run_attempt: 1, ...changes.run };
  const jobs = ['Tests serveur', 'Tests navigateur'].map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 }));
  return async path => {
    if (path.endsWith('/ci.yml')) return { id: 7 };
    if (path.includes('/jobs?')) return { jobs: changes.jobs || jobs, total_count: 2 };
    if (path.includes('/runs?')) return { workflow_runs: changes.newer ? [{ ...run, id: 43 }] : [run] };
    if (path.endsWith('/runs/42')) return run;
    throw new Error(path);
  };
}
async function committed(t) {
  const f = await fixture(t); await prepareDelivery(f.cwd, profile, f.command, details); await f.git('add', '.'); await f.git('commit', '-m', 'Release');
  f.sha = await f.git('rev-parse', 'HEAD'); return f;
}
test('successful main CI publishes an immutable annotated tag on the tested commit and can retry safely', async t => {
  const f = await committed(t), params = { repository: 'owner/project', sha: f.sha, runId: 42, cwd: f.cwd, command: f.command, request: ci(f.sha) };
  assert.equal(await publishVersion(params), 'v1.2.4'); assert.equal(await publishVersion(params), 'v1.2.4');
  assert.equal(await f.git('rev-parse', 'v1.2.4^{commit}'), f.sha);
  assert.match(await f.git('for-each-ref', '--format=%(contents)', 'refs/tags/v1.2.4'), /Le menu permet de retrouver les projets/);
});
test('failed, obsolete, foreign or incomplete CI cannot create a version tag', async t => {
  const f = await committed(t);
  for (const changes of [{ run: { conclusion: 'failure' } }, { run: { event: 'pull_request' } }, { run: { head_sha: 'b'.repeat(40) } }, { run: { head_repository: { full_name: 'another/project' } } }, { jobs: [] }, { newer: true }]) {
    await assert.rejects(publishVersion({ repository: 'owner/project', sha: f.sha, runId: 42, cwd: f.cwd, command: f.command, request: ci(f.sha, changes) }));
    assert.equal(await f.git('tag', '--list'), '');
  }
});
test('an existing version tag on another commit is never moved', async t => {
  const f = await committed(t); await f.git('tag', 'v1.2.4', f.base);
  await assert.rejects(publishVersion({ repository: 'owner/project', sha: f.sha, runId: 42, cwd: f.cwd, command: f.command, request: ci(f.sha) }), /autre commit/);
  assert.equal(await f.git('rev-parse', 'v1.2.4^{commit}'), f.base);
});
test('deployment verification waits through an old version and accepts only the expected version and full commit', async () => {
  let time = 0, calls = 0; const sha = 'a'.repeat(40);
  const result = await verifyDeployment({ url: 'https://site.example', sha, version: '1.2.4', timeoutMs: 30000 }, {
    now: () => time, wait: async ms => { time += ms; }, transport: async (url, options) => {
      assert.equal(options.redirect, 'error'); assert.ok(url.endsWith(sha));
      return Response.json(++calls === 1 ? { version: '1.2.3', commit: 'b'.repeat(40) } : { version: '1.2.4', commit: sha });
    },
  });
  assert.equal(result.commit, sha); assert.equal(calls, 2);
});
test('a different deployed commit or an unavailable site fails explicitly instead of claiming deployment success', async () => {
  for (const transport of [async () => Response.json({ version: '1.2.4', commit: 'b'.repeat(40) }), async () => { throw new Error('down'); }]) {
    let time = 0;
    await assert.rejects(verifyDeployment({ url: 'https://site.example', sha: 'a'.repeat(40), version: '1.2.4', timeoutMs: 10 }, { transport, now: () => time, wait: async ms => { time += ms; } }), /Déploiement non confirmé/);
  }
});
test('public build metadata bypasses caches without disclosing account or worker configuration', async t => {
  const f = await fixture(t), dist = join(f.root, 'dist'); await mkdir(dist);
  const build = { version: '1.2.4', commit: 'a'.repeat(40), tag: 'v1.2.4', date: '' }; await writeFile(join(dist, 'build-info.json'), JSON.stringify(build));
  const store = createStore(':memory:'), server = createAppServer({ store, dist }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/build-info.json?commit=${build.commit}`);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), build);
});
test('CI checks delivery before tests and the publication workflow waits for main CI and then checks deployment', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = ci.jobs.server.steps;
  assert.ok(steps.findIndex(step => step.run === 'npm run delivery:check') < steps.findIndex(step => step.run === 'npm test'));
  const release = parse(await readFile(new URL('../.github/workflows/tag-version.yml', import.meta.url), 'utf8'));
  assert.deepEqual(release.on.workflow_run.workflows, ['Tests']); assert.match(release.jobs.publish.if, /event == 'push'/); assert.match(release.jobs.publish.if, /conclusion == 'success'/);
  assert.equal(release.jobs.deploy.needs, 'publish'); assert.match(release.jobs.publish.steps[0].with.ref, /head_sha/);
});
