import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
  join,
  delay,
  createWorker,
  ApiError,
  createSiteClient,
  mergeAgentPullRequest,
  requiredJobs,
  repository,
  fixture,
  qtForm,
} from './helpers/worker-fixture.mjs';

// Worker : livraison d’une carte, PR, questions et fichiers générés.

test('worker merges only after GitHub CI and site eligibility, without Actions secrets or another model call', async t => {
  const f = await fixture(t);
  f.prepare();
  const submission = await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.merges, 0);
  assert.equal(f.modelCalls.length, 1);
  f.setTestsReady(true);
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(f.merges, 1);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.current().state, 'merging', 'the signed webhook alone completes the card');
  assert.ok(f.logs.some(line => line.includes('fusionnée après réussite des tests GitHub')));
  await f.webhook({
    action: 'closed',
    repository: { full_name: repository },
    pull_request: {
      number: 1,
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: submission.sha,
      head: { sha: submission.sha, repo: { full_name: repository } },
      base: { ref: 'main' },
    },
  });
  await f.worker.tick();
  assert.equal(f.current().state, 'done');
  assert.equal(f.merges, 1);
});

test('worker spaces GitHub checks of a waiting PR and resumes them as soon as its execution changes on the site', async t => {
  const f = await fixture(t);
  let clock = Date.now(),
    pulls = 0;
  const github = {
    ...f.github,
    async pull(...args) {
      pulls++;
      return f.github.pull(...args);
    },
  };
  const worker = createWorker({ ...f.config, githubPollMs: 60000 }, { ...f.dependencies, github, now: () => clock });
  f.prepare();
  assert.equal((await worker.tick()).status, 'merging');
  await worker.tick();
  assert.equal(pulls, 1);
  f.setTestsReady(true);
  clock += 30000;
  await worker.tick();
  assert.equal(pulls, 1, 'rien n’a changé sur le site : la PR n’est pas relue avant l’intervalle');
  assert.equal(f.merges, 0);
  // Résultat des contrôles reçu par webhook : l’exécution change sur le site, la PR est relue aussitôt.
  const { workflow } = f.store.workflows.executionProfile(f.project.id);
  assert.equal(
    f.store.workflows.githubChecks({
      action: 'completed',
      repository: { full_name: repository },
      workflow_run: {
        id: 1,
        run_attempt: 1,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        name: workflow.name,
        path: `.github/workflows/${workflow.file}`,
        head_sha: f.pr.head.sha,
        head_repository: { full_name: repository },
        html_url: `https://github.com/${repository}/actions/runs/1`,
      },
    }).updated,
    true,
  );
  await worker.tick();
  assert.equal(pulls, 2);
  assert.equal(f.merges, 1);
  await worker.tick();
  assert.equal(pulls, 2);
  clock += 60000;
  await worker.tick();
  assert.equal(pulls, 3, 'relue une fois l’intervalle écoulé');
  assert.ok(f.logs.some(line => line.includes('PR fusionnée, confirmation du site attendue')));
});

test('project diagnostics query GitHub every 15 minutes but are reported to the site every minute', async t => {
  const f = await fixture(t, { auto: true });
  let clock = Date.now(),
    checks = 0;
  const github = {
    ...f.github,
    request(path, ...rest) {
      if (path === `/repos/${repository}`) checks++;
      return f.github.request(path, ...rest);
    },
  };
  const worker = createWorker(f.config, { ...f.dependencies, github, now: () => clock });
  const reported = () => f.store.workflows.workerStatus(f.project.id).date;
  assert.equal((await worker.tick()).status, 'idle');
  assert.equal(checks, 1);
  assert.equal(f.store.workflows.workerStatus(f.project.id).state, 'ready');
  const first = reported();
  await delay(5);
  await worker.tick();
  assert.equal(reported(), first, 'pas de nouvel envoi avant une minute');
  clock += 60000;
  await worker.tick();
  assert.equal(checks, 1, 'le dernier diagnostic est renvoyé sans interroger GitHub');
  assert.notEqual(reported(), first);
  clock += 15 * 60000;
  await worker.tick();
  assert.equal(checks, 2);
  // Une configuration modifiée sur le site est contrôlée aussitôt.
  f.store.workflows.configureAi(f.project.id, { engine: 'codex', model: 'gpt-6.1-sol' }, f.user);
  await worker.tick();
  assert.equal(checks, 3);
  assert.equal(f.logs.filter(line => line.includes('configuration contrôlée')).length, 2);
});

