import picomatch from 'picomatch';
import { presetRules } from './execution-profile.mjs';

// Contrôles qui autorisent la fusion automatique : workflows GitHub, scripts npm et fichiers de
// configuration des tests déclarés par le profil installé (`reviewPaths`). Une PR qui les modifie
// pourrait affaiblir ses propres tests ; un responsable approuve alors le commit avant la fusion.
const ALWAYS = ['.github/**'];

const scriptsOf = source => {
  try {
    return JSON.stringify(JSON.parse(source).scripts || {});
  } catch {
    return null;
  }
};

// Liste lisible des contrôles modifiés entre la branche cible et HEAD (vide si aucun).
export async function reviewedChanges(profile, command, base) {
  const changed = (await command(['git', 'diff', '--name-only', `${base}...HEAD`])).split('\n').filter(Boolean);
  const matches = picomatch([...ALWAYS, ...(presetRules(profile).reviewPaths || [])], { dot: true });
  const reasons = changed.filter(path => matches(path));
  if (presetRules(profile).versioning?.format === 'npm' && changed.includes('package.json')) {
    const show = async ref => command(['git', 'show', `${ref}:package.json`]).catch(() => '');
    if (scriptsOf(await show(base)) !== scriptsOf(await show('HEAD'))) reasons.push('package.json (scripts)');
  }
  return [...new Set(reasons)].sort().slice(0, 50);
}
