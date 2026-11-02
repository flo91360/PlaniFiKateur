import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceededError, aiBudget, aiSpending } from '../worker/budget.mjs';
import { createClaudeRunner } from '../worker/claude.mjs';
import { readWorkerConfig } from '../worker/config.mjs';

const at = minutes => new Date(Date.UTC(2026, 10, 2, 12, minutes)).toISOString();
const run = {
  exchanges: [{ question: 'Quelle page ?', date: at(10), answer: { text: 'Accueil', date: at(20) } }],
  submissions: [],
  attempts: [
    { startedAt: at(0), usage: { inputTokens: 9e6, outputTokens: 1e5, costUsd: 6 } },
    { startedAt: at(25), usage: { inputTokens: 4e6, outputTokens: 5e4, costUsd: 3 } },
    // Tentative en cours : sa consommation est celle de la réservation (`current`).
    { startedAt: at(40), usage: { inputTokens: 1, costUsd: 100 } },
  ],
};

test('AI spending counts the attempts since the last human answer plus the current one', () => {
  assert.deepEqual(aiSpending(run, { inputTokens: 1e6, outputTokens: 1e4, costUsd: 2 }), {
    since: Date.parse(at(20)),
    costUsd: 5,
    tokens: 5060000,
  });
  // Corrections demandées sur la PR : nouvelle tranche à partir de cette décision.
  const rejected = { ...run, submissions: [{ decision: { accepted: false, date: at(30) } }] };
  assert.equal(aiSpending(rejected, null).costUsd, 0);
  // Sans intervention humaine, toute l’exécution compte.
  assert.equal(aiSpending({ ...run, exchanges: [] }, null).costUsd, 9);
});

test('the AI budget bounds Claude Code in dollars, Codex in tokens, and asks on the card once reached', () => {
  const config = { maxCostUsd: 10, maxTokens: 6e6 };
  assert.deepEqual(aiBudget(config, 'claude-code', run, { costUsd: 2 }), { question: null, remainingUsd: 5 });
  const reached = aiBudget(config, 'claude-code', run, { costUsd: 7.5 });
  assert.equal(reached.remainingUsd, undefined);
  assert.match(reached.question, /^Plafond de dépense IA atteint pour cette exécution : 10,50 \$ estimés depuis la/);
  assert.match(reached.question, /plafond de 10,00 \$ \(PLANIFIKATEUR_WORKER_MAX_COST_USD\)\. Répondez pour autoriser/);
  // Appel arrêté par le SDK : la question est posée même si l’estimation reste sous le plafond.
  assert.match(aiBudget(config, 'claude-code', run, { costUsd: 1 }, { exceeded: true }).question, /4,00 \$ estimés/);
  assert.deepEqual(aiBudget(config, 'codex', run, { inputTokens: 1e6 }), { question: null, remainingUsd: undefined });
  const tokens = aiBudget(config, 'codex', run, { inputTokens: 2.15e6 }, { discussion: true });
  assert.match(tokens.question, /6,2 millions de tokens depuis la dernière réponse, pour un plafond de 6 millions/);
  assert.match(tokens.question, /nouveau commentaire pour relancer l’agent/);
  // Un plafond à 0 est désactivé.
  assert.deepEqual(aiBudget({ maxCostUsd: 0, maxTokens: 0 }, 'claude-code', run, { costUsd: 1e4 }), { question: null });
  assert.deepEqual(aiBudget({ maxCostUsd: 0, maxTokens: 0 }, 'codex', run, { inputTokens: 1e12 }), { question: null });
});

test('worker spend caps default to 10 dollars and 20 million tokens and reject invalid amounts', () => {
  const env = {
    PLANIFIKATEUR_URL: 'https://example.com',
    PLANIFIKATEUR_AGENT_TOKEN: 'agent',
    PLANIFIKATEUR_GITHUB_TOKEN: 'github',
  };
  const config = readWorkerConfig(env);
  assert.equal(config.maxCostUsd, 10);
  assert.equal(config.maxTokens, 20000000);
  assert.equal(readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_MAX_COST_USD: '2.5' }).maxCostUsd, 2.5);
  assert.equal(readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_MAX_COST_USD: '0' }).maxCostUsd, 0);
  for (const value of ['', '-1', 'dix', '10001'])
    assert.throws(() => readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_MAX_COST_USD: value }), /invalide/);
  assert.throws(() => readWorkerConfig({ ...env, PLANIFIKATEUR_WORKER_MAX_TOKENS: '1.5' }), /invalide/);
});

test('Claude Code receives the remaining budget and counts only the new cost of a resumed conversation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-claude-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { claudeApiKey: 'private', claudeHome: join(root, 'claude'), codexHome: join(root, 'codex') };
  const card = { cardSnapshot: { title: 'Budget' }, objective: 'Budget', exchanges: [], submissions: [], updates: [] };
  const ai = { engine: 'claude-code', model: 'sonnet', effort: '' };
  let options, last;
  const usages = [],
    costs = [];
  const query = ({ options: selected }) => {
    options = selected;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'budget-session', model: 'sonnet' };
      yield { type: 'result', session_id: 'budget-session', duration_ms: 1000, usage: { output_tokens: 5 }, ...last };
    })();
  };
  const call = (job, maxBudgetUsd) =>
    createClaudeRunner(config, { query }).run({
      run: card,
      job: { ai, ...job },
      cwd: root,
      maxBudgetUsd,
      onThread() {},
      onUsage: usage => usages.push(usage),
      onSessionCost: cost => costs.push(cost),
    });
  // La transcription reprise porte déjà 5 $ : l’appel n’en a coûté que 2,5.
  last = { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 7.5 };
  const resumed = { threadId: 'budget-session', sessionCost: { thread: 'budget-session', usd: 5 } };
  await assert.rejects(call(resumed, 2.5), BudgetExceededError);
  assert.equal(options.maxBudgetUsd, 2.5);
  assert.equal(options.resume, 'budget-session');
  assert.equal(usages.at(-1).costUsd, 2.5);
  assert.deepEqual(costs.at(-1), { thread: 'budget-session', usd: 7.5 });
  // Total inférieur au dernier connu (transcription sans total enregistré) : tout revient à cet appel.
  last = {
    subtype: 'success',
    total_cost_usd: 1.25,
    structured_output: { status: 'result', summary: 'Fait.', question: '', files: [] },
  };
  assert.equal((await call(resumed)).summary, 'Fait.');
  assert.equal(options.maxBudgetUsd, undefined);
  assert.equal(usages.at(-1).costUsd, 1.25);
  // Nouvelle conversation : aucun coût antérieur à déduire.
  last = { ...last, total_cost_usd: 3 };
  await call({ sessionCost: { thread: 'other-session', usd: 2 } }, 4);
  assert.equal(options.resume, undefined);
  assert.equal(usages.at(-1).costUsd, 3);
});
