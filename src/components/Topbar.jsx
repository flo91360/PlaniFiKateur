import React from 'react';
import { ChevronRight, CircleHelp, FolderKanban, History, Inbox, Menu } from 'lucide-react';
import { avatarLabel } from './Avatar.jsx';

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
