import React, { useEffect, useState } from 'react';
import { workRequest } from './AgentSetup.jsx';
import { efforts, effortLabels } from '../../worker/ai-settings.mjs';
import { aiModels } from '../lib/ai-models.js';

export function EffortSelect({ engine = 'codex', value = '', onChange, disabled = false }) {
  const levels = efforts[engine] || efforts.codex;
  return <label>Effort IA<select aria-label="Effort IA" disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
    {!levels.includes(value) && <option value={value}>{effortLabels[value]} — incompatible avec ce moteur</option>}
    {levels.map(level => <option key={level} value={level}>{effortLabels[level]}</option>)}
  </select><span className="muted">L’effort dépend des capacités du modèle choisi.</span></label>;
}

export default function AiSettings({ projectId, user, onConfigured }) {
  const [ai, setAi] = useState(null), [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const models = aiModels[ai?.engine] || [];
  useEffect(() => {
    const controller = new AbortController();
    workRequest(`projects/${projectId}/ai`, 'GET', null, controller.signal).then(setAi).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [projectId]);
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await workRequest(`projects/${projectId}/ai`, 'PUT', ai);
      setAi(saved); onConfigured?.(saved); setMessage('Moteur et modèle enregistrés pour ce projet.');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <details className="agent-setup"><summary>Moteur et modèle IA</summary>
    <p>Ces choix s’appliquent aux nouvelles prises en charge. L’effort se règle dans chaque carte ; une conversation déjà commencée conserve ses réglages.</p>
    {ai && <><label>Moteur IA<select aria-label="Moteur IA" disabled={user.role !== 'admin' || busy} value={ai.engine} onChange={event => setAi({ engine: event.target.value, model: '' })}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label>
      <label>Modèle IA<select aria-label="Modèle IA" disabled={user.role !== 'admin' || busy} value={ai.model} onChange={event => setAi({ ...ai, model: event.target.value })}>
        <option value="">Par défaut</option>
        {ai.model && !models.some(model => model.value === ai.model) && <option value={ai.model}>{ai.model} (modèle enregistré)</option>}
        {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
      </select></label>
      <p className="muted">La liste dépend du moteur ; l’accès aux modèles dépend de votre compte. « Par défaut » utilise le modèle du moteur. Claude Code nécessite son authentification sur le worker.</p>
      {user.role === 'admin' && <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>Enregistrer les paramètres IA</button>}</>}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}
  </details>;
}
