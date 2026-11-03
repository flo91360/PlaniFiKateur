import { useCallback, useEffect } from 'react';
import { apiData, apiFetch } from './api-client.js';
import { usePolledResource } from './use-polled-resource.js';

const EMPTY = { items: [], unread: 0, lastReadId: 0 };
// Liste et compteurs (`meta`) dans une seule valeur.
const readNotifications = async (path, options) => {
  const result = await apiFetch(path, options);
  return { items: result.data, ...result.meta };
};

// Pastille de l’icône de l’application installée (écran d’accueil, API Badging) : nombre de
// notifications non lues, effacée quand tout est lu. Sans effet sur les navigateurs qui l’ignorent.
export function updateAppBadge(count, nav = globalThis.navigator) {
  if (!nav?.setAppBadge || !Number.isSafeInteger(count) || count < 0) return;
  (count ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {});
}

// Notifications du compte : relues à chaque événement « notifications » du flux, sinon chaque minute
// (toutes les 15 secondes sans flux). `markRead` marque comme lues celles qui sont affichées.
export function useNotifications(enabled) {
  const { data, setData } = usePolledResource('notifications?limit=30', {
    enabled,
    every: 60000,
    offlineEvery: 15000,
    refreshOn: type => type === 'notifications',
    read: readNotifications,
  });
  const state = data || EMPTY;
  const loaded = !!data;
  useEffect(() => {
    if (enabled && loaded) updateAppBadge(state.unread);
  }, [enabled, loaded, state.unread]);
  const markRead = useCallback(async () => {
    const upTo = state.items[0]?.id;
    if (!upTo || !state.unread) return;
    try {
      const counters = await apiData('notifications/read', { method: 'POST', data: { upTo } });
      setData(previous => ({
        ...(previous || EMPTY),
        ...counters,
        items: (previous || EMPTY).items.map(item => ({ ...item, read: item.id <= counters.lastReadId })),
      }));
    } catch {
      /* Nouvel essai à la prochaine ouverture. */
    }
  }, [state.items, state.unread, setData]);
  return { ...state, markRead };
}
