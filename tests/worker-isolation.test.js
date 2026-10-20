import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIsolation, isolatedCommand } from '../worker/isolation.mjs';
import { readWorkerConfig } from '../worker/config.mjs';

const base = {
  PLANIFIKATEUR_URL: 'https://site.example',
  PLANIFIKATEUR_AGENT_TOKEN: 'a',
  PLANIFIKATEUR_GITHUB_TOKEN: 'g',
};

test('project commands run in bubblewrap with the worker state hidden and .git read-only', t => {
  const root = mkdtempSync(join(tmpdir(), 'planifikateur-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  mkdirSync(join(stateRoot, 'codex'), { recursive: true });
  const config = {
    isolation: 'bwrap',
    stateRoot,
    codexHome: join(stateRoot, 'codex'),
    claudeHome: join(root, 'absent'),
  };
  const cwd = join(stateRoot, 'jobs', 'run');
  const cache = join(stateRoot, 'npm-cache');
  const argv = isolatedCommand(['npm', 'test'], { config, cwd, writable: [cache] });
  const pairs = flag => argv.flatMap((arg, index) => (arg === flag ? [argv.slice(index + 1, index + 3)] : []));
  assert.equal(argv[0], 'bwrap');
  assert.deepEqual(argv.slice(-3), ['--', 'npm', 'test']);
  for (const flag of ['--unshare-all', '--die-with-parent', '--new-session']) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(
    argv.slice(argv.indexOf('--proc'), argv.indexOf('--proc') + 2),
    ['--proc', '/proc'],
    'Un /proc neuf : le worker et ses variables restent invisibles.',
  );
  // L’état (avec Codex dedans) est masqué une seule fois ; Claude absent n’a rien à masquer.
  assert.deepEqual(
    argv.flatMap((arg, index) => (arg === '--tmpfs' ? [argv[index + 1]] : [])),
    ['/dev/shm', '/tmp', stateRoot],
  );
  assert.deepEqual(pairs('--bind'), [
    [cwd, cwd],
    [cache, cache],
  ]);
  assert.deepEqual(pairs('--ro-bind').at(-1), [join(cwd, '.git'), join(cwd, '.git')]);
  assert.deepEqual(isolatedCommand(['npm', 'test'], { config: { ...config, isolation: 'none' }, cwd }), [
    'npm',
    'test',
  ]);
});

test('the isolation mode is explicit: bubblewrap in the Docker image, none for a development worker', () => {
  assert.equal(readWorkerConfig(base).isolation, 'none');
  assert.equal(readWorkerConfig({ ...base, PLANIFIKATEUR_WORKER_ISOLATION: 'bwrap' }).isolation, 'bwrap');
  assert.throws(() => readWorkerConfig({ ...base, PLANIFIKATEUR_WORKER_ISOLATION: 'docker' }), /bwrap ou none/);
});

const bwrap = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
// En CI (PLANIFIKATEUR_REQUIRE_BWRAP=1), ce test ne peut pas être ignoré : bubblewrap y est installé.
test('bubblewrap is available wherever its real test is required', () => {
  if (process.env.PLANIFIKATEUR_REQUIRE_BWRAP === '1') assert.ok(bwrap, 'bubblewrap est requis mais inutilisable.');
});
test(
  'a real isolated command sees neither the worker variables nor its state',
  { skip: !bwrap && 'bubblewrap absent' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'planifikateur-isolation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const config = {
      isolation: 'bwrap',
      stateRoot: join(root, 'state'),
      codexHome: join(root, 'state', 'codex'),
      claudeHome: join(root, 'claude'),
    };
    assert.match(await checkIsolation(config), /bubblewrap/);
  },
);

test('worker secrets come from the private file written by the entrypoint, which is then deleted', async t => {
  const { withSecrets } = await import('../worker/secrets.mjs');
  const { mkdtemp, writeFile, access } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'secrets');
  await writeFile(file, 'PLANIFIKATEUR_AGENT_TOKEN=agent=avec=égal\nOPENAI_API_KEY=sk-test\nPATH=/injecte\n');
  const env = await withSecrets({ PATH: '/usr/bin', PLANIFIKATEUR_WORKER_SECRETS: file });
  assert.deepEqual(env, { PATH: '/usr/bin', PLANIFIKATEUR_AGENT_TOKEN: 'agent=avec=égal', OPENAI_API_KEY: 'sk-test' });
  await assert.rejects(access(file), { code: 'ENOENT' });
  const plain = { PATH: '/usr/bin' };
  assert.equal(await withSecrets(plain), plain, 'Sans fichier (hors Docker), l’environnement reste la source.');
});
