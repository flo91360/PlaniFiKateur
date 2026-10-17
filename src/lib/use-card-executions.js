import { useCallback, useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

export const unfinished = run => !!run && !['done', 'cancelled'].includes(run.state);

// Exécutions IA d’une carte (la plus récente d’abord), relues à chaque événement qui la concerne,
// sinon toutes les 5 secondes.
// `current` est l’exécution en cours, ou la dernière terminée. `managed` verrouille le statut
// et l’effort tant qu’une exécution est prise en charge ; `ai` décrit l’IA réellement utilisée.
// `onRefresh` est appelé après chaque lecture réussie pour actualiser le tableau ; `loaded` indique
// si une première lecture a abouti ou échoué, `error` le motif de la dernière lecture en échec.
export function useCardExecutions({ projectId, cardId, offline, onRefresh }) {
  const [runs, setRuns] = useState(null);
  // Dernière lecture en échec : affichée dans le panneau, sans bloquer la carte indéfiniment.
  const [error, setError] = useState('');
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const loading = useRef(null);
  const load = useCallback(async () => {
    const controller = new AbortController();
    loading.current?.abort();
    loading.current = controller;
    let next;
    try {
      next = await apiData(`projects/${projectId}/cards/${cardId}/work`, { signal: controller.signal });
    } catch (failure) {
      if (controller.signal.aborted) return;
      // Les exécutions déjà connues restent affichées (et verrouillent le statut) ; sans aucune
      // lecture réussie, le panneau affiche l’erreur et un bouton pour réessayer.
      setError(failure.message || 'Exécutions IA indisponibles.');
      return;
    }
    if (controller.signal.aborted) return;
    setRuns(next);
    setError('');
    try {
      await refresh.current?.();
    } catch {
      /* L’actualisation du tableau signale elle-même ses erreurs de connexion. */
    }
  }, [projectId, cardId]);
  const live = useServerConnected();
  useServerEvent((type, data) => {
    if (!offline && (type === 'ready' || (type === 'work' && data.cardId === cardId))) void load();
  });
  useEffect(() => {
    if (offline) return;
    void load();
    const timer = setInterval(() => void load(), live ? 30000 : 5000);
    return () => {
      loading.current?.abort();
      clearInterval(timer);
    };
  }, [offline, load, live]);
  const current = runs ? runs.find(unfinished) || runs[0] || null : null;
  return {
    // Faux tant que la première lecture n’a pas abouti ni échoué : rien n’est encore connu de la carte.
    loaded: offline || runs !== null || !!error,
    error,
    runs: runs || [],
    current,
    // Statut verrouillé pendant la première lecture, puis selon les exécutions connues. Si la lecture
    // échoue, le serveur reste seul juge : il refuse un statut piloté par une exécution.
    managed:
      runs === null ? !offline && !error : runs.some(run => unfinished(run) && (run.state !== 'ready' || !!run.agent)),
    ai: current?.aiRuntime || current?.ai || null,
    reload: load,
  };
}
