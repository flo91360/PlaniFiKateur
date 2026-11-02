import React from 'react';
import { Bell, Bot, ChevronRight, CircleHelp, FolderKanban, History, Inbox, Menu, Moon, Sun } from 'lucide-react';
import { avatarLabel } from './Avatar.jsx';
import { workerSummary } from '../lib/worker-status.js';

function saveLabel(saveStatus, offline) {
  if (saveStatus === 'saving') return 'Enregistrement…';
  if (saveStatus !== 'saved') return 'Sauvegarde indisponible';
  return offline ? 'Sauvegardé sur cet appareil' : 'Sauvegardé sur le serveur';
}

export default function Topbar({
  projectName,
  saveStatus,
  user,
  offline,
  attentionCount = 0,
  unreadCount = 0,
  workerActivity = null,
  dark = false,
  onToggleTheme,
  onOpenSidebar,
  onOpenModal,
}) {
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <button className="icon-button mobile-menu" aria-label="Ouvrir les projets" onClick={onOpenSidebar}>
          <Menu size={20} />
        </button>
        <FolderKanban size={17} />
        <span>Mes projets</span>
        <ChevronRight size={14} />
        <strong>{projectName || 'Votre espace'}</strong>
      </div>
      <div className="topbar-right">
        <span className="save-indicator">
          <span className={saveStatus === 'error' || saveStatus === 'conflict' ? 'error-dot' : 'online-dot'} />
          {saveLabel(saveStatus, offline)}
        </span>
        {!offline && workerActivity && (
          <WorkerIndicator activity={workerActivity} onOpen={() => onOpenModal('worker')} />
        )}
        {!offline && (
          <button
            className={`icon-button attention-button ${attentionCount ? 'pending' : ''}`}
            aria-label={attentionCount ? `À traiter (${attentionCount})` : 'À traiter'}
            title={attentionCount ? `${attentionCount} carte(s) attendent une réponse` : 'Rien à traiter'}
            onClick={() => onOpenModal('attention')}
          >
            <Inbox size={19} />
            {attentionCount > 0 && <span className="attention-count">{attentionCount}</span>}
          </button>
        )}
        {!offline && (
          <button
            className={`icon-button attention-button ${unreadCount ? 'pending' : ''}`}
            aria-label={unreadCount ? `Notifications (${unreadCount} non lues)` : 'Notifications'}
            title={unreadCount ? `${unreadCount} notification(s) non lue(s)` : 'Aucune notification non lue'}
            onClick={() => onOpenModal('notifications')}
          >
            <Bell size={19} />
            {unreadCount > 0 && <span className="attention-count">{unreadCount}</span>}
          </button>
        )}
        <button
          className="icon-button"
          aria-label={dark ? 'Passer au thème clair' : 'Passer au thème sombre'}
          title={dark ? 'Passer au thème clair' : 'Passer au thème sombre'}
          onClick={onToggleTheme}
        >
          {dark ? <Sun size={19} /> : <Moon size={19} />}
        </button>
        <button className="icon-button" aria-label="Informations sur PlaniFiKateur" onClick={() => onOpenModal('info')}>
          <CircleHelp size={19} />
        </button>
        {!offline && (
          <button className="icon-button" aria-label="Historique des projets" onClick={() => onOpenModal('activity')}>
            <History size={19} />
          </button>
        )}
        <button
          className="header-avatar"
          aria-label="Mon compte"
          onClick={() => onOpenModal(offline ? 'info' : 'account')}
        >
          {avatarLabel(user?.name)}
        </button>
      </div>
    </header>
  );
}

// Worker IA : point coloré et état court ; le détail (cartes en cours et en attente) s’ouvre au clic.
function WorkerIndicator({ activity, onOpen }) {
  const summary = workerSummary(activity);
  const text = summary.detail ? `${summary.label} : ${summary.detail}` : summary.label;
  return (
    <button
      className={`worker-indicator ${summary.tone}`}
      aria-label={`Worker IA, ${text}`}
      title={text}
      onClick={onOpen}
    >
      <Bot size={17} />
      <span className="worker-dot" />
      <span className="worker-label">{summary.label}</span>
      {summary.running + summary.queued > 0 && <span className="worker-count">{summary.running + summary.queued}</span>}
    </button>
  );
}
