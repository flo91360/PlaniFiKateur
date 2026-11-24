import { withProjectLists } from '../../src/lib/discussion-list.js';
import { validateWorkspace } from '../../src/lib/workspace.js';

// Migrations des projets jouées une seule fois (voir migrations.js), dans l’ordre de leur version.
// `settings` : tables des réglages par projet (PROJECT_SETTINGS de store.js).
export function projectMigrations({
  db,
  access,
  workflows,
  settings,
  readProjects,
  writeProjects,
  userById,
  forgetProject,
}) {
  // v3 — projets antérieurs aux listes « Discussion » et « À tester » : elles sont ajoutées
  // (l’ancienne liste « Terminées » renommée), les tâches livrées rangées et les cartes de
  // discussion retirées de la file de l’agent. Un tableau restauré les reçoit à l’écriture.
  const addProjectLists = () => {
    const previous = readProjects();
    const projects = previous.map(withProjectLists);
    if (projects.some((project, index) => project !== previous[index])) {
      const clean = validateWorkspace(projects, { attachmentData: false });
      workflows.withdrawDiscussion(clean, null);
      writeProjects(clean, undefined, { previous });
    }
  };
  // v4 — projets antérieurs aux droits par projet : règle par défaut, et leur créateur (d’après
  // l’historique) en devient responsable. Un projet créé ensuite reçoit sa règle à l’écriture.
  const adoptProjects = () => {
    for (const project of readProjects())
      if (!access.hasPolicy(project.id)) {
        const creator = db
          .prepare(
            "SELECT actor_id FROM activity WHERE action = 'project.created' AND project_id = ? ORDER BY id LIMIT 1",
          )
          .get(project.id)?.actor_id;
        access.adopt(project.id, creator ? userById(creator) : null);
      }
  };
  // v5 — projets supprimés avant la 0.1.31 : leurs réglages restaient en place. Ils sont effacés,
  // et les identifiants de projets supprimés d’après l’historique sont réservés.
  const forgetDeletedProjects = () => {
    const current = new Set(readProjects().map(project => project.id));
    const leftovers = new Set(
      [
        ...settings.flatMap(table =>
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
  };
  return [
    { version: 3, run: addProjectLists },
    { version: 4, run: adoptProjects },
    { version: 5, run: forgetDeletedProjects },
  ];
}
