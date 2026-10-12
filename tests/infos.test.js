import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInfos } from '../src/lib/infos.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { seed } from '../src/data/demo.js';
import { createStore } from '../server/store.js';
import { readBuildInfo } from '../server/build-info.js';

const version = { tag: 'v1.2.3', date: '2026-10-11T12:00:00+00:00' };
test('Infos reuses an existing list and updates a single version card without losing its comments', () => {
  const project = { id: 'project', lists: [{ id: 'custom', name: 'Infos', color: 'green' }], cards: [] };
  const first = withInfos(project, version);
  assert.equal(first.lists.length, 1);
  assert.equal(first.cards[0].listId, 'custom');
  assert.equal(first.cards[0].title, version.tag);
  assert.match(first.cards[0].description, /Publiée le 11 octobre 2026 à 14:00/);
  first.cards[0].comments.push({ id: 'comment', text: 'Conserver' });
  const next = withInfos(first, { ...version, tag: 'v1.2.4' });
  assert.equal(next.cards.length, 2);
  assert.equal(next.cards[0].title, 'v1.2.4');
  assert.deepEqual(next.cards[0].comments, first.cards[0].comments);
  assert.deepEqual(withInfos(next, { ...version, tag: 'v1.2.4' }), next);
});

test('Infos links the README of the associated repository and keeps it on navigator refreshes', () => {
  const project = { id: 'project', lists: [], cards: [] };
  const empty = withInfos(project);
  assert.equal(empty.cards[1].id, 'project-readme');
  assert.equal(empty.cards[1].readme, undefined);
  const linked = withInfos(empty, { ...version, repository: 'owner/repo' });
  assert.equal(linked.cards.length, 2);
  assert.equal(linked.cards[1].readme, 'owner/repo');
  assert.match(linked.cards[1].description, /https:\/\/github\.com\/owner\/repo#readme/);
  assert.deepEqual(validateWorkspace([{ ...linked, name: 'P', description: '', emoji: '◈', color: '#fff' }])[0].cards, linked.cards.map(card => ({ ...card, createdBy: null, createdAt: null, updatedBy: null, updatedAt: null, attachments: [] })));
  assert.deepEqual(withInfos(linked), linked);
  assert.equal(withInfos(linked, { tag: 'Aucun tag disponible', date: '' }).cards[1].readme, undefined);
  assert.throws(() => validateWorkspace([{ ...linked, name: 'P', description: '', emoji: '◈', color: '#fff', cards: [{ ...linked.cards[1], readme: 'evil.com/x/../y' }] }]), /mode d’emploi/);
});

test('existing databases receive Infos once and retain their other cards on restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'planifikateur-infos-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'workspace.sqlite');
  let store = createStore(file);
  try {
    const legacy = validateWorkspace(structuredClone(seed).map(project => ({ ...project, lists: project.lists.filter(list => list.name !== 'Infos'), cards: project.cards.filter(card => ![`${project.id}-git-version`, `${project.id}-readme`].includes(card.id)) })));
    store.write(legacy, store.getRevision());
    const previousRevision = store.getRevision();
    store.close(); store = createStore(file);
    const snapshot = store.read();
    assert.equal(snapshot.revision, previousRevision + 1);
    for (const project of snapshot.projects) {
      const before = legacy.find(item => item.id === project.id);
      assert.equal(project.lists.length, before.lists.length + 1);
      assert.equal(project.cards.length, before.cards.length + 2);
      assert.equal(project.cards.at(-2).title, 'Aucun tag disponible');
      assert.match(project.cards.at(-2).description, /Associez un dépôt GitHub/);
      assert.equal(project.cards.at(-1).title, 'Mode d’emploi du projet');
      assert.deepEqual(project.cards.slice(0, -2), before.cards);
    }
    store.close(); store = createStore(file);
    assert.deepEqual(store.read(), snapshot);
  } finally { store.close(); }
});

test('build info uses an exact Git tag or the commit identifier and includes its timestamp', () => {
  const cwd = new URL('../', import.meta.url);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tags = git(['tag', '--points-at', 'HEAD']).split('\n').filter(Boolean);
  const info = readBuildInfo();
  if (tags.length) assert.ok(tags.includes(info.tag));
  else assert.equal(info.tag, git(['rev-parse', '--short', 'HEAD']));
  assert.equal(info.date, git(['show', '-s', '--format=%cI', 'HEAD']));
  assert.ok(Number.isFinite(Date.parse(info.date)));
});
