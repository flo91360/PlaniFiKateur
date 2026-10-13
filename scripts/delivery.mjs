import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDelivery, verifyDelivery } from '../worker/delivery.mjs';
import { validateExecutionProfile } from '../worker/execution-profile.mjs';

const exec = promisify(execFile);
export const gitCommand = cwd => async args => (await exec(args[0], args.slice(1), { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
export async function delivery(args = process.argv.slice(2), env = process.env) {
  const options = {}, mode = args.shift();
  if (!['prepare', 'check'].includes(mode)) throw new Error('Utilisez delivery.mjs prepare ou check.');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--id','--title','--summary','--preset','--branch','--base','--root'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Argument de livraison invalide.');
    options[args[i]] = args[i + 1];
  }
  const cwd = resolve(options['--root'] || '.'), command = gitCommand(cwd);
  const profile = validateExecutionProfile({ preset: options['--preset'] || 'planifikateur', branch: options['--branch'] || 'main' });
  if (mode === 'prepare' && (!options['--id'] || !options['--title']?.trim() || !options['--summary']?.trim())) throw new Error('La préparation exige --id, --title et --summary.');
  const result = mode === 'prepare'
    ? await prepareDelivery(cwd, profile, command, { runId: options['--id'], title: options['--title'], summary: options['--summary'] })
    : await verifyDelivery(cwd, profile, command, options['--base'] || env.DELIVERY_BASE || `origin/${profile.branch}`);
  console.log(`Livraison ${result.version} : version, lockfile et changelog vérifiés.`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) delivery().catch(error => { console.error(error.message); process.exitCode = 1; });
