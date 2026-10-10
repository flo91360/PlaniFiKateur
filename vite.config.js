import { defineConfig } from 'vite';
import { createApi } from './server/api.js';
import { createStore } from './server/store.js';
import { readConfig } from './server/config.js';
import { createBackups } from './server/backups.js';

export default defineConfig({
  plugins: [{
    name: 'planifikateur-api',
    configureServer(server) {
      const config = readConfig();
      if (server.config.server.host === true || (typeof server.config.server.host === 'string' && !['localhost', '127.0.0.1', '::1'].includes(server.config.server.host))) {
        if (!config.ownerToken || !config.readToken) throw new Error('Une exposition réseau nécessite les clés propriétaire et lecture.');
      }
      const store = createStore(config.database);
      config.backups = createBackups(store, { directory: config.backupDirectory, intervalMs: config.backupIntervalMs, keep: config.backupKeep });
      server.middlewares.use(createApi(store, config));
      server.httpServer?.once('close', () => { config.backups.close(); store.close(); });
    },
  }],
});
