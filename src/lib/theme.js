// Thème de l’interface, choisi sur cet appareil : celui du système par défaut, clair ou sombre.
// Les couleurs suivent `color-scheme` (base.css) ; le choix explicite est posé sur la racine.
import { useCallback, useEffect, useState } from 'react';

export const THEME_STORAGE = 'planifikateur.theme';
// Copie du choix dans un cookie lisible par le serveur : les pages qu’il sert lui-même (README,
// changelog) n’exécutent aucun script et ne peuvent donc pas lire le stockage local.
export const THEME_COOKIE = 'planifikateur_theme';
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

export function themeCookie(theme) {
  return theme === 'clair' || theme === 'sombre'
    ? `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`
    : `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (theme === 'clair' || theme === 'sombre') root.dataset.theme = theme;
  else delete root.dataset.theme;
  if (root !== globalThis.document?.documentElement) return;
  try {
    globalThis.document.cookie = themeCookie(theme);
  } catch {
    // Cookies refusés : les documents servis par le serveur suivent alors le thème du système.
  }
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
