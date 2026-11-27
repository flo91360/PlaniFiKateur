import { randomBytes } from 'node:crypto';
import { fail } from '../http.js';

// Retours envoyés par le logiciel livré par un projet (bouton « bug » de DefilOrdi) : problème,
// idée ou avis (`kind`), et problème proposé après un plantage (`crash`). Le logiciel
// présente son jeton de licence : seul un poste sous licence peut écrire, et le rapport est rangé
// dans le projet de la licence. Les responsables du projet les lisent dans Paramètres du projet →
// Retours du logiciel. Le rapport ne contient rien sur les enfants : description, version, écran,
// journal technique et, si l’adulte l’a choisie, une capture d’écran.
export const MAX_REPORTS = 500; // par projet : les plus anciens partent au-delà
const MAX_SCREENSHOT = 1500000; // caractères de l’URL data: (≈ 1,1 Mo d’image)
export const REPORT_KINDS = ['bug', 'idea', 'opinion', 'survey'];
// Titre de la notification envoyée aux responsables du projet.
export const KIND_TITLES = {
  bug: 'Nouveau bug signalé',
  idea: 'Nouvelle idée',
  opinion: 'Nouvel avis',
  survey: 'Questionnaire rempli',
};
// Réponses d’un questionnaire (`survey`) : question et réponse en clair, dans l’ordre du logiciel.
const answers = value => {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > 40 ||
    value.some(
      item =>
        !item ||
        typeof item.question !== 'string' ||
        typeof item.answer !== 'string' ||
        item.question.length > 300 ||
        item.answer.length > 4000 ||
        (item.score !== undefined && (!Number.isInteger(item.score) || item.score < 1 || item.score > 10)),
    )
  )
    fail(400, 'invalid_bug_report', 'Réponses : 40 au plus, { question, answer, score? }.');
  return value.map(item => ({
    question: item.question.trim(),
    answer: item.answer.trim(),
    ...(item.score !== undefined ? { score: item.score } : {}),
  }));
};

