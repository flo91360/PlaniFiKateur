// Exécutables Windows attachés à une Release GitHub : la carte Version les propose au
// téléchargement directement depuis GitHub.
const executableName = /^[^\x00-\x1f/\\]{1,240}\.exe$/i;
const repositoryName = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Fichiers .exe d’une Release (champ `assets` de l’API GitHub), sans ceux encore en cours d’envoi.
export function releaseExecutables(assets) {
  if (!Array.isArray(assets)) return [];
  return assets
    .filter(
      asset =>
        asset &&
        typeof asset.name === 'string' &&
        executableName.test(asset.name) &&
        (!asset.state || asset.state === 'uploaded') &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0,
    )
    .slice(0, 10)
    .map(asset => ({ name: asset.name, size: asset.size }));
}

export function validateGithubRelease(value) {
  if (
    !value ||
    typeof value.repository !== 'string' ||
    !repositoryName.test(value.repository) ||
    typeof value.tag !== 'string' ||
    !value.tag.trim() ||
    value.tag.length > 140 ||
    /[\u0000-\u001f]/.test(value.tag) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 10
  )
    throw new Error('Release GitHub invalide.');
  const files = value.files.map(file => {
    if (
      !file ||
      typeof file.name !== 'string' ||
      !executableName.test(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1
    )
      throw new Error('Exécutable de la Release GitHub invalide.');
    return { name: file.name, size: file.size };
  });
  return { repository: value.repository, tag: value.tag, files };
}

export const githubReleaseUrl = release =>
  `https://github.com/${release.repository}/releases/tag/${encodeURIComponent(release.tag)}`;
export const githubDownloadUrl = (release, file) =>
  `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(file.name)}`;
