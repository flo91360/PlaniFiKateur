import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withInfos } from '../src/lib/infos.js';
import { withProjectLists } from '../src/lib/discussion-list.js';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { publicUser } from './accounts.js';
import { attributeChanges } from './activity.js';
import { createWorkflows } from './workflows.js';
import { createAccountStore } from './store/accounts.js';
import { createHistoryStore } from './store/history.js';
import { createReleaseStore } from './store/releases.js';
import { fail } from './http.js';
import { notificationRecipients } from './recipients.js';
import { migrateWorkspace, readWorkspace, writeWorkspace } from './workspace-tables.js';
import { applyChanges, ChangeError } from '../src/lib/workspace-changes.js';
import { allows, createAccess, MEMBER_ROLES, requirements, ROLES } from './access.js';

// Projets visés par un lot de modifications, ou null si la liste des projets elle-même change.
const changedProjects = changes => {
  if (!Array.isArray(changes)) return null;
  const ids = new Set();
  for (const change of changes) {
    if (['project.create', 'project.delete', 'project.order'].includes(change?.type)) return null;
    if (typeof change?.projectId === 'string') ids.add(change.projectId);
  }
  return [...ids];
};

// Erreur qui refuse une demande (4xx), par opposition à une panne du serveur.
const refusal = error => error?.status >= 400 && error.status < 500;

// Tentatives au plus pour isoler les modifications refusées d’un lot `partial` : chacune relit et
// revalide les projets visés, de façon synchrone. Au-delà, le reste du lot n’est pas tenté.
export const PARTIAL_ATTEMPTS = 50;
const NOT_ATTEMPTED = {
  code: 'not_attempted',
  message: 'Trop de modifications refusées dans ce lot : celle-ci n’a pas été tentée. Réessayez.',
};

// Lot `partial` refusé en entier : il est coupé en deux, récursivement, pour isoler les
// modifications refusées ; les parties acceptées s’appliquent dans l’ordre du lot.
// `attempt(from, to)` tente changes[from..to[ et renvoie { skipped } ou { error }.
export function settlePartial(changes, error, attempt, budget = PARTIAL_ATTEMPTS) {
  const skipped = [],
    rejected = [];
  let attempts = 0;
  const reject = (index, { code, message }) =>
    rejected.push({ index, type: changes[index]?.type ?? null, code, message });
  const settle = (from, to, failure) => {
    if (to - from === 1) return reject(from, failure);
    const middle = from + Math.floor((to - from) / 2);
    for (const [start, end] of [
      [from, middle],
      [middle, to],
    ]) {
      if (attempts >= budget) {
        for (let index = start; index < end; index++) reject(index, NOT_ATTEMPTED);
        continue;
      }
      attempts++;
      const outcome = attempt(start, end);
      if (outcome.error) settle(start, end, outcome.error);
      else skipped.push(...outcome.skipped.map(item => ({ ...item, index: item.index + start })));
    }
  };
  settle(0, changes.length, error);
  return { skipped, rejected, attempts };
}

// Projets, listes et cartes présents avant et absents après.
export const removedContent = (before, after) => {
  const ids = (projects, of) => new Set(projects.flatMap(of));
  const gone = of => {
    const kept = ids(after, of);
    return [...ids(before, of)].filter(id => !kept.has(id));
  };
  return {
    projectIds: gone(project => [project.id]),
    listIds: gone(project => project.lists.map(list => list.id)),
    cardIds: gone(project => project.cards.map(card => card.id)),
  };
};
// Un projet, une liste ou une carte présent avant et absent après ?
export const removesContent = (before, after) =>
  Object.values(removedContent(before, after)).some(ids => ids.length > 0);

// Actions qui notifient leurs destinataires (recipientIds : participants et abonnés de la carte,
// sans l’auteur de l’action). Les messages de l’agent sont déjà annoncés par leur action work.*.
export const NOTIFIED = [
  'comment.created',
  'card.status_changed',
  'card.deleted',
  'card.subscriber_added',
  'work.question',
  'work.submit',
  'work.checks',
  'work.merged',
  'work.interrupted',
  'work.cancel',
  'work.reject',
  'work.approve',
  'project.access_changed',
];
// Réglages rattachés à un projet, effacés avec lui et rétablis par une restauration.
export const PROJECT_SETTINGS = [
  'project_policies',
  'project_members',
  'github_projects',
  'project_ai',
  'project_execution',
];
const NOTIFIED_SQL = `action IN (${NOTIFIED.map(action => `'${action}'`).join(',')}) AND NOT (action = 'comment.created' AND json_extract(payload, '$.executionId') IS NOT NULL)`;

