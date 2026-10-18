import { findDoneList, withDoneList } from './done-list.js';

// Liste « Discussion » d’un projet : ses cartes sont des questions pour échanger sur le
// fonctionnement du projet et ses évolutions, jamais des demandes de modification. Elles ne sont
// jamais confiées à l’agent. Chaque projet l’a, même vide, juste avant la liste À tester (ou Infos) ;
// une liste existante nommée « Discussion » est reprise.
export const DISCUSSION_LIST_NAME = 'Discussion';
export const discussionListId = projectId => `${projectId}-discussion`;
const DISCUSSION_NAMES = ['discussion', 'discussions'];
export const findDiscussionList = project =>
  project.lists.find(list => list.id === discussionListId(project.id)) ||
  project.lists.find(list => DISCUSSION_NAMES.includes(list.name.trim().toLocaleLowerCase('fr')));
export const isDiscussionCard = (project, card) => !!card && card.listId === findDiscussionList(project)?.id;

// Ajoute la liste « Discussion » si elle manque et retire de la file de l’agent ses cartes
// « Prêtes à démarrer ». Renvoie le même projet quand il n’y a rien à changer.
export function withDiscussionList(project) {
  let list = findDiscussionList(project);
  const queued = card => card.listId === list?.id && card.status === 'ready';
  if (list && !project.cards.some(queued)) return project;
  let lists = project.lists;
  if (!list) {
    list = { id: discussionListId(project.id), name: DISCUSSION_LIST_NAME, color: 'purple' };
    const done = findDoneList(project)?.id;
    const anchor = lists.findIndex(item => item.id === done || item.id === `${project.id}-infos`);
    lists = anchor < 0 ? [...lists, list] : [...lists.slice(0, anchor), list, ...lists.slice(anchor)];
  }
  return {
    ...project,
    lists,
    cards: project.cards.some(queued)
      ? project.cards.map(card => (queued(card) ? { ...card, status: 'draft' } : card))
      : project.cards,
  };
}

// Liste où une carte repart quand sa livraison est refusée au test : la première liste du projet qui
// n’est ni « À tester », ni « Discussion », ni Infos.
export function restartList(project) {
  const kept = new Set([findDoneList(project)?.id, findDiscussionList(project)?.id, `${project.id}-infos`]);
  return project.lists.find(list => !kept.has(list.id));
}

// Listes tenues par le site dans chaque projet : Discussion, puis À tester.
export const withProjectLists = project => withDoneList(withDiscussionList(project));
