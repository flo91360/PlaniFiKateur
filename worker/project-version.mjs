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

// Version suivante écrite dans le fichier que déclare le profil installé (`versioning`).
export async function bumpProjectVersion(cwd, profile, command) {
  const versioning = presetRules(profile).versioning;
  if (!['npm', 'godot'].includes(versioning?.format)) return null;
  const npm = versioning.format === 'npm',
    files = npmFiles(versioning),
    file = npm ? files.manifest : 'project.godot';
  const regular = async name => {
    const details = await lstat(join(cwd, name));
    if (!details.isFile()) throw new Error(`Le fichier de version ${name} doit être un fichier ordinaire.`);
  };
  await regular(file);
  const base = await command(['git', 'show', `origin/${profile.branch}:${file}`]);
  const current = await readFile(join(cwd, file), 'utf8');
  const godotVersion = source => /^config\/version="([^"]+)"$/m.exec(source)?.[1];
  const version = nextProjectVersion(
    npm ? JSON.parse(base).version : godotVersion(base),
    npm ? JSON.parse(current).version : godotVersion(current),
  );
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
