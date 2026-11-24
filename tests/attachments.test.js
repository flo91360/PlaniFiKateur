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
test('attachment quota applies per card and per project, not across all projects', () => {
  const projects = structuredClone(seed);
  assert.ok(projects.length >= 2 && projects.every(project => project.cards.length));
  const full = Buffer.alloc(1024 * 1024).toString('base64');
  const files = (prefix, count) =>
    Array.from({ length: count }, (_, i) => ({ ...attachment(), id: `${prefix}-${i}`, size: 1024 * 1024, data: full }));
  // 2 Mo dans une carte de chaque projet : un projet chargé ne bloque plus les autres.
  for (const project of projects) project.cards[0].attachments = files(`file-${project.id}`, 2);
  assert.equal(validateWorkspace(projects).length, projects.length);
  // Au-delà de 20 Mo dans un même projet, la modification est refusée.
  const [project] = projects;
  const template = project.cards[0];
  project.cards = Array.from({ length: 11 }, (_, i) => ({
    ...structuredClone(template),
    id: `quota-card-${i}`,
    checklist: [],
    comments: [],
    attachments: files(`quota-${i}`, 2),
  }));
  assert.throws(() => validateWorkspace(projects), /20 Mo/);
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
    // Le contenu d’une pièce jointe ne change pas sous le même identifiant.
    const next = store.read();
    next.projects[0].cards[0].attachments[0] = { ...next.projects[0].cards[0].attachments[0], data: 'bmV3', size: 3 };
    assert.throws(
      () => store.write(next.projects, next.revision, actor),
      error => error.status === 400 && /nouvelle pièce jointe/.test(error.message),
    );
    assert.equal(store.workflows.list(project.id, card.id)[0].state, 'ready');
    // Remplacer le fichier (nouvel identifiant) annule la demande devenue obsolète.
    next.projects[0].cards[0].attachments[0].id = 'replaced-file';
    store.write(next.projects, next.revision, actor);
    assert.equal(store.workflows.list(project.id, card.id)[0].state, 'cancelled');
    assert.equal(store.read().projects[0].cards[0].status, 'draft');
  } finally {
    store.close();
  }
});

test('renaming a card in a project with 20 MB of attachments neither reads nor rewrites their content', () => {
  const store = createStore(':memory:');
  const actor = { id: 'author', name: 'Auteur' };
  try {
    const snapshot = store.read(),
      project = snapshot.projects[0];
    const megabyte = Buffer.alloc(1000000, 7).toString('base64');
    project.cards = Array.from({ length: 20 }, (_, index) => ({
      ...project.cards[0],
      id: `heavy-${index}`,
      title: `Carte ${index}`,
      comments: [],
      checklist: [],
      attachments: [
        {
          id: `heavy-file-${index}`,
          name: 'gros.bin',
          type: 'application/octet-stream',
          size: 1000000,
          data: megabyte,
        },
      ],
    }));
    store.write(snapshot.projects, snapshot.revision, actor);
    const durations = [];
    for (let round = 0; round < 5; round++) {
      const started = performance.now();
      store.change(
        [{ type: 'card.update', projectId: project.id, cardId: 'heavy-3', fields: { title: `Renommée ${round}` } }],
        actor,
        { strict: true, attachmentData: false, scope: 'changed' },
      );
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    assert.ok(durations[2] < 150, `Renommage en ${durations[2].toFixed(1)} ms`);
    // Le contenu reste intact, et une pièce jointe déjà connue renvoyée sans contenu le garde.
    store.change(
      [
        {
          type: 'card.update',
          projectId: project.id,
          cardId: 'heavy-3',
          fields: {
            attachments: [{ id: 'heavy-file-3', name: 'renommé.bin', type: 'application/octet-stream', size: 1000000 }],
          },
        },
      ],
      actor,
      { strict: true },
    );
    const card = store.read().projects[0].cards.find(item => item.id === 'heavy-3');
    assert.equal(card.title, 'Renommée 4');
    assert.equal(card.attachments[0].name, 'renommé.bin');
    assert.equal(card.attachments[0].data, megabyte);
    // Une nouvelle pièce jointe sans contenu est refusée.
    assert.throws(
      () =>
        store.change(
          [
            {
              type: 'attachment.create',
              projectId: project.id,
              cardId: 'heavy-4',
              attachment: { id: 'without-data', name: 'vide.txt', type: 'text/plain', size: 3 },
            },
          ],
          actor,
          { strict: true },
        ),
      error => error.status === 400 && /attachment\.data/.test(error.message),
    );
  } finally {
    store.close();
  }
});
