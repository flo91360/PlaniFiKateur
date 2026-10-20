import { readdir, readFile } from 'node:fs/promises';

// Processus restants avant une commande Git distante. Le jeton GitHub accompagne `clone`, `fetch`,
// `ls-remote` et `push` dans leur environnement, lisible dans /proc/<pid>/environ par tout
// processus du même utilisateur. Les commandes du projet tournent dans bubblewrap (autre espace de
// processus), mais une commande du moteur IA mise en arrière-plan pourrait survivre à son tour et
// guetter ce jeton. Dans l’image Docker, l’utilisateur du worker n’a aucun autre processus
// légitime : tout processus de cet utilisateur qui n’est ni le worker ni l’un de ses ancêtres est
// arrêté avant la commande. Les tâches sont traitées une à une : aucune commande du worker ne
// tourne à ce moment.

// Processus de l’utilisateur `uid` hors du processus `self` et de ses ancêtres.
export async function strayProcesses({ proc = '/proc', self = process.pid, uid = process.getuid?.() } = {}) {
  const parents = new Map(),
    owned = [];
  for (const name of await readdir(proc)) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try {
      status = await readFile(`${proc}/${name}/status`, 'utf8');
    } catch {
      continue; // Processus terminé entre-temps.
    }
    const pid = Number(name);
    parents.set(pid, Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]));
    // Uid : réel, effectif, sauvegardé, système de fichiers ; un seul suffit à le rattacher.
    const uids = (/^Uid:\s+(.+)$/m.exec(status)?.[1] || '').split(/\s+/).map(Number);
    if (uids.includes(uid)) owned.push(pid);
  }
  const ancestors = new Set();
  for (let pid = self; pid && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
  return owned.filter(pid => !ancestors.has(pid));
}

// Arrête ces processus (SIGKILL) ; renvoie leurs identifiants.
export async function stopStrays(options = {}, kill = process.kill) {
  const pids = await strayProcesses(options);
  for (const pid of pids)
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* Déjà terminé. */
    }
  return pids;
}
