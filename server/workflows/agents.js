import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.js';
import { canTransition, transition } from '../execution-states.js';
import { tokenHash } from '../accounts.js';
import { OPEN, text } from './core.js';

// Identités des agents : clé (seule son empreinte est gardée), projets autorisés, révocation.
// Retirer un projet ou révoquer la clé interrompt les exécutions en cours de cet agent.
export function createAgents(db, { transaction, audit }, { rows, unpack, save }) {
  const publicAgent = row => ({
    id: row.id,
    name: row.name,
    projectIds: JSON.parse(row.projects),
    active: !!row.active,
  });
  // Suivi du worker : dernier contact (toute requête avec sa clé, enregistrée au plus une fois par
  // minute), révision qu’il exécute et dernier passage du programme de mise à jour du VPS.
  const statusOf = id => {
    const row = db.prepare('SELECT data FROM agent_status WHERE agent_id=?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const writeStatus = (id, status) =>
    db
      .prepare('INSERT INTO agent_status VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data')
      .run(id, JSON.stringify(status));
  const seen = new Map();
  const agents = () =>
    db
      .prepare('SELECT * FROM agents ORDER BY rowid DESC')
      .all()
      .map(row => ({ ...publicAgent(row), status: statusOf(row.id) }));
  const interrupt = (action, concerned, reason, actor) => {
    for (const row of rows(OPEN))
      if (concerned(row)) {
        const run = transition(unpack(row), action);
        run.interruption = reason;
        save(run, actor, 'interrupted');
      }
  };
  const requireActive = id => {
    if (!db.prepare('SELECT id FROM agents WHERE id=? AND active=1').get(id))
      fail(404, 'agent_not_found', 'Agent actif inexistant.');
  };
  return {
    agents,
    agent(token) {
      const row = db.prepare('SELECT * FROM agents WHERE token_hash=? AND active=1').get(tokenHash(token || ''));
      return row ? publicAgent(row) : null;
    },
    touchAgent(agent, now = Date.now()) {
      if (now - (seen.get(agent.id) || 0) < 60000) return;
      seen.set(agent.id, now);
      writeStatus(agent.id, { ...statusOf(agent.id), lastSeenAt: new Date(now).toISOString() });
    },
    // Révision annoncée par le worker à son démarrage, ou résultat du programme de mise à jour du VPS
    // (state ok, waiting ou failed, avec son message et les révisions déployée et attendue).
    recordAgentStatus(agent, data) {
      const sha = (value, min = 40) =>
        value === undefined || (typeof value === 'string' && new RegExp(`^[0-9a-f]{${min},40}$`).test(value));
      const { revision, update } = data || {};
      if (
        (revision === undefined && update === undefined) ||
        !sha(revision, 7) ||
        (update !== undefined &&
          (!update ||
            typeof update !== 'object' ||
            !['ok', 'waiting', 'failed'].includes(update.state) ||
            typeof update.message !== 'string' ||
            !update.message.trim() ||
            update.message.length > 500 ||
            !sha(update.revision) ||
            !sha(update.latest)))
      )
        fail(400, 'invalid_status', 'État du worker invalide.');
      const date = new Date().toISOString(),
        status = { ...statusOf(agent.id) };
      if (revision !== undefined) Object.assign(status, { revision, startedAt: date });
      if (update !== undefined)
        status.update = {
          state: update.state,
          message: update.message.trim(),
          ...(update.revision ? { revision: update.revision } : {}),
          ...(update.latest ? { latest: update.latest } : {}),
          date,
          // Début de la situation actuelle : « en échec depuis… ».
          since: status.update?.state === update.state ? status.update.since : date,
        };
      writeStatus(agent.id, status);
      return status;
    },
    configureAgent(data, actor, id = null) {
      return transaction(() => {
        const name = text(data?.name, 'Nom de l’agent', 80);
        if (
          !Array.isArray(data.projectIds) ||
          !data.projectIds.length ||
          data.projectIds.length > 100 ||
          data.projectIds.some(p => typeof p !== 'string')
        )
          fail(400, 'invalid_work', 'Sélectionnez au moins un projet.');
        const projects = new Set(
          db
            .prepare('SELECT id FROM projects')
            .all()
            .map(project => project.id),
        );
        if (data.projectIds.some(id => !projects.has(id))) fail(400, 'invalid_work', 'Projet inexistant.');
        const projectIds = JSON.stringify([...new Set(data.projectIds)]);
        if (id) {
          requireActive(id);
          db.prepare('UPDATE agents SET name=?,projects=? WHERE id=?').run(name, projectIds, id);
          interrupt(
            'unassign',
            row => JSON.parse(row.data).agent?.id === id && !data.projectIds.includes(row.project_id),
            'L’accès de l’agent au projet a été retiré.',
            actor,
          );
          audit(actor, 'agent.configured', { agentId: id });
          return { agent: agents().find(a => a.id === id) };
        }
        if (agents().some(a => a.active)) fail(409, 'single_agent', 'Cette version accepte un seul agent actif.');
        id = randomUUID();
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO agents(id,name,token_hash,projects) VALUES(?,?,?,?)').run(
          id,
          name,
          tokenHash(token),
          projectIds,
        );
        audit(actor, 'agent.created', { agentId: id });
        return { agent: agents().find(a => a.id === id), token };
      });
    },
    revokeAgent(id, actor) {
      return transaction(() => {
        requireActive(id);
        db.prepare('UPDATE agents SET active=0 WHERE id=?').run(id);
        interrupt(
          'revoke',
          row => canTransition(row.state, 'revoke') && JSON.parse(row.data).agent?.id === id,
          'La clé de l’agent a été révoquée.',
          actor,
        );
        audit(actor, 'agent.revoked', { agentId: id });
        return { revoked: true };
      });
    },
  };
}
