import React from 'react';

// Retour d’un formulaire : message de réussite annoncé poliment, erreur en alerte.
export default function FormStatus({ message, error }) {
  return (
    <>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
}
