import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  tmpdir,
  join,
  delay,
  readWorkerConfig,
  createWorker,
  infrastructureFailure,
  commandEnvironment,
  createCodexRunner,
  taskPrompt,
  createGithubClient,
  repository,
  fixture,
} from './helpers/worker-fixture.mjs';

// Worker : configuration, adaptateurs IA et GitHub, points de reprise et échecs des contrôles.

test('worker configuration rejects external HTTP, credential URLs, invalid scopes and shell strings', () => {
  const env = {
    PLANIFIKATEUR_URL: 'https://site.example',
    PLANIFIKATEUR_AGENT_TOKEN: 'site-key',
    PLANIFIKATEUR_GITHUB_TOKEN: 'git-key',
    PLANIFIKATEUR_WORKER_PROJECTS: 'project',
    PLANIFIKATEUR_WORKER_REPOSITORIES: 'owner/repo',
  };
  for (const changes of [
    { PLANIFIKATEUR_URL: 'http://external.example' },
    { PLANIFIKATEUR_URL: 'https://user:password@site.example' },
    { PLANIFIKATEUR_WORKER_PROJECTS: '../project' },
    { PLANIFIKATEUR_WORKER_REPOSITORIES: 'https://evil.example' },
    { PLANIFIKATEUR_WORKER_TEST_COMMANDS: '["npm test"]' },
    { PLANIFIKATEUR_WORKER_HEARTBEAT_MS: '300000' },
    { PLANIFIKATEUR_WORKER_GITHUB_POLL_MS: '600001' },
    { PLANIFIKATEUR_WORKER_DIAGNOSTIC_MS: '-1' },
    { PLANIFIKATEUR_WORKER_REVISION: 'main' },
    { PLANIFIKATEUR_WORKER_REVISION: 'abc12' },
  ])
    assert.throws(() => readWorkerConfig({ ...env, ...changes }));
  assert.equal(readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_REVISION: 'abc1234' }).revision, 'abc1234');
  assert.equal(readWorkerConfig(env).revision, undefined);
  assert.equal(
    commandEnvironment({
      PATH: '/bin',
      GH_TOKEN: 'secret',
      PLANIFIKATEUR_AGENT_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
    }).GH_TOKEN,
    undefined,
  );
});

test('SDK adapter selects a sandbox, resumes a thread, validates JSON and never inherits GitHub/site secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let settings, threadOptions, threadId, passedSchema;
  class Codex {
    constructor(options) {
      settings = options;
    }
    resumeThread(id, options) {
      threadId = id;
      threadOptions = options;
      return {
        runStreamed: async (prompt, turn) => {
          passedSchema = turn.outputSchema;
          assert.match(prompt, /Description : French greeting/);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: id };
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: '{"status":"result","summary":"Translated","question":""}' },
              };
              yield { type: 'turn.completed' };
            })(),
          };
        },
      };
    }
  }
  const run = {
    cardSnapshot: { title: 'Greeting' },
    objective: 'French greeting',
    exchanges: [],
    submissions: [],
    updates: [],
  };
  const runner = createCodexRunner({ apiKey: 'model-key', codexHome: join(root, 'codex') }, { Codex });
  const result = await runner.run({
    run,
    job: { threadId: 'previous-thread' },
    cwd: root,
    signal: new AbortController().signal,
    onThread: async id => assert.equal(id, 'previous-thread'),
  });
  assert.equal(result.status, 'result');
  assert.equal(threadId, 'previous-thread');
  assert.equal(threadOptions.sandboxMode, 'workspace-write');
  assert.equal(threadOptions.approvalPolicy, 'never');
  assert.equal(settings.env.GH_TOKEN, undefined);
  assert.equal(settings.env.PLANIFIKATEUR_AGENT_TOKEN, undefined);
  assert.equal(settings.env.PLANIFIKATEUR_WORKER, '1');
  assert.equal(passedSchema.additionalProperties, false);
  assert.ok(!taskPrompt(run).includes('Critères d’acceptation'));
});

test('GitHub client publishes structured PR bodies and uses credentials only at the GitHub origin', async () => {
  const calls = [];
  const client = createGithubClient('private-token', async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return Response.json([]);
    return Response.json({ number: 9, draft: false, head: { repo: { full_name: repository } }, base: { ref: 'main' } });
  });
  await client.ensurePullRequest(repository, 'planifikateur/uuid', 'Title', 'Line one\nLine two');
  assert.equal(JSON.parse(calls[1].options.body).body, 'Line one\nLine two');
  assert.ok(calls.every(c => new URL(c.url).origin === 'https://api.github.com' && c.options.redirect === 'error'));
});

