// Surveillance du site : vérifie chaque minute le worker et les sauvegardes, et prévient les
// administrateurs (cloche et Web Push) au début de chaque incident, une seule fois.
export const WORKER_SILENCE_MS = 15 * 60000;
export const OFFSITE_STALE_MS = 48 * 3600000;
// Workflow GitHub qui publie le tag puis vérifie la version servie par le site.
export const DEPLOYMENT_WORKFLOW = '.github/workflows/tag-version.yml';

const minutes = ms => Math.round(ms / 60000);

export function checkAlerts(store, { backups = null, now = Date.now() } = {}) {
  // Worker : l’agent actif vu le plus récemment ne s’est plus manifesté depuis 15 min.
  const seen = store.workflows
    .agents()
    .filter(agent => agent.active && agent.status?.lastSeenAt)
    .map(agent => Date.parse(agent.status.lastSeenAt))
    .sort((a, b) => b - a)[0];
  if (seen && now - seen > WORKER_SILENCE_MS)
    store.raiseAlert('worker', {
      title: 'Worker muet',
      text: `Le worker IA ne s’est plus manifesté depuis ${minutes(now - seen)} min : les cartes prêtes ne sont plus prises en charge.`,
    });
  else if (seen) store.clearAlert('worker');
  if (!backups) return;
  const status = backups.status();
  if (status.error) store.raiseAlert('backup', { title: 'Sauvegarde en échec', text: status.error });
  else store.clearAlert('backup');
  // Copie quotidienne hors du site, une fois qu’elle a été confirmée au moins une fois.
  const offsite = status.offsite?.at ? Date.parse(status.offsite.at) : null;
  if (offsite && now - offsite > OFFSITE_STALE_MS)
    store.raiseAlert('offsite', {
      title: 'Copie hors site en retard',
      text: `Aucune copie quotidienne confirmée depuis ${Math.round((now - offsite) / 3600000)} h.`,
    });
  else if (offsite) store.clearAlert('offsite');
}

// Résultat du workflow « Livraison de version » du dépôt de PlaniFiKateur reçu par le webhook GitHub :
// un échec (tag ou vérification de la version servie) prévient les administrateurs, une réussite
// referme l’incident. Les workflows des autres dépôts suivis ne concernent pas ce site.
export function deploymentAlert(store, event) {
  const run = event?.workflow_run;
  if (event?.action !== 'completed' || run?.path !== DEPLOYMENT_WORKFLOW) return false;
  const repository = event.repository?.full_name;
  if (typeof repository !== 'string' || repository.split('/')[1]?.toLowerCase() !== 'planifikateur') return false;
  if (run.conclusion === 'success') {
    store.clearAlert('deployment');
    return true;
  }
  if (!['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) return false;
  const sha = typeof run.head_sha === 'string' ? run.head_sha.slice(0, 7) : '';
  store.raiseAlert('deployment', {
    title: 'Déploiement non vérifié',
    text: `La livraison${sha ? ` du commit ${sha}` : ''} de ${repository} n’a pas été confirmée sur le site : vérifiez le workflow « Livraison de version ».`,
  });
  return true;
}

export function createAlerts(store, { backups = null, intervalMs = 60000, log = console.error } = {}) {
  const tick = () => {
    try {
      checkAlerts(store, { backups });
    } catch (error) {
      log(`PlaniFiKateur : surveillance impossible (${error.message}).`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, close: () => clearInterval(timer) };
}
