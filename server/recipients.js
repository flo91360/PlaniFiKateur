// Destinataires d’une notification : participants de la carte (créateur, auteurs de
// commentaires…) et abonnés, sauf l’auteur de l’action, les comptes inactifs et les
// membres qui ont choisi de ne plus suivre la carte.
export function notificationRecipients({ participants = [], preferences = [], activeIds, actorId }) {
  const optedOut = new Set(preferences.filter(p => !p.following).map(p => p.user_id));
  const followers = preferences.filter(p => p.following).map(p => p.user_id);
  return [...new Set([...participants, ...followers])].filter(
    id => id && id !== actorId && activeIds.has(id) && !optedOut.has(id),
  );
}
