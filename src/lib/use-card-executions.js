import { useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';

const unfinished = run => !['done', 'cancelled'].includes(run.state);

// Exécutions IA d’une carte, relues toutes les 5 secondes. `managed` verrouille le statut
// et l’effort tant qu’une exécution est prise en charge ; `ai` décrit l’IA réellement utilisée.
// `onRefresh` est appelé après chaque lecture réussie pour actualiser le tableau.
export function useCardExecutions({ projectId, cardId, offline, onRefresh }) {
  const [managed, setManaged] = useState(!offline);
  const [ai, setAi] = useState(null);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const runs = await apiData(`projects/${projectId}/cards/${cardId}/work`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setManaged(runs.some(run => unfinished(run) && (run.state !== 'ready' || !!run.agent)));
        const current = runs.find(unfinished) || runs[0];
        setAi(current?.aiRuntime || current?.ai || null);
        await refresh.current();
      } catch {
        /* The workspace reports connectivity errors; keep the last known lock. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [offline, projectId, cardId]);
  return { managed, ai };
}
