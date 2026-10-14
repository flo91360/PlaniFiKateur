import { access, appendFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, validRepository } from './config.mjs';
import { ApiError, PublicationPendingError, createSiteClient, createGithubClient } from './clients.mjs';
import { createState } from './state.mjs';
import { runCommand } from './commands.mjs';
import { createCodexRunner } from './codex.mjs';
import { checkGeneratedFile, collectOutputs } from './outputs.mjs';
import { createClaudeRunner } from './claude.mjs';
import { validateAi, efforts, effortLabels } from './ai-settings.mjs';
import { defaultExecutionProfile, installedProfile, resolveWorkerCommand } from './execution-profile.mjs';
import { runtimeEnvironment, checkRuntime, projectDiagnostic } from './runtime.mjs';
import { prepareDelivery } from './delivery.mjs';
import { WorkerTimeoutError, createReservation } from './reservation.mjs';

import { checkoutFingerprint, requestFingerprint } from './checkpoint.mjs';

const workerDirectory = dirname(fileURLToPath(import.meta.url));
const MAX_ROUNDS = 3;
const engineName = engine => (engine === 'codex' ? 'Codex' : 'Claude Code');

// Un ancien worker posait cette question technique au lieu de republier sa PR ; le site la
// reconnaît aussi. Une vraie demande de précision exige toujours une réponse humaine.
const LEGACY_PUBLICATION_QUESTION = 'La PR ne pointe pas sur le commit testé.';
const legacyPublicationQuestion = run =>
  run.state === 'waiting' &&
  !!run.submissions.at(-1)?.pullRequest &&
  run.exchanges.at(-1)?.question === LEGACY_PUBLICATION_QUESTION &&
  !run.exchanges.at(-1)?.answer;

