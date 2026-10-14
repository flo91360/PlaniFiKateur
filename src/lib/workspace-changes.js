// Modifications fines du tableau, partagées par le navigateur et le serveur.
// diffWorkspace décrit ce qu’une session a changé depuis l’état qu’elle a lu ;
// applyChanges rejoue ces modifications sur l’état le plus récent. Deux sessions qui
// modifient des projets, listes, cartes ou champs différents ne sont donc plus en conflit.
//
// Chaque modification est un objet { type, … } :
//   project.create { project }                    project.update { projectId, fields }
//   project.delete { projectId }                  project.order  { projectIds }
//   list.create    { projectId, list }            list.update    { projectId, listId, fields }
//   list.delete    { projectId, listId }          list.order     { projectId, listIds }
//   card.create    { projectId, card }            card.update    { projectId, cardId, fields }
//   card.delete    { projectId, cardId }          card.order     { projectId, cardIds }
//   comment.create { projectId, cardId, comment } comment.update { projectId, cardId, commentId, text }
//   comment.delete { projectId, cardId, commentId }
// Les champs gérés par le serveur (auteurs, dates, cartes Infos) ne se modifient pas ainsi.

export const PROJECT_FIELDS = ['name', 'description', 'emoji', 'color'];
export const LIST_FIELDS = ['name', 'color'];
export const CARD_FIELDS = [
  'listId',
  'title',
  'description',
  'status',
  'priority',
  'aiEffort',
  'tags',
  'checklist',
  'attachments',
];
export const CHANGE_TYPES = [
  'project.create',
  'project.update',
  'project.delete',
  'project.order',
  'list.create',
  'list.update',
  'list.delete',
  'list.order',
  'card.create',
  'card.update',
  'card.delete',
  'card.order',
  'comment.create',
  'comment.update',
  'comment.delete',
];

export class ChangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangeError';
  }
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const idsOf = items => items.map(item => item.id);
const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

const changedFields = (before, after, keys) => {
  const fields = {};
  for (const key of keys) if (!same(before[key], after[key])) fields[key] = after[key] ?? null;
  return Object.keys(fields).length ? fields : null;
};

function diffCards(before, after, changes) {
  const previous = new Map(before.cards.map(card => [card.id, card]));
  const kept = new Set(idsOf(after.cards));
  for (const card of before.cards)
    if (!kept.has(card.id)) changes.push({ type: 'card.delete', projectId: before.id, cardId: card.id });
  for (const card of after.cards) {
    const old = previous.get(card.id);
    if (!old) {
      changes.push({ type: 'card.create', projectId: after.id, card });
      continue;
    }
    const fields = changedFields(old, card, CARD_FIELDS);
    if (fields) changes.push({ type: 'card.update', projectId: after.id, cardId: card.id, fields });
    const oldComments = new Map(old.comments.map(comment => [comment.id, comment]));
    const keptComments = new Set(idsOf(card.comments));
    const target = { projectId: after.id, cardId: card.id };
    for (const comment of old.comments)
      if (!keptComments.has(comment.id)) changes.push({ type: 'comment.delete', ...target, commentId: comment.id });
    for (const comment of card.comments) {
      const oldComment = oldComments.get(comment.id);
      if (!oldComment) changes.push({ type: 'comment.create', ...target, comment });
      else if (oldComment.text !== comment.text)
        changes.push({ type: 'comment.update', ...target, commentId: comment.id, text: comment.text });
    }
  }
}

function diffLists(before, after, changes) {
  const previous = new Map(before.lists.map(list => [list.id, list]));
  const kept = new Set(idsOf(after.lists));
  for (const list of after.lists) {
    const old = previous.get(list.id);
    if (!old) changes.push({ type: 'list.create', projectId: after.id, list });
    else {
      const fields = changedFields(old, list, LIST_FIELDS);
      if (fields) changes.push({ type: 'list.update', projectId: after.id, listId: list.id, fields });
    }
  }
  return before.lists
    .filter(list => !kept.has(list.id))
    .map(list => ({ type: 'list.delete', projectId: before.id, listId: list.id }));
}

