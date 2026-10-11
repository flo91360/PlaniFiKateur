import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowRight, ArrowUp, Check, CheckCheck, ChevronRight, Circle, CircleHelp, Clock3, History, FolderKanban, Layers3, LayoutGrid, Lightbulb, ListFilter, Menu, MessageSquare, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/manrope/latin-800.css';
import './style.css';
import { createId as uid } from './lib/id.js';
import { useWorkspace, offlineMode, exportWorkspace } from './lib/use-workspace.js';
import { validateWorkspace } from './lib/workspace.js';
import Attachments from './components/Attachments.jsx';
import BackupsPanel from './components/BackupsPanel.jsx';
import ConnectionScreen from './components/AccountScreen.jsx';
import AccountsPanel from './components/AccountsPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import CardSubscription from './components/CardSubscription.jsx';
import ProjectAutomation from './components/ProjectAutomation.jsx';
import Avatar, { avatarLabel } from './components/Avatar.jsx';
import { workRequest } from './components/AgentSetup.jsx';

const statuses = { draft: { label: 'À explorer', icon: Circle }, ready: { label: 'Prête à démarrer', icon: ArrowRight }, progress: { label: 'En cours', icon: Clock3 }, clarify: { label: 'À préciser', icon: CircleHelp }, review: { label: 'À valider', icon: CheckCheck }, done: { label: 'Terminée', icon: Check } };
const priorities = { low: 'Basse', normal: 'Normale', high: 'Haute' };
const parseTags = text => [...new Set(text.split(',').map(tag => tag.trim()).filter(Boolean))];



function Status({ value }) {
  const status = statuses[value] || statuses.draft;
  const Icon = status.icon;
  return <span className={`status ${value}`}><Icon size={12} />{status.label}</span>;
}

