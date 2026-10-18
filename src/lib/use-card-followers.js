import { usePolledResource } from './use-polled-resource.js';

const NONE = Object.freeze({});

// Suivi des cartes d’un projet : relu quand un abonnement change ou quand le contenu du projet
// change (un commentaire fait suivre la carte), sinon toutes les minutes ; 5 s sans flux.
export function useCardFollowers({ projectId, enabled }) {
  const { data } = usePolledResource(projectId ? `projects/${projectId}/card-followers` : '', {
    enabled,
    every: 60000,
    offlineEvery: 5000,
    refreshOn: (type, event) =>
      (type === 'subscriptions' && event.projectId === projectId) ||
      (type === 'workspace' && (!event.projectIds || event.projectIds.includes(projectId))),
  });
  return data || NONE;
}
