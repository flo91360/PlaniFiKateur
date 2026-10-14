import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, FolderKanban, Plus } from 'lucide-react';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import './style.css';
import { withInfos } from './lib/infos.js';
import { createId as uid } from './lib/id.js';
import { apiData } from './lib/api-client.js';
import { useWorkspace, offlineMode, exportWorkspace } from './lib/use-workspace.js';
import { useCardFollowers } from './lib/use-card-followers.js';
import { useAttention } from './lib/use-attention.js';
import ConnectionScreen from './components/AccountScreen.jsx';
import AccountsPanel from './components/AccountsPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import AttentionPanel from './components/AttentionPanel.jsx';
import Board from './components/Board.jsx';
import CardDetail from './components/CardDetail.jsx';
import CreationForm from './components/CreationForm.jsx';
import Dialog from './components/Dialog.jsx';
import InfoPanel from './components/InfoPanel.jsx';
import ProjectAutomation from './components/ProjectAutomation.jsx';
import ProjectHeader from './components/ProjectHeader.jsx';
import Sidebar from './components/Sidebar.jsx';
import SyncAlerts from './components/SyncAlerts.jsx';
import Topbar from './components/Topbar.jsx';

const DEFAULT_AI = { engine: 'codex', model: '' };
const NO_FILTERS = { query: '', statusFilter: 'all' };

// Une modale est soit un nom ('project', 'info'…), soit un objet { type, … }.
const modalKind = modal => (typeof modal === 'string' ? modal : modal?.type);
const dialogTitles = {
  'project-settings': 'Paramètres du projet',
  project: 'Un nouveau projet',
  list: 'Une nouvelle liste',
  'delete-project': 'Supprimer le projet',
  account: 'Mon compte',
  activity: 'Activité des projets',
  attention: 'À traiter',
  reload: 'Recharger le tableau',
  card: 'Une nouvelle idée',
  overview: 'Votre espace personnel',
  info: 'À propos de PlaniFiKateur',
};

const attachmentSize = (projects, exceptCardId) =>
  projects
    .flatMap(p => p.cards)
    .filter(c => c.id !== exceptCardId)
    .flatMap(c => c.attachments || [])
    .reduce((sum, a) => sum + a.size, 0);

// Moteur IA du projet : il détermine les niveaux d’effort proposés dans les cartes.
function useProjectAi(projectId, ready) {
  const [ai, setAi] = useState(DEFAULT_AI);
  useEffect(() => {
    setAi(DEFAULT_AI);
    if (offlineMode || !ready || !projectId) return;
    const controller = new AbortController();
    apiData(`projects/${projectId}/ai`, { signal: controller.signal })
      .then(setAi)
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, ready]);
  return [ai, setAi];
}

function useNotice() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

function DeleteProjectConfirm({ name, onCancel, onConfirm }) {
  return (
    <div className="project-delete-confirm">
      <p>
        Supprimer définitivement le projet <strong>{name}</strong> ?
      </p>
      <p>Ses listes, cartes et commentaires seront également supprimés. Cette action est irréversible.</p>
      <div className="transfer-actions">
        <button className="secondary-button" onClick={onCancel}>
          Annuler
        </button>
        <button className="danger-button" onClick={onConfirm}>
          Confirmer la suppression
        </button>
      </div>
    </div>
  );
}

