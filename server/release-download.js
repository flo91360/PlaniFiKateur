// Téléchargement des exécutables d’une Release GitHub par les comptes du projet. Le serveur
// demande à l’API GitHub, avec PLANIFIKATEUR_GITHUB_TOKEN, l’adresse signée et temporaire du
// fichier, puis y redirige le navigateur : un dépôt privé reste téléchargeable sans compte
// GitHub, et le jeton n’est jamais transmis au navigateur.
const SIGNED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:githubusercontent\.com|github\.com)$/i;

export function createReleaseDownloads({ token = '', transport = fetch, timeoutMs = 10000 } = {}) {
  const request = (path, accept, redirect = 'error') =>
    transport(`https://api.github.com${path}`, {
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PlaniFiKateur',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  return {
    // Adresse signée du fichier `name` de la Release `tag`, ou null si GitHub ne la fournit pas.
    async link(repository, tag, name) {
      const release = await request(
        `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        'application/vnd.github+json',
      );
      if (!release.ok) {
        await release.body?.cancel().catch(() => {});
        return null;
      }
      const asset = (await release.json())?.assets?.find?.(item => item?.name === name);
      if (!Number.isSafeInteger(asset?.id)) return null;
      const response = await request(
        `/repos/${repository}/releases/assets/${asset.id}`,
        'application/octet-stream',
        'manual',
      );
      await response.body?.cancel().catch(() => {});
      if (![301, 302, 303, 307, 308].includes(response.status)) return null;
      let location;
      try {
        location = new URL(response.headers.get('location'));
      } catch {
        return null;
      }
      return location.protocol === 'https:' && SIGNED_HOSTS.test(location.hostname) ? location.href : null;
    },
  };
}
