import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('VPS updater preserves running work and rolls back failed deployments; CI and secrets remain protected', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests/deploy', '-v'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the Godot installer refuses an archive with a wrong checksum before writing a binary', t => {
  const directory = mkdtempSync(join(tmpdir(), 'planifikateur-godot-checksum-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = join(directory, 'download.zip'), destination = join(directory, 'godot');
  writeFileSync(archive, 'corrupted download');
  const result = spawnSync('python3', ['worker/install-godot.py', '--archive', archive, '--destination', destination], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
  assert.equal(existsSync(destination), false);
});
