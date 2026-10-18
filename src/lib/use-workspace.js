import { useCallback, useEffect, useRef, useState } from 'react';
import { withInfos } from './infos.js';
import { withProjectLists } from './discussion-list.js';
import { seed } from '../data/demo.js';
import { validateWorkspace } from './workspace.js';
import { apiData, apiFetch } from './api-client.js';
import { DEFAULT_ACCENT } from './accents.js';
import { applyChanges, diffWorkspace } from './workspace-changes.js';
import { useServerConnected, useServerEvent } from './use-server-events.js';

const STORAGE = 'planifikateur.workspace.v1';
// Le serveur envoie les pièces jointes sans leur contenu, téléchargé à la demande.
export const SERVER_FORM = { attachmentData: false };
export const offlineMode = globalThis.__PLANIFIKATEUR_OFFLINE__ === true || globalThis.location?.protocol === 'file:';
function readLocal() {
  try {
    return validateWorkspace(JSON.parse(localStorage.getItem(STORAGE))).map(project =>
      withProjectLists(withInfos(project)),
    );
  } catch {
    return seed;
  }
}
// Session et workspace répondent sans enveloppe data ; 304 renvoie null.
const request = (path, options) => apiFetch(path, { fallback: 'Le serveur ne répond pas.', ...options });

