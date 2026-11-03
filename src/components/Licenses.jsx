import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'Europe/Paris' });
const state = license =>
  license.revoked
    ? 'désactivée'
    : license.expiresOn && Date.parse(`${license.expiresOn}T23:59:59Z`) < Date.now()
      ? 'expirée'
      : 'active';

// Clés de licence du logiciel livré par le projet : chaque clé autorise une personne à lancer
// l’exécutable sur un nombre limité de postes. Réservé aux responsables du projet.
export default function Licenses({ projectId, repository }) {
  const list = useApiResource(`projects/${projectId}/licenses`);
  const action = useApiAction();
  const [name, setName] = useState(''),
    [maxMachines, setMaxMachines] = useState(2),
    [expiresOn, setExpiresOn] = useState(''),
    [created, setCreated] = useState(null);
  const busy = action.busy,
    licenses = list.data || [];
  const replace = license => list.setData(items => items.map(item => (item.id === license.id ? license : item)));
  const create = event => {
    event.preventDefault();
    void action.run(async () => {
      const license = await apiData(`projects/${projectId}/licenses`, {
        method: 'POST',
        data: { name, maxMachines: Number(maxMachines), expiresOn: expiresOn || null },
      });
      const { key, ...saved } = license;
      list.setData(items => [...(items || []), saved]);
      setCreated({ name: saved.name, key });
      setName('');
      setExpiresOn('');
    }, 'Licence créée. Notez la clé : elle ne sera plus affichée.');
  };
  const update = (license, data, message) =>
    action.run(
      async () => replace(await apiData(`projects/${projectId}/licenses/${license.id}`, { method: 'PATCH', data })),
      message,
    );
  const remove = license =>
    window.confirm(`Supprimer définitivement la licence de ${license.name} ?`) &&
    action.run(async () => {
      await apiData(`projects/${projectId}/licenses/${license.id}`, { method: 'DELETE' });
      list.setData(items => items.filter(item => item.id !== license.id));
    }, 'Licence supprimée.');
  return (
    <details className="agent-setup" open>
      <summary>Licences du logiciel</summary>
      <p>
        Le logiciel demande une clé à son premier lancement, puis se vérifie auprès de PlaniFiKateur au moins tous les
        30 jours. Une licence désactivée ou arrivée à sa date de fin ne se renouvelle plus : le logiciel s’arrête au
        plus tard 30 jours après.{' '}
        {repository ? (
          <>
            Produit : <code>{repository}</code>.
          </>
        ) : (
          'Associez d’abord un dépôt GitHub.'
        )}
      </p>
      {created && (
        <p role="status" className="license-created">
          Clé de {created.name} : <code>{created.key}</code>
        </p>
      )}
      <form onSubmit={create} className="license-form">
        <label>
          Titulaire
          <input value={name} maxLength={80} required onChange={event => setName(event.target.value)} />
        </label>
        <label>
          Postes
          <input
            type="number"
            min={1}
            max={20}
            value={maxMachines}
            onChange={event => setMaxMachines(event.target.value)}
          />
        </label>
        <label>
          Fin d’accès (facultative)
          <input type="date" value={expiresOn} onChange={event => setExpiresOn(event.target.value)} />
        </label>
        <button type="submit" className="primary-button" disabled={busy || !repository || !name.trim()}>
          Créer une licence
        </button>
      </form>
      {licenses.length > 0 && (
        <ul className="licenses" aria-label="Licences">
          {licenses.map(license => (
            <li key={license.id}>
              <span>
                <strong>{license.name}</strong> · clé …{license.keyHint} · {state(license)} · {license.machines}/
                {license.maxMachines} poste(s)
                {license.expiresOn && <> · fin le {dateFormat.format(new Date(`${license.expiresOn}T12:00:00Z`))}</>}
                {license.lastSeen && <> · vue le {dateFormat.format(new Date(license.lastSeen))}</>}
              </span>
              <span className="license-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void update(
                      license,
                      { revoked: !license.revoked },
                      license.revoked ? 'Licence réactivée.' : 'Licence désactivée.',
                    )
                  }
                >
                  {license.revoked ? 'Réactiver' : 'Désactiver'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !license.machines}
                  onClick={() => void update(license, { resetMachines: true }, 'Postes libérés.')}
                >
                  Libérer les postes
                </button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove(license)}>
                  Supprimer
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <FormStatus message={action.message} error={action.error || list.error} />
    </details>
  );
}
