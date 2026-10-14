import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { createDriveArchive, readDriveConfig, archivableTag } from '../server/drive-archive.js';
import { fakeDrive, root, credentials } from './helpers/fake-drive.mjs';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const commit = 'a'.repeat(40),
  drive = { enabled: true, credentials, folder: root };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = (id, name, bytes, extra = {}) => ({
  id,
  name,
  size: bytes.length,
  state: 'uploaded',
  updated_at: '2026-10-12T10:00:00Z',
  digest: `sha256:${sha256(bytes)}`,
  bytes,
  ...extra,
});

async function fixture(t, releases, options = {}) {
  const served = { 'flo91360/defilordi': releases, ...options.repositories };
  const store = createStore(':memory:');
  t.after(() => store.close());
  const [first, second] = store.read().projects;
  store.workflows.configureGithub(first.id, 'flo91360/DefilOrdi', { id: 'github', name: 'GitHub' });
  const directory = await mkdtemp(join(tmpdir(), 'planifikateur-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const google = fakeDrive(),
    downloads = [],
    clock = { now: Date.parse('2026-10-12T12:00:00Z') };
  const github = async (url, request) => {
    url = new URL(url);
    assert.equal(url.origin, 'https://api.github.com');
    const [, repository, rest] = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(url.pathname) || [];
    const list = served[repository?.toLowerCase()];
    if (!list) return new Response(null, { status: 404 });
    if (rest === '/releases')
      return Response.json(
        list.map(release => ({ ...release, assets: release.assets.map(({ bytes, ...item }) => item) })),
      );
    if (rest.startsWith('/commits/')) return Response.json({ sha: commit });
    const download = /^\/releases\/assets\/(\d+)$/.exec(rest);
    if (download) {
      assert.equal(request.headers.Accept, 'application/octet-stream');
      downloads.push(Number(download[1]));
      const found = list.flatMap(release => release.assets).find(item => item.id === Number(download[1]));
      return new Response(options.served?.(found) || found.bytes);
    }
    return new Response(null, { status: 404 });
  };
  const archive = createDriveArchive(store, {
    drive: options.drive || drive,
    directory,
    transport: github,
    driveDependencies: google,
    start: false,
    now: () => clock.now,
    log: () => {},
  });
  t.after(() => archive.close());
  return { store, first, second, archive, google, downloads, clock, directory };
}
const folders = google =>
  [...google.entries.values()].filter(file => file.mimeType === 'application/vnd.google-apps.folder');
const infosCard = (store, project) =>
  store
    .read()
    .projects.find(p => p.id === project.id)
    .cards.find(c => c.id === `${project.id}-git-version`);

test('release executables are archived under <dossier>/<dépôt>/<version> once, with their link in the project infos', async t => {
  const setup = Buffer.from('setup-0.7.1'),
    portable = Buffer.from('portable-0.7.1');
  const releases = [
    {
      tag_name: 'v0.7.1',
      draft: false,
      assets: [
        asset(11, 'DefilOrdi-Installation-0.7.1.exe', setup),
        asset(12, 'DefilOrdi-Portable-0.7.1.exe', portable),
        asset(13, 'notes.zip', Buffer.from('zip')),
      ],
    },
    { tag_name: 'v0.8.0', draft: true, assets: [asset(21, 'Draft.exe', Buffer.from('draft'))] },
    { tag_name: 'nightly', draft: false, assets: [asset(31, 'Nightly.exe', Buffer.from('nightly'))] },
  ];
  const { store, first, archive, google, downloads, directory } = await fixture(t, releases);
  await archive.refresh();
  const project = folders(google).find(folder => folder.name === 'DefilOrdi'),
    version = folders(google).find(folder => folder.name === 'v0.7.1');
  assert.deepEqual(project.parents, [root]);
  assert.deepEqual(version.parents, [project.id]);
  assert.deepEqual(
    [...google.entries.values()]
      .filter(file => file.parents?.includes(version.id))
      .map(file => file.name)
      .sort(),
    ['DefilOrdi-Installation-0.7.1.exe', 'DefilOrdi-Portable-0.7.1.exe'],
  );
  assert.deepEqual(downloads, [11, 12]);
  assert.deepEqual(await readdir(directory), []);
  const status = archive.status('flo91360/DefilOrdi');
  assert.equal(status.enabled, true);
  assert.equal(status.error, '');
  assert.equal(status.releases.length, 1);
  assert.equal(status.releases[0].state, 'archived');
  assert.equal(status.releases[0].folderUrl, `https://drive.google.com/drive/folders/${version.id}`);
  store.recordGithubVersion('flo91360/DefilOrdi', { tag: 'v0.7.1', date: '' });
  assert.equal(infosCard(store, first).downloads.folderId, version.id);
  await archive.refresh();
  assert.deepEqual(downloads, [11, 12]);
  assert.equal(google.uploads, 2);
  assert.equal(archivableTag('v1.2.3'), true);
  assert.equal(archivableTag('release-1'), false);
});

test('a new project needs only its repository: its releases are archived in its own folder', async t => {
  const kart = [{ tag_name: 'v0.2.0', draft: false, assets: [asset(41, 'FunKart.exe', Buffer.from('kart'))] }];
  const { store, second, archive, google } = await fixture(t, [], { repositories: { 'flo91360/funkart': kart } });
  store.workflows.configureGithub(second.id, 'flo91360/FunKart', { id: 'github', name: 'GitHub' });
  await archive.refresh();
  const project = folders(google).find(folder => folder.name === 'FunKart'),
    version = folders(google).find(folder => folder.name === 'v0.2.0');
  assert.deepEqual(project.parents, [root]);
  assert.deepEqual(version.parents, [project.id]);
  assert.equal(archive.status('flo91360/FunKart').releases[0].state, 'archived');
  // A repository GitHub refuses is reported without blocking the others.
  store.workflows.configureGithub(second.id, 'flo91360/Missing', { id: 'github', name: 'GitHub' });
  await archive.refresh();
  assert.match(archive.status('flo91360/Missing').repositoryError, /404/);
});

test('an incomplete or corrupted download is never uploaded and is retried later', async t => {
  const bytes = Buffer.from('installer');
  const releases = [{ tag_name: 'v1.0.0', draft: false, assets: [asset(51, 'App.exe', bytes)] }];
  let serve = () => Buffer.from('tampered!');
  const { archive, google, downloads, clock } = await fixture(t, releases, { served: () => serve() });
  await archive.refresh();
  let [entry] = archive.status('flo91360/DefilOrdi').releases;
  assert.equal(entry.state, 'error');
  assert.match(entry.message, /empreinte/);
  assert.equal(google.uploads, 0);
  await archive.refresh();
  assert.equal(downloads.length, 1);
  await archive.refresh({ force: true });
  assert.equal(downloads.length, 2);
  // The manual retry counted as a second attempt: the next one waits 30 minutes.
  clock.now += 31 * 60000;
  serve = () => bytes.subarray(0, 3);
  await archive.refresh();
  [entry] = archive.status('flo91360/DefilOrdi').releases;
  assert.match(entry.message, /incomplet/);
  assert.equal(google.uploads, 0);
  clock.now += 61 * 60000;
  serve = () => bytes;
  await archive.refresh();
  assert.equal(archive.status('flo91360/DefilOrdi').releases[0].state, 'archived');
  assert.equal(google.uploads, 1);
});

test('a version rebuilt with different files keeps its archive and is reported instead of retried', async t => {
  const releases = [{ tag_name: 'v0.7.1', draft: false, assets: [asset(61, 'App.exe', Buffer.from('first build'))] }];
  const { archive, google, downloads, clock } = await fixture(t, releases);
  await archive.refresh();
  const original = [...google.entries.values()].find(file => file.name === 'App.exe');
  releases[0].assets = [asset(62, 'App.exe', Buffer.from('second build'), { updated_at: '2026-10-12T11:00:00Z' })];
  await archive.refresh();
  const [entry] = archive.status('flo91360/DefilOrdi').releases;
  assert.equal(entry.state, 'conflict');
  assert.match(entry.message, /fichier différent/);
  assert.equal([...google.entries.values()].find(file => file.name === 'App.exe').md5Checksum, original.md5Checksum);
  clock.now += 7 * 24 * 3600000;
  await archive.refresh();
  assert.deepEqual(downloads, [61, 62]);
  assert.equal(google.uploads, 1);
});

test('a Google authorization failure is reported once without marking releases as failed', async t => {
  const releases = [{ tag_name: 'v1.0.0', draft: false, assets: [asset(71, 'App.exe', Buffer.from('app'))] }];
  const { archive, google } = await fixture(t, releases);
  const transport = google.transport;
  google.transport = async (url, request) =>
    String(url).startsWith('https://oauth2.googleapis.com')
      ? new Response(null, { status: 400 })
      : transport(url, request);
  await archive.refresh();
  const status = archive.status('flo91360/DefilOrdi');
  assert.match(status.error, /Authentification Google refusée/);
  assert.deepEqual(status.releases, []);
  google.transport = transport;
  await archive.refresh();
  assert.equal(archive.status('flo91360/DefilOrdi').releases[0].state, 'archived');
});

test('the server configuration is optional and explains invalid values', () => {
  assert.deepEqual(readDriveConfig({}), { enabled: false });
  assert.match(
    readDriveConfig({ PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS: '{', PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER: root }).error,
    /JSON/,
  );
  assert.match(
    readDriveConfig({
      PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS: JSON.stringify(credentials),
      PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER: 'https://example.com/x',
    }).error,
    /FOLDER/,
  );
  assert.deepEqual(
    readDriveConfig({
      PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS: JSON.stringify(credentials),
      PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER: `https://drive.google.com/drive/folders/${root}`,
    }),
    { enabled: true, credentials, folder: `https://drive.google.com/drive/folders/${root}` },
  );
});

test('project members read the archive status and only the administrator starts an archive run', async t => {
  const releases = [{ tag_name: 'v1.0.0', draft: false, assets: [asset(81, 'App.exe', Buffer.from('app'))] }];
  const { store, first, archive, google } = await fixture(t, releases);
  seedAccount(store);
  const server = createAppServer({ store, config: { driveArchive: archive } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/projects/${first.id}/drive`)).status, 401);
  const Cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const before = await (await fetch(`${base}/api/v1/projects/${first.id}/drive`, { headers: { Cookie } })).json();
  assert.equal(before.data.enabled, true);
  assert.equal(before.data.repository, 'flo91360/DefilOrdi');
  assert.deepEqual(before.data.releases, []);
  assert.equal(
    (await fetch(`${base}/api/v1/projects/${first.id}/drive`, { method: 'POST', headers: { Cookie } })).status,
    202,
  );
  await archive.refresh();
  const after = await (await fetch(`${base}/api/v1/projects/${first.id}/drive`, { headers: { Cookie } })).json();
  assert.equal(after.data.releases[0].tag, 'v1.0.0');
  assert.equal(google.uploads, 1);
  assert.equal((await fetch(`${base}/api/v1/projects/unknown/drive`, { headers: { Cookie } })).status, 404);
});

test('a network failure names the unreachable service and cause instead of marking every release failed', async t => {
  const releases = [
    { tag_name: 'v1.0.0', draft: false, assets: [asset(91, 'App.exe', Buffer.from('app'))] },
    { tag_name: 'v1.1.0', draft: false, assets: [asset(92, 'Next.exe', Buffer.from('next'))] },
  ];
  const { archive, google } = await fixture(t, releases);
  const transport = google.transport;
  google.transport = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' }),
    });
  };
  await archive.refresh();
  const status = archive.status('flo91360/DefilOrdi');
  assert.match(
    status.error,
    /^Google injoignable depuis le serveur \(oauth2\.googleapis\.com : ENOTFOUND : getaddrinfo ENOTFOUND/,
  );
  assert.deepEqual(status.releases, []);
  google.transport = transport;
  await archive.refresh();
  assert.deepEqual(
    archive.status('flo91360/DefilOrdi').releases.map(release => release.state),
    ['archived', 'archived'],
  );
  assert.equal(archive.status('flo91360/DefilOrdi').error, '');
});
