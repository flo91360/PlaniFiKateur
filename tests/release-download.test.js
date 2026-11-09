import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { createReleaseDownloads } from '../server/release-download.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';

const date = '2026-10-12T07:32:00Z';
const signed = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc';

// Faux GitHub : la Release v2.0.0 du dépôt privé porte l’installateur.
function github(calls, { location = signed } = {}) {
  return async (url, options) => {
    calls.push({ url, headers: options.headers, redirect: options.redirect });
    if (url === 'https://api.github.com/repos/owner/private/releases/tags/v2.0.0')
      return Response.json({ assets: [{ id: 42, name: 'Setup 2.0.0.exe' }] });
    if (url === 'https://api.github.com/repos/owner/private/releases/assets/42')
      return new Response(null, { status: 302, headers: { Location: location } });
    return new Response('{}', { status: 404 });
  };
}

async function fixture(t, downloads) {
  const store = createStore(':memory:');
  seedAccount(store);
  const project = store.read().projects[0];
  store.workflows.configureGithub(project.id, 'owner/private', { id: 'github', name: 'GitHub' });
  store.recordGithubVersion('owner/private', { tag: 'v2.0.0', date });
  store.recordGithubChangelog('owner/private', [
    {
      tag_name: 'v2.0.0',
      published_at: date,
      draft: false,
      body: '',
      assets: [{ name: 'Setup 2.0.0.exe', size: 120, state: 'uploaded' }],
    },
  ]);
  const server = createAppServer({ store, config: { releaseDownloads: downloads } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const cookie = (await loginRequest(base)).headers.get('set-cookie').split(';')[0];
  const get = (path, session = cookie) =>
    fetch(`${base}/api/v1/projects/${project.id}/releases/${path}`, {
      redirect: 'manual',
      headers: session ? { Cookie: session } : {},
    });
  return { store, project, get };
}

test('a project member downloads the .exe of a private Release through a signed GitHub redirect', async t => {
  const calls = [];
  const { store, project, get } = await fixture(
    t,
    createReleaseDownloads({ token: 'secret-token', transport: github(calls) }),
  );
  const version = store
    .read()
    .projects.find(p => p.id === project.id)
    .cards.find(c => c.id === `${project.id}-git-version`);
  assert.equal(version.release.files[0].name, 'Setup 2.0.0.exe');
  const response = await get('v2.0.0/files/Setup%202.0.0.exe');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), signed);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(JSON.stringify([...response.headers]), /secret-token/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[1].headers.Accept, 'application/octet-stream');
  assert.equal(calls[1].redirect, 'manual');
});

test('the Release download needs a session and only serves the executables of the project version', async t => {
  const calls = [];
  const { get } = await fixture(t, createReleaseDownloads({ transport: github(calls) }));
  assert.equal((await get('v2.0.0/files/Setup%202.0.0.exe', '')).status, 401);
  const unknown = await get('v2.0.0/files/Autre.exe');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'release_file_not_found');
  assert.equal((await get('v9.9.9/files/Setup%202.0.0.exe')).status, 404);
  assert.equal(calls.length, 0, 'GitHub n’est appelé qu’après les contrôles');
});

test('an unexpected GitHub answer never redirects outside GitHub', async t => {
  const { get } = await fixture(
    t,
    createReleaseDownloads({ transport: github([], { location: 'https://evil.example/Setup.exe' }) }),
  );
  const response = await get('v2.0.0/files/Setup%202.0.0.exe');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'release_unavailable');
});

// Faux GitHub : README et CHANGELOG.md bruts du dépôt privé.
function documents(calls) {
  return async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (url === 'https://api.github.com/repos/owner/private/readme') return new Response('# Produit\n\nMode d’emploi');
    if (url === 'https://api.github.com/repos/owner/private/contents/CHANGELOG.md')
      return new Response('# Changelog\n\n## 2.0.0\n- Défilement plus doux');
    return new Response('{}', { status: 404 });
  };
}

test('a project member reads the README and CHANGELOG of a private repository without GitHub access', async t => {
  const calls = [];
  const { get } = await fixture(t, createReleaseDownloads({ token: 'secret-token', transport: documents(calls) }));
  const read = path => get(`../documents/${path}`);
  const changelog = await read('changelog');
  assert.equal(changelog.status, 200);
  assert.equal(changelog.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(changelog.headers.get('cache-control'), 'private, no-store');
  assert.match(changelog.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  const page = await changelog.text();
  assert.match(page, /<h2>2\.0\.0<\/h2>\n<ul><li>Défilement plus doux<\/li><\/ul>/);
  assert.match(page, /<header><p>private<\/p><h1>Changelog<\/h1><\/header>/);
  const readme = await read('readme');
  assert.match(await readme.text(), /<h1>Produit<\/h1>\n<p>Mode d’emploi<\/p>/);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw');
  assert.equal((await get(`../documents/readme`, '')).status, 401);
  const unknown = await read('license');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'document_not_found');
  assert.equal(calls.length, 2, 'GitHub n’est appelé qu’après les contrôles');
});

test('a missing document answers 502 without exposing the GitHub answer', async t => {
  const { get } = await fixture(
    t,
    createReleaseDownloads({ transport: async () => new Response('{}', { status: 404 }) }),
  );
  const response = await get('../documents/changelog');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'document_unavailable');
});
