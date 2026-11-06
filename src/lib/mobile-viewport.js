// Affichage dézoomé sur téléphone : la page s’ouvre à 80 % pour montrer davantage du tableau
// (colonnes, cartes) sans pincer l’écran. Le zoom manuel reste possible. Les tablettes et
// ordinateurs gardent l’échelle normale. Posé au démarrage, la politique de sécurité du
// serveur interdisant un script en ligne dans index.html.
export const MOBILE_SCALE = 0.8;
const PHONE_MAX_SIDE = 600;

export function viewportContent(screenWidth, screenHeight) {
  const shortest = Math.min(Number(screenWidth) || 0, Number(screenHeight) || 0);
  const phone = shortest > 0 && shortest < PHONE_MAX_SIDE;
  return `width=device-width, initial-scale=${phone ? MOBILE_SCALE : 1}`;
}

export function applyMobileViewport(doc = globalThis.document, screen = globalThis.screen) {
  const meta = doc?.querySelector('meta[name="viewport"]');
  if (!meta || !screen) return;
  const content = viewportContent(screen.width, screen.height);
  if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
}
