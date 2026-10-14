import React, { useEffect, useState } from 'react';
import { workRequest } from './AgentSetup.jsx';
import { executionPresets, validateExecutionProfile } from '../../worker/execution-profile.mjs';

export default function ExecutionSettings({ projectId, repository, user }) {
  const [profile, setProfile] = useState(null),
    [status, setStatus] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setProfile(null);
    setStatus(null);
    setError('');
    setMessage('');
    Promise.all([
      workRequest(`projects/${projectId}/execution`, 'GET', null, controller.signal),
      workRequest(`projects/${projectId}/worker-status`, 'GET', null, controller.signal),
    ])
      .then(([value, report]) => {
        setProfile(value);
        setStatus(report);
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    const timer = setInterval(() => {
      workRequest(`projects/${projectId}/worker-status`, 'GET', null, controller.signal)
        .then(setStatus)
        .catch(() => {});
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [projectId, repository]);
  const save = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setProfile(await workRequest(`projects/${projectId}/execution`, 'PUT', profile));
      setStatus(null);
      setMessage('Profil enregistré pour les prochaines tâches.');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
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
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
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
