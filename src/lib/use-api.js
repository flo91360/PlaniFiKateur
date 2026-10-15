import { useCallback, useEffect, useState } from 'react';
import { apiData } from './api-client.js';

// Ressource lue sur l’API (`path`, relatif à /api/v1/) : la requête est annulée au démontage ou
// au changement de chemin, et la réponse d’un ancien chemin n’est jamais affichée.
// - `data` vaut undefined tant que rien n’est chargé ; `setData` la remplace après une
//   modification enregistrée, `reload` relit la ressource ;
// - `key` relit la ressource quand une donnée dont elle dépend change (le dépôt d’un projet…) ;
// - `every` (ms) la relit périodiquement, sans effacer la dernière valeur en cas d’échec.
export function useApiResource(path, { enabled = true, key = '', every = 0 } = {}) {
  const identity = `${path}\n${key}`;
  const [state, setState] = useState({ identity: null, data: undefined, error: '' });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    const load = first =>
      apiData(path, { signal: controller.signal })
        .then(data => setState({ identity, data, error: '' }))
        .catch(cause => {
          if (first && !controller.signal.aborted) setState({ identity, data: undefined, error: cause.message });
        });
    load(true);
    const timer = every ? setInterval(() => load(false), every) : null;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [identity, path, enabled, every, version]);
  const current = state.identity === identity ? state : { data: undefined, error: '' };
  const setData = useCallback(
    update =>
      setState(previous => ({
        identity,
        error: '',
        data:
          typeof update === 'function' ? update(previous.identity === identity ? previous.data : undefined) : update,
      })),
    [identity],
  );
  const reload = useCallback(() => setVersion(value => value + 1), []);
  return { data: current.data, error: current.error, loaded: current.data !== undefined, setData, reload };
}

// Action d’un formulaire : `run(work, success)` exécute `work`, signale l’occupation, puis le
// message de réussite (texte, ou fonction du résultat) ou l’erreur. Renvoie le résultat, ou
// undefined en cas d’échec.
export function useApiAction() {
  const [state, setState] = useState({ busy: false, error: '', message: '' });
  const run = useCallback(async (work, success = '') => {
    setState({ busy: true, error: '', message: '' });
    try {
      const result = await work();
      setState({ busy: false, error: '', message: typeof success === 'function' ? success(result) : success });
      return result;
    } catch (cause) {
      setState({ busy: false, error: cause.message, message: '' });
      return undefined;
    }
  }, []);
  const clear = useCallback(() => setState(previous => ({ ...previous, error: '', message: '' })), []);
  return { ...state, run, clear };
}
