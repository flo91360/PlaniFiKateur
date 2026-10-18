import { isSystemCard } from './infos.js';

// Liste « À tester » d’un projet : les tâches livrées y sont rangées automatiquement, en attendant
// que leur demandeur vérifie la nouvelle version, pour que les autres listes ne gardent que le
// travail à faire. Chaque projet l’a, même vide, juste avant la liste Infos ; une liste existante
// nommée « À tester » est reprise, et l’ancienne liste « Terminées » est renommée.
export const DONE_LIST_NAME = 'À tester';
export const doneListId = projectId => `${projectId}-done`;
const DONE_NAMES = ['à tester', 'a tester'];
const LEGACY_NAMES = ['terminées', 'terminees', 'terminée', 'terminés', 'terminé'];
const listName = list => list.name.trim().toLocaleLowerCase('fr');
export const findDoneList = project =>
  project.lists.find(list => list.id === doneListId(project.id)) ||
  project.lists.find(list => DONE_NAMES.includes(listName(list))) ||
  project.lists.find(list => LEGACY_NAMES.includes(listName(list)));
// Cartes Infos exceptées : elles restent dans leur liste.
export const isFinished = (project, card) => card.status === 'done' && !isSystemCard(project.id, card.id);

// Ajoute la liste « À tester » si elle manque (ou renomme l’ancienne « Terminées ») et y range les
// tâches livrées. Renvoie le même projet quand il n’y a rien à changer.
export function withDoneList(project) {
  let list = findDoneList(project);
  const misplaced = card => isFinished(project, card) && card.listId !== list?.id;
  const legacy = list && LEGACY_NAMES.includes(listName(list));
  if (list && !legacy && !project.cards.some(misplaced)) return project;
  let lists = project.lists;
  if (legacy) {
    const renamed = { ...list, name: DONE_LIST_NAME };
    lists = lists.map(item => (item === list ? renamed : item));
    list = renamed;
  } else if (!list) {
    list = { id: doneListId(project.id), name: DONE_LIST_NAME, color: 'green' };
    const infos = lists.findIndex(item => item.id === `${project.id}-infos`);
    lists = infos < 0 ? [...lists, list] : [...lists.slice(0, infos), list, ...lists.slice(infos)];
  }
  return {
    ...project,
    lists,
    cards: project.cards.some(misplaced)
      ? project.cards.map(card => (misplaced(card) ? { ...card, listId: list.id } : card))
      : project.cards,
  };
}
