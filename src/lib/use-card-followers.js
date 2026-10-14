import { useEffect, useState } from 'react';
import { apiData } from './api-client.js';

export function useCardFollowers({ project, enabled, saveStatus, selectedId, modal }) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    if (!enabled || !project?.id) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try {
        const followers = await apiData(`projects/${project.id}/card-followers`, { signal: controller.signal });
        if (!controller.signal.aborted) setSnapshot({ projectId: project.id, followers });
      } catch {
        // Keep the last known followers until the next successful refresh.
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [project, enabled, saveStatus, selectedId, modal]);
  return enabled && project?.id && snapshot?.projectId === project.id ? snapshot.followers : {};
}