test('the worker announces its revision once, retries later, and shows it in project diagnostics', async t => {
  const f = await fixture(t, { auto: true });
  const revision = 'c'.repeat(40);
  let clock = Date.now(),
    failures = 1,
    announcements = 0;
  const real = createSiteClient(f.config);
  const site = {
    ...real,
    async status(data, signal) {
      announcements++;
      if (failures-- > 0) throw new TypeError('fetch failed');
      return real.status(data, signal);
    },
  };
  const worker = createWorker({ ...f.config, revision }, { ...f.dependencies, site, now: () => clock });
  const status = () => f.store.workflows.agents()[0].status;
  // Site momentanément injoignable : le travail continue, nouvel essai dix minutes plus tard.
  assert.equal((await worker.tick()).status, 'idle');
  assert.equal(status().revision, undefined);
  assert.ok(status().lastSeenAt, 'les autres requêtes du worker valent signe de vie');
  clock += 9 * 60000;
  await worker.tick();
  assert.equal(announcements, 1);
  clock += 60000;
  await worker.tick();
  assert.equal(status().revision, revision);
  assert.ok(status().startedAt);
  clock += 60 * 60000;
  await worker.tick();
  assert.equal(announcements, 2, 'annoncée une seule fois par démarrage');
  assert.deepEqual(
    f.store.workflows.workerStatus(f.project.id).checks.find(check => check.name === 'Version du worker'),
    { name: 'Version du worker', state: 'ok', message: 'Révision ccccccc en service.' },
  );
  // Sans révision (worker lancé à la main) : rien n’est annoncé et le diagnostic l’indique.
  const manual = createWorker(f.config, { ...f.dependencies, site });
  await manual.tick();
  assert.equal(announcements, 2);
  assert.equal(
    f.store.workflows.workerStatus(f.project.id).checks.find(check => check.name === 'Version du worker').state,
    'unknown',
  );
});

test('only GitHub network commands receive the token and no Git command runs hooks or a file monitor', async t => {
  const f = await fixture(t);
  f.prepare();
  await f.worker.tick();
  const gitCalls = f.calls.filter(call => call.command[0] === 'git');
  const remote = ['clone', 'fetch', 'ls-remote', 'push'];
  assert.ok(gitCalls.some(call => call.command[1] === 'push'));
  assert.ok(gitCalls.some(call => ['commit', 'merge', 'add', 'status'].includes(call.command[1])));
  for (const { command, env } of gitCalls) {
    assert.equal(!!env.PLANIFIKATEUR_GIT_TOKEN, remote.includes(command[1]), command.join(' '));
    assert.equal(!!env.GIT_ASKPASS, remote.includes(command[1]), command.join(' '));
    assert.deepEqual(
      [env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1],
      ['core.hooksPath', '/dev/null', 'core.fsmonitor', 'false'],
    );
  }
  // Les commandes du projet ne reçoivent aucune clé.
  for (const { command, env } of f.calls.filter(call => call.command[0] !== 'git'))
    assert.ok(!Object.keys(env || {}).some(name => /TOKEN|API_KEY/.test(name)), command.join(' '));
});

test('a push refused for a missing workflow permission asks for the token change instead of retrying', async t => {
  // Une carte ne modifie pas les workflows, mais la branche cible intégrée à une PR peut en apporter.
  const f = await fixture(t, {
    refusePush: () =>
      'To https://github.com/flo91360/defilordi.git\n ! [remote rejected] HEAD -> planifikateur/x (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/build-windows.yml` without `workflow` scope)\nerror: failed to push some refs',
  });
  f.prepare();
  const outcome = await f.worker.tick();
  assert.equal(outcome.status, 'waiting', f.logs.join('\n'));
  const run = f.current();
  assert.equal(run.state, 'waiting');
  const message = run.exchanges.at(-1).question;
  assert.match(message, /portée « workflow »/);
  assert.ok(!message.includes('github-test-token'));
  assert.equal(f.pr, undefined);
});

