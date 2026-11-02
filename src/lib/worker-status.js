// Suivi du worker IA pour l’administrateur, d’après le statut de l’agent (GET /api/v1/agents) :
// dernier contact, révision en service et dernier passage de la mise à jour automatique du VPS.

// Au-delà, un worker sans nouvelles ou une mise à jour en échec est signalé (le worker contacte le
// site toutes les 10 secondes ; la mise à jour automatique passe toutes les 5 minutes).
export const WORKER_ALERT_MS = 15 * 60000;

const when = date =>
  new Date(date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Alertes à afficher. Un échec passager de la mise à jour, résolu au passage suivant, n’alerte pas.
export function workerAlerts(status, now = Date.now()) {
  const alerts = [];
  const seen = Date.parse(status?.lastSeenAt);
  if (now - seen > WORKER_ALERT_MS)
    alerts.push(
      `Le worker IA ne s’est pas manifesté depuis le ${when(seen)} : les cartes prêtes ne sont plus prises en charge. Vérifiez qu’il tourne sur son serveur.`,
    );
  const update = status?.update;
  const failing = update?.state === 'failed' ? Date.parse(update.since) : NaN;
  if (now - failing >= WORKER_ALERT_MS)
    alerts.push(`La mise à jour automatique du worker échoue depuis le ${when(failing)} : ${update.message}`);
  return alerts;
}

const UPDATE_STATES = { ok: 'réussie', waiting: 'en attente', failed: 'en échec' };

// Lignes du panneau de l’agent.
export function workerDetails(status) {
  const lines = [
    status?.lastSeenAt
      ? `Dernier contact du worker : ${when(status.lastSeenAt)}.`
      : 'Aucun contact du worker enregistré pour le moment.',
  ];
  if (status?.revision)
    lines.push(`Révision ${status.revision.slice(0, 7)} annoncée au démarrage le ${when(status.startedAt)}.`);
  if (status?.update)
    lines.push(
      `Mise à jour automatique ${UPDATE_STATES[status.update.state]} (${when(status.update.date)}) : ${status.update.message}`,
    );
  return lines;
}
