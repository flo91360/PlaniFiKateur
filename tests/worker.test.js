import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount } from './helpers/accounts.mjs';
import { readWorkerConfig } from '../worker/config.mjs';
import { createWorker } from '../worker/worker.mjs';
import { createState } from '../worker/state.mjs';
import { commandEnvironment, runCommand } from '../worker/commands.mjs';
import { createCodexRunner, taskPrompt } from '../worker/codex.mjs';
import { ApiError, PublicationPendingError, createSiteClient, createGithubClient, connectionDiagnostic } from '../worker/clients.mjs';
import { mergeAgentPullRequest, requiredJobs } from '../scripts/merge-agent-pr.mjs';

const repository = 'worker/example', webhookSecret = 'worker-test-webhook';
async function fixture(t, options = {}) {
  const repository = options.repository || 'worker/example';
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-worker-'));
  const store = createStore(join(root, 'site.sqlite')), user = seedAccount(store);
  const snapshot = store.read(), project = snapshot.projects[0], card = project.cards[0];
  project.cards.slice(1).forEach(c => { c.status = 'draft'; });
  card.description = 'La fonction greet doit renvoyer bonjour plutôt que hello.'; card.checklist = [];
  store.write(snapshot.projects, snapshot.revision, user);
  store.workflows.configureGithub(project.id, repository, user);
  const credentials = store.workflows.configureAgent({ name: 'Codex test', projectIds: [project.id] }, user);
  const server = createAppServer({ store, config: { githubWebhookSecret: webhookSecret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  const bare = join(root, 'remote.git'), source = join(root, 'source'); await mkdir(source);
  const git = async (args, cwd = source) => { const r = await runCommand(['git', ...args], { cwd, env: { ...commandEnvironment(), HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.code, 0, r.output); return r.output.trim(); };
  await git(['init', '--bare', '--initial-branch=main', bare]);
  await git(['init', '--initial-branch=main']); await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(source, 'greet.mjs'), "export const greet = () => 'hello';\n");
  await writeFile(join(source, 'test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { greet } from './greet.mjs'; test('French greeting', () => assert.equal(greet(), 'bonjour'));\n");
  await writeFile(join(source, 'browser-check.mjs'), "import assert from 'node:assert/strict'; import { greet } from './greet.mjs'; assert.equal(`<h1>${greet()}</h1>`, '<h1>bonjour</h1>');\n");
  if (!options.preset || ['planifikateur', 'defilordi'].includes(options.preset)) {
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    await writeFile(join(source, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  }
  if (options.preset === 'funkart') await writeFile(join(source, 'project.godot'), '[application]\nconfig/version="1.0.0"\n');
  await git(['add', '.']); await git(['commit', '-m', 'Fixture']); await git(['remote', 'add', 'origin', bare]); await git(['push', 'origin', 'main']);
  const config = readWorkerConfig({
    PLANIFIKATEUR_URL: origin, PLANIFIKATEUR_AGENT_TOKEN: credentials.token, PLANIFIKATEUR_GITHUB_TOKEN: 'github-test-token',
    PLANIFIKATEUR_WORKER_DISCOVERY: options.auto ? 'auto' : 'manual', PLANIFIKATEUR_WORKER_PROJECTS: project.id, PLANIFIKATEUR_WORKER_REPOSITORIES: repository,
    PLANIFIKATEUR_WORKER_STATE_DIR: join(root, 'worker'), OPENAI_API_KEY: 'model-test-key',
    PLANIFIKATEUR_WORKER_INSTALL_COMMANDS: JSON.stringify([['node', '--version']]),
    PLANIFIKATEUR_WORKER_TEST_COMMANDS: JSON.stringify([['node', '--test', 'test.mjs'], ['node', 'browser-check.mjs']]),
  });
  store.workflows.configureExecution(project.id, { preset: options.preset || 'planifikateur', installCommands: config.installCommands, testCommands: config.testCommands }, user);
  const profile = store.workflows.executionProfile(project.id);
  const state = createState(config.stateRoot), calls = [], logs = [];
  const execute = async (command, args) => {
    calls.push({ command, env: args.env });
    if (options.preset && command[0] === 'node' && command[1] === '--version') return { code: 0, output: `v${profile.nodeMajor}.0.0` };
    if (options.preset && command[0] === 'godot' && command[1] === '--version') return { code: 0, output: '4.4.1.stable.official' };
    if (options.refusePush && command[0] === 'git' && command[1] === 'push') return { code: 1, output: options.refusePush() };
    if (command[0] === 'git') command = ['git', '-c', `url.${bare}.insteadOf=https://github.com/${repository}.git`, ...command.slice(1)];
    return runCommand(command, args);
  };
  let pr, labels = 0, branch, behind = false, testsReady = false, merges = 0, mergeFailure = false, publications = 0;
  const mergeClient = createGithubClient('github-test-token', async (url, request) => {
    const path = new URL(url).pathname;
    if (path === `/repos/${repository}`) return Response.json({ full_name: repository });
    if (path.endsWith(`/actions/workflows/${profile.workflow.file}`)) return Response.json({ id: 2, name: profile.workflow.name, state: 'active' });
    if (path.includes('/contents/.github/workflows/')) return Response.json({ encoding: 'base64', content: Buffer.from('on:\n  pull_request:\n').toString('base64') });
    const run = { id: 1, workflow_id: 2, event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: { full_name: repository }, head_sha: pr?.head.sha || 'a'.repeat(40), head_branch: branch, run_attempt: 1 };
    let data;
    if (path.endsWith(`/${profile.workflow.file}/runs`)) data = { workflow_runs: testsReady ? [run] : [] };
    else if (path.endsWith('/ci.yml')) data = { id: 2 };
    else if (path.endsWith('/actions/runs/1/jobs')) data = { jobs: profile.workflow.jobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 })), total_count: profile.workflow.jobs.length };
    else if (path.endsWith('/actions/runs/1')) data = run;
    else if (path.endsWith('/pulls/1/merge')) {
      if (mergeFailure) return Response.json({ message: 'Forbidden' }, { status: 403 });
      assert.equal(request.method, 'PUT'); assert.equal(JSON.parse(request.body).sha, pr.head.sha);
      await git(['update-ref', 'refs/heads/main', pr.head.sha], bare);
      merges++; pr.merged = true; pr.state = 'closed'; data = { merged: true, sha: pr.head.sha };
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
      assert.equal(repo, repository); branch = name;
      const sha = await git(['rev-parse', `refs/heads/${branch}`], bare);
      assert.equal(expectedSha, sha, 'publication must confirm the locally tested commit');
      pr ||= { number: 1, state: 'open', html_url: `https://github.com/${repository}/pull/1`, base: { ref: 'main' }, head: { repo: { full_name: repository } }, labels: [] };
      pr.head.sha = sha; pr.head.ref = branch; pr.title = title; pr.body = body;
      if (options.publicationPending && publications++ === 0) throw new PublicationPendingError();
      return structuredClone(pr);
    },
    async pull() { pr.head.sha = await git(['rev-parse', `refs/heads/${branch}`], bare); return structuredClone(pr); },
    async label() {
      assert.equal(store.workflows.list(project.id, card.id)[0].state, 'merging', 'label must follow submission');
      labels++;
      if (options.labelFailure && labels === 1) throw new Error('Label temporarily unavailable');
      pr.labels = [{ name: 'planifikateur-agent' }];
    },
    async unlabel() { pr.labels = []; },
    async behindMain() { return behind; },
    mergeWhenReady: mergeClient.mergeWhenReady,
  };
  const modelCalls = [];
  const model = { async run(input) {
    assert.equal(input.run.leaseToken, undefined); modelCalls.push(input);
    await input.onThread('fixture-thread');
    if (options.model) return options.model(input, modelCalls.length);
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'Greeting translated', question: '' };
  } };
  const dependencies = { github, state, model, execute, log: message => logs.push(message) };
  const worker = createWorker(config, dependencies), site = createSiteClient(config);
  const prepare = () => store.workflows.prepare(project.id, card.id, { delivery: 'github' }, user);
  const current = () => store.workflows.list(project.id, card.id)[0];
  const webhook = async payload => {
    const raw = JSON.stringify(payload);
    const response = await fetch(`${origin}/api/v1/github/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(raw).digest('hex') }, body: raw });
    assert.equal(response.status, 200); return response.json();
  };
  return { root, store, user, project, card, credentials, config, state, worker, site, prepare, current, github, dependencies, calls, modelCalls, logs, git, bare, source, webhook, get pr() { return pr; }, get merges() { return merges; }, setMergeFailure(value) { mergeFailure = value; }, setTestsReady(value) { testsReady = value; }, setBehind(value) { behind = value; } };
}

test('worker merges only after GitHub CI and site eligibility, without Actions secrets or another model call', async t => {
  const f = await fixture(t); f.prepare();
  const submission = await f.worker.tick();
  await f.worker.tick(); assert.equal(f.merges, 0); assert.equal(f.modelCalls.length, 1);
  f.setTestsReady(true);
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(f.merges, 1); assert.equal(f.modelCalls.length, 1);
  assert.equal(f.current().state, 'merging', 'the signed webhook alone completes the card');
  assert.ok(f.logs.some(line => line.includes('fusionnée après réussite des tests GitHub')));
  await f.webhook({ action: 'closed', repository: { full_name: repository }, pull_request: { number: 1, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: submission.sha, head: { sha: submission.sha, repo: { full_name: repository } }, base: { ref: 'main' } } });
  await f.worker.tick(); assert.equal(f.current().state, 'done'); assert.equal(f.merges, 1);
});

test('a push refused for a missing workflow permission asks for the token change instead of retrying', async t => {
  const f = await fixture(t, {
    refusePush: () => "To https://github.com/flo91360/defilordi.git\n ! [remote rejected] HEAD -> planifikateur/x (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/build-windows.yml` without `workflow` scope)\nerror: failed to push some refs",
    model: async input => {
      await mkdir(join(input.cwd, '.github', 'workflows'), { recursive: true });
      await writeFile(join(input.cwd, '.github', 'workflows', 'build-windows.yml'), 'on: push\n');
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Build Windows', question: '' };
    },
  });
  f.prepare();
  const outcome = await f.worker.tick(); assert.equal(outcome.status, 'waiting', f.logs.join('\n'));
  const run = f.current(); assert.equal(run.state, 'waiting');
  const message = run.exchanges.at(-1).question;
  assert.match(message, /portée « workflow »/); assert.match(message, /\.github\/workflows\/build-windows\.yml/);
  assert.ok(!message.includes('github-test-token'));
  assert.equal(f.pr, undefined);
});

test('a refused merge automatically retries without consuming another model attempt or replacing the PR', async t => {
  const f = await fixture(t); f.prepare(); await f.worker.tick(); f.setTestsReady(true); f.setMergeFailure(true);
  await f.worker.tick(); await f.worker.tick();
  assert.equal(f.merges, 0); assert.equal(f.current().state, 'merging'); assert.equal(f.modelCalls.length, 1);
  assert.equal(f.logs.filter(line => line.includes('fusion automatique bloquée')).length, 1);
  f.setMergeFailure(false); await f.worker.tick();
  assert.equal(f.merges, 1); assert.equal(f.modelCalls.length, 1); assert.equal(f.pr.number, 1);
});

test('local end-to-end from ready card status: real API, Git changes, passing tests, PR simulation, gated merge and signed completion', async t => {
  const f = await fixture(t), snapshot = f.store.read();
  snapshot.projects[0].cards[0].status = 'ready'; f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.equal(f.current(), undefined);
  const outcome = await f.worker.tick(); const ready = f.current(); assert.equal(outcome.status, 'merging');
  assert.equal(f.current().state, 'merging'); assert.equal(f.store.read().projects[0].cards[0].status, 'review');
  assert.match(await f.git(['show', `${outcome.sha}:greet.mjs`], f.bare), /bonjour/);
  const changelog = await f.git(['show', `${outcome.sha}:CHANGELOG.md`], f.bare);
  assert.ok(changelog.startsWith('# Changelog')); assert.match(changelog, /\n## 1\.0\.1 — \d{4}-\d{2}-\d{2}\n/);
  assert.ok(changelog.includes(`<!-- planifikateur:${ready.id} -->\n\n- **${f.card.title}** : Greeting translated`));
  const job = await f.state.get(ready.id); assert.equal(job.threadId, 'fixture-thread');
  const serialized = JSON.stringify(job); assert.ok(!serialized.includes(f.credentials.token)); assert.ok(!serialized.includes('github-test-token')); assert.ok(!serialized.includes('leaseToken'));
  for (const call of f.calls.filter(c => c.command[0] !== 'git')) { assert.equal(call.env.PLANIFIKATEUR_GIT_TOKEN, undefined); assert.equal(call.env.PLANIFIKATEUR_AGENT_TOKEN, undefined); assert.equal(call.env.OPENAI_API_KEY, undefined); }
  assert.ok(f.calls.findIndex(c => c.command[0] === 'node' && c.command[1] === 'browser-check.mjs') < f.calls.findIndex(c => c.command[0] === 'git' && c.command[1] === 'push'));
  const run = { workflow_id: 2, event: 'pull_request', status: 'completed', conclusion: 'success', head_repository: { full_name: repository }, head_sha: outcome.sha, head_branch: job.branch, run_attempt: 1 };
  const request = async (path, method, data) => {
    if (path.endsWith('/merge')) {
      assert.equal(method, 'PUT'); assert.equal(data.sha, outcome.sha);
      await f.git(['update-ref', 'refs/heads/main', outcome.sha], f.bare);
      return { merged: true, sha: outcome.sha };
    }
    if (path.includes('/jobs?')) return { jobs: requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 })), total_count: 2 };
    if (path.endsWith('/ci.yml')) return { id: 2 };
    if (path.includes('/actions/runs/')) return run;
    if (path.includes('/pulls?')) return [f.pr];
    if (path.endsWith('/pulls/1')) return f.pr;
    if (path.endsWith('/branches/main')) return { commit: { sha: await f.git(['rev-parse', 'main'], f.bare) } };
    if (path.includes('/compare/')) return { status: 'ahead' };
    throw new Error(path);
  };
  const merged = await mergeAgentPullRequest({ repository, runId: 1, request, eligible: async ({ number, sha }) => f.store.workflows.mergeEligible(repository, number, sha, f.credentials.agent).eligible });
  assert.equal(merged.merged, true); assert.equal(f.current().state, 'merging');
  await f.webhook({ action: 'closed', repository: { full_name: repository }, pull_request: { number: 1, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: outcome.sha, head: { sha: outcome.sha, repo: { full_name: repository } }, base: { ref: 'main' } } });
  assert.equal(f.current().state, 'done'); assert.equal(f.store.read().projects[0].cards[0].status, 'done');
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
  const jobs = ['finished-job', 'waiting-job'].map((id, index) => ({ id, projectId: f.project.id, cardId: f.card.id, repository, phase: index ? 'waiting' : 'done' }));
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
  const f = await fixture(t); const run = f.prepare();
  const second = createWorker(f.config, f.dependencies);
  const results = await Promise.all([f.worker.processTask(run), second.processTask(run)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['claimed_elsewhere', 'merging']); assert.equal(f.modelCalls.length, 1);
});

test('deleted cards in persisted jobs do not block a new task and their checkout remains intact', async t => {
  const f = await fixture(t);
  const jobs = ['deleted-job-one', 'deleted-job-two'].map(id => ({ id, projectId: f.project.id, cardId: 'deleted-card', repository, phase: 'interrupted', threadId: 'previous-thread' }));
  for (const job of jobs) await f.state.put(job);
  const checkout = join(f.config.stateRoot, 'jobs', jobs[0].id);
  await mkdir(checkout, { recursive: true }); await writeFile(join(checkout, 'partial.txt'), 'Keep partial work');
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  for (const job of jobs) assert.deepEqual(await f.state.get(job.id), { ...job, phase: 'cancelled' });
  assert.equal(await readFile(join(checkout, 'partial.txt'), 'utf8'), 'Keep partial work');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.logs.filter(message => message.includes('carte absente de son projet')).length, 2);
  const restarted = createWorker(f.config, { ...f.dependencies, site: { ...f.site, history: job => {
    assert.ok(!jobs.some(old => old.id === job.id), 'archived jobs must not be queried again');
    return f.site.history(job);
  } } });
  assert.equal((await restarted.tick()).status, 'idle'); assert.equal(f.modelCalls.length, 1);
});

test('an execution absent from an existing card is archived locally and the current task proceeds', async t => {
  const f = await fixture(t);
  const old = { id: 'missing-execution', projectId: f.project.id, cardId: f.card.id, repository, phase: 'running' };
  await f.state.put(old); f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging');
  assert.deepEqual(await f.state.get(old.id), { ...old, phase: 'cancelled' });
  assert.equal(f.modelCalls.length, 1);
});

test('access denials, network failures and unrelated 404 errors never discard persisted jobs', async t => {
  const f = await fixture(t), job = { id: 'protected-job', projectId: f.project.id, cardId: f.card.id, repository, phase: 'interrupted' };
  await f.state.put(job);
  for (const error of [new ApiError(401, 'agent_unauthorized'), new ApiError(403, 'agent_scope'), new ApiError(404, 'unknown_route'), new TypeError('fetch failed')]) {
    let polled = false;
    const worker = createWorker(f.config, { ...f.dependencies, site: { ...f.site, history: async () => { throw error; }, queue: async () => { polled = true; return []; } } });
    await assert.rejects(worker.tick(), caught => caught === error);
    assert.equal(polled, false); assert.deepEqual(await f.state.get(job.id), job);
  }
});

test('questions pause publication and an answer resumes the persisted conversation and checkout', async t => {
  const f = await fixture(t, { model: async (input, number) => {
    if (number === 1) { await writeFile(join(input.cwd, 'notes.txt'), 'Partial work'); return { status: 'question', question: 'Quelle langue ?', summary: '' }; }
    assert.equal(input.job.threadId, 'fixture-thread'); assert.equal(input.run.exchanges.at(-1).answer.text, 'Français');
    assert.equal(await readFile(join(input.cwd, 'notes.txt'), 'utf8'), 'Partial work');
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'French greeting', question: '' };
  } });
  f.prepare(); assert.equal((await f.worker.tick()).status, 'waiting'); assert.equal(f.pr, undefined);
  const snapshot = f.store.read();
  assert.equal(snapshot.projects[0].cards[0].comments.at(-1).text, 'Quelle langue ?');
  snapshot.projects[0].cards[0].comments.push({ id: 'language-reply', author: f.user.name, text: 'Français', date: new Date().toISOString() });
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  const restarted = createWorker(f.config, f.dependencies); assert.equal((await restarted.tick()).status, 'merging');
  assert.equal(f.modelCalls.length, 2);
});

