import { useCallback, useEffect, useRef, useState } from 'react';
import { apiData, apiFetch } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

// Notifications du compte : relues à chaque événement « notifications » du flux, sinon chaque minute
// (toutes les 15 secondes sans flux). `markRead` marque comme lues celles qui sont affichées.
export function useNotifications(enabled) {
  const [state, setState] = useState({ items: [], unread: 0, lastReadId: 0 });
  const live = useServerConnected();
  const controller = useRef(null);
  const load = useCallback(async () => {
    if (!enabled || document.visibilityState === 'hidden') return;
    controller.current?.abort();
    const current = (controller.current = new AbortController());
    try {
      const result = await apiFetch('notifications?limit=30', { signal: current.signal });
      if (!current.signal.aborted) setState({ items: result.data, ...result.meta });
    } catch {
      /* Les notifications restent celles de la dernière lecture réussie. */
    }
  }, [enabled]);
  useServerEvent(type => {
    if (type === 'notifications' || type === 'ready') void load();
  });
  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), live ? 60000 : 15000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.current?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, live, load]);
  const markRead = useCallback(async () => {
    const upTo = state.items[0]?.id;
    if (!upTo || !state.unread) return;
    try {
      const counters = await apiData('notifications/read', { method: 'POST', data: { upTo } });
      setState(previous => ({
        ...previous,
        ...counters,
        items: previous.items.map(item => ({ ...item, read: item.id <= counters.lastReadId })),
      }));
    } catch {
      /* Nouvel essai à la prochaine ouverture. */
    }
  }, [state.items, state.unread]);
  return enabled ? { ...state, markRead } : { items: [], unread: 0, lastReadId: 0, markRead };
}
