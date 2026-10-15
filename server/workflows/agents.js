import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from '../http.js';
import { canTransition, transition } from '../execution-states.js';
import { tokenHash } from '../accounts.js';
import { OPEN, text } from './core.js';

// Identités des agents : clé (seule son empreinte est gardée), projets autorisés, révocation.
// Retirer un projet ou révoquer la clé interrompt les exécutions en cours de cet agent.
export function createAgents(db, { transaction, audit, readProjects }, { rows, unpack, save }) {
  const publicAgent = row => ({
    id: row.id,
    name: row.name,
    projectIds: JSON.parse(row.projects),
    active: !!row.active,
  });
  const agents = () => db.prepare('SELECT * FROM agents ORDER BY rowid DESC').all().map(publicAgent);
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
        const projects = readProjects();
        if (data.projectIds.some(id => !projects.some(p => p.id === id)))
          fail(400, 'invalid_work', 'Projet inexistant.');
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
