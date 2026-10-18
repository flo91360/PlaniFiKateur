import { randomUUID, randomBytes } from 'node:crypto';
import { publicUser, tokenHash } from '../accounts.js';
import { DEFAULT_ACCENT, isAccent } from '../../src/lib/accents.js';
import { fail } from '../http.js';

// Comptes : administrateur initial, invitations, activation, mots de passe, préférences et sessions.
export function createAccountStore({ db, transaction, audit, access, userById }) {
  return {
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
        db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
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
  };
}
