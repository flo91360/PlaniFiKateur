import React, { useEffect, useState } from 'react';
import GithubSetup from './GithubSetup.jsx';
import AgentSetup from './AgentSetup.jsx';
import { apiData } from '../lib/api-client.js';
import AiSettings from './AiSettings.jsx';
import ExecutionSettings from './ExecutionSettings.jsx';
import DriveArchive from './DriveArchive.jsx';
import ProjectMembers, { roleLabels } from './ProjectMembers.jsx';
import MergeApproval from './MergeApproval.jsx';

export default function ProjectAutomation({ project, user, role, onAiConfigured, onAccessChanged }) {
  const [configuration, setConfiguration] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    apiData(`projects/${project.id}/github`, { signal: controller.signal })
      .then(setConfiguration)
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [project.id]);
  return (
    <div className="accounts-panel project-automation">
      <p>
        <strong>{project.name}</strong> · identifiant : <code>{project.id}</code> · votre rôle :{' '}
        {roleLabels[role] || 'Lecture'}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!configuration && !error && <p role="status">Chargement des paramètres…</p>}
      {configuration && (
        <>
          <p>
            Le dépôt, le moteur et le modèle s’appliquent au projet. L’effort se choisit dans chaque carte. Les
            changements du dépôt passent par une PR fusionnée automatiquement ; les fichiers seuls sont livrés dans la
            carte.
          </p>
          <ProjectMembers projectId={project.id} canManage={role === 'manager'} onChanged={onAccessChanged} />
          <MergeApproval projectId={project.id} canManage={role === 'manager'} />
          <AiSettings projectId={project.id} user={user} onConfigured={onAiConfigured} />
          <ExecutionSettings projectId={project.id} repository={configuration.repository} user={user} />
          <DriveArchive key={configuration.repository || ''} projectId={project.id} user={user} />
          {user.role === 'admin' ? (
            <>
              <GithubSetup projectId={project.id} configuration={configuration} onConfigured={setConfiguration} />
              <AgentSetup projectId={project.id} />
            </>
          ) : (
            <p>
              Dépôt : {configuration.repository || 'non configuré'}. Un administrateur peut modifier ces paramètres.
            </p>
          )}
        </>
      )}
    </div>
  );
}
