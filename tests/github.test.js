import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';
import { mergeAgentPullRequest, requiredJobs } from '../scripts/merge-agent-pr.mjs';
import { createGithubClient } from '../worker/clients.mjs';

const repository = 'flo91360/PlaniFiKateur',
  sha = 'a'.repeat(40),
  nextSha = 'b'.repeat(40),
  secret = 'webhook-test-secret';
async function fixture(t, configured = true) {
  const store = createStore(':memory:'),
    user = seedAccount(store),
    project = store.read().projects[0],
    card = project.cards[0];
  store.workflows.configureGithub(project.id, repository, user);
  const { agent, token } = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, user);
  const server = createAppServer({
    store,
    config: { readToken: 'read-only', githubWebhookSecret: configured ? secret : '' },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const login = await loginRequest(base.replace('/api/v1', ''));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const post = (path, data, headers = { Cookie: cookie }) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  const webhook = (event, data, signingSecret = secret) => {
    const raw = JSON.stringify(data);
    return fetch(base + '/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signingSecret).update(raw).digest('hex'),
      },
      body: raw,
    });
  };
  const submit = (run, headSha = sha) =>
    store.workflows.agentAction(
      project.id,
      card.id,
      run.id,
      'submit',
      {
        version: run.version,
        leaseToken: run.leaseToken,
        summary: 'Menu modifié',
        checks: 'Tests lancés sur GitHub',
        links: [],
        pullRequest: { url: `https://github.com/${repository}/pull/7`, headSha },
      },
      agent,
    );
  const prepare = () => {
    const r = store.workflows.prepare(
      project.id,
      card.id,
      { objective: 'Menu', criteria: 'Tests réussis', delivery: 'github' },
      user,
    );
    return store.workflows.agentAction(project.id, card.id, r.id, 'claim', { version: r.version }, agent);
  };
  const merged = (headSha = sha) => ({
    action: 'closed',
    repository: { full_name: repository },
    pull_request: {
      number: 7,
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: 'c'.repeat(40),
      head: { sha: headSha, repo: { full_name: repository } },
      base: { ref: 'main' },
    },
  });
  const check = conclusion => ({
    action: 'completed',
    repository: { full_name: repository },
    workflow_run: {
      id: 42,
      run_attempt: 1,
      name: 'Tests',
      event: 'pull_request',
      status: 'completed',
      conclusion,
      head_sha: sha,
      head_repository: { full_name: repository },
      html_url: 'https://github.com/test',
    },
  });
  return { store, user, project, card, agent, token, base, cookie, post, webhook, submit, prepare, merged, check };
}

test('only a signed GitHub merge closes a code task, with idempotency and history', async t => {
  const f = await fixture(t),
    run = f.submit(f.prepare());
  assert.equal(run.state, 'merging');
  assert.throws(
    () => f.store.workflows.human(f.project.id, f.card.id, run.id, 'accept', { version: run.version }, f.user),
    { code: 'invalid_transition' },
  );
  assert.equal((await f.webhook('pull_request', f.merged(), 'wrong')).status, 401);
  const check = await f.webhook('workflow_run', f.check('success'));
  assert.equal(check.status, 200);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'merging');
  const eligibility = await fetch(f.base + `/github/merge-eligibility?repository=${repository}&number=7&sha=${sha}`, {
    headers: { Authorization: `Bearer ${f.token}` },
  });
  assert.equal((await eligibility.json()).data.eligible, true);
  assert.equal((await f.webhook('pull_request', f.merged(nextSha))).status, 200);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'merging');
  const payload = f.merged();
  payload.pull_request.merged_at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  assert.equal((await f.webhook('pull_request', payload)).status, 200);
  const done = f.store.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(done.state, 'done');
  assert.equal(done.submissions[0].decision.automatic, true);
  assert.equal(f.store.read().projects[0].cards[0].status, 'done');
  const revision = f.store.getRevision();
  await f.webhook('pull_request', payload);
  assert.equal(f.store.getRevision(), revision);
  assert.equal(f.store.activity({ cardId: f.card.id }).filter(e => e.action === 'work.merged').length, 1);
});

