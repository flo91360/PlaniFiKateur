export const STATUSES = ['draft', 'ready', 'progress', 'clarify', 'review', 'flo', 'done'];
import { efforts } from '../../worker/ai-settings.mjs';
import { validateDriveRelease } from './drive-release.js';
const priorities = ['low', 'normal', 'high'];
// Pièces jointes : par fichier, par carte et par projet (un projet chargé ne bloque pas les autres).
export const ATTACHMENT_LIMITS = Object.freeze({
  files: 10,
  file: 1024 * 1024,
  card: 2 * 1024 * 1024,
  project: 20 * 1024 * 1024,
});

// `attachmentData: false` accepte les pièces jointes sans contenu : c’est ainsi que le serveur
// envoie le tableau au navigateur (le contenu se télécharge par sa route).
export function validateWorkspace(projects, { attachmentData = true } = {}) {
  if (!Array.isArray(projects)) throw new Error('Une liste de projets est requise.');
  const ids = new Set();
  const fail = message => {
    throw new Error(message);
  };
  const object = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} doit être un objet.`);
  };
  const text = (value, path, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
      fail(`${path} : texte invalide (maximum ${max} caractères).`);
    return value;
  };
  const id = (value, path) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) || ids.has(value))
      fail(`${path} : identifiant invalide ou déjà utilisé.`);
    ids.add(value);
    return value;
  };
  const identity = value => {
    if (value == null) return null;
    object(value, 'auteur');
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.id)) fail('Auteur invalide.');
    return { id: value.id, name: text(value.name, 'auteur.name', 80, true) };
  };
  const repository = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value))
      fail('Dépôt du mode d’emploi ou du changelog invalide.');
    return value;
  };
  const date = value => {
    if (value == null) return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Date invalide.');
    return value;
  };
  const array = (value, path, max) => {
    if (!Array.isArray(value) || value.length > max) fail(`${path} : liste invalide (maximum ${max} éléments).`);
    return value;
  };
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
    let projectBytes = 0;
    const cards = array(p.cards, `${path}.cards`, 5000).map(c => {
      let cardBytes = 0;
      object(c, `${path}.cards`);
      if (!listIds.has(c.listId)) fail(`${path}.cards.listId : liste inexistante.`);
      if (!STATUSES.includes(c.status) || !priorities.includes(c.priority))
        fail(`${path}.cards : statut ou priorité inconnus.`);
      if (c.aiEffort != null && !efforts.codex.includes(c.aiEffort)) fail('Effort IA invalide.');
      return {
        id: id(c.id, `${path}.cards.id`),
        listId: c.listId,
        createdBy: identity(c.createdBy),
        createdAt: date(c.createdAt),
        updatedBy: identity(c.updatedBy),
        updatedAt: date(c.updatedAt),
        title: text(c.title, `${path}.cards.title`, 140, true),
        description: text(c.description, `${path}.cards.description`, 20000),
        status: c.status,
        priority: c.priority,
        ...(c.aiEffort ? { aiEffort: c.aiEffort } : {}),
        ...(c.readme ? { readme: repository(c.readme) } : {}),
        ...(c.changelog ? { changelog: repository(c.changelog) } : {}),
        ...(c.downloads
          ? { downloads: validateDriveRelease(c.downloads, c.downloads.repository, c.downloads.version) }
          : {}),
        attachments: array(c.attachments ?? [], 'attachments', ATTACHMENT_LIMITS.files).map(a => {
          object(a, 'attachment');
          const attachmentId = id(a.id, 'attachment.id');
          const name = text(a.name, 'attachment.name', 255, true);
          if (/[\x00-\x1f\x7f/\\]/.test(name)) fail('Nom de pièce jointe invalide.');
          if (!Number.isInteger(a.size) || a.size < 1 || a.size > ATTACHMENT_LIMITS.file)
            fail('Chaque fichier doit peser entre 1 octet et 1 Mo.');
          const data =
            !attachmentData && a.data === undefined ? undefined : text(a.data, 'attachment.data', 1398104, true);
          if (
            data !== undefined &&
            (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
              data.length % 4 !== 0 ||
              (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) !== a.size)
          )
            fail('Contenu de pièce jointe invalide.');
          cardBytes += a.size;
          projectBytes += a.size;
          if (cardBytes > ATTACHMENT_LIMITS.card) fail('Les pièces jointes d’une carte ne peuvent dépasser 2 Mo.');
          if (projectBytes > ATTACHMENT_LIMITS.project)
            fail('Les pièces jointes d’un projet ne peuvent dépasser 20 Mo.');
          const type = text(a.type, 'attachment.type', 100, true);
          if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(type)) fail('Type de pièce jointe invalide.');
          return { id: attachmentId, name, type, size: a.size, ...(data === undefined ? {} : { data }) };
        }),
        tags: array(c.tags, `${path}.cards.tags`, 50).map(tag => text(tag, 'tag', 140, true)),
        checklist: array(c.checklist, `${path}.cards.checklist`, 500).map(item => {
          object(item, 'criterion');
          if (typeof item.done !== 'boolean') fail('criterion.done : booléen attendu.');
          return {
            id: id(item.id, 'criterion.id'),
            text: text(item.text, 'criterion.text', 2000, true),
            done: item.done,
          };
        }),
        comments: array(c.comments, `${path}.cards.comments`, 1000).map(comment => {
          object(comment, 'comment');
          if (typeof comment.date !== 'string' || !Number.isFinite(Date.parse(comment.date)))
            fail('comment.date : date invalide.');
          if (comment.authorKind != null && !['user', 'agent', 'system'].includes(comment.authorKind))
            fail('comment.authorKind : type d’auteur invalide.');
          return {
            id: id(comment.id, 'comment.id'),
            author: text(comment.author, 'comment.author', 140, true),
            authorId: comment.authorId == null ? null : text(comment.authorId, 'comment.authorId', 128, true),
            ...(comment.authorKind ? { authorKind: comment.authorKind } : {}),
            text: text(comment.text, 'comment.text', 10000, true),
            date: comment.date,
          };
        }),
      };
    });
    return {
      id: projectId,
      name: text(p.name, `${path}.name`, 140, true),
      description: text(p.description, `${path}.description`, 20000),
      emoji: text(p.emoji, `${path}.emoji`, 16, true),
      color: p.color,
      lists,
      cards,
    };
  });
}
