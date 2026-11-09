import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownPage } from '../server/markdown.js';

test('a changelog is laid out with headings, nested lists, emphasis, code and links', () => {
  const html = markdownToHtml(
    [
      '# Changelog',
      '',
      'Modifications **livrées**, de la plus *récente* à la plus ancienne.',
      '<!-- planifikateur:run -->',
      '',
      '## 1.2.0 — 2026-11-09',
      '',
      '- **Défilement** : plus doux avec `npm test`',
      '  - détail imbriqué',
      '- Voir [le guide](https://example.com/guide?a=1&b=2)',
      '',
      '1. Installer',
      '2. Lancer',
      '',
      '```sh',
      'npm ci <x>',
      '```',
      '',
      '> Remarque',
      '',
      '| Col | Val |',
      '| --- | --- |',
      '| a | b |',
      '',
      '---',
    ].join('\n'),
  );
  assert.equal(
    html,
    [
      '<h1>Changelog</h1>',
      '<p>Modifications <strong>livrées</strong>, de la plus <em>récente</em> à la plus ancienne.</p>',
      '<h2>1.2.0 — 2026-11-09</h2>',
      '<ul><li><strong>Défilement</strong> : plus doux avec <code>npm test</code><ul><li>détail imbriqué</li></ul></li><li>Voir <a href="https://example.com/guide?a=1&amp;b=2" rel="noreferrer">le guide</a></li></ul>',
      '<ol><li>Installer</li><li>Lancer</li></ol>',
      '<pre><code>npm ci &lt;x&gt;</code></pre>',
      '<blockquote><p>Remarque</p></blockquote>',
      '<table><thead><tr><th>Col</th><th>Val</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
      '<hr>',
    ].join('\n'),
  );
});

test('raw HTML and unsafe links in a document are never interpreted', () => {
  const html = markdownToHtml('<script>alert(1)</script>\n\n[clic](javascript:void) ![img](https://x/y.png)');
  assert.doesNotMatch(html, /<script|href="javascript/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /clic img/);
  const page = markdownPage({ title: 'Mode d’emploi', subtitle: '<DefilOrdi>', markdown: '# A' });
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<p>&lt;DefilOrdi&gt;<\/p>/);
});
