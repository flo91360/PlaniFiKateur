import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { presetRules } from './execution-profile.mjs';

export const parseProjectVersion = version => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version || '');
  if (!match || match.slice(1).some(n => !Number.isSafeInteger(Number(n))))
    throw new Error('La version du projet doit utiliser le format majeur.mineur.correctif.');
  return match.slice(1).map(Number);
};
export function nextProjectVersion(base, current) {
  const before = parseProjectVersion(base),
    after = parseProjectVersion(current);
  const different = after.findIndex((n, i) => n !== before[i]);
  if (different >= 0 && after[different] > before[different]) return current;
  before[2]++;
  parseProjectVersion(before.join('.'));
  return before.join('.');
}
// Seules les mentions de la version courante suivent la livraison : titres des documents et nom de
// la copie HTML (`…-v<version>.html`). Une mention historique (« Depuis la v… ») garde sa version.
export function currentVersionReferences(source, previous, version) {
  const escaped = previous.replaceAll('.', '\\.');
  const anywhere = new RegExp(`(?<![0-9.])${escaped}\\b`, 'g');
  const fileName = new RegExp(`(-v)${escaped}(\\.html)`, 'g');
  return source
    .split('\n')
    .map(line => (/^#{1,6}\s/.test(line) ? line.replace(anywhere, version) : line.replace(fileName, `$1${version}$2`)))
    .join('\n');
}

// Fichiers de version npm du profil : package.json et son lockfile, dans `versioning.directory`.
export const npmFiles = versioning => {
  const prefix = versioning?.directory ? `${versioning.directory}/` : '';
  return { manifest: `${prefix}package.json`, lock: `${prefix}package-lock.json` };
};
// Paquet Rust (Tauri) : la première ligne `version` de Cargo.toml, celle du paquet, et son entrée
// dans Cargo.lock.
const cargoName = source => /^name = "([^"]+)"$/m.exec(source)?.[1];
const lockEntry = name =>
  new RegExp(`^(name = "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\nversion = ")([^"]+)(")`, 'm');
export const cargoVersions = (toml, lock) => {
  const name = cargoName(toml);
  return { toml: /^version = "([^"]+)"$/m.exec(toml)?.[1], lock: name ? lockEntry(name).exec(lock)?.[2] : undefined };
};

// Paquet Python : la ligne `version = "…"` de la table [project] de pyproject.toml, et la ligne
// `__version__ = "…"` des modules qui l’exposent.
const projectTable = source => {
  const start = /^\[project\][ \t]*$/m.exec(source);
  if (!start) return null;
  const from = start.index + start[0].length;
  const next = /^\[/m.exec(source.slice(from));
  return { from, to: next ? from + next.index : source.length };
};
const PYPROJECT_VERSION = /^(version[ \t]*=[ \t]*")([^"]+)(")[ \t]*$/m;
const MODULE_VERSION = /^(__version__[ \t]*=[ \t]*["'])([^"']+)(["'])[ \t]*$/m;
export const pyprojectVersion = source => {
  const table = projectTable(source);
  return table ? PYPROJECT_VERSION.exec(source.slice(table.from, table.to))?.[2] : undefined;
};
export const moduleVersion = source => MODULE_VERSION.exec(source)?.[2];
const withPyprojectVersion = (source, version) => {
  const table = projectTable(source);
  return (
    source.slice(0, table.from) +
    source.slice(table.from, table.to).replace(PYPROJECT_VERSION, `$1${version}$3`) +
    source.slice(table.to)
  );
};
const VERSION_FILES = { npm: null, godot: 'project.godot', pyproject: 'pyproject.toml' };
const readers = {
  godot: source => /^config\/version="([^"]+)"$/m.exec(source)?.[1],
  pyproject: pyprojectVersion,
};
// Fichier qui porte la version du profil, et lecture de sa version.
export const versionFile = versioning =>
  versioning?.format === 'npm' ? npmFiles(versioning).manifest : VERSION_FILES[versioning?.format];
export const readVersionText = (source, format) =>
  format === 'npm' ? JSON.parse(source).version : readers[format]?.(source);

// Version suivante écrite dans le fichier que déclare le profil installé (`versioning`).
export async function bumpProjectVersion(cwd, profile, command) {
  const versioning = presetRules(profile).versioning;
  if (!Object.hasOwn(VERSION_FILES, versioning?.format || '')) return null;
  const format = versioning.format,
    npm = format === 'npm',
    files = npmFiles(versioning),
    file = versionFile(versioning);
  const regular = async name => {
    const details = await lstat(join(cwd, name));
    if (!details.isFile()) throw new Error(`Le fichier de version ${name} doit être un fichier ordinaire.`);
  };
  await regular(file);
  const base = await command(['git', 'show', `origin/${profile.branch}:${file}`]);
  const current = await readFile(join(cwd, file), 'utf8');
  const version = nextProjectVersion(readVersionText(base, format), readVersionText(current, format));
  if (npm) {
    const json = JSON.parse(current);
    await regular(files.lock);
    const lock = JSON.parse(await readFile(join(cwd, files.lock), 'utf8'));
    json.version = version;
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    await writeFile(join(cwd, file), JSON.stringify(json, null, 2) + '\n');
    await writeFile(join(cwd, files.lock), JSON.stringify(lock, null, 2) + '\n');
    if (versioning.cargo) await bumpCargoVersion(cwd, versioning.cargo, version, regular);
    if (versioning.documents?.length) {
      const previous = JSON.parse(base).version;
      try {
        if (!(await lstat(join(cwd, 'docs'))).isDirectory())
          throw new Error('Le dossier docs doit être un répertoire ordinaire.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      for (const document of versioning.documents) {
        try {
          await regular(document);
          const source = await readFile(join(cwd, document), 'utf8');
          await writeFile(join(cwd, document), currentVersionReferences(source, previous, version));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  } else if (format === 'pyproject') {
    await writeFile(join(cwd, file), withPyprojectVersion(current, version));
    for (const module of versioning.modules || []) {
      await regular(module);
      const source = await readFile(join(cwd, module), 'utf8');
      if (!moduleVersion(source)) throw new Error(`Ligne __version__ introuvable dans ${module}.`);
      await writeFile(join(cwd, module), source.replace(MODULE_VERSION, `$1${version}$3`));
    }
  } else await writeFile(join(cwd, file), current.replace(/^config\/version="[^"]+"$/m, `config/version="${version}"`));
  return version;
}

async function bumpCargoVersion(cwd, directory, version, regular) {
  const toml = `${directory}/Cargo.toml`,
    lock = `${directory}/Cargo.lock`;
  await regular(toml);
  await regular(lock);
  const manifest = await readFile(join(cwd, toml), 'utf8'),
    locked = await readFile(join(cwd, lock), 'utf8');
  const name = cargoName(manifest),
    found = cargoVersions(manifest, locked);
  if (!found.toml || !found.lock) throw new Error(`Version du paquet Rust introuvable dans ${toml} ou ${lock}.`);
  await writeFile(join(cwd, toml), manifest.replace(/^version = "[^"]+"$/m, `version = "${version}"`));
  await writeFile(join(cwd, lock), locked.replace(lockEntry(name), `$1${version}$3`));
}
