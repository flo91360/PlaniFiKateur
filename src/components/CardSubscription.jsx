import React, { useEffect, useState } from 'react';
import { Bell, BellOff, UserPlus } from 'lucide-react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import { useServerEvent } from '../lib/use-server-events.js';

// Suivi de la carte : relu à l’ouverture, puis quand un abonnement de la carte ou le contenu de son
// projet change (un commentaire fait suivre la carte à son auteur). Pas de lecture pendant un
// enregistrement : sa réponse fait foi.
export default function CardSubscription({ projectId, cardId }) {
  const base = `projects/${projectId}/cards/${cardId}`;
  const { busy, error: actionError, run, clear } = useApiAction();
  const read = { enabled: !busy, fallback: 'Suivi indisponible.' };
  const subscription = useApiResource(`${base}/subscription`, read);
  const subscribers = useApiResource(`${base}/subscribers`, read);
  useServerEvent((type, data) => {
    if (
      (type === 'subscriptions' && data.cardId === cardId) ||
      (type === 'workspace' && (!data.projectIds || data.projectIds.includes(projectId)))
    ) {
      subscription.reload();
      subscribers.reload();
    }
  });
  const following = subscription.data?.following ?? null,
    members = subscribers.data ?? null;
  const [selected, setSelected] = useState('');
  useEffect(() => setSelected(''), [base]);
  const update = async (suffix, data) => {
    const result = await run(() =>
      apiData(`${base}/${suffix}`, { method: 'PUT', data, fallback: 'Suivi indisponible.' }),
    );
    if (result === undefined) return;
    if (suffix === 'subscription') subscription.setData(result);
    else {
      subscribers.setData(result);
      setSelected('');
    }
  };
  const error = actionError || subscription.error || subscribers.error;
  const retry = () => {
    clear();
    subscription.reload();
    subscribers.reload();
  };
  const followers = members?.filter(member => member.following) || [];
  return (
    <section className="card-subscription">
      <button
        className="secondary-button"
        aria-pressed={!!following}
        disabled={busy || following === null}
        onClick={() => void update('subscription', { following: !following })}
      >
        {following ? <BellOff size={16} /> : <Bell size={16} />}
        {following ? 'Ne plus suivre' : 'Suivre la carte'}
      </button>
      <p>
        {following
          ? 'Vous suivez les évolutions de cette carte.'
          : 'Abonnez-vous aux évolutions, même sans être auteur.'}{' '}
        Ses commentaires, changements de statut et étapes de l’agent arrivent dans vos notifications.
      </p>
      <label>
        Ajouter un membre au suivi
        <select
          aria-label="Membre à abonner"
          value={selected}
          disabled={busy || members === null}
          onChange={event => setSelected(event.target.value)}
        >
          <option value="">Choisir un membre…</option>
          {members?.map(member => (
            <option key={member.id} value={member.id} disabled={member.following}>
              {member.name}
              {member.following ? ' — suit déjà la carte' : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        className="secondary-button"
        disabled={busy || !selected || !members?.some(member => member.id === selected && !member.following)}
        onClick={() => void update('subscribers', { userId: selected })}
      >
        <UserPlus size={16} />
        Ajouter au suivi
      </button>
      {members && (
        <div className="card-followers">
          <p>Membres qui suivent cette carte ({followers.length})</p>
          {followers.length > 0 ? (
            <ul aria-label="Membres abonnés">
              {followers.map(member => (
                <li key={member.id}>{member.name}</li>
              ))}
            </ul>
          ) : (
            <p>Aucun membre ne suit cette carte.</p>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="form-error">
          {error}
          <button className="secondary-button" onClick={retry}>
            Réessayer
          </button>
        </div>
      )}
    </section>
  );
}