const text = (value, label, max, required = false) => {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, 'invalid_bug_report', `${label} manquant.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max)
    fail(400, 'invalid_bug_report', `${label} : ${max} caractères au plus.`);
  return value.trim();
};
const screenshot = value => {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > MAX_SCREENSHOT ||
    !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    fail(400, 'invalid_bug_report', 'Capture d’écran : image PNG ou JPEG de 1 Mo au plus.');
  return value;
};
const date = value => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

export function createBugReportStore({ db, transaction, licenseFromToken, notify = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS bug_reports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, license_id TEXT NOT NULL,
      license_name TEXT NOT NULL, client_id TEXT NOT NULL, version TEXT NOT NULL, screen TEXT NOT NULL, system TEXT NOT NULL,
      description TEXT NOT NULL, journal TEXT NOT NULL, screenshot TEXT, reported_at TEXT, received_at TEXT NOT NULL,
      handled_at TEXT, UNIQUE(license_id, client_id));
    CREATE INDEX IF NOT EXISTS bug_reports_project ON bug_reports(project_id, received_at);`);
  // Colonnes ajoutées après coup : sorte de retour et plantage à l’origine du signalement.
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(bug_reports)')
      .all()
      .map(column => column.name),
  );
  if (!columns.has('kind')) db.exec("ALTER TABLE bug_reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'bug'");
  if (!columns.has('crash')) db.exec('ALTER TABLE bug_reports ADD COLUMN crash INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('answers')) db.exec('ALTER TABLE bug_reports ADD COLUMN answers TEXT');
  const view = row => ({
    id: row.id,
    kind: row.kind || 'bug',
    crash: !!row.crash,
    licenseId: row.license_id,
    licenseName: row.license_name,
    version: row.version,
    screen: row.screen,
    system: row.system,
    description: row.description,
    journal: row.journal,
    hasScreenshot: !!row.screenshot,
    reportedAt: row.reported_at,
    receivedAt: row.received_at,
    handled: !!row.handled_at,
    handledAt: row.handled_at,
    answers: row.answers ? JSON.parse(row.answers) : null,
  });
  const find = (projectId, id) => {
    const row = db.prepare('SELECT * FROM bug_reports WHERE id = ? AND project_id = ?').get(id, projectId);
    if (!row) fail(404, 'bug_report_not_found', 'Signalement inexistant dans ce projet.');
    return row;
  };
  return {
    // Envoi du logiciel. Un même rapport renvoyé (file d’attente hors ligne) n’est gardé qu’une fois.
    receiveBugReport(data, now = Date.now()) {
      if (!data || typeof data !== 'object') fail(400, 'invalid_bug_report', 'Signalement attendu.');
      const license = licenseFromToken(data.token);
      if (!license) fail(401, 'bug_report_unauthorized', 'Licence inconnue : signalement refusé.');
      const clientId = text(data.id, 'Identifiant', 64, true);
      if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) fail(400, 'invalid_bug_report', 'Identifiant invalide.');
      const report = {
        description: text(data.description, 'Description', 4000, true),
        version: text(data.version, 'Version', 40),
        screen: text(data.screen, 'Écran', 120),
        system: text(data.system, 'Système', 200),
        journal: text(data.journal, 'Journal', 20000),
        screenshot: screenshot(data.screenshot),
        reportedAt: date(data.reportedAt),
        kind: data.kind === undefined || data.kind === null ? 'bug' : data.kind,
        crash: data.crash === true,
        answers: answers(data.answers),
      };
      if (!REPORT_KINDS.includes(report.kind))
        fail(400, 'invalid_bug_report', `Sorte de retour : ${REPORT_KINDS.join(', ')}.`);
      if (!report.description) fail(400, 'invalid_bug_report', 'Description manquante.');
      return transaction(() => {
        const known = db
          .prepare('SELECT id FROM bug_reports WHERE license_id = ? AND client_id = ?')
          .get(license.licenseId, clientId);
        if (known) return { id: known.id, duplicate: true };
        const id = `bug-${randomBytes(8).toString('hex')}`;
        db.prepare(
          `INSERT INTO bug_reports (id, project_id, license_id, license_name, client_id, version, screen, system, description,
             journal, screenshot, reported_at, received_at, handled_at, kind, crash, answers)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
        ).run(
          id,
          license.projectId,
          license.licenseId,
          license.name,
          clientId,
          report.version,
          report.screen,
          report.system,
          report.description,
          report.journal,
          report.screenshot,
          report.reportedAt,
          new Date(now).toISOString(),
          report.kind,
          report.crash ? 1 : 0,
          report.answers ? JSON.stringify(report.answers) : null,
        );
        db.prepare(
          `DELETE FROM bug_reports WHERE project_id = ? AND id NOT IN
             (SELECT id FROM bug_reports WHERE project_id = ? ORDER BY received_at DESC, id DESC LIMIT ?)`,
        ).run(license.projectId, license.projectId, MAX_REPORTS);
        // Responsables prévenus dans la cloche et sur leurs appareils abonnés.
        notify(license.projectId, license.name, {
          kind: report.kind,
          title: report.crash ? 'Plantage signalé' : KIND_TITLES[report.kind],
          text: `${license.name} : ${report.description}`.slice(0, 300),
        });
        return { id, duplicate: false };
      });
    },
    // Les plus récents d’abord, sans les captures (lues une par une).
    bugReports(projectId) {
      return db
        .prepare('SELECT * FROM bug_reports WHERE project_id = ? ORDER BY received_at DESC, id DESC')
        .all(projectId)
        .map(view);
    },
    bugReportScreenshot(projectId, id) {
      const row = find(projectId, id);
      if (!row.screenshot) fail(404, 'screenshot_missing', 'Ce signalement n’a pas de capture d’écran.');
      return row.screenshot;
    },
    updateBugReport(projectId, id, data) {
      if (!data || typeof data !== 'object' || Object.keys(data).some(key => key !== 'handled'))
        fail(400, 'invalid_bug_report', 'Champ accepté : handled.');
      if (typeof data.handled !== 'boolean') fail(400, 'invalid_bug_report', 'handled doit être un booléen.');
      const row = find(projectId, id);
      db.prepare('UPDATE bug_reports SET handled_at = ? WHERE id = ?').run(
        data.handled ? row.handled_at || new Date().toISOString() : null,
        id,
      );
      return view(find(projectId, id));
    },
    deleteBugReport(projectId, id) {
      find(projectId, id);
      db.prepare('DELETE FROM bug_reports WHERE id = ?').run(id);
    },
  };
}
