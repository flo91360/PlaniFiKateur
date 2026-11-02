import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../worker/commands.mjs';
import { dependencyChanges } from '../worker/dependencies.mjs';

const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

async function repository(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), 'planifikateur-dependencies-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = async args => {
    const result = await runCommand(args, { cwd, env });
    if (result.code !== 0) throw new Error(result.output);
    return result.output.trim();
  };
  const write = async (path, content) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  await command(['git', 'init', '--quiet', '--initial-branch', 'main']);
  for (const [path, content] of Object.entries(files)) await write(path, content);
  await command(['git', 'add', '--all']);
  await command(['git', 'commit', '--quiet', '-m', 'Base']);
  await command(['git', 'checkout', '--quiet', '-b', 'tache']);
  const changes = async () => {
    await command(['git', 'add', '--all']);
    await command(['git', 'commit', '--quiet', '--allow-empty', '-m', 'Travail']);
    return dependencyChanges({ command, cwd, base: 'main' });
  };
  return { write, changes, remove: path => rm(join(cwd, path)) };
}

const lock = (version, packages) => ({
  name: 'demo',
  version,
  lockfileVersion: 3,
  packages: { '': { name: 'demo', version, dependencies: { react: '^19.0.0' } }, ...packages },
});
const react = {
  'node_modules/react': { version: '19.0.0', resolved: 'https://registry.npmjs.org/react/-/react-19.0.0.tgz' },
};

test('a delivery that only changes code or versions needs no approval', async t => {
  const repo = await repository(t, {
    'package.json': { name: 'demo', version: '1.0.0', dependencies: { react: '^19.0.0' } },
    'package-lock.json': lock('1.0.0', react),
    'src/app.js': 'export const a = 1;\n',
  });
  await repo.write('src/app.js', 'export const a = 2;\n');
  await repo.write('package.json', { name: 'demo', version: '1.0.1', dependencies: { react: '^19.0.0' } });
  await repo.write('package-lock.json', lock('1.0.1', react));
  assert.deepEqual(await repo.changes(), []);
});

test('added or changed dependencies, lockfile packages and other manifests are listed for approval', async t => {
  const repo = await repository(t, {
    'package.json': { name: 'demo', version: '1.0.0', dependencies: { react: '^19.0.0', lodash: '^4.0.0' } },
    'package-lock.json': lock('1.0.0', react),
    'worker/package.json': { name: 'worker', devDependencies: { vitest: '^2.0.0' } },
    'node_modules/x/package.json': { name: 'x' },
    'requirements.txt': 'requests==2.0\n',
  });
  await repo.write('package.json', {
    name: 'demo',
    version: '1.0.1',
    dependencies: { react: '^19.1.0', 'left-pad': '^1.3.0' },
    overrides: { qs: '6.14.1' },
  });
  await repo.write('package-lock.json', lock('1.0.1', { ...react, 'node_modules/left-pad': { version: '1.3.0' } }));
  await repo.write('worker/package.json', { name: 'worker', devDependencies: {} });
  await repo.write('requirements.txt', 'requests==2.0\nevil==1.0\n');
  await repo.write('Cargo.toml', '[dependencies]\n');
  assert.deepEqual(await repo.changes(), [
    'Manifeste de dépendances modifié : Cargo.toml',
    'Lockfile modifié : 1 paquet(s) ajouté(s) ou changé(s), dont left-pad (package-lock.json)',
    'Dépendance modifiée : react ^19.0.0 → ^19.1.0 (package.json)',
    'Dépendance ajoutée : left-pad ^1.3.0 (package.json)',
    'Résolutions de dépendances modifiées : overrides (package.json)',
    'Manifeste de dépendances modifié : requirements.txt',
  ]);
});

test('a new manifest counts every dependency, an unreadable one is reported and removals are free', async t => {
  const repo = await repository(t, { 'old/package.json': { name: 'old', dependencies: { a: '1.0.0' } } });
  await repo.remove('old/package.json');
  await repo.write('tools/package.json', { name: 'tools', dependencies: { b: '2.0.0' } });
  await repo.write('broken/package.json', '{ invalide');
  assert.deepEqual(await repo.changes(), [
    'Manifeste npm illisible : broken/package.json',
    'Dépendance ajoutée : b 2.0.0 (tools/package.json)',
  ]);
});
