import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { createVersionSync, latestTag, releaseVersion, tagPushVersion } from '../server/project-versions.js';
import { withInfos } from '../src/lib/infos.js';
import { driveReleaseBody } from '../src/lib/drive-release.js';

const secret = 'tag-webhook-test',
  date = '2026-10-12T07:32:00Z';
function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const [first, second] = store.read().projects;
  store.workflows.configureGithub(first.id, 'owner/first', { id: 'github', name: 'GitHub' });
  store.workflows.configureGithub(second.id, 'owner/second', { id: 'github', name: 'GitHub' });
  store.refreshInfos();
  return { store, first, second };
}
const card = (store, project) =>
  store
    .read()
    .projects.find(p => p.id === project.id)
    .cards.find(c => c.id === `${project.id}-git-version`);
const driveDownload = {
  repository: 'owner/first',
  version: 'v2.0.0',
  commit: 'a'.repeat(40),
  folderId: 'drive-version-folder',
  files: [{ id: 'drive-executable-id', name: 'Product.exe', size: 120, md5: 'b'.repeat(32) }],
};

test('signed release events publish downloads for the matching repository/version without inventing a tag push date', async t => {
  const { store, first, second } = fixture(t);
  store.recordGithubVersion('owner/first', { tag: 'v2.0.0', date: '' });
  const server = createAppServer({ store, config: { githubWebhookSecret: secret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const event = {
    action: 'edited',
    repository: { full_name: 'owner/first' },
    release: {
      draft: false,
      tag_name: 'v2.0.0',
      published_at: date,
      body: driveReleaseBody('Release notes', driveDownload),
    },
  };
  const send = async (data, signing = secret) => {
    const raw = JSON.stringify(data);
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'release',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signing).update(raw).digest('hex'),
      },
      body: raw,
    });
  };
  assert.equal((await send(event, 'wrong')).status, 401);
  assert.equal(card(store, first).downloads, undefined);
  assert.equal((await send(event)).status, 200);
  assert.deepEqual(card(store, first).downloads, driveDownload);
  assert.equal(card(store, second).downloads, undefined);
  assert.match(card(store, first).description, /Date de publication indisponible/);
  const snapshot = store.read();
  await send(event);
  store.refreshInfos();
  assert.deepEqual(store.read(), snapshot);
  await send({
    ...event,
    release: { ...event.release, body: driveReleaseBody('', { ...driveDownload, commit: 'c'.repeat(40) }) },
  });
  assert.deepEqual(card(store, first).downloads, driveDownload);
  const editedSnapshot = store.read();
  await send({ ...event, repository: { full_name: 'owner/second' } });
  assert.deepEqual(
    card(store, first),
    editedSnapshot.projects.find(p => p.id === first.id).cards.find(c => c.id === `${first.id}-git-version`),
  );
  assert.equal(card(store, second).downloads, undefined);
  store.recordGithubVersion('owner/first', { tag: 'v3.0.0', date });
  assert.equal(card(store, first).downloads, undefined);
});

test('download links are recovered by polling, survive outages and remain unchanged across a server restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-drive-links-')),
    file = join(dir, 'store.sqlite');
  let store = createStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.read().projects[0];
  store.workflows.configureGithub(project.id, 'owner/first', { id: 'github', name: 'GitHub' });
  const sync = createVersionSync(store, {
    start: false,
    transport: async url => {
      if (url.includes('/tags?')) return Response.json([{ name: 'v2.0.0' }]);
      if (url.includes('/events?')) return Response.json([]);
      return Response.json({ draft: false, body: driveReleaseBody('', driveDownload) });
    },
  });
  await sync.refresh();
  sync.close();
  assert.deepEqual(card(store, project).downloads, driveDownload);
  const snapshot = store.read();
  store.close();
  store = createStore(file);
  assert.deepEqual(store.read(), snapshot);
  const outage = createVersionSync(store, {
    start: false,
    transport: async () => {
      throw new Error('offline');
    },
  });
  await outage.refresh();
  outage.close();
  assert.deepEqual(store.read(), snapshot);
});

