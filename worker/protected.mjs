import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { presetRules } from './execution-profile.mjs';
import { npmFiles } from './project-version.mjs';

// Fichiers qu’une carte ne peut pas modifier : workflows GitHub, scripts npm et fichiers déclarés
// par le profil installé (`protectedPaths` : configuration des tests, et pour PlaniFiKateur le
// worker lui-même, déployé automatiquement, et sa chaîne de livraison). Une PR qui les changerait
// pourrait affaiblir les contrôles qui autorisent sa propre fusion. Aucune personne n’a à
// l’approuver : le worker rétablit ces fichiers et l’agent réalise la demande sans eux.
const ALWAYS = ['.github/**'];
export const SCRIPTS = 'package.json (scripts)';
// package.json dont les scripts sont protégés : celui du profil npm, à la racine ou dans `directory`.
const manifest = profile => {
  const versioning = presetRules(profile).versioning;
  return versioning?.format === 'npm' ? npmFiles(versioning).manifest : null;
};

const scriptsOf = source => {
  try {
    return JSON.stringify(JSON.parse(source).scripts || {});
  } catch {
    return null;
  }
};

const list = async (command, args) => (await command(['git', ...args])).split('\0').filter(Boolean);

// Fichiers dont le contenu diffère de `base` (la branche cible, déjà intégrée à la branche de la
// tâche) : commits de la branche et modifications en cours confondus, plus les nouveaux fichiers.
// Un fichier rétabli ne compte plus, même si un commit de travail l’avait modifié.
async function changedPaths(command, base) {
  return [
    ...new Set([
      ...(await list(command, ['diff', '-z', '--name-only', '--no-renames', base])),
      ...(await list(command, ['ls-files', '-z', '--others', '--exclude-standard'])),
    ]),
  ];
}

// Liste triée des fichiers protégés modifiés depuis la branche cible (vide si aucun) ;
// « package.json (scripts) » quand seuls ses scripts npm comptent.
export async function protectedChanges(profile, { command, cwd, base }) {
  const changed = await changedPaths(command, base);
  const matches = picomatch([...ALWAYS, ...(presetRules(profile).protectedPaths || [])], { dot: true });
  const found = changed.filter(path => matches(path));
  const scripts = manifest(profile);
  if (scripts && changed.includes(scripts)) {
    const target = await command(['git', 'show', `${base}:${scripts}`]).catch(() => '');
    const current = await readFile(join(cwd, scripts), 'utf8').catch(() => '');
    if (scriptsOf(target) !== scriptsOf(current)) found.push(SCRIPTS);
  }
  return [...new Set(found)].sort();
}

// Rétablit les fichiers protégés tels qu’ils sont sur la branche cible : contenu d’origine, ou
// suppression d’un fichier qu’elle n’a pas. Seuls les scripts de package.json sont rétablis, la
// version et les dépendances restant celles de la branche.
export async function restoreProtected(changes, { command, cwd, base, profile }) {
  for (const path of changes) {
    if (path === SCRIPTS) continue;
    const existing = await command(['git', 'cat-file', '-e', `${base}:${path}`]).then(
      () => true,
      () => false,
    );
    if (existing) await command(['git', '--literal-pathspecs', 'checkout', base, '--', path]);
    else {
      await command(['git', '--literal-pathspecs', 'rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
      await rm(join(cwd, path), { recursive: true, force: true });
    }
  }
  if (!changes.includes(SCRIPTS)) return;
  const scripts = manifest(profile) || 'package.json';
  const target = JSON.parse(await command(['git', 'show', `${base}:${scripts}`]));
  let current;
  try {
    current = JSON.parse(await readFile(join(cwd, scripts), 'utf8'));
  } catch {
    await command(['git', '--literal-pathspecs', 'checkout', base, '--', scripts]);
    return;
  }
  if (target.scripts === undefined) delete current.scripts;
  else current.scripts = target.scripts;
  await writeFile(join(cwd, scripts), JSON.stringify(current, null, 2) + '\n');
}

// Fichiers protégés d’un profil, tels qu’annoncés à l’agent dans sa consigne.
export const protectedPatterns = profile => [
  ...ALWAYS,
  ...(presetRules(profile).protectedPaths || []),
  ...(manifest(profile) ? [`scripts npm de ${manifest(profile)}`] : []),
];

// Question posée sur la carte quand l’agent ne peut pas réaliser la demande sans ces fichiers.
export const protectedQuestion = changes =>
  `Cette demande modifierait des fichiers protégés : ${changes.join(', ')}. Ils règlent le fonctionnement du worker, la livraison ou les contrôles qui autorisent la fusion : une carte ne peut pas les changer, et le worker les a rétablis. L’administrateur traitera cette partie en intervention directe. Reformulez la demande sans ces fichiers en répondant ici, ou annulez l’exécution.`;