test('a card cannot change the worker or the merge controls: they are restored and the rest is delivered', async t => {
  const f = await fixture(t, {
    model: async input => {
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      if (!/fichiers protégés modifiés/.test(input.feedback || '')) {
        await mkdir(join(input.cwd, '.github', 'workflows'), { recursive: true });
        await writeFile(join(input.cwd, '.github', 'workflows', 'ci.yml'), 'on: push\n');
        await mkdir(join(input.cwd, 'worker'), { recursive: true });
        await writeFile(join(input.cwd, 'worker', 'isolation.mjs'), 'export const sandbox = false;\n');
      }
      return { status: 'result', summary: 'Salutation française', question: '' };
    },
  });
  f.prepare();
  const outcome = await f.worker.tick();
  assert.equal(outcome.status, 'merging', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 2);
  assert.match(f.modelCalls[1].feedback, /\.github\/workflows\/ci\.yml, worker\/isolation\.mjs/);
  const submission = f.current().submissions.at(-1);
  const delivered = (await f.git(['ls-tree', '-r', '--name-only', submission.pullRequest.headSha], f.bare)).split('\n');
  assert.ok(delivered.includes('greet.mjs'));
  assert.ok(!delivered.some(path => path.startsWith('.github/') || path.startsWith('worker/')));
});

test('a request that needs protected files becomes a question on the card, without a PR', async t => {
  const f = await fixture(t, {
    model: async input => {
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      await writeFile(join(input.cwd, 'AGENTS.md'), '# Plus de consignes\n');
      return { status: 'result', summary: 'Consignes', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 3);
  const run = f.current();
  assert.equal(run.state, 'waiting');
  assert.match(run.exchanges.at(-1).question, /fichiers protégés : AGENTS\.md.*intervention directe/);
  assert.equal(f.pr, undefined);
  assert.equal(
    f.calls.some(c => c.command[0] === 'git' && c.command[1] === 'push'),
    false,
  );
});

test('a refused merge automatically retries without consuming another model attempt or replacing the PR', async t => {
  const f = await fixture(t);
  f.prepare();
  await f.worker.tick();
  f.setTestsReady(true);
  f.setMergeFailure(true);
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.merges, 0);
  assert.equal(f.current().state, 'merging');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.logs.filter(line => line.includes('fusion automatique bloquée')).length, 1);
  f.setMergeFailure(false);
  await f.worker.tick();
  assert.equal(f.merges, 1);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.pr.number, 1);
});

test('local end-to-end from ready card status: real API, Git changes, passing tests, PR simulation, gated merge and signed completion', async t => {
  const f = await fixture(t),
    snapshot = f.store.read();
  snapshot.projects[0].cards[0].status = 'ready';
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.equal(f.current(), undefined);
  const outcome = await f.worker.tick();
  const ready = f.current();
  assert.equal(outcome.status, 'merging');
  assert.equal(f.current().state, 'merging');
  assert.equal(f.store.read().projects[0].cards[0].status, 'review');
  assert.match(await f.git(['show', `${outcome.sha}:greet.mjs`], f.bare), /bonjour/);
  const changelog = await f.git(['show', `${outcome.sha}:CHANGELOG.md`], f.bare);
  assert.ok(changelog.startsWith('# Changelog'));
  assert.match(changelog, /\n## 1\.0\.1 — \d{4}-\d{2}-\d{2}\n/);
  assert.ok(changelog.includes(`<!-- planifikateur:${ready.id} -->\n\n- **${f.card.title}** : Greeting translated`));
  const job = await f.state.get(ready.id);
  assert.equal(job.threadId, 'fixture-thread');
  const serialized = JSON.stringify(job);
  assert.ok(!serialized.includes(f.credentials.token));
  assert.ok(!serialized.includes('github-test-token'));
  assert.ok(!serialized.includes('leaseToken'));
  for (const call of f.calls.filter(c => c.command[0] !== 'git')) {
    assert.equal(call.env.PLANIFIKATEUR_GIT_TOKEN, undefined);
    assert.equal(call.env.PLANIFIKATEUR_AGENT_TOKEN, undefined);
    assert.equal(call.env.OPENAI_API_KEY, undefined);
  }
  assert.ok(
    f.calls.findIndex(c => c.command[0] === 'node' && c.command[1] === 'browser-check.mjs') <
      f.calls.findIndex(c => c.command[0] === 'git' && c.command[1] === 'push'),
  );
  const run = {
    workflow_id: 2,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: repository },
    head_sha: outcome.sha,
    head_branch: job.branch,
    run_attempt: 1,
  };
  const request = async (path, method, data) => {
    if (path.endsWith('/merge')) {
      assert.equal(method, 'PUT');
      assert.equal(data.sha, outcome.sha);
      await f.git(['update-ref', 'refs/heads/main', outcome.sha], f.bare);
      return { merged: true, sha: outcome.sha };
    }
    if (path.includes('/jobs?'))
      return {
        jobs: requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 })),
        total_count: 2,
      };
    if (path.endsWith('/ci.yml')) return { id: 2 };
    if (path.includes('/actions/runs/')) return run;
    if (path.includes('/pulls?')) return [f.pr];
    if (path.endsWith('/pulls/1')) return f.pr;
    if (path.endsWith('/branches/main')) return { commit: { sha: await f.git(['rev-parse', 'main'], f.bare) } };
    if (path.includes('/compare/')) return { status: 'ahead' };
    throw new Error(path);
  };
  const merged = await mergeAgentPullRequest({
    repository,
    runId: 1,
    request,
    eligible: async ({ number, sha }) =>
      f.store.workflows.mergeEligible(repository, number, sha, f.credentials.agent).eligible,
  });
  assert.equal(merged.merged, true);
  assert.equal(f.current().state, 'merging');
  await f.webhook({
    action: 'closed',
    repository: { full_name: repository },
    pull_request: {
      number: 1,
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: outcome.sha,
      head: { sha: outcome.sha, repo: { full_name: repository } },
      base: { ref: 'main' },
    },
  });
  assert.equal(f.current().state, 'done');
  assert.equal(f.store.read().projects[0].cards[0].status, 'done');
  const checkout = join(f.config.stateRoot, 'jobs', ready.id);
  await access(join(checkout, '.git'));
  assert.equal((await f.worker.tick()).status, 'idle');
  await assert.rejects(access(checkout), { code: 'ENOENT' });
  assert.equal((await f.state.get(ready.id)).checkoutReleased, true);
  assert.equal(f.logs.filter(message => message.includes('checkout local supprimé')).length, 1);
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(f.logs.filter(message => message.includes('checkout local supprimé')).length, 1);
});

