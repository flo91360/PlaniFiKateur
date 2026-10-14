import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { withInfos } from '../src/lib/infos.js';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { publicUser, tokenHash } from './accounts.js';
import { DEFAULT_ACCENT, isAccent } from '../src/lib/accents.js';
import { attributeChanges } from './activity.js';
import { createWorkflows } from './workflows.js';
import { validateDriveRelease } from '../src/lib/drive-release.js';
import { fail } from './http.js';
import { notificationRecipients } from './recipients.js';
import { migrateWorkspace, readWorkspace, writeWorkspace } from './workspace-tables.js';
import { applyChanges, ChangeError } from '../src/lib/workspace-changes.js';
import { allows, createAccess, MEMBER_ROLES, requirements, ROLES } from './access.js';

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
const NOTIFIED_SQL = `action IN (${NOTIFIED.map(action => `'${action}'`).join(',')}) AND NOT (action = 'comment.created' AND json_extract(payload, '$.executionId') IS NOT NULL)`;

// `backupDirectory` reçoit la copie faite avant la migration du tableau en tables.
export function createStore(filename, { backupDirectory } = {}) {
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
  const created =
    db
      .prepare('INSERT OR IGNORE INTO workspace VALUES (1, 1, ?, ?)')
      .run(JSON.stringify(validateWorkspace(seed)), new Date().toISOString()).changes === 1;
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
  const readProjects = () => readWorkspace(db);
  // Toute écriture du contenu augmente la révision (sauf `revision: false`, quand une écriture
  // suivante de la même transaction s’en charge) : les navigateurs actualisent leur tableau.
  const writeProjects = (projects, date = new Date().toISOString(), { revision = true } = {}) => {
    writeWorkspace(db, projects);
    if (!revision) return;
    db.prepare('UPDATE workspace SET revision = revision + 1, updated_at = ? WHERE id = 1').run(date);
    emit({ type: 'workspace', revision: db.prepare('SELECT revision FROM workspace WHERE id = 1').get().revision });
  };
  const synchronizeInfos = () => {
    const previous = readProjects();
    const projects = previous.map(project => withInfos(project, versionFor(project.id)));
    // Comment migrations may reorder properties without changing their values.
    // Only an actual Infos change should increment the workspace revision.
    if (!isDeepStrictEqual(projects, previous)) writeProjects(validateWorkspace(projects));
  };
  const audit = (actor, action, payload = {}, revision = null) => {
    // Les destinataires d’une action notifiée la voient arriver aussitôt dans leur boîte.
    if (
      NOTIFIED.includes(action) &&
      !(action === 'comment.created' && payload.executionId) &&
      payload.recipientIds?.length
    )
      emit({ type: 'notifications', userIds: payload.recipientIds });
    return db
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
  };
  const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const findCard = (projectId, cardId) => {
    const project = readProjects().find(p => p.id === projectId);
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
  // Enregistre un nouvel état validé : exécutions IA, auteurs et dates, historique, abonnements.
  const commit = (before, clean, actor, { restore = false } = {}) => {
    const date = new Date().toISOString();
    workflows.reconcile(before.projects, clean, actor, restore);
    const events = restore
      ? [{ action: 'workspace.restored' }]
      : attributeChanges(validateWorkspace(before.projects), clean, actor, date);
    writeProjects(clean, date);
    const kept = new Set(clean.map(project => project.id));
    for (const project of before.projects) if (!kept.has(project.id)) access.forgetProject(project.id);
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
    for (const { card_id } of db.prepare('SELECT DISTINCT card_id FROM card_subscriptions').all()) {
      if (!survivingCards.has(card_id)) db.prepare('DELETE FROM card_subscriptions WHERE card_id = ?').run(card_id);
    }
  };
  return {
    workflows,
    // Abonnement aux événements validés ; renvoie la fonction de désabonnement.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recordDriveRelease(repository, data) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!this.read().projects.some(project => workflows.githubProject(project.id)?.toLowerCase() === repository))
          return { updated: false };
        let release;
        try {
          release = validateDriveRelease(data, repository, data.version);
        } catch {
          return { updated: false };
        }
        const row = db
          .prepare('SELECT data FROM github_downloads WHERE repository=? AND tag=?')
          .get(repository, release.version);
        if (row && (JSON.parse(row.data).commit !== release.commit || isDeepStrictEqual(JSON.parse(row.data), release)))
          return { updated: false };
        db.prepare(
          'INSERT INTO github_downloads VALUES(?,?,?) ON CONFLICT(repository,tag) DO UPDATE SET data=excluded.data',
        ).run(repository, release.version, JSON.stringify(release));
        synchronizeInfos();
        return { updated: true };
      });
    },
    driveArchive(repository, tag) {
      const row = db
        .prepare('SELECT data FROM drive_archives WHERE repository=? AND tag=?')
        .get(repository.toLowerCase(), tag);
      return row ? JSON.parse(row.data) : null;
    },
    recordDriveArchive(repository, tag, data) {
      db.prepare(
        'INSERT INTO drive_archives VALUES(?,?,?) ON CONFLICT(repository,tag) DO UPDATE SET data=excluded.data',
      ).run(repository.toLowerCase(), tag, JSON.stringify(data));
    },
    recordDriveRepository(repository, data) {
      db.prepare(
        'INSERT INTO drive_repositories VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data',
      ).run(repository.toLowerCase(), JSON.stringify(data));
    },
    driveStatus(repository) {
      repository = repository.toLowerCase();
      const checked = db.prepare('SELECT data FROM drive_repositories WHERE repository=?').get(repository);
      const { error = '', checkedAt = '' } = checked ? JSON.parse(checked.data) : {};
      const releases = db
        .prepare('SELECT tag,data FROM drive_archives WHERE repository=?')
        .all(repository)
        .map(row => {
          const { state, message, folderId, files, date } = JSON.parse(row.data);
          return {
            tag: row.tag,
            state,
            message,
            date,
            files: files || [],
            ...(folderId ? { folderUrl: `https://drive.google.com/drive/folders/${folderId}` } : {}),
          };
        })
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 10);
      return { checkedAt, repositoryError: error, releases };
    },
    recordGithubChangelog(repository, releases) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!this.read().projects.some(project => workflows.githubProject(project.id)?.toLowerCase() === repository))
          return;
        for (const release of releases) {
          if (
            !release ||
            release.draft ||
            typeof release.tag_name !== 'string' ||
            !release.tag_name.trim() ||
            release.tag_name.length > 140 ||
            !release.published_at ||
            !Number.isFinite(Date.parse(release.published_at))
          )
            continue;
          const entry = {
            tag: release.tag_name,
            date: new Date(release.published_at).toISOString(),
            body:
              typeof release.body === 'string'
                ? release.body
                    .replace(/<!-- planifikateur-drive\n[\s\S]*?\n-->/g, '')
                    .trim()
                    .slice(0, 20000)
                : '',
          };
          db.prepare(
            'INSERT INTO github_changelog VALUES(?,?,?) ON CONFLICT(repository,tag) DO UPDATE SET data=excluded.data',
          ).run(repository, entry.tag, JSON.stringify(entry));
        }
        synchronizeInfos();
      });
    },
    githubVersion(repository) {
      const row = db.prepare('SELECT data FROM github_versions WHERE repository=?').get(repository.toLowerCase());
      return row ? JSON.parse(row.data) : null;
    },
    refreshInfos() {
      return transaction(synchronizeInfos);
    },
    recordGithubVersion(repository, version) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!this.read().projects.some(project => workflows.githubProject(project.id)?.toLowerCase() === repository))
          return { updated: false };
        if (
          typeof version.tag !== 'string' ||
          !version.tag.trim() ||
          version.tag.length > 140 ||
          /[\u0000-\u001f]/.test(version.tag) ||
          (version.date && !Number.isFinite(Date.parse(version.date)))
        )
          return { updated: false };
        const previous = this.githubVersion(repository);
        // Do not replace a newer signed push with a stale API response.
        if (previous?.date && (!version.date || Date.parse(previous.date) > Date.parse(version.date)))
          return { updated: false };
        if (isDeepStrictEqual(previous, version)) return { updated: false };
        db.prepare(
          'INSERT INTO github_versions VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data',
        ).run(repository, JSON.stringify(version));
        synchronizeInfos();
        return { updated: true };
      });
    },
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
      const project = this.read().projects.find(project => project.id === projectId);
      if (!project) fail(404, 'project_not_found', 'Projet inexistant.');
      const members = activeMembers(projectId);
      // Une seule lecture des préférences pour toutes les cartes du projet.
      const prefsByCard = new Map(project.cards.map(card => [card.id, []]));
      for (const row of db.prepare('SELECT card_id,user_id,following FROM card_subscriptions').all())
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
        activity:
          activityDays > 0 ? db.prepare('DELETE FROM activity WHERE date < ?').run(cutoff(activityDays)).changes : 0,
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
    // Tableau vu par un compte : seulement ses projets, avec son rôle sur chacun (`access`).
    readFor(user) {
      const workspace = this.read();
      const roles = access.map(
        user,
        workspace.projects.map(project => project.id),
      );
      return { ...workspace, projects: workspace.projects.filter(project => roles[project.id]), access: roles };
    },
    projectRole: (user, projectId) => access.role(user, projectId),
    mergeApproval: projectId => access.mergeApproval(projectId),
    configureMergeApproval(projectId, data, actor) {
      return transaction(() => {
        this.requireProject(actor, projectId, 'manager');
        if (!data || typeof data.required !== 'boolean' || Object.keys(data).length !== 1)
          fail(400, 'invalid_approval', 'Envoyez { "required": true } ou { "required": false }.');
        access.setMergeApproval(projectId, data.required);
        audit(actor, 'project.approval_changed', {
          projectId,
          projectName: this.read().projects.find(project => project.id === projectId)?.name,
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
      const current = this.read().projects.some(project => project.id === projectId) && access.role(user, projectId);
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
    projectAccess(projectId) {
      const explicit = access.explicit(projectId);
      return {
        memberRole: access.policy(projectId),
        members: db
          .prepare('SELECT * FROM users WHERE active = 1 AND password_hash IS NOT NULL ORDER BY name,id')
          .all()
          .map(user => ({
            id: user.id,
            name: user.name,
            admin: user.role === 'admin',
            role: access.role(publicUser(user), projectId),
            explicit: user.role === 'admin' ? null : explicit[user.id] || null,
          })),
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
          projectName: this.read().projects.find(project => project.id === projectId)?.name,
          details: { memberRole: data.memberRole, members },
          recipientIds: Object.keys(members),
        });
        return this.projectAccess(projectId);
      });
    },
    // Remplace tout le tableau, à condition que la session ait lu la révision courante.
    write(projects, revision, actor = null, { restore = false } = {}) {
      return transaction(() => {
        const before = this.read();
        if (before.revision !== revision) return null;
        commit(before, validateWorkspace(projects), actor, { restore });
        return this.read();
      });
    },
    // Applique des modifications fines (voir src/lib/workspace-changes.js) sur l’état courant,
    // sans exiger de révision. Les modifications dont la cible a disparu sont ignorées et
    // renvoyées dans `skipped` ; avec `strict`, elles annulent tout.
    change(changes, actor, { strict = false } = {}) {
      return transaction(() => {
        const before = this.read();
        if (!Array.isArray(changes)) fail(400, 'invalid_change', 'Une liste de modifications est requise.');
        // Droits par projet : un projet masqué se comporte comme un projet inexistant ; un rôle
        // insuffisant sur un projet visible refuse tout le lot.
        const roles = access.map(
          actor,
          before.projects.map(project => project.id),
        );
        const existing = new Set(before.projects.map(project => project.id));
        const allowed = [],
          hidden = [];
        changes.forEach((change, index) => {
          const needs = requirements(change);
          if (needs.some(([projectId]) => existing.has(projectId) && !roles[projectId]))
            return hidden.push({ index, type: change?.type, reason: 'missing' });
          const refused = needs.find(([projectId, role]) => existing.has(projectId) && !allows(roles[projectId], role));
          if (refused)
            fail(
              403,
              'project_forbidden',
              refused[1] === 'manager'
                ? 'Seuls les responsables du projet peuvent confier une carte à l’agent ou gérer le projet.'
                : 'Votre rôle sur ce projet ne permet que la lecture.',
            );
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
        result.skipped = [...hidden, ...result.skipped.map(item => ({ ...item, index: allowed[item.index] }))].sort(
          (a, b) => a.index - b.index,
        );
        const refused = strict && result.skipped[0];
        if (refused)
          fail(
            refused.reason === 'missing' ? 404 : 409,
            `change_${refused.reason}`,
            refused.reason === 'missing'
              ? 'Élément inexistant : il a peut-être été supprimé.'
              : refused.reason === 'exists'
                ? 'Cet identifiant est déjà utilisé.'
                : 'Déplacez ou supprimez d’abord les cartes de cette liste.',
          );
        let clean;
        try {
          clean = validateWorkspace(result.projects);
        } catch (error) {
          fail(400, 'invalid_workspace', error.message);
        }
        // Rien à enregistrer (modifications ignorées ou déjà appliquées) : la révision ne bouge pas.
        if (JSON.stringify(clean) !== JSON.stringify(before.projects)) commit(before, clean, actor);
        return { ...this.readFor(actor), skipped: result.skipped };
      });
    },
    hasUsers() {
      return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
    },
    userByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    },
    userById,
    bootstrapUser(fields, passwordHash) {
      return transaction(() => {
        if (this.hasUsers()) fail(409, 'already_initialized', 'Le compte administrateur a déjà été créé.');
        const id = randomUUID();
        db.prepare("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'admin',?)").run(
          id,
          fields.email,
          fields.name,
          passwordHash,
          new Date().toISOString(),
        );
        const user = publicUser(userById(id));
        audit(user, 'account.created', { userId: id });
        return user;
      });
    },
    users() {
      return db.prepare('SELECT * FROM users ORDER BY created_at, id').all().map(publicUser);
    },
    inviteUser(fields, actor, existingId = null) {
      return transaction(() => {
        const token = randomBytes(32).toString('hex'),
          expires = Date.now() + 7 * 86400000;
        let id = existingId;
        if (id) {
          const existing = userById(id);
          if (!existing || !existing.active) fail(404, 'user_not_found', 'Compte actif inexistant.');
          if (existing.id === actor.id || existing.role === 'admin')
            fail(400, 'invalid_invitation', 'Ce compte ne peut pas être réinvité.');
          db.prepare('UPDATE users SET invite_hash = ?, invite_expires = ? WHERE id = ?').run(
            tokenHash(token),
            expires,
            id,
          );
        } else {
          if (this.userByEmail(fields.email)) fail(409, 'email_exists', 'Un compte utilise déjà cette adresse.');
          if (this.users().length >= 100) fail(400, 'user_limit', 'La limite de 100 comptes est atteinte.');
          id = randomUUID();
          db.prepare(
            "INSERT INTO users(id,email,name,role,invite_hash,invite_expires,created_at) VALUES(?,?,?,'member',?,?,?)",
          ).run(id, fields.email, fields.name, tokenHash(token), expires, new Date().toISOString());
        }
        audit(actor, 'account.invited', { userId: id });
        return { user: publicUser(userById(id)), token, expiresAt: new Date(expires).toISOString() };
      });
    },
    invitation(token) {
      return db
        .prepare('SELECT * FROM users WHERE invite_hash = ? AND invite_expires > ? AND active = 1')
        .get(tokenHash(token), Date.now());
    },
    acceptInvitation(token, name, passwordHash) {
      return transaction(() => {
        const user = this.invitation(token);
        if (!user) fail(400, 'invalid_invitation', 'Invitation invalide, expirée ou déjà utilisée.');
        db.prepare(
          'UPDATE users SET name = ?, password_hash = ?, invite_hash = NULL, invite_expires = NULL WHERE id = ?',
        ).run(name, passwordHash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        const result = publicUser(userById(user.id));
        audit(result, 'account.activated', { userId: user.id });
        return result;
      });
    },
    setActive(id, active, actor) {
      return transaction(() => {
        const user = userById(id);
        if (!user) fail(404, 'user_not_found', 'Compte inexistant.');
        if (id === actor.id || user.role === 'admin')
          fail(400, 'protected_admin', 'Le compte administrateur ne peut pas être désactivé.');
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        audit(actor, active ? 'account.enabled' : 'account.disabled', { userId: id });
        return publicUser(userById(id));
      });
    },
    deleteUser(id, actor) {
      return transaction(() => {
        const user = userById(id);
        if (!user) fail(404, 'user_not_found', 'Compte inexistant.');
        if (id === actor.id || user.role === 'admin')
          fail(400, 'protected_admin', 'Le compte administrateur ne peut pas être supprimé.');
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM card_subscriptions WHERE user_id = ?').run(id);
        access.forgetUser(id);
        db.prepare('DELETE FROM notification_reads WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        audit(actor, 'account.deleted', { userId: id, userName: user.name });
        return { deleted: true };
      });
    },
    changePassword(id, passwordHash, actor) {
      transaction(() => {
        db.prepare('UPDATE users SET password_hash = ?, invite_hash = NULL, invite_expires = NULL WHERE id = ?').run(
          passwordHash,
          id,
        );
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        audit(actor, 'account.password_changed', { userId: id });
      });
    },
    // Préférences personnelles d’affichage : propres au compte, jamais exposées aux autres.
    preferences(userId) {
      const row = db.prepare('SELECT accent FROM user_preferences WHERE user_id = ?').get(userId);
      return { accent: isAccent(row?.accent) ? row.accent : DEFAULT_ACCENT };
    },
    setAccent(userId, accent) {
      db.prepare('DELETE FROM user_preferences WHERE user_id = ?').run(userId);
      if (accent !== DEFAULT_ACCENT) db.prepare('INSERT INTO user_preferences VALUES(?,?)').run(userId, accent);
      return this.preferences(userId);
    },
    createSession(userId) {
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + 12 * 3600000);
      return token;
    },
    session(token) {
      if (!token) return null;
      return publicUser(
        db
          .prepare(
            'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1 AND u.password_hash IS NOT NULL',
          )
          .get(tokenHash(token), Date.now()),
      );
    },
    deleteSession(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    },
    // Notifications d’un compte : actions qui le concernent sur les projets qu’il voit, les plus
    // récentes d’abord, avec le nombre de non lues (après le dernier identifiant marqué comme lu).
    notifications(user, { limit = 30 } = {}) {
      const visible = JSON.stringify(Object.keys(this.readFor(user).access));
      const where = `${NOTIFIED_SQL} AND EXISTS (SELECT 1 FROM json_each(payload, '$.recipientIds') WHERE value = ?) AND (project_id IS NULL OR project_id IN (SELECT value FROM json_each(?)))`;
      const lastReadId =
        db.prepare('SELECT last_id FROM notification_reads WHERE user_id = ?').get(user.id)?.last_id ?? 0;
      const items = db
        .prepare(`SELECT * FROM activity WHERE ${where} ORDER BY id DESC LIMIT ?`)
        .all(user.id, visible, limit)
        .map(row => {
          const { projectName, cardTitle, details, executionId } = JSON.parse(row.payload);
          return {
            id: row.id,
            date: row.date,
            action: row.action,
            actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : { id: null, name: row.actor_name },
            projectId: row.project_id,
            projectName: projectName || null,
            cardId: row.card_id,
            cardTitle: cardTitle || null,
            ...(details ? { details } : {}),
            ...(executionId ? { executionId } : {}),
            read: row.id <= lastReadId,
          };
        });
      const unread = db
        .prepare(`SELECT COUNT(*) AS n FROM activity WHERE ${where} AND id > ?`)
        .get(user.id, visible, lastReadId).n;
      return { items, unread, lastReadId };
    },
    // Marque comme lues les notifications jusqu’à `upTo` inclus (jamais en arrière).
    readNotifications(user, upTo) {
      if (!Number.isSafeInteger(upTo) || upTo < 0) fail(400, 'invalid_notification', 'upTo : identifiant attendu.');
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM activity').get().id;
      db.prepare(
        'INSERT INTO notification_reads VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)',
      ).run(user.id, Math.min(upTo, max));
      emit({ type: 'notifications', userIds: [user.id] });
      return this.notifications(user, { limit: 0 });
    },
    // `visible` limite l’historique global aux projets d’un compte (les actions sans projet restent).
    activity({ projectId, cardId, before = Number.MAX_SAFE_INTEGER, limit = 50, visible = null } = {}) {
      const rows = db
        .prepare(
          'SELECT * FROM activity WHERE id < ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR card_id = ?) AND (? IS NULL OR project_id IS NULL OR project_id IN (SELECT value FROM json_each(?))) ORDER BY id DESC LIMIT ?',
        )
        .all(
          before,
          projectId || null,
          projectId || null,
          cardId || null,
          cardId || null,
          visible && JSON.stringify(visible),
          visible && JSON.stringify(visible),
          limit,
        );
      return rows.map(row => ({
        ...JSON.parse(row.payload),
        id: row.id,
        date: row.date,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name } : null,
        action: row.action,
        revision: row.revision,
      }));
    },
    close() {
      db.close();
    },
  };
}
