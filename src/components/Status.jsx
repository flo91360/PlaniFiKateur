import React from 'react';
import { ArrowRight, Check, CheckCheck, Circle, CircleHelp, Clock3 } from 'lucide-react';

// Libellés des statuts et priorités ; les clés sont validées par src/lib/workspace.js.
export const statuses = {
  draft: { label: 'À explorer', icon: Circle },
  ready: { label: 'Prête à démarrer', icon: ArrowRight },
  progress: { label: 'En cours', icon: Clock3 },
  clarify: { label: 'À préciser', icon: CircleHelp },
  review: { label: 'Tests et fusion', icon: CheckCheck },
  flo: { label: 'À relire', icon: CircleHelp },
  done: { label: 'Terminée', icon: Check },
};
export const priorities = { low: 'Basse', normal: 'Normale', high: 'Haute' };

// « Prête à démarrer » confie la carte à l’agent : réservé aux responsables du projet.
export function StatusOptions({ canLaunch = true }) {
  return Object.entries(statuses).map(([key, status]) => (
    <option key={key} value={key} disabled={key === 'ready' && !canLaunch}>
      {key === 'ready' && !canLaunch ? `${status.label} (responsables)` : status.label}
    </option>
  ));
}

export function PriorityOptions() {
  return Object.entries(priorities).map(([key, name]) => (
    <option key={key} value={key}>
      {name}
    </option>
  ));
}

export default function Status({ value }) {
  const status = statuses[value] || statuses.draft;
  const Icon = status.icon;
  return (
    <span className={`status ${value}`}>
      <Icon size={12} />
      {status.label}
    </span>
  );
}
