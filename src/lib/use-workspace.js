import { useCallback, useEffect, useRef, useState } from 'react';
import { seed } from '../data/demo.js';
import { validateWorkspace } from './workspace.js';

const STORAGE = 'planifikateur.workspace.v1';
export const offlineMode = globalThis.__PLANIFIKATEUR_OFFLINE__ === true || globalThis.location?.protocol === 'file:';
function readLocal() {
  try { return validateWorkspace(JSON.parse(localStorage.getItem(STORAGE))); } catch { return seed; }
}
async function request(path, options = {}) {
  const response = await fetch(`/api/v1/${path}`, { credentials: 'same-origin', ...options });
  if (response.status === 304) return null;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Le serveur ne répond pas.'), { status: response.status });
  return data;
}

export function useWorkspace({ pauseRefresh = false } = {}) {
  const [projects, setState] = useState(() => offlineMode ? readLocal() : seed);
  const [ready, setReady] = useState(offlineMode);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false), [user, setUser] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveError, setSaveError] = useState('');
  const [syncError, setSyncError] = useState('');
  const paused = useRef(pauseRefresh), refreshing = useRef(false);
  paused.current = pauseRefresh;
  const current = useRef(projects), saved = useRef(projects), revision = useRef(0), saving = useRef(false), initialized = useRef(offlineMode);
  const load = useCallback(async () => {
    setLoadError(''); setReady(false);
    try {
      const session = await request('session');
      setUser(session.user || null); setNeedsSetup(session.needsSetup);
      if (!session.authenticated) { setNeedsLogin(true); return; }
      const workspace = await request('workspace');
      const clean = validateWorkspace(workspace.projects);
      current.current = clean; saved.current = clean; revision.current = workspace.revision; initialized.current = true;
      setState(clean); setNeedsLogin(false); setSaveError(''); setSyncError(''); setSaveStatus('saved'); setReady(true);
    } catch (error) { setLoadError(error.message); }
  }, []);
  const refresh = useCallback(async ({ whileEditing = false } = {}) => {
    if (offlineMode || !initialized.current || (!whileEditing && paused.current) || saving.current || refreshing.current || current.current !== saved.current || document.visibilityState === 'hidden') return;
    const baseRevision = revision.current;
    refreshing.current = true;
    try {
      const remote = await request('workspace', { headers: { 'If-None-Match': `"${baseRevision}"` }, signal: AbortSignal.timeout(10000) });
      // A read may complete after the user begins editing or after a newer save.
      if ((!whileEditing && paused.current) || saving.current || current.current !== saved.current || revision.current !== baseRevision) return;
      if (remote && remote.revision > baseRevision) {
        const clean = validateWorkspace(remote.projects);
        current.current = clean; saved.current = clean; revision.current = remote.revision;
        setState(clean);
      }
      setSyncError('');
    } catch (error) {
      setSyncError(error.status === 401 ? 'Votre session a expiré. Rechargez la page pour vous reconnecter.' : 'Actualisation indisponible. Une nouvelle tentative sera faite automatiquement.');
    } finally { refreshing.current = false; }
  }, []);
  useEffect(() => { if (!offlineMode) void load(); }, [load]);
  useEffect(() => {
    if (offlineMode || !ready || pauseRefresh) return;
    const update = () => void refresh();
    update();
    const timer = setInterval(update, 5000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [ready, pauseRefresh, refresh]);
  const setProjects = useCallback(update => {
    const next = typeof update === 'function' ? update(current.current) : update;
    if (next === current.current) return;
    current.current = next; setState(next);
    if (!offlineMode) setSaveStatus('saving');
  }, []);
  const flush = useCallback(async () => {
    if (offlineMode || !initialized.current || saving.current || current.current === saved.current) return;
    saving.current = true; setSaveStatus('saving'); setSaveError('');
    try {
      while (current.current !== saved.current) {
        const snapshot = current.current;
        const data = await request('workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': `"${revision.current}"` }, body: JSON.stringify({ projects: snapshot }) });
        const canonical = validateWorkspace(data.projects);
        revision.current = data.revision; saved.current = canonical;
        if (current.current === snapshot) current.current = canonical;
        else current.current = current.current.map(p => ({ ...p, cards: p.cards.map(c => {
          const remote = canonical.find(project => project.id === p.id)?.cards.find(card => card.id === c.id);
          if (!remote) return c;
          return { ...c, createdBy: remote.createdBy, createdAt: remote.createdAt, updatedBy: remote.updatedBy, updatedAt: remote.updatedAt, comments: c.comments.map(comment => {
            const stamped = remote.comments.find(item => item.id === comment.id);
            return stamped ? { ...comment, author: stamped.author, authorId: stamped.authorId, date: stamped.date } : comment;
          }) };
        }) }));
        setState(current.current);
      }
      setSaveStatus('saved');
    } catch (error) {
      setSaveStatus(error.status === 409 ? 'conflict' : 'error'); setSaveError(error.message);
    } finally { saving.current = false; }
  }, []);
  useEffect(() => {
    if (offlineMode) {
      try { localStorage.setItem(STORAGE, JSON.stringify(projects)); setSaveStatus('saved'); }
      catch { setSaveStatus('error'); setSaveError('Le navigateur ne permet pas de conserver ces modifications après fermeture.'); }
      return;
    }
    const timer = setTimeout(() => void flush(), 250);
    return () => clearTimeout(timer);
  }, [projects, flush]);
  useEffect(() => {
    if (offlineMode) return;
    const warn = e => { if (current.current !== saved.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const authenticate = async (path, data) => { await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); await load(); };
  const login = data => authenticate('session', data);
  const setup = data => authenticate('accounts/setup', data);
  const accept = data => authenticate('accounts/accept', data);
  const logout = async () => { if (current.current !== saved.current) throw new Error('Sauvegardez ou exportez vos modifications avant de vous déconnecter.'); await request('session', { method: 'DELETE' }); initialized.current = false; setUser(null); setNeedsLogin(true); setReady(false); };
  return { projects, setProjects, ready, needsLogin, needsSetup, user, loadError, saveStatus, saveError, syncError, refresh, retrySave: flush, reload: load, login, setup, accept, logout };
}

export function exportWorkspace(projects) {
  const blob = new Blob([JSON.stringify({ version: 1, projects }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'PlaniFiKateur-projets.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
