import { useCallback, useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

export const unfinished = run => !!run && !['done', 'cancelled'].includes(run.state);

// Exécutions IA d’une carte (la plus récente d’abord), relues à chaque événement qui la concerne,
// sinon toutes les 5 secondes.
// `current` est l’exécution en cours, ou la dernière terminée. `managed` verrouille le statut
// et l’effort tant qu’une exécution est prise en charge ; `ai` décrit l’IA réellement utilisée.
// `onRefresh` est appelé après chaque lecture réussie pour actualiser le tableau ; `loaded` indique
// si une première lecture a abouti.
export function useCardExecutions({ projectId, cardId, offline, onRefresh }) {
  const [runs, setRuns] = useState(null);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const loading = useRef(null);
  const load = useCallback(async () => {
    const controller = new AbortController();
    loading.current?.abort();
    loading.current = controller;
    try {
      const next = await apiData(`projects/${projectId}/cards/${cardId}/work`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRuns(next);
      await refresh.current();
    } catch {
      /* The workspace reports connectivity errors; keep the last known lock. */
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
    // Faux tant que la première lecture n’a pas abouti : rien n’est encore connu de la carte.
    loaded: offline || runs !== null,
    runs: runs || [],
    current,
    managed: runs === null ? !offline : runs.some(run => unfinished(run) && (run.state !== 'ready' || !!run.agent)),
    ai: current?.aiRuntime || current?.ai || null,
    reload: load,
  };
}