export function useWorkspace({ pauseRefresh = false } = {}) {
  // Connecté, rien n’est affiché avant la lecture du serveur : jamais de projets de démonstration.
  const [projects, setState] = useState(() => (offlineMode ? readLocal() : []));
  const [ready, setReady] = useState(offlineMode);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false),
    [user, setUser] = useState(null);
  // Couleur dominante choisie par le compte connecté (couleur du site hors connexion).
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveError, setSaveError] = useState('');
  const [syncError, setSyncError] = useState('');
  // Modifications refusées ou ignorées par le serveur lors du dernier enregistrement : le reste est
  // enregistré et la page continue de s’actualiser ; ce message explique ce qui n’a pas été gardé.
  const [saveNotice, setSaveNotice] = useState('');
  // Rôle du compte sur chaque projet visible (viewer, editor, manager) ; null hors connexion.
  const [access, setAccess] = useState(null);
  const paused = useRef(pauseRefresh),
    refreshing = useRef(false),
    // Une actualisation demandée pendant un enregistrement ou une autre lecture est faite ensuite.
    pending = useRef(false);
  paused.current = pauseRefresh;
  const current = useRef(projects),
    saved = useRef(projects),
    revision = useRef(0),
    saving = useRef(false),
    initialized = useRef(offlineMode);
  const load = useCallback(async () => {
    setLoadError('');
    setReady(false);
    try {
      const session = await request('session');
      setUser(session.user || null);
      setAccent(session.preferences?.accent || DEFAULT_ACCENT);
      setNeedsSetup(session.needsSetup);
      if (!session.authenticated) {
        setNeedsLogin(true);
        return;
      }
      const workspace = await request('workspace');
      const clean = validateWorkspace(workspace.projects, SERVER_FORM);
      setAccess(workspace.access || {});
      current.current = clean;
      saved.current = clean;
      revision.current = workspace.revision;
      initialized.current = true;
      setState(clean);
      setNeedsLogin(false);
      setSaveError('');
      setSyncError('');
      setSaveStatus('saved');
      setReady(true);
    } catch (error) {
      setLoadError(error.message);
    }
  }, []);
  // `only` : relecture des seuls projets annoncés par le flux ({ projectIds, revision } attendue) ;
  // à défaut, ou si le serveur a avancé entre-temps, tout le tableau est relu.
  const refresh = useCallback(async ({ whileEditing = false, only = null } = {}) => {
    if (
      offlineMode ||
      !initialized.current ||
      (!whileEditing && paused.current) ||
      document.visibilityState === 'hidden'
    )
      return;
    if (saving.current || refreshing.current || current.current !== saved.current) {
      pending.current = true;
      return;
    }
    pending.current = false;
    const baseRevision = revision.current;
    refreshing.current = true;
    try {
      const remote = await request(
        only ? `workspace?projects=${only.projectIds.map(encodeURIComponent).join(',')}` : 'workspace',
        { headers: { 'If-None-Match': `"${baseRevision}"` }, signal: AbortSignal.timeout(10000) },
      );
      // A read may complete after the user begins editing or after a newer save.
      if (
        (!whileEditing && paused.current) ||
        saving.current ||
        current.current !== saved.current ||
        revision.current !== baseRevision
      )
        return;
      if (remote && only) {
        const merged =
          remote.revision === only.revision &&
          mergeProjects(saved.current, validateWorkspace(remote.projects, SERVER_FORM), only.projectIds);
        if (!merged) pending.current = true;
        else {
          current.current = merged;
          saved.current = merged;
          revision.current = remote.revision;
          setState(merged);
          setAccess(remote.access || {});
        }
      } else if (remote && remote.revision > baseRevision) {
        const clean = validateWorkspace(remote.projects, SERVER_FORM);
        current.current = clean;
        saved.current = clean;
        revision.current = remote.revision;
        setState(clean);
        setAccess(remote.access || {});
      }
      setSyncError('');
    } catch (error) {
      setSyncError(
        error.status === 401
          ? 'Votre session a expiré. Rechargez la page pour vous reconnecter.'
          : 'Actualisation indisponible. Une nouvelle tentative sera faite automatiquement.',
      );
    } finally {
      refreshing.current = false;
      if (pending.current) setTimeout(() => void refreshRef.current?.(), 0);
    }
  }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!offlineMode) void load();
  }, [load]);
  // Le flux d’événements annonce chaque nouvelle révision ; la lecture périodique ne sert plus
  // que de filet de sécurité, sauf si le flux est coupé ou si la dernière lecture a échoué.
  const live = useServerConnected();
  useServerEvent((type, data) => {
    if (type === 'ready') void refresh();
    else if (type === 'workspace' && data.revision > revision.current)
      // Changement limité à quelques projets, juste après notre révision : eux seuls sont relus.
      void refresh(
        data.projectIds && data.fromRevision === revision.current
          ? { only: { projectIds: data.projectIds, revision: data.revision } }
          : {},
      );
  });
  useEffect(() => {
    if (offlineMode || !ready || pauseRefresh) return;
    const update = () => void refresh();
    update();
    const timer = setInterval(update, live && !syncError ? 60000 : 5000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [ready, pauseRefresh, refresh, live, syncError]);
  const setProjects = useCallback(update => {
    const next = typeof update === 'function' ? update(current.current) : update;
    if (next === current.current) return;
    current.current = next;
    setState(next);
    if (!offlineMode) setSaveStatus('saving');
  }, []);
  // Envoie seulement les modifications locales : le serveur les applique sur son état courant,
  // y compris quand une autre session a modifié d’autres éléments entre-temps.
  const flush = useCallback(async () => {
    if (offlineMode || !initialized.current || saving.current || current.current === saved.current) return;
    saving.current = true;
    setSaveStatus('saving');
    setSaveError('');
    try {
      while (current.current !== saved.current) {
        const snapshot = current.current;
        const changes = diffWorkspace(saved.current, snapshot);
        if (!changes.length) {
          // Modifications annulées avant l’envoi : l’état local redevient celui du serveur.
          current.current = saved.current;
          setState(saved.current);
          continue;
        }
        const sentFrom = revision.current;
        const data = await apiData('workspace', {
          method: 'PATCH',
          data: { changes, partial: true, scope: 'changed' },
          fallback: 'Le serveur ne répond pas.',
        });
        setSaveNotice(describeRefusals(data));
        // Le serveur ne renvoie que les projets visés par le lot (`projectIds`) : ils remplacent
        // ceux de l’état enregistré. Si d’autres sessions ont écrit depuis la dernière lecture
        // (`fromRevision` différente), la révision reste en arrière et tout le tableau sera relu.
        const returned = validateWorkspace(data.projects, SERVER_FORM);
        const canonical = data.projectIds ? mergeProjects(saved.current, returned, data.projectIds) : returned;
        if (!canonical) throw new Error('Réponse du serveur incohérente. Rechargez la page.');
        if (data.projectIds && data.fromRevision !== sentFrom) pending.current = true;
        else revision.current = data.revision;
        saved.current = canonical;
        setAccess(data.access || {});
        // Les modifications faites pendant l’envoi sont rejouées sur l’état renvoyé par le serveur.
        current.current =
          current.current === snapshot
            ? canonical
            : applyChanges(canonical, diffWorkspace(snapshot, current.current)).projects;
        setState(current.current);
      }
      setSaveStatus('saved');
    } catch (error) {
      setSaveStatus(error.status === 409 ? 'conflict' : 'error');
      setSaveError(error.message);
    } finally {
      saving.current = false;
      if (pending.current && current.current === saved.current) void refreshRef.current();
    }
  }, []);
  useEffect(() => {
    if (offlineMode) {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(projects));
        setSaveStatus('saved');
      } catch {
        setSaveStatus('error');
        setSaveError('Le navigateur ne permet pas de conserver ces modifications après fermeture.');
      }
      return;
    }
    const timer = setTimeout(() => void flush(), 250);
    return () => clearTimeout(timer);
  }, [projects, flush]);
  useEffect(() => {
    if (offlineMode) return;
    const warn = e => {
      if (current.current !== saved.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const authenticate = async (path, data) => {
    await request(path, { method: 'POST', data });
    await load();
  };
  const login = data => authenticate('session', data);
  const setup = data => authenticate('accounts/setup', data);
  const accept = data => authenticate('accounts/accept', data);
  const logout = async () => {
    if (current.current !== saved.current)
      throw new Error('Sauvegardez ou exportez vos modifications avant de vous déconnecter.');
    await request('session', { method: 'DELETE' });
    initialized.current = false;
    setUser(null);
    setAccent(DEFAULT_ACCENT);
    setNeedsLogin(true);
    setReady(false);
  };
  return {
    projects,
    access,
    setProjects,
    ready,
    needsLogin,
    needsSetup,
    user,
    accent,
    setAccent,
    loadError,
    saveStatus,
    saveError,
    syncError,
    saveNotice,
    dismissSaveNotice: () => setSaveNotice(''),
    refresh,
    retrySave: flush,
    reload: load,
    login,
    setup,
    accept,
    logout,
  };
}

// Remplace dans `base` les projets `ids` par ceux de `projects` (absents : retirés, car supprimés ou
// devenus invisibles). Renvoie null si un projet inconnu de `base` apparaît : il faut tout relire.
export function mergeProjects(base, projects, ids) {
  const fresh = new Map(projects.map(project => [project.id, project]));
  if (projects.some(project => !base.some(item => item.id === project.id))) return null;
  const wanted = new Set(ids);
  return base.flatMap(project =>
    wanted.has(project.id) ? (fresh.has(project.id) ? [fresh.get(project.id)] : []) : [project],
  );
}

// Message pour les modifications refusées (droits, contenu) ou ignorées (élément supprimé ailleurs).
export function describeRefusals({ rejected = [], skipped = [] } = {}) {
  const parts = [];
  if (rejected.length) {
    const reasons = [...new Set(rejected.map(item => item.message).filter(Boolean))].slice(0, 3);
    parts.push(
      `${rejected.length === 1 ? 'Une modification a été refusée' : `${rejected.length} modifications ont été refusées`} et retirée${rejected.length === 1 ? '' : 's'} de la page${reasons.length ? ` : ${reasons.join(' ')}` : '.'}`,
    );
  }
  const missing = skipped.filter(item => item.reason === 'missing').length;
  if (missing)
    parts.push(
      `${missing === 1 ? 'Une modification visait' : `${missing} modifications visaient`} un élément supprimé entre-temps dans une autre session.`,
    );
  return parts.join(' ');
}

// Export JSON réimportable : en mode connecté, le contenu des pièces jointes (absent du tableau
// affiché) est relu sur le serveur. Les modifications locales non enregistrées sont conservées.
export async function exportWorkspace(projects) {
  if (projects.some(project => project.cards.some(card => (card.attachments || []).some(file => !file.data)))) {
    let full;
    try {
      full = await request('workspace?attachments=data');
    } catch {
      throw new Error('Le contenu des pièces jointes est indisponible pour l’export. Réessayez dans un instant.');
    }
    const data = new Map(
      full.projects.flatMap(project =>
        project.cards.flatMap(card => (card.attachments || []).map(file => [file.id, file.data])),
      ),
    );
    projects = projects.map(project => ({
      ...project,
      cards: project.cards.map(card => ({
        ...card,
        attachments: (card.attachments || [])
          .map(file => (file.data ? file : { ...file, data: data.get(file.id) }))
          .filter(file => file.data),
      })),
    }));
  }
  const blob = new Blob([JSON.stringify({ version: 1, projects }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'PlaniFiKateur-projets.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Lance l’export depuis un bouton : une erreur est signalée sans interrompre la page.
export const exportWithAlert = projects => void exportWorkspace(projects).catch(error => window.alert(error.message));
