import { readFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bumpProjectVersion, parseProjectVersion } from './project-version.mjs';
import { recordChangelog } from './changelog.mjs';
import { presetRules } from './execution-profile.mjs';

const regularText = async (cwd, file) => {
  if (!(await lstat(join(cwd, file))).isFile()) throw new Error(`${file} doit être un fichier ordinaire.`);
  return readFile(join(cwd, file), 'utf8');
};
async function versionFile(cwd, profile) {
  const format = presetRules(profile).versioning?.format;
  if (format === 'npm') return 'package.json';
  if (format === 'godot') return 'project.godot';
  if (format === 'qmake') {
    const names = (await readdir(cwd)).filter(name => name.endsWith('.pro'));
    if (names.length === 1) return names[0];
  }
  throw new Error('Le profil doit désigner un fichier de version unique.');
}
function readVersion(source, file) {
  const version =
    file === 'package.json'
      ? JSON.parse(source).version
      : file === 'project.godot'
        ? /^config\/version="([^"]+)"$/m.exec(source)?.[1]
        : /^VERSION\s*=\s*(\S+)\s*$/m.exec(source)?.[1];
  parseProjectVersion(version);
  return version;
}
export async function verifyDelivery(cwd, profile, command, base = `origin/${profile.branch}`) {
  try {
    await command(['git', 'merge-base', '--is-ancestor', base, 'HEAD']);
  } catch {
    throw new Error(
      'La branche cible a avancé : intégrez ses changements, préparez de nouveau la livraison puis relancez les vérifications.',
    );
  }
  const file = await versionFile(cwd, profile);
  const previous = readVersion(await command(['git', 'show', `${base}:${file}`]), file);
  const version = readVersion(await regularText(cwd, file), file);
  const before = parseProjectVersion(previous),
    after = parseProjectVersion(version);
  const changed = after.findIndex((number, i) => number !== before[i]);
  if (changed < 0 || after[changed] < before[changed])
    throw new Error(
      `La livraison doit augmenter la version ${previous} (version trouvée : ${version}). Lancez delivery:prepare avant les tests.`,
    );
  if (file === 'package.json') {
    const lock = JSON.parse(await regularText(cwd, 'package-lock.json'));
    if (lock.version !== version || (lock.packages?.[''] && lock.packages[''].version !== version))
      throw new Error('package.json et package-lock.json doivent porter la même version.');
  }
  const changelog = await regularText(cwd, 'CHANGELOG.md');
  const sections = changelog
    .replaceAll('\r\n', '\n')
    .split(/^(?=## )/m)
    .slice(1);
  const date = sections[0]?.split('\n')[0].slice(`## ${version} — `.length);
  if (
    !sections[0]?.startsWith(`## ${version} — `) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date || '') ||
    !/^- .+\S/m.test(sections[0])
  )
    throw new Error(`CHANGELOG.md doit commencer par une entrée renseignée pour ${version}.`);
  if (sections.filter(section => section.startsWith(`## ${version} — `)).length !== 1)
    throw new Error('Le changelog ne doit contenir qu’une section pour la nouvelle version.');
  return { version, previous, notes: sections[0].split('\n').slice(1).join('\n').trim() };
}
export async function prepareDelivery(cwd, profile, command, details) {
  const version = await bumpProjectVersion(cwd, profile, command);
  if (!version) throw new Error('Le profil ne permet pas de préparer une version pour cette livraison.');
  await recordChangelog(cwd, { ...details, version });
  return verifyDelivery(cwd, profile, command);
}
