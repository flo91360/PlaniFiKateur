import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDrive, createDriveClient } from '../scripts/google-drive.mjs';
import { fakeDrive, root, credentials } from './helpers/fake-drive.mjs';
import { authorizeGoogle } from '../scripts/google-drive-login.mjs';
import { driveFolderId, driveReleaseBody, driveReleaseFromBody } from '../src/lib/drive-release.js';
import { bumpProjectVersion, nextProjectVersion } from '../worker/project-version.mjs';

const commit = 'a'.repeat(40),
  md5 = bytes => createHash('md5').update(bytes).digest('hex');
async function files(t, size = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-drive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'Product.exe');
  await writeFile(path, Buffer.alloc(size, 7));
  return { dir, path };
}
const input = paths => ({
  credentials,
  rootFolder: root,
  repository: 'flo91360/DefilOrdi',
  version: 'v0.7.1',
  commit,
  paths,
});

test('only HTTPS links to an existing Drive folder or its identifier are accepted', () => {
  assert.equal(driveFolderId('https://drive.google.com/drive/folders/' + root + '?usp=drive_link'), root);
  assert.equal(driveFolderId('https://drive.google.com/drive/u/0/folders/' + root), root);
  for (const value of [
    undefined,
    '',
    'https://example.com/' + root,
    'http://drive.google.com/drive/folders/' + root,
    'https://drive.google.com/file/d/' + root + '/view',
  ])
    assert.throws(() => driveFolderId(value));
});
test('publishing uses the provided root, creates project/version folders and reruns without duplicates', async t => {
  const { path } = await files(t),
    drive = fakeDrive();
  const first = await publishDrive(input([path]), drive);
  const project = [...drive.entries.values()].find(file => file.name === 'DefilOrdi');
  assert.deepEqual(project.parents, [root]);
  const version = drive.entries.get(first.folderId);
  assert.deepEqual(version.parents, [project.id]);
  assert.equal(version.name, 'v0.7.1');
  assert.equal(first.files[0].md5, md5(Buffer.alloc(3, 7)));
  assert.deepEqual(await publishDrive(input([path]), drive), first);
  assert.equal(drive.uploads, 1);
  assert.equal(drive.entries.size, 4);
  assert.equal(
    drive.calls.some(call => call.url.pathname.includes('permissions')),
    false,
  );
});
test('another commit or a changed executable cannot replace an existing version', async t => {
  const { path } = await files(t),
    drive = fakeDrive();
  const before = await publishDrive(input([path]), drive);
  await assert.rejects(publishDrive({ ...input([path]), commit: 'b'.repeat(40) }, drive), /autre commit/);
  await writeFile(path, 'changed');
  await assert.rejects(publishDrive(input([path]), drive), /Aucun exécutable n’a été remplacé/);
  assert.equal(drive.uploads, 1);
  assert.equal(drive.entries.get(before.files[0].id).md5Checksum, before.files[0].md5);
});
test('missing or unwritable destinations do not create a replacement root', async t => {
  const { path } = await files(t);
  for (const unavailable of ['absent', 'unwritable']) {
    const drive = fakeDrive();
    if (unavailable === 'absent') drive.entries.delete(root);
    else drive.entries.get(root).capabilities.canAddChildren = false;
    await assert.rejects(publishDrive(input([path]), drive));
    assert.equal(
      drive.calls.filter(call => call.request.method === 'POST' && call.url.origin.includes('www.googleapis')).length,
      0,
    );
  }
});
test('large files are streamed in multiple resumable chunks with a final checksum', async t => {
  const { path } = await files(t, 8 * 1024 * 1024 + 100),
    drive = fakeDrive();
  const result = await publishDrive(input([path]), drive);
  assert.equal(result.files[0].size, 8 * 1024 * 1024 + 100);
  const chunks = drive.calls.filter(call => call.request.method === 'PUT');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].request.body.length, 8 * 1024 * 1024);
  assert.equal(chunks[1].request.headers['Content-Range'], 'bytes 8388608-8388707/8388708');
});
test('a partial publication retains its files and resumes the missing executable', async t => {
  const { dir, path } = await files(t),
    other = join(dir, 'Portable.exe'),
    drive = fakeDrive();
  await writeFile(other, 'portable');
  await publishDrive(input([path]), drive);
  drive.options.failUpload = true;
  await assert.rejects(publishDrive(input([path, other]), drive), /commencer/);
  drive.options.failUpload = false;
  const result = await publishDrive(input([path, other]), drive);
  assert.equal(result.files.length, 2);
  assert.equal(drive.entries.size, 5);
  assert.equal(drive.uploads, 3);
});
test('the uploader rejects foreign upload destinations before sending credentials', async t => {
  const { path } = await files(t),
    drive = fakeDrive({ foreignSession: 'https://example.com/receive' });
  await assert.rejects(publishDrive(input([path]), drive), /Destination Google Drive non autorisée/);
  assert.equal(
    drive.calls.some(call => call.url.origin === 'https://example.com'),
    false,
  );
});
test('expired Google credentials are refreshed without changing the destination', async () => {
  const drive = fakeDrive({ onceUnauthorized: true });
  assert.equal(await createDriveClient(credentials, root, drive).validateRoot(), root);
  assert.equal(drive.refreshes, 2);
});
test('ambiguous project folders are rejected without uploading files', async t => {
  const { path } = await files(t),
    drive = fakeDrive();
  for (const suffix of ['one', 'two'])
    drive.entries.set(suffix, {
      id: suffix,
      name: 'DefilOrdi',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [root],
    });
  await assert.rejects(publishDrive(input([path]), drive), /Plusieurs éléments/);
  assert.equal(drive.uploads, 0);
});
test('a release body keeps its previous notes, carries the Drive link once and validates metadata', async t => {
  const { path } = await files(t),
    release = await publishDrive(input([path]), fakeDrive());
  const body = driveReleaseBody('Release notes', release);
  assert.equal(driveReleaseBody(body, release), body);
  assert.deepEqual(driveReleaseFromBody(body, 'flo91360/DefilOrdi', 'v0.7.1'), release);
  assert.equal(driveReleaseFromBody(body, 'owner/another', 'v0.7.1'), null);
  assert.equal(driveReleaseFromBody(body, 'flo91360/DefilOrdi', 'v0.7.2'), null);
});
test('personal OAuth validates the callback state and binds the code to PKCE', async () => {
  let challenge;
  const result = await authorizeGoogle(credentials, {
    onUrl: async value => {
      const auth = new URL(value);
      challenge = auth.searchParams.get('code_challenge');
      assert.equal(auth.origin, 'https://accounts.google.com');
      assert.equal(auth.searchParams.get('access_type'), 'offline');
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: 'wrong', code: 'invalid' });
      assert.equal((await fetch(callback)).status, 400);
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'test-code' });
      assert.equal((await fetch(callback)).status, 200);
    },
    transport: async (url, request) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(request.redirect, 'error');
      assert.equal(createHash('sha256').update(request.body.get('code_verifier')).digest('base64url'), challenge);
      assert.equal(request.body.get('code'), 'test-code');
      return Response.json({ refresh_token: credentials.refresh_token });
    },
  });
  assert.deepEqual(result, credentials);
});
test('denying Google consent produces a clear error and closes the callback server', async () => {
  await assert.rejects(
    authorizeGoogle(credentials, {
      onUrl: async value => {
        const auth = new URL(value),
          callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), error: 'access_denied' });
        await fetch(callback);
      },
    }),
    /connexion Google a été refusée/,
  );
});
test('project versioning is idempotent and preserves a requested higher version', async t => {
  assert.equal(nextProjectVersion('1.2.3', '1.2.3'), '1.2.4');
  assert.equal(nextProjectVersion('1.2.3', '2.0.0'), '2.0.0');
  assert.equal(nextProjectVersion('1.2.4', '1.2.4'), '1.2.5');
  assert.throws(() => nextProjectVersion('broken', '1.0.0'));
  const { dir } = await files(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' } } }),
  );
  const profile = { preset: 'defilordi', branch: 'main' },
    command = async () => '{"version":"1.2.3"}';
  assert.equal(await bumpProjectVersion(dir, profile, command), '1.2.4');
  assert.equal(await bumpProjectVersion(dir, profile, command), '1.2.4');
  assert.equal(JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8')).packages[''].version, '1.2.4');
  await writeFile(join(dir, 'project.godot'), '[application]\nconfig/version="0.1.0"\nconfig/name="FunKart"\n');
  assert.equal(
    await bumpProjectVersion(dir, { preset: 'funkart', branch: 'main' }, async () => 'config/version="0.1.0"'),
    '0.1.1',
  );
  assert.match(await readFile(join(dir, 'project.godot'), 'utf8'), /config\/name="FunKart"/);
  await mkdir(join(dir, 'empty'));
  await assert.rejects(bumpProjectVersion(join(dir, 'empty'), { preset: 'planifikateur' }), { code: 'ENOENT' });
});
