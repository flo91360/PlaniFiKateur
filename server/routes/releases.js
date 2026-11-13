import { httpError } from '../http.js';
import { markdownPage, themeFromCookie } from '../markdown.js';

// Exécutables des Releases GitHub du dépôt associé, réservés aux comptes qui voient le projet.
export function releaseRoutes({ store, config, guards }) {
  return [
    // README et CHANGELOG.md du dépôt associé, lus par le serveur avec son jeton : l’ergothérapeute
    // ou tout autre compte du projet les consulte sans accès GitHub au dépôt privé.
    {
      path: '/api/v1/projects/:projectId/documents/:document',
      guard: guards.project,
      methods: {
        async GET(ctx) {
          const { projectId, document } = ctx.params;
          if (!['readme', 'changelog'].includes(document))
            throw httpError(404, 'document_not_found', 'Document inconnu : readme ou changelog.');
          const repository = store.workflows.githubProject(projectId);
          if (!repository)
            throw httpError(404, 'repository_missing', 'Associez un dépôt GitHub au projet pour lire ce document.');
          let text = null;
          try {
            text = await config.releaseDownloads?.document(repository, document);
          } catch {}
          if (text === null || text === undefined)
            throw httpError(
              502,
              'document_unavailable',
              'GitHub ne fournit pas ce document pour le moment. Réessayez dans quelques minutes.',
            );
          // Page mise en forme (titres, listes, liens) plutôt que le Markdown brut.
          const body = Buffer.from(
            markdownPage({
              title: document === 'readme' ? 'Mode d’emploi' : 'Changelog',
              subtitle: repository.split('/').pop(),
              markdown: text,
              theme: themeFromCookie(ctx.req.headers.cookie),
            }),
            'utf8',
          );
          ctx.res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': body.length,
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'private, no-store',
          });
          ctx.res.end(body);
        },
      },
    },
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
