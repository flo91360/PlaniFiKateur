import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { bumpProjectVersion, cargoVersions, npmFiles, parseProjectVersion } from './project-version.mjs';
import { recordChangelog, versionHeading } from './changelog.mjs';
import { presetRules } from './execution-profile.mjs';

const regularText = async (cwd, file) => {
  if (!(await lstat(join(cwd, file))).isFile()) throw new Error(`${file} doit être un fichier ordinaire.`);
  return readFile(join(cwd, file), 'utf8');
};
function versionFile(profile) {
  const versioning = presetRules(profile).versioning;
  if (versioning?.format === 'npm') return npmFiles(versioning).manifest;
  if (versioning?.format === 'godot') return 'project.godot';
  throw new Error('Le profil doit désigner un fichier de version unique.');
}
function readVersion(source, file) {
  const version = file.endsWith('package.json')
    ? JSON.parse(source).version
    : /^config\/version="([^"]+)"$/m.exec(source)?.[1];
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
  const versioning = presetRules(profile).versioning;
  const file = versionFile(profile);
  const previous = readVersion(await command(['git', 'show', `${base}:${file}`]), file);
  const version = readVersion(await regularText(cwd, file), file);
  const before = parseProjectVersion(previous),
    after = parseProjectVersion(version);
  const changed = after.findIndex((number, i) => number !== before[i]);
  if (changed < 0 || after[changed] < before[changed])
    throw new Error(
      `La livraison doit augmenter la version ${previous} (version trouvée : ${version}). Lancez delivery:prepare avant les tests.`,
    );
  if (versioning.format === 'npm') {
    const lock = JSON.parse(await regularText(cwd, npmFiles(versioning).lock));
    if (lock.version !== version || (lock.packages?.[''] && lock.packages[''].version !== version))
      throw new Error('package.json et package-lock.json doivent porter la même version.');
  }
  if (versioning.cargo) {
    const found = cargoVersions(
      await regularText(cwd, `${versioning.cargo}/Cargo.toml`),
      await regularText(cwd, `${versioning.cargo}/Cargo.lock`),
    );
    if (found.toml !== version || found.lock !== version)
      throw new Error('Cargo.toml et Cargo.lock doivent porter la même version que package.json.');
  }
  const changelog = await regularText(cwd, 'CHANGELOG.md');
  const sections = changelog
    .replaceAll('\r\n', '\n')
    .split(/^(?=## )/m)
    .slice(1);
  const heading = versionHeading(version, versioning.changelog);
  const date = sections[0]?.split('\n')[0].slice(heading.length);
  if (!sections[0]?.startsWith(heading) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^- .+\S/m.test(sections[0]))
    throw new Error(`CHANGELOG.md doit commencer par une entrée renseignée pour ${version}.`);
  if (sections.filter(section => section.startsWith(heading)).length !== 1)
    throw new Error('Le changelog ne doit contenir qu’une section pour la nouvelle version.');
  return { version, previous, notes: sections[0].split('\n').slice(1).join('\n').trim() };
}
export async function prepareDelivery(cwd, profile, command, details) {
  const version = await bumpProjectVersion(cwd, profile, command);
  if (!version) throw new Error('Le profil ne permet pas de préparer une version pour cette livraison.');
  await recordChangelog(cwd, { ...details, version, style: presetRules(profile).versioning?.changelog });
  return verifyDelivery(cwd, profile, command);
}