test('the worker selects Claude for the project and keeps the resolved model and card effort after an answer', async t => {
  const f = await fixture(t, { model: async (input, number) => {
    assert.equal(input.job.ai.engine, 'claude-code'); assert.equal(input.job.ai.effort, 'high');
    if (number === 2) assert.equal(input.job.ai.model, 'claude-sonnet-resolved');
    await input.onRuntime({ engine: 'claude-code', model: 'claude-sonnet-resolved', effort: 'high' });
    if (number === 1) return { status: 'question', summary: '', question: 'Quelle langue ?', files: [] };
    assert.equal(input.run.exchanges.at(-1).answer.text, 'Français.');
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'Traduit.', question: '', files: [] };
  } });
  const snapshot = f.store.read(); snapshot.projects[0].cards[0].aiEffort = 'high'; f.store.write(snapshot.projects, snapshot.revision, f.user);
  f.store.workflows.configureAi(f.project.id, { engine: 'claude-code', model: 'sonnet' }, f.user);
  const dependencies = { ...f.dependencies, claude: f.dependencies.model, model: { run() { throw new Error('Codex must not execute this task'); } } };
  const worker = createWorker(f.config, dependencies);
  f.prepare(); assert.equal((await worker.tick()).status, 'waiting');
  assert.equal(f.current().aiRuntime.model, 'claude-sonnet-resolved');
  f.store.workflows.configureAi(f.project.id, { engine: 'codex', model: 'different-model' }, f.user);
  const reply = f.store.read(); reply.projects[0].cards[0].comments.push({ id: 'claude-answer', author: f.user.name, text: 'Français.', date: new Date().toISOString() });
  f.store.write(reply.projects, reply.revision, f.user);
  assert.equal((await createWorker(f.config, dependencies).tick()).status, 'merging');
  assert.equal(f.current().ai.engine, 'claude-code'); assert.equal(f.modelCalls.length, 2);
});

