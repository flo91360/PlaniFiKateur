// Documentation du site, publiée avec son code source. Une copie déployée depuis un autre dépôt
// la redirige avec VITE_PLANIFIKATEUR_DOCS_URL au moment de la compilation.
const DOCS_URL =
  import.meta.env?.VITE_PLANIFIKATEUR_DOCS_URL || 'https://github.com/flo91360/PlaniFiKateur/blob/main/docs/';

export const docsLink = page => new URL(page, DOCS_URL).href;
