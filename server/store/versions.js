// Version publiée d’un projet (dernier tag GitHub, téléchargements, changelog des Releases),
// lue depuis les tables remplies par la synchronisation des versions.
export function createVersionReader({ db, workflows }) {
  return projectId => {
    const repository = workflows.githubProject(projectId);
    if (!repository) return { tag: 'Aucun tag disponible', date: '' };
    const row = db.prepare('SELECT data FROM github_versions WHERE repository=?').get(repository.toLowerCase());
    const version = row ? JSON.parse(row.data) : { tag: 'Version en cours de récupération', date: '' };
    const downloads = db
      .prepare('SELECT data FROM github_downloads WHERE repository=? AND tag=?')
      .get(repository.toLowerCase(), version.tag);
    const changelog = db
      .prepare('SELECT data FROM github_changelog WHERE repository=?')
      .all(repository.toLowerCase())
      .map(row => JSON.parse(row.data))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.tag.localeCompare(a.tag));
    // Exécutables de la Release GitHub de la version affichée, téléchargés depuis GitHub.
    const files = changelog.find(entry => entry.tag === version.tag)?.files;
    return {
      ...version,
      repository,
      changelog,
      ...(downloads ? { downloads: JSON.parse(downloads.data) } : {}),
      ...(files?.length ? { release: { repository, tag: version.tag, files } } : {}),
    };
  };
}