test('checkouts of tasks finished before the update are released while other phases keep theirs', async t => {
  const f = await fixture(t);
  const jobs = ['finished-job', 'waiting-job'].map((id, index) => ({
    id,
    projectId: f.project.id,
    cardId: f.card.id,
    repository,
    phase: index ? 'waiting' : 'done',
  }));
  for (const job of jobs) {
    await f.state.put(job);
    await mkdir(join(f.config.stateRoot, 'jobs', job.id, 'node_modules'), { recursive: true });
  }
  assert.equal((await f.worker.tick()).status, 'idle');
  await assert.rejects(access(join(f.config.stateRoot, 'jobs', 'finished-job')), { code: 'ENOENT' });
  await access(join(f.config.stateRoot, 'jobs', 'waiting-job', 'node_modules'));
  assert.deepEqual(await f.state.get('finished-job'), { ...jobs[0], checkoutReleased: true });
  // Unknown on the site, the second job is archived as cancelled and still keeps its checkout.
  assert.deepEqual(await f.state.get('waiting-job'), { ...jobs[1], phase: 'cancelled' });
});

test('two worker claims start only one model and one PR', async t => {
  const f = await fixture(t);
  const run = f.prepare();
  const second = createWorker(f.config, f.dependencies);
  const results = await Promise.all([f.worker.processTask(run), second.processTask(run)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['claimed_elsewhere', 'merging']);
  assert.equal(f.modelCalls.length, 1);
});

test('deleted cards in persisted jobs do not block a new task and their checkout remains intact', async t => {
  const f = await fixture(t);
  const jobs = ['deleted-job-one', 'deleted-job-two'].map(id => ({
    id,
    projectId: f.project.id,
    cardId: 'deleted-card',
    repository,
    phase: 'interrupted',
    threadId: 'previous-thread',
  }));
  for (const job of jobs) await f.state.put(job);
  const checkout = join(f.config.stateRoot, 'jobs', jobs[0].id);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'partial.txt'), 'Keep partial work');
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  for (const job of jobs) assert.deepEqual(await f.state.get(job.id), { ...job, phase: 'cancelled' });
  assert.equal(await readFile(join(checkout, 'partial.txt'), 'utf8'), 'Keep partial work');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.logs.filter(message => message.includes('carte absente de son projet')).length, 2);
  const restarted = createWorker(f.config, {
    ...f.dependencies,
    site: {
      ...f.site,
      history: job => {
        assert.ok(!jobs.some(old => old.id === job.id), 'archived jobs must not be queried again');
        return f.site.history(job);
      },
    },
  });
  assert.equal((await restarted.tick()).status, 'idle');
  assert.equal(f.modelCalls.length, 1);
});

