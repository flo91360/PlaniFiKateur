import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, MessageSquare, Trash2 } from 'lucide-react';
import ActivityPanel from './ActivityPanel.jsx';
import Attachments from './Attachments.jsx';
import Avatar from './Avatar.jsx';
import CardSubscription from './CardSubscription.jsx';
import DescriptionAssistant from './DescriptionAssistant.jsx';
import Dialog from './Dialog.jsx';
import LocalForm from './LocalForm.jsx';
import Status, { PriorityOptions, StatusOptions } from './Status.jsx';
import { EffortSelect } from './AiSettings.jsx';
import { cardLinks } from '../lib/infos.js';
import { createId as uid } from '../lib/id.js';
import { parseTags } from '../lib/tags.js';
import { unfinished, useCardExecutions } from '../lib/use-card-executions.js';
import ExecutionPanel from './ExecutionPanel.jsx';

function CommentText({ text }) {
  return (
    <p>
      {text.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a key={index} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

// Mode d’emploi, changelog et téléchargements Google Drive d’une carte Infos.
function CardResources({ card }) {
  return (
    <>
      {cardLinks(card).map(link => (
        <div key={link.href} className="download-release">
          <a className="secondary-button" href={link.href} target="_blank" rel="noreferrer">
            {link.detail}
            <ArrowRight size={16} />
          </a>
        </div>
      ))}
      {card.downloads && (
        <div className="download-release">
          <a
            className="secondary-button"
            href={`https://drive.google.com/drive/folders/${card.downloads.folderId}`}
            target="_blank"
            rel="noreferrer"
          >
            Télécharger cette version sur Google Drive
            <ArrowRight size={16} />
          </a>
          <ul>
            {card.downloads.files.map(file => (
              <li key={file.id}>
                <a href={`https://drive.google.com/file/d/${file.id}/view`} target="_blank" rel="noreferrer">
                  {file.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// Discussion entre l’agent et les personnes : questions de l’agent et réponses. L’activité de l’agent
// figure dans le bandeau « Exécution IA » ; `statusHint` rappelle l’attente quand ce bandeau est absent.
function Discussion({ card, user, readOnly, statusHint, onUpdate }) {
  const [comment, setComment] = useState('');
  const publish = () => {
    if (!comment.trim()) return;
    onUpdate({
      comments: [
        ...card.comments,
        { id: uid(), author: user?.name || 'Vous', text: comment.trim(), date: new Date().toISOString() },
      ],
    });
    setComment('');
  };
  return (
    <div className="comments-section">
      <h3>
        <MessageSquare size={17} />
        Discussion<span>{card.comments.length}</span>
      </h3>
      {statusHint && card.status === 'clarify' && (
        <p role="status">L’agent attend votre réponse. Publiez un commentaire pour reprendre la tâche.</p>
      )}
      {card.comments.map(c => (
        <div className="comment" key={c.id}>
          <Avatar name={c.author} kind={c.authorKind} />
          <div>
            <strong>
              {c.author}
              <time dateTime={c.date}>
                {new Date(c.date).toLocaleString('fr-FR', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </strong>
            <CommentText text={c.text} />
          </div>
        </div>
      ))}
      {!card.comments.length && <p className="muted">Une question, une précision ? La discussion commence ici.</p>}
      {readOnly ? (
        <p className="muted">Lecture seule : votre rôle sur ce projet ne permet pas de commenter.</p>
      ) : (
        <LocalForm onConfirm={publish}>
          <textarea
            aria-label="Votre commentaire"
            rows={2}
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Ajouter un commentaire…"
          />
          <button type="button" onClick={publish} className="secondary-button" disabled={!comment.trim()}>
            Publier
            <ArrowRight size={14} />
          </button>
        </LocalForm>
      )}
    </div>
  );
}

function DeleteCard({ onDelete, cancelsExecution }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="delete-confirm">
      <p>Supprimer définitivement cette carte ?{cancelsExecution && ' Son exécution IA en cours sera annulée.'}</p>
      <button className="danger-button" onClick={onDelete}>
        Oui, supprimer
      </button>
      <button className="secondary-button" onClick={() => setConfirming(false)}>
        Annuler
      </button>
    </div>
  ) : (
    <button className="delete-button" onClick={() => setConfirming(true)}>
      <Trash2 size={14} />
      Supprimer la carte
    </button>
  );
}

const saveLabels = { saved: 'Modifications enregistrées', saving: 'Enregistrement en cours…' };
const notSaved = 'La carte n’a pas pu être enregistrée : elle n’a pas été confiée à l’agent.';

// Champs qui forment la demande : les modifier annule l’exécution en cours (server/workflows.js, source).
const requestFields = {
  title: value => value,
  description: value => value,
  tags: value => JSON.stringify(value),
  attachments: value => JSON.stringify(value || []),
  aiEffort: value => value || '',
};
const changesRequest = (card, patch) =>
  Object.entries(requestFields).some(
    ([key, normalize]) => key in patch && normalize(patch[key]) !== normalize(card[key]),
  );
const systemCards = projectId => [`${projectId}-git-version`, `${projectId}-readme`, `${projectId}-changelog`];

function CancelConfirm({ onConfirm, onRevert }) {
  // Le bandeau s’affiche en haut du détail : le rendre visible même si la saisie a eu lieu plus bas.
  // Accolades obligatoires : les navigateurs récents renvoient une promesse que React prendrait
  // pour une fonction de nettoyage, ce qui ferait planter l’application au démontage.
  const banner = useRef(null);
  useEffect(() => {
    banner.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <div ref={banner} className="execution-confirm" role="alert">
      <p>
        Cette modification change la demande : l’exécution IA en cours sera annulée et la carte repassera «&nbsp;À
        explorer&nbsp;» jusqu’à ce qu’elle soit de nouveau confiée à l’agent.
      </p>
      <button className="danger-button" onClick={onConfirm}>
        Annuler l’exécution et enregistrer
      </button>
      <button className="secondary-button" onClick={onRevert}>
        Rétablir la demande
      </button>
    </div>
  );
}

export default function CardDetail({
  engine = 'codex',
  role = 'manager',
  attachmentBytes = 0,
  onWorkflowRefresh,
  offline,
  projectId,
  user,
  saveStatus,
  card,
  lists,
  onClose,
  onUpdate,
  onDelete,
}) {
  // Droits sur le projet : lecture seule pour un lecteur ; seul un responsable confie la carte à l’agent.
  const readOnly = role === 'viewer',
    canLaunch = role === 'manager';
  // Une carte prête attend l’agent avec la demande validée par un responsable : lui seul la modifie.
  const requestLocked = readOnly || (card.status === 'ready' && !canLaunch);
  const tagsText = card.tags.join(', ');
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [tags, setTags] = useState(tagsText);
  // Une mise à jour reçue du serveur remplace un champ seulement s’il n’est pas en cours de saisie.
  const previousFields = useRef({ title: card.title, description: card.description, tags: tagsText });
  useEffect(() => {
    const before = previousFields.current;
    setTitle(value => (value === before.title ? card.title : value));
    setDescription(value => (value === before.description ? card.description : value));
    setTags(value => (value === before.tags ? tagsText : value));
    previousFields.current = { title: card.title, description: card.description, tags: tagsText };
  }, [card.title, card.description, tagsText]);
  // Comparaison sur les valeurs enregistrées (titre vide conservé, description sans espaces de bord).
  const fieldsSaved =
    (title.trim() || card.title) === card.title &&
    description.trim() === card.description &&
    JSON.stringify(parseTags(tags)) === JSON.stringify(card.tags);
  const execution = useCardExecutions({
    projectId,
    cardId: card.id,
    offline,
    onRefresh: async () => {
      if (fieldsSaved) await onWorkflowRefresh();
    },
  });

  const runActive = unfinished(execution.current);
  // Modification qui annulerait l’exécution en cours : { patch, close } en attente de confirmation.
  // Un champ quitté (defer) reste un brouillon local : la confirmation vient à la fermeture, sans
  // déplacer la page au moment où la personne clique ailleurs.
  const [pending, setPending] = useState(null);
  const update = (patch, { close = false, defer = false } = {}) => {
    if (runActive && changesRequest(card, patch)) {
      if (!defer) setPending({ patch, close });
      return;
    }
    onUpdate(patch);
    if (close) onClose();
  };
  const saveFields = (nextDescription = description, options = { defer: true }) => {
    update({ title: title.trim() || card.title, description: nextDescription.trim(), tags: parseTags(tags) }, options);
    if (!title.trim()) setTitle(card.title);
  };
  const replaceDescription = text => {
    setDescription(text);
    saveFields(text);
  };
  const close = () => saveFields(description, { close: true });
  const confirmPending = () => {
    onUpdate(pending.patch);
    setPending(null);
    if (pending.close) onClose();
  };
  const revertPending = () => {
    setTitle(card.title);
    setDescription(card.description);
    setTags(tagsText);
    setPending(null);
    if (pending.close) onClose();
  };
  // Le bouton du bandeau est actif dès que la description saisie n’est pas vide : la carte est
  // enregistrée sur le serveur juste avant d’être confiée à l’agent.
  const startHint = description.trim() ? '' : 'Rédigez la description : c’est la demande transmise à l’agent.';
  const stored = fieldsSaved && saveStatus === 'saved';
  const executionShown = !offline && !systemCards(projectId).includes(card.id);
  const saveFailed = ['error', 'conflict'].includes(saveStatus);
  // Demandes « Confier à l’agent » en attente de l’enregistrement de la carte.
  const saveWaiters = useRef([]);
  useEffect(() => {
    if (!stored && !saveFailed) return;
    for (const waiter of saveWaiters.current.splice(0)) {
      if (stored) waiter.resolve();
      else waiter.reject(new Error(notSaved));
    }
  }, [stored, saveFailed]);
  const saveBeforeStart = () => {
    if (stored) return Promise.resolve();
    if (fieldsSaved && saveFailed) return Promise.reject(new Error(notSaved));
    const waiting = new Promise((resolve, reject) => saveWaiters.current.push({ resolve, reject }));
    saveFields(description, {});
    return waiting;
  };
  return (
    <Dialog title="Détail de la carte" wide onClose={close}>
      {pending && <CancelConfirm onConfirm={confirmPending} onRevert={revertPending} />}
      <div className="detail-body">
        <div className="detail-main">
          <label className="detail-title-label">
            Titre
            <input
              aria-label="Titre de la carte"
              className="detail-title"
              readOnly={requestLocked}
              value={title}
              maxLength={140}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => saveFields()}
            />
          </label>
          <p className="card-authorship">
            Créée par {card.createdBy?.name || 'Auteur inconnu'}
            {card.createdAt && <> · {new Date(card.createdAt).toLocaleString('fr-FR')}</>}
            {card.updatedBy && (
              <>
                <br />
                Dernière modification par {card.updatedBy.name}
              </>
            )}
          </p>
          <div className="detail-status">
            <Status value={card.status} />
            <span>dans {lists.find(l => l.id === card.listId)?.name}</span>
          </div>
          <label className="detail-label">
            Description
            <textarea
              aria-label="Description"
              rows={4}
              readOnly={requestLocked}
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={() => saveFields()}
              placeholder="Décrivez la demande pour l’agent, le résultat attendu et les contraintes utiles…"
            />
          </label>
          {!requestLocked && (
            <DescriptionAssistant
              value={description}
              onChange={replaceDescription}
              offline={offline}
              projectId={projectId}
              title={title}
              listId={card.listId}
            />
          )}
          <p className="muted">
            {requestLocked && !readOnly
              ? 'Carte confiée à l’agent : seul un responsable peut encore modifier la demande. Repassez-la en « À explorer » pour la retravailler.'
              : 'Cette description est l’objectif transmis à l’agent.'}
          </p>
          {executionShown && (
            <ExecutionPanel
              projectId={projectId}
              cardId={card.id}
              cardStatus={card.status}
              execution={execution}
              canStart={canLaunch && !startHint}
              startHint={canLaunch ? startHint : ''}
              canLaunch={canLaunch}
              canCancel={!readOnly}
              beforeStart={saveBeforeStart}
              onChanged={onWorkflowRefresh}
            />
          )}
          <CardResources card={card} />
          <label className="detail-label">
            Étiquettes
            <input
              value={tags}
              readOnly={requestLocked}
              onChange={e => setTags(e.target.value)}
              onBlur={() => saveFields()}
              placeholder="Interface, Recherche… (séparées par une virgule)"
            />
          </label>
          <Attachments
            otherBytes={attachmentBytes}
            attachments={card.attachments || []}
            source={offline ? null : { projectId, cardId: card.id }}
            readOnly={requestLocked}
            onChange={attachments => update({ attachments })}
          />
          <Discussion card={card} user={user} readOnly={readOnly} statusHint={!executionShown} onUpdate={onUpdate} />
          {!offline && <ActivityPanel projectId={projectId} cardId={card.id} />}
        </div>
        <aside className="detail-side">
          {!offline && <CardSubscription projectId={projectId} cardId={card.id} />}
          <label>
            Statut
            <select
              aria-label="Statut"
              disabled={execution.managed || readOnly}
              value={card.status}
              onChange={e => onUpdate({ status: e.target.value })}
            >
              <StatusOptions canLaunch={canLaunch} />
            </select>
          </label>
          <EffortSelect
            engine={execution.managed ? execution.ai?.engine || engine : engine}
            value={card.aiEffort || ''}
            disabled={execution.managed || requestLocked}
            onChange={aiEffort => update({ aiEffort })}
          />
          <label>
            Priorité
            <select
              aria-label="Priorité"
              value={card.priority}
              disabled={readOnly}
              onChange={e => onUpdate({ priority: e.target.value })}
            >
              <PriorityOptions />
            </select>
          </label>
          {!readOnly && <DeleteCard onDelete={onDelete} cancelsExecution={runActive} />}
        </aside>
      </div>
      <div className="detail-footer">
        <span>
          <Check size={14} />
          {runActive && !fieldsSaved
            ? 'Demande modifiée : confirmation à la fermeture'
            : saveLabels[saveStatus] || 'Modifications non sauvegardées'}
        </span>
        <button className="primary-button" onClick={close}>
          Terminé
          <Check size={16} />
        </button>
      </div>
    </Dialog>
  );
}
