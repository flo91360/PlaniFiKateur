import { setTimeout as delay } from 'node:timers/promises';
import { readWorkerConfig } from './config.mjs';
import { createWorker } from './worker.mjs';
import { checkClaudeSandbox, checkSandbox } from './sandbox-check.mjs';
import { connectionDiagnostic } from './clients.mjs';
import { checkIsolation } from './isolation.mjs';
import { withSecrets } from './secrets.mjs';

try {
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error('Usage : node worker/index.mjs [--once]');
  const config = readWorkerConfig(await withSecrets());
  await checkSandbox(config.stateRoot);
  // Bloquant : sans isolation, les tests du projet liraient l’état et les connexions du worker.
  console.log(`Isolation des commandes du projet : ${await checkIsolation(config)}.`);
  // Non bloquant : Claude Code peut encore modifier les fichiers, le worker lance les tests.
  await checkClaudeSandbox().catch(error => console.warn(`Avertissement : ${error.message}`));
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort(new Error('Arrêt du worker.')));
  process.on('SIGINT', () => stop.abort(new Error('Arrêt du worker.')));
  const worker = createWorker(config);
  const once = process.argv.includes('--once');
  console.log('Worker IA démarré : une tâche à la fois.');
  do {
    try {
      const result = await worker.tick(stop.signal);
      if (once && result.status === 'interrupted') process.exitCode = 1;
    } catch (error) {
      if (stop.signal.aborted) break;
      // No response body, process environment or model transcript in service logs.
      console.error(
        `Connexion du worker refusée ou indisponible (${connectionDiagnostic(error)}). Vérifiez la configuration du site et de GitHub.`,
      );
      if (once) process.exitCode = 1;
    }
    if (once || stop.signal.aborted) break;
    await delay(config.pollMs, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
