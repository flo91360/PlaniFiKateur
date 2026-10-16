import { isSystemCard } from './infos.js';

// Liste « Terminées » d’un projet : les tâches terminées y sont rangées automatiquement, pour que
// les autres listes ne gardent que le travail à faire. Elle apparaît avec la première tâche
// terminée, juste avant la liste Infos ; une liste existante nommée « Terminées » est reprise.
export const DONE_LIST_NAME = 'Terminées';
export const doneListId = projectId => `${projectId}-done`;
const DONE_NAMES = ['terminées', 'terminees', 'terminée', 'terminés', 'terminé'];
export const findDoneList = project =>
  project.lists.find(list => list.id === doneListId(project.id)) ||
  project.lists.find(list => DONE_NAMES.includes(list.name.trim().toLocaleLowerCase('fr')));
// Cartes Infos exceptées : elles restent dans leur liste.
export const isFinished = (project, card) => card.status === 'done' && !isSystemCard(project.id, card.id);

// Range les tâches terminées dans la liste « Terminées », créée si besoin. Renvoie le même projet
// quand il n’y a rien à déplacer.
export function withDoneList(project) {
  let list = findDoneList(project);
  const misplaced = card => isFinished(project, card) && card.listId !== list?.id;
  if (!project.cards.some(misplaced)) return project;
  let lists = project.lists;
  if (!list) {
    list = { id: doneListId(project.id), name: DONE_LIST_NAME, color: 'green' };
    const infos = lists.findIndex(item => item.id === `${project.id}-infos`);
    lists = infos < 0 ? [...lists, list] : [...lists.slice(0, infos), list, ...lists.slice(infos)];
  }
  return {
    ...project,
    lists,
    cards: project.cards.map(card => (misplaced(card) ? { ...card, listId: list.id } : card)),
  };
}
