import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Outils de fichiers de Claude Code : ils tournent dans le processus du worker, hors du sandbox
// des commandes. Chaque chemin reste dans le dépôt une fois les liens symboliques résolus, et
// rien ne s’écrit dans .git (un hook ou un filtre y ferait exécuter du code au worker).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Chemin réel : celui du fichier s’il existe, sinon celui de son dossier existant le plus proche.
async function real(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await real(dirname(path)), basename(path));
  }
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// Renvoie le motif du refus, ou '' si l’outil peut s’exécuter.
export async function confineTool(cwd, name, input = {}) {
  const root = await realpath(cwd);
  if (name === 'Glob' && typeof input.pattern === 'string') {
    if (isAbsolute(input.pattern) || input.pattern.split(/[\\/]/).includes('..'))
      return 'Le motif de recherche doit rester relatif au dépôt.';
  }
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') return 'Chemin invalide.';
    const path = await real(resolve(cwd, input[key]));
    if (!inside(root, path)) return 'Le fichier doit rester dans le dépôt.';
    const rel = relative(root, path).split(sep);
    if (WRITE_TOOLS.has(name) && rel[0] === '.git') return 'Le dossier .git est réservé au worker.';
  }
  return '';
}