test('an execution absent from an existing card is archived locally and the current task proceeds', async t => {
  const f = await fixture(t);
  const old = { id: 'missing-execution', projectId: f.project.id, cardId: f.card.id, repository, phase: 'running' };
  await f.state.put(old);
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging');
  assert.deepEqual(await f.state.get(old.id), { ...old, phase: 'cancelled' });
  assert.equal(f.modelCalls.length, 1);
});

test('access denials, network failures and unrelated 404 errors never discard persisted jobs', async t => {
  const f = await fixture(t),
    job = { id: 'protected-job', projectId: f.project.id, cardId: f.card.id, repository, phase: 'interrupted' };
  await f.state.put(job);
  for (const error of [
    new ApiError(401, 'agent_unauthorized'),
    new ApiError(403, 'agent_scope'),
    new ApiError(404, 'unknown_route'),
    new TypeError('fetch failed'),
  ]) {
    let polled = false;
    const worker = createWorker(f.config, {
      ...f.dependencies,
      site: {
        ...f.site,
        history: async () => {
          throw error;
        },
        queue: async () => {
          polled = true;
          return [];
        },
      },
    });
    await assert.rejects(worker.tick(), caught => caught === error);
    assert.equal(polled, false);
    assert.deepEqual(await f.state.get(job.id), job);
  }
});

test('questions pause publication and an answer resumes the persisted conversation and checkout', async t => {
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 1) {
        await writeFile(join(input.cwd, 'notes.txt'), 'Partial work');
        return { status: 'question', question: 'Quelle langue ?', summary: '' };
      }
      assert.equal(input.job.threadId, 'fixture-thread');
      assert.equal(input.run.exchanges.at(-1).answer.text, 'Français');
      assert.equal(await readFile(join(input.cwd, 'notes.txt'), 'utf8'), 'Partial work');
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'French greeting', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting');
  assert.equal(f.pr, undefined);
  const snapshot = f.store.read();
  assert.equal(snapshot.projects[0].cards[0].comments.at(-1).text, 'Quelle langue ?');
  snapshot.projects[0].cards[0].comments.push({
    id: 'language-reply',
    author: f.user.name,
    text: 'Français',
    date: new Date().toISOString(),
  });
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  const restarted = createWorker(f.config, f.dependencies);
  assert.equal((await restarted.tick()).status, 'merging');
  assert.equal(f.modelCalls.length, 2);
});

test('the worker selects Claude for the project and keeps the resolved model and card effort after an answer', async t => {
  const f = await fixture(t, {
    model: async (input, number) => {
      assert.equal(input.job.ai.engine, 'claude-code');
      assert.equal(input.job.ai.effort, 'high');
      if (number === 2) assert.equal(input.job.ai.model, 'claude-sonnet-resolved');
      await input.onRuntime({ engine: 'claude-code', model: 'claude-sonnet-resolved', effort: 'high' });
      if (number === 1) return { status: 'question', summary: '', question: 'Quelle langue ?', files: [] };
      assert.equal(input.run.exchanges.at(-1).answer.text, 'Français.');
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Traduit.', question: '', files: [] };
    },
  });
  const snapshot = f.store.read();
  snapshot.projects[0].cards[0].aiEffort = 'high';
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  f.store.workflows.configureAi(f.project.id, { engine: 'claude-code', model: 'sonnet' }, f.user);
  const dependencies = {
    ...f.dependencies,
    claude: f.dependencies.model,
    model: {
      run() {
        throw new Error('Codex must not execute this task');
      },
    },
  };
  const worker = createWorker(f.config, dependencies);
  f.prepare();
  assert.equal((await worker.tick()).status, 'waiting');
  assert.equal(f.current().aiRuntime.model, 'claude-sonnet-resolved');
  f.store.workflows.configureAi(f.project.id, { engine: 'codex', model: 'different-model' }, f.user);
  const reply = f.store.read();
  reply.projects[0].cards[0].comments.push({
    id: 'claude-answer',
    author: f.user.name,
    text: 'Français.',
    date: new Date().toISOString(),
  });
  f.store.write(reply.projects, reply.revision, f.user);
  assert.equal((await createWorker(f.config, dependencies).tick()).status, 'merging');
  assert.equal(f.current().ai.engine, 'claude-code');
  assert.equal(f.modelCalls.length, 2);
});

