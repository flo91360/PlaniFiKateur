import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign as signData } from 'node:crypto';

// Notifications Web Push (RFC 8030) : chiffrement aes128gcm du message (RFC 8291) et
// identification du serveur par VAPID (RFC 8292), avec les seuls modules intégrés de Node.

// Étapes de l’agent envoyées aux appareils abonnés : celles qui attendent une personne, plus la
// fusion qui place la carte « À tester ».
export const PUSHED = ['work.question', 'work.submit', 'work.checks', 'work.merged', 'work.interrupted'];

// Titre et texte de la notification, ou null quand l’étape n’attend personne.
export function pushMessage(event) {
  const where = [event.cardTitle, event.projectName].filter(Boolean).join(' · ') || 'Une carte';
  const titles = {
    'work.question': 'Question de l’agent',
    'work.submit':
      event.state === 'review'
        ? 'Résultat à valider'
        : event.state === 'merging' && event.approvalRequired
          ? 'PR à approuver'
          : null,
    'work.checks': event.state === 'waiting' ? 'Tests GitHub en échec' : null,
    'work.merged': 'Carte à tester',
    'work.interrupted': 'Exécution interrompue',
  };
  const title = titles[event.action];
  if (!title) return null;
  const details = {
    'work.question': 'L’agent attend votre réponse dans la discussion de la carte.',
    'work.submit': 'Ouvrez la carte pour vérifier le travail de l’agent.',
    'work.checks': 'L’agent n’a pas pu corriger les tests : il attend une réponse.',
    'work.merged': 'La PR est fusionnée : la carte est dans « À tester ».',
    'work.interrupted': 'Ouvrez la carte pour relancer ou préciser la demande.',
  };
  const route = event.projectId
    ? `/#/projets/${encodeURIComponent(event.projectId)}${event.cardId ? `/cartes/${encodeURIComponent(event.cardId)}` : ''}`
    : '/';
  return {
    title,
    body: `${where}\n${details[event.action]}`.slice(0, 400),
    url: route,
    tag: `planifikateur-${event.cardId || event.activityId}`,
  };
}

const b64 = buffer => Buffer.from(buffer).toString('base64url');

// Clé publique VAPID brute (point P-256 non compressé), transmise au navigateur pour s’abonner.
export function vapidPublicKey(jwk) {
  return b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
}

// Jeton VAPID (JWT ES256) pour le service de notification `audience`, valable 12 heures.
export function vapidAuthorization(jwk, audience, subject, now = Date.now()) {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = signData('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${vapidPublicKey(jwk)}`;
}

// Message chiffré pour un abonnement (clés p256dh et auth du navigateur), en un seul enregistrement.
export function encryptPush(payload, { p256dh, auth }, { salt = randomBytes(16), ecdh } = {}) {
  const receiver = Buffer.from(p256dh, 'base64url');
  if (!ecdh) {
    ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
  }
  const sender = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(receiver);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, Buffer.from(auth, 'base64url'), info, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // Dernier (et seul) enregistrement : contenu suivi du délimiteur 0x02.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(sender.length, 20);
  return Buffer.concat([header, sender, body, cipher.getAuthTag()]);
}

// Raison donnée par le service de notification quand il refuse un envoi (Apple : { "reason": "BadJwtToken" },
// Google et Mozilla : texte ou JSON), limitée à un mot-clé lisible sans données de l’abonnement.
async function refusalReason(response) {
  try {
    const text = String((await response.text?.()) || '').slice(0, 2000);
    let reason = text;
    try {
      const json = JSON.parse(text);
      reason = json.reason || json.error?.status || json.error?.message || json.message || json.errno || '';
    } catch {
      /* Réponse en texte brut. */
    }
    return (
      String(reason)
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[^\p{L}\p{N} ._:-]/gu, '')
        .trim()
        .slice(0, 120) || ''
    );
  } catch {
    return '';
  }
}

// Envoi d’un message à un abonnement. Renvoie { ok, status, reason, service } sans jamais lever
// d’erreur ; un abonnement refusé par son service (404, 410) est oublié.
export async function deliverPush(store, subscription, message, { fetch = globalThis.fetch, ttl = 86400 } = {}) {
  const service = new URL(subscription.endpoint).origin;
  try {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: vapidAuthorization(store.pushKey(), service, vapidSubject(subscription.origin)),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: 'high',
      },
      body: encryptPush(JSON.stringify(message), subscription),
    });
    if (response.ok) return { ok: true, status: response.status, reason: '', service };
    if ([404, 410].includes(response.status)) store.forgetPushSubscription(subscription.endpoint);
    return { ok: false, status: response.status, reason: await refusalReason(response), service };
  } catch (error) {
    return { ok: false, status: 0, reason: error.name, service };
  }
}

// Sujet VAPID : Apple refuse un jeton dont le sujet n’est ni une adresse https publique ni un
// mailto (403 BadJwtToken). L’adresse du site est gardée quand elle convient.
export function vapidSubject(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  } catch {
    /* Adresse absente ou invalide. */
  }
  return 'mailto:notifications@planifikateur.invalid';
}

// Envoi des étapes de l’agent aux appareils des destinataires. Une erreur est journalisée avec
// la raison du service, sans l’adresse de l’abonnement.
export function createPushSender(store, { fetch = globalThis.fetch, log = console.error } = {}) {
  const send = async event => {
    const message = pushMessage(event);
    if (!message) return;
    const subscriptions = store.pushSubscriptions(event.userIds || []);
    await Promise.all(
      subscriptions.map(async subscription => {
        const result = await deliverPush(store, subscription, message, { fetch });
        if (result.ok || [404, 410].includes(result.status)) return;
        log(
          result.status
            ? `PlaniFiKateur : notification refusée par ${result.service} (HTTP ${result.status}${result.reason ? `, ${result.reason}` : ''}).`
            : `PlaniFiKateur : notification non envoyée à ${result.service} (${result.reason}).`,
        );
      }),
    );
  };
  const pending = new Set();
  const unsubscribe = store.subscribe(event => {
    if (event.type !== 'push') return;
    const task = send(event)
      .catch(error => log(`PlaniFiKateur : notification non envoyée (${error.name}).`))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  return {
    publicKey: () => vapidPublicKey(store.pushKey()),
    // Attente des envois en cours (tests, arrêt).
    settled: () => Promise.all([...pending]),
    close: unsubscribe,
  };
}