export function createWorker(config, dependencies = {}) {
  const site = dependencies.site || createSiteClient(config);
  const github = dependencies.github || createGithubClient(config.githubToken);
  const state = dependencies.state || createState(config.stateRoot);
  const model = dependencies.model || createCodexRunner(config);
  const claude = dependencies.claude || createClaudeRunner(config);
  const execute = dependencies.execute || runCommand;
  const log = dependencies.log || console.log;
  // Les tests remplacent les presets installés par les leurs ; en production, ceux du worker.
  const profileOf = dependencies.installedProfile || installedProfile;
  const clean = text =>
    [config.token, config.githubToken, config.apiKey, config.claudeApiKey, config.claudeOauthToken]
      .filter(Boolean)
      .reduce((s, secret) => s.replaceAll(secret, '[secret]'), String(text))
      .slice(-12000);
  let projects = new Map();
  const diagnostics = new Map();
  const auto = config.discovery !== 'manual';
  const allowed = run =>
    run.delivery === 'github' &&
    validId(run.id) &&
    validId(run.projectId) &&
    validId(run.cardId) &&
    validRepository(run.repository) &&
    (auto
      ? projects.has(run.projectId)
      : config.repositories.includes(run.repository.toLowerCase()) && config.projectIds.includes(run.projectId));

  // done and cancelled are terminal: the checkout and its dependencies would only fill the disk.
  async function releaseCheckout(job) {
    if (!['done', 'cancelled'].includes(job.phase) || job.checkoutReleased) return;
    await rm(join(config.stateRoot, 'jobs', job.id), { recursive: true, force: true });
    job.checkoutReleased = true;
    await state.put(job);
    log(`Exécution ${job.id} : checkout local supprimé, tâche ${job.phase === 'done' ? 'terminée' : 'annulée'}.`);
  }

  async function waitForAnswer(task, message, { resetAttempts = false } = {}) {
    await task.reservation.action('question', { message });
    task.job.phase = 'waiting';
    if (resetAttempts) task.job.attempts = 0;
    await state.put(task.job);
    return { status: 'waiting' };
  }

  // État local de l’exécution : branche, réglages IA et profil figés à la première prise en charge.
  async function loadJob(run, candidate) {
    const job = (await state.get(run.id)) || {
      id: run.id,
      projectId: run.projectId,
      cardId: run.cardId,
      repository: run.repository.toLowerCase(),
      branch: `planifikateur/${run.id}`,
      attempts: 0,
      answers: 0,
    };
    if (
      job.repository !== run.repository.toLowerCase() ||
      job.projectId !== run.projectId ||
      job.cardId !== run.cardId ||
      job.branch !== `planifikateur/${run.id}`
    )
      throw new Error('État du worker incompatible avec la carte.');
    if (!job.ai) {
      const ai = validateAi(run.aiRuntime || run.ai || { engine: 'codex', model: '' });
      job.ai = {
        ...ai,
        model: ai.model || (ai.engine === 'codex' ? config.model || '' : ''),
        effort: run.ai?.effort || '',
      };
    }
    if (!efforts[job.ai.engine]?.includes(job.ai.effort) || (run.ai && job.ai.engine !== run.ai.engine))
      throw new Error('Réglages IA incompatibles avec la conversation existante.');
    // Preset et branche figés à la première prise en charge ; commandes toujours relues dans les
    // presets installés, pour qu’une mise à jour du worker s’applique aussi aux tâches en cours.
    const profile = profileOf(job.executionProfile || run.executionProfile || defaultExecutionProfile());
    if (
      run.executionProfile &&
      (run.executionProfile.preset !== profile.preset || run.executionProfile.branch !== profile.branch)
    )
      throw new Error('Le profil ne correspond plus à cette exécution.');
    job.executionProfile = profile;
    // Une nouvelle réponse humaine, une reprise de publication ou une correction de PR
    // redonnent toutes leurs tentatives au modèle.
    const answers = run.exchanges.filter(e => e.answer).length;
    if (answers !== job.answers) {
      job.attempts = 0;
      job.answers = answers;
    }
    if (
      candidate.publicationRecovery ||
      candidate.interruption === LEGACY_PUBLICATION_QUESTION ||
      (candidate.state === 'merging' && job.phase === 'merging')
    )
      job.attempts = 0;
    return job;
  }

  // Checkout de la branche de la tâche à jour de la branche cible, dépendances installées.
  async function prepareCheckout(task) {
    const { job, reservation } = task;
    const { signal } = reservation;
    const profile = job.executionProfile,
      targetBranch = profile.branch;
    const cwd = join(config.stateRoot, 'jobs', job.id);
    const home = join(cwd, '.planifikateur', 'home');
    const env = {
      ...runtimeEnvironment(profile, config),
      HOME: home,
      npm_config_cache: join(config.stateRoot, 'npm-cache'),
      PLANIFIKATEUR_WORKER: '1',
      CI: '1',
    };
    const gitEnv = {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ASKPASS: fileURLToPath(new URL('./git-askpass.mjs', import.meta.url)),
      PLANIFIKATEUR_GIT_TOKEN: config.githubToken,
    };
    const command = async (args, extra = {}) => {
      const result = await execute(args, {
        cwd,
        env: args[0] === 'git' ? gitEnv : env,
        signal: reservation.signal,
        ...extra,
      });
      if (result.code !== 0) throw new Error(`Échec de ${args.slice(0, 3).join(' ')} : ${clean(result.output)}`);
      return result.output.trim();
    };
    const url = `https://github.com/${job.repository}.git`;
    await mkdir(config.stateRoot, { recursive: true });
    await checkRuntime(profile, config, execute, signal);
    await mkdir(join(config.stateRoot, 'jobs'), { recursive: true, mode: 0o700 });
    let cloned = true;
    try {
      await access(join(cwd, '.git'));
    } catch {
      cloned = false;
    }
    if (!cloned) {
      // Recover the same branch after losing the checkout; never force-push.
      await command(['git', 'clone', '--no-tags', '--single-branch', '--branch', targetBranch, url, cwd], {
        cwd: config.stateRoot,
      });
    }
    await mkdir(home, { recursive: true });
    await appendFile(join(cwd, '.git', 'info', 'exclude'), '\n.planifikateur/\n');
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
    } else if ((await command(['git', 'branch', '--show-current'])) !== job.branch)
      throw new Error('Le checkout ne correspond plus à la branche de la tâche.');
    // Preserve partial work and let Codex resolve any conflicts with current main.
    const merged = await execute(['git', 'merge', '--no-edit', `origin/${targetBranch}`], {
      cwd,
      env: gitEnv,
      signal,
    });
    await reservation.action('progress', { message: `Préparation des dépendances du profil ${profile.preset}.` });
    const legacy = reservation.run.legacyExecutionProfile;
    for (const install of legacy ? config.installCommands : profile.installCommands)
      await command(resolveWorkerCommand(install, workerDirectory));
    await reservation.action('progress', {
      message: 'Le dépôt est prêt. L’agent réalise la demande avant les vérifications locales.',
    });
    return {
      cwd,
      env,
      gitEnv,
      command,
      url,
      targetBranch,
      testCommands: legacy ? config.testCommands : profile.testCommands,
      conflicts: merged.code
        ? `Résous les conflits avec ${targetBranch} avant de terminer : ${clean(merged.output)}`
        : '',
    };
  }

  // Fichiers générés contrôlés, puis version et changelog préparés si le dépôt a changé.
  // Lève une erreur décrivant ce que le modèle doit corriger.
  async function checkDeliverables(task, checkout, result, previous) {
    const { run } = task.reservation;
    const outputs = await collectOutputs(checkout.cwd, result.files || [], run.id);
    const retained = (run.cardSnapshot.attachments || []).filter(file => !outputs.some(next => next.id === file.id));
    if (
      retained.length + outputs.length > 10 ||
      [...retained, ...outputs].reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024
    )
      throw new Error('La carte manque de place pour ces fichiers : dix pièces jointes maximum et 2 Mo au total.');
    const checks = [];
    for (const file of outputs) checks.push(await checkGeneratedFile(file, checkout.command));
    const repositoryChanged =
      !!(await checkout.command(['git', 'status', '--porcelain'])) ||
      !!(await checkout.command(['git', 'diff', `origin/${checkout.targetBranch}...HEAD`, '--name-only']));
    if (!outputs.length && !repositoryChanged)
      throw new Error(
        'Aucun fichier ni modification livré. Pour une demande de fichier, crée le fichier dans .planifikateur/generated/ et indique son chemin dans files. Si tu ne peux pas réaliser la demande, pose une question précise avec status=question.',
      );
    if (repositoryChanged) {
      const { version } = await prepareDelivery(checkout.cwd, task.job.executionProfile, checkout.command, {
        runId: run.id,
        title: run.cardSnapshot.title,
        summary: result.summary,
        date: new Date(task.job.checkpoint?.deliveryDate || Date.now()),
      });
      checks.push(`Livraison ${version} : version et CHANGELOG.md vérifiés avant les tests`);
    }
    return { outputs, checks, artifactOnly: outputs.length > 0 && !previous && !repositoryChanged };
  }

  // Tests obligatoires du profil ; renvoie l’échec à transmettre au modèle, ou null.
  async function runTests(task, checkout, checks) {
    for (const test of checkout.testCommands) {
      const key = JSON.stringify(test);
      const checkpoint = task.job.checkpoint;
      if (checkpoint.completedTests.includes(key)) {
        checks.push(`${test.join(' ')} : réussi (repris)`);
        continue;
      }
      await task.reservation.action('progress', { message: `Vérification locale : ${test.join(' ')}.` });
      const outcome = await execute(resolveWorkerCommand(test, workerDirectory), {
        cwd: checkout.cwd,
        env: checkout.env,
        signal: task.reservation.signal,
      });
      if (outcome.code !== 0) return `${test.join(' ')} a échoué : ${clean(outcome.output)}`;
      task.reservation.signal.throwIfAborted();
      checkpoint.completedTests.push(key);
      await state.put(task.job);
      checks.push(`${test.join(' ')} : réussi`);
    }
    return null;
  }

  // Le modèle réalise la demande ; ses livrables et les tests sont vérifiés jusqu’à trois fois,
  // chaque échec lui étant renvoyé pour correction. Renvoie le résultat validé ou sa question.
  async function produce(task, checkout, previous, ciFeedback = '') {
    const { job, reservation } = task;
    const runner = job.ai.engine === 'claude-code' ? claude : model;
    const onRuntime = async runtime => {
      const safe = { ...validateAi(runtime), effort: job.ai.effort };
      if (JSON.stringify(job.aiRuntime) === JSON.stringify(safe)) return;
      if (safe.engine !== job.ai.engine) throw new Error('Le moteur de la conversation a changé.');
      job.aiRuntime = safe;
      job.ai.model = safe.model;
      await state.put(job);
      await reservation.action('progress', {
        aiRuntime: safe,
        message: `IA utilisée : ${engineName(safe.engine)} · ${safe.model} · effort ${effortLabels[safe.effort]}.`,
      });
    };
    let feedback = [checkout.conflicts, ciFeedback].filter(Boolean).join('\n\n');
    let cached = job.checkpoint;
    if (cached) {
      try {
        if (
          cached.format !== 1 ||
          checkout.conflicts ||
          cached.context !== requestFingerprint(reservation.run, job) ||
          cached.fingerprint !== (await checkoutFingerprint(checkout, cached.result, job.id))
        )
          cached = undefined;
      } catch (error) {
        if (reservation.signal.aborted) throw error;
        cached = undefined;
      }
      if (!cached) {
        delete job.checkpoint;
        await state.put(job);
      }
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let result = cached?.result;
      if (result) {
        await reservation.action('progress', {
          message: 'Résultat IA sauvegardé : reprise des vérifications sans nouvel appel au modèle.',
        });
      } else {
        if (!task.attemptStarted) {
          if (job.attempts >= config.maxAttempts)
            return {
              status: 'question',
              question:
                'Les tentatives automatiques du modèle n’ont pas abouti. Pouvez-vous préciser la demande ou corriger sa configuration ?',
            };
          job.attempts++;
          task.attemptStarted = true;
          await state.put(job);
        }
        result = await reservation.phase('travail IA', config.modelTimeoutMs, () =>
          runner.run({
            // Le profil montré au modèle est celui que le worker exécute réellement.
            run: { ...reservation.run, leaseToken: undefined, executionProfile: job.executionProfile },
            job,
            cwd: checkout.cwd,
            signal: reservation.signal,
            feedback,
            environment: checkout.env,
            onRuntime,
            onThread: async id => {
              job.threadId = id;
              await state.put(job);
            },
          }),
        );
        if (result.status === 'question') return { status: 'question', question: result.question };
        // Only persist the structured result, never runner credentials or output payloads.
        result = { status: 'result', summary: clean(result.summary), question: '', files: result.files || [] };
        job.checkpoint = {
          format: 1,
          result,
          context: requestFingerprint(reservation.run, job),
          deliveryDate: new Date().toISOString(),
          completedTests: [],
        };
      }
      let deliverables, failure;
      await reservation.phase('vérifications locales', config.testsTimeoutMs, async () => {
        try {
          if (!cached) {
            job.checkpoint.fingerprint = await checkoutFingerprint(checkout, result, job.id);
            await state.put(job);
          }
          deliverables = await checkDeliverables(task, checkout, result, previous);
        } catch (error) {
          if (reservation.signal.aborted) throw error;
          failure = `Corrige les fichiers à livrer : ${clean(error.message)}`;
        }
        if (!failure) {
          const fingerprint = await checkoutFingerprint(checkout, result, job.id);
          if (job.checkpoint.fingerprint !== fingerprint) job.checkpoint.completedTests = [];
          job.checkpoint.fingerprint = fingerprint;
          await state.put(job);
          if (!deliverables.artifactOnly) failure = await runTests(task, checkout, deliverables.checks);
          if (!failure && fingerprint !== (await checkoutFingerprint(checkout, result, job.id)))
            failure = 'Le contenu du dépôt a changé pendant les tests ; les vérifications doivent être refaites.';
        }
      });
      if (!failure) return { result, ...deliverables };
      delete job.checkpoint;
      await state.put(job);
      cached = undefined;
      if (round === MAX_ROUNDS - 1) throw new Error(failure);
      feedback = `Corrige l’échec puis propose à nouveau le résultat : ${failure}`;
    }
  }

  // Commit, push et PR (ou fichiers seuls livrés dans la carte), puis soumission au site.
  async function publish(task, checkout, { result, checks, outputs, artifactOnly }) {
    const { job, reservation } = task;
    const { run, signal } = reservation;
    const { command, targetBranch } = checkout;
    await reservation.action('heartbeat');
    if (
      (await command(['git', 'config', '--get', 'remote.origin.url'])) !== checkout.url ||
      (await command(['git', 'branch', '--show-current'])) !== job.branch
    )
      throw new Error('La branche ou l’origine a été modifiée par l’agent.');
    const files = outputs.map(({ path, ...file }) => file);
    if (artifactOnly) {
      await reservation.action('submit', {
        summary: result.summary,
        checks: checks.join('\n'),
        links: [],
        files,
        artifactOnly: true,
      });
      job.phase = 'done';
      job.attempts = 0;
      await state.put(job);
      log(`Exécution ${run.id} : fichiers livrés dans la carte, tâche terminée.`);
      await releaseCheckout(job);
      return { status: 'done', files: files.map(file => file.name) };
    }
    await command(['git', 'add', '--all']);
    if (await command(['git', 'diff', '--cached', '--name-only']))
      await command(['git', 'commit', '-m', `Carte ${run.cardSnapshot.title.slice(0, 120)} (${run.id})`]);
    if (!(await command(['git', 'diff', `origin/${targetBranch}...HEAD`, '--name-only'])))
      return waitForAnswer(
        task,
        'La tâche n’a produit aucune modification par rapport à main. Pouvez-vous préciser ce qui doit changer ?',
      );
    const sha = await command(['git', 'rev-parse', 'HEAD']);
    await reservation.action('progress', {
      message: 'Les tests locaux ont réussi. Le worker publie la branche et prépare la PR.',
    });
    const pushed = await execute(['git', 'push', 'origin', `HEAD:refs/heads/${job.branch}`], {
      cwd: checkout.cwd,
      env: checkout.gitEnv,
      signal,
    });
    if (pushed.code !== 0) {
      // Retrying cannot fix a missing token permission: ask for the configuration change.
      if (!workflowScopeRefused(pushed.output)) throw new Error(`Échec de git push origin : ${clean(pushed.output)}`);
      const workflows = (
        await command(['git', 'diff', `origin/${targetBranch}...HEAD`, '--name-only', '--', '.github/workflows'])
      )
        .split('\n')
        .filter(Boolean);
      const waiting = await waitForAnswer(task, workflowScopeQuestion(workflows), { resetAttempts: true });
      log(`Exécution ${run.id} : publication refusée, le token GitHub ne peut pas modifier les workflows.`);
      return waiting;
    }
    // PR starts unlabeled. Only enable merging after the site has bound this SHA.
    const pr = await github.ensurePullRequest(
      job.repository,
      job.branch,
      run.cardSnapshot.title.slice(0, 140),
      `${result.summary}\n\nCarte PlaniFiKateur : ${run.cardId}\nExécution : ${run.id}\n\nVérifications locales :\n${checks.map(c => `- ${c}`).join('\n')}`,
      signal,
      sha,
      targetBranch,
    );
    if (pr.head.sha !== sha) throw new Error(LEGACY_PUBLICATION_QUESTION);
    job.pullRequest = { number: pr.number, url: pr.html_url, headSha: sha };
    job.phase = 'pr';
    await state.put(job);
    await reservation.action('submit', {
      summary: result.summary,
      checks: checks.join('\n'),
      links: [pr.html_url],
      pullRequest: { url: pr.html_url, headSha: sha },
      files,
    });
    job.phase = 'merging';
    job.attempts = 0;
    await state.put(job);
    await github.label(job.repository, pr.number, signal);
    log(`Exécution ${run.id} : PR #${pr.number}, tests GitHub et fusion en attente.`);
    return { status: 'merging', number: pr.number, sha };
  }

  // Après un échec des contrôles GitHub, le modèle reçoit les jobs et étapes en échec avec la fin
  // de leurs journaux, plutôt qu’un simple « les contrôles ont échoué ».
  async function failedChecksFeedback({ job, reservation }) {
    const checks = reservation.run.githubChecks;
    if (checks?.conclusion !== 'failure' || !Number.isSafeInteger(checks.runId) || !github.failedChecks) return '';
    const intro = `Les contrôles GitHub de la PR ont échoué${checks.url ? ` (${checks.url})` : ''}.`;
    try {
      const failed = await github.failedChecks(job.repository, checks.runId, reservation.signal);
      if (!failed.length) return `${intro} Reproduis l’échec localement et corrige sa cause.`;
      return `${intro} Corrige la cause de ces échecs :\n\n${failed
        .map(
          check =>
            `Job « ${check.name} »${check.steps.length ? ` — étapes en échec : ${check.steps.join(', ')}` : ''}${check.log ? `\nFin du journal :\n${clean(check.log)}` : ''}`,
        )
        .join('\n\n')}`;
    } catch (error) {
      if (reservation.signal.aborted) throw error;
      return `${intro} Leurs journaux sont indisponibles (${clean(error.message)}) : reproduis l’échec localement et corrige sa cause.`;
    }
  }

  // Une tentative complète : checkout, réalisation et vérifications, publication.
  async function attempt(task) {
    const { candidate, job, reservation } = task;
    if (candidate.workerQuestion) return waitForAnswer(task, candidate.workerQuestion);
    job.phase = 'running';
    await state.put(job);
    const previous = reservation.run.submissions.at(-1)?.pullRequest || job.pullRequest;
    if (previous) {
      const pr = await github.pull(job.repository, previous.number, reservation.signal);
      if (pr.state === 'open' && pr.labels.some(l => l.name === 'planifikateur-agent'))
        await github.unlabel(job.repository, pr.number, reservation.signal);
    }
    log(`Prise en charge ${reservation.run.id}.`);
    const ciFeedback = await failedChecksFeedback(task);
    await reservation.action('progress', {
      message: `Le worker prépare le dépôt et lance ${engineName(job.ai.engine)}.`,
    });
    const checkout = await reservation.phase('préparation du dépôt', config.setupTimeoutMs, () =>
      prepareCheckout(task),
    );
    const produced = await produce(task, checkout, previous, ciFeedback);
    if (produced.status === 'question') return waitForAnswer(task, produced.question);
    return reservation.phase('publication', config.publicationTimeoutMs, () => publish(task, checkout, produced));
  }

  // Échec ou arrêt : l’exécution est interrompue sur le site (ou passe en question après
  // trop de tentatives) et le worker attend une minute avant de la reprendre.
  async function suspend(task, error, parentSignal) {
    const { job, reservation } = task;
    const { signal } = reservation;
    // Infrastructure failures and shutdowns must not exhaust the model retry budget.
    const publicationPending = error instanceof PublicationPendingError;
    if (task.attemptStarted && (reservation.failed || parentSignal?.aborted || publicationPending))
      job.attempts = Math.max(0, job.attempts - 1);
    // A failed final label is recovered by reconcile; never resubmit a merged task.
    const history = await site.history(reservation.run).catch(() => []);
    let current = history.find(item => item.id === reservation.run.id);
    if (current?.state === 'running') {
      const exhausted =
        !(error instanceof WorkerTimeoutError) &&
        !signal.aborted &&
        !publicationPending &&
        job?.attempts >= config.maxAttempts;
      const message = reservation.failed
        ? reservation.failure
        : parentSignal?.aborted
          ? 'Le worker a été arrêté. Une reprise est possible.'
          : error instanceof WorkerTimeoutError
            ? error.message
            : signal.aborted
              ? clean(signal.reason?.message || 'Exécution interrompue.')
              : error.message;
      current = await site
        .action({ ...current, leaseToken: reservation.token }, exhausted ? 'question' : 'interrupt', {
          message: clean(message).slice(0, 10000),
        })
        .catch(() => current);
    }
    if (job) {
      job.phase = current?.state || 'interrupted';
      job.retryAfter = Date.now() + 60000;
      await state.put(job);
    }
    log(
      `Exécution ${reservation.run.id} suspendue : ${clean(reservation.failed ? reservation.failure : error.message)}`,
    );
    return { status: 'interrupted' };
  }

  async function processTask(candidate, parentSignal) {
    if (!allowed(candidate)) return { status: 'ignored' };
    let run;
    try {
      const action = candidate.state === 'merging' || candidate.publicationRecovery ? 'revise' : 'claim';
      run = await site.action(candidate, action, {}, parentSignal);
    } catch (error) {
      if (error.status === 409) return { status: 'claimed_elsewhere' };
      throw error;
    }
    const reservation = createReservation({ site, run, config, log, parentSignal });
    const task = { candidate, reservation, job: undefined, attemptStarted: false };
    try {
      task.job = await loadJob(run, candidate);
      return await attempt(task);
    } catch (error) {
      return suspend(task, error, parentSignal);
    } finally {
      await reservation.stop();
    }
  }

  // Un projet en erreur (dépôt inaccessible, clé retirée…) n’empêche pas de servir les autres :
  // l’erreur est journalisée une fois, puis le projet est réessayé au tour suivant.
  const projectErrors = new Map();
  async function isolated(projectId, signal, callback) {
    try {
      const result = await callback();
      if (projectErrors.delete(projectId)) log(`Projet ${projectId} : traitement rétabli.`);
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = clean(error.message);
      if (projectErrors.get(projectId) !== message)
        log(`Projet ${projectId} : traitement impossible (${message}). Les autres projets continuent.`);
      projectErrors.set(projectId, message);
      return null;
    }
  }

  // Message de suivi journalisé une seule fois tant que la situation ne change pas.
  async function note(job, reason, message) {
    if (job.mergeReason === reason) return;
    job.mergeReason = reason;
    await state.put(job);
    log(message);
  }

  // Suivi d’une tâche connue : état sur le site, PR et fusion. Renvoie la tâche à reprendre, ou null.
  async function reconcileJob(job, signal) {
    if (['done', 'cancelled'].includes(job.phase)) {
      await releaseCheckout(job);
      return null;
    }
    if (auto && !projects.has(job.projectId)) {
      if (job.phase !== 'unauthorized') {
        job.phase = 'unauthorized';
        await state.put(job);
        log(`Exécution ${job.id} suspendue localement : projet non autorisé ou supprimé.`);
      }
      return null;
    }
    let history;
    try {
      history = await site.history(job, signal);
    } catch (error) {
      // Site injoignable ou clé refusée : toutes les tâches sont concernées, le tour s’arrête.
      if (!(error instanceof ApiError) || error.status !== 404 || error.code !== 'card_not_found')
        throw Object.assign(error, { siteError: true });
      job.phase = 'cancelled';
      await state.put(job);
      log(`Exécution ${job.id} archivée localement : carte absente de son projet.`);
      return null;
    }
    const run = history.find(r => r.id === job.id);
    if (!run) {
      job.phase = 'cancelled';
      await state.put(job);
      log(`Exécution ${job.id} archivée localement : exécution absente de la carte.`);
      return null;
    }
    if (allowed(run) && legacyPublicationQuestion(run)) {
      const pr = await github.pull(run.repository, run.submissions.at(-1).pullRequest.number, signal);
      if (
        pr.state === 'open' &&
        pr.head.ref === job.branch &&
        pr.head.repo?.full_name?.toLowerCase() === run.repository.toLowerCase() &&
        pr.base?.ref === (run.executionProfile?.branch || 'main')
      ) {
        log(`Exécution ${run.id} : reprise automatique de la publication interrompue.`);
        return { ...run, publicationRecovery: true };
      }
    }
    if (['done', 'cancelled', 'waiting', 'review'].includes(run.state)) {
      if (job.phase !== run.state) {
        job.phase = run.state;
        await state.put(job);
        log(`Exécution ${job.id} : ${run.state}.`);
      }
      await releaseCheckout(job);
      return null;
    }
    if (run.state !== 'merging' || !allowed(run)) return null;
    const submission = run.submissions.at(-1)?.pullRequest;
    const profile = profileOf(job.executionProfile || run.executionProfile || defaultExecutionProfile());
    if (!submission) return null;
    const pr = await github.pull(run.repository, submission.number, signal);
    if (pr.state !== 'open') {
      if (!pr.merged)
        return {
          ...run,
          workerQuestion: 'La PR a été fermée sans fusion. Souhaitez-vous reprendre cette tâche ou l’annuler ?',
        };
      // A merged PR is only completed by the signed GitHub webhook or the site's own GitHub check.
      await note(job, 'merged', `Exécution ${run.id} : PR fusionnée, confirmation du site attendue.`);
      return null;
    }
    if (pr.head.sha !== submission.headSha || pr.head.repo?.full_name?.toLowerCase() !== run.repository.toLowerCase()) {
      await note(
        job,
        'head_changed',
        `Exécution ${run.id} : le commit de la PR a changé hors du worker ; elle ne sera pas fusionnée automatiquement.`,
      );
      return null;
    }
    if (await github.behindMain(run.repository, pr.head.sha, signal, profile.branch)) return run;
    if (!pr.labels.some(l => l.name === 'planifikateur-agent')) await github.label(run.repository, pr.number, signal);
    let merged;
    try {
      merged = await github.mergeWhenReady(
        run.repository,
        pr,
        data => site.mergeEligible(data, signal),
        signal,
        profile,
      );
    } catch (error) {
      const message = clean(error.message);
      if (job.mergeReason !== message) {
        job.mergeReason = message;
        await state.put(job);
        log(`Exécution ${run.id} : fusion automatique bloquée : ${message}. Le worker réessaiera sans relancer Codex.`);
      }
      return null;
    }
    if (merged.merged) {
      log(
        `Exécution ${run.id} : PR #${pr.number} fusionnée après réussite des tests GitHub, notification du site attendue.`,
      );
    } else if (job.mergeReason !== merged.reason) {
      job.mergeReason = merged.reason;
      await state.put(job);
      log(`Exécution ${run.id} : fusion en attente (${merged.reason}).`);
    }
    return null;
  }

  // Une erreur sur une tâche (dépôt renommé, PR inaccessible…) ne bloque pas les autres : la tâche
  // est réessayée plus tard, avec un délai croissant, et l’erreur n’est journalisée qu’une fois.
  async function reconcile(signal) {
    for (const job of await state.all()) {
      if (job.followUp?.retryAfter > Date.now()) continue;
      try {
        const candidate = await reconcileJob(job, signal);
        if (job.followUp) {
          delete job.followUp;
          await state.put(job);
          log(`Exécution ${job.id} : suivi rétabli.`);
        }
        if (candidate) return candidate;
      } catch (error) {
        if (signal?.aborted || error.siteError) throw error;
        const message = clean(error.message);
        const failures = (job.followUp?.failures || 0) + 1;
        const minutes = Math.min(30, 2 ** (failures - 1));
        if (job.followUp?.error !== message)
          log(
            `Exécution ${job.id} : suivi impossible (${message}). Nouvelle tentative dans ${minutes} min ; les autres tâches continuent.`,
          );
        job.followUp = { error: message, failures, retryAfter: Date.now() + minutes * 60000 };
        await state.put(job);
      }
    }
    return null;
  }

  return {
    processTask,
    async tick(signal) {
      if (auto) {
        const discovered = await site.projects(signal);
        projects = new Map(
          discovered
            .filter(project => validId(project.id) && (!project.repository || validRepository(project.repository)))
            .map(project => [project.id, project]),
        );
        await mkdir(config.stateRoot, { recursive: true });
        for (const project of projects.values()) {
          const key = JSON.stringify(project),
            previous = diagnostics.get(project.id);
          if (previous?.key === key && previous.expires > Date.now()) continue;
          await isolated(project.id, signal, async () => {
            const report = await projectDiagnostic(project, config, github, execute, signal);
            report.checks.forEach(check => {
              check.message = clean(check.message);
            });
            await site.diagnostic(project.id, report, signal);
            diagnostics.set(project.id, { key, expires: Date.now() + 60000, report });
            log(
              `Projet ${project.name} : ${report.state === 'ready' ? 'configuration contrôlée' : 'configuration à compléter (voir les paramètres du projet)'}.`,
            );
          });
        }
      }
      const revise = await reconcile(signal);
      if (revise) return processTask(revise, signal);
      for (const projectId of auto ? projects.keys() : config.projectIds) {
        const handled = await isolated(projectId, signal, async () => {
          for (const candidate of await site.queue(projectId, signal)) {
            if (!allowed(candidate)) continue;
            const job = await state.get(candidate.id);
            if (job?.retryAfter > Date.now()) continue;
            if (auto) {
              const project = projects.get(projectId);
              const execution = {
                ...project,
                repository: candidate.repository,
                executionProfile: profileOf(candidate.executionProfile || project.executionProfile),
                ai: validateAi(job?.ai || candidate.aiRuntime || candidate.ai || project.ai),
              };
              const key = JSON.stringify(execution),
                cacheKey = `${projectId}:execution:${key}`;
              let report = diagnostics.get(cacheKey);
              if (!report || report.expires <= Date.now()) {
                report = {
                  report: await projectDiagnostic(execution, config, github, execute, signal),
                  expires: Date.now() + 60000,
                };
                diagnostics.set(cacheKey, report);
                if (diagnostics.size > 1000)
                  for (const [key, value] of diagnostics) if (value.expires <= Date.now()) diagnostics.delete(key);
              }
              if (report.report.state !== 'ready') continue;
            }
            return { result: await processTask(candidate, signal) };
          }
          return null;
        });
        if (handled) return handled.result;
      }
      return { status: 'idle' };
    },
  };
}

export function workflowScopeRefused(output) {
  return /refusing to allow an? (Personal Access Token|OAuth App|GitHub App)[^\n]*(create or update )?workflow/i.test(
    String(output),
  );
}

export function workflowScopeQuestion(files = []) {
  const list = files.length ? ` (${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''})` : '';
  return (
    `GitHub refuse la publication : la modification touche un workflow GitHub Actions${list} et le token PLANIFIKATEUR_GITHUB_TOKEN du worker n’a pas le droit de modifier les workflows. ` +
    'Ajoutez la portée « workflow » (token classique) ou la permission « Workflows : lecture et écriture » (token à granularité fine ou GitHub App), redémarrez le worker, puis répondez ici pour relancer la publication. ' +
    'Si le workflow ne devait pas changer, précisez-le et la modification sera refaite sans y toucher.'
  );
}
