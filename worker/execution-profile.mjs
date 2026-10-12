// Installed worker code: never load delivery rules from the branch being changed.
export const executionPresets = {
  planifikateur: { label: 'PlaniFiKateur', description: 'Node 24 · tests serveur et navigateur', nodeMajor: 24, godotVersion: '', branch: 'main', installCommands: [['npm', 'ci']], testCommands: [['npm', 'test'], ['npm', 'run', 'test:browser']], workflow: { file: 'ci.yml', name: 'Tests', jobs: ['Tests serveur', 'Tests navigateur'] } },
  defilordi: { label: 'DefilOrdi — Electron', description: 'Node 22 · TypeScript, Vitest et fabrication Windows', nodeMajor: 22, godotVersion: '', branch: 'main', installCommands: [['npm', 'ci']], testCommands: [['npm', 'run', 'typecheck'], ['npm', 'test'], ['npm', 'run', 'build']], workflow: { file: 'build-windows.yml', name: 'Windows .exe', jobs: ['build'] } },
  funkart: { label: 'FunKart — Godot', description: 'Godot 4.4.1 · profils, course automatique et exports', nodeMajor: 24, godotVersion: '4.4.1', branch: 'main', installCommands: [['godot', '--headless', '--import']], testCommands: [['godot', '--headless', '--path', '.', '--script', 'res://tests/test_profiles.gd'], ['godot', '--headless', '--path', '.', '--script', 'res://tests/autoplay.gd', '--', '--fast']], workflow: { file: 'build.yml', name: 'Construire le jeu', jobs: ['export'] } },
};
export function defaultExecutionProfile(repository = '') {
  const name = repository.split('/').at(-1).toLowerCase();
  return validateExecutionProfile({ preset: name === 'defilordi' || name === 'funkart' ? name : 'planifikateur' });
}
export function validateExecutionProfile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(executionPresets, data.preset)) throw new Error('Profil d’exécution invalide.');
  const defaults = executionPresets[data.preset];
  const branch = data.branch ?? defaults.branch;
  if (typeof branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('Branche cible invalide.');
  const commands = (value, fallback) => {
    const selected = value ?? fallback;
    if (!Array.isArray(selected) || !selected.length || selected.length > 20 || selected.some(command => !Array.isArray(command) || !command.length || command.length > 30 || command.some(arg => typeof arg !== 'string' || !arg || arg.length > 2000 || /[\0\r\n]/.test(arg)))) throw new Error('Les commandes du profil doivent être des tableaux d’arguments.');
    return structuredClone(selected);
  };
  const workflow = data.workflow ?? defaults.workflow;
  if (!workflow || typeof workflow !== 'object' || typeof workflow.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\.ya?ml$/.test(workflow.file) || typeof workflow.name !== 'string' || !workflow.name.trim() || workflow.name.length > 120 || !Array.isArray(workflow.jobs) || !workflow.jobs.length || workflow.jobs.length > 20 || workflow.jobs.some(name => typeof name !== 'string' || !name.trim() || name.length > 120) || new Set(workflow.jobs).size !== workflow.jobs.length) throw new Error('Contrôles GitHub du profil invalides.');
  return { preset: data.preset, branch, nodeMajor: defaults.nodeMajor, godotVersion: defaults.godotVersion, installCommands: commands(data.installCommands, defaults.installCommands), testCommands: commands(data.testCommands, defaults.testCommands), workflow: structuredClone(workflow) };
}
