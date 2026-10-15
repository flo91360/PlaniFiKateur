import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

export const roleLabels = { viewer: 'Lecture', editor: 'Contribution', manager: 'Responsable' };
const memberRoleLabels = { none: 'Aucun accès (projet masqué)', ...roleLabels };

// Membres et droits du projet : rôle des autres membres et rôles nommés. Modifiable par un responsable.
export default function ProjectMembers({ projectId, canManage, onChanged }) {
  const access = useApiResource(`projects/${projectId}/members`);
  const action = useApiAction();
  const [edited, setDraft] = useState(null);
  const draft = edited || access.data || null,
    busy = action.busy;
  const setExplicit = (id, role) =>
    setDraft({
      ...draft,
      members: draft.members.map(member => (member.id === id ? { ...member, explicit: role || null } : member)),
    });
  const save = () =>
    action.run(async () => {
      const members = Object.fromEntries(
        draft.members
          .filter(member => !member.admin)
          .filter(member => member.explicit !== access.data.members.find(item => item.id === member.id)?.explicit)
          .map(member => [member.id, member.explicit]),
      );
      access.setData(
        await apiData(`projects/${projectId}/members`, {
          method: 'PUT',
          data: { memberRole: draft.memberRole, members },
        }),
      );
      setDraft(null);
      await onChanged?.();
    }, 'Droits enregistrés pour ce projet.');
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
      <FormStatus message={action.message} error={action.error || access.error} />
    </details>
  );
}
