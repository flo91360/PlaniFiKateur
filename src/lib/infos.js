export const buildInfo = typeof __PLANIFIKATEUR_BUILD_INFO__ === 'undefined'
  ? { name: 'Version indisponible', date: '' }
  : __PLANIFIKATEUR_BUILD_INFO__;

// Stable project-scoped identifiers allow updates without duplicating the card.
export function withInfos(project, version = buildInfo) {
  const listId = `${project.id}-infos`;
  const cardId = `${project.id}-git-version`;
  const list = project.lists.find(item => item.id === listId) || project.lists.find(item => item.name === 'Infos');
  const card = project.cards.find(item => item.id === cardId);
  const description = version.date ? `Date du commit : ${version.date}` : 'Date du commit indisponible.';
  return {
    ...project,
    lists: list ? project.lists : [...project.lists, { id: listId, name: 'Infos', color: 'purple' }],
    cards: card
      ? project.cards.map(item => item.id === cardId ? { ...item, listId: list?.id || listId, title: version.name, description } : item)
      : [...project.cards, { id: cardId, listId: list?.id || listId, title: version.name, description, status: 'done', priority: 'normal', tags: ['Version'], comments: [], checklist: [] }],
  };
}
