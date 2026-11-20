import React from 'react';
import { LoaderCircle, WandSparkles } from 'lucide-react';
import FormStatus from './FormStatus.jsx';
import { apiData } from '../lib/api-client.js';
import { useApiAction } from '../lib/use-api.js';
import { implementationList } from '../lib/discussion-list.js';

// Sous la discussion d’une carte Discussion : en un clic, l’IA résume les demandes de la conversation
// et le serveur crée la carte d’implémentation dans Améliorations, avec une copie des pièces jointes.
// Créée par un responsable, elle est aussitôt « Prête à démarrer » et l’agent la prend en charge.
// La carte Discussion est ensuite supprimée : la nouvelle carte s’ouvre à sa place.
export default function DiscussionSummary({ projectId, card, lists, canLaunch, onImplemented }) {
  const target = implementationList({ id: projectId, lists });
  const action = useApiAction();
  const empty = !card.description.trim() && !card.comments.some(comment => comment.text.trim());

  const generate = async () => {
    const result = await action.run(() =>
      apiData(`projects/${projectId}/cards/${card.id}/implementation`, { method: 'POST', data: {} }),
    );
    if (result) await onImplemented(result);
  };

  if (!target) return null;
  return (
    <div className="discussion-summary">
      <button
        type="button"
        className="assistant-button magic"
        disabled={action.busy || empty}
        title={empty ? 'La discussion est vide : rien à résumer.' : undefined}
        onClick={() => void generate()}
      >
        {action.busy ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}
        {action.busy ? 'Création de la carte…' : `Créer la carte d’implémentation dans ${target.name}`}
      </button>
      {!action.busy && (
        <p className="muted">
          L’IA résume les demandes de la discussion dans la description d’une nouvelle carte, avec une copie des pièces
          jointes, puis supprime cette carte Discussion.{' '}
          {canLaunch
            ? 'La nouvelle carte est aussitôt confiée à l’agent.'
            : 'Un responsable du projet la confiera ensuite à l’agent.'}
        </p>
      )}
      <FormStatus error={action.error} />
    </div>
  );
}
