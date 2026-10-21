import React from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';
import { docsLink } from '../lib/links.js';

const labels = {
  archived: 'Archivée',
  error: 'Échec, nouvel essai prévu',
  conflict: 'Non archivée : fichiers différents pour une version existante',
  pruned: 'Retirée du Drive (toujours dans la Release GitHub)',
};
const date = value =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(
        new Date(value),
      )
    : '';

export default function DriveArchive({ projectId, user }) {
  const drive = useApiResource(`projects/${projectId}/drive`);
  const action = useApiAction();
  const status = drive.data,
    error = action.error || drive.error,
    busy = action.busy;
  const start = () =>
    action.run(async () => drive.setData(await apiData(`projects/${projectId}/drive`, { method: 'POST' })));
  const problem = status && (status.configurationError || status.error || status.repositoryError);
  return (
    <details className="agent-setup drive-archive">
      <summary>Archivage des .exe sur Google Drive</summary>
      {!status && !error && <p role="status">Chargement de l’archivage…</p>}
      {status && !status.enabled && <p>L’archivage n’est pas configuré sur le serveur.</p>}
      {status?.enabled && !status.repository && (
        <p>Associez un dépôt GitHub au projet : ses Releases contenant des .exe seront archivées automatiquement.</p>
      )}
      {status?.enabled && status.repository && (
        <p>
          Chaque Release <code>vX.Y.Z</code> de <code>{status.repository}</code> qui contient des .exe est copiée dans
          le dossier Drive, sous <code>{status.repository.split('/')[1]}/&lt;version&gt;/</code>.
          {status.keep > 0 &&
            ` Seules les ${status.keep} dernières versions y sont gardées : les plus anciennes vont à la corbeille du Drive.`}
          {status.lastRun && ` Dernière vérification : ${date(status.lastRun)}.`}
        </p>
      )}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {status?.releases?.length > 0 && (
        <ul className="drive-releases">
          {status.releases.map(release => (
            <li key={release.tag}>
              <strong>{release.tag}</strong> · {labels[release.state] || release.state}
              {release.folderUrl && (
                <>
                  {' '}
                  ·{' '}
                  <a href={release.folderUrl} target="_blank" rel="noreferrer">
                    Ouvrir le dossier
                  </a>
                </>
              )}
              {release.files?.length > 0 && (
                <span className="drive-files"> ({release.files.map(file => file.name).join(', ')})</span>
              )}
              {release.message && <span className="drive-message"> — {release.message}</span>}
            </li>
          ))}
        </ul>
      )}
      {status?.enabled && status.repository && !status.configurationError && user.role === 'admin' && (
        <button className="secondary-button" disabled={busy || status.running} onClick={() => void start()}>
          {status.running ? 'Archivage en cours…' : 'Vérifier les Releases maintenant'}
        </button>
      )}
      <FormStatus error={error} />
      <a href={docsLink('google-drive.md')} target="_blank" rel="noreferrer">
        Guide de l’archivage Google Drive
      </a>
    </details>
  );
}
