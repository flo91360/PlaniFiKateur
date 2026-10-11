import { access, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validId, validRepository } from './config.mjs';
import { ApiError, createSiteClient, createGithubClient } from './clients.mjs';
import { createState } from './state.mjs';
import { commandEnvironment, runCommand } from './commands.mjs';
import { createCodexRunner } from './codex.mjs';

export function createWorker(config, dependencies = {}) {
  const site = dependencies.site || createSiteClient(config);
  const github = dependencies.github || createGithubClient(config.githubToken);
  const state = dependencies.state || createState(config.stateRoot);
  const model = dependencies.model || createCodexRunner(config);
  const execute = dependencies.execute || runCommand;
  const log = dependencies.log || console.log;
  const clean = text => [config.token, config.githubToken, config.apiKey].filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[secret]'), String(text)).slice(-12000);
  const allowed = run => run.delivery === 'github' && validId(run.id) && validId(run.projectId) && validId(run.cardId) && validRepository(run.repository) && config.repositories.includes(run.repository.toLowerCase()) && config.projectIds.includes(run.projectId);

  async function processTask(candidate, parentSignal) {
    if (!allowed(candidate)) return { status: 'ignored' };
    let run;
    try { run = await site.action(candidate, candidate.state === 'merging' ? 'revise' : 'claim', {}, parentSignal); }
    catch (error) { if (error.status === 409) return { status: 'claimed_elsewhere' }; throw error; }
    const lease = run.leaseToken;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.taskTimeoutMs), ...(parentSignal ? [parentSignal] : [])]);
    const action = async (name, data = {}, actionSignal = signal) => {
      run = { ...await site.action({ ...run, leaseToken: lease }, name, data, actionSignal), leaseToken: lease };
      return run;
    };
    let heartbeating = false, heartbeatPromise;
    const timer = setInterval(() => {
      if (heartbeating || signal.aborted) return;
      heartbeating = true;
      // Heartbeat does not change the version; do not overwrite a parallel action.
      heartbeatPromise = site.action({ ...run, leaseToken: lease }, 'heartbeat', {}, signal)
        .catch(() => controller.abort(new Error('Connexion ou réservation perdue.')))
        .finally(() => { heartbeating = false; });
    }, config.heartbeatMs);
    timer.unref();
    let job;
    try {
      job = await state.get(run.id) || { id: run.id, projectId: run.projectId, cardId: run.cardId, repository: run.repository.toLowerCase(), branch: `planifikateur/${run.id}`, attempts: 0, answers: 0 };
      if (job.repository !== run.repository.toLowerCase() || job.projectId !== run.projectId || job.cardId !== run.cardId || job.branch !== `planifikateur/${run.id}`) throw new Error('État du worker incompatible avec la carte.');
      const answers = run.exchanges.filter(e => e.answer).length;
      if (answers !== job.answers) { job.attempts = 0; job.answers = answers; }
      if (candidate.workerQuestion) {
        await action('question', { message: candidate.workerQuestion }); job.phase = 'waiting'; await state.put(job);
        return { status: 'waiting' };
      }
      if (job.attempts >= config.maxAttempts) {
        await action('question', { message: 'Les tentatives automatiques n’ont pas abouti. Pouvez-vous préciser la demande ou faire corriger la configuration du worker avant une nouvelle reprise ?' });
        return { status: 'waiting' };
      }
      job.attempts++; job.phase = 'running'; await state.put(job);
      const previous = run.submissions.at(-1)?.pullRequest || job.pullRequest;
      if (previous) {
        const pr = await github.pull(job.repository, previous.number, signal);
        if (pr.state === 'open' && pr.labels.some(l => l.name === 'planifikateur-agent')) await github.unlabel(job.repository, pr.number, signal);
      }
      log(`Prise en charge ${run.id}.`);
      await action('progress', { message: 'Le worker prépare le dépôt et lance Codex.' });
      const cwd = join(config.stateRoot, 'jobs', run.id);
      const home = join(cwd, '.planifikateur', 'home');
      const env = { ...commandEnvironment(), HOME: home, npm_config_cache: join(config.stateRoot, 'npm-cache'), PLANIFIKATEUR_WORKER: '1', CI: '1' };
      const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: fileURLToPath(new URL('./git-askpass.mjs', import.meta.url)), PLANIFIKATEUR_GIT_TOKEN: config.githubToken };
      const command = async (args, extra = {}) => {
        const result = await execute(args, { cwd, env: args[0] === 'git' ? gitEnv : env, signal, ...extra });
        if (result.code !== 0) throw new Error(`Échec de ${args.slice(0, 3).join(' ')} : ${clean(result.output)}`);
        return result.output.trim();
      };
      const url = `https://github.com/${job.repository}.git`;
      await mkdir(join(config.stateRoot, 'jobs'), { recursive: true, mode: 0o700 });
      let cloned = true; try { await access(join(cwd, '.git')); } catch { cloned = false; }
      if (!cloned) {
        // Recover the same branch after losing the checkout; never force-push.
        await command(['git', 'clone', '--no-tags', '--single-branch', '--branch', 'main', url, cwd], { cwd: config.stateRoot });
      }
      await mkdir(home, { recursive: true });
      await appendFile(join(cwd, '.git', 'info', 'exclude'), '\n.planifikateur/\n');
      await command(['git', 'config', 'user.name', 'PlaniFiKateur Codex']);
      await command(['git', 'config', 'user.email', 'codex@planifikateur.invalid']);
      if (await command(['git', 'config', '--get', 'remote.origin.url']) !== url) throw new Error('L’origine du dépôt a changé.');
      await command(['git', 'fetch', 'origin', 'main']);
      if (!cloned) {
        const remote = await command(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${job.branch}`]);
        if (remote) {
          await command(['git', 'fetch', 'origin', `${job.branch}:refs/remotes/origin/${job.branch}`]);
          await command(['git', 'checkout', '-b', job.branch, `origin/${job.branch}`]);
        } else await command(['git', 'checkout', '-b', job.branch, 'origin/main']);
      } else if (await command(['git', 'branch', '--show-current']) !== job.branch) throw new Error('Le checkout ne correspond plus à la branche de la tâche.');
      // Preserve partial work and let Codex resolve any conflicts with current main.
      const merged = await execute(['git', 'merge', '--no-edit', 'origin/main'], { cwd, env: gitEnv, signal });
      let feedback = merged.code ? `Résous les conflits avec main avant de terminer : ${clean(merged.output)}` : '';
      for (const install of config.installCommands) await command(install);
      let result, checks = [];
      for (let round = 0; round < 3; round++) {
        result = await model.run({ run: { ...run, leaseToken: undefined }, job, cwd, signal, feedback, onThread: async id => { job.threadId = id; await state.put(job); } });
        if (result.status === 'question') {
          await action('question', { message: result.question }); job.phase = 'waiting'; await state.put(job);
          return { status: 'waiting' };
        }
        checks = []; let failure;
        for (const test of config.testCommands) {
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
      await command(['git', 'add', '--all']);
      if (await command(['git', 'diff', '--cached', '--name-only'])) await command(['git', 'commit', '-m', `Carte ${run.cardSnapshot.title.slice(0, 120)} (${run.id})`]);
      const changed = await command(['git', 'diff', 'origin/main...HEAD', '--name-only']);
      if (!changed) {
        await action('question', { message: 'La tâche n’a produit aucune modification par rapport à main. Pouvez-vous préciser ce qui doit changer ?' });
        job.phase = 'waiting'; await state.put(job); return { status: 'waiting' };
      }
      const sha = await command(['git', 'rev-parse', 'HEAD']);
      await action('progress', { message: 'Les tests locaux ont réussi. Le worker publie la branche et prépare la PR.' });
      await command(['git', 'push', 'origin', `HEAD:refs/heads/${job.branch}`]);
      // PR starts unlabeled. Only enable merging after the site has bound this SHA.
      const pr = await github.ensurePullRequest(job.repository, job.branch, run.cardSnapshot.title.slice(0, 140), `${result.summary}\n\nCarte PlaniFiKateur : ${run.cardId}\nExécution : ${run.id}\n\nVérifications locales :\n${checks.map(c => `- ${c}`).join('\n')}`, signal);
      if (pr.head.sha !== sha) throw new Error('La PR ne pointe pas sur le commit testé.');
      job.pullRequest = { number: pr.number, url: pr.html_url, headSha: sha }; job.phase = 'pr'; await state.put(job);
      await action('submit', { summary: result.summary, checks: checks.join('\n'), links: [pr.html_url], pullRequest: { url: pr.html_url, headSha: sha } });
      job.phase = 'merging'; await state.put(job);
      await github.label(job.repository, pr.number, signal);
      log(`Exécution ${run.id} : PR #${pr.number}, tests GitHub et fusion en attente.`);
      return { status: 'merging', number: pr.number, sha };
    } catch (error) {
      // A failed final label is recovered by reconcile; never resubmit a merged task.
      const history = await site.history(run).catch(() => []);
      const current = history.find(item => item.id === run.id);
      if (current?.state === 'running') {
        await site.action({ ...current, leaseToken: lease }, job?.attempts >= config.maxAttempts ? 'question' : 'interrupt', {
          message: clean(signal.aborted ? 'Le worker a été arrêté ou sa réservation a été perdue. Une reprise est possible.' : error.message).slice(0, 10000),
        }).catch(() => {});
      }
      if (job) { job.phase = current?.state || 'interrupted'; job.retryAfter = Date.now() + 60000; await state.put(job); }
      log(`Exécution ${run.id} suspendue : ${clean(error.message)}`);
      return { status: 'interrupted' };
    } finally {
      clearInterval(timer); await heartbeatPromise;
    }
  }

  async function reconcile(signal) {
    for (const job of await state.all()) {
      if (['done', 'cancelled'].includes(job.phase)) continue;
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
      if (['done', 'cancelled', 'waiting', 'review'].includes(run.state)) {
        if (job.phase !== run.state) { job.phase = run.state; await state.put(job); log(`Exécution ${job.id} : ${run.state}.`); }
        continue;
      }
      if (run.state !== 'merging' || !allowed(run)) continue;
      const submission = run.submissions.at(-1)?.pullRequest;
      if (!submission) continue;
      const pr = await github.pull(run.repository, submission.number, signal);
      if (pr.state !== 'open') {
        if (!pr.merged) return { ...run, workerQuestion: 'La PR a été fermée sans fusion. Souhaitez-vous reprendre cette tâche ou l’annuler ?' };
        // A merged PR is only completed by the signed GitHub webhook, never here.
        log(`Exécution ${run.id} : PR fermée, notification du site attendue.`); continue;
      }
      if (pr.head.sha !== submission.headSha || pr.head.repo?.full_name?.toLowerCase() !== run.repository.toLowerCase()) { log(`Exécution ${run.id} : le commit de la PR a changé.`); continue; }
      if (await github.behindMain(run.repository, pr.head.sha, signal)) return run;
      if (!pr.labels.some(l => l.name === 'planifikateur-agent')) await github.label(run.repository, pr.number, signal);
    }
    return null;
  }

  return {
    processTask,
    async tick(signal) {
      const revise = await reconcile(signal);
      if (revise) return processTask(revise, signal);
      for (const projectId of config.projectIds) for (const candidate of await site.queue(projectId, signal)) {
        if (!allowed(candidate)) continue;
        const job = await state.get(candidate.id);
        if (job?.retryAfter > Date.now()) continue;
        return processTask(candidate, signal);
      }
      return { status: 'idle' };
    },
  };
}
