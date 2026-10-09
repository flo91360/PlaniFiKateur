export const STATUSES = ['draft', 'ready', 'progress', 'clarify', 'review', 'done'];
const priorities = ['low', 'normal', 'high'];

export function validateWorkspace(projects) {
  if (!Array.isArray(projects)) throw new Error('Une liste de projets est requise.');
  const ids = new Set();
  const fail = message => { throw new Error(message); };
  const object = (value, path) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} doit être un objet.`); };
  const text = (value, path, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${path} : texte invalide (maximum ${max} caractères).`);
    return value;
  };
  const id = (value, path) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) || ids.has(value)) fail(`${path} : identifiant invalide ou déjà utilisé.`);
    ids.add(value);
    return value;
  };
  const array = (value, path, max) => { if (!Array.isArray(value) || value.length > max) fail(`${path} : liste invalide (maximum ${max} éléments).`); return value; };
  return array(projects, 'projects', 100).map((p, i) => {
    const path = `projects[${i}]`;
    object(p, path);
    const projectId = id(p.id, `${path}.id`);
    if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(p.color)) fail(`${path}.color : couleur hexadécimale attendue.`);
    const lists = array(p.lists, `${path}.lists`, 100).map(l => {
      object(l, `${path}.lists`);
      if (!['green', 'purple', 'orange'].includes(l.color)) fail(`${path}.lists.color : couleur inconnue.`);
      return { id: id(l.id, `${path}.lists.id`), name: text(l.name, `${path}.lists.name`, 140, true), color: l.color };
    });
    const listIds = new Set(lists.map(l => l.id));
    const cards = array(p.cards, `${path}.cards`, 5000).map(c => {
      object(c, `${path}.cards`);
      if (!listIds.has(c.listId)) fail(`${path}.cards.listId : liste inexistante.`);
      if (!STATUSES.includes(c.status) || !priorities.includes(c.priority)) fail(`${path}.cards : statut ou priorité inconnus.`);
      return {
        id: id(c.id, `${path}.cards.id`), listId: c.listId,
        title: text(c.title, `${path}.cards.title`, 140, true), description: text(c.description, `${path}.cards.description`, 20000),
        status: c.status, priority: c.priority,
        tags: array(c.tags, `${path}.cards.tags`, 50).map(tag => text(tag, 'tag', 140, true)),
        checklist: array(c.checklist, `${path}.cards.checklist`, 500).map(item => {
          object(item, 'criterion');
          if (typeof item.done !== 'boolean') fail('criterion.done : booléen attendu.');
          return { id: id(item.id, 'criterion.id'), text: text(item.text, 'criterion.text', 2000, true), done: item.done };
        }),
        comments: array(c.comments, `${path}.cards.comments`, 1000).map(comment => {
          object(comment, 'comment');
          if (typeof comment.date !== 'string' || !Number.isFinite(Date.parse(comment.date))) fail('comment.date : date invalide.');
          return { id: id(comment.id, 'comment.id'), author: text(comment.author, 'comment.author', 140, true), text: text(comment.text, 'comment.text', 10000, true), date: comment.date };
        }),
      };
    });
    return { id: projectId, name: text(p.name, `${path}.name`, 140, true), description: text(p.description, `${path}.description`, 20000), emoji: text(p.emoji, `${path}.emoji`, 16, true), color: p.color, lists, cards };
  });
}
