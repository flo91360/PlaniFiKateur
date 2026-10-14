import React from 'react';

// These actions update local state; they never submit or navigate a document.
// Embedded HTML previews may allow scripts while prohibiting native forms.
export default function LocalForm({ onConfirm, formRef, children, ...props }) {
  return (
    <form
      {...props}
      ref={formRef}
      onSubmit={e => {
        e.preventDefault();
        onConfirm();
      }}
      onKeyDown={e => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        const inputEnter = e.target.tagName === 'INPUT' && e.target.type !== 'checkbox';
        const commentShortcut = e.target.tagName === 'TEXTAREA' && (e.ctrlKey || e.metaKey);
        if (inputEnter || commentShortcut) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      {children}
    </form>
  );
}
