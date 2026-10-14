// Étiquettes saisies séparées par des virgules : sans doublon ni entrée vide.
export const parseTags = text => [
  ...new Set(
    text
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean),
  ),
];
