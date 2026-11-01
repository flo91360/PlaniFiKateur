import { useEffect, useRef, useSyncExternalStore } from 'react';

// Flux unique d’événements du serveur (GET /api/v1/events), partagé par toute la page.
// Les hooks relisent leurs données quand un événement les concerne ; tant que le flux n’est
// pas connecté, ils gardent leur actualisation périodique habituelle.
// Onglet masqué depuis une minute : le flux est fermé, pour que le serveur puisse se mettre en
// veille (Railway) ; il est rouvert au retour sur l’onglet, et `ready` fait tout relire.
const HIDDEN_CLOSE_MS = 60000;
const TYPES = ['ready', 'workspace', 'work', 'subscriptions', 'notifications'];
const handlers = new Set();
const watchers = new Set();
let source = null,
  users = 0,
  connected = false,
  retry = null,
  hiddenTimer = null;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const setConnected = value => {
  if (connected === value) return;
  connected = value;
  for (const watcher of watchers) watcher();
};

function open() {
  if (source || typeof EventSource === 'undefined' || hidden()) return;
  source = new EventSource('/api/v1/events');
  for (const type of TYPES)
    source.addEventListener(type, event => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (type === 'ready') setConnected(true);
      for (const handler of handlers) handler(type, data);
    });
  source.onerror = () => {
    setConnected(false);
    // Le navigateur se reconnecte seul après une coupure ; une réponse refusée (session expirée)
    // ferme le flux : nouvelle tentative plus tard, l’actualisation périodique prend le relais.
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      clearTimeout(retry);
      retry = setTimeout(() => users && open(), 30000);
    }
  };
}

function close() {
  clearTimeout(retry);
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
  source?.close();
  source = null;
  setConnected(false);
}

function onVisibility() {
  if (!users) return;
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
  if (!hidden()) open();
  else if (source) hiddenTimer = setTimeout(close, HIDDEN_CLOSE_MS);
}

// Ouvre le flux tant qu’au moins un composant le demande ; renvoie l’état de connexion.
export function useServerEvents(enabled) {
  useEffect(() => {
    if (!enabled) return;
    if (users++ === 0) document.addEventListener('visibilitychange', onVisibility);
    open();
    return () => {
      if (--users > 0) return;
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [enabled]);
  return useServerConnected();
}

export function useServerConnected() {
  return useSyncExternalStore(
    watcher => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    () => connected,
    () => false,
  );
}

// Appelle `handler(type, data)` pour chaque événement reçu, y compris `ready` après une
// (re)connexion : des changements ont pu être manqués pendant la coupure.
export function useServerEvent(handler) {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    const listener = (type, data) => current.current(type, data);
    handlers.add(listener);
    return () => handlers.delete(listener);
  }, []);
}
