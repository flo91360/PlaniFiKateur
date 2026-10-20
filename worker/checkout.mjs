import { access, appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkerCommand } from './execution-profile.mjs';
import { runtimeEnvironment, checkRuntime } from './runtime.mjs';
import { isolatedCommand } from './isolation.mjs';
import { stopStrays as stopStrayProcesses } from './strays.mjs';
import {
  checkoutProblem,
  gitGuard,
  concludeMerge,
  conflictInstructions,
  mergeInProgress,
  resolveWorkerOwned,
} from './checkout-state.mjs';

const workerDirectory = dirname(fileURLToPath(import.meta.url));
// Seules ces commandes Git contactent GitHub et reçoivent le jeton.
const REMOTE_GIT = new Set(['clone', 'fetch', 'ls-remote', 'push']);

// Checkout d’une tâche : répertoire, environnements des commandes (projet isolé, Git local, Git
// distant) et préparation de la branche à jour de la branche cible, dépendances installées.
export function createCheckouts({ config, execute, state, log, clean, github, stopStrays = stopStrayProcesses }) {
  // Avant une commande qui reçoit le jeton GitHub : dans l’image Docker, aucun processus restant du
  // moteur IA ne doit pouvoir le lire (worker/strays.mjs).
  async function beforeRemote() {
    if (!config.stopStrays) return;
    const stopped = await stopStrays();
    if (stopped.length) log(`Processus restants arrêtés avant une commande Git distante : ${stopped.join(', ')}.`);
  }

  // Répertoire de la tâche et environnements de ses commandes : celles du projet, Git local et Git
  // distant (seul à recevoir le jeton GitHub).
  function workspace({ job, reservation }) {
    const profile = job.executionProfile;
    const cwd = join(config.stateRoot, 'jobs', job.id);
    const home = join(cwd, '.planifikateur', 'home');
    const npmCache = join(config.stateRoot, 'npm-cache');
    const env = {
      ...runtimeEnvironment(profile, config),
      HOME: home,
      npm_config_cache: npmCache,
      PLANIFIKATEUR_WORKER: '1',
      CI: '1',
    };
    // Git ne lance ni hook ni surveillance du système de fichiers, même si l’agent en déclarait ;
    // le jeton GitHub n’accompagne que les commandes qui contactent GitHub.
    const gitEnv = {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    };
    const gitRemoteEnv = {
      ...gitEnv,
      GIT_ASKPASS: fileURLToPath(new URL('./git-askpass.mjs', import.meta.url)),
      PLANIFIKATEUR_GIT_TOKEN: config.githubToken,
    };
    const gitEnvFor = args => (REMOTE_GIT.has(args[1]) ? gitRemoteEnv : gitEnv);
    const command = async (args, extra = {}) => {
      if (args[0] === 'git' && REMOTE_GIT.has(args[1])) await beforeRemote();
      const result = await execute(args, {
        cwd,
        env: args[0] === 'git' ? gitEnvFor(args) : env,
        signal: reservation.signal,
        ...extra,
      });
      if (result.code !== 0) throw new Error(`Échec de ${args.slice(0, 3).join(' ')} : ${clean(result.output)}`);
      return result.output.trim();
    };
    const url = `https://github.com/${job.repository}.git`;
    return { cwd, home, npmCache, env, gitEnv, gitRemoteEnv, gitEnvFor, command, url, beforeRemote };
  }

  // Checkout de la branche de la tâche à jour de la branche cible, dépendances installées.
  async function prepareCheckout(task) {
    const { job, reservation } = task;
    const { signal } = reservation;
    const profile = job.executionProfile,
      targetBranch = profile.branch;
    const { cwd, home, npmCache, env, gitEnv, gitRemoteEnv, gitEnvFor, command, url } = workspace(task);
    // Commande du projet (installation, tests) : code de la branche, exécuté isolé du worker.
    const project = args =>
      isolatedCommand(resolveWorkerCommand(args, workerDirectory), { config, cwd, writable: [npmCache] });
    const git = async args => {
      if (REMOTE_GIT.has(args[0])) await beforeRemote();
      return execute(['git', ...args], { cwd, env: gitEnvFor(['git', ...args]), signal });
    };
    await mkdir(config.stateRoot, { recursive: true });
    await checkRuntime(profile, config, execute, signal);
    await mkdir(join(config.stateRoot, 'jobs'), { recursive: true, mode: 0o700 });
    let cloned = true;
    try {
      await access(join(cwd, '.git'));
    } catch {
      cloned = false;
    }
    if (cloned) {
      // Un checkout que le worker ne sait pas remettre en état est recréé depuis GitHub :
      // la branche publiée est reprise, seul le travail jamais poussé est perdu.
      // Configuration Git, attributs ou hooks changés depuis la dernière préparation : posés par
      // l’agent pendant un tour interrompu, ils ne doivent jamais servir aux commandes du worker.
      const problem =
        job.gitGuard && job.gitGuard !== (await gitGuard(cwd))
          ? 'configuration Git locale modifiée hors du worker'
          : await checkoutProblem(cwd, git, job.branch);
      if (problem) {
        log(`Exécution ${job.id} : checkout local recréé (${problem}).`);
        await reservation.action('progress', { message: `Checkout local recréé depuis GitHub : ${problem}.` });
        await rm(cwd, { recursive: true, force: true });
        cloned = false;
      }
    }
    if (!cloned) {
      // Recover the same branch after losing the checkout; never force-push.
      await command(['git', 'clone', '--no-tags', '--single-branch', '--branch', targetBranch, url, cwd], {
        cwd: config.stateRoot,
      });
    }
    await mkdir(home, { recursive: true });
    await mkdir(npmCache, { recursive: true });
    const exclude = join(cwd, '.git', 'info', 'exclude');
    if (!(await readFile(exclude, 'utf8').catch(() => '')).split('\n').includes('.planifikateur/'))
      await appendFile(exclude, '\n.planifikateur/\n');
    await command(['git', 'config', 'user.name', 'PlaniFiKateur IA']);
    await command(['git', 'config', 'user.email', 'agent@planifikateur.invalid']);
    if ((await command(['git', 'config', '--get', 'remote.origin.url'])) !== url)
      throw new Error('L’origine du dépôt a changé.');
    await command(['git', 'fetch', 'origin', targetBranch]);
    if (!cloned) {
      const remote = await command(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${job.branch}`]);
      if (remote) {
        await command(['git', 'fetch', 'origin', `${job.branch}:refs/remotes/origin/${job.branch}`]);
        await command(['git', 'checkout', '-b', job.branch, `origin/${job.branch}`]);
      } else await command(['git', 'checkout', '-b', job.branch, `origin/${targetBranch}`]);
    }
    // L’agent ne lance aucune commande Git : le worker termine la fusion d’un tour précédent
    // dont l’agent a résolu les conflits, puis intègre la branche cible actuelle.
    let conflicts = [];
    if (await mergeInProgress(cwd)) {
      conflicts = await concludeMerge(cwd, git);
      if (!conflicts.length) log(`Exécution ${job.id} : fusion précédente avec ${targetBranch} validée par le worker.`);
    }
    if (!conflicts.length) {
      // Le travail non validé d’un tour précédent est conservé dans un commit avant la fusion.
      if (await command(['git', 'status', '--porcelain'])) {
        await command(['git', 'add', '--all']);
        await command(['git', 'commit', '--no-verify', '-m', `Travail en cours (${job.id})`]);
      }
      const merged = await git(['merge', '--no-edit', `origin/${targetBranch}`]);
      if (merged.code !== 0) {
        if (!(await mergeInProgress(cwd)))
          throw new Error(`Échec de git merge origin/${targetBranch} : ${clean(merged.output)}`);
        conflicts = await resolveWorkerOwned(git);
        if (!conflicts.length) await command(['git', 'commit', '--no-edit', '--no-verify']);
      }
    }
    await reservation.action('progress', { message: `Préparation des dépendances du profil ${profile.preset}.` });
    const legacy = reservation.run.legacyExecutionProfile;
    for (const install of legacy ? config.installCommands : profile.installCommands) await command(project(install));
    await reservation.action('progress', {
      message: 'Le dépôt est prêt. L’agent réalise la demande avant les vérifications locales.',
    });
    job.gitGuard = await gitGuard(cwd);
    await state.put(job);
    return {
      cwd,
      env,
      gitEnv,
      gitRemoteEnv,
      beforeRemote,
      project,
      command,
      url,
      targetBranch,
      testCommands: legacy ? config.testCommands : profile.testCommands,
      git,
      conflicts: conflicts.length ? conflictInstructions(targetBranch, conflicts) : '',
    };
  }

  return { workspace, prepareCheckout };
}