const qtForm = '<?xml version="1.0"?><ui version="4.0"><class>PersonForm</class><widget class="QWidget" name="PersonForm"><layout class="QFormLayout" name="formLayout"><item row="0" column="0"><widget class="QLabel" name="nameLabel"><property name="text"><string>Nom</string></property></widget></item><item row="0" column="1"><widget class="QLineEdit" name="nameEdit"/></item></layout></widget><resources/><connections/></ui>';
test('a model question is relayed literally, a card reply resumes the thread and the generated Qt file is delivered without a PR', async t => {
  const question = 'Quels champs souhaitez-vous dans le formulaire Qt ?';
  const f = await fixture(t, { model: async (input, number) => {
    if (number === 1) return { status: 'question', summary: '', question, files: [] };
    assert.equal(input.job.threadId, 'fixture-thread');
    assert.equal(input.run.exchanges.at(-1).answer.text, 'Un champ Nom suffit.');
    await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
    await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), qtForm);
    return { status: 'result', summary: 'Le formulaire Qt est prêt à télécharger.', question: '', files: ['.planifikateur/generated/personne.ui'] };
  } });
  const initial = f.store.read(); initial.projects[0].cards[0].description = 'Génère un fichier Qt .ui avec un formulaire sur la personne.'; f.store.write(initial.projects, initial.revision, f.user);
  f.prepare(); assert.equal((await f.worker.tick()).status, 'waiting');
  let snapshot = f.store.read(), card = snapshot.projects[0].cards[0];
  assert.equal(card.status, 'clarify'); assert.equal(card.comments.at(-1).text, question);
  assert.equal(card.attachments.length, 0);
  card.comments.push({ id: 'form-answer', author: f.user.name, text: 'Un champ Nom suffit.', date: new Date().toISOString() });
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  const restarted = createWorker(f.config, f.dependencies);
  assert.equal((await restarted.tick()).status, 'done');
  snapshot = f.store.read(); card = snapshot.projects[0].cards[0];
  assert.equal(card.status, 'done'); assert.equal(card.attachments.length, 1);
  assert.equal(card.attachments[0].name, 'personne.ui');
  assert.equal(Buffer.from(card.attachments[0].data, 'base64').toString('utf8'), qtForm);
  assert.ok(card.comments.at(-1).text.includes('personne.ui'));
  assert.equal(f.pr, undefined);
  assert.equal(f.calls.some(call => call.command[0] === 'git' && call.command[1] === 'push'), false);
  assert.equal(f.calls.some(call => call.command.includes('--test')), false);
  await assert.rejects(access(join(f.config.stateRoot, 'jobs', f.current().id)), { code: 'ENOENT' });
});

