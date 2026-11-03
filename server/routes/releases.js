import { httpError } from '../http.js';

// Exécutables des Releases GitHub du dépôt associé, réservés aux comptes qui voient le projet.
export function releaseRoutes({ store, config, guards }) {
  return [
    {
      path: '/api/v1/projects/:projectId/releases/:tag/files/:file',
      guard: guards.project,
      methods: {
        async GET(ctx) {
          const { projectId, tag, file } = ctx.params;
          const release = store.releaseFile(projectId, tag, file);
          if (!release) throw httpError(404, 'release_file_not_found', 'Exécutable inexistant dans cette version.');
          let location = null;
          try {
            location = await config.releaseDownloads?.link(release.repository, release.tag, release.name);
          } catch {}
          if (!location)
            throw httpError(
              502,
              'release_unavailable',
              'GitHub ne fournit pas ce fichier pour le moment. Réessayez dans quelques minutes.',
            );
          ctx.res.writeHead(302, { Location: location, 'Cache-Control': 'private, no-store' });
          ctx.res.end();
        },
      },
    },
  ];
}
