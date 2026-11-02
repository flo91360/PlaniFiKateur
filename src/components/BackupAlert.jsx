import React from 'react';
import { useApiResource } from '../lib/use-api.js';

// Le serveur externe récupère une copie chaque jour : au-delà de deux jours, elle est en retard.
const OFFSITE_LATE_MS = 48 * 3600000;

// Bandeau de l’administrateur : la copie quotidienne hors du site, une fois mise en place, n’est
// plus confirmée. Le statut des sauvegardes est relu toutes les 30 minutes, onglet visible.
export default function BackupAlert() {
  const backups = useApiResource('backups', { raw: true, every: 30 * 60000 });
  const at = Date.parse(backups.data?.offsite?.at);
  if (!(Date.now() - at > OFFSITE_LATE_MS)) return null;
  return (
    <div className="sync-warning" role="status">
      <p>
        La copie quotidienne des données hors du site n’a pas été confirmée depuis le{' '}
        {new Date(at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} :
        vérifiez le service planifikateur-backup sur le VPS.
      </p>
    </div>
  );
}
