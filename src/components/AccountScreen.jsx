import React, { useState } from 'react';
import { Layers3 } from 'lucide-react';
export default function AccountScreen({ needsLogin, needsSetup, error, onLogin, onSetup, onAccept, onRetry }) {
  const [invitation] = useState(() => {
    const match = /^#invitation=([a-f0-9]{64})$/.exec(location.hash);
    if (match) history.replaceState(null, '', location.pathname + location.search);
    return match?.[1] || '';
  });
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [token, setToken] = useState('');
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const creating = !!invitation || needsSetup;
  const submit = async () => {
    if (busy || !password || (creating && !name.trim()) || (!invitation && !email.trim())) return;
    setBusy(true);
    setMessage('');
    try {
      if (invitation) await onAccept({ token: invitation, name, password });
      else if (needsSetup) await onSetup({ token, name, email, password });
      else await onLogin({ email, password });
    } catch (cause) {
      setMessage(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connection-screen">
      <section>
        <span className="info-illustration">
          <Layers3 size={28} />
        </span>
        <h1>PlaniFiKateur</h1>
        {needsLogin || invitation ? (
          <div
            className="account-form"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          >
            <h2>
              {invitation ? 'Activer mon compte' : needsSetup ? 'Créer le compte administrateur' : 'Se connecter'}
            </h2>
            <p>
              {invitation
                ? 'Choisissez votre nom et votre mot de passe personnel.'
                : needsSetup
                  ? 'Utilisez votre ancienne clé pour initialiser les comptes. Vos projets sont conservés.'
                  : 'Retrouvez les projets avec votre compte personnel.'}
            </p>
            {creating && (
              <label>
                Votre nom
                <input
                  aria-label="Votre nom"
                  maxLength={80}
                  autoComplete="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </label>
            )}
            {!invitation && (
              <label>
                Adresse e-mail
                <input
                  aria-label="Adresse e-mail"
                  type="email"
                  autoComplete="username"
                  maxLength={254}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </label>
            )}
            <label>
              Mot de passe
              <input
                aria-label="Mot de passe"
                type="password"
                autoComplete={creating ? 'new-password' : 'current-password'}
                minLength={creating ? 12 : undefined}
                maxLength={256}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </label>
            {creating && <small>Au moins 12 caractères.</small>}
            {needsSetup && !invitation && (
              <label>
                Clé d’initialisation
                <input
                  aria-label="Clé d’initialisation"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                />
              </label>
            )}
            {(message || error) && (
              <p role="alert" className="form-error">
                {message || error}
              </p>
            )}
            <button
              type="button"
              className="primary-button"
              disabled={busy || !password || (creating && !name.trim()) || (!invitation && !email.trim())}
              onClick={() => void submit()}
            >
              {busy
                ? 'Connexion…'
                : invitation
                  ? 'Activer mon compte'
                  : needsSetup
                    ? 'Créer mon compte'
                    : 'Se connecter'}
            </button>
          </div>
        ) : error ? (
          <>
            <p role="alert">Impossible de charger les projets : {error}</p>
            <button className="primary-button" onClick={onRetry}>
              Réessayer
            </button>
          </>
        ) : (
          <p role="status">Chargement de vos projets…</p>
        )}
      </section>
    </div>
  );
}
