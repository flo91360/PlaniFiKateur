import React, { useEffect, useState } from 'react';

export default function BackupsPanel() {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch('/api/v1/backups', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Impossible de consulter les sauvegardes.');
    setStatus(data);
  };
  useEffect(() => { void load().catch(cause => setError(cause.message)); }, []);
  const download = async name => {
    const response = await fetch(`/api/v1/backups/${name}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Impossible de télécharger la sauvegarde.');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const action = async name => {
    setBusy(true); setError('');
    try {
      if (!name) {
        const response = await fetch('/api/v1/backups', { method: 'POST', credentials: 'same-origin' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Impossible de créer la sauvegarde.');
        name = data.data.name;
        await load();
      }
      await download(name);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  return <section className="backup-panel"><h3>Sauvegardes</h3><p>{status ? `Copie automatique toutes les ${status.intervalHours} heures si les données changent, et avant une suppression. Jusqu’à ${status.keep} copies conservées.` : 'Chargement des sauvegardes…'}</p><p>Téléchargez régulièrement une copie pour la conserver en dehors du site.</p>{(error || status?.error) && <p role="alert" className="form-error">{error || status.error}</p>}<button className="secondary-button" disabled={busy} onClick={() => void action()}>{busy ? 'Préparation…' : 'Créer et télécharger une sauvegarde SQLite'}</button>{status?.files.length > 0 && <ul className="backup-list">{status.files.map(file => <li key={file.name}><span>{new Date(file.createdAt).toLocaleString('fr-FR')} · {Math.ceil(file.size / 1024)} Ko</span><button className="secondary-button" disabled={busy} onClick={() => void action(file.name)}>Télécharger<span className="sr-only"> la sauvegarde du {new Date(file.createdAt).toLocaleString('fr-FR')}</span></button></li>)}</ul>}</section>;
}
