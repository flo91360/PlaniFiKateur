import React, { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

export default function CardSubscription({ projectId, cardId, saveStatus }) {
  const [following, setFollowing] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const path = `/api/v1/projects/${projectId}/cards/${cardId}/subscription`;
  const read = async signal => {
    const response = await fetch(path, { credentials: 'same-origin', signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Suivi indisponible.');
    return result.data.following;
  };
  useEffect(() => {
    if (busy) return;
    const controller = new AbortController();
    setError('');
    read(controller.signal).then(value => { if (!controller.signal.aborted) setFollowing(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [path, saveStatus, busy]);
  const toggle = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ following: !following }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'Impossible de modifier le suivi.');
      setFollowing(result.data.following);
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <section className="card-subscription"><button className="secondary-button" aria-pressed={!!following} disabled={busy || following === null} onClick={() => void toggle()}>{following ? <BellOff size={16} /> : <Bell size={16} />}{following ? 'Ne plus suivre' : 'Suivre la carte'}</button><p>{following ? 'Vous suivez les évolutions de cette carte.' : 'Abonnez-vous aux évolutions, même sans être auteur.'} Les notifications seront disponibles dans une prochaine étape.</p>{error && <p role="alert" className="form-error">{error}<button className="secondary-button" onClick={() => read().then(setFollowing).then(() => setError('')).catch(cause => setError(cause.message))}>Réessayer</button></p>}</section>;
}
