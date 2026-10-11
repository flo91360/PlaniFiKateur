import { setTimeout as delay } from 'node:timers/promises';
import { readWorkerConfig } from './config.mjs';
import { createWorker } from './worker.mjs';
import { checkSandbox } from './sandbox-check.mjs';

try {
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error('Usage : node worker/index.mjs [--once]');
  const config = readWorkerConfig();
  await checkSandbox(config.stateRoot);
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort(new Error('Arrêt du worker.')));
  process.on('SIGINT', () => stop.abort(new Error('Arrêt du worker.')));
  const worker = createWorker(config);
  const once = process.argv.includes('--once');
  console.log('Worker Codex démarré : une tâche à la fois.');
  do {
    try {
      const result = await worker.tick(stop.signal);
      if (once && result.status === 'interrupted') process.exitCode = 1;
    } catch (error) {
      if (stop.signal.aborted) break;
      // No response body, process environment or model transcript in service logs.
      console.error('Connexion du worker refusée ou indisponible. Vérifiez la configuration du site et de GitHub.');
      if (once) process.exitCode = 1;
    }
    if (once || stop.signal.aborted) break;
    await delay(config.pollMs, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} catch (error) { console.error(error.message); process.exitCode = 1; }