test('generated files alongside repository changes remain bound to the tested PR and do not cancel its execution', async t => {
  const f = await fixture(t, { model: async input => {
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
    await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), qtForm);
    return { status: 'result', summary: 'Code corrigé et formulaire livré.', question: '', files: ['.planifikateur/generated/personne.ui'] };
  } });
  f.prepare(); assert.equal((await f.worker.tick()).status, 'merging');
  assert.equal(f.store.read().projects[0].cards[0].attachments.length, 1);
  assert.equal(f.current().state, 'merging');
  f.setTestsReady(true); await f.worker.tick(); assert.equal(f.merges, 1);
});

test('missing output declarations and malformed Qt XML are corrected before any file is delivered', async t => {
  const f = await fixture(t, { model: async (input, number) => {
    if (number === 2) assert.match(input.feedback, /indique son chemin dans files/);
    if (number === 3) assert.match(input.feedback, /Corrige les fichiers/);
    await mkdir(join(input.cwd, '.planifikateur', 'generated'), { recursive: true });
    await writeFile(join(input.cwd, '.planifikateur', 'generated', 'personne.ui'), number === 2 ? '<ui>' : qtForm);
    return { status: 'result', summary: 'Formulaire livré.', question: '', files: number === 1 ? [] : ['.planifikateur/generated/personne.ui'] };
  } });
  f.prepare(); assert.equal((await f.worker.tick()).status, 'done');
  assert.equal(f.modelCalls.length, 3);
  const files = f.store.read().projects[0].cards[0].attachments;
  assert.equal(files.length, 1);
  assert.equal(Buffer.from(files[0].data, 'base64').toString(), qtForm);
  assert.equal(f.pr, undefined);
});

