import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function readBuildInfo() {
  try {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { name: git(['describe', '--tags', '--always']), date: git(['show', '-s', '--format=%cI', 'HEAD']) };
  } catch {
    try { return JSON.parse(readFileSync(new URL('../dist/build-info.json', import.meta.url), 'utf8')); }
    catch {
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      return { name: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || `v${version}`, date: '' };
    }
  }
}
