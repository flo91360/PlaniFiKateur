// Mise en page HTML d’un README ou d’un CHANGELOG.md, sans dépendance : titres, paragraphes, listes
// (imbriquées par l’indentation), citations, blocs de code, tableaux, séparateurs, gras, italique,
// code et liens. Tout le texte est échappé avant la mise en forme ; seuls les liens http(s), mailto
// et les ancres sont conservés, les images deviennent leur texte de remplacement.

const escape = text =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const safeHref = href => (/^(?:https?:\/\/|mailto:|#)/i.test(href) ? href : null);

export function inline(text) {
  const codes = [];
  let html = escape(text).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  html = html
    .replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+&quot;[^&]*&quot;)?\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, href) => {
      const target = safeHref(href.replace(/&amp;/g, '&'));
      return target ? `<a href="${escape(target)}" rel="noreferrer">${label}</a>` : label;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" rel="noreferrer">$2</a>')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = row =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(cell => cell.trim());

function list(lines, start) {
  const indent = lines[start].match(LIST)[1].length;
  const ordered = /\d/.test(lines[start].match(LIST)[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = lines[i].match(LIST);
    if (match && match[1].length === indent) {
      items.push({ text: [match[3].replace(/^\[([ xX])\]\s+/, (_, c) => (c === ' ' ? '☐ ' : '☑ '))], children: '' });
      i++;
    } else if (match && match[1].length > indent && items.length) {
      const nested = list(lines, i);
      items.at(-1).children += nested.html;
      i = nested.end;
    } else if (!match && lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
      items.at(-1).text.push(lines[i].trim());
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  return {
    html: `<${tag}>${items.map(item => `<li>${inline(item.text.join(' '))}${item.children}</li>`).join('')}</${tag}>`,
    end: i,
  };
}

export function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*<!--.*-->\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const result = list(lines, i);
      out.push(result.html);
      i = result.end;
      continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(
        `<table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows
          .map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    const paragraph = [];
    for (
      ;
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>)/.test(lines[i]) &&
      !LIST.test(lines[i]) &&
      !/^\s*<!--.*-->\s*$/.test(lines[i]);
      i++
    )
      paragraph.push(lines[i].trim());
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

const STYLE = `
:root{color-scheme:light dark}:root[data-theme=clair]{color-scheme:light}:root[data-theme=sombre]{color-scheme:dark}
:root{--primary:#28734b;--text:light-dark(#263b33,#e3ece8);--muted:light-dark(#646f6b,#9fb0a9);--page:light-dark(#f7faf9,#111816);--surface:light-dark(#fff,#1a2320);--tint:light-dark(#f2f7f4,#1f2a26);--border:light-dark(#e2e9e6,#2c3a35);--link:light-dark(#28734b,#a4dfc7)}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:16px/1.6 "DM Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:#193d2f;color:#eff6f3;padding:18px 24px}
header p{margin:0;font-size:13px;color:#b7cac2}
header h1{margin:2px 0 0;font:700 20px/1.3 Manrope,system-ui,sans-serif}
main{max-width:860px;margin:24px auto;padding:8px 32px 32px;background:var(--surface);border:1px solid var(--border);border-radius:14px}
h1,h2,h3,h4{font-family:Manrope,system-ui,sans-serif;line-height:1.3;margin:1.6em 0 .5em}
h1{font-size:28px}h2{font-size:22px;padding-bottom:6px;border-bottom:1px solid var(--border)}h3{font-size:18px}
a{color:var(--link)}
code{font:14px ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--tint);padding:1px 5px;border-radius:5px}
pre{background:var(--tint);padding:14px;border-radius:10px;overflow:auto}pre code{padding:0;background:none}
blockquote{margin:1em 0;padding:4px 16px;border-left:4px solid var(--primary);color:var(--muted)}
table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto}th,td{border:1px solid var(--border);padding:6px 10px;text-align:left}th{background:var(--tint)}
hr{border:0;border-top:1px solid var(--border);margin:2em 0}
li{margin:.2em 0}
@media (max-width:640px){main{margin:0;border:0;border-radius:0;padding:4px 18px 24px}}
`;

// Thème choisi dans l’interface (cookie posé par src/lib/theme.js), ou null pour suivre le système.
export function themeFromCookie(header) {
  const value = /(?:^|;\s*)planifikateur_theme=([^;]*)/.exec(header || '')?.[1];
  return value === 'clair' || value === 'sombre' ? value : null;
}

// Page complète, autonome (aucun script ni ressource externe) : le serveur la sert avec une CSP stricte.
// Sans thème choisi, les couleurs suivent celui du système (`color-scheme: light dark`).
export function markdownPage({ title, subtitle, markdown, theme = null }) {
  const themed = theme === 'clair' || theme === 'sombre' ? ` data-theme="${theme}"` : '';
  return `<!DOCTYPE html>
<html lang="fr"${themed}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><p>${escape(subtitle)}</p><h1>${escape(title)}</h1></header>
<main>
${markdownToHtml(markdown)}
</main>
</body>
</html>
`;
}
