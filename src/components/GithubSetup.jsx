import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';
import { docsLink } from '../lib/links.js';

export default function GithubSetup({ projectId, configuration, onConfigured }) {
  const [repository, setRepository] = useState(configuration?.repository || '');
  const action = useApiAction();
  const save = () =>
    action.run(async () => {
      await apiData(`projects/${projectId}/github`, { method: 'PUT', data: { repository: repository.trim() } });
      onConfigured(await apiData(`projects/${projectId}/github`));
    }, 'Dépôt enregistré pour ce projet.');
  return (
    <details className="agent-setup">
      <summary>Dépôt GitHub et fusion automatique</summary>
      <label>
        Dépôt du projet
        <input
          aria-label="Dépôt du projet"
          placeholder="propriétaire/dépôt"
          value={repository}
          onChange={e => {
            setRepository(e.target.value);
            action.clear();
          }}
          maxLength={200}
        />
      </label>
      <button className="secondary-button" disabled={action.busy || !repository.trim()} onClick={() => void save()}>
        Enregistrer le dépôt
      </button>
      <p>
        Les PR seront fusionnées après réussite des contrôles du profil d’exécution. La carte sera terminée après
        confirmation de GitHub.
      </p>
      {!configuration?.webhookConfigured && (
        <p>La connexion GitHub reste à configurer sur le serveur et dans le dépôt.</p>
      )}
      <a href={docsLink('github.md')} target="_blank" rel="noreferrer">
        Guide de configuration GitHub
      </a>
      <FormStatus message={action.message} error={action.error} />
    </details>
  );
}
