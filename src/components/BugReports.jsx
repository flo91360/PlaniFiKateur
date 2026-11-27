import React, { useEffect, useState } from 'react';
import { apiData } from '../lib/api-client.js';
import { useApiAction, useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

const dateFormat = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
});

const KINDS = { bug: 'Problème', idea: 'Idée', opinion: 'Avis' };

// Retours envoyés depuis le logiciel livré par le projet (bouton « bug » de DefilOrdi : problème,
// idée ou avis, et problème proposé après un plantage), envoyés avec
// la licence du poste. Réservé aux responsables du projet. `onCount` reçoit le nombre à traiter,
// affiché sur l’onglet.
export default function BugReports({ projectId, onCount }) {
  const list = useApiResource(`projects/${projectId}/bug-reports`, { every: 120000 });
  const action = useApiAction();
  const [screenshots, setScreenshots] = useState({}),
    [showHandled, setShowHandled] = useState(false);
  const reports = list.data || [],
    open = reports.filter(report => !report.handled),
    shown = showHandled ? reports : open,
    busy = action.busy;
  useEffect(() => {
    if (list.data) onCount?.(open.length);
  }, [list.data, open.length, onCount]);
  const replace = report => list.setData(items => items.map(item => (item.id === report.id ? report : item)));
  const mark = (report, handled) =>
    action.run(
      async () =>
        replace(
          await apiData(`projects/${projectId}/bug-reports/${report.id}`, { method: 'PATCH', data: { handled } }),
        ),
      handled ? 'Retour marqué comme traité.' : 'Retour rouvert.',
    );
  const remove = report =>
    window.confirm('Supprimer définitivement ce retour ?') &&
    action.run(async () => {
      await apiData(`projects/${projectId}/bug-reports/${report.id}`, { method: 'DELETE' });
      list.setData(items => items.filter(item => item.id !== report.id));
    }, 'Retour supprimé.');
  const screenshot = report =>
    action.run(async () => {
      const { screenshot: image } = await apiData(`projects/${projectId}/bug-reports/${report.id}/screenshot`);
      setScreenshots(current => ({ ...current, [report.id]: image }));
    });
  return (
    <details className="agent-setup" open>
      <summary>Retours envoyés depuis le logiciel</summary>
      <p>
        Le bouton « bug » du logiciel envoie ici un problème, une idée ou un avis : le texte écrit par l’adulte, la
        version, l’écran en cours, le journal technique et, si elle a été choisie, une capture d’écran. Après un
        plantage, le logiciel propose aussi de le signaler. Rien sur les enfants n’est envoyé. Un retour fait hors
        connexion arrive au prochain lancement connecté. Chaque nouveau retour est notifié aux responsables du projet.
      </p>
      <label className="bug-reports-filter">
        <input type="checkbox" checked={showHandled} onChange={event => setShowHandled(event.target.checked)} />
        Afficher aussi les retours traités ({reports.length - open.length})
      </label>
      {list.loaded && shown.length === 0 && (
        <p className="muted">{reports.length ? 'Aucun retour à traiter.' : 'Aucun retour reçu pour le moment.'}</p>
      )}
      {shown.length > 0 && (
        <ul className="bug-reports" aria-label="Retours du logiciel">
          {shown.map(report => (
            <li key={report.id} className={report.handled ? 'handled' : ''}>
              <p className="bug-report-meta">
                <span
                  className={
                    report.kind === 'bug' || report.crash ? 'bug-report-kind' : 'bug-report-kind bug-report-idea'
                  }
                >
                  {report.crash ? 'Plantage' : KINDS[report.kind] || report.kind}
                </span>{' '}
                <strong>{dateFormat.format(new Date(report.reportedAt || report.receivedAt))}</strong> ·{' '}
                {report.licenseName}
                {report.version && <> · version {report.version}</>}
                {report.screen && <> · écran : {report.screen}</>}
                {report.handled && <> · traité</>}
              </p>
              <p className="bug-report-description">{report.description}</p>
              {(report.journal || report.system) && (
                <details>
                  <summary>Journal technique</summary>
                  <pre>{[report.system, report.journal].filter(Boolean).join('\n\n')}</pre>
                </details>
              )}
              {screenshots[report.id] && (
                <a href={screenshots[report.id]} target="_blank" rel="noreferrer">
                  <img className="bug-report-screenshot" src={screenshots[report.id]} alt="Capture d’écran jointe" />
                </a>
              )}
              <span className="license-actions">
                {report.hasScreenshot && !screenshots[report.id] && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void screenshot(report)}
                  >
                    Voir la capture
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void mark(report, !report.handled)}
                >
                  {report.handled ? 'Rouvrir' : 'Marquer comme traité'}
                </button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove(report)}>
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
