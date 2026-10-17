import React, { useState } from 'react';
import LocalForm from './LocalForm.jsx';
import { useUnsavedChanges } from './Dialog.jsx';

const LIST_COLORS = { green: 'Vert', purple: 'Violet', orange: 'Orange' };

// Réglages d’une liste : nom, couleur, place dans le tableau et suppression (liste vide seulement).
export function ListSettings({ list, cardCount, index, count, onSave, onMove, onDelete, onClose }) {
  const [name, setName] = useState(list.name),
    [color, setColor] = useState(list.color);
  useUnsavedChanges(name !== list.name || color !== list.color);
  const save = () => {
    if (!name.trim()) return;
    onSave({ name: name.trim(), color });
    onClose();
  };
  return (
    <LocalForm className="creation-form" onConfirm={save}>
      <label>
        Nom de la liste
        <input value={name} maxLength={140} onChange={e => setName(e.target.value)} required />
      </label>
      <label>
        Couleur
        <select value={color} onChange={e => setColor(e.target.value)}>
          {Object.entries(LIST_COLORS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="detail-order" role="group" aria-label="Place de la liste dans le tableau">
        <button type="button" className="secondary-button" disabled={index === 0} onClick={() => onMove(-1)}>
          Vers la gauche
        </button>
        <span>
          {index + 1} / {count}
        </span>
        <button type="button" className="secondary-button" disabled={index === count - 1} onClick={() => onMove(1)}>
          Vers la droite
        </button>
      </div>
      <p className="muted">
        {cardCount
          ? `Déplacez ou supprimez d’abord ${cardCount === 1 ? 'la carte' : `les ${cardCount} cartes`} de cette liste pour pouvoir la supprimer.`
          : 'Cette liste est vide : elle peut être supprimée.'}
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="delete-button"
          disabled={cardCount > 0}
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          Supprimer la liste
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" onClick={save} className="primary-button" disabled={!name.trim()}>
          Enregistrer la liste
        </button>
      </div>
    </LocalForm>
  );
}

// Nom, description, symbole et couleur du projet (responsables).
export function ProjectDetailsForm({ project, onSave, onClose }) {
  const [name, setName] = useState(project.name),
    [description, setDescription] = useState(project.description),
    [emoji, setEmoji] = useState(project.emoji),
    [color, setColor] = useState(project.color.length === 4 ? expand(project.color) : project.color);
  useUnsavedChanges(
    name !== project.name ||
      description !== project.description ||
      emoji !== project.emoji ||
      color !== (project.color.length === 4 ? expand(project.color) : project.color),
  );
  const save = () => {
    if (!name.trim() || !emoji.trim()) return;
    onSave({ name: name.trim(), description: description.trim(), emoji: emoji.trim(), color });
    onClose();
  };
  return (
    <LocalForm className="creation-form" onConfirm={save}>
      <label>
        Nom du projet
        <input value={name} maxLength={140} onChange={e => setName(e.target.value)} required />
      </label>
      <label>
        Description
        <textarea rows={3} value={description} maxLength={20000} onChange={e => setDescription(e.target.value)} />
      </label>
      <label>
        Symbole
        <input value={emoji} maxLength={16} onChange={e => setEmoji(e.target.value)} required />
      </label>
      <label>
        Couleur
        <input type="color" value={color} onChange={e => setColor(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" onClick={save} className="primary-button" disabled={!name.trim() || !emoji.trim()}>
          Enregistrer le projet
        </button>
      </div>
    </LocalForm>
  );
}

// #abc → #aabbcc : le sélecteur de couleur n’accepte que la forme longue.
const expand = color => `#${[...color.slice(1)].map(c => c + c).join('')}`;
