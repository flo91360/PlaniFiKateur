import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const CHANGELOG_FILE = 'CHANGELOG.md';
const header =
  '# Changelog\n\nModifications livrées par PlaniFiKateur depuis la mise en place de ce journal, de la plus récente à la plus ancienne.\n';
const marker = id => `<!-- planifikateur:${id} -->`;
// Une seule ligne, sans balise HTML : le texte du modèle ne peut ni créer de titre ni imiter un marqueur.
const line = (value, max) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/</g, '&lt;');
const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(date);

// Une section par livraison, sous la nouvelle version du projet quand le profil la fixe.
// Réécrire la même exécution (nouvelle tentative, reprise sur main à jour) remplace sa section.
export function changelogEntry(source, { runId, version, date = new Date(), title, summary }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId || ''))
    throw new Error('Identifiant d’exécution invalide pour le changelog.');
  const sections = (source.trim() ? source.replace(/\r\n/g, '\n') : header).split(/^(?=## )/m);
  const intro = sections[0].trimEnd() + '\n';
  const kept = sections
    .slice(1)
    .filter(section => !section.includes(marker(runId)))
    .map(section => section.trimEnd() + '\n');
  const heading = version ? `## ${version} — ${day(date)}` : `## ${day(date)}`;
  const entry = `${heading}\n${marker(runId)}\n\n- **${line(title, 140) || 'Modification'}** : ${line(summary, 2000) || 'Modification livrée.'}\n`;
  return [intro, entry, ...kept].join('\n');
}

export async function recordChangelog(cwd, details) {
  const path = join(cwd, CHANGELOG_FILE);
  let source = '';
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Le fichier ${CHANGELOG_FILE} doit être un fichier ordinaire.`);
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(path, changelogEntry(source, details));
}
