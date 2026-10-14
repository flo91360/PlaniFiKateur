const driveId = /^[a-zA-Z0-9_-]{10,200}$/;
export function driveFolderId(value) {
  if (typeof value !== 'string') throw new Error('Indiquez le dossier Google Drive de destination.');
  if (driveId.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Lien du dossier Google Drive invalide.');
  }
  const match = /^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]{10,200})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://drive.google.com' || url.username || url.password || !match)
    throw new Error('Indiquez le lien d’un dossier sur drive.google.com.');
  return match[1];
}
export function validateDriveRelease(value, repository, tag) {
  if (
    !value ||
    typeof repository !== 'string' ||
    typeof tag !== 'string' ||
    typeof value.repository !== 'string' ||
    value.repository.toLowerCase() !== repository.toLowerCase() ||
    value.version !== tag ||
    !/^[a-f0-9]{40}$/.test(value.commit || '') ||
    !driveId.test(value.folderId || '') ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 10
  )
    throw new Error('Publication Google Drive invalide.');
  const files = value.files.map(file => {
    if (
      !file ||
      !driveId.test(file.id || '') ||
      typeof file.name !== 'string' ||
      !/^[^\x00-\x1f/\\]{1,240}\.exe$/i.test(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      !/^[a-f0-9]{32}$/.test(file.md5 || '')
    )
      throw new Error('Exécutable Google Drive invalide.');
    return { id: file.id, name: file.name, size: file.size, md5: file.md5 };
  });
  return { repository: repository.toLowerCase(), version: tag, commit: value.commit, folderId: value.folderId, files };
}
export function driveReleaseFromBody(body, repository, tag) {
  if (typeof body !== 'string' || body.length > 100000) return null;
  const match = /<!-- planifikateur-drive\n([\s\S]{1,12000}?)\n-->/.exec(body);
  if (!match) return null;
  try {
    return validateDriveRelease(JSON.parse(match[1]), repository, tag);
  } catch {
    return null;
  }
}
export function driveReleaseBody(body, release) {
  const previous = String(body || '')
    .replace(/\n?<!-- planifikateur-drive\n[\s\S]*?\n-->\n?\[Télécharger sur Google Drive\]\([^\n]*\)\n?/g, '')
    .trim();
  return `${previous}${previous ? '\n\n' : ''}<!-- planifikateur-drive\n${JSON.stringify(release)}\n-->\n[Télécharger sur Google Drive](https://drive.google.com/drive/folders/${release.folderId})`;
}
