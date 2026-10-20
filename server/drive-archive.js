// Archives the .exe assets of each project's GitHub Releases in the owner's
// Google Drive: <dossier>/<dépôt>/<version>/<fichier>.exe. Credentials live
// only on the server, so a project needs no Drive configuration of its own.
import { createWriteStream } from 'node:fs';
import { mkdir, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { publishDrive } from '../scripts/google-drive.mjs';
import { driveFolderId } from '../src/lib/drive-release.js';

export const archivableTag = tag => typeof tag === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(tag);
const executable = asset =>
  asset &&
  typeof asset.name === 'string' &&
  /^[^\x00-\x1f/\\]{1,240}\.exe$/i.test(asset.name) &&
  (!asset.state || asset.state === 'uploaded') &&
  Number.isSafeInteger(asset.size) &&
  asset.size > 0 &&
  Number.isSafeInteger(asset.id);
// Any replaced asset changes its id or update date: the archive is retried once for the new files.
export const assetSignature = assets =>
  assets
    .map(asset => `${asset.id}:${asset.size}:${asset.updated_at || ''}`)
    .sort()
    .join('|');
const retryDelay = attempts => Math.min(24 * 3600000, 15 * 60000 * 2 ** Math.max(0, attempts - 1));

// Node reports every connection failure as "fetch failed": name the service,
// the host and the system cause so the project settings explain what to fix.
export function describedTransport(transport, service) {
  return async (url, options) => {
    try {
      return await transport(url, options);
    } catch (error) {
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return 'serveur inconnu';
        }
      })();
      const detail =
        error?.name === 'TimeoutError'
          ? 'délai dépassé'
          : [error?.cause?.code, error?.cause?.message].filter(Boolean).join(' : ') ||
            error?.message ||
            'erreur inconnue';
      throw Object.assign(
        new Error(
          `${service} injoignable depuis le serveur (${host} : ${detail}). Nouvel essai à la prochaine vérification.`,
        ),
        { network: true },
      );
    }
  };
}

export function readDriveConfig(env = process.env) {
  const raw = env.PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS || '',
    folder = env.PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER || '';
  if (!raw && !folder) return { enabled: false };
  let credentials,
    error = '';
  try {
    credentials = JSON.parse(raw);
  } catch {
    error = 'PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS doit contenir le JSON produit par scripts/google-drive-login.mjs.';
  }
  if (!error && (!credentials?.client_id || !credentials.client_secret || !credentials.refresh_token))
    error = 'PLANIFIKATEUR_GOOGLE_DRIVE_CREDENTIALS est incomplet : relancez scripts/google-drive-login.mjs.';
  try {
    driveFolderId(folder);
  } catch (cause) {
    error ||= `PLANIFIKATEUR_GOOGLE_DRIVE_FOLDER : ${cause.message}`;
  }
  return error ? { enabled: true, error } : { enabled: true, credentials, folder };
}

