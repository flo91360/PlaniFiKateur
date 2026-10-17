import React, { useEffect, useRef, useState } from 'react';
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

// Largeur où le panneau devient escamotable (même seuil que src/styles/responsive.css).
const MOBILE = '(max-width: 700px)';
function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE);
    if (!query) return;
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

// Navigation entre projets ; sur mobile, panneau ouvert par la barre supérieure. Fermé, il est
// hors de l’écran et inerte : ni le clavier ni les lecteurs d’écran n’y entrent. Ouvert, Échap le
// referme.
export default function Sidebar({ projects, currentId, user, offline, open, onClose, onChooseProject, onOpenModal }) {
  const mobile = useMobile();
  const panel = useRef(null);
  useEffect(() => {
    if (!open || !mobile) return;
    panel.current?.querySelector('a, button')?.focus();
    const close = e => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open, mobile, onClose]);
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside
        ref={panel}
        className={`sidebar ${open ? 'open' : ''}`}
        aria-label="Menu principal"
        inert={mobile && !open ? true : undefined}
      >
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
