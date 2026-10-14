import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest, testPasswordHash } from './helpers/accounts.mjs';
import { defaultExecutionProfile, validateExecutionProfile } from '../worker/execution-profile.mjs';
import { readWorkerConfig } from '../worker/config.mjs';
import { mergeAgentPullRequest } from '../worker/merge.mjs';
import { createSiteClient } from '../worker/clients.mjs';
import { checkWorkflowTrigger, runtimeEnvironment } from '../worker/runtime.mjs';

test('project discovery is scoped, read-only and refreshes authorizations without changing worker environment', async t => {
  const store = createStore(':memory:'),
    user = seedAccount(store),
    [first, second] = store.read().projects;
  store.workflows.configureGithub(first.id, 'flo91360/DefilOrdi', user);
  store.workflows.configureGithub(second.id, 'flo91360/FunKart', user);
  const { agent, token } = store.workflows.configureAgent({ name: 'Worker', projectIds: [first.id] }, user);
  const server = createAppServer({ store, config: { githubWebhookSecret: 'test' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = createSiteClient({ origin, token });
  let projects = await site.projects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].repository, 'flo91360/DefilOrdi');
  assert.equal(projects[0].executionProfile.nodeMajor, 22);
  assert.deepEqual(store.workflows.list(first.id, first.cards[0].id), []);
  store.workflows.configureAgent({ name: agent.name, projectIds: [first.id, second.id] }, user, agent.id);
  projects = await site.projects();
  assert.equal(projects.length, 2);
  assert.equal(projects[1].executionProfile.godotVersion, '4.4.1');
  await site.diagnostic(second.id, {
    state: 'blocked',
    checks: [{ name: 'Godot', state: 'blocked', message: 'Outil requis.' }],
  });
  assert.equal(store.workflows.workerStatus(second.id).state, 'blocked');
  store.workflows.configureAgent({ name: agent.name, projectIds: [first.id] }, user, agent.id);
  await assert.rejects(site.diagnostic(second.id, { state: 'ready', checks: [] }), error => error.status === 403);
  assert.equal(store.workflows.workerStatus(second.id), null);
  assert.equal((await fetch(origin + '/api/v1/agent/projects')).status, 401);
  const login = await loginRequest(origin),
    cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin + '/api/v1/agent/projects', { headers: { Cookie: cookie } })).status, 401);
  const invited = store.inviteUser({ name: 'Bob', email: 'bob@profiles.test' }, user);
  const member = store.acceptInvitation(invited.token, 'Bob', testPasswordHash);
  const memberCookie = `planifikateur_session=${store.createSession(member.id)}`;
  const endpoint = origin + `/api/v1/projects/${first.id}/execution`;
  assert.equal((await fetch(endpoint, { headers: { Cookie: memberCookie } })).status, 200);
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'PUT',
        headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: 'funkart' }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: 'funkart' }),
      })
    ).status,
    401,
  );
  assert.equal(store.workflows.executionProfile(first.id).preset, 'defilordi');
  const adminPut = data =>
    fetch(endpoint, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  const injected = await adminPut({ preset: 'funkart', installCommands: [['sh', '-c', 'curl https://exemple.test']] });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error.code, 'invalid_execution_profile');
  assert.equal(store.workflows.executionProfile(first.id).preset, 'defilordi');
  const saved = await adminPut({ preset: 'funkart', branch: 'main' });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data, validateExecutionProfile({ preset: 'funkart', branch: 'main' }));
});

test('project profiles persist, are frozen at preparation, protect old workers and route only their workflow notifications', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'planifikateur-profiles-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = join(folder, 'site.sqlite');
  let store = createStore(filename),
    user = seedAccount(store);
  const project = store.read().projects[0],
    card = project.cards[0];
  store.workflows.configureGithub(project.id, 'flo91360/FunKart', user);
  store.workflows.configureExecution(project.id, { preset: 'funkart' }, user);
  const { agent } = store.workflows.configureAgent({ name: 'Worker', projectIds: [project.id] }, user);
  let run = store.workflows.prepare(project.id, card.id, {}, user);
  assert.throws(
    () => store.workflows.agentAction(project.id, card.id, run.id, 'claim', { version: run.version }, agent),
    { code: 'worker_update_required' },
  );
  run = store.workflows.agentAction(
    project.id,
    card.id,
    run.id,
    'claim',
    { version: run.version, executionProfilesSupported: true },
    agent,
  );
  store.workflows.configureExecution(project.id, { preset: 'defilordi' }, user);
  run = store.workflows.agentAction(
    project.id,
    card.id,
    run.id,
    'submit',
    {
      version: run.version,
      leaseToken: run.leaseToken,
      summary: 'Code prêt',
      checks: 'Tests réussis',
      links: [],
      pullRequest: { url: 'https://github.com/flo91360/FunKart/pull/1', headSha: 'a'.repeat(40) },
    },
    agent,
  );
  const event = {
    action: 'completed',
    repository: { full_name: 'flo91360/FunKart' },
    workflow_run: {
      id: 10,
      run_attempt: 1,
      name: 'Tests',
      path: '.github/workflows/ci.yml',
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'a'.repeat(40),
      head_repository: { full_name: 'flo91360/FunKart' },
    },
  };
  assert.equal(store.workflows.githubChecks(event).updated, false);
  event.workflow_run.name = 'Construire le jeu';
  event.workflow_run.path = '.github/workflows/other.yml';
  assert.equal(store.workflows.githubChecks(event).updated, false);
  event.workflow_run.path = '.github/workflows/build.yml';
  assert.equal(store.workflows.githubChecks(event).updated, true);
  assert.equal(store.workflows.list(project.id, card.id)[0].state, 'ready');
  store.close();
  store = createStore(filename);
  t.after(() => store.close());
  assert.equal(store.workflows.executionProfile(project.id).preset, 'defilordi');
  assert.equal(store.workflows.list(project.id, card.id)[0].executionProfile.preset, 'funkart');
});