export function createDriveArchive(
  store,
  {
    drive = { enabled: false },
    token = '',
    directory,
    transport = fetch,
    driveDependencies,
    intervalMs = 15 * 60000,
    maxBytes = 2 * 1024 ** 3,
    releasesPerRepository = 10,
    now = Date.now,
    start = true,
    log = console.log,
  } = {},
) {
  let running = null,
    again = false,
    closed = false;
  transport = describedTransport(transport, 'GitHub');
  // Read per publication so a replaced transport (tests) is used on the next run.
  const google = () => ({
    ...driveDependencies,
    transport: describedTransport(driveDependencies?.transport || fetch, 'Google'),
  });
  const state = { lastRun: '', error: drive.error || '' };
  const github = async (path, accept = 'application/vnd.github+json') => {
    const response = await transport(`https://api.github.com${path}`, {
      // Asset downloads redirect to GitHub storage; fetch drops Authorization across origins.
      redirect: accept === 'application/octet-stream' ? 'follow' : 'error',
      signal: AbortSignal.timeout(accept === 'application/octet-stream' ? 30 * 60000 : 15000),
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PlaniFiKateur',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`GitHub a refusé la lecture de la Release (${response.status}).`), {
        status: response.status,
      });
    return accept === 'application/octet-stream' ? response : response.json();
  };
  const download = async (repository, asset, target) => {
    const response = await github(`/repos/${repository}/releases/assets/${asset.id}`, 'application/octet-stream');
    if (!response.body) throw new Error(`Téléchargement de ${asset.name} vide.`);
    const sha256 = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _, done) {
        size += chunk.length;
        sha256.update(chunk);
        done(
          size > asset.size || size > maxBytes
            ? Object.assign(new Error(`${asset.name} dépasse la taille annoncée par GitHub.`), {
                code: 'asset_too_large',
              })
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if (error.code === 'asset_too_large') throw error;
      throw Object.assign(
        new Error(
          `Téléchargement de ${asset.name} interrompu (${[error.cause?.code, error.cause?.message || error.message].filter(Boolean).join(' : ')}). Nouvel essai à la prochaine vérification.`,
        ),
        { network: true },
      );
    }
    if (size !== asset.size) throw new Error(`${asset.name} est incomplet (${size} octets sur ${asset.size}).`);
    const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '')?.[1];
    if (digest && sha256.digest('hex') !== digest)
      throw new Error(`L’empreinte de ${asset.name} ne correspond pas à celle de GitHub.`);
  };
  const archive = async (repository, release, assets) => {
    const commit = (await github(`/repos/${repository}/commits/${encodeURIComponent(release.tag_name)}`))?.sha;
    if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Commit du tag introuvable sur GitHub.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const folder = await mkdtemp(join(directory, 'release-'));
    try {
      const paths = [];
      for (const asset of assets) {
        const path = join(folder, asset.name);
        await download(repository, asset, path);
        paths.push(path);
      }
      return await publishDrive(
        {
          credentials: drive.credentials,
          rootFolder: drive.folder,
          repository,
          version: release.tag_name,
          commit,
          paths,
        },
        google(),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
  // Keep the configured spelling: it names the project folder in Drive.
  const repositories = () => [
    ...new Map(
      store
        .readLight()
        .projects.map(project => store.workflows.githubProject(project.id))
        .filter(Boolean)
        .map(repo => [repo.toLowerCase(), repo]),
    ).values(),
  ];
  const run = async force => {
    if (!drive.enabled || drive.error || closed) return;
    state.error = '';
    for (const repository of repositories()) {
      let releases;
      try {
        releases = await github(`/repos/${repository}/releases?per_page=${releasesPerRepository}`);
      } catch (error) {
        store.recordDriveRepository(repository, { error: error.message, checkedAt: new Date(now()).toISOString() });
        continue;
      }
      store.recordDriveRepository(repository, { error: '', checkedAt: new Date(now()).toISOString() });
      // Oldest first, so Drive folders are created in version order.
      for (const release of (Array.isArray(releases) ? releases : [])
        .filter(r => !r.draft && archivableTag(r.tag_name))
        .reverse()) {
        if (closed) return;
        const assets = (release.assets || []).filter(executable).slice(0, 10);
        if (!assets.length) continue;
        const signature = assetSignature(assets),
          previous = store.driveArchive(repository, release.tag_name);
        // A manual check retries failed versions now; conflicts wait for new files.
        if (
          previous?.signature === signature &&
          (previous.state === 'archived' ||
            previous.state === 'conflict' ||
            (!force && Date.parse(previous.retryAt) > now()))
        )
          continue;
        try {
          const result = await archive(repository, release, assets);
          store.recordDriveArchive(repository, release.tag_name, {
            signature,
            state: 'archived',
            message: '',
            attempts: 0,
            folderId: result.folderId,
            files: result.files.map(({ name, size }) => ({ name, size })),
            date: new Date(now()).toISOString(),
          });
          store.recordDriveRelease(repository, result);
          log(`Archivage Drive : ${repository} ${release.tag_name} (${result.files.length} exécutable(s)).`);
        } catch (error) {
          if (error.network || error.code === 'drive_unavailable') {
            // A global Drive failure would fail every release; report it once and retry later.
            state.error = error.message;
            return;
          }
          const attempts = (previous?.signature === signature ? previous.attempts || 0 : 0) + 1;
          // A version already archived from other files is never overwritten; only new assets retry it.
          const conflict = error.code === 'drive_conflict';
          store.recordDriveArchive(repository, release.tag_name, {
            signature,
            state: conflict ? 'conflict' : 'error',
            message: error.message.slice(0, 500),
            attempts,
            retryAt: conflict ? '9999-12-31T00:00:00.000Z' : new Date(now() + retryDelay(attempts)).toISOString(),
            date: new Date(now()).toISOString(),
          });
          log(`Archivage Drive : ${repository} ${release.tag_name} en échec (${error.message}).`);
        }
      }
    }
  };
  let forced = false;
  const refresh = ({ force = false } = {}) => {
    forced ||= force;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const force = forced;
          forced = false;
          await run(force);
        } while (again && !closed);
      } catch (error) {
        state.error = error.message;
      } finally {
        state.lastRun = new Date(now()).toISOString();
        running = null;
      }
    })();
    return running;
  };
  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref();
  if (start && drive.enabled)
    void (directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()).then(refresh);
  return {
    refresh,
    status(repository) {
      return {
        enabled: !!drive.enabled,
        configurationError: drive.error || '',
        error: state.error,
        lastRun: state.lastRun,
        running: !!running,
        repository: repository || '',
        ...(repository ? store.driveStatus(repository) : { checkedAt: '', repositoryError: '', releases: [] }),
      };
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
