import React from 'react';
import { ArrowRight } from 'lucide-react';
import { workerSummary, workerWhen } from '../lib/worker-status.js';

const SECTIONS = [
  ['running', 'En cours de réalisation'],
  ['ready', 'En attente de l’agent, dans l’ordre de prise en charge'],
  ['merging', 'Tests GitHub et fusion'],
];

// Ce que fait le worker IA : dernier contact, révision et cartes en cours ou en attente.
export default function WorkerPanel({ activity, onOpenCard }) {
  if (!activity) return <p className="worker-panel">Chargement de l’activité du worker…</p>;
  const summary = workerSummary(activity);
  const worker = activity.worker;
  return (
    <div className="attention-panel worker-panel">
      <p>
        {worker
          ? `${summary.label}. Dernier contact : ${workerWhen(worker.lastSeenAt)}${
              worker.revision ? `, révision ${worker.revision.slice(0, 7)}` : ''
            }.`
          : 'Aucun worker ne s’est encore manifesté : les cartes prêtes attendent son démarrage.'}
        {summary.tone === 'silent' && worker && ' Les cartes prêtes ne sont plus prises en charge.'}
      </p>
      {!activity.executions.length && <p>Aucune carte en cours ni en attente dans vos projets.</p>}
      {SECTIONS.map(([state, title]) => {
        const items = activity.executions.filter(item => item.state === state);
        if (!items.length) return null;
        return (
          <section key={state} aria-label={title}>
            <h3>{title}</h3>
            <ul>
              {items.map(item => (
                <li key={item.cardId}>
                  <button onClick={() => onOpenCard(item.projectId, item.cardId)}>
                    <span className="attention-kind">
                      {item.projectName}
                      <time dateTime={item.since}>depuis le {workerWhen(item.since)}</time>
                    </span>
                    <strong>{item.cardTitle}</strong>
                    <span className="attention-open">
                      Ouvrir la carte
                      <ArrowRight size={13} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
