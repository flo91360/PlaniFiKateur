import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownPage, themeFromCookie } from '../server/markdown.js';
import { applyTheme, themeCookie } from '../src/lib/theme.js';

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

test('a document page follows the theme chosen in the interface, or the system one', () => {
  assert.equal(themeFromCookie('planifikateur_session=abc; planifikateur_theme=sombre'), 'sombre');
  assert.equal(themeFromCookie('planifikateur_theme=clair'), 'clair');
  assert.equal(themeFromCookie('planifikateur_theme="><script>'), null);
  assert.equal(themeFromCookie(undefined), null);
  const dark = markdownPage({ title: 'Changelog', subtitle: 'depot', markdown: '# 1.0', theme: 'sombre' });
  assert.match(dark, /<html lang="fr" data-theme="sombre">/);
  assert.match(dark, /:root\[data-theme=sombre\]\{color-scheme:dark\}/);
  assert.match(markdownPage({ title: 'T', subtitle: 's', markdown: '' }), /<html lang="fr">/);
  assert.match(markdownPage({ title: 'T', subtitle: 's', markdown: '', theme: 'x' }), /<html lang="fr">/);
});

test('the interface copies its theme into a cookie read by the document pages', () => {
  assert.equal(themeCookie('sombre'), 'planifikateur_theme=sombre; Path=/; Max-Age=31536000; SameSite=Lax');
  assert.match(themeCookie('systeme'), /^planifikateur_theme=; Path=\/; Max-Age=0/);
  const root = { dataset: {} };
  const previous = globalThis.document;
  globalThis.document = { documentElement: root, cookie: '' };
  try {
    applyTheme('clair');
    assert.equal(root.dataset.theme, 'clair');
    assert.match(globalThis.document.cookie, /^planifikateur_theme=clair;/);
  } finally {
    globalThis.document = previous;
  }
});