test('a signed tag push updates only its repository projects, preserves discussion and rejects stale deliveries', async t => {
  const { store, first, second } = fixture(t);
  const snapshot = store.read();
  snapshot.projects[0].lists.find(l => l.id === `${first.id}-infos`).name = 'Info';
  snapshot.projects[0].cards
    .find(c => c.id === `${first.id}-git-version`)
    .comments.push({ id: 'discussion', author: 'Florian', text: 'Conserver', date });
  store.write(snapshot.projects, snapshot.revision);
  const server = createAppServer({ store, config: { githubWebhookSecret: secret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const payload = {
    ref: 'refs/tags/v2.0.0',
    deleted: false,
    repository: { full_name: 'OWNER/FIRST', pushed_at: Date.parse(date) / 1000 },
    head_commit: { timestamp: '2020-01-01T00:00:00Z' },
  };
  const post = async (data, signing = secret) => {
    const raw = JSON.stringify(data);
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signing).update(raw).digest('hex'),
      },
      body: raw,
    });
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
  await post(payload);
  assert.equal(store.getRevision(), revision + 1);
  await post({
    ...payload,
    ref: 'refs/tags/v1.0.0',
    repository: { ...payload.repository, pushed_at: Date.parse(date) / 1000 - 60 },
  });
  assert.equal(card(store, first).title, 'v2.0.0');
  await post({ ...payload, ref: 'refs/heads/main' });
  await post({ ...payload, deleted: true });
  await post({ ...payload, repository: { full_name: 'owner/unconfigured', pushed_at: Date.parse(date) / 1000 } });
  assert.equal(store.getRevision(), revision + 1);
});

test('GitHub synchronization recovers publication dates and never substitutes commit dates for missing history', async t => {
  const { store, first, second } = fixture(t);
  const calls = [];
  const sync = createVersionSync(store, {
    start: false,
    token: 'private-token',
    transport: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/tags?')) return Response.json([{ name: 'v1.0.0' }, { name: 'v2.0.0' }]);
      if (url.includes('/first/'))
        return Response.json([{ type: 'CreateEvent', created_at: date, payload: { ref_type: 'tag', ref: 'v2.0.0' } }]);
      return Response.json([]);
    },
  });
  t.after(() => sync.close());
  await sync.refresh();
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.match(card(store, first).description, /09:32/);
  assert.equal(card(store, second).title, 'v2.0.0');
  assert.match(card(store, second).description, /Date de publication indisponible/);
  assert.ok(calls.every(c => new URL(c.url).origin === 'https://api.github.com' && c.options.redirect === 'error'));
  assert.deepEqual(withInfos(store.read().projects[0]), store.read().projects[0]);
});

test('publication metadata survives restart-style refreshes, stale API results and a temporary GitHub failure', async t => {
  const { store, first } = fixture(t);
  store.recordGithubVersion('owner/first', { tag: 'v2.0.0', date });
  const snapshot = store.read();
  store.refreshInfos();
  assert.deepEqual(store.read(), snapshot);
  const sync = createVersionSync(store, {
    start: false,
    transport: async () => {
      throw new TypeError('Network unavailable');
    },
  });
  t.after(() => sync.close());
  await sync.refresh();
  assert.deepEqual(store.read(), snapshot);
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.deepEqual(store.recordGithubVersion('owner/first', { tag: 'v1.0.0', date: '' }), { updated: false });
  assert.equal(card(store, first).title, 'v2.0.0');
  assert.equal(
    tagPushVersion({ ref: 'refs/tags/v3', repository: { full_name: 'owner/first' }, head_commit: { timestamp: date } })
      .version.date,
    '',
  );
});

test('the repository tag and exact push timestamp survive a server restart without another GitHub request', t => {
  const directory = mkdtempSync(join(tmpdir(), 'planifikateur-tags-'));
  const filename = join(directory, 'workspace.sqlite');
  let store = createStore(filename);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const project = store.read().projects[0];
  store.workflows.configureGithub(project.id, 'owner/first', { id: 'github', name: 'GitHub' });
  store.recordGithubVersion('owner/first', { tag: 'v2.0.0', date });
  const snapshot = store.read();
  store.close();
  store = createStore(filename);
  assert.deepEqual(store.read(), snapshot);
  assert.deepEqual(store.githubVersion('owner/first'), { tag: 'v2.0.0', date });
});

