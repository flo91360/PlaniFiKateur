import React from 'react';
import { useApiResource } from '../lib/use-api.js';
import { workerAlerts } from '../lib/worker-status.js';

// Bandeau de l’administrateur : worker IA silencieux ou mise à jour automatique en échec. Le statut
// est relu toutes les 5 minutes, onglet visible.
export default function WorkerAlert() {
  const agents = useApiResource('agents', { every: 5 * 60000 });
  const agent = agents.data?.find(item => item.active);
  if (!agent) return null;
  return workerAlerts(agent.status).map(text => (
    <div key={text} className="sync-warning" role="status">
      <p>{text}</p>
    </div>
  ));
}
