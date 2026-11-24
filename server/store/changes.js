// Outils purs du planificateur de modifications du workspace (sans base de données).

// Projets visés par un lot de modifications, ou null si la liste des projets elle-même change.
export const changedProjects = changes => {
  if (!Array.isArray(changes)) return null;
  const ids = new Set();
  for (const change of changes) {
    if (['project.create', 'project.delete', 'project.order'].includes(change?.type)) return null;
    if (typeof change?.projectId === 'string') ids.add(change.projectId);
  }
  return [...ids];
};

// Erreur qui refuse une demande (4xx), par opposition à une panne du serveur.
export const refusal = error => error?.status >= 400 && error.status < 500;

// Tentatives au plus pour isoler les modifications refusées d’un lot `partial` : chacune relit et
// revalide les projets visés, de façon synchrone. Au-delà, le reste du lot n’est pas tenté.
export const PARTIAL_ATTEMPTS = 50;
const NOT_ATTEMPTED = {
  code: 'not_attempted',
  message: 'Trop de modifications refusées dans ce lot : celle-ci n’a pas été tentée. Réessayez.',
};

// Lot `partial` refusé en entier : il est coupé en deux, récursivement, pour isoler les
// modifications refusées ; les parties acceptées s’appliquent dans l’ordre du lot.
// `attempt(from, to)` tente changes[from..to[ et renvoie { skipped } ou { error }.
export function settlePartial(changes, error, attempt, budget = PARTIAL_ATTEMPTS) {
  const skipped = [],
    rejected = [];
  let attempts = 0;
  const reject = (index, { code, message }) =>
    rejected.push({ index, type: changes[index]?.type ?? null, code, message });
  const settle = (from, to, failure) => {
    if (to - from === 1) return reject(from, failure);
    const middle = from + Math.floor((to - from) / 2);
    for (const [start, end] of [
      [from, middle],
      [middle, to],
    ]) {
      if (attempts >= budget) {
        for (let index = start; index < end; index++) reject(index, NOT_ATTEMPTED);
        continue;
      }
      attempts++;
      const outcome = attempt(start, end);
      if (outcome.error) settle(start, end, outcome.error);
      else skipped.push(...outcome.skipped.map(item => ({ ...item, index: item.index + start })));
    }
  };
  settle(0, changes.length, error);
  return { skipped, rejected, attempts };
}

// Projets, listes et cartes présents avant et absents après.
export const removedContent = (before, after) => {
  const ids = (projects, of) => new Set(projects.flatMap(of));
  const gone = of => {
    const kept = ids(after, of);
    return [...ids(before, of)].filter(id => !kept.has(id));
  };
  return {
    projectIds: gone(project => [project.id]),
    listIds: gone(project => project.lists.map(list => list.id)),
    cardIds: gone(project => project.cards.map(card => card.id)),
  };
};
// Un projet, une liste ou une carte présent avant et absent après ?
export const removesContent = (before, after) =>
  Object.values(removedContent(before, after)).some(ids => ids.length > 0);

// Actions qui notifient leurs destinataires (recipientIds : participants et abonnés de la carte,
// sans l’auteur de l’action). Les messages de l’agent sont déjà annoncés par leur action work.*.
