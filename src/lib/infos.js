export const buildInfo =
  typeof __PLANIFIKATEUR_BUILD_INFO__ === 'undefined'
    ? { tag: 'Version indisponible', date: '' }
    : __PLANIFIKATEUR_BUILD_INFO__;

// Cartes Infos d’un projet (version, mode d’emploi, changelog) : tenues par le serveur, elles ne
// comptent pas parmi les idées du projet.
export const isSystemCard = (projectId, cardId) =>
  [`${projectId}-git-version`, `${projectId}-readme`, `${projectId}-changelog`].includes(cardId);
export const ideaCards = project => project.cards.filter(card => !isSystemCard(project.id, card.id));

// Stable project-scoped identifiers allow updates without duplicating the card.
export function withInfos(project, version) {
  const listId = `${project.id}-infos`;
  const cardId = `${project.id}-git-version`;
  const list =
    project.lists.find(item => item.id === listId) ||
    project.lists.find(item => ['info', 'infos'].includes(item.name.trim().toLocaleLowerCase('fr')));
  const card = project.cards.find(item => item.id === cardId);
  const preserve = !version && card;
  version ||= { tag: card?.title || 'Aucun tag disponible', date: '' };
  const validDate = version.date && Number.isFinite(Date.parse(version.date));
  const description = preserve
    ? card.description
    : (version.repository ? `Dépôt : ${version.repository}\n` : '') +
      (validDate
        ? `Publiée le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(version.date))} (Europe/Paris).`
        : version.tag === 'Aucun tag disponible'
          ? 'Associez un dépôt GitHub au projet pour afficher sa dernière version.'
          : version.tag === 'Aucun tag publié'
            ? 'Aucun tag publié dans ce dépôt.'
            : 'Date de publication indisponible dans l’historique GitHub.');
  const cards = card
    ? project.cards.map(item => {
        if (item.id !== cardId) return item;
        const { downloads, ...previous } = item;
        const current = preserve ? downloads : version.downloads;
        return {
          ...previous,
          listId: list?.id || listId,
          title: version.tag,
          description,
          status: 'done',
          ...(current ? { downloads: current } : {}),
        };
      })
    : [
        ...project.cards,
        {
          id: cardId,
          listId: list?.id || listId,
          title: version.tag,
          description,
          status: 'done',
          priority: 'normal',
          tags: ['Version'],
          comments: [],
          checklist: [],
          ...(version.downloads ? { downloads: version.downloads } : {}),
        },
      ];
  return {
    ...project,
    lists: list ? project.lists : [...project.lists, { id: listId, name: 'Infos', color: 'purple' }],
    cards: withChangelog(
      project.id,
      withReadme(project.id, cards, list?.id || listId, preserve ? undefined : version.repository || ''),
      list?.id || listId,
      preserve ? undefined : version,
    ),
  };
}

export const readmeUrl = repository => `https://github.com/${repository}#readme`;
// HEAD suit la branche par défaut du dépôt, où le worker tient CHANGELOG.md à jour.
export const changelogUrl = repository => `https://github.com/${repository}/blob/HEAD/CHANGELOG.md`;

// Liens affichés sous la carte du tableau (label) et dans son détail (detail).
export function cardLinks(card) {
  return [
    ...(card.readme
      ? [
          {
            href: readmeUrl(card.readme),
            label: 'Lire le mode d’emploi (README)',
            detail: 'Consulter le mode d’emploi (README)',
          },
        ]
      : []),
    ...(card.changelog
      ? [
          {
            href: changelogUrl(card.changelog),
            label: 'Lire le changelog (CHANGELOG.md)',
            detail: 'Consulter le changelog (CHANGELOG.md)',
          },
        ]
      : []),
  ];
}

// Without a repository argument (navigator), the server-provided link is kept.
function withReadme(projectId, cards, listId, repository) {
  const cardId = `${projectId}-readme`;
  const card = cards.find(item => item.id === cardId);
  if (repository === undefined) repository = card?.readme || '';
  const description = repository
    ? `Ce que fait le projet, comment l’installer, l’utiliser et le tester : ${readmeUrl(repository)}`
    : 'Associez un dépôt GitHub au projet pour afficher le lien vers son mode d’emploi (README).';
  const { readme, ...previous } = card || {
    id: cardId,
    priority: 'normal',
    tags: ['Mode d’emploi'],
    comments: [],
    checklist: [],
  };
  const next = {
    ...previous,
    listId,
    title: 'Mode d’emploi du projet',
    description,
    status: 'done',
    ...(repository ? { readme: repository } : {}),
  };
  return card ? cards.map(item => (item.id === cardId ? next : item)) : [...cards, next];
}

function withChangelog(projectId, cards, listId, version) {
  const id = `${projectId}-changelog`;
  const card = cards.find(item => item.id === id);
  const entries = version?.changelog;
  const description = entries?.length
    ? entries
        .map(entry => `${entry.tag} — ${entry.date.slice(0, 10)}\n${entry.body || 'Aucune note de version publiée.'}`)
        .join('\n\n')
        .slice(0, 20000)
    : version === undefined && card
      ? card.description
      : version?.repository
        ? `Chaque livraison est inscrite dans CHANGELOG.md : ${changelogUrl(version.repository)}\nLes notes des releases GitHub apparaîtront aussi ici dès leur publication.`
        : 'Associez un dépôt GitHub au projet pour afficher les nouveautés de chaque version.';
  const repository = version === undefined ? card?.changelog || '' : version.repository || '';
  const { changelog, ...previous } = card || {
    id,
    priority: 'normal',
    tags: ['Changelog'],
    comments: [],
    checklist: [],
  };
  const next = {
    ...previous,
    listId,
    title: 'Changelog',
    description,
    status: 'done',
    ...(repository ? { changelog: repository } : {}),
  };
  return card ? cards.map(item => (item.id === id ? next : item)) : [...cards, next];
}
