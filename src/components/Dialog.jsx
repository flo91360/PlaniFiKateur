import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// Fenêtre modale accessible : focus piégé, Échap pour fermer, défilement de la page bloqué.
export default function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${wide ? 'wide' : ''}`}>
        <header className="dialog-header">
          <span>{title}</span>
          <button className="icon-button" onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
