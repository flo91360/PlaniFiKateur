import React, { useEffect, useState } from 'react';
export async function workRequest(path, method = 'GET', data, signal) {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    credentials: 'same-origin',
    signal,
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Action indisponible.');
  return result.data;
}
export default function AgentSetup({ projectId }) {
  const [agent, setAgent] = useState(null),
    [name, setName] = useState('Agent principal'),
    [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [confirm, setConfirm] = useState(false);
  const load = async () => {
    setAgent((await workRequest('agents')).find(a => a.active) || null);
    setLoaded(true);
  };
  useEffect(() => {
    void load().catch(e => setError(e.message));
  }, []);
  const action = async fn => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="agent-setup">
      <summary>Connexion de l’agent (administrateur)</summary>
      <p>Un seul agent actif. Sa clé autorise uniquement le travail dans les projets sélectionnés.</p>
      {agent ? (
        <>
          <p>
            <strong>{agent.name}</strong> ·{' '}
            {agent.projectIds.includes(projectId) ? 'Autorisé sur ce projet' : 'Projet non autorisé'}
          </p>
          {!agent.projectIds.includes(projectId) && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  workRequest(`agents/${agent.id}`, 'PUT', {
                    name: agent.name,
                    projectIds: [...agent.projectIds, projectId],
                  }),
                )
              }
            >
              Autoriser ce projet
            </button>
          )}
          {confirm ? (
            <>
              <p>Révoquer la clé et interrompre les travaux en cours ?</p>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await workRequest(`agents/${agent.id}`, 'DELETE');
                    setToken('');
                    setConfirm(false);
                  })
                }
              >
                Confirmer la révocation
              </button>
              <button className="secondary-button" onClick={() => setConfirm(false)}>
                Conserver la clé
              </button>
            </>
          ) : (
            <button className="secondary-button" disabled={busy} onClick={() => setConfirm(true)}>
              Révoquer la clé de l’agent
            </button>
          )}
        </>
      ) : (
        <>
          <label>
            Nom de l’agent
            <input aria-label="Nom de l’agent" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
          </label>
          <button
            className="secondary-button"
            disabled={busy || !loaded || !name.trim()}
            onClick={() =>
              void action(async () => {
                const result = await workRequest('agents', 'POST', { name, projectIds: [projectId] });
                setToken(result.token);
              })
            }
          >
            Créer la clé de l’agent
          </button>
        </>
      )}
      {token && (
        <>
          <label>
            Clé de l’agent
            <input aria-label="Clé de l’agent" readOnly value={token} onFocus={e => e.target.select()} />
          </label>
          <p>
            Copiez cette clé dans la configuration de votre agent. Elle ne sera affichée qu’ici, jusqu’à la fermeture
            des paramètres du projet. Ne la placez pas dans une carte.
          </p>
          <button className="secondary-button" onClick={() => setToken('')}>
            Masquer la clé
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p>
        Le service d’exécution externe doit être connecté pour commencer le travail.{' '}
        <a href="/agent-guide.html" target="_blank" rel="noreferrer">
          Guide de connexion à l’API
        </a>
      </p>
    </details>
  );
}
