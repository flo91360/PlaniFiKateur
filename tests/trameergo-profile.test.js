import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExecutionProfile, validateExecutionProfile } from '../worker/execution-profile.mjs';
import { bumpProjectVersion } from '../worker/project-version.mjs';
import { prepareDelivery, verifyDelivery } from '../worker/delivery.mjs';
import { protectedChanges, protectedPatterns } from '../worker/protected.mjs';

const manifest = (version, scripts = { test: 'vitest run', build: 'vite build' }) =>
  JSON.stringify({ name: 'trameergo-tablette', version, scripts }, null, 2) + '\n';
const lock = version =>
  JSON.stringify({ name: 'trameergo-tablette', version, packages: { '': { version } } }, null, 2) + '\n';
const toml = version =>
  `[package]\nname = "trameergo"\nversion = "${version}"\nedition = "2021"\n\n[lib]\nname = "trameergo_lib"\n\n[dependencies]\nserde = { version = "1" }\n`;
const cargoLock = version =>
  `version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "trameergo"\nversion = "${version}"\ndependencies = [\n "serde",\n]\n`;
const changelog =
  '# Journal des modifications\n\nToutes les modifications notables de TrameErgo.\n\n## [1.5.1] - 2026-10-23\n\n### Modifié\n\n- Fiche patient.\n';

async function project(t) {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-tauri-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'tablette/src-tauri'), { recursive: true });
  const files = {
    'tablette/package.json': manifest('1.5.1'),
    'tablette/package-lock.json': lock('1.5.1'),
    'tablette/src-tauri/Cargo.toml': toml('1.5.1'),
    'tablette/src-tauri/Cargo.lock': cargoLock('1.5.1'),
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

test('the TrameErgo repository receives its Vue and Tauri profile with both CI jobs required before merging', () => {
  const profile = defaultExecutionProfile('flo91360/TrameErgo');
  assert.equal(profile.preset, 'trameergo');
  assert.equal(profile.nodeMajor, 22);
  assert.deepEqual(profile.installCommands, [['npm', 'ci', '--prefix', 'tablette']]);
  assert.deepEqual(profile.testCommands, [
    ['npm', '--prefix', 'tablette', 'test'],
    ['npm', '--prefix', 'tablette', 'run', 'build'],
  ]);
  assert.deepEqual(profile.workflow, {
    file: 'tablette.yml',
    name: 'Application tablette et Windows',
    jobs: ['tablette', 'build'],
  });
  assert.deepEqual(validateExecutionProfile({ preset: 'trameergo' }), profile);
});

test('TrameErgo deliveries raise package.json, its lockfile, Cargo.toml and Cargo.lock together', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/TrameErgo');
  assert.equal(await bumpProjectVersion(dir, profile, git(files)), '1.5.2');
  assert.equal(await bumpProjectVersion(dir, profile, git(files)), '1.5.2');
  const read = name => readFile(join(dir, name), 'utf8');
  assert.equal(JSON.parse(await read('tablette/package.json')).version, '1.5.2');
  assert.equal(JSON.parse(await read('tablette/package-lock.json')).packages[''].version, '1.5.2');
  assert.equal(await read('tablette/src-tauri/Cargo.toml'), toml('1.5.2'));
  // Seule l’entrée du paquet change : les dépendances gardent leur version.
  assert.equal(await read('tablette/src-tauri/Cargo.lock'), cargoLock('1.5.2'));
});

test('a TrameErgo delivery writes the changelog heading its CI expects and checks every version file', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/TrameErgo');
  const result = await prepareDelivery(dir, profile, git(files), {
    runId: 'run-1',
    title: 'Bilan',
    summary: 'Nouvelle rubrique.',
    date: new Date('2026-10-24T10:00:00Z'),
  });
  assert.equal(result.version, '1.5.2');
  const source = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(source, /^## \[1\.5\.2\] - 2026-10-24\n/m);
  assert.ok(source.indexOf('## [1.5.2]') < source.indexOf('## [1.5.1]'));
  assert.match(source, /^Toutes les modifications notables de TrameErgo\.$/m);
  await writeFile(join(dir, 'tablette/src-tauri/Cargo.lock'), cargoLock('1.5.1'));
  await assert.rejects(verifyDelivery(dir, profile, git(files)), /Cargo\.toml et Cargo\.lock/);
});

test('the npm scripts of tablette/package.json are protected for TrameErgo', async t => {
  const { dir, files } = await project(t),
    profile = defaultExecutionProfile('flo91360/TrameErgo');
  await writeFile(join(dir, 'tablette/package.json'), manifest('1.5.1', { test: 'true', build: 'vite build' }));
  const command = async args => {
    if (args[1] === 'diff') return 'tablette/package.json\0';
    if (args[1] === 'ls-files') return '';
    return git(files)(args);
  };
  assert.deepEqual(await protectedChanges(profile, { command, cwd: dir, base: 'origin/main' }), [
    'package.json (scripts)',
  ]);
  assert.ok(protectedPatterns(profile).includes('scripts npm de tablette/package.json'));
});