test('shutdown interrupts the card and a restart reclaims it without losing conversation', async t => {
  let started; const start = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { model: async (input, number) => {
    if (number === 1) { started(); await delay(60000, undefined, { signal: input.signal }); }
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'Resumed greeting', question: '' };
  } });
  const ready = f.prepare(), stop = new AbortController(); const running = f.worker.processTask(ready, stop.signal);
  await start; stop.abort(new Error('Stopped')); assert.equal((await running).status, 'interrupted'); assert.equal(f.current().state, 'interrupted'); assert.equal(f.pr, undefined);
  assert.equal((await f.worker.processTask(f.current())).status, 'merging'); assert.equal(f.modelCalls[1].job.threadId, 'fixture-thread');
});

test('failed mandatory tests are corrected at most three times and never publish a PR', async t => {
  const f = await fixture(t, { model: async input => {
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'hola';\n");
    return { status: 'result', summary: 'Unverified result', question: '' };
  } });
  f.prepare(); assert.equal((await f.worker.tick()).status, 'interrupted');
  assert.equal(f.modelCalls.length, 3); assert.equal(f.pr, undefined); assert.equal(f.current().state, 'interrupted');
  assert.equal(f.calls.some(c => c.command[0] === 'git' && c.command[1] === 'push'), false);
  assert.match(f.modelCalls[1].feedback, /French greeting|ERR_ASSERTION/);
});

test('label failure after submission recovers without a second claim or submission', async t => {
  const f = await fixture(t, { labelFailure: true }); f.prepare(); await f.worker.tick();
  assert.equal(f.current().state, 'merging'); assert.equal(f.pr.labels.length, 0);
  await f.worker.tick(); assert.equal(f.pr.labels[0].name, 'planifikateur-agent');
  assert.equal(f.current().submissions.length, 1); assert.equal(f.modelCalls.length, 1);
});

test('a pending PR is revised against new main and only its new tested SHA can merge', async t => {
  const f = await fixture(t); f.prepare(); const initial = await f.worker.tick();
  await writeFile(join(f.source, 'readme.md'), 'Another change'); await f.git(['add', '.']); await f.git(['commit', '-m', 'Advance main']); await f.git(['push', 'origin', 'main']);
  f.setBehind(true); const updated = await f.worker.tick(); f.setBehind(false);
  assert.equal(updated.status, 'merging'); assert.notEqual(updated.sha, initial.sha); assert.equal(updated.number, initial.number);
  assert.equal(f.current().submissions.length, 2);
  assert.equal(f.store.workflows.mergeEligible(repository, 1, initial.sha, f.credentials.agent).eligible, false);
  assert.equal(f.store.workflows.mergeEligible(repository, 1, updated.sha, f.credentials.agent).eligible, true);
  assert.equal(f.calls.some(c => c.command.includes('--force') || c.command.includes('--force-with-lease')), false);
});

