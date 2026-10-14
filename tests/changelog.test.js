import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogEntry, recordChangelog } from '../worker/changelog.mjs';

const date = new Date('2026-10-13T22:30:00Z');
test('each delivery adds one section at the top, replaced when the same execution is delivered again', () => {
  const first = changelogEntry('', { runId: 'run-1', version: '1.0.1', date, title: 'Menu', summary: 'Menu corrigé' });
  assert.match(
    first,
    /^# Changelog\n\n.+\n\n## 1\.0\.1 — 2026-10-14\n<!-- planifikateur:run-1 -->\n\n- \*\*Menu\*\* : Menu corrigé\n$/,
  );
  const second = changelogEntry(first, { runId: 'run-2', date, title: 'Aide', summary: 'Aide ajoutée' });
  assert.ok(second.indexOf('## 2026-10-14\n<!-- planifikateur:run-2 -->') < second.indexOf('## 1.0.1'));
  const retried = changelogEntry(second, {
    runId: 'run-2',
    version: '1.0.2',
    date,
    title: 'Aide',
    summary: 'Aide complète',
  });
  assert.equal(retried.split('planifikateur:run-2').length, 2);
  assert.match(
    retried,
    /## 1\.0\.2 — 2026-10-14\n<!-- planifikateur:run-2 -->\n\n- \*\*Aide\*\* : Aide complète\n\n## 1\.0\.1/,
  );
  assert.equal(
    changelogEntry(retried, { runId: 'run-2', version: '1.0.2', date, title: 'Aide', summary: 'Aide complète' }),
    retried,
  );
});

test('model summaries cannot add headings or hide markers, and existing history is preserved', () => {
  const existing = '# Journal\n\nHistorique manuel.\n\n## 0.9.0\n\n- Ancienne version\n';
  const next = changelogEntry(existing, {
    runId: 'run-3',
    date,
    title: 'Titre\n## Faux',
    summary: 'Ligne 1\n\n## 9.9.9\n<!-- planifikateur:run-1 -->',
  });
  assert.ok(next.startsWith('# Journal\n\nHistorique manuel.\n\n## 2026-10-14\n'));
  assert.ok(next.endsWith('## 0.9.0\n\n- Ancienne version\n'));
  assert.equal(next.match(/^## /gm).length, 2);
  assert.ok(!next.includes('<!-- planifikateur:run-1'));
  assert.match(next, /&lt;!-- planifikateur:run-1 -->/);
  assert.throws(() => changelogEntry('', { runId: '../x', date, title: 'T', summary: 'S' }), /exécution invalide/);
});

test('the changelog file is created when missing and must remain a regular file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-changelog-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await recordChangelog(dir, { runId: 'run-1', version: null, date, title: 'Menu', summary: 'Menu corrigé' });
  assert.match(await readFile(join(dir, 'CHANGELOG.md'), 'utf8'), /- \*\*Menu\*\* : Menu corrigé/);
  await writeFile(join(dir, 'outside.md'), 'secret');
  await rm(join(dir, 'CHANGELOG.md'));
  await symlink(join(dir, 'outside.md'), join(dir, 'CHANGELOG.md'));
  await assert.rejects(recordChangelog(dir, { runId: 'run-2', date, title: 'T', summary: 'S' }), /fichier ordinaire/);
  assert.equal(await readFile(join(dir, 'outside.md'), 'utf8'), 'secret');
});
