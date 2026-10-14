import React, { useState } from 'react';
import { Bot, ExternalLink } from 'lucide-react';
import { apiData } from '../lib/api-client.js';
import { unfinished } from '../lib/use-card-executions.js';
import { effortLabels } from '../../worker/ai-settings.mjs';

const STEPS = ['Prête', 'Réalisation', 'PR et tests', 'Terminée'];
const stepOf = { ready: 0, running: 1, waiting: 1, interrupted: 1, review: 2, merging: 2, done: 3 };
const checkLabels = {
  success: 'réussis',
  failure: 'en échec',
  cancelled: 'annulés',
  timed_out: 'expirés',
  action_required: 'en attente d’une action',
};

function headline(run) {
  const pr = run.submissions.at(-1)?.pullRequest;
  switch (run.state) {
    case 'ready':
      return 'En attente du worker : la tâche sera prise en charge à sa prochaine consultation.';
    case 'running':
      return `${run.agent?.name || 'L’agent'} réalise la demande.`;
    case 'waiting':
      return 'L’agent attend votre réponse : publiez-la dans la discussion.';
    case 'interrupted':
      return 'Exécution interrompue : le worker la reprendra automatiquement.';
    case 'review':
      return 'Résultat à valider.';
    case 'merging':
      return 'PR ouverte : fusion automatique après les tests GitHub.';
    case 'done':
      return pr ? 'PR fusionnée : tâche terminée.' : 'Tâche terminée.';
    default:
      return 'Exécution annulée.';
  }
}

function detail(run) {
  if (run.state === 'waiting') return run.exchanges.at(-1)?.question;
  if (run.state === 'interrupted') return run.interruption;
  if (run.state === 'cancelled') return run.cancellation;
  if (['review', 'done'].includes(run.state)) return run.submissions.at(-1)?.summary;
  return run.updates.at(-1)?.text || run.submissions.at(-1)?.summary;
}

function Steps({ state }) {
  const current = stepOf[state] ?? -1;
  return (
    <ol className={`execution-steps ${state === 'cancelled' ? 'cancelled' : ''}`}>
      {STEPS.map((label, index) => (
        <li
          key={label}
          className={index < current || state === 'done' ? 'done' : index === current ? 'current' : ''}
          aria-current={index === current && state !== 'done' ? 'step' : undefined}
        >
          {label}
        </li>
      ))}
    </ol>
  );
}

// Formulaire d’une action qui demande un message (annulation, corrections).
function MessageForm({ label, initial, submit, cancel, danger = false, busy, onSubmit, onCancel }) {
  const [message, setMessage] = useState(initial);
  return (
    <div className="execution-form">
      <label>
        {label}
        <textarea aria-label={label} rows={2} value={message} onChange={e => setMessage(e.target.value)} />
      </label>
      <div className="execution-actions">
        <button
          className={danger ? 'danger-button' : 'primary-button'}
          disabled={busy || !message.trim()}
          onClick={() => onSubmit(message.trim())}
        >
          {submit}
        </button>
        <button className="secondary-button" disabled={busy} onClick={onCancel}>
          {cancel}
        </button>
      </div>
    </div>
  );
}

// Suivi de l’exécution IA d’une carte et actions humaines (confier, annuler, valider, corriger).
export default function ExecutionPanel({ projectId, cardId, execution, canStart, startHint, onChanged }) {
  const run = execution.current;
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `projects/${projectId}/cards/${cardId}/work`;
  const act = async request => {
    setBusy(true);
    setError('');
    try {
      await request();
      setForm(null);
      await execution.reload();
      await onChanged();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const transition = (action, message) =>
    act(() => apiData(`${base}/${run.id}/${action}`, { method: 'POST', data: { version: run.version, message } }));
  const start = () => act(() => apiData(base, { method: 'POST', data: {} }));
  const active = unfinished(run);
  const pr = run?.submissions.at(-1)?.pullRequest;
  const checks = run?.githubChecks;
  const text = run && detail(run);
  return (
    <section className="execution-panel" aria-label="Exécution IA">
      <h3>
        <Bot size={17} />
        Exécution IA
        {execution.runs.length > 1 && <span>{execution.runs.length} exécutions</span>}
      </h3>
      {run ? (
        <>
          <Steps state={run.state} />
          <p className={`execution-headline ${run.state}`}>{headline(run)}</p>
          {text && <p className="execution-detail">{text}</p>}
          {(pr || checks) && (
            <p className="execution-links">
              {pr && (
                <a href={pr.url} target="_blank" rel="noreferrer">
                  PR #{pr.number}
                  <ExternalLink size={12} />
                </a>
              )}
              {checks?.url && (
                <a href={checks.url} target="_blank" rel="noreferrer">
                  Contrôles GitHub : {checkLabels[checks.conclusion] || checks.conclusion}
                  <ExternalLink size={12} />
                </a>
              )}
            </p>
          )}
        </>
      ) : (
        <p className="execution-detail">
          Aucune exécution pour cette carte. Passez-la au statut « Prête à démarrer » ou confiez-la directement à
          l’agent.
        </p>
      )}
      {execution.ai && (
        <p className="muted">
          Exécution : {execution.ai.engine === 'codex' ? 'Codex' : 'Claude Code'} · modèle{' '}
          {execution.ai.model || 'par défaut'} · effort {effortLabels[execution.ai.effort || '']}.
        </p>
      )}
      {form === 'cancel' ? (
        <MessageForm
          label="Motif de l’annulation"
          initial="Annulée depuis la carte."
          submit="Confirmer l’annulation"
          cancel="Garder l’exécution"
          danger
          busy={busy}
          onSubmit={message => transition('cancel', message)}
          onCancel={() => setForm(null)}
        />
      ) : form === 'reject' ? (
        <MessageForm
          label="Corrections demandées"
          initial=""
          submit="Envoyer à l’agent"
          cancel="Ne rien demander"
          busy={busy}
          onSubmit={message => transition('reject', message)}
          onCancel={() => setForm(null)}
        />
      ) : (
        <div className="execution-actions">
          {!active && (
            <button
              className="primary-button"
              disabled={busy || !canStart}
              title={startHint || undefined}
              onClick={() => void start()}
            >
              {run ? 'Relancer l’agent' : 'Confier à l’agent'}
            </button>
          )}
          {run?.state === 'review' && (
            <button className="primary-button" disabled={busy} onClick={() => void transition('accept')}>
              Valider le résultat
            </button>
          )}
          {['review', 'merging'].includes(run?.state) && (
            <button className="secondary-button" disabled={busy} onClick={() => setForm('reject')}>
              Demander des corrections
            </button>
          )}
          {active && (
            <button className="secondary-button" disabled={busy} onClick={() => setForm('cancel')}>
              Annuler l’exécution
            </button>
          )}
        </div>
      )}
      {!active && startHint && <p className="muted">{startHint}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
