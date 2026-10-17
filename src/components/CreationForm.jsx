import React, { useRef, useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import Attachments from './Attachments.jsx';
import DescriptionAssistant from './DescriptionAssistant.jsx';
import LocalForm from './LocalForm.jsx';
import { useUnsavedChanges } from './Dialog.jsx';
import { EffortSelect } from './AiSettings.jsx';
import { PriorityOptions, StatusOptions } from './Status.jsx';
import { parseTags } from '../lib/tags.js';
import { isDiscussionCard } from '../lib/discussion-list.js';
import { useProjectAccess } from '../lib/project-access.js';

const texts = {
  project: {
    intro: 'Un espace dédié, pour rassembler les idées qui vont ensemble.',
    label: 'Nom du projet',
    placeholder: 'Ex. Mon application',
    submit: 'Créer le projet',
  },
  list: {
    intro: 'Organisez votre tableau avec une catégorie qui vous ressemble.',
    label: 'Nom de la liste',
    placeholder: 'Ex. À explorer',
    submit: 'Créer la liste',
  },
  card: {
    intro: 'Décrivez la demande et le résultat attendu dès la création de votre carte.',
    label: 'Titre de la carte',
    placeholder: 'Qu’aimeriez-vous faire évoluer ?',
    submit: 'Créer la carte',
  },
};

// Création d’un projet, d’une liste ou d’une carte (type).
export default function CreationForm({
  engine = 'codex',
  offline = false,
  projectId,
  attachmentBytes = 0,
  type,
  lists,
  listId,
  onCancel,
  onSubmit,
}) {
  const { canLaunch } = useProjectAccess();
  const formRef = useRef(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const target = listId || lists[0]?.id || '';
  const [priority, setPriority] = useState('normal');
  const [aiEffort, setAiEffort] = useState('medium');
  const [status, setStatus] = useState('draft');
  const [tags, setTags] = useState('');
  const [comment, setComment] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const isCard = type === 'card';
  useUnsavedChanges(!!(title.trim() || description.trim() || tags.trim() || comment.trim() || attachments.length));
  // Une carte de la liste Discussion est une question pour échanger, jamais confiée à l’agent.
  const discussion = isCard && isDiscussionCard({ id: projectId, lists }, { listId: target });
  const text = texts[type];
  // `chosenStatus` : « ready » quand la carte est confiée à l’agent depuis le bandeau d’exécution.
  const create = chosenStatus => {
    if (uploading || !formRef.current.reportValidity()) return;
    const data = new FormData(formRef.current);
    const submittedTitle = String(data.get('title') || '').trim();
    if (!submittedTitle) {
      setError('Donnez un nom à votre projet, liste ou carte pour continuer.');
      return;
    }
    try {
      onSubmit({
        title: submittedTitle,
        description: String(data.get('description') || '').trim(),
        listId: target,
        priority,
        status: chosenStatus,
        aiEffort,
        tags: parseTags(String(data.get('tags') || '')),
        checklist: [],
        attachments,
        comment: String(data.get('comment') || '').trim(),
      });
    } catch {
      setError('La création a échoué. Vos informations sont conservées : vous pouvez réessayer.');
    }
  };
  const submit = () => create(status);
  return (
    <LocalForm className={`creation-form ${isCard ? 'card-creation' : ''}`} formRef={formRef} onConfirm={submit}>
      <p>{text.intro}</p>
      <div className={isCard ? 'creation-layout' : ''}>
        <div className="creation-main">
          <label>
            {text.label}
            <input
              name="title"
              autoFocus
              required
              maxLength={140}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={text.placeholder}
            />
          </label>
          {type !== 'list' && (
            <label>
              {type === 'project' ? 'Présentation' : 'Description'}
              <textarea
                name="description"
                aria-label={type === 'project' ? 'Présentation' : 'Description'}
                rows={3}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Quelques mots pour donner du contexte…"
              />
            </label>
          )}
          {isCard && (
            <>
              <DescriptionAssistant
                value={description}
                onChange={setDescription}
                offline={offline}
                projectId={projectId}
                title={title}
                listId={target}
              />
              <p className="muted">
                {discussion
                  ? 'Carte de discussion : une question pour échanger sur le projet. L’agent y répond sans rien modifier.'
                  : 'La description sera la demande transmise à l’agent.'}
              </p>
              {!offline && !discussion && (
                <section className="execution-panel" aria-label="Exécution IA">
                  <h3>
                    <Bot size={17} />
                    Exécution IA
                  </h3>
                  <p className="execution-detail">
                    Aucune exécution pour cette carte. Confiez-la à l’agent dès sa création : le worker la prendra en
                    charge.
                  </p>
                  {canLaunch ? (
                    <>
                      <div className="execution-actions">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={uploading || !title.trim() || !target || !description.trim()}
                          onClick={() => create('ready')}
                        >
                          Créer et confier à l’agent
                        </button>
                      </div>
                      {!description.trim() && (
                        <p className="muted">Rédigez la description : c’est la demande transmise à l’agent.</p>
                      )}
                    </>
                  ) : (
                    <p className="muted">Seuls les responsables du projet peuvent confier cette carte à l’agent.</p>
                  )}
                </section>
              )}
              <label>
                Étiquettes
                <input
                  name="tags"
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  placeholder="Interface, Recherche… (séparées par une virgule)"
                />
              </label>
              <Attachments
                otherBytes={attachmentBytes}
                attachments={attachments}
                onChange={setAttachments}
                onBusy={setUploading}
              />
              <label className="initial-comment">
                Premier commentaire <span className="optional-label">Facultatif</span>
                <textarea
                  name="comment"
                  aria-label="Votre commentaire"
                  rows={2}
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Une précision pour commencer la discussion…"
                />
              </label>
            </>
          )}
        </div>
        {isCard && (
          <aside className="creation-side">
            <EffortSelect engine={engine} value={aiEffort} onChange={setAiEffort} />
            <label>
              Statut
              <select aria-label="Statut" value={status} onChange={e => setStatus(e.target.value)}>
                <StatusOptions canLaunch={canLaunch} discussion={discussion} />
              </select>
            </label>
            <label>
              Priorité
              <select aria-label="Priorité" value={priority} onChange={e => setPriority(e.target.value)}>
                <PriorityOptions />
              </select>
            </label>
          </aside>
        )}
      </div>
      <div className="form-actions">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="secondary-button" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          onClick={submit}
          className="primary-button"
          disabled={uploading || !title.trim() || (isCard && !target)}
        >
          <Plus size={16} />
          {text.submit}
        </button>
      </div>
    </LocalForm>
  );
}
