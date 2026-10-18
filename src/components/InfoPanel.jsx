import React, { useState } from 'react';
import { ArrowRight, FolderKanban, Sparkles } from 'lucide-react';
import { createId as uid } from '../lib/id.js';
import { exportWithAlert, SERVER_FORM } from '../lib/use-workspace.js';
import { validateWorkspace } from '../lib/workspace.js';

// Projets importés avec de nouveaux identifiants : ils s’ajoutent sans remplacer les existants.
async function readImport(file, projects) {
  if (file.size > 4 * 1024 * 1024) throw new Error('Le fichier dépasse 4 Mo.');
  const json = JSON.parse(await file.text());
  const imported = validateWorkspace(Array.isArray(json) ? json : json.projects).map(p => {
    const listIds = new Map(p.lists.map(l => [l.id, uid()]));
    return {
      ...p,
      id: uid(),
      lists: p.lists.map(l => ({ ...l, id: listIds.get(l.id) })),
      cards: p.cards.map(c => ({
        ...c,
        id: uid(),
        listId: listIds.get(c.listId),
        comments: c.comments.map(m => ({ ...m, id: uid() })),
        attachments: (c.attachments || []).map(a => ({ ...a, id: uid() })),
        checklist: c.checklist.map(t => ({ ...t, id: uid() })),
      })),
    };
  });
  // Les projets affichés n’ont pas le contenu de leurs pièces jointes ; leur taille suffit au contrôle.
  validateWorkspace([...projects, ...imported], SERVER_FORM);
  return imported;
}

function ReloadPrompt({ projects, onReload }) {
  return (
    <>
      <h2>Reprendre les données du serveur ?</h2>
      <p>
        Les modifications non sauvegardées de cette page seront abandonnées. Exportez-les avant de continuer si vous
        souhaitez les conserver.
      </p>
      <button className="secondary-button" onClick={() => exportWithAlert(projects)}>
        Exporter mes modifications
      </button>
      <button className="primary-button" onClick={onReload}>
        Recharger depuis le serveur
      </button>
    </>
  );
}

function Overview({ projects }) {
  return (
    <>
      <span className="info-illustration">
        <FolderKanban size={30} />
      </span>
      <h2>Toutes vos idées ont leur place.</h2>
      <p>
        Votre espace rassemble {projects.length} projets et {projects.reduce((sum, p) => sum + p.cards.length, 0)}{' '}
        cartes. Sélectionnez un projet dans le menu pour retrouver son tableau.
      </p>
    </>
  );
}

function About({ offline }) {
  return (
    <>
      <span className="info-illustration">
        <Sparkles size={30} />
      </span>
      <h2>De l’idée à la réalisation.</h2>
      <p>
        Créez des projets, organisez vos cartes et suivez leur avancement. Les exemples présents au départ sont des
        données de démonstration.
      </p>
      <div className="info-note">
        <strong>{offline ? 'Sauvegarde locale' : 'Sauvegarde serveur'}</strong>
        <p>
          {offline
            ? 'Cette copie HTML conserve vos données dans ce navigateur. Exportez vos projets pour les importer dans la version connectée au serveur.'
            : 'Les cartes enregistrées sont consultables par l’API. Si le serveur refuse une modification, elle reste dans cette page et un message vous permet de la conserver.'}
        </p>
      </div>
      <div className="info-note">
        <strong>{offline ? 'Agent IA indisponible hors ligne' : 'Confier une carte à l’agent IA'}</strong>
        <p>
          {offline
            ? 'Cette copie n’est pas reliée à l’agent : importez vos projets dans le site connecté pour lui confier des cartes.'
            : 'Une fois le dépôt GitHub et l’agent configurés dans les paramètres du projet, passez une carte au statut « Prête à démarrer » : l’agent la prend en charge, pose ses questions dans la discussion, ouvre une PR et la fusionne après les tests GitHub.'}
        </p>
      </div>
    </>
  );
}

// Fenêtre d’information (view : 'info', 'overview' ou 'reload') avec export et import JSON. Les
// sauvegardes de la base sont dans « Mon compte », réservées à l’administrateur.
export default function InfoPanel({ view, projects, offline, onImport, onReload, onClose }) {
  const [importError, setImportError] = useState('');
  return (
    <div className="info-content">
      {view === 'reload' ? (
        <ReloadPrompt projects={projects} onReload={onReload} />
      ) : view === 'overview' ? (
        <Overview projects={projects} />
      ) : (
        <About offline={offline} />
      )}
      <div className="transfer-actions">
        <button className="secondary-button" onClick={() => exportWithAlert(projects)}>
          Exporter les projets (JSON)
        </button>
        <label className="secondary-button import-button">
          Importer des projets
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Importer des projets JSON"
            onChange={async e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                onImport(await readImport(file, projects));
                setImportError('');
              } catch (error) {
                setImportError(error.message);
              }
            }}
          />
        </label>
      </div>
      {importError && (
        <p className="form-error" role="alert">
          {importError}
        </p>
      )}
      <button className="primary-button" onClick={onClose}>
        C’est compris
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
