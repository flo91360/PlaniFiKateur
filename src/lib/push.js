import { apiData } from './api-client.js';

// Notifications Web Push de cet appareil : service worker /sw.js, abonnement du navigateur et
// enregistrement auprès du site (PUT/DELETE /api/v1/push/subscription).

export function pushSupport() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window))
    // iPhone et iPad : Web Push seulement depuis le site ajouté à l’écran d’accueil.
    return /iPhone|iPad|iPod/.test(navigator.userAgent || '') ? 'install' : 'unsupported';
  if (!window.isSecureContext) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'ready';
}

const registration = () => navigator.serviceWorker.register('/sw.js', { scope: '/' });

export async function currentSubscription() {
  if (pushSupport() !== 'ready') return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ? existing.pushManager.getSubscription() : null;
}

// Abonnement de cet appareil, renvoyé au serveur à chaque ouverture : le serveur le retrouve s’il
// l’avait oublié (refus passé du service, base restaurée, nouveau serveur) et l’adresse que le
// navigateur a pu renouveler est mise à jour. Un abonnement fait avec une autre clé serveur ne
// peut plus rien recevoir : il est retiré et l’appareil apparaît désabonné.
export async function syncSubscription() {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  if (Notification.permission !== 'granted') return null;
  const { publicKey } = await apiData('push');
  const key = subscription.options?.applicationServerKey;
  if (key && new Uint8Array(key).join() !== bytes(publicKey).join()) {
    await subscription.unsubscribe().catch(() => {});
    return null;
  }
  await apiData('push/subscription', { method: 'PUT', data: subscription.toJSON() });
  return subscription;
}

// Notification de test vers cet appareil. Renvoie un texte de réussite, sinon lève une erreur
// expliquant le refus du service de notification.
export async function testPush() {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error('Cet appareil n’est pas abonné : activez d’abord les notifications.');
  const result = await apiData('push/test', { method: 'POST', data: { endpoint: subscription.endpoint } });
  if (result.delivered)
    return 'Notification de test envoyée. Si rien n’apparaît d’ici une minute, vérifiez les réglages de notifications de l’appareil et le mode Concentration.';
  throw new Error(pushFailure(result));
}

export function pushFailure({ status, reason, service = '', subscribed }) {
  const who = /apple\.com/.test(service) ? 'Le service de notification d’Apple' : 'Le service de notification';
  const detail = `HTTP ${status}${reason ? `, ${reason}` : ''}`;
  if (!status) return `${who} est injoignable depuis le serveur${reason ? ` (${reason})` : ''}. Réessayez plus tard.`;
  if (!subscribed || [404, 410].includes(status))
    return `${who} ne reconnaît plus cet appareil (${detail}) : désactivez puis réactivez les notifications.`;
  if (/BadJwtToken|VapidPkHashMismatch|BadPublicKey|InvalidProviderToken/i.test(reason) || [401, 403].includes(status))
    return `${who} a refusé l’identification du serveur (${detail}) : désactivez puis réactivez les notifications.`;
  return `${who} a refusé la notification (${detail}).`;
}

export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error('Notifications refusées par le navigateur : autorisez-les dans les réglages du site.');
  const { publicKey } = await apiData('push');
  const worker = await registration();
  await navigator.serviceWorker.ready;
  let subscription = await worker.pushManager.getSubscription();
  // Clé du serveur changée (base restaurée) : l’ancien abonnement ne peut plus servir.
  const key = subscription?.options?.applicationServerKey;
  if (subscription && key && new Uint8Array(key).join() !== bytes(publicKey).join()) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ||= await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes(publicKey),
  });
  await apiData('push/subscription', { method: 'PUT', data: subscription.toJSON() });
  return subscription;
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await apiData('push/subscription', { method: 'DELETE', data: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe();
}

function bytes(base64url) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, char => char.charCodeAt(0));
}
