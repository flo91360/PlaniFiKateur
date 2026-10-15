import { useEffect, useRef, useState } from 'react';
import { apiData } from './api-client.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

// État de l’agent sur les cartes d’un projet ({ cardId: { state, awaitingApproval, checks } }),
// relu à chaque événement d’exécution du projet ; toutes les 2 minutes par sécurité, 10 s sans flux.
export function useWorkStatus({ projectId, enabled }) {
  const [snapshot, setSnapshot] = useState(null);
  const live = useServerConnected();
  const reload = useRef(() => {});
  useServerEvent((type, data) => {
    if (type === 'ready' || (type === 'work' && data.projectId === projectId)) reload.current();
  });
  useEffect(() => {
    if (!enabled || !projectId) return;
    const controller = new AbortController();
    const load = () =>
      apiData(`projects/${projectId}/work-status`, { signal: controller.signal })
        .then(status => {
          if (!controller.signal.aborted) setSnapshot({ projectId, status });
        })
        .catch(() => {});
    reload.current = load;
    load();
    const timer = setInterval(load, live ? 120000 : 10000);
    return () => {
      reload.current = () => {};
      controller.abort();
      clearInterval(timer);
    };
  }, [projectId, enabled, live]);
  return enabled && snapshot && snapshot.projectId === projectId ? snapshot.status : {};
}

// Badge d’une carte sur le tableau, ou null : ce qui attend une personne passe en premier.
export function workBadge(status) {
  if (!status) return null;
  if (status.state === 'waiting') return { tone: 'attention', label: 'Question de l’agent' };
  if (status.state === 'review') return { tone: 'attention', label: 'Résultat à valider' };
  if (status.awaitingApproval) return { tone: 'attention', label: 'PR à approuver' };
  if (status.state === 'merging') return { tone: 'progress', label: 'Tests GitHub en cours' };
  if (status.state === 'running') return { tone: 'progress', label: 'Agent au travail' };
  if (status.state === 'interrupted') return { tone: 'warning', label: 'Exécution interrompue' };
  if (status.state === 'ready')
    return status.checks === 'failure'
      ? { tone: 'warning', label: 'Tests GitHub en échec' }
      : { tone: 'progress', label: 'En attente de l’agent' };
  return null;
}