function App() {
  const [acceptingInvitation, setAcceptingInvitation] = useState(() =>
    /^#invitation=[a-f0-9]{64}$/.test(location.hash),
  );
  const [modal, setModal] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const workspace = useWorkspace({ pauseRefresh: !!modal || !!selectedId || !!dragging });
  const { projects, setProjects, ready, needsLogin, saveStatus } = workspace;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? null);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [sidebar, setSidebar] = useState(false);
  const [notice, setNotice] = useNotice();
  const project = projects.find(p => p.id === projectId) || projects[0];
  const selected = project?.cards.find(c => c.id === selectedId);
  const cardFollowers = useCardFollowers({
    project,
    enabled: !offlineMode && ready && !needsLogin,
    saveStatus,
    selectedId,
    modal,
  });
  const [projectAi, setProjectAi] = useProjectAi(project?.id, ready);
  const attention = useAttention({ enabled: !offlineMode && ready && !needsLogin, projects });

  const updateProject = transform =>
    setProjects(ps => {
      let changed = false;
      const next = ps.map(p => {
        if (p.id !== project.id) return p;
        const updated = transform(p);
        changed ||= updated !== p;
        return updated;
      });
      return changed ? next : ps;
    });
  const updateCard = (id, patch) =>
    updateProject(p => {
      const card = p.cards.find(c => c.id === id);
      if (!card || Object.entries(patch).every(([key, value]) => JSON.stringify(card[key]) === JSON.stringify(value)))
        return p;
      return { ...p, cards: p.cards.map(c => (c.id === id ? { ...c, ...patch } : c)) };
    });
  const chooseProject = id => {
    setProjectId(id);
    setFilters(NO_FILTERS);
    setSelectedId(null);
    setSidebar(false);
  };
  const openCard = (id, cardId) => {
    chooseProject(id);
    setModal(null);
    setSelectedId(cardId);
  };

  const createProject = values => {
    const id = uid();
    const newProject = withInfos({
      id,
      name: values.title,
      description: values.description || 'Votre prochaine grande idée commence ici.',
      emoji: '◈',
      color: '#e1e7cd',
      lists: [
        { id: uid(), name: 'Améliorations', color: 'green' },
        { id: uid(), name: 'Nouvelles idées', color: 'purple' },
        { id: uid(), name: 'Bugs', color: 'orange' },
      ],
      cards: [],
    });
    setProjects(ps => [...ps, newProject]);
    chooseProject(id);
    setNotice('Projet créé');
  };
  const createList = values => {
    const newList = { id: uid(), name: values.title, color: ['green', 'purple', 'orange'][project.lists.length % 3] };
    updateProject(p => ({ ...p, lists: [...p.lists, newList] }));
    setNotice('Liste créée');
  };
  const createCard = values => {
    const newCard = {
      id: uid(),
      listId: values.listId,
      title: values.title,
      description: values.description,
      status: values.status,
      priority: values.priority,
      aiEffort: values.aiEffort,
      tags: values.tags,
      comments: values.comment
        ? [{ id: uid(), author: 'Vous', text: values.comment, date: new Date().toISOString() }]
        : [],
      checklist: values.checklist,
      attachments: values.attachments,
    };
    updateProject(p => ({ ...p, cards: [...p.cards, newCard] }));
    setFilters(NO_FILTERS);
    setNotice('Carte créée');
  };
  const deleteProject = id => {
    const remaining = projects.filter(p => p.id !== id);
    setProjects(remaining);
    chooseProject(remaining[0]?.id ?? null);
    setDragging(null);
    setModal(null);
    setNotice('Projet supprimé');
  };

  const renderDialog = kind => {
    const close = () => setModal(null);
    switch (kind) {
      case 'project-settings':
        return (
          <ProjectAutomation key={project.id} project={project} user={workspace.user} onAiConfigured={setProjectAi} />
        );
      case 'project':
      case 'list':
      case 'card':
        return (
          <CreationForm
            engine={projectAi.engine}
            offline={offlineMode}
            projectId={project?.id}
            type={kind}
            attachmentBytes={attachmentSize(projects)}
            lists={project?.lists || []}
            listId={modal.listId}
            onCancel={close}
            onSubmit={values => {
              ({ project: createProject, list: createList, card: createCard })[kind](values);
              close();
            }}
          />
        );
      case 'account':
        return (
          <AccountsPanel
            user={workspace.user}
            onLogout={async () => {
              await workspace.logout();
              close();
              setSelectedId(null);
            }}
          />
        );
      case 'attention':
        return <AttentionPanel items={attention} onOpenCard={openCard} />;
      case 'activity':
        return (
          <div className="accounts-panel">
            <ActivityPanel />
          </div>
        );
      case 'delete-project':
        return (
          <DeleteProjectConfirm
            name={projects.find(p => p.id === modal.projectId)?.name}
            onCancel={close}
            onConfirm={() => deleteProject(modal.projectId)}
          />
        );
      default:
        return (
          <InfoPanel
            view={kind}
            projects={projects}
            offline={offlineMode}
            isAdmin={workspace.user?.role === 'admin'}
            onImport={imported => {
              setProjects(ps => [...ps, ...imported]);
              setNotice('Projets importés, sans remplacer les projets existants');
            }}
            onReload={() => {
              close();
              void workspace.reload();
            }}
            onClose={close}
          />
        );
    }
  };

  if (!offlineMode && (!ready || acceptingInvitation))
    return (
      <ConnectionScreen
        needsLogin={needsLogin}
        needsSetup={workspace.needsSetup}
        error={workspace.loadError}
        onLogin={workspace.login}
        onSetup={workspace.setup}
        onAccept={async data => {
          await workspace.accept(data);
          setAcceptingInvitation(false);
        }}
        onRetry={workspace.reload}
      />
    );
  const kind = modalKind(modal);
  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        currentId={project?.id}
        user={workspace.user}
        offline={offlineMode}
        open={sidebar}
        onClose={() => setSidebar(false)}
        onChooseProject={chooseProject}
        onOpenModal={setModal}
      />
      <main>
        <Topbar
          projectName={project?.name}
          saveStatus={saveStatus}
          user={workspace.user}
          offline={offlineMode}
          attentionCount={attention.length}
          onOpenSidebar={() => setSidebar(true)}
          onOpenModal={setModal}
        />
        <div className="page-content">
          {!offlineMode && (
            <SyncAlerts
              syncError={workspace.syncError}
              saveStatus={saveStatus}
              saveError={workspace.saveError}
              onRefresh={workspace.refresh}
              onExport={() => exportWorkspace(projects)}
              onReload={() => setModal('reload')}
              onRetrySave={workspace.retrySave}
            />
          )}
          {project ? (
            <>
              <ProjectHeader
                project={project}
                offline={offlineMode}
                onOpenSettings={() => setModal('project-settings')}
                onDelete={() => setModal({ type: 'delete-project', projectId: project.id })}
              />
              <Board
                key={project.id}
                project={project}
                followers={cardFollowers}
                filters={filters}
                onFilters={setFilters}
                dragging={dragging}
                onDragging={setDragging}
                onMoveCard={(cardId, listId) => {
                  updateCard(cardId, { listId });
                  setNotice('Carte déplacée');
                }}
                onOpenCard={setSelectedId}
                onAddCard={listId => setModal({ type: 'card', listId })}
                onAddList={() => setModal('list')}
              />
            </>
          ) : (
            <div className="empty-workspace">
              <FolderKanban size={36} />
              <h1>Aucun projet pour le moment</h1>
              <p>Créez un projet pour organiser vos idées.</p>
              <button className="primary-button" onClick={() => setModal('project')}>
                <Plus size={16} />
                Créer un projet
              </button>
            </div>
          )}
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {offlineMode && saveStatus === 'error' && (
        <div className="storage-warning" role="alert">
          Les modifications restent en mémoire, mais ne pourront pas être conservées après fermeture. Vérifiez les
          autorisations de stockage de votre navigateur.
        </div>
      )}
      {modal && (
        <Dialog wide={kind === 'card'} title={dialogTitles[kind] || dialogTitles.info} onClose={() => setModal(null)}>
          {renderDialog(kind)}
        </Dialog>
      )}
      {selected && (
        <CardDetail
          engine={projectAi.engine}
          attachmentBytes={attachmentSize(projects, selected.id)}
          onWorkflowRefresh={() => workspace.refresh({ whileEditing: true })}
          offline={offlineMode}
          projectId={project.id}
          user={workspace.user}
          saveStatus={saveStatus}
          card={selected}
          lists={project.lists}
          onClose={() => setSelectedId(null)}
          onUpdate={patch => updateCard(selected.id, patch)}
          onDelete={() => {
            updateProject(p => ({ ...p, cards: p.cards.filter(c => c.id !== selected.id) }));
            setSelectedId(null);
            setNotice('Carte supprimée');
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
