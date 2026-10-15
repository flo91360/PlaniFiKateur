import { fail } from '../http.js';
import { validateAi } from '../../worker/ai-settings.mjs';
import { defaultExecutionProfile, validateExecutionProfile } from '../../worker/execution-profile.mjs';

// Réglages d’un projet pour l’agent : dépôt GitHub, moteur et modèle IA, profil d’exécution, et
// dernier diagnostic envoyé par le worker.
export function createSettings(db, { transaction, audit, readProjects }, { checkAgent }) {
  const githubProject = projectId =>
    db.prepare('SELECT repository FROM github_projects WHERE project_id=?').get(projectId)?.repository || null;
  const projectAi = projectId => {
    const row = db.prepare('SELECT data FROM project_ai WHERE project_id=?').get(projectId);
    return row ? JSON.parse(row.data) : { engine: 'codex', model: '' };
  };
  const executionProfile = projectId => {
    const row = db.prepare('SELECT data FROM project_execution WHERE project_id=?').get(projectId);
    return row ? JSON.parse(row.data) : defaultExecutionProfile(githubProject(projectId) || '');
  };
  // Configuration transmise au worker ; un diagnostic devient périmé dès qu’elle change.
  const configuration = projectId => ({
    repository: githubProject(projectId),
    ai: projectAi(projectId),
    executionProfile: executionProfile(projectId),
  });
  const requireProject = projectId => {
    if (!readProjects().some(project => project.id === projectId)) fail(404, 'project_not_found', 'Projet inexistant.');
  };
  // Enregistre un réglage validé ; une erreur de validation devient une réponse 400 avec `code`.
  const configure = (table, projectId, data, validate, code) => {
    let value;
    try {
      value = validate(data);
    } catch (error) {
      fail(400, code, error.message);
    }
    db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`).run(
      projectId,
      JSON.stringify(value),
    );
    return value;
  };
  return {
    githubProject,
    projectAi,
    executionProfile,
    workerStatus(projectId) {
      const rows = db
        .prepare(
          'SELECT s.data,a.projects FROM project_worker_status s JOIN agents a ON a.id=s.agent_id WHERE s.project_id=? AND a.active=1',
        )
        .all(projectId);
      const status = rows
        .filter(row => JSON.parse(row.projects).includes(projectId))
        .map(row => JSON.parse(row.data))
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!status) return null;
      return {
        ...status,
        stale:
          JSON.stringify(status.configuration) !== JSON.stringify(configuration(projectId)) ||
          Date.now() - Date.parse(status.date) > 5 * 60000,
      };
    },
    recordWorkerStatus(projectId, data, agent) {
      checkAgent(agent, projectId);
      if (
        !['ready', 'blocked'].includes(data?.state) ||
        !Array.isArray(data.checks) ||
        !data.checks.length ||
        data.checks.length > 12 ||
        data.checks.some(
          check =>
            !['ok', 'blocked', 'unknown'].includes(check.state) ||
            typeof check.name !== 'string' ||
            !check.name ||
            check.name.length > 100 ||
            typeof check.message !== 'string' ||
            check.message.length > 600,
        )
      )
        fail(400, 'invalid_diagnostic', 'Diagnostic du worker invalide.');
      const status = {
        state: data.state,
        checks: data.checks.map(({ name, state, message }) => ({ name, state, message })),
        date: new Date().toISOString(),
        agent: { id: agent.id, name: agent.name },
        configuration: configuration(projectId),
      };
      db.prepare(
        'INSERT INTO project_worker_status VALUES(?,?,?) ON CONFLICT(project_id,agent_id) DO UPDATE SET data=excluded.data',
      ).run(projectId, agent.id, JSON.stringify(status));
      return status;
    },
    configureExecution(projectId, data, actor) {
      return transaction(() => {
        requireProject(projectId);
        const profile = configure(
          'project_execution',
          projectId,
          data,
          validateExecutionProfile,
          'invalid_execution_profile',
        );
        audit(actor, 'project.execution_configured', { projectId, profile });
        return profile;
      });
    },
    agentProjects(agent) {
      const row = db.prepare('SELECT * FROM agents WHERE id=? AND active=1').get(agent.id);
      if (!row) fail(401, 'agent_unauthorized', 'Agent révoqué.');
      const ids = JSON.parse(row.projects);
      return readProjects()
        .filter(project => ids.includes(project.id))
        .map(project => ({ id: project.id, name: project.name, ...configuration(project.id) }));
    },
    configureAi(projectId, data, actor) {
      return transaction(() => {
        requireProject(projectId);
        const ai = configure('project_ai', projectId, data, validateAi, 'invalid_ai');
        audit(actor, 'project.ai_configured', { projectId, ...ai });
        return ai;
      });
    },
    configureGithub(projectId, repository, actor) {
      return transaction(() => {
        requireProject(projectId);
        if (
          typeof repository !== 'string' ||
          !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
          repository.length > 200
        )
          fail(400, 'invalid_repository', 'Indiquez le dépôt sous la forme propriétaire/dépôt.');
        db.prepare(
          'INSERT INTO github_projects VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET repository=excluded.repository',
        ).run(projectId, repository);
        audit(actor, 'github.configured', { projectId, repository });
        return { repository, branch: executionProfile(projectId).branch };
      });
    },
    // Projet supprimé : son dépôt, ses réglages IA et d’exécution et l’accès des agents disparaissent
    // avec lui (une restauration de sauvegarde les rétablit).
    forgetProject(projectId) {
      for (const table of ['github_projects', 'project_ai', 'project_execution', 'project_worker_status'])
        db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      for (const agent of db.prepare('SELECT id, projects FROM agents').all()) {
        const projects = JSON.parse(agent.projects);
        if (projects.includes(projectId))
          db.prepare('UPDATE agents SET projects = ? WHERE id = ?').run(
            JSON.stringify(projects.filter(id => id !== projectId)),
            agent.id,
          );
      }
    },
  };
}
