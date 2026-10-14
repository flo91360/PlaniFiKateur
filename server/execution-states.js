// Machine d’états d’une exécution IA de carte.
//
// Parcours nominal : ready —claim→ running —submit→ merging —merged (webhook GitHub)→ done.
// - running —question→ waiting —answer→ ready : l’agent attend une réponse dans la discussion.
// - running —submit sans PR→ review —accept→ done, ou —reject→ ready ; un fichier seul va à done.
// - merging —checksFailed ou reject→ ready ; —revise→ running quand l’agent corrige sa PR.
// - running —interrupt, expire, revoke ou unassign→ interrupted —claim→ running.
// - Toute exécution non terminée peut être annulée (cancel) : par une personne, ou par le site
//   quand la carte est supprimée, modifiée, restaurée ou retirée de la file.
export const STATES = ['ready', 'running', 'waiting', 'review', 'merging', 'interrupted', 'done', 'cancelled'];
const TERMINAL = new Set(['done', 'cancelled']);
const OPEN = STATES.filter(state => !TERMINAL.has(state));
export const isTerminal = state => TERMINAL.has(state);

// Statut affiché sur la carte tant que l’exécution la pilote.
export const CARD_STATUS = {
  ready: 'ready',
  running: 'progress',
  waiting: 'clarify',
  review: 'review',
  merging: 'review',
  interrupted: 'ready',
  done: 'done',
  cancelled: 'draft',
};

// Action → états de départ admis et état(s) d’arrivée.
export const TRANSITIONS = {
  // Personnes (session du site).
  answer: { from: ['waiting'], to: 'ready' },
  accept: { from: ['review'], to: 'done' },
  reject: { from: ['review', 'merging'], to: 'ready' },
  cancel: { from: OPEN, to: 'cancelled' },
  // Agent (clé d’agent et réservation).
  claim: { from: ['ready', 'interrupted'], to: 'running' },
  // waiting : uniquement la reprise de l’ancienne question technique de publication (legacyPublicationQuestion).
  revise: { from: ['merging', 'waiting'], to: 'running' },
  question: { from: ['running'], to: 'waiting' },
  submit: { from: ['running'], to: ['done', 'merging', 'review'] },
  interrupt: { from: ['running'], to: 'interrupted' },
  // Site et GitHub.
  expire: { from: ['running'], to: 'interrupted' },
  revoke: { from: ['running', 'waiting'], to: 'interrupted' },
  unassign: { from: OPEN, to: 'interrupted' },
  checksFailed: { from: ['merging'], to: 'ready' },
  merged: { from: ['merging'], to: 'done' },
};

export const canTransition = (state, action) => !!TRANSITIONS[action]?.from.includes(state);

// Compatibilité : un ancien worker posait cette question technique au lieu de republier sa PR.
// Une vraie demande de précision exige toujours une réponse humaine.
export const LEGACY_PUBLICATION_QUESTION = 'La PR ne pointe pas sur le commit testé.';
export const legacyPublicationQuestion = run =>
  run.delivery === 'github' &&
  run.state === 'waiting' &&
  !!run.submissions.at(-1)?.pullRequest &&
  run.exchanges.at(-1)?.question === LEGACY_PUBLICATION_QUESTION &&
  !run.exchanges.at(-1)?.answer;

// Applique une transition. Les appelants vérifient l’état avant (avec un message adapté) :
// une transition impossible ici est une erreur de programmation, pas une erreur de l’utilisateur.
export function transition(run, action, target) {
  const rule = TRANSITIONS[action];
  const to = Array.isArray(rule?.to) ? target : rule?.to;
  if (!canTransition(run.state, action) || !to || (Array.isArray(rule.to) && !rule.to.includes(to)))
    throw new Error(`Transition ${action} impossible depuis ${run.state}.`);
  run.state = to;
  return run;
}
