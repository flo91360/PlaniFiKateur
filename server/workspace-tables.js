import { validateWorkspace } from '../src/lib/workspace.js';

// Tableau stocké en tables : projets, listes, cartes, commentaires et pièces jointes.
// readWorkspace reconstitue la liste de projets dans la forme exacte produite par
// validateWorkspace (mêmes clés, même ordre) ; writeWorkspace n’écrit que les lignes
// modifiées, ajoutées ou supprimées.
export const WORKSPACE_TABLES = `
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, emoji TEXT NOT NULL, color TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, list_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, ai_effort TEXT, tags TEXT NOT NULL, checklist TEXT NOT NULL, created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT, infos TEXT);
  CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, position INTEGER NOT NULL, author TEXT NOT NULL, author_id TEXT, author_kind TEXT, text TEXT NOT NULL, date TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS lists_project ON lists(project_id, position);
  CREATE INDEX IF NOT EXISTS cards_project ON cards(project_id, position);
  CREATE INDEX IF NOT EXISTS comments_card ON comments(card_id, position);
  CREATE INDEX IF NOT EXISTS attachments_card ON attachments(card_id, position);`;

// Version du schéma (PRAGMA user_version) à partir de laquelle le tableau est en tables.
export const TABLES_VERSION = 1;

const json = value => (value == null ? null : JSON.stringify(value));
const parse = value => (value == null ? null : JSON.parse(value));
const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
};

// `projectId` limite la lecture à un projet ; sans `attachmentData`, les pièces jointes n’ont que
// leur nom, leur type et leur taille (le contenu se télécharge par sa propre route).
export function readWorkspace(db, { projectId = null, attachmentData = true } = {}) {
  const one = projectId !== null;
  const cardsOf = one ? 'WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?)' : '';
  const params = one ? [projectId] : [];
  const lists = groupBy(
    db.prepare(`SELECT * FROM lists ${one ? 'WHERE project_id = ?' : ''} ORDER BY project_id, position`).all(...params),
    'project_id',
  );
  const cards = groupBy(
    db.prepare(`SELECT * FROM cards ${one ? 'WHERE project_id = ?' : ''} ORDER BY project_id, position`).all(...params),
    'project_id',
  );
  const comments = groupBy(
    db.prepare(`SELECT * FROM comments ${cardsOf} ORDER BY card_id, position`).all(...params),
    'card_id',
  );
  const attachments = groupBy(
    db
      .prepare(
        `SELECT id, card_id, position, name, type, size${attachmentData ? ', data' : ''} FROM attachments ${cardsOf} ORDER BY card_id, position`,
      )
      .all(...params),
    'card_id',
  );
  return db
    .prepare(`SELECT * FROM projects ${one ? 'WHERE id = ?' : ''} ORDER BY position`)
    .all(...params)
    .map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      emoji: p.emoji,
      color: p.color,
      lists: (lists.get(p.id) || []).map(l => ({ id: l.id, name: l.name, color: l.color })),
      cards: (cards.get(p.id) || []).map(c => {
        const infos = parse(c.infos) || {};
        return {
          id: c.id,
          listId: c.list_id,
          createdBy: parse(c.created_by),
          createdAt: c.created_at,
          updatedBy: parse(c.updated_by),
          updatedAt: c.updated_at,
          title: c.title,
          description: c.description,
          status: c.status,
          priority: c.priority,
          ...(c.ai_effort ? { aiEffort: c.ai_effort } : {}),
          ...(infos.readme ? { readme: infos.readme } : {}),
          ...(infos.changelog ? { changelog: infos.changelog } : {}),
          ...(infos.downloads ? { downloads: infos.downloads } : {}),
          attachments: (attachments.get(c.id) || []).map(a => ({
            id: a.id,
            name: a.name,
            type: a.type,
            size: a.size,
            ...(attachmentData ? { data: a.data } : {}),
          })),
          tags: JSON.parse(c.tags),
          checklist: JSON.parse(c.checklist),
          comments: (comments.get(c.id) || []).map(comment => ({
            id: comment.id,
            author: comment.author,
            authorId: comment.author_id,
            ...(comment.author_kind ? { authorKind: comment.author_kind } : {}),
            text: comment.text,
            date: comment.date,
          })),
        };
      }),
    }));
}

