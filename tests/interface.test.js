import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectAccess } from '../src/lib/project-access.js';

test('project roles map to the rights the interface applies', () => {
  assert.deepEqual(projectAccess('viewer'), { role: 'viewer', readOnly: true, canLaunch: false, canManage: false });
  assert.deepEqual(projectAccess('editor'), { role: 'editor', readOnly: false, canLaunch: false, canManage: false });
  assert.deepEqual(projectAccess('manager'), { role: 'manager', readOnly: false, canLaunch: true, canManage: true });
  assert.equal(projectAccess().canManage, true, 'Hors connexion, l’utilisateur est responsable de sa page.');
});

test('every class styled in src/styles is still used by the interface', () => {
  const files = directory =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
    );
  const css = files('src/styles')
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{[^}]*\}/g, '{}');
  const source = [...files('src'), 'index.html', ...files('public').filter(file => file.endsWith('.html'))]
    .filter(file => /\.(jsx?|html)$/.test(file))
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');
  const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]));
  const unused = [...classes].filter(name => !new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(source));
  assert.deepEqual(unused, [], 'Supprimer les règles CSS de ces classes, ou les remettre en usage.');
});
