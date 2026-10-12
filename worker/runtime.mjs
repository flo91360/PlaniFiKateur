import { dirname, join, delimiter } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { commandEnvironment } from './commands.mjs';
import { validateExecutionProfile } from './execution-profile.mjs';
import { parse } from 'yaml';
import picomatch from 'picomatch';

export function checkWorkflowTrigger(contents, branch) {
  let document;
  try { if (contents.length > 128000) throw new Error(); document = parse(contents); }
  catch { throw new Error('Le fichier du workflow est trop volumineux ou son YAML est invalide.'); }
  const on = document?.on;
  if (on === 'pull_request' || Array.isArray(on) && on.includes('pull_request')) return;
  if (!on || typeof on !== 'object' || !Object.hasOwn(on, 'pull_request')) throw new Error('Le workflow doit se déclencher sur les pull requests.');
  const trigger = on.pull_request || {};
  if (trigger.paths || trigger['paths-ignore']) throw new Error('Les contrôles de livraison doivent couvrir toutes les PR, sans filtre de chemins.');
  const patterns = trigger.branches;
  let included = !patterns;
  if (patterns) {
    if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string' || !pattern)) throw new Error('Filtre de branches GitHub invalide.');
    for (const pattern of patterns) {
      const negative = pattern.startsWith('!');
      if (picomatch(negative ? pattern.slice(1) : pattern, { dot: true })(branch)) included = !negative;
    }
  }
  const excluded = trigger['branches-ignore'];
  if (excluded && (!Array.isArray(excluded) || excluded.some(pattern => typeof pattern !== 'string'))) throw new Error('Filtre de branches GitHub invalide.');
  if (!included || excluded?.some(pattern => picomatch(pattern, { dot: true })(branch))) throw new Error('Le workflow des PR ne couvre pas la branche cible de ce projet.');
}

export function runtimeEnvironment(profile, config) {
  const bin = profile.nodeMajor === 22 ? config.node22Bin : dirname(process.execPath);
  return { ...commandEnvironment(), PATH: `${bin}${delimiter}${process.env.PATH || ''}`, ...(profile.preset === 'defilordi' ? { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } : {}) };
}
export async function checkRuntime(profile, config, execute, signal) {
  const home = join(config.stateRoot, 'runtime-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = { ...runtimeEnvironment(profile, config), HOME: home };
  const node = await execute(['node', '--version'], { cwd: config.stateRoot, env, signal });
  if (node.code !== 0 || !node.output.trim().startsWith(`v${profile.nodeMajor}.`)) throw new Error(`Node ${profile.nodeMajor} est requis pour ce projet. Mettez à jour l’image du worker.`);
  if (profile.godotVersion) {
    const godot = await execute(['godot', '--version'], { cwd: config.stateRoot, env, signal });
    if (godot.code !== 0 || !godot.output.split('\n').some(line => line.trim().startsWith(`${profile.godotVersion}.`))) throw new Error(`Godot ${profile.godotVersion} est requis pour ce projet. Mettez à jour l’image du worker.`);
  }
  return env;
}
export async function projectDiagnostic(project, config, github, execute, signal) {
  const checks = [];
  const check = async (name, callback) => {
    try { checks.push({ name, state: 'ok', message: await callback() }); }
    catch (error) { checks.push({ name, state: 'blocked', message: error.message.slice(0, 600) }); }
  };
  await check('Outils du projet', async () => {
    await checkRuntime(validateExecutionProfile(project.executionProfile), config, execute, signal);
    return `Node ${project.executionProfile.nodeMajor}${project.executionProfile.godotVersion ? ` · Godot ${project.executionProfile.godotVersion}` : ''} disponibles.`;
  });
  await check('Authentification IA', async () => {
    if (project.ai.engine === 'claude-code') {
      if (!config.claudeApiKey && !config.claudeOauthToken) throw new Error('Configurez l’authentification Anthropic dans l’environnement privé du worker.');
    } else if (!config.apiKey) {
      try { await access(join(config.codexHome, 'auth.json')); } catch { throw new Error('Configurez une clé API OpenAI ou une connexion Codex sur le worker.'); }
    }
    return 'Authentification configurée ; son accès au modèle sera vérifié lors de l’exécution.';
  });
  await check('Dépôt GitHub', async () => {
    if (!project.repository) throw new Error('Associez un dépôt GitHub au projet.');
    await github.request(`/repos/${project.repository}`, 'GET', undefined, signal);
    await github.request(`/repos/${project.repository}/branches/${encodeURIComponent(project.executionProfile.branch)}`, 'GET', undefined, signal);
    return `Dépôt et branche ${project.executionProfile.branch} accessibles.`;
  });
  if (project.repository) await check('Contrôles GitHub', async () => {
    const workflow = await github.request(`/repos/${project.repository}/actions/workflows/${project.executionProfile.workflow.file}`, 'GET', undefined, signal);
    if (workflow.state !== 'active' || workflow.name !== project.executionProfile.workflow.name) throw new Error('Le workflow du profil est absent, désactivé ou porte un autre nom.');
    const contents = await github.request(`/repos/${project.repository}/contents/.github/workflows/${project.executionProfile.workflow.file}?ref=${encodeURIComponent(project.executionProfile.branch)}`, 'GET', undefined, signal);
    if (contents.encoding !== 'base64') throw new Error('Fichier du workflow GitHub indisponible.');
    checkWorkflowTrigger(Buffer.from(contents.content, 'base64').toString('utf8'), project.executionProfile.branch);
    return `Workflow ${workflow.name} disponible pour les PR.`;
  });
  checks.push({ name: 'Notification de fusion', state: project.webhookConfigured ? 'unknown' : 'blocked', message: project.webhookConfigured ? 'Secret du site configuré ; la réception du webhook de ce dépôt sera confirmée à la première livraison.' : 'Le secret de webhook GitHub doit être configuré sur le site.' });
  return { state: checks.some(check => check.state === 'blocked') ? 'blocked' : 'ready', checks };
}
