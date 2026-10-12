import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const parse = version => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version || '');
  if (!match || match.slice(1).some(n => !Number.isSafeInteger(Number(n)))) throw new Error('La version du projet doit utiliser le format majeur.mineur.correctif.');
  return match.slice(1).map(Number);
};
export function nextProjectVersion(base, current) {
  const before = parse(base), after = parse(current);
  const different = after.findIndex((n, i) => n !== before[i]);
  if (different >= 0 && after[different] > before[different]) return current;
  before[2]++; parse(before.join('.')); return before.join('.');
}
export async function bumpProjectVersion(cwd, profile, command) {
  if (!['defilordi', 'funkart'].includes(profile.preset)) return null;
  const npm = profile.preset === 'defilordi', file = npm ? 'package.json' : 'project.godot';
  const regular = async name => { const details = await lstat(join(cwd, name)); if (!details.isFile()) throw new Error(`Le fichier de version ${name} doit être un fichier ordinaire.`); };
  await regular(file);
  const base = await command(['git', 'show', `origin/${profile.branch}:${file}`]);
  const current = await readFile(join(cwd, file), 'utf8');
  const godotVersion = source => /^config\/version="([^"]+)"$/m.exec(source)?.[1];
  const version = nextProjectVersion(npm ? JSON.parse(base).version : godotVersion(base), npm ? JSON.parse(current).version : godotVersion(current));
  if (npm) {
    const json = JSON.parse(current);
    await regular('package-lock.json');
    const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
    json.version = version; lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    await writeFile(join(cwd, file), JSON.stringify(json, null, 2) + '\n');
    await writeFile(join(cwd, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  } else await writeFile(join(cwd, file), current.replace(/^config\/version="[^"]+"$/m, `config/version="${version}"`));
  return version;
}
