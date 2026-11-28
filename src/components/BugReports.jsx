import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ImageIcon, Search } from 'lucide-react';
import { apiData } from '../lib/api-client.js';
import { useApiAction } from '../lib/use-api.js';
import FormStatus from './FormStatus.jsx';

const dateFormat = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Paris',
});

const KINDS = { bug: 'Problème', idea: 'Idée', opinion: 'Avis', survey: 'Questionnaire' };
const STATES = [
  ['open', 'À traiter'],
  ['handled', 'Traités'],
  ['all', 'Tous'],
];
const TYPES = [
  ['all', 'Tous les types'],
  ['crash', 'Plantages'],
  ['bug', 'Problèmes'],
  ['idea', 'Idées'],
  ['opinion', 'Avis'],
  ['survey', 'Questionnaires'],
];

const kindLabel = report => (report.crash ? 'Plantage' : KINDS[report.kind] || report.kind);
const kindClass = report =>
  report.kind === 'bug' || report.crash ? 'bug-report-kind' : 'bug-report-kind bug-report-idea';
const dateOf = report => dateFormat.format(new Date(report.reportedAt || report.receivedAt));
// Résumé d’une ligne de la liste : début du texte, ou première réponse d’un questionnaire.
const headline = report =>
  (report.answers ? report.answers.find(item => item.answer)?.answer : report.description)?.trim().split('\n')[0] ||
  'Sans description';
const matches = (report, type, query) =>
  (type === 'all' || (type === 'crash' ? report.crash : !report.crash && report.kind === type)) &&
  (!query ||
    [
      report.description,
      report.licenseName,
      report.version,
      report.screen,
      ...(report.answers || []).map(a => a.answer),
    ]
      .filter(Boolean)
      .some(text => text.toLowerCase().includes(query)));

