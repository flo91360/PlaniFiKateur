import { lstat, realpath, readFile } from 'node:fs/promises';
import { resolve, relative, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';

export async function collectOutputs(cwd, paths = [], executionId) {
  if (!Array.isArray(paths) || paths.length > 10 || new Set(paths).size !== paths.length)
    throw new Error('Maximum dix fichiers générés distincts.');
  const root = await realpath(cwd),
    files = [];
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\\') ||
      path.startsWith('/') ||
      path.includes(':') ||
      path
        .split('/')
        .some(part => !part || part === '..' || part === '.' || (part.startsWith('.') && part !== '.planifikateur')) ||
      (path.startsWith('.planifikateur/') && !path.startsWith('.planifikateur/generated/'))
    )
      throw new Error('Chemin de fichier généré non autorisé. Utilisez .planifikateur/generated/.');
    const target = resolve(root, path),
      resolved = await realpath(target);
    if (relative(root, resolved).startsWith('..' + sep) || resolved === root || resolved !== target)
      throw new Error('Les fichiers générés doivent rester dans le dépôt, sans lien symbolique.');
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024 * 1024)
      throw new Error('Chaque fichier généré doit être un fichier ordinaire de 1 octet à 1 Mo.');
    const bytes = await readFile(target);
    if (bytes.length < 1 || bytes.length > 1024 * 1024) throw new Error('Fichier généré trop volumineux.');
    const name = basename(path);
    if (name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Nom de fichier généré invalide.');
    const type =
      name.endsWith('.ui') || name.endsWith('.xml')
        ? 'application/xml'
        : name.endsWith('.json')
          ? 'application/json'
          : name.endsWith('.txt')
            ? 'text/plain'
            : 'application/octet-stream';
    files.push({
      id: `generated-${executionId}-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`,
      name,
      type,
      size: bytes.length,
      data: bytes.toString('base64'),
      path,
    });
    if (files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024)
      throw new Error('Maximum 2 Mo de fichiers générés au total.');
  }
  return files;
}