test('the merger requires each project workflow and jobs and never accepts an unrelated green suite', async () => {
  for (const preset of ['defilordi', 'funkart']) {
    const profile = validateExecutionProfile({ preset }),
      repo = `owner/${preset}`,
      sha = 'a'.repeat(40),
      calls = [];
    const run = {
      workflow_id: 2,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      head_repository: { full_name: repo },
      head_sha: sha,
      head_branch: 'planifikateur/task',
      run_attempt: 1,
    };
    const pr = {
      number: 1,
      state: 'open',
      draft: false,
      head: { sha, repo: { full_name: repo } },
      base: { ref: 'main' },
      labels: [{ name: 'planifikateur-agent' }],
    };
    let jobs = profile.workflow.jobs.map(name => ({
      name,
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
    }));
    const request = async (path, method) => {
      calls.push({ path, method });
      if (path.endsWith(`/workflows/${profile.workflow.file}`)) return { id: 2 };
      if (path.includes('/jobs?')) return { jobs, total_count: jobs.length };
      if (path.includes('/actions/runs/')) return run;
      if (path.includes('/pulls?')) return [pr];
      if (path.endsWith('/pulls/1')) return pr;
      if (path.endsWith('/branches/main')) return { commit: { sha: 'b'.repeat(40) } };
      if (path.includes('/compare/')) return { status: 'ahead' };
      if (path.endsWith('/merge')) return { merged: true, sha };
      throw new Error(path);
    };
    assert.equal(
      (
        await mergeAgentPullRequest({
          repository: repo,
          runId: 1,
          executionProfile: profile,
          request,
          eligible: async () => true,
        })
      ).merged,
      true,
    );
    calls.length = 0;
    jobs = [{ name: 'Tests serveur', status: 'completed', conclusion: 'success', run_attempt: 1 }];
    assert.equal(
      (
        await mergeAgentPullRequest({
          repository: repo,
          runId: 1,
          executionProfile: profile,
          request,
          eligible: async () => true,
        })
      ).merged,
      false,
    );
    assert.equal(
      calls.some(call => call.method === 'PUT'),
      false,
    );
  }
});

test('automatic discovery needs only connection credentials and profiles reject missing checks, unsafe refs and shell command strings', () => {
  const config = readWorkerConfig({
    PLANIFIKATEUR_URL: 'https://site.example',
    PLANIFIKATEUR_AGENT_TOKEN: 'agent',
    PLANIFIKATEUR_GITHUB_TOKEN: 'github',
  });
  assert.equal(config.discovery, 'auto');
  assert.deepEqual(config.projectIds, []);
  for (const data of [
    { preset: 'unknown' },
    { preset: 'funkart', branch: '../main' },
    { preset: 'defilordi', testCommands: ['npm test'] },
    { preset: 'funkart', workflow: { file: '../ci.yml', name: 'Tests', jobs: ['build'] } },
    { preset: 'defilordi', workflow: { file: 'ci.yml', name: 'Tests', jobs: [] } },
  ])
    assert.throws(() => validateExecutionProfile(data));
  assert.equal(defaultExecutionProfile('flo91360/DefilOrdi').preset, 'defilordi');
});

test('project diagnostics reject branch and path filters that would leave an agent PR without required CI', () => {
  assert.doesNotThrow(() => checkWorkflowTrigger('on: [push, pull_request]', 'main'));
  assert.doesNotThrow(() =>
    checkWorkflowTrigger('on:\n  pull_request:\n    branches: ["release/**", "!release/old"]', 'release/current'),
  );
  assert.throws(() => checkWorkflowTrigger('on:\n  pull_request:\n    branches: [main]', 'master'), /branche cible/);
  assert.throws(
    () => checkWorkflowTrigger('on:\n  pull_request:\n    branches: ["release/**", "!release/old"]', 'release/old'),
    /branche cible/,
  );
  assert.throws(() => checkWorkflowTrigger('on:\n  push:\n', 'main'), /pull requests/);
  assert.throws(() => checkWorkflowTrigger('on:\n  pull_request:\n    paths: ["src/**"]', 'main'), /filtre de chemins/);
});

test('preset environments reach the profile commands without changing the validated profile', () => {
  const config = { node22Bin: '/opt/node22/bin' };
  const defilordi = validateExecutionProfile({ preset: 'defilordi' });
  assert.equal(runtimeEnvironment(defilordi, config).ELECTRON_SKIP_BINARY_DOWNLOAD, '1');
  assert.ok(runtimeEnvironment(defilordi, config).PATH.startsWith('/opt/node22/bin'));
  assert.equal(
    runtimeEnvironment(validateExecutionProfile({ preset: 'planifikateur' }), config).ELECTRON_SKIP_BINARY_DOWNLOAD,
    undefined,
  );
  assert.equal('environment' in defilordi, false);
});