// Moyenne des notes de chaque question des questionnaires reçus (réponses notées `score`).
function SurveySummary({ reports }) {
  const surveys = reports.filter(report => report.kind === 'survey' && report.answers);
  if (!surveys.length) return null;
  const scores = new Map();
  for (const survey of surveys)
    for (const item of survey.answers)
      if (item.score !== undefined) scores.set(item.question, [...(scores.get(item.question) || []), item.score]);
  return (
    <div className="survey-summary">
      <strong>
        {surveys.length} questionnaire{surveys.length > 1 ? 's' : ''} reçu{surveys.length > 1 ? 's' : ''}
      </strong>
      {scores.size > 0 && (
        <ul aria-label="Moyenne des notes">
          {[...scores].map(([question, values]) => (
            <li key={question}>
              {question} : <strong>{(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}</strong> (
              {values.length} réponse{values.length > 1 ? 's' : ''})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Liste des retours : une ligne par retour, filtrée par état, type et texte cherché.
function ReportList({ reports, shown, filters, onFilters, onOpen, loaded }) {
  const count = state => reports.filter(r => (state === 'all' ? true : state === 'handled' ? r.handled : !r.handled));
  return (
    <>
      <div className="bug-page-toolbar">
        <div className="bug-page-states" role="group" aria-label="État des retours">
          {STATES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filters.state === key}
              onClick={() => onFilters({ ...filters, state: key })}
            >
              {label} <span className="bug-page-count">{count(key).length}</span>
            </button>
          ))}
        </div>
        <select
          aria-label="Type de retour"
          value={filters.type}
          onChange={event => onFilters({ ...filters, type: event.target.value })}
        >
          {TYPES.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <label className="bug-page-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Chercher dans les retours"
            placeholder="Chercher (texte, licence, version, écran)"
            value={filters.query}
            onChange={event => onFilters({ ...filters, query: event.target.value })}
          />
        </label>
      </div>
      <SurveySummary reports={reports} />
      {loaded && shown.length === 0 && (
        <p className="bug-page-empty muted">
          {!reports.length
            ? 'Aucun retour reçu pour le moment.'
            : filters.state === 'open' && filters.type === 'all' && !filters.query
              ? 'Aucun retour à traiter.'
              : 'Aucun retour ne correspond à ces filtres.'}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="bug-page-list" aria-label="Retours du logiciel">
          {shown.map(report => (
            <li key={report.id} className={report.handled ? 'handled' : ''}>
              <button type="button" onClick={() => onOpen(report.id)}>
                <span className={kindClass(report)}>{kindLabel(report)}</span>
                <span className="bug-page-line">
                  <strong>{headline(report)}</strong>
                  <span className="muted">
                    {report.licenseName}
                    {report.version && <> · version {report.version}</>}
                    {report.screen && <> · {report.screen}</>}
                    {report.handled && <> · traité</>}
                  </span>
                </span>
                {report.hasScreenshot && <ImageIcon size={15} aria-label="Capture jointe" />}
                <time dateTime={report.reportedAt || report.receivedAt}>{dateOf(report)}</time>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Détail d’un retour : texte entier, informations du poste, capture affichée d’emblée et journal.
function ReportDetail({ projectId, report, previous, next, onOpen, onBack, onReplace, onRemoved }) {
  const action = useApiAction();
  const [screenshot, setScreenshot] = useState({ id: null, image: '' });
  const busy = action.busy;
  useEffect(() => {
    if (!report.hasScreenshot) return;
    const controller = new AbortController();
    apiData(`projects/${projectId}/bug-reports/${report.id}/screenshot`, { signal: controller.signal })
      .then(({ screenshot: image }) => setScreenshot({ id: report.id, image }))
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, report.id, report.hasScreenshot]);
  const image = screenshot.id === report.id ? screenshot.image : '';
  const mark = handled =>
    action.run(
      async () =>
        onReplace(
          await apiData(`projects/${projectId}/bug-reports/${report.id}`, { method: 'PATCH', data: { handled } }),
        ),
      handled ? 'Retour marqué comme traité.' : 'Retour rouvert.',
    );
  const remove = () =>
    window.confirm('Supprimer définitivement ce retour ?') &&
    action.run(async () => {
      await apiData(`projects/${projectId}/bug-reports/${report.id}`, { method: 'DELETE' });
      onRemoved(report.id);
    });
  const technical = [report.system, report.journal].filter(Boolean).join('\n\n');
  return (
    <article className="bug-page-detail" aria-label="Détail du retour">
      <div className="bug-page-nav">
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={16} />
          Tous les retours
        </button>
        <span>
          <button
            type="button"
            className="icon-button"
            aria-label="Retour précédent"
            disabled={!previous}
            onClick={() => onOpen(previous.id)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Retour suivant"
            disabled={!next}
            onClick={() => onOpen(next.id)}
          >
            <ChevronRight size={18} />
          </button>
        </span>
      </div>
      <header className="bug-page-detail-header">
        <span className={kindClass(report)}>{kindLabel(report)}</span>
        {report.handled && <span className="bug-page-handled">Traité</span>}
        <h2>{headline(report)}</h2>
      </header>
      <dl className="bug-page-facts">
        <dt>Envoyé le</dt>
        <dd>{dateOf(report)}</dd>
        <dt>Licence</dt>
        <dd>{report.licenseName || '—'}</dd>
        <dt>Version</dt>
        <dd>{report.version || '—'}</dd>
        <dt>Écran</dt>
        <dd>{report.screen || '—'}</dd>
      </dl>
      <section>
        <h3>{report.answers ? 'Réponses' : 'Description'}</h3>
        {report.answers ? (
          <dl className="survey-answers">
            {report.answers.map((item, index) => (
              <React.Fragment key={index}>
                <dt>{item.question}</dt>
                <dd>{item.answer || '—'}</dd>
              </React.Fragment>
            ))}
          </dl>
        ) : (
          <p className="bug-report-description">{report.description || 'Sans description'}</p>
        )}
      </section>
      {report.hasScreenshot && (
        <section>
          <h3>Capture d’écran</h3>
          {image ? (
            <a href={image} target="_blank" rel="noreferrer">
              <img className="bug-report-screenshot" src={image} alt="Capture d’écran jointe" />
            </a>
          ) : (
            <p className="muted">Chargement de la capture…</p>
          )}
        </section>
      )}
      {technical && (
        <section>
          <h3>Journal technique</h3>
          <pre className="bug-page-journal">{technical}</pre>
        </section>
      )}
      <div className="license-actions">
        <button
          type="button"
          className={report.handled ? 'secondary-button' : 'primary-button'}
          disabled={busy}
          onClick={() => void mark(!report.handled)}
        >
          {report.handled ? 'Rouvrir' : 'Marquer comme traité'}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void remove()}>
          Supprimer
        </button>
      </div>
      <FormStatus message={action.message} error={action.error} />
    </article>
  );
}

// Page des retours envoyés depuis le logiciel livré par le projet (bouton « bug » de DefilOrdi :
// problème, idée ou avis, problème proposé après un plantage, questionnaire de fin d’essai), avec la
// licence du poste. Réservée aux responsables du projet. `list` est la ressource des retours, lue
// par App pour afficher aussi leur nombre sur le bouton d’accès ; `reportId` le retour ouvert.
export default function BugReportsPage({ project, list, reportId, onOpenReport, onBack }) {
  const [filters, setFilters] = useState({ state: 'open', type: 'all', query: '' });
  const page = useRef(null);
  // Un retour ouvert s’affiche depuis son début, même choisi en bas d’une longue liste.
  useEffect(() => {
    if (reportId) page.current?.scrollIntoView?.({ block: 'start' });
  }, [reportId]);
  const reports = list.data || [];
  const query = filters.query.trim().toLowerCase();
  const shown = reports.filter(
    report =>
      (filters.state === 'all' || (filters.state === 'handled' ? report.handled : !report.handled)) &&
      matches(report, filters.type, query),
  );
  const report = reportId ? reports.find(item => item.id === reportId) : null;
  // Précédent et suivant parmi les retours filtrés ; un retour ouvert hors filtre parcourt tous les retours.
  const sequence = report && shown.includes(report) ? shown : reports;
  const index = report ? sequence.indexOf(report) : -1;
  const replace = updated => list.setData(items => items.map(item => (item.id === updated.id ? updated : item)));
  const removed = id => {
    const following = sequence[index + 1] || sequence[index - 1];
    list.setData(items => items.filter(item => item.id !== id));
    onOpenReport(following && following.id !== id ? following.id : null);
  };
  return (
    <section ref={page} className="bug-page" aria-labelledby="bug-page-title">
      <div className="bug-page-header">
        <button type="button" className="secondary-button" onClick={onBack}>
          <ArrowLeft size={16} />
          Retour au tableau
        </button>
        <div>
          <div className="eyebrow">{project.name}</div>
          <h1 id="bug-page-title">Retours du logiciel</h1>
          {!reportId && (
            <p className="muted">
              Problèmes, idées, avis et questionnaires envoyés par le bouton « bug » du logiciel, avec la version,
              l’écran en cours, le journal technique et la capture choisie. Rien sur les enfants n’est envoyé. Chaque
              nouveau retour est notifié aux responsables du projet.
            </p>
          )}
        </div>
      </div>
      {!list.loaded && !list.error && <p role="status">Chargement des retours…</p>}
      {reportId && list.loaded && !report && (
        <p className="bug-page-empty muted">
          Ce retour n’existe plus.{' '}
          <button type="button" className="link-button" onClick={() => onOpenReport(null)}>
            Voir tous les retours
          </button>
        </p>
      )}
      {report ? (
        <ReportDetail
          key={report.id}
          projectId={project.id}
          report={report}
          previous={sequence[index - 1]}
          next={sequence[index + 1]}
          onOpen={onOpenReport}
          onBack={() => onOpenReport(null)}
          onReplace={replace}
          onRemoved={removed}
        />
      ) : (
        !reportId && (
          <ReportList
            reports={reports}
            shown={shown}
            filters={filters}
            onFilters={setFilters}
            onOpen={onOpenReport}
            loaded={list.loaded}
          />
        )
      )}
      <FormStatus error={list.error} />
    </section>
  );
}
