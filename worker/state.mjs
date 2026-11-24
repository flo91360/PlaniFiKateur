import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validId } from './config.mjs';

// Un fichier illisible (écriture coupée, disque plein) est mis de côté sous `<id>.json.corrupt` :
// les autres tâches restent suivies, et celle-ci repart de GitHub et du site à sa prochaine reprise.
// Les tâches terminées (et les fichiers mis de côté) sont effacées après `RETENTION_MS` sans
// changement : le suivi, qui relit tout le dossier, ne ralentit pas avec les mois.
export const RETENTION_MS = 7 * 24 * 3600000;
const TERMINAL = new Set(['done', 'cancelled']);

export function createState(root, { log = console.log } = {}) {
  const directory = join(root, 'state');
  const file = id => {
    if (!validId(id)) throw new Error('Identifiant d’exécution invalide.');
    return join(directory, `${id}.json`);
  };
  return {
    async get(id) {
      let text;
      try {
        text = await readFile(file(id), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      try {
        const job = JSON.parse(text);
        if (job && typeof job === 'object' && job.id === id) return job;
      } catch {}
      await rename(file(id), `${file(id)}.corrupt`).catch(() => {});
      log(`Exécution ${id} : état local illisible, mis de côté (${id}.json.corrupt).`);
      return null;
    },
    async put(job) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // No lease or access token is persisted. A restart must reclaim via the API.
      const target = file(job.id),
        temporary = `${target}.tmp`;
      await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
      await rename(temporary, target);
    },
    // Efface les tâches terminées et les fichiers illisibles inchangés depuis `retentionMs`.
    async prune({ now = Date.now(), retentionMs = RETENTION_MS } = {}) {
      let names;
      try {
        names = await readdir(directory);
      } catch (e) {
        if (e.code === 'ENOENT') return 0;
        throw e;
      }
      let removed = 0;
      for (const name of names) {
        const path = join(directory, name);
        const corrupt = name.endsWith('.json.corrupt');
        if (!corrupt && !(name.endsWith('.json') && validId(name.slice(0, -5)))) continue;
        const info = await stat(path).catch(() => null);
        if (!info || now - info.mtimeMs < retentionMs) continue;
        if (!corrupt) {
          const job = await this.get(name.slice(0, -5));
          if (!job || !TERMINAL.has(job.phase)) continue;
        }
        await rm(path, { force: true });
        removed++;
      }
      return removed;
    },
    async all() {
      try {
        const jobs = await Promise.all(
          (await readdir(directory))
            .filter(f => f.endsWith('.json') && validId(f.slice(0, -5)))
            .map(f => this.get(f.slice(0, -5))),
        );
        return jobs.filter(Boolean);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}
