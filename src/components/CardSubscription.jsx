import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, UserPlus } from 'lucide-react';
import { apiData } from '../lib/api-client.js';

export default function CardSubscription({ projectId, cardId, saveStatus }) {
  const [following, setFollowing] = useState(null),
    [members, setMembers] = useState(null);
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const base = `projects/${projectId}/cards/${cardId}`;
  const request = useCallback(
    (suffix, options = {}) => apiData(`${base}/${suffix}`, { fallback: 'Suivi indisponible.', ...options }),
    [base],
  );
  const read = useCallback(
    async signal => {
      const [subscription, people] = await Promise.all([
        request('subscription', { signal }),
        request('subscribers', { signal }),
      ]);
      if (!signal?.aborted) {
        setFollowing(subscription.following);
        setMembers(people);
      }
    },
    [request],
  );
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    read(controller.signal).catch(cause => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [read, saveStatus, busy]);
  useEffect(() => {
    setFollowing(null);
    setMembers(null);
    setSelected('');
  }, [base]);
  const update = async (suffix, data) => {
    setBusy(true);
    setError('');
    try {
      const result = await request(suffix, { method: 'PUT', data });
      if (suffix === 'subscription') {
        setFollowing(result.following);
      } else {
        setMembers(result);
        setSelected('');
      }
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
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
        Les notifications seront disponibles dans une prochaine étape.
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
          <button
            className="secondary-button"
            onClick={() =>
              read()
                .then(() => setError(''))
                .catch(cause => setError(cause.message))
            }
          >
            Réessayer
          </button>
        </div>
      )}
    </section>
  );
}
