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
import { applyAccent } from './lib/accents.js';
import { useWorkspace, offlineMode, exportWithAlert } from './lib/use-workspace.js';
import { useCardFollowers } from './lib/use-card-followers.js';
import { useAttention } from './lib/use-attention.js';
import { useServerEvents } from './lib/use-server-events.js';
import { useNotifications } from './lib/use-notifications.js';
import ConnectionScreen from './components/AccountScreen.jsx';
import AccountsPanel from './components/AccountsPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import AttentionPanel from './components/AttentionPanel.jsx';
import NotificationsPanel from './components/NotificationsPanel.jsx';
import Board from './components/Board.jsx';
import CardDetail from './components/CardDetail.jsx';
import ErrorBoundary, { DisplayError } from './components/ErrorBoundary.jsx';
import CreationForm from './components/CreationForm.jsx';
import Dialog from './components/Dialog.jsx';
import InfoPanel from './components/InfoPanel.jsx';
import ProjectAutomation from './components/ProjectAutomation.jsx';
import ProjectHeader from './components/ProjectHeader.jsx';
import { ListSettings, ProjectDetailsForm } from './components/EditForms.jsx';
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
  'edit-project': 'Modifier le projet',
  'edit-list': 'Modifier la liste',
  account: 'Mon compte',
  activity: 'Activité des projets',
  attention: 'À traiter',
  notifications: 'Notifications',
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
  // Rôle sur le projet affiché : lecture, contribution ou responsable (tous les droits hors connexion).
  // Un projet absent des droits reçus vient d’être créé dans cette page : son créateur en est responsable.
  const role = offlineMode
    ? 'manager'
    : workspace.access?.[project?.id] || (workspace.access && project ? 'manager' : 'viewer');
  const selected = project?.cards.find(c => c.id === selectedId);
  const cardFollowers = useCardFollowers({ projectId: project?.id, enabled: !offlineMode && ready && !needsLogin });
  const [projectAi, setProjectAi] = useProjectAi(project?.id, ready);
  const attention = useAttention({ enabled: !offlineMode && ready && !needsLogin });
  useServerEvents(!offlineMode && ready && !needsLogin);
  const notifications = useNotifications(!offlineMode && ready && !needsLogin);
  useEffect(() => applyAccent(workspace.accent), [workspace.accent]);

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
  // Déplace une carte d’un rang dans sa liste (vers le haut : -1), au clavier ou au toucher.
  const reorderCard = (id, delta) =>
    updateProject(p => {
      const card = p.cards.find(c => c.id === id);
      const siblings = p.cards.filter(c => c.listId === card?.listId);
      const neighbour = siblings[siblings.indexOf(card) + delta];
      if (!card || !neighbour) return p;
      const cards = [...p.cards];
      const from = cards.indexOf(card),
        to = cards.indexOf(neighbour);
      [cards[from], cards[to]] = [cards[to], cards[from]];
      return { ...p, cards };
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
  const updateList = (listId, fields) =>
    updateProject(p => ({ ...p, lists: p.lists.map(l => (l.id === listId ? { ...l, ...fields } : l)) }));
  const moveList = (listId, delta) =>
    updateProject(p => {
      const from = p.lists.findIndex(l => l.id === listId),
        to = from + delta;
      if (from < 0 || to < 0 || to >= p.lists.length) return p;
      const lists = [...p.lists];
      [lists[from], lists[to]] = [lists[to], lists[from]];
      return { ...p, lists };
    });
  const deleteList = listId => {
    updateProject(p =>
      p.cards.some(c => c.listId === listId) ? p : { ...p, lists: p.lists.filter(l => l.id !== listId) },
    );
    setNotice('Liste supprimée');
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
          <ProjectAutomation
            key={project.id}
            project={project}
            user={workspace.user}
            role={role}
            onAiConfigured={setProjectAi}
            onAccessChanged={() => workspace.refresh({ whileEditing: true })}
          />
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
            canLaunch={role === 'manager'}
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
            accent={workspace.accent}
            onAccent={workspace.setAccent}
            onLogout={async () => {
              await workspace.logout();
              close();
              setSelectedId(null);
            }}
          />
        );
      case 'attention':
        return <AttentionPanel items={attention} onOpenCard={openCard} />;
      case 'notifications':
        return <NotificationsPanel notifications={notifications} onOpenCard={openCard} />;
      case 'activity':
        return (
          <div className="accounts-panel">
            <ActivityPanel />
          </div>
        );
      case 'edit-project':
        return (
          <ProjectDetailsForm
            project={project}
            onClose={close}
            onSave={fields => {
              updateProject(p => ({ ...p, ...fields }));
              setNotice('Projet modifié');
            }}
          />
        );
      case 'edit-list': {
        const index = project.lists.findIndex(l => l.id === modal.listId);
        if (index < 0) return <p className="muted">Cette liste n’existe plus.</p>;
        return (
          <ListSettings
            key={modal.listId}
            list={project.lists[index]}
            index={index}
            count={project.lists.length}
            cardCount={project.cards.filter(c => c.listId === modal.listId).length}
            onSave={fields => {
              updateList(modal.listId, fields);
              setNotice('Liste modifiée');
            }}
            onMove={delta => moveList(modal.listId, delta)}
            onDelete={() => deleteList(modal.listId)}
            onClose={close}
          />
        );
      }
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
          unreadCount={notifications.unread}
          onOpenSidebar={() => setSidebar(true)}
          onOpenModal={setModal}
        />
        <div className="page-content">
          {!offlineMode && (
            <SyncAlerts
              syncError={workspace.syncError}
              saveStatus={saveStatus}
              saveError={workspace.saveError}
              saveNotice={workspace.saveNotice}
              onDismissNotice={workspace.dismissSaveNotice}
              onRefresh={workspace.refresh}
              onExport={() => exportWithAlert(projects)}
              onReload={() => setModal('reload')}
              onRetrySave={workspace.retrySave}
            />
          )}
          {project ? (
            <>
              <ProjectHeader
                project={project}
                offline={offlineMode}
                canDelete={role === 'manager'}
                readOnly={role === 'viewer'}
                onOpenSettings={() => setModal('project-settings')}
                onEdit={() => setModal('edit-project')}
                onDelete={() => setModal({ type: 'delete-project', projectId: project.id })}
              />
              <Board
                key={project.id}
                project={project}
                readOnly={role === 'viewer'}
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
                onEditList={listId => setModal({ type: 'edit-list', listId })}
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
          <ErrorBoundary resetKey={kind}>{renderDialog(kind)}</ErrorBoundary>
        </Dialog>
      )}
      {selected && (
        <ErrorBoundary
          resetKey={selected.id}
          fallback={() => (
            <Dialog title="Détail de la carte" onClose={() => setSelectedId(null)}>
              <DisplayError message="Le détail de cette carte n’a pas pu s’afficher.">
                <button className="secondary-button" onClick={() => setSelectedId(null)}>
                  Fermer
                </button>
              </DisplayError>
            </Dialog>
          )}
        >
          <CardDetail
            engine={projectAi.engine}
            role={role}
            attachmentBytes={attachmentSize(projects, selected.id)}
            onWorkflowRefresh={() => workspace.refresh({ whileEditing: true })}
            offline={offlineMode}
            projectId={project.id}
            user={workspace.user}
            saveStatus={saveStatus}
            card={selected}
            lists={project.lists}
            position={(() => {
              const siblings = project.cards.filter(c => c.listId === selected.listId);
              return { index: siblings.indexOf(selected), count: siblings.length };
            })()}
            onReorder={delta => reorderCard(selected.id, delta)}
            onClose={() => setSelectedId(null)}
            onUpdate={patch => updateCard(selected.id, patch)}
            onDelete={() => {
              updateProject(p => ({ ...p, cards: p.cards.filter(c => c.id !== selected.id) }));
              setSelectedId(null);
              setNotice('Carte supprimée');
            }}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary
    fallback={() => (
      <main className="display-error-page">
        <h1>PlaniFiKateur</h1>
        <DisplayError message="Le tableau n’a pas pu s’afficher." />
      </main>
    )}
  >
    <App />
  </ErrorBoundary>,
);
