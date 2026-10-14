import React, { useEffect, useState } from 'react';
import { apiBlob, apiData, apiFetch } from '../lib/api-client.js';

export default function BackupsPanel() {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = async () => {
    // Réponse sans enveloppe data : fichiers, erreur, intervalle et rétention.
    setStatus(await apiFetch('backups', { fallback: 'Impossible de consulter les sauvegardes.' }));
  };
  useEffect(() => {
    void load().catch(cause => setError(cause.message));
  }, []);
  const download = async name => {
    const blob = await apiBlob(`backups/${name}`, { fallback: 'Impossible de télécharger la sauvegarde.' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const action = async name => {
    setBusy(true);
    setError('');
    try {
      if (!name) {
        name = (await apiData('backups', { method: 'POST', fallback: 'Impossible de créer la sauvegarde.' })).name;
        await load();
      }
      await download(name);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="backup-panel">
      <h3>Sauvegardes</h3>
      <p>
        {status
          ? `Copie automatique toutes les ${status.intervalHours} heures si les données changent, et avant une suppression. Jusqu’à ${status.keep} copies conservées.`
          : 'Chargement des sauvegardes…'}
      </p>
      <p>Téléchargez régulièrement une copie pour la conserver en dehors du site.</p>
      {(error || status?.error) && (
        <p role="alert" className="form-error">
          {error || status.error}
        </p>
      )}
      <button className="secondary-button" disabled={busy} onClick={() => void action()}>
        {busy ? 'Préparation…' : 'Créer et télécharger une sauvegarde SQLite'}
      </button>
      {status?.files.length > 0 && (
        <ul className="backup-list">
          {status.files.map(file => (
            <li key={file.name}>
              <span>
                {new Date(file.createdAt).toLocaleString('fr-FR')} · {Math.ceil(file.size / 1024)} Ko
              </span>
              <button className="secondary-button" disabled={busy} onClick={() => void action(file.name)}>
                Télécharger
                <span className="sr-only"> la sauvegarde du {new Date(file.createdAt).toLocaleString('fr-FR')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
