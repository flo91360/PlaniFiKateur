import { readFile, rm } from 'node:fs/promises';

// Clés du worker. Dans l’image Docker, entrypoint.sh les retire de l’environnement avant de
// lancer le worker et les écrit dans un fichier privé, lu puis supprimé ici : elles ne restent
// qu’en mémoire et n’apparaissent jamais dans /proc/<pid>/environ, lisible par les processus
// du même utilisateur (commandes de l’agent, tests du projet).
export const SECRET_NAMES = [
  'PLANIFIKATEUR_AGENT_TOKEN',
  'PLANIFIKATEUR_GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

export async function withSecrets(env = process.env) {
  const file = env.PLANIFIKATEUR_WORKER_SECRETS;
  if (!file) return env;
  const values = {};
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const separator = line.indexOf('=');
    const name = line.slice(0, separator);
    if (separator > 0 && SECRET_NAMES.includes(name)) values[name] = line.slice(separator + 1);
  }
  await rm(file, { force: true });
  const { PLANIFIKATEUR_WORKER_SECRETS, ...rest } = env;
  return { ...rest, ...values };
}
