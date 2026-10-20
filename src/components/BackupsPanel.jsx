import React from 'react';
import { apiBlob, apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

export default function BackupsPanel() {
  // Réponse sans enveloppe data : fichiers, erreur, intervalle et rétention.
  const backups = useApiResource('backups', { raw: true, fallback: 'Impossible de consulter les sauvegardes.' });
  const status = backups.data;
  const { busy, error, run } = useApiAction();
  const download = async name => {
    const blob = await apiBlob(`backups/${name}`, { fallback: 'Impossible de télécharger la sauvegarde.' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // Sans nom : crée une copie, relit la liste puis la télécharge.
  const action = name =>
    run(async () => {
      if (!name) {
        name = (await apiData('backups', { method: 'POST', fallback: 'Impossible de créer la sauvegarde.' })).name;
        backups.reload();
      }
      await download(name);
    });
  return (
    <section className="backup-panel">
      <h3>Sauvegardes</h3>
      <p>
        {status
          ? `Copie automatique toutes les ${status.intervalHours} heures si les données changent, et avant une suppression. Jusqu’à ${status.keep} copies conservées de chaque sorte : les copies d’avant suppression ne remplacent pas les copies régulières.`
          : 'Chargement des sauvegardes…'}
      </p>
      <p>Téléchargez régulièrement une copie pour la conserver en dehors du site.</p>
      <FormStatus error={error || backups.error || status?.error} />
      <button className="secondary-button" disabled={busy} onClick={() => void action()}>
        {busy ? 'Préparation…' : 'Créer et télécharger une sauvegarde SQLite'}
      </button>
      {status?.files.length > 0 && (
        <ul className="backup-list">
          {status.files.map(file => (
            <li key={file.name}>
              <span>
                {new Date(file.createdAt).toLocaleString('fr-FR')} · {Math.ceil(file.size / 1024)} Ko
                {file.kind === 'deletion' && ' · avant suppression'}
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
