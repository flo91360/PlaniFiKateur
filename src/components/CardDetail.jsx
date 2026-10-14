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
import { effortLabels } from '../../worker/ai-settings.mjs';
import { cardLinks } from '../lib/infos.js';
import { createId as uid } from '../lib/id.js';
import { parseTags } from '../lib/tags.js';
import { useCardExecutions } from '../lib/use-card-executions.js';

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

function Discussion({ card, user, onUpdate }) {
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
      {card.status === 'clarify' && (
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
    </div>
  );
}

function DeleteCard({ onDelete }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="delete-confirm">
      <p>Supprimer définitivement cette carte ?</p>
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

export default function CardDetail({
  engine = 'codex',
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
  const fieldsSaved =
    title === card.title &&
    description === card.description &&
    JSON.stringify(parseTags(tags)) === JSON.stringify(card.tags);
  const execution = useCardExecutions({
    projectId,
    cardId: card.id,
    offline,
    onRefresh: async () => {
      if (fieldsSaved) await onWorkflowRefresh();
    },
  });

  const saveFields = (nextDescription = description) => {
    onUpdate({ title: title.trim() || card.title, description: nextDescription.trim(), tags: parseTags(tags) });
    if (!title.trim()) setTitle(card.title);
  };
  const replaceDescription = text => {
    setDescription(text);
    saveFields(text);
  };
  const close = () => {
    saveFields();
    onClose();
  };
  return (
    <Dialog title="Détail de la carte" wide onClose={close}>
      <div className="detail-body">
        <div className="detail-main">
          <label className="detail-title-label">
            Titre
            <input
              aria-label="Titre de la carte"
              className="detail-title"
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
              value={description}
              onChange={e => setDescription(e.target.value)}
              onBlur={() => saveFields()}
              placeholder="Décrivez la demande pour l’agent, le résultat attendu et les contraintes utiles…"
            />
          </label>
          <DescriptionAssistant
            value={description}
            onChange={replaceDescription}
            offline={offline}
            projectId={projectId}
            title={title}
            listId={card.listId}
          />
          <p className="muted">Cette description est l’objectif transmis à l’agent.</p>
          <CardResources card={card} />
          {execution.ai && (
            <p className="muted">
              Exécution : {execution.ai.engine === 'codex' ? 'Codex' : 'Claude Code'} · modèle{' '}
              {execution.ai.model || 'par défaut'} · effort {effortLabels[execution.ai.effort || '']}.
            </p>
          )}
          <label className="detail-label">
            Étiquettes
            <input
              value={tags}
              onChange={e => setTags(e.target.value)}
              onBlur={() => saveFields()}
              placeholder="Interface, Recherche… (séparées par une virgule)"
            />
          </label>
          <Attachments
            otherBytes={attachmentBytes}
            attachments={card.attachments || []}
            onChange={attachments => onUpdate({ attachments })}
          />
          <Discussion card={card} user={user} onUpdate={onUpdate} />
          {!offline && <ActivityPanel projectId={projectId} cardId={card.id} />}
        </div>
        <aside className="detail-side">
          {!offline && <CardSubscription projectId={projectId} cardId={card.id} saveStatus={saveStatus} />}
          <label>
            Statut
            <select
              aria-label="Statut"
              disabled={execution.managed}
              value={card.status}
              onChange={e => onUpdate({ status: e.target.value })}
            >
              <StatusOptions />
            </select>
          </label>
          <EffortSelect
            engine={execution.managed ? execution.ai?.engine || engine : engine}
            value={card.aiEffort || ''}
            disabled={execution.managed}
            onChange={aiEffort => onUpdate({ aiEffort })}
          />
          <label>
            Priorité
            <select aria-label="Priorité" value={card.priority} onChange={e => onUpdate({ priority: e.target.value })}>
              <PriorityOptions />
            </select>
          </label>
          <DeleteCard onDelete={onDelete} />
        </aside>
      </div>
      <div className="detail-footer">
        <span>
          <Check size={14} />
          {saveLabels[saveStatus] || 'Modifications non sauvegardées'}
        </span>
        <button className="primary-button" onClick={close}>
          Terminé
          <Check size={16} />
        </button>
      </div>
    </Dialog>
  );
}
