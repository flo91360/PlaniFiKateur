import React, { useState } from 'react';
import { Bot, ExternalLink } from 'lucide-react';
import { apiData } from '../lib/api-client.js';
import { unfinished } from '../lib/use-card-executions.js';
import { effortLabels } from '../../worker/ai-settings.mjs';
import { usageText } from '../lib/execution-usage.js';

const STEPS = ['Prête', 'Réalisation', 'PR et tests', 'Terminée'];
const stepOf = { ready: 0, running: 1, waiting: 1, interrupted: 1, review: 2, merging: 2, done: 3 };
const checkLabels = {
  success: 'réussis',
  failure: 'en échec',
  cancelled: 'annulés',
  timed_out: 'expirés',
  action_required: 'en attente d’une action',
};

// La PR attend-elle l’approbation d’un responsable (projet qui l’exige, commit pas encore approuvé) ?
export const awaitingApproval = run =>
  run?.state === 'merging' &&
  !!run.approvalRequired &&
  run.approval?.headSha !== run.submissions.at(-1)?.pullRequest?.headSha;

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
      if (awaitingApproval(run)) return 'PR ouverte : elle attend l’approbation d’un responsable avant la fusion.';
      return run.approvalRequired
        ? `PR approuvée par ${run.approval.actor.name} : fusion après les tests GitHub.`
        : 'PR ouverte : fusion automatique après les tests GitHub.';
    case 'done':
      return pr ? 'PR fusionnée : tâche terminée.' : 'Tâche terminée.';
    default:
      return 'Exécution annulée.';
  }
}

// La question en attente figure dans la discussion de la carte : le bandeau ne la répète pas.
function detail(run) {
  if (run.state === 'waiting') return '';
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

const timeOf = date =>
  new Date(date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Détail du dernier résultat soumis : vérifications, livrables et fichiers joints à la carte.
function Result({ submission }) {
  const links = submission.links || [];
  const files = submission.files || [];
  return (
    <>
      {submission.checks && <p className="execution-detail">Vérifications : {submission.checks}</p>}
      {links.length > 0 && (
        <ul className="execution-deliverables" aria-label="Livrables">
          {links.map(link => (
            <li key={link}>
              <a href={link} target="_blank" rel="noreferrer">
                {link}
              </a>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <p className="execution-detail">Fichiers joints à la carte : {files.map(file => file.name).join(', ')}</p>
      )}
    </>
  );
}

// Historique de l’activité de l’agent sur l’exécution affichée (avancement, résultats, contrôles,
// interruption) : ces informations ne sont pas publiées dans la discussion.
function Journal({ run }) {
  const entries = [
    ...run.updates.map((update, index) => ({ key: `update-${index}`, date: update.date, text: update.text })),
    ...run.submissions.map((submission, index) => ({
      key: `submission-${index}`,
      date: submission.date,
      text: `Résultat soumis${submission.pullRequest ? ` (PR #${submission.pullRequest.number})` : ''} : ${submission.summary}`,
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!entries.length) return null;
  return (
    <details className="execution-journal">
      <summary>Journal de l’agent ({entries.length})</summary>
      <ol>
        {entries.map(entry => (
          <li key={entry.key}>
            {entry.date && <time dateTime={entry.date}>{timeOf(entry.date)}</time>}
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
    </details>
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
// `canLaunch` : responsable du projet (confier, valider, faire corriger) ; `canCancel` : contributeur.
// `beforeStart` enregistre la carte avant de la confier à l’agent (le bouton est actif dès que la
// description est renseignée, même si elle n’est pas encore enregistrée).
export default function ExecutionPanel({
  projectId,
  cardId,
  cardStatus,
  execution,
  canStart,
  startHint,
  canLaunch = true,
  canCancel = true,
  beforeStart = async () => {},
  onChanged,
}) {
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
  const start = () =>
    act(async () => {
      await beforeStart();
      await apiData(base, { method: 'POST', data: {} });
    });
  const active = unfinished(run);
  // Une tâche terminée n’est plus relancée : une suite fait l’objet d’une nouvelle carte.
  const finished = run?.state === 'done';
  const submission = run?.submissions.at(-1);
  const pr = submission?.pullRequest;
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
          {run.state === 'merging' && submission?.reviewRequired?.length > 0 && (
            <div className="execution-review" role="note">
              <p>
                Cette PR modifie les contrôles qui autorisent sa fusion : un responsable vérifie qu’ils ne sont pas
                affaiblis avant de l’approuver.
              </p>
              <ul aria-label="Contrôles modifiés">
                {submission.reviewRequired.map(item => (
                  <li key={item}>
                    <code>{item}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {submission && ['review', 'merging', 'done'].includes(run.state) && <Result submission={submission} />}
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
          <Journal run={run} />
        </>
      ) : execution.error ? (
        <div className="execution-error" role="alert">
          <p>Exécutions IA de cette carte indisponibles : {execution.error}</p>
          <button className="secondary-button" onClick={() => void execution.reload()}>
            Réessayer
          </button>
        </div>
      ) : !execution.loaded ? (
        <p className="execution-detail" aria-busy="true">
          Chargement de l’exécution IA…
        </p>
      ) : cardStatus === 'ready' ? (
        <p className="execution-detail">
          Carte prête à démarrer : le worker la prendra en charge à sa prochaine consultation.
        </p>
      ) : (
        <p className="execution-detail">
          Aucune exécution pour cette carte. Passez-la au statut « Prête à démarrer » ou confiez-la directement à
          l’agent.
        </p>
      )}
      {run && execution.error && (
        <p className="muted" role="status">
          Dernière actualisation impossible ({execution.error}) : l’état affiché peut dater. Nouvel essai automatique.
        </p>
      )}
      {execution.ai && (
        <p className="muted">
          Exécution : {execution.ai.engine === 'codex' ? 'Codex' : 'Claude Code'} · modèle{' '}
          {execution.ai.model || 'par défaut'} · effort {effortLabels[execution.ai.effort || '']}.
        </p>
      )}
      {run?.usage && <p className="muted execution-usage">{usageText(run.usage)}</p>}
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
          {!active && !finished && canLaunch && execution.loaded && !(execution.error && !run) && (
            <button
              className="primary-button"
              disabled={busy || !canStart}
              title={startHint || undefined}
              onClick={() => void start()}
            >
              {run ? 'Relancer l’agent' : 'Confier à l’agent'}
            </button>
          )}
          {awaitingApproval(run) && canLaunch && (
            <button className="primary-button" disabled={busy} onClick={() => void transition('approve')}>
              Approuver la fusion
            </button>
          )}
          {run?.state === 'review' && canLaunch && (
            <button className="primary-button" disabled={busy} onClick={() => void transition('accept')}>
              Valider le résultat
            </button>
          )}
          {['review', 'merging'].includes(run?.state) && canLaunch && (
            <button className="secondary-button" disabled={busy} onClick={() => setForm('reject')}>
              Demander des corrections
            </button>
          )}
          {active && canCancel && (
            <button className="secondary-button" disabled={busy} onClick={() => setForm('cancel')}>
              Annuler l’exécution
            </button>
          )}
        </div>
      )}
      {!active && !finished && startHint && <p className="muted">{startHint}</p>}
      {!canLaunch && (
        <p className="muted">
          Seuls les responsables du projet peuvent confier cette carte à l’agent ou valider son travail.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
