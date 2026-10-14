import { useEffect, useState } from 'react';
import { apiData } from './api-client.js';

// Cartes qui attendent une personne (questions de l’agent, résultats à valider).
// Relu à chaque changement du tableau, au retour sur l’onglet et toutes les 30 secondes.
export function useAttention({ enabled, projects }) {
  const [items, setItems] = useState([]);
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
    load();
    const timer = setInterval(load, 30000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, projects]);
  return enabled ? items : [];
}
