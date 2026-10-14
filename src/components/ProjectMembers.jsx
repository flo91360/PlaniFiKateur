import React, { useEffect, useState } from 'react';
import { apiData } from '../lib/api-client.js';

export const roleLabels = { viewer: 'Lecture', editor: 'Contribution', manager: 'Responsable' };
const memberRoleLabels = { none: 'Aucun accès (projet masqué)', ...roleLabels };

// Membres et droits du projet : rôle des autres membres et rôles nommés. Modifiable par un responsable.
export default function ProjectMembers({ projectId, canManage, onChanged }) {
  const [access, setAccess] = useState(null),
    [draft, setDraft] = useState(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    apiData(`projects/${projectId}/members`, { signal: controller.signal })
      .then(data => {
        setAccess(data);
        setDraft(data);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [projectId]);
  const setExplicit = (id, role) =>
    setDraft({
      ...draft,
      members: draft.members.map(member => (member.id === id ? { ...member, explicit: role || null } : member)),
    });
  const save = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const members = Object.fromEntries(
        draft.members
          .filter(member => !member.admin)
          .filter(member => member.explicit !== access.members.find(item => item.id === member.id)?.explicit)
          .map(member => [member.id, member.explicit]),
      );
      const saved = await apiData(`projects/${projectId}/members`, {
        method: 'PUT',
        data: { memberRole: draft.memberRole, members },
      });
      setAccess(saved);
      setDraft(saved);
      setMessage('Droits enregistrés pour ce projet.');
      await onChanged?.();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="agent-setup">
      <summary>Membres et droits</summary>
      <p>
        <strong>Lecture</strong> : consulter le projet. <strong>Contribution</strong> : modifier les cartes, commenter
        et annuler une exécution. <strong>Responsable</strong> : confier les cartes à l’agent, valider ou faire corriger
        son travail et gérer le projet. Les administrateurs sont responsables de tous les projets.
      </p>
      {draft && (
        <>
          <label>
            Autres membres
            <select
              aria-label="Rôle des autres membres"
              disabled={!canManage || busy}
              value={draft.memberRole}
              onChange={event => setDraft({ ...draft, memberRole: event.target.value })}
            >
              {Object.entries(memberRoleLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <ul className="project-members" aria-label="Membres du projet">
            {draft.members.map(member => (
              <li key={member.id}>
                <span>{member.name}</span>
                {member.admin ? (
                  <span className="muted">Responsable (administrateur)</span>
                ) : (
                  <select
                    aria-label={`Rôle de ${member.name}`}
                    disabled={!canManage || busy}
                    value={member.explicit || ''}
                    onChange={event => setExplicit(member.id, event.target.value)}
                  >
                    <option value="">Comme les autres membres</option>
                    {Object.entries(roleLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
          {canManage ? (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
              Enregistrer les droits
            </button>
          ) : (
            <p className="muted">Seuls les responsables du projet peuvent modifier ces droits.</p>
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
