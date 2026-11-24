import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  writeFile,
  join,
  delay,
  createWorker,
  ApiError,
  PublicationPendingError,
  createSiteClient,
  createGithubClient,
  connectionDiagnostic,
  repository,
  fixture,
  answer,
  exists,
} from './helpers/worker-fixture.mjs';

// Worker : reprises (conflits, dépôt, accès, réservation, synchronisation des PR) et profils.

test('the worker itself concludes a merge whose conflicts the agent resolved without Git, then merges current main', async t => {
  let checkout;
  const f = await fixture(t, {
    model: async (input, count) => {
      checkout = input.cwd;
      if (count === 1) {
        await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
        return { status: 'question', summary: '', question: 'Faut-il aussi traduire le titre ?' };
      }
      if (count === 2) {
        // Conflit avec main : l’agent corrige le fichier mais, sans shell, laisse la fusion en cours.
        assert.match(input.feedback, /greet\.mjs/);
        assert.match(input.feedback, /Ne lance aucune commande Git/);
        assert.ok(await exists(join(input.cwd, '.git', 'MERGE_HEAD')));
        await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
        return { status: 'question', summary: '', question: 'Il faut valider la fusion en cours.' };
      }
      assert.doesNotMatch(input.feedback || '', /conflit/i);
      assert.equal(await exists(join(input.cwd, '.git', 'MERGE_HEAD')), false);
      return { status: 'result', summary: 'Greeting translated', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting');
  await writeFile(join(f.source, 'greet.mjs'), "export const greet = () => 'salut';\n");
  await f.git(['commit', '-am', 'Conflicting main']);
  await f.git(['push', 'origin', 'main']);
  answer(f);
  assert.equal((await f.worker.tick()).status, 'waiting', f.logs.join('\n'));
  // main avance encore pendant que la fusion attend.
  await writeFile(join(f.source, 'readme.md'), 'Later main');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Later main']);
  await f.git(['push', 'origin', 'main']);
  answer(f);
  assert.equal((await f.worker.tick()).status, 'merging', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 3);
  assert.ok(f.logs.some(line => line.includes('fusion précédente avec main validée par le worker')));
  const branch = `refs/heads/planifikateur/${f.current().id}`;
  assert.equal(await f.git(['show', `${branch}:greet.mjs`], f.bare), "export const greet = () => 'bonjour';");
  assert.equal(await f.git(['show', `${branch}:readme.md`], f.bare), 'Later main');
  assert.equal(JSON.parse(await f.git(['show', `${branch}:package.json`], f.bare)).version, '1.0.1');
  assert.equal(await exists(join(checkout, '.git', 'MERGE_HEAD')), false);
});

test('a changelog conflict with main is resolved by the worker, which rewrites its own entry', async t => {
  const f = await fixture(t);
  f.prepare();
  const initial = await f.worker.tick();
  const run = f.current();
  await writeFile(
    join(f.source, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.0.1 — 2026-01-01\n\n- **Autre carte** : livrée.\n',
  );
  // Une autre carte livrée sur main a pris la même version : seul le changelog entre en conflit.
  await writeFile(
    join(f.source, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.1' }, null, 2) + '\n',
  );
  await writeFile(
    join(f.source, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.1', packages: { '': { version: '1.0.1' } } }, null, 2) + '\n',
  );
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'Other delivery']);
  await f.git(['push', 'origin', 'main']);
  f.setBehind(true);
  const updated = await f.worker.tick();
  f.setBehind(false);
  assert.equal(updated.status, 'merging', f.logs.join('\n'));
  assert.notEqual(updated.sha, initial.sha);
  const changelog = await f.git(['show', `refs/heads/planifikateur/${run.id}:CHANGELOG.md`], f.bare);
  assert.doesNotMatch(changelog, /^<{7}/m);
  assert.match(changelog, /- \*\*Autre carte\*\* : livrée\./);
  assert.equal(changelog.split(`<!-- planifikateur:${run.id} -->`).length, 2);
  assert.match(changelog, new RegExp(`## 1\\.0\\.2 — .+\\n<!-- planifikateur:${run.id} -->`));
  assert.ok(f.modelCalls.every(call => !/conflit/i.test(call.feedback || '')));
  assert.equal(f.modelCalls.length, 1);
});

test('a checkout stuck in an operation the worker cannot resume is recloned from GitHub', async t => {
  const f = await fixture(t, {
    model: async (input, count) => {
      if (count === 1) return { status: 'question', summary: '', question: 'Quelle langue ?' };
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Greeting translated', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting');
  await mkdir(join(f.config.stateRoot, 'jobs', f.current().id, '.git', 'rebase-merge'));
  answer(f);
  assert.equal((await f.worker.tick()).status, 'merging', f.logs.join('\n'));
  assert.ok(f.logs.some(line => line.includes('checkout local recréé (opération Git interrompue (rebase-merge))')));
});

for (const preset of ['planifikateur', 'defilordi', 'funkart'])
  test(`automatic discovery delivers ${preset} with its model, repository, tests and GitHub workflow`, async t => {
    const repo = `flo91360/${preset}`;
    const f = await fixture(t, { auto: true, preset, repository: repo });
    f.config.projectIds = [];
    f.config.repositories = [];
    f.store.workflows.configureAi(f.project.id, { engine: 'codex', model: 'gpt-6.1-sol' }, f.user);
    f.prepare();
    assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
    assert.equal(f.modelCalls.length, 1);
    assert.equal(f.modelCalls[0].job.ai.model, 'gpt-6.1-sol');
    assert.equal(f.modelCalls[0].run.repository, repo);
    assert.equal(f.modelCalls[0].run.executionProfile.preset, preset);
    assert.equal(f.store.workflows.workerStatus(f.project.id).state, 'ready');
    f.setTestsReady(true);
    await f.worker.tick();
    assert.equal(f.merges, 1);
    const run = f.current();
    await f.webhook({
      action: 'closed',
      repository: { full_name: repo },
      pull_request: {
        number: 1,
        merged: true,
        merged_at: new Date().toISOString(),
        merge_commit_sha: f.pr.head.sha,
        head: { sha: f.pr.head.sha, repo: { full_name: repo } },
        base: { ref: 'main' },
      },
    });
    assert.equal(f.current().state, 'done');
    assert.equal(await f.git(['show', 'main:greet.mjs'], f.bare), "export const greet = () => 'bonjour';");
    if (preset !== 'funkart') {
      assert.equal(JSON.parse(await f.git(['show', 'main:package.json'], f.bare)).version, '1.0.1');
      assert.equal(JSON.parse(await f.git(['show', 'main:package-lock.json'], f.bare)).packages[''].version, '1.0.1');
    } else assert.match(await f.git(['show', 'main:project.godot'], f.bare), /config\/version="1.0.1"/);
    // DefilOrdi fabrique son CHANGELOG.md sur main par sa CI : le worker ne l’écrit pas.
    if (preset === 'defilordi') await assert.rejects(f.git(['show', 'main:CHANGELOG.md'], f.bare), /CHANGELOG\.md/);
    else
      assert.match(
        await f.git(['show', 'main:CHANGELOG.md'], f.bare),
        new RegExp(
          `\\n## 1\\.0\\.1 — \\d{4}-\\d{2}-\\d{2}\\n<!-- planifikateur:${run.id} -->\\n\\n- \\*\\*.+\\*\\* : Greeting translated`,
        ),
      );
    assert.equal(f.current().id, run.id);
  });

test('a blocked new engine configuration does not prevent resuming an existing Codex conversation', async t => {
  const f = await fixture(t, {
    auto: true,
    model: async (input, count) => {
      if (count === 1) return { status: 'question', summary: '', question: 'Quelle langue ?' };
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Traduction prête.', question: '' };
    },
  });
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'waiting');
  f.store.workflows.configureAi(f.project.id, { engine: 'claude-code', model: 'sonnet' }, f.user);
  const waiting = f.current();
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    waiting.id,
    'answer',
    { version: waiting.version, message: 'Français' },
    f.user,
  );
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  assert.equal(f.current().ai.engine, 'codex');
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.store.workflows.workerStatus(f.project.id).state, 'blocked');
});

test('withdrawn projects preserve their local conversation and cannot block another authorized project', async t => {
  const f = await fixture(t, { auto: true });
  const previous = {
    id: 'withdrawn-task',
    projectId: 'withdrawn-project',
    cardId: 'previous-card',
    repository: 'old/repo',
    phase: 'running',
    threadId: 'keep-thread',
  };
  await f.state.put(previous);
  f.prepare();
  assert.equal((await f.worker.tick()).status, 'merging', JSON.stringify(f.logs));
  assert.deepEqual(await f.state.get(previous.id), { ...previous, phase: 'unauthorized' });
  assert.equal(f.modelCalls.length, 1);
});

test('worker ignores manual deliveries and repositories outside its allowlist', async t => {
  const f = await fixture(t);
  const run = f.prepare();
  assert.equal((await f.worker.processTask({ ...run, repository: 'unapproved/repo' })).status, 'ignored');
  assert.equal((await f.worker.processTask({ ...run, delivery: 'manual' })).status, 'ignored');
  assert.equal(f.current().state, 'ready');
  assert.equal(f.modelCalls.length, 0);
});

test('loss of agent access stops Codex through the heartbeat and prevents publication', async t => {
  let started;
  const start = new Promise(resolve => {
    started = resolve;
  });
  const f = await fixture(t, {
    model: async input => {
      started();
      await delay(60000, undefined, { signal: input.signal });
      return { status: 'result', summary: 'Too late', question: '' };
    },
  });
  const worker = createWorker({ ...f.config, heartbeatMs: 20 }, f.dependencies);
  const running = worker.processTask(f.prepare());
  await start;
  f.store.workflows.revokeAgent(f.credentials.agent.id, f.user);
  assert.equal((await running).status, 'interrupted');
  assert.equal(f.pr, undefined);
  assert.equal(
    f.calls.some(c => c.command[0] === 'git' && c.command[1] === 'push'),
    false,
  );
  assert.equal((await f.state.get(f.current().id)).attempts, 0);
  assert.match(f.logs.at(-1), /API : 401/);
});

test('temporary heartbeat outages preserve the task and resume lease renewal', async t => {
  let failures = 0,
    renewals = 0;
  const f = await fixture(t, {
    model: async input => {
      await delay(160, undefined, { signal: input.signal });
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Greeting translated', question: '' };
    },
  });
  const site = {
    ...f.site,
    async action(run, name, data, signal) {
      if (name === 'heartbeat') {
        if (failures++ < 2) throw new ApiError(503, 'unavailable');
        renewals++;
      }
      return f.site.action(run, name, data, signal);
    },
  };
  const worker = createWorker({ ...f.config, heartbeatMs: 20 }, { ...f.dependencies, site });
  assert.equal((await worker.processTask(f.prepare())).status, 'merging');
  assert.equal(f.modelCalls.length, 1);
  assert.ok(renewals > 0);
  assert.equal(f.logs.filter(line => line.includes('temporairement indisponible')).length, 2);
  assert.equal((await f.state.get(f.current().id)).attempts, 0);
});

test('an outage cannot keep working after the last confirmed lease expires', async t => {
  const f = await fixture(t, {
    model: async input => {
      await delay(60000, undefined, { signal: input.signal });
      throw new Error('Must stop before completing');
    },
  });
  const site = {
    ...f.site,
    async action(run, name, data, signal) {
      if (name === 'heartbeat') throw new ApiError(502, 'unavailable');
      const response = await f.site.action(run, name, data, signal);
      return response.state === 'running'
        ? { ...response, leaseExpiresAt: new Date(Date.now() + 200).toISOString() }
        : response;
    },
  };
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
  const f = await fixture(t, {
    model: async (input, number) => {
      if (number === 2)
        assert.equal(input.run.submissions.at(-1).decision.message, 'Add a comment explaining the greeting');
      await writeFile(
        join(input.cwd, 'greet.mjs'),
        `${number === 2 ? '// French greeting\n' : ''}export const greet = () => 'bonjour';\n`,
      );
      return { status: 'result', summary: 'Greeting corrected', question: '' };
    },
  });
  f.prepare();
  const initial = await f.worker.tick();
  const run = f.current();
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    run.id,
    'reject',
    { version: run.version, message: 'Add a comment explaining the greeting' },
    f.user,
  );
  const corrected = await f.worker.tick();
  assert.equal(corrected.status, 'merging');
  assert.equal(corrected.number, initial.number);
  assert.notEqual(corrected.sha, initial.sha);
  assert.equal(f.current().submissions.length, 2);
  assert.equal(f.current().submissions[0].decision.accepted, false);
});

test('a PR closed without merging asks a question instead of creating another PR', async t => {
  const f = await fixture(t);
  f.prepare();
  await f.worker.tick();
  f.pr.state = 'closed';
  f.pr.merged = false;
  assert.equal((await f.worker.tick()).status, 'waiting');
  assert.equal(f.current().state, 'waiting');
  assert.equal(f.modelCalls.length, 1);
  assert.match(f.current().exchanges.at(-1).question, /fermée sans fusion/);
});

test('a retry budget stops repeated model runs until a human answers', async t => {
  const f = await fixture(t, {
    model: async () => {
      throw new Error('Model unavailable');
    },
  });
  const worker = createWorker({ ...f.config, maxAttempts: 1 }, f.dependencies);
  await worker.processTask(f.prepare());
  assert.equal(f.current().state, 'waiting');
  assert.equal(f.modelCalls.length, 1);
  assert.equal((await worker.processTask({ ...f.current(), state: 'ready' })).status, 'claimed_elsewhere');
  assert.equal(f.modelCalls.length, 1);
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
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.current().submissions.at(-1).pullRequest.headSha, f.pr.head.sha);
});

test('the original agent recovers the old publication question without a human answer', async t => {
  const f = await fixture(t);
  f.prepare();
  await f.worker.tick();
  const claimed = await f.site.action(f.current(), 'revise');
  await f.site.action(claimed, 'question', { message: 'La PR ne pointe pas sur le commit testé.' });
  const job = await f.state.get(claimed.id);
  job.attempts = 3;
  job.phase = 'waiting';
  await f.state.put(job);
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
  const f = await fixture(t);
  f.prepare();
  await f.worker.tick();
  const claimed = await f.site.action(f.current(), 'revise');
  await f.site.action(claimed, 'question', { message: 'Quel fichier faut-il modifier ?' });
  await assert.rejects(f.site.action(f.current(), 'revise'), error => error.status === 409);
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(f.current().state, 'waiting');
  assert.equal(f.modelCalls.length, 1);
});

test('GitHub PR synchronization ignores stale listings and waits for the tested head', async () => {
  const branch = 'planifikateur/task',
    testedSha = 'a'.repeat(40),
    waits = [];
  const stale = {
    number: 9,
    state: 'open',
    draft: false,
    head: { sha: 'b'.repeat(40), ref: branch, repo: { full_name: repository } },
    base: { ref: 'main' },
  };
  let reads = 0;
  const client = createGithubClient(
    'private-token',
    async url => {
      if (new URL(url).pathname.endsWith('/pulls')) return Response.json([stale]);
      reads++;
      return Response.json(reads < 3 ? stale : { ...stale, head: { ...stale.head, sha: testedSha } });
    },
    async ms => {
      waits.push(ms);
    },
  );
  const pr = await client.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha);
  assert.equal(pr.head.sha, testedSha);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('PR synchronization never approves a different commit or an unrelated branch', async () => {
  const branch = 'planifikateur/task',
    testedSha = 'a'.repeat(40);
  const stale = {
    number: 9,
    state: 'open',
    draft: false,
    head: { sha: 'b'.repeat(40), ref: branch, repo: { full_name: repository } },
    base: { ref: 'main' },
  };
  let reads = 0;
  const client = createGithubClient(
    'private-token',
    async url => {
      if (new URL(url).pathname.endsWith('/pulls')) return Response.json([stale]);
      reads++;
      return Response.json(stale);
    },
    async () => {},
  );
  await assert.rejects(
    client.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha),
    PublicationPendingError,
  );
  assert.equal(reads, 6);
  const foreign = createGithubClient('private-token', async url =>
    Response.json(
      new URL(url).pathname.endsWith('/pulls')
        ? [stale]
        : { ...stale, head: { ...stale.head, ref: 'other-branch', sha: testedSha } },
    ),
  );
  await assert.rejects(
    foreign.ensurePullRequest(repository, branch, 'Title', 'Body', undefined, testedSha),
    /ne correspond pas/,
  );
});
