import { createReadStream } from 'node:fs';
import { validateWorkspace } from '../../src/lib/workspace.js';
import { httpError } from '../http.js';
import { removesContent } from '../store.js';

// Tableau complet de l’interface (lecture conditionnelle, écriture par révision) et sauvegardes.
export function workspaceRoutes({ store, config, auth, guards }) {
  const backups = ctx => {
    guards.admin(ctx);
    if (!config.backups) throw httpError(503, 'backups_unavailable', 'Les sauvegardes ne sont pas configurées.');
  };
  return [
    {
      path: '/api/v1/workspace',
      methods: {
        GET(ctx) {
          auth.readAccess(ctx.req);
          auth.requireAccount(ctx.req);
          const etag = `"${store.getRevision()}"`;
          ctx.res.setHeader('ETag', etag);
          if (ctx.req.headers['if-none-match'] === etag) {
            ctx.res.statusCode = 304;
            ctx.res.end();
            return;
          }
          // Seuls les projets visibles par le compte, avec son rôle sur chacun (access).
          const workspace = store.readFor(auth.requireAccount(ctx.req));
          ctx.res.setHeader('ETag', `"${workspace.revision}"`);
          ctx.send(200, workspace);
        },
        // Remplacement complet : réservé aux administrateurs, qui voient tous les projets
        // (une session limitée supprimerait sinon les projets qu’elle ne voit pas).
        async PUT(ctx) {
          const admin = auth.requireAdmin(ctx.req);
          const match = /^"(\d+)"$/.exec(ctx.req.headers['if-match'] || '');
          if (!match)
            throw httpError(428, 'precondition_required', 'Envoyez la révision obtenue à la lecture dans If-Match.');
          const revision = Number(match[1]);
          const data = await ctx.body();
          let clean;
          try {
            clean = validateWorkspace(data?.projects);
          } catch (error) {
            throw httpError(400, 'invalid_workspace', error.message);
          }
          if (config.backups && store.getRevision() === revision && removesContent(store.read().projects, clean)) {
            try {
              config.backups.create({ kind: 'deletion' });
            } catch {
              throw httpError(
                503,
                'backup_failed',
                'La sauvegarde de sécurité a échoué. La suppression n’a pas été enregistrée.',
              );
            }
          }
          let saved;
          try {
            saved = store.write(clean, revision, admin);
          } catch (error) {
            throw httpError(error.status || 400, error.code || 'invalid_workspace', error.message);
          }
          if (!saved)
            throw httpError(
              409,
              'revision_conflict',
              'Le tableau a changé dans une autre session. Rechargez les données avant de réessayer.',
            );
          ctx.res.setHeader('ETag', `"${saved.revision}"`);
          ctx.send(200, store.readFor(admin));
        },
      },
    },
    {
      path: '/api/v1/backups',
      guard: backups,
      methods: {
        GET: ctx => ctx.send(200, config.backups.status()),
        POST(ctx) {
          let backup;
          try {
            backup = config.backups.create();
          } catch {
            throw httpError(
              503,
              'backup_failed',
              'Impossible de créer la sauvegarde. Vérifiez le stockage et les logs.',
            );
          }
          ctx.send(201, { data: backup });
        },
      },
    },
    {
      path: '/api/v1/backups/:filename',
      guard: backups,
      methods: {
        GET(ctx) {
          const name = ctx.params.filename;
          const file = config.backups.file(name);
          if (!file) throw httpError(404, 'backup_not_found', 'Sauvegarde inexistante.');
          ctx.res.setHeader('Content-Type', 'application/vnd.sqlite3');
          ctx.res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          createReadStream(file)
            .on('error', () => ctx.res.destroy())
            .pipe(ctx.res);
        },
      },
    },
  ];
}
