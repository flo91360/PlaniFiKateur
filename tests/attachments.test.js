import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { createStore } from '../server/store.js';
import { prepareAttachments, createCodexRunner } from '../worker/codex.mjs';

const attachment = () => ({ id: 'attachment-test', name: 'bug.txt', type: 'text/plain', size: 3, data: 'YnVn' });
test('attachments survive SQLite persistence and are attributed as card changes', () => {
  const store = createStore(':memory:');
  try {
    const snapshot = store.read();
    snapshot.projects[0].cards[0].attachments = [attachment()];
    store.write(snapshot.projects, snapshot.revision, { id: 'author', name: 'Auteur' });
    assert.deepEqual(store.read().projects[0].cards[0].attachments, [attachment()]);
    assert.ok(store.activity().some(e => e.action === 'card.updated' && e.details.fields.includes('attachments')));
    const next = store.read();
    next.projects[0].cards[0].attachments = [];
    store.write(next.projects, next.revision);
    assert.deepEqual(store.read().projects[0].cards[0].attachments, []);
  } finally {
    store.close();
  }
});
test('attachment validation rejects malformed contents, unsafe names and size/count limits', () => {
  const clean = () => structuredClone(seed);
  for (const bad of [
    { data: '!!!!' },
    { size: 4 },
    { name: '../file' },
    { type: 'text/html;script' },
    { size: 1048577 },
    { data: 'Yg==', size: 3 },
  ]) {
    const projects = clean();
    projects[0].cards[0].attachments = [{ ...attachment(), ...bad }];
    assert.throws(() => validateWorkspace(projects));
  }
  const projects = clean();
  projects[0].cards[0].attachments = Array.from({ length: 11 }, (_, i) => ({ ...attachment(), id: `file-${i}` }));
  assert.throws(() => validateWorkspace(projects));
  const full = Buffer.alloc(1024 * 1024).toString('base64');
  projects[0].cards[0].attachments = Array.from({ length: 3 }, (_, i) => ({
    ...attachment(),
    id: `file-${i}`,
    size: 1024 * 1024,
    data: full,
  }));
  assert.throws(() => validateWorkspace(projects), /2 Mo/);
  assert.deepEqual(validateWorkspace(clean())[0].cards[0].attachments, []);
});
test('worker materializes bytes safely, removes stale files and sends images to Codex', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-attachments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = {
    cardSnapshot: { title: 'Bug', attachments: [{ ...attachment(), name: '../capture.png', type: 'image/png' }] },
    objective: 'Corriger',
    exchanges: [],
    submissions: [],
    updates: [],
  };
  const files = await prepareAttachments(run, root);
  assert.equal(await readFile(files[0].path, 'utf8'), 'bug');
  assert.equal(files[0].path.startsWith(join(root, '.planifikateur', 'attachments') + '/'), true);
  let input;
  class Codex {
    startThread() {
      return {
        runStreamed: async prompt => {
          input = prompt;
          return {
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: '{"status":"result","summary":"Corrigé","question":""}' },
              };
              yield { type: 'turn.completed' };
            })(),
          };
        },
      };
    }
  }
  await createCodexRunner({ codexHome: join(root, 'codex') }, { Codex }).run({
    run,
    job: {},
    cwd: root,
    onThread() {},
  });
  assert.equal(input[1].type, 'local_image');
  assert.equal(await readFile(input[1].path, 'utf8'), 'bug');
  assert.match(input[0].text, /Pièces jointes/);
  await prepareAttachments({ cardSnapshot: {} }, root);
  await assert.rejects(readdir(join(root, '.planifikateur', 'attachments')), { code: 'ENOENT' });
});

test('execution snapshots include attachments and changing a file cancels the obsolete request', () => {
  const store = createStore(':memory:');
  const actor = { id: 'author', name: 'Auteur' };
  try {
    const snapshot = store.read(),
      project = snapshot.projects[0],
      card = project.cards[0];
    card.attachments = [attachment()];
    store.write(snapshot.projects, snapshot.revision, actor);
    store.workflows.configureGithub(project.id, 'owner/repository', actor);
    const run = store.workflows.prepare(project.id, card.id, {}, actor);
    assert.deepEqual(run.cardSnapshot.attachments, [attachment()]);
    const next = store.read();
    next.projects[0].cards[0].attachments[0].data = 'bmV3';
    store.write(next.projects, next.revision, actor);
    assert.equal(store.workflows.list(project.id, card.id)[0].state, 'cancelled');
    assert.equal(store.read().projects[0].cards[0].status, 'draft');
  } finally {
    store.close();
  }
});