for (const preset of ['planifikateur', 'defilordi', 'funkart']) test(`automatic discovery delivers ${preset} with its model, repository, tests and GitHub workflow`, async t => {
  const repo = `flo91360/${preset}`;
  const f = await fixture(t, { auto: true, preset, repository: repo });
  f.config.projectIds = []; f.config.repositories = [];
  f.store.workflows.configureAi(f.project.id, { engine: 'codex', model: 'gpt-6.1-sol' }, f.user);
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.modelCalls[0].job.ai.model, 'gpt-6.1-sol');
  assert.equal(f.modelCalls[0].run.repository, repo);
  assert.equal(f.modelCalls[0].run.executionProfile.preset, preset);
  assert.equal(f.store.workflows.workerStatus(f.project.id).state, 'ready');
  f.setTestsReady(true);
  await f.worker.tick(); assert.equal(f.merges, 1);
  const run = f.current();
  await f.webhook({ action: 'closed', repository: { full_name: repo }, pull_request: { number: 1, merged: true, merged_at: new Date().toISOString(), merge_commit_sha: f.pr.head.sha, head: { sha: f.pr.head.sha, repo: { full_name: repo } }, base: { ref: 'main' } } });
  assert.equal(f.current().state, 'done');
  assert.equal(await f.git(['show', 'main:greet.mjs'], f.bare), "export const greet = () => 'bonjour';");
  if (preset !== 'funkart') {
    assert.equal(JSON.parse(await f.git(['show', 'main:package.json'], f.bare)).version, '1.0.1');
    assert.equal(JSON.parse(await f.git(['show', 'main:package-lock.json'], f.bare)).packages[''].version, '1.0.1');
  } else assert.match(await f.git(['show', 'main:project.godot'], f.bare), /config\/version="1.0.1"/);
  assert.match(await f.git(['show', 'main:CHANGELOG.md'], f.bare), new RegExp(`\\n## 1\\.0\\.1 — \\d{4}-\\d{2}-\\d{2}\\n<!-- planifikateur:${run.id} -->\\n\\n- \\*\\*.+\\*\\* : Greeting translated`));
  assert.equal(f.current().id, run.id);
});

test('a blocked new engine configuration does not prevent resuming an existing Codex conversation', async t => {
  const f = await fixture(t, { auto: true, model: async (input, count) => {
    if (count === 1) return { status: 'question', summary: '', question: 'Quelle langue ?' };
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'Traduction prête.', question: '' };
  } });
  f.prepare(); assert.equal((await f.worker.tick()).status, 'waiting');
  f.store.workflows.configureAi(f.project.id, { engine: 'claude-code', model: 'sonnet' }, f.user);
  const waiting = f.current();
  f.store.workflows.human(f.project.id, f.card.id, waiting.id, 'answer', { version: waiting.version, message: 'Français' }, f.user);
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  assert.equal(f.current().ai.engine, 'codex'); assert.equal(f.modelCalls.length, 2);
  assert.equal(f.store.workflows.workerStatus(f.project.id).state, 'blocked');
});

test('withdrawn projects preserve their local conversation and cannot block another authorized project', async t => {
  const f = await fixture(t, { auto: true });
  const previous = { id: 'withdrawn-task', projectId: 'withdrawn-project', cardId: 'previous-card', repository: 'old/repo', phase: 'running', threadId: 'keep-thread' };
  await f.state.put(previous);
  f.prepare(); assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  assert.deepEqual(await f.state.get(previous.id), { ...previous, phase: 'unauthorized' });
  assert.equal(f.modelCalls.length, 1);
});

test('worker ignores manual deliveries and repositories outside its allowlist', async t => {
  const f = await fixture(t); const run = f.prepare();
  assert.equal((await f.worker.processTask({ ...run, repository: 'unapproved/repo' })).status, 'ignored');
  assert.equal((await f.worker.processTask({ ...run, delivery: 'manual' })).status, 'ignored');
  assert.equal(f.current().state, 'ready'); assert.equal(f.modelCalls.length, 0);
});

test('loss of agent access stops Codex through the heartbeat and prevents publication', async t => {
  let started; const start = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { model: async input => { started(); await delay(60000, undefined, { signal: input.signal }); return { status: 'result', summary: 'Too late', question: '' }; } });
  const worker = createWorker({ ...f.config, heartbeatMs: 20 }, f.dependencies);
  const running = worker.processTask(f.prepare()); await start;
  f.store.workflows.revokeAgent(f.credentials.agent.id, f.user);
  assert.equal((await running).status, 'interrupted'); assert.equal(f.pr, undefined);
  assert.equal(f.calls.some(c => c.command[0] === 'git' && c.command[1] === 'push'), false);
  assert.equal((await f.state.get(f.current().id)).attempts, 0);
  assert.match(f.logs.at(-1), /API : 401/);
});

