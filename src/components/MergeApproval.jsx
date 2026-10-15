import React, { useEffect, useState } from 'react';
import { apiData } from '../lib/api-client.js';

// Validation humaine avant la fusion des PR de l’agent, réglée par un responsable du projet.
export default function MergeApproval({ projectId, canManage, onState }) {
  const [required, setRequired] = useState(null),
    [saved, setSaved] = useState(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    apiData(`projects/${projectId}/approval`, { signal: controller.signal })
      .then(data => {
        setRequired(data.required);
        setSaved(data.required);
        onState?.(data.required);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [projectId, onState]);
  const save = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await apiData(`projects/${projectId}/approval`, { method: 'PUT', data: { required } });
      setSaved(data.required);
      onState?.(data.required);
      setMessage(
        data.required
          ? 'Chaque PR de l’agent attendra désormais l’approbation d’un responsable.'
          : 'Les PR de l’agent fusionnent de nouveau après les tests, sans approbation.',
      );
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="agent-setup">
      <summary>Validation avant fusion</summary>
      <p>
        Par défaut, une PR de l’agent fusionne dès que les tests GitHub réussissent. Avec la validation, elle attend en
        plus qu’un responsable l’approuve depuis la carte ; une correction de l’agent demande une nouvelle approbation.
      </p>
      {required !== null && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              aria-label="Approuver chaque PR avant sa fusion"
              disabled={!canManage || busy}
              checked={required}
              onChange={event => setRequired(event.target.checked)}
            />
            Approuver chaque PR avant sa fusion
          </label>
          {canManage ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || required === saved}
              onClick={() => void save()}
            >
              Enregistrer la validation
            </button>
          ) : (
            <p className="muted">Seuls les responsables du projet peuvent modifier ce réglage.</p>
          )}
        </>
      )}
      {message && <p aria-live="polite">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}
