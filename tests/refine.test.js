import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { readConfig } from '../server/config.js';
import { createRefiner, validateRefinement, DEFAULT_REFINE_MODEL } from '../server/refine.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const apiKey = 'sk-ant-test-secret';
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const message = (result, extra = {}) => ({ model: DEFAULT_REFINE_MODEL, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(result) }], ...extra });
const fakeTransport = (responses = []) => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next || reply(message({ prompt: 'Objectif\nAjouter un bouton.', questions: [] }));
  };
  return { transport, calls };
};

async function fixture(t, config = {}) {
  const store = createStore(':memory:');
  seedAccount(store);
  const server = createAppServer({ store, config: { readToken: 'refine-test-agent', ...config } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const Cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const refine = (projectId, data, headers = { Cookie }) => fetch(`${base}/api/v1/projects/${projectId}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { store, base, Cookie, refine };
}

test('the refiner sends a structured, non-modifying request to the Messages API', async () => {
  const { transport, calls } = fakeTransport();
  const refiner = createRefiner({ apiKey, transport });
  assert.equal(refiner.enabled, true);
  assert.equal(refiner.model, 'claude-opus-5-5');
  const result = await refiner.refine({ project: { name: 'Mon projet', description: 'Une appli', repository: 'owner/repo' }, list: 'Bugs', title: 'Bouton', description: 'euh ajouter un bouton euh pour exporter', exchanges: [{ question: 'Quel format ?', answer: 'CSV' }] });
  assert.deepEqual(result, { prompt: 'Objectif\nAjouter un bouton.', questions: [], model: 'claude-opus-5-5' });
  const [{ url, options, body }] = calls;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['x-api-key'], apiKey);
  assert.equal(options.headers['anthropic-version'], '2023-06-01');
  assert.equal(options.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema.required, ['prompt', 'questions']);
  assert.match(body.system, /Tu ne réalises pas la demande et tu ne modifies rien/);
  assert.match(body.system, /pose une question précise/);
  const prompt = body.messages[0].content;
  for (const expected of ['Projet : Mon projet', 'Dépôt GitHub : owner/repo', 'Liste de la carte : Bugs', 'Titre de la carte : Bouton', 'euh ajouter un bouton euh pour exporter', 'Question : Quel format ?\nRéponse : CSV']) assert.ok(prompt.includes(expected), expected);
});

test('a model without server-side fallback is called without the fallback beta', async () => {
  const { transport, calls } = fakeTransport();
  await createRefiner({ apiKey, model: 'claude-haiku-5-5', transport }).refine({ description: 'Texte' });
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.fallbacks, undefined);
  assert.equal(calls[0].options.headers['anthropic-beta'], undefined);
  assert.equal(calls[0].body.messages[0].content, 'Demande à reformuler :\n<<<\nTexte\n>>>');
});

test('the refiner keeps only the final model output and bounds questions', async () => {
  const content = [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: JSON.stringify({ prompt: '  Demande claire  ', questions: [' Q1 ', '', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'] }) }];
  const { transport } = fakeTransport([reply({ model: 'claude-opus-4-8', stop_reason: 'end_turn', content })]);
  const result = await createRefiner({ apiKey, transport }).refine({ description: 'Texte' });
  assert.deepEqual(result, { prompt: 'Demande claire', questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'], model: 'claude-opus-4-8' });
});

test('provider failures become explicit errors without leaking the key', async () => {
  const cases = [
    [reply(message({}, { stop_reason: 'refusal', content: [] })), 422, 'refinement_refused'],
    [reply(message({ prompt: 'Partiel' }, { stop_reason: 'max_tokens' })), 502, 'refinement_incomplete'],
    [reply({ model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'pas du JSON' }] }), 502, 'refinement_invalid'],
    [reply(message({ prompt: '', questions: [] })), 502, 'refinement_invalid'],
    [reply({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${apiKey}` } }, 401), 502, 'ai_unauthorized'],
    [reply({ type: 'error', error: { type: 'rate_limit_error' } }, 429), 503, 'ai_busy'],
    [reply({ type: 'error', error: { type: 'overloaded_error' } }, 529), 503, 'ai_busy'],
    [reply({ type: 'error', error: { type: 'invalid_request_error' } }, 400), 502, 'ai_rejected'],
    [new TypeError('fetch failed'), 504, 'ai_unreachable'],
  ];
  for (const [response, status, code] of cases) {
    const { transport } = fakeTransport([response]);
    await assert.rejects(createRefiner({ apiKey, transport }).refine({ description: 'Texte' }), error => {
      assert.equal(error.status, status, code); assert.equal(error.code, code);
      assert.ok(!error.message.includes(apiKey)); return true;
    });
  }
  await assert.rejects(createRefiner({ transport: fakeTransport().transport }).refine({ description: 'Texte' }), { status: 503, code: 'ai_not_configured' });
});

