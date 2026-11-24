import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dependenciesChanged } from '../scripts/dependency-changes.mjs';

const checks = readFileSync('scripts/dependency-checks.sh', 'utf8');

test('the dependency checks audit both lockfiles and build the images like the VPS', () => {
  assert.match(checks, /npm audit --audit-level=high\n/);
  assert.match(checks, /npm audit --prefix worker --audit-level=high\n/);
  // Même construction que worker/deploy/update.py.
  assert.match(
    readFileSync('worker/deploy/update.py', 'utf8'),
    /"docker", "build", "-f", "worker\/Dockerfile", "-t", image, "\."/,
  );
  assert.match(checks, /docker build -f worker\/Dockerfile -t planifikateur-worker:ci \.\n/);
  // Image du site : même Dockerfile et même argument de commit que deploy/site.py.
  assert.match(readFileSync('deploy/site.py', 'utf8'), /"-f", "deploy\/site\.Dockerfile", "--build-arg",/);
  assert.match(checks, /docker build -f deploy\/site\.Dockerfile --build-arg PLANIFIKATEUR_COMMIT_SHA=/);
});

test('the required server job runs the dependency checks whenever dependencies, worker or deploy change', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(ci.jobs.server.name, 'Tests serveur');
  const steps = ci.jobs.server.steps;
  const detect = steps.find(step => step.id === 'deps');
  assert.match(detect.run, /dependency-checks\.sh changed/);
  for (const command of ['audit', 'worker-image', 'site-image']) {
    const step = steps.find(item => item.run === `scripts/dependency-checks.sh ${command}`);
    assert.ok(step, command);
    assert.equal(step.if, "steps.deps.outputs.changed == 'true'");
    assert.ok(steps.indexOf(step) < steps.findIndex(item => item.run === 'npm test'));
  }
  // Contrôle hebdomadaire séparé, sans doublon pour les PR.
  const weekly = parse(readFileSync('.github/workflows/dependencies.yml', 'utf8'));
  assert.ok(weekly.on.schedule[0].cron);
  assert.equal(weekly.on.pull_request, undefined);
});

test('a version bump alone does not count as a dependency change, a dependency or deploy change does', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-deps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const manifest = (version, dependencies = { a: '1.0.0' }) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version, dependencies }));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'p', version, packages: { '': { name: 'p', version, dependencies } } }),
    );
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'c');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  manifest('1.0.0');
  writeFileSync(join(dir, 'README.md'), 'a');
  const first = commit();
  manifest('1.0.1');
  writeFileSync(join(dir, 'README.md'), 'b');
  const bumped = commit();
  assert.equal(dependenciesChanged(first, { cwd: dir }), false);
  manifest('1.0.2', { a: '1.0.1' });
  commit();
  assert.equal(dependenciesChanged(bumped, { cwd: dir }), true);
  const dependency = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'deploy'));
  writeFileSync(join(dir, 'deploy', 'site.Dockerfile'), 'FROM node:24');
  commit();
  assert.equal(dependenciesChanged(dependency, { cwd: dir }), true);
  // Base inconnue (premier push, historique absent) : tout est contrôlé.
  for (const base of ['', '0'.repeat(40), 'f'.repeat(40)]) assert.equal(dependenciesChanged(base, { cwd: dir }), true);
});

test('every workflow pins its actions to a full commit', () => {
  for (const file of readdirSync('.github/workflows')) {
    for (const [, action] of readFileSync(`.github/workflows/${file}`, 'utf8').matchAll(/uses: (\S+)/g))
      assert.match(action, /@[0-9a-f]{40}$/, `${file} : ${action}`);
  }
});
