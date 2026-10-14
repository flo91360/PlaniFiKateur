import React, { useEffect, useRef, useState } from 'react';
import { createId } from '../lib/id.js';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function Attachment({ file, onRemove, disabled, readOnly }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
    const next = URL.createObjectURL(
      new Blob([bytes], { type: imageTypes.has(file.type) ? file.type : 'application/octet-stream' }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file.data, file.type]);
  return (
    <li>
      {imageTypes.has(file.type) && url && <img src={url} alt={`Aperçu de ${file.name}`} />}
      <a href={url} download={file.name}>
        {file.name}
      </a>
      <span>{Math.ceil(file.size / 1024)} Ko</span>
      {!readOnly && (
        <button
          type="button"
          className="delete-button"
          disabled={disabled}
          aria-label={`Retirer ${file.name}`}
          onClick={onRemove}
        >
          Retirer
        </button>
      )}
    </li>
  );
}
// `readOnly` (lecteur du projet) : liste et téléchargement seulement.
export default function Attachments({ otherBytes = 0, attachments, onChange, onBusy = () => {}, readOnly = false }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reading = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const add = async files => {
    if (!files.length || reading.current) return;
    reading.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      if (attachments.length + files.length > 10) throw new Error('Maximum 10 pièces jointes par carte.');
      if (files.some(f => f.size < 1 || f.size > 1024 * 1024))
        throw new Error('Chaque fichier doit peser entre 1 octet et 1 Mo.');
      if ([...attachments, ...files].reduce((sum, f) => sum + f.size, otherBytes) > 2 * 1024 * 1024)
        throw new Error('Maximum 2 Mo de pièces jointes.');
      const added = await Promise.all(
        files.map(
          file =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
              reader.onload = () =>
                resolve({
                  id: createId(),
                  name: file.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255) || 'capture.png',
                  size: file.size,
                  type: /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
                  data: String(reader.result).split(',')[1],
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      if (mounted.current) onChange([...attachments, ...added]);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      reading.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <section
      className="attachments"
      onPaste={e => {
        if (readOnly) return;
        const files = [...e.clipboardData.files];
        if (files.length) {
          e.preventDefault();
          void add(files);
        }
      }}
    >
      <h3>Pièces jointes</h3>
      <p className="muted">
        Fichiers et captures pour l’agent, ou fichiers générés à télécharger. 10 fichiers par carte, 1 Mo par fichier et
        2 Mo au total dans les projets.
      </p>
      {!readOnly && (
        <>
          <label>
            Ajouter des fichiers
            <input
              type="file"
              multiple
              aria-label="Ajouter des fichiers"
              disabled={busy}
              onChange={e => {
                void add([...e.target.files]);
                e.target.value = '';
              }}
            />
          </label>
          <div tabIndex={0} className="attachment-paste" aria-label="Coller une capture d’écran">
            Cliquez ici puis collez une capture d’écran.
          </div>
        </>
      )}
      {busy && <p role="status">Lecture des fichiers…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <ul>
        {attachments.map(file => (
          <Attachment
            key={file.id}
            file={file}
            disabled={busy}
            readOnly={readOnly}
            onRemove={() => onChange(attachments.filter(a => a.id !== file.id))}
          />
        ))}
      </ul>
    </section>
  );
}
