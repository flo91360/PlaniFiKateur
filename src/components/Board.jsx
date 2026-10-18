import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  Layers3,
  LayoutGrid,
  Lightbulb,
  ListChecks,
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

// Le tableau montre les cartes actives, ou seulement les cartes archivées (`archived`).
export const cardMatches = (card, { query, statusFilter, archived = false }) =>
  !!card.archived === archived &&
  (statusFilter === 'all' || card.status === statusFilter) &&
  `${card.title} ${card.description} ${card.tags.join(' ')}`
    .toLocaleLowerCase('fr')
    .includes(query.toLocaleLowerCase('fr').trim());

// Échéance au format court (« 18 oct. ») ; `late` si elle est passée pour une carte non terminée.
const today = () => new Date().toLocaleDateString('sv');
export const dueLabel = date =>
  new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const isLate = card => !!card.dueDate && card.dueDate < today() && card.status !== 'done';

function Toolbar({ listCount, query, statusFilter, archived, archivedCount, onQuery, onStatusFilter, onArchived }) {
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
        {(archived || archivedCount > 0) && (
          <button
            type="button"
            className={`secondary-button archive-toggle ${archived ? 'active' : ''}`}
            aria-pressed={archived}
            onClick={() => onArchived(!archived)}
          >
            <Archive size={15} />
            {archived ? 'Revenir au tableau' : `Archivées (${archivedCount})`}
          </button>
        )}
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

function CardPreview({
  card,
  color,
  system,
  assignee,
  followers,
  work,
  dragging,
  dropBefore,
  readOnly,
  onDragStart,
  onDragEnd,
  onOpen,
}) {
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
      data-card-id={card.id}
      className={`card ${dragging ? 'dragging' : ''} ${dropBefore ? 'drop-before' : ''} ${links.length ? 'with-link' : ''}`}
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
          {card.dueDate && (
            <span
              className={`card-due ${isLate(card) ? 'late' : ''}`}
              aria-label={`Échéance : ${dueLabel(card.dueDate)}${isLate(card) ? ' (dépassée)' : ''}`}
            >
              <CalendarDays size={13} />
              {dueLabel(card.dueDate)}
            </span>
          )}
          {card.checklist.length > 0 && (
            <span
              className={card.checklist.every(item => item.done) ? 'checklist-complete' : ''}
              aria-label={`Liste de contrôle : ${card.checklist.filter(item => item.done).length} sur ${card.checklist.length}`}
            >
              <ListChecks size={13} />
              {card.checklist.filter(item => item.done).length}/{card.checklist.length}
            </span>
          )}
          {card.comments.length > 0 && (
            <span>
              <MessageSquare size={13} />
              {card.comments.length}
            </span>
          )}
          {assignee && (
            <span className="card-assignee" title={`Responsable : ${assignee.name}`}>
              <Avatar className="card-avatar assignee" name={assignee.name} />
              <span className="sr-only">Responsable : {assignee.name}</span>
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

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;

// Tableau d’un projet : recherche, filtre de statut, cartes et listes à glisser-déposer.
// `dragging` vaut { kind: 'card' | 'list', id } pendant un glisser-déposer.
// Barre de défilement horizontale collée au bas de l’écran : la barre native du tableau n’apparaît
// qu’après ses cartes, souvent hors de vue. Cette copie reste visible tant que le tableau l’est
// et défile en même temps que lui.
function useStickyScrollbar() {
  const boardRef = useRef(null);
  const barRef = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const board = boardRef.current;
    const bar = barRef.current;
    if (!board || !bar) return undefined;
    const measure = () => setWidth(board.scrollWidth > board.clientWidth + 1 ? board.scrollWidth : 0);
    const follow = (from, to) => () => {
      if (Math.abs(to.scrollLeft - from.scrollLeft) > 1) to.scrollLeft = from.scrollLeft;
    };
    const onBoard = follow(board, bar);
    const onBar = follow(bar, board);
    board.addEventListener('scroll', onBoard, { passive: true });
    bar.addEventListener('scroll', onBar, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(board);
    for (const child of board.children) observer?.observe(child);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      board.removeEventListener('scroll', onBoard);
      bar.removeEventListener('scroll', onBar);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
  useEffect(() => {
    if (width && barRef.current && boardRef.current) barRef.current.scrollLeft = boardRef.current.scrollLeft;
  }, [width]);
  return { boardRef, barRef, width };
}

export default function Board({
  project,
  members = [],
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
  const scrollbar = useStickyScrollbar();
  // Liste survolée : { id, side } où side vaut 'before' ou 'after' quand on déplace une liste ;
  // { id, beforeId } quand on déplace une carte, déposée avant la carte `beforeId` (null : en fin de liste).
  const [dropList, setDropList] = useState(null);
  const draggedCard = dragging?.kind === 'card' ? dragging.id : null;
  const draggedList = dragging?.kind === 'list' ? dragging.id : null;
  const filtering = filters.query || filters.statusFilter !== 'all';
  const archived = !!filters.archived;
  const archivedCount = project.cards.filter(card => card.archived).length;
  const visible = project.cards.filter(card => cardMatches(card, filters));
  const memberById = new Map(members.map(member => [member.id, member]));
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
        archived={archived}
        archivedCount={archivedCount}
        onQuery={query => onFilters({ ...filters, query })}
        onStatusFilter={statusFilter => onFilters({ ...filters, statusFilter })}
        onArchived={value => onFilters({ ...filters, archived: value })}
      />
      <div className="board-caption">
        <span>
          {archived
            ? `${archivedCount} ${archivedCount > 1 ? 'cartes archivées' : 'carte archivée'} : ouvrez-en une pour la restaurer`
            : `${plural(project.lists.length, 'liste')} · ${plural(project.cards.length - archivedCount, 'carte')}`}
        </span>
        <span>
          <span className="tiny-dot" />
          {filtering
            ? `${visible.length} carte${visible.length > 1 ? 's' : ''} trouvée${visible.length > 1 ? 's' : ''}`
            : readOnly
              ? 'Lecture seule sur ce projet'
              : 'Glissez les cartes et les listes, ou déplacez-les depuis leur détail'}
        </span>
      </div>
      <div className="board" aria-label="Tableau du projet" ref={scrollbar.boardRef}>
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
                  // Carte survolée : dépôt avant elle si le pointeur est sur sa moitié haute, après sinon.
                  // Entre deux cartes, l’emplacement précédent est conservé ; sur l’en-tête ou le bas
                  // de la liste, la carte va en fin de liste.
                  const over = e.target.closest?.('[data-card-id]');
                  const between = !over && !!e.target.closest?.('.cards');
                  let beforeId = between && dropList?.id === list.id ? dropList.beforeId : null;
                  if (over && e.currentTarget.contains(over)) {
                    const siblings = cards.filter(card => card.id !== draggedCard);
                    const index = siblings.findIndex(card => card.id === over.dataset.cardId);
                    const box = over.getBoundingClientRect();
                    if (index >= 0)
                      beforeId =
                        e.clientY < box.top + box.height / 2 ? siblings[index].id : siblings[index + 1]?.id || null;
                    else beforeId = dropList?.beforeId ?? null;
                  }
                  if (dropList?.id !== list.id || dropList.beforeId !== beforeId)
                    setDropList({ id: list.id, beforeId });
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
                if (draggedCard) onMoveCard(draggedCard, list.id, dropList?.id === list.id ? dropList.beforeId : null);
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
                    assignee={card.assigneeId ? memberById.get(card.assigneeId) || { name: 'Ancien membre' } : null}
                    followers={followers[card.id] || []}
                    work={work[card.id]}
                    dragging={draggedCard === card.id}
                    dropBefore={!!draggedCard && dropList?.id === list.id && dropList.beforeId === card.id}
                    readOnly={readOnly}
                    onDragStart={id => onDragging({ kind: 'card', id })}
                    onDragEnd={endDrag}
                    onOpen={onOpenCard}
                  />
                ))}
                {!cards.length && (
                  <div className="empty-list">
                    <Lightbulb size={22} />
                    <p>{filtering ? 'Aucune carte ne correspond' : 'Aucune carte dans cette liste'}</p>
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
      <div className="board-scrollbar" ref={scrollbar.barRef} hidden={!scrollbar.width} aria-hidden="true">
        <div style={{ width: scrollbar.width }} />
      </div>
      <footer className="board-footer">
        <span>
          <Layers3 size={14} />
          {project.name}
        </span>
        <span>PlaniFiKateur · v{appVersion}</span>
      </footer>
    </>
  );
}