test('a model question is relayed literally, a card reply resumes the thread and the generated Qt file is delivered without a PR', async t => {
  const question = 'Quels champs souhaitez-vous dans le formulaire Qt ?';
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 1) return { status: 'question', summary: '', question, files: [] };
      assert.equal(input.job.threadId, 'fixture-thread');
      assert.equal(input.run.exchanges.at(-1).answer.text, 'Un champ Nom suffit.');
      await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
      await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), qtForm);
      return {
        status: 'result',
        summary: 'Le formulaire Qt est prêt à télécharger.',
        question: '',
        files: ['.planifikateur/generated/personne.ui'],
      };
    },
  });
  const initial = f.store.read();
  initial.projects[0].cards[0].description = 'Génère un fichier Qt .ui avec un formulaire sur la personne.';
  f.store.write(initial.projects, initial.revision, f.user);
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting');
  let snapshot = f.store.read(),
    card = snapshot.projects[0].cards[0];
  assert.equal(card.status, 'clarify');
  assert.equal(card.comments.at(-1).text, question);
  assert.equal(card.attachments.length, 0);
  card.comments.push({
    id: 'form-answer',
    author: f.user.name,
    text: 'Un champ Nom suffit.',
    date: new Date().toISOString(),
  });
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  const restarted = createWorker(f.config, f.dependencies);
  assert.equal((await restarted.tick()).status, 'done');
  snapshot = f.store.read();
  card = snapshot.projects[0].cards[0];
  assert.equal(card.status, 'done');
  assert.equal(card.attachments.length, 1);
  assert.equal(card.attachments[0].name, 'personne.ui');
  assert.equal(Buffer.from(card.attachments[0].data, 'base64').toString('utf8'), qtForm);
  // Le résultat figure dans l’exécution (bandeau), la discussion garde seulement l’échange.
  assert.equal(card.comments.at(-1).text, 'Un champ Nom suffit.');
  const [delivered] = f.store.workflows.list(snapshot.projects[0].id, card.id);
  assert.deepEqual(
    delivered.submissions.at(-1).files.map(file => file.name),
    ['personne.ui'],
  );
  assert.equal(f.pr, undefined);
  assert.equal(
    f.calls.some(call => call.command[0] === 'git' && call.command[1] === 'push'),
    false,
  );
  assert.equal(
    f.calls.some(call => call.command.includes('--test')),
    false,
  );
  await assert.rejects(access(join(f.config.stateRoot, 'jobs', f.current().id)), { code: 'ENOENT' });
});

test('generated files alongside repository changes remain bound to the tested PR and do not cancel its execution', async t => {
  const f = await fixture(t, {
    model: async input => {
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
      await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), qtForm);
      return {
        status: 'result',
        summary: 'Code corrigé et formulaire livré.',
        question: '',
        files: ['.planifikateur/generated/personne.ui'],
      };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging');
  assert.equal(f.store.read().projects[0].cards[0].attachments.length, 1);
  assert.equal(f.current().state, 'merging');
  f.setTestsReady(true);
  await f.worker.tick();
  assert.equal(f.merges, 1);
});

test('missing output declarations and malformed Qt XML are corrected before any file is delivered', async t => {
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 2) assert.match(input.feedback, /indique son chemin dans files/);
      if (number === 3) assert.match(input.feedback, /Corrige les fichiers/);
      await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
      await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), number === 2 ? '<ui>' : qtForm);
      return {
        status: 'result',
        summary: 'Formulaire livré.',
        question: '',
        files: number === 1 ? [] : ['.planifikateur/generated/personne.ui'],
      };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'done');
  assert.equal(f.modelCalls.length, 3);
  const files = f.store.read().projects[0].cards[0].attachments;
  assert.equal(files.length, 1);
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), qtForm);
  assert.equal(f.pr, undefined);
});

