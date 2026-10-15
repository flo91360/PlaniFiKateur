import React, { useEffect, useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

// Validation humaine avant la fusion des PR de l’agent, réglée par un responsable du projet.
export default function MergeApproval({ projectId, canManage, onState }) {
  const approval = useApiResource(`projects/${projectId}/approval`);
  const action = useApiAction();
  const [draft, setDraft] = useState(null);
  const saved = approval.data?.required ?? null,
    required = draft ?? saved,
    busy = action.busy;
  useEffect(() => {
    if (saved !== null) onState?.(saved);
  }, [saved, onState]);
  const save = () =>
    action.run(
      async () => {
        approval.setData(await apiData(`projects/${projectId}/approval`, { method: 'PUT', data: { required } }));
        setDraft(null);
        return required;
      },
      value =>
        value
          ? 'Chaque PR de l’agent attendra désormais l’approbation d’un responsable.'
          : 'Les PR de l’agent fusionnent de nouveau après les tests, sans approbation.',
    );
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
              onChange={event => setDraft(event.target.checked)}
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
      <FormStatus message={action.message} error={action.error || approval.error} />
    </details>
  );
}
