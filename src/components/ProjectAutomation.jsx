import React, { useEffect, useState } from 'react';
import GithubSetup from './GithubSetup.jsx';
import AgentSetup, { workRequest } from './AgentSetup.jsx';
import AiSettings from './AiSettings.jsx';

export default function ProjectAutomation({ project, user, onAiConfigured }) {
  const [configuration, setConfiguration] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    workRequest(`projects/${project.id}/github`, 'GET', null, controller.signal)
      .then(setConfiguration).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [project.id]);
  return <div className="accounts-panel project-automation">
    <p><strong>{project.name}</strong> · identifiant : <code>{project.id}</code></p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!configuration && !error && <p role="status">Chargement des paramètres…</p>}
    {configuration && <>
      <p>Le dépôt, le moteur et le modèle s’appliquent au projet. L’effort se choisit dans chaque carte. Les changements du dépôt passent par une PR fusionnée automatiquement ; les fichiers seuls sont livrés dans la carte.</p>
      <AiSettings projectId={project.id} user={user} onConfigured={onAiConfigured} />
      {user.role === 'admin' ? <><GithubSetup projectId={project.id} configuration={configuration} onConfigured={setConfiguration} /><AgentSetup projectId={project.id} /></> : <p>Dépôt : {configuration.repository || 'non configuré'}. Un administrateur peut modifier ces paramètres.</p>}
    </>}
  </div>;
}
