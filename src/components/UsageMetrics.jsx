import React from 'react';
import { useApiResource } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

const number = value => (Number.isFinite(value) ? value : 0);

// Chiffres d’utilisation envoyés chaque semaine par le logiciel (familles de test qui l’ont
// accepté) : un tableau par licence, les semaines les plus récentes d’abord.
export default function UsageMetrics({ projectId }) {
  const list = useApiResource(`projects/${projectId}/usage-metrics`, { every: 300000 });
  const rows = list.data || [];
  const byLicense = new Map();
  for (const row of rows) byLicense.set(row.licenseId, [...(byLicense.get(row.licenseId) || []), row]);
  return (
    <details className="agent-setup" open>
      <summary>Utilisation du logiciel</summary>
      <p>
        Chaque semaine, les postes dont les parents ont accepté l’envoi transmettent des totaux : nombre d’enfants,
        jours d’utilisation, parties et minutes par jeu. Jamais de prénom ni de résultat d’enfant.
      </p>
      {list.loaded && rows.length === 0 && <p className="muted">Aucun relevé reçu pour le moment.</p>}
      {[...byLicense].map(([licenseId, weeks]) => (
        <section key={licenseId} className="usage-license" aria-label={`Utilisation de ${weeks[0].licenseName}`}>
          <h4>{weeks[0].licenseName}</h4>
          <div className="usage-table">
            <table>
              <thead>
                <tr>
                  <th>Semaine</th>
                  <th>Poste</th>
                  <th>Enfants</th>
                  <th>Jours</th>
                  <th>Parties</th>
                  <th>Minutes</th>
                  <th>Jeux</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map(week => (
                  <tr key={`${week.period}-${week.machine}`}>
                    <td>{week.period}</td>
                    <td>
                      <code>{week.machine}</code>
                    </td>
                    <td>{number(week.data.enfants)}</td>
                    <td>{number(week.data.joursActifs)}</td>
                    <td>{number(week.data.parties)}</td>
                    <td>{number(week.data.minutes)}</td>
                    <td>
                      {Object.entries(week.data.jeux || {})
                        .sort((a, b) => number(b[1]?.parties) - number(a[1]?.parties))
                        .map(([game, value]) => `${game} : ${number(value?.parties)} (${number(value?.minutes)} min)`)
                        .join(', ') || '—'}
                    </td>
                    <td>{week.data.version || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <FormStatus error={list.error} />
    </details>
  );
}
