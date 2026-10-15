import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from './commands.mjs';

// Commandes du projet (installation, tests) : elles exécutent le code de la branche modifiée
// par l’agent, donc rien de ce qu’elles lisent ou écrivent ne doit atteindre le worker.
// Avec PLANIFIKATEUR_WORKER_ISOLATION=bwrap (image Docker), chacune tourne dans bubblewrap :
// - nouvel espace de processus avec son propre /proc : le worker et ses variables sont invisibles ;
// - bwrap est lancé avec l’environnement déjà filtré (sans clé), qu’il transmet tel quel ;
// - système en lecture seule, dossier d’état du worker masqué (autres tâches, état local,
//   connexions Codex et Claude) ; seuls le checkout et le cache npm restent modifiables ;
// - .git du checkout en lecture seule : ni hook ni configuration Git ne peuvent être posés.
export const ISOLATION_MODES = ['bwrap', 'none'];

export function isolatedCommand(command, { config, cwd, writable = [] }) {
  if (config.isolation !== 'bwrap') return command;
  // Un dossier absent n’a rien à cacher ; un dossier inclus dans un autre est déjà masqué.
  const hidden = [config.stateRoot, config.codexHome, config.claudeHome].filter(
    (path, index, all) =>
      existsSync(path) &&
      all.indexOf(path) === index &&
      !all.some(other => other !== path && path.startsWith(`${other}/`)),
  );
  return [
    'bwrap',
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--share-net',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--tmpfs',
    '/dev/shm',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    ...hidden.flatMap(path => ['--tmpfs', path]),
    ...[cwd, ...writable].flatMap(path => ['--bind', path, path]),
    '--ro-bind',
    join(cwd, '.git'),
    join(cwd, '.git'),
    '--chdir',
    cwd,
    '--',
    ...command,
  ];
}

// Contrôle au démarrage : une commande isolée ne voit ni l’environnement du worker, ni son état,
// et ne peut écrire ni dans .git ni hors du checkout.
export async function checkIsolation(config, execute = runCommand) {
  if (config.isolation !== 'bwrap') return 'désactivée (PLANIFIKATEUR_WORKER_ISOLATION=none)';
  await mkdir(config.stateRoot, { recursive: true });
  const root = await mkdtemp(join(config.stateRoot, 'isolation-check-'));
  try {
    const cwd = join(root, 'checkout');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const probe = [
      'sh',
      '-c',
      'test ! -e "$1" && ! touch .git/probe 2>/dev/null && ! touch /opt/probe 2>/dev/null && touch allowed && [ "$(head -c 5 /proc/1/cmdline)" = bwrap ] && echo isolation-ok',
      'probe',
      join(root, 'hidden'),
    ];
    await mkdir(join(root, 'hidden'));
    const result = await execute(isolatedCommand(probe, { config, cwd }), {
      cwd,
      env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    });
    if (result.code !== 0 || !result.output.includes('isolation-ok'))
      throw new Error(
        `Isolation des commandes du projet indisponible (bubblewrap) : ${String(result.output).trim().slice(-300)}`,
      );
    return 'bubblewrap : processus, état du worker et .git isolés';
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
