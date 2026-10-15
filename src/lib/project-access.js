import { createContext, useContext } from 'react';

// Droits du compte sur le projet affiché, calculés une fois dans App et lus par les composants :
// - viewer (lecture) : consulter, sans rien modifier ;
// - editor (contribution) : modifier les cartes, commenter, annuler une exécution ;
// - manager (responsable) : en plus, confier une carte à l’agent, valider, régler et supprimer le projet.
// Hors connexion, toute la page appartient à son utilisateur : responsable.
export const projectAccess = (role = 'manager') => ({
  role,
  readOnly: role === 'viewer',
  canLaunch: role === 'manager',
  canManage: role === 'manager',
});

export const ProjectAccess = createContext(projectAccess());
export const useProjectAccess = () => useContext(ProjectAccess);
