import { createSchema, createCore } from './workflows/core.js';
import { createSettings } from './workflows/settings.js';
import { createAgents } from './workflows/agents.js';
import { createGithub } from './workflows/github.js';
import { createRuns } from './workflows/runs.js';
import { createAgentActions } from './workflows/agent-actions.js';

export { LEASE_MS, MAX_CI_FAILURES } from './workflows/core.js';

// Parcours des exécutions IA, assemblé à partir des modules de server/workflows/ :
// - core : tables, lecture et enregistrement des exécutions, contrôles communs ;
// - settings : dépôt, moteur IA, profil d’exécution et diagnostic du worker par projet ;
// - agents : clés des agents et projets autorisés ;
// - runs : préparation, file, décisions humaines, vues et cohérence avec le tableau ;
// - agent-actions : transitions demandées par le worker (réservation, avancement, résultat) ;
// - github : contrôles, fusion et PR en attente.
export function createWorkflows(
  db,
  {
    transaction,
    audit,
    findCard,
    readProjects,
    writeProjects,
    recipients,
    emit = () => {},
    canLaunch = () => true,
    requiresApproval = () => false,
  },
) {
  createSchema(db);
  const deps = {
    transaction,
    audit,
    findCard,
    readProjects,
    writeProjects,
    recipients,
    emit,
    canLaunch,
    requiresApproval,
  };
  const core = createCore(db, deps);
  const settings = createSettings(db, deps, core);
  return {
    ...settings,
    ...createAgents(db, deps, core),
    ...createGithub(deps, core),
    ...createRuns(db, deps, core, settings),
    ...createAgentActions(db, deps, core, settings),
  };
}
