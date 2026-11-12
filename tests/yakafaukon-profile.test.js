import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExecutionProfile, validateExecutionProfile } from '../worker/execution-profile.mjs';
import { prepareDelivery } from '../worker/delivery.mjs';
import { protectedChanges } from '../worker/protected.mjs';
import { checkRuntime, runtimeEnvironment } from '../worker/runtime.mjs';

const godotProject = version =>
  `config_version=5\n\n[application]\n\nconfig/name="YaKaFauKon"\nconfig/version="${version}"\n`;
const changelog =
  '# Journal des modifications\n\nToutes les versions publiées.\n\n## [2.0.0] - 2026-11-12\n\n### Ajouté\n\n- Version 2.\n';
const git = files => async args => {
  if (args[1] === 'merge-base') return '';
  if (args[1] === 'show') return files[args[2].slice(args[2].indexOf(':') + 1)];
  throw new Error(`Commande inattendue : ${args.join(' ')}`);
};
const tests = ['run_tests', 'gameplay_test', 'profile_test', 'flow_test'];

test('the YaKaFauKon repository runs its four Godot 4.7.2 test scripts and requires the export job', () => {
  const profile = defaultExecutionProfile('flo91360/YaKaFauKon');
  assert.equal(profile.preset, 'yakafaukon');
  assert.equal(profile.godotVersion, '4.7.2');
  assert.deepEqual(profile.installCommands, [['godot', '--headless', '--import']]);
  assert.deepEqual(
    profile.testCommands,
    tests.map(name => ['godot', '--headless', '--path', '.', '--script', `res://tests/${name}.gd`]),
  );
  assert.deepEqual(profile.workflow, { file: 'build.yml', name: 'Construire le jeu', jobs: ['export'] });
  assert.deepEqual(validateExecutionProfile({ preset: 'yakafaukon' }), profile);
});

test('each Godot profile finds its own Godot version first in the PATH', () => {
  const config = { godotRoot: '/opt/godot', node22Bin: '/opt/node22/bin' };
  assert.ok(
    runtimeEnvironment(defaultExecutionProfile('owner/yakafaukon'), config).PATH.startsWith('/opt/godot/4.7.2:'),
  );
  assert.ok(runtimeEnvironment(defaultExecutionProfile('owner/funkart'), config).PATH.startsWith('/opt/godot/4.4.1:'));
  assert.doesNotMatch(runtimeEnvironment(defaultExecutionProfile('owner/planifikateur'), config).PATH, /godot/);
});

test('the worker refuses YaKaFauKon tasks when Godot 4.7.2 is missing from its image', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planifikateur-runtime-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const profile = defaultExecutionProfile('flo91360/YaKaFauKon');
  const runtime = godot => async command =>
    command[0] === 'node' ? { code: 0, output: `v${profile.nodeMajor}.1.0\n` } : { code: 0, output: godot };
  await checkRuntime(profile, { stateRoot }, runtime('4.7.2.stable.official.ed1daf0bf\n'));
  await assert.rejects(checkRuntime(profile, { stateRoot }, runtime('4.4.1.stable.official\n')), /Godot 4\.7\.2/);
});

test('a YaKaFauKon delivery raises config/version and writes the changelog heading its CI publishes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-yakafaukon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { 'project.godot': godotProject('2.0.0'), 'CHANGELOG.md': changelog };
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  const result = await prepareDelivery(dir, defaultExecutionProfile('flo91360/YaKaFauKon'), git(files), {
    runId: 'run-1',
    title: 'Nouvelle activité',
    summary: 'Activité jardinage.',
    date: new Date('2026-11-12T10:00:00Z'),
  });
  assert.equal(result.version, '2.0.1');
  assert.equal(await readFile(join(dir, 'project.godot'), 'utf8'), godotProject('2.0.1'));
  const written = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(written, /^## \[2\.0\.1\] - 2026-11-12$/m);
  assert.ok(written.indexOf('## [2.0.1]') < written.indexOf('## [2.0.0]'));
});

test('a card cannot change the YaKaFauKon test scripts that decide its merge', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-yakafaukon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = async args => {
    if (args[1] === 'diff') return 'tests/gameplay_test.gd\0scripts/core/data.gd\0.github/workflows/build.yml\0';
    if (args[1] === 'ls-files') return '';
    throw new Error(`Commande inattendue : ${args.join(' ')}`);
  };
  assert.deepEqual(
    await protectedChanges(defaultExecutionProfile('owner/yakafaukon'), { command, cwd: dir, base: 'origin/main' }),
    ['.github/workflows/build.yml', 'tests/gameplay_test.gd'],
  );
});

test('the Godot installer only installs a version whose checksums it knows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-godot-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = join(dir, 'godot');
  const install = version =>
    spawnSync(
      'python3',
      [
        'worker/install-godot.py',
        '--version',
        version,
        '--archive',
        join(dir, 'absent.zip'),
        '--destination',
        destination,
      ],
      {
        encoding: 'utf8',
      },
    );
  assert.match(install('4.9.9').stderr, /invalid choice/);
  await writeFile(join(dir, 'absent.zip'), 'corrupted download');
  assert.match(install('4.7.2').stderr, /checksum mismatch/);
  assert.equal(existsSync(destination), false);
});
