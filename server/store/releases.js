import { isDeepStrictEqual } from 'node:util';
import { validateDriveRelease } from '../../src/lib/drive-release.js';
import { releaseExecutables } from '../../src/lib/github-release.js';

// Versions publiées des dépôts : tags, releases GitHub et leurs exécutables.
// Chaque enregistrement met à jour les cartes Infos des projets liés au dépôt.
export function createReleaseStore({ db, transaction, workflows, synchronizeInfos }) {
  // Un projet est-il lié à ce dépôt (en minuscules) ?
  const linked = repository =>
    db
      .prepare('SELECT id FROM projects')
      .all()
      .some(project => workflows.githubProject(project.id)?.toLowerCase() === repository);
  return {
    recordDriveRelease(repository, data) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!linked(repository)) return { updated: false };
        let release;
        try {
          release = validateDriveRelease(data, repository, data.version);
        } catch {
          return { updated: false };
        }
        const row = db
          .prepare('SELECT data FROM github_downloads WHERE repository=? AND tag=?')
          .get(repository, release.version);
        if (row && (JSON.parse(row.data).commit !== release.commit || isDeepStrictEqual(JSON.parse(row.data), release)))
          return { updated: false };
        db.prepare(
          'INSERT INTO github_downloads VALUES(?,?,?) ON CONFLICT(repository,tag) DO UPDATE SET data=excluded.data',
        ).run(repository, release.version, JSON.stringify(release));
        synchronizeInfos();
        return { updated: true };
      });
    },
    recordGithubChangelog(repository, releases) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!linked(repository)) return;
        for (const release of releases) {
          if (
            !release ||
            release.draft ||
            typeof release.tag_name !== 'string' ||
            !release.tag_name.trim() ||
            release.tag_name.length > 140 ||
            !release.published_at ||
            !Number.isFinite(Date.parse(release.published_at))
          )
            continue;
          const files = releaseExecutables(release.assets);
          const entry = {
            tag: release.tag_name,
            date: new Date(release.published_at).toISOString(),
            body:
              typeof release.body === 'string'
                ? release.body
                    .replace(/<!-- planifikateur-drive\n[\s\S]*?\n-->/g, '')
                    .trim()
                    .slice(0, 20000)
                : '',
            ...(files.length ? { files } : {}),
          };
          db.prepare(
            'INSERT INTO github_changelog VALUES(?,?,?) ON CONFLICT(repository,tag) DO UPDATE SET data=excluded.data',
          ).run(repository, entry.tag, JSON.stringify(entry));
        }
        synchronizeInfos();
      });
    },
    githubVersion(repository) {
      const row = db.prepare('SELECT data FROM github_versions WHERE repository=?').get(repository.toLowerCase());
      return row ? JSON.parse(row.data) : null;
    },
    refreshInfos() {
      return transaction(synchronizeInfos);
    },
    recordGithubVersion(repository, version) {
      return transaction(() => {
        repository = repository.toLowerCase();
        if (!linked(repository)) return { updated: false };
        if (
          typeof version.tag !== 'string' ||
          !version.tag.trim() ||
          version.tag.length > 140 ||
          /[\u0000-\u001f]/.test(version.tag) ||
          (version.date && !Number.isFinite(Date.parse(version.date)))
        )
          return { updated: false };
        const previous = this.githubVersion(repository);
        // Do not replace a newer signed push with a stale API response.
        if (previous?.date && (!version.date || Date.parse(previous.date) > Date.parse(version.date)))
          return { updated: false };
        if (isDeepStrictEqual(previous, version)) return { updated: false };
        db.prepare(
          'INSERT INTO github_versions VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET data=excluded.data',
        ).run(repository, JSON.stringify(version));
        synchronizeInfos();
        return { updated: true };
      });
    },
  };
}
