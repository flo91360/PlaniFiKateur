import { defineConfig } from 'vite';
import { readBuildInfo } from './server/build-info.js';

import { createApi } from './server/api.js';
import { createStore } from './server/store.js';
import { readConfig } from './server/config.js';
import { createBackups } from './server/backups.js';
import { createRetention } from './server/retention.js';
import { createVersionSync } from './server/project-versions.js';
import { createRepositoryContext } from './server/repository-context.js';

const buildInfo = readBuildInfo();

export default defineConfig({
  define: { __PLANIFIKATEUR_BUILD_INFO__: JSON.stringify(buildInfo) },
  plugins: [
    {
      name: 'planifikateur-api',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify(buildInfo) });
      },
      configureServer(server) {
        const config = readConfig();
        if (
          server.config.server.host === true ||
          (typeof server.config.server.host === 'string' &&
            !['localhost', '127.0.0.1', '::1'].includes(server.config.server.host))
        ) {
          if (!config.ownerToken || !config.readToken)
            throw new Error('Une exposition réseau nécessite les clés propriétaire et lecture.');
        }
        const store = createStore(config.database, { backupDirectory: config.backupDirectory });
        config.versions = createVersionSync(store, { token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '' });
        config.repositoryContext = createRepositoryContext({ token: process.env.PLANIFIKATEUR_GITHUB_TOKEN || '' });
        config.backups = createBackups(store, {
          directory: config.backupDirectory,
          intervalMs: config.backupIntervalMs,
          keep: config.backupKeep,
        });
        const retention = createRetention(store, {
          activityDays: config.activityRetentionDays,
          executionDays: config.executionRetentionDays,
        });
        const api = createApi(store, config);
        server.middlewares.use(api);
        // Les flux d’événements restent ouverts : les fermer avant l’arrêt du serveur de développement.
        const close = server.close.bind(server);
        server.close = async () => {
          api.close();
          return close();
        };
        server.httpServer?.once('close', () => {
          config.versions.close();
          config.backups.close();
          retention.close();
          store.close();
        });
      },
    },
  ],
});
