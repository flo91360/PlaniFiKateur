import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

export default function AgentSetup({ projectId }) {
  const agents = useApiResource('agents');
  const request = useApiAction();
  const [name, setName] = useState('Agent principal'),
    [token, setToken] = useState(''),
    [confirm, setConfirm] = useState(false);
  const agent = agents.data?.find(item => item.active) || null,
    loaded = agents.loaded,
    busy = request.busy,
    error = request.error || agents.error;
  // Chaque action relit la liste des agents : la clé, ses projets ou sa révocation ont changé.
  const action = work =>
    request.run(async () => {
      await work();
      agents.setData(await apiData('agents'));
    });
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
                  apiData(`agents/${agent.id}`, {
                    method: 'PUT',
                    data: { name: agent.name, projectIds: [...agent.projectIds, projectId] },
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
                    await apiData(`agents/${agent.id}`, { method: 'DELETE' });
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
                const result = await apiData('agents', { method: 'POST', data: { name, projectIds: [projectId] } });
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
      <FormStatus error={error} />
      <p>
        Le service d’exécution externe doit être connecté pour commencer le travail.{' '}
        <a href="/agent-guide.html" target="_blank" rel="noreferrer">
          Guide de connexion à l’API
        </a>
      </p>
    </details>
  );
}
