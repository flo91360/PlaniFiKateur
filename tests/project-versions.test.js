import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { createVersionSync, tagPushVersion } from '../server/project-versions.js';
import { withInfos } from '../src/lib/infos.js';

const secret = 'tag-webhook-test', date = '2026-10-12T07:32:00Z';
function fixture(t) {
  const store = createStore(':memory:'); t.after(() => store.close());
  const [first, second] = store.read().projects;
  store.workflows.configureGithub(first.id, 'owner/first', { id: 'github', name: 'GitHub' });
  store.workflows.configureGithub(second.id, 'owner/second', { id: 'github', name: 'GitHub' });
  store.refreshInfos();
  return { store, first, second };
}
const card = (store, project) => store.read().projects.find(p => p.id === project.id).cards.find(c => c.id === `${project.id}-git-version`);

test('a signed tag push updates only its repository projects, preserves discussion and rejects stale deliveries', async t => {
  const { store, first, second } = fixture(t);
  const snapshot = store.read();
  snapshot.projects[0].lists.find(l => l.id === `${first.id}-infos`).name = 'Info';
  snapshot.projects[0].cards.find(c => c.id === `${first.id}-git-version`).comments.push({ id: 'discussion', author: 'Florian', text: 'Conserver', date });
  store.write(snapshot.projects, snapshot.revision);
  const server = createAppServer({ store, config: { githubWebhookSecret: secret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const payload = { ref: 'refs/tags/v2.0.0', deleted: false, repository: { full_name: 'OWNER/FIRST', pushed_at: Date.parse(date) / 1000 }, head_commit: { timestamp: '2020-01-01T00:00:00Z' } };
  const post = async (data, signing = secret) => {
    const raw = JSON.stringify(data);
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/github/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signing).update(raw).digest('hex') }, body: raw });
  };
  assert.equal((await post(payload, 'incorrect')).status, 401);
  const revision = store.getRevision();
  assert.equal((await post(payload)).status, 200);
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.match(card(store, first).description, /12 octobre 2026 à 09:32/);
  assert.ok(!card(store, first).description.includes('2020'));
  assert.equal(card(store, first).comments.length, 1);
  assert.equal(card(store, first).status, 'done');
  assert.equal(card(store, second).title, 'Version en cours de récupération');
  assert.equal(store.getRevision(), revision + 1);
  await post(payload); assert.equal(store.getRevision(), revision + 1);
  await post({ ...payload, ref: 'refs/tags/v1.0.0', repository: { ...payload.repository, pushed_at: Date.parse(date) / 1000 - 60 } });
  assert.equal(card(store, first).title, 'v2.0.0');
  await post({ ...payload, ref: 'refs/heads/main' });
  await post({ ...payload, deleted: true });
  await post({ ...payload, repository: { full_name: 'owner/unconfigured', pushed_at: Date.parse(date) / 1000 } });
  assert.equal(store.getRevision(), revision + 1);
});

test('GitHub synchronization recovers publication dates and never substitutes commit dates for missing history', async t => {
  const { store, first, second } = fixture(t);
  const calls = [];
  const sync = createVersionSync(store, { start: false, token: 'private-token', transport: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/tags?')) return Response.json([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]);
    if (url.includes('/first/')) return Response.json([{ type: 'CreateEvent', created_at: date, payload: { ref_type: 'tag', ref: 'v2.0.0' } }]);
    return Response.json([]);
  } });
  t.after(() => sync.close());
  await sync.refresh();
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.match(card(store, first).description, /09:32/);
  assert.equal(card(store, second).title, 'v1.0.0');
  assert.match(card(store, second).description, /Date de push du tag indisponible/);
  assert.ok(calls.every(c => new URL(c.url).origin === 'https://api.github.com' && c.options.redirect === 'error'));
  assert.deepEqual(withInfos(store.read().projects[0]), store.read().projects[0]);
});

test('publication metadata survives restart-style refreshes, stale API results and a temporary GitHub failure', async t => {
  const { store, first } = fixture(t);
  store.recordGithubVersion('owner/first', { tag: 'v2.0.0', date });
  const snapshot = store.read();
  store.refreshInfos(); assert.deepEqual(store.read(), snapshot);
  const sync = createVersionSync(store, { start: false, transport: async () => { throw new TypeError('Network unavailable'); } });
  t.after(() => sync.close()); await sync.refresh();
  assert.deepEqual(store.read(), snapshot);
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.deepEqual(store.recordGithubVersion('owner/first', { tag: 'v1.0.0', date: '' }), { updated: false });
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.equal(tagPushVersion({ ref: 'refs/tags/v3', repository: { full_name: 'owner/first' }, head_commit: { timestamp: date } }).version.date, '');
});

test('the repository tag and exact push timestamp survive a server restart without another GitHub request', t => {
  const directory = mkdtempSync(join(tmpdir(), 'planifikateur-tags-'));
  const filename = join(directory, 'workspace.sqlite');
  let store = createStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = store.read().projects[0];
  store.workflows.configureGithub(project.id, 'owner/first', { id: 'github', name: 'GitHub' });
  store.recordGithubVersion('owner/first', { tag: 'v2.0.0', date });
  const snapshot = store.read();
  store.close(); store = createStore(filename);
  assert.deepEqual(store.read(), snapshot);
  assert.deepEqual(store.githubVersion('owner/first'), { tag: 'v2.0.0', date });
});
