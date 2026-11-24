// Banc d’essai commun des tests du worker (tests/worker-*.test.js) : site, dépôt Git local,
// GitHub et modèle simulés.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, stat, utimes, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../../server/store.js';
import { createAppServer } from '../../server/index.js';
import { seedAccount } from './accounts.mjs';
import { readWorkerConfig } from '../../worker/config.mjs';
import { createWorker, infrastructureFailure } from '../../worker/worker.mjs';
import { createState } from '../../worker/state.mjs';
import { commandEnvironment, runCommand } from '../../worker/commands.mjs';
import { createCodexRunner, taskPrompt } from '../../worker/codex.mjs';
import {
  ApiError,
  PublicationPendingError,
  createSiteClient,
  createGithubClient,
  connectionDiagnostic,
} from '../../worker/clients.mjs';
import { mergeAgentPullRequest, requiredJobs } from '../../scripts/merge-agent-pr.mjs';
import { installedProfile } from '../../worker/execution-profile.mjs';
import { BudgetExceededError } from '../../worker/budget.mjs';

export const repository = 'worker/example',
  webhookSecret = 'worker-test-webhook';

export async function fixture(t, options = {}) {
  const repository = options.repository || 'worker/example';
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-worker-'));
  const store = createStore(join(root, 'site.sqlite')),
    user = seedAccount(store);
  const snapshot = store.read(),
    project = snapshot.projects[0],
    card = project.cards[0];
  project.cards.slice(1).forEach(c => {
    c.status = 'draft';
  });
  card.description = 'La fonction greet doit renvoyer bonjour plutôt que hello.';
  card.checklist = [];
  store.write(snapshot.projects, snapshot.revision, user);
  store.workflows.configureGithub(project.id, repository, user);
  const credentials = store.workflows.configureAgent({ name: 'Codex test', projectIds: [project.id] }, user);
  const server = createAppServer({ store, config: { githubWebhookSecret: webhookSecret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bare = join(root, 'remote.git'),
    source = join(root, 'source');
  await mkdir(source);
  const git = async (args, cwd = source) => {
    const r = await runCommand(['git', ...args], {
      cwd,
      env: { ...commandEnvironment(), HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(r.code, 0, r.output);
    return r.output.trim();
  };
  await git(['init', '--bare', '--initial-branch=main', bare]);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'greet.mjs'), "export const greet = () => 'hello';\n");
  await writeFile(
    join(source, 'test.mjs'),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.mjs'; test('French greeting', () => assert.equal(greet(), 'bonjour'));\n",
  );
  await writeFile(
    join(source, 'browser-check.mjs'),
    "import assert from 'node:assert/strict'; import { greet } from './greet.mjs'; assert.equal(`<h1>${greet()}</h1>`, '<h1>bonjour</h1>');\n",
  );
  if (!options.preset || ['planifikateur', 'defilordi'].includes(options.preset)) {
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    await writeFile(
      join(source, 'package-lock.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', packages: { '': { version: '1.0.0' } } }),
    );
  }
  if (options.preset === 'funkart')
    await writeFile(join(source, 'project.godot'), '[application]\nconfig/version="1.0.0"\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture']);
  await git(['remote', 'add', 'origin', bare]);
  await git(['push', 'origin', 'main']);
  const config = readWorkerConfig({
    PLANIFIKATEUR_URL: origin,
    PLANIFIKATEUR_AGENT_TOKEN: credentials.token,
    PLANIFIKATEUR_GITHUB_TOKEN: 'github-test-token',
    PLANIFIKATEUR_WORKER_DISCOVERY: options.auto ? 'auto' : 'manual',
    PLANIFIKATEUR_WORKER_PROJECTS: project.id,
    PLANIFIKATEUR_WORKER_REPOSITORIES: repository,
    PLANIFIKATEUR_WORKER_STATE_DIR: join(root, 'worker'),
    // Les tests enchaînent les tours : la PR est relue à chacun (voir le test de l’espacement).
    PLANIFIKATEUR_WORKER_GITHUB_POLL_MS: '0',
    OPENAI_API_KEY: 'model-test-key',
    PLANIFIKATEUR_WORKER_INSTALL_COMMANDS: JSON.stringify([['node', '--version']]),
    PLANIFIKATEUR_WORKER_TEST_COMMANDS: JSON.stringify([
      ['node', '--test', 'test.mjs'],
      ['node', 'browser-check.mjs'],
    ]),
  });
  store.workflows.configureExecution(
    project.id,
    {
      preset: options.preset || 'planifikateur',
      installCommands: config.installCommands,
      testCommands: config.testCommands,
    },
    user,
  );
  const profile = store.workflows.executionProfile(project.id);
  const state = createState(config.stateRoot),
    calls = [],
    logs = [];
  const execute = async (command, args) => {
    calls.push({ command, env: args.env });
    if (options.execute) {
      const result = await options.execute(command, args);
      if (result) return result;
    }
    if (options.preset && command[0] === 'node' && command[1] === '--version')
      return { code: 0, output: `v${profile.nodeMajor}.0.0` };
    if (options.preset && command[0] === 'godot' && command[1] === '--version')
      return { code: 0, output: '4.4.1.stable.official' };
    if (options.refusePush && command[0] === 'git' && command[1] === 'push')
      return { code: 1, output: options.refusePush() };
    if (command[0] === 'git')
      command = ['git', '-c', `url.${bare}.insteadOf=https://github.com/${repository}.git`, ...command.slice(1)];
    return runCommand(command, args);
  };
  let pr,
    labels = 0,
    branch,
    behind = false,
    testsReady = false,
    merges = 0,
    mergeFailure = false,
    publications = 0;
  const mergeClient = createGithubClient('github-test-token', async (url, request) => {
    const path = new URL(url).pathname;
    if (path === `/repos/${repository}`) return Response.json({ full_name: repository });
    if (path.endsWith(`/actions/workflows/${profile.workflow.file}`))
      return Response.json({ id: 2, name: profile.workflow.name, state: 'active' });
    if (path.includes('/contents/.github/workflows/'))
      return Response.json({ encoding: 'base64', content: Buffer.from('on:\n  pull_request:\n').toString('base64') });
    const run = {
      id: 1,
      workflow_id: 2,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      head_repository: { full_name: repository },
      head_sha: pr?.head.sha || 'a'.repeat(40),
      head_branch: branch,
      run_attempt: 1,
    };
    let data;
    if (path.endsWith(`/${profile.workflow.file}/runs`)) data = { workflow_runs: testsReady ? [run] : [] };
    else if (path.endsWith('/ci.yml')) data = { id: 2 };
    else if (path.endsWith('/actions/runs/1/jobs'))
      data = {
        jobs: profile.workflow.jobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 })),
        total_count: profile.workflow.jobs.length,
      };
    else if (path.endsWith('/actions/runs/1')) data = run;
    else if (path.endsWith('/pulls/1/merge')) {
      if (mergeFailure) return Response.json({ message: 'Forbidden' }, { status: 403 });
      assert.equal(request.method, 'PUT');
      assert.equal(JSON.parse(request.body).sha, pr.head.sha);
      await git(['update-ref', 'refs/heads/main', pr.head.sha], bare);
      merges++;
      pr.merged = true;
      pr.state = 'closed';
      data = { merged: true, sha: pr.head.sha };
    } else if (path.endsWith('/pulls/1')) data = pr;
    else if (path.endsWith('/pulls')) data = [pr];
    else if (path.endsWith('/branches/main')) data = { commit: { sha: await git(['rev-parse', 'main'], bare) } };
    else if (path.includes('/compare/')) data = { status: behind ? 'diverged' : 'ahead' };
    else throw new Error(`Unexpected GitHub request: ${path}`);
    return Response.json(data);
  });
  const github = {
    request: mergeClient.request,
    async ensurePullRequest(repo, name, title, body, signal, expectedSha) {
      assert.equal(repo, repository);
      branch = name;
      const sha = await git(['rev-parse', `refs/heads/${branch}`], bare);
      assert.equal(expectedSha, sha, 'publication must confirm the locally tested commit');
      pr ||= {
        number: 1,
        state: 'open',
        html_url: `https://github.com/${repository}/pull/1`,
        base: { ref: 'main' },
        head: { repo: { full_name: repository } },
        labels: [],
      };
      pr.head.sha = sha;
      pr.head.ref = branch;
      pr.title = title;
      pr.body = body;
      if (options.publicationPending && publications++ === 0) throw new PublicationPendingError();
      return structuredClone(pr);
    },
    async pull() {
      pr.head.sha = await git(['rev-parse', `refs/heads/${branch}`], bare);
      return structuredClone(pr);
    },
    async label() {
      assert.equal(store.workflows.list(project.id, card.id)[0].state, 'merging', 'label must follow submission');
      labels++;
      if (options.labelFailure && labels === 1) throw new Error('Label temporarily unavailable');
      pr.labels = [{ name: 'planifikateur-agent' }];
    },
    async unlabel() {
      pr.labels = [];
    },
    async behindMain() {
      return behind;
    },
    mergeWhenReady: mergeClient.mergeWhenReady,
  };
  const modelCalls = [];
  const model = {
    async run(input) {
      assert.equal(input.run.leaseToken, undefined);
      modelCalls.push(input);
      await input.onThread('fixture-thread');
      if (options.model) return options.model(input, modelCalls.length);
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Greeting translated', question: '' };
    },
  };
  // Presets installés du worker de test : ceux du dépôt, avec les commandes de la fixture.
  const fixturePresets = data => ({
    ...installedProfile(data),
    installCommands: config.installCommands,
    testCommands: config.testCommands,
  });
  const dependencies = {
    github,
    state,
    model,
    execute,
    installedProfile: fixturePresets,
    log: message => logs.push(message),
  };
  const worker = createWorker(config, dependencies),
    site = createSiteClient(config);
  const prepare = () => store.workflows.prepare(project.id, card.id, { delivery: 'github' }, user);
  const current = () => store.workflows.list(project.id, card.id)[0];
  const webhook = async payload => {
    const raw = JSON.stringify(payload);
    const response = await fetch(`${origin}/api/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(raw).digest('hex'),
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    root,
    store,
    user,
    project,
    card,
    credentials,
    config,
    state,
    worker,
    site,
    prepare,
    current,
    github,
    dependencies,
    calls,
    modelCalls,
    logs,
    git,
    bare,
    source,
    webhook,
    get pr() {
      return pr;
    },
    get merges() {
      return merges;
    },
    setMergeFailure(value) {
      mergeFailure = value;
    },
    setTestsReady(value) {
      testsReady = value;
    },
    setBehind(value) {
      behind = value;
    },
  };
}

export const qtForm =
  '<?xml version="1.0"?><ui version="4.0"><class>PersonForm</class><widget class="QWidget" name="PersonForm"><layout class="QFormLayout" name="formLayout"><item row="0" column="0"><widget class="QLabel" name="nameLabel"><property name="text"><string>Nom</string></property></widget></item><item row="0" column="1"><widget class="QLineEdit" name="nameEdit"/></item></layout></widget><resources/><connections/></ui>';

export const answer = f => {
  const waiting = f.current();
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    waiting.id,
    'answer',
    { version: waiting.version, message: 'Continue.' },
    f.user,
  );
};

export const exists = path =>
  access(path).then(
    () => true,
    () => false,
  );

export {
  createHmac,
  access,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
  rm,
  tmpdir,
  join,
  delay,
  createStore,
  createAppServer,
  seedAccount,
  readWorkerConfig,
  createWorker,
  infrastructureFailure,
  createState,
  commandEnvironment,
  runCommand,
  createCodexRunner,
  taskPrompt,
  ApiError,
  PublicationPendingError,
  createSiteClient,
  createGithubClient,
  connectionDiagnostic,
  mergeAgentPullRequest,
  requiredJobs,
  installedProfile,
  BudgetExceededError,
};
