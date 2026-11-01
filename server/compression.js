import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Compression des réponses : moins de trafic sortant (fichiers de l’interface, JSON de l’API).
// Le flux d’événements n’est jamais compressé : il doit arriver au fil de l’eau.

// Types de fichiers qui gagnent à être compressés ; les polices woff/woff2 le sont déjà.
export const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
// En dessous, l’en-tête de compression coûte plus qu’il ne fait gagner.
const MIN_BYTES = 1024;
// Variantes précompressées écrites à la compilation (vite.config.js), de la préférée à la suivante.
export const ENCODINGS = [
  { name: 'br', extension: '.br' },
  { name: 'gzip', extension: '.gz' },
];

// Le navigateur accepte-t-il cet encodage (`Accept-Encoding`, en tenant compte de `q=0`) ?
export function accepts(header, encoding) {
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== encoding && name !== '*') continue;
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

// Corps JSON de l’API : brotli rapide (qualité 4) ou gzip, selon ce que le client accepte.
export function compressBody(res, body) {
  res.setHeader('Vary', 'Accept-Encoding');
  const header = res.req?.headers['accept-encoding'];
  if (Buffer.byteLength(body) < MIN_BYTES || !header) return body;
  if (accepts(header, 'br')) {
    res.setHeader('Content-Encoding', 'br');
    return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  }
  if (accepts(header, 'gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    return gzipSync(body, { level: 6 });
  }
  return body;
}

// Compression maximale, faite une fois à la compilation : rien n’est recompressé au réveil du service.
export function precompress(source) {
  if (source.length < MIN_BYTES) return [];
  return [
    {
      extension: '.br',
      data: brotliCompressSync(source, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
    },
    { extension: '.gz', data: gzipSync(source, { level: 9 }) },
  ].filter(variant => variant.data.length < source.length);
}