function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    const focusables = () => [...el.querySelectorAll('button, input, textarea, select, [tabindex="0"]')].filter(e => !e.disabled);
    focusables()[0]?.focus();
    const handle = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const list = focusables();
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    el.addEventListener('keydown', handle);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { el.removeEventListener('keydown', handle); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${wide ? 'wide' : ''}`}><header className="dialog-header"><span>{title}</span><button className="icon-button" onClick={onClose} aria-label="Fermer"><X size={20} /></button></header>{children}</section></div>;
}

function App() {
  const [acceptingInvitation, setAcceptingInvitation] = useState(() => /^#invitation=[a-f0-9]{64}$/.test(location.hash));
  const [modal, setModal] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const workspace = useWorkspace({ pauseRefresh: !!modal || !!selectedId || !!dragging });
  const { projects, setProjects, ready, needsLogin, loadError, saveStatus, saveError } = workspace;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sidebar, setSidebar] = useState(false);
  const storageError = offlineMode && saveStatus === 'error';
  const [importError, setImportError] = useState('');
  const [dropList, setDropList] = useState(null);
  const [notice, setNotice] = useState('');
  const project = projects.find(p => p.id === projectId) || projects[0];
  const selected = project?.cards.find(c => c.id === selectedId);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const updateProject = transform => setProjects(ps => {
    let changed = false;
    const next = ps.map(p => {
      if (p.id !== project.id) return p;
      const updated = transform(p); changed ||= updated !== p; return updated;
    });
    return changed ? next : ps;
  });
  const updateCard = (id, patch) => updateProject(p => {
    const card = p.cards.find(c => c.id === id);
    if (!card || Object.entries(patch).every(([key, value]) => JSON.stringify(card[key]) === JSON.stringify(value))) return p;
    return { ...p, cards: p.cards.map(c => c.id === id ? { ...c, ...patch } : c) };
  });
  const chooseProject = id => { setProjectId(id); setQuery(''); setStatusFilter('all'); setSelectedId(null); setSidebar(false); };
  const matches = c => (statusFilter === 'all' || c.status === statusFilter) && `${c.title} ${c.description} ${c.tags.join(' ')}`.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr').trim());
  const done = (project?.cards || []).filter(c => c.status === 'done').length;
  const progress = (project?.cards || []).filter(c => c.status === 'progress').length;
  const clarify = (project?.cards || []).filter(c => c.status === 'clarify').length;
  const total = project?.cards.length || 0;
  const filteredCount = (project?.cards || []).filter(matches).length;

  if (!offlineMode && (!ready || acceptingInvitation)) return <ConnectionScreen needsLogin={needsLogin} needsSetup={workspace.needsSetup} error={loadError} onLogin={workspace.login} onSetup={workspace.setup} onAccept={async data => { await workspace.accept(data); setAcceptingInvitation(false); }} onRetry={workspace.reload} />;
  return <div className="app-shell">
    {sidebar && <div className="sidebar-backdrop" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); chooseProject(projects[0]?.id ?? null); }}><span className="brand-icon"><Layers3 size={23} /></span>PlaniFiKateur<span className="brand-dot">.</span></a>
      <div className="workspace-label">VOTRE ESPACE DE TRAVAIL</div>
      <button className="workspace-button" onClick={() => setModal('overview')}><span className="workspace-avatar">P</span><span>Espace personnel<small>Un peu d’ordre, plein d’idées</small></span><ChevronRight size={15} /></button>
      <div className="sidebar-section-title"><span>MES PROJETS</span><button aria-label="Créer un projet" onClick={() => setModal('project')}><Plus size={17} /></button></div>
      <nav aria-label="Projets">{projects.map(p => <button key={p.id} className={`project-link ${project?.id === p.id ? 'active' : ''}`} onClick={() => chooseProject(p.id)}><span className="project-symbol" style={{ color: p.color }}>{p.emoji}</span><span>{p.name}</span><span className="project-count">{p.cards.length}</span></button>)}</nav>
      <button className="new-project" onClick={() => setModal('project')}><Plus size={16} />Nouveau projet</button>
      <div className="sidebar-tip"><span className="tip-icon"><Sparkles size={19} /></span><h3>Les idées d’abord.<br />Les agents, bientôt.</h3><p>Préparez vos demandes aujourd’hui. Vos agents pourront prendre le relais demain.</p><span className="coming-soon">EN PRÉPARATION</span></div>
      <div className="sidebar-footer"><Avatar name={workspace.user?.name} /><div>{workspace.user?.name || 'Votre espace'}<small>v0.1.7 · {offlineMode ? 'données locales' : 'connecté au serveur'}</small></div><span className="online-dot" /></div>
    </aside>
    <main>
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Ouvrir les projets" onClick={() => setSidebar(true)}><Menu size={20} /></button><FolderKanban size={17} /><span>Mes projets</span><ChevronRight size={14} /><strong>{project?.name || 'Votre espace'}</strong></div><div className="topbar-right"><span className="save-indicator"><span className={saveStatus === 'error' || saveStatus === 'conflict' ? 'error-dot' : 'online-dot'} />{saveStatus === 'saving' ? 'Enregistrement…' : saveStatus !== 'saved' ? 'Sauvegarde indisponible' : offlineMode ? 'Sauvegardé sur cet appareil' : 'Sauvegardé sur le serveur'}</span><button className="icon-button" aria-label="Informations sur le prototype" onClick={() => setModal('info')}><CircleHelp size={19} /></button>{!offlineMode && <button className="icon-button" aria-label="Historique des projets" onClick={() => setModal('activity')}><History size={19} /></button>}<button className="header-avatar" aria-label="Mon compte" onClick={() => setModal(offlineMode ? 'info' : 'account')}>{avatarLabel(workspace.user?.name)}</button></div></header>
      <div className="page-content">
        {!offlineMode && workspace.syncError && <div className="sync-warning" role="status"><p>{workspace.syncError}</p><button className="secondary-button" onClick={workspace.refresh}>Réessayer l’actualisation</button></div>}
        {!offlineMode && saveStatus !== 'saved' && saveStatus !== 'saving' && <div className="sync-warning" role="alert"><p>{saveError} Vos modifications restent dans cette page.</p><button className="secondary-button" onClick={() => exportWorkspace(projects)}>Exporter mes modifications</button>{saveStatus === 'conflict' ? <button className="secondary-button" onClick={() => setModal('reload')}>Recharger le tableau</button> : <button className="secondary-button" onClick={workspace.retrySave}>Réessayer la sauvegarde</button>}</div>}
        {project ? <><div className="project-heading"><div className="project-title"><span className="large-symbol" style={{ background: project.color }}>{project.emoji}</span><div><div className="eyebrow">DE L’IDÉE À LA RÉALISATION</div><h1>{project.name}</h1><p>{project.description}</p></div></div><div className="project-actions">{!offlineMode && <><button className="secondary-button" onClick={() => setModal('project-settings')}>Paramètres du projet</button></>}<button className="delete-button project-delete" onClick={() => setModal({ type: 'delete-project', projectId: project.id })}><Trash2 size={16} />Supprimer le projet</button></div></div>
        <div className="stats"><div className="stat"><span className="stat-icon neutral"><Lightbulb size={18} /></span><div><strong>{total}<small>idées au total</small></strong><span>Toutes vos pistes, au même endroit</span></div></div><div className="stat"><span className="stat-icon blue"><Clock3 size={18} /></span><div><strong>{progress}<small>en cours</small></strong><span>Des idées qui prennent forme</span></div></div><div className="stat"><span className="stat-icon amber"><CircleHelp size={18} /></span><div><strong>{clarify}<small>à préciser</small></strong><span>Un peu de contexte pour avancer</span></div></div><div className="stat"><span className="stat-icon green"><CheckCheck size={18} /></span><div><strong>{done}<small>terminées</small></strong><span>{total ? Math.round(done / total * 100) : 0} % des idées concrétisées</span></div></div></div>
        <div className="board-toolbar"><div className="board-tab"><LayoutGrid size={16} />Tableau<span>{project.lists.length} listes</span></div><div className="board-controls"><label className="search-field"><Search size={16} /><input aria-label="Rechercher une carte" placeholder="Rechercher une idée…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Effacer la recherche" onClick={() => setQuery('')}><X size={14} /></button>}</label><label className="filter-field"><ListFilter size={16} /><select aria-label="Filtrer par statut" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">Tous les statuts</option>{Object.entries(statuses).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></label></div></div>
        <div className="board-caption"><span>Un projet, plusieurs pistes. À vous de les faire avancer.</span><span><span className="tiny-dot" />{query || statusFilter !== 'all' ? `${filteredCount} carte${filteredCount > 1 ? 's' : ''} trouvée${filteredCount > 1 ? 's' : ''}` : 'Glissez les cartes pour les organiser'}</span></div>
        <div className="board" aria-label="Tableau du projet">{project.lists.map(list => <section key={list.id} className={`list-column ${dropList === list.id ? 'drag-over' : ''}`} onDragOver={e => { if (dragging) { e.preventDefault(); setDropList(list.id); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropList(null); }} onDrop={e => { e.preventDefault(); if (dragging) { updateCard(dragging, { listId: list.id }); setNotice('Carte déplacée'); } setDragging(null); setDropList(null); }}><header className="list-header"><div><span className={`list-dot ${list.color}`} /><h2>{list.name}</h2><span className="list-count">{(project?.cards || []).filter(c => c.listId === list.id && matches(c)).length}</span></div><button className="icon-button" aria-label={`Ajouter une carte dans ${list.name}`} onClick={() => setModal({ type: 'card', listId: list.id })}><Plus size={17} /></button></header><div className="cards">{(project?.cards || []).filter(c => c.listId === list.id && matches(c)).map(card => <button key={card.id} draggable onDragStart={e => { setDragging(card.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); }} onDragEnd={() => { setDragging(null); setDropList(null); }} onClick={() => setSelectedId(card.id)} className={`card ${dragging === card.id ? 'dragging' : ''}`}><div className="card-tags">{card.tags.map((tag, i) => <span key={i} className={`tag ${list.color}`}>{tag}</span>)}{!card.tags.length && <span className="untagged">Nouvelle idée</span>}</div><h3>{card.title}</h3><p>{card.description || 'Ajoutez un peu de contexte à cette idée…'}</p><Status value={card.status} /><footer><span className={`priority ${card.priority}`}>{card.priority === 'high' ? <ArrowUp size={12} /> : card.priority === 'low' ? <ArrowDown size={12} /> : <span className="priority-lines">=</span>}{priorities[card.priority]}</span><div className="card-meta">{card.comments.length > 0 && <span><MessageSquare size={13} />{card.comments.length}</span>}<Avatar className="card-avatar" name={card.createdBy?.name} /></div></footer></button>)}{!project.cards.some(c => c.listId === list.id && matches(c)) && <div className="empty-list"><Lightbulb size={22} /><p>{query || statusFilter !== 'all' ? 'Aucune carte ne correspond' : 'Une nouvelle piste commence ici'}</p></div>}</div><button className="add-card" onClick={() => setModal({ type: 'card', listId: list.id })}><Plus size={16} />Ajouter une carte</button></section>)}<button className="add-list" onClick={() => setModal('list')}><Plus size={17} />Ajouter une liste</button></div>
        <footer className="board-footer"><span><Layers3 size={14} />Un esprit libre. Des idées bien rangées.</span><span>PlaniFiKateur · Première version</span></footer></> : <div className="empty-workspace"><FolderKanban size={36} /><h1>Aucun projet pour le moment</h1><p>Créez un projet pour organiser vos idées.</p><button className="primary-button" onClick={() => setModal('project')}><Plus size={16} />Créer un projet</button></div>}
      </div>
    </main>
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    {storageError && <div className="storage-warning" role="alert">Les modifications restent en mémoire, mais ne pourront pas être conservées après fermeture. Vérifiez les autorisations de stockage de votre navigateur.</div>}
    {modal && <Dialog wide={modal.type === 'card'} title={modal === 'project-settings' ? 'Paramètres du projet' : modal === 'project' ? 'Un nouveau projet' : modal === 'list' ? 'Une nouvelle liste' : modal.type === 'delete-project' ? 'Supprimer le projet' : modal === 'account' ? 'Mon compte' : modal === 'activity' ? 'Activité des projets' : modal === 'reload' ? 'Recharger le tableau' : modal.type === 'card' ? 'Une nouvelle idée' : modal === 'overview' ? 'Votre espace personnel' : 'À propos de cette première version'} onClose={() => setModal(null)}>
      {modal === 'project-settings' ? <ProjectAutomation key={project.id} project={project} user={workspace.user} /> : (modal === 'project' || modal === 'list' || modal.type === 'card') ? <CreationForm type={modal === 'project' ? 'project' : modal === 'list' ? 'list' : 'card'} attachmentBytes={projects.flatMap(p => p.cards).flatMap(c => c.attachments || []).reduce((sum, a) => sum + a.size, 0)} lists={project?.lists || []} listId={modal.listId} onCancel={() => setModal(null)} onSubmit={values => {
        if (modal === 'project') { const id = uid(); const newProject = { id, name: values.title, description: values.description || 'Votre prochaine grande idée commence ici.', emoji: '◈', color: '#e1e7cd', lists: [{ id: uid(), name: 'Améliorations', color: 'green' }, { id: uid(), name: 'Nouvelles idées', color: 'purple' }, { id: uid(), name: 'Bugs', color: 'orange' }], cards: [] }; setProjects(ps => [...ps, newProject]); chooseProject(id); setNotice('Projet créé'); }
        else if (modal === 'list') { const newList = { id: uid(), name: values.title, color: ['green', 'purple', 'orange'][project.lists.length % 3] }; updateProject(p => ({ ...p, lists: [...p.lists, newList] })); setNotice('Liste créée'); }
        else { const newCard = { id: uid(), listId: values.listId, title: values.title, description: values.description, status: values.status, priority: values.priority, tags: values.tags, comments: values.comment ? [{ id: uid(), author: 'Vous', text: values.comment, date: new Date().toISOString() }] : [], checklist: values.checklist, attachments: values.attachments }; updateProject(p => ({ ...p, cards: [...p.cards, newCard] })); setQuery(''); setStatusFilter('all'); setNotice('Carte créée'); }
        setModal(null);
      }} /> : modal === 'account' ? <AccountsPanel user={workspace.user} onLogout={async () => { await workspace.logout(); setModal(null); setSelectedId(null); }} /> : modal === 'activity' ? <div className="accounts-panel"><ActivityPanel /></div> : modal.type === 'delete-project' ? <div className="project-delete-confirm"><p>Supprimer définitivement le projet <strong>{projects.find(p => p.id === modal.projectId)?.name}</strong> ?</p><p>Ses listes, cartes et commentaires seront également supprimés. Cette action est irréversible.</p><div className="transfer-actions"><button className="secondary-button" onClick={() => setModal(null)}>Annuler</button><button className="danger-button" onClick={() => {
        const remaining = projects.filter(p => p.id !== modal.projectId);
        setProjects(remaining); chooseProject(remaining[0]?.id ?? null); setDragging(null); setDropList(null); setModal(null); setNotice('Projet supprimé');
      }}>Confirmer la suppression</button></div></div> : <div className="info-content">{modal === 'reload' ? <><h2>Reprendre les données du serveur ?</h2><p>Les modifications non sauvegardées de cette page seront abandonnées. Exportez-les avant de continuer si vous souhaitez les conserver.</p><button className="secondary-button" onClick={() => exportWorkspace(projects)}>Exporter mes modifications</button><button className="primary-button" onClick={() => { setModal(null); void workspace.reload(); }}>Recharger depuis le serveur</button></> : modal === 'overview' ? <><span className="info-illustration"><FolderKanban size={30} /></span><h2>Toutes vos idées ont leur place.</h2><p>Votre espace rassemble {projects.length} projets et {projects.reduce((sum, p) => sum + p.cards.length, 0)} cartes. Sélectionnez un projet dans le menu pour retrouver son tableau.</p></> : <><span className="info-illustration"><Sparkles size={30} /></span><h2>Les fondations de vos futurs projets.</h2><p>Créez des projets, organisez vos cartes et suivez leur avancement. Les exemples présents au départ sont des données de démonstration.</p><div className="info-note"><strong>{offlineMode ? 'Sauvegarde locale' : 'Sauvegarde serveur'}</strong><p>{offlineMode ? 'Cette copie HTML conserve vos données dans ce navigateur. Exportez vos projets pour les importer dans la version connectée au serveur.' : 'Les cartes enregistrées sont consultables par l’API. Si le serveur refuse une modification, elle reste dans cette page et un message vous permet de la conserver.'}</p></div><div className="info-note"><strong>Les agents IA arrivent ensuite</strong><p>Les statuts sont modifiables manuellement. Aucun agent n’est connecté et aucune tâche n’est déléguée automatiquement.</p></div></>}{!offlineMode && workspace.user?.role === 'admin' && modal !== 'reload' && <BackupsPanel />}<div className="transfer-actions"><button className="secondary-button" onClick={() => exportWorkspace(projects)}>Exporter les projets (JSON)</button><label className="secondary-button import-button">Importer des projets<input type="file" accept=".json,application/json" aria-label="Importer des projets JSON" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        try {
          if (file.size > 4 * 1024 * 1024) throw new Error('Le fichier dépasse 4 Mo.');
          const json = JSON.parse(await file.text());
          const imported = validateWorkspace(Array.isArray(json) ? json : json.projects).map(p => {
            const listIds = new Map(p.lists.map(l => [l.id, uid()]));
            return { ...p, id: uid(), lists: p.lists.map(l => ({ ...l, id: listIds.get(l.id) })), cards: p.cards.map(c => ({ ...c, id: uid(), listId: listIds.get(c.listId), comments: c.comments.map(m => ({ ...m, id: uid() })), attachments: (c.attachments || []).map(a => ({ ...a, id: uid() })), checklist: c.checklist.map(t => ({ ...t, id: uid() })) })) };
          });
          validateWorkspace([...projects, ...imported]);
          setProjects(ps => [...ps, ...imported]); setImportError(''); setNotice('Projets importés, sans remplacer les projets existants');
        } catch (error) { setImportError(error.message); }
      }} /></label></div>{importError && <p className="form-error" role="alert">{importError}</p>}<button className="primary-button" onClick={() => setModal(null)}>C’est compris<ArrowRight size={16} /></button></div>}
    </Dialog>}
    {selected && <CardDetail attachmentBytes={projects.flatMap(p => p.cards).filter(c => c.id !== selected.id).flatMap(c => c.attachments || []).reduce((sum, a) => sum + a.size, 0)} onWorkflowRefresh={() => workspace.refresh({ whileEditing: true })} offline={offlineMode} projectId={project.id} user={workspace.user} saveStatus={saveStatus} card={selected} lists={project.lists} onClose={() => setSelectedId(null)} onUpdate={patch => updateCard(selected.id, patch)} onDelete={() => { updateProject(p => ({ ...p, cards: p.cards.filter(c => c.id !== selected.id) })); setSelectedId(null); setNotice('Carte supprimée'); }} />}
  </div>;
}

// These actions update local state; they never submit or navigate a document.
// Embedded HTML previews may allow scripts while prohibiting native forms.
function LocalForm({ onConfirm, formRef, children, ...props }) {
  return <form {...props} ref={formRef} onSubmit={e => { e.preventDefault(); onConfirm(); }} onKeyDown={e => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const inputEnter = e.target.tagName === 'INPUT' && e.target.type !== 'checkbox';
    const commentShortcut = e.target.tagName === 'TEXTAREA' && (e.ctrlKey || e.metaKey);
    if (inputEnter || commentShortcut) { e.preventDefault(); onConfirm(); }
  }}>{children}</form>;
}

function CreationForm({ attachmentBytes = 0, type, lists, listId, onCancel, onSubmit }) {
  const formRef = useRef(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState(listId || lists[0]?.id || '');
  const [priority, setPriority] = useState('normal');
  const [status, setStatus] = useState('draft');
  const [tags, setTags] = useState('');
  const [comment, setComment] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const isCard = type === 'card';
  const submit = () => {
    if (uploading || !formRef.current.reportValidity()) return;
    const data = new FormData(formRef.current);
    const submittedTitle = String(data.get('title') || '').trim();
    if (!submittedTitle) { setError('Donnez un nom à votre projet, liste ou carte pour continuer.'); return; }
    try {
      onSubmit({ title: submittedTitle, description: String(data.get('description') || '').trim(), listId: target, priority, status, tags: parseTags(String(data.get('tags') || '')), checklist: [], attachments, comment: String(data.get('comment') || '').trim() });
    } catch {
      setError('La création a échoué. Vos informations sont conservées : vous pouvez réessayer.');
    }
  };
  return <LocalForm className={`creation-form ${isCard ? 'card-creation' : ''}`} formRef={formRef} onConfirm={submit}>
    <p>{type === 'project' ? 'Un espace dédié, pour rassembler les idées qui vont ensemble.' : type === 'list' ? 'Organisez votre tableau avec une catégorie qui vous ressemble.' : 'Décrivez la demande et le résultat attendu dès la création de votre carte.'}</p>
    <div className={isCard ? 'creation-layout' : ''}>
      <div className="creation-main">
        <label>{type === 'project' ? 'Nom du projet' : type === 'list' ? 'Nom de la liste' : 'Titre de la carte'}<input name="title" autoFocus required maxLength={140} value={title} onChange={e => setTitle(e.target.value)} placeholder={type === 'project' ? 'Ex. Mon application' : type === 'list' ? 'Ex. À explorer' : 'Qu’aimeriez-vous faire évoluer ?'} /></label>
        {type !== 'list' && <label>{type === 'project' ? 'Présentation' : 'Description'}<textarea name="description" aria-label={type === 'project' ? 'Présentation' : 'Description'} rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Quelques mots pour donner du contexte…" /></label>}
        {isCard && <>
          <p className="muted">La description sera la demande transmise à l’agent.</p><label>Étiquettes<input name="tags" value={tags} onChange={e => setTags(e.target.value)} placeholder="Interface, Recherche… (séparées par une virgule)" /></label>
          <Attachments otherBytes={attachmentBytes} attachments={attachments} onChange={setAttachments} onBusy={setUploading} /><label className="initial-comment">Premier commentaire <span className="optional-label">Facultatif</span><textarea name="comment" aria-label="Votre commentaire" rows={2} value={comment} onChange={e => setComment(e.target.value)} placeholder="Une précision pour commencer la discussion…" /></label>
        </>}
      </div>
      {isCard && <aside className="creation-side">
        <label>Liste<select aria-label="Liste" value={target} onChange={e => setTarget(e.target.value)}>{lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Statut<select aria-label="Statut" value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(statuses).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></label>
        <label>Priorité<select aria-label="Priorité" value={priority} onChange={e => setPriority(e.target.value)}>{Object.entries(priorities).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </aside>}
    </div>
    <div className="form-actions">
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="button" className="secondary-button" onClick={onCancel}>Annuler</button>
      <button type="button" onClick={submit} className="primary-button" disabled={uploading || !title.trim() || (isCard && !target)}><Plus size={16} />{type === 'project' ? 'Créer le projet' : type === 'list' ? 'Créer la liste' : 'Créer la carte'}</button>
    </div>
  </LocalForm>;
}

function CommentText({ text }) {
  return <p>{text.split(/(https?:\/\/[^\s]+)/g).map((part, index) => /^https?:\/\//.test(part) ? <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a> : part)}</p>;
}

function CardDetail({ attachmentBytes = 0, onWorkflowRefresh, offline, projectId, user, saveStatus, card, lists, onClose, onUpdate, onDelete }) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [comment, setComment] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [tags, setTags] = useState(card.tags.join(', '));
  const [workflowManaged, setWorkflowManaged] = useState(!offline);
  const previousFields = useRef({ title: card.title, description: card.description, tags: card.tags.join(', ') });
  useEffect(() => {
    const before = previousFields.current;
    setTitle(value => value === before.title ? card.title : value);
    setDescription(value => value === before.description ? card.description : value);
    setTags(value => value === before.tags ? card.tags.join(', ') : value);
    previousFields.current = { title: card.title, description: card.description, tags: card.tags.join(', ') };
  }, [card.title, card.description, JSON.stringify(card.tags)]);
  const fieldsSaved = title === card.title && description === card.description && JSON.stringify(parseTags(tags)) === JSON.stringify(card.tags);

  const workflowRefresh = useRef(null);
  workflowRefresh.current = async () => { if (fieldsSaved) await onWorkflowRefresh(); };
  useEffect(() => {
    if (offline) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const runs = await workRequest(`projects/${projectId}/cards/${card.id}/work`, 'GET', null, controller.signal);
        if (!controller.signal.aborted) { setWorkflowManaged(runs.some(run => !['ready', 'done', 'cancelled'].includes(run.state))); await workflowRefresh.current(); }
      } catch { /* The workspace reports connectivity errors; keep the last known lock. */ }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [offline, projectId, card.id]);

  const saveFields = () => { onUpdate({ title: title.trim() || card.title, description: description.trim(), tags: parseTags(tags) }); if (!title.trim()) setTitle(card.title); };
  const close = () => { saveFields(); onClose(); };
  const publishComment = () => {
    if (!comment.trim()) return;
    onUpdate({ comments: [...card.comments, { id: uid(), author: user?.name || 'Vous', text: comment.trim(), date: new Date().toISOString() }] });
    setComment('');
  };
  return <Dialog title="Détail de la carte" wide onClose={close}><div className="detail-body"><div className="detail-main"><label className="detail-title-label">Titre<input aria-label="Titre de la carte" className="detail-title" value={title} maxLength={140} onChange={e => setTitle(e.target.value)} onBlur={saveFields} /></label><p className="card-authorship">Créée par {card.createdBy?.name || 'Auteur inconnu'}{card.createdAt && <> · {new Date(card.createdAt).toLocaleString('fr-FR')}</>}{card.updatedBy && <><br />Dernière modification par {card.updatedBy.name}</>}</p><div className="detail-status"><Status value={card.status} /><span>dans {lists.find(l => l.id === card.listId)?.name}</span></div><label className="detail-label">Description<textarea aria-label="Description" rows={4} value={description} onChange={e => setDescription(e.target.value)} onBlur={saveFields} placeholder="Décrivez la demande pour l’agent, le résultat attendu et les contraintes utiles…" /></label><p className="muted">Cette description est l’objectif transmis à l’agent.</p><label className="detail-label">Étiquettes<input value={tags} onChange={e => setTags(e.target.value)} onBlur={saveFields} placeholder="Interface, Recherche… (séparées par une virgule)" /></label><Attachments otherBytes={attachmentBytes} attachments={card.attachments || []} onChange={attachments => onUpdate({ attachments })} /><div className="comments-section"><h3><MessageSquare size={17} />Discussion<span>{card.comments.length}</span></h3>{card.status === 'clarify' && <p role="status">L’agent attend votre réponse. Publiez un commentaire pour reprendre la tâche.</p>}{card.comments.map(c => <div className="comment" key={c.id}><Avatar name={c.author} kind={c.authorKind} /><div><strong>{c.author}<time dateTime={c.date}>{new Date(c.date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></strong><CommentText text={c.text} /></div></div>)}{!card.comments.length && <p className="muted">Une question, une précision ? La discussion commence ici.</p>}<LocalForm onConfirm={publishComment}><textarea aria-label="Votre commentaire" rows={2} value={comment} onChange={e => setComment(e.target.value)} placeholder="Ajouter un commentaire…" /><button type="button" onClick={publishComment} className="secondary-button" disabled={!comment.trim()}>Publier<ArrowRight size={14} /></button></LocalForm></div>{!offline && <><ActivityPanel projectId={projectId} cardId={card.id} /></>}</div><aside className="detail-side">{!offline && <CardSubscription projectId={projectId} cardId={card.id} saveStatus={saveStatus} />}<label>Statut<select aria-label="Statut" disabled={workflowManaged} value={card.status} onChange={e => onUpdate({ status: e.target.value })}>{Object.entries(statuses).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select></label><label>Priorité<select aria-label="Priorité" value={card.priority} onChange={e => onUpdate({ priority: e.target.value })}>{Object.entries(priorities).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>Déplacer vers<select aria-label="Déplacer vers" value={card.listId} onChange={e => onUpdate({ listId: e.target.value })}>{lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{deleting ? <div className="delete-confirm"><p>Supprimer définitivement cette carte ?</p><button className="danger-button" onClick={onDelete}>Oui, supprimer</button><button className="secondary-button" onClick={() => setDeleting(false)}>Annuler</button></div> : <button className="delete-button" onClick={() => setDeleting(true)}><Trash2 size={14} />Supprimer la carte</button>}</aside></div><div className="detail-footer"><span><Check size={14} />{saveStatus === 'saved' ? 'Modifications enregistrées' : saveStatus === 'saving' ? 'Enregistrement en cours…' : 'Modifications non sauvegardées'}</span><button className="primary-button" onClick={close}>Terminé<Check size={16} /></button></div></Dialog>;
}

createRoot(document.getElementById('root')).render(<App />);
