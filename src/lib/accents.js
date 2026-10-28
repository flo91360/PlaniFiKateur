// Couleurs dominantes proposées dans « Mon compte ». Module partagé : le serveur n’accepte que
// ces identifiants et l’interface applique les teintes correspondantes. Chaque teinte est
// vérifiée (tests/accents.test.js) pour garder un contraste lisible du texte et des contrôles.
export const DEFAULT_ACCENT = 'foret';

// Variables CSS appliquées sur la racine du document pour chaque couleur.
export const ACCENT_VARIABLES = {
  primary: '--primary',
  hover: '--primary-hover',
  soft: '--primary-soft',
  ring: '--primary-ring',
  sidebar: '--sidebar',
  sidebarRaised: '--sidebar-raised',
  sidebarHover: '--sidebar-hover',
  sidebarActive: '--sidebar-active',
  sidebarBorder: '--sidebar-border',
  sidebarText: '--sidebar-text',
  sidebarSoft: '--sidebar-soft',
  sidebarMuted: '--sidebar-muted',
  sidebarAccent: '--sidebar-accent',
};

export const ACCENTS = [
  {
    id: 'foret',
    label: 'Forêt (par défaut)',
    primary: '#28734b',
    hover: '#1e5939',
    soft: '#e9f3ef',
    ring: '#a5c8ba',
    sidebar: '#193d2f',
    sidebarRaised: '#24483a',
    sidebarHover: '#2a4d3f',
    sidebarActive: '#315345',
    sidebarBorder: '#345648',
    sidebarText: '#eff6f3',
    sidebarSoft: '#b7cac2',
    sidebarMuted: '#88a69a',
    sidebarAccent: '#a4dfc7',
  },
  {
    id: 'ocean',
    label: 'Océan',
    primary: '#1d4ed8',
    hover: '#1e40af',
    soft: '#eaf0fd',
    ring: '#a9c1f5',
    sidebar: '#172e57',
    sidebarRaised: '#223962',
    sidebarHover: '#283f68',
    sidebarActive: '#2f466f',
    sidebarBorder: '#324972',
    sidebarText: '#eef3fb',
    sidebarSoft: '#b9c7e0',
    sidebarMuted: '#8fa3c4',
    sidebarAccent: '#a9c6f7',
  },
  {
    id: 'prune',
    label: 'Prune',
    primary: '#6d28d9',
    hover: '#5b21b6',
    soft: '#f3effd',
    ring: '#c9b6f2',
    sidebar: '#2b1d4f',
    sidebarRaised: '#36285a',
    sidebarHover: '#3c2e60',
    sidebarActive: '#433567',
    sidebarBorder: '#46386a',
    sidebarText: '#f3effb',
    sidebarSoft: '#cdc3e6',
    sidebarMuted: '#a99cc8',
    sidebarAccent: '#c9b6f7',
  },
  {
    id: 'framboise',
    label: 'Framboise',
    primary: '#be123c',
    hover: '#9f1239',
    soft: '#fdeef1',
    ring: '#f1abbb',
    sidebar: '#46142a',
    sidebarRaised: '#511f35',
    sidebarHover: '#57253b',
    sidebarActive: '#5e2c42',
    sidebarBorder: '#612f45',
    sidebarText: '#fbeff3',
    sidebarSoft: '#e3c6d2',
    sidebarMuted: '#c79aae',
    sidebarAccent: '#f5b3c8',
  },
  {
    id: 'cuivre',
    label: 'Cuivre',
    primary: '#a14a0a',
    hover: '#92400e',
    soft: '#fef6ec',
    ring: '#ecc28f',
    sidebar: '#43260f',
    sidebarRaised: '#4e311a',
    sidebarHover: '#543720',
    sidebarActive: '#5b3e27',
    sidebarBorder: '#5e412a',
    sidebarText: '#fbf3ea',
    sidebarSoft: '#e0cbb6',
    sidebarMuted: '#c2a58a',
    sidebarAccent: '#f3c48f',
  },
  {
    id: 'ardoise',
    label: 'Ardoise',
    primary: '#475569',
    hover: '#334155',
    soft: '#eef1f5',
    ring: '#b4bfcc',
    sidebar: '#1e2633',
    sidebarRaised: '#293141',
    sidebarHover: '#2f3747',
    sidebarActive: '#363e4e',
    sidebarBorder: '#394151',
    sidebarText: '#f1f4f8',
    sidebarSoft: '#c5ccd8',
    sidebarMuted: '#9aa5b8',
    sidebarAccent: '#b9c6da',
  },
];

export const isAccent = value => ACCENTS.some(accent => accent.id === value);
export const accentById = id => ACCENTS.find(accent => accent.id === id) || ACCENTS[0];

// Contraste WCAG 2.x entre deux couleurs #rrggbb.
const channel = value => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(index => channel(parseInt(hex.slice(index, index + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

// Applique la couleur sur la page (navigateur uniquement).
export function applyAccent(id, root = globalThis.document?.documentElement) {
  if (!root) return;
  const accent = accentById(id);
  for (const [key, variable] of Object.entries(ACCENT_VARIABLES)) root.style.setProperty(variable, accent[key]);
  // Fonds teintés pour le thème sombre : la couleur dominante mélangée à la surface sombre.
  root.style.setProperty(
    '--primary-soft',
    `light-dark(${accent.soft}, color-mix(in srgb, ${accent.primary} 32%, #1a2320))`,
  );
  root.style.setProperty(
    '--primary-ring',
    `light-dark(${accent.ring}, color-mix(in srgb, ${accent.sidebarAccent} 45%, #1a2320))`,
  );
  root.dataset.accent = accent.id;
}
