import React, { useId, useRef, useState } from 'react';
import GithubSetup from './GithubSetup.jsx';
import AgentSetup from './AgentSetup.jsx';
import { useApiResource } from '../lib/use-api.js';
import AiSettings from './AiSettings.jsx';
import ExecutionSettings from './ExecutionSettings.jsx';
import DriveArchive from './DriveArchive.jsx';
import ProjectMembers, { roleLabels } from './ProjectMembers.jsx';
import MergeApproval from './MergeApproval.jsx';
import { useProjectAccess } from '../lib/project-access.js';

const engineLabels = { codex: 'Codex', 'claude-code': 'Claude Code' };

// Paramètres d’un projet en onglets ; chaque onglet résume son état. Les panneaux restent montés :
// un réglage en cours de saisie survit au changement d’onglet.
export default function ProjectAutomation({ project, user, onAiConfigured, onAccessChanged }) {
  const { role, canManage } = useProjectAccess();
  const github = useApiResource(`projects/${project.id}/github`);
  const configuration = github.data || null,
    setConfiguration = github.setData,
    error = github.error;
  const [tab, setTab] = useState('access'),
    [ai, setAi] = useState(null),
    [approval, setApproval] = useState(null);
  const id = useId(),
    tabs = useRef({});
  const sections = [
    {
      key: 'access',
      label: 'Accès',
      state: [
        `votre rôle : ${(roleLabels[role] || 'Lecture').toLowerCase()}`,
        approval === null ? '' : approval ? 'PR approuvées avant fusion' : 'fusion sans approbation',
      ]
        .filter(Boolean)
        .join(' · '),
    },
    {
      key: 'ai',
      label: 'Agent IA',
      state: ai ? `${engineLabels[ai.engine] || ai.engine} · ${ai.model || 'modèle par défaut'}` : '',
    },
    { key: 'repository', label: 'Dépôt', state: configuration?.repository || 'non configuré' },
  ];
  const keydown = event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = sections.findIndex(section => section.key === tab);
    const next = sections[(index + step + sections.length) % sections.length].key;
    setTab(next);
    tabs.current[next]?.focus();
  };
  const panel = (key, children) => (
    <div role="tabpanel" id={`${id}-${key}`} aria-labelledby={`${id}-${key}-tab`} hidden={tab !== key}>
      {children}
    </div>
  );
  return (
    <div className="accounts-panel project-automation">
      <p>
        <strong>{project.name}</strong> · identifiant : <code>{project.id}</code>
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!configuration && !error && <p role="status">Chargement des paramètres…</p>}
      {configuration && (
        <>
          <div className="settings-tabs" role="tablist" aria-label="Paramètres du projet" onKeyDown={keydown}>
            {sections.map(section => (
              <button
                key={section.key}
                ref={element => (tabs.current[section.key] = element)}
                type="button"
                role="tab"
                id={`${id}-${section.key}-tab`}
                aria-controls={`${id}-${section.key}`}
                aria-selected={tab === section.key}
                tabIndex={tab === section.key ? 0 : -1}
                onClick={() => setTab(section.key)}
              >
                <strong>{section.label}</strong>
                {section.state && <span className="muted">{section.state}</span>}
              </button>
            ))}
          </div>
          {panel(
            'access',
            <>
              <ProjectMembers projectId={project.id} canManage={canManage} onChanged={onAccessChanged} />
              <MergeApproval projectId={project.id} canManage={canManage} onState={setApproval} />
            </>,
          )}
          {panel(
            'ai',
            <>
              <p>
                Le moteur et le modèle s’appliquent au projet. L’effort se choisit dans chaque carte. Les changements du
                dépôt passent par une PR fusionnée automatiquement ; les fichiers seuls sont livrés dans la carte.
              </p>
              <AiSettings projectId={project.id} user={user} onConfigured={onAiConfigured} onState={setAi} />
              <ExecutionSettings projectId={project.id} repository={configuration.repository} user={user} />
            </>,
          )}
          {panel(
            'repository',
            <>
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
              <DriveArchive key={configuration.repository || ''} projectId={project.id} user={user} />
            </>,
          )}
        </>
      )}
    </div>
  );
}
