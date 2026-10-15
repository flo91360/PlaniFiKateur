const who = actor => (actor ? { id: actor.id, name: actor.name } : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Comparaison d’un champ de carte sans sérialiser les pièces jointes (base64) ni les discussions.
const sameField = (key, a, b) => {
  if (key === 'comments')
    return a.length === b.length && a.every((comment, i) => comment.id === b[i].id && comment.text === b[i].text);
  if (key === 'attachments') {
    a ??= [];
    b ??= [];
    return (
      a.length === b.length &&
      a.every(
        (file, i) =>
          file.id === b[i].id &&
          file.name === b[i].name &&
          file.type === b[i].type &&
          file.size === b[i].size &&
          file.data === b[i].data,
      )
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  return same(a, b);
};
const CARD_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'listId',
  'tags',
  'checklist',
  'comments',
  'attachments',
  'aiEffort',
];
export function attributeChanges(before, after, actor, date) {
  const events = [];
  const emit = (action, p, card, details = {}) => {
    const participants = card ? [card.createdBy?.id, ...(card.comments || []).map(c => c.authorId)] : [];
    events.push({
      action,
      projectId: p.id,
      projectName: p.name,
      cardId: card?.id || null,
      cardTitle: card?.title || null,
      details,
      recipientIds: [...new Set(participants.filter(id => id && id !== actor?.id))],
    });
  };
  const oldProjects = new Map(before.map(p => [p.id, p]));
  const oldCards = new Map(before.flatMap(p => p.cards.map(c => [c.id, { card: c, projectId: p.id }])));
  for (const p of after) {
    const old = oldProjects.get(p.id);
    if (!old) emit('project.created', p);
    else if (!same([old.name, old.description, old.emoji, old.color], [p.name, p.description, p.emoji, p.color]))
      emit('project.updated', p);
    const oldLists = new Map((old?.lists || []).map(l => [l.id, l]));
    const lists = new Set(p.lists.map(l => l.id));
    for (const list of p.lists) {
      const previous = oldLists.get(list.id);
      if (!previous) emit('list.created', p, null, { name: list.name, listId: list.id });
      else if (!same(previous, list)) emit('list.updated', p, null, { name: list.name, listId: list.id });
    }
    for (const list of old?.lists || [])
      if (!lists.has(list.id)) emit('list.deleted', p, null, { name: list.name, listId: list.id });
    for (const card of p.cards) {
      const previous = oldCards.get(card.id)?.card;
      if (previous && oldCards.get(card.id).projectId !== p.id)
        emit('card.project_changed', p, previous, { from: oldCards.get(card.id).projectId, to: p.id });
      card.createdBy = previous?.createdBy || (previous ? null : who(actor));
      card.createdAt = previous?.createdAt || (previous ? null : date);
      card.updatedBy = previous?.updatedBy || null;
      card.updatedAt = previous?.updatedAt || null;
      const oldComments = new Map((previous?.comments || []).map(c => [c.id, c]));
      for (const comment of card.comments) {
        const oldComment = oldComments.get(comment.id);
        if (oldComment) {
          comment.author = oldComment.author;
          comment.authorId = oldComment.authorId || null;
          if (oldComment.authorKind) comment.authorKind = oldComment.authorKind;
          else delete comment.authorKind;
          comment.date = oldComment.date;
        } else {
          comment.author = actor?.name || 'Administration';
          comment.authorId = actor?.id || null;
          comment.authorKind = actor ? 'user' : 'system';
          comment.date = date;
        }
      }
      if (!previous) {
        card.updatedBy = who(actor);
        card.updatedAt = date;
        emit('card.created', p, card);
      } else {
        const fields = CARD_FIELDS.filter(key => !sameField(key, previous[key], card[key]));
        if (fields.length) {
          card.updatedBy = who(actor);
          card.updatedAt = date;
          emit('card.updated', p, card, { fields });
          if (fields.includes('status'))
            emit('card.status_changed', p, card, { from: previous.status, to: card.status });
          if (fields.includes('listId')) emit('card.moved', p, card, { from: previous.listId, to: card.listId });
        }
      }
      const comments = new Set(card.comments.map(c => c.id));
      for (const comment of card.comments) {
        const previousComment = oldComments.get(comment.id);
        if (!previousComment) emit('comment.created', p, card, { commentId: comment.id });
        else if (previousComment.text !== comment.text) emit('comment.updated', p, card, { commentId: comment.id });
      }
      for (const comment of previous?.comments || [])
        if (!comments.has(comment.id)) emit('comment.deleted', p, card, { commentId: comment.id });
    }
    const cards = new Set(p.cards.map(c => c.id));
    for (const card of old?.cards || []) if (!cards.has(card.id)) emit('card.deleted', p, card);
  }
  const projects = new Set(after.map(p => p.id));
  for (const p of before)
    if (!projects.has(p.id)) {
      emit('project.deleted', p);
      for (const card of p.cards) emit('card.deleted', p, card);
    }
  return events;
}
