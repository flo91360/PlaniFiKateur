import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Layers3,
  LayoutGrid,
  Lightbulb,
  ListFilter,
  MessageSquare,
  Plus,
  Search,
  X,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import Status, { StatusOptions, priorities } from './Status.jsx';
import { cardLinks } from '../lib/infos.js';
import { version as appVersion } from '../../package.json';

export const cardMatches = (card, { query, statusFilter }) =>
  (statusFilter === 'all' || card.status === statusFilter) &&
  `${card.title} ${card.description} ${card.tags.join(' ')}`
    .toLocaleLowerCase('fr')
    .includes(query.toLocaleLowerCase('fr').trim());

function Toolbar({ listCount, query, statusFilter, onQuery, onStatusFilter }) {
  return (
    <div className="board-toolbar">
      <div className="board-tab">
        <LayoutGrid size={16} />
        Tableau<span>{listCount} listes</span>
      </div>
      <div className="board-controls">
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="Rechercher une carte"
            placeholder="Rechercher une idée…"
            value={query}
            onChange={e => onQuery(e.target.value)}
          />
          {query && (
            <button aria-label="Effacer la recherche" onClick={() => onQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <label className="filter-field">
          <ListFilter size={16} />
          <select aria-label="Filtrer par statut" value={statusFilter} onChange={e => onStatusFilter(e.target.value)}>
            <option value="all">Tous les statuts</option>
            <StatusOptions />
          </select>
        </label>
      </div>
    </div>
  );
}

function Priority({ value }) {
  return (
    <span className={`priority ${value}`}>
      {value === 'high' ? (
        <ArrowUp size={12} />
      ) : value === 'low' ? (
        <ArrowDown size={12} />
      ) : (
        <span className="priority-lines">=</span>
      )}
      {priorities[value]}
    </span>
  );
}

function CardPreview({ card, color, followers, dragging, readOnly, onDragStart, onDragEnd, onOpen }) {
  const links = cardLinks(card);
  const preview = (
    <button
      draggable={!readOnly}
      onDragStart={e => {
        onDragStart(card.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(card.id)}
      className={`card ${dragging ? 'dragging' : ''} ${links.length ? 'with-link' : ''}`}
    >
      <div className="card-tags">
        {card.tags.map((tag, i) => (
          <span key={i} className={`tag ${color}`}>
            {tag}
          </span>
        ))}
        {!card.tags.length && <span className="untagged">Nouvelle idée</span>}
      </div>
      <h3>{card.title}</h3>
      <p>{card.description || 'Ajoutez un peu de contexte à cette idée…'}</p>
      <Status value={card.status} />
      <footer>
        <Priority value={card.priority} />
        <div className="card-meta">
          {card.comments.length > 0 && (
            <span>
              <MessageSquare size={13} />
              {card.comments.length}
            </span>
          )}
          <div className="card-followers-avatars" role="group" aria-label="Membres qui suivent cette carte">
            {followers.map(member => (
              <Avatar key={member.id} className="card-avatar" name={member.name} />
            ))}
          </div>
        </div>
      </footer>
    </button>
  );
  if (!links.length) return preview;
  return (
    <div className="card-group">
      {preview}
      {links.map(link => (
        <a key={link.href} className="card-link" href={link.href} target="_blank" rel="noreferrer">
          {link.label}
          <ArrowRight size={13} />
        </a>
      ))}
    </div>
  );
}

// Tableau d’un projet : recherche, filtre de statut et colonnes à glisser-déposer.
export default function Board({
  project,
  followers,
  filters,
  onFilters,
  dragging,
  onDragging,
  onMoveCard,
  onOpenCard,
  onAddCard,
  onAddList,
  readOnly = false,
}) {
  const [dropList, setDropList] = useState(null);
  const filtering = filters.query || filters.statusFilter !== 'all';
  const visible = project.cards.filter(card => cardMatches(card, filters));
  const endDrag = () => {
    onDragging(null);
    setDropList(null);
  };
  return (
    <>
      <Toolbar
        listCount={project.lists.length}
        query={filters.query}
        statusFilter={filters.statusFilter}
        onQuery={query => onFilters({ ...filters, query })}
        onStatusFilter={statusFilter => onFilters({ ...filters, statusFilter })}
      />
      <div className="board-caption">
        <span>Un projet, plusieurs pistes. À vous de les faire avancer.</span>
        <span>
          <span className="tiny-dot" />
          {filtering
            ? `${visible.length} carte${visible.length > 1 ? 's' : ''} trouvée${visible.length > 1 ? 's' : ''}`
            : readOnly
              ? 'Lecture seule sur ce projet'
              : 'Glissez les cartes pour les organiser'}
        </span>
      </div>
      <div className="board" aria-label="Tableau du projet">
        {project.lists.map(list => {
          const cards = visible.filter(c => c.listId === list.id);
          return (
            <section
              key={list.id}
              className={`list-column ${dropList === list.id ? 'drag-over' : ''}`}
              onDragOver={e => {
                if (dragging) {
                  e.preventDefault();
                  setDropList(list.id);
                }
              }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget)) setDropList(null);
              }}
              onDrop={e => {
                e.preventDefault();
                if (dragging) onMoveCard(dragging, list.id);
                endDrag();
              }}
            >
              <header className="list-header">
                <div>
                  <span className={`list-dot ${list.color}`} />
                  <h2>{list.name}</h2>
                  <span className="list-count">{cards.length}</span>
                </div>
                {!readOnly && (
                  <button
                    className="icon-button"
                    aria-label={`Ajouter une carte dans ${list.name}`}
                    onClick={() => onAddCard(list.id)}
                  >
                    <Plus size={17} />
                  </button>
                )}
              </header>
              <div className="cards">
                {cards.map(card => (
                  <CardPreview
                    key={card.id}
                    card={card}
                    color={list.color}
                    followers={followers[card.id] || []}
                    dragging={dragging === card.id}
                    readOnly={readOnly}
                    onDragStart={onDragging}
                    onDragEnd={endDrag}
                    onOpen={onOpenCard}
                  />
                ))}
                {!cards.length && (
                  <div className="empty-list">
                    <Lightbulb size={22} />
                    <p>{filtering ? 'Aucune carte ne correspond' : 'Une nouvelle piste commence ici'}</p>
                  </div>
                )}
              </div>
              {!readOnly && (
                <button className="add-card" onClick={() => onAddCard(list.id)}>
                  <Plus size={16} />
                  Ajouter une carte
                </button>
              )}
            </section>
          );
        })}
        {!readOnly && (
          <button className="add-list" onClick={onAddList}>
            <Plus size={17} />
            Ajouter une liste
          </button>
        )}
      </div>
      <footer className="board-footer">
        <span>
          <Layers3 size={14} />
          Un esprit libre. Des idées bien rangées.
        </span>
        <span>PlaniFiKateur · v{appVersion}</span>
      </footer>
    </>
  );
}
