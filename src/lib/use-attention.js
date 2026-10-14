import { useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerEvent } from './use-server-events.js';

// Cartes qui attendent une personne (questions de l’agent, résultats à valider).
// Relu à chaque changement du tableau ou d’une exécution, au retour sur l’onglet et toutes les 30 secondes.
export function useAttention({ enabled, projects }) {
  const [items, setItems] = useState([]);
  const reload = useRef(() => {});
  useServerEvent(type => {
    if (type === 'work' || type === 'ready') reload.current();
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      apiData('attention', { signal: controller.signal })
        .then(next => {
          if (!controller.signal.aborted) setItems(next);
        })
        .catch(() => {});
    };
    reload.current = load;
    load();
    const timer = setInterval(load, 30000);
    document.addEventListener('visibilitychange', load);
    return () => {
      reload.current = () => {};
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, projects]);
  return enabled ? items : [];
}
