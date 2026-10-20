// Installed worker code: never load delivery rules from the branch being changed.
// Registre des profils : chaque entrée déclare tout ce qui lui est propre, et le reste du worker
// s’en déduit sans tester les noms de profils.
// - repositories : noms de dépôt qui choisissent ce profil par défaut ;
// - versioning : fichier de version (npm : package.json et son lockfile, godot : project.godot,
//   qmake : l’unique fichier .pro) et documents dont le numéro suit la version ;
// - instructions : consignes propres au projet ajoutées à la demande envoyée au modèle ;
// - protectedPaths : fichiers qu’une carte ne peut pas modifier, comme les workflows GitHub et
//   les scripts npm (configuration des tests, worker et livraison) : le worker les rétablit
//   avant de livrer (worker/protected.mjs) ;
// - environment : variables ajoutées aux commandes (hors du profil validé, qui reste comparable).
export const executionPresets = {
  planifikateur: {
    label: 'PlaniFiKateur',
    description: 'Node 24 · tests serveur et navigateur',
    nodeMajor: 24,
    godotVersion: '',
    branch: 'main',
    installCommands: [['npm', 'ci']],
    testCommands: [
      ['npm', 'test'],
      ['npm', 'run', 'test:browser'],
    ],
    workflow: { file: 'ci.yml', name: 'Tests', jobs: ['Tests serveur', 'Tests navigateur'] },
    repositories: ['planifikateur'],
    versioning: { format: 'npm', documents: ['README.md', 'docs/agents.md', 'docs/github.md'] },
    // Le worker est redéployé automatiquement depuis main : ni lui, ni sa chaîne de livraison, ni
    // les consignes des agents et leurs tests ne sont modifiables par une carte.
    protectedPaths: [
      'playwright.config.*',
      'eslint.config.*',
      '.prettierrc*',
      '.prettierignore',
      'worker/**',
      '.dockerignore',
      'scripts/delivery.mjs',
      'scripts/merge-agent-pr.mjs',
      'scripts/publish-version.mjs',
      'scripts/verify-deployment.mjs',
      'AGENTS.md',
      'CLAUDE.md',
      'tests/worker*.test.js',
      'tests/execution-profiles.test.js',
      'tests/trameergo-profile.test.js',
      'tests/delivery.test.js',
      'tests/deploy.test.js',
      'tests/deploy/**',
    ],
  },
  defilordi: {
    label: 'DefilOrdi — Electron',
    description: 'Node 22 · TypeScript, Vitest et fabrication Windows',
    nodeMajor: 22,
    godotVersion: '',
    branch: 'main',
    installCommands: [['npm', 'ci']],
    testCommands: [
      ['npm', 'run', 'typecheck'],
      ['npm', 'test'],
      ['npm', 'run', 'build'],
    ],
    workflow: { file: 'build-windows.yml', name: 'Windows .exe', jobs: ['build'] },
    repositories: ['defilordi'],
    versioning: { format: 'npm' },
    protectedPaths: ['vitest.config.*', 'tsconfig*.json'],
    environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  },
  trameergo: {
    label: 'TrameErgo — Qt Windows',
    description: 'C++ Qt 6 et ActiveQt (Word) · cohérence du projet ici, compilation Windows sur GitHub',
    nodeMajor: 24,
    godotVersion: '',
    branch: 'main',
    installCommands: [['python3', '--version']],
    testCommands: [['python3', '@worker/checks/qt_project.py']],
    workflow: { file: 'build-windows.yml', name: 'Windows .exe', jobs: ['build'] },
    repositories: ['trameergo'],
    versioning: { format: 'qmake' },
    instructions:
      'Un formulaire Qt Designer demandé en fichier téléchargeable est un véritable document XML <ui version="4.0">, ouvrable dans Qt Designer, avec les champs demandés.',
  },
  funkart: {
    label: 'FunKart — Godot',
    description: 'Godot 4.4.1 · profils, course automatique et exports',
    nodeMajor: 24,
    godotVersion: '4.4.1',
    branch: 'main',
    installCommands: [['godot', '--headless', '--import']],
    testCommands: [
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/test_profiles.gd'],
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/autoplay.gd', '--', '--fast'],
    ],
    workflow: { file: 'build.yml', name: 'Construire le jeu', jobs: ['export'] },
    repositories: ['funkart'],
    versioning: { format: 'godot' },
    protectedPaths: ['tests/test_profiles.gd', 'tests/autoplay.gd'],
  },
};
// Profil par défaut d’un dépôt : celui qui le déclare dans `repositories`, sinon PlaniFiKateur.
export function defaultExecutionProfile(repository = '') {
  const name = repository.split('/').at(-1).toLowerCase();
  const preset = Object.keys(executionPresets).find(key => executionPresets[key].repositories?.includes(name));
  return validateExecutionProfile({ preset: preset || 'planifikateur' });
}
// Règles installées d’un profil validé (versionnage, consignes, environnement), jamais celles
// d’un profil reçu du site.
export const presetRules = profile => executionPresets[profile?.preset] || {};
// Profil réellement exécuté par le worker : seuls le preset et la branche viennent du site ; les
// commandes et les contrôles GitHub sont ceux des presets installés avec ce worker. Un site
// compromis ou un profil enregistré par une version précédente ne peut donc pas imposer de commande.
export function installedProfile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Profil d’exécution invalide.');
  return validateExecutionProfile({ preset: data.preset, branch: data.branch });
}
// "@worker/…" désigne un contrôle installé avec le worker, jamais un fichier du dépôt modifié.
export function resolveWorkerCommand(command, workerDirectory) {
  return command.map(arg =>
    arg.startsWith('@worker/') && !arg.includes('..') ? `${workerDirectory}/${arg.slice('@worker/'.length)}` : arg,
  );
}
export function validateExecutionProfile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(executionPresets, data.preset))
    throw new Error('Profil d’exécution invalide.');
  const defaults = executionPresets[data.preset];
  const branch = data.branch ?? defaults.branch;
  if (
    typeof branch !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  )
    throw new Error('Branche cible invalide.');
  const commands = (value, fallback) => {
    const selected = value ?? fallback;
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 20 ||
      selected.some(
        command =>
          !Array.isArray(command) ||
          !command.length ||
          command.length > 30 ||
          command.some(arg => typeof arg !== 'string' || !arg || arg.length > 2000 || /[\0\r\n]/.test(arg)),
      )
    )
      throw new Error('Les commandes du profil doivent être des tableaux d’arguments.');
    return structuredClone(selected);
  };
  const workflow = data.workflow ?? defaults.workflow;
  if (
    !workflow ||
    typeof workflow !== 'object' ||
    typeof workflow.file !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\.ya?ml$/.test(workflow.file) ||
    typeof workflow.name !== 'string' ||
    !workflow.name.trim() ||
    workflow.name.length > 120 ||
    !Array.isArray(workflow.jobs) ||
    !workflow.jobs.length ||
    workflow.jobs.length > 20 ||
    workflow.jobs.some(name => typeof name !== 'string' || !name.trim() || name.length > 120) ||
    new Set(workflow.jobs).size !== workflow.jobs.length
  )
    throw new Error('Contrôles GitHub du profil invalides.');
  return {
    preset: data.preset,
    branch,
    nodeMajor: defaults.nodeMajor,
    godotVersion: defaults.godotVersion,
    installCommands: commands(data.installCommands, defaults.installCommands),
    testCommands: commands(data.testCommands, defaults.testCommands),
    workflow: structuredClone(workflow),
  };
}
