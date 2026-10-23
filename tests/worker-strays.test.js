import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strayProcesses, stopStrays } from '../worker/strays.mjs';
import { createCheckouts } from '../worker/checkout.mjs';
import { defaultExecutionProfile } from '../worker/execution-profile.mjs';

// Faux /proc : pid → [parent, uid].
async function proc(t, processes) {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [pid, [ppid, uid]] of Object.entries(processes)) {
    await mkdir(join(root, pid));
    await writeFile(join(root, pid, 'status'), `Name:\tx\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  }
  await mkdir(join(root, 'self'));
  return root;
}

test('processes of the worker user other than the worker and its ancestors are stopped', async t => {
  // 1 : entrypoint (root) ; 10 : worker ; 11 : commande restée d’un tour IA ; 12 : son enfant ;
  // 20 : processus d’un autre utilisateur.
  const root = await proc(t, { 1: [0, 0], 10: [1, 1000], 11: [10, 1000], 12: [11, 1000], 20: [1, 1001] });
  assert.deepEqual((await strayProcesses({ proc: root, self: 10, uid: 1000 })).sort(), [11, 12]);
  const killed = [];
  const stopped = await stopStrays({ proc: root, self: 10, uid: 1000 }, (pid, signal) => {
    killed.push([pid, signal]);
    if (pid === 12) throw Object.assign(new Error('déjà terminé'), { code: 'ESRCH' });
  });
  assert.deepEqual(stopped.sort(), [11, 12]);
  assert.deepEqual(killed.sort(), [
    [11, 'SIGKILL'],
    [12, 'SIGKILL'],
  ]);
});

test('only Git commands that receive the GitHub token stop the remaining processes, in the Docker image', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planifikateur-strays-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const calls = [];
  const checkouts = stopStrays =>
    createCheckouts({
      config: { stopStrays, stateRoot, githubToken: 'jeton' },
      execute: async args => {
        calls.push(args.join(' '));
        return { code: 0, output: '' };
      },
      state: {},
      log: () => {},
      clean: text => text,
      github: {},
      stopStrays: async () => {
        calls.push('arrêt');
        return [];
      },
    });
  const task = {
    job: { id: 'tache', repository: 'owner/repo', executionProfile: defaultExecutionProfile('owner/repo') },
    reservation: { signal: undefined },
  };
  const { command, beforeRemote } = checkouts(true).workspace(task);
  await command(['git', 'status']);
  await command(['git', 'fetch', 'origin', 'main']);
  await beforeRemote();
  assert.deepEqual(calls, ['git status', 'arrêt', 'git fetch origin main', 'arrêt']);
  calls.length = 0;
  await checkouts(false).workspace(task).command(['git', 'push', 'origin', 'HEAD']);
  assert.deepEqual(calls, ['git push origin HEAD'], 'Hors Docker, aucun processus n’est arrêté.');
});

test('stopping remaining processes is explicit: on in the Docker image only', async () => {
  const { readWorkerConfig } = await import('../worker/config.mjs');
  const base = {
    PLANIFIKATEUR_URL: 'https://site.example',
    PLANIFIKATEUR_AGENT_TOKEN: 'agent',
    PLANIFIKATEUR_GITHUB_TOKEN: 'github',
  };
  assert.equal(readWorkerConfig(base).stopStrays, false);
  assert.equal(readWorkerConfig({ ...base, PLANIFIKATEUR_WORKER_STOP_STRAYS: '1' }).stopStrays, true);
  assert.throws(() => readWorkerConfig({ ...base, PLANIFIKATEUR_WORKER_STOP_STRAYS: 'oui' }), /0 ou 1/);
  const { readFile } = await import('node:fs/promises');
  const dockerfile = await readFile(new URL('../worker/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /PLANIFIKATEUR_WORKER_STOP_STRAYS=1/);
  // Un checkout en umask 077 rendrait le code illisible pour l'utilisateur node.
  assert.match(dockerfile, /chmod -R a\+rX,go-w \/opt\/worker/);
});
