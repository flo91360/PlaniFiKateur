import { useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

// Suivi des cartes d’un projet : relu quand un abonnement change ou quand le contenu du projet
// change (un commentaire fait suivre la carte), sinon toutes les minutes ; 5 s sans flux.
export function useCardFollowers({ projectId, enabled }) {
  const [snapshot, setSnapshot] = useState(null);
  const live = useServerConnected();
  const reload = useRef(() => {});
  useServerEvent((type, data) => {
    if (
      type === 'ready' ||
      (type === 'subscriptions' && data.projectId === projectId) ||
      (type === 'workspace' && (!data.projectIds || data.projectIds.includes(projectId)))
    )
      reload.current();
  });
  useEffect(() => {
    if (!enabled || !projectId) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const followers = await apiData(`projects/${projectId}/card-followers`, { signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot({ projectId, followers });
      } catch {
        // Keep the last known followers until the next successful refresh.
      } finally {
        loading = false;
      }
    };
    reload.current = () => void refresh();
    void refresh();
    const timer = setInterval(refresh, live ? 60000 : 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      reload.current = () => {};
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [projectId, enabled, live]);
  return enabled && projectId && snapshot?.projectId === projectId ? snapshot.followers : {};
}
