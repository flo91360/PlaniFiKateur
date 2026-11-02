import React, { useEffect, useState } from 'react';
import { currentSubscription, disablePush, enablePush, pushSupport, syncSubscription, testPush } from '../lib/push.js';
import { useApiAction } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

const MESSAGES = {
  install:
    'Sur iPhone et iPad, ajoutez d’abord le site à l’écran d’accueil (Partager, puis « Sur l’écran d’accueil »), puis ouvrez-le depuis cette icône pour activer les notifications.',
  unsupported: 'Ce navigateur ne permet pas les notifications Web Push.',
  denied: 'Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur.',
};

// Notifications sur cet appareil : questions de l’agent, résultats et PR à valider, tests en
// échec, cartes à tester et exécutions interrompues, même site fermé.
export default function PushSettings() {
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState(null);
  const { busy, error, message, run } = useApiAction();
  useEffect(() => {
    let active = true;
    syncSubscription()
      .then(subscription => active && setSubscribed(!!subscription))
      // Serveur injoignable : l’état local de l’abonnement reste affiché.
      .catch(() => currentSubscription().then(subscription => active && setSubscribed(!!subscription)))
      .catch(() => active && setSubscribed(false));
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="account-form push-settings">
      <h3>Notifications sur cet appareil</h3>
      <p>
        Recevez sur cet appareil, même site fermé, les étapes de l’agent qui vous attendent sur vos cartes : question,
        résultat ou PR à valider, tests en échec, carte à tester, exécution interrompue. Les commentaires et changements
        de statut restent dans la cloche du site.
      </p>
      {support !== 'ready' ? (
        <p role="note">{MESSAGES[support]}</p>
      ) : subscribed ? (
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void run(testPush, text => text)}
          >
            Envoyer une notification de test
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await disablePush();
                setSubscribed(false);
              }, 'Notifications désactivées sur cet appareil.')
            }
          >
            Désactiver les notifications
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || subscribed === null}
          onClick={() =>
            void run(async () => {
              await enablePush();
              setSubscribed(true);
            }, 'Notifications activées sur cet appareil.')
          }
        >
          Activer les notifications
        </button>
      )}
      <FormStatus message={message} error={error} />
    </div>
  );
}