test('refinement input is validated and unanswered exchanges are dropped', () => {
  assert.throws(() => validateRefinement(null), { code: 'invalid_refinement' });
  assert.throws(() => validateRefinement({ description: '   ' }), /Rédigez ou dictez/);
  assert.throws(() => validateRefinement({ description: 'x'.repeat(20001) }), /maximum 20000/);
  assert.throws(() => validateRefinement({ description: 'Texte', title: 42 }), /title/);
  assert.throws(() => validateRefinement({ description: 'Texte', exchanges: Array(21).fill({ question: 'Q', answer: 'R' }) }), /exchanges/);
  assert.deepEqual(validateRefinement({ description: ' Texte ', exchanges: [{ question: 'Q1', answer: ' R1 ' }, { question: 'Q2', answer: '' }] }), { title: '', description: 'Texte', listId: '', exchanges: [{ question: 'Q1', answer: 'R1' }] });
});

test('the server reads the Anthropic key and the optional model from its environment', () => {
  assert.equal(readConfig({}).anthropicApiKey, '');
  const config = readConfig({ ANTHROPIC_API_KEY: apiKey, PLANIFIKATEUR_REFINE_MODEL: 'claude-sonnet-5-5' });
  assert.equal(config.anthropicApiKey, apiKey);
  assert.equal(config.refineModel, 'claude-sonnet-5-5');
  assert.throws(() => readConfig({ PLANIFIKATEUR_REFINE_MODEL: 'bad model' }), /PLANIFIKATEUR_REFINE_MODEL/);
});

test('the refine route requires an account, a project and a configured key', async t => {
  const { base, Cookie, refine } = await fixture(t);
  assert.equal((await refine('planifikateur', { description: 'Texte' }, {})).status, 401);
  assert.equal((await refine('planifikateur', { description: 'Texte' }, { Cookie, Origin: 'https://other.test' })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/projects/planifikateur/refine`, { headers: { Cookie } })).status, 405);
  assert.equal((await refine('missing', { description: 'Texte' })).status, 404);
  const empty = await refine('planifikateur', { description: '' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'invalid_refinement');
  const disabled = await refine('planifikateur', { description: 'Texte' });
  assert.equal(disabled.status, 503);
  assert.deepEqual((await disabled.json()).error, { code: 'ai_not_configured', message: 'La reformulation IA n’est pas configurée : ajoutez ANTHROPIC_API_KEY aux variables du serveur du site.' });
});

test('the refine route returns a proposal with project context and limits each account', async t => {
  const { transport, calls } = fakeTransport([reply(message({ prompt: 'Objectif\nCorriger le tri.', questions: ['Quel ordre par défaut ?'] }))]);
  const { store, refine } = await fixture(t, { refiner: createRefiner({ apiKey, transport }) });
  store.workflows.configureGithub('planifikateur', 'owner/planifikateur', { id: 'github', name: 'GitHub' });
  const response = await refine('planifikateur', { title: 'Tri', description: 'le tri marche pas', listId: 'bugs', exchanges: [] });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(apiKey));
  assert.deepEqual(JSON.parse(text).data, { prompt: 'Objectif\nCorriger le tri.', questions: ['Quel ordre par défaut ?'], model: 'claude-opus-5-5' });
  const prompt = calls[0].body.messages[0].content;
  for (const expected of ['Projet : PlaniFiKateur', 'Dépôt GitHub : owner/planifikateur', 'Liste de la carte : Bugs', 'Titre de la carte : Tri', 'le tri marche pas']) assert.ok(prompt.includes(expected), expected);
  for (let i = 1; i < 10; i++) assert.equal((await refine('planifikateur', { description: 'Texte' })).status, 200);
  const limited = await refine('planifikateur', { description: 'Texte' });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'too_many_refinements');
  assert.equal(calls.length, 10);
});
