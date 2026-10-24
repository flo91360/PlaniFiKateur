import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExecutionProfile, validateExecutionProfile } from '../worker/execution-profile.mjs';
import { bumpProjectVersion } from '../worker/project-version.mjs';
import { prepareDelivery, verifyDelivery } from '../worker/delivery.mjs';
import { protectedChanges } from '../worker/protected.mjs';
import { checkRuntime, runtimeEnvironment } from '../worker/runtime.mjs';

const pyproject = version =>
  `[build-system]\nrequires = ["setuptools>=68"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "autocorrect-nepsy"\nversion = "${version}"\ndependencies = [\n    "numpy>=1.24",\n]\n\n[project.optional-dependencies]\ntest = ["pytest>=7"]\n\n[tool.other]\nversion = "9.9.9"\n`;
const changelog =
  '# Journal des modifications\n\nToutes les évolutions notables.\n\n<!-- nouvelles versions -->\n\n## [0.1.0] - 2026-10-24\n\n- Prototype.\n';
const init = version => `"""Correction automatique."""\n\n__version__ = "${version}"\n`;

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-nepsy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'autocorrect_nepsy'));
  const files = {
    'pyproject.toml': pyproject('0.1.0'),
    'autocorrect_nepsy/__init__.py': init('0.1.0'),
    'CHANGELOG.md': changelog,
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return { dir, files };
}
// Branche cible simulée : `git show origin/main:<fichier>` renvoie l’état initial.
const git = files => async args => {
  if (args[1] === 'merge-base') return '';
  if (args[1] === 'show') return files[args[2].slice(args[2].indexOf(':') + 1)];
  throw new Error(`Commande inattendue : ${args.join(' ')}`);
};

test('the AutoCorrectNEPSY repository requires its version, test and Windows executable jobs before merging', () => {
  const profile = defaultExecutionProfile('flo91360/AutoCorrectNEPSY');
  assert.equal(profile.preset, 'autocorrectnepsy');
  assert.deepEqual(profile.installCommands, [
    ['python3', '-m', 'venv', '.planifikateur/venv'],
    ['.planifikateur/venv/bin/python', '-m', 'pip', 'install', '-e', '.[test]'],
  ]);
  assert.deepEqual(profile.testCommands, [['.planifikateur/venv/bin/python', '-m', 'pytest', '-q']]);
  assert.deepEqual(profile.workflow, {
    file: 'tests.yml',
    name: 'Tests et exécutable Windows',
    jobs: [
      'Version',
      'Tests Python 3.10 (Linux)',
      'Tests Python 3.12 (Linux)',
      'Tests Python 3.12 (Windows)',
      'Exécutable Windows',
    ],
  });
  assert.deepEqual(validateExecutionProfile({ preset: 'autocorrectnepsy' }), profile);
  assert.equal(runtimeEnvironment(profile, {}).PIP_DISABLE_PIP_VERSION_CHECK, '1');
});

test('AutoCorrectNEPSY deliveries raise pyproject.toml and __version__ together', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/AutoCorrectNEPSY');
  assert.equal(await bumpProjectVersion(dir, profile, git(files)), '0.1.1');
  assert.equal(await bumpProjectVersion(dir, profile, git(files)), '0.1.1');
  // Seule la version de [project] change, pas celle d’une autre table.
  assert.equal(await readFile(join(dir, 'pyproject.toml'), 'utf8'), pyproject('0.1.1'));
  assert.equal(await readFile(join(dir, 'autocorrect_nepsy/__init__.py'), 'utf8'), init('0.1.1'));
});

test('an AutoCorrectNEPSY delivery writes the changelog heading its CI expects and checks __version__', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/AutoCorrectNEPSY');
  const result = await prepareDelivery(dir, profile, git(files), {
    runId: 'run-1',
    title: 'Item 9',
    summary: 'Critères de l’item 9.',
    date: new Date('2026-10-24T10:00:00Z'),
  });
  assert.equal(result.version, '0.1.1');
  // Titre « ## [x.y.z] - date » attendu par le job « Version » du dépôt, sous son repère.
  const changelog = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /<!-- nouvelles versions -->\n\n## \[0\.1\.1\] - 2026-10-24\n/);
  assert.ok(changelog.indexOf('## [0.1.1]') < changelog.indexOf('## [0.1.0]'));
  await writeFile(join(dir, 'autocorrect_nepsy/__init__.py'), init('0.1.0'));
  await assert.rejects(verifyDelivery(dir, profile, git(files)), /__version__/);
});

test('the .gitignore that keeps children’s data out of the public repository is protected', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/AutoCorrectNEPSY');
  const command = async args => {
    if (args[1] === 'diff') return '.gitignore\0tests/conftest.py\0packaging/verifier_version.py\0';
    if (args[1] === 'ls-files') return 'pytest.ini\0';
    return git(files)(args);
  };
  assert.deepEqual(await protectedChanges(profile, { command, cwd: dir, base: 'origin/main' }), [
    '.gitignore',
    'packaging/verifier_version.py',
    'pytest.ini',
  ]);
});

test('the worker image must provide Python 3.10 or later with venv for AutoCorrectNEPSY', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planifikateur-runtime-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const profile = defaultExecutionProfile('flo91360/AutoCorrectNEPSY');
  const runtime = python => async command => {
    if (command[0] === 'node') return { code: 0, output: `v${profile.nodeMajor}.1.0\n` };
    return python;
  };
  await checkRuntime(profile, { stateRoot }, runtime({ code: 0, output: '3.11\n' }));
  await assert.rejects(checkRuntime(profile, { stateRoot }, runtime({ code: 0, output: '3.9\n' })), /Python 3\.10/);
  await assert.rejects(checkRuntime(profile, { stateRoot }, runtime({ code: 1, output: 'No module named venv' })));
});
