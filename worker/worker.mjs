import { access, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, validRepository } from './config.mjs';
import { ApiError, PublicationPendingError, createSiteClient, createGithubClient, connectionDiagnostic, temporaryConnectionError } from './clients.mjs';
import { createState } from './state.mjs';
import { commandEnvironment, runCommand } from './commands.mjs';
import { createCodexRunner } from './codex.mjs';
import { collectOutputs } from './outputs.mjs';
import { createClaudeRunner } from './claude.mjs';
import { validateAi, efforts, effortLabels } from './ai-settings.mjs';
import { defaultExecutionProfile, validateExecutionProfile } from './execution-profile.mjs';
import { runtimeEnvironment, checkRuntime, projectDiagnostic } from './runtime.mjs';
import { bumpProjectVersion } from './project-version.mjs';

export function createWorker(config, dependencies = {}) {
  const site = dependencies.site || createSiteClient(config);
  const github = dependencies.github || createGithubClient(config.githubToken);
  const state = dependencies.state || createState(config.stateRoot);
  const model = dependencies.model || createCodexRunner(config);
  const claude = dependencies.claude || createClaudeRunner(config);
  const execute = dependencies.execute || runCommand;
  const log = dependencies.log || console.log;
  const clean = text => [config.token, config.githubToken, config.apiKey, config.claudeApiKey, config.claudeOauthToken].filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[secret]'), String(text)).slice(-12000);
  let projects = new Map();
  const diagnostics = new Map();
  const auto = config.discovery !== 'manual';
  const allowed = run => run.delivery === 'github' && validId(run.id) && validId(run.projectId) && validId(run.cardId) && validRepository(run.repository) && (auto ? projects.has(run.projectId) : config.repositories.includes(run.repository.toLowerCase()) && config.projectIds.includes(run.projectId));

  async function processTask(candidate, parentSignal) {
    if (!allowed(candidate)) return { status: 'ignored' };
    let run;
    try { run = await site.action(candidate, candidate.state === 'merging' || candidate.publicationRecovery ? 'revise' : 'claim', {}, parentSignal); }
    catch (error) { if (error.status === 409) return { status: 'claimed_elsewhere' }; throw error; }
    const lease = run.leaseToken;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.taskTimeoutMs), ...(parentSignal ? [parentSignal] : [])]);
    let leaseDeadline = Date.parse(run.leaseExpiresAt), leaseTimer, reservationFailure = false;
    const renewDeadline = response => {
      const expires = Date.parse(response.leaseExpiresAt);
      if (!Number.isFinite(expires)) return;
      leaseDeadline = Math.max(leaseDeadline || 0, expires);
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(() => {
        reservationFailure = true;
        controller.abort(new Error('Réservation expirée : le site n’a pas confirmé sa prolongation.'));
      }, Math.max(0, leaseDeadline - Date.now()));
      leaseTimer.unref();
    };
    renewDeadline(run);
    const action = async (name, data = {}, actionSignal = signal) => {
      run = { ...await site.action({ ...run, leaseToken: lease }, name, data, actionSignal), leaseToken: lease };
      if (run.state === 'running') renewDeadline(run);
      else { clearInterval(timer); clearTimeout(leaseTimer); }
      return run;
    };
    let heartbeating = false, heartbeatPromise;
    const timer = setInterval(() => {
      if (heartbeating || signal.aborted) return;
      heartbeating = true;
      // Heartbeat does not change the version; do not overwrite a parallel action.
      heartbeatPromise = site.action({ ...run, leaseToken: lease }, 'heartbeat', {}, signal)
        .then(response => { if (run.state === 'running') renewDeadline(response); })
        .catch(error => {
          if (signal.aborted || run.state !== 'running') return;
          const diagnostic = connectionDiagnostic(error);
          if (temporaryConnectionError(error) && Date.now() < leaseDeadline) {
            log(`Exécution ${run.id} : prolongation temporairement indisponible (${diagnostic}), nouvelle tentative prévue.`);
            return;
          }
          reservationFailure = true;
          controller.abort(new Error(temporaryConnectionError(error) && Date.now() >= leaseDeadline
            ? 'Réservation expirée : le site n’a pas confirmé sa prolongation.'
            : `Réservation perdue (${diagnostic}).`));
        })
        .finally(() => { heartbeating = false; });
    }, config.heartbeatMs);
    timer.unref();
    let job, attemptStarted = false;
    try {
      job = await state.get(run.id) || { id: run.id, projectId: run.projectId, cardId: run.cardId, repository: run.repository.toLowerCase(), branch: `planifikateur/${run.id}`, attempts: 0, answers: 0 };
      if (job.repository !== run.repository.toLowerCase() || job.projectId !== run.projectId || job.cardId !== run.cardId || job.branch !== `planifikateur/${run.id}`) throw new Error('État du worker incompatible avec la carte.');
      if (!job.ai) {
        const ai = validateAi(run.aiRuntime || run.ai || { engine: 'codex', model: '' });
        job.ai = { ...ai, model: ai.model || (ai.engine === 'codex' ? config.model || '' : ''), effort: run.ai?.effort || '' };
      }
      if (!efforts[job.ai.engine]?.includes(job.ai.effort) || run.ai && job.ai.engine !== run.ai.engine) throw new Error('Réglages IA incompatibles avec la conversation existante.');
      const runner = job.ai.engine === 'claude-code' ? claude : model;
      const onRuntime = async runtime => {
        const safe = { ...validateAi(runtime), effort: job.ai.effort };
        if (JSON.stringify(job.aiRuntime) === JSON.stringify(safe)) return;
        if (safe.engine !== job.ai.engine) throw new Error('Le moteur de la conversation a changé.');
        job.aiRuntime = safe; job.ai.model = safe.model; await state.put(job);
        await action('progress', { aiRuntime: safe, message: `IA utilisée : ${safe.engine === 'codex' ? 'Codex' : 'Claude Code'} · ${safe.model} · effort ${effortLabels[safe.effort]}.` });
      };
      if (!job.executionProfile) job.executionProfile = validateExecutionProfile(run.executionProfile || defaultExecutionProfile());
      if (run.executionProfile && JSON.stringify(job.executionProfile) !== JSON.stringify(run.executionProfile)) throw new Error('Le profil ne correspond plus à cette exécution.');
      const profile = job.executionProfile, targetBranch = profile.branch;
      const answers = run.exchanges.filter(e => e.answer).length;
      if (answers !== job.answers) { job.attempts = 0; job.answers = answers; }
      if (candidate.publicationRecovery || candidate.interruption === 'La PR ne pointe pas sur le commit testé.' || candidate.state === 'merging' && job.phase === 'merging') job.attempts = 0;
      if (candidate.workerQuestion) {
        await action('question', { message: candidate.workerQuestion }); job.phase = 'waiting'; await state.put(job);
        return { status: 'waiting' };
      }
      if (job.attempts >= config.maxAttempts) {
        await action('question', { message: 'Les tentatives automatiques n’ont pas abouti. Pouvez-vous préciser la demande ou faire corriger la configuration du worker avant une nouvelle reprise ?' });
        return { status: 'waiting' };
      }
      job.attempts++; attemptStarted = true; job.phase = 'running'; await state.put(job);
      const previous = run.submissions.at(-1)?.pullRequest || job.pullRequest;
      if (previous) {
        const pr = await github.pull(job.repository, previous.number, signal);
        if (pr.state === 'open' && pr.labels.some(l => l.name === 'planifikateur-agent')) await github.unlabel(job.repository, pr.number, signal);
      }
      log(`Prise en charge ${run.id}.`);
      await action('progress', { message: `Le worker prépare le dépôt et lance ${job.ai.engine === 'codex' ? 'Codex' : 'Claude Code'}.` });
      const cwd = join(config.stateRoot, 'jobs', run.id);
      const home = join(cwd, '.planifikateur', 'home');
      const env = { ...runtimeEnvironment(profile, config), HOME: home, npm_config_cache: join(config.stateRoot, 'npm-cache'), PLANIFIKATEUR_WORKER: '1', CI: '1' };
      const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: fileURLToPath(new URL('./git-askpass.mjs', import.meta.url)), PLANIFIKATEUR_GIT_TOKEN: config.githubToken };
      const command = async (args, extra = {}) => {
        const result = await execute(args, { cwd, env: args[0] === 'git' ? gitEnv : env, signal, ...extra });
        if (result.code !== 0) throw new Error(`Échec de ${args.slice(0, 3).join(' ')} : ${clean(result.output)}`);
        return result.output.trim();
      };
      const url = `https://github.com/${job.repository}.git`;
      await mkdir(config.stateRoot, { recursive: true });
      await checkRuntime(profile, config, execute, signal);
      await mkdir(join(config.stateRoot, 'jobs'), { recursive: true, mode: 0o700 });
      let cloned = true; try { await access(join(cwd, '.git')); } catch { cloned = false; }
      if (!cloned) {
        // Recover the same branch after losing the checkout; never force-push.
        await command(['git', 'clone', '--no-tags', '--single-branch', '--branch', targetBranch, url, cwd], { cwd: config.stateRoot });
      }
      await mkdir(home, { recursive: true });
      await appendFile(join(cwd, '.git', 'info', 'exclude'), '\n.planifikateur/\n');
      await command(['git', 'config', 'user.name', 'PlaniFiKateur IA']);
      await command(['git', 'config', 'user.email', 'agent@planifikateur.invalid']);
      if (await command(['git', 'config', '--get', 'remote.origin.url']) !== url) throw new Error('L’origine du dépôt a changé.');
      await command(['git', 'fetch', 'origin', targetBranch]);
      if (!cloned) {
        const remote = await command(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${job.branch}`]);
        if (remote) {
          await command(['git', 'fetch', 'origin', `${job.branch}:refs/remotes/origin/${job.branch}`]);
          await command(['git', 'checkout', '-b', job.branch, `origin/${job.branch}`]);
        } else await command(['git', 'checkout', '-b', job.branch, `origin/${targetBranch}`]);
      } else if (await command(['git', 'branch', '--show-current']) !== job.branch) throw new Error('Le checkout ne correspond plus à la branche de la tâche.');
      // Preserve partial work and let Codex resolve any conflicts with current main.
      const merged = await execute(['git', 'merge', '--no-edit', `origin/${targetBranch}`], { cwd, env: gitEnv, signal });
      let feedback = merged.code ? `Résous les conflits avec ${targetBranch} avant de terminer : ${clean(merged.output)}` : '';
      await action('progress', { message: `Préparation des dépendances du profil ${profile.preset}.` });
      for (const install of run.legacyExecutionProfile ? config.installCommands : profile.installCommands) await command(install);
      await action('progress', { message: 'Le dépôt est prêt. L’agent réalise la demande avant les vérifications locales.' });
      let result, checks = [], outputs = [], artifactOnly = false;
      for (let round = 0; round < 3; round++) {
        result = await runner.run({ run: { ...run, leaseToken: undefined }, job, cwd, signal, feedback, environment: env, onRuntime, onThread: async id => { job.threadId = id; await state.put(job); } });
        if (result.status === 'question') {
          await action('question', { message: result.question }); job.phase = 'waiting'; await state.put(job);
          return { status: 'waiting' };
        }
        checks = []; let failure;
        try {
          outputs = await collectOutputs(cwd, result.files || [], run.id);
          const retained = (run.cardSnapshot.attachments || []).filter(file => !outputs.some(next => next.id === file.id));
          if (retained.length + outputs.length > 10 || [...retained, ...outputs].reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error('La carte manque de place pour ces fichiers : dix pièces jointes maximum et 2 Mo au total.');
          for (const file of outputs) {
            if (file.name.endsWith('.ui')) {
              await command(['python3', '-c', 'import sys,xml.etree.ElementTree as ET; r=ET.parse(sys.argv[1]).getroot(); w=r.find("widget"); assert r.tag=="ui" and r.get("version")=="4.0" and r.findtext("class") and w is not None and w.get("class") and w.get("name"), "Document Qt Designer .ui incomplet"', file.path]);
              checks.push(`${file.name} : structure XML Qt Designer vérifiée`);
            } else if (file.name.endsWith('.json')) {
              JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'));
              checks.push(`${file.name} : JSON valide`);
            } else checks.push(`${file.name} : fichier généré (${file.size} octets)`);
          }
          const repositoryChanged = !!await command(['git', 'status', '--porcelain']) || !!await command(['git', 'diff', `origin/${targetBranch}...HEAD`, '--name-only']);
          if (!outputs.length && !repositoryChanged) throw new Error('Aucun fichier ni modification livré. Pour une demande de fichier, crée le fichier dans .planifikateur/generated/ et indique son chemin dans files. Si tu ne peux pas réaliser la demande, pose une question précise avec status=question.');
          artifactOnly = outputs.length > 0 && !previous && !repositoryChanged;
          if (repositoryChanged) {
            const version = await bumpProjectVersion(cwd, profile, command);
            if (version) checks.push(`Version ${version} : préparée avant les tests`);
          }
        } catch (error) { failure = `Corrige les fichiers à livrer : ${clean(error.message)}`; }
        for (const test of failure || artifactOnly ? [] : run.legacyExecutionProfile ? config.testCommands : profile.testCommands) {
          await action('progress', { message: `Vérification locale : ${test.join(' ')}.` });
          const outcome = await execute(test, { cwd, env, signal });
          if (outcome.code !== 0) { failure = `${test.join(' ')} a échoué : ${clean(outcome.output)}`; break; }
          checks.push(`${test.join(' ')} : réussi`);
        }
        if (!failure) break;
        if (round === 2) throw new Error(failure);
        feedback = `Corrige l’échec puis propose à nouveau le résultat : ${failure}`;
      }
      await action('heartbeat');
      if (await command(['git', 'config', '--get', 'remote.origin.url']) !== url || await command(['git', 'branch', '--show-current']) !== job.branch) throw new Error('La branche ou l’origine a été modifiée par l’agent.');
      const deliveredFiles = outputs.map(({ path, ...file }) => file);
      if (artifactOnly) {
        await action('submit', { summary: result.summary, checks: checks.join('\n'), links: [], files: deliveredFiles, artifactOnly: true });
        job.phase = 'done'; job.attempts = 0; await state.put(job);
        log(`Exécution ${run.id} : fichiers livrés dans la carte, tâche terminée.`);
        return { status: 'done', files: deliveredFiles.map(file => file.name) };
      }
      await command(['git', 'add', '--all']);
      if (await command(['git', 'diff', '--cached', '--name-only'])) await command(['git', 'commit', '-m', `Carte ${run.cardSnapshot.title.slice(0, 120)} (${run.id})`]);
      const changed = await command(['git', 'diff', `origin/${targetBranch}...HEAD`, '--name-only']);
      if (!changed) {
        await action('question', { message: 'La tâche n’a produit aucune modification par rapport à main. Pouvez-vous préciser ce qui doit changer ?' });
        job.phase = 'waiting'; await state.put(job); return { status: 'waiting' };
      }
      const sha = await command(['git', 'rev-parse', 'HEAD']);
      await action('progress', { message: 'Les tests locaux ont réussi. Le worker publie la branche et prépare la PR.' });
      await command(['git', 'push', 'origin', `HEAD:refs/heads/${job.branch}`]);
      // PR starts unlabeled. Only enable merging after the site has bound this SHA.
      const pr = await github.ensurePullRequest(job.repository, job.branch, run.cardSnapshot.title.slice(0, 140), `${result.summary}\n\nCarte PlaniFiKateur : ${run.cardId}\nExécution : ${run.id}\n\nVérifications locales :\n${checks.map(c => `- ${c}`).join('\n')}`, signal, sha, targetBranch);
      if (pr.head.sha !== sha) throw new Error('La PR ne pointe pas sur le commit testé.');
      job.pullRequest = { number: pr.number, url: pr.html_url, headSha: sha }; job.phase = 'pr'; await state.put(job);
      await action('submit', { summary: result.summary, checks: checks.join('\n'), links: [pr.html_url], pullRequest: { url: pr.html_url, headSha: sha }, files: deliveredFiles });
      job.phase = 'merging'; job.attempts = 0; await state.put(job);
      await github.label(job.repository, pr.number, signal);
      log(`Exécution ${run.id} : PR #${pr.number}, tests GitHub et fusion en attente.`);
      return { status: 'merging', number: pr.number, sha };
    } catch (error) {
      // Infrastructure failures and shutdowns must not exhaust the model retry budget.
      const publicationPending = error instanceof PublicationPendingError;
      if (attemptStarted && (reservationFailure || parentSignal?.aborted || publicationPending)) job.attempts = Math.max(0, job.attempts - 1);
      // A failed final label is recovered by reconcile; never resubmit a merged task.
      const history = await site.history(run).catch(() => []);
      let current = history.find(item => item.id === run.id);
      if (current?.state === 'running') {
        current = await site.action({ ...current, leaseToken: lease }, !signal.aborted && !publicationPending && job?.attempts >= config.maxAttempts ? 'question' : 'interrupt', {
          message: clean(reservationFailure ? controller.signal.reason.message : signal.aborted ? 'Le worker a été arrêté. Une reprise est possible.' : error.message).slice(0, 10000),
        }).catch(() => current);
      }
      if (job) { job.phase = current?.state || 'interrupted'; job.retryAfter = Date.now() + 60000; await state.put(job); }
      log(`Exécution ${run.id} suspendue : ${clean(reservationFailure ? controller.signal.reason.message : error.message)}`);
      return { status: 'interrupted' };
    } finally {
      clearInterval(timer); await heartbeatPromise; clearTimeout(leaseTimer);
    }
  }

  async function reconcile(signal) {
    for (const job of await state.all()) {
      if (['done', 'cancelled'].includes(job.phase)) continue;
      if (auto && !projects.has(job.projectId)) {
        if (job.phase !== 'unauthorized') { job.phase = 'unauthorized'; await state.put(job); log(`Exécution ${job.id} suspendue localement : projet non autorisé ou supprimé.`); }
        continue;
      }
      let history;
      try { history = await site.history(job, signal); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404 || error.code !== 'card_not_found') throw error;
        job.phase = 'cancelled'; await state.put(job);
        log(`Exécution ${job.id} archivée localement : carte absente de son projet.`);
        continue;
      }
      const run = history.find(r => r.id === job.id);
      if (!run) {
        job.phase = 'cancelled'; await state.put(job);
        log(`Exécution ${job.id} archivée localement : exécution absente de la carte.`);
        continue;
      }
      if (run.state === 'waiting' && allowed(run) && run.submissions.at(-1)?.pullRequest
          && run.exchanges.at(-1)?.question === 'La PR ne pointe pas sur le commit testé.' && !run.exchanges.at(-1)?.answer) {
        const pr = await github.pull(run.repository, run.submissions.at(-1).pullRequest.number, signal);
        if (pr.state === 'open' && pr.head.ref === job.branch && pr.head.repo?.full_name?.toLowerCase() === run.repository.toLowerCase() && pr.base?.ref === (run.executionProfile?.branch || 'main')) {
          log(`Exécution ${run.id} : reprise automatique de la publication interrompue.`);
          return { ...run, publicationRecovery: true };
        }
      }
      if (['done', 'cancelled', 'waiting', 'review'].includes(run.state)) {
        if (job.phase !== run.state) { job.phase = run.state; await state.put(job); log(`Exécution ${job.id} : ${run.state}.`); }
        continue;
      }
      if (run.state !== 'merging' || !allowed(run)) continue;
      const submission = run.submissions.at(-1)?.pullRequest;
      const profile = validateExecutionProfile(job.executionProfile || run.executionProfile || defaultExecutionProfile());
      if (!submission) continue;
      const pr = await github.pull(run.repository, submission.number, signal);
      if (pr.state !== 'open') {
        if (!pr.merged) return { ...run, workerQuestion: 'La PR a été fermée sans fusion. Souhaitez-vous reprendre cette tâche ou l’annuler ?' };
        // A merged PR is only completed by the signed GitHub webhook, never here.
        log(`Exécution ${run.id} : PR fermée, notification du site attendue.`); continue;
      }
      if (pr.head.sha !== submission.headSha || pr.head.repo?.full_name?.toLowerCase() !== run.repository.toLowerCase()) { log(`Exécution ${run.id} : le commit de la PR a changé.`); continue; }
      if (await github.behindMain(run.repository, pr.head.sha, signal, profile.branch)) return run;
      if (!pr.labels.some(l => l.name === 'planifikateur-agent')) await github.label(run.repository, pr.number, signal);
      let merged;
      try { merged = await github.mergeWhenReady(run.repository, pr, data => site.mergeEligible(data, signal), signal, profile); }
      catch (error) {
        const message = clean(error.message);
        if (job.mergeReason !== message) {
          job.mergeReason = message; await state.put(job);
          log(`Exécution ${run.id} : fusion automatique bloquée : ${message}. Le worker réessaiera sans relancer Codex.`);
        }
        continue;
      }
      if (merged.merged) {
        log(`Exécution ${run.id} : PR #${pr.number} fusionnée après réussite des tests GitHub, notification du site attendue.`);
      } else if (job.mergeReason !== merged.reason) {
        job.mergeReason = merged.reason; await state.put(job);
        log(`Exécution ${run.id} : fusion en attente (${merged.reason}).`);
      }
    }
    return null;
  }

  return {
    processTask,
    async tick(signal) {
      if (auto) {
        const discovered = await site.projects(signal);
        projects = new Map(discovered.filter(project => validId(project.id) && (!project.repository || validRepository(project.repository))).map(project => [project.id, project]));
        await mkdir(config.stateRoot, { recursive: true });
        for (const project of projects.values()) {
          const key = JSON.stringify(project), previous = diagnostics.get(project.id);
          if (previous?.key === key && previous.expires > Date.now()) continue;
          const report = await projectDiagnostic(project, config, github, execute, signal);
          report.checks.forEach(check => { check.message = clean(check.message); });
          await site.diagnostic(project.id, report, signal);
          diagnostics.set(project.id, { key, expires: Date.now() + 60000, report });
          log(`Projet ${project.name} : ${report.state === 'ready' ? 'configuration contrôlée' : 'configuration à compléter (voir les paramètres du projet)'}.`);
        }
      }
      const revise = await reconcile(signal);
      if (revise) return processTask(revise, signal);
      for (const projectId of auto ? projects.keys() : config.projectIds) {
        for (const candidate of await site.queue(projectId, signal)) {
          if (!allowed(candidate)) continue;
          const job = await state.get(candidate.id);
          if (job?.retryAfter > Date.now()) continue;
          if (auto) {
            const project = projects.get(projectId);
            const execution = { ...project, repository: candidate.repository, executionProfile: candidate.executionProfile || project.executionProfile, ai: validateAi(job?.ai || candidate.aiRuntime || candidate.ai || project.ai) };
            const key = JSON.stringify(execution), cacheKey = `${projectId}:execution:${key}`;
            let report = diagnostics.get(cacheKey);
            if (!report || report.expires <= Date.now()) {
              report = { report: await projectDiagnostic(execution, config, github, execute, signal), expires: Date.now() + 60000 };
              diagnostics.set(cacheKey, report);
              if (diagnostics.size > 1000) for (const [key, value] of diagnostics) if (value.expires <= Date.now()) diagnostics.delete(key);
            }
            if (report.report.state !== 'ready') continue;
          }
          return processTask(candidate, signal);
        }
      }
      return { status: 'idle' };
    },
  };
}
