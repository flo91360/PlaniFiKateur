import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedChanges } from '../worker/review.mjs';
import { defaultExecutionProfile } from '../worker/execution-profile.mjs';

// Dépôt simulé : fichiers modifiés et contenu de package.json sur la branche cible et sur HEAD.
const repository =
  (changed, files = {}) =>
  async args => {
    if (args[1] === 'diff') return changed.join('\n');
    if (args[1] === 'show') {
      const content = files[args[2].split(':')[0]];
      if (content === undefined) throw new Error('absent');
      return content;
    }
    throw new Error(args.join(' '));
  };
const scripts = value => JSON.stringify({ version: '1.0.0', scripts: value });

test('workflow, test configuration and npm script changes need a review, ordinary code does not', async () => {
  const planifikateur = defaultExecutionProfile('owner/planifikateur');
  assert.deepEqual(
    await reviewedChanges(planifikateur, repository(['src/app.js', 'tests/app.test.js']), 'origin/main'),
    [],
  );
  assert.deepEqual(
    await reviewedChanges(
      planifikateur,
      repository(['.github/workflows/ci.yml', 'playwright.config.js', 'src/app.js']),
      'origin/main',
    ),
    ['.github/workflows/ci.yml', 'playwright.config.js'],
  );
  // La version change à chaque livraison : seuls les scripts comptent.
  const versionOnly = repository(['package.json'], {
    'origin/main': scripts({ test: 'node --test' }),
    HEAD: JSON.stringify({ version: '1.0.1', scripts: { test: 'node --test' } }),
  });
  assert.deepEqual(await reviewedChanges(planifikateur, versionOnly, 'origin/main'), []);
  const weakened = repository(['package.json'], {
    'origin/main': scripts({ test: 'node --test' }),
    HEAD: scripts({ test: 'true' }),
  });
  assert.deepEqual(await reviewedChanges(planifikateur, weakened, 'origin/main'), ['package.json (scripts)']);
  // Godot : les scripts de test du profil ; pas de package.json à comparer.
  const funkart = defaultExecutionProfile('owner/funkart');
  assert.deepEqual(
    await reviewedChanges(funkart, repository(['tests/autoplay.gd', 'scenes/main.gd', 'package.json']), 'origin/main'),
    ['tests/autoplay.gd'],
  );
});
