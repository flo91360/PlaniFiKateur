import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validId } from './config.mjs';

// Un fichier illisible (écriture coupée, disque plein) est mis de côté sous `<id>.json.corrupt` :
// les autres tâches restent suivies, et celle-ci repart de GitHub et du site à sa prochaine reprise.
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
