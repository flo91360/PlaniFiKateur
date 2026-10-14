import React from 'react';
import { ArrowRight } from 'lucide-react';

const kinds = { waiting: 'Question de l’agent', review: 'Résultat à valider' };
const when = date =>
  date && Number.isFinite(Date.parse(date))
    ? new Date(date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

// Liste des cartes qui attendent une personne ; un clic ouvre la carte dans son projet.
export default function AttentionPanel({ items, onOpenCard }) {
  if (!items.length)
    return (
      <div className="attention-panel">
        <p>Rien à traiter : l’agent n’attend aucune réponse et aucun résultat n’est à valider.</p>
      </div>
    );
  return (
    <div className="attention-panel">
      <p>
        Ouvrez la carte pour répondre à l’agent dans sa discussion (la tâche reprend dès que votre commentaire est
        enregistré) ou valider son résultat.
      </p>
      <ul aria-label="Cartes à traiter">
        {items.map(item => (
          <li key={item.executionId}>
            <button onClick={() => onOpenCard(item.projectId, item.cardId)}>
              <span className="attention-kind">
                {kinds[item.state]} · {item.projectName}
                <time dateTime={item.since}>{when(item.since)}</time>
              </span>
              <strong>{item.cardTitle}</strong>
              {item.message && <span className="attention-message">{item.message}</span>}
              <span className="attention-open">
                Ouvrir la carte
                <ArrowRight size={13} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
