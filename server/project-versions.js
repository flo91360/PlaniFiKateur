// Git records creation/commit dates, not tag push dates. Only GitHub events
// supply a publication timestamp; missing history remains explicitly unknown.
export function tagPushVersion(data) {
  if (data?.deleted || typeof data?.ref !== 'string' || !data.ref.startsWith('refs/tags/') || typeof data.repository?.full_name !== 'string') return null;
  const tag = data.ref.slice('refs/tags/'.length);
  const pushed = data.repository.pushed_at;
  const timestamp = typeof pushed === 'number' ? pushed * 1000 : Date.parse(pushed);
  return { repository: data.repository.full_name, version: { tag, date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '' } };
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
          store.recordGithubVersion(repository, { tag: published?.payload.ref || tags[0].name, date: published?.created_at || '' });
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
