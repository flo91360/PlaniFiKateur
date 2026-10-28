// Thème de l’interface, choisi sur cet appareil : celui du système par défaut, clair ou sombre.
// Les couleurs suivent `color-scheme` (base.css) ; le choix explicite est posé sur la racine.
import { useCallback, useEffect, useState } from 'react';

export const THEME_STORAGE = 'planifikateur.theme';
export const THEMES = [
  { id: 'systeme', label: 'Comme le système' },
  { id: 'clair', label: 'Clair' },
  { id: 'sombre', label: 'Sombre' },
];
const isTheme = value => THEMES.some(theme => theme.id === value);

// Le stockage peut être refusé (navigation privée, copie HTML) : le thème du système s’applique alors.
export function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE);
    return isTheme(value) ? value : 'systeme';
  } catch {
    return 'systeme';
  }
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (theme === 'clair' || theme === 'sombre') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

const darkQuery = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)');

// Thème choisi, thème sombre effectivement affiché et enregistrement d’un nouveau choix.
export function useTheme() {
  const [theme, setCurrent] = useState(storedTheme);
  const [systemDark, setSystemDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    const update = event => setSystemDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback(next => {
    const value = isTheme(next) ? next : 'systeme';
    setCurrent(value);
    try {
      if (value === 'systeme') localStorage.removeItem(THEME_STORAGE);
      else localStorage.setItem(THEME_STORAGE, value);
    } catch {
      // Choix gardé pour cette page seulement.
    }
  }, []);
  return { theme, dark: theme === 'sombre' || (theme === 'systeme' && systemDark), setTheme };
}