test('superseded CI does not requeue the agent and later successful tests allow automatic merge', async t => {
  const f = await fixture(t),
    run = f.submit(f.prepare());
  await f.webhook('workflow_run', f.check('cancelled'));
  let current = f.store.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(current.state, 'merging');
  assert.equal(f.store.workflows.queue(f.project.id, f.agent, { autoPrepare: false }).length, 0);
  assert.equal(f.store.read().projects[0].cards[0].status, 'review');
  assert.equal(current.submissions.length, 1);
  assert.ok(!current.updates.some(update => /annulée/.test(update.text)));
  const success = f.check('success');
  success.workflow_run.id++;
  await f.webhook('workflow_run', success);
  current = f.store.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(current.state, 'merging');
  assert.equal(current.githubChecks.conclusion, 'success');
  const revision = f.store.getRevision();
  await f.webhook('workflow_run', f.check('cancelled'));
  assert.equal(f.store.getRevision(), revision);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, true);
  await f.webhook('pull_request', f.merged());
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'done');
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].id, run.id);
});

test('failed checks requeue work; obsolete commits, cancelled work and unmerged closure cannot finish it', async t => {
  const f = await fixture(t);
  f.submit(f.prepare());
  let run;
  const closed = f.merged();
  closed.pull_request.merged = false;
  await f.webhook('pull_request', closed);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'merging');
  await f.webhook('workflow_run', f.check('failure'));
  run = f.store.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(run.state, 'ready');
  run = f.store.workflows.agentAction(f.project.id, f.card.id, run.id, 'claim', { version: run.version }, f.agent);
  run = f.submit(run, nextSha);
  await f.webhook('pull_request', f.merged());
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'merging');
  assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, false);
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    run.id,
    'cancel',
    { version: run.version, message: 'Demande retirée' },
    f.user,
  );
  assert.equal(f.store.workflows.mergeEligible(repository, 7, nextSha, f.agent).eligible, false);
  await f.webhook('pull_request', f.merged(nextSha));
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'cancelled');
});

test('PR identity and commit are mandatory and GitHub delivery requires configuration', async t => {
  const f = await fixture(t, false),
    run = f.prepare();
  const path = `/projects/${f.project.id}/cards/${f.card.id}/work`;
  assert.equal((await f.post(path, { objective: 'A', criteria: 'B', delivery: 'github' })).status, 503);
  assert.equal((await f.webhook('pull_request', f.merged())).status, 503);
  const data = {
    version: run.version,
    leaseToken: run.leaseToken,
    summary: 'Result',
    checks: 'Tests',
    links: [],
    pullRequest: { url: 'https://github.com/wrong/repo/pull/7', headSha: sha },
  };
  assert.throws(() => f.store.workflows.agentAction(f.project.id, f.card.id, run.id, 'submit', data, f.agent), {
    code: 'invalid_pull_request',
  });
  data.pullRequest.url = `https://github.com/${repository}/pull/7`;
  delete data.pullRequest.headSha;
  assert.throws(() => f.store.workflows.agentAction(f.project.id, f.card.id, run.id, 'submit', data, f.agent), {
    code: 'invalid_pull_request',
  });
});

