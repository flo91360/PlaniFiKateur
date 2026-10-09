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
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Le serveur ne répond pas.'), { status: response.status });
  return data;
}

export function useWorkspace() {
  const [projects, setState] = useState(() => offlineMode ? readLocal() : seed);
  const [ready, setReady] = useState(offlineMode);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveError, setSaveError] = useState('');
  const current = useRef(projects), saved = useRef(projects), revision = useRef(0), saving = useRef(false), initialized = useRef(offlineMode);
  const load = useCallback(async () => {
    setLoadError(''); setReady(false);
    try {
      const session = await request('session');
      if (!session.authenticated) { setNeedsLogin(true); return; }
      const workspace = await request('workspace');
      const clean = validateWorkspace(workspace.projects);
      current.current = clean; saved.current = clean; revision.current = workspace.revision; initialized.current = true;
      setState(clean); setNeedsLogin(false); setSaveError(''); setSaveStatus('saved'); setReady(true);
    } catch (error) { setLoadError(error.message); }
  }, []);
  useEffect(() => { if (!offlineMode) void load(); }, [load]);
  const setProjects = useCallback(update => {
    const next = typeof update === 'function' ? update(current.current) : update;
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
        saved.current = snapshot; revision.current = data.revision;
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
  const login = async token => { await request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); await load(); };
  return { projects, setProjects, ready, needsLogin, loadError, saveStatus, saveError, retrySave: flush, reload: load, login };
}

export function exportWorkspace(projects) {
  const blob = new Blob([JSON.stringify({ version: 1, projects }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'PlaniFiKateur-projets.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
