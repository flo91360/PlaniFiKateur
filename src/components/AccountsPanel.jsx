import React, { useEffect, useState } from 'react';
async function request(path, options = {}) {
  const response = await fetch(`/api/v1/${path}`, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Action impossible.');
  return data;
}
export default function AccountsPanel({ user, onLogout }) {
  const [users, setUsers] = useState([]),
    [name, setName] = useState(''),
    [email, setEmail] = useState('');
  const [link, setLink] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [currentPassword, setCurrent] = useState(''),
    [password, setPassword] = useState('');
  const load = async () => {
    if (user.role === 'admin') setUsers((await request('users')).data);
  };
  useEffect(() => {
    void load().catch(cause => setError(cause.message));
  }, []);
  const action = async fn => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
      await load();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const invite = async id => {
    const result = await request(id ? `users/${id}/invitation` : 'users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    setLink(`${location.origin}/#invitation=${result.data.token}`);
    setMessage('Invitation valable 7 jours. Transmettez ce lien uniquement à la personne concernée.');
    setName('');
    setEmail('');
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
              await request('accounts/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, password }),
              });
              setCurrent('');
              setPassword('');
              setMessage('Mot de passe modifié. Les autres sessions ont été déconnectées.');
            })
          }
        >
          Modifier mon mot de passe
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
                          await request(`users/${member.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ active: !member.active }),
                          });
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
                              setMessage(`Le compte de ${member.name} a été supprimé.`);
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
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button className="secondary-button" disabled={busy} onClick={() => void action(onLogout)}>
        Se déconnecter
      </button>
    </div>
  );
}
