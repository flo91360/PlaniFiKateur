import React from 'react';

// Actualisation ou sauvegarde serveur en échec : les modifications restent dans la page.
export default function SyncAlerts({
  syncError,
  saveStatus,
  saveError,
  saveNotice,
  onRefresh,
  onExport,
  onReload,
  onRetrySave,
  onDismissNotice,
}) {
  return (
    <>
      {saveNotice && (
        <div className="sync-warning" role="alert">
          <p>{saveNotice} Vos autres modifications sont enregistrées.</p>
          <button className="secondary-button" onClick={onDismissNotice}>
            Compris
          </button>
        </div>
      )}
      {syncError && (
        <div className="sync-warning" role="status">
          <p>{syncError}</p>
          <button className="secondary-button" onClick={onRefresh}>
            Réessayer l’actualisation
          </button>
        </div>
      )}
      {saveStatus !== 'saved' && saveStatus !== 'saving' && (
        <div className="sync-warning" role="alert">
          <p>{saveError} Vos modifications restent dans cette page.</p>
          <button className="secondary-button" onClick={onExport}>
            Exporter mes modifications
          </button>
          {saveStatus === 'conflict' ? (
            <button className="secondary-button" onClick={onReload}>
              Recharger le tableau
            </button>
          ) : (
            <button className="secondary-button" onClick={onRetrySave}>
              Réessayer la sauvegarde
            </button>
          )}
        </div>
      )}
    </>
  );
}
