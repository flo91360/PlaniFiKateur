import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { createStore } from './store.js';
import { readConfig } from './config.js';
import { createBackups } from './backups.js';
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

export function createAppServer({ store, config = {}, dist = resolve('dist') }) {
  const api = createApi(store, config);
  return createServer(async (req, res) => {
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
    res.setHeader(
      'Cache-Control',
      extname(file) === '.html' || path === '/build-info.json' ? 'no-store' : 'public, max-age=3600',
    );
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const store = createStore(config.database);
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
  const server = createAppServer({ store, config });
  server.listen(config.port, config.host, () =>
    console.log(`PlaniFiKateur : serveur actif sur ${config.host}:${server.address().port}`),
  );
  const stop = () =>
    server.close(() => {
      config.versions.close();
      config.driveArchive.close();
      config.backups.close();
      store.close();
      process.exit(0);
    });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