// Modifications qui transforment `before` en `after`. Les suppressions de listes viennent après
// les déplacements de cartes, et l’ordre n’est envoyé que s’il diffère du résultat attendu.
export function diffWorkspace(before, after) {
  const changes = [];
  const listDeletions = [];
  const previous = new Map(before.map(project => [project.id, project]));
  const kept = new Set(idsOf(after));
  for (const project of before)
    if (!kept.has(project.id)) changes.push({ type: 'project.delete', projectId: project.id });
  for (const project of after) {
    const old = previous.get(project.id);
    if (!old) {
      changes.push({ type: 'project.create', project });
      continue;
    }
    const fields = changedFields(old, project, PROJECT_FIELDS);
    if (fields) changes.push({ type: 'project.update', projectId: project.id, fields });
    listDeletions.push(...diffLists(old, project, changes));
    diffCards(old, project, changes);
  }
  changes.push(...listDeletions);
  const expected = applyChanges(before, changes).projects;
  if (!sameOrder(idsOf(expected), idsOf(after))) changes.push({ type: 'project.order', projectIds: idsOf(after) });
  for (const project of after) {
    const result = expected.find(item => item.id === project.id);
    if (!result || !previous.has(project.id)) continue;
    if (!sameOrder(idsOf(result.lists), idsOf(project.lists)))
      changes.push({ type: 'list.order', projectId: project.id, listIds: idsOf(project.lists) });
    if (!sameOrder(idsOf(result.cards), idsOf(project.cards)))
      changes.push({ type: 'card.order', projectId: project.id, cardIds: idsOf(project.cards) });
  }
  return changes;
}

// Les éléments cités dans `order` reprennent les places qu’ils occupent, dans l’ordre demandé ;
// ceux que la session ne connaissait pas (ajoutés ailleurs entre-temps) restent en place.
const reorder = (items, order) => {
  const present = new Set(idsOf(items));
  const wanted = [...new Set(order)].filter(id => present.has(id));
  const moved = new Set(wanted);
  const byId = new Map(items.map(item => [item.id, item]));
  let next = 0;
  return items.map(item => (moved.has(item.id) ? byId.get(wanted[next++]) : item));
};

const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChangeError(`${name} doit être un objet.`);
  return value;
};
const identifier = (value, name) => {
  if (typeof value !== 'string' || !value) throw new ChangeError(`${name} : identifiant attendu.`);
  return value;
};
const identifiers = (value, name) => {
  if (!Array.isArray(value) || value.length > 10000 || value.some(id => typeof id !== 'string'))
    throw new ChangeError(`${name} : liste d’identifiants attendue.`);
  return value;
};
const fieldsOf = (value, allowed) => {
  object(value, 'fields');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new ChangeError(`Champs non modifiables : ${unknown.join(', ')}.`);
  return value;
};
const merge = (item, fields) => {
  const next = { ...item };
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) delete next[key];
    else next[key] = value;
  }
  return next;
};

// Résultat d’une modification : nouvel état, ou raison pour laquelle elle ne s’applique pas.
const MISSING = 'missing',
  EXISTS = 'exists',
  NOT_EMPTY = 'not_empty';

