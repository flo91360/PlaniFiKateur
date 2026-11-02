import { usePolledResource } from './use-polled-resource.js';

// Activité du worker IA pour la barre du haut : relue à chaque événement d’exécution, et toutes les
// 2 minutes pour le dernier contact du worker (30 secondes sans flux d’événements).
export function useWorkerActivity({ enabled }) {
  const { data } = usePolledResource('worker-activity', {
    enabled,
    every: 120000,
    offlineEvery: 30000,
    refreshOn: type => type === 'work',
  });
  return data || null;
}