test('temporary heartbeat outages preserve the task and resume lease renewal', async t => {
  let failures = 0, renewals = 0;
  const f = await fixture(t, { model: async input => {
    await delay(160, undefined, { signal: input.signal });
    await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
    return { status: 'result', summary: 'Greeting translated', question: '' };
  } });
  const site = { ...f.site, async action(run, name, data, signal) {
    if (name === 'heartbeat') {
      if (failures++ < 2) throw new ApiError(503, 'unavailable');
      renewals++;
    }
    return f.site.action(run, name, data, signal);
  } };
  const worker = createWorker({ ...f.config, heartbeatMs: 20 }, { ...f.dependencies, site });
  assert.equal((await worker.processTask(f.prepare())).status, 'merging');
  assert.equal(f.modelCalls.length, 1);
  assert.ok(renewals > 0);
  assert.equal(f.logs.filter(line => line.includes('temporairement indisponible')).length, 2);
  assert.equal((await f.state.get(f.current().id)).attempts, 0);
});

test('an outage cannot keep working after the last confirmed lease expires', async t => {
  const f = await fixture(t, { model: async input => {
    await delay(60000, undefined, { signal: input.signal });
    throw new Error('Must stop before completing');
  } });
  const site = { ...f.site, async action(run, name, data, signal) {
    if (name === 'heartbeat') throw new ApiError(502, 'unavailable');
    const response = await f.site.action(run, name, data, signal);
    return response.state === 'running' ? { ...response, leaseExpiresAt: new Date(Date.now() + 200).toISOString() } : response;
  } };
  const worker = createWorker({ ...f.config, heartbeatMs: 20 }, { ...f.dependencies, site });
  assert.equal((await worker.processTask(f.prepare())).status, 'interrupted');
  assert.equal(f.pr, undefined);
  assert.equal(f.current().state, 'interrupted');
  const job = await f.state.get(f.current().id);
  assert.equal(job.attempts, 0);
  assert.equal(job.phase, 'interrupted');
  assert.ok(f.logs.some(line => line.includes('Réservation expirée')));
});

test('connection diagnostics expose codes without response bodies or credentials', () => {
  const secret = 'private-token';
  assert.equal(connectionDiagnostic(new ApiError(401, 'invalid_token')), 'API : 401 invalid_token');
  assert.equal(connectionDiagnostic(new ApiError(500, secret + ' https://private.example')), 'API : 500 api_error');
  assert.equal(connectionDiagnostic(new TypeError(secret, { cause: { code: 'ECONNRESET' } })), 'Réseau : ECONNRESET');
  assert.equal(connectionDiagnostic(new Error(secret)), 'Connexion indisponible');
});

test('a rejected result resumes on the same PR with corrections and a new commit', async t => {
  const f = await fixture(t, { model: async (input, number) => {
    if (number === 2) assert.equal(input.run.submissions.at(-1).decision.message, 'Add a comment explaining the greeting');
    await writeFile(join(input.cwd, 'greet.mjs'), `${number === 2 ? '// French greeting\n' : ''}export const greet = () => 'bonjour';\n`);
    return { status: 'result', summary: 'Greeting corrected', question: '' };
  } });
  f.prepare(); const initial = await f.worker.tick(); const run = f.current();
  f.store.workflows.human(f.project.id, f.card.id, run.id, 'reject', { version: run.version, message: 'Add a comment explaining the greeting' }, f.user);
  const corrected = await f.worker.tick(); assert.equal(corrected.status, 'merging'); assert.equal(corrected.number, initial.number); assert.notEqual(corrected.sha, initial.sha);
  assert.equal(f.current().submissions.length, 2); assert.equal(f.current().submissions[0].decision.accepted, false);
});

test('a PR closed without merging asks a question instead of creating another PR', async t => {
  const f = await fixture(t); f.prepare(); await f.worker.tick(); f.pr.state = 'closed'; f.pr.merged = false;
  assert.equal((await f.worker.tick()).status, 'waiting'); assert.equal(f.current().state, 'waiting'); assert.equal(f.modelCalls.length, 1);
  assert.match(f.current().exchanges.at(-1).question, /fermée sans fusion/);
});

test('a retry budget stops repeated model runs until a human answers', async t => {
  const f = await fixture(t, { model: async () => { throw new Error('Model unavailable'); } });
  const worker = createWorker({ ...f.config, maxAttempts: 1 }, f.dependencies);
  await worker.processTask(f.prepare()); assert.equal(f.current().state, 'waiting'); assert.equal(f.modelCalls.length, 1);
  assert.equal((await worker.processTask({ ...f.current(), state: 'ready' })).status, 'claimed_elsewhere'); assert.equal(f.modelCalls.length, 1);
});

test('delayed PR synchronization retries automatically without using the model failure budget', async t => {
  const f = await fixture(t, { publicationPending: true });
  const worker = createWorker({ ...f.config, maxAttempts: 1 }, f.dependencies);
  assert.equal((await worker.processTask(f.prepare())).status, 'interrupted');
  assert.equal(f.current().state, 'interrupted');
  assert.equal(f.current().exchanges.length, 0);
  assert.equal((await f.state.get(f.current().id)).attempts, 0);
  assert.equal((await worker.processTask(f.current())).status, 'merging');
  assert.equal(f.pr.number, 1);
  assert.equal(f.current().submissions.at(-1).pullRequest.headSha, f.pr.head.sha);
});

test('the original agent recovers the old publication question without a human answer', async t => {
  const f = await fixture(t); f.prepare(); await f.worker.tick();
  const claimed = await f.site.action(f.current(), 'revise');
  await f.site.action(claimed, 'question', { message: 'La PR ne pointe pas sur le commit testé.' });
  const job = await f.state.get(claimed.id); job.attempts = 3; job.phase = 'waiting'; await f.state.put(job);
  const otherSite = createSiteClient({ ...f.config, token: 'unrecognized-agent-token' });
  await assert.rejects(otherSite.action(f.current(), 'revise'), error => error.status === 401);
  assert.equal((await f.worker.tick()).status, 'merging');
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.current().exchanges.at(-1).answer, null);
  assert.equal(f.current().submissions.length, 2);
  assert.equal(f.current().submissions.at(-1).pullRequest.number, 1);
  assert.equal((await f.state.get(claimed.id)).attempts, 0);
});

