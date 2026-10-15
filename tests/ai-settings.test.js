import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { createCodexRunner, codexSessionModel } from '../worker/codex.mjs';
import { createClaudeRunner } from '../worker/claude.mjs';

test('project engine/model and card effort are isolated and frozen at first claim through questions and runtime reports', () => {
  const store = createStore(':memory:'),
    actor = { id: 'owner', name: 'Florian' };
  try {
    const snapshot = store.read(),
      [first, second] = snapshot.projects,
      card = first.cards[0];
    card.aiEffort = 'high';
    store.write(snapshot.projects, snapshot.revision, actor);
    store.workflows.configureGithub(first.id, 'owner/first', actor);
    store.workflows.configureAi(first.id, { engine: 'claude-code', model: 'sonnet' }, actor);
    assert.deepEqual(store.workflows.projectAi(second.id), { engine: 'codex', model: '' });
    const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [first.id] }, actor);
    let run = store.workflows.prepare(first.id, card.id, {}, actor);
    store.workflows.configureAi(first.id, { engine: 'claude-code', model: 'opus' }, actor);
    assert.throws(
      () => store.workflows.agentAction(first.id, card.id, run.id, 'claim', { version: run.version }, agent),
      error => error.code === 'worker_update_required',
    );
    run = store.workflows.agentAction(
      first.id,
      card.id,
      run.id,
      'claim',
      { version: run.version, aiSettingsSupported: true, engines: ['codex', 'claude-code'] },
      agent,
    );
    assert.deepEqual(run.ai, { engine: 'claude-code', model: 'opus', effort: 'high' });
    store.workflows.configureAi(first.id, { engine: 'codex', model: 'another-model' }, actor);
    assert.throws(
      () =>
        store.workflows.agentAction(
          first.id,
          card.id,
          run.id,
          'progress',
          {
            version: run.version,
            leaseToken: run.leaseToken,
            message: 'Wrong engine',
            aiRuntime: { engine: 'codex', model: 'model' },
          },
          agent,
        ),
      error => error.code === 'invalid_ai',
    );
    const lease = run.leaseToken;
    run = store.workflows.agentAction(
      first.id,
      card.id,
      run.id,
      'progress',
      {
        version: run.version,
        leaseToken: lease,
        message: 'Model selected',
        aiRuntime: { engine: 'claude-code', model: 'claude-opus-resolved' },
      },
      agent,
    );
    run = store.workflows.agentAction(
      first.id,
      card.id,
      run.id,
      'question',
      { version: run.version, leaseToken: lease, message: 'Quelle fenêtre ?' },
      agent,
    );
    run = store.workflows.human(
      first.id,
      card.id,
      run.id,
      'answer',
      { version: run.version, message: 'La fenêtre principale.' },
      actor,
    );
    run = store.workflows.agentAction(
      first.id,
      card.id,
      run.id,
      'claim',
      { version: run.version, aiSettingsSupported: true, engines: ['codex', 'claude-code'] },
      agent,
    );
    assert.deepEqual(run.ai, { engine: 'claude-code', model: 'opus', effort: 'high' });
    assert.equal(run.aiRuntime.model, 'claude-opus-resolved');
    assert.throws(() => store.workflows.configureAi(first.id, { engine: 'unknown', model: '' }, actor));
    assert.throws(() => store.workflows.configureAi(first.id, { engine: 'codex', model: 'model\nsecret' }, actor));
    const invalid = store.read().projects;
    invalid[0].cards[0].aiEffort = 'invented';
    assert.throws(() => validateWorkspace(invalid), /Effort IA/);
  } finally {
    store.close();
  }
});

test('a card without effort gets the medium effort its detail shows, unless the worker ignores AI settings', () => {
  const store = createStore(':memory:'),
    actor = { id: 'owner', name: 'Florian' };
  try {
    const snapshot = store.read(),
      [first] = snapshot.projects,
      [card, other] = first.cards;
    delete card.aiEffort;
    delete other.aiEffort;
    store.write(snapshot.projects, snapshot.revision, actor);
    store.workflows.configureGithub(first.id, 'owner/first', actor);
    const { agent } = store.workflows.configureAgent({ name: 'Agent', projectIds: [first.id] }, actor);
    let run = store.workflows.prepare(first.id, card.id, {}, actor);
    run = store.workflows.agentAction(
      first.id,
      card.id,
      run.id,
      'claim',
      { version: run.version, aiSettingsSupported: true, engines: ['codex', 'claude-code'] },
      agent,
    );
    assert.deepEqual(run.ai, { engine: 'codex', model: '', effort: 'medium' });
    let legacy = store.workflows.prepare(first.id, other.id, {}, actor);
    legacy = store.workflows.agentAction(first.id, other.id, legacy.id, 'claim', { version: legacy.version }, agent);
    assert.deepEqual(legacy.ai, { engine: 'codex', model: '', effort: '' });
  } finally {
    store.close();
  }
});

