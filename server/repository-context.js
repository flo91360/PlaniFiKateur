// Documentation du dépôt transmise à la reformulation : le README et CLAUDE.md
// (AGENTS.md à défaut), lus par l’API GitHub sur la branche cible du projet.
// Les fichiers sont conservés tant que la branche reste sur le même commit ;
// une indisponibilité de GitHub n’empêche jamais la reformulation.
const FILE_LIMIT = 12000;

export function trimDocument(content, limit = FILE_LIMIT) {
  const text = content.replace(/\r\n/g, '\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}\n[… document tronqué]` : text;
}

export function createRepositoryContext({ token = '', transport = fetch, headTtlMs = 60000, timeoutMs = 5000 } = {}) {
  const heads = new Map(),
    documents = new Map();
  const request = async (path, accept) => {
    const response = await transport(`https://api.github.com${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PlaniFiKateur',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 404) return null;
      throw new Error(`GitHub ${response.status}`);
    }
    return response.text();
  };
  const raw = path => request(path, 'application/vnd.github.raw+json');
  // Un seul appel léger par minute et par branche pour savoir si le commit a changé.
  const head = async (repository, branch) => {
    const key = `${repository}@${branch}`.toLowerCase(),
      cached = heads.get(key);
    if (cached && cached.until > Date.now()) return cached.sha;
    let sha = null;
    try {
      const text = (await request(`/repos/${repository}/commits/${branch}`, 'application/vnd.github.sha'))?.trim();
      if (/^[0-9a-f]{40}$/.test(text || '')) sha = text;
    } catch {}
    heads.set(key, { sha, until: Date.now() + headTtlMs });
    return sha;
  };
  return {
    async get(repository, branch = 'main') {
      if (!repository) return [];
      const sha = await head(repository, branch);
      if (!sha) return [];
      const key = `${repository.toLowerCase()}@${sha}`;
      if (!documents.has(key)) {
        try {
          let [readme, guide] = await Promise.all([
              raw(`/repos/${repository}/readme?ref=${sha}`),
              raw(`/repos/${repository}/contents/CLAUDE.md?ref=${sha}`),
            ]),
            guideName = 'CLAUDE.md';
          if (guide === null) {
            guide = await raw(`/repos/${repository}/contents/AGENTS.md?ref=${sha}`);
            guideName = 'AGENTS.md';
          }
          const files = [
            ['README', readme],
            [guideName, guide],
          ]
            .filter(([, content]) => content?.trim())
            .map(([name, content]) => ({ name, content: trimDocument(content) }));
          documents.set(key, files);
          if (documents.size > 50) documents.delete(documents.keys().next().value);
        } catch {
          return [];
        }
      }
      return documents.get(key);
    },
  };
}
