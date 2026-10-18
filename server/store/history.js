import { fail } from '../http.js';

// Notifications des comptes et historique des actions.
export function createHistoryStore({ db, emit }) {
  return {
    // Notifications d’un compte : actions qui le concernent sur les projets qu’il voit, les plus
    // récentes d’abord, avec le nombre de non lues (après le dernier identifiant marqué comme lu).
    notifications(user, { limit = 30 } = {}) {
      const visible = JSON.stringify(Object.keys(this.accessOf(user)));
      const from = `FROM notifications n JOIN activity a ON a.id = n.activity_id WHERE n.user_id = ? AND (a.project_id IS NULL OR a.project_id IN (SELECT value FROM json_each(?)))`;
      const lastReadId =
        db.prepare('SELECT last_id FROM notification_reads WHERE user_id = ?').get(user.id)?.last_id ?? 0;
      const items = db
        .prepare(`SELECT a.* ${from} ORDER BY n.activity_id DESC LIMIT ?`)
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
        .prepare(`SELECT COUNT(*) AS n ${from} AND n.activity_id > ?`)
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
    // `visible` limite l’historique global aux projets d’un compte ; les actions sans projet
    // (comptes, agents) ne sont montrées qu’aux administrateurs (`visible` absent).
    activity({ projectId, cardId, before = Number.MAX_SAFE_INTEGER, limit = 50, visible = null } = {}) {
      const rows = db
        .prepare(
          'SELECT * FROM activity WHERE id < ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR card_id = ?) AND (? IS NULL OR project_id IN (SELECT value FROM json_each(?))) ORDER BY id DESC LIMIT ?',
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
  };
}
