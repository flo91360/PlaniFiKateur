import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const UnsavedContext = createContext(null);

// Un formulaire signale sa saisie non enregistrée : fermer la fenêtre (Échap, clic à côté, croix)
// demande alors confirmation au lieu de perdre la saisie.
export function useUnsavedChanges(dirty) {
  const report = useContext(UnsavedContext);
  useEffect(() => {
    report?.(dirty);
    return () => report?.(false);
  }, [dirty, report]);
}

// Fenêtre modale accessible : focus piégé, Échap pour fermer, défilement de la page bloqué.
export default function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const [dirty, setDirty] = useState(false),
    [confirming, setConfirming] = useState(false);
  const report = useCallback(value => setDirty(value), []);
  const requestClose = () => (dirty ? setConfirming(true) : onClose());
  const closeRef = useRef(requestClose);
  closeRef.current = confirming ? () => setConfirming(false) : requestClose;
  const keepRef = useRef(null);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    const focusables = () =>
      [...el.querySelectorAll('button, input, textarea, select, [tabindex="0"]')].filter(e => !e.disabled);
    focusables()[0]?.focus();
    const handle = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const list = focusables();
        const first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    el.addEventListener('keydown', handle);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      el.removeEventListener('keydown', handle);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={e => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${wide ? 'wide' : ''}`}>
        <header className="dialog-header">
          <span>{title}</span>
          <button className="icon-button" onClick={requestClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </header>
        {confirming && (
          <div className="dialog-discard" role="alert">
            <p>Votre saisie n’est pas enregistrée. Fermer cette fenêtre la fera perdre.</p>
            <div className="form-actions">
              <button ref={keepRef} type="button" className="secondary-button" onClick={() => setConfirming(false)}>
                Continuer la saisie
              </button>
              <button type="button" className="delete-button" onClick={onClose}>
                Abandonner la saisie
              </button>
            </div>
          </div>
        )}
        <UnsavedContext.Provider value={report}>{children}</UnsavedContext.Provider>
      </section>
    </div>
  );
}