function applyOne(projects, change) {
  object(change, 'Modification');
  if (!CHANGE_TYPES.includes(change.type)) throw new ChangeError('Type de modification inconnu.');
  const [kind, action] = change.type.split('.');
  if (kind === 'project') {
    if (action === 'create') {
      const project = object(change.project, 'project');
      identifier(project.id, 'project.id');
      if (projects.some(p => p.id === project.id)) return EXISTS;
      return [...projects, project];
    }
    if (action === 'order') return reorder(projects, identifiers(change.projectIds, 'projectIds'));
    const projectId = identifier(change.projectId, 'projectId');
    if (!projects.some(p => p.id === projectId)) return MISSING;
    if (action === 'delete') return projects.filter(p => p.id !== projectId);
    const fields = fieldsOf(change.fields, PROJECT_FIELDS);
    return projects.map(p => (p.id === projectId ? merge(p, fields) : p));
  }
  const projectId = identifier(change.projectId, 'projectId');
  const project = projects.find(p => p.id === projectId);
  if (!project) return MISSING;
  const replace = next => projects.map(p => (p.id === projectId ? next : p));
  if (kind === 'list') {
    if (action === 'create') {
      const list = object(change.list, 'list');
      identifier(list.id, 'list.id');
      if (project.lists.some(l => l.id === list.id)) return EXISTS;
      return replace({ ...project, lists: [...project.lists, list] });
    }
    if (action === 'order')
      return replace({ ...project, lists: reorder(project.lists, identifiers(change.listIds, 'listIds')) });
    const listId = identifier(change.listId, 'listId');
    if (!project.lists.some(l => l.id === listId)) return MISSING;
    if (action === 'delete') {
      if (project.cards.some(card => card.listId === listId)) return NOT_EMPTY;
      return replace({ ...project, lists: project.lists.filter(l => l.id !== listId) });
    }
    const fields = fieldsOf(change.fields, LIST_FIELDS);
    return replace({ ...project, lists: project.lists.map(l => (l.id === listId ? merge(l, fields) : l)) });
  }
  if (kind === 'card') {
    if (action === 'create') {
      const card = object(change.card, 'card');
      identifier(card.id, 'card.id');
      if (project.cards.some(c => c.id === card.id)) return EXISTS;
      return replace({ ...project, cards: [...project.cards, card] });
    }
    if (action === 'order')
      return replace({ ...project, cards: reorder(project.cards, identifiers(change.cardIds, 'cardIds')) });
    const cardId = identifier(change.cardId, 'cardId');
    if (!project.cards.some(c => c.id === cardId)) return MISSING;
    if (action === 'delete') return replace({ ...project, cards: project.cards.filter(c => c.id !== cardId) });
    const fields = fieldsOf(change.fields, CARD_FIELDS);
    return replace({ ...project, cards: project.cards.map(c => (c.id === cardId ? merge(c, fields) : c)) });
  }
  const cardId = identifier(change.cardId, 'cardId');
  const card = project.cards.find(c => c.id === cardId);
  if (!card) return MISSING;
  const replaceComments = comments =>
    replace({ ...project, cards: project.cards.map(c => (c.id === cardId ? { ...c, comments } : c)) });
  if (action === 'create') {
    const comment = object(change.comment, 'comment');
    identifier(comment.id, 'comment.id');
    if (card.comments.some(c => c.id === comment.id)) return EXISTS;
    // L’auteur et la date définitifs sont attribués par le serveur.
    return replaceComments([
      ...card.comments,
      {
        id: comment.id,
        author: comment.author || 'Vous',
        authorId: comment.authorId ?? null,
        text: comment.text,
        date: comment.date || new Date().toISOString(),
      },
    ]);
  }
  const commentId = identifier(change.commentId, 'commentId');
  if (!card.comments.some(c => c.id === commentId)) return MISSING;
  if (action === 'delete') return replaceComments(card.comments.filter(c => c.id !== commentId));
  if (typeof change.text !== 'string') throw new ChangeError('text : texte attendu.');
  return replaceComments(card.comments.map(c => (c.id === commentId ? { ...c, text: change.text } : c)));
}

// Applique les modifications dans l’ordre. Une modification dont la cible a disparu (ou qui
// recréerait un élément existant) est ignorée et signalée dans `skipped`.
export function applyChanges(projects, changes) {
  if (!Array.isArray(changes) || changes.length > 20000)
    throw new ChangeError('Une liste de modifications est requise.');
  let state = projects;
  const skipped = [];
  changes.forEach((change, index) => {
    const result = applyOne(state, change);
    if (typeof result === 'string') skipped.push({ index, type: change.type, reason: result });
    else state = result;
  });
  return { projects: state, skipped };
}
