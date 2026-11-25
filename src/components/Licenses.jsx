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

// Formules vendues (DefilOrdi : « famille » ouvre l’espace parents, limité en enfants).
const OFFERS = [
  ['', 'Sans formule'],
  ['famille', 'Famille'],
  ['cabinet', 'Cabinet'],
  ['etablissement', 'Établissement'],
];
const offerLabel = value => OFFERS.find(([id]) => id === (value || ''))?.[1] || value;
const DEFAULTS = { famille: { machines: 1, profiles: 3 }, cabinet: { machines: 2, profiles: '' } };

// Champs communs à la création et à la modification d’une licence.
function LicenseFields({ values, onChange }) {
  const set = (field, value) => onChange({ ...values, [field]: value });
  return (
    <>
      <label>
        Formule
        <select
          value={values.offer}
          onChange={event => {
            const chosen = event.target.value,
              defaults = DEFAULTS[chosen];
            onChange({
              ...values,
              offer: chosen,
              ...(defaults ? { maxMachines: defaults.machines, maxProfiles: defaults.profiles } : {}),
            });
          }}
        >
          {OFFERS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Postes
        <input
          type="number"
          min={1}
          max={20}
          value={values.maxMachines}
          onChange={event => set('maxMachines', event.target.value)}
        />
      </label>
      <label>
        Enfants (vide = sans limite)
        <input
          type="number"
          min={1}
          max={100}
          value={values.maxProfiles}
          onChange={event => set('maxProfiles', event.target.value)}
        />
      </label>
      <label>
        Cabinet rattaché (facultatif)
        <input value={values.cabinet} maxLength={80} onChange={event => set('cabinet', event.target.value)} />
      </label>
      <label>
        Fin d’accès (facultative)
        <input type="date" value={values.expiresOn} onChange={event => set('expiresOn', event.target.value)} />
      </label>
    </>
  );
}

const EMPTY = { offer: '', maxMachines: 2, maxProfiles: '', cabinet: '', expiresOn: '' };
const payload = values => ({
  offer: values.offer || null,
  maxMachines: Number(values.maxMachines),
  maxProfiles: values.maxProfiles === '' ? null : Number(values.maxProfiles),
  cabinet: values.cabinet.trim() || null,
  expiresOn: values.expiresOn || null,
});
const valuesOf = license => ({
  offer: license.offer || '',
  maxMachines: license.maxMachines,
  maxProfiles: license.maxProfiles ?? '',
  cabinet: license.cabinet || '',
  expiresOn: license.expiresOn || '',
});

// Clés de licence du logiciel livré par le projet : chaque clé autorise une personne à lancer
// l’exécutable sur un nombre limité de postes. Réservé aux responsables du projet.
export default function Licenses({ projectId, repository }) {
  const list = useApiResource(`projects/${projectId}/licenses`);
  const action = useApiAction();
  const [name, setName] = useState(''),
    [values, setValues] = useState(EMPTY),
    [editing, setEditing] = useState(null),
    [created, setCreated] = useState(null);
  const busy = action.busy,
    licenses = list.data || [];
  const replace = license => list.setData(items => items.map(item => (item.id === license.id ? license : item)));
  const create = event => {
    event.preventDefault();
    void action.run(async () => {
      const license = await apiData(`projects/${projectId}/licenses`, {
        method: 'POST',
        data: { name, ...payload(values) },
      });
      const { key, ...saved } = license;
      list.setData(items => [...(items || []), saved]);
      setCreated({ name: saved.name, key });
      setName('');
      setValues(EMPTY);
    }, 'Licence créée. Notez la clé : elle ne sera plus affichée.');
  };
  const update = (license, data, message) =>
    action.run(async () => {
      replace(await apiData(`projects/${projectId}/licenses/${license.id}`, { method: 'PATCH', data }));
      return true;
    }, message);
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
        30 jours. Une licence désactivée ou arrivée à sa date de fin ne se renouvelle plus : le logiciel passe en
        lecture seule au plus tard 30 jours après. La formule, le nombre d’enfants et le cabinet rattaché sont transmis
        au logiciel avec la licence.{' '}
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
        <LicenseFields values={values} onChange={setValues} />
        <button type="submit" className="primary-button" disabled={busy || !repository || !name.trim()}>
          Créer une licence
        </button>
      </form>
      {licenses.length > 0 && (
        <ul className="licenses" aria-label="Licences">
          {licenses.map(license => (
            <li key={license.id}>
              <span>
                <strong>{license.name}</strong> · clé …{license.keyHint} · {state(license)}
                {license.offer && <> · {offerLabel(license.offer)}</>} · {license.machines}/{license.maxMachines}{' '}
                poste(s)
                {license.maxProfiles && <> · {license.maxProfiles} enfant(s)</>}
                {license.cabinet && <> · suivi : {license.cabinet}</>}
                {license.expiresOn && <> · fin le {dateFormat.format(new Date(`${license.expiresOn}T12:00:00Z`))}</>}
                {license.lastSeen && <> · vue le {dateFormat.format(new Date(license.lastSeen))}</>}
              </span>
              <span className="license-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    setEditing(editing?.id === license.id ? null : { id: license.id, ...valuesOf(license) })
                  }
                >
                  Modifier
                </button>
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
              {editing?.id === license.id && (
                <form
                  className="license-form"
                  aria-label={`Modifier la licence de ${license.name}`}
                  onSubmit={event => {
                    event.preventDefault();
                    void update(license, payload(editing), 'Licence modifiée.').then(done => done && setEditing(null));
                  }}
                >
                  <LicenseFields values={editing} onChange={next => setEditing({ ...next, id: license.id })} />
                  <button type="submit" className="primary-button" disabled={busy}>
                    Enregistrer
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormStatus message={action.message} error={action.error || list.error} />
    </details>
  );
}
