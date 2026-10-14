import React from 'react';

export function avatarLabel(name, kind = 'user') {
  if (kind === 'agent') return 'IA';
  return name?.trim().slice(0, 1).toLocaleUpperCase('fr-FR') || '?';
}

export default function Avatar({ name, kind = 'user', className = 'user-avatar' }) {
  const label = name || 'Auteur inconnu';
  return (
    <span className={className} title={label} aria-label={kind === 'agent' ? `Agent IA : ${label}` : label}>
      {avatarLabel(name, kind)}
    </span>
  );
}
