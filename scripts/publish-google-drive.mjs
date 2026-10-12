import { readdir, realpath, appendFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDrive } from './google-drive.mjs';
import { driveReleaseBody, validateDriveRelease } from '../src/lib/drive-release.js';

export async function executablePaths(directory) {
  const root = await realpath(directory), out = [];
  const visit = async (folder, depth = 0) => {
    if (depth > 6) throw new Error('Les exécutables sont trop profondément imbriqués.');
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Les liens symboliques ne sont pas acceptés dans les fichiers à publier.');
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
        const checked = await realpath(path), local = relative(root, checked);
        if (local === '..' || local.startsWith('..' + sep)) throw new Error('Un fichier est hors du dossier des exécutables.');
        out.push(checked);
      }
    }
  };
  await visit(root); return out.sort();
}
export async function updateGithubRelease(repository, release, token, transport = fetch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !token) throw new Error('Dépôt ou authentification GitHub absent.');
  release = validateDriveRelease(release, repository, release?.version);
  const request = async (path, method = 'GET', body) => {
    const response = await transport(`https://api.github.com/repos/${repository}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`Le lien Google Drive n’a pas pu être publié sur GitHub (${response.status}). Les fichiers Drive sont conservés ; relancez la publication.`);
    return response.json();
  };
  const previous = await request(`/releases/tags/${encodeURIComponent(release.version)}`);
  const body = driveReleaseBody(previous?.body, release);
  if (previous?.draft) throw new Error('La Release GitHub de cette version est encore un brouillon.');
  if (previous) return request(`/releases/${previous.id}`, 'PATCH', { body });
  return request('/releases', 'POST', { tag_name: release.version, target_commitish: release.commit, name: `${repository.split('/')[1]} ${release.version}`, body });
}
export async function main(env = process.env) {
  let credentials;
  try { credentials = JSON.parse(env.GOOGLE_DRIVE_CREDENTIALS || ''); } catch { throw new Error('Le secret GOOGLE_DRIVE_CREDENTIALS doit contenir le JSON d’authentification Google.'); }
  const repository = env.GITHUB_REPOSITORY;
  const release = await publishDrive({ credentials, rootFolder: env.GOOGLE_DRIVE_FOLDER_ID, repository, version: env.DRIVE_VERSION, commit: env.GITHUB_SHA, paths: await executablePaths(env.DRIVE_ARTIFACT_DIR) });
  await updateGithubRelease(repository, release, env.GITHUB_TOKEN);
  const url = `https://drive.google.com/drive/folders/${release.folderId}`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `folder-url=${url}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Exécutables disponibles\n\n[${repository.split('/')[1]} ${release.version} sur Google Drive](${url})\n\n${release.files.map(file => `- ${file.name}`).join('\n')}\n`);
  console.log(`Publication ${release.version} terminée : ${release.files.length} exécutable(s).`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