function mergeFixture(change = {}) {
  const run = {
    workflow_id: 2,
    id: 12,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_repository: { full_name: repository },
    head_sha: sha,
    head_branch: 'agent/menu',
    run_attempt: 1,
    ...change.run,
  };
  const pr = {
    number: 7,
    state: 'open',
    draft: false,
    head: { sha, repo: { full_name: repository } },
    base: { ref: 'main' },
    labels: [{ name: 'planifikateur-agent' }],
    ...change.pr,
  };
  const jobs =
    change.jobs || requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 }));
  const calls = [];
  const request = async (path, method = 'GET', data) => {
    calls.push({ path, method, data });
    if (method === 'DELETE') return null;
    if (path.includes('/merge')) return { merged: true, sha: 'c'.repeat(40) };
    if (path.includes('/jobs?')) return { jobs, total_count: jobs.length };
    if (path.endsWith('/ci.yml')) return { id: 2 };
    if (path.includes('/actions/runs/')) return run;
    if (path.includes('/pulls?')) return [pr];
    if (path.endsWith('/pulls/7')) return pr;
    if (path.endsWith('/branches/main')) return { commit: { sha: 'd'.repeat(40) } };
    if (path.includes('/compare/')) return { status: change.comparison || 'ahead' };
    throw new Error(path);
  };
  return { run, pr, calls, request };
}
test('automatic merger checks both suites and merges exactly the tested head commit', async () => {
  const f = mergeFixture();
  const result = await mergeAgentPullRequest({ repository, runId: 12, request: f.request, eligible: async () => true });
  assert.equal(result.merged, true);
  assert.deepEqual(f.calls.find(c => c.method === 'PUT').data, { sha, merge_method: 'squash' });
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).path, `/repos/${repository}/git/refs/heads/agent/menu`);
});
test('a branch that cannot be deleted after merging does not turn the merge into a failure', async () => {
  const f = mergeFixture();
  const logs = [];
  const request = async (path, method, data) => {
    if (method === 'DELETE') throw Object.assign(new Error('refusé'), { status: 403 });
    return f.request(path, method, data);
  };
  const result = await mergeAgentPullRequest({
    repository,
    runId: 12,
    request,
    eligible: async () => true,
    log: line => logs.push(line),
  });
  assert.equal(result.merged, true);
  assert.match(logs.at(-1), /conservée/);
});
test('the automatic merger never deletes the target branch itself', async () => {
  const f = mergeFixture({ run: { head_branch: 'main' } });
  f.pr.base.ref = 'main';
  await mergeAgentPullRequest({ repository, runId: 12, request: f.request, eligible: async () => true });
  assert.equal(
    f.calls.some(c => c.method === 'DELETE'),
    false,
  );
});
test('the GitHub client creates a missing delivery label once and retries attaching it to the PR', async () => {
  const calls = [];
  let attached = 0;
  const client = createGithubClient('private', async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    if (new URL(url).pathname.endsWith('/issues/1/labels') && attached++ === 0)
      return Response.json({}, { status: 422 });
    return Response.json({});
  });
  await client.label(repository, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.name, 'planifikateur-agent');
  assert.deepEqual(calls[2].body.labels, ['planifikateur-agent']);
});
test('repository names differing only in case still identify the same tested PR', async () => {
  const f = mergeFixture();
  const result = await mergeAgentPullRequest({
    repository: repository.toLowerCase(),
    runId: 12,
    request: f.request,
    eligible: async () => true,
  });
  assert.equal(result.merged, true);
});

test('worker merger never uses an older green run when newer tests are pending, failed or cancelled', async () => {
  for (const conclusion of [null, 'failure', 'cancelled']) {
    const f = mergeFixture();
    f.pr.head.ref = f.run.head_branch;
    const client = createGithubClient('test-token', async (url, options) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/ci.yml/runs'))
        return Response.json({
          workflow_runs: [f.run, { ...f.run, id: 13, status: conclusion ? 'completed' : 'in_progress', conclusion }],
        });
      return Response.json(await f.request(path, options.method, options.body && JSON.parse(options.body)));
    });
    let eligibilityCalls = 0;
    const result = await client.mergeWhenReady(repository, f.pr, async () => {
      eligibilityCalls++;
      return true;
    });
    assert.equal(result.merged, false);
    assert.equal(eligibilityCalls, 0);
    assert.equal(
      f.calls.some(call => call.method === 'PUT'),
      false,
    );
  }
});

