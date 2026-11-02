import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/dependencies.yml', 'utf8');

test('the dependency workflow audits both lockfiles and builds the worker image like the VPS', () => {
  assert.match(workflow, /run: npm audit --audit-level=high\n/);
  assert.match(workflow, /run: npm audit --prefix worker --audit-level=high\n/);
  assert.match(workflow, /schedule:\n\s+- cron: /);
  // Même construction que worker/deploy/update.py.
  assert.match(
    readFileSync('worker/deploy/update.py', 'utf8'),
    /"docker", "build", "-f", "worker\/Dockerfile", "-t", image, "\."/,
  );
  assert.match(workflow, /run: docker build -f worker\/Dockerfile -t planifikateur-worker:ci \.\n/);
  // Image du site : même Dockerfile et même argument de commit que deploy/site.py.
  assert.match(readFileSync('deploy/site.py', 'utf8'), /"-f", "deploy\/site\.Dockerfile", "--build-arg",/);
  assert.match(workflow, /docker build -f deploy\/site\.Dockerfile --build-arg PLANIFIKATEUR_COMMIT_SHA=/);
  assert.match(workflow, /- deploy\/\*\*\n/);
  // Hors des contrôles requis : ses jobs ne portent pas le nom de ceux de ci.yml.
  assert.doesNotMatch(workflow, /name: Tests (serveur|navigateur)/);
});

test('every workflow pins its actions to a full commit', () => {
  for (const file of readdirSync('.github/workflows')) {
    for (const [, action] of readFileSync(`.github/workflows/${file}`, 'utf8').matchAll(/uses: (\S+)/g))
      assert.match(action, /@[0-9a-f]{40}$/, `${file} : ${action}`);
  }
});
