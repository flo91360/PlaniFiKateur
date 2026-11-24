import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// Les dépendances, le worker ou le déploiement ont-ils changé depuis `base` ? Chaque livraison
// change la version de package.json et du lockfile : ce seul changement ne compte pas.
const watched =
  /^(\.npmrc|\.dockerignore|worker\/|deploy\/|scripts\/dependency-(checks\.sh|changes\.mjs)|\.github\/workflows\/(ci|dependencies)\.yml)/;
const manifests = new Set(['package.json', 'package-lock.json']);

// Manifeste sans le numéro de version du projet.
const withoutVersion = data => {
  if (!data) return data;
  const copy = structuredClone(data);
  delete copy.version;
  if (copy.packages?.['']) delete copy.packages[''].version;
  return copy;
};

export function dependenciesChanged(base, { cwd = process.cwd() } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const read = (revision, file) => {
    try {
      return JSON.parse(git('show', `${revision}:${file}`));
    } catch {
      return null;
    }
  };
  if (!base || /^0+$/.test(base)) return true;
  try {
    git('cat-file', '-e', `${base}^{commit}`);
  } catch {
    return true;
  }
  const from = git('merge-base', base, 'HEAD').trim();
  const files = git('diff', '--name-only', from, 'HEAD').split('\n').filter(Boolean);
  return files.some(
    file =>
      watched.test(file) ||
      (manifests.has(file) && !isDeepStrictEqual(withoutVersion(read(from, file)), withoutVersion(read('HEAD', file)))),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(`changed=${dependenciesChanged(process.argv[2])}`);
