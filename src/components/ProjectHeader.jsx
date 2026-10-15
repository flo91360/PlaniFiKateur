import React from 'react';
import { CheckCheck, CircleHelp, Clock3, Lightbulb, Pencil, Trash2 } from 'lucide-react';
import { ideaCards } from '../lib/infos.js';

function Stat({ icon: Icon, tone, value, label, hint }) {
  return (
    <div className="stat">
      <span className={`stat-icon ${tone}`}>
        <Icon size={18} />
      </span>
      <div>
        <strong>
          {value}
          <small>{label}</small>
        </strong>
        <span>{hint}</span>
      </div>
    </div>
  );
}

function ProjectStats({ cards }) {
  const count = status => cards.filter(c => c.status === status).length;
  const total = cards.length,
    done = count('done');
  return (
    <div className="stats">
      <Stat
        icon={Lightbulb}
        tone="neutral"
        value={total}
        label="idées au total"
        hint="Toutes vos pistes, au même endroit"
      />
      <Stat icon={Clock3} tone="blue" value={count('progress')} label="en cours" hint="Des idées qui prennent forme" />
      <Stat
        icon={CircleHelp}
        tone="amber"
        value={count('clarify')}
        label="à préciser"
        hint="Un peu de contexte pour avancer"
      />
      <Stat
        icon={CheckCheck}
        tone="green"
        value={done}
        label="terminées"
        hint={`${total ? Math.round((done / total) * 100) : 0} % des idées concrétisées`}
      />
    </div>
  );
}

export default function ProjectHeader({
  project,
  offline,
  canDelete = true,
  readOnly = false,
  onOpenSettings,
  onEdit,
  onDelete,
}) {
  return (
    <>
      <div className="project-heading">
        <div className="project-title">
          <span className="large-symbol" style={{ background: project.color }}>
            {project.emoji}
          </span>
          <div>
            <div className="eyebrow">DE L’IDÉE À LA RÉALISATION</div>
            <h1>{project.name}</h1>
            <p>{project.description}</p>
          </div>
        </div>
        <div className="project-actions">
          {readOnly && (
            <span className="read-only-badge" title="Votre rôle sur ce projet ne permet pas de le modifier.">
              Lecture seule
            </span>
          )}
          {!offline && (
            <button className="secondary-button" onClick={onOpenSettings}>
              Paramètres du projet
            </button>
          )}
          {canDelete && (
            <button className="secondary-button" onClick={onEdit}>
              <Pencil size={16} />
              Modifier le projet
            </button>
          )}
          {canDelete && (
            <button className="delete-button project-delete" onClick={onDelete}>
              <Trash2 size={16} />
              Supprimer le projet
            </button>
          )}
        </div>
      </div>
      <ProjectStats cards={ideaCards(project)} />
    </>
  );
}
