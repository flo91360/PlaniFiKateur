import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANGELOG_FILE } from './changelog.mjs';

// État Git du checkout d’une tâche. L’agent ne lance aucune commande Git : le worker
// termine lui-même une fusion avec la branche cible dont l’agent a résolu les conflits.

// Fichiers dont le worker régénère le contenu à chaque livraison (sa section du changelog
// est réécrite d’après l’identifiant de l’exécution) : la version de la branche cible suffit.
const WORKER_OWNED = [CHANGELOG_FILE];

const exists = async path => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Opérations qu’un worker ne reprend pas : le checkout est alors recréé.
const UNRECOVERABLE = ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

export const mergeInProgress = cwd => exists(join(cwd, '.git', 'MERGE_HEAD'));

// Empreinte de ce qui, dans .git, ferait exécuter du code au worker lors de ses commandes Git
// locales : configuration (filtres, pilotes de fusion, textconv…), attributs et hooks. Le worker
// la relève après avoir préparé le checkout ; une différence ensuite vient de l’agent.
export async function gitGuard(cwd) {
  const read = name => readFile(join(cwd, '.git', name), 'utf8').catch(() => '');
  const hooks = await readdir(join(cwd, '.git', 'hooks')).catch(() => []);
  return createHash('sha256')
    .update(
      JSON.stringify([
        await read('config'),
        await read(join('info', 'attributes')),
        hooks.filter(name => !name.endsWith('.sample')).sort(),
      ]),
    )
    .digest('hex');
}

// Raison de recréer le checkout, ou '' s’il peut être repris tel quel (fusion en cours comprise).
export async function checkoutProblem(cwd, git, branch) {
  for (const name of UNRECOVERABLE)
    if (await exists(join(cwd, '.git', name))) return `opération Git interrompue (${name})`;
  const current = await git(['branch', '--show-current']);
  if (current.code !== 0) return 'dépôt Git illisible';
  if (current.output.trim() !== branch) return 'branche différente de celle de la tâche';
  if ((await git(['status', '--porcelain'])).code !== 0) return 'état Git illisible';
  return '';
}

// Lignes de début et de fin d’un bloc de conflit laissé par Git.
export const hasConflictMarkers = text => /^<{7}(?: |$)/m.test(text) || /^>{7}(?: |$)/m.test(text);

export async function unmergedFiles(git) {
  const listed = await git(['diff', '--name-only', '--diff-filter=U', '-z']);
  if (listed.code !== 0) throw new Error(`Lecture des conflits impossible : ${listed.output}`);
  return [...new Set(listed.output.split('\0').filter(Boolean))];
}

// Reprend de la branche cible les fichiers en conflit que le worker régénère lui-même.
// Renvoie les autres fichiers en conflit, que seul l’agent peut résoudre.
export async function resolveWorkerOwned(git) {
  const remaining = [];
  for (const file of await unmergedFiles(git)) {
    if (!WORKER_OWNED.includes(file)) remaining.push(file);
    else if ((await git(['checkout', '--theirs', '--', file])).code !== 0) remaining.push(file);
    else {
      const added = await git(['add', '--', file]);
      if (added.code !== 0) throw new Error(`Indexation de ${file} impossible : ${added.output}`);
    }
  }
  return remaining;
}

// Termine une fusion en cours une fois l’agent passé : fichiers sans marqueur indexés, puis
// commit de fusion. Renvoie les fichiers encore en conflit (fusion laissée en cours), sinon [].
export async function concludeMerge(cwd, git) {
  if (!(await mergeInProgress(cwd))) return [];
  const remaining = [];
  for (const file of await resolveWorkerOwned(git)) {
    let text = '';
    try {
      text = await readFile(join(cwd, file), 'utf8');
    } catch (error) {
      // Un fichier supprimé par l’agent est une résolution : « add --all » indexe la suppression.
      if (error.code !== 'ENOENT') throw error;
    }
    if (hasConflictMarkers(text)) remaining.push(file);
    else {
      const added = await git(['add', '--all', '--', file]);
      if (added.code !== 0) throw new Error(`Indexation de ${file} impossible : ${added.output}`);
    }
  }
  if (remaining.length) return remaining;
  // Seule la fusion est validée ; le reste du travail de l’agent reste dans l’arbre de travail.
  const committed = await git(['commit', '--no-edit', '--no-verify']);
  if (committed.code !== 0) throw new Error(`Validation de la fusion impossible : ${committed.output}`);
  return [];
}

export const conflictInstructions = (targetBranch, files) =>
  `La fusion de ${targetBranch} dans la branche de la tâche est en cours et ces fichiers sont en conflit : ${files.join(', ')}. ` +
  'Résous-les en modifiant directement les fichiers, sans laisser aucun marqueur de conflit (<<<<<<<, =======, >>>>>>>). ' +
  'Ne lance aucune commande Git : le worker indexe les fichiers résolus, valide la fusion, prépare la version puis relance les tests. ' +
  `${CHANGELOG_FILE} est repris de ${targetBranch} et réécrit par le worker : ne le modifie pas.`;
