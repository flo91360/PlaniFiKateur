import { useCallback, useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

// Ressource tenue à jour (`path`, relatif à /api/v1/) : relue à l’ouverture du flux d’événements,
// à chaque événement retenu par `refreshOn(type, data)`, au retour sur l’onglet et périodiquement,
// toutes les `every` ms avec le flux (filet de sécurité) ou `offlineEvery` ms sans lui.
// - une seule lecture à la fois : une demande reçue pendant une lecture la relance ensuite ;
// - un échec garde la dernière valeur ; rien n’est lu quand l’onglet est masqué ;
// - `data` vaut undefined tant que rien n’est chargé pour ce chemin ; `setData` la remplace
//   après une action enregistrée, `reload` force une lecture ;
// - `read` remplace la lecture par défaut (apiData), par exemple pour garder `meta`.
export function usePolledResource(
  path,
  { enabled = true, every = 60000, offlineEvery = 5000, refreshOn = () => false, read = apiData } = {},
) {
  const [state, setState] = useState({ path: null, data: undefined });
  const live = useServerConnected();
  const reload = useRef(() => {});
  const filter = useRef(refreshOn);
  filter.current = refreshOn;
  const reader = useRef(read);
  reader.current = read;
  useServerEvent((type, data) => {
    if (type === 'ready' || filter.current(type, data)) reload.current();
  });
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    let loading = false,
      again = false;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      try {
        const data = await reader.current(path, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ path, data });
      } catch {
        /* La dernière valeur connue reste affichée jusqu’à la prochaine lecture réussie. */
      } finally {
        loading = false;
        if (again && !controller.signal.aborted) {
          again = false;
          void load();
        }
      }
    };
    const refresh = () => void load();
    reload.current = refresh;
    refresh();
    const timer = setInterval(refresh, live ? every : offlineEvery);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      reload.current = () => {};
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [path, enabled, live, every, offlineEvery]);
  const setData = useCallback(update => setState(previous => ({ path, data: update(previous.data) })), [path]);
  return {
    data: enabled && path && state.path === path ? state.data : undefined,
    reload: useCallback(() => reload.current(), []),
    setData,
  };
}