test('worker merger rechecks for newly started CI before checking eligibility and merging', async () => {
  const f = mergeFixture();
  f.pr.head.ref = f.run.head_branch;
  let listings = 0,
    eligibilityCalls = 0;
  const client = createGithubClient('test-token', async (url, options) => {
    const parsed = new URL(url),
      path = parsed.pathname;
    if (path.endsWith('/ci.yml/runs'))
      return Response.json({
        workflow_runs: ++listings === 1 ? [f.run] : [{ ...f.run, id: 13, status: 'queued', conclusion: null }],
      });
    return Response.json(
      await f.request(path + parsed.search, options.method, options.body && JSON.parse(options.body)),
    );
  });
  const result = await client.mergeWhenReady(repository, f.pr, async () => {
    eligibilityCalls++;
    return true;
  });
  assert.equal(result.merged, false);
  assert.equal(eligibilityCalls, 0);
  assert.equal(
    f.calls.some(call => call.method === 'PUT'),
    false,
  );
});
test('automatic merger rejects absent, skipped, failed, unfinished or ambiguous required suites', async () => {
  for (const jobs of [
    [],
    [{ name: 'Tests serveur', status: 'completed', conclusion: 'success', run_attempt: 1 }],
    ...['skipped', 'failure', 'cancelled', null].map(conclusion =>
      requiredJobs.map(name => ({ name, status: 'completed', conclusion, run_attempt: 1 })),
    ),
    requiredJobs.map(name => ({ name, status: 'in_progress', conclusion: 'success', run_attempt: 1 })),
    [
      ...requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success', run_attempt: 1 })),
      { name: 'Tests serveur', status: 'completed', conclusion: 'success', run_attempt: 1 },
    ],
  ]) {
    const f = mergeFixture({ jobs });
    assert.equal(
      (await mergeAgentPullRequest({ repository, runId: 12, request: f.request, eligible: async () => true })).merged,
      false,
    );
    assert.equal(
      f.calls.some(c => c.method === 'PUT'),
      false,
    );
  }
});
test('automatic merger rejects forks, other workflows, stale heads, drafts, missing labels and outdated bases', async () => {
  for (const change of [
    { run: { workflow_id: 99 } },
    { run: { head_repository: { full_name: 'fork/repo' } } },
    { run: { run_attempt: 2 } },
    { pr: { head: { sha: nextSha, repo: { full_name: repository } } } },
    { pr: { draft: true } },
    { pr: { labels: [] } },
    { comparison: 'diverged' },
  ]) {
    const f = mergeFixture(change);
    assert.equal(
      (await mergeAgentPullRequest({ repository, runId: 12, request: f.request, eligible: async () => true })).merged,
      false,
    );
    assert.equal(
      f.calls.some(c => c.method === 'PUT'),
      false,
    );
  }
  const f = mergeFixture();
  assert.equal(
    (await mergeAgentPullRequest({ repository, runId: 12, request: f.request, eligible: async () => false })).reason,
    'task_not_eligible',
  );
});

test('revise rotates reservations and blocks merging while the agent updates the PR', async t => {
  const f = await fixture(t),
    submitted = f.submit(f.prepare());
  const response = await f.post(
    `/projects/${f.project.id}/cards/${f.card.id}/work/${submitted.id}/revise`,
    { version: submitted.version },
    { Authorization: `Bearer ${f.token}` },
  );
  assert.equal(response.status, 200);
  const revised = (await response.json()).data;
  assert.equal(revised.state, 'running');
  assert.match(revised.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, false);
  await f.webhook('pull_request', f.merged());
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'running');
  const newSubmission = f.submit(revised, nextSha);
  assert.equal(newSubmission.state, 'merging');
  assert.equal(f.store.workflows.mergeEligible(repository, 7, nextSha, f.agent).eligible, true);
});

