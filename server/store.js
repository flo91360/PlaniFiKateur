import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { withInfos } from '../src/lib/infos.js';
import { seed } from '../src/data/demo.js';
import { validateWorkspace } from '../src/lib/workspace.js';
import { publicUser, tokenHash } from './accounts.js';
import { attributeChanges } from './activity.js';
import { createWorkflows } from './workflows.js';
import { validateDriveRelease } from '../src/lib/drive-release.js';
import { fail } from './http.js';
import { notificationRecipients } from './recipients.js';
import { migrateWorkspace, readWorkspace, writeWorkspace } from './workspace-tables.js';
import { applyChanges, ChangeError } from '../src/lib/workspace-changes.js';

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
    CREATE TABLE IF NOT EXISTS drive_repositories (repository TEXT PRIMARY KEY, data TEXT NOT NULL);`);
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
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const readProjects = () => readWorkspace(db);
  // Toute écriture du contenu augmente la révision (sauf `revision: false`, quand une écriture
  // suivante de la même transaction s’en charge) : les navigateurs actualisent leur tableau.
  const writeProjects = (projects, date = new Date().toISOString(), { revision = true } = {}) => {
    writeWorkspace(db, projects);
    if (revision) db.prepare('UPDATE workspace SET revision = revision + 1, updated_at = ? WHERE id = 1').run(date);
  };
  const synchronizeInfos = () => {
    const previous = readProjects();
    const projects = previous.map(project => withInfos(project, versionFor(project.id)));
    // Comment migrations may reorder properties without changing their values.
    // Only an actual Infos change should increment the workspace revision.
    if (!isDeepStrictEqual(projects, previous)) writeProjects(validateWorkspace(projects));
  };
  const audit = (actor, action, payload = {}, revision = null) =>
    db
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
  const activeMembers = () =>
    db.prepare('SELECT id,name FROM users WHERE active = 1 AND password_hash IS NOT NULL ORDER BY name,id').all();
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
  const workflows = createWorkflows(db, { transaction, audit, findCard, readProjects, writeProjects, recipients });
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
  // Enregistre un nouvel état validé : exécutions IA, auteurs et dates, historique, abonnements.
  const commit = (before, clean, actor, { restore = false } = {}) => {
    const date = new Date().toISOString();
    workflows.reconcile(before.projects, clean, actor, restore);
    const events = restore
      ? [{ action: 'workspace.restored' }]
      : attributeChanges(validateWorkspace(before.projects), clean, actor, date);
    writeProjects(clean, date);
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
      return activeMembers().map(user => ({ ...user, following: following(card, user.id, prefs) }));
    },
    projectCardFollowers(projectId) {
      const project = this.read().projects.find(project => project.id === projectId);
      if (!project) fail(404, 'project_not_found', 'Projet inexistant.');
      const members = activeMembers();
      return Object.fromEntries(
        project.cards.map(card => {
          const prefs = preferences(card.id);
          return [card.id, members.filter(member => following(card, member.id, prefs))];
        }),
      );
    },
    setSubscription(projectId, cardId, actor, enabled, userId = actor.id) {
      return transaction(() => {
        const { project, card } = findCard(projectId, cardId);
        const target = userById(userId);
        if (!target?.active || !target.password_hash)
          fail(400, 'invalid_subscriber', 'Choisissez un membre actif du projet.');
        const previous = preferences(cardId).find(row => row.user_id === userId);
        if (!previous || !!previous.following !== enabled) {
          db.prepare(
            'INSERT INTO card_subscriptions VALUES(?,?,?) ON CONFLICT(card_id,user_id) DO UPDATE SET following = excluded.following',
          ).run(cardId, userId, enabled ? 1 : 0);
          audit(actor, userId !== actor.id ? 'card.subscriber_added' : enabled ? 'card.followed' : 'card.unfollowed', {
            projectId,
            projectName: project.name,
            cardId,
            cardTitle: card.title,
            subscriberId: userId,
            subscriberName: target.name,
            recipientIds: [],
          });
        }
        return { following: enabled };
      });
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
        let result;
        try {
          result = applyChanges(before.projects, changes);
        } catch (error) {
          if (error instanceof ChangeError) fail(400, 'invalid_change', error.message);
          throw error;
        }
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
        if (JSON.stringify(clean) === JSON.stringify(before.projects)) return { ...before, skipped: result.skipped };
        commit(before, clean, actor);
        return { ...this.read(), skipped: result.skipped };
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
    activity({ projectId, cardId, before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
      const rows = db
        .prepare(
          'SELECT * FROM activity WHERE id < ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR card_id = ?) ORDER BY id DESC LIMIT ?',
        )
        .all(before, projectId || null, projectId || null, cardId || null, cardId || null, limit);
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
