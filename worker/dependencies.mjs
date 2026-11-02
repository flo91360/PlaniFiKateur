import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// Dépendances ajoutées ou modifiées par une carte : un paquet piégé s’exécuterait dans la CI, puis
// sur le serveur après la fusion automatique. La PR attend alors l’approbation d’un responsable,
// qui voit la liste sur la carte (soumission `reviewRequired`). Une dépendance retirée ne compte pas.
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const NPM_LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const OTHER_LOCKS = new Set(['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
// Manifestes et lockfiles des autres écosystèmes : signalés sans détail.
const MANIFESTS = [
  /^(requirements|constraints)[\w.-]*\.(txt|in)$/,
  /^(pyproject\.toml|Pipfile(\.lock)?|poetry\.lock|uv\.lock|setup\.(py|cfg))$/,
  /^(Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/,
  /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.lockfile|libs\.versions\.toml)$/,
  /^(packages\.config|Directory\.Packages\.props|.+\.csproj|Podfile(\.lock)?|Package\.(swift|resolved))$/,
  /^(pubspec\.(yaml|lock)|deno\.(json|jsonc|lock)|mix\.(exs|lock)|vcpkg\.json|conanfile\.(txt|py))$/,
];
const MAX_ITEMS = 50;

const parse = source => {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
};
const clip = text => (text.length > 300 ? `${text.slice(0, 299)}…` : text);

function packageChanges(path, before, after) {
  if (after === undefined) return [`Manifeste npm illisible : ${path}`];
  const items = [];
  for (const field of FIELDS) {
    const old = before?.[field] || {};
    for (const [name, spec] of Object.entries(after[field] || {})) {
      if (!(name in old)) items.push(`Dépendance ajoutée : ${name} ${spec} (${path})`);
      else if (old[name] !== spec) items.push(`Dépendance modifiée : ${name} ${old[name]} → ${spec} (${path})`);
    }
  }
  for (const field of ['overrides', 'resolutions', 'pnpm'])
    if (JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after[field] ?? null))
      items.push(`Résolutions de dépendances modifiées : ${field} (${path})`);
  return items;
}

// Paquets résolus du lockfile npm, sans le projet lui-même (dont la version change à chaque livraison).
function lockChanges(path, before, after) {
  if (after === undefined) return [`Lockfile illisible : ${path}`];
  const packages = lock => {
    if (!lock?.packages) return lock?.dependencies || {};
    const rest = { ...lock.packages };
    delete rest[''];
    return rest;
  };
  const old = packages(before),
    now = packages(after);
  const changed = Object.keys(now).filter(key => JSON.stringify(old[key]) !== JSON.stringify(now[key]));
  return changed.length
    ? [
        `Lockfile modifié : ${changed.length} paquet(s) ajouté(s) ou changé(s), dont ${changed
          .slice(0, 5)
          .map(key => key.replace(/^.*node_modules\//, ''))
          .join(', ')} (${path})`,
      ]
    : [];
}

// Liste des changements de dépendances depuis la branche cible `base`, vide s’il n’y en a pas.
export async function dependencyChanges({ command, cwd, base }) {
  const paths = (await command(['git', 'diff', '-z', '--name-only', '--no-renames', base]))
    .split('\0')
    .filter(path => path && !path.split('/').includes('node_modules'));
  const items = [];
  for (const path of paths) {
    const name = basename(path);
    const npm = name === 'package.json' || NPM_LOCKS.has(name);
    if (!npm) {
      if (OTHER_LOCKS.has(name)) items.push(`Lockfile modifié : ${path}`);
      else if (MANIFESTS.some(pattern => pattern.test(name))) items.push(`Manifeste de dépendances modifié : ${path}`);
      continue;
    }
    const before = parse(await command(['git', 'show', `${base}:${path}`]).catch(() => 'null')) ?? null;
    const source = await readFile(join(cwd, path), 'utf8').catch(() => null);
    if (source === null) continue; // Fichier supprimé : rien de nouveau à installer.
    const after = parse(source);
    items.push(...(name === 'package.json' ? packageChanges : lockChanges)(path, before, after));
  }
  if (items.length > MAX_ITEMS) items.splice(MAX_ITEMS - 1, Infinity, `… et ${items.length - MAX_ITEMS + 1} autre(s)`);
  return items.map(clip);
}
