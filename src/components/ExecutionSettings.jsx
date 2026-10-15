import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { executionPresets, validateExecutionProfile } from '../../worker/execution-profile.mjs';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

export default function ExecutionSettings({ projectId, repository, user }) {
  // Le profil par défaut dépend du dépôt : il est relu quand le dépôt change.
  const saved = useApiResource(`projects/${projectId}/execution`, { key: repository || '' });
  const worker = useApiResource(`projects/${projectId}/worker-status`, { key: repository || '', every: 30000 });
  const action = useApiAction();
  // Profil en cours de modification, oublié quand le dépôt change.
  const [draft, setDraft] = useState({ repository, profile: null });
  const profile = (draft.repository === repository && draft.profile) || saved.data,
    status = worker.data,
    busy = action.busy,
    setProfile = next => setDraft({ repository, profile: next });
  const save = () =>
    action.run(async () => {
      saved.setData(
        await apiData(`projects/${projectId}/execution`, {
          method: 'PUT',
          data: { preset: profile.preset, branch: profile.branch },
        }),
      );
      setDraft({ repository, profile: null });
      worker.setData(null);
    }, 'Profil enregistré pour les prochaines tâches.');
  return (
    <details className="agent-setup">
      <summary>Exécution et connexion du projet</summary>
      <p>
        Le worker utilise les outils et les vérifications de ce projet. Une tâche commencée conserve son profil jusqu’à
        sa livraison.
      </p>
      {profile && (
        <>
          <label>
            Profil d’exécution
            <select
              aria-label="Profil d’exécution"
              disabled={user.role !== 'admin' || busy}
              value={profile.preset}
              onChange={event =>
                setProfile(validateExecutionProfile({ preset: event.target.value, branch: profile.branch }))
              }
            >
              {Object.entries(executionPresets).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <p>{executionPresets[profile.preset].description}</p>
          <label>
            Branche cible
            <input
              aria-label="Branche cible"
              value={profile.branch}
              maxLength={128}
              disabled={user.role !== 'admin' || busy}
              onChange={event => setProfile({ ...profile, branch: event.target.value })}
            />
          </label>
          <p>Fusion automatique après réussite des contrôles : {profile.workflow.jobs.join(', ')}.</p>
          {user.role === 'admin' && (
            <button className="secondary-button" disabled={busy} onClick={() => void save()}>
              Enregistrer le profil
            </button>
          )}
        </>
      )}
      <FormStatus message={action.message} error={action.error || saved.error || worker.error} />
      <p>
        <strong>Connexion du worker</strong>
      </p>
      {!status || status.stale ? (
        <p>En attente d’un contrôle du worker avec la configuration actuelle.</p>
      ) : (
        <>
          <p>
            {status.state === 'ready' ? 'Configuration contrôlée' : 'Configuration à compléter'} ·{' '}
            {new Date(status.date).toLocaleString('fr-FR')}
          </p>
          <ul>
            {status.checks.map(check => (
              <li key={check.name}>
                <strong>{check.name}</strong> : {check.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
