import React, { useEffect, useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { efforts, effortLabels, defaultEffort } from '../../worker/ai-settings.mjs';
import { aiModels } from '../lib/ai-models.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

export function EffortSelect({ engine = 'codex', value = defaultEffort, onChange, disabled = false }) {
  const levels = (efforts[engine] || efforts.codex).filter(Boolean);
  const selectedValue = value || defaultEffort;
  return (
    <label>
      Effort IA
      <select
        aria-label="Effort IA"
        disabled={disabled}
        value={selectedValue}
        onChange={event => onChange(event.target.value)}
      >
        {!levels.includes(selectedValue) && (
          <option value={selectedValue}>{effortLabels[selectedValue]} — incompatible avec ce moteur</option>
        )}
        {levels.map(level => (
          <option key={level} value={level}>
            {effortLabels[level]}
          </option>
        ))}
      </select>
      <span className="muted">L’effort dépend des capacités du modèle choisi.</span>
    </label>
  );
}

export default function AiSettings({ projectId, user, onConfigured, onState }) {
  const saved = useApiResource(`projects/${projectId}/ai`);
  const action = useApiAction();
  const [draft, setDraft] = useState(null);
  const ai = draft || saved.data,
    busy = action.busy,
    setAi = setDraft;
  const models = aiModels[ai?.engine] || [];
  useEffect(() => {
    if (saved.data) onState?.(saved.data);
  }, [saved.data, onState]);
  const save = () =>
    action.run(async () => {
      const next = await apiData(`projects/${projectId}/ai`, { method: 'PUT', data: ai });
      saved.setData(next);
      setDraft(null);
      onConfigured?.(next);
    }, 'Moteur et modèle enregistrés pour ce projet.');
  return (
    <details className="agent-setup">
      <summary>Moteur et modèle IA</summary>
      <p>
        Ces choix s’appliquent aux nouvelles prises en charge. L’effort se règle dans chaque carte ; une conversation
        déjà commencée conserve ses réglages.
      </p>
      {ai && (
        <>
          <label>
            Moteur IA
            <select
              aria-label="Moteur IA"
              disabled={user.role !== 'admin' || busy}
              value={ai.engine}
              onChange={event => setAi({ engine: event.target.value, model: '' })}
            >
              <option value="codex">Codex</option>
              <option value="claude-code">Claude Code</option>
            </select>
          </label>
          <label>
            Modèle IA
            <select
              aria-label="Modèle IA"
              disabled={user.role !== 'admin' || busy}
              value={ai.model}
              onChange={event => setAi({ ...ai, model: event.target.value })}
            >
              <option value="">Par défaut</option>
              {ai.model && !models.some(model => model.value === ai.model) && (
                <option value={ai.model}>{ai.model} (modèle enregistré)</option>
              )}
              {models.map(model => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            La liste dépend du moteur ; l’accès aux modèles dépend de votre compte. « Par défaut » utilise le modèle du
            moteur. Claude Code nécessite son authentification sur le worker.
          </p>
          {user.role === 'admin' && (
            <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>
              Enregistrer les paramètres IA
            </button>
          )}
        </>
      )}
      <FormStatus message={action.message} error={action.error || saved.error} />
    </details>
  );
}
