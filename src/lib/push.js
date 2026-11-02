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