test('browser timeout resumes only unfinished checks with the saved result and no new model call', async t => {
  let browserAttempts = 0;
  const f = await fixture(t, {
    execute: async (command, args) => {
      if (command[1] === 'browser-check.mjs' && ++browserAttempts === 1)
        await delay(15000, undefined, { signal: args.signal });
    },
  });
  const worker = createWorker({ ...f.config, testsTimeoutMs: 5000, maxAttempts: 1 }, f.dependencies);
  assert.equal((await worker.processTask(f.prepare())).status, 'interrupted');
  assert.match(f.current().interruption, /Délai dépassé.*vérifications locales/);
  assert.doesNotMatch(f.current().interruption, /worker a été arrêté/);
  assert.equal(f.pr, undefined);
  const saved = await f.state.get(f.current().id);
  assert.equal(saved.checkpoint.completedTests.length, 1);
  assert.equal(saved.checkpoint.result.summary, 'Greeting translated');
  const restarted = createWorker(f.config, f.dependencies);
  assert.equal((await restarted.processTask(f.current())).status, 'merging');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(browserAttempts, 2);
  assert.equal(f.calls.filter(c => c.command[1] === '--test').length, 1);
});

test('shutdown during tests preserves the completed IA result and the worker resumes without Codex', async t => {
  const controller = new AbortController();
  let interrupted = false;
  const f = await fixture(t, {
    execute: async (command, args) => {
      if (command[1] === 'browser-check.mjs' && !interrupted) {
        interrupted = true;
        controller.abort(new Error('Deployment restart'));
        args.signal.throwIfAborted();
      }
    },
  });
  assert.equal((await f.worker.processTask(f.prepare(), controller.signal)).status, 'interrupted');
  assert.match(f.current().interruption, /worker a été arrêté/);
  assert.equal((await createWorker(f.config, f.dependencies).processTask(f.current())).status, 'merging');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.calls.filter(c => c.command[1] === '--test').length, 1);
});

test('changed checkout invalidates the saved IA result and previously successful checks', async t => {
  const controller = new AbortController();
  let interrupted = false;
  const f = await fixture(t, {
    execute: async (command, args) => {
      if (command[1] === 'browser-check.mjs' && !interrupted) {
        interrupted = true;
        controller.abort();
        args.signal.throwIfAborted();
      }
    },
  });
  await f.worker.processTask(f.prepare(), controller.signal);
  await writeFile(
    join(f.config.stateRoot, 'jobs', f.current().id, 'greet.mjs'),
    "export const greet = () => 'changed';\n",
  );
  assert.equal((await f.worker.processTask(f.current())).status, 'merging');
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.calls.filter(c => c.command[1] === '--test').length, 2);
});

test('IA timeout is distinct from shutdown and the testing phase receives its own deadline', async t => {
  const f = await fixture(t, {
    model: async input => {
      await delay(1000, undefined, { signal: input.signal });
    },
  });
  const worker = createWorker({ ...f.config, modelTimeoutMs: 30 }, f.dependencies);
  assert.equal((await worker.processTask(f.prepare())).status, 'interrupted');
  assert.match(f.current().interruption, /Délai dépassé.*travail IA/);
  assert.equal(f.pr, undefined);
  assert.equal((await f.state.get(f.current().id)).checkpoint, undefined);
});

test('phase deadline configuration keeps explicit legacy values and validates every limit', () => {
  const env = {
    PLANIFIKATEUR_URL: 'https://example.com',
    PLANIFIKATEUR_AGENT_TOKEN: 'agent',
    PLANIFIKATEUR_GITHUB_TOKEN: 'github',
  };
  const config = readWorkerConfig(env);
  assert.equal(config.taskTimeoutMs, 60 * 60000);
  assert.equal(config.modelTimeoutMs, 30 * 60000);
  assert.equal(config.testsTimeoutMs, 30 * 60000);
  assert.equal(config.setupTimeoutMs, 15 * 60000);
  assert.equal(config.publicationTimeoutMs, 10 * 60000);
  assert.equal(config.githubPollMs, 60000);
  assert.equal(config.diagnosticMs, 15 * 60000);
  assert.equal(readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_TIMEOUT_MS: '1200000' }).taskTimeoutMs, 1200000);
  for (const phase of ['SETUP', 'MODEL', 'TESTS', 'PUBLICATION']) {
    assert.throws(() => readWorkerConfig({ ...env, [`PLANIFIKATEUR_WORKER_${phase}_TIMEOUT_MS`]: '0' }), /invalide/);
    assert.throws(
      () => readWorkerConfig({ ...env, [`PLANIFIKATEUR_WORKER_${phase}_TIMEOUT_MS`]: '7200001' }),
      /invalide/,
    );
  }
});

