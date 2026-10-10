import React, { useState } from 'react';
import { workRequest } from './AgentSetup.jsx';
export default function GithubSetup({ projectId, configuration, onConfigured }) {
  const [repository, setRepository] = useState(configuration?.repository || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { await workRequest(`projects/${projectId}/github`, 'PUT', { repository: repository.trim() }); onConfigured(await workRequest(`projects/${projectId}/github`)); }
    catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  return <details className="agent-setup"><summary>Dépôt GitHub et fusion automatique</summary><label>Dépôt du projet<input aria-label="Dépôt du projet" placeholder="propriétaire/dépôt" value={repository} onChange={e => setRepository(e.target.value)} maxLength={200} /></label><button className="secondary-button" disabled={busy || !repository.trim()} onClick={() => void save()}>Enregistrer le dépôt</button><p>Les PR de l’agent vers main seront fusionnées après réussite des tests serveur et navigateur. La carte sera terminée après confirmation de GitHub.</p>{!configuration?.webhookConfigured && <p>La connexion GitHub reste à configurer sur le serveur et dans le dépôt.</p>}<a href="https://github.com/flo91360/PlaniFiKateur/blob/main/docs/github.md" target="_blank" rel="noreferrer">Guide de configuration GitHub</a>{error && <p role="alert" className="form-error">{error}</p>}</details>;
}