test('genuine clarification questions cannot be bypassed by automatic PR recovery', async t => {
  const f = await fixture(t); f.prepare(); await f.worker.tick();
  const claimed = await f.site.action(f.current(), 'revise');
  await f.site.action(claimed, 'question', { message: 'Quel fichier faut-il modifier ?' });
  await assert.rejects(f.site.action(f.current(), 'revise'), error => error.status === 409);
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(f.current().state, 'waiting');
  assert.equal(f.modelCalls.length, 1);
});

test('GitHub PR synchronization ignores stale listings and waits for the tested head', async () => {
  const branch = 'planifikateur/task', testedSha = 'a'.repeat(40), waits = [];
  const stale = { number: 9, state: 'open', draft: false, head: { sha: 'b'.repeat(40), ref: branch, repo: { full_name: repository } }, base: { ref: 'main' } };
  let reads = 0;
  const client = createGithubClient('private-token', async url => {
    if (new URL(url).pathname.endsWith('/pulls')) return Response.json([stale]);
    reads++;
    return Response.json(reads < 3 ? stale : { ...stale, head: { ...stale.head, sha: testedSha } });
  }, async ms => { waits.push(ms); });
  const pr = await client.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha);
  assert.equal(pr.head.sha, testedSha);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('PR synchronization never approves a different commit or an unrelated branch', async () => {
  const branch = 'planifikateur/task', testedSha = 'a'.repeat(40);
  const stale = { number: 9, state: 'open', draft: false, head: { sha: 'b'.repeat(40), ref: branch, repo: { full_name: repository } }, base: { ref: 'main' } };
  let reads = 0;
  const client = createGithubClient('private-token', async url => {
    if (new URL(url).pathname.endsWith('/pulls')) return Response.json([stale]);
    reads++; return Response.json(stale);
  }, async () => {});
  await assert.rejects(client.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha), PublicationPendingError);
  assert.equal(reads, 6);
  const foreign = createGithubClient('private-token', async url => Response.json(new URL(url).pathname.endsWith('/pulls') ? [stale] : { ...stale, head: { ...stale.head, ref: 'other-branch', sha: testedSha } }));
  await assert.rejects(foreign.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha), /ne correspond pas/);
});

test('worker configuration rejects external HTTP, credential URLs, invalid scopes and shell strings', () => {
  const env = { PLANIFIKATEUR_URL: 'https://site.example', PLANIFIKATEUR_AGENT_TOKEN: 'site-key', PLANIFIKATEUR_GITHUB_TOKEN: 'git-key', PLANIFIKATEUR_WORKER_PROJECTS: 'project', PLANIFIKATEUR_WORKER_REPOSITORIES: 'owner/repo' };
  for (const changes of [{ PLANIFIKATEUR_URL: 'http://external.example' }, { PLANIFIKATEUR_URL: 'https://user:password@site.example' }, { PLANIFIKATEUR_WORKER_PROJECTS: '../project' }, { PLANIFIKATEUR_WORKER_REPOSITORIES: 'https://evil.example' }, { PLANIFIKATEUR_WORKER_TEST_COMMANDS: '["npm test"]' }, { PLANIFIKATEUR_WORKER_HEARTBEAT_MS: '300000' }]) assert.throws(() => readWorkerConfig({ ...env, ...changes }));
  assert.equal(commandEnvironment({ PATH: '/bin', GH_TOKEN: 'secret', PLANIFIKATEUR_AGENT_TOKEN: 'secret', OPENAI_API_KEY: 'secret' }).GH_TOKEN, undefined);
});

test('SDK adapter selects a sandbox, resumes a thread, validates JSON and never inherits GitHub/site secrets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-sdk-')); t.after(() => rm(root, { recursive: true, force: true }));
  let settings, threadOptions, threadId, passedSchema;
  class Codex {
    constructor(options) { settings = options; }
    resumeThread(id, options) { threadId = id; threadOptions = options; return { runStreamed: async (prompt, turn) => {
      passedSchema = turn.outputSchema; assert.match(prompt, /Description : French greeting/);
      return { events: (async function* () { yield { type: 'thread.started', thread_id: id }; yield { type: 'item.completed', item: { type: 'agent_message', text: '{"status":"result","summary":"Translated","question":""}' } }; yield { type: 'turn.completed' }; })() };
    } }; }
  }
  const run = { cardSnapshot: { title: 'Greeting' }, objective: 'French greeting', exchanges: [], submissions: [], updates: [] };
  const runner = createCodexRunner({ apiKey: 'model-key', codexHome: join(root, 'codex') }, { Codex });
  const result = await runner.run({ run, job: { threadId: 'previous-thread' }, cwd: root, signal: new AbortController().signal, onThread: async id => assert.equal(id, 'previous-thread') });
  assert.equal(result.status, 'result'); assert.equal(threadId, 'previous-thread'); assert.equal(threadOptions.sandboxMode, 'workspace-write'); assert.equal(threadOptions.approvalPolicy, 'never');
  assert.equal(settings.env.GH_TOKEN, undefined); assert.equal(settings.env.PLANIFIKATEUR_AGENT_TOKEN, undefined); assert.equal(settings.env.PLANIFIKATEUR_WORKER, '1');
  assert.equal(passedSchema.additionalProperties, false); assert.ok(!taskPrompt(run).includes('Critères d’acceptation'));
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
