import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyDeployment({ url, sha, version, timeoutMs = 10 * 60000 }, { transport = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !/^[a-f0-9]{40}$/.test(sha) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Configuration de vérification du déploiement invalide.');
  const deadline = now() + timeoutMs;
  do {
    try {
      const response = await transport(`${origin.origin}/build-info.json?commit=${sha}`, { redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const build = await response.json();
        if (build.commit === sha && build.version === version) return build;
      }
    } catch { /* A restart or unavailable endpoint is retried until the deadline. */ }
    if (now() >= deadline) break;
    await wait(Math.min(10000, deadline - now()));
  } while (now() < deadline);
  throw new Error(`Déploiement non confirmé : le site ne sert pas encore la version ${version} et le commit attendu. Le tag est conservé ; vérifiez Railway ou relancez uniquement ce contrôle.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDeployment({ url: process.env.PLANIFIKATEUR_URL, sha: process.env.DELIVERY_SHA, version: process.env.DELIVERY_VERSION })
    .then(build => console.log(`Déploiement confirmé : ${build.version} (${build.commit}).`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
