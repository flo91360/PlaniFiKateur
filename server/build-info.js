import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function readBuildInfo() {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  try {
    const git = args =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let tag;
    try {
      tag = git(['describe', '--tags', '--exact-match', 'HEAD']);
    } catch {
      tag = git(['rev-parse', '--short', 'HEAD']);
    }
    return { tag, version, commit: git(['rev-parse', 'HEAD']), date: git(['show', '-s', '--format=%cI', 'HEAD']) };
  } catch {
    if (/^[a-f0-9]{40}$/.test(process.env.RAILWAY_GIT_COMMIT_SHA || ''))
      return { tag: `v${version}`, version, commit: process.env.RAILWAY_GIT_COMMIT_SHA, date: '' };
    try {
      const info = JSON.parse(readFileSync(new URL('../dist/build-info.json', import.meta.url), 'utf8'));
      return {
        tag: info.tag || info.name,
        version: info.version || version,
        commit: info.commit || process.env.RAILWAY_GIT_COMMIT_SHA || '',
        date: info.date,
      };
    } catch {
      return {
        tag: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || `v${version}`,
        version,
        commit: process.env.RAILWAY_GIT_COMMIT_SHA || '',
        date: '',
      };
    }
  }
}
