import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validId } from './config.mjs';

export function createState(root) {
  const directory = join(root, 'state');
  const file = id => {
    if (!validId(id)) throw new Error('Identifiant d’exécution invalide.');
    return join(directory, `${id}.json`);
  };
  return {
    async get(id) {
      try {
        return JSON.parse(await readFile(file(id), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
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
        return await Promise.all(
          (await readdir(directory)).filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5))),
        );
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  };
}
