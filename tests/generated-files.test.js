import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGeneratedFile, collectOutputs } from '../worker/outputs.mjs';
import { createCodexRunner } from '../worker/codex.mjs';
import { createStore } from '../server/store.js';

test('generated files are confined to real files inside the checkout and keep deterministic identifiers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-outputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.planifikateur', 'generated'), { recursive: true });
  await writeFile(join(root, '.planifikateur', 'generated', 'form.ui'), '<ui/>');
  const paths = ['.planifikateur/generated/form.ui'];
  const [file] = await collectOutputs(root, paths, 'execution');
  assert.equal(file.name, 'form.ui');
  assert.equal(file.type, 'application/xml');
  assert.equal(Buffer.from(file.data, 'base64').toString(), '<ui/>');
  assert.deepEqual(await collectOutputs(root, paths, 'execution'), [file]);
  for (const invalid of [
    '/etc/passwd',
    '../outside',
    '.git/config',
    '.planifikateur/home/auth.json',
    '.planifikateur/attachments/input.ui',
    'C:\\file.ui',
  ])
    await assert.rejects(collectOutputs(root, [invalid], 'execution'));
  await symlink(join(root, '.planifikateur', 'generated', 'form.ui'), join(root, 'alias.ui'));
  await assert.rejects(collectOutputs(root, ['alias.ui'], 'execution'), /lien symbolique/);
  await writeFile(join(root, 'oversize.ui'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(collectOutputs(root, ['oversize.ui'], 'execution'), /1 Mo/);
  await assert.rejects(collectOutputs(root, [...paths, ...paths], 'execution'), /distincts/);
});

test('a final question outside JSON is relayed verbatim, while intermediate questions never pause a successful turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planifikateur-questions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = {
    cardSnapshot: { title: 'Formulaire' },
    objective: 'Crée un formulaire',
    exchanges: [],
    submissions: [],
    updates: [],
  };
  let messages = ['Quels champs souhaitez-vous dans le formulaire ?'];
  class Codex {
    startThread() {
      return {
        runStreamed: async () => ({
          events: (async function* () {
            for (const text of messages) yield { type: 'item.completed', item: { type: 'agent_message', text } };
            yield { type: 'turn.completed' };
          })(),
        }),
      };
    }
  }
  const runner = createCodexRunner({ codexHome: join(root, 'codex') }, { Codex });
  let result = await runner.run({ run, job: {}, cwd: root, onThread() {} });
  assert.equal(result.status, 'question');
  assert.equal(result.question, messages[0]);
  messages = [
    'Pourquoi utiliser Qt ?',
    JSON.stringify({ status: 'result', summary: 'Fichier prêt.', question: '', files: [] }),
  ];
  result = await runner.run({ run, job: {}, cwd: root, onThread() {} });
  assert.equal(result.status, 'result');
  messages = [
    JSON.stringify({
      status: 'result',
      summary: 'En attente.',
      question: 'Quelle version de Qt utilisez-vous ?',
      files: [],
    }),
  ];
  result = await runner.run({ run, job: {}, cwd: root, onThread() {} });
  assert.equal(result.status, 'question');
  assert.equal(result.question, 'Quelle version de Qt utilisez-vous ?');
});

test('artifact delivery enforces the lease, workspace limits and a real file; a rejected payload changes nothing', () => {
  const store = createStore(':memory:');
  try {
    const actor = { id: 'owner', name: 'Florian' },
      project = store.read().projects[0],
      card = project.cards[0];
    store.workflows.configureGithub(project.id, 'owner/project', actor);
    const credentials = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, actor);
    const ready = store.workflows.prepare(project.id, card.id, {}, actor);
    const run = store.workflows.agentAction(
      project.id,
      card.id,
      ready.id,
      'claim',
      { version: ready.version },
      credentials.agent,
    );
    const data = {
      version: run.version,
      leaseToken: run.leaseToken,
      artifactOnly: true,
      summary: 'Fichier livré.',
      checks: 'Fichier vérifié.',
      links: [],
    };
    const snapshot = store.read();
    assert.throws(
      () =>
        store.workflows.agentAction(project.id, card.id, run.id, 'submit', { ...data, files: [] }, credentials.agent),
      error => error.code === 'invalid_delivery',
    );
    const file = {
      id: `generated-${run.id}-file`,
      name: 'form.ui',
      type: 'application/xml',
      size: 5,
      data: Buffer.from('<ui/>').toString('base64'),
    };
    assert.throws(
      () =>
        store.workflows.agentAction(
          project.id,
          card.id,
          run.id,
          'submit',
          { ...data, leaseToken: 'incorrect', files: [file] },
          credentials.agent,
        ),
      error => error.code === 'invalid_lease',
    );
    assert.throws(
      () =>
        store.workflows.agentAction(
          project.id,
          card.id,
          run.id,
          'submit',
          { ...data, files: [{ ...file, name: '../form.ui' }] },
          credentials.agent,
        ),
      error => error.code === 'invalid_files',
    );
    assert.deepEqual(store.read(), snapshot);
    const done = store.workflows.agentAction(
      project.id,
      card.id,
      run.id,
      'submit',
      { ...data, files: [file] },
      credentials.agent,
    );
    assert.equal(done.state, 'done');
    assert.equal(store.read().projects[0].cards[0].attachments[0].name, 'form.ui');
    assert.equal(
      store
        .activity()
        .some(
          event =>
            event.action === 'card.updated' &&
            event.actor.id === credentials.agent.id &&
            event.details.fields.includes('attachments'),
        ),
      true,
    );
  } finally {
    store.close();
  }
});

test('generated files are checked by type before delivery', async () => {
  const calls = [];
  const command = async args => {
    calls.push(args);
    return '';
  };
  const json = { name: 'data.json', size: 2, data: Buffer.from('{}').toString('base64') };
  assert.equal(await checkGeneratedFile(json, command), 'data.json : JSON valide');
  await assert.rejects(
    checkGeneratedFile({ ...json, data: Buffer.from('{').toString('base64') }, command),
    SyntaxError,
  );
  const form = { name: 'form.ui', size: 5, path: '.planifikateur/generated/form.ui' };
  assert.equal(await checkGeneratedFile(form, command), 'form.ui : structure XML Qt Designer vérifiée');
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][3]], ['python3', '-c', form.path]);
  await assert.rejects(
    checkGeneratedFile(form, async () => {
      throw new Error('Document Qt Designer .ui incomplet');
    }),
    /incomplet/,
  );
  assert.equal(
    await checkGeneratedFile({ name: 'notes.txt', size: 12 }, command),
    'notes.txt : fichier généré (12 octets)',
  );
  assert.equal(calls.length, 1);
});
