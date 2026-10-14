// Droits par projet. Chaque compte a sur un projet un rôle :
//   viewer  (lecture)      : voir le projet, ses cartes, discussions et exécutions ;
//   editor  (contribution) : modifier les cartes et les listes, commenter, annuler une exécution ;
//   manager (responsable)  : confier une carte à l’agent, valider ou corriger son travail,
//                            gérer le projet et ses membres.
// Le rôle vient d’abord des membres nommés du projet, sinon du rôle donné aux autres membres
// (`none` masque le projet). Un administrateur est responsable de tous les projets.
export const ROLES = ['viewer', 'editor', 'manager'];
export const MEMBER_ROLES = ['none', ...ROLES];
export const DEFAULT_MEMBER_ROLE = 'editor';
const RANK = { viewer: 1, editor: 2, manager: 3 };

export const allows = (role, wanted) => (RANK[role] || 0) >= RANK[wanted];

// Rôle nécessaire pour une modification fine (src/lib/workspace-changes.js), par projet visé.
// Placer une carte dans « Prête à démarrer » la confie à l’agent : c’est réservé aux responsables.
export function requirements(change) {
  const [kind, action] = String(change?.type).split('.');
  if (kind === 'project') return ['update', 'delete'].includes(action) ? [[change.projectId, 'manager']] : [];
  if (kind === 'card' && action === 'create')
    return [[change.projectId, change.card?.status === 'ready' ? 'manager' : 'editor']];
  if (kind === 'card' && action === 'update')
    return [[change.projectId, change.fields?.status === 'ready' ? 'manager' : 'editor']];
  return [[change?.projectId, 'editor']];
}

export function createAccess(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_policies (project_id TEXT PRIMARY KEY, member_role TEXT NOT NULL CHECK(member_role IN ('none','viewer','editor','manager')));
    CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','editor','manager')), PRIMARY KEY(project_id,user_id));`);
  const policy = projectId =>
    db.prepare('SELECT member_role FROM project_policies WHERE project_id = ?').get(projectId)?.member_role ??
    DEFAULT_MEMBER_ROLE;
  const effective = (user, explicit, memberRole) => {
    if (!user?.id || user.active === false) return null;
    if (user.role === 'admin') return 'manager';
    const role = explicit ?? memberRole;
    return role === 'none' ? null : role;
  };
  return {
    policy,
    // Rôle effectif d’un compte sur un projet, ou null s’il ne le voit pas.
    role(user, projectId) {
      const explicit = user?.id
        ? db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id)
            ?.role
        : null;
      return effective(user, explicit, policy(projectId));
    },
    // Rôles d’un compte sur plusieurs projets : { projectId: rôle } pour les seuls projets visibles.
    map(user, projectIds) {
      const policies = new Map(
        db
          .prepare('SELECT project_id, member_role FROM project_policies')
          .all()
          .map(row => [row.project_id, row.member_role]),
      );
      const explicit = new Map(
        user?.id
          ? db
              .prepare('SELECT project_id, role FROM project_members WHERE user_id = ?')
              .all(user.id)
              .map(row => [row.project_id, row.role])
          : [],
      );
      const roles = {};
      for (const id of projectIds) {
        const role = effective(user, explicit.get(id), policies.get(id) ?? DEFAULT_MEMBER_ROLE);
        if (role) roles[id] = role;
      }
      return roles;
    },
    // Nouveau projet : règle par défaut et, s’il n’est pas administrateur, créateur responsable.
    adopt(projectId, creator) {
      db.prepare('INSERT OR IGNORE INTO project_policies VALUES (?, ?)').run(projectId, DEFAULT_MEMBER_ROLE);
      if (creator?.id && creator.role !== 'admin')
        db.prepare(
          "INSERT INTO project_members VALUES (?, ?, 'manager') ON CONFLICT(project_id,user_id) DO UPDATE SET role = 'manager'",
        ).run(projectId, creator.id);
    },
    hasPolicy: projectId => !!db.prepare('SELECT 1 FROM project_policies WHERE project_id = ?').get(projectId),
    // Membres nommés d’un projet : { userId: rôle }.
    explicit(projectId) {
      return Object.fromEntries(
        db
          .prepare('SELECT user_id, role FROM project_members WHERE project_id = ?')
          .all(projectId)
          .map(row => [row.user_id, row.role]),
      );
    },
    configure(projectId, { memberRole, members = {} }) {
      if (memberRole !== undefined)
        db.prepare(
          'INSERT INTO project_policies VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET member_role = excluded.member_role',
        ).run(projectId, memberRole);
      for (const [userId, role] of Object.entries(members)) {
        if (role === null)
          db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
        else
          db.prepare(
            'INSERT INTO project_members VALUES (?, ?, ?) ON CONFLICT(project_id,user_id) DO UPDATE SET role = excluded.role',
          ).run(projectId, userId, role);
      }
    },
    forgetProject(projectId) {
      db.prepare('DELETE FROM project_policies WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    },
    forgetUser(userId) {
      db.prepare('DELETE FROM project_members WHERE user_id = ?').run(userId);
    },
  };
}
