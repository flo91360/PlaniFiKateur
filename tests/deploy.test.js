import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('VPS updater preserves running work and rolls back failed deployments; CI and secrets remain protected', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/deploy', '-v'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