test('new tasks inherit their project repository and always use automatic GitHub delivery', async t => {
  const f = await fixture(t),
    path = `/projects/${f.project.id}/cards/${f.card.id}/work`;
  const invalid = await f.post(path, { delivery: 'manual' });
  assert.equal(invalid.status, 400);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
  const response = await f.post(path, {});
  assert.equal(response.status, 201);
  const run = (await response.json()).data;
  assert.equal(run.delivery, 'github');
  assert.equal(run.repository, repository);
  const snapshot = f.store.read(),
    other = structuredClone(f.project);
  other.id = 'other-project';
  other.lists.forEach((list, i) => {
    list.id = `other-list-${i}`;
  });
  other.cards.forEach((card, i) => {
    card.id = `other-card-${i}`;
    card.listId = other.lists[0].id;
    card.comments = [];
    card.checklist = [];
  });
  snapshot.projects.push(other);
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.throws(() => f.store.workflows.prepare(other.id, other.cards[0].id, {}, f.user), {
    code: 'github_not_configured',
  });
  f.store.workflows.configureGithub(other.id, 'flo91360/Klaviflo', f.user);
  const otherRun = f.store.workflows.prepare(other.id, other.cards[0].id, {}, f.user);
  assert.equal(otherRun.repository, 'flo91360/Klaviflo');
  assert.equal(otherRun.delivery, 'github');
  f.store.workflows.configureGithub(f.project.id, 'flo91360/NewRepository', f.user);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].repository, repository);
});

test('preparation without a delivery choice still requires the server webhook secret', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.post(`/projects/${f.project.id}/cards/${f.card.id}/work`, {})).status, 503);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
});