// `backupDirectory` reçoit la copie faite avant la migration du tableau en tables.
// `demo` : une base neuve reçoit les projets de démonstration (développement et tests) ; sinon elle
// commence vide.
export function createStore(filename, { backupDirectory, demo = true } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, projects TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL CHECK(role IN ('admin','member')), active INTEGER NOT NULL DEFAULT 1, invite_hash TEXT, invite_expires INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS card_subscriptions (card_id TEXT NOT NULL, user_id TEXT NOT NULL, following INTEGER NOT NULL CHECK(following IN (0,1)), PRIMARY KEY(card_id,user_id));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL, project_id TEXT, card_id TEXT, revision INTEGER, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_project ON activity(project_id, id);
    CREATE INDEX IF NOT EXISTS activity_card ON activity(card_id, id);
    CREATE TABLE IF NOT EXISTS github_downloads (repository TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repository,tag));
    CREATE TABLE IF NOT EXISTS github_changelog (repository TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repository,tag));
    CREATE TABLE IF NOT EXISTS github_versions (repository TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drive_archives (repository TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(repository,tag));
    CREATE TABLE IF NOT EXISTS drive_repositories (repository TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_reads (user_id TEXT PRIMARY KEY, last_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY, accent TEXT NOT NULL);`);
  // Destinataires de chaque action notifiée, indexés par compte (v0.1.34) : la boîte d’un compte se
  // lit sans parcourir tout l’historique. Remplie une fois depuis l’historique à sa création.
  const notificationsTable = !db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
    .get();
  db.exec(
    'CREATE TABLE IF NOT EXISTS notifications (user_id TEXT NOT NULL, activity_id INTEGER NOT NULL, PRIMARY KEY(user_id, activity_id))',
  );
  if (notificationsTable)
    db.exec(
      `INSERT OR IGNORE INTO notifications SELECT r.value, a.id FROM (SELECT id, payload FROM activity WHERE ${NOTIFIED_SQL}) a, json_each(a.payload, '$.recipientIds') r`,
    );
  const created =
    db
      .prepare('INSERT OR IGNORE INTO workspace VALUES (1, 1, ?, ?)')
      .run(JSON.stringify(validateWorkspace(demo ? seed : [])), new Date().toISOString()).changes === 1;
  // Une base existante est copiée avant d’être convertie : la copie permet de revenir en arrière.
  migrateWorkspace(db, {
    backup() {
      if (filename === ':memory:' || created) return;
      const directory = resolve(backupDirectory || join(dirname(filename), 'backups'));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const name = `planifikateur-avant-tables-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      db.prepare('VACUUM INTO ?').run(join(directory, name));
    },
  });
  // Événements diffusés aux navigateurs (flux /api/v1/events). Pendant une transaction, ils
  // attendent sa validation : une écriture annulée n’est jamais annoncée. Un même événement
  // (même type et même cible) n’est envoyé qu’une fois par transaction.
  const listeners = new Set();
  let queued = null;
  const deliver = events => {
    for (const event of events)
      for (const listener of listeners)
        try {
          listener(event);
        } catch {
          /* Un flux fermé ne doit pas empêcher les autres de recevoir l’événement. */
        }
  };
  const emit = event => {
    if (!queued) return deliver([event]);
    const key = JSON.stringify([event.type, event.projectId, event.cardId, event.executionId, event.userIds]);
    // Plusieurs révisions dans une transaction : un seul événement, depuis la première révision,
    // qui cite tous les projets touchés (ou aucun si l’une d’elles concernait tout le tableau).
    const previous = queued.get(key);
    if (event.type === 'workspace' && previous)
      event = {
        ...event,
        fromRevision: previous.fromRevision,
        ...(previous.projectIds && event.projectIds
          ? { projectIds: [...new Set([...previous.projectIds, ...event.projectIds])] }
          : { projectIds: undefined }),
      };
    queued.set(key, event);
  };
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    queued = new Map();
    try {
      const result = fn();
      db.exec('COMMIT');
      const events = [...queued.values()];
      queued = null;
      deliver(events);
      return result;
    } catch (error) {
      queued = null;
      db.exec('ROLLBACK');
      throw error;
    }
  };
  // Chaque lecture retient le nombre d’écritures déjà faites : une écriture qui part d’un état lu
  // depuis, sans écriture intermédiaire, calcule ses différences en mémoire (writeWorkspace).
  let writes = 0,
    touched = new Set();
  const snapshots = new WeakMap();
  // `projectIds` : seulement ces projets, à écrire ensuite avec `scope` (writeProjects).
  const readProjects = (projectIds = null) => {
    const projects = readWorkspace(db, { projectIds });
    snapshots.set(projects, writes);
    return projects;
  };
  // Seulement ces projets, avec la révision : une modification limitée à quelques projets ne lit
  // ni n’écrit le reste du tableau (ses pièces jointes en particulier).
  const readScope = projectIds => {
    const projects = readWorkspace(db, { projectIds });
    snapshots.set(projects, writes);
    return { projects, ...db.prepare('SELECT revision, updated_at AS updatedAt FROM workspace WHERE id = 1').get() };
  };
  // Identifiants créés dans les projets lus qui existent déjà ailleurs : validateWorkspace ne les
  // voit pas quand seuls ces projets sont lus, alors qu’ils doivent rester uniques dans le tableau.
  const checkNewIds = (before, clean, scope) => {
    const collect = projects =>
      projects.flatMap(p => [
        ...p.lists.map(l => l.id),
        ...p.cards.flatMap(c => [
          c.id,
          ...(c.comments || []).map(m => m.id),
          ...(c.attachments || []).map(a => a.id),
          ...c.checklist.map(i => i.id),
        ]),
      ]);
    const known = new Set(collect(before));
    const created = [...new Set(collect(clean).filter(id => !known.has(id)))];
    if (!created.length) return;
    const outside = `NOT IN (SELECT value FROM json_each(?))`,
      ids = JSON.stringify(created),
      projects = JSON.stringify(scope);
    const among = 'IN (SELECT value FROM json_each(?))';
    const taken =
      db.prepare(`SELECT 1 FROM projects WHERE id ${among}`).get(ids) ||
      db.prepare(`SELECT 1 FROM lists WHERE id ${among} AND project_id ${outside}`).get(ids, projects) ||
      db.prepare(`SELECT 1 FROM cards WHERE id ${among} AND project_id ${outside}`).get(ids, projects) ||
      db
        .prepare(
          `SELECT 1 FROM comments m JOIN cards c ON c.id = m.card_id WHERE m.id ${among} AND c.project_id ${outside}`,
        )
        .get(ids, projects) ||
      db
        .prepare(
          `SELECT 1 FROM attachments a JOIN cards c ON c.id = a.card_id WHERE a.id ${among} AND c.project_id ${outside}`,
        )
        .get(ids, projects) ||
      db
        .prepare(
          `SELECT 1 FROM cards c, json_each(c.checklist) i WHERE json_extract(i.value, '$.id') ${among} AND c.project_id ${outside}`,
        )
        .get(ids, projects);
    if (taken) fail(400, 'invalid_workspace', 'Identifiant invalide ou déjà utilisé dans un autre projet.');
  };
  // Toute écriture du contenu augmente la révision (sauf `revision: false`, quand une écriture
  // suivante de la même transaction s’en charge) : les navigateurs actualisent leur tableau.
  // `previous` : état lu juste avant (readProjects), si aucune autre écriture n’a eu lieu depuis.
  const writeProjects = (
    projects,
    date = new Date().toISOString(),
    { revision = true, previous = null, scope = null } = {},
  ) => {
    const { projectIds, structural } = writeWorkspace(
      db,
      projects,
      previous && snapshots.get(previous) === writes ? previous : null,
      { scope },
    );
    writes++;
    // Projets touchés depuis le dernier événement de la transaction (une écriture sans révision
    // les transmet à la suivante).
    for (const id of projectIds) touched.add(id);
    if (structural) touched.structural = true;
    if (!revision) return;
    db.prepare('UPDATE workspace SET revision = revision + 1, updated_at = ? WHERE id = 1').run(date);
    // Les navigateurs ne relisent que les projets cités ; sans `projectIds` (liste des projets
    // changée, ou rien d’identifiable), ils relisent tout le tableau.
    const ids = [...touched];
    const current = db.prepare('SELECT revision FROM workspace WHERE id = 1').get().revision;
    emit({
      type: 'workspace',
      revision: current,
      fromRevision: current - 1,
      ...(touched.structural || !ids.length ? {} : { projectIds: ids }),
    });
    touched = new Set();
  };
  const synchronizeInfos = () => {
    const previous = readProjects();
    const projects = previous.map(project => withInfos(project, versionFor(project.id)));
    // Comment migrations may reorder properties without changing their values.
    // Only an actual Infos change should increment the workspace revision.
    if (!isDeepStrictEqual(projects, previous)) writeProjects(validateWorkspace(projects), undefined, { previous });
  };
  const audit = (actor, action, payload = {}, revision = null) => {
    // Les destinataires d’une action notifiée la voient arriver aussitôt dans leur boîte.
    const notified =
      NOTIFIED.includes(action) &&
      !(action === 'comment.created' && payload.executionId) &&
      payload.recipientIds?.length;
    if (notified) emit({ type: 'notifications', userIds: payload.recipientIds });
    const inserted = db
      .prepare(
        'INSERT INTO activity(date,actor_id,actor_name,action,project_id,card_id,revision,payload) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        new Date().toISOString(),
        actor?.id || null,
        actor?.name || 'Administration',
        action,
        payload.projectId || null,
        payload.cardId || null,
        revision,
        JSON.stringify(payload),
      );
    if (notified)
      for (const userId of new Set(payload.recipientIds))
        db.prepare('INSERT OR IGNORE INTO notifications VALUES (?, ?)').run(userId, inserted.lastInsertRowid);
    return inserted;
  };
  // Rétention : l’historique ancien part avec ses notifications.
  const purgeActivity = before => {
    const removed = db.prepare('DELETE FROM activity WHERE date < ?').run(before).changes;
    if (removed) db.exec('DELETE FROM notifications WHERE activity_id NOT IN (SELECT id FROM activity)');
    return removed;
  };
  const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const projectName = projectId => db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId)?.name;
  const findCard = (projectId, cardId) => {
    const [project] = readWorkspace(db, { projectIds: [projectId] });
    const card = project?.cards.find(c => c.id === cardId);
    if (!card) fail(404, 'card_not_found', 'Carte inexistante dans ce projet.');
    return { project, card };
  };
  const preferences = cardId =>
    db.prepare('SELECT user_id,following FROM card_subscriptions WHERE card_id = ?').all(cardId);
  const participants = card => [card.createdBy?.id, ...card.comments.map(c => c.authorId)].filter(Boolean);
  const access = createAccess(db);
  // Membres actifs, limités à ceux qui voient le projet quand il est précisé.
  const activeMembers = projectId =>
    db
      .prepare('SELECT id,name,role FROM users WHERE active = 1 AND password_hash IS NOT NULL ORDER BY name,id')
      .all()
      .filter(user => !projectId || access.role(user, projectId))
      .map(({ id, name }) => ({ id, name }));
  const following = (card, userId, prefs = preferences(card.id)) => {
    const preference = prefs.find(row => row.user_id === userId);
    return preference ? !!preference.following : participants(card).includes(userId);
  };
  const activeUserIds = () =>
    new Set(
      db
        .prepare('SELECT id FROM users WHERE active = 1 AND password_hash IS NOT NULL')
        .all()
        .map(user => user.id),
    );
  const recipients = (card, actor, extra = []) =>
    notificationRecipients({
      participants: [...participants(card), ...extra],
      preferences: preferences(card.id),
      activeIds: activeUserIds(),
      actorId: actor?.id,
    });
  // Une carte « Prête à démarrer » n’est confiée à l’agent que si un responsable l’y a placée.
  const canLaunch = (actor, projectId) => {
    const user = actor?.id ? userById(actor.id) : null;
    return !!user && allows(access.role(publicUser(user), projectId), 'manager');
  };
  const workflows = createWorkflows(db, {
    canLaunch,
    // Projets sans le contenu des pièces jointes : lecture seule (file de l’agent, « À traiter »).
    readLight: projectIds => readWorkspace(db, { projectIds, attachmentData: false }),
    requiresApproval: projectId => access.mergeApproval(projectId),
    transaction,
    audit,
    findCard,
    readProjects,
    writeProjects,
    recipients,
    emit,
  });
  const versionFor = projectId => {
    const repository = workflows.githubProject(projectId);
    if (!repository) return { tag: 'Aucun tag disponible', date: '' };
    const row = db.prepare('SELECT data FROM github_versions WHERE repository=?').get(repository.toLowerCase());
    const version = row ? JSON.parse(row.data) : { tag: 'Version en cours de récupération', date: '' };
    const downloads = db
      .prepare('SELECT data FROM github_downloads WHERE repository=? AND tag=?')
      .get(repository.toLowerCase(), version.tag);
    const changelog = db
      .prepare('SELECT data FROM github_changelog WHERE repository=?')
      .all(repository.toLowerCase())
      .map(row => JSON.parse(row.data))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.tag.localeCompare(a.tag));
    return { ...version, repository, changelog, ...(downloads ? { downloads: JSON.parse(downloads.data) } : {}) };
  };
  transaction(synchronizeInfos);
  // Projets antérieurs aux listes « Discussion » et « À tester » : elles sont ajoutées au démarrage
  // (l’ancienne liste « Terminées » renommée), les tâches livrées rangées et les cartes de discussion retirées de la file de l’agent.
  transaction(() => {
    const previous = readProjects();
    const projects = previous.map(withProjectLists);
    if (projects.some((project, index) => project !== previous[index])) {
      const clean = validateWorkspace(projects);
      workflows.withdrawDiscussion(clean, null);
      writeProjects(clean, undefined, { previous });
    }
  });
  // Projets antérieurs aux droits par projet : règle par défaut, et leur créateur (d’après
  // l’historique) en devient responsable.
  transaction(() => {
    for (const project of readProjects())
      if (!access.hasPolicy(project.id)) {
        const creator = db
          .prepare(
            "SELECT actor_id FROM activity WHERE action = 'project.created' AND project_id = ? ORDER BY id LIMIT 1",
          )
          .get(project.id)?.actor_id;
        access.adopt(project.id, creator ? userById(creator) : null);
      }
  });
  // Projet supprimé : droits, dépôt, réglages et accès des agents sont effacés, et son
  // identifiant reste réservé.
  const forgetProject = projectId => {
    access.forgetProject(projectId);
    workflows.forgetProject(projectId);
    access.bury(projectId);
  };
  // Restauration : chaque projet revient avec les réglages qu’il avait dans la sauvegarde (droits,
  // validation, dépôt, IA, exécution) et l’accès des agents qui existent encore.
  const restoreProjectSettings = (projectId, { tables = {}, agents = [] }) => {
    for (const [table, rows] of Object.entries(tables)) {
      if (!PROJECT_SETTINGS.includes(table)) continue;
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map(column => column.name),
      );
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      for (const row of rows.filter(row => row.project_id === projectId)) {
        const names = Object.keys(row).filter(name => columns.has(name));
        db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(
          ...names.map(name => row[name]),
        );
      }
    }
    for (const saved of agents) {
      const current = db.prepare('SELECT projects FROM agents WHERE id = ? AND active = 1').get(saved.id);
      if (!current || !saved.projects.includes(projectId)) continue;
      const projects = JSON.parse(current.projects);
      if (!projects.includes(projectId))
        db.prepare('UPDATE agents SET projects = ? WHERE id = ?').run(
          JSON.stringify([...projects, projectId]),
          saved.id,
        );
    }
  };
  // Projets supprimés avant la 0.1.31 : leurs réglages restaient en place. Ils sont effacés, et
  // les identifiants de projets supprimés d’après l’historique sont réservés.
  transaction(() => {
    const current = new Set(readProjects().map(project => project.id));
    const leftovers = new Set(
      [
        ...PROJECT_SETTINGS.flatMap(table =>
          db
            .prepare(`SELECT DISTINCT project_id FROM ${table}`)
            .all()
            .map(row => row.project_id),
        ),
        ...db
          .prepare(
            "SELECT DISTINCT project_id FROM activity WHERE action = 'project.deleted' AND project_id IS NOT NULL",
          )
          .all()
          .map(row => row.project_id),
        ...db
          .prepare('SELECT projects FROM agents')
          .all()
          .flatMap(row => JSON.parse(row.projects)),
      ].filter(id => !current.has(id)),
    );
    for (const projectId of leftovers) forgetProject(projectId);
  });
  // Champs que seul le serveur renseigne (cartes Infos : téléchargement, README, changelog).
  const withoutSystemFields = card => {
    if (!card || typeof card !== 'object') return card;
    const { downloads, readme, changelog, ...rest } = card;
    return rest;
  };
  // Le navigateur reçoit les pièces jointes sans leur contenu : une pièce jointe déjà connue
  // (même identifiant) qu’il renvoie sans `data` retrouve le contenu enregistré.
  const withData = (attachments, stored) =>
    Array.isArray(attachments)
      ? attachments.map(file =>
          file && typeof file === 'object' && file.data === undefined && stored().has(file.id)
            ? { ...file, data: stored().get(file.id) }
            : file,
        )
      : attachments;
  const withCardData = (card, stored) =>
    card && typeof card === 'object' && 'attachments' in card
      ? { ...card, attachments: withData(card.attachments, stored) }
      : card;
  const sanitize = (change, stored) => {
    if (change?.type === 'card.create')
      return { ...change, card: withCardData(withoutSystemFields(change.card), stored) };
    if (change?.type === 'project.create' && Array.isArray(change.project?.cards))
      return {
        ...change,
        project: {
          ...change.project,
          cards: change.project.cards.map(card => withCardData(withoutSystemFields(card), stored)),
        },
      };
    if (change?.type === 'card.update' && change.fields && typeof change.fields === 'object')
      return { ...change, fields: withCardData(change.fields, stored) };
    if (change?.type === 'attachment.create')
      return { ...change, attachment: withData([change.attachment], stored)[0] };
    return change;
  };
  // Contrôle des droits puis application d’un lot de modifications sur `before`.
  const planChanges = (before, changes, actor, strict) => {
    if (!Array.isArray(changes)) fail(400, 'invalid_change', 'Une liste de modifications est requise.');
    // Droits par projet : un projet masqué se comporte comme un projet inexistant ; un rôle
    // insuffisant sur un projet visible refuse tout le lot.
    const roles = access.map(
      actor,
      before.projects.map(project => project.id),
    );
    const projects = new Map(before.projects.map(project => [project.id, project]));
    const cardOf = (projectId, cardId) => projects.get(projectId)?.cards.find(card => card.id === cardId);
    const lookup = { cardStatus: (projectId, cardId) => cardOf(projectId, cardId)?.status ?? null };
    const allowed = [],
      hidden = [];
    let stored = null;
    const attachmentData = () =>
      (stored ??= new Map(
        before.projects.flatMap(project =>
          project.cards.flatMap(card => (card.attachments || []).map(file => [file.id, file.data])),
        ),
      ));
    changes = changes.map(change => sanitize(change, attachmentData));
    changes.forEach((change, index) => {
      if (change?.type === 'project.create' && access.isDeleted(change.project?.id))
        fail(
          409,
          'project_deleted',
          'Cet identifiant appartient à un projet supprimé : seul un administrateur peut le restaurer depuis une sauvegarde.',
        );
      const needs = requirements(change, lookup);
      if (needs.some(([projectId]) => projects.has(projectId) && !roles[projectId]))
        return hidden.push({ index, type: change?.type, reason: 'missing' });
      const refused = needs.find(([projectId, role]) => projects.has(projectId) && !allows(roles[projectId], role));
      if (refused)
        fail(
          403,
          'project_forbidden',
          refused[1] === 'manager'
            ? 'Seuls les responsables du projet peuvent confier une carte à l’agent, modifier une carte qui l’attend ou gérer le projet.'
            : 'Votre rôle sur ce projet ne permet que la lecture.',
        );
      // Un commentaire n’est modifié que par son auteur ; un responsable peut aussi le supprimer.
      if (change?.type === 'comment.update' || change?.type === 'comment.delete') {
        const comment = cardOf(change.projectId, change.cardId)?.comments.find(item => item.id === change.commentId);
        const author = !!comment?.authorId && comment.authorId === actor?.id;
        if (comment && !author && (change.type === 'comment.update' || !allows(roles[change.projectId], 'manager')))
          fail(
            403,
            'comment_forbidden',
            change.type === 'comment.update'
              ? 'Seul l’auteur d’un commentaire peut le modifier.'
              : 'Seuls l’auteur d’un commentaire et les responsables du projet peuvent le supprimer.',
          );
      }
      // L’ordre des projets est commun : chacun ne range que les projets qu’il peut modifier.
      if (change?.type === 'project.order' && Array.isArray(change.projectIds))
        changes[index] = {
          ...change,
          projectIds: change.projectIds.filter(id => allows(roles[id], 'editor')),
        };
      allowed.push(index);
    });
    let result;
    try {
      result = applyChanges(
        before.projects,
        allowed.map(index => changes[index]),
      );
    } catch (error) {
      if (error instanceof ChangeError) fail(400, 'invalid_change', error.message);
      throw error;
    }
    const skipped = [...hidden, ...result.skipped.map(item => ({ ...item, index: allowed[item.index] }))].sort(
      (a, b) => a.index - b.index,
    );
    const first = strict && skipped[0];
    if (first)
      fail(
        first.reason === 'missing' ? 404 : 409,
        `change_${first.reason}`,
        first.reason === 'missing'
          ? 'Élément inexistant : il a peut-être été supprimé.'
          : first.reason === 'exists'
            ? 'Cet identifiant est déjà utilisé.'
            : 'Déplacez ou supprimez d’abord les cartes de cette liste.',
      );
    try {
      // Une tâche passée au statut « À tester » rejoint la liste « À tester ».
      return { clean: validateWorkspace(result.projects.map(withProjectLists)), skipped };
    } catch (error) {
      fail(400, 'invalid_workspace', error.message);
    }
  };
  // Enregistre un nouvel état validé : exécutions IA, auteurs et dates, historique, abonnements.
  // Responsable et archivage d’une carte, contrôlés quand ils changent : le responsable est un
  // membre actif qui voit le projet ; une carte dont l’agent traite la demande n’est pas archivée.
  const checkCards = (before, after) => {
    const previous = new Map(before.flatMap(project => project.cards.map(card => [card.id, card])));
    for (const project of after)
      for (const card of project.cards) {
        const old = previous.get(card.id);
        if (card.assigneeId && card.assigneeId !== old?.assigneeId) {
          const user = userById(card.assigneeId);
          if (!user?.active || !user.password_hash || !access.role(publicUser(user), project.id))
            fail(400, 'invalid_assignee', 'Le responsable de la carte doit être un membre actif du projet.');
        }
        if (
          card.archived &&
          !old?.archived &&
          db.prepare("SELECT 1 FROM executions WHERE card_id = ? AND state NOT IN ('done','cancelled')").get(card.id)
        )
          fail(409, 'managed_status', 'L’agent traite cette carte : annulez son exécution avant de l’archiver.');
      }
  };
  // `scope` : seuls ces projets ont été lus (before) et sont écrits (clean), les autres restent intacts.
  const commit = (before, clean, actor, { restore = false, settings = null, scope = null } = {}) => {
    const date = new Date().toISOString();
    if (!restore) checkCards(before.projects, clean);
    workflows.reconcile(before.projects, clean, actor, restore, scope);
    // before.projects vient de readWorkspace : il est déjà sous forme canonique.
    const events = restore ? [{ action: 'workspace.restored' }] : attributeChanges(before.projects, clean, actor, date);
    writeProjects(clean, date, { previous: before.projects, scope });
    const kept = new Set(clean.map(project => project.id));
    for (const project of before.projects) if (!kept.has(project.id)) forgetProject(project.id);
    if (restore)
      for (const project of clean) {
        access.revive(project.id);
        if (settings) restoreProjectSettings(project.id, settings);
      }
    for (const project of clean) if (!access.hasPolicy(project.id)) access.adopt(project.id, actor);
    const activeIds = activeUserIds();
    for (const event of events) {
      // Les participants calculés par attributeChanges sont complétés par les abonnés de la carte.
      if (event.cardId)
        event.recipientIds = notificationRecipients({
          participants: event.recipientIds,
          preferences: preferences(event.cardId),
          activeIds,
          actorId: actor?.id,
        });
      audit(actor, event.action, event, before.revision + 1);
    }
    const survivingCards = new Set(clean.flatMap(p => p.cards.map(c => c.id)));
    const removedCards = scope
      ? before.projects.flatMap(p => p.cards.map(c => c.id)).filter(id => !survivingCards.has(id))
      : db
          .prepare('SELECT DISTINCT card_id FROM card_subscriptions')
          .all()
          .map(row => row.card_id)
          .filter(id => !survivingCards.has(id));
    for (const id of removedCards) db.prepare('DELETE FROM card_subscriptions WHERE card_id = ?').run(id);
  };
  const releases = createReleaseStore({ db, transaction, workflows, synchronizeInfos });
  const accounts = createAccountStore({ db, transaction, audit, access, userById });
  const history = createHistoryStore({ db, emit });
  return {
    workflows,
    // Abonnement aux événements validés ; renvoie la fonction de désabonnement.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...releases,
    subscription(projectId, cardId, userId) {
      const { card } = findCard(projectId, cardId);
      return { following: following(card, userId) };
    },
    cardMembers(projectId, cardId) {
      const { card } = findCard(projectId, cardId);
      const prefs = preferences(card.id);
      return activeMembers(projectId).map(user => ({ ...user, following: following(card, user.id, prefs) }));
    },
    projectCardFollowers(projectId) {
      const [project] = readWorkspace(db, { projectIds: [projectId], attachmentData: false });
      if (!project) fail(404, 'project_not_found', 'Projet inexistant.');
      const members = activeMembers(projectId);
      // Une seule lecture des préférences pour toutes les cartes du projet.
      const prefsByCard = new Map(project.cards.map(card => [card.id, []]));
      for (const row of db
        .prepare(
          'SELECT card_id,user_id,following FROM card_subscriptions WHERE card_id IN (SELECT id FROM cards WHERE project_id = ?)',
        )
        .all(projectId))
        prefsByCard.get(row.card_id)?.push(row);
      return Object.fromEntries(
        project.cards.map(card => [
          card.id,
          members.filter(member => following(card, member.id, prefsByCard.get(card.id))),
        ]),
      );
    },
    setSubscription(projectId, cardId, actor, enabled, userId = actor.id) {
      return transaction(() => {
        const { project, card } = findCard(projectId, cardId);
        const target = userById(userId);
        if (!target?.active || !target.password_hash || !access.role(publicUser(target), projectId))
          fail(400, 'invalid_subscriber', 'Choisissez un membre actif du projet.');
        const previous = preferences(cardId).find(row => row.user_id === userId);
        if (!previous || !!previous.following !== enabled) {
          db.prepare(
            'INSERT INTO card_subscriptions VALUES(?,?,?) ON CONFLICT(card_id,user_id) DO UPDATE SET following = excluded.following',
          ).run(cardId, userId, enabled ? 1 : 0);
          emit({ type: 'subscriptions', projectId, cardId });
          audit(actor, userId !== actor.id ? 'card.subscriber_added' : enabled ? 'card.followed' : 'card.unfollowed', {
            projectId,
            projectName: project.name,
            cardId,
            cardTitle: card.title,
            subscriberId: userId,
            subscriberName: target.name,
            recipientIds: userId !== actor.id ? [userId] : [],
          });
        }
        return { following: enabled };
      });
    },
    // Rétention : supprime l’historique et les exécutions terminées plus anciens que le nombre
    // de jours indiqué (0 : tout conserver). Les cartes et leurs commentaires ne sont jamais touchés.
    purge({ activityDays = 0, executionDays = 0, now = Date.now() } = {}) {
      const cutoff = days => new Date(now - days * 86400000).toISOString();
      return transaction(() => ({
        activity: activityDays > 0 ? purgeActivity(cutoff(activityDays)) : 0,
        executions: executionDays > 0 ? workflows.purge(cutoff(executionDays)) : 0,
      }));
    },
    backupVersion() {
      return `${this.getRevision()}:${db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM activity').get().id}`;
    },
    getRevision() {
      return db.prepare('SELECT revision FROM workspace WHERE id = 1').get().revision;
    },
    snapshot(target) {
      db.prepare('VACUUM INTO ?').run(target);
    },
    read() {
      const row = db.prepare('SELECT revision, updated_at FROM workspace WHERE id = 1').get();
      return { projects: readProjects(), revision: row.revision, updatedAt: row.updated_at };
    },
    // Tableau complet sans le contenu des pièces jointes (consultation, clés de lecture et d’agent).
    readLight() {
      return {
        ...db.prepare('SELECT revision, updated_at AS updatedAt FROM workspace WHERE id = 1').get(),
        projects: readWorkspace(db, { attachmentData: false }),
      };
    },
    // Tableau vu par un compte : seulement ses projets, avec son rôle sur chacun (`access`).
    // `attachmentData: false` : pièces jointes sans leur contenu, pour le navigateur.
    // `projectIds` : seulement ces projets (relecture partielle), `access` restant complet.
    readFor(user, { attachmentData = true, projectIds = null } = {}) {
      const workspace =
        attachmentData && !projectIds
          ? this.read()
          : {
              ...db.prepare('SELECT revision, updated_at AS updatedAt FROM workspace WHERE id = 1').get(),
              projects: readWorkspace(db, { attachmentData, projectIds }),
            };
      const roles = projectIds
        ? this.accessOf(user)
        : access.map(
            user,
            workspace.projects.map(project => project.id),
          );
      return { ...workspace, projects: workspace.projects.filter(project => roles[project.id]), access: roles };
    },
    projectRole: (user, projectId) => access.role(user, projectId),
    // Une pièce jointe d’une carte, avec son contenu (base64), ou null.
    attachment(projectId, cardId, attachmentId) {
      return (
        db
          .prepare(
            'SELECT a.name, a.type, a.size, a.data FROM attachments a JOIN cards c ON c.id = a.card_id WHERE a.id = ? AND c.id = ? AND c.project_id = ?',
          )
          .get(attachmentId, cardId, projectId) || null
      );
    },
    // Rôle d’un compte sur chacun des projets qu’il voit, sans lire le contenu du tableau.
    accessOf(user) {
      return access.map(
        user,
        db
          .prepare('SELECT id FROM projects ORDER BY position')
          .all()
          .map(row => row.id),
      );
    },
    mergeApproval: projectId => access.mergeApproval(projectId),
    configureMergeApproval(projectId, data, actor) {
      return transaction(() => {
        this.requireProject(actor, projectId, 'manager');
        if (!data || typeof data.required !== 'boolean' || Object.keys(data).length !== 1)
          fail(400, 'invalid_approval', 'Envoyez { "required": true } ou { "required": false }.');
        access.setMergeApproval(projectId, data.required);
        audit(actor, 'project.approval_changed', {
          projectId,
          projectName: projectName(projectId),
          details: { required: data.required },
          recipientIds: [],
        });
        // Les exécutions en cours de fusion affichent ou retirent l’attente de validation.
        emit({ type: 'work', projectId });
        return { required: data.required };
      });
    },
    // Exige un rôle minimal sur un projet ; un projet masqué est signalé comme inexistant.
    requireProject(user, projectId, role = 'viewer') {
      const current =
        !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) && access.role(user, projectId);
      if (!current) fail(404, 'project_not_found', 'Projet inexistant.');
      if (!allows(current, role))
        fail(
          403,
          'project_forbidden',
          role === 'manager'
            ? 'Cette action est réservée aux responsables du projet.'
            : 'Votre rôle sur ce projet ne permet que la lecture.',
        );
      return current;
    },
    // Membres d’un projet : règle pour les autres membres et rôle effectif de chaque compte actif.
    // Sans `viewer` (ou pour un responsable) : tous les comptes actifs, pour gérer les membres ;
    // les autres rôles ne voient que les comptes qui ont accès au projet.
    projectAccess(projectId, viewer = null) {
      const explicit = access.explicit(projectId);
      const manages = !viewer || allows(access.role(viewer, projectId), 'manager');
      const members = db
        .prepare('SELECT * FROM users WHERE active = 1 AND password_hash IS NOT NULL ORDER BY name,id')
        .all()
        .map(user => ({
          id: user.id,
          name: user.name,
          admin: user.role === 'admin',
          role: access.role(publicUser(user), projectId),
          explicit: user.role === 'admin' ? null : explicit[user.id] || null,
        }));
      return {
        memberRole: access.policy(projectId),
        members: manages
          ? members
          : members.filter(member => member.role).map(member => ({ ...member, explicit: null })),
      };
    },
    configureProjectAccess(projectId, data, actor) {
      return transaction(() => {
        this.requireProject(actor, projectId, 'manager');
        if (!data || typeof data !== 'object' || Array.isArray(data))
          fail(400, 'invalid_access', 'Un objet JSON est attendu.');
        const unknown = Object.keys(data).filter(key => !['memberRole', 'members'].includes(key));
        if (unknown.length) fail(400, 'invalid_access', `Champs inconnus : ${unknown.join(', ')}.`);
        if (data.memberRole !== undefined && !MEMBER_ROLES.includes(data.memberRole))
          fail(400, 'invalid_access', 'Rôle des autres membres inconnu.');
        const members = data.members ?? {};
        if (!members || typeof members !== 'object' || Array.isArray(members))
          fail(400, 'invalid_access', 'members : objet { identifiant: rôle } attendu.');
        for (const [userId, role] of Object.entries(members)) {
          const user = userById(userId);
          if (!user?.active || !user.password_hash) fail(400, 'invalid_access', 'Choisissez des membres actifs.');
          if (user.role === 'admin')
            fail(400, 'invalid_access', 'Un administrateur est responsable de tous les projets.');
          if (role !== null && !ROLES.includes(role)) fail(400, 'invalid_access', 'Rôle inconnu.');
        }
        access.configure(projectId, { memberRole: data.memberRole, members });
        // La visibilité des projets change : les navigateurs relisent le tableau.
        db.prepare('UPDATE workspace SET revision = revision + 1, updated_at = ? WHERE id = 1').run(
          new Date().toISOString(),
        );
        emit({ type: 'workspace', revision: this.getRevision() });
        audit(actor, 'project.access_changed', {
          projectId,
          projectName: projectName(projectId),
          details: { memberRole: data.memberRole, members },
          recipientIds: Object.keys(members),
        });
        return this.projectAccess(projectId);
      });
    },
    // Remplace tout le tableau, à condition que la session ait lu la révision courante.
    // Une restauration (`restore`) peut ramener des projets supprimés, avec leurs réglages (`settings`).
    write(projects, revision, actor = null, { restore = false, settings = null } = {}) {
      return transaction(() => {
        const before = this.read();
        if (before.revision !== revision) return null;
        const clean = validateWorkspace(validateWorkspace(projects).map(withProjectLists));
        const existing = new Set(before.projects.map(project => project.id));
        if (!restore && clean.some(project => !existing.has(project.id) && access.isDeleted(project.id)))
          fail(
            409,
            'project_deleted',
            'Le tableau contient un projet supprimé : restaurez-le depuis une sauvegarde plutôt que de le recréer.',
          );
        commit(before, clean, actor, { restore, settings });
        return this.read();
      });
    },
    // Applique des modifications fines (voir src/lib/workspace-changes.js) sur l’état courant,
    // sans exiger de révision. Les modifications dont la cible a disparu sont ignorées et
    // renvoyées dans `skipped` ; avec `strict`, elles annulent tout.
    // `attachmentData: false` : le tableau renvoyé omet le contenu des pièces jointes.
    // `scope: 'changed'` : seuls les projets visés par le lot sont renvoyés (`projectIds`), avec
    // la révision lue au départ (`fromRevision`) ; tout le tableau si la liste des projets change.
    change(changes, actor, { strict = false, partial = false, attachmentData = true, scope = 'all' } = {}) {
      return transaction(() => {
        // Modifications limitées à des projets existants : seuls ces projets sont lus et écrits.
        const limited = changedProjects(changes);
        const local =
          !!limited?.length &&
          limited.every(id => db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) &&
          limited;
        const state = () => (local ? readScope(local) : this.read());
        const before = state();
        const targets = scope === 'changed' ? limited : null;
        const save = (from, clean) => {
          if (local) checkNewIds(from.projects, clean, local);
          commit(from, clean, actor, { scope: local || null });
        };
        const respond = extra => ({
          ...this.readFor(actor, { attachmentData, projectIds: targets }),
          ...(targets ? { projectIds: targets, fromRevision: before.revision } : {}),
          ...extra,
        });
        if (!partial) {
          const { clean, skipped } = planChanges(before, changes, actor, strict);
          // Rien à enregistrer (modifications ignorées ou déjà appliquées) : la révision ne bouge pas.
          if (JSON.stringify(clean) !== JSON.stringify(before.projects)) save(before, clean);
          return respond({ skipped, replays: 0 });
        }
        // `partial` : une modification refusée (droits, contenu invalide, statut piloté par l’agent)
        // n’empêche pas les autres. Le lot est d’abord tenté en entier ; s’il est refusé, il est
        // découpé (settlePartial) et les refus sont renvoyés dans `rejected`. `replays` compte les
        // tentatives supplémentaires, limitées par compte (server/routes/content.js).
        const attempt = (name, callback) => {
          db.exec(`SAVEPOINT ${name}`);
          // Les événements d’une tentative annulée ne doivent pas être diffusés.
          const events = new Map(queued);
          try {
            const result = callback();
            db.exec(`RELEASE ${name}`);
            return { result };
          } catch (error) {
            db.exec(`ROLLBACK TO ${name}`);
            db.exec(`RELEASE ${name}`);
            queued = events;
            if (!refusal(error)) throw error;
            return { error };
          }
        };
        const apply = (current, batch) => {
          const { clean, skipped } = planChanges(current, batch, actor, false);
          if (JSON.stringify(clean) !== JSON.stringify(current.projects)) save(current, clean);
          return skipped;
        };
        const whole = attempt('batch', () => apply(before, changes));
        if (!whole.error) return respond({ skipped: whole.result, rejected: [], replays: 0 });
        if (!Array.isArray(changes)) throw whole.error;
        const { skipped, rejected, attempts } = settlePartial(changes, whole.error, (from, to) => {
          const part = attempt('part', () => apply(state(), changes.slice(from, to)));
          return part.error ? { error: part.error } : { skipped: part.result };
        });
        return respond({ skipped, rejected, replays: attempts });
      });
    },
    // Vérifie des modifications sans les enregistrer (mêmes refus que `change`) et indique si
    // elles suppriment un élément : la sauvegarde de sécurité n’est faite qu’à cette condition.
    // En mode `partial`, seules les modifications acceptées comptent, isolées comme par `change`
    // (même découpage, même nombre de tentatives au plus), compté dans `replays`.
    previewChanges(changes, actor, { strict = false, partial = false } = {}) {
      const before = this.read();
      const plan = (state, batch) => planChanges(state, batch, actor, partial ? false : strict).clean;
      // `removed` : projets, listes et cartes retirés (voir backups.covers).
      const result = (projects, replays) => {
        const removed = removedContent(before.projects, projects);
        return { removes: Object.values(removed).some(ids => ids.length > 0), removed, replays };
      };
      if (!partial) return result(plan(before, changes), 0);
      let state = before;
      try {
        state = { ...state, projects: plan(state, changes) };
        return result(state.projects, 0);
      } catch (error) {
        if (!refusal(error)) throw error;
        if (!Array.isArray(changes)) return result(before.projects, 0);
        const { attempts } = settlePartial(changes, error, (from, to) => {
          try {
            state = { ...state, projects: plan(state, changes.slice(from, to)) };
            return { skipped: [] };
          } catch (failure) {
            if (!refusal(failure)) throw failure;
            return { error: failure };
          }
        });
        return result(state.projects, attempts);
      }
    },
    // Un de ces projets, listes ou cartes a-t-il changé depuis l’action d’historique `activityId` ?
    // Toute modification d’une carte (champs, commentaires, pièces jointes, exécution) est inscrite
    // à l’historique avec elle ; une restauration change tout.
    touchedSince(activityId, { projectIds = [], listIds = [], cardIds = [] }) {
      const among = 'IN (SELECT value FROM json_each(?))';
      return !!db
        .prepare(
          `SELECT 1 FROM activity WHERE id > ? AND (action = 'workspace.restored' OR project_id ${among} OR card_id ${among} OR json_extract(payload, '$.details.listId') ${among}) LIMIT 1`,
        )
        .get(activityId, JSON.stringify(projectIds), JSON.stringify(cardIds), JSON.stringify(listIds));
    },
    ...accounts,
    ...history,
    close() {
      db.close();
    },
  };
}
