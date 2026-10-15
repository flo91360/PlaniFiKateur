export const efforts = {
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  'claude-code': ['', 'low', 'medium', 'high', 'xhigh', 'max'],
};
// Effort appliqué à une carte qui n’en précise pas : celui que l’interface affiche et propose.
export const defaultEffort = 'medium';
export const effortLabels = {
  '': 'Par défaut',
  minimal: 'Minimal',
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Très élevé',
  max: 'Maximum',
  ultra: 'Ultra',
  persistent: 'Persistant',
};
export function validateAi(data = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Paramètres IA invalides.');
  const { engine = 'codex', model = '' } = data;
  if (
    !Object.hasOwn(efforts, engine) ||
    typeof model !== 'string' ||
    model.length > 160 ||
    (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model))
  )
    throw new Error('Moteur ou identifiant de modèle invalide.');
  return { engine, model };
}
