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
    ? `Publiée le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(version.date))} (Europe/Paris).`
    : version.tag === 'Aucun tag disponible' ? 'Associez un dépôt GitHub au projet pour afficher sa dernière version.' : version.tag === 'Aucun tag publié' ? 'Aucun tag publié dans ce dépôt.' : 'Date de publication indisponible dans l’historique GitHub.');
  const cards = card
    ? project.cards.map(item => {
      if (item.id !== cardId) return item;
      const { downloads, ...previous } = item;
      const current = preserve ? downloads : version.downloads;
      return { ...previous, listId: list?.id || listId, title: version.tag, description, status: 'done', ...(current ? { downloads: current } : {}) };
    })
    : [...project.cards, { id: cardId, listId: list?.id || listId, title: version.tag, description, status: 'done', priority: 'normal', tags: ['Version'], comments: [], checklist: [], ...(version.downloads ? { downloads: version.downloads } : {}) }];
  return {
    ...project,
    lists: list ? project.lists : [...project.lists, { id: listId, name: 'Infos', color: 'purple' }],
    cards: withReadme(project.id, cards, list?.id || listId, preserve ? undefined : version.repository || ''),
  };
}

export const readmeUrl = repository => `https://github.com/${repository}#readme`;

// Without a repository argument (navigator), the server-provided link is kept.
function withReadme(projectId, cards, listId, repository) {
  const cardId = `${projectId}-readme`;
  const card = cards.find(item => item.id === cardId);
  if (repository === undefined) repository = card?.readme || '';
  const description = repository
    ? `Ce que fait le projet, comment l’installer, l’utiliser et le tester : ${readmeUrl(repository)}`
    : 'Associez un dépôt GitHub au projet pour afficher le lien vers son mode d’emploi (README).';
  const { readme, ...previous } = card || { id: cardId, priority: 'normal', tags: ['Mode d’emploi'], comments: [], checklist: [] };
  const next = { ...previous, listId, title: 'Mode d’emploi du projet', description, status: 'done', ...(repository ? { readme: repository } : {}) };
  return card ? cards.map(item => item.id === cardId ? next : item) : [...cards, next];
}