test('changed generated attachment invalidates the checkpoint even when ignored by Git', async t => {
  const controller = new AbortController();
  let interrupted = false;
  const f = await fixture(t, {
    model: async input => {
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      await mkdir(join(input.cwd, '.planifikateur/generated'), { recursive: true });
      await writeFile(join(input.cwd, '.planifikateur/generated/result.txt'), 'Expected result');
      return { status: 'result', summary: 'Generated result', files: ['.planifikateur/generated/result.txt'] };
    },
    execute: async (command, args) => {
      if (command[1] === 'browser-check.mjs' && !interrupted) {
        interrupted = true;
        controller.abort();
        args.signal.throwIfAborted();
      }
    },
  });
  await f.worker.processTask(f.prepare(), controller.signal);
  await writeFile(
    join(f.config.stateRoot, 'jobs', f.current().id, '.planifikateur/generated/result.txt'),
    'Changed result',
  );
  assert.equal((await f.worker.processTask(f.current())).status, 'merging');
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.calls.filter(c => c.command[1] === '--test').length, 2);
});

test('after failed GitHub checks the model receives the failed jobs and the end of their logs', async t => {
  const f = await fixture(t);
  f.prepare();
  const submission = await f.worker.tick();
  const { workflow } = f.current().executionProfile;
  f.store.workflows.githubChecks({
    action: 'completed',
    repository: { full_name: repository },
    workflow_run: {
      id: 77,
      run_attempt: 1,
      name: workflow.name,
      path: `.github/workflows/${workflow.file}`,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
      head_sha: submission.sha,
      head_repository: { full_name: repository },
      html_url: 'https://github.com/run/77',
    },
  });
  assert.equal(f.current().state, 'ready');
  f.github.failedChecks = async (repo, runId) => {
    assert.equal(runId, 77);
    return [{ name: 'Tests navigateur', steps: ['Playwright'], log: 'Error: menu introuvable' }];
  };
  await f.worker.tick();
  assert.equal(f.modelCalls.length, 2);
  const { feedback } = f.modelCalls[1];
  assert.match(feedback, /run\/77/);
  assert.match(feedback, /Job « Tests navigateur » — étapes en échec : Playwright/);
  assert.match(feedback, /menu introuvable/);
});

test('a GitHub checks failure caused by the runner republishes the PR once without calling the model', async t => {
  const f = await fixture(t);
  f.prepare();
  const fail = (sha, id) => {
    const { workflow } = f.current().executionProfile;
    f.store.workflows.githubChecks({
      action: 'completed',
      repository: { full_name: repository },
      workflow_run: {
        id,
        run_attempt: 1,
        name: workflow.name,
        path: `.github/workflows/${workflow.file}`,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'failure',
        head_sha: sha,
        head_repository: { full_name: repository },
        html_url: `https://github.com/run/${id}`,
      },
    });
  };
  f.github.failedChecks = async () => [
    {
      name: 'tablette',
      steps: ['Parcours dans le navigateur (Playwright)'],
      log: 'E: Unable to locate package libgtk-4-1\nFailed to install browsers',
    },
  ];
  const first = await f.worker.tick();
  fail(first.sha, 77);
  assert.equal(f.current().state, 'ready');
  assert.equal((await f.worker.tick()).status, 'merging');
  assert.equal(f.modelCalls.length, 1, 'Le modèle n’est pas sollicité pour une panne du runner.');
  // La même panne revient : le modèle reçoit cette fois les journaux pour corriger.
  fail(f.current().submissions.at(-1).pullRequest.headSha, 78);
  assert.equal(f.current().state, 'ready');
  await f.worker.tick();
  assert.equal(f.modelCalls.length, 2);
  assert.match(f.modelCalls[1].feedback, /Unable to locate package/);
});

test('infrastructureFailure recognises runner failures but not a failing test', () => {
  assert.ok(infrastructureFailure('E: Unable to locate package libopus0'));
  assert.ok(infrastructureFailure('npm error code ECONNRESET'));
  assert.ok(infrastructureFailure('The runner has received a shutdown signal.'));
  assert.ok(!infrastructureFailure('AssertionError: expected 2 to equal 3'));
  assert.ok(!infrastructureFailure(''));
  assert.ok(!infrastructureFailure(undefined));
});
