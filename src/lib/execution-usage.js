const number = new Intl.NumberFormat('fr-FR');
const duration = ms => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'moins d’une minute';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
};
// Consommation de l’exécution : tentatives, durée, tokens et coût estimé quand le moteur le fournit.
export const usageText = usage => {
  if (!usage) return '';
  const parts = [
    `${usage.attempts} tentative${usage.attempts > 1 ? 's' : ''}`,
    duration(usage.durationMs),
    `${number.format(usage.inputTokens)} tokens en entrée${usage.cachedInputTokens ? ` (dont ${number.format(usage.cachedInputTokens)} en cache)` : ''}`,
    `${number.format(usage.outputTokens)} en sortie`,
  ];
  if (usage.costUsd !== null)
    parts.push(`coût estimé ${usage.costUsd.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' })}`);
  return `Consommation : ${parts.join(' · ')}.`;
};