test('Codex receives the frozen model and effort and extracts the actual model without exposing session text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-codex-ai-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex'),
    sessions = join(home, 'sessions', '2026');
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, 'rollout-session.jsonl'),
    [
      JSON.stringify({ type: 'user_message', payload: { text: 'private-session-content' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'resolved-model' } }),
    ].join('\n'),
  );
  assert.equal(await codexSessionModel(home, 'session'), 'resolved-model');
  assert.equal(await codexSessionModel(home, '../invalid'), null);
  let options, runtime;
  class Codex {
    resumeThread(id, value) {
      assert.equal(id, 'session');
      options = value;
      return {
        runStreamed: async () => ({
          events: (async function* () {
            yield {
              type: 'item.completed',
              item: {
                type: 'agent_message',
                text: JSON.stringify({ status: 'question', summary: '', question: 'Quelle fenêtre ?', files: [] }),
              },
            };
            yield { type: 'turn.completed' };
          })(),
        }),
      };
    }
  }
  const run = {
    ai: { engine: 'codex', model: 'project-model', effort: 'high' },
    cardSnapshot: { title: 'Window' },
    objective: 'Window',
    exchanges: [],
    submissions: [],
    updates: [],
  };
  const result = await createCodexRunner({ codexHome: home, model: 'global-model' }, { Codex }).run({
    run,
    job: { threadId: 'session', ai: { engine: 'codex', model: 'frozen-model', effort: 'medium' } },
    cwd: root,
    onRuntime: async value => {
      runtime = value;
    },
    onThread() {},
  });
  assert.equal(options.model, 'frozen-model');
  assert.equal(options.modelReasoningEffort, 'medium');
  assert.deepEqual(runtime, { engine: 'codex', model: 'resolved-model', effort: 'medium' });
  assert.equal(result.status, 'question');
});

test('Claude Code uses isolated credentials, frozen model/effort, resumed session and structured results', async t => {
  const unauthenticated = await createClaudeRunner({}).run({});
  assert.equal(unauthenticated.status, 'question');
  assert.match(unauthenticated.question, /ANTHROPIC_API_KEY/);
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-claude-ai-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    claudeApiKey: 'anthropic-private-key',
    claudeHome: join(root, 'claude'),
    codexHome: join(root, 'codex'),
  };
  let options, session, runtime;
  const query = ({ options: selected }) => {
    options = selected;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-session', model: 'claude-sonnet-resolved' };
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: {
          status: 'result',
          summary: 'Fichier prêt.',
          question: '',
          files: ['.planifikateur/generated/file.ui'],
        },
      };
    })();
  };
  const run = { cardSnapshot: { title: 'Window' }, objective: 'Window', exchanges: [], submissions: [], updates: [] };
  const result = await createClaudeRunner(config, { query }).run({
    run,
    job: { threadId: 'old-claude-session', ai: { engine: 'claude-code', model: 'sonnet', effort: 'high' } },
    cwd: root,
    onThread: async id => {
      session = id;
    },
    onRuntime: async value => {
      runtime = value;
    },
  });
  assert.equal(options.model, 'sonnet');
  assert.equal(options.effort, 'high');
  assert.equal(options.resume, 'old-claude-session');
  assert.equal(options.env.ANTHROPIC_API_KEY, config.claudeApiKey);
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.PLANIFIKATEUR_AGENT_TOKEN, undefined);
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.equal(options.permissionMode, 'acceptEdits');
  assert.deepEqual(options.settingSources, []);
  assert.equal((await options.canUseTool('Write', { file_path: '/outside/file' })).behavior, 'deny');
  assert.equal(session, 'claude-session');
  assert.equal(runtime.model, 'claude-sonnet-resolved');
  assert.equal(result.status, 'result');
});

test('Claude AskUserQuestion is relayed to the card instead of waiting for terminal input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-claude-question-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { claudeApiKey: 'private', claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') };
  const query = ({ options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'question-session', model: 'sonnet' };
      const permission = await options.canUseTool('AskUserQuestion', {
        questions: [
          {
            question: 'Quelle fenêtre faut-il modifier ?',
            options: [{ label: 'Principale', description: 'Écran d’accueil' }],
          },
        ],
      });
      assert.equal(permission.behavior, 'deny');
      assert.equal(options.abortController.signal.aborted, true);
      throw new Error('Query interrupted after question');
    })();
  const run = { cardSnapshot: { title: 'Window' }, objective: 'Window', exchanges: [], submissions: [], updates: [] };
  const result = await createClaudeRunner(config, { query }).run({
    run,
    job: { ai: { engine: 'claude-code', model: 'sonnet', effort: '' } },
    cwd: root,
    onThread() {},
  });
  assert.equal(result.status, 'question');
  assert.equal(result.question, 'Quelle fenêtre faut-il modifier ?\nPrincipale : Écran d’accueil');
});
