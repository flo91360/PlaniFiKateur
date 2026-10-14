import React, { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { activityLabels } from './ActivityPanel.jsx';

const when = date =>
  new Date(date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Notifications du compte (actions des autres sur ses cartes) ; l’ouverture les marque comme lues.
export default function NotificationsPanel({ notifications, onOpenCard }) {
  const { items, markRead } = notifications;
  // Les notifications nouvelles à l’ouverture restent mises en avant tant que la fenêtre est ouverte.
  const [seenUpTo] = useState(notifications.lastReadId);
  useEffect(() => {
    void markRead();
  }, [markRead]);
  if (!items.length)
    return (
      <div className="attention-panel">
        <p>
          Aucune notification. Vous serez prévenu des commentaires, changements de statut et étapes de l’agent sur les
          cartes que vous avez créées, commentées ou que vous suivez.
        </p>
      </div>
    );
  return (
    <div className="attention-panel">
      <ul aria-label="Notifications">
        {items.map(item => (
          <li key={item.id} className={item.id > seenUpTo ? 'unread' : ''}>
            <button
              disabled={!item.cardId || item.action === 'card.deleted'}
              onClick={() => onOpenCard(item.projectId, item.cardId)}
            >
              <span className="attention-kind">
                {item.projectName || 'Espace'}
                <time dateTime={item.date}>{when(item.date)}</time>
              </span>
              <strong>{item.cardTitle || item.projectName || 'PlaniFiKateur'}</strong>
              <span className="attention-message">
                {item.actor.name} {activityLabels[item.action] || item.action}
              </span>
              {item.cardId && item.action !== 'card.deleted' && (
                <span className="attention-open">
                  Ouvrir la carte
                  <ArrowRight size={13} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
