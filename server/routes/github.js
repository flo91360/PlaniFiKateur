import { githubEvent } from '../github.js';
import { releaseVersion, tagPushVersion } from '../project-versions.js';
import { driveReleaseFromBody } from '../../src/lib/drive-release.js';
import { httpError } from '../http.js';

const releaseActions = ['published', 'released', 'edited'];

// Webhook GitHub signé et contrôle de fusion demandé par le worker.
export function githubRoutes({ store, config, auth }) {
  const release = (ctx, data) => {
    const repository = data.repository?.full_name,
      release = data.release;
    const listed = releaseActions.includes(data.action);
    const downloads =
      listed && repository && !release?.draft && driveReleaseFromBody(release?.body, repository, release?.tag_name);
    const published = releaseVersion(data);
    if (listed && typeof repository === 'string') store.recordGithubChangelog(repository, [release]);
    const version = published ? store.recordGithubVersion(published.repository, published.version) : { updated: false };
    ctx.send(200, { data: downloads ? store.recordDriveRelease(repository, downloads) : version });
    if (downloads) void config.versions?.refresh();
    if (listed && !release?.draft) void config.driveArchive?.refresh();
  };
  return [
    {
      path: '/api/v1/github/webhook',
      methods: {
        async POST(ctx) {
          const { event, data } = await githubEvent(ctx.req, config.githubWebhookSecret);
          if (event === 'release') return release(ctx, data);
          if (event === 'push') {
            const tag = tagPushVersion(data);
            return ctx.send(200, {
              data: tag ? store.recordGithubVersion(tag.repository, tag.version) : { updated: false },
            });
          }
          const result =
            event === 'pull_request'
              ? store.workflows.githubMerged(data)
              : event === 'workflow_run'
                ? store.workflows.githubChecks(data)
                : { updated: false };
          ctx.send(200, { data: result });
        },
      },
    },
    {
      path: '/api/v1/github/merge-eligibility',
      methods: {
        GET(ctx) {
          const repository = ctx.url.searchParams.get('repository') || '',
            number = Number(ctx.url.searchParams.get('number')),
            sha = ctx.url.searchParams.get('sha') || '';
          if (
            !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
            !Number.isSafeInteger(number) ||
            number < 1 ||
            !/^[a-f0-9]{40}$/.test(sha)
          )
            throw httpError(400, 'invalid_pull_request', 'PR invalide.');
          ctx.send(200, { data: store.workflows.mergeEligible(repository, number, sha, auth.requireAgent(ctx.req)) });
        },
      },
    },
  ];
}
