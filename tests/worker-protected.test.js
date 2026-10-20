import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../worker/commands.mjs';
import { protectedChanges, protectedPatterns, protectedQuestion, restoreProtected } from '../worker/protected.mjs';
import { defaultExecutionProfile } from '../worker/execution-profile.mjs';
import { taskPrompt } from '../worker/codex.mjs';

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

// Dépôt réel : la branche cible `main`, puis la branche de la tâche avec les fichiers donnés.
async function repository(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), 'planifikateur-protected-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async args => {
    const result = await runCommand(args, { cwd, env });
    if (result.code !== 0) throw new Error(result.output);
    return result.output.trim();
  };
  const write = async (path, content) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  };
  await command(['git', 'init', '--quiet', '--initial-branch', 'main']);
  for (const [path, content] of Object.entries(files)) await write(path, content);
  await command(['git', 'add', '--all']);
  await command(['git', 'commit', '--quiet', '-m', 'Base']);
  await command(['git', 'checkout', '--quiet', '-b', 'tache']);
  return { cwd, command, write, base: 'main', read: path => readFile(join(cwd, path), 'utf8') };
}

const packageJson = (version, scripts) => JSON.stringify({ name: 'demo', version, scripts }, null, 2) + '\n';
const planifikateur = defaultExecutionProfile('owner/planifikateur');

test('ordinary code changes are free, the worker, its delivery and the merge controls are protected', async t => {
  const repo = await repository(t, {
    'package.json': packageJson('1.0.0', { test: 'node --test' }),
    'src/app.js': 'export const a = 1;\n',
    'worker/isolation.mjs': 'export const sandbox = true;\n',
    '.github/workflows/ci.yml': 'name: Tests\n',
    'AGENTS.md': '# Consignes\n',
  });
  await repo.write('src/app.js', 'export const a = 2;\n');
  await repo.write('tests/app.test.js', 'nouveau test\n');
  // La version change à chaque livraison : seuls les scripts npm comptent.
  await repo.write('package.json', packageJson('1.0.1', { test: 'node --test' }));
  assert.deepEqual(await protectedChanges(planifikateur, repo), []);

  await repo.write('.github/workflows/ci.yml', 'name: Tests\non: push\n');
  await repo.command(['git', 'commit', '--quiet', '-am', 'Travail en cours']);
  await repo.write('worker/isolation.mjs', 'export const sandbox = false;\n');
  await repo.write('worker/nouveau.mjs', 'nouveau\n');
  await repo.write('AGENTS.md', '# Consignes allégées\n');
  await repo.write('package.json', packageJson('1.0.1', { test: 'true' }));
  assert.deepEqual(await protectedChanges(planifikateur, repo), [
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'package.json (scripts)',
    'worker/isolation.mjs',
    'worker/nouveau.mjs',
  ]);
});

test('protected files are restored as on the target branch, the rest of the work is kept', async t => {
  const repo = await repository(t, {
    'package.json': packageJson('1.0.0', { test: 'node --test' }),
    'worker/isolation.mjs': 'export const sandbox = true;\n',
    'src/app.js': 'export const a = 1;\n',
  });
  // Un fichier protégé ajouté dans un commit de travail, un autre modifié sans commit.
  await repo.write('worker/ajout.mjs', 'ajouté\n');
  await repo.write('.github/workflows/ci.yml', 'name: Faux\n');
  await repo.command(['git', 'add', '--all']);
  await repo.command(['git', 'commit', '--quiet', '-m', 'Travail en cours']);
  await repo.write('worker/isolation.mjs', 'export const sandbox = false;\n');
  await repo.write('src/app.js', 'export const a = 2;\n');
  await repo.write('package.json', packageJson('1.0.1', { test: 'true', lint: 'true' }));
  const touched = await protectedChanges(planifikateur, repo);
  assert.equal(touched.length, 4);
  await restoreProtected(touched, repo);
  assert.deepEqual(await protectedChanges(planifikateur, repo), []);
  assert.equal(await repo.read('worker/isolation.mjs'), 'export const sandbox = true;\n');
  await assert.rejects(repo.read('worker/ajout.mjs'), { code: 'ENOENT' });
  await assert.rejects(repo.read('.github/workflows/ci.yml'), { code: 'ENOENT' });
  assert.equal(await repo.read('src/app.js'), 'export const a = 2;\n');
  assert.deepEqual(JSON.parse(await repo.read('package.json')), {
    name: 'demo',
    version: '1.0.1',
    scripts: { test: 'node --test' },
  });
  // Après le commit du worker, la branche ne livre plus aucun fichier protégé.
  await repo.command(['git', 'add', '--all']);
  await repo.command(['git', 'commit', '--quiet', '-m', 'Livraison']);
  assert.equal(await repo.command(['git', 'diff', '--name-only', 'main...HEAD']), 'package.json\nsrc/app.js');
});

test('each profile protects its own test configuration, and the agent is told in advance', async t => {
  const funkart = defaultExecutionProfile('owner/funkart');
  const repo = await repository(t, {
    'tests/autoplay.gd': 'extends Node\n',
    'scenes/main.gd': 'extends Node\n',
    'package.json': '{}\n',
  });
  await repo.write('tests/autoplay.gd', 'extends Node # allégé\n');
  await repo.write('scenes/main.gd', 'extends Node2D\n');
  await repo.write('package.json', '{ "scripts": { "test": "true" } }\n');
  // Godot : les scripts de test du profil ; pas de scripts npm à comparer.
  assert.deepEqual(await protectedChanges(funkart, repo), ['tests/autoplay.gd']);
  assert.ok(protectedPatterns(planifikateur).includes('worker/**'));
  assert.ok(protectedPatterns(planifikateur).includes('scripts npm de package.json'));
  assert.ok(!protectedPatterns(funkart).includes('scripts npm de package.json'));
  const prompt = taskPrompt({
    cardSnapshot: { title: 'Carte' },
    objective: 'Demande',
    executionProfile: planifikateur,
    exchanges: [],
    submissions: [],
    updates: [],
  });
  assert.match(prompt, /Ne modifie pas ces fichiers protégés.*worker\/\*\*/);
  assert.match(protectedQuestion(['worker/isolation.mjs']), /worker\/isolation\.mjs.*intervention directe/);
});