test('a tag created by a GitHub Release takes the Release publication date, by polling or signed webhook', async t => {
  const { store, first, second } = fixture(t);
  const releaseDate = '2026-10-12T08:15:00Z';
  const sync = createVersionSync(store, {
    start: false,
    transport: async url => {
      if (url.includes('/tags?')) return Response.json([{ name: 'v0.7.2' }]);
      if (url.includes('/events?')) return Response.json([]);
      if (url.includes('/first/releases/tags/v0.7.2'))
        return Response.json({ draft: false, tag_name: 'v0.7.2', published_at: releaseDate, body: '' });
      return new Response('{}', { status: 404 });
    },
  });
  t.after(() => sync.close());
  await sync.refresh();
  assert.equal(card(store, first).title, 'v0.7.2');
  assert.match(card(store, first).description, /Publiée le 12 octobre 2026 à 10:15/);
  assert.match(card(store, second).description, /Date de publication indisponible/);

  const server = createAppServer({ store, config: { githubWebhookSecret: secret } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const send = async data => {
    const raw = JSON.stringify(data);
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'release',
        'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });
  };
  const event = {
    action: 'published',
    repository: { full_name: 'owner/first' },
    release: { draft: false, tag_name: 'v0.7.3', published_at: '2026-10-13T06:00:00Z', body: 'Notes' },
  };
  await send({ ...event, release: { ...event.release, draft: true } });
  await send({ ...event, action: 'edited' });
  assert.equal(card(store, first).title, 'v0.7.2');
  assert.deepEqual((await (await send(event)).json()).data, { updated: true });
  assert.equal(card(store, first).title, 'v0.7.3');
  assert.match(card(store, first).description, /Publiée le 13 octobre 2026 à 08:00/);
  await send({ ...event, release: { ...event.release, tag_name: 'v0.7.1', published_at: '2026-10-01T06:00:00Z' } });
  assert.equal(card(store, first).title, 'v0.7.3');
  assert.equal(releaseVersion({ ...event, release: { ...event.release, published_at: null } }), null);
});

test('without a creation event the highest version tag is chosen, not the first listed by name', () => {
  assert.equal(
    latestTag([{ name: 'v0.1.9' }, { name: 'v0.1.16' }, { name: 'v0.1.10' }, { name: 'nightly' }]),
    'v0.1.16',
  );
  assert.equal(latestTag([{ name: 'v2.0.0' }, { name: '10.0.0' }]), '10.0.0');
  assert.equal(latestTag([{ name: 'nightly' }, { name: 'beta' }]), 'nightly');
});

test('Changelog recovers historical release notes, updates without duplicates and survives outages', async t => {
  const { store, first } = fixture(t);
  let releases = [
    { tag_name: 'v2.0.0', published_at: date, body: 'Nouvelle interface' },
    { tag_name: 'v1.0.0', published_at: '2026-10-01T10:00:00Z', body: 'Première version' },
    { tag_name: 'v3.0.0', published_at: date, body: 'Secret', draft: true },
  ];
  const sync = createVersionSync(store, {
    start: false,
    transport: async url => {
      if (url.includes('/releases?')) {
        if (!releases) throw new Error('offline');
        return { ok: true, json: async () => releases };
      }
      return { ok: true, json: async () => (url.includes('/tags?') ? [{ name: 'v2.0.0' }] : []) };
    },
  });
  t.after(() => sync.close());
  const changelog = () =>
    store
      .read()
      .projects.find(p => p.id === first.id)
      .cards.find(c => c.id === `${first.id}-changelog`);
  await sync.refresh();
  assert.match(changelog().description, /v2.0.0.*\nNouvelle interface\n\nv1.0.0.*\nPremière version/);
  assert.doesNotMatch(changelog().description, /Secret/);
  releases[0].body = 'Interface améliorée';
  await sync.refresh();
  assert.match(changelog().description, /Interface améliorée/);
  assert.equal(changelog().description.split('v2.0.0').length, 2);
  const snapshot = store.read();
  releases = null;
  await sync.refresh();
  assert.deepEqual(store.read(), snapshot);
  assert.deepEqual(
    withInfos(store.read().projects.find(p => p.id === first.id)),
    store.read().projects.find(p => p.id === first.id),
  );
});

test('a local failure while refreshing versions is reported instead of crashing the server', async () => {
  const errors = [];
  const broken = {
    refreshInfos() {
      throw new Error('base indisponible');
    },
  };
  const sync = createVersionSync(broken, { start: false, onError: message => errors.push(message) });
  await sync.refresh();
  sync.close();
  assert.match(errors[0], /versions GitHub impossible \(base indisponible\)/);
});
