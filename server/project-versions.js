// Git records creation/commit dates, not publication dates. Only GitHub events
// (tag push or creation) and Releases supply a publication timestamp; missing
// history remains explicitly unknown.
import { driveReleaseFromBody } from '../src/lib/drive-release.js';
export function tagPushVersion(data) {
  if (data?.deleted || typeof data?.ref !== 'string' || !data.ref.startsWith('refs/tags/') || typeof data.repository?.full_name !== 'string') return null;
  const tag = data.ref.slice('refs/tags/'.length);
  const pushed = data.repository.pushed_at;
  const timestamp = typeof pushed === 'number' ? pushed * 1000 : Date.parse(pushed);
  return { repository: data.repository.full_name, version: { tag, date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '' } };
}

// GitHub lists tags by name (v0.1.9 before v0.1.16): prefer the highest version.
export function latestTag(tags) {
  const parse = name => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name)?.slice(1).map(Number);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const versions = tags.map(tag => ({ name: tag.name, version: parse(tag.name) })).filter(tag => tag.version);
  return versions.length ? versions.reduce((best, tag) => compare(tag.version, best.version) > 0 ? tag : best).name : tags[0].name;
}

export function releaseDate(release) {
  return release && !release.draft && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? new Date(release.published_at).toISOString() : '';
}

// A published Release is the publication of its tag version.
export function releaseVersion(data) {
  const repository = data?.repository?.full_name, tag = data?.release?.tag_name, date = releaseDate(data?.release);
  if (!['published', 'released'].includes(data?.action) || typeof repository !== 'string' || typeof tag !== 'string' || !date) return null;
  return { repository, version: { tag, date } };
}

export function createVersionSync(store, { transport = fetch, intervalMs = 15 * 60000, token = '', start = true } = {}) {
  let running = false, closed = false;
  const read = async path => {
    const response = await transport(`https://api.github.com${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PlaniFiKateur', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) throw new Error('Version GitHub temporairement indisponible.');
    return response.json();
  };
  const refresh = async () => {
    if (running || closed) return;
    running = true;
    try {
      store.refreshInfos();
      const repositories = [...new Set(store.read().projects.map(project => store.workflows.githubProject(project.id)).filter(Boolean).map(repo => repo.toLowerCase()))];
      for (const repository of repositories) {
        try {
          const tags = await read(`/repos/${repository}/tags?per_page=100`);
          if (closed) return;
          if (!Array.isArray(tags)) continue;
          if (!tags.length) { store.recordGithubVersion(repository, { tag: 'Aucun tag publié', date: '' }); continue; }
          let events = [];
          // Events are best-effort: private repositories or expired history may
          // still expose tags without a recoverable publication timestamp.
          try { events = await read(`/repos/${repository}/events?per_page=100`); } catch {}
          if (closed) return;
          const published = Array.isArray(events) ? events.filter(event => event.type === 'CreateEvent' && event.payload?.ref_type === 'tag'
            && tags.some(tag => tag.name === event.payload.ref) && Number.isFinite(Date.parse(event.created_at)))
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] : null;
          const tag = published?.payload.ref || latestTag(tags);
          // Tags created by a Release (for example from GitHub Actions) are not
          // pushed with Git: the Release publication date is then their date.
          const releases = new Map();
          const releaseFor = async name => {
            if (!releases.has(name)) releases.set(name, await read(`/repos/${repository}/releases/tags/${encodeURIComponent(name)}`).catch(() => null));
            return releases.get(name);
          };
          const release = published ? null : await releaseFor(tag);
          if (closed) return;
          store.recordGithubVersion(repository, { tag, date: published?.created_at || releaseDate(release) });
          try {
            const currentTag = store.githubVersion(repository)?.tag || tag;
            const current = await releaseFor(currentTag);
            const downloads = current && !current.draft && driveReleaseFromBody(current.body, repository, currentTag);
            if (downloads && !closed) store.recordDriveRelease(repository, downloads);
          } catch { /* Preserve the previous download link during an API outage. */ }
        } catch {
          // Retain the last known version; a GitHub failure must not block the site.
        }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref();
  if (start) void refresh();
  return { refresh, close() { closed = true; clearInterval(timer); } };
}
