import { useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

// Cartes qui attendent une personne (questions de l’agent, résultats à valider).
// Relu à chaque événement d’exécution, au retour sur l’onglet, et toutes les 30 secondes seulement
// sans flux d’événements (toutes les 5 minutes sinon, par sécurité).
export function useAttention({ enabled }) {
  const [items, setItems] = useState([]);
  const live = useServerConnected();
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
    const timer = setInterval(load, live ? 300000 : 30000);
    document.addEventListener('visibilitychange', load);
    return () => {
      reload.current = () => {};
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, live]);
  return enabled ? items : [];
}
