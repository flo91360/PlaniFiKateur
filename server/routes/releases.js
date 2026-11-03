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

// Licences du logiciel livré par le projet : gestion par les responsables, activation publique
// par le logiciel (clé + empreinte de la machine) et clé publique de vérification des jetons.
export function licenseRoutes({ store, auth, guards }) {
  const manager = ctx => {
    guards.project(ctx);
    store.requireProject(ctx.user, ctx.params.projectId, 'manager');
  };
  return [
    {
      path: '/api/v1/projects/:projectId/licenses',
      guard: manager,
      methods: {
        GET: ctx => ctx.send(200, { data: store.licenses(ctx.params.projectId) }),
        async POST(ctx) {
          ctx.send(201, { data: store.createLicense(ctx.params.projectId, await ctx.body()) });
        },
      },
    },
    {
      path: '/api/v1/projects/:projectId/licenses/:licenseId',
      guard: manager,
      methods: {
        async PATCH(ctx) {
          const { projectId, licenseId } = ctx.params;
          ctx.send(200, { data: store.updateLicense(projectId, licenseId, await ctx.body()) });
        },
        DELETE(ctx) {
          store.deleteLicense(ctx.params.projectId, ctx.params.licenseId);
          ctx.send(200, { data: { id: ctx.params.licenseId, deleted: true } });
        },
      },
    },
    {
      path: '/api/v1/licenses/activate',
      methods: {
        async POST(ctx) {
          auth.licenseLimit(ctx.req);
          ctx.send(200, { data: store.activateLicense(await ctx.body()) });
        },
      },
    },
    {
      path: '/api/v1/licenses/public-key',
      methods: {
        GET: ctx => ctx.send(200, { data: { algorithm: 'Ed25519', publicKey: store.licensePublicKey() } }),
      },
    },
  ];
}