test('shutdown interrupts the card and a restart reclaims it without losing conversation', async t => {
  let started;
  const start = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 1) {
        started();
        await delay(60000, undefined, { signal: input.signal });
      }
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Resumed greeting', question: '' };
    },
  });
  const ready = f.prepare(),
    stop = new AbortController();
  const running = f.worker.processTask(ready, stop.signal);
  await start;
  stop.abort(new Error('Stopped'));
  assert.equal((await running).status, 'interrupted');
  assert.equal(f.current().state, 'interrupted');
  assert.equal(f.pr, undefined);
  assert.equal((await f.worker.processTask(f.current())).status, 'merging');
  assert.equal(f.modelCalls[1].job.threadId, 'fixture-thread');
});

test('a Git hook or filter planted by the model removes the checkout before any worker Git command', async t => {
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 1) {
        await writeFile(join(input.cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await writeFile(join(input.cwd, '.git', 'config'), '[filter "x"]\n\tclean = sh -c leak\n', { flag: 'a' });
      }
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Greeting', question: '' };
    },
  });
  const first = await f.worker.processTask(f.prepare());
  assert.equal(first.status, 'interrupted');
  assert.match(f.current().interruption, /configuration Git locale/);
  assert.equal(f.pr, undefined);
  await assert.rejects(stat(join(f.config.stateRoot, 'jobs', f.current().id)), { code: 'ENOENT' });
  // La reprise recrée le checkout depuis GitHub, sans le hook, et livre normalement.
  assert.equal((await f.worker.processTask(f.current())).status, 'merging');
});

test('failed mandatory tests are corrected at most three times and never publish a PR', async t => {
  const f = await fixture(t, {
    model: async input => {
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'hola';\n");
      return { status: 'result', summary: 'Unverified result', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'interrupted');
  assert.equal(f.modelCalls.length, 3);
  assert.equal(f.pr, undefined);
  assert.equal(f.current().state, 'interrupted');
  assert.equal(
    f.calls.some(c => c.command[0] === 'git' && c.command[1] === 'push'),
    false,
  );
  assert.match(f.modelCalls[1].feedback, /French greeting|ERR_ASSERTION/);
});

test('label failure after submission recovers without a second claim or submission', async t => {
  const f = await fixture(t, { labelFailure: true });
  f.prepare();
  await f.worker.tick();
  assert.equal(f.current().state, 'merging');
  assert.equal(f.pr.labels.length, 0);
  await f.worker.tick();
  assert.equal(f.pr.labels[0].name, 'planifikateur-agent');
  assert.equal(f.current().submissions.length, 1);
  assert.equal(f.modelCalls.length, 1);
});

test('a pending PR is revised against new main and only its new tested SHA can merge', async t => {
  const f = await fixture(t);
  f.prepare();
  const initial = await f.worker.tick();
  await writeFile(join(f.source, 'readme.md'), 'Another change');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Advance main']);
  await f.git(['push', 'origin', 'main']);
  f.setBehind(true);
  const updated = await f.worker.tick();
  f.setBehind(false);
  assert.equal(updated.status, 'merging');
  assert.notEqual(updated.sha, initial.sha);
  assert.equal(updated.number, initial.number);
  assert.equal(f.current().submissions.length, 2);
  assert.equal(f.store.workflows.mergeEligible(repository, 1, initial.sha, f.credentials.agent).eligible, false);
  assert.equal(f.store.workflows.mergeEligible(repository, 1, updated.sha, f.credentials.agent).eligible, true);
  assert.equal(
    f.calls.some(c => c.command.includes('--force') || c.command.includes('--force-with-lease')),
    false,
  );
  // Le résultat IA publié est repris : seuls la version et les tests sont refaits sur main à jour.
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.calls.filter(c => c.command[1] === '--test').length, 2);
  assert.ok(f.current().updates.some(u => /main a avancé.*sans nouvel appel au modèle/.test(u.text)));
});

test('when updating a PR against new main breaks the tests, the model fixes them with the failure', async t => {
  let runs = 0;
  const f = await fixture(t, {
    execute: async command => {
      if (command[1] === '--test' && ++runs === 2) return { code: 1, output: 'AssertionError: main incompatible' };
    },
  });
  f.prepare();
  await f.worker.tick();
  await writeFile(join(f.source, 'readme.md'), 'Another change');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Advance main']);
  await f.git(['push', 'origin', 'main']);
  f.setBehind(true);
  const updated = await f.worker.tick();
  f.setBehind(false);
  assert.equal(updated.status, 'merging', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 2);
  assert.match(f.modelCalls[1].feedback, /main incompatible/);
});