test('automatic discovery does not create executions while the webhook secret is missing', async t => {
  const f = await fixture(t, false),
    snapshot = f.store.read();
  snapshot.projects[0].cards[0].status = 'ready';
  f.store.write(snapshot.projects, snapshot.revision, f.user);
  const response = await fetch(`${f.base}/projects/${f.project.id}/work`, {
    headers: { Authorization: `Bearer ${f.token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, []);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
});

test('a project that requires approval merges only the PR commit a manager approved', async t => {
  const f = await fixture(t);
  const path = run => `/projects/${f.project.id}/cards/${f.card.id}/work/${run.id}`;
  assert.equal(
    (await f.post(`/projects/${f.project.id}/approval`, { required: 'oui' }, { Cookie: f.cookie })).status,
    405,
    'Le réglage se modifie par PUT.',
  );
  f.store.configureMergeApproval(f.project.id, { required: true }, f.user);
  const submitted = f.submit(f.prepare());
  assert.deepEqual(f.store.workflows.mergeEligible(repository, 7, sha, f.agent), {
    eligible: false,
    reason: 'approval_required',
  });
  let [listed] = f.store.workflows.list(f.project.id, f.card.id);
  assert.equal(listed.approvalRequired, true);
  assert.ok(f.store.workflows.attention().some(item => item.executionId === submitted.id && item.state === 'merging'));
  const approved = await f.post(`${path(submitted)}/approve`, { version: listed.version });
  assert.equal(approved.status, 200);
  const run = (await approved.json()).data;
  assert.equal(run.state, 'merging');
  assert.equal(run.approval.headSha, sha);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, true);
  assert.equal(
    f.store.workflows.attention().some(item => item.executionId === submitted.id),
    false,
  );
  assert.ok(f.store.activity({ cardId: f.card.id }).some(event => event.action === 'work.approve'));
  // Une correction de l’agent change le commit : il faut une nouvelle approbation.
  const revised = f.store.workflows.agentAction(
    f.project.id,
    f.card.id,
    run.id,
    'revise',
    { version: run.version },
    f.agent,
  );
  f.submit(revised, nextSha);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, nextSha, f.agent).eligible, false);
  // Sans exigence, la fusion automatique reprend.
  f.store.configureMergeApproval(f.project.id, { required: false }, f.user);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, nextSha, f.agent).eligible, true);
  [listed] = f.store.workflows.list(f.project.id, f.card.id);
  assert.equal(listed.approvalRequired, false);
});

test('three consecutive CI failures ask a person, and checks without a verdict never go back to the model', async t => {
  const f = await fixture(t);
  f.submit(f.prepare());
  let run;
  const failing = id => ({ ...f.check('failure'), workflow_run: { ...f.check('failure').workflow_run, id } });
  // Délai dépassé : rien à corriger dans le code, la tâche attend une relance des contrôles.
  await f.webhook('workflow_run', {
    ...f.check('timed_out'),
    workflow_run: { ...f.check('timed_out').workflow_run, id: 40 },
  });
  run = f.store.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(run.state, 'merging');
  assert.match(run.updates.at(-1).text, /sans verdict \(timed_out\)/);
  for (let cycle = 1; cycle <= 3; cycle++) {
    await f.webhook('workflow_run', failing(100 + cycle));
    run = f.store.workflows.list(f.project.id, f.card.id)[0];
    if (cycle < 3) {
      assert.equal(run.state, 'ready');
      run = f.store.workflows.agentAction(f.project.id, f.card.id, run.id, 'claim', { version: run.version }, f.agent);
      run = f.submit(run);
    }
  }
  assert.equal(run.state, 'waiting');
  assert.match(run.exchanges.at(-1).question, /échoué 3 fois de suite/);
  const card = f.store.read().projects[0].cards.find(item => item.id === f.card.id);
  assert.equal(card.status, 'clarify');
  assert.ok(card.comments.some(comment => /échoué 3 fois de suite/.test(comment.text)));
  // La réponse d’une personne relance une correction avec un nouveau compteur.
  run = f.store.workflows.human(
    f.project.id,
    f.card.id,
    run.id,
    'answer',
    { version: run.version, message: 'Le test e2e dépend du fuseau horaire.' },
    f.user,
  );
  assert.equal(run.state, 'ready');
  assert.equal(run.ciFailures, 0);
});

test('the server catches up on lost webhooks by reading the pull request and its checks on GitHub', async t => {
  const { createGithubSync } = await import('../server/github-sync.js');
  const f = await fixture(t);
  f.submit(f.prepare());
  const requests = [];
  let pull = {
    number: 7,
    state: 'open',
    merged: false,
    head: { sha, repo: { full_name: repository } },
    base: { ref: 'main' },
  };
  let runs = [];
  const transport = async url => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path.endsWith('/pulls/7')) return Response.json(pull);
    if (path.endsWith('/ci.yml/runs')) return Response.json({ workflow_runs: runs });
    return new Response('', { status: 404 });
  };
  const errors = [];
  const sync = createGithubSync(f.store, { transport, quietMs: 0, start: false, onError: e => errors.push(e) });
  const state = () => f.store.workflows.list(f.project.id, f.card.id)[0].state;
  // Tests encore en cours : rien ne change.
  runs = [{ ...f.check('failure').workflow_run, status: 'in_progress', conclusion: null }];
  assert.equal((await sync.refresh()).checked, 1);
  assert.equal(state(), 'merging');
  // Webhook de réussite perdu, puis fusion perdue : le serveur les retrouve lui-même.
  runs = [{ ...f.check('success').workflow_run, path: '.github/workflows/ci.yml' }];
  await sync.refresh();
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].githubChecks.conclusion, 'success');
  pull = { ...f.merged().pull_request, state: 'closed' };
  await sync.refresh();
  assert.equal(state(), 'done');
  assert.ok(requests.every(path => path.startsWith(`/repos/${repository.toLowerCase()}/`)));
  // Plus rien en attente : aucune requête.
  requests.length = 0;
  assert.equal((await sync.refresh()).checked, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
});

test('an inaccessible pull request is reported once and does not stop the catch-up of the others', async t => {
  const { createGithubSync } = await import('../server/github-sync.js');
  const f = await fixture(t);
  f.submit(f.prepare());
  const errors = [];
  const sync = createGithubSync(f.store, {
    transport: async () => new Response('', { status: 404 }),
    quietMs: 0,
    start: false,
    onError: message => errors.push(message),
  });
  await sync.refresh();
  await sync.refresh();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /#7 impossible \(GitHub a répondu 404\.\)/);
  // Une exécution récente attend d’abord son webhook.
  const patient = createGithubSync(f.store, { transport: async () => assert.fail('trop tôt'), start: false });
  assert.equal((await patient.refresh()).checked, 0);
});

test('a local failure during the GitHub catch-up is reported instead of crashing the server', async () => {
  const { createGithubSync } = await import('../server/github-sync.js');
  const errors = [];
  const broken = {
    workflows: {
      mergingPullRequests() {
        throw new Error('base indisponible');
      },
    },
  };
  const sync = createGithubSync(broken, { start: false, onError: message => errors.push(message) });
  assert.deepEqual(await sync.refresh(), { checked: 0 });
  assert.match(errors[0], /vérification des PR GitHub impossible \(base indisponible\)/);
  // Le tour suivant peut reprendre : le verrou d’exécution a été libéré.
  await sync.refresh();
  assert.equal(errors.length, 2);
});

test('the worker reads failed job logs from the temporary link without sending its token there', async () => {
  const calls = [];
  const client = createGithubClient('worker-token', async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    const { pathname, hostname } = new URL(url);
    if (pathname.endsWith('/runs/42/jobs'))
      return Response.json({
        jobs: [
          { id: 1, name: 'Tests serveur', conclusion: 'success', steps: [] },
          {
            id: 2,
            name: 'Tests navigateur',
            conclusion: 'failure',
            steps: [
              { name: 'Installer', conclusion: 'success' },
              { name: 'Playwright', conclusion: 'failure' },
            ],
          },
        ],
      });
    if (pathname.endsWith('/jobs/2/logs'))
      return new Response(null, { status: 302, headers: { location: 'https://logs.example.test/job-2' } });
    if (hostname === 'logs.example.test') return new Response(`${'x'.repeat(7000)}\nError: menu introuvable`);
    return new Response('', { status: 404 });
  });
  const failed = await client.failedChecks(repository, 42);
  assert.deepEqual(
    failed.map(job => [job.name, job.steps]),
    [['Tests navigateur', ['Playwright']]],
  );
  assert.equal(failed[0].log.length, 6000);
  assert.match(failed[0].log, /menu introuvable$/);
  assert.equal(calls.find(call => call.url.startsWith('https://logs.example.test')).authorization, undefined);
});

test('a PR that changes its own merge controls waits for a manager to approve its exact commit', async t => {
  const f = await fixture(t),
    run = f.prepare();
  const submit = reviewRequired =>
    f.store.workflows.agentAction(
      f.project.id,
      f.card.id,
      run.id,
      'submit',
      {
        version: run.version,
        leaseToken: run.leaseToken,
        summary: 'Tests allégés',
        checks: 'Tests lancés',
        links: [],
        pullRequest: { url: `https://github.com/${repository}/pull/7`, headSha: sha },
        reviewRequired,
      },
      f.agent,
    );
  for (const invalid of ['.github', [''], [42], Array(51).fill('a')])
    assert.throws(
      () => submit(invalid),
      error => error.status === 400 && error.code === 'invalid_review',
    );
  const submitted = submit(['.github/workflows/ci.yml', 'package.json (scripts)']);
  assert.deepEqual(submitted.submissions.at(-1).reviewRequired, ['.github/workflows/ci.yml', 'package.json (scripts)']);
  assert.deepEqual(f.store.workflows.mergeEligible(repository, 7, sha, f.agent), {
    eligible: false,
    reason: 'approval_required',
  });
  const [listed] = f.store.workflows.list(f.project.id, f.card.id);
  assert.equal(listed.approvalRequired, true, 'Le projet n’exige pas d’approbation : la PR, si.');
  assert.equal(f.store.workflows.projectStatus(f.project.id)[f.card.id].awaitingApproval, true);
  assert.ok(f.store.workflows.attention().some(item => item.executionId === run.id));
  f.store.workflows.human(f.project.id, f.card.id, run.id, 'approve', { version: listed.version }, f.user);
  assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, true);
});
