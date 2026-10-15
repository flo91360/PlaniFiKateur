import React from 'react';
import { ChevronRight, Layers3, Plus, Sparkles } from 'lucide-react';
import { ideaCards } from '../lib/infos.js';
import Avatar from './Avatar.jsx';
import { version as appVersion } from '../../package.json';

function AgentTip({ offline }) {
  return (
    <div className="sidebar-tip">
      <span className="tip-icon">
        <Sparkles size={19} />
      </span>
      {offline ? (
        <>
          <h3>Copie hors ligne.</h3>
          <p>
            Vos cartes restent dans ce navigateur. Importez-les dans le site connecté pour les confier à l’agent IA.
          </p>
        </>
      ) : (
        <>
          <h3>
            Une carte prête,
            <br />
            un agent au travail.
          </h3>
          <p>
            Passez une carte au statut « Prête à démarrer » : l’agent IA la réalise, pose ses questions dans la
            discussion et livre une PR fusionnée après les tests.
          </p>
        </>
      )}
    </div>
  );
}

// Navigation entre projets ; sur mobile, panneau ouvert par la barre supérieure.
export default function Sidebar({ projects, currentId, user, offline, open, onClose, onChooseProject, onOpenModal }) {
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <a
          className="brand"
          href="#"
          onClick={e => {
            e.preventDefault();
            onChooseProject(projects[0]?.id ?? null);
          }}
        >
          <span className="brand-icon">
            <Layers3 size={23} />
          </span>
          PlaniFiKateur<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">VOTRE ESPACE DE TRAVAIL</div>
        <button
          className="workspace-button"
          onClick={() => {
            onClose();
            onOpenModal('overview');
          }}
        >
          <span className="workspace-avatar">P</span>
          <span>
            Espace personnel<small>Un peu d’ordre, plein d’idées</small>
          </span>
          <ChevronRight size={15} />
        </button>
        <div className="sidebar-section-title">
          <span>MES PROJETS</span>
          <button aria-label="Créer un projet" onClick={() => onOpenModal('project')}>
            <Plus size={17} />
          </button>
        </div>
        <nav aria-label="Projets">
          {projects.map(p => (
            <button
              key={p.id}
              className={`project-link ${currentId === p.id ? 'active' : ''}`}
              onClick={() => onChooseProject(p.id)}
            >
              <span className="project-symbol" style={{ color: p.color }}>
                {p.emoji}
              </span>
              <span>{p.name}</span>
              <span className="project-count">{ideaCards(p).length}</span>
            </button>
          ))}
        </nav>
        <button className="new-project" onClick={() => onOpenModal('project')}>
          <Plus size={16} />
          Nouveau projet
        </button>
        <AgentTip offline={offline} />
        <div className="sidebar-footer">
          <Avatar name={user?.name} />
          <div>
            {user?.name || 'Votre espace'}
            <small>
              v{appVersion} · {offline ? 'données locales' : 'connecté au serveur'}
            </small>
          </div>
          <span className="online-dot" />
        </div>
      </aside>
    </>
  );
}
