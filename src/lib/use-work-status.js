import { usePolledResource } from './use-polled-resource.js';

const NONE = Object.freeze({});

// État de l’agent sur les cartes d’un projet ({ cardId: { state, awaitingApproval, checks } }),
// relu à chaque événement d’exécution du projet ; toutes les 2 minutes par sécurité, 10 s sans flux.
export function useWorkStatus({ projectId, enabled }) {
  const { data } = usePolledResource(projectId ? `projects/${projectId}/work-status` : '', {
    enabled,
    every: 120000,
    offlineEvery: 10000,
    refreshOn: (type, event) => type === 'work' && event.projectId === projectId,
  });
  return data || NONE;
}

// Badge d’une carte sur le tableau, ou null : ce qui attend une personne passe en premier.
export function workBadge(status) {
  if (!status) return null;
  if (status.state === 'waiting') return { tone: 'attention', label: 'Question de l’agent' };
  if (status.state === 'review') return { tone: 'attention', label: 'Résultat à valider' };
  if (status.awaitingApproval) return { tone: 'attention', label: 'PR à approuver' };
  if (status.state === 'merging') return { tone: 'progress', label: 'Tests GitHub en cours' };
  if (status.state === 'running') return { tone: 'progress', label: 'Agent au travail' };
  if (status.state === 'interrupted') return { tone: 'warning', label: 'Exécution interrompue' };
  if (status.state === 'ready')
    return status.checks === 'failure'
      ? { tone: 'warning', label: 'Tests GitHub en échec' }
      : { tone: 'progress', label: 'En attente de l’agent' };
  return null;
}
