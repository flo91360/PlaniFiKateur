import { fail } from '../http.js';

// Consommation d’une tentative rapportée par le worker (cumul depuis le début de la tentative) :
// tokens d’entrée, dont lus en cache, tokens de sortie, coût estimé en dollars quand le moteur le
// fournit (Claude), durée du modèle en millisecondes.
const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'costUsd', 'durationMs'];
const MAX = { costUsd: 100000, default: 1e12 };

export function validateUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail(400, 'invalid_usage', 'Consommation invalide.');
  const clean = {};
  for (const field of FIELDS) {
    const value = usage[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > (MAX[field] || MAX.default) ||
      (field !== 'costUsd' && !Number.isInteger(value))
    )
      fail(400, 'invalid_usage', `Consommation invalide (${field}).`);
    clean[field] = value;
  }
  return clean;
}

// Total des tentatives d’une exécution : tokens, coût connu et durée (une tentative en cours
// compte jusqu’à `now`). null pour une exécution qui n’a jamais été prise par un agent.
export function usageSummary(run, now = Date.now()) {
  const attempts = run.attempts || [];
  if (!attempts.length) return null;
  const total = { attempts: attempts.length, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0 };
  let cost = null;
  for (const attempt of attempts) {
    const usage = attempt.usage || {};
    total.inputTokens += usage.inputTokens || 0;
    total.cachedInputTokens += usage.cachedInputTokens || 0;
    total.outputTokens += usage.outputTokens || 0;
    if (usage.costUsd !== undefined) cost = (cost || 0) + usage.costUsd;
    const end = attempt.endedAt ? Date.parse(attempt.endedAt) : now;
    total.durationMs += Math.max(0, end - Date.parse(attempt.startedAt));
  }
  return { ...total, costUsd: cost === null ? null : Math.round(cost * 10000) / 10000 };
}
