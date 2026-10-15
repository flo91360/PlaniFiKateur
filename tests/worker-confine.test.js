import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confineTool } from '../worker/confine.mjs';

test('Claude file tools stay in the repository, symbolic links resolved, and never write into .git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-confine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, '.git', 'hooks'), { recursive: true });
  await mkdir(join(cwd, 'src'));
  await writeFile(join(root, 'secret.txt'), 'secret');
  await symlink(join(root, 'secret.txt'), join(cwd, 'lien'));
  await symlink(root, join(cwd, 'dehors'));
  const allowed = [
    ['Read', { file_path: 'src/app.js' }],
    ['Write', { file_path: join(cwd, 'src', 'nouveau', 'fichier.js') }],
    ['Grep', { pattern: 'TODO' }],
    ['Grep', { pattern: 'TODO', path: 'src' }],
    ['Glob', { pattern: 'src/**/*.js' }],
    ['Read', { file_path: '.git/HEAD' }],
  ];
  for (const [name, input] of allowed)
    assert.equal(await confineTool(cwd, name, input), '', `${name} ${JSON.stringify(input)}`);
  const refused = [
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: 'lien' }],
    ['Write', { file_path: 'dehors/nouveau.txt' }],
    ['Grep', { pattern: 'TOKEN', path: '/proc/1/environ' }],
    ['Grep', { pattern: 'TOKEN', path: '..' }],
    ['Glob', { pattern: '/proc/*/environ' }],
    ['Glob', { pattern: '../**/*' }],
    ['Glob', { pattern: '*', path: '/' }],
    ['Write', { file_path: '.git/hooks/pre-commit' }],
    ['Edit', { file_path: join(cwd, '.git', 'config') }],
    ['Read', { file_path: 42 }],
  ];
  for (const [name, input] of refused)
    assert.notEqual(await confineTool(cwd, name, input), '', `${name} ${JSON.stringify(input)}`);
});
