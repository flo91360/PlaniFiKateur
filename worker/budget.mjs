// Plafond de dépense IA d’une exécution. Il couvre les appels au modèle depuis la dernière
// intervention humaine (réponse à une question, corrections demandées) ou, à défaut, depuis le
// début de l’exécution : une réponse sur la carte accorde une nouvelle tranche. Claude Code
// rapporte un coût estimé en dollars, plafonné aussi pendant l’appel (maxBudgetUsd) ; Codex ne
// rapporte que des tokens, comparés au plafond entre deux appels.

export class BudgetExceededError extends Error {
  constructor() {
    super('Plafond de dépense IA atteint pendant l’appel au modèle.');
    this.name = 'BudgetExceededError';
  }
}

const humanDate = run =>
  Math.max(
    0,
    ...(run.exchanges || []).map(exchange => Date.parse(exchange.answer?.date) || 0),
    ...(run.submissions || []).map(submission =>
      submission.decision?.accepted === false ? Date.parse(submission.decision.date) || 0 : 0,
    ),
  );

// Consommation depuis la dernière intervention humaine : tentatives précédentes enregistrées sur
// le site, plus `current`, celle de la tentative en cours (la dernière de `run.attempts`).
export function aiSpending(run, current) {
  const since = humanDate(run);
  const attempts = (run.attempts || []).slice(0, -1).filter(attempt => Date.parse(attempt.startedAt) >= since);
  const sum = field =>
    attempts.reduce((total, attempt) => total + (attempt.usage?.[field] || 0), 0) + (current?.[field] || 0);
  return { since, costUsd: sum('costUsd'), tokens: sum('inputTokens') + sum('outputTokens') };
}

const amount = value => value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const millions = value => (value / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 });

// État du plafond pour le prochain appel : `remainingUsd` borne un appel Claude Code ; `question`
// est posée sur la carte quand le plafond est atteint, ou dès que le SDK a arrêté l’appel
// (`exceeded`), null sinon. Un plafond à 0 est désactivé.
export function aiBudget(config, engine, run, current, { discussion = false, exceeded = false } = {}) {
  const spent = aiSpending(run, current);
  const since = spent.since ? 'depuis la dernière réponse' : 'depuis le début de l’exécution';
  const next = discussion
    ? 'Posez de nouveau la question dans un nouveau commentaire pour relancer l’agent avec un nouveau plafond.'
    : 'Répondez pour autoriser une nouvelle tranche, en précisant si besoin ce qui reste à faire, ou annulez l’exécution.';
  const claude = engine === 'claude-code',
    cap = claude ? config.maxCostUsd : config.maxTokens;
  if (!(cap > 0))
    return { question: exceeded ? `Plafond de dépense IA atteint pendant l’appel au modèle. ${next}` : null };
  const remainingUsd = claude ? Math.max(0, cap - spent.costUsd) : undefined;
  if (!exceeded && (claude ? remainingUsd >= 0.01 : spent.tokens < cap)) return { question: null, remainingUsd };
  return {
    question: claude
      ? `Plafond de dépense IA atteint pour cette exécution : ${amount(spent.costUsd)} $ estimés ${since}, pour un plafond de ${amount(cap)} $ (PLANIFIKATEUR_WORKER_MAX_COST_USD). ${next}`
      : `Plafond de consommation IA atteint pour cette exécution : ${millions(spent.tokens)} millions de tokens ${since}, pour un plafond de ${millions(cap)} millions (PLANIFIKATEUR_WORKER_MAX_TOKENS). ${next}`,
  };
}
