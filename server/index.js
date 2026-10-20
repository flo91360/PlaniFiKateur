import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { createStore } from './store.js';
import { readConfig } from './config.js';
import { createBackups } from './backups.js';
import { createRetention } from './retention.js';
import { createGithubSync } from './github-sync.js';
import { createVersionSync } from './project-versions.js';
import { createDriveArchive, readDriveConfig } from './drive-archive.js';
import { createRepositoryContext } from './repository-context.js';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// Pages HTML : scripts, styles, polices et API de la même origine seulement ; aperçus d’images
// locaux (blob:) ; aucun affichage dans le cadre d’un autre site.
const HTML_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

export function createAppServer({ store, config = {}, dist = resolve('dist') }) {
  const api = createApi(store, config);
  const server = createServer((req, res) =>
    serve(req, res).catch(error => {
      // Dernier recours : une erreur imprévue ferme la requête sans arrêter le serveur.
      (config.logError || console.error)(`PlaniFiKateur : erreur sur ${req.method} ${req.url.split('?')[0]}`, error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      } else res.destroy();
    }),
  );
  async function serve(req, res) {
    if (await api(req, res)) return;
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405);
      res.end();
      return;
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let file = resolve(dist, `.${path}`);
    if (file !== dist && !file.startsWith(dist + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) {
        res.writeHead(404);
        res.end();
        return;
      }
      file = resolve(dist, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(503);
      res.end('Compilez l’interface avec npm run build.');
      return;
    }
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (extname(file) === '.html') for (const [name, value] of Object.entries(HTML_HEADERS)) res.setHeader(name, value);
    // Origine HTTPS : le navigateur n’y revient plus en HTTP.
    if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Les fichiers compilés portent l’empreinte de leur contenu : ils ne changent jamais.
    res.setHeader(
      'Cache-Control',
      extname(file) === '.html' || path === '/build-info.json'
        ? 'no-store'
        : path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    );
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }
  // Les flux d’événements restent ouverts indéfiniment : les fermer pour que l’arrêt aboutisse.
  const close = server.close.bind(server);
  server.close = callback => {
    api.close();
    return close(callback);
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const store = createStore(config.database, { backupDirectory: config.backupDirectory, demo: config.demo });
  config.versions = createVersionSync(store, { token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '' });
  config.repositoryContext = createRepositoryContext({ token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '' });
  config.driveArchive = createDriveArchive(store, {
    drive: readDriveConfig(),
    token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '',
    directory: join(dirname(config.database), 'drive-transfers'),
  });
  config.backups = createBackups(store, {
    directory: config.backupDirectory,
    intervalMs: config.backupIntervalMs,
    keep: config.backupKeep,
  });
  const githubSync = createGithubSync(store, { token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '' });
  const retention = createRetention(store, {
    activityDays: config.activityRetentionDays,
    executionDays: config.executionRetentionDays,
  });
  const server = createAppServer({ store, config });
  server.listen(config.port, config.host, () =>
    console.log(`PlaniFiKateur : serveur actif sur ${config.host}:${server.address().port}`),
  );
  const stop = () =>
    server.close(() => {
      config.versions.close();
      config.driveArchive.close();
      config.backups.close();
      retention.close();
      githubSync.close();
      store.close();
      process.exit(0);
    });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