// Lignes attendues pour chaque table, dans l’ordre des colonnes du schéma.
function rowsOf(projects) {
  const rows = { projects: [], lists: [], cards: [], comments: [], attachments: [] };
  projects.forEach((p, position) => {
    rows.projects.push([p.id, position, p.name, p.description, p.emoji, p.color]);
    p.lists.forEach((l, index) => rows.lists.push([l.id, p.id, index, l.name, l.color]));
    p.cards.forEach((c, index) => {
      const infos = {
        ...(c.readme ? { readme: c.readme } : {}),
        ...(c.changelog ? { changelog: c.changelog } : {}),
        ...(c.downloads ? { downloads: c.downloads } : {}),
      };
      rows.cards.push([
        c.id,
        p.id,
        c.listId,
        index,
        c.title,
        c.description,
        c.status,
        c.priority,
        c.aiEffort || null,
        JSON.stringify(c.tags),
        JSON.stringify(c.checklist),
        json(c.createdBy),
        c.createdAt ?? null,
        json(c.updatedBy),
        c.updatedAt ?? null,
        Object.keys(infos).length ? JSON.stringify(infos) : null,
      ]);
      (c.comments || []).forEach((comment, order) =>
        rows.comments.push([
          comment.id,
          c.id,
          order,
          comment.author,
          comment.authorId ?? null,
          comment.authorKind ?? null,
          comment.text,
          comment.date,
        ]),
      );
      (c.attachments || []).forEach((a, order) =>
        rows.attachments.push([a.id, c.id, order, a.name, a.type, a.size, a.data]),
      );
    });
  });
  return rows;
}

const COLUMNS = {
  projects: ['id', 'position', 'name', 'description', 'emoji', 'color'],
  lists: ['id', 'project_id', 'position', 'name', 'color'],
  cards: [
    'id',
    'project_id',
    'list_id',
    'position',
    'title',
    'description',
    'status',
    'priority',
    'ai_effort',
    'tags',
    'checklist',
    'created_by',
    'created_at',
    'updated_by',
    'updated_at',
    'infos',
  ],
  comments: ['id', 'card_id', 'position', 'author', 'author_id', 'author_kind', 'text', 'date'],
  attachments: ['id', 'card_id', 'position', 'name', 'type', 'size', 'data'],
};

// Remplace le contenu des tables par `projects` (déjà validé) en n’écrivant que les différences.
// `previous`, quand il est fourni, est l’état actuellement en base (tel que lu par readWorkspace) :
// les différences sont alors calculées en mémoire, sans relire les tables ni les pièces jointes.
// Renvoie le nombre de lignes écrites ou supprimées.
export function writeWorkspace(db, projects, previous = null) {
  const wanted = rowsOf(projects);
  const known = previous && rowsOf(previous);
  let written = 0;
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const existing = known
      ? new Map(known[table].map(row => [row[0], row]))
      : new Map(
          db
            .prepare(`SELECT ${columns.join(',')} FROM ${table}`)
            .all()
            .map(row => [row.id, columns.map(column => row[column])]),
        );
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    );
    const ids = new Set();
    for (const row of wanted[table]) {
      ids.add(row[0]);
      const current = existing.get(row[0]);
      if (!current || current.length !== row.length || current.some((value, i) => value !== row[i])) {
        upsert.run(...row);
        written++;
      }
    }
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const id of existing.keys())
      if (!ids.has(id)) {
        remove.run(id);
        written++;
      }
  }
  return written;
}

// Convertit l’ancien tableau JSON (colonne workspace.projects) en tables, une seule fois.
// `backup` est appelé avant toute modification ; la conversion est vérifiée puis validée en
// une transaction : en cas d’écart, la base reste intacte et le démarrage échoue.
export function migrateWorkspace(db, { backup } = {}) {
  if (db.prepare('PRAGMA user_version').get().user_version >= TABLES_VERSION) {
    db.exec(WORKSPACE_TABLES);
    return false;
  }
  backup?.();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(WORKSPACE_TABLES);
    const legacy = validateWorkspace(
      JSON.parse(db.prepare('SELECT projects FROM workspace WHERE id = 1').get().projects),
    );
    for (const table of Object.keys(COLUMNS)) db.exec(`DELETE FROM ${table}`);
    writeWorkspace(db, legacy);
    if (JSON.stringify(readWorkspace(db)) !== JSON.stringify(legacy))
      throw new Error('Conversion du tableau en tables incohérente : la base n’a pas été modifiée.');
    db.prepare("UPDATE workspace SET projects = '[]' WHERE id = 1").run();
    db.exec(`PRAGMA user_version = ${TABLES_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}
