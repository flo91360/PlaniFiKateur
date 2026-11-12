// Installed worker code: never load delivery rules from the branch being changed.
// Registre des profils : chaque entrée déclare tout ce qui lui est propre, et le reste du worker
// s’en déduit sans tester les noms de profils.
// - repositories : noms de dépôt qui choisissent ce profil par défaut ;
// - versioning : fichier de version (npm : package.json et son lockfile, dans `directory` s’il est
//   donné, godot : project.godot), version du paquet Rust de `cargo` (Cargo.toml et Cargo.lock),
//   titre du changelog (`bracketed` : « ## [x.y.z] - date » ; `generated` : CHANGELOG.md fabriqué par
//   la CI du dépôt sur la branche cible, que le worker n’écrit pas et qu’une PR ne modifie pas) et
//   documents dont le numéro suit la version ;
// - instructions : consignes propres au projet ajoutées à la demande envoyée au modèle ;
// - protectedPaths : fichiers qu’une carte ne peut pas modifier, comme les workflows GitHub et
//   les scripts npm (configuration des tests, worker et livraison) : le worker les rétablit
//   avant de livrer (worker/protected.mjs) ;
// - environment : variables ajoutées aux commandes (hors du profil validé, qui reste comparable) ;
// - python : version minimale de python3 (avec venv) exigée de l’image du worker.
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
      'tests/autocorrectnepsy-profile.test.js',
      'tests/yakafaukon-profile.test.js',
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
    // Après chaque fusion, la CI de main publie la Release puis recopie CHANGELOG.md sur main
    // (« Journal des modifications : version … [skip ci] ») : le worker n’y écrit pas.
    versioning: { format: 'npm', changelog: 'generated' },
    protectedPaths: ['vitest.config.*', 'tsconfig*.json'],
    environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    instructions:
      'CHANGELOG.md est fabriqué par la CI du dépôt après chaque fusion : ne le modifie pas, le worker le reprend tel qu’il est sur main. Le worker augmente lui-même la version de package.json et package-lock.json. Décris la livraison en remplaçant entièrement la section « ## Prochaine version » de changements.md ; en cas de conflit sur ce fichier, cette section ne garde que les puces de cette carte, jamais celles venues de main.',
  },
  trameergo: {
    label: 'TrameErgo — Vue et Tauri',
    description: 'Node 22 · application tablette Vue 3 (Vitest, build) et installateur Windows Tauri sur GitHub',
    nodeMajor: 22,
    godotVersion: '',
    branch: 'main',
    installCommands: [['npm', 'ci', '--prefix', 'tablette']],
    testCommands: [
      ['npm', '--prefix', 'tablette', 'test'],
      ['npm', '--prefix', 'tablette', 'run', 'build'],
    ],
    workflow: { file: 'tablette.yml', name: 'Application tablette et Windows', jobs: ['tablette', 'build'] },
    repositories: ['trameergo'],
    versioning: { format: 'npm', directory: 'tablette', cargo: 'tablette/src-tauri', changelog: 'bracketed' },
    protectedPaths: ['tablette/vite.config.*', 'tablette/playwright.config.*', 'tablette/tsconfig*.json'],
    instructions:
      'L’application est dans tablette/ (Vue 3, TypeScript), empaquetée par Tauri pour Windows. Le CLAUDE.md du dépôt demande d’augmenter la version et de compléter CHANGELOG.md : ici le worker le fait lui-même, ne modifie donc ni les versions de tablette/package.json, src-tauri/Cargo.toml et Cargo.lock, ni CHANGELOG.md.',
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
  yakafaukon: {
    label: 'YaKaFauKon — Godot',
    description: 'Godot 4.7.2 · tests de logique, de jeu, de profils et d’écrans, exe Windows sur GitHub',
    nodeMajor: 24,
    godotVersion: '4.7.2',
    branch: 'main',
    installCommands: [['godot', '--headless', '--import']],
    testCommands: [
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/run_tests.gd'],
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/gameplay_test.gd'],
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/profile_test.gd'],
      ['godot', '--headless', '--path', '.', '--script', 'res://tests/flow_test.gd'],
    ],
    workflow: { file: 'build.yml', name: 'Construire le jeu', jobs: ['export'] },
    repositories: ['yakafaukon'],
    // La CI du dépôt exige une section « ## [x.y.z] » de CHANGELOG.md pour publier la Release.
    versioning: { format: 'godot', changelog: 'bracketed' },
    protectedPaths: ['tests/run_tests.gd', 'tests/gameplay_test.gd', 'tests/profile_test.gd', 'tests/flow_test.gd'],
    instructions:
      'Jeu Godot 4.7.2 (GDScript) pour apprendre la frappe au clavier en ergothérapie, joué par des enfants de 8 à 16 ans souvent dyslexiques ou TDAH : textes de l’interface simples, en français. Le code est dans scripts/ (core, world, ui, screens) et les données du jeu dans scripts/core/data.gd. Les quatre scripts de tests/ sont lancés par le worker et la CI ; tu peux ajouter des vérifications dans d’autres fichiers de tests/ appelés depuis le code testé, mais ne modifie pas ces quatre scripts. La CI fabrique YaKaFauKon.exe et publie la Release : ne range jamais d’exe ni de dossier build/ dans le dépôt. Laisse vides file_version et product_version dans export_presets.cfg. Le worker augmente lui-même config/version dans project.godot et complète CHANGELOG.md : ne les modifie pas.',
  },
  autocorrectnepsy: {
    label: 'AutoCorrectNEPSY — Python',
    description: 'Python 3 · tests pytest dans un environnement virtuel, exécutable Windows sur GitHub',
    nodeMajor: 24,
    godotVersion: '',
    branch: 'main',
    // Environnement virtuel dans .planifikateur/, exclu de Git par le worker ; installation
    // modifiable (-e) pour que les tests lisent le code modifié par l’agent.
    installCommands: [
      ['python3', '-m', 'venv', '.planifikateur/venv'],
      ['.planifikateur/venv/bin/python', '-m', 'pip', 'install', '-e', '.[test]'],
    ],
    testCommands: [['.planifikateur/venv/bin/python', '-m', 'pytest', '-q']],
    workflow: {
      file: 'tests.yml',
      name: 'Tests et exécutable Windows',
      jobs: [
        'Version',
        'Tests Python 3.10 (Linux)',
        'Tests Python 3.12 (Linux)',
        'Tests Python 3.12 (Windows)',
        'Exécutable Windows',
      ],
    },
    repositories: ['autocorrectnepsy'],
    versioning: { format: 'pyproject', modules: ['autocorrect_nepsy/__init__.py'], changelog: 'bracketed' },
    python: '3.10',
    // Le dépôt est public : son .gitignore tient à l’écart les scans et cotations d’enfants. Le
    // contrôle de version du job « Version » est protégé comme les workflows.
    protectedPaths: [
      '.gitignore',
      'pytest.ini',
      'tox.ini',
      'setup.cfg',
      'conftest.py',
      'packaging/verifier_version.py',
    ],
    environment: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    instructions:
      'Paquet Python autocorrect_nepsy/ (Python 3.10 ou plus, interface Tkinter), testé par pytest sur les dessins synthétiques de tests/synth.py. Les dépendances sont installées dans .planifikateur/venv : lance les tests avec .planifikateur/venv/bin/python -m pytest -q (les tests de l’interface sont ignorés faute d’écran ; la CI les rejoue sous Linux et Windows et construit AutoCorrectNEPSY.exe). Ce dépôt est public : n’y ajoute jamais de scan, de cotation d’enfant, de page du manuel ou du cahier de réponses, ni aucun PDF, image ou CSV réel. Le worker augmente lui-même la version (pyproject.toml et __version__ de autocorrect_nepsy/__init__.py) et complète CHANGELOG.md : ne les modifie pas et ne lance pas packaging/nouvelle_version.py.',
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
// CHANGELOG.md fabriqué sur la branche cible par la CI du dépôt (`changelog: 'generated'`).
export const generatedChangelog = profile => presetRules(profile).versioning?.changelog === 'generated';
// Fichiers que seule la branche cible fait évoluer, hors de toute PR : un commit de la branche cible
// qui ne touche qu’eux n’oblige pas à remettre à jour une PR qui ne les modifie pas.
export const targetOnlyPaths = profile => (generatedChangelog(profile) ? ['CHANGELOG.md'] : []);
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
