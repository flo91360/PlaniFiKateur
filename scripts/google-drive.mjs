import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { driveFolderId, validateDriveRelease } from '../src/lib/drive-release.js';

// Erreurs identifiées par leur code, que l’archivage serveur distingue sans lire le message :
// drive_unavailable (compte ou dossier inutilisable, pour toutes les versions) et drive_conflict
// (version déjà archivée depuis d’autres fichiers, jamais remplacée).
export const driveError = (code, message) => Object.assign(new Error(message), { code });
const escapeQuery = value => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
export async function fileIdentity(path) {
  const details = await stat(path),
    md5 = createHash('md5');
  if (!details.isFile() || !details.size) throw new Error('L’exécutable à publier est vide ou absent.');
  for await (const chunk of createReadStream(path)) md5.update(chunk);
  return { name: basename(path), size: details.size, md5: md5.digest('hex') };
}
export function createDriveClient(
  credentials,
  folder,
  { transport = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {},
) {
  const root = driveFolderId(folder);
  if (!credentials?.client_id || !credentials.client_secret || !credentials.refresh_token)
    throw driveError(
      'drive_unavailable',
      'Configurez GOOGLE_DRIVE_CREDENTIALS avec l’authentification de votre compte Google.',
    );
  let token,
    expires = 0;
  const folders = new Set([root]);
  const refresh = async () => {
    const response = await transport('https://oauth2.googleapis.com/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok)
      throw driveError(
        'drive_unavailable',
        `Authentification Google refusée (${response.status}). Reconnectez le compte Google.`,
      );
    const data = await response.json();
    if (!data.access_token || !Number.isFinite(data.expires_in))
      throw new Error('Réponse d’authentification Google invalide.');
    token = data.access_token;
    expires = Date.now() + data.expires_in * 1000 - 60000;
  };
  const request = async (url, options = {}) => {
    const target = new URL(url);
    if (target.origin !== 'https://www.googleapis.com' || !/^\/(?:upload\/)?drive\/v3\//.test(target.pathname))
      throw new Error('Destination Google Drive non autorisée.');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!token || Date.now() >= expires) await refresh();
      // Resumable uploads answer 308 "Resume Incomplete": read it, never follow it
      // (redirect: 'error' makes fetch throw on any 3xx; other 3xx stay non-ok errors).
      const response = await transport(target, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        expires = 0;
        continue;
      }
      // A failed folder/file creation may have reached Google already. A new
      // publication will list existing children before attempting it again.
      const retryable =
        response.status === 429 ||
        (!['POST', 'PATCH'].includes(options.method) && [500, 502, 503, 504].includes(response.status));
      if (retryable && attempt < 3) {
        await wait(1000 * 2 ** attempt);
        continue;
      }
      return response;
    }
    throw new Error('Connexion Google Drive temporairement indisponible.');
  };
  const json = async (path, options) => {
    const response = await request(`https://www.googleapis.com/drive/v3/${path}`, options);
    if (!response.ok)
      throw new Error(
        `Google Drive a refusé l’opération (${response.status}). Vérifiez l’accès au dossier et le stockage disponible.`,
      );
    return response.json();
  };
  const list = async (parent, name) => {
    if (!folders.has(parent)) throw new Error('Le dossier doit rester sous la destination autorisée.');
    const out = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({
        q: `'${escapeQuery(parent)}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
        spaces: 'drive',
        fields: 'nextPageToken,files(id,name,mimeType,parents,appProperties,md5Checksum,size)',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await json(`files?${query}`);
      out.push(...data.files);
      pageToken = data.nextPageToken || '';
      if (out.length > 1000) throw new Error('Trop de fichiers homonymes dans le dossier de destination.');
    } while (pageToken);
    return out;
  };
  return {
    async validateRoot() {
      const folder = await json(
        `files/${root}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`,
      );
      if (
        folder.id !== root ||
        folder.trashed ||
        folder.mimeType !== 'application/vnd.google-apps.folder' ||
        !folder.capabilities?.canAddChildren
      )
        throw driveError(
          'drive_unavailable',
          'Le dossier fourni est absent ou votre compte ne peut pas y ajouter des fichiers.',
        );
      return root;
    },
    async folder(parent, name, properties = {}) {
      const existing = await list(parent, name);
      if (
        existing.length > 1 ||
        existing.some(file => file.mimeType !== 'application/vnd.google-apps.folder' || !file.parents?.includes(parent))
      )
        throw new Error('Plusieurs éléments portent le nom du dossier attendu. Aucun élément n’a été modifié.');
      const selected =
        existing[0] ||
        (await json('files?fields=id,name,parents,appProperties&supportsAllDrives=true', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parent],
            appProperties: properties,
          }),
        }));
      if (!selected.parents?.includes(parent))
        throw new Error('Le dossier retourné est hors de la destination autorisée.');
      if (
        properties.commit &&
        (selected.appProperties?.commit !== properties.commit ||
          selected.appProperties?.repository !== properties.repository)
      )
        throw driveError(
          'drive_conflict',
          'Cette version appartient déjà à un autre commit. Augmentez le numéro de version ; les anciens fichiers sont conservés.',
        );
      folders.add(selected.id);
      return selected.id;
    },
    async upload(parent, path) {
      const identity = await fileIdentity(path),
        existing = await list(parent, identity.name);
      if (existing.length) {
        if (
          existing.length !== 1 ||
          !existing[0].parents?.includes(parent) ||
          existing[0].md5Checksum !== identity.md5 ||
          Number(existing[0].size) !== identity.size
        )
          throw driveError(
            'drive_conflict',
            'Un fichier différent existe déjà dans cette version. Aucun exécutable n’a été remplacé.',
          );
        return { id: existing[0].id, ...identity };
      }
      const initiated = await request(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,md5Checksum,size',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'application/vnd.microsoft.portable-executable',
            'X-Upload-Content-Length': String(identity.size),
          },
          body: JSON.stringify({ name: identity.name, parents: [parent] }),
        },
      );
      if (!initiated.ok) throw new Error(`Impossible de commencer l’envoi Google Drive (${initiated.status}).`);
      const location = initiated.headers.get('location');
      if (!location) throw new Error('Session d’envoi Google Drive absente.');
      const handle = await open(path, 'r');
      let position = 0,
        result;
      try {
        while (position < identity.size) {
          const bytes = Buffer.alloc(Math.min(8 * 1024 * 1024, identity.size - position));
          const read = await handle.read(bytes, 0, bytes.length, position);
          if (read.bytesRead !== bytes.length) throw new Error('L’exécutable a changé pendant son envoi.');
          const response = await request(location, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/vnd.microsoft.portable-executable',
              'Content-Range': `bytes ${position}-${position + bytes.length - 1}/${identity.size}`,
            },
            body: bytes,
          });
          if (response.status === 308) {
            const range = /^bytes=0-(\d+)$/.exec(response.headers.get('range') || '');
            const next = range ? Number(range[1]) + 1 : 0;
            if (next <= position || next > identity.size)
              throw new Error('Progression de l’envoi Google Drive invalide.');
            position = next;
          } else if (response.ok) {
            result = await response.json();
            position = identity.size;
          } else
            throw new Error(
              `Envoi Google Drive interrompu (${response.status}). Relancez la publication pour reprendre les fichiers manquants.`,
            );
        }
      } finally {
        await handle.close();
      }
      if (!result?.id || result.md5Checksum !== identity.md5 || Number(result.size) !== identity.size)
        throw new Error('Google Drive n’a pas confirmé l’intégrité du fichier envoyé.');
      return { id: result.id, ...identity };
    },
  };
}

export async function publishDrive({ credentials, rootFolder, repository, version, commit, paths }, dependencies) {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    !/^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.length > 10 ||
    paths.some(path => !/\.exe$/i.test(path))
  )
    throw new Error('Dépôt, version ou liste d’exécutables invalide.');
  const identities = await Promise.all(paths.map(fileIdentity));
  if (identities.some(file => !/^[^\x00-\x1f/\\]{1,240}\.exe$/i.test(file.name)))
    throw new Error('Nom d’exécutable invalide.');
  if (new Set(identities.map(file => file.name)).size !== identities.length)
    throw new Error('Deux exécutables portent le même nom.');
  const drive = createDriveClient(credentials, rootFolder, dependencies);
  const root = await drive.validateRoot();
  const project = await drive.folder(root, repository.split('/')[1]);
  const folderId = await drive.folder(project, version, { repository: repository.toLowerCase(), commit });
  const files = [];
  for (const path of paths) files.push(await drive.upload(folderId, path));
  return validateDriveRelease({ repository, version, commit, folderId, files }, repository, version);
}
