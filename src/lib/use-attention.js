import { usePolledResource } from './use-polled-resource.js';

const NONE = Object.freeze([]);

// Cartes qui attendent une personne (questions de l’agent, résultats à valider).
// Relu à chaque événement d’exécution, au retour sur l’onglet, et toutes les 30 secondes seulement
// sans flux d’événements (toutes les 5 minutes sinon, par sécurité).
export function useAttention({ enabled }) {
  const { data } = usePolledResource('attention', {
    enabled,
    every: 300000,
    offlineEvery: 30000,
    refreshOn: type => type === 'work',
  });
  return data || NONE;
}
