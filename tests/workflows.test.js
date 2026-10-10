import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { restoreBackup } from '../server/backups.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-work-')), file = join(dir, 'site.sqlite');
  const store = createStore(file), user = seedAccount(store), project = store.read().projects[0], card = project.cards[0];
  const credentials = store.workflows.configureAgent({ name: 'Test agent', projectIds: [project.id] }, user);
  const second = createStore(file), config = { readToken: 'read-only-test' };
  const servers = [createAppServer({ store, config }), createAppServer({ store: second, config })];
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bases = servers.map(s => `http://127.0.0.1:${s.address().port}`);
  const response = await loginRequest(bases[0]); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  t.after(async () => { for (const s of servers) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } second.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = `/projects/${project.id}/cards/${card.id}/work`;
  const request = (route, { method = 'GET', data, token, human = false, base = bases[0], headers = {} } = {}) => fetch(`${base}/api/v1${route}`, { method, headers: { ...(human ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const prepare = async () => { const r = await request(path, { method: 'POST', human: true, data: {} }); assert.equal(r.status, 201); return (await r.json()).data; };
  const action = (run, name, data = {}, options = {}) => request(`${path}/${run.id}/${name}`, { method: 'POST', token: credentials.token, data: { version: run.version, leaseToken: run.leaseToken, ...data }, ...options });
  const agentAction = async (run, name, data) => { const r = await action(run, name, data); assert.equal(r.status, 200, JSON.stringify(await r.clone().json())); return { ...(await r.json()).data, leaseToken: run.leaseToken }; };
  const claim = async run => { const r = await action(run, 'claim'); assert.equal(r.status, 200); return (await r.json()).data; };
  const humanAction = async (run, name, data = {}) => { const r = await action(run, name, data, { human: true, token: null }); assert.equal(r.status, 200, JSON.stringify(await r.clone().json())); return (await r.json()).data; };
  return { store, second, file, dir, user, project, card, credentials, bases, path, request, prepare, action, claim, agentAction, humanAction };
}

test('two servers claiming simultaneously create one exclusive reservation and no secret leaks', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const results = await Promise.all([f.action(prepared, 'claim'), f.action(prepared, 'claim', {}, { base: f.bases[1] })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
  const claimed = (await results.find(r => r.status === 200).json()).data;
  assert.match(claimed.leaseToken, /^[a-f0-9]{64}$/);
  assert.equal(f.store.read().projects[0].cards[0].status, 'progress');
  const list = await (await f.request(f.path, { human: true })).text();
  assert.ok(!list.includes(claimed.leaseToken)); assert.ok(!list.includes(f.credentials.token)); assert.ok(!list.includes('lease_hash'));
  const db = new DatabaseSync(f.file); t.after(() => db.close());
  assert.notEqual(db.prepare('SELECT token_hash FROM agents').get().token_hash, f.credentials.token);
  assert.notEqual(db.prepare('SELECT lease_hash FROM executions').get().lease_hash, claimed.leaseToken);
});

test('complete workflow keeps questions, corrections and submissions and requires human acceptance', async t => {
  const f = await fixture(t); f.store.setSubscription(f.project.id, f.card.id, f.user, true);
  let run = await f.claim(await f.prepare());
  const leaseToken = run.leaseToken;
  run = await f.agentAction(run, 'progress', { message: 'J’analyse le menu.' });
  run = await f.agentAction(run, 'question', { message: 'Faut-il conserver les raccourcis ?' });
  assert.equal(run.state, 'waiting'); assert.equal(f.store.read().projects[0].cards[0].status, 'clarify');
  assert.equal((await f.action(run, 'submit', { summary: 'X', checks: 'X', links: [] })).status, 409);
  assert.deepEqual(f.store.activity({ cardId: f.card.id }).find(e => e.action === 'work.question').recipientIds, [f.user.id]);
  run = await f.humanAction(run, 'answer', { message: 'Oui, tous les raccourcis.' });
  assert.equal(run.state, 'ready'); run = await f.claim(run); assert.notEqual(run.leaseToken, leaseToken);
  assert.equal(run.exchanges[0].answer.text, 'Oui, tous les raccourcis.');
  run = await f.agentAction(run, 'submit', { summary: 'Menu adapté.', checks: 'Test mobile réalisé.', links: ['https://example.test/result'] });
  assert.equal(run.state, 'review'); assert.equal(f.store.read().projects[0].cards[0].status, 'review');
  assert.equal((await f.action(run, 'accept')).status, 401);
  assert.equal((await f.action(run, 'reject', { message: '' }, { human: true, token: null })).status, 400);
  run = await f.humanAction(run, 'reject', { message: 'Le contraste doit être renforcé.' });
  assert.equal(run.state, 'ready'); assert.equal(run.submissions[0].decision.accepted, false);
  run = await f.claim(run);
  run = await f.agentAction(run, 'submit', { summary: 'Contraste corrigé.', checks: 'Contraste vérifié, tests réussis.', links: [] });
  run = await f.humanAction(run, 'accept');
  assert.equal(run.state, 'done'); assert.equal(run.submissions.length, 2); assert.equal(run.submissions[1].decision.actor.id, f.user.id);
  assert.equal(f.store.read().projects[0].cards[0].status, 'done');
  assert.equal((await f.action(run, 'claim')).status, 409);
  assert.equal((await f.action(run, 'reject', { message: 'stale' }, { human: true, token: null })).status, 409);
  const next = await f.prepare(); assert.notEqual(next.id, run.id);
});

test('expired reservations survive reconnect, rotate on recovery and fence old workers', async t => {
  const f = await fixture(t), run = await f.claim(await f.prepare());
  const db = new DatabaseSync(f.file); t.after(() => db.close());
  db.prepare('UPDATE executions SET lease_expires=? WHERE id=?').run(Date.now()-1, run.id);
  assert.equal((await f.action(run, 'submit', { summary: 'late', checks: 'late', links: [] })).status, 409);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'interrupted');
  const reopened = createStore(f.file); t.after(() => reopened.close());
  assert.equal(reopened.workflows.list(f.project.id, f.card.id)[0].state, 'interrupted');
  const queue = (await (await f.request(`/projects/${f.project.id}/work`, { token: f.credentials.token })).json()).data;
  const resumed = await f.claim(queue[0]); assert.notEqual(resumed.leaseToken, run.leaseToken);
  assert.equal((await f.action({ ...resumed, leaseToken: run.leaseToken }, 'progress', { message: 'old process' })).status, 409);
  const heartbeat = await f.agentAction(resumed, 'heartbeat'); assert.equal(heartbeat.version, resumed.version);
  let interrupted = await f.agentAction(resumed, 'interrupt', { message: 'Outil temporairement indisponible.' });
  assert.equal(interrupted.state, 'interrupted'); interrupted = await f.claim(interrupted); assert.equal(interrupted.state, 'running');
});

test('agent permissions are scoped and the consultation key cannot write or claim', async t => {
  const f = await fixture(t), run = await f.prepare();
  assert.equal((await f.request(f.path, { token: 'read-only-test' })).status, 401);
  assert.equal((await f.action(run, 'claim', {}, { token: 'read-only-test' })).status, 401);
  assert.equal((await f.request(f.path, { method: 'POST', token: f.credentials.token, data: {} })).status, 401);
  assert.equal((await f.request('/agents', { token: f.credentials.token })).status, 401);
  const snapshot = f.store.read();
  const other = { ...structuredClone(f.project), id: 'private-project', cards: [], lists: f.project.lists.map((l, i) => ({ ...l, id: `private-list-${i}` })) };
  snapshot.projects.push(other); f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.equal((await f.request(`/projects/${other.id}/cards`, { token: f.credentials.token })).status, 403);
  assert.equal((await f.request('/projects/wrong/work', { token: f.credentials.token })).status, 403);
  assert.equal((await f.request(`/projects/${f.project.id}/cards/wrong/work/${run.id}/claim`, { method: 'POST', token: f.credentials.token, data: { version: run.version } })).status, 404);
  assert.equal((await f.request('/agents', { method: 'POST', human: true, data: { name: 'second', projectIds: [f.project.id] } })).status, 409);
  const claimed = await f.claim(run);
  assert.equal((await f.action(claimed, 'submit', { summary: 'result', checks: 'tests', links: ['javascript:alert(1)'] })).status, 400);
  assert.equal((await f.action(claimed, 'submit', { summary: 'result', links: [] })).status, 400);
  f.store.workflows.revokeAgent(f.credentials.agent.id, f.user);
  assert.equal((await f.action(claimed, 'heartbeat')).status, 401);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'interrupted');
});

test('human transitions require current versions and content edits cancel obsolete executions', async t => {
  const f = await fixture(t), prepared = await f.prepare(), running = await f.claim(prepared);
  assert.equal((await f.action(prepared, 'cancel', { message: 'stale' }, { human: true, token: null })).status, 409);
  let snapshot = f.store.read(); snapshot.projects[0].cards[0].status = 'done';
  assert.throws(() => f.store.write(snapshot.projects, snapshot.revision, f.user), { code: 'managed_status' });
  assert.equal(f.store.getRevision(), snapshot.revision);
  snapshot = f.store.read(); snapshot.projects[0].cards[0].description += ' Nouvelle demande'; f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'cancelled');
  assert.equal((await f.action(running, 'submit', { summary: 'old result', checks: 'tests', links: [] })).status, 409);
  const newRun = await f.claim(await f.prepare());
  snapshot = f.store.read(); snapshot.projects[0].cards = snapshot.projects[0].cards.filter(c => c.id !== f.card.id); f.store.write(snapshot.projects, snapshot.revision, f.user);
  assert.equal((await f.action(newRun, 'heartbeat')).status, 404);
  assert.equal(f.store.workflows.queue(f.project.id, f.credentials.agent).length, 0);
});

test('backup restoration keeps execution history but invalidates current work and pending validation', async t => {
  const f = await fixture(t), file = join(f.dir, 'backup.sqlite');
  f.store.snapshot(file); const run = await f.claim(await f.prepare());
  const reviewed = await f.agentAction(run, 'submit', { summary: 'Result', checks: 'Verified', links: [] });
  restoreBackup(f.store, file, () => {});
  const history = f.store.workflows.list(f.project.id, f.card.id);
  assert.equal(history[0].state, 'cancelled'); assert.equal(history[0].submissions.length, 1);
  assert.equal((await f.action(reviewed, 'accept', {}, { human: true, token: null })).status, 409);
  const db = new DatabaseSync(f.file); t.after(() => db.close());
  assert.equal(db.prepare('SELECT lease_hash FROM executions WHERE id=?').get(run.id).lease_hash, null);
});


test('reference client connects to the API and propagates unauthorized failures', async t => {
  const f = await fixture(t); const run = await f.prepare();
  const execute = promisify(execFile);
  const env = { ...process.env, PLANIFIKATEUR_URL: f.bases[0], PLANIFIKATEUR_AGENT_TOKEN: f.credentials.token };
  const { stdout } = await execute(process.execPath, ['scripts/agent-client.mjs', 'queue', f.project.id], { env });
  const data = JSON.parse(stdout).data; assert.equal(data[0].id, run.id);
  const history = await execute(process.execPath, ['scripts/agent-client.mjs', 'history', f.project.id, f.card.id], { env });
  assert.equal(JSON.parse(history.stdout).data[0].state, 'ready');
  await assert.rejects(execute(process.execPath, ['scripts/agent-client.mjs', 'queue', f.project.id], { env: { ...env, PLANIFIKATEUR_AGENT_TOKEN: 'invalid-token' } }), error => error.code === 1 && error.stderr.includes('401') && !error.stderr.includes('invalid-token'));
});

test('preparation derives the complete request from the saved card and cannot override it with duplicate fields', async t => {
  const f = await fixture(t), current = f.store.read().projects[0].cards[0];
  const response = await f.request(f.path, { method: 'POST', human: true, data: { objective: 'Injected objective', criteria: 'Injected criteria', context: 'Injected context' } });
  assert.equal(response.status, 201); const run = (await response.json()).data;
  assert.equal(run.requestSource, 'card'); assert.equal(run.objective, current.description);
  assert.equal(run.criteria, current.checklist.map(c => c.text).join('\n'));
  assert.equal(run.context, ''); assert.deepEqual(run.cardSnapshot.checklist, current.checklist);
  assert.equal(f.store.read().projects[0].cards[0].description, current.description);
});

test('preparation requires a saved description and criteria in the card itself', async t => {
  const f = await fixture(t); let snapshot = f.store.read();
  snapshot.projects[0].cards[0].description = ''; f.store.write(snapshot.projects, snapshot.revision, f.user);
  const data = { objective: 'Duplicate cannot replace the description', criteria: 'Duplicate cannot replace criteria' };
  assert.equal((await f.request(f.path, { method: 'POST', human: true, data })).status, 400);
  snapshot = f.store.read(); snapshot.projects[0].cards[0].description = 'Actual request'; snapshot.projects[0].cards[0].checklist = []; f.store.write(snapshot.projects, snapshot.revision, f.user);
  const response = await f.request(f.path, { method: 'POST', human: true, data });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'missing_criteria');
  assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
});

test('legacy execution requests remain intact when opening an existing database', async t => {
  const f = await fixture(t), prepared = await f.prepare(), db = new DatabaseSync(f.file);
  t.after(() => db.close());
  const legacy = JSON.parse(db.prepare('SELECT data FROM executions WHERE id=?').get(prepared.id).data);
  delete legacy.requestSource; legacy.objective = 'Objectif historique'; legacy.criteria = 'Critères historiques'; legacy.context = 'Contraintes historiques';
  db.prepare('UPDATE executions SET data=? WHERE id=?').run(JSON.stringify(legacy), prepared.id);
  const reopened = createStore(f.file); t.after(() => reopened.close());
  const run = reopened.workflows.list(f.project.id, f.card.id)[0];
  assert.equal(run.objective, 'Objectif historique'); assert.equal(run.criteria, 'Critères historiques'); assert.equal(run.context, 'Contraintes historiques');
});
