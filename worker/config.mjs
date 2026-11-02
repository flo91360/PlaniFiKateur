import { resolve } from 'node:path';
import { ISOLATION_MODES } from './isolation.mjs';

export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
export const validRepository = value =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) && value.length <= 200;

export function readWorkerConfig(env = process.env) {
  const required = name => {
    if (!env[name]?.trim()) throw new Error(`${name} est requis.`);
    return env[name].trim();
  };
  const origin = new URL(required('PLANIFIKATEUR_URL'));
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !['https:', 'http:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  )
    throw new Error('PLANIFIKATEUR_URL : origine HTTPS requise (HTTP accepté uniquement en local).');
  const discovery = env.PLANIFIKATEUR_WORKER_DISCOVERY || 'auto';
  if (!['auto', 'manual'].includes(discovery)) throw new Error('PLANIFIKATEUR_WORKER_DISCOVERY : auto ou manual.');
  const projectIds = [
    ...new Set(
      (env.PLANIFIKATEUR_WORKER_PROJECTS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    ),
  ];
  const repositories = [
    ...new Set(
      (env.PLANIFIKATEUR_WORKER_REPOSITORIES || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (discovery === 'manual' && (!projectIds.length || !repositories.length))
    throw new Error('Le mode manual exige les projets et les dépôts autorisés.');
  if (projectIds.length > 100 || projectIds.some(id => !validId(id)))
    throw new Error('PLANIFIKATEUR_WORKER_PROJECTS : identifiants de projets séparés par des virgules.');
  if (repositories.some(repo => !validRepository(repo)))
    throw new Error('PLANIFIKATEUR_WORKER_REPOSITORIES : propriétaire/dépôt, séparés par des virgules.');
  const number = (name, fallback, min, max) => {
    const n = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} invalide.`);
    return n;
  };
  // Montant en dollars, décimales admises ; 0 désactive le plafond correspondant.
  const dollars = (name, fallback, max) => {
    const n = env[name] === undefined ? fallback : env[name].trim() ? Number(env[name]) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} invalide.`);
    return n;
  };
  const commands = (name, fallback) => {
    let value;
    try {
      value = env[name] ? JSON.parse(env[name]) : fallback;
    } catch {
      throw new Error(`${name} : tableau JSON de commandes requis.`);
    }
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.some(c => !Array.isArray(c) || !c.length || c.some(a => typeof a !== 'string' || !a || a.includes('\0')))
    )
      throw new Error(`${name} : utilisez [["npm","test"],…].`);
    return value;
  };
  const stateRoot = resolve(env.PLANIFIKATEUR_WORKER_STATE_DIR || '.data/worker');
  // bwrap dans l’image Docker ; none pour un worker de développement sans bubblewrap.
  const isolation = env.PLANIFIKATEUR_WORKER_ISOLATION || 'none';
  if (!ISOLATION_MODES.includes(isolation)) throw new Error('PLANIFIKATEUR_WORKER_ISOLATION : bwrap ou none.');
  // 1 dans l’image Docker, où l’utilisateur du worker n’a pas d’autre processus : ceux qui restent
  // sont arrêtés avant une commande Git distante (worker/strays.mjs).
  const stopStrays = env.PLANIFIKATEUR_WORKER_STOP_STRAYS || '0';
  if (!['0', '1'].includes(stopStrays)) throw new Error('PLANIFIKATEUR_WORKER_STOP_STRAYS : 0 ou 1.');
  return {
    origin: origin.origin,
    token: required('PLANIFIKATEUR_AGENT_TOKEN'),
    githubToken: required('PLANIFIKATEUR_GITHUB_TOKEN'),
    apiKey: env.OPENAI_API_KEY || env.CODEX_API_KEY,
    projectIds,
    repositories,
    stateRoot,
    isolation,
    stopStrays: stopStrays === '1',
    discovery,
    node22Bin: resolve(env.PLANIFIKATEUR_NODE22_BIN || '/opt/node22/bin'),
    codexHome: resolve(env.CODEX_HOME || `${stateRoot}/codex`),
    model: env.PLANIFIKATEUR_CODEX_MODEL || undefined,
    claudeApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    claudeHome: resolve(env.CLAUDE_CONFIG_DIR || `${stateRoot}/claude`),
    pollMs: number('PLANIFIKATEUR_WORKER_POLL_MS', 10000, 1000, 60000),
    // Quota de l’API GitHub (5 000 requêtes par heure et par token) : une PR en attente de fusion est
    // relue à chaque changement de son exécution sur le site, sinon au plus à cet intervalle.
    githubPollMs: number('PLANIFIKATEUR_WORKER_GITHUB_POLL_MS', 60000, 0, 10 * 60000),
    // Contrôle complet de la configuration d’un projet prêt (outils, dépôt, workflow GitHub) ; un
    // projet à compléter est revérifié au moins toutes les 2 min, une configuration modifiée aussitôt.
    diagnosticMs: number('PLANIFIKATEUR_WORKER_DIAGNOSTIC_MS', 15 * 60000, 0, 60 * 60000),
    heartbeatMs: number('PLANIFIKATEUR_WORKER_HEARTBEAT_MS', 60000, 1000, 120000),
    taskTimeoutMs: number('PLANIFIKATEUR_WORKER_TIMEOUT_MS', 60 * 60000, 1000, 2 * 60 * 60000),
    setupTimeoutMs: number('PLANIFIKATEUR_WORKER_SETUP_TIMEOUT_MS', 15 * 60000, 1000, 2 * 60 * 60000),
    modelTimeoutMs: number('PLANIFIKATEUR_WORKER_MODEL_TIMEOUT_MS', 30 * 60000, 1000, 2 * 60 * 60000),
    testsTimeoutMs: number('PLANIFIKATEUR_WORKER_TESTS_TIMEOUT_MS', 30 * 60000, 1000, 2 * 60 * 60000),
    publicationTimeoutMs: number('PLANIFIKATEUR_WORKER_PUBLICATION_TIMEOUT_MS', 10 * 60000, 1000, 2 * 60 * 60000),
    maxAttempts: number('PLANIFIKATEUR_WORKER_MAX_ATTEMPTS', 3, 1, 10),
    // Plafonds de consommation IA d’une exécution entre deux interventions humaines (worker/budget.mjs) :
    // coût estimé pour Claude Code, tokens d’entrée et de sortie pour Codex. 0 désactive le plafond.
    maxCostUsd: dollars('PLANIFIKATEUR_WORKER_MAX_COST_USD', 10, 10000),
    maxTokens: number('PLANIFIKATEUR_WORKER_MAX_TOKENS', 20000000, 0, 10000000000),
    installCommands: commands('PLANIFIKATEUR_WORKER_INSTALL_COMMANDS', [['npm', 'ci']]),
    testCommands: commands('PLANIFIKATEUR_WORKER_TEST_COMMANDS', [
      ['npm', 'test'],
      ['npm', 'run', 'test:browser'],
    ]),
  };
}
