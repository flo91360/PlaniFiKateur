export const buildInfo = typeof __PLANIFIKATEUR_BUILD_INFO__ === 'undefined'
  ? { tag: 'Version indisponible', date: '' }
  : __PLANIFIKATEUR_BUILD_INFO__;

// Stable project-scoped identifiers allow updates without duplicating the card.
export function withInfos(project, version) {
  const listId = `${project.id}-infos`;
  const cardId = `${project.id}-git-version`;
  const list = project.lists.find(item => item.id === listId) || project.lists.find(item => ['info', 'infos'].includes(item.name.trim().toLocaleLowerCase('fr')));
  const card = project.cards.find(item => item.id === cardId);
  const preserve = !version && card;
  version ||= { tag: card?.title || 'Aucun tag disponible', date: '' };
  const validDate = version.date && Number.isFinite(Date.parse(version.date));
  const description = preserve ? card.description : (version.repository ? `Dépôt : ${version.repository}\n` : '') + (validDate
    ? `Date de push du tag : ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(version.date))} (Europe/Paris).`
    : version.tag === 'Aucun tag disponible' ? 'Associez un dépôt GitHub au projet pour afficher sa dernière version.' : version.tag === 'Aucun tag publié' ? 'Aucun tag publié dans ce dépôt.' : 'Date de push du tag indisponible dans l’historique GitHub.');
  return {
    ...project,
    lists: list ? project.lists : [...project.lists, { id: listId, name: 'Infos', color: 'purple' }],
    cards: card
      ? project.cards.map(item => item.id === cardId ? { ...item, listId: list?.id || listId, title: version.tag, description, status: 'done' } : item)
      : [...project.cards, { id: cardId, listId: list?.id || listId, title: version.tag, description, status: 'done', priority: 'normal', tags: ['Version'], comments: [], checklist: [] }],
  };
}
