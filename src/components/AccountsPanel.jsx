import React, { useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { ACCENTS, DEFAULT_ACCENT } from '../lib/accents.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import BackupsPanel from './BackupsPanel.jsx';
import FormStatus from './FormStatus.jsx';

const request = (path, options) => apiData(path, { fallback: 'Action impossible.', ...options });
export default function AccountsPanel({ user, accent = DEFAULT_ACCENT, onAccent = () => {}, onLogout }) {
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [link, setLink] = useState(''),
    [deletingId, setDeletingId] = useState(null);
  const [currentPassword, setCurrent] = useState(''),
    [password, setPassword] = useState('');
  // Membres de l’espace : réservés à l’administrateur, relus après chaque action.
  const members = useApiResource('users', { enabled: user.role === 'admin', fallback: 'Action impossible.' });
  const users = members.data || [];
  const { busy, error, message, run } = useApiAction();
  // `fn` renvoie le message de réussite éventuel.
  const action = fn =>
    run(
      async () => {
        const done = await fn();
        members.reload();
        return done;
      },
      done => done || '',
    );
  // La couleur s’applique aussitôt ; elle est rétablie si le serveur refuse de l’enregistrer.
  const chooseAccent = id =>
    action(async () => {
      const previous = accent;
      onAccent(id);
      try {
        const saved = await request('accounts/preferences', { method: 'PUT', data: { accent: id } });
        onAccent(saved.accent);
      } catch (cause) {
        onAccent(previous);
        throw cause;
      }
      return id === DEFAULT_ACCENT ? 'Couleur par défaut rétablie.' : 'Couleur enregistrée sur votre compte.';
    });
  const invite = async id => {
    const result = await request(id ? `users/${id}/invitation` : 'users', { method: 'POST', data: { name, email } });
    setLink(`${location.origin}/#invitation=${result.token}`);
    setName('');
    setEmail('');
    return 'Invitation valable 7 jours. Transmettez ce lien uniquement à la personne concernée.';
  };
  return (
    <div className="accounts-panel">
      <h2>Mon compte</h2>
      <p>
        <strong>{user.name}</strong> · {user.email}
      </p>
      <p>{user.role === 'admin' ? 'Administrateur' : 'Membre'} · Accès aux projets partagés</p>
      <div className="account-form">
        <h3>Changer mon mot de passe</h3>
        <label>
          Mot de passe actuel
          <input
            aria-label="Mot de passe actuel"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrent(e.target.value)}
          />
        </label>
        <label>
          Nouveau mot de passe
          <input
            aria-label="Nouveau mot de passe"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={busy || !currentPassword || password.length < 12}
          onClick={() =>
            void action(async () => {
              await request('accounts/password', { method: 'POST', data: { currentPassword, password } });
              setCurrent('');
              setPassword('');
              return 'Mot de passe modifié. Les autres sessions ont été déconnectées.';
            })
          }
        >
          Modifier mon mot de passe
        </button>
      </div>
      <div className="account-form appearance-settings">
        <h3>Apparence</h3>
        <p>Couleur dominante du site, enregistrée avec votre compte. Elle ne change que votre affichage.</p>
        <div className="accent-palette" role="group" aria-label="Couleur dominante">
          {ACCENTS.map(option => (
            <button
              key={option.id}
              type="button"
              className="accent-option"
              aria-pressed={accent === option.id}
              disabled={busy}
              onClick={() => void chooseAccent(option.id)}
            >
              <span className="accent-swatch" style={{ background: option.primary }} aria-hidden="true" />
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || accent === DEFAULT_ACCENT}
          onClick={() => void chooseAccent(DEFAULT_ACCENT)}
        >
          Rétablir la couleur par défaut
        </button>
      </div>
      {user.role === 'admin' && (
        <>
          <h2>Membres de l’espace</h2>
          <div className="account-form">
            <label>
              Nom du membre
              <input aria-label="Nom du membre" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label>
              E-mail du membre
              <input
                aria-label="E-mail du membre"
                type="email"
                maxLength={254}
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy || !name.trim() || !email.trim()}
              onClick={() => void action(() => invite())}
            >
              Créer une invitation
            </button>
          </div>
          {link && (
            <label>
              Lien d’invitation
              <input aria-label="Lien d’invitation" readOnly value={link} onFocus={e => e.target.select()} />
            </label>
          )}
          <ul className="member-list">
            {users.map(member => (
              <li key={member.id}>
                <div>
                  <strong>{member.name}</strong>
                  <small>
                    {member.email} ·{' '}
                    {member.role === 'admin'
                      ? 'Administrateur'
                      : !member.active
                        ? 'Désactivé'
                        : member.pending
                          ? 'Invité'
                          : 'Actif'}
                  </small>
                </div>
                {member.role !== 'admin' && (
                  <div className="member-actions">
                    {member.active && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void action(() => invite(member.id))}
                      >
                        {member.pending ? 'Renouveler le lien' : 'Réinitialiser le mot de passe'}
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request(`users/${member.id}`, { method: 'PATCH', data: { active: !member.active } });
                        })
                      }
                    >
                      {member.active ? 'Désactiver' : 'Réactiver'}
                    </button>
                    {deletingId === member.id ? (
                      <div className="delete-confirm account-delete-confirm">
                        <p>
                          Supprimer définitivement le compte de <strong>{member.name}</strong> ({member.email}) ?
                        </p>
                        <p>
                          Son accès, ses invitations et ses abonnements seront supprimés. Ses cartes, commentaires et
                          actions resteront conservés avec leur auteur.
                        </p>
                        <button
                          className="danger-button"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await request(`users/${member.id}`, { method: 'DELETE' });
                              setDeletingId(null);
                              setLink('');
                              return `Le compte de ${member.name} a été supprimé.`;
                            })
                          }
                        >
                          Confirmer la suppression du compte
                        </button>
                        <button className="secondary-button" disabled={busy} onClick={() => setDeletingId(null)}>
                          Annuler la suppression
                        </button>
                      </div>
                    ) : (
                      <button className="delete-button" disabled={busy} onClick={() => setDeletingId(member.id)}>
                        Supprimer le compte
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {/* Sauvegardes de la base : une tâche d’administration, à côté de la gestion des comptes. */}
          <BackupsPanel />
        </>
      )}
      <FormStatus message={message} error={error || members.error} />
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => void action(async () => void (await onLogout()))}
      >
        Se déconnecter
      </button>
    </div>
  );
}
