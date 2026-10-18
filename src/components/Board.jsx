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
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import Status, { StatusOptions, priorities } from './Status.jsx';
import { cardLinks, isSystemCard } from '../lib/infos.js';
import { workBadge } from '../lib/use-work-status.js';
import { version as appVersion } from '../../package.json';
import { useProjectAccess } from '../lib/project-access.js';

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
        Tableau
        <span>
          {listCount} liste{listCount > 1 ? 's' : ''}
        </span>
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

function CardPreview({ card, color, system, followers, work, dragging, readOnly, onDragStart, onDragEnd, onOpen }) {
  const links = cardLinks(card);
  const badge = workBadge(work);
  // Carte du tableau : un article dont le titre est le bouton d’ouverture (étendu à toute la carte),
  // pour que les lecteurs d’écran annoncent son titre, ses étiquettes et son état séparément.
  const preview = (
    <article
      draggable={!readOnly}
      onDragStart={e => {
        onDragStart(card.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
      }}
      onDragEnd={onDragEnd}
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
      <h3>
        <button type="button" className="card-open" onClick={() => onOpen(card.id)}>
          {card.title}
        </button>
      </h3>
      <p>{card.description || 'Ajoutez un peu de contexte à cette idée…'}</p>
      {!system && <Status value={card.status} />}
      {badge && <span className={`work-badge ${badge.tone}`}>{badge.label}</span>}
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
    </article>
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

// Tableau d’un projet : recherche, filtre de statut, cartes et listes à glisser-déposer.
// `dragging` vaut { kind: 'card' | 'list', id } pendant un glisser-déposer.
export default function Board({
  project,
  followers,
  work = {},
  filters,
  onFilters,
  dragging,
  onDragging,
  onMoveCard,
  onMoveList = () => {},
  onOpenCard,
  onAddCard,
  onAddList,
  onEditList = () => {},
}) {
  const { readOnly } = useProjectAccess();
  // Liste survolée : { id, side } où side vaut 'before' ou 'after' quand on déplace une liste.
  const [dropList, setDropList] = useState(null);
  const draggedCard = dragging?.kind === 'card' ? dragging.id : null;
  const draggedList = dragging?.kind === 'list' ? dragging.id : null;
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
              : 'Glissez les cartes et les listes, ou déplacez-les depuis leur détail'}
        </span>
      </div>
      <div className="board" aria-label="Tableau du projet">
        {project.lists.map(list => {
          const cards = visible.filter(c => c.listId === list.id);
          return (
            <section
              key={list.id}
              className={[
                'list-column',
                draggedCard && dropList?.id === list.id && 'drag-over',
                draggedList === list.id && 'list-dragging',
                draggedList &&
                  draggedList !== list.id &&
                  dropList?.id === list.id &&
                  (dropList.side === 'after' ? 'drop-after' : 'drop-before'),
              ]
                .filter(Boolean)
                .join(' ')}
              onDragOver={e => {
                if (draggedCard) {
                  e.preventDefault();
                  setDropList({ id: list.id });
                } else if (draggedList) {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  const side = e.clientX < box.left + box.width / 2 ? 'before' : 'after';
                  if (dropList?.id !== list.id || dropList.side !== side) setDropList({ id: list.id, side });
                }
              }}
              onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget)) setDropList(null);
              }}
              onDrop={e => {
                e.preventDefault();
                if (draggedCard) onMoveCard(draggedCard, list.id);
                else if (draggedList && dropList?.id === list.id && draggedList !== list.id)
                  onMoveList(draggedList, list.id, dropList.side === 'after');
                endDrag();
              }}
            >
              <header
                className="list-header"
                draggable={!readOnly}
                title={readOnly ? undefined : 'Glissez pour déplacer la liste'}
                onDragStart={e => {
                  if (e.target !== e.currentTarget) return;
                  onDragging({ kind: 'list', id: list.id });
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', list.name);
                }}
                onDragEnd={endDrag}
              >
                <div>
                  <span className={`list-dot ${list.color}`} />
                  <h2>{list.name}</h2>
                  <span className="list-count">{cards.length}</span>
                </div>
                {!readOnly && (
                  <div className="list-actions">
                    <button
                      className="icon-button"
                      aria-label={`Modifier la liste ${list.name}`}
                      onClick={() => onEditList(list.id)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Ajouter une carte dans ${list.name}`}
                      onClick={() => onAddCard(list.id)}
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                )}
              </header>
              <div className="cards">
                {cards.map(card => (
                  <CardPreview
                    key={card.id}
                    card={card}
                    color={list.color}
                    system={isSystemCard(project.id, card.id)}
                    followers={followers[card.id] || []}
                    work={work[card.id]}
                    dragging={draggedCard === card.id}
                    readOnly={readOnly}
                    onDragStart={id => onDragging({ kind: 'card', id })}
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
