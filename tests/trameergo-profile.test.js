import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultExecutionProfile,
  validateExecutionProfile,
  resolveWorkerCommand,
} from '../worker/execution-profile.mjs';
import { bumpProjectVersion } from '../worker/project-version.mjs';

const workerDirectory = fileURLToPath(new URL('../worker', import.meta.url));
const pro = (extra = '') =>
  `QT += core gui axcontainer widgets uitools\nVERSION = 1.2.3\nSOURCES += \\\n    main.cpp \\\n    window.cpp\nHEADERS += \\\n    window.h\nFORMS += \\\n    window.ui\n${extra}`;
const ui = (names = ['Window', 'button']) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ui version="4.0">\n <class>Window</class>\n <widget class="QWidget" name="${names[0]}">\n  <widget class="QPushButton" name="${names[1]}"/>\n </widget>\n</ui>\n`;
async function project(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'planifikateur-qt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const all = {
    'App.pro': pro(),
    'main.cpp': 'int main() { return 0; } // )\n',
    'window.cpp':
      '#include "window.h"\n#include "ui_window.h"\nconst char *t = "{ ( [";\nchar c = \'}\';\nWindow::Window() { if (true) { call(1, 2); } }\n',
    'window.h': '#pragma once\nclass Window : public QWidget {\n    Q_OBJECT\npublic:\n    Window();\n};\n',
    'window.ui': ui(),
    ...files,
  };
  for (const [name, content] of Object.entries(all)) if (content !== null) await writeFile(join(dir, name), content);
  return dir;
}
const check = (dir, profile = defaultExecutionProfile('flo91360/TrameErgo')) => {
  const [command, ...args] = resolveWorkerCommand(profile.testCommands[0], workerDirectory);
  return spawnSync(command, args, { cwd: dir, encoding: 'utf8' });
};

test('the TrameErgo repository receives its Qt profile with a Windows build required before merging', () => {
  const profile = defaultExecutionProfile('flo91360/TrameErgo');
  assert.equal(profile.preset, 'trameergo');
  assert.deepEqual(profile.workflow, { file: 'build-windows.yml', name: 'Windows .exe', jobs: ['build'] });
  assert.deepEqual(validateExecutionProfile({ preset: 'trameergo' }), profile);
  const resolved = resolveWorkerCommand(profile.testCommands[0], workerDirectory);
  assert.ok(existsSync(resolved[1]));
  // Only installed worker files are resolved: a path escaping the worker stays literal and fails.
  assert.deepEqual(resolveWorkerCommand(['python3', '@worker/../repo.py', 'value'], '/opt/worker'), [
    'python3',
    '@worker/../repo.py',
    'value',
  ]);
});

test('the Qt check accepts a consistent project, including braces inside strings and comments', async t => {
  const result = check(await project(t));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /App\.pro : 4 fichiers déclarés/);
});

test('the Qt check reports the mistakes a change typically introduces', async t => {
  const cases = [
    [{ 'window.cpp': null }, /SOURCES : « window\.cpp » est déclaré dans le \.pro mais absent/],
    [{ 'window.cpp': 'Window::Window() { if (ok) {\n}\n' }, /window\.cpp : « \{ » non fermé/],
    [{ 'main.cpp': 'int main() { return f(1)); }\n' }, /main\.cpp : « \) » inattendu ligne 1/],
    [{ 'window.ui': '<ui version="4.0"><class>Window</class>' }, /window\.ui : XML invalide/],
    [{ 'window.ui': ui(['Window', 'Window']) }, /plusieurs widgets s'appellent « Window »/],
    [
      { 'App.pro': pro().replace('HEADERS += \\\n    window.h\n', '') },
      /window\.h : classe Q_OBJECT absente de HEADERS/,
    ],
    [{ 'App.pro': pro().replace('1.2.3', 'v1') }, /VERSION « v1 »/],
    [{ 'Other.pro': 'SOURCES += main.cpp\n' }, /Un seul fichier \.pro/],
  ];
  for (const [files, message] of cases) {
    const result = check(await project(t, files));
    assert.equal(result.status, 1, `${message} : ${result.stdout}`);
    assert.match(result.stdout, message);
  }
});

test('TrameErgo deliveries raise the qmake VERSION once and keep an explicitly higher version', async t => {
  const dir = await project(t),
    profile = defaultExecutionProfile('flo91360/TrameErgo');
  const base = async () => pro();
  assert.equal(await bumpProjectVersion(dir, profile, base), '1.2.4');
  assert.equal(await bumpProjectVersion(dir, profile, base), '1.2.4');
  assert.match(await readFile(join(dir, 'App.pro'), 'utf8'), /^VERSION = 1\.2\.4$/m);
  await writeFile(join(dir, 'App.pro'), pro().replace('1.2.3', '2.0.0'));
  assert.equal(await bumpProjectVersion(dir, profile, base), '2.0.0');
  await writeFile(join(dir, 'App.pro'), pro().replace('VERSION = 1.2.3\n', ''));
  assert.equal(await bumpProjectVersion(dir, profile, base), null);
});
